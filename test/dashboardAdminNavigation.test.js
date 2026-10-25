'use strict';

// Synthetic source tests only. Capability responses below do not grant access;
// the actual Express boundary is exercised separately in this file.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const { createNoFriesApp } = require('../server');
const request = require('supertest');
const { normaliseReturnTo } = require('../api/shared/browserAuth');
const { buildDashboardAdminEntryDocument } = require('../lib/dashboardAdminEntryDocument');
const { createDashboardAdminSignupRuntime } = require('../api/shared/dashboardAdmin/signupAuditRuntimeAdapter');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { entrySessionFixture, SUBJECT, NOW } = require('./fixtures/dashboardAdminEntrySession');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/operator-loader.js'), 'utf8');
const operatorDocument = fs.readFileSync(path.join(root, 'app/operator.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function navigationHarness() {
    const { document, window } = createDom();
    const requests = [], scripts = [], listeners = new Map(), timers = new Map();
    let nextTimer = 0;
    const link = document.createElement('a');
    link.id = 'dashboardAdminNavigation'; link.href = '/dashboard-admin/entry'; link.hidden = true;
    const status = document.createElement('p');
    document.body = document.createElement('body'); document.body.dataset.page = 'operator';
    document.head = { append(script) { scripts.push(script); } };
    document.getElementById = id => id === link.id ? link : id === 'loadingStatus' ? status : null;
    window.location.replace = jest.fn();
    window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
    window.addEventListener = (name, callback) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
    };
    const fetch = jest.fn((url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })));
    vm.runInNewContext(source, { document, window, fetch, AbortController });
    return { document, window, link, requests, scripts, fetch,
        event(name, event = {}) { for (const callback of listeners.get(name) || []) callback(event); },
        expire() { for (const [id, timer] of [...timers]) if (timer.delay === 5000) { timers.delete(id); timer.callback(); } },
        async reply(index, statusCode, body, extra = {}) {
            requests[index].resolve({ status: statusCode, ok: statusCode >= 200 && statusCode < 300,
                headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body, ...extra });
            await flush();
        },
        async verify() { await this.reply(0, 200, { authenticated: true }); }
    };
}

