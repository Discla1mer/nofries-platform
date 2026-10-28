'use strict';
const { createRuntime } = require('../api/shared/websiteAnalyticsRuntime');
const tenant = '947787df-88fd-4417-b6b2-99c13d8410ba', person = 'acada13b-5614-49d6-a356-88d816aa0a3c';
const subject = `${tenant}:${person}`;
const env = { NOFRIES_PUBLIC_URL: 'https://nofries.nz', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff', NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_DEFAULT_TENANT_ID: 'no-fries', NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ALLOWED_SUBJECTS: subject, NOFRIES_ADMIN_SUBJECTS: subject };
const identity = { provider: 'entra-bff', isAuthenticated: true, subjectKey: subject, tenantId: tenant, principalId: person };
const doc = { version: 1, start: '2026-10-28', home: 1, days: {} };
const store = { read: jest.fn(async () => doc), record: jest.fn(async () => {}) };
const get = (headers = {}) => ({ method: 'GET', headers });
const post = (body, headers = {}) => ({ method: 'POST', headers: { origin: env.NOFRIES_PUBLIC_URL, 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) });
const event = { event: 'view', page: 'home', device: 'unknown', referrer: 'direct' };
beforeEach(() => jest.clearAllMocks());
test('staff summary requires BFF, both allowlists and current default tenant', async () => {
    const handler = createRuntime({ env, store, getIdentity: async () => identity });
    expect((await handler(get(), '/summary')).status).toBe(200);
    for (const bad of [{ ...env, NOFRIES_ALLOWED_SUBJECTS: '' }, { ...env, NOFRIES_ADMIN_SUBJECTS: '' }, { ...env, NOFRIES_ENTRA_TENANT_ID: 'other' }, { ...env, NOFRIES_DEFAULT_TENANT_ID: '' }, { ...env, NOFRIES_BROWSER_AUTH_MODE: 'swa' }]) {
        expect((await createRuntime({ env: bad, store, getIdentity: async () => identity })(get(), '/summary')).status).toBe(403);
    }
    for (const bad of [null, { ...identity, provider: 'customer' }, { ...identity, isAuthenticated: false }, { ...identity, tenantId: 'wrong' }]) {
        expect((await createRuntime({ env, store, getIdentity: async () => { if (!bad) throw Error('expired'); return bad; } })(get(), '/summary')).status).toBe(403);
    }
});
test('rejects origins, unbounded fields and methods; honors privacy signals', async () => {
    const handler = createRuntime({ env, store });
    expect((await handler(post(event), '/events')).status).toBe(204);
    for (const req of [post({ ...event, url: '?token=x' }), post(event, { origin: 'https://evil.invalid' }), post(event, { 'sec-fetch-site': 'cross-site' }), post(event, { 'content-type': 'text/plain' }), { ...post(event), body: Buffer.alloc(513) }]) expect((await handler(req, '/events')).status).toBe(400);
    for (const h of [{ dnt: '1' }, { 'sec-gpc': '1' }]) expect((await handler(post(event, h), '/events')).status).toBe(204);
    expect(store.record).toHaveBeenCalledTimes(1);
    expect((await handler({ method: 'DELETE', headers: {} }, '/events')).status).toBe(404);
    expect((await handler(get(), '/unknown')).status).toBe(404);
});
test('unconfigured and exhausted instances fail without recording or storing identities', async () => {
    expect((await createRuntime({ env, store: null })(post(event), '/events')).status).toBe(503);
    const handler = createRuntime({ env, store, clock: () => 1000 });
    for (let i = 0; i < 300; i++) await handler(get(), '/counter');
    expect((await handler(post(event), '/events')).status).toBe(429);
    expect(store.record).not.toHaveBeenCalled();
});
test('real BFF cookie verifier rejects anonymous, forged, expired, revoked and customer cookies', async () => {
    const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
    const sessions = new MemoryBrowserSessionStore(), id = Buffer.alloc(32, 5).toString('base64url');
    const now = Date.now();
    const record = { v: 1, kind: 'browser_session', issuedAt: now - 1000, idleExpiresAt: now + 60000, absoluteExpiresAt: now + 60000, identity };
    await sessions.createSession(id, record);
    const handler = createRuntime({ env, store, identityStore: sessions });
    const cookie = `__Host-nofries-auth=${id}`;
    expect((await handler(get({ cookie }), '/summary')).status).toBe(200);
    for (const headers of [{}, { 'x-ms-client-principal': Buffer.from(JSON.stringify({ userDetails: 'admin@example.com' })).toString('base64') }, { cookie: `__Host-nofries-customer=${id}` }, { cookie: '__Host-nofries-auth=invalid' }]) expect((await handler(get(headers), '/summary')).status).toBe(403);
    sessions.sessions.set(id, { ...record, idleExpiresAt: now - 1 });
    expect((await handler(get({ cookie }), '/summary')).status).toBe(403);
    sessions.sessions.set(id, record);
    const revoked = createRuntime({ env: { ...env, NOFRIES_ALLOWED_SUBJECTS: '' }, store, identityStore: sessions });
    expect((await revoked(get({ cookie }), '/summary')).status).toBe(403);
});
test('App Service terminates disabled analytics methods before generic API limiter', async () => {
    const app = require('../server').createNoFriesApp();
    const request = require('supertest');
    for (const result of [await request(app).get('/api/website-analytics/counter'), await request(app).post('/api/website-analytics/events').send({}), await request(app).delete('/api/website-analytics/summary')]) {
        expect(result.status).toBe(503); expect(result.headers['cache-control']).toMatch(/no-store/); expect(result.headers['x-ratelimit-limit']).toBeUndefined();
    }
});
test('Function bindings and SWA routes expose only exact paths and guard summary in runtime', () => {
    const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json')));
    for (const [name, suffix] of [['websiteAnalyticsCounter', 'counter'], ['websiteAnalyticsEvents', 'events'], ['websiteAnalyticsSummary', 'summary']]) {
        const binding = require(`../api/${name}/function.json`).bindings[0];
        expect(binding).toMatchObject({ route: `website-analytics/${suffix}`, authLevel: 'anonymous' });
        const routes = config.routes.filter(r => r.route === `/api/website-analytics/${suffix}`);
        expect(routes).toHaveLength(1); expect(routes[0].allowedRoles).toEqual(['anonymous']);
        expect(typeof require(`../api/${name}`)).toBe('function');
    }
    expect(config.routes.some(r => r.route === '/api/website-analytics/*' && r.allowedRoles.includes('anonymous'))).toBe(false);
    expect(config.routes.find(r => r.route === '/api/*').allowedRoles).toEqual(['authenticated']);
});
test('bounded identity checks retain slots after timeout and never read on late success', async () => {
    jest.useFakeTimers();
    try {
        const resolves = [];
        const handler = createRuntime({ env, store, getIdentity: () => new Promise(resolve => resolves.push(resolve)) });
        const pending = Array.from({ length: 4 }, () => handler(get(), '/summary'));
        await Promise.resolve();
        expect(resolves).toHaveLength(4);
        // The cap applies across separately composed runtimes in this process.
        const other = createRuntime({ env, store, getIdentity: async () => identity });
        expect((await other(get(), '/summary')).status).toBe(503);
        await jest.advanceTimersByTimeAsync(2000);
        expect((await Promise.all(pending)).map(r => r.status)).toEqual([503, 503, 503, 503]);
        expect((await other(get(), '/summary')).status).toBe(503);
        expect(store.read).not.toHaveBeenCalled();
        resolves[0](identity); await Promise.resolve(); await Promise.resolve();
        expect((await other(get(), '/summary')).status).toBe(200);
        expect(store.read).toHaveBeenCalledTimes(1);
        for (const resolve of resolves.slice(1)) resolve(identity);
        await Promise.resolve(); await Promise.resolve();
        expect(store.read).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});
