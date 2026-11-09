'use strict';

// Fictional "Try No Fries" demo (#29): default-off isolation, navigation and reset.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const app = require('../server');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const demo = require('../demo/try/try-demo');
const { buildTryDemoDocument, SOURCES } = require('../demo/try/document');
const { PUBLIC_ROOT_FILES, PUBLIC_SCRIPT_FILES } = require('../lib/publicAssets');
const { createDom } = require('./fixtures/dashboardDom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function recordingStorage(initial = {}) {
    const values = new Map(Object.entries(initial)); const touched = new Set();
    return { values, touched, getItem(key) { touched.add(key); return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { touched.add(key); values.set(key, String(value)); }, removeItem(key) { touched.add(key); values.delete(key); } };
}
const press = (dom, text) => dom.root.querySelectorAll('button').find(item => item.textContent.startsWith(text)).click();
const submit = dom => { for (const fn of dom.root.querySelector('form').events.submit) fn({ preventDefault() {} }); };
const actions = dom => dom.root.querySelectorAll('li').filter(item => item.dataset.action).map(item => item.dataset.action + ':' + item.children[0].textContent);

test('the App Service never serves or packages the demo; only the static build publishes it', async () => {
    for (const route of ['/try', '/try/', '/demo/try/try-demo.js', '/demo/try/document.js']) assert.equal((await request(app).get(route)).status, 404, route);
    assert.ok([...PUBLIC_ROOT_FILES, ...PUBLIC_SCRIPT_FILES].every(file => !/try|demo/i.test(file)));
    assert.match(read('scripts/build-static.js'), /require\('\.\.\/demo\/try\/document'\)/);
    for (const file of ['scripts/build-app-service.js', 'lib/productionApplication.js', 'app-service.js']) {
        assert.doesNotMatch(read(file), /demo\/|tryDemo/, file);
    }
    for (const value of [false, 'true', 1, {}]) assert.throws(() => app.createNoFriesApp({ tryDemo: value }), undefined, String(value));
});

test('enabled local route is self-contained, cookieless and blocks network, forms, frames and images', async () => {
    const response = await request(app.createNoFriesApp({ tryDemo: true })).get('/try');
    assert.equal(response.status, 200);
    const csp = response.headers['content-security-policy'];
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "img-src 'none'", "base-uri 'none'", "style-src-attr 'none'"]) assert.ok(csp.includes(directive), directive);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/]+=*'; /);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['x-robots-tag'], /noindex/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.text, buildTryDemoDocument().html);
    assert.doesNotMatch(response.text, /<script\s+src|<link\b|<iframe|https?:\/\/|shared-assistant|prospect/i);
    assert.deepEqual(response.text.match(/href="[^"]*"/g), ['href="/contact.html"', 'href="/"']);
    assert.match(response.text, /Interactive demo · fictional business/);
});

