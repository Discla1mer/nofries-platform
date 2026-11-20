'use strict';
const vm = require('node:vm');
const { createDashboardService } = require('../api/shared/dashboardService');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { mount } = require('../api/shared/protectedAssets/paidResults');
const { fixture, reason } = require('./fixtures/paidResults');
const { createDom } = require('./fixtures/dashboardDom');

function render(data, extra) {
    const dom = createDom();
    dom.document.body = dom.document.createElement('body');
    dom.document.body.append(dom.root);
    const copied = jest.fn(), printed = jest.fn(() => dom.document.body.querySelector('article').textContent);
    dom.window.navigator = { clipboard: { writeText: copied } };
    dom.window.print = printed;
    const handle = mount(dom.root, { ...data, isCurrent: () => true, ...extra });
    return { ...dom, handle, copied, printed, buttons: () => dom.root.querySelectorAll('button') };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test.each([true, false])('sealed grouped results and explicit exports, ISO=%s', async iso => {
    const permit = jest.fn(async () => true), view = render(fixture(iso), { authoriseExport: permit });
    expect(view.root.querySelectorAll('ul')[0].children).toHaveLength(iso ? 11 : 6);
    const gaps = view.root.querySelector('ol').children;
    expect(gaps).toHaveLength(3);
    expect(gaps.every(item => item.children[0].textContent.endsWith(iso ? 'Not started' : 'No'))).toBe(true);
    expect(view.buttons().map(button => button.textContent)).toEqual(['Copy board summary', 'Print board summary',
        ...(iso ? ['Copy statement of applicability', 'Print statement of applicability'] : [])]);
    for (const button of view.buttons()) { button.click(); await flush(); }
    expect(permit).toHaveBeenCalledTimes(iso ? 4 : 2);
    expect(view.printed).toHaveBeenCalledTimes(iso ? 2 : 1);
    expect(view.document.body.children).toHaveLength(1);
    expect(view.copied.mock.calls[0][0]).toContain('Top gaps');
    if (iso) {
        const claim = 'This is a readiness self-assessment, not certification. For accredited certification, use an accredited certification body.';
        expect(view.root.textContent).toContain(claim);
        expect(view.copied.mock.calls[0][0]).toContain(claim);
        expect(view.root.querySelectorAll('article')).toHaveLength(93);
        expect(view.copied.mock.calls[0][0]).toContain('No applicable controls (0 applicable · 8 marked not applicable)');
        expect(view.copied.mock.calls[0][0]).toContain('50% (3 applicable');
        expect(view.copied.mock.calls[1][0]).toContain(reason);
        expect(view.root.querySelector('em')).toBeNull();
    } else {
        expect(view.copied.mock.calls[0][0]).toContain('GV · Govern — 32.3%–71.0% (Set direction and accountability · 31 outcomes · 6 unknown · 6 marked not applicable)');
        expect(view.copied.mock.calls[0][0]).toContain('Republished courtesy');
    }
});

test.each([
    data => { data.record.assessment.profileRef.profileId = 'ncsc'; },
    data => { data.record.assessment.moduleId = 'improvement_plan'; },
    data => { data.record.assessment.profileRef.profileVersion = 'other'; },
    data => { data.record.assessment.profileRef.sourceCatalogueSha256 = '0'.repeat(64); },
    data => { data.record.assessment.profileRef.catalogueSha256 = '0'.repeat(64); },
    data => { data.record.assessment.status = 'in-progress'; },
    data => { data.record.assessment.submission.revision--; },
    data => { data.record.assessment.responses.pop(); },
    data => { data.record.assessment.responses[0] = data.record.assessment.responses[1]; },
    data => { data.record.assessment.responses[0].optionId = 'not_applicable'; },
    data => { data.record.assessment.responses.find(r => r.rationale).rationale.text = ' '; }
])('mismatched, incomplete or unsealed reads fail closed', change => {
    const data = fixture(true); change(data);
    const view = render(data, { authoriseExport: async () => true });
    expect(view.root.textContent).toBe('These saved results are unavailable.');
    expect(view.buttons()).toHaveLength(0);
});
test('the shared authenticated application serves the free questionnaire without the paid renderer', async () => {
    const service = createDashboardService(admissionFixture().adapters);
    const app = await service.handleRequest({ method: 'GET' }, 'app.js');
    expect(app.status).toBe(200);
    const browser = {};
    vm.runInNewContext(app.body, browser);
    expect(typeof browser.NoFriesNcscQuestionnaire.mount).toBe('function');
    expect(browser.NoFriesPaidResults).toBeUndefined();
    expect(app.body).not.toContain('A range starts at the reported readiness');
    expect(app.body).not.toContain('what evidence the board will see');
    expect(app.body).not.toContain('No applicable controls');
});
test.each([true, false])('read-only results show the selected submission without a report export or plan write, ISO=%s', iso => {
    const view = render(fixture(iso));
    expect(view.buttons()).toHaveLength(0);
    expect(view.root.textContent).toContain('Board summary');
    expect(view.root.querySelector('ul').children).toHaveLength(iso ? 11 : 6);
    if (iso) expect(view.root.textContent).toContain(reason);
    expect(view.root.querySelectorAll('input')).toHaveLength(0);
    expect(view.copied).not.toHaveBeenCalled();
    expect(view.printed).not.toHaveBeenCalled();
});
test('revoked export is refused', async () => {
    const view = render(fixture(true), { authoriseExport: async () => false });
    for (const button of view.buttons()) { button.click(); await flush(); }
    expect(view.copied).not.toHaveBeenCalled();
    expect(view.printed).not.toHaveBeenCalled();
    expect(view.root.querySelectorAll('input')).toHaveLength(0);
});
test('a pending grant cannot export after a generation change or a replacement selection', async () => {
    let resolve, current = true;
    const view = render(fixture(true), { authoriseExport: () => new Promise(done => { resolve = done; }), isCurrent: () => current });
    view.buttons()[0].click(); current = false; resolve(true); await flush();
    expect(view.copied).not.toHaveBeenCalled();
    current = true; view.buttons()[1].click();
    mount(view.root, { ...fixture(false), isCurrent: () => true });
    view.handle.destroy(); resolve(true); await flush();
    expect(view.printed).not.toHaveBeenCalled();
    expect(view.root.textContent).toContain('NIST CSF 2.0');
    expect(view.root.textContent).not.toContain(reason);
});

function nistAnswers(overrides, defaultAnswer = 'yes') {
    const data = fixture(false);
    for (const answer of data.record.assessment.responses) {
        answer.optionId = overrides[answer.itemId] || defaultAnswer;
        answer.rationale = answer.optionId === 'not_applicable' ? { text: reason } : null;
    }
    return render(data);
}

test('the NIST board counts all reported gaps and uncertain answers before selecting the top three', () => {
    const view = render(fixture(false));
    expect(view.root.textContent).toContain('The team reported gaps in 42 of 106 outcomes. 42 answers need confirmation.');
    expect(view.root.textContent).toContain('Start with business needs (Govern, GV.OC-04). Agree who owns the next step');
    expect(view.root.querySelector('ul').children.map(row => row.children[0].textContent))
        .toEqual(['GV · Govern', 'ID · Identify', 'PR · Protect', 'DE · Detect', 'RS · Respond', 'RC · Recover']);
    expect(view.root.querySelector('ol').children).toHaveLength(3);
});

test('a known NIST gap leads the board decision before uncertain answers in earlier functions', () => {
    const view = nistAnswers({ 'GV.OC-01-Q1': 'unknown', 'ID.AM-01-Q1': 'not_applicable', 'RC.RP-01-Q1': 'partial' });
    expect(view.root.textContent).toContain('1 of 106 outcomes. 2 answers need confirmation.');
    expect(view.root.textContent).toContain('Start with restoring services (Recover, RC.RP-01). Agree who owns the next step');
    const gaps = view.root.querySelector('ol').children;
    expect(gaps[0].textContent).toContain('Ask the recovery lead');
    expect(gaps[1].textContent).toContain('Find the person who can answer');
    expect(gaps[2].textContent).toContain('Check the recorded reason against the scope');
    expect(view.buttons()).toHaveLength(0);
});

test('unconfirmed NIST outcomes prompt a check and all-Yes outcomes prompt an evidence review', () => {
    const uncertain = nistAnswers({ 'PR.AA-01-Q1': 'not_applicable' });
    expect(uncertain.root.textContent).toContain('0 of 106 outcomes. 1 answer needs confirmation.');
    expect(uncertain.root.textContent).toContain('Ask management to check the answer about identity and access (Protect, PR.AA-01)');
    const complete = nistAnswers({});
    expect(complete.root.textContent).toContain('The team marked all 106 outcomes Yes.');
    expect(complete.root.textContent).toContain('ask a service owner to show recent evidence');
    expect(complete.root.querySelector('ol').children).toHaveLength(0);
    expect(render(fixture(true)).root.textContent).not.toContain('of 106 outcomes');
});

test('each published NIST category has a board topic and a suggested next step for a reported gap', () => {
    const { publication } = fixture(false);
    const categories = new Set();
    for (const question of publication.questions) {
        const category = question.controlId.split('-')[0];
        if (categories.has(category)) continue;
        categories.add(category);
        const view = nistAnswers({ [question.id]: 'no' });
        const gap = view.root.querySelector('ol').children[0];
        expect(view.root.textContent).toContain('Start with ');
        expect(view.root.textContent).toContain(', ' + question.controlId + ').');
        expect(gap.children[1].textContent).not.toBe(question.guidance.startingActions[0]);
        expect(gap.children[1].textContent.length).toBeGreaterThan(0);
    }
    expect(categories.size).toBe(22);
});
