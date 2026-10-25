'use strict';

// Optional actual-Chromium regression test using existing installations only.
// node scripts/tests/ncsc-question-text-browser.cjs
// NOFRIES_QUESTION_TEXT_ARTIFACTS selects a private external output directory.
// NOFRIES_QUESTION_TEXT_RECORD_BASELINE=1 records the unmodified RED control.
// The existing preview supplies actual renderer/CSS and process-local synthetic
// records. This is not authentication, SQL, scoring or customer acceptance proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPreview, buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const artifacts = path.resolve(process.env.NOFRIES_QUESTION_TEXT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-question-text-')));
assert.ok(path.relative(root, artifacts).startsWith('..' + path.sep), 'Keep synthetic artifacts outside the checkout');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const recordBaseline = process.env.NOFRIES_QUESTION_TEXT_RECORD_BASELINE === '1';
const sources = ['api/shared/protectedAssets/ncscQuestionnaire.js', 'app/dashboard.css',
    'api/shared/ncscQuestionnaireMetadata.js', 'scripts/build-ncsc-questionnaire-preview.js',
    'scripts/tests/ncsc-question-text-browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes();
const preview = buildPreview(path.join(artifacts, 'questionnaire.html'));
const { metadata } = buildFixtures();
const results = [], problems = [], errors = [], outside = [], requests = [];
const files = new Map([['/questionnaire.html', preview.output], ['/questionnaire-frame.html', preview.frameOutput]]);
const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ method: request.method, path: pathname });
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || !files.has(pathname)) { response.statusCode = 404; return response.end(); }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(files.get(pathname)));
});

async function openAssessment(page) {
    const cyber = page.locator('.dashboard-module-link[data-module="cyber_security"]');
    if (await cyber.isVisible()) await cyber.click();
    else {
        await page.getByRole('navigation', { name: 'Dashboard tasks', exact: true })
            .getByRole('button', { name: 'Assess', exact: true }).click();
    }
    await page.locator('.ncsc-assessment-list button').first().click();
    await page.locator('#ncsc-question-index').waitFor();
}

async function measure(page, questionIndex) {
    // Long pages remain scrollable. Centre the prompt before checking actual
    // paint visibility so the fixed mobile task bar cannot mask an observed line.
    await page.locator('.ncsc-question legend').evaluate(node => node.scrollIntoView({ block: 'center' }));
    return page.evaluate(({ questionIndex, expected }) => {
        const picker = document.getElementById('ncsc-question-index');
        const legend = document.querySelector('.ncsc-question legend');
        const field = legend.parentElement.getBoundingClientRect();
        const box = legend.getBoundingClientRect(), style = getComputedStyle(legend);
        const range = document.createRange(); range.selectNodeContents(legend);
        const textRects = [...range.getClientRects()].filter(r => r.width > 0).map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        const characterRects = [];
        for (let i = 0; i < legend.firstChild.length; i++) {
            if (/\s/.test(legend.firstChild.textContent[i])) continue;
            range.setStart(legend.firstChild, i); range.setEnd(legend.firstChild, i + 1);
            const rect = range.getBoundingClientRect();
            const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
            characterRects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                unobscured: Boolean(hit && legend.contains(hit)) });
        }
        const pickerStyle = getComputedStyle(picker), canvas = document.createElement('canvas');
        const context = canvas.getContext('2d'); context.font = pickerStyle.font;
        // Reserve the native arrow as well as declared control padding. A native
        // single-line selected value cannot display text wider than this box.
        const available = picker.clientWidth - parseFloat(pickerStyle.paddingLeft) - parseFloat(pickerStyle.paddingRight) - 24;
        return { questionIndex, expected, text: legend.textContent, whiteSpace: style.whiteSpace,
            legend: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height },
            field: { left: field.left, right: field.right }, textRects, characterRects,
            choices: [...picker.options].map(option => ({ text: option.textContent, width: context.measureText(option.textContent).width })),
            available, pageWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    }, { questionIndex, expected: metadata.questions[questionIndex].prompt });
}

