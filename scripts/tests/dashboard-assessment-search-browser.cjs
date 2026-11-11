'use strict';

// Synthetic saved records only. No customer session or API requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-assessment-search-'));
    const preview = buildPreview(path.join(directory, 'preview.html'));
    const server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(fs.readFileSync(preview.path));
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port + '/';
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const unexpected = [], errors = [];
        await page.route('**/*', route => {
            if (route.request().url() === origin && route.request().method() === 'GET') return route.continue();
            unexpected.push(route.request().url()); return route.abort();
        });
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(origin);
            await page.locator('[data-module="cyber_security"]:visible').click();
            const search = page.locator('#ncsc-assessment-search');
            await search.waitFor();
            const cards = page.locator('.ncsc-assessment-card');
            assert.equal(await cards.count(), 2);
            const date = (await cards.first().locator('h3').innerText()).replace('Assessment started ', '');
            for (const query of [' OFFICE AND CLOUD ', date]) {
                await search.fill(query);
                assert.equal(await cards.count(), 2);
                assert.equal(await search.evaluate(node => node === document.activeElement), true);
            }
            await search.fill('no matching scope');
            assert.equal(await cards.count(), 0);
            await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
            assert.equal(await cards.count(), 2);
            assert.equal(await search.inputValue(), '');
            assert.equal(await search.evaluate(node => node === document.activeElement), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        console.log('Saved-assessment search passed at desktop, 390px and 320px.');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
