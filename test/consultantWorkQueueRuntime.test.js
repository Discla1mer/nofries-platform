'use strict';

// Genuine portfolio binder, scoped contexts, retained history and paired audit.
// Controlled synthetic SQL is not a substitute for native PostgreSQL/RLS tests.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForShare: jest.fn(), loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore', () => {
    const actual = jest.requireActual('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    return { ...actual, readHead: jest.fn(), readHistory: jest.fn() };
});
const { createDashboardResourceRuntime } = require('../api/shared/dashboardRuntime');
const { createImprovementRequestFixture } = require('./fixtures/improvementRequestFixture');
async function ready(options = {}) {
    const h = createImprovementRequestFixture(options), runtime = createDashboardResourceRuntime(h.options);
    const selected = await runtime.forRequest(h.request(), { expectedGeneration: h.session.generationToken });
    const generated = await selected.improvement.execute(h.generate());
    return { ...h, runtime, selected, plan: generated.plan };
}
function queue(h, input = { limit: 50, cursor: null }, request = h.request()) {
    return h.runtime.readWorkQueue(request, { expectedGeneration: h.session.generationToken }, input);
}
test('reads real retained actions with stable exact links and paired audit without changing session or plan', async () => {
    const h = await ready(), session = JSON.stringify(h.rows.session), revisions = JSON.stringify(h.state.committed.revisions);
    const result = await queue(h);
    expect(result.rows.length).toBe(h.plan.actions.length);
    expect(result.rows[0]).toMatchObject({ bindingId: h.binding.bindingId, organisationLabel: h.binding.organisationLabel,
        planId: h.plan.planId, planRevision: h.plan.revision });
    expect(new Set(result.rows.map(row => row.actionId))).toEqual(new Set(h.plan.actions.map(row => row.actionId)));
    expect(JSON.stringify(h.rows.session)).toBe(session); expect(JSON.stringify(h.state.committed.revisions)).toBe(revisions);
    expect(h.state.committed.auditRows.filter(row => row.payload.action === 'improvement.read')).toHaveLength(2);
    expect(h.state.borrows).toBe(h.state.released);
});
test('paged real plan results are request-bound and cannot share selected-client request capability', async () => {
    const h = await ready(), request = h.request(), input = { limit: 1, cursor: null };
    const pending = queue(h, input, request); input.limit = 50;
    const first = await pending; expect(first.rows).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    expect(await queue(h, { limit: 1, cursor: null }, request)).toBe(first);
    await expect(queue(h, { limit: 2, cursor: null }, request)).rejects.toMatchObject({ code: 'work_queue_access_denied' });
    await expect(h.runtime.forRequest(request, { expectedGeneration: h.session.generationToken })).rejects.toMatchObject({ statusCode: 403 });
    const second = await queue(h, { limit: 1, cursor: first.nextCursor });
    expect(second.rows[0].actionId).not.toBe(first.rows[0].actionId);
});
test('a revoked organisation before its first read yields unavailable coverage without its name', async () => {
    const h = await ready(); h.snapshot.flags.enabled.improvement_plan = false;
    const result = await queue(h);
    expect(result.rows).toEqual([]); expect(result.organisations).toEqual([]);
    expect(result.coverage.unavailableOrganisations).toBe(1);
    expect(JSON.stringify(result)).not.toContain(h.binding.organisationLabel);
});
test('final recheck suppresses already-read actions if current membership is revoked', async () => {
    const h = await ready();
    let reads = 0;
    h.state.hook = event => {
        if (event.phase === 'after' && event.sql === 'COMMIT' && h.state.committed.auditRows.filter(row => row.payload.action === 'improvement.read').length === 2) {
            reads++;
            if (reads === 1) h.snapshot.membershipState.memberships[0].status = 'suspended';
        }
    };
    await expect(queue(h)).rejects.toMatchObject({ code: 'work_queue_access_denied', statusCode: 403 });
    expect(h.state.borrows).toBe(h.state.released);
});
test('invalid cursors are refused before database I/O and stale generations never become unavailable coverage', async () => {
    const h = await ready(), before = h.pool.connect.mock.calls.length;
    await expect(queue(h, { limit: 1, cursor: 'e30' })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.pool.connect).toHaveBeenCalledTimes(before);
    await expect(h.runtime.readWorkQueue(h.request(), { expectedGeneration: 'f'.repeat(64) }, { limit: 1, cursor: null }))
        .rejects.toMatchObject({ code: 'work_queue_access_denied', statusCode: 403 });
});
test('the server-only disclosure assertion retains child expiry checks after the queue promise settles', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z', h = await ready({ membershipEndsAt: cutoff }), request = h.request();
    const result = await queue(h, { limit: 50, cursor: null }, request);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(h.runtime.assertWorkQueueDisclosure(request)).toBe(h.state.at);
    h.state.at = cutoff;
    expect(() => h.runtime.assertWorkQueueDisclosure(request)).toThrow(expect.objectContaining({ code: 'work_queue_access_denied' }));
    await expect(queue(h, { limit: 50, cursor: null }, request)).rejects.toMatchObject({ code: 'work_queue_access_denied' });
    expect(() => h.runtime.assertWorkQueueDisclosure({ ...request })).toThrow(expect.objectContaining({ statusCode: 403 }));
});
test('reusing a settled queue request cannot bypass its original request deadline', async () => {
    const h = await ready(), request = h.request();
    await queue(h, { limit: 50, cursor: null }, request);
    h.state.at = '2026-09-07T11:01:00.000Z';
    await expect(queue(h, { limit: 50, cursor: null }, request)).rejects.toMatchObject({ code: 'work_queue_unavailable', statusCode: 503 });
});
