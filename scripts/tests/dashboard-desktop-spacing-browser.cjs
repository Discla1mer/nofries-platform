'use strict';

// Optional served-source Chromium witness; uses installed Playwright only.
// NOFRIES_DESKTOP_ARTIFACTS: external output directory.
// NOFRIES_DESKTOP_CSS: immutable CSS baseline override; default is actual source.
// NOFRIES_DESKTOP_BASELINE: prior results.json for parity and width comparisons.
// NOFRIES_DESKTOP_EXPECT=1: enforce phase1 desktop geometry.
// NOFRIES_DESKTOP_NARROW_FOCUS_PROBE=1: ordinary-text320px native-focus
// regression on both entry documents, using unchanged focus assertions.
// NOFRIES_DESKTOP_CONTROL=1 with immutable base CSS records the diagnosed
// inherited long-menu text200 bottom-ring failure; never enabled for candidate.
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
const widths = [320, 390, 1220, 1280, 1440, 1600, 1920];
const routes = ['/dashboard', '/'];
const expectedWide = process.env.NOFRIES_DESKTOP_EXPECT === '1';
const artifacts = path.resolve(process.env.NOFRIES_DESKTOP_ARTIFACTS ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-desktop-spacing-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep artifacts outside the repository');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const baseline = process.env.NOFRIES_DESKTOP_BASELINE && JSON.parse(fs.readFileSync(process.env.NOFRIES_DESKTOP_BASELINE));
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const sourceFiles = ['app/dashboard.css', 'app/dashboard.html', 'index.html', 'style.css', 'home.css',
    'js/dashboard-loader.js', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'lib/signupDocument.js',
    'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
    'api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file), 'scripts/tests/dashboard-desktop-spacing-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha256(read(file))]));
const before = hashes();
const cssOverride = process.env.NOFRIES_DESKTOP_CSS || process.env.NOFRIES_DASHBOARD_TEST_CSS;
const baseCss = cssOverride ? fs.readFileSync(cssOverride) : read('app/dashboard.css');
const reportTail = process.env.NOFRIES_DESKTOP_REPORT_TAIL ? fs.readFileSync(process.env.NOFRIES_DESKTOP_REPORT_TAIL) : Buffer.alloc(0);
if (reportTail.length) {
    assert.equal(reportTail.length, 647); assert.equal(sha256(reportTail), 'f3079b137c497572cf91d21eb5641a85c53c16842ed62e730f6fc321f228fcaf');
}
const css = Buffer.concat([baseCss, reportTail]);
const guardsOnly = process.env.NOFRIES_DESKTOP_GUARDS_ONLY === '1';
const focusProbe = process.env.NOFRIES_DESKTOP_FOCUS_PROBE === '1';
const narrowFocusProbe = process.env.NOFRIES_DESKTOP_NARROW_FOCUS_PROBE === '1';
const supplementOnly = process.env.NOFRIES_DESKTOP_SUPPLEMENT_ONLY === '1';
const baselineControl = process.env.NOFRIES_DESKTOP_CONTROL === '1';
assert.ok(!baselineControl || (cssOverride && !expectedWide), 'Known-failure control requires explicit immutable base CSS and no candidate expectations');
const fullMode = !guardsOnly && !focusProbe && !narrowFocusProbe && !supplementOnly;
assert.ok(!narrowFocusProbe || (!focusProbe && !guardsOnly && !supplementOnly && !baselineControl && !baseline && !process.env.NOFRIES_DESKTOP_CONTROL_RESUME), 'Narrow native-focus regression runs independently without baseline gaps or resumed observations');
const caseId = (route, view, width, extra = {}) => `${route === '/' ? 'gateway' : route.slice(1)}-${view}-${width}${extra.text200 ? '-text200' : ''}${extra.zoom ? '-zoom200' : ''}`;
const expectedInventory = [];
function inventory(route, view, width, extra) { expectedInventory.push(caseId(route, view, width, extra)); }
for (const width of widths) {
    for (const route of routes) for (const view of ['overview', 'overview-unbroken', 'ready-chooser', 'questionnaire', 'results', 'services', 'selection', 'loading']) inventory(route, view, width);
    inventory('/', 'public', width); inventory('/signup', 'signup', width);
}
for (const width of [320, 390, 1280, 1440, 1920]) for (const route of routes) for (const view of ['overview', 'overview-long-menu', 'questionnaire', 'guard-organisation', 'guard-signout', 'guard-public-link']) inventory(route, view, width, { text200: true });
for (const route of routes) inventory(route, 'questionnaire-print', 1440);
for (const width of [320, 390, 1280, 1440, 1920]) for (const route of routes) for (const view of ['guard-organisation', 'guard-signout', 'guard-public-link']) inventory(route, view, width);
for (const route of routes) for (const view of ['overview', 'questionnaire', 'guard-organisation', 'guard-signout', 'guard-public-link']) inventory(route, view, 1440, { zoom: true });
if (baseline) {
    assert.equal(baseline.completed, true, 'Baseline must be terminal and completed, including any honestly retained known-failure control');
    assert.equal(baseline.mode, 'full', 'Full candidate parity requires a full baseline, not a probe or supplemental run');
    assert.equal(new Set(baseline.results.map(row => row.id)).size, baseline.results.length, 'Baseline IDs are unique');
    assert.deepEqual(baseline.results.map(row => row.id).sort(), expectedInventory.slice().sort(), 'Baseline exact case inventory');
    assert.equal(baseline.baseCssSha256, '49e1d2aeda552738fb9ae03cc8d37e827f1f6f85b5a68655de930e3a5a93d050', 'Baseline CSS is immutable qualified PR590 source');
    const runtimeHashes = values => Object.fromEntries(Object.entries(values).filter(([file]) => !['app/dashboard.css', 'scripts/tests/dashboard-desktop-spacing-browser.cjs'].includes(file)));
    assert.deepEqual(runtimeHashes(baseline.sourceHashesBefore), runtimeHashes(before), 'Baseline runtime/doc/public styles match candidate');
}
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
let state = 'ready', selectionUnbrokenProbe = true, textScale = false;
const pendingSessions = new Set();
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
        if (state === 'loading') { pendingSessions.add(res); res.on('close', () => pendingSessions.delete(res)); return; }
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
        body = read(assets[pathname]);
        if (pathname === '/style.css' && textScale) body = Buffer.concat([body, Buffer.from('\nhtml { font-size: 200%; }\n')]);
        type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    }
    if (body === undefined) { blocked.push({ method: req.method, path: pathname }); res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', type); res.end(body);
});

