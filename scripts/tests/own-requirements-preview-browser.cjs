'use strict';
// Local fixture only; intentionally no application entry point or HTTP listener.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const input = '4.1. Ask who can change a supplier’s bank details.\n' +
    '  Record the person who last checked.\n• Review unused accounts each quarter.\nBack up the supplier list.';
const sourceFiles = {
    '/dashboard.css': ['text/css', 'app/dashboard.css'],
    '/parse.js': ['application/javascript', 'api/shared/ownRequirements/parseRequirements.js'],
    '/review.js': ['application/javascript', 'api/shared/ownRequirements/reviewScreen.js']
};
const html = '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Requirements preview</title>' +
    '<link rel="stylesheet" href="/dashboard.css"></head><body class="nofries-dashboard">' +
    '<main class="dashboard-main"><h1>Your requirements</h1><div id="host"></div></main>' +
    '<script src="/parse.js"></script><script src="/review.js"></script><script src="/mount.js"></script></body></html>';
async function main() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    try {
        for (const width of [375, 1280]) {
            const page = await browser.newPage({ viewport: { width, height: 850 } });
            const unexpected = [], errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.route('**/*', route => {
                const req = route.request(), url = new URL(req.url());
                if (url.origin === 'http://preview.test' && req.method() === 'GET' && !url.search) {
                    const fulfill = (contentType, body) => route.fulfill({ status: 200, contentType, body,
                        headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'none'" } });
                    if (url.pathname === '/') return fulfill('text/html', html);
                    if (url.pathname === '/mount.js') return fulfill('application/javascript',
                        'NoFriesRequirementsReview.mountRequirementsReview(document.querySelector("#host"));');
                    const file = sourceFiles[url.pathname];
                    if (file) return fulfill(file[0], fs.readFileSync(path.join(root, file[1])));
                }
                unexpected.push(req.method() + ' ' + url.pathname);
                return route.abort();
            });
            await page.goto('http://preview.test/');
            const field = page.getByRole('textbox', { name: 'Requirements to review' });
            const button = page.getByRole('button', { name: 'Preview requirements' });
            const status = page.getByRole('status'), items = page.getByRole('listitem');
            await field.fill(input);
            await field.press('Tab');
            assert.ok(await button.evaluate(el => el === document.activeElement));
            await button.press('Enter');
            assert.equal(await status.textContent(), '3 requirements to review.');
            assert.deepEqual(await items.allTextContents(), [
                'Source 4.1: Ask who can change a supplier’s bank details. Record the person who last checked.',
                'Review unused accounts each quarter.', 'Back up the supplier list.'
            ]);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
            if (process.argv[2]) {
                fs.mkdirSync(process.argv[2], { recursive: true });
                await page.screenshot({ path: path.join(process.argv[2], 'requirements-' + width + '.png'), fullPage: true });
            }
            await field.fill('<strong>Policy</strong> & proof');
            assert.equal(await items.count(), 0);
            await button.click();
            assert.equal(await items.textContent(), '<strong>Policy</strong> & proof');
            assert.equal(await items.locator('strong').count(), 0);
            await field.fill('1) Good requirement.\n2)');
            await button.click();
            assert.match(await status.textContent(), /item is empty/);
            assert.equal(await items.count(), 0);
            assert.ok(await field.evaluate(el => el === document.activeElement));
            await field.fill('Corrected text.');
            await button.click();
            assert.equal(await status.textContent(), '1 requirement to review.');
            await page.reload();
            assert.equal(await field.inputValue(), '');
            assert.equal(await items.count(), 0);
            assert.deepEqual(errors, []);
            assert.deepEqual(unexpected, []);
            console.log(width + 'px: preview, keyboard, literal text, invalidation, correction and reload passed.');
            await page.close();
        }
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
