'use strict';

// POST /api/dashboard/contact-requests (#409 stage 1b): refusal ordering through
// the real Express host, and the writer's outcomes against a scripted database.
// Successful native journeys are in test/integration/contactRequestHttpPostgres.js.
const request = require('supertest');
const crypto = require('node:crypto');
const { createNoFriesApp } = require('../server');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');
const { CONTACT_TOPICS, ContactRequestError, normaliseContactRequest, writeContactRequest } = require('../api/shared/contactRequests');
const uid = n => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-11-18T22:00:00.000Z');
const GENERATION = 'a'.repeat(64);
const ROUTE = '/api/dashboard/contact-requests';
const BODY = Object.freeze({ operationId: uid(900), topic: 'results', consentVersion: 'contact-request-v1' });
let serial = 0;

function harness({ enabled = true } = {}) {
    const origin = `https://contact-${++serial}.invalid`, state = { bytes: 1, sequence: 100, now: NOW };
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
        identityPolicy: { policyId: 'synthetic-contact-http', policyRevision: 0,
            issuer: `https://login.microsoftonline.com/${uid(1)}/v2.0`, identityTenantId: uid(1), audience: uid(2) },
        proofStore, clock: () => new Date(state.now).toISOString(),
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(4), restoreEpoch: uid(5) })),
        newRequestId: () => uid(++state.sequence), requestBudgetMs: 1000, pool, instanceId: uid(4),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(++state.sequence), newOperationId: () => uid(++state.sequence),
        newGenerationToken: () => crypto.createHash('sha256').update(String(++state.sequence)).digest('hex'),
        ...(enabled ? { contactRequestsEnabled: true } : {})
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

describe('route refusals', () => {
    test('flag off: the route is unknown and its body is never read', async () => {
        const h = harness({ enabled: false });
        // A malformed media type and body would be refused (415) if anything read the request.
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Content-Type', 'text/plain').send('x'.repeat(4096)),
            404, 'dashboard_not_found');
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).send(BODY), 404, 'dashboard_not_found');
        noPrivateWork(h);
    });
    test.each([false, null, 'true', 1, {}])('rejects explicit contactRequestsEnabled=%p', value => {
        const h = harness({ enabled: false });
        expect(() => createNoFriesApp({ dashboard: { ...h.configuration, contactRequestsEnabled: value } })).toThrow();
    });
    test.each(['get', 'put', 'delete'])('only POST is accepted (%s)', async method => {
        const h = harness(), result = await request(h.app)[method](ROUTE);
        closed(result, 405, 'dashboard_method_not_allowed'); expect(result.headers.allow).toBe('POST');
        noPrivateWork(h);
    });
    test.each([
        ['an unknown topic', { ...BODY, topic: 'everything' }], ['a topic in another case', { ...BODY, topic: 'Results' }],
        ['an unknown consent version', { ...BODY, consentVersion: 'contact-request-v0' }],
        ['a non-uuid operation id', { ...BODY, operationId: 'retry-1' }], ['an upper-case operation id', { ...BODY, operationId: 'ABCDEF00-0000-4000-8000-000000000900' }],
        ['a missing field', { operationId: BODY.operationId, topic: 'results' }],
        ['an extra tenant field', { ...BODY, tenantId: uid(9) }], ['a message', { ...BODY, message: 'call me' }]
    ])('refuses %s before the session or database is touched', async (_, body) => {
        const h = harness();
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).send(body), 400, 'dashboard_input_invalid');
        noPrivateWork(h);
    });
    test('refuses a query string, a non-JSON body and a foreign origin before sign-in', async () => {
        const h = harness();
        closed(await h.sameOrigin(request(h.app).post(ROUTE + '?topic=results')).send(BODY), 400, 'dashboard_input_invalid');
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Content-Type', 'text/plain').send('x'), 415, 'dashboard_unsupported_media_type');
        closed(await request(h.app).post(ROUTE).set('Origin', 'https://foreign.invalid').set('Sec-Fetch-Site', 'cross-site').send(BODY),
            403, 'dashboard_access_denied');
        closed(await request(h.app).post(ROUTE).send(BODY), 403, 'dashboard_access_denied');
        noPrivateWork(h);
    });
    test('requires a signed-in session', async () => {
        const h = harness();
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).send(BODY), 401, 'dashboard_authentication_required');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });
    test('refuses a staff operator session, with or without a generation, before any SQL', async () => {
        const h = harness(), cookie = await h.login();
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Cookie', cookie)
            .set('X-NoFries-Dashboard-Generation', GENERATION).send(BODY), 403, 'dashboard_access_denied');
        closed(await h.sameOrigin(request(h.app).post(ROUTE)).set('Cookie', cookie).send(BODY), 403, 'dashboard_access_denied');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });
});

