'use strict';

// Source-bound synthetic Chromium acceptance. Only this process's loopback
// server handles selection and saved-setup resume; no provider or durable write.
// Run: node scripts/tests/consultant-organisation-navigation-browser.cjs
// NOFRIES_NAV_BASELINE=1 reads the retained pre-change source as a RED control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { fixture } = require('../../test/fixtures/dashboardFixture');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');

const root = path.resolve(__dirname, '../..');
const baseline = process.env.NOFRIES_NAV_BASELINE === '1';
const baselineFiles = new Set(['js/dashboard-loader.js', 'app/dashboard.html', 'home.css']);
const read = file => baseline && baselineFiles.has(file)
    ? execFileSync('git', ['show', '606880468721d076844cd642d03813f5d12ed8a8:' + file], { cwd: root })
    : fs.readFileSync(path.join(root, file));
const hash = value => createHash('sha256').update(value).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js',
    'ncscQuestionnaire.js', 'organisationPicture.js'];
const sourceFiles = ['js/dashboard-loader.js', 'app/dashboard.html', 'index.html', 'home.css', 'style.css',
    'app/dashboard.css', 'lib/dashboardDocument.js', 'test/fixtures/dashboardFixture.js',
    'api/shared/appLifecycle/dashboardProjection.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file),
    'scripts/tests/consultant-organisation-navigation-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(read(file))]));
const before = hashes();
const app = bundleFiles.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n');
const css = read('app/dashboard.css').toString();
const document = buildDashboardDocument({ customerLogin: true, customerTransport: 'auto',
    template: read('app/dashboard.html').toString(), loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app, protectedStyleSource: css });
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const D = '10000000-0000-4000-8000-000000000004';
const csrfToken = 'c'.repeat(43);
const bindings = [{ bindingId: A, organisationLabel: 'Synthetic consultancy' },
    { bindingId: B, organisationLabel: 'Synthetic client' }];
const models = Object.fromEntries([[A, 'Synthetic consultancy'], [B, 'Synthetic client']]
    .map(([bindingId, name]) => [bindingId, projectDashboard(fixture({ now: new Date().toISOString(), name }))]));
const staticAssets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')],
    '/images/nofrieslogo.png': ['image/png', read('images/nofrieslogo.png')] };
const requests = [], blocked = [], errors = [], results = [];
let mode = 'consultant', selected = A, generation = 'a'.repeat(64), resumeAttempts = 0;
const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, pathname });
    res.setHeader('Cache-Control', 'no-store');
    let body, type = 'application/json', status = 200;
    if (req.method === 'POST' && pathname === '/api/customer-signup/clients') {
        let input = ''; for await (const chunk of req) input += chunk;
        if (mode !== 'consultant' || input !== JSON.stringify({ action: 'resume', requestId: D })) {
            blocked.push({ method: req.method, pathname, reason: 'unexpected setup command' }); status = 405;
        } else {
            resumeAttempts += 1;
            if (resumeAttempts === 1) { status = 503; body = { code: 'synthetic_unavailable' }; }
            else body = { csrfToken, state: { status: 'resume_acceptance' } };
        }
    } else if (req.method === 'POST' && pathname === '/api/dashboard/selection') {
        let input = ''; for await (const chunk of req) input += chunk;
        let command; try { command = JSON.parse(input); } catch (_) { command = {}; }
        if (mode !== 'consultant' || command.bindingId !== B || command.expectedGeneration !== generation ||
            !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(command.operationId || '')) {
            blocked.push({ method: req.method, pathname, reason: 'unexpected selection command' }); status = 405;
        } else {
            selected = B; generation = 'b'.repeat(64);
            body = { schemaVersion: 1, generation, selectedBindingId: selected };
        }
    } else if (req.method !== 'GET') {
        blocked.push({ method: req.method, pathname, reason: 'unexpected method' }); status = 405;
    } else if (pathname === '/dashboard') {
        body = document.html; type = 'text/html'; res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
    else if (pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
    else if (pathname === '/api/dashboard/session') {
        body = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: mode,
            ...(mode === 'consultant' ? { clientSetupAvailable: true } : {}), generation, selectedBindingId: selected,
            expiresAt: new Date(Date.now() + 3600000).toISOString() };
    } else if (pathname === '/api/dashboard/organisations') {
        body = { schemaVersion: 1, bindings: mode === 'company' ? bindings.slice(0, 1) : bindings, nextAfterBindingId: null };
    } else if (pathname === '/api/dashboard/bootstrap') body = models[selected];
    else if (pathname === '/api/customer-signup/clients' && mode === 'consultant') {
        body = { csrfToken, state: { status: 'clients', remaining: 1, clients: [
            { requestId: C, organisationName: 'Synthetic client', status: 'ready' },
            { requestId: D, organisationName: 'Synthetic pending client', status: 'pending' }] } };
    } else if (staticAssets[pathname]) [type, body] = staticAssets[pathname];
    else { blocked.push({ method: req.method, pathname, reason: 'unknown path' }); status = 404; }
    res.statusCode = status; res.setHeader('Content-Type', type);
    res.end(type === 'application/json' ? JSON.stringify(body || { code: 'synthetic_denied' }) : body);
});

