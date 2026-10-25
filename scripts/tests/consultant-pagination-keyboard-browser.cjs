'use strict';

// Synthetic loopback acceptance using the real document, CSP, loader and existing
// dashboard fixture. Native keys cross page boundaries without refocusing More.
// Run: node scripts/tests/consultant-pagination-keyboard-browser.cjs
// NOFRIES_PAGING_BASELINE=1 substitutes the unchanged main loader as a RED control.
// NOFRIES_PAGING_VIEW_BASELINE_SOURCE points to the saved pre-route-fix loader.
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
const baseline = process.env.NOFRIES_PAGING_BASELINE === '1';
const viewBaseline = process.env.NOFRIES_PAGING_VIEW_BASELINE_SOURCE;
assert.ok(!baseline || !viewBaseline, 'choose only one causal baseline');
const read = file => viewBaseline && file === 'js/dashboard-loader.js' ? fs.readFileSync(viewBaseline)
    : baseline && file === 'js/dashboard-loader.js'
    ? execFileSync('git', ['show', 'da865a8c2ad1346cccfd21af743aed0adc421426:' + file], { cwd: root })
    : fs.readFileSync(path.join(root, file));
const hash = data => createHash('sha256').update(data).digest('hex');
const bundleFiles = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js',
    'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js'];
const sourceFiles = ['js/dashboard-loader.js', 'app/dashboard.html', 'app/dashboard.css', 'style.css', 'home.css',
    'lib/dashboardDocument.js', 'test/fixtures/dashboardFixture.js', 'api/shared/appLifecycle/dashboardProjection.js',
    ...bundleFiles.map(file => 'api/shared/protectedAssets/' + file),
    'scripts/tests/consultant-pagination-keyboard-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(read(file))]));
const before = hashes();
const app = bundleFiles.map(file => read('api/shared/protectedAssets/' + file).toString()).join('\n');
const css = read('app/dashboard.css');
const dashboard = buildDashboardDocument({ customerLogin: true, customerTransport: 'auto',
    template: read('app/dashboard.html').toString(), loaderSource: read('js/dashboard-loader.js').toString(),
    protectedAppSource: app, protectedStyleSource: css.toString() });
const bindingId = n => '10000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const bindings = Array.from({ length: 105 }, (_, i) => ({ bindingId: bindingId(i + 1),
    organisationLabel: 'Synthetic portfolio organisation ' + (i + 1) }));
const staticAssets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
    '/favicon.svg': ['image/svg+xml', read('favicon.svg')],
    '/images/nofrieslogo.png': ['image/png', read('images/nofrieslogo.png')] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let selected = bindings[0].bindingId, generation = 'a'.repeat(64), fault = null, gate = null;
