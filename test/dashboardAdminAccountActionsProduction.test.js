'use strict';

// The actual launcher, HTTP handlers, staff capture, native gate and action
// runtime run here from settings alone. Only SDK and SQL transports are synthetic.
const { fixture } = require('./fixtures/dashboardAdminAccountActionsProduction');
const { createStaffDashboardAdministration, readStaffActionSettings, readStaffAdminSettings } = require('../lib/dashboardAdminStaffProduction');
const { createProductionDashboardAdministration } = require('../lib/dashboardAdminProduction');
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic|@/); warning.mockRestore(); });
const post = (h, app, cookie, route, input) => h.send('post', '/api/dashboard-admin/' + route, app).set('Cookie', cookie)
    .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(input);
const openSession = async (h, app, cookie) => expect((await h.send('post', '/api/dashboard/session', app).set('Cookie', cookie)
    .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
const membership = (h, selector = h.selector) => ({ selector, confirmationEmail: h.record.email, expectedMembershipRevision: 0 });

test('settings alone compose one-attempt managed-identity action clients, the audit container and the built-in approval issuers', () => {
    const h = fixture(); h.env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID = '85000000-0000-4000-8000-000000000050';
    const ports = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk), actions = ports.dashboardAdminAccountActions;
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountActions', 'dashboardAdminAccountLookup']);
    expect(actions.sources.map(row => row.source.kind)).toEqual(['legacy_admin', 'legacy_starter', 'external_starter']);
    expect(actions.sources.every(row => row.authorityContainer.pipeline.options.retryOptions.maxTries === 1)).toBe(true);
    expect(actions.auditContainer.pipeline.options.retryOptions.maxTries).toBe(1);
    expect(actions.auditContainer.url).toBe('https://syntheticdata.blob.core.windows.net/account-action-audit');
    expect(actions).not.toHaveProperty('readApprovedExtension'); expect(actions).not.toHaveProperty('readApprovedAction');
    expect(actions.auditPolicy.retention).toEqual({ unit: 'calendar_months', count: 13 });
    expect(h.sdk.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: h.env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID });
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]); expect(warning).not.toHaveBeenCalled();
    expect(Object.keys(createProductionDashboardAdministration(h.env, h.dashboard, h.sdk, null)).sort()).toEqual(Object.keys(ports).sort());
});
test.each([undefined, '', 'false'])('actions flag %p remains default-off while lookup stays composed', value => {
    const h = fixture(); h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = value;
    expect(readStaffActionSettings(h.env, readStaffAdminSettings(h.env))).toBe(false);
    const ports = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk);
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountLookup']); expect(warning).not.toHaveBeenCalled();
});
test.each(['TRUE', '1'])('noncanonical actions flag %p fails closed', value => {
    const h = fixture(); h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = value;
    expect(createStaffDashboardAdministration(h.env, h.dashboard, h.sdk)).not.toHaveProperty('dashboardAdminAccountActions');
    expect(warning).toHaveBeenCalledWith('[dashboard-admin-account-actions] dashboard_admin_unavailable');
});
test.each(['NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER'])
('a missing %s keeps the host and read-only console running with no actions', setting => {
    const h = fixture(); delete h.env[setting];
    expect(() => h.build()).not.toThrow();
    const ports = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk);
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountLookup']);
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    expect(warning.mock.calls).toEqual([['[dashboard-admin-account-actions] dashboard_admin_unavailable'], ['[dashboard-admin-account-actions] dashboard_admin_unavailable']]);
});
test.each(['missing audit', 'bad audit', 'legacy-signups', 'dashboard-proofs'])('invalid %s audit configuration disables the whole console', mode => {
    const h = fixture();
    if (mode === 'missing audit') delete h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER;
    else if (mode === 'bad audit') h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER = '../unsafe';
    else h.env.NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER = mode;
    expect(() => h.build()).not.toThrow();
    expect(createStaffDashboardAdministration(h.env, h.dashboard, h.sdk)).toEqual({});
    expect(warning.mock.calls.every(([line]) => line === '[dashboard-admin] dashboard_admin_configuration_invalid')).toBe(true);
});
test.each(['legacy_admin', 'legacy_starter', 'external_starter'])('production %s source refuses to approve or execute without a current membership and writes nothing to the customer', async kind => {
    const h = fixture(kind), app = h.build();
    expect(h.sdk).not.toHaveProperty('dashboardAdministration'); expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    const { cookie } = await h.login(app); await openSession(h, app, cookie);
    const entry = await h.send('get', '/api/dashboard-admin/entry-capabilities', app).set('Cookie', cookie);
    expect(entry.status).toBe(200); expect(entry.body).toEqual({ entry: true, accountActions: true });
    // Approval needs the exact current membership; this synthetic organisation
    // has no PostgreSQL membership rows, so the approval is refused after reading
    // the subject record, with attempt/terminal audit and no customer write.
    const approved = await post(h, app, cookie, 'approve-suspend', membership(h));
    expect([403, 409, 503]).toContain(approved.status); expect(approved.body).toEqual({ code: expect.stringMatching(/^dashboard_admin_/) });
    expect(h.reads.some(row => row.key === h.subjectPath && row.name === h.sourceName)).toBe(true);
    const audit = [...h.bucket('syntheticdata', 'account-action-audit').keys()];
    expect(audit.every(key => /^dashboard-admin-account-actions\/[0-9a-f-]{36}\/approval-(attempt|terminal)\.json$/.test(key))).toBe(true);
    const executed = await post(h, app, cookie, 'suspend', { ...membership(h), operationId: h.nextId() });
    expect(executed.status).toBe(403);
    expect(h.writes.filter(row => row.key.startsWith('customer-subjects/'))).toEqual([]);
    expect(warning.mock.calls.every(([line]) => /^\[dashboard-admin-account-actions\] dashboard_admin_/.test(line))).toBe(true);
});
test.each(['wrong scope', 'duplicate authority', 'wrong email'])('%s refuses before any customer write', async mode => {
    const h = fixture(), app = h.build(), { cookie } = await h.login(app); await openSession(h, app, cookie);
    const input = membership(h);
    if (mode === 'wrong scope') input.selector = { ...h.selector, organisationId: 'different-org' };
    if (mode === 'duplicate authority') h.put('legacy-signups', h.subjectPath, h.record);
    if (mode === 'wrong email') input.confirmationEmail = 'someone-else@example.invalid';
    h.reads.length = 0;
    expect([400, 403]).toContain((await post(h, app, cookie, 'approve-suspend', input)).status);
    expect(h.writes.filter(row => row.account === 'syntheticdata' && row.key.startsWith('customer-subjects/'))).toEqual([]);
});
test.each(['disabled', 'anonymous', 'nonstaff', 'origin', 'no native session'])('production %s guard prevents every action write', async mode => {
    const h = fixture();
    if (mode === 'disabled') h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = 'false';
    if (mode === 'nonstaff') h.env.NOFRIES_ADMIN_SUBJECTS = '';
    const app = h.build(), { cookie } = await h.login(app);
    if (!['disabled', 'no native session'].includes(mode)) await openSession(h, app, cookie);
    h.writes.length = 0;
    for (const route of ['approve-suspend', 'approve-restore', 'suspend', 'restore']) {
        const req = post(h, app, mode === 'anonymous' ? '' : cookie, route, { ...membership(h), ...(route.startsWith('approve') ? {} : { operationId: h.nextId() }) });
        if (mode === 'origin') req.set('Origin', 'https://other.invalid');
        expect((await req).status).toBe(mode === 'disabled' ? 404 : mode === 'anonymous' ? 401 : 403);
    }
    expect(h.writes.filter(row => row.account === 'syntheticdata')).toEqual([]);
    expect(h.reads.some(row => row.key.startsWith('customer-subjects/'))).toBe(false);
    if (mode === 'disabled') expect((await h.send('get', '/api/dashboard-admin/entry-capabilities', app).set('Cookie', cookie)).body).toEqual({ entry: true });
});
test.each(['missing client', 'constructor failure', 'getter'])('%s disables the console without startup I/O', mode => {
    const h = fixture();
    if (mode === 'missing client') h.sdk.BlobServiceClient = null;
    if (mode === 'constructor failure') h.sdk.ManagedIdentityCredential = class { constructor() { throw new Error('PRIVATE_SDK'); } };
    if (mode === 'getter') Object.defineProperty(h.env, 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER', { get() { throw new Error('PRIVATE_GETTER'); } });
    expect(createStaffDashboardAdministration(h.env, h.dashboard, h.sdk)).not.toHaveProperty('dashboardAdminAccountActions');
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
});
