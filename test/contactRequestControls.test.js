'use strict';

// #409 stage 1c: "Ask No Fries to contact me" on results and Services cards.
// Real shell, organisation picture and delivered loader; synthetic DOM and transport.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const picture = require('../api/shared/protectedAssets/organisationPicture');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { buildFixtures, createSyntheticTransport } = require('../scripts/build-ncsc-questionnaire-preview');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { fixture } = require('./fixtures/dashboardFixture');
const { createDom } = require('./fixtures/dashboardDom');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW: NCSC_NOW } = require('./fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');

const CONSENT = 'No Fries staff will see your organisation name, your sign-in email and a summary of your results, and will contact you by email.';
const ASK = 'Ask No Fries to contact me';
const SENT = 'Request sent. We’ll be in touch by email.';
const ALREADY = 'You’ve already asked about this today. We’ll be in touch.';
const FAILED = 'Your request could not be sent. Please try again later.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const buttonsIn = node => node.querySelectorAll('button');
const byText = (node, text) => buttonsIn(node).find(item => item.textContent === text);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('contact control', () => {
    function control(send = jest.fn(async () => 'requested'), subject) {
        const dom = createDom(), node = shell.contactControl(dom.document, 'results', send, subject);
        dom.root.append(node);
        const status = node.querySelector('[role="status"]');
        return { dom, node, send, status, ask: byText(node, ASK), confirm: node.querySelector('.dashboard-contact-confirm') };
    }
    test('asks for consent with the exact wording before anything is sent', async () => {
        const c = control();
        expect(c.ask.type).toBe('button'); expect(c.confirm.hidden).toBe(true);
        expect(c.ask.getAttribute('aria-expanded')).toBe('false');
        expect(c.ask.getAttribute('aria-controls')).toBe(c.confirm.id);
        expect(c.status.getAttribute('aria-live')).toBe('polite');
        c.ask.click();
        expect(c.send).not.toHaveBeenCalled();
        expect(c.confirm.hidden).toBe(false); expect(c.ask.hidden).toBe(true);
        expect(c.ask.getAttribute('aria-expanded')).toBe('true');
        const consent = c.confirm.querySelector('p');
        expect(consent.textContent).toBe(CONSENT);
        const send = byText(c.confirm, 'Send request');
        expect(send.getAttribute('aria-describedby')).toBe(consent.id);
        expect(c.dom.document.activeElement).toBe(send);
    });
    test('Cancel sends nothing and returns focus to the button', async () => {
        const c = control();
        c.ask.click(); byText(c.confirm, 'Cancel').click(); await settle();
        expect(c.send).not.toHaveBeenCalled();
        expect(c.confirm.hidden).toBe(true); expect(c.ask.hidden).toBe(false);
        expect(c.dom.document.activeElement).toBe(c.ask);
    });
    test.each([
        ['requested', SENT, false],
        ['already_requested', ALREADY, false],
        ['failed', FAILED, true],
        ['unexpected', FAILED, true]
    ])('outcome %s shows its message', async (outcome, message, offeredAgain) => {
        const c = control(jest.fn(async () => outcome));
        c.ask.click(); byText(c.confirm, 'Send request').click();
        expect(c.status.textContent).toBe('Sending your request…');
        await settle();
        expect(c.send).toHaveBeenCalledTimes(1); expect(c.send).toHaveBeenCalledWith('results');
        expect(c.status.textContent).toBe(message); expect(c.confirm.hidden).toBe(true);
        expect(c.ask.hidden).toBe(!offeredAgain);
        expect(c.dom.document.activeElement).toBe(offeredAgain ? c.ask : c.status);
    });
    test('a rejected send is a neutral failure', async () => {
        const c = control(jest.fn(async () => { throw new Error('synthetic'); }));
        c.ask.click(); byText(c.confirm, 'Send request').click(); await settle();
        expect(c.status.textContent).toBe(FAILED); expect(c.ask.hidden).toBe(false);
    });
    test('a second click while sending does not send twice', async () => {
        const pending = deferred(), c = control(jest.fn(() => pending.promise));
        c.ask.click(); const send = byText(c.confirm, 'Send request');
        send.click(); send.click(); byText(c.confirm, 'Cancel').click(); await settle();
        expect(c.send).toHaveBeenCalledTimes(1);
        expect(send.disabled).toBe(true); expect(c.confirm.hidden).toBe(false);
        pending.resolve('requested'); await settle();
        expect(c.status.textContent).toBe(SENT);
    });
    test('a subject names the service for assistive technology only', () => {
        const c = control(undefined, 'Tier 1 support');
        expect(c.ask.textContent).toBe(ASK);
        expect(c.ask.getAttribute('aria-label')).toBe('Ask No Fries to contact me about Tier 1 support');
    });
    test('the shell source stays free of transport and browser storage', () => {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardShell.js'), 'utf8');
        expect(source).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|\.innerHTML/);
    });
});

