'use strict';

const crypto = require('node:crypto');
const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { execFileSync } = require('node:child_process');
const { createDashboardRuntimeHandlers } = require('../api/shared/dashboardRuntimeHandlers');
const { BrowserAuthError, clearAuthCookie } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { projectCurrentRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { DashboardOnboardingError } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');

const uid = n => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), CLIENT = uid(2), SUBJECT = uid(3), INSTANCE = uid(4), EPOCH = uid(5);
const NOW = Date.parse('2026-09-08T22:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const cookie = result => result.cookie.split(';')[0];
const parentId = result => cookie(result).split('=')[1];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const turn = () => new Promise(resolve => setImmediate(resolve));
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// This driver controls I/O only for the genuine host/runtime composition. Genuine runtime/domain code produces and
// validates every session, receipt and audit. It does not model PostgreSQL RLS
// or lock concurrency; the separate restricted PostgreSQL suite proves those.
function controlledSql(state) {
    const primary = { dashboard_runtime_instance: 'instance_id', dashboard_session_gates: 'session_sha256',
        dashboard_runtime_receipts: 'receipt_id', dashboard_runtime_audit: 'event_id' };
    state.tables = Object.fromEntries(Object.keys(primary).map(name => [name, []]));
    state.tables.dashboard_runtime_instance.push(projectCurrentRow('instance', {
        schemaVersion: 1, instanceId: INSTANCE, revision: 1, restoreEpoch: EPOCH, ingressStatus: 'enabled',
        changedAt: new Date(NOW).toISOString(), evidenceRef: 'synthetic-test-only', evidenceSha256: digest('synthetic')
    }, { receiptId: uid(6) }));
    state.trace = [];
    const jsonColumns = new Set(['payload', 'identity_payload', 'scope_json']);
    const decode = (key, value) => jsonColumns.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
    return { end: jest.fn(), connect: jest.fn(async () => {
        let tables = null;
        const release = jest.fn(() => { state.releases.push(state.trace.length); });
        state.clients.push({ release });
        return { release, async query(text, params = []) {
            const sql = typeof text === 'string' ? text : text.text;
            const event = { sql, params: clone(params) }; state.trace.push(event);
            if (state.beforeSql) await state.beforeSql(event);
            let rows = [];
            if (sql === 'BEGIN') tables = clone(state.tables);
            else if (sql === 'COMMIT') { state.tables = tables; tables = null; }
            else if (sql === 'ROLLBACK') tables = null;
            else if (/^SELECT octet_length/.test(sql)) rows = [{ payload_bytes: Buffer.byteLength(params[0]) }];
            else if (/^(SET LOCAL |SELECT (set_config\(|pg_advisory_))/.test(sql)) { /* fixed control statements */ }
            else {
                let match = sql.match(/^INSERT INTO nofries\.(\w+) \(([^)]+)\) VALUES /);
                if (match) {
                    const [, table, names] = match;
                    if (!primary[table] || !tables) throw new Error('Unexpected controlled INSERT');
                    const row = Object.fromEntries(names.split(', ').map((key, i) => [key, decode(key, params[i])]));
                    if (tables[table].some(value => value[primary[table]] === row[primary[table]])) throw new Error('Synthetic duplicate key');
                    tables[table].push(row); rows = [clone(row)];
                } else if ((match = sql.match(/^UPDATE nofries\.(\w+) SET (.+) WHERE (\w+) = \$(\d+) RETURNING /))) {
                    const [, table, assignments, key, position] = match;
                    const row = tables[table].find(value => value[key] === params[Number(position) - 1]);
                    if (row) { for (const assignment of assignments.split(', ')) {
                        const [, column, index] = assignment.match(/^(\w+) = \$(\d+)$/);
                        row[column] = decode(column, params[Number(index) - 1]);
                    } rows = [clone(row)]; }
                } else if ((match = sql.match(/^SELECT .+ FROM nofries\.(\w+) WHERE /))) {
                    const table = match[1]; if (!primary[table] || !tables) throw new Error('Unexpected controlled SELECT');
                    rows = tables[table].filter(row => [...sql.matchAll(/\b(\w+) = \$(\d+)\b/g)]
                        .every(([, column, position]) => row[column] === params[Number(position) - 1]));
                    if (sql.includes('ORDER BY (CASE WHEN')) {
                        rows = rows.filter(row => { const receipt = row.payload, record = receipt.result.record;
                            const before = receipt.originalFacts.domainReceipt.originalFacts.predecessor;
                            return record.revision > (before ? before.revision : -1) && record.revision <= params[1] &&
                                (record.revision > params[2] || record.revision === params[2] && row.receipt_id > params[3]);
                        }).sort((a, b) => a.payload.result.record.revision - b.payload.result.record.revision || a.receipt_id.localeCompare(b.receipt_id)).slice(0, params[4]);
                    }
                    rows = clone(rows);
                } else throw new Error('Unexpected controlled SQL');
            }
            const result = { rows, rowCount: rows.length };
            if (state.afterSql) await state.afterSql(event, result);
            return result;
        } };
    }) };
}

// All provider/store doubles below are synthetic I/O adapters. Authentication,
// original proof issuance, capture, logout and SQL operations use real factories.
function harness({ budget = 1000, identity = SUBJECT } = {}) {
    const state = { now: NOW, bytes: 1, sequence: 40, epoch: EPOCH, clients: [], releases: [], deletes: [] };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-test-only-secret', NOFRIES_ALLOWED_SUBJECTS: TENANT + ':' + identity };
    const store = new MemoryBrowserSessionStore();
    const load = store.loadSession.bind(store), remove = store.deleteSession.bind(store);
    store.loadSession = jest.fn(async id => {
        if (state.beforeLoad) await state.beforeLoad(id);
        const value = await load(id);
        return state.afterLoad ? state.afterLoad(id, value) : value;
    });
    store.deleteSession = jest.fn(async id => {
        if (state.beforeDelete) await state.beforeDelete(id);
        state.deletes.push({ id, traceLength: state.trace.length });
        await remove(id);
    });
    const proofs = new Map();
    const proofStore = {
        createOriginalProof: jest.fn(async (id, proof) => {
            if (state.beforeProofCreate) await state.beforeProofCreate(id, proof);
            if (proofs.has(id)) throw new Error('Synthetic conditional proof collision');
            proofs.set(id, clone(proof));
            if (state.afterProofCreate) await state.afterProofCreate(id, proof);
        }),
        readOriginalProof: jest.fn(async id => {
            if (state.beforeProofRead) await state.beforeProofRead(id);
            return proofs.has(id) ? clone(proofs.get(id)) : null;
        })
    };
    const clientApplication = {
        getAuthCodeUrl: jest.fn(async input => {
            if (state.beforeAuthUrl) await state.beforeAuthUrl(input);
            return 'https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize?' +
                new URLSearchParams({ client_id: CLIENT, redirect_uri: input.redirectUri, response_type: 'code',
                    response_mode: 'form_post', scope: input.scopes.join(' '), state: input.state, nonce: input.nonce,
                    code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod });
        }),
        acquireTokenByCode: jest.fn(async input => {
            if (state.beforeToken) await state.beforeToken(input);
            return { idTokenClaims: { tid: TENANT, oid: identity, aud: CLIENT,
                iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce: input.nonce,
                exp: state.now / 1000 + 600, iat: state.now / 1000,
                preferred_username: 'synthetic@example.invalid', name: 'Synthetic operator' },
            account: { tenantId: TENANT, localAccountId: identity } };
        }),
        getTokenCache() { return { removeAccount }; }
    };
    const removeAccount = jest.fn(async account => {
        if (state.beforeRemoveAccount) await state.beforeRemoveAccount(account);
    });
    const clock = jest.fn(() => {
        if (state.onClock) state.onClock();
        return new Date(state.now).toISOString();
    });
    const external = jest.fn(async () => {
        if (state.beforeEpoch) await state.beforeEpoch();
        return { instanceId: INSTANCE, restoreEpoch: state.epoch };
    });
    const nextId = () => uid(++state.sequence);
    const options = {
        browserAuthOptions: { env, store, clientApplication,
            cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(43), challenge: 'c'.repeat(43) }) },
            randomBytes: () => Buffer.alloc(32, state.bytes++) },
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 1,
            issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
        proofStore, clock, readExternalRuntimeEpoch: external, newRequestId: jest.fn(nextId), requestBudgetMs: budget,
        pool: controlledSql(state), instanceId: INSTANCE,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: jest.fn(nextId), newGenerationToken: jest.fn(() => digest(nextId())), newOperationId: jest.fn(nextId)
    };
    let handler;
    function build() { handler = createDashboardRuntimeHandlers(options); return handler; }
    async function begin() {
        const started = await handler.authServices.login.beginLogin({ returnTo: '/portal' });
        return { body: { state: new URL(started.location).searchParams.get('state'), code: 'synthetic-code' },
            cookieHeader: cookie(started) };
    }
    async function login() {
        const input = await begin();
        const result = await handler.authServices.callback.completeLogin(input);
        return { input, result, cookie: cookie(result) };
    }
    return { state, env, store, proofs, proofStore, clock, external, options, build, begin, login, nextId, clientApplication, removeAccount };
}

