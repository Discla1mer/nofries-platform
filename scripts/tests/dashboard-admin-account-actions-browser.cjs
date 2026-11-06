'use strict';

// Local Chromium evidence. Uses the real document, CSS, three protected browser
// controllers and account-action service, with synthetic in-memory authority,
// confirmation storage and native-action ports. This is not production session,
// HTTP-handler, database, audit durability or deployment evidence.
// Reuses installed Playwright and Chromium; never downloads a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardAdminDocument, dashboardAdminCss, contentSecurityPolicy } = require('../../lib/dashboardAdminDocument');
const { createDashboardAdminAccountActionService } = require('../../api/shared/dashboardAdmin/accountActionService');

const root = path.resolve(__dirname, '../..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-admin-account-actions-'));
fs.chmodSync(artifacts, 0o700);
const assets = ['dashboardAdmin.js', 'signupQueue.js', 'dashboardAdminAccountActions.js'];
const script = assets.map(file => fs.readFileSync(path.join(root, 'api/shared/protectedAssets', file), 'utf8')).join('\n');
const selector = { provider: 'legacy', subjectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'Synthetic-Tenant_A.1', organisationId: 'Synthetic-Organisation_A.1' };
const actor = { provider: 'entra-bff', isAuthenticated: true,
    subjectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const membership = { membershipId: 'synthetic-browser-member', status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-12-31T00:00:00.000Z' };
const canonicalName = 'Synthetic organisation';
const confirmations = new Map(), receipts = new Map(), requests = [], effects = [];
let state, responseMode = 'normal', releaseResponse = null;
function reset() {
    state = { label: null, status: 'active', revision: 1, recoverable: false };
    confirmations.clear(); receipts.clear(); requests.length = 0; effects.length = 0; responseMode = 'normal';
}
const version = () => createHash('sha256').update(JSON.stringify(state)).digest('hex');
const fail = (code = 409) => { throw Object.assign(new Error('synthetic-boundary-rejection'), { statusCode: code, code: code === 409 ? 'dashboard_admin_conflict' : 'dashboard_admin_unavailable' }); };
const service = createDashboardAdminAccountActionService({ authoriseOperator: async ({ principal, selector: selected }) =>
    principal.subjectKey === actor.subjectKey && (!selected || Object.keys(selector).every(key => selected[key] === selector[key])),
    clock: () => new Date().toISOString(),
    confirmationStore: {
        create: async (key, command, beforeWrite) => { await beforeWrite(); if (confirmations.has(key)) fail(); confirmations.set(key, command); return true; },
        load: async key => confirmations.get(key) || null
    }, adapter: {
        inspect: async selected => ({ selector: selected, version: version(), displayName: canonicalName, displayLabel: state.label,
            membership: { ...membership, status: state.status }, actions: ['edit', ...(state.status === 'active' ? ['delete'] : state.recoverable ? ['restore'] : [])],
            witness: { source: 'synthetic-browser-authority', revision: state.revision } }),
        outcome: async command => receipts.get(command.operationId) || null,
        commit: async (command, context) => {
            if (receipts.has(command.operationId)) return receipts.get(command.operationId);
            if (version() !== command.expectedVersion) fail();
            await context.beforeCommit();
            const before = { ...state };
            if (command.action === 'edit') state.label = command.patch.displayLabel;
            else if (command.action === 'delete' && state.status === 'active') { state.status = 'suspended'; state.recoverable = true; }
            else if (command.action === 'restore' && state.status === 'suspended' && state.recoverable) { state.status = 'active'; state.recoverable = false; }
            else fail();
            state.revision += 1;
            const receipt = { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded', version: version(), occurredAt: context.check() };
            effects.push({ action: command.action, before, after: { ...state } }); receipts.set(command.operationId, receipt); return receipt;
        }
    }
});
const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    const files = { '/dashboard-admin': ['text/html; charset=utf-8', buildDashboardAdminDocument()],
        '/api/dashboard-admin/app.js': ['application/javascript; charset=utf-8', script],
        '/api/dashboard-admin/app.css': ['text/css; charset=utf-8', dashboardAdminCss] };
    function json(body, code = 200) { if (response.destroyed) return; response.statusCode = code; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); }
    try {
        const file = files[request.url];
        if (request.method === 'GET' && file) { response.setHeader('Content-Type', file[0]); return response.end(file[1]); }
        if (request.url === '/favicon.svg') { response.statusCode = 204; return response.end(); }
        if (request.method === 'GET' && request.url === '/api/dashboard-admin/capabilities') return json({ lookup: false, signupList: false, recovery: [], ...await service.capabilities(actor) });
        const match = request.url.match(/^\/api\/dashboard-admin\/actions\/(inspect|prepare|execute|outcome)$/);
        if (request.method !== 'POST' || !match) return json({ code: 'synthetic_not_found' }, 404);
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), method = match[1];
        requests.push({ method, input });
        const result = await service[method](actor, input);
        if (method === 'execute' && responseMode === 'hold-after-commit') await new Promise(resolve => { releaseResponse = resolve; });
        if (method === 'execute' && responseMode === 'drop-after-commit') { response.destroy(); return; }
        json(result);
    } catch (error) { json({ code: error.code || 'dashboard_admin_unavailable' }, error.statusCode || 503); }
});

