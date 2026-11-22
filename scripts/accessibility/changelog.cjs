'use strict';
// Built files and loopback GETs only. No sign-in or submissions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const dist = path.resolve(__dirname, '../../dist');
const evidence = process.env.NOFRIES_CHANGELOG_EVIDENCE || '/tmp/nofries-changelog';
const unexpected = [], errors = [], results = [];
const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + new URL(req.url, 'http://127.0.0.1').pathname);
    if (req.method !== 'GET' || !file.startsWith(dist + '/') || !fs.existsSync(file)) {
        unexpected.push(req.method + ' ' + req.url); res.writeHead(404); return res.end();
    }
    res.setHeader('Content-Type', ({ '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[path.extname(file)] || 'image/png');
    res.end(fs.readFileSync(file));
});
(async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
        fs.mkdirSync(evidence, { recursive: true });
        for (const width of [375, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (route.request().url().startsWith(origin + '/') && route.request().method() === 'GET') return route.continue();
                unexpected.push(route.request().url()); return route.abort();
            });
            await page.goto(origin + '/changelog.html');
            await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
            assert.equal(await page.locator(':focus').getAttribute('id'), 'main-content');
            const links = ['/roadmap.html', '/pricing.html#pricing-pilot', '/roadmap.html#roadmap-planned'];
            for (const href of links) {
                await page.keyboard.press('Tab');
                assert.equal(await page.locator(':focus').getAttribute('href'), href, 'Editorial links follow reading order');
            }
            for (const href of links) {
                await page.locator(`main a[href="${href}"]`).focus();
                await Promise.all([page.waitForURL(origin + href), page.keyboard.press('Enter')]);
                assert.equal(page.url(), origin + href); await page.goBack();
            }
            assert.equal(await page.locator('main article').count(), 5);
            assert.equal(await page.locator('main a[href*="github.com"], main a[href*="issuecomment-"]').count(), 0);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
            assert.deepEqual(axe.violations, []);
            results.push({ width, keyboard: 'passed', axeViolations: [], axeIncomplete: axe.incomplete.map(x => x.id) });
            await page.screenshot({ path: path.join(evidence, `changelog-${width}.png`), fullPage: true });
            await context.close();
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, unexpected, errors }, null, 2));
        console.log('Changelog: 375px/1280px keyboard skip, links, overflow and axe passed.');
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
