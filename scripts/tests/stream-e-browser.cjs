'use strict';
// Real production documents, client, shell, questionnaire and CSS at 375px.
// Only loopback synthetic fixtures; no identity provider or real acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { deferredFixture, DATA, AT } = require('../../test/fixtures/deferredDetailsFixture');
const { representativeDetails } = require('../../api/shared/customerSignup/deferredRepresentativeDetails');
const root = path.resolve(__dirname, '../..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const artifacts = path.resolve(process.env.NOFRIES_STREAM_E_ARTIFACTS || '/tmp/stream-e-browser');
const campaign = process.env.NOFRIES_STREAM_E_CAMPAIGN || '';
assert.ok(['', 'board', 'scam'].includes(campaign));
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
let enabled = true, phase = 'setup_details', showResult = false, loseSave = false, denyRead = false, audits = 0, writes = 0, detailReads = 0;
let accountType = 'company', audience = model.audience, ownEnrollment = true;
const blocked = [], errors = [], captures = [], requests = [], prints = [];
(async () => {
    const evidenceFile = path.join(artifacts, 'synthetic-details-store.json');
    if (fs.existsSync(evidenceFile)) fs.unlinkSync(evidenceFile);
    const evidence = () => fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : null;
    const f = await deferredFixture(), before = JSON.stringify([f.saved, f.receipt, f.activation]);
    const deps = { context: f.context, clock: () => AT, audit: { createEvent: (_, x) => x, writeEvent: async () => { audits++; } },
        database: { async withTenantTransaction(_, work) { return work({ async query(sql, args) {
            if (sql.includes('FROM nofries.dashboard_starter_scopes')) return { rows: [{ preparation: f.preparation, activation: f.activation }] };
            if (sql.includes('FROM nofries.signup_acceptance_receipts')) return { rows: [{ payload: { receipt: f.receipt } }] };
            if (sql.includes('SELECT payload, payload_sha256')) { const row = evidence(); return { rows: row ? [row] : [] }; }
            if (sql.includes('SELECT EXISTS')) return { rows: [{ found: showResult }] };
            if (sql.includes('INSERT INTO nofries.dashboard_representative_details')) {
                if (evidence()) return { rowCount: 0 };
                fs.writeFileSync(evidenceFile, JSON.stringify({ payload: JSON.parse(args[4]), payload_sha256: args[5] }), { flag: 'wx' });
                writes++; return { rowCount: 1 };
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
        else if (pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType,
            representativeDetailsAvailable: true, ...(enabled && ownEnrollment ? { questionnaireExportGateAvailable: true } : {}),
            generation: 'a'.repeat(64), selectedBindingId: f.preparation.slot.bindingId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
        else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1, bindings: [{ bindingId: f.preparation.slot.bindingId,
            organisationLabel: model.context.displayName }], nextAfterBindingId: null };
        else if (pathname === '/api/dashboard/bootstrap') body = { ...model, audience };
        else if (['/api/dashboard/modules/cyber_security', '/api/dashboard/modules/overview'].includes(pathname)) body = { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
            module: model.modules.find(item => item.key === pathname.split('/').pop()), summary: model.summary, services: model.services,
            admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
        else if (pathname === '/api/dashboard/representative-details') {
            if (!input) detailReads++;
            if (!input && denyRead) { status = 503; body = { code: 'synthetic_read_unavailable' }; }
            else body = await representativeDetails(deps, input);
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
        const page = await browser.newPage({ viewport: { width: 375, height: 844 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); page.setDefaultTimeout(15000);
        await page.addInitScript(campaign => {
            if (campaign) sessionStorage.setItem('nofries-enquiry-campaign', 'meta/paid/' + campaign);
            window.syntheticPrints = 0; window.syntheticBeforePrint = 0;
            addEventListener('beforeprint', () => { window.syntheticBeforePrint++; });
            const print = window.print.bind(window); window.print = () => { window.syntheticPrints++; print(); };
        }, campaign);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push('OUTSIDE'), route.abort()));
        async function capture(name, locator) {
            if (locator) await locator.scrollIntoViewIfNeeded();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '375px overflow: ' + name);
            await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: false }); captures.push(name);
        }
        async function openResult() {
            await page.goto(origin + '/dashboard#cyber-security');
            // A hash-only navigation keeps the existing session witness. Reload
            // so each simulated server flag change obtains a fresh witness.
            await page.reload();
            await page.locator('.ncsc-questionnaire-answers, .ncsc-assessment-list').first().waitFor();
            if (!await page.locator('.ncsc-questionnaire-answers').count()) {
                await page.locator('.ncsc-assessment-list li').filter({ hasText: 'Submitted' }).getByRole('button').first().click();
            }
            await page.locator('.ncsc-questionnaire-answers').waitFor();
            return page.locator('.ncsc-questionnaire-answers');
        }
        async function printEvidence(name, section, expected) {
            await page.emulateMedia({ media: 'print' });
            assert.equal(await section.isVisible(), expected);
            const pdf = path.join(artifacts, name + '.pdf');
            await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
            const printed = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
            assert.equal(printed.includes('Answers for your insurer or customer questionnaire'), expected);
            assert.equal(printed.includes('not a guarantee an insurer or customer accepts them'), expected);
            for (const question of await section.locator('h4').allTextContents()) assert.equal(printed.includes(question), expected);
            prints.push({ file: name + '.pdf', questionnaireIncluded: expected });
            await page.emulateMedia({ media: 'screen' });
        }
        async function copyAnswers(section) {
            await section.getByRole('button', { name: 'Copy answers', exact: true }).click();
            await section.getByRole('status').filter({ hasText: 'Summary copied.' }).waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await section.getByLabel('Answers to copy').inputValue());
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
        assert.equal(evidence(), null);
        showResult = true; await page.goto(origin + '/dashboard#overview'); await page.locator('.picture-top-gaps').waitFor();
        await page.locator('.picture-top-gaps').evaluate(node => node.scrollIntoView({ block: 'start' }));
        await capture('05-first-result');
        await page.locator('.picture-summary > summary').click();
        assert.equal(await page.getByText('Summary for your board or insurer', { exact: true }).count(), 0);
        const boardGate = page.locator('.picture-summary .dashboard-details-gate'); await boardGate.getByRole('button', { name: 'Add your details' }).waitFor();
        await capture('06-summary-gate', boardGate);
        // D has no flag. With E off, its original exports work even with outstanding details.
        enabled = false; let section = await openResult();
        assert.equal(await section.locator('li').count(), 9); assert.equal(evidence(), null);
        await copyAnswers(section);
        await section.getByRole('button', { name: 'Print answers', exact: true }).click();
        assert.equal(await page.evaluate(() => window.syntheticPrints), 1);
        assert.ok(await page.evaluate(() => window.syntheticBeforePrint > 0));
        await printEvidence('questionnaire-flag-off', section, true);
        assert.equal(writes, 0);
        enabled = true; denyRead = true;
        for (const scenario of [
            { type: 'company', audience: model.audience, enrolled: false },
            { type: 'company', audience: 'Scoped advisor', enrolled: true },
            { type: 'consultant', audience: model.audience, enrolled: false }
        ]) {
            accountType = scenario.type; audience = scenario.audience; ownEnrollment = scenario.enrolled;
            section = await openResult();
            await copyAnswers(section);
            await section.getByRole('button', { name: 'Print answers', exact: true }).click();
            await page.goto(origin + '/dashboard#overview');
            await page.locator('.picture-summary > summary').click();
            await page.getByRole('button', { name: 'Copy board summary' }).click();
            await page.getByRole('button', { name: 'Print board summary' }).click();
            assert.equal(await page.locator('.picture-summary .dashboard-details-gate').count(), 0);
        }
        accountType = 'company'; audience = model.audience; ownEnrollment = true;
        // With E on, a failed server read cannot expose export controls or print output.
        enabled = true; denyRead = true; section = await openResult();
        if (campaign) {
            const promoted = page.locator(campaign === 'board' ? '.ncsc-board-next-step' : '.ncsc-results .picture-next-steps-help');
            await promoted.getByText('Your details could not be checked.').waitFor();
            assert.equal(await promoted.locator('textarea, a, pre').count(), 0);
        }
        await section.getByText('Your details could not be checked.').waitFor();
        assert.equal(await section.locator('li').count(), 9);
        assert.equal(await section.getByRole('button', { name: /^(Copy|Print) answers$/ }).count(), 0);
        await page.emulateMedia({ media: 'print' }); assert.equal(await section.isVisible(), false); await page.emulateMedia({ media: 'screen' });
        denyRead = false; await section.getByRole('button', { name: 'Retry', exact: true }).click();
        const gate = section.locator('.dashboard-details-gate'); await gate.getByRole('button', { name: 'Add your details' }).waitFor();
        assert.equal(await section.locator('li').count(), 9);
        assert.equal(await section.locator('textarea').count(), 0);
        await section.locator('h3').evaluate(node => node.scrollIntoView({ block: 'start' }));
        await capture('09-questionnaire-readable'); await capture('10-questionnaire-export-gate', gate);
        // Whole-page app printing and browser/PDF printing both apply the print CSS.
        await page.locator('.ncsc-next-steps > details > summary').click();
        await page.getByRole('button', { name: 'Print these results', exact: true }).first().click();
        assert.equal(await page.evaluate(() => window.syntheticPrints), 1);
        assert.ok(await page.evaluate(() => window.syntheticBeforePrint > 0));
        await printEvidence('questionnaire-before-details', section, false);
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
        await gate.getByRole('button', { name: 'Copy answers', exact: true }).waitFor();
        assert.deepEqual(evidence().payload.details, DATA);
        await copyAnswers(section); await capture('11-questionnaire-exports-ready', gate);
        await section.getByRole('button', { name: 'Print answers', exact: true }).click();
        assert.equal(await page.evaluate(() => window.syntheticPrints), 2);
        await printEvidence('questionnaire-after-details', section, true);
        const readsBeforeReload = detailReads, storedBytes = fs.readFileSync(evidenceFile, 'utf8');
        await page.reload();
        section = page.locator('.ncsc-questionnaire-answers');
        await section.getByRole('button', { name: 'Copy answers', exact: true }).waitFor();
        if (campaign === 'board') await page.locator('.ncsc-board-next-step').getByRole('button', { name: 'Copy board summary' }).waitFor();
        if (campaign === 'scam') await page.locator('.ncsc-results .picture-next-steps-help').getByRole('link', { name: 'Fix these with No Fries' }).waitFor();
        assert.ok(detailReads > readsBeforeReload); assert.equal(fs.readFileSync(evidenceFile, 'utf8'), storedBytes);
        await copyAnswers(section); await printEvidence('questionnaire-after-reload', section, true);
        await page.goto(origin + '/dashboard#overview'); await page.locator('.picture-summary > summary').click();
        await page.getByText('Summary for your board or insurer', { exact: true }).waitFor();
        await page.locator('.picture-board-summary').evaluate(node => node.scrollIntoView({ block: 'start' }));
        await capture('08-summary-ready');
        assert.equal(writes, 1); assert.equal(audits, 1); assert.equal(JSON.stringify([f.saved, f.receipt, f.activation]), before);
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify({ campaign, viewport: { width: 375, height: 844 }, captures, prints, writes, audits, detailReads,
            persistence: 'Synthetic supplemental row written to disk and validated on each service read, including after reload',
            assertions: ['flag off full fields', 'flag on minimal signup through question one', 'first result before capture', 'summary gate',
                'D suggestions readable with E on', 'E off questionnaire Copy/Print unchanged with outstanding details', 'failed details read withholds exports',
                'whole-page and browser print exclude questionnaire before capture', 'cancel', 'lost response retry', 'post-save persisted confirmation',
                'questionnaire Copy/Print after save and reload', 'agreement bytes unchanged'], errors, blocked }, null, 2));
        console.log(JSON.stringify({ passed: true, captures, artifacts }));
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
