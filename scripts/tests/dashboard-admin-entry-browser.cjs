'use strict';

// Synthetic localhost transport only: no real identity, gate, grant, account,
// provider or SQL. Genuine callback/native-gate coverage is in the Jest tests.
// Uses existing Playwright/Chromium; installs no dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardAdminEntryDocument } = require('../../lib/dashboardAdminEntryDocument');
const { contentSecurityPolicy } = require('../../lib/dashboardAdminDocument');

const root = path.resolve(__dirname, '../..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-admin-entry-browser-'));
fs.chmodSync(artifacts, 0o700);
const sourceFiles = ['api/shared/protectedAssets/dashboardAdminEntry.js', 'lib/dashboardAdminEntryDocument.js',
    'js/operator-loader.js', 'app/operator.html'];
const files = {
    '/dashboard-admin/entry': ['text/html', buildDashboardAdminEntryDocument()],
    '/operator': ['text/html', fs.readFileSync(path.join(root, 'app/operator.html'), 'utf8')],
    '/api/dashboard-admin/entry.js': ['application/javascript', fs.readFileSync(path.join(root, sourceFiles[0]), 'utf8')],
    '/js/operator-loader.js': ['application/javascript', fs.readFileSync(path.join(root, 'js/operator-loader.js'), 'utf8')],
    '/assets/operator.css': ['text/css', fs.readFileSync(path.join(root, 'app/operator.css'), 'utf8')],
    '/api/lifecycle/app.js': ['application/javascript', '// Synthetic protected asset; no account data.'],
    '/dashboard-admin': ['text/html', '<!doctype html><h1>Synthetic administration destination</h1>']
};
const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.url === '/favicon.svg' || request.url === '/images/nofrieslogo.png') { response.statusCode = 204; return response.end(); }
    const file = files[request.url];
    if (request.method !== 'GET' || !file) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', file[0] + '; charset=utf-8'); response.end(file[1]);
});
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } });
const ready = () => ({ schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard',
    expiresAt: new Date(Date.now() + 60000).toISOString(), generation: 'a'.repeat(64), selectedBindingId: null });
async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic request was not observed'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

