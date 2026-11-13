'use strict';

// Fictional "Try No Fries" demo (#29): default-off isolation, real-engine parity, persistence and reset.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const vm = require('node:vm');
const request = require('supertest');
const app = require('../server');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
const { ncscFixture, createCommand, saveCommand, submitCommand, NOW } = require('./fixtures/ncscAssessmentFixture');
const golden = require('./fixtures/ncscAcceptedEvaluation.json');
const demo = require('../demo/try/try-demo');
const { buildTryDemoDocument, SOURCES, engineModules, engineBundle } = require('../demo/try/document');
const { PUBLIC_ROOT_FILES, PUBLIC_SCRIPT_FILES } = require('../lib/publicAssets');
const { createDom } = require('./fixtures/dashboardDom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function recordingStorage(initial = {}) {
    const values = new Map(Object.entries(initial)); const touched = new Set();
    return { values, touched, getItem(key) { touched.add(key); return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { touched.add(key); values.set(key, String(value)); }, removeItem(key) { touched.add(key); values.delete(key); } };
}
function steppingClock(start = '2026-11-13T01:00:00.000Z') { let at = Date.parse(start); return () => new Date(at += 1000).toISOString(); }
const mixedResponses = () => golden.input.atomInputs.map(atom => ({ itemId: atom.itemId, optionId: atom.response.optionId,
    rationale: atom.response.optionId === 'not_applicable' ? { text: 'Fictional claim awaiting review.' } : null }));
async function submitThroughClient(client, assessmentId, responses) {
    await client.create(createCommand(assessmentId, 'create-' + assessmentId, 'Fictional workshop and office laptops.'));
    await client.save(saveCommand(assessmentId, 0, 'save-' + assessmentId, responses));
    return client.submit(submitCommand(assessmentId, 1, 'submit-' + assessmentId));
}

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
    // One inline script and style; the markup outside them loads nothing and links only to site pages.
    assert.equal(response.text.match(/<script\b/g).length, 1);
    const markup = response.text.replace(/<script>[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '');
    assert.doesNotMatch(markup, /<script\s+src|<link\b|<iframe|<img\b|https?:\/\/|shared-assistant|prospect/i);
    assert.deepEqual(markup.match(/href="[^"]*"/g), ['href="/login?intent=create"', 'href="/contact.html"', 'href="/"']);
    assert.match(markup, /Interactive demo · fictional business/);
    assert.match(markup, />Create your account</);
});

test('the page runs the real dashboard assets and scoring modules, with no fixture data', () => {
    assert.deepEqual(SOURCES.slice(0, 6), ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js',
        'assessmentExplanation.js', 'organisationPicture.js'].map(file => 'api/shared/protectedAssets/' + file));
    const gateway = read('scripts/build-static.js').match(/protectedAppSource: \[([^\]]+)\]/)[1];
    for (const file of SOURCES.slice(0, 6)) assert.ok(gateway.includes("'" + path.basename(file) + "'"), file + ' is in the signed-in dashboard bundle');
    const modules = [...engineModules().keys()];
    assert.ok(modules.includes('api/shared/assessmentEngine/assessmentEvaluator.js') && modules.includes('api/shared/ncscQuestionnaireMetadata.js'));
    assert.ok(modules.every(file => /^api\/shared\/(assessmentEngine|securityGap)\/|^api\/shared\/ncscQuestionnaireMetadata\.js$/.test(file)), modules.join());
    const html = buildTryDemoDocument().html;
    for (const file of [...SOURCES, ...modules]) assert.ok(html.includes(read(file)), file + ' is embedded unchanged');
    const source = read('demo/try/try-demo.js');
    assert.doesNotMatch(source, /test\/fixtures|dashboard-preview|XMLHttpRequest|sendBeacon|WebSocket|EventSource|cookie|@[a-z0-9-]+\./i);
    assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['node:crypto',
        '../../api/shared/assessmentEngine/ncscAssessmentEvaluator', '../../api/shared/assessmentEngine/assessmentEvaluator', '../../api/shared/ncscQuestionnaireMetadata']);
    for (const fixtureName of ['Harbour Workshop', 'Kauri Studio', 'Harbour City Services', 'synthetic-tenant', 'No Fries Demo Customer']) assert.ok(!html.includes(fixtureName), fixtureName);
    const model = demo.projection('2026-11-13T01:00:00.000Z');
    assert.match(model.context.displayName, /\(fictional\)$/);
    assert.ok(model.admissionGranted === false && model.providerAccessGranted === false && model.services.every(item => item.operational === false));
    assert.deepEqual(model.summary, { state: 'empty', attention: [], metrics: [] });
    assert.ok(shell.validate(model));
});

