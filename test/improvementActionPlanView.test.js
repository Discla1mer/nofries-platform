'use strict';

// The locked repository has no browser/JSDOM dependency. This existing DOM
// contract verifies element/text/control composition, not browser layout or an
// authenticated host. Native details/summary owns keyboard behavior in browsers.
const fs = require('node:fs');
const vm = require('node:vm');
const { mount, mountLoading } = require('../api/shared/protectedAssets/improvementActionPlanView');
const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementPlan, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { createDom } = require('./fixtures/dashboardDom');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const scope = { tenantId: 'synthetic-tenant', organisationId: fixture.organisationId, planId: 'synthetic-plan' };
const NOTE = '完成 <script>alert(1)</script><img src=x onerror=alert(2)> & "note"';
const REFERENCE = '證據:*<img onerror=alert(3)>';
const REASON = 'Recheck <svg onload=alert(4)> & Unicode 證據';
const UNAVAILABLE = 'Improvement action plan is unavailable. Refresh the page to try again. ' +
    'If the problem continues, contact your support team.';
function seed() {
    return createImprovementPlan({ ...scope, actorSubjectKey: ACTOR, createdAt: '2026-09-14T09:00:00.000Z' },
        clone(fixture), { registry: acceptedRegistry });
}
function step(state, index, type, payload) {
    return applyImprovementActionCommand(state, { ...scope, evaluationOutputSha256: state.source.evaluationOutputSha256,
        actionId: state.proposals[index].actionId, operationId: 'op-' + state.commands.length, expectedRevision: state.commands.length,
        actorSubjectKey: ACTOR, at: '2026-09-14T09:' + String(state.commands.length + 1).padStart(2, '0') + ':00.000Z', type, payload },
    { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] });
}
const assign = (state, index) => step(state, index, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
const start = (state, index) => step(assign(state, index), index, 'start', {});
const complete = (state, index) => step(start(state, index), index, 'complete', { note: NOTE, evidenceReference: REFERENCE });
function mixed() {
    let state = assign(seed(), 0); state = start(state, 1);
    state = step(start(state, 2), 2, 'block', { reason: REASON });
    state = complete(state, 3); return step(complete(state, 4), 4, 'reopen', { reason: REASON });
}
function presentation(state = mixed(), settings = {}) {
    return projectImprovementActionPlanPresentation(projectImprovementActionList(state, {
        scope, asOf: settings.asOf || '2026-10-02T00:00:00.000Z',
        filters: { status: 'all', owner: 'all', overdueOnly: false, ...settings.filters }
    }));
}
function render(model = presentation()) {
    const dom = createDom(), original = dom.document.createElement;
    dom.document.createElement = tag => {
        const node = original(tag);
        Object.defineProperty(node, 'innerHTML', { set() { throw new Error('HTML sinks are forbidden'); } });
        return node;
    };
    return { ...dom, controller: mount(dom.root, model) };
}
function facts(element) {
    const terms = element.children.filter(child => child.tagName === 'DT');
    const values = element.children.filter(child => child.tagName === 'DD');
    return Object.fromEntries(terms.map((term, index) => [term.textContent, values[index].textContent]));
}
function cardFacts(card) {
    const identifiers = card.children.find(child => child.tagName === 'DETAILS' && child.children[0].textContent === 'Action identifiers');
    return { ...facts(card.children.find(child => child.tagName === 'DL')), ...facts(identifiers.querySelector('dl')) };
}
const history = card => card.children.find(child => child.tagName === 'DETAILS' && child.children[0].textContent.startsWith('Action history'));
const evidence = card => card.children.find(child => child.tagName === 'DETAILS' && child.children[0].textContent === 'Supporting evidence');
const cards = dom => dom.root.querySelectorAll('article');
const card = (dom, actionId) => cards(dom).find(value => cardFacts(value)['Action ID'] === actionId);

test('real retained domain → list → presentation → DOM preserves exact action order and source identity', () => {
    const state = mixed(), model = presentation(state), before = clone(model), dom = render(model);
    expect(cards(dom).map(value => cardFacts(value)['Action ID'])).toEqual(model.actions.map(action => action.actionId));
    expect(dom.root.querySelector('h2').textContent).toBe('Improvement action plan');
    const source = facts(dom.root.querySelector('dl'));
    expect(source).toEqual({ 'Plan ID': scope.planId, 'Plan revision': String(state.commands.length),
        'Plan last updated (UTC)': model.updatedAt, 'As of (UTC)': model.asOf, 'Assessment ID': fixture.assessmentId,
        'Assessment revision': fixture.assessmentRevision, 'Assessment scored at (UTC)': fixture.scoreAsOf,
        'Evaluation output SHA-256': state.source.evaluationOutputSha256 });
    model.actions.forEach(action => {
        const element = card(dom, action.actionId), values = cardFacts(element);
        expect(values).toMatchObject({ 'Control ID': action.controlId, 'Item ID': action.itemId, 'Domain ID': action.domainId,
            'Assessment response': action.labels.response,
            'Response origin': action.labels.responseOrigin, 'Assessment evidence': action.labels.evidenceState,
            'Owner ID': action.ownerSubjectKey || 'Unassigned' });
        expect(element.querySelector('.dashboard-badge').textContent).toBe(action.labels.status);
        expect(element.textContent).toContain(action.rationale.suggestedAction);
    });
    expect(model).toEqual(before);
    Object.values(model.notices).forEach(notice => expect(dom.root.textContent).toContain(notice));
    expect(dom.root.textContent).toContain('Showing 14 of 14 actions.');
});

test('exact action focus uses only current validated cards and retires with its mounted view', () => {
    const model = presentation(), dom = render(model), actionId = model.actions[3].actionId;
    expect(dom.controller.focusAction(actionId)).toBe(true);
    expect(dom.document.activeElement).toBe(card(dom, actionId));
    expect(dom.document.activeElement.getAttribute('tabindex')).toBe('-1');
    expect(dom.controller.focusAction('missing-action')).toBe(false);
    const current = mount(dom.root, presentation());
    expect(dom.controller.focusAction(actionId)).toBe(false);
    expect(current.focusAction(actionId)).toBe(true);
    current.destroy(); expect(current.focusAction(actionId)).toBe(false);
});

test('loading and invalid presentation views expose no focusable retained action', () => {
    const dom = createDom(), actionId = presentation().actions[0].actionId;
    expect(mountLoading(dom.root).focusAction(actionId)).toBe(false);
    expect(mount(dom.root, {}).focusAction(actionId)).toBe(false);
});

test('workflow completion, blocks and reopened history retain exact global revisions and inert notes/reference text', () => {
    const state = mixed(), model = presentation(state), dom = render(model);
    const completed = card(dom, state.proposals[3].actionId), reopened = card(dom, state.proposals[4].actionId);
    const completedModel = model.actions.find(value => value.actionId === state.proposals[3].actionId);
    expect(completedModel.completion.at < model.updatedAt).toBe(true);
    expect(cardFacts(completed)).toMatchObject({ 'Workflow completed at (UTC)': completedModel.completion.at, 'Completion note': NOTE,
        'Completion meaning': 'Workflow completed; control implementation has not been verified.' });
    expect(facts(evidence(completed).querySelector('dl'))['Completion evidence reference (unverified)']).toBe(REFERENCE);
    expect(cardFacts(card(dom, state.proposals[2].actionId))['Block reason']).toBe(REASON);
    expect(cardFacts(reopened)).not.toHaveProperty('Completion note');
    expect(cardFacts(reopened)).not.toHaveProperty('Completion evidence reference (unverified)');
    expect(history(reopened).textContent).toContain(NOTE);
    expect(history(reopened).textContent).toContain(REFERENCE);
    const action = model.actions.find(value => value.actionId === state.proposals[4].actionId);
    expect(history(reopened).querySelectorAll('h4').map(value => value.textContent)).toEqual(action.history.map(event => 'Plan revision ' + event.revision + ' · ' + event.label));
    expect(action.history[0].revision).toBeGreaterThan(1); // Global revisions retain gaps from other actions.
    action.history.forEach(event => expect(history(reopened).textContent).toContain(event.at + ' (UTC)'));
    for (const tag of ['a', 'img', 'script', 'svg', 'iframe', 'button', 'input', 'select', 'form']) expect(dom.root.querySelectorAll(tag)).toEqual([]);
});

test('native details/summary history controls preserve default browser keyboard semantics', () => {
    const dom = render();
    expect(dom.root.querySelectorAll('details').filter(element => element.children[0].textContent.startsWith('Action history'))).toHaveLength(cards(dom).length);
    dom.root.querySelectorAll('details').forEach(element => {
        expect(element.children[0].tagName).toBe('SUMMARY');
        expect(element.children[0].textContent).toMatch(/^(Action history \(\d+ events\)|Supporting evidence|Action identifiers|Source and plan metadata|Counts and filters)$/);
        expect(element.getAttribute('role')).toBeNull(); expect(element.children[0].getAttribute('role')).toBeNull();
        expect(element.children[0].getAttribute('tabindex')).toBeNull(); expect(element.children[0].events).toEqual({});
    });
});

test('each action exposes retained evidence claims with separate assessment provenance and explicit unknown document facts', () => {
    const model = presentation(), before = clone(model), dom = render(model);
    model.actions.forEach(action => {
        const section = evidence(card(dom, action.actionId));
        expect(section.getAttribute('open')).toBeNull();
        expect(facts(section.querySelectorAll('dl')[0])).toEqual({
            'Assessment evidence claim': action.labels.evidenceState,
            ...(action.completion === null ? {} : {
                'Completion evidence reference (unverified)': action.evidence.completionReference,
                'Completion reference recorded at (UTC)': action.completion.at
            }),
            'Verification': action.completion === null ? 'No verification recorded' : 'Not verified'
        });
        expect(facts(section.querySelectorAll('dl')[1])).toEqual({
            'Assessment ID': model.source.assessmentId, 'Assessment revision': model.source.assessmentRevision,
            'Assessment scored at (UTC)': model.source.scoreAsOf
        });
        expect(section.textContent).toContain('No supporting document version is linked to this action');
        expect(section.textContent).toContain('its date and version are unknown.');
        expect(section.textContent).toContain('Completing an action does not verify a control or change scores.');
        if (action.completion === null) expect(section.textContent).toContain('No completion evidence reference is recorded for the current action.');
        expect(section.querySelectorAll('a')).toEqual([]);
    });
    expect(model).toEqual(before);
});

test('reopening removes the current evidence reference without presenting its historical date as current evidence', () => {
    const state = mixed(), model = presentation(state), dom = render(model);
    const action = card(dom, state.proposals[4].actionId), current = evidence(action);
    const values = facts(current.querySelector('dl'));
    expect(values.Verification).toBe('No verification recorded');
    expect(values).not.toHaveProperty('Completion evidence reference (unverified)');
    expect(values).not.toHaveProperty('Completion reference recorded at (UTC)');
    expect(current.textContent).toContain('its date and version are unknown.');
    expect(current.textContent).not.toContain(REFERENCE);
    expect(history(action).textContent).toContain(REFERENCE);
    expect(current.textContent).toContain('Review the assessment claim and Action history for earlier records.');
});

test.each([
    ['independently_reviewed_current', 'Independently reviewed as current'],
    ['tested_or_observed_current', 'Tested or observed as current'],
    ['stale', 'Stale'], ['unavailable', 'Unavailable'], ['not_provided', 'Not provided']
])('assessment claim %s does not become document verification or a fabricated version/date', (state, label) => {
    const model = clone(presentation()); model.actions[0].evidence.assessmentState = state; model.actions[0].labels.evidenceState = label;
    const section = evidence(cards(render(model))[0]), values = facts(section.querySelector('dl'));
    expect(values).toMatchObject({ 'Assessment evidence claim': label, 'Verification': 'No verification recorded' });
    expect(section.textContent).toContain('The assessment claim and completion reference are self-reported.');
    expect(section.textContent).toContain('its date and version are unknown.');
});

test('compact heading leads with action summary while verbose source, counts and identifiers use native disclosures', () => {
    const model = presentation(), dom = render(model), panel = dom.root.children[0];
    expect(panel.children.slice(0, 5).map(child => child.tagName)).toEqual(['H2', 'P', 'P', 'P', 'P']);
    expect(panel.children[1].textContent).toContain(model.source.assessmentRevision);
    expect(panel.children[2].textContent).toContain('Visible overdue: ' + model.counts.visible.overdue);
    const details = panel.children.filter(child => child.tagName === 'DETAILS');
    expect(details.map(child => child.children[0].textContent)).toEqual(['Source and plan metadata', 'Counts and filters']);
    details.forEach(element => expect(element.getAttribute('open')).toBeNull());
    const first = cards(dom)[0];
    expect(first.children[0].textContent).toContain(model.actions[0].controlId);
    expect(first.children[2].textContent).toBe(model.actions[0].rationale.suggestedAction);
    expect(facts(first.children.find(child => child.tagName === 'DL'))).not.toHaveProperty('Owner ID');
    expect(cardFacts(first)).toMatchObject({ 'Owner ID': model.actions[0].ownerSubjectKey || 'Unassigned',
        'Owner eligibility': 'Current eligibility not checked' });
    expect(first.children.find(child => child.tagName === 'DETAILS').getAttribute('open')).toBeNull();
});

test('read-only next steps explain each current status without changing ownership, due dates or reopened history', () => {
    const state = mixed(), model = presentation(state), dom = render(model);
    expect(dom.root.textContent).toContain('Read-only plan. Review each action’s next step, owner and due date.');
    expect(dom.root.textContent).toContain('Open Action history for earlier updates. Changes cannot be made in this view.');
    const assigned = card(dom, state.proposals[0].actionId), active = card(dom, state.proposals[1].actionId);
    const blocked = card(dom, state.proposals[2].actionId), completed = card(dom, state.proposals[3].actionId);
    const reopened = card(dom, state.proposals[4].actionId), unassigned = card(dom, state.proposals[5].actionId);
    expect(cardFacts(assigned)).toMatchObject({ 'Next step': 'Confirm the owner and due date, then review the suggested work.',
        'Owner': 'Assigned (eligibility not checked)', 'Due date (UTC calendar day)': '2026-10-01' });
    expect(cardFacts(active)['Next step']).toBe('Review progress with the action owner against the due date.');
    expect(cardFacts(blocked)).toMatchObject({ 'Next step': 'Review the block reason and agree how to move forward.', 'Block reason': REASON });
    expect(cardFacts(completed)['Next step']).toBe('Review the completion note and action history.');
    expect(cardFacts(reopened)['Next step']).toBe(cardFacts(assigned)['Next step']);
    expect(cardFacts(reopened)).not.toHaveProperty('Completion note');
    expect(history(reopened).textContent).toContain(NOTE);
    expect(cardFacts(unassigned)).toMatchObject({ 'Next step': 'Agree an owner and due date before starting this action.',
        'Owner': 'Unassigned', 'Due date (UTC calendar day)': 'Not set' });
    expect(history(unassigned).textContent).toContain('No updates recorded for this action.');
    expect(cards(dom).map(value => cardFacts(value)['Action ID'])).toEqual(model.actions.map(action => action.actionId));
    for (const tag of ['button', 'input', 'select', 'form', 'a']) expect(dom.root.querySelectorAll(tag)).toEqual([]);
});

test('filtered and empty selections show original all counts and plan-wide metadata', () => {
    const state = mixed(), all = presentation(state), selected = presentation(state, { filters: { status: 'completed' } }), dom = render(selected);
    expect(cards(dom)).toHaveLength(1); expect(dom.root.textContent).toContain('Showing 1 of 14 actions.');
    expect(dom.root.textContent).toContain('Filters: status Completed; owner all; overdue only No.');
    expect(selected.counts.all).toEqual(all.counts.all);
    expect(facts(dom.root.querySelector('dl'))['Plan last updated (UTC)']).toBe(all.updatedAt);
    const empty = render(presentation(state, { filters: { owner: OTHER } }));
    expect(cards(empty)).toEqual([]); expect(empty.root.textContent).toContain('Showing 0 of 14 actions.');
    expect(empty.root.textContent).toContain('No actions match these filters.');
    expect(empty.root.textContent).toContain('Review the selection in Counts and filters to see what is included.');
    const noActions = clone(all); noActions.actions = [];
    const counts = { total: 0, overdue: 0, unassigned: 0, byStatus: { open: 0, in_progress: 0, blocked: 0, completed: 0 } };
    noActions.counts = { all: clone(counts), visible: clone(counts) };
    expect(render(noActions).root.textContent).toContain('No retained improvement actions. Check that this is the assessment version you intended to review.');
});

test.each([
    ['2026-10-01T23:59:59.999Z', 'No'], ['2026-10-02T00:00:00.000Z', 'Yes']
])('renders supplied UTC overdue decision at %s without reading the current clock', (asOf, expected) => {
    const state = assign(seed(), 0), model = presentation(state, { asOf });
    const now = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock forbidden'); });
    try {
        expect(cardFacts(card(render(model), state.proposals[0].actionId))['Overdue at supplied as-of date (UTC)']).toBe(expected);
    } finally { now.mockRestore(); }
});

test('HTML-looking IDs remain literal text without attribute, link or element interpolation', () => {
    const model = clone(presentation()); model.actions[0].actionId = '<script>alert(5)</script>';
    model.actions[0].controlId = '<img src=x>'; model.actions[0].itemId = '" onclick="alert(6)'; model.actions[0].domainId = '<svg onload=alert(7)>';
    const dom = render(model), values = cardFacts(cards(dom)[0]);
    expect(values['Action ID']).toBe(model.actions[0].actionId); expect(values['Control ID']).toBe('<img src=x>');
    expect(values['Item ID']).toBe(model.actions[0].itemId); expect(values['Domain ID']).toBe(model.actions[0].domainId);
    for (const tag of ['a', 'img', 'script', 'svg']) expect(dom.root.querySelectorAll(tag)).toEqual([]);
});

test.each([
    ['missing root', model => { delete model.source; }],
    ['unknown field', model => { model.permissions = ['write']; }],
    ['unknown vocabulary', model => { model.actions[0].status = 'verified'; }],
    ['misleading label', model => { model.actions[0].labels.status = 'Verified secure'; }],
    ['misleading notice', model => { model.notices.evidence = 'All evidence verified'; }],
    ['wrong counts', model => { model.counts.visible.total = 0; }],
    ['wrong revision type', model => { model.source.assessmentRevision = 2; }],
    ['noncanonical instant', model => { model.asOf = '2026-02-30T00:00:00.000Z'; }],
    ['extra history data', model => { model.actions.find(value => value.history.length).history[0].actor = 'private'; }],
    ['unsafe evidence capability', model => { model.actions[0].evidence.downloadAllowed = true; }],
    ['missing completion', model => { model.actions.find(value => value.status === 'completed').completion = null; }],
    ['excess actions', model => { model.actions = Array(4097).fill(model.actions[0]); }],
    ['excess string envelope', model => { model.actions[0].rationale.suggestedAction = 'x'.repeat(8388609); }]
])('malformed %s fails closed without partial retained details or raw errors', (_name, corrupt) => {
    const model = clone(presentation()); corrupt(model);
    const dom = render(model);
    expect(dom.root.textContent).toBe(UNAVAILABLE);
    expect(dom.root.querySelector('[role="status"]')).not.toBeNull(); expect(cards(dom)).toEqual([]);
    expect(dom.root.textContent).not.toContain(fixture.assessmentId); expect(dom.root.textContent).not.toContain(NOTE);
});

test('accessors, cycles, sparse arrays and custom JSON hooks are rejected without executing getters', () => {
    const models = [clone(presentation()), clone(presentation()), clone(presentation()), clone(presentation())]; let calls = 0;
    Object.defineProperty(models[0], 'source', { enumerable: true, get() { calls++; throw new Error('private getter detail'); } });
    models[1].scope = models[1]; delete models[2].actions[1]; models[3].toJSON = () => { calls++; return {}; };
    models.forEach(model => expect(render(model).root.textContent).toBe(UNAVAILABLE));
    expect(calls).toBe(0);
});

test('remount and idempotent destroy prevent an old handle from erasing the new view', () => {
    const dom = createDom(), first = mount(dom.root, presentation()), second = mount(dom.root, presentation(mixed(), { filters: { status: 'completed' } }));
    first.destroy(); expect(dom.root.textContent).toContain('Showing 1 of 14 actions.');
    second.destroy(); second.destroy(); expect(dom.root.textContent).toBe('');
    const current = mount(dom.root, presentation()); const denied = mount(dom.root, { source: 'private' });
    current.destroy(); expect(dom.root.textContent).toBe(UNAVAILABLE);
    denied.destroy(); expect(dom.root.textContent).toBe('');
    expect(() => mount(null, presentation())).toThrow('improvement_view_root_required');
});

test('host-controlled loading replaces stale details and shares safe remount and destroy behavior', () => {
    const dom = createDom(), first = mount(dom.root, presentation());
    const loading = mountLoading(dom.root);
    expect(dom.root.textContent).toBe('Loading improvement actions…');
    expect(dom.root.querySelector('[role="status"]')).not.toBeNull();
    expect(cards(dom)).toEqual([]); expect(dom.root.textContent).not.toContain(fixture.assessmentId);
    first.destroy(); expect(dom.root.textContent).toBe('Loading improvement actions…');
    const loaded = mount(dom.root, presentation());
    loading.destroy(); expect(cards(dom)).toHaveLength(14);
    expect(dom.root.querySelector('[aria-busy="true"]')).toBeNull();
    const pending = mountLoading(dom.root), denied = mount(dom.root, null);
    loaded.destroy(); pending.destroy(); expect(dom.root.textContent).toBe(UNAVAILABLE);
    denied.destroy(); expect(dom.root.textContent).toBe('');
    const last = mountLoading(dom.root); last.destroy(); last.destroy();
    expect(dom.root.textContent).toBe('');
    expect(() => mountLoading(null)).toThrow('improvement_view_root_required');
});

test('standalone browser global works without require, request, storage, clock or event ports', () => {
    const source = fs.readFileSync(require.resolve('../api/shared/protectedAssets/improvementActionPlanView'), 'utf8');
    const dom = createDom(), forbidden = jest.fn(() => { throw new Error('side effect forbidden'); });
    const context = vm.createContext({ root: dom.root, data: JSON.stringify(presentation()), fetch: forbidden,
        XMLHttpRequest: forbidden, localStorage: { getItem: forbidden, setItem: forbidden },
        sessionStorage: { getItem: forbidden, setItem: forbidden }, addEventListener: forbidden });
    vm.runInContext(source, context); vm.runInContext('NoFriesImprovementActionPlanView.mountLoading(root);', context);
    expect(dom.root.textContent).toBe('Loading improvement actions…');
    vm.runInContext('NoFriesImprovementActionPlanView.mount(root, JSON.parse(data));', context);
    expect(dom.root.textContent).toContain('Showing 14 of 14 actions.'); expect(forbidden).not.toHaveBeenCalled();
    expect(source).not.toMatch(/\binnerHTML\b|\bfetch\s*\(|addEventListener\s*\(/);
});