function check(metric, prefix) {
    const failed = [];
    if (metric.text !== metric.expected) failed.push(prefix + ': full prompt changed');
    if (metric.whiteSpace === 'nowrap') failed.push(prefix + ': prompt cannot wrap');
    if (!metric.characterRects.length || metric.characterRects.some(r => r.right <= r.left || r.bottom <= r.top ||
        r.left < Math.max(metric.legend.left, metric.field.left) - 1 || r.right > Math.min(metric.legend.right, metric.field.right) + 1 ||
        r.top < metric.legend.top - 1 || r.bottom > metric.legend.bottom + 1)) failed.push(prefix + ': prompt character clipped');
    if (metric.characterRects.some(r => !r.unobscured)) failed.push(prefix + ': visible prompt character obscured');
    if (metric.scrollWidth > metric.pageWidth + 1) failed.push(prefix + ': page overflows horizontally');
    if (metric.choices.some(choice => choice.width > metric.available + 1)) failed.push(prefix + ': native selector text exceeds its display box');
    problems.push(...failed);
    if (!recordBaseline) assert.deepEqual(failed, []);
}

(async () => {
    let browser, failure = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const width of [1280, 1024, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 950 } });
            const page = await context.newPage(); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => { window.questionTextViolations = []; document.addEventListener('securitypolicyviolation', e => window.questionTextViolations.push(e.effectiveDirective)); });
            await page.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin !== origin || request.method() !== 'GET') { outside.push(request.method()); return route.abort(); }
                return route.continue();
            });
            await page.goto(origin + '/questionnaire-frame.html'); await openAssessment(page);
            const picker = page.getByLabel('Question', { exact: true });
            assert.equal(await picker.locator('option').count(), metadata.questions.length);
            const measurements = [];
            for (let index = 0; index < metadata.questions.length; index++) {
                await picker.selectOption(String(index));
                const metric = await measure(page, index); measurements.push(metric); check(metric, width + '/question' + (index + 1));
                if (index === 1) {
                    await page.locator('.ncsc-questionnaire').screenshot({ path: path.join(artifacts, 'question-2-' + width + '.png') });
                    await picker.screenshot({ path: path.join(artifacts, 'selector-2-' + width + '.png') });
                    await page.locator('.ncsc-question legend').evaluate(node => node.scrollIntoView({ block: 'center' }));
                    await page.locator('.ncsc-question legend').screenshot({ path: path.join(artifacts, 'prompt-2-' + width + '.png') });
                }
            }
            await picker.selectOption('0'); await picker.focus(); await page.keyboard.press('ArrowDown');
            assert.equal(await picker.inputValue(), '1');
            assert.equal(await page.locator('.ncsc-question legend').textContent(), metadata.questions[1].prompt);
            const no = page.locator('.ncsc-question input[value="no"]');
            await no.focus(); await page.keyboard.press('Space');
            await picker.selectOption('2'); await picker.selectOption('1');
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true, 'navigation retains the local answer');
            assert.match(await page.locator('.ncsc-status').textContent(), /unsaved changes/);
            check(await measure(page, 1), width + '/dirty-answer');
            const last = metadata.questions.length - 1;
            await picker.selectOption(String(last));
            await page.locator('.ncsc-question input[value="not_applicable"]').check();
            await page.locator('.ncsc-question textarea').first().fill('Synthetic pending exclusion.');
            check(await measure(page, last), width + '/dirty-pending-na');
            await page.getByRole('button', { name: 'Save progress', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            await picker.selectOption('1');
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true, 'save retains the selected answer');
            check(await measure(page, 1), width + '/saved-answer');
            assert.deepEqual(await page.evaluate(() => window.questionTextViolations), []);
            results.push({ width, questionCount: metadata.questions.length, measurements, keyboardAndDraftAndSyntheticSave: true });
            await context.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(hashes(), before);
        if (recordBaseline) assert.ok(problems.length > 0, 'The original source must reproduce clipping');
        else assert.deepEqual(problems, []);
    } catch (error) { failure = error.message; }
    finally {
        const receipt = { passed: failure === null && !recordBaseline && problems.length === 0, recordBaseline,
            failure, problems, results, errors, outside, requests, sourceBefore: before, sourceAfter: hashes(),
            preview, browser: browser && browser.version(), syntheticOnly: true };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify({ passed: failure === null && !recordBaseline && problems.length === 0,
        recordBaseline, failure, cases: results.length, problems: problems.length, artifacts }));
    if (failure || recordBaseline || problems.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
