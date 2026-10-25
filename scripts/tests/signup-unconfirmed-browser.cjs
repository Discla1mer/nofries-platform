'use strict';

// Focused synthetic loopback acceptance. Uses installed Playwright/Chromium;
// never signs in, submits details or contacts a provider/production service.
// Run: node scripts/tests/signup-unconfirmed-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildSignupDocument, buildHostedSignupDocument } = require('../../lib/signupDocument');
const { withHashBoundSharedAssistantDocument } = require('../../lib/withHashBoundSharedAssistantDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sourceFiles = ['api/shared/customerSignup/signupJourney.js', 'api/shared/customerSignup/signupClient.js',
    'lib/signupDocument.js', 'lib/withHashBoundSharedAssistantDocument.js', 'lib/withSharedAssistantDocument.js',
    'lib/sharedAssistantDocument.js', 'js/prospect-assistant.js', 'js/shared-assistant.js',
    'style.css', 'home.css', 'shared-assistant.css', 'images/nofrieslogo.png', 'images/fry-chat.png',
    'scripts/tests/signup-unconfirmed-browser.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceHashes = hashes();
const sources = { clientSource: read(sourceFiles[1]), journeySource: read(sourceFiles[0]) };
const wrap = document => withHashBoundSharedAssistantDocument(document,
    { prospectSource: read('js/prospect-assistant.js'), sharedSource: read('js/shared-assistant.js') });
const documents = {
    dynamic: wrap(buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' })),
    hosted: wrap(buildHostedSignupDocument(sources))
};
const assets = new Set(['style.css', 'home.css', 'shared-assistant.css', 'images/nofrieslogo.png',
    'images/fry-chat.png', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']);
const statePath = '/api/external-customer-signup/state';
const code = 'Error code: NF-SIGNUP-UNCONFIRMED';
const reason = 'We could not confirm your account setup. Do not create another account or submit your details again.';
const sentinel = 'SYNTHETIC_UNTRUSTED_PROVIDER_DETAIL';
const reference = 'NF-0123456789ABCDEF';
const publicDiagnostic = { stage: 'workspace_preparation', reason: 'setup_information_unavailable' };
const cases = [
    { name: 'dynamic-503-desktop', document: 'dynamic', width: 1440, status: 503 },
    { name: 'hosted-unavailable-mobile', document: 'hosted', width: 320, state: 'unavailable' },
    { name: 'hosted-503-mobile-text-200', document: 'hosted', width: 320, status: 503, textScale: 2 },
    { name: 'dynamic-network-desktop', document: 'dynamic', width: 1440, network: true },
    { name: 'hosted-network-mobile', document: 'hosted', width: 320, network: true },
    { name: 'hosted-repeated-navigation', document: 'hosted', width: 320, status: 503, visits: 2 },
    { name: 'dynamic-recorded-step-desktop', document: 'dynamic', width: 1440, status: 503, diagnostic: publicDiagnostic },
    { name: 'hosted-recorded-step-mobile-text-200', document: 'hosted', width: 320, state: 'unavailable', textScale: 2, diagnostic: publicDiagnostic },
    { name: 'hosted-unknown-diagnostic-mobile', document: 'hosted', width: 320, status: 503,
        diagnostic: { stage: 'unknown_public_stage', reason: 'unknown_public_reason' } },
    { name: 'dynamic-malicious-diagnostic-desktop', document: 'dynamic', width: 1440, status: 503,
        diagnostic: { stage: '<img src=x onerror="' + sentinel + '">', reason: sentinel } },
    { name: 'hosted-half-diagnostic-mobile', document: 'hosted', width: 320, status: 503,
        diagnostic: { stage: publicDiagnostic.stage } },
    { name: 'dynamic-no-diagnostic-response-desktop', document: 'dynamic', width: 1440, status: 503, noMetadata: true },
    { name: 'dynamic-pending-preparation-mobile', document: 'dynamic', width: 320, state: 'pending_preparation', diagnostic: publicDiagnostic },
    { name: 'hosted-pending-admission-desktop', document: 'hosted', width: 1440, state: 'pending_admission' },
    { name: 'dynamic-complete-company', document: 'dynamic', width: 1440, state: 'continue_to_dashboard', accountType: 'company' },
    { name: 'hosted-complete-consultant', document: 'hosted', width: 320, state: 'continue_to_dashboard', accountType: 'consultant', diagnostic: publicDiagnostic }
];
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-signup-unconfirmed-'));
fs.chmodSync(artifacts, 0o700);
const requests = [], unexpected = [], cspViolations = [], pageErrors = [], results = [];
let current, base;
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
        unexpected.push({ method: req.method, path: pathname }); res.statusCode = 405; return res.end();
    }
    if (pathname === '/dynamic' || pathname === '/hosted') {
        const document = documents[pathname.slice(1)];
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
        return res.end(document.html);
    }
    if (assets.has(pathname.slice(1))) {
        const file = pathname.slice(1);
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(fs.readFileSync(path.join(root, file)));
    }
    if (pathname === statePath) {
        res.setHeader('Content-Type', 'application/json');
        if (!current.noMetadata) {
            res.setHeader('X-NoFries-Support-Reference', reference);
            res.setHeader('X-NoFries-Release-Sha', 'a'.repeat(40));
            res.setHeader('X-NoFries-Release-Run-Id', '12345');
        }
        if (current.diagnostic?.stage) res.setHeader('X-NoFries-Signup-Stage', current.diagnostic.stage);
        if (current.diagnostic?.reason) res.setHeader('X-NoFries-Signup-Reason', current.diagnostic.reason);
        res.setHeader('X-Synthetic-Untrusted-Detail', sentinel);
        res.statusCode = current.status || 200;
        return res.end(JSON.stringify(current.status ? { error: sentinel } : {
            state: { status: current.state || 'unavailable', ...(current.accountType ? { accountType: current.accountType } : {}) }
        }));
    }
    if (pathname === '/dashboard') {
        res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Synthetic destination</title><h1>Synthetic dashboard destination</h1>');
    }
    unexpected.push({ method: req.method, path: pathname }); res.statusCode = 404; res.end();
});

async function keyboard(page, name) {
    const skip = page.locator('#signup-skip');
    for (let n = 0; n < 40 && !await skip.evaluate(node => node === document.activeElement); n++) await page.keyboard.press('Shift+Tab');
    assert.ok(await skip.evaluate(node => node === document.activeElement), name + ': skip link reachable');
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('#signup').evaluate(node => node === document.activeElement), name + ': skip target focused');
    const count = await page.locator('a[href],button,input,select').evaluateAll(nodes => nodes.filter(node => {
        const r = node.getBoundingClientRect(), s = getComputedStyle(node);
        return !node.disabled && !node.closest('[hidden]') && node.tabIndex >= 0 && r.width > 0 && r.height > 0 && s.visibility !== 'hidden';
    }).length);
    const seen = new Set(), focus = [];
    for (let n = 0; n < count + 5; n++) {
        await page.keyboard.press('Tab');
        // Let native scrolling settle; do not scroll or refocus the control.
        await page.evaluate(async () => {
            let previous, stable = 0;
            for (let frame = 0; frame < 90 && stable < 5; frame++) {
                await new Promise(requestAnimationFrame);
                const r = document.activeElement.getBoundingClientRect();
                const value = [scrollX, scrollY, r.top, r.bottom].join();
                stable = value === previous ? stable + 1 : 0; previous = value;
            }
        });
        const item = await page.evaluate(() => {
            const node = document.activeElement;
            if (node === document.body) return null;
            const nodes = [...document.querySelectorAll('a[href],button,input,select')];
            const s = getComputedStyle(node), r = node.getBoundingClientRect();
            const extent = Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
            return { key: nodes.indexOf(node), label: (node.getAttribute('aria-label') || node.textContent).trim().slice(0, 80),
                focusVisible: node.matches(':focus-visible'), outline: s.outlineStyle, extent,
                left: r.left - extent, right: r.right + extent, top: r.top - extent, bottom: r.bottom + extent,
                viewportWidth: innerWidth, viewportHeight: innerHeight };
        });
        if (!item) continue;
        if (seen.has(item.key)) break;
        seen.add(item.key);
        assert.ok(item.focusVisible && item.outline !== 'none' && item.extent >= 2, name + ': visible keyboard focus: ' + JSON.stringify(item));
        assert.ok(item.left >= -.5 && item.right <= item.viewportWidth + .5 && item.top >= -.5 && item.bottom <= item.viewportHeight + .5,
            name + ': full keyboard ring fits after native scroll: ' + JSON.stringify(item));
        focus.push(item);
    }
    assert.equal(seen.size, count, name + ': every enabled control reached');
    return focus;
}

