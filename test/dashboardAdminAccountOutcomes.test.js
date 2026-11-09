'use strict';
const { createActionOutcomeReader } = require('../api/shared/dashboardAdmin/accountActionsOutcome');
const { fixture, actor, clone, uid } = require('./fixtures/dashboardAdminMembershipActions');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const read = (h, input) => createActionOutcomeReader(h.config)(actor, input, { request: {}, signal: new AbortController().signal });
async function completed() {
    const h = fixture(), input = h.input(); await h.run('suspend', input);
    const key = `dashboard-admin-account-actions/${input.operationId}/`;
    return { h, input: { selector: h.selector, operationId: input.operationId }, key,
        attempt: h.state.rows.get(key + 'attempt.json'), terminal: h.state.rows.get(key + 'terminal.json') };
}
test('lost HTTP response can be checked by operation ID without another mutation or audit write', async () => {
    const { h, input, terminal } = await completed(), before = clone([...h.state.rows.entries()]), snapshot = clone(h.state.snapshot);
    const result = await read(h, input);
    expect(result).toMatchObject({ operationId: input.operationId, outcome: 'succeeded',
        attempt: { phase: 'attempt', outcome: 'attempt' }, terminal: { actorSubjectKey: actor.subjectKey, action: 'suspend',
            before: { status: 'active' }, after: { status: 'suspended' }, occurredAt: terminal.occurredAt } });
    expect(result.terminal).not.toHaveProperty('nativeCommand'); expect(result.terminal).not.toHaveProperty('context');
    expect([...h.state.rows.entries()]).toEqual(before); expect(h.state.snapshot).toEqual(snapshot); expect(h.state.committed).toBe(1);
});
test.each(['no terminal', 'uncertain'])('%s remains unconfirmed without inferring success from current membership', async mode => {
    const { h, input, key, terminal } = await completed();
    if (mode === 'no terminal') h.state.rows.delete(key + 'terminal.json');
    else { terminal.outcome = 'uncertain'; terminal.after = null; delete terminal.resultSha256; }
    expect((await read(h, input)).outcome).toBe(mode === 'no terminal' ? 'unconfirmed' : 'uncertain');
    expect(h.state.committed).toBe(1);
});
test.each(['unknown field', 'bad actor', 'bad time', 'future', 'mismatched pair', 'no attempt', 'bad command', 'bad result', 'bad selector', 'bad before'])('corrupt %s is refused', async mode => {
    const { h, input, key, terminal } = await completed();
    if (mode === 'unknown field') terminal.privateData = 'PRIVATE_DETAIL';
    if (mode === 'bad actor') terminal.actorSubjectKey = 'bad';
    if (mode === 'bad time') terminal.occurredAt = 'bad';
    if (mode === 'future') terminal.occurredAt = '2099-01-01T00:00:00.000Z';
    if (mode === 'mismatched pair') h.state.rows.get(key + 'attempt.json').approvalSha256 = 'f'.repeat(64);
    if (mode === 'no attempt') h.state.rows.delete(key + 'attempt.json');
    if (mode === 'bad command') terminal.nativeCommand = null;
    if (mode === 'bad result') terminal.resultSha256 = 'bad';
    if (mode === 'bad selector') terminal.selector.extra = true;
    if (mode === 'bad before') terminal.before = { status: 'suspended' };
    await expect(read(h, input)).rejects.toMatchObject({ statusCode: 503, code: 'dashboard_admin_unavailable' });
    expect(h.state.committed).toBe(1);
});
test('missing and different-target operations share a not-found response after scoped authorization', async () => {
    const { h, input } = await completed();
    for (const value of [{ ...input, operationId: uid(99) }, { ...input, selector: { ...input.selector, organisationId: 'other' } }])
        await expect(read(h, value)).rejects.toMatchObject({ statusCode: 404, code: 'dashboard_admin_not_found' });
});
test('denied scope never reads audits and revocation during reads withholds a buffered outcome', async () => {
    const { h, input } = await completed(), get = h.config.auditContainer.getBlockBlobClient;
    const readBlob = jest.fn(get); h.config.auditContainer.getBlockBlobClient = readBlob;
    h.config.readContext.mockRejectedValueOnce(new Error('PRIVATE_DENIED'));
    await expect(read(h, input)).rejects.toMatchObject({ statusCode: 503 }); expect(readBlob).not.toHaveBeenCalled();
    h.config.auditContainer.getBlockBlobClient = key => { const blob = get(key); return { ...blob, async download(...args) {
        const result = await blob.download(...args); if (key.endsWith('terminal.json')) h.context.restoreEpoch = uid(99); return result;
    } }; };
    await expect(read(h, input)).rejects.toMatchObject({ statusCode: 403 });
});
test('extension audit projections validate their exact expiry and command pairing', async () => {
    const { h, input, key } = await completed(), now = h.config.clock(), expiresAt = new Date(Date.parse(now) + 86400000).toISOString();
    const base = { schemaVersion: 1, operationId: input.operationId, action: 'extend-expired-access', actorSubjectKey: actor.subjectKey,
        targetSha256: hash(input.selector), commandSha256: 'a'.repeat(64), proposedAfter: { status: 'active', expiresAt }, occurredAt: now };
    h.state.rows.set(key + 'attempt.json', { ...base, phase: 'attempt', outcome: 'attempt', before: null, after: null });
    h.state.rows.set(key + 'terminal.json', { ...base, phase: 'terminal', outcome: 'succeeded',
        before: { status: 'expired', expiresAt: new Date(Date.parse(now) - 1000).toISOString() }, after: base.proposedAfter });
    expect((await read(h, input)).terminal.after).toEqual(base.proposedAfter);
    h.state.rows.get(key + 'terminal.json').after = { status: 'active', expiresAt: now };
    await expect(read(h, input)).rejects.toMatchObject({ statusCode: 503 });
});
