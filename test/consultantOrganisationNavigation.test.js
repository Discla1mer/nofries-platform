'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createDom } = require('./fixtures/dashboardDom');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { fixture } = require('./fixtures/dashboardFixture');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');

const SOURCE = fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const D = '10000000-0000-4000-8000-000000000004';
const GA = 'a'.repeat(64);
const GB = 'b'.repeat(64);
const ids = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus',
    'dashboardRetry', 'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices',
    'dashboardMore', 'dashboardApp', 'dashboardApplicationIntegrity', 'dashboardStyleIntegrity', 'dashboardSkipLink'];
const csrfToken = 'c'.repeat(43);
const state = (selectedBindingId = null, generation = GA, extra = {}) => ({ schemaVersion: 1, authenticated: true,
    purpose: 'customer', accountType: 'consultant', expiresAt: '2026-09-09T00:30:00.000Z', generation, selectedBindingId, ...extra });
const listing = (bindings, nextAfterBindingId = null) => ({ schemaVersion: 1, bindings, nextAfterBindingId });
const row = (bindingId, organisationLabel) => ({ bindingId, organisationLabel });
const client = (requestId, organisationName, status) => ({ requestId, organisationName, status });
const clients = (records, remaining = 1) => ({ csrfToken, state: { status: 'clients', clients: records, remaining } });
const projection = name => projectDashboard(fixture({ now: '2026-09-08T23:30:00.000Z', name }));
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, redirected: false, type: 'basic',
    headers: { get: () => 'application/json; charset=utf-8' }, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 35; i += 1) await Promise.resolve(); }

// Actual loader and dashboard shell, with controlled DOM and transport. This
// proves navigation and request identity, not browser layout or live access.
function harness(hash = '#organisations') {
    const { document, window } = createDom();
    const createElement = document.createElement;
    document.createElement = tag => {
        const node = createElement(tag);
        Object.defineProperty(node, 'id', { get: () => node.getAttribute('id') || '', set: value => node.setAttribute('id', value) });
        node.contains = child => node === child || node.children.some(item => item.contains(child));
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
    elements.dashboardApplicationIntegrity.setAttribute('content', sri);
    elements.dashboardStyleIntegrity.setAttribute('content', sri);
    window.location.hash = hash; window.crypto = { randomUUID: crypto.randomUUID }; window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const requests = []; const fetch = (url, init) => { const work = deferred(); requests.push({ url, init, ...work }); return work.promise; };
    vm.runInContext(SOURCE, vm.createContext({ document, window, fetch, AbortController, Date, console }), { filename: 'dashboard-loader.js' });
    async function reply(index, status, value) {
        expect(requests[index]).toBeDefined(); requests[index].resolve(response(status, value)); await flush();
    }
    async function mount(index, value, name) {
        await reply(index, 200, projection(name));
        window.NoFriesDashboard = shell;
        native.slice(-2).forEach(node => node.onload()); await flush();
        await reply(index + 1, 200, value);
    }
    return { document, window, elements, requests, reply, mount,
        get status() { return document.body.dataset.dashboardState; },
        get back() { return document.getElementById('consultantPortfolioControls'); } };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-08T23:30:00.000Z')); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('consultant sees both distinct ready binding IDs, pending setup once, and no ready setup duplicate', async () => {
    const h = harness(); await flush();
    await h.reply(0, 200, state(null, GA, { clientSetupAvailable: true }));
    await h.reply(1, 200, listing([row(A, 'Shared name'), row(B, 'Shared name')]));
    await h.reply(2, 200, clients([client(C, 'Shared name', 'ready'), client(D, 'Draft client', 'pending')]));
    const choices = h.elements.dashboardChoices.children;
    expect(choices).toHaveLength(3);
    expect(choices.slice(0, 2).map(item => item.textContent)).toEqual(['Shared name', 'Shared name']);
    expect(choices.slice(0, 2).map(item => item.getAttribute('aria-label'))).toEqual([
        'Shared name · Dashboard ready', 'Shared name · Dashboard ready']);
    expect(choices[2].textContent).toContain('Draft client');
    expect(h.document.getElementById('clientSetupControls').textContent).toContain('Add organisation');
    choices[1].click(); await flush();
    expect(JSON.parse(h.requests[3].init.body).bindingId).toBe(B);
});