describe('Services tab', () => {
    const model = options => JSON.parse(JSON.stringify(projectDashboard(fixture(options))));
    function services(options, mountOptions) {
        const dom = createDom();
        const controller = shell.mount(dom.root, model(options), { initialRoute: '#services', ...mountOptions });
        return { dom, controller, cards: dom.root.querySelector('.dashboard-service-cards') };
    }
    test('shows no contact control unless the host passes a sender', () => {
        const { dom, controller } = services({});
        expect(byText(dom.root, ASK)).toBeUndefined();
        controller.destroy();
    });
    test('puts one control on each service card, sending that service key', async () => {
        const send = jest.fn(async () => 'requested');
        const { cards, controller } = services({}, { contactRequest: send });
        const panels = cards.children;
        expect(panels).toHaveLength(registry.services.length);
        panels.forEach((card, index) => {
            const asks = buttonsIn(card).filter(item => item.textContent === ASK);
            expect(asks).toHaveLength(1);
            expect(asks[0].getAttribute('aria-label')).toBe('Ask No Fries to contact me about ' + registry.services[index].label);
        });
        const third = panels[2];
        byText(third, ASK).click(); byText(third, 'Send request').click(); await settle();
        expect(send).toHaveBeenCalledWith(registry.services[2].key);
        expect(third.querySelector('[role="status"]').textContent).toBe(SENT);
        controller.destroy();
    });
    test('an advisor-only projection gets no control even when a sender is passed', () => {
        const { dom, controller } = services({ role: 'fractional_advisor', service: 'fractional_advisory' }, { contactRequest: jest.fn() });
        expect(byText(dom.root, ASK)).toBeUndefined();
        controller.destroy();
    });
    test('a viewer gets the control', () => {
        const { dom, controller } = services({ role: 'viewer' }, { contactRequest: jest.fn() });
        expect(byText(dom.root, ASK)).toBeDefined();
        controller.destroy();
    });
});

