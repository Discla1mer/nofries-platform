'use strict';

// Optional loopback-only browser composition proof with existing Playwright and
// Chromium. Canonical API responses use existing synthetic domain fixtures. This
// is not installed schema, real identity/provider access or authenticated live
// acceptance. The separately executed native HTTP suite owns that SQL proof.
// Run: node scripts/tests/improvement-plan-mounted-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } =
    require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } =
    require('../../api/shared/improvementPlan/improvementPlanDomain');
const { normaliseImprovementCommand } = require('../../api/shared/improvementPlan/improvementPlanService');
const { projectImprovementActionList } = require('../../api/shared/improvementPlan/improvementActionListProjection');
const { projectImprovementActionPlanPresentation } = require('../../api/shared/improvementPlan/improvementActionPlanPresentation');
const { acceptedRegistry } = require('../../api/shared/assessmentLifecycle/ncscAssessmentSubmission');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (status, code) => ({ status, body: { code } });
const GENERATION_A = 'a'.repeat(64), GENERATION_B = 'b'.repeat(64);
const BINDING_A = '10000000-0000-4000-8000-000000000001';
const BINDING_B = '10000000-0000-4000-8000-000000000002';
const TENANT_A = 'synthetic-mounted-a', TENANT_B = 'synthetic-mounted-b';
const SELECTED = 'assessment-selected';
const AS_OF = '2026-09-07T09:30:00.000Z';
const DUE_DATE = '2026-09-08';
const BLOCK_REASON = 'Synthetic browser dependency needs review.';
const COMPLETION_NOTE = 'Synthetic workflow finished; the control and evidence remain unverified.';
const COMPLETION_REFERENCE = 'synthetic:completion:browser-record';
const REOPEN_REASON = 'Synthetic reviewer requires another follow-up.';

function literalList(source, expression) {
    const matches = [...source.matchAll(expression)];
    assert.ok(matches.length, 'Expected the existing protected delivery list');
    return matches.map(match => JSON.parse(match[1].replace(/'/g, '"')));
}
function deliveredAssets() {
    const serviceLists = literalList(read('api/shared/dashboardService.js'), /return response\(200,\s*(\[[^\]]+\])\s*\.map/g);
    assert.equal(serviceLists.length, 1);
    const selected = serviceLists[0];
    for (const file of ['server.js', 'scripts/build-static.js']) {
        const lists = literalList(read(file), /protectedAppSource:\s*(\[[^\]]+\])/g);
        assert.equal(lists.length, 2, file + ': both protected document/SRI paths are checked');
        lists.forEach(list => assert.deepEqual(list, selected, file + ': protected bytes match the actual API bundle'));
    }
    for (const required of ['organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']) {
        assert.ok(selected.includes(required), required + ' must be in delivered application bytes');
    }
    return selected.map(file => 'api/shared/protectedAssets/' + file);
}

function submittedVersion(tenant, assessmentId, option) {
    let previous = null;
    for (const command of [createCommand(assessmentId, 'create-' + assessmentId, 'Synthetic selected office and cloud scope.'),
        saveCommand(assessmentId, 0, 'save-' + assessmentId, allResponses(option)),
        submitCommand(assessmentId, 1, 'submit-' + assessmentId)]) {
        previous = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, previous, tenant.state.tenantAggregate, NOW);
    }
    return previous;
}
const fixtures = buildFixtures(), metadata = fixtures.metadata;
const organisationId = fixtures.tenants[0].model.context.organisationId;
const tenant = ncscFixture({ tenantId: TENANT_A, organisationId });
const versions = new Map(['assessment-earlier', SELECTED].map((id, index) =>
    [id, submittedVersion(tenant, id, index ? 'yes' : 'no')]));
const details = new Map([...versions].map(([id, version]) => [id, projectNcscDetail(version)]));
const selectedDetail = details.get(SELECTED);
const selectedSource = { assessmentId: SELECTED, revision: selectedDetail.revision,
    revisionSha256: selectedDetail.revisionSha256, profileRef: selectedDetail.profileRef,
    outputSha256: selectedDetail.submission.evaluation.outputSha256 };
const assessmentHash = hash(JSON.stringify([...versions]));

function newState(capable = true) {
    const model = clone(fixtures.tenants[0].model);
    model.context.displayName = 'Synthetic mounted organisation A';
    model.modules.find(row => row.key === 'improvement_plan').state = capable ? 'ready' : 'planned';
    return { model, generation: GENERATION_A, binding: BINDING_A, tenantId: TENANT_A,
        records: new Map(), receipts: new Map(), requests: [], errors: [], denied: false,
        viewGate: null, editorGate: null, sequence: 0, caseId: '', commandUncertain: false,
        editorCanWrite: true, editorDenied: false, staleEditor: false, conflictNext: false, writeDenied: false };
}
function presentation(record) {
    return projectImprovementActionPlanPresentation(projectImprovementActionList(record, {
        scope: { tenantId: record.tenantId, organisationId: record.organisationId, planId: record.planId },
        asOf: AS_OF, filters: { status: 'all', owner: 'all', overdueOnly: false }
    }));
}
function summary(detail) {
    return Object.fromEntries(['assessmentId', 'moduleId', 'profileRef', 'status', 'revision',
        'revisionSha256', 'createdAt', 'updatedAt', 'progress'].map(key => [key, clone(detail[key])]));
}
function scopedRecords(state) {
    return [...state.records.values()].filter(row => row.tenantId === state.tenantId && row.organisationId === organisationId);
}
function editorProjection(state, record) {
    const plan = getImprovementPlanView(record);
    const candidates = [
        ['assign', { ownerSubjectKey: SUBJECT, dueDate: DUE_DATE }], ['start', {}],
        ['block', { reason: BLOCK_REASON }],
        ['complete', { note: COMPLETION_NOTE, evidenceReference: COMPLETION_REFERENCE }],
        ['reopen', { reason: REOPEN_REASON }]
    ];
    // Synthetic authority says only this active member may be selected. Probe
    // the actual pure domain for transition availability; never duplicate its
    // workflow engine or mutate a record while producing editor metadata.
    const actions = plan.actions.map(action => ({ actionId: action.actionId,
        commands: state.editorCanWrite ? candidates.filter(([type, payload]) => {
            try {
                applyImprovementActionCommand(record, { tenantId: record.tenantId, organisationId, planId: record.planId,
                    evaluationOutputSha256: record.source.evaluationOutputSha256, actorSubjectKey: SUBJECT,
                    at: AS_OF, actionId: action.actionId, operationId: 'synthetic-editor-probe-' + type,
                    expectedRevision: plan.revision, type, payload },
                { tenantId: record.tenantId, organisationId, actorSubjectKey: SUBJECT, eligibleOwnerSubjectKeys: [SUBJECT] });
                return true;
            } catch (error) {
                if (error.statusCode === 409 && /^improvement_/.test(error.code)) return false;
                throw error;
            }
        }).map(([type]) => type) : [] }));
    return { schemaVersion: 1, scope: { tenantId: record.tenantId, organisationId, planId: record.planId },
        planRevision: plan.revision + (state.staleEditor ? 1 : 0), asOf: AS_OF,
        canWrite: state.editorCanWrite, ownerChoices: state.editorCanWrite ? [{ subjectKey: SUBJECT, label: 'Assign to me' }] : [], actions };
}
function action(state, body) {
    const command = normaliseImprovementCommand(body), intent = JSON.stringify(command);
    const key = state.tenantId + ':' + command.operationId;
    const original = state.receipts.get(key);
    if (original) return original.intent === intent ? clone(original.response) : problem(409, 'improvement_operation_conflict');
    let record = state.records.get(command.planId);
    if (command.type === 'generate') {
        assert.equal(command.payload.assessmentId, selectedSource.assessmentId, 'Generate uses the explicit selected assessment');
        assert.equal(command.payload.assessmentRevision, selectedSource.revision, 'Generate uses its exact numeric revision');
        assert.equal(command.payload.assessmentRevisionSha256, selectedSource.revisionSha256, 'Generate uses its exact retained revision hash');
        assert.notEqual(command.planId, command.payload.assessmentId, 'The plan ID is not an assessment-to-plan mapping');
        assert.notEqual(command.operationId, command.planId, 'Plan and operation identities are independent');
        if (record) return problem(409, 'improvement_revision_conflict');
        record = createImprovementPlan({ tenantId: state.tenantId, organisationId, planId: command.planId,
            actorSubjectKey: SUBJECT, createdAt: NOW }, versions.get(SELECTED).envelope.submission.input,
        { registry: acceptedRegistry });
    } else {
        if (!record || record.tenantId !== state.tenantId) return problem(404, 'improvement_not_found');
        if (record.commands.length !== command.expectedRevision) return problem(409, 'improvement_revision_conflict');
        record = applyImprovementActionCommand(record, { tenantId: state.tenantId, organisationId, planId: command.planId,
            evaluationOutputSha256: record.source.evaluationOutputSha256, actorSubjectKey: SUBJECT,
            at: new Date(Date.parse(NOW) + (++state.sequence) * 1000).toISOString(), ...command },
        { tenantId: state.tenantId, organisationId, actorSubjectKey: SUBJECT, eligibleOwnerSubjectKeys: [SUBJECT] });
    }
    state.records.set(record.planId, record);
    const response = { status: 200, body: { schemaVersion: 1, plan: getImprovementPlanView(record) } };
    state.receipts.set(key, { intent, response: clone(response) });
    return response;
}
function assignOwner(state, planId, dueDate = DUE_DATE, operationId = 'synthetic-owner-assignment') {
    const record = state.records.get(planId), plan = getImprovementPlanView(record);
    assert.ok(plan.actions.length);
    const response = action(state, { planId, type: 'assign', operationId,
        expectedRevision: plan.revision, actionId: plan.actions[0].actionId,
        payload: { ownerSubjectKey: SUBJECT, dueDate } });
    assert.equal(response.status, 200);
    return plan.actions[0].actionId;
}
function seedPlan(state, suffix) {
    const planId = 'synthetic-editor-plan-' + suffix;
    const response = action(state, { planId, type: 'generate', operationId: 'synthetic-editor-generate-' + suffix,
        expectedRevision: null, actionId: null, payload: { assessmentId: selectedSource.assessmentId,
            assessmentRevision: selectedSource.revision, assessmentRevisionSha256: selectedSource.revisionSha256 } });
    assert.equal(response.status, 200); return planId;
}
function deferred() {
    let resolve;
    return { promise: new Promise(done => { resolve = done; }), resolve };
}
async function witness(promise, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Missing synthetic witness: ' + label)), 12000);
        })]);
    } finally { clearTimeout(timer); }
}

