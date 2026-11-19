'use strict';

const { createFrameworkAction } = require('../api/shared/dashboardAdmin/frameworkActions');
const { tuples } = require('../api/shared/appLifecycle/paidFrameworkDecisions');
const { fixture, actor, clone, NOW } = require('./fixtures/dashboardAdminMembershipActions');

function staff() {
    const h = fixture();
    const { readApprovedAction, ...config } = h.config;
    const witness = { productGrantId: 'synthetic-product', agreementRef: 'synthetic-terms', revision: 0, granted: false };
    const change = jest.fn(async (command, approval) => approval ? { revision: 1, granted: command.action === 'grant' } : witness);
    const run = createFrameworkAction({ ...config, createRepository: guard => ({ async frameworkDecision(...args) {
        await guard(); return change(...args);
    } }) });
    const input = { selector: h.selector, confirmationEmail: h.record.email, expectedMembershipRevision: 2,
        reason: 'Synthetic purchase confirmed', action: 'grant', tuple: tuples[0], step: 'approve' };
    return { ...h, change, input, call: patch => run(actor, { ...input, ...patch }, { request: {}, signal: new AbortController().signal }) };
}
test('create-only approval, attempt and outcome bind the staff identity, exact scope, tuple and reason', async () => {
    const h = staff(), { operationId } = await h.call({});
    const apply = { step: 'apply', operationId };
    await expect(h.call(apply)).resolves.toMatchObject({ granted: true, revision: 1 });
    const records = [...h.state.rows.values()];
    expect(records).toHaveLength(3);
    for (const r of records) expect(r.command).toMatchObject({ actorSubjectKey: actor.subjectKey, selector: h.selector,
        tuple: tuples[0], reason: h.input.reason, action: 'grant', operationId });
    await expect(h.call(apply)).rejects.toBeDefined();
    expect(h.change).toHaveBeenCalledTimes(2);
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
