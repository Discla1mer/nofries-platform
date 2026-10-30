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
const GA = 'a'.repeat(64), GB = 'b'.repeat(64);
const NOW = '2026-09-08T23:30:00.000Z';
const ids = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus',
    'dashboardRetry', 'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices',
    'dashboardMore', 'dashboardApp', 'dashboardApplicationIntegrity', 'dashboardStyleIntegrity', 'dashboardSkipLink',
    'dashboardOrganisationSearch', 'dashboardOrganisationStatus', 'dashboardOrganisationSearchControls', 'dashboardOrganisationClear',
    'dashboardOrganisationCount', 'dashboardOrganisationEmpty'];
const state = (selectedBindingId = A, generation = GA, extra = {}) => ({ schemaVersion: 1, authenticated: true,
    purpose: 'customer', accountType: 'consultant', workQueueAvailable: true,
    expiresAt: '2026-09-09T00:30:00.000Z', generation, selectedBindingId, ...extra });
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, redirected: false, type: 'basic',
    headers: { get: () => 'application/json; charset=utf-8' }, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const organisation = (bindingId = A, organisationLabel = 'Kauri client', extra = {}) => ({ bindingId, organisationLabel,
    state: 'checked', plansChecked: 1, ...extra });
function action(actionId, extra = {}) {
    const value = { bindingId: A, organisationLabel: 'Kauri client', planId: 'retained-plan', planRevision: 3,
        actionId: actionId.toLowerCase().replace(/\s+/g, '-'), suggestedAction: actionId, status: 'open', assigned: true, ownerEligibility: 'not_checked',
        dueDate: '2026-09-08', blockedReason: null, ...extra };
    value.isOverdue = value.status !== 'completed' && value.dueDate !== null && value.dueDate < NOW.slice(0, 10);
    return value;
}
function page(rows = [action('Review backups')], extra = {}) {
    return { schemaVersion: 1, asOf: NOW, dueDateBasis: 'UTC_calendar_day', rows,
        organisations: [organisation()], coverage: { basis: 'current_page', checkedOrganisations: 1,
            partialOrganisations: 0, unavailableOrganisations: 0, complete: true }, nextCursor: null, ...extra };
}

