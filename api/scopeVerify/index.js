const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const { clearAccessCookie, createScopeAccessService, ScopeAccessError } = require('../shared/scopeAccess');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('../shared/securityHeaders');
const { requestBodySize } = require('../shared/requestLimits');

const service = createScopeAccessService();
const MAX_REQUEST_BYTES = 16 * 1024;

module.exports = async function scopeVerify(context, req) {
    const headers = req.headers || {};
    const method = String(req.method || 'GET').toUpperCase();
    if (isBlockedUserAgent(getHeader(headers, 'user-agent'))) {
        context.res = method === 'GET' ? redirect('/scope.html?error=blocked') : json(403, { error: 'Request blocked' });
        return;
    }
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        context.res = method === 'GET'
            ? redirect('/scope.html?error=request-too-large', clearAccessCookie())
            : json(413, { error: 'Request body is too large', code: 'request_too_large' });
        return;
    }
    try {
        assertSameOriginForMutation(req);
    } catch (error) {
        context.res = method === 'GET' ? redirect('/scope.html?error=origin', clearAccessCookie()) : errorResult(error, context);
        return;
    }

    const clientKey = getClientKeyFromHeaders(headers, 'unknown');
    const rateLimit = checkRateLimit('apiScopeVerify', clientKey);
    if (!rateLimit.allowed) {
        context.res = method === 'GET'
            ? redirect('/scope.html?error=rate-limit', clearAccessCookie())
            : json(429, { error: 'Too many verification attempts. Please request a new code.' }, rateLimitHeaders(rateLimit));
        return;
    }

    const query = req.query || {};
    const body = req.body || {};
    try {
        const result = await service.verifyAccess({
            challengeId: body.challengeId || query.id,
            code: body.code,
            linkToken: query.token
        });
        context.res = method === 'GET'
            ? redirect('/scope.html', result.cookie)
            : json(200, { verified: true, emailHint: result.emailHint }, {
                ...rateLimitHeaders(rateLimit),
                'Set-Cookie': result.cookie
            });
    } catch (error) {
        if (method === 'GET') {
            context.res = redirect(`/scope.html?error=${encodeURIComponent(error.code || 'verification')}`, clearAccessCookie());
            return;
        }
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
    return json(500, { error: 'No Fries could not confirm that code.' });
}

function redirect(location, cookie) {
    const headers = apiSecurityHeaders({
        'Location': location,
    });
    if (cookie) headers['Set-Cookie'] = cookie;
    return { status: 302, headers, body: '' };
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
