'use strict';

const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const request = require('supertest');
const { createProductionApplication } = require('../../lib/productionApplication');
const { customerProductionHarness } = require('../helpers/customerProductionHarness');
const { paidFrameworks, rendererAsset } = require('../../api/shared/protectedAssets/dashboardRegistry');
const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { assetPath, checkPicker } = require('../../scripts/tests/paid-renderer-browser.cjs');

async function withLoopbackBrowser(work) {
    const directory = mkdtempSync(join(tmpdir(), 'paid-renderer-'));
    let server, browser;
    try {
        const key = join(directory, 'tls.key'), cert = join(directory, 'tls.crt');
        require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
        server = require('node:https').createServer({ key: readFileSync(key), cert: readFileSync(cert) });
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
        browser = await require('playwright').chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
        await work(server, 'https://127.0.0.1:' + server.address().port, browser);
    } finally {
        try { if (browser) await browser.close(); }
        finally {
            if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            rmSync(directory, { recursive: true, force: true });
        }
    }
}

module.exports = ({ resourceSetup, NCSC_SUBJECT, nextId, identity }) => {
    async function fixture(ref, origin, enabled, otherRefs = []) {
        const [tenant, oid] = NCSC_SUBJECT.split(':');
        const principal = { ...identity(), identityTenantId: tenant, oid,
            issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', audience: nextId() };
        const f = await resourceSetup({ productionIdentity: principal, initialTime: '2026-11-19T00:01:00.000Z',
            exampleOptions: { profileRefs: [ACCEPTED_PROFILE_REF, ...[ref, ...otherRefs].filter(Boolean).map(row => ({ profileId: row.profileId, profileVersion: row.version }))] } });
        const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal, instanceId: f.instanceId,
            restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now), applicationFactory: (env, deps) =>
                createProductionApplication({ ...env, NOFRIES_PUBLIC_URL: origin,
                    ...(enabled === undefined ? {} : { NOFRIES_PAID_FRAMEWORKS_ENABLED: enabled }),
                    NOFRIES_DASHBOARD_NCSC_ENABLED: 'true' }, deps) });
        h.env.NOFRIES_PUBLIC_URL = origin;
        const user = h.addUser({ ...f.scope, bindingId: f.publication.binding.bindingId });
        user.authority.accountType = 'consultant'; user.save();
        const { cookie } = await h.login(user);
        await h.consent(cookie);
        await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', cookie)
            .send({ operationId: nextId() }).expect(200);
        async function select(bindingId) {
            const current = await request(h.app).get('/api/dashboard/session').set('Cookie', cookie).expect(200);
            await h.sameOrigin(request(h.app).post('/api/dashboard/selection')).set('Cookie', cookie)
                .send({ operationId: nextId(), bindingId, expectedGeneration: current.body.generation }).expect(200);
        }
        const session = await request(h.app).get('/api/dashboard/session').set('Cookie', cookie).expect(200);
        expect(session.body.generation).toMatch(/^[a-f0-9]{64}$/);
        return { f, h, cookie, select, generation: session.body.generation };
    }
    async function revokeFixtureProduct(f, ref) {
        const { createPostgresDatabase } = require('../../api/shared/database/postgres');
        const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
        const operationId = nextId();
        const repository = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: f.seedPool }),
            clock: () => f.state.now, authoriseAdministration: cmd => cmd.tenantId === f.scope.tenantId &&
                cmd.organisationId === f.scope.organisationId && cmd.actorSubjectKey === NCSC_SUBJECT &&
                (cmd.type === 'authority.read' || (cmd.type === 'entitlement.update' && cmd.operationId === operationId)) });
        const { revisions, snapshot } = await repository.readAuthoritySnapshot(f.scope, { authenticated: true, subjectKey: NCSC_SUBJECT });
        const state = snapshot.entitlementState;
        const grants = state.grants.map(grant => grant.frameworks.some(row => row.moduleId === ref.moduleId &&
            row.profileId === ref.profileId && row.version === ref.version) ? { ...grant, status: 'revoked' } : grant);
        await repository.executeAuthorityCommand({ ...f.scope, operationId, actorSubjectKey: NCSC_SUBJECT, type: 'entitlement.update',
            expectedRevisions: revisions, payload: { ...state, grants, revision: state.revision + 1 } });
    }
    test.each(paidFrameworks)('paid renderer flag off denies a signed-in $label asset', async ref => {
        const { h, cookie, generation } = await fixture(ref, 'https://nofries.example.test', 'TRUE');
        for (const name of ['collection', 'questionnaire', 'results']) {
            await request(h.app).get(assetPath(ref, name, generation)).set('Cookie', cookie).expect(404);
        }
        await request(h.app).get('/api/dashboard/frameworks/' + ref.profileId + '/' + ref.version + '/assessments')
            .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', generation).expect(404);
    });
    // Explicit because the standalone picker base does not package the renderer/publication/runtime stack.
    if (process.env.NOFRIES_TEST_RENDERER_BROWSER === 'true') {
        test.each([['free organisation', 'true', null], ['flag off', undefined, paidFrameworks[0]]])(
            'signed-in Overview for %s requests no paid scripts or data', async (_label, flag, ref) => {
                await withLoopbackBrowser(async (server, origin, browser) => {
                    const { f, h, cookie } = await fixture(ref, origin, flag);
                    server.on('request', h.app);
                    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
                    try {
                        const split = cookie.indexOf('=');
                        await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, secure: true, httpOnly: true }]);
                        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
                        const page = await context.newPage(), paid = [];
                        page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/dashboard/frameworks/')) paid.push(req.url()); });
                        await page.clock.setFixedTime(new Date(f.state.now));
                        await page.goto(origin + '/dashboard#overview');
                        await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
                        await page.waitForLoadState('networkidle');
                        expect(paid).toEqual([]);
                        for (const row of paidFrameworks) expect(await page.getByRole('heading', { name: row.label + ' progress' }).count()).toBe(0);
                    } finally { await context.close(); }
                });
            }, 30000);
        test('one signed-in browser moves from ISO to NIST to a locked client', async () => {
            const [nist, iso] = paidFrameworks;
            await withLoopbackBrowser(async (server, origin, browser) => {
                const { f, h, cookie, select } = await fixture(iso, origin, 'true', [nist]);
                server.on('request', h.app);
                const context = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
                try {
                    const split = cookie.indexOf('=');
                    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, secure: true, httpOnly: true }]);
                    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
                    const page = await context.newPage();
                    page.setDefaultTimeout(8000);
                    await page.clock.setFixedTime(new Date(f.state.now));
                    await page.goto(origin + '/dashboard#cyber-security');
                    const documentStart = await page.evaluate(() => performance.timeOrigin);
                    const open = name => page.getByRole('button', { name, exact: true });
                    const terms = page.locator('fieldset summary').filter({ hasText: / explained$/ });
                    const delivered = [];
                    for (const ref of [iso, nist]) {
                        await open('Open ' + ref.label).click();
                        await page.getByRole('textbox', { name: 'What part of your organisation will you assess?' }).fill('Synthetic workshop');
                        const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/assets/questionnaire.js'));
                        await open('Start assessment').click();
                        await page.getByRole('radio').first().waitFor();
                        const script = await response;
                        expect(script.status()).toBe(200);
                        expect(script.headers()['cache-control']).toMatch(/private, no-store/);
                        expect('sha256-' + createHash('sha256').update(await script.body()).digest('base64')).toBe(rendererAsset(ref, 'questionnaire').integrity);
                        delivered.push(new URL(script.url()));
                        if (ref === iso) {
                            const term = terms.filter({ hasText: /^Information risk explained$/ });
                            await term.focus();
                            await page.keyboard.press('Enter');
                            expect(await term.evaluate(node => node.parentElement.open)).toBe(true);
                            await open('Back to assessment choices').click();
                        } else {
                            expect(await terms.count()).toBe(0);
                            expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
                        }
                    }
                    await page.goto(origin + '/dashboard#overview');
                    for (const [ref, total] of [[iso, 116], [nist, 106]]) {
                        const card = page.locator('section.dashboard-panel').filter({ has: page.getByRole('heading', { name: ref.label + ' progress' }) });
                        await card.getByRole('link', { name: 'Resume ' + ref.label, exact: true }).waitFor();
                        expect(await card.innerText()).toContain('0 of ' + total + ' answered');
                    }
                    await page.getByRole('link', { name: 'Resume ' + nist.label, exact: true }).click();
                    await page.getByRole('radio').first().waitFor();
                    const other = await f.addResource({ tenantId: f.scope.tenantId + '-free', organisationId: f.scope.organisationId },
                        { profileRefs: [ACCEPTED_PROFILE_REF] });
                    await select(other.publication.binding.bindingId);
                    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
                    await page.getByRole('radio').first().waitFor({ state: 'detached' });
                    await page.getByText('Locked', { exact: true }).first().waitFor();
                    expect(await page.getByText('Locked', { exact: true }).count()).toBe(2);
                    expect(await terms.count()).toBe(0);
                    const selection = await request(h.app).get('/api/dashboard/session').set('Cookie', cookie).expect(200);
                    for (const [index, ref] of [iso, nist].entries()) {
                        const prior = delivered[index];
                        await request(h.app).get(prior.pathname + prior.search).set('Cookie', cookie).expect(403);
                        const refused = await request(h.app).get(assetPath(ref, 'questionnaire', selection.body.generation)).set('Cookie', cookie).expect(403);
                        expect(refused.headers['cache-control']).toMatch(/no-store/);
                        expect(refused.text).not.toContain('NoFriesPaidQuestionnaire');
                        await request(h.app).get('/api/dashboard/frameworks/' + ref.profileId + '/' + ref.version + '/assessments')
                            .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', selection.body.generation).expect(403);
                    }
                    await open('Open NCSC check').click();
                    await page.getByRole('heading', { name: 'Cyber security assessment', exact: true }).waitFor();
                    expect(await terms.count()).toBe(0);
                } finally { await context.close(); }
            });
        }, 90000);
        test.each(paidFrameworks)('mounted paid picker: $label', async ref => {
            await withLoopbackBrowser(async (server, origin, browser) => {
                const { f, h, cookie, select } = await fixture(ref, origin, 'true');
                server.on('request', h.app);
                await checkPicker({ browser, app: h.app, origin, cookie, now: f.state.now, ref,
                    directory: process.env.NOFRIES_TEST_RENDERER_SCREENSHOTS,
                    revoke: () => revokeFixtureProduct(f, ref),
                    returnToOrganisation: () => select(f.publication.binding.bindingId),
                    switchOrganisation: async () => {
                        const other = await f.addResource({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId });
                        await select(other.publication.binding.bindingId);
                    } });
            });
        }, 120000);
    }
};
