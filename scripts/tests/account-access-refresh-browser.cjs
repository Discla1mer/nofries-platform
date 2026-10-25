'use strict';

// Synthetic selected-mount concurrency check with existing Playwright/Chromium.
// Only loopback GETs: no login, provider I/O, writes, screenshots or traces.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['js/dashboard-loader.js', 'app/dashboard.html', 'app/dashboard.css',
    ...['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js',
        'organisationPicture.js'].map(file => 'api/shared/protectedAssets/' + file)];
const sources = sourceFiles.map(file => ({ file, content: read(file) }));
const app = sources.slice(3).map(source => source.content).join('\n'), css = sources[2].content;
const document = buildDashboardDocument({ loaderSource: sources[0].content, template: sources[1].content,
    protectedAppSource: app, protectedStyleSource: css });
const fixtures = buildFixtures(), seed = fixtures.tenants[0];
const binding = '10000000-0000-4000-8000-000000000001';
const secondBinding = '10000000-0000-4000-8000-000000000002';
let directoryBindings = [{ bindingId: binding, organisationLabel: 'Synthetic focus organisation' }];
let savedClients = [];
const session = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'consultant',
    generation: 'a'.repeat(64), selectedBindingId: binding, expiresAt: new Date(Date.now() + 3600000).toISOString() };
const staticAssets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')],
    '/images/nofrieslogo.png': ['image/png', fs.readFileSync(path.join(root, 'images/nofrieslogo.png'))] };
const PER_READ_MS = 60;
const requests = [], errors = [], unexpected = [], results = [];
const occurrences = new Map(), gates = new Map();
let model, moduleView;
function deferred() {
    let resolve;
    return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) };
}
function armSession(offset = 1) {
    const key = '/api/dashboard/session#' + ((occurrences.get('/api/dashboard/session') || 0) + offset);
    const arrived = deferred(), release = deferred();
    const gate = { arrived, release, key }; gates.set(key, gate); return gate;
}
async function waiting(gate) {
    let timer;
    try {
        await Promise.race([gate.arrived.promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic witness was not requested: ' + gate.key)), 10000); })]);
    } finally { clearTimeout(timer); }
}
const server = http.createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        const record = { path: pathname, method: request.method, aborted: false, startedAt: performance.now(), finishedAt: null }; requests.push(record);
        response.on('finish', () => { record.finishedAt = performance.now(); });
        response.on('close', () => { if (!response.writableFinished) record.aborted = true; });
        if (request.method !== 'GET') { unexpected.push('Non-GET request'); response.writeHead(405); return response.end(); }
        const count = (occurrences.get(pathname) || 0) + 1; occurrences.set(pathname, count);
        let type = 'application/json', body, status = 200;
        if (pathname === '/dashboard') { body = document.html; type = 'text/html'; }
        else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
        else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
        else if (pathname === '/api/dashboard/session') body = session;
        else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1,
            bindings: directoryBindings, nextAfterBindingId: null };
        else if (pathname === '/api/dashboard/bootstrap') body = model;
        else if (pathname === '/api/dashboard/modules/cyber_security') body = moduleView;
        else if (pathname === '/api/customer-signup/clients') body = { csrfToken: 'c'.repeat(43),
            state: { status: 'clients', remaining: 3 - savedClients.length, clients: savedClients } };
        else if (staticAssets[pathname]) [type, body] = staticAssets[pathname];
        else { unexpected.push('Unknown loopback request'); response.writeHead(404); return response.end(); }
        const gate = gates.get(pathname + '#' + count);
        if (gate) { gate.arrived.resolve(); status = await gate.release.promise || 200; }
        if (pathname.startsWith('/api/') && !['/api/dashboard/app.js', '/api/dashboard/dashboard.css'].includes(pathname)) {
            await new Promise(resolve => setTimeout(resolve, PER_READ_MS));
        }
        if (status !== 200) body = { code: 'dashboard_access_denied' };
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
            'Content-Security-Policy': document.contentSecurityPolicy });
        response.end(type === 'application/json' ? JSON.stringify(body) : body);
    } catch (error) {
        errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end();
    }
});
const apiReads = from => requests.slice(from).filter(row => row.path.startsWith('/api/') &&
    !['/api/dashboard/app.js', '/api/dashboard/dashboard.css'].includes(row.path));
const expectedPaths = cyber => ['/api/dashboard/session', '/api/dashboard/organisations', '/api/dashboard/bootstrap',
    ...(cyber ? ['/api/dashboard/modules/cyber_security'] : []), '/api/dashboard/session'];
