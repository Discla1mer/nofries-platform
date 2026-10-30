'use strict';
// Isolated loopback browser check over the actual homepage and analytics script.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name));
let available = true, events = [], pendingSummary, counterOverride = null;
const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/api/website-analytics/status') { res.setHeader('Content-Type', 'application/json'); res.statusCode = available ? 200 : 503; return res.end(JSON.stringify(available ? counterOverride || { status: 'available' } : { status: 'unavailable' })); }
    if (req.url === '/api/website-analytics/summary') { pendingSummary = res; return; }
    if (req.url === '/admin-test') { res.setHeader('Content-Type', 'text/html'); return res.end('<button id=websiteUsageLoad>Load</button><p id=websiteUsageStatus></p><pre id=websiteUsageResult hidden></pre><script src=/api/shared/protectedAssets/websiteUsage.js></script>'); }
    if (req.url === '/api/shared/protectedAssets/websiteUsage.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(read('api/shared/protectedAssets/websiteUsage.js')); }
    if (req.url === '/api/website-analytics/events' && req.method === 'POST') { let body = ''; req.on('data', data => { body += data; }); return req.on('end', () => { events.push(JSON.parse(body)); res.writeHead(204); res.end(); }); }
    if (req.url === '/' || req.url.startsWith('/login')) { let html = read(req.url === '/' ? 'index.html' : 'login.html').toString().replace(/<script\b[^>]*><\/script>/g, ''); html = html.replace('</head>', '<script src="/js/website-analytics.js" defer></script></head>'); res.setHeader('Content-Type', 'text/html'); return res.end(html); }
    const file = req.url.split('?')[0].slice(1);
    if (['js/website-analytics.js', 'home.css', 'style.css'].includes(file)) { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); return res.end(read(file)); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
        await page.goto(base); await page.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; });
        await page.waitForFunction(() => window.__nofriesWebsiteAnalytics); await page.waitForTimeout(100);
        assert.equal(events.filter(x => x.event === 'view').length, 1);
        assert.equal(await page.locator('.website-counter, #website-view-count').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await page.waitForTimeout(100); assert.equal(events.filter(x => x.event === 'view').length, 2);
        await page.reload(); await page.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; }); await page.waitForTimeout(100);
        assert.equal(events.filter(x => x.event === 'view').length, 3);
        events = []; await page.locator('a[href="/login?intent=create"]').evaluate(link => link.addEventListener('click', event => event.preventDefault()));
        await page.locator('a[href="/login?intent=create"]').click(); await page.waitForTimeout(100); assert.deepEqual(events, [{ event: 'create-click' }]);
        events = []; const login = await browser.newPage(); await login.goto(base + '/login?intent=create&secret=never-send'); await login.waitForTimeout(100);
        assert.deepEqual(events.map(x => x.event).sort(), ['signup-entry', 'view']); assert.ok(events.every(x => !JSON.stringify(x).includes('secret')));
        events = []; available = false; await page.reload(); await page.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; }); await page.waitForTimeout(100);
        assert.equal(events.length, 0);
        available = true;
        for (const invalid of [{ status: 'unavailable' }, { status: 'available', total: 42 }, ['available']]) {
            counterOverride = invalid; events = []; await page.reload(); await page.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; }); await page.waitForTimeout(100);
            assert.equal(events.length, 0);
        }
        counterOverride = null; events = []; const protectedPage = await browser.newPage();
        await protectedPage.goto(base); await protectedPage.evaluate(() => { document.getElementById('gatewayPublic').hidden = true; document.body.dataset.dashboardState = 'ready'; }); await protectedPage.waitForTimeout(100); assert.equal(events.length, 0);
        const privatePage = await browser.newPage(); await privatePage.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })); await privatePage.goto(base); await privatePage.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; }); await privatePage.waitForTimeout(100); assert.equal(events.length, 0);
        const dntPage = await browser.newPage(); await dntPage.addInitScript(() => Object.defineProperty(navigator, 'doNotTrack', { value: '1' })); await dntPage.goto(base); await dntPage.evaluate(() => { document.body.dataset.dashboardState = 'unauthenticated'; }); await dntPage.waitForTimeout(100); assert.equal(events.length, 0);
        const admin = await browser.newPage(); await admin.goto(base + '/admin-test'); await admin.locator('#websiteUsageLoad').click();
        for (let i = 0; i < 50 && !pendingSummary; i++) await admin.waitForTimeout(10);
        assert.ok(pendingSummary); pendingSummary.writeHead(200, { 'Content-Type': 'application/json' });
        pendingSummary.end(JSON.stringify({ start: '2026-01-01', days: { '2026-10-28': { pages: { home: 3, roadmap: 8 }, referrers: { search: 11 }, devices: { mobile: 11 }, createClicks: 2, signupEntries: 1 } } })); pendingSummary = null;
        await admin.getByText('Recorded page views: 11.').waitFor();
        const output = await admin.locator('#websiteUsageResult').innerText();
        assert.ok(output.includes('Reporting window:') && output.includes('Search: 11') && output.includes('Mobile: 11') && output.includes('Create-account clicks: 2') && output.includes('not a conversion rate'));
        assert.ok(output.indexOf('Roadmap: 8') < output.indexOf('Homepage: 3'));
        await admin.locator('#websiteUsageLoad').click(); for (let i = 0; i < 50 && !pendingSummary; i++) await admin.waitForTimeout(10);
        pendingSummary.writeHead(503); pendingSummary.end(); pendingSummary = null; await admin.getByText('Website usage is unavailable.').waitFor();
        assert.equal(await admin.locator('#websiteUsageResult').isHidden(), true); assert.equal(await admin.locator('#websiteUsageResult').innerText(), '');
        await admin.locator('#websiteUsageLoad').click(); for (let i = 0; i < 50 && !pendingSummary; i++) await admin.waitForTimeout(10);
        assert.ok(pendingSummary); await admin.evaluate(() => window.dispatchEvent(new CustomEvent('dashboard-admin-revoked')));
        pendingSummary.writeHead(200, { 'Content-Type': 'application/json' }); pendingSummary.end(JSON.stringify({ home: 42 }));
        await admin.waitForTimeout(100); assert.equal(await admin.locator('#websiteUsageResult').isHidden(), true); assert.equal(await admin.locator('#websiteUsageResult').innerText(), '');
        console.log('Website analytics browser checks passed.');
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
