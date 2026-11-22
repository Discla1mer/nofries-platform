'use strict';
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { createDashboardService } = require('../api/shared/dashboardService');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { mount, projectIsoOutput } = require('../api/shared/protectedAssets/paidResults');
const { fixture, reason } = require('./fixtures/paidResults');
const { createDom } = require('./fixtures/dashboardDom');

function render(data, extra) {
    const dom = createDom();
    dom.document.body = dom.document.createElement('body');
    dom.document.body.append(dom.root);
    const copied = jest.fn(), printed = jest.fn(() => dom.document.body.querySelector('article').textContent);
    dom.window.navigator = { clipboard: { writeText: copied } };
    dom.window.print = printed;
    dom.window.crypto = webcrypto;
    const handle = mount(dom.root, { ...data, isCurrent: () => true, ...extra });
    return { ...dom, handle, copied, printed, buttons: () => dom.root.querySelectorAll('button') };
}
const boardKind = 'iso_board_summary', statementKind = 'iso_statement_of_applicability';
const reportIds = { [boardKind]: 'issued-board-1', [statementKind]: 'issued-statement-1' };
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const click = (view, i) => [...view.buttons()[i].events.click][0]();

function issuedFixture(data, change = value => value) {
    const read = jest.fn(async intent => {
        const content = projectIsoOutput(data.record, data.publication, intent.outputKind);
        return change({ intent: { ...intent }, content, outputSha256: digest(content) });
    });
    return { reportIds, read };
}

test('server projection fixes document bytes independently of saved response order', () => {
    const { record, publication } = fixture(true);
    const board = projectIsoOutput(record, publication, boardKind), statement = projectIsoOutput(record, publication, statementKind);
    expect(digest(board)).toBe('3ca42ae2601d8630e4e69c01ca20d96f3302c15e391cb4e7d1ea9a651a8d8f6f');
    expect(digest(statement)).toBe('1948b6ad07f634b278625ba0f579196bdf1f97d75c69a4d5367eb6c4038ae6b5');
    expect(JSON.parse(board)).toMatchObject({ formatVersion: 1, outputKind: boardKind });
    expect(board).toContain('50% (3 applicable');
    expect(board).toContain('No applicable controls (0 applicable');
    expect(board).not.toContain(reason);
    expect(JSON.parse(statement).blocks.slice(3)).toHaveLength(93);
    expect(statement).toContain(reason);
    record.assessment.responses.reverse();
    expect(projectIsoOutput(record, publication, boardKind)).toBe(board);
    expect(projectIsoOutput(record, publication, statementKind)).toBe(statement);
    expect(() => projectIsoOutput(record, publication, 'monthly')).toThrow();
    const nist = fixture(false);
    expect(() => projectIsoOutput(nist.record, nist.publication, boardKind)).toThrow();
});

// #521's grouped-results assertions, kept on screen: #512 limits Copy and Print to issued ISO outputs.
test.each([true, false])('sealed grouped results on screen, ISO=%s', iso => {
    const view = render(fixture(iso));
    expect(view.root.querySelectorAll('ul')[0].children).toHaveLength(iso ? 11 : 6);
    const gaps = view.root.querySelector('ol').children;
    expect(gaps).toHaveLength(3);
    expect(gaps.every(item => item.children[0].textContent.endsWith(iso ? 'Not started' : 'No'))).toBe(true);
    expect(view.buttons()).toHaveLength(0);
    expect(view.root.textContent).toContain('Top gaps');
    if (iso) {
        const claim = 'This is a readiness self-assessment, not certification. For accredited certification, use an accredited certification body.';
        expect(view.root.textContent).toContain(claim);
        expect(view.root.querySelectorAll('article')).toHaveLength(93);
        expect(view.root.textContent).toContain('No applicable controls');
        expect(view.root.textContent).toContain('0 applicable · 8 marked not applicable');
        expect(view.root.textContent).toContain(reason);
        expect(view.root.querySelector('em')).toBeNull();
    } else {
        const govern = view.root.querySelector('ul').children[0];
        expect(govern.children.map(child => child.textContent)).toEqual(['GV · Govern', '32.3%–71.0%',
            'Set direction and accountability · 31 outcomes · 6 unknown · 6 marked not applicable']);
        expect(view.root.textContent).toContain('Republished courtesy');
    }
});

