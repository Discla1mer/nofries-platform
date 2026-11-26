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
        const report = questionnaire.questionnaireAnswers(assessment, V2());
        const output = panel.querySelector('.ncsc-questionnaire-answers');
        expect(output.querySelectorAll('li')).toHaveLength(11);
        expect(output.querySelector('textarea').value).toBe(report.text);
        expect(output.textContent).toContain(report.footer);
        // 9 graded part-credit answers and 5 No: 14 gaps to fix, 2 "I don't know" to check.
        expect(panel.querySelector('.ncsc-verdict').textContent).toBe('You have 14 gaps to fix and 2 answers to check.');
        ui.controller.destroy();
    });

    test.each([['yes', 'Yes'], ['partly', 'Partly'], ['ad_hoc', 'Partly'], ['no', 'No'],
        ['unknown', 'Not answered'], ['not_applicable', 'Not answered']])('insurer answers use the v2 source question and its own option: %s', (saved, expected) => {
        const md = V2(), assessment = { status: 'submitted', profileRef: md.profileRef,
            scopePopulation: { description: 'Fictional office' }, responses: md.questions.map(q => ({ itemId: q.id, optionId: saved })) };
        const report = questionnaire.questionnaireAnswers(assessment, md), byId = Object.fromEntries(report.items.map(row => [row.id, row]));
        for (const id of ['mfa', 'backup-storage', 'restore-tests', 'training', 'incident-plan', 'admin-rights', 'payment-checks', 'supplier-access', 'email-protection']) {
            expect(byId[id].answer).toBe(expected);
            expect(byId[id].question).toMatch(/\?$/);
            if (saved === 'ad_hoc') expect(byId[id].basis).toContain('Sometimes, but not written down or checked');
        }
        expect(byId['patch-speed'].answer).toBe('Not answered'); // PA does not ask for a deadline.
        expect(byId.endpoint.answer).toBe('Not answered'); // Alerts do not attest EDR coverage.
        expect(byId['restore-tests'].question).toContain('three months');
        expect(byId['backup-storage'].question).toContain('out of reach of ransomware');
    });

    test('MFA method does not imply coverage, and backup storage does not imply a restore test', () => {
        const md = V2(), a = { status: 'submitted', profileRef: md.profileRef, scopePopulation: { description: 'Test' },
            responses: [{ itemId: 'NF-NCSC-MCSS-MF-01-Q2', optionId: 'mfa_key' },
                { itemId: 'NF-NCSC-MCSS-DR-01-Q1', optionId: 'yes' }] };
        const rows = () => Object.fromEntries(questionnaire.questionnaireAnswers(a, md).items.map(item => [item.id, item.answer]));
        expect(rows()).toMatchObject({ mfa: 'Not answered', 'backup-storage': 'Yes', 'restore-tests': 'Not answered' });
        a.responses.push(...a.responses);
        expect(rows()['backup-storage']).toBe('Not answered');
        a.responses = [{ itemId: 'NF-NCSC-MCSS-MF-01-Q1', optionId: 'mfa_key' }];
        expect(rows().mfa).toBe('Not answered');
        a.responses[0].optionId = 'yes';
        a.profileRef = { ...md.profileRef, sourceCatalogueSha256: 'a'.repeat(64) };
        expect(Object.values(rows()).every(answer => answer === 'Not answered')).toBe(true);
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

    test.each([[14, ACCEPTED_NCSC_CONTEXT], [16, NCSC_V2_CONTEXT]])(
        'signed-in progress counts the actual retained questions when either profile is available: %i', async (total, profile) => {
            const h = await backend(profile); await h.execute(createCommand());
            const ui = mountUi(h);
            try {
                await until(() => listButton(ui)); listButton(ui).click();
                await until(() => ui.root.textContent.includes('0 of ' + total + ' answered'));
            } finally { ui.controller.destroy(); }
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

    test('a supplied profile that is not exactly the pinned v2 profile is refused (fail closed)', async () => {
        const h = await backend(ACCEPTED_NCSC_CONTEXT, { profileMetadata: null });
        const mount = profileMetadata => () => {
            const dom = createDom(); dom.root = dom.document.createElement('div');
            questionnaire.mount(dom.root, { metadata: V1(), ...(profileMetadata === undefined ? {} : { profileMetadata }), client: h.client,
                organisationId: h.organisationId, presentationMode: 'editable', window: dom.window, autosaveIdleMs: 0 }).destroy();
        };
        const ref = V2().profileRef;
        const near = Object.keys(ref).map(key => ({ ...V2(), profileRef: { ...ref, [key]: key.endsWith('Sha256') ? 'e'.repeat(64) : ref[key] + 'x' } }));
        near.push({ ...V2(), profileRef: { ...ref, extra: 'x' } });
        near.push({ ...V2(), profileRef: Object.fromEntries(Object.entries(ref).slice(1)) });
        for (const profile of near) {
            expect(mount([profile])).toThrow('ncsc_composition_required');
            expect(mount([V2(), profile])).toThrow('ncsc_composition_required');
        }
        expect(mount([V1()])).toThrow('ncsc_composition_required');
        expect(mount(undefined)).not.toThrow();
        expect(mount([V2()])).not.toThrow();
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
        expect(ui.root.textContent).toContain('Not sure? You can check later.');
        // v1 worked examples are keyed by question id and never shown on a v2 question with the same id.
        expect(ui.root.textContent).not.toContain('This matches Partial');
        ui.controller.destroy();
        const saved = await h.client.save(saveCommand('assessment-a', 0, 'save-new', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]));
        expect(saved.assessment.responses).toEqual([{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]);
        // An assessment this client has not seen has no known profile: the
        // synchronous check is shape only, never another profile's questions.
        expect(h.client.normaliseCommand(saveCommand('assessment-z', 0, 'save-z', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]))
            .payload.responses).toHaveLength(1);
        expect(() => h.client.normaliseCommand(saveCommand('assessment-z', 0, 'save-z', [{ itemId: 'not an id', optionId: 'ad_hoc', rationale: null }])))
            .toThrow(expect.objectContaining({ code: 'ncsc_input_invalid' }));
    });

    test('scoring v2 (#399): a save to an assessment the client has not seen reads its profile first', async () => {
        const h = await backend();
        await h.execute(createCommand());
        const calls = [];
        const fetch = (path, options) => { calls.push((options && options.method) + ' ' + path); return h.fetch(path, options); };
        // A fresh client: the v2 assessment is checked against v2, so a v1-only question is refused before any write.
        const fresh = clientModule.createClient({ metadata: V1(), profileMetadata: [V2()], fetch });
        await expect(fresh.save(saveCommand('assessment-a', 0, 'save-v1', [{ itemId: 'NF-NCSC-CC-AC-01-Q1', optionId: 'partial', rationale: null }])))
            .rejects.toMatchObject({ code: 'ncsc_input_invalid' });
        expect(calls).toEqual(['GET ' + PREFIX + '/assessment-a']);
        const other = clientModule.createClient({ metadata: V1(), profileMetadata: [V2()], fetch });
        const saved = await other.save(saveCommand('assessment-a', 0, 'save-v2', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]));
        expect(saved.assessment.responses).toEqual([{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }]);
        expect(calls.slice(1)).toEqual(['GET ' + PREFIX + '/assessment-a', 'POST ' + PREFIX + '/assessment-a/save']);
        // A second save needs no read: the profile is now known.
        await other.save(saveCommand('assessment-a', 1, 'save-v2b', [{ itemId: 'NF-NCSC-CC-EM-01-Q1', optionId: 'partly', rationale: null }]));
        expect(calls.slice(3)).toEqual(['POST ' + PREFIX + '/assessment-a/save']);
        // With one profile (flag off) nothing is read first.
        const single = clientModule.createClient({ metadata: V1(), fetch });
        await expect(single.save(saveCommand('assessment-a', 2, 'save-x', [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'ad_hoc', rationale: null }])))
            .rejects.toMatchObject({ code: 'ncsc_input_invalid' });
        expect(calls).toHaveLength(4);
    });
});

