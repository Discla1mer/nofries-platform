'use strict';

// Unconnected source factory. No ambient environment, SDK identity client,
// logger, credential chain or cache file. Disabled before all other access.
const { isIP } = require('node:net');
const RESOURCE = 'https://vault.azure.net';
const SCOPE = RESOURCE + '/.default';
const DEADLINE_MS = 2000, MAX_BYTES = 32768, MAX_OUTSTANDING = 4;
const OPERATION_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE = 'App Service identity is temporarily unavailable.';
const error = () => Object.assign(new Error(MESSAGE), { code: 'appservice_identity_unavailable' });
const fail = () => { throw error(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Reflect.ownKeys(value).every(key => keys.includes(key));

function endpoint(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value)) fail();
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Deliberately narrow local-address policy, not a claim that the platform
    // guarantees these ranges. Real endpoint compatibility is a promotion gate.
    const local = host === '::1' || isIP(host) === 4 &&
        (host.startsWith('127.') || host.startsWith('169.254.') && host !== '169.254.169.254');
    if (url.href !== value || url.protocol !== 'http:' || !local || url.username || url.password ||
        url.search || url.hash || url.pathname.startsWith('/metadata/')) fail();
    return url.href;
}

// JSON.parse alone accepts duplicate keys. The REST success contract is flat;
// tokenize just that grammar and reject duplicate (including escaped) keys.
function flatJson(text) {
    let at = 0;
    const ws = () => { while (/[\t\n\r ]/.test(text[at] || '') && at < text.length) at++; };
    const string = () => {
        const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(at));
        if (!match) fail();
        at += match[0].length;
        return JSON.parse(match[0]);
    };
    const result = Object.create(null); ws();
    if (text[at++] !== '{') fail(); ws();
    if (text[at] !== '}') for (;;) {
        const key = string(); ws(); if (text[at++] !== ':') fail(); ws();
        if (Object.hasOwn(result, key)) fail();
        let value;
        if (text[at] === '"') value = string();
        else {
            const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
            if (!match) fail(); at += match[0].length; value = JSON.parse(match[0]);
        }
        result[key] = value; ws();
        if (text[at] !== ',') break;
        at++; ws();
    }
    if (text[at++] !== '}') fail(); ws();
    if (at !== text.length) fail();
    return result;
}

function seconds(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,10})$/.test(value)) fail();
    const n = Number(value);
    if (!Number.isSafeInteger(n * 1000)) fail();
    return n;
}

function accessToken(bytes, clientId, now) {
    const data = flatJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!only(data, ['access_token', 'expires_on', 'resource', 'token_type', 'client_id',
        'not_before', 'expires_in', 'ext_expires_in']) || data.resource !== RESOURCE ||
        data.token_type !== 'Bearer' || data.client_id !== clientId ||
        typeof data.access_token !== 'string' || data.access_token.length > 16384 ||
        !/^[A-Za-z0-9\-._~+/]+={0,2}$/.test(data.access_token)) fail();
    const expires = seconds(data.expires_on) * 1000, at = now();
    if (!Number.isSafeInteger(at) || at < 0 || expires < at + 60000 || expires > at + 172800000) fail();
    if (data.not_before !== undefined && seconds(data.not_before) * 1000 > at + 30000) fail();
    for (const key of ['expires_in', 'ext_expires_in']) {
        if (data[key] !== undefined && (seconds(data[key]) < 1 || seconds(data[key]) > 172800)) fail();
    }
    // Opaque token; never decode JWT claims as authority or log any part of it.
    return Object.freeze({ token: data.access_token, expiresOnTimestamp: expires, tokenType: 'Bearer' });
}

