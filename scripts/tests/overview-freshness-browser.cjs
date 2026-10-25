'use strict';

// Optional synthetic Chromium check using an existing Playwright/browser install.
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/tests/overview-freshness-browser.cjs
// NOFRIES_FRESHNESS_SCREENSHOTS optionally saves synthetic review images outside source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const fixtures = buildFixtures(), seed = fixtures.tenants[0];
const detail = seed.assessments.find(record => record.status === 'submitted');
const app = ['ncscQuestionnaire.js', 'organisationPicture.js']
    .map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const css = read('app/dashboard.css');
const document = buildDashboardDocument({ template: read('app/dashboard.html'),
    loaderSource: read('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: css });
const glue = `const detail = ${JSON.stringify(detail)};
    const next = { ...detail, assessmentId: 'synthetic-next-assessment' };
    window.fixture = { failNextList: false, listCalls: [], readCalls: [] };
    NoFriesOrganisationPicture.mount(document.getElementById('picture'), {
        metadata: ${JSON.stringify(fixtures.metadata)}, organisationId: ${JSON.stringify(seed.model.context.organisationId)},
        displayName: 'Synthetic review organisation', client: {
            list: async ({ afterAssessmentId }) => {
                fixture.listCalls.push(afterAssessmentId);
                if (fixture.failNextList) { fixture.failNextList = false; throw { statusCode: 503 }; }
                return afterAssessmentId === null
                    ? { assessments: [detail], nextAfterAssessmentId: detail.assessmentId }
                    : { assessments: [next], nextAfterAssessmentId: null };
            },
            read: async id => { fixture.readCalls.push(id); return { assessment: detail }; }
        } });`;
const html = '<!doctype html><html lang="en-NZ"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic freshness review</title>' +
    '<link rel="stylesheet" href="/dashboard.css"><body class="nofries-dashboard">' +
    '<main id="picture" class="dashboard-main"></main><script src="/app.js"></script>' +
    '<script src="/fixture.js"></script></body></html>';
const assets = { '/': ['text/html', html], '/app.js': ['text/javascript', app],
    '/dashboard.css': ['text/css', css], '/fixture.js': ['text/javascript', glue] };
const errors = [], blocked = [], results = [];
const server = http.createServer((req, res) => {
    const asset = assets[req.url];
    if (req.method !== 'GET' || !asset) { blocked.push(req.method + ' ' + req.url); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': asset[0], 'Content-Security-Policy': document.contentSecurityPolicy,
        'Cache-Control': 'no-store' }); res.end(asset[1]);
});

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 950 } });
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== base || route.request().method() !== 'GET') {
                    blocked.push('unexpected network request'); return route.abort();
                }
                return route.continue();
            });
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            await page.goto(base);
            await page.locator('.picture-metrics').waitFor();
            assert.match(await page.locator('.picture-heading').textContent(), /not a live check of connected systems/);
            assert.match(await page.locator('#picture').textContent(), /Refresh reloads saved assessments/);
            assert.match(await page.locator('.picture-metrics').textContent(), /Coverage recorded in this saved assessment/);
            const source = await page.locator('.picture-source').textContent();
            const metrics = await page.locator('.picture-metrics').textContent();
            for (const label of ['Refresh', 'Load more']) {
                const before = await page.evaluate(() => ({ lists: fixture.listCalls.length, reads: fixture.readCalls.length }));
                await page.evaluate(() => { fixture.failNextList = true; });
                const trigger = page.getByRole('button', { name: label, exact: true });
                await trigger.focus(); await page.keyboard.press('Enter');
                const retry = page.getByRole('button', { name: 'Retry', exact: true });
                await retry.waitFor();
                assert.equal(await page.locator('.picture-metrics').count(), 0);
                await retry.focus();
                assert.notEqual(await retry.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
                await page.keyboard.press('Enter');
                await page.locator('.picture-metrics').waitFor();
                const calls = await page.evaluate(() => ({ lists: fixture.listCalls, reads: fixture.readCalls }));
                assert.equal(calls.lists.length, before.lists + 2);
                const cursor = label === 'Refresh' ? null : detail.assessmentId;
                assert.deepEqual(calls.lists.slice(-2), [cursor, cursor]);
                assert.equal(calls.reads.length, before.reads + 1);
                assert.equal(await page.locator('.picture-toolbar select').evaluate(node => node === document.activeElement), true);
                assert.equal(await page.locator('.picture-toolbar select').inputValue(), detail.assessmentId);
                assert.equal(await page.locator('.picture-source').textContent(), source);
                assert.equal(await page.locator('.picture-metrics').textContent(), metrics);
                assert.equal(await retry.count(), 0);
            }
            assert.equal(await page.locator('.picture-toolbar option').count(), 2);
            assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            if (process.env.NOFRIES_FRESHNESS_SCREENSHOTS) {
                fs.mkdirSync(process.env.NOFRIES_FRESHNESS_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.NOFRIES_FRESHNESS_SCREENSHOTS,
                    'overview-freshness-' + width + '.png') });
            }
            results.push({ width, refreshRetry: true, paginationRetry: true, savedSourceUnchanged: true,
                keyboardFocus: true, noHorizontalOverflow: true });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        console.log(JSON.stringify({ results, pageErrors: errors.length, blockedRequests: blocked.length }));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