async function main() {
    const bundleFiles = deliveredAssets();
    const sourceFiles = ['js/dashboard-loader.js', 'app/dashboard.html', 'app/dashboard.css',
        'lib/dashboardDocument.js', 'api/shared/dashboardService.js', 'server.js', 'scripts/build-static.js',
        'scripts/tests/improvement-plan-mounted-browser.cjs', ...bundleFiles];
    const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(read(file))]));
    const fixtureFiles = [...new Set([...Object.keys(require.cache)
        .filter(file => file.startsWith(root + path.sep) && !file.includes(path.sep + 'node_modules' + path.sep))
        .map(file => path.relative(root, file)), 'style.css', 'home.css', 'favicon.svg', 'images/nofrieslogo.png'])].sort();
    const fixtureHashes = () => Object.fromEntries(fixtureFiles.map(file =>
        [file, hash(fs.readFileSync(path.join(root, file)))]));
    const frozenFixtures = fixtureHashes();
    const frozen = hashes(), app = bundleFiles.map(read).join('\n'), css = read('app/dashboard.css');
    const document = buildDashboardDocument({ loaderSource: read('js/dashboard-loader.js'),
        template: read('app/dashboard.html'), protectedAppSource: app, protectedStyleSource: css });
    const staticAssets = { '/style.css': ['text/css', read('style.css')], '/home.css': ['text/css', read('home.css')],
        '/favicon.svg': ['image/svg+xml', read('favicon.svg')],
        '/images/nofrieslogo.png': ['image/png', fs.readFileSync(path.join(root, 'images/nofrieslogo.png'))] };
    const errors = [], blocked = [], results = [], requests = [], gates = new Set();
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-improvement-mounted-browser-'));
    fs.chmodSync(artifacts, 0o700);
    let state = newState(), origin, browser;
    const server = http.createServer(async (request, response) => {
        const fixture = state;
        try {
            const target = new URL(request.url, 'http://127.0.0.1'), pathname = target.pathname;
            const row = { case: fixture.caseId, path: pathname, method: request.method,
                generation: request.headers['x-nofries-dashboard-generation'] === fixture.generation,
                finished: false };
            requests.push(row); fixture.requests.push(row);
            response.on('finish', () => { row.finished = true; });
            let body, type = 'application/json', status = 200;
            if (request.method === 'GET' && pathname === '/dashboard') { body = document.html; type = 'text/html'; }
            else if (request.method === 'GET' && pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
            else if (request.method === 'GET' && pathname === '/api/dashboard/dashboard.css') { body = css; type = 'text/css'; }
            else if (request.method === 'GET' && staticAssets[pathname]) [type, body] = staticAssets[pathname];
            else if (request.method === 'GET' && pathname === '/api/dashboard/session') {
                body = { schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard',
                    generation: fixture.generation, selectedBindingId: fixture.binding,
                    expiresAt: new Date(Date.now() + 3600000).toISOString() };
            } else if (request.method === 'GET' && pathname === '/api/dashboard/organisations') {
                body = { schemaVersion: 1, bindings: [
                    { bindingId: BINDING_A, organisationLabel: 'Synthetic mounted organisation A' },
                    { bindingId: BINDING_B, organisationLabel: 'Synthetic mounted organisation B' }
                ], nextAfterBindingId: null };
            } else {
                assert.equal(row.generation, true, 'Every private synthetic API call uses its current canonical generation');
                if (request.method === 'GET' && pathname === '/api/dashboard/bootstrap') body = fixture.model;
                else if (request.method === 'GET' && pathname === '/api/dashboard/modules/cyber_security') {
                    body = { schemaVersion: 1, context: fixture.model.context, generatedAt: fixture.model.generatedAt,
                        module: fixture.model.modules.find(item => item.key === 'cyber_security'),
                        summary: { state: 'empty', attention: [], metrics: [] }, services: [],
                        admissionGranted: false, providerAccessGranted: false, metadata, presentationMode: 'editable' };
                } else if (request.method === 'GET' && pathname === '/api/dashboard/modules/improvement_plan') {
                    body = { schemaVersion: 1, context: fixture.model.context, generatedAt: fixture.model.generatedAt,
                        module: fixture.model.modules.find(item => item.key === 'improvement_plan'),
                        summary: { state: 'empty', attention: [], metrics: [] }, services: [],
                        admissionGranted: false, providerAccessGranted: false };
                } else if (request.method === 'GET' && pathname === '/api/dashboard/ncsc/assessments') {
                    const values = fixture.tenantId === TENANT_A ? [...details.values()].map(summary) : [];
                    body = { schemaVersion: 1, assessments: values, nextAfterAssessmentId: null };
                } else if (request.method === 'GET' && pathname.startsWith('/api/dashboard/ncsc/assessments/')) {
                    const assessmentId = decodeURIComponent(pathname.slice('/api/dashboard/ncsc/assessments/'.length));
                    assert.ok(details.has(assessmentId)); body = { schemaVersion: 1, assessment: details.get(assessmentId) };
                } else if (request.method === 'GET' && pathname === '/api/dashboard/improvement/plans') {
                    assert.deepEqual([...target.searchParams.keys()].filter(key => !['limit', 'afterPlanId'].includes(key)), []);
                    const limit = Number(target.searchParams.get('limit') || 20), after = target.searchParams.get('afterPlanId');
                    assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50);
                    const records = scopedRecords(fixture).sort((a, b) => a.planId < b.planId ? -1 : 1)
                        .filter(record => after === null || record.planId > after);
                    const plans = records.slice(0, limit).map(record => ({ planId: record.planId, planRevision: record.commands.length }));
                    body = { schemaVersion: 1, scope: { tenantId: fixture.tenantId, organisationId }, asOf: AS_OF,
                        plans, nextAfterPlanId: records.length > plans.length ? plans.at(-1).planId : null };
                    if (fixture.denied) { status = 403; body = { code: 'improvement_list_access_denied' }; }
                } else if (request.method === 'GET' && pathname === '/api/dashboard/improvement/view') {
                    const record = fixture.records.get(target.searchParams.get('planId'));
                    assert.ok(record && record.tenantId === fixture.tenantId);
                    body = presentation(record);
                    if (fixture.viewGate) {
                        const gate = fixture.viewGate; fixture.viewGate = null; gate.arrived.resolve();
                        await gate.release.promise;
                    }
                } else if (request.method === 'GET' && pathname === '/api/dashboard/improvement/editor') {
                    assert.deepEqual([...target.searchParams.keys()], ['planId']);
                    const record = fixture.records.get(target.searchParams.get('planId'));
                    assert.ok(record && record.tenantId === fixture.tenantId);
                    body = editorProjection(fixture, record);
                    if (fixture.editorDenied) { status = 403; body = { code: 'improvement_access_denied' }; }
                    if (fixture.editorGate) {
                        const gate = fixture.editorGate; fixture.editorGate = null; gate.arrived.resolve();
                        await gate.release.promise;
                    }
                } else if (request.method === 'POST' && pathname === '/api/dashboard/improvement/execute') {
                    assert.equal(request.headers.origin, origin, 'Browser mutation stays on its exact loopback origin');
                    assert.match(request.headers['content-type'], /^application\/json(?:;|$)/);
                    let raw = '';
                    for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 16384); }
                    const command = JSON.parse(raw); row.command = clone(command);
                    if (fixture.writeDenied) { status = 403; body = { code: 'improvement_access_denied' }; }
                    else {
                        if (fixture.conflictNext && command.type !== 'generate') {
                            fixture.conflictNext = false;
                            assignOwner(fixture, command.planId, '2026-09-10', 'synthetic-concurrent-assignment');
                        }
                        const result = action(fixture, command); status = result.status; body = result.body;
                        if (fixture.commandUncertain) {
                            fixture.commandUncertain = false;
                            status = 503; body = { code: 'improvement_outcome_ambiguous' };
                        }
                    }
                } else {
                    blocked.push({ path: pathname, method: request.method }); status = 404; body = { code: 'synthetic_route_closed' };
                }
            }
            response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store',
                'Content-Security-Policy': document.contentSecurityPolicy });
            response.end(type === 'application/json' ? JSON.stringify(body) : body);
        } catch (error) {
            fixture.errors.push(error.message); errors.push(error.message);
            if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ code: 'synthetic_fixture_failed' }));
        }
    });
    async function openPage(width, capable, suffix, prepare) {
        state = newState(capable); state.caseId = width + '-' + suffix;
        if (prepare) prepare(state);
        const context = await browser.newContext({ viewport: { width, height: 950 } });
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (message.type() !== 'error') return;
            if (message.text() === 'Failed to load resource: the server responded with a status of 403 (Forbidden)' &&
                ['/api/dashboard/improvement/plans', '/api/dashboard/improvement/editor', '/api/dashboard/improvement/execute']
                    .includes(new URL(message.location().url, origin).pathname)) return;
            if (/Failed to load resource: the server responded with a status of 503/.test(message.text()) &&
                new URL(message.location().url, origin).pathname === '/api/dashboard/improvement/execute') return;
            if (/Failed to load resource: the server responded with a status of 409/.test(message.text()) &&
                new URL(message.location().url, origin).pathname === '/api/dashboard/improvement/execute') return;
            errors.push(message.text());
        });
        page.on('dialog', async dialog => { errors.push('Unexpected browser dialog'); await dialog.dismiss(); });
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== origin || !['GET', 'POST'].includes(request.method()) ||
                request.method() === 'POST' && url.pathname !== '/api/dashboard/improvement/execute') {
                blocked.push({ path: url.pathname, method: request.method() }); return route.abort();
            }
            return route.continue();
        });
        await page.addInitScript(() => {
            window.syntheticViolations = [];
            document.addEventListener('securitypolicyviolation', event => syntheticViolations.push(event.effectiveDirective));
        });
        await page.goto(origin + '/dashboard#overview', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
        await page.getByLabel('Saved assessment', { exact: true }).selectOption(SELECTED);
        await page.locator('.picture-source').filter({ hasText: 'submitted' }).waitFor();
        assert.equal(await page.getByLabel('Saved assessment', { exact: true }).inputValue(), SELECTED);
        return { context, page, fixture: state };
    }
    async function navigate(page, key) {
        let link = page.locator('a[data-module="' + key + '"]:visible').first();
        if (!await link.count()) {
            const menus = page.locator('nav:visible details.dashboard-menu-other');
            if (await menus.count()) {
                const summary = menus.first().locator(':scope > summary'); await summary.focus(); await page.keyboard.press('Enter');
            }
            link = page.locator('a[data-module="' + key + '"]:visible').first();
        }
        await link.focus(); await page.keyboard.press('Enter');
    }
    async function reviewAndOpen(page) {
        const review = page.getByRole('button', { name: 'Review supporting-evidence gaps', exact: true });
        await review.focus(); await page.keyboard.press('Enter');
        const category = page.locator('.picture-follow-up > details').filter({ has: page.locator('summary', { hasText: /^Supporting-evidence gaps/ }) });
        assert.equal(await category.evaluate(node => node.open), true, 'The existing saved-gap category opens');
        assert.equal(await category.locator(':scope > summary').evaluate(node => node === document.activeElement), true,
            'Keyboard gap action focuses its existing category summary');
        assert.ok(await category.locator('article:visible').count());
        const plan = page.getByRole('button', { name: 'Plan improvements for this assessment', exact: true });
        await plan.focus(); await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: 'Improvement Plan', exact: true }).waitFor();
        await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).waitFor();
    }
    const editorSection = page => page.locator('section[aria-label="Update an improvement action"]');
    const updateForm = page => page.getByRole('form', { name: 'Improvement action update', exact: true });
    const openerLabels = { assign: 'Assign to me', start: 'Start action', block: 'Block action',
        complete: 'Complete action', reopen: 'Reopen action' };
    const submitLabels = { assign: 'Save assignment', start: 'Start action', block: 'Record block',
        complete: 'Record completion', reopen: 'Reopen action' };
    async function createFromUi(run) {
        await reviewAndOpen(run.page);
        await run.page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true }).click();
        await run.page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
        assert.equal(run.fixture.records.size, 1);
        await editorSection(run.page).waitFor();
        return [...run.fixture.records.keys()][0];
    }
    async function chooseAction(page, actionId) {
        const picker = editorSection(page).getByRole('combobox', { name: 'Improvement action', exact: true });
        await picker.waitFor();
        const available = await picker.locator('option').evaluateAll(rows => rows.map(row => ({ value: row.value, label: row.label })));
        const selected = actionId || available.find(row => row.value)?.value;
        assert.ok(selected && available.some(row => row.value === selected), 'Use only an action offered by the current server editor response');
        await picker.selectOption(selected);
        assert.equal((await editorSection(page).innerText()).includes(SUBJECT), false,
            'The editor offers the canonical self label without displaying raw owner identity or invented people');
        assert.equal(await editorSection(page).getByLabel('Owner ID', { exact: true }).count(), 0);
        return selected;
    }
    async function openAction(page, type) {
        const control = editorSection(page).getByRole('button', { name: openerLabels[type], exact: true });
        await control.focus(); await page.keyboard.press('Enter');
        const form = updateForm(page); await form.waitFor(); return form;
    }
    async function submitAction(page, type) {
        const submit = updateForm(page).getByRole('button', { name: submitLabels[type], exact: true });
        assert.equal(await submit.isEnabled(), true, 'A fresh current editor context permits the explicit submit');
        await submit.focus(); await page.keyboard.press('Enter');
    }
    async function waitRevision(page, revision) {
        await page.waitForFunction(value => {
            const terms = [...document.querySelectorAll('[aria-label="Improvement action plan"] dt')];
            const term = terms.find(node => node.textContent === 'Plan revision');
            const editor = document.querySelector('section[aria-label="Update an improvement action"]');
            return term?.nextElementSibling?.textContent === String(value) &&
                editor && [...editor.querySelectorAll('button')].some(button => !button.disabled);
        }, revision);
    }
    async function fillAssignment(page, dueDate) {
        const form = await openAction(page, 'assign');
        const due = form.getByLabel('Due date (UTC)', { exact: true });
        assert.equal(await due.evaluate(node => node === document.activeElement), true, 'Assignment opens on its labelled UTC date field');
        await due.fill(dueDate); return form;
    }
    async function selectSaved(page, planId) {
        await navigate(page, 'improvement_plan');
        await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).waitFor();
        const selected = page.getByRole('combobox', { name: 'Saved improvement plans', exact: true });
        if (await selected.inputValue() !== planId) await selected.selectOption(planId);
        await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
    }
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [320, 390, 1280]) {
            let run = await openPage(width, true, 'journey');
            try {
                const { page, fixture } = run;
                const metrics = await page.locator('.picture-metrics').textContent();
                await reviewAndOpen(page);
                assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 0, 'Opening the plan never creates one automatically');
                const create = page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true });
                // Visibility precedes the async saved-plan read. Keyboard Enter
                // has no actionability wait and is ignored while Create is disabled.
                await page.waitForFunction(() => [...document.querySelectorAll('button')]
                    .some(button => button.textContent === 'Create improvement plan for this assessment' && !button.disabled));
                await create.focus(); await page.keyboard.press('Enter');
                await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
                assert.equal(fixture.records.size, 1);
                const [planId] = fixture.records.keys();
                assert.equal(await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).inputValue(), planId);
                assert.ok(await page.locator('[aria-label="Improvement action plan"] article').count());
                await page.locator('[aria-label="Improvement action plan"] summary')
                    .filter({ hasText: /^Source and plan metadata$/ }).click();
                const rendered = await page.locator('[aria-label="Improvement action plan"]').innerText();
                assert.ok(rendered.includes(SELECTED));
                assert.ok(rendered.includes(selectedSource.outputSha256));
                assert.match(rendered, /Risk priority has not been calculated/);
                assert.match(rendered, /unverified[\s\S]*scores are unchanged/);
                const picker = page.getByRole('combobox', { name: 'Saved improvement plans', exact: true });
                await picker.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
                await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
                assert.equal(await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true })
                    .evaluate(node => node === document.activeElement), true, 'Saved-plan selection preserves native keyboard focus');
                assignOwner(fixture, planId);
                const refresh = page.getByRole('button', { name: 'Refresh improvement plan', exact: true });
                await refresh.focus(); await page.keyboard.press('Enter');
                await page.waitForFunction(date => document.querySelector('[aria-label="Improvement action plan"]')?.textContent.includes(date), DUE_DATE);
                assert.equal(await page.getByRole('button', { name: 'Refresh improvement plan', exact: true })
                    .evaluate(node => node === document.activeElement), true, 'Retained refresh preserves native keyboard focus');
                const assigned = page.locator('[aria-label="Improvement action plan"] article').filter({ hasText: DUE_DATE }).first();
                await assigned.locator('summary').filter({ hasText: /^Action identifiers$/ }).click();
                await assigned.locator('summary').filter({ hasText: /^Action history \(1 events\)$/ }).click();
                const refreshed = await page.locator('[aria-label="Improvement action plan"]').innerText();
                assert.match(refreshed, /Assigned \(eligibility not checked\)/);
                assert.ok(refreshed.includes('Assigned'));
                assert.ok(refreshed.includes(SUBJECT));
                assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 1, 'Browser made only the intentional generation command');
                assert.equal(hash(JSON.stringify([...versions])), assessmentHash, 'Workflow updates do not change the saved assessment');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ': plan does not overflow');
                await navigate(page, 'overview');
                await page.locator('.picture-metrics').waitFor();
                assert.equal(await page.getByLabel('Saved assessment', { exact: true }).inputValue(), SELECTED);
                assert.equal(await page.locator('.picture-metrics').textContent(), metrics, 'Saved score and evidence measures stay unchanged');
                await reviewAndOpen(page);
                await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).selectOption(planId);
                await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
                const arrived = deferred(), release = deferred(), gate = { arrived, release };
                gates.add(gate); fixture.viewGate = gate;
                await page.getByRole('button', { name: 'Refresh improvement plan', exact: true }).click();
                await witness(arrived.promise, 'late view after navigation');
                await navigate(page, 'services');
                await page.getByRole('heading', { name: 'Services', exact: true }).waitFor();
                release.resolve(); await page.waitForLoadState('networkidle');
                assert.equal(await page.locator('[aria-label="Improvement action plan"]').count(), 0, 'Destroyed view cannot return after its delayed response');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ': navigation does not overflow');
                assert.deepEqual(await page.evaluate(() => window.syntheticViolations), []);
                results.push({ width, case: 'saved-gap-to-plan', exactSelectedSource: true, intentionalGenerate: true,
                    retainedOwnerRefresh: true, noScoreEffect: true, keyboardGapFocus: true, staleAfterTeardown: 'inert', overflow: 'none' });
            } finally {
                if (run.fixture.viewGate) run.fixture.viewGate.release.resolve();
                await run.context.close();
            }

            run = await openPage(width, false, 'no-capability');
            try {
                assert.equal(await run.page.getByRole('button', { name: 'Plan improvements for this assessment', exact: true }).count(), 0);
                assert.equal(await run.page.getByRole('button', { name: 'Review supporting-evidence gaps', exact: true }).count(), 1,
                    'Saved gap review remains usable without the new action tables or Improvement capability');
                assert.equal(run.fixture.requests.filter(row => row.path.startsWith('/api/dashboard/improvement/')).length, 0);
                results.push({ width, case: 'no-capability', noPlanButton: true, savedGapsAvailable: true, improvementRequests: 0 });
            } finally { await run.context.close(); }

            run = await openPage(width, true, 'denial');
            try {
                run.fixture.denied = true;
                const plan = run.page.getByRole('button', { name: 'Plan improvements for this assessment', exact: true });
                await plan.click();
                await run.page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
                assert.equal(await run.page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
                assert.equal(await run.page.locator('[aria-label="Improvement action plan"]').count(), 0);
                assert.equal(run.fixture.requests.filter(row => row.method === 'POST').length, 0);
                results.push({ width, case: 'denial', disclosureCleared: true, writes: 0 });
            } finally { await run.context.close(); }
        }
        const run = await openPage(390, true, 'generation-change');
        try {
            const { page, fixture } = run;
            await reviewAndOpen(page);
            await page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true }).click();
            await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
            const arrived = deferred(), release = deferred(), gate = { arrived, release };
            gates.add(gate); fixture.viewGate = gate;
            await page.getByRole('button', { name: 'Refresh improvement plan', exact: true }).click();
            await witness(arrived.promise, 'old-generation retained view');
            fixture.generation = GENERATION_B; fixture.binding = BINDING_B; fixture.tenantId = TENANT_B;
            fixture.model.context.displayName = 'Synthetic mounted organisation B';
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready' &&
                document.querySelector('.dashboard-topbar')?.textContent.includes('Synthetic mounted organisation B') &&
                document.querySelector('select[aria-label="Saved improvement plans"]')?.options.length === 1);
            release.resolve(); await page.waitForLoadState('networkidle');
            assert.equal(await page.locator('[aria-label="Improvement action plan"]').count(), 0,
                'A response from the old same-organisation-ID tenant cannot appear after selection/generation changes');
            assert.equal(await page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true }).count(), 0,
                'The old selected assessment callback is not retained across authority cycles');
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 1);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(await page.evaluate(() => window.syntheticViolations), []);
            results.push({ width: 390, case: 'generation-change', sameOrganisationIdDifferentTenant: true,
                oldResponse: 'inert', oldAssessmentSelection: 'cleared', implicitWrites: 0 });
        } finally { await run.context.close(); }
        const pendingRun = await openPage(390, true, 'pending-command');
        try {
            const { page, fixture } = pendingRun;
            await reviewAndOpen(page); fixture.commandUncertain = true;
            await page.getByRole('button', { name: 'Create improvement plan for this assessment', exact: true }).click();
            const retry = page.getByRole('button', { name: 'Retry pending improvement command', exact: true });
            await retry.waitFor();
            assert.equal(fixture.records.size, 1, 'The first synthetic generation committed before its acknowledgement was lost');
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 1, 'An ambiguous response does not automatically repeat the command');
            await navigate(page, 'services');
            assert.equal(await page.locator('#dashboard-content > header h1').innerText(), 'Improvement Plan');
            await page.locator('#dashboardAccountMenu > summary').focus(); await page.keyboard.press('Enter');
            await page.locator('#dashboardSignOut').click();
            assert.equal(await retry.isVisible(), true, 'Logout respects the pending child leave lifecycle');
            await page.locator('#dashboardChooser > summary').click();
            await page.locator('#dashboardChoices [data-binding-id="' + BINDING_B + '"]').click();
            assert.equal(await retry.isVisible(), true, 'Organisation selection respects the pending child leave lifecycle');
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 1);
            await retry.click();
            await page.getByRole('heading', { name: 'Improvement action plan', exact: true }).waitFor();
            const posts = fixture.requests.filter(row => row.method === 'POST');
            assert.equal(posts.length, 2); assert.deepEqual(posts[1].command, posts[0].command,
                'Explicit reconciliation retries retain exactly the same command identity and payload');
            assert.equal(fixture.records.size, 1);
            assert.equal(await retry.count(), 0);
            results.push({ width: 390, case: 'pending-command', ambiguousCommit: true,
                inAppLeave: 'blocked', logout: 'blocked', organisationSelection: 'blocked', explicitRetrySameIdentity: true,
                retainedPlans: 1, automaticRetries: 0 });
        } finally { await pendingRun.context.close(); }

        // These successors are editing acceptance: every accepted transition is
        // submitted by an actual form click, rather than fixture-side mutation.
        for (const width of [320, 390, 1280]) {
            const run = await openPage(width, true, 'action-forms');
            try {
                const { page, fixture } = run, metrics = await page.locator('.picture-metrics').textContent();
                const planId = await createFromUi(run), actionId = await chooseAction(page);
                const postCount = () => fixture.requests.filter(row => row.method === 'POST').length;
                await fillAssignment(page, '2026-09-12');
                const beforeCancel = postCount();
                await updateForm(page).getByRole('button', { name: 'Cancel changes', exact: true }).click();
                assert.equal(postCount(), beforeCancel, 'Cancelling a form sends no command');
                assert.equal(fixture.records.get(planId).commands.length, 0);
                assert.equal(await updateForm(page).count(), 0);
                assert.equal(await editorSection(page).getByRole('combobox', { name: 'Improvement action', exact: true })
                    .evaluate(node => node === document.activeElement), true, 'Cancel returns focus to the durable action picker');

                await fillAssignment(page, DUE_DATE); await submitAction(page, 'assign'); await waitRevision(page, 1);
                let record = fixture.records.get(planId);
                assert.deepEqual(record.commands[0].payload, { ownerSubjectKey: SUBJECT, dueDate: DUE_DATE });
                assert.equal(getImprovementPlanView(record).actions.find(action => action.actionId === actionId).ownerSubjectKey, SUBJECT);
                let form = await openAction(page, 'start');
                assert.equal(await form.getByRole('button', { name: 'Start action', exact: true })
                    .evaluate(node => node === document.activeElement), true, 'A fieldless start form focuses its submit control');
                await submitAction(page, 'start'); await waitRevision(page, 2);
                form = await openAction(page, 'block');
                const block = form.getByLabel('Block reason', { exact: true });
                assert.equal(await block.evaluate(node => node === document.activeElement), true);
                const beforeInvalid = postCount();
                await block.fill('   '); await submitAction(page, 'block');
                assert.equal(await block.getAttribute('aria-invalid'), 'true');
                assert.equal(await block.evaluate(node => node === document.activeElement), true);
                assert.equal(await block.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')).hidden), false);
                assert.equal(await block.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')).textContent),
                    'Enter a block reason of up to 1000 characters using plain text, then save again.');
                assert.ok((await page.getByRole('status').allTextContents())
                    .includes('Enter a block reason of up to 1000 characters using plain text, then save again.'));
                assert.equal(await block.inputValue(), '   ');
                assert.equal(postCount(), beforeInvalid, 'Invalid reason sends no command');
                await block.fill(BLOCK_REASON); await submitAction(page, 'block'); await waitRevision(page, 3);
                form = await openAction(page, 'complete');
                const note = form.getByLabel('Completion note', { exact: true });
                assert.equal(await note.evaluate(node => node === document.activeElement), true);
                await note.fill(COMPLETION_NOTE);
                const reference = form.getByLabel('Completion evidence reference (unverified)', { exact: true });
                await reference.fill('https://forbidden.invalid/evidence'); await submitAction(page, 'complete');
                assert.equal(await reference.getAttribute('aria-invalid'), 'true');
                assert.equal(await reference.evaluate(node => node === document.activeElement), true);
                assert.equal(await reference.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')).hidden), false);
                assert.equal(await reference.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')).textContent),
                    'Enter an unverified record ID of up to 180 characters without surrounding spaces. URLs and file paths cannot be used.');
                assert.ok((await page.getByRole('status').allTextContents())
                    .includes('Enter an unverified record ID of up to 180 characters without surrounding spaces. URLs and file paths cannot be used.'));
                assert.equal(await note.inputValue(), COMPLETION_NOTE);
                assert.equal(await reference.inputValue(), 'https://forbidden.invalid/evidence');
                assert.equal(postCount(), beforeInvalid + 1, 'Invalid evidence reference sends no command');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ': validation guidance fits');
                if (width === 390) await page.screenshot({ path: path.join(artifacts, '390-invalid-evidence-reference.png') });
                await reference.fill(COMPLETION_REFERENCE);
                if (width === 390) await page.screenshot({ path: path.join(artifacts, '390-completion-form.png') });
                await submitAction(page, 'complete'); await waitRevision(page, 4);
                record = fixture.records.get(planId);
                const completed = getImprovementPlanView(record).actions.find(action => action.actionId === actionId);
                assert.equal(completed.status, 'completed');
                assert.equal(completed.completion.evidenceVerification, 'not_verified');
                assert.equal(completed.completion.evidenceReference, COMPLETION_REFERENCE);
                form = await openAction(page, 'reopen');
                const reason = form.getByLabel('Reopen reason', { exact: true });
                assert.equal(await reason.evaluate(node => node === document.activeElement), true);
                await reason.fill(REOPEN_REASON); await submitAction(page, 'reopen'); await waitRevision(page, 5);
                record = fixture.records.get(planId);
                assert.deepEqual(record.commands.map(row => row.type), ['assign', 'start', 'block', 'complete', 'reopen']);
                assert.deepEqual(record.commands.map(row => row.expectedRevision), [0, 1, 2, 3, 4]);
                assert.ok(record.commands.every(row => row.actionId === actionId && row.planId === planId));
                const reopened = getImprovementPlanView(record).actions.find(action => action.actionId === actionId);
                assert.equal(reopened.status, 'open'); assert.equal(reopened.completion, null);
                const posts = fixture.requests.filter(row => row.method === 'POST').map(row => row.command);
                assert.deepEqual(posts.map(row => row.type), ['generate', 'assign', 'start', 'block', 'complete', 'reopen']);
                assert.equal(new Set(posts.map(row => row.operationId)).size, 6, 'Each explicit new intent has its own operation identity');
                assert.deepEqual(posts.slice(1).map(row => row.payload), [
                    { ownerSubjectKey: SUBJECT, dueDate: DUE_DATE }, {}, { reason: BLOCK_REASON },
                    { note: COMPLETION_NOTE, evidenceReference: COMPLETION_REFERENCE }, { reason: REOPEN_REASON }
                ]);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ': forms and retained view fit');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
                await waitRevision(page, 5);
                assert.equal(await page.getByRole('combobox', { name: 'Saved improvement plans', exact: true }).inputValue(), planId);
                const card = page.locator('[aria-label="Improvement action plan"] article').filter({ hasText: actionId });
                assert.equal(await card.count(), 1);
                await card.locator('summary').filter({ hasText: /^Action history \(5 events\)$/ }).click();
                const history = await card.innerText();
                for (const value of ['Assigned', 'Started', 'Blocked', 'Completed', 'Reopened',
                    BLOCK_REASON, COMPLETION_NOTE, COMPLETION_REFERENCE, REOPEN_REASON]) assert.ok(history.includes(value), value + ' survives browser reload');
                assert.match(history, /unverified|not verified/i);
                if (width === 390) await page.screenshot({ path: path.join(artifacts, '390-retained-history.png') });
                assert.equal(postCount(), 6, 'Reload only reads the already retained workflow');
                assert.equal(hash(JSON.stringify([...versions])), assessmentHash);
                await navigate(page, 'overview'); await page.locator('.picture-metrics').waitFor();
                await page.getByLabel('Saved assessment', { exact: true }).selectOption(SELECTED);
                await page.locator('.picture-metrics').waitFor();
                assert.equal(await page.locator('.picture-metrics').textContent(), metrics);
                assert.deepEqual(await page.evaluate(() => window.syntheticViolations), []);
                results.push({ width, case: 'actual-action-forms', commandsFromBrowser: ['assign', 'start', 'block', 'complete', 'reopen'],
                    revisions: [1, 2, 3, 4, 5], canonicalSelfOnly: true, cancelWrites: 0, keyboardFocus: true,
                    invalidFieldFocus: true, invalidFieldWrites: 0, correctionRetainsDraft: true,
                    reloadRetainsHistory: true, completionEvidence: 'not_verified', scoreEffect: 'none', overflow: 'none' });
            } finally { await run.context.close(); }
        }

        let editRun = await openPage(390, true, 'read-only-editor', fixture => {
            seedPlan(fixture, 'read-only'); fixture.editorCanWrite = false;
        });
        try {
            const { page, fixture } = editRun;
            await selectSaved(page, [...fixture.records.keys()][0]);
            await page.waitForLoadState('networkidle');
            assert.ok(await page.locator('[aria-label="Improvement action plan"] article').count());
            assert.equal(await updateForm(page).count(), 0);
            for (const name of Object.values(openerLabels)) assert.equal(await editorSection(page).getByRole('button', { name, exact: true }).count(), 0);
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 0);
            results.push({ width: 390, case: 'read-only-editor', syntheticGrant: 'read-only advisor',
                savedViewAvailable: true, inferredWrites: 0, mutationControls: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'stale-editor', fixture => { seedPlan(fixture, 'stale'); fixture.staleEditor = true; });
        try {
            const { page, fixture } = editRun;
            await navigate(page, 'improvement_plan');
            await page.waitForLoadState('networkidle');
            assert.ok(fixture.requests.some(row => row.path === '/api/dashboard/improvement/editor'));
            assert.equal(await updateForm(page).count(), 0);
            for (const name of Object.values(openerLabels)) assert.equal(await editorSection(page).getByRole('button', { name, exact: true }).count(), 0);
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 0);
            results.push({ width: 390, case: 'stale-editor', revisionMismatch: 'withheld', writes: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'editor-denial', fixture => { seedPlan(fixture, 'denied'); fixture.editorDenied = true; });
        try {
            const { page, fixture } = editRun;
            await navigate(page, 'improvement_plan');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 0);
            results.push({ width: 390, case: 'editor-denial', disclosureCleared: true, writes: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'write-denial');
        try {
            const { page, fixture } = editRun;
            const planId = await createFromUi(editRun); await chooseAction(page);
            await fillAssignment(page, DUE_DATE); fixture.writeDenied = true; await submitAction(page, 'assign');
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'denied');
            assert.equal(await page.locator('#dashboardApp').evaluate(node => node.children.length), 0);
            assert.equal(fixture.records.get(planId).commands.length, 0);
            results.push({ width: 390, case: 'write-denial', commandRejected: true, disclosureCleared: true, retainedMutationCount: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'revision-conflict');
        try {
            const { page, fixture } = editRun;
            const planId = await createFromUi(editRun), actionId = await chooseAction(page);
            await fillAssignment(page, DUE_DATE);
            fixture.conflictNext = true;
            const beforeReads = fixture.requests.filter(row => ['/api/dashboard/improvement/view', '/api/dashboard/improvement/editor'].includes(row.path)).length;
            await submitAction(page, 'assign');
            await editorSection(page).getByText('Plan changed; cancel these changes and refresh.', { exact: true }).waitFor();
            const form = updateForm(page);
            assert.equal(await form.getByLabel('Due date (UTC)', { exact: true }).inputValue(), DUE_DATE, '409 preserves the user draft for review');
            assert.equal(await form.getByRole('button', { name: 'Save assignment', exact: true }).isDisabled(), true);
            assert.equal(fixture.requests.filter(row => ['/api/dashboard/improvement/view', '/api/dashboard/improvement/editor'].includes(row.path)).length,
                beforeReads, '409 performs no hidden read/rebase/resubmit');
            await navigate(page, 'services');
            assert.equal(await page.locator('#dashboard-content > header h1').innerText(), 'Improvement Plan');
            await form.getByRole('button', { name: 'Cancel changes', exact: true }).click();
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 2);
            await page.getByRole('button', { name: 'Refresh improvement plan', exact: true }).click();
            await waitRevision(page, 1); await chooseAction(page, actionId);
            assert.ok((await page.locator('[aria-label="Improvement action plan"]').innerText()).includes('2026-09-10'));
            await fillAssignment(page, DUE_DATE); await submitAction(page, 'assign'); await waitRevision(page, 2);
            const posts = fixture.requests.filter(row => row.method === 'POST').map(row => row.command);
            assert.equal(posts.length, 3); assert.equal(posts[1].expectedRevision, 0); assert.equal(posts[2].expectedRevision, 1);
            assert.notEqual(posts[2].operationId, posts[1].operationId, 'A manually confirmed fresh intent has a new operation identity');
            assert.equal(fixture.records.get(planId).commands.length, 2);
            results.push({ width: 390, case: 'revision-conflict', preservedDraft: true, staleSubmit: 'disabled', hiddenReads: 0,
                explicitCancelAndRefresh: true, freshManualRevision: 2, automaticRetries: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'uncertain-assignment');
        try {
            const { page, fixture } = editRun;
            const planId = await createFromUi(editRun); await chooseAction(page);
            await fillAssignment(page, DUE_DATE); fixture.commandUncertain = true; await submitAction(page, 'assign');
            const retry = page.getByRole('button', { name: 'Retry pending improvement command', exact: true }); await retry.waitFor();
            assert.equal(await updateForm(page).getByRole('button', { name: 'Cancel changes', exact: true }).isDisabled(), true,
                'An unknown write outcome cannot be discarded as a clean cancellation');
            assert.equal(await updateForm(page).getByLabel('Due date (UTC)', { exact: true }).isDisabled(), true);
            await navigate(page, 'services');
            assert.equal(await page.locator('#dashboard-content > header h1').innerText(), 'Improvement Plan');
            const pendingPosts = fixture.requests.filter(row => row.method === 'POST');
            assert.equal(pendingPosts.length, 2); assert.equal(fixture.records.get(planId).commands.length, 1);
            await retry.click(); await waitRevision(page, 1);
            const posts = fixture.requests.filter(row => row.method === 'POST').map(row => row.command);
            assert.equal(posts.length, 3); assert.deepEqual(posts[2], posts[1]);
            assert.equal(fixture.records.get(planId).commands.length, 1, 'The reconciled assignment remains exactly one retained event');
            results.push({ width: 390, case: 'uncertain-assignment', committedBeforeLostAck: true,
                discardAndEdit: 'disabled', explicitRetrySameIdentity: true, retainedEvents: 1, automaticRetries: 0 });
        } finally { await editRun.context.close(); }

        editRun = await openPage(390, true, 'late-editor');
        try {
            const { page, fixture } = editRun;
            await createFromUi(editRun); await chooseAction(page);
            const oldEditor = await editorSection(page).elementHandle();
            const arrived = deferred(), release = deferred(), gate = { arrived, release };
            gates.add(gate); fixture.editorGate = gate;
            await page.getByRole('button', { name: 'Refresh improvement plan', exact: true }).click();
            await witness(arrived.promise, 'old-generation editor authority');
            fixture.generation = GENERATION_B; fixture.binding = BINDING_B; fixture.tenantId = TENANT_B;
            fixture.model.context.displayName = 'Synthetic mounted organisation B';
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready' &&
                document.querySelector('.dashboard-topbar')?.textContent.includes('Synthetic mounted organisation B') &&
                document.querySelector('select[aria-label="Saved improvement plans"]')?.options.length === 1);
            release.resolve(); await page.waitForLoadState('networkidle');
            assert.equal(await oldEditor.evaluate(node => node.isConnected), false, 'The old tenant editor is destroyed');
            assert.equal(await editorSection(page).isHidden(), true, 'The fresh tenant has no retained plan or editor authority');
            assert.equal(await editorSection(page).locator('option').count(), 0);
            assert.equal(await editorSection(page).locator('button:visible').count(), 0);
            assert.equal(await updateForm(page).count(), 0);
            assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 1);
            results.push({ width: 390, case: 'late-editor', sameOrganisationIdDifferentTenant: true,
                oldAuthority: 'inert', staleForms: 0, implicitWrites: 0 });
        } finally { await editRun.context.close(); }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(hashes(), frozen,
            'Browser verification must finish on the same source bytes it started with');
        assert.deepEqual(fixtureHashes(), frozenFixtures, 'Canonical fixture/domain inputs remain on the same bytes');
        assert.equal(hash(JSON.stringify([...versions])), assessmentHash);
        const result = { passed: true, synthetic: true, authenticatedAcceptance: false, browser: browser.version(),
            results, sourceHashes: frozen, fixtureSourceHashes: frozenFixtures,
            screenshots: ['390-completion-form.png', '390-invalid-evidence-reference.png', '390-retained-history.png'], errors, blocked, requests };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ passed: results.length, artifacts, requests: requests.length,
            browser: browser.version(), externalRequests: 0, pageErrors: 0, liveAcceptance: false }));
    } catch (error) {
        fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ error: error.message,
            results, sourceHashes: frozen, fixtureSourceHashes: frozenFixtures,
            errors, blocked, requests }, null, 2) + '\n', { mode: 0o600 });
        throw error;
    } finally {
        for (const gate of gates) gate.release.resolve();
        if (state.viewGate) state.viewGate.release.resolve();
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
