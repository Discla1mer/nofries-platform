'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/dashboardAdmin/accountLookupClient.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/operator.html'), 'utf8');
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
const json = (status, value) => ({ status, ok: status === 200, redirected: false, headers: { get: () => 'application/json' }, json: async () => value });
const session = json(200, { authenticated: true, purpose: 'operator_dashboard' });
const row = email => ({ email, kind: 'legacy_starter', container: 'legacy-signups', schemaVersion: 1, plan: 'starter', accountType: 'company',
    organisation: 'Synthetic', status: 'active', effectiveAt: null, expiresAt: '2026-11-10T12:00:00.000Z', revision: 1 });
const reply = (email, truncated = false) => json(200, { rows: [row(email)], truncated });

function harness(fetch) {
    const { document, window } = createDom(), nodes = new Map(), create = document.createElement;
    document.createElement = tag => {
        const node = create(tag);
        for (const [method, child] of Object.entries({ createCaption: 'caption', createTHead: 'thead',
            createTBody: 'tbody', insertRow: 'tr', insertCell: 'td' })) {
            node[method] = () => { const item = document.createElement(child); node.append(item); return item; };
        }
        return node;
    };
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="(accountL(?:ookup|ist)[^"]+)"[^>]*>/g)) {
        const node = document.createElement(match[1]); node.value = ''; nodes.set(match[2], node);
    }
    document.getElementById = id => nodes.get(id);
    const button = document.createElement('button'), form = nodes.get('accountLookupForm'); form.append(button);
    window.dispatchEvent = event => window.dispatch(event.type);
    window.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
    vm.runInNewContext(source, { document, window, Event: class { constructor(type) { this.type = type; } }, fetch, AbortController, setTimeout: jest.fn(), clearTimeout: jest.fn() });
    return { nodes, window, button, submit: () => [...form.events.submit][0]({ preventDefault() {} }) };
}
const sessionThenLookup = (...lookups) => {
    const fetch = jest.fn();
    for (const lookup of lookups) fetch.mockReturnValueOnce(Promise.resolve(session)).mockReturnValueOnce(lookup);
    return fetch;
};

test('pagehide aborts an in-flight lookup and restored page can submit without reinitialization', async () => {
    const old = deferred(), next = deferred();
    const fetch = sessionThenLookup(old.promise, next.promise);
    const h = harness(fetch), email = h.nodes.get('accountLookupEmail'), result = h.nodes.get('accountLookupResults');
    email.value = 'before@example.test'; const first = h.submit();
    while (fetch.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    expect(h.button.disabled).toBe(true); expect(result.getAttribute('aria-busy')).toBe('true');
    h.window.dispatch('pagehide');
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(h.button.disabled).toBe(false); expect(result.getAttribute('aria-busy')).toBe('false');
    expect(email.value).toBe(''); expect(result.textContent).toBe('');
    expect(h.nodes.get('accountLookupStatus').textContent).toBe('');
    h.window.dispatch('pageshow'); email.value = 'after@example.test'; const second = h.submit();
    old.resolve(reply('before@example.test')); await first;
    expect(result.textContent).not.toContain('before@example.test');
    next.resolve(reply('after@example.test')); await second;
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [url, options] of fetch.mock.calls) {
        expect(['/api/dashboard/session', '/api/dashboard-admin/accounts/lookup']).toContain(url);
        expect(url).not.toMatch(/email|@|%40|\?/);
        if (url.endsWith('/accounts/lookup')) { expect(options.method).toBe('POST'); expect(options.headers['Content-Type']).toBe('application/json'); }
        else expect(options.headers['X-Nofries-Dashboard-Purpose']).toBe('operator_dashboard');
    }
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ email: 'after@example.test' });
    expect(h.button.disabled).toBe(false); expect(result.getAttribute('aria-busy')).toBe('false');
    expect(result.textContent).toContain('after@example.test'); expect(result.textContent).toContain('legacy_starter');
    expect(h.nodes.get('accountLookupStatus').textContent).toContain('Lookup complete');
});