// A real IncomingMessage owns the readable stream. Actual socket framing,
// duplicate header and byte-limit behavior is tested by the installed server.
function request({ method = 'GET', url = '/api/dashboard/session', cookieHeader = '',
    body, headers = {}, rawHeaders, unfinished = false } = {}) {
    const req = new IncomingMessage(new Socket());
    req.method = method; req.url = url; req.originalUrl = url;
    req.headers = { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...headers };
    if (method === 'POST') Object.assign(req.headers, { 'content-type': 'application/json',
        origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin', ...headers });
    req.rawHeaders = rawHeaders || Object.entries(req.headers).flatMap(([key, value]) => [key, value]);
    if (body !== undefined) req.push(Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    if (!unfinished) { req.complete = true; req.push(null); }
    return req;
}
function expectError(result, status, code) {
    expect(result).toMatchObject({ status, body: { code }, isRaw: false });
    expect(Object.keys(result.body)).toEqual(['code']);
    expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    expect(result.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(result.headers.Location).toBeUndefined();
}
function expectNoAuthorityIo(h) {
    expect(h.store.loadSession).not.toHaveBeenCalled();
    expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
    expect(h.external).not.toHaveBeenCalled();
    expect(h.options.newRequestId).not.toHaveBeenCalled();
    expect(h.options.pool.connect).not.toHaveBeenCalled();
}

describe('trusted dashboard host construction', () => {
    test.each([[false, ','], [true, ','], [true, ';'], [true, '\n']])('real operator activation reader requires the separate exact admin allowlist (%s, %p)', async (allowed, delimiter) => {
        const h = harness(); h.env.NOFRIES_ADMIN_SUBJECTS = TENANT + ':' + uid(98) + delimiter + TENANT + ':' + (allowed ? SUBJECT : uid(98));
        const read = jest.fn(async () => { throw new Error('Synthetic unavailable approved envelope'); });
        h.options.activation = { read, writeCompletion: jest.fn() };
        const handler = h.build(), issued = await h.login();
        expect((await handler.handleRequest(request({ method: 'POST', cookieHeader: issued.cookie,
            body: { operationId: h.nextId() } }))).status).toBe(200);
        const session = await handler.handleRequest(request({ cookieHeader: issued.cookie }));
        expect(session.body.activationAvailable).toBe(allowed ? true : undefined);
        const body = { action: 'customer_activation', activationId: uid(97), phase: 'prepare' };
        const response = await handler.handleRequest(request({ method: 'POST', cookieHeader: issued.cookie, body }));
        expect(response.status).toBe(allowed ? 503 : 403);
        expect(read).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(h.options.activation.writeCompletion).not.toHaveBeenCalled();
    });

    test('J-ENV native Node process.env is detached before configured handler use', () => {
        const h = harness();
        // A fresh Node process retains the real process.env prototype; Jest's
        // environment wrapper is not this native boundary. Supply only this
        // explicit synthetic map, never a copy of the parent process environment.
        const script = `
            const { IncomingMessage } = require('node:http');
            const { Socket } = require('node:net');
            const { MemoryBrowserSessionStore } = require('./api/shared/browserSessionStore');
            const { createDashboardRuntimeHandlers } = require('./api/shared/dashboardRuntimeHandlers');
            const uid = n => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
            const tenant = process.env.NOFRIES_ENTRA_TENANT_ID, client = process.env.NOFRIES_ENTRA_CLIENT_ID;
            const originalOrigin = process.env.NOFRIES_PUBLIC_URL;
            const nativePrototype = Object.getPrototypeOf(process.env) !== Object.prototype;
            let clockCalls = 0, sqlCalls = 0;
            const handlers = createDashboardRuntimeHandlers({
                browserAuthOptions: { env: process.env, store: new MemoryBrowserSessionStore() },
                identityPolicy: { policyId: 'synthetic-native-env-policy', policyRevision: 0,
                    issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', identityTenantId: tenant, audience: client },
                proofStore: { async createOriginalProof() {}, async readOriginalProof() { return null; } },
                clock: () => { clockCalls++; return '2026-09-08T22:00:00.000Z'; },
                readExternalRuntimeEpoch: async () => ({ instanceId: uid(4), restoreEpoch: uid(5) }),
                newRequestId: () => uid(6), requestBudgetMs: 1000,
                pool: { async connect() { sqlCalls++; throw new Error('Unexpected synthetic SQL'); }, async end() {} },
                instanceId: uid(4), historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                newId: () => uid(7), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => uid(8)
            });
            const constructorClockCalls = clockCalls;
            process.env.NOFRIES_PUBLIC_URL = 'https://mutated.invalid';
            process.env.NOFRIES_REQUIRE_AUTH = 'false';
            const request = new IncomingMessage(new Socket());
            request.method = 'POST'; request.url = '/api/dashboard/logout';
            request.rawHeaders = ['Content-Type', 'application/json', 'Origin', originalOrigin, 'Sec-Fetch-Site', 'same-origin'];
            request.push(Buffer.from('{}')); request.complete = true; request.push(null);
            handlers.handleRequest(request).then(result => {
                process.stdout.write(JSON.stringify({ nativePrototype, constructorClockCalls, sqlCalls,
                    status: result.status, code: result.body.code }));
            }).catch(() => { process.exitCode = 1; });
        `;
        const output = execFileSync(process.execPath, ['-e', script], {
            cwd: require('node:path').resolve(__dirname, '..'), env: { ...h.env }, encoding: 'utf8'
        });
        expect(JSON.parse(output)).toEqual({ nativePrototype: true, constructorClockCalls: 0, sqlCalls: 0,
            status: 401, code: 'dashboard_authentication_required' });
    });

    test('exposes only the frozen HTTP controller and four minimal genuine auth services without I/O', () => {
        const h = harness(), handler = h.build();
        expect(Object.keys(require('../api/shared/dashboardRuntimeHandlers'))).toEqual(['createDashboardRuntimeHandlers']);
        expect(Object.keys(handler).sort()).toEqual(['authServices', 'handleRequest']);
        expect(Object.keys(handler.authServices).sort()).toEqual(['callback', 'login', 'logout', 'session']);
        for (const [key, method] of Object.entries({ login: 'beginLogin', callback: 'completeLogin', logout: 'logout', session: 'readSessionDetails' })) {
            expect(Object.keys(handler.authServices[key])).toEqual([method]);
            expect(Object.isFrozen(handler.authServices[key])).toBe(true);
        }
        expect(Object.isFrozen(handler)).toBe(true); expect(Object.isFrozen(handler.authServices)).toBe(true);
        expect(h.clock).not.toHaveBeenCalled(); expectNoAuthorityIo(h);
        expect(h.clientApplication.getAuthCodeUrl).not.toHaveBeenCalled();
    });

    test.each(['extra', 'missing', 'symbol', 'accessor', 'proxy', 'auth disabled', 'clock proxy',
        'env accessor', 'env proxy', 'policy accessor', 'proof accessor', 'proof proxy', 'store accessor', 'pool accessor'])
    ('rejects %s construction before dependency invocation', kind => {
        const h = harness(), invoked = jest.fn(() => { throw new Error('Accessor executed'); });
        let value = h.options;
        if (kind === 'extra') value = { ...value, captureRequest: jest.fn() };
        if (kind === 'missing') { value = { ...value }; delete value.newOperationId; }
        if (kind === 'symbol') value = { ...value, [Symbol('hidden')]: true };
        if (kind === 'accessor') Object.defineProperty(value, 'clock', { get: invoked });
        if (kind === 'proxy') value = new Proxy(value, { get: invoked, ownKeys: invoked });
        if (kind === 'auth disabled') h.env.NOFRIES_REQUIRE_AUTH = 'false';
        if (kind === 'clock proxy') value.clock = new Proxy(h.clock, { apply: invoked });
        if (kind === 'env accessor') Object.defineProperty(h.env, 'NOFRIES_ENTRA_CLIENT_SECRET', { get: invoked });
        if (kind === 'env proxy') value.browserAuthOptions.env = new Proxy(h.env, { get: invoked, ownKeys: invoked });
        if (kind === 'policy accessor') Object.defineProperty(value.identityPolicy, 'audience', { get: invoked });
        if (kind === 'proof accessor') Object.defineProperty(value.proofStore, 'readOriginalProof', { get: invoked });
        if (kind === 'proof proxy') value.proofStore = new Proxy(value.proofStore, { get: invoked, ownKeys: invoked });
        if (kind === 'store accessor') Object.defineProperty(h.store, 'loadSession', { get: invoked });
        if (kind === 'pool accessor') Object.defineProperty(value.pool, 'connect', { get: invoked });
        expect(() => createDashboardRuntimeHandlers(value)).toThrow();
        expect(invoked).not.toHaveBeenCalled();
        expect(h.clock).not.toHaveBeenCalled();
        expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
        expect(h.clientApplication.getAuthCodeUrl).not.toHaveBeenCalled();
    });

    test('later configuration mutation cannot swap the retained authority or dependency methods', async () => {
        const h = harness(), handler = h.build(), replacement = jest.fn(() => { throw new Error('Replacement must remain unused'); });
        const connect = h.options.pool.connect;
        h.env.NOFRIES_REQUIRE_AUTH = 'false'; h.env.NOFRIES_ENTRA_TENANT_ID = uid(99);
        h.options.identityPolicy.audience = uid(99);
        h.options.clock = replacement; h.options.readExternalRuntimeEpoch = replacement;
        h.options.pool.connect = replacement;
        h.proofStore.createOriginalProof = replacement; h.proofStore.readOriginalProof = replacement;
        const issued = await h.login();
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 409, 'dashboard_initialization_required');
        expect(replacement).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalled();
        expect(h.proofs.size).toBe(1);
    });

    test.each(['symbol', 'hidden accessor', 'oversized', 'inherited required configuration'])
    ('J-ENV rejects %s environment without reading inherited authority or invoking accessors', kind => {
        const h = harness(), invoked = jest.fn(() => { throw new Error('Environment accessor executed'); });
        let env = { ...h.env };
        if (kind === 'symbol') env[Symbol('hidden')] = true;
        if (kind === 'hidden accessor') Object.defineProperty(env, 'hidden', { get: invoked });
        if (kind === 'oversized') env.SYNTHETIC_EXTRA = 'x'.repeat(32768);
        if (kind === 'inherited required configuration') {
            env = Object.assign(Object.create({ NOFRIES_ENTRA_CLIENT_SECRET: h.env.NOFRIES_ENTRA_CLIENT_SECRET }), env);
            delete env.NOFRIES_ENTRA_CLIENT_SECRET;
        }
        h.options.browserAuthOptions.env = env;
        expect(() => h.build()).toThrow();
        expect(invoked).not.toHaveBeenCalled(); expect(h.clock).not.toHaveBeenCalled(); expectNoAuthorityIo(h);
    });

    test('J-ENV copies only own enumerable data and never traverses inherited environment accessors', () => {
        const h = harness(), invoked = jest.fn(() => { throw new Error('Inherited accessor executed'); });
        const prototype = {};
        Object.defineProperty(prototype, 'NOFRIES_REQUIRE_AUTH', { get: invoked });
        const ownEnv = { ...h.env }; delete ownEnv.NOFRIES_REQUIRE_AUTH;
        const env = Object.assign(Object.create(prototype), ownEnv);
        Object.defineProperty(env, 'SYNTHETIC_IGNORED', { value: 'x'.repeat(32768) });
        h.options.browserAuthOptions.env = env;
        expect(Object.keys(h.build()).sort()).toEqual(['authServices', 'handleRequest']);
        expect(invoked).not.toHaveBeenCalled(); expect(h.clock).not.toHaveBeenCalled(); expectNoAuthorityIo(h);
    });
});

describe('dashboard authentication and safe host projections', () => {
    test.each(['absent', 'unknown', 'expired', 'malformed retained identity'])
    ('a genuine %s parent is 401 before a malformed generation can become authority', async kind => {
        const h = harness(), handler = h.build();
        let issued = null;
        if (kind !== 'absent') issued = await h.login();
        if (kind === 'unknown') h.store.sessions.clear();
        if (kind === 'expired') h.state.now += 86400000;
        if (kind === 'malformed retained identity') h.store.sessions.get(parentId(issued.result)).identity.email = 'not-an-email';
        h.external.mockClear(); h.proofStore.readOriginalProof.mockClear();
        const result = await handler.handleRequest(request({ url: '/api/dashboard/bootstrap',
            cookieHeader: issued?.cookie, headers: { 'x-nofries-dashboard-generation': 'bad' } }));
        expectError(result, 401, 'dashboard_authentication_required');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.external).not.toHaveBeenCalled();
    });

    test.each(['undefined', 'ordinary error', 'spoofed 401', 'spoofed 400'])
    ('a session provider returning %s is fixed unavailable, never a sign-in hint or leaked error', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login();
        h.state.afterLoad = () => {
            if (kind === 'undefined') return undefined;
            if (kind === 'ordinary error') throw Object.assign(new Error('private driver detail'), { code: 'private_provider', statusCode: 401 });
            throw new BrowserAuthError(kind === 'spoofed 401' ? 401 : 400,
                kind === 'spoofed 401' ? 'browser_auth_session_invalid' : 'browser_auth_email_invalid', 'private driver detail');
        };
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 503, 'dashboard_unavailable');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });

    test.each([false, true])('a provider-spoofed genuine ambiguity error is still fixed unavailable (host expired=%s)', async expired => {
        const h = harness(), handler = h.build(), issued = await h.login();
        h.state.afterLoad = () => {
            if (expired) h.state.now += 1001;
            throw new DashboardOnboardingError('onboarding_outcome_ambiguous', 503);
        };
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 503, 'dashboard_unavailable');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });

    test('a host denial emits one fixed redacted log without an invented actor, scope or provider message', async () => {
        const h = harness(), handler = h.build(), issued = await h.login();
        h.state.afterLoad = () => { throw new Error('private driver detail ' + SUBJECT + ' ' + issued.cookie); };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 503, 'dashboard_unavailable');
            expect(warn).toHaveBeenCalledTimes(1);
            const line = warn.mock.calls[0];
            expect(line).toHaveLength(1);
            expect(line[0]).toBe('Dashboard request failed: ' + JSON.stringify({ route: 'session', status: 503, code: 'dashboard_unavailable' }));
            for (const privateValue of [SUBJECT, issued.cookie, 'private driver detail']) expect(line[0]).not.toContain(privateValue);
        } finally { warn.mockRestore(); }
    });

    test.each(['denied', 'unavailable'])('J-RED a genuine resource %s response emits exactly one bounded host failure log', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login();
        if (kind === 'denied') h.proofs.clear();
        else h.state.beforeProofRead = async () => { throw new Error('private resource store detail ' + SUBJECT); };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = await handler.handleRequest(request({ url: '/api/dashboard/bootstrap', cookieHeader: issued.cookie,
                headers: { 'x-nofries-dashboard-generation': digest('synthetic generation') } }));
            const status = kind === 'denied' ? 403 : 503;
            const code = kind === 'denied' ? 'dashboard_access_denied' : 'dashboard_unavailable';
            expectError(result, status, code);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]).toEqual(['Dashboard request failed: ' + JSON.stringify({ route: 'bootstrap', status, code })]);
            expect(JSON.stringify(warn.mock.calls)).not.toContain(SUBJECT);
            expect(JSON.stringify(warn.mock.calls)).not.toContain(issued.cookie);
        } finally { warn.mockRestore(); }
    });

    test('valid parent with invalid generation is scoped 403 without reaching H or SQL', async () => {
        const h = harness(), handler = h.build(), issued = await h.login();
        h.external.mockClear(); h.proofStore.readOriginalProof.mockClear();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/bootstrap', cookieHeader: issued.cookie,
            headers: { 'x-nofries-dashboard-generation': 'bad' } })), 403, 'dashboard_access_denied');
        expect(h.external).not.toHaveBeenCalled(); expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });

    test.each(['missing proof', 'wrong proof', 'restored epoch'])('%s on a valid parent is denied, not initialization-required', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login();
        if (kind === 'missing proof') h.proofs.clear();
        if (kind === 'wrong proof') [...h.proofs.values()][0].identitySha256 = digest('another identity');
        if (kind === 'restored epoch') h.state.epoch = uid(99);
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 403, 'dashboard_access_denied');
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
    });

    test('genuine absent gate is initialization-required; initialization projects no private state or proof', async () => {
        const h = harness(), handler = h.build(), issued = await h.login();
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 409, 'dashboard_initialization_required');
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
        const initialized = await handler.handleRequest(request({ method: 'POST', cookieHeader: issued.cookie,
            body: { operationId: h.nextId() } }));
        expect(initialized).toMatchObject({ status: 200, body: { schemaVersion: 1, initialized: true }, isRaw: false });
        expect(Object.keys(initialized.body).sort()).toEqual(['initialized', 'schemaVersion']);
        const ready = await handler.handleRequest(request({ cookieHeader: issued.cookie }));
        expect(ready.status).toBe(200);
        expect(Object.keys(ready.body).sort()).toEqual(['authenticated', 'expiresAt', 'generation', 'purpose', 'schemaVersion', 'selectedBindingId']);
        expect(ready.body).toMatchObject({ schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', selectedBindingId: null });
        const output = JSON.stringify([initialized, ready]);
        for (const secret of [parentId(issued.result), issued.cookie, 'synthetic@example.invalid', SUBJECT,
            [...h.proofs.keys()][0], [...h.proofs.values()][0].identitySha256]) expect(output).not.toContain(secret);
    });
});