// Real delivered loader and dashboard shell; synthetic transport/DOM only.
// These checks establish request and navigation behavior, not visual layout.
function harness(hash = '#work-queue') {
    const { document, window } = createDom(), createElement = document.createElement;
    const windowEvents = new Map();
    window.addEventListener = (name, fn) => { if (!windowEvents.has(name)) windowEvents.set(name, new Set()); windowEvents.get(name).add(fn); };
    window.removeEventListener = (name, fn) => windowEvents.get(name)?.delete(fn);
    window.dispatch = (name, event) => { for (const fn of windowEvents.get(name) || []) fn(event); };
    window.listenerCount = name => windowEvents.get(name)?.size || 0;
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
    elements.dashboardApplicationIntegrity.setAttribute('content', sri); elements.dashboardStyleIntegrity.setAttribute('content', sri);
    window.location.hash = hash; window.crypto = { randomUUID: crypto.randomUUID }; window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout; window.confirm = jest.fn(() => false); window.location.assign = jest.fn();
    const requests = [], improvementMounts = [];
    const fetch = (url, init) => { const work = deferred(); requests.push({ url, init, ...work }); return work.promise; };
    vm.runInContext(SOURCE, vm.createContext({ document, window, fetch, AbortController, Date, console }), { filename: 'dashboard-loader.js' });
    async function reply(index, status, value) {
        expect(requests[index]).toBeDefined(); requests[index].resolve(response(status, value)); await flush();
    }
    function loadAssets() {
        window.NoFriesDashboard = shell;
        window.NoFriesImprovementActionPlanClient = { mount: (root, input) => {
            improvementMounts.push(input);
            root.textContent = 'Exact retained plan view';
            return { destroy() {}, requestLeave(commit) { commit(); return Promise.resolve(true); }, ready: Promise.resolve(true) };
        } };
        native.slice(-2).forEach(node => node.onload());
    }
    return { document, window, elements, requests, reply, loadAssets, improvementMounts,
        get status() { return document.body.dataset.dashboardState; },
        get queue() { return elements.dashboardApp; },
        get results() { return document.getElementById('workQueueResults'); } };
}
function button(h, text) { return h.document.body.querySelectorAll('button').find(node => node.textContent === text); }
function change(h, id, value, event = 'change') {
    const node = h.document.getElementById(id); expect(node).not.toBeNull(); node.value = value;
    for (const handler of node.events[event] || []) handler();
}
function titles(h) { return h.results.querySelectorAll('h3').map(node => node.textContent); }
async function ready(h, data = page(), account = state()) {
    await flush(); await h.reply(0, 200, account); await h.reply(1, 200, account);
    expect(h.requests[2].url).toBe('/api/dashboard/work-queue?limit=50');
    await h.reply(2, 200, data); await h.reply(3, 200, account);
}
async function nextPage(h, index, data, account = state()) {
    await h.reply(index, 200, account); await h.reply(index + 1, 200, data); await h.reply(index + 2, 200, account);
}
async function selectedPlan(h, index) {
    await h.reply(index, 200, { schemaVersion: 1, selectedBindingId: B, generation: GB });
    await h.reply(index + 1, 200, state(B, GB));
    await h.reply(index + 2, 200, { schemaVersion: 1, bindings: [{ bindingId: A, organisationLabel: 'Original client' },
        { bindingId: B, organisationLabel: 'Target client' }], nextAfterBindingId: null });
    const model = JSON.parse(JSON.stringify(projectDashboard(fixture({ now: NOW, name: 'Target client' }))));
    model.modules.find(item => item.key === 'improvement_plan').state = 'ready';
    await h.reply(index + 3, 200, model); h.loadAssets(); await flush();
    await h.reply(index + 4, 200, state(B, GB));
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

function withoutQueue(account = state()) { const value = { ...account }; delete value.workQueueAvailable; return value; }
const directoryPage = () => ({ schemaVersion: 1, bindings: [{ bindingId: A, organisationLabel: 'Kauri client' }], nextAfterBindingId: null });

test('new client negotiates the optional field on every session read, not queue reads', async () => {
    const h = harness(); await ready(h);
    button(h, 'Refresh actions').click(); await flush();
    await h.reply(4, 200, state()); await h.reply(5, 200, page()); await h.reply(6, 200, state());
    expect(h.status).toBe('queue');
    const sessions = h.requests.filter(item => item.url === '/api/dashboard/session');
    expect(sessions).toHaveLength(5);
    for (const item of h.requests) {
        expect(item.init.method).toBe('GET');
        if (item.url === '/api/dashboard/session') {
            expect(item.init.headers['X-NoFries-Dashboard-Capabilities']).toBe('work-queue-v1');
        } else expect(item.init.headers).not.toHaveProperty('X-NoFries-Dashboard-Capabilities');
    }
});

test.each(['#organisations', '#work-queue'])('unadvertised queue at %s returns to the directory without requests or selection writes', async hash => {
    const h = harness(hash), account = withoutQueue();
    await flush(); await h.reply(0, 200, account); await h.reply(1, 200, directoryPage());
    expect(h.status).toBe('selection'); expect(button(h, 'Work queue')).toBeUndefined();
    expect(h.window.location.hash).toBe('#organisations');
    expect(h.requests.map(item => item.url)).toEqual(['/api/dashboard/session', '/api/dashboard/organisations?limit=50']);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
    expect(h.requests[0].init.headers['X-NoFries-Dashboard-Capabilities']).toBe('work-queue-v1');
});

test.each([true, false])('selected organisation keeps its overview with queue availability %s independent of module readiness', async enabled => {
    const h = harness('#overview'), account = enabled ? state() : withoutQueue();
    await flush(); await h.reply(0, 200, account); await h.reply(1, 200, directoryPage());
    const model = JSON.parse(JSON.stringify(projectDashboard(fixture({ now: NOW }))));
    model.modules.find(item => item.key === 'improvement_plan').state = 'disabled';
    await h.reply(2, 200, model); h.loadAssets(); await flush(); await h.reply(3, 200, account);
    expect(h.status).toBe('ready'); expect(h.window.location.hash).toBe('#overview');
    expect(!!button(h, 'Work queue')).toBe(enabled);
    expect(h.requests.some(item => item.url.startsWith('/api/dashboard/work-queue'))).toBe(false);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test.each([false, 'true', 1, null])('malformed queue capability %p fails closed before further reads', async capability => {
    const h = harness(); await flush(); await h.reply(0, 200, state(A, GA, { workQueueAvailable: capability }));
    expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1); expect(h.queue.children).toHaveLength(0);
});

test.each([
    { accountType: 'company' },
    { purpose: 'operator_dashboard', accountType: undefined },
    { accountType: undefined }
])('non-consultant cannot advertise a queue capability (%p)', async overrides => {
    const account = state(A, GA, overrides);
    if (account.accountType === undefined) delete account.accountType;
    const h = harness(); await flush(); await h.reply(0, 200, account);
    expect(h.status).toBe('unavailable'); expect(h.requests).toHaveLength(1);
});

test.each(['before queue read', 'before disclosure'])('capability removal %s reconciles without disclosing stale actions or writing selection', async phase => {
    const h = harness(), absent = withoutQueue(); await flush(); await h.reply(0, 200, state());
    let next;
    if (phase === 'before queue read') { await h.reply(1, 200, absent); next = 2; }
    else {
        await h.reply(1, 200, state()); await h.reply(2, 200, page());
        expect(h.queue.textContent).not.toContain('Review backups');
        await h.reply(3, 200, absent); next = 4;
    }
    await h.reply(next, 200, absent); await h.reply(next + 1, 200, directoryPage());
    expect(h.status).toBe('selection'); expect(h.window.location.hash).toBe('#organisations');
    expect(button(h, 'Work queue')).toBeUndefined(); expect(h.queue.textContent).not.toContain('Review backups');
    expect(h.requests.filter(item => item.url.startsWith('/api/dashboard/work-queue'))).toHaveLength(phase === 'before queue read' ? 0 : 1);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('capability removal during refresh discards displayed queue and keeps selected organisation unchanged', async () => {
    const h = harness(); await ready(h); expect(titles(h)).toEqual(['Review backups']);
    button(h, 'Refresh actions').click(); await flush();
    await h.reply(4, 200, withoutQueue()); await h.reply(5, 200, withoutQueue());
    await h.reply(6, 200, directoryPage());
    expect(h.status).toBe('selection'); expect(button(h, 'Work queue')).toBeUndefined();
    expect(h.queue.textContent).not.toContain('Review backups');
    expect(h.requests.filter(item => item.url.startsWith('/api/dashboard/work-queue'))).toHaveLength(1);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('unexpected 404 after advertised availability keeps explicit Organisations recovery without writes', async () => {
    const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, state());
    await h.reply(2, 404, { code: 'dashboard_not_found' });
    expect(h.status).toBe('queue'); expect(h.queue.textContent).toContain('Return to Organisations');
    button(h, 'Organisations').click(); await flush();
    await h.reply(3, 200, withoutQueue()); await h.reply(4, 200, directoryPage());
    expect(h.status).toBe('selection'); expect(button(h, 'Work queue')).toBeUndefined();
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('queue reads current authority without directory or selection writes and hides rows until final confirmation', async () => {
    const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, state());
    expect(h.requests[2].init.headers['X-NoFries-Dashboard-Generation']).toBe(GA);
    expect(h.requests[2].init.credentials).toBe('same-origin');
    await h.reply(2, 200, page());
    expect(h.queue.textContent).not.toContain('Review backups');
    await h.reply(3, 200, state());
    expect(h.status).toBe('queue'); expect(titles(h)).toEqual(['Review backups']);
    expect(h.queue.textContent).toContain('1 action shown');
    expect(h.queue.textContent).toContain('1 organisation fully checked on this page');
    expect(h.queue.textContent).toContain('Dates use UTC');
    expect(h.queue.textContent).toContain('Assigned (eligibility not checked)');
    expect(button(h, 'Work queue').getAttribute('aria-current')).toBe('page');
    expect(h.requests.map(item => item.url)).toEqual(['/api/dashboard/session', '/api/dashboard/session',
        '/api/dashboard/work-queue?limit=50', '/api/dashboard/session']);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('consultant navigation opens the queue from the organisation list without changing the selected client', async () => {
    const h = harness('#organisations'); await flush(); await h.reply(0, 200, state());
    await h.reply(1, 200, { schemaVersion: 1, bindings: [{ bindingId: A, organisationLabel: 'Kauri client' }], nextAfterBindingId: null });
    expect(h.status).toBe('selection'); button(h, 'Work queue').click(); await flush();
    expect(h.window.location.hash).toBe('#work-queue');
    await h.reply(2, 200, state()); await h.reply(3, 200, state());
    await h.reply(4, 200, page()); await h.reply(5, 200, state());
    expect(h.status).toBe('queue'); expect(titles(h)).toEqual(['Review backups']);
    expect(h.requests.slice(2).map(item => item.url)).toEqual(['/api/dashboard/session', '/api/dashboard/session',
        '/api/dashboard/work-queue?limit=50', '/api/dashboard/session']);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('status and attention filters preserve distinct UTC date boundaries without requests', async () => {
    const h = harness();
    const rows = [action('Overdue blocked', { status: 'blocked', dueDate: '2026-09-07', blockedReason: 'Waiting for evidence' }),
        action('Due today'), action('Due in six days', { dueDate: '2026-09-14' }),
        action('Due in seven days', { dueDate: '2026-09-15' }),
        action('No owner', { assigned: false, dueDate: null }),
        action('Completed yesterday', { status: 'completed', dueDate: '2026-09-07' })];
    await ready(h, page(rows));
    expect(titles(h)).toEqual(['Overdue blocked', 'Due today', 'Due in six days', 'Due in seven days', 'No owner']);
    expect(h.queue.textContent).toContain('5 actions shown');
    change(h, 'workQueueAttention', 'soon'); expect(titles(h)).toEqual(['Due today', 'Due in six days']);
    change(h, 'workQueueAttention', 'overdue'); expect(titles(h)).toEqual(['Overdue blocked']);
    change(h, 'workQueueAttention', 'blocked'); expect(titles(h)).toEqual(['Overdue blocked']);
    expect(h.queue.textContent).toContain('Waiting for evidence');
    change(h, 'workQueueAttention', 'unassigned'); expect(titles(h)).toEqual(['No owner']);
    change(h, 'workQueueAttention', 'all'); change(h, 'workQueueStatus', 'completed');
    expect(titles(h)).toEqual(['Completed yesterday']); expect(h.queue.textContent).not.toContain('Overdue ·');
    change(h, 'workQueueStatus', 'all'); expect(titles(h)).toHaveLength(6);
    expect(h.requests).toHaveLength(4); expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('combined search and organisation filters are local and Clear filters restores unfinished actions and focus', async () => {
    const h = harness(); await ready(h, page([action('Review backups'), action('Review access', { bindingId: B,
        organisationLabel: 'Māori client' })], { organisations: [organisation(), organisation(B, 'Māori client')],
        coverage: { basis: 'current_page', checkedOrganisations: 2, partialOrganisations: 0, unavailableOrganisations: 0, complete: true } }));
    const input = h.document.getElementById('workQueueSearch'); input.focus();
    change(h, 'workQueueSearch', ' MĀORI ', 'input'); expect(titles(h)).toEqual(['Review access']);
    expect(h.document.activeElement).toBe(input);
    change(h, 'workQueueOrganisation', A); expect(titles(h)).toEqual([]);
    expect(h.queue.textContent).toContain('No actions on this page match these filters');
    change(h, 'workQueueSearch', 'BACKUPS', 'input'); expect(titles(h)).toEqual(['Review backups']);
    button(h, 'Clear filters').click(); expect(titles(h)).toEqual(['Review backups', 'Review access']);
    expect(input.value).toBe(''); expect(h.document.activeElement).toBe(input);
    expect(h.document.getElementById('workQueueOrganisation').value).toBe('');
    expect(h.requests).toHaveLength(4);
});

test('Next replaces the page and organisation choices after fresh authority, preserving local text filters', async () => {
    const h = harness(); await ready(h, page([action('Review first')], { nextCursor: 'next_page',
        coverage: { basis: 'current_page', checkedOrganisations: 1, partialOrganisations: 0, unavailableOrganisations: 0, complete: false } }));
    change(h, 'workQueueSearch', 'review', 'input'); change(h, 'workQueueOrganisation', A);
    button(h, 'Next actions').focus(); button(h, 'Next actions').click(); await flush();
    expect(h.results.children).toHaveLength(0);
    await h.reply(4, 200, state());
    expect(h.requests[5].url).toBe('/api/dashboard/work-queue?limit=50&cursor=next_page');
    await h.reply(5, 200, page([action('Review second', { bindingId: B, organisationLabel: 'Second client' })],
        { organisations: [organisation(B, 'Second client')] }));
    expect(h.results.children).toHaveLength(0); await h.reply(6, 200, state());
    expect(titles(h)).toEqual(['Review second']); expect(h.queue.textContent).not.toContain('Review first');
    expect(h.document.getElementById('workQueueSearch').value).toBe('review');
    expect(h.document.getElementById('workQueueOrganisation').value).toBe('');
    expect(h.document.getElementById('workQueueOrganisation').children.map(node => node.value)).toEqual(['', B]);
    expect(button(h, 'Next actions').hidden).toBe(true); expect(button(h, 'First actions').hidden).toBe(false);
    expect(h.document.activeElement === h.queue.querySelector('.work-queue-coverage')).toBe(true);
    button(h, 'First actions').click(); await flush(); await nextPage(h, 7, page());
    expect(h.requests[8].url).toBe('/api/dashboard/work-queue?limit=50');
    expect(button(h, 'First actions').hidden).toBe(true);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test.each(['synchronous', 'deferred'])('disabling the focused pager preserves owned focus through its %s blur', async delivery => {
    const h = harness(); await ready(h, page([action('First action')], { nextCursor: 'next_page',
        coverage: { basis: 'current_page', checkedOrganisations: 1, partialOrganisations: 0, unavailableOrganisations: 0, complete: false } }));
    const pager = button(h, 'Next actions'); let disabled = false;
    Object.defineProperty(pager, 'disabled', { get: () => disabled, set(value) {
        disabled = value;
        if (value && h.document.activeElement === pager) {
            const blur = () => {
                h.document.activeElement = h.document.body;
                h.window.dispatch('blur', { type: 'blur', target: pager });
            };
            if (delivery === 'deferred') Promise.resolve().then(blur); else blur();
        }
    } });
    pager.focus(); pager.click(); await flush();
    await nextPage(h, 4, page());
    expect(h.document.activeElement).toBe(h.queue.querySelector('.work-queue-coverage'));
});

test.each(['pointerdown', 'keydown', 'blur', 'focusin'])('pending pager %s still relinquishes automatic focus', async event => {
    const h = harness(); await ready(h, page([action('First action')], { nextCursor: 'next_page',
        coverage: { basis: 'current_page', checkedOrganisations: 1, partialOrganisations: 0, unavailableOrganisations: 0, complete: false } }));
    button(h, 'Next actions').focus(); button(h, 'Next actions').click(); await flush();
    const search = h.document.getElementById('workQueueSearch'); search.focus();
    h.window.dispatch(event, { type: event, target: event === 'blur' ? h.window : search });
    await nextPage(h, 4, page());
    expect(h.document.activeElement).toBe(search);
});

test('typing while the next page is pending keeps user focus and uses the current filter on completion', async () => {
    const h = harness(); await ready(h, page([action('First action')], { nextCursor: 'next_page',
        coverage: { basis: 'current_page', checkedOrganisations: 1, partialOrganisations: 0, unavailableOrganisations: 0, complete: false } }));
    button(h, 'Next actions').focus(); button(h, 'Next actions').click(); await flush();
    const search = h.document.getElementById('workQueueSearch');
    h.window.dispatch('pointerdown'); search.focus(); change(h, 'workQueueSearch', 'matching', 'input');
    await nextPage(h, 4, page([action('Matching action'), action('Other action')]));
    expect(h.document.activeElement === search).toBe(true); expect(titles(h)).toEqual(['Matching action']);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test.each([401, 403])('a queue %s clears every prior action and organisation', async code => {
    const h = harness(); await ready(h); const detached = button(h, 'Open action');
    button(h, 'Refresh actions').click(); await flush(); await h.reply(4, 200, state());
    await h.reply(5, code, { code: 'work_queue_unavailable' });
    expect(h.queue.children).toHaveLength(0); expect(h.queue.textContent).not.toContain('Kauri client');
    expect(h.status).toBe(code === 401 ? 'expired' : 'denied');
    const before = h.requests.length; detached.click(); await flush(); expect(h.requests).toHaveLength(before);
});

test('an old queue response cannot replace organisation navigation or issue its final session read', async () => {
    const h = harness(); await ready(h);
    button(h, 'Refresh actions').click(); await flush(); await h.reply(4, 200, state());
    button(h, 'Organisations').click(); await flush();
    expect(h.window.location.hash).toBe('#organisations');
    await h.reply(6, 200, state());
    await h.reply(7, 200, { schemaVersion: 1, bindings: [{ bindingId: A, organisationLabel: 'Current client' }], nextAfterBindingId: null });
    const before = h.requests.length; await h.reply(5, 200, page([action('Stale private action')]));
    expect(h.status).toBe('selection'); expect(h.queue.textContent).not.toContain('Stale private action');
    expect(h.elements.dashboardChoices.textContent).toContain('Current client'); expect(h.requests).toHaveLength(before);
});

test('changed final generation discards staged actions and restarts authority instead of displaying them', async () => {
    const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, state());
    await h.reply(2, 200, page([action('Staged private action')])); await h.reply(3, 200, state(A, GB));
    expect(h.queue.textContent).not.toContain('Staged private action');
    expect(h.requests[4].url).toBe('/api/dashboard/session');
    await h.reply(4, 200, state(A, GB)); await h.reply(5, 200, state(A, GB));
    expect(h.requests[6].init.headers['X-NoFries-Dashboard-Generation']).toBe(GB);
    await h.reply(6, 200, page([action('Current action')])); await h.reply(7, 200, state(A, GB));
    expect(titles(h)).toEqual(['Current action']);
    expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test('partial and unavailable coverage is explicit even when inaccessible client labels are withheld', async () => {
    const h = harness(); await ready(h, page([], { organisations: [organisation(A, 'Checked client', { state: 'partial', plansChecked: 2 })],
        nextCursor: 'next_page', coverage: { basis: 'current_page', checkedOrganisations: 0, partialOrganisations: 1,
            unavailableOrganisations: 2, complete: false } }));
    expect(h.queue.textContent).toMatch(/1 (?:partly|partially) checked/i);
    expect(h.queue.textContent).toMatch(/2 unavailable/i);
    expect(h.queue.textContent).toContain('More actions or organisations are available');
    expect(h.queue.textContent).not.toMatch(/all clear|no outstanding work/i);
});

test('opening an action writes only exact client selection and hands its target to the fresh selected plan', async () => {
    const h = harness(); const target = action('target-action', { bindingId: B, organisationLabel: 'Target client',
        planId: 'not-on-first-plan-page', planRevision: 8 });
    await ready(h, page([target], { organisations: [organisation(B, 'Target client')] }));
    button(h, 'Open action').click(); await flush();
    expect(h.requests[4].url).toBe('/api/dashboard/selection'); expect(h.requests[4].init.method).toBe('POST');
    expect(h.requests[4].init.headers).not.toHaveProperty('X-NoFries-Dashboard-Capabilities');
    expect(JSON.parse(h.requests[4].init.body)).toEqual({ bindingId: B, expectedGeneration: GA, operationId: expect.any(String) });
    expect(h.window.location.hash).toBe('#improvement-plan');
    await selectedPlan(h, 4);
    expect(h.status).toBe('ready'); expect(h.improvementMounts).toHaveLength(1);
    expect(h.improvementMounts[0].initialTarget).toEqual({ planId: 'not-on-first-plan-page', actionId: 'target-action', planRevision: 8 });
    expect(h.requests.filter(item => item.init.method !== 'GET').map(item => item.url)).toEqual(['/api/dashboard/selection']);
    button(h, 'Work queue').click(); await flush();
    await h.reply(9, 200, state(B, GB)); await h.reply(10, 200, state(B, GB));
    await h.reply(11, 200, page([target], { organisations: [organisation(B, 'Target client')] }));
    expect(h.queue.textContent).not.toContain('target-action'); await h.reply(12, 200, state(B, GB));
    expect(h.status).toBe('queue'); expect(titles(h)).toEqual(['target-action']);
    expect(h.document.activeElement === button(h, 'Open action')).toBe(true);
    expect(h.requests.filter(item => item.init.method !== 'GET')).toHaveLength(1);
});

test.each(['unavailable', 'timeout'])('uncertain %s selection retries the same command and retains the exact action target', async outcome => {
    const h = harness(); const target = action('target-action', { bindingId: B, organisationLabel: 'Target client',
        planId: 'later-retained-plan', planRevision: 8 });
    await ready(h, page([target], { organisations: [organisation(B, 'Target client')] }));
    button(h, 'Open action').click(); await flush(); const originalBody = h.requests[4].init.body;
    if (outcome === 'unavailable') await h.reply(4, 503, { code: 'dashboard_unavailable' });
    else { jest.advanceTimersByTime(12001); await flush(); }
    expect(h.status).toBe('unavailable'); expect(h.queue.children).toHaveLength(0);
    expect(h.elements.dashboardRetry.hidden).toBe(false); h.elements.dashboardRetry.click(); await flush();
    expect(h.requests[5].url).toBe('/api/dashboard/selection'); expect(h.requests[5].init.body).toBe(originalBody);
    if (outcome === 'timeout') {
        await h.reply(4, 200, { schemaVersion: 1, selectedBindingId: B, generation: GB });
        expect(h.requests).toHaveLength(6); expect(h.improvementMounts).toHaveLength(0);
    }
    await selectedPlan(h, 5);
    expect(h.status).toBe('ready'); expect(h.improvementMounts).toHaveLength(1);
    expect(h.improvementMounts[0].initialTarget).toEqual({ planId: 'later-retained-plan', actionId: 'target-action', planRevision: 8 });
    const writes = h.requests.filter(item => item.init.method !== 'GET');
    expect(writes).toHaveLength(2); expect(writes.map(item => item.init.body)).toEqual([originalBody, originalBody]);
});

test('a selection receipt never opens the target in a different current organisation', async () => {
    const h = harness(); await ready(h, page([action('target-action', { bindingId: B, organisationLabel: 'Target client' })],
        { organisations: [organisation(B, 'Target client')] }));
    button(h, 'Open action').click(); await flush();
    await h.reply(4, 200, { schemaVersion: 1, selectedBindingId: B, generation: GB });
    await h.reply(5, 200, state(A, GB));
    expect(h.status).toBe('unavailable'); expect(h.improvementMounts).toHaveLength(0);
    expect(h.queue.children).toHaveLength(0); expect(h.requests).toHaveLength(6);
});

test('unavailable feature remains an explicit recoverable queue state with no selection or writes', async () => {
    const h = harness(); await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, state());
    await h.reply(2, 503, { code: 'work_queue_unavailable' });
    expect(h.status).toBe('queue'); expect(h.results.children).toHaveLength(0);
    expect(h.queue.textContent).toContain('Work queue is currently unavailable');
    button(h, 'Refresh actions').click(); await flush(); await nextPage(h, 3, page());
    expect(titles(h)).toEqual(['Review backups']); expect(h.requests.every(item => item.init.method === 'GET')).toBe(true);
});

test.each([
    ['duplicate action', data => { data.rows.push({ ...data.rows[0] }); }],
    ['different organisation label', data => { data.rows[0].organisationLabel = 'Unverified label'; }],
    ['invalid calendar date', data => { data.rows[0].dueDate = '2026-02-30'; }],
    ['forged overdue flag', data => { data.rows[0].isOverdue = true; }],
    ['unassigned due date', data => { data.rows[0].assigned = false; }]
])('invalid queue response (%s) exposes no rows and offers a safe retry', async (_name, mutate) => {
    const h = harness(), data = page(); mutate(data);
    await flush(); await h.reply(0, 200, state()); await h.reply(1, 200, state()); await h.reply(2, 200, data);
    expect(h.results.children).toHaveLength(0); expect(h.queue.textContent).not.toContain('Review backups');
    expect(h.queue.textContent).toContain('currently unavailable'); expect(button(h, 'Refresh actions').disabled).toBe(false);
    expect(h.requests).toHaveLength(3);
});
