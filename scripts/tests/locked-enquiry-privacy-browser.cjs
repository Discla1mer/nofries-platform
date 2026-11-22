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
    else if (pathname === '/api/dashboard/modules/cyber_security') body = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
        module: model.modules.find(m => m.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] }, services: [],
        admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable',
        ...(included === null ? {} : { paidFrameworks: included }) };
    else if (pathname === '/api/enquiry') body = { available: true, promote: false };
    else if (['/images/paper-texture.webp', '/assets/fonts/fraunces-latin-opsz-normal.woff2', '/contact.html', '/js/contact.js', '/js/enquiry-availability.js', '/style.css', '/home.css', '/favicon.svg', '/images/nofrieslogo.png', '/fictional-nist-example.html', '/fictional-iso-example.html'].includes(pathname)) {
        type = pathname.endsWith('.woff2') ? 'font/woff2' : pathname.endsWith('.webp') ? 'image/webp' : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
        // The ISO page belongs to #501. A supplied checkout keeps this test runnable on #529 alone.
        if (pathname === '/fictional-iso-example.html' && process.env.NOFRIES_ISO_EXAMPLE_FILE) body = fs.readFileSync(process.env.NOFRIES_ISO_EXAMPLE_FILE);
        else body = read(pathname.slice(1));
    } else { failures.push(pathname); status = 404; body = {}; }
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': doc.contentSecurityPolicy });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
});
(async () => {
    let browser;
    const passed = [];
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const accountType of ['company', 'consultant']) {
            session.accountType = accountType; session.generation = 'a'.repeat(64);
            session.selectedBindingId = '10000000-0000-4000-8000-000000000001';
            session.expiresAt = new Date(Date.now() + 3600000).toISOString();
            model.context.displayName = 'Fictional Harbour Studio'; admitted = true;
            const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
            let scriptGate = null, availabilityGate = null;
            await context.route('**/*', async route => {
                const req = route.request(), url = new URL(req.url());
                requests.push([req.method(), req.url(), req.postData(), req.headers()]);
                if (url.origin !== origin || req.method() !== 'GET' || url.pathname.startsWith('/api/dashboard/frameworks/')) {
                    failures.push('external, mutation or paid read'); return route.abort();
                }
                if (url.pathname === '/js/contact.js' && scriptGate) await scriptGate;
                if (url.pathname === '/api/enquiry' && availabilityGate) await availabilityGate;
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
            page.on('console', msg => writes.push(['console', msg.text()]));
            const ready = () => page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            const dialog = page.getByRole('dialog', { name: 'Ask No Fries', exact: true });
            const card = ref => page.locator('.dashboard-panel').filter({ has: page.getByRole('heading', { name: ref.label, exact: true }) });
            const link = ref => card(ref).locator('a[href="/contact.html"]');
            const message = dialog.locator('[name=message]'), organisation = dialog.locator('[name=organisation]');
            const choose = async (ref, plan) => {
                const select = card(ref).locator('select');
                if (await select.count()) await select.selectOption(plan);
            };
            const open = async (ref, plan = 'annual') => {
                await choose(ref, plan); await link(ref).focus(); await page.keyboard.press('Enter');
                await message.waitFor();
                const plans = await card(ref).locator('select').count();
                assert.equal(await message.inputValue(), 'I would like to ask about ' + ref.label + (plans ? ' on the ' + plan + ' plan' : '') + '.');
                assert.equal(await organisation.inputValue(), accountType === 'consultant' ? model.context.displayName : '');
                assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
                assert.equal(new URL(page.url()).hash, '#cyber-security');
            };
            await page.goto(origin + '/dashboard#cyber-security'); await ready();
            if (await card(paidFrameworks[0]).locator('select').count()) {
                await link(paidFrameworks[0]).click();
                assert.equal(await dialog.count(), 0);
                assert.equal(await card(paidFrameworks[0]).locator('select').evaluate(node => node === document.activeElement), true);
                passed.push(accountType + ': invoice plan required');
            }
            // Close while a script is still loading: the later response cannot reopen the form.
            let releaseScript; scriptGate = new Promise(resolve => { releaseScript = resolve; });
            await choose(paidFrameworks[0], 'monthly'); await link(paidFrameworks[0]).click();
            await dialog.waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            releaseScript(); scriptGate = null;
            await page.waitForFunction(() => typeof window.mountEnquiryForm === 'function');
            assert.equal(await dialog.count(), 0); passed.push(accountType + ': late script');
            for (const ref of paidFrameworks) for (const plan of ['monthly', 'annual']) {
                await open(ref, plan);
                await message.fill('Synthetic unsent edit'); await organisation.fill('Synthetic unsent organisation');
                await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
                assert.equal(await link(ref).evaluate(node => node === document.activeElement), true);
                await open(ref, plan); // Edits do not carry into a new form.
                if (process.env.NOFRIES_TEST_ENQUIRY_EVIDENCE && accountType === 'consultant' && plan === 'annual') {
                    await dialog.screenshot({ path: path.join(process.env.NOFRIES_TEST_ENQUIRY_EVIDENCE, ref.profileId + '-375.png') });
                }
                await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            }
            passed.push(accountType + ': frameworks, plans, edits, close focus');
            // A normal submit waits for availability. Closing during that wait must suppress the send.
            let releaseAvailability; availabilityGate = new Promise(resolve => { releaseAvailability = resolve; });
            await open(paidFrameworks[1]);
            await dialog.locator('[name=name]').fill('Synthetic Buyer');
            await dialog.locator('[name=email]').fill('buyer@example.test');
            await dialog.locator('#contact-send').click();
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            releaseAvailability(); availabilityGate = null;
            await page.waitForFunction(() => !document.querySelector('dialog'));
            passed.push(accountType + ': pending submit cancelled');
            await open(paidFrameworks[1]); await message.fill('Synthetic unsent edit');
            await page.reload(); await ready(); assert.equal(await dialog.count(), 0);
            await open(paidFrameworks[0], 'monthly');
            // Revalidate a different selected binding with the same organisation ID; no stale name survives.
            session.generation = 'b'.repeat(64); session.selectedBindingId = '20000000-0000-4000-8000-000000000002';
            model.context.displayName = 'Fictional Kōwhai Theatre';
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await dialog.waitFor({ state: 'detached' }); await ready();
            await open(paidFrameworks[1]);
            await page.goto(origin + '/contact.html');
            assert.equal(await page.locator('#contact-message').inputValue(), '');
            assert.equal(await page.locator('#contact-organisation').inputValue(), '');
            await page.goBack(); await ready(); assert.equal(await dialog.count(), 0);
            await page.goForward(); await page.goBack(); await ready(); assert.equal(await dialog.count(), 0);
            passed.push(accountType + ': switch, reload, repeated history, blank fallback');
            await open(paidFrameworks[0], 'monthly'); admitted = false;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await dialog.count(), 0); passed.push(accountType + ': access loss');
            admitted = true; session.expiresAt = new Date(Date.now() + 60000).toISOString();
            await page.goto('about:blank'); await page.clock.install({ time: new Date() });
            await page.goto(origin + '/dashboard#cyber-security'); await ready();
            await open(paidFrameworks[1]); await page.clock.fastForward(61000);
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'expired');
            assert.equal(await dialog.count(), 0); passed.push(accountType + ': expiry');
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(failures, []);
        const observed = JSON.stringify([requests, writes]);
        for (const value of ['Fictional Harbour Studio', 'Fictional Kōwhai Theatre', 'Synthetic unsent', 'Synthetic Buyer', 'buyer@example.test', ...paidFrameworks.map(ref => ref.label)]) assert.ok(!observed.includes(value), 'Private form context escaped');
        assert.ok(!writes.some(([key]) => key === 'analytics'));
        console.log(JSON.stringify({ viewport: '375x812', passed, externalRequests: 0, enquirySends: 0, paidReads: 0, analytics: 0, privateContextLeaks: 0, pageErrors: 0 }));
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
