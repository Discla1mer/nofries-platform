'use strict';

const assert = require('node:assert/strict');

// Pass a fresh, signed-in Chromium page for the disposable #509 host. The
// caller owns the session and storage. This driver uses only browser controls.
async function checkPickerKeyboard(page, origin, ref) {
    assert.match(origin, /^https?:\/\/127\.0\.0\.1:\d+$/);
    const iso = ref.profileId === 'nf-iso-27001-2022-readiness';
    const collection = origin + '/api/dashboard/frameworks/' + ref.profileId + '/' + ref.version + '/assessments';
    const assets = [], writes = [], errors = [];
    page.on('response', res => {
        const url = new URL(res.url());
        if (url.pathname.includes('/frameworks/') && url.pathname.includes('/assets/')) {
            assets.push({path: url.pathname, cache: res.headers()['cache-control'], status: res.status()});
        }
        if (res.request().method() === 'POST' && res.url().startsWith(collection)) writes.push(res.status());
    });
    page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', {name, exact: true});
    async function tabTo(target) {
        await target.waitFor({state: 'visible'});
        for (let tabs = 0; tabs < 100; tabs++) {
            if (await target.evaluate(el => el === document.activeElement)) return;
            await page.keyboard.press('Tab');
        }
        throw new Error('Tab did not reach ' + target);
    }
    async function activate(target) { await tabTo(target); await page.keyboard.press('Enter'); }
    async function openPicker() {
        await page.goto('about:blank');
        await page.goto(origin + '/dashboard#cyber-security');
        await activate(button('Open ' + ref.label));
    }
    await page.setViewportSize({width: 375, height: 812});
    await openPicker();
    await tabTo(page.getByRole('textbox', {name: 'What part of your organisation will you assess?'}));
    await page.keyboard.type('Synthetic workshop');
    const created = page.waitForResponse(r => r.url() === collection && r.request().method() === 'POST');
    await activate(button('Start assessment'));
    const {assessmentId} = (await (await created).json()).assessment;
    const firstRadio = page.getByRole('radio').first(), na = page.getByRole('radio', {name: /^Not applicable/});
    const section = page.getByRole('combobox', {name: 'Section', exact: true});
    const heading = page.locator('.ncsc-answer legend'), save = button('Save progress');
    await heading.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await section.locator('option').count(), iso ? 11 : 6);
    assert.equal(await na.count(), iso ? 0 : 1);
    await tabTo(firstRadio); await page.keyboard.press('Space');
    if (iso) { await tabTo(section); await page.keyboard.press('End'); }
    else await activate(button('Next'));
    await tabTo(firstRadio); await page.keyboard.press('ArrowLeft');
    assert.equal(await na.isChecked(), true);
    await activate(save);
    const reason = page.getByRole('textbox', {name: 'Why does this not apply to your scope?'});
    assert.equal(await reason.evaluate(el => el === document.activeElement && !el.validity.valid), true);
    assert.deepEqual(writes, [200]);
    const text = 'No systems in the declared workshop scope use this practice.';
    await page.keyboard.type(text);
    const excludedPrompt = await heading.textContent();
    const savedReply = page.waitForResponse(r => r.url() === collection + '/' + assessmentId + '/save');
    await activate(save);
    const saved = (await (await savedReply).json()).assessment;
    await page.getByText('Progress saved.', {exact: true}).waitFor();
    assert.equal(saved.revision, 1);
    assert.equal(saved.responses.length, 2);
    assert.equal(saved.responses.find(row => row.rationale)?.rationale.text, text);
    await openPicker();
    const card = page.getByRole('listitem').filter({hasText: assessmentId});
    const detail = page.waitForResponse(r => r.url() === collection + '/' + assessmentId && r.request().method() === 'GET');
    await activate(card.getByRole('button', {name: 'Resume assessment'}));
    assert.deepEqual((await (await detail).json()).assessment.responses, saved.responses);
    await heading.waitFor();
    assert.match(await page.locator('.dashboard-eyebrow').filter({hasText: 'Question'}).innerText(),
        iso ? /Question 2 of/ : /Question 3 of/);
    if (iso) { await tabTo(section); await page.keyboard.press('End'); }
    await activate(page.getByText('Find a question', {exact: true}));
    await tabTo(page.getByRole('combobox', {name: 'Question in this section'}));
    await page.keyboard.press('Home');
    if (!iso) await activate(button('Next'));
    assert.equal(await heading.textContent(), excludedPrompt);
    assert.equal(await na.isChecked(), true);
    assert.equal(await reason.inputValue(), text);
    await tabTo(reason);
    assert.equal(await reason.evaluate(el => {
        const box = el.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.top < innerHeight;
    }), true);
    const base = new URL(collection).pathname.replace(/\/assessments$/, '/assets/');
    const questionnaires = assets.filter(asset => asset.path === base + 'questionnaire.js');
    const collections = assets.filter(asset => asset.path === base + 'collection.js');
    assert.equal(questionnaires.length, 2);
    if (collections.length) assert.equal(collections.length, 2);
    assert.equal(assets.length, questionnaires.length + collections.length);
    for (const asset of assets) {
        assert.equal(asset.status, 200);
        assert.match(asset.cache, /no-store/);
    }
    assert.deepEqual(writes, [200, 200]);
    assert.deepEqual(errors, []);
}
module.exports = {checkPickerKeyboard};
