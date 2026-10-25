'use strict';

// Independent synthetic acceptance: genuine accepted assessment -> retained
// action commands -> existing list -> priority-state diagnostic. This suite
// exercises no request host, repository, database, evidence reader or UI.
const { ImprovementActionPriorityStateError, projectImprovementActionPriorityState } =
    require('../api/shared/improvementPlan/improvementActionPriorityState');
const { createImprovementPlan, applyImprovementActionCommand } =
    require('../api/shared/improvementPlan/improvementPlanDomain');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { evaluateAssessment, calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256 } =
    require('../api/shared/assessmentEngine/assessmentEvaluator');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const SCOPE = Object.freeze({ tenantId: 'synthetic-priority-tenant', organisationId: accepted.organisationId,
    planId: 'synthetic-priority-plan' });
const FILTERS = Object.freeze({ status: 'all', owner: 'all', overdueOnly: false });
const AS_OF = '2026-10-02T00:00:00.000Z';
const PRIORITY = Object.freeze({ status: 'not_calculated', reason: 'priority_adapter_required' });

function seed(changeInput = () => {}) {
    const input = clone(accepted);
    changeInput(input);
    input.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(
        input.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    input.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(
        input.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
    return { input, state: createImprovementPlan({ ...SCOPE, actorSubjectKey: ACTOR,
        createdAt: '2026-09-14T09:00:00.000Z' }, input, { registry: acceptedRegistry }) };
}
function step(state, type, payload) {
    const revision = state.commands.length;
    return applyImprovementActionCommand(state, { ...SCOPE, actionId: state.proposals[0].actionId,
        evaluationOutputSha256: state.source.evaluationOutputSha256, operationId: 'acceptance-' + revision,
        expectedRevision: revision, actorSubjectKey: ACTOR,
        at: new Date(Date.parse('2026-09-14T09:01:00.000Z') + revision * 60000).toISOString(), type, payload },
    { tenantId: SCOPE.tenantId, organisationId: SCOPE.organisationId,
        actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] });
}
function listOf(state, filters = FILTERS, asOf = AS_OF) {
    return projectImprovementActionList(state, { scope: SCOPE, filters, asOf });
}
function selectionOf(list) {
    return clone({ scope: list.scope, planRevision: list.planRevision, source: list.source });
}
function diagnose(list, selection = selectionOf(list)) {
    return projectImprovementActionPriorityState(list, selection);
}
function expectError(work, code, statusCode) {
    let error;
    try { work(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ImprovementActionPriorityStateError);
    expect(error).toMatchObject({ code, statusCode });
}

test('retained list has an explicit missing priority basis rather than fabricated risk or compliance values', () => {
    const { state } = seed(), list = listOf(state), result = diagnose(list);
    expect(result).toEqual({ schemaVersion: 1, scope: SCOPE, planRevision: 0, source: list.source, asOf: AS_OF,
        priority: PRIORITY, scheduling: { order: 'due_date_then_action_id', dueDateBasis: 'UTC_calendar_day', riskRanking: false },
        missingInputs: [
            { input: 'priorityMethod', state: 'not_defined', reason: 'priority_adapter_required' },
            { input: 'statedImpact', state: 'not_exposed', reason: 'per_item_impact_not_retained' },
            { input: 'priorityOverlay', state: 'not_exposed', reason: 'per_item_overlay_not_retained' },
            { input: 'riskContextSnapshot', state: 'not_exposed', reason: 'risk_snapshot_not_exposed' },
            { input: 'evidenceSnapshot', state: 'not_exposed', reason: 'evidence_snapshot_not_exposed' },
            { input: 'frameworkProfile', state: 'not_exposed', reason: 'profile_version_not_exposed' }
        ] });
    expect(result).not.toHaveProperty('actions'); expect(result).not.toHaveProperty('riskScore');
    expect(result).not.toHaveProperty('complianceScore'); expect(result).not.toHaveProperty('topThree');
});

test('completing and reopening genuine retained work never calculates priority or changes the original assessment', () => {
    const { state: initial, input } = seed(), sourceBefore = clone(initial.source);
    const evaluationBefore = evaluateAssessment(input, { registry: acceptedRegistry });
    const assigned = step(initial, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
    const running = step(assigned, 'start', {});
    const completed = step(running, 'complete', { note: 'Synthetic work completed; evidence review still required.',
        evidenceReference: 'synthetic:unverified-reference' });
    const reopened = step(completed, 'reopen', { reason: 'Synthetic review identified more work.' });
    const snapshots = [initial, assigned, running, completed, reopened].map(state => listOf(state));
    const results = snapshots.map(list => diagnose(list));
    expect(results.map(result => result.planRevision)).toEqual([0, 1, 2, 3, 4]);
    for (const result of results) {
        expect(result.priority).toEqual(PRIORITY);
        expect(result.missingInputs).toEqual(results[0].missingInputs);
        expect(result.scheduling.riskRanking).toBe(false);
        expect(result.source).toEqual(results[0].source);
    }
    const completedAction = snapshots[3].actions.find(action => action.actionId === initial.proposals[0].actionId);
    const reopenedAction = snapshots[4].actions.find(action => action.actionId === initial.proposals[0].actionId);
    expect(completedAction.evidence).toMatchObject({ completionVerification: 'not_verified', scoreEffect: 'none' });
    expect(reopenedAction).toMatchObject({ status: 'open', completion: null,
        evidence: { completionReference: null, completionVerification: 'not_recorded', scoreEffect: 'none' } });
    expect(reopenedAction.history.map(event => event.type)).toEqual(['assign', 'start', 'complete', 'reopen']);
    expect(reopened.source).toEqual(sourceBefore);
    expect(evaluateAssessment(input, { registry: acceptedRegistry })).toEqual(evaluationBefore);
});

test('an overdue boundary changes scheduling facts without becoming a risk-priority signal', () => {
    const state = step(seed().state, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
    const before = listOf(state, FILTERS, '2026-10-01T23:59:59.999Z');
    const after = listOf(state, FILTERS, '2026-10-02T00:00:00.000Z');
    const action = list => list.actions.find(row => row.actionId === state.proposals[0].actionId);
    expect(action(before).isOverdue).toBe(false); expect(action(after).isOverdue).toBe(true);
    const left = diagnose(before), right = diagnose(after);
    expect(left.priority).toEqual(right.priority); expect(right.priority).toEqual(PRIORITY);
    expect(left.missingInputs).toEqual(right.missingInputs);
    expect(left.scheduling).toEqual(right.scheduling); expect(right.scheduling.riskRanking).toBe(false);
    expect(left.asOf).toBe(before.asOf); expect(right.asOf).toBe(after.asOf);
});

test.each(['not_provided', 'unavailable', 'stale'])('%s evidence remains missing basis rather than low risk', evidenceState => {
    const { state } = seed(input => { input.atomInputs[0].evidenceState = evidenceState; });
    const list = listOf(state), result = diagnose(list);
    expect(list.actions.find(action => action.actionId === state.proposals[0].actionId).evidence.assessmentState).toBe(evidenceState);
    expect(result.priority).toEqual(PRIORITY);
    expect(result.missingInputs).toContainEqual({ input: 'evidenceSnapshot', state: 'not_exposed', reason: 'evidence_snapshot_not_exposed' });
    expect(result).not.toHaveProperty('evidenceConfidence'); expect(result).not.toHaveProperty('riskScore');
});

test('retained source changes cannot turn an omitted impact value into a priority estimate', () => {
    const high = seed(input => { input.atomInputs[0].statedImpact = 'high'; });
    const unknown = seed(input => { input.atomInputs[0].statedImpact = 'unspecified'; });
    const highList = listOf(high.state), unknownList = listOf(unknown.state);
    const highResult = diagnose(highList), unknownResult = diagnose(unknownList);
    expect(highResult.source.evaluationOutputSha256).not.toBe(unknownResult.source.evaluationOutputSha256);
    expect(highResult.priority).toEqual(unknownResult.priority);
    expect(highResult.missingInputs).toEqual(unknownResult.missingInputs);
    expect(unknownResult.missingInputs).toContainEqual({ input: 'statedImpact', state: 'not_exposed', reason: 'per_item_impact_not_retained' });
});

test('a selection retained before a real command cannot diagnose the newer plan revision', () => {
    const initial = seed().state, selected = selectionOf(listOf(initial));
    const assigned = step(initial, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
    const current = listOf(assigned);
    expectError(() => diagnose(current, selected), 'improvement_priority_selection_conflict', 409);
    expect(diagnose(current).planRevision).toBe(1);
    expect(selected.planRevision).toBe(0);
});

test.each([
    ['assessmentId', 'synthetic-prior-assessment'],
    ['assessmentRevision', 'rev-0'],
    ['scoreAsOf', '2026-09-07T09:59:59.999Z'],
    ['evaluationOutputSha256', 'f'.repeat(64)]
])('an exact selection with a different %s conflicts without substituting current source', (field, value) => {
    const list = listOf(seed().state), selected = selectionOf(list), original = clone(list);
    selected.source[field] = value;
    expectError(() => diagnose(list, selected), 'improvement_priority_selection_conflict', 409);
    expect(selected.source[field]).toBe(value); expect(list).toEqual(original);
});

test('a foreign organisation selection yields no diagnostic for the retained plan', () => {
    const list = listOf(seed().state), selected = selectionOf(list);
    selected.scope.organisationId = 'synthetic-foreign-organisation';
    expectError(() => diagnose(list, selected), 'improvement_priority_scope_mismatch', 404);
    expect(diagnose(list).scope.organisationId).toBe(SCOPE.organisationId);
});

test('empty and filtered selections do not manufacture priority from the visible population', () => {
    const state = seed().state, all = listOf(state), empty = listOf(state, { ...FILTERS, status: 'completed' });
    expect(all.actions.length).toBeGreaterThan(3); expect(empty.actions).toEqual([]);
    expect(empty.counts.all).toEqual(all.counts.all);
    expect(diagnose(empty)).toEqual(diagnose(all));
});

test('diagnostics detach and freeze both selected identity and reasons without mutating retained inputs', () => {
    const list = clone(listOf(seed().state)), selected = selectionOf(list), original = clone({ list, selected });
    const result = diagnose(list, selected);
    expect({ list, selected }).toEqual(original); expect(diagnose(list, selected)).toEqual(result);
    for (const value of [result, result.scope, result.source, result.priority, result.scheduling,
        result.missingInputs, ...result.missingInputs]) expect(Object.isFrozen(value)).toBe(true);
    list.source.assessmentRevision = 'rev-99'; selected.scope.organisationId = 'synthetic-changed';
    expect(result.source.assessmentRevision).toBe(original.list.source.assessmentRevision);
    expect(result.scope.organisationId).toBe(original.selected.scope.organisationId);
});
