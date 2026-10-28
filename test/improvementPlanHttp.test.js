'use strict';

// Actual Express/IncomingMessage, browser callback, proof and host guards.
// The deliberately unavailable SQL transport proves refusal ordering only;
// successful retained/native journeys belong to the existing PostgreSQL fixture.
const request = require('supertest');
const crypto = require('node:crypto');
const http = require('node:http');
const { createNoFriesApp } = require('../server');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const uid = n => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-09-08T22:00:00.000Z');
const GENERATION = 'a'.repeat(64);
const SELECTOR = '?planId=plan-a';
const COMMAND = Object.freeze({ planId: 'plan-a', type: 'generate', operationId: 'generate-a',
    expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-a', assessmentRevision: 2,
        assessmentRevisionSha256: 'b'.repeat(64) } });
let serial = 0;

function harness({ enabled = true } = {}) {
    const origin = `https://improvement-${++serial}.invalid`, state = { bytes: 1, sequence: 100, now: NOW };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: origin,
        NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(2),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-http-provider-only', NOFRIES_ALLOWED_SUBJECTS: uid(1) + ':' + uid(3) };
    const store = new MemoryBrowserSessionStore();
    store.loadSession = jest.fn(store.loadSession.bind(store));
    const proofs = new Map(), proofStore = {
        createOriginalProof: jest.fn(async (key, value) => {
            if (proofs.has(key)) throw new Error('Synthetic conditional collision');
            proofs.set(key, JSON.parse(JSON.stringify(value)));
        }),
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
        identityPolicy: { policyId: 'synthetic-improvement-http', policyRevision: 0,
            issuer: `https://login.microsoftonline.com/${uid(1)}/v2.0`, identityTenantId: uid(1), audience: uid(2) },
        proofStore, clock: () => new Date(state.now).toISOString(),
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(4), restoreEpoch: uid(5) })),
        newRequestId: () => uid(++state.sequence), requestBudgetMs: 1000, pool, instanceId: uid(4),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(++state.sequence), newOperationId: () => uid(++state.sequence),
        newGenerationToken: () => crypto.createHash('sha256').update(String(++state.sequence)).digest('hex'),
        ...(enabled ? { improvementEnabled: true } : {})
    };
    const app = createNoFriesApp({ dashboard: configuration });
    const sameOrigin = call => call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    async function login() {
        const begun = await request(app).get('/api/auth/login?returnTo=%2Fportal');
        expect(begun.status).toBe(302);
        const callback = await request(app).post('/api/auth/callback')
            .set('Cookie', begun.headers['set-cookie'][0].split(';')[0]).type('form')
            .send({ state: new URL(begun.headers.location).searchParams.get('state'), code: 'synthetic-code' });
        expect(callback.status).toBe(303);
        const cookie = callback.headers['set-cookie'][0].split(';')[0];
        store.loadSession.mockClear(); proofStore.readOriginalProof.mockClear(); pool.connect.mockClear();
        return cookie;
    }
    return { app, configuration, state, origin, store, pool, proofStore, sameOrigin, login };
}
function closed(result, status, code) {
    expect(result.status).toBe(status); expect(result.body).toEqual({ code });
    expect(result.headers['cache-control']).toContain('private'); expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['content-type']).toMatch(/^application\/json/);
    expect(result.headers.location).toBeUndefined();
    expect(result.text).not.toMatch(/PRIVATE_SYNTHETIC|synthetic-http-provider-only|72000000/);
}
function noPrivateWork(h) {
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
}
beforeEach(() => resetAbuseProtectionForTests());

