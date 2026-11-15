'use strict';
// Staff account reset/delete through the existing accounts/lookup route, and
// its production composition from settings. The executor is the real module;
// storage, database, Graph and audit are synthetic.
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createAccountWipeExecutor } = require('../api/shared/dashboardAdmin/accountWipeExecutor');
const { createAccountWipeRoute, sessionDigest } = require('../api/shared/dashboardAdmin/accountWipeRoute');
const { fixture } = require('./fixtures/dashboardAdminAccountActionsProduction');
const { createStaffDashboardAdministration } = require('../lib/dashboardAdminStaffProduction');
const { composeAccountWipe, createRetryMarkers, createRoleProbe, ROLE_PROBE } = require('../lib/dashboardAdminAccountWipeProduction');

const uid = n => '71000000-0000-4000-8000-' + String(n).padStart(12, '0');
const STAFF = uid(1) + ':' + uid(2), EMAIL = 'synthetic.owner@example.test', origin = 'https://operator.example.test';
const identity = { provider: 'entra-bff', isAuthenticated: true, subjectKey: STAFF, tenantId: uid(1), principalId: uid(2) };
const COOKIE = '__Host-nofries-auth=' + 's'.repeat(43);
const wire = (input, { cookie = COOKIE, site = 'same-origin' } = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method: 'POST', url: '/api/dashboard-admin/accounts/lookup',
    headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': site, cookie } });
let warning;
beforeEach(() => { jest.spyOn(console, 'info').mockImplementation(() => {}); warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic|@/); jest.restoreAllMocks(); });

function harness(options = {}, requestBudgetMs = 10000) {
    const flag = Object.hasOwn(options, 'flag') ? options.flag : 'true', admin = options.admin || STAFF;
    const records = [], lookupAudit = jest.fn(async () => {});
    const found = { account: { accountId: uid(10) }, subjectKey: uid(3) + ':' + uid(4), tenantIds: [uid(20)] };
    let current = found;
    const repository = { reset: jest.fn(async () => ({ counts: { a: 3 } })), delete: jest.fn(async () => ({ counts: { a: 3 } })) };
    const storage = { inventory: jest.fn(async () => current), delete: jest.fn(async () => { current = null; return { blobs: 2, versions: 0 }; }) };
    const remover = { remove: jest.fn(async () => ({ removed: true, alreadyGone: false })), check: jest.fn(async () => true) };
    const executor = createAccountWipeExecutor({ sources: [{ kind: 'external_starter', storage }], repository, identity: remover,
        legacyIndexConfigured: false, ensureRole: async () => {}, audit: async event => records.push(event), targetDigest: () => 'd'.repeat(64) });
    const service = { authorise: jest.fn(async actor => actor), capabilities: async () => ({}), lookup: async () => ({}) };
    const handler = createDashboardAdminHandlers({ service, readOperatorSession: async () => ({ identity }),
        accountLookupReader: { read: jest.fn(), list: jest.fn(), wipe: createAccountWipeRoute(executor), audit: lookupAudit, targetDigest: () => 'd'.repeat(64) },
        env: { NOFRIES_PUBLIC_URL: origin, NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: admin,
            NOFRIES_ADMIN_SUBJECTS: admin, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE: flag }, requestBudgetMs });
    return { handler, records, lookupAudit, repository, storage, remover, service };
}
const approve = (action, extra = {}) => ({ wipe: { step: 'approve', action, email: EMAIL, confirmEmail: EMAIL, confirmWord: action.toUpperCase(), ...extra } });
const execute = approvalId => ({ wipe: { step: 'execute', approvalId, email: EMAIL } });

test('approve then apply deletes through the lookup route, with no lookup record and the native gate checked', async () => {
    const h = harness();
    const approved = await h.handler.handle(wire(approve('delete')), 'accounts/lookup');
    expect(approved.status).toBe(200); expect(approved.body).toMatchObject({ action: 'delete', approvalId: expect.any(String), store: 'external' });
    const applied = await h.handler.handle(wire(execute(approved.body.approvalId)), 'accounts/lookup');
    expect(applied).toMatchObject({ status: 200, body: { outcome: 'succeeded', stages: { database: 'done', storage: 'done', identity: 'done' } } });
    expect(h.lookupAudit).not.toHaveBeenCalled();
    expect(h.records.map(r => r.phase)).toEqual(['approval', 'attempt', 'outcome']);
    expect(h.service.authorise).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: STAFF }), null);
});

