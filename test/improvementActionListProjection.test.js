'use strict';

const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } =
    require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { evaluateAssessment } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const scope = { tenantId: 'synthetic-tenant', organisationId: fixture.organisationId, planId: 'synthetic-plan' };
const options = () => ({ scope, asOf: '2026-10-02T00:00:00.000Z', filters: { status: 'all', owner: 'all', overdueOnly: false } });
function seed() { return createImprovementPlan({ ...scope, actorSubjectKey: ACTOR, createdAt: '2026-09-14T09:00:00.000Z' },
    clone(fixture), { registry: acceptedRegistry }); }
function step(state, index, type, payload) {
    return applyImprovementActionCommand(state, { ...scope, evaluationOutputSha256: state.source.evaluationOutputSha256,
        actionId: state.proposals[index].actionId, operationId: 'op-' + state.commands.length,
        expectedRevision: state.commands.length, actorSubjectKey: ACTOR, at: '2026-09-14T09:01:00.000Z', type, payload },
    { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER, OTHER] });
}
const assign = (state, index = 0, dueDate = '2026-10-01', ownerSubjectKey = OWNER) => step(state, index, 'assign', { ownerSubjectKey, dueDate });
const run = (state, index = 0) => step(assign(state, index), index, 'start', {});
const finish = (state, index = 0) => step(run(state, index), index, 'complete', {
    note: 'Synthetic <b>completion</b> note.', evidenceReference: '證據:0|/opaque?not-a-url' });
function mixed() {
    let state = assign(seed());
    state = run(state, 1);
    state = step(run(state, 2), 2, 'block', { reason: 'Waiting on supplier.' });
    state = finish(state, 3);
    return step(finish(state, 4), 4, 'reopen', { reason: 'Review found more work.' });
}
const row = (view, state, index = 0) => view.actions.find(action => action.actionId === state.proposals[index].actionId);

test('real retained domain yields exact owner, due date, rationale, status and original assessment provenance', () => {
    const state = mixed(), view = projectImprovementActionList(state, options()), original = getImprovementPlanView(state);
    expect(view).toMatchObject({ schemaVersion: 1, scope, planRevision: state.commands.length,
        dueDateBasis: 'UTC_calendar_day', priority: { status: 'not_calculated' }, order: 'due_date_then_action_id',
        counts: { all: { total: 14, unassigned: 9, overdue: 4,
            byStatus: { open: 11, in_progress: 1, blocked: 1, completed: 1 } } } });
    expect(view.counts.visible).toEqual(view.counts.all);
    expect(row(view, state)).toMatchObject({ ownerSubjectKey: OWNER, ownerEligibility: 'not_checked',
        dueDate: '2026-10-01', status: 'open', isOverdue: true,
        rationale: { kind: original.actions[0].kind, suggestedAction: original.actions[0].suggestedAction } });
    expect(row(view, state, 2)).toMatchObject({ status: 'blocked', blockedReason: 'Waiting on supplier.' });
    expect(view.source).toEqual({ assessmentId: fixture.assessmentId, assessmentRevision: fixture.assessmentRevision,
        scoreAsOf: fixture.scoreAsOf, evaluationOutputSha256: state.source.evaluationOutputSha256 });
});

test('completion and reopening retain original history without linking or verifying evidence or changing scores', () => {
    const state = mixed(), source = clone(state.source), evaluation = evaluateAssessment(clone(fixture), { registry: acceptedRegistry });
    const view = projectImprovementActionList(state, options()), completed = row(view, state, 3), reopened = row(view, state, 4);
    expect(completed).toMatchObject({ status: 'completed', isOverdue: false,
        completion: { at: '2026-09-14T09:01:00.000Z', note: 'Synthetic <b>completion</b> note.' },
        evidence: { completionReference: '證據:0|/opaque?not-a-url', completionVerification: 'not_verified',
            durableLinkStatus: 'not_established', downloadAllowed: false, scoreEffect: 'none' } });
    expect(reopened).toMatchObject({ status: 'open', isOverdue: true, completion: null,
        evidence: { completionReference: null, completionVerification: 'not_recorded', durableLinkStatus: 'not_established' } });
    expect(reopened.history.map(event => event.type)).toEqual(['assign', 'start', 'complete', 'reopen']);
    expect(reopened.history[2].details).toEqual({ note: 'Synthetic <b>completion</b> note.',
        evidenceReference: '證據:0|/opaque?not-a-url', evidenceVerification: 'not_verified', durableLinkStatus: 'not_established' });
    expect(reopened.history[3].details.reason).toBe('Review found more work.');
    for (const event of reopened.history) expect(event).toMatchObject({ revision: expect.any(Number), at: expect.any(String) });
    expect(state.source).toEqual(source);
    expect(evaluateAssessment(clone(fixture), { registry: acceptedRegistry })).toEqual(evaluation);
});

test.each([
    ['2026-09-30T23:59:59.999Z', false], ['2026-10-01T00:00:00.000Z', false],
    ['2026-10-01T23:59:59.999Z', false], ['2026-10-02T00:00:00.000Z', true]
])('overdue uses the whole UTC due date at %s', (asOf, expected) => {
    const state = assign(seed());
    expect(row(projectImprovementActionList(state, { ...options(), asOf }), state).isOverdue).toBe(expected);
});

test('undated work is never overdue and due dates sort before undated rows without a risk ranking', () => {
    let state = assign(seed(), 0, '2026-10-04'); state = assign(state, 1, '2026-10-01'); state = assign(state, 2, '2026-10-01');
    const view = projectImprovementActionList(state, options());
    const early = [state.proposals[1].actionId, state.proposals[2].actionId].sort();
    expect(view.actions.slice(0, 3).map(action => action.actionId)).toEqual([...early, state.proposals[0].actionId]);
    expect(view.actions.slice(3).every(action => action.dueDate === null && !action.isOverdue)).toBe(true);
    expect(view.priority.status).toBe('not_calculated');
});

