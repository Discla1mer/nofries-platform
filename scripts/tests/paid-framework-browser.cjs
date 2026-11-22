'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Mount the two protected renderers from the candidate build. All assessment
// operations go through a signed-in disposable fixtureTransport. Asset admission
// and a real export decision are separate host checks.
async function checkPaidBrowser({ browser, call, publication, assetRoot, axePath, outputDirectory }) {
    const profile = publication.profile;
    const collection = '/api/dashboard/frameworks/' + profile.id + '/' + profile.version + '/assessments';
    const assessmentId = 'synthetic-' + randomUUID(), detail = collection + '/' + assessmentId;
    const start = await call('post', collection, { assessmentId, idempotencyKey: randomUUID(), expectedRevision: null,
        payload: { scopePopulation: { description: 'Synthetic office recovery scope.' } } });
    assert.equal(start.status, 200);
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errors = [], observations = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const file = name => path.join(outputDirectory, profile.id + '-' + name);

    async function mount(simulateExport) {
        const retained = await call('get', detail);
        assert.equal(retained.status, 200);
        await page.goto('https://fixture.test/');
        await page.addStyleTag({ path: path.join(assetRoot, 'app/dashboard.css') });
        for (const asset of ['paidQuestionnaire.js', 'paidResults.js']) {
            await page.addScriptTag({ path: path.join(assetRoot, 'api/shared/protectedAssets', asset) });
        }
        await page.addScriptTag({ path: axePath });
        await page.evaluate(({ publication, record, simulateExport }) => {
            const container = document.querySelector('.dashboard-panel');
            window.print = () => { window.printSnapshot = document.documentElement.outerHTML; };
            NoFriesPaidQuestionnaire.mount(container, { publication, record, isCurrent: () => true,
                mutate: window.mutateFixture, showResults: submitted => NoFriesPaidResults.mount(container, {
                    publication, record: submitted, isCurrent: () => true, authoriseExport: simulateExport ? async () => true : undefined
                }) });
        }, { publication, record: retained.body, simulateExport });
        return retained.body.assessment;
    }

    async function observe(stage) {
        const result = await page.evaluate(async () => ({
            width: innerWidth, contentWidth: document.documentElement.scrollWidth,
            violations: (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
                .violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))
        }));
        observations.push({ stage, ...result });
        await page.screenshot({ path: file(stage + '-375.png') });
        assert.equal(result.contentWidth, 375, stage);
        assert.deepEqual(result.violations, [], stage);
    }

    try {
        await page.route('**/*', route => route.request().url() === 'https://fixture.test/' ? route.fulfill({
            contentType: 'text/html', body: '<!doctype html><html lang="en-NZ"><title>Local assessment</title>' +
                '<meta name="viewport" content="width=device-width"><body class="nofries-dashboard">' +
                '<main class="dashboard-main"><section class="dashboard-panel"></section></main></body></html>'
        }) : route.abort());
        await page.exposeFunction('mutateFixture', async (url, body) => {
            assert.ok([detail + '/save', detail + '/submit'].includes(url));
            const result = await call('post', url, body);
            assert.equal(result.status, 200);
            requests.push({ action: url.split('/').pop(), revision: result.body.assessment.revision,
                answers: result.body.assessment.responses.length });
            return result.body;
        });
        assert.deepEqual((await mount(false)).responses, []);
        await observe('form');
        const save = page.getByRole('button', { name: 'Save progress', exact: true });
        await page.getByRole('radio').first().check();
        await save.click();
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        assert.equal((await mount(false)).responses.length, 1);
        await observe('resumed');
        for (let i = 1; i < publication.questions.length; i++) {
            await page.getByRole('radio').nth(1).check();
            if (i + 1 < publication.questions.length) await page.getByRole('button', { name: 'Next', exact: true }).click();
        }
        await save.click();
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Submit assessment' }).click();
        await page.getByRole('heading', { name: 'Board summary' }).waitFor();
        await observe('results');
        const print = page.getByRole('button', { name: 'Print board summary', exact: true });
        assert.ok(!(await print.count()) || !(await print.isEnabled()));
        const submitted = await mount(true);
        assert.equal(submitted.status, 'submitted');
        assert.equal(submitted.responses.length, publication.questions.length);
        await print.click();
        await page.waitForFunction(() => Boolean(window.printSnapshot));
        const paper = await browser.newPage();
        try {
            await paper.setContent(await page.evaluate(() => window.printSnapshot));
            assert.ok((await paper.locator('.paid-results-paper').innerText()).includes(assessmentId));
            await paper.pdf({ path: file('board.pdf'), format: 'A4', margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
        } finally { await paper.close(); }
        assert.deepEqual(errors, []);
    } finally {
        fs.writeFileSync(file('observations.json'), JSON.stringify({ requests, observations, errors }, null, 2));
        await page.close();
    }
}

module.exports = { checkPaidBrowser };
