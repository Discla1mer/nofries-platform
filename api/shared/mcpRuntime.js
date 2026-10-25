const crypto = require('crypto');
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { apiSecurityHeaders } = require('./securityHeaders');
const { getLifecycleService } = require('./lifecycleRuntime');
const { McpAccessError, McpAuthError, requireMcpCapability, resolveMcpAccess } = require('./mcpAuth');
const { getReleaseIdentity } = require('./releaseIdentity');
const { requestBodySize } = require('./requestLimits');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SCOPE = 'nofries.lifecycle.read';
const RELEASE_CANARY_QUERY_PREFIX = '__release_canary__';
const MAX_MCP_REQUEST_BYTES = 64 * 1024;
const CANARY_BINDING_STATE = Symbol('canaryBindingState');
const DIAGNOSTIC_CODES = new Set([
    'access_verification_failed',
    'capability_required',
    'canary_application_guard_failed',
    'canary_request_stamp_invalid',
    'canary_release_identity_invalid',
    'canary_release_sha_mismatch',
    'canary_tenant_binding_invalid',
    'internal_error',
    'lifecycle_read_failed',
    'request_failed',
    'request_handling_failed',
    'response_failed',
    'storage_initialisation_failed',
    'tenant_access_required'
]);
const DIAGNOSTIC_STAGES = new Set([
    'capability',
    'handler',
    'request',
    'response',
    'response_headers',
    'storage_init',
    'storage_read',
    'tenant_access'
]);

function toolDefinitions(scope = MCP_SCOPE) {
    const securitySchemes = [{ type: 'oauth2', scopes: [scope] }];
    const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
    return [
        {
            name: 'search',
            title: 'Search No Fries lifecycle records',
            description: 'Use this when the user wants to find a No Fries prospect, customer, lifecycle record, or operator handoff task.',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
                required: ['query'],
                additionalProperties: false
            },
            securitySchemes,
            _meta: { securitySchemes },
            annotations
        },
        {
            name: 'fetch',
            title: 'Fetch a No Fries lifecycle record',
            description: 'Use this after search when the user wants the structured record, field provenance, handoff task, and audit evidence for one result.',
            inputSchema: {
                type: 'object',
                properties: { id: { type: 'string', minLength: 1, maxLength: 240 } },
                required: ['id'],
                additionalProperties: false
            },
            securitySchemes,
            _meta: { securitySchemes },
            annotations
        }
    ];
}

async function handleMcpRequest(req, dependencies = {}) {
    const env = dependencies.env || process.env;
    const method = String(req && req.method || 'POST').toUpperCase();
    if (method !== 'POST') {
        return json(405, { error: 'Method not allowed' }, { Allow: 'POST' });
    }
    if (requestBodySize(req) > MAX_MCP_REQUEST_BYTES) {
        return mcpError(null, -32600, 'Request body is too large', 413);
    }
    let request;
    try {
        request = parseMcpRequest(req && req.body);
    } catch (error) {
        return mcpError(null, error.code || -32600, error.message || 'Invalid Request');
    }
    if (!request.id && request.method === 'notifications/initialized') {
        return { status: 202, headers: mcpHeaders(), body: '', isRaw: true };
    }
    const id = request.id == null ? null : request.id;
    if (request.method === 'initialize') {
        return mcpResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'nofries-lifecycle', version: '1.0.0' },
            instructions: 'Search before fetch. This connector is read-only. Treat discovery facts as claims with provenance; do not advance lifecycle stages or perform external actions.'
        });
    }
    if (request.method === 'ping') return mcpResult(id, {});
    if (request.method === 'tools/list') {
        return mcpResult(id, { tools: toolDefinitions(resolveMcpSettings(env).scope) });
    }
    if (request.method === 'tools/call') {
        return callTool(id, request.params || {}, req, Object.assign({}, dependencies, { env }));
    }
    return mcpError(id, -32601, 'Method not found');
}

function handleMcpAuthMetadataRequest(req, options = {}) {
    const env = options.env || process.env;
    const method = String(req && req.method || 'GET').toUpperCase();
    if (method !== 'GET') return json(405, { error: 'Method not allowed' }, { Allow: 'GET' });
    const settings = resolveMcpSettings(env);
    if (!settings.resource || !settings.authorizationServer) {
        return json(503, {
            error: 'No Fries MCP OAuth is not configured',
            code: 'mcp_auth_not_configured'
        });
    }
    return json(200, {
        resource: settings.resource,
        authorization_servers: [settings.authorizationServer],
        scopes_supported: [settings.scope],
        resource_documentation: `${settings.publicUrl}/privacy.html`
    });
}

