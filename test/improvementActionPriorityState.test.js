'use strict';

const { projectImprovementActionPriorityState, ImprovementActionPriorityStateError } =
    require('../api/shared/improvementPlan/improvementActionPriorityState');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { tenantId: 'synthetic-tenant', organisationId: accepted.organisationId, planId: 'synthetic-plan' };
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
function list() {
    const state = createImprovementPlan({ ...scope, actorSubjectKey: ACTOR, createdAt: accepted.scoreAsOf },
        clone(accepted), { registry: acceptedRegistry });
    return projectImprovementActionList(state, { scope, asOf: '2026-10-21T00:00:00.000Z',
        filters: { status: 'all', owner: 'all', overdueOnly: false } });
}
const selection = model => clone({ scope: model.scope, planRevision: model.planRevision, source: model.source });
function failure(work, code, statusCode) {
    let caught;
    try { work(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ImprovementActionPriorityStateError);
    expect(caught).toMatchObject({ code, statusCode, message: code });
    expect(caught.stack).toBeUndefined(); expect(Object.isFrozen(caught)).toBe(true);
    expect(JSON.stringify(caught)).not.toMatch(/private|synthetic|assessmentId|organisationId/);
}

test('version1 names each unavailable basis while preserving exact source and scheduling semantics', () => {
    const model = list(), result = projectImprovementActionPriorityState(model, selection(model));
    expect(result).toEqual({ schemaVersion: 1, scope, planRevision: 0, source: model.source, asOf: model.asOf,
        priority: { status: 'not_calculated', reason: 'priority_adapter_required' },
        scheduling: { order: 'due_date_then_action_id', dueDateBasis: 'UTC_calendar_day', riskRanking: false },
        missingInputs: [
            { input: 'priorityMethod', state: 'not_defined', reason: 'priority_adapter_required' },
            { input: 'statedImpact', state: 'not_exposed', reason: 'per_item_impact_not_retained' },
            { input: 'priorityOverlay', state: 'not_exposed', reason: 'per_item_overlay_not_retained' },
            { input: 'riskContextSnapshot', state: 'not_exposed', reason: 'risk_snapshot_not_exposed' },
            { input: 'evidenceSnapshot', state: 'not_exposed', reason: 'evidence_snapshot_not_exposed' },
            { input: 'frameworkProfile', state: 'not_exposed', reason: 'profile_version_not_exposed' }
        ] });
    expect(result).not.toHaveProperty('actions'); expect(result).not.toHaveProperty('score');
    expect(result).not.toHaveProperty('rank'); expect(result).not.toHaveProperty('topThree');
    expect(result.missingInputs.every(input => input.state !== 'absent')).toBe(true);
});

test('diagnostic is deterministic, deeply frozen and detached without mutating either input', () => {
    const model = clone(list()), expected = selection(model), before = clone({ model, expected });
    const first = projectImprovementActionPriorityState(model, expected);
    expect(projectImprovementActionPriorityState(model, expected)).toEqual(first);
    expect({ model, expected }).toEqual(before);
    for (const value of [first, first.scope, first.source, first.priority, first.scheduling,
        first.missingInputs, ...first.missingInputs]) expect(Object.isFrozen(value)).toBe(true);
    model.source.assessmentId = 'changed'; expected.scope.organisationId = 'changed';
    expect(first.source.assessmentId).toBe(before.model.source.assessmentId);
    expect(first.scope).toEqual(before.model.scope);
});

test.each([
    ['unknown scope field', s => { s.scope.permission = 'private'; }],
    ['scope syntax', s => { s.scope.tenantId = '../private'; }],
    ['negative revision', s => { s.planRevision = -1; }],
    ['negative zero', s => { s.planRevision = -0; }],
    ['fractional revision', s => { s.planRevision = 0.5; }],
    ['revision limit', s => { s.planRevision = 1025; }],
    ['latest revision', s => { s.source.assessmentRevision = 'LaTeSt'; }],
    ['noncanonical time', s => { s.source.scoreAsOf = '2026-10-21'; }],
    ['invalid digest', s => { s.source.evaluationOutputSha256 = 'private'; }],
    ['missing digest', s => { delete s.source.evaluationOutputSha256; }],
    ['supplied risk score', s => { s.riskScore = 100; }],
    ['supplied basis', s => { s.source.riskContextSnapshot = { sha256: 'a'.repeat(64) }; }]
])('selection rejects %s with a sanitized input error', (_, change) => {
    const model = list(), expected = selection(model); change(expected);
    failure(() => projectImprovementActionPriorityState(model, expected), 'improvement_priority_input_invalid', 400);
});

test.each([
    ['forged priority', m => { m.priority = { status: 'calculated', reason: 'private' }; }],
    ['ranking order', m => { m.order = 'highest_risk_first'; }],
    ['extra retained impact', m => { m.actions[0].statedImpact = 'critical'; }],
    ['missing evidence state', m => { delete m.actions[0].evidence.assessmentState; }],
    ['verified completion', m => { m.actions[0].evidence.completionVerification = 'verified'; }],
    ['extra private field', m => { m.private = 'private'; }]
])('malformed %s is withheld instead of treated as missing basis', (_, change) => {
    const model = clone(list()), expected = selection(model); change(model);
    failure(() => projectImprovementActionPriorityState(model, expected), 'improvement_priority_unavailable', 503);
});

test('hostile accessors, proxies and JSON hooks execute no customer code', () => {
    const model = list(), expected = selection(model); let calls = 0;
    const getter = clone(expected);
    Object.defineProperty(getter, 'source', { enumerable: true, get() { calls++; return expected.source; } });
    const proxy = new Proxy(expected, { ownKeys() { calls++; return []; } });
    const hook = { ...expected, toJSON() { calls++; return {}; } };
    for (const input of [getter, proxy, hook]) {
        failure(() => projectImprovementActionPriorityState(model, input), 'improvement_priority_input_invalid', 400);
    }
    const hostileList = clone(model);
    Object.defineProperty(hostileList, 'source', { enumerable: true, get() { calls++; return model.source; } });
    failure(() => projectImprovementActionPriorityState(hostileList, expected), 'improvement_priority_unavailable', 503);
    expect(calls).toBe(0);
});