const guards = [], focusWitnesses = [];
const resumePath = process.env.NOFRIES_DESKTOP_CONTROL_RESUME;
const resume = resumePath && JSON.parse(fs.readFileSync(resumePath));
if (resume) {
    assert.ok(baselineControl && fullMode && !baseline, 'Resume is only an explicit immutable baseline control');
    assert.equal(resume.mode, 'full'); assert.equal(resume.completed, false);
    assert.match(resume.failure, /Full vertical keyboard ring fits/);
    assert.equal(resume.baseCssSha256, sha256(baseCss)); assert.equal(resume.appSha256, sha256(app));
    for (const [file, hash] of Object.entries(before)) if (!['app/dashboard.css', 'scripts/tests/dashboard-desktop-spacing-browser.cjs'].includes(file)) {
        assert.equal(resume.sourceHashesBefore[file], hash, 'Resumed immutable runtime ' + file);
        assert.equal(resume.sourceHashesAfter[file], hash, 'Resumed original run source stability ' + file);
    }
    assert.equal(new Set(resume.results.map(row => row.id)).size, resume.results.length);
    for (const row of resume.results) assert.ok(expectedInventory.includes(row.id), 'Resumed observation belongs to exact inventory');
    results.push(...resume.results); guards.push(...resume.guards); knownBaselineGaps.push(...resume.knownBaselineGaps);
    // The fatal target remains in the immutable original receipt; rerun that
    // target under the explicit diagnosed control, preserving50 unique focus cases.
    focusWitnesses.push(...resume.focusWitnesses.slice(0, -1));
}
const hasCase = (route, view, width, extra) => results.some(row => row.id === caseId(route, view, width, extra));
function sourceAndNetworkChecks() {
    assert.deepEqual(blocked, [], 'No unexpected or non-GET requests'); assert.deepEqual(errors, [], 'No browser page errors');
    const after = hashes(), expected = { ...before };
    if (cssOverride) { delete after['app/dashboard.css']; delete expected['app/dashboard.css']; }
    assert.deepEqual(after, expected, 'Served runtime/test sources remained frozen');
}
const closeTo = (a, b, message) => assert.ok(Math.abs(a - b) <= 1, message + ` (${a}/${b})`);
async function settle(page) {
    await page.evaluate(() => new Promise((resolve, reject) => {
        let previous = null, stable = 0, frames = 0;
        const tick = () => {
            const r = document.activeElement.getBoundingClientRect();
            const value = [scrollX, scrollY, r.x, r.y, r.width, r.height].join(':');
            stable = previous === value ? stable + 1 : 0; previous = value;
            if (++frames > 180) return reject(new Error('Native scroll did not settle'));
            if (stable >= 8) return resolve(); requestAnimationFrame(tick);
        }; requestAnimationFrame(tick);
    }));
}
async function geometry(page, route, view, width, extra = {}) {
    await settle(page);
    const metric = await page.evaluate(() => {
        const bounds = selector => {
            const node = document.querySelector(selector);
            if (!node || !node.getClientRects().length) return null;
            const r = node.getBoundingClientRect(), s = getComputedStyle(node);
            return { x: r.x, y: r.y, width: r.width, right: r.right, height: r.height,
                paddingLeft: parseFloat(s.paddingLeft), paddingRight: parseFloat(s.paddingRight),
                fontSize: parseFloat(s.fontSize), maxWidth: s.maxWidth, display: s.display, position: s.position };
        };
        const visible = node => node.getClientRects().length > 0;
        const main = bounds('.dashboard-main');
        const paragraphs = [...document.querySelectorAll('.dashboard-main p')].filter(visible).map(node => {
            const s = getComputedStyle(node), r = node.getBoundingClientRect();
            // A zero-width measurement span uses the paragraph's actual font.
            const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
            ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
            return { className: node.className, width: r.width, characters: r.width / ctx.measureText('0').width,
                maxWidth: s.maxWidth, textLength: node.textContent.length };
        });
        return { innerWidth, scrollWidth: document.documentElement.scrollWidth, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
            state: document.body.dataset.dashboardState,
            entry: bounds('#dashboardEntry'), header: bounds('.site-header'), layout: bounds('.dashboard-layout'), main,
            workspaceInner: main && main.width - main.paddingLeft - main.paddingRight,
            rail: bounds('.dashboard-rail'), topbar: bounds('.dashboard-topbar'),
            heading: bounds('.dashboard-page-heading'), metrics: bounds('.picture-metrics'),
            moduleCards: bounds('.dashboard-module-cards'), serviceCards: bounds('.dashboard-service-cards'),
            questionnaire: bounds('.ncsc-questionnaire'), textarea: bounds('.ncsc-questionnaire textarea'),
            chooser: bounds('#dashboardChooser'), signup: bounds('#signup'), dialog: bounds('dialog[open]'),
            mobileNav: bounds('.dashboard-mobile-nav'), paragraphs,
            nav: [...document.querySelectorAll('.dashboard-rail [data-module]')].map(node => ({
                module: node.dataset.module, label: node.textContent, current: node.getAttribute('aria-current'),
                x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width,
                height: node.getBoundingClientRect().height })),
            overflowingControls: [...document.querySelectorAll('textarea, select, input:not([type="radio"]):not([type="checkbox"]), #dashboardChoices button')]
                .filter(visible).filter(node => { const r = node.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; })
                .map(node => node.tagName + '#' + node.id),
            violations: window.desktopViolations };
    });
    const id = caseId(route, view, width, extra);
    const result = { id, route, view, width, ...extra, ...metric }; results.push(result);
    await page.screenshot({ path: path.join(artifacts, id + '.png'), fullPage: true });
    assert.ok(metric.scrollWidth <= metric.innerWidth + 1, `${id}: page overflow ${metric.scrollWidth}/${metric.innerWidth}`);
    assert.deepEqual(metric.overflowingControls, [], `${id}: control outside viewport`);
    assert.deepEqual(metric.violations, [], `${id}: CSP violation`);
    if (metric.header && metric.entry) {
        closeTo(metric.header.x, metric.entry.x, id + ': header/entry left');
        closeTo(metric.header.width, metric.entry.width, id + ': header/entry width');
    }
    if (metric.questionnaire) assert.ok(metric.questionnaire.width <= metric.rootFont * 58 + 1, id + ': editor remains <=58rem');
    if (metric.textarea) assert.ok(metric.textarea.width <= metric.questionnaire.width + 1, id + ': textarea stays within editor');
    const desktopReady = metric.state === 'ready' && metric.innerWidth >= 1220 && extra.media !== 'print';
    if (expectedWide && desktopReady) {
        closeTo(metric.entry.width, metric.innerWidth, id + ': fluid shell');
        closeTo(metric.rail.width, metric.rootFont * 14.5, id + ': labelled sidebar retained');
        closeTo(metric.main.x, metric.rail.right, id + ': main begins at sidebar edge');
        closeTo(metric.topbar.x, metric.main.x, id + ': topbar/main edge');
        closeTo(metric.topbar.paddingLeft, metric.main.paddingLeft, id + ': topbar/main content alignment');
        const padding = metric.innerWidth >= 1600 ? 32 : 24;
        closeTo(metric.main.paddingLeft, padding, id + ': main left gutter');
        closeTo(metric.main.paddingRight, padding, id + ': main right gutter');
        closeTo(metric.workspaceInner, metric.innerWidth - metric.rail.width - padding * 2, id + ': available width');
        for (const p of metric.paragraphs.filter(p => p.textLength > 80)) assert.ok(p.characters <= 75.2, id + ': readable paragraph width ' + p.characters);
    }
    if (baseline) {
        const old = baseline.results.find(item => item.id === id);
        assert.ok(old, id + ': baseline observation exists');
        if (!desktopReady) for (const key of ['entry', 'header', 'main', 'rail', 'questionnaire', 'textarea', 'chooser', 'signup', 'dialog', 'mobileNav']) {
            if (metric[key] || old[key]) {
                assert.ok(metric[key] && old[key], id + ': parity visibility ' + key);
                for (const dimension of ['x', 'width', 'height']) closeTo(metric[key][dimension], old[key][dimension], id + ': parity ' + key + '.' + dimension);
            }
        }
        if (desktopReady && !extra.text200 && ['overview', 'overview-unbroken', 'services'].includes(view)) {
            assert.ok(metric.workspaceInner > old.workspaceInner + 50, id + ': increased usable workspace');
            if (metric.metrics && old.metrics) assert.ok(metric.metrics.width > old.metrics.width + 50, id + ': data uses wider space');
        }
        assert.deepEqual(metric.nav.map(n => n.module), old.nav.map(n => n.module), id + ': module order/capabilities unchanged');
    }
    return result;
}
async function visit(page, url) {
    await page.goto('about:blank'); await page.goto(url);
}
async function ready(page, base, route, hash = '#overview') {
    state = 'ready'; await visit(page, base + route + hash);
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    await page.locator('.dashboard-main').waitFor();
}
async function overview(page, base, route) {
    await ready(page, base, route);
    await page.locator('.picture-toolbar select').selectOption('assessment-submitted');
    await page.locator('.picture-metrics').waitFor();
}
async function questionnaire(page, base, route, submitted = false) {
    await ready(page, base, route, '#cyber-security');
    await page.locator('.ncsc-assessment-list button').filter({ hasText: submitted ? 'submitted' : 'in-progress' }).first().click();
    await page.locator(submitted ? '.ncsc-result-metrics' : '.ncsc-question-index').waitFor();
}
async function keyboardFocus(page, route, width, extra) {
    const railLinks = page.locator('.dashboard-rail [data-module]');
    if (await railLinks.first().isVisible()) {
        await railLinks.first().focus(); await page.keyboard.press('Tab');
    } else {
        await page.locator('#dashboard-content').focus(); await page.keyboard.press('Tab');
    }
    await settle(page);
    const focus = await page.evaluate(() => {
        const n = document.activeElement, s = getComputedStyle(n), r = n.getBoundingClientRect();
        return { tag: n.tagName, module: n.dataset.module, outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth),
            outlineOffset: parseFloat(s.outlineOffset), x: r.x, right: r.right, y: r.y, bottom: r.bottom, innerWidth, innerHeight };
    });
    focusWitnesses.push({ route, width, ...extra, ...focus });
    assert.equal(focus.outlineStyle, 'solid', 'Keyboard outline is visible'); assert.ok(focus.outlineWidth >= 2);
    const ring = focus.outlineOffset + focus.outlineWidth;
    assert.ok(focus.x >= ring - 1 && focus.right + ring <= focus.innerWidth + 1, 'Full horizontal keyboard ring fits');
    const verticalFits = focus.y >= ring - 1 && focus.bottom + ring <= focus.innerHeight + 1;
    if (!verticalFits && baselineControl && width >= 1220 && extra.text200 && (extra.longMenu || (route === '/' && width === 1920)) && focus.module === 'ai_governance' &&
        focus.y >= ring - 1 && focus.bottom + ring - focus.innerHeight <= 8 && focus.bottom - focus.y + ring * 2 < focus.innerHeight) {
        knownBaselineGaps.push({ route, width, ...extra, failure: 'Inherited desktop text200 native focus clips bottom ring by <=8px', ...focus });
    } else assert.ok(verticalFits, 'Full vertical keyboard ring fits after native scroll settles');
}
async function stressLabels(page) {
    // DOM fixture only: use unchanged real anchors/listeners/order with longer
    // labels. No source or runtime function is replaced.
    await page.locator('.dashboard-rail [data-module] > span:last-child').evaluateAll(nodes => nodes.forEach((node, index) => {
        node.textContent = index % 2 ? 'Synthetic extended menu label for organisation governance' : 'SyntheticUnbrokenMenuLabel'.repeat(4);
    }));
}
async function readyChooser(page) {
    const chooser = page.locator('#dashboardChooser');
    if (!(await chooser.getAttribute('open'))) await page.locator('#dashboardChooserHeading').click();
    await page.locator('#dashboardChoices button').last().waitFor();
}
async function guardTour(page, base, route, width, extra) {
    const views = ['guard-organisation', 'guard-signout', 'guard-public-link'];
    if (views.every(view => hasCase(route, view, width, extra))) return;
    assert.ok(views.every(view => !hasCase(route, view, width, extra)), 'Resume only complete guard-tour blocks');
    await ready(page, base, route, '#cyber-security');
    await page.getByRole('button', { name: 'Start an assessment', exact: true }).click();
    const draft = 'Synthetic unsent desktop spacing draft';
    await page.locator('#ncsc-scope').fill(draft);
    for (const target of ['organisation', 'signout', 'public-link']) {
        if (target === 'organisation') { await readyChooser(page); await page.locator('#dashboardChoices button').last().click(); }
        else if (target === 'signout') await page.locator('#dashboardSignOut').click();
        else {
            const link = page.locator('footer a[data-dashboard-leave]').first();
            await link.focus(); await page.keyboard.press('Enter');
        }
        await page.locator('.ncsc-leave-dialog[open]').waitFor();
        const buttons = page.locator('.ncsc-leave-dialog button');
        for (let i = 0; i < await buttons.count(); i++) {
            await buttons.nth(i).focus(); await page.keyboard.press('Tab'); await settle(page);
            const ring = await page.evaluate(() => {
                const n = document.activeElement, s = getComputedStyle(n), r = n.getBoundingClientRect(), d = n.closest('dialog').getBoundingClientRect();
                return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, left: d.left, dialogRight: d.right, dialogTop: d.top, dialogBottom: d.bottom, viewportHeight: innerHeight, outline: s.outlineStyle,
                    clearance: parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset) };
            });
            assert.equal(ring.outline, 'solid');
            assert.ok(ring.x - ring.clearance >= ring.left - 1 && ring.right + ring.clearance <= ring.dialogRight + 1, 'Dialog action horizontal ring fits');
            assert.ok(ring.y - ring.clearance >= Math.max(0, ring.dialogTop) - 1 &&
                ring.bottom + ring.clearance <= Math.min(ring.viewportHeight, ring.dialogBottom) + 1, 'Dialog action full vertical ring fits visible dialog/viewport');
        }
        await geometry(page, route, 'guard-' + target, width, extra);
        await page.getByRole('button', { name: 'Stay here', exact: true }).click();
        assert.equal(await page.locator('#ncsc-scope').inputValue(), draft);
        assert.ok(page.url().endsWith('#cyber-security'));
        guards.push({ route, width, ...extra, target, dialog: true, stayed: true, draftPreserved: true });
    }
}
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser, zoomContext, zoomProfile, failure = null;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        async function configure(context) {
            await context.addInitScript(() => {
                window.desktopViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.desktopViolations.push(event.effectiveDirective));
            });
            await context.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== base || request.method() !== 'GET') {
                    blocked.push({ method: request.method(), path: new URL(request.url()).pathname, external: true }); return route.abort();
                }
                return route.continue();
            });
            const page = await context.newPage(); page.setDefaultTimeout(12000);
            page.on('pageerror', error => errors.push(error.message)); return page;
        }
        const context = await browser.newContext(), page = await configure(context);
        if (narrowFocusProbe) {
            await page.setViewportSize({ width: 320, height: 1000 });
            for (const route of routes) {
                await overview(page, base, route);
                await keyboardFocus(page, route, 320, { ordinaryText: true, narrowDesktop: true });
                await geometry(page, route, 'narrow-native-focus-probe', 320);
            }
            sourceAndNetworkChecks(); return;
        }
        if (focusProbe) {
            textScale = true; await page.setViewportSize({ width: 1280, height: 1000 });
            await overview(page, base, '/dashboard'); await stressLabels(page);
            await keyboardFocus(page, '/dashboard', 1280, { text200: true, longMenu: true });
            await geometry(page, '/dashboard', 'long-menu-focus-probe', 1280, { text200: true }); sourceAndNetworkChecks(); return;
        }
        if (!guardsOnly && !supplementOnly) for (const width of widths) {
            if (routes.every(route => ['overview', 'overview-unbroken', 'ready-chooser', 'questionnaire', 'results', 'services', 'selection', 'loading'].every(view => hasCase(route, view, width))) && hasCase('/', 'public', width) && hasCase('/signup', 'signup', width)) continue;
            await page.setViewportSize({ width, height: 1000 });
            for (const route of routes) {
                await overview(page, base, route); await keyboardFocus(page, route, width, {});
                await geometry(page, route, 'overview', width);
                model.context.displayName = unbrokenName;
                await overview(page, base, route); await stressLabels(page); await keyboardFocus(page, route, width, { longMenu: true }); await geometry(page, route, 'overview-unbroken', width);
                model.context.displayName = spacedName;
                await readyChooser(page); await geometry(page, route, 'ready-chooser', width);
                await questionnaire(page, base, route); await geometry(page, route, 'questionnaire', width);
                await questionnaire(page, base, route, true); await geometry(page, route, 'results', width);
                await ready(page, base, route, '#services'); await geometry(page, route, 'services', width);
                state = 'selection'; await visit(page, base + route); await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
                await geometry(page, route, 'selection', width);
                state = 'loading'; await visit(page, base + route); await page.locator('#dashboardEntry').waitFor();
                await geometry(page, route, 'loading', width);
                pendingSessions.forEach(response => { response.statusCode = 503; response.end('{}'); });
            }
            state = 'public'; await visit(page, base + '/'); await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated');
            await geometry(page, '/', 'public', width);
            await visit(page, base + '/signup'); await page.getByRole('checkbox').waitFor(); await geometry(page, '/signup', 'signup', width);
        }
        textScale = true;
        if (!guardsOnly && !supplementOnly) for (const width of [320, 390, 1280, 1440, 1920]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const route of routes) {
                const views = ['overview', 'overview-long-menu', 'questionnaire', 'guard-organisation', 'guard-signout', 'guard-public-link'];
                if (views.every(view => hasCase(route, view, width, { text200: true }))) continue;
                assert.ok(views.every(view => !hasCase(route, view, width, { text200: true })), 'Resume only whole text200 route blocks');
                await overview(page, base, route); await keyboardFocus(page, route, width, { text200: true });
                await geometry(page, route, 'overview', width, { text200: true });
                await stressLabels(page); await keyboardFocus(page, route, width, { text200: true, longMenu: true }); await geometry(page, route, 'overview-long-menu', width, { text200: true });
                await questionnaire(page, base, route); await geometry(page, route, 'questionnaire', width, { text200: true });
                await guardTour(page, base, route, width, { text200: true });
            }
        }
        textScale = false;
        if (!guardsOnly) for (const route of routes) {
            if (hasCase(route, 'questionnaire-print', 1440)) continue;
            await page.setViewportSize({ width: 1440, height: 1000 }); await questionnaire(page, base, route);
            await page.emulateMedia({ media: 'print' });
            await geometry(page, route, 'questionnaire-print', 1440, { media: 'print' });
            await page.pdf({ path: path.join(artifacts, (route === '/' ? 'gateway' : 'dashboard') + '-print.pdf'), format: 'A4' });
            await page.emulateMedia({ media: 'screen' });
        }
        for (const width of [320, 390, 1280, 1440, 1920]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const route of routes) await guardTour(page, base, route, width, {});
        }
        zoomProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-desktop-zoom-'));
        fs.mkdirSync(path.join(zoomProfile, 'Default'));
        fs.writeFileSync(path.join(zoomProfile, 'Default/Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
        zoomContext = await chromium.launchPersistentContext(zoomProfile, { headless: true, viewport: null,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--window-size=1440,1000'] });
        const zoomPage = await configure(zoomContext);
        for (const route of routes) {
            await overview(zoomPage, base, route);
            const zoom = await zoomPage.evaluate(() => ({ zoom: true, outerWidth, innerWidth, devicePixelRatio, scale: visualViewport.scale }));
            assert.equal(zoom.outerWidth, 1440); assert.equal(zoom.innerWidth, 720); assert.equal(zoom.devicePixelRatio, 2); assert.equal(zoom.scale, 1);
            await keyboardFocus(zoomPage, route, 1440, zoom); await geometry(zoomPage, route, 'overview', 1440, zoom);
            await questionnaire(zoomPage, base, route); await geometry(zoomPage, route, 'questionnaire', 1440, zoom);
            await guardTour(zoomPage, base, route, 1440, zoom);
        }
        assert.equal(new Set(results.map(row => row.id)).size, results.length, 'No duplicate observations');
        if (fullMode) assert.deepEqual(results.map(row => row.id).sort(), expectedInventory.slice().sort(), 'Complete exact228-case inventory');
        sourceAndNetworkChecks();
        console.log(JSON.stringify({ passed: knownBaselineGaps.length === 0, completed: true, fullMatrix: fullMode, knownBaselineGaps: knownBaselineGaps.length, observations: results.length, guards: guards.length, focus: focusWitnesses.length, artifacts, browser: browser.version() }));
    } catch (error) { failure = error.stack; throw error; }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ schemaVersion: 1, passed: failure === null && knownBaselineGaps.length === 0, completed: failure === null, fullMatrixPassed: fullMode && failure === null && knownBaselineGaps.length === 0, mode: fullMode ? 'full' : narrowFocusProbe ? 'narrow-focus-probe' : focusProbe ? 'focus-probe' : guardsOnly ? 'guards-only' : 'supplement-only', expectedInventory: fullMode ? expectedInventory : null, failure,
            baselineControl, resumedFrom: resumePath ? { path: resumePath, sha256: sha256(fs.readFileSync(resumePath)), observations: resume.results.length, originalFailure: resume.failure } : null, expectedWide, guardsOnly, focusProbe, narrowFocusProbe, supplementOnly, knownBaselineGaps, syntheticOnly: true, cssOverride: cssOverride || null, baseCssSha256: sha256(baseCss), reportTailBytes: reportTail.length, reportTailSha256: reportTail.length ? sha256(reportTail) : null, cssSha256: sha256(css), appSha256: sha256(app),
            browser: browser && browser.version(), results, guards, focusWitnesses, blocked, errors, requests,
            sourceHashesBefore: before, sourceHashesAfter: hashes(),
            limitations: ['Synthetic loopback Chromium only; no actual authentication, hosted or live customer acceptance.',
                '200% text fixture appends html font-size:200% to served style.css; native browser zoom is separately DPR/viewport asserted.',
                'Long menu stress changes labels on actual mounted anchors only; product source, order and event listeners remain unchanged.',
                'Guard tours cancel with Stay here; no save, selection, logout or external navigation effect is allowed.'] }, null, 2), { mode: 0o600 });
        pendingSessions.forEach(response => response.end('{}'));
        if (zoomContext) await zoomContext.close();
        if (zoomProfile) fs.rmSync(zoomProfile, { recursive: true, force: true });
        if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
