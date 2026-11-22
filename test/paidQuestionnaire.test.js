'use strict';
const { mount } = require('../api/shared/protectedAssets/paidQuestionnaire');
const { fixture } = require('./fixtures/paidResults');
const { createDom } = require('./fixtures/dashboardDom');

// The shared minimal DOM lacks a few members this renderer uses; add them for this file only.
function dom() {
    const view = createDom(), proto = Object.getPrototypeOf(view.root), append = proto.append;
    Object.defineProperties(proto, {
        parentNode: { get() { return this.parentElement || null; } },
        options: { get() { return this.children.filter(child => child.tagName === 'OPTION'); } }
    });
    Object.assign(proto, {
        append(...children) {
            append.apply(this, children.map(child => {
                if (typeof child !== 'string') return child;
                const text = view.document.createElement('#text'); text.textContent = child; return text;
            }));
        },
        appendChild(child) { this.append(child); return child; },
        reportValidity() { return !this.validationMessage; }
    });
    view.window.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
    view.window.confirm = jest.fn(() => true);
    view.unload = [];
    const add = view.window.addEventListener, remove = view.window.removeEventListener;
    view.window.addEventListener = jest.fn((name, fn) => { if (name === 'beforeunload') view.unload.push(fn); add(name, fn); });
    view.window.removeEventListener = jest.fn((name, fn) => { if (name === 'beforeunload' && view.unload.includes(fn)) view.unload.splice(view.unload.indexOf(fn), 1); remove(name, fn); });
    return view;
}
const NA_TEXT = 'Synthetic: no hired equipment in this scope.';
const flush = () => new Promise(resolve => setImmediate(resolve));
// The paid adapter projects the stored rationale text as { text } (paidAssessments.js project()).
function inProgress(responses = []) {
    const data = fixture(true);
    data.publication.questions.forEach(q => { q.prompt = 'Synthetic prompt for ' + q.id; });
    Object.assign(data.record.assessment, { status: 'in-progress', revision: 1, submission: null, responses });
    return data;
}
function render(data = inProgress(), extra = {}) {
    const view = dom();
    const mutate = jest.fn(extra.mutate || (async (_path, body) => echo(data.record, body)));
    const handle = mount(view.root, { ...data, isCurrent: () => true, mutate, showResults: jest.fn(), ...extra, mutate });
    const radios = () => view.root.querySelectorAll('input').filter(input => input.type === 'radio');
    const button = label => view.root.querySelectorAll('button').find(b => b.textContent === label);
    const choose = optionId => {
        const legend = view.root.querySelector('legend').textContent;
        const question = data.publication.questions.find(q => q.prompt === legend);
        radios()[question.responseOptionIds.indexOf(optionId)].onchange();
    };
    const reason = () => view.root.querySelector('textarea');
    const status = () => view.root.querySelector('p.ncsc-status') || view.root.querySelectorAll('p').find(p => p.getAttribute('role') === 'status');
    return { ...view, handle, mutate, data, radios, button, choose, reason, status };
}
// Server echo: the saved revision with every submitted response merged in.
function echo(record, body) {
    const responses = new Map(record.assessment.responses.map(row => [row.itemId, row]));
    for (const row of body.payload.responses) responses.set(row.itemId, row);
    record.assessment = { ...record.assessment, revision: body.expectedRevision + 1, status: 'in-progress',
        responses: [...responses.values()] };
    return JSON.parse(JSON.stringify(record));
}
const firstQuestion = data => data.publication.questions.find(q => q.controlId === 'C4.1');
const naQuestion = data => data.publication.questions.find(q => q.controlId === 'A.5.1');

test('renders the first unanswered question with its options and saved progress', () => {
    const data = inProgress(), q = firstQuestion(data);
    data.record.assessment.responses = [{ itemId: q.id, optionId: 'in_place', rationale: null }];
    const view = render(data);
    expect(view.root.querySelector('h1').textContent).toBe('ISO 27001 readiness self-assessment');
    expect(view.root.textContent).toContain('1 of ' + data.publication.questions.length + ' answers saved');
    expect(view.root.querySelector('legend').textContent).toBe(data.publication.questions.find(row => row.controlId === 'C4.2').prompt);
    expect(view.radios()).toHaveLength(4);
    expect(view.button('Save progress').disabled).toBe(true);
    expect(view.handle.hasUnsavedChanges()).toBe(false);
});

