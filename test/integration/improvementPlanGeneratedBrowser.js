'use strict';

// Explicitly opted-in, loopback-only qualification. The generated server owns
// every HTTP/API response and native transaction. Only OIDC/proof/session ports
// use the existing synthetic fixture; this is not live identity or Azure proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACT = path.join(ROOT, 'app-service-dist');
const ORIGIN = 'https://nofries.invalid';
const GENERATION = 'X-NoFries-Dashboard-Generation';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ASSETS = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js',
    'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js'];
const OPEN = { assign: 'Assign to me', start: 'Start action', block: 'Block action', complete: 'Complete action', reopen: 'Reopen action' };
const SAVE = { assign: 'Save assignment', start: 'Start action', block: 'Record block', complete: 'Record completion', reopen: 'Reopen action' };

function filesBelow(directory, prefix = '') {
    return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
        if (entry.name === 'node_modules') return [];
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? filesBelow(directory, relative) : [relative];
    });
}
function artifactInputs() {
    assert.equal(fs.realpathSync(ARTIFACT), ARTIFACT, 'Use this worktree\'s generated artifact');
    const files = ['app-service.js', 'server.js', 'app/dashboard.html', 'app/dashboard.css',
        ...['api', 'lib', 'js'].flatMap(directory => filesBelow(path.join(ROOT, directory)).map(file => path.join(directory, file)))];
    const inputs = {};
    for (const file of files) {
        const source = fs.readFileSync(path.join(ROOT, file)), generated = fs.readFileSync(path.join(ARTIFACT, file));
        assert.equal(sha(generated), sha(source), 'Generated runtime differs: ' + file);
        inputs[file] = sha(source);
    }
    for (const file of ['package.json', 'package-lock.json', 'api/package.json', 'api/package-lock.json',
        'test/integration/dashboardRuntimePostgres.js', 'test/integration/improvementPlanGeneratedBrowser.js']) {
        inputs[file] = sha(fs.readFileSync(path.join(ROOT, file)));
    }
    const configuration = fs.readFileSync(path.join(ROOT, 'dist/staticwebapp.config.json'));
    assert.ok(configuration.length <= 20000, 'Keep the existing static configuration byte cap');
    const rules = JSON.parse(configuration).routes.filter(row => row.route === '/api/dashboard/improvement/*');
    assert.equal(rules.length, 1); assert.deepEqual(rules[0].methods, ['GET', 'POST']);
    return { inputs, staticConfigBytes: configuration.length, staticConfigSha256: sha(configuration) };
}

