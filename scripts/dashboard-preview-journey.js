'use strict';

// Dev-only composition. Node evaluates one fixed example at build time; the
// browser gets data and the existing in-memory transport, never a scoring shim.
const { buildFixtures, createSyntheticTransport } = require('./build-ncsc-questionnaire-preview');
function buildJourney() {
    const fixtures = buildFixtures(), model = fixtures.tenants[0].model;
    const { ncscFixture, createCommand, saveCommand, submitCommand, allResponses, SUBJECT } = require('../test/fixtures/ncscAssessmentFixture');
    const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
    const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
    const { createImprovementPlan } = require('../api/shared/improvementPlan/improvementPlanDomain');
    const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
    const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
    const tenant = ncscFixture({ organisationId: model.context.organisationId });
    const answers = allResponses().map((row, index) => ({ ...row,
        optionId: ['yes', 'partial', 'no', 'unknown'][index % 4] }));
    let record = null;
    for (const command of [createCommand('seeded-example'), saveCommand('seeded-example', 0, 'seed-save', answers), submitCommand('seeded-example')]) {
        record = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, record, tenant.state.tenantAggregate, fixtures.now);
    }
    const scope = { ...tenant.scope, planId: 'seeded-example-plan' };
    const plan = createImprovementPlan({ ...scope, actorSubjectKey: SUBJECT, createdAt: fixtures.now },
        record.envelope.submission.input, { registry: acceptedRegistry });
    model.context.displayName = 'Synthetic Cyber practice';
    model.modules = model.modules.filter(row => ['overview', 'cyber_security', 'improvement_plan'].includes(row.key));
    model.modules.forEach(row => { row.state = 'ready'; });
    model.services = [];
    return { model, metadata: fixtures.metadata, now: fixtures.now, digests: fixtures.digests,
        example: projectNcscDetail(record), plan: projectImprovementActionPlanPresentation(projectImprovementActionList(plan,
            { scope, asOf: fixtures.now, filters: { status: 'all', owner: 'all', overdueOnly: false } })) };
}

