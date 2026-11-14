'use strict';

// #151 F5: staff view of anonymous daily funnel totals, behind the flag and
// the existing staff admin checks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');
const { readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { FUNNEL_EVENTS, READ_SQL, createFunnelCountReader, funnelWindow, projectFunnelView } = require('../api/shared/funnelCounts');
const { buildDashboardAdminDocument } = require('../lib/dashboardAdminDocument');

const uid = n => '71000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), ACTOR = uid(2), CLIENT = uid(3), NOW = Date.parse('2026-11-12T22:00:00.000Z');
const SUBJECT = TENANT + ':' + ACTOR;
const SESSION = Buffer.alloc(32, 9).toString('base64url');
const cookie = '__Host-nofries-auth=' + SESSION;
const zeroes = () => Object.fromEntries(FUNNEL_EVENTS.map(event => [event, 0]));

function wire(route, method = 'GET') {
    const req = Readable.from([]);
    req.method = method;
    req.originalUrl = req.url = route === 'document' ? '/dashboard-admin' : '/api/dashboard-admin/' + route;
    req.headers = { cookie };
    return req;
}

async function harness({ flag = 'true', reader = jest.fn(async () => ({ days: [] })) } = {}) {
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-funnel-view-test-secret',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: SUBJECT,
        ...(flag === null ? {} : { NOFRIES_FUNNEL_COUNTS_ENABLED: flag }) };
    const identity = { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT, principalId: ACTOR,
        subjectKey: SUBJECT, name: 'Synthetic operator', email: 'operator@example.invalid' };
    const store = new MemoryBrowserSessionStore();
    await store.createSession(SESSION, { v: 1, kind: 'browser_session', issuedAt: NOW - 60000,
        idleExpiresAt: NOW + 60000, absoluteExpiresAt: NOW + 600000, identity });
    const readOperatorSession = jest.fn(header => readBrowserSessionDetails(header, { env, store, now: () => NOW }));
    const state = { allowed: true };
    const service = { authorise: jest.fn(async actor => {
        if (!state.allowed) throw new DashboardAdminError(403, 'dashboard_admin_access_denied');
        return actor;
    }), capabilities: jest.fn(async () => Object.freeze({ lookup: true, recovery: [] })), lookup: jest.fn() };
    const handler = createDashboardAdminHandlers({ service, readOperatorSession, env, funnelReader: reader });
    return { env, state, service, reader, readOperatorSession, handler };
}

describe('funnel window and projection', () => {
    test('covers the 30 NZ days ending today, oldest first', () => {
        const window = funnelWindow(new Date('2026-11-12T11:30:00Z'));
        expect(window.to).toBe('2026-11-13');
        expect(window.from).toBe('2026-10-15');
        expect(window.days).toHaveLength(30);
        expect(window.days[29]).toBe('2026-11-13');
        expect(funnelWindow(new Date('2026-03-02T00:00:00Z')).days.slice(0, 2)).toEqual(['2026-02-01', '2026-02-02']);
    });

    test('fills missing events with zero and rejects malformed rows', () => {
        const window = funnelWindow(new Date('2026-11-12T11:30:00Z'));
        const view = projectFunnelView([{ day: '2026-11-13', event: 'visit', count: '12' }, { day: '2026-10-15', event: 'submitted', count: 2 }], window);
        expect(view.events).toEqual(FUNNEL_EVENTS);
        expect(view.days[29]).toEqual({ day: '2026-11-13', counts: { ...zeroes(), visit: 12 } });
        expect(view.days[0].counts.submitted).toBe(2);
        expect(view.days[10].counts).toEqual(zeroes());
        for (const row of [{ day: '2026-09-01', event: 'visit', count: 1 }, { day: '2026-11-13', event: 'other', count: 1 },
            { day: '2026-11-13', event: 'visit', count: -1 }, { day: '2026-11-13', event: 'visit', count: 'x' }]) {
            expect(() => projectFunnelView([row], window)).toThrow('funnel_counts_row_invalid');
        }
    });

    test('reader runs one bounded read-only select under the runtime role', async () => {
        const queries = [];
        const client = { query: jest.fn(async (sql, params) => { queries.push([sql, params]);
            return sql === READ_SQL ? { rows: [{ day: '2026-11-13', event: 'first_answer', count: '3' }] } : {}; }), release: jest.fn() };
        const read = createFunnelCountReader({ pool: { connect: async () => client }, now: () => new Date('2026-11-12T11:30:00Z') });
        const view = await read();
        expect(queries).toEqual([['BEGIN READ ONLY', undefined], ['SET LOCAL ROLE nofries_runtime', undefined],
            ["SET LOCAL statement_timeout = '1000ms'", undefined], [READ_SQL, ['2026-10-15', '2026-11-13']], ['COMMIT', undefined]]);
        expect(READ_SQL).toMatch(/^SELECT [^;]* FROM nofries\.funnel_daily_counts/);
        expect(view.days[29].counts.first_answer).toBe(3);
        expect(client.release).toHaveBeenCalledWith(false);
    });

    test('a failed read rolls back; a failed rollback discards the connection', async () => {
        const failing = rollback => ({ query: jest.fn(async sql => {
            if (sql === READ_SQL || rollback && sql === 'ROLLBACK') throw new Error('broken'); return {}; }), release: jest.fn() });
        for (const [rollback, discard] of [[false, false], [true, true]]) {
            const client = failing(rollback);
            await expect(createFunnelCountReader({ pool: { connect: async () => client } })()).rejects.toThrow('broken');
            expect(client.release).toHaveBeenCalledWith(discard);
        }
    });
});

