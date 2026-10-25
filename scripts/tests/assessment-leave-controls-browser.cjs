'use strict';

// Optional Chromium acceptance; uses the installed Playwright, no dependency change.
// NOFRIES_LEAVE_CONTROLS_ARTIFACTS writes synthetic screenshots and a result receipt.
// NOFRIES_LEAVE_CONTROLS_BASELINE_ROOT reads an unchanged checkout for before evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const baseline = process.env.NOFRIES_LEAVE_CONTROLS_BASELINE_ROOT;
const root = baseline || path.resolve(__dirname, '../..');
const { buildPreview } = require(path.join(root, 'scripts/build-ncsc-questionnaire-preview'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-leave-controls-'));
const preview = buildPreview(path.join(temporary, 'questionnaire.html'));
const artifacts = process.env.NOFRIES_LEAVE_CONTROLS_ARTIFACTS;
const errors = [], unexpected = [], results = [];
const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/questionnaire-frame.html') {
        unexpected.push(request.method + ' ' + request.url); response.writeHead(404); return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(preview.frameOutput));
});
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function keyboardClick(page, control) { await control.focus(); await page.keyboard.press('Enter'); }
async function openAssessment(page) {
    const desktop = page.locator('.dashboard-module-link[data-module="cyber_security"]').first();
    if (await desktop.isVisible()) await keyboardClick(page, desktop);
    else await keyboardClick(page, page.getByRole('navigation', { name: 'Dashboard tasks', exact: true })
        .getByRole('button', { name: 'Assess', exact: true }));
    await page.locator('.ncsc-assessment-list button').first().click();
    await page.locator('#ncsc-question-index').selectOption('1');
}
async function choose(page, value) { await page.locator('.ncsc-question input[value="' + value + '"]').check(); }
async function leave(page) {
    await keyboardClick(page, button(page, 'Back to assessments'));
    await page.locator('dialog[open]').waitFor();
    assert.equal(await button(page, 'Stay here').evaluate(node => node === document.activeElement), true);
}
async function arm(page, scenario) {
    await page.locator('#scenario').selectOption(scenario);
    await button(page, 'Arm next mutation').click();
}
async function geometry(page, label) {
    const layout = await page.locator('dialog[open]').evaluate(dialog => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(dialog),
            scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
            controls: [...dialog.querySelectorAll('button')].map(node => ({ label: node.textContent, ...rect(node),
                borderColor: getComputedStyle(node).borderTopColor, outlineStyle: getComputedStyle(node).outlineStyle,
                outlineWidth: getComputedStyle(node).outlineWidth, focused: node === document.activeElement })) };
    });
    assert.ok(layout.dialog.x >= 0 && layout.dialog.right <= layout.viewport.width);
    assert.ok(layout.dialog.y >= 0 && layout.dialog.bottom <= layout.viewport.height);
    assert.ok(layout.scrollWidth <= layout.clientWidth, label + ': no horizontal overflow inside dialog');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const control of layout.controls) {
        assert.ok(control.height >= 44 && control.width >= 44, label + ': touch target');
        assert.ok(control.x >= layout.dialog.x && control.right <= layout.dialog.right);
    }
    const [save, discard, stay] = layout.controls;
    assert.equal(stay.focused, true);
    assert.equal(stay.outlineStyle, 'solid'); assert.equal(stay.outlineWidth, '3px');
    if (!baseline) {
        assert.ok(save.bottom < discard.y, label + ': primary action has its own row');
        assert.notEqual(discard.borderColor, 'rgba(0, 0, 0, 0)');
        assert.notEqual(stay.borderColor, 'rgba(0, 0, 0, 0)');
        if (layout.viewport.width <= 480) {
            assert.ok(discard.bottom < stay.y, label + ': secondary controls stack');
            assert.ok(Math.abs(save.width - stay.width) < 1);
        } else {
            assert.equal(discard.y, stay.y); assert.ok(discard.right < stay.x);
        }
    }
    if (artifacts) {
        fs.mkdirSync(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, label + '.png') });
    }
    return layout;
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
                    unexpected.push(request.method() + ' unexpected request'); return route.abort();
                }
                return route.continue();
            });
            await page.addInitScript(() => {
                window.violations = [];
                document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
            });
            await page.goto(origin + '/questionnaire-frame.html');
            await openAssessment(page); await choose(page, 'no'); await leave(page);
            const layout = await geometry(page, (baseline ? 'before-' : 'after-') + width);
            // DOM order, focus trap in both directions, Escape and repeated cancellation.
            for (const name of ['Save and leave', 'Discard unsent changes', 'Stay here']) {
                await page.keyboard.press('Tab');
                assert.equal(await button(page, name).evaluate(node => node === document.activeElement), true);
            }
            for (const name of ['Discard unsent changes', 'Save and leave', 'Stay here']) {
                await page.keyboard.press('Shift+Tab');
                assert.equal(await button(page, name).evaluate(node => node === document.activeElement), true);
            }
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('dialog').count(), 0);
            assert.equal(await button(page, 'Back to assessments').evaluate(node => node === document.activeElement), true);
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
            await leave(page); await page.keyboard.press('Enter'); // Initially focused Stay.
            assert.equal(await page.locator('dialog').count(), 0);
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
            // Discard only the unsent answer, then reopen the same saved record.
            await leave(page); await keyboardClick(page, button(page, 'Discard unsent changes'));
            await openAssessment(page);
            assert.equal(await page.locator('.ncsc-question input[value="unknown"]').isChecked(), true);
            // Save and leave once; repeat entry and confirm persistence/revision in the fixture.
            await choose(page, 'no'); await leave(page);
            await keyboardClick(page, button(page, 'Save and leave'));
            await openAssessment(page);
            assert.equal(await page.locator('.ncsc-question input[value="no"]').isChecked(), true);
            assert.match(await page.locator('.ncsc-status').textContent(), /Saved revision 2/);
            // Interrupt a delayed save with Stay. Existing in-flight operation must finish safely.
            await choose(page, 'partial'); await arm(page, 'delay'); await leave(page);
            await keyboardClick(page, button(page, 'Save and leave'));
            assert.equal(await button(page, 'Save and leave').isDisabled(), true);
            assert.equal(await button(page, 'Discard unsent changes').isDisabled(), true);
            await keyboardClick(page, button(page, 'Stay here'));
            await keyboardClick(page, button(page, 'Back to assessments'));
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Resolve the running'));
            assert.equal(await page.locator('dialog').count(), 0);
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('Your progress is saved.'));
            assert.match(await page.locator('.ncsc-status').textContent(), /Saved revision 3/);
            // A lost response leaves an unconfirmed operation; retry acknowledges the same revision.
            await choose(page, 'yes'); await arm(page, 'lost'); await leave(page);
            await keyboardClick(page, button(page, 'Save and leave'));
            await button(page, 'Retry same operation').waitFor();
            await keyboardClick(page, button(page, 'Back to assessments'));
            assert.equal(await page.locator('dialog').count(), 0);
            await keyboardClick(page, button(page, 'Retry same operation'));
            await page.waitForFunction(() => document.querySelector('.ncsc-status')?.textContent.includes('The operation is confirmed'));
            await keyboardClick(page, button(page, 'Back to assessments')); await openAssessment(page);
            assert.equal(await page.locator('.ncsc-question input[value="yes"]').isChecked(), true);
            assert.match(await page.locator('.ncsc-status').textContent(), /Saved revision 4/);
            // Short viewport/reflow and forced colors retain keyboard-reachable controls.
            await choose(page, 'no'); await leave(page);
            await page.setViewportSize({ width, height: 480 });
            await geometry(page, (baseline ? 'before-' : 'after-') + width + '-short');
            await page.emulateMedia({ forcedColors: 'active' });
            await geometry(page, (baseline ? 'before-' : 'after-') + width + '-forced-colors');
            await page.emulateMedia({ media: 'print' });
            assert.equal(await page.locator('dialog[open]').isVisible(), false);
            await page.emulateMedia({ media: 'screen' });
            await page.keyboard.press('Escape');
            assert.deepEqual(await page.evaluate(() => window.violations), []);
            results.push({ width, layout, keyboardTrapAndReturn: true, repeatedStayAndEscape: true,
                discardPreservesSavedAnswer: true, saveAndReturn: true, interruptedDelayedSave: true,
                lostResponseRetrySameRevision: true, shortViewportAndForcedColors: true, hiddenInPrint: true });
            await page.close();
        }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        for (const source of preview.sources) assert.equal(createHash('sha256')
            .update(fs.readFileSync(path.join(root, source.path))).digest('hex'), source.sha256, 'Source changed during verification');
        const receipt = { results, pageErrors: 0, unexpectedRequests: 0, sources: preview.sources, syntheticOnly: true };
        if (artifacts) fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
        console.log(JSON.stringify(receipt));
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