describe('one immutable host invocation and continuation deadline', () => {
    test('same original request coalesces; changed transport cannot replace the original cookie, route or body', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        const operationId = h.nextId(), req = request({ method: 'POST', cookieHeader: issued.cookie, body: { operationId } });
        const first = handler.handleRequest(req), same = handler.handleRequest(req);
        await entered.promise;
        req.headers.cookie = '__Host-nofries_session=changed'; req.url = '/api/dashboard/logout'; req.originalUrl = req.url;
        req.body = { operationId: h.nextId(), bindingId: uid(88) };
        const changed = await handler.handleRequest(req);
        expect([400, 403, 503]).toContain(changed.status);
        release.resolve();
        const result = await first;
        expect(await same).toEqual(result); expect(result.status).toBe(200);
        expect(h.state.tables.dashboard_runtime_receipts).toHaveLength(1);
        expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.options.newRequestId).toHaveBeenCalledTimes(1);
        const calls = h.store.loadSession.mock.calls.length;
        expect([400, 403, 503]).toContain((await handler.handleRequest(req)).status);
        expect(h.store.loadSession).toHaveBeenCalledTimes(calls);
    });

    test('a changed raw generation cannot replace the captured invalid generation while authentication waits', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.external.mockClear(); h.proofStore.readOriginalProof.mockClear();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        const req = request({ url: '/api/dashboard/bootstrap', cookieHeader: issued.cookie,
            headers: { 'x-nofries-dashboard-generation': 'bad' } });
        const first = handler.handleRequest(req);
        await entered.promise;
        req.headers['x-nofries-dashboard-generation'] = digest('attempted replacement');
        req.rawHeaders[req.rawHeaders.indexOf('x-nofries-dashboard-generation') + 1] = digest('attempted replacement');
        expectError(await handler.handleRequest(req), 403, 'dashboard_access_denied');
        release.resolve(); expectError(await first, 403, 'dashboard_access_denied');
        expect(h.external).not.toHaveBeenCalled(); expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });

    test('clock reentry encounters an installed slot and cannot create a second deadline or provider attempt', async () => {
        const h = harness(), handler = h.build(), req = request();
        let nested;
        h.state.onClock = () => { h.state.onClock = null; nested = handler.handleRequest(req); };
        const result = await handler.handleRequest(req);
        expectError(result, 401, 'dashboard_authentication_required');
        expect([400, 403, 503]).toContain((await nested).status);
        expectNoAuthorityIo(h);
    });

    test.each(['valid', 'invalid'])('expired original budget after a pending %s pre-context parent is 503 before H/SQL', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.external.mockClear(); h.proofStore.readOriginalProof.mockClear();
        if (kind === 'invalid') h.store.sessions.clear();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        let done = false;
        const req = request({ cookieHeader: issued.cookie });
        const outcome = handler.handleRequest(req).then(value => { done = true; return value; });
        await entered.promise; h.state.now += 1001; await turn();
        expect(done).toBe(false); expect(h.options.pool.connect).not.toHaveBeenCalled();
        release.resolve(); expectError(await outcome, 503, 'dashboard_unavailable');
        expect(h.external).not.toHaveBeenCalled(); expect(h.options.newRequestId).not.toHaveBeenCalled();
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        const calls = h.store.loadSession.mock.calls.length;
        expectError(await handler.handleRequest(req), 503, 'dashboard_unavailable');
        expect(h.store.loadSession).toHaveBeenCalledTimes(calls);
    });

    test.each(['proof', 'epoch'])('a later H %s await cannot reset the earlier host budget', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.state[kind === 'proof' ? 'beforeProofRead' : 'beforeEpoch'] = async () => { entered.resolve(); await release.promise; };
        let done = false;
        const outcome = handler.handleRequest(request({ cookieHeader: issued.cookie })).then(value => { done = true; return value; });
        await entered.promise; h.state.now += 1001; await turn(); expect(done).toBe(false);
        release.resolve(); expectError(await outcome, 503, 'dashboard_unavailable');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });

    test('a genuine pending SQL statement owns settlement and release after host expiry', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.state.beforeSql = async event => {
            if (event.sql.startsWith('SELECT') && event.sql.includes('FROM nofries.dashboard_runtime_instance')) {
                entered.resolve(); await release.promise;
            }
        };
        let done = false;
        const outcome = handler.handleRequest(request({ cookieHeader: issued.cookie })).then(value => { done = true; return value; });
        await entered.promise; h.state.now += 1001; await turn();
        expect(done).toBe(false); expect(h.state.clients).toHaveLength(1);
        expect(h.state.clients[0].release).not.toHaveBeenCalled();
        release.resolve(); expectError(await outcome, 503, 'dashboard_unavailable');
        expect(h.state.clients[0].release).toHaveBeenCalledTimes(1);
        expect(h.state.trace.map(event => event.sql)).toContain('ROLLBACK');
        expect(h.state.trace.map(event => event.sql)).not.toContain('COMMIT');
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
    });

    test('the finite timer latches expiry with a stationary supplied clock and still awaits SQL settlement', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        const h = harness(), handler = h.build(), entered = latch(), release = latch();
        let outcome;
        try {
            const issued = await h.login();
            h.state.beforeSql = async event => {
                if (event.sql.startsWith('SELECT') && event.sql.includes('FROM nofries.dashboard_runtime_instance')) {
                    entered.resolve(); await release.promise;
                }
            };
            let done = false;
            outcome = handler.handleRequest(request({ cookieHeader: issued.cookie })).then(value => { done = true; return value; });
            await entered.promise; jest.advanceTimersByTime(1001); await turn();
            expect(h.state.now).toBe(NOW); expect(done).toBe(false);
            expect(h.state.clients[0].release).not.toHaveBeenCalled();
            release.resolve(); expectError(await outcome, 503, 'dashboard_unavailable');
            expect(h.state.clients[0].release).toHaveBeenCalledTimes(1);
            expect(h.state.trace.map(event => event.sql)).toContain('ROLLBACK');
            expect(jest.getTimerCount()).toBe(0);
        } finally { release.resolve(); if (outcome) await outcome; jest.useRealTimers(); }
    });

    test.each([false, true])('J-RED genuine unresolved COMMIT recovery retains ambiguous outcome (host expired=%s)', async expired => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        let committedAttempts = 0;
        h.state.afterSql = async event => {
            if (event.sql === 'COMMIT' && h.state.tables.dashboard_runtime_receipts.length) {
                committedAttempts++;
                if (committedAttempts === 2) { entered.resolve(); await release.promise; }
                throw new Error('Synthetic lost COMMIT acknowledgement');
            }
        };
        let done = false;
        const outcome = handler.handleRequest(request({ method: 'POST', cookieHeader: issued.cookie, body: { operationId: h.nextId() } }))
            .then(value => { done = true; return value; });
        try {
            await entered.promise;
            if (expired) h.state.now += 1001;
            await turn(); expect(done).toBe(false);
            expect(h.state.clients[h.state.clients.length - 1].release).not.toHaveBeenCalled();
            release.resolve(); const result = await outcome;
            expect(result.headers['Set-Cookie']).toBeUndefined();
            expect(h.store.deleteSession).not.toHaveBeenCalled();
            expect(committedAttempts).toBe(2);
            expect(h.state.tables.dashboard_session_gates).toHaveLength(1);
            expect(h.state.tables.dashboard_runtime_receipts).toHaveLength(1);
            expect(h.state.tables.dashboard_runtime_audit).toHaveLength(1);
            for (const client of h.state.clients) expect(client.release).toHaveBeenCalledTimes(1);
            expectError(result, 503, 'dashboard_outcome_ambiguous');
        } finally { release.resolve(); await outcome; }
    });

    test('a regressed clock fails one entry without poisoning the next actual request', async () => {
        const h = harness(), handler = h.build(), issued = await h.login();
        h.state.beforeLoad = async () => { h.state.now = NOW - 1; };
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 503, 'dashboard_unavailable');
        h.state.beforeLoad = null; h.state.now = NOW;
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 409, 'dashboard_initialization_required');
    });

    test('interleaved requests retain independent budgets while a later valid request may proceed', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        let hold = true;
        h.state.beforeLoad = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } };
        const first = handler.handleRequest(request({ cookieHeader: issued.cookie }));
        await entered.promise; h.state.now += 1001;
        expectError(await handler.handleRequest(request({ cookieHeader: issued.cookie })), 409, 'dashboard_initialization_required');
        release.resolve(); expectError(await first, 503, 'dashboard_unavailable');
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
    });
});

