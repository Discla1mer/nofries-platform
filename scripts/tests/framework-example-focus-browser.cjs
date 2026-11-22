'use strict';

// Synthetic signed-in projections only; no identity provider, database or enquiry sends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { paidFrameworks } = require('../../api/shared/protectedAssets/dashboardRegistry');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const files = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'organisationPicture.js'];
const app = files.map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const css = read('app/dashboard.css').toString();
const doc = buildDashboardDocument({ loaderSource: read('js/dashboard-loader.js').toString(), template: read('app/dashboard.html').toString(),
    protectedAppSource: app, protectedStyleSource: css });
const fixtures = buildFixtures(), model = fixtures.tenants[0].model;
let included = [], admitted = true;
const session = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'company',
    generation: 'a'.repeat(64), selectedBindingId: '10000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 3600000).toISOString() };
const failures = [], requests = [], writes = [], errors = [];
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    let body, type = 'application/json', status = 200;
    if (req.method !== 'GET') { failures.push('non-GET'); res.writeHead(405); res.end(); return; }
    if (pathname === '/dashboard') { body = doc.html; type = 'text/html'; }
    else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') { body = admitted ? session : { code: 'dashboard_access_denied' }; status = admitted ? 200 : 403; }
    else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1, bindings: [{ bindingId: session.selectedBindingId, organisationLabel: model.context.displayName }], nextAfterBindingId: null };
    else if (pathname === '/api/dashboard/bootstrap') body = model;
    else if (pathname === '/api/dashboard/ncsc/assessments') body = { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null };
    else if (pathname === '/api/dashboard/modules/cyber_security') body = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
        module: model.modules.find(m => m.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] }, services: [],
        admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable',
        ...(included === null ? {} : { paidFrameworks: included }) };
    else if (['/images/paper-texture.webp', '/assets/fonts/fraunces-latin-opsz-normal.woff2', '/style.css', '/home.css', '/favicon.svg', '/images/nofrieslogo.png', '/fictional-nist-example.html', '/fictional-iso-example.html'].includes(pathname)) {
        type = pathname.endsWith('.woff2') ? 'font/woff2' : pathname.endsWith('.webp') ? 'image/webp' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
        // The ISO page belongs to #501. A supplied checkout keeps this test runnable on #529 alone.
        if (pathname === '/fictional-iso-example.html' && process.env.NOFRIES_ISO_EXAMPLE_FILE) body = fs.readFileSync(process.env.NOFRIES_ISO_EXAMPLE_FILE);
        else body = read(pathname.slice(1));
    } else { failures.push(pathname); status = 404; body = {}; }
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': doc.contentSecurityPolicy });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
});
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
        await context.route('**/*', route => {
            const req = route.request(); requests.push([req.method(), req.url(), req.postData(), req.headers()]);
            if (new URL(req.url()).origin !== origin || req.method() !== 'GET') { failures.push('external or mutation'); return route.abort(); }
            return route.continue();
        });
        await context.exposeFunction('captureWrite', (key, value) => writes.push([key, value]));
        await context.addInitScript(() => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) { window.captureWrite(key, value); return original.call(this, key, value); };
            window.plausible = (...args) => window.captureWrite('analytics', args);
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        const ready = () => page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
        const focus = key => page.waitForFunction(id => document.activeElement?.id === id, 'framework-example-' + key);
        await page.goto(origin + '/dashboard#cyber-security'); await ready();
        // Each dashboard history entry retains its own originating card, including after several round trips.
        for (const key of ['nist', 'iso', 'nist', 'iso']) {
            await page.locator('#framework-example-' + key).focus(); await page.keyboard.press('Enter');
            await page.getByRole('heading', { level: 1 }).waitFor();
            assert.equal(new URL(page.url()).pathname, '/fictional-' + key + '-example.html');
            await page.goBack(); await ready(); await focus(key);
            await page.goForward(); await page.getByRole('link', { name: 'Return to Cyber Security', exact: true }).focus();
            await page.keyboard.press('Enter'); await ready(); await focus(key);
            await page.goBack(); await page.goForward(); await ready(); await focus(key);
            assert.equal(new URL(page.url()).hash, '#cyber-security');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
        }
        // Same-document history must not let a stale example marker steal navigation focus.
        await page.getByRole('link', { name: 'Services', exact: true }).first().click();
        assert.notEqual(await page.evaluate(() => document.activeElement.id), 'framework-example-iso');
        for (const grants of [null, [], [paidFrameworks[0]], [paidFrameworks[1]], paidFrameworks]) {
            included = grants === null ? null : grants.map(({ moduleId, profileId, version }) => ({ moduleId, profileId, version }));
            await page.goto('about:blank');
            await page.goto(origin + '/dashboard#cyber-security/nist-example'); await ready();
            const expected = grants === null ? 0 : 2 - grants.length;
            assert.equal(await page.locator('[id^=framework-example-]').count(), expected);
            if (app.includes('Invoice plan for ')) {
                assert.equal(await page.locator('.dashboard-panel select').count(), expected);
                assert.equal((await page.locator('#dashboardApp').innerText()).includes('NZ$99 + GST'), grants !== null);
            }
            if (grants !== null && !grants.includes(paidFrameworks[0])) await focus('nist');
            else assert.notEqual(await page.evaluate(() => document.activeElement.id), 'framework-example-nist');
        }
        admitted = false;
        await page.goto('about:blank');
        await page.goto(origin + '/dashboard#cyber-security/iso-example');
        await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
        assert.equal(await page.locator('[id^=framework-example-]').count(), 0);
        assert.deepEqual(errors, []); assert.deepEqual(failures, []);
        const observed = JSON.stringify([requests, writes]);
        assert.ok(!observed.includes(model.context.displayName));
        assert.ok(!writes.some(([key]) => key === 'analytics'));
        console.log(JSON.stringify({ viewport: '375x812', roundTrips: 4, historyTraversals: 16, entitlementStates: 5, denial: 'passed', externalRequests: 0, mutations: 0, pageErrors: 0 }));
        await context.close();
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
