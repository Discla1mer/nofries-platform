const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { apiSecurityHeaders } = require('./securityHeaders');
const { parameterBytes, requestBodySize } = require('./requestLimits');

const DEFAULT_SCOPE = 'nofries.lifecycle.read';
const OAUTH_FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_OAUTH_REQUEST_BYTES = 32 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;
const OIDC_SCOPES = new Set(['offline_access', 'openid', 'profile', 'email']);
const CHATGPT_CALLBACK = /^\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const CHATGPT_STABLE_CALLBACK = '/connector_platform_oauth_redirect';

function handleMcpOauthMetadataRequest(req, options = {}) {
    const method = String(req && req.method || 'GET').toUpperCase();
    if (method !== 'GET') return oauthJson(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const settings = resolveMcpOauthBridgeSettings(options.env || process.env);
    if (!settings.configured) return notConfigured();
    return oauthJson(200, {
        issuer: settings.publicUrl,
        authorization_endpoint: `${settings.publicUrl}/api/mcp-oauth-authorize`,
        token_endpoint: `${settings.publicUrl}/api/mcp-oauth-token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [settings.scope, 'offline_access']
    });
}

function handleMcpOauthAuthorizeRequest(req, options = {}) {
    const method = String(req && req.method || 'GET').toUpperCase();
    if (method !== 'GET') return oauthJson(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const settings = resolveMcpOauthBridgeSettings(options.env || process.env);
    if (!settings.configured) return notConfigured();
    const query = normaliseParameters(req && req.query);
    if (parameterBytes(query) > MAX_OAUTH_REQUEST_BYTES) {
        return oauthError(413, 'invalid_request', 'The authorization request is too large.');
    }
    const validation = validateAuthorizeRequest(query, settings);
    if (validation) return validation;

    const target = new URL(settings.entraAuthorizationEndpoint);
    [
        'client_id',
        'response_type',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        'response_mode',
        'prompt',
        'login_hint',
        'domain_hint',
        'nonce',
        'claims',
        'ui_locales',
        'max_age',
        'id_token_hint'
    ].forEach((name) => {
        if (query[name]) target.searchParams.set(name, query[name]);
    });
    return {
        status: 302,
        headers: apiSecurityHeaders({ Location: target.toString() }),
        body: '',
        isRaw: true
    };
}

async function handleMcpOauthTokenRequest(req, options = {}) {
    const method = String(req && req.method || 'POST').toUpperCase();
    if (method !== 'POST') return oauthJson(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (requestBodySize(req) > MAX_OAUTH_REQUEST_BYTES) {
        return oauthError(413, 'invalid_request', 'The token request is too large.');
    }
    const settings = resolveMcpOauthBridgeSettings(options.env || process.env);
    if (!settings.configured) return notConfigured();
    const form = normaliseParameters(req && req.body);
    if (parameterBytes(form) > MAX_OAUTH_REQUEST_BYTES) {
        return oauthError(413, 'invalid_request', 'The token request is too large.');
    }
    const validation = validateTokenRequest(form, settings);
    if (validation) return validation;

    const upstream = new URLSearchParams();
    const allowed = form.grant_type === 'refresh_token'
        ? ['client_id', 'grant_type', 'refresh_token', 'scope']
        : ['client_id', 'grant_type', 'code', 'redirect_uri', 'code_verifier', 'scope'];
    allowed.forEach((name) => {
        if (form[name]) upstream.set(name, form[name]);
    });

    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') {
        return oauthJson(503, { error: 'temporarily_unavailable', error_description: 'Token exchange is unavailable.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_FETCH_TIMEOUT_MS);
    let response;
    let body;
    try {
        response = await fetchImpl(settings.entraTokenEndpoint, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: upstream.toString(),
            redirect: 'error',
            signal: controller.signal
        });
        body = response && typeof response.text === 'function' ? await response.text() : '';
    } catch (error) {
        return oauthJson(502, { error: 'temporarily_unavailable', error_description: 'Microsoft token exchange could not be reached.' });
    } finally {
        clearTimeout(timer);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_OAUTH_RESPONSE_BYTES) {
        return oauthJson(502, { error: 'temporarily_unavailable', error_description: 'Microsoft token exchange returned too much data.' });
    }
    try {
        JSON.parse(body || '{}');
    } catch (error) {
        return oauthJson(502, { error: 'temporarily_unavailable', error_description: 'Microsoft token exchange returned an invalid response.' });
    }
    return {
        status: Number(response && response.status) || 502,
        headers: apiSecurityHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            Pragma: 'no-cache'
        }),
        body,
        isRaw: true
    };
}

function validateAuthorizeRequest(query, settings) {
    if (query.client_id !== settings.clientId) return oauthError(400, 'invalid_client', 'The OAuth client is not approved.');
    if (query.response_type !== 'code') return oauthError(400, 'unsupported_response_type', 'Only authorization code flow is supported.');
    if (!isAllowedChatGptRedirect(query.redirect_uri)) return oauthError(400, 'invalid_request', 'The callback URL is not approved.');
    if (!query.state || query.state.length > 2048) return oauthError(400, 'invalid_request', 'OAuth state is required.');
    if (query.code_challenge_method !== 'S256' || !isValidCodeChallenge(query.code_challenge)) {
        return oauthError(400, 'invalid_request', 'S256 PKCE is required.');
    }
    if (query.response_mode && !['query', 'form_post'].includes(query.response_mode)) {
        return oauthError(400, 'invalid_request', 'The response mode is not supported.');
    }
    return validateScopes(query.scope, settings.scope, true);
}

function validateTokenRequest(form, settings) {
    if (form.client_secret || form.client_assertion) {
        return oauthError(400, 'invalid_client', 'This connector uses a public PKCE client.');
    }
    if (form.client_id !== settings.clientId) return oauthError(400, 'invalid_client', 'The OAuth client is not approved.');
    if (!['authorization_code', 'refresh_token'].includes(form.grant_type)) {
        return oauthError(400, 'unsupported_grant_type', 'The grant type is not supported.');
    }
    const scopeError = validateScopes(form.scope, settings.scope, false);
    if (scopeError) return scopeError;
    if (form.grant_type === 'refresh_token') {
        if (!form.refresh_token || form.refresh_token.length > 12000) {
            return oauthError(400, 'invalid_request', 'A refresh token is required.');
        }
        return null;
    }
    if (!form.code || form.code.length > 12000) return oauthError(400, 'invalid_request', 'An authorization code is required.');
    if (!isAllowedChatGptRedirect(form.redirect_uri)) return oauthError(400, 'invalid_request', 'The callback URL is not approved.');
    if (!isValidCodeVerifier(form.code_verifier)) return oauthError(400, 'invalid_request', 'A valid PKCE verifier is required.');
    return null;
}

function validateScopes(value, requiredScope, requireScope) {
    const scopes = String(value || '').split(/\s+/).filter(Boolean);
    if (requireScope && !scopes.includes(requiredScope)) {
        return oauthError(400, 'invalid_scope', 'The No Fries lifecycle read scope is required.');
    }
    if (scopes.some((scope) => scope !== requiredScope && !OIDC_SCOPES.has(scope))) {
        return oauthError(400, 'invalid_scope', 'An unsupported scope was requested.');
    }
    return null;
}

function isAllowedChatGptRedirect(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:'
            && url.hostname === 'chatgpt.com'
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
            && (CHATGPT_CALLBACK.test(url.pathname) || url.pathname === CHATGPT_STABLE_CALLBACK);
    } catch (error) {
        return false;
    }
}

function isValidCodeChallenge(value) {
    return /^[A-Za-z0-9_-]{43,128}$/.test(String(value || ''));
}

function isValidCodeVerifier(value) {
    return /^[A-Za-z0-9._~-]{43,128}$/.test(String(value || ''));
}

function resolveMcpOauthBridgeSettings(env) {
    const publicUrl = normaliseHttpsOrigin(env.NOFRIES_PUBLIC_URL || 'https://nofries.nz');
    const issuer = normaliseHttpsUrl(env.NOFRIES_MCP_ISSUER);
    const clientId = String(env.NOFRIES_MCP_CLIENT_ID || env.NOFRIES_MCP_AUDIENCE || '').trim();
    const scope = String(env.NOFRIES_MCP_SCOPE || DEFAULT_SCOPE).trim();
    const endpoints = resolveEntraEndpoints(issuer);
    return {
        publicUrl,
        issuer,
        clientId,
        scope,
        entraAuthorizationEndpoint: endpoints.authorization,
        entraTokenEndpoint: endpoints.token,
        configured: Boolean(publicUrl && clientId && scope && endpoints.authorization && endpoints.token)
    };
}

function resolveEntraEndpoints(issuer) {
    try {
        const url = new URL(issuer);
        if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com') return {};
        const match = url.pathname.match(/^\/([^/]+)\/v2\.0\/?$/);
        if (!match || !match[1]) return {};
        const tenant = encodeURIComponent(decodeURIComponent(match[1]));
        return {
            authorization: `${url.origin}/${tenant}/oauth2/v2.0/authorize`,
            token: `${url.origin}/${tenant}/oauth2/v2.0/token`
        };
    } catch (error) {
        return {};
    }
}

function normaliseHttpsOrigin(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (url.protocol !== 'https:') return '';
        return url.origin;
    } catch (error) {
        return '';
    }
}

function normaliseHttpsUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : '';
    } catch (error) {
        return '';
    }
}

function normaliseParameters(value) {
    if (Buffer.isBuffer(value)) return Object.fromEntries(new URLSearchParams(value.toString('utf8')));
    if (typeof value === 'string') return Object.fromEntries(new URLSearchParams(value));
    const result = {};
    Object.entries(value && typeof value === 'object' ? value : {}).forEach(([key, item]) => {
        result[key] = String(Array.isArray(item) ? item[0] : item == null ? '' : item);
    });
    return result;
}

function oauthError(status, error, description) {
    return oauthJson(status, { error, error_description: description });
}

function notConfigured() {
    return oauthJson(503, { error: 'temporarily_unavailable', error_description: 'No Fries OAuth is not configured.' });
}

function oauthJson(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)),
        body
    };
}

function rateLimited(req, bucket, env) {
    const clientKey = getClientKeyFromHeaders(req && req.headers || {}, 'unknown');
    const result = checkRateLimit(bucket, clientKey, env);
    if (result.allowed) return null;
    return oauthJson(429, { error: 'temporarily_unavailable', error_description: 'Too many OAuth requests.' }, rateLimitHeaders(result));
}

async function runMcpOauthMetadataFunction(context, req) {
    const limited = rateLimited(req, 'apiRead', process.env);
    context.res = limited || handleMcpOauthMetadataRequest(req);
}

async function runMcpOauthAuthorizeFunction(context, req) {
    const limited = rateLimited(req, 'apiRead', process.env);
    context.res = limited || handleMcpOauthAuthorizeRequest(req);
}

async function runMcpOauthTokenFunction(context, req) {
    const limited = rateLimited(req, 'apiWrite', process.env);
    context.res = limited || await handleMcpOauthTokenRequest(req);
}

module.exports = {
    handleMcpOauthAuthorizeRequest,
    handleMcpOauthMetadataRequest,
    handleMcpOauthTokenRequest,
    isAllowedChatGptRedirect,
    resolveMcpOauthBridgeSettings,
    runMcpOauthAuthorizeFunction,
    runMcpOauthMetadataFunction,
    runMcpOauthTokenFunction
};
