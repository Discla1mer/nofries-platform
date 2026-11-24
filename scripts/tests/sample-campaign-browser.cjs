'use strict';

// Run against the sample checkout and, until merged, the #483 and #477 checkouts.
// All browser requests are intercepted. The fixture supplies a completed signup
// state and a submitted synthetic assessment to the real signup and Results clients.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const sample = path.resolve(__dirname, '../..');
const signup = path.resolve(process.env.NOFRIES_SIGNUP_CHECKOUT || sample);
const results = path.resolve(process.env.NOFRIES_RESULTS_CHECKOUT || sample);
const evidence = process.argv[2];
const origin = 'http://127.0.0.1:8080';
const viewport = { width: 375, height: 844 };
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const { withCustomerProvider } = require(path.join(signup, 'lib/dashboardDocument'));
const { buildSignupDocument } = require(path.join(signup, 'lib/signupDocument'));
const { buildFixtures, createSyntheticTransport } = require(path.join(results, 'scripts/build-ncsc-questionnaire-preview'));
const login = withCustomerProvider(read(signup, 'login.html'), 'external');
const signupPage = buildSignupDocument({
    clientSource: read(signup, 'api/shared/customerSignup/signupClient.js'),
    journeySource: read(signup, 'api/shared/customerSignup/signupJourney.js'),
    customerLogin: true, customerTransport: 'external'
});
const sections = {
    board: 'Summary for your board or insurer',
    supplier: 'Answers for your insurer or customer questionnaire',
    insurance: 'Answers for your insurer or customer questionnaire',
    scam: 'Check payment changes safely',
    direct: 'Suggested follow-ups'
};
const cases = [
    ['board', 'board.html'], ['supplier', 'supplier-questionnaire.html'],
    ['insurance', 'insurance.html'], ['scam', 'invoice-scams.html'],
    ['direct', null], ['first-touch', 'board.html']
];

function mountResults(fixtures, createTransport) {
    const tenant = fixtures.tenants[0];
    const transport = createTransport(tenant, fixtures.metadata, fixtures);
    const client = NoFriesNcscAssessmentClient.createClient({ metadata: fixtures.metadata, fetch: transport.fetch });
    NoFriesNcscQuestionnaire.mount(document.getElementById('results'), {
        metadata: fixtures.metadata, organisationId: tenant.model.context.organisationId,
        client, window, initialAssessmentId: 'assessment-submitted', presentationMode: 'editable'
    });
}
const dashboard = '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/app/dashboard.css">' +
    '<body class="nofries-dashboard"><main class="dashboard-main"><div id="results"></div></main>' +
    ['ncscAssessmentClient', 'ncscQuestionnaire'].map(file => '<script src="/api/shared/protectedAssets/' + file + '.js"></script>').join('') +
    '<script>(' + mountResults + ')(' + JSON.stringify(buildFixtures()) + ',' + createSyntheticTransport + ');</script></body></html>';

// Restrict the intercepted responses to the assets used by the three real page flows.
const roots = new Map();
for (const [root, files] of [
    [sample, ['board.html', 'supplier-questionnaire.html', 'insurance.html', 'invoice-scams.html',
        'sample-result.html', 'js/home.js', 'js/enquiry-availability.js', 'style.css', 'home.css', 'favicon.svg',
        'images/nofrieslogo.png', 'images/paper-texture.webp', 'assets/fonts/fraunces-latin-opsz-normal.woff2',
        'assets/fonts/fraunces-latin-opsz-italic.woff2']],
    [signup, ['contact.html', 'js/organisation-setup.js', 'js/contact.js']],
    [results, ['app/dashboard.css', 'api/shared/protectedAssets/ncscAssessmentClient.js',
        'api/shared/protectedAssets/ncscQuestionnaire.js']]
]) {
    for (const file of files) roots.set(file, root);
}

