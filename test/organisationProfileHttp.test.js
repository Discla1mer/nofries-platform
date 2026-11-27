'use strict';

// GET/POST /api/dashboard/organisation-profile (#608 step 2): refusals through the
// real Express host, before any session or SQL work. Saving and reading against
// PostgreSQL are in test/integration/organisationProfileHttpPostgres.js.
const request = require('supertest');
const crypto = require('node:crypto');
const { createNoFriesApp } = require('../server');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const uid = n => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-11-27T08:00:00.000Z');
const GENERATION = 'a'.repeat(64);
const ROUTE = '/api/dashboard/organisation-profile';
const BODY = Object.freeze({ expectedRevision: 0, website: 'example.co.nz', industry: 'retail', region: 'auckland', sizeBand: '6-20' });
let serial = 0;

function harness({ enabled = true } = {}) {
    const origin = `https://profile-${++serial}.invalid`, state = { bytes: 1, sequence: 100, now: NOW };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: origin,
        NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(2),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-http-provider-only', NOFRIES_ALLOWED_SUBJECTS: uid(1) + ':' + uid(3) };
    const store = new MemoryBrowserSessionStore();
    store.loadSession = jest.fn(store.loadSession.bind(store));
    const proofs = new Map(), proofStore = {
        createOriginalProof: jest.fn(async (key, value) => { proofs.set(key, JSON.parse(JSON.stringify(value))); }),
        readOriginalProof: jest.fn(async key => proofs.get(key) || null)
    };
    const pool = { end: jest.fn(), connect: jest.fn(async () => { throw new Error('PRIVATE_SYNTHETIC_SQL_UNAVAILABLE'); }) };
    const configuration = {
        browserAuthOptions: { env, store, randomBytes: size => Buffer.alloc(size, state.bytes++),
            cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
            clientApplication: {
                async getAuthCodeUrl(input) {
                    return `https://login.microsoftonline.com/${uid(1)}/oauth2/v2.0/authorize?` +
                        new URLSearchParams({ client_id: uid(2), redirect_uri: input.redirectUri, response_type: 'code',
                            response_mode: 'form_post', state: input.state, nonce: input.nonce,
                            code_challenge: input.codeChallenge, code_challenge_method: 'S256' });
                },
                async acquireTokenByCode(input) {
                    return { idTokenClaims: { tid: uid(1), oid: uid(3), aud: uid(2),
                        iss: `https://login.microsoftonline.com/${uid(1)}/v2.0`, nonce: input.nonce,
                        exp: state.now / 1000 + 600 }, account: { tenantId: uid(1), localAccountId: uid(3) } };
                },
                getTokenCache: () => ({ removeAccount: async () => {} })
            } },
        identityPolicy: { policyId: 'synthetic-profile-http', policyRevision: 0,
            issuer: `https://login.microsoftonline.com/${uid(1)}/v2.0`, identityTenantId: uid(1), audience: uid(2) },
        proofStore, clock: () => new Date(state.now).toISOString(),
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(4), restoreEpoch: uid(5) })),
        newRequestId: () => uid(++state.sequence), requestBudgetMs: 1000, pool, instanceId: uid(4),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(++state.sequence), newOperationId: () => uid(++state.sequence),
        newGenerationToken: () => crypto.createHash('sha256').update(String(++state.sequence)).digest('hex'),
        ...(enabled ? { organisationProfileEnabled: true } : {})
    };
    const app = createNoFriesApp({ dashboard: configuration });
    const sameOrigin = call => call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    async function login() {
        const begun = await request(app).get('/api/auth/login?returnTo=%2Fportal');
        const callback = await request(app).post('/api/auth/callback')
            .set('Cookie', begun.headers['set-cookie'][0].split(';')[0]).type('form')
            .send({ state: new URL(begun.headers.location).searchParams.get('state'), code: 'synthetic-code' });
        expect(callback.status).toBe(303);
        const cookie = callback.headers['set-cookie'][0].split(';')[0];
        store.loadSession.mockClear(); proofStore.readOriginalProof.mockClear(); pool.connect.mockClear();
        return cookie;
    }
    return { app, configuration, origin, store, pool, proofStore, sameOrigin, login };
}
function closed(result, status, code) {
    expect([result.status, result.body]).toEqual([status, { code }]);
    // The edge rule carries no headers (config size), so the app's own must be complete.
    expect(result.headers['cache-control']).toMatch(/private.*no-store/);
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
    expect(result.headers['x-robots-tag']).toMatch(/noindex/);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-type']).toMatch(/^application\/json/);
    expect(result.text).not.toMatch(/PRIVATE_SYNTHETIC|synthetic-http-provider-only/);
}
function noPrivateWork(h) {
    expect(h.store.loadSession).not.toHaveBeenCalled();
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
}
beforeEach(() => resetAbuseProtectionForTests());

describe('organisation profile route refusals', () => {
    test('flag off: the route is unknown for GET and POST and its body is never read', async () => {
        const h = harness({ enabled: false });
        closed(await h.sameOrigin(request(h.app).get(ROUTE)), 404, 'dashboard_not_found');
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Content-Type', 'text/plain').send('x'.repeat(4096)), 404, 'dashboard_not_found');
        noPrivateWork(h);
    });
    test.each([false, null, 'true', 1, {}])('rejects explicit organisationProfileEnabled=%p', value => {
        const h = harness({ enabled: false });
        expect(() => createNoFriesApp({ dashboard: { ...h.configuration, organisationProfileEnabled: value } })).toThrow();
    });
    test.each(['put', 'delete'])('only GET and POST are accepted (%s)', async method => {
        const h = harness(), result = await request(h.app)[method](ROUTE);
        closed(result, 405, 'dashboard_method_not_allowed'); expect(result.headers.allow).toBe('GET, POST');
        noPrivateWork(h);
    });
    test.each([
        ['an unknown industry', { ...BODY, industry: 'mining' }], ['a private website', { ...BODY, website: 'http://localhost/' }],
        ['a missing field', { expectedRevision: 0, website: '', industry: '', region: '' }],
        ['an extra organisation field', { ...BODY, organisationId: 'other' }], ['a string revision', { ...BODY, expectedRevision: '0' }]
    ])('refuses %s before the session or database is touched', async (_, body) => {
        const h = harness();
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).send(body), 400, 'dashboard_input_invalid');
        noPrivateWork(h);
    });
    test('requires a signed-in session', async () => {
        const h = harness();
        closed(await h.sameOrigin(request(h.app).get(ROUTE)), 401, 'dashboard_authentication_required');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });
    test('refuses a staff operator session before any SQL', async () => {
        const h = harness(), cookie = await h.login();
        closed(await h.sameOrigin(request(h.app).get(ROUTE)).set('Cookie', cookie)
            .set('X-NoFries-Dashboard-Generation', GENERATION), 403, 'dashboard_access_denied');
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Cookie', cookie)
            .set('X-NoFries-Dashboard-Generation', GENERATION).send(BODY), 403, 'dashboard_access_denied');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });
});
