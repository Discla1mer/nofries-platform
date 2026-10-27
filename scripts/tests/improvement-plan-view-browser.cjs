'use strict';

// Optional actual-browser component proof. Uses existing Playwright/Chromium,
// synthetic retained actions and a loopback allowlist only. No installed host,
// authenticated acceptance, editing, API call or dependency installation.
// Run: node scripts/tests/improvement-plan-view-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { createImprovementPlan, applyImprovementActionCommand } = require('../../api/shared/improvementPlan/improvementPlanDomain');
const { projectImprovementActionList } = require('../../api/shared/improvementPlan/improvementActionListProjection');
const { projectImprovementActionPlanPresentation } = require('../../api/shared/improvementPlan/improvementActionPlanPresentation');
const { acceptedRegistry } = require('../../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const fixture = require('../../test/fixtures/ncscAcceptedEvaluation.json').input;
const root = path.resolve(__dirname, '../..');
const files = ['api/shared/protectedAssets/improvementActionPlanView.js',
    'api/shared/improvementPlan/improvementPlanDomain.js', 'api/shared/improvementPlan/improvementActionListProjection.js',
    'api/shared/improvementPlan/improvementActionPlanPresentation.js', 'app/dashboard.css',
    'test/fixtures/ncscAcceptedEvaluation.json', 'scripts/tests/improvement-plan-view-browser.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const frozen = hashes();
const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const scope = { tenantId: 'synthetic-tenant', organisationId: fixture.organisationId, planId: 'synthetic-plan' };
const NOTE = '完成 <script>alert(1)</script><img src=x onerror=alert(2)> & "note" ' + 'long-unbroken-note'.repeat(30);
const REFERENCE = '證據:*<img onerror=alert(3)>';
const REASON = 'Recheck <svg onload=alert(4)> & Unicode 證據';

function retainedModels() {
    let state = createImprovementPlan({ ...scope, actorSubjectKey: ACTOR, createdAt: '2026-09-14T09:00:00.000Z' },
        clone(fixture), { registry: acceptedRegistry });
    function step(index, type, payload) {
        state = applyImprovementActionCommand(state, { ...scope, evaluationOutputSha256: state.source.evaluationOutputSha256,
            actionId: state.proposals[index].actionId, operationId: 'synthetic-op-' + state.commands.length,
            expectedRevision: state.commands.length, actorSubjectKey: ACTOR,
            at: '2026-09-14T09:' + String(state.commands.length + 1).padStart(2, '0') + ':00.000Z', type, payload },
        { tenantId: scope.tenantId, organisationId: scope.organisationId, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] });
    }
    for (let index = 0; index < 5; index++) {
        step(index, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-10-01' });
        if (index > 0) step(index, 'start', {});
        if (index === 2) step(index, 'block', { reason: REASON });
        if (index >= 3) step(index, 'complete', { note: NOTE, evidenceReference: REFERENCE });
        if (index === 4) step(index, 'reopen', { reason: REASON });
    }
    const project = filters => projectImprovementActionList(state, { scope, asOf: '2026-10-02T00:00:00.000Z',
        filters: { status: 'all', owner: 'all', overdueOnly: false, ...filters } });
    const mixed = projectImprovementActionPlanPresentation(project());
    const filtered = projectImprovementActionPlanPresentation(project({ owner: OTHER }));
    // Explicit synthetic zero-action contract fixture. This makes no claim that
    // this assessment has no gaps; the ordinary mixed model retains every gap.
    const emptyList = clone(project()); emptyList.actions = [];
    const zero = { total: 0, overdue: 0, unassigned: 0, byStatus: { open: 0, in_progress: 0, blocked: 0, completed: 0 } };
    emptyList.counts = { all: clone(zero), visible: clone(zero) };
    return { mixed, filtered, empty: projectImprovementActionPlanPresentation(emptyList),
        completedIndex: mixed.actions.findIndex(action => action.actionId === state.proposals[3].actionId),
        reopenedIndex: mixed.actions.findIndex(action => action.actionId === state.proposals[4].actionId) };
}

function documentFor() {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Synthetic Improvement Plan component check</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/dashboard.css">' +
        '</head><body class="nofries-dashboard"><main class="dashboard-main"><div id="plan"></div></main>' +
        '<script src="/view.js"></script></body></html>';
}
async function keyboardOpen(page, summary) {
    // Begin at the actual native tab sequence, then use Space/Enter to toggle.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    let reached = false;
    for (let count = 0; count < 40; count++) {
        await page.keyboard.press('Tab');
        if (await summary.evaluate(node => node === document.activeElement)) { reached = true; break; }
    }
    assert.equal(reached, true, 'Disclosure summary is reachable through native Tab navigation');
    const focus = await summary.evaluate(node => {
        const style = getComputedStyle(node);
        return { visible: node.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.ok(focus.visible && focus.style !== 'none' && focus.width >= 2, 'Keyboard focus remains visible');
    assert.equal(await summary.evaluate(node => node.parentElement.open), false);
    await page.keyboard.press('Space');
    assert.equal(await summary.evaluate(node => node.parentElement.open), true);
    await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(node => node.parentElement.open), false);
    await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(node => node.parentElement.open), true);
}

async function main() {
    const models = retainedModels(), requests = [], violations = [], errors = [], cases = [];
    const artifacts = fs.mkdtempSync('/tmp/nofries-improvement-plan-browser-'); fs.chmodSync(artifacts, 0o700);
    const routes = { '/dashboard.css': ['text/css', fs.readFileSync(path.join(root, 'app/dashboard.css'))],
        '/view.js': ['text/javascript', fs.readFileSync(path.join(root, 'api/shared/protectedAssets/improvementActionPlanView.js'))],
        '/': ['text/html; charset=utf-8', documentFor()] };
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        requests.push({ method: request.method, path: pathname });
        if (request.method !== 'GET' || !routes[pathname]) {
            violations.push({ method: request.method, path: pathname }); response.statusCode = 405; return response.end();
        }
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', routes[pathname][0]);
        response.end(routes[pathname][1]);
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true });
        for (const width of [320, 390, 768, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
            page.on('dialog', dialog => { errors.push('Unexpected script dialog'); dialog.dismiss(); });
            await context.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== origin || request.method() !== 'GET' || !routes[url.pathname]) {
                    violations.push({ method: request.method(), path: url.pathname }); return route.abort();
                }
                return route.continue();
            });
            await page.goto(origin);
            await page.evaluate(model => {
                window.syntheticOld = NoFriesImprovementActionPlanView.mountLoading(document.querySelector('#plan'));
                window.syntheticCurrent = NoFriesImprovementActionPlanView.mount(document.querySelector('#plan'), model);
                window.syntheticOld.destroy();
            }, models.mixed);
            assert.equal(await page.locator('[aria-busy]').count(), 0);
            assert.equal(await page.locator('article').count(), models.mixed.actions.length);
            assert.match(await page.locator('#plan').innerText(), /Read-only plan[\s\S]*Changes cannot be made in this view/);
            const facts = await page.locator('article').evaluateAll(elements => elements.map(element => {
                const list = element.querySelector(':scope > dl');
                return Object.fromEntries([...list.querySelectorAll('dt')]
                    .map(term => [term.textContent, term.nextElementSibling.textContent]));
            }));
            // Native DOM facts preserve presentation values and sequence; guidance
            // does not pick a different action or invent a human owner name.
            for (const [index, action] of models.mixed.actions.entries()) {
                assert.equal(await page.locator('article h3').nth(index).innerText(), action.controlId + ' · ' + action.labels.kind);
                assert.equal(facts[index].Owner, action.labels.owner);
                assert.equal(facts[index]['Due date (UTC calendar day)'], action.dueDate || 'Not set');
                assert.equal(facts[index]['Overdue at supplied as-of date (UTC)'], action.isOverdue ? 'Yes' : 'No');
                assert.ok(facts[index]['Next step'], 'Every action has a plain-language next step');
                if (action.status === 'completed') assert.match(facts[index]['Next step'], /completion note.*history/);
                else if (action.status === 'blocked') assert.match(facts[index]['Next step'], /block reason.*move forward/);
                else if (action.ownerSubjectKey === null) assert.match(facts[index]['Next step'], /owner and due date.*starting/);
                else assert.match(facts[index]['Next step'], /owner.*due date/);
            }
            assert.equal(facts[models.reopenedIndex]['Completion note'], undefined);
            assert.equal(facts[models.completedIndex]['Completion note'], NOTE);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, width + ': collapsed overflow');
            if (width === 390 || width === 1280) await page.screenshot({ path: path.join(artifacts, width + '-ready.png'), fullPage: false });
            const completed = page.locator('article').nth(models.completedIndex);
            const evidence = completed.locator('details').filter({ has: page.locator('summary', { hasText: /^Supporting evidence$/ }) });
            await keyboardOpen(page, evidence.locator('summary'));
            const evidenceFacts = await evidence.locator('dl').first().evaluate(list => Object.fromEntries([...list.querySelectorAll('dt')]
                .map(term => [term.textContent, term.nextElementSibling.textContent])));
            assert.equal(evidenceFacts['Completion evidence reference (unverified)'], REFERENCE);
            assert.equal(evidenceFacts['Completion reference recorded at (UTC)'], models.mixed.actions[models.completedIndex].completion.at);
            assert.match(await evidence.innerText(), /its date and version are unknown/);
            assert.equal(evidenceFacts.Verification, 'Not verified');
            assert.match(await evidence.innerText(), /Assessment source/);
            assert.equal(await evidence.locator('a, img, script').count(), 0);
            if (width === 390 || width === 1280) await evidence.screenshot({ path: path.join(artifacts, width + '-supporting-evidence.png') });
            const reopened = page.locator('article').nth(models.reopenedIndex);
            const emptyEvidence = reopened.locator('details').filter({ has: page.locator('summary', { hasText: /^Supporting evidence$/ }) });
            await keyboardOpen(page, emptyEvidence.locator('summary'));
            assert.match(await emptyEvidence.innerText(), /No completion evidence reference is recorded for the current action/);
            assert.equal((await emptyEvidence.innerText()).includes(REFERENCE), false);
            assert.equal((await emptyEvidence.innerText()).includes('Completion reference recorded at (UTC)'), false);
            if (width === 390) await emptyEvidence.screenshot({ path: path.join(artifacts, width + '-empty-evidence.png') });
            const history = reopened.locator('details').filter({ has: page.locator('summary', { hasText: /^Action history/ }) });
            await keyboardOpen(page, history.locator('summary'));
            assert.match(await history.innerText(), /Completed[\s\S]*Reopened/);
            assert.ok((await history.innerText()).includes(NOTE));
            assert.ok((await history.innerText()).includes(REFERENCE));
            if (width === 390) await reopened.screenshot({ path: path.join(artifacts, '390-reopened-history.png') });
            await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, width + ': expanded overflow');
            assert.equal(await page.locator('#plan a, #plan img, #plan script, #plan svg, #plan iframe, #plan button, #plan input, #plan select, #plan textarea, #plan form').count(), 0);
            assert.ok((await page.locator('#plan').innerText()).includes('No updates recorded for this action.'));
            cases.push({ width, state: 'ready', actions: models.mixed.actions.length, keyboardEvidence: 'pass', keyboardHistory: 'pass', retainedHistory: 'pass', overflow: 'none' });
            for (const state of ['filtered', 'empty']) {
                await page.evaluate(model => NoFriesImprovementActionPlanView.mount(document.querySelector('#plan'), model), models[state]);
                const text = await page.locator('#plan').innerText();
                assert.equal(await page.locator('article').count(), 0);
                assert.match(text, state === 'filtered' ? /No actions match these filters.*Counts and filters/ : /No retained improvement actions.*assessment version/);
                assert.ok(text.includes('Showing 0 of ' + models[state].counts.all.total + ' actions.'));
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                cases.push({ width, state, overflow: 'none' });
            }
            await page.evaluate(() => {
                window.syntheticOld = NoFriesImprovementActionPlanView.mount(document.querySelector('#plan'), { privateError: 'synthetic internal detail' });
            });
            const unavailable = await page.locator('[role="status"]').innerText();
            assert.match(unavailable, /unavailable.*Refresh the page.*support team/);
            assert.ok(!unavailable.includes('synthetic internal detail'));
            assert.equal(await page.locator('article, #plan button, #plan input, #plan form').count(), 0);
            cases.push({ width, state: 'unavailable', sanitized: true });
            await page.evaluate(() => {
                window.syntheticCurrent = NoFriesImprovementActionPlanView.mountLoading(document.querySelector('#plan'));
                window.syntheticOld.destroy();
            });
            assert.equal(await page.locator('[role="status"]').innerText(), 'Loading improvement actions…');
            assert.equal(await page.locator('[role="status"]').getAttribute('aria-busy'), null);
            assert.equal(await page.locator('article, #plan button, #plan input, #plan form').count(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            cases.push({ width, state: 'loading', staleController: 'inert', overflow: 'none' });
            await context.close();
        }
        assert.deepEqual(violations, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), frozen);
        const result = { synthetic: true, authenticatedAcceptance: false, cases, requests, violations, errors,
            sourceHashes: frozen, externalRequests: 0, mutationRequests: 0 };
        fs.writeFileSync(path.join(artifacts, 'browser-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ passed: cases.length, artifacts, requests: requests.length, externalRequests: 0, mutationRequests: 0, errors: 0 }));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
