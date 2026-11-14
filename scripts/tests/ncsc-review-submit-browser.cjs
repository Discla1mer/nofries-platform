'use strict';

// Actual local Chromium + the existing synthetic preview and real renderer/CSS.
// Uses existing installations only; no real account, authentication or network.
// Writes reach only the preview's in-memory transport. NOFRIES_REVIEW_ARTIFACTS
// may select a private external directory for screenshots and the receipt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');
const { ncscFixture, createCommand, saveCommand, submitCommand, SUBJECT } = require('../../test/fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../../api/shared/ncscAssessmentService');

// The general preview deliberately omits calculated results on interactive
// submission. For this check only, evaluate the submitted synthetic answers in
// Node using the real domain evaluator. No scoring arithmetic runs in the page.
function evaluatedSubmission(detail) {
    const fixture = ncscFixture({ tenantId: 'synthetic-review-browser', organisationId: 'shared-preview-organisation' });
    const commands = [createCommand(detail.assessmentId, 'browser-create', detail.scopePopulation.description)];
    for (let revision = 0; revision < detail.revision - 1; revision++) {
        commands.push(saveCommand(detail.assessmentId, revision, 'browser-save-' + revision, detail.responses));
    }
    commands.push(submitCommand(detail.assessmentId, detail.revision - 1, 'browser-submit'));
    let version = null;
    for (const command of commands) version = makeVersion({ ...fixture.scope, actorSubjectKey: SUBJECT,
        assessmentId: command.assessmentId, action: command.action, expectedRevision: command.expectedRevision,
        payload: command.payload }, command.idempotencyKey, version, fixture.state.tenantAggregate, detail.updatedAt);
    return projectNcscDetail(version);
}

const root = path.resolve(__dirname, '../..');
const artifacts = path.resolve(process.env.NOFRIES_REVIEW_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-review-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep synthetic artifacts outside the checkout');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const preview = buildPreview(path.join(artifacts, 'questionnaire.html'));
const files = new Map([['/questionnaire.html', preview.output], ['/questionnaire-frame.html', preview.frameOutput]]);
const results = [], errors = [], outside = [];
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || !files.has(pathname)) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fs.readFileSync(files.get(pathname)));
});

const button = (page, name) => page.getByRole('button', { name, exact: true });
const writes = page => page.evaluate(() => window.reviewTransport.filter(row => row.method !== 'GET').map(row => row.path.split('/').at(-1)));
const focusedId = page => page.evaluate(() => document.activeElement && document.activeElement.id);
async function press(page, locator, key = 'Enter') { await locator.focus(); await page.keyboard.press(key); }
async function openAssessment(page, index) {
    // Desktop shows the sidebar link; narrow layouts show the task link instead.
    if (await page.locator('.ncsc-assessment-list').count() === 0) await page.locator('.dashboard-module-link[data-module="cyber_security"]:visible').first().click();
    await page.locator('.ncsc-assessment-list button').nth(index).click();
    await page.locator('#ncsc-question-index').waitFor();
}
async function layout(page, name, width) {
    const metric = await page.evaluate(() => {
        const review = document.querySelector('.ncsc-review'), box = review.getBoundingClientRect();
        const items = [...review.querySelectorAll('.ncsc-review-item, .ncsc-review-actions button')].map(item => item.getBoundingClientRect());
        return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, left: box.left, right: box.right,
            itemsInside: items.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1) };
    });
    assert.ok(metric.scrollWidth <= metric.viewport + 1, 'No horizontal page overflow at ' + width);
    assert.ok(metric.left >= -1 && metric.right <= metric.viewport + 1, 'Review fits the viewport at ' + width);
    assert.ok(metric.itemsInside, 'Review rows and actions stay inside the review at ' + width);
    await page.locator('.ncsc-review').screenshot({ path: path.join(artifacts, name + '-' + width + '.png') });
    return metric;
}

