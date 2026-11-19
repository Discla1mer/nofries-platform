'use strict';

// Scoring v2 (#399), flag off: renders Overview and the bounded client's models for several accepted-profile (v1) datasets, using
// the browser modules under `root`. The parity test compares this repository's
// output with digests recorded from main before the v2 Overview change (40f3432).
// The same function, pointed at a checkout of main, produced those digests.
const path = require('path');
const crypto = require('crypto');
const { createDom } = require('./dashboardDom');

const PREFIX = '/api/dashboard/ncsc/assessments';
const pause = () => new Promise(resolve => setImmediate(resolve));
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8' } });

function serialise(node) {
    if (!node || typeof node !== 'object' || !node.tagName) return null;
    return [node.tagName, node.className, node._text, node.hidden, Object.entries(node.attributes).sort(), Object.entries(node.dataset).sort(),
        node.value === undefined ? null : String(node.value), node.disabled === undefined ? null : !!node.disabled, node.children.map(serialise)];
}
// Element ids carry a per-mount sequence; Intl may use different spaces by ICU version.
const normal = value => JSON.stringify(value).replace(/picture-assessment-\d+/g, 'picture-assessment-N').replace(/[\s  ]+/g, ' ');
const digest = value => crypto.createHash('sha256').update(normal(value)).digest('hex');

async function until(predicate, label) {
    const end = Date.now() + 4000;
    while (!predicate() && Date.now() < end) await pause();
    if (!predicate()) throw new Error('parity_timeout: ' + label);
}

