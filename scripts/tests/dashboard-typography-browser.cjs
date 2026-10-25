'use strict';

// Optional actual-renderer Chromium check using existing installations only.
// NODE_PATH must include the installed Playwright and repository dependencies.
// NOFRIES_TYPOGRAPHY_BASELINE_CSS optionally supplies before-comparison CSS.
// NOFRIES_TYPOGRAPHY_BASELINE_ROOT supplies the actual before renderer and CSS.
// NOFRIES_TYPOGRAPHY_TEST_CSS optionally supplies a candidate/negative control.
// Artifacts are synthetic and are written outside source. No authentication or live I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } =
    require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const baselineRoot = process.env.NOFRIES_TYPOGRAPHY_BASELINE_ROOT;
const baselineRead = file => fs.readFileSync(path.join(baselineRoot, file), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js',
    'ncscQuestionnaire.js', 'organisationPicture.js'];
const app = bundleFiles.map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const tracked = ['app/dashboard.css', 'app/dashboard.html', 'style.css', 'home.css', 'js/dashboard-loader.js',
    'lib/dashboardDocument.js', 'scripts/tests/dashboard-typography-browser.cjs',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file)];
const hashes = () => Object.fromEntries(tracked.map(file => [file, hash(read(file))]));
const beforeHashes = hashes();
const candidateCss = process.env.NOFRIES_TYPOGRAPHY_TEST_CSS
    ? fs.readFileSync(process.env.NOFRIES_TYPOGRAPHY_TEST_CSS, 'utf8') : read('app/dashboard.css');
const styles = { after: candidateCss };
const apps = { after: app };
if (baselineRoot) {
    styles.before = baselineRead('app/dashboard.css');
    apps.before = bundleFiles.map(file => baselineRead('api/shared/protectedAssets/' + file)).join('\n');
} else if (process.env.NOFRIES_TYPOGRAPHY_BASELINE_CSS) {
    styles.before = fs.readFileSync(process.env.NOFRIES_TYPOGRAPHY_BASELINE_CSS, 'utf8');
    apps.before = app;
}
const baselineHashes = baselineRoot ? Object.fromEntries(['app/dashboard.css', ...bundleFiles
    .map(file => 'api/shared/protectedAssets/' + file)].map(file => [file, hash(baselineRead(file))])) : null;
const artifacts = process.env.NOFRIES_TYPOGRAPHY_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-typography-'));
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });

