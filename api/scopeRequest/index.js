const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const { createScopeAccessService, ScopeAccessError } = require('../shared/scopeAccess');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('../shared/securityHeaders');
const { requestBodySize } = require('../shared/requestLimits');

const service = createScopeAccessService();
const MAX_REQUEST_BYTES = 16 * 1024;

module.exports = async function scopeRequest(context, req) {
    const headers = req.headers || {};
    if (isBlockedUserAgent(getHeader(headers, 'user-agent'))) {
        context.res = json(403, { error: 'Request blocked' });
        return;
    }
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        context.res = json(413, { error: 'Request body is too large', code: 'request_too_large' });
        return;
    }
    try {
        assertSameOriginForMutation(req);
    } catch (error) {
        context.res = errorResult(error, context);
        return;
    }

    const clientKey = getClientKeyFromHeaders(headers, 'unknown');
    const rateLimit = checkRateLimit('apiScopeRequest', clientKey);
    if (!rateLimit.allowed) {
        context.res = json(429, { error: 'Too many verification emails have been requested. Please wait and try again.' }, rateLimitHeaders(rateLimit));
        return;
    }

    try {
        const result = await service.requestAccess({
            email: req.body && req.body.email,
            website: req.body && req.body.website,
            ip: clientKey
        });
        context.res = json(200, result, rateLimitHeaders(rateLimit));
    } catch (error) {
        context.res = errorResult(error, context);
    }
};

function errorResult(error, context) {
    if (error instanceof ScopeAccessError) {
        return json(error.status, { error: error.publicMessage, code: error.code });
    }
    if (error && error.statusCode >= 400 && error.statusCode < 500) {
        return json(error.statusCode, Object.assign({ error: error.message }, error.details || {}));
    }
    if (context && context.log && typeof context.log.error === 'function') context.log.error(error);
    return json(500, { error: 'No Fries could not send that verification email.' });
}

function json(status, body, extraHeaders = {}) {
    return {
        status,
        headers: apiSecurityHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            ...extraHeaders
        }),
        body
    };
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}
