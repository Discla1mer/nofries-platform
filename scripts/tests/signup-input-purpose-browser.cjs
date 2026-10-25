'use strict';

// Real signup document/CSP/client/view; synthetic loopback reads only.
// node scripts/tests/signup-input-purpose-browser.cjs
// NOFRIES_SIGNUP_PURPOSE_BASELINE=1 substitutes only the frozen base view in memory.
// NOFRIES_SIGNUP_PURPOSE_ARTIFACTS selects an external evidence directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');

const root = path.resolve(__dirname, '../..');
const baseline = process.env.NOFRIES_SIGNUP_PURPOSE_BASELINE === '1';
const artifacts = process.env.NOFRIES_SIGNUP_PURPOSE_ARTIFACTS
    || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-signup-input-purpose-'));
fs.mkdirSync(artifacts, { recursive: true });
const viewFile = 'api/shared/customerSignup/signupJourney.js';
const sources = ['lib/signupDocument.js', 'api/shared/customerSignup/signupClient.js', viewFile,
    'style.css', 'home.css', 'scripts/tests/signup-input-purpose-browser.cjs'];
const read = file => baseline && file === viewFile
    ? execFileSync('git', ['show', 'fd3e0480a70c92255514347d6cdd0535f2415bfe:' + file], { cwd: root })
    : fs.readFileSync(path.join(root, file));
const hash = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(sources.map(file => [file, hash(read(file))]));
const before = hashes();
const document = buildSignupDocument({ clientSource: read(sources[1]).toString(),
    journeySource: read(viewFile).toString(), customerLogin: true, customerTransport: 'external' });
const assets = { '/style.css': ['text/css', 'style.css'], '/home.css': ['text/css', 'home.css'],
    '/favicon.svg': ['image/svg+xml', 'favicon.svg'], '/images/nofrieslogo.png': ['image/png', 'images/nofrieslogo.png'] };
const reserved = { accountType: 'consultant', organisationName: 'Synthetic reserved consultancy' };
let reservation = false;
const requests = [], blocked = [], errors = [], results = [];
const purposes = { organisationName: 'organization', name: 'name', role: 'organization-title', address: 'street-address' };
const typed = { organisationName: 'Synthetic typed organisation', name: 'Synthetic Avery Example',
    role: 'Operations lead', address: '123 Synthetic Street, Wellington 6011', registrationId: '' };
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path: pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
        blocked.push(req.method + ' ' + pathname); res.writeHead(405); return res.end();
    }
    if (pathname === '/signup') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': document.contentSecurityPolicy });
        return res.end(document.html);
    }
    if (pathname === '/api/external-customer-signup/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state: { status: 'setup_details', email: 'synthetic@example.test',
            ...(reservation ? { reservation: { ...reserved } } : {}) }, csrfToken: 's'.repeat(43) }));
    }
    if (assets[pathname]) {
        const [type, file] = assets[pathname]; res.writeHead(200, { 'Content-Type': type }); return res.end(read(file));
    }
    blocked.push(req.method + ' ' + pathname); res.writeHead(404); res.end();
});
const input = (page, name) => page.locator('form [name="' + name + '"]');
async function attributes(page, isReserved) {
    const state = await page.locator('form:has(input[name="name"])').evaluate(form => ({
        fields: [...form.querySelectorAll('input,select')].map(node => ({ name: node.name,
            purpose: node.getAttribute('autocomplete'), type: node.type, required: node.required,
            maximum: node.maxLength, disabled: node.disabled, checked: node.checked })),
        emailInputs: form.querySelectorAll('[name=email],input[type=email]').length
    }));
    for (const [name, purpose] of Object.entries(purposes)) {
        const field = state.fields.find(node => node.name === name);
        assert.equal(field.purpose, purpose, name + ' exposes its standard purpose');
        assert.equal(field.type, 'text'); assert.equal(field.required, true);
        assert.equal(field.maximum, { organisationName: 120, name: 160, role: 120, address: 500 }[name]);
        assert.equal(field.disabled, name === 'organisationName' && isReserved);
    }
    for (const name of ['registrationId', 'accountType', 'authorityConfirmed']) {
        assert.equal(state.fields.find(node => node.name === name).purpose, null, name + ' has no invented purpose');
    }
    assert.equal(state.emailInputs, 0, 'signed-in email remains text');
    assert.equal(await input(page, 'authorityConfirmed').isChecked(), false);
    assert.equal(await input(page, 'accountType').isDisabled(), isReserved);
}
async function tabTo(page, name) {
    for (let i = 0; i < 25; i++) {
        if (await page.evaluate(expected => document.activeElement.name === expected, name)) return;
        await page.keyboard.press('Tab');
    }
    assert.fail('native Tab did not reach ' + name);
}
async function keyboardEntry(page, isReserved) {
    if (!isReserved) {
        await tabTo(page, 'accountType'); await page.keyboard.press('ArrowDown');
        assert.equal(await input(page, 'accountType').inputValue(), 'consultant');
    }
    for (const [name, value] of Object.entries(typed)) {
        if (isReserved && name === 'organisationName') continue;
        await tabTo(page, name); await page.keyboard.type(value);
        assert.equal(await input(page, name).inputValue(), value);
        assert.equal(await input(page, name).evaluate(node => node.validity.valid), true);
    }
    if (isReserved) assert.equal(await input(page, 'organisationName').inputValue(), reserved.organisationName);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'authorityConfirmed');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'registrationId');
    assert.equal(await input(page, 'authorityConfirmed').isChecked(), false);
    assert.equal(await page.locator('form:has(input[name="name"])').evaluate(form => form.checkValidity()), false,
        'unchecked authority retains its native required check');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}
