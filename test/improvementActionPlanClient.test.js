'use strict';

const { mount } = require('../api/shared/protectedAssets/improvementActionPlanClient');
const { createDom } = require('./fixtures/dashboardDom');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const input = require('./fixtures/ncscAcceptedEvaluation.json').input;
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OTHER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const SCOPE = { tenantId: 'synthetic-tenant', organisationId: input.organisationId };
const AT = '2026-10-01T09:00:00.000Z';
function seed(planId = 'plan-a') {
    return createImprovementPlan({ ...SCOPE, planId, actorSubjectKey: ACTOR, createdAt: AT }, clone(input), { registry: acceptedRegistry });
}
function presentation(state) {
    return projectImprovementActionPlanPresentation(projectImprovementActionList(state, {
        scope: { ...SCOPE, planId: state.planId }, asOf: AT, filters: { status: 'all', owner: 'all', overdueOnly: false }
    }));
}
function page(rows = [{ planId: 'plan-a', planRevision: 0 }], nextAfterPlanId = null, scope = SCOPE) {
    return { schemaVersion: 1, scope: clone(scope), asOf: AT, plans: rows, nextAfterPlanId };
}
function source() {
    return { assessmentId: input.assessmentId, revision: 2, revisionSha256: 'a'.repeat(64), profileRef: clone(input.profileRef),
        outputSha256: seed().source.evaluationOutputSha256 };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function visible(node) { for (let at = node; at; at = at.parentElement) if (at.hidden) return false; return true; }
function button(h, label) { return h.root.querySelectorAll('button').find(node => node.textContent === label && visible(node)); }
function editorContext(state, planId = 'plan-a', canWrite = true) {
    const model = presentation(state.plans.get(planId));
    return { schemaVersion: 1, scope: { ...SCOPE, planId }, planRevision: model.planRevision, asOf: AT, canWrite,
        ownerChoices: canWrite ? [{ subjectKey: ACTOR, label: 'Assign to me' }] : [],
        actions: model.actions.map(action => ({ actionId: action.actionId, commands: !canWrite ? [] : action.status === 'completed' ? ['reopen'] :
            ['assign', ...['open', 'blocked'].includes(action.status) && action.ownerSubjectKey ? ['start'] : [],
                ...action.status === 'in_progress' ? ['block'] : [],
                ...['in_progress', 'blocked'].includes(action.status) && action.ownerSubjectKey ? ['complete'] : []] })) };
}
function append(state, type, payload, actionId = presentation(state).actions[0].actionId, operationId = 'seed-' + state.commands.length, expectedRevision = state.commands.length) {
    const owners = [...new Set([ACTOR, ...getImprovementPlanView(state).actions.map(action => action.ownerSubjectKey).filter(Boolean),
        ...type === 'assign' ? [payload.ownerSubjectKey] : []])];
    return applyImprovementActionCommand(state, { ...SCOPE, planId: state.planId, evaluationOutputSha256: state.source.evaluationOutputSha256,
        actionId, operationId, expectedRevision, actorSubjectKey: ACTOR, at: AT, type, payload },
    { ...SCOPE, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: owners });
}
async function settle() { for (let count = 0; count < 3; count++) await new Promise(resolve => setImmediate(resolve)); }
function form(h) { return h.root.querySelectorAll('form').find(visible); }
function field(h, label) {
    return form(h)?.querySelectorAll('input').concat(form(h)?.querySelectorAll('textarea') || [])
        .find(control => control.getAttribute('aria-label') === label || control.parentElement?.tagName === 'LABEL' && control.parentElement.textContent.includes(label));
}
function emit(node, event) { for (const callback of node.events[event] || []) callback({ currentTarget: node, target: node, preventDefault() {} }); }
function fill(h, label, value) { const control = field(h, label); expect(control).toBeDefined(); control.value = value; emit(control, 'input'); emit(control, 'change'); return control; }
function disabled(node) { for (let at = node; at; at = at.parentElement) if (at.disabled) return true; return false; }
function chooseAction(h, actionId = presentation(h.state.plans.get('plan-a')).actions[0].actionId) {
    const picker = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Improvement action');
    expect(picker).toBeDefined(); picker.value = actionId; emit(picker, 'change'); return actionId;
}
async function submitForm(h) {
    const editor = form(h); expect(editor).toBeDefined();
    expect(editor.events.submit.size).toBeGreaterThan(0);
    for (const callback of editor.events.submit || []) callback({ currentTarget: editor, preventDefault() {} });
    await settle();
}
function harness(settings = {}) {
    const dom = createDom(), state = { current: true, plans: new Map([['plan-a', settings.plan || seed()]]), ids: 0 };
    const request = jest.fn(async (path, body) => {
        if (path.startsWith('/api/dashboard/improvement/editor?planId=')) {
            const id = decodeURIComponent(path.split('=')[1]);
            return settings.editorRespond ? settings.editorRespond(path, body, state) : { status: 200, value: editorContext(state, id, settings.canWrite !== false) };
        }
        if (settings.respond) return settings.respond(path, body, state);
        if (path.startsWith('/api/dashboard/improvement/plans?')) return { status: 200, value: page([...state.plans].map(([planId, value]) => ({ planId, planRevision: value.commands.length }))) };
        if (path.startsWith('/api/dashboard/improvement/view?planId=')) {
            const id = decodeURIComponent(path.split('=')[1]); return { status: 200, value: presentation(state.plans.get(id)) };
        }
        if (path === '/api/dashboard/improvement/execute') {
            const before = state.plans.get(body.planId), after = append(before, body.type, body.payload, body.actionId, body.operationId, body.expectedRevision);
            state.plans.set(body.planId, after); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(after) } };
        }
        throw new Error('unexpected fixture request');
    });
    const options = { request, isCurrent: () => state.current, newId: jest.fn(() => 'generated-' + ++state.ids),
        organisationId: SCOPE.organisationId, ...settings.options };
    return { ...dom, state, request, options, controller: mount(dom.root, options) };
}

