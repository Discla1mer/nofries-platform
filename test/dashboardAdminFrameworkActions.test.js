'use strict';

const { createFrameworkAction } = require('../api/shared/dashboardAdmin/frameworkActions');
const { tuples } = require('../api/shared/appLifecycle/paidFrameworkDecisions');
const { fixture, actor, clone, NOW } = require('./fixtures/dashboardAdminMembershipActions');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');

function staff() {
    const h = fixture(), uploaded = [];
    const { readApprovedAction, ...config } = h.config;
    const container = config.auditContainer;
    config.auditContainer = { url: container.url, getBlockBlobClient: key => {
        const blob = container.getBlockBlobClient(key);
        return { download: () => blob.download(), uploadData: (bytes, options) => {
            uploaded.push(Buffer.from(bytes).toString('utf8')); return blob.uploadData(bytes, options);
        } };
    } };
    const witness = { productGrantId: 'synthetic-product', agreementRef: 'synthetic-terms', revision: 0, granted: false };
    const change = jest.fn(async (command, approval) => approval ? { revision: 1, granted: command.action === 'grant' } : witness);
    const run = createFrameworkAction({ ...config, createRepository: guard => ({ async frameworkDecision(...args) {
        await guard(); return change(...args);
    } }) });
    const input = { selector: h.selector, confirmationEmail: h.record.email, expectedMembershipRevision: 2,
        reason: 'Synthetic purchase confirmed', action: 'grant', tuple: tuples[0], step: 'approve' };
    return { ...h, change, input, uploaded, call: patch => run(actor, { ...input, ...patch }, { request: {}, signal: new AbortController().signal }) };
}
test('create-only approval, attempt and outcome bind the staff identity, exact scope, tuple and reason', async () => {
    const h = staff(), { operationId } = await h.call({});
    const apply = { step: 'apply', operationId };
    await expect(h.call(apply)).resolves.toMatchObject({ granted: true, revision: 1 });
    const records = [...h.state.rows.values()];
    expect(records).toHaveLength(3);
    for (const r of records) expect(r.command).toMatchObject({ actorSubjectKey: actor.subjectKey, selector: h.selector,
        tuple: tuples[0], reasonSha256: hash(h.input.reason), reasonLength: h.input.reason.length, action: 'grant', operationId });
    await expect(h.call(apply)).rejects.toBeDefined();
    expect(h.change).toHaveBeenCalledTimes(2);
});
test.each([['succeeded', null], ['refused', 409], ['uncertain', 500], ['not_applied', 503]])(
    'audit blobs carry only the reason digest the database stores (%s)', async (outcome, status) => {
        const h = staff(), reason = 'Synthetic distinctive reason 7f3a', { operationId } = await h.call({ reason });
        if (status) h.change.mockImplementationOnce(async () => { throw Object.assign(new DashboardAdminError(status, 'dashboard_admin_x'),
            status === 503 ? { notApplied: 'operator_capability_unbound' } : {}); });
        const applied = h.call({ reason, step: 'apply', operationId });
        if (status) await expect(applied).rejects.toMatchObject({ statusCode: status }); else await applied;
        expect(h.uploaded).toHaveLength(3);
        for (const text of [...h.uploaded, ...[...h.state.rows.values()].map(row => JSON.stringify(row))]) {
            expect(text).not.toContain(reason);
            expect(text).not.toContain('Synthetic distinctive');
        }
        for (const row of h.state.rows.values()) {
            expect(row.command).not.toHaveProperty('reason');
            expect(row.command).toMatchObject({ reasonSha256: hash(reason), reasonLength: reason.length });
        }
        expect([...h.state.rows.entries()].find(([key]) => key.endsWith('outcome.json'))[1].outcome).toBe(outcome);
    });
test('an unbound operator capability is audited as a deterministic not_applied outcome', async () => {
    const h = staff(), { operationId } = await h.call({});
    h.change.mockImplementationOnce(async () => { throw Object.assign(new DashboardAdminError(503, 'dashboard_admin_unavailable'),
        { notApplied: 'operator_capability_unbound' }); });
    await expect(h.call({ step: 'apply', operationId })).rejects.toMatchObject({ statusCode: 503, code: 'dashboard_admin_unavailable' });
    const outcome = h.state.rows.get('dashboard-admin-framework-access/' + operationId + '/outcome.json');
    expect(outcome).toMatchObject({ outcome: 'not_applied', code: 'operator_capability_unbound' });
    // Any other unavailable failure stays uncertain and carries no code.
    const other = staff(), second = await other.call({});
    other.change.mockImplementationOnce(async () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); });
    await expect(other.call({ step: 'apply', operationId: second.operationId })).rejects.toMatchObject({ statusCode: 503 });
    const uncertain = other.state.rows.get('dashboard-admin-framework-access/' + second.operationId + '/outcome.json');
    expect(uncertain.outcome).toBe('uncertain');
    expect(uncertain).not.toHaveProperty('code');
});
test('a changed reason cannot apply an approval because the digests differ', async () => {
    const h = staff(), { operationId } = await h.call({});
    await expect(h.call({ step: 'apply', operationId, reason: 'Synthetic purchase confirmed!' })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.change).toHaveBeenCalledTimes(1);
});
test.each([{ tuple: { ...tuples[0], version: 'future' } }, { tuple: { ...tuples[0], moduleId: 'overview' } },
    { reason: '  ' }, { reason: '' }, { action: 'restore' }, { confirmationEmail: 'wrong@example.test' }])('refuses invalid approval %j', async patch => {
    const h = staff();
    await expect(h.call(patch)).rejects.toBeDefined();
    expect(h.change).not.toHaveBeenCalled();
});
test.each([{ tuple: tuples[1] }, { action: 'revoke' }, { reason: 'Different approval' }])('apply refuses changed authority %j', async patch => {
    const h = staff(), { operationId } = await h.call({});
    await expect(h.call({ step: 'apply', operationId, ...patch })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.change).toHaveBeenCalledTimes(1);
});
test('a changed staff session and an unavailable attempt audit each prevent the write', async () => {
    const h = staff(), { operationId } = await h.call({}), apply = { step: 'apply', operationId };
    h.config.readContext.mockResolvedValue({ ...h.context, sessionSha256: 'a'.repeat(64) });
    await expect(h.call(apply)).rejects.toMatchObject({ statusCode: 403 });
    h.config.readContext.mockResolvedValue(clone(h.context)); h.state.fail = 'attempt.json';
    await expect(h.call(apply)).rejects.toBeDefined(); expect(h.change).toHaveBeenCalledTimes(1);
});

