'use strict';

// Synthetic composition of the delivered loader, shell, client and questionnaire.
// Reuses existing fixture contracts. DOM/native events and repository durability
// are doubles; no provider session, browser layout or production data is involved.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createDom } = require('./dashboardDom');
const { fixture } = require('./dashboardFixture');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');
const shell = require('../../api/shared/protectedAssets/dashboardShell');
const clientModule = require('../../api/shared/protectedAssets/ncscAssessmentClient');
const questionnaire = require('../../api/shared/protectedAssets/ncscQuestionnaire');
const { createNcscQuestionnaireMetadata } = require('../../api/shared/ncscQuestionnaireMetadata');
const { createNcscAssessmentHandlers } = require('../../api/shared/ncscAssessmentHandlers');
const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail, projectNcscSummary,
    NcscAssessmentError } = require('../../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createCommand, saveCommand, allResponses, clone } = require('./ncscAssessmentFixture');

const NOW = '2026-09-08T23:30:00.000Z';
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const GA = 'a'.repeat(64);
const PREFIX = '/api/dashboard/ncsc/assessments';
const ASSESSMENT = 'synthetic-cross-feature-assessment';
const IDS = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus',
    'dashboardRetry', 'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices', 'dashboardMore',
    'dashboardApp', 'dashboardApplicationIntegrity', 'dashboardStyleIntegrity', 'dashboardSkipLink'];
const SOURCE = fs.readFileSync(path.join(__dirname, '../../js/dashboard-loader.js'), 'utf8');
const ENTRY = fs.readFileSync(path.join(__dirname, '../../app/dashboard.html'), 'utf8').match(/<(main|div)\s+class="shell"/)[1];
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function response(status, value) {
    return { status, ok: status >= 200 && status < 300, redirected: false, type: 'basic',
        headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        json: async () => clone(value), text: async () => JSON.stringify(value) };
}