test('lookup selection is explicit and cleared by input, new lookup and pagehide', async () => {
    const value = { rows: [{ ...row('selected@example.test'), selector: { subjectKey: 'synthetic' } }], truncated: false };
    const h = harness(async url => url === '/api/dashboard/session' ? session : json(200, value)); await h.submit();
    expect(h.window.nofriesAccountSelection).toBeNull();
    const choose = () => h.nodes.get('accountLookupResults').querySelectorAll('button')[1].click();
    choose(); expect(h.window.nofriesAccountSelection).toEqual(value.rows[0]);
    for (const fn of h.nodes.get('accountLookupForm').events.input) fn(); expect(h.window.nofriesAccountSelection).toBeNull();
    await h.submit(); choose(); const next = h.submit(); expect(h.window.nofriesAccountSelection).toBeNull(); await next;
    choose(); h.window.dispatch('pagehide'); expect(h.window.nofriesAccountSelection).toBeNull();
});

test('opens the native operator session once when required and reports the bounded scan cap', async () => {
    const fetch = jest.fn()
        .mockResolvedValueOnce(json(409, { code: 'dashboard_initialization_required' }))
        .mockResolvedValueOnce(json(200, { schemaVersion: 1, initialized: true }))
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(json(200, { rows: [], truncated: true }));
    const h = harness(fetch); h.nodes.get('accountLookupEmail').value = 'capped@example.test'; await h.submit();
    expect(fetch.mock.calls.map(([url, options]) => url + ' ' + options.method)).toEqual(['/api/dashboard/session GET', '/api/dashboard/session POST',
        '/api/dashboard/session GET', '/api/dashboard-admin/accounts/lookup POST']);
    expect(h.nodes.get('accountLookupStatus').textContent).toMatch(/100-record cap.*incomplete/);
    const denied = harness(jest.fn().mockResolvedValueOnce(json(403, { code: 'dashboard_access_denied' })));
    denied.nodes.get('accountLookupEmail').value = 'denied@example.test'; await denied.submit();
    expect(denied.nodes.get('accountLookupStatus').textContent).toContain('Staff admin access is required');
});

test('the signup list loads after the staff session, shows formed date and organisations, and Open runs the email lookup', async () => {
    const listed = { rows: [{ provider: 'external', readable: true, email: 'listed@example.test', accountType: 'consultant', plan: 'starter',
        createdAt: '2026-11-01T00:00:00.000Z', activatedAt: '2026-11-01T00:05:00.000Z', signup: 'activated', signIn: 'active', organisationsComplete: true,
        organisations: [{ name: 'Listed Ltd', kind: 'own' }, { name: 'Client Co', kind: 'client' }] }, { provider: 'legacy', readable: false }], truncated: true };
    const fetch = jest.fn(async url => url === '/api/dashboard/session' ? session : json(200, listed));
    const h = harness(fetch), load = h.nodes.get('accountListLoad'), form = h.nodes.get('accountLookupForm');
    form.requestSubmit = jest.fn(); h.nodes.get('accountLookupPanel').scrollIntoView = jest.fn();
    expect(h.nodes.get('accountListPanel').hidden).toBe(false);
    await [...load.events.click][0]();
    expect(fetch.mock.calls.map(([url, options]) => url + ' ' + options.method)).toEqual(['/api/dashboard/session GET', '/api/dashboard-admin/accounts/lookup POST']);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({});
    const text = h.nodes.get('accountListResults').textContent;
    expect(text).toContain('listed@example.test'); expect(text).toContain('Listed Ltd'); expect(text).toContain('Client Co (client)');
    expect(text).toContain('Consultant'); expect(text).toContain('could not be read');
    expect(h.nodes.get('accountListStatus').textContent).toContain('capped at 200');
    h.nodes.get('accountListResults').querySelectorAll('button')[0].click();
    expect(h.nodes.get('accountLookupEmail').value).toBe('listed@example.test'); expect(form.requestSubmit).toHaveBeenCalled();
    const denied = harness(jest.fn().mockResolvedValueOnce(json(403, { code: 'dashboard_access_denied' })));
    await [...denied.nodes.get('accountListLoad').events.click][0]();
    expect(denied.nodes.get('accountListStatus').textContent).toContain('Staff admin access is required');
});