test('mount uses actual retained IDs and unchanged renderer through canonical read paths', async () => {
    const h = harness(); expect(await h.controller.ready).toBe(true);
    expect(h.request.mock.calls.map(args => args[0])).toEqual(['/api/dashboard/improvement/plans?limit=20', '/api/dashboard/improvement/view?planId=plan-a',
        '/api/dashboard/improvement/editor?planId=plan-a']);
    expect(h.root.textContent).toContain('Improvement action plan');
    expect(h.root.textContent).toContain('Read-only plan.');
    expect(h.root.textContent).toContain('Risk priority has not been calculated.');
    expect(h.root.querySelector('select').getAttribute('aria-label')).toBe('Saved improvement plans');
    expect(button(h, 'Create improvement plan for this assessment')).toBeUndefined();
    expect(h.options.newId).not.toHaveBeenCalled();
});

test('a selected saved assessment is snapshotted but never automatically generates or guesses a plan ID', async () => {
    const selected = source(), expected = clone(selected), h = harness({ options: { sourceAssessment: selected } });
    selected.assessmentId = 'changed'; selected.profileRef.profileId = 'changed';
    expect(await h.controller.ready).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.options.newId).not.toHaveBeenCalled();
    expect(button(h, 'Create improvement plan for this assessment')).toBeDefined();
    expect(h.root.textContent).toContain(expected.assessmentId); expect(h.root.textContent).not.toContain('changed');
    expect(h.root.querySelectorAll('article')).toEqual([]);
    expect(await h.controller.select('guessed-plan')).toBe(false); expect(h.request).toHaveBeenCalledTimes(1);
});

test('explicit generation sends the exact submitted revision and independent IDs, then reads retained presentation', async () => {
    const selected = source(), h = harness({ options: { sourceAssessment: selected }, respond(path, body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page([]) };
        if (path.endsWith('/execute')) { const plan = seed(body.planId); state.plans.set(body.planId, plan); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(plan) } }; }
        return { status: 200, value: presentation(state.plans.get(decodeURIComponent(path.split('=')[1]))) };
    } });
    await h.controller.ready; expect(await h.controller.generate()).toBe(true);
    expect(h.request.mock.calls[1]).toEqual(['/api/dashboard/improvement/execute', { planId: 'generated-1', type: 'generate',
        operationId: 'generated-2', expectedRevision: null, actionId: null,
        payload: { assessmentId: selected.assessmentId, assessmentRevision: selected.revision, assessmentRevisionSha256: selected.revisionSha256 } }]);
    expect(h.request.mock.calls[2]).toEqual(['/api/dashboard/improvement/view?planId=generated-1']);
    expect(h.root.textContent).toContain('Improvement action plan'); expect(h.options.newId).toHaveBeenCalledTimes(2);
});

test('uncertain writes retain their exact immutable command for explicit retry and hold shell leave', async () => {
    const selected = source(); let attempts = 0, seen;
    const h = harness({ options: { sourceAssessment: selected }, respond(path, body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page([]) };
        if (path.endsWith('/execute')) {
            seen ||= body; expect(body).toBe(seen); expect(Object.isFrozen(body.payload)).toBe(true);
            if (++attempts === 1) throw new Error('PRIVATE synthetic transport loss');
            const plan = seed(body.planId); state.plans.set(body.planId, plan); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(plan) } };
        }
        return { status: 200, value: presentation(state.plans.get(decodeURIComponent(path.split('=')[1]))) };
    } });
    await h.controller.ready; expect(await h.controller.generate()).toBe(false);
    expect(h.root.textContent).toContain('outcome is unconfirmed'); expect(h.root.textContent).not.toContain('PRIVATE');
    const leave = jest.fn(); expect(await h.controller.requestLeave(leave)).toBe(false); expect(leave).not.toHaveBeenCalled();
    expect(await h.controller.generate()).toBe(false); expect(h.options.newId).toHaveBeenCalledTimes(2);
    expect(button(h, 'Retry pending improvement command')).toBeDefined();
    expect(await h.controller.retry()).toBe(true); expect(attempts).toBe(2); expect(h.options.newId).toHaveBeenCalledTimes(2);
    expect(await h.controller.requestLeave(leave)).toBe(true); expect(leave).toHaveBeenCalledTimes(1);
});

test.each([401, 403])('denial %i clears presentation and prevents further reads/writes in the old mount', async status => {
    const h = harness(); await h.controller.ready; expect(h.root.querySelectorAll('article').length).toBeGreaterThan(0);
    h.request.mockResolvedValueOnce({ status, value: { code: 'access_denied' } });
    expect(await h.controller.refresh()).toBe(false); expect(h.root.querySelectorAll('article')).toEqual([]);
    expect(h.root.textContent).toContain('access is unavailable'); const count = h.request.mock.calls.length;
    expect(await h.controller.select('plan-a')).toBe(false); expect(await h.controller.refresh()).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(count); expect(button(h, 'Refresh improvement plan')).toBeUndefined();
});

test('external owner operation uses the existing command contract and refreshes read-only retained state', async () => {
    const h = harness(); await h.controller.ready;
    h.request.mockImplementation(async (path, body) => {
        if (path.includes('/editor?')) return { status: 200, value: editorContext(h.state) };
        if (path.endsWith('/execute')) {
            const before = h.state.plans.get('plan-a');
            const after = applyImprovementActionCommand(before, { ...SCOPE, planId: 'plan-a', evaluationOutputSha256: before.source.evaluationOutputSha256,
                actionId: body.actionId, operationId: body.operationId, expectedRevision: body.expectedRevision, actorSubjectKey: ACTOR,
                at: AT, type: body.type, payload: body.payload },
            { ...SCOPE, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [ACTOR] });
            h.state.plans.set('plan-a', after); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(after) } };
        }
        return { status: 200, value: presentation(h.state.plans.get('plan-a')) };
    });
    const command = { planId: 'plan-a', type: 'assign', operationId: 'assign-a', expectedRevision: 0,
        actionId: h.state.plans.get('plan-a').proposals[0].actionId, payload: { ownerSubjectKey: ACTOR, dueDate: '2026-10-02' } };
    expect(await h.controller.execute(command)).toBe(true);
    expect(h.request.mock.calls.filter(args => args[0].endsWith('/execute'))).toEqual([['/api/dashboard/improvement/execute', command]]);
    expect(h.request.mock.calls.at(-2)).toEqual(['/api/dashboard/improvement/view?planId=plan-a']);
    expect(h.request.mock.calls.at(-1)).toEqual(['/api/dashboard/improvement/editor?planId=plan-a']);
    expect(h.root.textContent).toContain('2026-10-02'); expect(h.root.textContent).toContain('Assigned');
    expect(h.root.textContent).toContain('scores are unchanged');
});

