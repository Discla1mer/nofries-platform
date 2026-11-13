'use strict';

const { mount, mountLoading } = require('../api/shared/protectedAssets/improvementActionPlanView');
const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry: registry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { createDom } = require('./fixtures/dashboardDom');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json').input;
const OWNER = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const scope = { tenantId: 'synthetic-tenant', organisationId: fixture.organisationId, planId: 'synthetic-plan' };
const context = { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: OWNER, eligibleOwnerSubjectKeys: [OWNER] };
const AT = '2026-09-14T10:00:00.000Z';
const NOTE = '<script>alert(1)</script><img src=x onerror=alert(2)> ' + '證據😀'.repeat(100);
const REASON = '<svg onload=alert(3)> Review again';
const clone = value => JSON.parse(JSON.stringify(value));
function seed() {
    return createImprovementPlan({ ...scope, actorSubjectKey: OWNER, createdAt: '2026-09-14T09:00:00.000Z' }, fixture, { registry });
}
function step(state, index, type, payload) {
    return applyImprovementActionCommand(state, { ...scope, evaluationOutputSha256: state.source.evaluationOutputSha256,
        actionId: state.proposals[index].actionId, operationId: 'op-' + state.commands.length, expectedRevision: state.commands.length,
        actorSubjectKey: OWNER, at: AT, type, payload }, context);
}
const assign = (state, index) => step(state, index, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
function mixed() {
    let state = assign(seed(), 0);
    state = step(state, 0, 'start', {});
    state = assign(state, 1);
    state = step(state, 1, 'start', {});
    state = step(state, 0, 'complete', { note: NOTE, evidenceReference: 'evidence:synthetic' });
    state = step(state, 1, 'block', { reason: REASON });
    return step(state, 0, 'reopen', { reason: REASON });
}
function model(state = mixed(), filters = {}) {
    return projectImprovementActionPlanPresentation(projectImprovementActionList(state, { scope,
        asOf: '2026-10-02T00:00:00.000Z', filters: { status: 'all', owner: 'all', overdueOnly: false, ...filters } }));
}
function render(value = model()) { const dom = createDom(); mount(dom.root, value); return dom; }
const recent = dom => dom.root.querySelector('[aria-label="Latest saved action updates"]');
const entries = dom => recent(dom).querySelector('ol').children;
const history = dom => dom.root.querySelectorAll('details').filter(element => element.children[0].textContent.startsWith('Action history'));

test('shows only five newest global revisions across actions, including equal timestamps, without reordering or changing retained data', () => {
    const state = mixed(), value = model(state), before = clone({ state, value }), dom = render(value);
    const expected = value.actions.flatMap(action => action.history.map(event => ({ action, event })))
        .sort((a, b) => b.event.revision - a.event.revision).slice(0, 5);
    expect(entries(dom)).toHaveLength(5);
    expected.forEach(({ action, event }, i) => {
        expect(entries(dom)[i].textContent).toContain('Plan revision ' + event.revision + ' · ' + AT + ' (UTC)');
        expect(entries(dom)[i].textContent).toContain(action.controlId + ' · ' + action.labels.kind);
        expect(entries(dom)[i].children[0].textContent).toContain(Array.from(action.rationale.suggestedAction).slice(0, 100).join(''));
    });
    expect(recent(dom).textContent).toContain('Latest 5 of 7 saved updates');
    expect(recent(dom).textContent).toContain('Newest plan revision first.');
    expect(recent(dom).textContent).not.toContain(OWNER);
    expect(recent(dom).textContent).not.toContain('evidence:synthetic');
    expect(recent(dom).textContent).toContain('Assignment updated · Due date (UTC): 2026-10-01');
    expect(history(dom).map(section => section.querySelectorAll('h4').map(item => item.textContent)))
        .toEqual(value.actions.map(action => action.history.map(event => 'Plan revision ' + event.revision + ' · ' + event.label)));
    expect({ state, value }).toEqual(before);
});

test('completion and reopen are workflow events, with inert bounded previews and unabridged per-action history', () => {
    const dom = render();
    expect(recent(dom).textContent).toContain('Workflow completed');
    expect(recent(dom).textContent).toContain('Reopened');
    expect(recent(dom).textContent).toContain('Workflow updates do not verify evidence or change assessment scores.');
    expect(recent(dom).textContent).toContain('Full records remain in each action’s Action history below.');
    expect(recent(dom).textContent).toContain('Completion note (preview): ' + Array.from(NOTE).slice(0, 160).join('') + '…');
    expect(recent(dom).textContent).not.toContain(NOTE);
    expect(recent(dom).textContent).toContain('Reason: ' + REASON);
    expect(history(dom).some(section => section.textContent.includes(NOTE))).toBe(true);
    for (const tag of ['script', 'img', 'svg', 'iframe', 'a', 'button', 'input', 'form']) expect(dom.root.querySelectorAll(tag)).toEqual([]);
});

test.each([{ status: 'blocked' }, { status: 'open' }, { owner: 'unassigned' }, { overdueOnly: true }])
    ('summary includes only histories from the current filtered selection %j', filters => {
        const value = model(mixed(), filters), dom = render(value);
        const expected = value.actions.flatMap(action => action.history).sort((a, b) => b.revision - a.revision).slice(0, 5);
        expect(recent(dom).textContent).toContain('Only actions shown in this view are included; current filters apply.');
        expect(recent(dom).querySelectorAll('li')).toHaveLength(expected.length);
        recent(dom).querySelectorAll('li').forEach((entry, index) => expect(entry.children[1].textContent)
            .toContain('Plan revision ' + expected[index].revision + ' · ' + expected[index].at + ' (UTC)'));
    });

test('valid untouched actions get a scoped empty message; empty selections never imply the whole plan has no updates', () => {
    expect(recent(render(model(seed()))).textContent).toContain('No saved updates for the actions shown.');
    const selected = render(model(mixed(), { status: 'completed' }));
    expect(recent(selected)).toBeNull();
    expect(selected.root.textContent).toContain('No actions match these filters.');
    expect(selected.root.textContent).not.toContain('No saved updates');
});

test.each([
    value => { value.actions[0].history[0].revision = 9999; },
    value => { value.actions[0].history[0].at = 'invalid'; },
    value => { value.actions[0].history[0].details.actor = 'private'; },
    value => { value.actions[0].history[0].label = 'Verified secure'; },
    value => { value.actions[0].history = null; }
])('invalid input removes the previous summary atomically, not a zero-state or partial list', corrupt => {
    const dom = render(), value = clone(model()); corrupt(value); mount(dom.root, value);
    expect(recent(dom)).toBeNull(); expect(history(dom)).toEqual([]);
    expect(dom.root.textContent).toContain('Improvement action plan is unavailable.');
    expect(dom.root.textContent).not.toContain('No saved updates');
    expect(dom.root.textContent).not.toContain(REASON);
});

test('loading, unavailable and newer mounts retire stale updates; old handles cannot erase a new selection', () => {
    const dom = createDom(), old = mount(dom.root, model());
    mountLoading(dom.root); expect(recent(dom)).toBeNull();
    mount(dom.root, model(mixed(), { status: 'blocked' })); old.destroy();
    expect(recent(dom).textContent).toContain('Latest 3 of 3 saved updates');
    mount(dom.root, null); expect(recent(dom)).toBeNull();
    expect(dom.root.textContent).not.toContain('No saved updates');
});
