'use strict';

// Optional synthetic served-shell Chromium check. Existing browser/Playwright only.
// NOFRIES_FOOTER_TEST_ROOT selects a checkout; NOFRIES_FOOTER_BASELINE=1 proves the
// original six footer bypasses. No provider requests, credentials or captures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = process.env.NOFRIES_FOOTER_TEST_ROOT || path.resolve(__dirname, '../..');
const { buildDashboardDocument } = require(path.join(root, 'lib/dashboardDocument'));
const { buildGatewayDocument } = require(path.join(root, 'lib/gatewayDocument'));
const { buildFixtures } = require(path.join(root, 'scripts/build-ncsc-questionnaire-preview'));
const read = file => fs.readFileSync(path.join(root, file));
const baseline = process.env.NOFRIES_FOOTER_BASELINE === '1';
const bundle = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const sources = ['app/dashboard.html', 'index.html', 'js/dashboard-loader.js', 'app/dashboard.css', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
    ...bundle.map(file => 'api/shared/protectedAssets/' + file)];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(read(file)).digest('hex')]));
const before = hashes();
const app = bundle.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n');
const css = read('app/dashboard.css').toString();
const documents = Object.fromEntries([['/dashboard', 'app/dashboard.html'], ['/', 'index.html']].map(([url, file]) =>
    [url, (url === '/' ? buildGatewayDocument : buildDashboardDocument)({ customerLogin: true, customerTransport: 'auto', template: read(file).toString(),
        loaderSource: read('js/dashboard-loader.js').toString(), protectedAppSource: app, protectedStyleSource: css })]));
const fixture = buildFixtures(), seed = fixture.tenants[0];
const bindingId = '10000000-0000-4000-8000-000000000001';
const model = seed.model;
const moduleView = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
    module: model.modules.find(row => row.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
    services: [], admissionGranted: false, providerAccessGranted: false, metadata: fixture.metadata, presentationMode: 'editable' };
const assets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')], '/images/nofrieslogo.png': ['image/png', read('images/nofrieslogo.png')] };
const targets = { '/dashboard': ['/roadmap.html', 'https://news.nofries.nz/'],
    '/': ['https://news.nofries.nz/', '/roadmap.html', '/privacy.html', '/terms.html'] };
