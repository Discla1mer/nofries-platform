'use strict';
// Focused F03/F04 presentation regression using PR580's genuine synthetic BFF,
// HTTPS handler and queue service. No production accounts or provider traffic.
// Optional --baseline-css=<local file> serves immutable retained CSS as a causal
// control; failed acceptance assertions are collected and still exit nonzero.
const assert = require('node:assert/strict'), https = require('node:https'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { createDashboardAdminHandlers } = require('../../api/shared/dashboardAdmin/handlers');
const { createDashboardAdminService } = require('../../api/shared/dashboardAdmin/service');
const { createSignupListService } = require('../../api/shared/dashboardAdmin/signupService');
const { readBrowserSessionDetails } = require('../../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const f = require('../../test/fixtures/dashboardAdminSignupFixture');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-admin-presentation-')); fs.chmodSync(artifacts, 0o700);
const baselinePath = process.argv.find(arg => arg.startsWith('--baseline-css='))?.slice('--baseline-css='.length);
const baselineCss = baselinePath ? fs.readFileSync(baselinePath, 'utf8') : null;
const cssSha256 = require('node:crypto').createHash('sha256').update(baselineCss ?? require('../../lib/dashboardAdminDocument').dashboardAdminCss).digest('hex');
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
function contrast(a, b) {
    const foreground = a.match(/[\d.]+/g).map(Number), background = b.match(/[\d.]+/g).map(Number);
    assert.ok(background.length === 3 || background[3] === 1, 'Contrast measurement needs an opaque adjacent background');
    const alpha = foreground.length === 4 ? foreground[3] : 1;
    const luminance = colour => {
        const channels = colour.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const x = luminance(foreground.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha))), y = luminance(background);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
