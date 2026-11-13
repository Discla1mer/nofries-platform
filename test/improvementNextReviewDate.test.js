'use strict';

const crypto = require('node:crypto');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { normaliseImprovementCommand } = require('../api/shared/improvementPlan/improvementPlanService');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { mount } = require('../api/shared/protectedAssets/improvementActionPlanView');
const { acceptedRegistry: registry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { createDom } = require('./fixtures/dashboardDom');
const input = require('./fixtures/ncscAcceptedEvaluation.json').input;
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const scope = { tenantId: 'synthetic-tenant', organisationId: input.organisationId, planId: 'synthetic-plan' };
const context = { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [ACTOR] };
const payload = { note: 'Completed synthetic work.', evidenceReference: 'evidence:synthetic' };
const clone = value => JSON.parse(JSON.stringify(value));
function command(state, type, details) {
    return { ...scope, evaluationOutputSha256: state.source.evaluationOutputSha256, actionId: state.proposals[0].actionId,
        operationId: 'op-' + state.commands.length, expectedRevision: state.commands.length,
        actorSubjectKey: ACTOR, at: '2026-09-14T09:01:00.000Z', type, payload: details };
}
function step(state, type, details) { return applyImprovementActionCommand(state, command(state, type, details), context); }
function running() {
    const state = createImprovementPlan({ ...scope, createdAt: '2026-09-14T09:00:00.000Z', actorSubjectKey: ACTOR }, input, { registry });
    return step(step(state, 'assign', { ownerSubjectKey: ACTOR, dueDate: '2026-10-01' }), 'start', {});
}
function model(state) {
    return projectImprovementActionPlanPresentation(projectImprovementActionList(state, { scope,
        asOf: '2027-01-01T00:00:00.000Z', filters: { status: 'all', owner: 'all', overdueOnly: false } }));
}
function wire(state, details) {
    const { planId, type, operationId, expectedRevision, actionId, payload } = command(state, 'complete', details);
    return { planId, type, operationId, expectedRevision, actionId, payload };
}

test('legacy completion keeps its pre-change receipt digest and no invented review date', () => {
    const state = step(running(), 'complete', payload), result = { schemaVersion: 1, plan: getImprovementPlanView(state) };
    // Captured from origin/main 7860d1d before this change.
    expect(crypto.createHash('sha256').update(serialiseAssessmentEvaluation(result)).digest('hex'))
        .toBe('cc98a9469ffbbf0052b948d55c5b916cacbd06508d717188b7b57ffdcdf14d81');
    expect(result.plan.actions[0].completion).not.toHaveProperty('nextReviewDate');
    expect(normaliseImprovementCommand(wire(running(), payload)).payload).toEqual(payload);
    const dom = createDom(); mount(dom.root, model(state)); expect(dom.root.textContent).toContain('Next review date (UTC) Not set');
});

test.each(['2026-09-14', '2026-12-01'])('retains %s through reload, history and replay without verification or score changes', nextReviewDate => {
    const initial = running(), details = { ...payload, nextReviewDate }, cmd = command(initial, 'complete', details);
    expect(normaliseImprovementCommand(wire(initial, details)).payload).toEqual(details);
    const state = applyImprovementActionCommand(initial, cmd, context);
    expect(applyImprovementActionCommand(state, cmd, context)).toEqual(state);
    const view = getImprovementPlanView(clone(state));
    expect(view.actions[0].completion).toMatchObject({ nextReviewDate, evidenceVerification: 'not_verified' });
    expect(view.source).toEqual(getImprovementPlanView(initial).source);
    const projected = model(state), action = projected.actions.find(a => a.actionId === cmd.actionId);
    expect(action.completion.nextReviewDate).toBe(nextReviewDate);
    expect(action.history.at(-1).details.nextReviewDate).toBe(nextReviewDate);
    expect(action.evidence).toMatchObject({ scoreEffect: 'none', completionVerification: 'not_verified', downloadAllowed: false });
    const dom = createDom(); mount(dom.root, projected);
    expect(dom.root.textContent).toContain('Next review date (UTC) ' + nextReviewDate);
    const reopened = model(step(state, 'reopen', { reason: 'Review found more work.' })).actions.find(a => a.actionId === cmd.actionId);
    expect(reopened.completion).toBeNull(); expect(reopened.history.at(-2).details.nextReviewDate).toBe(nextReviewDate);
    expect(() => applyImprovementActionCommand(state, { ...cmd, payload: { ...details, nextReviewDate: '2027-01-01' } }, context)).toThrow('operation_conflict');
    expect(() => applyImprovementActionCommand(initial, { ...cmd, expectedRevision: 0 }, context)).toThrow('revision_conflict');
    expect(() => applyImprovementActionCommand(initial, cmd, { ...context, tenantId: 'another-tenant' })).toThrow('scope_mismatch');
    expect(() => applyImprovementActionCommand(initial, cmd, { ...context, organisationId: 'another-org' })).toThrow('scope_mismatch');
});

test.each([null, '', '2026-02-30', 'not-a-date', '2026-09-14T00:00:00Z'])('rejects malformed review date %p', nextReviewDate => {
    expect(() => normaliseImprovementCommand(wire(running(), { ...payload, nextReviewDate }))).toThrow('improvement_input_invalid');
    expect(() => step(running(), 'complete', { ...payload, nextReviewDate })).toThrow();
});

test('server rejects a review date before the trusted completion day, not before the later read day', () => {
    expect(() => step(running(), 'complete', { ...payload, nextReviewDate: '2026-09-13' })).toThrow('date_invalid');
    const state = running(), cmd = command(state, 'complete', { ...payload, nextReviewDate: '2026-09-14' });
    expect(() => applyImprovementActionCommand(state, { ...cmd, at: '2026-09-15T00:00:00.000Z' }, context)).toThrow('date_invalid');
});

test.each([null, '2026-02-30', '2026-09-13'])('both presentation boundaries reject corrupt review date %p', nextReviewDate => {
    const state = step(running(), 'complete', { ...payload, nextReviewDate: '2026-12-01' });
    for (const location of ['completion', 'history']) {
        const projected = clone(model(state)), action = projected.actions.find(a => a.completion);
        (location === 'completion' ? action.completion : action.history.at(-1).details).nextReviewDate = nextReviewDate;
        const { presentationVersion, notices, ...list } = clone(projected);
        list.actions.forEach(a => { delete a.labels; a.history.forEach(e => { delete e.label; }); });
        expect(() => projectImprovementActionPlanPresentation(list)).toThrow('improvement_presentation_unavailable');
        const dom = createDom(); mount(dom.root, projected);
        expect(dom.root.textContent).toContain('Improvement action plan is unavailable');
    }
});
