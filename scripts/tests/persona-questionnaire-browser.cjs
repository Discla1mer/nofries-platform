'use strict';

// Optional Chromium regression check using the actual renderer and CSS with the
// repository's in-memory transport. This is not authentication, SQL or scoring
// evidence. Requires existing Playwright and Chromium installations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-persona-questionnaire-'));
const preview = buildPreview(path.join(directory, 'questionnaire.html'));
const files = new Map([['/questionnaire-frame.html', preview.frameOutput]]);
const errors = [], unexpected = [], measurements = [];
const server = http.createServer((request, response) => {
    const file = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (request.method !== 'GET' || !file) {
        unexpected.push(request.method + ' ' + request.url);
        response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(file));
});

async function visibleQuestion(page) {
    const value = await page.locator('.ncsc-question legend').evaluate(legend => {
        const box = legend.getBoundingClientRect();
        const navigation = document.querySelector('.dashboard-mobile-nav');
        const navBox = navigation && navigation.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, viewport: innerHeight,
            focused: document.activeElement === legend,
            visibleBottom: navBox && navBox.height && navBox.top > 0 ? Math.min(innerHeight, navBox.top) : innerHeight,
            overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.equal(value.focused, true, 'Opening or changing a question focuses its prompt');
    assert.ok(value.top >= -1 && value.bottom <= value.visibleBottom + 1,
        'The whole question must be visible immediately: ' + JSON.stringify(value));
    assert.ok(value.overflow <= 1, 'No horizontal overflow');
    return value;
}

async function openAssessment(page, id) {
    await page.locator('.ncsc-assessment-list button[data-assessment-id="' + id + '"]').click();
    await page.locator('#ncsc-question-index').waitFor();
    return visibleQuestion(page);
}

async function saveAtPointer(page, delayed) {
    if (delayed) await page.evaluate(() => {
        document.getElementById('scenario').value = 'delay';
        document.getElementById('arm-scenario').click();
    });
    const save = page.locator('#ncsc-save');
    await save.evaluate(button => { button.focus(); button.scrollIntoView({ block: 'center' }); });
    const before = await save.evaluate(button => {
        const box = button.getBoundingClientRect();
        return { scroll: scrollY, question: document.getElementById('ncsc-question-index').value,
            x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.dblclick(before.x, before.y, { delay: 50 });
    if (delayed) assert.equal(await save.isDisabled(), true, 'Save is disabled during an outstanding mutation');
    await page.waitForFunction(() => {
        const button = document.getElementById('ncsc-save');
        return button && !button.disabled && /Your progress is saved/.test(document.querySelector('.ncsc-save-status').textContent);
    });
    const after = await save.evaluate(button => ({ scroll: scrollY, focused: document.activeElement === button,
        activeElement: document.activeElement.id || document.activeElement.tagName }));
    assert.ok(Math.abs(before.scroll - after.scroll) <= 2,
        'Save preserves scroll after a double-click: ' + JSON.stringify({ before, after }));
    assert.equal(after.focused, true, 'Save retains keyboard focus: ' + JSON.stringify(after));
    assert.equal(await page.locator('#ncsc-question-index').inputValue(), before.question, 'Double-clicking Save stays on the same question');
    return { delayed, scrollBefore: before.scroll, scrollAfter: after.scroll };
}

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        browser = await chromium.launch({ headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
            const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.personaViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.personaViolations.push(event.effectiveDirective));
            });
            await page.route('**/*', route => {
                if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') {
                    unexpected.push(route.request().method() + ' ' + route.request().url()); return route.abort();
                }
                return route.continue();
            });
            await page.goto(origin + '/questionnaire-frame.html');
            await page.locator('.dashboard-module-link[data-module="cyber_security"]:visible').first().click();
            const initial = await openAssessment(page, 'assessment-a');
            await page.getByRole('button', { name: 'Next question', exact: true }).click();
            await visibleQuestion(page);
            await page.locator('.ncsc-question input[value="no"]').check();
            assert.match(await page.locator('#ncsc-draft-progress').textContent(), /Unsaved changes/);
            const delayedSave = await saveAtPointer(page, true);
            await page.locator('.ncsc-question input[value="yes"]').check();
            const immediateSave = await saveAtPointer(page, false);

            await page.getByRole('button', { name: 'Back to assessments', exact: true }).click();
            await openAssessment(page, 'assessment-b');
            await page.getByRole('button', { name: 'Submit assessment', exact: true }).click();
            assert.equal(await page.locator('#ncsc-confirm-title').evaluate(node => document.activeElement === node), true);
            assert.equal(await page.locator('#ncsc-submitted').count(), 0, 'Opening review does not submit');
            assert.match(await page.locator('.ncsc-submit-review').textContent(), /Unknown/);
            await page.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
            assert.equal(await page.locator('#ncsc-submitted').count(), 0, 'Cancelling review leaves the draft editable');
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isEnabled(), true);
            await page.getByRole('button', { name: 'Submit assessment', exact: true }).click();
            await page.getByRole('button', { name: 'Confirm submission', exact: true }).click();
            await page.locator('#ncsc-submitted').waitFor();
            assert.equal(await page.locator('#ncsc-submitted').evaluate(node => document.activeElement === node), true);
            assert.match(await page.locator('.ncsc-status').textContent(), /Submitted/);
            assert.equal(await page.locator('.ncsc-next-steps li').count(), 14);
            assert.match(await page.locator('#ncsc-provider-summary').inputValue(), /Scope:.*\nSubmitted:/);
            assert.doesNotMatch(await page.locator('#ncsc-submitted').textContent(), /T\d\d:\d\d|revision/);
            await page.getByRole('button', { name: 'Retry loading results', exact: true }).click();
            await page.locator('#ncsc-submitted').waitFor();
            assert.equal(await page.locator('.ncsc-question input[value="unknown"]').isDisabled(), true);
            assert.deepEqual(await page.evaluate(() => window.personaViolations), []);
            measurements.push({ viewport, initial, saves: [delayedSave, immediateSave], submission: 'review, cancel, confirm, retry passed' });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        console.log(JSON.stringify({ syntheticBrowserChecks: measurements }, null, 2));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