test('work queue remains unavailable without explicit Improvement runtime readiness', async () => {
    const h = harness({ enabled: false });
    closed(await request(h.app).get('/api/dashboard/work-queue'), 404, 'dashboard_not_found');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['', '?limit=1', '?limit=50'])('canonical work queue %s requires authentication and private JSON headers', async query => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/work-queue' + query), 401, 'dashboard_authentication_required');
    noPrivateWork(h);
});
test.each(['post', 'put', 'delete'])('work queue rejects %s and never installs a write capability', async method => {
    const h = harness(), result = await request(h.app)[method]('/api/dashboard/work-queue');
    closed(result, 405, 'dashboard_method_not_allowed'); expect(result.headers.allow).toBe('GET');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['?limit=0', '?limit=51', '?limit=01', '?limit=%31', '?limit=2&limit=3', '?cursor=', '?cursor=e30',
    '?tenantId=foreign', '?bindingId=foreign', '?cursor=%61', '?cursor=%ZZ', '?cursor=a+b'])
('work queue rejects closed or noncanonical selector %s before providers', async query => {
    const h = harness(), result = await request(h.app).get('/api/dashboard/work-queue' + query);
    expect(result.status).toBe(400); expect(Object.keys(result.body)).toEqual(['code']);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test('work queue rejects an operator session before any portfolio SQL', async () => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/work-queue').set('Cookie', cookie)
        .set('X-NoFries-Dashboard-Generation', GENERATION), 403, 'dashboard_access_denied');
    noPrivateWork(h);
});
test('work queue requires a generation and rejects GET bodies before database work', async () => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/work-queue').set('Cookie', cookie), 403, 'dashboard_access_denied');
    closed(await request(h.app).get('/api/dashboard/work-queue').set('Content-Type', 'text/plain').send('unexpected'),
        400, 'dashboard_input_invalid');
    noPrivateWork(h);
});

test.each([
    ['get', 'plans', 401], ['get', 'list?planId=plan-a', 401], ['get', 'view?planId=plan-a', 401], ['get', 'editor?planId=plan-a', 401],
    ['get', 'execute', 405], ['post', 'plans', 405], ['get', 'unknown', 404]
])('the canonical %s improvement/%s response owns complete private JSON headers', async (method, path, status) => {
    const h = harness(), result = await request(h.app)[method]('/api/dashboard/improvement/' + path);
    expect(result.status).toBe(status);
    expect(result.headers['cache-control']).toMatch(/private.*no-store/);
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
    expect(result.headers['x-robots-tag']).toMatch(/noindex/);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-type']).toMatch(/^application\/json/);
    noPrivateWork(h);
});