const fixtures = buildFixtures(), seed = fixtures.tenants[0];
const selectedId = '55555555-5555-4555-8555-555555555555';
const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: seed.model.context.organisationId });
const answers = allResponses().map((row, index) => ({ ...row,
    optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
    rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
let version = null;
for (const command of [createCommand(selectedId, 'create-mixed', 'Synthetic office and cloud scope.'),
    saveCommand(selectedId, 0, 'save-mixed', answers), submitCommand(selectedId, 1, 'submit-mixed')]) {
    version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
        action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
    command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
}
seed.assessments.push(projectNcscDetail(version));

// This explicitly synthetic host composes the real renderers and client. It does
// not run or bypass an authentication check: there is no provider/session here.
async function fixtureApplication(seed, metadata, settings, makeTransport, selectedId) {
    const parameters = new URL(location.href).searchParams;
    const variant = parameters.get('variant') || 'after';
    const view = parameters.get('view') || 'overview';
    const fixture = window.fixture = { ready: false, reads: [], writes: 0,
        initialRecords: JSON.stringify(seed.assessments), records: seed.assessments };
    function load(tag, source, integrityId) {
        return new Promise((resolve, reject) => {
            const node = document.createElement(tag);
            node.integrity = document.getElementById(integrityId).content;
            node.crossOrigin = 'anonymous'; node.onload = resolve; node.onerror = reject;
            if (tag === 'script') node.src = source;
            else { node.rel = 'stylesheet'; node.href = source; }
            document.head.append(node);
        });
    }
    await Promise.all([load('script', '/app.js?variant=' + variant, 'dashboardApplicationIntegrity'),
        load('link', '/dashboard.css?variant=' + variant, 'dashboardStyleIntegrity')]);
    if (parameters.has('largeText')) {
        await new Promise(resolve => {
            const link = document.createElement('link'); link.rel = 'stylesheet';
            link.href = '/large-text.css'; link.onload = resolve; document.head.append(link);
        });
    }
    document.body.dataset.dashboardState = 'ready';
    document.getElementById('dashboardSignOut').hidden = false;
    const accountMenu = document.getElementById('dashboardAccountMenu');
    if (accountMenu) { accountMenu.hidden = false; accountMenu.open = true; }
    document.getElementById('dashboardChooser').hidden = false;
    document.getElementById('dashboardChoices').append(Object.assign(document.createElement('button'),
        { type: 'button', textContent: seed.model.context.displayName }));
    const target = document.getElementById('dashboardApp'); target.hidden = false;
    const transport = makeTransport(seed, metadata, settings);
    const client = NoFriesNcscAssessmentClient.createClient({ metadata, fetch(url, options) {
        if (options.method !== 'GET') { fixture.writes++; throw new Error('Typography check prohibits mutations'); }
        fixture.reads.push(url); return transport.fetch(url, options);
    } });
    NoFriesDashboard.mount(target, seed.model, { window,
        initialRoute: ['questionnaire', 'results'].includes(view) ? 'cyber-security'
            : view === 'overview-draft' ? 'overview' : view,
        mountPicture(childRoot, presentation) {
            return NoFriesOrganisationPicture.mount(childRoot, { metadata, client,
                organisationId: seed.model.context.organisationId, displayName: seed.model.context.displayName,
                initialAssessmentId: view === 'overview-draft' ? 'assessment-a' : selectedId, openCyber: presentation.openCyber });
        },
        mountCyber(childRoot) {
            return NoFriesNcscQuestionnaire.mount(childRoot, { metadata, client, window,
                organisationId: seed.model.context.organisationId, presentationMode: 'editable',
                initialAssessmentId: view === 'results' ? selectedId : 'assessment-a' });
        } });
    fixture.ready = true;
}
const loader = '(' + fixtureApplication.toString() + ')(' + JSON.stringify(seed) + ',' +
    JSON.stringify(fixtures.metadata) + ',' + JSON.stringify(fixtures) + ',' + createSyntheticTransport.toString() + ',' + JSON.stringify(selectedId) +
    ').catch(error => { console.error(error); });';
const documents = Object.fromEntries(Object.entries(styles).map(([variant, css]) => [variant,
    buildDashboardDocument({ template: read('app/dashboard.html'), loaderSource: loader,
        protectedAppSource: apps[variant], protectedStyleSource: css })]));
const errors = [], unexpected = [], results = [], requests = [];
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') || 'after';
    const document = documents[variant];
    requests.push({ method: request.method, path: url.pathname });
    let body, type;
    if (request.method === 'GET' && document) {
        if (url.pathname === '/dashboard') { body = document.html; type = 'text/html'; }
        else if (url.pathname === '/dashboard.css') { body = styles[variant]; type = 'text/css'; }
        else if (url.pathname === '/app.js') { body = apps[variant]; type = 'text/javascript'; }
        else if (url.pathname === '/large-text.css') { body = 'html { font-size: 125%; }'; type = 'text/css'; }
        else if (['/style.css', '/home.css', '/favicon.svg', '/images/nofrieslogo.png'].includes(url.pathname)) {
            body = fs.readFileSync(path.join(root, url.pathname.slice(1)));
            type = url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        }
    }
    if (body === undefined) { unexpected.push(request.method + ' ' + url.pathname); response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'Content-Security-Policy': document.contentSecurityPolicy }); response.end(body);
});

