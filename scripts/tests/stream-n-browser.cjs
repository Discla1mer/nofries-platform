'use strict';
// Synthetic loopback fixture: production Results, gates and CSS; no real account.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');
const root = path.resolve(__dirname, '../..'), fixtures = buildFixtures(), seed = fixtures.tenants[0];
const files = ['style.css', 'home.css', 'app/dashboard.css', 'api/shared/protectedAssets/dashboardShell.js', 'api/shared/protectedAssets/ncscAssessmentClient.js', 'api/shared/protectedAssets/ncscQuestionnaire.js'];
const assets = ['assets/fonts/fraunces-latin-opsz-normal.woff2', 'assets/fonts/fraunces-latin-opsz-italic.woff2', 'images/paper-texture.webp'];
const artifacts = process.env.NOFRIES_STREAM_N_ARTIFACTS || '/tmp/nofries-stream-n';
function assessment(option, submitted) {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: seed.model.context.organisationId });
    let version = null;
    for (const command of [createCommand('assessment-n'), saveCommand('assessment-n', 0, 'save-n', allResponses(option)), submitCommand('assessment-n', 1, 'submit-n')].slice(0, submitted ? 3 : 2)) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId, action: command.action,
            expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
    }
    return projectNcscDetail(version);
}
function app(fixtures, seed, transportFactory) {
    const transport = transportFactory(seed, fixtures.metadata, fixtures);
    window.transportCalls = [];
    const client = NoFriesNcscAssessmentClient.createClient({ metadata: fixtures.metadata, fetch(url, init = {}) {
        window.transportCalls.push({ url, method: init.method || 'GET', body: init.body }); return transport.fetch(url, init);
    } });
    const gate = content => NoFriesDashboard.detailsGate(document, { isCurrent: () => true, read: async () => ({ status: window.fixtureGate }) }, content);
    NoFriesNcscQuestionnaire.mount(document.getElementById('results'), { metadata: fixtures.metadata, client, window,
        organisationId: seed.model.context.organisationId, initialAssessmentId: 'assessment-n', presentationMode: 'editable',
        ...(window.fixtureGate ? { detailsGate: gate, boardExportGate: gate, questionnaireExportGate: gate } : {}) });
}
async function main() {
    fs.mkdirSync(artifacts, { recursive: true });
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
        if (pathname === '/api/enquiry') { res.setHeader('Content-Type', 'application/json'); return res.end('{"available":true}'); }
        if (assets.includes(pathname.slice(1))) { res.setHeader('Content-Type', pathname.endsWith('.woff2') ? 'font/woff2' : 'image/webp'); return res.end(fs.readFileSync(path.join(root, pathname))); }
        if (files.includes(pathname.slice(1))) { res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(fs.readFileSync(path.join(root, pathname))); }
        if (pathname !== '/') { res.statusCode = 404; return res.end(); }
        const option = new URL(req.url, 'http://fixture.invalid').searchParams.get('answer') || 'no';
        const data = { ...seed, assessments: [assessment(option, false)], submittedFixture: assessment(option, true) };
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Results review</title>' +
            files.filter(f => f.endsWith('.css')).map(f => '<link rel="stylesheet" href="/' + f + '">').join('') + '<body><p>Synthetic Stream N review · no customer data</p><div class="nofries-dashboard"><div class="dashboard-workspace"><main class="dashboard-main"><div id="results"></div></main></div></div>' +
            files.filter(f => f.endsWith('.js')).map(f => '<script src="/' + f + '"></script>').join('') +
            '<script>(' + app + ')(' + JSON.stringify(fixtures) + ',' + JSON.stringify(data) + ',' + createSyntheticTransport + ');</script></body></html>');
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const results = [], errors = [], requests = [];
        const cases = [['insurance'], ['supplier'], ['board'], ['scam'], [''], ['unknown'], ['scam', 'unknown'], ['board', 'no', 'details_required'], ['scam', 'no', 'details_required'], ['insurance', 'no', 'details_required'], ['supplier', 'no', null, false], ['scam', 'no', 'details_required', false]];
        let defaultMarkup;
        for (const [campaign, answer = 'no', gate = null, available = true] of cases) {
            let settle;
            const pending = new Promise(resolve => { settle = resolve; });
            const context = await browser.newContext({ viewport: { width: 375, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
            await context.route('**/*', async route => {
                const request = route.request(); assert.equal(new URL(request.url()).origin, origin); assert.equal(request.method(), 'GET');
                if (request.resourceType() !== 'document') assert.ok(!request.url().includes('utm_'));
                if (new URL(request.url()).pathname === '/api/enquiry') {
                    await pending;
                    return route.fulfill({ json: { available } });
                }
                requests.push({ path: new URL(request.url()).pathname, method: request.method() }); return route.continue();
            });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({ campaign, gate }) => {
                if (campaign) sessionStorage.setItem('nofries-enquiry-campaign', 'meta/paid/' + campaign);
                window.storageWrites = []; window.fixtureGate = gate;
                for (const method of ['setItem', 'removeItem', 'clear']) Storage.prototype[method] = function () { window.storageWrites.push(method); throw new Error('Unexpected storage mutation'); };
            }, { campaign, gate });
            await page.goto(origin + '/?answer=' + answer + '&utm_campaign=board');
            await page.getByRole('button', { name: 'Review and submit', exact: true }).click();
            await page.getByRole('button', { name: 'Save and submit assessment' }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
            const panel = page.locator('.ncsc-results'); await panel.waitFor();
            if (!gate) {
                const initial = panel.locator(':scope > :last-child a');
                await initial.waitFor(); assert.equal(await initial.getAttribute('href'), 'mailto:hello@nofries.nz');
            }
            settle();
            if (!gate && available) await panel.locator(':scope > :last-child a[href^="/contact"]').waitFor();
            const headings = await panel.locator(':scope > section > h3').allTextContents();
            const first = campaign === 'insurance' || campaign === 'supplier' ? 'Answers for your insurer or customer questionnaire' : campaign === 'board' ? 'Summary for your board or insurer' : campaign === 'scam' ? (answer === 'no' ? 'Payment-check gap and next step' : 'Check payment changes safely') : 'Your top three gaps';
            assert.equal(headings[0], first);
            if (campaign === 'insurance') assert.equal(headings[1], 'Summary for your board or insurer');
            await panel.locator('.picture-next-steps-help').waitFor();
            assert.equal(await panel.locator('.picture-next-steps-help').count(), 1);
            assert.equal(await panel.locator('.picture-top-gaps').count(), 1);
            assert.equal(await panel.locator('.picture-top-gap').count(), answer === 'no' ? 3 : 0);
            assert.equal(await panel.locator('.ncsc-questionnaire-answers').count(), 1);
            if (campaign === 'scam') {
                await panel.locator('.picture-next-steps-help').waitFor();
                assert.equal(await panel.locator('.ncsc-payment-next-step + .picture-next-steps-help').count(), 1);
                if (!gate) assert.equal(await panel.getByRole('link', { name: 'Fix these with No Fries', exact: true }).getAttribute('href'), '/contact.html?service=managed_security_90');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (!campaign) defaultMarkup = await panel.innerHTML();
            if (campaign === 'unknown') assert.equal(await panel.innerHTML(), defaultMarkup);
            await page.evaluate(() => document.fonts.ready);
            await panel.locator('h2').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
            const name = (campaign || 'none') + (answer === 'unknown' ? '-unknown-answer' : '') + (gate ? '-gated' : '');
            await page.screenshot({ path: path.join(artifacts, name + (available ? '' : '-offline') + '-375.png') });
            if (gate) {
                assert.equal(await panel.locator('a[href^="mailto:"]').count(), 0);
                await panel.getByRole('button', { name: 'Add your details' }).first().waitFor();
                assert.equal(await panel.getByRole('button', { name: /Copy answers|Print answers|Copy board summary|Print board summary/ }).count(), 0);
                assert.equal(await panel.getByRole('link', { name: 'Fix these with No Fries' }).count(), 0);
                await page.evaluate(() => { window.fixtureGate = 'ready'; });
                while (await panel.getByRole('button', { name: 'Add your details' }).count()) await panel.getByRole('button', { name: 'Add your details' }).first().click();
                await panel.getByRole('button', { name: 'Copy answers', exact: true }).waitFor();
            }
            if (available) await panel.locator(':scope > :last-child a[href^="/contact"]').waitFor();
            const gapLinks = panel.locator('.picture-top-gap .ncsc-results-contact a');
            assert.equal(await gapLinks.count(), answer === 'no' ? 3 : 0);
            const destination = available ? '/contact.html?service=managed_security_90' : 'mailto:hello@nofries.nz';
            for (const link of await gapLinks.all()) assert.equal(await link.getAttribute('href'), destination);
            assert.equal(await panel.locator(':scope > :last-child a').getAttribute('href'), destination);
            if (await gapLinks.count()) {
                await gapLinks.first().focus();
                await page.keyboard.press('Tab');
                assert.ok(await gapLinks.nth(1).evaluate(el => el === document.activeElement));
            }
            if (['insurance', 'supplier', 'board'].includes(campaign)) {
                const input = panel.locator(campaign === 'board' ? '#ncsc-board-summary' : '#ncsc-questionnaire-answer-text');
                await input.focus(); await page.keyboard.press('Tab');
                const copy = panel.getByRole('button', { name: campaign === 'board' ? 'Copy board summary' : 'Copy answers', exact: true });
                assert.equal(await copy.evaluate(el => document.activeElement === el), true); await page.keyboard.press('Enter');
                assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), await input.inputValue());
                await page.keyboard.press('Tab');
                assert.equal(await page.evaluate(() => document.activeElement.textContent), campaign === 'board' ? 'Print board summary' : 'Print answers');
                if (campaign === 'board') {
                    await page.evaluate(() => { window.boardPrint = null; addEventListener('beforeprint', () => { window.boardPrint = document.querySelector('.picture-print-only')?.textContent; }); });
                    await page.keyboard.press('Enter');
                    assert.equal(await page.evaluate(() => window.boardPrint), await input.inputValue());
                    await panel.getByRole('button', { name: 'Go to your top gaps' }).focus();
                    await page.keyboard.press('Enter');
                    assert.equal(await page.evaluate(() => document.activeElement.id), 'ncsc-results-top-gaps');
                }
            }
            if (campaign === 'supplier') {
                const first = panel.getByRole('button', { name: 'Jump to the first answer to verify' });
                await first.focus(); await page.keyboard.press('Enter');
                assert.equal(await page.evaluate(() => document.activeElement.id), 'ncsc-supplier-first-evidence');
            }
            assert.deepEqual(await page.evaluate(() => window.storageWrites), []);
            const writes = (await page.evaluate(() => window.transportCalls)).filter(call => call.method !== 'GET');
            assert.equal(writes.length, 1);
            assert.ok(writes[0].url.endsWith('/submit'));
            results.push({ campaign: campaign || 'none', answer, gate, first, screenshot: name + '-375.png' }); await context.close();
        }
        assert.deepEqual(errors, []);
        const sources = files.map(file => ({ path: file, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
        fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify({ passed: true, syntheticOnly: true, viewport: { width: 375, height: 844 }, browser: browser.version(), results, errors, storageWrites: 0, confirmedSubmissions: results.length, otherTransportWrites: 0,
            requests: requests.reduce((counts, request) => { const key = request.method + ' ' + request.path; counts[key] = (counts[key] || 0) + 1; return counts; }, {}), sources }, null, 2));
        console.log(JSON.stringify({ passed: true, cases: results.length, artifacts }));
    } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