test('pagehide aborts a pending signup list and its late response is never rendered', async () => {
    const pending = deferred();
    const fetch = jest.fn().mockResolvedValueOnce(session).mockReturnValueOnce(pending.promise);
    const h = harness(fetch), load = h.nodes.get('accountListLoad'), result = h.nodes.get('accountListResults');
    const run = [...load.events.click][0]();
    while (fetch.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    h.window.dispatch('pagehide');
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(load.disabled).toBe(false); expect(result.getAttribute('aria-busy')).toBe('false');
    pending.resolve(json(200, { rows: [{ provider: 'external', readable: true, email: 'late@example.test', accountType: 'company', plan: 'starter',
        createdAt: null, activatedAt: null, signup: 'unfinished', signIn: 'none', organisationsComplete: true, organisations: [] }], truncated: false }));
    await run;
    expect(result.textContent).not.toContain('late@example.test');
    expect(h.nodes.get('accountListStatus').textContent).toBe('');
});

describe('customer accounts list: opens by itself, with Reset and Delete on every row behind one confirmation', () => {
    const listed = { rows: [{ provider: 'external', readable: true, email: 'row@example.test', accountType: 'company', plan: 'starter',
        createdAt: null, activatedAt: null, signup: 'unfinished', signIn: 'none', organisationsComplete: true, organisations: [] }], truncated: false };
    function setup(wipeOn = true, outcome = { done: true, text: 'Delete complete for row@example.test.' }) {
        const fetch = jest.fn(async url => url === '/api/dashboard/session' ? session : json(200, listed));
        const perform = jest.fn(async () => outcome);
        const timers = [];
        const { document, window } = createDom(), nodes = new Map(), create = document.createElement;
        document.createElement = tag => {
            const node = create(tag);
            for (const [method, child] of Object.entries({ createCaption: 'caption', createTHead: 'thead', createTBody: 'tbody', insertRow: 'tr', insertCell: 'td' }))
                node[method] = () => { const item = document.createElement(child); node.append(item); return item; };
            if (tag === 'dialog') { node.open = false; node.showModal = jest.fn(() => { node.open = true; }); node.close = jest.fn(() => { node.open = false; }); }
            return node;
        };
        for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="(accountL(?:ookup|ist)[^"]+)"[^>]*>/g)) { const node = document.createElement(match[1]); node.value = ''; nodes.set(match[2], node); }
        document.getElementById = id => nodes.get(id);
        nodes.get('accountLookupForm').append(document.createElement('button'));
        window.dispatchEvent = event => window.dispatch(event.type);
        window.nofriesAccountWipe = { perform, available: () => wipeOn };
        vm.runInNewContext(source, { document, window, Event: class { constructor(type) { this.type = type; } }, fetch, AbortController,
            setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: jest.fn() });
        const dialog = nodes.get('accountListPanel').querySelector('dialog');
        const button = name => nodes.get('accountListResults').querySelectorAll('button').find(item => item.textContent === name);
        return { fetch, perform, timers, nodes, dialog, button };
    }
    const autoload = async h => { const [fn, ms] = h.timers.find(([, ms]) => ms === 0); expect(ms).toBe(0); await fn(); };

    test('the list loads straight away and each row carries Open, Reset and Delete', async () => {
        const h = setup();
        expect(h.fetch).not.toHaveBeenCalled();
        await autoload(h);
        expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({});
        for (const name of ['Open', 'Reset', 'Delete']) { expect(h.button(name)).toBeTruthy(); expect(h.button(name).hidden).toBe(false); }
        expect(h.button('Delete').getAttribute('aria-label')).toBe('Delete row@example.test');
        expect(h.nodes.get('accountListStatus').textContent).toBe('1 account.');
    });

    test('Delete asks once, naming the account; Yes deletes and marks the row, Cancel does nothing', async () => {
        const h = setup();
        await autoload(h);
        h.button('Delete').click();
        expect(h.dialog.showModal).toHaveBeenCalled();
        expect(h.dialog.textContent).toContain('Delete this account?');
        expect(h.dialog.textContent).toContain('row@example.test');
        expect(h.dialog.textContent).toContain('cannot be undone');
        h.dialog.querySelectorAll('button').find(item => item.textContent === 'Cancel').click();
        expect(h.dialog.open).toBe(false); expect(h.perform).not.toHaveBeenCalled();
        h.button('Delete').click();
        h.dialog.querySelectorAll('button').find(item => item.textContent === 'Yes, delete').click();
        await new Promise(resolve => setImmediate(resolve));
        expect(h.perform).toHaveBeenCalledWith('delete', 'row@example.test', 'external');
        expect(h.perform).toHaveBeenCalledTimes(1);
        expect(h.nodes.get('accountListResults').textContent).toContain('Delete complete for row@example.test.');
        expect(h.nodes.get('accountListResults').querySelectorAll('.account-deleted')).toHaveLength(1);
        expect(h.button('Delete').hidden).toBe(true);
    });

    test('Reset confirms with its own wording and keeps the row', async () => {
        const h = setup(true, { done: true, text: 'Reset complete for row@example.test: 3 database rows cleared. Sign-in is kept.' });
        await autoload(h);
        h.button('Reset').click();
        expect(h.dialog.textContent).toContain('Reset this account?');
        expect(h.dialog.textContent).toContain('Sign-in, email and organisations are kept');
        h.dialog.querySelectorAll('button').find(item => item.textContent === 'Yes, reset').click();
        await new Promise(resolve => setImmediate(resolve));
        expect(h.perform).toHaveBeenCalledWith('reset', 'row@example.test', 'external');
        expect(h.button('Delete').hidden).toBe(false);
    });

    test('without the staff wipe, rows show Open only and nothing can be confirmed', async () => {
        const h = setup(false);
        await autoload(h);
        expect(h.button('Open').hidden).toBe(false);
        expect(h.button('Delete').hidden).toBe(true); expect(h.button('Reset').hidden).toBe(true);
        h.button('Delete').click();
        expect(h.dialog.showModal).not.toHaveBeenCalled(); expect(h.perform).not.toHaveBeenCalled();
    });
});

