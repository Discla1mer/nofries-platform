'use strict';

// Optional synthetic rendering check using installed Playwright and Chromium.
// No installation, provider login, customer data or external requests.
// node scripts/tests/retained-result-presentation-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildRetainedTrialReadDocument, contentSecurityPolicy } = require('../../lib/retainedTrialReadDocument');
const { createRetainedTrialAssessmentReader } = require('../../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture } = require('../../test/fixtures/retainedTrialReadFixture');

async function main() {
    const fixture = await retainedTrialFixture();
    const result = JSON.parse(JSON.stringify(await createRetainedTrialAssessmentReader(fixture.options).read({}, fixture.input)));
    result.assessment.assessmentId = 'synthetic-' + 'a'.repeat(150);
    result.assessment.scopePopulation.description = 'Synthetic scope ' + 'long-unbroken-text'.repeat(70);
    result.assessment.responses[0].rationale = { text: 'Synthetic rationale ' + 'a'.repeat(2000) };
    const documents = Object.fromEntries(['signin', 'unavailable', 'result'].map(status => [status,
        buildRetainedTrialReadDocument({ selection: fixture.input, result: status === 'result' ? result : null, status })]));
    documents.missing = buildRetainedTrialReadDocument();
    const root = path.resolve(__dirname, '../..'), requests = [], problems = [], cases = [];
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        const url = new URL(req.url, 'http://localhost');
        if (['/style.css', '/home.css', '/favicon.svg'].includes(url.pathname)) {
            res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'image/svg+xml');
            return res.end(fs.readFileSync(path.join(root, url.pathname.slice(1))));
        }
        res.setHeader('Content-Security-Policy', contentSecurityPolicy);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET' && documents[url.pathname.slice(1)]) return res.end(documents[url.pathname.slice(1)]);
        if (req.method === 'POST' && url.pathname === '/api/retained-results') {
            // Observe the existing native form locally; never contact production.
            let body = '';
            req.on('data', chunk => { body += chunk; });
            return req.on('end', () => {
                if (body) problems.push('Unexpected logout fields');
                res.end(documents.signin);
            });
        }
        res.statusCode = 404; res.end('Synthetic fixture only');
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true });
        const context = await browser.newContext();
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin !== origin) {
                problems.push('Blocked external request'); return route.abort();
            }
            return route.continue();
        });
        for (const width of [360, 768, 1440]) {
            for (const status of Object.keys(documents)) {
                const page = await context.newPage();
                page.on('pageerror', error => problems.push(error.message));
                page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
                await page.setViewportSize({ width, height: 900 });
                await page.goto(origin + '/' + status);
                await page.keyboard.press('Tab');
                assert.equal(await page.locator('.skip-link').evaluate(el => el === document.activeElement), true);
                await page.keyboard.press('Enter');
                assert.equal(await page.locator('#saved-results-title').evaluate(el => el === document.activeElement), true);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${status}/${width} overflow`);
                assert.equal(await page.locator('input, textarea, select, script').count(), 0);
                await page.keyboard.press('Tab');
                const destination = status === 'result' ? 'button[type="submit"]' : status === 'missing' ? 'a[href="/privacy.html"]' : 'a.button';
                assert.equal(await page.locator(destination).evaluate(el => el === document.activeElement), true);
                const focus = await page.locator(destination).evaluate(el => {
                    const css = getComputedStyle(el); return { style: css.outlineStyle, width: parseFloat(css.outlineWidth) };
                });
                assert.ok(focus.style !== 'none' && focus.width >= 2);
                if (status === 'result') {
                    assert.ok((await page.locator('article').innerText()).includes(result.assessment.assessmentId));
                    assert.ok((await page.locator('article').innerText()).includes('2026-11-02 12:00:02.000 UTC'));
                    await Promise.all([page.waitForURL(origin + '/api/retained-results'), page.keyboard.press('Enter')]);
                    assert.equal(await page.locator('h1').innerText(), 'Open your saved result');
                }
                cases.push({ width, status, keyboard: 'pass', overflow: 'none' });
                await page.close();
            }
        }
        assert.deepEqual(problems, []);
        assert.equal(requests.filter(req => req.method === 'POST').length, 3);
        assert.ok(requests.every(req => req.method === 'GET' || req.url === '/api/retained-results'));
        console.log(JSON.stringify({ synthetic: true, cases, logoutPosts: 3, externalRequests: 0, pageErrors: 0 }, null, 2));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
