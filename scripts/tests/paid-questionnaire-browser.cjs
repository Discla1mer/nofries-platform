'use strict';

// Local synthetic host for the #500 hand-off. Nothing here is served by the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createNistFrameworkProfile } = require('../../api/shared/assessmentEngine/nistFrameworkProfile');

function isoFixture() {
    const ids = ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'A.5', 'A.6', 'A.7', 'A.8'];
    const domains = ids.map((id, order) => ({id, order, title: 'Practice group ' + id}));
    const clauseIds = { C6: ['C6.1.2', 'C6.1.3', 'C6.2', 'C6.3'], C7: ['C7.1', 'C7.2', 'C7.4', 'C7.5'] };
    const counts = [4, 3, 4, 4, 3, 3, 2, 37, 8, 14, 34];
    const controls = domains.flatMap(({id}, i) => Array.from({length: counts[i]}, (_, n) => ({
        domainId: id, order: n + 1, id: clauseIds[id]?.[n] || id + '.' + (n + 1)
    })));
    const responseOptions = ['Not started', 'Partly in place', 'In place', 'In place with evidence', 'Not applicable']
        .map(label => ({id: label.toLowerCase().replaceAll(' ', '_'), label, applicable: label !== 'Not applicable'}));
    return {
        profile: {id: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1', title: 'ISO 27001 readiness self-assessment'},
        framework: {id: 'iso-iec-27001', version: '2022'}, catalogueSha256: '1'.repeat(64), sourceCatalogueSha256: '2'.repeat(64),
        domains, controls, responseOptions, questions: controls.map(control => ({
            id: control.id + '-Q1', order: 1, controlId: control.id,
            prompt: 'Who checked the latest practice record for ' + control.id + '?',
            responseOptionIds: responseOptions.filter(o => o.applicable || control.domainId.startsWith('A.')).map(o => o.id),
            guidance: {evidenceExamples: ['A dated entry from the practice register.']}
        }))
    };
}

