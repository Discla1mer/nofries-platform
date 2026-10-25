'use strict';

// Real access/domain/projector composition with synthetic storage ports only.
// No native schema, runtime binding, grants or live sessions are installed here.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/improvementPlan/improvementPlanStore', () => {
    const actual = jest.requireActual('../api/shared/improvementPlan/improvementPlanStore');
    return { ...actual, loadHistory: jest.fn() };
});

const crypto = require('node:crypto');
const { DashboardPersistenceError, dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const actionStore = require('../api/shared/improvementPlan/improvementPlanStore');
const { createPostgresImprovementActionListRepository } = require('../api/shared/improvementPlan/postgresImprovementActionListRepository');
const { ImprovementActionListError } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } =
    require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { evidenceFixture, clone } = require('./fixtures/evidenceMetadataFixture');
const { createClock, createContext } = require('./fixtures/ncscAssessmentFixture');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-02T00:00:00.000Z';
const FILTERS = Object.freeze({ status: 'all', owner: 'all', overdueOnly: false });

function retainedState(scope, actorSubjectKey) {
    let state = createImprovementPlan({ ...scope, actorSubjectKey, createdAt: accepted.scoreAsOf },
        { ...clone(accepted), organisationId: scope.organisationId }, { registry: acceptedRegistry });
    function step(index, type, payload = {}) {
        state = applyImprovementActionCommand(state, { ...scope, actorSubjectKey, type, payload,
            actionId: state.proposals[index].actionId, evaluationOutputSha256: state.source.evaluationOutputSha256,
            operationId: 'operation-' + state.commands.length, expectedRevision: state.commands.length,
            at: '2026-09-07T10:01:00.000Z' },
        { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey,
            eligibleOwnerSubjectKeys: [OWNER, OTHER] });
    }
    function assign(index, ownerSubjectKey = OWNER) { step(index, 'assign', { ownerSubjectKey, dueDate: '2026-10-01' }); }
    function complete(index) {
        assign(index); step(index, 'start'); step(index, 'complete', {
            note: 'Synthetic completion awaiting evidence review.', evidenceReference: 'synthetic:evidence:completion' });
    }
    assign(0); assign(1, OTHER); step(1, 'start');
    assign(2); step(2, 'start'); step(2, 'block', { reason: 'Waiting on supplier.' });
    complete(3); complete(4); step(4, 'reopen', { reason: 'Review found more work.' });
    return state;
}

async function harness(options = {}) {
    const f = evidenceFixture({ now: NOW, organisationId: accepted.organisationId,
        modules: ['overview', 'improvement_plan'], ...options });
    const clock = createClock(f.now), context = await createContext(f.scope, clock), trace = [];
    const domain = retainedState({ ...f.scope, planId: 'plan-a' }, f.subjectKey);
    const h = { ...f, state: clone(f.state), clock, context, trace, tx: { query: jest.fn() },
        retained: clone({ state: domain, result: { schemaVersion: 1, plan: getImprovementPlanView(domain) },
            source: { assessmentId: accepted.assessmentId, revision: 2, revisionSha256: 'c'.repeat(64) }, history: [] }),
        afterSnapshot: null, afterLoad: null, afterAudit: null, beforeCommit: null, failCommit: false };
    h.selector = { planId: 'plan-a', filters: { ...FILTERS } };
    dataStorage.loadSnapshotForUpdate.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual(f.scope); trace.push('authority');
        if (h.afterSnapshot) await h.afterSnapshot(); return h.state;
    });
    actionStore.loadHistory.mockImplementation(async (tx, scope, aggregate) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual({ ...f.scope, planId: 'plan-a' });
        expect(aggregate).toBe(h.state.tenantAggregate); trace.push('load');
        if (h.afterLoad) await h.afterLoad(); return h.retained;
    });
    h.database = { withTenantTransaction: jest.fn(async (tenantId, work) => {
        expect(tenantId).toBe(f.scope.tenantId); trace.push('begin');
        try {
            const result = await work(h.tx);
            if (h.beforeCommit) await h.beforeCommit();
            if (h.failCommit) throw Object.assign(new Error('private uncertain database outcome'), { code: 'postgres_commit_failed' });
            trace.push('commit'); return result;
        } catch (error) { trace.push('rollback-or-uncertain'); throw error; }
    }) };
    h.auditEvents = [];
    h.audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
        expect(trace.slice(trace.lastIndexOf('begin'))).not.toContain('commit');
        trace.push('audit'); h.auditEvents.push(clone(event));
        if (h.afterAudit) await h.afterAudit();
    } });
    h.repository = createPostgresImprovementActionListRepository({ database: h.database, clock: clock.now, audit: h.audit });
    h.read = input => h.repository.readImprovementActionList(h.context, input === undefined ? h.selector : input);
    h.row = (result, index) => result.actions.find(action => action.actionId === h.retained.state.proposals[index].actionId);
    return h;
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
afterEach(() => jest.clearAllMocks());

