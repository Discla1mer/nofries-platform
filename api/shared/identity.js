const { BrowserAuthError, readBrowserSessionCookie } = require('./browserAuth');
const { createBrowserSessionStore } = require('./browserSessionStore');

let hostedBrowserSessionStore = null;

function getRequestIdentity(req, env = process.env) {
    const principal = parseStaticWebAppsPrincipal(getHeader(req, 'x-ms-client-principal'));
    const body = req.body || {};
    const query = req.query || {};
    const allowDevelopmentIdentity = !isHostedAuthRequired(env);
    const fallbackEmail = allowDevelopmentIdentity ? (
        body.email ||
        query.email ||
        getHeader(req, 'X-NoFries-Email') ||
        env.NOFRIES_DEV_EMAIL ||
        ''
    ) : '';
    const fallbackName = allowDevelopmentIdentity ? (body.name || query.name || '') : '';
    const clientEmail = normaliseEmail(fallbackEmail);
    const email = normaliseEmail(principal.email || fallbackEmail);

    return {
        email,
        clientEmail,
        name: String(principal.name || fallbackName || '').trim(),
        provider: principal.provider || (principal.email ? 'azure-static-web-apps' : 'email'),
        principalId: principal.id || null,
        tenantId: principal.tenantId || '',
        isAuthenticated: Boolean(principal.email),
        emailSource: principal.email ? 'azure-static-web-apps' : 'client'
    };
}

async function getProductRequestIdentity(req, env = process.env, options = {}) {
    const mode = browserAuthMode(env);
    if (mode === 'swa') {
        return getRequestIdentity(req, env);
    }

    const store = options.store || getHostedBrowserSessionStore(env);
    try {
        const identity = await readBrowserSessionCookie(req, {
            env,
            store,
            now: options.now
        });
        if (!identity) {
            throw new BrowserAuthError(401, 'browser_auth_session_missing');
        }
        return identity;
    } catch (error) {
        if (error instanceof BrowserAuthError) {
            throw browserIdentityError(error);
        }
        throw browserIdentityError(new BrowserAuthError(503, 'browser_auth_unavailable'));
    }
}

function browserAuthMode(env = process.env) {
    const value = String(env.NOFRIES_BROWSER_AUTH_MODE || '').trim().toLowerCase();
    if (!value && String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false') {
        return 'swa';
    }
    if (value !== 'swa' && value !== 'entra_bff') {
        const error = new Error('No Fries browser authentication is not configured.');
        error.statusCode = 503;
        error.details = { code: 'browser_auth_unavailable' };
        throw error;
    }
    return value;
}

function getHostedBrowserSessionStore(env) {
    if (env !== process.env) {
        return createBrowserSessionStore({ env });
    }
    if (!hostedBrowserSessionStore) {
        hostedBrowserSessionStore = createBrowserSessionStore({ env });
    }
    return hostedBrowserSessionStore;
}

function browserIdentityError(error) {
    const statusCode = Number(error && error.statusCode) === 401 ? 401 : 503;
    const result = new Error(statusCode === 401
        ? 'Sign-in is required.'
        : 'No Fries session verification is temporarily unavailable.');
    result.statusCode = statusCode;
    result.details = {
        code: statusCode === 401 ? 'authentication_required' : 'browser_auth_unavailable'
    };
    return result;
}

function resetRequestIdentityForTests() {
    hostedBrowserSessionStore = null;
}

function getHeader(req, name) {
    if (!req) {
        return '';
    }
    if (typeof req.get === 'function') {
        return req.get(name) || '';
    }
    const headers = req.headers || {};
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function parseStaticWebAppsPrincipal(header) {
    if (!header) {
        return {};
    }

    try {
        const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        const claims = Array.isArray(payload.claims) ? payload.claims : [];
        return {
            id: payload.userId || '',
            email: normaliseEmail(payload.userDetails || getClaim(claims, [
                'emails',
                'email',
                'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
            ])),
            name: getClaim(claims, [
                'name',
                'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
            ]) || payload.userDetails || '',
            tenantId: getClaim(claims, [
                'tid',
                'tenantid',
                'http://schemas.microsoft.com/identity/claims/tenantid'
            ]),
            provider: payload.identityProvider || 'azure-static-web-apps'
        };
    } catch (error) {
        return {};
    }
}

function getClaim(claims, names) {
    const matched = claims.find((claim) => names.includes(claim.typ));
    return matched ? String(matched.val || '').trim() : '';
}

function normaliseEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isHostedAuthRequired(env) {
    // Authentication is fail-closed. Local development must explicitly opt out.
    return String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
}

module.exports = {
    browserAuthMode,
    getProductRequestIdentity,
    getRequestIdentity,
    parseStaticWebAppsPrincipal,
    resetRequestIdentityForTests
};
