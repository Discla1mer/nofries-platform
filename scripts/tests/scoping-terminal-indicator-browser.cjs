'use strict';

// Optional local Chromium proof; uses the real document, loader and application.
// All requests are synthetic loopback GETs. No stored profile or live session.
// NOFRIES_SCOPING_ARTIFACTS selects an external evidence directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { buildScopingDocument } = require('../../lib/scopingDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['app/mssp.html', 'app/mssp.css', 'app/mssp.js', 'js/app-loader.js',
    'js/scoping-copy.js', 'lib/scopingDocument.js', 'scripts/tests/scoping-terminal-indicator-browser.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, hash(read(file))]));
const before = hashes();
const baselineRef = 'fd3e0480a70c92255514347d6cdd0535f2415bfe';
const baselineCss = execFileSync('git', ['show', baselineRef + ':app/mssp.css'], { cwd: root });
const document = buildScopingDocument({ template: read('app/mssp.html').toString(),
    loaderSource: read('js/app-loader.js').toString(), copySource: read('js/scoping-copy.js').toString() });
const artifacts = process.env.NOFRIES_SCOPING_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-scoping-indicator-'));
fs.mkdirSync(artifacts, { recursive: true });
const bootstrap = { tenant: { name: 'Synthetic workspace' }, user: { email: 'fixture@example.test', role: 'consultant' } };
const results = [], errors = [], unexpected = [];
let scenario, base;
function deferred() {
    let resolve;
    return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) };
}
function setup(mode, baseline = false) {
    scenario = { mode, baseline, requests: [], sessions: 0, bootstraps: 0, gates: [] };
    if (mode === 'failure') {
        for (let i = 0; i < 3; i++) scenario.gates.push({ arrived: deferred(), release: deferred() });
    } else if (mode === 'loading') scenario.gates.push({ arrived: deferred(), release: deferred() });
    return scenario;
}
async function gate(current, index) {
    const witness = current.gates[index];
    witness.arrived.resolve();
    await witness.release.promise;
}
async function waiting(witness) {
    let timer;
    try {
        await Promise.race([witness.arrived.promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic loader request did not arrive')), 10000); })]);
    } finally { clearTimeout(timer); }
}
const assets = { '/images/nofrieslogo.png': ['image/png', read('images/nofrieslogo.png')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')] };
const server = http.createServer(async (req, res) => {
    const current = scenario, pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    current.requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { unexpected.push(req.method + ' ' + pathname); res.writeHead(405); return res.end(); }
    let body, type = 'application/json', status = 200;
    if (pathname === '/scoping') {
        type = 'text/html'; body = document.html;
        res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    } else if (pathname === '/assets/mssp.css') {
        type = 'text/css'; body = current.baseline ? baselineCss : read('app/mssp.css');
    } else if (assets[pathname]) [type, body] = assets[pathname];
    else if (['/favicon.ico', '/apple-touch-icon.png'].includes(pathname)) { type = 'image/png'; body = assets['/images/nofrieslogo.png'][1]; }
    else if (pathname === '/api/auth/session') {
        current.sessions++;
        if (current.mode === 'loading' || current.mode === 'failure' && current.sessions === 1) await gate(current, 0);
        if (current.mode === 'denied') { status = 403; body = { code: 'tenant_access_required', error: 'Synthetic access denied.' }; }
        else body = { authenticated: true };
    } else if (pathname === '/api/sales/bootstrap') {
        current.bootstraps++;
        if (current.mode === 'failure') {
            await gate(current, current.bootstraps);
            status = 503; body = { code: 'synthetic_unavailable', error: 'Synthetic service unavailable.' };
        } else body = bootstrap;
    } else if (pathname === '/api/sales/app.js') {
        type = 'text/javascript'; body = read('app/mssp.js');
        if (current.mode === 'script-failure') { status = 503; body = ''; }
    } else { unexpected.push('Unexpected GET ' + pathname); res.writeHead(404); return res.end(); }
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
});

async function sample(page) {
    return page.evaluate(() => {
        const mark = document.querySelector('.loading-mark'), style = getComputedStyle(mark);
        return { bodyClass: document.body.className, animation: style.animationName,
            transform: style.transform, marker: getComputedStyle(mark, '::after').content,
            heading: document.getElementById('loadingHeading').textContent,
            message: document.getElementById('loadingMessage').textContent,
            status: document.getElementById('loadingStatus').textContent,
            live: document.getElementById('loadingPanel').getAttribute('aria-live'),
            panelHidden: document.getElementById('loadingPanel').hidden,
            scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
    });
}
async function moving(page, expected) {
    const first = await sample(page);
    await page.waitForTimeout(90);
    const next = await sample(page);
    assert.equal(next.animation, expected ? 'spin' : 'none');
    if (expected) assert.notEqual(first.transform, next.transform, 'The loading ring should rotate');
    else assert.equal(first.transform, next.transform, 'The terminal/reduced-motion mark should stay static');
    return next;
}
async function capture(page, name) {
    const current = await sample(page);
    assert.ok(current.scrollWidth <= current.width, name + ' horizontal overflow');
    await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
    return current;
}
async function focusRetry(page) {
    const retry = page.locator('#loadingStatus a').first();
    assert.equal(await retry.textContent(), 'Retry');
    assert.equal(await retry.getAttribute('href'), '/scoping');
    assert.equal(await page.locator('#loadingStatus a').last().getAttribute('href'), '/api/auth/login?returnTo=%2Fscoping');
    let found = false;
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        found = await retry.evaluate(el => el === document.activeElement);
        if (found) break;
    }
    assert.equal(found, true, 'Native Tab must reach existing Retry');
    const target = await retry.evaluate(el => {
        const box = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            viewport: innerHeight, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom,
            outline: style.outlineStyle, hit: el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
    });
    assert.ok(target.left >= 0 && target.right <= await page.evaluate(() => innerWidth));
    assert.ok(target.top >= target.headerBottom && target.bottom <= target.viewport, 'Focused Retry must be unobscured');
    assert.equal(target.hit, true); assert.notEqual(target.outline, 'none');
    return target;
}
async function failureCase(browser, width, reduced, baseline = false) {
    const current = setup('failure', baseline);
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 },
        reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await guard(page);
    const name = (baseline ? 'baseline-' : '') + 'terminal-' + width + (reduced ? '-reduced' : '');
    try {
        await page.goto(base + '/scoping', { waitUntil: 'domcontentloaded' });
        await waiting(current.gates[0]);
        const loading = await moving(page, !reduced);
        assert.match(loading.bodyClass, /app-loading/); assert.doesNotMatch(loading.bodyClass, /workspace-unavailable/);
        assert.equal(await page.locator('#loadingStatus a').count(), 0);
        current.gates[0].release.resolve();
        await waiting(current.gates[1]);
        assert.equal(current.sessions, 1); assert.equal(current.bootstraps, 1);
        current.gates[1].release.resolve();
        await waiting(current.gates[2]);
        const retrying = await moving(page, !reduced);
        assert.match(retrying.message, /Retrying once/); assert.match(retrying.bodyClass, /app-loading/);
        assert.doesNotMatch(retrying.bodyClass, /workspace-unavailable/);
        assert.equal(await page.locator('#loadingStatus a').count(), 0);
        if (!baseline) await capture(page, 'retrying-' + width + (reduced ? '-reduced' : ''));
        current.gates[2].release.resolve();
        await page.locator('body.workspace-unavailable').waitFor();
        const terminal = await moving(page, baseline);
        assert.doesNotMatch(terminal.bodyClass, /app-loading/); assert.equal(terminal.live, 'polite');
        assert.equal(current.sessions, 2); assert.equal(current.bootstraps, 2);
        assert.equal(terminal.heading, 'Workspace could not load');
        assert.match(terminal.status, /Synthetic service unavailable/);
        if (!baseline) assert.equal(terminal.marker, '"!"');
        const target = await focusRetry(page);
        await capture(page, name);
        const retryLoad = setup('loading');
        await page.keyboard.press('Enter');
        await waiting(retryLoad.gates[0]);
        const reloading = await moving(page, !reduced);
        assert.match(reloading.bodyClass, /app-loading/); assert.doesNotMatch(reloading.bodyClass, /workspace-unavailable/);
        assert.equal(retryLoad.sessions, 1); assert.equal(retryLoad.bootstraps, 0);
        results.push({ name, loading, retrying, terminal, keyboardTarget: target,
            sessions: current.sessions, bootstraps: current.bootstraps, retryStartedFreshSession: true });
    } finally {
        // Close the page before releasing Retry's held GET. Otherwise the old
        // document can dispatch bootstrap after the next scenario has started.
        await context.close();
        for (const item of current.gates) item.release.resolve();
        for (const item of scenario.gates) item.release.resolve();
    }
}
async function guard(page) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin === base && request.method() === 'GET') return route.continue();
        unexpected.push('Nonfixture request'); return route.abort();
    });
}
async function settledCase(browser, width, mode) {
    const current = setup(mode);
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 } });
    const page = await context.newPage(); await guard(page);
    try {
        await page.goto(base + '/scoping');
        if (mode === 'success') {
            await page.locator('#viewRoot .page').waitFor();
            assert.equal(await page.locator('#loadingPanel').isVisible(), false);
            assert.equal(await page.locator('body').getAttribute('class'), '');
            assert.equal(current.sessions, 1); assert.equal(current.bootstraps, 1);
            assert.equal(current.requests.filter(row => row.path === '/api/sales/app.js').length, 1);
        } else {
            await page.locator('body.' + (mode === 'denied' ? 'access-denied' : 'workspace-unavailable')).waitFor();
            const state = await moving(page, false);
            assert.equal(state.marker, '"!"');
            assert.equal(current.sessions, 1); assert.equal(current.bootstraps, mode === 'denied' ? 0 : 1);
            if (mode === 'denied') assert.equal(await page.locator('#loadingStatus a').first().getAttribute('href'), '/api/auth/login?returnTo=%2Fscoping');
            else await focusRetry(page);
        }
        results.push({ name: mode + '-' + width, state: await capture(page, mode + '-' + width),
            sessions: current.sessions, bootstraps: current.bootstraps });
    } finally { await context.close(); }
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    let browser, failure = null;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        await failureCase(browser, 390, false, true);
        for (const width of [1440, 390, 320]) {
            await failureCase(browser, width, false);
            await failureCase(browser, width, true);
            for (const mode of ['success', 'denied', 'script-failure']) await settledCase(browser, width, mode);
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ passed: true, cases: results.length, artifacts, browser: browser.version() }));
    } catch (error) { failure = error.message; throw error; }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure,
            syntheticOnly: true, baselineRef, baselineCssHash: hash(baselineCss), results, errors, unexpected,
            sourceHashesBefore: before, sourceHashesAfter: hashes(), browser: browser?.version() }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