describe('closed inputs', () => {
    test('the topic list is "results" plus every dashboard service key', () => {
        expect(CONTACT_TOPICS).toEqual(['results', ...registry.services.map(service => service.key)]);
        expect(CONTACT_TOPICS).toHaveLength(13);
    });
    test('a valid request is copied and frozen; anything else is a closed 400', () => {
        const value = normaliseContactRequest({ ...BODY });
        expect(value).toEqual(BODY); expect(Object.isFrozen(value)).toBe(true);
        for (const input of [null, [], 'results', { ...BODY, topic: 'results ' }, { ...BODY, operationId: 1 }]) {
            expect(() => normaliseContactRequest(input)).toThrow(expect.objectContaining({ code: 'contact_request_input_invalid', statusCode: 400 }));
        }
    });
});

describe('writer outcomes', () => {
    const SUBJECT = uid(1) + ':' + uid(3), SCOPE = Object.freeze({ tenantId: 'tenant-a', organisationId: 'organisation-a' });
    async function contextFor(subjectKey = SUBJECT) {
        const resolver = createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey }),
            resolveScope: async () => SCOPE, clock: () => '2026-11-18T22:00:00.000Z', createRequestId: () => uid(50) });
        return resolver.resolve({});
    }
    // Rows keyed by request id, plus the daily unique key, as 0026 enforces them.
    function database(rows = new Map()) {
        const statements = [], events = [];
        const client = { async query(sql, params) {
            statements.push([sql.replace(/\s+/g, ' ').trim(), params]);
            if (sql.includes('SELECT')) {
                const row = rows.get(params[1]);
                return { rows: row ? [{ organisation_id: row[1], subject_key: row[3], topic: row[4], consent_version: row[5] }] : [] };
            }
            const daily = [...rows.values()].some(row => row[1] === params[1] && row[4] === params[4] && row[7].slice(0, 10) === params[6].slice(0, 10));
            if (rows.has(params[2]) || daily) return { rowCount: 0 };
            rows.set(params[2], [...params, params[6]]);
            return { rowCount: 1 };
        } };
        return { rows, statements, events, port: {
            database: { withTenantTransaction: jest.fn(async (tenantId, work) => { expect(tenantId).toBe(SCOPE.tenantId); return work(client); }) },
            clock: () => '2026-11-18T22:00:00.000Z',
            audit: { createEvent: (context, operation) => ({ context, ...operation }), writeEvent: async event => { events.push(event); } } } };
    }
    test('first request is stored for the bound organisation and subject, with the NZ day taken from the stored time', async () => {
        const d = database(), context = await contextFor();
        await expect(writeContactRequest({ ...d.port, context }, BODY)).resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        const insert = d.statements.find(([sql]) => sql.startsWith('INSERT'));
        expect(insert[0]).toContain("($7::timestamptz AT TIME ZONE 'Pacific/Auckland')::date, $7::timestamptz");
        expect(insert[0]).toContain('ON CONFLICT DO NOTHING');
        expect(insert[1]).toEqual(['tenant-a', 'organisation-a', BODY.operationId, SUBJECT, 'results', 'contact-request-v1', '2026-11-18T22:00:00.000Z']);
        expect(d.events).toEqual([{ context, action: 'contact.request', module: 'overview', result: 'succeeded' }]);
    });
    test('a retry of the same operation id returns the same result without a second row', async () => {
        const d = database(), context = await contextFor();
        await writeContactRequest({ ...d.port, context }, BODY);
        await expect(writeContactRequest({ ...d.port, context }, BODY)).resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        expect(d.rows.size).toBe(1);
        expect(d.statements.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1);
    });
    test('a second request for the same topic and day is "already requested", not an error', async () => {
        const d = database(), context = await contextFor();
        await writeContactRequest({ ...d.port, context }, BODY);
        const second = { ...BODY, operationId: uid(901) };
        await expect(writeContactRequest({ ...d.port, context }, second)).resolves.toEqual({ schemaVersion: 1, status: 'already_requested' });
        // Retrying that second call gives the same answer.
        await expect(writeContactRequest({ ...d.port, context }, second)).resolves.toEqual({ schemaVersion: 1, status: 'already_requested' });
        await expect(writeContactRequest({ ...d.port, context }, { ...BODY, operationId: uid(902), topic: 'tier1_support' }))
            .resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        expect(d.rows.size).toBe(2);
    });
    test('reusing an operation id for other content, or another subject\'s id, is a conflict and writes no audit', async () => {
        const d = database(), context = await contextFor();
        await writeContactRequest({ ...d.port, context }, BODY);
        await expect(writeContactRequest({ ...d.port, context }, { ...BODY, topic: 'monthly_proof' }))
            .rejects.toEqual(new ContactRequestError('contact_request_operation_conflict', 409));
        const other = await contextFor(uid(7) + ':' + uid(8));
        await expect(writeContactRequest({ ...d.port, context: other }, BODY))
            .rejects.toMatchObject({ code: 'contact_request_operation_conflict', statusCode: 409 });
        expect(d.events).toHaveLength(1);
    });
    test('refuses an unbranded context before any database work', async () => {
        const d = database();
        await expect(writeContactRequest({ ...d.port, context: { scope: SCOPE, identity: { subjectKey: SUBJECT } } }, BODY)).rejects.toThrow();
        expect(d.port.database.withTenantTransaction).not.toHaveBeenCalled();
    });
});
