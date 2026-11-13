'use strict';

// Synthetic protected component only; no real identity, writes or customer data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');
const root = path.resolve(__dirname, '../..'), artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-overview-reviews-'));
const files = ['api/shared/protectedAssets/ncscQuestionnaire.js', 'api/shared/protectedAssets/assessmentExplanation.js',
    'api/shared/protectedAssets/organisationPicture.js', 'app/dashboard.css'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const frozen = hashes(), fixtures = buildFixtures(), record = fixtures.tenants[0].assessments[2];
const action = (id, nextReviewDate) => ({ actionId: id, status: 'completed', dueDate: '2026-10-01', isOverdue: false,
    ownerLabel: 'Synthetic long owner label for operations and technology follow-ups',
    rationale: { suggestedAction: 'Review the saved follow-up for ' + id + ': confirm what is in place with the responsible team.' },
    completion: { at: '2026-10-01T00:00:00.000Z', note: 'Saved workflow completion', nextReviewDate } });
const value = { more: true, lists: [{ asOf: '2026-11-12T23:59:00.000Z', actions: [
    action('one', '2026-11-01'), action('two', '2026-11-12'), action('three', '2026-11-13'), action('four', '2026-11-26')] }] };
const routes = {
    '/': ['text/html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/dashboard.css"></head><body class="nofries-dashboard"><main class="dashboard-main"><div id="picture"></div></main><script src="/view.js"></script></body></html>'],
    '/dashboard.css': ['text/css', fs.readFileSync(path.join(root, files[3]))],
    '/view.js': ['text/javascript', files.slice(0, 3).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')]
};
const blocked = [], errors = [], observations = [];
const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || !routes[request.url]) { blocked.push(request.url); response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'Content-Type': routes[request.url][0], 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" });
    response.end(routes[request.url][1]);
});
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let browser, completed = false;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin || route.request().method() !== 'GET' || !routes[url.pathname]) { blocked.push(url.href); return route.abort(); }
            return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        for (const width of [1440, 390, 320]) for (const enlarged of [false, true]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
            await page.evaluate(({ metadata, record, value }) => {
                window.reviewWrites = 0; window.reviewOpens = 0;
                window.mountReview = list => {
                    if (window.currentPicture) window.currentPicture.destroy();
                    window.currentPicture = NoFriesOrganisationPicture.mount(document.querySelector('#picture'), {
                        metadata, organisationId: record.submission.evaluation.provenance.organisationId,
                        client: { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }), read: async () => ({ assessment: record }),
                            save: () => window.reviewWrites++, submit: () => window.reviewWrites++ },
                        readActions: async () => list, openImprovement: () => window.reviewOpens++
                    });
                };
                window.mountReview(value);
            }, { metadata: fixtures.metadata, record, value });
            await page.locator('.picture-review-note').waitFor();
            if (enlarged) await page.evaluate(() => document.documentElement.style.fontSize = '200%');
            const card = page.locator('.picture-actions'), baseline = await page.locator('.picture-metrics').textContent();
            assert.match(await card.textContent(), /Reviews due \(2\)/);
            assert.match(await card.textContent(), /Reviews in the next 14 days \(2\)/);
            assert.match(await card.textContent(), /12 Nov 2026 \(UTC\)/);
            assert.match(await card.textContent(), /does not confirm a review took place/);
            const link = card.getByRole('link', { name: 'View the full plan', exact: true });
            await link.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
            const focus = await link.evaluate(node => { const box = node.getBoundingClientRect(); return {
                active: node === document.activeElement, ring: parseFloat(getComputedStyle(node).outlineWidth),
                visible: node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }; });
            assert.equal(focus.active, true); assert.ok(focus.ring >= 3); assert.equal(focus.visible, true);
            await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => window.reviewOpens), 1);
            assert.equal(await page.evaluate(() => window.reviewWrites), 0);
            assert.equal(await page.locator('.picture-metrics').textContent(), baseline);
            const geometry = await card.evaluate(node => { const box = node.getBoundingClientRect(); return {
                width: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: box.left, right: box.right }; });
            assert.ok(geometry.scrollWidth <= width + 1); assert.ok(geometry.left >= -1 && geometry.right <= width + 1);
            observations.push({ width, enlarged, ...geometry });
            if (!enlarged) await card.screenshot({ path: path.join(artifacts, 'reviews-' + width + '.png') });
            await page.evaluate(() => window.mountReview({ more: false, lists: [] }));
            await page.getByText('No actions yet.', { exact: false }).waitFor();
            assert.equal(await page.locator('.picture-review-note').count(), 0);
        }
        assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), frozen);
        completed = true; console.log(JSON.stringify({ completed, cases: observations.length, artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ completed, errors, blocked, observations, frozen }, null, 2));
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
