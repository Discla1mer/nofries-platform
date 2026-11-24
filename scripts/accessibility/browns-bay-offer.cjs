'use strict';
const assert = require('node:assert/strict');

// Exercise the public visitor's route. Only read local pages; never send an enquiry.
module.exports = async function checkBrownsBayOffer(browser, base) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    try {
        const page = await context.newPage();
        await page.route('**/*', route => new URL(route.request().url()).origin === base &&
            route.request().method() === 'GET' ? route.continue() : route.abort());
        await page.goto(base + '/');
        const link = page.getByRole('link', { name: 'Browns Bay Local Offer' });
        await link.focus(); await page.keyboard.press('Enter');
        await page.waitForURL(base + '/offer');
        await page.getByRole('heading', { level: 1 }).waitFor();
        assert.equal(await page.locator('.ad-price').innerText(), 'NZ$30.04 + GST per computer per month');
        assert.ok(await page.getByText(/NZ\$100 per 30 minutes/).isVisible());
        assert.ok(await page.getByText(/Offer pricing and availability are subject to confirmation/).isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.reload(); await page.keyboard.press('Tab');
        assert.equal(await page.locator(':focus').innerText(), 'Skip to content');
        await page.keyboard.press('Enter');
        assert.equal(await page.locator(':focus').getAttribute('id'), 'main-content');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator(':focus').getAttribute('href'), '/contact.html');
        await page.keyboard.press('Enter');
        await page.waitForURL(base + '/contact.html');
        await page.getByRole('heading', {level: 1}).waitFor();
        console.log('PASS: homepage footer to /offer at 375px; conditional offer pricing, skip link and contact keyboard path.');
    } finally { await context.close(); }
};
