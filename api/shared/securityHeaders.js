const API_SECURITY_HEADERS = Object.freeze({
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow'
});

function apiSecurityHeaders(extraHeaders = {}) {
    return Object.assign({}, API_SECURITY_HEADERS, extraHeaders);
}

function assertSameOriginForMutation(req, env = process.env) {
    const method = String(req && req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return;
    }

    const fetchSite = getHeader(req, 'sec-fetch-site').toLowerCase();
    if (fetchSite === 'cross-site') {
        throw requestSecurityError('Cross-site requests are not permitted');
    }

    const origin = getHeader(req, 'origin');
    if (!origin) {
        if (fetchSite === 'same-origin' || allowHeaderlessMutation(env)) {
            return;
        }
        throw requestSecurityError('A same-origin request signal is required');
    }

    const allowedHosts = new Set([configuredPublicHost(env)].filter(Boolean));
    if (developmentAuthDisabled(env)) {
        allowedHosts.add(firstHeaderValue(getHeader(req, 'x-forwarded-host')).toLowerCase());
        allowedHosts.add(firstHeaderValue(getHeader(req, 'host')).toLowerCase());
        allowedHosts.delete('');
    }
    let originUrl;
    let originHost = '';
    try {
        originUrl = new URL(origin);
        originHost = originUrl.host.toLowerCase();
    } catch (error) {
        throw requestSecurityError('The request origin is invalid');
    }

    if (allowedHosts.has(originHost)) {
        return;
    }

    throw requestSecurityError('Cross-origin requests are not permitted');
}

function configuredPublicHost(env) {
    try {
        return new URL(String(env.NOFRIES_PUBLIC_URL || '')).host.toLowerCase();
    } catch (error) {
        return '';
    }
}

function allowHeaderlessMutation(env) {
    if (String(env.NOFRIES_ALLOW_HEADERLESS_MUTATIONS || '').trim().toLowerCase() === 'true') {
        return true;
    }
    return developmentAuthDisabled(env);
}

function developmentAuthDisabled(env) {
    return String(env.NODE_ENV || '').trim().toLowerCase() !== 'production' &&
        String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false';
}

function getHeader(req, name) {
    if (!req) {
        return '';
    }
    if (typeof req.get === 'function') {
        return String(req.get(name) || '').trim();
    }
    const headers = req.headers || {};
    return String(headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '').trim();
}

function firstHeaderValue(value) {
    return String(value || '').split(',')[0].trim();
}

function requestSecurityError(message) {
    const error = new Error(message);
    error.statusCode = 403;
    error.details = { code: 'same_origin_required' };
    return error;
}

module.exports = {
    API_SECURITY_HEADERS,
    apiSecurityHeaders,
    assertSameOriginForMutation
};
