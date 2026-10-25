'use strict';

const crypto = require('node:crypto');
const { createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');
const { createBrowserAuthService, BrowserAuthError, clearAuthCookie } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { projectCurrentRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorLogoutService } = require('../api/shared/dashboardOperatorLogout');
const { createAuthLogoutFunction } = require('../api/authLogout');

const uid = n => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), CLIENT = uid(2), SUBJECT = uid(3), INSTANCE = uid(4), EPOCH = uid(5);
const NOW = Date.parse('2026-09-08T21:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const cookie = result => result.cookie.split(';')[0];
const parentId = result => cookie(result).split('=')[1];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// This driver controls I/O only. Genuine runtime/domain code produces and
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
        return { release: jest.fn(), async query(text, params = []) {
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

function harness() {
    const state = { now: NOW, sequence: 30, bytes: 1, epoch: EPOCH, deletes: [], captureRequests: [] };
    const clock = () => new Date(state.now).toISOString();
    const nextId = () => uid(++state.sequence);
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-test-only-secret', NOFRIES_ALLOWED_SUBJECTS: TENANT + ':' + SUBJECT };
    const store = new MemoryBrowserSessionStore();
    const originalLoad = store.loadSession.bind(store), originalDelete = store.deleteSession.bind(store);
    store.loadSession = jest.fn(async id => {
        if (state.beforeLoad) await state.beforeLoad(id);
        const record = await originalLoad(id);
        return state.afterLoad ? state.afterLoad(id, record) : record;
    });
    store.deleteSession = jest.fn(async id => {
        if (state.beforeDelete) await state.beforeDelete(id);
        state.deletes.push({ id, traceLength: state.trace.length });
        await originalDelete(id);
    });
    const proofs = new Map();
    const proofStore = {
        async createOriginalProof(key, value) { if (proofs.has(key)) throw new Error('Synthetic conditional collision'); proofs.set(key, clone(value)); },
        async readOriginalProof(key) { if (state.beforeProofRead) await state.beforeProofRead(key); return proofs.has(key) ? clone(proofs.get(key)) : null; }
    };
    const cryptoProvider = { generatePkceCodes: async () => ({ verifier: 'v'.repeat(43), challenge: 'c'.repeat(43) }) };
    let nonce;
    const clientApplication = {
        async getAuthCodeUrl(input) { nonce = input.nonce; return 'https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize?' +
            new URLSearchParams({ client_id: CLIENT, redirect_uri: input.redirectUri, response_type: 'code', response_mode: 'form_post',
                scope: input.scopes.join(' '), state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod }); },
        async acquireTokenByCode() { return { idTokenClaims: { tid: TENANT, oid: SUBJECT, aud: CLIENT,
            iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce, exp: state.now / 1000 + 600, iat: state.now / 1000,
            preferred_username: 'synthetic@example.invalid', name: 'Synthetic operator' }, account: { tenantId: TENANT, localAccountId: SUBJECT } }; },
        getTokenCache() { return { removeAccount: async () => {} }; }
    };
    const browserAuthOptions = { env, store, clientApplication, cryptoProvider, randomBytes: () => Buffer.alloc(32, state.bytes++) };
    const external = async () => ({ instanceId: INSTANCE, restoreEpoch: state.epoch });
    const operator = createDashboardOperatorSession({ browserAuthOptions,
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 1, issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
        proofStore, clock, readExternalRuntimeEpoch: external, newRequestId: nextId, requestBudgetMs: 60000 });
    const original = createBrowserAuthService({ ...browserAuthOptions, now: () => state.now });
    const captureRequest = async request => { state.captureRequests.push(request); return operator.captureRequest(request); };
    const runtimeOptions = { pool: controlledSql(state), clock, instanceId: INSTANCE,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        readExternalRuntimeEpoch: external, newId: nextId, readVerifiedOnboardingProof: async () => null,
        readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false,
        newGenerationToken: () => digest(nextId()) };
    const runtime = createPostgresDashboardRuntimeRepository({ ...runtimeOptions, captureRequest });
    async function login(proof = true) {
        const started = await original.beginLogin({ returnTo: '/operator' });
        const input = { cookieHeader: cookie(started), body: { state: new URL(started.location).searchParams.get('state'), code: 'synthetic-code' } };
        const result = await (proof ? operator.callbackService : original).completeLogin(input);
        return { result, input: { cookieHeader: cookie(result), returnTo: '/portal' }, request: Object.freeze({ headers: Object.freeze({ cookie: cookie(result) }) }) };
    }
    const newOperationId = jest.fn(nextId);
    const options = { browserAuthOptions, captureRequest, runtimeOptions, newOperationId };
    const service = () => createDashboardOperatorLogoutService(options);
    return { state, clock, env, store, proofs, operator, original, browserAuthOptions, runtimeOptions, runtime, captureRequest, nextId, login, newOperationId, options, service };
}

describe('ordinary operator logout composition', () => {
    test('I-RED valid original proof can revoke an absent gate through the genuine runtime final check', async () => {
        const h = harness(), issued = await h.login();
        const outcome = await settled(h.runtime.revokeSession(issued.request, { operationId: h.nextId() }));
        const sql = h.state.trace.map(row => row.sql);
        expect({ code: outcome.error?.code || null,
            wroteGate: sql.some(value => value.startsWith('INSERT INTO nofries.dashboard_session_gates')),
            wroteReceipt: sql.some(value => value.startsWith('INSERT INTO nofries.dashboard_runtime_receipts')),
            wroteAudit: sql.some(value => value.startsWith('INSERT INTO nofries.dashboard_runtime_audit')),
            committed: sql.includes('COMMIT'), rolledBack: sql.includes('ROLLBACK')
        }).toEqual({ code: null, wroteGate: true, wroteReceipt: true, wroteAudit: true, committed: true, rolledBack: false });
        expect(outcome.value.record).toMatchObject({ status: 'revoked', revision: 0, operatorIssuanceSha256: null });
    });

    test.each([[false, false], [false, true], [true, false], [true, true]])(
        'ordinary logout awaits committed revocation (gate=%s proof=%s)', async (present, proof) => {
            const h = harness(), issued = await h.login(present || proof);
            if (present) await h.runtime.initializeOperatorSession(issued.request, { operationId: h.nextId() });
            if (!proof) h.proofs.clear();
            h.state.trace.length = 0; h.state.captureRequests.length = 0;
            const service = h.service();
            expect(Object.keys(service)).toEqual(['logout']); expect(Object.isFrozen(service)).toBe(true);
            const result = await service.logout(issued.input);
            expect(result).toEqual({ location: '/portal', cookie: clearAuthCookie() });
            expect(h.state.tables.dashboard_session_gates[0]).toMatchObject({ status: 'revoked', revision: present ? 1 : 0 });
            expect(h.store.sessions.has(parentId(issued.result))).toBe(false);
            expect(h.newOperationId).toHaveBeenCalledTimes(1);
            expect(h.state.deletes).toHaveLength(1);
            expect(h.state.trace.slice(0, h.state.deletes[0].traceLength).map(row => row.sql)).toContain('COMMIT');
            expect(h.state.captureRequests.length).toBeGreaterThan(1);
            expect(new Set(h.state.captureRequests).size).toBe(1);
            expect(Object.isFrozen(h.state.captureRequests[0])).toBe(true);
            expect(Object.isFrozen(h.state.captureRequests[0].headers)).toBe(true);
        });

    test.each(['pending', 'failed'])('SQL %s cannot reach explicit browser logout', async kind => {
        const h = harness(), issued = await h.login(), entered = latch(), release = latch();
        h.state.beforeSql = async event => {
            if (event.sql.startsWith('INSERT INTO nofries.dashboard_session_gates')) {
                entered.resolve(); await release.promise;
                if (kind === 'failed') throw new Error('synthetic private SQL failure');
            }
        };
        const outcome = settled(h.service().logout(issued.input));
        await entered.promise;
        expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.store.sessions.has(parentId(issued.result))).toBe(true);
        release.resolve();
        const result = await outcome;
        if (kind === 'failed') {
            expect(result.error).toMatchObject({ statusCode: 503, code: 'browser_auth_dashboard_unavailable' });
            expect(result.error.message).not.toContain('private SQL');
            expect(h.store.deleteSession).not.toHaveBeenCalled();
            expect(h.state.tables.dashboard_session_gates).toEqual([]);
        } else expect(result.value).toEqual({ location: '/portal', cookie: clearAuthCookie() });
    });

    test('a postcommit parent deletion failure retains revocation and retry completes safely', async () => {
        const h = harness(), issued = await h.login(); let first = true;
        h.state.beforeDelete = async () => { if (first) { first = false; throw new BrowserAuthError(401, 'private-delete-detail'); } };
        const service = h.service();
        await expect(service.logout(issued.input)).rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_dashboard_unavailable' });
        const gate = clone(h.state.tables.dashboard_session_gates[0]);
        expect(gate.status).toBe('revoked'); expect(h.store.sessions.has(parentId(issued.result))).toBe(true);
        await expect(h.runtime.initializeOperatorSession(issued.request, { operationId: h.nextId() })).rejects.toMatchObject({ statusCode: 403 });
        await expect(service.logout(issued.input)).resolves.toEqual({ location: '/portal', cookie: clearAuthCookie() });
        expect(h.state.tables.dashboard_session_gates[0]).toEqual(gate);
        expect(h.store.sessions.has(parentId(issued.result))).toBe(false);
    });

    test.each(['after commit', 'before commit'])('lost COMMIT response %s uses genuine retained receipt recovery', async phase => {
        const h = harness(), issued = await h.login(); let failed = false;
        const hook = async event => { if (!failed && event.sql === 'COMMIT') { failed = true; throw new Error('synthetic lost response'); } };
        if (phase === 'after commit') h.state.afterSql = hook; else h.state.beforeSql = hook;
        const outcome = await settled(h.service().logout(issued.input));
        expect(failed).toBe(true); expect(h.newOperationId).toHaveBeenCalledTimes(1);
        expect(h.state.trace.filter(row => row.sql === 'BEGIN')).toHaveLength(2);
        if (phase === 'after commit') {
            expect(outcome.value).toEqual({ location: '/portal', cookie: clearAuthCookie() });
            expect(h.state.tables.dashboard_session_gates[0].status).toBe('revoked');
            expect(h.state.tables.dashboard_runtime_receipts).toHaveLength(1);
        } else {
            expect(outcome.error).toMatchObject({ statusCode: 503 });
            expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.state.tables.dashboard_session_gates).toEqual([]);
        }
        const second = h.state.trace.findIndex((row, i) => row.sql === 'BEGIN' && i > 0);
        expect(h.state.trace.slice(second).filter(row => /^(INSERT|UPDATE|DELETE) /.test(row.sql))).toEqual([]);
    });

    test.each(['empty', 'unknown', 'expired', 'malformed record', 'malformed email'])
    ('%s parent preserves cleanup without borrowing SQL or generating an operation', async variant => {
        const h = harness(), issued = await h.login(), id = parentId(issued.result);
        if (variant === 'empty') issued.input.cookieHeader = '';
        if (variant === 'unknown') h.store.sessions.delete(id);
        if (variant === 'expired') h.state.now += 4 * 60 * 60 * 1000;
        if (variant === 'malformed record') h.store.sessions.get(id).kind = 'not-a-session';
        if (variant === 'malformed email') h.store.sessions.get(id).identity.email = 'invalid';
        await expect(h.service().logout(issued.input)).resolves.toEqual({ location: '/portal', cookie: clearAuthCookie() });
        expect(h.runtimeOptions.pool.connect).not.toHaveBeenCalled(); expect(h.newOperationId).not.toHaveBeenCalled();
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
    });

    test.each(['malformed', 'duplicate'])('%s cookie preserves the genuine parser401 without SQL or deletion', async variant => {
        const h = harness(), issued = await h.login();
        const input = { ...issued.input, cookieHeader: variant === 'malformed' ? '__Host-nofries-auth=invalid' :
            issued.input.cookieHeader + '; ' + issued.input.cookieHeader };
        const legacy = await settled(h.original.logout(input));
        const composed = await settled(h.service().logout(input));
        expect(composed.error).toBeInstanceOf(BrowserAuthError);
        expect(composed.error).toMatchObject({ statusCode: legacy.error.statusCode, code: legacy.error.code });
        expect(composed.error).toMatchObject({ statusCode: 401, code: 'browser_auth_cookie_invalid' });
        expect(h.runtimeOptions.pool.connect).not.toHaveBeenCalled(); expect(h.store.deleteSession).not.toHaveBeenCalled();
    });

    test.each(['plain', '401', 'email400', 'undefined'])('parent provider failure %s cannot masquerade as cleanup eligibility', async kind => {
        const h = harness(), issued = await h.login();
        h.state.afterLoad = () => {
            if (kind === 'undefined') return undefined;
            if (kind === '401') throw new BrowserAuthError(401, 'browser_auth_session_invalid');
            if (kind === 'email400') throw new BrowserAuthError(400, 'browser_auth_email_invalid');
            throw new Error('synthetic private storage detail');
        };
        await expect(h.service().logout(issued.input)).rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_dashboard_unavailable' });
        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.runtimeOptions.pool.connect).not.toHaveBeenCalled();
        expect(h.newOperationId).not.toHaveBeenCalled();
    });

    test.each(['proof mismatch', 'proof unavailable', 'epoch drift', 'parent vanished', 'parent unavailable'])
    ('valid initial parent then %s never enters unfenced cleanup', async kind => {
        const h = harness(), issued = await h.login(); let reads = 0;
        if (kind === 'proof mismatch') for (const proof of h.proofs.values()) proof.identitySha256 = 'f'.repeat(64);
        if (kind === 'proof unavailable') h.state.beforeProofRead = async () => { throw new Error('synthetic private proof failure'); };
        h.state.afterLoad = (id, record) => {
            if (++reads === 1) {
                if (kind === 'epoch drift') h.state.epoch = uid(10);
                return record;
            }
            if (kind === 'parent vanished') return null;
            if (kind === 'parent unavailable') throw new Error('synthetic parent unavailable');
            return record;
        };
        await expect(h.service().logout(issued.input)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.state.tables.dashboard_session_gates).toEqual([]);
        expect(h.newOperationId).toHaveBeenCalledTimes(1);
    });

    test.each(['active wrong proof', 'revoked wrong proof', 'terminal nonlogout'])
    ('narrow tombstone correction retains %s denial', async kind => {
        const h = harness(), issued = await h.login();
        if (kind === 'terminal nonlogout') {
            await h.runtime.revokeSession(issued.request, { operationId: h.nextId() });
            await expect(h.runtime.initializeOperatorSession(issued.request, { operationId: h.nextId() })).rejects.toMatchObject({ statusCode: 403 });
            await expect(h.runtime.readSession(issued.request)).rejects.toMatchObject({ statusCode: 403 });
        } else {
            await h.runtime.initializeOperatorSession(issued.request, { operationId: h.nextId() });
            if (kind === 'revoked wrong proof') await h.runtime.revokeSession(issued.request, { operationId: h.nextId() });
            h.state.tables.dashboard_session_gates[0].operator_issuance_sha256 = 'f'.repeat(64);
            await expect(h.service().logout(issued.input)).rejects.toMatchObject({ statusCode: 503 });
            expect(h.store.deleteSession).not.toHaveBeenCalled();
        }
    });

    test.each(['identity', 'expiry', 'epoch'])('terminal tombstone still rejects changed %s binding', async variant => {
        const h = harness(), issued = await h.login();
        await h.runtime.revokeSession(issued.request, { operationId: h.nextId() });
        const gate = h.state.tables.dashboard_session_gates[0];
        if (variant === 'identity') {
            gate.identity_payload.oid = uid(99);
            const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
            gate.identity_sha256 = canonicalDigest(gate.identity_payload); gate.subject_key = TENANT + ':' + uid(99);
        }
        if (variant === 'expiry') gate.expires_at = new Date(NOW + 60000).toISOString();
        if (variant === 'epoch') gate.restore_epoch = uid(99);
        const before = clone(h.state.tables);
        await expect(h.service().logout(issued.input)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.state.tables).toEqual(before);
    });

    test('invalid return path retains genuine400 after authority revocation and parent cleanup', async () => {
        const h = harness(), issued = await h.login();
        await expect(h.service().logout({ ...issued.input, returnTo: '//foreign.invalid' })).rejects.toMatchObject({
            statusCode: 400, code: 'browser_auth_return_path_invalid' });
        expect(h.state.tables.dashboard_session_gates[0].status).toBe('revoked');
        expect(h.store.sessions.has(parentId(issued.result))).toBe(false);
    });

    test('input mutation during a parent read cannot swap the private cookie or redirect', async () => {
        const h = harness(), first = await h.login(), second = await h.login(), entered = latch(), release = latch(); let waited = false;
        h.state.beforeLoad = async () => { if (!waited) { waited = true; entered.resolve(); await release.promise; } };
        const result = h.service().logout(first.input);
        await entered.promise; first.input.cookieHeader = second.input.cookieHeader; first.input.returnTo = '/support'; release.resolve();
        await expect(result).resolves.toEqual({ location: '/portal', cookie: clearAuthCookie() });
        expect(h.store.sessions.has(parentId(first.result))).toBe(false);
        expect(h.store.sessions.has(parentId(second.result))).toBe(true);
        expect(new Set(h.state.captureRequests.map(value => value.headers.cookie))).toEqual(new Set([cookie(first.result)]));
    });

    test('concurrent callers retain different immutable requests and one operation ID each', async () => {
        const h = harness(), first = await h.login(), second = await h.login(), entered = latch(), release = latch(); let waited = false;
        h.state.beforeLoad = async id => { if (!waited && id === parentId(first.result)) { waited = true; entered.resolve(); await release.promise; } };
        const service = h.service(), pending = service.logout(first.input);
        await entered.promise; await service.logout(second.input); release.resolve(); await pending;
        expect(new Set(h.state.captureRequests).size).toBe(2);
        expect(new Set(h.state.captureRequests.map(value => value.headers.cookie)).size).toBe(2);
        expect(h.newOperationId).toHaveBeenCalledTimes(2);
        expect(h.state.tables.dashboard_session_gates).toHaveLength(2);
        expect(h.state.tables.dashboard_session_gates.every(value => value.status === 'revoked')).toBe(true);
    });

    test.each(['invalid', 'regression'])('trusted clock %s cannot delete an initially valid parent', async variant => {
        const h = harness(), issued = await h.login();
        h.state.afterLoad = (_, record) => { h.state.now = variant === 'invalid' ? NaN : NOW - 1; return record; };
        await expect(h.service().logout(issued.input)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.runtimeOptions.pool.connect).not.toHaveBeenCalled();
    });

    test.each(['capture override', 'auth now override', 'bad operation', 'disabled auth'])('closed %s refuses without parent deletion', async kind => {
        const h = harness(), issued = await h.login();
        if (kind === 'capture override') h.options.runtimeOptions = { ...h.runtimeOptions, captureRequest: async () => null };
        if (kind === 'auth now override') h.options.browserAuthOptions = { ...h.browserAuthOptions, now: () => NOW };
        if (kind === 'disabled auth') h.env.NOFRIES_REQUIRE_AUTH = 'false';
        if (kind === 'bad operation') h.options.newOperationId = () => 'not-a-uuid';
        await expect(Promise.resolve().then(() => h.service().logout(issued.input))).rejects.toMatchObject({ statusCode: 503 });
        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.runtimeOptions.pool.connect).not.toHaveBeenCalled();
    });

    test('unchanged route rejects method, origin and rate limit before invoking private logout', async () => {
        const h = harness(), issued = await h.login();
        h.env.NOFRIES_RATE_API_WRITE_MAX = '1';
        const route = createAuthLogoutFunction({ env: h.env, service: h.service() });
        const request = { method: 'POST', headers: { origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin',
            cookie: issued.input.cookieHeader, 'x-forwarded-for': '192.0.2.251' }, body: { returnTo: '/portal' } };
        const method = {}; await route(method, { ...request, method: 'GET' }); expect(method.res.status).toBe(405);
        const origin = {}; await route(origin, { ...request, headers: { ...request.headers, origin: 'https://foreign.invalid' } }); expect(origin.res.status).toBe(403);
        expect(h.newOperationId).not.toHaveBeenCalled(); expect(h.store.deleteSession).not.toHaveBeenCalled();
        const success = {}; await route(success, request); expect(success.res.status).toBe(303);
        expect(success.res.headers).toMatchObject({ Location: '/portal', 'Set-Cookie': clearAuthCookie(), 'Cache-Control': expect.stringContaining('no-store') });
        const denied = {}; await route(denied, request); expect(denied.res.status).toBe(429);
        expect(h.newOperationId).toHaveBeenCalledTimes(1); expect(h.store.deleteSession).toHaveBeenCalledTimes(1);
    });

    test('unchanged route returns generic503 without a cookie or raw failure details', async () => {
        const h = harness(), issued = await h.login();
        h.state.beforeProofRead = () => { throw new Error('synthetic secret provider detail'); };
        const route = createAuthLogoutFunction({ env: h.env, service: h.service() }), context = { log: { warn: jest.fn() } };
        await route(context, { method: 'POST', headers: { origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin',
            cookie: issued.input.cookieHeader, 'x-forwarded-for': '192.0.2.252' }, body: {} });
        expect(context.res.status).toBe(503); expect(context.res.headers['Set-Cookie']).toBeUndefined();
        expect(context.res.body).toMatchObject({ code: 'browser_auth_unavailable' });
        expect(JSON.stringify(context.res) + JSON.stringify(context.log.warn.mock.calls)).not.toMatch(/synthetic secret|__Host-nofries-auth|private proof/);
        expect(h.store.deleteSession).not.toHaveBeenCalled();
    });
});
