'use strict';
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const { readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const f = require('./fixtures/dashboardAdminSignupFixture');
const token = Buffer.alloc(32, 8).toString('base64url'), cookie = '__Host-nofries-auth=' + token;
function wire({ route = 'signups', method = route === 'signups' ? 'POST' : 'GET', body = method === 'POST' ? { cursor: null } : undefined, headers = {} } = {}) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    request.method = method; request.url = request.originalUrl = '/api/dashboard-admin/' + route;
    request.headers = { cookie, ...(method === 'POST' ? { 'content-type': 'application/json', origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin' } : {}), ...headers };
    return request;
}
async function harness() {
    const state = { grant: f.grant() };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid', NOFRIES_ENTRA_TENANT_ID: f.TENANT,
        NOFRIES_ENTRA_CLIENT_ID: f.uid(9), NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-only', NOFRIES_ALLOWED_SUBJECTS: f.ACTOR, NOFRIES_ADMIN_SUBJECTS: f.ACTOR };
    const identity = { ...f.principal, tenantId: f.TENANT, principalId: f.uid(3), email: 'operator@example.invalid', name: 'Synthetic' };
    const record = { v: 1, kind: 'browser_session', issuedAt: Date.parse(f.NOW) - 60000,
        idleExpiresAt: Date.parse(f.NOW) + 60000, absoluteExpiresAt: Date.parse(f.NOW) + 600000, identity };
    const store = new MemoryBrowserSessionStore(); await store.createSession(token, record);
    const readOperatorSession = jest.fn(header => readBrowserSessionDetails(header, { env, store, now: () => Date.parse(f.NOW) }));
    const ports = { authoriseSignupList: jest.fn(async () => state.grant), readSignupPage: jest.fn(async () => f.page()),
        audit: jest.fn(async event => f.ack(event)), clock: () => f.NOW };
    const signupListService = createSignupListService(ports);
    const options = { signupListService, readOperatorSession, env };
    const handler = createDashboardAdminHandlers(options);
    return { state, env, store, identity, record, ports, options, handler, readOperatorSession, signupListService };
}
const run = (h, options) => h.handler.handle(wire(options), options?.route || 'signups');
describe('native signup queue HTTP boundary', () => {
    test('queue-only operator receives protected shell/capability/actual result without lookup grant', async () => {
        const h = await harness();
        expect((await run(h, { route: 'capabilities' })).body).toEqual({ lookup: false, recovery: [], signupList: true });
        const doc = await run(h, { route: 'document' }); expect(doc.status).toBe(200); expect(doc.body).toContain('signupQueueLoad');
        const asset = await run(h, { route: 'app.js' }); expect(asset.body).toContain('signupQueueLoad'); expect(asset.body).toContain('adminLookupForm');
        const result = await run(h); expect(result.status).toBe(200); expect(result.body.rows[0].email).toBe('person1@example.invalid');
        expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
        expect(JSON.stringify(result.body)).not.toContain('operatorSubjectKey');
        expect((await run(h, { route: 'lookup', method: 'POST' })).status).toBe(503);
    });
    test('exact-person diagnostic permission cannot confer listing', async () => {
        const h = await harness(); h.state.grant = false;
        const service = { authorise: async () => true, capabilities: async () => ({ lookup: true, recovery: [] }), lookup: async () => ({}) };
        h.handler = createDashboardAdminHandlers({ ...h.options, service });
        expect((await run(h, { route: 'capabilities' })).body).toEqual({ lookup: true, recovery: [], signupList: false });
        expect((await run(h)).status).toBe(403); expect(h.ports.readSignupPage).not.toHaveBeenCalled();
    });
    test.each(['', '__Host-nofries-customer=' + token, '__Host-nofries-external-customer=' + token])('rejects anonymous/customer cookie %s', async value => {
        const h = await harness(); expect((await run(h, { headers: { cookie: value, 'x-ms-client-principal': 'forged', 'x-nofries-role': 'admin' } })).status).toBe(401);
        expect(h.ports.authoriseSignupList).not.toHaveBeenCalled();
    });
    test.each(['consultant', 'development', 'foreign-provider', 'forged-subject'])('rejects %s even with permissive listing policy', async kind => {
        const h = await harness();
        if (kind === 'consultant') h.env.NOFRIES_ADMIN_SUBJECTS = f.TENANT + ':' + f.uid(99);
        if (kind === 'development') h.env.NOFRIES_REQUIRE_AUTH = 'false';
        if (kind === 'foreign-provider') h.readOperatorSession.mockResolvedValue({ identity: { ...h.identity, provider: 'external-customer' } });
        if (kind === 'forged-subject') h.readOperatorSession.mockResolvedValue({ identity: { ...h.identity, subjectKey: f.TENANT + ':' + f.uid(99) } });
        expect((await run(h)).status).toBe(403); expect(h.ports.authoriseSignupList).not.toHaveBeenCalled();
    });
    test.each(['session', 'role', 'allowlist', 'authority'])('revocation of %s during read withholds buffer', async kind => {
        const h = await harness(); h.ports.readSignupPage.mockImplementation(async () => {
            if (kind === 'session') await h.store.deleteSession(token);
            if (kind === 'role') h.env.NOFRIES_ADMIN_SUBJECTS = f.TENANT + ':' + f.uid(99);
            if (kind === 'allowlist') h.env.NOFRIES_ALLOWED_SUBJECTS = f.TENANT + ':' + f.uid(99);
            if (kind === 'authority') h.state.grant = false;
            return f.page();
        });
        const result = await run(h); expect([401, 403]).toContain(result.status); expect(JSON.stringify(result.body)).not.toContain('person1');
    });
    test.each(['populationId', 'provider', 'tenantId', 'authorityRevision'])('final native check changing valid %s cannot disclose previous population', async key => {
        const h = await harness(); const original = h.readOperatorSession.getMockImplementation(); let calls = 0;
        h.readOperatorSession.mockImplementation(async header => { const value = await original(header); if (++calls === 3) {
            h.state.grant = { ...h.state.grant, [key]: key === 'authorityRevision' ? 2 : key === 'provider' ? 'external' : 'other' };
        } return value; });
        const result = await run(h); expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain('person1');
    });
    test.each([
        [{ method: 'GET' }, 405], [{ body: { cursor: null, email: 'a@example.invalid' } }, 400],
        [{ headers: { origin: 'https://foreign.invalid' } }, 403], [{ headers: { 'content-type': 'text/plain' } }, 415],
        [{ body: '{"broken"' }, 400], [{ body: 'x'.repeat(2049) }, 413], [{ headers: { 'content-encoding': 'gzip' } }, 415]
    ])('strict wire boundary %p', async (options, code) => {
        const h = await harness(); expect((await run(h, options)).status).toBe(code); expect(h.ports.readSignupPage).not.toHaveBeenCalled();
    });
    test('audit exceptions never expose provider details', async () => {
        const h = await harness(); h.ports.audit.mockRejectedValue(new Error('PRIVATE_DATABASE_DIAGNOSTIC'));
        const result = await run(h); expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'dashboard_admin_unavailable' });
    });
    test('dormant default cannot reach any listing path', async () => {
        const handler = createDashboardAdminHandlers();
        expect((await handler.handle(wire(), 'signups')).status).toBe(503);
    });
});

test('timed-out diagnostic fallback cannot start a signup authority port later', async () => {
    const h = await harness();
    const service = { authorise: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 35)), capabilities: async () => ({}), lookup: async () => ({}) };
    const handler = createDashboardAdminHandlers({ ...h.options, service, requestBudgetMs: 10 });
    expect((await handler.handle(wire({ route: 'document' }), 'document')).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 45)); expect(h.ports.authoriseSignupList).not.toHaveBeenCalled();
});
