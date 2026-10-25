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
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { fixture } = require('../../test/fixtures/dashboardFixture');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');

const root = path.resolve(__dirname, '../..');
const artifactDirectory = process.env.NOFRIES_ORGANISATION_ARTIFACTS;
if (artifactDirectory) fs.mkdirSync(artifactDirectory, { recursive: true });
const baseline = process.env.NOFRIES_NAV_BASELINE === '1';
const baselineFiles = new Set(['js/dashboard-loader.js', 'app/dashboard.html', 'home.css']);
const read = file => baseline && baselineFiles.has(file)
    ? execFileSync('git', ['show', '606880468721d076844cd642d03813f5d12ed8a8:' + file], { cwd: root })
    : fs.readFileSync(path.join(root, file));
const hash = value => createHash('sha256').update(value).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js',
    'ncscQuestionnaire.js', 'organisationPicture.js'];
const sourceFiles = ['js/dashboard-loader.js', 'app/dashboard.html', 'index.html', 'home.css', 'style.css',
    'app/dashboard.css', 'lib/dashboardDocument.js', 'lib/gatewayDocument.js', 'test/fixtures/dashboardFixture.js',
    'js/home.js', 'js/organisation-setup.js', 'js/prospect-assistant.js',
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
const gateway = buildGatewayDocument({ customerLogin: true, customerTransport: 'auto',
    template: read('index.html').toString(), loaderSource: read('js/dashboard-loader.js').toString(),
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
    '/favicon.ico': ['image/x-icon', read('favicon.ico')],
    '/apple-touch-icon.png': ['image/png', read('apple-touch-icon.png')],
    ...Object.fromEntries(['home.js', 'organisation-setup.js', 'prospect-assistant.js']
        .map(file => ['/js/' + file, ['text/javascript', read('js/' + file)]])),
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
    } else if (pathname === '/') {
        body = gateway.html; type = 'text/html'; res.setHeader('Content-Security-Policy', gateway.contentSecurityPolicy);
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
        controls: [...document.querySelectorAll('#dashboardChoices button, #clientSetupControls button, #clientSetupControls input, #dashboardOrganisationSearchControls input, #dashboardOrganisationSearchControls button, #dashboardAccountMenu > summary, #dashboardAccountActions button')]
            .filter(node => node.getClientRects().length).map(node => {
                const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, text: node.textContent };
            }) }));
    if (geometry.scrollWidth > geometry.viewport + 1) {
        const overflowing = await page.evaluate(() => [...document.querySelectorAll('body *')]
            .filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1)
            .map(node => ({ tag: node.tagName, id: node.id, className: node.className, right: node.getBoundingClientRect().right })));
        assert.fail(name + ': horizontal page overflow ' + JSON.stringify(overflowing));
    }
    for (const control of geometry.controls) assert.ok(control.left >= -1 && control.right <= geometry.viewport + 1,
        name + ': clipped control ' + control.text);
    return geometry;
}
async function checkHeaderTargets(page, name) {
    const targets = await page.locator('.site-header > a[data-dashboard-home]').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label') || node.textContent.trim(),
            left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }));
    assert.equal(targets.length, 2, name + ': both home links are present');
    for (const target of targets) {
        assert.ok(target.width >= 44 && target.height >= 44, name + ': home link touch target ' + JSON.stringify(target));
        assert.ok(target.left >= 0 && target.right <= page.viewportSize().width, name + ': home link fits viewport');
    }
    assert.ok(targets[0].right <= targets[1].left, name + ': home links do not overlap');
}
async function checkFormReadability(page, name) {
    const inputs = await page.locator('.consultant-client-form input:not([type="checkbox"])').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { name: node.name, font: parseFloat(getComputedStyle(node).fontSize),
            rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize), height: rect.height };
    }));
    assert.ok(inputs.length > 0, name + ': text fields are rendered');
    for (const input of inputs) {
        assert.ok(input.font >= input.rootFont && input.font >= 16, name + ': readable scaled input text ' + JSON.stringify(input));
        assert.ok(input.height >= 48, name + ': text field touch height');
    }
    await checkGeometry(page, name);
    if (await page.locator('body[data-page="operator-dashboard"]').count()) await checkHeaderTargets(page, name);
    if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, name + '.png'), fullPage: true });
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
        for (const width of [320, 375, 390, 768, 1024, 1440]) {
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
            await checkHeaderTargets(page, 'consultant-ready-' + width);
            await keyboardFocus(page, '.site-header > a[data-dashboard-home]:last-child');
            const back = page.locator('#consultantPortfolioControls');
            assert.equal(await back.count(), 1);
            assert.equal(await back.isVisible(), false, 'Account disclosure initially contains the Return action');
            await keyboardFocus(page, '#dashboardAccountMenu > summary'); await page.keyboard.press('Enter');
            assert.equal(await back.isVisible(), true, 'Keyboard opening Account exposes Return');
            assert.equal(await back.evaluate(node => node.parentElement.id), 'dashboardAccountActions');
            assert.equal(await page.locator('#dashboardSignOut').isVisible(), true);
            const accountGeometry = await page.locator('#dashboardAccountMenu').evaluate(menu => {
                const nodes = [menu.querySelector('summary'), ...menu.querySelectorAll('button:not([hidden])')];
                return nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
            });
            for (const rect of accountGeometry) assert.ok(rect.height >= 44, 'Account action has a usable touch target');
            const ordered = accountGeometry.slice().sort((a, b) => a.top - b.top);
            for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i].top >= ordered[i - 1].bottom - 1, 'Account controls do not overlap');
            assert.equal(await page.locator('#dashboardChooser').evaluate(node => node.open), false);
            assert.equal(await page.locator('#dashboardHeading').textContent(), 'Viewing Synthetic consultancy');
            await keyboardFocus(page, '#consultantPortfolioControls');
            await checkGeometry(page, 'consultant-selected-' + width);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
            await page.getByRole('button', { name: 'Continue setup: Synthetic pending client' }).waitFor();
            assert.equal(await page.locator('#dashboardChoices > .consultant-organisation-ready').count(), 2);
            assert.deepEqual(await page.locator('#dashboardChoices > .consultant-organisation-ready').evaluateAll(rows =>
                rows.map(row => ({ label: row.getAttribute('aria-label'), badge: getComputedStyle(row, '::after').content }))), [
                { label: 'Synthetic consultancy · Open to check access', badge: '"Open to check access"' },
                { label: 'Synthetic client · Open to check access', badge: '"Open to check access"' }
            ]);
            assert.equal(await page.locator('#dashboardOrganisationStatus option[value="ready"]').textContent(), 'Setup complete');
            assert.equal(await page.locator('#dashboardChoices > .client-workspace-row').count(), 1);
            assert.equal(await page.locator('#dashboardChoices').textContent().then(text => text.match(/Synthetic client/g)?.length), 1,
                'ready saved setup must not duplicate directory binding');
            assert.equal(await page.locator('#clientSetupControls button').filter({ hasText: 'Add organisation' }).count(), 1);
            await keyboardFocus(page, '#clientSetupControls button');
            await checkGeometry(page, 'consultant-list-' + width);
            const search = page.getByRole('searchbox', { name: 'Find an organisation' });
            const visibleRows = page.locator('#dashboardChoices > :visible');
            await keyboardFocus(page, '#dashboardOrganisationSearch');
            if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, 'organisations-' + width + '.png'), fullPage: true });
            await page.waitForLoadState('networkidle');
            const beforeSearch = requests.length;
            await search.fill('  CLIENT  ');
            assert.equal(await visibleRows.count(), 2, 'search includes ready and unfinished organisations');
            assert.equal(await page.locator('#dashboardOrganisationCount').textContent(), '2 of 3 loaded organisations shown');
            assert.equal(await search.evaluate(node => node === document.activeElement), true, 'typing retains focus');
            await search.fill('No matching organisation');
            assert.equal(await visibleRows.count(), 0);
            assert.equal(await page.locator('#dashboardOrganisationEmpty').isVisible(), true);
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('#dashboardOrganisationClear').evaluate(node => node === document.activeElement), true);
            await page.keyboard.press('Enter');
            assert.equal(await search.inputValue(), '');
            assert.equal(await search.evaluate(node => node === document.activeElement), true, 'clear returns focus to search');
            assert.equal(await visibleRows.count(), 3);
            assert.equal(await page.locator('#dashboardOrganisationEmpty').isVisible(), false);
            assert.deepEqual(requests.slice(beforeSearch), [], 'search and clear issue no network requests');
            await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
            if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, 'organisations-' + width + '-text-200.png'), fullPage: true });
            await checkGeometry(page, 'consultant-enlarged-text-' + width);
            await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
            await search.fill('pending');
            assert.equal(await visibleRows.count(), 1);
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
            await checkFormReadability(page, 'consultant-add-' + width);
            await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
            await checkFormReadability(page, 'consultant-add-' + width + '-text-200');
            await keyboardFocus(page, '.consultant-client-form input[name="organisationName"]');
            await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
            await page.goto('about:blank'); await page.goto(origin + '/dashboard#organisations');
            await search.fill('Synthetic client');
            assert.equal(await page.locator('#dashboardChoices > .consultant-organisation-ready:visible').count(), 1);
            await page.locator('#dashboardChoices > .consultant-organisation-ready').nth(1).click();
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(await page.locator('#dashboardHeading').textContent(), 'Viewing Synthetic client');
            assert.equal(await back.isVisible(), false);
            await keyboardFocus(page, '#dashboardAccountMenu > summary'); await page.keyboard.press('Enter');
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
            assert.equal(await company.locator('#dashboardOrganisationSearchControls').isVisible(), false);
            await checkGeometry(company, 'company-selected-' + width);
            await company.close();

            mode = 'consultant'; selected = A; generation = 'a'.repeat(64);
            const gatewayPage = await browser.newPage({ viewport: { width, height: 900 } });
            gatewayPage.on('pageerror', error => errors.push(error.message));
            await gatewayPage.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== origin || request.method() !== 'GET') {
                    blocked.push({ method: request.method(), reason: 'unexpected gateway request' }); return route.abort();
                }
                return route.continue();
            });
            await gatewayPage.goto(origin + '/#organisations');
            await gatewayPage.getByRole('button', { name: 'Add organisation', exact: true }).click();
            await checkFormReadability(gatewayPage, 'gateway-add-' + width);
            await gatewayPage.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
            await checkFormReadability(gatewayPage, 'gateway-add-' + width + '-text-200');
            await keyboardFocus(gatewayPage, '.consultant-client-form input[name="organisationName"]');
            await gatewayPage.close();
            results.push({ width, consultant: 'selected, return, name search, no-match/clear, filtered resume/error, add, exact client selection',
                textScaling: '100% and 200%', company: 'own only', gateway: 'Add form at 100% and 200%' });
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