async function serve(route) {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (url.origin !== origin || route.request().method() !== 'GET') throw new Error('Unexpected request: ' + url.pathname);
    if (name === 'login') return route.fulfill({ contentType: 'text/html', body: login });
    if (name === 'signup') return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': signupPage.contentSecurityPolicy }, body: signupPage.html });
    if (name === 'dashboard') return route.fulfill({ contentType: 'text/html', body: dashboard });
    if (name === 'api/external-customer-signup/state') return route.fulfill({ json: { state: { status: 'continue_to_dashboard' }, csrfToken: 'x'.repeat(43) } });
    if (name === 'api/enquiry') return route.fulfill({ json: { available: true } });
    if (name === 'favicon.ico') return route.fulfill({ status: 204 });
    assert.ok(roots.has(name), 'Unexpected fixture resource: ' + name);
    return route.fulfill({ path: path.join(roots.get(name), name) });
}

async function journey(browser, name, landing, destination) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        const documents = [], errors = [];
        let outbound = false;
        await context.route('**/*', async route => {
            try {
                const request = route.request(), url = new URL(request.url());
                if (request.isNavigationRequest()) documents.push(url.pathname + url.search);
                if (outbound) {
                    assert.doesNotMatch(url.search, /utm_|fbclid|gclid/i);
                    assert.doesNotMatch((await request.allHeaders()).referer || '', /utm_|fbclid|gclid/i);
                }
                await serve(route);
            } catch (error) { errors.push(error.message); await route.abort(); }
        });
        page.on('pageerror', error => errors.push(error.message));
        if (name === 'first-touch') await page.goto(origin + '/sample-result.html?utm_source=meta&utm_medium=paid&utm_campaign=scam');
        if (landing) {
            const campaign = name === 'first-touch' ? 'board' : name;
            await page.goto(origin + '/' + landing + '?utm_source=meta&utm_medium=paid&utm_campaign=' + campaign + '&fbclid=discard');
            await page.locator('a[href*="/sample-result.html"]').click();
            const sampleUrl = new URL(page.url());
            assert.equal(sampleUrl.searchParams.get('utm_campaign'), campaign);
            assert.equal(sampleUrl.searchParams.has('fbclid'), false);
        } else await page.goto(origin + '/sample-result.html');
        const campaign = name === 'first-touch' ? 'scam' : name;
        const tag = name === 'direct' ? null : 'meta/paid/' + campaign;
        const stored = () => page.evaluate(() => sessionStorage.getItem('nofries-enquiry-campaign'));
        await page.waitForLoadState('domcontentloaded');
        assert.equal(await stored(), tag);
        assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), tag ? ['nofries-enquiry-campaign'] : []);
        assert.equal(await page.evaluate(() => localStorage.length), 0);
        const actions = page.locator('.sample-result-next');
        await actions.scrollIntoViewIfNeeded();
        if (evidence && name === 'board' && destination === 'signup') await page.screenshot({ path: path.join(evidence, 'sample-actions.png') });
        outbound = true;
        const start = documents.length;
        let heading;
        if (destination === 'signup') {
            await actions.getByRole('link', { name: 'Start your free assessment' }).click();
            const first = page.locator('.ncsc-results > section > h3').first();
            await first.waitFor();
            heading = await first.textContent();
            assert.equal(heading, sections[campaign]);
            assert.deepEqual(documents.slice(start), ['/login?intent=create', '/signup?provider=external&intent=create', '/dashboard']);
            await first.scrollIntoViewIfNeeded();
        } else {
            await actions.getByRole('link', { name: 'Talk to us' }).click();
            heading = await page.locator('#contact-heading').textContent();
            assert.equal(heading, tag ? '90-day managed security' : 'Talk to No Fries');
            assert.deepEqual(documents.slice(start), ['/contact.html']);
        }
        assert.equal(await stored(), tag);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        if (evidence && name === 'board') await page.screenshot({ path: path.join(evidence, 'board-' + destination + '.png') });
        return { entry: name, destination, tag, documents: documents.slice(start), heading };
    } finally { await context.close(); }
}

async function main() {
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
    try {
        const journeys = [];
        for (const [name, landing] of cases) {
            for (const destination of ['signup', 'contact']) journeys.push(await journey(browser, name, landing, destination));
        }
        const receipt = { viewport, browser: browser.version(), synthetic: true, journeys };
        if (evidence) fs.writeFileSync(path.join(evidence, 'journeys.json'), JSON.stringify(receipt, null, 2) + '\n');
        console.log(journeys.length + ' sample journeys passed at 375 px.');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
