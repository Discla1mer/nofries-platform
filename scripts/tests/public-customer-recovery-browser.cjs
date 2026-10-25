'use strict';
// Optional loopback-only synthetic integration check. Run from the repository:
// node scripts/tests/public-customer-recovery-browser.cjs
// Uses existing Playwright/Chromium; never downloads or calls a provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..'), fromRoot = createRequire(path.join(root, 'package.json'));
const { chromium } = fromRoot('playwright');
const { buildSignupDocument } = fromRoot('./lib/signupDocument');
const { withHashBoundSharedAssistantDocument } = fromRoot('./lib/withHashBoundSharedAssistantDocument');
const { publicHelpReply } = fromRoot('./api/shared/agents/nofriesPublicKnowledge');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sourcePaths = ['api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    'js/prospect-assistant.js', 'js/shared-assistant.js', 'lib/sharedAssistantDocument.js', 'shared-assistant.css',
    'api/shared/agents/nofriesPublicKnowledge.js', 'lib/signupDocument.js', 'lib/withHashBoundSharedAssistantDocument.js',
    'scripts/tests/public-customer-recovery-browser.cjs'];
const hashes = () => Object.fromEntries(sourcePaths.map(file => [file,
    createHash('sha256').update(read(file)).digest('hex')]));
const before = hashes();
const document = withHashBoundSharedAssistantDocument(buildSignupDocument({
    clientSource: read(sourcePaths[0]), journeySource: read(sourcePaths[1]),
    customerLogin: true, customerTransport: 'external'
}), { prospectSource: read('js/prospect-assistant.js'), sharedSource: read('js/shared-assistant.js') });
const assets = new Set(['style.css', 'home.css', 'shared-assistant.css', 'images/nofrieslogo.png',
    'images/fry-chat.png', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']);
const requestLog = [], observations = [], errors = [], blocked = [], unexpected = [];
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    requestLog.push({ method: req.method, path: url.pathname, body });
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/signup') {
        res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
        res.setHeader('Content-Type', 'text/html'); return res.end(document.html);
    }
    const file = url.pathname.slice(1);
    if (assets.has(file)) {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(fs.readFileSync(path.join(root, file)));
    }
    if (url.pathname === '/api/external-customer-signup/state' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ state: { status: 'setup_details', email: 'synthetic@example.test' }, csrfToken: 'a'.repeat(43) }));
    }
    if (url.pathname === '/api/external-customer-signup/setup' && req.method === 'POST') {
        res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Synthetic rejected request' }));
    }
    if (url.pathname === '/api/prospect/session' && req.method === 'GET') {
        assert.equal(url.searchParams.get('publicHelpOnly'), 'true');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ assistant: { runtime: { mode: 'mock' }, publicHelpOnly: true,
            publicHelpProtocol: 'public-help-v1' }, conversation: { messages: [] }, organisation: null }));
    }
    if (url.pathname === '/api/prospect/chat' && req.method === 'POST') {
        const input = JSON.parse(body);
        assert.deepEqual(Object.keys(input).sort(), ['publicHelpMessage', 'publicHelpOnly']);
        assert.equal(input.publicHelpOnly, true);
        res.setHeader('Content-Type', 'text/event-stream');
        return res.end('event: done\ndata: ' + JSON.stringify({ text: publicHelpReply(input.publicHelpMessage).text,
            runtime: { mode: 'mock' } }) + '\n\n');
    }
    unexpected.push({ method: req.method, path: url.pathname });
    res.statusCode = 404; res.end();
});
async function main() {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 },
            { width: 320, height: 700 }, { width: 568, height: 320 }]) {
            const context = await browser.newContext({ viewport });
            const page = await context.newPage(), start = requestLog.length;
            page.setDefaultTimeout(8000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()); });
            await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue()
                : (blocked.push(route.request().url()), route.abort()));
            await page.goto(base + '/signup?provider=external');
            await page.getByRole('heading', { name: 'Set up your workspace', exact: true }).waitFor();
            await page.locator('select[name=accountType]').selectOption('consultant');
            const fields = { organisationName: 'Synthetic consultancy', name: 'Synthetic owner', role: 'Director',
                address: 'Synthetic address', registrationId: '9429000000000' };
            for (const [name, value] of Object.entries(fields)) await page.locator('input[name=' + name + ']').fill(value);
            await page.locator('input[name=authorityConfirmed]').check();
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            await page.getByRole('heading', { name: 'Signup is unavailable', exact: true }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Check setup status', exact: true }).count(), 0);
            assert.equal(await page.getByText('Error code: NF-SIGNUP-UNCONFIRMED', { exact: true }).count(), 1);
            assert.equal(await page.getByText('We could not confirm your account setup. Do not create another account or submit your details again.', { exact: true }).count(), 1);
            await page.locator('[data-assistant-launcher]').click();
            await page.locator('#assistant-input:enabled').waitFor();
            assert.equal(await page.locator('#assistant-input').evaluate(node => node.tagName), 'TEXTAREA');
            const question = 'How do I create an account or log in to No Fries?';
            await page.locator('#assistant-input').fill(question);
            await page.locator('#assistant-form button[type=submit]').click();
            await page.locator('#assistant-messages a[href="https://nofries.nz/login"]').waitFor();
            await page.locator('[data-assistant-close]').click();
            assert.equal(requestLog.slice(start).filter(r => r.path === '/api/external-customer-signup/state').length, 1);
            assert.equal(requestLog.slice(start).filter(r => r.path === '/api/external-customer-signup/setup').length, 1);
            // Recovery now requires deliberate fresh navigation. Private
            // in-memory setup text and consent cannot survive that boundary.
            await page.reload();
            await page.getByRole('heading', { name: 'Set up your workspace', exact: true }).waitFor();
            for (const name of Object.keys(fields)) assert.equal(await page.locator('input[name=' + name + ']').inputValue(), '');
            assert.equal(await page.locator('select[name=accountType]').inputValue(), 'company');
            assert.equal(await page.locator('input[name=authorityConfirmed]').isChecked(), false);
            // Clearing public chat still cannot erase a newly entered form.
            for (const [name, value] of Object.entries(fields)) await page.locator('input[name=' + name + ']').fill(value);
            await page.locator('select[name=accountType]').selectOption('consultant');
            await page.locator('[data-assistant-launcher]').click();
            assert.ok(!(await page.locator('#assistant-messages').innerText()).includes(question));
            await page.locator('#assistant-reset').click();
            await page.locator('[data-assistant-close]').click();
            for (const [name, value] of Object.entries(fields)) assert.equal(await page.locator('input[name=' + name + ']').inputValue(), value);
            assert.equal(await page.locator('select[name=accountType]').inputValue(), 'consultant');
            assert.equal(await page.locator('input[name=authorityConfirmed]').isChecked(), false);
            const requests = requestLog.slice(start);
            assert.equal(requests.filter(r => r.path === '/api/external-customer-signup/setup').length, 1);
            assert.equal(requests.filter(r => r.path === '/api/external-customer-signup/state').length, 2);
            assert.equal(requests.filter(r => r.path === '/api/prospect/chat').length, 1);
            assert.ok(!requests.find(r => r.path === '/api/prospect/chat').body.includes(fields.name));
            observations.push({ viewport, discardedPrivateDraftFields: 5, accountTypeChosenAgain: true,
                authorityUnchecked: true, automaticSetupResubmissions: 0, publicHelpOnly: true,
                freshNavigationDiscardsChat: true, clearChatPreservesNewSetupFields: 5 });
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(unexpected, []);
        assert.deepEqual(hashes(), before);
        const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-public-customer-browser-'));
        const result = { passed: true, syntheticOnly: true, browser: browser.version(), observations,
            errors, blocked, unexpected, sourceHashes: before };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ passed: true, cases: observations.length, browser: browser.version(), artifacts }));
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
