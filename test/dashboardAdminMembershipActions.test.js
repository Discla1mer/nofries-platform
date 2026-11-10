'use strict';

const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { resolveActiveMembership } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture, actor, uid, clone, NOW, SUBJECT } = require('./fixtures/dashboardAdminMembershipActions');

test('durable membership success survives revocation after its terminal audit', async () => {
    const h = fixture(), get = h.config.auditContainer.getBlockBlobClient;
    h.config.auditContainer.getBlockBlobClient = key => {
        const blob = get(key), upload = blob.uploadData;
        return { ...blob, async uploadData(...args) {
            const result = await upload(...args);
            if (key.endsWith('terminal.json')) h.config.readContext.mockRejectedValue(new Error('PRIVATE_REVOKED'));
            return result;
        } };
    };
    await expect(h.run('suspend')).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(h.state.committed).toBe(1);
    expect([...h.state.rows].find(([key, row]) => key.endsWith('/terminal.json') && row.action === 'suspend')[1].outcome).toBe('succeeded');
});
test('a delayed terminal audit must finish before a suspension reports success', async () => {
    const h = fixture(), get = h.config.auditContainer.getBlockBlobClient;
    let release, reached;
    const pending = new Promise(resolve => { reached = resolve; });
    h.config.auditContainer.getBlockBlobClient = key => {
        const blob = get(key), upload = blob.uploadData;
        return { ...blob, async uploadData(...args) {
            if (key.endsWith('/terminal.json')) { reached(); await new Promise(resolve => { release = resolve; }); }
            return upload(...args);
        } };
    };
    let complete = false;
    const result = h.run('suspend').then(() => { complete = true; });
    await pending; expect(h.state.committed).toBe(1); expect(complete).toBe(false);
    release(); await result; expect(complete).toBe(true);
});

