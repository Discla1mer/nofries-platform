'use strict';

// Staff suspend then restore through the actual production launcher: HTTP
// handlers, staff capture, native operator gate, settings-only composition,
// source selection, membership action, approvals and audit records are real.
// Only SDK/SQL transports and the canonical membership repository (PostgreSQL
// locks and RLS are covered by the native suites) are synthetic.
jest.mock('../api/shared/dashboardAdmin/accountActionsRepository', () => ({ createAccountActionsRepository: jest.fn() }));
const { createAccountActionsRepository } = require('../api/shared/dashboardAdmin/accountActionsRepository');
const { fixture } = require('./fixtures/dashboardAdminAccountActionsProduction');
const { fixture: dashboardFixture, SUBJECT } = require('./fixtures/dashboardFixture');
const { NOW } = require('./fixtures/dashboardAdminEntrySession');
const { hash, canonical } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataCodec, dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { verifyRestore } = require('../api/shared/dashboardAdmin/accountActionsProvenance');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const clone = value => JSON.parse(JSON.stringify(value)), iso = new Date(NOW).toISOString();
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic|@/); warning.mockRestore(); });

function host() {
    const h = fixture('external_starter'), f = dashboardFixture({ now: iso });
    h.env.NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID = SUBJECT.slice(0, 36);
    const record = { ...h.record, subjectKey: SUBJECT, ...f.scope, expiresAt: NOW + 86400000 };
    h.bucket('syntheticdata', 'external-signups').clear();
    const subjectPath = `customer-subjects/${subjectHash(SUBJECT)}.json`;
    h.bucket('syntheticdata', 'external-signups').set(subjectPath, { bytes: Buffer.from(canonical(record)), etag: '"initial"' });
    const selector = { provider: 'external', subjectKey: SUBJECT, ...f.scope };
    const state = { committed: 0, receipts: new Map(), snapshot: { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState,
        entitlementState: f.entitlementState, flags: f.flags, advisorAssignments: [], usage: f.entitlementState.grants.map(dataCodec.newUsage) } };
    const tx = { async query(sql, p) {
        if (sql.startsWith('INSERT')) { state.receipts.set(p[2], { tenant_id: p[0], organisation_id: p[1], operation_id: p[2],
            schema_version: 1, intent_sha256: p[3], result_sha256: p[4], payload: JSON.parse(p[5]) }); return { rowCount: 1 }; }
        return { rows: sql.includes('ORDER BY') ? [...state.receipts.values()].reverse().slice(0, 101) : [state.receipts.get(p[2])].filter(Boolean) };
    } };
    createAccountActionsRepository.mockImplementation((_pool, clock, guard, allowed, context) => ({
        verifyRestore: (target, snapshot, read) => verifyRestore(tx, target, snapshot, { instanceId: context.instanceId, restoreEpoch: context.restoreEpoch }, read, clock()),
        async readAuthoritySnapshot() { await guard(); return { snapshot: clone(state.snapshot), revisions: dataCodec.revisionVector(state.snapshot), evaluatedAt: clock() }; },
        async executeAuthorityCommand(command) {
            await guard(); if (!allowed(command)) throw new Error('PRIVATE_NOT_ALLOWED');
            if (hash(command.expectedRevisions) !== hash(dataCodec.revisionVector(state.snapshot))) throw Object.assign(new Error(), { statusCode: 409 });
            const membershipState = applyMembershipCommand(state.snapshot.membershipState, state.snapshot.tenantAggregate,
                { ...f.scope, actorSubjectKey: command.actorSubjectKey, now: clock(), expectedRevision: command.expectedRevisions.membership, ...command.payload });
            await guard(); state.snapshot.membershipState = membershipState; state.committed++;
            return dataStorage.saveOperationReceipt(tx, command, hash({ command, initialState: null }), state.snapshot, clock());
        } }));
    return { ...h, f, record, selector, subjectPath, state };
}
const post = (h, app, cookie, route, input) => h.send('post', '/api/dashboard-admin/' + route, app).set('Cookie', cookie)
    .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(input);