async function ready(page) {
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    assert.deepEqual(await page.locator('#dashboardApp').evaluate(node => ({ hidden: node.hidden, inert: node.inert })),
        { hidden: false, inert: false });
}
async function visible(page) {
    assert.deepEqual(await page.locator('#dashboardApp').evaluate(node => ({ hidden: node.hidden, inert: node.inert })),
        { hidden: false, inert: false });
}
async function focusStorm(page, cachedReturn = false) {
    await page.evaluate(cached => {
        if (cached) {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        }
        for (let index = 0; index < 60; index++) window.dispatchEvent(new Event('focus'));
    }, cachedReturn);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function arm(path) {
    const key = path + '#' + ((occurrences.get(path) || 0) + 1);
    const gate = { arrived: deferred(), release: deferred(), key }; gates.set(key, gate); return gate;
}
async function responseFinished(record) {
    const deadline = Date.now() + 10000;
    while (!record.finishedAt) {
        assert.ok(Date.now() < deadline, 'Synthetic response did not finish');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, args: ['--no-sandbox'] });
        const cases = [1440, 390, 320].flatMap(width => [false, true].map(cyber => ({ width, cyber, accountType: 'consultant' })))
            .concat([{ width: 1440, cyber: false, accountType: 'company' }]);
        for (const { width, cyber, accountType } of cases) {
            occurrences.clear(); gates.clear(); session.accountType = accountType;
            directoryBindings = [{ bindingId: binding, organisationLabel: 'Synthetic focus organisation' }];
            savedClients = [];
            if (accountType === 'consultant') session.clientSetupAvailable = true;
            else delete session.clientSetupAvailable;
            model = JSON.parse(JSON.stringify(seed.model));
            if (!cyber) model.modules.find(item => item.key === 'cyber_security').state = 'planned';
            moduleView = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
                module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
                services: [], admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
            const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') {
                    unexpected.push('Unexpected browser request'); return route.abort();
                }
                return route.continue();
            });
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            const initial = requests.length, first = armSession(), final = armSession(2);
            const directoryGate = arm('/api/dashboard/organisations'), bootstrapGate = arm('/api/dashboard/bootstrap');
            await page.goto(origin + '/dashboard#services', { waitUntil: 'domcontentloaded' }); await waiting(first);
            assert.equal(apiReads(initial).length, 1, 'No directory/bootstrap before the session witness');
            await focusStorm(page); assert.equal(apiReads(initial).length, 1);
            first.release.resolve();
            await Promise.all([waiting(directoryGate), waiting(bootstrapGate)]);
            assert.deepEqual(apiReads(initial).map(row => row.path), expectedPaths(false).slice(0, 3));
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.hidden && node.children.length === 0), true);
            // Neither middle response has arrived, yet both requests exist.
            const middle = apiReads(initial).slice(1), finishDirectoryFirst = width !== 390;
            (finishDirectoryFirst ? directoryGate : bootstrapGate).release.resolve();
            await responseFinished(middle[finishDirectoryFirst ? 0 : 1]);
            await focusStorm(page);
            assert.equal(requests.slice(initial).filter(row => ['/api/dashboard/app.js', '/api/dashboard/dashboard.css'].includes(row.path)).length, 0);
            assert.equal(apiReads(initial).length, 3);
            (finishDirectoryFirst ? bootstrapGate : directoryGate).release.resolve(); await waiting(final);
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.hidden && node.children.length === 0), true);
            await focusStorm(page); assert.deepEqual(apiReads(initial).map(row => row.path), expectedPaths(cyber));
            final.release.resolve(); await ready(page);
            assert.ok(Math.max(...middle.map(row => row.startedAt)) < Math.min(...middle.map(row => row.finishedAt)),
                'Directory/bootstrap intervals overlap');
            await page.evaluate(() => { window.retainedMain = document.querySelector('#dashboardApp main'); });
            const focused = requests.length, focusFinal = armSession(2);
            await focusStorm(page); await waiting(focusFinal); await visible(page);
            assert.deepEqual(apiReads(focused).map(row => row.path), expectedPaths(cyber));
            focusFinal.release.resolve(); await ready(page);
            assert.equal(await page.evaluate(() => document.querySelector('#dashboardApp main') === window.retainedMain), true);
            // A distinct completed return performs fresh checks again.
            await page.waitForTimeout(100);
            const distinct = requests.length, distinctFinal = armSession(2);
            await focusStorm(page); await waiting(distinctFinal); await visible(page);
            distinctFinal.release.resolve(); await responseFinished(apiReads(distinct).at(-1)); await ready(page);
            await page.waitForTimeout(100);
            assert.deepEqual(apiReads(distinct).map(row => row.path), expectedPaths(cyber));
            const denied = requests.length, denial = armSession(2);
            await page.evaluate(() => {
                window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
                window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
            });
            await waiting(denial); assert.equal(await page.locator('#dashboardApp').evaluate(node => node.hidden && node.children.length === 0), true);
            denial.release.resolve(403); await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            assert.deepEqual(apiReads(denied).map(row => row.path), expectedPaths(cyber));
            const violations = await page.evaluate(() => window.violations); assert.deepEqual(violations, []);
            results.push({ width, cyber, accountType, selectedMountReads: apiReads(initial).slice(0, cyber ? 5 : 4).length,
                selectedMountRounds: cyber ? 4 : 3, directoryBootstrapOverlap: true, finalWitnessHeld: true,
                ordinaryFocusChecks: apiReads(focused).slice(0, cyber ? 5 : 4).length, distinctFocusFresh: true,
                finalDenialClearedContent: true, cspViolations: violations.length });
            await page.close();
        }
        occurrences.clear(); gates.clear(); session.accountType = 'consultant'; session.clientSetupAvailable = true;
        const account = await browser.newPage(); account.setDefaultTimeout(10000);
        account.on('pageerror', error => errors.push(error.message));
        const clientGate = arm('/api/customer-signup/clients');
        await account.goto(origin + '/dashboard#organisations', { waitUntil: 'domcontentloaded' });
        await waiting(clientGate);
        const accountRefresh = requests.length, pendingClientFinal = armSession(2);
        await focusStorm(account); await focusStorm(account);
        assert.equal(await account.evaluate(() => document.body.dataset.dashboardState), 'selection');
        assert.equal(await account.locator('#clientSetupControls').count(), 1);
        assert.equal(apiReads(accountRefresh).filter(row => row.path === '/api/customer-signup/clients').length, 0);
        clientGate.release.resolve(200); await waiting(pendingClientFinal);
        pendingClientFinal.release.resolve();
        await account.waitForFunction(() => document.querySelector('#clientSetupControls button') !== null);
        await account.locator('#clientSetupControls').getByRole('button', { name: 'Add organisation' }).click();
        await account.locator('#clientSetupControls input[name="organisationName"]').fill('Unsaved synthetic client');
        await account.evaluate(() => { window.savedInput = document.querySelector('#clientSetupControls input[name="organisationName"]');
            window.savedInput.focus(); });
        const accountFinal = armSession(2), accountReads = requests.length;
        await focusStorm(account); await waiting(accountFinal);
        assert.equal(await account.evaluate(() => document.body.dataset.dashboardState), 'selection');
        assert.equal(await account.evaluate(() => document.activeElement === window.savedInput &&
            window.savedInput.value === 'Unsaved synthetic client'), true);
        assert.deepEqual(apiReads(accountReads).map(row => row.path),
            ['/api/dashboard/session', '/api/dashboard/organisations', '/api/dashboard/session']);
        accountFinal.release.resolve();
        await responseFinished(apiReads(accountReads).at(-1));
        await account.waitForFunction(() => document.querySelector('#clientSetupControls input[name="organisationName"]') === window.savedInput);
        results.push({ width: 1280, cyber: false, accountType: 'consultant-account', clientReadPreserved: true,
            unsavedFocusedInputPreserved: true, backgroundChecks: true });
        await account.close();
        occurrences.clear(); gates.clear();
        directoryBindings = [{ bindingId: binding, organisationLabel: 'Synthetic focus organisation' }];
        savedClients = [{ requestId: '10000000-0000-4000-8000-000000000003',
            organisationName: 'Saved synthetic client', status: 'pending' }];
        const changed = await browser.newPage(); changed.setDefaultTimeout(10000);
        changed.on('pageerror', error => errors.push(error.message));
        await changed.goto(origin + '/dashboard#organisations', { waitUntil: 'domcontentloaded' });
        await changed.locator('#dashboardChoices .client-workspace-row button').waitFor();
        await changed.evaluate(() => {
            window.retainedPendingRow = document.querySelector('#dashboardChoices .client-workspace-row');
            window.retainedPendingAction = window.retainedPendingRow.querySelector('button');
            window.retainedReadyChoice = document.querySelector('#dashboardChoices > button');
            window.retainedPendingAction.focus();
        });
        directoryBindings = directoryBindings.concat({ bindingId: secondBinding, organisationLabel: 'New synthetic organisation' });
        const changedReads = requests.length, changedFinal = armSession(2);
        await focusStorm(changed); await waiting(changedFinal);
        assert.equal(await changed.evaluate(() => document.querySelector('#dashboardChoices .client-workspace-row') === window.retainedPendingRow &&
            document.activeElement === window.retainedPendingAction), true);
        changedFinal.release.resolve(); await responseFinished(apiReads(changedReads).at(-1));
        await changed.waitForFunction(() => document.querySelectorAll('#dashboardChoices > button').length === 2);
        assert.equal(await changed.evaluate(() => document.querySelector('#dashboardChoices .client-workspace-row') === window.retainedPendingRow &&
            document.querySelector('#dashboardChoices > button') === window.retainedReadyChoice &&
            document.activeElement === window.retainedPendingAction), true);
        assert.deepEqual(apiReads(changedReads).map(row => row.path),
            ['/api/dashboard/session', '/api/dashboard/organisations', '/api/dashboard/session']);
        results.push({ width: 1280, accountType: 'consultant-account', changedDirectory: true,
            pendingRowAndFocusPreserved: true, readyChoicePreserved: true });
        await changed.close();
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        assert.equal(requests.filter(row => row.method !== 'GET').length, 0);
        assert.deepEqual(requests.filter(row => row.aborted).map(row => row.path), []);
        assert.deepEqual(sources.map(source => hash(read(source.file))), sources.map(source => hash(source.content)));
        process.stdout.write(JSON.stringify({ cases: results, writes: 0, aborted: 0, unexpected: 0, pageErrors: 0,
            sourceSha256: Object.fromEntries(sources.map(source => [source.file, hash(source.content)])) }, null, 2) + '\n');
    } finally {
        for (const gate of gates.values()) gate.release.resolve();
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
