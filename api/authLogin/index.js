const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const {
    BrowserAuthError,
    createBrowserAuthService
} = require('../shared/browserAuth');
const { apiSecurityHeaders } = require('../shared/securityHeaders');

function createAuthLoginFunction(options = {}) {
    if (options.customerTransport !== undefined && (options.customerTransport !== 'external' || options.customerEntry !== true)) {
        throw new TypeError('browser_auth_login_transport_invalid');
    }
    const env = options.env || process.env;
    let configuredService = options.service || null;

    return async function authLogin(context, req) {
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
                { error: 'Too many sign-in attempts. Please wait and try again.' },
                rateLimitHeaders(rateLimit)
            );
            return;
        }

        let accountChoice = false;
        try {
            const selection = req && req.query && req.query.account;
            if (selection !== undefined && (options.customerTransport !== 'external' || selection !== 'choose')) {
                throw new BrowserAuthError(400, 'browser_auth_account_selection_invalid');
            }
            accountChoice = selection === 'choose';
            const intent = req && req.query && req.query.intent;
            if (intent !== undefined && (intent !== 'create' || options.customerTransport !== 'external' || selection !== undefined)) {
                throw new BrowserAuthError(400, 'browser_auth_registration_invalid');
            }
            const service = configuredService || (configuredService = createBrowserAuthService({ env }));
            const result = await service.beginLogin({
                returnTo: req && req.query && req.query.returnTo,
                ...(intent === 'create' ? { registration: true } : {}),
                ...(accountChoice ? { selectAccount: true } : {})
            });
            context.res = redirect(result.location, result.cookie, rateLimitHeaders(rateLimit), 302);
        } catch (error) {
            logSafeFailure(context, error);
            if (options.customerEntry && getHeader(headers, 'accept').includes('text/html')) {
                context.res = { status: 303, headers: apiSecurityHeaders({ ...rateLimitHeaders(rateLimit),
                    Location: options.customerTransport === 'external'
                        ? '/login?signin=retry&provider=external' + (accountChoice ? '&account=choose' : '')
                        : '/login?signin=retry&provider=legacy' }), body: '' };
                return;
            }
            context.res = authError(error, rateLimitHeaders(rateLimit));
        }
    };
}

function redirect(location, cookie, extraHeaders = {}, status = 302) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({}, extraHeaders, {
            Location: location,
            'Set-Cookie': cookie
        })),
        body: ''
    };
}

function authError(error, extraHeaders = {}) {
    const status = error instanceof BrowserAuthError ? error.statusCode : 500;
    return json(status, {
        error: status >= 500
            ? 'No Fries sign-in is temporarily unavailable.'
            : 'No Fries could not start sign-in.',
        code: status >= 500 ? 'browser_auth_unavailable' : 'browser_auth_failed'
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
        context.log.warn(`Browser sign-in start failed: ${code}`);
    }
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

const handler = createAuthLoginFunction();
handler.createAuthLoginFunction = createAuthLoginFunction;

module.exports = handler;
