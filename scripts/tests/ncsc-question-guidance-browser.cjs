'use strict';

// Actual local Chromium + the existing synthetic preview and real renderer/CSS.
// Uses existing installations only; no real account, authentication or writes.
// NOFRIES_QUESTION_GUIDANCE_ARTIFACTS may select a private external directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPreview, buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const artifacts = path.resolve(process.env.NOFRIES_QUESTION_GUIDANCE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-question-guidance-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep synthetic artifacts outside the checkout');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sources = ['api/shared/protectedAssets/ncscQuestionnaire.js', 'app/dashboard.css',
    'api/shared/ncscQuestionnaireMetadata.js', 'api/shared/assessmentEngine/ncscAcceptedFrameworkProfile.js',
    'scripts/build-ncsc-questionnaire-preview.js', 'scripts/tests/ncsc-question-guidance-browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes(), preview = buildPreview(path.join(artifacts, 'questionnaire.html'));
const { metadata } = buildFixtures();
const results = [], errors = [], outside = [], requests = [];
const files = new Map([['/questionnaire.html', preview.output], ['/questionnaire-frame.html', preview.frameOutput]]);
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ method: request.method, path: pathname }); response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || !files.has(pathname)) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fs.readFileSync(files.get(pathname)));
});

async function openAssessment(page) {
    const cyber = page.locator('.dashboard-module-link[data-module="cyber_security"]');
    if (await cyber.isVisible()) await cyber.click();
    else await page.getByRole('navigation', { name: 'Dashboard tasks', exact: true })
        .getByRole('button', { name: 'Assess', exact: true }).click();
    await page.locator('.ncsc-assessment-list button').first().click();
    await page.locator('#ncsc-question-index').waitFor();
}

async function textMetrics(locator) {
    await locator.evaluate(element => element.scrollIntoView({ block: 'center' }));
    return locator.evaluate(element => {
        const box = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
        return { text: element.textContent, left: box.left, right: box.right, height: box.height,
            whiteSpace: getComputedStyle(element).whiteSpace, viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            lines: [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ left: rect.left, right: rect.right,
                unobscured: element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) })) };
    });
}

function fits(metric) {
    assert.ok(metric.height > 0 && metric.lines.length > 0, 'Text is actually rendered');
    assert.notEqual(metric.whiteSpace, 'nowrap', 'Guidance can wrap');
    assert.ok(metric.left >= -1 && metric.right <= metric.viewport + 1, 'Guidance fits the viewport');
    assert.ok(metric.lines.every(rect => rect.left >= metric.left - 1 && rect.right <= metric.right + 1), 'Guidance text fits its box');
    assert.ok(metric.lines.every(rect => rect.unobscured), 'Guidance text can be read without a fixed control covering it');
    assert.ok(metric.scrollWidth <= metric.viewport + 1, 'No horizontal page overflow');
}