function createAppServiceCredential(options = {}, dependencies = {}) {
    try {
        if (options.enabled === undefined || options.enabled === false) return null;
        if (options.enabled !== true || !only(options, ['enabled', 'env', 'identity', 'tenantId']) ||
            !only(dependencies, ['request', 'now'])) fail();
        const { env, identity, tenantId } = options;
        if (!object(env) || !only(identity, ['kind', 'clientId']) ||
            !Object.hasOwn(identity, 'kind') || !Object.hasOwn(identity, 'clientId') ||
            !['system-assigned', 'user-assigned'].includes(identity.kind) ||
            typeof identity.clientId !== 'string' || !UUID.test(identity.clientId) ||
            typeof tenantId !== 'string' || !UUID.test(tenantId)) fail();
        const kind = identity.kind, clientId = identity.clientId;
        const pinnedEndpoint = endpoint(env.IDENTITY_ENDPOINT);
        const request = dependencies.request === undefined ? require('node:http').request : dependencies.request;
        const now = dependencies.now === undefined ? Date.now : dependencies.now;
        if (typeof now !== 'function' || typeof request !== 'function') fail();
        let outstanding = 0;
        const attempted = new WeakMap();

        function inputs(scopes, input) {
            if (!(scopes === SCOPE || Array.isArray(scopes) && scopes.length === 1 && scopes[0] === SCOPE) ||
                !only(input, ['abortSignal', 'requestOptions', 'tracingOptions', 'enableCae', 'tenantId']) ||
                input.tenantId !== undefined && input.tenantId !== tenantId ||
                input.enableCae !== undefined && typeof input.enableCae !== 'boolean') fail();
            // CAE is advisory in the SDK; MI does not support workload CAE.
            // Any claims/PoP request is rejected by the option allowlist above.
            const signal = input.abortSignal;
            if (signal !== undefined && (!object(signal) || typeof signal.aborted !== 'boolean' ||
                typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail();
            if (signal?.aborted) fail();
            let timeout = DEADLINE_MS;
            if (input.requestOptions !== undefined) {
                if (!only(input.requestOptions, ['timeout'])) fail();
                const n = input.requestOptions.timeout;
                if (n !== undefined) {
                    if (!Number.isSafeInteger(n) || n < 1 || n > 5000) fail();
                    timeout = Math.min(timeout, n);
                }
            }
            if (input.tracingOptions !== undefined && !only(input.tracingOptions, ['tracingContext'])) fail();
            // Tracing context is intentionally not forwarded or inspected.
            return { signal, timeout };
        }

        function acquire(signal, timeout) {
            if (outstanding >= MAX_OUTSTANDING) fail();
            if (endpoint(env.IDENTITY_ENDPOINT) !== pinnedEndpoint) fail();
            const header = env.IDENTITY_HEADER;
            if (typeof header !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(header)) fail();
            const url = new URL(pinnedEndpoint);
            url.searchParams.set('resource', RESOURCE);
            url.searchParams.set('api-version', '2019-08-01');
            if (kind === 'user-assigned') url.searchParams.set('client_id', clientId);
            outstanding++;
            return new Promise((resolve, reject) => {
                let req, body, settled = false, released = false, timer, bytes = 0, started;
                const chunks = [];
                const release = () => { if (!released) { released = true; outstanding--; } };
                const destroy = () => {
                    try { body?.destroy(); } catch (_) { /* never expose transport errors */ }
                    try { req?.destroy(); } catch (_) { /* no speculative capacity release */ }
                };
                const finish = (value, failed = false) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try { signal?.removeEventListener('abort', abort); } catch (_) { /* no transport detail */ }
                    chunks.length = 0;
                    if (failed) { destroy(); reject(error()); } else resolve(value);
                };
                const abort = () => finish(null, true);
                const current = () => {
                    const at = now();
                    if (!Number.isSafeInteger(at) || at < started || at - started >= timeout || signal?.aborted) fail();
                };
                try {
                    started = now();
                    if (!Number.isSafeInteger(started) || started < 0) fail();
                    timer = setTimeout(abort, timeout);
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted) { abort(); release(); return; }
                    req = request(url, { method: 'GET', agent: false, maxHeaderSize: 8192,
                        headers: { 'X-IDENTITY-HEADER': header, Accept: 'application/json', 'Accept-Encoding': 'identity' } });
                    req.on('error', abort);
                    req.on('close', () => { if (!settled) abort(); release(); });
                    req.on('response', response => {
                        body = response;
                        response.on('error', abort);
                        response.on('aborted', abort);
                        response.on('close', () => { if (!settled) abort(); });
                        if (settled) { destroy(); return; }
                        try {
                            current();
                            const headers = response.headers;
                            const type = headers['content-type'], length = headers['content-length'];
                            if (response.statusCode !== 200 || typeof type !== 'string' ||
                                !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
                                headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity' ||
                                length !== undefined && (typeof length !== 'string' || !/^[0-9]{1,8}$/.test(length) || Number(length) > MAX_BYTES)) fail();
                            response.on('data', chunk => {
                                if (settled) return;
                                try {
                                    current();
                                    if (!(chunk instanceof Uint8Array) || chunk.length === 0 ||
                                        chunks.length >= 4096 || (bytes += chunk.length) > MAX_BYTES) fail();
                                    chunks.push(Buffer.from(chunk));
                                } catch (_) { abort(); }
                            });
                            response.on('end', () => {
                                if (settled) return;
                                try {
                                    current();
                                    if (length !== undefined && bytes !== Number(length)) fail();
                                    const token = accessToken(Buffer.concat(chunks, bytes), clientId, now);
                                    current();
                                    finish(token);
                                } catch (_) { abort(); }
                            });
                        } catch (_) { abort(); }
                    });
                    req.end();
                } catch (_) {
                    finish(null, true);
                    if (!req) release();
                }
                // Release only on actual request close; an injected broken
                // transport that ignores destroy cannot create unbounded work.
            });
        }

        return Object.freeze({ async getToken(scopes, input = {}) {
            try {
                const { signal, timeout } = inputs(scopes, input);
                // At most one HTTP acquisition per five-second operation signal.
                // This is NOT a general token/refresh cache: an old signal cannot
                // refresh or replay its memo, even if the opaque token is valid.
                const started = now();
                if (!Number.isSafeInteger(started) || started < 0) fail();
                if (signal && attempted.has(signal)) {
                    const prior = attempted.get(signal);
                    if (started < prior.started || started - prior.started >= OPERATION_MS) fail();
                    return await prior.pending;
                }
                const pending = acquire(signal, timeout);
                if (signal) attempted.set(signal, { started, pending });
                return await pending;
            } catch (_) { throw error(); }
        } });
    } catch (_) { throw error(); }
}

module.exports = { createAppServiceCredential, SCOPE, RESOURCE, DEADLINE_MS, MAX_BYTES, MESSAGE };
