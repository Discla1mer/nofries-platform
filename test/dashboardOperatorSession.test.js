'use strict';

const crypto = require('node:crypto');
const { createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');
const { createBrowserAuthService, BrowserAuthError } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const domain = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createDashboardRequestDatabase } = require('../api/shared/database/dashboardRequestDatabase');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');

const TENANT = '10000000-0000-4000-8000-000000000001';
const CLIENT = '10000000-0000-4000-8000-000000000002';
const SUBJECT = '10000000-0000-4000-8000-000000000003';
const SECOND = '10000000-0000-4000-8000-000000000004';
const INSTANCE = '10000000-0000-4000-8000-000000000005';
const EPOCH = '10000000-0000-4000-8000-000000000006';
const NEXT_EPOCH = '10000000-0000-4000-8000-000000000007';
const OPERATION = '10000000-0000-4000-8000-000000000008';
const NOW = Date.parse('2026-09-08T21:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const cookie = result => result.cookie.split(';')[0];
const parentId = result => cookie(result).split('=')[1];
const digest = id => crypto.createHash('sha256')
    .update(Buffer.from('nofries:operator-dashboard-session:v1\0', 'utf8'))
    .update(Buffer.from(id, 'base64url')).digest('hex');

function harness(change = {}) {
    const state = { now: NOW, epoch: EPOCH, bytes: 1, requests: 0, claims: {}, ...change.state };
    const env = {
        NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-test-only-secret',
        NOFRIES_ALLOWED_SUBJECTS: TENANT + ':' + SUBJECT + ',' + TENANT + ':' + SECOND,
        ...change.env
    };
    const store = new MemoryBrowserSessionStore();
    const create = store.createSession.bind(store), load = store.loadSession.bind(store);
    store.createSession = jest.fn(async (id, record) => {
        if (state.beforeCreate) await state.beforeCreate(id, record);
        await create(id, record);
        if (state.afterCreate) await state.afterCreate(id, record);
    });
    store.loadSession = jest.fn(async id => {
        if (state.beforeLoad) await state.beforeLoad(id);
        const result = await load(id);
        return state.afterLoad ? state.afterLoad(id, result) : result;
    });
    store.deleteSession = jest.fn(store.deleteSession.bind(store));
    const proofs = new Map();
    const proofStore = {
        createOriginalProof: jest.fn(async (key, record) => {
            if (state.beforeProofCreate) await state.beforeProofCreate(key, record);
            if (proofs.has(key)) throw new Error('conditional collision');
            proofs.set(key, clone(record));
            if (state.afterProofCreate) return state.afterProofCreate(key, record);
            return undefined;
        }),
        readOriginalProof: jest.fn(async key => {
            if (state.beforeProofRead) await state.beforeProofRead(key);
            if (state.readProof) return state.readProof(key, proofs);
            return proofs.has(key) ? clone(proofs.get(key)) : null;
        })
    };
    const clientApplication = {
        getAuthCodeUrl: jest.fn(async params => {
            const url = new URL('https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize');
            for (const [key, value] of Object.entries({ client_id: CLIENT, redirect_uri: params.redirectUri,
                response_mode: 'form_post', state: params.state, nonce: params.nonce,
                code_challenge: params.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
            return url.href;
        }),
        acquireTokenByCode: jest.fn(async params => ({
            idTokenClaims: { aud: CLIENT, tid: TENANT, oid: params.code === 'second' ? SECOND : SUBJECT,
                iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce: params.nonce,
                exp: Math.floor(state.now / 1000) + 3600, name: 'Synthetic operator',
                preferred_username: 'synthetic@example.invalid', ...state.claims },
            account: { localAccountId: SUBJECT, tenantId: TENANT },
            accessToken: 'synthetic-unpersisted-token', idToken: 'synthetic-unpersisted-id-token'
        })),
        getTokenCache: () => ({ removeAccount: jest.fn(async () => {}) })
    };
    const cryptoProvider = { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) };
    const randomBytes = size => state.forcedBytes || Buffer.alloc(size, state.bytes++);
    const browserAuthOptions = { env, store, clientApplication, cryptoProvider, randomBytes };
    const clock = jest.fn(() => new Date(state.now).toISOString());
    const readExternalRuntimeEpoch = jest.fn(async () => {
        if (state.beforeEpoch) await state.beforeEpoch();
        return { instanceId: INSTANCE, restoreEpoch: state.epoch };
    });
    const options = { browserAuthOptions,
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 0,
            issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
        proofStore, clock, readExternalRuntimeEpoch,
        newRequestId: jest.fn(() => '20000000-0000-4000-8000-' + (++state.requests).toString().padStart(12, '0')),
        requestBudgetMs: 1000, ...change.options };
    const original = createBrowserAuthService({ ...browserAuthOptions, now: () => state.now });
    const adapter = change.skipAdapter ? null : createDashboardOperatorSession(options);
    async function begin() {
        const started = await original.beginLogin({ returnTo: '/portal' });
        const args = { body: { code: 'first', state: new URL(started.location).searchParams.get('state') },
            cookieHeader: cookie(started) };
        return args;
    }
    async function login(code = 'first', wrapped = true) {
        const input = await begin(); input.body.code = code;
        const result = await (wrapped ? adapter.callbackService : original).completeLogin(input);
        return { result, input, request: { headers: { cookie: cookie(result) } } };
    }
    return { state, env, store, proofs, proofStore, options, original, adapter, begin, login,
        clock, readExternalRuntimeEpoch, clientApplication };
}

describe('original operator issuance and private runtime capture', () => {
    test('genuine OIDC callback preserves the original result and produces exact private proof/capture', async () => {
        const h = harness(), legacy = harness();
        const issued = await h.login(), control = await legacy.login('first', false);
        expect(issued.result).toEqual(control.result);
        expect(Object.keys(issued.result).sort()).toEqual(['cookie', 'expiresAt', 'identity', 'location']);
        expect(Object.keys(h.adapter)).toEqual(['callbackService', 'captureRequest']);
        expect(Object.keys(h.adapter.callbackService)).toEqual(['completeLogin']);
        expect(Object.isFrozen(h.adapter.callbackService)).toBe(true);
        const capture = await h.adapter.captureRequest(issued.request);
        const identityPayload = domain.normaliseStableIdentity({ ...h.options.identityPolicy, oid: SUBJECT });
        const expected = { schemaVersion: 1, kind: 'operator_dashboard_issuance',
            sessionSha256: digest(parentId(issued.result)), identitySha256: domain.canonicalDigest(identityPayload),
            instanceId: INSTANCE, restoreEpoch: EPOCH,
            issuedAt: new Date(NOW).toISOString(), expiresAt: issued.result.expiresAt };
        expect(h.proofs.get(expected.sessionSha256)).toEqual(expected);
        expect(capture).toEqual({ requestId: '20000000-0000-4000-8000-000000000001',
            deadline: new Date(NOW + 1000).toISOString(), sessionSha256: expected.sessionSha256,
            kind: 'operator_dashboard', identityPayload, instanceId: INSTANCE, restoreEpoch: EPOCH,
            issuedAt: expected.issuedAt, expiresAt: expected.expiresAt,
            operatorIssuanceProof: expected, discovery: null });
        expect(Object.isFrozen(capture)).toBe(true);
        expect(Object.isFrozen(capture.operatorIssuanceProof)).toBe(true);
        for (const sensitive of [parentId(issued.result), cookie(issued.result), 'synthetic@example.invalid',
            'Synthetic operator', 'synthetic-unpersisted-token']) {
            expect(JSON.stringify(capture)).not.toContain(sensitive);
            expect(JSON.stringify(expected)).not.toContain(sensitive);
        }
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['nonce', { nonce: 'invalid' }], ['tenant', { tid: SECOND }],
        ['subject', { oid: EPOCH }], ['audience', { aud: EPOCH }], ['issuer', { iss: 'https://attacker.invalid' }]
    ])('genuine %s rejection cannot reach proof issuance', async (_, claims) => {
        const h = harness({ state: { claims } });
        await expect(h.login()).rejects.toBeInstanceOf(BrowserAuthError);
        expect(h.store.createSession).not.toHaveBeenCalled();
        expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
    });

    test('state rejection and replay preserve one-use callback and one original proof', async () => {
        const h = harness(), input = await h.begin();
        const wrong = clone(input); wrong.body.state = 'x'.repeat(43);
        await expect(h.adapter.callbackService.completeLogin(wrong)).rejects.toBeInstanceOf(BrowserAuthError);
        expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
        await h.adapter.callbackService.completeLogin(input);
        await expect(h.adapter.callbackService.completeLogin(input)).rejects.toBeInstanceOf(BrowserAuthError);
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
    });

    test.each(['parent failure', 'proof failure', 'lost acknowledgement', 'wrong acknowledgement', 'collision'])
    ('%s withholds callback success and never rolls back by deletion', async kind => {
        const h = harness();
        if (kind === 'parent failure') h.state.beforeCreate = async () => { throw new Error('sensitive storage detail'); };
        if (kind === 'proof failure') h.state.beforeProofCreate = async () => { throw new Error('sensitive storage detail'); };
        if (kind === 'lost acknowledgement') h.state.afterProofCreate = async () => { throw new Error('sensitive storage detail'); };
        if (kind === 'wrong acknowledgement') h.state.afterProofCreate = async () => true;
        if (kind === 'collision') h.state.beforeProofCreate = async key => h.proofs.set(key, { retained: true });
        const error = await h.login().catch(value => value);
        expect(error).toBeInstanceOf(BrowserAuthError);
        expect(error.statusCode).toBe(503);
        expect(error.message).not.toContain('sensitive storage detail');
        expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.store.sessions.size).toBe(kind === 'parent failure' ? 0 : 1);
        if (kind === 'collision') expect([...h.proofs.values()]).toEqual([{ retained: true }]);
    });

    test.each(['parent write', 'proof write', 'final callback check'])
    ('epoch change at %s cannot re-stamp the original session', async boundary => {
        const h = harness();
        if (boundary === 'parent write') h.state.afterCreate = async () => { h.state.epoch = NEXT_EPOCH; };
        if (boundary === 'proof write') h.state.afterProofCreate = async () => { h.state.epoch = NEXT_EPOCH; };
        if (boundary === 'final callback check') {
            let afterProofChecks = 0;
            h.state.afterProofCreate = async () => {
                h.state.beforeEpoch = async () => { if (++afterProofChecks === 2) h.state.epoch = NEXT_EPOCH; };
            };
        }
        await expect(h.login()).rejects.toMatchObject({ statusCode: 503, clearTransactionCookie: true });
        expect(h.store.sessions.size).toBe(1);
        expect(h.store.deleteSession).not.toHaveBeenCalled();
        for (const value of h.proofs.values()) expect(value.restoreEpoch).toBe(EPOCH);
        if (boundary === 'parent write') expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
    });

    test('an old genuinely verified parent remains proofless on every read', async () => {
        const h = harness(), { request } = await h.login('first', false);
        const first = await h.adapter.captureRequest(request);
        const second = await h.adapter.captureRequest(request);
        expect(first.operatorIssuanceProof).toBeNull();
        expect(second).toEqual(first);
        expect(h.store.loadSession).toHaveBeenCalledTimes(2);
        expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
    });

    test.each([
        ['wrong identity', proof => { proof.identitySha256 = 'f'.repeat(64); }],
        ['wrong parent', proof => { proof.sessionSha256 = 'f'.repeat(64); }],
        ['wrong instance', proof => { proof.instanceId = NEXT_EPOCH; }],
        ['wrong epoch', proof => { proof.restoreEpoch = NEXT_EPOCH; }],
        ['wrong expiry', proof => { proof.expiresAt = new Date(NOW + 5000).toISOString(); }],
        ['wrong issuance', proof => { proof.issuedAt = new Date(NOW - 1).toISOString(); }],
        ['wrong purpose', proof => { proof.kind = 'customer'; }],
        ['missing field', proof => { delete proof.schemaVersion; }],
        ['extra field', proof => { proof.extra = true; }]
    ])('%s proof denies instead of becoming a proofless operator', async (_, change) => {
        const h = harness(), { result, request } = await h.login();
        change(h.proofs.get(digest(parentId(result))));
        await expect(h.adapter.captureRequest(request)).resolves.toBeNull();
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
    });

    test.each(['deleted', 'wrong subject', 'wrong purpose', 'malformed email', 'shortened expiry', 'expired', 'allowlist revoked'])
    ('current parent %s cannot retain dashboard authority', async kind => {
        const h = harness(), { result, request } = await h.login();
        const id = parentId(result), record = h.store.sessions.get(id);
        if (kind === 'deleted') h.store.sessions.delete(id);
        if (kind === 'wrong subject') record.identity.subjectKey = TENANT + ':' + SECOND;
        if (kind === 'wrong purpose') record.kind = 'customer';
        if (kind === 'malformed email') record.identity.email = 'invalid';
        if (kind === 'shortened expiry') record.idleExpiresAt = NOW + 500;
        if (kind === 'expired') h.state.now += 4 * 60 * 60 * 1000;
        if (kind === 'allowlist revoked') h.env.NOFRIES_ALLOWED_SUBJECTS = TENANT + ':' + SECOND;
        await expect(h.adapter.captureRequest(request)).resolves.toBeNull();
    });

    test.each(['undefined proof', 'failed proof', 'failed parent', 'undefined parent', 'failed epoch', 'invalid epoch'])
    ('%s is generic unavailable, not absence or proofless authority', async kind => {
        const h = harness(), { request } = await h.login();
        if (kind === 'undefined proof') h.state.readProof = () => undefined;
        if (kind === 'failed proof') h.state.beforeProofRead = async () => { throw new BrowserAuthError(401, 'private'); };
        if (kind === 'failed parent') h.state.beforeLoad = async () => { throw new BrowserAuthError(401, 'private'); };
        if (kind === 'undefined parent') h.state.afterLoad = () => undefined;
        if (kind === 'failed epoch') h.state.beforeEpoch = async () => { throw new Error('private'); };
        if (kind === 'invalid epoch') h.state.epoch = 'malformed';
        await expect(h.adapter.captureRequest(request)).rejects.toMatchObject({
            statusCode: 503, code: 'browser_auth_dashboard_unavailable' });
    });

    test.each(['parent read', 'proof read'])('epoch replacement during %s denies', async boundary => {
        const h = harness(), { request } = await h.login();
        if (boundary === 'parent read') h.state.beforeLoad = async () => { h.state.epoch = NEXT_EPOCH; };
        else h.state.beforeProofRead = async () => { h.state.epoch = NEXT_EPOCH; };
        await expect(h.adapter.captureRequest(request)).resolves.toBeNull();
    });

    test('original request cookie and budget are captured before awaits and preserved on re-verification', async () => {
        const h = harness(), first = await h.login(), second = await h.login('second');
        const pending = h.adapter.captureRequest(first.request);
        first.request.headers.cookie = cookie(second.result);
        const capture = await pending;
        expect(capture.identityPayload.oid).toBe(SUBJECT);
        h.state.now += 500;
        const refreshed = await h.adapter.captureRequest(first.request);
        expect(refreshed).toEqual(capture);
        expect(h.options.newRequestId).toHaveBeenCalledTimes(1);
        expect(h.store.loadSession).toHaveBeenCalledTimes(2);
        h.state.now += 500;
        await expect(h.adapter.captureRequest(first.request)).rejects.toMatchObject({ statusCode: 503 });
    });

    test('concurrent genuine operators retain separate parent/proof captures across reordered loads', async () => {
        const h = harness(), first = await h.login(), second = await h.login('second');
        let releaseFirst;
        const waiting = new Promise(resolve => { releaseFirst = resolve; });
        let reached;
        const reachedFirst = new Promise(resolve => { reached = resolve; });
        h.state.beforeLoad = async id => { if (id === parentId(first.result)) { reached(); await waiting; } };
        const a = h.adapter.captureRequest(first.request);
        await reachedFirst;
        const b = await h.adapter.captureRequest(second.request);
        releaseFirst();
        const resultA = await a;
        expect(resultA.identityPayload.oid).toBe(SUBJECT);
        expect(b.identityPayload.oid).toBe(SECOND);
        expect(resultA.sessionSha256).not.toBe(b.sessionSha256);
        expect(resultA.requestId).not.toBe(b.requestId);
    });

    test('clock regression or deadline during an awaited proof read cannot disclose a capture', async () => {
        for (const displacement of [-1, 1000]) {
            const h = harness(), { request } = await h.login();
            h.state.beforeProofRead = async () => { h.state.now += displacement; };
            await expect(h.adapter.captureRequest(request)).rejects.toMatchObject({ statusCode: 503 });
        }
    });

    test('missing and duplicate opaque cookies are handled by the genuine reader', async () => {
        const h = harness(), { result } = await h.login();
        await expect(h.adapter.captureRequest({ headers: {} })).resolves.toBeNull();
        await expect(h.adapter.captureRequest({ headers: { cookie: cookie(result) + '; ' + cookie(result) } })).resolves.toBeNull();
        expect(h.store.loadSession).not.toHaveBeenCalled();
    });

    test('existing runtime rejects proofless resource/initialization and reserves it for revocation', async () => {
        const h = harness(), { request } = await h.login('first', false);
        const pool = { connect: jest.fn(async () => { throw new Error('synthetic database unavailable'); }),
            end: jest.fn(async () => {}) };
        const common = { pool, clock: h.clock, instanceId: INSTANCE,
            historyBudget: { maxRecords: 100, maxBytes: 1000000, maxDurationMs: 1000 },
            captureRequest: h.adapter.captureRequest, readExternalRuntimeEpoch: h.readExternalRuntimeEpoch,
            newId: () => OPERATION };
        const binder = createDashboardRequestDatabase({ ...common, resolveSubmissionQuota: () => null });
        await expect(binder.bindRequest(request, { expectedGeneration: 'a'.repeat(64) }))
            .rejects.toMatchObject({ statusCode: 403 });
        expect(pool.connect).not.toHaveBeenCalled();
        const runtime = createPostgresDashboardRuntimeRepository({ ...common,
            readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
            authoriseOperatorOperation: () => false, newGenerationToken: () => 'a'.repeat(64) });
        await expect(runtime.initializeOperatorSession(request, { operationId: OPERATION }))
            .rejects.toMatchObject({ statusCode: 403 });
        expect(pool.connect).not.toHaveBeenCalled();
        await expect(runtime.revokeSession(request, { operationId: OPERATION }))
            .rejects.toMatchObject({ statusCode: 503 });
        expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    test.each(['disabled auth', 'policy mismatch', 'extra auth factory', 'missing proof adapter', 'unbounded budget'])
    ('%s cannot construct the dormant adapter', kind => {
        const h = harness({ skipAdapter: true });
        if (kind === 'disabled auth') h.env.NOFRIES_REQUIRE_AUTH = 'false';
        if (kind === 'policy mismatch') h.options.identityPolicy.audience = SECOND;
        if (kind === 'extra auth factory') h.options.browserAuthOptions.authFactory = () => ({});
        if (kind === 'missing proof adapter') delete h.options.proofStore.readOriginalProof;
        if (kind === 'unbounded budget') h.options.requestBudgetMs = 60001;
        expect(() => createDashboardOperatorSession(h.options)).toThrow(expect.objectContaining({ statusCode: 503 }));
        expect(h.store.createSession).not.toHaveBeenCalled();
    });
});
