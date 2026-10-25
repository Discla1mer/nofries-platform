'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');
const { createDom } = require('./fixtures/dashboardDom');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');
const ncscClient = require('../api/shared/protectedAssets/ncscAssessmentClient');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { fixture } = require('./fixtures/dashboardFixture');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { normaliseNcscCommand, projectNcscDetail, projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createCommand, saveCommand, allResponses } = require('./fixtures/ncscAssessmentFixture');

const SOURCE = fs.readFileSync(process.env.NOFRIES_DASHBOARD_LOADER_TEST_SOURCE ||
    path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
const ENTRY_HTML = fs.readFileSync(path.join(__dirname, '../app/dashboard.html'), 'utf8');
const GATEWAY_HTML = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const ENTRY_MARKUP = ENTRY_HTML.match(/<(main|div)\s+class="shell"([^>]*)>/);
const NOW = '2026-09-08T23:30:00.000Z';
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const GA = 'a'.repeat(64);
const GB = 'b'.repeat(64);
const GC = 'c'.repeat(64);
const ids = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus', 'dashboardRetry',
    'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices', 'dashboardMore', 'dashboardApp',
    'dashboardApplicationIntegrity', 'dashboardStyleIntegrity', 'dashboardSkipLink'];

function state(selectedBindingId = A, generation = GA, extra = {}) {
    return { schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', expiresAt: '2026-09-09T00:30:00.000Z',
        generation, selectedBindingId, ...extra };
}
function listing(bindings = [A, B], nextAfterBindingId = null) {
    return { schemaVersion: 1, bindings: bindings.map(bindingId => ({ bindingId, organisationLabel: 'Organisation ' + bindingId.slice(-1) })), nextAfterBindingId };
}
function projection(name = 'Current organisation') {
    return projectDashboard(fixture({ now: NOW, name }));
}
function response(status, value, extra = {}) {
    return { status, ok: status >= 200 && status < 300, redirected: false, type: 'basic',
        headers: { get: () => 'application/json; charset=utf-8' }, json: async () => value, ...extra };
}
function deferred() {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 35; index += 1) await Promise.resolve(); }

