'use strict';

const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { planCarryForward, carryOperationId } = require('../api/shared/improvementPlan/improvementPlanCarryForward');
const { createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json');

const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const registry = createFrameworkRegistry([createAcceptedNcscFrameworkProfile()]);
const AT = '2026-09-14T09:01:00.000Z';
function plan(planId) {
    return createImprovementPlan({ tenantId: 'synthetic-tenant', organisationId: fixture.input.organisationId, planId,
        createdAt: '2026-09-14T09:00:00.000Z', actorSubjectKey: ACTOR }, clone(fixture.input), { registry });
}
function apply(state, actionId, type, payload) {
    return applyImprovementActionCommand(state, { tenantId: state.tenantId, organisationId: state.organisationId,
        planId: state.planId, evaluationOutputSha256: state.source.evaluationOutputSha256, actionId,
        operationId: `op-${state.commands.length}`, expectedRevision: state.commands.length, actorSubjectKey: ACTOR,
        at: AT, type, payload }, { tenantId: state.tenantId, organisationId: state.organisationId,
        actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] });
}
// A previous plan from an earlier assessment with one action in each state.
function previousView() {
    let state = plan('previous-plan');
    const [a, b, c, d, e] = state.proposals.map(row => row.actionId);
    const label = { ownerLabel: 'Ops lead', dueDate: '2026-10-01' }, subject = { ownerSubjectKey: OWNER, dueDate: '2026-11-01' };
    state = apply(state, a, 'assign', label);
    state = apply(apply(state, b, 'assign', subject), b, 'start', {});
    state = apply(apply(apply(state, c, 'assign', label), c, 'start', {}), c, 'block', { reason: 'Waiting on supplier.' });
    state = apply(apply(apply(state, d, 'assign', subject), d, 'start', {}), d, 'complete',
        { note: 'Synthetic work done.', evidenceReference: 'evidence:synthetic-1' });
    void e; // left unassigned
    const view = clone(getImprovementPlanView(state));
    view.source.provenance.assessmentId = 'earlier-assessment';
    view.source.provenance.scoreAsOf = '2026-01-01T00:00:00.000Z';
    return view;
}

test('carries owner, due date and open-work status by question, and reopens completed gaps', () => {
    const previous = previousView(), next = getImprovementPlanView(plan('next-plan'));
    const carried = planCarryForward(previous, next);
    const byItem = new Map(next.actions.map(action => [action.itemId, action.actionId]));
    expect(carried).toEqual(previous.actions.slice(0, 4).map((action, index) => ({
        actionId: byItem.get(action.itemId), itemId: action.itemId,
        ownerSubjectKey: [1, 3].includes(index) ? OWNER : null,
        steps: [
            { type: 'assign', payload: [1, 3].includes(index) ? { ownerSubjectKey: OWNER, dueDate: '2026-11-01' }
                : { ownerLabel: 'Ops lead', dueDate: '2026-10-01' } },
            ...([1, 2].includes(index) ? [{ type: 'start', payload: {} }] : []),
            ...(index === 2 ? [{ type: 'block', payload: { reason: 'Waiting on supplier.' } }] : [])
        ] })));
    // Action IDs are per plan; matching is by the assessment question.
    expect(carried.every(row => !previous.actions.some(action => action.actionId === row.actionId))).toBe(true);
});

test('carried steps replay through the real domain to the expected statuses', () => {
    let state = plan('next-plan');
    for (const action of planCarryForward(previousView(), getImprovementPlanView(state))) {
        for (const step of action.steps) state = apply(state, action.actionId, step.type, step.payload);
    }
    const actions = getImprovementPlanView(state).actions;
    expect(actions.slice(0, 5).map(action => [action.status, action.ownerLabel ?? action.ownerSubjectKey, action.dueDate, action.blockedReason]))
        .toEqual([['open', 'Ops lead', '2026-10-01', null], ['in_progress', OWNER, '2026-11-01', null],
            ['blocked', 'Ops lead', '2026-10-01', 'Waiting on supplier.'], ['open', OWNER, '2026-11-01', null],
            ['open', null, null, null]]);
    expect(actions.every(action => action.completion === null)).toBe(true);
});

test('closed gaps are not carried, and unrelated or later sources carry nothing', () => {
    const previous = previousView(), next = clone(getImprovementPlanView(plan('next-plan')));
    next.actions = next.actions.slice(1);
    expect(planCarryForward(previous, next).map(row => row.itemId)).toEqual(previous.actions.slice(1, 4).map(row => row.itemId));
    for (const change of [
        view => { view.source.provenance.moduleId = 'other-module'; },
        view => { view.source.provenance.assessmentId = next.source.provenance.assessmentId; },
        view => { view.source.provenance.scoreAsOf = '2999-01-01T00:00:00.000Z'; },
        view => { delete view.source; }
    ]) {
        const altered = clone(previous); change(altered);
        expect(planCarryForward(altered, next)).toEqual([]);
    }
});

test('carry operation IDs name the exact source revision and stay valid identifiers', () => {
    const id = carryOperationId('a'.repeat(64), 1024);
    expect(id).toBe(`carry:${'a'.repeat(64)}:1024`);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
});
