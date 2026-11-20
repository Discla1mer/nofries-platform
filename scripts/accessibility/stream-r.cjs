'use strict';
const fs = require('node:fs');
const { chromium } = require('playwright');
const [base, output, ...routes] = process.argv.slice(2);
const origin = new URL(base).origin;
async function audit() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const results = [];
    try {
        for (const width of [375, 1280]) for (const route of routes) {
            const page = await browser.newPage({ viewport: { width, height: 900 }, ignoreHTTPSErrors: process.env.AUDIT_PROXY_TLS === '1', serviceWorkers: 'block', reducedMotion: 'reduce' });
            const row = { route, width };
            try {
                await page.route('**/*', request => {
                    const allowed = new URL(request.request().url()).origin === origin && request.request().method() === 'GET';
                    return allowed ? request.continue() : request.abort();
                });
                const response = await page.goto(origin + route, { timeout: 20000 });
                if (!response.ok()) throw Error('HTTP ' + response.status());
                await page.locator('h1').first().waitFor({ timeout: 5000 });
                if (route === '/try#results') {
                    await page.getByRole('button', { name: 'View saved assessment' }).click();
                    await page.getByRole('heading', { name: 'Assessment results', exact: true }).waitFor();
                }
                await page.evaluate(() => document.fonts.ready);
                await page.evaluate(fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
                const report = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }));
                row.title = await page.title();
                row.version = report.testEngine.version;
                row.violations = report.violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) }));
                row.incomplete = report.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length }));
                if (width === 375 && ['/pricing.html','/try','/board.html'].includes(route)) await page.screenshot({ path: output.replace(/\.json$/, '-') + route.slice(1).replace('.html','') + '.png' });
            } catch (error) { row.blocked = error.message; }
            if (row.blocked || row.violations?.length) process.exitCode = 1;
            results.push(row);
            fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
            await page.close();
        }
    } finally { await browser.close(); }
}
audit().catch(error => { console.error(error); process.exitCode = 1; });
