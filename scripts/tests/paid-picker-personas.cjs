'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startFixture } = require('./paid-picker-fixture.cjs');
const reviewedIso = require('../../test/fixtures/paidIsoSuggestionPublication.json');

async function main() {
    const [root, axePath, directory] = process.argv.slice(2);
    assert.ok(root && axePath && directory, 'Supply the local assembly, axe.min.js and an evidence directory');
    fs.mkdirSync(directory, { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    const results = [];
    try {
        for (const [persona, enabled, entitled, index] of [
            ['it-manager', true, true, 1],
            ['owner', true, true, 1],
            ['consultant', true, true, 0],
            ['flag-off', false, true, 0],
            ['free-only', true, false, 0]
        ]) {
            const fixture = await startFixture(path.resolve(root), persona, enabled, entitled);
            const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(8000);
            const network = [],
                observations = [],
                errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            page.on('response', (r) => {
                const url = new URL(r.url());
                if (url.pathname.startsWith('/api/'))
                    network.push({ method: r.request().method(), route: url.pathname, status: r.status() });
            });
            await page.route('**/*', (route) =>
                new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
            );
            const button = (name) => page.getByRole('button', { name, exact: true });
            const ref = fixture.paidFrameworks[index],
                pathname = '/api/dashboard/frameworks/' + ref.profileId + '/' + ref.version + '/assessments';
            const entry = async () => {
                await page.goto('about:blank');
                await page.goto(fixture.origin + '/dashboard#cyber-security');
            };
            const open = async () => {
                await entry();
                await button('Open ' + ref.label).click();
                await button('Start assessment').waitFor();
            };
            const shot = (name) => path.join(directory, persona + '-' + name + '.png');
            const observe = async (stage) => {
                await page.evaluate(fs.readFileSync(axePath, 'utf8'));
                const metrics = await page.evaluate(async () => ({
                    width: innerWidth,
                    scrollWidth: document.documentElement.scrollWidth,
                    violations: (
                        await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
                    ).violations.map((v) => ({
                        id: v.id,
                        impact: v.impact,
                        targets: v.nodes.map((n) => n.target)
                    }))
                }));
                observations.push({ stage, ...metrics });
                await page.screenshot({ path: shot(stage) });
                assert.equal(metrics.scrollWidth, 375, stage);
                assert.deepEqual(metrics.violations, [], stage);
            };
            const noSuggestions = async () => assert.equal(await page.getByText('Needs confirmation', { exact: true }).count(), 0);
            try {
                await entry();
                if (!enabled || !entitled) {
                    await page
                        .getByRole('heading', { name: enabled ? 'Choose an assessment' : 'Cyber security assessment', exact: true })
                        .waitFor();
                    for (const target of fixture.paidFrameworks) assert.equal(await button('Open ' + target.label).count(), 0);
                    if (enabled) assert.equal(await page.getByText('Locked', { exact: true }).count(), 2);
                    const before = fixture.operations.length;
                    await noSuggestions();
                    await observe('entry');
                    assert.equal(before, 0);
                    for (const target of fixture.paidFrameworks) {
                        const response = await page.request.get(
                            fixture.origin + '/api/dashboard/frameworks/' + target.profileId + '/' + target.version + '/assessments',
                            { headers: { 'X-NoFries-Dashboard-Generation': fixture.generation() } }
                        );
                        assert.equal(response.status(), enabled ? 403 : 404);
                    }
                } else {
                    await button('Open ' + ref.label).waitFor();
                    await observe('picker');
                    await open();
                    await page
                        .getByRole('textbox', { name: 'What part of your organisation will you assess?' })
                        .fill('Synthetic office recovery scope');
                    await button('Start assessment').click();
                    const first = page.getByRole('radio').first();
                    await first.waitFor();
                    await noSuggestions();
                    assert.equal(await page.locator('input[type=radio]:checked').count(), 0);
                    const initial = fixture.accounts[0].revisions[0].record.state;
                    assert.deepEqual(initial.responses, []);
                    if (ref.profileId === reviewedIso.profileId) assert.deepEqual(initial.profileRef, reviewedIso);
                    await observe('form');
                    await first.check();
                    await button('Save progress').click();
                    await page.getByText('Progress saved.', { exact: true }).waitFor();
                    await open();
                    await button('Resume assessment').click();
                    await first.waitFor();
                    const count = index === 1 ? 116 : 106;
                    await page.getByText('1 of ' + count + ' answers saved', { exact: true }).waitFor();
                    await observe('resume');
                    await noSuggestions();
                    for (let i = 1; i < count; i++) {
                        await page.getByRole('radio').nth(1).check();
                        if (i + 1 < count) await button('Next').click();
                    }
                    if (persona === 'it-manager' || persona === 'owner') {
                        await page.getByText('Find a question', { exact: true }).click();
                        const list = page.getByRole('combobox', { name: 'Question in this section' });
                        const code = persona === 'it-manager' ? 'A.8.13-Q1' : 'A.8.30-Q1';
                        const option = await list
                            .locator('option')
                            .filter({ hasText: code + ' · ' })
                            .textContent();
                        await list.selectOption({ label: option });
                        if (persona === 'owner') {
                            await page.getByRole('radio', { name: 'Not applicable with a reason' }).check();
                            await page
                                .getByRole('textbox', { name: 'Why does this not apply to your scope?' })
                                .fill('This synthetic client does not outsource development.');
                        } else {
                            await page.getByRole('radio', { name: 'In place with evidence', exact: true }).check();
                            const question = page.locator('fieldset legend');
                            assert.match(await question.textContent(), /recover/);
                            await question.scrollIntoViewIfNeeded();
                            await page.screenshot({ path: shot('backup-question') });
                        }
                    }
                    await button('Save progress').click();
                    await page.getByText('Progress saved.', { exact: true }).waitFor();
                    page.once('dialog', (d) => d.accept());
                    await button('Submit assessment').click();
                    const board = page.getByRole('heading', { name: 'Board summary', exact: true });
                    await board.waitFor();
                    await open();
                    const detailPath = pathname + '/' + initial.assessmentId;
                    const [readback] = await Promise.all([
                        page.waitForResponse((response) => new URL(response.url()).pathname === detailPath && response.request().method() === 'GET'),
                        button('View results').click()
                    ]);
                    assert.equal(readback.status(), 200);
                    const reopened = (await readback.json()).assessment;
                    assert.equal(reopened.status, 'submitted');
                    if (ref.profileId === reviewedIso.profileId) assert.deepEqual(reopened.profileRef, reviewedIso);
                    await board.waitFor();
                    await observe('results');
                    assert.equal(await page.getByRole('button', { name: /^(Copy|Print) / }).count(), 0);
                    const final = fixture.accounts[0].revisions.at(-1).record.state;
                    assert.equal(final.responses.length, count);
                    if (ref.profileId === reviewedIso.profileId) assert.deepEqual(final.profileRef, reviewedIso);
                    if (persona === 'it-manager')
                        assert.equal(final.responses.find((r) => r.itemId === 'A.8.13-Q1').optionId, 'in_place_with_evidence');
                    if (persona === 'owner') {
                        const item = page
                            .locator('.paid-results article')
                            .filter({ has: page.getByRole('heading', { name: /^A\.8\.30 ·/ }) });
                        assert.match(await item.innerText(), /Reason: This synthetic client does not outsource development/);
                        await item.scrollIntoViewIfNeeded();
                        await page.screenshot({ path: shot('customer-evidence') });
                    }
                    if (persona === 'consultant') {
                        const saved = fixture.accounts[0].revisions.at(-1).record.state;
                        const oldGeneration = fixture.generation();
                        async function change(label) {
                            await page.goto(fixture.origin + '/dashboard#organisations');
                            const target = page.locator('#dashboardChoices button').filter({ hasText: label });
                            await target.click();
                            await page.waitForFunction(() => document.body.dataset.dashboardState === 'ready');
                            await open();
                        }
                        await change('Synthetic organisation B');
                        await page.getByText('No saved assessments yet.', { exact: true }).waitFor();
                        assert.equal(await board.count(), 0);
                        for (const [generation, status] of [
                            [oldGeneration, 403],
                            [fixture.generation(), 404]
                        ]) {
                            const res = await page.request.get(fixture.origin + pathname + '/' + saved.assessmentId, {
                                headers: { 'X-NoFries-Dashboard-Generation': generation }
                            });
                            assert.equal(res.status(), status);
                        }
                        await observe('second-client');
                        await page
                            .getByRole('textbox', { name: 'What part of your organisation will you assess?' })
                            .fill('Synthetic office recovery scope');
                        await button('Start assessment').click();
                        await page.getByRole('radio', { name: 'No', exact: true }).check();
                        await button('Save progress').click();
                        await page.getByText('Progress saved.', { exact: true }).waitFor();
                        const second = fixture.accounts[1].revisions.at(-1).record.state;
                        assert.equal(second.responses.length, 1);
                        assert.equal(second.responses[0].optionId, 'no');
                        await change('Synthetic organisation A');
                        assert.equal(await button('Resume assessment').count(), 0);
                        await button('View results').click();
                        await board.waitFor();
                        assert.equal(
                            fixture.accounts[0].revisions.at(-1).record.state.submission.responseSetSha256,
                            saved.submission.responseSetSha256
                        );
                    }
                }
                assert.deepEqual(
                    network.filter((r) => /export|quota|reservation/i.test(r.route)),
                    []
                );
                assert.deepEqual(fixture.errors, []);
                assert.deepEqual(errors, []);
            } catch (error) {
                console.error(
                    persona,
                    'last requests',
                    network.slice(-10),
                    'fixture errors',
                    fixture.errors,
                    'page',
                    (await page.locator('body').innerText()).slice(0, 800)
                );
                throw error;
            } finally {
                results.push({ persona, observations, network, errors, fixtureErrors: fixture.errors });
                fs.writeFileSync(path.join(directory, 'runs.json'), JSON.stringify(results, null, 2));
                await page.close();
                await fixture.close();
            }
            console.log(
                persona,
                observations.map((o) => [o.stage, o.scrollWidth, o.violations.map((v) => v.id)])
            );
        }
    } finally {
        await browser.close();
    }
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