test('demo data is synthetic and independent of fixtures, the development preview and runtime APIs', () => {
    const source = read('demo/try/try-demo.js');
    assert.doesNotMatch(source, /require\(|test\/fixtures|dashboard-preview|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|cookie|@[a-z0-9-]+\./i);
    assert.deepEqual(SOURCES, ['api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js', 'demo/try/try-demo.js']);
    const html = buildTryDemoDocument().html;
    for (const fixtureName of ['Harbour Workshop', 'Kauri Studio', 'Harbour City Services', 'synthetic-tenant', 'No Fries Demo Customer']) assert.ok(!html.includes(fixtureName), fixtureName);
    const model = demo.projection();
    assert.match(model.context.displayName, /\(fictional\)$/);
    assert.ok(model.admissionGranted === false && model.providerAccessGranted === false && model.services.every(item => item.operational === false));
    const dom = createDom(); shell.mount(dom.root, model, { initialRoute: '' });
    assert.match(dom.root.textContent, /Brightwater Joinery \(fictional\)[\s\S]*Review who has administrator access/);
});

test('navigation reaches the sample assessment through the real shell, validates and shows prioritised next actions', async () => {
    const dom = createDom(); const storage = recordingStorage();
    const controller = shell.mount(dom.root, demo.projection(), { initialRoute: '', mountCyber: demo.mountAssessment(demo.createStore(storage)) });
    await controller.navigate('cyber-security');
    assert.match(dom.root.textContent, /Sample cyber security check/);
    press(dom, 'Start the sample questions');
    assert.equal(dom.root.querySelectorAll('fieldset').length, 6);
    assert.equal(dom.document.activeElement.textContent, 'Sample questions');
    submit(dom);
    assert.match(dom.root.querySelector('[role="alert"]').textContent, /Answer all six questions/);
    assert.equal(dom.document.activeElement.name, 'try-demo-mfa');
    const choose = (id, value) => { const input = dom.root.querySelector('[data-question="' + id + '"]').querySelectorAll('input').find(item => item.value === value); for (const fn of input.events.change) fn({}); };
    [['mfa', 'yes'], ['admins', 'partly'], ['updates', 'no'], ['protection', 'yes'], ['backup', 'yes'], ['restore', 'unsure']].forEach(([id, value]) => choose(id, value));
    submit(dom);
    assert.equal(dom.document.activeElement.textContent, 'Sample results');
    assert.deepEqual(actions(dom), ['updates:High priority', 'restore:High priority', 'admins:Medium priority']);
    assert.equal(dom.root.querySelectorAll('a').find(link => link.textContent.startsWith('Talk to No Fries')).href, '/contact.html');
    assert.match(dom.root.textContent, /People and access 75%[\s\S]*Devices and protection 50%[\s\S]*Backup and recovery 50%/);
    await controller.navigate('overview');
    assert.match(dom.root.textContent, /Needs attention/);
    assert.deepEqual([...storage.touched], [demo.STORAGE_KEY]);
});

test('reset clears only the demo key and returns to the Overview; blocked storage falls back to memory', async () => {
    const dom = createDom(); const storage = recordingStorage({ 'nofries.unrelated': 'kept' });
    const nodes = { 'try-demo-dashboard': dom.root, 'try-demo-status': dom.document.createElement('p'), 'try-demo-reset': dom.document.createElement('button') };
    dom.document.getElementById = id => nodes[id];
    Object.assign(dom.window, { document: dom.document, NoFriesDashboard: shell, localStorage: storage });
    dom.window.location.pathname = '/try';
    demo.start(dom.window);
    dom.root.querySelectorAll('a').find(link => link.textContent.includes('Cyber Security')).click();
    await new Promise(resolve => setImmediate(resolve));
    press(dom, 'Start the sample questions'); press(dom, 'Use example answers'); submit(dom);
    assert.deepEqual(actions(dom), ['admins:High priority', 'restore:High priority', 'mfa:Medium priority', 'protection:Medium priority']);
    assert.ok(storage.values.has(demo.STORAGE_KEY));
    nodes['try-demo-reset'].click();
    assert.equal(storage.values.has(demo.STORAGE_KEY), false);
    assert.equal(storage.values.get('nofries.unrelated'), 'kept');
    assert.match(nodes['try-demo-status'].textContent, /^Demo reset\./);
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.deepEqual([...storage.touched].sort(), [demo.STORAGE_KEY]);

    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const store = demo.createStore(blocked);
    store.save({ answers: { mfa: 'yes', unknown: 'yes', admins: 'maybe' }, view: 'results' });
    assert.deepEqual(store.read(), { answers: { mfa: 'yes' }, view: 'results' });
    store.clear(); assert.deepEqual(store.read(), { answers: {}, view: 'intro' });
    assert.deepEqual(demo.createStore(recordingStorage({ [demo.STORAGE_KEY]: '{not json' })).read(), { answers: {}, view: 'intro' });
    const perfect = demo.results(Object.fromEntries(demo.QUESTIONS.map(question => [question.id, 'yes'])));
    assert.deepEqual([perfect.complete, perfect.actions.length, perfect.areas.map(area => area.percent)], [true, 0, [100, 100, 100]]);
});