describe('staff funnel route', () => {
    test('flag on: an authorised staff admin gets the view and the capability', async () => {
        const view = { from: '2026-10-15', to: '2026-11-13', events: FUNNEL_EVENTS, days: [] };
        const h = await harness({ reader: jest.fn(async () => view) });
        const result = await h.handler.handle(wire('funnel'), 'funnel');
        expect(result.status).toBe(200);
        expect(result.body).toEqual(view);
        expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
        // Session and permission are checked before the read and again before release.
        expect(h.readOperatorSession).toHaveBeenCalledTimes(2);
        expect(h.service.authorise).toHaveBeenCalledTimes(2);
        expect((await h.handler.handle(wire('capabilities'), 'capabilities')).body).toEqual({ lookup: true, recovery: [], funnel: true });
    });

    test.each([['off', null], ['not exactly true', 'TRUE']])('flag %s: no route, no capability, no panel and no script', async (_name, flag) => {
        const h = await harness({ flag });
        expect((await h.handler.handle(wire('funnel'), 'funnel'))).toMatchObject({ status: 404, body: { code: 'dashboard_admin_not_found' } });
        expect((await h.handler.handle(wire('capabilities'), 'capabilities')).body).toEqual({ lookup: true, recovery: [] });
        expect((await h.handler.handle(wire('document'), 'document')).body).not.toContain('funnelPanel');
        expect((await h.handler.handle(wire('app.js'), 'app.js')).body).not.toContain('funnelPanel');
        expect(h.reader).not.toHaveBeenCalled();
    });

    test('flag on without a composed reader stays off', async () => {
        const h = await harness();
        const handler = createDashboardAdminHandlers({ service: h.service, readOperatorSession: h.readOperatorSession, env: h.env });
        expect((await handler.handle(wire('funnel'), 'funnel')).status).toBe(404);
    });

    test('flag on adds the panel and its script', async () => {
        const h = await harness();
        expect((await h.handler.handle(wire('document'), 'document')).body).toContain('id="funnelPanel"');
        expect((await h.handler.handle(wire('app.js'), 'app.js')).body).toContain("byId('funnelPanel')");
    });

    test('denied, signed-out and failing reads release no counts', async () => {
        const h = await harness();
        h.state.allowed = false;
        expect((await h.handler.handle(wire('funnel'), 'funnel'))).toMatchObject({ status: 403, body: { code: 'dashboard_admin_access_denied' } });
        expect(h.reader).not.toHaveBeenCalled();
        const signedOut = wire('funnel'); signedOut.headers = {};
        expect((await h.handler.handle(signedOut, 'funnel')).status).toBe(401);
        const broken = await harness({ reader: jest.fn(async () => { throw new Error('db detail'); }) });
        expect((await broken.handler.handle(wire('funnel'), 'funnel'))).toMatchObject({ status: 503, body: { code: 'dashboard_admin_unavailable' } });
        expect((await h.handler.handle(wire('funnel', 'POST'), 'funnel')).status).toBe(405);
    });
});