async function renderV1Parity(root) {
    const load = file => require(path.join(root, file));
    const saved = process.env.NOFRIES_NCSC_PROFILE_V2;
    delete process.env.NOFRIES_NCSC_PROFILE_V2;
    try {
        const { createNcscQuestionnaireMetadata } = load('api/shared/ncscQuestionnaireMetadata');
        const clientModule = load('api/shared/protectedAssets/ncscAssessmentClient');
        const picture = load('api/shared/protectedAssets/organisationPicture');
        const { ACCEPTED_NCSC_CONTEXT } = load('api/shared/assessmentEngine/ncscProfileSet');
        const { createNcscAssessmentHandlers } = load('api/shared/ncscAssessmentHandlers');
        const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail, projectNcscSummary } = load('api/shared/ncscAssessmentService');
        const { makeVersion, stableIntent } = load('api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
        // The request context is branded by its own module instance, so the fixture comes from `root` too.
        const { ncscFixture, createClock, createContext, createCommand, saveCommand, submitCommand, clone } = load('test/fixtures/ncscAssessmentFixture');
        const metadata = createNcscQuestionnaireMetadata(), ids = ACCEPTED_NCSC_CONTEXT.questionIds;

        async function backend() {
            const at = '2026-11-20T09:00:00.000Z', fixture = ncscFixture({ now: at }), clock = createClock(at);
            const context = await createContext(fixture.scope, clock);
            const versions = new Map();
            const repository = {
                async listNcscAssessments(_context, page) {
                    const keys = [...versions.keys()].sort().filter(id => !page.afterAssessmentId || id > page.afterAssessmentId);
                    const selected = keys.slice(0, page.limit);
                    return { schemaVersion: 1, assessments: selected.map(id => projectNcscSummary(versions.get(id))),
                        nextAfterAssessmentId: keys.length > selected.length ? selected.at(-1) : null };
                },
                async readNcscAssessment(_context, selector) {
                    return { schemaVersion: 1, assessment: projectNcscDetail(versions.get(selector.assessmentId)) };
                },
                async executeNcscAssessment(current, input) {
                    clock.advance(60000);
                    const command = normaliseNcscCommand(input), intent = stableIntent(current, command);
                    const value = makeVersion(intent, command.idempotencyKey, versions.get(command.assessmentId) || null,
                        fixture.state.tenantAggregate, clock.now());
                    versions.set(command.assessmentId, value);
                    return clone({ schemaVersion: 1, action: command.action, assessment: projectNcscDetail(value) });
                }
            };
            const service = createNcscAssessmentService({ repository, requestContext: { resolve: async () => context } });
            const handlers = createNcscAssessmentHandlers({ service, guardMutation: async () => true });
            const calls = [];
            const fetch = async (url, init) => {
                calls.push((init.method || 'GET') + ' ' + url);
                const parsed = new URL(url, 'https://synthetic.invalid');
                const request = { method: init.method || 'GET', query: Object.fromEntries(parsed.searchParams),
                    ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) };
                const response = await handlers.handleRequest(request, decodeURIComponent(parsed.pathname.slice(PREFIX.length).replace(/^\//, '')));
                return reply(response.body, response.status);
            };
            const execute = command => repository.executeNcscAssessment(context, command);
            const answers = option => ids.map((itemId, index) => {
                const optionId = typeof option === 'function' ? option(index) : option;
                return { itemId, optionId, rationale: optionId === 'not_applicable' ? { text: 'Synthetic: not in scope.' } : null };
            });
            return { fetch, calls, organisationId: fixture.scope.organisationId,
                async submitted(id, option, scope) {
                    await execute(createCommand(id, 'create-' + id, scope));
                    await execute(saveCommand(id, 0, 'save-' + id, answers(option)));
                    await execute(submitCommand(id, 1, 'submit-' + id));
                },
                async draft(id, option) {
                    await execute(createCommand(id, 'create-' + id));
                    if (option) await execute(saveCommand(id, 0, 'save-' + id, answers(option).slice(0, 5)));
                } };
        }
        const cycle = ['yes', 'partial', 'no', 'unknown', 'not_applicable'];
        const actionList = { asOf: '2026-11-20T09:30:00.000Z', scope: { planId: 'plan-a' }, planRevision: 3, actions: [
            ['NF-NCSC-CC-PM-01-Q1', 'Roll out the password manager.', 'in_progress', '2026-11-25'],
            ['NF-NCSC-CC-SV-01-Q1', 'Agree a call-back check.', 'not_started', '2026-11-10'],
            ['NF-NCSC-CC-AC-01-Q1', 'Block unapproved apps.', 'not_started', null],
            ['NF-NCSC-MCSS-RM-01-Q1', 'Write down the top risks.', 'completed', '2026-11-01']
        ].map(([itemId, suggestedAction, status, dueDate], index) => ({ actionId: 'action-' + index, itemId, status,
            isOverdue: status !== 'completed' && dueDate !== null && dueDate < '2026-11-20', dueDate, rationale: { suggestedAction },
            ...(status === 'completed' ? { completion: { nextReviewDate: '2026-11-28' } } : {}) })) };
        const datasets = [
            ['mixed single result', async h => { await h.submitted('assessment-a', index => cycle[index % 5]); }],
            ['three results and a draft, compared', async h => {
                await h.submitted('assessment-c', 'yes', 'Office only.');
                await h.submitted('assessment-b', index => index < 9 ? 'no' : 'partial');
                await h.draft('assessment-d', 'partial');
                await h.submitted('assessment-a', index => cycle[(index + 2) % 5]);
            }, { compare: true, choose: 'assessment-c' }],
            ['draft only', async h => { await h.draft('assessment-a', 'yes'); }],
            ['empty organisation', async () => {}],
            ['mostly unknown, with actions and plan links', async h => { await h.submitted('assessment-a', index => index < 2 ? 'no' : 'unknown'); },
                { actions: true }],
            ['two gaps only', async h => { await h.submitted('assessment-a', index => index === 4 ? 'partial' : index === 11 ? 'no' : 'yes'); }]
        ];
        const output = {};
        for (const [name, seed, settings = {}] of datasets) {
            const h = await backend(); await seed(h);
            const client = clientModule.createClient({ metadata: clone(metadata), fetch: h.fetch });
            const models = { list: await client.list() };
            if (models.list.assessments.length) models.read = await client.read(models.list.assessments[0].assessmentId);
            if (models.list.assessments.some(row => row.status !== 'submitted')) {
                const draft = models.list.assessments.find(row => row.status !== 'submitted');
                const command = saveCommand(draft.assessmentId, draft.revision, 'save-parity', [{ itemId: ids[0], optionId: 'no', rationale: null }]);
                models.normalised = client.normaliseCommand(command);
                models.bytes = client.commandByteLength(command);
            }
            const dom = createDom(), events = [];
            const options = { metadata: clone(metadata), client, organisationId: h.organisationId, displayName: 'Synthetic organisation',
                openCyber: (...args) => events.push(['openCyber', ...args]),
                ...(settings.actions ? { openImprovement: () => true, planGap: () => true,
                    readActions: () => Promise.resolve({ more: false, lists: [clone(actionList)] }) } : {}) };
            const controller = picture.mount(dom.root, options);
            const settled = () => !dom.root.textContent.includes('Loading saved assessment');
            await until(() => settled() && (dom.root.querySelector('.picture-source') || dom.root.querySelector('.picture-first-use')), name);
            for (let i = 0; i < 5; i++) await pause();
            const views = [serialise(dom.root)];
            if (settings.compare) {
                const button = dom.root.querySelector('.picture-trend').querySelectorAll('button')[0];
                button.click(); await until(() => dom.root.querySelector('.picture-trend-table'), name + ' compare');
                views.push(serialise(dom.root));
                const select = dom.root.querySelector('.picture-toolbar').querySelector('select'); select.value = settings.choose;
                for (const callback of select.events.change || []) callback();
                await until(() => settled() && dom.root.querySelector('.picture-source'), name + ' choose');
                for (let i = 0; i < 5; i++) await pause();
                views.push(serialise(dom.root));
                const again = dom.root.querySelector('.picture-trend').querySelectorAll('button')[0];
                if (again) { again.click(); for (let i = 0; i < 20; i++) await pause(); views.push(serialise(dom.root)); }
            }
            controller.destroy();
            output[name] = { dom: digest(views), models: digest(models), requests: digest(h.calls),
                actions: digest(picture.actionSummary(clone({ more: false, lists: [actionList] }), metadata)) };
        }
        return output;
    } finally {
        if (saved === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = saved;
    }
}

module.exports = { renderV1Parity, serialise, digest };
