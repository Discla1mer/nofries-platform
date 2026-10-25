const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const { clearAccessCookie, createScopeAccessService, ScopeAccessError } = require('../shared/scopeAccess');
const { getServiceScope } = require('../shared/serviceScope');
const { apiSecurityHeaders } = require('../shared/securityHeaders');

const service = createScopeAccessService();

module.exports = async function scopeContent(context, req) {
    const headers = req.headers || {};
    if (isBlockedUserAgent(getHeader(headers, 'user-agent'))) {
        context.res = json(403, { error: 'Request blocked' });
        return;
    }

    const clientKey = getClientKeyFromHeaders(headers, 'unknown');
    const rateLimit = checkRateLimit('apiScopeContent', clientKey);
    if (!rateLimit.allowed) {
        context.res = json(429, { error: 'Too many requests. Please wait and try again.' }, rateLimitHeaders(rateLimit));
        return;
    }

    try {
        const viewer = service.authorize({
            cookie: getHeader(headers, 'cookie'),
            authorization: getHeader(headers, 'authorization')
        });
        context.res = json(200, {
            viewer: { emailHint: viewer.emailHint, expiresAt: viewer.expiresAt },
            scope: getServiceScope()
        }, rateLimitHeaders(rateLimit));
    } catch (error) {
        if (error instanceof ScopeAccessError) {
            context.res = json(error.status, { error: error.publicMessage, code: error.code }, {
                'Set-Cookie': clearAccessCookie()
            });
            return;
        }
        if (context && context.log && typeof context.log.error === 'function') context.log.error(error);
        context.res = json(500, { error: 'No Fries could not load the service scope.' });
    }
};

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