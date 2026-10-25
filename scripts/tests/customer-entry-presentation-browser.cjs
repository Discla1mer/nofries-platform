'use strict';

// Optional rendered presentation verifier, using existing Playwright/Chromium.
// node scripts/tests/customer-entry-presentation-browser.cjs
// Only loopback synthetic data. The single allowed POST resumes a fixture;
// no acceptance, account creation, authentication or durable write is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { buildSignupDocument } = require('../../lib/signupDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'organisationPicture.js'];
const files = ['home.css', 'style.css', 'login.html', 'index.html', 'app/dashboard.html', 'app/dashboard.css',
    'js/dashboard-loader.js', 'js/organisation-setup.js', 'lib/signupDocument.js', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js',
    'api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file), 'scripts/tests/customer-entry-presentation-browser.cjs'];
const hash = source => createHash('sha256').update(source).digest('hex');
const hashes = () => Object.fromEntries(files.map(file => [file, hash(read(file))]));
const before = hashes();
const cssOverride = process.env.NOFRIES_ENTRY_HOME_CSS;
const homeCss = cssOverride ? fs.readFileSync(cssOverride, 'utf8') : read('home.css');
const app = bundleFiles.map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const options = { customerLogin: true, customerTransport: 'auto', loaderSource: read('js/dashboard-loader.js'),
    protectedAppSource: app, protectedStyleSource: read('app/dashboard.css') };
const dashboard = buildDashboardDocument({ ...options, template: read('app/dashboard.html') });
const gateway = buildGatewayDocument({ ...options, template: read('index.html') });
const signup = buildSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js'), customerLogin: true, customerTransport: 'external' });
const legal = { status: 'terms', termsVersion: 'synthetic-version-2026-10-15', termsDigest: 'a'.repeat(64),
    scheduleId: 'synthetic-schedule', scheduleDigest: 'b'.repeat(64),
    scheduleText: ['Synthetic organisation schedule', 'Organisation: "Synthetic company <Example>"',
        'Activation: 15 October 2026; access ends: 14 November 2026.',
        'Original agreement date: 29 September 2026.',
        'Literal text: <script>mustNotExecute()</script>',
        ...Array.from({ length: 30 }, (_, i) => `Schedule line ${i + 1}: exact saved text, with no legal interpretation.`), ''].join('\n'),
    termsText: ['Synthetic agreement for rendered checks only.', 'Effective date: 29 September 2026.',
        'Whitespace is preserved:\tindented text.', 'Literal text: <img src="https://invalid.example/image">',
        ...Array.from({ length: 45 }, (_, i) => `Agreement clause ${i + 1}. Complete text remains readable and printable.`),
        'LongUnbrokenSyntheticDocumentReference'.repeat(8), 'END OF SYNTHETIC AGREEMENT', ''].join('\n') };
const requestId = '10000000-0000-4000-8000-000000000002';
const bindings = [{ bindingId: '10000000-0000-4000-8000-000000000001', organisationLabel: 'Synthetic consultancy' }];
const assets = Object.fromEntries(['style.css', 'home.css', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
    'images/nofrieslogo.png', 'js/organisation-setup.js', 'js/home.js', 'js/prospect-assistant.js'].map(file => ['/' + file, file]));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-customer-entry-presentation-'));
fs.chmodSync(artifacts, 0o700);
const requests = [], blocked = [], errors = [], csp = [], results = [];
let mode = 'public';
const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && pathname === '/api/customer-signup/clients') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (body !== JSON.stringify({ action: 'resume', requestId })) {
            blocked.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end();
        }
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ state: legal, csrfToken: 'c'.repeat(43) }));
    }
    if (req.method !== 'GET') { blocked.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end(); }
    let body, type = 'application/json';
    if (['/dashboard', '/', '/signup'].includes(pathname)) {
        const document = pathname === '/' ? gateway : pathname === '/signup' ? signup : dashboard;
        body = document.html; type = 'text/html'; res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    } else if (pathname === '/login') {
        body = read('login.html'); type = 'text/html';
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; script-src-attr 'none'; style-src-attr 'none'");
    } else if (pathname === '/api/dashboard/session') {
        res.statusCode = mode === 'public' ? 401 : 200;
        body = JSON.stringify(mode === 'public' ? { code: 'dashboard_session_required' } : {
            schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'consultant', clientSetupAvailable: true,
            generation: 'a'.repeat(64), selectedBindingId: null, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    } else if (pathname === '/api/dashboard/organisations') {
        body = JSON.stringify({ schemaVersion: 1, bindings, nextAfterBindingId: null });
    } else if (pathname === '/api/customer-signup/clients') {
        body = JSON.stringify({ state: { status: 'clients', remaining: 1,
            clients: [{ requestId, organisationName: 'Synthetic client', status: 'pending' }] }, csrfToken: 'c'.repeat(43) });
    } else if (pathname === '/api/external-customer-signup/state') {
        body = JSON.stringify({ state: legal, csrfToken: 'c'.repeat(43) });
    } else if (pathname === '/api/organisation-setup/state') {
        res.setHeader('x-nofries-customer-sign-in', 'available'); body = JSON.stringify({ state: 'start' });
    } else if (assets[pathname]) {
        body = pathname === '/home.css' ? homeCss : fs.readFileSync(path.join(root, assets[pathname]));
        type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    } else { blocked.push({ method: req.method, path: pathname }); res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', type); res.end(body);
});

async function layout(page, name) {
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
        legal: [...document.querySelectorAll('.signup-legal-text, .client-signup-terms')].map(node => ({
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY,
            width: node.getBoundingClientRect().width, visible: !!node.getBoundingClientRect().height })) }));
    assert.ok(geometry.width <= geometry.viewport + 1, name + ': horizontal overflow');
    for (const document of geometry.legal.filter(item => item.visible)) {
        assert.ok(document.scrollHeight <= document.clientHeight + 1, name + ': legal text is clipped or nested scrolling');
    }
    results.push({ name, ...geometry });
}
async function focus(page, selector) {
    await page.locator(selector).focus();
    // Tab back into the target with real keyboard input to trigger focus-visible.
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const outline = await page.locator(selector).evaluate(node => ({ active: node === document.activeElement,
        style: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }));
    assert.equal(outline.active, true); assert.equal(outline.style, 'solid'); assert.ok(outline.width >= 3);
}
async function legalText(page, schedule, terms) {
    assert.equal(await page.locator(schedule).textContent(), legal.scheduleText);
    assert.equal(await page.locator(terms).textContent(), legal.termsText);
    assert.equal(await page.locator('script[src^="https"], img[src^="https"]').count(), 0);
}
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser, failure = null;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext();
        await context.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
            console.error('CSP:' + event.effectiveDirective);
        }));
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.text().startsWith('CSP:')) csp.push(message.text()); });
        await context.route('**/*', route => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin !== base || req.method() !== 'GET' && !(req.method() === 'POST' &&
                url.pathname === '/api/customer-signup/clients' && req.postData() === JSON.stringify({ action: 'resume', requestId }))) {
                blocked.push({ method: req.method(), path: url.pathname, external: url.origin !== base }); return route.abort();
            }
            return route.continue();
        });
        for (const width of [1440, 390, 320]) for (const enlarged of [false, true]) {
            await page.setViewportSize({ width, height: 900 });
            const suffix = width + (enlarged ? '-text200' : '');
            async function visit(route) {
                await page.goto(base + route);
                if (enlarged) await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
            }
            mode = 'public'; await visit('/dashboard');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated');
            assert.equal(await page.locator('#dashboardSignIn').getAttribute('href'), '/login');
            await focus(page, '#dashboardSignIn'); await layout(page, 'signed-out-' + suffix);
            if (width === 1440 && !enlarged) {
                const box = await page.locator('#dashboardStatusPanel').boundingBox();
                assert.ok(box.width <= 642, 'Signed-out entry should fit a compact account card');
            }
            await page.screenshot({ path: path.join(artifacts, 'signed-out-' + suffix + '.png'), fullPage: true });
            await visit('/'); await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated');
            assert.equal(await page.locator('#create-organisation a.button').getAttribute('href'), '/login');
            await layout(page, 'gateway-' + suffix);
            await visit('/login?provider=legacy'); await page.locator('#organisation-form:not([hidden])').waitFor();
            await focus(page, '#organisation-email'); await layout(page, 'login-' + suffix);
            await visit('/signup?provider=external'); await page.getByRole('heading', { name: 'Dashboard agreement', exact: true }).waitFor();
            await legalText(page, '.signup-schedule .signup-legal-text', '.signup-agreement .signup-legal-text');
            assert.equal(await page.getByRole('checkbox').isChecked(), false);
            assert.ok(await page.getByRole('button', { name: 'Accept and continue' }).isDisabled());
            await focus(page, '.signup-consent input'); await layout(page, 'organisation-legal-' + suffix);
            if (width === 1440 && !enlarged) assert.ok((await page.locator('#signup').boundingBox()).width >= 900,
                'Legal review should use the wider reading layout');
            await page.screenshot({ path: path.join(artifacts, 'organisation-legal-' + suffix + '.png'), fullPage: true });
            mode = 'consultant'; await visit('/dashboard#organisations');
            await page.getByRole('button', { name: 'Continue setup: Synthetic client', exact: true }).click();
            await page.getByText('Review the schedule and terms for Synthetic client', { exact: true }).waitFor();
            await legalText(page, 'section.client-terms-section .client-signup-terms', 'details.client-terms-section .client-signup-terms');
            const details = page.locator('details.client-terms-section');
            assert.equal(await details.evaluate(node => node.open), true);
            assert.equal(await page.locator('.client-consent input').isChecked(), false);
            await focus(page, '#clientTermsHeading'); await page.keyboard.press('Enter');
            assert.equal(await details.evaluate(node => node.open), false);
            await page.keyboard.press('Space'); assert.equal(await details.evaluate(node => node.open), true);
            await layout(page, 'client-legal-' + suffix);
            await page.screenshot({ path: path.join(artifacts, 'client-legal-' + suffix + '.png'), fullPage: true });
            if (width === 1440 && !enlarged) {
                await page.locator('#clientTermsHeading').click();
                await page.emulateMedia({ media: 'print' });
                assert.equal(await page.locator('.skip-link').isVisible(), false, 'Fixed skip link must not overlay printed legal text');
                assert.ok(await page.locator('details.client-terms-section .client-signup-terms').isVisible(),
                    'Complete client agreement must print even when its disclosure is closed');
                await layout(page, 'client-legal-print');
                await page.pdf({ path: path.join(artifacts, 'client-legal.pdf'), format: 'A4', printBackground: true });
                await page.emulateMedia({ media: 'screen' });
            }
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(csp, []);
        assert.deepEqual(hashes(), before, 'Sources changed during verification');
        console.log(JSON.stringify({ passed: true, observations: results.length, browser: browser.version(), artifacts }));
    } catch (error) { failure = error.stack; throw error; }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure,
            syntheticOnly: true, scope: 'Loopback presentation and exact legal-text rendering; synthetic resume POST only. No acceptance, authentication, durable writes or live verification.',
            results, blocked, errors, csp, requests, sourceHashesBefore: before, sourceHashesAfter: hashes(), cssOverride: cssOverride || null,
            cssSha256: hash(homeCss) }, null, 2), { mode: 0o600 });
        if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
