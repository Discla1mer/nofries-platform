const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const {
    BrowserAuthError,
    clearAuthCookie,
    createBrowserAuthService
} = require('../shared/browserAuth');
const { apiSecurityHeaders } = require('../shared/securityHeaders');

function createAuthSessionFunction(options = {}) {
    const env = options.env || process.env;
    let configuredService = options.service || null;

    return async function authSession(context, req) {
        const method = String(req && req.method || 'GET').toUpperCase();
        if (method !== 'GET') {
            context.res = json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'GET' });
            return;
        }
        const headers = req && req.headers || {};
        if (isBlockedUserAgent(getHeader(headers, 'user-agent'), env)) {
            context.res = json(403, { error: 'Request blocked' });
            return;
        }
        const rateLimit = checkRateLimit(
            'apiRead',
            getClientKeyFromHeaders(headers, 'unknown'),
            env
        );
        if (!rateLimit.allowed) {
            context.res = json(
                429,
                { error: 'Too many requests. Please wait and try again.' },
                rateLimitHeaders(rateLimit)
            );
            return;
        }

        try {
            const service = configuredService || (configuredService = createBrowserAuthService({ env }));
            const details = await service.readSessionDetails(getHeader(headers, 'cookie'));
            if (!details) {
                context.res = authenticationRequired(rateLimitHeaders(rateLimit));
                return;
            }
            const identity = details.identity;
            context.res = json(200, {
                authenticated: true,
                user: {
                    email: identity.email,
                    name: identity.name,
                    tenantId: identity.tenantId,
                    principalId: identity.principalId
                },
                expiresAt: details.expiresAt
            }, rateLimitHeaders(rateLimit));
        } catch (error) {
            logSafeFailure(context, error);
            if (error instanceof BrowserAuthError && error.statusCode < 500) {
                context.res = authenticationRequired(Object.assign({}, rateLimitHeaders(rateLimit), {
                    'Set-Cookie': clearAuthCookie()
                }));
                return;
            }
            context.res = json(503, {
                error: 'No Fries session verification is temporarily unavailable.',
                code: 'browser_auth_unavailable'
            }, rateLimitHeaders(rateLimit));
        }
    };
}

function authenticationRequired(extraHeaders = {}) {
    return json(401, {
        authenticated: false,
        error: 'Sign-in is required.',
        code: 'authentication_required'
    }, extraHeaders);
}

function json(status, body, extraHeaders = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({
            'Content-Type': 'application/json; charset=utf-8'
        }, extraHeaders)),
        body
    };
}

function logSafeFailure(context, error) {
    const code = error instanceof BrowserAuthError ? error.code : 'browser_auth_unexpected';
    if (context && context.log && typeof context.log.warn === 'function') {
        context.log.warn(`Browser session verification failed: ${code}`);
    }
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

const handler = createAuthSessionFunction();
handler.createAuthSessionFunction = createAuthSessionFunction;

module.exports = handler;
