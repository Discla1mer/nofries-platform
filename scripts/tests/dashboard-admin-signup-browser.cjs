'use strict';
// Synthetic local HTTPS + genuine BFF codec + real queue service/handler/assets.
// Never points at production or contacts a provider.
const assert = require('node:assert/strict'), https = require('node:https'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { createDashboardAdminHandlers } = require('../../api/shared/dashboardAdmin/handlers');
const { createSignupListService } = require('../../api/shared/dashboardAdmin/signupService');
const { readBrowserSessionDetails } = require('../../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const f = require('../../test/fixtures/dashboardAdminSignupFixture');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-signup-queue-')); fs.chmodSync(artifacts, 0o700);
(async () => {
    let browser, server, failure, mode = 'available', sourceCalls = 0, pending = null, pendingEntered = null, permitted = true;
    const outside = [], pageErrors = [], results = [], events = [];
    const store = new MemoryBrowserSessionStore(), token = Buffer.alloc(32, 9).toString('base64url');
    const identity = { ...f.principal, tenantId: f.TENANT, principalId: f.uid(3), email: 'operator@example.invalid', name: 'Synthetic operator' };
    await store.createSession(token, { v: 1, kind: 'browser_session', issuedAt: Date.parse(f.NOW) - 1000,
        idleExpiresAt: Date.parse(f.NOW) + 600000, absoluteExpiresAt: Date.parse(f.NOW) + 600000, identity });
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: f.TENANT, NOFRIES_ENTRA_CLIENT_ID: f.uid(9),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-browser-only', NOFRIES_ALLOWED_SUBJECTS: f.ACTOR, NOFRIES_ADMIN_SUBJECTS: f.ACTOR };
    const service = createSignupListService({ authoriseSignupList: async () => permitted ? f.grant() : false,
        readSignupPage: async input => {
            sourceCalls++;
            if (mode === 'pending') {
                await new Promise(resolve => { pending = resolve; pendingEntered(); });
                const stale = f.record(99); stale.account.value.organisation = 'STALE SYNTHETIC PAGE';
                return f.page([stale]);
            }
            if (mode === 'unavailable') throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC');
            if (mode === 'empty') return f.page([]);
            const p = f.page([f.record(input.cursor ? 2 : 1)], input.cursor ? null : 'private-source-next');
            if (mode === 'unknown') for (const key of ['account', 'setup', 'acceptance', 'registration']) p.records[0][key] = { state: 'unknown' };
            return p;
        }, audit: async event => { events.push(event); return f.ack(event); }, clock: () => f.NOW });
    const handler = createDashboardAdminHandlers({ signupListService: service, env,
        readOperatorSession: header => readBrowserSessionDetails(header, { env, store, now: () => Date.parse(f.NOW) }) });
    const forge = require('node-forge'), pair = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = forge.pki.publicKeyFromPem(pair.publicKey.export({ type: 'spki', format: 'pem' }));
    certificate.serialNumber = '01'; certificate.validity.notBefore = new Date(Date.now() - 60000); certificate.validity.notAfter = new Date(Date.now() + 3600000);
    certificate.setSubject([{ name: 'commonName', value: '127.0.0.1' }]); certificate.setIssuer(certificate.subject.attributes);
    certificate.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
    certificate.sign(forge.pki.privateKeyFromPem(key), forge.md.sha256.create());
    server = https.createServer({ key, cert: forge.pki.certificateToPem(certificate) }, async (req, res) => {
        if (req.url === '/favicon.svg') { res.statusCode = 204; return res.end(); }
        req.originalUrl = req.url;
        const route = req.url === '/dashboard-admin' ? 'document' : req.url.startsWith('/api/dashboard-admin/') ? req.url.slice('/api/dashboard-admin/'.length) : null;
        const result = await handler.handle(req, route);
        if (res.destroyed) return;
        res.writeHead(result.status, result.headers); res.end(result.isRaw ? result.body : JSON.stringify(result.body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://127.0.0.1:' + server.address().port; env.NOFRIES_PUBLIC_URL = origin;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 768, 390, 320]) {
            mode = 'available'; permitted = true;
            const context = await browser.newContext({ viewport: { width, height: 950 }, ignoreHTTPSErrors: true });
            // Ephemeral localhost TLS only; no production credentials or traffic.
            await context.addCookies([{ name: '__Host-nofries-auth', value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
            await context.route('**/*', route => {
                const req = route.request();
                if (new URL(req.url()).origin !== origin) { outside.push(req.url()); return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => pageErrors.push(e.message));
            await page.addInitScript(() => { window.cspViolations = []; document.addEventListener('securitypolicyviolation', e => window.cspViolations.push(e.effectiveDirective)); });
            await page.goto(origin + '/dashboard-admin');
            const load = page.getByRole('button', { name: 'Load signups', exact: true }), next = page.getByRole('button', { name: 'Next page', exact: true });
            await page.waitForFunction(() => !document.getElementById('signupQueueLoad').disabled);
            assert.equal(await page.locator('#adminLookupFields').evaluate(node => node.disabled), true, 'queue permission does not enable diagnostic lookup');
            await load.focus(); await page.keyboard.press('Space');
            await page.getByText('person1@example.invalid', { exact: true }).waitFor();
            assert.equal(await page.locator('#signupQueueResultHeading').evaluate(n => document.activeElement === n), true);
            await load.focus(); await page.keyboard.press('Tab'); assert.equal(await next.evaluate(n => document.activeElement === n), true);
            await page.keyboard.press('Enter'); await page.getByText('person2@example.invalid', { exact: true }).waitFor();
            assert.equal(await next.isDisabled(), true); assert.equal(await page.getByText('person1@example.invalid', { exact: true }).count(), 0);
            const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1,
                controls: ['signupQueueLoad', 'signupQueueNext', 'signupQueueCheck'].map(id => document.getElementById(id).getBoundingClientRect().height), violations: window.cspViolations }));
            assert.equal(layout.overflow, false); assert.ok(layout.controls.every(height => height >= 44)); assert.deepEqual(layout.violations, []);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, 'signup-queue-' + width + '.png'), fullPage: true });
            mode = 'pending';
            const entered = new Promise(resolve => { pendingEntered = resolve; });
            await load.click();
            let enteredTimer;
            try { await Promise.race([entered, new Promise((_, reject) => { enteredTimer = setTimeout(() => reject(new Error('Pending source was not entered')), 5000); })]); } finally { clearTimeout(enteredTimer); }
            await page.getByRole('button', { name: 'Cancel loading signups' }).click();
            assert.equal(await page.locator('#signupQueueResult').isHidden(), true); assert.equal(await load.evaluate(n => document.activeElement === n), true);
            mode = 'available'; await load.click(); await page.getByText('person1@example.invalid', { exact: true }).waitFor();
            assert.equal(typeof pending, 'function'); pending(); pending = null;
            await page.waitForTimeout(100);
            assert.doesNotMatch(await page.locator('#signupQueueResult').innerText(), /STALE SYNTHETIC PAGE|person99/);
            mode = 'unavailable'; await load.click(); await page.getByText('Signup records are unavailable. This is not an empty population.').waitFor();
            assert.equal(await page.locator('#signupQueueResult').isHidden(), true);
            mode = 'empty'; await load.click(); await page.getByRole('heading', { name: 'No signup records in this approved page' }).waitFor();
            mode = 'unknown'; await load.click(); await page.getByRole('heading', { name: 'Email unknown', exact: true }).waitFor();
            permitted = false; await load.click(); await page.waitForFunction(() => document.getElementById('signupQueueLoad').disabled);
            assert.equal(await page.locator('#signupQueueResult').isHidden(), true);
            assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_PROVIDER_DIAGNOSTIC|person1@example.invalid|private-source-next/);
            results.push({ width, keyboard: true, noOverflow: true, cancellation: true, permissions: true, unavailableAndUnknown: true });
            await context.close();
        }
        assert.deepEqual(outside, []); assert.deepEqual(pageErrors, []);
        assert.ok(sourceCalls > 0 && events.some(event => event.outcome === 'unavailable'));
    } catch (error) { failure = error; }
    finally {
        if (pending) pending();
        if (browser) await browser.close();
        if (server) await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ syntheticOnly: true, passed: !failure, results, sourceCalls, auditEvents: events.length, outside, pageErrors }, null, 2));
        process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: !failure, widths: results.map(r => r.width), artifacts }) + '\n');
    }
    if (failure) throw failure;
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
