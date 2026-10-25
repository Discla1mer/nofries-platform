const {
    checkRateLimit,
    getClientKeyFromHeaders,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const {
    BrowserAuthError,
    createBrowserAuthService,
    parseFormBody
} = require('../shared/browserAuth');
const { apiSecurityHeaders } = require('../shared/securityHeaders');

function createAuthLogoutFunction(options = {}) {
    const env = options.env || process.env;
    let configuredService = options.service || null;

    return async function authLogout(context, req) {
        const method = String(req && req.method || '').toUpperCase();
        if (method !== 'POST') {
            context.res = json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'POST' });
            return;
        }
        try {
            assertLogoutSameOriginRequest(req, env);
        } catch (error) {
            context.res = json(403, {
                error: 'This sign-out request was not accepted.',
                code: 'same_origin_required'
            });
            return;
        }

        const headers = req && req.headers || {};
        const rateLimit = checkRateLimit(
            'apiWrite',
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
            const form = parseFormBody(req && req.body);
            const service = configuredService || (configuredService = createBrowserAuthService({ env }));
            const result = await service.logout({
                returnTo: form.returnTo || req && req.query && req.query.returnTo,
                cookieHeader: getHeader(headers, 'cookie')
            });
            context.res = {
                status: 303,
                headers: apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), {
                    Location: result.location,
                    'Set-Cookie': result.cookie
                })),
                body: ''
            };
        } catch (error) {
            logSafeFailure(context, error);
            const status = error instanceof BrowserAuthError ? error.statusCode : 500;
            if (options.setupAccountChange === true && getHeader(headers, 'accept').includes('text/html')) {
                context.res = {
                    status,
                    headers: apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Content-Security-Policy': apiSecurityHeaders()['Content-Security-Policy'] + "; style-src 'self'; img-src 'self'"
                    })),
                    body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
                        '<meta name="robots" content="noindex,nofollow"><title>Sign-out was not confirmed | No Fries</title>' +
                        '<link rel="icon" href="/images/nofrieslogo.png" type="image/png"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/home.css"></head>' +
                        '<body class="access-page"><a class="skip-link" href="#signout-message">Skip to sign-out message</a>' +
                        '<header class="site-header shell"><a class="brand" href="/" aria-label="No Fries home"><img class="brand-logo" src="/images/nofrieslogo.png" width="44" height="44" alt="">' +
                        '<span class="brand-copy"><strong>No Fries</strong><span>Dashboard</span></span></a><a class="text-link" href="/">Back to home</a></header>' +
                        '<main class="shell account-notice-layout"><section class="organisation-card signup-card" id="signout-message" tabindex="-1" aria-labelledby="signout-title">' +
                        '<p class="eyebrow">Account access</p><h1 id="signout-title">Sign-out was not confirmed</h1>' +
                        '<p>No Fries could not confirm sign-out. Any sign-in already in progress may still finish. Wait for it to finish, then return to workspace setup and try again.</p>' +
                        '<a class="button" href="/signup?provider=external">Return to workspace setup</a>' +
                        '<p class="field-help signup-status-help"><a href="/report.html#kind=error&amp;screen=signup" target="_blank" rel="noopener noreferrer" aria-label="Report this problem (opens in a new tab)">Report this problem</a></p></section></main></body></html>'
                };
                return;
            }
            context.res = json(status, {
                error: status >= 500
                    ? 'No Fries sign-out is temporarily unavailable.'
                    : 'No Fries could not complete sign-out.',
                code: status >= 500 ? 'browser_auth_unavailable' : 'browser_auth_failed'
            }, rateLimitHeaders(rateLimit));
        }
    };
}

function assertLogoutSameOriginRequest(req, env = process.env) {
    const expectedOrigin = configuredPublicOrigin(env.NOFRIES_PUBLIC_URL);
    const headers = req && req.headers || {};
    const origin = String(getHeader(headers, 'origin')).trim();
    const fetchSite = String(getHeader(headers, 'sec-fetch-site')).trim().toLowerCase();

    if (!origin || origin === 'null') {
        if (fetchSite !== 'same-origin') {
            throw new BrowserAuthError(403, 'same_origin_required');
        }
        return;
    }

    let actualOrigin;
    try {
        actualOrigin = new URL(origin).origin;
    } catch (error) {
        throw new BrowserAuthError(403, 'same_origin_required');
    }
    if (
        origin !== actualOrigin ||
        actualOrigin !== expectedOrigin ||
        (fetchSite && fetchSite !== 'same-origin')
    ) {
        throw new BrowserAuthError(403, 'same_origin_required');
    }
}

function configuredPublicOrigin(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch (error) {
        throw new BrowserAuthError(503, 'browser_auth_public_url_invalid');
    }
    if (
        url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash
    ) {
        throw new BrowserAuthError(503, 'browser_auth_public_url_invalid');
    }
    return url.origin;
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
        context.log.warn(`Browser sign-out failed: ${code}`);
    }
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

const handler = createAuthLogoutFunction();
handler.createAuthLogoutFunction = createAuthLogoutFunction;

module.exports = handler;