test('suspend blocks only scoped admission; restore preserves all data and returns access', async () => {
    const h = fixture(), before = clone(h.state.snapshot);
    await h.run('suspend');
    expect(() => resolveActiveMembership(h.state.snapshot.membershipState, h.f.tenantAggregate, { ...h.f.scope, subjectKey: SUBJECT }, NOW)).toThrow();
    await h.run('restore');
    expect(resolveActiveMembership(h.state.snapshot.membershipState, h.f.tenantAggregate, { ...h.f.scope, subjectKey: SUBJECT }, NOW).status).toBe('active');
    const { membershipState, ...after } = h.state.snapshot, { membershipState: original, ...rest } = before;
    expect(after).toEqual(rest); expect(membershipState.invitations).toEqual(original.invitations);
    expect(membershipState.memberships).toEqual(original.memberships.map(row => ({ ...row, updatedAt: NOW, updatedBy: actor.subjectKey })));
    expect(membershipState.revision).toBe(original.revision + 2); expect(h.record.status).toBe('active');
    expect([...h.state.rows.values()].filter(row => row.phase === 'terminal' && ['suspend', 'restore'].includes(row.action)).map(row => [row.before.status, row.after.status, row.outcome]))
        .toEqual([['active', 'suspended', 'succeeded'], ['suspended', 'active', 'succeeded']]);
});
test.each(['confirmation', 'revision', 'revoked', 'approval', 'epoch', 'scope', 'audit', 'delete', 'self', 'issuance'])('%s refusal cannot change customer data', async mode => {
    const h = fixture(), input = h.input();
    if (mode === 'confirmation') input.confirmationEmail = 'wrong@example.invalid';
    if (mode === 'revision') input.expectedMembershipRevision++;
    if (mode === 'revoked') h.record.status = 'revoked';
    if (mode === 'approval') h.approval.actions = ['restore'];
    if (mode === 'epoch') h.context.restoreEpoch = uid(99);
    if (mode === 'scope') input.selector = { ...input.selector, organisationId: 'another-organisation' };
    if (mode === 'audit') h.state.fail = 'attempt.json';
    if (mode === 'self') { h.selector.subjectKey = h.record.subjectKey = actor.subjectKey; h.config.source.providerTenantId = actor.subjectKey.slice(0, 36); }
    if (mode === 'issuance') h.config.readContext.mockImplementation(async () => {
        for (const key of h.state.rows.keys()) if (key.endsWith('approval-terminal.json')) h.state.rows.delete(key); return clone(h.context);
    });
    await expect(h.run(mode === 'delete' ? 'delete' : 'suspend', input)).rejects.toBeDefined();
    expect(h.state.snapshot).toEqual(h.snapshot); expect(h.state.committed).toBe(0);
});
test('late approval revocation prevents the write and terminal audit failure withholds success', async () => {
    const h = fixture(); let calls = 0;
    h.config.readApprovedAction.mockImplementation(async ({ operationId }) => {
        const record = clone(h.state.approvals.get(operationId)); record.grant.status = ++calls > 2 ? 'revoked' : 'active'; return record;
    });
    await expect(h.run('suspend')).rejects.toMatchObject({ statusCode: 403 }); expect(h.state.committed).toBe(0);
    const next = fixture(); next.state.fail = 'terminal.json';
    await expect(next.run('suspend')).rejects.toMatchObject({ statusCode: 503 }); expect(next.state.committed).toBe(1);
});
test.each(['suspend', 'restore', 'approve-suspend', 'approve-restore'])('%s HTTP route is default-off and uses staff auth and same origin', async action => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try { for (const mode of ['off', 'anonymous', 'nonstaff', 'origin', 'allowed']) {
        const h = fixture(), execute = jest.fn(async () => ({ outcome: 'succeeded' }));
        const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://actions.invalid', NOFRIES_ENTRA_TENANT_ID: actor.subjectKey.slice(0, 36),
            NOFRIES_ALLOWED_SUBJECTS: actor.subjectKey, NOFRIES_ADMIN_SUBJECTS: mode === 'nonstaff' ? '' : actor.subjectKey,
            NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: mode === 'off' ? '' : 'true' };
        const handler = createDashboardAdminHandlers({ env, accountActions: { execute },
            service: { authorise: jest.fn(), capabilities: jest.fn(), lookup: jest.fn() },
            readOperatorSession: async () => ({ identity: mode === 'anonymous' ? null : { ...actor, tenantId: actor.subjectKey.slice(0, 36), principalId: actor.subjectKey.slice(37) } }) });
        const req = Readable.from([Buffer.from(JSON.stringify(h.input()))]);
        Object.assign(req, { method: 'POST', url: '/api/dashboard-admin/' + action, headers: { 'content-type': 'application/json',
            origin: mode === 'origin' ? 'https://wrong.invalid' : env.NOFRIES_PUBLIC_URL, 'sec-fetch-site': 'same-origin' } });
        expect((await handler.handle(req, action)).status).toBe(({ off: 404, anonymous: 401, nonstaff: 403, origin: 403, allowed: 200 })[mode]);
        expect(execute).toHaveBeenCalledTimes(mode === 'allowed' ? 1 : 0);
    } } finally { warning.mockRestore(); }
});
test('built-in approvals are audited, session-bound, single-operation and last fifteen minutes', async () => {
    const h = fixture(); delete h.config.readApprovedAction;
    const input = h.input(); delete input.operationId;
    const approved = await h.run('approve-suspend', input), command = { ...input, operationId: approved.operationId };
    expect(Date.parse(approved.approvalExpiresAt) - Date.parse(NOW)).toBe(900000); expect(h.state.committed).toBe(0);
    expect([...h.state.rows.values()].filter(row => row.phase).map(row => [row.phase, row.outcome])).toEqual([['attempt', 'attempt'], ['terminal', 'succeeded']]);
    h.context.sessionSha256 = 'f'.repeat(64);
    await expect(h.run('suspend', command)).rejects.toMatchObject({ statusCode: 403 });
    h.context.sessionSha256 = 'd'.repeat(64); await h.run('suspend', command);
    await expect(h.run('suspend', command)).rejects.toMatchObject({ statusCode: 409 }); expect(h.state.committed).toBe(1);
    const restoreInput = { ...input, expectedMembershipRevision: h.state.snapshot.membershipState.revision };
    const restore = await h.run('approve-restore', restoreInput);
    await h.run('restore', { ...restoreInput, operationId: restore.operationId }); expect(h.state.committed).toBe(2);
    await expect(h.run('suspend', command)).rejects.toMatchObject({ statusCode: 409 }); expect(h.state.committed).toBe(2);
});
test.each(['operation', 'session', 'duration', 'action', 'authority'])('execution refuses a mismatched %s approval binding', async mode => {
    const h = fixture(), read = h.config.readApprovedAction.getMockImplementation();
    h.config.readApprovedAction.mockImplementation(async args => {
        const record = await read(args);
        if (mode === 'operation') record.operationId = uid(99);
        if (mode === 'session') record.sessionSha256 = 'f'.repeat(64);
        if (mode === 'duration') record.grant.validUntil = new Date(Date.parse(NOW) + 900001).toISOString();
        if (mode === 'action') record.grant.actions = ['restore', 'suspend'];
        if (mode === 'authority') record.authoritySha256 = 'f'.repeat(64);
        return record;
    });
    await expect(h.run('suspend')).rejects.toMatchObject({ statusCode: 403 }); expect(h.state.committed).toBe(0);
});
test.each(['no staff suspension', 'unknown later change', 'malformed audit', 'wrong native receipt'])('restore refuses %s', async mode => {
    const h = fixture();
    if (mode === 'no staff suspension') h.state.snapshot.membershipState.memberships[0].status = 'suspended';
    else {
        await h.run('suspend');
        if (mode === 'unknown later change') { h.state.snapshot = clone(h.state.snapshot); h.state.snapshot.membershipState.revision++; }
        if (mode === 'malformed audit') [...h.state.rows.values()].find(row => row.phase === 'terminal' && row.action === 'suspend').extra = true;
        if (mode === 'wrong native receipt') [...h.state.receipts.values()][0].intent_sha256 = '0'.repeat(64);
    }
    const before = clone(h.state.snapshot); await expect(h.run('restore')).rejects.toBeDefined(); expect(h.state.snapshot).toEqual(before);
});
test.each([1, 100, 101])('%s verified different-member changes preserve restore only within the bounded history', async count => {
    const h = fixture(), member = h.state.snapshot.membershipState.memberships[0], other = SUBJECT.slice(0, 37) + uid(99);
    h.state.snapshot.membershipState.memberships.push({ ...member, subjectKey: other, membershipId: 'other-member',
        invitationId: 'other-invite', createdBy: other, updatedBy: other });
    const invitation = h.state.snapshot.membershipState.invitations.find(row => row.invitationId === member.invitationId);
    h.state.snapshot.membershipState.invitations.push({ ...invitation, subjectKey: other, invitationId: 'other-invite', membershipId: 'other-member', updatedBy: other });
    await h.run('suspend'); const stale = h.input();
    h.selector.subjectKey = h.record.subjectKey = other;
    for (let i = 0; i < count; i++) await h.run(i % 2 ? 'restore' : 'suspend');
    h.selector.subjectKey = h.record.subjectKey = SUBJECT;
    await expect(h.run('restore', stale)).rejects.toMatchObject({ statusCode: 409 });
    if (count > 100) await expect(h.run('restore')).rejects.toMatchObject({ statusCode: 409 });
    else await h.run('restore');
    expect(h.state.snapshot.membershipState.memberships.map(row => row.status)).toEqual([count > 100 ? 'suspended' : 'active', count % 2 ? 'suspended' : 'active']);
    expect(h.state.committed).toBe(count + 1 + (count <= 100 ? 1 : 0));
});