test('execute rejects unknown envelope keys and a different retained plan/revision before transport', async () => {
    const h = harness(); await h.controller.ready; const count = h.request.mock.calls.length;
    const base = { planId: 'plan-a', type: 'start', operationId: 'start-a', expectedRevision: 0,
        actionId: seed().proposals[0].actionId, payload: {} };
    for (const command of [{ ...base, tenantId: 'forged' }, { ...base, planId: 'other-plan' }, { ...base, expectedRevision: 1 }, { ...base, type: 'delete' }]) {
        expect(await h.controller.execute(command)).toBe(false);
    }
    expect(h.request).toHaveBeenCalledTimes(count);
});

test('pagination uses validated server cursor and does not accumulate an unbounded list or select another plan', async () => {
    const first = Array.from({ length: 20 }, (_, n) => ({ planId: 'plan-' + String(n).padStart(2, '0'), planRevision: 0 }));
    const h = harness({ options: { sourceAssessment: source() }, respond(path) {
        return { status: 200, value: path.includes('afterPlanId=') ? page([{ planId: 'plan-z', planRevision: 0 }]) : page(first, 'plan-19') };
    } });
    await h.controller.ready; button(h, 'More saved plans').click();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.request.mock.calls[1]).toEqual(['/api/dashboard/improvement/plans?limit=20&afterPlanId=plan-19']);
    expect(h.root.querySelectorAll('option').map(option => option.value)).toEqual(['', 'plan-z']);
    expect(button(h, 'More saved plans')).toBeUndefined();
});

test.each([
    value => { value.scope.organisationId = 'foreign'; },
    value => { value.plans = [{ planId: 'plan-a', planRevision: -1 }]; },
    value => { value.plans = [{ planId: 'plan-a', planRevision: 0 }, { planId: 'plan-a', planRevision: 0 }]; },
    value => { value.plans = [{ planId: 'plan-z', planRevision: 0 }, { planId: 'plan-a', planRevision: 0 }]; },
    value => { value.nextAfterPlanId = 'plan-a'; },
    value => { value.extra = 'unknown'; }
])('malformed or foreign plan index is withheld', async change => {
    const value = page(); change(value); const h = harness({ respond: () => ({ status: 200, value }) });
    expect(await h.controller.ready).toBe(false); expect(h.root.querySelectorAll('article')).toEqual([]);
    expect(h.root.querySelectorAll('option').map(option => option.value)).toEqual(['']); expect(h.request).toHaveBeenCalledTimes(1);
});

test('a changed tenant on refresh cannot replace the pinned scope', async () => {
    const h = harness(); await h.controller.ready;
    h.request.mockResolvedValueOnce({ status: 200, value: page(undefined, null, { ...SCOPE, tenantId: 'other-tenant' }) });
    expect(await h.controller.refresh()).toBe(false); expect(h.root.querySelectorAll('article')).toEqual([]);
    expect(h.root.textContent).toContain('unavailable');
});

test.each(['destroy', 'scope'])('late %s results cannot render or initiate more work', async kind => {
    const waiting = deferred(), h = harness({ respond: () => waiting.promise });
    const retainedRefresh = button(h, 'Refresh improvement plan');
    if (kind === 'destroy') h.controller.destroy(); else h.state.current = false;
    waiting.resolve({ status: 200, value: page() }); expect(await h.controller.ready).toBe(false);
    expect(h.root.textContent).toBe(''); retainedRefresh.click(); expect(h.request).toHaveBeenCalledTimes(1);
    const leave = jest.fn(); expect(await h.controller.requestLeave(leave)).toBe(false); expect(leave).not.toHaveBeenCalled();
});

test('replacing a controller retires late reads without clearing the new owner', async () => {
    const first = deferred(), h = harness({ respond: () => first.promise });
    const second = mount(h.root, { ...h.options, request: async () => ({ status: 200, value: page([]) }) });
    expect(await second.ready).toBe(true); const rendered = h.root.textContent;
    first.resolve({ status: 200, value: page() }); expect(await h.controller.ready).toBe(false); expect(h.root.textContent).toBe(rendered);
});

test('hostile selected source accessors and invalid closed source fail before requests or disclosure', () => {
    const dom = createDom(), request = jest.fn(), selected = source(), getter = jest.fn();
    Object.defineProperty(selected, 'assessmentId', { enumerable: true, get: getter });
    const options = { request, isCurrent: () => true, newId: () => 'new-id', organisationId: SCOPE.organisationId, sourceAssessment: selected };
    expect(() => mount(dom.root, options)).toThrow('improvement_client_invalid'); expect(getter).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(() => mount(dom.root, { ...options, sourceAssessment: { ...source(), extra: 'unsupported' } })).toThrow('improvement_client_invalid');
});

test('view identity and generated evaluation source are bound before rendering', async () => {
    const value = clone(presentation(seed())); value.scope.planId = 'other-plan';
    const h = harness({ respond: path => ({ status: 200, value: path.includes('/plans?') ? page() : value }) });
    expect(await h.controller.ready).toBe(false); expect(h.root.querySelectorAll('article')).toEqual([]);
});

test.each([503, 'malformed'])('unconfirmed %s acknowledgement retains the original command until explicit retry', async outcome => {
    let posted;
    const h = harness({ options: { sourceAssessment: source() }, respond(path, body) {
        if (path.includes('/plans?')) return { status: 200, value: page([]) };
        posted ||= body;
        return outcome === 'malformed' ? { status: 200, value: { schemaVersion: 1, plan: { planId: 'foreign-plan' } } } :
            { status: outcome, value: { code: 'improvement_outcome_ambiguous' } };
    } });
    await h.controller.ready; expect(await h.controller.generate()).toBe(false);
    const count = h.request.mock.calls.length; expect(count).toBe(2);
    expect(h.root.textContent).toContain('outcome is unconfirmed');
    expect(await h.controller.requestLeave(jest.fn())).toBe(false);
    expect(await h.controller.refresh()).toBe(false); expect(h.request).toHaveBeenCalledTimes(count);
    expect(await h.controller.retry()).toBe(false); expect(h.request.mock.calls.at(-1)[1]).toBe(posted);
    expect(h.options.newId).toHaveBeenCalledTimes(2);
});