let accountType = 'consultant', setupAvailable = false;
const requests = [], errors = [], blocked = [], results = [];
function reset(options) {
    selected = bindings[0].bindingId; generation = 'a'.repeat(64); fault = null; gate = null;
    accountType = options.accountType || 'consultant'; setupAvailable = options.setupAvailable === true;
}
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: url.pathname, query: url.search });
        let status = 200, body, type = 'application/json';
        if (req.method === 'POST' && url.pathname === '/api/dashboard/selection') {
            assert.equal(accountType, 'consultant', 'Company fixture has no cross-organisation selection');
            let input = ''; for await (const chunk of req) input += chunk;
            const command = JSON.parse(input);
            assert.ok(bindings.some(row => row.bindingId === command.bindingId));
            assert.equal(command.expectedGeneration, generation);
            assert.match(command.operationId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
            selected = command.bindingId; generation = 'b'.repeat(64);
            body = { schemaVersion: 1, generation, selectedBindingId: selected };
        } else {
            assert.equal(req.method, 'GET', 'only explicit synthetic selection may write');
            if (url.pathname === '/dashboard') {
                body = dashboard.html; type = 'text/html';
                res.setHeader('Content-Security-Policy', dashboard.contentSecurityPolicy);
            } else if (url.pathname === '/api/dashboard/session') {
                body = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType,
                    ...(setupAvailable ? { clientSetupAvailable: true } : {}),
                    generation, selectedBindingId: selected, expiresAt: new Date(Date.now() + 3600000).toISOString() };
            } else if (url.pathname === '/api/dashboard/organisations') {
                assert.equal(url.searchParams.get('limit'), '50');
                const after = url.searchParams.get('afterBindingId');
                const start = after ? bindings.findIndex(row => row.bindingId === after) + 1 : 0;
                assert.ok(!after || start > 0);
                if (after && gate) { const pending = gate; pending.seen.resolve(); await pending.release.promise; }
                if (after && fault === 'denied') { status = 403; body = { code: 'synthetic_denied' }; }
                else {
                    const available = accountType === 'company' ? bindings.slice(0, 1) : bindings;
                    const rows = after && fault === 'empty' ? [] : available.slice(start, start + 50);
                    body = { schemaVersion: 1, bindings: rows,
                        nextAfterBindingId: rows.length && start + rows.length < available.length ? rows.at(-1).bindingId : null };
                }
            } else if (url.pathname === '/api/customer-signup/clients') {
                assert.ok(accountType === 'consultant' && setupAvailable);
                body = { csrfToken: 'c'.repeat(43), state: { status: 'clients', remaining: 1, clients: [] } };
            } else if (url.pathname === '/api/dashboard/bootstrap') {
                const row = bindings.find(item => item.bindingId === selected);
                body = projectDashboard(fixture({ now: new Date().toISOString(), name: row.organisationLabel }));
            } else if (url.pathname === '/api/dashboard/app.js') { type = 'text/javascript'; body = app; }
            else if (url.pathname === '/api/dashboard/dashboard.css') { type = 'text/css'; body = css; }
            else if (staticAssets[url.pathname]) [type, body] = staticAssets[url.pathname];
            else throw new Error('unexpected path ' + url.pathname);
        }
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
    } catch (error) {
        errors.push(error.message); res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'synthetic_fixture_failure' }));
    }
});
const rows = page => page.locator('#dashboardChoices > .consultant-organisation-ready');
const active = page => page.evaluate(() => ({ id: document.activeElement.id,
    tag: document.activeElement.tagName, bindingId: document.activeElement.getAttribute('data-binding-id') }));