test.each([false, null, undefined, 'true', 1, {}, []])('rejects explicit improvementEnabled=%p', value => {
    const h = harness({ enabled: false });
    expect(() => createNoFriesApp({ dashboard: { ...h.configuration, improvementEnabled: value } })).toThrow();
    expect(h.pool.connect).not.toHaveBeenCalled();
});
test('rejects an accessor activation without invoking it', () => {
    const h = harness({ enabled: false }), getter = jest.fn(() => true), dashboard = { ...h.configuration };
    Object.defineProperty(dashboard, 'improvementEnabled', { enumerable: true, get: getter });
    expect(() => createNoFriesApp({ dashboard })).toThrow(); expect(getter).not.toHaveBeenCalled();
});
test.each(['plans', 'list', 'view', 'editor', 'execute'])('keeps improvement/%s unmounted by default', async action => {
    const h = harness({ enabled: false });
    closed(await request(h.app).get('/api/dashboard/improvement/' + action + SELECTOR), 404, 'dashboard_not_found');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['list/', 'view/extra', 'editor/', 'editor/extra', '%65ditor', 'execute/', 'evidence', 'ranking', '%6cist'])('closes unsupported improvement/%s', async path => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/improvement/' + path + SELECTOR), 404, 'dashboard_not_found');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each([['post', 'plans', 'GET'], ['post', 'list', 'GET'], ['post', 'view', 'GET'], ['post', 'editor', 'GET'], ['put', 'editor', 'GET'], ['delete', 'editor', 'GET'], ['get', 'execute', 'POST'], ['put', 'execute', 'POST']])
('rejects %s improvement/%s with exact Allow', async (method, action, allow) => {
    const h = harness(), result = await request(h.app)[method]('/api/dashboard/improvement/' + action);
    closed(result, 405, 'dashboard_method_not_allowed'); expect(result.headers.allow).toBe(allow);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['', '?', '?status=open', '?planId=a&planId=b', '?planId=a&tenantId=other', '?planId=a&overdueOnly=1',
    '?planId=a&overdueOnly=TRUE', '?planId=a&owner=a+b', '?planId=%70lan-a', '?planId=%ZZ', '?planId=a&status='])
('rejects noncanonical/closed selector %s before providers', async query => {
    const h = harness(), result = await request(h.app).get('/api/dashboard/improvement/list' + query);
    expect(result.status).toBe(400); expect(Object.keys(result.body)).toEqual(['code']);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['list', 'view', 'editor'])('%s accepts the canonical plan selector and still requires authentication', async action => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/improvement/' + action + SELECTOR), 401, 'dashboard_authentication_required');
    noPrivateWork(h);
});
test.each(['', '?planId=', '?status=open', '?planId=a&planId=b', '?planId=a&tenantId=other',
    '?planId=a&status=all', '?planId=a&owner=all', '?planId=a&overdueOnly=false', '?planId=%70lan-a',
    '?planId=%ZZ', '?planId=a+b', '?planId=a&'])
('editor rejects noncanonical or additional selector fields %s before providers', async query => {
    const h = harness(), result = await request(h.app).get('/api/dashboard/improvement/editor' + query);
    expect(result.status).toBe(400); expect(Object.keys(result.body)).toEqual(['code']);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['?planId=plan-a&status=blocked&owner=unassigned&overdueOnly=false',
    '?planId=plan-a&overdueOnly=true', '?planId=plan-a&owner=' + encodeURIComponent(uid(1) + ':' + uid(3))])
('accepts canonical selector %s before authentication', async selector => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/improvement/list' + selector), 401, 'dashboard_authentication_required');
    noPrivateWork(h);
});
test.each(['?limit=0', '?limit=51', '?limit=01', '?limit=1.5', '?limit=%31', '?limit=1&limit=2',
    '?planId=plan-a', '?tenantId=foreign', '?afterPlanId=', '?afterPlanId=%70lan-a', '?afterPlanId=%ZZ',
    '?afterPlanId=plan-a&afterPlanId=plan-b'])('rejects closed/canonical plan page %s before providers', async query => {
    const h = harness();
    const result = await request(h.app).get('/api/dashboard/improvement/plans' + query);
    expect(result.status).toBe(400); expect(Object.keys(result.body)).toEqual(['code']);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test('rejects an empty raw plan-page query before providers', async () => {
    const h = harness(), server = h.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        // Supertest removes a trailing question mark. Exercise the original
        // IncomingMessage target so this checks the actual empty-query guard.
        const result = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
                path: '/api/dashboard/improvement/plans?' }, res => {
                const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            }); req.on('error', reject); req.end();
        });
        expect(result).toEqual({ status: 400, body: { code: 'dashboard_input_invalid' } });
        expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test.each(['', '?limit=1', '?limit=50', '?afterPlanId=plan-a', '?limit=2&afterPlanId=plan-a'])
('valid plan index %s still requires authentication', async query => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/improvement/plans' + query), 401, 'dashboard_authentication_required');
    noPrivateWork(h);
});
test('plan index requires original generation after genuine callback', async () => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/improvement/plans').set('Cookie', cookie), 403, 'dashboard_access_denied');
    noPrivateWork(h);
});
test('plan index reaches the actual binder with canonical page, cookie and generation', async () => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/improvement/plans?limit=2&afterPlanId=plan-a')
        .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', GENERATION), 503, 'improvement_list_unavailable');
    expect(h.pool.connect).toHaveBeenCalledTimes(1); expect(h.proofStore.readOriginalProof).toHaveBeenCalled();
});
test.each(['list', 'view', 'editor'])('%s requires generation after genuine callback before private binding', async action => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/improvement/' + action + SELECTOR).set('Cookie', cookie), 403, 'dashboard_access_denied');
    expect(h.store.loadSession).toHaveBeenCalledTimes(1); noPrivateWork(h);
});
test.each(['list', 'view', 'editor'])('%s reaches the actual request binder after genuine callback and generation', async action => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).get('/api/dashboard/improvement/' + action + SELECTOR)
        .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', GENERATION), 503, 'improvement_list_unavailable');
    expect(h.pool.connect).toHaveBeenCalledTimes(1); expect(h.proofStore.readOriginalProof).toHaveBeenCalled();
});
test('mutation refuses absent exact origin before authentication or native work', async () => {
    const h = harness(), cookie = await h.login();
    closed(await request(h.app).post('/api/dashboard/improvement/execute').set('Cookie', cookie)
        .set('X-NoFries-Dashboard-Generation', GENERATION).send(COMMAND), 403, 'dashboard_access_denied');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test('mutation refuses cross-origin before authentication or native work', async () => {
    const h = harness();
    closed(await request(h.app).post('/api/dashboard/improvement/execute').set('Origin', 'https://foreign.invalid')
        .set('Sec-Fetch-Site', 'cross-site').send(COMMAND), 403, 'dashboard_access_denied');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test('mutation requires a parent cookie after canonical origin/body validation', async () => {
    const h = harness();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).send(COMMAND), 401, 'dashboard_authentication_required');
    noPrivateWork(h);
});
test('mutation requires generation after genuine callback', async () => {
    const h = harness(), cookie = await h.login();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).set('Cookie', cookie)
        .send(COMMAND), 403, 'dashboard_access_denied'); noPrivateWork(h);
});
test('mutation closes the existing command shape before opening native SQL', async () => {
    const h = harness(), cookie = await h.login();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).set('Cookie', cookie)
        .set('X-NoFries-Dashboard-Generation', GENERATION).send({ ...COMMAND, tenantId: 'foreign' }), 400, 'improvement_input_invalid');
    noPrivateWork(h);
});
test('mutation reaches the actual binder without exposing unavailable SQL details', async () => {
    const h = harness(), cookie = await h.login();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).set('Cookie', cookie)
        .set('X-NoFries-Dashboard-Generation', GENERATION).send(COMMAND), 503, 'improvement_unavailable');
    expect(h.pool.connect).toHaveBeenCalledTimes(1); expect(h.proofStore.readOriginalProof).toHaveBeenCalled();
});
test('mutation rejects a query rather than accepting alternate command fields', async () => {
    const h = harness();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute?planId=other')).send(COMMAND),
        400, 'dashboard_input_invalid');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['list', 'editor'])('%s GET refuses a body before authentication or native work', async action => {
    const h = harness();
    closed(await request(h.app).get('/api/dashboard/improvement/' + action + SELECTOR).set('Content-Type', 'text/plain')
        .send('unexpected'), 400, 'dashboard_input_invalid');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test('parent-session work cannot outlive the original request budget', async () => {
    const h = harness(), cookie = await h.login(), load = h.store.loadSession.getMockImplementation();
    h.store.loadSession.mockImplementationOnce(async id => {
        const value = await load(id); h.state.now += 1001; return value;
    });
    closed(await request(h.app).get('/api/dashboard/improvement/list' + SELECTOR).set('Cookie', cookie)
        .set('X-NoFries-Dashboard-Generation', GENERATION), 503, 'dashboard_unavailable');
    noPrivateWork(h);
});
test('mutation rejects compressed wire input before providers', async () => {
    const h = harness();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).set('Content-Encoding', 'gzip')
        .send(COMMAND), 415, 'dashboard_unsupported_media_type');
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each([['text/plain', JSON.stringify(COMMAND), 415, 'dashboard_unsupported_media_type'],
    ['application/json', '{broken', 400, 'dashboard_input_invalid'],
    ['application/json', JSON.stringify({ padding: 'x'.repeat(524288) }), 413, 'dashboard_request_too_large']])
('preserves raw wire refusal for %s', async (type, body, status, code) => {
    const h = harness();
    closed(await h.sameOrigin(request(h.app).post('/api/dashboard/improvement/execute')).set('Content-Type', type)
        .send(body), status, code);
    expect(h.store.loadSession).not.toHaveBeenCalled(); noPrivateWork(h);
});
test.each(['list', 'editor'])('%s rejects duplicate generation headers on an actual HTTP socket', async action => {
    const h = harness(), cookie = await h.login(), server = http.createServer(h.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
                path: '/api/dashboard/improvement/' + action + SELECTOR, headers: ['Host', 'transport.invalid', 'Connection', 'close',
                    'Cookie', cookie, 'X-NoFries-Dashboard-Generation', GENERATION, 'X-NoFries-Dashboard-Generation', GENERATION] }, res => {
                const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            }); req.on('error', reject); req.end();
        });
        expect(result).toEqual({ status: 403, body: { code: 'dashboard_access_denied' } }); noPrivateWork(h);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