async function checkGlossary(page, publication, iso, output) {
    // Walk the actual rendered sequence, including sections without glossary entries.
    const found = await page.evaluate(() => {
        const questions = [];
        for (;;) {
            const field = document.querySelector('fieldset');
            const labels = [...field.querySelectorAll('summary')].map(s => s.textContent).filter(s => s.endsWith(' explained'));
            questions.push({ prompt: field.querySelector('legend').textContent, labels });
            const next = [...document.querySelectorAll('button')].find(b => b.textContent === 'Next');
            if (!next) return questions;
            next.click();
        }
    });
    assert.equal(found.length, publication.questions.length);
    const expected = iso ? {
        'C4.1-Q1': ['Information risk'], 'C4.3-Q1': ['Scope', 'ISMS'], 'C5.3-Q1': ['Risk owner'],
        'C6.1.2-Q1': ['Likelihood'], 'C6.1.3-Q1': ['Annex A', 'Risk treatment', 'Statement of Applicability'],
        'C9.2-Q1': ['Internal audit'], 'C9.3-Q1': ['Management review'], 'C10.2-Q1': ['Corrective action']
    } : {};
    const questions = new Map(publication.questions.map(q => [q.prompt, q.id]));
    assert.equal(questions.size, found.length);
    for (const row of found) {
        assert.ok(questions.has(row.prompt));
        assert.deepEqual(row.labels, (expected[questions.get(row.prompt)] || []).map(term => term + ' explained'));
    }
    if (!iso) return;
    await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption({ index: 2 });
    await page.getByRole('button', { name: 'Next', exact: true }).press('Enter');
    const help = page.locator('summary').filter({ hasText: /^Risk treatment explained$/ });
    // Keep the existing tab order through the answers. Native summary owns expand/collapse.
    await page.getByRole('radio').first().focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Annex A explained');
    await page.keyboard.press('Tab');
    assert.ok(await help.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Space');
    const meaning = page.getByText(/^What you decide to do about a risk/);
    await meaning.waitFor({ state: 'visible' });
    const ax = await page.context().newCDPSession(page);
    const { nodes } = await ax.send('Accessibility.getFullAXTree');
    const disclosure = nodes.find(n => n.name?.value === 'Risk treatment explained' && !n.ignored);
    assert.ok(disclosure?.properties.some(p => p.name === 'expanded' && p.value.value === true));
    await ax.detach();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('legend').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(output, 'iso-glossary-375.png') });
    await page.keyboard.press('Escape');
    await meaning.waitFor({ state: 'hidden' });
    assert.ok(await help.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Enter');
    await meaning.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Next', exact: true }).press('Enter');
    assert.ok(await page.locator('legend').evaluate(el => el === document.activeElement));
    assert.equal(await help.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save progress' }).isEnabled(), false);
}

async function exercise(browser, iso, output) {
    const isoPath = process.env.NOFRIES_TEST_ISO_PUBLICATION;
    const p = !iso ? createNistFrameworkProfile() : isoPath ? JSON.parse(fs.readFileSync(isoPath, 'utf8')) : isoFixture();
    const id = 'synthetic-assessment', base = '/api/dashboard/frameworks/' + p.profile.id + '/' + p.profile.version + '/assessments/' + id;
    const ref = {frameworkId: p.framework.id, frameworkVersion: p.framework.version, profileId: p.profile.id,
        profileVersion: p.profile.version, catalogueSha256: p.catalogueSha256, sourceCatalogueSha256: p.sourceCatalogueSha256};
    const state = {assessmentId: id, moduleId: 'cyber_security', profileRef: ref, revision: 0, status: 'created', responses: [], submission: null};
    const envelope = () => ({schemaVersion: 1, assessment: state});
    let failure, loseReply = false;
    const keys = new Map(), commands = [], errors = [];
    const context = await browser.newContext({viewport: {width: 375, height: 812}});
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on('pageerror', e => errors.push(e.message));
    const assetDir = 'api/shared/protectedAssets/';
    const scripts = ['paidQuestionnaire.js'];
    if (iso) scripts.push('isoQuestionnaireGlossary.js');
    const renderer = Buffer.concat(scripts.map(file => fs.readFileSync(assetDir + file)));
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        assert.equal(url.origin, 'https://fixture.test');
        const reply = data => route.fulfill({json: data});
        if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body:
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style"><body class="nofries-dashboard"><main class="dashboard-main"></main><script src="/module"></script>'});
        if (url.pathname === '/style') return route.fulfill({path: 'app/dashboard.css', contentType: 'text/css'});
        if (url.pathname === '/module') return route.fulfill({body: renderer, contentType: 'application/javascript'});
        if (url.pathname === base && req.method() === 'GET') return reply(envelope());
        assert.equal(req.method(), 'POST');
        assert.ok([base + '/save', base + '/submit'].includes(url.pathname));
        const body = req.postDataJSON();
        commands.push(body);
        if (failure) return route.fulfill({status: failure, json: {}});
        if (keys.has(body.idempotencyKey)) {
            assert.deepEqual(body, keys.get(body.idempotencyKey));
            return reply(envelope());
        }
        assert.ok(Buffer.byteLength(req.postData()) < 65536);
        assert.equal(body.expectedRevision, state.revision);
        keys.set(body.idempotencyKey, body);
        state.revision++;
        if (url.pathname.endsWith('/save')) {
            assert.ok(body.payload.responses.length);
            const saved = new Map(state.responses.map(row => [row.itemId, row]));
            body.payload.responses.forEach(row => saved.set(row.itemId, row));
            state.responses = [...saved.values()];
            state.status = 'in-progress';
        } else {
            assert.deepEqual(body.payload, {});
            assert.equal(state.responses.length, p.questions.length);
            state.status = 'submitted';
            state.submission = {revision: state.revision, responseSetSha256: '3'.repeat(64), submittedAt: '2026-11-19T00:00:00.000Z'};
        }
        if (loseReply) { loseReply = false; return route.abort(); }
        return reply(envelope());
    });
    async function open() {
        await page.goto('https://fixture.test/');
        await page.evaluate(async ({p, base}) => {
            const root = document.querySelector('main');
            window.active = true;
            window.controller = NoFriesPaidQuestionnaire.mount(root, {
                record: await (await fetch(base)).json(), publication: p, isCurrent: () => window.active,
                mutate: async (url, body) => {
                    const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
                    if (!res.ok) throw Object.assign(new Error(), {status: res.status});
                    return res.json();
                }, showResults: result => { window.selectedResult = result; root.textContent = 'Saved results'; }
            });
        }, {p, base});
    }
    const role = (name, label) => page.getByRole(name, {name: label, exact: true});
    const next = role('button', 'Next'), save = role('button', 'Save progress'), submit = role('button', 'Submit assessment');
    const section = page.getByRole('combobox', {name: 'Section'});
    const na = role('radio', p.responseOptions.find(o => !o.applicable).label), reason = page.getByRole('textbox');
    const filter = role('checkbox', 'Show unanswered questions only');
    await open();
    await checkGlossary(page, p, iso, output);
    assert.equal(commands.length, 0);
    await open();
    assert.equal(await section.locator('option').count(), iso ? 11 : 6);
    assert.equal(await na.count(), iso ? 0 : 1);
    assert.equal(await submit.isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await section.focus();
    await page.keyboard.press('Tab');
    assert.ok(await filter.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Find a question');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('input[type=radio]:checked').count(), 1);
    assert.match(await section.locator('option:checked').textContent(), /1 of/);
    await page.screenshot({path: path.join(output, (iso ? 'iso' : 'nist') + '-375.png'), fullPage: true});
    await next.click();
    assert.ok(await page.locator('legend').evaluate(el => el === document.activeElement));
    if (iso) await section.selectOption({index: 7});
    await na.check();
    assert.ok(await reason.isVisible());
    await reason.fill('   ');
    await save.click();
    assert.equal(commands.length, 0);
    assert.ok(await reason.evaluate(el => el === document.activeElement && !el.validity.valid));
    await reason.fill('This practice covers no systems in our declared scope.');
    loseReply = true;
    await save.click();
    await role('button', 'Try again').click();
    await page.getByText('Progress saved.', {exact: true}).waitFor();
    assert.deepEqual(commands[0], commands[1]);
    assert.equal(state.revision, 1);
    assert.equal(state.responses.length, 2);
    const first = state.responses[0], excluded = state.responses[1];
    assert.equal(excluded.rationale.text, 'This practice covers no systems in our declared scope.');
    await open(); // fresh document, new mount, GET reads only the host's retained record
    assert.equal(await page.locator('input[type=radio]:checked').count(), 0);
    assert.equal(await page.locator('legend').textContent(), p.questions[iso ? 1 : 2].prompt);
    if (iso) await section.selectOption({index: 7});
    await page.getByText('Find a question', {exact: true}).click();
    await page.getByLabel('Question in this section').selectOption({index: iso ? 0 : 1});
    assert.equal(await reason.inputValue(), excluded.rationale.text);
    await page.getByRole('radio').first().check();
    assert.equal(await reason.isVisible(), false);
    page.once('dialog', dialog => dialog.dismiss());
    assert.equal(await page.evaluate(() => window.controller.requestLeave(() => {})), false);
    await open();
    await filter.check();
    assert.match(await section.locator('option').first().textContent(), iso ? /1 of/ : /2 of/);
    const expected = p.questions.filter(q => ![first.itemId, excluded.itemId].includes(q.id));
    assert.equal(await page.locator('legend').textContent(), expected[0].prompt);
    await next.click();
    assert.equal(await page.locator('legend').textContent(), expected[1].prompt);
    // Populate the remaining rows in the synthetic host, then reopen the exact record.
    const retained = state.responses.slice();
    state.responses.push(...expected.map(q => ({itemId: q.id, optionId: q.responseOptionIds[0], rationale: null})));
    await open();
    await filter.check();
    await page.getByText('No unanswered questions in this section.').waitFor();
    page.once('dialog', d => d.accept());
    await submit.click();
    await page.getByText('Saved results').waitFor();
    assert.deepEqual(await page.evaluate(() => window.selectedResult.assessment.submission), state.submission);
    await open();
    assert.equal(await page.getByRole('radio').count(), 0);
    state.responses = retained;
    state.status = 'in-progress';
    state.submission = null;
    for (failure of [409, 403]) {
        await open();
        await page.getByRole('radio').first().check();
        await save.click();
        await page.getByText(failure === 409 ? /Reopen it/ : /assessment is unavailable/).waitFor();
        assert.equal(await page.getByRole('radio').count(), 0);
    }
    failure = null;
    await open();
    if (!iso) {
        const before = state.revision;
        for (let i = 0; i < 7; i++) {
            await na.check();
            await reason.fill('組'.repeat(4000));
            await next.click();
        }
        await save.click();
        await page.getByText('Progress saved.', {exact: true}).waitFor();
        assert.equal(state.revision, before + 2);
        assert.equal(state.responses.filter(row => row.rationale?.text.length === 4000).length, 7);
    }
    await page.evaluate(() => { window.active = false; window.controller.destroy(); });
    assert.equal(await page.locator('main').textContent(), '');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(p.profile.id, p.questions.length, 'questions passed');
}

(async () => {
    const output = process.env.NOFRIES_QUESTIONNAIRE_ARTIFACTS || '/tmp/iso-4-evidence';
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox']});
    try {
        await exercise(browser, false, output);
        await exercise(browser, true, output);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
