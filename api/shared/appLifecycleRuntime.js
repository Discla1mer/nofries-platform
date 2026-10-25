const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProductRequestIdentity } = require('./identity');
const { assertCapability, resolveTenantAccess } = require('./appTenantAccess');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { createLifecycleRepository, LifecycleRepositoryError } = require('./appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('./appLifecycle/lifecycleService');
const { createApprovedProposalVerifier } = require('./proposalApprovalProvider');
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { requestBodySize } = require('./requestLimits');

const DATA_DIR = process.env.NOFRIES_DATA_DIR || path.join(os.tmpdir(), 'nofries-data');
const MAX_REQUEST_BYTES = 256 * 1024;
let repository;
let service;

async function handleLifecycleRequest(req, routeContext = {}) {
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        throw lifecycleError(413, 'Request body is too large', 'request_too_large');
    }
    assertSameOriginForMutation(req);
    const identity = await getProductRequestIdentity(req);
    const access = resolveTenantAccess(identity);
    if (!access.allowed) {
        throw lifecycleError(403, 'This Microsoft identity has not been approved for a No Fries tenant', 'tenant_access_required', {
            reason: access.reason
        });
    }
    const method = String(req.method || 'GET').toUpperCase();
    const routePath = getLifecyclePath(req, routeContext);
    const segments = routePath.split('/').filter(Boolean).map(decodeURIComponent);
    const body = getJsonBody(req);
    const lifecycle = getLifecycleService();

    if (method === 'GET' && segments.length === 1 && segments[0] === 'app.js') {
        assertCapability(access, 'lifecycle:read');
        return raw(200, fs.readFileSync(path.join(__dirname, 'protectedAssets', 'operator.js'), 'utf8'), {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff'
        });
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'bootstrap') {
        assertCapability(access, 'lifecycle:read');
        return json(200, await lifecycle.bootstrap(access));
    }
    if (segments[0] === 'retention') {
        assertCapability(access, 'tenant:admin');
        if (method === 'GET' && segments.length === 1) {
            return json(200, await lifecycle.previewRetention(access));
        }
        if (method === 'POST' && segments.length === 1) {
            return json(200, await lifecycle.runRetention(access, body));
        }
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'GET, POST' });
    }
    if (segments[0] === 'controls' && segments[1] === 'run' && segments.length === 2) {
        if (method !== 'POST') return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'POST' });
        assertCapability(access, 'tenant:admin');
        assertCapability(access, 'customer-controls:run');
        return json(200, await lifecycle.runCustomerControls(access, body));
    }
    if (segments[0] === 'organisations') {
        if (method === 'GET' && segments.length === 1) {
            assertCapability(access, 'lifecycle:read');
            return json(200, await lifecycle.listOrganisations(access));
        }
        if (method === 'POST' && segments.length === 1) {
            assertCapability(access, 'lifecycle:write');
            return json(201, await lifecycle.createOrganisation(access, body));
        }
        if (method === 'POST' && segments.length === 2 && segments[1] === 'pilot') {
            assertCapability(access, 'tenant:admin');
            assertCapability(access, 'lifecycle:transition');
            return json(201, await lifecycle.createInternalPilotCustomer(access, body));
        }
        if (method === 'GET' && segments.length === 2) {
            assertCapability(access, 'lifecycle:read');
            return json(200, await lifecycle.getOrganisation(access, segments[1]));
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'export') {
            assertCapability(access, 'lifecycle:read');
            assertCapability(access, 'lifecycle:audit:read');
            const exported = await lifecycle.exportOrganisation(access, segments[1]);
            return raw(200, JSON.stringify(exported, null, 2), {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="nofries-lifecycle-${safeFilePart(segments[1])}.json"`,
                'Cache-Control': 'private, no-store, max-age=0'
            });
        }
        if ((method === 'PATCH' || method === 'PUT') && segments.length === 2) {
            assertCapability(access, 'lifecycle:write');
            if (body.lifecycleState) assertCapability(access, 'lifecycle:transition');
            return json(200, await lifecycle.updateOrganisation(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'prepare-scoping') {
            assertCapability(access, 'lifecycle:transition');
            return json(200, await lifecycle.prepareScoping(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'proposal-ready') {
            assertCapability(access, 'customer:accept');
            return json(200, await lifecycle.bindApprovedProposal(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'commercial-acceptance') {
            assertCapability(access, 'customer:accept');
            return json(200, await lifecycle.recordCommercialAcceptance(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'onboarding' && segments[3] === 'start') {
            assertCapability(access, 'onboarding:write');
            return json(200, await lifecycle.startCustomerOnboarding(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'external-reference') {
            assertCapability(access, 'integration:map');
            return json(200, await lifecycle.addExternalReference(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'customer-master' && segments[3] === 'change') {
            assertCapability(access, 'onboarding:write');
            return json(200, await lifecycle.updateCustomerMaster(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'support-profile' && segments[3] === 'change') {
            assertCapability(access, 'service-status:write');
            return json(200, await lifecycle.updateSupportProfile(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'device-match') {
            assertCapability(access, 'onboarding:write');
            return json(200, await lifecycle.matchOnboardingDevice(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'onboarding' && segments[3] === 'evidence') {
            assertCapability(access, 'onboarding:write');
            return json(200, await lifecycle.recordOnboardingEvidence(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'activation-requests') {
            assertCapability(access, 'onboarding:write');
            return json(201, await lifecycle.requestActivation(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 5 && segments[2] === 'activation-requests' && segments[4] === 'review') {
            assertCapability(access, 'onboarding:approve');
            return json(200, await lifecycle.reviewActivation(access, segments[1], segments[3], body));
        }
        if (method === 'POST' && segments.length === 5 && segments[2] === 'activation-requests' && segments[4] === 'execute') {
            assertCapability(access, 'onboarding:execute');
            return json(200, await lifecycle.executeActivation(access, segments[1], segments[3], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'service-status') {
            assertCapability(access, 'service-status:write');
            return json(200, await lifecycle.updateServiceStatus(access, segments[1], body));
        }
        if (method === 'GET' && segments.length === 3 && segments[2] === 'proof') {
            assertCapability(access, 'lifecycle:read');
            return json(200, await lifecycle.getCustomerProof(access, segments[1], {
                period: req && req.query && req.query.period
            }));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'proof') {
            assertCapability(access, 'proof:write');
            return json(200, await lifecycle.recordProofEvidence(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'proof' && segments[3] === 'approve') {
            assertCapability(access, 'proof:approve');
            return json(200, await lifecycle.approveCustomerProof(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 4 && segments[2] === 'proof' && segments[3] === 'issue') {
            assertCapability(access, 'proof:issue');
            return json(200, await lifecycle.issueCustomerProof(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'onboarding-device') {
            assertCapability(access, 'lifecycle:transition');
            return json(200, await lifecycle.updateOnboardingDevice(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'onboarding-gate') {
            assertCapability(access, 'lifecycle:transition');
            return json(200, await lifecycle.updateOnboardingGate(access, segments[1], body));
        }
        if (method === 'DELETE' && segments.length === 2) {
            assertCapability(access, 'tenant:admin');
            return json(200, await lifecycle.deleteOrganisation(access, segments[1], body));
        }
    }
    return json(404, { error: 'Lifecycle route not found', code: 'route_not_found' });
}

async function runLifecycleFunction(context, req) {
    try {
        const method = String(req && req.method || 'GET').toUpperCase();
        const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
        const clientKey = getClientKeyFromHeaders(req && req.headers || {}, 'unknown');
        const rateLimit = checkRateLimit(bucket, clientKey);
        if (!rateLimit.allowed) {
            context.res = json(429, { error: 'Too many requests. Please wait and try again.', code: 'rate_limited' }, rateLimitHeaders(rateLimit));
            return;
        }
        context.res = await handleLifecycleRequest(req);
        context.res.headers = apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), context.res.headers || {}));
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

function getLifecycleRepository(options = {}) {
    if (options.reset) {
        repository = null;
        service = null;
    }
    if (!repository) {
        repository = createLifecycleRepository({ dataDir: DATA_DIR });
    }
    return repository;
}

function getLifecycleService(options = {}) {
    if (options.reset) {
        repository = null;
        service = null;
    }
    const activeRepository = getLifecycleRepository();
    if (!service) {
        service = createLifecycleService({
            repository: activeRepository,
            approvedProposalVerifier: createApprovedProposalVerifier({ dataDir: DATA_DIR })
        });
    }
    return service;
}

function resetLifecycleRuntimeForTests() {
    repository = null;
    service = null;
}

function getLifecyclePath(req, context) {
    if (context.path != null) return String(context.path || '').replace(/^\/+|\/+$/g, '');
    const rawUrl = String(req.originalUrl || req.url || '');
    let pathname = rawUrl.split('?')[0];
    try {
        pathname = new URL(rawUrl, 'https://nofries.local').pathname;
    } catch (error) {
        // Keep the path-only value.
    }
    return pathname.replace(/^\/api\/lifecycle\/?/, '').replace(/^\/+|\/+$/g, '');
}

function getJsonBody(req) {
    if (!req || req.body == null) return {};
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
    if (typeof req.body === 'string') return parseJson(req.body);
    return req.body;
}

function parseJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        throw lifecycleError(400, 'Request body must contain valid JSON', 'invalid_json');
    }
}

function json(status, body, headers = {}) {
    return { status, headers: apiSecurityHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)), body };
}

function raw(status, body, headers = {}) {
    return { status, headers: apiSecurityHeaders(headers), body, isRaw: true };
}

function errorResponse(error, logger) {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500 && !(error instanceof LifecycleRepositoryError) && logger && typeof logger.error === 'function') {
        logger.error(error);
    }
    return json(status, Object.assign({
        error: status >= 500 && !(error instanceof LifecycleRepositoryError)
            ? 'No Fries could not complete that request'
            : error.message
    }, error.details || {}));
}

function lifecycleError(statusCode, message, code, details = {}) {
    return new LifecycleRepositoryError(statusCode, message, Object.assign({ code }, details));
}

function safeFilePart(value) {
    return String(value || 'organisation').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 120) || 'organisation';
}

module.exports = {
    errorResponse,
    getLifecycleRepository,
    getLifecycleService,
    handleLifecycleRequest,
    resetLifecycleRuntimeForTests,
    runLifecycleFunction
};