test('applying waits past the read budget for the outcome and its record; a slow approval is still bounded', async () => {
    const h = harness({}, 40);
    const { body } = await h.handler.handle(wire(approve('delete')), 'accounts/lookup');
    h.storage.delete.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 120)); return { blobs: 1, versions: 0 }; });
    const applied = await h.handler.handle(wire(execute(body.approvalId)), 'accounts/lookup');
    expect(applied).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    expect(h.records.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'succeeded' });
    // The run deadline is handed to the database transaction.
    expect(h.repository.delete).toHaveBeenCalledWith(expect.any(Object), { signal: expect.any(AbortSignal), deadline: expect.any(Number) });
    // One 25 s budget for the whole apply; the stages end 3 s before it, for the outcome record.
    expect(h.repository.delete.mock.calls[0][1].deadline - Date.now()).toBeLessThanOrEqual(22000);
    h.storage.inventory.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 120)); return null; });
    expect((await h.handler.handle(wire(approve('reset')), 'accounts/lookup')).status).toBe(503);
});

test.each([undefined, '', 'false', 'TRUE'])('flag %p: a wipe body is answered 404 and nothing is read', async flag => {
    const h = harness({ flag });
    const result = await h.handler.handle(wire(approve('delete')), 'accounts/lookup');
    expect(result.status).toBe(404); expect(h.storage.inventory).not.toHaveBeenCalled();
    const capabilities = await h.handler.handle(Object.assign(Readable.from([]), { method: 'GET', url: '/api/dashboard-admin/entry-capabilities', headers: {} }), 'entry-capabilities');
    expect(capabilities.body).not.toHaveProperty('accountWipe');
});

test('flag on advertises the controls to the console', async () => {
    const h = harness();
    const result = await h.handler.handle(Object.assign(Readable.from([]), { method: 'GET', url: '/api/dashboard-admin/entry-capabilities', headers: {} }), 'entry-capabilities');
    expect(result.body).toMatchObject({ entry: true, accountWipe: true });
});

test('a cross-site request or a non-staff subject never reaches the executor', async () => {
    const h = harness();
    expect((await h.handler.handle(wire(approve('reset'), { site: 'cross-site' }), 'accounts/lookup')).status).toBe(403);
    const other = harness({ admin: uid(8) + ':' + uid(9) });
    expect((await other.handler.handle(wire(approve('reset')), 'accounts/lookup')).status).toBe(403);
    expect(h.storage.inventory).not.toHaveBeenCalled(); expect(other.storage.inventory).not.toHaveBeenCalled();
});

test('the approval is bound to the staff browser session cookie', async () => {
    const h = harness();
    const { body } = await h.handler.handle(wire(approve('reset')), 'accounts/lookup');
    const other = await h.handler.handle(wire(execute(body.approvalId), { cookie: '__Host-nofries-auth=' + 't'.repeat(43) }), 'accounts/lookup');
    expect(other).toMatchObject({ status: 403, body: { code: 'account_wipe_approval_invalid' } });
    expect(h.repository.reset).not.toHaveBeenCalled();
    expect((await h.handler.handle(wire(approve('reset'), { cookie: '' }), 'accounts/lookup')).body.code).toBe('account_wipe_approval_invalid');
});

test.each([
    [{ wipe: { step: 'approve', action: 'delete', email: EMAIL } }, 400, 'account_wipe_input_invalid'],
    [{ wipe: { step: 'other' } }, 400, 'account_wipe_input_invalid'],
    [approve('delete', { confirmWord: 'RESET' }), 400, 'account_wipe_confirmation_mismatch'],
    [{ wipe: approve('delete').wipe, email: EMAIL }, 400, 'dashboard_admin_account_lookup_400']
])('malformed body %# is refused with %s', async (input, status, code) => {
    const h = harness();
    expect(await h.handler.handle(wire(input), 'accounts/lookup')).toMatchObject({ status, body: { code } });
    expect(h.storage.delete).not.toHaveBeenCalled();
});

test('refusals are bounded codes the console can explain', async () => {
    const h = harness();
    h.storage.inventory.mockResolvedValueOnce(null);
    expect(await h.handler.handle(wire(approve('reset')), 'accounts/lookup')).toMatchObject({ status: 404, body: { code: 'account_wipe_account_not_found' } });
    h.storage.inventory.mockRejectedValueOnce(Object.assign(new Error('PRIVATE ' + EMAIL), { code: 'ECONNRESET' }));
    expect(await h.handler.handle(wire(approve('reset')), 'accounts/lookup')).toMatchObject({ status: 503, body: { code: 'account_wipe_unavailable' } });
});