const member = h => h.state.snapshot.membershipState.memberships.find(row => row.subjectKey === SUBJECT);
async function signedIn(h) {
    const app = h.build(), { cookie } = await h.login(app);
    expect((await h.send('post', '/api/dashboard/session', app).set('Cookie', cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL)
        .set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
    return { app, cookie };
}

test('staff suspend then restore succeeds end to end with session-bound approvals and attempt/terminal audit records', async () => {
    const h = host(), { app, cookie } = await signedIn(h), before = clone(h.state.snapshot);
    for (const [action, from, to] of [['suspend', 'active', 'suspended'], ['restore', 'suspended', 'active']]) {
        const input = { selector: h.selector, confirmationEmail: h.record.email, expectedMembershipRevision: h.state.snapshot.membershipState.revision };
        const approved = await post(h, app, cookie, 'approve-' + action, input);
        expect(approved.status).toBe(200);
        expect(approved.body).toMatchObject({ action, membershipStatus: from, expectedMembershipRevision: input.expectedMembershipRevision, operationId: expect.any(String) });
        expect(Date.parse(approved.body.approvalExpiresAt) - NOW).toBe(900000);
        expect(member(h).status).toBe(from);
        const done = await post(h, app, cookie, action, { ...input, operationId: approved.body.operationId });
        expect(done.status).toBe(200); expect(done.body).toEqual({ operationId: approved.body.operationId, outcome: 'succeeded' });
        expect(member(h).status).toBe(to);
        const audit = h.bucket('syntheticdata', 'account-action-audit'), prefix = `dashboard-admin-account-actions/${approved.body.operationId}/`;
        const read = name => JSON.parse(audit.get(prefix + name).bytes);
        expect([...audit.keys()].filter(key => key.startsWith(prefix)).sort()).toEqual(['approval-attempt.json', 'approval-terminal.json', 'approval.json', 'attempt.json', 'terminal.json'].map(name => prefix + name));
        expect(read('terminal.json')).toMatchObject({ phase: 'terminal', outcome: 'succeeded', action, before: { status: from }, after: { status: to } });
        expect(read('approval-terminal.json')).toMatchObject({ outcome: 'succeeded', action: 'approve-' + action });
        // A consumed operation cannot be replayed.
        expect((await post(h, app, cookie, action, { ...input, operationId: approved.body.operationId })).status).not.toBe(200);
    }
    expect(h.state.committed).toBe(2);
    const { membershipState, ...rest } = h.state.snapshot, { membershipState: original, ...unchanged } = before;
    expect(rest).toEqual(unchanged); expect(membershipState.revision).toBe(original.revision + 2);
    // Customer authority is never written or deleted by membership actions.
    expect(h.writes.filter(row => row.name !== 'account-action-audit' && row.account === 'syntheticdata')).toEqual([]);
    expect(JSON.parse(h.bucket('syntheticdata', 'external-signups').get(h.subjectPath).bytes)).toEqual(h.record);
});
test.each(['approve-extension', 'extend-expired-access'])('removed %s does not exist: no route, runtime action, customer read, audit or write', async route => {
    const h = host(), { app, cookie } = await signedIn(h); h.reads.length = 0; h.writes.length = 0;
    const input = { selector: h.selector, confirmationEmail: h.record.email, newExpiresAt: new Date(NOW + 86400000).toISOString(),
        ...(route === 'extend-expired-access' ? { operationId: h.nextId() } : {}) };
    for (const session of [cookie, '']) {
        const result = await post(h, app, session, route, input);
        expect(result.status).toBe(404); expect(result.body).toEqual({ code: 'dashboard_admin_not_found' });
    }
    const { createStaffDashboardAdministration } = require('../lib/dashboardAdminStaffProduction');
    const { createAccountActionsRuntime } = require('../api/shared/dashboardAdmin/accountActionsRuntime');
    const configuration = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk).dashboardAdminAccountActions;
    const runtime = createAccountActionsRuntime(configuration, h.dashboard, async () => { throw new Error('PRIVATE_MUST_NOT_AUTHORISE'); });
    expect(Object.keys(runtime)).toEqual(['execute']);
    await expect(runtime.execute({ subjectKey: 'x' }, input, { signal: new AbortController().signal }, route)).rejects.toMatchObject({ statusCode: 403 });
    for (const extra of [{ expiry: false }, { readApprovedExtension: async () => null }]) {
        expect(() => createAccountActionsRuntime({ ...configuration, ...extra }, h.dashboard, async () => {})).toThrow();
    }
    expect(h.reads.filter(row => row.account === 'syntheticdata')).toEqual([]); expect(h.writes).toEqual([]);
    expect(h.state.committed).toBe(0);
});
test('a malformed legacy listing locator cannot stop the host or the console and is reported in one safe line', async () => {
    const h = host(); h.env.NOFRIES_DASHBOARD_ADMIN_BINDING = '{'; h.env.NOFRIES_DASHBOARD_ADMIN_ENABLED = 'true';
    let app; expect(() => { app = h.build(); }).not.toThrow();
    expect(warning.mock.calls).toEqual([['[dashboard-admin-account-actions] dashboard_admin_unavailable']]);
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    const { cookie } = await h.login(app);
    expect((await h.send('get', '/api/dashboard-admin/entry-capabilities', app).set('Cookie', cookie)).body).toEqual({ entry: true, accountActions: true });
});
test('the composed action configuration is deeply frozen and carries only sources, audit container and audit policy', () => {
    const h = host(), { createStaffDashboardAdministration } = require('../lib/dashboardAdminStaffProduction');
    const configuration = createStaffDashboardAdministration(h.env, h.dashboard, h.sdk).dashboardAdminAccountActions;
    expect(Object.keys(configuration).sort()).toEqual(['auditContainer', 'auditPolicy', 'sources']);
    for (const value of [configuration, configuration.sources, ...configuration.sources, ...configuration.sources.map(row => row.source), configuration.auditPolicy, configuration.auditPolicy.retention])
        expect(Object.isFrozen(value)).toBe(true);
    expect(() => { 'use strict'; configuration.readApprovedAction = async () => ({}); }).toThrow(TypeError);
    expect(() => { 'use strict'; configuration.sources.push({}); }).toThrow(TypeError);
});
