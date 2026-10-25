'use strict';

// Optional actual-Chromium regression check, using existing installations only.
// node scripts/tests/dashboard-ready-browser.cjs
// All HTTP and data are synthetic loopback GETs; no login, cookies or provider I/O.
// NOFRIES_DASHBOARD_TEST_CSS may point to retained baseline CSS for a RED control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { fixture } = require('../../test/fixtures/dashboardFixture');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');
const questionnaire = require('../../api/shared/protectedAssets/ncscQuestionnaire');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'organisationPicture.js'];
const sources = ['app/dashboard.css', 'app/dashboard.html', 'js/dashboard-loader.js', 'lib/dashboardDocument.js',
    'api/shared/appLifecycle/dashboardProjection.js', 'test/fixtures/dashboardFixture.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file), 'scripts/tests/dashboard-ready-browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, sha256(read(file))]));
const before = hashes();
const css = process.env.NOFRIES_DASHBOARD_TEST_CSS ? fs.readFileSync(process.env.NOFRIES_DASHBOARD_TEST_CSS) : read('app/dashboard.css');
const app = Buffer.from(bundleFiles.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n'));
const document = buildDashboardDocument({ template: read('app/dashboard.html').toString(), loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app.toString(), protectedStyleSource: css.toString() });
assert.ok(document.contentSecurityPolicy.includes("style-src-attr 'none'"));
const fixtures = buildFixtures();
const seed = fixtures.tenants[0];
const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: seed.model.context.organisationId });
const answers = allResponses().map((row, index) => ({ ...row,
    optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
    rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
let version = null;
for (const command of [createCommand('assessment-mixed', 'create-mixed', 'Synthetic office and cloud scope.'),
    saveCommand('assessment-mixed', 0, 'save-mixed', answers), submitCommand('assessment-mixed', 1, 'submit-mixed')]) {
    version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
        action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
    command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
}
const detail = projectNcscDetail(version);
const expected = questionnaire.resultModel(detail, fixtures.metadata, seed.model.context.organisationId);
assert.equal(expected.attainment, '46.4%–60.7%');
const glue = Buffer.from(`const detail = ${JSON.stringify(detail)}, metadata = ${JSON.stringify(fixtures.metadata)};
    NoFriesOrganisationPicture.mount(document.getElementById('picture'), { metadata, organisationId: ${JSON.stringify(seed.model.context.organisationId)},
        displayName: 'Synthetic organisation', client: { list: async () => ({ assessments: [detail], nextAfterAssessmentId: null }),
            read: async () => ({ assessment: detail }) } });`);
const pictureHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Synthetic range check</title><link rel="stylesheet" href="/api/dashboard/dashboard.css" integrity="${document.styleIntegrity}" crossorigin="anonymous">
    <body class="nofries-dashboard"><main id="picture" class="dashboard-main"></main>
    <script src="/api/dashboard/app.js" integrity="${document.appIntegrity}" crossorigin="anonymous"></script><script src="/picture-fixture.js"></script></body></html>`;
const now = new Date().toISOString();
const input = fixture({ now, name: 'Synthetic focus organisation' });
const enteredJobTitle = 'Managing Director', longJobTitle = 'W'.repeat(120);
function titleProjection(jobTitle) {
    return projectDashboard({ ...input, currentUserProfile: { ...input.scope, subjectKey: input.subjectKey,
        membershipId: input.membershipState.memberships[0].membershipId, jobTitle } });
}
const legacyModel = { ...projectDashboard(input) }; delete legacyModel.currentUser;
const models = { entered: titleProjection(enteredJobTitle), long: titleProjection(longJobTitle), legacy: legacyModel };
const binding = '10000000-0000-4000-8000-000000000001';
const session = { schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', generation: 'a'.repeat(64),
    selectedBindingId: binding, expiresAt: new Date(Date.now() + 3600000).toISOString() };
const assets = { '/style.css': 'style.css', '/home.css': 'home.css', '/favicon.svg': 'favicon.svg', '/images/nofrieslogo.png': 'images/nofrieslogo.png' };
const requests = [], blocked = [], errors = [], results = [];
let expired = false, scenario = 'entered';
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-dashboard-ready-browser-'));
fs.chmodSync(artifacts, 0o700);
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    let body, type = 'application/json';
    if (req.method !== 'GET') { blocked.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end(); }
    if (pathname === '/dashboard') { body = document.html; type = 'text/html'; }
    else if (pathname === '/picture') { body = pictureHtml; type = 'text/html'; }
    else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/picture-fixture.js') { body = glue; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/session') { res.statusCode = expired ? 401 : 200; body = JSON.stringify(expired ? { code: 'dashboard_session_expired' } : session); }
    else if (pathname === '/api/dashboard/organisations') { body = JSON.stringify({ schemaVersion: 1,
        bindings: [{ bindingId: binding, organisationLabel: 'Synthetic focus organisation' }], nextAfterBindingId: null }); }
    else if (pathname === '/api/dashboard/bootstrap') { body = JSON.stringify(models[scenario]); }
    else if (assets[pathname]) { body = read(assets[pathname]); type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png'; }
    else { blocked.push({ method: req.method, path: pathname }); res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', type); res.end(body);
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser, page, failure = null, failureState = null, phase = 'launch';
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            page = await context.newPage();
            await page.addInitScript(() => {
                window.styleViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.styleViolations.push(event.effectiveDirective));
            });
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== base || request.method() !== 'GET') {
                    blocked.push({ method: request.method(), external: true }); return route.abort();
                }
                return route.continue();
            });
            phase = width + ':picture';
            await page.goto(base + '/picture');
            await page.locator('.picture-domain-track').last().waitFor();
            const ranges = await page.locator('.picture-domain-track').evaluateAll(tracks => tracks.map(track => {
                const style = getComputedStyle(track.querySelector('.picture-domain-uncertainty'));
                return { trackWidth: track.getBoundingClientRect().width, left: parseFloat(style.left), width: parseFloat(style.width),
                    lower: track.style.getPropertyValue('--picture-lower'), upper: track.style.getPropertyValue('--picture-upper') };
            }));
            assert.equal(ranges.length, expected.domains.length);
            assert.ok(expected.domains.some(domain => domain.upperPercentTenths > domain.lowerPercentTenths));
            ranges.forEach((range, index) => {
                const domain = expected.domains[index];
                assert.ok(range.trackWidth > 0);
                assert.equal(range.lower, domain.lowerPercentTenths / 10 + '%');
                assert.equal(range.upper, domain.upperPercentTenths / 10 + '%');
                assert.ok(Math.abs(range.left - range.trackWidth * domain.lowerPercentTenths / 1000) < 1);
                assert.ok(Math.abs(range.width - range.trackWidth * (domain.upperPercentTenths - domain.lowerPercentTenths) / 1000) < 1);
            });
            assert.deepEqual(await page.evaluate(() => window.styleViolations), []);
            await page.evaluate(() => {
                const probe = document.createElement('div'); probe.id = 'blocked-inline-style'; document.body.append(probe);
                probe.setAttribute('style', 'display:none');
            });
            await page.waitForFunction(() => window.styleViolations.includes('style-src-attr'));
            assert.notEqual(await page.locator('#blocked-inline-style').evaluate(node => getComputedStyle(node).display), 'none');
            results.push({ width, ranges, cssomViolations: 0, negativeControlBlocked: true });
            expired = false; scenario = 'entered';
            phase = width + ':entered';
            await page.goto(base + '/dashboard#overview');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(await page.locator('.dashboard-topbar .dashboard-muted').textContent(), enteredJobTitle);
            assert.equal(await page.locator('.dashboard-context .dashboard-muted').textContent(), enteredJobTitle);
            const initialFocus = await page.evaluate(() => document.activeElement.id);
            results.push({ width, scenario, jobTitle: enteredJobTitle, readyFocus: initialFocus });
            assert.equal(initialFocus, 'dashboardHeading', 'Ready heading must remain focusable with actual protected CSS');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'dashboardSignOut');
            phase = width + ':focus-revalidation';
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready' && document.activeElement.id === 'dashboardHeading');
            phase = width + ':expiry-focus';
            expired = true;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'expired');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'dashboardHeading');
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            assert.equal(await page.locator('#dashboardHeading').evaluate(node => getComputedStyle(node).display === 'none'), false);
            assert.deepEqual(await page.evaluate(() => window.styleViolations), []);
            results.push({ width, focusRevalidated: true, expiryContentCleared: true, expiryHeadingFocused: true });
            for (const variant of ['long', 'legacy']) {
                expired = false; scenario = variant;
                phase = width + ':' + variant;
                // Same-URL/hash navigation can retain the expired document.
                // Each fixture variant needs a fresh document and GET chain.
                await page.reload();
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
                assert.equal(await page.evaluate(() => document.activeElement.id), 'dashboardHeading');
                if (variant === 'long') {
                    assert.equal(await page.locator('.dashboard-topbar .dashboard-muted').textContent(), longJobTitle);
                    assert.equal(await page.locator('.dashboard-context .dashboard-muted').textContent(), longJobTitle);
                    const layout = await page.locator('.dashboard-topbar .dashboard-muted').evaluate(node => {
                        const range = document.createRange(); range.selectNodeContents(node);
                        const rect = node.getBoundingClientRect();
                        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
                            bodyScrollWidth: document.body.scrollWidth, titleClientWidth: node.clientWidth, titleScrollWidth: node.scrollWidth,
                            titleLeft: rect.left, titleRight: rect.right, titleHeight: rect.height, lines: range.getClientRects().length };
                    });
                    assert.ok(layout.lines > 1 && layout.titleHeight > 0, 'The 120-character unbroken title must wrap visibly');
                    assert.ok(layout.scrollWidth <= layout.viewport + 1 && layout.bodyScrollWidth <= layout.viewport + 1,
                        'The long title must not create viewport overflow');
                    assert.ok(layout.titleScrollWidth <= layout.titleClientWidth + 1 && layout.titleLeft >= 0 && layout.titleRight <= width + 1,
                        'The long title must stay inside its visible header');
                    results.push({ width, scenario, jobTitleLength: longJobTitle.length, layout });
                } else {
                    assert.equal(await page.locator('.dashboard-topbar .dashboard-muted').count(), 0);
                    assert.equal(await page.locator('.dashboard-context .dashboard-muted').count(), 0);
                    assert.doesNotMatch(await page.locator('.dashboard-topbar').textContent(), /IT manager|Executive \/ board|Scoped advisor/);
                    assert.doesNotMatch(await page.locator('.dashboard-context').textContent(), /IT manager|Executive \/ board|Scoped advisor/);
                    results.push({ width, scenario, currentUserAbsent: true, inferredRoleAbsent: true });
                }
                assert.deepEqual(await page.evaluate(() => window.styleViolations), []);
            }
            await context.close();
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
        assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ passed: true, browser: browser.version(), syntheticOnly: true, artifacts, results }));
    } catch (error) {
        if (page && !page.isClosed()) failureState = await page.evaluate(() => ({ state: document.body.dataset.dashboardState,
            focus: document.activeElement.id, appHidden: document.getElementById('dashboardApp')?.hidden })).catch(() => null);
        failure = error.message; throw error;
    } finally {
        try {
            fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure, phase, failureState, results, errors, blocked,
                requests, sourceHashesBefore: before, sourceHashesAfter: hashes(), cssSha256: sha256(css),
                browser: browser && browser.version() }, null, 2), { mode: 0o600 });
        } finally {
            try { if (browser) await browser.close(); }
            finally { await new Promise(resolve => server.close(resolve)); }
        }
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
