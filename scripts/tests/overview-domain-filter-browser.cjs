'use strict';

// Optional synthetic Chromium check using an existing Playwright/browser install.
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/tests/overview-domain-filter-browser.cjs
// NOFRIES_DOMAIN_FILTER_SCREENSHOTS optionally saves synthetic review images outside source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } =
    require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const fixtures = buildFixtures(), seed = fixtures.tenants[0], metadata = fixtures.metadata;
const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: seed.model.context.organisationId });
const responses = allResponses().map((row, index) => ({ ...row,
    optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
    rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
let version = null;
for (const command of [createCommand('assessment-mixed', 'create-mixed', 'Synthetic office and cloud scope.'),
    saveCommand('assessment-mixed', 0, 'save-mixed', responses), submitCommand('assessment-mixed', 1, 'submit-mixed')]) {
    version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
        action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
    command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
}
const detail = projectNcscDetail(version);
const categoryLabels = ['Unresolved answers', 'Reported implementation gaps', 'Supporting-evidence gaps'];
const optionGroups = [['unknown', 'not_applicable'], ['partial', 'no'], null];
const domainByControl = new Map(metadata.controls.map(control => [control.id, control.domainId]));
const expectedIds = (index, domainId) => metadata.questions.filter(question =>
    (!domainId || domainByControl.get(question.controlId) === domainId) &&
    (!optionGroups[index] || optionGroups[index].includes(responses.find(row => row.itemId === question.id).optionId)))
    .map(question => question.id);
const app = ['ncscQuestionnaire.js', 'organisationPicture.js']
    .map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const css = read('app/dashboard.css');
const document = buildDashboardDocument({ template: read('app/dashboard.html'),
    loaderSource: read('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: css });
const glue = `const detail = ${JSON.stringify(detail)};
    window.fixture = { listCalls: [], readCalls: [] };
    NoFriesOrganisationPicture.mount(document.getElementById('picture'), {
        metadata: ${JSON.stringify(metadata)}, organisationId: ${JSON.stringify(seed.model.context.organisationId)},
        displayName: 'Synthetic review organisation', client: {
            list: async ({ afterAssessmentId }) => { fixture.listCalls.push(afterAssessmentId);
                return { assessments: [detail], nextAfterAssessmentId: null }; },
            read: async id => { fixture.readCalls.push(id); return { assessment: detail }; }
        } });`;
const html = '<!doctype html><html lang="en-NZ"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic domain filter review</title>' +
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
        for (const width of [1440, 390, 320]) {
            browser = await chromium.launch({ headless: true,
                executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
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
            const filter = page.getByLabel('Filter follow-up by NCSC function', { exact: true });
            await filter.waitFor();
            assert.deepEqual(await filter.locator('option').allTextContents(), ['All functions', ...metadata.domains.map(domain => domain.title)]);
            const metrics = await page.locator('.picture-metrics').textContent();
            const domainMetrics = await page.locator('.picture-domains').textContent();
            const source = await page.locator('.picture-source').textContent();
            const categories = page.locator('.picture-follow-up > details');
            for (let i = 0; i < categoryLabels.length; i++) {
                await categories.nth(i).locator(':scope > summary').focus(); await page.keyboard.press('Enter');
            }
            async function check(domainId) {
                assert.equal(await filter.inputValue(), domainId);
                for (let i = 0; i < categoryLabels.length; i++) {
                    const category = categories.nth(i), ids = expectedIds(i, domainId), total = expectedIds(i).length;
                    assert.equal(await category.getAttribute('open'), '');
                    assert.deepEqual(await category.locator('article:visible').evaluateAll(nodes =>
                        nodes.map(node => node.getAttribute('data-question-id'))), ids);
                    assert.equal(await category.locator(':scope > summary').textContent(), categoryLabels[i] + ' · ' +
                        (domainId ? ids.length + ' of ' + total + ' shown' : total));
                    assert.equal(await category.locator('.picture-follow-up-empty').isVisible(), !!domainId && ids.length === 0);
                }
                assert.equal(await page.locator('.picture-metrics').textContent(), metrics);
                assert.equal(await page.locator('.picture-domains').textContent(), domainMetrics);
                assert.equal(await page.locator('.picture-source').textContent(), source);
                assert.equal(await filter.evaluate(node => node === document.activeElement), true);
                assert.notEqual(await filter.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
            await filter.focus(); await check('');
            for (const domain of metadata.domains) {
                await page.keyboard.press('ArrowDown'); await check(domain.id);
                assert.match(await page.locator('.picture-follow-up-status').textContent(), new RegExp('^Showing ' + domain.title + ':'));
            }
            await page.keyboard.press('Home'); await check('');
            assert.equal(await page.locator('.picture-follow-up-status').textContent(), 'Showing all functions.');
            await page.keyboard.press('End'); await check(metadata.domains.at(-1).id);
            assert.deepEqual(await page.evaluate(() => fixture), { listCalls: [null], readCalls: [detail.assessmentId] });
            if (process.env.NOFRIES_DOMAIN_FILTER_SCREENSHOTS) {
                fs.mkdirSync(process.env.NOFRIES_DOMAIN_FILTER_SCREENSHOTS, { recursive: true });
                await page.locator('.picture-follow-up').screenshot({ path: path.join(process.env.NOFRIES_DOMAIN_FILTER_SCREENSHOTS,
                    'overview-domain-filter-' + width + '.png') });
            }
            await page.getByRole('button', { name: 'Refresh', exact: true }).focus(); await page.keyboard.press('Enter');
            await filter.waitFor();
            assert.equal(await filter.inputValue(), '');
            assert.equal(await page.locator('.picture-follow-up-status').textContent(), 'Showing all functions.');
            assert.equal(await page.locator('.picture-metrics').textContent(), metrics);
            assert.deepEqual(await page.evaluate(() => fixture), { listCalls: [null, null], readCalls: [detail.assessmentId, detail.assessmentId] });
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            results.push({ width, allDomainIdsAndCounts: true, keyboardFilterAndReset: true, emptyStates: true,
                scoresUnchanged: true, openCategoriesPreserved: true, visibleFocus: true, refreshResetAndReads: true,
                noHorizontalOverflow: true });
            await browser.close(); browser = null;
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        console.log(JSON.stringify({ results, pageErrors: errors.length, blockedRequests: blocked.length }));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
