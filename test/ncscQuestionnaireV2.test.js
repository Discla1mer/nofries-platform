'use strict';

// Scoring v2 (#399), browser slice: questionnaire metadata for profile
// 2026-11-18.1 and the questionnaire's results for a retained v2 assessment.
// The real service, handlers, store transitions and evaluator run; only the
// durable transaction is replaced, as in ncscQuestionnaire.test.js.
const crypto = require('crypto');
const { createNcscQuestionnaireMetadata, createNcscQuestionnaireMetadataV2 } = require('../api/shared/ncscQuestionnaireMetadata');
const clientModule = require('../api/shared/protectedAssets/ncscAssessmentClient');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');
const { createNcscFrameworkProfileV2 } = require('../api/shared/assessmentEngine/ncscFrameworkProfileV2');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail, projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createCommand, saveCommand, submitCommand, clone } = require('./fixtures/ncscAssessmentFixture');
const { createDom } = require('./fixtures/dashboardDom');

const PREFIX = '/api/dashboard/ncsc/assessments';
const V1 = () => createNcscQuestionnaireMetadata();
const V2 = () => createNcscQuestionnaireMetadataV2();
// The worked example in #399, in profile order: 25.3% with two "I don't know" answers.
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
    'no', 'ad_hoc', 'partly', 'no', 'unknown'];
const pause = () => new Promise(resolve => setImmediate(resolve));
const sha256 = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8' } });
const v2Answers = (answers = EXAMPLE) => NCSC_V2_CONTEXT.questionIds.map((itemId, index) => ({ itemId, optionId: answers[index],
    rationale: answers[index] === 'not_applicable' ? { text: 'Synthetic: no office network.' } : null }));

