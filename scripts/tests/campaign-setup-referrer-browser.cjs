'use strict';
// Positive HTTPS journeys using real documents, clients and CSS. Run with
// Playwright + Firefox/WebKit installs, Chromium and openssl available:
// CAMPAIGN_EVIDENCE_DIR=/tmp/campaign-evidence node scripts/tests/campaign-setup-referrer-browser.cjs
// Optional CHROMIUM/FIREFOX/WEBKIT_EXECUTABLE_PATH selects a locally installed engine.
// All service responses are in-memory fixtures. Only loopback is reachable;
// contact submission is always blocked. Missing engines fail, never silently skip.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const engines = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, createCommand, saveCommand, submitCommand, SUBJECT } = require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');
// The real request checks these fixture routes stand in for.
const { assertExactSameOriginRequest } = require('../../api/shared/browserAuth');
const { assertSameOriginForMutation } = require('../../api/shared/securityHeaders');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const viewport = { width: 375, height: 844 }, campaign = 'meta/paid/insurance';
const taggedLanding = '/insurance.html?utm_source=meta&utm_medium=paid&utm_campaign=insurance';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const bundle = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js',
    'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js'];
const app = bundle.map(file => read('api/shared/protectedAssets/' + file)).join('\n');
const dashboard = buildDashboardDocument({ template: read('app/dashboard.html'), customerLogin: true, customerTransport: 'auto',
    loaderSource: read('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: read('app/dashboard.css') });

async function journey(browser, engine, provider, tls, output) {
    const receipt = { engine, browser: browser.version(), provider, viewport, campaign, syntheticOnly: true,
        steps: [], requests: [], telemetry: [], blocked: [], errors: [], firstFailingStep: null, completedThroughContactPreview: false };
    const signup = buildSignupDocument({ customerLogin: true, ...(provider === 'external' ? { customerTransport: 'external' } : {}),
        clientSource: read('api/shared/customerSignup/signupClient.js'), journeySource: read('api/shared/customerSignup/signupJourney.js') });
    const fixtures = buildFixtures(), seed = fixtures.tenants[0], model = seed.model;
    const transport = createSyntheticTransport({ ...seed, assessments: [] }, fixtures.metadata, fixtures);
    const binding = '10000000-0000-4000-8000-000000000001', base = { requestId: binding, accountType: null };
    let phase = 'create_account', setup = { state: 'start' }, submitted, origin, context, page, step = 'launch';
    function evaluated(detail) {
        const fixture = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: model.context.organisationId });
        const commands = [createCommand(detail.assessmentId, 'fixture-create', detail.scopePopulation.description)];
        for (let revision = 0; revision < detail.revision - 1; revision++) commands.push(saveCommand(detail.assessmentId, revision, 'fixture-save-' + revision, detail.responses));
        commands.push(submitCommand(detail.assessmentId, detail.revision - 1, 'fixture-submit'));
        let version = null;
        for (const command of commands) version = makeVersion({ ...fixture.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey, version, fixture.state.tenantAggregate, detail.updatedAt);
        return projectNcscDetail(version);
    }
    const server = https.createServer(tls, async (req, res) => {
        try {
            const url = new URL(req.url, origin), pathname = url.pathname;
            let raw = ''; for await (const chunk of req) raw += chunk;
            receipt.requests.push({ method: req.method, path: pathname, query: url.search, origin: req.headers.origin || '',
                referrer: req.headers.referer || '', body: raw });
            res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
            // Arm the browser funnel counts so their same-origin POSTs are exercised too.
            if (pathname.startsWith('/api/')) res.setHeader('x-nofries-funnel', 'on');
            // Non-CORS POSTs keep the real HTTPS Origin, never 'null' (WebKit/Firefox
            // send 'null' under no-referrer), and a Referer of the origin only. Then
            // the real check for the route runs on the real request headers:
            // - 'exact' is assertExactSameOriginRequest, which also requires
            //   Sec-Fetch-Site: same-origin (dashboard assessment POSTs);
            // - 'mutation' is assertSameOriginForMutation, which refuses cross-site
            //   and needs Sec-Fetch-Site only without an Origin (telemetry, signup).
            const realCheckEnv = { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: origin + '/' };
            // The dashboard's own fetches keep its document policy, so its Referer is not asserted here.
            const sameOriginPost = (rule, { referer = true } = {}) => {
                assert.equal(req.headers.origin, origin, req.method + ' ' + pathname + ' must preserve its HTTPS Origin');
                if (referer) assert.equal(req.headers.referer, origin + '/', req.method + ' ' + pathname + ' Referer contains only origin');
                assert.match(req.headers['content-type'] || '', /^application\/json(?:\s*;|$)/i);
                if (rule === 'exact') {
                    assert.equal(req.headers['sec-fetch-site'], 'same-origin', req.method + ' ' + pathname + ' must send Sec-Fetch-Site: same-origin');
                    assert.doesNotThrow(() => assertExactSameOriginRequest(req, realCheckEnv), req.method + ' ' + pathname + ' exact same-origin check');
                } else if (rule === 'mutation') {
                    assert.doesNotThrow(() => assertSameOriginForMutation(req, realCheckEnv), req.method + ' ' + pathname + ' same-origin mutation check');
                } else throw new Error('unknown same-origin rule');
            };
            const telemetryPost = req.method === 'POST' && pathname === '/api/telemetry';
            const setupPost = provider === 'legacy' && /^\/api\/organisation-setup\/(?:request|verify|choose|details)$/.test(pathname);
            const signupPost = provider === 'external' && /^\/api\/external-customer-signup\/(?:setup|terms)$/.test(pathname);
            const assessmentPost = /^\/api\/dashboard\/ncsc\/assessments(?:\/[\w.:-]+\/(?:save|submit))?$/.test(pathname);
            if (req.method !== 'GET' && !(req.method === 'POST' && (setupPost || signupPost || assessmentPost)) && !telemetryPost) {
                receipt.blocked.push(req.method + ' ' + pathname); res.writeHead(405); return res.end();
            }
            let body, type = 'application/json', status = 200;
            if (telemetryPost) {
                sameOriginPost('mutation'); receipt.telemetry.push(JSON.parse(raw).event); res.writeHead(204); return res.end();
            } else if (pathname.startsWith('/api/organisation-setup/')) {
                // Match the production setup origin/content-type rule on normal browser POSTs.
                // No supplied or rewritten Origin/Referer headers or negative test cases.
                if (req.method === 'POST') {
                    assert.equal(req.headers.origin, origin, 'setup POST must preserve its HTTPS Origin');
                    assert.ok(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
                    assert.match(req.headers['content-type'] || '', /^application\/json(?:\s*;|$)/i);
                }
                assert.equal(req.headers.referer, origin + '/', 'setup Referer contains only origin');
                const action = pathname.split('/').pop(), value = raw ? JSON.parse(raw) : null;
                if (action === 'request') { assert.equal(value.email, 'synthetic@example.test'); setup = { ...base, state: 'awaiting_code', emailHint: 's***@example.test' }; }
                if (action === 'verify') { assert.equal(value.code, '12345678'); setup = { ...base, state: 'verified', accessGranted: false, nextStep: 'choose_account' }; }
                if (action === 'choose') setup = { ...setup, accountType: value.accountType, organisationName: value.organisationName, nextStep: 'details_required' };
                if (action === 'details') setup = { ...setup, nextStep: 'secure_sign_in' };
                res.setHeader('x-nofries-customer-entry', provider); res.setHeader('x-nofries-customer-sign-in', 'available'); body = setup;
            } else if (pathname === '/signup' || pathname === '/dashboard') {
                const doc = pathname === '/signup' ? signup : dashboard;
                body = doc.html; type = 'text/html'; res.setHeader('Content-Security-Policy', doc.contentSecurityPolicy);
            } else if (pathname === '/api/' + (provider === 'external' ? 'external-customer' : 'customer') + '-auth/login') {
                // Identity boundary is a local fixture redirect, not a real identity provider.
                phase = 'setup_details'; res.writeHead(302, { Location: '/signup?provider=' + provider }); return res.end();
            } else if (pathname === '/api/customer-signup/state' && provider === 'legacy') {
                body = { state: { status: 'continue_to_dashboard', accountType: 'company' } };
            } else if (pathname.startsWith('/api/external-customer-signup/') && provider === 'external') {
                if (req.method === 'POST') sameOriginPost('mutation');
                if (pathname.endsWith('/setup')) { assert.equal(JSON.parse(raw).organisationName, 'Synthetic Renewal Workshop'); phase = 'terms'; }
                if (pathname.endsWith('/terms')) { assert.equal(JSON.parse(raw).accepted, true); phase = 'continue_to_dashboard'; }
                const state = phase === 'setup_details' ? { status: phase, email: 'synthetic@example.test' } : phase === 'terms' ? {
                    status: phase, termsText: 'SYNTHETIC LOCAL FIXTURE ONLY. No real agreement or account.', termsVersion: 'synthetic-local-only', termsDigest: 'b'.repeat(64),
                    scheduleId: 'synthetic-renewal', scheduleDigest: 'c'.repeat(64), scheduleText: 'SYNTHETIC LOCAL FIXTURE. No charge or activation.'
                } : { status: phase, ...(phase === 'continue_to_dashboard' ? { accountType: 'company' } : {}) };
                body = { state, ...(['setup_details', 'terms'].includes(phase) ? { csrfToken: 's'.repeat(43) } : {}) };
            } else if (pathname === '/api/dashboard/app.js') { body = app; type = 'application/javascript'; }
            else if (pathname === '/api/dashboard/dashboard.css') { body = read('app/dashboard.css'); type = 'text/css'; }
            else if (pathname === '/api/dashboard/session') body = { schemaVersion: 1, authenticated: true, purpose: 'customer', accountType: 'company',
                generation: 'a'.repeat(64), selectedBindingId: binding, expiresAt: new Date(Date.now() + 3600000).toISOString() };
            else if (pathname === '/api/dashboard/organisations') body = { schemaVersion: 1, bindings: [{ bindingId: binding, organisationLabel: model.context.displayName }], nextAfterBindingId: null };
            else if (pathname === '/api/dashboard/bootstrap') body = model;
            else if (['/api/dashboard/modules/cyber_security', '/api/dashboard/modules/overview'].includes(pathname)) body = {
                schemaVersion: 1, context: model.context, generatedAt: model.generatedAt, module: model.modules.find(item => item.key === pathname.split('/').pop()),
                summary: model.summary, services: model.services, admissionGranted: false, providerAccessGranted: false, metadata: fixtures.metadata, presentationMode: 'editable' };
            else if (pathname.startsWith('/api/dashboard/ncsc/assessments')) {
                if (req.method === 'POST') sameOriginPost('exact', { referer: false });
                const result = await transport.fetch(req.url, { method: req.method, ...(raw ? { body: raw } : {}) }); status = result.status; body = JSON.parse(await result.text());
                if (pathname.endsWith('/submit') && status === 200) submitted = body.assessment = evaluated(body.assessment);
                if (submitted && pathname.endsWith('/' + submitted.assessmentId) && req.method === 'GET') body.assessment = submitted;
            } else if (pathname === '/api/enquiry') body = { available: true };
            else if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
            else if (/^\/(?:login(?:\.html)?|insurance\.html|contact\.html|style\.css|home\.css|favicon\.svg|apple-touch-icon\.png|images\/[\w.-]+|assets\/fonts\/[\w.-]+|js\/(?:home|enquiry-availability|enquiry-home|organisation-setup|contact)\.js)$/.test(pathname)) {
                const file = pathname === '/login' ? 'login.html' : pathname.slice(1);
                body = fs.readFileSync(path.join(root, file)); type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css'
                    : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
            } else { receipt.blocked.push(req.method + ' ' + pathname); status = 404; body = { code: 'synthetic_unavailable' }; }
            res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body);
        } catch (error) { receipt.errors.push('fixture: ' + error.message); res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'https://127.0.0.1:' + server.address().port; receipt.origin = origin;
    async function capture(name) {
        const state = await page.evaluate(() => ({ path: location.pathname + location.search + location.hash,
            campaign: sessionStorage.getItem('nofries-enquiry-campaign'), width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        receipt.steps.push({ name, ...state, tabs: context.pages().length });
        assert.equal(context.pages().length, 1); assert.equal(state.width, 375); assert.ok(state.scrollWidth <= 376, name + ' overflow');
        if (name !== 'landing') assert.equal(state.campaign, campaign, name + ' campaign continuity');
        if (output) await page.screenshot({ path: path.join(output, engine + '-' + provider + '-' + name + '.png') });
    }
    try {
        context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== origin || url.pathname === '/api/enquiry' && request.method() !== 'GET') {
                receipt.blocked.push('browser: ' + request.method() + ' ' + url.pathname); return route.abort();
            }
            return route.continue();
        });
        page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => receipt.errors.push(error.message));
        step = 'landing'; await page.goto(origin + taggedLanding);
        const entry = page.getByRole('link', { name: 'Create a free account', exact: true });
        const entryUrl = new URL(await entry.getAttribute('href'), origin);
        for (const [name, value] of new URL(taggedLanding, origin).searchParams) assert.equal(entryUrl.searchParams.get(name), value);
        await capture('landing');
        step = 'account-entry'; await page.getByRole('link', { name: 'Create a free account', exact: true }).click();
        if (provider === 'external') {
            await button(page, 'Create account').waitFor(); await capture('account-entry');
            step = 'signup-details'; await button(page, 'Create account').click();
            for (const [name, value] of Object.entries({ organisationName: 'Synthetic Renewal Workshop', name: 'Synthetic Owner', role: 'Owner', address: '1 Synthetic Test Street' })) await page.locator('[name="' + name + '"]').fill(value);
            await page.locator('[name="authorityConfirmed"]').check(); await capture('signup-details');
            await button(page, 'Continue').click(); await page.getByRole('heading', { name: 'Review your terms' }).waitFor();
            await page.locator('.signup-consent input').check(); await button(page, 'Accept and continue').click();
        } else {
            await page.locator('#organisation-email').waitFor(); await capture('account-entry');
            step = 'setup-email'; await page.locator('#organisation-email').fill('synthetic@example.test'); await page.locator('#organisation-send').click();
            await page.getByRole('heading', { name: 'Check your inbox', exact: true }).waitFor();
            step = 'setup-code'; await page.locator('#organisation-code').fill('12345678'); await page.locator('#organisation-verify').click();
            step = 'setup-account'; await page.locator('#organisation-company').click(); await page.locator('#organisation-name').fill('Synthetic Renewal Workshop');
            await page.locator('#organisation-profile-form button[type=submit]').click();
            step = 'setup-details';
            for (const [id, value] of Object.entries({ name: 'Synthetic Owner', role: 'Owner', address: '1 Synthetic Test Street' })) await page.locator('#representative-' + id).fill(value);
            await page.locator('#representative-authority').check(); await page.locator('#organisation-details-form button[type=submit]').click();
            await page.locator('#organisation-continue').waitFor(); await capture('setup-complete'); await page.locator('#organisation-continue').click();
        }
        step = 'dashboard'; await page.waitForURL('**/dashboard*');
        const cyber = page.locator('.dashboard-module-link[data-module="cyber_security"]:visible').first();
        await cyber.waitFor(); await capture('dashboard'); await cyber.click();
        step = 'assessment-create'; await button(page, 'Start an assessment').click();
        await page.locator('#ncsc-scope').fill('Synthetic office and cloud services for renewal browser test.'); await button(page, 'Create assessment').click();
        await page.locator('#ncsc-question-index').waitFor(); await capture('assessment');
        const questions = await page.locator('#ncsc-question-index option').evaluateAll(nodes => nodes.map(node => node.value)); receipt.assessmentQuestions = questions.length;
        step = 'assessment-answer';
        for (const value of questions) { await page.locator('#ncsc-question-index').selectOption(value); await page.locator('.ncsc-answer input[value="no"]').check(); }
        step = 'assessment-review'; await button(page, 'Review and submit').click(); await page.locator('.ncsc-review').waitFor(); await capture('assessment-review');
        await button(page, 'Save and submit assessment').click(); await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
        step = 'results'; await page.locator('.ncsc-results').waitFor(); await capture('results');
        const offer = page.locator('.ncsc-results').getByRole('link', { name: 'Fix these with No Fries', exact: true });
        step = 'contact-preview';
        if (await offer.count()) { receipt.contactPath = 'Results offer'; await offer.click(); }
        else {
            receipt.contactPath = 'Same-tab insurance landing paid CTA'; await page.goto(origin + taggedLanding);
            await page.getByRole('link', { name: 'Ask about 90-day managed security', exact: true }).click();
        }
        await page.locator('#contact-form').waitFor(); await page.waitForFunction(() => !document.querySelector('#contact-send').disabled);
        for (const [id, value] of Object.entries({ name: 'Synthetic Owner', email: 'synthetic@example.test', organisation: 'Synthetic Renewal Workshop' })) await page.locator('#contact-' + id).fill(value);
        receipt.contact = { service: new URL(page.url()).searchParams.get('service'), message: await page.locator('#contact-message').inputValue() };
        assert.equal(receipt.contact.service, 'managed_security_90'); assert.match(receipt.contact.message, /90-day managed security/);
        await capture('contact-preview'); // Never activate the Send control.
        const api = receipt.requests.filter(request => request.path.startsWith('/api/'));
        for (const request of api) assert.doesNotMatch(request.query + request.body + request.referrer, /utm_|meta\/paid\/insurance/);
        receipt.setupRequests = api.filter(request => request.path.startsWith('/api/organisation-setup/'));
        assert.equal(receipt.setupRequests.filter(request => request.method === 'POST').length, provider === 'legacy' ? 4 : 0);
        // Funnel counts arrive from every engine (each POST was Origin-checked above).
        assert.ok(receipt.telemetry.length > 0, 'funnel counts must reach the same-origin handler');
        assert.deepEqual(receipt.blocked, []); assert.deepEqual(receipt.errors, []); receipt.completedThroughContactPreview = true;
    } catch (error) {
        receipt.firstFailingStep = step; receipt.failure = error.message;
        if (page && output) await page.screenshot({ path: path.join(output, engine + '-' + provider + '-failure.png') }).catch(() => {});
    } finally {
        receipt.enquiryPostCount = receipt.requests.filter(request => request.path === '/api/enquiry' && request.method === 'POST').length;
        await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    return receipt;
}

async function run() {
    const output = process.env.CAMPAIGN_EVIDENCE_DIR; if (output) fs.mkdirSync(output, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-loopback-tls-'));
    const result = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        node: process.version, playwright: require('playwright/package.json').version,
        setupSourceSha256: createHash('sha256').update(read('js/organisation-setup.js')).digest('hex'), viewport, campaign,
        boundaries: ['HTTPS loopback only; ephemeral test certificate; fresh browser contexts.',
            'Local synthetic identity callbacks, signup state and agreements, session and assessment services.',
            'Actual clients/documents/CSS and assessment evaluator; no database, live flags, provider or delivery.',
            'Stops at filled unsent Contact preview. Linux WebKit is not physical iOS device coverage.'], cases: [], gaps: [] };
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', path.join(temporary, 'key.pem'), '-out', path.join(temporary, 'cert.pem')], { stdio: 'ignore' });
        const tls = { key: fs.readFileSync(path.join(temporary, 'key.pem')), cert: fs.readFileSync(path.join(temporary, 'cert.pem')) };
        for (const engine of ['chromium', 'firefox', 'webkit']) {
            let browser;
            try {
                const executablePath = process.env[engine.toUpperCase() + '_EXECUTABLE_PATH'] || (engine === 'chromium' ? '/usr/bin/chromium' : undefined);
                browser = await engines[engine].launch({ headless: true, timeout: 30000, executablePath,
                    ...(engine === 'chromium' ? { args: ['--no-sandbox', '--disable-background-networking'] } : {}) });
            } catch (error) { result.gaps.push({ engine, step: 'browser-launch', error: error.message }); continue; }
            try { for (const provider of ['external', 'legacy']) result.cases.push(await journey(browser, engine, provider, tls, output)); }
            finally { await browser.close(); }
        }
        result.passed = result.gaps.length === 0 && result.cases.length === 6 && result.cases.every(item => item.completedThroughContactPreview && item.enquiryPostCount === 0);
        if (output) fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(result, null, 2));
        return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { run };
if (require.main === module) run().then(result => {
    console.log(JSON.stringify({ ...result, cases: result.cases.map(({ requests, ...item }) => item) }));
    if (!result.passed) process.exitCode = 1;
}).catch(error => { console.error(error); process.exitCode = 1; });
