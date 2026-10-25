'use strict';

// Optional synthetic Chromium acceptance using the existing browser and Playwright.
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/tests/assessment-read-retry-browser.cjs
// No external requests, browser authentication, writes, screenshots or saved captures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildFixtures, createSyntheticTransport } = require('../build-ncsc-questionnaire-preview');
const { buildDashboardDocument } = require('../../lib/dashboardDocument');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = ['api/shared/protectedAssets/ncscAssessmentClient.js',
    'api/shared/protectedAssets/ncscQuestionnaire.js', 'app/dashboard.css'];
const sources = files.map(file => ({ file, content: read(file) }));
const app = sources.slice(0, 2).map(source => source.content).join('\n');
const css = sources[2].content;
const fixtures = buildFixtures();
const selectedId = 'assessment-submitted'; // Deliberately beyond the first two-record list page.
const selected = fixtures.tenants[0].assessments.find(row => row.assessmentId === selectedId);
const policy = buildDashboardDocument({ template: read('app/dashboard.html'),
    loaderSource: read('js/dashboard-loader.js'), protectedAppSource: app, protectedStyleSource: css });

// The actual client still validates every response and owns request cancellation.
// Detail responses are manually released; deliberately ignoring the fetch signal
// exercises a transport that delivers after navigation has already aborted it.
function fixtureApplication(seed, metadata, settings, makeTransport) {
    const transport = makeTransport(seed, metadata, settings);
    const region = document.getElementById('assessment');
    const pending = [];
    const fixture = window.fixture = { listCalls: [], readCalls: [], abortedReads: [], writes: 0,
        statusChanges: [], removedStatus: false };
    function problem(status, code) {
        return { status, ok: false, redirected: false,
            headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
            text: async () => JSON.stringify({ code }) };
    }
    const client = NoFriesNcscAssessmentClient.createClient({ metadata, fetch(url, options) {
        const target = new URL(url, 'https://synthetic-preview.invalid');
        if (options.method !== 'GET') { fixture.writes++; throw new Error('Synthetic read acceptance prohibits writes'); }
        const id = target.pathname.slice('/api/dashboard/ncsc/assessments'.length + 1);
        if (!id) {
            fixture.listCalls.push(target.searchParams.get('afterAssessmentId'));
            return transport.fetch(url, options);
        }
        fixture.readCalls.push(decodeURIComponent(id));
        const index = fixture.readCalls.length - 1;
        options.signal.addEventListener('abort', () => fixture.abortedReads.push(index), { once: true });
        return new Promise(resolve => pending.push({ resolve, url, options }));
    } });
    fixture.finishRead = outcome => {
        const request = pending.shift();
        if (!request) throw new Error('No pending synthetic detail read');
        if (outcome === 'success') request.resolve(transport.fetch(request.url, { ...request.options, signal: undefined }));
        else if (outcome === 'denied') request.resolve(problem(403, 'ncsc_access_denied'));
        else if (outcome === 'unavailable') request.resolve(problem(503, 'ncsc_unavailable'));
        else throw new Error('Unknown synthetic outcome');
    };
    NoFriesNcscQuestionnaire.mount(region, { metadata, client,
        organisationId: seed.model.context.organisationId, presentationMode: 'editable', window });
    const status = region.querySelector('.ncsc-status');
    fixture.sameStatus = () => region.querySelector('.ncsc-status') === status && status.isConnected;
    const observer = new MutationObserver(records => {
        if (records.some(record => [...record.removedNodes].some(node => node === status || node.contains?.(status)))) {
            fixture.removedStatus = true;
        }
        fixture.statusChanges.push(status.textContent);
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
}
const glue = `(${fixtureApplication.toString()})(${JSON.stringify(fixtures.tenants[0])},
    ${JSON.stringify(fixtures.metadata)}, ${JSON.stringify(fixtures)}, ${createSyntheticTransport.toString()});`;
const html = '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic saved-assessment read retry</title>' +
    '<link rel="icon" href="data:,"><link rel="stylesheet" href="/dashboard.css"></head><body class="nofries-dashboard">' +
    '<main id="assessment" class="dashboard-main"></main><script src="/app.js"></script>' +
    '<script src="/fixture.js"></script></body></html>';
const assets = { '/': ['text/html', html], '/app.js': ['text/javascript', app],
    '/dashboard.css': ['text/css', css], '/fixture.js': ['text/javascript', glue] };
const errors = [], unexpected = [], results = [];
const server = http.createServer((request, response) => {
    const asset = assets[request.url];
    if (request.method !== 'GET' || !asset) {
        unexpected.push('Unexpected loopback request'); response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': asset[0], 'Content-Security-Policy': policy.contentSecurityPolicy,
        'Cache-Control': 'no-store' }); response.end(asset[1]);
});
const button = (page, name) => page.getByRole('button', { name, exact: true });
const retry = page => button(page, 'Retry loading this assessment');
const back = page => button(page, 'Back to assessments');
async function keyboardClick(page, control, key = 'Enter') { await control.focus(); await page.keyboard.press(key); }
async function headingFocus(page, label) {
    assert.equal(await page.locator('#ncsc-title').evaluate(node => node === document.activeElement), true,
        label + ': focus returns to the attached questionnaire heading');
}
async function tabTo(page, control, label) {
    await page.keyboard.press('Tab');
    assert.equal(await control.evaluate(node => node === document.activeElement), true, label);
    assert.notEqual(await control.evaluate(node => getComputedStyle(node).outlineStyle), 'none', label + ': visible focus');
}
async function settle(page, outcome) {
    await page.evaluate(value => fixture.finishRead(value), outcome);
    // Flush async client validation, rendering and the live-region observer.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function status(page, expression) {
    await page.waitForFunction(source => new RegExp(source).test(document.querySelector('.ncsc-status')?.textContent), expression.source);
    assert.deepEqual(await page.locator('.ncsc-status').evaluate(node => ({
        role: node.getAttribute('role'), live: node.getAttribute('aria-live'), atomic: node.getAttribute('aria-atomic'),
        attached: fixture.sameStatus(), removed: fixture.removedStatus
    })), { role: 'status', live: 'polite', atomic: 'true', attached: true, removed: false });
}
async function selectSaved(page) {
    await button(page, 'Load more assessments').waitFor();
    assert.equal(await page.locator('.ncsc-assessment-list').textContent().then(text => text.includes(selectedId)), false);
    await keyboardClick(page, button(page, 'Load more assessments'));
    const target = page.locator('.ncsc-assessment-list li').filter({ hasText: 'Assessment reference: ' + selectedId }).getByRole('button');
    await target.waitFor(); await keyboardClick(page, target);
    await status(page, /^Loading the selected assessment\.$/); await headingFocus(page, 'Selected record loading');
}
async function requestState(page) {
    return page.evaluate(() => ({ lists: [...fixture.listCalls], reads: [...fixture.readCalls],
        aborted: [...fixture.abortedReads], writes: fixture.writes }));
}

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 390, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
            await page.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== origin || request.method() !== 'GET') {
                    unexpected.push('Unexpected browser request'); return route.abort();
                }
                return route.continue();
            });
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            await page.goto(origin); await selectSaved(page);
            await tabTo(page, back(page), 'Loading keeps Back keyboard reachable');
            await settle(page, 'unavailable');
            await status(page, /^The saved assessment could not be loaded\./); await headingFocus(page, 'First failure');
            assert.equal(await page.locator('.ncsc-assessment-list').count(), 0);
            assert.doesNotMatch(await page.locator('.ncsc-status').textContent(), /unsent draft/i);
            assert.deepEqual(await requestState(page), { lists: [null, 'assessment-b'], reads: [selectedId], aborted: [], writes: 0 });
            await tabTo(page, retry(page), 'Retry follows heading in keyboard order');
            await page.keyboard.press('Space');
            await status(page, /^Loading the selected assessment\.$/); await headingFocus(page, 'First keyboard retry');
            assert.equal(await retry(page).count(), 0);
            // Repeated activation during loading must not start another read.
            await page.keyboard.press('Enter'); await page.keyboard.press('Space');
            assert.deepEqual((await requestState(page)).reads, [selectedId, selectedId]);
            await tabTo(page, back(page), 'Back remains keyboard reachable during retry');
            await settle(page, 'unavailable');
            await status(page, /^The saved assessment could not be loaded\./); await headingFocus(page, 'Repeated failure');
            await tabTo(page, retry(page), 'Retry is reachable after the second failure');
            await page.keyboard.press('Enter');
            await status(page, /^Loading the selected assessment\.$/); await headingFocus(page, 'Second keyboard retry');
            await settle(page, 'success');
            await status(page, /^Saved revision /); await headingFocus(page, 'Successful recovery');
            assert.equal(await page.locator('.ncsc-result-provenance dt').filter({ hasText: /^Assessment$/ })
                .evaluate(node => node.nextElementSibling.textContent), selectedId);
            assert.match(await page.locator('.ncsc-status').textContent(), new RegExp('Saved revision ' + selected.revision + '\\.'));
            assert.deepEqual(await requestState(page), { lists: [null, 'assessment-b'],
                reads: [selectedId, selectedId, selectedId], aborted: [], writes: 0 });
            await tabTo(page, back(page), 'Recovered saved record offers keyboard Back');
            await page.keyboard.press('Space');
            await button(page, 'Load more assessments').waitFor(); await headingFocus(page, 'Back to saved list');

            for (const outcome of ['success', 'denied']) {
                await selectSaved(page);
                const before = await requestState(page);
                await tabTo(page, back(page), 'Back during pending read');
                await page.keyboard.press(outcome === 'success' ? 'Enter' : 'Space');
                await button(page, 'Load more assessments').waitFor(); await headingFocus(page, 'Cancelled read');
                const afterBack = await requestState(page);
                assert.deepEqual(afterBack.aborted, [...before.aborted, before.reads.length - 1], 'Back aborts selected read');
                const savedList = await page.locator('.ncsc-content').textContent();
                await settle(page, outcome);
                assert.equal(await page.locator('.ncsc-content').textContent(), savedList, 'Late ' + outcome + ' cannot replace the saved list');
                assert.equal(await retry(page).count(), 0);
                assert.equal(await page.locator('.ncsc-question').count(), 0);
                await headingFocus(page, 'Late ' + outcome);
                assert.deepEqual(await requestState(page), afterBack, 'No automatic read, list retry or mutation after late result');
            }
            const finalState = await requestState(page);
            assert.equal(finalState.writes, 0);
            assert.ok(finalState.reads.every(id => id === selectedId), 'Every read retains the exact selected ID');
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const changes = await page.evaluate(() => fixture.statusChanges);
            assert.ok(changes.some(text => text === 'Loading the selected assessment.'));
            assert.ok(changes.filter(text => text.startsWith('The saved assessment could not be loaded.')).length >= 2);
            assert.ok(changes.some(text => text.startsWith('Saved revision ')));
            results.push({ width, failFailSuccess: true, exactIdBeyondFirstPage: true, keyboardRetryAndBack: true,
                headingFocusAndTabOrder: true, persistentPoliteAtomicStatus: true, abortAndIgnoreLateSuccessOrDenial: true,
                detailReads: finalState.reads.length, listReads: finalState.lists.length, writes: finalState.writes,
                noHorizontalOverflow: true });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        const hashes = sources.map(source => {
            const hash = content => createHash('sha256').update(content).digest('hex');
            assert.equal(hash(read(source.file)), hash(source.content), 'Source changed during verification: ' + source.file);
            return { path: source.file, sha256: hash(source.content) };
        });
        console.log(JSON.stringify({ results, pageErrors: 0, unexpectedRequests: 0, sources: hashes, syntheticOnly: true }));
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