let flag;
beforeEach(() => { flag = process.env.NOFRIES_NCSC_PROFILE_V2; process.env.NOFRIES_NCSC_PROFILE_V2 = 'true'; });
afterEach(() => { if (flag === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = flag; });

// New assessments are created on `createWith` (create-on-v2 is a later step of #399).
async function backend(createWith = NCSC_V2_CONTEXT, settings = {}) {
    // After 2026-11-18, when the v2 profile takes effect.
    const at = '2026-11-20T09:00:00.000Z', fixture = ncscFixture({ now: at }), clock = createClock(at);
    const context = await createContext(fixture.scope, clock);
    const versions = new Map();
    const repository = {
        async listNcscAssessments(_context, page) {
            const ids = [...versions.keys()].sort().filter(id => !page.afterAssessmentId || id > page.afterAssessmentId);
            const selected = ids.slice(0, page.limit);
            return { schemaVersion: 1, assessments: selected.map(id => projectNcscSummary(versions.get(id))),
                nextAfterAssessmentId: ids.length > selected.length ? selected.at(-1) : null };
        },
        async readNcscAssessment(_context, selector) {
            return { schemaVersion: 1, assessment: projectNcscDetail(versions.get(selector.assessmentId)) };
        },
        async executeNcscAssessment(current, input) {
            const command = normaliseNcscCommand(input), intent = stableIntent(current, command);
            const value = makeVersion(intent, command.idempotencyKey, versions.get(command.assessmentId) || null,
                fixture.state.tenantAggregate, clock.now(), command.action === 'create' ? createWith : undefined);
            versions.set(command.assessmentId, value);
            return clone({ schemaVersion: 1, action: command.action, assessment: projectNcscDetail(value) });
        }
    };
    const service = createNcscAssessmentService({ repository, requestContext: { resolve: async () => context } });
    const handlers = createNcscAssessmentHandlers({ service, guardMutation: async () => true });
    const fetch = jest.fn(async (url, init) => {
        const parsed = new URL(url, 'https://synthetic.invalid');
        const request = { method: init.method || 'GET', query: Object.fromEntries(parsed.searchParams),
            ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) };
        const response = await handlers.handleRequest(request, decodeURIComponent(parsed.pathname.slice(PREFIX.length).replace(/^\//, '')));
        return reply(response.body, response.status);
    });
    const profileMetadata = settings.profileMetadata === undefined ? [V2()] : settings.profileMetadata;
    return { fetch, versions, organisationId: fixture.scope.organisationId,
        client: clientModule.createClient({ metadata: V1(), ...(profileMetadata ? { profileMetadata } : {}), fetch }),
        execute: command => repository.executeNcscAssessment(context, command) };
}
async function submittedV2(answers = EXAMPLE, id = 'assessment-a') {
    const h = await backend();
    await h.execute(createCommand(id, 'create-' + id)); await h.execute(saveCommand(id, 0, 'save-' + id, v2Answers(answers)));
    const response = await h.execute(submitCommand(id, 1, 'submit-' + id));
    return { h, assessment: response.assessment };
}
function mountUi(h, settings = {}) {
    const dom = createDom(); dom.root = dom.document.createElement('div');
    const controller = questionnaire.mount(dom.root, { metadata: V1(), profileMetadata: [V2()], client: h.client,
        organisationId: h.organisationId, presentationMode: 'editable', window: dom.window, autosaveIdleMs: 0, ...settings });
    return { ...dom, controller };
}
async function until(predicate) {
    const end = Date.now() + 4000;
    while (!predicate() && Date.now() < end) await pause();
    expect(Boolean(predicate())).toBe(true);
}
const listButton = ui => (ui.root.querySelector('.ncsc-assessment-list')?.querySelectorAll('button') || [])[0];

describe('v2 questionnaire metadata', () => {
    test('v1 metadata is byte-identical to main and v2 projects the 16-question profile without scoring data', () => {
        // Digest of JSON.stringify(createNcscQuestionnaireMetadata()) at main 136a264.
        expect(sha256(V1())).toBe('c15efe24838eea00c3e84b0a3874d4825539a6ed48a449889c64dd4250a5c3ba');
        const v2 = V2(), profile = createNcscFrameworkProfileV2();
        expect(v2.profileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
        expect(v2.questions.map(question => question.id)).toEqual(NCSC_V2_CONTEXT.questionIds);
        v2.questions.forEach(question => {
            const source = profile.questions.find(row => row.id === question.id);
            expect(question.prompt).toBe(source.prompt); expect(question.guidance).toEqual(source.guidance);
            expect(question).not.toHaveProperty('smallBusiness');
        });
        expect(v2.limitations).toContain('This is a No Fries planning score from your answers, not an official NCSC or CS-CMM rating.');
        expect(JSON.stringify(v2)).not.toMatch(/implementationFactor|"weight"|"sourceIds"|sourceReferences/);
        expect(Object.isFrozen(v2.questions[0])).toBe(true);
        expect(() => clientModule.createClient({ metadata: V1(), profileMetadata: [V2()], fetch: jest.fn() })).not.toThrow();
    });

    test('the browser pins equal the server profile and evaluator for every answer and question', async () => {
        const profile = createNcscFrameworkProfileV2();
        // Each answer on its own: the browser's per-atom check accepts the server's credit only if its table agrees.
        for (const optionId of ['yes', 'partly', 'ad_hoc', 'no', 'unknown']) {
            const { h, assessment } = await submittedV2(EXAMPLE.map((_, index) => index === 5 ? 'mfa_key' : optionId), 'a-' + optionId);
            expect(questionnaire.resultModel(assessment, V2(), h.organisationId)).not.toBeNull();
        }
        for (const optionId of profile.questions[5].responseOptionIds) {
            const { h, assessment } = await submittedV2(EXAMPLE.map((answer, index) => index === 5 ? optionId : answer), 'm-' + optionId);
            const model = questionnaire.resultModel(assessment, V2(), h.organisationId);
            expect(model).not.toBeNull();
            const row = model.domains.flatMap(domain => domain.controls.flatMap(control => control.questions)).find(item => item.itemId === 'NF-NCSC-MCSS-MF-01-Q2');
            expect(row).toMatchObject({ responseOptionId: optionId, weight: 2 });
        }
    });
});

describe('v2 results in the questionnaire', () => {
    test('the worked example renders 25.3% with v2 question text, weights and answer labels', async () => {
        const { h, assessment } = await submittedV2(), before = clone(assessment);
        const model = questionnaire.resultModel(assessment, V2(), h.organisationId);
        expect(model).toMatchObject({ lowerDisplay: '25.3%', upperDisplay: '35.0%', unknown: 2, denominatorWeight: 31,
            lowerCreditUnits: 785, completed: 14, total: 16 });
        expect(assessment).toEqual(before);
        // Never by the v1 metadata, and never by profileVersion alone.
        expect(questionnaire.resultModel(assessment, V1(), h.organisationId)).toBeNull();
        const near = clone(V2()); near.profileRef.catalogueSha256 = V1().profileRef.catalogueSha256;
        expect(questionnaire.resultModel(assessment, near, h.organisationId)).toBeNull();

        const ui = mountUi(h); await until(() => listButton(ui)); listButton(ui).click();
        await until(() => ui.root.querySelector('.ncsc-result-metric'));
        const panel = ui.root.querySelector('.ncsc-results');
        expect(panel.querySelector('.ncsc-result-value').textContent).toBe('25.3% in place');
        expect(panel.textContent).toContain('This is a No Fries planning score from your answers, not an official NCSC or CS-CMM rating.');
        expect(panel.textContent).not.toContain('No Fries weights every question equally');
        expect(panel.textContent).toContain(NCSC_V2_CONTEXT.profile.questions[14].prompt);
        expect(panel.textContent).toContain('Limit supplier access');
        expect(panel.textContent).toContain('Saved answer: Text or email code only. Weight: 2.');
        expect(panel.textContent).toContain('Saved answer: Sometimes, but not written down or checked. Weight: 2.');
        // The insurer answers map v1 questions only, so they are not offered for a v2 result.
        expect(panel.querySelector('.ncsc-questionnaire-answers')).toBeNull();
        // 9 graded part-credit answers and 5 No: 14 gaps to fix, 2 "I don't know" to check.
        expect(panel.querySelector('.ncsc-verdict').textContent).toBe('You have 14 gaps to fix and 2 answers to check.');
        ui.controller.destroy();
    });

    test('provider and board summaries group v2 answers by credit, with each answer\'s own label', async () => {
        const answers = EXAMPLE.slice(); answers[0] = 'yes'; answers[5] = 'mfa_key'; answers[13] = 'not_applicable';
        const { assessment } = await submittedV2(answers);
        const provider = questionnaire.providerSummary(assessment, V2());
        const title = id => V2().controls.find(control => control.id === id).title;
        expect(provider.items.map(item => item.title)).toContain(title('NF-NCSC-MCSS-MF-01') + ' — Partly in place');
        expect(provider.items.some(item => item.title.endsWith(' — Sometimes, but not written down or checked'))).toBe(true);
        expect(provider.items.some(item => item.title.endsWith(' — I don\'t know'))).toBe(true);
        expect(provider.items.find(item => item.title.startsWith('Limit supplier access')).action)
            .toBe('List who has access, turn on the extra login step, and add a breach-notice clause.');
        const board = questionnaire.boardSummary(assessment, V2()).text;
        const section = heading => board.split('\n\n').find(part => part.startsWith(heading + ':')) || '';
        expect(section('In place')).toContain(title('NF-NCSC-MCSS-RM-01'));
        expect(section('Partly in place')).toContain(title('NF-NCSC-MCSS-SA-01'));
        expect(section('Not in place yet')).toContain('Limit supplier access');
        expect(section('Not yet confirmed')).toContain('Protect your business email');
        expect(section('Marked not applicable (to be confirmed)')).toContain('Protect and separate your network');
    });

    test('v1 results are unchanged when v2 metadata is also supplied', async () => {
        const h = await backend(ACCEPTED_NCSC_CONTEXT);
        const ids = ACCEPTED_NCSC_CONTEXT.questionIds;
        await h.execute(createCommand()); await h.execute(saveCommand('assessment-a', 0, 'save-a', ids.map(itemId => ({ itemId, optionId: 'partial', rationale: null }))));
        await h.execute(submitCommand());
        const html = async profileMetadata => {
            const dom = createDom(); dom.root = dom.document.createElement('div');
            const client = clientModule.createClient({ metadata: V1(), ...(profileMetadata ? { profileMetadata } : {}), fetch: h.fetch });
            const controller = questionnaire.mount(dom.root, { metadata: V1(), ...(profileMetadata ? { profileMetadata } : {}), client,
                organisationId: h.organisationId, presentationMode: 'editable', window: dom.window, autosaveIdleMs: 0 });
            await until(() => listButton(dom)); listButton(dom).click();
            await until(() => dom.root.querySelector('.ncsc-result-metric'));
            const text = dom.root.textContent; controller.destroy(); return text;
        };
        const without = await html(null), withV2 = await html([V2()]);
        expect(withV2).toBe(without);
        expect(without).toContain('No Fries weights every question equally');
    });

    test('without v2 metadata (flag off) the client refuses a v2 assessment exactly as before', async () => {
        const { h } = await submittedV2();
        const client = clientModule.createClient({ metadata: V1(), fetch: h.fetch });
        await expect(client.read('assessment-a')).rejects.toMatchObject({ code: 'ncsc_unavailable' });
        await expect(client.list()).rejects.toMatchObject({ code: 'ncsc_unavailable' });
        await expect((await backend(NCSC_V2_CONTEXT, { profileMetadata: [V2()] })).client.list()).resolves.toMatchObject({ assessments: [] });
    });

    test('a v2 draft opens with v2 questions and answers, and saves through the client against its own profile', async () => {
        const h = await backend();
        await h.execute(createCommand());
        const ui = mountUi(h); await until(() => listButton(ui)); listButton(ui).click();
        await until(() => ui.root.querySelector('fieldset'));
        expect(ui.root.querySelector('legend').textContent).toBe(NCSC_V2_CONTEXT.profile.questions[0].prompt);
        expect(ui.root.textContent).toContain('Sometimes, but not written down or checked');
        expect(ui.root.textContent).toContain('It happens sometimes, but it is not written down, owned or checked.');
        expect(ui.root.textContent).toContain('Not sure? Choose I don\'t know.');
        // v1 worked examples are keyed by question id and never shown on a v2 question with the same id.
        expect(ui.root.textContent).not.toContain('This matches Partial');
        ui.controller.destroy();
        const saved = await h.client.save(saveCommand('assessment-a', 0, 'save-new', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]));
        expect(saved.assessment.responses).toEqual([{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]);
        // A v1 assessment in the same client is still held to v1 questions.
        await h.execute(createCommand('assessment-b', 'create-b'));
        expect(() => h.client.normaliseCommand(saveCommand('assessment-z', 0, 'save-z', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }])))
            .toThrow(expect.objectContaining({ code: 'ncsc_input_invalid' }));
    });
});
