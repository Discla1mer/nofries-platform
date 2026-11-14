'use strict';

// Optional actual-Chromium check for the fictional demo (#29), using existing installations only.
// node scripts/tests/try-demo-browser.cjs   (NOFRIES_TRY_DEMO_SCREENSHOTS=<dir> keeps screenshots)
// Loopback only. Fails on any request other than the page itself, any console error or CSP violation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createNoFriesApp } = require('../../server');
const { STORAGE_KEY } = require('../../demo/try/try-demo');

const shots = process.env.NOFRIES_TRY_DEMO_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nf-try-demo-'));
fs.mkdirSync(shots, { recursive: true });
const ANSWERS = ['yes', 'partial', 'no', 'unknown', 'yes', 'yes', 'partial', 'yes', 'yes', 'partial', 'yes', 'yes', 'no', 'yes'];
async function tabTo(page, predicate, limit = 60) {
    for (let index = 0; index < limit; index++) { await page.keyboard.press('Tab'); if (await page.evaluate(predicate)) return; }
    throw new Error('Keyboard focus did not reach the expected control');
}
// Full-page captures draw fixed elements (the shell's off-screen skip link) at the scroll offset.
async function shot(page, file, fullPage = true) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(shots, file), fullPage }); }
const fits = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const main = page => page.locator('main');
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
    for (const label of ['Reset demo', 'Create your account', 'Talk to No Fries', 'No Fries home']) {
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
    const touch = name !== 'desktop';
    const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    const unexpected = [];
    page.on('request', request => { if (request.url().split('#')[0] !== origin + '/try') unexpected.push(request.url()); });
    page.on('console', message => { if (message.type() === 'error' || /Content Security Policy|Refused to/i.test(message.text())) unexpected.push(message.text()); });
    page.on('pageerror', error => unexpected.push(error.message));
    const press = async locator => { if (touch) await locator.tap(); else await locator.click(); };
    await page.goto(origin + '/try');
    await page.evaluate(() => localStorage.setItem('nofries.unrelated', 'kept'));
    assert.match(await page.locator('.try-demo-banner').innerText(), /fictional business/);
    assert.equal(await page.getByRole('link', { name: 'Create your account' }).getAttribute('href'), '/login?intent=create');
    assert.equal(await page.locator('h1').innerText(), 'Overview');
    await main(page).getByText('28.6%–42.9%').first().waitFor();
    assert.equal(await page.getByRole('link', { name: 'Get help closing these gaps' }).getAttribute('href'), '/contact.html');
    assert.ok(await fits(page), name + ': no horizontal scroll');
    await checkPalette(page);
    await shot(page, name + '-1-overview.png', !touch);

    if (name === 'desktop') {
        await tabTo(page, () => document.activeElement.matches('.dashboard-rail a') && document.activeElement.textContent.includes('Cyber Security'));
        await page.keyboard.press('Enter');
    } else await page.locator('.dashboard-mobile-nav a', { hasText: 'Cyber Security' }).tap();
    await press(page.getByRole('button', { name: 'Start an assessment' }));
    await page.locator('#ncsc-scope').fill('Brightwater Joinery (fictional): all 9 staff, workshop and office laptops, Microsoft 365.');
    await press(page.getByRole('button', { name: 'Create assessment' }));
    await main(page).getByText('0 of 14 answered').waitFor();
    for (let index = 0; index < ANSWERS.length; index++) {
        await press(page.locator('main fieldset label').filter({ has: page.locator('input[value="' + ANSWERS[index] + '"]') }).first());
        if (index === 1) await shot(page, name + '-2-question.png');
        if (index < ANSWERS.length - 1) await press(page.getByRole('button', { name: 'Next question' }));
    }
    await press(page.getByRole('button', { name: 'Save progress' }));
    await main(page).getByText(/14 of 14 answered.*all saved/).waitFor();
    await press(page.getByRole('button', { name: 'Review and submit' }));
    await page.getByRole('heading', { name: 'Review your answers before submitting' }).waitFor();
    await press(page.getByRole('button', { name: 'Save and submit assessment' }));
    await press(page.getByRole('button', { name: 'Submit', exact: true }));
    await page.getByRole('heading', { name: 'Assessment results' }).waitFor();
    const results = await main(page).innerText();
    assert.match(results, /Reported implementation\s+67\.9%–75\.0%/, 'real scoring, lower bound first');
    assert.match(results, /Suggested follow-ups/);
    await press(page.getByText('Summary to share with your IT provider'));
    for (const label of ['Copy summary', 'Print these results']) assert.equal(await main(page).getByRole('button', { name: label }).first().isVisible(), true, label);
    assert.ok(await fits(page), name + ': results fit');
    await shot(page, name + '-3-results.png');

    await page.reload();
    await (touch ? page.locator('.dashboard-mobile-nav a', { hasText: 'Overview' }).tap() : page.locator('.dashboard-rail a', { hasText: 'Overview' }).click());
    await press(page.getByRole('button', { name: 'Compare with previous assessment' }));
    await page.getByText(/Compared with the previous assessment/).waitFor();
    assert.match(await main(page).innerText(), /Overall\s+28\.6%–42\.9%\s+67\.9%–75\.0%/, 'saved answers survive reload and compare');
    await shot(page, name + '-4-compare.png');

    const reset = page.getByRole('button', { name: 'Reset demo' });
    if (name === 'desktop') { await reset.focus(); await page.keyboard.press('Enter'); } else await reset.tap();
    assert.match(await page.locator('#try-demo-status').innerText(), /Demo reset/);
    assert.equal(await page.locator('h1').innerText(), 'Overview');
    assert.deepEqual(await page.evaluate(key => [localStorage.getItem(key), localStorage.getItem('nofries.unrelated')], STORAGE_KEY), [null, 'kept']);
    await main(page).getByText('28.6%–42.9%').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Compare with previous assessment' }).count(), 0, 'reset removed the visitor assessment');
    assert.deepEqual(await context.cookies(), []);
    assert.deepEqual(unexpected, [], name + ': no network, console, CSP or script errors');
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
        console.log('Try demo browser check passed (1280px, 390px and 320px: 14 questions, review, submit, results, compare, reset). Screenshots: ' + shots);
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