test.each([
    ['active', 'Active dashboard membership', 'Active in this organisation'],
    ['not_started', 'Workspace activated', 'No active membership'],
    [null, 'Workspace activated', 'No active membership'],
])('checkpoint summary separates scoped membership (%s) from a browser load', async (effectiveStatus, last, membership) => {
    const selected = { ...row('selected@example.test'), effectiveAt: '2026-10-01T10:00:00.000Z', selector: { subjectKey: 'synthetic' } };
    const fetch = sessionThenLookup(json(200, { rows: [selected] })).mockResolvedValueOnce(json(200, { result: {
        status: 'found', revisions: { membership: 1 }, organisation: { displayName: 'Synthetic' },
        memberships: effectiveStatus ? [{ effectiveStatus, status: 'active', roles: ['owner'], validUntil: 'later' }] : []
    } }));
    const h = harness(fetch); await h.submit();
    const result = h.nodes.get('accountLookupResults');
    expect(result.textContent).toContain('Dashboard membership: Not checked');
    await [...result.querySelectorAll('button')[0].events.click][0]();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.textContent).toContain('Last confirmed onboarding checkpoint: ' + last);
    expect(result.textContent).toContain('Dashboard membership: ' + membership);
    expect(result.textContent).toContain('Agreement acceptance: Not verified');
    expect(result.textContent).toContain('First successful dashboard load: Not recorded');
});

test('sign-in record alone is not a starter, workspace or membership checkpoint', async () => {
    const h = harness(sessionThenLookup(json(200, { rows: [{ ...row('only@example.test'), plan: null }] }))); await h.submit();
    expect(h.nodes.get('accountLookupResults').textContent).toContain('Last confirmed onboarding checkpoint: None confirmed here');
});

test('every list and lookup cell names its column so narrow screens can show labelled cards', async () => {
    const cells = node => [...(node.tagName === 'TD' ? [node] : []), ...node.children.flatMap(cells)];
    const listed = { rows: [{ provider: 'external', readable: true, email: 'card@example.test', accountType: 'company', plan: 'starter',
        createdAt: '2026-11-01T00:00:00.000Z', activatedAt: null, signup: 'unfinished', signIn: 'none', organisationsComplete: true,
        organisations: [{ name: 'Card Ltd', kind: 'own' }] }], truncated: false };
    const list = harness(jest.fn(async url => url === '/api/dashboard/session' ? session : json(200, listed)));
    await [...list.nodes.get('accountListLoad').events.click][0]();
    expect(cells(list.nodes.get('accountListResults')).map(cell => cell.getAttribute('data-label')))
        .toEqual(['Email', 'Type', 'Account formed', 'Signup', 'Sign-in record', 'Organisations', 'Plan', 'Actions']);
    const lookup = harness(sessionThenLookup(reply('card@example.test')));
    lookup.nodes.get('accountLookupEmail').value = 'card@example.test'; await lookup.submit();
    const labels = cells(lookup.nodes.get('accountLookupResults')).map(cell => cell.getAttribute('data-label'));
    expect(labels).toEqual(['Email', 'Store', 'Schema', 'Plan', 'Type', 'Organisation', 'Sign-in record', 'Activated (UTC)',
        'Recorded end date, not enforced (UTC)', 'Revision', 'Dashboard access']);
});
