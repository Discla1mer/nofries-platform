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
    expect(digest(board)).toBe('4ed4237e205745b13e7ca6bf1f2193e8b19e9328d636417ed8d8d5bad1ec997d');
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
    expect(app.body).not.toContain('Unknown answers and claims of non-applicability stay in the range');
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
        expect(govern.textContent).toContain('31 outcomes · 6 marked not applicable, to confirm');
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
