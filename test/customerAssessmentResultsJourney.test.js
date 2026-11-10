'use strict';

// Production loader, shell, questionnaire, client, handlers and evaluator with
// synthetic identity, DOM and in-memory storage. Not hosted/browser acceptance.
const { harness, flush, NOW, GA, ASSESSMENT } = require('./fixtures/dashboardCrossFeatureHarness');
const { clone } = require('./fixtures/ncscAssessmentFixture');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
const { evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');

let active;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { active?.close(); active = null; jest.clearAllTimers(); jest.useRealTimers(); });

// Release only the exact assessment requests made by the real client. A bounded
// loop fails rather than letting an unexpected background request pass silently.
async function settleAssessment(h, first) {
    let index = first;
    for (let turn = 0; turn < 20; turn++) {
        await flush();
        if (index === h.requests.length) return;
        await h.serve(index++);
    }
    throw new Error('Assessment journey exceeded its request budget');
}

describe.each(['company', 'consultant'])('%s calculated assessment journey', account => {
    test('save, resume, confirm once and reopen preserve the same answers and reproducible results', async () => {
        active = await harness(account); const h = active;
        await flush(); await h.open(); await h.resume();
        const original = clone(h.backend.initial);
        const options = ['partial', 'no', 'unknown', 'not_applicable', ...Array(10).fill('yes')];
        options.forEach((option, index) => h.choose(index, option));
        h.choose(3, 'not_applicable');
        const rationale = h.byId('ncsc-rationale-' + h.cyber.metadata.questions[3].id);
        rationale.value = 'Synthetic applicability claim awaiting review.'; h.event(rationale, 'input');
        let first = h.requests.length;
        h.button('Save progress').click(); await settleAssessment(h, first);
        const saved = clone(h.backend.versions.get(ASSESSMENT));
        const savedDetail = projectNcscDetail(saved);
        expect(savedDetail).toMatchObject({ status: 'in-progress', progress: { answered: 14 } });
        expect(h.backend.mutations.map(command => command.action)).toEqual(['save']);
        expect(Object.fromEntries(savedDetail.responses.map(row => [row.itemId, row.optionId])))
            .toEqual(Object.fromEntries(h.cyber.metadata.questions.map((question, index) => [question.id, options[index]])));
        expect(h.backend.initial).toEqual(original);

        first = h.requests.length;
        h.button('Back to assessments').click(); await settleAssessment(h, first); await h.resume();
        expect(h.requests.slice(first).every(row => row.init.method === 'GET')).toBe(true);
        h.choose(3, 'not_applicable');
        expect(h.byId(rationale.id).value).toBe(rationale.value);
        // Opening and cancelling review are read-only even after leaving/resuming.
        first = h.requests.length;
        h.button('Review and submit').click();
        expect(h.elements.dashboardApp.querySelectorAll('.ncsc-review-item')).toHaveLength(14);
        h.button('Back to questions').click(); h.button('Review and submit').click();
        expect(h.requests).toHaveLength(first);
        const confirm = h.button('Save and submit assessment'); confirm.click(); confirm.click(); confirm.click();
        expect(h.elements.dashboardApp.querySelectorAll('.ncsc-submit-dialog')).toHaveLength(1);
        expect(h.requests).toHaveLength(first);
        h.button('Cancel').click();
        expect(h.elements.dashboardApp.querySelector('.ncsc-submit-dialog')).toBeNull();
        expect(h.requests).toHaveLength(first);
        confirm.click();
        const submit = h.button('Submit'); submit.click(); submit.click(); submit.click();
        await settleAssessment(h, first);
        expect(h.backend.mutations.map(command => command.action)).toEqual(['save', 'submit']);
        expect(h.requests.filter(row => row.init.method === 'POST').map(row => row.url)).toEqual([
            '/api/dashboard/ncsc/assessments/' + ASSESSMENT + '/save',
            '/api/dashboard/ncsc/assessments/' + ASSESSMENT + '/submit'
        ]);

        const submitted = clone(h.backend.versions.get(ASSESSMENT));
        const detail = projectNcscDetail(submitted), { input, evaluation } = submitted.envelope.submission;
        expect(detail).toMatchObject({ assessmentId: ASSESSMENT, status: 'submitted', revision: savedDetail.revision + 1 });
        expect(detail.responses).toEqual(savedDetail.responses);
        expect(detail.scopePopulation).toEqual(savedDetail.scopePopulation);
        expect(evaluation).toEqual(evaluateAcceptedNcscAssessment(JSON.parse(JSON.stringify(input))));
        expect(evaluation.provenance).toMatchObject({ assessmentId: ASSESSMENT,
            assessmentRevision: 'rev-' + detail.revision, scoreAsOf: NOW });
        expect(evaluation.countsCompletion).toMatchObject({ yes: 10, partial: 1, no: 1,
            unknown: 2, directUnknown: 1, missing: 0, claimedNotApplicableAtoms: 1,
            approvedNotApplicableAtoms: 0, completionNumerator: 12, completionDenominator: 14 });
        const resultText = h.elements.dashboardApp.querySelector('.ncsc-results').textContent;
        function expectCalculatedResults() {
            const panel = h.elements.dashboardApp.querySelector('.ncsc-results');
            expect(panel.querySelectorAll('.ncsc-result-metric').map(card => card.querySelector('.ncsc-result-value').textContent))
                .toEqual(['75.0%–89.3%', '12 of 14', '0.0%']);
            expect(panel.textContent).toContain('85.7%');
            expect(panel.textContent).toContain(rationale.value);
            expect(panel.textContent).toContain('Calculation inputs and versions');
            expect(panel.textContent).toContain(evaluation.outputSha256);
            expect(panel.textContent).toContain(detail.submission.responseSetSha256);
            expect(h.button('Retry loading results')).toBeUndefined();
        }
        expectCalculatedResults();
        expect(h.button('Save progress')).toBeUndefined();
        expect(h.button('Save and submit assessment')).toBeUndefined();

        first = h.requests.length;
        h.button('Back to assessments').click(); await settleAssessment(h, first); await h.resume();
        expectCalculatedResults();
        expect(h.elements.dashboardApp.querySelector('.ncsc-results').textContent).toBe(resultText);
        expect(h.requests.slice(first).every(row => row.init.method === 'GET')).toBe(true);
        expect(h.backend.versions.get(ASSESSMENT)).toEqual(submitted);
        expect(h.backend.mutations).toHaveLength(2);
        expect(h.requests.filter(row => row.url.startsWith('/api/dashboard/ncsc/assessments'))
            .every(row => row.init.headers['X-NoFries-Dashboard-Generation'] === GA)).toBe(true);
    });
});