test('every refusal on the route is recorded: executor refusals and malformed bodies alike, without the email', async () => {
    const h = harness();
    await h.handler.handle(wire(approve('delete', { confirmWord: 'NOPE' })), 'accounts/lookup');
    await h.handler.handle(wire({ wipe: { step: 'execute', approvalId: 'x', email: EMAIL } }), 'accounts/lookup');
    await h.handler.handle(wire({ wipe: { step: 'other', email: EMAIL } }), 'accounts/lookup');
    await h.handler.handle(wire(approve('reset'), { cookie: '' }), 'accounts/lookup');
    expect(h.records.map(r => [r.phase, r.code])).toEqual([
        ['approval_refused', 'account_wipe_confirmation_mismatch'], ['execute_refused', 'account_wipe_approval_invalid'],
        ['execute_refused', 'account_wipe_input_invalid'], ['approval_refused', 'account_wipe_approval_invalid']]);
    expect(h.records.every(r => r.targetSha256 === 'd'.repeat(64))).toBe(true);
    expect(JSON.stringify(h.records)).not.toContain(EMAIL);
});

test.each([['account_wipe_role_unavailable'], ['account_wipe_identity_unavailable']])('%s is a 503 service fault, not a refusal', async code => {
    const h = harness();
    h.remover.check.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_unavailable' }));
    const route = createAccountWipeRoute({ approve: async () => { throw Object.assign(new Error('x'), { code }); }, execute: jest.fn(), refused: jest.fn() });
    expect(await route(approve('delete').wipe, { subjectKey: STAFF }, { headers: { cookie: COOKIE } }, new AbortController().signal))
        .toEqual({ status: 503, body: { code } });
    if (code === 'account_wipe_identity_unavailable')
        expect(await h.handler.handle(wire(approve('delete')), 'accounts/lookup')).toMatchObject({ status: 503, body: { code } });
});

test('session digest needs exactly one staff session cookie', () => {
    expect(sessionDigest(COOKIE)).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionDigest('other=1; ' + COOKIE)).toBe(sessionDigest(COOKIE));
    expect(sessionDigest(COOKIE + '; ' + COOKIE)).toBeNull();
    expect(sessionDigest('__Host-nofries-customer=' + 's'.repeat(43))).toBeNull();
    expect(sessionDigest('__Host-nofries-auth=short')).toBeNull();
});