const errors = [], unexpected = [], results = [];
let anonymous = false;
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET') { unexpected.push(request.method + ' ' + url.pathname); response.writeHead(405); return response.end(); }
    let body, type = 'application/json', status = 200;
    if (documents[url.pathname]) {
        body = documents[url.pathname].html; type = 'text/html';
        response.setHeader('Content-Security-Policy', documents[url.pathname].contentSecurityPolicy);
    } else if (url.pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (url.pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (url.pathname === '/api/dashboard/session') {
        status = anonymous ? 401 : 200;
        body = anonymous ? { code: 'dashboard_authentication_required' } : { schemaVersion: 1, authenticated: true,
            purpose: 'customer', accountType: 'company', generation: 'a'.repeat(64), selectedBindingId: bindingId,
            expiresAt: new Date(Date.now() + 3600000).toISOString() };
    } else if (url.pathname === '/api/dashboard/organisations') body = { schemaVersion: 1,
        bindings: [{ bindingId, organisationLabel: 'Synthetic footer organisation' }], nextAfterBindingId: null };
    else if (url.pathname === '/api/dashboard/bootstrap') body = model;
    else if (url.pathname === '/api/dashboard/modules/cyber_security') body = moduleView;
    else if (url.pathname === '/api/dashboard/ncsc/assessments') body = { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null };
    else if (['/roadmap.html', '/privacy.html', '/terms.html'].includes(url.pathname)) { body = '<!doctype html><title>Synthetic destination</title>'; type = 'text/html'; }
    else if (['/js/home.js', '/js/organisation-setup.js', '/js/prospect-assistant.js'].includes(url.pathname)) { body = read(url.pathname.slice(1)); type = 'text/javascript'; }
    else if (assets[url.pathname]) [type, body] = assets[url.pathname];
    else { unexpected.push(request.method + ' ' + url.pathname); status = 404; body = {}; }
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
});
const button = (page, name) => page.getByRole('button', { name, exact: true });
const draft = 'Synthetic unsent footer draft';
async function activate(page, locator, touch) {
    // The unchanged fixed mobile task bar overlaps footer touch targets. Exercise
    // native keyboard activation at320px, and native touch on the dialog controls.
    if (touch && await locator.evaluate(node => node.tagName !== 'A')) await locator.tap();
    else { await locator.focus(); await page.keyboard.press('Enter'); }
}
async function settled(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function assertDraft(page) {
    assert.equal(await page.locator('#ncsc-scope').inputValue(), draft);
    assert.equal(await page.locator('#dashboardApp').evaluate(node => node.hidden), false);
}
async function assertFocus(page) {
    await settled(page);
    const heading = page.locator('#ncsc-title');
    assert.equal(await heading.evaluate(node => node === document.activeElement && node.tabIndex === -1), true,
        'Footer cancellation retains the genuine questionnaire fallback focus');
    let reached = false;
    for (let index = 0; index < 6 && !reached; index++) {
        await page.keyboard.press('Tab');
        reached = await page.locator('#ncsc-scope').evaluate(node => node === document.activeElement);
    }
    assert.equal(reached, true, 'The retained scope is keyboard-reachable after cancellation');
}
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, args: ['--no-sandbox'] });
        for (const width of baseline ? [1440] : [1440, 320]) for (const shell of Object.keys(targets)) {
            const touch = width === 320;
            const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch });
            await context.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                if (request.method() === 'GET' && request.url() === 'https://news.nofries.nz/') {
                    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic News destination</title>' });
                }
                if (url.origin !== origin || request.method() !== 'GET') { unexpected.push('Blocked non-fixture request'); return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage(); page.setDefaultTimeout(7000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => dialog.accept());
            await page.addInitScript(() => {
                window.footerViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.footerViolations.push(event.effectiveDirective));
            });
            const navigation = [];
            page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigation.push(request.url()); });
            async function open(withDraft = true) {
                await page.goto(origin + shell + '#cyber-security');
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
                await button(page, 'Start an assessment').waitFor();
                if (withDraft) { await button(page, 'Start an assessment').click(); await page.locator('#ncsc-scope').fill(draft); }
                assert.deepEqual(await page.evaluate(() => window.footerViolations), []);
            }
            for (const target of targets[shell]) {
                anonymous = false; await open();
                const link = page.locator('footer a').filter({ hasText: target.includes('news.') ? 'News' :
                    target.includes('roadmap') ? 'Roadmap' : target.includes('privacy') ? 'Privacy' : 'Terms' });
                assert.equal(await link.getAttribute('href'), target);
                const destination = new URL(target, origin).href;
                const initial = navigation.length;
                await activate(page, link, touch);
                if (baseline) {
                    await page.waitForURL(destination);
                    assert.equal(navigation.length - initial, 1);
                    assert.equal(await page.locator('dialog').count(), 0);
                    results.push({ shell, target, reproducedBypass: true }); continue;
                }
                await page.locator('dialog[open]').waitFor();
                assert.equal(navigation.length, initial);
                assert.equal(await button(page, 'Stay here').evaluate(node => node === document.activeElement), true);
                for (const name of ['Save and leave', 'Discard unsent changes', 'Stay here']) {
                    await page.keyboard.press('Tab');
                    assert.equal(await button(page, name).evaluate(node => node === document.activeElement), true);
                }
                for (const name of ['Discard unsent changes', 'Save and leave', 'Stay here']) {
                    await page.keyboard.press('Shift+Tab');
                    assert.equal(await button(page, name).evaluate(node => node === document.activeElement), true);
                }
                await activate(page, button(page, 'Stay here'), touch);
                await assertDraft(page); await assertFocus(page);
                await activate(page, link, touch); await page.keyboard.press('Escape');
                await assertDraft(page); await assertFocus(page);
                await activate(page, link, touch);
                await page.locator('footer a').last().evaluate(node => { node.click(); node.click(); });
                assert.equal(await page.locator('dialog[open]').count(), 1);
                await activate(page, button(page, 'Discard unsent changes'), touch);
                await page.waitForURL(destination);
                assert.equal(navigation.length - initial, 1, 'One explicit decision navigates once to its original target');
                results.push({ width, shell, target, footerActivation: 'keyboard', dialogTouch: touch, stayEscapeDraftAndQuestionnaireFocus: true, focusTrap: true, discardExactlyOnce: true });
            }
            if (!baseline) {
                anonymous = false; await open();
                const link = page.locator('footer a[href="/roadmap.html"]');
                const destination = new URL(await link.getAttribute('href'), origin).href;
                for (const mode of ['Control', '_blank']) {
                    if (mode === '_blank') await link.evaluate(node => node.setAttribute('target', '_blank'));
                    const popupReady = context.waitForEvent('page', { timeout: 7000 });
                    popupReady.catch(() => {});
                    await link.focus();
                    await page.keyboard.press(mode === 'Control' ? 'Control+Enter' : 'Enter');
                    const popup = await popupReady; await popup.bringToFront();
                    try { await popup.waitForURL(destination, { timeout: 7000 }); }
                    catch (error) { throw new Error('Native tab witness ' + JSON.stringify({ width, shell, mode, expected: destination, actual: popup.url(), unexpected }) + ': ' + error.message); }
                    await popup.close(); await page.bringToFront();
                    await assertDraft(page); assert.equal(await page.locator('dialog').count(), 0);
                    if (mode === '_blank') await link.evaluate(node => node.removeAttribute('target'));
                }
                // Clean and anonymous footer navigation retain their native destinations.
                for (const signedOut of [false, true]) {
                    anonymous = signedOut;
                    if (signedOut) { await page.goto(origin + shell); await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated'); }
                    else await open(false);
                    const plain = page.locator('footer a').first(), url = new URL(await plain.getAttribute('href'), origin).href;
                    await activate(page, plain, touch); await page.waitForURL(url);
                    assert.equal(await page.locator('dialog').count(), 0);
                }
                results.push({ width, shell, modifiedAndBlankNative: true, cleanAndAnonymousNative: true,
                    mobileKeyboardLinksTouchDialog: touch, preExistingFooterTouchOcclusion: touch });
            }
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ passed: true, baseline, syntheticOnly: true, results, sources: before }));
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