describe('optional staff administration navigation', () => {
    test('uses a native hidden link in the wrapping private navigation', () => {
        expect(operatorDocument).toMatch(/<a id="dashboardAdminNavigation" href="\/dashboard-admin\/entry" hidden>Dashboard administration<\/a>/);
        expect(operatorDocument.indexOf('dashboardAdminNavigation')).toBeGreaterThan(operatorDocument.indexOf('aria-label="Private workspace navigation"'));
        const css = fs.readFileSync(path.join(root, 'app/operator.css'), 'utf8');
        expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
        expect(css).toMatch(/\.operator-header nav\s*\{[^}]*flex-wrap:\s*wrap/);
        expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    });

    test('never discovers admin capability before genuine session verification', async () => {
        const h = navigationHarness();
        h.event('focus'); h.event('pageshow', { persisted: true }); await flush();
        expect(h.requests.map(value => value.url)).toEqual(['/api/auth/session']);
        await h.reply(0, 401, { authenticated: false });
        expect(h.link.hidden).toBe(true); expect(h.scripts).toHaveLength(0);
        expect(h.window.location.replace).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Foperator');
    });

    test('shows the native link only after permission to open the empty staff entry', async () => {
        const h = navigationHarness(); await h.verify();
        expect(h.scripts).toHaveLength(1);
        expect(h.scripts[0].src).toBe('/api/lifecycle/app.js');
        expect(h.link.hidden).toBe(true);
        expect(h.requests[1]).toMatchObject({ url: '/api/dashboard-admin/entry-capabilities', options: {
            credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }
        } });
        await h.reply(1, 200, { entry: true });
        expect(h.link.hidden).toBe(false);
        h.link.focus(); expect(h.document.activeElement).toBe(h.link);
        expect(h.link.href).toBe('/dashboard-admin/entry');
    });

    test.each([
        [200, { entry: false }], [200, { entry: 'true' }],
        [200, {}], [200, { lookup: true, recovery: [] }],
        [200, { entry: true, error: 'untrusted' }],
        [200, null], [401, { code: 'dashboard_admin_authentication_required' }],
        [403, { code: 'dashboard_admin_access_denied' }], [404, {}], [503, {}]
    ])('keeps optional navigation hidden for missing, malformed or denied capability %s %j', async (statusCode, body) => {
        const h = navigationHarness(); await h.verify(); await h.reply(1, statusCode, body);
        expect(h.link.hidden).toBe(true); expect(h.scripts).toHaveLength(1);
        expect(h.window.location.replace).not.toHaveBeenCalled();
    });

    test('a failed optional request does not block the existing protected application', async () => {
        const h = navigationHarness(); await h.verify(); h.requests[1].reject(new Error('synthetic network failure')); await flush();
        expect(h.link.hidden).toBe(true); expect(h.scripts).toHaveLength(1);
        expect(h.window.location.replace).not.toHaveBeenCalled();
    });

    test.each([
        { redirected: true }, { type: 'opaqueredirect' },
        { headers: { get: () => 'text/html' } }, { json: async () => { throw new Error('bad JSON'); } }
    ])('rejects an untrusted capability transport', async extra => {
        const h = navigationHarness(); await h.verify(); await h.reply(1, 200, { entry: true }, extra);
        expect(h.link.hidden).toBe(true);
    });

    test('bounds discovery and ignores a successful response received after its timeout', async () => {
        const h = navigationHarness(); await h.verify(); h.expire();
        expect(h.requests[1].options.signal.aborted).toBe(true);
        await h.reply(1, 200, { entry: true }); expect(h.link.hidden).toBe(true);
    });

    test('repeated focus cancels previous discovery and discards out-of-order responses', async () => {
        const h = navigationHarness(); await h.verify(); h.event('focus'); await flush();
        expect(h.requests[1].options.signal.aborted).toBe(true);
        await h.reply(2, 200, { entry: false });
        await h.reply(1, 200, { entry: true }); expect(h.link.hidden).toBe(true);
        h.event('focus'); await flush(); await h.reply(3, 200, { entry: true });
        expect(h.link.hidden).toBe(false);
        h.event('focus'); expect(h.link.hidden).toBe(true); await flush();
        await h.reply(4, 403, { code: 'dashboard_admin_access_denied' }); expect(h.link.hidden).toBe(true);
    });

    test('pagehide cancels discovery and persisted restoration checks current authority again', async () => {
        const h = navigationHarness(); await h.verify(); h.event('pagehide');
        expect(h.requests[1].options.signal.aborted).toBe(true);
        await h.reply(1, 200, { entry: true }); expect(h.link.hidden).toBe(true);
        h.event('focus'); await flush(); expect(h.requests).toHaveLength(2);
        h.event('pageshow', { persisted: true }); await flush();
        expect(h.requests).toHaveLength(3);
        await h.reply(2, 401, { code: 'dashboard_admin_authentication_required' }); expect(h.link.hidden).toBe(true);
    });
});

const entrySource = fs.readFileSync(path.join(root, 'api/shared/protectedAssets/dashboardAdminEntry.js'), 'utf8');
const readySession = overrides => ({ schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard',
    expiresAt: new Date(Date.now() + 60000).toISOString(), generation: 'a'.repeat(64), selectedBindingId: null, ...overrides });
function entryHarness({ crypto = { randomUUID: () => '85000000-0000-4000-8000-000000000999' } } = {}) {
    const { document, window } = createDom();
    const requests = [], timers = new Map(); let timerId = 0;
    const elements = Object.fromEntries(['adminEntryOpen', 'adminEntryCancel', 'adminEntryStatus', 'adminEntrySignIn']
        .map(id => [id, document.createElement(id === 'adminEntryStatus' ? 'p' : id === 'adminEntrySignIn' ? 'a' : 'button')]));
    document.body = document.createElement('body'); document.body.dataset.page = 'dashboard-admin-entry';
    document.getElementById = id => elements[id];
    window.crypto = crypto; window.location.assign = jest.fn();
    window.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
    window.clearTimeout = id => timers.delete(id);
    const fetch = jest.fn((url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })));
    vm.runInNewContext(entrySource, { document, window, fetch, AbortController });
    return { document, window, elements, requests,
        async open() { elements.adminEntryOpen.click(); await flush(); },
        cancel() { elements.adminEntryCancel.click(); },
        expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
        async reply(index, statusCode, value, extra = {}) {
            requests[index].resolve({ status: statusCode, headers: { get: () => 'application/json' }, json: async () => value, ...extra });
            await flush();
        }
    };
}

