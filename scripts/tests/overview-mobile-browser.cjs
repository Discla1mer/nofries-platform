'use strict';

// Synthetic signed-in documents using the real loader, shell and Overview.
// Run with an existing Playwright/Chromium install; no credentials or API writes.
// NOFRIES_MOBILE_ARTIFACTS keeps screenshots/measurements outside the checkout.
// NOFRIES_MOBILE_CSS + NOFRIES_MOBILE_BASELINE=1 retain a pre-change control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } =
    require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');

const root = path.resolve(__dirname, '../..'), read = file => fs.readFileSync(path.join(root, file));
const artifacts = path.resolve(process.env.NOFRIES_MOBILE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nf-overview-mobile-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep evidence outside source');
fs.mkdirSync(artifacts, { recursive: true });
const baseline = process.env.NOFRIES_MOBILE_BASELINE === '1';
const css = process.env.NOFRIES_MOBILE_CSS ? fs.readFileSync(process.env.NOFRIES_MOBILE_CSS) : read('app/dashboard.css');
const app = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js',
    'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
    .map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const options = { customerLogin: true, customerTransport: 'auto', loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app, protectedStyleSource: css.toString() };
const documents = Object.fromEntries([['/dashboard', 'app/dashboard.html'], ['/', 'index.html']].map(([url, file]) =>
    [url, (url === '/' ? buildGatewayDocument : buildDashboardDocument)({ ...options, template: read(file).toString() })]));
const fixtures = buildFixtures(), seed = fixtures.tenants[0], model = seed.model;
const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: model.context.organisationId });
const responses = allResponses().map((row, i) => ({ ...row, optionId: ['yes', 'partial', 'no', 'unknown'][i % 4] }));
let version = null;
for (const command of [createCommand('assessment-mobile', 'create-mobile', 'Synthetic office and cloud services.'),
    saveCommand('assessment-mobile', 0, 'save-mobile', responses), submitCommand('assessment-mobile', 1, 'submit-mobile')]) {
    version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
        action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
    command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
}
const record = projectNcscDetail(version);
const summary = Object.fromEntries(['assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256',
    'createdAt', 'updatedAt', 'progress'].map(key => [key, record[key]]));
const bindingId = '10000000-0000-4000-8000-000000000001';
const longName = 'Synthetic regional organisation for community technology and shared cloud services '.repeat(3).slice(0, 200);
const unbrokenName = 'SyntheticUnbrokenOrganisation'.repeat(8).slice(0, 200);
const owner = 'Alexandria Synthetic Operations and Regional Technology Coordination Lead'.slice(0, 80);
const action = (id, title, dueDate, isOverdue = false) => ({ actionId: id, status: 'open', dueDate, isOverdue,
    ownerLabel: owner, rationale: { suggestedAction: title } });
const actions = [action('long', 'Confirm the recovery responsibilities for every regional office and shared cloud service before the next scheduled recovery exercise.', '2026-09-22', true),
    action('short', 'Review access', '2026-09-30'),
    action('unbroken', 'SyntheticUnbrokenActionTitle'.repeat(5), '9999-12-31')];
actions[2].ownerLabel = 'SyntheticUnbrokenOwnerName'.repeat(3);
const actionList = { scope: { planId: 'plan-mobile' }, planRevision: 1, asOf: '2026-09-23T00:00:00.000Z', actions };
const assets = Object.fromEntries(['style.css', 'home.css', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png',
    'images/nofrieslogo.png', 'js/organisation-setup.js', 'js/home.js', 'js/enquiry-availability.js', 'js/enquiry-home.js',
    'images/paper-texture.webp', 'images/nofries-mark-large.webp', 'assets/fonts/fraunces-latin-opsz-normal.woff2',
    'assets/fonts/fraunces-latin-opsz-italic.woff2'].map(file => ['/' + file, file]));
