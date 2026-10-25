'use strict';

// Optional installed-Chromium regression; no installation or live data.
// NODE_PATH=/workspace/NoFries/node_modules:$NODE_PATH node scripts/tests/dashboard-mobile-footer-clearance-browser.cjs
// --record-baseline records failures and requires the original 320x900 obstruction.
// NOFRIES_FOOTER_HOME_CSS selects retained CSS; NOFRIES_FOOTER_BASELINE selects
// a baseline results.json for desktop/no-nav/print geometry parity.
// NOFRIES_FOOTER_DASHBOARD_CSS selects a retained protected CSS control.
// NOFRIES_FOOTER_REPORT_TAIL appends the exact frozen647-byte compatibility tail.
// Long labels wrap through product CSS only; no fixture wrapping or reduced controls.
// Output is always outside source. Baseline mode never qualifies a CSS fix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = process.env.NOFRIES_FOOTER_TEST_ROOT || path.resolve(__dirname, '../..');
const { buildDashboardDocument } = require(path.join(root, 'lib/dashboardDocument'));
const { buildGatewayDocument } = require(path.join(root, 'lib/gatewayDocument'));
const { fixture } = require(path.join(root, 'test/fixtures/dashboardFixture'));
const { projectDashboard } = require(path.join(root, 'api/shared/appLifecycle/dashboardProjection'));
const { buildFixtures } = require(path.join(root, 'scripts/build-ncsc-questionnaire-preview'));
const read = file => fs.readFileSync(path.join(root, file));
const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = process.argv.includes('--record-baseline');
const desktopControl = process.env.NOFRIES_FOOTER_DESKTOP_CONTROL === '1';
const selectedScenarios = process.env.NOFRIES_FOOTER_SCENARIOS ? JSON.parse(process.env.NOFRIES_FOOTER_SCENARIOS) : null;
const routesOverridden = process.env.NOFRIES_FOOTER_ROUTES !== undefined;
const selectedRoutes = process.env.NOFRIES_FOOTER_ROUTES ? JSON.parse(process.env.NOFRIES_FOOTER_ROUTES) : ['/dashboard', '/'];
const scrollDiagnostic = process.env.NOFRIES_FOOTER_SCROLL_DIAGNOSTIC === '1';
const mode = baseline ? 'baseline-observation' : desktopControl ? 'desktop-control-observation' :
    selectedScenarios || routesOverridden || scrollDiagnostic ? 'selected-observation' : 'candidate-acceptance';
assert.ok(!(baseline && desktopControl), 'Choose baseline or desktop control observation');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-mobile-footer-'));
const homeCss = process.env.NOFRIES_FOOTER_HOME_CSS ? fs.readFileSync(process.env.NOFRIES_FOOTER_HOME_CSS) : read('home.css');
const rawDashboardCss = process.env.NOFRIES_FOOTER_DASHBOARD_CSS ? fs.readFileSync(process.env.NOFRIES_FOOTER_DASHBOARD_CSS) : read('app/dashboard.css');
const reportTail = process.env.NOFRIES_FOOTER_REPORT_TAIL ? fs.readFileSync(process.env.NOFRIES_FOOTER_REPORT_TAIL) : Buffer.alloc(0);
if (reportTail.length) {
    assert.equal(reportTail.length, 647);
    assert.equal(hash(reportTail), 'f3079b137c497572cf91d21eb5641a85c53c16842ed62e730f6fc321f228fcaf');
}
const dashboardCss = Buffer.concat([rawDashboardCss, reportTail]);
const bundle = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const inputs = ['home.css', 'style.css', 'app/dashboard.css', 'app/dashboard.html', 'index.html', 'js/dashboard-loader.js',
    'lib/dashboardDocument.js', 'lib/gatewayDocument.js', ...bundle.map(file => 'api/shared/protectedAssets/' + file)];
const hashes = () => Object.fromEntries(inputs.map(file => [file, hash(read(file))]));
const before = hashes();
const regressionHash = hash(fs.readFileSync(__filename));
const app = Buffer.from(bundle.map(file => read('api/shared/protectedAssets/' + file)).join('\n'));
const options = { loaderSource: read('js/dashboard-loader.js').toString(), protectedAppSource: app.toString(), protectedStyleSource: dashboardCss.toString() };
const documents = { '/dashboard': buildDashboardDocument({ ...options, template: read('app/dashboard.html').toString() }),
    '/': buildGatewayDocument({ ...options, template: read('index.html').toString() }) };