(async () => {
    let browser, server, failure, mode = 'available', sourceCalls = 0, pending = null, pendingEntered = null, permitted = true, lookupPermitted = true, lookupReads = 0;
    const outside = [], pageErrors = [], results = [], controls = [], events = [];
    const longOrganisation = 'Synthetic-' + 'Organisation'.repeat(9);
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
            p.records[0].account.value.organisation = longOrganisation;
            if (mode === 'unknown') for (const key of ['account', 'setup', 'acceptance', 'registration']) p.records[0][key] = { state: 'unknown' };
            return p;
        }, audit: async event => { events.push(event); return f.ack(event); }, clock: () => f.NOW });
    const lookup = createDashboardAdminService({ requestBudgetMs: 1000, clock: () => f.NOW, audit: async () => true,
        authoriseOperator: async ({ principal }) => lookupPermitted && principal.subjectKey === f.ACTOR,
        readAuthoritySnapshot: async () => { lookupReads++; throw new Error('Presentation fixture never performs identity lookup'); } });
    const handler = createDashboardAdminHandlers({ service: lookup, signupListService: service, env,
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
        if (route === 'app.css' && result.status === 200 && baselineCss !== null) result.body = baselineCss;
        res.writeHead(result.status, result.headers); res.end(result.isRaw ? result.body : JSON.stringify(result.body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://127.0.0.1:' + server.address().port; env.NOFRIES_PUBLIC_URL = origin;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 768, 390, 320]) for (const rootSize of [16, 32]) {
            mode = 'available'; permitted = true; lookupPermitted = true;
            const label = width + 'px/' + rootSize + 'px';
            const context = await browser.newContext({ viewport: { width, height: 950 }, ignoreHTTPSErrors: true });
            await context.addCookies([{ name: '__Host-nofries-auth', value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
            await context.route('**/*', route => {
                const req = route.request();
                if (new URL(req.url()).origin !== origin) { outside.push(req.url()); return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', e => pageErrors.push(e.message));
            await page.addInitScript(() => { window.cspViolations = []; document.addEventListener('securitypolicyviolation', e => window.cspViolations.push(e.effectiveDirective)); });
            await page.goto(origin + '/dashboard-admin');
            // Browser-only text enlargement; application CSS/DOM and API data are
            // otherwise real. This is a stress check, not a full zoom audit.
            await page.evaluate(size => { document.documentElement.style.fontSize = size + 'px'; }, rootSize);
            const load = page.locator('#signupQueueLoad'), next = page.locator('#signupQueueNext');
            const subject = page.locator('#adminSubject');
            await page.waitForFunction(() => !document.getElementById('signupQueueLoad').disabled && !document.getElementById('adminLookupFields').disabled);
            async function measure(state) {
                const layout = await page.evaluate(() => {
                    const viewport = innerWidth, visible = n => n.getClientRects().length > 0;
                    const clipped = [];
                    for (const n of document.querySelectorAll('main h1, main h2, main h3, main p, main dt, main dd, label, legend, button, header a')) {
                        if (!visible(n)) continue;
                        const rect = n.getBoundingClientRect();
                        if (rect.left < -1 || rect.right > viewport + 1) clipped.push(n.id || n.tagName);
                        // Test rendered text, not just the element box. This catches
                        // overflow hidden/clip being used to hide an unfixed heading.
                        const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
                        while (walker.nextNode()) {
                            if (!walker.currentNode.textContent.trim() || walker.currentNode.parentElement.closest('select')) continue;
                            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                            if ([...range.getClientRects()].some(r => r.left < -1 || r.right > viewport + 1)) clipped.push((n.id || n.tagName) + ':text');
                        }
                    }
                    const sizes = ['h1', 'h2', 'h3', 'body'].map(selector => { const n = document.querySelector(selector); return n ? parseFloat(getComputedStyle(n).fontSize) : null; });
                    return { documentWidth: document.documentElement.scrollWidth, viewport, clipped, sizes,
                        targets: [...document.querySelectorAll('input:not([type=hidden]), select, button')].filter(visible).map(n => ({ id: n.id || 'signout', height: n.getBoundingClientRect().height })),
                        violations: window.cspViolations };
                });
                check(layout.documentWidth <= width + 1, label + '/' + state + ': document width ' + layout.documentWidth);
                check(!layout.clipped.length, label + '/' + state + ': text/control overflow ' + layout.clipped.join(','));
                check(layout.targets.every(target => target.height >= 44), label + '/' + state + ': target under44px');
                check(layout.sizes[0] > layout.sizes[1] && (!layout.sizes[2] || layout.sizes[1] > layout.sizes[2]), label + '/' + state + ': heading hierarchy');
                check(layout.sizes[3] === rootSize, label + '/' + state + ': text enlargement');
                assert.deepEqual(layout.violations, []);
                results.push({ width, rootSize, state, ...layout });
            }
            async function control(state, expectedFocused = null, expectedHovered = null) {
                const values = await page.evaluate(() => ['adminSubject', 'adminTenant', 'adminOrganisation', 'adminProvider'].map(id => {
                    const n = document.getElementById(id), style = getComputedStyle(n), rect = n.getBoundingClientRect();
                    return { id, disabled: n.matches(':disabled'), border: style.borderTopColor, borderWidth: parseFloat(style.borderTopWidth),
                        background: style.backgroundColor, adjacent: getComputedStyle(n.closest('.admin-panel')).backgroundColor,
                        outline: style.outlineColor, outlineWidth: parseFloat(style.outlineWidth),
                        outlineStyle: style.outlineStyle, focused: n.matches(':focus-visible'), hovered: n.matches(':hover'),
                        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight,
                        forced: matchMedia('(forced-colors: active)').matches };
                }));
                if (expectedFocused) assert.equal(values.find(value => value.id === expectedFocused).focused, true, 'Actual keyboard focus: ' + expectedFocused);
                if (expectedHovered) assert.equal(values.find(value => value.id === expectedHovered).hovered, true, 'Actual pointer hover: ' + expectedHovered);
                for (const value of values) {
                    value.borderContrast = contrast(value.border, value.background);
                    value.outerContrast = contrast(value.border, value.adjacent);
                    if (!value.disabled) check(value.borderWidth >= 1 && Math.min(value.borderContrast, value.outerContrast) >= 3,
                        label + '/' + state + '/' + value.id + ': enabled boundary ' + Math.min(value.borderContrast, value.outerContrast).toFixed(3));
                    if (value.focused) {
                        value.focusContrast = contrast(value.outline, value.adjacent);
                        check(value.outlineStyle !== 'none' && value.outlineWidth >= 2 && value.focusContrast >= 3, label + '/' + state + ': visible focus');
                        check(value.left >= 6 && value.right <= width - 6 && value.top >= 6 && value.bottom <= value.viewportHeight - 6,
                            label + '/' + state + ': focus indicator outside viewport');
                    }
                }
                controls.push({ width, rootSize, state, values });
            }
            await measure('ready'); await control('default');
            for (const id of ['adminSubject', 'adminTenant', 'adminOrganisation', 'adminProvider']) {
                await page.locator('#' + id).hover(); await control('hover-' + id, null, id);
            }
            // Ordinary keyboard navigation from page entry, including skip link.
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('.skip-link').evaluate(n => n === document.activeElement), true);
            await page.keyboard.press('Enter');
            for (let tab = 0; tab < 12 && !await subject.evaluate(n => n === document.activeElement); tab++) await page.keyboard.press('Tab');
            assert.equal(await subject.evaluate(n => n === document.activeElement), true);
            await control('keyboard-focus-subject', 'adminSubject');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.locator('#adminProvider').evaluate(n => n === document.activeElement), true);
            await control('keyboard-focus-provider', 'adminProvider');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab'); await control('keyboard-focus-tenant', 'adminTenant');
            await page.keyboard.press('Tab'); await control('keyboard-focus-organisation', 'adminOrganisation');
            await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
            await page.keyboard.type(f.SUBJECT);
            assert.equal(await subject.inputValue(), f.SUBJECT);
            await subject.fill('');
            await page.emulateMedia({ forcedColors: 'active' });
            await control('forced-colours-focus-subject', 'adminSubject');
            await page.keyboard.press('Shift+Tab'); await control('forced-colours-focus-provider', 'adminProvider');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab'); await control('forced-colours-focus-tenant', 'adminTenant');
            await page.keyboard.press('Tab'); await control('forced-colours-focus-organisation', 'adminOrganisation');
            await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
            await page.emulateMedia({ forcedColors: 'none' });
            // Reach load using native Tab from the lookup controls, then activate.
            for (let tab = 0; tab < 12 && !await load.evaluate(n => n === document.activeElement); tab++) await page.keyboard.press('Tab');
            assert.equal(await load.evaluate(n => n === document.activeElement), true);
            await page.keyboard.press('Space');
            await page.getByText(longOrganisation, { exact: true }).waitFor();
            await measure('loaded-long-name');
            assert.equal(await page.locator('#signupQueueResultHeading').evaluate(n => n === document.activeElement), true);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, width + '-' + rootSize + '-loaded.png'), fullPage: true });
            // Paging and fresh requests still work after resizing and keyboard use.
            await next.click(); await page.getByText('person2@example.invalid', { exact: true }).waitFor();
            assert.equal(await next.isDisabled(), true);
            mode = 'pending';
            const entered = new Promise(resolve => { pendingEntered = resolve; });
            await load.click();
            let timer;
            try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pending source not entered')), 5000); })]); } finally { clearTimeout(timer); }
            await measure('loading');
            await page.locator('#signupQueueCancel').click();
            assert.equal(await load.evaluate(n => n === document.activeElement), true);
            assert.equal(await page.locator('#signupQueueResult').isHidden(), true);
            await measure('cancelled');
            pending(); pending = null;
            mode = 'available'; await load.click(); await page.getByText(longOrganisation, { exact: true }).waitFor();
            assert.doesNotMatch(await page.locator('#signupQueueResult').innerText(), /STALE SYNTHETIC PAGE|person99/);
            mode = 'unavailable'; await load.click(); await page.getByText('Signup records are unavailable. This is not an empty population.').waitFor(); await measure('unavailable');
            mode = 'empty'; await load.click(); await page.getByRole('heading', { name: 'No signup records in this approved page' }).waitFor(); await measure('empty');
            mode = 'unknown'; await load.click(); await page.getByRole('heading', { name: 'Email unknown', exact: true }).waitFor(); await measure('unknown');
            permitted = false; lookupPermitted = false; await load.click();
            await page.waitForFunction(() => document.getElementById('signupQueueLoad').disabled && document.getElementById('adminLookupFields').disabled);
            await measure('revoked'); await control('disabled');
            assert.equal(await subject.isDisabled(), true);
            await page.emulateMedia({ forcedColors: 'active' }); await control('forced-colours-disabled');
            await page.emulateMedia({ forcedColors: 'none' });
            // Lookup capability by itself must leave queue absent and no rows.
            lookupPermitted = true;
            await page.locator('#adminCheckAccess').click();
            await page.waitForFunction(() => !document.getElementById('adminLookupFields').disabled);
            await page.locator('#signupQueueCheck').click();
            await page.getByText('Signup capability is unavailable. No signup records have been loaded.').waitFor();
            assert.equal(await load.isDisabled(), true);
            await measure('capability-absent');
            assert.equal(await page.locator('#signupQueueResult').isHidden(), true);
            assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_PROVIDER_DIAGNOSTIC|person1@example.invalid|private-source-next|STALE SYNTHETIC PAGE/);
            await context.close();
        }
        assert.deepEqual(outside, []); assert.deepEqual(pageErrors, []); assert.equal(lookupReads, 0);
        assert.ok(sourceCalls > 0 && events.length > 0);
        if (failures.length) throw new Error(failures.length + ' presentation assertions failed: ' + failures.slice(0, 5).join('; '));
    } catch (error) { failure = error; }
    finally {
        if (pending) pending();
        if (browser) await browser.close();
        if (server) await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ syntheticOnly: true, baseline: baselinePath || null, cssSha256,
            passed: !failure, failure: failure?.message, failures, results, controls, sourceCalls, auditEvents: events.length, lookupReads, outside, pageErrors }, null, 2));
        process.stdout.write(JSON.stringify({ syntheticOnly: true, baseline: Boolean(baselinePath), passed: !failure, cases: results.length, failures: failures.length, artifacts }) + '\n');
    }
    if (failure) throw failure;
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