test('definite rejected generation releases its retry identity and shell leave without claiming a saved plan', async () => {
    const h = harness({ options: { sourceAssessment: source() }, respond(path) {
        return path.includes('/plans?') ? { status: 200, value: page([]) } : { status: 409, value: { code: 'improvement_source_conflict' } };
    } });
    await h.controller.ready; expect(await h.controller.generate()).toBe(false);
    expect(button(h, 'Retry pending improvement command')).toBeUndefined(); expect(h.root.querySelectorAll('article')).toEqual([]);
    const leave = jest.fn(); expect(await h.controller.requestLeave(leave)).toBe(true); expect(leave).toHaveBeenCalledTimes(1);
});

test('external command data is frozen before awaiting transport and late authority loss withholds its response', async () => {
    const h = harness(); await h.controller.ready; const pending = deferred();
    h.request.mockImplementationOnce(() => pending.promise);
    const command = { planId: 'plan-a', type: 'assign', operationId: 'assign-a', expectedRevision: 0,
        actionId: seed().proposals[0].actionId, payload: { ownerSubjectKey: ACTOR, dueDate: '2026-10-02' } };
    const result = h.controller.execute(command); command.payload.dueDate = '2030-01-01'; command.operationId = 'changed';
    const captured = h.request.mock.calls.at(-1)[1]; expect(captured.operationId).toBe('assign-a');
    expect(captured.payload.dueDate).toBe('2026-10-02'); expect(Object.isFrozen(captured.payload)).toBe(true);
    h.state.current = false; pending.resolve({ status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(seed()) } });
    expect(await result).toBe(false); expect(h.root.textContent).toBe('');
    expect(await h.controller.retry()).toBe(false);
});

test('a plan created from the selected source cannot render a different evaluation output', async () => {
    const h = harness({ options: { sourceAssessment: source() }, respond(path, body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page([]) };
        if (path.endsWith('/execute')) { state.created = seed(body.planId); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(state.created) } }; }
        const model = clone(presentation(state.created)); model.source.evaluationOutputSha256 = 'b'.repeat(64);
        return { status: 200, value: model };
    } });
    await h.controller.ready; expect(await h.controller.generate()).toBe(false); expect(h.root.querySelectorAll('article')).toEqual([]);
});

