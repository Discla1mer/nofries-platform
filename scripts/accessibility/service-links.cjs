'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const { once } = require('node:events');

(async () => {
    const dist = path.resolve(__dirname, '../../dist');
    const server = http.createServer((req, res) => {
        const file = path.resolve(dist, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); return res.end();
        }
        res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
    }).listen(0, '127.0.0.1');
    let browser;
    try {
        await once(server, 'listening');
        const base = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
        const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
        await page.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
        for (const [entry, href, target] of [
            ['/managed-it.html', '#included', 'included'],
            ['/roadmap.html', '/pricing.html#pricing-pilot', 'pricing-pilot'],
            ['/roadmap.html', '/pricing.html#pricing-assessments', 'pricing-assessments']
        ]) {
            await page.goto(base + entry);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const link = page.locator('main a[href="' + href + '"]').first();
            let reached = false;
            for (let i = 0; i < 60 && !reached; i++) {
                await page.keyboard.press('Tab');
                reached = await link.evaluate(el => el === document.activeElement);
            }
            assert.ok(reached, entry + ' keyboard access to ' + href);
            await page.keyboard.press('Enter');
            await page.waitForURL(new URL(href, base + entry).href);
            assert.ok(await page.locator('#' + target).isVisible());
            console.log('PASS 375px keyboard:', entry, '→', href);
        }
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