const model = projectDashboard(fixture({ now: new Date().toISOString(), name: 'Synthetic footer workspace', service: 'managed_endpoint' }));
const questionnaireFixture = buildFixtures(), questionnaireSeed = questionnaireFixture.tenants[0];
const questionnaireModule = { schemaVersion: 1, context: questionnaireSeed.model.context, generatedAt: questionnaireSeed.model.generatedAt,
    module: questionnaireSeed.model.modules.find(row => row.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
    services: [], admissionGranted: false, providerAccessGranted: false, metadata: questionnaireFixture.metadata, presentationMode: 'editable' };
const binding = '10000000-0000-4000-8000-000000000001';
const assets = Object.fromEntries(['style.css', 'home.css', 'favicon.svg', 'favicon.ico', 'images/nofrieslogo.png',
    'js/organisation-setup.js', 'js/home.js', 'js/prospect-assistant.js'].map(file => ['/' + file, file]));
const requests = [], blocked = [], errors = [], violations = [], results = [], scrollTimings = [];
let state = 'ready', textScale = 100, safeArea = 0, questionnaire = false;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { blocked.push({ method: req.method, path: pathname }); res.writeHead(405); return res.end(); }
    let body, type = 'application/json';
    if (documents[pathname]) {
        const doc = documents[pathname];
        body = doc.html.replace('</head>', '<link rel="stylesheet" href="/fixture.css"></head>');
        if (safeArea) body = body.replace('width=device-width, initial-scale=1.0', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
        type = 'text/html'; res.setHeader('Content-Security-Policy', doc.contentSecurityPolicy);
    } else if (pathname === '/fixture.css') {
        // Preserve the product's real smooth/native scrolling policy.
        body = 'html { font-size: ' + textScale + '%; }'; type = 'text/css';
    } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = dashboardCss; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') {
        if (state === 'loading') return; // Intentionally pending local GET; closed with this context.
        res.statusCode = state === 'signed-out' ? 401 : state === 'denied' ? 403 : 200;
        body = JSON.stringify(state === 'signed-out' ? { code: 'dashboard_session_required' } : state === 'denied' ? { code: 'dashboard_access_denied' } : {
            schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', generation: 'a'.repeat(64),
            selectedBindingId: state === 'selection' ? null : binding, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    } else if (pathname === '/api/dashboard/organisations') {
        body = JSON.stringify({ schemaVersion: 1, bindings: [1, 2].map(index => ({ bindingId: binding.slice(0, -1) + index,
            organisationLabel: 'Synthetic workspace ' + index })), nextAfterBindingId: null });
    } else if (pathname === '/api/dashboard/bootstrap') { body = JSON.stringify(questionnaire ? questionnaireSeed.model : model); }
    else if (pathname === '/api/dashboard/modules/cyber_security') { body = JSON.stringify(questionnaireModule); }
    else if (pathname === '/api/dashboard/ncsc/assessments') {
        body = JSON.stringify({ schemaVersion: 1, assessments: questionnaireSeed.assessments.filter(row => row.status === 'in-progress').slice(0, 1)
            .map(row => Object.fromEntries(['assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress'].map(key => [key, row[key]]))), nextAfterAssessmentId: null });
    } else if (pathname === '/api/dashboard/ncsc/assessments/assessment-a') { body = JSON.stringify({ schemaVersion: 1, assessment: questionnaireSeed.assessments[0] }); }
    else if (pathname === '/api/organisation-setup/state') { body = JSON.stringify({ state: 'start' }); }
    else if (assets[pathname]) {
        body = pathname === '/home.css' ? homeCss : read(assets[pathname]);
        type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    }
    if (body === undefined) { blocked.push({ method: req.method, path: pathname }); res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', type); res.end(body);
});

// Blink rounds the document scroll range to CSS pixels. Allow subpixel bounds
// rounding only; fixed-nav overlap and outline clearance are measured separately.
const rounding = .75;
async function settle(page) {
    const observation = await page.evaluate(limit => new Promise((resolve, reject) => {
        let stable = 0, previous, start = performance.now(), trace = [];
        const tick = () => {
            const position = [scrollX, scrollY, document.querySelector('.dashboard-mobile-nav')?.scrollLeft || 0];
            stable = previous && position.every((value, index) => Math.abs(value - previous[index]) < .1) ? stable + 1 : 0;
            previous = position;
            trace.push(position); if (trace.length > 16) trace.shift();
            if (stable >= 8) resolve({ duration: performance.now() - start, position });
            else if (performance.now() - start >= limit) reject(new Error('Native scrolling did not settle: ' + JSON.stringify({ trace,
                active: document.activeElement.tagName + ':' + document.activeElement.textContent.trim().slice(0, 40),
                scrollHeight: document.documentElement.scrollHeight, fontSize: getComputedStyle(document.documentElement).fontSize,
                navPosition: getComputedStyle(document.querySelector('.dashboard-mobile-nav') || document.body).position })));
            else requestAnimationFrame(tick);
        }; requestAnimationFrame(tick);
    // Real smooth scroll across the enlarged document measured 1.64s. Wait for
    // eight stationary frames rather than assuming every native animation ends
    // within 1.5s; the bounded deadline still rejects motion that never settles.
    }), 5000);
    scrollTimings.push(observation);
}
async function measure(page, end = true) {
    if (end) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(page);
    return page.evaluate(epsilon => {
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const probe = (node, rounded = false) => {
            const box = rect(node), xs = [box.left + epsilon, (box.left + box.right) / 2, box.right - epsilon],
                ys = [box.top + epsilon, (box.top + box.bottom) / 2, box.bottom - epsilon];
            // Rounded task corners are outside the button's painted hit region.
            // Sample their inner arcs; footer link edges retain full-rectangle probes.
            const radius = rounded ? Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map(key => parseFloat(getComputedStyle(node)[key]) || 0)) : 0;
            const inset = Math.min(radius * (1 - Math.SQRT1_2) + epsilon, box.width / 2, box.height / 2);
            const points = xs.flatMap((initialX, column) => ys.map((initialY, row) => {
                const corner = rounded && column !== 1 && row !== 1;
                const x = Math.floor(corner ? column === 0 ? box.left + inset : box.right - inset : initialX),
                    y = Math.floor(corner ? row === 0 ? box.top + inset : box.bottom - inset : initialY);
                const found = document.elementFromPoint(x, y); return {
                x, y, hit: !!found && (found === node || node.contains(found)), actual: found && (found.className || found.tagName) }; }));
            const bounds = box.left >= -epsilon && box.top >= -epsilon && box.right <= innerWidth + epsilon && box.bottom <= innerHeight + epsilon;
            return { ...box, points, hit: bounds && points.every(point => point.hit), bounds,
                targetSize: box.width >= 44 && box.height >= 44 };
        };
        const nav = document.querySelector('.dashboard-mobile-nav'), navStyle = nav && getComputedStyle(nav),
            navVisible = !!nav && navStyle.display !== 'none', navOverlay = navVisible && navStyle.position === 'fixed', navBox = nav && rect(nav);
        const targets = [...document.querySelectorAll('.home-footer a')].map(link => {
            const box = probe(link), style = getComputedStyle(link), ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
            return { href: link.getAttribute('href'), ...box, unobscured: box.hit && (!navOverlay || box.bottom <= navBox.top),
                focused: link === document.activeElement, focusVisible: link.matches(':focus-visible'),
                outlineWidth: parseFloat(style.outlineWidth), outlineOffset: parseFloat(style.outlineOffset),
                // All of the target and its visible ring must fit above the bar.
                focusRingClear: !navVisible || (box.top - ring >= -epsilon && box.bottom + ring <= (navOverlay ? navBox.top : innerHeight) &&
                    box.left - ring >= -epsilon && box.right + ring <= innerWidth + epsilon) };
        });
        const labels = nav ? [...nav.children].map(button => {
            const box = probe(button, true), range = document.createRange(); range.selectNodeContents(button);
            const text = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
            return { text: button.textContent, ...box, lines: text.length, textRects: text,
                contained: text.every(r => r.left >= box.left - epsilon && r.right <= box.right + epsilon && r.top >= box.top - epsilon && r.bottom <= box.bottom + epsilon),
                scrollWidth: button.scrollWidth, clientWidth: button.clientWidth, scrollHeight: button.scrollHeight, clientHeight: button.clientHeight,
                fontSize: getComputedStyle(button).fontSize, lineHeight: getComputedStyle(button).lineHeight, whiteSpace: getComputedStyle(button).whiteSpace };
        }) : [];
        const chooser = document.getElementById('dashboardChooser'), heading = document.getElementById('dashboardChooserHeading'), headingRange = document.createRange();
        headingRange.selectNodeContents(heading);
        return { state: document.body.dataset.dashboardState, viewport: { width: innerWidth, height: innerHeight },
            scrollY, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
            footer: rect(document.querySelector('.home-footer')), targets,
            hit: targets.every(target => target.unobscured && target.targetSize),
            nav: navBox, navDisplay: navStyle && navStyle.display, navPosition: navStyle && navStyle.position, navOverlay,
            navPaddingBottom: navStyle && navStyle.paddingBottom, labels,
            chooser: { tag: chooser.tagName, open: chooser.tagName === 'DETAILS' ? chooser.open : !chooser.hidden,
                ...rect(chooser), headingText: [...headingRange.getClientRects()].map(r => ({ left: r.left, right: r.right })) },
            questionnaireMounted: !!document.querySelector('#dashboardApp .ncsc-questionnaire'),
            rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
            fixedEnhancementSupported: CSS.supports('height:anchor-size(--dashboard-footer-tasks block)') &&
                CSS.supports('width:calc(100vw * 1rem / 16px)'),
            tailHeight: getComputedStyle(document.body, '::after').height };
    }, rounding);
}
function geometryPass(geometry) {
    const navVisible = geometry.navDisplay && geometry.navDisplay !== 'none';
    const expectedPosition = !geometry.questionnaireMounted && geometry.fixedEnhancementSupported && geometry.viewport.height >= 736 && geometry.rootFontSize <= 16 ? 'fixed' : 'static';
    return geometry.hit && geometry.scrollWidth <= geometry.viewport.width + rounding && (!navVisible ||
        ((baseline || geometry.navPosition === expectedPosition) && (!geometry.navOverlay || geometry.nav.top >= 0) && geometry.labels.length === 5 &&
        geometry.labels.every(label => (!geometry.navOverlay || label.hit) && label.targetSize && label.contained && label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1)));
}
async function exerciseFooter(page) {
    const links = page.locator('.home-footer a'), count = await links.count(), activations = [];
    await page.evaluate(() => {
        window.footerClicks = [];
        if (window.footerProbeInstalled) return;
        window.footerProbeInstalled = true;
        document.querySelector('.home-footer').addEventListener('click', event => {
            const link = event.target.closest('a'); if (!link) return;
            window.footerClicks.push(link.getAttribute('href')); event.preventDefault();
        });
    });
    for (let index = 0; index < count; index++) {
        const link = links.nth(index), href = await link.getAttribute('href');
        await measure(page); // Each touch starts at the real end of document.
        let tapped = false;
        const beforeTap = await page.evaluate(() => window.footerClicks.length);
        try { await link.tap({ timeout: 600 }); tapped = (await page.evaluate(() => window.footerClicks.length)) === beforeTap + 1; }
        catch (error) { if (error.name !== 'TimeoutError') throw error; }
        const neighbor = index === 0 ? 1 : index - 1;
        await links.nth(neighbor).focus(); await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab');
        const focusGeometry = await measure(page, false), target = focusGeometry.targets[index];
        const beforeKey = await page.evaluate(() => window.footerClicks.length);
        await page.keyboard.press('Enter');
        const keyed = (await page.evaluate(() => window.footerClicks.length)) === beforeKey + 1;
        activations.push({ href, tapped, keyed, target,
            pass: tapped && keyed && target.focused && target.focusVisible && target.outlineWidth >= 2 && target.unobscured && target.targetSize && target.focusRingClear });
    }
    return activations;
}
async function readyCase(page, route, scenario) {
    state = 'ready'; questionnaire = false; textScale = scenario.textScale || 100; safeArea = scenario.safeArea || 0;
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: safeArea, right: 0 } });
    await page.goto('about:blank'); await page.goto(base + route + '#overview');
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    const chooser = page.locator('#dashboardChooser');
    const details = await chooser.evaluate(node => node.tagName === 'DETAILS');
    if (details && scenario.chooserOpen) await chooser.locator('summary').tap();
    // The gateway uses a section. Its hidden state is a genuine loader state,
    // not a disclosure widget. Cover it in addition to the always-present case.
    if (!details && scenario.chooserClosed) await chooser.evaluate(node => { node.hidden = true; });
    assert.equal(await page.locator('.dashboard-mobile-nav .dashboard-task').count(), 5);
    if (scenario.longLabels) await page.locator('.dashboard-mobile-nav .dashboard-task').evaluateAll(buttons => {
        const labels = ['Organisation home', 'Assess your workspace', 'Plan improvements', 'Review saved proof', 'More workspace tools'];
        buttons.forEach((button, index) => { button.textContent = labels[index]; });
    });
    const end = await measure(page), activations = await exerciseFooter(page), taskNavigation = baseline ? null : await exerciseTasks(page, scenario);
    if (safeArea) assert.ok(parseFloat(end.navPaddingBottom) >= 8 * textScale / 100 + safeArea, 'CDP safe area must affect actual nav padding');
    const wraps = !scenario.longLabels || end.navDisplay === 'none' || end.labels.some(label => label.lines > 1);
    const record = { route, scenario, end, activations, taskNavigation,
        pass: geometryPass(end) && wraps && activations.every(row => row.pass) && (!taskNavigation || taskNavigation.pass) };
    results.push(record);
    console.log(JSON.stringify({ route, scenario, layout: end.navPosition, footerPass: activations.every(row => row.pass),
        tasksPass: taskNavigation?.pass, pass: record.pass }));
    if (!baseline) assert.ok(record.pass, 'Complete ready footer/task targets and actions must pass');
    if (scenario.width === 320 && (!scenario.textScale || scenario.textScale === 200) && !scenario.chooserClosed) await page.screenshot({ path: path.join(artifacts,
        (route === '/' ? 'gateway' : 'dashboard') + '-320-' + (scenario.textScale || 100) + (scenario.longLabels ? '-long' : '') + '.png') });
    await cdp.detach();
    return record;
}
async function settledFocus(page, key) {
    // Wait for native focus scrolling to finish. Never repair its scroll position.
    await settle(page);
    return page.evaluate(key => {
        const node = document.activeElement, box = node.getBoundingClientRect(), style = getComputedStyle(node),
            nav = document.querySelector('.dashboard-mobile-nav'), navStyle = nav && getComputedStyle(nav),
            dialog = node.closest('dialog[open]'), dialogBox = dialog && dialog.getBoundingClientRect(), navControl = !!node.closest('.dashboard-mobile-nav'),
            navOverlay = !!nav && navStyle.display !== 'none' && navStyle.position === 'fixed',
            regionTop = dialog ? Math.max(0, dialogBox.top) : navControl && navOverlay ? nav.getBoundingClientRect().top : 0,
            regionBottom = dialog ? Math.min(innerHeight, dialogBox.bottom) : navOverlay && !navControl ? nav.getBoundingClientRect().top : innerHeight,
            outlineWidth = parseFloat(style.outlineWidth) || 0,
            ring = outlineWidth + (parseFloat(style.outlineOffset) || 0),
            found = document.elementFromPoint(Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2)),
            interactive = node.matches('a,button,input,textarea,select,summary'),
            questionnaireControl = interactive && !!node.closest('.ncsc-questionnaire'),
            footerControl = !!node.closest('.home-footer');
        const full = box.top >= regionTop - .75 && box.bottom <= regionBottom + .75 && box.left >= -.75 && box.right <= innerWidth + .75,
            outlineClear = box.top - ring >= regionTop && box.bottom + ring <= regionBottom && box.left - ring >= 0 && box.right + ring <= innerWidth,
            hit = !!found && (found === node || node.contains(found));
        const visible = { left: Math.max(0, box.left), right: Math.min(innerWidth, box.right),
            top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom) };
        const visiblePoint = document.elementFromPoint(Math.floor((visible.left + visible.right) / 2), Math.floor((visible.top + visible.bottom) / 2)),
            visibleHit = !!visiblePoint && (visiblePoint === node || node.contains(visiblePoint)),
            usableNativeSlice = visible.right - visible.left >= Math.min(44, box.width) && visible.bottom - visible.top >= Math.min(44, box.height),
            authorCovered = !dialog && !navControl && navOverlay && visible.bottom > regionBottom;
        const keyboard = !key.includes('rawTouch-initial'), focusVisible = node.matches(':focus-visible'),
            indicatorVisible = focusVisible && outlineWidth >= 2 && style.outlineStyle !== 'none';
        return { key, tag: node.tagName, id: node.id, question: document.getElementById('ncsc-question-index')?.value,
            label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 100) || node.id,
            questionnaireControl, footerControl, navControl, navOverlay, inDialog: !!dialog, interactive,
            navIndex: navControl ? [...nav.children].indexOf(node) : null,
            top: box.top, bottom: box.bottom, width: box.width, height: box.height,
            scrollY, regionTop, regionBottom, hit, full, outlineClear, ring, outlineWidth, focusVisible, indicatorVisible, keyboard,
            nativeViewportClip: !full, visible, visibleHit, usableNativeSlice, authorCovered,
            // Flow preserves native textarea/caret scrolling, including fields
            // taller than a landscape viewport. Viewport clipping is recorded;
            // author-created overlay coverage remains a failure.
            pass: dialog ? full && hit && outlineClear && (!keyboard || indicatorVisible) :
                questionnaireControl ? usableNativeSlice && visibleHit && !authorCovered && (!keyboard || indicatorVisible) :
                footerControl ? full && hit && (!navOverlay || outlineClear) && (!keyboard || indicatorVisible) :
                navControl ? full && hit && outlineClear && (!keyboard || indicatorVisible) : true };
    }, key);
}
async function exerciseTasks(page, scenario) {
    if (await page.locator('.dashboard-mobile-nav').evaluate(node => getComputedStyle(node).display === 'none')) return { hidden: true, pass: true };
    const tasks = page.locator('.dashboard-mobile-nav .dashboard-task'), steps = [], touches = [];
    // The footer's first link is the genuine adjacent focus target after More.
    await page.locator('.home-footer a').first().focus();
    for (let index = 4; index >= 0; index--) { await page.keyboard.press('Shift+Tab'); steps.push(await settledFocus(page, 'Tasks-Shift+Tab')); }
    for (let index = 1; index < 5; index++) { await page.keyboard.press('Tab'); steps.push(await settledFocus(page, 'Tasks-Tab')); }
    await page.evaluate(() => {
        window.taskClicks = [];
        if (window.taskProbeInstalled) return;
        window.taskProbeInstalled = true;
        document.querySelector('.dashboard-mobile-nav').addEventListener('click', event => {
            const button = event.target.closest('button'); if (!button) return;
            const r = button.getBoundingClientRect(), inset = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius',
                'borderBottomLeftRadius', 'borderBottomRightRadius'].map(key => parseFloat(getComputedStyle(button)[key]) || 0)) * (1 - Math.SQRT1_2) + .75;
            const xs = [r.left + .75, (r.left + r.right) / 2, r.right - .75], ys = [r.top + .75, (r.top + r.bottom) / 2, r.bottom - .75];
            const points = xs.flatMap((x, column) => ys.map((y, row) => {
                const corner = column !== 1 && row !== 1, px = Math.floor(corner ? column === 0 ? r.left + inset : r.right - inset : x),
                    py = Math.floor(corner ? row === 0 ? r.top + inset : r.bottom - inset : y), hit = document.elementFromPoint(px, py);
                return { x: px, y: py, hit: !!hit && (hit === button || button.contains(hit)) };
            }));
            window.taskClicks.push({ index: [...button.parentElement.children].indexOf(button), trusted: event.isTrusted,
                rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }, points,
                eventPoint: { x: event.clientX, y: event.clientY, hit: (() => {
                    const hit = document.elementFromPoint(event.clientX, event.clientY); return !!hit && (hit === button || button.contains(hit));
                })() },
                full: r.top >= -.75 && r.left >= -.75 && r.right <= innerWidth + .75 && r.bottom <= innerHeight + .75,
                targetSize: r.width >= 44 && r.height >= 44, hit: points.every(point => point.hit) });
        }, true);
    });
    const destinations = ['overview', 'ai-governance', 'improvement-plan', 'evidence', 'services'];
    for (let index = 0; index < 5; index++) {
        await page.locator('.home-footer a').first().focus();
        for (let step = 4; step >= index; step--) await page.keyboard.press('Shift+Tab');
        const before = await settledFocus(page, 'Tasks-before-touch'), count = await page.evaluate(() => window.taskClicks.length);
        let tapped = false;
        try { await tasks.nth(index).tap({ timeout: 600 }); tapped = true; }
        catch (error) { if (error.name !== 'TimeoutError') throw error; }
        await settle(page);
        const clicked = await page.evaluate(() => window.taskClicks.at(-1)), route = new URL(page.url()).hash.slice(1);
        // Observe geometry during the trusted activation, after the ordinary
        // locator action's native scrolling. Retain the rapid primer's geometry;
        // the separate settled keyboard tour requires whole targets/indicators.
        touches.push({ index, before, tapped, clicked, route, expected: destinations[index],
            pass: before.navControl && before.navIndex === index && tapped &&
                (await page.evaluate(() => window.taskClicks.length)) === count + 1 && clicked?.index === index && clicked.trusted &&
                clicked.full && clicked.targetSize && clicked.hit && clicked.eventPoint.hit && route === destinations[index] });
        if (scenario.longLabels) await tasks.evaluateAll(buttons => {
            ['Organisation home', 'Assess your workspace', 'Plan improvements', 'Review saved proof', 'More workspace tools']
                .forEach((label, position) => { buttons[position].textContent = label; });
        });
    }
    // Return to the original overview through the same actual task handler.
    await page.locator('.home-footer a').first().focus();
    for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter'); await settle(page);
    if (scenario.longLabels) await tasks.evaluateAll(buttons => {
        ['Organisation home', 'Assess your workspace', 'Plan improvements', 'Review saved proof', 'More workspace tools']
            .forEach((label, index) => { buttons[index].textContent = label; });
    });
    return { steps, touches, returnedHome: new URL(page.url()).hash === '#overview',
        pass: steps.every(row => row.navControl && row.pass && row.width >= 44 && row.height >= 44) &&
            touches.every(row => row.pass) && new URL(page.url()).hash === '#overview' };
}
async function questionnaireJourney(page, route, scenario) {
    questionnaire = true; state = 'ready'; textScale = scenario.textScale || 100; safeArea = scenario.safeArea || 0;
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: safeArea, right: 0 } });
    await page.goto('about:blank'); await page.goto(base + route + '#cyber-security');
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    const chooser = page.locator('#dashboardChooser');
    if (await chooser.evaluate(node => node.tagName === 'DETAILS')) {
        if (scenario.chooserOpen) await chooser.locator('summary').tap();
    } else if (scenario.chooserClosed) await chooser.evaluate(node => { node.hidden = true; });
    if (scenario.longLabels) await page.locator('.dashboard-mobile-nav .dashboard-task').evaluateAll(buttons => {
        ['Organisation home', 'Assess your workspace', 'Plan improvements', 'Review saved proof', 'More workspace tools']
            .forEach((label, index) => { buttons[index].textContent = label; });
    });
    let entryTapped = true;
    try { await page.locator('.ncsc-assessment-list button').first().tap({ timeout: 600 }); }
    catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        entryTapped = false;
        // Keep the failed touch as a failing case. Continue the independently
        // required keyboard journey through actual native adjacent focus.
        for (let index = 0; index < 45; index++) {
            await page.keyboard.press('Tab');
            if (await page.locator('.ncsc-assessment-list button').first().evaluate(node => node === document.activeElement)) { await page.keyboard.press('Enter'); break; }
        }
    }
    await page.locator('#ncsc-clear-answer').waitFor();
    const steps = [], touches = [], guarded = !!process.env.NOFRIES_FOOTER_GUARD_COMPOSITION;
    await page.evaluate(guarded => {
        window.journeyFooterClicks = 0;
        document.querySelector('.home-footer').addEventListener('click', event => {
            if (!event.target.closest('a[href="/roadmap.html"]')) return;
            window.journeyFooterClicks++;
            if (!guarded) event.preventDefault();
        }, true);
    }, guarded);
    let answered = false, nextActivated = false, helpOpened = false, footerReached = false, answerChange, questionChange;
    for (let index = 0; index < 35 && !answered; index++) {
        await page.keyboard.press('Tab'); const focus = await settledFocus(page, 'Tab-to-answer'); steps.push(focus);
        if (focus.tag === 'INPUT') {
            const before = await page.evaluate(() => document.querySelector('.ncsc-question input:checked')?.value || null);
            await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space');
            const after = await page.locator('input:focus').evaluate(node => ({ value: node.value, checked: node.checked }));
            answered = after.checked && after.value !== before; answerChange = { before, after };
            steps.push(await settledFocus(page, 'Answer-ArrowRight-Space'));
        }
    }
    for (let index = 0; index < 70; index++) {
        await page.keyboard.press('Tab'); const focus = await settledFocus(page, 'Tab-to-footer'); steps.push(focus);
        if (focus.label === 'Help me answer this question' && !helpOpened) {
            await page.keyboard.press('Enter');
            helpOpened = await page.locator('summary:focus').evaluate(node => node.parentElement.open);
            steps.push(await settledFocus(page, 'Help-Enter'));
        }
        if (focus.label === 'Next question' && !nextActivated) {
            const before = await page.locator('#ncsc-question-index').inputValue();
            await page.keyboard.press('Enter');
            const after = await page.locator('#ncsc-question-index').inputValue();
            nextActivated = before !== after; questionChange = { before, after }; steps.push(await settledFocus(page, 'Next-Enter'));
        }
        if (focus.footerControl && focus.label === 'Roadmap') { footerReached = true; break; }
    }
    // Continue from the actual adjacent focus target, without focus() or scrolling.
    for (let index = 0; index < 15; index++) { await page.keyboard.press('Shift+Tab'); steps.push(await settledFocus(page, 'Shift+Tab-from-footer')); }
    for (let index = 0; index < 35; index++) {
        await page.keyboard.press('Tab'); const focus = await settledFocus(page, 'Tab-return-footer'); steps.push(focus);
        if (focus.footerControl && focus.label === 'Roadmap') break;
    }
    // Raw touch uses only the position produced by native keyboard scrolling.
    // Clicking is observed, not force-clicked; interception keeps synthetic GETs local.
    const roadmap = page.locator('.home-footer a[href="/roadmap.html"]');
    const guards = [];
    async function checkGuard(activation) {
        await page.locator('dialog[open]').waitFor();
        const dialogSteps = [];
        for (const key of ['initial', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
            if (key !== 'initial') await page.keyboard.press(key);
            dialogSteps.push(await settledFocus(page, 'Dialog-' + activation + '-' + key));
        }
        const stay = page.getByRole('button', { name: 'Stay here', exact: true }), box = await stay.boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        guards.push({ activation, steps: dialogSteps, stayRawTouchClosed: true, pass: dialogSteps.every(row => row.pass) });
    }
    const beforeEnter = await page.evaluate(() => window.journeyFooterClicks);
    await page.keyboard.press('Enter');
    const footerEntered = (await page.evaluate(() => window.journeyFooterClicks)) === beforeEnter + 1;
    if (guarded) {
        await checkGuard('Enter');
        // Stay restores the genuine questionnaire fallback focus. Reach Roadmap
        // again through native Tab; never focus or scroll the footer manually.
        for (let index = 0; index < 70; index++) {
            await page.keyboard.press('Tab'); const focus = await settledFocus(page, 'Tab-after-Stay'); steps.push(focus);
            if (focus.footerControl && focus.label === 'Roadmap') break;
        }
    }
    const target = await roadmap.boundingBox();
    if (target) {
        const beforeTap = await page.evaluate(() => window.journeyFooterClicks);
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
        await settle(page);
        touches.push({ label: 'Roadmap', rawTouch: true, clicked: (await page.evaluate(() => window.journeyFooterClicks)) === beforeTap + 1 });
    }
    // The isolated base predates the frozen576 footer guard. In the immutable
    // UI582 composition this same actual touch must open its native leave dialog.
    if (guarded) await checkGuard('rawTouch');
    const record = { route, journey: scenario, entryTapped, answered, answerChange, nextActivated, questionChange, helpOpened, footerReached, footerEntered, steps, touches, guards,
        pass: entryTapped && answered && nextActivated && helpOpened && footerReached && footerEntered && steps.every(row => row.pass) &&
            touches.length === 1 && touches.every(row => row.clicked) && guards.every(row => row.pass) };
    results.push(record);
    console.log(JSON.stringify({ route, journey: scenario, pass: record.pass, nativeSteps: steps.length,
        obscured: steps.filter(row => !row.pass).map(row => ({ label: row.label, key: row.key, top: row.top, bottom: row.bottom, regionBottom: row.regionBottom })) }));
    await cdp.detach(); return record;
}
let base;
(async () => {
    let browser, context, failure;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: true });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => console.error('CSP:' + event.effectiveDirective)));
        page.on('console', message => { if (message.text().startsWith('CSP:')) violations.push(message.text()); });
        await page.route('**/*', route => {
            const req = route.request();
            if (new URL(req.url()).origin !== base || req.method() !== 'GET') { blocked.push({ method: req.method(), external: true }); return route.abort(); }
            return route.continue();
        });
        for (const route of desktopControl ? [] : selectedRoutes) {
            const scenarios = [
                { width: 320, height: 900 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 },
                { width: 900, height: 320 }, { width: 568, height: 320 },
                { width: 320, height: 900, textScale: 200 }, { width: 390, height: 844, textScale: 200 },
                { width: 768, height: 1024, textScale: 200 }, { width: 1280, height: 900, textScale: 200 },
                { width: 320, height: 900, longLabels: true }, { width: 390, height: 844, longLabels: true },
                { width: 320, height: 900, longLabels: true, textScale: 200 }, { width: 390, height: 844, longLabels: true, textScale: 200 },
                { width: 768, height: 1024, longLabels: true, textScale: 200 }, { width: 568, height: 320, longLabels: true, textScale: 200 },
                { width: 320, height: 900, longLabels: true, textScale: 200, safeArea: 34 },
                { width: 390, height: 844, longLabels: true, textScale: 200, safeArea: 34 },
                { width: 568, height: 320, longLabels: true, textScale: 200, safeArea: 34 }
            ];
            for (const scenario of selectedScenarios || scenarios) for (const expanded of [false, true]) await readyCase(page, route,
                { ...scenario, ...(route === '/dashboard' ? { chooserOpen: expanded } : { chooserClosed: !expanded }) });
            if (selectedScenarios) continue;
            // A final default document matches the retained baseline's parity states.
            await readyCase(page, route, { width: 390, height: 844, safeArea: 34 });
            for (const size of [{ width: 844, height: 390 }, { width: 320, height: 900 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
                await page.setViewportSize(size); const geometry = await measure(page), activations = await exerciseFooter(page);
                results.push({ route, resize: size, geometry, activations, pass: geometryPass(geometry) && activations.every(row => row.pass) });
            }
            await page.emulateMedia({ media: 'print' }); const printed = await measure(page);
            assert.equal(printed.navDisplay, 'none'); assert.equal(printed.tailHeight, 'auto');
            results.push({ route, print: true, geometry: printed });
            await page.emulateMedia({ media: 'screen' });
            await page.locator('.dashboard-mobile-nav').evaluate(nav => { nav.hidden = true; });
            const hidden = await measure(page); assert.equal(hidden.tailHeight, 'auto');
            results.push({ route, absent: 'hidden-nav', geometry: hidden });
            await page.locator('.dashboard-mobile-nav').evaluate(nav => nav.remove());
            const absent = await measure(page); assert.equal(absent.nav, null); assert.equal(absent.tailHeight, 'auto');
            results.push({ route, absent: 'removed-nav', geometry: absent });
            for (const view of ['signed-out', 'loading', 'selection', 'denied']) {
                state = view; textScale = 100; safeArea = 0;
                await page.goto('about:blank'); await page.goto(base + route, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(expected => document.body.dataset.dashboardState === expected, view === 'signed-out' ? 'unauthenticated' : view);
                const geometry = await measure(page); assert.equal(geometry.nav, null);
                results.push({ route, view, geometry });
            }
        }
        if (!baseline && !selectedScenarios) for (const route of selectedRoutes) {
            const journeys = [
                { width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 },
                { width: 568, height: 320 }, { width: 390, height: 844, textScale: 200 },
                { width: 320, height: 900, textScale: 200, longLabels: true, safeArea: 34 },
                { width: 390, height: 844, textScale: 200, longLabels: true, safeArea: 34 },
                { width: 568, height: 320, textScale: 200, longLabels: true, safeArea: 34 }
            ];
            for (const scenario of journeys.filter(row => !desktopControl || row.width === 1280)) for (const expanded of [false, true]) await questionnaireJourney(page, route,
                { ...scenario, ...(route === '/dashboard' ? { chooserOpen: expanded } : { chooserClosed: !expanded }) });
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(violations, []); assert.deepEqual(hashes(), before);
        assert.equal(hash(fs.readFileSync(__filename)), regressionHash, 'Regression source stays frozen during browser execution');
        if (process.env.NOFRIES_FOOTER_BASELINE && !desktopControl && !selectedScenarios) {
            const control = JSON.parse(fs.readFileSync(process.env.NOFRIES_FOOTER_BASELINE, 'utf8'));
            assert.equal(control.mode, 'baseline-observation');
            const parity = row => row.view || row.print || row.absent;
            for (const row of results.filter(parity)) {
                const prior = control.results.find(other => row.route === other.route && row.view === other.view && row.print === other.print && row.absent === other.absent);
                assert.ok(prior, 'Matched original baseline parity case'); const a = row.geometry, b = prior.geometry;
                assert.equal(a.state, b.state); assert.equal(a.scrollWidth, b.scrollWidth);
                assert.ok(Math.abs(a.scrollHeight - b.scrollHeight) <= 1, 'Unchanged no-nav/print scroll extent');
                for (const field of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(a.footer[field] - b.footer[field]) <= 1, 'Unchanged no-nav/print footer geometry');
            }
            for (const row of results.filter(row => row.scenario?.width > 768 && !row.scenario.textScale && !row.scenario.longLabels && !row.scenario.chooserOpen && !row.scenario.chooserClosed)) {
                const prior = control.results.find(other => other.route === row.route && other.scenario?.width === row.scenario.width && !other.scenario.textScale && !other.scenario.longLabels);
                if (prior) for (const field of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(row.end.footer[field] - prior.end.footer[field]) <= 1, 'Unchanged desktop footer geometry');
            }
        }
        if (baseline) for (const route of ['/dashboard', '/']) {
            const red = results.find(row => row.route === route && row.scenario?.width === 320 && !row.scenario.textScale && !row.scenario.longLabels);
            assert.equal(red.end.hit, false, route + ' original complete targets must be obstructed');
            assert.equal(red.activations.find(row => row.href === '/roadmap.html').tapped, false);
        } else if (!desktopControl) assert.equal(results.filter(row => row.pass === false).length, 0, 'All complete footer targets, labels, taps and focus rings must pass');
        console.log(JSON.stringify({ mode, baselineReproduced: baseline,
            candidatePassed: mode === 'candidate-acceptance', scenarios: results.length, failedTargetCases: results.filter(row => row.pass === false).length,
            activations: results.reduce((sum, row) => sum + (row.activations?.length || 0), 0), reportTailBytes: reportTail.length, browser: browser.version(), artifacts }));
    } catch (error) { failure = error.message; console.error(error.stack); process.exitCode = 1; }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ mode,
            candidatePassed: mode === 'candidate-acceptance' && !failure, failure, browser: browser?.version(), regressionHash, results, requests, blocked, errors, violations, scrollTimings,
            homeCssSha256: hash(homeCss), dashboardCssSha256: hash(dashboardCss), reportTailBytes: reportTail.length,
            reportTailSha256: reportTail.length ? hash(reportTail) : null, sourceHashesBefore: before, sourceHashesAfter: hashes() }, null, 2), { mode: 0o600 });
        if (context) await context.close(); if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        console.log('Evidence: ' + path.join(artifacts, 'results.json'));
    }
})();