test.each([75, 150])('%s long advisor revisions stay restorable or refuse before mutation', async count => {
    const h = fixture();
    const { fixture: dashboardFixture } = require('./fixtures/dashboardFixture');
    const { normaliseAdvisorAssignment } = require('../api/shared/appLifecycle/portalPermissions');
    const template = dashboardFixture({ role: 'fractional_advisor' }).advisorAssignments.cyber_security;
    h.state.snapshot.advisorAssignments = Array.from({ length: count }, (_, i) => normaliseAdvisorAssignment({
        ...template, assignmentId: String(i).padStart(180, 'a'), status: 'revoked' }));
    const before = clone(h.state.snapshot);
    if (count === 75) { await h.run('suspend'); await h.run('restore'); expect(h.state.committed).toBe(2); }
    else { await expect(h.run('suspend')).rejects.toBeDefined(); expect(h.state.committed).toBe(0); expect(h.state.snapshot).toEqual(before); }
    expect([...h.state.rows.values()].every(row => Buffer.byteLength(JSON.stringify(row)) <= 32768)).toBe(true);
});

test('identical concurrent requests commit exactly one membership change', async () => {
    const h = fixture(), input = h.input();
    const results = await Promise.allSettled([h.run('suspend', input), h.run('suspend', input)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(row => row.status === 'rejected').reason.statusCode).toBe(409);
    expect(h.state.committed).toBe(1); expect(h.state.receipts.size).toBe(1);
});
test.each(['extra field', 'wrong target', 'failed issuance'])('execution refuses %s in the retained approval audit', async mode => {
    const h = fixture(); delete h.config.readApprovedAction;
    const input = h.input(); delete input.operationId; const approved = await h.run('approve-suspend', input);
    const audit = h.state.rows.get(`dashboard-admin-account-actions/${approved.operationId}/approval-terminal.json`);
    if (mode === 'extra field') audit.unexpected = true;
    if (mode === 'wrong target') audit.targetSha256 = 'f'.repeat(64);
    if (mode === 'failed issuance') audit.outcome = 'refused';
    await expect(h.run('suspend', { ...input, operationId: approved.operationId })).rejects.toBeDefined();
    expect(h.state.committed).toBe(0);
});
