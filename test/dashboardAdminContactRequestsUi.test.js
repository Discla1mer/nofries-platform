'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/dashboardAdmin/contactRequestsClient.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/operator.html'), 'utf8');
const json = (status, value) => ({ status, ok: status === 200, redirected: false, headers: { get: () => 'application/json' }, json: async () => value });
const session = json(200, { authenticated: true, purpose: 'operator_dashboard' });

function harness(fetch) {
    const { document, window } = createDom(), nodes = new Map(), create = document.createElement;
    document.createElement = tag => {
        const node = create(tag);
        for (const [method, child] of Object.entries({ createCaption: 'caption', createTHead: 'thead', createTBody: 'tbody', insertRow: 'tr', insertCell: 'td' })) {
            node[method] = () => { const item = document.createElement(child); node.append(item); return item; };
        }
        return node;
    };
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="(contactRequests[^"]+)"[^>]*>/g)) nodes.set(match[2], document.createElement(match[1]));
    nodes.get('contactRequestsPanel').hidden = true;
    document.getElementById = id => nodes.get(id);
    window.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
    vm.runInNewContext(source, { document, window, fetch, AbortController, setTimeout: jest.fn(), clearTimeout: jest.fn() });
    return { nodes, window, load: () => [...nodes.get('contactRequestsLoad').events.click][0]() };
}

test('the operator page has a hidden read-only panel with no form or edit control', () => {
    const panel = html.slice(html.indexOf('<section id="contactRequestsPanel"'), html.indexOf('</section>', html.indexOf('<section id="contactRequestsPanel"')));
    expect(panel).toContain('hidden');
    expect(panel).not.toMatch(/<form|<input|delete|edit/i);
});

test('loads on request, renders NZ time, organisation, topic and email as text, and marks owner fallback', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(json(200, { truncated: false, windowDays: 90, rows: [
        { requestedAt: '2026-11-18T22:30:00.000Z', organisation: '<img src=x onerror=alert(1)>', topic: 'Results', contactEmail: 'asker@example.test', contactBasis: 'requester' },
        { requestedAt: '2026-11-10T01:00:00.000Z', organisation: 'Alpha Ltd', topic: 'Managed IT', contactEmail: 'owner@example.test', contactBasis: 'account' }] }));
    const h = harness(fetch);
    expect(h.nodes.get('contactRequestsPanel').hidden).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await h.load();
    expect(fetch.mock.calls[1][0]).toBe('/api/dashboard-admin/accounts/lookup');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ contactRequests: true });
    expect(fetch.mock.calls.every(([url]) => !url.includes('@') && !url.includes('?'))).toBe(true);
    const text = h.nodes.get('contactRequestsResults').textContent;
    expect(text).toContain('19 Nov 2026');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).toContain('asker@example.test');
    expect(text).toMatch(/owner@example\.test\s*\(account owner/);
    expect(h.nodes.get('contactRequestsStatus').textContent).toBe('2 requests in the last 90 days.');
});

test.each([[403, 'Staff admin access is required. Sign in again.'], [404, 'Contact requests are unavailable.'], [429, 'Too many requests. Try again in a minute.']])('status %i shows a plain message', async (status, message) => {
    const h = harness(jest.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(json(status, { code: 'x' })));
    await h.load();
    expect(h.nodes.get('contactRequestsStatus').textContent).toBe(message);
    expect(h.nodes.get('contactRequestsResults').textContent).toBe('');
});

test('pagehide clears rendered rows', async () => {
    const h = harness(jest.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(json(200, { truncated: true, windowDays: 90, rows: [] })));
    await h.load();
    expect(h.nodes.get('contactRequestsStatus').textContent).toMatch(/^No contact requests in the last 90 days among the accounts checked/);
    h.window.dispatch('pagehide');
    expect(h.nodes.get('contactRequestsStatus').textContent).toBe('');
});
