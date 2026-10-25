'use strict';

// Exercise the actual composed Express host, without production configuration,
// external I/O, real identities or a mock replacement for its staff session reader.
const { createServer, IncomingMessage } = require('node:http');
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { fixture, SUBJECT: TARGET, NOW } = require('./fixtures/dashboardFixture');

const uid = n => '71000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), ACTOR = uid(2), CLIENT = uid(3), SUBJECT = TENANT + ':' + ACTOR;
const TOKEN = Buffer.alloc(32, 71).toString('base64url');
const COOKIE = '__Host-nofries-auth=' + TOKEN;
const routes = ['/dashboard-admin', '/dashboard-admin/', '/api/dashboard-admin/app.js',
    '/api/dashboard-admin/app.css', '/api/dashboard-admin/capabilities'];
const clone = value => JSON.parse(JSON.stringify(value));

async function harness({ role = 'admin', admin = true, reader = true, audit = true } = {}) {
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-composition-test-secret',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: role === 'admin' ? SUBJECT : '',
        // These strings cannot install a factory or confer authority.
        NOFRIES_DASHBOARD_ADMIN_ENABLED: 'true', NOFRIES_DASHBOARD_ADMIN_SIGNUPS_ENABLED: 'true' };
    const store = new MemoryBrowserSessionStore();
    await store.createSession(TOKEN, { v: 1, kind: 'browser_session',
        issuedAt: Date.parse(NOW) - 60000, idleExpiresAt: Date.parse(NOW) + 60000,
        absoluteExpiresAt: Date.parse(NOW) + 600000,
        identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT,
            principalId: ACTOR, subjectKey: SUBJECT, name: 'Synthetic operator', email: 'operator@example.invalid' } });
    const pool = { connect: jest.fn(async () => { throw new Error('UNEXPECTED_DATABASE_ACCESS'); }), end: jest.fn() };
    const dashboard = { browserAuthOptions: { env, store },
        identityPolicy: { policyId: 'synthetic-composition-policy', policyRevision: 1,
            issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
        proofStore: { createOriginalProof: jest.fn(), readOriginalProof: jest.fn(async () => null) },
        clock: () => NOW, readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(10), restoreEpoch: uid(11) })),
        newRequestId: () => uid(12), requestBudgetMs: 1000, pool, instanceId: uid(10),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(13), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => uid(14) };
    const f = fixture();
    const snapshot = { tenantAggregate: clone(f.tenantAggregate), membershipState: clone(f.membershipState),
        entitlementState: clone(f.entitlementState), flags: clone(f.flags), advisorAssignments: [],
        usage: f.entitlementState.grants.map(dataCodec.newUsage) };
    const observation = { snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt: NOW };
    const selector = { provider: 'legacy', subjectKey: TARGET, ...f.scope };
    const state = { allowed: true };
    const ports = { authoriseOperator: jest.fn(async () => state.allowed),
        readAuthoritySnapshot: reader ? jest.fn(async () => observation) : null,
        audit: jest.fn(async () => audit), clock: dashboard.clock, requestBudgetMs: 1000 };
    const configuration = { dashboard, ...(admin ? { dashboardAdmin: ports } : {}) };
    const app = createNoFriesApp(configuration);
    return { app, env, store, pool, dashboard, ports, selector, observation, state, configuration };
}

function privateError(response, status, code) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code });
    expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.text).not.toMatch(/UNEXPECTED_DATABASE_ACCESS|synthetic-composition-test-secret|operator@example/);
}
function lookup(h, server = h.app, label) {
    const operation = request(server).post('/api/dashboard-admin/lookup').set('Cookie', COOKIE)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin');
    if (label) operation.set('X-Composition-Test', label);
    return operation.send(h.selector);
}

test.each(routes)('actual host stays disabled without trusted configuration: %s', async route => {
    const response = await request(createNoFriesApp()).get(route).set('Cookie', COOKIE)
        .set('X-MS-Client-Principal', 'forged');
    privateError(response, 503, 'dashboard_admin_unavailable');
});

test('valid staff admin and environment opt-in strings cannot install the administration service', async () => {
    const h = await harness({ admin: false });
    for (const route of routes) privateError(await request(h.app).get(route).set('Cookie', COOKIE),
        503, 'dashboard_admin_unavailable');
    privateError(await lookup(h), 503, 'dashboard_admin_unavailable');
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.ports.authoriseOperator).not.toHaveBeenCalled();
    expect(h.ports.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.ports.audit).not.toHaveBeenCalled();
});

test.each(['authoriseOperator', 'audit', 'clock', 'readAuthoritySnapshot', 'requestBudgetMs'])
('incomplete explicit composition fails during construction: %s', async key => {
    const h = await harness();
    const incomplete = { ...h.ports }; delete incomplete[key];
    expect(() => createNoFriesApp({ dashboard: h.dashboard, dashboardAdmin: incomplete }))
        .toThrow(expect.objectContaining({ code: 'browser_auth_dashboard_unavailable', statusCode: 503 }));
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.ports.authoriseOperator).not.toHaveBeenCalled();
});