describe('results next step', () => {
    const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
    function mixed() {
        const responses = allResponses().map((row, index) => ({ ...row,
            optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
            rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
        const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
        let version = null;
        for (const command of [createCommand('assessment-mixed', 'create-mixed', 'Synthetic office and cloud scope.'),
            saveCommand('assessment-mixed', 0, 'save-mixed', responses), submitCommand('assessment-mixed', 1, 'submit-mixed')]) {
            version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
                action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
            command.idempotencyKey, version, tenant.state.tenantAggregate, NCSC_NOW);
        }
        return projectNcscDetail(version);
    }
    async function mounted(extra) {
        const fixtures = buildFixtures(), seed = JSON.parse(JSON.stringify(fixtures.tenants[0])); seed.assessments = [mixed()];
        const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures), dom = createDom();
        const controller = picture.mount(dom.root, { metadata: fixtures.metadata, organisationId: seed.model.context.organisationId,
            client: createClient({ metadata: fixtures.metadata, fetch: transport.fetch }), displayName: 'Synthetic organisation A', ...extra });
        await flush();
        return { dom, controller, panel: dom.root.querySelector('.picture-next-steps') };
    }
    test('shows the host control in the Next step panel when offered', async () => {
        const send = jest.fn(async () => 'already_requested');
        const contactControl = jest.fn(() => shell.contactControl(createDom().document, 'results', send));
        const { panel, controller } = await mounted({ contactControl });
        expect(panel).not.toBeNull();
        expect(contactControl).toHaveBeenCalled();
        byText(panel, ASK).click(); byText(panel, 'Send request').click(); await settle();
        expect(send).toHaveBeenCalledWith('results');
        expect(panel.querySelector('.dashboard-contact-status').textContent).toBe(ALREADY);
        controller.destroy();
    });
    test('shows nothing new without the option', async () => {
        const { panel, controller } = await mounted({});
        expect(panel).not.toBeNull(); expect(byText(panel, ASK)).toBeUndefined();
        controller.destroy();
    });
});

// The delivered loader: session negotiation, transport, retries and outcomes.
describe('dashboard loader', () => {
    const SOURCE = fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
    const A = '10000000-0000-4000-8000-000000000001', GA = 'a'.repeat(64), NOW = '2026-09-08T23:30:00.000Z';
    const ids = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus',
        'dashboardRetry', 'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices',
        'dashboardMore', 'dashboardApp', 'dashboardApplicationIntegrity', 'dashboardStyleIntegrity', 'dashboardSkipLink',
        'dashboardOrganisationSearch', 'dashboardOrganisationStatus', 'dashboardOrganisationSearchControls', 'dashboardOrganisationClear',
        'dashboardOrganisationCount', 'dashboardOrganisationEmpty'];
    const account = (extra = {}) => ({ schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'company',
        contactRequestsAvailable: true, expiresAt: '2026-09-09T00:30:00.000Z', generation: GA, selectedBindingId: A, ...extra });
    const directory = { schemaVersion: 1, bindings: [{ bindingId: A, organisationLabel: 'Kauri client' }], nextAfterBindingId: null };
    const response = (status, value) => ({ status, ok: status >= 200 && status < 300, redirected: false, type: 'basic',
        headers: { get: () => 'application/json; charset=utf-8' }, json: async () => value });

    function harness() {
        const { document, window } = createDom(), createElement = document.createElement;
        document.createElement = tag => {
            const node = createElement(tag);
            Object.defineProperty(node, 'id', { get: () => node.getAttribute('id') || '', set: value => node.setAttribute('id', value) });
            return node;
        };
        const elements = Object.fromEntries(ids.map(id => [id, document.createElement('div')]));
        Object.entries(elements).forEach(([id, node]) => { node.id = id; });
        const findId = (node, id) => !node ? null : node.id === id ? node : node.children.map(child => findId(child, id)).find(Boolean) || null;
        document.body = document.createElement('body'); document.body.dataset.page = 'operator-dashboard';
        document.body.dataset.customerProvider = 'staff'; document.body.append(elements.dashboardEntry);
        document.getElementById = id => elements[id] || findId(document.body, id);
        document.querySelectorAll = selector => document.body.querySelectorAll(selector);
        document.querySelector = selector => document.body.querySelector(selector);
        elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
        document.head = document.createElement('head'); const native = [];
        document.head.append = node => { native.push(node); document.head.children.push(node); };
        document.head.removeChild = node => { document.head.children = document.head.children.filter(item => item !== node); };
        const sri = 'sha256-' + crypto.createHash('sha256').update('approved bytes').digest('base64');
        elements.dashboardApplicationIntegrity.setAttribute('content', sri); elements.dashboardStyleIntegrity.setAttribute('content', sri);
        const storage = { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() };
        window.location.hash = '#services'; window.crypto = { randomUUID: crypto.randomUUID }; window.setTimeout = setTimeout;
        window.clearTimeout = clearTimeout; window.confirm = jest.fn(() => false); window.location.assign = jest.fn();
        window.localStorage = storage; window.sessionStorage = storage;
        const requests = [];
        const fetch = (url, init) => { const work = deferred(); requests.push({ url, init, ...work }); return work.promise; };
        vm.runInContext(SOURCE, vm.createContext({ document, window, fetch, AbortController, Date, console }), { filename: 'dashboard-loader.js' });
        async function reply(index, status, value) { expect(requests[index]).toBeDefined(); requests[index].resolve(response(status, value)); await settle(); }
        async function fail(index) { expect(requests[index]).toBeDefined(); requests[index].reject(new TypeError('synthetic network')); await settle(); }
        function loadAssets() { window.NoFriesDashboard = shell; native.slice(-2).forEach(node => node.onload()); }
        return { document, window, elements, requests, reply, fail, loadAssets, storage, get status() { return document.body.dataset.dashboardState; } };
    }
    async function ready(h, session = account()) {
        await settle(); await h.reply(0, 200, session); await h.reply(1, 200, directory);
        await h.reply(2, 200, JSON.parse(JSON.stringify(projectDashboard(fixture({ now: NOW })))));
        h.loadAssets(); await settle(); await h.reply(3, 200, session);
        expect(h.status).toBe('ready');
    }
    function ask(h, index = 0) {
        const card = h.elements.dashboardApp.querySelector('.dashboard-service-cards').children[index];
        byText(card, ASK).click(); byText(card, 'Send request').click();
        return card;
    }
    const contactCalls = h => h.requests.filter(item => item.url === '/api/dashboard/contact-requests');
    beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    test('advertises the contact capability on session reads', async () => {
        const h = harness(); await ready(h);
        h.requests.filter(item => item.url === '/api/dashboard/session').forEach(item =>
            expect(item.init.headers['X-NoFries-Dashboard-Capabilities']).toBe('work-queue-v1 account-label-v1 contact-request-v1'));
    });
    test('without the session field no control is shown', async () => {
        const session = account(); delete session.contactRequestsAvailable;
        const h = harness(); await ready(h, session);
        expect(byText(h.elements.dashboardApp, ASK)).toBeUndefined();
    });
    test.each([false, 'true', 1, null])('a malformed contactRequestsAvailable %p fails closed', async value => {
        const h = harness(); await settle(); await h.reply(0, 200, account({ contactRequestsAvailable: value }));
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1);
    });
    test('an operator session cannot carry the field', async () => {
        const session = account({ purpose: 'operator_dashboard' }); delete session.accountType;
        const h = harness(); await settle(); await h.reply(0, 200, session);
        expect(h.status).toBe('unavailable');
    });
    test('sends one closed request with a fresh lowercase id and shows the outcome', async () => {
        const h = harness(); await ready(h);
        const card = ask(h, 1); await settle();
        const [call] = contactCalls(h);
        expect(call.init.method).toBe('POST');
        expect(call.init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(call.init.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(call.init.body);
        expect(Object.keys(body).sort()).toEqual(['consentVersion', 'operationId', 'topic']);
        expect(body.topic).toBe(registry.services[1].key); expect(body.consentVersion).toBe('contact-request-v1');
        expect(body.operationId).toMatch(UUID);
        await h.reply(h.requests.indexOf(call), 200, { schemaVersion: 1, status: 'requested' });
        expect(card.querySelector('[role="status"]').textContent).toBe(SENT);
        expect(call.url).toBe('/api/dashboard/contact-requests');
        expect(h.storage.setItem.mock.calls.flat().join(' ')).not.toMatch(/contact|operationId/i);
        expect(h.window.location.hash).toBe('#services');
        // A second action is a new operation.
        byText(card, ASK); const next = ask(h, 2); await settle();
        const second = contactCalls(h)[1];
        expect(JSON.parse(second.init.body).operationId).not.toBe(body.operationId);
        await h.reply(h.requests.indexOf(second), 200, { schemaVersion: 1, status: 'already_requested' });
        expect(next.querySelector('[role="status"]').textContent).toBe(ALREADY);
    });
    test('a 503 and a network error retry the same operation id, at most three attempts', async () => {
        const h = harness(); await ready(h);
        const card = ask(h); await settle();
        await h.reply(h.requests.indexOf(contactCalls(h)[0]), 503, { code: 'contact_request_unavailable' });
        expect(contactCalls(h)).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1000); await settle();
        expect(contactCalls(h)).toHaveLength(2);
        await h.fail(h.requests.indexOf(contactCalls(h)[1]));
        await jest.advanceTimersByTimeAsync(2000); await settle();
        const calls = contactCalls(h);
        expect(calls).toHaveLength(3);
        expect(new Set(calls.map(item => JSON.parse(item.init.body).operationId)).size).toBe(1);
        await h.reply(h.requests.indexOf(calls[2]), 503, { code: 'contact_request_unavailable' });
        await jest.advanceTimersByTimeAsync(10000); await settle();
        expect(contactCalls(h)).toHaveLength(3);
        expect(card.querySelector('[role="status"]').textContent).toBe(FAILED);
        expect(h.status).toBe('ready');
    });
    test('a retry that succeeds shows the sent message', async () => {
        const h = harness(); await ready(h);
        const card = ask(h); await settle();
        await h.fail(h.requests.indexOf(contactCalls(h)[0]));
        await jest.advanceTimersByTimeAsync(1000); await settle();
        await h.reply(h.requests.indexOf(contactCalls(h)[1]), 200, { schemaVersion: 1, status: 'requested' });
        expect(card.querySelector('[role="status"]').textContent).toBe(SENT);
    });
    test.each([
        [403, { code: 'contact_request_access_denied' }],
        [404, { code: 'dashboard_route_not_found' }],
        [409, { code: 'contact_request_operation_conflict' }],
        [400, { code: 'contact_request_input_invalid' }],
        [200, { schemaVersion: 1, status: 'queued' }],
        [200, { schemaVersion: 1, status: 'requested', extra: true }]
    ])('a %s answer is a neutral failure without retry and keeps the dashboard open', async (status, value) => {
        const h = harness(); await ready(h);
        const card = ask(h); await settle();
        await h.reply(h.requests.indexOf(contactCalls(h)[0]), status, value);
        await jest.advanceTimersByTimeAsync(5000); await settle();
        expect(contactCalls(h)).toHaveLength(1);
        expect(card.querySelector('[role="status"]').textContent).toBe(FAILED);
        expect(byText(card, ASK).hidden).toBe(false);
        expect(h.status).toBe('ready');
    });
});