test.each([
    ['off', 404], ['case', 404], ['account-actions-off', 404], ['nonstaff', 403], ['anonymous', 401],
    ['origin', 403], ['allowed', 200]
])('existing staff endpoint checks %s before dispatching a paid change', async (mode, expected) => {
    const { Readable } = require('node:stream');
    const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
    const h = staff(), env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://actions.invalid',
        NOFRIES_ENTRA_TENANT_ID: actor.subjectKey.slice(0, 36), NOFRIES_ALLOWED_SUBJECTS: actor.subjectKey,
        NOFRIES_ADMIN_SUBJECTS: mode === 'nonstaff' ? '' : actor.subjectKey,
        NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: mode === 'account-actions-off' ? 'false' : 'true',
        NOFRIES_PAID_FRAMEWORKS_ENABLED: mode === 'case' ? 'TRUE' : mode === 'off' ? '' : 'true' };
    const execute = jest.fn(() => ({ outcome: 'succeeded' })), authorise = jest.fn();
    const handler = createDashboardAdminHandlers({ env, accountActions: { execute }, service: { authorise, lookup: jest.fn(), capabilities: jest.fn() },
        readOperatorSession: async () => ({ identity: mode === 'anonymous' ? null :
            { ...actor, tenantId: actor.subjectKey.slice(0,36), principalId: actor.subjectKey.slice(37) } }) });
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ frameworkAccess: h.input }))]), {
        method: 'POST', headers: { 'content-type': 'application/json', origin: mode === 'origin' ? 'https://other.invalid' : env.NOFRIES_PUBLIC_URL,
            'sec-fetch-site': 'same-origin' } });
    expect((await handler.handle(req, 'lookup')).status).toBe(expected);
    expect(execute).toHaveBeenCalledTimes(mode === 'allowed' ? 1 : 0);
    if (expected === 200) expect(authorise).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: actor.subjectKey }), h.input.selector);
});

test.each([['on', 'true', 1], ['off', '', 0]])('framework-access failures log category, status and code only (%s)', async (_, flag, lines) => {
    const { Readable } = require('node:stream');
    const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
    const h = staff(), env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://actions.invalid',
        NOFRIES_ENTRA_TENANT_ID: actor.subjectKey.slice(0, 36), NOFRIES_ALLOWED_SUBJECTS: actor.subjectKey,
        NOFRIES_ADMIN_SUBJECTS: actor.subjectKey, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'true', NOFRIES_PAID_FRAMEWORKS_ENABLED: flag };
    const execute = jest.fn(async () => { throw Object.assign(new DashboardAdminError(503, 'dashboard_admin_unavailable'),
        { notApplied: 'operator_capability_unbound' }); });
    const handler = createDashboardAdminHandlers({ env, accountActions: { execute }, service: { authorise: jest.fn(), lookup: jest.fn(), capabilities: jest.fn() },
        readOperatorSession: async () => ({ identity: { ...actor, tenantId: actor.subjectKey.slice(0, 36), principalId: actor.subjectKey.slice(37) } }) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ frameworkAccess: h.input }))]), {
            method: 'POST', headers: { 'content-type': 'application/json', origin: env.NOFRIES_PUBLIC_URL, 'sec-fetch-site': 'same-origin' } });
        expect((await handler.handle(req, 'lookup')).status).toBe(flag ? 503 : 404);
        expect(warn.mock.calls).toEqual(lines ? [['[dashboard-admin-account-actions] framework-access 503 dashboard_admin_unavailable']] : []);
        const logged = JSON.stringify(warn.mock.calls);
        for (const value of [h.input.reason, h.record.email, h.selector.subjectKey, h.selector.organisationId]) expect(logged).not.toContain(value);
    } finally { warn.mockRestore(); }
});
