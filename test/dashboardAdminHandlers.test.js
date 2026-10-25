'use strict';

const { Readable } = require('node:stream');
const { createServer, IncomingMessage } = require('node:http');
const request = require('supertest');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createDashboardAdminService, DashboardAdminError } = require('../api/shared/dashboardAdmin/service');
const { readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');

const uid = n => '70000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), ACTOR = uid(2), CLIENT = uid(3), NOW = Date.parse('2026-10-18T22:00:00.000Z');
const SUBJECT = TENANT + ':' + ACTOR;
const SESSION = Buffer.alloc(32, 7).toString('base64url');
const SELECTOR = { provider: 'legacy', subjectKey: TENANT + ':' + uid(4), tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' };
const cookie = '__Host-nofries-auth=' + SESSION;

function wire({ method = 'GET', route = 'capabilities', body, headers = {}, url } = {}) {
    const bytes = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = Readable.from(bytes);
    req.method = method;
    req.originalUrl = req.url = url || (route === 'document' ? '/dashboard-admin' : '/api/dashboard-admin/' + route);
    req.headers = { cookie, ...(method === 'POST' ? { 'content-type': 'application/json', origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin' } : {}), ...headers };
    return req;
}

async function harness() {
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-dashboard-admin-test-secret',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: SUBJECT };
    const identity = { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT, principalId: ACTOR,
        subjectKey: SUBJECT, name: 'Synthetic operator', email: 'operator@example.invalid' };
    const record = { v: 1, kind: 'browser_session', issuedAt: NOW - 60000,
        idleExpiresAt: NOW + 60000, absoluteExpiresAt: NOW + 600000, identity };
    const store = new MemoryBrowserSessionStore();
    await store.createSession(SESSION, record);
    const readOperatorSession = jest.fn(header => readBrowserSessionDetails(header, { env, store, now: () => NOW }));
    const state = { allowed: true };
    const service = { authorise: jest.fn(async actor => {
        if (!state.allowed) throw new DashboardAdminError(403, 'dashboard_admin_access_denied');
        return actor;
    }), capabilities: jest.fn(async () => ({ lookup: true, recovery: [] })),
    lookup: jest.fn(async () => ({ result: { status: 'found', privateTestSentinel: 'BUFFERED_RESULT_MUST_BE_WITHHELD_ON_REVOCATION' } })) };
    const handler = createDashboardAdminHandlers({ service, readOperatorSession, env });
    return { env, identity, record, store, state, service, readOperatorSession, handler };
}

function expectPrivate(result, status, code) {
    expect(result.status).toBe(status);
    if (code) expect(result.body).toEqual({ code });
    expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    expect(result.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE_PROVIDER_DETAIL');
}

describe('dashboard administration HTTP boundary with genuine BFF record validation', () => {
    test('binds exact lookup actor to staff session and rechecks session and scoped policy before release', async () => {
        const h = await harness();
        const result = await h.handler.handle(wire({ method: 'POST', route: 'lookup', body: SELECTOR,
            headers: { 'x-nofries-subject': SELECTOR.subjectKey, 'x-ms-client-principal': 'forged' } }), 'lookup');
        expectPrivate(result, 200);
        expect(h.readOperatorSession).toHaveBeenCalledTimes(3);
        const actor = { provider: 'entra-bff', isAuthenticated: true, subjectKey: SUBJECT, tenantId: TENANT, principalId: ACTOR };
        expect(h.service.lookup).toHaveBeenCalledWith(actor, SELECTOR);
        expect(h.service.authorise).toHaveBeenLastCalledWith(actor, SELECTOR);
    });

    test.each(['', '__Host-nofries-customer=' + SESSION, '__Host-nofries-external-customer=' + SESSION])('customer/anonymous cookie %s never reaches authority service', async header => {
        const h = await harness();
        const result = await h.handler.handle(wire({ headers: { cookie: header, 'x-ms-client-principal': 'forged' } }), 'capabilities');
        expectPrivate(result, 401, 'dashboard_admin_authentication_required');
        expect(h.service.authorise).not.toHaveBeenCalled();
        expect(h.service.lookup).not.toHaveBeenCalled();
    });

    test('customer record transplanted into staff cookie namespace is rejected by genuine BFF reader', async () => {
        const h = await harness();
        await h.store.deleteSession(SESSION);
        await h.store.createSession(SESSION, { ...h.record, customerAssurance: { stage: 'verified' } });
        expectPrivate(await h.handler.handle(wire(), 'capabilities'), 401, 'dashboard_admin_authentication_required');
        expect(h.service.authorise).not.toHaveBeenCalled();
    });

    test('consultant remains denied even when trusted policy would permit and role header claims admin', async () => {
        const h = await harness();
        h.env.NOFRIES_ADMIN_SUBJECTS = TENANT + ':' + uid(8);
        expectPrivate(await h.handler.handle(wire({ headers: { 'x-nofries-role': 'admin' } }), 'capabilities'), 403, 'dashboard_admin_access_denied');
        expect(h.service.authorise).not.toHaveBeenCalled();
    });

    test('local development identity cannot substitute for immutable staff BFF identity', async () => {
        const h = await harness();
        const readOperatorSession = jest.fn(async () => ({ identity: { ...h.identity, provider: 'email' } }));
        const handler = createDashboardAdminHandlers({ service: h.service, readOperatorSession, env: h.env });
        expectPrivate(await handler.handle(wire(), 'capabilities'), 403, 'dashboard_admin_access_denied');
        expect(h.service.capabilities).not.toHaveBeenCalled();
    });

    test('local development role defaults and duplicate staff cookies cannot establish operator access', async () => {
        const h = await harness();
        h.env.NOFRIES_REQUIRE_AUTH = 'false';
        expectPrivate(await h.handler.handle(wire(), 'capabilities'), 403, 'dashboard_admin_access_denied');
        h.env.NOFRIES_REQUIRE_AUTH = 'true';
        expectPrivate(await h.handler.handle(wire({ headers: { cookie: cookie + '; ' + cookie } }), 'capabilities'), 401, 'dashboard_admin_authentication_required');
        expect(h.service.authorise).not.toHaveBeenCalled();
    });

    test.each(['session', 'allowed-subject', 'admin-role', 'operator-policy', 'different-actor'])('withholds buffered result after %s is revoked or changed during lookup', async mode => {
        const h = await harness();
        h.service.lookup.mockImplementation(async () => {
            if (mode === 'session') await h.store.deleteSession(SESSION);
            if (mode === 'allowed-subject') h.env.NOFRIES_ALLOWED_SUBJECTS = TENANT + ':' + uid(9);
            if (mode === 'admin-role') h.env.NOFRIES_ADMIN_SUBJECTS = TENANT + ':' + uid(9);
            if (mode === 'operator-policy') h.state.allowed = false;
            if (mode === 'different-actor') {
                const other = { ...h.identity, principalId: uid(9), subjectKey: TENANT + ':' + uid(9) };
                h.env.NOFRIES_ALLOWED_SUBJECTS += ',' + other.subjectKey;
                h.env.NOFRIES_ADMIN_SUBJECTS += ',' + other.subjectKey;
                await h.store.deleteSession(SESSION);
                await h.store.createSession(SESSION, { ...h.record, identity: other });
            }
            return { result: 'BUFFERED_RESULT_MUST_BE_WITHHELD_ON_REVOCATION' };
        });
        const result = await h.handler.handle(wire({ method: 'POST', route: 'lookup', body: SELECTOR }), 'lookup');
        expectPrivate(result, ['session', 'allowed-subject'].includes(mode) ? 401 : 403,
            ['session', 'allowed-subject'].includes(mode) ? 'dashboard_admin_authentication_required' : 'dashboard_admin_access_denied');
        expect(JSON.stringify(result.body)).not.toContain('BUFFERED_RESULT');
    });

    test('expired staff parent and store failure are distinct, sanitized failures', async () => {
        const h = await harness();
        await h.store.deleteSession(SESSION);
        await h.store.createSession(SESSION, { ...h.record, idleExpiresAt: NOW - 1 });
        expectPrivate(await h.handler.handle(wire(), 'capabilities'), 401, 'dashboard_admin_authentication_required');
        h.store.loadSession = async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); };
        expectPrivate(await h.handler.handle(wire(), 'capabilities'), 503, 'dashboard_admin_unavailable');
    });

    test('explicit policy denial defeats ordinary admin and missing reader truthfully disables lookup', async () => {
        const h = await harness();
        const policy = jest.fn(async () => false);
        const service = createDashboardAdminService({ authoriseOperator: policy, readAuthoritySnapshot: null,
            audit: async () => true, clock: () => new Date(NOW).toISOString(), requestBudgetMs: 1000 });
        const handler = createDashboardAdminHandlers({ service, readOperatorSession: h.readOperatorSession, env: h.env });
        expectPrivate(await handler.handle(wire(), 'capabilities'), 403, 'dashboard_admin_access_denied');
        policy.mockResolvedValue(true);
        const result = await handler.handle(wire(), 'capabilities');
        expectPrivate(result, 200);
        expect(result.body).toEqual({ lookup: false, recovery: [] });
        expectPrivate(await handler.handle(wire({ method: 'POST', route: 'lookup', body: SELECTOR }), 'lookup'), 503, 'dashboard_admin_unavailable');
    });

    test.each(['document', 'app.js', 'app.css'])('protects %s using both current session and explicit policy', async route => {
        const h = await harness();
        const result = await h.handler.handle(wire({ route }), route);
        expectPrivate(result, 200);
        expect(result.isRaw).toBe(true);
        expect(typeof result.body).toBe('string');
        expect(h.readOperatorSession).toHaveBeenCalledTimes(2);
        expect(h.service.authorise).toHaveBeenCalledTimes(2);
        if (route === 'document') expect(result.headers['Content-Security-Policy']).toContain("script-src 'self'");
        h.state.allowed = false;
        expectPrivate(await h.handler.handle(wire({ route }), route), 403, 'dashboard_admin_access_denied');
    });

    test.each([
        [{ origin: 'https://other.invalid' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403],
        [{ origin: '' }, 403], [{ 'sec-fetch-site': '' }, 403],
        [{ 'content-type': 'text/plain' }, 415], [{ 'content-encoding': 'gzip' }, 415],
        [{ 'content-length': '2049' }, 413]
    ])('rejects unsupported/cross-origin wire contract %p', async (headers, status) => {
        const h = await harness();
        expectPrivate(await h.handler.handle(wire({ method: 'POST', route: 'lookup', body: SELECTOR, headers }), 'lookup'), status);
        expect(h.service.lookup).not.toHaveBeenCalled();
    });

    test.each(['{broken', 'x'.repeat(2049), Buffer.from([0xff]), { ...SELECTOR, actor: SUBJECT }, { ...SELECTOR, query: '*' }])('rejects malformed/oversized/nonexact input without read', async body => {
        const h = await harness();
        expectPrivate(await h.handler.handle(wire({ method: 'POST', route: 'lookup', body }), 'lookup'), typeof body === 'string' && body.length > 2048 ? 413 : 400);
        expect(h.service.lookup).not.toHaveBeenCalled();
    });

    test('refuses query strings, unsupported methods/routes and bodies on GET', async () => {
        const h = await harness();
        expectPrivate(await h.handler.handle(wire({ url: '/api/dashboard-admin/capabilities?subjectKey=forged' }), 'capabilities'), 400);
        const method = await h.handler.handle(wire({ method: 'POST' }), 'capabilities');
        expectPrivate(method, 405); expect(method.headers.Allow).toBe('GET');
        expectPrivate(await h.handler.handle(wire(), 'list-users'), 404);
        expectPrivate(await h.handler.handle(wire({ headers: { 'content-length': '1' } }), 'capabilities'), 400);
        expect(h.service.lookup).not.toHaveBeenCalled();
    });

    test('timeout withholds output and prevents a late policy from starting lookup', async () => {
        const h = await harness();
        let finish;
        h.service.authorise.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const handler = createDashboardAdminHandlers({ service: h.service, readOperatorSession: h.readOperatorSession, env: h.env, requestBudgetMs: 10 });
        expectPrivate(await handler.handle(wire({ method: 'POST', route: 'lookup', body: SELECTOR }), 'lookup'), 503, 'dashboard_admin_unavailable');
        finish();
        await new Promise(resolve => setImmediate(resolve));
        expect(h.service.lookup).not.toHaveBeenCalled();
    });

    test('incomplete body expires with handler budget and releases parser listeners without source work', async () => {
        const h = await harness();
        const handler = createDashboardAdminHandlers({ service: h.service, readOperatorSession: h.readOperatorSession, env: h.env, requestBudgetMs: 10 });
        const req = new Readable({ read() {} });
        Object.assign(req, { method: 'POST', originalUrl: '/api/dashboard-admin/lookup', headers: wire({ method: 'POST' }).headers });
        req.push(Buffer.from('{'));
        expectPrivate(await handler.handle(req, 'lookup'), 503, 'dashboard_admin_unavailable');
        expect(req.listenerCount('data')).toBe(0);
        req.push(null);
        expect(h.service.lookup).not.toHaveBeenCalled();
    });
});

describe('dashboard administration Node/Express integration', () => {
    test('default app exposes neither assets nor lookup without explicit trusted composition', async () => {
        const app = require('../server').createNoFriesApp();
        for (const route of ['/dashboard-admin', '/api/dashboard-admin/app.js', '/api/dashboard-admin/app.css', '/api/dashboard-admin/capabilities']) {
            const result = await request(app).get(route).set('X-MS-Client-Principal', 'forged');
            expect(result.status).toBe(503);
            expect(result.body).toEqual({ code: 'dashboard_admin_unavailable' });
            expect(result.headers['cache-control']).toBe('private, no-store, max-age=0');
        }
    });

    test('rejects explicit admin composition without genuine dashboard authentication', () => {
        expect(() => require('../server').createNoFriesApp({ dashboardAdmin: {
            authoriseOperator: async () => true, readAuthoritySnapshot: null, audit: async () => true,
            clock: () => new Date(NOW).toISOString(), requestBudgetMs: 1000
        } })).toThrow(expect.objectContaining({ statusCode: 503, code: 'browser_auth_dashboard_unavailable' }));
    });

    test('installed routes use real staff cookie, private assets and bounded body parsing before shared middleware', async () => {
        const h = await harness();
        const instanceId = uid(10), epoch = uid(11);
        const unavailablePool = { connect: jest.fn(async () => { throw new Error('not used by admin session'); }), end: jest.fn() };
        const dashboard = { browserAuthOptions: { env: h.env, store: h.store },
            identityPolicy: { policyId: 'synthetic-admin-policy', policyRevision: 1,
                issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
            proofStore: { createOriginalProof: async () => {}, readOriginalProof: async () => null },
            clock: () => new Date(NOW).toISOString(), readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch: epoch }),
            newRequestId: () => uid(12), requestBudgetMs: 1000, pool: unavailablePool, instanceId,
            historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
            newId: () => uid(13), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => uid(14) };
        const nativeRequests = new Map();
        const policy = jest.fn(async input => {
            expect(Object.isFrozen(input)).toBe(true);
            expect(input.request).toBeInstanceOf(IncomingMessage);
            expect(input.request).toBe(nativeRequests.get(input.request.headers['x-admin-test-request']));
            return true;
        });
        const app = require('../server').createNoFriesApp({ dashboard, dashboardAdmin: {
            authoriseOperator: policy, readAuthoritySnapshot: null, audit: async () => true,
            clock: dashboard.clock, requestBudgetMs: 1000
        } });
        const server = createServer((req, res) => {
            nativeRequests.set(req.headers['x-admin-test-request'], req);
            app(req, res);
        });
        const capability = await request(server).get('/api/dashboard-admin/capabilities').set('Cookie', cookie).set('X-Admin-Test-Request', 'capabilities');
        expect(capability.status).toBe(200);
        expect(capability.body).toEqual({ lookup: false, recovery: [] });
        const document = await request(server).get('/dashboard-admin').set('Cookie', cookie).set('X-Admin-Test-Request', 'document');
        expect(document.status).toBe(200);
        expect(document.text).toContain('Dashboard administration');
        expect(document.headers['content-security-policy']).toContain("script-src 'self'");
        const oversized = await request(server).post('/api/dashboard-admin/lookup').set('Cookie', cookie).set('X-Admin-Test-Request', 'oversized')
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').set('Content-Type', 'application/json').send('x'.repeat(2049));
        expect(oversized.status).toBe(413);
        expect(oversized.body).toEqual({ code: 'dashboard_admin_request_too_large' });
        expect(unavailablePool.connect).not.toHaveBeenCalled();
        expect(policy).toHaveBeenCalledWith({ principal: { provider: 'entra-bff', isAuthenticated: true, subjectKey: SUBJECT }, selector: null,
            request: nativeRequests.get('capabilities') });
        expect(JSON.stringify(capability.body)).not.toContain('request');
        const beforeSynthetic = policy.mock.calls.length;
        const adminLayer = app._router.stack.find(layer => !layer.route && layer.regexp.toString().includes('api\\/dashboard-admin'));
        expect(adminLayer).toBeDefined();
        const synthetic = wire(); synthetic.path = '/capabilities';
        const denied = await new Promise((resolve, reject) => {
            const res = Object.assign(new (require('node:events').EventEmitter)(), { destroyed: false, writableEnded: false, setHeader() {},
                status(status) { this.statusCode = status; return this; },
                json(body) { resolve({ status: this.statusCode, body }); } });
            adminLayer.handle(synthetic, res, reject);
        });
        expect(denied).toEqual({ status: 403, body: { code: 'dashboard_admin_access_denied' } });
        expect(policy).toHaveBeenCalledTimes(beforeSynthetic);
        const absentComposition = require('../server').createNoFriesApp({ dashboard });
        const absent = await request(absentComposition).get('/api/dashboard-admin/capabilities').set('Cookie', cookie);
        expect(absent.status).toBe(503);
        expect(absent.body).toEqual({ code: 'dashboard_admin_unavailable' });

        // The opt-in reader and writer get the same native request and the
        // service's exact frozen target, without adding them to the HTTP event.
        const reader = jest.fn(async () => null), audit = jest.fn(async () => true);
        const boundApp = require('../server').createNoFriesApp({ dashboard, dashboardAdmin: {
            authoriseOperator: policy, readAuthoritySnapshot: reader, audit,
            clock: dashboard.clock, requestBudgetMs: 1000
        } });
        const boundServer = createServer((req, res) => {
            nativeRequests.set(req.headers['x-admin-test-request'], req);
            boundApp(req, res);
        });
        const lookup = await request(boundServer).post('/api/dashboard-admin/lookup')
            .set('Cookie', cookie).set('X-Admin-Test-Request', 'lookup')
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
            .send(SELECTOR);
        expect(lookup.status).toBe(200);
        expect(lookup.body.result.status).toBe('unavailable');
        expect(reader).toHaveBeenCalledTimes(1);
        expect(audit.mock.calls.map(([event]) => event.outcome)).toEqual(['attempt', 'unavailable']);
        const seen = nativeRequests.get('lookup');
        const selected = reader.mock.calls[0][2];
        expect(selected).toEqual(SELECTOR);
        expect(Object.isFrozen(selected)).toBe(true);
        const readContext = reader.mock.calls[0][3];
        expect(readContext).toEqual({ request: seen, selector: selected });
        expect(Object.isFrozen(readContext)).toBe(true);
        for (const [event, context] of audit.mock.calls) {
            expect(context).toEqual({ request: seen, selector: selected });
            expect(Object.isFrozen(context)).toBe(true);
            expect(event).not.toHaveProperty('request');
            expect(event).not.toHaveProperty('selector');
        }
        expect(JSON.stringify(lookup.body)).not.toContain('x-admin-test-request');
    });
});
