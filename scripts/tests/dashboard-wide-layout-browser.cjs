'use strict';

// Optional actual-Chromium layout acceptance using installed Playwright only.
// node scripts/tests/dashboard-wide-layout-browser.cjs
// NOFRIES_EXPECT_WIDE_LAYOUT=1 also checks the intended >1220px widening.
// NOFRIES_WIDE_LAYOUT_ARTIFACTS selects an external artifact directory.
// NOFRIES_WIDE_LAYOUT_BASELINE points to an earlier results.json for geometry
// comparisons. NOFRIES_WIDE_LAYOUT_CSS selects retained CSS for a RED control.
// All requests are synthetic, loopback GETs. No sign-in, consent or mutations.
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
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const widths = [320, 390, 768, 1024, 1220, 1280, 1440, 1920, 2560];
const routes = ['/dashboard', '/'];
const expectedWide = process.env.NOFRIES_EXPECT_WIDE_LAYOUT === '1';
const artifacts = path.resolve(process.env.NOFRIES_WIDE_LAYOUT_ARTIFACTS ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-dashboard-wide-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep artifacts outside the repository');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const baseline = process.env.NOFRIES_WIDE_LAYOUT_BASELINE && JSON.parse(fs.readFileSync(process.env.NOFRIES_WIDE_LAYOUT_BASELINE));
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'organisationPicture.js'];
const sourceFiles = ['app/dashboard.css', 'app/dashboard.html', 'index.html', 'style.css', 'home.css',
    'js/dashboard-loader.js', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'lib/signupDocument.js',
    'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
    'api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file), 'scripts/tests/dashboard-wide-layout-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha256(read(file))]));
const before = hashes();
const cssOverride = process.env.NOFRIES_WIDE_LAYOUT_CSS || process.env.NOFRIES_DASHBOARD_TEST_CSS;
const css = cssOverride ? fs.readFileSync(cssOverride) : read('app/dashboard.css');
const app = Buffer.from(bundleFiles.map(file => read('api/shared/protectedAssets/' + file)).join('\n'));
const options = { customerLogin: true, customerTransport: 'auto', loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app.toString(), protectedStyleSource: css.toString() };
const dashboard = buildDashboardDocument({ ...options, template: read('app/dashboard.html').toString() });
const gateway = buildGatewayDocument({ ...options, template: read('index.html').toString() });
const signup = buildSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js').toString(),
    journeySource: read('api/shared/customerSignup/signupJourney.js').toString() });
assert.equal(dashboard.appIntegrity, gateway.appIntegrity);
assert.equal(dashboard.styleIntegrity, gateway.styleIntegrity);
const fixtures = buildFixtures();
const model = fixtures.tenants[0].model;
const spacedName = 'Synthetic organisation with a deliberately long name for regional offices and shared cloud services '.repeat(2).slice(0, 200);
const unbrokenName = 'SyntheticUnbrokenOrganisationName'.repeat(7).slice(0, 200);
model.context.displayName = spacedName;
const binding = '10000000-0000-4000-8000-000000000001';
const bindings = [spacedName, unbrokenName].map((organisationLabel, index) => ({
    bindingId: index ? '10000000-0000-4000-8000-000000000002' : binding, organisationLabel }));
const summaries = fixtures.tenants[0].assessments.map(item => Object.fromEntries([
    'assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress'
].map(key => [key, item[key]])));
const moduleModel = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
    module: model.modules.find(item => item.key === 'cyber_security'), summary: model.summary, services: model.services,
    admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
const assets = Object.fromEntries(['style.css', 'home.css', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
    'images/nofrieslogo.png', 'js/organisation-setup.js', 'js/home.js', 'js/prospect-assistant.js'].map(file => ['/' + file, file]));