(async () => {
    let browser, failure = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.questionGuidanceViolations = []; window.questionGuidanceTransport = [];
                document.addEventListener('securitypolicyviolation', event => window.questionGuidanceViolations.push(event.effectiveDirective));
                // Observe only the existing in-memory preview transport, preserving
                // the actual client factory. A write makes this read-only test fail.
                let factory;
                Object.defineProperty(window, 'NoFriesNcscAssessmentClient', {
                    configurable: true, get: () => factory,
                    set(value) {
                        factory = Object.freeze({ ...value, createClient(options) {
                            return value.createClient({ ...options, fetch(url, init = {}) {
                                const method = init.method || 'GET';
                                window.questionGuidanceTransport.push({ method, path: new URL(url, location.origin).pathname });
                                if (method !== 'GET') throw new Error('Unexpected synthetic transport write');
                                return options.fetch(url, init);
                            } });
                        } });
                    }
                });
            });
            await page.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== origin || request.method() !== 'GET') { outside.push(request.method()); return route.abort(); }
                return route.continue();
            });
            await page.goto(origin + '/questionnaire-frame.html'); await openAssessment(page);
            const picker = page.getByLabel('Question', { exact: true }), measurements = [];
            const originalTransport = await page.evaluate(() => window.questionGuidanceTransport);
            assert.ok(originalTransport.length > 0 && originalTransport.every(request => request.method === 'GET'));
            for (const [index, question] of metadata.questions.entries()) {
                await picker.selectOption(String(index));
                assert.equal(await page.locator('.ncsc-question legend').textContent(), question.prompt);
                const hint = page.locator('#ncsc-input-guidance-' + question.id);
                assert.equal(await hint.isVisible(), true, 'Question hint is visible with guidance closed');
                assert.equal(await page.locator('.ncsc-answer').getAttribute('aria-describedby'), 'ncsc-input-guidance-' + question.id);
                const selectedBefore = await page.locator('.ncsc-answer input:checked').evaluateAll(inputs => inputs.map(input => input.value));
                const guidance = page.locator('.ncsc-guidance').filter({ has: page.locator('summary', { hasText: /^Guidance and evidence examples$/ }) });
                const summary = guidance.locator('summary'), example = guidance.locator('.ncsc-input-example');
                assert.equal(await guidance.evaluate(element => element.open), false);
                const hintMetric = await textMetrics(hint); fits(hintMetric);
                if (index === 1 || width === 320 && index === 5) {
                    await page.screenshot({ path: path.join(artifacts, 'viewport-question-' + (index + 1) + '-' + width + '.png') });
                    await page.locator('.ncsc-answer').screenshot({ path: path.join(artifacts, 'question-' + (index + 1) + '-' + width + '.png') });
                }
                await summary.focus(); await page.keyboard.press('Space');
                assert.equal(await guidance.evaluate(element => element.open), true, 'Native disclosure opens with Space');
                assert.equal(await example.isVisible(), true);
                const exampleMetric = await textMetrics(example); fits(exampleMetric);
                assert.match(exampleMetric.text, /^Example: .+ (Yes|Partial|No|Unknown)\b/);
                const guidanceText = await guidance.textContent();
                assert.ok(guidanceText.includes(question.guidance.summary));
                for (const text of [...question.guidance.evidenceExamples, ...question.guidance.startingActions]) assert.ok(guidanceText.includes(text));
                assert.ok(guidanceText.includes('Document upload is not enabled here.'));
                assert.deepEqual(await page.locator('.ncsc-answer input:checked').evaluateAll(inputs => inputs.map(input => input.value)), selectedBefore,
                    'Reading examples cannot choose or change an answer');
                if (index === 1) {
                    await page.screenshot({ path: path.join(artifacts, 'viewport-guidance-2-' + width + '.png') });
                    await guidance.screenshot({ path: path.join(artifacts, 'guidance-2-' + width + '.png') });
                }
                await summary.focus(); await page.keyboard.press('Enter');
                assert.equal(await guidance.evaluate(element => element.open), false, 'Native disclosure closes with Enter');
                measurements.push({ id: question.id, hint: hintMetric, example: exampleMetric });
            }
            await picker.focus(); await page.keyboard.press('Home'); assert.equal(await picker.inputValue(), '0');
            await page.keyboard.press('ArrowDown'); assert.equal(await picker.inputValue(), '1');
            await page.keyboard.press('End'); assert.equal(await picker.inputValue(), String(metadata.questions.length - 1));
            await picker.selectOption('0');
            const partial = page.locator('.ncsc-answer input[value="partial"]'); await partial.focus(); await page.keyboard.press('Space');
            assert.equal(await page.locator('.ncsc-answer input[value="partial"]').isChecked(), true);
            await picker.selectOption('1'); await picker.selectOption('0');
            assert.equal(await page.locator('.ncsc-answer input[value="partial"]').isChecked(), true, 'Navigation retains the unsaved answer');
            assert.match(await page.locator('.ncsc-status').textContent(), /unsaved changes/);
            // This seeded draft has unanswered questions. Submission must stop at
            // client validation, retain the hint and error, and issue no command.
            await page.getByRole('button', { name: 'Submit assessment', exact: true }).click();
            await page.locator('.ncsc-errors a').first().click();
            const described = (await page.locator('.ncsc-answer').getAttribute('aria-describedby')).split(' ');
            assert.equal(described.length, 2);
            assert.ok(described[0].startsWith('ncsc-input-guidance-') && described[1].startsWith('ncsc-error-'));
            assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-invalid')), 'true');
            assert.equal(await page.locator('input[type="file"]').count(), 0);
            const transport = await page.evaluate(() => window.questionGuidanceTransport);
            assert.deepEqual(transport, originalTransport, 'Guidance, local answer changes and validation make no transport calls');
            assert.deepEqual(await page.evaluate(() => window.questionGuidanceViolations), []);
            results.push({ width, questions: measurements.length, measurements, keyboard: true, unsavedAnswerPreserved: true,
                validationHintAndError: true, transportReads: transport.length, transportWrites: 0 });
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(hashes(), before);
    } catch (error) { failure = error.message; }
    finally {
        const receipt = { passed: failure === null, failure, results, errors, outside, requests,
            sourceBefore: before, sourceAfter: hashes(), preview, browser: browser && browser.version(), syntheticOnly: true };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify({ passed: failure === null, failure, cases: results.length, artifacts }));
    if (failure) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
