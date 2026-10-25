'use strict';

// Optional rendered regression check. Uses an already installed Playwright and
// Chromium; no dependency installation, external service, account or Azure I/O.
// node scripts/tests/account-presentation-browser.cjs
// CHROMIUM_EXECUTABLE_PATH and NOFRIES_PRESENTATION_ARTIFACTS may be supplied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildSignupDocument, buildSignupUnavailableDocument } = require('../../lib/signupDocument');
const { createNcscQuestionnaireMetadata } = require('../../api/shared/ncscQuestionnaireMetadata');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');
const { fixture } = require('../../test/fixtures/dashboardFixture');

const root = path.resolve(__dirname, '../..');
const artifacts = process.env.NOFRIES_PRESENTATION_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-presentation-'));
fs.mkdirSync(artifacts, { recursive: true });
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bundle = buildSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js') });
const metadata = createNcscQuestionnaireMetadata();
const model = projectDashboard(fixture());
const assets = { '/style.css': 'style.css', '/home.css': 'home.css', '/dashboard.css': 'app/dashboard.css',
    '/registry.js': 'api/shared/protectedAssets/dashboardRegistry.js',
    '/dashboard.js': 'api/shared/protectedAssets/dashboardShell.js',
    '/questionnaire.js': 'api/shared/protectedAssets/ncscQuestionnaire.js',
    '/favicon.svg': 'favicon.svg', '/images/nofrieslogo.png': 'images/nofrieslogo.png' };
