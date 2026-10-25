'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const { buildDashboardAdminDocument } = require('../lib/dashboardAdminDocument');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const f = require('./fixtures/dashboardAdminSignupFixture');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/signupQueue.js'), 'utf8');
const lookup = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardAdmin.js'), 'utf8');
const pause = () => new Promise(resolve => setImmediate(resolve));
const reply = (body, status = 200, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
async function page() { return createSignupListService({ authoriseSignupList: async () => f.grant(), readSignupPage: async () => f.page(), audit: async event => f.ack(event), clock: () => f.NOW }).list(f.principal, { cursor: null }); }
function harness(fetch, both = false) {
    const dom = createDom(), nodes = new Map(), listeners = new Map(), timers = [];
    for (const match of buildDashboardAdminDocument().matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const item = dom.document.createElement(match[1]); item.id = match[2]; item.value = '';
        item.disabled = /\sdisabled(?:[\s>])/.test(match[0]); item.hidden = /\shidden(?:[\s>])/.test(match[0]); nodes.set(item.id, item);
    }
    dom.document.getElementById = id => nodes.get(id) || null;
    dom.window.setTimeout = fn => { timers.push(fn); return timers.length; }; dom.window.clearTimeout = jest.fn();
    dom.window.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    dom.window.addEventListener = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
    dom.window.dispatchEvent = event => { for (const fn of listeners.get(event.type) || []) fn(event); };
    vm.runInNewContext((both ? lookup + '\n' : '') + source, { document: dom.document, window: dom.window, fetch, AbortController });
    return { ...dom, nodes, timers, emit(id, name = 'click') { for (const fn of nodes.get(id).events[name] || []) fn({ preventDefault() {} }); },
        dispatch(name, detail) { dom.window.dispatchEvent({ type: name, ...detail }); }, async ready() { await pause(); await pause(); } };
}
describe('protected signup queue UI', () => {
    test('requires independent capability, explicit load and exact cursor-only POST; focuses result', async () => {
        const gate = deferred(), fetch = jest.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce(reply(await page()));
        const h = harness(fetch); expect(h.nodes.get('signupQueueLoad').disabled).toBe(true); h.emit('signupQueueLoad'); expect(fetch).toHaveBeenCalledTimes(1);
        gate.resolve(reply({ lookup: true, signupList: true, recovery: [] })); await h.ready(); h.emit('signupQueueLoad'); await h.ready();
        expect(fetch.mock.calls[1][0]).toBe('/api/dashboard-admin/signups'); expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ cursor: null });
        expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', method: 'POST' });
        expect(h.nodes.get('signupQueueResult').textContent).toContain('person1@example.invalid');
        expect(h.nodes.get('signupQueueResult').textContent).toContain('Awaiting admission');
        expect(h.document.activeElement.id).toBe('signupQueueResultHeading');
    });
    test.each([{}, { lookup: true }, { signupList: false }, { signupList: 'true' }])('missing/invalid capability %p never loads rows', async capability => {
        const fetch = jest.fn(async () => reply(capability)), h = harness(fetch); await h.ready(); h.emit('signupQueueLoad');
        expect(h.nodes.get('signupQueueLoad').disabled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
        expect(h.nodes.get('signupQueueStatus').textContent).toContain('unavailable');
    });
    test('next uses opaque token, refresh starts over and clears previous page during loading', async () => {
        const first = f.clone(await page()); first.nextCursor = 'x'.repeat(43); first.continuation = 'more';
        const pending = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ signupList: true })).mockResolvedValueOnce(reply(first)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply(await page()));
        const h = harness(fetch); await h.ready(); h.emit('signupQueueLoad'); await h.ready(); h.emit('signupQueueNext');
        expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ cursor: first.nextCursor }); expect(h.nodes.get('signupQueueResult').hidden).toBe(true);
        h.emit('signupQueueLoad'); await h.ready(); pending.resolve(reply(first)); await h.ready();
        expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ cursor: null }); expect(h.nodes.get('signupQueueNext').disabled).toBe(true);
    });
    test.each(['cancel', 'timeout', 'pagehide'])('%s clears rows and rejects late successful responses', async kind => {
        const late = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ signupList: true })).mockReturnValueOnce(late.promise);
        const h = harness(fetch); await h.ready(); h.emit('signupQueueLoad');
        if (kind === 'cancel') h.emit('signupQueueCancel'); if (kind === 'timeout') h.timers.at(-1)(); if (kind === 'pagehide') h.dispatch('pagehide');
        expect(fetch.mock.calls[1][1].signal.aborted).toBe(true); late.resolve(reply(await page())); await h.ready();
        expect(h.nodes.get('signupQueueResult').hidden).toBe(true); expect(h.nodes.get('signupQueueResult').textContent).toBe('');
    });
    test.each([401, 403])('even stale %s clears both protected panels', async code => {
        const late = deferred(), fetch = jest.fn().mockImplementation(async url => url.endsWith('capabilities') ? reply({ lookup: true, signupList: true, recovery: [] }) : late.promise);
        const h = harness(fetch, true); await h.ready(); h.nodes.get('adminLookupResult').textContent = 'SENSITIVE_LOOKUP'; h.nodes.get('adminLookupResult').hidden = false;
        h.emit('signupQueueLoad'); h.emit('signupQueueCancel'); late.resolve(reply({ raw: 'PRIVATE_DIAGNOSTIC' }, code)); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true); expect(h.nodes.get('adminLookupFields').disabled).toBe(true);
        expect(h.nodes.get('signupQueueResult').hidden).toBe(true); expect(h.nodes.get('signupQueueLoad').disabled).toBe(true);
    });
    test('lookup-side denial clears queue and pageshow rechecks permission', async () => {
        const fetch = jest.fn(async () => reply({ lookup: true, signupList: true, recovery: [] })), h = harness(fetch, true); await h.ready();
        h.nodes.get('signupQueueResult').textContent = 'SENSITIVE_QUEUE'; h.nodes.get('signupQueueResult').hidden = false;
        h.dispatch('dashboard-admin-revoked', { detail: 403 }); expect(h.nodes.get('signupQueueResult').textContent).toBe('');
        h.dispatch('pageshow', { persisted: true }); await h.ready(); expect(fetch).toHaveBeenCalledTimes(4);
    });
    test.each(['missing', 'extra-sensitive', 'bad-collection', 'bad-milestone', 'bad-cursor', 'bad-content-type', '503'])('fails closed for %s response', async kind => {
        let body = f.clone(await page()), code = 200, type = 'application/json';
        if (kind === 'missing') delete body.rows; if (kind === 'extra-sensitive') body.rows[0].secret = 'SECRET';
        if (kind === 'bad-collection') body.rows = {}; if (kind === 'bad-milestone') body.rows[0].milestones.accountActivated = { status: 'recorded', at: null };
        if (kind === 'bad-cursor') body.nextCursor = 'raw-source-cursor'; if (kind === 'bad-content-type') type = 'text/html'; if (kind === '503') code = 503;
        const fetch = jest.fn().mockResolvedValueOnce(reply({ signupList: true })).mockResolvedValueOnce(reply(body, code, type));
        const h = harness(fetch); await h.ready(); h.emit('signupQueueLoad'); await h.ready();
        expect(h.nodes.get('signupQueueResult').hidden).toBe(true); expect(h.nodes.get('signupQueueStatus').textContent).toContain('could not be loaded');
        expect(h.nodes.get('signupQueueResult').textContent).not.toMatch(/SECRET|person1/);
    });
    test.each(['unavailable', 'empty', 'limit'])('%s is explicit and never implies completed signup', async mode => {
        const body = f.clone(await page());
        if (mode === 'unavailable') Object.assign(body, { status: 'unavailable', rows: [], observedAt: null, continuation: 'unavailable' });
        if (mode === 'empty') body.rows = []; if (mode === 'limit') body.continuation = 'limit_reached';
        const fetch = jest.fn().mockResolvedValueOnce(reply({ signupList: true })).mockResolvedValueOnce(reply(body)), h = harness(fetch);
        await h.ready(); h.emit('signupQueueLoad'); await h.ready();
        const text = h.nodes.get('signupQueueStatus').textContent + h.nodes.get('signupQueueResult').textContent;
        expect(text).toMatch(mode === 'unavailable' ? /not an empty population/ : mode === 'empty' ? /No signup records in this approved page/ : /viewing limit reached/);
        expect(text).not.toMatch(/signup completed|last active|verification attempts/i);
    });
    test('rendering uses safe text nodes and no browser storage or telemetry', () => {
        expect(source).not.toMatch(/innerHTML|localStorage|sessionStorage|console\.|sendBeacon/);
        expect(buildDashboardAdminDocument()).toContain('id="signupQueueStatus" role="status" aria-live="polite" aria-atomic="true"');
    });
});


test('queue-only capability scopes lookup status to lookup data', async () => {
    const fetch = jest.fn(async () => reply({ lookup: false, signupList: true, recovery: [] }));
    const h = harness(fetch, true); await h.ready();
    expect(h.nodes.get('adminAccessStatus').textContent).toContain('No lookup data has been loaded');
    expect(h.nodes.get('signupQueueLoad').disabled).toBe(false);
});