test.each(['__Host-nofries-customer=', '__Host-nofries-external-customer='])
('customer cookie cannot substitute for the actual staff cookie: %s', async name => {
    const h = await harness();
    const result = await request(h.app).get('/dashboard-admin').set('Cookie', name + TOKEN);
    privateError(result, 401, 'dashboard_admin_authentication_required');
    expect(h.ports.authoriseOperator).not.toHaveBeenCalled();
    expect(h.ports.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.ports.audit).not.toHaveBeenCalled();
});

test('a genuine allowed staff Consultant cannot reach the administration policy or reader', async () => {
    const h = await harness({ role: 'consultant' });
    privateError(await lookup(h), 403, 'dashboard_admin_access_denied');
    expect(h.ports.authoriseOperator).not.toHaveBeenCalled();
    expect(h.ports.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.ports.audit).not.toHaveBeenCalled();
});

test('explicitly absent lookup reader advertises absence and never starts an audit', async () => {
    const h = await harness({ reader: false });
    const capability = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', COOKIE);
    expect(capability.status).toBe(200);
    expect(capability.body).toEqual({ lookup: false, recovery: [] });
    privateError(await lookup(h), 503, 'dashboard_admin_unavailable');
    expect(h.ports.audit).not.toHaveBeenCalled();
    expect(h.pool.connect).not.toHaveBeenCalled();
});

test('lookup composition cannot provide listing or any recovery endpoint', async () => {
    const h = await harness();
    for (const route of ['signups', 'reset', 'delete', 'grant']) {
        const result = await request(h.app).post('/api/dashboard-admin/' + route).set('Cookie', COOKIE)
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).send({});
        privateError(result, 404, 'dashboard_admin_not_found');
    }
    const capability = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', COOKIE);
    expect(capability.body).toEqual({ lookup: true, recovery: [] });
    expect(h.ports.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.ports.audit).not.toHaveBeenCalled();
});

test('unacknowledged attempt audit prevents even the exact synthetic lookup read', async () => {
    const h = await harness({ audit: false });
    privateError(await lookup(h), 503, 'dashboard_admin_unavailable');
    expect(h.ports.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.ports.audit.mock.calls.map(([event]) => event.outcome)).toEqual(['attempt']);
});

test('session revocation during source I/O withholds the buffered result at the host', async () => {
    const h = await harness();
    h.ports.readAuthoritySnapshot.mockImplementation(async () => {
        await h.store.deleteSession(TOKEN);
        return h.observation;
    });
    privateError(await lookup(h), 401, 'dashboard_admin_authentication_required');
    expect(h.ports.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(h.ports.audit.mock.calls.map(([event]) => event.outcome)).toEqual(['attempt', 'found']);
});

test('policy revocation during source I/O withholds the result and starts no terminal audit', async () => {
    const h = await harness();
    h.ports.readAuthoritySnapshot.mockImplementation(async () => { h.state.allowed = false; return h.observation; });
    privateError(await lookup(h), 403, 'dashboard_admin_access_denied');
    expect(h.ports.audit.mock.calls.map(([event]) => event.outcome)).toEqual(['attempt']);
});

test('overlapping real requests retain their own private native read and audit context', async () => {
    const h = await harness(), seen = new Map(), entered = [];
    let release;
    const bothEntered = new Promise(resolve => { release = resolve; });
    const server = createServer((req, res) => { seen.set(req.headers['x-composition-test'], req); h.app(req, res); });
    h.ports.readAuthoritySnapshot.mockImplementation(async (_scope, _actor, selector, context) => {
        const label = context.request.headers['x-composition-test'];
        expect(context.request).toBeInstanceOf(IncomingMessage);
        expect(context.request).toBe(seen.get(label));
        expect(context.selector).toBe(selector);
        expect(Object.isFrozen(context)).toBe(true);
        entered.push(label);
        if (entered.length === 2) release();
        await bothEntered;
        expect(context.request).toBe(seen.get(label));
        return h.observation;
    });
    const results = await Promise.all([lookup(h, server, 'first'), lookup(h, server, 'second')]);
    expect(entered.sort()).toEqual(['first', 'second']);
    for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.body.result.status).toBe('found');
        expect(result.body.result.identity.subjectKey).toBe(TARGET);
        expect(result.text).not.toContain('x-composition-test');
    }
    for (const [event, context] of h.ports.audit.mock.calls) {
        const label = context.request.headers['x-composition-test'];
        expect(context.request).toBe(seen.get(label));
        expect(context.selector).toEqual(h.selector);
        expect(event).not.toHaveProperty('request');
        expect(event).not.toHaveProperty('selector');
    }
    expect(h.ports.audit).toHaveBeenCalledTimes(4);
    const ids = h.ports.audit.mock.calls.filter(([event]) => event.outcome === 'attempt').map(([event]) => event.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(h.pool.connect).not.toHaveBeenCalled();
});
