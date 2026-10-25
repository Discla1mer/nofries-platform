'use strict';

const { harness, flush, NOW, GA, ASSESSMENT } = require('./fixtures/dashboardCrossFeatureHarness');
const { clone } = require('./fixtures/ncscAssessmentFixture');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');

let active;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { active?.close(); active = null; jest.clearAllTimers(); jest.useRealTimers(); });

async function editor(account) {
    active = await harness(account); await flush(); await active.open(); await active.resume();
    expect(active.byId('ncsc-question-index').value).toBe('2'); return active;
}
function expectUsable(h, input) {
    expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.hidden).toBe(false);
    expect(h.elements.dashboardApp.inert).toBe(false); expect(h.document.activeElement).toBe(input);
    expect(h.byId(input.id)).toBe(input); expect(h.mounts).toHaveLength(1);
    expect(h.mounts[0].destroy).not.toHaveBeenCalled();
}

describe.each(['company', 'consultant'])('%s saved assessment across account access refresh', account => {
    test('ten separate focus returns retain the dirty answer, rationale, focus and saved revision', async () => {
        const h = await editor(account), answer = h.choose(2, 'not_applicable');
        const input = h.byId('ncsc-rationale-' + h.cyber.metadata.questions[2].id);
        input.value = 'Synthetic local rationale, not yet saved.'; h.event(input, 'input'); input.focus();
        const before = clone(h.backend.versions.get(ASSESSMENT));
        for (let pass = 0; pass < 10; pass++) {
            const first = h.requests.length; h.window.dispatch('focus'); await flush();
            for (let storm = 0; storm < 20; storm++) h.window.dispatch('focus');
            await flush(); expect(h.requests).toHaveLength(first + 1); expectUsable(h, input);
            await h.refresh(first); expectUsable(h, input);
            expect(input.value).toBe('Synthetic local rationale, not yet saved.'); expect(answer.checked).toBe(true);
            expect(h.byId('ncsc-question-index').children[2].textContent).toContain('*');
            expect(h.requests.slice(first)).toHaveLength(5);
            expect(h.requests.slice(first).every(row => row.init.method === 'GET')).toBe(true);
        }
        expect(h.backend.mutations).toHaveLength(0); expect(h.backend.versions.get(ASSESSMENT)).toEqual(before);
        expect(h.requests.filter(row => /bootstrap|modules\/cyber_security|ncsc\/assessments/.test(row.url))
            .every(row => row.init.headers['X-NoFries-Dashboard-Generation'] === GA)).toBe(true);
    });

    test('one explicit save overlaps slow refresh, then navigation and fresh read resume the same saved record', async () => {
        const h = await editor(account); h.choose(2, 'no');
        const save = h.requests.length; h.button('Save progress').click(); await flush();
        expect(h.requests[save].init.method).toBe('POST');
        const command = JSON.parse(h.requests[save].init.body);
        expect(h.requests[save].url).toBe('/api/dashboard/ncsc/assessments/' + ASSESSMENT + '/save');
        expect(command).toMatchObject({ expectedRevision: 1,
            payload: { responses: [{ itemId: h.cyber.metadata.questions[2].id, optionId: 'no' }] } });
        const refresh = h.requests.length; h.window.dispatch('focus'); await flush();
        await h.reply(refresh, 200, h.session); await h.serve(save);
        expect(h.elements.dashboardApp.textContent).toContain('Your progress is saved.');
        await h.refresh(refresh);
        const saved = clone(h.backend.versions.get(ASSESSMENT));
        expect(projectNcscDetail(saved)).toMatchObject({ revision: 2, status: 'in-progress', progress: { answered: 3 } });
        const initial = projectNcscDetail(h.backend.initial);
        expect(initial).toMatchObject({ revision: 1, progress: { answered: 2 } });
        expect(initial.responses.some(row => row.itemId === h.cyber.metadata.questions[2].id)).toBe(false);
        h.button('Back to assessments').click(); await flush(); await h.serve(h.requests.length - 1); await h.resume();
        expect(h.byId('ncsc-question-index').value).toBe('3');
        const picker = h.byId('ncsc-question-index'); picker.value = '2'; h.event(picker, 'change');
        expect(h.byId('ncsc-answer-' + h.cyber.metadata.questions[2].id + '-no').checked).toBe(true);
        expect(h.byId('ncsc-question-index').children[2].textContent).not.toContain('*');
        expect(h.backend.versions.get(ASSESSMENT)).toEqual(saved); expect(h.backend.mutations).toHaveLength(1);
        expect(h.requests.filter(row => row.init.method === 'POST')).toHaveLength(1);
    });

    test.each([401, 403])('final authority witness %s removes dirty content and detached controls cannot save', async status => {
        const h = await editor(account); const detached = h.choose(2, 'partial'), save = h.button('Save progress');
        const first = h.requests.length; h.window.dispatch('focus'); await flush();
        await h.reply(first, 200, h.session); await h.reply(first + 1, 200, h.directory);
        await h.reply(first + 2, 200, h.model); await h.reply(first + 3, 200, h.cyber);
        expect(h.elements.dashboardApp.hidden).toBe(false);
        await h.reply(first + 4, status, { code: 'synthetic_access_denied' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied');
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        const count = h.requests.length; detached.checked = true; h.event(detached, 'change'); save.click(); await flush();
        expect(h.requests).toHaveLength(count); expect(h.backend.mutations).toHaveLength(0);
        expect(h.backend.versions.get(ASSESSMENT)).toEqual(h.backend.initial);
    });
});

test('Consultant return guards dirty saved answers; Stay and Discard preserve stored revision before reopening', async () => {
    const h = await editor('consultant'); h.choose(2, 'no');
    const first = h.requests.length, back = h.byId('consultantPortfolioControls');
    back.onclick(); await flush(); expect(h.button('Stay here')).toBeDefined();
    h.button('Stay here').click(); await flush(); expect(h.requests).toHaveLength(first);
    expect(h.byId('ncsc-question-index').children[2].textContent).toContain('*');
    back.onclick(); await flush(); h.button('Discard unsent changes').click(); await flush();
    expect(h.window.location.hash).toBe('#organisations'); expect(h.elements.dashboardApp.hidden).toBe(true);
    await h.reply(first, 200, h.session); await h.reply(first + 1, 200, h.directory);
    expect(h.status).toBe('selection'); expect(h.byId('clientSetupControls')).toBeNull();
    expect(h.backend.mutations).toHaveLength(0); expect(h.backend.versions.get(ASSESSMENT)).toEqual(h.backend.initial);
    // Re-enter the selected Cyber route via a fresh focus restoration,
    // avoiding another selection command merely to validate saved readback.
    h.window.location.hash = '#cyber-security'; h.window.dispatch('pagehide');
    h.window.dispatch('focus'); await flush(); await h.open(h.requests.length - 1); await h.resume();
    expect(h.byId('ncsc-question-index').value).toBe('2');
    expect(h.byId('ncsc-question-index').children[2].textContent).not.toContain('*');
    expect(h.requests.every(row => row.init.method === 'GET')).toBe(true);
});