(async () => {
    let browser, failure;
    const results = [], outside = [], pageErrors = [];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [320, 390, 768, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            let mode = 'fresh', initialized = false, entryAllowed = true, entryDenied = false, pending = [], trace = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => {
                window.entryCspViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.entryCspViolations.push(event.effectiveDirective));
            });
            await page.route('**/*', async route => {
                const req = route.request(), url = new URL(req.url());
                if (url.origin !== origin) { outside.push(req.method() + ' ' + url.origin); return route.abort(); }
                if (url.pathname === '/api/auth/session') return json(route, 200, { authenticated: true });
                if (url.pathname === '/api/dashboard-admin/entry-capabilities') {
                    trace.push({ path: url.pathname, method: req.method() });
                    if (mode === 'pending-navigation') {
                        pending.push(() => json(route, 200, { entry: true }).catch(() => {})); return;
                    }
                    return json(route, entryDenied ? 403 : 200, entryDenied ? { code: 'dashboard_admin_access_denied' } : { entry: entryAllowed });
                }
                if (url.pathname === '/api/dashboard/session') {
                    trace.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
                    assert.equal(req.headers()['x-nofries-dashboard-purpose'], 'operator_dashboard');
                    if (req.method() === 'POST') {
                        assert.deepEqual(Object.keys(req.postDataJSON()), ['operationId']);
                        assert.match(req.postDataJSON().operationId, /^[0-9a-f-]{36}$/);
                        if (mode === 'pending-post') {
                            pending.push(() => json(route, 200, { schemaVersion: 1, initialized: true }).catch(() => {})); return;
                        }
                        if (mode === 'uncertain') return json(route, 503, { code: 'dashboard_outcome_ambiguous' });
                        initialized = true; return json(route, 200, { schemaVersion: 1, initialized: true });
                    }
                    if (mode === 'pending-session') {
                        pending.push(() => json(route, 200, ready()).catch(() => {})); return;
                    }
                    if (mode === 'unknown') return json(route, 409, { code: 'unknown_synthetic_state' });
                    if (mode === 'error') return json(route, 503, { error: 'PRIVATE_ERROR_CANARY' });
                    return initialized ? json(route, 200, ready()) : json(route, 409, { code: 'dashboard_initialization_required' });
                }
                if (url.pathname === '/api/dashboard-admin/capabilities') {
                    trace.push({ path: url.pathname, method: req.method() });
                    if (mode === 'revoked') return json(route, 401, { code: 'dashboard_admin_authentication_required' });
                    if (mode === 'forbidden') return json(route, 403, { code: 'dashboard_admin_access_denied' });
                    return json(route, 200, { lookup: mode !== 'absent', recovery: [] });
                }
                return route.continue();
            });
            const open = () => page.getByRole('button', { name: /^(Open administration|Check access again)$/ });
            const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no overflow at ' + width);
            const entry = async (nextMode, isReady = false) => {
                mode = nextMode; initialized = isReady; pending = []; trace = [];
                await page.goto(origin + '/dashboard-admin/entry'); await open().waitFor();
                assert.equal(trace.length, 0, 'entry makes no automatic API request');
            };

            await entry('fresh'); await noOverflow();
            await open().focus(); await page.keyboard.press('Tab');
            assert.equal(await page.locator('#adminEntryCancel').isVisible(), false);
            await open().focus();
            assert.equal(await open().evaluate(node => node === document.activeElement), true);
            assert.ok((await open().boundingBox()).height >= 44);
            await page.screenshot({ path: path.join(artifacts, 'entry-' + width + '.png'), fullPage: true });
            await page.keyboard.press('Enter'); await page.waitForURL(origin + '/dashboard-admin');
            assert.deepEqual(trace.map(item => item.method + ' ' + item.path), ['GET /api/dashboard/session',
                'POST /api/dashboard/session', 'GET /api/dashboard/session', 'GET /api/dashboard-admin/capabilities']);

            for (const nextMode of ['unknown', 'error', 'absent', 'revoked', 'forbidden']) {
                await entry(nextMode, ['absent', 'revoked', 'forbidden'].includes(nextMode));
                await open().click(); await page.waitForFunction(() => !document.getElementById('adminEntryOpen').disabled);
                assert.equal(page.url(), origin + '/dashboard-admin/entry');
                assert.equal(trace.some(item => item.method === 'POST'), false);
                assert.doesNotMatch(await page.locator('#adminEntryStatus').innerText(), /PRIVATE_ERROR_CANARY|gate|SQL|runtime/);
                assert.equal(await page.locator('#adminEntrySignIn').isVisible(), nextMode === 'revoked');
                await noOverflow();
            }
            await entry('uncertain'); await open().click();
            await page.getByText('Opening your session could not be confirmed.', { exact: false }).waitFor();
            await open().click(); await page.waitForFunction(() => !document.getElementById('adminEntryOpen').disabled);
            assert.equal(trace.filter(item => item.method === 'POST').length, 1, 'uncertain command is never repeated');

            for (const nextMode of ['pending-session', 'pending-post']) {
                await entry(nextMode); await open().click(); await until(() => pending.length === 1);
                await page.getByRole('button', { name: 'Cancel access check' }).click();
                assert.equal(await open().evaluate(node => node === document.activeElement), true);
                await pending.shift()();
                mode = nextMode === 'pending-post' ? 'fresh' : 'unknown';
                await open().click(); await page.waitForFunction(() => !document.getElementById('adminEntryOpen').disabled);
                assert.equal(trace.filter(item => item.method === 'POST').length, nextMode === 'pending-post' ? 1 : 0);
                assert.equal(page.url(), origin + '/dashboard-admin/entry');
            }
            await entry('pending-session'); await open().click(); await until(() => pending.length === 1);
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
            await pending.shift()();
            assert.equal(page.url(), origin + '/dashboard-admin/entry');
            assert.equal(trace.length, 1, 'pagehide ignores the late session response');

            mode = 'fresh'; entryAllowed = true; entryDenied = false; trace = [];
            await page.goto(origin + '/operator');
            const nav = page.getByRole('link', { name: 'Dashboard administration', exact: true }); await nav.waitFor(); await noOverflow();
            await page.getByRole('link', { name: 'Service desk', exact: true }).focus(); await page.keyboard.press('Tab');
            assert.equal(await nav.evaluate(node => node === document.activeElement), true);
            assert.equal(await nav.getAttribute('href'), '/dashboard-admin/entry');
            await page.screenshot({ path: path.join(artifacts, 'navigation-' + width + '.png'), fullPage: true });
            mode = 'pending-navigation'; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await until(() => pending.length === 1);
            assert.equal(await page.locator('#dashboardAdminNavigation').isVisible(), false);
            mode = 'fresh'; entryAllowed = false;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForResponse(response => response.url().endsWith('/entry-capabilities'));
            await pending.shift()();
            assert.equal(await page.locator('#dashboardAdminNavigation').isVisible(), false, 'late entry approval cannot override current denial');
            entryAllowed = true; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await nav.waitFor();
            entryDenied = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForResponse(response => response.url().endsWith('/entry-capabilities'));
            assert.equal(await page.locator('#dashboardAdminNavigation').isVisible(), false);
            assert.deepEqual(await page.evaluate(() => window.entryCspViolations), []);
            results.push({ width, keyboard: 'pass', explicitInitialization: 'pass', unknownAndDenied: 'pass',
                uncertaintyAndCancellation: 'pass', staleNavigation: 'pass', overflow: 'none' });
            await context.close();
        }
        assert.deepEqual(outside, []); assert.deepEqual(pageErrors, []);
    } catch (error) { failure = error; }
    finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
    const report = { syntheticOnly: true, productionRequests: 0, artifacts, results, outside, pageErrors,
        hashes: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
        ...(failure ? { error: failure.message } : {}) };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (failure) { console.error(failure.stack); process.exitCode = 1; }
})();