// This drives actual loader and shell source. The DOM/native events are controlled
// doubles: they do not establish layout, CSP/SRI enforcement or network redirects.
function harness(options = {}) {
    const dom = createDom();
    const { document, window } = dom;
    const createElement = document.createElement;
    document.createElement = tag => {
        const element = createElement(tag);
        Object.defineProperty(element, 'id', { get: () => element.getAttribute('id') || '', set: value => element.setAttribute('id', value) });
        element.contains = child => element === child || element.children.some(item => item.contains(child));
        return element;
    };
    const elements = Object.fromEntries(ids.map(id => [id, document.createElement('div')]));
    // Preserve the real entry document's landmark container when composing the
    // genuine shell; otherwise a detached mount double hides nested landmarks.
    elements.dashboardEntry = document.createElement(ENTRY_MARKUP[1]);
    const entryRole = ENTRY_MARKUP[2].match(/\brole="([^"]+)"/);
    if (entryRole) elements.dashboardEntry.setAttribute('role', entryRole[1]);
    Object.entries(elements).forEach(([id, element]) => { element.id = id; });
    const findId = (node, id) => !node ? null : node.id === id ? node : node.children.map(child => findId(child, id)).find(Boolean) || null;
    document.getElementById = id => elements[id] || findId(document.body, id);
    document.body = document.createElement('body');
    document.body.dataset.page = options.page || 'operator-dashboard';
    // Ordinary operator cases use an explicit staff document. An absent marker
    // is exercised separately, including the actual generated public documents.
    if (options.external) document.body.dataset.customerProvider = 'external';
    else if (!Object.hasOwn(options, 'provider')) document.body.dataset.customerProvider = 'staff';
    else if (options.provider !== undefined) document.body.dataset.customerProvider = options.provider;
    if (options.documentHtml) {
        document.body.dataset = {};
        const body = options.documentHtml.match(/<body\b([^>]*)>/)[1];
        for (const attribute of body.matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
            document.body.dataset[attribute[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attribute[2];
        }
    }
    if (options.gateway) { document.body.dataset.dashboardGateway = 'true'; elements.gatewayPublic = document.createElement('div'); }
    // Exercise the actual standalone or root gateway entry's Home links, including their
    // opt-in guard attribute; do not synthesize a route the page does not use.
    const header = document.createElement('header');
    const homeEntry = options.documentHtml || (options.gateway ? GATEWAY_HTML : ENTRY_HTML);
    function links(markup, parent) {
        return [...markup.matchAll(/<a\b([^>]*\bhref="[^"]+"[^>]*)>/g)].map(match => {
            const anchor = document.createElement('a');
            for (const attribute of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
                anchor.setAttribute(attribute[1], attribute[2] || '');
                if (attribute[1] === 'href') anchor.href = attribute[2];
                if (attribute[1].startsWith('data-')) anchor.dataset[attribute[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attribute[2] || '';
            }
            parent.append(anchor); return anchor;
        });
    }
    const headerLinks = links(homeEntry.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1], header);
    const homeLinks = headerLinks.filter(link => link.href === '/');
    const footer = document.createElement('footer');
    const footerLinks = links(homeEntry.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)[1], footer);
    document.body.append(header, elements.dashboardEntry, footer);
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.querySelector = selector => document.body.querySelector(selector);
    const prototype = Object.getPrototypeOf(elements.dashboardApp);
    prototype.showModal = function () { this.open = true; };
    prototype.close = function () { this.open = false; };
    prototype.removeChild = function (node) { this.children = this.children.filter(item => item !== node); node.parentElement = null; };
    elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
    document.head = document.createElement('head');
    const native = [];
    document.head.append = node => { node.parentNode = document.head; native.push(node); document.head.children.push(node); };
    document.head.removeChild = node => { document.head.children = document.head.children.filter(item => item !== node); node.parentNode = null; };
    const sri = 'sha256-' + crypto.createHash('sha256').update('approved bytes').digest('base64');
    elements.dashboardApplicationIntegrity.setAttribute('content', sri);
    elements.dashboardStyleIntegrity.setAttribute('content', sri);
    window.location.hash = options.hash || '';
    window.location.search = '?tenant=must-not-survive';
    window.location.assign = jest.fn();
    window.crypto = options.noCrypto ? undefined : { randomUUID: jest.fn(() => crypto.randomUUID()) };
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const listeners = {};
    const originalAdd = window.addEventListener;
    window.addEventListener = (name, callback) => { (listeners[name] ||= []).push(callback); originalAdd(name, callback); };
    const requests = [];
    const fetch = jest.fn((url, init) => {
        const work = deferred();
        requests.push({ url, init, ...work });
        return work.promise;
    });
    const mounts = [], ncscMounts = [], improvementMounts = [];
    const factory = { validate: jest.fn(shell.validate), mount: jest.fn((root, model, config) => {
        const controller = shell.mount(root, model, config);
        const destroy = jest.spyOn(controller, 'destroy');
        mounts.push({ root, model, config, controller, destroy });
        return controller;
    }) };
    const context = vm.createContext({ document, window, fetch, AbortController, Date, console: { log: jest.fn(), error: jest.fn() } });
    const source = options.documentHtml ? options.documentHtml.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1] : options.source || SOURCE;
    vm.runInContext(source, context, { filename: 'dashboard-loader.js' });
    async function reply(index, status, value, extra) {
        expect(requests[index]).toBeDefined();
        requests[index].resolve(response(status, value, extra));
        await flush();
    }
    function load(index, fail = false) {
        const node = native[index];
        expect(node).toBeDefined();
        if (node.tagName === 'SCRIPT' && !options.noFactory) {
            window.NoFriesDashboard = factory;
            if (options.improvement) window.NoFriesImprovementActionPlanClient = { mount: (root, input) => {
                const controller = require('../api/shared/protectedAssets/improvementActionPlanClient').mount(root, { ...input,
                    request: async (path, body) => { const result = await input.request(path, body);
                        return { status: result.status, value: JSON.parse(JSON.stringify(result.value)) }; },
                    ...(input.sourceAssessment ? { sourceAssessment: JSON.parse(JSON.stringify(input.sourceAssessment)) } : {}) });
                improvementMounts.push({ root, input, controller }); return controller;
            } };
            if (options.cyber) {
                window.NoFriesNcscAssessmentClient = { createClient: input => ncscClient.createClient({
                    metadata: JSON.parse(JSON.stringify(input.metadata)), fetch: input.fetch }) };
                window.NoFriesNcscQuestionnaire = { mount: (...args) => { ncscMounts.push(args); return questionnaire.mount(...args); } };
                if (options.picture) window.NoFriesOrganisationPicture = require('../api/shared/protectedAssets/organisationPicture');
            }
        }
        const callback = fail ? node.onerror : node.onload;
        if (callback) callback();
    }
    async function open(value = state(), name = 'Current organisation', first = requests.length ? requests.length - 1 : 0) {
        await reply(first, 200, value);
        await reply(first + 1, 200, listing());
        if (value.selectedBindingId === null) return;
        await reply(first + 2, 200, projection(name));
        const index = native.length - 2;
        load(index); load(index + 1); await flush();
        await reply(first + 3, 200, value);
    }
    function click(id) { const node = elements[id]; node.click(); if (node.onclick) node.onclick(); }
    function linkClick(anchor, extra = {}) {
        const event = { currentTarget: anchor, target: anchor, button: 0, ctrlKey: false, metaKey: false, shiftKey: false,
            altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
        for (const callback of anchor.events.click || []) callback(event);
        if (!event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !(event.button > 0) &&
            (!anchor.getAttribute('target') || anchor.getAttribute('target') === '_self') && anchor.getAttribute('download') === null) window.location.assign(anchor.href);
        return event;
    }
    function homeClick(index = 0, extra = {}) { return linkClick(homeLinks[index], extra); }
    return { ...dom, elements, native, requests, fetch, reply, load, open, factory, mounts, ncscMounts, improvementMounts, click, homeLinks, homeClick, headerLinks, footerLinks, linkClick,
        event: (name, data) => (listeners[name] || []).forEach(callback => callback(data)),
        get status() { return document.body.dataset.dashboardState; } };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('mounted retained Improvement Plan', () => {
    async function ready(h) {
        await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = JSON.parse(JSON.stringify(projection()));
        model.modules.find(item => item.key === 'improvement_plan').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        return model;
    }
    function empty(model) {
        return { schemaVersion: 1, scope: { tenantId: fixture().scope.tenantId,
            organisationId: model.context.organisationId }, asOf: NOW, plans: [], nextAfterPlanId: null };
    }
    test('the genuine mounted client uses the selected generation and persisted index without Cyber access', async () => {
        const h = harness({ improvement: true, hash: '#improvement-plan' }), model = await ready(h);
        expect(h.requests[3].url).toBe('/api/dashboard/session'); await h.reply(3, 200, state());
        expect(h.mounts[0].config.mountImprovement).toEqual(expect.any(Function));
        expect(h.requests[4].url).toMatch(/^\/api\/dashboard\/improvement\/plans(?:\?|$)/);
        expect(h.requests[4].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(h.requests[4].init.credentials).toBe('same-origin');
        await h.reply(4, 200, empty(model));
        expect(h.improvementMounts).toHaveLength(1);
        expect(await h.improvementMounts[0].controller.ready).toBe(true);
        expect(h.elements.dashboardApp.textContent).not.toContain('workspace is coming next');
        expect(h.elements.dashboardApp.querySelector('[aria-label="Saved improvement plans"]')).not.toBeNull();
        expect(h.requests.some(item => item.url.includes('/ncsc/'))).toBe(false);
        h.window.dispatch('pagehide');
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.improvementMounts[0].input.isCurrent()).toBe(false);
    });
    test('a ready projection cannot fall back to a missing client implementation', async () => {
        const h = harness({ hash: '#improvement-plan' }); await ready(h);
        expect(h.status).toBe('unavailable'); expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.requests).toHaveLength(3);
    });
    test.each([401, 403])('an index %s clears the mounted shell through the canonical failure path', async status => {
        const h = harness({ improvement: true, hash: '#improvement-plan' }); await ready(h);
        await h.reply(3, 200, state()); await h.reply(4, status, { code: 'improvement_list_access_denied' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied');
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
    });
    test('a late plan index cannot disclose after page teardown', async () => {
        const h = harness({ improvement: true, hash: '#improvement-plan' }), model = await ready(h);
        await h.reply(3, 200, state()); h.window.dispatch('pagehide'); await h.reply(4, 200, empty(model));
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.requests).toHaveLength(5);
    });
    test('an unready module never installs the controller or requests retained plan data', async () => {
        const h = harness({ improvement: true, hash: '#improvement-plan' }); await flush(); await h.open();
        expect(h.mounts[0].config.mountImprovement).toBeUndefined();
        expect(h.improvementMounts).toHaveLength(0);
        expect(h.requests.some(item => item.url.includes('/improvement/'))).toBe(false);
        h.window.dispatch('pagehide');
    });
});

describe('consultant client setup', () => {
    const consultant = () => state(A, GA, { purpose: 'customer', accountType: 'consultant', clientSetupAvailable: true });
    const csrfToken = 'c'.repeat(43);
    async function portfolio(options = {}) {
        const h = harness({ hash: '#organisations', provider: undefined, ...options });
        await flush();
        await h.reply(0, 200, consultant()); await h.reply(1, 200, listing([A]));
        expect(h.requests[2].url).toBe('/api/customer-signup/clients'); return h;
    }
    // Setup commands stay in the form; saved incomplete organisations now
    // appear beside ready directory bindings in the single chooser list.
    const buttons = h => h.document.getElementById('clientSetupControls').querySelectorAll('button')
        .concat(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row').flatMap(row => row.querySelectorAll('button')));
    test.each([401, 403])('account-owner caption is cleared when a current session read returns %s', async status => {
        const h = await portfolio();
        await h.reply(2, 200, { csrfToken, state: { status: 'clients', remaining: 3, clients: [] } });
        expect(h.elements.dashboardHeading.textContent).toBe('Your consultant account');
        expect(h.elements.dashboardMessage.textContent).toContain('Choose your own or a client organisation');
        expect(h.elements.dashboardStatus.textContent).toContain('Account owner');
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Add organisation');
        h.event('focus'); await flush();
        expect(h.requests[3].init.method).toBe('GET');
        await h.reply(3, status, { code: 'synthetic_access_unavailable' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied');
        expect(h.elements.dashboardStatus.textContent).not.toContain('Account owner');
        expect(h.document.getElementById('clientSetupControls')).toBeNull();
        expect(h.requests.every(r => r.init.method === 'GET')).toBe(true);
    });
    async function savedAcceptance() {
        const h = await portfolio();
        await h.reply(2, 200, { csrfToken, state: { status: 'clients', remaining: 1, clients: [
            { requestId: C, organisationName: 'Saved client', status: 'pending' },
            { requestId: B, organisationName: 'Other client', status: 'pending' }
        ] } });
        buttons(h).find(b => (b.getAttribute('aria-label') || b.textContent) === 'Continue setup: Saved client').click(); await flush();
        expect(JSON.parse(h.requests[3].init.body)).toEqual({ action: 'resume', requestId: C });
        return h;
    }
    const offeredTerms = () => ({ csrfToken, state: { status: 'terms', termsText: 'Synthetic terms', scheduleText: 'Synthetic schedule',
        termsVersion: 'synthetic', termsDigest: GA, scheduleId: 'synthetic-schedule', scheduleDigest: GB } });
    const pendingClient = (requestId = C, token = csrfToken) => ({ csrfToken: token, state: { status: 'clients', remaining: 2,
        clients: [{ requestId, organisationName: 'Saved client', status: 'pending' }] } });
    async function acceptingClient() {
        const h = await savedAcceptance(); await h.reply(3, 200, offeredTerms());
        h.document.getElementById('clientSetupControls').querySelector('input').checked = true;
        buttons(h).find(b => b.textContent === 'Accept and create client dashboard').click(); await flush();
        expect(h.requests[4].init.method).toBe('GET'); return h;
    }
    // Alternate capacities are synthetic transport fixtures, not approved plans.
    const clientQuota = (used, remaining) => ({ csrfToken, state: { status: 'clients', remaining,
        clients: Array.from({ length: used }, (_, index) => ({
            requestId: '20000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
            organisationName: 'Synthetic quota client ' + (index + 1),
            status: ['ready', 'pending', 'details_required'][index % 3]
        })) } });
    test.each([
        { used: 0, remaining: 0 }, { used: 0, remaining: 1 },
        { used: 1, remaining: 0 }, { used: 1, remaining: 1 },
        { used: 2, remaining: 1 }, { used: 4, remaining: 0 },
        { used: 5, remaining: 0 }, { used: 5, remaining: 3 },
        { used: 0, remaining: Number.MAX_SAFE_INTEGER },
        { used: 5, remaining: Number.MAX_SAFE_INTEGER - 5 }
    ])('valid server list renders $used saved clients with $remaining slots remaining', async ({ used, remaining }) => {
        const h = await portfolio(); await h.reply(2, 200, clientQuota(used, remaining));
        const controls = h.document.getElementById('clientSetupControls');
        expect(controls.textContent).not.toContain('Your starter account includes up to');
        if (remaining > 0) expect(controls.textContent).toContain(remaining +
            (remaining === 1 ? ' client slot remains.' : ' client slots remain.'));
        expect(controls.textContent).toContain('Organisations added here share your account’s original access period.');
        const incomplete = clientQuota(used, remaining).state.clients.filter(client => client.status !== 'ready');
        const savedRows = h.elements.dashboardChoices.querySelectorAll('.client-workspace-row');
        expect(savedRows).toHaveLength(incomplete.length);
        expect(savedRows.map(row => row.dataset.requestId)).toEqual(incomplete.map(client => client.requestId));
        for (const client of incomplete) expect(h.elements.dashboardChoices.textContent).toContain(client.organisationName);
        for (const client of clientQuota(used, remaining).state.clients.filter(client => client.status === 'ready')) {
            expect(h.elements.dashboardChoices.textContent).not.toContain(client.organisationName);
        }
        expect(buttons(h).some(b => b.textContent === 'Add organisation')).toBe(remaining > 0);
        expect(buttons(h).some(b => b.textContent === 'Retry')).toBe(false);
        if (remaining === 0) expect(controls.textContent).toContain('No client slots remain.');
        if (remaining === 0) expect(controls.textContent).not.toContain('Add a client to review');
        expect(h.requests.every(r => r.init.method === 'GET')).toBe(true);
    });
    const readerClients = (count, nextCursor = null, start = 1) => ({ csrfToken, state: {
        status: 'clients_read_only', remaining: null, nextCursor, clients: Array.from({length:count},(_,index)=>({
            requestId:'40000000-0000-4000-8000-'+String(start+index).padStart(12,'0'),
            organisationName:'Read-only client '+(start+index),status:index%2?'details_required':'pending'
        }))
    }});
    test.each([0,4,50])('reader-floor list with %s saved setups renders records without lifecycle actions or access claims',async count=>{
        const h=await portfolio();await h.reply(2,200,readerClients(count));
        const controls=h.document.getElementById('clientSetupControls');
        expect(controls.textContent).toContain('Further setup steps are currently unavailable');
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(count);
        expect(h.elements.dashboardChoices.children.filter(node=>node.getAttribute('data-binding-id'))).toHaveLength(1);
        expect(buttons(h).some(button=>/Add organisation|Continue|Accept|Complete|Retry previous/.test(button.textContent))).toBe(false);
        expect(controls.querySelector('input')).toBeNull();expect(controls.querySelector('form')).toBeNull();
        expect(controls.textContent).not.toContain('no product limit');expect(h.requests.every(request=>request.init.method==='GET')).toBe(true);
    });
    test('reader-floor More and First pages remain bounded reads and retain authorised directory choices',async()=>{
        const h=await portfolio();await h.reply(2,200,readerClients(50,'reader_page_2'));
        buttons(h).find(button=>button.textContent==='More saved setups').click();await flush();
        expect(h.requests[3].url).toBe('/api/customer-signup/clients?cursor=reader_page_2');
        await h.reply(3,200,readerClients(4,null,51));
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(4);
        expect(h.elements.dashboardChoices.textContent).toContain('Read-only client 54');
        expect(buttons(h).some(button=>button.textContent==='More saved setups')).toBe(false);
        buttons(h).find(button=>button.textContent==='First saved setups').click();await flush();
        expect(h.requests[4].url).toBe('/api/customer-signup/clients');await h.reply(4,200,readerClients(50,'reader_page_2'));
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(50);
        expect(buttons(h).some(button=>button.textContent==='First saved setups')).toBe(false);
        expect(h.elements.dashboardChoices.children.filter(node=>node.getAttribute('data-binding-id'))).toHaveLength(1);
        expect(h.requests.every(request=>request.init.method==='GET')).toBe(true);
    });
    test('reader-floor saved setups leave authorised selection and Return to organisations usable',async()=>{
        const h=await portfolio();await h.reply(2,200,readerClients(4));
        h.elements.dashboardChoices.children.find(node=>node.getAttribute('data-binding-id')===A).click();await flush();
        expect(JSON.parse(h.requests[3].init.body)).toMatchObject({bindingId:A,expectedGeneration:GA});
        await h.reply(3,200,{schemaVersion:1,generation:GB,selectedBindingId:A});
        const selected={...consultant(),generation:GB};await h.open(selected,'Authorised own workspace',4);
        expect(h.status).toBe('ready');
        h.document.getElementById('consultantPortfolioControls').onclick();await flush();
        await h.reply(8,200,selected);await h.reply(9,200,listing([A]));await h.reply(10,200,readerClients(4));
        expect(h.status).toBe('selection');expect(h.window.location.hash).toBe('#organisations');
        expect(buttons(h).some(button=>/Add organisation|Continue|Accept/.test(button.textContent))).toBe(false);
        expect(h.requests.filter(request=>request.init.method==='POST')).toHaveLength(1);
    });
    test.each(['draft','pending'])('reader-floor response discards a cached %s after fresh return without submitting it',async kind=>{
        const {h}=await unfinished();
        if(kind==='pending'){
            const form=h.document.getElementById('clientSetupControls').querySelector('form');
            for(const submit of form.events.submit)submit({preventDefault(){}});await flush();
        }
        const posts=h.requests.filter(request=>request.init.method==='POST').length,index=h.requests.length;
        h.event('pagehide');h.event('pageshow',{persisted:true});await flush();
        await h.reply(index,200,consultant());await h.reply(index+1,200,listing([A]));await h.reply(index+2,200,readerClients(4));
        const controls=h.document.getElementById('clientSetupControls');
        expect(controls.querySelector('form')).toBeNull();expect(controls.querySelector('input')).toBeNull();
        expect(buttons(h).some(button=>/Add organisation|Continue|Accept|Retry previous|Check and resume/.test(button.textContent))).toBe(false);
        expect(h.requests.filter(request=>request.init.method==='POST')).toHaveLength(posts);
        if(kind==='pending')await h.reply(3,200,offeredTerms());
        expect(buttons(h).some(button=>button.textContent==='Accept and create client dashboard')).toBe(false);
    });
    test('setup read-only removes existing saved-row actions while preserving authorised ready choices',async()=>{
        const h=await portfolio();
        await h.reply(2,200,{csrfToken,state:{status:'clients',remaining:1,clients:[
            {requestId:C,organisationName:'Saved pending client',status:'pending'},
            {requestId:B,organisationName:'Saved incomplete client',status:'details_required'}
        ]}});
        const ready=h.elements.dashboardChoices.children.find(node=>node.getAttribute('data-binding-id')===A);
        const rows=h.elements.dashboardChoices.querySelectorAll('.client-workspace-row');
        expect(rows).toHaveLength(2);expect(rows.flatMap(row=>row.querySelectorAll('button'))).toHaveLength(2);
        buttons(h).find(button=>button.getAttribute('aria-label')==='Continue setup: Saved pending client').click();await flush();
        await h.reply(3,200,{csrfToken,state:{status:'setup_read_only'}});
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(2);
        expect(rows.flatMap(row=>row.querySelectorAll('button'))).toHaveLength(0);
        expect(h.elements.dashboardChoices.textContent).toContain('Saved pending client');
        expect(h.elements.dashboardChoices.textContent).toContain('Saved incomplete client');
        expect(h.elements.dashboardChoices.children.find(node=>node.getAttribute('data-binding-id')===A)).toBe(ready);
        expect(ready.disabled).not.toBe(true);ready.click();await flush();
        expect(h.requests[4].url).toBe('/api/dashboard/selection');
        expect(JSON.parse(h.requests[4].init.body)).toMatchObject({bindingId:A,expectedGeneration:GA});
        expect(h.requests.filter(request=>request.url==='/api/customer-signup/clients'&&request.init.method==='POST')).toHaveLength(1);
    });
    test('setup read-only response offers only a list readback and discards the completed command',async()=>{
        const {h}=await submittedClient();await h.reply(3,200,{csrfToken,state:{status:'setup_read_only'}});
        const controls=h.document.getElementById('clientSetupControls');
        expect(controls.textContent).toContain('Further setup steps are currently unavailable');
        expect(buttons(h).map(button=>button.textContent)).toEqual(['Back to saved setups']);
        buttons(h)[0].click();await flush();expect(h.requests[4].init.method).toBe('GET');
        expect(h.requests[4].url).toBe('/api/customer-signup/clients');await h.reply(4,200,readerClients(4));
        expect(h.requests.filter(request=>request.init.method==='POST')).toHaveLength(1);
    });
    test('read-only consent preflight cannot submit acceptance from an earlier writable terms view',async()=>{
        const h=await acceptingClient(),value=pendingClient();
        value.state.status='clients_read_only';value.state.remaining=null;value.state.nextCursor=null;
        await h.reply(4,200,value);
        expect(h.requests).toHaveLength(5);
        expect(h.requests.filter(request=>request.init.method==='POST')).toHaveLength(1);
        expect(buttons(h).some(button=>button.textContent==='Accept and create client dashboard')).toBe(false);
    });
    test('setup read-only response prevents a detached old form from resubmitting its lifecycle command',async()=>{
        const {h}=await unfinished(),form=h.document.getElementById('clientSetupControls').querySelector('form');
        for(const submit of form.events.submit)submit({preventDefault(){}});await flush();
        await h.reply(3,200,{csrfToken,state:{status:'setup_read_only'}});
        for(const submit of form.events.submit)submit({preventDefault(){}});await flush();
        expect(h.requests).toHaveLength(4);
    });
    test.each([
        value=>{value.state.remaining=1;},value=>{delete value.state.nextCursor;},
        value=>{value.state.nextCursor='../foreign';},value=>{value.state.clients=readerClients(51).state.clients;},
        value=>{value.state.clients.push(value.state.clients[0]);},value=>{value.state.authorityGranted=true;}
    ])('malformed reader-floor client projection %# grants no setup controls',async change=>{
        const h=await portfolio(),value=readerClients(1);change(value);await h.reply(2,200,value);
        expect(buttons(h).some(button=>/Add organisation|Continue|Accept/.test(button.textContent))).toBe(false);
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(0);
        expect(h.requests.every(request=>request.init.method==='GET')).toBe(true);
    });
    test('saved actions beyond three rows use only their authoritative request IDs', async () => {
        const h = await portfolio(), value = clientQuota(5, 3); await h.reply(2, 200, value);
        buttons(h).find(b => b.getAttribute('aria-label') === 'Continue setup: Synthetic quota client 5').click(); await flush();
        expect(JSON.parse(h.requests[3].init.body)).toEqual({ action: 'resume', requestId: value.state.clients[4].requestId });
        await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Your terms acceptance is saved');
        expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
    });
    const malformedClientLists = [
        ['missing remaining', value => { delete value.state.remaining; }],
        ['negative remaining', value => { value.state.remaining = -1; }],
        ['fractional remaining', value => { value.state.remaining = 0.5; }],
        ['string remaining', value => { value.state.remaining = '2'; }],
        ['null remaining', value => { value.state.remaining = null; }],
        ['boolean remaining', value => { value.state.remaining = true; }],
        ['object remaining', value => { value.state.remaining = {}; }],
        ['array remaining', value => { value.state.remaining = []; }],
        ['NaN remaining', value => { value.state.remaining = NaN; }],
        ['infinite remaining', value => { value.state.remaining = Infinity; }],
        ['unsafe remaining', value => { value.state.remaining = Number.MAX_SAFE_INTEGER + 1; }],
        ['overflowing total', value => { value.state.remaining = Number.MAX_SAFE_INTEGER; }],
        ['missing clients', value => { delete value.state.clients; }],
        ['non-array clients', value => { value.state.clients = {}; }],
        ['null clients', value => { value.state.clients = null; }],
        ['unexpected quota field', value => { value.state.quota = 3; }],
        ['unknown list status', value => { value.state.status = 'unknown'; }],
        ['augmented envelope', value => { value.proof = 'synthetic-untrusted'; }],
        ['missing CSRF', value => { delete value.csrfToken; }],
        ['invalid CSRF', value => { value.csrfToken = 'synthetic-invalid'; }],
        ['null client row', value => { value.state.clients[0] = null; }],
        ['array client row', value => { value.state.clients[0] = []; }],
        ['missing request ID', value => { delete value.state.clients[0].requestId; }],
        ['invalid request ID', value => { value.state.clients[0].requestId = 'synthetic-invalid'; }],
        ['empty client label', value => { value.state.clients[0].organisationName = ''; }],
        ['control-character client label', value => { value.state.clients[0].organisationName = 'Synthetic\u0000label'; }],
        ['unknown client status', value => { value.state.clients[0].status = 'activated'; }],
        ['augmented client row', value => { value.state.clients[0].grant = 'synthetic-untrusted'; }],
        ['duplicate request ID', value => { value.state.clients.push({ ...value.state.clients[0] }); }]
    ];
    test.each(malformedClientLists)('malformed quota list %s fails closed and retries only a read', async (_name, change) => {
        const h = await portfolio(), value = clientQuota(1, 2); change(value); await h.reply(2, 200, value);
        const controls = h.document.getElementById('clientSetupControls');
        expect(controls.textContent).toContain('We could not load your current client organisations');
        expect(h.elements.dashboardChoices.querySelectorAll('.client-workspace-row')).toHaveLength(0);
        expect(buttons(h).map(b => b.textContent)).toEqual(['Retry']);
        buttons(h)[0].click(); await flush();
        expect(h.requests[3].init.method).toBe('GET'); expect(h.requests[3].init).not.toHaveProperty('body');
        await h.reply(3, 200, clientQuota(1, 2));
        expect(controls.textContent).toContain('2 client slots remain.');
        expect(controls.textContent).not.toContain('Your starter account includes up to');
        expect(h.requests.every(r => r.init.method === 'GET')).toBe(true);
    });
    test.each(malformedClientLists)('malformed quota preflight %s never submits acceptance', async (_name, change) => {
        const h = await acceptingClient(), value = pendingClient(); change(value); await h.reply(4, 200, value);
        expect(h.requests).toHaveLength(5);
        expect(h.requests.filter(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toHaveLength(0);
        expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1); // Original saved-client resume only.
        expect(buttons(h).some(b => /Accept/.test(b.textContent))).toBe(false);
    });
    test.each([0, 1, 4, Number.MAX_SAFE_INTEGER - 1])
        ('alternate capacity preflight with %s remaining preserves one acceptance and repeated same-client recovery', async remaining => {
            const h = await acceptingClient(), freshCsrf = 'd'.repeat(43), value = pendingClient(C, freshCsrf);
            value.state.remaining = remaining; await h.reply(4, 200, value);
            expect(JSON.parse(h.requests[5].init.body)).toEqual({ action: 'accept', requestId: C, terms: { accepted: true,
                termsVersion: 'synthetic', termsDigest: GA, scheduleId: 'synthetic-schedule', scheduleDigest: GB } });
            expect(h.requests[5].init.headers['X-CSRF-Token']).toBe(freshCsrf);
            await h.reply(5, 503, { code: 'starter_signup_unavailable' });
            const recovery = buttons(h).find(b => b.textContent === 'Check and resume saved setup');
            recovery.click(); recovery.click(); await flush();
            expect(h.requests).toHaveLength(7);
            expect(JSON.parse(h.requests[6].init.body)).toEqual({ action: 'resume', requestId: C });
            await h.reply(6, 503, {});
            buttons(h).find(b => b.textContent === 'Check and resume saved setup').click(); await flush();
            expect(JSON.parse(h.requests[7].init.body)).toEqual({ action: 'resume', requestId: C });
            await h.reply(7, 200, { csrfToken: freshCsrf, state: { status: 'ready' } });
            expect(h.requests.filter(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toHaveLength(1);
        });
    test('identity is checked just before acceptance; failed confirmation never submits consent', async () => {
        const h = await acceptingClient();
        const controls = h.document.getElementById('clientSetupControls');
        expect(controls.getAttribute('aria-busy')).toBe('true');
        expect(buttons(h).find(b => /Accept/.test(b.textContent)).disabled).toBe(true);
        await h.reply(4, 401, { code: 'starter_reauthentication_required' });
        expect(h.requests).toHaveLength(5); expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
        expect(controls.textContent).toContain('This attempt has not submitted acceptance');
        expect(controls.querySelector('input')).toBeNull();
        expect(controls.querySelector('a').classList.contains('client-action-primary')).toBe(true);
        expect(controls.querySelector('a').href).toBe('/login?reauthenticate=1');
    });
    test('fresh preflight CSRF is used once despite repeated acceptance clicks', async () => {
        const h = await acceptingClient(), freshCsrf = 'd'.repeat(43);
        buttons(h).find(b => /Accept/.test(b.textContent)).click(); await flush(); expect(h.requests).toHaveLength(5);
        await h.reply(4, 200, pendingClient(C, freshCsrf));
        expect(JSON.parse(h.requests[5].init.body)).toMatchObject({ action: 'accept', requestId: C, terms: { accepted: true } });
        expect(h.requests[5].init.headers['X-CSRF-Token']).toBe(freshCsrf);
        await h.reply(5, 401, { code: 'starter_reauthentication_required' });
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Acceptance is not confirmed');
        expect(h.document.getElementById('clientSetupControls').textContent).not.toContain('has not submitted');
    });
    test.each(['503', 'lost acknowledgement', 'invalid state'])('uncertain acceptance %s recovers the original saved client without resubmitting consent', async outcome => {
        const h = await acceptingClient(); await h.reply(4, 200, pendingClient());
        if (outcome === 'lost acknowledgement') { h.requests[5].reject(new Error('Synthetic lost acknowledgement')); await flush(); }
        else await h.reply(5, outcome === '503' ? 503 : 200, outcome === '503' ? { code: 'starter_signup_unavailable' } : { csrfToken, state: { status: 'unconfirmed' } });
        const recovery = buttons(h).find(b => b.textContent === 'Check and resume saved setup');
        expect(recovery).toBeDefined(); expect(buttons(h).some(b => b.textContent === 'Retry')).toBe(false);
        recovery.click(); recovery.click(); await flush();
        expect(h.requests).toHaveLength(7); expect(JSON.parse(h.requests[6].init.body)).toEqual({ action: 'resume', requestId: C });
        await h.reply(6, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Your terms acceptance is saved');
        expect(h.document.getElementById('clientSetupControls').querySelector('input')).toBeNull();
        expect(h.requests.filter(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toHaveLength(1);
    });
    test('recovery with unrecorded acceptance returns the original terms with an unchecked choice', async () => {
        const h = await acceptingClient(); await h.reply(4, 200, pendingClient()); await h.reply(5, 503, {});
        buttons(h).find(b => b.textContent === 'Check and resume saved setup').click(); await flush(); await h.reply(6, 200, offeredTerms());
        expect(h.document.getElementById('clientSetupControls').querySelector('input').checked).not.toBe(true);
        expect(h.requests).toHaveLength(7);
    });
    test.each(['503', 'lost acknowledgement', 'invalid state'])('interrupted saved-client recovery %s keeps one explicit same-client action', async outcome => {
        const h = await acceptingClient(); await h.reply(4, 200, pendingClient()); await h.reply(5, 503, {});
        buttons(h).find(b => b.textContent === 'Check and resume saved setup').click(); await flush();
        if (outcome === 'lost acknowledgement') { h.requests[6].reject(new Error('Synthetic lost recovery acknowledgement')); await flush(); }
        else await h.reply(6, outcome === '503' ? 503 : 200, outcome === '503' ? {} : { csrfToken, state: { status: 'unconfirmed' } });
        expect(buttons(h)).toHaveLength(1);
        expect(buttons(h)[0].textContent).toBe('Check and resume saved setup');
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('use any recorded acceptance to finish setup');
        buttons(h)[0].click(); await flush(); expect(JSON.parse(h.requests[7].init.body)).toEqual({ action: 'resume', requestId: C });
        await h.reply(7, 200, { csrfToken, state: { status: 'ready' } });
        expect(h.requests.filter(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toHaveLength(1);
    });
    test.each(['missing target', 'augmented envelope', 'duplicate target', '403'])('invalid or denied identity preflight %s never starts an accept', async outcome => {
        const h = await acceptingClient(), value = pendingClient();
        if (outcome === 'missing target') value.state.clients[0].requestId = B;
        if (outcome === 'augmented envelope') value.proof = 'caller-supplied';
        if (outcome === 'duplicate target') { value.state.clients.push(value.state.clients[0]); value.state.remaining = 1; }
        await h.reply(4, outcome === '403' ? 403 : 200, value);
        expect(h.requests).toHaveLength(5); expect(h.requests.some(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toBe(false);
        expect(buttons(h).some(b => /Accept/.test(b.textContent))).toBe(false);
    });
    test('preflight ready readback shows completion without an acceptance write', async () => {
        const h = await acceptingClient(), value = pendingClient(); value.state.clients[0].status = 'ready';
        await h.reply(4, 200, value); expect(h.requests).toHaveLength(5);
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Client dashboard ready');
    });
    test('an abandoned identity preflight cannot submit acceptance in a changed generation', async () => {
        const h = await acceptingClient(); h.window.dispatch('focus'); await flush();
        await recheck(h, 5, { ...consultant(), generation: GB });
        await h.reply(4, 200, pendingClient());
        expect(h.requests.some(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toBe(false);
    });
    test('focus during uncertain acceptance restores explicit same-client recovery and ignores its late success', async () => {
        const h = await acceptingClient(); await h.reply(4, 200, pendingClient());
        h.window.dispatch('focus'); await flush(); await recheck(h, 6);
        const recovery = buttons(h).find(b => b.textContent === 'Check and resume saved setup'); expect(recovery).toBeDefined();
        await h.reply(5, 200, { csrfToken, state: { status: 'ready' } });
        expect(buttons(h).some(b => b.textContent === 'Refresh organisations')).toBe(false);
        recovery.click(); await flush(); expect(JSON.parse(h.requests[9].init.body)).toEqual({ action: 'resume', requestId: C });
        await h.reply(9, 200, { csrfToken, state: { status: 'ready' } });
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('Client dashboard ready');
        expect(h.requests.filter(r => r.init.body && JSON.parse(r.init.body).action === 'accept')).toHaveLength(1);
    });
    test('saved client acceptance requires explicit completion bound to the response despite another busy selection', async () => {
        const h = await savedAcceptance();
        buttons(h).find(b => (b.getAttribute('aria-label') || b.textContent) === 'Continue setup: Other client').click(); await flush();
        buttons(h).find(b => b.textContent === 'Add organisation').click(); await flush();
        expect(h.requests).toHaveLength(4);
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        expect(h.requests).toHaveLength(4);
        const controls = h.document.getElementById('clientSetupControls');
        expect(controls.querySelector('input')).toBeNull();
        expect(controls.textContent).toContain('Your terms acceptance is saved');
        const complete = buttons(h).find(b => b.textContent === 'Complete client setup');
        expect(complete).toBeDefined(); complete.click(); complete.click(); await flush();
        expect(h.requests).toHaveLength(5);
        expect(JSON.parse(h.requests[4].init.body)).toEqual({ action: 'resume_acceptance', requestId: C });
        expect(h.requests[4].init.headers['X-CSRF-Token']).toBe(csrfToken);
        await h.reply(4, 200, { csrfToken, state: { status: 'ready' } });
        expect(controls.textContent).toContain('Client dashboard ready');
    });
    test.each(['503', 'lost acknowledgement'])('saved client completion retains the exact command after %s', async outcome => {
        const h = await savedAcceptance();
        await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        buttons(h).find(b => b.textContent === 'Complete client setup').click(); await flush();
        const original = h.requests[4].init.body;
        if (outcome === '503') await h.reply(4, 503, { code: 'starter_signup_unavailable' });
        else { h.requests[4].reject(new Error('Synthetic acknowledgement lost')); await flush(); }
        buttons(h).find(b => b.textContent === 'Retry').click(); await flush();
        expect(h.requests[5].init.body).toBe(original);
        expect(JSON.parse(original)).toEqual({ action: 'resume_acceptance', requestId: C });
        await h.reply(5, 200, { csrfToken, state: { status: 'ready' } });
        expect(buttons(h).some(b => b.textContent === 'Complete client setup')).toBe(false);
    });
    test.each(['generation', 'binding'])('saved client completion cannot outlive its %s', async changed => {
        const h = await savedAcceptance();
        await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        const staleComplete = buttons(h).find(b => b.textContent === 'Complete client setup');
        expect(staleComplete).toBeDefined();
        h.window.dispatch('focus'); await flush();
        await recheck(h, 4, { ...consultant(), ...(changed === 'generation' ? { generation: GB } : { selectedBindingId: B }) });
        staleComplete.click(); await flush(); expect(h.requests).toHaveLength(8);
    });
    test.each([{}, { status: 'resume_acceptance', receipt: 'caller-supplied' }])
        ('client completion cannot be inferred from an unbound or augmented recovery state %j', async recovery => {
            const augmented = Object.keys(recovery).length > 0;
            const h = augmented ? await savedAcceptance() : await portfolio();
            await h.reply(augmented ? 3 : 2, 200, { csrfToken, state: augmented ? recovery : { status: 'resume_acceptance' } });
            expect(buttons(h).some(b => b.textContent === 'Complete client setup')).toBe(false);
            expect(h.requests).toHaveLength(augmented ? 4 : 3);
        });
    test('interrupted completion survives a same-authority recheck while its abandoned acknowledgement cannot replace the retry', async () => {
        const h = await savedAcceptance();
        await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
        buttons(h).find(b => b.textContent === 'Complete client setup').click(); await flush();
        const original = h.requests[4].init.body;
        h.window.dispatch('focus'); await flush(); await recheck(h, 5);
        buttons(h).find(b => b.textContent === 'Retry previous client setup').click(); await flush();
        expect(h.requests[8].init.body).toBe(original);
        await h.reply(4, 200, { csrfToken, state: { status: 'ready' } });
        expect(buttons(h).some(b => b.textContent === 'Refresh organisations')).toBe(false);
        await h.reply(8, 200, { csrfToken, state: { status: 'ready' } });
        expect(buttons(h).some(b => b.textContent === 'Refresh organisations')).toBe(true);
    });
    test('client setup presents an optional NZBN with an associated accessible description', async () => {
        const h = await portfolio();
        await h.reply(2, 200, { csrfToken, state: { status: 'clients', remaining: 3, clients: [] } });
        buttons(h).find(b => b.textContent === 'Add organisation').click();
        const controls = h.document.getElementById('clientSetupControls');
        const input = controls.querySelectorAll('input').find(node => node.name === 'registrationId');
        expect(input.parentElement.tagName).toBe('LABEL');
        expect(input.parentElement.textContent).toMatch(/^NZBN \(optional\)/);
        expect(input.getAttribute('aria-label')).toBe('NZBN (optional)');
        const help = h.document.getElementById(input.getAttribute('aria-describedby'));
        expect(help).not.toBeNull();
        expect(help.textContent).toBe('The client organisation’s New Zealand Business Number, if it has one.');
        expect(input.type).toBe('text'); expect(input.required).toBe(false); expect(input.maxLength).toBe(160);
        expect(input.getAttribute('pattern')).toBeNull();
        expect(controls.textContent).not.toContain('Company registration number');
        expect(h.requests).toHaveLength(3);
    });
    test('records deliberate client details, retries the same request and requires terms acceptance', async () => {
        const h = await portfolio();
        await h.reply(2, 200, { csrfToken, state: { status: 'clients', remaining: 3, clients: [] } });
        buttons(h).find(b => b.textContent === 'Add organisation').click();
        const form = h.document.getElementById('clientSetupControls').querySelector('form');
        const values = { organisationName: 'Synthetic client', name: 'Synthetic User', role: 'Consultant', address: 'Synthetic address', registrationId: '9429000000000' };
        form.querySelectorAll('input').forEach(input => { if (input.type === 'checkbox') input.checked = true; else input.value = values[input.name]; });
        for (const submit of form.events.submit) submit({ preventDefault() {} }); await flush();
        const original = h.requests[3].init.body;
        expect(JSON.parse(original)).toMatchObject({ action: 'create', organisationName: 'Synthetic client',
            details: { registrationId: values.registrationId, authorityConfirmed: true } });
        expect(h.requests[3].init.headers['X-CSRF-Token']).toBe(csrfToken);
        await h.reply(3, 503, { code: 'starter_signup_unavailable' });
        buttons(h).find(b => b.textContent === 'Retry').click(); await flush();
        expect(h.requests[4].init.body).toBe(original);
        await h.reply(4, 200, { csrfToken, state: { status: 'terms', termsText: 'Synthetic terms', scheduleText: 'Synthetic schedule',
            termsVersion: 'synthetic', termsDigest: GA, scheduleId: 'synthetic-schedule', scheduleDigest: GB } });
        const accept = buttons(h).find(b => b.textContent === 'Accept and create client dashboard');
        accept.click(); await flush(); expect(h.requests).toHaveLength(5);
        h.document.getElementById('clientSetupControls').querySelector('input').checked = true;
        accept.click(); await flush(); await h.reply(5, 200, pendingClient(JSON.parse(original).requestId));
        expect(JSON.parse(h.requests[6].init.body)).toMatchObject({ action: 'accept', requestId: JSON.parse(original).requestId,
            terms: { accepted: true, termsDigest: GA, scheduleDigest: GB } });
        await h.reply(6, 200, { csrfToken, state: { status: 'ready' } });
        expect(buttons(h).some(b => b.textContent === 'Refresh organisations')).toBe(true);
    });
    test('expired consent proof presents customer sign-in instead of an endless retry', async () => {
        const h = await portfolio(); await h.reply(2, 401, { code: 'starter_reauthentication_required' });
        const controls = h.document.getElementById('clientSetupControls');
        expect(controls.querySelector('a').href).toBe('/login?reauthenticate=1');
        expect(controls.textContent).toContain('Sign in again'); expect(buttons(h)).toHaveLength(0);
    });
    test('external consent reauthentication keeps the selected provider', async () => {
        const h = await portfolio({ external: true });
        await h.reply(2, 401, { code: 'starter_reauthentication_required' });
        expect(h.document.getElementById('clientSetupControls').querySelector('a').href).toBe('/api/external-customer-auth/login');
    });
    test.each([
        [undefined, '/login?reauthenticate=1'], ['auto', '/login?reauthenticate=1'], ['invalid', '/login?reauthenticate=1'],
        ['legacy', '/api/customer-auth/login'], ['external', '/api/external-customer-auth/login']
    ])('saved-client reauthentication keeps provider %s through repeated expired reads', async (provider, expected) => {
        const h = await portfolio({ provider });
        await h.reply(2, 401, { code: 'starter_reauthentication_required' });
        expect(h.document.getElementById('clientSetupControls').querySelector('a').href).toBe(expected);
        h.event('focus'); await flush();
        await h.reply(3, 200, consultant()); await h.reply(4, 200, listing([A]));
        await h.reply(5, 200, consultant());
        expect(h.document.getElementById('clientSetupControls').querySelector('a').href).toBe(expected);
        expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
        expect(buttons(h)).toHaveLength(0);
    });
    describe('generated public customer recovery', () => {
        let documents;
        beforeAll(() => {
            execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
            documents = ['app/dashboard.html', 'index.html'].map(file => fs.readFileSync(path.join(__dirname, '../dist', file), 'utf8'));
        });
        test.each([0, 1])('actual static document %s never sends unknown customer recovery directly to workforce auth', async index => {
            const html = documents[index];
            const h = await portfolio({ documentHtml: html, gateway: index === 1 });
            await h.reply(2, 401, { code: 'starter_reauthentication_required' });
            expect(h.document.body.dataset.customerProvider).toBe('auto');
            expect(h.elements.dashboardSignIn.href).toBe('/login');
            expect(h.document.getElementById('clientSetupControls').querySelector('a').href).toBe('/login?reauthenticate=1');
            expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
        });
    });
    const emptyClients = () => ({ csrfToken, state: { status: 'clients', remaining: 3, clients: [] } });
    async function unfinished() {
        const h = await portfolio(); await h.reply(2, 200, emptyClients());
        h.window.crypto.randomUUID.mockImplementation(() => C);
        buttons(h).find(b => b.textContent === 'Add organisation').click();
        const values = { organisationName: 'Unsubmitted client', name: 'Synthetic User', role: 'Consultant', address: 'Synthetic address', registrationId: '' };
        h.document.getElementById('clientSetupControls').querySelectorAll('input').forEach(input => {
            if (input.type === 'checkbox') input.checked = true; else input.value = values[input.name];
        });
        h.window.crypto.randomUUID.mockImplementation(() => B);
        return { h, values };
    }
    async function recheck(h, index, fresh = consultant()) {
        const blocking = h.status !== 'selection';
        await h.reply(index, 200, fresh);
        if (!blocking && (fresh.generation !== GA || fresh.selectedBindingId !== A)) {
            expect(h.document.getElementById('clientSetupControls')).toBeNull();
            await h.reply(index + 1, 200, fresh);
            await h.reply(index + 2, 200, listing([fresh.selectedBindingId]));
            await h.reply(index + 3, 200, emptyClients());
        } else {
            await h.reply(index + 1, 200, listing([fresh.selectedBindingId]));
            await h.reply(index + 2, 200, blocking ? emptyClients() : fresh);
        }
    }
    async function submittedClient() {
        const { h } = await unfinished();
        const form = h.document.getElementById('clientSetupControls').querySelector('form');
        for (const submit of form.events.submit) submit({ preventDefault() {} });
        await flush();
        return { h, original: h.requests[3].init.body };
    }
    async function uncertainClientCommand(kind) {
        if (kind === 'create') { const { h, original } = await submittedClient(); return { h, index: 3, original }; }
        if (kind === 'resume') {
            const h = await savedAcceptance(); return { h, index: 3, original: h.requests[3].init.body };
        }
        const h = await acceptingClient(); await h.reply(4, 200, pendingClient());
        return { h, index: 5, original: h.requests[5].init.body };
    }
    test.each(['create', 'accept', 'resume'])
        ('uncertain client command %s blocks binding selection and sign-out before and after 503', async kind => {
            const { h, index, original } = await uncertainClientCommand(kind);
            const binding = h.elements.dashboardChoices.children[0];
            binding.click(); h.click('dashboardSignOut'); await flush();
            expect(h.requests).toHaveLength(index + 1); // Busy command cannot be replaced.
            await h.reply(index, 503, { code: 'starter_signup_unavailable' });
            binding.click(); h.click('dashboardSignOut'); await flush();
            expect(h.requests).toHaveLength(index + 1);
            expect(h.status).toBe('selection');
            expect(h.elements.dashboardChoices.children[0]).toBe(binding);
            const notice = h.document.getElementById('clientSetupControls').querySelector('.client-workspace-status');
            expect(notice.textContent).toContain('Check and resume saved setup before changing organisation or signing out.');
            expect(h.document.activeElement).toBe(notice);
            const action = buttons(h).find(button => button.textContent ===
                (kind === 'create' ? 'Retry' : 'Check and resume saved setup'));
            expect(action).toBeDefined(); action.click(); await flush();
            expect(h.requests).toHaveLength(index + 2);
            expect(JSON.parse(h.requests[index + 1].init.body)).toEqual(kind === 'create'
                ? JSON.parse(original) : { action: 'resume', requestId: C });
            expect(h.requests.slice(index, index + 2).every(request => request.url === '/api/customer-signup/clients')).toBe(true);
        });
    test('uncertain saved setup blocks More pagination without losing its request', async () => {
        const h = harness({ hash: '#organisations', provider: undefined }); await flush();
        await h.reply(0, 200, consultant()); await h.reply(1, 200, listing([A], A));
        await h.reply(2, 200, pendingClient());
        buttons(h).find(button => button.getAttribute('aria-label') === 'Continue setup: Saved client').click(); await flush();
        const original = h.requests[3].init.body;
        h.click('dashboardMore'); await flush(); expect(h.requests).toHaveLength(4);
        await h.reply(3, 503, { code: 'starter_signup_unavailable' });
        h.click('dashboardMore'); await flush();
        expect(h.requests).toHaveLength(4);
        expect(h.document.getElementById('clientSetupControls').querySelector('.client-workspace-status').textContent)
            .toContain('Check and resume saved setup before changing organisation or signing out.');
        buttons(h).find(button => button.textContent === 'Check and resume saved setup').click(); await flush();
        expect(JSON.parse(h.requests[4].init.body)).toEqual(JSON.parse(original));
        expect(h.requests.filter(request => request.url.includes('afterBindingId'))).toHaveLength(0);
    });
    test.each(['create', 'accept', 'resume'])
        ('late %s result cannot replace same-request recovery or allow binding selection', async kind => {
            const { h, index, original } = await uncertainClientCommand(kind);
            h.event('focus'); await flush(); await recheck(h, index + 1);
            const actionLabel = kind === 'create' ? 'Retry previous client setup' : 'Check and resume saved setup';
            const recovery = buttons(h).find(button => button.textContent === actionLabel);
            expect(recovery).toBeDefined();
            await h.reply(index, 200, { csrfToken, state: { status: 'ready' } });
            h.elements.dashboardChoices.children[0].click(); h.click('dashboardSignOut'); await flush();
            expect(h.requests).toHaveLength(index + 4);
            expect(buttons(h)).toContain(recovery);
            recovery.click(); await flush();
            expect(h.requests[index + 4].init.body).toBe(kind === 'create' ? original : JSON.stringify({ action: 'resume', requestId: C }));
        });
    const fullClients = () => ({ csrfToken, state: { status: 'clients', remaining: 0, clients: [A, B,
        '10000000-0000-4000-8000-000000000004'].map((requestId, index) => ({ requestId,
            organisationName: 'Other tab client ' + index, status: 'ready' })) } });
    test('definitive client rejection reloads capacity consumed by another tab without repeating the create', async () => {
        const { h } = await submittedClient();
        await h.reply(3, 409, { code: 'starter_client_limit' });
        expect(h.requests).toHaveLength(5);
        expect(h.requests[4]).toMatchObject({ url: '/api/customer-signup/clients', init: { method: 'GET' } });
        expect(h.requests[4].init).not.toHaveProperty('body');
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        await h.reply(4, 200, fullClients());
        expect(h.document.getElementById('clientSetupControls').textContent).toContain('No client slots remain.');
        expect(buttons(h).some(b => /Retry|Add client/.test(b.textContent))).toBe(false);
        h.window.dispatch('focus'); await flush();
        await h.reply(5, 200, consultant()); await h.reply(6, 200, listing([A])); await h.reply(7, 200, consultant());
        expect(buttons(h).some(b => /Retry|Add client/.test(b.textContent))).toBe(false);
        expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
    });
    test('definitive client rejection replaces locked details with authoritative resume and fresh terms', async () => {
        const { h } = await submittedClient();
        await h.reply(3, 409, { code: 'starter_details_locked' });
        expect(h.requests[4].init.method).toBe('GET');
        const freshCsrf = 'd'.repeat(43);
        await h.reply(4, 200, { csrfToken: freshCsrf, state: { status: 'clients', remaining: 2,
            clients: [{ requestId: C, organisationName: 'Saved client', status: 'pending' }] } });
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        expect(buttons(h).some(b => /Retry/.test(b.textContent))).toBe(false);
        buttons(h).find(b => (b.getAttribute('aria-label') || b.textContent) === 'Continue setup: Saved client').click(); await flush();
        expect(JSON.parse(h.requests[5].init.body)).toEqual({ action: 'resume', requestId: C });
        expect(h.requests[5].init.headers['X-CSRF-Token']).toBe(freshCsrf);
        await h.reply(5, 200, { csrfToken: freshCsrf, state: { status: 'terms', termsText: 'Current terms', scheduleText: 'Current schedule',
            termsVersion: 'current', termsDigest: GB, scheduleId: 'current-schedule', scheduleDigest: GC } });
        const accept = buttons(h).find(b => b.textContent === 'Accept and create client dashboard');
        accept.click(); await flush(); expect(h.requests).toHaveLength(6);
        h.document.getElementById('clientSetupControls').querySelector('input').checked = true;
        accept.click(); await flush();
        await h.reply(6, 200, pendingClient(C, freshCsrf));
        expect(JSON.parse(h.requests[7].init.body)).toMatchObject({ action: 'accept', requestId: C,
            terms: { accepted: true, termsDigest: GB, scheduleDigest: GC } });
    });
    test.each(['starter_client_limit', 'starter_details_locked'])
        ('definitive client rejection %s retries only the authoritative read after reconciliation fails', async code => {
            const { h } = await submittedClient();
            await h.reply(3, 409, { code });
            expect(h.requests[4].init.method).toBe('GET');
            await h.reply(4, 503, { code: 'starter_signup_unavailable' });
            expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
            expect(h.document.getElementById('clientSetupControls').textContent).toContain('Retry to refresh the list.');
            buttons(h).find(b => b.textContent === 'Retry').click(); await flush();
            expect(h.requests[5].init.method).toBe('GET'); expect(h.requests[5].init).not.toHaveProperty('body');
            await h.reply(5, 200, fullClients());
            expect(buttons(h).some(b => /Retry|Add client/.test(b.textContent))).toBe(false);
            expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
        });
    test.each([401, 403])('definitive client rejection followed by %s cannot restore or repeat rejected details', async status => {
        const { h } = await submittedClient();
        await h.reply(3, 409, { code: 'starter_details_locked' });
        await h.reply(4, status, { code: 'starter_reauthentication_required' });
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        if (status === 401) {
            expect(h.document.getElementById('clientSetupControls').querySelector('a').href).toBe('/login?reauthenticate=1');
            expect(buttons(h)).toHaveLength(0);
        } else {
            buttons(h).find(b => b.textContent === 'Retry').click(); await flush();
            expect(h.requests[5].init.method).toBe('GET');
        }
        expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
    });
    test.each([{ code: 'unknown_conflict' }, {}, { code: 'starter_client_limit', extra: true }])
        ('uncertain client conflict %j retains the original request rather than guessing a denial', async value => {
            const { h, original } = await submittedClient();
            await h.reply(3, 409, value); expect(h.requests).toHaveLength(4);
            buttons(h).find(b => b.textContent === 'Retry').click(); await flush();
            expect(h.requests[4].init.method).toBe('POST'); expect(h.requests[4].init.body).toBe(original);
        });
    test('late definitive client rejection from an abandoned cycle cannot clear the current unresolved request', async () => {
        const { h, original } = await submittedClient();
        h.window.dispatch('focus'); await flush(); await recheck(h, 4);
        await h.reply(3, 409, { code: 'starter_client_limit' });
        expect(h.requests).toHaveLength(7);
        expect(buttons(h).some(b => b.textContent === 'Add organisation')).toBe(false);
        buttons(h).find(b => b.textContent === 'Retry previous client setup').click(); await flush();
        expect(h.requests[7].init.method).toBe('POST'); expect(h.requests[7].init.body).toBe(original);
    });
    test('unfinished client details survive focus and cached return only after fresh authority checks', async () => {
        const { h, values } = await unfinished();
        for (const event of ['focus', 'cached return']) {
            const index = h.requests.length;
            const existing = h.document.getElementById('clientSetupControls');
            if (event === 'focus') h.window.dispatch('focus');
            else { h.event('pagehide'); h.event('pageshow', { persisted: true }); }
            await flush();
            if (event === 'focus') expect(h.document.getElementById('clientSetupControls')).toBe(existing);
            else expect(h.document.getElementById('clientSetupControls')).toBeNull();
            await recheck(h, index);
            const form = h.document.getElementById('clientSetupControls').querySelector('form');
            for (const input of form.querySelectorAll('input')) {
                if (input.type === 'checkbox') expect(input.checked).toBe(true); else expect(input.value).toBe(values[input.name]);
            }
        }
        const form = h.document.getElementById('clientSetupControls').querySelector('form');
        for (const submit of form.events.submit) submit({ preventDefault() {} }); await flush();
        expect(JSON.parse(h.requests.at(-1).init.body)).toMatchObject({ action: 'create', requestId: C, organisationName: values.organisationName,
            details: { name: values.name, role: values.role, address: values.address, registrationId: '', authorityConfirmed: true } });
    });
    test.each(['generation', 'binding'])('unfinished client details are discarded after a changed %s', async changed => {
        const { h } = await unfinished(); h.window.dispatch('focus'); await flush();
        await recheck(h, 3, { ...consultant(), ...(changed === 'generation' ? { generation: GB } : { selectedBindingId: B }) });
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        expect(buttons(h).some(b => b.textContent === 'Add organisation')).toBe(true);
    });
    test.each([401, 403])('unfinished client details are discarded after authoritative denial %s', async status => {
        const { h } = await unfinished(); h.window.dispatch('focus'); await flush();
        await h.reply(3, status, { code: 'dashboard_access_denied' });
        expect(h.document.getElementById('clientSetupControls')).toBeNull();
        h.window.dispatch('focus'); await flush(); await recheck(h, 4);
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
    });
    test('unfinished client details stay visible through uncertain access and retry quietly', async () => {
        const { h, values } = await unfinished(); h.window.dispatch('focus'); await flush();
        await h.reply(3, 503, { code: 'dashboard_unavailable' });
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).not.toBeNull(); expect(h.status).toBe('selection');
        h.click('dashboardRetry'); await flush(); await recheck(h, 4);
        const form = h.document.getElementById('clientSetupControls').querySelector('form');
        expect(form.querySelector('input').value).toBe(values.organisationName);
    });
    test.each(['pending response', '503'])('unfinished client details keep the same command after focus during %s', async outcome => {
        const { h } = await unfinished();
        const form = h.document.getElementById('clientSetupControls').querySelector('form');
        for (const submit of form.events.submit) submit({ preventDefault() {} }); await flush();
        const original = h.requests[3].init.body;
        if (outcome === '503') await h.reply(3, 503, { code: 'starter_signup_unavailable' });
        h.window.dispatch('focus'); await flush(); await recheck(h, 4);
        expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
        expect(buttons(h).some(b => b.textContent === 'Add organisation')).toBe(false);
        buttons(h).find(b => b.textContent === (outcome === '503' ? 'Retry' : 'Retry previous client setup')).click(); await flush();
        expect(h.requests[7].init.body).toBe(original);
        const terms = { csrfToken, state: { status: 'terms', termsText: 'Synthetic terms', scheduleText: 'Synthetic schedule',
            termsVersion: 'synthetic', termsDigest: GA, scheduleId: 'synthetic-schedule', scheduleDigest: GB } };
        if (outcome === 'pending response') {
            await h.reply(3, 200, terms);
            expect(buttons(h).some(b => b.textContent === 'Accept and create client dashboard')).toBe(false);
        }
        await h.reply(7, 200, terms);
        h.document.getElementById('clientSetupControls').querySelector('input').checked = true;
        buttons(h).find(b => b.textContent === 'Accept and create client dashboard').click(); await flush();
        await h.reply(8, 200, pendingClient());
        expect(JSON.parse(h.requests[9].init.body)).toMatchObject({ action: 'accept', requestId: C });
    });
    test.each([['form', 'focus'], ['form', 'cached return'], ['pending', 'focus'], ['pending', 'cached return']])
        ('unfinished client details survive repeated revalidation of %s through %s', async (stage, event) => {
            const { h, values } = await unfinished(); let original;
            if (stage === 'pending') {
                const form = h.document.getElementById('clientSetupControls').querySelector('form');
                for (const submit of form.events.submit) submit({ preventDefault() {} }); await flush();
                original = h.requests[3].init.body;
            }
            const first = h.requests.length; h.window.dispatch('focus'); await flush();
            if (stage === 'pending') expect(h.requests[first - 1].init.signal.aborted).toBe(true);
            await recheck(h, first);
            const second = h.requests.length;
            if (event === 'focus') h.window.dispatch('focus');
            else { h.event('pagehide'); h.event('pageshow', { persisted: true }); }
            await flush(); await recheck(h, second);
            const form = h.document.getElementById('clientSetupControls').querySelector('form');
            if (stage === 'pending') {
                expect(form).toBeNull();
                expect(buttons(h).some(b => b.textContent === 'Add organisation')).toBe(false);
                buttons(h).find(b => b.textContent === 'Retry previous client setup').click(); await flush();
                expect(h.requests.at(-1).init.body).toBe(original);
            } else {
                expect(form.querySelector('input').value).toBe(values.organisationName);
                for (const submit of form.events.submit) submit({ preventDefault() {} }); await flush();
                expect(JSON.parse(h.requests.at(-1).init.body).requestId).toBe(C);
            }
        });
});

describe('internal dashboard loader protocol', () => {
    test('renders an admitted customer with the genuine shell and fresh customer session', async () => {
        const h = harness(); await flush();
        await h.open(state(A, GA, { purpose: 'customer' }), 'Customer organisation');
        expect(h.status).toBe('ready');
        expect(h.mounts).toHaveLength(1);
        expect(h.mounts[0].model.context.displayName).toBe('Customer organisation');
        expect(h.elements.dashboardApp.textContent).toContain('Customer organisation');
    });

    test('entry and genuine shell keep one top-level main landmark through ready, expiry and failed mount', async () => {
        const h = harness(); await flush();
        const landmarks = () => [...h.document.body.querySelectorAll('main'), ...h.document.body.querySelectorAll('[role="main"]')];
        expect(landmarks()).toHaveLength(1);
        await h.open(state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        expect(landmarks()).toHaveLength(1);
        expect(landmarks()[0].className).toContain('dashboard-main');
        expect(h.elements.dashboardEntry.getAttribute('role')).toBeNull();
        jest.advanceTimersByTime(2000); await flush();
        expect(h.status).toBe('expired');
        expect(landmarks()).toEqual([h.elements.dashboardEntry]);
        h.factory.mount.mockImplementation(() => { throw new Error('Synthetic mount failure'); });
        h.window.dispatch('focus'); await flush(); await h.open(state(B, GB), 'Current B', 4);
        expect(h.status).toBe('unavailable');
        expect(landmarks()).toEqual([h.elements.dashboardEntry]);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
    });

    test('begins read-only and mounts only after bootstrap, both fixed native assets and a fresh session', async () => {
        const h = harness(); await flush();
        expect(h.requests.map(r => r.url)).toEqual(['/api/dashboard/session']);
        await h.reply(0, 200, state());
        await h.reply(1, 200, listing());
        expect(h.native).toHaveLength(0);
        expect(h.requests[2].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        await h.reply(2, 200, projection());
        expect(h.native.map(n => n.src || n.href)).toEqual(['/api/dashboard/app.js', '/api/dashboard/dashboard.css']);
        for (const node of h.native) {
            expect(node.integrity).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
            expect(node.crossOrigin).toBe('anonymous');
        }
        h.load(0); await flush(); expect(h.mounts).toHaveLength(0);
        h.load(1); await flush(); expect(h.mounts).toHaveLength(0);
        await h.reply(3, 200, state());
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
        expect(h.mounts[0].model.admissionGranted).toBe(false);
        expect(h.mounts[0].model.providerAccessGranted).toBe(false);
        expect(h.mounts[0].model.modules.find(m => m.key === 'cyber_security').state).toBe('planned');
        expect(h.mounts[0].config.mountCyber).toBeUndefined();
        for (const request of h.requests) {
            expect(request.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
            expect(request.init).not.toHaveProperty('body');
            expect(request.init.headers).not.toHaveProperty('Content-Type');
        }
    });

    test('requires an explicit choice even for one organisation and sends the frozen command then rereads authority', async () => {
        const h = harness(); await flush();
        await h.reply(0, 200, state(null)); await h.reply(1, 200, listing([A]));
        expect(h.status).toBe('selection'); expect(h.native).toHaveLength(0); expect(h.requests).toHaveLength(2);
        h.elements.dashboardChoices.children[0].click(); await flush();
        const command = JSON.parse(h.requests[2].init.body);
        expect(command).toEqual({ bindingId: A, expectedGeneration: GA, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
        expect(h.requests[2].init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
        await h.reply(2, 200, { schemaVersion: 1, generation: GB, selectedBindingId: A });
        expect(h.requests[3].url).toBe('/api/dashboard/session');
        await h.open(state(B, GC), 'Newer server choice', 3);
        expect(h.requests[5].init.headers['X-NoFries-Dashboard-Generation']).toBe(GC);
        expect(h.mounts[0].model.context.displayName).toBe('Newer server choice');
    });

    test('only the exact initialization signal permits one automatic command and a fresh read', async () => {
        const h = harness(); await flush();
        await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests[1].url).toBe('/api/dashboard/session');
        expect(Object.keys(JSON.parse(h.requests[1].init.body))).toEqual(['operationId']);
        await h.reply(1, 200, { schemaVersion: 1, initialized: true });
        await h.reply(2, 409, { code: 'dashboard_initialization_required' });
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(3);
    });

    test('accepts the actual host canonical UUID shape without inventing version restrictions', async () => {
        const binding = '00000000-0000-0000-0000-000000000001';
        const h = harness(); await flush(); await h.reply(0, 200, state(binding));
        await h.reply(1, 200, listing([binding])); await h.reply(2, 200, projection());
        h.load(0); h.load(1); await flush(); await h.reply(3, 200, state(binding));
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
    });

    test.each([
        { generation: [GB], selectedBindingId: A },
        { generation: GB, selectedBindingId: [A] },
        { generation: GB, selectedBindingId: B }
    ])('rejects coerced or wrong-command selection acknowledgement %j and retains its original command', async ack => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, listing());
        h.elements.dashboardChoices.children[0].click(); await flush(); const body = h.requests[2].init.body;
        await h.reply(2, 200, { schemaVersion: 1, ...ack });
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(3);
        h.click('dashboardRetry'); await flush(); expect(h.requests[3].init.body).toBe(body);
    });

    test.each([
        { ...listing([A]), bindings: [{ bindingId: [A], organisationLabel: 'Array identifier' }] },
        { ...listing([A]), bindings: [{ bindingId: { value: A }, organisationLabel: 'Object identifier' }] },
        { ...listing([A]), nextAfterBindingId: [A] }
    ])('rejects coerced directory identifier or cursor %j', async page => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, page);
        expect(h.status).toBe('unavailable'); expect(h.elements.dashboardChoices.children).toHaveLength(0);
    });

    test.each([{ code: 'dashboard_session_initialization_required' }, { code: 'dashboard_initialization_required', extra: true },
        { code: 'dashboard_revoked' }, {}])('does not initialize unknown or non-closed 409 %j', async body => {
        const h = harness(); await flush(); await h.reply(0, 409, body);
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1); expect(h.native).toHaveLength(0);
    });

    test.each([401, 403, 410, 503])('shows fixed safe state for HTTP %s without initializing or redirect loops', async status => {
        const h = harness(); await flush(); await h.reply(0, status, { code: 'private_subject', error: '<private provider record>' });
        expect(h.status).toBe(status === 401 ? 'unauthenticated' : status === 403 ? 'denied' : 'unavailable');
        expect(h.elements.dashboardStatus.textContent).not.toMatch(/private|provider/);
        expect(h.requests).toHaveLength(1); expect(h.window.location.assign).not.toHaveBeenCalled();
    });

    test.each([
        { authenticated: false }, { purpose: 'customer_dashboard' }, { generation: 'A'.repeat(64) },
        { generation: null }, { selectedBindingId: 'not-a-uuid' }, { expiresAt: '2026-09-09T00:30:00Z' },
        { expiresAt: '+010000-01-01T00:00:00.000Z' }, { expiresAt: '0000-01-01T00:00:00.000Z' },
        { schemaVersion: 2 }, { extra: true }
    ])('rejects a malformed closed session %j', async extra => {
        const h = harness(); await flush(); await h.reply(0, 200, state(A, GA, extra));
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1);
    });

    test.each([
        { redirected: true }, { type: 'opaque' }, { type: 'opaqueredirect' },
        { headers: { get: () => 'text/html' } }, { headers: { get: () => 'application/jsonp' } },
        { json: async () => { throw new Error('invalid JSON'); } }
    ])('rejects unsafe JSON response transport %j', async extra => {
        const h = harness(); await flush(); await h.reply(0, 200, state(), extra);
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1);
    });

    test('uses only returned ascending UUID cursors and keeps an existing selection outside page one', async () => {
        const h = harness(); await flush();
        await h.reply(0, 200, state(C)); await h.reply(1, 200, listing([A], A));
        await h.reply(2, 200, projection()); h.load(0); h.load(1); await flush(); await h.reply(3, 200, state(C));
        expect(h.status).toBe('ready'); expect(h.requests.every(r => r.init.method === 'GET')).toBe(true);
        h.click('dashboardMore'); await flush();
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests[4].url).toBe('/api/dashboard/organisations?limit=50&afterBindingId=' + A);
        await h.reply(4, 200, listing([B, C]));
        expect(h.elements.dashboardChoices.children.map(n => n.textContent)).toEqual(['Organisation 1', 'Organisation 2', 'Organisation 3']);
        expect(h.elements.dashboardMore.hidden).toBe(true);
        expect(h.window.location.hash).toBe('');
    });

    test.each([
        listing([B, A]), listing([A, A]), listing([], A), listing([A], B),
        { ...listing(), bindings: [{ bindingId: A, organisationLabel: '' }] },
        { ...listing(), bindings: [{ bindingId: A, organisationLabel: 'x'.repeat(201) }] },
        { ...listing(), bindings: [{ bindingId: A, organisationLabel: 'Name\u0000secret' }] },
        { ...listing(), bindings: [{ bindingId: A, organisationLabel: 'Valid', tenantId: 'extra' }] },
        { ...listing(), nextAfterBindingId: 'https://bad.example' }
    ])('rejects malformed or repeating directory data %j', async body => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, body);
        expect(h.status).toBe('unavailable'); expect(h.elements.dashboardChoices.children).toHaveLength(0); expect(h.native).toHaveLength(0);
    });

    test('rejects a non-advancing subsequent page without retaining old organisation labels', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, listing([A], A));
        h.click('dashboardMore'); await flush(); await h.reply(2, 200, listing([A], A));
        expect(h.status).toBe('unavailable'); expect(h.elements.dashboardChoices.children).toHaveLength(0);
    });

    test('keeps labels as text and never lets them choose URLs or selectors', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null));
        await h.reply(1, 200, { ...listing([A]), bindings: [{ bindingId: A, organisationLabel: '<script>synthetic only</script>' }] });
        const button = h.elements.dashboardChoices.children[0];
        expect(button.textContent).toBe('<script>synthetic only</script>'); expect(button.children).toHaveLength(0);
        expect(h.requests.map(r => r.url)).toEqual(['/api/dashboard/session', '/api/dashboard/organisations?limit=50']);
    });

    test.each(['initialization', 'selection'])('retains exact %s command after a timeout; focus does not submit a competing mutation', async kind => {
        const h = harness(); await flush(); let index;
        if (kind === 'initialization') { await h.reply(0, 409, { code: 'dashboard_initialization_required' }); index = 1; }
        else {
            await h.reply(0, 200, state(null)); await h.reply(1, 200, listing());
            h.elements.dashboardChoices.children[0].click(); await flush(); index = 2;
        }
        const original = h.requests[index].init.body;
        jest.advanceTimersByTime(12000); await flush();
        expect(h.status).toBe('unavailable'); expect(h.requests[index].init.signal.aborted).toBe(true);
        h.window.dispatch('focus'); await flush();
        expect(h.requests).toHaveLength(index + 1); expect(h.elements.dashboardSignOut.hidden).toBe(true);
        h.click('dashboardRetry'); await flush();
        expect(h.requests[index + 1].init.body).toBe(original);
        expect(h.window.crypto.randomUUID).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardStatus.textContent).not.toMatch(/cancelled|rolled back|not submitted/i);
    });

    test.each([true, false])('requires secure UUID generation for initialization/selection (initial=%s)', async initial => {
        const h = harness({ noCrypto: true }); await flush();
        if (initial) await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        else { await h.reply(0, 200, state(null)); await h.reply(1, 200, listing()); h.elements.dashboardChoices.children[0].click(); await flush(); }
        expect(h.status).toBe('unavailable'); expect(h.requests.some(r => r.init.method === 'POST')).toBe(false);
    });

    test('drops an acknowledged old receipt when current authority has changed and bounds repeated reconciliation', async () => {
        const h = harness(); await flush();
        for (let round = 0; round < 3; round += 1) {
            const i = round * 4;
            await h.reply(i, 200, state(A, GA)); await h.reply(i + 1, 200, listing()); await h.reply(i + 2, 200, projection('Obsolete'));
            h.load(round * 2); h.load(round * 2 + 1); await flush(); await h.reply(i + 3, 200, state(B, GB));
        }
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(12); expect(h.mounts).toHaveLength(0);
    });

    test.each(registry.modules.map(m => '#' + m.route))('keeps only an exact known sign-in route %s', async hash => {
        const h = harness({ hash }); await flush();
        expect(h.elements.dashboardSignIn.href).toBe('/api/auth/login?returnTo=' + encodeURIComponent('/dashboard' + hash));
    });

    test.each(['#' + A, '#services?tenant=' + A, '#unknown', '#/services', '#services/child'])('discards unsafe sign-in navigation %s', async hash => {
        const h = harness({ hash }); await flush(); expect(h.elements.dashboardSignIn.href).toBe('/api/auth/login?returnTo=%2Fdashboard');
    });
});

describe('dashboard asynchronous ownership and sign-out', () => {
    test.each([
        [undefined, '/login'], ['auto', '/login'], ['unexpected', '/login'],
        ['legacy', '/login?provider=legacy'], ['external', '/login?provider=external'],
        ['staff', '/api/auth/login?returnTo=%2Fdashboard%23overview']
    ])('provider %s retains the correct entry after initial and returning session expiry', async (provider, expected) => {
        const h = harness({ provider, hash: '#overview' }); await flush();
        await h.reply(0, 401, { code: 'authentication_required' });
        expect(h.elements.dashboardSignIn.href).toBe(expected);
        h.click('dashboardRetry'); await flush(); await h.open();
        h.event('focus'); await flush(); await h.reply(5, 401, { code: 'authentication_required' });
        expect(h.status).toBe('expired'); expect(h.elements.dashboardApp.hidden).toBe(true);
        expect(h.elements.dashboardSignIn.href).toBe(expected);
        expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
    });
    test('external expired sessions and completed logout return to the external entry', async () => {
        const h = harness({ external: true }); await flush();
        expect(h.elements.dashboardSignIn.href).toBe('/login?provider=external');
        await h.open(); h.click('dashboardSignOut'); await flush();
        await h.reply(4, 200, { schemaVersion: 1, loggedOut: true });
        expect(h.window.location.assign).toHaveBeenCalledWith('/login?provider=external');
    });
    test.each(['focus', 'persisted page restoration', 'organisation selection'])('preserves the navigated view after %s revalidation', async trigger => {
        const h = harness({ hash: '#overview' }); await flush(); await h.open();
        h.elements.dashboardApp.querySelectorAll('a').find(link => link.href === '#services').click();
        expect(h.window.location.hash).toBe('#services');
        expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Services');
        let next = state();
        if (trigger === 'organisation selection') {
            h.elements.dashboardChoices.children[1].click(); await flush();
            expect(JSON.parse(h.requests[4].init.body)).toMatchObject({ bindingId: B, expectedGeneration: GA });
            await h.reply(4, 200, { schemaVersion: 1, generation: GB, selectedBindingId: B });
            next = state(B, GB);
        } else if (trigger === 'persisted page restoration') {
            h.window.dispatch('pagehide'); h.event('pageshow', { persisted: true }); await flush();
        } else {
            h.window.dispatch('focus'); await flush();
            expect(h.mounts[0].destroy).not.toHaveBeenCalled();
            await h.reply(4, 200, next); await h.reply(5, 200, listing());
            await h.reply(6, 200, projection('Changed display requires fresh mount'));
        }
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        const first = h.requests.length - 1;
        expect(h.requests[first].url).toBe('/api/dashboard/session');
        await h.open(next, 'Fresh authorised organisation', first);
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(2);
        expect(h.window.location.hash).toBe('#services');
        expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Services');
        expect(h.elements.dashboardApp.textContent).toContain('Fresh authorised organisation');
    });

    test('uses navigation changed while the final fresh session read is pending', async () => {
        const h = harness({ hash: '#overview' }); await flush();
        await h.reply(0, 200, state()); await h.reply(1, 200, listing()); await h.reply(2, 200, projection());
        h.load(0); h.load(1); await flush();
        expect(h.requests[3].url).toBe('/api/dashboard/session'); expect(h.mounts).toHaveLength(0);
        h.window.location.hash = '#services';
        await h.reply(3, 200, state());
        expect(h.status).toBe('ready');
        expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Services');
        expect(h.window.location.hash).toBe('#services');
    });

    test.each(['#' + A, '#services?tenant=' + A, '#unknown', '#/services', '#services/child'])('falls back safely when the route changes to %s before remount', async hash => {
        const h = harness({ hash: '#services' }); await flush(); await h.open();
        expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Services');
        h.window.location.hash = hash; h.window.dispatch('focus'); await flush();
        await h.reply(4, 200, state()); await h.reply(5, 200, listing());
        await h.reply(6, 200, projection('Changed display requires fresh mount'));
        await h.open(state(), 'Fresh authorised organisation', 7);
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(2);
        expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Overview');
        expect(h.elements.dashboardApp.textContent).not.toContain(hash);
        expect(h.requests.every(request => !request.url.includes(hash.slice(1)))).toBe(true);
    });

    test('a held selection acknowledgement cannot reconcile after focus replacement, and retry preserves the original command', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, listing());
        const oldButton = h.elements.dashboardChoices.children[0];
        oldButton.click(); oldButton.click(); await flush();
        const original = h.requests[2]; expect(h.requests).toHaveLength(3);
        h.window.dispatch('focus'); await flush();
        original.resolve(response(200, { schemaVersion: 1, generation: GB, selectedBindingId: A })); await flush();
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(3); expect(h.mounts).toHaveLength(0);
        h.click('dashboardRetry'); await flush(); expect(h.requests[3].init.body).toBe(original.init.body);
        await h.reply(3, 200, { schemaVersion: 1, generation: GB, selectedBindingId: A });
        await h.open(state(B, GC), 'Newer selection after original commit', 4);
        expect(h.mounts[0].model.context.displayName).toBe('Newer selection after original commit');
        expect(h.requests[6].init.headers['X-NoFries-Dashboard-Generation']).toBe(GC);
    });

    test('an obsolete chooser click cannot issue a command after A to B to A cycles', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state(null)); await h.reply(1, 200, listing());
        const obsolete = h.elements.dashboardChoices.children[0];
        h.window.dispatch('focus'); await flush(); await h.reply(2, 200, state(B, GB));
        await h.open(state(B, GB), 'B', 3);
        h.window.dispatch('focus'); await flush(); await h.reply(7, 200, state(A, GA));
        await h.open(state(A, GA), 'A again', 8);
        obsolete.click(); await flush();
        expect(h.requests).toHaveLength(12); expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
        expect(h.elements.dashboardApp.textContent).toContain('A again');
    });

    test('a valid body that arrives after the request deadline cannot revive a failed cycle', async () => {
        const h = harness(); await flush();
        const body = deferred(); await h.reply(0, 200, null, { json: () => body.promise });
        jest.advanceTimersByTime(12000); await flush(); expect(h.status).toBe('unavailable');
        body.resolve(state()); await flush(); expect(h.requests).toHaveLength(1); expect(h.status).toBe('unavailable');
        expect(h.elements.dashboardApp.children).toHaveLength(0);
    });

    test.each(['directory', 'bootstrap'])('old %s completion cannot render after A to B to A replacement', async stage => {
        const h = harness(); await flush(); await h.reply(0, 200, state());
        if (stage === 'bootstrap') await h.reply(1, 200, listing());
        const old = h.requests[h.requests.length - 1];
        h.window.dispatch('pagehide'); h.event('pageshow', { persisted: true }); await flush();
        const b = h.requests.length - 1; await h.open(state(B, GB), 'B current', b);
        h.window.dispatch('focus'); await flush(); const a = h.requests.length - 1;
        await h.reply(a, 200, state(A, GA)); await h.open(state(A, GA), 'A current again', a + 1);
        const focus = h.document.activeElement;
        old.resolve(response(200, stage === 'directory' ? listing([C]) : projection('Obsolete A'))); await flush();
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(2);
        expect(h.elements.dashboardApp.textContent).toContain('A current again'); expect(h.elements.dashboardApp.textContent).not.toContain('Obsolete');
        expect(h.document.activeElement).toBe(focus); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1); expect(h.mounts[1].destroy).not.toHaveBeenCalled();
    });

    test.each(['load', 'error', 'timeout'])('old native %s callbacks cannot mount, fail or clean up a newer cycle', async kind => {
        const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, listing()); await h.reply(2, 200, projection('Old'));
        const callbacks = h.native.slice().map(node => ({ load: node.onload, error: node.onerror }));
        h.window.dispatch('pagehide'); h.event('pageshow', { persisted: true }); await flush();
        await h.open(state(B, GB), 'B current', 3);
        h.window.dispatch('focus'); await flush(); await h.reply(7, 200, state(A, GA));
        await h.open(state(A, GA), 'A current again', 8);
        if (kind === 'timeout') jest.advanceTimersByTime(12000);
        else callbacks.forEach(callback => callback[kind]());
        await flush();
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(2);
        expect(h.elements.dashboardApp.textContent).toContain('A current again'); expect(h.mounts[1].destroy).not.toHaveBeenCalled();
        expect(h.document.head.children).toHaveLength(2);
    });

    test('a stale error and delayed focus revalidation cannot erase or focus over a current mount', async () => {
        const h = harness(); await flush(); await h.open();
        h.window.dispatch('focus'); await flush(); const old = h.requests[4];
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.window.dispatch('pagehide'); h.event('pageshow', { persisted: true }); await flush();
        await h.open(state(B, GB), 'Fresh B', 5);
        const focus = h.document.activeElement;
        old.reject(new Error('sensitive provider detail')); await flush();
        expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.textContent).toContain('Fresh B'); expect(h.document.activeElement).toBe(focus);
    });

    test('expiry clears a mounted view and a later 401 is shown as expired', async () => {
        const h = harness(); await flush(); await h.open(state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        jest.advanceTimersByTime(2000); await flush(); expect(h.status).toBe('expired');
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        h.window.dispatch('focus'); await flush(); await h.reply(4, 401, { code: 'authentication_required' });
        expect(h.status).toBe('expired'); expect(h.elements.dashboardSignIn.hidden).toBe(false);
    });

    test('pagehide destroys the view and persisted page restoration starts a fresh authority check', async () => {
        const h = harness(); await flush(); await h.open(); h.window.dispatch('pagehide');
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        h.event('pageshow', { persisted: true }); await flush(); expect(h.requests[4].url).toBe('/api/dashboard/session');
        await h.reply(4, 403, { code: 'access_denied' }); expect(h.status).toBe('denied'); expect(h.elements.dashboardApp.hidden).toBe(true);
    });

    test.each(['script', 'style', 'factory', 'integrity'])('keeps the mount empty after native %s failure', async kind => {
        const h = harness({ noFactory: kind === 'factory' }); await flush();
        if (kind === 'integrity') h.elements.dashboardStyleIntegrity.setAttribute('content', 'sha256-invalid');
        await h.reply(0, 200, state()); await h.reply(1, 200, listing()); await h.reply(2, 200, projection());
        if (kind !== 'integrity') { h.load(0, kind === 'script'); h.load(1, kind === 'style'); await flush(); }
        expect(h.status).toBe('unavailable'); expect(h.mounts).toHaveLength(0); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });

    test('requires protected composition metadata before mounting ready Cyber', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = JSON.parse(JSON.stringify(projection())); model.modules.find(m => m.key === 'cyber_security').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        expect(h.requests[3].url).toBe('/api/dashboard/modules/cyber_security');
        await h.reply(3, 404, { code: 'dashboard_not_found' });
        expect(h.factory.validate).toHaveBeenCalledTimes(1); expect(h.mounts).toHaveLength(0); expect(h.status).toBe('unavailable');
    });

    test('preserves a genuine disabled Cyber projection while mounting its ready Overview', async () => {
        const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = projectDashboard(fixture({ now: NOW, enabled: { cyber_security: false } }));
        expect(model.modules.find(m => m.key === 'cyber_security').state).toBe('disabled');
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush(); await h.reply(3, 200, state());
        expect(h.status).toBe('ready'); expect(h.mounts[0].model.modules.find(m => m.key === 'cyber_security').state).toBe('disabled');
        expect(h.mounts[0].config).not.toHaveProperty('mountCyber');
    });

    test('sign-out clears immediately, retains uncertainty and navigates only after a valid acknowledgement', async () => {
        const h = harness(); await flush(); await h.open(); h.click('dashboardSignOut'); await flush();
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests[4].url).toBe('/api/dashboard/logout'); expect(h.requests[4].init.body).toBe('{}');
        await h.reply(4, 503, { code: 'dashboard_outcome_ambiguous' });
        expect(h.status).toBe('signout'); expect(h.window.location.assign).not.toHaveBeenCalled();
        h.click('dashboardRetry'); await flush(); expect(h.requests[5].init.body).toBe('{}');
        await h.reply(5, 200, { schemaVersion: 1, loggedOut: true });
        expect(h.window.location.assign).toHaveBeenCalledWith('/'); expect(h.mounts).toHaveLength(1);
    });

    test('a malformed sign-out acknowledgement never announces success and a genuine 401 shows expired', async () => {
        const h = harness(); await flush(); await h.open(); h.click('dashboardSignOut'); await flush();
        await h.reply(4, 200, { schemaVersion: 1, loggedOut: true, extra: true });
        expect(h.status).toBe('signout'); expect(h.window.location.assign).not.toHaveBeenCalled();
        h.click('dashboardRetry'); await flush(); await h.reply(5, 401, { code: 'authentication_required' });
        expect(h.status).toBe('expired'); expect(h.window.location.assign).not.toHaveBeenCalled();
    });
});