async function checkRow(page, index) {
    assert.equal((await active(page)).bindingId, bindings[index].bindingId, 'focus must continue at organisation ' + (index + 1));
    // The existing global smooth-scroll rule animates focus scrolling. Observe
    // its settled geometry without changing motion preferences or scrolling it.
    await page.waitForFunction(rowIndex => {
        const node = document.querySelectorAll('#dashboardChoices > .consultant-organisation-ready')[rowIndex];
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.top >= -1 && rect.bottom <= innerHeight + 1;
    }, index);
    const geometry = await rows(page).nth(index).evaluate(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
            outline: style.outlineStyle, width: parseFloat(style.outlineWidth), viewport: innerWidth, height: innerHeight };
    });
    assert.ok(geometry.top >= -1 && geometry.bottom <= geometry.height + 1, 'focused row must be in view');
    assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, 'focused row must not clip');
    assert.ok(geometry.outline === 'solid' && geometry.width >= 2, 'native keyboard focus must remain visible');
}
async function reachMore(page, from, end) {
    await checkRow(page, from);
    for (let index = from + 1; index < end; index++) {
        await page.keyboard.press('Tab');
        assert.equal((await active(page)).bindingId, bindings[index].bindingId);
    }
    await page.keyboard.press('Tab'); assert.equal((await active(page)).id, 'dashboardMore');
}
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        async function open(width, options = {}) {
            reset(options); const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin === origin) return route.continue();
                blocked.push(route.request().url()); return route.abort();
            });
            await page.goto(origin + '/dashboard' + (options.route || '#organisations'));
            await page.waitForFunction(expected => document.body.dataset.dashboardState === expected,
                options.route ? 'ready' : 'selection');
            assert.equal(await page.locator('#dashboardChoices > button[data-binding-id]').count(), accountType === 'company' ? 1 : 50);
            if (!options.route) await rows(page).first().focus(); // Set the initial test position only.
            return page;
        }
        for (const width of [1440, 390, 320]) {
            const page = await open(width), first = requests.length;
            await reachMore(page, 0, 50); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelectorAll('#dashboardChoices > .consultant-organisation-ready').length === 100);
            await checkRow(page, 50);
            await reachMore(page, 50, 100); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelectorAll('#dashboardChoices > .consultant-organisation-ready').length === 105);
            await checkRow(page, 100);
            assert.equal(await page.locator('#dashboardMore').isVisible(), false);
            for (let index = 101; index < 105; index++) await page.keyboard.press('Tab');
            await checkRow(page, 104);
            assert.deepEqual(await rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-binding-id'))),
                bindings.map(row => row.bindingId));
            assert.equal(requests.slice(first).filter(req => req.method === 'POST').length, 0);
            await page.keyboard.press(width === 390 ? 'Enter' : 'Space');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(selected, bindings[104].bindingId);
            assert.equal(requests.slice(first).filter(req => req.method === 'POST').length, 1);
            results.push({ width, organisations: 105, nativeKeys: '50→100→105, first-new-row focus, late selection', passed: true });
            await page.close();
        }
        const moved = await open(390);
        await reachMore(moved, 0, 50);
        gate = { seen: deferred(), release: deferred() };
        await moved.keyboard.press('Enter'); await gate.seen.promise;
        // Removing the focused More button can leave Chromium's sequential
        // cursor at the document boundary. Tab naturally to a live control.
        for (let attempts = 0; attempts < 12; attempts++) {
            await moved.keyboard.press('Tab');
            if (!['BODY', 'HTML'].includes((await active(moved)).tag)) break;
        }
        const deliberate = await active(moved);
        assert.ok(!['BODY', 'HTML'].includes(deliberate.tag), 'native Tab during loading must reach a live control');
        const deliberateNode = await moved.evaluateHandle(() => document.activeElement);
        gate.release.resolve();
        await moved.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
        assert.deepEqual(await active(moved), deliberate, 'successful completion must not steal deliberately moved focus');
        assert.equal(await deliberateNode.evaluate(node => node === document.activeElement), true);
        await deliberateNode.dispose();
        results.push({ case: 'deliberate focus movement during pending More', passed: true }); await moved.close();

        const empty = await open(390); await reachMore(empty, 0, 50); fault = 'empty';
        await empty.keyboard.press('Enter');
        await empty.waitForFunction(() => document.body.dataset.dashboardState === 'selection' && document.getElementById('dashboardMore').hidden);
        await checkRow(empty, 49);
        results.push({ case: 'empty final page retains last-row focus', passed: true }); await empty.close();

        const denied = await open(390); await reachMore(denied, 0, 50); fault = 'denied';
        await denied.keyboard.press('Enter');
        await denied.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
        assert.equal((await active(denied)).id, 'dashboardHeading'); assert.equal(await rows(denied).count(), 0);
        results.push({ case: '403 clears rows and preserves error heading focus', passed: true }); await denied.close();

        for (const width of [1440, 390, 320]) {
            const page = await open(width, { route: '#overview', setupAvailable: true });
            assert.equal(await page.locator('#consultantPortfolioControls').isVisible(), true);
            assert.equal(await page.locator('#clientSetupControls').count(), 0);
            await page.locator('#dashboardChooserHeading').focus(); await page.keyboard.press('Enter');
            await rows(page).first().focus(); // Initial position in the expanded chooser.
            await reachMore(page, 0, 50); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection' &&
                document.querySelectorAll('#dashboardChoices > .consultant-organisation-ready').length === 100 &&
                document.activeElement.getAttribute('data-binding-id') === '10000000-0000-4000-8000-000000000033');
            await checkRow(page, 50);
            assert.equal(new URL(page.url()).hash, '#organisations', 'More must persist the requested list view');
            await page.waitForLoadState('networkidle'); // Settle the synthetic owner setup read before measuring refresh.
            const focusedNode = await page.evaluateHandle(() => document.activeElement);
            const first = requests.length;
            let sessions = 0;
            const confirmed = page.waitForResponse(response => response.url() === origin + '/api/dashboard/session' &&
                response.request().method() === 'GET' && ++sessions === 2);
            await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus')); });
            await (await confirmed).finished(); await page.waitForLoadState('networkidle');
            assert.equal(await page.evaluate(() => document.body.dataset.dashboardState), 'selection');
            assert.equal(await rows(page).count(), 100);
            assert.equal(await focusedNode.evaluate(node => node === document.activeElement), true);
            await focusedNode.dispose(); await checkRow(page, 50);
            const refresh = requests.slice(first);
            assert.deepEqual(refresh.map(req => req.method + ' ' + req.path + req.query), [
                'GET /api/dashboard/session', 'GET /api/dashboard/organisations?limit=50',
                'GET /api/dashboard/organisations?limit=50&afterBindingId=' + bindings[49].bindingId,
                'GET /api/dashboard/session'
            ], 'focus storm must validate only the two loaded pages and final session witness');
            assert.equal(await page.locator('#dashboardChooser input[type="search"]').count(), 0);
            await page.keyboard.press('Space');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            assert.equal(selected, bindings[50].bindingId);
            assert.equal(new URL(page.url()).hash, '#overview');
            assert.equal(requests.slice(first).filter(req => req.method === 'POST').length, 1);
            assert.ok((await page.locator('#dashboardHeading').textContent()).includes(bindings[50].organisationLabel));
            await page.waitForLoadState('networkidle');
            const beforeReturn = requests.length;
            await page.locator('#consultantPortfolioControls').focus(); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'selection');
            await page.waitForLoadState('networkidle');
            assert.equal(new URL(page.url()).hash, '#organisations');
            assert.equal(await rows(page).count(), 50, 'deliberate Return keeps the existing first-page contract');
            assert.equal(await page.locator('#consultantPortfolioControls').isVisible(), false);
            assert.ok((await page.locator('#clientSetupControls').textContent()).includes('Add organisation'));
            assert.equal((await active(page)).id, 'dashboardHeading');
            // Chromium may refresh the favicon after replaceState; measure the API contract.
            assert.ok(requests.slice(beforeReturn).filter(req => req.path.startsWith('/api/')).every(req => req.method === 'GET' &&
                ['/api/dashboard/session', '/api/dashboard/organisations', '/api/customer-signup/clients'].includes(req.path)));
            results.push({ width, case: 'mounted More → stable bounded focus refresh → explicit selection → Return',
                organisations: 100, organisationSearch: 'not provided by existing UI', passed: true });
            await page.close();
        }
        const company = await open(390, { accountType: 'company', route: '#overview' });
        assert.equal(await company.locator('#consultantPortfolioControls').count(), 0);
        assert.equal(await company.locator('#clientSetupControls').count(), 0);
        assert.equal(await company.locator('#dashboardMore').isVisible(), false);
        assert.equal(await company.locator('#dashboardChoices > button[data-binding-id]').first().getAttribute('data-binding-id'), bindings[0].bindingId);
        results.push({ case: 'Company presentation for one server-supplied authorised binding', passed: true });
        await company.close();
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ status: 'passed', baseline, viewBaseline: !!viewBaseline,
            browser: browser.version(), results, sourceHashes: before }));
    } catch (error) {
        console.error(JSON.stringify({ status: 'failed', baseline, viewBaseline: !!viewBaseline, message: error.message, results, errors, blocked,
            recentRequests: requests.slice(-8), sourceHashes: before })); process.exitCode = 1;
    } finally {
        if (gate) gate.release.resolve();
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
})();
