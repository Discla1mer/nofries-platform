'use strict';

// Run from the disposable PostgreSQL fixture with #507, #506, #504 and #503 packaged.
const assert = require('node:assert/strict');
const request = require('supertest');

const { createHash } = require('node:crypto');
const { paidFrameworks, rendererIntegrity, rendererSelection } = require('../../api/shared/protectedAssets/dashboardRegistry');

function assetPath(ref, name, generation) {
    const version = Buffer.from(rendererIntegrity[name].slice(7), 'base64').toString('base64url');
    const selection = createHash('sha256').update(rendererSelection(generation, ref, name)).digest('hex');
    return '/api/dashboard/frameworks/' + ref.profileId + '/' + ref.version + '/assets/' + name + '.js?v=' + version + '&s=' + selection;
}

async function checkPicker({ browser, app, origin, cookie, now, ref, revoke, switchOrganisation, returnToOrganisation, directory }) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
    const page = await context.newPage(), assets = [], failures = [];
    page.setDefaultTimeout(8000);
    assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/);
    const other = paidFrameworks.find(row => row.profileId !== ref.profileId);
    const outboundExports = [];
    try {
        const split = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, secure: true, httpOnly: true }]);
        await page.clock.setFixedTime(new Date(now));
        // Every dashboard request hits the actual loopback HTTPS application.
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        page.on('response', res => {
            const url = new URL(res.url());
            if (url.pathname.startsWith('/api/dashboard/frameworks/') && url.pathname.includes('/assets/')) {
                assets.push({ path: url.pathname + url.search, status: res.status(), cache: res.headers()['cache-control'] });
            }
        });
        page.on('request', req => {
            if (/export|quota|reservation/i.test(new URL(req.url()).pathname)) outboundExports.push(req.method());
        });
        page.on('pageerror', error => failures.push(error.message));
        const button = name => page.getByRole('button', { name, exact: true });
        const open = async () => {
            await page.goto('about:blank');
            await page.goto(origin + '/dashboard#cyber-security');
            await button('Open ' + ref.label).click();
            await page.getByRole('textbox', { name: 'What part of your organisation will you assess?' }).waitFor();
        };
        await open();
        await page.getByRole('textbox', { name: 'What part of your organisation will you assess?' }).fill('Synthetic workshop');
        await button('Start assessment').click();
        await page.getByRole('radio').first().check(); await button('Save progress').click();
        await page.getByText('Progress saved.', { exact: true }).waitFor();
        await open(); await button('Resume assessment').click();
        await button('Save progress').waitFor();
        await page.getByRole('radio').first().scrollIntoViewIfNeeded();
        if (directory) await page.screenshot({ path: directory + '/' + ref.profileId + '-resume.png' });
        assert.equal(assets.length, 2); assert.ok(assets.every(row => row.status === 200 && /no-store/.test(row.cache)));
        for (const row of assets) assert.match(row.path, /\/questionnaire\.js\?v=[\w-]{43}&s=[a-f0-9]{64}$/);
        const admitted = assets[0].path;
        const session = await request(app).get('/api/dashboard/session').set('Cookie', cookie);
        assert.ok(!admitted.includes(session.body.generation));
        const bad = admitted.slice(0, -1) + (admitted.endsWith('0') ? '1' : '0');
        await request(app).get(bad).set('Cookie', cookie).expect(403);
        await request(app).get(admitted).expect(401);
        await request(app).get(assetPath(other, 'questionnaire', session.body.generation)).set('Cookie', cookie).expect(403);
        const verified = await request(app).get(admitted).set('Cookie', cookie).expect(200);
        assert.equal('sha256-' + createHash('sha256').update(verified.text).digest('base64'), rendererIntegrity.questionnaire);

        // Answer every remaining question through the mounted controls, including the section transitions.
        await page.evaluate(() => {
            for (let count = 0; count < 200; count++) {
                const answer = document.querySelectorAll('.ncsc-answer input[type=radio]')[1];
                if (!answer) throw new Error('Question missing');
                answer.click();
                const next = [...document.querySelectorAll('button')].find(node => node.textContent === 'Next');
                if (!next) return;
                next.click();
            }
            throw new Error('Question navigation did not end');
        });
        await button('Save progress').click();
        page.once('dialog', dialog => dialog.accept());
        await button('Submit assessment').click();
        const board = page.getByRole('heading', { name: 'Board summary', exact: true });
        await board.waitFor();
        await open(); await button('View results').click(); await board.waitFor();
        await board.scrollIntoViewIfNeeded();
        if (directory) await page.screenshot({ path: directory + '/' + ref.profileId + '-results.png' });
        assert.equal(assets.filter(row => row.path.includes('/results.js?') && row.status === 200 && /no-store/.test(row.cache)).length, 2);
        assert.equal(await page.getByRole('button', { name: /^(Copy|Print) / }).count(), 0);
        assert.equal(await page.locator('script[src*="/frameworks/"]').count(), 0);

        // Change to a different tenant with the same organisation ID and the same profile grant.
        await switchOrganisation();
        await request(app).get(admitted).set('Cookie', cookie).expect(403);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await board.waitFor({ state: 'detached' });
        await open();
        await page.getByText('No saved assessments yet.', { exact: true }).waitFor();
        await returnToOrganisation();
        await open(); await button('View results').click(); await board.waitFor();
        const currentAsset = assets.at(-1).path;
        await revoke();
        const denied = await request(app).get(currentAsset).set('Cookie', cookie).expect(403);
        assert.match(denied.headers['cache-control'], /no-store/);
        assert.ok(!denied.text.includes('NoFriesPaidResults'));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await board.waitFor({ state: 'detached' });
        assert.deepEqual(outboundExports, []);
        assert.deepEqual(failures, []);
    } finally { await context.close(); }
}
module.exports = { assetPath, checkPicker };
