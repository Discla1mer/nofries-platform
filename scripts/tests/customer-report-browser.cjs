'use strict';
// Synthetic loopback GETs only; no email draft is opened or sent. Uses existing
// Playwright/Chromium, without installation. Run: node scripts/tests/customer-report-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const files = ['report.html', 'customer-report.css', 'js/customer-report.js', 'lib/publicAssets.js',
    'test/customerReporting.test.js', 'scripts/tests/customer-report-browser.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const frozen = hashes();
const artifacts = fs.mkdtempSync('/tmp/nofries-report-browser-');
fs.chmodSync(artifacts, 0o700);
const assets = { '/report.html': 'report.html', '/customer-report.css': 'customer-report.css',
    '/style.css': 'style.css', '/js/customer-report.js': 'js/customer-report.js', '/favicon.svg': 'favicon.svg',
    '/images/nofrieslogo.png': 'images/nofrieslogo.png' };
const requests = [], violations = [], errors = [], results = [];
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ method: request.method, path: pathname });
    if (request.method !== 'GET' || !assets[pathname]) {
        violations.push({ method: request.method, path: pathname }); response.statusCode = 405; return response.end();
    }
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; connect-src 'self'");
    response.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.js') ? 'text/javascript' :
        pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    response.end(fs.readFileSync(path.join(root, assets[pathname])));
});

function audit() {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = value => rgb(value).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
        .reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    const visible = node => !node.closest('[hidden]') && node.getBoundingClientRect().height > 0;
    const controls = [...document.querySelectorAll('select,textarea')].filter(visible).map(node => {
        const style = getComputedStyle(node), card = getComputedStyle(document.querySelector('.report-card'));
        return { id: node.id, text: contrast(style.color, style.backgroundColor), border: contrast(style.borderTopColor, card.backgroundColor),
            width: node.getBoundingClientRect().width };
    });
    const focus = getComputedStyle(document.activeElement);
    return { overflow: document.documentElement.scrollWidth > innerWidth, controls,
        focus: { id: document.activeElement.id, visible: document.activeElement.matches(':focus-visible'),
            outline: focus.outlineStyle, width: parseFloat(focus.outlineWidth) },
        labels: [...document.querySelectorAll('select,textarea,input')].every(node => document.querySelector('label[for="' + node.id + '"]')),
        imageLoaded: document.querySelector('.brand img').naturalWidth > 0 };
}

(async function () {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 390, 320]) for (const kind of ['error', 'bug', 'feedback']) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push({ width, kind, message: error.message }));
            page.on('console', message => { if (message.type() === 'error') errors.push({ width, kind, message: message.text() }); });
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== base || route.request().method() !== 'GET' || !assets[url.pathname]) {
                    violations.push({ method: route.request().method(), path: url.pathname }); return route.abort();
                }
                return route.continue();
            });
            const supportReference = 'NF-0123456789ABCDEF', releaseSha = 'a'.repeat(40), releaseRun = '38380759572';
            await page.goto(base + '/report.html#kind=' + kind + '&screen=signup&step=setup&code=signup_unavailable&reference=' +
                supportReference + '&apiReleaseSha=' + releaseSha + '&apiReleaseRunId=' + releaseRun + '&token=synthetic-private');
            assert.equal(page.url(), base + '/report.html');
            await page.keyboard.press('Tab');
            assert.ok(await page.locator('.report-skip').evaluate(node => node === document.activeElement));
            await page.keyboard.press('Enter');
            assert.ok(await page.locator('#report-main').evaluate(node => node === document.activeElement), 'Skip target should receive keyboard focus');
            await page.locator('#report-description').fill('The synthetic setup screen did not finish.\npassword: synthetic-private\nowner@example.test');
            await page.locator('#report-preview-button').focus();
            const before = await page.evaluate(audit);
            assert.equal(before.overflow, false); assert.equal(before.labels, true); assert.equal(before.imageLoaded, true);
            assert.equal(before.focus.visible, true); assert.ok(before.focus.width >= 3);
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#report-preview-title').evaluate(node => node === document.activeElement), true);
            const body = await page.locator('#report-body').inputValue();
            assert.ok(body.includes('Report reference: NF-'));
            if (kind === 'error') {
                assert.ok(body.includes('Failed step: setup'));
                assert.ok(body.includes('Support reference: ' + supportReference));
                assert.ok(body.includes('Original API release SHA: ' + releaseSha));
                assert.ok(body.includes('Original API release run: ' + releaseRun));
            } else assert.ok(!body.includes('Failed step:') && !body.includes('Error code:') &&
                !body.includes('Support reference:') && !body.includes('Original API release'));
            assert.ok(!body.includes('synthetic-private')); assert.ok(!body.includes('owner@example.test'));
            assert.equal(await page.locator('#report-open').isDisabled(), true);
            await page.locator('#report-reviewed').focus(); await page.keyboard.press('Space');
            assert.equal(await page.locator('#report-open').isDisabled(), false);
            // Inspect and copy are tested without external email-app activation.
            await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.syntheticCopy = value; } }, configurable: true }));
            await page.locator('#report-copy').click();
            assert.ok((await page.evaluate(() => window.syntheticCopy)).endsWith(body));
            assert.ok((await page.locator('#report-status').innerText()).includes('delivery are not confirmed'));
            await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('synthetic copy failure'); } }, configurable: true }));
            await page.locator('#report-copy').click();
            assert.ok((await page.locator('#report-status').innerText()).includes('Copy was not confirmed'));
            const after = await page.evaluate(audit);
            assert.equal(after.overflow, false);
            for (const control of after.controls) {
                assert.ok(control.text >= 4.5, control.id + ': text contrast');
                assert.ok(control.border >= 3, control.id + ': border contrast');
            }
            const screenshot = `${width}-${kind}.png`;
            await page.screenshot({ path: path.join(artifacts, screenshot), fullPage: true });
            results.push({ width, kind, before, after, screenshot });
            await context.close();
        }
        assert.deepEqual(violations, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), frozen);
        fs.writeFileSync(path.join(artifacts, 'browser-results.json'), JSON.stringify({ results, requests, violations, errors,
            sourceHashes: frozen, emailAppOpened: false, emailSent: false }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ passed: results.length, artifacts, requests: requests.length, violations: violations.length, errors: errors.length }));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}()).catch(error => { console.error(error.message); process.exitCode = 1; server.close(); });
