'use strict';

const fs = require('fs');
const path = require('path');
const { getProductRequestIdentity } = require('./identity');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { requestBodySize } = require('./requestLimits');
const { resolveCustomerPortalAccess } = require('./customerPortalAccess');
const { createCustomerPortalService } = require('./customerPortalService');
const {
    getMonthlyProofSchedulerHealth,
    requireMonthlyProofProductionReady
} = require('./monthlyProofScheduler');

const MAX_REQUEST_BYTES = 64 * 1024;
const IMMUTABLE_SUBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let service;

async function handleCustomerPortalRequest(req, routeContext = {}) {
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        throw portalError(413, 'Request body is too large', 'request_too_large');
    }
    assertSameOriginForMutation(req);
    const method = String(req && req.method || 'GET').toUpperCase();
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    assertCustomerPortalRuntimeEnabled(process.env, mutation);
    const routePath = customerPortalPath(req, routeContext);
    assertCustomerPortalProofRuntimeReady(process.env, routePath, method);
    const bootstrapProofAvailable = routePath === 'bootstrap'
        ? customerPortalBootstrapProofAvailable(process.env)
        : true;
    const identity = await getProductRequestIdentity(req);
    const access = resolveCustomerPortalAccess(identity);
    if (!access.allowed) {
        throw portalError(403, 'This identity has not been approved for a customer portal', 'customer_portal_access_required', {
            reason: access.reason
        });
    }
    assertCustomerPortalWriteSubjectScope(process.env, access, mutation);

    const segments = routePath
        .split('/')
        .filter(Boolean)
        .map(safeDecodeURIComponent);
    const body = getJsonBody(req);

    if (method === 'GET' && segments.length === 1 && segments[0] === 'app.js') {
        const protectedAssets = path.join(__dirname, 'protectedAssets');
        const application = [
            fs.readFileSync(path.join(protectedAssets, 'portalPending.js'), 'utf8'),
            fs.readFileSync(path.join(protectedAssets, 'portal.js'), 'utf8')
        ].join('\n');
        return raw(200, application, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff'
        });
    }

    const portal = getCustomerPortalService();
    if (method === 'GET' && segments.length === 1 && segments[0] === 'bootstrap') {
        return json(200, await portal.bootstrap(access, { proofAvailable: bootstrapProofAvailable }));
    }
    if (segments[0] === 'tickets') {
        if (method === 'GET' && segments.length === 1) {
            return json(200, await portal.listTickets(access));
        }
        if (method === 'POST' && segments.length === 1) {
            const result = await portal.createTicket(access, body);
            return json(customerPortalCreateStatus(result), result);
        }
        if (method === 'GET' && segments.length === 3 && segments[1] === 'operations') {
            return json(200, await portal.getOperationStatus(access, segments[2]));
        }
        if (method === 'GET' && segments.length === 2) {
            return json(200, await portal.getTicket(access, segments[1]));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'reply') {
            const result = await portal.replyToTicket(access, segments[1], body);
            return json(result.status === 'completed' ? 200 : 202, result);
        }
    }
    if (segments[0] === 'proof') {
        if (method === 'GET' && segments.length === 2 && segments[1] === 'current') {
            return json(200, await portal.getCurrentProof(access));
        }
        if (method === 'GET' && segments.length === 2 && segments[1] === 'history') {
            return json(200, await portal.getProofHistory(access));
        }
        if (method === 'GET' && segments.length === 2) {
            return json(200, await portal.getProofPeriod(access, segments[1]));
        }
    }

    return json(404, { error: 'Customer portal route not found', code: 'route_not_found' });
}