async function run() {
    let browser, failure;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const scenario of cases) {
            current = scenario;
            const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
            const page = await context.newPage(); page.setDefaultTimeout(8000);
            const start = requests.length;
            let abortedStateRequests = 0;
            await page.addInitScript(() => {
                window.syntheticCspViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.syntheticCspViolations.push(event.effectiveDirective));
            });
            page.on('pageerror', error => pageErrors.push({ case: scenario.name, message: error.message }));
            await context.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== base || request.method() !== 'GET') {
                    unexpected.push({ case: scenario.name, external: url.origin !== base, method: request.method() }); return route.abort();
                }
                if (scenario.network && url.pathname === statePath) { abortedStateRequests++; return route.abort('failed'); }
                return route.continue();
            });
            for (let visit = 0; visit < (scenario.visits || 1); visit++) {
                await page.goto(base + '/' + scenario.document + '?provider=external');
                if (scenario.state === 'continue_to_dashboard') {
                    await page.getByRole('heading', { name: 'Synthetic dashboard destination', exact: true }).waitFor();
                    assert.equal(page.url(), base + '/dashboard' + (scenario.accountType === 'consultant' ? '#organisations' : ''));
                    continue;
                }
                const pending = ['pending_preparation', 'pending_admission'].includes(scenario.state);
                const heading = scenario.state === 'pending_preparation' ? 'Your organisation is being prepared'
                    : scenario.state === 'pending_admission' ? 'Account setup received' : 'Signup is unavailable';
                await page.getByRole('heading', { name: heading, exact: true }).waitFor();
                await page.waitForFunction(() => document.getElementById('signup').getAttribute('aria-busy') === 'false');
                if (scenario.textScale === 2) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
                const card = page.locator('#signup');
                assert.equal(await card.getByRole('heading', { name: 'Account setup complete', exact: true }).count(), 0);
                if (pending) {
                    assert.equal(await card.getByText(code, { exact: true }).count(), 0);
                    assert.doesNotMatch(await card.innerText(), /Recorded step:|Support reference:|Reason:|server diagnostic/);
                    assert.match(await card.innerText(), scenario.state === 'pending_preparation' ? /terms have not been accepted/ : /do not have dashboard access yet/);
                    assert.equal(await card.getByRole('button', { name: scenario.state === 'pending_preparation' ? 'Check setup status' : 'Check access status', exact: true }).count(), 1);
                } else {
                    assert.equal(await card.getByRole('button').count(), 0, 'unconfirmed state has no retry action');
                    assert.ok(await card.getByText(reason, { exact: true }).isVisible());
                    assert.ok(await card.getByText(code, { exact: true }).isVisible());
                    assert.doesNotMatch(await card.innerText(), new RegExp(sentinel + '|unknown_public_|<img'));
                    const hasMetadata = !scenario.network && !scenario.noMetadata;
                    if (hasMetadata) assert.ok(await card.getByText('Support reference: ' + reference, { exact: true }).isVisible());
                    else assert.equal(await card.getByText('Support reference: ' + reference, { exact: true }).count(), 0);
                    if (scenario.diagnostic === publicDiagnostic) {
                        assert.ok(await card.getByText('Recorded step: Preparing your workspace.', { exact: true }).isVisible());
                        assert.ok(await card.getByText('Reason: Setup information was unavailable for this step.', { exact: true }).isVisible());
                    } else {
                        assert.doesNotMatch(await card.innerText(), /Recorded step:|Reason:/);
                        assert.ok(await card.getByText(hasMetadata ? 'No further server diagnostic is available for this attempt.'
                            : 'No server diagnostic was received for this attempt.', { exact: true }).isVisible());
                    }
                    assert.equal(await card.getByRole('link', { name: 'Sign in again', exact: true }).getAttribute('href'), '/api/external-customer-auth/login');
                    assert.equal(await card.getByRole('link', { name: 'Sign in with another account', exact: true }).getAttribute('href'), '/api/external-customer-auth/login?account=choose');
                    const report = card.getByRole('link', { name: 'Report this problem (opens in a new tab)', exact: true });
                    const href = await report.getAttribute('href');
                    const params = new URLSearchParams(href.split('#')[1]);
                    assert.equal(href.split('#')[0], '/report.html');
                    assert.deepEqual([...params.keys()].sort(), (!hasMetadata ? ['kind', 'screen', 'code'] : ['kind', 'screen', 'code', 'reference', 'apiReleaseSha', 'apiReleaseRunId']).sort());
                    assert.equal(params.get('code'), 'signup_unavailable');
                    if (hasMetadata) assert.equal(params.get('reference'), reference);
                    assert.equal(await report.getAttribute('rel'), 'noopener noreferrer');
                }
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), scenario.name + ': no horizontal overflow');
                const focus = await keyboard(page, scenario.name);
                cspViolations.push(...(await page.evaluate(() => window.syntheticCspViolations)).map(directive => ({ case: scenario.name, directive })));
                await page.screenshot({ path: path.join(artifacts, scenario.name + '-' + visit + '.png'), fullPage: true });
                results.push({ case: scenario.name, visit, width: scenario.width, textScale: scenario.textScale || 1, pending, focus });
            }
            const observed = requests.slice(start);
            const visits = scenario.visits || 1;
            assert.equal(observed.filter(request => request.path === statePath).length + abortedStateRequests, visits, scenario.name + ': one initial authority request per navigation');
            assert.equal(observed.filter(request => request.path.startsWith('/api/') && request.path !== statePath).length, 0, scenario.name + ': no auth/setup/terms/assistant action');
            assert.ok(observed.every(request => request.method === 'GET'), scenario.name + ': no submission');
            if (scenario.state === 'continue_to_dashboard') results.push({ case: scenario.name, provenSyntheticCompletion: true, accountType: scenario.accountType });
            await context.close();
        }
        assert.deepEqual(cspViolations, []); assert.deepEqual(pageErrors, []); assert.deepEqual(unexpected, []);
        assert.deepEqual(hashes(), sourceHashes, 'exact input source unchanged during acceptance');
    } catch (error) { failure = error.message; process.exitCode = 1; }
    finally {
        const result = { passed: !failure, failure, syntheticOnly: true, cases: cases.length, results,
            requests, unexpected, cspViolations, pageErrors, sourceHashes, sourceHashesAfter: hashes(), browser: browser?.version() };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ passed: !failure, failure, cases: results.length, artifacts }));
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