let signupState = 'terms', holdBootstrap = false, releaseBootstrap;
const requests = [], results = [], pageErrors = [], cspErrors = [];
function fixtureHtml(mode, dashboard) {
    const assessment = { assessmentId: 'synthetic-assessment', moduleId: metadata.moduleId, profileRef: metadata.profileRef,
        status: 'draft', revision: 0, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
        scopePopulation: { description: 'Synthetic office and cloud services.' },
        progress: { answered: 0, missing: metadata.questions.length, total: metadata.questions.length, unknown: 0, notApplicableClaims: 0 },
        responses: mode === 'readonly' ? [{ itemId: metadata.questions[0].id, optionId: 'not_applicable',
            rationale: { text: 'Synthetic retained rationale.' } }] : [] };
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Synthetic presentation acceptance</title><link rel="stylesheet" href="/dashboard.css">
        <body class="nofries-dashboard"><div id="fixture" class="dashboard-main"></div>
        <script src="/registry.js"></script><script src="/dashboard.js"></script><script src="/questionnaire.js"></script>
        <script>
        const metadata = ${JSON.stringify(metadata)}, assessment = ${JSON.stringify(assessment)};
        const forbidden = () => { throw new Error('Unexpected synthetic mutation'); };
        const client = { list: async () => ({ assessments: ${mode === 'scope' ? '[]' : '[assessment]'}, nextAfterAssessmentId: null }),
            read: async () => ({ assessment }), create: forbidden, save: forbidden, submit: forbidden,
            normaliseCommand: value => value, commandByteLength: value => JSON.stringify(value).length };
        ${dashboard ? `NoFriesDashboard.mount(document.getElementById('fixture'), ${JSON.stringify(model)});` :
        `NoFriesNcscQuestionnaire.mount(document.getElementById('fixture'), { metadata, client,
            organisationId: 'synthetic-workshop', presentationMode: '${mode === 'readonly' ? 'read_only' : 'editable'}' });`}
        </script></body></html>`;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (assets[url.pathname]) {
        res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(fs.readFileSync(path.join(root, assets[url.pathname])));
    }
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/signup') {
        res.setHeader('Content-Security-Policy', bundle.contentSecurityPolicy);
        res.setHeader('Content-Type', 'text/html'); return res.end(bundle.html);
    }
    if (url.pathname === '/unavailable') {
        res.setHeader('Content-Type', 'text/html'); return res.end(buildSignupUnavailableDocument());
    }
    if (url.pathname === '/assessment' || url.pathname === '/dashboard') {
        res.setHeader('Content-Type', 'text/html'); return res.end(fixtureHtml(url.searchParams.get('mode'), url.pathname === '/dashboard'));
    }
    requests.push({ path: url.pathname, method: req.method });
    if (url.pathname === '/api/customer-signup/bootstrap') {
        let body = ''; for await (const chunk of req) body += chunk;
        assert.equal(req.method, 'POST'); assert.deepEqual(JSON.parse(body), { invitationToken: 'x'.repeat(43) });
        if (holdBootstrap) await new Promise(resolve => { releaseBootstrap = resolve; });
        res.statusCode = 204; return res.end();
    }
    if (url.pathname === '/api/customer-signup/state') {
        assert.equal(req.method, 'GET'); res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ state: signupState === 'terms' ? { status: 'terms',
            termsText: 'Synthetic agreement for presentation checks only.\nNo customer consent is submitted.',
            termsVersion: 'synthetic-v1', termsDigest: 'a'.repeat(64) } : { status: signupState }, csrfToken: 'c'.repeat(43) }));
    }
    res.statusCode = 404; res.end();
});

function contrast(a, b) {
    const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }).reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function boundary(page, selector, name) {
    const styles = await page.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el); return { border: s.borderTopColor, background: s.backgroundColor, outline: s.outlineColor,
            outlineStyle: s.outlineStyle, readOnly: el.readOnly, disabled: el.disabled };
    });
    const ratio = contrast(styles.border, styles.background);
    assert.ok(ratio >= 3, `${name} boundary contrast ${ratio.toFixed(2)} must be >=3`);
    results.push({ name, contrast: ratio, ...styles }); return styles;
}
async function overflow(page, name) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
}
async function screenshot(page, name) { await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true }); }
async function focusSkip(page) {
    // Journey rendering focuses its heading. Traverse backwards with a real
    // keyboard from that position (or from the document during bootstrap).
    for (let i = 0; i < 12; i++) {
        if (await page.locator('#signup-skip').evaluate(el => el === document.activeElement)) return;
        await page.keyboard.press('Shift+Tab');
    }
    assert.fail('Skip link was not keyboard reachable');
}
async function foreground(page, selector, name) {
    const s = await page.locator(selector).first().evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
    const ratio = contrast(s.color, 'rgb(255,255,255)');
    assert.ok(ratio >= 4.5, `${name} on paper contrast ${ratio.toFixed(2)} must be >=4.5`);
    results.push({ name, contrast: ratio, ...s });
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true });
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', event => { if (/Content Security Policy|Refused to/i.test(event.text())) cspErrors.push(event.text()); });
        await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            signupState = 'terms'; await page.goto(base + '/signup');
            await page.getByRole('checkbox').waitFor();
            assert.equal(await page.getByRole('checkbox').isChecked(), false);
            await overflow(page, `signup-${width}`);
            await focusSkip(page);
            assert.equal(await page.locator('#signup-skip').evaluate(el => el === document.activeElement), true);
            await screenshot(page, `signup-keyboard-${width}`);
            await page.keyboard.press('Enter');
            assert.equal(page.url(), base + '/signup');
            assert.equal(await page.locator('#signup').evaluate(el => el === document.activeElement), true);
            await page.reload(); await page.getByRole('checkbox').waitFor();
            assert.equal(await page.getByRole('checkbox').isChecked(), false);
            await screenshot(page, `signup-${width}`);

            await page.goto(base + '/dashboard'); await page.locator('.dashboard-attention-item').first().waitFor();
            await overflow(page, `dashboard-${width}`); await screenshot(page, `dashboard-${width}`);
            await page.goto(base + '/assessment?mode=scope');
            await page.getByRole('button', { name: 'Start an assessment', exact: true }).click();
            assert.equal(await page.locator('#ncsc-scope').inputValue(), '');
            await boundary(page, '#ncsc-scope', `empty-scope-${width}`);
            await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
            const focused = await boundary(page, '#ncsc-scope', `focused-scope-${width}`);
            assert.equal(focused.outlineStyle, 'solid'); assert.ok(contrast(focused.outline, focused.background) >= 3);
            await screenshot(page, `scope-focus-${width}`);
            await page.getByRole('button', { name: 'Create assessment', exact: true }).click();
            await boundary(page, '#ncsc-scope[aria-invalid="true"]', `invalid-scope-${width}`);
            await overflow(page, `scope-${width}`);

            await page.goto(base + '/assessment');
            await page.locator('.ncsc-assessment-list button').click();
            await boundary(page, 'select', `question-select-${width}`);
            await page.locator('input[value="not_applicable"]').check();
            assert.equal(await page.locator('textarea').inputValue(), '');
            await boundary(page, 'textarea', `empty-rationale-${width}`);
            await page.getByRole('button', { name: 'Save progress', exact: true }).click();
            await boundary(page, 'textarea[aria-invalid="true"]', `invalid-rationale-${width}`);
            await overflow(page, `rationale-${width}`); await screenshot(page, `rationale-errors-${width}`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ media: 'print' });
        await foreground(page, '.ncsc-inline-error', 'print-inline-error');
        await boundary(page, 'select', 'print-select');
        for (const backgrounds of [true, false]) await page.pdf({ path: path.join(artifacts, `assessment-print-${backgrounds}.pdf`), printBackground: backgrounds, format: 'A4' });
        await screenshot(page, 'assessment-print');
        await page.goto(base + '/dashboard');
        await foreground(page, '.dashboard-attention-item .dashboard-badge', 'print-attention-badge');
        assert.equal(await page.locator('.dashboard-attention-item .dashboard-badge').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
        for (const backgrounds of [true, false]) await page.pdf({ path: path.join(artifacts, `dashboard-print-${backgrounds}.pdf`), printBackground: backgrounds, format: 'A4' });
        await screenshot(page, 'dashboard-print');
        await page.goto(base + '/dashboard#cyber-security');
        const selected = await page.locator('.dashboard-group-links [aria-current="page"]').evaluate(el => ({
            color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor
        }));
        const selectedContrast = contrast(selected.color, selected.background);
        assert.ok(selectedContrast >= 4.5, `Printed selected module contrast ${selectedContrast.toFixed(2)} must be >=4.5`);
        results.push({ name: 'print-selected-module', contrast: selectedContrast, ...selected });
        await screenshot(page, 'selected-module-print'); await page.emulateMedia({ media: 'screen' });

        await page.goto(base + '/assessment?mode=readonly'); await page.locator('.ncsc-assessment-list button').click();
        assert.equal((await boundary(page, 'textarea', 'readonly-rationale')).readOnly, true);
        assert.equal(await page.locator('input[type="radio"]:disabled').count(), metadata.responseOptions.length);
        // Explicit disabled select styling probe; read-only question navigation remains enabled in the real renderer.
        await page.locator('select').evaluate(el => { el.disabled = true; });
        assert.equal((await boundary(page, 'select', 'disabled-select-probe')).disabled, true);
        await screenshot(page, 'assessment-readonly');

        holdBootstrap = true; signupState = 'pending_admission';
        await page.goto(base + '/signup#invitation=' + 'x'.repeat(43));
        await page.getByText('Opening your account', { exact: true }).waitFor();
        await focusSkip(page); await page.keyboard.press('Enter');
        assert.equal(page.url(), base + '/signup');
        assert.equal(await page.locator('#signup').evaluate(el => el === document.activeElement), true);
        holdBootstrap = false; releaseBootstrap();
        await page.getByRole('heading', { name: 'Account setup received' }).waitFor();
        const count = requests.filter(r => r.path.endsWith('/bootstrap')).length;
        await page.reload(); await page.getByRole('heading', { name: 'Account setup received' }).waitFor();
        assert.equal(requests.filter(r => r.path.endsWith('/bootstrap')).length, count);
        for (const fragment of ['#signup', '#invitation=short', '#invitation=' + 'x'.repeat(43) + '&extra=1']) {
            await page.goto(base + '/unavailable');
            const before = requests.length;
            await page.goto(base + '/signup' + fragment); await page.getByRole('heading', { name: 'Signup is unavailable' }).waitFor();
            assert.equal(page.url(), base + '/signup'); assert.equal(requests.length, before);
            assert.equal(await page.locator('h1').evaluate(el => el === document.activeElement), true);
        }
        await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'signup-invalid');
        await page.goto(base + '/unavailable'); await overflow(page, 'unavailable-mobile'); await screenshot(page, 'signup-unavailable');
        assert.deepEqual(pageErrors, []); assert.deepEqual(cspErrors, []);
        const evidence = { browser: browser.version(), widths: [1440, 390, 320], results, requests, pageErrors, cspErrors,
            signup: 'Keyboard skip, invitation interruption, refresh and strict malformed-fragment rejection passed',
            scope: 'Synthetic loopback rendering only; no real sign-in, consent, admission or deployment' };
        fs.writeFileSync(path.join(artifacts, 'browser-results.json'), JSON.stringify(evidence, null, 2) + '\n');
        console.log(JSON.stringify({ passed: true, checks: results.length, artifacts }));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { releaseBootstrap?.(); server.closeAllConnections(); server.close(); });