test('empty message follows validated reads, and Company has no client setup', async () => {
    const h = harness(); await flush();
    await h.reply(0, 200, state(null, GA, { clientSetupAvailable: true }));
    await h.reply(1, 200, listing([]));
    expect(h.elements.dashboardChoices.textContent).not.toContain('No organisations');
    await h.reply(2, 200, clients([]));
    expect(h.elements.dashboardChoices.textContent).toContain('No organisations available yet.');
    const company = harness(); await flush();
    await company.reply(0, 200, state(null, GA, { accountType: 'company' }));
    await company.reply(1, 200, listing([row(A, 'Own company')]));
    expect(company.elements.dashboardChoices.children.map(item => item.textContent)).toEqual(['Own company']);
    expect(company.document.getElementById('clientSetupControls')).toBeNull();
});

test('incomplete rows resume by request ID and current zero capacity remains visible', async () => {
    const h = harness(); await flush();
    await h.reply(0, 200, state(null, GA, { clientSetupAvailable: true }));
    await h.reply(1, 200, listing([row(A, 'Own consultancy')]));
    await h.reply(2, 200, clients([client(B, 'Draft client', 'pending'),
        client(C, 'Details client', 'details_required'), client(D, 'Ready client', 'ready')], 0));
    expect(h.elements.dashboardChoices.children).toHaveLength(3);
    expect(h.document.getElementById('clientSetupControls').textContent).toContain('No client slots remain.');
    expect(h.document.getElementById('clientSetupControls').querySelector('form')).toBeNull();
    h.elements.dashboardChoices.children[1].querySelector('button').click(); await flush();
    expect(JSON.parse(h.requests[3].init.body)).toEqual({ action: 'resume', requestId: B });
    await h.reply(3, 200, { csrfToken, state: { status: 'resume_acceptance' } });
    const detail = harness(); await flush();
    await detail.reply(0, 200, state(null, GA, { clientSetupAvailable: true }));
    await detail.reply(1, 200, listing([row(A, 'Own consultancy')]));
    await detail.reply(2, 200, clients([client(C, 'Details client', 'details_required')]));
    detail.elements.dashboardChoices.children[1].querySelector('button').click();
    expect(detail.document.getElementById('clientSetupControls').querySelector('form')).not.toBeNull();
    expect(detail.document.getElementById('clientSetupControls').querySelector('input').value).toBe('Details client');
});

test('selected consultant context has a visible return outside chooser and re-reads access', async () => {
    const h = harness('#overview'); await flush(); const selected = state(A);
    await h.reply(0, 200, selected); await h.reply(1, 200, listing([row(A, 'Own consultancy')]));
    await h.mount(2, selected, 'Own consultancy');
    expect(h.status).toBe('ready');
    expect(h.elements.dashboardHeading.textContent).toBe('Viewing Own consultancy');
    expect(h.back.parentElement).toBe(h.elements.dashboardStatusPanel);
    expect(h.back.hidden).toBe(false);
    h.back.onclick(); await flush();
    expect(h.window.location.hash).toBe('#organisations');
    expect(h.elements.dashboardApp.hidden).toBe(true);
    await h.reply(4, 200, selected); await h.reply(5, 200, listing([row(A, 'Own consultancy')]));
    expect(h.status).toBe('selection'); expect(h.back.hidden).toBe(true);
});

test('directory keeps validated page cursor and foreign selection denial clears the chooser', async () => {
    const h = harness(); await flush();
    await h.reply(0, 200, state()); await h.reply(1, 200, listing([row(A, 'Own consultancy')], A));
    expect(h.elements.dashboardMore.hidden).toBe(false);
    h.elements.dashboardMore.onclick(); await flush();
    expect(h.requests[2].url).toBe('/api/dashboard/organisations?limit=50&afterBindingId=' + A);
    await h.reply(2, 200, listing([row(B, 'Authorised client')]));
    expect(h.elements.dashboardChoices.children.map(item => item.textContent)).toEqual(['Own consultancy', 'Authorised client']);
    h.elements.dashboardChoices.children[1].click(); await flush();
    expect(JSON.parse(h.requests[3].init.body).bindingId).toBe(B);
    await h.reply(3, 403, { code: 'dashboard_binding_denied' });
    expect(h.status).toBe('denied'); expect(h.elements.dashboardChoices.children).toHaveLength(0);
});