async function callTool(id, params, req, dependencies) {
    const name = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (!['search', 'fetch'].includes(name)) return mcpError(id, -32602, 'Unknown tool');
    const incidentId = normaliseIncidentId(dependencies.incidentId) || createIncidentId();
    let access;
    try {
        const resolver = dependencies.resolveAccess || resolveMcpAccess;
        access = await resolver(req, { env: dependencies.env, fetchImpl: dependencies.fetchImpl, now: dependencies.now });
    } catch (error) {
        if (error instanceof McpAuthError || error.statusCode === 401) {
            return mcpResult(id, authenticationResult(error, dependencies.env));
        }
        const diagnostic = diagnosticResult(incidentId, 'tenant_access', error, 'access_verification_failed');
        logMcpIncident(dependencies.logger, name, diagnostic, error);
        if (error instanceof McpAccessError || error.statusCode === 403) {
            return mcpResult(id, toolError(
                'This identity is authenticated but is not approved for No Fries.',
                diagnostic
            ));
        }
        return mcpResult(id, toolError('No Fries could not verify access.', diagnostic));
    }

    try {
        requireMcpCapability(access, 'lifecycle:read');
        if (name === 'fetch') requireMcpCapability(access, 'lifecycle:audit:read');
    } catch (error) {
        const diagnostic = diagnosticResult(incidentId, 'capability', error, 'capability_required');
        logMcpIncident(dependencies.logger, name, diagnostic, error);
        return mcpResult(id, toolError('Your No Fries role does not permit this read.', diagnostic));
    }

    let lifecycle;
    try {
        lifecycle = dependencies.lifecycle || getLifecycleService();
    } catch (error) {
        const diagnostic = diagnosticResult(incidentId, 'storage_init', error, 'storage_initialisation_failed');
        logMcpIncident(dependencies.logger, name, diagnostic, error);
        return mcpResult(id, toolError('No Fries could not initialise the lifecycle store.', diagnostic));
    }

    try {
        if (name === 'search') {
            let query;
            try {
                query = requireString(args.query, 'query', 500);
            } catch (error) {
                observeCanaryQuery(dependencies[CANARY_BINDING_STATE], id, access, null);
                throw error;
            }
            observeCanaryQuery(dependencies[CANARY_BINDING_STATE], id, access, query);
            const results = await lifecycle.searchAgentContext(access, query);
            const result = {
                content: [{ type: 'text', text: JSON.stringify({ results }) }]
            };
            const releaseCanary = releaseCanaryMetadata(query, access, dependencies);
            if (releaseCanary && releaseCanary.code) {
                const diagnostic = diagnosticResult(incidentId, 'response', null, releaseCanary.code);
                try {
                    logMcpIncident(dependencies.logger, name, diagnostic);
                } catch {
                    // Logging cannot replace the closed response or reveal the rejected binding.
                }
                return mcpResult(id, toolError('No Fries could not verify the connector release.', diagnostic));
            }
            if (releaseCanary) {
                result._meta = { 'nofries/release-canary': releaseCanary };
            }
            return mcpResult(id, result);
        }
        const documentId = requireString(args.id, 'id', 240);
        const document = await lifecycle.fetchAgentContext(access, documentId);
        return mcpResult(id, {
            content: [{ type: 'text', text: JSON.stringify(document) }]
        });
    } catch (error) {
        if (error && error.code === -32602) return mcpError(id, error.code, error.message);
        const diagnostic = diagnosticResult(incidentId, 'storage_read', error, 'lifecycle_read_failed');
        logMcpIncident(dependencies.logger, name, diagnostic, error);
        return mcpResult(id, toolError('No Fries could not complete that read.', diagnostic));
    }
}

