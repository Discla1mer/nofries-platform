'use strict';

// Optional served-source Chromium acceptance using the installed Playwright.
// NOFRIES_MENU_ARTIFACTS selects an external directory for screenshots/receipts.
// All server requests are loopback GETs. Assessment reads/saves are intercepted
// by the existing in-memory synthetic transport before any network operation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { fixture } = require('../../test/fixtures/dashboardFixture');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');
const registry = require('../../api/shared/protectedAssets/dashboardRegistry');

const root = path.resolve(__dirname, '../..');
const artifacts = path.resolve(process.env.NOFRIES_MENU_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-workspace-menu-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep evidence outside the source checkout');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const read = file => fs.readFileSync(path.join(root, file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const sourceFiles = ['app/dashboard.css', 'app/dashboard.html', 'index.html', 'style.css', 'home.css',
    'js/dashboard-loader.js', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js',
    'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
    'scripts/tests/dashboard-workspace-menu-browser.cjs', 'scripts/build-ncsc-questionnaire-preview.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file)];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha256(read(file))]));
const sourceHashesBefore = hashes();
const app = bundleFiles.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n');
const css = read('app/dashboard.css').toString();
const options = { customerLogin: true, customerTransport: 'auto', loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app, protectedStyleSource: css };
const documents = Object.fromEntries([['/dashboard', 'app/dashboard.html'], ['/', 'index.html']].map(([url, file]) =>
    [url, (url === '/' ? buildGatewayDocument : buildDashboardDocument)({ ...options, template: read(file).toString() })]));
assert.equal(documents['/'].appIntegrity, documents['/dashboard'].appIntegrity);
assert.equal(documents['/'].styleIntegrity, documents['/dashboard'].styleIntegrity);
const fixtures = buildFixtures();
const clone = value => JSON.parse(JSON.stringify(value));
const models = { all: clone(fixtures.tenants[0].model),
    viewer: projectDashboard(fixture({ role: 'viewer', tier: 'dashboard_score', empty: true })),
    advisor: projectDashboard(fixture({ role: 'fractional_advisor', service: 'fractional_advisory', empty: true })),
    unavailable: projectDashboard(fixture({ enabled: { cyber_security: false }, empty: true })) };
const bindingId = '10000000-0000-4000-8000-000000000001';
const primaryKeys = ['overview', 'cyber_security', 'services'];
const requests = [], blocked = [], errors = [], results = [], guards = [], screenshots = [], focusWitnesses = [], labelLegibility = [];
let scenario = 'all', text200 = false, browser, activePage, failure = null;
const assets = Object.fromEntries(['style.css', 'home.css', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
    'images/nofrieslogo.png', 'js/organisation-setup.js', 'js/home.js', 'js/prospect-assistant.js'].map(file => ['/' + file, file]));
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ method: request.method, path: pathname });
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { blocked.push(request.method + ' ' + pathname); response.writeHead(405); return response.end(); }
    let body, type = 'application/json';
    const model = models[scenario];
    if (documents[pathname]) {
        body = documents[pathname].html; type = 'text/html';
        response.setHeader('Content-Security-Policy', documents[pathname].contentSecurityPolicy);
    } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true,
        purpose: 'customer', accountType: 'company', generation: 'a'.repeat(64), selectedBindingId: bindingId,
        expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1, bindings: [
        { bindingId, organisationLabel: model.context.displayName },
        { bindingId: '10000000-0000-4000-8000-000000000002', organisationLabel: 'Another synthetic organisation' }
    ], nextAfterBindingId: null };
    else if (pathname === '/api/dashboard/bootstrap') body = model;
    else if (pathname === '/api/dashboard/modules/cyber_security') body = { schemaVersion: 1,
        context: model.context, generatedAt: model.generatedAt, module: model.modules.find(item => item.key === 'cyber_security'),
        summary: model.summary, services: model.services, admissionGranted: false, providerAccessGranted: false,
        metadata: fixtures.metadata, presentationMode: 'editable' };
    else if (['/roadmap.html', '/privacy.html', '/terms.html'].includes(pathname)) { body = '<!doctype html><title>Synthetic destination</title>'; type = 'text/html'; }
    else if (assets[pathname]) {
        body = read(assets[pathname]);
        if (pathname === '/style.css' && text200) body = Buffer.concat([body, Buffer.from('\nhtml { font-size: 200%; }\n')]);
        type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    }
    if (body === undefined) { blocked.push(request.method + ' ' + pathname); response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': type });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
});
const button = (page, name) => page.getByRole('button', { name, exact: true });
const menu = page => page.locator('.dashboard-rail nav[aria-label="Workspace"]:visible, .dashboard-mobile-nav:visible');
const link = (page, key) => menu(page).locator('[data-module="' + key + '"]');
const disclosure = page => menu(page).locator('details.dashboard-menu-other');
// Observe native scrolling to rest, using the established desktop witness's
// stable-frame rule. Do not repair the scroll position or move focus afterward.
const settle = page => page.evaluate(() => new Promise((resolve, reject) => {
    let previous = null, stable = 0, frames = 0;
    const tick = () => {
        const r = document.activeElement.getBoundingClientRect();
        const value = [scrollX, scrollY, r.x, r.y, r.width, r.height].join(':');
        stable = previous === value ? stable + 1 : 0; previous = value;
        if (++frames > 180) return reject(new Error('Native scroll did not settle'));
        if (stable >= 8) return resolve(); requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
}));
async function activate(page, locator) { await locator.focus(); await page.keyboard.press('Enter'); }
async function capture(page, label) {
    await settle(page);
    const file = label + '.png';
    await page.screenshot({ path: path.join(artifacts, file), fullPage: true, timeout: 30000 });
    screenshots.push(file);
    const geometry = await page.evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const visible = node => !!node.getClientRects().length;
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
            hash: location.hash, title: document.querySelector('.dashboard-main h1')?.textContent,
            nav: [...document.querySelectorAll('.dashboard-rail nav[aria-label="Workspace"], .dashboard-mobile-nav')]
                .filter(visible).map(node => ({ ...rect(node), position: getComputedStyle(node).position,
                    detailsOpen: !!node.querySelector('details[open]'), links: [...node.querySelectorAll('[data-module]')].map(item => ({
                        key: item.dataset.module, text: item.textContent, visible: visible(item), current: item.getAttribute('aria-current'), ...rect(item) })) })),
            mainWidth: document.querySelector('.dashboard-main')?.getBoundingClientRect().width,
            mainTop: document.querySelector('.dashboard-main')?.getBoundingClientRect().top,
            footerSpacerHeight: parseFloat(getComputedStyle(document.body, '::after').height) || 0,
            fixedEnhancementSupported: CSS.supports('height:anchor-size(--dashboard-footer-tasks block)') && CSS.supports('width:calc(100vw * 1rem / 16px)'),
            accountParent: document.getElementById('dashboardStatusPanel')?.parentElement.id,
            chooserParent: document.getElementById('dashboardChooser')?.parentElement.id };
    });
    assert.ok(geometry.scrollWidth <= geometry.width + 1, label + ': no page horizontal overflow');
    assert.equal(geometry.accountParent, 'dashboardEntry'); assert.equal(geometry.chooserParent, 'dashboardEntry');
    assert.equal(geometry.nav.length, 1, label + ': exactly one visible responsive menu');
    if (geometry.width <= 768) {
        assert.equal(geometry.nav[0].position, 'static', label + ': grouped mobile menu keeps its full height in normal flow');
        assert.ok(geometry.nav[0].bottom <= geometry.mainTop + 1, label + ': mobile menu precedes the content without overlay');
        assert.ok(geometry.footerSpacerHeight <= 8, label + ': only the existing8px footer focus-ring clearance remains');
    }
    for (const node of geometry.nav[0].links.filter(item => item.visible)) {
        assert.ok(node.width >= 44 && node.height >= 44, label + ': link target at least44px ' + node.key);
        assert.ok(node.x >= -1 && node.right <= geometry.width + 1, label + ': link fits width ' + node.key);
    }
    results.push({ label, screenshot: file, ...geometry });
    return geometry;
}
async function focusWitness(page, label) {
    await settle(page);
    const observation = await page.evaluate(() => {
        const n = document.activeElement, r = n.getBoundingClientRect(), s = getComputedStyle(n);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { tag: n.tagName, key: n.dataset.module, outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth),
            ring: parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset), top: r.top, bottom: r.bottom,
            left: r.left, right: r.right, width: innerWidth, height: innerHeight, hit: !!hit && (hit === n || n.contains(hit)) };
    });
    focusWitnesses.push({ label, ...observation });
    assert.equal(observation.outline, 'solid', label + ': keyboard focus visible');
    assert.ok(observation.outlineWidth >= 2 && observation.hit, label + ': focused target is unobscured');
    assert.ok(observation.top >= observation.ring - 1 && observation.bottom + observation.ring <= observation.height + 1 &&
        observation.left >= observation.ring - 1 && observation.right + observation.ring <= observation.width + 1, label + ': complete focus ring fits after native scrolling');
}
async function assertLongLabelLegibility(page, label) {
    const observation = await menu(page).locator('.dashboard-menu-primary').evaluate(primary => {
        const containerWidth = primary.getBoundingClientRect().width;
        return { containerWidth, links: [...primary.querySelectorAll('[data-module]')].map(node => {
            const text = node.querySelector('span:not(.dashboard-icon)'), rect = node.getBoundingClientRect();
            return { key: node.dataset.module, width: rect.width, height: rect.height,
                textWidth: text.getBoundingClientRect().width, fontSize: parseFloat(getComputedStyle(text).fontSize) };
        }) };
    });
    labelLegibility.push({ label, ...observation });
    assert.equal(observation.links.length, 3, label + ': all primary destinations retain their actual labels');
    for (const row of observation.links) {
        assert.ok(row.width >= observation.containerWidth * .8, label + ': enlarged long labels use full-width rows ' + row.key);
        assert.ok(row.textWidth >= row.fontSize * 5, label + ': label text has at least five em of usable width ' + row.key);
    }
}
async function assertMenu(page, label) {
    const expected = models[scenario].modules;
    const nav = menu(page);
    assert.equal(await nav.count(), 1);
    const actual = await nav.locator('[data-module]').evaluateAll(nodes => nodes.map(node => node.dataset.module));
    assert.deepEqual(actual.slice().sort(), expected.map(item => item.key).sort(), label + ': exact server-permitted modules only');
    const primary = await nav.locator('.dashboard-menu-primary [data-module]').evaluateAll(nodes => nodes.map(node => node.dataset.module));
    assert.deepEqual(primary, expected.filter(item => primaryKeys.includes(item.key) && item.state === 'ready').map(item => item.key), label + ': ready primary destinations');
    for (const item of expected.filter(item => !primary.includes(item.key))) {
        const row = disclosure(page).locator('[data-module="' + item.key + '"]');
        assert.equal(await row.count(), 1);
        if (item.state === 'planned') assert.match(await row.textContent(), /Coming next/i);
        if (item.state === 'disabled') assert.match(await row.textContent(), /Unavailable/i);
    }
    assert.equal(await nav.locator('[role="menu"], [role="menuitem"]').count(), 0, 'Native disclosure/anchors retain their semantics');
    assert.equal(await nav.locator('button').count(), 0, 'Assessment task controls stay inside their workspace');
}
async function configure(context) {
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET') { blocked.push('Blocked non-fixture request: ' + request.method()); return route.abort(); }
        return route.continue();
    });
    const transportSource = '(' + createSyntheticTransport.toString() + ')';
    await context.addInitScript({ content: `(() => {
        const fixture = ${JSON.stringify(fixtures).replace(/</g, '\\u003c')};
        const transport = ${transportSource}(fixture.tenants[0], fixture.metadata, fixture);
        const original = window.fetch.bind(window);
        window.menuSyntheticRequests = []; window.menuTransport = transport; window.menuViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.menuViolations.push(event.effectiveDirective));
        window.fetch = async function(url, options = {}) {
            const target = new URL(typeof url === 'string' ? url : url.url, location.href);
            if (target.origin === location.origin && /^\\/api\\/dashboard\\/ncsc\\/assessments(?:\\/|$)/.test(target.pathname)) {
                const result = await transport.fetch(target.pathname + target.search, options);
                window.menuSyntheticRequests.push({ method: options.method || 'GET', path: target.pathname, status: result.status });
                return result;
            }
            return original(url, options);
        };
    })();` });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    return page;
}
let origin;
async function visit(page, shell, hash = '#overview') {
    await page.goto('about:blank'); await page.goto(origin + shell + hash);
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    await page.locator('.dashboard-main h1').waitFor(); await assertMenu(page, shell + hash);
}
async function openAssessment(page) {
    await activate(page, link(page, 'cyber_security'));
    await page.locator('.ncsc-assessment-list button').first().click();
    await page.locator('#ncsc-question-index').selectOption('1');
}
async function expectHeading(page, title) {
    await page.waitForFunction(title => document.querySelector('.dashboard-main h1')?.textContent === title, title);
}
async function dialog(page) {
    await page.locator('dialog[open]').waitFor();
    assert.equal(await button(page, 'Stay here').evaluate(node => node === document.activeElement), true);
}
async function guardChecks(page, shell, width) {
    await visit(page, shell); await openAssessment(page);
    await page.locator('.ncsc-question input[value="no"]').check();
    await activate(page, link(page, 'services')); await dialog(page);
    await capture(page, (shell === '/' ? 'gateway' : 'dashboard') + '-dirty-stay-' + width);
    await activate(page, button(page, 'Stay here'));
    assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
    assert.equal(new URL(page.url()).hash, '#cyber-security');
    await activate(page, link(page, 'services')); await dialog(page);
    await link(page, 'overview').evaluate(node => { node.click(); node.click(); });
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await activate(page, button(page, 'Discard unsent changes')); await expectHeading(page, 'Services');
    await openAssessment(page); assert.equal(await page.locator('.ncsc-question input[value="unknown"]').isChecked(), true);
    await page.locator('.ncsc-question input[value="no"]').check();
    await page.evaluate(() => window.menuTransport.setScenario('delay'));
    await activate(page, link(page, 'services')); await dialog(page);
    await activate(page, button(page, 'Save and leave'));
    assert.equal(await button(page, 'Save and leave').isDisabled(), true);
    await link(page, 'overview').evaluate(node => { node.click(); node.click(); });
    await expectHeading(page, 'Services'); await openAssessment(page);
    assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
    assert.match(await page.locator('.ncsc-status').textContent(), /Saved revision 2/);
    assert.equal(await page.evaluate(() => window.menuSyntheticRequests.filter(row => row.method === 'POST').length), 1);
    // Existing secondary public links keep the loader's original leave guard.
    await page.locator('.ncsc-question input[value="partial"]').check();
    await activate(page, page.locator('footer a[data-dashboard-leave]').first()); await dialog(page);
    await activate(page, button(page, 'Stay here'));
    assert.equal(await page.locator('.ncsc-question input[value="partial"]').isChecked(), true);
    guards.push({ shell, width, stayKeepsDraft: true, discardRestoresSaved: true, saveRevision: 2,
        saveOperations: 1, repeatedClicksKeepOriginalTarget: true, secondaryPublicLeaveGuard: true });
    // A fresh document has independent in-memory records and a clean owned branch.
    await visit(page, shell); await openAssessment(page);
    await page.locator('.ncsc-question input[value="no"]').check();
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => history.back()); await dialog(page);
    assert.equal(new URL(page.url()).hash, '#cyber-security');
    await activate(page, button(page, 'Stay here'));
    assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
    await page.evaluate(() => history.back()); await dialog(page);
    await activate(page, button(page, 'Discard unsent changes')); await expectHeading(page, 'Overview');
    await page.evaluate(() => history.forward()); await expectHeading(page, 'Cyber Security');
    assert.equal(await page.evaluate(() => history.length), length);
    guards.push({ shell, width, nativeBackStay: true, nativeBackDiscard: true, nativeForward: true,
        branchLengthPreserved: true, baseline: 'Exact PR5923e5ce505 synthetic Chromium control passes this same sequence; no history source changes.' });
}

