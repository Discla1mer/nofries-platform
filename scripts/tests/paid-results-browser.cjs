// Run with Playwright and Chromium available. Only synthetic records are mounted.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { fixture, reason } = require('../../test/fixtures/paidResults');
const root = path.resolve(__dirname, '../..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'paid-results-'));

async function run() {
    fs.mkdirSync(out, { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    try {
        for (const iso of [false, true]) {
            const id = iso ? 'iso' : 'nist';
            const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
            await page.setContent('<!doctype html><body class="nofries-dashboard"><main class="dashboard-main"><section id="result" class="dashboard-panel"></section></main>');
            await page.addStyleTag({ path: path.join(root, 'app/dashboard.css') });
            await page.addScriptTag({ path: path.join(root, 'api/shared/protectedAssets/paidResults.js') });
            await page.evaluate(data => {
                window.print = () => { window.printSnapshot = document.documentElement.outerHTML; };
                Object.defineProperty(navigator, 'clipboard', { value: { writeText: text => { window.copied = text; } } });
                NoFriesPaidResults.mount(document.querySelector('#result'), { ...data, isCurrent: () => true,
                    authoriseExport: async () => true });
            }, fixture(iso));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
            await page.screenshot({ path: path.join(out, id + '-375.png') });
            assert.equal(await page.locator('.paid-results em').count(), 0);
            await page.emulateMedia({ media: 'print' });
            assert.equal(await page.locator('.paid-results').isVisible(), false);
            await page.emulateMedia({ media: 'screen' });
            for (const name of iso ? ['board summary', 'statement of applicability'] : ['board summary']) {
                const board = name === 'board summary';
                const copy = page.getByRole('button', { name: 'Copy ' + name });
                if (!board) {
                    await page.getByRole('heading', { name: 'Statement of Applicability' }).evaluate(el => el.scrollIntoView());
                    await page.screenshot({ path: path.join(out, 'iso-statement-375.png') });
                }
                await copy.click();
                const content = await page.evaluate(() => window.copied);
                assert.ok(content.includes(board ? 'Top gaps' : reason));
                await page.getByRole('button', { name: 'Print ' + name }).click();
                // Capture the exact DOM present at window.print(), before synchronous cleanup.
                const sheet = await browser.newPage();
                await sheet.setContent(await page.evaluate(() => window.printSnapshot));
                const file = path.join(out, id + (board ? '-board' : '-statement') + '.pdf');
                await sheet.pdf({ path: file, format: 'A4', margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' } });
                const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))[1]);
                const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
                if (board) { assert.equal(pages, 1); assert.match(text, /Top gaps/); assert.ok(!text.includes(reason)); }
                else { assert.ok(pages > 1); assert.ok(text.includes('A.8.34') && text.includes('<em>external devices</em>')); }
                assert.ok(!text.includes('Copy board summary'));
                console.log(id, name, pages, 'A4 page(s); 375px fits; copy matches');
                await sheet.close();
            }
            await page.close();
        }
    } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