function releaseCanaryMetadata(query, access, dependencies) {
    const queryText = String(query || '');
    if (!queryText.startsWith(RELEASE_CANARY_QUERY_PREFIX)) return null;
    if (
        !access ||
        access.allowed !== true ||
        !access.authentication ||
        access.authentication.provider !== 'mcp-oauth-application' ||
        !access.user ||
        access.user.role !== 'mcp_reader'
    ) {
        return { code: 'canary_application_guard_failed' };
    }
    const requestedSha = queryText.slice(RELEASE_CANARY_QUERY_PREFIX.length);
    if (!/^[0-9a-f]{40}$/.test(requestedSha)) return { code: 'canary_request_stamp_invalid' };

    let releaseSha;
    try {
        const resolveReleaseIdentity = typeof dependencies.getReleaseIdentity === 'function'
            ? dependencies.getReleaseIdentity
            : getReleaseIdentity;
        const identity = resolveReleaseIdentity();
        releaseSha = identity && typeof identity.releaseSha === 'string' ? identity.releaseSha : '';
    } catch {
        return { code: 'canary_release_identity_invalid' };
    }
    if (!/^[0-9a-f]{40}$/.test(releaseSha)) return { code: 'canary_release_identity_invalid' };
    if (requestedSha !== releaseSha) {
        const binding = dependencies[CANARY_BINDING_STATE];
        if (binding && binding.queryClass === 'release_canary' && binding.releaseSha === requestedSha) {
            binding.releaseMismatch = { requestedSha, resolvedSha: releaseSha };
        }
        return { code: 'canary_release_sha_mismatch' };
    }
    const tenantKey = access.tenant && typeof access.tenant.key === 'string'
        ? access.tenant.key
        : '';
    if (!/^[0-9a-f]{32}$/.test(tenantKey)) return { code: 'canary_tenant_binding_invalid' };
    return { releaseSha, tenantKey };
}

async function runMcpFunction(context, req, dependencies = {}) {
    const incidentId = normaliseIncidentId(context && context.invocationId) || createIncidentId();
    let stage = 'request';
    try {
        const clientKey = getClientKeyFromHeaders(req && req.headers || {}, 'unknown');
        const rateLimit = checkRateLimit('apiRead', clientKey);
        if (!rateLimit.allowed) {
            context.res = json(429, { error: 'Too many requests', code: 'rate_limited' }, rateLimitHeaders(rateLimit));
            return;
        }
        const handler = dependencies.handleRequest || handleMcpRequest;
        const handlerDependencies = Object.assign({}, dependencies, {
            incidentId,
            logger: context && context.log
        });
        delete handlerDependencies.handleRequest;
        const nonce = handler === handleMcpRequest && !('handleRequest' in dependencies)
            ? canaryProbeNonce(req && req.headers)
            : null;
        const canaryBinding = nonce ? { nonce } : null;
        if (canaryBinding) handlerDependencies[CANARY_BINDING_STATE] = canaryBinding;
        stage = 'handler';
        context.res = await handler(req, handlerDependencies);
        stage = 'response_headers';
        context.res.headers = apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), context.res.headers || {}));
        if (canaryBinding && canaryBinding.queryClass) {
            try {
                const evidence = {
                    v: 1,
                    nonce: canaryBinding.nonce,
                    loadedFunctionsSha256: canaryFunctionsSha256(),
                    queryClass: canaryBinding.queryClass,
                    normalizedRequestSha256: canaryBinding.normalizedRequestSha256,
                    beforeMeta: canaryMetadataProjection(context.res.body, canaryBinding.releaseSha)
                };
                if (canaryBinding.releaseMismatch) {
                    evidence.releaseMismatch = {
                        requestedSha: canaryBinding.releaseMismatch.requestedSha,
                        resolvedSha: canaryBinding.releaseMismatch.resolvedSha
                    };
                }
                const decoded = JSON.stringify(evidence);
                const encoded = Buffer.from(decoded, 'ascii').toString('base64url');
                if (decoded.length <= 1152 && encoded.length <= 1536) {
                    context.res.headers['X-NoFries-Canary-Evidence'] = encoded;
                }
            } catch {
                // Missing evidence is inconclusive; diagnostics cannot change the response.
            }
        }
    } catch (error) {
        const fallbackCodes = {
            request: 'request_failed',
            handler: 'request_handling_failed',
            response_headers: 'response_failed'
        };
        const diagnostic = diagnosticResult(incidentId, stage, error, fallbackCodes[stage] || 'internal_error');
        logMcpIncident(context && context.log, '', diagnostic, error);
        context.res = mcpError(null, -32603, diagnosticMessage('Internal error.', diagnostic), 200, diagnostic);
    }
}

// These are selected loaded definitions, not a package or worker attestation.
function canaryFunctionsSha256() {
    const definitions = [handleMcpRequest, parseMcpRequest, callTool, requireString,
        releaseCanaryMetadata, runMcpFunction];
    return crypto.createHash('sha256').update(JSON.stringify([
        'nofries-mcp-canary-functions/v1',
        ...definitions.map(fn => [fn.name, Function.prototype.toString.call(fn)])
    ]), 'utf8').digest('hex');
}

