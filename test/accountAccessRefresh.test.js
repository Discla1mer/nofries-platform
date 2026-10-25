'use strict';

// Focused real-loader regressions use the existing synthetic DOM and shell.
// A valid session keeps the displayed page usable during fresh read-only checks.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');
const { createDom } = require('./fixtures/dashboardDom');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { fixture } = require('./fixtures/dashboardFixture');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');

// The opt-in immutable baseline is a causal negative control, never a product edit.
const SOURCE = process.env.NOFRIES_ACCESS_REFRESH_BASELINE === '1'
    ? execFileSync('git', ['show', '1ff04f3fa158c2e166ce408c39df59a16812fe31:js/dashboard-loader.js'],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
const ENTRY_HTML = fs.readFileSync(path.join(__dirname, '../app/dashboard.html'), 'utf8');
const ENTRY_MARKUP = ENTRY_HTML.match(/<(main|div)\s+class="shell"([^>]*)>/);
const NOW = '2026-09-08T23:30:00.000Z';
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const GA = 'a'.repeat(64);
const GB = 'b'.repeat(64);
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
    const dom = createDom(), { document, window } = dom;
    const createElement = document.createElement;
    document.createElement = tag => {
        const element = createElement(tag);
        Object.defineProperty(element, 'id', { get: () => element.getAttribute('id') || '',
            set: value => element.setAttribute('id', value) });
        element.contains = child => element === child || element.children.some(item => item.contains(child));
        return element;
    };
    const elements = Object.fromEntries(ids.map(id => [id, document.createElement('div')]));
    elements.dashboardEntry = document.createElement(ENTRY_MARKUP[1]);
    Object.entries(elements).forEach(([id, element]) => { element.id = id; });
    const findId = (node, id) => !node ? null : node.id === id ? node :
        node.children.map(child => findId(child, id)).find(Boolean) || null;
    document.getElementById = id => elements[id] || findId(document.body, id);
    document.body = document.createElement('body');
    document.body.dataset.page = 'operator-dashboard';
    document.body.dataset.customerProvider = 'legacy';
    document.body.append(elements.dashboardEntry);
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.querySelector = selector => document.body.querySelector(selector);
    elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
    document.head = document.createElement('head');
    const native = [];
    document.head.append = node => { node.parentNode = document.head; native.push(node); document.head.children.push(node); };
    document.head.removeChild = node => {
        document.head.children = document.head.children.filter(item => item !== node); node.parentNode = null;
    };
    const sri = 'sha256-' + crypto.createHash('sha256').update('approved bytes').digest('base64');
    elements.dashboardApplicationIntegrity.setAttribute('content', sri);
    elements.dashboardStyleIntegrity.setAttribute('content', sri);
    window.location.hash = options.hash || '';
    window.location.assign = jest.fn();
    window.crypto = { randomUUID: jest.fn(() => crypto.randomUUID()) };
    window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
    const listeners = {}, originalAdd = window.addEventListener;
    window.addEventListener = (name, callback) => { (listeners[name] ||= []).push(callback); originalAdd(name, callback); };
    const requests = [], mounts = [];
    const fetch = jest.fn((url, init) => {
        const work = deferred(); requests.push({ url, init, ...work }); return work.promise;
    });
    const factory = { validate: jest.fn(shell.validate), mount: jest.fn((root, model, config) => {
        const controller = shell.mount(root, model, config);
        mounts.push({ controller, destroy: jest.spyOn(controller, 'destroy') }); return controller;
    }) };
    const context = vm.createContext({ document, window, fetch, AbortController, Date,
        console: { log: jest.fn(), error: jest.fn() } });
    vm.runInContext(SOURCE, context, { filename: 'dashboard-loader.js' });
    async function reply(index, status, value, extra) {
        expect(requests[index]).toBeDefined(); requests[index].resolve(response(status, value, extra)); await flush();
    }
    function load(index) {
        const node = native[index]; expect(node).toBeDefined();
        if (node.tagName === 'SCRIPT') window.NoFriesDashboard = factory;
        if (node.onload) node.onload();
    }
    async function open(value = state(), name = 'Current organisation', first = requests.length ? requests.length - 1 : 0) {
        await reply(first, 200, value); await reply(first + 1, 200, listing());
        if (value.selectedBindingId === null) return;
        await reply(first + 2, 200, projection(name));
        const index = native.length - 2; load(index); load(index + 1); await flush();
        await reply(first + 3, 200, value);
    }
    return { ...dom, elements, native, requests, reply, load, open, factory, mounts,
        event: (name, data) => (listeners[name] || []).forEach(callback => callback(data)),
        get status() { return document.body.dataset.dashboardState; } };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });


