const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const { createEnquiryService, EnquiryError } = require('../shared/enquiry');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('../shared/securityHeaders');
const { requestBodySize } = require('../shared/requestLimits');

const MAX_REQUEST_BYTES = 16 * 1024;

function createEnquiryFunction(service = createEnquiryService()) {
    return async function enquiry(context, req) {
        if (req.method === 'GET') {
            context.res = json(200, service.availability(), { 'Cache-Control': 'no-store' });
            return;
        }
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

        const rateLimit = checkRateLimit('apiEnquiry', getClientKeyFromHeaders(headers, 'unknown'));
        if (!rateLimit.allowed) {
            context.res = json(429, { error: 'Too many enquiries have been sent. Please wait and try again.' }, rateLimitHeaders(rateLimit));
            return;
        }

        try {
            const result = await service.submitEnquiry(req.body || {});
            context.res = json(200, result, rateLimitHeaders(rateLimit));
        } catch (error) {
            context.res = errorResult(error, context);
        }
    };
}

function errorResult(error, context) {
    if (error instanceof EnquiryError) {
        if (error.status >= 500 && context && context.log && typeof context.log.warn === 'function') {
            context.log.warn(`enquiry ${error.code}`);
        }
        return json(error.status, { error: error.publicMessage, code: error.code },
            Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? { 'Retry-After': String(error.retryAfter) } : {});
    }
    if (error && error.statusCode >= 400 && error.statusCode < 500) {
        return json(error.statusCode, Object.assign({ error: error.message }, error.details || {}));
    }
    if (context && context.log && typeof context.log.error === 'function') context.log.error('enquiry unexpected_error');
    return json(500, { error: 'Your enquiry could not be sent. Please email hello@nofries.nz.' });
}

function json(status, body, extraHeaders = {}) {
    return {
        status,
        headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }),
        body
    };
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

module.exports = createEnquiryFunction();
module.exports.createEnquiryFunction = createEnquiryFunction;
module.exports.errorResult = errorResult;