async function autofill(page, context, isReserved) {
    const cdp = await context.newCDPSession(page);
    try {
        await cdp.send('Autofill.enable');
        await input(page, 'name').click();
        // Chrome asynchronously registers dynamically inserted forms with its
        // autofill service after focus; allow that renderer notification to settle.
        await page.waitForTimeout(500);
        const { root: dom } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.nodeId, selector: 'input[name="name"]' });
        const { node } = await cdp.send('DOM.describeNode', { nodeId });
        const { frameTree } = await cdp.send('Page.getFrameTree');
        const filled = [];
        cdp.on('Autofill.addressFormFilled', event => filled.push(...event.filledFields));
        await cdp.send('Autofill.trigger', { fieldId: node.backendNodeId, frameId: frameTree.frame.id,
            address: { fields: [
                { name: 'NAME_FULL', value: 'Synthetic Jordan Example' },
                { name: 'COMPANY_NAME', value: 'Synthetic autofill organisation' },
                { name: 'ADDRESS_HOME_STREET_ADDRESS', value: '456 Synthetic Avenue' },
                { name: 'ADDRESS_HOME_CITY', value: 'Wellington' },
                { name: 'ADDRESS_HOME_ZIP', value: '6011' }, { name: 'ADDRESS_HOME_COUNTRY', value: 'NZ' }
            ] } });
        await page.waitForFunction(() => document.querySelector('input[name="name"]').value === 'Synthetic Jordan Example');
        assert.equal(await input(page, 'organisationName').inputValue(),
            isReserved ? reserved.organisationName : 'Synthetic autofill organisation');
        assert.equal(await input(page, 'address').inputValue(), '456 Synthetic Avenue');
        assert.equal(await input(page, 'accountType').inputValue(), isReserved ? 'consultant' : 'company');
        assert.equal(await input(page, 'authorityConfirmed').isChecked(), false);
        assert.equal(await input(page, 'registrationId').inputValue(), '');
        // Chromium has no address-profile job-title value. Keep the correctly
        // exposed role editable and exercise ordinary input after autofill.
        await tabTo(page, 'role'); await page.keyboard.type('Synthetic team lead');
        assert.equal(await input(page, 'role').inputValue(), 'Synthetic team lead');
        await input(page, 'name').click(); await page.keyboard.press('End'); await page.keyboard.type(' Jr');
        assert.equal(await input(page, 'name').inputValue(), 'Synthetic Jordan Example Jr');
        await attributes(page, isReserved);
        for (const name of ['name', 'address', ...(isReserved ? [] : ['organisationName'])]) {
            assert.ok(filled.some(field => field.name === name && field.fillingStrategy === 'autocompleteAttribute'),
                name + ' is filled using the explicit autocomplete purpose');
        }
        return filled.map(({ name, autofillType, fillingStrategy }) => ({ name, autofillType, fillingStrategy }));
    } finally { await cdp.detach(); }
}
(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        async function open(width, isReserved) {
            reservation = isReserved;
            const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin === origin) return route.continue();
                blocked.push(route.request().url()); return route.abort();
            });
            await page.goto(origin + '/signup'); await page.locator('form input[name="name"]').waitFor();
            await attributes(page, isReserved); return { page, context };
        }
        for (const width of [1440, 390, 320]) {
            for (const isReserved of [false, true]) {
                const { page, context } = await open(width, isReserved);
                await keyboardEntry(page, isReserved);
                await page.screenshot({ path: path.join(artifacts, 'signup-' + width + (isReserved ? '-reserved' : '-typed') + '.png'), fullPage: true });
                results.push({ width, reserved: isReserved, case: 'attributes/native typing/Tab/ShiftTab/unchecked authority', passed: true });
                await context.close();
            }
        }
        for (const isReserved of [false, true]) {
            const { page, context } = await open(1440, isReserved);
            const fields = await autofill(page, context, isReserved);
            results.push({ width: 1440, reserved: isReserved, case: 'ephemeral Chromium address autofill/edit', fields, passed: true });
            await page.screenshot({ path: path.join(artifacts, 'signup-autofill' + (isReserved ? '-reserved' : '') + '.png'), fullPage: true });
            await context.close();
        }
        assert.deepEqual(blocked, [], 'no outside, unexpected or mutation requests'); assert.deepEqual(errors, []);
        assert.ok(requests.every(req => req.method === 'GET'), 'no signup, email, account or terms write');
        assert.deepEqual(hashes(), before, 'qualified source remains unchanged');
        fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify({ baseline, browser: browser.version(),
            sources: before, results, requests, blocked, errors, limits: 'Chromium address-profile autofill supports name, organisation and street address; job title remains correctly identified and manually editable. No stored profile, native mobile keyboard, Safari, AT or authenticated/live acceptance.' }, null, 2));
        process.stdout.write(JSON.stringify({ passed: results.length, artifacts, browser: browser.version(), blocked: blocked.length, errors: errors.length }) + '\n');
    } catch (error) {
        fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ baseline, sources: before, results,
            error: error.message, requests, blocked, errors }, null, 2));
        process.stderr.write(error.stack + '\n'); process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})();
