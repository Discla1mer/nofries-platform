'use strict';

const crypto = require('node:crypto');
const { copy, fields, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const { assertExactSameOriginRequest } = require('../browserAuth');
const { apiSecurityHeaders } = require('../securityHeaders');
const { LunaProfileError, MAX_BYTES } = require('./lunaProfile');
const COOKIES = ['__Host-nofries-customer', '__Host-nofries-external-customer'];
const HEADERS = ['cookie', 'origin', 'sec-fetch-site', 'x-csrf-token', 'content-type', 'content-length'];
const PUBLIC_ERRORS = Object.freeze({ luna_profile_input_invalid: 400, luna_profile_unauthenticated: 401,
    luna_profile_access_denied: 403, luna_profile_method_not_allowed: 405,
    luna_profile_conflict: 409, luna_profile_request_too_large: 413, luna_profile_unavailable: 503 });
const fail = (code = 'luna_profile_input_invalid') => { throw new LunaProfileError(code, PUBLIC_ERRORS[code]); };
const response = (status, body, headers = {}) => ({ status, isRaw: false, body,
    headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }) });
function snapshot(input) {
    try {
        const request = copy(input, MAX_BYTES + 8192);
        const optional = ['query', 'body'].filter(key => Object.hasOwn(request, key));
        fields(request, ['method', 'headers', ...optional]);
        if (!['GET', 'POST'].includes(request.method)) fail('luna_profile_method_not_allowed');
        fields(request.query === undefined ? {} : request.query, []);
        const raw = request.headers;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 64) fail();
        const headers = {};
        for (const [key, value] of Object.entries(raw)) {
            const lower = key.toLowerCase();
            if (!HEADERS.includes(lower)) continue;
            if (Object.hasOwn(headers, lower) || typeof value !== 'string' || /[\r\n\0]/.test(value)) fail();
            headers[lower] = value;
        }
        if (Buffer.byteLength(headers.cookie || '') > 4096) fail('luna_profile_request_too_large');
        if (request.method === 'GET') {
            if (Object.hasOwn(request, 'body') || headers['content-length'] && headers['content-length'] !== '0') fail();
        } else {
            if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')) fail();
            if (headers['content-length'] !== undefined &&
                (!/^(0|[1-9][0-9]*)$/.test(headers['content-length']) || Number(headers['content-length']) > MAX_BYTES)) {
                fail('luna_profile_request_too_large');
            }
            request.body = fields(copy(request.body, MAX_BYTES), ['nickname', 'expectedRevision', 'operationId']);
        }
        return freeze({ method: request.method, headers, ...(request.method === 'POST' ? { body: request.body } : {}) });
    } catch (error) {
        if (error instanceof LunaProfileError) throw error;
        if (error?.code === 'onboarding_request_too_large') fail('luna_profile_request_too_large');
        fail();
    }
}

// Dormant normalized HTTP port, not a route registration. A future host must
// retain its /api security/rate middleware and bounded raw-body parser. All
// dependencies below are private server composition, never request assertions.
function createLunaProfileHandlers({ service, env, customerCookie, issueCsrfToken }) {
    if (!service || ['read', 'save'].some(key => typeof service[key] !== 'function') ||
        !COOKIES.includes(customerCookie) || typeof issueCsrfToken !== 'function' ||
        typeof env?.NOFRIES_PUBLIC_URL !== 'string') throw new TypeError('Invalid Luna profile handlers');
    const originEnvironment = Object.freeze({ NOFRIES_PUBLIC_URL: env.NOFRIES_PUBLIC_URL });
    const read = service.read.bind(service), save = service.save.bind(service);
    return Object.freeze({ async handleRequest(input) {
        try {
            // Snapshot before CSRF/current-customer/storage calls can await.
            const request = snapshot(input), cookie = request.headers.cookie || '';
            const names = cookie.split(';').map(value => value.trim().split('=')[0]);
            if (names.filter(name => name === customerCookie).length !== 1 ||
                names.some(name => COOKIES.includes(name) && name !== customerCookie)) fail('luna_profile_unauthenticated');
            if (request.method === 'POST') {
                try { assertExactSameOriginRequest(request, originEnvironment); }
                catch (_) { fail('luna_profile_access_denied'); }
            }
            const csrfToken = await issueCsrfToken(request);
            if (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken)) fail('luna_profile_unavailable');
            if (request.method === 'POST') {
                const supplied = request.headers['x-csrf-token'];
                if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
                    !crypto.timingSafeEqual(Buffer.from(csrfToken), Buffer.from(supplied))) fail('luna_profile_access_denied');
            }
            // The actual service repeats current ownership checks around store
            // work, including after the adapter's asynchronous write preflight.
            const profile = request.method === 'GET' ? await read(cookie) : await save(cookie, request.body);
            return response(200, { profile, csrfToken });
        } catch (error) {
            const code = error instanceof LunaProfileError && Object.hasOwn(PUBLIC_ERRORS, error.code) &&
                PUBLIC_ERRORS[error.code] === error.statusCode ? error.code : 'luna_profile_unavailable';
            return response(PUBLIC_ERRORS[code], { code }, code === 'luna_profile_method_not_allowed' ? { Allow: 'GET, POST' } : {});
        }
    } });
}

module.exports = { createLunaProfileHandlers };
