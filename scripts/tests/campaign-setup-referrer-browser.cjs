'use strict';
// Real login/signup documents in Chromium; loopback synthetic setup only.
// The fixture accepts one in-memory email request. No provider or delivery runs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const signup = buildSignupDocument({ customerLogin: true, customerTransport: 'external',
    clientSource: read('api/shared/customerSignup/signupClient.js').toString(),
    journeySource: read('api/shared/customerSignup/signupJourney.js').toString() });

async function run() {
    let provider, requests, browser;
    const unexpected = [], errors = [], cases = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
        let raw = ''; for await (const chunk of req) raw += chunk;
        requests.push({ method: req.method, path: pathname, query: url.search, referrer: req.headers.referer || '', body: raw });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        let body, type = 'application/json';
        if (pathname === '/api/organisation-setup/state' && req.method === 'GET') {
            res.setHeader('x-nofries-customer-entry', provider); body = { state: 'start' };
        } else if (pathname === '/api/organisation-setup/request' && req.method === 'POST' && provider === 'legacy') {
            body = { state: 'awaiting_code', requestId: '10000000-0000-4000-8000-000000000001', accountType: null, emailHint: 's***@example.test' };
        } else if (req.method !== 'GET') {
            unexpected.push(req.method + ' ' + pathname); res.writeHead(405); return res.end();
        } else if (pathname === '/signup') {
            body = signup.html; type = 'text/html'; res.setHeader('Content-Security-Policy', signup.contentSecurityPolicy);
        } else if (pathname === '/api/external-customer-signup/state') body = { state: { status: 'create_account' } };
        else if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        else if (/^\/(?:login(?:\.html)?|style\.css|home\.css|js\/(?:enquiry-availability|organisation-setup)\.js|images\/[\w.-]+|assets\/fonts\/[\w.-]+)$/.test(pathname)) {
            const file = pathname === '/login' ? 'login.html' : pathname.slice(1);
            body = read(file); type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript'
                : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'image/png';
        } else { unexpected.push(req.method + ' ' + pathname); res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-background-networking'] });
        for (provider of ['external', 'legacy']) {
            requests = [];
            const context = await browser.newContext({ viewport: { width: 375, height: 844 }, serviceWorkers: 'block' });
            await context.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin) { unexpected.push('outside origin'); return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            await page.goto(origin + '/login?intent=create&utm_source=meta&utm_medium=paid&utm_campaign=insurance');
            if (provider === 'external') {
                await page.getByRole('button', { name: 'Create account', exact: true }).waitFor();
                assert.equal(new URL(page.url()).search, '?provider=external&intent=create');
            } else {
                await page.locator('#organisation-email').fill('synthetic@example.test');
                await page.locator('#organisation-send').click();
                await page.getByRole('heading', { name: 'Check your inbox', exact: true }).waitFor();
            }
            assert.equal(context.pages().length, 1);
            assert.equal(await page.evaluate(() => sessionStorage.getItem('nofries-enquiry-campaign')), 'meta/paid/insurance');
            const api = requests.filter(request => request.path.startsWith('/api/'));
            for (const request of api) {
                if (request.path.startsWith('/api/organisation-setup/')) {
                    assert.equal(request.referrer, '', provider + ' ' + request.path + ' must omit Referer');
                }
                assert.doesNotMatch(request.query + request.body + request.referrer, /utm_|meta\/paid\/insurance/);
            }
            assert.equal(api.filter(request => request.method === 'POST').length, provider === 'legacy' ? 1 : 0);
            cases.push({ provider, apiRequests: api.length, campaign: 'meta/paid/insurance', referrers: api.map(request => request.referrer) });
            await context.close();
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        return { passed: true, browser: browser.version(), viewport: { width: 375, height: 844 }, syntheticOnly: true, cases };
    } finally {
        await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