async function createBackend() {
    const example = ncscFixture({ now: NOW, tenantId: 'synthetic-tenant', organisationId: 'synthetic-workshop' });
    const clock = createClock(NOW), context = await createContext(example.scope, clock);
    const versions = new Map(), receipts = new Map(), mutations = [];
    const repository = {
        async listNcscAssessments(_context, page) {
            const ids = [...versions.keys()].sort().filter(id => !page.afterAssessmentId || id > page.afterAssessmentId);
            const selected = ids.slice(0, page.limit);
            return { schemaVersion: 1, assessments: selected.map(id => projectNcscSummary(versions.get(id))),
                nextAfterAssessmentId: ids.length > selected.length ? selected.at(-1) : null };
        },
        async readNcscAssessment(_context, selector) {
            const version = versions.get(selector.assessmentId);
            if (!version) throw new NcscAssessmentError('ncsc_not_found', 404);
            return { schemaVersion: 1, assessment: projectNcscDetail(version) };
        },
        async executeNcscAssessment(current, input) {
            const command = normaliseNcscCommand(input), intent = stableIntent(current, command);
            const digest = JSON.stringify(intent), receipt = receipts.get(command.idempotencyKey);
            if (receipt) {
                if (receipt.digest !== digest) throw new NcscAssessmentError('ncsc_idempotency_conflict', 409);
                return clone(receipt.value);
            }
            const version = makeVersion(intent, command.idempotencyKey, versions.get(command.assessmentId) || null,
                example.state.tenantAggregate, clock.now());
            versions.set(command.assessmentId, version);
            const value = { schemaVersion: 1, action: command.action, assessment: projectNcscDetail(version) };
            receipts.set(command.idempotencyKey, { digest, value }); mutations.push(clone(command));
            return clone(value);
        }
    };
    const handlers = createNcscAssessmentHandlers({ service: createNcscAssessmentService({ repository,
        requestContext: { resolve: async () => context } }), guardMutation: async () => true });
    await repository.executeNcscAssessment(context, createCommand(ASSESSMENT));
    const rows = allResponses(); rows[0].optionId = 'partial'; rows[1].optionId = 'unknown';
    await repository.executeNcscAssessment(context, saveCommand(ASSESSMENT, 0, 'seed-saved-draft', rows.slice(0, 2)));
    mutations.length = 0;
    return { versions, mutations, initial: versions.get(ASSESSMENT), async handle(row) {
        const url = new URL(row.url, 'https://synthetic.invalid');
        return handlers.handleRequest({ method: row.init.method || 'GET', query: Object.fromEntries(url.searchParams),
            ...(row.init.body === undefined ? {} : { body: JSON.parse(row.init.body) }) },
        decodeURIComponent(url.pathname.slice(PREFIX.length).replace(/^\//, '')));
    } };
}

async function harness(accountType) {
    const backend = await createBackend(), { document, window } = createDom();
    const createElement = document.createElement;
    document.createElement = tag => {
        const node = createElement(tag);
        Object.defineProperty(node, 'id', { get: () => node.getAttribute('id') || '', set: value => node.setAttribute('id', value) });
        node.contains = child => node === child || node.children.some(item => item.contains(child));
        node.showModal = function () { this.open = true; };
        node.close = function () { this.open = false; };
        node.removeChild = child => { node.children = node.children.filter(item => item !== child); child.parentElement = null; };
        return node;
    };
    const elements = Object.fromEntries(IDS.map(id => [id, document.createElement(id === 'dashboardEntry' ? ENTRY : 'div')]));
    Object.entries(elements).forEach(([id, node]) => { node.id = id; });
    document.body = document.createElement('body'); document.body.dataset.page = 'operator-dashboard';
    document.body.dataset.customerProvider = 'external'; document.body.append(elements.dashboardEntry);
    elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
    document.getElementById = id => elements[id] || document.body.querySelectorAll('[id]').find(node => node.id === id) || null;
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.querySelector = selector => document.body.querySelector(selector);
    document.head = document.createElement('head'); const native = [], requests = [], mounts = [];
    document.head.append = node => { node.parentNode = document.head; document.head.children.push(node); native.push(node); };
    document.head.removeChild = node => { document.head.children = document.head.children.filter(item => item !== node); node.parentNode = null; };
    const sri = 'sha256-' + crypto.createHash('sha256').update('synthetic approved bytes').digest('base64');
    elements.dashboardApplicationIntegrity.setAttribute('content', sri); elements.dashboardStyleIntegrity.setAttribute('content', sri);
    window.location.hash = '#cyber-security'; window.location.assign = jest.fn();
    window.crypto = { randomUUID: crypto.randomUUID }; window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
    const fetch = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
    window.NoFriesDashboard = { validate: shell.validate, mount(root, model, config) {
        const controller = shell.mount(root, model, config); mounts.push({ controller, destroy: jest.spyOn(controller, 'destroy') }); return controller;
    } };
    // The CommonJS client rejects foreign-realm adapter objects. Reconstruct
    // its explicit port in its own realm, as the existing loader harness does.
    window.NoFriesNcscAssessmentClient = { createClient: input => clientModule.createClient({
        metadata: clone(input.metadata), fetch: input.fetch }) };
    window.NoFriesNcscQuestionnaire = questionnaire;
    const session = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType,
        expiresAt: '2026-09-09T00:30:00.000Z', generation: GA, selectedBindingId: A };
    const directory = { schemaVersion: 1, bindings: [A, B].map(bindingId => ({ bindingId,
        organisationLabel: 'Synthetic organisation ' + bindingId.slice(-1) })), nextAfterBindingId: null };
    const model = clone(projectDashboard(fixture({ now: NOW, name: 'Synthetic current organisation' })));
    model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    const cyber = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
        module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
        services: [], admissionGranted: false, providerAccessGranted: false,
        metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' };
    vm.runInContext(SOURCE, vm.createContext({ document, window, fetch, AbortController, Date, console }), { filename: 'dashboard-loader.js' });
    async function reply(index, status, value) {
        expect(requests[index]).toBeDefined(); requests[index].resolve(response(status, value)); await flush();
    }
    async function serve(index) {
        expect(requests[index].url.startsWith(PREFIX)).toBe(true);
        const result = await backend.handle(requests[index]); await reply(index, result.status, result.body);
    }
    async function open(first = 0) {
        await reply(first, 200, session); await reply(first + 1, 200, directory); await reply(first + 2, 200, model);
        native.slice(-2).forEach(node => node.onload()); await flush();
        await reply(first + 3, 200, cyber); await reply(first + 4, 200, session); await serve(first + 5);
    }
    async function refresh(first) {
        await reply(first, 200, session);
        expect(requests.slice(first + 1, first + 4).map(row => row.url)).toEqual([
            '/api/dashboard/organisations?limit=50', '/api/dashboard/bootstrap', '/api/dashboard/modules/cyber_security']);
        await reply(first + 3, 200, cyber); await reply(first + 2, 200, model); await reply(first + 1, 200, directory);
        expect(requests[first + 4].url).toBe('/api/dashboard/session'); await reply(first + 4, 200, session);
    }
    const button = label => elements.dashboardApp.querySelectorAll('button').find(node => node.textContent === label);
    const byId = id => document.getElementById(id);
    function event(node, type) {
        expect(node).toBeDefined();
        for (const handler of node.events[type] || []) handler({ currentTarget: node, target: node, preventDefault() {} });
    }
    async function resume() {
        const saved = elements.dashboardApp.querySelector('.ncsc-assessment-list')?.querySelectorAll('button') || [];
        expect(saved).toHaveLength(1); const index = requests.length; saved[0].click(); await flush(); await serve(index);
    }
    function choose(index, option) {
        const picker = byId('ncsc-question-index'); picker.value = String(index); event(picker, 'change');
        const input = byId('ncsc-answer-' + cyber.metadata.questions[index].id + '-' + option);
        input.checked = true; event(input, 'change'); return input;
    }
    return { document, window, elements, requests, backend, mounts, session, directory, model, cyber,
        open, refresh, reply, serve, resume, choose, button, byId, event,
        get status() { return document.body.dataset.dashboardState; },
        close() { window.dispatch('pagehide'); } };
}

module.exports = { harness, flush, NOW, GA, ASSESSMENT };