function canaryMetadataProjection(body, syntheticSha) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const owns = (value, key) => object(value) && Object.prototype.hasOwnProperty.call(value, key);
    const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
        keys.every(key => owns(value, key));
    const result = object(body) ? body.result : null;
    const meta = object(result) ? result._meta : null;
    const atExpectedLocation = owns(meta, 'nofries/release-canary');
    const stamp = atExpectedLocation ? meta['nofries/release-canary'] : null;
    return {
        atExpectedLocation,
        valid: exactKeys(meta, ['nofries/release-canary']) &&
            exactKeys(stamp, ['releaseSha', 'tenantKey']) &&
            typeof syntheticSha === 'string' && /^[0-9a-f]{40}$/.test(syntheticSha) &&
            stamp.releaseSha === syntheticSha && typeof stamp.tenantKey === 'string' &&
            /^[0-9a-f]{32}$/.test(stamp.tenantKey)
    };
}

function canaryProbeNonce(headers) {
    try {
        if (!headers || typeof headers !== 'object') return null;
        const names = Object.keys(headers).filter(name => name.toLowerCase() === 'x-nofries-canary-probe');
        if (names.length !== 1) return null;
        const value = headers[names[0]];
        return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null;
    } catch {
        return null;
    }
}

function observeCanaryQuery(state, id, access, query) {
    if (!state || id !== 'authenticated_canary' || !access || access.allowed !== true ||
        !access.authentication || access.authentication.provider !== 'mcp-oauth-application' ||
        !access.user || access.user.role !== 'mcp_reader') return;
    try {
        const releaseSha = typeof query === 'string' && query.startsWith(RELEASE_CANARY_QUERY_PREFIX)
            ? query.slice(RELEASE_CANARY_QUERY_PREFIX.length) : null;
        state.queryClass = query === null ? 'invalid_input'
            : releaseSha === null ? 'other'
                : /^[0-9a-f]{40}$/.test(releaseSha) ? 'release_canary' : 'invalid_release_canary';
        state.normalizedRequestSha256 = state.queryClass === 'release_canary'
            ? crypto.createHash('sha256').update(JSON.stringify([
                'nofries-mcp-canary-request/v1', state.nonce, '2.0',
                'authenticated_canary', 'tools/call', 'search', query
            ]), 'utf8').digest('hex') : null;
        state.releaseSha = state.queryClass === 'release_canary' ? releaseSha : null;
    } catch {
        delete state.queryClass;
    }
}

async function runMcpAuthMetadataFunction(context, req) {
    context.res = handleMcpAuthMetadataRequest(req);
    context.res.headers = apiSecurityHeaders(context.res.headers || {});
}

function authenticationResult(error, env) {
    const settings = resolveMcpSettings(env);
    const code = error && error.details && error.details.code === 'insufficient_scope'
        ? 'insufficient_scope'
        : 'invalid_token';
    const description = cleanChallengeValue(error && error.message || 'Authentication required');
    const challenge = `Bearer resource_metadata="${settings.metadataUrl}", scope="${settings.scope}", error="${code}", error_description="${description}"`;
    return {
        content: [{ type: 'text', text: `Authentication required: ${description}` }],
        _meta: { 'mcp/www_authenticate': [challenge] },
        isError: true
    };
}

function resolveMcpSettings(env) {
    const publicUrl = String(env.NOFRIES_PUBLIC_URL || 'https://nofries.nz').trim().replace(/\/$/, '');
    const resource = String(env.NOFRIES_MCP_RESOURCE_URL || `${publicUrl}/api/mcp`).trim();
    const scope = Object.prototype.hasOwnProperty.call(env, 'NOFRIES_MCP_SCOPE')
        ? env.NOFRIES_MCP_SCOPE
        : MCP_SCOPE;
    // OAuth requests name the resource as well as its delegated permission.
    // mcpAuth.js validates delegated scopes and application roles separately.
    const qualifiedScope = qualifiedMcpReadScope(env.NOFRIES_MCP_AUDIENCE);
    if (scope !== MCP_SCOPE && (!qualifiedScope || scope !== qualifiedScope)) {
        throw new McpAuthError(
            'The No Fries MCP OAuth resource server is not configured',
            'mcp_auth_not_configured'
        );
    }
    return {
        publicUrl,
        resource,
        metadataUrl: String(env.NOFRIES_MCP_METADATA_URL || `${publicUrl}/api/mcp-auth`).trim(),
        authorizationServer: String(env.NOFRIES_MCP_AUTHORIZATION_SERVER || env.NOFRIES_MCP_ISSUER || '').trim().replace(/\/$/, ''),
        scope
    };
}