// Ephemeral test TLS only. Chromium maps the fixed synthetic host to loopback;
// no trust store or production credential is created. Delete key files as soon
// as the local server's in-memory options have been read.
function testTlsOptions() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-generated-browser-tls-'));
    try {
        const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
            '-out', cert, '-days', '1', '-subj', '/CN=nofries.invalid',
            '-addext', 'subjectAltName=DNS:nofries.invalid'], { stdio: 'ignore', timeout: 10000 });
        return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = function registerGeneratedBrowser({ ncscHttpSetup, httpJson, testUrl, getOwnerPool, loginClean, subject }) {
    // Refuse invalid fixture targets while registering, before the containing
    // native suite can run its database setup hooks.
    assert.equal(process.env.NOFRIES_TEST_IMPROVEMENT_GENERATED_BROWSER, '1');
    const database = new URL(testUrl);
    assert.ok(['postgres:', 'postgresql:'].includes(database.protocol));
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
    assert.equal(database.search, ''); assert.equal(database.hash, '');
    test('Generated Improvement runtime and browser forms persist native history, audit, replay and generation denial', async () => {
        const rootLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json')));
        // Loading this optional peer happens only inside the explicit case.
        const { chromium } = require('playwright');
        assert.equal(require('playwright/package.json').version, rootLock.packages['node_modules/playwright'].version);
        const provenance = artifactInputs(), packagedRequire = createRequire(path.join(ARTIFACT, 'server.js'));
        const apiLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'api/package-lock.json')));
        const packagedApiRequire = createRequire(path.join(ARTIFACT, 'api/shared/dashboardRuntime.js'));
        assert.equal(packagedRequire('pg/package.json').version, rootLock.packages['node_modules/pg'].version);
        assert.equal(packagedApiRequire('pg/package.json').version, apiLock.packages['node_modules/pg'].version);
        const appFactory = packagedRequire('./server.js').createNoFriesApp;
        assert.equal(typeof appFactory, 'function');
        assert.notEqual(appFactory, require('../../server').createNoFriesApp, 'Use the generated server factory');
        for (const file of ['api/shared/dashboardRuntime.js', 'api/shared/dashboardRuntimeHandlers.js',
            'api/shared/database/dashboardRequestDatabase.js', 'api/shared/database/postgres.js']) {
            assert.notEqual(packagedRequire('./' + file), require(path.join(ROOT, file)),
                'Generated runtime must load its own module, separately from source fixture mocks: ' + file);
        }
        const { createCommand, saveCommand, submitCommand, allResponses } = require('../fixtures/ncscAssessmentFixture');
        const h = await ncscHttpSetup({ improvementEnabled: true, appFactory });
        httpJson(await h.ncscPost(createCommand()), 201);
        httpJson(await h.ncscPost(saveCommand('assessment-a', 0, 'save-generated-browser', allResponses('yes'))), 200);
        const submitted = await h.ncscPost(submitCommand()); httpJson(submitted, 200);
        const scope = h.binding.scope, owner = getOwnerPool();
        async function retained() {
            const state = {};
            for (const table of ['dashboard_improvement_revisions', 'dashboard_improvement_heads',
                'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts', 'dashboard_runtime_audit']) {
                state[table] = (await owner.query(`SELECT xmin::text AS transaction_id,to_jsonb(t) AS value
                    FROM nofries.${table} t WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY to_jsonb(t)::text`,
                [scope.tenantId, scope.organisationId])).rows;
            }
            return state;
        }
        const before = await retained(), executions = [], requests = [], errors = [], blocked = [];
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-generated-improvement-browser-'));
        const server = https.createServer(testTlsOptions(), h.app); let browser, context, page, planId, actionId;
        const requestRows = new WeakMap(), responseTasks = new Set();
        const bundle = ASSETS.map(file => fs.readFileSync(path.join(ARTIFACT, 'api/shared/protectedAssets', file), 'utf8')).join('\n');
        let deliveredBundle = false, deliveredStyle = false;
        // Observe actual incoming security metadata without reading the body
        // stream or changing what the generated raw-wire controller receives.
        server.prependListener('request', (request, response) => {
            const url = new URL(request.url, ORIGIN);
            const row = requests.find(item => !item.serverObserved && item.path === url.pathname && item.method === request.method);
            if (!row) { errors.push('Untracked loopback request'); return; }
            row.serverObserved = true;
            if (request.method === 'POST') {
                row.generationCurrent = request.headers['x-nofries-dashboard-generation'] === h.generation;
                row.requestSecurity = { origin: request.headers.origin || null, fetchSite: request.headers['sec-fetch-site'] || null,
                    generationCurrent: row.generationCurrent, contentType: request.headers['content-type'] || null,
                    cookiePresent: Boolean(request.headers.cookie) };
                try {
                    assert.equal(row.requestSecurity.origin, ORIGIN); assert.equal(row.requestSecurity.fetchSite, 'same-origin');
                    assert.equal(row.requestSecurity.cookiePresent, true); assert.match(row.requestSecurity.contentType, /^application\/json/);
                } catch (error) { errors.push(error.message); }
            }
            response.once('finish', () => { row.status = response.statusCode; });
        });
        async function inspectResponse(response) {
            const row = requestRows.get(response.request());
            assert.ok(row, 'Observe only tracked browser responses'); row.status = response.status();
            const headers = await response.allHeaders();
            const requiredBody = row.path === '/api/dashboard/app.js' && row.status === 200 ||
                row.path === '/api/dashboard/dashboard.css' && row.status === 200 ||
                row.path === '/api/dashboard/improvement/execute' && row.method === 'POST';
            if (!requiredBody) return;
            let body;
            try { body = await response.body(); }
            catch (error) { throw new Error('Required response body unavailable for ' + row.method + ' ' + row.path + ': ' + error.message, { cause: error }); }
            assert.ok(body.length <= 16 * 1024 * 1024, 'Keep bounded response inspection');
            if (row.path === '/api/dashboard/app.js' && row.status === 200) {
                assert.equal(body.toString(), bundle); assert.match(headers['cache-control'], /no-store/); deliveredBundle = true;
            }
            if (row.path === '/api/dashboard/dashboard.css' && row.status === 200) {
                assert.equal(sha(body), sha(fs.readFileSync(path.join(ARTIFACT, 'app/dashboard.css')))); deliveredStyle = true;
            }
            if (row.method === 'POST') {
                const value = JSON.parse(body); row.responseCode = value.code || null;
                if (row.status === 200) { row.result = value; executions.push(row); }
            }
        }
        async function settleResponses() {
            while (responseTasks.size) await Promise.all([...responseTasks]);
            assert.deepEqual(errors, []);
        }
        try {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolve); });
            browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
                args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP nofries.invalid 127.0.0.1'] });
            context = await browser.newContext({ viewport: { width: 390, height: 950 }, ignoreHTTPSErrors: true });
            const split = h.cookie.indexOf('=');
            await context.addCookies([{ name: h.cookie.slice(0, split), value: h.cookie.slice(split + 1),
                url: ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' }]);
            await context.route('**/*', async route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== ORIGIN || !['GET', 'POST'].includes(request.method()) ||
                    request.method() === 'POST' && url.pathname !== '/api/dashboard/improvement/execute') {
                    blocked.push(url.origin + url.pathname); return route.abort();
                }
                const row = { path: url.pathname, method: request.method() }; requests.push(row);
                requestRows.set(request, row);
                try {
                    if (request.method() === 'POST') {
                        const body = request.postDataBuffer(); assert.ok(body && body.length <= 16384);
                        row.raw = body.toString(); row.command = JSON.parse(row.raw);
                        row.commandType = row.command.type;
                    }
                    // Let Chromium send the genuine request, including its own
                    // wire-time Origin and Fetch Metadata. Never rewrite it.
                    await route.continue();
                } catch (error) { errors.push(error.message); await route.abort(); }
            });
            page = await context.newPage(); page.setDefaultTimeout(15000);
            page.on('response', response => {
                const task = inspectResponse(response).catch(error => { errors.push(error.message); });
                responseTasks.add(task); task.finally(() => responseTasks.delete(task));
            });
            // Native authority uses this explicit synthetic fixture clock.
            // Keep genuine browser expiry checks on the same timeline.
            await page.clock.install({ time: new Date(h.state.now) });
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.generatedCspViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.generatedCspViolations.push(event.effectiveDirective));
            });
            await page.goto(ORIGIN + '/dashboard#overview', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            await settleResponses();
            assert.equal(await page.locator('script[src="/api/dashboard/app.js"]').getAttribute('integrity'),
                'sha256-' + crypto.createHash('sha256').update(bundle).digest('base64'));
            await page.getByLabel('Saved assessment', { exact: true }).selectOption('assessment-a');
            await page.locator('.picture-source').filter({ hasText: 'submitted' }).waitFor();
            await page.getByRole('button', { name: 'Review supporting-evidence gaps', exact: true }).click();
            const category = page.locator('.picture-follow-up > details').filter({ has: page.locator('summary', { hasText: /^Supporting-evidence gaps/ }) });
            assert.equal(await category.evaluate(node => node.open), true); assert.ok(await category.locator('article').count());
            await page.getByRole('button', { name: 'Plan improvements for this assessment', exact: true }).click();
            assert.equal(executions.length, 0, 'Review/navigation must not create a plan');
            await page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true }).click();
            await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
            await settleResponses();
            assert.equal(executions.length, 1); const generated = executions[0]; planId = generated.command.planId;
            assert.equal(generated.command.type, 'generate');
            assert.deepEqual(generated.command.payload, { assessmentId: 'assessment-a', assessmentRevision: submitted.body.assessment.revision,
                assessmentRevisionSha256: submitted.body.assessment.revisionSha256 });
            const editor = page.locator('section[aria-label="Update an improvement action"]');
            const form = () => page.getByRole('form', { name: 'Improvement action update', exact: true });
            const picker = editor.getByRole('combobox', { name: 'Improvement action', exact: true });
            await picker.waitFor(); actionId = await picker.inputValue(); assert.ok(actionId);
            async function open(type) { await editor.getByRole('button', { name: OPEN[type], exact: true }).click(); await form().waitFor(); }
            async function save(type) {
                const count = executions.length;
                await form().getByRole('button', { name: SAVE[type], exact: true }).click();
                await page.waitForFunction(revision => {
                    const term = [...document.querySelectorAll('[aria-label="Improvement action plan"] dt')].find(node => node.textContent === 'Plan revision');
                    return term?.nextElementSibling?.textContent === String(revision) &&
                        [...document.querySelectorAll('section[aria-label="Update an improvement action"] button')].some(button => !button.disabled);
                }, count);
                await settleResponses();
                assert.equal(executions.length, count + 1); assert.equal(executions.at(-1).command.type, type);
            }
            await open('assign'); await form().getByLabel('Due date (UTC)', { exact: true }).fill('2026-09-08');
            const cancelBefore = await retained();
            await form().getByRole('button', { name: 'Cancel changes', exact: true }).click();
            assert.deepEqual(await retained(), cancelBefore); assert.equal(executions.length, 1);
            await open('assign'); await form().getByLabel('Due date (UTC)', { exact: true }).fill('2026-09-08'); await save('assign');
            assert.equal(executions.at(-1).command.payload.ownerSubjectKey, subject(h.principal));
            await open('start'); await save('start');
            await open('block'); await form().getByLabel('Block reason', { exact: true }).fill('Synthetic generated-runtime dependency.'); await save('block');
            // Follow only legal commands advertised by the actual native editor.
            if (await editor.getByRole('button', { name: OPEN.start, exact: true }).isVisible()) { await open('start'); await save('start'); }
            await open('complete'); await form().getByLabel('Completion note', { exact: true }).fill('Synthetic work completed for review.');
            await form().getByLabel('Completion evidence reference (unverified)', { exact: true }).fill('synthetic:generated-browser:evidence'); await save('complete');
            const completed = await h.get('improvement/view?planId=' + encodeURIComponent(planId), h.generation); httpJson(completed, 200);
            assert.equal(completed.body.actions.find(row => row.actionId === actionId).evidence.completionVerification, 'not_verified');
            await open('reopen'); await form().getByLabel('Reopen reason', { exact: true }).fill('Synthetic reviewer requests follow-up.'); await save('reopen');
            const revision = executions.length - 1, writes = executions.map(row => row.command.type);
            assert.ok(['assign', 'start', 'block', 'complete', 'reopen'].every(type => writes.includes(type)));
            assert.deepEqual(executions.slice(1).map(row => row.command.expectedRevision), Array.from({ length: revision }, (_, index) => index));
            assert.equal(new Set(executions.map(row => row.command.operationId)).size, executions.length);
            assert.ok(executions.every(row => row.generationCurrent));
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
            await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
            await settleResponses();
            assert.equal(await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).inputValue(), planId);
            const card = page.locator('[aria-label="Improvement action plan"] article').filter({ hasText: actionId });
            await card.locator('summary').filter({ hasText: /^Action history/ }).click();
            for (const label of ['Assigned', 'Started', 'Blocked', 'Completed', 'Reopened']) assert.ok((await card.innerText()).includes(label));
            assert.equal(executions.length, revision + 1, 'Reload performs no write');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: path.join(directory, '390-retained-native-history.png') });
            const persisted = await retained(), actionRows = persisted.dashboard_improvement_revisions;
            const writeAudits = persisted.dashboard_runtime_audit.filter(row => row.value.payload.action === 'improvement.write');
            assert.equal(actionRows.length, executions.length); assert.equal(writeAudits.length, executions.length);
            assert.deepEqual(actionRows.map(row => row.transaction_id).sort(), writeAudits.map(row => row.transaction_id).sort());
            for (const row of actionRows) {
                assert.equal(row.value.assessment_revision, submitted.body.assessment.revision);
                assert.equal(row.value.assessment_sha256, submitted.body.assessment.revisionSha256);
                assert.equal(row.value.assessment_id, 'assessment-a');
            }
            for (const table of ['dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts'])
                assert.deepEqual(persisted[table], before[table], 'Action workflow must preserve exact assessment state and scores');
            const replayBefore = await retained();
            const replay = await h.post('improvement/execute', generated.raw).set('Content-Type', 'application/json').set(GENERATION, h.generation);
            httpJson(replay, 200); assert.deepEqual(replay.body, generated.result); assert.deepEqual(await retained(), replayBefore);
            await open('assign'); await form().getByLabel('Due date (UTC)', { exact: true }).fill('2026-09-09');
            const oldGeneration = h.generation; h.generation = await h.select(h.binding, oldGeneration);
            assert.notEqual(h.generation, oldGeneration); const denialBefore = await retained();
            await form().getByRole('button', { name: SAVE.assign, exact: true }).click();
            await form().waitFor({ state: 'detached' });
            await settleResponses();
            assert.equal(await editor.isVisible(), false);
            assert.equal(requests.filter(row => row.path === '/api/dashboard/improvement/execute').at(-1).status, 403);
            assert.deepEqual(await retained(), denialBefore);
            httpJson(await h.post('improvement/execute', generated.raw).set('Content-Type', 'application/json').set(GENERATION, oldGeneration), 403, 'improvement_access_denied');
            assert.deepEqual(await retained(), denialBefore);
            assert.ok(deliveredBundle && deliveredStyle); assert.deepEqual(await page.evaluate(() => window.generatedCspViolations), []);
            assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
            await context.close(); context = null;
            const disabled = await ncscHttpSetup({ appFactory }), trace = disabled.f.state.trace.length;
            const disabledBefore = await retained();
            httpJson(await disabled.get('improvement/editor?planId=' + encodeURIComponent(planId), disabled.generation), 404, 'dashboard_not_found');
            httpJson(await disabled.post('improvement/execute', generated.raw).set('Content-Type', 'application/json').set(GENERATION, disabled.generation), 404, 'dashboard_not_found');
            assert.equal(disabled.f.state.trace.length, trace); assert.deepEqual(await retained(), disabledBefore);
            assert.deepEqual(artifactInputs(), provenance, 'Source and generated bytes must stay frozen through the proof');
            fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ passed: true, synthetic: true, liveAcceptance: false,
                browser: browser.version(), viewport: 390, transport: 'genuine-loopback-https', provenance, commands: writes, planRevision: revision,
                nativeRevisions: actionRows.length, pairedWriteAudits: writeAudits.length, exactReplayEffects: 0,
                staleGenerationEffects: 0, defaultOffPrivateQueries: 0, assessmentChanged: false,
                requests: requests.map(({ path: route, method, status, commandType, requestSecurity, responseCode }) =>
                    ({ path: route, method, status, commandType, requestSecurity, responseCode })), errors, blocked }, null, 2));
            console.log(JSON.stringify({ generatedImprovementBrowser: 'PASS', artifacts: directory, commands: writes.length, nativeAuditPairs: writeAudits.length }));
        } catch (error) {
            const browserState = page && !page.isClosed() ? await page.evaluate(() => ({
                state: document.body?.dataset.dashboardState || null,
                status: [...document.querySelectorAll('[role="status"]')].slice(0, 4).map(node => node.textContent),
                csp: window.generatedCspViolations || [], now: new Date().toISOString()
            })).catch(() => ({ unavailable: true })) : { unavailable: true };
            fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ passed: false, message: error.message, provenance,
                fixtureTime: h.state.now, browserState,
                requests: requests.map(({ path: route, method, status, commandType, requestSecurity, responseCode }) =>
                    ({ path: route, method, status, commandType, requestSecurity, responseCode })), errors, blocked }, null, 2));
            throw error;
        } finally {
            if (context) await context.close();
            if (browser) await browser.close();
            server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
            await loginClean();
        }
    }, 120000);
};