test('scoped retained commands yield real owners, due dates, completion and reopen history without business mutation', async () => {
    const h = await harness(), before = clone({ authority: h.state, retained: h.retained });
    const result = await h.read();
    expect(result).toMatchObject({ schemaVersion: 1, scope: { ...h.scope, planId: 'plan-a' },
        planRevision: 13, asOf: NOW, dueDateBasis: 'UTC_calendar_day',
        priority: { status: 'not_calculated', reason: 'priority_adapter_required' }, order: 'due_date_then_action_id',
        counts: { all: { total: 14, unassigned: 9, overdue: 4,
            byStatus: { open: 11, in_progress: 1, blocked: 1, completed: 1 } } },
        source: { assessmentId: accepted.assessmentId, assessmentRevision: accepted.assessmentRevision,
            scoreAsOf: accepted.scoreAsOf, evaluationOutputSha256: h.retained.state.source.evaluationOutputSha256 } });
    expect(result.counts.visible).toEqual(result.counts.all);
    expect(h.row(result, 0)).toMatchObject({ ownerSubjectKey: OWNER, ownerEligibility: 'not_checked',
        dueDate: '2026-10-01', isOverdue: true, status: 'open' });
    expect(h.row(result, 2)).toMatchObject({ blockedReason: 'Waiting on supplier.', status: 'blocked' });
    expect(h.row(result, 3)).toMatchObject({ status: 'completed', isOverdue: false,
        completion: { note: 'Synthetic completion awaiting evidence review.' },
        evidence: { completionReference: 'synthetic:evidence:completion', completionVerification: 'not_verified',
            durableLinkStatus: 'not_established', downloadAllowed: false, scoreEffect: 'none' } });
    expect(h.row(result, 4)).toMatchObject({ status: 'open', completion: null,
        evidence: { completionReference: null, completionVerification: 'not_recorded', durableLinkStatus: 'not_established' } });
    expect(h.row(result, 4).history.map(event => event.type)).toEqual(['assign', 'start', 'complete', 'reopen']);
    expect(h.row(result, 4).history[2].details).toMatchObject({ evidenceReference: 'synthetic:evidence:completion',
        evidenceVerification: 'not_verified', durableLinkStatus: 'not_established' });
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.trace).toEqual(['begin', 'authority', 'load', 'audit', 'commit']);
    expect(h.auditEvents).toHaveLength(1);
    expect(h.auditEvents[0]).toMatchObject({ action: 'improvement.read', module: 'improvement_plan', result: 'succeeded', ...h.scope });
    expect({ authority: h.state, retained: h.retained }).toEqual(before);
    expect(h.tx.query).not.toHaveBeenCalled();
    expect(Object.keys(h.repository)).toEqual(['listImprovementPlans', 'readImprovementActionList']);
});

test('filters use retained owner references without granting current membership or changing full counts', async () => {
    const h = await harness(), all = await h.read();
    const filtered = await h.read({ planId: 'plan-a', filters: { status: 'open', owner: OWNER, overdueOnly: true } });
    expect(filtered.actions.map(action => action.actionId).sort()).toEqual([
        h.retained.state.proposals[0].actionId, h.retained.state.proposals[4].actionId].sort());
    expect(filtered.counts.all).toEqual(all.counts.all);
    expect(filtered.counts.visible).toEqual({ total: 2, unassigned: 0, overdue: 2,
        byStatus: { open: 2, in_progress: 0, blocked: 0, completed: 0 } });
    expect(h.state.membershipState.memberships.some(member => member.subjectKey === OWNER)).toBe(false);
    expect(filtered.actions.every(action => action.ownerEligibility === 'not_checked')).toBe(true);
    const empty = await h.read({ planId: 'plan-a', filters: { status: 'completed', owner: 'unassigned', overdueOnly: true } });
    expect(empty.actions).toEqual([]); expect(empty.counts.all).toEqual(all.counts.all);
});

