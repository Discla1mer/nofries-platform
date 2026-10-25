'use strict';

// Optional Chromium check using an existing Playwright/browser installation.
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/tests/assessment-usability-browser.cjs
// NOFRIES_USABILITY_SCREENSHOTS optionally saves synthetic review images.
// Uses actual preview components and in-memory transport, not customer/auth acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPreview, buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-usability-'));
const preview = buildPreview(path.join(temporary, 'questionnaire.html'));
const fixtures = buildFixtures(), errors = [], unexpected = [], results = [];
const imageDirectory = process.env.NOFRIES_USABILITY_SCREENSHOTS;
const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/questionnaire-frame.html') {
        unexpected.push(request.method + ' ' + request.url); response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(preview.frameOutput));
});
async function openCyber(page) {
    const desktop = page.locator('.dashboard-module-link[data-module="cyber_security"]');
    if (await desktop.isVisible()) await desktop.click();
    else await page.getByRole('navigation', { name: 'Dashboard tasks', exact: true })
        .getByRole('button', { name: 'Assess', exact: true }).click();
    await page.locator('.ncsc-assessment-list button').first().waitFor();
}
async function jump(page, index) {
    const control = page.getByRole('button', { name: 'Next unresolved question', exact: true });
    await control.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#ncsc-question-index').inputValue(), String(index));
    const legend = page.locator('.ncsc-question legend');
    assert.equal(await legend.textContent(), fixtures.metadata.questions[index].prompt);
    assert.equal(await legend.evaluate(node => node === document.activeElement), true);
}
async function layout(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
async function screenshot(page, name, selector = '.ncsc-questionnaire') {
    if (!imageDirectory) return;
    fs.mkdirSync(imageDirectory, { recursive: true });
    const target = page.locator(selector);
    await target.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await target.screenshot({ path: path.join(imageDirectory, name + '.png') });
}

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 950 } });
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
            await page.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== origin || request.method() !== 'GET') {
                    unexpected.push(request.method() + ' external request'); return route.abort();
                }
                return route.continue();
            });
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            await page.goto(origin + '/questionnaire-frame.html'); await openCyber(page);
            const rows = page.locator('.ncsc-assessment-list li');
            assert.equal(await rows.count(), 2);
            for (let index = 0; index < 2; index++) {
                const record = fixtures.tenants[0].assessments[index], row = rows.nth(index);
                assert.ok((await row.locator('p').textContent()).includes(record.assessmentId));
                assert.ok((await row.locator('p').textContent()).includes(record.updatedAt.replace('T', ' ').replace('Z', ' UTC')));
                assert.equal(await row.locator('button').getAttribute('aria-describedby'), await row.locator('p').getAttribute('id'));
            }
            await layout(page); await screenshot(page, 'assessment-list-' + width);
            await rows.first().locator('button').click();
            const picker = page.locator('#ncsc-question-index');
            await picker.selectOption('0');
            await jump(page, 1); // Unknown is unresolved even though it is answered.
            await jump(page, 3); // Skip the resolved third answer; find the first unanswered one.
            await picker.selectOption('13'); await jump(page, 0); // Wrap to pending N/A.
            await picker.selectOption('1'); await page.locator('.ncsc-question input[value="no"]').check();
            await picker.selectOption('0'); await jump(page, 3); // Local resolution changes navigation only.
            assert.match(await page.locator('.ncsc-status').textContent(), /unsaved changes/);
            await layout(page); await screenshot(page, 'assessment-navigation-' + width, '.ncsc-question-navigation');

            await page.locator('#scenario').selectOption('delay');
            await page.getByRole('button', { name: 'Arm next mutation', exact: true }).click();
            await page.getByRole('button', { name: 'Save progress', exact: true }).click();
            const home = width === 1440 ? page.locator('.dashboard-module-link[data-module="overview"]') :
                page.getByRole('navigation', { name: 'Dashboard tasks', exact: true }).getByRole('button', { name: 'Home', exact: true });
            const originalHome = await home.elementHandle();
            await home.focus(); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Resolve the running'));
            assert.equal(await originalHome.evaluate(node => node.isConnected && node === document.activeElement), true);
            assert.equal(await home.getAttribute('aria-current'), null);
            assert.equal(await page.locator('.ncsc-questionnaire').count(), 1);
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            assert.equal(await originalHome.evaluate(node => node.isConnected && node === document.activeElement), true);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => !document.querySelector('.ncsc-questionnaire'));
            await openCyber(page); await rows.nth(1).locator('button').click();
            await page.getByRole('button', { name: 'Submit assessment', exact: true }).click();
            await page.locator('.ncsc-sealed').waitFor();
            await jump(page, 1); // Submitted Unknown answers remain available read-only.
            assert.equal(await page.getByRole('button', { name: 'Save progress', exact: true }).count(), 0);
            assert.equal(await page.locator('.ncsc-question input:not(:disabled)').count(), 0);
            await layout(page);
            await page.getByRole('button', { name: 'Back to assessments', exact: true }).click();
            await page.getByRole('button', { name: 'Load more assessments', exact: true }).click();
            await rows.nth(2).locator('button').click();
            assert.equal(await page.getByRole('button', { name: 'Next unresolved question', exact: true }).isDisabled(), true);
            await layout(page);
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            results.push({ width, savedReferences: true, keyboardDraftAndSubmittedNavigation: true,
                delayedSaveNavigationRetainsFocus: true, allResolvedDisabled: true, noHorizontalOverflow: true });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        for (const source of preview.sources) assert.equal(createHash('sha256')
            .update(fs.readFileSync(path.join(root, source.path))).digest('hex'), source.sha256, 'Source changed during verification');
        console.log(JSON.stringify({ results, pageErrors: 0, unexpectedRequests: 0, sources: preview.sources, syntheticOnly: true }));
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
