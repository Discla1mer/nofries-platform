'use strict';

// Optional real-Chromium regression using an existing Playwright installation.
// node scripts/tests/ask-fry-composer-browser.cjs
// NOFRIES_COMPOSER_ARTIFACTS=/external/path keeps screenshots/receipt outside source.
// NOFRIES_COMPOSER_SOURCE_ROOT=/frozen/source selects a causal RED control.
// NOFRIES_COMPOSER_SOURCE_REF optionally labels that immutable source in the receipt.
// No provider, production API, authentication or protected assessment is exercised.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const checkout = path.resolve(__dirname, '../..');
const root = path.resolve(process.env.NOFRIES_COMPOSER_SOURCE_ROOT || checkout);
const artifacts = path.resolve(process.env.NOFRIES_COMPOSER_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-composer-')));
for (const directory of [root, checkout]) {
    const relative = path.relative(directory, artifacts);
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Keep synthetic artifacts outside source');
}
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sources = ['lib/sharedAssistantDocument.js', 'js/shared-assistant.js', 'js/prospect-assistant.js',
    'shared-assistant.css', 'app/dashboard.css', 'images/fry-chat.png'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const before = hashes();
const { renderSharedAssistant } = require(path.join(root, 'lib/sharedAssistantDocument'));
const markup = renderSharedAssistant({ fryAssetPath: '/images/fry-chat.png', page: 'dashboard', helpOnly: true });
// The real dashboard stylesheet supplies the fixed/wrapped taskbar geometry.
// No protected application module is mounted or assessment request is served.
const html = '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic public composer regression</title>' +
    '<link rel="stylesheet" href="/app/dashboard.css"><link rel="stylesheet" href="/shared-assistant.css">' +
    '<style>body{margin:0;background:#08100f;color:#f6faf9;font:16px/1.5 system-ui}.fixture-main{padding:16px;min-height:1600px}' +
    '.fixture-main button{font:inherit;min-height:44px}.fixture-main p{max-width:40rem}</style></head><body>' +
    '<main class="fixture-main"><h1>Synthetic public help</h1><p>Loopback fixture only. No private assessment, customer, provider or production connection.</p>' +
    '<button id="fixture-help" data-assistant-open data-assistant-topic="dashboard">Open public help</button> ' +
    '<button id="outside-focus">Unrelated page control</button></main>' +
    '<div class="nofries-dashboard"><nav class="dashboard-mobile-nav" aria-label="Dashboard tasks">' +
    ['Home', 'Assess', 'Plan', 'Proof', 'More'].map(label => '<button class="dashboard-task" type="button">' + label + '</button>').join('') +
    '</nav></div>' + markup + '<script src="/js/prospect-assistant.js"></script><script src="/js/shared-assistant.js"></script></body></html>';
const assets = new Map(sources.filter(file => !file.startsWith('lib/')).map(file => ['/' + file, file]));
const results = [], errors = [], outside = [], requests = [], screenshots = [];
const session = { assistant: { publicHelpOnly: true, publicHelpProtocol: 'public-help-v1', runtime: { mode: 'mock' } } };
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: request.url });
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(html);
    }
    if (request.method === 'GET' && request.url === '/api/prospect/session?publicHelpOnly=true') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(session));
    }
    if (request.method === 'POST' && url.pathname === '/api/prospect/chat') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requests.at(-1).body = body;
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end('event: done\ndata: ' + JSON.stringify({ text: 'Synthetic public reply only.', runtime: { mode: 'mock' } }) + '\n\n');
        });
        return;
    }
    if (request.method === 'GET' && assets.has(url.pathname)) {
        const file = assets.get(url.pathname);
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript';
        response.writeHead(200, { 'Content-Type': type }); return response.end(fs.readFileSync(path.join(root, file)));
    }
    outside.push(request.method + ' ' + request.url); response.writeHead(404); response.end();
});
const apiCount = () => requests.filter(request => request.path.startsWith('/api/')).length;
const waitForFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function doubleText(page) {
    await page.evaluate(() => {
        const sizes = [...document.querySelectorAll('body *')].map(node => [node, parseFloat(getComputedStyle(node).fontSize)]);
        // Match the original combined-UX text stress. Existing author-important
        // dashboard taskbar typography stays authored; every public font doubles.
        sizes.forEach(([node, size]) => { node.style.fontSize = size * 2 + 'px'; });
    });
    await waitForFrames(page);
}
async function metrics(page) {
    return page.evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const header = document.querySelector('.nf-assistant-header'), composer = document.querySelector('.nf-assistant-compose');
        const dialog = document.querySelector('#nofries-assistant-dialog'), nav = document.querySelector('.dashboard-mobile-nav');
        const controls = ['#assistant-input', '#assistant-form button[type="submit"]'].map(selector => {
            const node = document.querySelector(selector), box = rect(node);
            const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
            return { selector, box, centreHit: hit === node || node.contains(hit),
                actualHit: hit && { tag: hit.tagName, id: hit.id, className: hit.className }, focused: node === document.activeElement };
        });
        return { header: rect(header), composer: rect(composer), dialog: rect(dialog), nav: getComputedStyle(nav).display === 'none' ? null : rect(nav),
            controls, active: document.activeElement.id || document.activeElement.tagName, viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth, publicOnly: document.querySelector('[data-shared-assistant]').dataset.assistantHelpOnly };
    });
}
function geometryProblems(metric) {
    const failed = [], { header, composer, dialog, nav, viewport } = metric;
    if (composer.top < header.bottom - .5) failed.push('composer overlaps sticky header by ' + (header.bottom - composer.top).toFixed(2) + 'px');
    if (composer.bottom > dialog.bottom + .5) failed.push('composer extends below dialog');
    if (composer.left < dialog.left - .5 || composer.right > dialog.right + .5) failed.push('composer extends outside dialog width');
    if (dialog.top < -.5 || dialog.left < -.5 || dialog.bottom > viewport.height + .5 || dialog.right > viewport.width + .5) failed.push('dialog extends outside viewport');
    if (nav && dialog.bottom > nav.top + .5) failed.push('dialog overlaps fixed dashboard navigation');
    if (metric.documentWidth > viewport.width + 1) failed.push('fixture page overflows horizontally');
    metric.controls.forEach(control => {
        if (!control.centreHit) failed.push(control.selector + ' centre is obscured');
        if (control.box.top < header.bottom - .5 || control.box.bottom > dialog.bottom + .5) failed.push(control.selector + ' is not fully visible');
    });
    return failed;
}
async function checkGeometry(page, label, observations) {
    // Allow browser layout/ResizeObserver/requestAnimationFrame delivery, without
    // scrolling or focusing from the test to repair the state under examination.
    await waitForFrames(page);
    const metric = await metrics(page), problems = geometryProblems(metric);
    observations.push({ label, metric, problems });
    assert.deepEqual(problems, [], label + ': ' + problems.join('; '));
    return metric;
}
async function screenshot(page, filename) {
    await page.screenshot({ path: path.join(artifacts, filename) }); screenshots.push(filename);
}
(async () => {
    let browser, fatal = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function runCase(name, viewport, action) {
        const observations = [], start = Date.now();
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const request = route.request();
            if (new URL(request.url()).origin !== origin) { outside.push(request.method() + ' external origin'); return route.abort(); }
            return route.continue();
        });
        let failure = null;
        try {
            const initialRequests = apiCount(); await page.goto(origin);
            assert.equal(apiCount(), initialRequests, 'Mount must not bootstrap public help');
            await action(page, observations);
        } catch (error) {
            failure = error.message;
            await screenshot(page, name + '-failure.png');
        } finally {
            results.push({ name, viewport, passed: failure === null, failure, observations, milliseconds: Date.now() - start });
            console.log((failure ? 'FAIL ' : 'PASS ') + name + (failure ? ': ' + failure : ''));
            await context.close();
        }
    }
    async function open(page, opener = '[data-assistant-launcher]') {
        await page.locator(opener).click();
        await page.waitForFunction(() => !document.getElementById('assistant-input').disabled && document.activeElement.id === 'assistant-input');
    }
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 568, height: 320 }]) {
            for (const enlarged of [false, true]) {
                const name = viewport.width + 'x' + viewport.height + (enlarged ? '-text200' : '-normal');
                await runCase(name, viewport, async (page, observations) => {
                    if (enlarged) await doubleText(page);
                    await open(page); await page.locator('#assistant-input').fill('Synthetic public draft');
                    await checkGeometry(page, 'textarea focus', observations);
                    await page.keyboard.press('Tab');
                    assert.equal(await page.locator('#assistant-form button[type="submit"]').evaluate(node => node === document.activeElement), true, 'Native Tab must focus Send');
                    await checkGeometry(page, 'native Tab to Send', observations);
                    await page.keyboard.press('Shift+Tab');
                    assert.equal(await page.locator('#assistant-input').evaluate(node => node === document.activeElement), true, 'Native Shift+Tab must return to textarea');
                    await checkGeometry(page, 'native Shift+Tab to textarea', observations);
                    if (viewport.width === 568 || viewport.width === 390) await screenshot(page, name + '.png');
                    await page.keyboard.press('Escape');
                    await page.waitForFunction(() => !document.querySelector('#nofries-assistant-dialog').open && document.activeElement.matches('[data-assistant-launcher]'));
                    await open(page, '#fixture-help');
                    await page.keyboard.press('Escape');
                    await page.waitForFunction(() => !document.querySelector('#nofries-assistant-dialog').open && document.activeElement.id === 'fixture-help');
                    assert.equal(await page.locator('#assistant-input').inputValue(), 'Synthetic public draft', 'Close/reopen retains draft');
                });
            }
        }
        await runCase('live-font-resize-focused-textarea', { width: 390, height: 844 }, async (page, observations) => {
            await open(page); await page.locator('#assistant-input').fill('Draft across text enlargement');
            await doubleText(page);
            await checkGeometry(page, 'live text enlargement while textarea stays focused', observations);
            assert.equal(await page.locator('#assistant-input').evaluate(node => node === document.activeElement), true);
            await page.setViewportSize({ width: 568, height: 320 });
            await checkGeometry(page, 'viewport resize while textarea stays focused', observations);
            assert.equal(await page.locator('#assistant-input').evaluate(node => node === document.activeElement), true, 'Viewport resize retains textarea focus');
            assert.equal(await page.locator('#assistant-input').inputValue(), 'Draft across text enlargement');
            await screenshot(page, 'live-font-resize-textarea.png');
        });
        await runCase('live-font-resize-focused-send', { width: 390, height: 844 }, async (page, observations) => {
            await open(page); await page.keyboard.press('Tab');
            assert.equal(await page.locator('#assistant-form button[type="submit"]').evaluate(node => node === document.activeElement), true);
            await doubleText(page);
            await checkGeometry(page, 'live text enlargement while Send stays focused', observations);
            await page.setViewportSize({ width: 568, height: 320 });
            await checkGeometry(page, 'viewport resize while Send stays focused', observations);
            assert.equal(await page.locator('#assistant-form button[type="submit"]').evaluate(node => node === document.activeElement), true);
        });
        await runCase('resize-with-unrelated-focus-does-not-steal-focus', { width: 390, height: 844 }, async (page, observations) => {
            await open(page); await page.locator('#outside-focus').focus();
            assert.equal(await page.locator('#outside-focus').evaluate(node => node === document.activeElement), true);
            const scrollBefore = await page.locator('#nofries-assistant-dialog').evaluate(node => node.scrollTop);
            await doubleText(page); await page.setViewportSize({ width: 568, height: 320 }); await waitForFrames(page);
            assert.equal(await page.locator('#outside-focus').evaluate(node => node === document.activeElement), true, 'Resize must not move unrelated focus into composer');
            observations.push({ label: 'unrelated focus after font/viewport changes', metric: await metrics(page), scrollBefore });
            await page.locator('#assistant-input').focus();
            await checkGeometry(page, 'deliberate return to composer after unrelated focus', observations);
        });
        assert.deepEqual(errors, [], 'No page errors, including ResizeObserver loops');
        assert.deepEqual(outside, [], 'No unexpected or external network requests');
        assert.deepEqual(requests.filter(request => request.method !== 'GET'), [], 'Layout checks must not submit or replay a question');
        assert.deepEqual(hashes(), before, 'Qualification must not change source');
    } catch (error) { fatal = error.message; }
    finally {
        const receipt = { passed: fatal === null && results.every(result => result.passed), failure: fatal, sourceRoot: root,
            sourceRef: process.env.NOFRIES_COMPOSER_SOURCE_REF || null, cases: results.length,
            results, pageErrors: errors, unexpectedRequests: outside, requests, screenshots, sourceBefore: before, sourceAfter: hashes(),
            harnessSha256: sha256(fs.readFileSync(__filename)), browser: browser && browser.version(), syntheticOnly: true,
            limitations: ['Headless Linux Chromium only; no real mobile keyboard, OS font preference, IME, Safari/WebKit or screen-reader acceptance.',
                'Text stress assigns twice every currently computed font size once; author-important dashboard taskbar typography stays authored. All public composer/header fonts double. This is not native browser zoom.',
                'Actual public UI and real dashboard CSS/fixed nav geometry, synthetic loopback bootstrap only; no protected assessment, authentication, production or provider acceptance.'] };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
        if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        console.log(JSON.stringify({ passed: receipt.passed, cases: results.length, failedCases: results.filter(result => !result.passed).length, failure: fatal, artifacts }));
        if (!receipt.passed) process.exitCode = 1;
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