test('answering marks the form dirty, and choosing the saved answer again clears it', () => {
    const data = inProgress(), q = firstQuestion(data);
    data.record.assessment.responses = [{ itemId: q.id, optionId: 'in_place', rationale: null }];
    const view = render(data);
    // Go back to the saved question.
    view.button('Previous').onclick();
    expect(view.root.querySelector('legend').textContent).toBe(q.prompt);
    view.choose('partly_in_place');
    expect(view.handle.hasUnsavedChanges()).toBe(true);
    expect(view.status().textContent).toBe('Unsaved changes (1).');
    expect(view.button('Save progress').disabled).toBe(false);
    view.choose('in_place');
    expect(view.handle.hasUnsavedChanges()).toBe(false);
    expect(view.status().textContent).toBe('');
    expect(view.button('Save progress').disabled).toBe(true);
});

test('a not-applicable answer needs a reason before it can be saved', async () => {
    const data = inProgress(), q = naQuestion(data);
    const view = render(data);
    view.root.querySelectorAll('select')[0].selectedIndex = data.publication.domains.findIndex(d => d.id === 'A.5');
    view.root.querySelectorAll('select')[0].onchange();
    expect(view.root.querySelector('legend').textContent).toBe(q.prompt);
    view.choose('not_applicable');
    expect(view.reason().parentElement.hidden).toBe(false);
    view.button('Save progress').onclick(); await flush();
    expect(view.mutate).not.toHaveBeenCalled();
    expect(view.reason().validationMessage).toBe('Enter a reason or choose another answer.');
    view.reason().value = '   '; view.reason().oninput();
    view.button('Save progress').onclick(); await flush();
    expect(view.mutate).not.toHaveBeenCalled();
    view.reason().value = '  ' + NA_TEXT + '  '; view.reason().oninput();
    view.button('Save progress').onclick(); await flush();
    expect(view.mutate).toHaveBeenCalledTimes(1);
    expect(view.mutate.mock.calls[0][1].payload.responses).toEqual([{ itemId: q.id, optionId: 'not_applicable', rationale: { text: NA_TEXT } }]);
});

test('the save payload names the pinned endpoint, revision, idempotency key and only the changed answers', async () => {
    const data = inProgress(), view = render(data), q = firstQuestion(data);
    view.choose('partly_in_place');
    view.button('Next').onclick();
    view.choose('not_started');
    view.button('Save progress').onclick(); await flush();
    expect(view.mutate).toHaveBeenCalledTimes(1);
    const [path, body] = view.mutate.mock.calls[0];
    expect(path).toBe('/api/dashboard/frameworks/nf-iso-27001-2022-readiness/2026-11-19.1/assessments/synthetic-board/save');
    expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'idempotencyKey', 'payload']);
    expect(body).toEqual({ expectedRevision: 1, idempotencyKey: '00000000-0000-4000-8000-000000000001', payload: { responses: [
        { itemId: q.id, optionId: 'partly_in_place', rationale: null },
        { itemId: data.publication.questions.find(row => row.controlId === 'C4.2').id, optionId: 'not_started', rationale: null }] } });
    expect(view.handle.hasUnsavedChanges()).toBe(false);
    expect(view.status().textContent).toBe('Progress saved.');
    expect(view.root.textContent).toContain('2 of ' + data.publication.questions.length + ' answers saved');
});

test('the unload guard follows unsaved answers and is removed on save and on teardown', async () => {
    let fail = true;
    const data = inProgress(), view = render(data, { mutate: async (_path, body) => {
        if (fail) throw Object.assign(new Error('synthetic'), { status: 503 });
        return echo(data.record, body);
    } });
    expect(view.unload).toHaveLength(0);
    view.choose('partly_in_place');
    expect(view.unload).toHaveLength(1);
    expect(view.window.listenerCount('beforeunload')).toBe(1);
    const event = { preventDefault: jest.fn(), returnValue: undefined };
    expect(view.unload[0](event)).toBe('');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
    // An unconfirmed save keeps the answers unsaved, so the guard stays.
    view.button('Save progress').onclick(); await flush();
    expect(view.handle.hasUnsavedChanges()).toBe(true);
    expect(view.unload).toHaveLength(1);
    fail = false;
    view.button('Try again').onclick(); await flush();
    expect(view.handle.hasUnsavedChanges()).toBe(false);
    expect(view.unload).toHaveLength(0);
    expect(view.window.listenerCount('beforeunload')).toBe(0);
    view.button('Next').onclick();
    view.choose('in_place');
    expect(view.unload).toHaveLength(1);
    const listener = view.unload[0];
    view.handle.destroy();
    expect(view.unload).toHaveLength(0);
    expect(view.window.listenerCount('beforeunload')).toBe(0);
    const late = { preventDefault: jest.fn() };
    expect(listener(late)).toBeUndefined();
    expect(late.preventDefault).not.toHaveBeenCalled();
});