async function runCustomerPortalFunction(context, req) {
    let rateLimit = null;
    try {
        const method = String(req && req.method || 'GET').toUpperCase();
        const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
        rateLimit = checkRateLimit(bucket, getClientKeyFromHeaders(req && req.headers || {}, 'unknown'));
        if (!rateLimit.allowed) {
            context.res = json(429, {
                error: 'Too many requests. Please wait and try again.',
                code: 'rate_limited'
            }, rateLimitHeaders(rateLimit));
            return;
        }
        context.res = await handleCustomerPortalRequest(req);
        context.res.headers = apiSecurityHeaders(Object.assign(
            {},
            rateLimitHeaders(rateLimit),
            context.res.headers || {}
        ));
    } catch (error) {
        context.res = errorResponse(error, context && context.log);
        if (rateLimit) {
            context.res.headers = apiSecurityHeaders(Object.assign(
                {},
                rateLimitHeaders(rateLimit),
                context.res.headers || {}
            ));
        }
    }
}

function getCustomerPortalService(options = {}) {
    if (options.reset) service = null;
    if (options.service) {
        service = options.service;
        return service;
    }
    if (!service) {
        const { createAutotaskRuntime } = require('./serviceDesk/autotaskRuntimeFactory');
        const { getLifecycleService } = require('./appLifecycleRuntime');
        const {
            buildCustomerProofPortalView,
            publishedProofForPeriod
        } = require('./appLifecycle/monthlyProof');
        service = createCustomerPortalService({
            ticketProvider: createAutotaskRuntime({ env: process.env }),
            lifecycleService: getLifecycleService(),
            buildProofView: buildCustomerProofPortalView,
            proofForPeriod: publishedProofForPeriod
        });
    }
    return service;
}

function resetCustomerPortalRuntimeForTests() {
    service = null;
}

function customerPortalPath(req, context) {
    if (context.path != null) return String(context.path || '').replace(/^\/+|\/+$/g, '');
    const rawUrl = String(req && (req.originalUrl || req.url) || '');
    let pathname = rawUrl.split('?')[0];
    try {
        pathname = new URL(rawUrl, 'https://nofries.local').pathname;
    } catch (error) {
        // Retain the path-only value above.
    }
    return pathname.replace(/^\/api\/customer-portal\/?/, '').replace(/^\/+|\/+$/g, '');
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        throw portalError(404, 'Customer portal route not found', 'route_not_found');
    }
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
        throw portalError(400, 'Request body must contain valid JSON', 'invalid_json');
    }
}

function json(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'private, no-store, max-age=0'
        }, headers)),
        body
    };
}

function raw(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(headers),
        body,
        isRaw: true
    };
}

function errorResponse(error, logger) {
    const status = Number(error && error.statusCode);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus >= 500 && logger && typeof logger.error === 'function') logger.error(error);
    return json(safeStatus, Object.assign({
        error: safeStatus >= 500 ? 'No Fries could not complete that request' : error.message
    }, error && error.details || {}));
}

function portalError(statusCode, message, code, details = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = Object.assign({ code }, details);
    return error;
}

function customerPortalCreateStatus(result) {
    if (!result || result.status !== 'completed') return 202;
    return result.created === false ? 200 : 201;
}

function assertCustomerPortalRuntimeEnabled(env = process.env, write = false) {
    if (String(env.NOFRIES_CUSTOMER_PORTAL_ENABLED || '').trim().toLowerCase() !== 'true') {
        throw portalError(503, 'The customer portal is temporarily unavailable', 'customer_portal_disabled');
    }
    if (write && String(env.NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED || '').trim().toLowerCase() !== 'true') {
        throw portalError(503, 'Customer portal changes are temporarily unavailable', 'customer_portal_writes_disabled');
    }
    if (write) {
        const scope = String(env.NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE || '').trim().toLowerCase();
        if (!['canary', 'governed'].includes(scope)) {
            throw portalError(503, 'Customer portal changes are not admitted', 'customer_portal_write_scope_invalid');
        }
        if (scope === 'canary') parseCanarySubjects(env.NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS);
    }
}