describe('ready Cyber composition', () => {
    async function ready(h, mode = 'editable') {
        await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = JSON.parse(JSON.stringify(projection())); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        expect(h.requests[3].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        h.cyberProjection = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt, module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] }, services: [], admissionGranted: false, providerAccessGranted: false, metadata: createNcscQuestionnaireMetadata(), presentationMode: mode };
        await h.reply(3, 200, h.cyberProjection);
        await h.reply(4, 200, state());
    }
    async function refreshToModule(h, first) {
        await h.reply(first, 200, state()); await h.reply(first + 1, 200, listing());
        await h.reply(first + 2, 200, h.mounts[0].model);
        expect(h.requests[first + 3].url).toBe('/api/dashboard/modules/cyber_security');
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
    }
    async function refresh(h, first) {
        await refreshToModule(h, first); await h.reply(first + 3, 200, h.cyberProjection);
        expect(h.requests[first + 4].url).toBe('/api/dashboard/session');
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        await h.reply(first + 4, 200, state());
    }
    test.each([
        ['generation changed', 200, state(B, GB), 'loading'],
        ['revoked', 403, { code: 'dashboard_access_denied' }, 'denied'],
        ['signed out', 401, { code: 'authentication_required' }, 'expired'],
        ['expired', 200, state(A, GA, { expiresAt: NOW }), 'expired']
    ])('the final Cyber session check clears a retained draft when access is %s', async (_name, status, final, expected) => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        for (let index = 0; index < 10; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(7);
        await refreshToModule(h, 6); await h.reply(9, 200, h.cyberProjection);
        expect(h.requests[10].url).toBe('/api/dashboard/session');
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        await h.reply(10, status, final);
        expect(h.status).toBe(expected); expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
    });
    test('connects the genuine organisation picture on Overview through the selected generation', async () => {
        const h = harness({ cyber: true, picture: true, hash: '#overview' }); await ready(h);
        expect(h.mounts[0].config.mountPicture).toEqual(expect.any(Function));
        expect(h.requests[5].url).toMatch(/^\/api\/dashboard\/ncsc\/assessments/);
        expect(h.requests[5].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(h.requests[5].init.credentials).toBe('same-origin');
        const empty = { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null };
        await h.reply(5, 200, empty, { text: async () => JSON.stringify(empty) });
        expect(h.elements.dashboardApp.textContent).toContain('No saved assessments yet');
        h.window.dispatch('pagehide');
        expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    test.each([200, 403])('Overview continues its exact saved record through a fresh generation-bound read (%s), without another list or write', async status => {
        const stored = await records();
        stored.execute(createCommand('assessment-direct', 'seed-direct', 'Synthetic Overview selected scope.'));
        const h = harness({ cyber: true, picture: true, hash: '#overview' }); await ready(h);
        await ncscReply(h, 5, 200, stored.list());
        await ncscReply(h, 6, 200, stored.read('assessment-direct'));
        expect(h.ncscMounts).toHaveLength(0);
        control(h, 'Continue saved assessment').click(); await flush();
        expect(h.requests).toHaveLength(8);
        expect(h.requests[7].url).toBe('/api/dashboard/ncsc/assessments/assessment-direct');
        expect(h.requests[7].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(h.ncscMounts[0][1]).toMatchObject({ initialAssessmentId: 'assessment-direct',
            organisationId: h.cyberProjection.context.organisationId });
        await ncscReply(h, 7, status, status === 200 ? stored.read('assessment-direct') : { code: 'ncsc_access_denied' });
        if (status === 200) {
            expect(h.elements.dashboardApp.textContent).toContain('Synthetic Overview selected scope.');
            expect(h.elements.dashboardApp.querySelector('.ncsc-question-index')).not.toBeNull();
        } else {
            expect(h.status).toBe('denied'); expect(h.elements.dashboardApp.children).toHaveLength(0);
        }
        expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
        expect(stored.versions.size).toBe(1);
        h.window.dispatch('pagehide');
    });
    test('Board Reports retains its existing module view without loading assessment records', async () => {
        const h = harness({ cyber: true, picture: true, hash: '#board-reports' }); await ready(h);
        expect(h.requests).toHaveLength(5);
        expect(h.elements.dashboardApp.querySelector('.organisation-picture')).toBeNull();
        expect(h.elements.dashboardApp.textContent).not.toContain('Draft assessment snapshot');
        h.window.dispatch('pagehide');
    });
    test('denied overview record access clears the full selected organisation view', async () => {
        const h = harness({ cyber: true, picture: true, hash: '#overview' }); await ready(h);
        await h.reply(5, 403, { code: 'ncsc_access_denied' });
        expect(h.status).toBe('denied'); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    const control = (h, label) => h.elements.dashboardApp.querySelectorAll('button').find(button => button.textContent === label);
    function inputEvent(input, event = 'input') { for (const callback of input.events[event] || []) callback(); }
    function unsavedScope(h) {
        control(h, 'Start an assessment').click();
        const input = h.elements.dashboardApp.querySelector('textarea'); input.value = 'Synthetic unsaved scope';
        inputEvent(input); input.focus(); return input;
    }
    async function ncscReply(h, index, status, value) {
        await h.reply(index, status, value, { headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null }, text: async () => JSON.stringify(value) });
    }
    // Keep synthetic durable state separate from the browser draft. Genuine
    // domain transitions and DTO projection supply acknowledgements; this does
    // not establish PostgreSQL durability or exercise a deployed customer.
    async function records() {
        const source = ncscFixture({ now: NOW, organisationId: 'synthetic-workshop' });
        const context = await createContext(source.scope, createClock(NOW));
        const versions = new Map();
        return { versions,
            execute(input) {
                const command = normaliseNcscCommand(input);
                const version = makeVersion(stableIntent(context, command), command.idempotencyKey,
                    versions.get(command.assessmentId) || null, source.state.tenantAggregate, NOW);
                versions.set(command.assessmentId, version);
                return { schemaVersion: 1, action: command.action, assessment: projectNcscDetail(version) };
            },
            command(request) {
                const body = JSON.parse(request.init.body);
                const parts = request.url.split('/');
                return parts.at(-1) === 'assessments' ? { ...body, action: 'create' }
                    : { ...body, assessmentId: decodeURIComponent(parts.at(-2)), action: parts.at(-1) };
            },
            list() { return { schemaVersion: 1, assessments: [...versions.values()].map(projectNcscSummary), nextAfterAssessmentId: null }; },
            read(id) { return { schemaVersion: 1, assessment: projectNcscDetail(versions.get(id)) }; }
        };
    }
    async function openedRecord(h, stored) {
        await ready(h); await ncscReply(h, 5, 200, stored.list());
        const row = h.elements.dashboardApp.querySelector('.ncsc-assessment-list').querySelector('button');
        row.click(); await flush(); await ncscReply(h, 6, 200, stored.read('assessment-home'));
    }
    function selectAnswer(h, option = 'no') {
        const input = h.elements.dashboardApp.querySelectorAll('input').find(item => item.type === 'radio' && item.value === option);
        input.checked = true; inputEvent(input, 'change');
    }
    const footerTargets = [
        [false, 0, '/roadmap.html'], [false, 1, 'https://news.nofries.nz/'],
        [true, 0, 'https://news.nofries.nz/'], [true, 1, '/roadmap.html'],
        [true, 2, '/privacy.html'], [true, 3, '/terms.html']
    ];
    test.each(footerTargets)('footer gateway=%s link=%s preserves draft, focus and first destination %s', async (gateway, index, target) => {
        const h = harness({ gateway, cyber: true, hash: '#cyber-security' }); await ready(h);
        const input = unsavedScope(h), link = h.footerLinks[index];
        expect(link.href).toBe(target);
        for (const cancel of ['Stay here', 'Escape']) {
            link.focus(); expect(h.linkClick(link, { detail: 0 }).defaultPrevented).toBe(true);
            const dialog = h.elements.dashboardApp.querySelector('dialog'); expect(dialog).not.toBeNull();
            if (cancel === 'Stay here') control(h, cancel).click();
            else for (const callback of dialog.events.keydown) callback({ key: 'Escape', preventDefault() {} });
            await flush();
            expect(h.document.activeElement).toBe(h.elements.dashboardApp.querySelector('h2'));
            expect(h.document.activeElement.tabIndex).toBe(-1); expect(input.value).toBe('Synthetic unsaved scope');
            expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
            expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        }
        h.linkClick(link);
        const discard = control(h, 'Discard unsent changes');
        h.homeClick(); h.linkClick(h.footerLinks[(index + 1) % h.footerLinks.length]); h.linkClick(link);
        expect(h.elements.dashboardApp.querySelectorAll('dialog')).toHaveLength(1);
        discard.click(); discard.click(); await flush();
        expect(h.window.location.assign.mock.calls).toEqual([[target]]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1); expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.requests.filter(request => request.init.method === 'POST')).toHaveLength(0);
    });
    test.each(footerTargets)('clean footer gateway=%s link=%s navigates once to %s', async (gateway, index, target) => {
        const h = harness({ gateway, cyber: true, hash: '#cyber-security' }); await ready(h);
        h.linkClick(h.footerLinks[index]); h.linkClick(h.footerLinks[index]); await flush();
        expect(h.window.location.assign.mock.calls).toEqual([[target]]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests[5].init.signal.aborted).toBe(true);
    });
    test.each([false, true])('anonymous footer gateway=%s retains ordinary native navigation', async gateway => {
        const h = harness({ gateway }); await flush(); await h.reply(0, 401, { code: 'authentication_required' });
        h.footerLinks.forEach(link => expect(h.linkClick(link).defaultPrevented).toBe(false));
        expect(h.window.location.assign.mock.calls).toEqual(h.footerLinks.map(link => [link.href]));
        expect(h.mounts).toHaveLength(0);
    });
    test.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 },
        { defaultPrevented: true }, { target: '_blank' }, { target: 'other-window' }, { download: '' }])
        ('footer native activation %j retains the current draft', async attributes => {
            const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h);
            const input = unsavedScope(h), link = h.footerLinks[3], extra = { ...attributes };
            for (const name of ['target', 'download']) if (Object.hasOwn(extra, name)) { link.setAttribute(name, extra[name]); delete extra[name]; }
            const event = h.linkClick(link, extra); await flush();
            expect(event.defaultPrevented).toBe(Boolean(attributes.defaultPrevented));
            expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
            expect(input.value).toBe('Synthetic unsaved scope'); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        });
    test('footer Save waits for a create acknowledgement and retains the original target across repeated exits', async () => {
        const stored = await records();
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h);
        await ncscReply(h, 5, 200, stored.list()); unsavedScope(h); h.linkClick(h.footerLinks[3]);
        control(h, 'Save and leave').click(); control(h, 'Save and leave').click(); await flush();
        h.linkClick(h.footerLinks[0]); h.homeClick(); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.requests).toHaveLength(7); expect(h.window.location.assign).not.toHaveBeenCalled();
        const result = stored.execute(stored.command(h.requests[6])); await ncscReply(h, 6, 201, result);
        expect(h.window.location.assign.mock.calls).toEqual([['/terms.html']]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(stored.read(result.assessment.assessmentId).assessment.scopePopulation.description).toBe('Synthetic unsaved scope');
    });
    test.each(['rejected', 'invalid acknowledgement', 400, 503])('footer Save %s remains in place with its draft', async outcome => {
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        h.linkClick(h.footerLinks[2]); control(h, 'Save and leave').click(); await flush();
        if (outcome === 'rejected') { h.requests[6].reject(new Error('Synthetic lost response')); await flush(); }
        else await ncscReply(h, 6, typeof outcome === 'number' ? outcome : 201,
            { code: outcome === 400 ? 'ncsc_input_invalid' : 'ncsc_unavailable' });
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        expect(h.elements.dashboardApp.querySelector('textarea').value).toBe('Synthetic unsaved scope');
        expect(h.elements.dashboardApp.textContent).not.toContain('Your progress is saved.');
        h.linkClick(h.footerLinks[0]); await flush();
        expect(Boolean(h.elements.dashboardApp.querySelector('dialog'))).toBe(outcome === 400);
        expect(h.requests).toHaveLength(7);
    });
    test.each([false, true])('footer discards unsent answer only, preserving saved record (gateway=%s)', async gateway => {
        const stored = await records(); stored.execute(createCommand('assessment-home'));
        stored.execute(saveCommand('assessment-home', 0, 'saved-footer', allResponses('yes')));
        const saved = stored.read('assessment-home');
        const h = harness({ gateway, cyber: true, hash: '#cyber-security' }); await openedRecord(h, stored); selectAnswer(h);
        h.linkClick(h.footerLinks[0]); control(h, 'Discard unsent changes').click(); await flush();
        expect(stored.read('assessment-home')).toEqual(saved);
        expect(h.requests.filter(request => request.init.method === 'POST')).toHaveLength(0);
        expect(h.window.location.assign.mock.calls).toEqual([[h.footerLinks[0].href]]);
    });
    test('footer blocks a running answer save and allows the chosen target only after acknowledgement', async () => {
        const stored = await records(); stored.execute(createCommand('assessment-home'));
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await openedRecord(h, stored); selectAnswer(h);
        control(h, 'Save progress').click(); await flush();
        h.footerLinks.forEach(link => h.linkClick(link)); await flush();
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
        expect(h.elements.dashboardApp.textContent).toContain('Resolve the running or unconfirmed operation');
        const result = stored.execute(stored.command(h.requests[7])); await ncscReply(h, 7, 200, result);
        h.linkClick(h.footerLinks[2]); await flush(); expect(h.window.location.assign.mock.calls).toEqual([['/privacy.html']]);
    });
    test('footer retains draft and leave decisions through a quiet access refresh', async () => {
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h); const input = unsavedScope(h);
        h.window.dispatch('focus'); await flush(); h.footerLinks.forEach(link => h.linkClick(link)); await flush();
        expect(h.requests[6].url).toBe('/api/dashboard/session');
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.elements.dashboardApp.querySelectorAll('dialog')).toHaveLength(1);
        control(h, 'Stay here').click(); await flush();
        await refresh(h, 6); expect(h.elements.dashboardApp.querySelector('textarea')).toBe(input);
        h.linkClick(h.footerLinks[2]); expect(h.elements.dashboardApp.querySelector('dialog')).not.toBeNull();
    });
    test.each(['denial', 'pagehide'])('stale footer decision cannot navigate after %s', async invalidation => {
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        h.linkClick(h.footerLinks[2]); const discard = control(h, 'Discard unsent changes');
        if (invalidation === 'denial') { h.window.dispatch('focus'); await flush(); await h.reply(6, 403, { code: 'dashboard_access_denied' }); }
        else h.window.dispatch('pagehide');
        await flush(); discard.click(); await flush(); expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
    });
    test.each([1, 2])('gateway explicit header link %s uses the same target-preserving guard', async index => {
        const h = harness({ gateway: true, cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        h.linkClick(h.headerLinks[index]); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.window.location.assign.mock.calls).toEqual([[h.headerLinks[index].href]]);
    });
    test('the actual root gateway brand retains Stay, then Discard restores public home and tears down', async () => {
        const h = harness({ page: 'managed-it', gateway: true, cyber: true, hash: '#cyber-security' });
        await ready(h); const input = unsavedScope(h);
        expect(h.homeLinks).toHaveLength(1);
        expect(h.homeLinks[0].getAttribute('data-dashboard-home')).toBe('');
        expect(h.elements.gatewayPublic.hidden).toBe(true);
        expect(h.homeClick().defaultPrevented).toBe(true);
        control(h, 'Stay here').click(); await flush();
        expect(input.value).toBe('Synthetic unsaved scope');
        expect(h.elements.gatewayPublic.hidden).toBe(true);
        expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.homeClick(); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(h.elements.gatewayPublic.hidden).toBe(false);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests.every(request => request.init.method !== 'POST')).toBe(true);
    });
    test.each([201, 503])('the actual root gateway Save waits for acknowledgement %s before leaving', async status => {
        const stored = await records();
        const h = harness({ page: 'managed-it', gateway: true, cyber: true, hash: '#cyber-security' });
        await ready(h); await ncscReply(h, 5, 200, stored.list());
        const input = unsavedScope(h); h.homeClick(); control(h, 'Save and leave').click(); await flush();
        expect(h.requests).toHaveLength(7);
        expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.elements.gatewayPublic.hidden).toBe(true);
        const result = status === 201 ? stored.execute(stored.command(h.requests[6])) : { code: 'ncsc_unavailable' };
        await ncscReply(h, 6, status, result);
        if (status === 201) {
            expect(h.window.location.assign.mock.calls).toEqual([['/']]);
            expect(h.elements.gatewayPublic.hidden).toBe(false);
            expect(h.elements.dashboardApp.children).toHaveLength(0);
            expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        } else {
            expect(h.window.location.assign).not.toHaveBeenCalled();
            expect(h.elements.gatewayPublic.hidden).toBe(true);
            expect(input.value).toBe('Synthetic unsaved scope');
            expect(h.mounts[0].destroy).not.toHaveBeenCalled();
            expect(h.elements.dashboardApp.textContent).toContain('This operation is unconfirmed.');
            h.homeClick(); await flush();
            expect(h.elements.dashboardApp.textContent).toContain('Resolve the running or unconfirmed operation');
            expect(h.requests).toHaveLength(7);
            expect(h.window.location.assign).not.toHaveBeenCalled();
            expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        }
    });
    test.each([0, 1])('Home link %s guards an unsaved questionnaire scope until an explicit decision', async index => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        const app = h.elements.dashboardApp;
        const input = unsavedScope(h);
        h.homeClick(index); await flush();
        expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(app.querySelector('dialog').textContent).toContain('Leave with unsaved changes?');
        app.querySelectorAll('button').find(button => button.textContent === 'Stay here').click();
        expect(input.value).toBe('Synthetic unsaved scope');
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
    });
    test.each(['Stay here', 'Escape', 'cancel'])('Home dialog traps keyboard focus and %s retains the draft', async choice => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        const input = unsavedScope(h); h.homeClick(); await flush();
        const dialog = h.elements.dashboardApp.querySelector('dialog');
        const [save, discard, stay] = dialog.querySelectorAll('button');
        expect(h.document.activeElement).toBe(stay);
        const key = (value, shiftKey = false) => {
            const event = { key: value, shiftKey, preventDefault: jest.fn() };
            for (const callback of dialog.events.keydown) callback(event);
            expect(event.preventDefault).toHaveBeenCalled();
        };
        key('Tab'); expect(h.document.activeElement).toBe(save);
        key('Tab', true); expect(h.document.activeElement).toBe(stay);
        key('Tab', true); expect(h.document.activeElement).toBe(discard);
        h.homeClick(0); h.homeClick(1); await flush();
        expect(h.elements.dashboardApp.querySelectorAll('dialog')).toEqual([dialog]);
        if (choice === 'Stay here') stay.click();
        else if (choice === 'Escape') key('Escape');
        else { const event = { preventDefault: jest.fn() }; for (const callback of dialog.events.cancel) callback(event); expect(event.preventDefault).toHaveBeenCalled(); }
        await flush(); expect(h.document.activeElement).toBe(input);
        expect(input.value).toBe('Synthetic unsaved scope'); expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
        h.homeClick(1); expect(h.elements.dashboardApp.querySelector('dialog')).not.toBeNull();
    });
    test.each(['editable', 'read-only'])('clean %s questionnaire permits one ordinary Home navigation and tears down', async mode => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h, mode);
        h.homeClick(1); h.homeClick(0); await flush();
        expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.requests[5].init.signal.aborted).toBe(true);
    });
    test('discarding an unsaved new scope leaves no create command and clears protected content', async () => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        h.homeClick(); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.requests).toHaveLength(6); expect(h.requests.every(request => request.init.method !== 'POST')).toBe(true);
        expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    test('Save and leave waits for an actual create acknowledgement and repeats neither save nor navigation', async () => {
        const stored = await records();
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        await ncscReply(h, 5, 200, stored.list()); unsavedScope(h); h.homeClick();
        control(h, 'Save and leave').click(); await flush();
        expect(h.requests).toHaveLength(7); expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(control(h, 'Save and leave').disabled).toBe(true);
        expect(control(h, 'Discard unsent changes').disabled).toBe(true);
        h.homeClick(0); h.homeClick(1); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.requests).toHaveLength(7); expect(h.window.location.assign).not.toHaveBeenCalled();
        const result = stored.execute(stored.command(h.requests[6]));
        await ncscReply(h, 6, 201, result);
        expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(stored.read(result.assessment.assessmentId).assessment.scopePopulation.description).toBe('Synthetic unsaved scope');
        expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    test.each([400, 503])('failed or ambiguous Save and leave %s keeps the scope and never claims saved progress', async status => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h);
        h.homeClick(); control(h, 'Save and leave').click(); await flush();
        await ncscReply(h, 6, status, { code: status === 400 ? 'ncsc_input_invalid' : 'ncsc_unavailable' });
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        expect(h.elements.dashboardApp.querySelector('textarea').value).toBe('Synthetic unsaved scope');
        expect(h.elements.dashboardApp.textContent).not.toContain('Your progress is saved.');
        h.homeClick(1); await flush();
        expect(Boolean(h.elements.dashboardApp.querySelector('dialog'))).toBe(status === 400);
        expect(h.requests).toHaveLength(7);
        if (status === 503) expect(h.elements.dashboardApp.textContent).toContain('Resolve the running or unconfirmed operation');
    });
    test('discard removes only the local answer; the existing saved assessment can be reopened unchanged', async () => {
        const stored = await records(); stored.execute(createCommand('assessment-home'));
        stored.execute(saveCommand('assessment-home', 0, 'saved-home', allResponses('yes')));
        const saved = stored.read('assessment-home');
        const h = harness({ cyber: true, hash: '#cyber-security' }); await openedRecord(h, stored);
        selectAnswer(h);
        expect(h.elements.dashboardApp.querySelector('.ncsc-status').textContent).toContain('1 answer has unsaved changes.');
        expect(h.elements.dashboardApp.querySelector('.ncsc-draft-progress').textContent).toContain('1 with unsaved changes');
        expect(h.document.getElementById('ncsc-question-index').children[0].textContent).toMatch(/\*$/);
        h.homeClick(); control(h, 'Discard unsent changes').click(); await flush();
        expect(h.requests.filter(request => request.init.method === 'POST')).toHaveLength(0);
        expect(stored.read('assessment-home')).toEqual(saved); expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        const reopened = harness({ cyber: true, hash: '#cyber-security' }); await openedRecord(reopened, stored);
        expect(reopened.elements.dashboardApp.querySelectorAll('input').find(item => item.type === 'radio' && item.checked).value).toBe('yes');
        expect(reopened.elements.dashboardApp.textContent).toContain('Saved revision 1');
        expect(reopened.elements.dashboardApp.querySelector('.ncsc-status').textContent).not.toContain('unsaved changes');
        expect(reopened.elements.dashboardApp.querySelector('.ncsc-draft-progress').textContent).not.toContain('unsaved changes');
        expect(reopened.document.getElementById('ncsc-question-index').children.every(option => !/\*$/.test(option.textContent))).toBe(true);
        expect(reopened.document.getElementById('ncsc-question-index-help').textContent).toContain('* marks unsaved changes');
        reopened.homeClick(); await flush();
        expect(reopened.elements.dashboardApp.querySelector('dialog')).toBeNull();
        expect(reopened.window.location.assign.mock.calls).toEqual([['/']]);
        expect(reopened.requests.filter(request => request.init.method === 'POST')).toHaveLength(0);
        expect(stored.read('assessment-home')).toEqual(saved);
    });
    test('Home is blocked during a normal answer save, then permits navigation after its saved acknowledgement', async () => {
        const stored = await records(); stored.execute(createCommand('assessment-home'));
        const h = harness({ cyber: true, hash: '#cyber-security' }); await openedRecord(h, stored); selectAnswer(h);
        control(h, 'Save progress').click(); await flush();
        h.homeClick(0); h.homeClick(1); await flush();
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
        expect(h.elements.dashboardApp.textContent).toContain('Resolve the running or unconfirmed operation');
        const result = stored.execute(stored.command(h.requests[7])); await ncscReply(h, 7, 200, result);
        expect(h.elements.dashboardApp.textContent).toContain('Your progress is saved.');
        h.homeClick(1); await flush(); expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(stored.read('assessment-home').assessment).toMatchObject({ revision: 1, progress: { answered: 1 } });
    });
    test.each([false, true])('Save and leave records answer progress; cancellation during save retains the view: %s', async cancel => {
        const stored = await records(); stored.execute(createCommand('assessment-home'));
        const h = harness({ cyber: true, hash: '#cyber-security' }); await openedRecord(h, stored); selectAnswer(h);
        h.homeClick(1, { button: undefined, detail: 0 }); control(h, 'Save and leave').click(); await flush();
        const dialog = h.elements.dashboardApp.querySelector('dialog');
        h.homeClick(0); h.homeClick(1); await flush(); expect(h.requests).toHaveLength(8);
        expect(h.window.location.assign).not.toHaveBeenCalled();
        if (cancel) for (const callback of dialog.events.keydown) callback({ key: 'Escape', preventDefault() {} });
        const result = stored.execute(stored.command(h.requests[7])); await ncscReply(h, 7, 200, result);
        expect(stored.read('assessment-home').assessment).toMatchObject({ revision: 1, progress: { answered: 1 },
            responses: [{ itemId: createNcscQuestionnaireMetadata().questions[0].id, optionId: 'no' }] });
        if (cancel) {
            expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
            expect(h.elements.dashboardApp.textContent).toContain('Your progress is saved.');
            h.homeClick(); await flush();
        }
        expect(h.window.location.assign.mock.calls).toEqual([['/']]);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
    });
    test.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
        ('modified Home activation %j leaves the current draft and native event untouched', async extra => {
            const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); const input = unsavedScope(h);
            expect(h.homeClick(0, extra).defaultPrevented).toBe(false); await flush();
            expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
            expect(input.value).toBe('Synthetic unsaved scope'); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        });
    test('Home retains a draft while authority is rechecked, then still offers the explicit leave decision', async () => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); const input = unsavedScope(h);
        h.window.dispatch('focus'); await flush();
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        expect(h.homeClick(0).defaultPrevented).toBe(true); h.homeClick(1); await flush();
        expect(h.window.location.assign).not.toHaveBeenCalled(); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        await refresh(h, 6);
        expect(h.elements.dashboardApp.querySelector('textarea')).toBe(input);
        h.homeClick(1); expect(h.elements.dashboardApp.querySelector('dialog')).not.toBeNull();
    });
    test.each(['denial', 'pagehide'])('a stale Home leave decision cannot navigate after %s clears protected content', async invalidation => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h); unsavedScope(h); h.homeClick();
        const discard = control(h, 'Discard unsent changes');
        if (invalidation === 'denial') { h.window.dispatch('focus'); await flush(); await h.reply(6, 403, { code: 'dashboard_access_denied' }); }
        else h.window.dispatch('pagehide');
        await flush(); discard.click(); await flush();
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.window.location.assign).not.toHaveBeenCalled();
    });
    test.each([false, true])('ready-state document skip link focuses main without changing Cyber route or opening a leave dialog (gateway=%s)', async gateway => {
        const h = harness({ gateway, cyber: true, hash: '#cyber-security' }); await ready(h);
        const before = h.window.location.hash, skip = h.elements.dashboardSkipLink;
        expect(skip.href).toBe('#dashboard-content');
        const event = { preventDefault: jest.fn() };
        for (const callback of skip.events.click) callback(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(h.document.activeElement).toBe(h.elements.dashboardApp.querySelector('main'));
        expect(h.window.location.hash).toBe(before);
        expect(h.elements.dashboardApp.querySelector('dialog')).toBeNull();
    });
    test.each(['editable', 'read-only'])('mounts the genuine questionnaire with server %s presentation and generation-bound list', async mode => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h, mode);
        expect(h.ncscMounts).toHaveLength(1);
        expect(h.ncscMounts[0][1]).toMatchObject({ organisationId: h.cyberProjection.context.organisationId });
        expect(h.status).toBe('ready');
        expect(h.elements.dashboardApp.textContent).toContain('assessment');
        expect(h.elements.dashboardApp.querySelectorAll('button').some(button => button.textContent === 'Start an assessment')).toBe(mode === 'editable');
        expect(h.requests[5].url).toMatch(/^\/api\/dashboard\/ncsc\/assessments/);
        expect(h.requests[5].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(h.requests[5].init.credentials).toBe('same-origin');
        // Denial clears the whole protected view, not only the child.
        await h.reply(5, 403, { code: 'ncsc_access_denied' });
        expect(h.status).toBe('denied'); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    test('same-generation focus preserves the mounted questionnaire; changed selection clears it', async () => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        h.window.dispatch('focus'); await flush();
        expect(h.elements.dashboardApp.hidden).toBe(false);
        await refresh(h, 6);
        expect(h.mounts).toHaveLength(1); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.window.dispatch('focus'); await flush(); await h.reply(11, 200, state(B, GB));
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.hidden).toBe(true);
        await h.reply(5, 403, { code: 'ncsc_access_denied' });
        expect(h.status).toBe('loading');
    });
    test.each(['sign-out', 'organisation selection'])('unsaved scope is retained until explicit leave on %s', async action => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        const values = { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null };
        await h.reply(5, 200, values, { headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null }, text: async () => JSON.stringify(values) });
        const app = h.elements.dashboardApp;
        const prototype = Object.getPrototypeOf(app);
        prototype.showModal = function () { this.open = true; };
        prototype.close = function () { this.open = false; };
        prototype.removeChild = function (node) { this.children = this.children.filter(item => item !== node); node.parentElement = null; };
        const button = label => app.querySelectorAll('button').find(item => item.textContent === label);
        button('Start an assessment').click();
        const input = app.querySelector('textarea'); input.value = 'Synthetic HQ scope';
        for (const callback of input.events.input) callback();
        if (action === 'sign-out') h.click('dashboardSignOut');
        else h.elements.dashboardChoices.children[1].click();
        await flush();
        expect(app.textContent).toContain('Leave with unsaved changes?'); expect(h.requests).toHaveLength(6);
        button('Stay here').click(); await flush();
        expect(input.value).toBe('Synthetic HQ scope'); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.window.dispatch('focus'); await flush(); await refresh(h, 6);
        expect(app.querySelector('textarea').value).toBe('Synthetic HQ scope');
        if (action === 'sign-out') h.click('dashboardSignOut');
        else h.elements.dashboardChoices.children[1].click();
        button('Discard unsent changes').click(); await flush();
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests[11].url).toBe(action === 'sign-out' ? '/api/dashboard/logout' : '/api/dashboard/selection');
    });
    test.each(['network', '503', 'timeout'])('uncertain focus %s hides and locks draft until same-generation retry', async failure => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        const app = h.elements.dashboardApp;
        app.querySelectorAll('button').find(item => item.textContent === 'Start an assessment').click();
        const input = app.querySelector('textarea'); input.value = 'Retained synthetic scope';
        for (const callback of input.events.input) callback();
        h.window.dispatch('focus'); await flush();
        if (failure === 'network') { h.requests[6].reject(new Error('network')); await flush(); }
        else if (failure === '503') await h.reply(6, 503, { code: 'dashboard_unavailable' });
        else { jest.advanceTimersByTime(12000); await flush(); }
        expect(app.hidden).toBe(false); expect(app.inert).toBe(false);
        expect(h.status).toBe('ready'); expect(h.elements.dashboardStatus.textContent).toContain('Could not refresh access');
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(7);
        h.click('dashboardRetry'); await flush(); await refresh(h, 7);
        expect(app.hidden).toBe(false); expect(app.inert).toBe(false);
        expect(app.querySelector('textarea').value).toBe('Retained synthetic scope');
        expect(h.mounts).toHaveLength(1);
        h.window.dispatch('focus'); await flush(); await h.reply(12, 401, { code: 'authentication_required' });
        expect(app.children).toHaveLength(0); expect(h.status).toBe('expired');
    });
    test('unconfirmed mutation survives focus outage and retries exactly after authority recovery', async () => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        const app = h.elements.dashboardApp;
        const button = label => app.querySelectorAll('button').find(item => item.textContent === label);
        button('Start an assessment').click();
        const input = app.querySelector('textarea'); input.value = 'Synthetic scope with uncertain save';
        for (const callback of input.events.input) callback();
        button('Create assessment').click(); await flush();
        const bytes = h.requests[6].init.body;
        const unavailable = { code: 'ncsc_unavailable' };
        await h.reply(6, 503, unavailable, { headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null }, text: async () => JSON.stringify(unavailable) });
        expect(app.textContent).toContain('Operation unconfirmed');
        h.window.dispatch('focus'); await flush(); await h.reply(7, 503, { code: 'dashboard_unavailable' });
        expect(app.hidden).toBe(false); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.click('dashboardRetry'); await flush(); await refresh(h, 8);
        expect(app.textContent).toContain('Operation unconfirmed');
        button('Retry same operation').click(); await flush();
        expect(h.requests[13].init.body).toBe(bytes);
        expect(h.requests[13].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
    });
    test.each(['denied', 'read-only', 'metadata', 'disabled'])('focus rechecks module authority and clears changed %s contract', async change => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        h.window.dispatch('focus'); await flush(); await refreshToModule(h, 6);
        expect(h.requests[9].url).toBe('/api/dashboard/modules/cyber_security');
        expect(h.requests[9].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
        expect(h.elements.dashboardApp.hidden).toBe(false);
        const changed = JSON.parse(JSON.stringify(h.cyberProjection));
        if (change === 'read-only') changed.presentationMode = 'read-only';
        if (change === 'metadata') changed.metadata.title = 'Changed accepted display';
        if (change === 'disabled') changed.module.state = 'disabled';
        await h.reply(9, change === 'denied' ? 403 : 200, changed);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.status).toBe(change === 'denied' ? 'denied' : 'loading');
    });
    test('transient module-authority recheck failure keeps content hidden for retry', async () => {
        const h = harness({ cyber: true, hash: '#cyber-security' }); await ready(h);
        h.window.dispatch('focus'); await flush(); await refreshToModule(h, 6);
        await h.reply(9, 503, { code: 'dashboard_unavailable' });
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        h.click('dashboardRetry'); await flush(); await refresh(h, 10);
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.mounts).toHaveLength(1);
    });
    test.each([null, { organisationId: 'another-organisation' }])('mismatched Cyber organisation context %s cannot mount', async context => {
        const h = harness({ cyber: true }); await flush();
        await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = JSON.parse(JSON.stringify(projection())); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        await h.reply(3, 200, { schemaVersion: 1, context, generatedAt: model.generatedAt,
            module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
            services: [], admissionGranted: false, providerAccessGranted: false, metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' });
        expect(h.status).toBe('unavailable'); expect(h.mounts).toHaveLength(0);
        expect(h.requests).toHaveLength(4);
    });
    test('malformed metadata/edit presentation cannot mount Cyber', async () => {
        const h = harness({ cyber: true }); await flush();
        await h.reply(0, 200, state()); await h.reply(1, 200, listing());
        const model = JSON.parse(JSON.stringify(projection())); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        await h.reply(3, 200, { schemaVersion: 1, metadata: createNcscQuestionnaireMetadata(), presentationMode: 'admin' });
        expect(h.status).toBe('unavailable'); expect(h.mounts).toHaveLength(0);
    });
});


