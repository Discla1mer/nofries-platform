'use strict';

// Actual browser/UI with a synthetic email-code service. No identity-provider,
// invitation, agreement acceptance or production delivery is exercised here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [320, 1280]) {
            const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 800 } });
            const errors = [], requests = [];
            page.on('pageerror', error => errors.push(error.message));
            let state = { state: 'start' };
            const base = { requestId: '10000000-0000-4000-8000-000000000001', accountType: null };
            await page.route('**/*', async route => {
                const url = new URL(route.request().url());
                assert.equal(url.origin, 'http://signup.test');
                if (url.pathname.startsWith('/api/organisation-setup/')) {
                    const action = url.pathname.split('/').pop(), body = route.request().postDataJSON();
                    requests.push({ action, body });
                    if (action === 'request') state = { ...base, state: 'awaiting_code', emailHint: 'o***@example.test' };
                    if (action === 'verify') { assert.equal(body.code, '12345678'); state = { ...base, state: 'verified', accessGranted: false, nextStep: 'choose_account' }; }
                    if (action === 'choose') state = { ...state, accountType: body.accountType, organisationName: body.organisationName, nextStep: 'details_required' };
                    if (action === 'details') state = { ...state, nextStep: 'secure_sign_in' };
                    return route.fulfill({ json: state, headers: { 'x-nofries-customer-entry': 'legacy', 'x-nofries-customer-sign-in': 'available' } });
                }
                const file = url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
                const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html';
                await route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
            });
            await page.goto('http://signup.test/login?intent=create');
            const heading = page.locator('#organisation-title');
            await heading.getByText('Create your account', { exact: true }).waitFor();
            assert.equal(await page.locator('#organisation-returning-sign-in').getAttribute('class'), 'text-link');
            await page.locator('#organisation-send').click();
            assert.equal(await page.locator('#organisation-email').getAttribute('aria-invalid'), 'true');
            await page.locator('#organisation-email').fill('owner@example.test');
            assert.equal(await page.locator('#organisation-email').getAttribute('aria-invalid'), null);
            await page.locator('#organisation-send').click();
            await page.getByText('Check your inbox', { exact: true }).waitFor();
            assert.match(await page.locator('#organisation-email-hint').textContent(), /owner@example.test/);
            await page.locator('#organisation-code').fill(' 1234-5678 ');
            assert.equal(await page.locator('#organisation-code').inputValue(), '12345678');
            await page.locator('#organisation-verify').click();
            await page.getByText('How will you use No Fries?', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.activeElement.id), 'organisation-title');
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#organisation-choice').isVisible(), true);
            assert.equal(await page.locator('#organisation-returning').isVisible(), false);
            await page.locator('#organisation-company').click();
            await page.getByText('Name your organisation', { exact: true }).waitFor();
            await page.goBack(); assert.equal(await page.locator('#organisation-choice').isVisible(), true);
            await page.goForward(); assert.equal(await page.locator('#organisation-profile-form').isVisible(), true);
            await page.locator('#organisation-name').fill('Synthetic café');
            await page.locator('#organisation-profile-form button[type=submit]').click();
            await page.getByText('Your account details', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.activeElement.id), 'organisation-title');
            await page.locator('#organisation-details-form button[type=submit]').click();
            assert.equal(await page.locator('#representative-name').getAttribute('aria-invalid'), 'true');
            for (const [id, value] of [['name', 'Synthetic Owner'], ['role', 'Owner'], ['address', '1 Example Street']]) await page.locator('#representative-' + id).fill(value);
            await page.locator('#representative-authority').check();
            await page.locator('#representative-registration').fill('abc123');
            await page.locator('#organisation-details-form button[type=submit]').click();
            assert.equal(await page.locator('#representative-registration').getAttribute('aria-invalid'), 'true');
            await page.locator('#representative-registration').fill('');
            await page.locator('#organisation-details-form button[type=submit]').click();
            await page.getByRole('heading', { name: 'Continue secure sign-in', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.activeElement.id), 'organisation-title');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            assert.equal(requests.filter(request => request.action === 'details').length, 1);
            assert.deepEqual(errors, []);
            await page.close();
        }
        console.log('Persona sign-up browser checks passed at 320px and 1280px (synthetic service).');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
