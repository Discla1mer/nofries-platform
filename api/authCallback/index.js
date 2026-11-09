const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('../shared/abuseProtection');
const {
    BrowserAuthError,
    clearTransactionCookie,
    createBrowserAuthService
} = require('../shared/browserAuth');
const { logSafeFailure: logStaffFailure } = require('../shared/browserAuthDiagnostics');
const { apiSecurityHeaders } = require('../shared/securityHeaders');

function createAuthCallbackFunction(options = {}) {
    if (options.customerTransport !== undefined && (options.customerTransport !== 'external' || options.customerEntry !== true)) {
        throw new TypeError('browser_auth_callback_transport_invalid');
    }
    const env = options.env || process.env;
    const clearCallbackTransaction = options.clearTransactionCookie || clearTransactionCookie;
    let configuredService = options.service || null;

    return async function authCallback(context, req) {
        const method = String(req && req.method || '').toUpperCase();
        if (method !== 'POST') {
            if (!options.customerEntry) logStaffFailure(context, new BrowserAuthError(405, 'method_not_allowed'));
            context.res = json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'POST' });
            return;
        }
        const headers = req && req.headers || {};
        if (isBlockedUserAgent(getHeader(headers, 'user-agent'), env)) {
            if (!options.customerEntry) logStaffFailure(context, new BrowserAuthError(403, 'request_blocked'));
            context.res = json(403, { error: 'Request blocked' });
            return;
        }
        const rateLimit = checkRateLimit(
            'apiWrite',
            getClientKeyFromHeaders(headers, 'unknown'),
            env
        );
        if (!rateLimit.allowed) {
            if (!options.customerEntry) logStaffFailure(context, new BrowserAuthError(429, 'rate_limited'));
            context.res = json(
                429,
                { error: 'Too many sign-in attempts. Please wait and try again.' },
                rateLimitHeaders(rateLimit)
            );
            return;
        }

        try {
            const service = configuredService || (configuredService = createBrowserAuthService({ env }));
            const result = await service.completeLogin({
                body: req && req.body,
                cookieHeader: getHeader(headers, 'cookie')
            });
            // Static hosting cannot use the HttpOnly session cookie to choose
            // a signup document. Carry only this fixed presentation hint after
            // successful external authentication; never accept a return URL.
            const location = options.customerTransport === 'external' && result.location === '/signup'
                ? '/signup?provider=external' : result.location;
            context.res = redirect(location, result.cookies || result.cookie, rateLimitHeaders(rateLimit));
        } catch (error) {
            // Customer support references retain their existing behavior.
            const reference = options.customerEntry ? supportReference() : null;
            if (options.customerEntry) logSafeFailure(context, error, reference);
            else logStaffFailure(context, error);
            if (options.customerEntry && getHeader(headers, 'accept').includes('text/html')) {
                const responseHeaders = rateLimitHeaders(rateLimit);
                if (shouldClearTransactionCookie(error)) responseHeaders['Set-Cookie'] = clearCallbackTransaction();
                // Presentation only: never relay a provider error, callback
                // value or return URL. Missing cookies remain a generic retry.
                const recovery = error instanceof BrowserAuthError && error.code === 'browser_auth_transaction_expired'
                    ? 'expired' : error instanceof BrowserAuthError && ACCOUNT_RECOVERY_CODES.has(error.code) ? 'account' : 'retry';
                context.res = { status: 303, headers: apiSecurityHeaders({ ...responseHeaders,
                    Location: (options.customerTransport === 'external'
                        ? `/login?signin=${recovery}&provider=external` : `/login?signin=${recovery}&provider=legacy`) + `&ref=${reference}` }), body: '' };
                return;
            }
            context.res = authError(error, rateLimitHeaders(rateLimit), clearCallbackTransaction);
        }
    };
}

function redirect(location, cookie, extraHeaders = {}) {
    return {
        status: 303,
        headers: apiSecurityHeaders(Object.assign({}, extraHeaders, {
            Location: location,
            'Set-Cookie': cookie
        })),
        body: ''
    };
}

function authError(error, extraHeaders = {}, clearCallbackTransaction = clearTransactionCookie) {
    const status = error instanceof BrowserAuthError ? error.statusCode : 500;
    const headers = Object.assign({}, extraHeaders);
    if (shouldClearTransactionCookie(error)) {
        headers['Set-Cookie'] = clearCallbackTransaction();
    }
    return json(status, {
        error: status >= 500
            ? 'No Fries sign-in is temporarily unavailable.'
            : 'No Fries could not complete sign-in. Please try again.',
        code: status >= 500 ? 'browser_auth_unavailable' : 'browser_auth_failed'
    }, headers);
}

function shouldClearTransactionCookie(error) {
    if (!error || typeof error !== 'object') return false;
    if (error.clearTransactionCookie === true) return true;
    return error instanceof BrowserAuthError && [
        'browser_auth_cookie_invalid',
        'browser_auth_transaction_invalid',
        'browser_auth_transaction_missing'
    ].includes(error.code);
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

// Authentication succeeded at the provider, but No Fries holds no active
// account for it (missing, expired, revoked or unverified customer record).
// Retrying cannot help; the visitor needs support, so say so.
const ACCOUNT_RECOVERY_CODES = new Set(['browser_auth_customer_required', 'browser_auth_email_verification_required']);
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function supportReference() {
    const bytes = require('node:crypto').randomBytes(6);
    return 'NF-' + Array.from(bytes, byte => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join('');
}

function logSafeFailure(context, error, reference) {
    const code = error instanceof BrowserAuthError ? error.code : 'browser_auth_unexpected';
    if (context && context.log && typeof context.log.warn === 'function') {
        const stage = ['customer_begin', 'customer_verify', 'customer_recheck', 'session_record', 'runtime_epoch',
            'session_save', 'epoch_after_save', 'issuance_proof', 'epoch_after_proof'].includes(error?.diagnosticStage) ? ` stage=${error.diagnosticStage}` : '';
        context.log.warn(`Browser sign-in callback failed: ${code}${stage}${reference ? ` ref=${reference}` : ''}`);
    }
}

function getHeader(headers, name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

const handler = createAuthCallbackFunction();
handler.createAuthCallbackFunction = createAuthCallbackFunction;

module.exports = handler;