test('board commitments distinguish two questions on one control and a ranked unknown', async () => {
    const metadata = V2();
    const backup = metadata.questions.filter(question => question.id.includes('-DR-'));
    const unknown = metadata.questions.find(question => question.id.endsWith('MF-01-Q1'));
    const expected = [unknown, ...backup];
    const answers = metadata.questions.map(question => question === unknown ? 'unknown' : backup.includes(question) ? 'no' : question.responseOptionIds[0]);
    const { h, assessment } = await submittedV2(answers);
    const dom = createDom();
    const readBoardPlan = jest.fn(async () => expected.map((q, i) => ({ itemId: q.id, controlId: q.controlId,
        kind: q === unknown ? 'assessment' : 'implementation', owner: 'Synthetic owner ' + i, dueDate: '2026-11-24', editTarget: null })));
    const picture = require('../api/shared/protectedAssets/organisationPicture');
    const controller = picture.mount(dom.root, { client: h.client, metadata, organisationId: h.organisationId, readBoardPlan, openAction: jest.fn() });
    await until(() => dom.root.querySelector('.picture-summary'));
    const board = dom.root.querySelector('.picture-summary'); board.open = true;
    for (const callback of board.events.toggle) callback();
    await until(() => board.querySelector('.picture-board-actions').querySelectorAll('li').length === 3);
    const paper = board.querySelector('.picture-board-print').textContent;
    backup.forEach((q, i) => expect(paper).toContain(q.prompt + ' — Synthetic owner ' + (i + 1)));
    expect(paper).toContain('Synthetic owner 0');
    expect(readBoardPlan.mock.calls[0][0].outputSha256).toBe(assessment.submission.evaluation.outputSha256);
    controller.destroy();
});