test('server time sampled after load crosses the UTC due-date boundary and caller mutation cannot change filters', async () => {
    const h = await harness({ now: '2026-10-01T23:59:59.999Z' });
    const input = { planId: 'plan-a', filters: { status: 'open', owner: OWNER, overdueOnly: true } };
    h.afterLoad = () => { h.clock.advance(1); input.filters.owner = OTHER; input.planId = 'foreign'; };
    const result = await h.read(input);
    expect(result.asOf).toBe('2026-10-02T00:00:00.000Z');
    expect(result.filters).toEqual({ status: 'open', owner: OWNER, overdueOnly: true });
    expect(result.scope.planId).toBe('plan-a'); expect(result.actions).toHaveLength(2);
});

test.each(['viewer', 'membership', 'product', 'module', 'flag', 'tenant', 'organisation'])
('current %s denial precedes object lookup and audit', async kind => {
    const h = await harness(kind === 'viewer' ? { role: 'viewer' } : {});
    if (kind === 'membership') h.state.membershipState.memberships[0].status = 'suspended';
    if (kind === 'product') h.state.entitlementState.grants = [];
    if (kind === 'module') h.state.entitlementState.grants[0].modules = ['overview'];
    if (kind === 'flag') h.state.flags.enabled.improvement_plan = false;
    if (kind === 'tenant') h.state.tenantAggregate.tenant.recordStatus = 'suspended';
    if (kind === 'organisation') h.state.tenantAggregate.organisations[0].recordStatus = 'suspended';
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    expect(actionStore.loadHistory).not.toHaveBeenCalled(); expect(h.auditEvents).toEqual([]);
    expect(h.trace).not.toContain('commit');
});

test.each(['load', 'audit'])('membership expiry during %s withholds the whole list', async phase => {
    const h = await harness();
    h[phase === 'load' ? 'afterLoad' : 'afterAudit'] = () => h.clock.set(h.state.membershipState.memberships[0].validUntil);
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    expect(h.trace).not.toContain('commit');
    expect(h.auditEvents).toHaveLength(phase === 'load' ? 0 : 1);
});

test('revocation during awaited audit is checked before disclosure', async () => {
    const h = await harness(); h.afterAudit = () => { h.state.flags.enabled.improvement_plan = false; };
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    expect(h.auditEvents).toHaveLength(1); expect(h.trace).not.toContain('commit');
});

test.each(['load', 'audit'])('a clock regression during %s returns a sanitized unavailable error', async phase => {
    const h = await harness();
    h.afterLoad = () => h.clock.advance(2000);
    if (phase === 'load') h.afterLoad = () => h.clock.advance(-1);
    else h.afterAudit = () => h.clock.advance(-1000);
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
    expect(h.trace).not.toContain('commit');
});

test.each(['missing', 'corrupt', 'load-failure', 'pre-update-time'])('%s retained history returns no partial list or audit', async kind => {
    const h = await harness();
    if (kind === 'missing') h.retained = null;
    if (kind === 'corrupt') h.retained.state.commands[0].expectedRevision = 9;
    if (kind === 'load-failure') actionStore.loadHistory.mockRejectedValue(new Error('private retained history detail'));
    if (kind === 'pre-update-time') h.retained.state.commands.forEach(command => { command.at = '2026-10-03T00:00:00.000Z'; });
    const expected = kind === 'missing' ? ['improvement_list_not_found', 404]
        : kind === 'pre-update-time' ? ['improvement_list_time_conflict', 409] : ['improvement_list_unavailable', 503];
    await expect(h.read()).rejects.toMatchObject({ code: expected[0], statusCode: expected[1] });
    expect(h.auditEvents).toEqual([]); expect(h.trace).not.toContain('commit');
});

