'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/portal-loader.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(statuses, hash = '') {
    const ids = ['loadingPanel', 'loadingHeading', 'loadingMessage', 'loadingStatus', 'loadingActions', 'startupWatchdog', 'portalApp'];
    const elements = Object.fromEntries(ids.map(id => [id, { hidden: true, textContent: '', setAttribute() {} }]));
    const calls = [], redirects = [], scripts = [], started = [];
    const document = { body: { dataset: { page: 'customer-portal' }, classList: { remove() {} } },
        getElementById: id => elements[id], createElement: tag => ({ tagName: tag }),
        head: { append(script) { scripts.push(script); script.onload(); } } };
    const window = { location: { hash, assign: url => redirects.push(url) }, setTimeout: () => 1, clearTimeout() {},
        NoFriesPortal: { start: data => started.push(data) } };
    const bootstrap = { customer: { id: 'synthetic', displayName: 'Synthetic customer' }, user: {}, tickets: [],
        proof: { status: 'unavailable', current: { state: 'unavailable' }, history: [] } };
    vm.runInNewContext(source, { window, document, AbortController, fetch: async url => {
        calls.push(url); const status = statuses[calls.length - 1] || 200;
        return { status, ok: status === 200, json: async () => status !== 200 ? {} : url === '/api/auth/session' ? { authenticated: true } : bootstrap };
    } });
    return { calls, redirects, scripts, started, elements };
}
test('fresh portal session redirects to exact /portal before protected bootstrap or script', async () => {
    const h = harness([401]); await flush();
    assert.deepEqual(h.redirects, ['/api/auth/login?returnTo=%2Fportal']);
    assert.deepEqual(h.calls, ['/api/auth/session']); assert.equal(h.scripts.length, 0);
});
test('session expiring between identity and bootstrap returns to exact portal login', async () => {
    const h = harness([200, 401]); await flush();
    assert.deepEqual(h.redirects, ['/api/auth/login?returnTo=%2Fportal']); assert.equal(h.scripts.length, 0);
});
for (const statuses of [[401], [200, 401]]) test('registered module-shaped deep link survives a fresh or expired login', async () => {
    const h = harness(statuses, '#cyber-security'); await flush();
    assert.deepEqual(h.redirects, ['/api/auth/login?returnTo=%2Fportal%23cyber-security']);
});
for (const fragment of ['#cyber-security/foreign-object', '#https://attacker.invalid', '#%0d%0a', '#' + 'a'.repeat(100)]) test('unsafe or object fragment is dropped before sign-in', async () => {
    const h = harness([401], fragment); await flush(); assert.deepEqual(h.redirects, ['/api/auth/login?returnTo=%2Fportal']);
});
test('post-auth entry starts legacy app only after successful protected bootstrap', async () => {
    const h = harness([200, 200]); await flush();
    assert.deepEqual(h.calls, ['/api/auth/session', '/api/customer-portal/bootstrap']);
    assert.equal(h.scripts[0].src, '/api/customer-portal/app.js'); assert.equal(h.started.length, 1);
    assert.equal(h.redirects.length, 0);
});
test('denied portal bootstrap never loads a dashboard or legacy protected application', async () => {
    const h = harness([200, 403]); await flush();
    assert.equal(h.scripts.length, 0); assert.equal(h.started.length, 0); assert.equal(h.redirects.length, 0);
    assert.match(h.elements.loadingHeading.textContent, /not been approved/);
});