test('hostile response accessors and command payload getters are rejected without invoking hooks', async () => {
    const h = harness(); await h.controller.ready; const getter = jest.fn(), command = {
        planId: 'plan-a', type: 'start', operationId: 'start-a', expectedRevision: 0, actionId: seed().proposals[0].actionId
    };
    Object.defineProperty(command, 'payload', { enumerable: true, get: getter });
    const count = h.request.mock.calls.length; expect(await h.controller.execute(command)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(h.request).toHaveBeenCalledTimes(count);
    const result = { status: 200 }; Object.defineProperty(result, 'value', { enumerable: true, get: getter });
    h.request.mockResolvedValueOnce(result); expect(await h.controller.refresh()).toBe(false); expect(getter).not.toHaveBeenCalled();
});

test('toolbar controls keep their DOM identity and keyboard focus through a retained refresh', async () => {
    const h = harness(); await h.controller.ready;
    const control = button(h, 'Refresh improvement plan'), picker = h.root.querySelector('select'); control.focus();
    const pending = deferred(); h.request.mockImplementationOnce(() => pending.promise);
    const done = h.controller.refresh(); expect(control.disabled).toBe(true);
    pending.resolve({ status: 200, value: page() }); expect(await done).toBe(true);
    expect(button(h, 'Refresh improvement plan')).toBe(control); expect(h.root.querySelector('select')).toBe(picker);
    expect(h.document.activeElement).toBe(control); expect(control.disabled).toBe(false);
    expect(picker.parentElement.classList.contains('picture-toolbar')).toBe(true);
});

function assigned() { return append(seed(), 'assign', { ownerSubjectKey: ACTOR, dueDate: '2026-10-02' }); }
function started() { return append(assigned(), 'start', {}); }
function completed() { return append(started(), 'complete', { note: 'Recorded workflow completion.', evidenceReference: 'synthetic:evidence:original' }); }
const OPERATIONS = [
    { type: 'assign', label: 'Assign to me', state: seed, values: { 'Due date (UTC)': '2026-10-02' }, payload: { ownerSubjectKey: ACTOR, dueDate: '2026-10-02' } },
    { type: 'start', label: 'Start action', state: assigned, values: {}, payload: {} },
    { type: 'block', label: 'Block action', state: started, values: { 'Block reason': 'Awaiting an agreed dependency.' }, payload: { reason: 'Awaiting an agreed dependency.' } },
    { type: 'complete', label: 'Complete action', state: started,
        values: { 'Completion note': 'Recorded workflow completion.', 'Completion evidence reference (unverified)': 'synthetic:evidence:completion' },
        payload: { note: 'Recorded workflow completion.', evidenceReference: 'synthetic:evidence:completion' } },
    { type: 'reopen', label: 'Reopen action', state: completed, values: { 'Reopen reason': 'Follow-up work remains.' }, payload: { reason: 'Follow-up work remains.' } }
];

test.each(OPERATIONS)('actual $type form sends the retained command and refreshes its resulting view/editor', async operation => {
    const h = harness({ plan: operation.state() }); expect(await h.controller.ready).toBe(true);
    const before = h.state.plans.get('plan-a'), actionId = chooseAction(h);
    const action = presentation(before).actions.find(row => row.actionId === actionId);
    const picker = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Improvement action');
    expect(picker.children.find(option => option.value === actionId).textContent).toContain(action.controlId);
    expect(picker.children.find(option => option.value === actionId).textContent).not.toContain(actionId);
    const trigger = button(h, operation.label); expect(trigger).toBeDefined(); trigger.focus(); trigger.click();
    expect(form(h)).toBeDefined(); expect(button(h, 'Cancel changes')).toBeDefined();
    expect(h.document.activeElement.closest('form')).toBe(form(h));
    if (operation.type === 'assign') {
        expect(field(h, 'Due date (UTC)').type).toBe('date'); expect(field(h, 'Due date (UTC)').required).toBe(true);
    }
    for (const [label, value] of Object.entries(operation.values)) fill(h, label, value);
    await submitForm(h);
    const writes = h.request.mock.calls.filter(([path]) => path === '/api/dashboard/improvement/execute');
    expect(writes).toEqual([['/api/dashboard/improvement/execute', { planId: 'plan-a', type: operation.type, operationId: 'generated-1',
        expectedRevision: before.commands.length, actionId, payload: operation.payload }]]);
    expect(Object.isFrozen(writes[0][1].payload)).toBe(true); expect(h.options.newId).toHaveBeenCalledTimes(1);
    expect(h.state.plans.get('plan-a').commands).toHaveLength(before.commands.length + 1);
    expect(h.request.mock.calls.slice(-2).map(([path]) => path)).toEqual(['/api/dashboard/improvement/view?planId=plan-a',
        '/api/dashboard/improvement/editor?planId=plan-a']);
    expect(form(h)).toBeUndefined(); expect(h.root.textContent).toContain('scores are unchanged');
    expect(h.document.activeElement.getAttribute('aria-label')).toBe('Improvement action');
    if (operation.type === 'complete') expect(h.root.textContent).toContain('unverified');
});

test('read-only editor context retains the read-only view without forms or action commands', async () => {
    const h = harness({ canWrite: false }); expect(await h.controller.ready).toBe(true);
    expect(h.root.textContent).toContain('Improvement action plan');
    for (const operation of OPERATIONS) expect(button(h, operation.label)).toBeUndefined();
    expect(form(h)).toBeUndefined(); expect(h.options.newId).not.toHaveBeenCalled();
    const before = h.request.mock.calls.length;
    expect(await h.controller.execute({ planId: 'plan-a', type: 'assign', operationId: 'forged-write', expectedRevision: 0,
        actionId: seed().proposals[0].actionId, payload: { ownerSubjectKey: ACTOR, dueDate: '2026-10-02' } })).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(before);
});

test('available action controls follow server commands rather than guessing from a ready module or view status', async () => {
    const h = harness({ plan: assigned(), editorRespond(_path, _body, state) {
        const context = editorContext(state); context.actions.forEach(action => { action.commands = ['assign']; });
        return { status: 200, value: context };
    } });
    await h.controller.ready; chooseAction(h);
    expect(button(h, 'Assign to me')).toBeDefined(); expect(button(h, 'Start action')).toBeUndefined();
});

test('the public execute path cannot invent a different assignment owner than the current server choice', async () => {
    const h = harness(); await h.controller.ready; const before = h.request.mock.calls.length;
    expect(await h.controller.execute({ planId: 'plan-a', type: 'assign', operationId: 'assign-foreign-owner', expectedRevision: 0,
        actionId: presentation(h.state.plans.get('plan-a')).actions[0].actionId,
        payload: { ownerSubjectKey: OTHER, dueDate: '2026-10-02' } })).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(before);
});

test('a server-permitted start can operate an action owned by another eligible member', async () => {
    const plan = append(seed(), 'assign', { ownerSubjectKey: OTHER, dueDate: '2026-10-02' });
    const h = harness({ plan }); await h.controller.ready; const actionId = chooseAction(h);
    expect(button(h, 'Start action')).toBeDefined(); button(h, 'Start action').click(); await submitForm(h);
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([['/api/dashboard/improvement/execute', {
        planId: 'plan-a', type: 'start', operationId: 'generated-1', expectedRevision: 1, actionId, payload: {}
    }]]);
    const action = getImprovementPlanView(h.state.plans.get('plan-a')).actions.find(row => row.actionId === actionId);
    expect(action.status).toBe('in_progress'); expect(action.ownerSubjectKey).toBe(OTHER);
});

test('a blocked action can be completed through the real form when the server permits it', async () => {
    const plan = append(started(), 'block', { reason: 'Recorded blocker awaiting review.' });
    const h = harness({ plan }); await h.controller.ready; const actionId = chooseAction(h);
    expect(button(h, 'Complete action')).toBeDefined(); button(h, 'Complete action').click();
    fill(h, 'Completion note', 'Recorded workflow completion after review.');
    fill(h, 'Completion evidence reference (unverified)', 'synthetic:evidence:blocked-completion'); await submitForm(h);
    const action = getImprovementPlanView(h.state.plans.get('plan-a')).actions.find(row => row.actionId === actionId);
    expect(action.status).toBe('completed'); expect(action.blockedReason).toBeNull();
    expect(action.completion.evidenceVerification).toBe('not_verified');
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))[0][1]).toMatchObject({
        type: 'complete', expectedRevision: 3, actionId,
        payload: { note: 'Recorded workflow completion after review.', evidenceReference: 'synthetic:evidence:blocked-completion' }
    });
});

test('editor action identity matches the complete view set independently of server row order', async () => {
    const h = harness({ editorRespond(_path, _body, state) {
        const context = editorContext(state); context.actions.reverse(); return { status: 200, value: context };
    } });
    expect(await h.controller.ready).toBe(true); chooseAction(h);
    expect(button(h, 'Assign to me')).toBeDefined();
});

test.each([
    context => { context.scope.tenantId = 'other-tenant'; },
    context => { context.scope.organisationId = 'other-organisation'; },
    context => { context.scope.planId = 'other-plan'; },
    context => { context.planRevision++; },
    context => { context.asOf = 'not-an-instant'; },
    context => { context.canWrite = 'true'; },
    context => { context.actions[0].actionId = 'other-action'; },
    context => { context.actions.pop(); },
    context => { context.actions.push(clone(context.actions[0])); },
    context => { context.ownerChoices[0].label = 'Invented person'; },
    context => { context.ownerChoices.push({ subjectKey: ACTOR.replace(/222222222222$/, '333333333333'), label: 'Assign to me' }); },
    context => { context.actions[0].commands = ['delete']; },
    context => { context.actions[0].commands = ['assign', 'assign']; },
    context => { context.extra = 'unsupported'; }
])('unmatched or malformed fresh editor context never enables a write form', async change => {
    const h = harness({ editorRespond(_path, _body, state) { const context = editorContext(state); change(context); return { status: 200, value: context }; } });
    await h.controller.ready;
    for (const operation of OPERATIONS) expect(button(h, operation.label)).toBeUndefined();
    expect(form(h)).toBeUndefined(); expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([]);
});

