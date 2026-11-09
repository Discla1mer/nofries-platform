'use strict';
const { fixture } = require('./fixtures/dashboardAdminAccountActionsProduction');
const { createBoundDashboardAdministration } = require('../lib/dashboardAdminBindings');
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic|@/); warning.mockRestore(); });
const post = (h, app, cookie, route, input) => h.send('post', '/api/dashboard-admin/' + route, app).set('Cookie', cookie)
    .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(input);
test.each(['legacy_admin', 'legacy_starter', 'external_starter'])('bound production %s source issues and consumes a protected extension approval', async kind => {
    const h = fixture(kind), app = h.build();
    expect(h.sdk).not.toHaveProperty('dashboardAdministration'); expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    const { cookie } = await h.login(app);
    expect((await h.send('post', '/api/dashboard/session', app).set('Cookie', cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL)
        .set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
    const approved = await post(h, app, cookie, 'approve-extension', h.input); expect(approved.status).toBe(200);
    const result = await post(h, app, cookie, 'extend-expired-access', { ...h.input, operationId: approved.body.operationId });
    expect(result.status).toBe(200); expect(result.body.outcome).toBe('succeeded');
    const saved = JSON.parse(h.bucket('syntheticdata', h.sourceName).get(h.subjectPath).bytes);
    expect(saved).toEqual({ ...h.record, revision: 1, expiresAt: Date.parse(h.input.newExpiresAt) });
    const audit = h.bucket('syntheticdata', 'account-action-audit');
    expect([...audit.values()].map(row => JSON.parse(row.bytes)).filter(row => row.phase === 'terminal').map(row => row.outcome)).toEqual(['succeeded', 'succeeded']);
    expect(h.writes.filter(row => row.key.startsWith('customer-subjects/'))).toEqual([{ account: 'syntheticdata', name: h.sourceName, key: h.subjectPath }]);
    expect(warning).not.toHaveBeenCalled();
});
test('bound actions use one-attempt managed-identity clients and the built-in membership issuer configuration', () => {
    const h = fixture(); h.env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID = '85000000-0000-4000-8000-000000000050';
    const ports = createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null), actions = ports.dashboardAdminAccountActions;
    expect(actions.sources.map(row => row.source.kind)).toEqual(['legacy_admin', 'legacy_starter', 'external_starter']);
    expect(actions.sources.every(row => row.authorityContainer.pipeline.options.retryOptions.maxTries === 1)).toBe(true);
    expect(actions.auditContainer.pipeline.options.retryOptions.maxTries).toBe(1);
    expect(actions).not.toHaveProperty('readApprovedExtension'); expect(actions).not.toHaveProperty('readApprovedAction');
    expect(actions.auditPolicy.retention).toEqual({ unit: 'calendar_months', count: 13 });
    expect(ports.dashboardAdmin.authoriseOperator).toEqual(expect.any(Function));
    expect(h.sdk.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: h.env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID });
});
test.each([undefined, '', 'false', 'TRUE', '1'])('actions flag %s remains default-off without constructing action clients', value => {
    const h = fixture(); h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = value;
    const ports = createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null);
    expect(ports).not.toHaveProperty('dashboardAdminAccountActions');
    expect(h.clients.some(row => row.options.retryOptions.maxTries === 1)).toBe(false); expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
});
test.each(['missing audit', 'bad audit', 'customer-authority', 'legacy-signups', 'external-signups', 'nofries-browser-auth',
    'dashboard-proofs', 'dashboard-epochs', 'private-approvals', 'missing source', 'duplicate source', 'bad tenant'])
