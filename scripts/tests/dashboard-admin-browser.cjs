'use strict';

// Local synthetic browser evidence only. No production application, account,
// database, permission, signup, or customer access is exercised by this script.
// Uses existing Playwright/Chromium installations; installs no dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildDashboardAdminDocument, dashboardAdminCss, contentSecurityPolicy } = require('../../lib/dashboardAdminDocument');
const { createDashboardAdminService } = require('../../api/shared/dashboardAdmin/service');
const { dataCodec } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { fixture: dashboardFixture, SUBJECT } = require('../../test/fixtures/dashboardFixture');

const root = path.resolve(__dirname, '../..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-dashboard-admin-'));
fs.chmodSync(artifacts, 0o700);
const script = fs.readFileSync(path.join(root, 'api/shared/protectedAssets/dashboardAdmin.js'), 'utf8');
const selection = { provider: 'legacy', subjectKey: SUBJECT, tenantId: 'Synthetic-Tenant_A.1', organisationId: 'Synthetic-Workshop_A.1' };
const evaluatedAt = '2026-10-18T22:00:00.000Z';
const canonical = dashboardFixture({ organisationId: selection.organisationId, now: evaluatedAt });
const snapshot = JSON.parse(JSON.stringify({ tenantAggregate: canonical.tenantAggregate, membershipState: canonical.membershipState,
    entitlementState: canonical.entitlementState, flags: canonical.flags, advisorAssignments: [],
    usage: canonical.entitlementState.grants.map(dataCodec.newUsage) }), (key, value) => key === 'tenantId' ? selection.tenantId : value);
const invitationSubject = SUBJECT.slice(0, -1) + '2';
snapshot.membershipState = applyMembershipCommand(snapshot.membershipState, snapshot.tenantAggregate, {
    tenantId: selection.tenantId, organisationId: selection.organisationId, expectedRevision: snapshot.membershipState.revision,
    actorSubjectKey: SUBJECT, now: evaluatedAt, action: 'invite', payload: { invitationId: 'synthetic-pending-only',
        subjectKey: invitationSubject, roles: ['viewer'], validFrom: evaluatedAt, validUntil: snapshot.entitlementState.grants[0].validUntil,
        expiresAt: snapshot.entitlementState.grants[0].validUntil, grantEvidenceId: 'synthetic-pending-evidence' } });
const actor = SUBJECT.slice(0, -1) + '9', principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: actor };
const service = createDashboardAdminService({ requestBudgetMs: 1000, clock: () => evaluatedAt, audit: async () => true,
    authoriseOperator: ({ principal: user, selector }) => user.subjectKey === actor && (!selector ||
        selector.provider === selection.provider && [SUBJECT, invitationSubject].includes(selector.subjectKey) && selector.tenantId === selection.tenantId && selector.organisationId === selection.organisationId),
    readAuthoritySnapshot: async () => ({ snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt }) });
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } });
const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const files = { '/dashboard-admin': ['text/html; charset=utf-8', buildDashboardAdminDocument()],
        '/api/dashboard-admin/app.js': ['application/javascript; charset=utf-8', script],
        '/api/dashboard-admin/app.css': ['text/css; charset=utf-8', dashboardAdminCss] };
    const file = files[request.url];
    if (request.method !== 'GET' || !file) { response.statusCode = request.url === '/favicon.svg' ? 204 : 404; return response.end(); }
    response.setHeader('Content-Type', file[0]); response.end(file[1]);
});