describe('genuine auth service ledgers and fenced logout', () => {
    test('J-RED successful token acquisition after expiry still settles genuine token-cache cleanup before failing', async () => {
        const h = harness(), handler = h.build(), input = await h.begin();
        const tokenEntered = latch(), releaseToken = latch(), cleanupEntered = latch(), releaseCleanup = latch();
        h.state.beforeToken = async () => { tokenEntered.resolve(); await releaseToken.promise; };
        h.state.beforeRemoveAccount = async () => { cleanupEntered.resolve(); await releaseCleanup.promise; };
        let done = false;
        const outcome = settled(handler.authServices.callback.completeLogin(input)).then(value => { done = true; return value; });
        try {
            await tokenEntered.promise; h.state.now += 1001; releaseToken.resolve(); await turn();
            expect(h.removeAccount).toHaveBeenCalledTimes(1);
            await cleanupEntered.promise;
            expect(done).toBe(false);
            expect(h.store.sessions.size).toBe(0); expect(h.proofs.size).toBe(0);
            releaseCleanup.resolve();
            const result = await outcome;
            expect(result.error).toMatchObject({ statusCode: 503, clearTransactionCookie: true });
            expect(h.removeAccount).toHaveBeenCalledWith({ tenantId: TENANT, localAccountId: SUBJECT });
            expect(h.store.transactions.size).toBe(0);
            expect(h.store.sessions.size).toBe(0); expect(h.proofs.size).toBe(0);
        } finally { releaseToken.resolve(); releaseCleanup.resolve(); await outcome; }
    });

    test('callback issues one original proof; final expiry preserves consumed transaction cleanup flag', async () => {
        const h = harness(), handler = h.build(), input = await h.begin();
        h.state.afterProofCreate = async () => { h.state.now += 1001; };
        const outcome = await settled(handler.authServices.callback.completeLogin(input));
        expect(outcome.error).toMatchObject({ statusCode: 503, clearTransactionCookie: true });
        expect(h.store.transactions.size).toBe(0); expect(h.proofs.size).toBe(1);
        expect(h.store.sessions.size).toBe(1); expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
    });

    test.each(['ordinary', 'dashboard'])('%s logout cannot renew its ledger during I initial parent load', async mode => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        let loads = 0;
        h.state.beforeLoad = async () => {
            if (++loads === (mode === 'ordinary' ? 1 : 2)) { entered.resolve(); await release.promise; }
        };
        let done = false;
        const outcome = settled(mode === 'ordinary' ? handler.authServices.logout.logout({ cookieHeader: issued.cookie, returnTo: '/portal' }) :
            handler.handleRequest(request({ method: 'POST', url: '/api/dashboard/logout', cookieHeader: issued.cookie, body: {} })))
            .then(value => { done = true; return value; });
        await entered.promise; h.state.now += 1001; await turn(); expect(done).toBe(false);
        release.resolve(); const result = await outcome;
        if (mode === 'ordinary') expect(result.error).toMatchObject({ statusCode: 503 });
        else expectError(result.value, 503, 'dashboard_unavailable');
        expect(h.options.pool.connect).not.toHaveBeenCalled(); expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.options.newOperationId).not.toHaveBeenCalled();
    });

    test('late parent deletion settles after committed revoke; no success cookie escapes expired dashboard logout', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.state.beforeDelete = async () => { entered.resolve(); await release.promise; };
        let done = false;
        const outcome = handler.handleRequest(request({ method: 'POST', url: '/api/dashboard/logout', cookieHeader: issued.cookie, body: {} }))
            .then(value => { done = true; return value; });
        await entered.promise;
        expect(h.state.trace.map(event => event.sql)).toContain('COMMIT');
        expect(h.state.tables.dashboard_session_gates[0]).toMatchObject({ status: 'revoked', revision: 0 });
        h.state.now += 1001; await turn(); expect(done).toBe(false);
        release.resolve(); const result = await outcome;
        expectError(result, 503, 'dashboard_unavailable'); expect(result.headers['Set-Cookie']).toBeUndefined();
        expect(h.store.sessions.has(parentId(issued.result))).toBe(false);
        expect(h.state.tables.dashboard_session_gates[0].status).toBe('revoked');
        expect(h.state.trace.map(event => event.sql)).not.toContain('ROLLBACK');
    });

    test('successful dashboard logout returns only fixed result and genuine clearing cookie after committed revocation', async () => {
        const h = harness(), handler = h.build(), issued = await h.login();
        const result = await handler.handleRequest(request({ method: 'POST', url: '/api/dashboard/logout', cookieHeader: issued.cookie, body: {} }));
        expect(result).toMatchObject({ status: 200, body: { schemaVersion: 1, loggedOut: true },
            headers: { 'Set-Cookie': clearAuthCookie() }, isRaw: false });
        expect(Object.keys(result.body).sort()).toEqual(['loggedOut', 'schemaVersion']);
        expect(result.headers.Location).toBeUndefined();
        expect(h.state.trace.slice(0, h.state.deletes[0].traceLength).map(event => event.sql)).toContain('COMMIT');
        expect(h.store.sessions.has(parentId(issued.result))).toBe(false);
    });

    test('separately configured compositions retain their own policies, auth services and failures', async () => {
        const a = harness(), b = harness({ identity: uid(10) }), one = a.build(), two = b.build();
        const issuedA = await a.login(), issuedB = await b.login();
        expect((await one.authServices.session.readSessionDetails(issuedA.cookie)).identity.principalId).toBe(SUBJECT);
        expect((await two.authServices.session.readSessionDetails(issuedB.cookie)).identity.principalId).toBe(uid(10));
        a.state.afterLoad = () => { throw new Error('private app A outage'); };
        expectError(await one.handleRequest(request({ cookieHeader: issuedA.cookie })), 503, 'dashboard_unavailable');
        expectError(await two.handleRequest(request({ cookieHeader: issuedB.cookie })), 409, 'dashboard_initialization_required');
        expect(a.options.pool.connect).not.toHaveBeenCalled();
        expect(b.options.pool.connect).toHaveBeenCalled();
    });
});

