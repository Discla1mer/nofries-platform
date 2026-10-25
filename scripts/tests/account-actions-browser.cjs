'use strict';

// Synthetic loopback browser acceptance; uses already-installed Playwright.
// Run: node scripts/tests/account-actions-browser.cjs
// NOFRIES_ACTIONS_BASELINE=1 uses the deployed baseline's three changed sources
// as a causal negative control without altering the working tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildGatewayDocument } = require('../../lib/gatewayDocument');
const { buildHostedSignupDocument } = require('../../lib/signupDocument');

const root = path.resolve(__dirname, '../..');
const baseline = process.env.NOFRIES_ACTIONS_BASELINE === '1';
const changed = ['index.html', 'home.css', 'api/shared/customerSignup/signupJourney.js'];
const read = file => baseline && changed.includes(file)
    ? execFileSync('git', ['show', '5cf1ac5ad3f69247f9b00c6c571b8b156464ce35:' + file], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, file), 'utf8');
const bundleFiles = ['dashboardRegistry', 'dashboardShell', 'ncscAssessmentClient', 'ncscQuestionnaire', 'organisationPicture'];
const gateway = buildGatewayDocument({ customerLogin: true, template: read('index.html'),
    loaderSource: read('js/dashboard-loader.js'), protectedStyleSource: read('app/dashboard.css'),
    protectedAppSource: bundleFiles.map(file => read('api/shared/protectedAssets/' + file + '.js')).join('\n') });
