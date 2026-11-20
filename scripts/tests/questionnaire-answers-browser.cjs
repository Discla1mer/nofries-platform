'use strict';

// Real Chromium, production renderer/CSS and the existing synthetic saved result.
// Run with installed Playwright/Chromium; artifacts stay outside runtime packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');

const { allResponses } = require('../../test/fixtures/ncscAssessmentFixture');

async function main() {
    const artifacts = process.env.NOFRIES_ANSWER_ARTIFACTS || '/tmp/nofries-questionnaire-answers';
    fs.mkdirSync(artifacts, { recursive: true });
    const submitted = allResponses('no');
    submitted.find(row => row.itemId === 'NF-NCSC-MCSS-LP-01-Q1').optionId = 'partial';
    submitted.find(row => row.itemId === 'NF-NCSC-CC-SV-01-Q1').optionId = 'yes';
    const preview = buildPreview(path.join(artifacts, 'questionnaire.html'), submitted);
    const errors = [], requests = [], transport = [];
    const server = http.createServer((req, res) => {
        requests.push(req.method);
        if (req.method !== 'GET' || req.url !== '/questionnaire-frame.html') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(preview.frameOutput));
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ['clipboard-read', 'clipboard-write'] });
        await context.route('**/*', route => {
            assert.equal(new URL(route.request().url()).origin, origin);
            assert.equal(route.request().method(), 'GET'); return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.answerTransport = []; window.answerCspErrors = [];
            document.addEventListener('securitypolicyviolation', event => window.answerCspErrors.push(event.effectiveDirective));
            let factory;
            Object.defineProperty(window, 'NoFriesNcscAssessmentClient', { configurable: true, get: () => factory, set(value) {
                factory = { ...value, createClient(options) { return value.createClient({ ...options, fetch(url, init = {}) {
                    window.answerTransport.push(init.method || 'GET');
                    if (init.method && init.method !== 'GET') throw new Error('Unexpected write');
                    return options.fetch(url, init);
                } }); } };
            } });
        });
        await page.goto(origin + '/questionnaire-frame.html');
        await page.locator('.dashboard-module-link[data-module="cyber_security"]').filter({ visible: true }).click();
        await page.getByRole('button', { name: 'Load more assessments', exact: true }).click();
        await page.locator('.ncsc-assessment-list li').filter({ hasText: 'Submitted' }).getByRole('button').first().click();
        const section = page.locator('.ncsc-questionnaire-answers'); await section.waitFor();
        assert.equal(await section.locator('li').count(), 9);
        assert.deepEqual(await section.locator('li strong').allTextContents(), ['No', 'Not answered', 'No', 'Not answered', 'Not answered', 'No', 'No', 'Partly', 'Yes'].map(answer => 'Suggested answer: ' + answer));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const input = section.getByLabel('Answers to copy'), expected = await input.inputValue();
        const rows = await section.locator('li').evaluateAll(items => items.map(item => Array.from(item.children, child => child.textContent)));
        const evidence = [];
        for (const row of rows) {
            const hints = row.filter(line => line.startsWith('Evidence: '));
            assert.equal(hints.length, row[1] === 'Suggested answer: Yes' ? 0 : 1);
            assert.ok(expected.split('\n\n').includes(row.join('\n')));
            evidence.push(...hints);
        }
        assert.equal(await input.getAttribute('readonly'), '');
        await section.locator('h3').evaluate(title => title.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(artifacts, 'viewport-375.png') });
        await section.screenshot({ path: path.join(artifacts, 'answers-375.png') });
        const before = await page.evaluate(() => window.answerTransport);
        await section.getByRole('button', { name: 'Copy answers', exact: true }).click();
        await section.getByRole('status').filter({ hasText: 'Summary copied.' }).waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
        await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('Synthetic clipboard denial')); });
        await section.getByRole('button', { name: 'Copy answers', exact: true }).click();
        await section.getByRole('status').filter({ hasText: 'Summary selected.' }).waitFor();
        assert.equal(await input.evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
        await page.evaluate(() => {
            window.answerPrints = 0; window.answerBeforePrint = 0;
            addEventListener('beforeprint', () => { window.answerBeforePrint++; });
            const original = window.print.bind(window); window.print = () => { window.answerPrints++; original(); };
        });
        await section.getByRole('button', { name: 'Print answers', exact: true }).click();
        assert.equal(await page.evaluate(() => window.answerPrints), 1);
        assert.ok(await page.evaluate(() => window.answerBeforePrint > 0));
        await page.emulateMedia({ media: 'print' });
        assert.equal(await section.locator('.ncsc-questionnaire-answer-controls').isVisible(), false);
        assert.equal(await section.locator('footer').isVisible(), true);
        const pdf = path.join(artifacts, 'results-print.pdf');
        await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
        const pages = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).split('\f');
        const first = pages.findIndex(text => text.includes('Answers for your insurer or customer questionnaire'));
        assert.ok(first >= 0); let last = first;
        while (last < pages.length && !pages[last].includes('not a guarantee')) last++;
        assert.ok(last < pages.length, 'Printed footer is present');
        const printed = pages.slice(first, last + 1).join(' ').replace(/\s+/g, ' ');
        for (const question of await section.locator('h4').allTextContents()) assert.ok(printed.includes(question), question);
        assert.equal(printed.match(/Evidence: /g)?.length, evidence.length);
        for (const line of evidence) assert.ok(printed.includes(line), line);
        for (let i = first; i <= last; i++) execFileSync('pdftoppm', ['-f', String(i + 1), '-l', String(i + 1), '-scale-to', '1440', '-png', '-singlefile', pdf, path.join(artifacts, 'print-page-' + (i + 1))]);
        transport.push(...await page.evaluate(() => window.answerTransport));
        assert.deepEqual(transport, before); assert.ok(transport.every(method => method === 'GET'));
        assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.answerCspErrors), []);
        fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify({ passed: true, syntheticOnly: true, viewport: { width: 375, height: 812 }, browser: browser.version(),
            copy: 'real clipboard and rejection fallback passed', print: 'native beforeprint and A4 PDF passed', printPages: [first + 1, last + 1],
            transport, requests, errors, sources: preview.sources }, null, 2));
        console.log(JSON.stringify({ passed: true, artifacts, printPages: [first + 1, last + 1], transportWrites: 0 }));
    } finally {
        if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
