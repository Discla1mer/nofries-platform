'use strict';

// Actual local Chromium, current renderer/CSS and the immutable PR582 shell.
// All HTTP and saved writes are loopback fixtures. No browser storage, customer
// session, provider request, dependency installation, merge or release action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const shellRef = '231598ba288f2d4148fd0c05c335ee33a8703ebf';
const artifacts = path.resolve(process.env.NOFRIES_RECOVERY_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-recovery-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep synthetic artifacts outside the checkout');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const { buildDashboardDocument } = require(path.join(root, 'lib/dashboardDocument'));
const { buildGatewayDocument } = require(path.join(root, 'lib/gatewayDocument'));
const { buildFixtures, createSyntheticTransport } = require(path.join(root, 'scripts/build-ncsc-questionnaire-preview'));
const read = file => fs.readFileSync(path.join(root, file));
const pinned = file => execFileSync('git', ['show', shellRef + ':' + file], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const bundle = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const sources = ['app/dashboard.css', 'home.css', 'js/dashboard-loader.js', 'app/dashboard.html', 'index.html',
    'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'scripts/build-ncsc-questionnaire-preview.js',
    'api/shared/ncscQuestionnaireMetadata.js', 'scripts/tests/questionnaire-recovery-hierarchy-browser.cjs',
    ...bundle.map(file => 'api/shared/protectedAssets/' + file)];
const hashes = () => Object.fromEntries(sources.map(file => [file, sha256(read(file))]));
const before = hashes(), app = bundle.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n');
const css = read('app/dashboard.css').toString();
const shellFiles = ['app/dashboard.html', 'index.html', 'js/dashboard-loader.js'];
const shellHashes = Object.fromEntries(shellFiles.map(file => [file, sha256(pinned(file))]));
const documents = Object.fromEntries([['/dashboard', 'app/dashboard.html'], ['/', 'index.html']].map(([url, file]) =>
    [url, (url === '/' ? buildGatewayDocument : buildDashboardDocument)({ customerLogin: true, customerTransport: 'auto',
        template: pinned(file), loaderSource: pinned('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: css })]));
const baselineRef = 'fd3e0480a70c92255514347d6cdd0535f2415bfe';
const baselineModule = execFileSync('git', ['show', baselineRef + ':api/shared/protectedAssets/ncscQuestionnaire.js'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const baselineApp = bundle.map(file => file === 'ncscQuestionnaire.js' ? baselineModule : read('api/shared/protectedAssets/' + file).toString()).join('\n');
const baselineDocuments = Object.fromEntries([['/dashboard', 'app/dashboard.html'], ['/', 'index.html']].map(([url, file]) =>
    [url, (url === '/' ? buildGatewayDocument : buildDashboardDocument)({ customerLogin: true, customerTransport: 'auto',
        template: pinned(file), loaderSource: pinned('js/dashboard-loader.js'), protectedAppSource: baselineApp, protectedStyleSource: css })]));
let baselineMode = false, navigationSequence = 0, enlargedTextMode = false;
const fixture = buildFixtures(), seed = fixture.tenants[0], model = seed.model;
const bindingId = '10000000-0000-4000-8000-000000000001';
const moduleView = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
    module: model.modules.find(row => row.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
    services: [], admissionGranted: false, providerAccessGranted: false, metadata: fixture.metadata, presentationMode: 'editable' };
const assets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')], '/images/nofrieslogo.png': ['image/png', read('images/nofrieslogo.png')] };
const errors = [], violations = [], unexpected = [], requests = [], results = [], injectedFaults = [];
let transport, holdWrites = false, held = [], operations = [], expectedLoss = null;
const writeEvents = new EventEmitter();
async function awaitingHeldWrite() {
    if (held.length) return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { writeEvents.off('held', done); reject(new Error('Synthetic write did not reach held response')); }, 10000);
        function done() { clearTimeout(timer); resolve(); }
        writeEvents.once('held', done);
    });
}
function reset() {
    assert.equal(held.length, 0, 'Previous synthetic responses were released');
    assert.ok(!expectedLoss || expectedLoss.remaining === 0, 'Every explicitly armed response loss was consumed');
    transport = createSyntheticTransport(seed, fixture.metadata, fixture); operations = []; holdWrites = false; expectedLoss = null;
}
const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname });
    let body, type = 'application/json', status = 200;
    try {
        if (url.pathname.startsWith('/api/dashboard/ncsc/assessments')) {
            const parts = []; for await (const part of request) parts.push(part);
            const text = Buffer.concat(parts).toString();
            if (request.method === 'POST') {
                operations.push({ path: url.pathname, body: JSON.parse(text) });
                if (holdWrites) await new Promise(resolve => { held.push(resolve); writeEvents.emit('held'); });
            }
            const reply = await transport.fetch(url.pathname + url.search, { method: request.method, ...(text ? { body: text } : {}) });
            status = reply.status; body = JSON.parse(await reply.text());
        } else if (request.method !== 'GET') { unexpected.push(request.method + ' ' + url.pathname); status = 405; body = {}; }
        else if (documents[url.pathname]) {
            body = (baselineMode ? baselineDocuments : documents)[url.pathname].html; type = 'text/html';
            response.setHeader('Content-Security-Policy', (baselineMode ? baselineDocuments : documents)[url.pathname].contentSecurityPolicy);
        } else if (url.pathname === '/api/dashboard/app.js') { body = baselineMode ? baselineApp : app; type = 'text/javascript'; }
        else if (url.pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
        else if (url.pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true,
            purpose: 'customer', accountType: 'company', generation: 'a'.repeat(64), selectedBindingId: bindingId,
            expiresAt: new Date(Date.now() + 3600000).toISOString() };
        else if (url.pathname === '/api/dashboard/organisations') body = { schemaVersion: 1,
            bindings: [{ bindingId, organisationLabel: 'Synthetic recovery organisation' }], nextAfterBindingId: null };
        else if (url.pathname === '/api/dashboard/bootstrap') body = model;
        else if (url.pathname === '/api/dashboard/modules/cyber_security') body = moduleView;
        else if (url.pathname === '/roadmap.html') { body = '<!doctype html><title>Synthetic destination</title>'; type = 'text/html'; }
        else if (['/js/home.js', '/js/organisation-setup.js'].includes(url.pathname)) { body = read(url.pathname.slice(1)); type = 'text/javascript'; }
        else if (url.pathname === '/js/prospect-assistant.js') { body = pinned('js/prospect-assistant.js'); type = 'text/javascript'; }
        else if (assets[url.pathname]) [type, body] = assets[url.pathname];
        else { unexpected.push(request.method + ' ' + url.pathname); status = 404; body = {}; }
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(type === 'application/json' ? JSON.stringify(body) : body);
    } catch (error) {
        // One explicitly armed save may commit in the synthetic store and lose
        // its HTTP response. Consume only that exact injected fault; all other
        // errors remain fatal. A post-commit503 withholds the acknowledgement
        // deterministically: Chromium may transparently replay a raw closed
        // localhost connection, which otherwise confirms this exact receipt.
        if (expectedLoss?.remaining === 1 && request.method === 'POST' && url.pathname === expectedLoss.path &&
            error.message === 'Synthetic response lost after in-memory commit') {
            expectedLoss.remaining = 0;
            injectedFaults.push({ code: 'synthetic_acknowledgement_unavailable_after_commit', path: url.pathname,
                consumed: true, committedInMemory: true, acknowledged: false, wireStatus: 503 });
            response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ code: 'ncsc_unavailable' }));
        } else { errors.push(error.message); response.writeHead(500); response.end('{}'); }
    }
});
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function listenerCount(page) { return page.evaluate(() => window.recoveryListeners.size); }
async function dirty(page, option = 'partial') {
    const answer = page.locator('.ncsc-answer input[value="' + option + '"]');
    await answer.focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('.ncsc-answer input[value="' + option + '"]').isChecked(), true);
    assert.equal(await listenerCount(page), 1, 'Exactly one conditional native warning is mounted');
}
async function cancelReload(page) {
    const original = page.url();
    const dialogReady = page.waitForEvent('dialog');
    const reload = page.reload({ waitUntil: 'domcontentloaded' }).then(() => ({ completed: true }), error => ({ aborted: error.message }));
    const dialog = await dialogReady;
    assert.equal(dialog.type(), 'beforeunload', 'This is Chromium native unload protection');
    await dialog.dismiss();
    const outcome = await reload;
    assert.ok(outcome.aborted || !outcome.completed, 'Canceled native reload does not replace the document');
    assert.equal(page.url(), original);
    return { type: dialog.type(), browserOwnsWording: true, canceled: true };
}
async function overflow(page, locator, baseline) {
    await locator.scrollIntoViewIfNeeded(); await settle(page);
    const value = await locator.evaluate(element => {
        const rect = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
        const questionnaire = document.querySelector('.ncsc-questionnaire'), box = questionnaire.getBoundingClientRect();
        const elementOutliers = [...questionnaire.querySelectorAll('*')].map(node => {
            const item = node.getBoundingClientRect(); return { tag: node.tagName, id: node.id, left: item.left, right: item.right, width: item.width, height: item.height };
        }).filter(item => item.width > 0 && item.height > 0 && (item.left < -1 || item.right > innerWidth + 1));
        function textOutliers(scope) {
            const rows = [], walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT); let text;
            while ((text = walker.nextNode())) {
                if (!text.textContent.trim()) continue;
                const owner = text.parentElement, range = document.createRange(); range.selectNodeContents(text);
                for (const line of range.getClientRects()) if (line.width > 0 && line.height > 0 && (line.left < -1 || line.right > innerWidth + 1)) {
                    rows.push({ tag: owner.tagName, id: owner.id, cls: owner.className, text: text.textContent.trim(),
                        left: line.left, right: line.right, inQuestionnaire: Boolean(owner.closest('.ncsc-questionnaire')) });
                }
            }
            return rows;
        }
        return { viewport: innerWidth, left: rect.left, right: rect.right, width: rect.width,
            questionnaire: { left: box.left, right: box.right, elementOutliers, textOutliers: textOutliers(questionnaire) },
            documentTextOutliers: textOutliers(document.body),
            scrollWidth: document.documentElement.scrollWidth,
            lines: [...range.getClientRects()].filter(row => row.width > 0).map(row => ({ left: row.left, right: row.right })) };
    });
    assert.ok(value.left >= -1 && value.right <= value.viewport + 1, 'Component fits viewport');
    assert.ok(value.lines.every(row => row.left >= value.left - 1 && row.right <= value.right + 1), 'Text wraps inside component');
    assert.ok(value.questionnaire.left >= -1 && value.questionnaire.right <= value.viewport + 1, 'Questionnaire root fits the viewport');
    assert.deepEqual(value.questionnaire.elementOutliers, [], 'Every visible questionnaire descendant element fits the viewport');
    assert.deepEqual(value.questionnaire.textOutliers, [], 'Every visible questionnaire text range fits the viewport');
    if (value.scrollWidth > value.viewport + 1) {
        assert.ok(baseline?.knownInherited, 'Unexpected document overflow: ' + JSON.stringify(value));
        assert.equal(value.viewport, 320);
        assert.ok(Math.abs(baseline.documentWidth - 358) <= 1, 'Fresh exact baseline matches the known358px shell limit');
        assert.ok(value.documentTextOutliers.length > 0);
        assert.ok(value.documentTextOutliers.every(row => !row.inQuestionnaire && (
            row.tag === 'H2' && row.id === 'dashboardChooserHeading' && row.text === 'Your organisations' ||
            row.tag === 'BUTTON' && row.cls.split(' ').includes('dashboard-task') && row.text === 'More')),
        'All inherited outlier text remains in the exact known outer chooser/task owners');
        assert.equal(baseline.chooser.text, 'Your organisations');
        assert.ok(baseline.chooser.lines.some(line => line.right > value.viewport + 1), 'Baseline proves the outside-owner chooser text overflow');
        assert.ok(value.scrollWidth <= baseline.documentWidth + 1, 'Candidate cannot increase inherited outer-shell overflow');
        value.inheritedShellOverflow = { baselineWidth: baseline.documentWidth, candidateWidth: value.scrollWidth,
            owner: '#dashboardChooserHeading', text: baseline.chooser.text, baselineGlyphLines: baseline.chooser.lines, candidateOutlierText: value.documentTextOutliers };
    }
    return value;
}
async function normalOpen(page, origin, shell) {
    await page.goto(origin + shell + '?recovery=' + (++navigationSequence) + '#cyber-security');
    await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
    await page.locator('.ncsc-assessment-list button').first().click();
    await page.locator('#ncsc-question-index').waitFor();
    if (enlargedTextMode) await doubleText(page);
}
async function doubleText(page) {
    await page.evaluate(() => {
        if (!window.recoveryTextObserver) {
            const originals = new Map(); let scheduled = false;
            function enlarge() {
                // Restore authored sizes before each measurement, so surviving
                // and newly rendered nodes receive exactly 200%, never 400%.
                originals.forEach((value, element) => {
                    if (value.text) element.style.setProperty('font-size', value.text, value.priority);
                    else element.style.removeProperty('font-size');
                });
                const elements = [...document.querySelectorAll('body, body *')];
                const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
                elements.forEach((element, index) => {
                    if (!originals.has(element)) originals.set(element, { text: element.style.getPropertyValue('font-size'), priority: element.style.getPropertyPriority('font-size') });
                    element.style.setProperty('font-size', (sizes[index] * 2) + 'px', 'important');
                });
                scheduled = false;
            }
            window.recoveryTextObserver = new MutationObserver(() => {
                if (!scheduled) { scheduled = true; requestAnimationFrame(enlarge); }
            });
            window.recoveryTextObserver.observe(document.body, { childList: true, subtree: true });
            enlarge();
        }
    });
    await settle(page);
}