const signup = buildHostedSignupDocument({ clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js') });
const assets = ['style.css', 'home.css', 'js/organisation-setup.js', 'js/home.js', 'js/prospect-assistant.js',
    'images/nofrieslogo.png', 'favicon.svg'];
const sources = [...changed, 'lib/signupDocument.js', 'lib/gatewayDocument.js', 'js/dashboard-loader.js',
    'api/shared/customerSignup/signupClient.js', 'scripts/tests/account-actions-browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(read(file)).digest('hex')]));
const before = hashes();
const artifacts = fs.mkdtempSync('/tmp/nofries-account-actions-');
let state = { status: 'create_account' }, status = 200, base;
const results = [], violations = [], errors = [], requests = [];
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push({ method: req.method, pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { violations.push({ method: req.method, pathname }); res.statusCode = 405; return res.end(); }
    if (pathname === '/' || pathname === '/signup') {
        const doc = pathname === '/' ? gateway : signup;
        res.setHeader('Content-Security-Policy', doc.contentSecurityPolicy);
        res.setHeader('Content-Type', 'text/html'); return res.end(doc.html);
    }
    if (assets.includes(pathname.slice(1))) {
        const file = pathname.slice(1);
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(file.endsWith('.png') ? fs.readFileSync(path.join(root, file)) : read(file));
    }
    res.setHeader('Content-Type', 'application/json');
    if (pathname === '/api/dashboard/session') { res.statusCode = 401; return res.end(JSON.stringify({ code: 'dashboard_session_required' })); }
    if (['/api/external-customer-signup/state', '/api/customer-signup/state'].includes(pathname)) {
        res.statusCode = status; return res.end(JSON.stringify({ state,
            ...(['setup_details', 'resume_setup'].includes(state.status) ? { csrfToken: 'c'.repeat(43) } : {}) }));
    }
    violations.push({ method: req.method, pathname }); res.statusCode = 404; res.end('{}');
});
async function geometry(page, name) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('main,section,button,a,input,select')]
        .filter(el => el.getClientRects().length && !el.closest('dialog:not([open])') && !el.classList.contains('skip-link'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; })
        .map(el => el.id || el.className));
    assert.deepEqual(overflow, [], name + ' has no clipped controls');
    await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
}
(async () => {
    let browser, failure;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin === base) return route.continue();
                violations.push({ external: true }); return route.abort();
            });
            await page.addInitScript(() => {
                window.cspViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.effectiveDirective));
            });
            await page.goto(base);
            await page.waitForFunction(() => document.body.dataset.dashboardState === 'unauthenticated');
            const visibleEntry = page.locator('a[href="/login"]:visible');
            await geometry(page, 'gateway-' + width);
            assert.equal(await visibleEntry.count(), 1, 'one public account-entry action');
            assert.equal(await visibleEntry.evaluate(el => el.closest('section').id), 'create-organisation');
            if (width < 980) {
                const card = await page.locator('#create-organisation').boundingBox();
                const intro = await page.locator('.home-intro').boundingBox();
                assert.ok(card.y < intro.y && card.y + card.height < 900, 'mobile account action appears before introduction within first viewport');
            }
            await page.locator('#dashboardSkipLink').focus(); await page.keyboard.press('Enter');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.closest('section')?.id), 'create-organisation');
            const outline = await visibleEntry.evaluate(el => getComputedStyle(el).outlineStyle);
            assert.notEqual(outline, 'none');
            // Exercise the existing recovery panel presentation without simulating authority.
            await page.evaluate(() => { document.getElementById('dashboardStatusPanel').hidden = false;
                document.getElementById('dashboardSignIn').hidden = false; });
            assert.equal(await page.locator('a[href="/login"]:visible, #dashboardSignIn:visible').count(), 1);
            assert.equal(await page.locator('#dashboardSignIn').isVisible(), true);
            assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
            results.push({ width, gateway: true, recoveryPanel: true, keyboard: true });

            for (const suffix of ['', '&account=choose', '&signin=expired']) {
                state = { status: 'create_account' }; status = 200;
                await page.goto(base + '/signup?provider=external' + suffix);
                await page.locator('#signup > .signup-entry-action').waitFor();
                assert.equal(await page.locator('#signup > button:visible').count(), 1);
                assert.equal(await page.locator('.signup-help').isVisible(), false, 'entry already supplies the sign-in action');
                const target = page.locator('#signup > button');
                if (suffix === '&account=choose') {
                    await target.evaluate(el => { el.disabled = true; });
                    assert.equal(await page.locator('.signup-help').isVisible(), true, 'disabled primary restores shell account access');
                    assert.equal(await page.locator('#signup-return-to-login').getAttribute('href'), '/api/external-customer-auth/login?account=choose');
                    await geometry(page, 'signup-disabled-fallback-' + width);
                    await target.evaluate(el => { el.disabled = false; el.hidden = true; });
                    assert.equal(await page.locator('.signup-help').isVisible(), true, 'hidden primary restores shell account access');
                    await target.evaluate(el => { el.hidden = false; });
                    assert.equal(await page.locator('.signup-help').isVisible(), false);
                }
                await page.keyboard.press('Tab');
                assert.equal(await target.evaluate(el => el === document.activeElement), true);
                const box = await target.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44);
                await geometry(page, 'signup-' + width + (suffix.replace(/[^a-z]/g, '-') || '-entry'));
                assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
                results.push({ width, signup: suffix || 'new', onePrimary: true, keyboard: true });
            }
            status = 503; state = { status: 'unavailable' };
            const interruptedReadStart = requests.length;
            await page.goto(base + '/signup?provider=external');
            await page.getByRole('heading', { name: 'Signup is unavailable', exact: true }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Check setup status', exact: true }).count(), 0);
            assert.equal(await page.getByText('Error code: NF-SIGNUP-UNCONFIRMED', { exact: true }).count(), 1);
            assert.equal(await page.getByText('We could not confirm your account setup. Do not create another account or submit your details again.', { exact: true }).count(), 1);
            assert.equal(requests.slice(interruptedReadStart).filter(request => request.pathname === '/api/external-customer-signup/state').length, 1);
            state = { status: 'resume_setup', email: 'synthetic@example.test', accountType: 'company', organisationName: 'Synthetic saved company' }; status = 200;
            // A deliberate fresh navigation performs the existing authority
            // read. The unavailable view has no in-place status retry action.
            await page.reload();
            await page.getByRole('button', { name: 'Resume workspace setup', exact: true }).waitFor();
            assert.equal(await page.locator('#signup h1').evaluate(el => el === document.activeElement), true);
            assert.equal(await page.locator('.signup-help').isVisible(), false);
            assert.equal(requests.slice(interruptedReadStart).filter(request => request.pathname === '/api/external-customer-signup/state').length, 2);
            await geometry(page, 'signup-recovered-' + width);
            await page.reload();
            await page.getByRole('button', { name: 'Resume workspace setup', exact: true }).waitFor();
            results.push({ width, unavailableHasFixedCode: true, unavailableHasNoStatusRetry: true,
                freshNavigationRecovery: true, savedSetupReload: true });
            await context.close();
        }
        assert.deepEqual(violations, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
    } catch (error) { failure = error.message; process.exitCode = 1; }
    finally {
        const result = { passed: !failure, failure, baseline, syntheticOnly: true, results, errors, violations, requests,
            artifacts, browser: browser?.version(), sourceHashesBefore: before, sourceHashesAfter: hashes() };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ passed: !failure, failure, cases: results.length, artifacts }));
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
})();