test('the retained history limit exposes no new action commands even for a current writer', async () => {
    const first = assigned(), template = first.commands[0];
    const limited = { ...seed(), commands: Array.from({ length: 1024 }, (_, revision) => ({ ...clone(template),
        operationId: 'history-' + revision, expectedRevision: revision })) };
    const h = harness({ plan: limited, editorRespond(_path, _body, state) {
        const context = editorContext(state); context.actions.forEach(action => { action.commands = []; });
        return { status: 200, value: context };
    } });
    expect(await h.controller.ready).toBe(true); expect(presentation(limited).planRevision).toBe(1024);
    for (const operation of OPERATIONS) expect(button(h, operation.label)).toBeUndefined();
    expect(form(h)).toBeUndefined(); expect(h.options.newId).not.toHaveBeenCalled();
});

test('cancel clears a local action draft without allocating an operation or sending a write', async () => {
    const h = harness(); await h.controller.ready; chooseAction(h); button(h, 'Assign to me').click();
    fill(h, 'Due date (UTC)', '2026-10-02'); const before = h.request.mock.calls.length, leave = jest.fn();
    expect(await h.controller.requestLeave(leave)).toBe(false); expect(leave).not.toHaveBeenCalled();
    expect(await h.controller.refresh()).toBe(false); expect(await h.controller.select('plan-a')).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(before); expect(h.options.newId).not.toHaveBeenCalled();
    button(h, 'Cancel changes').click(); expect(form(h)).toBeUndefined();
    expect(h.document.activeElement.getAttribute('aria-label')).toBe('Improvement action');
    expect(h.request).toHaveBeenCalledTimes(before); expect(h.options.newId).not.toHaveBeenCalled();
    expect(await h.controller.requestLeave(leave)).toBe(true); expect(leave).toHaveBeenCalledTimes(1);
});

const FORM_VALIDATION_MESSAGES = {
    'Due date (UTC)': 'Enter a valid due date in UTC (YYYY-MM-DD), then save again.',
    'Block reason': 'Enter a block reason of up to 1000 characters using plain text, then save again.',
    'Reopen reason': 'Enter a reopen reason of up to 1000 characters using plain text, then save again.',
    'Completion note': 'Enter a completion note of up to 1000 characters using plain text, then save again.',
    'Completion evidence reference (unverified)': 'Enter an unverified record ID of up to 180 characters without surrounding spaces. URLs and file paths cannot be used.'
};
const INVALID_ACTION_FIELDS = [
    ...[
        ['empty date', ''], ['non-calendar date', '2026-02-30'], ['invalid leap day', '2026-02-29'],
        ['wrong format', '02/10/2026'], ['timestamp instead of calendar day', '2026-10-02T00:00:00.000Z'],
        ['surrounding spaces', ' 2026-10-02 ']
    ].map(([description, value]) => ({ type: 'assign', field: 'Due date (UTC)', description, value })),
    ...[
        ['block', 'Block reason'], ['reopen', 'Reopen reason'], ['complete', 'Completion note']
    ].flatMap(([type, field]) => [
        ['empty text', ''], ['whitespace-only text', ' \n\t '], ['overlong text', 'x'.repeat(1001)],
        ['control character', 'Recorded\u0000text'], ['lone high surrogate', 'Recorded\ud800text'],
        ['lone low surrogate', 'Recorded\udc00text']
    ].map(([description, value]) => ({ type, field, description, value }))),
    ...[
        ['empty reference', ''], ['whitespace-only reference', ' '], ['leading space', ' synthetic:evidence:completion'],
        ['trailing space', 'synthetic:evidence:completion '], ['overlong reference', 'x'.repeat(181)],
        ['control character', 'record\u0000id'], ['newline', 'record\nid'], ['lone high surrogate', 'record\ud800id'],
        ['lone low surrogate', 'record\udc00id'], ['HTTPS URL', 'https://forbidden.invalid/evidence'],
        ['scheme URL', 'custom://forbidden.invalid/evidence'], ['data URI', 'data:text/plain,unverified'],
        ['absolute file path', '/tmp/evidence'], ['relative file path', './evidence'],
        ['parent file path', '../evidence'], ['Windows file path', 'C:\\evidence'], ['UNC path', '\\\\host\\evidence']
    ].map(([description, value]) => ({ type: 'complete', field: 'Completion evidence reference (unverified)', description, value }))
];

test.each(INVALID_ACTION_FIELDS)('$type form identifies $description in $field and saves the corrected same draft once', async invalid => {
    const operation = OPERATIONS.find(item => item.type === invalid.type), before = operation.state();
    const h = harness({ plan: before }); expect(await h.controller.ready).toBe(true);
    const actionId = chooseAction(h); button(h, operation.label).click();
    const retainedForm = form(h), values = { ...operation.values, [invalid.field]: invalid.value };
    for (const [name, value] of Object.entries(values)) fill(h, name, value);
    const control = field(h, invalid.field), feedback = control.parentElement.querySelector('span'), requestCount = h.request.mock.calls.length;
    expect(control.getAttribute('aria-describedby')).toBeNull(); expect(feedback.hidden).toBe(true); expect(feedback.textContent).toBe('');
    await submitForm(h);
    expect(form(h)).toBe(retainedForm); expect(h.state.plans.get('plan-a')).toBe(before);
    expect(h.request).toHaveBeenCalledTimes(requestCount); expect(h.options.newId).not.toHaveBeenCalled();
    expect(h.root.querySelector('[role="status"]').textContent).toBe(FORM_VALIDATION_MESSAGES[invalid.field]);
    expect(h.document.activeElement).toBe(control); expect(control.getAttribute('aria-invalid')).toBe('true');
    const descriptionId = control.getAttribute('aria-describedby');
    expect(descriptionId).toMatch(/^improvement-action-field-feedback-\d+$/);
    expect(h.root.querySelectorAll('[id="' + descriptionId + '"]')).toEqual([feedback]);
    expect(feedback.hidden).toBe(false); expect(feedback.textContent).toBe(FORM_VALIDATION_MESSAGES[invalid.field]);
    for (const [name, value] of Object.entries(values)) expect(field(h, name).value).toBe(value);

    fill(h, invalid.field, operation.values[invalid.field]); await submitForm(h);
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([['/api/dashboard/improvement/execute', {
        planId: 'plan-a', type: operation.type, operationId: 'generated-1', expectedRevision: before.commands.length,
        actionId, payload: operation.payload
    }]]);
    expect(h.options.newId).toHaveBeenCalledTimes(1); expect(form(h)).toBeUndefined();
    expect(h.state.plans.get('plan-a').commands).toHaveLength(before.commands.length + 1);
    expect(control.getAttribute('aria-invalid')).toBeNull(); expect(control.getAttribute('aria-describedby')).toBeNull();
    expect(feedback.hidden).toBe(true); expect(feedback.textContent).toBe('');
});