// Serialized into the standalone document. All state belongs to this mount;
// scenario replacement/reset destroys it. No storage or native fetch fallback.
function previewApplication(models, journey, makeTransport) {
    const root = document.getElementById('dashboard'), selector = document.getElementById('scenario');
    const status = document.getElementById('preview-status');
    const practiceName = 'Cyber practice — tab memory only';
    let controller;
    [practiceName, ...Object.keys(models)].forEach(name => {
        const option = document.createElement('option'); option.textContent = name; option.value = name; selector.append(option);
    });
    function node(parent, tag, text, className) {
        const element = document.createElement(tag); if (text) element.textContent = text;
        if (className) element.className = className; parent.append(element); return element;
    }
    function button(parent, label, action) {
        const control = node(parent, 'button', label, 'dashboard-button' +
            (/^(Return|Review seeded)/.test(label) ? ' dashboard-button-secondary' : '')); control.type = 'button';
        control.addEventListener('click', action); return control;
    }
    function readonly(child) {
        return { destroy: () => child?.destroy(), requestLeave: commit => {
            if (commit) commit(); return Promise.resolve(true);
        } };
    }
    function practice() {
        const transport = makeTransport({ assessments: [] }, journey.metadata, journey);
        const records = new Map(); let selected = null, ids = 0, exampleMode = false;
        const client = NoFriesNcscAssessmentClient.createClient({ metadata: journey.metadata, async fetch(url, options) {
            const response = await transport.fetch(url, options), value = JSON.parse(await response.text());
            if (response.ok && value.assessment) {
                selected = value.assessment.assessmentId; records.set(selected, value.assessment);
            }
            return response;
        } });
        const exampleTransport = makeTransport({ assessments: [journey.example] }, journey.metadata, journey);
        const exampleClient = NoFriesNcscAssessmentClient.createClient({ metadata: journey.metadata, fetch: exampleTransport.fetch });
        function notice(parent, text) { node(parent, 'p', text, 'dashboard-status-panel'); }
        function reviewExample() { exampleMode = true; return controller.navigate('overview').then(moved => {
            if (!moved) exampleMode = false; return moved;
        }); }
        function reviewPractice() { exampleMode = false; return controller.navigate('overview'); }
        function answerSummary(parent, guidance) {
            const record = records.get(selected);
            notice(parent, 'Practice answers only · tab memory. No score, risk ranking, verified evidence or authoritative improvement plan is calculated.');
            if (!record) { node(parent, 'p', 'Create or reopen a practice assessment in Cyber Security first.'); return; }
            node(parent, 'p', 'Selected practice assessment: ' + record.assessmentId + ' · revision ' + record.revision + ' · ' + record.status);
            node(parent, 'p', record.scopePopulation.description, 'ncsc-preserve-text');
            const counts = ['yes', 'partial', 'no', 'unknown', 'not_applicable'].map(option =>
                journey.metadata.responseOptions.find(row => row.id === option).label + ': ' + record.responses.filter(row => row.optionId === option).length);
            node(parent, 'p', counts.join(' · ') + ' · Unanswered: ' + record.progress.missing);
            if (guidance) {
                node(parent, 'h2', 'Practice follow-up · preview guidance');
                node(parent, 'p', 'Questions in profile order. These suggestions are not saved actions, assignments, completion or evidence outcomes.');
                const list = node(parent, 'ol');
                journey.metadata.questions.forEach(question => {
                    const response = record.responses.find(row => row.itemId === question.id);
                    if (response?.optionId === 'yes') return;
                    const item = node(list, 'li'); node(item, 'h3', question.prompt);
                    node(item, 'p', response ? journey.metadata.responseOptions.find(row => row.id === response.optionId).label : 'Unanswered');
                    node(item, 'p', response?.optionId === 'no' || response?.optionId === 'partial'
                        ? question.guidance.startingActions[0] : 'Clarify the answer and scope before agreeing an action.');
                });
                if (!list.children.length) node(parent, 'p', 'All practice answers are Yes. This does not verify implementation or supporting evidence.');
            }
        }
        return { window, mountCyber(parent, host) {
            exampleMode = false;
            notice(parent, 'Cyber practice · Create, Save, Submit and Reopen are simulations in this tab only. Submit seals practice answers without calculating a score. Reload, Reset or changing scenario clears this work.');
            button(parent, 'Review practice answers', reviewPractice);
            button(parent, 'Review seeded example results', reviewExample);
            const child = node(parent, 'div');
            return NoFriesNcscQuestionnaire.mount(child, { metadata: journey.metadata, client, window,
                presentationMode: 'editable', generation: host.generation, organisationId: journey.model.context.organisationId,
                initialAssessmentId: host.initialAssessmentId,
                createId: () => '00000000-0000-4000-8000-' + (++ids).toString(16).padStart(12, '0') });
        }, mountPicture(parent, host) {
            let child;
            function render() {
                child?.destroy(); child = null; parent.replaceChildren();
                if (exampleMode) {
                    notice(parent, 'SEEDED EXAMPLE · These results and the linked plan use fixed synthetic answers evaluated at build time. They are unrelated to your practice answers.');
                    button(parent, 'Return to practice answers', () => { exampleMode = false; render(); });
                    child = NoFriesOrganisationPicture.mount(node(parent, 'div'), { metadata: journey.metadata, client: exampleClient,
                        organisationId: journey.model.context.organisationId, displayName: 'Fixed synthetic example',
                        initialAssessmentId: journey.example.assessmentId, openImprovement: host.openImprovement });
                    return;
                }
                node(parent, 'h2', 'Practice the Cyber journey'); answerSummary(parent, false);
                button(parent, 'Start or reopen practice assessment', () => controller.navigate('cyber-security'));
                button(parent, 'Review practice follow-up', () => controller.navigate('improvement-plan'));
                button(parent, 'Review seeded example results', () => { exampleMode = true; render(); });
            }
            render(); return { destroy: () => child?.destroy(), requestLeave: commit =>
                child ? child.requestLeave(commit) : readonly().requestLeave(commit) };
        }, mountImprovement(parent) {
            if (exampleMode) {
                notice(parent, 'SEEDED EXAMPLE PLAN · Read-only actions from the fixed example, unrelated to your practice answers. No assignments or changes are submitted.');
                button(parent, 'Return to practice answers', reviewPractice);
                return readonly(NoFriesImprovementActionPlanView.mount(node(parent, 'div'), journey.plan));
            }
            answerSummary(parent, true); button(parent, 'Return to practice answers', reviewPractice);
            return readonly();
        } };
    }
    function select() {
        if (controller) controller.destroy();
        const isPractice = selector.value === practiceName, model = isPractice ? journey.model : models[selector.value];
        const first = NoFriesDashboardRegistry.modules.find(item => model.modules.some(row => row.key === item.key));
        window.history.replaceState(null, '', '#' + first.route); status.textContent = '';
        controller = NoFriesDashboard.mount(root, model, { initialRoute: first.route, ...(isPractice ? practice() : {}) });
    }
    document.getElementById('reset').addEventListener('click', () => {
        selector.selectedIndex = 0; select(); status.textContent = 'Preview reset. All practice work has been cleared.';
    });
    selector.addEventListener('change', select);
    root.addEventListener('click', () => { status.textContent = ''; });
    window.addEventListener('hashchange', () => { status.textContent = ''; });
    // Real clients also render source/download links. Keep attribution visible,
    // but this offline artifact must not navigate to those destinations.
    const offlineLinks = () => root.querySelectorAll('a[href]').forEach(link => {
        if (link.getAttribute('href').startsWith('#')) return;
        link.title = 'Reference only in this offline preview: ' + link.getAttribute('href');
        link.removeAttribute('href'); link.removeAttribute('target'); link.removeAttribute('download'); link.setAttribute('aria-disabled', 'true');
    });
    new MutationObserver(offlineLinks).observe(root, { childList: true, subtree: true });
    select(); offlineLinks();
}
module.exports = { buildJourney, previewApplication, createSyntheticTransport };
