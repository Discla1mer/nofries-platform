'use strict';

// Optional actual-Chromium test; installed Playwright/Chromium only.
// node scripts/tests/selection-wrapper-browser.cjs
// NOFRIES_SELECTION_HOME_CSS selects retained original CSS for a RED control.
// NOFRIES_SELECTION_RECORD_BASELINE=1 completes RED measurements, reporting
// failed long-label checks and exit1. Candidate acceptance never relaxes them.
// NOFRIES_SELECTION_BASELINE points to its results.json for parity comparisons.
// NOFRIES_SELECTION_ARTIFACTS selects an external output directory.
// Every network request is a synthetic loopback GET; no account mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { buildSignupDocument } = require('../../lib/signupDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const widths = [320, 390, 768, 1024, 1220, 1280, 1440, 1920, 2560];
const routes = ['/dashboard', '/'];
const artifacts = path.resolve(process.env.NOFRIES_SELECTION_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-selection-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep artifacts outside the repository');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const baseline = process.env.NOFRIES_SELECTION_BASELINE && JSON.parse(fs.readFileSync(process.env.NOFRIES_SELECTION_BASELINE));
const recordBaseline = process.env.NOFRIES_SELECTION_RECORD_BASELINE === '1';
assert.ok(!recordBaseline || process.env.NOFRIES_SELECTION_HOME_CSS, 'A RED baseline must name retained CSS');
assert.ok(!recordBaseline || !baseline, 'Do not relax candidate comparison checks');
const homeCss = process.env.NOFRIES_SELECTION_HOME_CSS ? fs.readFileSync(process.env.NOFRIES_SELECTION_HOME_CSS) : read('home.css');
const protectedFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'organisationPicture.js'];
const sourceFiles = ['home.css', 'style.css', 'app/dashboard.css', 'app/dashboard.html', 'index.html', 'js/dashboard-loader.js',
    'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'lib/signupDocument.js', 'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
    'api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    ...protectedFiles.map(file => 'api/shared/protectedAssets/' + file), 'scripts/tests/selection-wrapper-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha256(read(file))]));
const before = hashes();
const app = protectedFiles.map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const options = { customerLogin: true, customerTransport: 'auto', loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app, protectedStyleSource: read('app/dashboard.css').toString() };
const documents = { '/dashboard': buildDashboardDocument({ ...options, template: read('app/dashboard.html').toString() }),
    '/': buildGatewayDocument({ ...options, template: read('index.html').toString() }),
    '/signup': buildSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js').toString(),
        journeySource: read('api/shared/customerSignup/signupJourney.js').toString() }) };
const names = { normal: ['Synthetic Harbour Workshop', 'Synthetic Kauri Studio'], long: [
    'Synthetic regional organisation with offices and shared cloud services '.repeat(3).slice(0, 200),
    'SyntheticUnbrokenOrganisationName'.repeat(7).slice(0, 200)] };
const assets = Object.fromEntries(['style.css', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'images/nofrieslogo.png',
    'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js'].map(file => ['/' + file, file]));