async function checkGeometry(page, name) {
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('#dashboardChoices button, #clientSetupControls button, #consultantPortfolioControls')]
            .filter(node => node.getClientRects().length).map(node => {
                const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, text: node.textContent };
            }) }));
    assert.ok(geometry.scrollWidth <= geometry.viewport + 1, name + ': horizontal page overflow');
    for (const control of geometry.controls) assert.ok(control.left >= -1 && control.right <= geometry.viewport + 1,
        name + ': clipped control ' + control.text);
    return geometry;
}
async function keyboardFocus(page, selector) {
    await page.locator(selector).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const focus = await page.locator(selector).evaluate(node => ({ active: node === document.activeElement,
        style: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }));
    assert.ok(focus.active && focus.style === 'solid' && focus.width >= 2, selector + ': keyboard focus must be visible');
}

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            mode = 'consultant'; selected = A; generation = 'a'.repeat(64); resumeAttempts = 0;
            const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin) {
                    blocked.push({ method: route.request().method(), reason: 'external request' }); return route.abort();
                }
                return route.continue();
            });
            await page.goto(origin + '/dashboard#overview');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            const back = page.locator('#consultantPortfolioControls');
            assert.equal(await back.count(), 1);
            assert.equal(await back.isVisible(), true, 'Return remains visible outside collapsed chooser');
            assert.equal(await back.evaluate(node => node.parentElement.id), 'dashboardStatusPanel');
            assert.equal(await page.locator('#dashboardChooser').evaluate(node => node.open), false);
            assert.equal(await page.locator('#dashboardHeading').textContent(), 'Viewing Synthetic consultancy');
            await keyboardFocus(page, '#consultantPortfolioControls');
            await checkGeometry(page, 'consultant-selected-' + width);
            await back.click();
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
            await page.getByRole('button', { name: 'Continue setup: Synthetic pending client' }).waitFor();
            assert.equal(await page.locator('#dashboardChoices > .consultant-organisation-ready').count(), 2);
            assert.equal(await page.locator('#dashboardChoices > .client-workspace-row').count(), 1);
            assert.equal(await page.locator('#dashboardChoices').textContent().then(text => text.match(/Synthetic client/g)?.length), 1,
                'ready saved setup must not duplicate directory binding');
            assert.equal(await page.locator('#clientSetupControls button').filter({ hasText: 'Add organisation' }).count(), 1);
            await keyboardFocus(page, '#clientSetupControls button');
            await checkGeometry(page, 'consultant-list-' + width);
            await page.getByRole('button', { name: 'Continue setup: Synthetic pending client' }).click();
            await page.getByRole('button', { name: 'Check and resume saved setup' }).waitFor();
            assert.equal(await page.locator('#dashboardChoices .client-workspace-row button').count(), 0,
                'uncertain setup leaves only same-client recovery action');
            await page.getByRole('button', { name: 'Check and resume saved setup' }).click();
            await page.getByRole('button', { name: 'Complete client setup' }).waitFor();
            assert.equal(resumeAttempts, 2);
            await page.goto('about:blank'); await page.goto(origin + '/dashboard#organisations');
            await page.getByRole('button', { name: 'Add organisation', exact: true }).waitFor();
            await page.getByRole('button', { name: 'Add organisation', exact: true }).click();
            assert.equal(await page.locator('#clientSetupControls form input[name="organisationName"]').evaluate(node => node === document.activeElement), true);
            await checkGeometry(page, 'consultant-add-' + width);
            await page.goto('about:blank'); await page.goto(origin + '/dashboard#organisations');
            await page.locator('#dashboardChoices > .consultant-organisation-ready').nth(1).click();
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(await page.locator('#dashboardHeading').textContent(), 'Viewing Synthetic client');
            assert.equal(await back.isVisible(), true);
            await checkGeometry(page, 'consultant-client-' + width);
            await page.close();

            mode = 'company'; selected = A; generation = 'a'.repeat(64);
            const company = await browser.newPage({ viewport: { width, height: 900 } }); company.setDefaultTimeout(10000);
            company.on('pageerror', error => errors.push(error.message));
            await company.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin) {
                    blocked.push({ method: route.request().method(), reason: 'external request' }); return route.abort();
                }
                return route.continue();
            });
            await company.goto(origin + '/dashboard#overview');
            await company.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(await company.locator('#dashboardChoices > button').count(), 1, 'Company has its own binding only');
            assert.equal(await company.locator('#clientSetupControls').count(), 0);
            assert.equal(await company.locator('#consultantPortfolioControls').count(), 0);
            await checkGeometry(company, 'company-selected-' + width);
            await company.close();
            results.push({ width, consultant: 'selected, return, one list, resume/error, add, client selected', company: 'own only' });
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ status: 'passed', baseline, results, sourceHash: before['js/dashboard-loader.js'] }));
    } catch (error) {
        console.error(JSON.stringify({ status: 'failed', baseline, message: error.message, blocked, errors,
            recentRequests: requests.slice(-15) }));
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})();