(async () => {
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 1920, 390, 320]) for (const shell of ['/dashboard', '/']) {
            const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : width === 320 ? 900 : 1000 }, hasTouch: width < 500 });
            const page = await configure(context); scenario = 'all'; text200 = false;
            const label = (shell === '/' ? 'gateway' : 'dashboard') + '-' + width;
            await visit(page, shell); assert.equal(await disclosure(page).evaluate(node => node.open), false);
            await capture(page, label + '-collapsed');
            if (width < 500) {
                const primary = await menu(page).locator('.dashboard-menu-primary [data-module]').evaluateAll(nodes => nodes.map(node => {
                    const r = node.getBoundingClientRect(); return { key: node.dataset.module, top: r.top, bottom: r.bottom, height: innerHeight };
                }));
                assert.equal(primary.length, 3);
                assert.ok(primary.every(item => item.top >= 0 && item.bottom <= item.height), label + ': all three primary destinations are visible on initial ready view without scrolling');
            }
            const summary = disclosure(page).locator('summary');
            await summary.focus(); await page.keyboard.press('Enter'); assert.equal(await disclosure(page).evaluate(node => node.open), true);
            for (let index = 0; index < await disclosure(page).locator('[data-module]').count(); index++) {
                await page.keyboard.press('Tab'); await focusWitness(page, label + '-secondary-' + index);
                assert.equal(await page.evaluate(() => document.activeElement.tagName), 'A');
            }
            await capture(page, label + '-expanded-keyboard');
            await summary.focus(); await page.keyboard.press('Space'); assert.equal(await disclosure(page).evaluate(node => node.open), false);
            await page.goto('about:blank'); await visit(page, shell, '#ai-governance');
            assert.equal(await disclosure(page).evaluate(node => node.open), true);
            assert.equal(await link(page, 'ai_governance').getAttribute('aria-current'), 'page');
            await capture(page, label + '-current-secondary');
            await visit(page, shell, '#services');
            assert.match(await page.locator('.dashboard-main').textContent(), /does not automatically include monitoring, support or advisory services/);
            await capture(page, label + '-informational-services');
            // Native focus on the final content control must remain visible above
            // the normal-flow menu, including Chromium's supported old fixed-bar branch.
            const lastContent = page.locator('.dashboard-main button:visible').last();
            await lastContent.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
            await focusWitness(page, label + '-last-content');
            if (width < 500) {
                const lastFooter = page.locator('.home-footer a:visible').last();
                await lastFooter.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
                await focusWitness(page, label + '-last-footer');
            }
            text200 = true;
            await visit(page, shell);
            await disclosure(page).locator('summary').click();
            await menu(page).locator('[data-module]').evaluateAll(nodes => nodes.forEach((node, index) => {
                // Synthetic DOM-only label stress retains the actual anchors/listeners.
                const label = node.querySelector('span:not(.dashboard-icon)');
                if (label && label.firstChild) label.firstChild.nodeValue = index % 2 ? 'Synthetic extended workspace label for organisation governance' : 'SyntheticUnbrokenWorkspaceLabel'.repeat(3);
            }));
            if (width < 500) await assertLongLabelLegibility(page, label + '-long-labels-text200');
            await capture(page, label + '-long-labels-text200');
            text200 = false;
            if (width === 1440 || width === 390) {
                for (const variant of ['viewer', 'advisor', 'unavailable']) {
                    scenario = variant;
                    await visit(page, shell, variant === 'unavailable' ? '#cyber-security' : '#overview');
                    if (await disclosure(page).count()) await disclosure(page).evaluate(node => { node.open = true; });
                    await assertMenu(page, label + '-' + variant);
                    if (variant === 'unavailable') {
                        assert.match(await link(page, 'cyber_security').textContent(), /Unavailable/i);
                        assert.match(await page.locator('.dashboard-main').textContent(), /temporarily unavailable/i);
                        assert.equal(await page.locator('.ncsc-questionnaire').count(), 0);
                    }
                    await capture(page, label + '-' + variant);
                }
                scenario = 'all'; await guardChecks(page, shell, width);
            }
            assert.deepEqual(await page.evaluate(() => window.menuViolations), []);
            await context.close(); activePage = null;
            console.log(JSON.stringify({ completedPage: label, observations: results.length, guardRecords: guards.length }));
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        assert.ok(requests.every(row => row.method === 'GET'));
        assert.deepEqual(hashes(), sourceHashesBefore, 'Actual source remained stable throughout the complete observation');
    } catch (error) {
        failure = error.stack || String(error); process.exitCode = 1;
        if (activePage && !activePage.isClosed()) {
            try { await activePage.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, timeout: 30000 }); } catch (_) { /* Preserve the original failure. */ }
        }
    } finally {
        const receipt = { completed: failure === null, failure, syntheticOnly: true, results, guards, screenshots, focusWitnesses, labelLegibility,
            requests, blocked, errors, sourceHashesBefore, sourceHashesAfter: hashes(),
            serverStateLabels: Object.fromEntries(Object.entries(models).map(([name, model]) => [name,
                model.modules.map(item => ({ key: item.key, route: registry.modules.find(row => row.key === item.key).route,
                    state: item.state, presentation: item.state === 'planned' ? 'Coming next' : item.state === 'disabled' ? 'Unavailable' : 'Ready' }))])),
            limitations: ['Headless Linux Chromium with synthetic sessions/data only; no real authentication, customer writes, provider calls, physical-device, WebKit, IME or screen-reader acceptance.',
                '200% text appends a fixture-only root font rule to served public style.css. Long labels replace DOM text only; production source and route keys stay exact.',
                'Assessment requests use the pre-existing in-memory synthetic transport; no assessment HTTP request or persistent write occurs.'] };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        console.log(JSON.stringify({ completed: receipt.completed, observations: results.length, guardTours: guards.length,
            screenshots: screenshots.length, loopbackRequests: requests.length, failure, artifacts }));
    }
})();