test('the browser shims match node:crypto, Buffer and util for the inputs the engine uses', () => {
    const context = vm.createContext({ TextEncoder });
    vm.runInContext(read('demo/try/node-shims.js'), context);
    const shims = context.NoFriesTryNodeShims;
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'é😀\u0000'.repeat(500)]) {
        assert.equal(shims.crypto.createHash('sha256').update('domain', 'utf8').update(text, 'utf8').digest('hex'),
            crypto.createHash('sha256').update('domain', 'utf8').update(text, 'utf8').digest('hex'));
        assert.equal(shims.Buffer.byteLength(text, 'utf8'), Buffer.byteLength(text, 'utf8'));
    }
    assert.throws(() => shims.crypto.createHash('md5'));
    assert.equal(shims.util.types.isProxy(new Proxy({}, {})), false, 'browsers cannot detect proxies; the engine only sees plain data here');
    assert.equal(typeof util.types.isProxy, 'function');
});

test('results match the real server path for the same answers, in Node and in the bundled browser engine', async () => {
    // Real server path: the durable store's version builder and the API projection.
    const fixture = ncscFixture(), context = { scope: fixture.scope, identity: { subjectKey: fixture.subjectKey } };
    let version = null;
    for (const command of [createCommand('assessment-a'), saveCommand('assessment-a', 0, 'save-a', mixedResponses()), submitCommand('assessment-a')]) {
        version = makeVersion(stableIntent(context, command), command.idempotencyKey, version, fixture.state.tenantAggregate, NOW);
    }
    const metadata = createNcscQuestionnaireMetadata();
    const serverResult = questionnaire.resultModel(projectNcscDetail(version), metadata, fixture.scope.organisationId);
    assert.ok(serverResult && /^\d/.test(serverResult.attainment));

    const nodeBackend = demo.createBackend(demo.createStore(recordingStorage()), steppingClock());
    const nodeSubmitted = await submitThroughClient(createClient({ metadata: nodeBackend.metadata, fetch: nodeBackend.fetch }), 'visitor-a', mixedResponses());
    assert.deepEqual(questionnaire.resultModel(nodeSubmitted.assessment, metadata, demo.ORGANISATION_ID), serverResult);

    // The page's bundle, run without Node's require, Buffer, crypto or util.
    const page = vm.createContext({ TextEncoder, URL });
    vm.runInContext([read('demo/try/node-shims.js'), read('demo/try/try-demo.js'), engineBundle()].join('\n'), page);
    assert.equal(page.Buffer, undefined);
    const pageBackend = page.NoFriesTryDemo.createBackend(page.NoFriesTryDemo.createStore(recordingStorage()), steppingClock());
    assert.deepEqual(JSON.parse(JSON.stringify(pageBackend.metadata)), JSON.parse(JSON.stringify(metadata)));
    const pageClient = createClient({ metadata: JSON.parse(JSON.stringify(pageBackend.metadata)),
        fetch: async (url, options) => { const response = await pageBackend.fetch(url, options); const text = await response.text();
            return { ...response, headers: { get: response.headers.get }, text: async () => text }; } });
    const pageSubmitted = await submitThroughClient(pageClient, 'visitor-a', mixedResponses());
    assert.deepEqual(pageSubmitted, nodeSubmitted, 'identical bytes, hashes and evaluation');
});

test('the fictional earlier assessment is scored by the real rules and seeds Overview comparison', async () => {
    const backend = demo.createBackend(demo.createStore(recordingStorage()), steppingClock());
    const client = createClient({ metadata: backend.metadata, fetch: backend.fetch });
    const listed = await client.list({ limit: 50 });
    assert.deepEqual(listed.assessments.map(item => [item.assessmentId, item.status, item.progress.answered]), [[demo.EARLIER_ID, 'submitted', 14]]);
    const earlier = questionnaire.resultModel((await client.read(demo.EARLIER_ID)).assessment, backend.metadata, demo.ORGANISATION_ID);
    assert.equal(earlier.attainment, '28.6%–42.9%', 'lower bound first');
    assert.equal(backend.metadata.questions.length, 14);
});

test('saved steps replay after reload; unreadable or stale logs start afresh; reset clears only the demo key', async () => {
    const storage = recordingStorage({ 'nofries.unrelated': 'kept' });
    const first = demo.createBackend(demo.createStore(storage), steppingClock());
    const client = createClient({ metadata: first.metadata, fetch: first.fetch });
    await client.create(createCommand('visitor-b', 'create-b', 'Fictional scope.'));
    await client.save(saveCommand('visitor-b', 0, 'save-b', mixedResponses().slice(0, 3)));
    assert.equal(JSON.parse(storage.values.get(demo.STORAGE_KEY)).log.length, 2);
    const again = createClient({ metadata: first.metadata, fetch: demo.createBackend(demo.createStore(storage), steppingClock()).fetch });
    const restored = (await again.read('visitor-b')).assessment;
    assert.deepEqual([restored.status, restored.revision, restored.progress.answered], ['in-progress', 1, 3]);
    assert.deepEqual([...storage.touched].sort(), [demo.STORAGE_KEY]);

    for (const value of ['{not json', JSON.stringify({ log: [{ command: { assessmentId: 'x', action: 'submit' }, at: NOW }] }), JSON.stringify({ answers: {}, view: 'results' })]) {
        const stale = recordingStorage({ [demo.STORAGE_KEY]: value });
        const fresh = createClient({ metadata: first.metadata, fetch: demo.createBackend(demo.createStore(stale), steppingClock()).fetch });
        assert.deepEqual((await fresh.list({})).assessments.map(item => item.assessmentId), [demo.EARLIER_ID]);
    }
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const store = demo.createStore(blocked);
    store.append({ command: { a: 1 }, at: NOW });
    assert.deepEqual(store.read(), [{ command: { a: 1 }, at: NOW }]);
    store.clear(); assert.deepEqual(store.read(), []);
    await assert.rejects(demo.pageFetch('https://example.invalid/'), TypeError);
    assert.deepEqual(await (await demo.pageFetch('/api/enquiry')).json(), { available: true });
});