describe('root dashboard gateway', () => {
    test('anonymous entry preserves organisation setup without fetching private assets', async () => {
        const h = harness({ page: 'managed-it', gateway: true }); await flush();
        const skip = h.elements.dashboardSkipLink;
        expect(skip.href).toBe('#main-content'); expect(skip.textContent).toBe('Skip to content');
        const activation = { preventDefault: jest.fn() };
        for (const callback of skip.events.click) callback(activation);
        expect(activation.preventDefault).not.toHaveBeenCalled();
        await h.reply(0, 401, { code: 'dashboard_authentication_required' });
        expect(h.status).toBe('unauthenticated'); expect(h.elements.gatewayPublic.hidden).toBe(false);
        expect(h.elements.dashboardStatusPanel.hidden).toBe(true); expect(h.native).toHaveLength(0);
        expect(skip.href).toBe('#main-content'); expect(skip.textContent).toBe('Skip to content');
        for (const callback of skip.events.click) callback(activation);
        expect(activation.preventDefault).not.toHaveBeenCalled();
    });
    test('admission mounts the genuine protected dashboard at root and expiry clears it', async () => {
        const h = harness({ page: 'managed-it', gateway: true }); await flush();
        await h.open(state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        expect(h.elements.gatewayPublic.hidden).toBe(true); expect(h.mounts).toHaveLength(1);
        jest.advanceTimersByTime(2000); await flush();
        expect(h.status).toBe('expired'); expect(h.elements.dashboardApp.hidden).toBe(true);
        expect(h.elements.gatewayPublic.hidden).toBe(false);
        expect(h.elements.dashboardSkipLink.href).toBe('#dashboardHeading');
    });
});

test('consultant completion opens the portfolio first, selects a client and returns to the portfolio', async () => {
    const h = harness({ hash: '#organisations' }); await flush();
    const customer = state(A, GA, { purpose: 'customer', accountType: 'consultant' });
    await h.reply(0, 200, customer); await h.reply(1, 200, listing());
    expect(h.status).toBe('selection'); expect(h.elements.dashboardHeading.textContent).toBe('Your consultant account');
    expect(h.elements.dashboardMessage.textContent).toBe('Choose an organisation workspace you can access.');
    expect(h.elements.dashboardStatus.textContent).not.toContain('Account owner');
    expect(h.mounts).toHaveLength(0); expect(h.requests).toHaveLength(2);
    h.elements.dashboardChoices.children[1].click(); await flush();
    expect(JSON.parse(h.requests[2].init.body).bindingId).toBe(B);
    await h.reply(2, 200, { schemaVersion: 1, generation: GB, selectedBindingId: B });
    const selected = state(B, GB, { purpose: 'customer', accountType: 'consultant' });
    await h.open(selected, 'Selected client', 3);
    expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.textContent).toContain('Selected client');
    expect(h.elements.dashboardMessage.textContent).toContain('this organisation’s saved assessment');
    expect(h.elements.dashboardMessage.textContent).toContain('Return to organisations');
    expect(h.window.location.hash).toBe('#overview');
    h.event('focus'); await flush(); await h.open(selected, 'Selected client', 7);
    expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.textContent).toContain('Selected client');
    const back = h.elements.dashboardStatusPanel.children.find(node => node.id === 'consultantPortfolioControls');
    expect(back.hidden).toBe(false); back.onclick(); await flush();
    await h.reply(11, 200, selected); await h.reply(12, 200, listing());
    expect(h.status).toBe('selection'); expect(h.elements.dashboardApp.hidden).toBe(true);
    expect(back.hidden).toBe(true); expect(h.window.location.hash).toBe('#organisations');
    h.event('pageshow', { persisted: true }); await flush();
    await h.reply(13, 200, selected); await h.reply(14, 200, listing());
    expect(h.status).toBe('selection'); expect(h.elements.dashboardApp.hidden).toBe(true);
});
test('company completion opens its organisation and an operator cannot claim a consultant account type', async () => {
    const h = harness(); await flush();
    await h.open(state(A, GA, { purpose: 'customer', accountType: 'company' }));
    expect(h.status).toBe('ready');
    expect(h.elements.dashboardMessage.textContent).toBe('View your organisation’s saved assessment and next actions.');
    const invalid = harness(); await flush();
    await invalid.reply(0, 200, state(A, GA, { accountType: 'consultant' }));
    expect(invalid.status).toBe('unavailable'); expect(invalid.requests).toHaveLength(1);
});


