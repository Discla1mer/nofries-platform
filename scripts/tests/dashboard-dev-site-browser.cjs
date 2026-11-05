'use strict';

// Local synthetic evidence only; does not emulate or qualify Azure authorization.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildDevSite } = require('../build-dashboard-dev-site');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dev-browser-'));
const build = buildDevSite(path.join(artifacts, 'site'));
const config = JSON.parse(fs.readFileSync(path.join(build.output, 'staticwebapp.config.json')));
const requests = [], unexpected = [], errors = [], observations = [], probes = [];
const server = http.createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html', ...config.globalHeaders });
    res.end(fs.readFileSync(path.join(build.output, 'index.html')));
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let browser, completed = false;
    try {
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
        await context.route('**/*', route => {
            if (route.request().url() === origin + '/' && route.request().method() === 'GET') return route.continue();
            unexpected.push(route.request().url()); return route.abort();
        });
        await context.addInitScript(() => {
            window.previewViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                window.previewViolations.push({ directive: event.effectiveDirective, target: event.blockedURI });
            });
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
            assert.equal(await page.locator('#scenario option').count(), 8);
            assert.equal(await page.locator('#preview-revision').textContent(), build.commit + (build.dirty ? '-dirty' : ''));
            for (let index = 0; index < 8; index++) {
                await page.locator('#scenario').selectOption({ index });
                await page.locator('.dashboard-main h1').waitFor();
                assert.equal(await page.locator('.dashboard-main h1').textContent(), index === 2 ? 'Cyber Security' : 'Overview');
                const nav = page.locator(width > 800 ? '.dashboard-rail nav' : '.dashboard-mobile-nav');
                const menu = nav.locator('details');
                if (await menu.count()) await menu.locator('summary').click();
                const keys = await nav.locator('a[data-module]').evaluateAll(links => links.map(link => link.dataset.module));
                for (const key of keys) {
                    const link = nav.locator('[data-module="' + key + '"]');
                    if (!(await link.isVisible())) await menu.locator('summary').click();
                    const href = await link.getAttribute('href');
                    await link.click();
                    assert.equal(new URL(page.url()).hash, href);
                    assert.equal(await link.getAttribute('aria-current'), 'page');
                    assert.ok(await page.locator('.dashboard-main h1').textContent());
                }
                const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
                assert.ok(fits, width + 'px / scenario ' + index + ' fits viewport');
                observations.push({ width, scenario: index, navigation: keys, fits });
            }
            const reset = page.getByRole('button', { name: 'Reset preview', exact: true });
            await reset.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
            assert.equal(await reset.evaluate(node => node === document.activeElement && parseFloat(getComputedStyle(node).outlineWidth) >= 3), true);
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#scenario').evaluate(node => node.selectedIndex), 0);
            assert.equal(new URL(page.url()).hash, '#overview');
            await page.screenshot({ path: path.join(artifacts, 'dashboard-' + width + '.png'), fullPage: true });
            assert.deepEqual(await page.evaluate(() => window.previewViolations), []);
            assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: '' });
        }
        // Genuine browser CSP, with an independent network abort as a safety net.
        // No probe may reach an HTTP server, including a production origin.
        probes.push(...await page.evaluate(async () => {
            const outcomes = [];
            for (const url of ['/api/dashboard', '/api/dashboard/ncsc/assessments', 'https://nofries.nz/api/dashboard']) {
                try { await fetch(url); outcomes.push({ url, blocked: false }); }
                catch { outcomes.push({ url, blocked: true }); }
            }
            return outcomes;
        }));
        assert.ok(probes.every(probe => probe.blocked));
        await page.waitForFunction(() => window.previewViolations.filter(row => row.directive === 'connect-src').length >= 3);
        probes.push(...await page.evaluate(() => window.previewViolations));
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        assert.equal(requests.length, 3);
        completed = true;
        console.log(JSON.stringify({ completed, browser: browser.version(), scenarios: observations.length, requests: requests.length, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ completed, build, browser: browser?.version(), observations, requests, unexpected, errors, probes }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