const requests = [], blocked = [], errors = [], knownBaselineGaps = [], results = [];
let state = 'ready', selectionUnbrokenProbe = false;
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    let body, type = 'application/json';
    if (req.method !== 'GET') { blocked.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end(); }
    if (routes.includes(pathname) || pathname === '/signup') {
        const document = pathname === '/' ? gateway : pathname === '/signup' ? signup : dashboard;
        body = document.html; type = 'text/html'; res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') {
        res.statusCode = state === 'public' ? 401 : 200;
        body = JSON.stringify(state === 'public' ? { code: 'dashboard_session_required' } : {
            schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', generation: 'a'.repeat(64),
            selectedBindingId: state === 'selection' ? null : binding, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    } else if (pathname === '/api/dashboard/organisations') {
        const available = state === 'selection' && !selectionUnbrokenProbe ? bindings.map((item, index) => index ? {
            ...item, organisationLabel: 'Synthetic second organisation with regional offices and cloud services '.repeat(3).slice(0, 200) } : item) : bindings;
        body = JSON.stringify({ schemaVersion: 1, bindings: available, nextAfterBindingId: null });
    }
    else if (pathname === '/api/dashboard/bootstrap') { body = JSON.stringify(model); }
    else if (pathname === '/api/dashboard/modules/cyber_security') { body = JSON.stringify(moduleModel); }
    else if (pathname === '/api/dashboard/ncsc/assessments') { body = JSON.stringify({ schemaVersion: 1, assessments: summaries, nextAfterAssessmentId: null }); }
    else if (pathname.startsWith('/api/dashboard/ncsc/assessments/')) {
        const detail = fixtures.tenants[0].assessments.find(item => pathname.endsWith('/' + item.assessmentId));
        if (detail) body = JSON.stringify({ schemaVersion: 1, assessment: detail });
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

async function geometry(page, route, view, width, extra = {}) {
    const metric = await page.evaluate(() => {
        const bounds = selector => {
            const node = document.querySelector(selector);
            if (!node || !node.getClientRects().length) return null;
            const r = node.getBoundingClientRect(), s = getComputedStyle(node);
            return { x: r.x, width: r.width, right: r.right, maxWidth: s.maxWidth,
                color: s.color, background: s.backgroundColor, borderRadius: s.borderRadius, fontSize: s.fontSize };
        };
        const visible = node => node.getClientRects().length > 0;
        return { innerWidth, scrollWidth: document.documentElement.scrollWidth,
            entry: bounds('#dashboardEntry'), header: bounds('.site-header'), layout: bounds('.dashboard-layout'),
            main: bounds('.dashboard-main'), rail: bounds('.dashboard-rail'), questionnaire: bounds('.ncsc-questionnaire'),
            chooser: bounds('#dashboardChooser'), signup: bounds('#signup'), access: bounds('.access-layout'),
            dialog: bounds('dialog[open]'), state: document.body.dataset.dashboardState,
            overflowingControls: [...document.querySelectorAll('textarea, select, input:not([type="radio"]):not([type="checkbox"]), #dashboardChoices button')]
                .filter(visible).filter(node => { const r = node.getBoundingClientRect(); return r.width > innerWidth || r.right > innerWidth + 1 || r.left < -1; })
                .map(node => node.tagName + '#' + node.id),
            styleViolations: window.layoutViolations };
    });
    const label = `${route === '/' ? 'gateway' : route.slice(1)}-${view}-${width}${extra.zoom ? '-zoom200' : ''}`;
    const result = { route, view, width, ...extra, ...metric }; results.push(result);
    await page.screenshot({ path: path.join(artifacts, label + '.png'), fullPage: true });
    const overflowMessage = `${label}: horizontal overflow ${metric.scrollWidth}/${metric.innerWidth}`;
    if (extra.knownBaselineGap) {
        assert.equal(metric.state, 'selection', 'Only the pre-existing initial chooser gap is diagnostic');
        knownBaselineGaps.push({ route, width, issue: extra.knownBaselineGap, scrollWidth: metric.scrollWidth,
            viewport: metric.innerWidth, overflowing: metric.scrollWidth > metric.innerWidth + 1 });
    }
    else assert.ok(metric.scrollWidth <= metric.innerWidth + 1, overflowMessage);
    assert.deepEqual(metric.overflowingControls, [], `${label}: controls exceed viewport`);
    assert.deepEqual(metric.styleViolations, [], `${label}: CSP violations`);
    if (metric.main) assert.ok(metric.main.width <= 1441, `${label}: main exceeds 90rem`);
    if (metric.questionnaire) assert.ok(metric.questionnaire.width <= 929, `${label}: questionnaire exceeds 58rem`);
    if (metric.entry) {
        assert.ok(metric.entry.x >= -1 && metric.entry.right <= metric.innerWidth + 1, `${label}: shell outside viewport`);
        if (metric.state !== 'ready' || width <= 1220 || extra.zoom || extra.media === 'print') {
            assert.ok(metric.entry.width <= 1181, `${label}: existing shell cap must be retained`);
        } else if (expectedWide) {
            assert.ok(metric.entry.width > 1180, `${label}: wide ready shell must expand`);
            assert.ok(metric.entry.width <= 1729, `${label}: ready shell exceeds 108rem`);
            assert.ok(metric.entry.x >= 20, `${label}: retain outer gutters`);
        }
        if (metric.header) {
            assert.ok(Math.abs(metric.header.x - metric.entry.x) <= 1 && Math.abs(metric.header.width - metric.entry.width) <= 1,
                `${label}: header and entry shells must align`);
        }
    }
    if (baseline && !extra.zoom) {
        const old = baseline.results.find(item => item.route === route && item.view === view && item.width === width && !item.zoom && item.media === extra.media);
        assert.ok(old, `${label}: baseline observation missing`);
        if (extra.knownBaselineGap) assert.equal(metric.scrollWidth, old.scrollWidth, `${label}: known initial selection overflow changed`);
        if (metric.state !== 'ready' || width <= 1220 || extra.media === 'print') {
            for (const key of ['entry', 'header', 'main', 'questionnaire', 'chooser', 'signup', 'access', 'dialog']) {
                if (metric[key] && old[key]) for (const dimension of ['x', 'width']) {
                    assert.ok(Math.abs(metric[key][dimension] - old[key][dimension]) <= 1, `${label}: ${key}.${dimension} changed`);
                }
            }
        }
        for (const key of ['layout', 'main', 'rail', 'questionnaire']) if (metric[key] && old[key]) {
            for (const style of ['color', 'background', 'borderRadius', 'fontSize']) assert.equal(metric[key][style], old[key][style], `${label}: ${key}.${style} changed`);
        }
    }
    return result;
}

async function visit(page, url) {
    // Same-document fragment navigation would keep the previously open child
    // view. Start a fresh real document for each independent fixture scenario.
    await page.goto('about:blank'); await page.goto(url);
}
async function ready(page, base, route, hash = '#overview') {
    state = 'ready'; await visit(page, base + route + hash);
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    await page.locator('.dashboard-main').waitFor();
}
async function keyboardSkip(page) {
    // Real sequential keyboard traversal also confirms that the skip link is
    // reachable from the heading focused by the loader or the gateway document.
    let reached = false;
    for (let i = 0; i < 80; i++) {
        if (await page.locator('#dashboardSkipLink').evaluate(node => node === document.activeElement)) { reached = true; break; }
        await page.keyboard.press('Shift+Tab');
    }
    assert.ok(reached, 'Dashboard skip link must be keyboard reachable');
    await page.waitForFunction(() => !document.getElementById('dashboardApp').inert);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dashboard-content');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
        const node = document.activeElement, s = getComputedStyle(node), r = node.getBoundingClientRect();
        return { tag: node.tagName, outline: s.outlineStyle, width: s.outlineWidth, visible: r.width > 0 && r.height > 0,
            left: r.left, right: r.right, viewport: innerWidth };
    });
    assert.ok(focused.visible && focused.left >= -1 && focused.right <= focused.viewport + 1, 'Keyboard target must be within viewport');
    assert.equal(focused.outline, 'solid'); assert.ok(parseFloat(focused.width) >= 2);
    return focused;
}
async function questionnaire(page, base, route, submitted = false) {
    await ready(page, base, route, '#cyber-security');
    const button = page.locator('.ncsc-assessment-list button').filter({ hasText: submitted ? 'submitted' : 'in-progress' }).first();
    await button.click(); await page.locator(submitted ? '.ncsc-result-metrics' : '.ncsc-question-index').waitFor();
}
async function overview(page, base, route) {
    await ready(page, base, route);
    await page.locator('.picture-toolbar select').selectOption('assessment-submitted');
    await page.locator('.picture-metrics').waitFor();
}
async function readyChooser(page) {
    const chooser = page.locator('#dashboardChooser');
    if (await chooser.evaluate(node => node.tagName === 'DETAILS')) await page.locator('#dashboardChooserHeading').click();
    await page.locator('#dashboardChoices button').last().waitFor();
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser, zoomContext, zoomProfile, failure = null;
    try {
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        async function configure(context) {
            await context.addInitScript(() => {
                window.layoutViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.layoutViolations.push(event.effectiveDirective));
            });
            await context.route('**/*', route => {
                const req = route.request();
                if (new URL(req.url()).origin !== base || req.method() !== 'GET') {
                    blocked.push({ method: req.method(), path: new URL(req.url()).pathname, external: true }); return route.abort();
                }
                return route.continue();
            });
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            page.on('pageerror', error => errors.push(error.message));
            return page;
        }
        const page = await configure(await browser.newContext());
        for (const width of widths) {
            await page.setViewportSize({ width, height: 1000 });
            for (const route of routes) {
                await overview(page, base, route);
                const focus = await keyboardSkip(page);
                await geometry(page, route, 'overview', width, { keyboardFocus: focus });
                model.context.displayName = unbrokenName;
                await overview(page, base, route); await geometry(page, route, 'overview-unbroken', width);
                model.context.displayName = spacedName;
                await readyChooser(page); await geometry(page, route, 'ready-chooser', width);
                await questionnaire(page, base, route); await geometry(page, route, 'questionnaire', width);
                // Make only an unsent local draft, then inspect the real leave
                // dialog. Stay here returns to the draft without any API write.
                await page.locator('input[value="yes"]').check();
                await page.getByRole('button', { name: 'Back to assessments', exact: true }).click();
                await page.locator('.ncsc-leave-dialog[open]').waitFor();
                await geometry(page, route, 'leave-dialog', width);
                await page.getByRole('button', { name: 'Stay here', exact: true }).click();
                await page.getByRole('button', { name: 'Back to assessments', exact: true }).click();
                await page.getByRole('button', { name: 'Discard unsent changes', exact: true }).click();
                await questionnaire(page, base, route, true); await geometry(page, route, 'results', width);
                state = 'selection'; await visit(page, base + route);
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
                await geometry(page, route, 'selection', width);
            }
            state = 'public'; await visit(page, base + '/');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated');
            await geometry(page, '/', 'public-home', width);
            await page.getByRole('button', { name: 'Managed IT', exact: true }).click();
            await page.locator('#service-dialog[open]').waitFor();
            await geometry(page, '/', 'public-dialog', width); await page.keyboard.press('Escape');
            assert.equal(await page.locator('#service-dialog').evaluate(node => node.open), false);
            await visit(page, base + '/signup'); await page.getByRole('checkbox').waitFor();
            await geometry(page, '/signup', 'signup', width);
            // Keep this unchanged source defect visible, outside the strict
            // ready-layout acceptance matrix. A valid unbroken label overflows
            // initial selection; the ready chooser already wraps that label.
            for (const route of routes) {
                state = 'selection'; selectionUnbrokenProbe = true;
                await visit(page, base + route);
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
                await geometry(page, route, 'selection-unbroken', width, { knownBaselineGap: 'Initial chooser does not wrap unbroken organisation labels' });
                selectionUnbrokenProbe = false;
            }
        }
        // Chromium's native persisted zoom level, with a real 1440px window and
        // no emulated viewport. Assert DPR2 and 720 CSS pixels below, which also
        // distinguishes browser zoom from pinch zoom (visualViewport.scale1).
        zoomProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-layout-zoom-'));
        fs.mkdirSync(path.join(zoomProfile, 'Default'));
        fs.writeFileSync(path.join(zoomProfile, 'Default/Preferences'), JSON.stringify({
            partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
        zoomContext = await chromium.launchPersistentContext(zoomProfile, { headless: true, viewport: null,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--window-size=1440,1000'] });
        const zoomPage = await configure(zoomContext);
        for (const route of routes) {
            await overview(zoomPage, base, route);
            const zoom = await zoomPage.evaluate(() => ({ zoom: 'native-200%', outerWidth, cssViewport: innerWidth,
                devicePixelRatio, visualViewportScale: visualViewport.scale }));
            assert.equal(zoom.outerWidth, 1440); assert.equal(zoom.cssViewport, 720);
            assert.equal(zoom.devicePixelRatio, 2); assert.equal(zoom.visualViewportScale, 1);
            await geometry(zoomPage, route, 'overview', 1440, { ...zoom, keyboardFocus: await keyboardSkip(zoomPage) });
            await readyChooser(zoomPage); await geometry(zoomPage, route, 'ready-chooser', 1440, zoom);
            await questionnaire(zoomPage, base, route); await geometry(zoomPage, route, 'questionnaire', 1440, zoom);
            await questionnaire(zoomPage, base, route, true); await geometry(zoomPage, route, 'results', 1440, zoom);
            state = 'selection'; await visit(zoomPage, base + route);
            await zoomPage.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
            await geometry(zoomPage, route, 'selection', 1440, zoom);
        }
        await zoomContext.close(); zoomContext = null;
        for (const route of routes) {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await questionnaire(page, base, route);
            await page.emulateMedia({ media: 'print' });
            await geometry(page, route, 'questionnaire-print', 1440, { media: 'print' });
            await page.pdf({ path: path.join(artifacts, `${route === '/' ? 'gateway' : 'dashboard'}-questionnaire-print.pdf`), format: 'A4', printBackground: true });
            await page.emulateMedia({ media: 'screen' });
            await questionnaire(page, base, route, true);
            await page.emulateMedia({ media: 'print' });
            await geometry(page, route, 'results-print', 1440, { media: 'print' });
            await page.pdf({ path: path.join(artifacts, `${route === '/' ? 'gateway' : 'dashboard'}-results-print.pdf`), format: 'A4', printBackground: true });
            await page.emulateMedia({ media: 'screen' });
        }
        assert.deepEqual(blocked, [], 'Unexpected network or mutation request');
        assert.deepEqual(errors, [], 'Browser page errors');
        assert.deepEqual(hashes(), before, 'Sources changed during browser verification; rerun on a frozen candidate');
        console.log(JSON.stringify({ passed: true, completed: true, knownBaselineGaps: knownBaselineGaps.length,
            expectedWide, browser: browser.version(), observations: results.length, artifacts }));
    } catch (error) { failure = error.stack; throw error; }
    finally {
        try {
            fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null,
                completed: failure === null, failure, knownBaselineGaps,
                expectedWide, browser: browser && browser.version(), widths, routes, syntheticOnly: true,
                scope: 'Rendered synthetic loopback GETs only; no customer acceptance, authentication/isolation proof or deployment.',
                zoom: 'Native Chromium persisted 200% zoom; 1440px outer window,720 CSS viewport,DPR2,visualViewport.scale1 asserted.',
                results, blocked, errors, requests, sourceHashesBefore: before, sourceHashesAfter: hashes(),
                cssOverride: cssOverride || null, cssSha256: sha256(css), appSha256: sha256(app), appIntegrity: dashboard.appIntegrity, styleIntegrity: dashboard.styleIntegrity }, null, 2), { mode: 0o600 });
        } finally {
            if (zoomContext) await zoomContext.close();
            if (zoomProfile) fs.rmSync(zoomProfile, { recursive: true, force: true });
            if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        }
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