describe('unmounted authority refresh coalescing', () => {
    const paths = ['/api/dashboard/session', '/api/dashboard/organisations?limit=50',
        '/api/dashboard/bootstrap', '/api/dashboard/modules/cyber_security', '/api/dashboard/session'];
    function cyberProjection() {
        const model = JSON.parse(JSON.stringify(projection()));
        model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        return model;
    }
    function moduleProjection(model) {
        return { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
            module: model.modules.find(item => item.key === 'cyber_security'),
            summary: { state: 'empty', attention: [], metrics: [] }, services: [], admissionGranted: false,
            providerAccessGranted: false, metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' };
    }
    async function finish(h, first, asset, model) {
        await h.reply(first, 200, state()); await h.reply(first + 1, 200, listing());
        await h.reply(first + 2, 200, model);
        h.load(asset); h.load(asset + 1); await flush();
        await h.reply(first + 3, 200, moduleProjection(model)); await h.reply(first + 4, 200, state());
    }
    test.each(['initial load', 'cached return'].flatMap(origin =>
        ['session', 'directory', 'bootstrap', 'script', 'style', 'module', 'final session'].map(stage => [origin, stage])))
        ('%s shares the pending %s check across overlapping focus and pageshow', async (origin, stage) => {
            const h = harness({ cyber: true, hash: '#services' }), model = cyberProjection();
            await flush();
            if (origin === 'cached return') {
                await finish(h, 0, 0, model);
                h.window.dispatch('pagehide'); h.event('pageshow', { persisted: true }); await flush();
            }
            const first = origin === 'initial load' ? 0 : 5;
            const asset = origin === 'initial load' ? 0 : 2;
            if (stage !== 'session') await h.reply(first, 200, state());
            if (!['session', 'directory'].includes(stage)) await h.reply(first + 1, 200, listing());
            if (!['session', 'directory', 'bootstrap'].includes(stage)) await h.reply(first + 2, 200, model);
            if (['style', 'module', 'final session'].includes(stage)) h.load(asset);
            if (['module', 'final session'].includes(stage)) { h.load(asset + 1); await flush(); }
            if (stage === 'final session') await h.reply(first + 3, 200, moduleProjection(model));
            const count = h.requests.length, natives = h.native.length;
            for (let index = 0; index < 12; index++) h.window.dispatch('focus');
            h.event('pageshow', { persisted: true }); await flush();
            expect(h.requests).toHaveLength(count); expect(h.native).toHaveLength(natives);
            expect(h.requests.slice(first).every(item => item.init.signal.aborted === false)).toBe(true);
            expect(h.status).toBe('loading'); expect(h.elements.dashboardApp.hidden).toBe(true);
            expect(h.mounts).toHaveLength(origin === 'initial load' ? 0 : 1);
            await finish(h, first, asset, model);
            expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(origin === 'initial load' ? 1 : 2);
            expect(h.requests.slice(first).map(item => item.url)).toEqual(paths);
            expect(h.requests.slice(first).every(item => item.init.method === 'GET')).toBe(true);
            expect(h.window.location.hash).toBe('#services');
        });

    test('each distinct completed focus return still performs both fresh session witnesses', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.open();
        const main = h.elements.dashboardApp.querySelector('main');
        for (const first of [4, 8]) {
            h.window.dispatch('focus'); await flush();
            expect(h.requests[first].url).toBe('/api/dashboard/session');
            await h.reply(first, 200, state()); await h.reply(first + 1, 200, listing());
            await h.reply(first + 2, 200, projection());
            expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
            await h.reply(first + 3, 200, state());
            expect(h.status).toBe('ready'); expect(h.requests).toHaveLength(first + 4);
            expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
        }
        expect(h.requests.slice(4).map(item => item.url)).toEqual([
            paths[0], paths[1], paths[2], paths[4], paths[0], paths[1], paths[2], paths[4]
        ]);
    });

    test('failed initial reconciliation releases sharing so the next focus can retry fresh reads', async () => {
        const h = harness(); await flush(); await h.reply(0, 503, { code: 'dashboard_unavailable' });
        expect(h.status).toBe('unavailable');
        h.window.dispatch('focus'); await flush(); await h.open(state(), 'Recovered after unavailable', 1);
        expect(h.status).toBe('ready'); expect(h.requests).toHaveLength(5);
    });

    test('pagehide invalidates a pending chain and overlapping return events share the new tenant checks', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, state());
        const old = h.requests[1];
        h.window.dispatch('pagehide'); h.window.dispatch('focus'); await flush();
        h.event('pageshow', { persisted: true }); await flush();
        expect(old.init.signal.aborted).toBe(true);
        expect(h.requests).toHaveLength(4); expect(h.requests[3].url).toBe('/api/dashboard/session');
        await h.open(state(B, GB), 'Current organisation B', 3);
        old.resolve(response(200, listing())); await flush();
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
        expect(h.elements.dashboardApp.textContent).toContain('Current organisation B');
        expect(h.requests.slice(3).every(item => item.init.method === 'GET')).toBe(true);
    });
});

