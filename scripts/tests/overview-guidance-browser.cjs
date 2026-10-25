'use strict';

// Optional synthetic Chromium check using an existing Playwright/browser install.
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/tests/overview-guidance-browser.cjs
// NOFRIES_GUIDANCE_SCREENSHOTS optionally saves synthetic review images outside source.
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
    NoFriesOrganisationPicture.mount(document.getElementById('picture'), {
        metadata: ${JSON.stringify(fixtures.metadata)}, organisationId: ${JSON.stringify(seed.model.context.organisationId)},
        displayName: 'Synthetic review organisation', client: {
            list: async () => ({ assessments: [detail], nextAfterAssessmentId: null }),
            read: async () => ({ assessment: detail }) } });`;
const html = '<!doctype html><html lang="en-NZ"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic guidance review</title>' +
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
            const category = page.locator('.picture-follow-up > details').last();
            const summary = category.locator(':scope > summary');
            await summary.focus();
            await page.keyboard.press('Enter');
            assert.equal(await category.getAttribute('open'), '');
            await page.keyboard.press('Tab');
            const guidance = category.locator('article').first().locator('details');
            assert.equal(await guidance.locator('summary').evaluate(node => node === document.activeElement), true);
            assert.notEqual(await guidance.locator('summary').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
            await page.keyboard.press('Space');
            assert.equal(await guidance.getAttribute('open'), '');
            assert.deepEqual(await guidance.locator('h5').allTextContents(), ['Suggested next actions', 'Useful evidence']);
            assert.equal(await guidance.locator('ul').count(), 2);
            assert.ok(await guidance.locator('ul').first().locator('li').count() > 0);
            assert.ok(await guidance.locator('ul').last().locator('li').count() > 0);
            assert.equal(await category.locator('button,input').count(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            if (process.env.NOFRIES_GUIDANCE_SCREENSHOTS) {
                fs.mkdirSync(process.env.NOFRIES_GUIDANCE_SCREENSHOTS, { recursive: true });
                await category.locator('article').first().screenshot({ path: path.join(process.env.NOFRIES_GUIDANCE_SCREENSHOTS,
                    'overview-guidance-' + width + '.png') });
            }
            await page.keyboard.press('Space');
            assert.equal(await guidance.getAttribute('open'), null);
            await page.keyboard.press('Enter');
            assert.equal(await guidance.getAttribute('open'), '');
            results.push({ width, labelledLists: true, keyboardOpenClose: true, visibleFocus: true, noHorizontalOverflow: true });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        console.log(JSON.stringify({ results, pageErrors: errors.length, blockedRequests: blocked.length }));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