describe('explicit administration entry protocol', () => {
    test('entry has no inline execution or protected data assets and makes no automatic requests', async () => {
        const html = buildDashboardAdminEntryDocument();
        expect(html).toContain('src="/api/dashboard-admin/entry.js"');
        expect(html).toContain('href="/assets/operator.css"');
        expect(html).toContain('role="status" aria-live="polite"');
        expect(html).not.toMatch(/<style|<script(?! src)|on(?:click|load)=|dashboard-admin\/app\./);
        const h = entryHarness(); await flush(); expect(h.requests).toHaveLength(0);
    });

    test('only explicit intent and exact initialization signal permit one command followed by fresh authority', async () => {
        const h = entryHarness(); await h.open();
        expect(h.elements.adminEntryOpen.disabled).toBe(true);
        await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests[1]).toMatchObject({ url: '/api/dashboard/session', options: { method: 'POST',
            credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard', 'Content-Type': 'application/json' } } });
        expect(JSON.parse(h.requests[1].options.body)).toEqual({ operationId: '85000000-0000-4000-8000-000000000999' });
        await h.open(); expect(h.requests).toHaveLength(2);
        await h.reply(1, 200, { schemaVersion: 1, initialized: true });
        expect(h.requests[2].options.method).toBe('GET');
        expect(h.requests[2].options.headers['X-Nofries-Dashboard-Purpose']).toBe('operator_dashboard');
        await h.reply(2, 200, readySession());
        expect(h.requests[3].url).toBe('/api/dashboard-admin/capabilities');
        expect(h.requests[3].options.headers).not.toHaveProperty('X-Nofries-Dashboard-Purpose');
        await h.reply(3, 200, { lookup: false, signupList: true, recovery: [] });
        expect(h.window.location.assign).toHaveBeenCalledWith('/dashboard-admin');
        expect(h.requests.map(value => value.url)).toEqual(['/api/dashboard/session', '/api/dashboard/session',
            '/api/dashboard/session', '/api/dashboard-admin/capabilities']);
    });

    test('an existing native staff session checks current capability without an initialization command', async () => {
        const h = entryHarness(); await h.open(); await h.reply(0, 200, readySession({ activationAvailable: true }));
        await h.reply(1, 200, { lookup: true, recovery: [] });
        expect(h.window.location.assign).toHaveBeenCalledWith('/dashboard-admin');
        expect(h.requests.every(value => value.options.method === 'GET')).toBe(true);
    });

    test.each([[409, {}], [409, { code: 'dashboard_initialization_required', extra: true }],
        [409, { code: 'dashboard_revoked' }], [503, { code: 'dashboard_unavailable' }],
        [200, readySession({ purpose: 'customer' })], [200, readySession({ expiresAt: '2020-01-01T00:00:00.000Z' })],
        [200, readySession({ generation: null })], [200, readySession({ selectedBindingId: 'bad-id' })]])
    ('denied, malformed or unknown session state never permits initialization %s %j', async (statusCode, value) => {
        const h = entryHarness(); await h.open(); await h.reply(0, statusCode, value);
        expect(h.requests).toHaveLength(1); expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.elements.adminEntryOpen.disabled).toBe(false);
    });

    test.each([null, { randomUUID: () => 'invalid' }])('missing secure operation IDs prevent any command', async crypto => {
        const h = entryHarness({ crypto }); await h.open(); await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests).toHaveLength(1); expect(h.window.location.assign).not.toHaveBeenCalled();
    });

    test.each([[200, { lookup: false, signupList: false, recovery: [] }], [200, { lookup: 'true', recovery: [] }],
        [200, { lookup: false, signupList: 'true', recovery: [] }], [200, { lookup: true }],
        [200, { lookup: true, recovery: [], private: 'canary' }], [503, {}]])
    ('absence or invalid capability stays at the data-free entry %s %j', async (statusCode, value) => {
        const h = entryHarness(); await h.open(); await h.reply(0, 200, readySession()); await h.reply(1, statusCode, value);
        expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.elements.adminEntryStatus.textContent).toMatch(/access is unavailable/);
        expect(h.elements.adminEntryStatus.textContent).not.toContain('canary');
    });

    test.each([401, 403])('access revoked during final capability check clears the entry flow: %s', async statusCode => {
        const h = entryHarness(); await h.open(); await h.reply(0, 200, readySession());
        await h.reply(1, statusCode, { error: 'PRIVATE_DIAGNOSTIC' });
        expect(h.window.location.assign).not.toHaveBeenCalled();
        expect(h.elements.adminEntrySignIn.hidden).toBe(statusCode !== 401);
        expect(h.elements.adminEntryStatus.textContent).not.toContain('PRIVATE_DIAGNOSTIC');
    });

    test.each([[503, {}], [200, { schemaVersion: 1, initialized: false }],
        [200, { schemaVersion: 1, initialized: true, extra: true }]])
    ('an uncertain acknowledgement never generates or resends an initialization command %s %j', async (statusCode, value) => {
        const h = entryHarness(); await h.open(); await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        await h.reply(1, statusCode, value);
        expect(h.elements.adminEntryStatus.textContent).toMatch(/could not be confirmed/);
        await h.open(); await h.reply(2, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests).toHaveLength(3); expect(h.requests.filter(item => item.options.method === 'POST')).toHaveLength(1);
        await h.open(); await h.reply(3, 200, readySession()); await h.reply(4, 200, { lookup: true, recovery: [] });
        expect(h.window.location.assign).toHaveBeenCalledWith('/dashboard-admin');
    });

    test('cancelled initialization checks current state without repeating the uncertain command', async () => {
        const h = entryHarness(); await h.open(); await h.reply(0, 409, { code: 'dashboard_initialization_required' });
        h.cancel(); expect(h.requests[1].options.signal.aborted).toBe(true);
        expect(h.document.activeElement).toBe(h.elements.adminEntryOpen);
        await h.reply(1, 200, { schemaVersion: 1, initialized: true }); expect(h.requests).toHaveLength(2);
        await h.open(); await h.reply(2, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests).toHaveLength(3); expect(h.elements.adminEntryStatus.textContent).toMatch(/could not be confirmed/);
    });

    test('timeout, cancellation and pagehide ignore late successes, with explicit checks still possible', async () => {
        const h = entryHarness(); await h.open(); h.expire(); await flush();
        expect(h.requests[0].options.signal.aborted).toBe(true);
        await h.reply(0, 200, readySession()); expect(h.requests).toHaveLength(1);
        await h.open(); h.cancel(); await h.reply(1, 409, { code: 'dashboard_initialization_required' });
        expect(h.requests).toHaveLength(2);
        await h.open(); await h.reply(2, 200, readySession()); h.window.dispatch('pagehide');
        expect(h.requests[3].options.signal.aborted).toBe(true);
        await h.reply(3, 200, { lookup: true, recovery: [] });
        expect(h.window.location.assign).not.toHaveBeenCalled();
    });
});