describe('concurrent mounted authority refresh', () => {
    async function mounted(cyber, value = state()) {
        const h = harness({ cyber, hash: '#services' }); await flush();
        const model = JSON.parse(JSON.stringify(projection()));
        if (cyber) model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        await h.reply(0, 200, value); await h.reply(1, 200, listing()); await h.reply(2, 200, model);
        h.load(0); h.load(1); await flush();
        h.refreshModel = model;
        if (cyber) {
            h.refreshModule = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
                module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
                services: [], admissionGranted: false, providerAccessGranted: false,
                metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' };
            await h.reply(3, 200, h.refreshModule);
        }
        await h.reply(cyber ? 4 : 3, 200, value);
        expect(h.status).toBe('ready'); return h;
    }
    function paths(cyber) {
        return ['/api/dashboard/organisations?limit=50', '/api/dashboard/bootstrap',
            ...(cyber ? ['/api/dashboard/modules/cyber_security'] : [])];
    }
    function payload(h, offset) { return offset === 1 ? listing() : offset === 2 ? h.refreshModel : h.refreshModule; }
    async function beginRefresh(h, cyber) {
        const first = h.requests.length;
        h.window.dispatch('focus'); await flush(); await h.reply(first, 200, state());
        expect(h.requests.slice(first + 1).map(item => item.url)).toEqual(paths(cyber));
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        return first;
    }
    async function finishRefresh(h, first, cyber) {
        await h.reply(first, 200, state());
        for (let offset = cyber ? 3 : 2; offset > 0; offset--) await h.reply(first + offset, 200, payload(h, offset));
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        const final = first + (cyber ? 4 : 3);
        expect(h.requests[final].url).toBe('/api/dashboard/session'); await h.reply(final, 200, state());
        expect(h.status).toBe('ready');
    }
    test.each([false, true])('parallel middle GETs accept reverse completion with Cyber=%s and retain the final witness fence', async cyber => {
        const h = await mounted(cyber), main = h.elements.dashboardApp.querySelector('main');
        const first = await beginRefresh(h, cyber), middleCount = cyber ? 3 : 2;
        expect(h.requests).toHaveLength(first + 1 + middleCount);
        for (let offset = middleCount; offset > 0; offset--) {
            await h.reply(first + offset, 200, payload(h, offset));
            expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
            if (offset > 1) expect(h.requests).toHaveLength(first + 1 + middleCount);
        }
        const final = first + 1 + middleCount;
        expect(h.requests[final].url).toBe('/api/dashboard/session');
        for (let index = 0; index < 12; index++) h.window.dispatch('focus'); await flush();
        expect(h.requests).toHaveLength(final + 1);
        await h.reply(final, 200, state());
        expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
        expect(h.requests.slice(first).every(item => item.init.method === 'GET' && !item.init.signal.aborted)).toBe(true);
        for (const item of h.requests.slice(first + 2, final)) expect(item.init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
    });

    test.each([false, true])('Cyber=%s keeps the controlled60ms GET critical path to three witnessed rounds', async cyber => {
        const h = await mounted(cyber), first = h.requests.length, started = Date.now();
        const delayed = (index, value) => {
            expect(h.requests[index]).toBeDefined();
            setTimeout(() => h.requests[index].resolve(response(200, value)), 60);
        };
        h.window.dispatch('focus'); await flush(); delayed(first, state());
        jest.advanceTimersByTime(60); await flush();
        for (let offset = 1; offset <= (cyber ? 3 : 2); offset++) delayed(first + offset, payload(h, offset));
        jest.advanceTimersByTime(60); await flush();
        expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
        delayed(first + (cyber ? 4 : 3), state());
        jest.advanceTimersByTime(60); await flush();
        expect(h.status).toBe('ready'); expect(Date.now() - started).toBe(180);
        expect(h.requests.slice(first)).toHaveLength(cyber ? 5 : 4);
        expect(h.requests.slice(first).every(item => item.init.method === 'GET')).toBe(true);
    });

    const failures = [false, true].flatMap(cyber => Array.from({ length: cyber ? 3 : 2 }, (_, index) => index + 1)
        .flatMap(offset => ['success', 'denial'].map(late => [cyber, offset, late])));
    test.each(failures)('Cyber=%s failed middle%s cancels held siblings; late %s cannot affect a completed retry', async (cyber, offset, late) => {
        const h = await mounted(cyber), main = h.elements.dashboardApp.querySelector('main');
        const first = await beginRefresh(h, cyber), held = h.requests.slice(first + 1).filter(item => item !== h.requests[first + offset]);
        await h.reply(first + offset, 503, { code: 'dashboard_unavailable' });
        expect(h.status).toBe('ready'); expect(held.every(item => item.init.signal.aborted)).toBe(true);
        expect(h.elements.dashboardApp.querySelector('main')).toBe(main); expect(h.elements.dashboardApp.hidden).toBe(false);
        const retry = h.requests.length; h.click('dashboardRetry'); await flush(); await finishRefresh(h, retry, cyber);
        const count = h.requests.length, chooser = h.elements.dashboardChoices.textContent;
        for (const item of held) item.resolve(response(late === 'denial' ? 403 : 200,
            late === 'denial' ? { code: 'dashboard_access_denied' } : payload(h, h.requests.indexOf(item) - first)));
        await flush();
        expect(h.status).toBe('ready'); expect(h.requests).toHaveLength(count);
        expect(h.elements.dashboardApp.querySelector('main')).toBe(main); expect(h.elements.dashboardChoices.textContent).toBe(chooser);
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
    });

    const denials = [false, true].flatMap(cyber => Array.from({ length: cyber ? 3 : 2 }, (_, index) => index + 1)
        .flatMap(offset => [401, 403].map(status => [cyber, offset, status])));
    test.each(denials)('Cyber=%s current middle%s returning%s clears immediately and cancels siblings', async (cyber, offset, status) => {
        const h = await mounted(cyber), first = await beginRefresh(h, cyber);
        const held = h.requests.slice(first + 1).filter(item => item !== h.requests[first + offset]);
        await h.reply(first + offset, status, { code: 'dashboard_access_denied' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied');
        expect(h.elements.dashboardApp.children).toHaveLength(0); expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(held.every(item => item.init.signal.aborted)).toBe(true);
        const count = h.requests.length;
        for (const item of held) item.resolve(response(200, payload(h, h.requests.indexOf(item) - first)));
        await flush(); expect(h.requests).toHaveLength(count); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });

    test.each(['pagehide', 'expiry'])('%s closes all parallel reads and stale denial cannot clear a new tenant', async reason => {
        const h = await mounted(true, state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        const first = await beginRefresh(h, true), held = h.requests.slice(first + 1);
        if (reason === 'expiry') { jest.advanceTimersByTime(2000); await flush(); expect(h.status).toBe('expired'); }
        else h.window.dispatch('pagehide');
        expect(held.every(item => item.init.signal.aborted)).toBe(true); expect(h.elements.dashboardApp.children).toHaveLength(0);
        const next = h.requests.length; h.event('pageshow', { persisted: true }); await flush();
        await h.open(state(B, GB), 'New authorised tenant', next);
        for (const item of held) item.resolve(response(403, { code: 'dashboard_access_denied' }));
        await flush(); expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.textContent).toContain('New authorised tenant');
        expect(h.mounts).toHaveLength(2);
    });

    test('a late bootstrap JSON body from a cancelled group cannot replace a successful retry', async () => {
        const h = await mounted(true), first = await beginRefresh(h, true), body = deferred();
        await h.reply(first + 2, 200, null, { json: () => body.promise });
        await h.reply(first + 1, 503, { code: 'dashboard_unavailable' });
        expect(h.status).toBe('ready'); expect(h.requests[first + 2].init.signal.aborted).toBe(true);
        const next = h.requests.length; h.click('dashboardRetry'); await flush(); await finishRefresh(h, next, true);
        body.resolve(projection('Obsolete response')); await flush();
        expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.textContent).not.toContain('Obsolete response');
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
    });
});

describe('retained non-Cyber focus refresh', () => {
    async function mounted(value = state(), options = {}) {
        const h = harness({ hash: '#services', ...options });
        await flush(); await h.open(value);
        expect(h.status).toBe('ready');
        return h;
    }
    function locked(h) {
        expect(h.elements.dashboardApp.hidden).toBe(false);
        expect(h.elements.dashboardApp.inert).toBe(false);
        expect(h.elements.dashboardChooser.hidden).toBe(false);
        expect(h.mounts[0].destroy).not.toHaveBeenCalled();
    }
    async function finishRefresh(h, first, value = state(), model = projection(), final = value) {
        expect(h.requests[first].url).toBe('/api/dashboard/session');
        await h.reply(first, 200, value);
        expect(h.requests[first + 1].url).toBe('/api/dashboard/organisations?limit=50');
        await h.reply(first + 1, 200, listing());
        expect(h.requests[first + 2].url).toBe('/api/dashboard/bootstrap');
        expect(h.requests[first + 2].init.headers['X-NoFries-Dashboard-Generation']).toBe(value.generation);
        await h.reply(first + 2, 200, model);
        expect(h.requests[first + 3].url).toBe('/api/dashboard/session');
        locked(h);
        await h.reply(first + 3, 200, final);
    }
    // Leave exactly one of the four authority reads pending.
    async function pendingStage(h, stage) {
        const first = h.requests.length;
        h.window.dispatch('focus'); await flush();
        locked(h);
        if (stage === 'session') return first;
        await h.reply(first, 200, state());
        locked(h);
        if (stage === 'directory') return first + 1;
        await h.reply(first + 1, 200, listing());
        locked(h);
        if (stage === 'bootstrap') return first + 2;
        await h.reply(first + 2, 200, projection());
        locked(h);
        expect(h.requests[first + 3].url).toBe('/api/dashboard/session');
        return first + 3;
    }

    test('focus storms coalesce while retaining the genuine route, main and listeners until both session checks pass', async () => {
        const h = await mounted(state(), { hash: '#overview' });
        h.elements.dashboardApp.querySelectorAll('a').find(link => link.href === '#services').click();
        const main = h.elements.dashboardApp.querySelector('main');
        const heading = h.elements.dashboardApp.querySelector('h1');
        const listeners = ['hashchange', 'popstate'].map(name => h.window.listenerCount(name));
        const fresh = state(A, GA, { expiresAt: '2026-09-09T01:30:00.000Z' });
        const later = JSON.parse(JSON.stringify(projection()));
        later.generatedAt = '2026-09-08T23:30:01.000Z';
        for (let index = 0; index < 12; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(5); locked(h);
        await h.reply(4, 200, fresh);
        for (let index = 0; index < 12; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(7); locked(h);
        await h.reply(5, 200, listing());
        for (let index = 0; index < 12; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(7); locked(h);
        await h.reply(6, 200, later);
        for (let index = 0; index < 12; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(8); locked(h);
        expect(h.requests[7].url).toBe('/api/dashboard/session');
        await h.reply(7, 200, fresh);
        expect(h.status).toBe('ready');
        expect(h.elements.dashboardApp.hidden).toBe(false);
        expect(h.elements.dashboardApp.inert).toBe(false);
        expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
        expect(h.elements.dashboardApp.querySelector('h1')).toBe(heading);
        expect(heading.textContent).toBe('Services'); expect(h.window.location.hash).toBe('#services');
        expect(h.mounts).toHaveLength(1); expect(h.native).toHaveLength(2);
        expect(['hashchange', 'popstate'].map(name => h.window.listenerCount(name))).toEqual(listeners);
        expect(h.requests.slice(4).map(item => item.url)).toEqual([
            '/api/dashboard/session', '/api/dashboard/organisations?limit=50',
            '/api/dashboard/bootstrap', '/api/dashboard/session'
        ]);
        for (const item of h.requests.slice(4)) {
            expect(item.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
            expect(item.init).not.toHaveProperty('body');
        }
    });

    test('a fresh directory replaces cross-tab organisation labels without replacing an unchanged mount', async () => {
        const h = await mounted(); const main = h.elements.dashboardApp.querySelector('main');
        h.window.dispatch('focus'); await flush(); await h.reply(4, 200, state());
        const changed = listing([A, C]); changed.bindings[0].organisationLabel = 'Renamed authorised organisation';
        await h.reply(5, 200, changed); await h.reply(6, 200, projection()); locked(h);
        await h.reply(7, 200, state());
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
        expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
        expect(h.elements.dashboardChoices.children.map(item => item.textContent)).toEqual([
            'Renamed authorised organisation', 'Organisation 3'
        ]);
        expect(h.elements.dashboardChoices.textContent).not.toContain('Organisation 2');
        h.elements.dashboardChoices.children[1].click(); await flush();
        expect(JSON.parse(h.requests[8].init.body)).toMatchObject({ bindingId: C, expectedGeneration: GA });
    });

    test.each([
        ['generation', state(), state(A, GB)],
        ['binding', state(), state(B, GA)],
        ['purpose', state(), state(A, GA, { purpose: 'customer' })],
        ['activation capability added', state(), state(A, GA, { activationAvailable: true })],
        ['activation capability removed', state(A, GA, { activationAvailable: true }), state()],
        ['account type', state(A, GA, { purpose: 'customer', accountType: 'company' }), state(A, GA, { purpose: 'customer', accountType: 'consultant' })],
        ['client setup capability added', state(A, GA, { purpose: 'customer', accountType: 'consultant' }), state(A, GA, { purpose: 'customer', accountType: 'consultant', clientSetupAvailable: true })],
        ['client setup capability removed', state(A, GA, { purpose: 'customer', accountType: 'consultant', clientSetupAvailable: true }), state(A, GA, { purpose: 'customer', accountType: 'consultant' })]
    ])('changed %s starts full reconciliation rather than revealing the retained mount', async (_name, initial, fresh) => {
        const h = await mounted(initial); h.window.dispatch('focus'); await flush(); locked(h);
        await h.reply(4, 200, fresh);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.elements.dashboardApp.hidden).toBe(true); expect(h.status).toBe('loading');
        expect(h.requests[5].url).toBe('/api/dashboard/session');
        expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
    });

    test.each([
        ['organisation', model => { model.context.organisationId = 'another-authorised-organisation'; }],
        ['display name', model => { model.context.displayName = 'Renamed current organisation'; }],
        ['audience', model => { model.audience = 'Executive / board'; }],
        ['subscription', model => { model.subscription = 'Score'; }],
        ['module permission removed', model => { model.modules = model.modules.filter(item => item.key !== 'it_optimisation'); }],
        ['module disabled', model => { model.modules.find(item => item.key === 'it_optimisation').state = 'disabled'; }],
        ['service state', model => { model.services[0].state = 'disabled'; }],
        ['summary state', model => { model.summary.state = 'stale'; }],
        ['attention display', model => { model.summary.attention[0].title = 'New current action'; }],
        ['metric display', model => { model.summary.metrics[0].value = '65%'; }]
    ])('changed validated %s display contract clears the old mount and starts full reconciliation', async (_name, change) => {
        const h = await mounted(); const index = await pendingStage(h, 'bootstrap');
        const model = JSON.parse(JSON.stringify(projection())); change(model);
        // Keep this a valid server projection so the case proves comparison,
        // rather than merely proving that invalid input is rejected.
        expect(() => shell.validate(model)).not.toThrow();
        await h.reply(index, 200, model);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.elements.dashboardApp.hidden).toBe(true); expect(h.status).toBe('loading');
        expect(h.requests[index + 1].url).toBe('/api/dashboard/session');
    });

    test.each([
        ['invalid organisation', model => { model.context.organisationId = ''; }],
        ['duplicate module', model => { model.modules.push({ ...model.modules[0] }); }],
        ['invalid summary', model => { model.summary.metrics[0].asAt = 'invalid'; }],
        ['admission claim', model => { model.admissionGranted = true; }],
        ['provider access claim', model => { model.providerAccessGranted = true; }]
    ])('invalid refresh %s fails closed and cannot reveal a previously valid mount', async (_name, change) => {
        const h = await mounted(); const index = await pendingStage(h, 'bootstrap');
        const model = JSON.parse(JSON.stringify(projection())); change(model);
        await h.reply(index, 200, model);
        expect(h.status).toBe('unavailable'); expect(h.elements.dashboardApp.hidden).toBe(true);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests).toHaveLength(index + 1);
    });

    test.each([
        ['generation', state(A, GB)], ['binding', state(B, GA)],
        ['purpose', state(A, GA, { purpose: 'customer' })]
    ])('changed final-session %s cannot reveal the matching earlier projection', async (_name, final) => {
        const h = await mounted(); const index = await pendingStage(h, 'final session');
        await h.reply(index, 200, final);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.elements.dashboardApp.hidden).toBe(true); expect(h.status).toBe('loading');
        expect(h.requests[index + 1].url).toBe('/api/dashboard/session');
    });

    test.each([
        ['401', 401, { code: 'authentication_required' }, 'expired'],
        ['403', 403, { code: 'dashboard_access_denied' }, 'denied'],
        ['expired value', 200, state(A, GA, { expiresAt: NOW }), 'expired']
    ])('final-session %s clears the retained mount after matching earlier reads', async (_name, status, value, expected) => {
        const h = await mounted(); const index = await pendingStage(h, 'final session');
        await h.reply(index, status, value);
        expect(h.status).toBe(expected); expect(h.elements.dashboardApp.hidden).toBe(true);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        expect(h.requests).toHaveLength(index + 1);
    });

    test.each(['session', 'directory', 'bootstrap', 'final session'].flatMap(stage =>
        ['network', '503', 'timeout'].map(outcome => [stage, outcome])))
        ('%s %s retains its unexpired view until an explicit fresh retry', async (stage, outcome) => {
            const h = await mounted(); const main = h.elements.dashboardApp.querySelector('main');
            const index = await pendingStage(h, stage);
            if (outcome === 'network') { h.requests[index].reject(new Error('synthetic network failure')); await flush(); }
            else if (outcome === '503') await h.reply(index, 503, { code: 'dashboard_unavailable' });
            else { jest.advanceTimersByTime(12000); await flush(); }
            expect(h.status).toBe('ready'); locked(h);
            expect(h.elements.dashboardStatus.textContent).toContain('Could not refresh access');
            const count = h.requests.length;
            expect(h.requests).toHaveLength(count);
            h.click('dashboardRetry'); await flush();
            await finishRefresh(h, count);
            expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
            expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
            expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
            expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
        });

    test('a focus after an outage performs fresh reads and can reuse only after the final session check', async () => {
        const h = await mounted(); h.window.dispatch('focus'); await flush();
        await h.reply(4, 503, { code: 'dashboard_unavailable' }); locked(h);
        h.window.dispatch('focus'); await flush(); await finishRefresh(h, 5);
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
    });

    test('local expiry clears a retained mount and a late successful read cannot extend its expired authority', async () => {
        const h = await mounted(state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        h.window.dispatch('focus'); await flush(); const old = h.requests[4]; locked(h);
        jest.advanceTimersByTime(2000); await flush();
        expect(h.status).toBe('expired'); expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        old.resolve(response(200, state())); await flush();
        expect(h.status).toBe('expired'); expect(h.requests).toHaveLength(5);
        expect(h.elements.dashboardApp.hidden).toBe(true);
    });

    test('only completed fresh checks replace the old expiry timer with the server-confirmed expiry', async () => {
        const h = await mounted(state(A, GA, { expiresAt: '2026-09-08T23:30:02.000Z' }));
        const renewed = state(A, GA, { expiresAt: '2026-09-08T23:30:05.000Z' });
        h.window.dispatch('focus'); await flush(); await finishRefresh(h, 4, renewed);
        jest.advanceTimersByTime(2000); await flush();
        expect(h.status).toBe('ready'); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        jest.advanceTimersByTime(3000); await flush();
        expect(h.status).toBe('expired'); expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
    });

    test('JSON arriving after a refresh deadline cannot unlock content or replace the current retry', async () => {
        const h = await mounted(); const index = await pendingStage(h, 'final session');
        const body = deferred(); await h.reply(index, 200, null, { json: () => body.promise });
        jest.advanceTimersByTime(12000); await flush(); expect(h.status).toBe('ready'); locked(h);
        h.click('dashboardRetry'); await flush(); const retry = h.requests.length - 1;
        body.resolve(state(B, GB)); await flush(); locked(h);
        expect(h.requests).toHaveLength(retry + 1);
        await finishRefresh(h, retry);
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
    });

    test.each(['bootstrap', 'final session'].flatMap(stage => ['success', 'error'].map(outcome => [stage, outcome])))
        ('late %s %s after pagehide cannot affect the newer BFCache-return mount', async (stage, outcome) => {
            const h = await mounted(); const index = await pendingStage(h, stage); const old = h.requests[index];
            h.window.dispatch('pagehide');
            expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
            expect(h.elements.dashboardApp.children).toHaveLength(0);
            h.event('pageshow', { persisted: true }); await flush(); const first = h.requests.length - 1;
            expect(h.requests[first].url).toBe('/api/dashboard/session');
            await h.open(state(B, GB), 'Fresh organisation after cached return', first);
            const main = h.elements.dashboardApp.querySelector('main'), focus = h.document.activeElement;
            if (outcome === 'error') old.reject(new Error('obsolete response'));
            else old.resolve(response(200, stage === 'bootstrap' ? projection('Obsolete organisation') : state()));
            await flush();
            expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.hidden).toBe(false);
            expect(h.elements.dashboardApp.inert).toBe(false);
            expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
            expect(h.document.activeElement).toBe(focus); expect(h.mounts).toHaveLength(2);
            expect(h.mounts[1].destroy).not.toHaveBeenCalled();
            expect(h.elements.dashboardApp.textContent).toContain('Fresh organisation after cached return');
            expect(h.elements.dashboardApp.textContent).not.toContain('Obsolete organisation');
        });

    test.each(['selection', 'logout'])('focus storms during pending %s never retry its mutation automatically', async kind => {
        const h = await mounted();
        if (kind === 'selection') h.elements.dashboardChoices.children[1].click();
        else h.click('dashboardSignOut');
        await flush(); const original = h.requests[4]; expect(original.init.method).toBe('POST');
        for (let index = 0; index < 12; index++) h.window.dispatch('focus');
        await flush(); expect(h.requests).toHaveLength(5);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        original.resolve(response(200, kind === 'selection'
            ? { schemaVersion: 1, generation: GB, selectedBindingId: B }
            : { schemaVersion: 1, loggedOut: true }));
        await flush(); expect(h.requests).toHaveLength(5);
        expect(h.window.location.assign).not.toHaveBeenCalled();
        h.click('dashboardRetry'); await flush();
        expect(h.requests[5].url).toBe(original.url);
        expect(h.requests[5].init.body).toBe(original.init.body);
    });
});

describe('consultant directory refresh pagination', () => {
    const portfolioId = number => '20000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
    const portfolioRow = number => ({ bindingId: portfolioId(number), organisationLabel: 'Portfolio organisation ' + number });
    const portfolioRows = Array.from({ length: 105 }, (_, index) => portfolioRow((index + 1) * 2));
    const account = extra => state(null, GA, { purpose: 'customer', accountType: 'consultant', ...extra });
    const page = (rows, nextAfterBindingId = null) => ({ schemaVersion: 1, bindings: rows, nextAfterBindingId });
    const pages = (rows = portfolioRows, hasMore = false) => [
        page(rows.slice(0, 50), rows[49].bindingId),
        page(rows.slice(50, 100), rows[99].bindingId),
        page(rows.slice(100), hasMore ? rows[rows.length - 1].bindingId : null)
    ];
    const readyChoices = h => h.elements.dashboardChoices.children.filter(node => node.tagName === 'BUTTON');
    const labels = h => readyChoices(h).map(node => node.textContent);
    const savedClients = { csrfToken: 'c'.repeat(43), state: { status: 'clients', remaining: 2,
        clients: [{ requestId: portfolioId(999), organisationName: 'Retained saved setup', status: 'pending' }] } };

    async function loadedPortfolio(options = {}) {
        const value = account(options.account), loadedPages = pages(portfolioRows, options.hasMore);
        const h = harness({ hash: '#organisations' }); await flush();
        await h.reply(0, 200, value);
        for (let index = 0; index < loadedPages.length; index++) {
            if (index) { h.click('dashboardMore'); await flush(); }
            const next = h.requests.length - 1;
            expect(h.requests[next].url).toBe('/api/dashboard/organisations?limit=50' +
                (index ? '&afterBindingId=' + loadedPages[index - 1].nextAfterBindingId : ''));
            await h.reply(next, 200, loadedPages[index]);
            if (value.clientSetupAvailable) {
                expect(h.requests[h.requests.length - 1].url).toBe('/api/customer-signup/clients');
                await h.reply(h.requests.length - 1, 200, savedClients);
            }
        }
        expect(h.status).toBe('selection'); expect(readyChoices(h)).toHaveLength(105);
        return { h, value, loadedPages };
    }
    async function startRefresh(h, value) {
        h.event('focus'); await flush();
        const first = h.requests.length - 1;
        expect(h.requests[first].url).toBe('/api/dashboard/session');
        await h.reply(first, 200, value);
        return first;
    }
    async function refreshedPages(h, freshPages, first) {
        for (let index = 0; index < freshPages.length; index++) {
            expect(h.requests[first + index].url).toBe('/api/dashboard/organisations?limit=50' +
                (index ? '&afterBindingId=' + freshPages[index - 1].nextAfterBindingId : ''));
            await h.reply(first + index, 200, freshPages[index]);
        }
        const witness = first + freshPages.length;
        expect(h.requests[witness].url).toBe('/api/dashboard/session');
        return witness;
    }

    test('refreshes all three explicitly loaded pages and stages 105 rows until the final session witness', async () => {
        const { h, value, loadedPages } = await loadedPortfolio();
        const original = readyChoices(h), focused = original[104]; focused.focus();
        const first = await startRefresh(h, value);
        for (let index = 0; index < loadedPages.length; index++) {
            expect(h.requests[first + 1 + index].url).toBe('/api/dashboard/organisations?limit=50' +
                (index ? '&afterBindingId=' + loadedPages[index - 1].nextAfterBindingId : ''));
            await h.reply(first + 1 + index, 200, loadedPages[index]);
            expect(readyChoices(h).length).toBe(original.length);
            expect(readyChoices(h).every((node, position) => node === original[position])).toBe(true);
            expect(h.document.activeElement).toBe(focused);
        }
        expect(h.requests[first + 4].url).toBe('/api/dashboard/session');
        await h.reply(first + 4, 200, value);
        expect(labels(h)).toEqual(portfolioRows.map(row => row.organisationLabel));
        expect(readyChoices(h).every((node, position) => node === original[position])).toBe(true);
        expect(h.document.activeElement).toBe(focused);
        expect(h.elements.dashboardMore.hidden).toBe(true);
        expect(h.requests.slice(first).filter(request => request.url.startsWith('/api/dashboard/organisations'))).toHaveLength(3);
        expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
    });

    test('follows fresh page cursors after insertion and deletion instead of replaying old page boundaries', async () => {
        const { h, value, loadedPages } = await loadedPortfolio();
        const updated = [portfolioRow(1), ...portfolioRows.filter(row => row.bindingId !== portfolioId(140))];
        updated[80] = { ...updated[80], organisationLabel: 'Renamed authorised organisation' };
        const freshPages = pages(updated), before = labels(h);
        expect(freshPages[0].nextAfterBindingId).not.toBe(loadedPages[0].nextAfterBindingId);
        const first = await startRefresh(h, value);
        const witness = await refreshedPages(h, freshPages, first + 1);
        expect(labels(h)).toEqual(before);
        await h.reply(witness, 200, value);
        expect(labels(h)).toEqual(updated.map(row => row.organisationLabel));
        expect(labels(h)).not.toContain('Portfolio organisation 140');
        expect(h.elements.dashboardMore.hidden).toBe(true);
    });

    test('stops at an early end and remembers the smaller loaded page count for the next focus', async () => {
        const { h, value } = await loadedPortfolio();
        const shortened = page([portfolioRow(2)]);
        let first = await startRefresh(h, value);
        let witness = await refreshedPages(h, [shortened], first + 1);
        await h.reply(witness, 200, value);
        expect(labels(h)).toEqual(['Portfolio organisation 2']);
        expect(h.elements.dashboardMore.hidden).toBe(true);
        const newlyExtended = page([portfolioRow(2)], portfolioId(2));
        first = await startRefresh(h, value);
        witness = await refreshedPages(h, [newlyExtended], first + 1);
        await h.reply(witness, 200, value);
        expect(h.requests).toHaveLength(witness + 1);
        expect(labels(h)).toEqual(['Portfolio organisation 2']);
        expect(h.elements.dashboardMore.hidden).toBe(false);
    });

    test('never speculatively requests a fourth page and coalesces focus through later pages and the witness', async () => {
        const { h, value, loadedPages } = await loadedPortfolio({ hasMore: true });
        const first = await startRefresh(h, value);
        for (let index = 0; index < loadedPages.length; index++) {
            for (let focus = 0; focus < 20; focus++) h.event('focus');
            await flush(); expect(h.requests).toHaveLength(first + 2 + index);
            await h.reply(first + 1 + index, 200, loadedPages[index]);
        }
        for (let focus = 0; focus < 20; focus++) h.event('focus');
        await flush(); expect(h.requests).toHaveLength(first + 5);
        expect(h.requests[first + 4].url).toBe('/api/dashboard/session');
        await h.reply(first + 4, 200, value);
        expect(h.requests).toHaveLength(first + 5); expect(readyChoices(h)).toHaveLength(105);
        expect(h.elements.dashboardMore.hidden).toBe(false);
    });

    test.each([2, 3].flatMap(laterPage => [401, 403, 'malformed'].map(outcome => [laterPage, outcome])))
        ('a page %s %s result clears every old label without starting a later read', async (laterPage, outcome) => {
            const { h, value, loadedPages } = await loadedPortfolio();
            const first = await startRefresh(h, value);
            for (let index = 0; index < laterPage - 1; index++) await h.reply(first + 1 + index, 200, loadedPages[index]);
            const failed = first + laterPage;
            expect(h.requests[failed].url).toContain('/api/dashboard/organisations?limit=50&afterBindingId=');
            if (outcome === 'malformed') await h.reply(failed, 200, page([portfolioRows[0]]));
            else await h.reply(failed, outcome, { code: 'dashboard_binding_denied' });
            expect(h.status).toBe(outcome === 401 ? 'expired' : outcome === 403 ? 'denied' : 'unavailable');
            expect(h.elements.dashboardChoices.children).toHaveLength(0);
            expect(h.requests).toHaveLength(failed + 1);
            expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
        });

    test.each([2, 3])('page %s outage retains the complete old list and retry refreshes the same loaded horizon', async laterPage => {
        const { h, value, loadedPages } = await loadedPortfolio();
        const before = labels(h), first = await startRefresh(h, value);
        for (let index = 0; index < laterPage - 1; index++) await h.reply(first + 1 + index, 200, loadedPages[index]);
        await h.reply(first + laterPage, 503, { code: 'dashboard_unavailable' });
        expect(h.status).toBe('selection'); expect(labels(h)).toEqual(before);
        expect(h.elements.dashboardRetry.hidden).toBe(false);
        expect(h.requests).toHaveLength(first + laterPage + 1);
        h.click('dashboardRetry'); await flush();
        const retry = h.requests.length - 1;
        expect(h.requests[retry].url).toBe('/api/dashboard/session'); await h.reply(retry, 200, value);
        const witness = await refreshedPages(h, loadedPages, retry + 1);
        expect(labels(h)).toEqual(before); await h.reply(witness, 200, value);
        expect(labels(h)).toEqual(before); expect(h.elements.dashboardRetry.hidden).toBe(true);
    });

    test('selection during a slow second page aborts refresh and late data cannot restore the old list', async () => {
        const { h, value, loadedPages } = await loadedPortfolio();
        const choice = readyChoices(h)[104], first = await startRefresh(h, value);
        await h.reply(first + 1, 200, loadedPages[0]);
        const held = h.requests[first + 2];
        expect(held.url).toContain('&afterBindingId='); choice.click(); await flush();
        expect(held.init.signal.aborted).toBe(true);
        const selection = h.requests.length - 1;
        expect(h.requests[selection].url).toBe('/api/dashboard/selection');
        expect(JSON.parse(h.requests[selection].init.body)).toMatchObject({ bindingId: portfolioRows[104].bindingId, expectedGeneration: GA });
        await h.reply(selection, 403, { code: 'dashboard_binding_denied' });
        held.resolve(response(200, loadedPages[1])); await flush();
        expect(h.status).toBe('denied'); expect(h.elements.dashboardChoices.children).toHaveLength(0);
        expect(h.requests).toHaveLength(selection + 1);
    });

    test('the original expiry aborts a slow later page and late success cannot extend authority', async () => {
        const { h, value, loadedPages } = await loadedPortfolio({ account: { expiresAt: '2026-09-08T23:30:02.000Z' } });
        const first = await startRefresh(h, value); await h.reply(first + 1, 200, loadedPages[0]);
        const held = h.requests[first + 2]; expect(held.url).toContain('&afterBindingId=');
        jest.advanceTimersByTime(2000); await flush();
        expect(held.init.signal.aborted).toBe(true); expect(h.status).toBe('expired');
        held.resolve(response(200, loadedPages[1])); await flush();
        expect(h.status).toBe('expired'); expect(h.elements.dashboardChoices.children).toHaveLength(0);
        expect(h.requests).toHaveLength(first + 3);
    });

    test('a changed final session discards all staged pages and starts a fresh authority cycle', async () => {
        const { h, value, loadedPages } = await loadedPortfolio();
        const published = [], originalReplace = h.elements.dashboardChoices.replaceChildren;
        h.elements.dashboardChoices.replaceChildren = function (...nodes) {
            published.push(nodes.filter(node => node.tagName === 'BUTTON').map(node => node.textContent));
            return originalReplace.apply(this, nodes);
        };
        const staged = loadedPages.map(entry => page(entry.bindings.map(row =>
            ({ ...row, organisationLabel: 'Staged ' + row.organisationLabel })), entry.nextAfterBindingId));
        const first = await startRefresh(h, value);
        const witness = await refreshedPages(h, staged, first + 1);
        expect(published).toHaveLength(0);
        const changed = state(null, GB, { purpose: 'customer', accountType: 'consultant' });
        await h.reply(witness, 200, changed);
        expect(h.status).toBe('loading'); expect(readyChoices(h)).toHaveLength(0);
        expect(published.every(rows => rows.length === 0)).toBe(true);
        expect(h.requests[witness + 1].url).toBe('/api/dashboard/session');
        await h.reply(witness + 1, 200, changed);
        await h.reply(witness + 2, 200, page([portfolioRow(500)]));
        expect(labels(h)).toEqual(['Portfolio organisation 500']);
        expect(published.flat().some(label => label.startsWith('Staged '))).toBe(false);
    });

    test.each(['pending action', 'unsaved form'])('all loaded pages refresh while retaining the same %s and focus', async focusedTarget => {
        const { h, value, loadedPages } = await loadedPortfolio({ account: { clientSetupAvailable: true } });
        const section = h.document.getElementById('clientSetupControls');
        const savedRow = h.elements.dashboardChoices.querySelector('.client-workspace-row');
        const savedAction = savedRow.querySelector('button');
        let form = null, focused = savedAction;
        if (focusedTarget === 'unsaved form') {
            section.querySelectorAll('button').find(button => button.textContent === 'Add organisation').click();
            form = section.querySelector('form'); focused = form.querySelector('input'); focused.value = 'Retained draft organisation';
        }
        focused.focus(); const first = await startRefresh(h, value);
        const refreshed = loadedPages.map((entry, index) => index ? entry : page(entry.bindings.map((row, rowIndex) =>
            rowIndex ? row : { ...row, organisationLabel: 'Renamed own consultancy' }), entry.nextAfterBindingId));
        const witness = await refreshedPages(h, refreshed, first + 1);
        expect(readyChoices(h)).toHaveLength(105); expect(h.document.activeElement).toBe(focused);
        await h.reply(witness, 200, value);
        expect(readyChoices(h)).toHaveLength(105);
        expect(h.document.getElementById('clientSetupControls')).toBe(section);
        expect(h.elements.dashboardChoices.querySelector('.client-workspace-row')).toBe(savedRow);
        expect(savedRow.querySelector('button')).toBe(savedAction); expect(h.document.activeElement).toBe(focused);
        if (form) { expect(section.querySelector('form')).toBe(form); expect(focused.value).toBe('Retained draft organisation'); }
        expect(labels(h)[0]).toBe('Renamed own consultancy');
        expect(h.requests.slice(first).every(request => request.init.method === 'GET')).toBe(true);
    });
});

describe('More keyboard continuation', () => {
    const binding = number => '30000000-0000-4000-8000-' + String(number).padStart(12, '0');
    const rows = Array.from({ length: 105 }, (_, index) => ({ bindingId: binding(index + 1), organisationLabel: 'Keyboard organisation ' + (index + 1) }));
    const account = extra => state(null, GA, { purpose: 'customer', accountType: 'consultant', ...extra });
    const page = (bindings, nextAfterBindingId = null) => ({ schemaVersion: 1, bindings, nextAfterBindingId });
    const ready = h => h.elements.dashboardChoices.children.filter(node => node.tagName === 'BUTTON');
    async function initial(extra) {
        const h = harness({ hash: '#organisations' }); await flush();
        await h.reply(0, 200, account(extra)); await h.reply(1, 200, page(rows.slice(0, 50), binding(50)));
        expect(h.status).toBe('selection'); expect(ready(h)).toHaveLength(50);
        h.headingFocus = jest.spyOn(h.elements.dashboardHeading, 'focus');
        return h;
    }
    async function more(h, focused = true) {
        if (focused) h.elements.dashboardMore.focus();
        h.headingFocus.mockClear();
        const index = h.requests.length; h.click('dashboardMore'); await flush();
        expect(h.requests[index].url).toMatch(/^\/api\/dashboard\/organisations\?limit=50&afterBindingId=/);
        return index;
    }
    // The shared minimal DOM does not synthesize bubbling native focus events.
    // Deliver those events explicitly here; the independent browser probe owns
    // actual Tab/Space order and focus loss when More becomes hidden.
    function focused(h, target) {
        target.focus(); h.event('focusin', { type: 'focusin', target });
    }

    test.each(['retained control', 'automatic body fallback'])('continues directly at rows51 and101 without H1 double focus (%s)', async fallback => {
        const h = await initial();
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true);
        let next = await more(h);
        if (fallback === 'automatic body fallback') focused(h, h.document.body);
        await h.reply(next, 200, page(rows.slice(50, 100), binding(100)));
        expect(ready(h)).toHaveLength(100); expect(h.document.activeElement === ready(h)[50]).toBe(true);
        expect(h.document.activeElement.getAttribute('data-binding-id')).toBe(binding(51));
        expect(h.headingFocus).not.toHaveBeenCalled();
        expect(h.window.listenerCount('focusin')).toBe(0);
        next = await more(h);
        if (fallback === 'automatic body fallback') focused(h, h.document.body);
        await h.reply(next, 200, page(rows.slice(100)));
        expect(ready(h)).toHaveLength(105); expect(h.document.activeElement === ready(h)[100]).toBe(true);
        expect(h.document.activeElement.getAttribute('data-binding-id')).toBe(binding(101));
        expect(h.elements.dashboardMore.hidden).toBe(true); expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test('respects native focus movement to another control during the pending page', async () => {
        const h = await initial(), index = await more(h);
        focused(h, h.elements.dashboardSkipLink);
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(ready(h)).toHaveLength(100); expect(h.document.activeElement === h.elements.dashboardSkipLink).toBe(true);
        expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test('latches deliberate focus movement even when focus subsequently returns to the body', async () => {
        const h = await initial(), index = await more(h);
        focused(h, h.elements.dashboardSkipLink); focused(h, h.document.body);
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(h.document.activeElement === h.document.body).toBe(true); expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test.each(['pointerdown', 'keydown', 'blur'])('respects %s while More is pending even without a new focus target', async type => {
        const h = await initial(), index = await more(h);
        focused(h, h.document.body);
        h.event(type, { type, key: 'Tab', target: h.document.body });
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(h.document.activeElement === h.document.body).toBe(true); expect(h.headingFocus).not.toHaveBeenCalled();
        expect(h.window.listenerCount(type)).toBe(0);
    });
    test('does not invent focus ownership for a programmatic More activation', async () => {
        const h = await initial(); focused(h, h.elements.dashboardSkipLink);
        const index = await more(h, false);
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(h.document.activeElement === h.elements.dashboardSkipLink).toBe(true); expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test('uses the last retained ready row when the final page is empty and More becomes hidden', async () => {
        const h = await initial(), index = await more(h); focused(h, h.document.body);
        await h.reply(index, 200, page([]));
        expect(ready(h)).toHaveLength(50); expect(h.elements.dashboardMore.hidden).toBe(true);
        expect(h.document.activeElement === ready(h)[49]).toBe(true); expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test('a disposed cycle removes focus listeners and a late page cannot move current focus', async () => {
        const h = await initial(), index = await more(h);
        h.event('pagehide'); await flush(); focused(h, h.elements.dashboardSignIn);
        expect(h.window.listenerCount('focusin')).toBe(0); expect(h.requests[index].init.signal.aborted).toBe(true);
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(ready(h)).toHaveLength(0); expect(h.document.activeElement === h.elements.dashboardSignIn).toBe(true);
        expect(h.headingFocus).not.toHaveBeenCalled();
    });
    test('a replacement cycle wins over a stale More response and retains ordinary entry heading focus', async () => {
        const h = await initial(), index = await more(h);
        h.event('focus'); await flush();
        expect(h.requests[index].init.signal.aborted).toBe(true);
        await h.reply(index + 1, 200, account()); await h.reply(index + 2, 200, page(rows.slice(0, 50), binding(50)));
        expect(h.status).toBe('selection'); expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true);
        const headingCalls = h.headingFocus.mock.calls.length;
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(ready(h)).toHaveLength(50); expect(h.headingFocus).toHaveBeenCalledTimes(headingCalls);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true);
    });
    test.each([[401, 'expired'], [403, 'denied'], [503, 'unavailable']])('page status%s preserves the %s heading focus', async (status, expected) => {
        const h = await initial(), index = await more(h); focused(h, h.elements.dashboardSkipLink);
        await h.reply(index, status, { code: 'synthetic_page_failure' });
        expect(h.status).toBe(expected); expect(ready(h)).toHaveLength(0);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true); expect(h.headingFocus).toHaveBeenCalledTimes(1);
        expect(h.window.listenerCount('focusin')).toBe(0);
    });
    test('a request timeout keeps the error heading and a late valid page cannot focus a row', async () => {
        const h = await initial(), index = await more(h);
        jest.advanceTimersByTime(12000); await flush();
        expect(h.status).toBe('unavailable'); expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true);
        await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(ready(h)).toHaveLength(0); expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true);
        expect(h.headingFocus).toHaveBeenCalledTimes(1);
    });
    test.each(['expiry timer', 'clock advanced before timer'])('original session expiry prevents a late focus handoff (%s)', async mode => {
        const h = await initial({ expiresAt: '2026-09-08T23:30:02.000Z' }), index = await more(h);
        if (mode === 'expiry timer') jest.advanceTimersByTime(2000);
        else jest.setSystemTime(new Date('2026-09-08T23:30:02.000Z'));
        await flush(); await h.reply(index, 200, page(rows.slice(50, 100), binding(100)));
        expect(h.status).toBe('expired'); expect(ready(h)).toHaveLength(0);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true); expect(h.headingFocus).toHaveBeenCalledTimes(1);
    });
    test('an invalid page retains ordinary unavailable heading focus', async () => {
        const h = await initial(), index = await more(h);
        await h.reply(index, 200, page([rows[49]]));
        expect(h.status).toBe('unavailable'); expect(ready(h)).toHaveLength(0);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true); expect(h.headingFocus).toHaveBeenCalledTimes(1);
    });
});

describe('Consultant paging view', () => {
    const binding = number => '40000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
    const rows = Array.from({ length: 100 }, (_, index) => ({ bindingId: binding(index + 1), organisationLabel: 'Workspace ' + (index + 1) }));
    const page = (bindings, nextAfterBindingId = null) => ({ schemaVersion: 1, bindings, nextAfterBindingId });
    const account = extra => state(A, GA, { purpose: 'customer', accountType: 'consultant', ...extra });
    const readyRows = h => h.elements.dashboardChoices.children.filter(node => node.tagName === 'BUTTON');
    const button = (h, label) => h.elements.dashboardApp.querySelectorAll('button').find(node => node.textContent === label);

    async function mounted(hash = '#overview', value = account()) {
        const h = harness({ hash, cyber: hash === '#cyber-security' }); await flush();
        await h.reply(0, 200, value); await h.reply(1, 200, page(rows.slice(0, 50), binding(50)));
        const model = JSON.parse(JSON.stringify(projection()));
        if (hash === '#cyber-security') model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        await h.reply(2, 200, model); h.load(0); h.load(1); await flush();
        let witness = 3;
        if (hash === '#cyber-security') {
            await h.reply(3, 200, { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
                module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
                services: [], admissionGranted: false, providerAccessGranted: false,
                metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' });
            witness = 4;
        }
        await h.reply(witness, 200, value);
        if (hash === '#cyber-security') await h.reply(5, 200, { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null },
            { headers: { get: () => 'application/json; charset=utf-8' }, text: async () => JSON.stringify({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null }) });
        expect(h.status).toBe('ready'); expect(readyRows(h)).toHaveLength(50);
        return { h, value };
    }
    async function expanded(h) {
        const first = h.requests.length;
        h.elements.dashboardMore.focus(); h.click('dashboardMore'); await flush();
        expect(h.requests[first].url).toBe('/api/dashboard/organisations?limit=50&afterBindingId=' + binding(50));
        await h.reply(first, 200, page(rows.slice(50)));
        expect(h.status).toBe('selection'); expect(readyRows(h)).toHaveLength(100);
        expect(h.mounts[0].destroy).toHaveBeenCalledTimes(1);
        return first;
    }
    function editScope(h) {
        button(h, 'Start an assessment').click();
        const input = h.elements.dashboardApp.querySelector('textarea'); input.value = 'Synthetic retained scope';
        for (const callback of input.events.input) callback();
        return input;
    }

    test.each(['#overview', '#cyber-security'])('mounted %s More adopts the list route and quietly refreshes both loaded pages', async hash => {
        const { h, value } = await mounted(hash); await expanded(h);
        expect(h.window.location.hash).toBe('#organisations');
        expect(h.document.activeElement === readyRows(h)[50]).toBe(true);
        const retained = readyRows(h), focused = retained[80]; focused.focus();
        const first = h.requests.length; h.event('focus'); await flush();
        expect(h.status).toBe('selection'); expect(readyRows(h).every((node, index) => node === retained[index])).toBe(true);
        expect(h.requests[first].url).toBe('/api/dashboard/session'); await h.reply(first, 200, value);
        expect(h.requests[first + 1].url).toBe('/api/dashboard/organisations?limit=50');
        await h.reply(first + 1, 200, page(rows.slice(0, 50), binding(50)));
        expect(h.requests[first + 2].url).toBe('/api/dashboard/organisations?limit=50&afterBindingId=' + binding(50));
        await h.reply(first + 2, 200, page(rows.slice(50)));
        expect(h.requests[first + 3].url).toBe('/api/dashboard/session');
        expect(h.status).toBe('selection'); expect(h.document.activeElement === focused).toBe(true);
        await h.reply(first + 3, 200, value);
        expect(h.requests.slice(first).map(item => item.url)).toEqual(['/api/dashboard/session',
            '/api/dashboard/organisations?limit=50', '/api/dashboard/organisations?limit=50&afterBindingId=' + binding(50), '/api/dashboard/session']);
        expect(h.status).toBe('selection'); expect(readyRows(h)).toHaveLength(100);
        expect(h.document.activeElement === focused).toBe(true); expect(h.mounts).toHaveLength(1);
        expect(h.window.location.hash).toBe('#organisations');

        const selection = h.requests.length; readyRows(h)[80].click(); await flush();
        expect(h.requests[selection].url).toBe('/api/dashboard/selection');
        expect(JSON.parse(h.requests[selection].init.body).bindingId).toBe(binding(81));
        await h.reply(selection, 200, { schemaVersion: 1, generation: GB, selectedBindingId: binding(81) });
        await h.reply(selection + 1, 200, state(binding(81), GB, { purpose: 'customer', accountType: 'consultant' }));
        expect(h.window.location.hash).toBe('#overview');
        expect(h.requests.slice(selection + 2).some(item => item.url === '/api/dashboard/bootstrap')).toBe(true);
    });

    test('operator paging retains its existing dashboard route', async () => {
        const { h } = await mounted('#overview', state()); await expanded(h);
        expect(h.window.location.hash).toBe('#overview');
    });
    test('Company dashboard retains its own workspace controls and route', async () => {
        const { h } = await mounted('#overview', state(A, GA, { purpose: 'customer', accountType: 'company' }));
        expect(h.window.location.hash).toBe('#overview');
        expect(h.document.getElementById('consultantPortfolioControls')).toBeNull();
        expect(h.elements.dashboardMessage.textContent).toBe('View your organisation’s saved assessment and next actions.');
        expect(h.document.getElementById('clientSetupControls')).toBeNull();
    });
    test.each(['Stay here', 'cancel'])('%s preserves the Cyber route, draft and mounted dashboard before More', async choice => {
        const { h } = await mounted('#cyber-security'); const draft = editScope(h), count = h.requests.length;
        h.click('dashboardMore'); await flush();
        expect(h.elements.dashboardApp.querySelector('dialog')).not.toBeNull();
        if (choice === 'Stay here') button(h, choice).click();
        else for (const callback of h.elements.dashboardApp.querySelector('dialog').events.cancel) callback({ preventDefault() {} });
        await flush();
        expect(h.window.location.hash).toBe('#cyber-security'); expect(h.requests).toHaveLength(count);
        expect(h.status).toBe('ready'); expect(h.mounts[0].destroy).not.toHaveBeenCalled();
        expect(h.elements.dashboardApp.querySelector('textarea') === draft).toBe(true);
        expect(draft.value).toBe('Synthetic retained scope');
    });
    test('accepted Cyber discard changes the route only when the guarded navigation commits', async () => {
        const { h } = await mounted('#cyber-security'); editScope(h); const first = h.requests.length;
        h.click('dashboardMore'); await flush(); expect(h.window.location.hash).toBe('#cyber-security');
        h.elements.dashboardMore.focus(); button(h, 'Discard unsent changes').click(); await flush();
        expect(h.window.location.hash).toBe('#organisations');
        await h.reply(first, 200, page(rows.slice(50)));
        expect(h.status).toBe('selection'); expect(readyRows(h)).toHaveLength(100);
        expect(h.document.activeElement === readyRows(h)[50]).toBe(true);
    });
    test('a stale accepted leave callback cannot change the route or issue a directory request', async () => {
        const { h } = await mounted('#cyber-security'); let accept;
        jest.spyOn(h.mounts[0].controller, 'requestLeave').mockImplementation(commit => { accept = commit; return Promise.resolve(false); });
        const count = h.requests.length; h.click('dashboardMore'); await flush();
        expect(typeof accept).toBe('function'); h.event('pagehide'); accept(); await flush();
        expect(h.window.location.hash).toBe('#cyber-security'); expect(h.requests).toHaveLength(count);
        expect(h.elements.dashboardApp.children).toHaveLength(0);
    });
    test.each([401, 403])('More %s denial still clears the list and focuses the ordinary error heading', async status => {
        const { h } = await mounted(); const first = h.requests.length;
        h.click('dashboardMore'); await flush(); await h.reply(first, status, { code: 'dashboard_access_denied' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied'); expect(readyRows(h)).toHaveLength(0);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true); expect(h.requests).toHaveLength(first + 1);
    });
    test('original expiry clears a pending mounted-to-list transition and ignores its late response', async () => {
        const { h } = await mounted('#overview', account({ expiresAt: '2026-09-08T23:30:02.000Z' }));
        const first = h.requests.length; h.click('dashboardMore'); await flush();
        jest.advanceTimersByTime(2000); await flush(); await h.reply(first, 200, page(rows.slice(50)));
        expect(h.status).toBe('expired'); expect(readyRows(h)).toHaveLength(0);
        expect(h.document.activeElement === h.elements.dashboardHeading).toBe(true); expect(h.requests).toHaveLength(first + 1);
    });
});
