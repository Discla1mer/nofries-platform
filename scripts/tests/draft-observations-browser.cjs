'use strict';

// Synthetic protected renderer, not authenticated-host or database acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');
const root = path.resolve(__dirname, '../..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-draft-observations-'));
const preview = buildPreview(path.join(artifacts, 'preview.html'));
const errors = [], blocked = [], observations = [];
const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
        blocked.push(request.method + ' ' + request.url); response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(preview.frameOutput));
});
const action = (page, name) => page.getByRole('button', { name, exact: true });
async function openList(page) {
    await page.locator('[data-module="cyber_security"]:visible').click();
    await page.locator('#ncsc-assessment-search').waitFor();
}
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let browser, completed = false;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        await context.route('**/*', route => {
            if (route.request().url() !== origin + '/' || route.request().method() !== 'GET') {
                blocked.push(route.request().url()); return route.abort();
            }
            return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) for (const enlarged of [false, true]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
            await openList(page); await action(page, 'Continue assessment').first().click();
            const panel = page.locator('.ncsc-draft-observations'), summary = panel.locator('summary');
            await summary.waitFor();
            if (enlarged) await page.evaluate(() => document.documentElement.style.fontSize = '200%');
            await summary.focus(); await page.keyboard.press('Enter');
            assert.equal(await panel.evaluate(node => node.open), true);
            assert.match(await panel.textContent(), /3 of 14 responses saved/);
            assert.match(await panel.textContent(), /Information to confirm · 1/);
            assert.match(await panel.textContent(), /Applicability to confirm · 1/);
            assert.doesNotMatch(await panel.textContent(), /\d+(?:\.\d+)?%/);
            const jump = panel.getByRole('button', { name: /Question 2:/ });
            await jump.focus(); await page.keyboard.press('Enter');
            assert.equal(await page.locator('#ncsc-question-index').inputValue(), '1');
            assert.equal(await page.locator('.ncsc-question legend').evaluate(node => node === document.activeElement), true);
            await page.locator('.ncsc-question input[value="no"]').check();
            assert.match(await panel.textContent(), /Reported gaps · 0/);
            await action(page, 'Save progress').click();
            await panel.getByRole('heading', { name: 'Reported gaps · 1', exact: true }).waitFor();
            assert.equal(await panel.evaluate(node => node.open), true);
            const geometry = await panel.evaluate(node => ({
                width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                controls: [...node.querySelectorAll('summary, button')].map(control => {
                    const box = control.getBoundingClientRect();
                    return { text: control.textContent, left: box.left, right: box.right, height: box.height };
                })
            }));
            assert.ok(geometry.scrollWidth <= width + 1);
            for (const control of geometry.controls) {
                assert.ok(control.left >= -1 && control.right <= width + 1, control.text);
                assert.ok(control.height >= 44, control.text + ': touch target');
            }
            observations.push({ width, enlarged, ...geometry });
            if (!enlarged) await panel.screenshot({ path: path.join(artifacts, 'draft-' + width + '.png') });
            await summary.focus(); await page.keyboard.press('Enter');
            assert.equal(await panel.evaluate(node => node.open), false);
            await action(page, 'Back to assessments').click(); assert.equal(await panel.count(), 0);
            await action(page, 'Load more assessments').click(); await action(page, 'View results').click();
            await page.locator('#ncsc-sealed').waitFor(); assert.equal(await panel.count(), 0);
            await page.locator('#tenant').selectOption('1'); await openList(page);
            await action(page, 'Continue assessment').first().click(); await summary.waitFor();
            assert.equal(await panel.evaluate(node => node.open), false);
            assert.match(await panel.textContent(), /Reported gaps · 0/);
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        for (const source of preview.sources) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, source.path))).digest('hex'), source.sha256);
        completed = true; console.log(JSON.stringify({ completed, observations: observations.length, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ completed, errors, blocked, observations, preview }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