test('reverting the only edit removes the guard without a save', () => {
    const view = render();
    view.choose('in_place');
    expect(view.unload).toHaveLength(1);
    view.choose('in_place');
    expect(view.handle.hasUnsavedChanges()).toBe(true);
    const data = inProgress(), q = firstQuestion(data);
    data.record.assessment.responses = [{ itemId: q.id, optionId: 'in_place', rationale: null }];
    const saved = render(data);
    saved.button('Previous').onclick();
    saved.choose('not_started');
    expect(saved.unload).toHaveLength(1);
    saved.choose('in_place');
    expect(saved.unload).toHaveLength(0);
});

test('saved not-applicable answers keep their stored rationale text and round-trip unchanged', async () => {
    const data = inProgress(), q = naQuestion(data);
    data.record.assessment.responses = [{ itemId: q.id, optionId: 'not_applicable', rationale: { text: NA_TEXT } }];
    const view = render(data);
    expect(view.handle.hasUnsavedChanges()).toBe(false);
    view.root.querySelectorAll('select')[0].selectedIndex = data.publication.domains.findIndex(d => d.id === 'A.5');
    view.root.querySelectorAll('select')[0].onchange();
    // The section opens on its first incomplete question; move back to the saved one.
    view.button('Previous').onclick();
    expect(view.root.querySelector('legend').textContent).toBe(q.prompt);
    expect(view.reason().value).toBe(NA_TEXT);
    expect(view.reason().parentElement.hidden).toBe(false);
    expect(view.button('Save progress').disabled).toBe(true);
    // Editing another answer and saving leaves the stored rationale as returned by the adapter.
    view.button('Next').onclick();
    view.choose('in_place');
    view.button('Save progress').onclick(); await flush();
    expect(view.mutate.mock.calls[0][1].payload.responses).toHaveLength(1);
    expect(view.status().textContent).toBe('Progress saved.');
    expect(data.record.assessment.responses.find(row => row.itemId === q.id)).toEqual({ itemId: q.id, optionId: 'not_applicable', rationale: { text: NA_TEXT } });
});

test.each([
    ['a not-applicable answer without its text', { optionId: 'not_applicable', rationale: null }],
    ['a blank rationale', { optionId: 'not_applicable', rationale: { text: ' ' } }],
    ['a rationale on an applicable answer', { optionId: 'in_place', rationale: { text: NA_TEXT } }],
    ['an option the question does not offer', { optionId: 'yes', rationale: null }]
])('a saved read with %s fails closed', (_, change) => {
    const data = inProgress(), q = naQuestion(data);
    data.record.assessment.responses = [{ itemId: q.id, ...change }];
    expect(() => render(data)).toThrow('response_mismatch');
});

test('a profile mismatch or a stale selection refuses to render', () => {
    const data = inProgress();
    data.record.assessment.profileRef.profileVersion = 'other';
    expect(() => render(data)).toThrow('assessment_mismatch');
    expect(() => render(inProgress(), { isCurrent: () => false })).toThrow('assessment_unavailable');
});

test('the pinned renderer integrity matches every packaged paid renderer file', () => {
    const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
    const { rendererIntegrity } = require('../api/shared/protectedAssets/dashboardRegistry');
    for (const [name, file] of [['collection', 'paidCollection.js'], ['questionnaire', 'paidQuestionnaire.js'], ['results', 'paidResults.js']]) {
        const bytes = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets', file));
        expect('sha256-' + createHash('sha256').update(bytes).digest('base64')).toBe(rendererIntegrity[name]);
    }
    // The ISO questionnaire pin covers the shared questionnaire followed by the ISO glossary.
    const { paidFrameworks, rendererAsset } = require('../api/shared/protectedAssets/dashboardRegistry');
    const iso = paidFrameworks.find(ref => ref.profileId === 'nf-iso-27001-2022-readiness');
    const directory = path.join(__dirname, '../api/shared/protectedAssets');
    const isoBytes = Buffer.concat([fs.readFileSync(path.join(directory, 'paidQuestionnaire.js')),
        fs.readFileSync(path.join(directory, 'isoQuestionnaireGlossary.js'))]);
    expect(rendererAsset(iso, 'questionnaire')).toEqual({ withIsoTerms: true,
        integrity: 'sha256-' + createHash('sha256').update(isoBytes).digest('base64') });
});