async function activate(page, locator) {
    await locator.focus(); await page.keyboard.press('Enter');
    assert.equal(await locator.evaluate(node => node === document.activeElement), true);
    assert.notEqual(await locator.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
}
async function prepare(page, view) {
    await page.waitForFunction(() => window.fixture?.ready === true);
    if (view === 'overview') {
        const filter = page.getByLabel('Filter follow-up by NCSC function', { exact: true }); await filter.waitFor();
        const score = await page.locator('.picture-metrics').textContent();
        await filter.focus(); await page.keyboard.press('ArrowDown');
        assert.equal(await filter.inputValue(), fixtures.metadata.domains[0].id);
        assert.equal(await page.locator('.picture-metrics').textContent(), score);
        await page.keyboard.press('Home'); assert.equal(await filter.inputValue(), '');
        assert.equal(await filter.evaluate(node => node === document.activeElement), true);
        assert.notEqual(await filter.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
        await activate(page, page.locator('.picture-follow-up > details > summary').first());
        await activate(page, page.locator('.picture-follow-up article details > summary').first());
    } else if (view === 'overview-draft') {
        await page.locator('.picture-empty').waitFor();
        assert.match(await page.locator('.picture-empty').textContent(), /Saved progress is not a score/);
        assert.equal(await page.locator('.picture-metrics').count(), 0);
    } else if (view === 'questionnaire') {
        const index = page.getByLabel('Question', { exact: true }); await index.waitFor();
        const initial = Number(await index.inputValue());
        await index.focus(); await page.keyboard.press('ArrowDown'); assert.equal(await index.inputValue(), String(initial + 1));
        await page.keyboard.press('Home'); assert.equal(await index.inputValue(), '0');
        assert.notEqual(await index.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
        await page.locator('.ncsc-option input').first().focus();
        assert.notEqual(await page.locator('.ncsc-option input').first().evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    } else if (view === 'results') {
        await page.locator('.ncsc-results').waitFor();
        await activate(page, page.locator('.ncsc-result-domain > summary').first());
        await activate(page, page.locator('.ncsc-result-control > summary').first());
    } else {
        await activate(page, page.locator('.dashboard-service-cards button').first());
        assert.equal(await page.locator('.dashboard-service-detail').first().isVisible(), true);
    }
}
async function observe(page) {
    return page.evaluate(() => {
        const root = document.querySelector('.nofries-dashboard');
        const visible = node => getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), styles = [];
        while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.textContent.trim() || !visible(parent)) continue;
            const range = document.createRange(); range.selectNode(node);
            if (!range.getClientRects().length) continue;
            const style = getComputedStyle(parent);
            styles.push({ fontSize: parseFloat(style.fontSize), weight: style.fontWeight, fontStyle: style.fontStyle });
        }
        const controls = [...root.querySelectorAll('button, select, summary, .ncsc-option, .dashboard-module-link')]
            .filter(visible).map(node => ({ label: node.textContent.slice(0, 100), height: node.getBoundingClientRect().height }));
        return { text: root.textContent,
            stableText: ['.picture-scope', '.picture-metrics', '.picture-domains', '.picture-follow-up',
                '.ncsc-questionnaire', '.dashboard-service-cards'].map(selector => root.querySelector(selector)?.textContent || null),
            selectorValues: [...root.querySelectorAll('.picture-toolbar option')].map(node => node.value),
            organisationContext: root.querySelector('.dashboard-topbar').textContent,
            sizes: [...new Set(styles.map(row => row.fontSize))].sort((a, b) => a - b),
            weights: [...new Set(styles.map(row => row.weight))].sort(), fontStyles: [...new Set(styles.map(row => row.fontStyle))],
            rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
            minSize: Math.min(...styles.map(row => row.fontSize)),
            bodyWeight: getComputedStyle(root).fontWeight, controls,
            scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth,
            chrome: ['.brand-copy strong', '.site-header .text-link', '#dashboardSignOut', '#dashboardChooser summary']
                .map(selector => ({ selector, size: getComputedStyle(document.querySelector(selector)).fontSize,
                    weight: getComputedStyle(document.querySelector(selector)).fontWeight })),
            unchangedRecords: JSON.stringify(fixture.records) === fixture.initialRecords,
            writes: fixture.writes, reads: fixture.reads, violations: window.violations };
    });
}

(async () => {
    let browser, failure = null;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const observations = new Map();
        const cases = [1440, 768, 390, 320].flatMap(width => ['overview', 'overview-draft', 'questionnaire', 'results', 'services']
            .map(view => ({ width, view })));
        cases.push({ width: 390, view: 'questionnaire', largeText: true },
            { width: 390, view: 'overview', largeText: true },
            { width: 390, view: 'questionnaire', forcedColors: 'active' });
        for (const variant of ['before', 'after'].filter(item => documents[item])) for (const scenario of cases) {
            const page = await browser.newPage({ viewport: { width: scenario.width, height: 950 },
                forcedColors: scenario.forcedColors || 'none' });
            page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') {
                    unexpected.push('Unexpected external request or mutation'); return route.abort();
                }
                return route.continue();
            });
            const key = scenario.view + '-' + scenario.width + (scenario.largeText ? '-text125' : '') +
                (scenario.forcedColors ? '-forced-colors' : '');
            await page.goto(origin + '/dashboard?variant=' + variant + '&view=' + scenario.view +
                (scenario.largeText ? '&largeText=1' : ''));
            await prepare(page, scenario.view);
            if (variant === 'after' && ['overview', 'overview-draft'].includes(scenario.view)) {
                assert.equal(await page.locator('.picture-heading h2').textContent(), 'Cyber baseline');
                assert.equal(await page.locator('.picture-heading .dashboard-eyebrow').count(), 0);
                const details = page.locator('.organisation-picture > .ncsc-result-provenance');
                const summary = details.locator(':scope > summary');
                assert.equal(await details.getAttribute('open'), null);
                await activate(page, summary); assert.equal(await details.getAttribute('open'), '');
                const record = scenario.view === 'overview-draft' ? seed.assessments[0] : seed.assessments.at(-1);
                for (const text of [record.assessmentId, record.updatedAt, fixtures.metadata.title,
                    fixtures.metadata.profileRef.profileVersion, seed.model.context.displayName]) {
                    assert.ok((await details.textContent()).includes(text));
                }
                if (scenario.width === 390) await details.screenshot({ path: path.join(artifacts, 'after-' + key + '-source-details.png') });
                await activate(page, summary); assert.equal(await details.getAttribute('open'), null);
                assert.equal((await page.locator('.picture-source').textContent()).includes(record.assessmentId), false);
                assert.equal((await page.locator('.picture-source').textContent()).includes(record.updatedAt), false);
            }
            const result = await observe(page);
            assert.equal(result.unchangedRecords, true); assert.equal(result.writes, 0);
            assert.deepEqual(result.violations, []);
            assert.ok(result.scrollWidth <= result.viewport + 1, key + ': no horizontal overflow');
            if (variant === 'after') {
                assert.deepEqual(result.weights, ['400', '600'], key + ': two restrained weights');
                for (const control of result.controls) assert.ok(control.height >= 44, key + ': usable target ' + control.label);
                assert.equal(result.bodyWeight, '400'); assert.deepEqual(result.fontStyles, ['normal']);
                const unit = result.rootFontSize;
                const display = Math.min(Math.max(1.5 * unit, scenario.width * .025), 2 * unit);
                for (const size of result.sizes) assert.ok([.875 * unit, unit, 1.25 * unit, display]
                    .some(expected => Math.abs(size - expected) < .02), key + ': consistent size ' + size);
                assert.ok(result.minSize >= .875 * unit);
                assert.deepEqual(result.chrome.map(row => row.weight), ['600', '400', '400', '400']);
                if (scenario.view === 'questionnaire') {
                    assert.deepEqual(await page.locator('.ncsc-option').first().evaluate(node => ({
                        label: getComputedStyle(node.querySelector('strong')).fontWeight,
                        description: getComputedStyle(node.querySelector('.dashboard-muted')).fontWeight
                    })), { label: '600', description: '400' });
                }
                if (observations.has(key)) {
                    const before = observations.get(key);
                    assert.deepEqual(result.stableText, before.stableText, key + ': unchanged scope, statuses, saved values and scores');
                    assert.deepEqual(result.selectorValues, before.selectorValues, key + ': unchanged exact selector values');
                    assert.equal(result.organisationContext, before.organisationContext, key + ': unchanged organisation bar');
                    assert.deepEqual(result.reads, before.reads, key + ': unchanged read calls');
                }
            } else observations.set(key, result);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, variant + '-' + key + '.png') });
            if (scenario.view === 'overview' && !scenario.largeText) {
                await page.locator('.picture-follow-up').screenshot({ path: path.join(artifacts, variant + '-' + key + '-follow-up.png') });
            }
            const { text, stableText, controls, ...receipt } = result;
            results.push({ variant, ...scenario, ...receipt, textSha256: hash(text), controlsChecked: controls.length });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), beforeHashes);
        console.log(JSON.stringify({ passed: true, syntheticOnly: true, cases: results.length, artifacts,
            weights: ['400', '600'], unexpectedRequests: 0, writes: 0, browser: browser.version() }));
    } catch (error) { failure = error.message; throw error; }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure,
            syntheticOnly: true, results, errors, unexpected, requests, sourceHashesBefore: beforeHashes,
            sourceHashesAfter: hashes(), baselineSourceHashes: baselineHashes,
            cssSha256: Object.fromEntries(Object.entries(styles).map(([variant, css]) => [variant, hash(css)])),
            appSha256: Object.fromEntries(Object.entries(apps).map(([variant, source]) => [variant, hash(source)])),
            browser: browser && browser.version() }, null, 2), { mode: 0o600 });
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
