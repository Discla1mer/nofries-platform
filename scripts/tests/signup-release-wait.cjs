'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');

const document = buildSignupDocument({
    clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
    journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8'),
    customerLogin: true,
    customerTransport: 'external'
});
const message = 'We’re updating No Fries, this will take a minute or two';
async function run() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
    try {
        for (const intent of ['create', 'login', 'details', 'timeout']) {
            const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
            let reads = 0;
            const submissions = [];
            await page.clock.install();
            await page.route('**/*', route => {
                const { pathname } = new URL(route.request().url());
                if (pathname === '/signup') return route.fulfill({ contentType: 'text/html', body: document.html });
                if (pathname === '/api/external-customer-signup/setup') {
                    submissions.push(route.request().postData());
                    if (submissions.length === 1) return route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Site stopped</h1>' });
                    return route.fulfill({ json: { state: { status: 'pending_preparation' } } });
                }
                if (pathname === '/api/external-customer-signup/state') {
                    if (intent === 'details') return route.fulfill({ json: { state: { status: 'setup_details', email: 'person@example.test' }, csrfToken: 'x'.repeat(43) } });
                    if (++reads === 1 || intent === 'timeout') return route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Site stopped</h1>' });
                    return route.fulfill({ json: { state: { status: 'create_account' } } });
                }
                if (pathname === '/api/external-customer-auth/login') return route.fulfill({ body: 'Synthetic sign-in handoff' });
                if (pathname === '/style.css' || pathname === '/home.css' || pathname.startsWith('/assets/fonts/') || pathname.startsWith('/images/'))
                    return route.fulfill({ path: '.' + pathname });
                return route.fulfill({ status: 404, body: '' });
            });
            await page.goto('http://localhost/signup?provider=external&intent=' + (intent === 'timeout' ? 'create' : intent));
            const company = page.locator('[name=organisationName]');
            if (intent === 'details') {
                for (const field of ['organisationName', 'name', 'role', 'address']) {
                    await page.locator('[name=' + field + ']').fill('Synthetic ' + field);
                }
                await page.getByRole('checkbox').check();
                await page.getByRole('button', { name: 'Continue', exact: true }).click();
            }
            await page.getByText(message, { exact: true }).waitFor();
            if (intent === 'details') assert.equal(await company.inputValue(), 'Synthetic organisationName');
            if (intent === 'create' && process.argv[2]) await page.screenshot({ path: process.argv[2] });
            if (intent === 'timeout') {
                await page.clock.fastForward(180001);
                await page.getByRole('button', { name: 'Try again' }).waitFor();
            } else {
                await page.clock.runFor(1100);
                if (intent === 'login') await page.waitForURL('**/api/external-customer-auth/login');
                else await page.waitForFunction(() => !document.querySelector('.signup-release-wait'));
                if (intent === 'details') {
                    await page.getByRole('button', { name: 'Check setup status' }).waitFor();
                    assert.equal(submissions.length, 2);
                    assert.equal(submissions[0], submissions[1]);
                } else assert.equal(reads, 2);
            }
            await page.close();
        }
    } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
