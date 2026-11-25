'use strict';

// Scoring v2 (#399), browser slice 2: Overview for a tenant that holds both
// accepted-profile (v1) and 2026-11-18.1 (v2) results. The real service,
// handlers, store transitions, evaluator and bounded client run; only the
// durable transaction is replaced, as in ncscQuestionnaireV2.test.js.
const { createNcscQuestionnaireMetadata, createNcscQuestionnaireMetadataV2 } = require('../api/shared/ncscQuestionnaireMetadata');
const clientModule = require('../api/shared/protectedAssets/ncscAssessmentClient');
const picture = require('../api/shared/protectedAssets/organisationPicture');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail, projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createCommand, saveCommand, submitCommand, clone } = require('./fixtures/ncscAssessmentFixture');
const { createDom } = require('./fixtures/dashboardDom');

const PREFIX = '/api/dashboard/ncsc/assessments';
const V1 = () => createNcscQuestionnaireMetadata();
const V2 = () => createNcscQuestionnaireMetadataV2();
// The #399 worked example, in profile order: 7.85 / 31 = 25.3%, two "I don't know".
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
    'no', 'ad_hoc', 'partly', 'no', 'unknown'];
const pause = () => new Promise(resolve => setImmediate(resolve));
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8' } });

let flag;
beforeEach(() => { flag = process.env.NOFRIES_NCSC_PROFILE_V2; process.env.NOFRIES_NCSC_PROFILE_V2 = 'true'; });
afterEach(() => { if (flag === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = flag; });

async function backend() {
    const at = '2026-11-20T09:00:00.000Z', fixture = ncscFixture({ now: at }), clock = createClock(at);
    const context = await createContext(fixture.scope, clock);
    const versions = new Map();
    let createWith = ACCEPTED_NCSC_CONTEXT;
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
            clock.advance(60000);
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
    const execute = command => repository.executeNcscAssessment(context, command);
    async function submitted(id, profile, answers) {
        createWith = profile;
        await execute(createCommand(id, 'create-' + id));
        await execute(saveCommand(id, 0, 'save-' + id, profile.questionIds.map((itemId, index) => ({ itemId, optionId: answers[index],
            rationale: answers[index] === 'not_applicable' ? { text: 'Synthetic: not in scope.' } : null }))));
        return (await execute(submitCommand(id, 1, 'submit-' + id))).assessment;
    }
    return { fetch, organisationId: fixture.scope.organisationId, submitted };
}
const v1Answers = option => ACCEPTED_NCSC_CONTEXT.questionIds.map((_, index) => typeof option === 'function' ? option(index) : option);
function mountPicture(h, settings = {}) {
    const dom = createDom();
    const extra = settings.profileMetadata === undefined ? { profileMetadata: [V2()] } : settings.profileMetadata ? { profileMetadata: settings.profileMetadata } : {};
    const client = clientModule.createClient({ metadata: V1(), ...extra, fetch: h.fetch });
    const controller = picture.mount(dom.root, { metadata: V1(), ...extra, client, organisationId: h.organisationId,
        displayName: 'Synthetic organisation', ...settings.options });
    return { ...dom, controller, client };
}
async function until(predicate) {
    const end = Date.now() + 4000;
    while (!predicate() && Date.now() < end) await pause();
    expect(Boolean(predicate())).toBe(true);
}
function picker(dom) { return dom.root.querySelector('.picture-toolbar').querySelector('select'); }
function choose(dom, assessmentId) {
    const select = picker(dom); select.value = assessmentId;
    for (const callback of select.events.change || []) callback();
}
const loaded = dom => !!dom.root.querySelector('.picture-top-gaps');
function serialise(node) {
    if (!node || typeof node !== 'object' || !node.tagName) return null;
    return [node.tagName, node.className, node._text, node.hidden, Object.entries(node.attributes).sort(), Object.entries(node.dataset).sort(),
        node.value === undefined ? null : String(node.value), node.children.map(serialise)];
}

describe('Overview with v1 and v2 results in one organisation', () => {
    test('a tenant with a v2 result keeps its Overview and v1 history, each shown with its own profile', async () => {
        const h = await backend();
        await h.submitted('assessment-c', ACCEPTED_NCSC_CONTEXT, v1Answers(index => index < 7 ? 'yes' : 'partial'));
        await h.submitted('assessment-b', NCSC_V2_CONTEXT, EXAMPLE.map(value => value === 'unknown' ? 'partly' : value));
        await h.submitted('assessment-a', NCSC_V2_CONTEXT, EXAMPLE);
        const dom = mountPicture(h); await until(() => loaded(dom));
        expect(dom.root.textContent).not.toContain('could not be confirmed');
        expect(picker(dom).children.map(option => option.value)).toEqual(['assessment-a', 'assessment-b', 'assessment-c']);
        // Newest is the v2 worked example.
        const primary = dom.root.querySelector('.picture-primary');
        expect(primary.textContent).toContain('25.3%');
        const gaps = dom.root.querySelector('.picture-top-gaps');
        expect(gaps.querySelector('h3').textContent).toBe('Your top five gaps');
        expect(gaps.querySelector('.picture-top-gaps-list').children.map(item => item.dataset.gapItem)).toEqual(['NF-NCSC-MCSS-DR-01-Q2',
            'NF-NCSC-CC-SV-01-Q1', 'NF-NCSC-CC-PM-01-Q1', 'NF-NCSC-CC-SU-01-Q1', 'NF-NCSC-CC-EM-01-Q1']);
        expect(gaps.textContent).toContain('This is a No Fries planning list from your answers, not an official NCSC priority.');
        expect(gaps.textContent).not.toContain('Account sign-in checks, updates, backups and payment checks come first.');
        // v2 titles, never the v1 "Critical Control extension" names.
        expect(gaps.textContent).toContain('Check sensitive requests a second way');
        expect(gaps.textContent).toContain('Limit supplier access');
        expect(gaps.textContent).not.toContain('Sensitive-request verification check');
        const confirm = gaps.querySelector('.picture-confirm-next');
        expect(confirm.querySelector('h4').textContent).toBe('Confirm these next');
        expect(confirm.querySelector('ul').children.map(item => [item.dataset.gapItem, item.textContent]))
            .toEqual([['NF-NCSC-MCSS-DU-01-Q1', 'Detect Unusual Behaviour']]);
        // Every graded shortfall is a reported gap (9 part-credit + 5 No), the 2 unknowns are unresolved.
        const categories = dom.root.querySelector('.picture-follow-up').children.filter(node => node.tagName === 'DETAILS');
        expect(categories.map(node => node.children[0].textContent)).toEqual(['Unresolved answers · 2', 'Reported implementation gaps · 14']);
        const calculation = dom.root.querySelector('.picture-calculation').textContent;
        expect(calculation).toContain('This saved result: 7.85–10.85 reported or possible credits ÷ 31 included question weights × 100 = 25.3%–35.0%.');
        expect(calculation).toContain('Each question has a weight of 1, 2 or 3.');
        expect(calculation).not.toContain('equal weight');
        expect(calculation).toContain('This self-reported assessment helps you plan improvements.');
        expect(dom.root.querySelector('.ncsc-result-provenance').textContent).toContain('2026-11-18.1');
        // Change over time compares only the other v2 result and says why the v1 one is left out.
        const trend = dom.root.querySelector('.picture-trend');
        expect(trend.querySelector('.picture-trend-break').textContent).toBe('1 other submitted assessment used a different set of questions, so it is not compared with this one or listed here. Results from different sets of questions are not comparable.');
        expect(trend.textContent).toContain('There is 1 other submitted assessment.');
        trend.querySelectorAll('button')[0].click();
        await until(() => dom.root.querySelector('.picture-trend-table'));
        const table = dom.root.querySelector('.picture-trend-table');
        expect(table.querySelector('tbody').children[0].textContent).toMatch(/^Overall/);
        expect(dom.root.querySelector('.picture-trend').textContent).toContain('Both saved results use the same set of questions and question weights.');
        expect(dom.root.querySelector('.picture-trend-history').children).toHaveLength(2);
        expect(dom.root.querySelector('.picture-trend-history').textContent).not.toContain('Result unavailable');

        // The v1 result in the same tenant is shown with the accepted profile, as before.
        choose(dom, 'assessment-c'); await until(() => loaded(dom) && dom.root.querySelector('.ncsc-result-provenance').textContent.includes('2026-09-02.1'));
        const v1Gaps = dom.root.querySelector('.picture-top-gaps');
        expect(v1Gaps.querySelector('h3').textContent).toBe('Your top three gaps');
        expect(v1Gaps.querySelector('.picture-confirm-next')).toBeNull();
        expect(v1Gaps.textContent).toContain('Account sign-in checks, updates, backups and payment checks come first.');
        expect(dom.root.querySelector('.picture-calculation').textContent).toContain('No Fries gives each question equal weight');
        const v1Trend = dom.root.querySelector('.picture-trend');
        expect(v1Trend.querySelector('.picture-trend-break').textContent).toMatch(/^2 other submitted assessments used a different set of questions, so they are not compared/);
        expect(v1Trend.textContent).toContain('This is the only submitted assessment with this set of questions so far.');
        expect(v1Trend.querySelectorAll('button')).toHaveLength(0);
        dom.controller.destroy();
    });

    test('Copy and Print use the selected profile and the owner of a matching saved action', async () => {
        const h = await backend();
        await h.submitted('assessment-v1', ACCEPTED_NCSC_CONTEXT, v1Answers('no'));
        await h.submitted('assessment-v2', NCSC_V2_CONTEXT, EXAMPLE);
        const readBoardPlan = jest.fn(async source => {
            const question = source.assessmentId === 'assessment-v2' ? 'NF-NCSC-CC-SU-01-Q1' : 'NF-NCSC-MCSS-MF-01-Q1';
            const profile = source.assessmentId === 'assessment-v2' ? V2() : V1();
            expect(source.profileRef).toEqual(profile.profileRef);
            return [{ itemId: question, controlId: profile.questions.find(row => row.id === question).controlId,
                kind: 'implementation', owner: 'Owner of ' + source.assessmentId, dueDate: '2026-11-26' }];
        });
        const dom = mountPicture(h, { options: { readBoardPlan, openAction: jest.fn() } });
        const writeText = jest.fn(), print = jest.fn();
        Object.assign(dom.window, { print, navigator: { clipboard: { writeText } } });
        await until(() => loaded(dom));
        for (const [id, title] of [['assessment-v2', 'Limit supplier access'], ['assessment-v1', 'Multi-factor']]) {
            if (picker(dom).value !== id) choose(dom, id);
            await until(() => loaded(dom) && picker(dom).value === id);
            const handoff = dom.root.querySelector('.picture-summary');
            handoff.open = true;
            for (const toggle of handoff.events.toggle || []) toggle();
            const board = handoff.querySelector('.picture-board-summary');
            const input = board.querySelector('textarea');
            await until(() => input.value.includes('Owner of ' + id));
            expect(input.value.toLowerCase()).toContain(title.toLowerCase());
            expect(input.value).toContain('Due 26 Nov 2026');
            expect(input.value).not.toContain('Owner of ' + (id === 'assessment-v2' ? 'assessment-v1' : 'assessment-v2'));
            const press = label => board.querySelectorAll('button').find(control => control.textContent === label).click();
            press('Copy board summary');
            expect(writeText).toHaveBeenLastCalledWith(input.value);
            print.mockImplementationOnce(() => {
                const printed = board.querySelector('.picture-board-print');
                expect(printed.classList.contains('picture-print-only')).toBe(true);
                expect(printed.textContent).toBe(input.value);
            });
            press('Print board summary');
        }
        expect(print).toHaveBeenCalledTimes(2);
        dom.controller.destroy();
    });

    test('a v2 result with no gaps says so, and the actions card names only controls every profile agrees on', async () => {
        const h = await backend();
        await h.submitted('assessment-a', NCSC_V2_CONTEXT, NCSC_V2_CONTEXT.questionIds.map(id => id === 'NF-NCSC-MCSS-MF-01-Q2' ? 'mfa_key' : 'yes'));
        const list = { asOf: '2026-11-20T09:30:00.000Z', scope: { planId: 'plan-a' }, planRevision: 1, actions: [
            ['NF-NCSC-CC-SV-01-Q1', 'Agree a call-back check.'], ['NF-NCSC-CC-SU-01-Q1', 'List supplier access.'],
            ['NF-NCSC-MCSS-RM-01-Q1', 'Write down the top risks.']].map(([itemId, suggestedAction], index) => ({ actionId: 'action-' + index,
            itemId, status: 'not_started', isOverdue: false, dueDate: null, rationale: { suggestedAction } })) };
        const dom = mountPicture(h, { options: { openImprovement: () => true, readActions: () => Promise.resolve({ more: false, lists: [list] }) } });
        await until(() => loaded(dom) && dom.root.querySelector('.picture-actions'));
        expect(dom.root.querySelector('.picture-top-gaps').textContent).toContain('None of your answers show a gap to fix first.');
        const titles = picture.actionSummary({ more: false, lists: [list] }, V1(), [V2()]).next.map(item => item.title);
        // SV-01 is named differently in v1 and v2, so it is not named; SU-01 is v2 only; RM-01 is the same in both.
        expect(titles).toEqual(['Agree a call-back check.', 'Limit supplier access: list supplier access.', 'Risk Management: write down the top risks.']);
        // One profile (flag off): the v1 name, exactly as before.
        expect(picture.actionSummary({ more: false, lists: [list] }, V1()).next[0].title).toBe('Sensitive-request verification check: agree a call-back check.');
        dom.controller.destroy();
    });

    test('a v1-only tenant renders the same Overview whether or not v2 metadata is supplied', async () => {
        const h = await backend();
        await h.submitted('assessment-a', ACCEPTED_NCSC_CONTEXT, v1Answers(index => ['yes', 'partial', 'no', 'unknown'][index % 4]));
        await h.submitted('assessment-b', ACCEPTED_NCSC_CONTEXT, v1Answers('partial'));
        const render = async profileMetadata => {
            const dom = mountPicture(h, { profileMetadata }); await until(() => loaded(dom));
            dom.root.querySelector('.picture-trend').querySelectorAll('button')[0].click();
            await until(() => dom.root.querySelector('.picture-trend-table'));
            // Element ids carry a per-mount sequence number.
            const value = JSON.stringify(serialise(dom.root)).replace(/picture-assessment-\d+/g, 'picture-assessment-N');
            dom.controller.destroy(); return value;
        };
        expect(await render([V2()])).toBe(await render(null));
    });

    test('unknown profiles fail closed for the whole response, and composition is checked', async () => {
        const h = await backend();
        await h.submitted('assessment-a', ACCEPTED_NCSC_CONTEXT, v1Answers('yes'));
        const real = clientModule.createClient({ metadata: V1(), fetch: h.fetch });
        const other = { ...V1().profileRef, catalogueSha256: 'f'.repeat(64) };
        // A client that passes a row naming a profile the picture was not given.
        const client = { read: (id, settings) => real.read(id, settings),
            list: async input => { const page = clone(await real.list(input)); page.assessments[0].profileRef = other; return page; } };
        const dom = createDom();
        picture.mount(dom.root, { metadata: V1(), profileMetadata: [V2()], client, organisationId: h.organisationId });
        await until(() => dom.root.textContent.includes('could not be confirmed'));
        expect(dom.root.querySelector('.picture-top-gaps')).toBeNull();
        for (const profileMetadata of [{}, [V1()], [V2(), V2()], [{ ...V2(), moduleId: 'other' }], [null], [V2(), V2(), V2(), V2(), V2()]]) {
            expect(() => picture.mount(createDom().root, { metadata: V1(), profileMetadata, client, organisationId: h.organisationId }))
                .toThrow('picture_composition_required');
        }
    });

    test('a supplied profile that is not exactly the pinned v2 profile is refused (fail closed)', async () => {
        const h = await backend();
        await h.submitted('assessment-a', ACCEPTED_NCSC_CONTEXT, v1Answers('partial'));
        const client = clientModule.createClient({ metadata: V1(), fetch: h.fetch });
        const mount = profileMetadata => () => picture.mount(createDom().root, { metadata: V1(),
            ...(profileMetadata === undefined ? {} : { profileMetadata }), client, organisationId: h.organisationId }).destroy();
        const ref = V2().profileRef;
        const near = Object.keys(ref).map(key => ({ ...V2(), profileRef: { ...ref, [key]: key.endsWith('Sha256') ? 'e'.repeat(64) : ref[key] + 'x' } }));
        // A re-hashed catalogue, any other single field, an extra field or a missing field.
        near.push({ ...V2(), profileRef: { ...ref, extra: 'x' } });
        near.push({ ...V2(), profileRef: Object.fromEntries(Object.entries(ref).slice(1)) });
        near.push({ ...V2(), profileRef: [] });
        for (const profile of near) {
            expect(mount([profile])).toThrow('picture_composition_required');
            expect(mount([V2(), profile])).toThrow('picture_composition_required');
        }
        // A supplied copy of the accepted (v1) profile is still refused as a duplicate.
        expect(mount([V1()])).toThrow('picture_composition_required');
        // The accepted profile alone, and with the exact pinned v2 profile, still mount and render.
        expect(mount(undefined)).not.toThrow();
        expect(mount([V2()])).not.toThrow();
        for (const settings of [{ profileMetadata: null }, {}]) {
            const dom = mountPicture(h, settings); await until(() => loaded(dom));
            expect(dom.root.querySelector('.picture-top-gaps').querySelector('h3').textContent).toBe('Your top three gaps');
            dom.controller.destroy();
        }
    });

    test('the pinned v2 reference matches the served v2 profile on every field', () => {
        const result = { domains: [{ controls: [{ questions: NCSC_V2_CONTEXT.profile.questions.map((question, index) =>
            ({ itemId: question.id, responseOptionId: EXAMPLE[index], weight: question.weight, answer: EXAMPLE[index] })) }] }] };
        expect(V2().profileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
        expect(picture.topGaps(result, V2())).toHaveLength(5);
        expect(picture.confirmNext(result, V2()).map(gap => gap.itemId)).toEqual(['NF-NCSC-MCSS-DU-01-Q1']);
    });
});