describe('staff funnel table', () => {
    function element(tag) {
        const node = { tag, children: [], hidden: false, disabled: false, textContent: '', listeners: {}, scope: '',
            append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
            addEventListener(name, fn) { this.listeners[name] = fn; } };
        return node;
    }
    function mount(responses) {
        const ids = { funnelPanel: element('section'), funnelLoad: element('button'), funnelStatus: element('p'), funnelResult: element('div') };
        ids.funnelPanel.hidden = true; ids.funnelResult.hidden = true;
        const fetch = jest.fn(async url => {
            const [status, body] = responses[url.split('/').pop()];
            return { status, ok: status === 200, headers: { get: () => 'application/json' }, json: async () => body };
        });
        const listeners = {}, dispatched = [];
        const window = { addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
            CustomEvent: function (type, init) { this.type = type; this.detail = init.detail; },
            dispatchEvent(event) { dispatched.push([event.type, event.detail]); for (const fn of listeners[event.type] || []) fn(event); } };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/funnelCountsView.js'), 'utf8'),
            { document: { getElementById: id => ids[id], createElement: element }, fetch, window });
        return { ids, fetch, listeners, dispatched };
    }
    const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
    const text = node => node.textContent + node.children.map(text).join('');

    test('shows the panel only with the capability and renders an accessible 30-day table, newest first', async () => {
        const view = projectFunnelView([{ day: '2026-11-13', event: 'visit', count: 5 }, { day: '2026-11-12', event: 'visit', count: 2 }],
            funnelWindow(new Date('2026-11-12T11:30:00Z')));
        const { ids, fetch } = mount({ capabilities: [200, { lookup: false, recovery: [], funnel: true }], funnel: [200, view] });
        await flush();
        expect(ids.funnelPanel.hidden).toBe(false);
        ids.funnelLoad.listeners.click();
        await flush();
        expect(fetch.mock.calls.map(([url, options]) => [url, options.credentials])).toEqual([
            ['/api/dashboard-admin/capabilities', 'same-origin'], ['/api/dashboard-admin/funnel', 'same-origin']]);
        const table = ids.funnelResult.children[0];
        expect(table.tag).toBe('table');
        const [caption, head, body, foot] = table.children;
        expect(caption.tag).toBe('caption');
        expect(head.children[0].children.every(cell => cell.tag === 'th' && cell.scope === 'col')).toBe(true);
        expect(body.children).toHaveLength(30);
        expect(body.children[0].children[0]).toMatchObject({ tag: 'th', scope: 'row', textContent: '2026-11-13' });
        expect(body.children[0].children[1].textContent).toBe('5');
        expect(text(foot)).toContain('30-day total7');
        expect(ids.funnelStatus.textContent).toBe('Funnel counts loaded for 2026-10-15 to 2026-11-13.');
    });

    test('stays hidden without the capability, and a malformed view shows an error, not a table', async () => {
        expect(mount({ capabilities: [200, { lookup: true, recovery: [] }] }).ids.funnelPanel.hidden).toBe(true);
        const { ids } = mount({ capabilities: [200, { funnel: true }], funnel: [200, { days: [] }] });
        await flush();
        ids.funnelLoad.listeners.click();
        await flush();
        expect(ids.funnelResult.hidden).toBe(true);
        expect(ids.funnelStatus.textContent).toBe('Funnel counts could not be loaded. Try again.');
    });

    test.each([401, 403])('a %s while loading clears the table and tells the other panels', async status => {
        const view = projectFunnelView([], funnelWindow(new Date('2026-11-12T11:30:00Z')));
        const responses = { capabilities: [200, { funnel: true }], funnel: [200, view] };
        const { ids, dispatched } = mount(responses);
        await flush();
        ids.funnelLoad.listeners.click(); await flush();
        expect(ids.funnelResult.hidden).toBe(false);
        responses.funnel = [status, {}];
        ids.funnelLoad.listeners.click(); await flush();
        expect(dispatched).toEqual([['dashboard-admin-revoked', status]]);
        expect(ids.funnelResult.hidden).toBe(true);
        expect(ids.funnelResult.children).toEqual([]);
        expect(ids.funnelPanel.hidden).toBe(true);
    });

    test('a superseded request that comes back 401 still broadcasts the revocation', async () => {
        let release;
        const ids = { funnelPanel: element('section'), funnelLoad: element('button'), funnelStatus: element('p'), funnelResult: element('div') };
        const dispatched = [];
        const fetch = jest.fn(url => url.endsWith('capabilities')
            ? Promise.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ funnel: true }) })
            : new Promise(resolve => { release = () => resolve({ status: 401, ok: false, headers: { get: () => 'application/json' }, json: async () => ({}) }); }));
        const window = { addEventListener() {}, CustomEvent: function (type, init) { this.type = type; this.detail = init.detail; },
            dispatchEvent(event) { dispatched.push([event.type, event.detail]); } };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/funnelCountsView.js'), 'utf8'),
            { document: { getElementById: id => ids[id], createElement: element }, fetch, window });
        await flush();
        ids.funnelLoad.listeners.click(); await flush();
        ids.funnelLoad.listeners.click(); await flush();
        release(); await flush();
        expect(dispatched).toEqual([['dashboard-admin-revoked', 401]]);
    });

    test('a revocation broadcast by another panel clears the funnel table', async () => {
        const view = projectFunnelView([], funnelWindow(new Date('2026-11-12T11:30:00Z')));
        const { ids, listeners } = mount({ capabilities: [200, { funnel: true }], funnel: [200, view] });
        await flush();
        ids.funnelLoad.listeners.click(); await flush();
        expect(ids.funnelResult.hidden).toBe(false);
        for (const fn of listeners['dashboard-admin-revoked']) fn({ detail: 401 });
        expect(ids.funnelResult.hidden).toBe(true);
        expect(ids.funnelResult.children).toEqual([]);
        expect(ids.funnelPanel.hidden).toBe(true);
    });

    test('document panel uses a labelled region, live status and an explicit button', () => {
        const html = buildDashboardAdminDocument({ funnel: true });
        expect(html).toMatch(/<section id="funnelPanel" class="admin-panel" aria-labelledby="funnelHeading" hidden>/);
        expect(html).toMatch(/<p id="funnelStatus" role="status" aria-live="polite" aria-atomic="true">/);
        expect(html).toMatch(/<div id="funnelResult" class="table-scroll" tabindex="0" role="region" aria-labelledby="funnelHeading" hidden>/);
        expect(buildDashboardAdminDocument()).toBe(buildDashboardAdminDocument({ funnel: false }));
    });
});