(async () => {
    let browser, failure = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const shell of ['/dashboard', '/']) for (const [width, enlarged] of [[1280, false], [390, false], [320, false], [390, true], [320, true]]) {
            reset(); enlargedTextMode = enlarged;
            const caseStarted = Date.now();
            const context = await browser.newContext({ viewport: { width, height: width === 320 ? 740 : 950 }, hasTouch: width < 500,
                reducedMotion: width === 1280 ? 'no-preference' : 'reduce' });
            await context.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin) { unexpected.push('Blocked outside request'); return route.abort(); }
                return route.continue();
            });
            await context.addInitScript(() => {
                window.recoveryListeners = new Set(); window.recoveryMounts = [];
                const add = window.addEventListener, remove = window.removeEventListener;
                window.addEventListener = function (type, listener, options) { if (type === 'beforeunload') window.recoveryListeners.add(listener); return add.call(this, type, listener, options); };
                window.removeEventListener = function (type, listener, options) { if (type === 'beforeunload') window.recoveryListeners.delete(listener); return remove.call(this, type, listener, options); };
                let factory;
                Object.defineProperty(window, 'NoFriesNcscQuestionnaire', { configurable: true, get: () => factory, set(value) {
                    factory = { ...value, mount(...args) { const controller = value.mount(...args); window.recoveryMounts.push({ controller, args }); return controller; } };
                } });
                document.addEventListener('securitypolicyviolation', event => console.error('RECOVERY_CSP:' + event.effectiveDirective));
            });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.text().startsWith('RECOVERY_CSP:')) violations.push(message.text()); });
            // Compare the same accepted task in exact-main and candidate modules
            // under identical PR582 shell/CSS/fixtures. Query identities force
            // full document navigation when switching the immutable app bytes.
            baselineMode = true; await normalOpen(page, origin, shell); if (enlarged) await doubleText(page);
            const baselineHierarchy = await page.locator('.ncsc-questionnaire').evaluate(element => {
                const root = element.getBoundingClientRect(), question = element.querySelector('.ncsc-question').getBoundingClientRect();
                const chooser = document.getElementById('dashboardChooserHeading'), range = document.createRange();
                if (chooser) range.selectNodeContents(chooser);
                return { taskOffset: question.top - root.top, font: getComputedStyle(element.querySelector('legend')).fontSize,
                    documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
                    chooser: chooser ? { text: chooser.textContent, lines: [...range.getClientRects()].filter(row => row.width > 0).map(row => ({ left: row.left, right: row.right })) } : null,
                    optionalBeforeTask: Boolean(element.querySelector('.ncsc-workshop').compareDocumentPosition(element.querySelector('.ncsc-question')) & Node.DOCUMENT_POSITION_FOLLOWING) };
            });
            baselineHierarchy.knownInherited = shell === '/' && width === 320 && enlarged;
            if (baselineHierarchy.knownInherited) assert.ok(Math.abs(baselineHierarchy.documentWidth - 358) <= 1, 'Known gateway320/200 shell overflow has not grown');
            baselineMode = false; reset(); await normalOpen(page, origin, shell);
            assert.equal(await listenerCount(page), 0, 'Clean acknowledged draft has no unload handler');
            const cleanDialogs = []; const observe = dialog => { cleanDialogs.push(dialog.type()); dialog.dismiss(); };
            page.on('dialog', observe); await page.reload(); await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready'); page.off('dialog', observe);
            if (enlarged) await doubleText(page);
            assert.deepEqual(cleanDialogs, [], 'Clean browser reload has no native warning');
            await button(page, 'Start an assessment').click(); const scope = page.locator('#ncsc-scope');
            await scope.fill(' \n\t '); assert.equal(await listenerCount(page), 0, 'Whitespace-only scope is not meaningful dirty content');
            await scope.fill('Synthetic declared scope 😀'); assert.equal(await listenerCount(page), 1);
            await cancelReload(page); assert.equal(await scope.inputValue(), 'Synthetic declared scope 😀');
            await button(page, 'Back to assessments').click(); await button(page, 'Discard unsent changes').click();
            assert.equal(await listenerCount(page), 0);
            await page.locator('.ncsc-assessment-list button').first().click(); await page.locator('#ncsc-question-index').waitFor();
            if (enlarged) await doubleText(page);
            const workshop = page.locator('#ncsc-workshop');
            assert.equal(await workshop.evaluate(element => element.tagName === 'DETAILS' && !element.open), true, 'Optional workshop starts collapsed');
            assert.equal(await page.locator('.ncsc-content').evaluate(element => Boolean(element.compareDocumentPosition(document.getElementById('ncsc-workshop')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Current task precedes optional workshop');
            assert.equal(await button(page, 'Save progress').getAttribute('class'), 'dashboard-button');
            assert.equal(await button(page, 'Submit assessment').getAttribute('class'), 'dashboard-text-button');
            assert.equal(await button(page, 'Submit assessment').getAttribute('aria-describedby'), 'ncsc-submit-consequence');
            assert.match(await page.locator('#ncsc-submit-consequence').textContent(), /read-only/);
            const screenshotPrefix = (shell === '/' ? 'gateway' : 'dashboard') + '-' + width + (enlarged ? '-200text' : '');
            const hierarchy = await page.locator('.ncsc-questionnaire').evaluate(element => {
                const root = element.getBoundingClientRect(), question = element.querySelector('.ncsc-question').getBoundingClientRect();
                return { taskOffset: question.top - root.top, font: getComputedStyle(element.querySelector('legend')).fontSize, optionalAfterTask: Boolean(element.querySelector('.ncsc-content').compareDocumentPosition(element.querySelector('#ncsc-workshop')) & Node.DOCUMENT_POSITION_FOLLOWING) };
            });
            hierarchy.baseline = baselineHierarchy; hierarchy.reduction = baselineHierarchy.taskOffset - hierarchy.taskOffset;
            assert.ok(hierarchy.reduction > 0, 'Disclosing optional material reduces vertical task displacement');
            assert.equal(baselineHierarchy.optionalBeforeTask, true); assert.equal(hierarchy.optionalAfterTask, true);
            assert.equal(hierarchy.font, enlarged ? '40px' : '20px', 'Current question is genuinely doubled when text stress is selected');
            const taskGeometry = await overflow(page, page.locator('.ncsc-question'), baselineHierarchy);
            await page.locator('.ncsc-question').screenshot({ path: path.join(artifacts, screenshotPrefix + '-question.png') });
            await page.locator('#ncsc-title').scrollIntoViewIfNeeded(); await settle(page);
            await page.screenshot({ path: path.join(artifacts, screenshotPrefix + '-task.png') });
            const submitGeometry = await overflow(page, page.locator('.ncsc-final-submission'), baselineHierarchy);
            await page.locator('.ncsc-actions').last().screenshot({ path: path.join(artifacts, screenshotPrefix + '-save-submit.png') });
            await dirty(page);
            const reloadWarning = await cancelReload(page);
            assert.equal(await page.locator('.ncsc-answer input[value="partial"]').isChecked(), true, 'Native cancel retains the exact local answer');
            holdWrites = true; const startWrites = operations.length;
            await button(page, 'Save progress').click();
            await page.waitForFunction(() => document.querySelector('.ncsc-warning')?.textContent.includes('Operation in progress'));
            assert.equal(await listenerCount(page), 1, 'Pending acknowledgement retains native protection');
            await button(page, 'Save progress').evaluate(element => { element.click(); element.click(); });
            assert.equal(operations.length, startWrites + 1, 'Repeated pending Save activations send one operation');
            const pendingWarning = await cancelReload(page);
            assert.equal(await page.locator('.ncsc-answer input[value="partial"]').isChecked(), true);
            holdWrites = false; held.splice(0).forEach(resolve => resolve());
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            assert.equal(await listenerCount(page), 0, 'Only acknowledged successful Save removes the handler');
            const savedBody = operations.at(-1).body;
            assert.equal(savedBody.expectedRevision, 1); assert.equal(savedBody.payload.responses.length, 1);
            await dirty(page, 'no');
            const footer = page.locator('footer a[href="/roadmap.html"]');
            await footer.focus(); await page.keyboard.press('Enter'); await page.locator('dialog[open]').waitFor();
            assert.equal(await button(page, 'Stay here').evaluate(element => element === document.activeElement), true);
            for (const name of ['Save and leave', 'Discard unsent changes', 'Stay here']) { await page.keyboard.press('Tab'); assert.equal(await button(page, name).evaluate(element => element === document.activeElement), true); }
            for (const name of ['Discard unsent changes', 'Save and leave', 'Stay here']) { await page.keyboard.press('Shift+Tab'); assert.equal(await button(page, name).evaluate(element => element === document.activeElement), true); }
            if (width < 500) await button(page, 'Stay here').tap(); else await button(page, 'Stay here').click();
            assert.equal(await listenerCount(page), 1);
            assert.equal(await page.locator('.ncsc-answer input[value="no"]').isChecked(), true);
            await footer.focus(); await page.keyboard.press('Enter'); await page.locator('dialog[open]').waitFor();
            await button(page, 'Discard unsent changes').click(); await page.waitForURL(origin + '/roadmap.html');
            const discardNavigation = true;
            await normalOpen(page, origin, shell);
            assert.equal(await listenerCount(page), 0); await page.locator('#ncsc-question-index').selectOption('3');
            assert.equal(await page.locator('.ncsc-answer input[value="partial"]').isChecked(), true, 'Discard retains acknowledged saved answer');
            await dirty(page, 'no'); const beforeLeave = operations.length;
            await footer.focus(); await page.keyboard.press('Enter'); await page.locator('dialog[open]').waitFor();
            await button(page, 'Save and leave').click(); await page.waitForURL(origin + '/roadmap.html');
            assert.equal(operations.length, beforeLeave + 1, 'Save-and-leave acknowledges one write before navigation');
            await normalOpen(page, origin, shell); await page.locator('#ncsc-question-index').selectOption('3');
            assert.equal(await page.locator('.ncsc-answer input[value="no"]').isChecked(), true);
            // Disclosure is native-keyboard operable and survives a Save rerender,
            // including focus on a retained source link and both open states.
            const summary = page.locator('#ncsc-workshop-title');
            await summary.focus(); await page.keyboard.press('Space'); assert.equal(await workshop.evaluate(element => element.open), true);
            assert.equal(await page.locator('#ncsc-workshop-pdf').getAttribute('download'), 'No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.pdf');
            await page.locator('#ncsc-workshop-sources-title').focus(); await page.keyboard.press('Enter');
            assert.equal(await page.locator('.ncsc-workshop-sources').evaluate(element => element.open), true);
            const workshopGeometry = await overflow(page, workshop, baselineHierarchy);
            await workshop.screenshot({ path: path.join(artifacts, screenshotPrefix + '-workshop.png') });
            await dirty(page, 'partial'); holdWrites = true;
            await button(page, 'Save progress').click(); await awaitingHeldWrite();
            const sourceLink = page.locator('#ncsc-workshop-source-4'); await sourceLink.focus();
            holdWrites = false; held.splice(0).forEach(resolve => resolve());
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            assert.equal(await sourceLink.evaluate(element => element === document.activeElement), true, 'Workshop source-link focus survives acknowledged Save rerender');
            assert.equal(await workshop.evaluate(element => element.open), true);
            assert.equal(await page.locator('.ncsc-workshop-sources').evaluate(element => element.open), true);
            await summary.focus(); await page.keyboard.press('Enter');
            // Invalid pending N/A remains in the exact field; error links focus it.
            await dirty(page, 'not_applicable');
            const rationale = page.locator('.ncsc-question textarea'); await rationale.fill('');
            const validationStart = operations.length; await button(page, 'Save progress').click();
            await page.locator('.ncsc-errors a').first().click();
            assert.equal(await rationale.evaluate(element => element === document.activeElement && element.getAttribute('aria-invalid') === 'true'), true);
            const blankError = await page.locator('.ncsc-errors').textContent(); assert.doesNotMatch(blankError, /UTF-16|NUL|Unicode/);
            assert.equal(operations.length, validationStart, 'Invalid rationale makes no write');
            if (enlarged) await doubleText(page);
            const errorGeometry = await overflow(page, page.locator('.ncsc-errors'), baselineHierarchy);
            await page.screenshot({ path: path.join(artifacts, (shell === '/' ? 'gateway' : 'dashboard') + '-' + width + (enlarged ? '-200text' : '') + '-error.png') });
            await rationale.fill('😀'.repeat(2001)); await button(page, 'Save progress').click();
            assert.doesNotMatch(await page.locator('.ncsc-errors').textContent(), /UTF-16|NUL|Unicode/);
            assert.equal(operations.length, validationStart);
            await rationale.evaluate(element => { element.value = 'Synthetic\0unsupported'; element.dispatchEvent(new Event('input', { bubbles: true })); });
            await button(page, 'Save progress').click();
            assert.match(await page.locator('.ncsc-errors').textContent(), /unsupported character/);
            assert.equal(operations.length, validationStart);
            await rationale.fill('Synthetic valid emoji 😀'); await button(page, 'Save progress').click();
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            assert.equal(operations.at(-1).body.payload.responses[0].rationale.text, 'Synthetic valid emoji 😀');
            assert.equal(await listenerCount(page), 0);
            // A lost response committed in memory but is unconfirmed locally.
            // Keep the native warning until retrying the identical command
            // acknowledges it and the current saved version is reconciled.
            await dirty(page, 'no'); expectedLoss = { path: '/api/dashboard/ncsc/assessments/assessment-a/save', remaining: 1 }; transport.setScenario('lost');
            const lostStart = operations.length; await button(page, 'Save progress').click();
            await page.getByRole('heading', { name: 'Operation unconfirmed', exact: true }).waitFor();
            assert.equal(await listenerCount(page), 1);
            await cancelReload(page);
            const lostCommand = operations.at(-1).body;
            await button(page, 'Retry same operation').click();
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('The operation is confirmed'));
            assert.equal(operations.length, lostStart + 2); assert.equal(expectedLoss.remaining, 0);
            assert.deepEqual(operations.at(-1).body, lostCommand, 'Retry retains exact revision, payload and idempotency key');
            assert.equal(await listenerCount(page), 0, 'Acknowledged retry plus reconciliation removes warning');
            // Final submission drains the latest draft before its immutable
            // submit command. Repeated activation cannot duplicate either write.
            await button(page, 'Back to assessments').click();
            await page.locator('.ncsc-assessment-list button').nth(1).click(); await page.locator('#ncsc-question-index').waitFor();
            await dirty(page, 'yes'); const finalStart = operations.length; holdWrites = true;
            await button(page, 'Submit assessment').click(); await awaitingHeldWrite();
            assert.ok(operations.at(-1).path.endsWith('/save'));
            await button(page, 'Submit assessment').evaluate(element => { element.click(); element.click(); });
            assert.equal(operations.length, finalStart + 1);
            const submitRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/submit'));
            held.shift()(); await submitRequest; await awaitingHeldWrite();
            assert.ok(operations.at(-1).path.endsWith('/submit'));
            assert.equal(await listenerCount(page), 1, 'Pending final command warns even when its answer draft is clean');
            await cancelReload(page);
            await button(page, 'Submit assessment').evaluate(element => { element.click(); element.click(); });
            assert.equal(operations.length, finalStart + 2);
            holdWrites = false; held.splice(0).forEach(resolve => resolve());
            await page.locator('.ncsc-sealed').waitFor(); assert.equal(await listenerCount(page), 0);
            assert.deepEqual(operations.slice(finalStart).map(operation => operation.path.split('/').at(-1)), ['save', 'submit']);
            assert.equal(operations[finalStart + 1].body.expectedRevision, operations[finalStart].body.expectedRevision + 1);
            assert.equal(await page.locator('.ncsc-answer input').evaluateAll(inputs => inputs.every(input => input.disabled)), true);
            await button(page, 'Back to assessments').click();
            await page.locator('.ncsc-assessment-list button').first().click(); await page.locator('#ncsc-question-index').waitFor();
            // Remount and repeated destroy must remove the old instance's
            // handler while the real host root is still connected.
            await dirty(page, 'partial');
            await page.evaluate(() => {
                const { args } = window.recoveryMounts.at(-1); window.NoFriesNcscQuestionnaire.mount(...args);
            });
            assert.equal(await listenerCount(page), 0, 'Remount destroys the prior dirty instance handler');
            await page.locator('.ncsc-assessment-list button').first().click(); await page.locator('#ncsc-question-index').waitFor();
            await dirty(page); await page.evaluate(() => { window.recoveryMounts.at(-1).controller.destroy(); window.recoveryMounts.at(-1).controller.destroy(); });
            assert.equal(await listenerCount(page), 0, 'Repeated destroy is harmless and detaches protection');
            await page.evaluate(() => { const { args } = window.recoveryMounts.at(-1); window.NoFriesNcscQuestionnaire.mount(...args); });
            await page.locator('.ncsc-assessment-list button').first().click(); await page.locator('#ncsc-question-index').waitFor();
            // Re-enter through a fresh real host after the deliberate direct
            // module replacement above; the outer host must own this controller.
            await normalOpen(page, origin, shell);
            // PR582's outer guarded transport consumes HTTP403, destroys the
            // questionnaire and renders the dashboard denial before the module
            // receives it. Assert that actual boundary and detached handler.
            await dirty(page, 'no'); transport.setScenario('denied'); await button(page, 'Save progress').click();
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await listenerCount(page), 0, 'Definitive authority denial destroys stale unload protection');
            results.push({ shell, width, enlarged, motion: width === 1280 ? 'default' : 'authored reduced-motion', elapsedMs: Date.now() - caseStarted, cleanReloadNoWarning: true, reloadWarning, pendingWarning, pendingDuplicateSafe: true,
                successfulSave: true, lostResponseExactRetry: true, finalSaveBeforeSubmitIdempotent: true, stayAndKeyboardTrap: true, discardNavigation, saveAndLeave: true, disclosureStateAndFocusRetained: true, meaningfulScopeAndWhitespace: true,
                blankLengthUnsupportedValidation: true, validEmojiPreserved: true, hierarchy, taskGeometry, submitGeometry, workshopGeometry, errorGeometry, deniedDetached: true, remountAndDestroyDetached: true,
                fixtureWrites: operations.length });
            await context.close();
            console.log(JSON.stringify({ completedCase: results.length, shell, width, enlarged }));
        }
        assert.equal(injectedFaults.length, results.length, 'Exactly one explicit response-loss fault per completed case');
        assert.deepEqual(errors, []); assert.deepEqual(violations, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), before);
    } catch (error) { failure = error.stack; }
    finally {
        holdWrites = false; held.splice(0).forEach(resolve => resolve());
        if (browser && failure) {
            const last = browser.contexts().at(-1)?.pages().at(-1);
            if (last) { fs.writeFileSync(path.join(artifacts, 'failure.txt'), await last.locator('body').innerText()); await last.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); }
        }
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure, results,
            errors, violations, unexpected, requests, injectedFaults, sourcesBefore: before, sourcesAfter: hashes(), shellRef, shellHashes, baselineRef, baselineModuleSha256: sha256(baselineModule),
            browser: browser && browser.version(), syntheticOnly: true,
            screenshots: Object.fromEntries(fs.readdirSync(artifacts).filter(file => file.endsWith('.png')).map(file => [file, sha256(fs.readFileSync(path.join(artifacts, file)))])),
            limitations: ['Native unload warnings require user activation and browser-owned wording.', 'Ambiguous-outcome fixture returns503 after syntheticcommit; raw localhost connection loss was transparently retried by Chromium.', 'No guarantee against mobile OS termination; no persistent draft recovery.', 'Synthetic Chromium is not Safari, physical-mobile or assistive-technology acceptance.', 'Shared mobile footer/focus clearance is owned by another lane.', 'Pinned582 gateway320/200 has inherited358px document overflow from #dashboardChooserHeading; candidate may not increase that baseline.'] }, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify({ passed: failure === null, failure, cases: results.length, artifacts }));
    if (failure) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
