'use strict';
// Built files and loopback GETs only. No sign-in or submissions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const { readRoadmap, LANE_IDS } = require('../generate-roadmap');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist');
const evidence = process.env.NOFRIES_ROADMAP_EVIDENCE || '/tmp/nofries-roadmap';
const unexpected = [], errors = [], results = [];
const server = http.createServer((req, res) => {
    const filename = path.resolve(dist, '.' + new URL(req.url, 'http://127.0.0.1').pathname);
    if (req.method !== 'GET' || !filename.startsWith(dist + '/') || !fs.existsSync(filename)) {
        unexpected.push(req.method + ' ' + req.url); res.writeHead(404); return res.end();
    }
    res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.html') ? 'text/html' : filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    res.end(fs.readFileSync(filename));
});
(async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
        fs.mkdirSync(evidence, { recursive: true });
        for (const width of [375, 1440]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (route.request().url().startsWith(origin + '/') && route.request().method() === 'GET') return route.continue();
                unexpected.push(route.request().url()); return route.abort();
            });
            await page.goto(origin + '/roadmap.html');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Enter');
            assert.equal(await page.locator(':focus').getAttribute('id'), 'main-content', 'Skip link moves focus');
            // Tab through the service link to the first lane jump; native navigation retains focus.
            await page.keyboard.press('Tab');
            assert.equal(await page.locator(':focus').getAttribute('href'), '/pricing.html#pricing-pilot');
            await page.keyboard.press('Tab');
            const data = readRoadmap();
            const laneIds = Object.keys(data.lanes).map(lane => LANE_IDS[lane]);
            for (const [index, id] of laneIds.entries()) {
                assert.equal(await page.locator(':focus').getAttribute('href'), '#' + id, 'Lane links follow roadmap order');
                if (index < laneIds.length - 1) await page.keyboard.press('Tab');
            }
            for (const id of laneIds) {
                await page.locator(`.roadmap-jump a[href="#${id}"]`).focus();
                await page.keyboard.press('Enter');
                assert.equal(await page.locator(':focus').getAttribute('id'), id);
            }
            await page.locator('#roadmap-live').focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.locator(':focus').getAttribute('href'), '/sample-result.html');
            await page.keyboard.press('Tab');
            assert.equal(await page.locator(':focus').getAttribute('href'), '/try');
            assert.equal(await page.locator('.roadmap-timeline article').count(), data.items.length);
            assert.equal(await page.locator('main a[href*="github.com"], main a[href*="issuecomment-"]').count(), 0);
            const geometry = await page.locator('.roadmap-timeline > li').evaluateAll(els => els.map(el => ({ x: el.offsetLeft, y: el.offsetTop })));
            assert.equal(new Set(geometry.map(p => p.x)).size, width === 375 ? 1 : laneIds.length);
            if (width === 375) assert.ok(geometry.every((p, i) => !i || p.y > geometry[i - 1].y));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
            const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
            assert.deepEqual(axe.violations, []);
            await page.screenshot({ path: path.join(evidence, `roadmap-${width}.png`), fullPage: true });
            results.push({ width, geometry, keyboard: 'passed', axeViolations: axe.violations, axeIncomplete: axe.incomplete.map(r => ({ id: r.id, nodes: r.nodes.length })) });
            await context.close();
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, unexpected, errors }, null, 2));
        console.log('Roadmap: 375px stacked, 1440px lane columns, keyboard skip/jumps/feature links, no engineering links and axe passed.');
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