test('completion validation moves focus to the next invalid field without discarding either value or sending a command', async () => {
    const before = started(), h = harness({ plan: before }); expect(await h.controller.ready).toBe(true);
    const actionId = chooseAction(h); button(h, 'Complete action').click();
    const note = fill(h, 'Completion note', ' '), reference = fill(h, 'Completion evidence reference (unverified)', 'https://forbidden.invalid/evidence');
    const retainedForm = form(h), requestCount = h.request.mock.calls.length;
    const noteFeedback = note.parentElement.querySelector('span'), referenceFeedback = reference.parentElement.querySelector('span');
    await submitForm(h);
    expect(h.document.activeElement).toBe(note); expect(note.getAttribute('aria-invalid')).toBe('true');
    expect(h.root.querySelector('[role="status"]').textContent).toBe(FORM_VALIDATION_MESSAGES['Completion note']);
    expect(note.getAttribute('aria-describedby')).toBe(noteFeedback.getAttribute('id'));
    expect(noteFeedback.hidden).toBe(false); expect(noteFeedback.textContent).toBe(FORM_VALIDATION_MESSAGES['Completion note']);
    expect(reference.getAttribute('aria-describedby')).toBeNull(); expect(referenceFeedback.hidden).toBe(true);
    fill(h, 'Completion note', 'Recorded workflow completion.'); await submitForm(h);
    expect(form(h)).toBe(retainedForm); expect(note.getAttribute('aria-invalid')).toBeNull();
    expect(note.getAttribute('aria-describedby')).toBeNull(); expect(noteFeedback.hidden).toBe(true); expect(noteFeedback.textContent).toBe('');
    expect(h.document.activeElement).toBe(reference); expect(reference.getAttribute('aria-invalid')).toBe('true');
    expect(h.root.querySelector('[role="status"]').textContent).toBe(FORM_VALIDATION_MESSAGES['Completion evidence reference (unverified)']);
    expect(reference.getAttribute('aria-describedby')).toBe(referenceFeedback.getAttribute('id'));
    expect(referenceFeedback.hidden).toBe(false); expect(referenceFeedback.textContent).toBe(FORM_VALIDATION_MESSAGES['Completion evidence reference (unverified)']);
    expect(note.value).toBe('Recorded workflow completion.'); expect(reference.value).toBe('https://forbidden.invalid/evidence');
    expect(h.request).toHaveBeenCalledTimes(requestCount); expect(h.options.newId).not.toHaveBeenCalled();
    expect(h.state.plans.get('plan-a')).toBe(before);

    fill(h, 'Completion evidence reference (unverified)', 'synthetic:evidence:completion'); await submitForm(h);
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([['/api/dashboard/improvement/execute', {
        planId: 'plan-a', type: 'complete', operationId: 'generated-1', expectedRevision: before.commands.length, actionId,
        payload: { note: 'Recorded workflow completion.', evidenceReference: 'synthetic:evidence:completion' }
    }]]);
    expect(h.options.newId).toHaveBeenCalledTimes(1); expect(form(h)).toBeUndefined();
});

test('simultaneous mounts and a remount keep field descriptions unique without allocating command operations', async () => {
    const h = harness(); expect(await h.controller.ready).toBe(true);
    const otherRoot = h.document.createElement('div'), host = h.document.createElement('main'); host.append(h.root, otherRoot);
    const other = { ...h, root: otherRoot, controller: mount(otherRoot, h.options) }; expect(await other.controller.ready).toBe(true);
    const described = [];
    for (const current of [h, other]) {
        chooseAction(current); button(current, 'Assign to me').click();
        const control = fill(current, 'Due date (UTC)', ''); await submitForm(current);
        const id = control.getAttribute('aria-describedby'), feedback = control.parentElement.querySelector('span');
        expect(id).toMatch(/^improvement-action-field-feedback-\d+$/);
        expect(host.querySelectorAll('[id="' + id + '"]')).toEqual([feedback]);
        expect(feedback.hidden).toBe(false); expect(feedback.textContent).toBe(FORM_VALIDATION_MESSAGES['Due date (UTC)']);
        described.push({ id, feedback, root: current.root });
    }
    expect(new Set(described.map(item => item.id)).size).toBe(2);
    expect(h.root.querySelector('[id="' + described[1].id + '"]')).toBeNull();
    expect(other.root.querySelector('[id="' + described[0].id + '"]')).toBeNull();
    other.controller = mount(otherRoot, h.options); expect(await other.controller.ready).toBe(true);
    chooseAction(other); button(other, 'Assign to me').click(); const remountedControl = fill(other, 'Due date (UTC)', ''); await submitForm(other);
    const remountedId = remountedControl.getAttribute('aria-describedby');
    expect(remountedId).toMatch(/^improvement-action-field-feedback-\d+$/);
    expect(described.some(item => item.id === remountedId)).toBe(false);
    expect(host.querySelector('[id="' + described[1].id + '"]')).toBeNull();
    expect(host.querySelectorAll('[id="' + remountedId + '"]')).toEqual([remountedControl.parentElement.querySelector('span')]);
    expect(h.options.newId).not.toHaveBeenCalled();
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([]);
    h.controller.destroy(); other.controller.destroy();
});