test.each(['tenantId', 'organisationId', 'planId'])('valid retained state for a different %s never escapes', async key => {
    const h = await harness();
    h.retained.state = retainedState({ ...h.scope, planId: 'plan-a', [key]: 'foreign' }, h.subjectKey);
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_scope_mismatch', statusCode: 404 });
    expect(h.auditEvents).toEqual([]); expect(h.trace).not.toContain('commit');
});

test('a missing authority snapshot is denied and does not reveal whether a plan exists', async () => {
    const h = await harness();
    dataStorage.loadSnapshotForUpdate.mockRejectedValue(new DashboardPersistenceError('dashboard_not_found', 404));
    await expect(h.read()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    expect(actionStore.loadHistory).not.toHaveBeenCalled(); expect(h.auditEvents).toEqual([]);
});

test('copied contexts, injected scope/time and malformed selectors never open a transaction', async () => {
    const h = await harness();
    await expect(h.repository.readImprovementActionList(clone(h.context), h.selector))
        .rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    for (const input of [null, { ...h.selector, tenantId: 'foreign' }, { ...h.selector, asOf: NOW },
        { ...h.selector, filters: { ...FILTERS, overdueOnly: 'true' } },
        { ...h.selector, filters: { ...FILTERS, owner: 'forged-owner' } }]) {
        await expect(h.read(input)).rejects.toMatchObject({ code: 'improvement_list_input_invalid', statusCode: 400 });
    }
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});

test.each(['audit', 'commit'])('awaits %s completion before exposing a detached immutable list', async phase => {
    const h = await harness(), reached = deferred(), release = deferred();
    h[phase === 'audit' ? 'afterAudit' : 'beforeCommit'] = async () => { reached.resolve(); await release.promise; };
    let settled = false;
    const reading = h.read().then(result => { settled = true; return result; });
    await reached.promise;
    expect(settled).toBe(false); expect(h.trace).not.toContain('commit');
    release.resolve();
    const result = await reading;
    expect(settled).toBe(true); expect(h.trace.at(-1)).toBe('commit');
    expect(Object.isFrozen(result.actions[0].history)).toBe(true);
    expect(Object.isFrozen(result.counts.visible.byStatus)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/actorSubjectKey|operationId|createdBy|completedBy|private-/);
    h.retained.state.commands[0].payload.dueDate = '2030-01-01';
    expect(result.actions.some(action => action.dueDate === '2030-01-01')).toBe(false);
});

test.each(['expiry', 'revocation', 'clock-regression'])
('%s while COMMIT is pending withholds disclosure after the transaction has settled', async kind => {
    const h = await harness(), reached = deferred(), release = deferred();
    h.beforeCommit = async () => { reached.resolve(); await release.promise; };
    let settled = false;
    const reading = h.read().then(
        result => { settled = true; return { result }; },
        error => { settled = true; return { error }; });
    await reached.promise;
    expect(settled).toBe(false); expect(h.auditEvents).toHaveLength(1);
    if (kind === 'expiry') h.clock.set(h.state.membershipState.memberships[0].validUntil);
    if (kind === 'revocation') h.state.flags.enabled.improvement_plan = false;
    if (kind === 'clock-regression') h.clock.advance(-1);
    release.resolve();
    const outcome = await reading;
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(ImprovementActionListError);
    expect(outcome.error).toMatchObject(kind === 'clock-regression'
        ? { code: 'improvement_list_unavailable', statusCode: 503 }
        : { code: 'improvement_list_access_denied', statusCode: 403 });
    // The read audit may already be committed. Disclosure denial does not undo it.
    expect(h.trace.at(-1)).toBe('commit'); expect(h.trace).not.toContain('rollback-or-uncertain');
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(actionStore.loadHistory).toHaveBeenCalledTimes(1); expect(h.auditEvents).toHaveLength(1);
});

test.each(['audit', 'commit'])('failed or uncertain %s withholds output without retrying work', async phase => {
    const h = await harness();
    if (phase === 'audit') h.afterAudit = () => { throw new Error('private audit sink detail'); };
    else h.failCommit = true;
    let error;
    try { await h.read(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ImprovementActionListError);
    expect(error).toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
    expect(error.message).toBe('improvement_list_unavailable'); expect(error.stack).toBeUndefined();
    expect(Object.isFrozen(error)).toBe(true); expect(JSON.stringify(error)).not.toMatch(/private|postgres|audit sink/);
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(actionStore.loadHistory).toHaveBeenCalledTimes(1); expect(h.auditEvents).toHaveLength(1);
    expect(h.trace).not.toContain('commit'); expect(h.tx.query).not.toHaveBeenCalled();
});

describe('persisted bounded plan selection', () => {
    const SQL = 'SELECT tenant_id, organisation_id, plan_id, revision FROM nofries.dashboard_improvement_heads ' +
        'WHERE tenant_id = $1 AND organisation_id = $2 ' +
        'AND ($3::text IS NULL OR plan_id COLLATE "C" > $3::text COLLATE "C") ' +
        'ORDER BY plan_id COLLATE "C" LIMIT $4';
    async function selectionHarness() {
        const h = await harness();
        h.page = { limit: 2, afterPlanId: null };
        h.head = (plan_id, revision = 0) => ({ tenant_id: h.scope.tenantId,
            organisation_id: h.scope.organisationId, plan_id, revision });
        h.rows = [h.head('Plan-a', 3), h.head('plan-a', 1024), h.head('plan-b', 1)];
        h.tx.query.mockImplementation(async () => { h.trace.push('heads'); return { rows: h.rows, rowCount: h.rows.length }; });
        h.select = page => h.repository.listImprovementPlans(h.context, page === undefined ? h.page : page);
        return h;
    }
    test('selects only scoped persisted identities with C-order paging and one read audit', async () => {
        const h = await selectionHarness(), before = clone(h.state), result = await h.select();
        expect(result).toEqual({ schemaVersion: 1, scope: h.context.scope, asOf: NOW,
            plans: [{ planId: 'Plan-a', planRevision: 3 }, { planId: 'plan-a', planRevision: 1024 }], nextAfterPlanId: 'plan-a' });
        expect(h.tx.query).toHaveBeenCalledTimes(1);
        expect(h.tx.query).toHaveBeenCalledWith(SQL, [h.scope.tenantId, h.scope.organisationId, null, 3]);
        expect(h.trace).toEqual(['begin', 'authority', 'heads', 'audit', 'commit']);
        expect(h.auditEvents).toHaveLength(1);
        expect(h.auditEvents[0]).toMatchObject({ action: 'improvement.read', module: 'improvement_plan', ...h.scope });
        expect(actionStore.loadHistory).not.toHaveBeenCalled(); expect(h.state).toEqual(before);
        expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.plans[0])).toBe(true);
        h.rows[0].revision = 4; expect(result.plans[0].planRevision).toBe(3);
        expect(JSON.stringify(result)).not.toMatch(/priority|actionId|evaluation|owner|evidence|payload_sha256/);
    });
    test.each([[[]], [['plan-c']], [['plan-c', 'plan-d']]])('empty/exact final page %p has no continuation cursor', async identities => {
        const h = await selectionHarness(); h.rows = identities.map(id => h.head(id));
        const result = await h.select({ limit: 2, afterPlanId: 'plan-b' });
        expect(result.plans).toEqual(identities.map(planId => ({ planId, planRevision: 0 })));
        expect(result.nextAfterPlanId).toBeNull();
        expect(h.tx.query).toHaveBeenCalledWith(SQL, [h.scope.tenantId, h.scope.organisationId, 'plan-b', 3]);
        expect(h.auditEvents).toHaveLength(1);
    });
    test.each(['extra-row', 'duplicate', 'order', 'cursor', 'foreign-tenant', 'foreign-organisation', 'bad-id',
        'missing-id', 'revision-string', 'revision-negative', 'revision-overflow', 'extra-column', 'missing-column'])
    ('rejects %s head corruption without audit, history reads or retries', async kind => {
        const h = await selectionHarness();
        if (kind === 'extra-row') h.rows.push(h.head('plan-c'));
        if (kind === 'duplicate') h.rows[1].plan_id = h.rows[0].plan_id;
        if (kind === 'order') h.rows.reverse();
        if (kind === 'cursor') h.page.afterPlanId = h.rows[0].plan_id;
        if (kind === 'foreign-tenant') h.rows[0].tenant_id = 'foreign';
        if (kind === 'foreign-organisation') h.rows[0].organisation_id = 'foreign';
        if (kind === 'bad-id') h.rows[0].plan_id = 'non/ascii';
        if (kind === 'missing-id') h.rows[0].plan_id = null;
        if (kind === 'revision-string') h.rows[0].revision = '3';
        if (kind === 'revision-negative') h.rows[0].revision = -1;
        if (kind === 'revision-overflow') h.rows[0].revision = 1025;
        if (kind === 'extra-column') h.rows[0].payload = 'private';
        if (kind === 'missing-column') delete h.rows[0].organisation_id;
        await expect(h.select()).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
        expect(h.tx.query).toHaveBeenCalledTimes(1); expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
        expect(h.auditEvents).toEqual([]); expect(actionStore.loadHistory).not.toHaveBeenCalled();
        expect(h.trace).not.toContain('commit');
    });
    test.each(['result-accessor', 'result-proxy', 'rows-proxy', 'row-accessor', 'row-proxy'])
    ('rejects %s storage output without invoking hooks', async kind => {
        const h = await selectionHarness(), hook = jest.fn(), result = {};
        if (kind === 'result-accessor') Object.defineProperty(result, 'rows', { get: hook });
        if (kind === 'result-proxy') h.tx.query.mockResolvedValue(new Proxy({ rows: h.rows }, { ownKeys: hook, getOwnPropertyDescriptor: hook }));
        else if (kind === 'rows-proxy') result.rows = new Proxy(h.rows, { get: hook, ownKeys: hook });
        else if (kind === 'row-accessor') { Object.defineProperty(h.rows[0], 'plan_id', { enumerable: true, get: hook }); result.rows = h.rows; }
        else if (kind === 'row-proxy') result.rows = [new Proxy(h.rows[0], { get: hook, ownKeys: hook })];
        if (kind !== 'result-proxy') h.tx.query.mockResolvedValue(result);
        await expect(h.select()).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
        expect(hook).not.toHaveBeenCalled(); expect(h.auditEvents).toEqual([]);
    });
    test('denies copied contexts and invalid pages before opening the transaction', async () => {
        const h = await selectionHarness();
        await expect(h.repository.listImprovementPlans(clone(h.context), h.page)).rejects.toMatchObject({ statusCode: 403 });
        await expect(h.select({ ...h.page, tenantId: 'foreign' })).rejects.toMatchObject({ statusCode: 400 });
        expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
    });
    test('denies revoked improvement access before selecting persisted heads', async () => {
        const h = await selectionHarness(); h.state.flags.enabled.improvement_plan = false;
        await expect(h.select()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
        expect(h.tx.query).not.toHaveBeenCalled(); expect(h.auditEvents).toEqual([]);
    });
    test.each(['audit', 'commit'])('failed %s withholds plan selection without retry', async phase => {
        const h = await selectionHarness();
        if (phase === 'audit') h.afterAudit = () => { throw new Error('private sink detail'); };
        else h.failCommit = true;
        await expect(h.select()).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
        expect(h.tx.query).toHaveBeenCalledTimes(1); expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
        expect(h.trace).not.toContain('commit'); expect(actionStore.loadHistory).not.toHaveBeenCalled();
    });
    test.each(['expiry', 'revocation', 'clock-regression'])('withholds plans after settled %s without claiming rollback', async kind => {
        const h = await selectionHarness();
        h.beforeCommit = () => {
            if (kind === 'expiry') h.clock.set(h.state.membershipState.memberships[0].validUntil);
            if (kind === 'revocation') h.state.flags.enabled.improvement_plan = false;
            if (kind === 'clock-regression') h.clock.advance(-1);
        };
        await expect(h.select()).rejects.toMatchObject({ code: kind === 'clock-regression'
            ? 'improvement_list_unavailable' : 'improvement_list_access_denied', statusCode: kind === 'clock-regression' ? 503 : 403 });
        expect(h.trace.at(-1)).toBe('commit'); expect(h.tx.query).toHaveBeenCalledTimes(1);
        expect(h.auditEvents).toHaveLength(1); expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    });
});
