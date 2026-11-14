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
    expect(fetch.mock.calls.map(([url, options]) => url + ' ' + options.method)).toEqual(['/api/dashboard/session GET', '/api/dashboard-admin/accounts/list POST']);
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