const requests = [], blocked = [], errors = [], results = [], baselineFailures = [];
let state = 'selection', variant = 'normal';
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    let body, type = 'application/json';
    if (req.method !== 'GET') { blocked.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end(); }
    if (documents[pathname]) {
        body = documents[pathname].html; type = 'text/html'; res.setHeader('Content-Security-Policy', documents[pathname].contentSecurityPolicy);
    } else if (pathname === '/home.css') { body = homeCss; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') {
        res.statusCode = state === 'public' ? 401 : 200;
        body = JSON.stringify(state === 'public' ? { code: 'dashboard_session_required' } : { schemaVersion: 1, authenticated: true,
            purpose: 'operator_dashboard', generation: 'a'.repeat(64), selectedBindingId: null, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    } else if (pathname === '/api/dashboard/organisations') {
        body = JSON.stringify({ schemaVersion: 1, bindings: names[variant].map((organisationLabel, index) => ({
            bindingId: `10000000-0000-4000-8000-00000000000${index + 1}`, organisationLabel })), nextAfterBindingId: null });
    } else if (pathname === '/api/customer-signup/state') {
        body = JSON.stringify({ state: { status: 'terms', termsText: 'Synthetic layout agreement. No consent is submitted.',
            termsVersion: 'synthetic-v1', termsDigest: 'a'.repeat(64) }, csrfToken: 'c'.repeat(43) });
    } else if (assets[pathname]) {
        body = read(assets[pathname]); type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    }
    if (body === undefined) { blocked.push({ method: req.method, path: pathname }); res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', type); res.end(body);
});

async function visit(page, url) { await page.goto('about:blank'); await page.goto(url); }
async function measure(page, route, view, width, zoom = null) {
    let focus = null;
    if (view === 'normal' || view === 'long') {
        const target = page.locator('#dashboardChoices button').last();
        for (let i = 0; i < 24 && !await target.evaluate(node => node === document.activeElement); i++) await page.keyboard.press('Tab');
        focus = await target.evaluate(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return {
            reached: node === document.activeElement, outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), left: r.left, right: r.right }; });
        assert.ok(focus.reached && focus.outline === 'solid' && focus.outlineWidth >= 2, 'Chooser buttons must remain keyboard focusable');
    }
    const metric = await page.evaluate(() => {
        const box = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return {
            x: r.x, right: r.right, width: r.width, height: r.height, color: s.color, background: s.backgroundColor,
            borderRadius: s.borderRadius, fontSize: s.fontSize, overflowWrap: s.overflowWrap }; };
        const selector = document.querySelector('#dashboardEntry, .access-layout');
        return { innerWidth, outerWidth, devicePixelRatio, visualViewportScale: visualViewport.scale,
            scrollWidth: document.documentElement.scrollWidth, state: document.body.dataset.dashboardState,
            shell: box(selector), violations: window.selectionViolations,
            buttons: [...document.querySelectorAll('#dashboardChoices button')].map(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return { ...box(node), label: node.textContent, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
                    textRects: [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, width: r.width })) };
            }) };
    });
    const key = `${route === '/' ? 'gateway' : route.slice(1)}-${view}-${width}${zoom ? '-zoom200' : ''}`;
    const row = { route, view, width, zoom, focus, ...metric }; results.push(row);
    await page.screenshot({ path: path.join(artifacts, key + '.png'), fullPage: true });
    const problems = [];
    if (metric.scrollWidth > metric.innerWidth + 1) problems.push(`page overflow ${metric.scrollWidth}/${metric.innerWidth}`);
    for (const button of metric.buttons) {
        if (button.x < metric.shell.x - 1 || button.right > metric.shell.right + 1) problems.push('button outside chooser shell');
        if (button.scrollWidth > button.clientWidth + 1) problems.push('text exceeds button scroll box');
        if (button.textRects.some(r => r.left < button.x - 1 || r.right > button.right + 1)) problems.push('text paints outside button');
    }
    if (recordBaseline && view === 'long') baselineFailures.push(...problems.map(problem => key + ': ' + problem));
    else assert.deepEqual(problems, [], key);
    assert.deepEqual(metric.violations, [], key + ': CSP');
    if (metric.buttons.length) assert.deepEqual(metric.buttons.map(button => button.label), names[view], key + ': full labels retained');
    if (focus) assert.ok(focus.left >= -1 && focus.right <= metric.innerWidth + 1, key + ': focused button outside viewport');
    if (zoom) {
        assert.equal(metric.outerWidth, 1440); assert.equal(metric.innerWidth, 720);
        assert.equal(metric.devicePixelRatio, 2); assert.equal(metric.visualViewportScale, 1);
    }
    if (baseline) {
        const old = baseline.results.find(item => item.route === route && item.view === view && item.width === width && item.zoom === zoom);
        assert.ok(old, key + ': baseline observation missing');
        for (const field of ['x', 'width']) assert.ok(Math.abs(old.shell[field] - metric.shell[field]) <= 1, key + ': shell changed');
        for (let i = 0; i < metric.buttons.length; i++) {
            const fields = ['color', 'background', 'borderRadius', 'fontSize'];
            if (view === 'normal') fields.push('x', 'width', 'height');
            for (const field of fields) assert.equal(metric.buttons[i][field], old.buttons[i][field], key + ': unchanged button ' + field);
        }
    }
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser, zoomContext, zoomProfile, failure = null;
    try {
        async function configure(context) {
            await context.addInitScript(() => { window.selectionViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.selectionViolations.push(event.effectiveDirective)); });
            await context.route('**/*', route => {
                const req = route.request();
                if (new URL(req.url()).origin !== base || req.method() !== 'GET') {
                    blocked.push({ method: req.method(), path: new URL(req.url()).pathname, external: true }); return route.abort();
                }
                return route.continue();
            });
            const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); return page;
        }
        async function selections(page, route, width, zoom = null) {
            for (variant of ['normal', 'long']) {
                state = 'selection'; await visit(page, base + route);
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
                await measure(page, route, variant, width, zoom);
            }
        }
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        const page = await configure(await browser.newContext());
        for (const width of widths) {
            await page.setViewportSize({ width, height: 1000 });
            for (const route of routes) await selections(page, route, width);
            state = 'public'; await visit(page, base + '/');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated'); await measure(page, '/', 'public', width);
            await visit(page, base + '/signup'); await page.getByRole('checkbox').waitFor(); await measure(page, '/signup', 'signup', width);
        }
        await page.goto('about:blank');
        zoomProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-selection-zoom-')); fs.mkdirSync(path.join(zoomProfile, 'Default'));
        fs.writeFileSync(path.join(zoomProfile, 'Default/Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
        zoomContext = await chromium.launchPersistentContext(zoomProfile, { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, viewport: null, args: ['--no-sandbox', '--window-size=1440,1000'] });
        const zoomPage = await configure(zoomContext);
        for (const route of routes) await selections(zoomPage, route, 1440, 'native-200%');
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before, 'Source changed during verification');
        console.log(JSON.stringify({ passed: baselineFailures.length === 0, completed: true, observations: results.length,
            baselineFailures: baselineFailures.length, browser: browser.version(), artifacts }));
        if (baselineFailures.length) process.exitCode = 1;
    } catch (error) { failure = error.stack; throw error; }
    finally {
        try { fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null && baselineFailures.length === 0,
            completed: failure === null, failure, recordBaseline, baselineFailures, syntheticOnly: true,
            scope: 'Synthetic loopback rendering only; no sign-in, consent, selection mutation, production or customer acceptance.',
            widths, routes, results, blocked, errors, requests, browser: browser && browser.version(), homeCssSha256: sha256(homeCss),
            homeCssOverride: process.env.NOFRIES_SELECTION_HOME_CSS || null, sourceHashesBefore: before, sourceHashesAfter: hashes() }, null, 2), { mode: 0o600 }); }
        finally { if (zoomContext) await zoomContext.close(); if (zoomProfile) fs.rmSync(zoomProfile, { recursive: true, force: true });
            if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
