'use strict';
// Real Chromium, actual signup JS/HTML/CSS, synthetic loopback-only service.
// No identity provider, delivery, agreement acceptance or production account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launch } = require('./helpers/chromium-journey.cjs');
const root = path.resolve(__dirname, '../..');
async function run() {
    let state, requests, browser;
    const base = { requestId: '10000000-0000-4000-8000-000000000001', accountType: null };
    const assets = new Set(['login.html', 'style.css', 'home.css', 'js/organisation-setup.js', 'images/nofrieslogo.png']);
    const unexpected = [], measurements = [];
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
            if (url.pathname.startsWith('/api/organisation-setup/')) {
                let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 8192) throw new Error('oversized synthetic request'); }
                const action = url.pathname.split('/').pop(), body = text ? JSON.parse(text) : null;
                requests.push({ action, method: request.method, body });
                if (action === 'request') state = { ...base, state: 'awaiting_code', emailHint: 'o***@example.test' };
                if (action === 'verify') { assert.equal(body.code, '12345678'); state = { ...base, state: 'verified', accessGranted: false, nextStep: 'choose_account' }; }
                if (action === 'choose') state = { ...state, accountType: body.accountType, organisationName: body.organisationName, nextStep: 'details_required' };
                if (action === 'details') state = { ...state, nextStep: 'secure_sign_in' };
                response.writeHead(200, { 'content-type': 'application/json', 'x-nofries-customer-entry': 'legacy', 'x-nofries-customer-sign-in': 'available' });
                return response.end(JSON.stringify(state));
            }
            const file = url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
            if (request.method !== 'GET' || !assets.has(file)) { unexpected.push(request.method + ' ' + url.pathname); response.writeHead(404); return response.end(); }
            response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html', 'cache-control': 'no-store' });
            response.end(fs.readFileSync(path.join(root, file)));
        } catch (error) { unexpected.push(error.message); response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await launch(origin);
        for (const width of [1280, 320]) for (const scale of [1, 2]) {
            state = { state: 'start' }; requests = [];
            await browser.navigate(origin + '/login?intent=create&case=' + width + '-' + scale, width);
            await browser.wait('document.getElementById("organisation-title").textContent === "Create your account"');
            const fonts = await browser.textScale(scale), stages = [];
            async function layout(stage) {
                const measured = await browser.evaluate(`(()=>{const visible=[...document.querySelectorAll('main input,main button,main form,main a')].filter(n=>n.getClientRects().length && getComputedStyle(n).visibility!=='hidden');
                    return {overflow:document.documentElement.scrollWidth-innerWidth, outside:visible.filter(n=>{const r=n.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1;}).map(n=>n.id||n.tagName), controls:visible.length,
                    errors:[...document.querySelectorAll('[id$="-error"]')].filter(n=>n.getClientRects().length && n.textContent).map(n=>({id:n.id,font:parseFloat(getComputedStyle(n).fontSize)}))};})()`);
                assert.ok(measured.overflow <= 1, JSON.stringify({width,scale,stage,...measured}));
                assert.deepEqual(measured.outside, [], JSON.stringify({width,scale,stage,...measured}));
                if (scale === 2) {
                    const baseline = measurements.find(m => m.width === width && m.scale === 1).stages.find(s => s.stage === stage);
                    for (const error of measured.errors) assert.ok(Math.abs(error.font - baseline.errors.find(e => e.id === error.id).font * 2) < 0.1, 'Validation text doubles: ' + error.id);
                }
                stages.push({stage,...measured});
            }
            await layout('email');
            const text = id => browser.evaluate('document.getElementById(' + JSON.stringify(id) + ').textContent');
            const focused = () => browser.evaluate('document.activeElement.id');
            await browser.click('#organisation-send');
            assert.equal(await browser.evaluate('document.getElementById("organisation-email").getAttribute("aria-invalid")'), 'true');
            await layout('email-validation');
            await browser.fill('#organisation-email', 'owner@example.test'); await browser.click('#organisation-send');
            await browser.wait('document.getElementById("organisation-title").textContent === "Check your inbox"');
            assert.match(await text('organisation-email-hint'), /owner@example.test/);
            await layout('code');
            await browser.fill('#organisation-code', ' 1234-5678 ', '12345678'); await browser.click('#organisation-verify');
            await browser.wait('document.getElementById("organisation-title").textContent === "How will you use No Fries?"');
            assert.equal(await focused(), 'organisation-title');
            await layout('account-choice');
            await browser.click('#organisation-company'); await browser.fill('#organisation-name', 'Synthetic café');
            await layout('organisation-name');
            await browser.click('#organisation-profile-form button[type=submit]');
            await browser.wait('document.getElementById("organisation-title").textContent === "Your account details"');
            assert.equal(await focused(), 'organisation-title');
            await layout('details');
            await browser.click('#organisation-details-form button[type=submit]');
            assert.equal(await browser.evaluate('document.getElementById("representative-name").getAttribute("aria-invalid")'), 'true');
            await layout('details-validation');
            for (const [id, value] of [['name', 'Synthetic Owner'], ['role', 'Owner'], ['address', '1 Example Street']]) await browser.fill('#representative-' + id, value);
            await browser.click('#representative-authority'); await browser.fill('#representative-registration', 'abc123');
            await browser.click('#organisation-details-form button[type=submit]');
            assert.equal(await browser.evaluate('document.getElementById("representative-registration").getAttribute("aria-invalid")'), 'true');
            await layout('nzbn-validation');
            await browser.fill('#representative-registration', ''); await browser.click('#organisation-details-form button[type=submit]');
            await browser.wait('document.getElementById("organisation-title").textContent === "Continue secure sign-in"');
            assert.equal(await focused(), 'organisation-title');
            await layout('secure-sign-in');
            const overflow = await browser.evaluate('document.documentElement.scrollWidth - innerWidth');
            assert.ok(overflow <= 1, JSON.stringify({ width, scale, overflow }));
            assert.equal(requests.filter(r => r.action === 'details').length, 1);
            assert.ok(requests.filter(r => r.body).every(r => r.method === 'POST'));
            measurements.push({ width, scale, fonts, overflow, stages, signup: 'email-code/account/details/secure-sign-in passed' });
        }
        assert.deepEqual(browser.errors, []); assert.deepEqual(browser.unexpected, []); assert.deepEqual(unexpected, []);
        return { browser: browser.version, synthetic: true, measurements };
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
