'use strict';

// Actual protected renderers and CSS in the existing synthetic preview harness.
// No customer session, persistence or network API calls. Run with installed Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');
const root = path.resolve(__dirname, '../..');
const artifacts = path.resolve(process.env.NOFRIES_ASSESSMENT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nf-assessment-experience-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep evidence outside source');
const preview = buildPreview(path.join(artifacts, 'assessment-preview.html'));
const errors = [], blocked = [], observations = [], requests = [];
const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method !== 'GET' || request.url !== '/') {
        blocked.push(request.method + ' ' + request.url); response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(preview.frameOutput));
});
const action = (page, name) => page.getByRole('button', { name, exact: true });
const listActions = page => page.locator('.ncsc-assessment-list button');
async function openList(page) {
    await page.locator('[data-module="cyber_security"]:visible').click();
    await page.locator('#ncsc-assessment-search').waitFor();
}
async function inspect(page, label) {
    const geometry = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('.ncsc-assessment-filters input, .ncsc-assessment-filters select, .ncsc-assessment-list button, .ncsc-assessment-list summary')]
            .filter(node => node.checkVisibility()).map(node => {
                const r = node.getBoundingClientRect();
                return { text: node.textContent || node.getAttribute('aria-label') || node.id, x: r.x, right: r.right, height: r.height };
            })
    }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1, label + ': no horizontal page overflow');
    for (const control of geometry.controls) {
        assert.ok(control.x >= -1 && control.right <= geometry.width + 1, label + ': control fits ' + control.text);
        assert.ok(control.height >= 44, label + ': usable touch target ' + control.text);
    }
    observations.push({ label, ...geometry });
}
async function keyboardFocus(page, locator) {
    await locator.focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const focus = await locator.evaluate(node => {
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { active: node === document.activeElement, ring: parseFloat(style.outlineWidth),
            visible: node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    assert.equal(focus.active, true); assert.ok(focus.ring >= 3); assert.equal(focus.visible, true);
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
        await context.addInitScript(() => {
            window.experienceViolations = [];
            document.addEventListener('securitypolicyviolation', event => window.experienceViolations.push(event.effectiveDirective));
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) for (const enlarged of [false, true]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
            await page.locator('.picture-resume').waitFor();
            if (enlarged) await page.evaluate(() => document.documentElement.style.fontSize = '200%');
            const label = width + (enlarged ? '-text200' : '');
            const resume = await page.locator('.picture-resume').boundingBox(), toolbar = await page.locator('.picture-toolbar').boundingBox();
            assert.ok(resume.y < toolbar.y, 'Resume panel precedes maintenance');
            await openList(page); await inspect(page, label + '-initial');
            assert.equal(await listActions(page).count(), 2);
            await page.locator('#ncsc-assessment-status').selectOption('submitted');
            assert.equal(await listActions(page).count(), 0);
            assert.equal(await page.getByText('No loaded assessments match your search and status.', { exact: true }).isVisible(), true);
            assert.equal(await page.getByText('Search and filters cover loaded assessments. Load more to include more saved records.', { exact: true }).isVisible(), true);
            await action(page, 'Load more assessments').click();
            await action(page, 'View results').waitFor();
            assert.equal(await page.locator('#ncsc-assessment-status').inputValue(), 'submitted');
            assert.equal(await listActions(page).count(), 1);
            await page.locator('#ncsc-assessment-status').selectOption('all');
            assert.equal(await listActions(page).count(), 3);
            const search = page.locator('#ncsc-assessment-search');
            await keyboardFocus(page, search);
            await search.pressSequentially('assessment-b');
            assert.equal(await search.evaluate(node => node === document.activeElement), true);
            assert.equal(await listActions(page).count(), 1);
            await search.fill('no-match'); await keyboardFocus(page, action(page, 'Clear filters'));
            await page.keyboard.press('Enter');
            assert.equal(await search.evaluate(node => node === document.activeElement), true);
            assert.equal(await listActions(page).count(), 3);
            await inspect(page, label + '-all');
            if (!enlarged) {
                await page.locator('.dashboard-main').screenshot({ path: path.join(artifacts, 'assessments-' + width + '.png') });
            }
            await search.fill('assessment-b');
            await keyboardFocus(page, action(page, 'Continue assessment')); await page.keyboard.press('Enter');
            await page.locator('#ncsc-question-index').waitFor();
            assert.match(await page.locator('.ncsc-status').textContent(), /14 of 14 answered/);
            await action(page, 'Back to assessments').click();
            await search.waitFor(); assert.equal(await search.inputValue(), 'assessment-b');
            assert.equal(await listActions(page).count(), 1);
            // Host replacement must discard the old organisation's filter state.
            await page.locator('#tenant').selectOption('1'); await openList(page);
            assert.equal(await search.inputValue(), '');
            assert.equal(await page.locator('#ncsc-assessment-status').inputValue(), 'all');
            await page.locator('#display-mode').selectOption('read-only'); await openList(page);
            assert.equal(await action(page, 'Continue assessment').count(), 0);
            assert.equal(await action(page, 'Start an assessment').count(), 0);
            assert.equal(await action(page, 'View assessment').count(), 2);
            assert.deepEqual(await page.evaluate(() => window.experienceViolations), []);
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
        for (const source of preview.sources) {
            const hash = createHash('sha256').update(fs.readFileSync(path.join(root, source.path))).digest('hex');
            assert.equal(hash, source.sha256, 'Source remained stable: ' + source.path);
        }
        completed = true;
        console.log(JSON.stringify({ completed, observations: observations.length, requests: requests.length, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ completed, observations, requests, errors, blocked, preview }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