test.each(['open', 'in_progress', 'blocked', 'completed'])('status filter %s preserves all counts and accurate visible counts', status => {
    const state = mixed(), all = projectImprovementActionList(state, options());
    const result = projectImprovementActionList(state, { ...options(), filters: { ...options().filters, status } });
    expect(result.actions).toEqual(all.actions.filter(action => action.status === status));
    expect(result.counts.all).toEqual(all.counts.all);
    expect(result.counts.visible.total).toBe(result.actions.length);
});

test('owner and overdue filters combine, including unassigned and valid empty selections', () => {
    const state = mixed();
    const select = filters => projectImprovementActionList(state, { ...options(), filters: { ...options().filters, ...filters } });
    expect(select({ owner: OWNER, overdueOnly: true }).actions).toHaveLength(4);
    expect(select({ owner: 'unassigned' }).actions).toHaveLength(9);
    const empty = select({ owner: OTHER }); expect(empty.actions).toEqual([]);
    expect(empty.counts.visible).toEqual({ total: 0, overdue: 0, unassigned: 0,
        byStatus: { open: 0, in_progress: 0, blocked: 0, completed: 0 } });
    expect(select({ owner: 'unassigned', overdueOnly: true }).actions).toEqual([]);
});

test.each(['tenantId', 'organisationId', 'planId'])('requires exact retained %s consistency without granting authority', key => {
    expect(() => projectImprovementActionList(seed(), { ...options(), scope: { ...scope, [key]: 'foreign' } }))
        .toThrow(expect.objectContaining({ code: 'improvement_list_scope_mismatch', statusCode: 404 }));
});

test('a saved owner reference cannot assert present membership, read permission or eligible reassignment', () => {
    const state = assign(seed());
    const result = projectImprovementActionList(state, options());
    expect(row(result, state).ownerEligibility).toBe('not_checked');
    expect(result).not.toHaveProperty('permissions'); expect(result).not.toHaveProperty('canComplete');
    expect(() => projectImprovementActionList(state, { ...options(), permissions: ['improvement.write'] })).toThrow();
});

test('rejects noncanonical, invalid or pre-update asOf, unknown filters and supplied evidence candidates', () => {
    const state = assign(seed());
    for (const asOf of ['2026-10-02', '2026-10-02T12:00:00+12:00', '2026-02-30T00:00:00.000Z', null]) {
        expect(() => projectImprovementActionList(state, { ...options(), asOf })).toThrow();
    }
    expect(() => projectImprovementActionList(state, { ...options(), asOf: '2026-09-14T09:00:00.000Z' }))
        .toThrow(expect.objectContaining({ statusCode: 409 }));
    for (const filters of [{ ...options().filters, status: 'accepted_risk' }, { ...options().filters, owner: 'forged' },
        { ...options().filters, overdueOnly: 'true' }, { ...options().filters, score: 100 }]) {
        expect(() => projectImprovementActionList(state, { ...options(), filters })).toThrow();
    }
    expect(() => projectImprovementActionList(state, { ...options(), evidenceCandidate: { status: 'unpersisted' } })).toThrow();
});

test.each(['scope', 'revision', 'transition', 'reference', 'digest', 'view'])('corrupt %s state is rejected by existing replay before any partial list', kind => {
    const state = clone(finish(seed()));
    if (kind === 'scope') state.commands[0].organisationId = 'foreign';
    if (kind === 'revision') state.commands[1].expectedRevision = 80;
    if (kind === 'transition') state.commands[1].type = 'complete';
    if (kind === 'reference') state.commands[2].payload.evidenceReference = 'https://private.invalid/file';
    if (kind === 'digest') state.source.evaluationOutputSha256 = 'f'.repeat(64);
    const input = kind === 'view' ? getImprovementPlanView(seed()) : state;
    expect(() => projectImprovementActionList(input, options()))
        .toThrow(expect.objectContaining({ code: 'improvement_list_unavailable', statusCode: 503 }));
});

test('detaches and freezes repeated output while excluding internal actors, operation IDs and source extras', () => {
    const state = clone(mixed()), settings = clone(options()); state.source.provenance.internalNote = 'private-sentinel';
    const original = clone(state), result = projectImprovementActionList(state, settings);
    expect(projectImprovementActionList(state, settings)).toEqual(result); expect(state).toEqual(original);
    expect(JSON.stringify(result)).not.toMatch(/private-sentinel|actorSubjectKey|operationId|createdBy|completedBy/);
    expect(Object.isFrozen(result.actions[0].history)).toBe(true); expect(Object.isFrozen(result.counts.visible.byStatus)).toBe(true);
    state.commands[0].payload.dueDate = '2030-01-01'; settings.filters.owner = OTHER;
    expect(result.filters.owner).toBe('all'); expect(result.actions.some(action => action.dueDate === '2030-01-01')).toBe(false);
});

test('hostile accessors, proxies and JSON hooks do not run', () => {
    let hooks = 0; const state = clone(seed());
    Object.defineProperty(state, 'commands', { enumerable: true, get() { hooks++; return []; } });
    const proxy = new Proxy(clone(seed()), { ownKeys() { hooks++; return []; } });
    const hooked = { ...clone(seed()), toJSON() { hooks++; return {}; } };
    for (const input of [state, proxy, hooked]) expect(() => projectImprovementActionList(input, options())).toThrow();
    const settings = options(); Object.defineProperty(settings, 'asOf', { enumerable: true, get() { hooks++; return ''; } });
    expect(() => projectImprovementActionList(seed(), settings)).toThrow(); expect(hooks).toBe(0);
});