test('start mounts the real shell with the real Overview and Cyber Security workspaces; reset returns to Overview', async () => {
    const dom = createDom(); const storage = recordingStorage({ 'nofries.unrelated': 'kept' });
    const nodes = { 'try-demo-dashboard': dom.root, 'try-demo-status': dom.document.createElement('p'), 'try-demo-reset': dom.document.createElement('button') };
    dom.document.getElementById = id => nodes[id];
    Object.assign(dom.window, { document: dom.document, localStorage: storage, NoFriesDashboard: shell, NoFriesNcscAssessmentClient: { createClient },
        NoFriesNcscQuestionnaire: questionnaire, NoFriesOrganisationPicture: require('../api/shared/protectedAssets/organisationPicture') });
    dom.window.location.pathname = '/try';
    demo.start(dom.window);
    assert.equal(dom.window.fetch, demo.pageFetch);
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    for (let index = 0; index < 20 && !/28\.6%–42\.9%/.test(dom.root.textContent); index++) await new Promise(resolve => setImmediate(resolve));
    assert.match(dom.root.textContent, /Cyber baseline[\s\S]*28\.6%–42\.9%/);
    dom.root.querySelectorAll('a').find(link => link.textContent.includes('Cyber Security')).click();
    for (let index = 0; index < 20 && !/Start an assessment/.test(dom.root.textContent); index++) await new Promise(resolve => setImmediate(resolve));
    assert.match(dom.root.textContent, /Cyber security assessment[\s\S]*Start an assessment/);
    storage.setItem(demo.STORAGE_KEY, JSON.stringify({ log: [] })); storage.touched.clear();
    nodes['try-demo-reset'].click();
    assert.equal(storage.values.has(demo.STORAGE_KEY), false);
    assert.equal(storage.values.get('nofries.unrelated'), 'kept');
    assert.match(nodes['try-demo-status'].textContent, /^Demo reset\./);
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.deepEqual([...storage.touched].sort(), [demo.LEGACY_STORAGE_KEY, demo.STORAGE_KEY].sort());
});

test('a malformed request body is a 400 ncsc_input_invalid problem and records nothing', async () => {
    const storage = recordingStorage();
    const backend = demo.createBackend(demo.createStore(storage), steppingClock());
    for (const [url, body] of [['/api/dashboard/ncsc/assessments', '{not json'], ['/api/dashboard/ncsc/assessments', undefined],
        ['/api/dashboard/ncsc/assessments', 'null'], ['/api/dashboard/ncsc/assessments/visitor-c/save', '[]']]) {
        const response = await backend.fetch(url, { method: 'POST', body });
        assert.equal(response.status, 400, String(body));
        assert.deepEqual(JSON.parse(await response.text()), { code: 'ncsc_input_invalid' });
    }
    assert.equal(storage.values.has(demo.STORAGE_KEY), false);
});

test('start removes the legacy v1 key once, and reset removes it again with the current key', () => {
    const dom = createDom();
    const storage = recordingStorage({ [demo.LEGACY_STORAGE_KEY]: '{"answers":{}}', 'nofries.unrelated': 'kept' });
    const nodes = { 'try-demo-dashboard': dom.root, 'try-demo-status': dom.document.createElement('p'), 'try-demo-reset': dom.document.createElement('button') };
    dom.document.getElementById = id => nodes[id];
    Object.assign(dom.window, { document: dom.document, localStorage: storage, NoFriesDashboard: shell, NoFriesNcscAssessmentClient: { createClient },
        NoFriesNcscQuestionnaire: questionnaire });
    dom.window.location.pathname = '/try';
    demo.start(dom.window);
    assert.equal(demo.LEGACY_STORAGE_KEY, 'nofries.tryDemo.v1');
    assert.equal(storage.values.has(demo.LEGACY_STORAGE_KEY), false);
    storage.setItem(demo.LEGACY_STORAGE_KEY, '{"answers":{}}'); storage.setItem(demo.STORAGE_KEY, JSON.stringify({ log: [] }));
    nodes['try-demo-reset'].click();
    assert.equal(storage.values.has(demo.LEGACY_STORAGE_KEY), false);
    assert.equal(storage.values.has(demo.STORAGE_KEY), false);
    assert.equal(storage.values.get('nofries.unrelated'), 'kept');
});
