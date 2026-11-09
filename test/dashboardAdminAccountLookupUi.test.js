'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/dashboardAdmin/accountLookupClient.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/operator.html'), 'utf8');
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
const reply = email => ({ ok: true, json: async () => ({ rows: [{ email, accountType: 'company', organisation: 'Synthetic',
    status: 'active', expiresAt: '2026-11-10T12:00:00.000Z', revision: 1 }] }) });

function harness(fetch) {
    const { document, window } = createDom(), nodes = new Map(), create = document.createElement;
    // Table APIs absent from the shared minimal DOM, using its actual node model.
    document.createElement = tag => {
        const node = create(tag);
        for (const [method, child] of Object.entries({ createCaption: 'caption', createTHead: 'thead',
            createTBody: 'tbody', insertRow: 'tr', insertCell: 'td' })) {
            node[method] = () => { const item = document.createElement(child); node.append(item); return item; };
        }
        return node;
    };
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="(accountLookup[^"]+)"[^>]*>/g)) {
        const node = document.createElement(match[1]); node.value = ''; nodes.set(match[2], node);
    }
    document.getElementById = id => nodes.get(id);
    const button = document.createElement('button'), form = nodes.get('accountLookupForm'); form.append(button);
    vm.runInNewContext(source, { document, window, fetch, AbortController, setTimeout: jest.fn(), clearTimeout: jest.fn() });
    return { nodes, window, button, submit: () => [...form.events.submit][0]({ preventDefault() {} }) };
}

test('pagehide aborts an in-flight lookup and restored page can submit without reinitialization', async () => {
    const old = deferred(), next = deferred();
    const fetch = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const h = harness(fetch), email = h.nodes.get('accountLookupEmail'), result = h.nodes.get('accountLookupResults');
    email.value = 'before@example.test'; const first = h.submit();
    expect(h.button.disabled).toBe(true); expect(result.getAttribute('aria-busy')).toBe('true');
    h.window.dispatch('pagehide');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.button.disabled).toBe(false); expect(result.getAttribute('aria-busy')).toBe('false');
    expect(email.value).toBe(''); expect(result.textContent).toBe('');
    expect(h.nodes.get('accountLookupStatus').textContent).toBe('');
    // A bfcache restore keeps this document and its listeners; it does not rerun the script.
    h.window.dispatch('pageshow'); email.value = 'after@example.test'; const second = h.submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
        expect(url).toBe('/api/dashboard-admin/accounts/lookup');
        expect(url).not.toMatch(/email|@|%40|\?/);
        expect(options.method).toBe('POST'); expect(options.headers['Content-Type']).toBe('application/json');
    }
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ email: 'after@example.test' });
    old.resolve(reply('before@example.test')); await first;
    expect(h.button.disabled).toBe(true); expect(result.getAttribute('aria-busy')).toBe('true');
    expect(result.textContent).not.toContain('before@example.test');
    next.resolve(reply('after@example.test')); await second;
    expect(h.button.disabled).toBe(false); expect(result.getAttribute('aria-busy')).toBe('false');
    expect(result.textContent).toContain('after@example.test');
    expect(h.nodes.get('accountLookupStatus').textContent).toContain('Lookup complete');
});