test('a 409 keeps the draft for review and requires cancel plus explicit refresh before a new intent', async () => {
    let writes = 0;
    const h = harness({ respond(path, body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page([{ planId: 'plan-a', planRevision: state.plans.get('plan-a').commands.length }]) };
        if (path.includes('/view?')) return { status: 200, value: presentation(state.plans.get('plan-a')) };
        if (path.endsWith('/execute')) {
            writes++; state.plans.set('plan-a', append(state.plans.get('plan-a'), 'assign', { ownerSubjectKey: ACTOR, dueDate: '2026-10-03' }));
            return { status: 409, value: { code: 'improvement_revision_conflict' } };
        }
        throw new Error('unexpected fixture path');
    } });
    await h.controller.ready; chooseAction(h); button(h, 'Assign to me').click(); fill(h, 'Due date (UTC)', '2026-10-02');
    const reads = h.request.mock.calls.length; await submitForm(h);
    expect(writes).toBe(1); expect(h.request.mock.calls).toHaveLength(reads + 1);
    expect(h.root.textContent).toContain('Plan changed'); expect(field(h, 'Due date (UTC)').value).toBe('2026-10-02');
    const formSubmit = form(h).querySelectorAll('button').find(node => node.type === 'submit'); expect(disabled(formSubmit)).toBe(true);
    expect(button(h, 'Retry pending improvement command')).toBeUndefined();
    expect(await h.controller.requestLeave(jest.fn())).toBe(false); expect(await h.controller.refresh()).toBe(false);
    button(h, 'Cancel changes').click(); expect(form(h)).toBeUndefined(); expect(writes).toBe(1);
    expect(await h.controller.refresh()).toBe(true); expect(writes).toBe(1);
    expect(h.request.mock.calls.slice(-2).map(([path]) => path)).toEqual(['/api/dashboard/improvement/view?planId=plan-a',
        '/api/dashboard/improvement/editor?planId=plan-a']);
    expect(h.root.textContent).toContain('2026-10-03'); expect(h.options.newId).toHaveBeenCalledTimes(1);
});

test('uncertain action submission disables editing and cancel while retry reuses the exact captured identity', async () => {
    let attempts = 0, first;
    const h = harness({ respond(path, body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page() };
        if (path.includes('/view?')) return { status: 200, value: presentation(state.plans.get('plan-a')) };
        if (path.endsWith('/execute')) {
            first ||= body; expect(body).toBe(first);
            if (++attempts === 1) return { status: 503, value: { code: 'improvement_outcome_ambiguous' } };
            const after = append(state.plans.get('plan-a'), body.type, body.payload, body.actionId, body.operationId, body.expectedRevision);
            state.plans.set('plan-a', after); return { status: 200, value: { schemaVersion: 1, plan: getImprovementPlanView(after) } };
        }
        throw new Error('unexpected fixture path');
    } });
    await h.controller.ready; chooseAction(h); button(h, 'Assign to me').click(); fill(h, 'Due date (UTC)', '2026-10-02');
    await submitForm(h); expect(attempts).toBe(1); expect(disabled(field(h, 'Due date (UTC)'))).toBe(true);
    expect(disabled(button(h, 'Cancel changes'))).toBe(true); expect(await h.controller.requestLeave(jest.fn())).toBe(false);
    field(h, 'Due date (UTC)').value = '2030-01-01'; emit(field(h, 'Due date (UTC)'), 'input');
    button(h, 'Retry pending improvement command').click(); await settle();
    expect(attempts).toBe(2); expect(first.payload.dueDate).toBe('2026-10-02'); expect(h.options.newId).toHaveBeenCalledTimes(1);
    expect(form(h)).toBeUndefined(); expect(h.root.textContent).toContain('2026-10-02');
});

test.each([401, 403])('editor-context %i clears all private action and plan content', async status => {
    const h = harness({ editorRespond: () => ({ status, value: { code: 'improvement_access_denied' } }) });
    await h.controller.ready; expect(h.root.querySelectorAll('article')).toEqual([]); expect(form(h)).toBeUndefined();
    expect(h.root.textContent).not.toContain(seed().proposals[0].suggestedAction); const count = h.request.mock.calls.length;
    expect(await h.controller.refresh()).toBe(false); expect(h.request).toHaveBeenCalledTimes(count);
});

test.each([401, 403])('action write %i clears the draft and makes retained submit callbacks inert', async status => {
    const h = harness({ plan: started(), respond(path, _body, state) {
        if (path.includes('/plans?')) return { status: 200, value: page([{ planId: 'plan-a', planRevision: state.plans.get('plan-a').commands.length }]) };
        if (path.includes('/view?')) return { status: 200, value: presentation(state.plans.get('plan-a')) };
        return { status, value: { code: 'improvement_access_denied' } };
    } });
    await h.controller.ready; chooseAction(h); button(h, 'Block action').click(); fill(h, 'Block reason', 'PRIVATE_DRAFT_DO_NOT_RETAIN');
    const retained = form(h); await submitForm(h);
    expect(form(h)).toBeUndefined(); expect(h.root.querySelectorAll('article')).toEqual([]);
    expect(h.root.textContent).not.toContain('PRIVATE_DRAFT_DO_NOT_RETAIN');
    const count = h.request.mock.calls.length; emit(retained, 'submit'); await settle();
    expect(h.request).toHaveBeenCalledTimes(count); expect(await h.controller.retry()).toBe(false);
});

test.each(['destroy', 'scope'])('late editor context after %s cannot enable a form or disclose retained content', async kind => {
    const waiting = deferred(), h = harness({ editorRespond: () => waiting.promise });
    await settle(); expect(h.request.mock.calls.at(-1)[0]).toBe('/api/dashboard/improvement/editor?planId=plan-a');
    if (kind === 'destroy') h.controller.destroy(); else h.state.current = false;
    waiting.resolve({ status: 200, value: editorContext(h.state) }); expect(await h.controller.ready).toBe(false);
    expect(h.root.textContent).toBe(''); expect(form(h)).toBeUndefined();
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/execute'))).toEqual([]);
});
