'use strict';

// Local synthetic evidence only; does not emulate or qualify Azure authorization.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildDevSite } = require('../build-dashboard-dev-site');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dev-browser-'));
const build = buildDevSite(path.join(artifacts, 'site'));
const config = JSON.parse(fs.readFileSync(path.join(build.output, 'staticwebapp.config.json')));
const requests = [], unexpected = [], errors = [], observations = [], probes = [];
const journeys = [];
const server = http.createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html', ...config.globalHeaders });
    res.end(fs.readFileSync(path.join(build.output, 'index.html')));
});

const button = (page, name) => page.getByRole('button', { name, exact: true });
async function practiceJourney(page, width) {
    await button(page, 'Start or reopen practice assessment').click();
    // Reset's announcement must not describe Overview after navigating to Cyber.
    assert.equal(await page.locator('#preview-status').textContent(), '');
    await button(page, 'Start an assessment').click();
    await page.locator('#ncsc-scope').fill('Synthetic practice A <img src=x onerror=alert(1)>');
    await button(page, 'Create assessment').click();
    await page.getByRole('radio', { name: 'Partial', exact: true }).check();
    await button(page, 'Save progress').click();
    await page.getByText('Saved revision 1. Your progress is saved.', { exact: true }).waitFor();
    await button(page, 'Review practice answers').click();
    assert.match(await page.locator('.dashboard-picture-workspace').innerText(), /Partial: 1/);
    await button(page, 'Review practice follow-up').click();
    assert.match(await page.locator('.dashboard-improvement-workspace').innerText(), /Synthetic practice A[\s\S]*preview guidance/);
    assert.equal(await page.locator('.dashboard-improvement-workspace img').count(), 0);
    await button(page, 'Return to practice answers').click();
    await button(page, 'Start or reopen practice assessment').click();
    await button(page, 'Continue assessment').click();
    // Reopen chooses the first unanswered question; retain its unsent draft.
    await page.getByRole('radio', { name: 'Unknown', exact: true }).check();
    await button(page, 'Review practice answers').click();
    await button(page, 'Stay here').click();
    assert.equal(await page.getByRole('radio', { name: 'Unknown', exact: true }).isChecked(), true);
    await button(page, 'Review practice answers').click();
    await button(page, 'Save and leave').click();
    await button(page, 'Start or reopen practice assessment').waitFor();
    assert.match(await page.locator('.dashboard-picture-workspace').innerText(), /Unknown: 1/);
    await button(page, 'Start or reopen practice assessment').click();
    await button(page, 'Continue assessment').click();
    for (let index = 0; index < 12; index++) {
        await page.getByRole('radio', { name: 'No', exact: true }).check();
        if (index < 11) await button(page, 'Next unanswered question').click();
    }
    await button(page, 'Submit assessment').click();
    await page.locator('.ncsc-sealed').waitFor();
    await button(page, 'Review practice answers').click();
    assert.match(await page.locator('.dashboard-picture-workspace').innerText(), /No: 12[\s\S]*Unanswered: 0/);
    assert.doesNotMatch(await page.locator('.dashboard-picture-workspace').innerText(), /\d+\.\d+%/);
    // A second selected assessment must not inherit A's answer/gap summary.
    await button(page, 'Start or reopen practice assessment').click();
    await button(page, 'Start an assessment').click();
    await page.locator('#ncsc-scope').fill('Synthetic practice B');
    await button(page, 'Create assessment').click();
    await page.getByRole('radio', { name: 'Yes', exact: true }).check();
    await button(page, 'Save progress').click();
    await page.getByText('Saved revision 1. Your progress is saved.', { exact: true }).waitFor();
    await button(page, 'Review practice answers').click();
    const second = await page.locator('.dashboard-picture-workspace').innerText();
    assert.match(second, /Synthetic practice B[\s\S]*Yes: 1[\s\S]*Partial: 0/);
    assert.doesNotMatch(second, /Synthetic practice A/);
    await button(page, 'Review practice follow-up').click();
    assert.equal(await page.locator('.dashboard-improvement-workspace li').count(), 13);
    await page.screenshot({ path: path.join(artifacts, 'practice-follow-up-' + width + '.png'), fullPage: false });
    await button(page, 'Return to practice answers').click();
    await button(page, 'Review seeded example results').click();
    await page.locator('.picture-metrics').waitFor();
    assert.match(await page.locator('.dashboard-picture-workspace').innerText(), /unrelated to your practice answers/);
    await button(page, 'Plan improvements for this assessment').click();
    assert.match(await page.locator('.dashboard-improvement-workspace').innerText(), /SEEDED EXAMPLE PLAN/);
    assert.equal(await page.locator('.dashboard-improvement-workspace article').count(), 14);
    await page.screenshot({ path: path.join(artifacts, 'seeded-plan-' + width + '.png'), fullPage: false });
    assert.equal(await page.locator('a[href]:not([href^="#"])').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    // Scenario replacement, Reset and a genuine document reload each start empty.
    await page.locator('#scenario').selectOption({ index: 1 });
    await page.locator('#scenario').selectOption({ index: 0 });
    assert.match(await page.locator('.dashboard-picture-workspace').innerText(), /Create or reopen a practice assessment/);
    await createEmptyRecord(page, 'Synthetic Reset check');
    await button(page, 'Reset preview').click();
    await practiceEmpty(page);
    await createEmptyRecord(page, 'Synthetic reload check');
    await page.reload(); await practiceEmpty(page);
    journeys.push({ width, saveReopen: true, leaveDecision: true, submitWithoutScore: true,
        selectedAssessmentIsolation: true, seededPlan: true, resetScenarioReloadClear: true });
}
async function practiceEmpty(page) {
    await button(page, 'Start or reopen practice assessment').click();
    await page.getByText('No saved assessments yet.', { exact: true }).waitFor();
    await button(page, 'Review practice answers').click();
}
async function createEmptyRecord(page, scope) {
    await button(page, 'Start or reopen practice assessment').click();
    await button(page, 'Start an assessment').click();
    await page.locator('#ncsc-scope').fill(scope);
    await button(page, 'Create assessment').click();
    await page.getByRole('radio', { name: 'Yes', exact: true }).waitFor();
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let browser, completed = false;
    try {
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
        await context.route('**/*', route => {
            if (route.request().url() === origin + '/' && route.request().method() === 'GET') return route.continue();
            unexpected.push(route.request().url()); return route.abort();
        });
        await context.addInitScript(() => {
            window.previewViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                window.previewViolations.push({ directive: event.effectiveDirective, target: event.blockedURI });
            });
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
            assert.equal(await page.locator('#scenario option').count(), 9);
            assert.equal(await page.locator('#preview-revision').textContent(), build.commit + (build.dirty ? '-dirty' : ''));
            for (let index = 0; index < 9; index++) {
                await page.locator('#scenario').selectOption({ index });
                await page.locator('.dashboard-main h1').waitFor();
                assert.equal(await page.locator('.dashboard-main h1').textContent(), index === 3 ? 'Cyber Security' : 'Overview');
                const nav = page.locator(width > 800 ? '.dashboard-rail nav' : '.dashboard-mobile-nav');
                const menu = nav.locator('details');
                if (await menu.count()) await menu.locator('summary').click();
                const keys = await nav.locator('a[data-module]').evaluateAll(links => links.map(link => link.dataset.module));
                for (const key of keys) {
                    const link = nav.locator('[data-module="' + key + '"]');
                    if (!(await link.isVisible())) await menu.locator('summary').click();
                    const href = await link.getAttribute('href');
                    await link.click();
                    assert.equal(new URL(page.url()).hash, href);
                    assert.equal(await link.getAttribute('aria-current'), 'page');
                    assert.ok(await page.locator('.dashboard-main h1').textContent());
                }
                const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
                assert.ok(fits, width + 'px / scenario ' + index + ' fits viewport');
                observations.push({ width, scenario: index, navigation: keys, fits });
            }
            const reset = page.getByRole('button', { name: 'Reset preview', exact: true });
            await reset.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
            assert.equal(await reset.evaluate(node => node === document.activeElement && parseFloat(getComputedStyle(node).outlineWidth) >= 3), true);
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#scenario').evaluate(node => node.selectedIndex), 0);
            assert.equal(new URL(page.url()).hash, '#overview');
            await practiceJourney(page, width);
            await page.screenshot({ path: path.join(artifacts, 'dashboard-' + width + '.png'), fullPage: true });
            assert.deepEqual(await page.evaluate(() => window.previewViolations), []);
            assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: '' });
        }
        // Genuine browser CSP, with an independent network abort as a safety net.
        // No probe may reach an HTTP server, including a production origin.
        probes.push(...await page.evaluate(async () => {
            const outcomes = [];
            for (const url of ['/api/dashboard', '/api/dashboard/ncsc/assessments', 'https://nofries.nz/api/dashboard']) {
                try { await fetch(url); outcomes.push({ url, blocked: false }); }
                catch { outcomes.push({ url, blocked: true }); }
            }
            return outcomes;
        }));
        assert.ok(probes.every(probe => probe.blocked));
        await page.waitForFunction(() => window.previewViolations.filter(row => row.directive === 'connect-src').length >= 3);
        probes.push(...await page.evaluate(() => window.previewViolations));
        assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        assert.equal(requests.length, 6);
        completed = true;
        console.log(JSON.stringify({ completed, browser: browser.version(), scenarios: observations.length, requests: requests.length, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ completed, build, browser: browser?.version(), observations, journeys, requests, unexpected, errors, probes }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