const consultant = () => state(A, GA, { purpose: 'customer', accountType: 'consultant', clientSetupAvailable: true });
const clients = { csrfToken: 'c'.repeat(43), state: { status: 'clients', remaining: 3, clients: [] } };

async function portfolio() {
    const h = harness({ hash: '#organisations' }); await flush();
    await h.reply(0, 200, consultant()); await h.reply(1, 200, listing([A])); await h.reply(2, 200, clients);
    expect(h.status).toBe('selection'); return h;
}
test('account return keeps its view during slow fresh reads and the final witness', async () => {
    const h = await portfolio(); h.event('focus'); await flush();
    const controls = h.document.getElementById('clientSetupControls');
    const choice = h.elements.dashboardChoices.children[0];
    expect(h.status).toBe('selection'); expect(h.document.getElementById('clientSetupControls')).toBe(controls);
    jest.advanceTimersByTime(11000); await h.reply(3, 200, consultant());
    expect(h.status).toBe('selection'); expect(h.requests).toHaveLength(5);
    jest.advanceTimersByTime(11000); await h.reply(4, 200, listing([A]));
    expect(h.status).toBe('selection'); expect(h.elements.dashboardChoices.children[0]).toBe(choice);
    expect(h.requests[5].url).toBe('/api/dashboard/session');
    await h.reply(5, 200, consultant());
    expect(h.status).toBe('selection'); expect(h.document.getElementById('clientSetupControls')).toBe(controls);
});
test('repeated account focus shares one refresh and keeps its client view and read', async () => {
    const h = await portfolio();
    h.event('focus'); await flush();
    for (let index = 0; index < 60; index++) h.event('focus');
    await flush(); expect(h.requests).toHaveLength(4); expect(h.status).toBe('selection');
    await h.reply(3, 200, consultant()); await h.reply(4, 200, listing([A]));
    h.event('focus'); await flush(); expect(h.requests).toHaveLength(6);
    await h.reply(5, 200, consultant());
    expect(h.requests.every(row => row.init.method === 'GET')).toBe(true);
});
test('account focus does not abort a client-list GET already in flight', async () => {
    const h = harness({ hash: '#organisations' }); await flush();
    await h.reply(0, 200, consultant()); await h.reply(1, 200, listing([A]));
    expect(h.requests[2].url).toBe('/api/customer-signup/clients');
    h.event('focus'); await flush();
    for (let index = 0; index < 30; index++) h.event('focus');
    await flush(); expect(h.requests).toHaveLength(4);
    expect(h.requests[2].init.signal.aborted).toBe(false);
    await h.reply(2, 200, clients);
    const section = h.document.getElementById('clientSetupControls');
    await h.reply(3, 200, consultant()); await h.reply(4, 200, listing([A]));
    await h.reply(5, 200, consultant());
    expect(h.document.getElementById('clientSetupControls')).toBe(section);
    expect(h.requests[2].init.signal.aborted).toBe(false);
});
test('unsaved consultant client details remain the same focused form through quiet checks', async () => {
    const h = await portfolio();
    const section = h.document.getElementById('clientSetupControls');
    const add = Array.from(section.querySelectorAll('button')).find(button => button.textContent === 'Add organisation');
    add.click();
    const form = section.querySelector('form'); const input = form.querySelector('input');
    input.value = 'Draft client'; input.focus();
    h.event('focus'); await flush(); expect(h.status).toBe('selection');
    await h.reply(3, 200, consultant()); await h.reply(4, 200, listing([A]));
    expect(h.document.getElementById('clientSetupControls')).toBe(section);
    expect(section.querySelector('form')).toBe(form);
    await h.reply(5, 200, consultant());
    expect(section.querySelector('form')).toBe(form); expect(input.value).toBe('Draft client');
    expect(h.document.activeElement).toBe(input);
});
test('a changed ready directory preserves the pending client row and focused action', async () => {
    const h = harness({ hash: '#organisations' }); await flush();
    await h.reply(0, 200, consultant()); await h.reply(1, 200, listing([A]));
    await h.reply(2, 200, { csrfToken: clients.csrfToken, state: { status: 'clients', remaining: 2,
        clients: [{ requestId: C, organisationName: 'Saved client', status: 'pending' }] } });
    const row = h.elements.dashboardChoices.querySelector('.client-workspace-row');
    const action = row.querySelector('button'); action.focus();
    h.event('focus'); await flush();
    await h.reply(3, 200, consultant()); await h.reply(4, 200, listing([A, B]));
    expect(h.elements.dashboardChoices.querySelector('.client-workspace-row')).toBe(row);
    expect(h.document.activeElement).toBe(action);
    expect(h.elements.dashboardChoices.children.filter(child => child.tagName === 'BUTTON')).toHaveLength(1);
    await h.reply(5, 200, consultant());
    expect(h.elements.dashboardChoices.children.filter(child => child.tagName === 'BUTTON')).toHaveLength(2);
    expect(h.elements.dashboardChoices.querySelector('.client-workspace-row')).toBe(row);
    expect(row.querySelector('button')).toBe(action);
    expect(h.document.activeElement).toBe(action);
    expect(h.requests.every(request => request.init.method === 'GET')).toBe(true);
});
test('an old session expiry clears a displayed account during a slow quiet refresh', async () => {
    const h = harness({ hash: '#organisations' }); await flush();
    const soon = { ...consultant(), expiresAt: new Date(Date.parse(NOW) + 2000).toISOString() };
    await h.reply(0, 200, soon); await h.reply(1, 200, listing([A])); await h.reply(2, 200, clients);
    h.event('focus'); await flush();
    jest.advanceTimersByTime(2000); await flush();
    expect(h.status).toBe('expired'); expect(h.document.getElementById('clientSetupControls')).toBeNull();
    expect(h.requests[3].init.signal.aborted).toBe(true);
    await h.reply(3, 200, consultant()); expect(h.status).toBe('expired');
});
test('overlapping consultant account session/directory focus events share the running reconciliation', async () => {
    const h = await portfolio(); h.event('focus'); await flush(); const first = h.requests.length;
    for (let index = 0; index < 60; index++) h.event('focus');
    await flush(); expect(h.requests).toHaveLength(first);
    await h.reply(3, 200, consultant());
    for (let index = 0; index < 60; index++) h.event('focus');
    await flush(); expect(h.requests).toHaveLength(first + 1);
    await h.reply(4, 200, listing([A])); await h.reply(5, 200, consultant()); expect(h.status).toBe('selection');
});
test('selected consultant mount uses three 11-second rounds after its selection acknowledgement', async () => {
    const h = await portfolio(); h.elements.dashboardChoices.children[0].click(); await flush();
    expect(h.requests[3].init.method).toBe('POST');
    await h.reply(3, 200, { schemaVersion: 1, generation: GA, selectedBindingId: A });
    jest.advanceTimersByTime(11000); await h.reply(4, 200, consultant());
    expect(h.requests.slice(5).map(row => row.url)).toEqual(organisationPaths);
    jest.advanceTimersByTime(11000); await h.reply(5, 200, listing([A])); await h.reply(6, 200, projection());
    h.load(0); h.load(1); await flush();
    expect(h.status).toBe('loading'); jest.advanceTimersByTime(11000); await h.reply(7, 200, consultant());
    expect(h.status).toBe('ready'); expect(h.window.location.hash).toBe('#overview');
    expect(Date.now()).toBe(Date.parse(NOW) + 33000);
});
test('a held consultant session times out after 12 seconds without hiding the account', async () => {
    const h = await portfolio(); h.event('focus'); await flush(); jest.advanceTimersByTime(12000); await flush();
    expect(h.status).toBe('selection'); expect(h.requests[3].init.signal.aborted).toBe(true);
    expect(h.elements.dashboardStatus.textContent).toContain('Could not refresh access');
    expect(h.elements.dashboardRetry.hidden).toBe(false);
});
test('malformed account session fails closed instead of treating bad authority as an outage', async () => {
    const h = await portfolio(); h.event('focus'); await flush();
    await h.reply(3, 200, { authenticated: true });
    expect(h.status).toBe('unavailable');
    expect(h.document.getElementById('clientSetupControls')).toBeNull();
});
test.each([401, 403])('consultant account session %s clears content and does not start directory', async status => {
    const h = await portfolio(); h.event('focus'); await flush(); await h.reply(3, status, { code: 'synthetic_denial' });
    expect(h.status).toBe(status === 401 ? 'expired' : 'denied'); expect(h.requests).toHaveLength(4);
    expect(h.document.getElementById('clientSetupControls')).toBeNull();
});
test('mounted consultant focus displays content through its final witness and coalesces repeated focus', async () => {
    const h = harness({ hash: '#services' }); await flush(); await h.open(consultant()); expect(h.status).toBe('ready');
    const main = h.elements.dashboardApp.querySelector('main'); h.event('focus'); await flush(); await h.reply(4, 200, consultant());
    expect(h.requests.slice(5).map(row => row.url)).toEqual(organisationPaths);
    await h.reply(5, 200, listing()); await h.reply(6, 200, projection());
    expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.hidden).toBe(false); expect(h.elements.dashboardApp.inert).toBe(false);
    for (let index = 0; index < 60; index++) h.event('focus');
    await flush(); expect(h.requests).toHaveLength(8);
    await h.reply(7, 200, consultant()); expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.querySelector('main')).toBe(main);
});
test('mounted consultant final witness denial clears retained content', async () => {
    const h = harness({ hash: '#services' }); await flush(); await h.open(consultant()); h.event('focus'); await flush();
    await h.reply(4, 200, consultant()); await h.reply(5, 200, listing()); await h.reply(6, 200, projection());
    await h.reply(7, 403, { code: 'synthetic_revocation' });
    expect(h.status).toBe('denied'); expect(h.elements.dashboardApp.children).toHaveLength(0);
});
test('invalid quiet directory response clears a mounted view', async () => {
    const h = harness({ hash: '#services' }); await flush(); await h.open(consultant());
    h.event('focus'); await flush(); await h.reply(4, 200, consultant());
    await h.reply(5, 200, { schemaVersion: 1, bindings: [], nextAfterBindingId: 'not-a-uuid' });
    expect(h.status).toBe('unavailable'); expect(h.elements.dashboardApp.children).toHaveLength(0);
    expect(h.requests[6].init.signal.aborted).toBe(true);
});
test('a changed mounted binding clears the old tenant before new reads', async () => {
    const h = harness({ hash: '#services' }); await flush(); await h.open(consultant());
    h.event('focus'); await flush(); expect(h.status).toBe('ready');
    await h.reply(4, 200, state(B, GB, { purpose: 'customer', accountType: 'consultant' }));
    expect(h.status).toBe('loading'); expect(h.elements.dashboardApp.children).toHaveLength(0);
    expect(h.requests[5].url).toBe('/api/dashboard/session');
});
test('focus during pending consultant selection clears presentation without automatically repeating its mutation', async () => {
    const h = await portfolio(); h.elements.dashboardChoices.children[0].click(); await flush();
    const pending = h.requests[3]; h.event('focus'); await flush();
    expect(pending.init.signal.aborted).toBe(true); expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(4);
    pending.resolve(response(200, { schemaVersion: 1, generation: GA, selectedBindingId: A })); await flush();
    expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(4);
});