let mode = 'actions', enlarged = false;
const blocked = [], errors = [], observations = [], failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET') { blocked.push(req.method + ' ' + pathname); res.writeHead(405); return res.end(); }
    let body, type = 'application/json';
    if (documents[pathname]) { body = documents[pathname].html; type = 'text/html'; res.setHeader('Content-Security-Policy', documents[pathname].contentSecurityPolicy); }
    else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true, purpose: 'customer',
        accountType: 'company', generation: 'a'.repeat(64), selectedBindingId: bindingId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1,
        bindings: [{ bindingId, organisationLabel: model.context.displayName }], nextAfterBindingId: null };
    else if (pathname === '/api/dashboard/bootstrap') body = model;
    else if (pathname === '/api/dashboard/modules/cyber_security') body = { schemaVersion: 1, context: model.context,
        generatedAt: model.generatedAt, module: model.modules.find(item => item.key === 'cyber_security'), summary: model.summary,
        services: model.services, admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
    else if (pathname === '/api/dashboard/ncsc/assessments') body = { schemaVersion: 1, assessments: [summary], nextAfterAssessmentId: null };
    else if (pathname === '/api/dashboard/ncsc/assessments/assessment-mobile') body = { schemaVersion: 1, assessment: record };
    else if (pathname === '/api/dashboard/improvement/plans') body = { plans: mode === 'empty' ? [] : [{ planId: 'plan-mobile', planRevision: 1 }], nextAfterPlanId: null };
    else if (pathname === '/api/dashboard/improvement/list') body = actionList;
    else if (pathname === '/api/enquiry') body = { available: false };
    else if (assets[pathname]) {
        body = read(assets[pathname]);
        if (pathname === '/style.css' && enlarged) body = Buffer.concat([body, Buffer.from('\nhtml { font-size: 200%; }\n')]);
        type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.woff2') ? 'font/woff2' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    }
    if (body === undefined) { blocked.push(req.url); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
});

async function measure(page, label) {
    const result = await page.evaluate(() => {
        const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
        const describe = node => ({ tag: node.tagName, class: node.className, text: node.textContent.trim().slice(0, 100) });
        const controls = [...document.querySelectorAll('body :is(a, button, select, summary)')].filter(visible);
        const splitWords = [];
        for (const label of document.querySelectorAll('.dashboard-mobile-nav .dashboard-task > span:last-child')) {
            const text = label.firstChild;
            for (const word of text.textContent.matchAll(/\S+/g)) {
                const range = document.createRange(); range.setStart(text, word.index); range.setEnd(text, word.index + word[0].length);
                if (range.getClientRects().length > 1) splitWords.push(word[0]);
            }
        }
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            splitWords,
            overflow: [...document.querySelectorAll('.dashboard-main *, .dashboard-mobile-nav *, .dashboard-topbar *')]
                .filter(visible).filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(describe),
            small: controls.filter(node => { const box = node.getBoundingClientRect(); return box.width < 44 || box.height < 44; })
                .map(node => ({ ...describe(node), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
            clipped: [...document.querySelectorAll('.picture-action-title, .picture-action-meta, .dashboard-menu-state, .dashboard-topbar')]
                .filter(visible).filter(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map(describe),
            violations: window.violations };
    });
    observations.push({ label, ...result });
    check(result.scrollWidth <= result.width + 1 && result.overflow.length === 0, label + ': horizontal overflow');
    check(result.small.length === 0, label + ': targets below 44px');
    check(result.clipped.length === 0, label + ': clipped text');
    check(result.splitWords.length === 0, label + ': navigation splits words');
    assert.deepEqual(result.violations, []);
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const page = await browser.newPage({ reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => { window.violations = []; document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective)); });
        await page.route('**/*', route => {
            if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') { blocked.push(route.request().url()); return route.abort(); }
            return route.continue();
        });
        for (const route of ['/dashboard', '/']) for (const width of [375, 390]) for (const zoom of [false, true]) {
            enlarged = zoom; model.context.displayName = zoom ? unbrokenName : longName;
            for (const scenario of ['actions', 'empty', 'planned']) {
                mode = scenario; model.modules.find(item => item.key === 'improvement_plan').state = mode === 'planned' ? 'planned' : 'ready';
                await page.setViewportSize({ width, height: 844 }); await page.goto('about:blank'); await page.goto(origin + route + '#overview');
                await page.locator('.picture-top-gaps').waitFor();
                const label = (route === '/' ? 'gateway' : 'dashboard') + '-' + width + (zoom ? '-text200' : '') + '-' + mode;
                assert.equal(await page.locator('.picture-metrics').count(), 1);
                assert.equal(await page.locator('.picture-top-gap').count(), 3);
                if (mode === 'planned') {
                    await page.locator('.dashboard-mobile-nav .dashboard-menu-other > summary').click();
                    assert.match(await page.locator('.dashboard-mobile-nav [data-module="improvement_plan"]').textContent(), /Included · coming next/);
                    assert.equal(await page.locator('.picture-actions').count(), 0);
                } else {
                    await page.locator('.picture-actions').waitFor();
                    if (mode === 'actions') {
                        assert.match(await page.locator('.picture-actions').textContent(), /Due 31 Dec 9999/);
                        assert.match(await page.locator('.picture-actions').textContent(), /Due 30 Sept 2026/);
                        assert.match(await page.locator('.picture-actions').textContent(), /Owner: Alexandria/);
                    } else {
                        await page.locator('.picture-actions-empty a').click();
                        assert.equal(await page.locator('.picture-top-gaps h3').evaluate(node => node === document.activeElement), true);
                    }
                }
                await measure(page, label);
                if (!zoom && route === '/dashboard') {
                    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                    await page.screenshot({ path: path.join(artifacts, label + '-top.png') });
                    await page.screenshot({ path: path.join(artifacts, label + '-full.png'), fullPage: true });
                    for (const [name, selector] of [['actions', '.picture-actions'], ['score', '.picture-metrics'], ['gaps', '.picture-top-gaps']]) {
                        if (mode === 'actions') {
                            const clip = await page.locator(selector).boundingBox();
                            await page.screenshot({ path: path.join(artifacts, label + '-' + name + '.png'), fullPage: true, clip });
                        }
                    }
                }
                const scores = await page.locator('.picture-metrics').textContent();
                for (const selector of ['.picture-follow-up > details > summary', '.picture-summary > summary', '.ncsc-result-provenance > summary']) {
                    const target = page.locator(selector).first(); await target.focus(); await page.keyboard.press('Enter');
                    assert.equal(await target.evaluate(node => node.parentElement.open), true);
                    assert.ok(await target.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 3));
                }
                await measure(page, label + '-expanded');
                assert.equal(await page.locator('.picture-metrics').textContent(), scores);
            }
            // Service availability is reached from Overview's existing Services link.
            model.services[0].state = 'setup_required'; model.services[1].state = 'disabled';
            await page.reload(); await page.locator('.picture-top-gaps').waitFor();
            await page.locator('.dashboard-mobile-nav [data-module="services"]').click();
            await page.locator('.dashboard-service-cards').waitFor();
            assert.match(await page.locator('.dashboard-service-cards').textContent(), /Waiting for setup/);
            assert.match(await page.locator('.dashboard-service-cards').textContent(), /Included · unavailable/);
            assert.match(await page.locator('.dashboard-service-cards').textContent(), /Available to scope/);
            await measure(page, route + '-' + width + '-' + zoom + '-services');
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        if (!baseline) assert.deepEqual(failures, []);
        console.log(JSON.stringify({ baseline, observations: observations.length, failures: failures.length, errors, blocked, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ baseline, failures, errors, blocked, observations }, null, 2));
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
