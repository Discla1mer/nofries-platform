'use strict';
// Synthetic, read-only source-page check. No real site or account access.
// Run: node scripts/tests/roadmap-disclosure-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const allowed = new Map(['/roadmap.html', '/home.css', '/style.css', '/favicon.svg', '/images/nofrieslogo.png', '/images/paper-texture.webp', '/assets/fonts/fraunces-latin-opsz-normal.woff2', '/assets/fonts/fraunces-latin-opsz-italic.woff2'].map(file => [file, path.join(root, file)]));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 768, 390, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const unexpected = [];
            await page.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                const file = url.origin === 'https://roadmap.test' && allowed.get(url.pathname);
                if (request.method() !== 'GET' || !file) { unexpected.push(request.url()); return route.abort(); }
                return route.fulfill({ path: file, contentType: ({ '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[path.extname(file)] || 'text/html' });
            });
            await page.goto('https://roadmap.test/roadmap.html');
            assert.equal(await page.locator('details').count(), 8);
            assert.equal(await page.locator('details[open]').count(), 0);
            const summaries = page.locator('.roadmap-theme > summary');
            for (let index = 0; index < 8; index++) {
                const summary = summaries.nth(index);
                await summary.focus();
                assert.ok(await summary.evaluate(node => node === document.activeElement));
                const size = await summary.boundingBox();
                assert.ok(size.height >= 44);
                await page.keyboard.press('Enter');
                assert.equal(await page.locator('details[open]').count(), 1);
                assert.ok(await summary.evaluate(node => node.parentElement.open));
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                await page.keyboard.press('Space');
                assert.equal(await page.locator('details[open]').count(), 0);
                assert.ok(await summary.evaluate(node => node === document.activeElement));
            }
            // Multiple themes can remain open. Enlarged text must still wrap.
            await page.evaluate(() => {
                document.querySelectorAll('details').forEach(node => { node.open = true; });
                document.documentElement.style.fontSize = '200%';
            });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            assert.equal(await page.locator('details[open]').count(), 8);
            assert.deepEqual(unexpected, []);
            await page.close();
        }
        console.log('Roadmap disclosures pass at 1440, 768, 390 and 320px, including keyboard and enlarged text.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