function assertCustomerPortalProofRuntimeReady(env = process.env, routePath = '', method = 'GET',
    readiness = requireMonthlyProofProductionReady, schedulerHealth = getMonthlyProofSchedulerHealth) {
    const hosted = String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
    const proofDependent = routePath === 'proof' || routePath.startsWith('proof/');
    if (!hosted || !proofDependent) return null;
    try {
        return readiness();
    } catch (error) {
        const emergencyRead = emergencyProofReadReady(env, schedulerHealth);
        if (emergencyRead) return emergencyRead;
        throw portalError(503, 'The monthly Proof service is temporarily unavailable', 'monthly_proof_runtime_unavailable');
    }
}

function customerPortalBootstrapProofAvailable(env = process.env, readiness = requireMonthlyProofProductionReady,
    schedulerHealth = getMonthlyProofSchedulerHealth) {
    if (String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false') return true;
    try {
        readiness();
        return true;
    } catch (error) {
        return Boolean(emergencyProofReadReady(env, schedulerHealth));
    }
}

function emergencyProofReadReady(env = process.env, schedulerHealth = getMonthlyProofSchedulerHealth) {
    const exactReadOnlyVector =
        String(env.NOFRIES_CUSTOMER_PORTAL_ENABLED || '').trim().toLowerCase() === 'true' &&
        String(env.NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE || '').trim().toLowerCase() === 'disabled' &&
        String(env.NOFRIES_SERVICE_DESK_WRITE_SCOPE || '').trim().toLowerCase() === 'disabled' &&
        String(env.NOFRIES_AUTOTASK_MODE || '').trim().toLowerCase() === 'readonly' &&
        String(env.NOFRIES_AUTOTASK_WRITE_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_LIFECYCLE_STORAGE_PROVIDER || '').trim().toLowerCase() === 'azure';
    if (!exactReadOnlyVector) return null;
    const health = typeof schedulerHealth === 'function' ? schedulerHealth() : null;
    if (!health || health.enabled !== false || health.status !== 'disabled') return null;
    return health;
}

function assertCustomerPortalWriteSubjectScope(env = process.env, access = {}, write = false) {
    if (!write) return;
    const scope = String(env.NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE || '').trim().toLowerCase();
    if (scope === 'canary') {
        const subjects = parseCanarySubjects(env.NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS);
        if (!subjects.includes(String(access.user && access.user.subjectKey || ''))) {
            throw portalError(403, 'This customer identity is not admitted for portal changes', 'customer_portal_write_scope_denied');
        }
        return;
    }
    if (scope === 'governed' && access.user && access.user.role === 'customer_admin') return;
    throw portalError(403, 'This customer identity is not admitted for portal changes', 'customer_portal_write_scope_denied');
}

function parseCanarySubjects(value) {
    const source = String(value || '').trim();
    if (!source || /^@Microsoft\.KeyVault\(/i.test(source)) {
        throw portalError(503, 'The portal canary identity set is unavailable', 'customer_portal_canary_subjects_invalid');
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        throw portalError(503, 'The portal canary identity set is unavailable', 'customer_portal_canary_subjects_invalid');
    }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 25) {
        throw portalError(503, 'The portal canary identity set is unavailable', 'customer_portal_canary_subjects_invalid');
    }
    const subjects = parsed.map((item) => String(item || '').trim());
    if (subjects.some((item) => item !== item.toLowerCase() || !IMMUTABLE_SUBJECT_PATTERN.test(item)) ||
        new Set(subjects).size !== subjects.length) {
        throw portalError(503, 'The portal canary identity set is unavailable', 'customer_portal_canary_subjects_invalid');
    }
    return subjects;
}

module.exports = {
    assertCustomerPortalRuntimeEnabled,
    assertCustomerPortalProofRuntimeReady,
    assertCustomerPortalWriteSubjectScope,
    customerPortalBootstrapProofAvailable,
    customerPortalPath,
    customerPortalCreateStatus,
    errorResponse,
    getCustomerPortalService,
    handleCustomerPortalRequest,
    resetCustomerPortalRuntimeForTests,
    runCustomerPortalFunction
};