const organisationPaths = ['/api/dashboard/organisations?limit=50', '/api/dashboard/bootstrap'];
const accounts = [
    ['operator', () => state()],
    ['company', () => state(A, GA, { purpose: 'customer', accountType: 'company' })],
    ['consultant', consultant]
];

describe('selected organisation reconciliation overlaps independent reads', () => {
    test.each(accounts.flatMap(([name, value]) => ['directory', 'bootstrap'].map(first => [name, first, value])))
        ('%s starts both reads after its fresh session; %s completes first', async (_name, first, account) => {
            const h = harness({ hash: '#services' }); await flush();
            expect(h.requests).toHaveLength(1);
            await h.reply(0, 200, account());
            expect(h.requests.slice(1).map(row => row.url)).toEqual(organisationPaths);
            expect(h.requests[2].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
            expect(h.requests.every(row => row.init.method === 'GET' && row.init.cache === 'no-store' &&
                row.init.credentials === 'same-origin' && row.init.redirect === 'error')).toBe(true);
            if (first === 'directory') await h.reply(1, 200, listing());
            else await h.reply(2, 200, projection());
            expect(h.native).toHaveLength(0); expect(h.mounts).toHaveLength(0);
            expect(h.status).toBe('loading'); expect(h.elements.dashboardApp.hidden).toBe(true);
            for (let index = 0; index < 60; index++) h.event('focus');
            h.event('pageshow', { persisted: true }); await flush();
            expect(h.requests).toHaveLength(3);
            if (first === 'directory') await h.reply(2, 200, projection());
            else await h.reply(1, 200, listing());
            h.load(0); h.load(1); await flush();
            expect(h.requests[3].url).toBe('/api/dashboard/session');
            expect(h.mounts).toHaveLength(0); expect(h.elements.dashboardApp.hidden).toBe(true);
            await h.reply(3, 200, account()); expect(h.status).toBe('ready');
            expect(h.requests).toHaveLength(4); expect(h.mounts).toHaveLength(1);
        });

    test.each(['directory', 'bootstrap'].flatMap(stage => [401, 403, 503].map(status => [stage, status])))
        ('%s failure %s cancels its sibling and stale bodies cannot revive the cycle', async (stage, status) => {
            const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
            expect(h.requests.slice(1).map(row => row.url)).toEqual(organisationPaths);
            const failed = stage === 'directory' ? 1 : 2, sibling = stage === 'directory' ? 2 : 1;
            await h.reply(failed, status, { code: 'synthetic_failure' });
            expect(h.requests[sibling].init.signal.aborted).toBe(true);
            expect(h.status).toBe(status === 401 ? 'expired' : status === 403 ? 'denied' : 'unavailable');
            expect(h.mounts).toHaveLength(0); expect(h.native).toHaveLength(0);
            h.event('focus'); await flush();
            const newer = state(B, GB, { purpose: 'customer', accountType: 'consultant' });
            await h.open(newer, 'New tenant after failure', 3);
            h.requests[sibling].resolve(response(200, stage === 'directory' ? projection('Obsolete tenant') : listing([A])));
            await flush();
            expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
            expect(h.elements.dashboardApp.textContent).toContain('New tenant after failure');
            expect(h.elements.dashboardApp.textContent).not.toContain('Obsolete tenant');
            expect(h.requests[5].init.headers['X-NoFries-Dashboard-Generation']).toBe(GB);
        });

    test.each([401, 403])('a final session %s never admits a selected mount', async status => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        await h.reply(1, 200, listing()); await h.reply(2, 200, projection());
        h.load(0); h.load(1); await flush();
        expect(h.mounts).toHaveLength(0); await h.reply(3, status, { code: 'synthetic_revocation' });
        expect(h.status).toBe(status === 401 ? 'expired' : 'denied');
        expect(h.mounts).toHaveLength(0); expect(h.elements.dashboardApp.children).toHaveLength(0);
    });

    test('pagehide cancels both middle reads and late replies cannot overwrite a different tenant', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        expect(h.requests).toHaveLength(3); h.event('pagehide');
        expect(h.requests.slice(1).every(row => row.init.signal.aborted)).toBe(true);
        h.event('pageshow', { persisted: true }); await flush();
        await h.open(state(B, GB, { purpose: 'customer', accountType: 'consultant' }), 'Current tenant B', 3);
        h.requests[1].resolve(response(200, listing([A])));
        h.requests[2].resolve(response(200, projection('Obsolete tenant A'))); await flush();
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
        expect(h.elements.dashboardApp.textContent).toContain('Current tenant B');
        expect(h.elements.dashboardApp.textContent).not.toContain('Obsolete tenant A');
    });

    test('a pending bootstrap deadline cancels the directory and cannot mount a late body', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        expect(h.requests).toHaveLength(3); jest.advanceTimersByTime(12000); await flush();
        expect(h.status).toBe('unavailable'); expect(h.requests.slice(1).every(row => row.init.signal.aborted)).toBe(true);
        h.requests[1].resolve(response(200, listing())); h.requests[2].resolve(response(200, projection())); await flush();
        expect(h.status).toBe('unavailable'); expect(h.mounts).toHaveLength(0);
    });

    test('a changed final generation reconciles anew before mounting the current organisation', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        await h.reply(1, 200, listing()); await h.reply(2, 200, projection('Old selected organisation'));
        h.load(0); h.load(1); await flush();
        const newer = state(B, GB, { purpose: 'customer', accountType: 'consultant' });
        await h.reply(3, 200, newer); expect(h.mounts).toHaveLength(0); expect(h.status).toBe('loading');
        await h.open(newer, 'Fresh selected organisation', 4);
        expect(h.status).toBe('ready'); expect(h.mounts).toHaveLength(1);
        expect(h.elements.dashboardApp.textContent).toContain('Fresh selected organisation');
        expect(h.requests[6].init.headers['X-NoFries-Dashboard-Generation']).toBe(GB);
    });

    test('navigation from account to organisation while directory is pending still fetches its projection', async () => {
        const h = harness({ hash: '#organisations' }); await flush(); await h.reply(0, 200, consultant());
        expect(h.requests).toHaveLength(2); h.window.location.hash = '#services';
        await h.reply(1, 200, listing()); expect(h.requests[2].url).toBe('/api/dashboard/bootstrap');
        await h.reply(2, 200, projection()); h.load(0); h.load(1); await flush(); await h.reply(3, 200, consultant());
        expect(h.status).toBe('ready'); expect(h.elements.dashboardApp.querySelector('h1').textContent).toBe('Services');
    });

    test('navigation from organisation to account while middle reads are pending retains the account decision', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        expect(h.requests).toHaveLength(3); h.window.location.hash = '#organisations';
        await h.reply(1, 200, listing()); await h.reply(2, 200, projection());
        expect(h.status).toBe('selection'); expect(h.native).toHaveLength(0); expect(h.mounts).toHaveLength(0);
        await h.reply(3, 200, clients); expect(h.window.location.hash).toBe('#organisations');
    });

    test('an invalid bootstrap body is rejected without a fallback duplicate GET', async () => {
        const h = harness({ hash: '#services' }); await flush(); await h.reply(0, 200, consultant());
        await h.reply(1, 200, listing()); await h.reply(2, 200, null); h.load(0); h.load(1); await flush();
        expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(3); expect(h.mounts).toHaveLength(0);
    });
});
