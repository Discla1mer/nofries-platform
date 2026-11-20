'use strict';

const { join } = require('node:path');
const { paidFrameworks } = require('../../api/shared/protectedAssets/dashboardRegistry');
const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');

module.exports = ({ withLoopbackBrowser, fixture }) => {
    test.each(['consultant', 'company'])('editable locked enquiry, signed-in %s, no send', async accountType => {
        const [nist, iso] = paidFrameworks;
        const first = 'Fictional Harbour Studio', second = 'Fictional Kōwhai Theatre';
        await withLoopbackBrowser(async (server, origin, browser) => {
            const { f, h, cookie, select } = await fixture(nist, origin, 'true', { accountType, prepareExample(example) {
                example.state.tenantAggregate.organisations[0].displayName = example.scope.tenantId.endsWith('-second') ? second : first;
            } });
            server.on('request', h.app);
            const context = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
            try {
                const split = cookie.indexOf('=');
                await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, secure: true, httpOnly: true }]);
                const traffic = [], forbidden = [], logs = [], writes = [];
                await context.route('**/*', route => {
                    const req = route.request(), url = new URL(req.url());
                    traffic.push([req.method(), req.url(), req.postData(), req.headers()]);
                    if (url.origin !== origin || (url.pathname === '/api/enquiry' && req.method() !== 'GET') ||
                        url.pathname === '/api/telemetry') {
                        forbidden.push([req.method(), url.pathname]); return route.abort();
                    }
                    return route.continue();
                });
                await context.exposeFunction('recordStorageWrite', (k, v) => writes.push([k, v]));
                await context.addInitScript(() => {
                    const original = Storage.prototype.setItem;
                    Storage.prototype.setItem = function (key, value) {
                        window.recordStorageWrite(key, value);
                        return original.call(this, key, value);
                    };
                    window.plausible = (...args) => window.recordStorageWrite('analytics event', args);
                });
                const page = await context.newPage();
                page.setDefaultTimeout(7000);
                page.on('console', msg => logs.push(msg.text()));
                await page.clock.setFixedTime(new Date(f.state.now));
                await page.goto(origin + '/dashboard#cyber-security');
                const dialog = page.getByRole('dialog', { name: 'Ask No Fries' });
                const link = ref => page.getByRole('link', { name: 'Ask No Fries about ' + ref.label, exact: true });
                const message = dialog.locator('[name=message]'), organisation = dialog.locator('[name=organisation]');
                async function open(ref, name) {
                    await link(ref).focus(); await page.keyboard.press('Enter');
                    await message.waitFor();
                    expect(await message.inputValue()).toBe('I would like to ask about ' + ref.label + '.');
                    expect(await organisation.inputValue()).toBe(accountType === 'consultant' ? name : '');
                    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth && window.innerWidth === 375)).toBe(true);
                    expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe('/dashboard#cyber-security');
                }
                await open(iso, first);
                expect(await link(nist).count()).toBe(0);
                await message.fill('Synthetic unsent edit'); await organisation.fill('Synthetic unsent organisation');
                await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
                await open(iso, first);
                await page.reload(); await dialog.waitFor({ state: 'detached' });
                expect(await page.locator('textarea[name=message]').count()).toBe(0);
                if (accountType === 'consultant') {
                    await open(iso, first);
                    const other = await f.addResource({ tenantId: f.scope.tenantId + '-second', organisationId: f.scope.organisationId },
                        { profileRefs: [ACCEPTED_PROFILE_REF] });
                    await select(other.publication.binding.bindingId);
                    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
                    await dialog.waitFor({ state: 'detached' });
                    await open(nist, second);
                    if (process.env.NOFRIES_TEST_ENQUIRY_EVIDENCE) {
                        await dialog.screenshot({ path: join(process.env.NOFRIES_TEST_ENQUIRY_EVIDENCE, 'consultant-375.png') });
                    }
                    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
                    await open(iso, second);
                }
                await page.goto(origin + '/contact.html');
                expect(await page.locator('#contact-message').inputValue()).toBe('');
                expect(await page.locator('#contact-organisation').inputValue()).toBe('');
                await page.goBack(); await link(iso).waitFor(); expect(await dialog.count()).toBe(0);
                expect(forbidden).toEqual([]);
                const observed = JSON.stringify([traffic, writes, logs]);
                for (const value of [first, second, iso.label, nist.label, 'Synthetic unsent']) expect(observed.includes(value)).toBe(false);
                expect(writes.some(([key]) => key === 'analytics event')).toBe(false);
                expect(traffic.filter(([,url]) => new URL(url).pathname.startsWith('/api/dashboard/frameworks/'))).toEqual([]);
            } finally { await context.close(); }
        });
    }, 75000);
};