(async () => {
    let browser, failure;
    const results = [], outside = [], pageErrors = [], violations = [], lookupRequests = [];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 768, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            let capability = { lookup: true, recovery: [] }, capabilityStatus = 200, mode = 'found', pending;
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => { window.adminCspViolations = []; document.addEventListener('securitypolicyviolation', event => window.adminCspViolations.push(event.effectiveDirective)); });
            await page.route('**/*', async route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== origin) { outside.push(request.method() + ' ' + url.origin); return route.abort(); }
                if (url.pathname === '/api/dashboard-admin/capabilities') return json(route, capability, capabilityStatus);
                if (url.pathname === '/api/dashboard-admin/lookup') {
                    assert.equal(request.method(), 'POST'); lookupRequests.push(request.postDataJSON());
                    if (mode === 'pending') {
                        await new Promise(resolve => { pending = resolve; });
                        const stale = JSON.parse(JSON.stringify(await service.lookup(principal, request.postDataJSON())));
                        stale.result.organisation.displayName = 'Stale synthetic result';
                        return json(route, stale).catch(() => {});
                    }
                    if (mode === '403' || mode === '401' || mode === '503') return json(route, { message: 'private-diagnostic-canary' }, Number(mode));
                    // Success traverses the real service/normalizer/projection,
                    // backed only by the canonical synthetic domain fixture.
                    const body = JSON.parse(JSON.stringify(await service.lookup(principal, request.postDataJSON())));
                    if (mode === 'not_found') body.result.status = 'not_found';
                    if (mode === 'mismatch') body.result.scope.organisationId = '33333333-3333-4333-8333-333333333333';
                    if (mode === 'case-mismatch') body.result.scope.tenantId = body.result.scope.tenantId.toLowerCase();
                    if (mode === 'unsafe-text') body.result.organisation.displayName = '<img src=x onerror=alert(1)>';
                    return json(route, body);
                }
                return route.continue();
            });
            await page.goto(origin + '/dashboard-admin');
            const subject = page.getByLabel('Immutable subject key', { exact: true });
            const submit = page.getByRole('button', { name: 'Look up identity', exact: true });
            const fill = async () => {
                await page.getByLabel('Identity provider').selectOption(selection.provider);
                await subject.fill(selection.subjectKey); await page.getByLabel('Tenant ID', { exact: true }).fill(selection.tenantId);
                await page.getByLabel('Organisation ID', { exact: true }).fill(selection.organisationId);
            };
            await subject.waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.getElementById('adminLookupFields').disabled);
            await page.getByLabel('Identity provider').focus(); await page.keyboard.press('ArrowDown');
            assert.equal(await page.getByLabel('Identity provider').inputValue(), 'external');
            await page.keyboard.press('ArrowUp'); await page.keyboard.press('Tab');
            assert.equal(await subject.evaluate(node => node === document.activeElement), true, 'provider is followed by subject in keyboard order');
            await fill(); await page.getByLabel('Organisation ID', { exact: true }).focus(); await page.keyboard.press('Enter');
            await page.getByRole('heading', { name: 'Scoped access records found', exact: true }).waitFor();
            assert.equal(await page.locator('#adminResultHeading').evaluate(node => node === document.activeElement), true);
            assert.deepEqual(lookupRequests.at(-1), selection);
            assert.match(await page.locator('#adminLookupResult').innerText(), /Synthetic-Tenant_A\.1/);
            assert.match(await page.locator('#adminLookupResult').innerText(), /Synthetic-Workshop_A\.1/);
            assert.ok((await page.locator('#adminLookupResult').innerText()).includes(snapshot.entitlementState.grants[0].validUntil));
            assert.match(await page.locator('#adminLookupResult').innerText(), /does not establish signup completion/);
            assert.match(await page.locator('#adminLookupResult').innerText(), /no trusted diagnostic reader is connected/);
            const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                controls: [...document.querySelectorAll('#adminLookupFields input, #adminLookupFields select, #adminLookupSubmit')]
                    .map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
            assert.ok(layout.scrollWidth <= width + 1, 'no horizontal overflow at ' + width);
            assert.ok(layout.controls.every(box => box.width > 0 && box.height >= 44), 'usable controls at ' + width);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, 'dashboard-admin-' + width + '.png'), fullPage: true });

            // An invitation is a scoped access record, not a current membership.
            await subject.fill(invitationSubject); await submit.click();
            await page.getByRole('heading', { name: 'Scoped access records found', exact: true }).waitFor();
            assert.equal(await page.locator('#adminLookupStatus').innerText(), 'Scoped access records found.');
            const invitationOnly = await page.locator('#adminLookupResult').evaluate(node => {
                const children = [...node.children], next = title => children[children.findIndex(item => item.tagName === 'H3' && item.textContent === title) + 1];
                return { membership: next('Memberships').textContent, invitation: next('Invitations').textContent, text: node.textContent };
            });
            assert.equal(invitationOnly.membership, 'None recorded in this snapshot.');
            assert.match(invitationOnly.invitation, /pending/);
            assert.doesNotMatch(invitationOnly.text, /Scoped membership found|Effective status|synthetic-membership|signup complete|activation successful/i);
            assert.match(invitationOnly.text, /does not establish signup completion/);

            // Changing an exact key clears the previous record before a new read.
            await subject.fill('synthetic:changed'); assert.equal(await page.locator('#adminLookupResult').isHidden(), true);
            await fill(); mode = 'pending'; await submit.click();
            await page.getByRole('button', { name: 'Cancel lookup', exact: true }).waitFor();
            await page.waitForFunction(() => document.getElementById('adminLookupForm').getAttribute('aria-busy') === 'true');
            assert.equal(await submit.isDisabled(), true);
            await page.getByRole('button', { name: 'Cancel lookup', exact: true }).click();
            assert.equal(await page.locator('#adminLookupResult').isHidden(), true);
            mode = 'found'; await submit.click(); await page.getByRole('heading', { name: 'Scoped access records found', exact: true }).waitFor();
            pending();
            await page.waitForFunction(() => !document.getElementById('adminLookupSubmit').disabled);
            assert.doesNotMatch(await page.locator('#adminLookupResult').innerText(), /Stale synthetic result/);
            mode = '503'; await submit.click(); await page.waitForFunction(() => document.getElementById('adminLookupStatus').textContent.includes('Lookup unavailable'));
            assert.equal(await page.locator('#adminLookupResult').isHidden(), true);
            assert.doesNotMatch(await page.locator('body').innerText(), /private-diagnostic-canary/);
            mode = 'not_found'; await submit.click(); await page.getByRole('heading', { name: 'No membership in this exact scope', exact: true }).waitFor();
            assert.match(await page.locator('#adminLookupResult').innerText(), /another provider or in another scope/);
            mode = 'mismatch'; await submit.click(); await page.waitForFunction(() => document.getElementById('adminLookupStatus').textContent.includes('Lookup unavailable'));
            assert.equal(await page.locator('#adminLookupResult').isHidden(), true);
            mode = 'case-mismatch'; await submit.click(); await page.waitForFunction(() => document.getElementById('adminLookupStatus').textContent.includes('Lookup unavailable'));
            assert.equal(await page.locator('#adminLookupResult').isHidden(), true);
            mode = 'unsafe-text'; await submit.click(); await page.getByRole('heading', { name: 'Scoped access records found', exact: true }).waitFor();
            assert.match(await page.locator('#adminLookupResult').innerText(), /<img src=x onerror=alert\(1\)>/);
            assert.equal(await page.locator('#adminLookupResult img').count(), 0);
            mode = '403'; await submit.click(); await page.waitForFunction(() => document.getElementById('adminLookupFields').disabled);
            assert.equal(await page.locator('#adminLookupResult').isHidden(), true); assert.equal(await subject.inputValue(), '');
            capability = { lookup: false, recovery: [] }; await page.getByRole('button', { name: 'Check access again' }).click();
            await page.waitForFunction(() => document.getElementById('adminAccessStatus').textContent.includes('Lookup capability is unavailable'));
            assert.equal(await subject.isDisabled(), true);
            capabilityStatus = 503; await page.getByRole('button', { name: 'Check access again' }).click();
            await page.waitForFunction(() => document.getElementById('adminAccessStatus').textContent.includes('could not be checked'));
            capabilityStatus = 200; capability = { lookup: true, recovery: [] }; await page.getByRole('button', { name: 'Check access again' }).click();
            await page.waitForFunction(() => !document.getElementById('adminLookupFields').disabled);
            mode = '401'; await fill(); await submit.click(); await page.getByRole('link', { name: 'Sign in to staff workspace' }).waitFor();
            assert.equal(await subject.isDisabled(), true); assert.equal(await subject.inputValue(), '');
            assert.equal(await page.getByRole('link', { name: 'Sign in to staff workspace' }).getAttribute('href'), '/api/auth/login?returnTo=%2Fdashboard-admin%2Fentry');
            violations.push(...await page.evaluate(() => window.adminCspViolations));
            results.push({ width, layout, keyboard: true, cancelAndRepeat: true, errorAndPermissionStates: true,
                canonicalServiceProjection: true, mixedCaseNonUuidScope: true, caseMismatchRejected: true,
                invitationOnlyNeutralResult: true, noAccountMutation: true });
            await context.close();
        }
        assert.deepEqual(outside, []); assert.deepEqual(pageErrors, []); assert.deepEqual(violations, []);
    } catch (error) { failure = error; }
    finally {
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
        const sources = ['lib/dashboardAdminDocument.js', 'api/shared/protectedAssets/dashboardAdmin.js', 'test/dashboardAdminUi.test.js',
            'scripts/tests/dashboard-admin-browser.cjs', 'api/shared/dashboardAdmin/service.js', 'api/shared/dashboardAdmin/readProjection.js'];
        fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ syntheticOnly: true, results, outside, pageErrors, violations,
            lookupCount: lookupRequests.length, sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
            failure: failure?.message || null }, null, 2), { mode: 0o600 });
        process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: !failure, widths: results.map(item => item.width), artifacts }) + '\n');
        if (failure) { process.stderr.write(failure.stack + '\n'); process.exitCode = 1; }
    }
})();