('invalid %s configuration keeps the production host running with no actions', mode => {
    const h = fixture();
    if (mode === 'missing audit') delete h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER;
    else if (mode === 'bad audit') h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER = '../unsafe';
    else if (mode === 'missing source') delete h.env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER;
    else if (mode === 'duplicate source') h.env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER = h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER;
    else if (mode === 'bad tenant') h.env.NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID = 'bad-tenant';
    else h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER = mode;
    expect(() => h.build()).not.toThrow();
    const ports = createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null);
    expect(ports).not.toHaveProperty('dashboardAdminAccountActions'); expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    expect(warning.mock.calls.every(([line]) => line === '[dashboard-admin-account-actions] dashboard_admin_unavailable')).toBe(true);
});
test.each(['missing grant', 'wrong scope', 'duplicate authority'])('%s refuses before a customer write', async mode => {
    const h = fixture(), app = h.build(), { cookie } = await h.login(app);
    expect((await h.send('post', '/api/dashboard/session', app).set('Cookie', cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL)
        .set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
    if (mode === 'missing grant') h.bucket('syntheticdata', 'private-approvals').clear();
    if (mode === 'wrong scope') h.input.selector = { ...h.selector, organisationId: 'different-org' };
    if (mode === 'duplicate authority') h.put('legacy-signups', h.subjectPath, h.record);
    h.reads.length = 0;
    expect((await post(h, app, cookie, 'approve-extension', h.input)).status).toBe(403);
    if (mode !== 'duplicate authority') expect(h.reads.some(row => row.key.startsWith('customer-subjects/'))).toBe(false);
    expect(h.writes.some(row => row.key.startsWith('customer-subjects/'))).toBe(false);
});

test.each(['NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER'])('missing %s fails closed without stopping the host', setting => {
    const h = fixture(); delete h.env[setting]; expect(() => h.build()).not.toThrow();
    expect(createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null)).not.toHaveProperty('dashboardAdminAccountActions');
});
test.each(['disabled', 'anonymous', 'nonstaff', 'origin'])('production %s guard prevents every action write', async mode => {
    const h = fixture();
    if (mode === 'disabled') h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = 'false';
    if (mode === 'nonstaff') h.env.NOFRIES_ADMIN_SUBJECTS = '';
    const app = h.build(), { cookie } = await h.login(app);
    h.writes.length = 0;
    const req = post(h, app, mode === 'anonymous' ? '' : cookie, 'approve-extension', h.input);
    if (mode === 'origin') req.set('Origin', 'https://other.invalid');
    expect((await req).status).toBe(mode === 'disabled' ? 404 : mode === 'anonymous' ? 401 : 403);
    expect(h.writes).toEqual([]); expect(h.reads.some(row => row.key.startsWith('customer-subjects/'))).toBe(false);
});

test('the optional actions binder refuses an invalid shared managed-identity selector', () => {
    const h = fixture(); h.env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID = 'bad-identity';
    expect(createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null)).not.toHaveProperty('dashboardAdminAccountActions');
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
});

test.each(['suspend', 'restore', 'approve-suspend', 'approve-restore', 'extend-expired-access'])('bound source selection forwards the explicit %s action', async action => {
    const h = fixture(), configuration = createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null).dashboardAdminAccountActions;
    const execute = jest.fn(async () => ({ outcome: 'synthetic-dispatch' }));
    const authorise = jest.fn(async () => { expect(h.reads).toEqual([]); });
    const runtime = require('../api/shared/dashboardAdmin/accountActionsSources').createAccountActionsSources(
        configuration, h.dashboard, authorise, value => ({ execute: (...args) => execute(value.source.kind, ...args), approve: jest.fn() }));
    const actor = { subjectKey: 'synthetic-actor' }, invocation = { signal: new AbortController().signal };
    await runtime.execute(actor, h.input, invocation, action);
    expect(authorise).toHaveBeenCalledWith(actor, h.selector);
    expect(execute).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledWith('legacy_admin', actor, h.input, invocation, action);
    h.reads.length = 0;
    await expect(runtime.execute(actor, h.input, invocation)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.reads).toEqual([]); expect(execute).toHaveBeenCalledTimes(1);
});
test.each(['missing client', 'constructor failure', 'getter', 'missing binding'])('%s disables optional actions without startup I/O', mode => {
    const h = fixture();
    if (mode === 'missing client') h.sdk.BlobServiceClient = null;
    if (mode === 'constructor failure') h.sdk.ManagedIdentityCredential = class { constructor() { throw new Error('PRIVATE_SDK'); } };
    if (mode === 'getter') Object.defineProperty(h.env, 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER', { get() { throw new Error('PRIVATE_GETTER'); } });
    if (mode === 'missing binding') delete h.env.NOFRIES_DASHBOARD_ADMIN_BINDING;
    expect(createBoundDashboardAdministration(h.env, h.dashboard, h.sdk, null)).not.toHaveProperty('dashboardAdminAccountActions');
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
});