function composedEntry() {
    const h = entrySessionFixture();
    const grant = { schemaVersion: 1, capability: 'signupList', operatorSubjectKey: SUBJECT, provider: 'legacy',
        tenantId: 'synthetic-entry-tenant', populationId: 'synthetic-entry-population', indexId: 'synthetic-entry-index',
        authorityRevision: 1, issuedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 600000).toISOString(),
        maxPageSize: 1, maxRows: 1, maxPages: 1, fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-entry-policy' };
    const approved = { value: grant };
    const readApprovedAuthority = jest.fn(async () => approved.value);
    const resolvePopulationBinding = jest.fn(async () => ({ authoritySha256: hash(grant), manifestSha256: 'b'.repeat(64) }));
    const readSignupPage = jest.fn(async () => { throw new Error('NO_SOURCE_READ_EXPECTED'); });
    const config = Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
        'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId'].map(key => [key, h.dashboard[key]]));
    const native = createDashboardAdminSignupRuntime({ ...config, readApprovedAuthority, resolvePopulationBinding, readSignupPage });
    h.rebuild({ dashboardAdminSignupList: native });
    return { h, native, approved, readApprovedAuthority, resolvePopulationBinding, readSignupPage };
}

describe('actual protected host administration entry', () => {
    test.each(['/dashboard-admin/entry', '/api/dashboard-admin/entry.js', '/api/dashboard-admin/entry-capabilities'])
    ('default composition stays disabled: %s', async route => {
        const response = await request(createNoFriesApp()).get(route);
        expect(response.status).toBe(503); expect(response.body).toEqual({ code: 'dashboard_admin_unavailable' });
        expect(response.headers.location).toBeUndefined(); expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
    });

    test('genuine callback returns to the empty entry, then only the explicit native command creates a gate', async () => {
        const { h, approved, readApprovedAuthority, readSignupPage } = composedEntry();
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
        const started = await h.send('get', '/dashboard-admin');
        expect(started.status).toBe(302);
        expect(h.store.transactions.size).toBe(1);
        expect([...h.store.transactions.values()][0].returnTo).toBe('/dashboard-admin/entry');
        const transaction = started.headers['set-cookie'][0].split(';')[0];
        const callback = await h.send('post', '/api/auth/callback').set('Cookie', transaction).type('form')
            .send({ code: 'synthetic-entry-code', state: new URL(started.headers.location).searchParams.get('state') });
        expect(callback.status).toBe(303); expect(callback.headers.location).toBe('/dashboard-admin/entry');
        const cookie = callback.headers['set-cookie'].find(value => value.startsWith('__Host-nofries-auth=')).split(';')[0];
        expect(h.proofs.size).toBe(1); expect(h.state.tables.dashboard_session_gates).toEqual([]);
        expect(h.pool.connect).not.toHaveBeenCalled();
        for (const route of ['/dashboard-admin/entry', '/api/dashboard-admin/entry.js', '/api/dashboard-admin/entry-capabilities']) {
            const entry = await h.send('get', route).set('Cookie', cookie);
            expect(entry.status).toBe(200); expect(entry.headers['cache-control']).toBe('private, no-store, max-age=0');
        }
        expect(h.pool.connect).not.toHaveBeenCalled(); expect(readApprovedAuthority).not.toHaveBeenCalled();
        const before = await h.send('get', '/api/dashboard/session').set('Cookie', cookie)
            .set('X-Nofries-Dashboard-Purpose', 'operator_dashboard');
        expect(before.status).toBe(409); expect(before.body).toEqual({ code: 'dashboard_initialization_required' });
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
        const initialized = await h.send('post', '/api/dashboard/session').set('Cookie', cookie)
            .set('X-Nofries-Dashboard-Purpose', 'operator_dashboard').set('Origin', h.env.NOFRIES_PUBLIC_URL)
            .set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() });
        expect(initialized.status).toBe(200); expect(initialized.body).toEqual({ schemaVersion: 1, initialized: true });
        expect(h.state.tables.dashboard_session_gates).toHaveLength(1);
        const current = await h.send('get', '/api/dashboard/session').set('Cookie', cookie)
            .set('X-Nofries-Dashboard-Purpose', 'operator_dashboard');
        expect(current.body).toMatchObject({ authenticated: true, purpose: 'operator_dashboard', selectedBindingId: null });
        const capability = await h.send('get', '/api/dashboard-admin/capabilities').set('Cookie', cookie);
        expect(capability.body).toEqual({ lookup: false, signupList: true, recovery: [] });
        expect((await h.send('get', '/dashboard-admin').set('Cookie', cookie)).status).toBe(200);
        expect(readSignupPage).not.toHaveBeenCalled();
        expect(h.state.trace.some(row => /dashboard_organisations|dashboard_bootstrap|dashboard_memberships/.test(row.sql))).toBe(false);
        approved.value = null;
        const revoked = await h.send('get', '/dashboard-admin').set('Cookie', cookie);
        expect(revoked.status).toBe(403); expect(revoked.headers.location).toBeUndefined();
    });

    test.each(['/dashboard-admin', '/dashboard-admin/entry/', '/dashboard-admin/entry/other', '//attacker.invalid/dashboard-admin/entry'])
    ('only the exact empty entry is newly accepted as a login return: %s', value => {
        expect(normaliseReturnTo('/dashboard-admin/entry', 'https://entry-session.invalid', '/operator')).toBe('/dashboard-admin/entry');
        expect(() => normaliseReturnTo(value, 'https://entry-session.invalid', '/operator')).toThrow();
    });

    test.each(['__Host-nofries-customer', '__Host-nofries-external-customer', '__Host-nofries-retained-read'])
    ('a customer-only cookie gains neither entry nor operator metadata: %s', async name => {
        const { h } = composedEntry(); const { cookie } = await h.login(); h.resetObservations();
        for (const route of ['/dashboard-admin', '/dashboard-admin/entry', '/api/dashboard-admin/entry.js', '/api/dashboard-admin/entry-capabilities']) {
            const response = await h.send('get', route).set('Cookie', cookie.replace('__Host-nofries-auth', name));
            expect(response.status).toBe(401); expect(response.headers.location).toBeUndefined();
            expect(response.body).toEqual({ code: 'dashboard_admin_authentication_required' });
        }
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('a genuine Consultant is denied before native grants or sources', async () => {
        const { h, native, readApprovedAuthority } = composedEntry();
        h.dashboard.browserAuthOptions.env.NOFRIES_ADMIN_SUBJECTS = '';
        h.rebuild({ dashboardAdminSignupList: native });
        const { cookie } = await h.login(); h.resetObservations();
        for (const route of ['/dashboard-admin', '/dashboard-admin/entry', '/api/dashboard-admin/entry.js', '/api/dashboard-admin/entry-capabilities']) {
            const response = await h.send('get', route).set('Cookie', cookie);
            expect(response.status).toBe(403); expect(response.headers.location).toBeUndefined();
        }
        expect(readApprovedAuthority).not.toHaveBeenCalled(); expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('entry APIs remain JSON401 and invalid methods or queries never start sign-in', async () => {
        const { h } = composedEntry();
        for (const route of ['/api/dashboard-admin/entry.js', '/api/dashboard-admin/entry-capabilities', '/api/dashboard-admin/capabilities']) {
            const response = await h.send('get', route);
            expect(response.status).toBe(401); expect(response.headers.location).toBeUndefined();
        }
        for (const [method, route, statusCode] of [['get', '/dashboard-admin/entry?returnTo=/operator', 400],
            ['post', '/dashboard-admin/entry', 405], ['get', '/dashboard-admin?x=1', 400],
            ['get', '/api/dashboard-admin/entry-capabilities?x=1', 400], ['get', '/dashboard-admin/entry/', 404]]) {
            const response = await h.send(method, route);
            expect(response.status).toBe(statusCode); expect(response.headers.location).toBeUndefined();
        }
        expect(h.store.transactions.size).toBe(0); expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('entry capability is withheld if the real parent session is revoked before disclosure', async () => {
        const { h } = composedEntry(); const { cookie } = await h.login(); h.resetObservations();
        const original = h.store.loadSession.bind(h.store); let reads = 0;
        h.store.loadSession = async token => ++reads === 1 ? original(token) : null;
        // Reconstruct captures the actual store method; no mock identity replaces authentication.
        h.rebuild({ dashboardAdminSignupList: { authoriseSignupList: async () => null, readSignupPage: null,
            audit: null, clock: h.dashboard.clock, requestBudgetMs: 1000 } });
        const response = await h.send('get', '/api/dashboard-admin/entry-capabilities').set('Cookie', cookie);
        expect(response.status).toBe(401); expect(response.body).toEqual({ code: 'dashboard_admin_authentication_required' });
        expect(h.pool.connect).not.toHaveBeenCalled();
    });
});