describe('production composition', () => {
    test('flag off (or suspend/restore off) composes no wipe port', () => {
        for (const env of [{}, { NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE: 'false' }, { NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'false' }]) {
            const h = fixture(); Object.assign(h.env, env);
            expect(createStaffDashboardAdministration(h.env, h.dashboard, h.sdk).dashboardAdminAccountLookup).not.toHaveProperty('wipe');
        }
        expect(warning).not.toHaveBeenCalled();
    });

    test('flag on composes the wipe route without reading or writing anything', () => {
        const h = fixture(); h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE = 'true';
        const ports = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk);
        expect(ports.dashboardAdminAccountLookup.wipe).toEqual(expect.any(Function));
        expect(ports).toHaveProperty('dashboardAdminAccountActions');
        expect(h.reads).toEqual([]); expect(h.writes).toEqual([]); expect(warning).not.toHaveBeenCalled();
    });

    test('a noncanonical flag leaves lookup, suspend and restore running', () => {
        const h = fixture(); h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE = 'TRUE';
        const ports = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk);
        expect(ports.dashboardAdminAccountLookup).not.toHaveProperty('wipe'); expect(ports).toHaveProperty('dashboardAdminAccountActions');
        expect(warning).toHaveBeenCalledWith('[dashboard-admin-account-wipe] dashboard_admin_unavailable');
    });

    function compose(env = {}, pool = null) {
        const containers = [];
        const service = { getContainerClient: name => { containers.push(name); return { getBlobClient() {}, listBlobsFlat() {}, getBlockBlobClient() {} }; } };
        const settings = { sources: [{ kind: 'legacy_admin', container: 'a' }, { kind: 'legacy_starter', container: 'b' }, { kind: 'external_starter', container: 'c' }],
            identityClientId: null, targetDigest: () => 'd'.repeat(64) };
        const route = composeAccountWipe({ env: { NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(5), ...env }, settings,
            pool: pool || { connect: async () => ({ query: async () => ({ rows: [{ ok: true }] }), release() {} }) },
            services: { storage: service, auth: service }, auditContainer: {},
            dependencies: { ManagedIdentityCredential: class {}, ClientAssertionCredential: class {} }, log: message => warning(message) });
        return { route, containers };
    }
    const request = { headers: { cookie: COOKIE } }, actor = { subjectKey: STAFF };

    test('uses both starter containers and the browser-auth container, never the legacy admin store', () => {
        expect(compose().containers).toEqual(['nofries-browser-auth', 'b', 'c']);
    });

    test('without Graph settings delete is refused before any read; partial Graph settings log one line', async () => {
        const { route } = compose();
        expect(await route(approve('delete').wipe, actor, request, new AbortController().signal)).toMatchObject({ status: 503, body: { code: 'account_wipe_identity_not_configured' } });
        compose({ NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: uid(5) });
        expect(warning).toHaveBeenCalledWith('[dashboard-admin-account-wipe] account_wipe_identity_configuration_invalid');
        warning.mockClear();
    });

    test.each(['NOFRIES_DASHBOARD_ADMIN_BINDING', 'NOFRIES_DASHBOARD_ADMIN_ENABLED'])('%s set refuses delete', async key => {
        const { route } = compose({ [key]: 'true', NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: uid(5), NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID: uid(6) });
        expect((await route(approve('delete').wipe, actor, request, new AbortController().signal)).body.code).toBe('account_wipe_legacy_index_configured');
    });

    test('retry markers are overwritten in place under a digest name and read back; a missing one is null', async () => {
        const rows = new Map(), writes = [];
        const container = { getBlockBlobClient: key => ({
            async uploadData(bytes, options) { writes.push({ key, conditions: options.conditions }); rows.set(key, Buffer.from(bytes)); return { etag: '"m"' }; },
            async download() {
                if (!rows.has(key)) throw Object.assign(new Error('missing'), { statusCode: 404 });
                return { contentLength: rows.get(key).length, etag: '"m"', readableStreamBody: Readable.from([rows.get(key)]) };
            } }) };
        const markers = createRetryMarkers(container), digest = 'e'.repeat(64);
        expect(await markers.read(digest)).toBeNull();
        await markers.write(digest, { databaseDone: true });
        expect(writes).toEqual([{ key: `dashboard-admin-account-wipes/retry/${digest}.json`, conditions: {} }]);
        expect(await markers.read(digest)).toEqual({ databaseDone: true });
        await expect(markers.read('not-a-digest')).rejects.toThrow();
    });

    test('a stalled connection wait for the role probe ends at the deadline; a late connection is released as broken', async () => {
        const released = []; let deliver;
        const pool = { connect: () => new Promise(resolve => { deliver = () => resolve({ query: async () => ({ rows: [{ ok: true }] }), release: discard => released.push(discard) }); }) };
        await expect(createRoleProbe(pool)({ deadline: Date.now() + 30 })).rejects.toThrow();
        deliver(); await new Promise(resolve => setImmediate(resolve));
        expect(released).toEqual([true]);
    });

    test('the role probe runs with statement_timeout no larger than the time left, and a stalled probe is discarded', async () => {
        const seen = [], released = [];
        const pool = { connect: async () => ({ query: async (sql, params) => { seen.push([sql, params]);
            if (sql === ROLE_PROBE) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
            return { rows: [] }; }, release: discard => released.push(discard) }) };
        await expect(createRoleProbe(pool)({ deadline: Date.now() + 2000 })).rejects.toThrow();
        expect(Number(seen[1][1][0])).toBeLessThanOrEqual(2000); expect(released).toEqual([true]);
        expect(seen.at(-1)[0]).toBe('ROLLBACK');
    });

    test('a login that cannot SET the wipe role is refused with a clear code', async () => {
        const queries = [];
        const pool = { connect: async () => ({ query: async sql => { queries.push(sql); return { rows: [{ ok: false }] }; }, release() {} }) };
        const { route } = compose({}, pool);
        expect((await route(approve('reset').wipe, actor, request, new AbortController().signal)).body.code).toBe('account_wipe_role_unavailable');
        expect(queries).toEqual(['BEGIN', "SELECT set_config('statement_timeout', $1, true)", ROLE_PROBE, 'COMMIT']);
    });
});
