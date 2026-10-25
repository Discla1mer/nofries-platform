'use strict';

// Optional synthetic Chromium check with existing Playwright/browser installations.
// No login, provider I/O, writes, screenshots, traces or diagnostic artifacts.
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
const session = { schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard',
    generation: 'a'.repeat(64), selectedBindingId: binding, expiresAt: new Date(Date.now() + 3600000).toISOString() };
const staticAssets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')],
    '/images/nofrieslogo.png': ['image/png', fs.readFileSync(path.join(root, 'images/nofrieslogo.png'))] };
const PER_READ_MS = 60;
const requests = [], errors = [], unexpected = [], results = [];
let deniedConsoleErrors = 0;
const occurrences = new Map(), gates = new Map();
let model, moduleView;
function deferred() {
    let resolve;
    return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) };
}
function armSession(offset = 1) {
    const key = '/api/dashboard/session#' + ((occurrences.get('/api/dashboard/session') || 0) + offset);
    const arrived = deferred(), release = deferred();
    const gate = { arrived, release }; gates.set(key, gate); return gate;
}
async function waiting(gate) {
    let timer;
    try {
        await Promise.race([gate.arrived.promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic witness was not requested')), 10000); })]);
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
            bindings: [{ bindingId: binding, organisationLabel: 'Synthetic focus organisation' }], nextAfterBindingId: null };
        else if (pathname === '/api/dashboard/bootstrap') body = model;
        else if (pathname === '/api/dashboard/modules/cyber_security') body = moduleView;
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
async function locked(page) {
    assert.deepEqual(await page.locator('#dashboardApp').evaluate(node => ({ hidden: node.hidden, inert: node.inert })),
        { hidden: true, inert: true });
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

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) for (const cyber of [false, true]) {
            occurrences.clear(); gates.clear();
            model = JSON.parse(JSON.stringify(seed.model));
            if (!cyber) model.modules.find(item => item.key === 'cyber_security').state = 'planned';
            moduleView = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
                module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
                services: [], admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => {
                if (message.type() !== 'error') return;
                if (message.location().url === origin + '/api/dashboard/session' &&
                    message.text() === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') deniedConsoleErrors++;
                else errors.push(message.text());
            });
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
            const initial = requests.length, first = armSession();
            await page.goto(origin + '/dashboard#services', { waitUntil: 'domcontentloaded' }); await waiting(first);
            await focusStorm(page); // Initial authority read, no mounted controller.
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
            assert.equal(apiReads(initial).length, 1);
            assert.equal(apiReads(initial)[0].aborted, false);
            first.release.resolve(); await ready(page);
            assert.deepEqual(apiReads(initial).map(row => row.path), expectedPaths(cyber));

            const mounted = requests.length, sessionStart = armSession(), final = armSession(2);
            await page.evaluate(() => { window.retainedMain = document.querySelector('#dashboardApp main'); });
            await focusStorm(page); await waiting(sessionStart); await locked(page);
            assert.equal(apiReads(mounted).length, 1); sessionStart.release.resolve();
            await waiting(final); await locked(page); await focusStorm(page);
            assert.deepEqual(apiReads(mounted).map(row => row.path), expectedPaths(cyber));
            final.release.resolve(); await ready(page);
            assert.equal(await page.evaluate(() => document.querySelector('#dashboardApp main') === window.retainedMain), true);

            // An ordinary completed return must still perform all current checks.
            // This measures only the synthetic server's 60ms-per-GET baseline.
            const measured = requests.length;
            const started = await page.evaluate(() => { const at = performance.now(); window.dispatchEvent(new Event('focus')); return at; });
            await ready(page);
            const syntheticMountedWaitMs = Math.round(await page.evaluate(at => performance.now() - at, started));
            assert.deepEqual(apiReads(measured).map(row => row.path), expectedPaths(cyber));
            const middle = apiReads(measured).slice(1, -1);
            assert.ok(Math.max(...middle.map(row => row.startedAt)) < Math.min(...middle.map(row => row.finishedAt)),
                'Independent middle GETs must overlap while preserving the final witness');
            assert.equal(await page.evaluate(() => document.querySelector('#dashboardApp main') === window.retainedMain), true);

            const cached = requests.length, returning = armSession();
            await focusStorm(page, true); await waiting(returning);
            assert.equal(apiReads(cached).length, 1); assert.equal(apiReads(cached)[0].aborted, false);
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            returning.release.resolve(); await ready(page);
            assert.deepEqual(apiReads(cached).map(row => row.path), expectedPaths(cyber));
            assert.equal(await page.evaluate(() => document.querySelector('#dashboardApp main') === window.retainedMain), false);

            const denied = requests.length, denial = armSession(2);
            await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waiting(denial); await locked(page);
            denial.release.resolve(403);
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            assert.deepEqual(apiReads(denied).map(row => row.path), expectedPaths(cyber));
            assert.ok(requests.slice(initial).every(row => row.method === 'GET' && !row.aborted));
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            results.push({ width, cyber, initialStormSharesOneChain: true, mountedStormKeepsFinalWitnessFence: true,
                distinctCompletedFocusChecksFresh: true, cachedReturnStormSharesNewChain: true,
                finalSessionDenialClears: true, abortedRequests: 0, perReadDelayMs: PER_READ_MS,
                mountedReadCount: expectedPaths(cyber).length, middleReadsOverlap: true, syntheticMountedWaitMs });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.equal(deniedConsoleErrors, 6);
        for (const source of sources) assert.equal(hash(read(source.file)), hash(source.content), 'Source changed during verification');
        console.log(JSON.stringify({ results, pageErrors: 0, unexpectedRequests: 0, syntheticOnly: true,
            sourceHashes: sources.map(source => ({ path: source.file, sha256: hash(source.content) })) }));
    } finally {
        for (const gate of gates.values()) gate.release.resolve();
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
