const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProductRequestIdentity } = require('./identity');
const {
    assertCapability,
    resolveTenantAccess
} = require('./tenantAccess');
const {
    apiSecurityHeaders,
    assertSameOriginForMutation
} = require('./securityHeaders');
const {
    checkRateLimit,
    getClientKeyFromHeaders,
    rateLimitHeaders
} = require('./abuseProtection');
const { requestBodySize } = require('./requestLimits');
const { createServiceDeskService } = require('./serviceDesk/agentRuntime');
const {
    ServiceDeskRepositoryError,
    createServiceDeskRepository
} = require('./serviceDesk/serviceDeskRepository');

const DATA_DIR = process.env.NOFRIES_DATA_DIR || path.join(os.tmpdir(), 'nofries-data');
const MAX_REQUEST_BYTES = 128 * 1024;

let repository;
let service;

async function handleServiceDeskRequest(req, routeContext = {}) {
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        throw serviceDeskError(413, 'Request body is too large', {
            code: 'request_too_large'
        });
    }
    assertSameOriginForMutation(req);
    const identity = await getProductRequestIdentity(req);
    const access = resolveTenantAccess(identity);
    if (!access.allowed) {
        throw serviceDeskError(403, 'This Microsoft identity has not been approved for a No Fries tenant', {
            code: 'tenant_access_required',
            reason: access.reason
        });
    }

    const method = String(req.method || 'GET').toUpperCase();
    const routePath = getServiceDeskPath(req, routeContext);
    const segments = routePath.split('/').filter(Boolean).map(decodeURIComponent);
    const body = normaliseMutationInput(req, getJsonBody(req));

    if (method === 'GET' && segments.length === 1 && segments[0] === 'app.js') {
        assertCapability(access, 'service-desk:read');
        return raw(
            200,
            fs.readFileSync(path.join(__dirname, 'protectedAssets', 'support.js'), 'utf8'),
            {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'private, no-store, max-age=0',
                'X-Content-Type-Options': 'nosniff'
            }
        );
    }

    const serviceDesk = getService();

    if (method === 'GET' && segments.length === 1 && segments[0] === 'bootstrap') {
        assertCapability(access, 'service-desk:read');
        return json(200, await serviceDesk.bootstrap(access));
    }

    if (segments[0] === 'tickets') {
        if (method === 'GET' && segments.length === 1) {
            return json(200, await serviceDesk.listTickets(access));
        }
        if (method === 'POST' && segments.length === 1) {
            const result = await serviceDesk.createTicket(access, body);
            return json(mutationStatus(result, 201), result);
        }
        if (method === 'GET' && segments.length === 3 && segments[1] === 'by-number') {
            return json(200, await serviceDesk.getTicketByNumber(access, segments[2], {
                customerId: queryValue(req, 'customerId')
            }));
        }
        if (method === 'GET' && segments.length === 2) {
            return json(200, await serviceDesk.getTicket(access, segments[1], {
                customerId: queryValue(req, 'customerId')
            }));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'replies') {
            const result = await serviceDesk.replyToTicket(access, segments[1], body);
            return json(mutationStatus(result, 200), result);
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'status') {
            const result = await serviceDesk.updateTicketStatus(access, segments[1], body);
            return json(mutationStatus(result, 200), result);
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'investigate') {
            return json(200, await serviceDesk.investigateTicket(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'approve') {
            return json(200, await serviceDesk.approveRecommendation(access, segments[1], body));
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'execute') {
            return json(200, await serviceDesk.executeApprovedRemediation(access, segments[1], body));
        }
    }


    if (segments[0] === 'operations' && segments.length >= 2) {
        if (method === 'GET' && segments.length === 2 && typeof serviceDesk.getOperationStatus === 'function') {
            return json(200, await serviceDesk.getOperationStatus(access, segments[1], {
                customerId: queryValue(req, 'customerId')
            }));
        }
        if (
            method === 'POST' && segments.length === 3 && segments[2] === 'resolve-absent' &&
            typeof serviceDesk.resolveOperationStepAbsent === 'function'
        ) {
            return json(200, await serviceDesk.resolveOperationStepAbsent(access, segments[1], body));
        }
    }

    if (method === 'GET' && segments.length === 1 && segments[0] === 'audit') {
        return json(200, await serviceDesk.getAudit(access));
    }

    return json(404, { error: 'Service-desk route not found', code: 'route_not_found' });
}

async function runServiceDeskFunction(context, req) {
    try {
        const headers = req && req.headers || {};
        const method = String(req && req.method || 'GET').toUpperCase();
        const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
        const clientKey = getClientKeyFromHeaders(headers, 'unknown');
        const rateLimit = checkRateLimit(bucket, clientKey);
        if (!rateLimit.allowed) {
            context.res = json(
                429,
                { error: 'Too many requests. Please wait and try again.', code: 'rate_limited' },
                rateLimitHeaders(rateLimit)
            );
            return;
        }
        if (requestBodySize(req) > MAX_REQUEST_BYTES) {
            context.res = json(
                413,
                { error: 'Request body is too large', code: 'request_too_large' },
                rateLimitHeaders(rateLimit)
            );
            return;
        }
        context.res = await handleServiceDeskRequest(req);
        context.res.headers = apiSecurityHeaders(Object.assign(
            {},
            rateLimitHeaders(rateLimit),
            context.res.headers || {}
        ));
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

function getServiceDeskPath(req, context) {
    if (context.path != null) {
        return String(context.path || '').replace(/^\/+|\/+$/g, '');
    }
    const rawUrl = String(req.originalUrl || req.url || '');
    let pathname = rawUrl.split('?')[0];
    try {
        pathname = new URL(rawUrl, 'https://nofries.local').pathname;
    } catch (error) {
        // Keep the path-only value above.
    }
    return pathname.replace(/^\/api\/service-desk\/?/, '').replace(/^\/+|\/+$/g, '');
}

function getJsonBody(req) {
    if (!req || req.body == null) {
        return {};
    }
    if (Buffer.isBuffer(req.body)) {
        return parseJson(req.body.toString('utf8'));
    }
    if (typeof req.body === 'string') {
        return parseJson(req.body);
    }
    return req.body;
}

function normaliseMutationInput(req, value) {
    const body = value && typeof value === 'object' && !Array.isArray(value) ? Object.assign({}, value) : value;
    const headerValue = requestHeader(req, 'idempotency-key');
    if (!headerValue || !body || typeof body !== 'object') return body;
    if (body.operationId && String(body.operationId) !== headerValue) {
        throw serviceDeskError(400, 'Use one matching operation identity', { code: 'operation_identity_ambiguous' });
    }
    body.operationId = headerValue;
    return body;
}

function requestHeader(req, name) {
    const headers = req && req.headers || {};
    const target = String(name).toLowerCase();
    const match = Object.keys(headers).find((key) => String(key).toLowerCase() === target);
    const value = match ? headers[match] : '';
    return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}

function queryValue(req, name) {
    if (req && req.query && req.query[name] != null) return String(req.query[name]);
    const rawUrl = String(req && (req.originalUrl || req.url) || '');
    try {
        return new URL(rawUrl, 'https://nofries.local').searchParams.get(name) || '';
    } catch (error) {
        return '';
    }
}

function mutationStatus(result, createdStatus) {
    if (result && (result.status === 'pending' || result.status === 'confirmation_required')) return 202;
    if (result && result.idempotentReplay === true) return 200;
    return createdStatus;
}

function parseJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        throw serviceDeskError(400, 'Request body must contain valid JSON', {
            code: 'invalid_json'
        });
    }
}

function getService() {
    if (!service) {
        // The service-desk agents stay independently testable, but use the same
        // tenant-isolated lifecycle context whenever a ticket customer is linked.
        const { getLifecycleService } = require('./appLifecycleRuntime');
        const contextProvider = getLifecycleService();
        if (String(process.env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase() === 'autotask') {
            const { createProductionServiceDeskService } = require('./serviceDesk/productionServiceDeskService');
            service = createProductionServiceDeskService({
                env: process.env,
                contextProvider
            });
        } else {
            if (!repository) repository = createServiceDeskRepository({ dataDir: DATA_DIR });
            service = createServiceDeskService({
                repository,
                contextProvider
            });
        }
    }
    return service;
}

function resetServiceDeskRuntimeForTests() {
    repository = null;
    service = null;
}

function json(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({
            'Content-Type': 'application/json; charset=utf-8'
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
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    if (status >= 500 && !(error instanceof ServiceDeskRepositoryError) && logger && typeof logger.error === 'function') {
        logger.error(error);
    }
    return json(status, Object.assign({
        error: status >= 500 && !(error instanceof ServiceDeskRepositoryError)
            ? 'No Fries could not complete that request'
            : error.message
    }, error.details || {}));
}

function serviceDeskError(statusCode, message, details = {}) {
    return new ServiceDeskRepositoryError(statusCode, message, details);
}

module.exports = {
    errorResponse,
    handleServiceDeskRequest,
    resetServiceDeskRuntimeForTests,
    runServiceDeskFunction
};
