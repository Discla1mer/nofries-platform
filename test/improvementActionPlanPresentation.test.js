'use strict';

// Synthetic accepted assessment -> real domain lifecycle -> real list -> pure
// presentation. No repository, request, audit, lookup or runtime binding is used.
const { projectImprovementActionPlanPresentation, ImprovementActionPlanPresentationError } =
    require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { EVIDENCE_STATES, evaluateAssessment, calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256 } =
    require('../api/shared/assessmentEngine/assessmentEvaluator');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const scope = { tenantId: 'synthetic-tenant', organisationId: accepted.organisationId, planId: 'synthetic-plan' };
const AS_OF = '2026-10-02T00:00:00.000Z';
const FILTERS = Object.freeze({ status: 'all', owner: 'all', overdueOnly: false });
const NOTE = 'Synthetic 證據 <img src=x onerror=alert(1)> completion.\nReview still required.';
const EVIDENCE = '證據:<svg onload=alert(1)>|opaque*?not-a-url';
const REASON = 'Synthetic <script>alert("waiting")</script> 等待.';
function seed(input = accepted) {
    const bound = clone(input);
    bound.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(bound.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    bound.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(bound.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
    return createImprovementPlan({ ...scope, actorSubjectKey: ACTOR, createdAt: '2026-09-14T09:00:00.000Z' },
        bound, { registry: acceptedRegistry });
}
function step(state, index, type, payload) {
    const revision = state.commands.length;
    return applyImprovementActionCommand(state, { ...scope, actorSubjectKey: ACTOR, type, payload,
        evaluationOutputSha256: state.source.evaluationOutputSha256, actionId: state.proposals[index].actionId,
        operationId: 'operation-' + revision, expectedRevision: revision,
        at: new Date(Date.parse('2026-09-14T09:01:00.000Z') + revision * 60000).toISOString() },
    { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: ACTOR,
        eligibleOwnerSubjectKeys: [OWNER, OTHER] });
}
const assign = (state, index = 0, ownerSubjectKey = OWNER, dueDate = '2026-10-01') =>
    step(state, index, 'assign', { ownerSubjectKey, dueDate });
const run = (state, index) => step(assign(state, index), index, 'start', {});
const complete = (state, index) => step(run(state, index), index, 'complete', { note: NOTE, evidenceReference: EVIDENCE });
function mixed() {
    let state = assign(seed());
    state = run(state, 1);
    state = step(run(state, 2), 2, 'block', { reason: REASON });
    state = complete(state, 3);
    return step(complete(state, 4), 4, 'reopen', { reason: 'Synthetic 再確認 <b>further work</b>.' });
}
const listOf = (state, filters = FILTERS, asOf = AS_OF) => projectImprovementActionList(state, { scope, filters, asOf });
const row = (model, state, index = 0) => model.actions.find(action => action.actionId === state.proposals[index].actionId);
function withoutPresentation(model) {
    const { presentationVersion, notices, actions, ...root } = model;
    return { ...root, actions: actions.map(action => {
        const { labels, history, ...original } = action;
        return { ...original, history: history.map(event => { const { label, ...retained } = event; return retained; }) };
    }) };
}
function assertUnavailable(work) {
    let caught;
    try { work(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ImprovementActionPlanPresentationError);
    expect(caught).toMatchObject({ code: 'improvement_presentation_unavailable', statusCode: 503,
        message: 'improvement_presentation_unavailable' });
    expect(caught.stack).toBeUndefined(); expect(Object.isFrozen(caught)).toBe(true);
    expect(JSON.stringify(caught)).not.toMatch(/private|source payload|assessmentId|ownerSubjectKey|evidenceReference/);
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('all four retained gap kinds become readable while every original list value is preserved', () => {
    const state = mixed(), list = listOf(state), before = clone(list);
    const presentation = projectImprovementActionPlanPresentation(list);
    expect(presentation.presentationVersion).toBe(1);
    expect(withoutPresentation(presentation)).toEqual(list); expect(list).toEqual(before);
    const kinds = new Map(presentation.actions.map(action => [action.rationale.kind, action.labels.kind]));
    expect(Object.fromEntries(kinds)).toEqual({ implementation: 'Implementation gap', evidence: 'Evidence gap',
        assessment: 'Assessment needed', applicability: 'Applicability review' });
    expect(row(presentation, state)).toMatchObject({ ownerSubjectKey: OWNER, ownerEligibility: 'not_checked',
        dueDate: '2026-10-01', status: 'open', isOverdue: true,
        labels: { status: 'Open', owner: 'Assigned (eligibility not checked)', response: 'Partly implemented',
            responseOrigin: 'Recorded response', evidenceState: 'Self-attested' } });
    expect(presentation.actions.find(action => action.ownerSubjectKey === null).labels.owner).toBe('Unassigned');
    expect(row(presentation, state, 1).labels.status).toBe('In progress');
    expect(row(presentation, state, 2)).toMatchObject({ labels: { status: 'Blocked' }, blockedReason: REASON });
    const applicability = presentation.actions.find(action => action.rationale.kind === 'applicability');
    expect(applicability).toMatchObject({ labels: { response: 'Unknown',
        responseOrigin: 'Not-applicable claim awaiting approval', evidenceState: 'Not provided' } });
    expect(presentation.actions.find(action => action.rationale.responseOrigin === 'direct_unknown').labels.responseOrigin)
        .toBe('Recorded as unknown');
    expect(presentation.actions.find(action => action.rationale.response === 'yes').labels.response).toBe('Yes');
    expect(presentation.actions.find(action => action.rationale.response === 'no').labels.response).toBe('No');
});

test('completion remains unverified workflow history and reopening clears only current completion', () => {
    const state = mixed(), list = listOf(state), model = projectImprovementActionPlanPresentation(list);
    const completed = row(model, state, 3), reopened = row(model, state, 4);
    expect(completed).toMatchObject({ labels: { status: 'Completed' }, isOverdue: false,
        completion: { at: '2026-09-14T09:09:00.000Z', note: NOTE }, evidence: {
            completionReference: EVIDENCE, completionVerification: 'not_verified', durableLinkStatus: 'not_established',
            downloadAllowed: false, scoreEffect: 'none' } });
    expect(reopened).toMatchObject({ status: 'open', completion: null, isOverdue: true,
        evidence: { completionReference: null, completionVerification: 'not_recorded' } });
    expect(reopened.history.map(event => event.label)).toEqual(['Assigned', 'Started', 'Completed', 'Reopened']);
    expect(reopened.history[2].details).toEqual({ note: NOTE, evidenceReference: EVIDENCE,
        evidenceVerification: 'not_verified', durableLinkStatus: 'not_established' });
    expect(completed.history.map(event => event.revision)).toEqual([7, 8, 9]);
    expect(reopened.history.map(event => event.revision)).toEqual([10, 11, 12, 13]);
    expect(row(model, state, 2).history.map(event => event.label)).toEqual(['Assigned', 'Started', 'Blocked']);
    expect(model.planRevision).toBe(13); expect(model.updatedAt).toBe('2026-09-14T09:13:00.000Z');
    expect(completed.history.at(-1).at).not.toBe(model.updatedAt);
    expect(withoutPresentation(model)).toEqual(list);
});

test('notices preserve uncalculated priority, operational order and owner/evidence uncertainty', () => {
    const model = projectImprovementActionPlanPresentation(listOf(mixed()));
    expect(model.notices).toEqual({ priority: 'Risk priority has not been calculated.',
        order: 'Ordered by due date, then action ID. This is not a risk ranking.',
        evidence: 'Completion records workflow progress. Evidence references are unverified, downloads are unavailable, and scores are unchanged.',
        owner: 'Owner references do not confirm current membership or permission.' });
    expect(model.priority).toEqual({ status: 'not_calculated', reason: 'priority_adapter_required' });
    expect(model.order).toBe('due_date_then_action_id');
    for (const action of model.actions) {
        expect(action).not.toHaveProperty('rank'); expect(action).not.toHaveProperty('riskScore');
        expect(action).not.toHaveProperty('personName'); expect(action).not.toHaveProperty('questionText');
        expect(action).not.toHaveProperty('canComplete');
    }
    expect(JSON.stringify(model)).not.toMatch(/actorSubjectKey|operationId|createdBy|completedBy/);
});

test.each([
    { status: 'open', owner: OWNER, overdueOnly: true },
    { status: 'in_progress', owner: 'all', overdueOnly: false },
    { status: 'blocked', owner: 'all', overdueOnly: false },
    { status: 'completed', owner: 'all', overdueOnly: false },
    { status: 'all', owner: 'unassigned', overdueOnly: false },
    { status: 'all', owner: OTHER, overdueOnly: false }
])('retains exact filters, visible rows and plan-wide counts for %j', filters => {
    const state = mixed(), all = listOf(state), list = listOf(state, filters);
    const model = projectImprovementActionPlanPresentation(list);
    expect(withoutPresentation(model)).toEqual(list);
    expect(model.counts.all).toEqual(all.counts.all);
    expect(model.counts.visible.total).toBe(model.actions.length);
    expect(model.actions.map(action => action.actionId)).toEqual(list.actions.map(action => action.actionId));
    expect(model.updatedAt).toBe(all.updatedAt); expect(model.planRevision).toBe(13);
});

test('a genuinely empty generated plan and an empty filtered list both remain valid', () => {
    const noGaps = clone(accepted);
    noGaps.atomInputs = noGaps.atomInputs.map(atom => ({ itemId: atom.itemId, response: { optionId: 'yes' },
        evidenceState: 'documented_current', statedImpact: 'unspecified', priorityOverlay: 'none' }));
    const list = listOf(seed(noGaps)), empty = projectImprovementActionPlanPresentation(list);
    expect(empty.actions).toEqual([]); expect(empty.planRevision).toBe(0);
    expect(empty.counts.all).toEqual({ total: 0, unassigned: 0, overdue: 0,
        byStatus: { open: 0, in_progress: 0, blocked: 0, completed: 0 } });
    expect(withoutPresentation(empty)).toEqual(list);
    const filtered = projectImprovementActionPlanPresentation(listOf(mixed(), { ...FILTERS, owner: OTHER }));
    expect(filtered.actions).toEqual([]); expect(filtered.counts.visible.total).toBe(0);
    expect(filtered.counts.all.total).toBe(14); expect(filtered.planRevision).toBe(13);
});

test('UTC due-date status is retained from the list without a presentation-time clock recalculation', () => {
    const state = assign(seed()), before = listOf(state, FILTERS, '2026-10-01T23:59:59.999Z');
    const after = listOf(state, FILTERS, '2026-10-02T00:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2035-01-01T00:00:00.000Z'));
    const modelBefore = projectImprovementActionPlanPresentation(before), modelAfter = projectImprovementActionPlanPresentation(after);
    expect(row(modelBefore, state).isOverdue).toBe(false); expect(row(modelAfter, state).isOverdue).toBe(true);
    expect(modelBefore.asOf).toBe(before.asOf); expect(modelAfter.asOf).toBe(after.asOf);
    expect(modelBefore.dueDateBasis).toBe('UTC_calendar_day');
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    expect(projectImprovementActionPlanPresentation(before)).toEqual(modelBefore);
});

test('source identity and original evaluation remain unchanged without current catalogue text lookup', () => {
    const state = mixed(), sourceBefore = clone(state.source), before = evaluateAssessment(clone(accepted), { registry: acceptedRegistry });
    const list = listOf(state), model = projectImprovementActionPlanPresentation(list);
    expect(model.source).toEqual({ assessmentId: accepted.assessmentId, assessmentRevision: accepted.assessmentRevision,
        scoreAsOf: accepted.scoreAsOf, evaluationOutputSha256: state.source.evaluationOutputSha256 });
    expect(state.source).toEqual(sourceBefore);
    expect(evaluateAssessment(clone(accepted), { registry: acceptedRegistry })).toEqual(before);
    expect(Object.keys(model.source).sort()).toEqual(Object.keys(list.source).sort());
});

test.each([
    ['not_provided', 'Not provided'], ['attested', 'Self-attested'], ['documented_current', 'Documented as current'],
    ['tested_or_observed_current', 'Tested or observed as current'], ['independently_reviewed_current', 'Independently reviewed as current'],
    ['stale', 'Stale'], ['inaccessible', 'Inaccessible'], ['disputed', 'Disputed'], ['unavailable', 'Unavailable']
])('retained evidence vocabulary %s is readable without asserting verification', (evidenceState, label) => {
    const input = clone(accepted); input.atomInputs[0].evidenceState = evidenceState;
    const state = seed(input), model = projectImprovementActionPlanPresentation(listOf(state));
    expect(row(model, state)).toMatchObject({ labels: { evidenceState: label }, evidence: {
        assessmentState: evidenceState, completionVerification: 'not_recorded', downloadAllowed: false, scoreEffect: 'none' } });
    expect(EVIDENCE_STATES).toContain(evidenceState);
});

test('a missing original response is presented as missing rather than a recorded answer', () => {
    const input = clone(accepted), itemId = input.atomInputs[0].itemId;
    delete input.atomInputs[0].response;
    const model = projectImprovementActionPlanPresentation(listOf(seed(input)));
    expect(model.actions.find(action => action.itemId === itemId)).toMatchObject({ rationale: { responseOrigin: 'missing' },
        labels: { response: 'Unknown', responseOrigin: 'No response recorded', kind: 'Assessment needed' } });
});

test('output is detached and recursively frozen, and Unicode/HTML-looking content remains exact inert data', () => {
    const state = mixed(), input = clone(listOf(state)), before = clone(input), model = projectImprovementActionPlanPresentation(input);
    expect(input).toEqual(before);
    expect(row(model, state, 3).completion.note).toBe(NOTE);
    expect(row(model, state, 3).evidence.completionReference).toBe(EVIDENCE);
    expect(row(model, state, 2).blockedReason).toBe(REASON);
    function checkFrozen(value) {
        if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(checkFrozen); }
    }
    checkFrozen(model);
    input.scope.planId = 'mutated'; input.source.assessmentId = 'mutated'; input.counts.all.total = 1;
    input.actions.find(action => action.status === 'completed').completion.note = 'mutated';
    expect(withoutPresentation(model)).toEqual(before);
    expect(() => { model.actions[0].labels.status = 'mutated'; }).toThrow(TypeError);
    expect(projectImprovementActionPlanPresentation(before)).toEqual(model);
});

const corruptions = [
    ['root extra field', input => { input.privateDetail = 'private source payload'; }],
    ['root schema', input => { input.schemaVersion = 2; }],
    ['scope shape', input => { input.scope.extra = 'private'; }],
    ['source shape', input => { input.source.profileText = 'private invented wording'; }],
    ['priority claim', input => { input.priority.status = 'ranked'; }],
    ['order vocabulary', input => { input.order = 'highest_risk_first'; }],
    ['time shape', input => { input.asOf = '2026-10-02'; }],
    ['date basis', input => { input.dueDateBasis = 'local'; }],
    ['filter shape', input => { input.filters.extra = true; }],
    ['count shape', input => { input.counts.all.extra = 1; }],
    ['visible count mismatch', input => { input.counts.visible.total++; }],
    ['action shape', input => { input.actions[0].rank = 1; }],
    ['status vocabulary', input => { input.actions[0].status = 'verified'; }],
    ['owner eligibility claim', input => { input.actions[0].ownerEligibility = 'eligible'; }],
    ['due date shape', input => { input.actions[0].dueDate = '2026-02-30'; }],
    ['rationale shape', input => { input.actions[0].rationale.questionText = 'private invented wording'; }],
    ['gap vocabulary', input => { input.actions[0].rationale.kind = 'risk'; }],
    ['response vocabulary', input => { input.actions[0].rationale.response = 'approved_not_applicable'; }],
    ['response origin vocabulary', input => { input.actions[0].rationale.responseOrigin = 'generated'; }],
    ['evidence vocabulary', input => { input.actions[0].evidence.assessmentState = 'verified'; }],
    ['download claim', input => { input.actions[0].evidence.downloadAllowed = true; }],
    ['score claim', input => { input.actions[0].evidence.scoreEffect = 'improved'; }],
    ['completion shape', input => { input.actions.find(action => action.completion).completion.extra = true; }],
    ['history vocabulary', input => { input.actions.find(action => action.history.length).history[0].type = 'verified'; }],
    ['history shape', input => { input.actions.find(action => action.history.length).history[0].actorSubjectKey = ACTOR; }],
    ['history details shape', input => { input.actions.find(action => action.history.length).history[0].details.extra = true; }]
];
test.each(corruptions)('malformed %s fails closed with only a sanitized presentation error', (name, corrupt) => {
    const input = clone(listOf(mixed())); corrupt(input);
    assertUnavailable(() => projectImprovementActionPlanPresentation(input));
});

test('malformed roots, oversized values and re-presented models are rejected without partial output', () => {
    for (const input of [undefined, null, [], {}, projectImprovementActionPlanPresentation(listOf(seed()))]) {
        assertUnavailable(() => projectImprovementActionPlanPresentation(input));
    }
    const large = clone(listOf(seed())); large.actions[0].rationale.suggestedAction = 'x'.repeat(2 * 1024 * 1024);
    assertUnavailable(() => projectImprovementActionPlanPresentation(large));
});

test('hostile accessors, proxies and JSON hooks are rejected without executing hooks', () => {
    let hooks = 0;
    const accessor = clone(listOf(mixed()));
    Object.defineProperty(accessor.actions[0].rationale, 'kind', { enumerable: true, get() { hooks++; return 'implementation'; } });
    const proxy = new Proxy(clone(listOf(seed())), { ownKeys() { hooks++; return []; } });
    const hooked = { ...clone(listOf(seed())), toJSON() { hooks++; return {}; } };
    for (const input of [accessor, proxy, hooked]) assertUnavailable(() => projectImprovementActionPlanPresentation(input));
    expect(hooks).toBe(0);
});
