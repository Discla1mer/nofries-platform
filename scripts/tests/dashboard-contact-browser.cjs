'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { server, model } = require('./overview-mobile-browser.cjs');

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
    try {
        const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
        let enabled = false, outcome = 'requested';
        const writes = [];
        await page.route(origin + '/api/dashboard/session', async route => {
            const response = await route.fetch();
            const json = await response.json();
            if (enabled) json.contactRequestsEnabled = true;
            await route.fulfill({ response, json });
        });
        await page.route(origin + '/api/enquiry', route => route.fulfill({ json: { available: true } }));
        await page.route(origin + '/api/dashboard/contact-requests', route => {
            const request = route.request();
            assert.equal(request.method(), 'POST');
            assert.equal(request.headers()['x-nofries-dashboard-generation'], 'a'.repeat(64));
            const body = request.postDataJSON();
            assert.deepEqual(Object.keys(body).sort(), ['consentVersion', 'operationId', 'topic']);
            assert.equal(body.consentVersion, 'contact-request-v1');
            writes.push(body);
            return route.fulfill({ status: outcome === 'failed' ? 503 : 200, json: { schemaVersion: 1, status: outcome } });
        });
        const ask = page.getByRole('button', { name: 'Ask No Fries to contact me', exact: true });
        const confirmation = page.getByText('Your request has been received. No Fries will contact you by email.', { exact: true });
        const capture = async (label, target) => {
            if (!process.env.NOFRIES_CONTACT_SCREENSHOTS) return;
            await target.evaluate(node => node.scrollIntoView({ block: 'center' }));
            await page.screenshot({ path: path.join(process.env.NOFRIES_CONTACT_SCREENSHOTS, label + '.png') });
        };
        await page.goto(origin + '/dashboard#overview');
        await page.getByText('Fix these with No Fries').waitFor();
        assert.equal(await ask.count(), 0);
        await page.locator('.dashboard-mobile-nav [data-module="services"]').click();
        await page.locator('.dashboard-service-cards').waitFor();
        assert.equal(await page.locator('a[href^="/contact.html?service="]').count(), model.services.length + 1);
        assert.equal(await ask.count(), 0);
        enabled = true;
        await page.goto(origin + '/dashboard#overview');
        await page.reload();
        await ask.waitFor();
        await page.getByText('No Fries staff will see your organisation name, your sign-in email and a summary of your results, and will contact you by email.', { exact: true }).waitFor();
        assert.equal(writes.length, 0);
        await capture('results-consent', ask);
        await ask.click();
        await confirmation.waitFor();
        assert.equal(writes[0].topic, 'results');
        await capture('results-confirmation', confirmation);
        await page.locator('.dashboard-mobile-nav [data-module="services"]').click();
        const offer = page.locator('.dashboard-offer-panel button');
        await capture('managed-security', offer);
        outcome = 'already_requested';
        await offer.click();
        await confirmation.waitFor();
        assert.equal(writes[1].topic, 'results');
        for (const service of model.services) {
            const detail = page.locator('#dashboard-service-' + service.key);
            await page.locator('[aria-controls="dashboard-service-' + service.key + '"]').click();
            outcome = 'failed';
            await detail.getByRole('button').click();
            await detail.getByText('We could not confirm your request. Please try again.').waitFor();
            const failed = writes.at(-1);
            assert.equal(failed.topic, service.key);
            outcome = 'requested';
            await detail.getByRole('button').click();
            await detail.getByText('Your request has been received.', { exact: false }).waitFor();
            assert.deepEqual(writes.at(-1), failed);
        }
        console.log('375px browser passed for results, managed security and ' + model.services.length + ' services.');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
