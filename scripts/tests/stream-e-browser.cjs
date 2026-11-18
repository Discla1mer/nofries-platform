'use strict';
// Real production documents, client, shell, questionnaire and CSS at 375px.
// Only loopback synthetic fixtures; no identity provider or real acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { deferredFixture, DATA, AT } = require('../../test/fixtures/deferredDetailsFixture');
const { representativeDetails } = require('../../api/shared/customerSignup/deferredRepresentativeDetails');
const root = path.resolve(__dirname, '../..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const artifacts = path.resolve(process.env.NOFRIES_STREAM_E_ARTIFACTS || '/tmp/stream-e-browser');
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep)); fs.mkdirSync(artifacts, { recursive: true });
const app = ['dashboardRegistry.js','dashboardShell.js','ncscAssessmentClient.js','ncscQuestionnaire.js','assessmentExplanation.js',
    'organisationPicture.js','improvementActionPlanView.js','improvementActionPlanClient.js'].map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const signup = buildSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js'), customerLogin: true, customerTransport: 'external' });
const dashboard = buildDashboardDocument({ template: read('app/dashboard.html'), customerLogin: true, customerTransport: 'auto',
    loaderSource: read('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: read('app/dashboard.css') });
const fixtures = buildFixtures(), seed = fixtures.tenants[0], model = seed.model;
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');
const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: model.context.organisationId });
let version = null;
for (const command of [createCommand('assessment-submitted', 'fixture-create', 'Synthetic office and cloud services.'),
    saveCommand('assessment-submitted', 0, 'fixture-save', allResponses('no')), submitCommand('assessment-submitted', 1, 'fixture-submit')]) {
    version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId, action: command.action,
        expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
}
seed.assessments[2] = projectNcscDetail(version);
const transport = createSyntheticTransport({ ...seed, assessments: [] }, fixtures.metadata, fixtures);
let enabled = true, phase = 'setup_details', showResult = false, evidence = null, loseSave = false, audits = 0, writes = 0;
const blocked = [], errors = [], captures = [], requests = [];
(async () => {
    const f = await deferredFixture(), before = JSON.stringify([f.saved, f.receipt, f.activation]);
    const deps = { context: f.context, clock: () => AT, audit: { createEvent: (_, x) => x, writeEvent: async () => { audits++; } },
        database: { async withTenantTransaction(_, work) { return work({ async query(sql, args) {
            if (sql.includes('FROM nofries.dashboard_starter_scopes')) return { rows: [{ preparation: f.preparation, activation: f.activation }] };
            if (sql.includes('FROM nofries.signup_acceptance_receipts')) return { rows: [{ payload: { receipt: f.receipt } }] };
            if (sql.includes('SELECT payload, payload_sha256')) return { rows: evidence ? [evidence] : [] };
            if (sql.includes('SELECT EXISTS')) return { rows: [{ found: showResult }] };
            if (sql.includes('INSERT INTO nofries.dashboard_representative_details')) {
                if (evidence) return { rowCount: 0 };
                evidence = { payload: JSON.parse(args[4]), payload_sha256: args[5] }; writes++; return { rowCount: 1 };
            }
            throw new Error('Unexpected fixture SQL');
        } }); } } };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
        requests.push(req.method + ' ' + pathname);
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = raw ? JSON.parse(raw) : undefined;
        let body, type = 'application/json', status = 200;
        const doc = pathname === '/signup' ? signup : pathname === '/dashboard' ? dashboard : null;
        if (doc) { body = doc.html; type = 'text/html'; res.setHeader('Content-Security-Policy', doc.contentSecurityPolicy); }
        else if (pathname.startsWith('/api/external-customer-signup/')) {
            if (pathname.endsWith('/setup')) {
                assert.equal(input.organisationName, 'Synthetic Workshop');
                assert.deepEqual(input.details, { authorityConfirmed: true }); await f.setup.save(f.proof, input.details); phase = 'terms';
            }
            if (pathname.endsWith('/terms')) { assert.equal(input.accepted, true); phase = 'continue_to_dashboard'; }
            const state = phase === 'setup_details' ? { status: phase, email: 'synthetic@example.test', ...(enabled ? { deferredDetails: true } : {}) }
                : phase === 'terms' ? { status: 'terms', termsText: 'SYNTHETIC LOCAL FIXTURE. No real agreement is accepted by this browser test.',
                    termsVersion: 'synthetic-local-only', termsDigest: 'b'.repeat(64), ...f.saved.offer.schedule }
                    : { status: phase, accountType: 'company' };
            delete state.schemaVersion;
            body = { state, ...(['setup_details', 'terms'].includes(phase) ? { csrfToken: 's'.repeat(43) } : {}) };
        } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'text/javascript'; }
        else if (pathname === '/api/dashboard/dashboard.css') { body = read('app/dashboard.css'); type = 'text/css'; }
        else if (pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'company',
            representativeDetailsAvailable: true, generation: 'a'.repeat(64), selectedBindingId: f.preparation.slot.bindingId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
        else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1, bindings: [{ bindingId: f.preparation.slot.bindingId,
            organisationLabel: model.context.displayName }], nextAfterBindingId: null };
        else if (pathname === '/api/dashboard/bootstrap') body = model;
        else if (['/api/dashboard/modules/cyber_security', '/api/dashboard/modules/overview'].includes(pathname)) body = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
            module: model.modules.find(item => item.key === pathname.split('/').pop()), summary: model.summary, services: model.services,
            admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
        else if (pathname === '/api/dashboard/representative-details') {
            body = await representativeDetails(deps, input);
            if (input && loseSave) { loseSave = false; status = 503; body = { code: 'synthetic_response_unconfirmed' }; }
        } else if (pathname.startsWith('/api/dashboard/ncsc/assessments')) {
            if (showResult) {
                const record = seed.assessments[2];
                body = pathname.endsWith('/' + record.assessmentId) ? { schemaVersion: 1, assessment: record } : { schemaVersion: 1,
                    assessments: [Object.fromEntries(['assessmentId','moduleId','profileRef','status','revision','revisionSha256','createdAt','updatedAt','progress'].map(k => [k, record[k]]))], nextAfterAssessmentId: null };
            } else {
                const result = await transport.fetch(req.url, { method: req.method, ...(raw ? { body: raw } : {}) });
                status = result.status; body = JSON.parse(await result.text());
            }
        } else if (pathname === '/api/enquiry') body = { available: true };
        else if (/^\/(?:style.css|home.css|favicon.svg|favicon.ico|apple-touch-icon.png|images\/[\w.-]+|assets\/fonts\/[\w.-]+)$/.test(pathname) && fs.existsSync(path.join(root, pathname))) {
            body = fs.readFileSync(path.join(root, pathname)); type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.woff2') ? 'font/woff2' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        } else { blocked.push(req.method + ' ' + pathname); status = 404; body = {}; }
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const page = await browser.newPage({ viewport: { width: 375, height: 844 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push('OUTSIDE'), route.abort()));
        async function capture(name, locator) {
            if (locator) await locator.scrollIntoViewIfNeeded();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '375px overflow: ' + name);
            await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: false }); captures.push(name);
        }
        enabled = false; await page.goto(origin + '/signup'); await page.locator('[name="name"]').waitFor();
        await capture('01-flag-off-signup', page.locator('form').first());
        enabled = true; await page.reload(); await page.locator('[name="organisationName"]').waitFor();
        assert.equal(await page.locator('[name="name"], [name="role"], [name="address"]').count(), 0);
        await page.locator('[name="organisationName"]').fill('Synthetic Workshop');
        await page.locator('[name="authorityConfirmed"]').check(); await capture('02-flag-on-signup', page.locator('form').first());
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('heading', { name: 'Review your terms' }).waitFor(); await capture('03-terms', page.locator('.signup-consent'));
        await page.locator('.signup-consent input').check(); await page.getByRole('button', { name: 'Accept and continue', exact: true }).click();
        await page.waitForURL('**/dashboard*');
        await page.locator('.dashboard-module-link[data-module="cyber_security"]:visible').first().click();
        const start = page.getByRole('button', { name: 'Start an assessment', exact: true }); if (await start.isVisible()) await start.click();
        await page.locator('#ncsc-scope').fill('Synthetic office and cloud services.');
        await page.getByRole('button', { name: 'Create assessment', exact: true }).click();
        await page.locator('#ncsc-question-index').waitFor(); await capture('04-question-one', page.locator('#ncsc-question-index'));
        assert.equal(evidence, null);
        showResult = true; await page.goto(origin + '/dashboard#overview'); await page.locator('.picture-top-gaps').waitFor();
        await page.locator('.picture-top-gaps').evaluate(node => node.scrollIntoView({ block: 'start' }));
        await capture('05-first-result');
        await page.locator('.picture-summary > summary').click();
        assert.equal(await page.getByText('Summary for your board or insurer', { exact: true }).count(), 0);
        const gate = page.locator('.picture-summary .dashboard-details-gate'); await gate.getByRole('button', { name: 'Add your details' }).waitFor();
        await capture('06-summary-gate', gate);
        await gate.getByRole('button', { name: 'Add your details' }).click();
        for (const [name, value] of Object.entries(DATA)) await gate.locator('[name="' + name + '"]').fill(value);
        await capture('07-later-details', gate);
        // Cancel/reload submits nothing; a lost acknowledgement retains one record.
        await gate.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(writes, 0);
        await gate.getByRole('button', { name: 'Add your details' }).click();
        for (const [name, value] of Object.entries(DATA)) await gate.locator('[name="' + name + '"]').fill(value);
        loseSave = true; await gate.getByRole('button', { name: 'Save details and continue' }).click();
        await gate.getByText(/Your details could not be confirmed/).waitFor();
        await gate.getByRole('button', { name: 'Save details and continue' }).click();
        await gate.getByText('Summary for your board or insurer', { exact: true }).waitFor();
        await page.reload(); await page.locator('.picture-summary > summary').click();
        await page.getByText('Summary for your board or insurer', { exact: true }).waitFor();
        await page.locator('.picture-board-summary').evaluate(node => node.scrollIntoView({ block: 'start' }));
        await capture('08-summary-ready');
        assert.equal(writes, 1); assert.equal(audits, 1); assert.equal(JSON.stringify([f.saved, f.receipt, f.activation]), before);
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify({ viewport: { width: 375, height: 844 }, captures, writes, audits,
            assertions: ['flag off full fields', 'flag on minimal signup through question one', 'first result before capture', 'summary gate', 'cancel', 'lost response retry', 'reload', 'agreement bytes unchanged'], errors, blocked }, null, 2));
        console.log(JSON.stringify({ passed: true, captures, artifacts }));
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
