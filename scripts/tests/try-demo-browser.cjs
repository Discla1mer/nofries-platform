'use strict';

// Optional actual-Chromium check for the fictional demo (#29), using existing installations only.
// node scripts/tests/try-demo-browser.cjs   (NOFRIES_TRY_DEMO_SCREENSHOTS=<dir> keeps screenshots)
// Loopback only. Fails on any request other than the page itself, or any CSP violation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createNoFriesApp } = require('../../server');
const { STORAGE_KEY } = require('../../demo/try/try-demo');

const shots = process.env.NOFRIES_TRY_DEMO_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nf-try-demo-'));
fs.mkdirSync(shots, { recursive: true });
async function tabTo(page, predicate, limit = 60) {
    for (let index = 0; index < limit; index++) { await page.keyboard.press('Tab'); if (await page.evaluate(predicate)) return; }
    throw new Error('Keyboard focus did not reach the expected control');
}
// Full-page captures draw fixed elements (the shell's off-screen skip link) at the scroll offset.
async function shot(page, file, fullPage = true) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(shots, file), fullPage }); }
const focusedText = page => page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());

function contrast(first, second) {
    const luminance = color => color.match(/\d+(?:\.\d+)?/g).slice(0, 3)
        .map(value => Number(value) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
}

async function checkPalette(page) {
    const palette = await page.evaluate(() => {
        const dashboard = getComputedStyle(document.querySelector('.nofries-dashboard'));
        const token = name => {
            const hex = dashboard.getPropertyValue('--dashboard-' + name).trim();
            return 'rgb(' + [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')';
        };
        const colors = selector => {
            const style = getComputedStyle(document.querySelector(selector));
            return { text: style.color, background: style.backgroundColor, border: style.borderTopColor };
        };
        return { ink: token('ink'), paper: token('paper'), surface: token('surface'), yellow: token('yellow'),
            body: colors('body'), banner: colors('.try-demo-banner'), reset: colors('#try-demo-reset'), cta: colors('.try-demo-cta') };
    });
    assert.equal(palette.body.background, palette.paper, 'page uses dashboard paper');
    assert.equal(palette.banner.background, palette.yellow, 'banner uses dashboard mustard');
    assert.equal(palette.banner.text, palette.ink, 'banner uses dashboard ink');
    assert.equal(palette.reset.background, palette.surface, 'reset uses dashboard surface');
    assert.equal(palette.reset.text, palette.ink);
    assert.equal(palette.cta.background, palette.ink);
    assert.equal(palette.cta.text, palette.surface);
    for (const control of [palette.banner, palette.reset, palette.cta]) assert.ok(contrast(control.text, control.background) >= 4.5, 'demo text has AA contrast');
    assert.ok(contrast(palette.reset.border, palette.banner.background) >= 3, 'reset boundary is visible');
    assert.ok(contrast(palette.cta.background, palette.banner.background) >= 3, 'contact control is visible');
    await tabTo(page, () => document.activeElement.id === 'try-demo-reset');
    for (const label of ['Reset demo', 'Talk to No Fries', 'No Fries home']) {
        assert.equal(await focusedText(page), label);
        const focus = await page.evaluate(() => {
            const element = document.activeElement; const style = getComputedStyle(element);
            return { color: style.outlineColor, width: parseFloat(style.outlineWidth), style: style.outlineStyle,
                visible: element.matches(':focus-visible'), height: element.getBoundingClientRect().height };
        });
        assert.ok(focus.visible && focus.style === 'solid' && focus.width >= 3, label + ': visible focus');
        assert.ok(contrast(focus.color, palette.banner.background) >= 3, label + ': focus contrast');
        assert.ok(focus.height >= 46, label + ': 2.875rem touch target');
        await page.keyboard.press('Tab');
    }
}

async function run(browser, origin, name, viewport) {
    const context = await browser.newContext({ viewport, isMobile: name !== 'desktop', hasTouch: name !== 'desktop' });
    const page = await context.newPage();
    const unexpected = [];
    page.on('request', request => { if (request.url().split('#')[0] !== origin + '/try') unexpected.push(request.url()); });
    page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) unexpected.push(message.text()); });
    page.on('pageerror', error => unexpected.push(error.message));
    await page.goto(origin + '/try');
    await page.evaluate(() => localStorage.setItem('nofries.unrelated', 'kept'));
    assert.match(await page.locator('.try-demo-banner').innerText(), /fictional business/);
    assert.equal(await page.locator('h1').innerText(), 'Overview');
    assert.match(await page.locator('.dashboard-attention').innerText(), /Review who has administrator access/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': no horizontal scroll');
    await checkPalette(page);
    await shot(page, name + '-1-overview.png', name !== 'mobile');

    if (name === 'desktop') {
        // Keyboard only: rail link, start, six radio groups, submit.
        await tabTo(page, () => document.activeElement.matches('.dashboard-rail a') && document.activeElement.textContent.includes('Cyber Security'));
        await page.keyboard.press('Enter');
        assert.equal(await focusedText(page), 'Cyber Security');
        await tabTo(page, () => document.activeElement.textContent.startsWith('Start the sample questions'));
        await page.keyboard.press('Enter');
        assert.equal(await focusedText(page), 'Sample questions');
        for (const keys of [['Space'], ['ArrowDown'], ['ArrowDown', 'ArrowDown'], ['Space'], ['Space'], ['ArrowDown', 'ArrowDown', 'ArrowDown']]) {
            await page.keyboard.press('Tab');
            for (const key of keys) await page.keyboard.press(key);
        }
        assert.equal(await page.locator('[role="status"]', { hasText: 'answered' }).innerText(), '6 of 6 answered');
        await shot(page, 'desktop-2-questions.png');
        await tabTo(page, () => document.activeElement.textContent === 'See sample results');
        await page.keyboard.press('Enter');
    } else {
        await page.locator('.dashboard-mobile-nav a', { hasText: 'Cyber Security' }).tap();
        await page.getByRole('button', { name: 'Start the sample questions' }).tap();
        await page.getByRole('button', { name: 'See sample results' }).tap();
        assert.match(await page.getByRole('alert').innerText(), /Answer all six questions/);
        assert.equal(await page.evaluate(() => document.activeElement.name), 'try-demo-mfa');
        await page.getByRole('button', { name: 'Use example answers' }).tap();
        await page.getByRole('button', { name: 'See sample results' }).tap();
    }
    assert.equal(await focusedText(page), 'Sample results');
    const actions = await page.locator('[data-action]').evaluateAll(rows => rows.map(row => row.dataset.action + ':' + row.querySelector('.dashboard-badge').textContent));
    assert.deepEqual(actions, name === 'desktop'
        ? ['updates:High priority', 'restore:High priority', 'admins:Medium priority']
        : ['admins:High priority', 'restore:High priority', 'mfa:Medium priority', 'protection:Medium priority']);
    assert.equal(await page.locator('.ncsc-result-metric').count(), 3);
    const badgeColors = await page.locator('.try-demo-actions-list [data-priority="High"]').first().evaluate(element => {
        const style = getComputedStyle(element); const dashboard = getComputedStyle(element.closest('.nofries-dashboard'));
        return { text: style.color, background: style.backgroundColor, border: style.borderColor,
            expectedBackground: dashboard.getPropertyValue('--dashboard-navy').trim(), expectedBorder: dashboard.getPropertyValue('--dashboard-control-border').trim() };
    });
    const rgb = hex => 'rgb(' + [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')';
    assert.equal(badgeColors.background, rgb(badgeColors.expectedBackground), 'priority badge uses dashboard tint');
    assert.equal(badgeColors.border, rgb(badgeColors.expectedBorder), 'priority badge uses dashboard border');
    assert.ok(contrast(badgeColors.text, badgeColors.background) >= 4.5, 'priority text has AA contrast');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': results fit');
    assert.equal(await page.getByRole('link', { name: 'Talk to No Fries about your real IT' }).getAttribute('href'), '/contact.html');
    await shot(page, name + '-3-results.png');

    await page.reload();
    assert.equal(await page.locator('h2', { hasText: 'Sample results' }).count(), 1, 'progress survives reload');
    const reset = page.getByRole('button', { name: 'Reset demo' });
    if (name === 'desktop') { await reset.focus(); await page.keyboard.press('Enter'); } else await reset.tap();
    assert.match(await page.locator('#try-demo-status').innerText(), /Demo reset/);
    assert.equal(await page.locator('h1').innerText(), 'Overview');
    assert.ok(['', '#overview'].includes(new URL(page.url()).hash), 'reset leaves the assessment route');
    assert.deepEqual(await page.evaluate(key => [localStorage.getItem(key), localStorage.getItem('nofries.unrelated')], STORAGE_KEY), [null, 'kept']);
    await page.goto(origin + '/try#cyber-security');
    assert.equal(await page.getByRole('button', { name: 'Start the sample questions' }).count(), 1, 'reset cleared answers');
    assert.deepEqual(await context.cookies(), []);
    assert.deepEqual(unexpected, [], name + ': no network, CSP or script errors');
    await context.close();
}

(async () => {
    const server = createNoFriesApp({ tryDemo: true }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    try {
        await run(browser, origin, 'desktop', { width: 1280, height: 860 });
        await run(browser, origin, 'mobile', { width: 390, height: 844 });
        await run(browser, origin, 'narrow', { width: 320, height: 844 });
        console.log('Try demo browser check passed (1280px keyboard, 390px and 320px touch). Screenshots: ' + shots);
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