describe('fixed evidence metadata HTTP request boundary', () => {
    test.each(['', '?', '?artefactId=', '?artefactId=a&artefactId=b', '?artefactId=a&tenantId=other',
        '?tenantId=other', '?artefactId=%', '?artefactId=%FF', '?artefactId=shared:artefact',
        '?artefactId=shared%3aartefact', '?artefactId=%61', '?artefactId=a+b'])
    ('rejects noncanonical selector %s before authentication or SQL', async query => {
        const h = harness(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/evidence' + query })), 400, 'dashboard_input_invalid');
        expectNoAuthorityIo(h);
    });
    test.each(['POST', 'PUT', 'DELETE', 'HEAD'])('rejects evidence %s before authority providers', async method => {
        const h = harness(), handler = h.build();
        const result = await handler.handleRequest(request({ method, url: '/api/dashboard/evidence?artefactId=shared%3Aartefact' }));
        expectError(result, 405, 'dashboard_method_not_allowed'); expect(result.headers.Allow).toBe('GET');
        expectNoAuthorityIo(h);
    });
    test('canonical evidence selector still requires genuine browser authentication', async () => {
        const h = harness(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/evidence?artefactId=shared%3Aartefact' })),
            401, 'dashboard_authentication_required');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['missing', 'invalid', 'duplicate'])('authenticated evidence %s generation cannot reach SQL', async kind => {
        const h = harness(), handler = h.build(), issued = await h.login();
        const header = 'x-nofries-dashboard-generation';
        const headers = kind === 'missing' ? {} : { [header]: kind === 'invalid' ? 'bad' : digest('synthetic generation') };
        const rawHeaders = ['cookie', issued.cookie, ...Object.entries(headers).flat()];
        if (kind === 'duplicate') rawHeaders.push(header, digest('synthetic generation'));
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/evidence?artefactId=shared%3Aartefact',
            cookieHeader: issued.cookie, headers, rawHeaders })), 403, 'dashboard_access_denied');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });
    test('GET evidence body is rejected before authentication', async () => {
        const h = harness(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/evidence?artefactId=shared%3Aartefact', body: 'payload' })),
            400, 'dashboard_input_invalid'); expectNoAuthorityIo(h);
    });
    test('original evidence query cannot be replaced while browser authentication awaits', async () => {
        const h = harness(), handler = h.build(), issued = await h.login(), entered = latch(), release = latch();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        const req = request({ url: '/api/dashboard/evidence?artefactId=original', cookieHeader: issued.cookie,
            headers: { 'x-nofries-dashboard-generation': 'bad' } });
        const first = handler.handleRequest(req); await entered.promise;
        req.originalUrl = '/api/dashboard/evidence?artefactId=replacement'; req.url = req.originalUrl;
        expectError(await handler.handleRequest(req), 403, 'dashboard_access_denied');
        release.resolve(); expectError(await first, 403, 'dashboard_access_denied');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });
});

