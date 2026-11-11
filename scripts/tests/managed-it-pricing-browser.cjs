'use strict';

// Run with an existing Playwright and Chromium installation. Serves repository files
// through an intercepted synthetic origin; no server or external requests are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const assets = new Map(['/managed-it.html', '/style.css', '/home.css', '/managed-it.css',
    '/assets/fonts/fraunces-latin-opsz-normal.woff2', '/assets/fonts/fraunces-latin-opsz-italic.woff2',
    '/images/paper-texture.webp', '/images/nofries-mark-32.png'].map(file => [file, path.join(root, file)]));

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 768, 390, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            await page.route('**/*', async route => {
                const url = new URL(route.request().url());
                const file = url.origin === 'http://nofries.test' && assets.get(url.pathname);
                if (!file || !fs.existsSync(file)) return route.abort();
                const ext = path.extname(file);
                await route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png' })[ext] });
            });
            await page.goto('http://nofries.test/managed-it.html#plans');
            await page.evaluate(() => document.fonts.ready);
            assert.equal(await page.locator('.managed-it-tier').count(), 3);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal scroll`);
            const styles = await page.locator('.managed-it-tier').evaluateAll(cards => cards.map(card => {
                const s = getComputedStyle(card);
                return { background: s.backgroundColor, radius: s.borderRadius, width: card.getBoundingClientRect().width };
            }));
            assert.ok(styles.every(s => s.background === 'rgb(246, 242, 234)' && s.radius === '14px' && s.width > 0));
            const badge = await page.locator('.managed-it-tier-badge').evaluate(el => {
                const s = getComputedStyle(el); return [s.color, s.backgroundColor];
            });
            assert.deepEqual(badge, ['rgb(21, 24, 22)', 'rgb(219, 177, 87)']);
            for (const button of await page.locator('.managed-it-tier .button').all()) {
                const box = await button.boundingBox();
                assert.ok(box.width >= 44 && box.height >= 44, `${width}: touch target`);
                await button.focus();
                await page.keyboard.press('Tab');
                await page.keyboard.press('Shift+Tab');
                assert.ok(await button.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'), `${width}: keyboard focus`);
            }
            await page.locator('.managed-it-tier .button-secondary').first().hover();
            assert.equal(await page.locator('.managed-it-tier .button-secondary').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(242, 228, 188)');
            await page.close();
        }
        console.log('Managed IT pricing: desktop, tablet, 390px and 320px passed');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