test('clicks carry the independently issued report ID and the sealed intent', async () => {
    const data = fixture(true), issued = issuedFixture(data);
    const view = render(data, { issuedExports: issued });
    expect(issued.read).not.toHaveBeenCalled();
    expect(view.buttons().map(b => b.textContent)).toEqual(['Copy board summary', 'Print board summary',
        'Copy statement of applicability', 'Print statement of applicability']);
    const keys = new Set();
    for (let i = 0; i < 4; i++) {
        await click(view, i);
        const kind = i < 2 ? boardKind : statementKind;
        const intent = issued.read.mock.calls[i][0];
        expect(intent).toEqual({ outputKind: kind, action: i % 2 ? 'print' : 'copy', issuedReportId: reportIds[kind],
            assessmentId: 'synthetic-board', expectedRevision: 3, responseSetSha256: 'e'.repeat(64), idempotencyKey: expect.any(String) });
        keys.add(intent.idempotencyKey);
    }
    expect(keys.size).toBe(4);
    const claim = 'This is a readiness self-assessment, not certification. For accredited certification, use an accredited certification body.';
    expect(view.root.textContent).toContain(claim);
    expect(view.copied.mock.calls[0][0]).toContain(claim);
    expect(view.copied.mock.calls[0][0]).toContain('Top gaps');
    expect(view.copied.mock.calls[1][0]).toContain(reason);
    expect(view.printed).toHaveBeenCalledTimes(2);
    expect(view.document.body.children).toHaveLength(1);
    expect(view.root.querySelector('em')).toBeNull();
});
test('only the ISO output with an issued identifier has controls', () => {
    const data = fixture(true), issued = issuedFixture(data);
    const onlyBoard = { ...issued, reportIds: { [boardKind]: reportIds[boardKind] } };
    expect(render(data, { issuedExports: onlyBoard }).buttons().map(b => b.textContent)).toEqual(['Copy board summary', 'Print board summary']);
    expect(render(fixture(false), { issuedExports: issued }).buttons()).toHaveLength(0);
    expect(render(data, { authoriseExport: () => true }).buttons()).toHaveLength(0);
});
test.each([
    () => true, receipt => ({...receipt, intent: {...receipt.intent, issuedReportId: reportIds[statementKind]}}),
    receipt => ({...receipt, intent: {...receipt.intent, outputKind: statementKind}}),
    receipt => ({...receipt, intent: {...receipt.intent, assessmentId: 'other'}}),
    receipt => ({...receipt, intent: {...receipt.intent, expectedRevision: 2}}),
    receipt => ({...receipt, intent: {...receipt.intent, responseSetSha256: 'f'.repeat(64)}}),
    receipt => ({...receipt, intent: {...receipt.intent, action: 'print'}}),
    receipt => ({...receipt, intent: {...receipt.intent, idempotencyKey: 'other'}}),
    receipt => ({...receipt, content: 'A different issued report', outputSha256: digest('A different issued report')}),
    receipt => ({...receipt, outputSha256: 'd'.repeat(64)})
])('wrong receipt, intent or artifact cannot disclose an output', async change => {
    const data = fixture(true), view = render(data, { issuedExports: issuedFixture(data, change) });
    await click(view, 0);
    expect(view.copied).not.toHaveBeenCalled();
    expect(view.root.textContent).toContain('Copy is unavailable');
});
test('a lost receipt or clipboard failure reuses the original intent until delivery', async () => {
    const data = fixture(true), issued = issuedFixture(data), view = render(data, { issuedExports: issued });
    issued.read.mockRejectedValueOnce(new Error('unconfirmed'));
    view.copied.mockRejectedValueOnce(new Error('clipboard unavailable'));
    for (let i = 0; i < 4; i++) await click(view, 0);
    const keys = issued.read.mock.calls.map(([intent]) => intent.idempotencyKey);
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
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
    const view = render(data, { issuedExports: issuedFixture(data) });
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
    const gaps = view.root.querySelector('ol').children;
    expect(gaps).toHaveLength(3);
    expect(gaps.every(item => item.children[0].textContent.endsWith(iso ? 'Not started' : 'No'))).toBe(true);
    if (iso) {
        expect(view.root.textContent).toContain(reason);
        expect(view.root.querySelectorAll('article')).toHaveLength(93);
    } else {
        const govern = view.root.querySelector('ul').children[0];
        expect(govern.textContent).toContain('32.3%–71.0%');
        // #521 replaced the trailing 'to confirm' with the function purpose and an unknown count.
        expect(govern.textContent).toContain('Set direction and accountability · 31 outcomes · 6 unknown · 6 marked not applicable');
        expect(view.root.textContent).toContain('Republished courtesy');
    }
    expect(view.root.querySelectorAll('input')).toHaveLength(0);
    expect(view.copied).not.toHaveBeenCalled();
    expect(view.printed).not.toHaveBeenCalled();
});
test('a refused issued read leaves results on screen and makes no local export', async () => {
    const data = fixture(true), issued = issuedFixture(data);
    issued.read.mockRejectedValue(new Error('export refused'));
    const view = render(data, { issuedExports: issued });
    for (let i = 0; i < view.buttons().length; i++) await click(view, i);
    expect(view.root.textContent).toContain(reason);
    expect(view.copied).not.toHaveBeenCalled();
    expect(view.printed).not.toHaveBeenCalled();
});
test.each(['switch', 'replace'])('a pending issued read cannot disclose after %s', async operation => {
    const data = fixture(true), issued = issuedFixture(data);
    let current = true, release;
    const wait = new Promise(resolve => { release = resolve; });
    const view = render(data, { issuedExports: { reportIds, read: async intent => { await wait; return issued.read(intent); } },
        isCurrent: () => current });
    const pending = click(view, 1);
    await click(view, 1);
    if (operation === 'switch') current = false;
    else {
        mount(view.root, { ...fixture(false), isCurrent: () => true });
        view.handle.destroy();
        expect(view.root.textContent).toContain('NIST CSF 2.0');
        expect(view.root.textContent).not.toContain(reason);
    }
    release(); await pending;
    expect(issued.read).toHaveBeenCalledTimes(1);
    expect(view.printed).not.toHaveBeenCalled();
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