(async () => {
    let browser, failure;
    const results = [], outside = [], pageErrors = [], violations = [];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1280, 768, 390, 320]) {
            reset();
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => { window.actionCspViolations = []; document.addEventListener('securitypolicyviolation', event => window.actionCspViolations.push(event.effectiveDirective)); });
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
                return route.continue();
            });
            const field = suffix => page.locator('#accountActions' + suffix);
            const waitStatus = text => page.waitForFunction(value => document.getElementById('accountActionsStatus').textContent.includes(value), text);
            const focusIs = suffix => field(suffix).evaluate(element => document.activeElement === element);
            async function inspect() {
                await field('Provider').selectOption(selector.provider); await field('Subject').fill(selector.subjectKey);
                await field('Tenant').fill(selector.tenantId); await field('Organisation').fill(selector.organisationId);
                await field('Organisation').press('Enter'); await field('InspectionHeading').waitFor();
                assert.equal(await focusIs('InspectionHeading'), true); assert.deepEqual(requests.at(-1).input, selector);
            }
            async function prepare(action, label = null) {
                await field('Action').selectOption(action); if (action === 'delete') await field('ConfirmationName').fill(canonicalName); if (label !== null) await field('Name').fill(label);
                await field('Prepare').click(); await field('PreviewHeading').waitFor();
                assert.equal(await focusIs('PreviewHeading'), true); assert.equal(await field('Execute').isDisabled(), true);
                const text = await field('Preview').innerText();
                for (const expected of [selector.subjectKey, selector.tenantId, selector.organisationId, canonicalName, 'before', 'after']) assert.ok(text.includes(expected));
                assert.equal(requests.at(-1).method, 'prepare');
                assert.deepEqual(requests.at(-1).input.patch, label === null ? null : { displayLabel: label });
            }
            async function confirm() {
                await field('Confirm').check(); await field('Execute').click(); await waitStatus('request succeeded');
                assert.equal(await focusIs('OutcomeHeading'), true); assert.equal(await field('Recover').isHidden(), true);
            }
            async function refresh() { await field('Fresh').click(); await field('InspectionHeading').waitFor(); }
            async function layoutCheck() {
                const layout = await page.evaluate(() => {
                    const section = document.getElementById('accountActionsHeading').parentElement;
                    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                        controls: [...section.querySelectorAll('input:not([type="checkbox"]), select, button')].filter(node => node.getClientRects().length)
                            .map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
                                left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })) };
                });
                assert.ok(layout.scrollWidth <= width + 1, 'no horizontal overflow at ' + width);
                assert.ok(layout.controls.every(box => box.width > 0 && box.height >= 44 && box.left >= 0 && box.right <= width + 1), 'visible usable controls at ' + width);
                return layout;
            }
            await page.goto(origin + '/dashboard-admin');
            await page.waitForFunction(() => !document.getElementById('accountActionsSelectorFields').disabled);
            assert.equal(requests.length, 0, 'no automatic identity or account read');
            await field('Provider').focus(); await page.keyboard.press('ArrowDown'); assert.equal(await field('Provider').inputValue(), 'external');
            await page.keyboard.press('ArrowUp'); await page.keyboard.press('Tab'); assert.equal(await focusIs('Subject'), true);
            await inspect(); assert.match(await field('Inspection').innerText(), /Signup reset and permanent account erasure are unavailable/);
            assert.deepEqual(await field('Action').locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['edit', 'delete']);
            await prepare('edit', 'Synthetic browser staff label');
            const commitsBeforeConfirmation = effects.length;
            await page.keyboard.press('Tab'); assert.equal(await focusIs('Confirm'), true, 'review heading leads to confirmation checkbox');
            await page.keyboard.press('Space'); await page.keyboard.press('Tab'); assert.equal(await focusIs('Execute'), true);
            assert.equal(effects.length, commitsBeforeConfirmation, 'checkbox alone does not send action');
            await page.keyboard.press('Enter'); await waitStatus('request succeeded'); assert.equal(await focusIs('OutcomeHeading'), true);
            assert.equal(state.label, 'Synthetic browser staff label'); assert.equal(state.status, 'active');
            await refresh(); await prepare('delete');
            assert.match(await field('Preview').innerText(), /Stored data, the global identity and memberships in other organisations are preserved/);
            assert.match(await field('Preview').innerText(), /suspended/);
            const layout = await layoutCheck();
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, 'account-actions-preview-' + width + '.png'), fullPage: true });
            await confirm(); assert.equal(state.status, 'suspended');
            await refresh(); assert.deepEqual(await field('Action').locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['edit', 'restore']);
            await prepare('restore'); assert.match(await field('Preview').innerText(), /does not extend access dates/);
            await confirm(); assert.equal(state.status, 'active'); assert.equal(state.label, 'Synthetic browser staff label');

            // The real service has committed before delivery is interrupted.
            // Cancellation aborts only the browser wait; outcome uses the exact
            // retained token and reads the synthetic receipt without a new effect.
            await refresh(); await prepare('edit', 'Synthetic recovered label'); responseMode = 'hold-after-commit';
            await field('Confirm').check(); await field('Execute').click();
            await page.waitForFunction(() => document.getElementById('accountActionsCancel').textContent === 'Stop waiting for this request');
            const holdDeadline = Date.now() + 10000;
            while (!releaseResponse && Date.now() < holdDeadline) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(typeof releaseResponse, 'function', 'synthetic commit reached the held response boundary');
            const executeInput = requests.at(-1).input, committedCount = effects.length;
            await field('Cancel').click(); await waitStatus('outcome is unverified');
            assert.equal(await field('Subject').isDisabled(), true); assert.equal(await field('Fresh').isHidden(), true);
            assert.equal(await field('Recover').isVisible(), true); assert.equal(await focusIs('Recover'), true);
            responseMode = 'normal'; releaseResponse(); releaseResponse = null;
            await field('Recover').click(); await waitStatus('request succeeded');
            assert.equal(requests.at(-1).method, 'outcome'); assert.deepEqual(requests.at(-1).input, executeInput);
            assert.equal(effects.length, committedCount, 'outcome recovery never creates another effect');
            assert.equal(state.label, 'Synthetic recovered label');

            await refresh(); await prepare('edit', 'Synthetic network recovery label'); responseMode = 'drop-after-commit';
            await field('Confirm').check(); await field('Execute').click(); await waitStatus('outcome could not be verified');
            const droppedInput = requests.at(-1).input, effectsAfterDrop = effects.length;
            responseMode = 'normal'; await field('Recover').click(); await waitStatus('request succeeded');
            assert.deepEqual(requests.at(-1).input, droppedInput); assert.equal(effects.length, effectsAfterDrop);
            assert.equal(effects.length, 5); await layoutCheck();
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, 'account-actions-recovered-' + width + '.png'), fullPage: true });
            assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
            violations.push(...await page.evaluate(() => window.actionCspViolations));
            results.push({ width, layout, keyboardAndFocus: true, explicitLabelConfirmation: true, scopedRemoveRestore: true,
                cancelAfterCommitSameTokenRecovery: true, droppedResponseSameTokenRecovery: true, effects: effects.length, requestCount: requests.length,
                noBrowserStorage: true, canonicalNameUnchanged: true });
            await context.close();
        }
        assert.deepEqual(outside, []); assert.deepEqual(pageErrors, []); assert.deepEqual(violations, []);
    } catch (error) { failure = error; }
    finally {
        if (releaseResponse) releaseResponse();
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
        const sources = ['lib/dashboardAdminDocument.js', ...assets.map(file => 'api/shared/protectedAssets/' + file),
            'api/shared/dashboardAdmin/accountActionService.js', 'api/shared/dashboardAdmin/accountActionRecords.js', 'scripts/tests/dashboard-admin-account-actions-browser.cjs'];
        fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ syntheticOnly: true,
            realComponents: ['Chromium', 'generated document and CSS', 'protected browser controllers', 'accountActionService and record codecs'],
            syntheticBoundaries: ['local HTTP shell instead of production handlers/session', 'operator authority', 'in-memory confirmation storage', 'in-memory native account action and receipt ports'],
            results, outside, pageErrors, violations, sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
            failure: failure?.message || null }, null, 2), { mode: 0o600 });
        process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: !failure, widths: results.map(item => item.width), artifacts }) + '\n');
        if (failure) { process.stderr.write(failure.stack + '\n'); process.exitCode = 1; }
    }
})();