describe('opt-in NCSC HTTP request boundary', () => {
    function configured() {
        const h = harness(); h.options.ncsc = { resolveSubmissionQuota: jest.fn(() => null) };
        return h;
    }
    test('absent NCSC configuration preserves unavailable routes', async () => {
        const h = harness(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments' })), 404, 'dashboard_not_found');
        expectNoAuthorityIo(h);
    });
    test.each([null, {}, { resolveSubmissionQuota: null }, { resolveSubmissionQuota() {}, extra: true }])('rejects malformed trusted NCSC configuration %p', ncsc => {
        const h = harness(); h.options.ncsc = ncsc;
        expect(() => h.build()).toThrow(BrowserAuthError);
    });
    test('does not invoke an NCSC configuration getter', () => {
        const h = harness(), getter = jest.fn();
        Object.defineProperty(h.options, 'ncsc', { get: getter, enumerable: true });
        expect(() => h.build()).toThrow(BrowserAuthError); expect(getter).not.toHaveBeenCalled();
    });
    test.each(['', '/example', '/example%3Aone', '/example%3Aone/save', '/example/save', '/example/submit'])('configured route %s reaches authentication instead of 404', async suffix => {
        const h = configured(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments' + suffix,
            method: suffix.includes('/save') || suffix.includes('/submit') ? 'POST' : 'GET',
            ...(suffix.includes('/save') || suffix.includes('/submit') ? { body: {} } : {}) })),
        401, 'dashboard_authentication_required');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['/', '/a/delete', '/a/b/save', '/%61', '/a?limit=1'])('rejects noncanonical item route %s before providers', async suffix => {
        const h = configured(), handler = h.build();
        const result = await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments' + suffix }));
        expect([400, 404]).toContain(result.status); expectNoAuthorityIo(h);
    });
    test.each(['?limit=01', '?limit=0', '?limit=101', '?limit=1&limit=2', '?unknown=1', '?afterAssessmentId=%61', '?afterAssessmentId=a/b', '?'])('rejects invalid collection query %s', async query => {
        const h = configured(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments' + query })), 400, 'dashboard_input_invalid');
        expectNoAuthorityIo(h);
    });
    test.each(['?limit=100', '?afterAssessmentId=assessment%3A1', '?limit=1&afterAssessmentId=assessment-1'])('canonical collection query %s reaches authentication', async query => {
        const h = configured(), handler = h.build();
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments' + query })), 401, 'dashboard_authentication_required');
    });
    test.each(['missing', 'invalid', 'duplicate'])('requires unique generation: %s', async kind => {
        const h = configured(), handler = h.build(), issued = await h.login();
        const key = 'x-nofries-dashboard-generation', headers = kind === 'missing' ? {} : { [key]: kind === 'invalid' ? 'bad' : digest('generation') };
        const rawHeaders = ['cookie', issued.cookie, ...Object.entries(headers).flat()];
        if (kind === 'duplicate') rawHeaders.push(key, digest('generation'));
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments', cookieHeader: issued.cookie, headers, rawHeaders })),
            403, 'dashboard_access_denied');
        expect(h.options.pool.connect).not.toHaveBeenCalled();
    });
    test('foreign-origin mutation is denied before authentication and quota lookup', async () => {
        const h = configured(), handler = h.build();
        expectError(await handler.handleRequest(request({ method: 'POST', url: '/api/dashboard/ncsc/assessments/a/save',
            headers: { origin: 'https://foreign.invalid' }, body: {} })), 403, 'dashboard_access_denied');
        expectNoAuthorityIo(h); expect(h.options.ncsc.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
    test.each(['malformed', 'media', 'oversized', 'get-body'])('retains raw wire guard for %s', async kind => {
        const h = configured(), handler = h.build();
        const result = await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments', method: kind === 'get-body' ? 'GET' : 'POST',
            headers: kind === 'media' ? { 'content-type': 'text/plain' } : {},
            body: kind === 'oversized' ? 'x'.repeat(524289) : kind === 'malformed' ? '{' : '{}' }));
        expect(result.status).toBe(kind === 'oversized' ? 413 : kind === 'media' ? 415 : 400);
        expectNoAuthorityIo(h);
    });
    test('authentication completion after deadline cannot reach binding or quota', async () => {
        const h = configured(), handler = h.build(), issued = await h.login();
        h.state.afterLoad = (_id, value) => { h.state.now += 1000; return value; };
        expectError(await handler.handleRequest(request({ url: '/api/dashboard/ncsc/assessments', cookieHeader: issued.cookie,
            headers: { 'x-nofries-dashboard-generation': digest('generation') } })), 503, 'dashboard_unavailable');
        expect(h.options.pool.connect).not.toHaveBeenCalled(); expect(h.options.ncsc.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
});