(async () => {
    let browser, failure = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            await context.exposeFunction('evaluateSyntheticSubmission', evaluatedSubmission);
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.reviewTransport = [];
                let factory;
                Object.defineProperty(window, 'NoFriesNcscAssessmentClient', {
                    configurable: true, get: () => factory,
                    set(value) {
                        factory = Object.freeze({ ...value, createClient(options) {
                            return value.createClient({ ...options, async fetch(url, init = {}) {
                                window.reviewTransport.push({ method: init.method || 'GET', path: new URL(url, location.origin).pathname });
                                const response = await options.fetch(url, init);
                                if (!response.ok || !String(url).endsWith('/submit')) return response;
                                const body = JSON.parse(await response.text());
                                body.assessment = await window.evaluateSyntheticSubmission(body.assessment);
                                return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
                            } });
                        } });
                    }
                });
            });
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().method()); return route.abort(); }
                return route.continue();
            });
            await page.goto(origin + '/questionnaire-frame.html');

            // Sparse draft: unanswered items, a saved N/A explanation and a local unsaved answer.
            await openAssessment(page, 0);
            await page.getByLabel('Question', { exact: true }).selectOption('3');
            await press(page, page.locator('.ncsc-answer input[value="yes"]'), 'Space');
            await press(page, button(page, 'Review and submit'));
            assert.equal(await focusedId(page), 'ncsc-review-title', 'Opening review moves focus to its heading');
            const review = page.locator('.ncsc-review');
            assert.match(await review.textContent(), /Synthetic population A: office and cloud services\./);
            assert.match(await review.textContent(), /N\/A explanation: Synthetic pending N\/A claim/);
            assert.match(await page.locator('.ncsc-review-item').nth(3).textContent(), /Answer: Yes.*Not saved yet/);
            assert.match(await page.locator('.ncsc-review-item').nth(4).textContent(), /Answer: Unanswered/);
            assert.match(await page.locator('#ncsc-review-readiness').textContent(), /^Before you can submit, answer 10 questions/);
            const sparse = await layout(page, 'review-sparse', width);

            // Keyboard: Tab moves between edit actions; edit, change, return to the same row.
            const edit4 = button(page, 'Edit question 4'); await edit4.focus(); await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit question 5');
            await press(page, edit4);
            assert.equal(await page.evaluate(() => document.activeElement.tagName), 'LEGEND', 'Edit focuses the question');
            await press(page, page.locator('.ncsc-answer input[value="unknown"]'), 'Space');
            await press(page, button(page, 'Return to review'));
            assert.match(await focusedId(page), /^ncsc-review-edit-/, 'Return focuses the edited row action');
            assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit question 4');
            assert.match(await page.locator('.ncsc-review-item').nth(3).textContent(), /Answer: Unknown.*Not saved yet/);
            await press(page, button(page, 'Back to questions'));
            assert.equal(await page.evaluate(() => document.activeElement.tagName), 'LEGEND');
            assert.deepEqual(await writes(page), [], 'Opening, editing from, returning to and leaving review write nothing');

            // Confirmation with missing answers stops at validation and writes nothing.
            await press(page, button(page, 'Review and submit'));
            await press(page, button(page, 'Save and submit assessment'));
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ncsc-errors')), true);
            await press(page, page.locator('.ncsc-errors a').first());
            assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-invalid')), 'true');
            assert.equal(await button(page, 'Return to review').count(), 1);
            assert.deepEqual(await writes(page), []);
            await press(page, button(page, 'Back to assessments')); await press(page, button(page, 'Discard unsent changes'));
            await page.locator('.ncsc-assessment-list button').first().waitFor();

            // Complete draft: one unsaved change, then one explicit confirmation saves then submits once.
            await openAssessment(page, 1);
            await press(page, page.locator('.ncsc-answer input[value="no"]'), 'Space');
            await press(page, button(page, 'Review and submit'));
            assert.match(await page.locator('#ncsc-review-readiness').textContent(), /^Every question has an answer/);
            assert.match(await page.locator('#ncsc-review-consequence').textContent(), /1 unsaved answer is saved first/);
            const complete = await layout(page, 'review-complete', width);
            assert.deepEqual(await writes(page), []);
            await button(page, 'Save and submit assessment').click();
            await button(page, 'Submit').evaluate(element => { element.click(); element.click(); });
            await page.locator('.ncsc-sealed').waitFor();
            await page.getByRole('heading', { name: 'Assessment results', exact: true }).waitFor();
            assert.equal(await page.locator('.ncsc-results .ncsc-result-metric').count(), 3, 'Calculated results render after confirmation');
            assert.doesNotMatch(await page.locator('.ncsc-results').textContent(), /Results are unavailable/);
            assert.deepEqual(await writes(page), ['save', 'submit'], 'Repeated activation sends one save and one submit');
            assert.equal(await page.locator('.ncsc-review').count(), 0);
            assert.equal(await button(page, 'Review and submit').count(), 0);
            await page.screenshot({ path: path.join(artifacts, 'sealed-' + width + '.png') });
            results.push({ width, sparse, complete, keyboard: true, writes: await writes(page) });
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    } catch (error) { failure = error.message; }
    finally {
        const receipt = { passed: failure === null, failure, results, errors, outside, browser: browser && browser.version(), syntheticOnly: true };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify({ passed: failure === null, failure, cases: results.length, artifacts }));
    if (failure) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