function qualifiedMcpReadScope(audience) {
    if (typeof audience !== 'string' || !audience || audience.length > 2048 ||
        /[\s\x00-\x1f\x7f"\\?#]/.test(audience)) return '';
    const resource = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(audience)
        ? `api://${audience}`
        : audience;
    try {
        const url = new URL(resource);
        if (!['api:', 'https:'].includes(url.protocol) || !url.hostname ||
            url.username || url.password || url.search || url.hash || resource.endsWith('/')) return '';
        return `${resource}/${MCP_SCOPE}`;
    } catch (error) {
        return '';
    }
}

function parseMcpRequest(value) {
    let request = value;
    if (Buffer.isBuffer(request)) request = request.toString('utf8');
    if (typeof request === 'string') {
        try {
            request = JSON.parse(request);
        } catch (error) {
            throw protocolError(-32700, 'Parse error');
        }
    }
    if (!request || Array.isArray(request) || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        throw protocolError(-32600, 'Invalid Request');
    }
    return request;
}

function requireString(value, name, maxLength) {
    const text = String(value == null ? '' : value).trim();
    if (!text || text.length > maxLength) throw protocolError(-32602, `${name} is required`);
    return text;
}

function toolError(message, diagnostic) {
    const result = { content: [{ type: 'text', text: diagnosticMessage(message, diagnostic) }], isError: true };
    if (diagnostic) result._meta = { 'nofries/diagnostic': diagnostic };
    return result;
}

function mcpResult(id, result) {
    return json(200, { jsonrpc: '2.0', id, result }, mcpHeaders());
}

function mcpError(id, code, message, status = 200, data) {
    const error = { code, message };
    if (data) error.data = data;
    return json(status, { jsonrpc: '2.0', id, error }, mcpHeaders());
}

function protocolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function mcpHeaders() {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'X-Content-Type-Options': 'nosniff'
    };
}

function json(status, body, headers = {}) {
    return { status, headers: apiSecurityHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)), body };
}

function cleanChallengeValue(value) {
    return String(value || '').replace(/["\r\n]/g, ' ').trim().slice(0, 240);
}

function createIncidentId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}

function normaliseIncidentId(value) {
    const incidentId = String(value || '').trim();
    return /^[a-z0-9_-]{1,80}$/i.test(incidentId) ? incidentId : '';
}

function diagnosticResult(incidentId, stage, error, fallbackCode) {
    return {
        incidentId: normaliseIncidentId(incidentId) || createIncidentId(),
        stage: DIAGNOSTIC_STAGES.has(stage) ? stage : 'response',
        code: safeDiagnosticCode(error && error.details && error.details.code, fallbackCode)
    };
}

function safeDiagnosticCode(value, fallback) {
    const candidate = String(value || '').trim();
    if (DIAGNOSTIC_CODES.has(candidate)) return candidate;
    return DIAGNOSTIC_CODES.has(fallback) ? fallback : 'internal_error';
}

function logMcpIncident(logger, toolName, diagnostic, error) {
    if (!logger || typeof logger.error !== 'function') return;
    const statusCode = Number(error && error.statusCode);
    logger.error({
        event: 'mcp_incident',
        incidentId: diagnostic.incidentId,
        stage: diagnostic.stage,
        code: diagnostic.code,
        statusCode: Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500,
        tool: ['search', 'fetch'].includes(toolName) ? toolName : 'request'
    });
}

function diagnosticMessage(message, diagnostic) {
    const base = String(message || '').trim().slice(0, 420);
    if (!diagnostic) return base;
    return `${base} Reference: ${diagnostic.stage}/${diagnostic.code}; incident ${diagnostic.incidentId}.`.slice(0, 600);
}

module.exports = {
    MCP_PROTOCOL_VERSION,
    canaryFunctionsSha256,
    canaryMetadataProjection,
    handleMcpAuthMetadataRequest,
    handleMcpRequest,
    resolveMcpSettings,
    runMcpAuthMetadataFunction,
    runMcpFunction,
    toolDefinitions
};
