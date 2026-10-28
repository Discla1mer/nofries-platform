'use strict';
// Optional real-browser regression over actual build-static output. Run build first:
// node scripts/tests/public-footer-assistant-clearance-browser.cjs
// NOFRIES_FOOTER_SOURCE_ROOT selects an already-built causal control.
// NOFRIES_FOOTER_ARTIFACTS selects an external evidence directory.
// Only loopback GETs; no forms, accounts, Terms acceptance or chat submissions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const checkout = path.resolve(__dirname, '../..');
const root = path.resolve(process.env.NOFRIES_FOOTER_SOURCE_ROOT || checkout);
const dist = path.join(root, 'dist');
const artifacts = path.resolve(process.env.NOFRIES_FOOTER_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nf-public-footer-')));
for (const directory of [root, checkout]) {
    const relative = path.relative(directory, artifacts);
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Keep artifacts outside source');
}
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sourcePaths = ['shared-assistant.css', 'home.css', 'style.css', 'managed-it.css', 'index.html', 'managed-it.html',
    'roadmap.html', 'lib/signupDocument.js', 'lib/sharedAssistantDocument.js', 'js/shared-assistant.js', 'js/prospect-assistant.js'];
const builtPaths = ['index.html', 'app/signup.html', 'managed-it.html', 'roadmap.html', 'home.css', 'shared-assistant.css',
    'staticwebapp.config.json'];
const hash = value => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries([...sourcePaths.map(file => [file, path.join(root, file)]),
    ...builtPaths.map(file => ['dist/' + file, path.join(dist, file)])].map(([file, absolute]) => [file, hash(fs.readFileSync(absolute))]));
const before = hashes();
assert.equal(before['shared-assistant.css'], before['dist/shared-assistant.css'], 'Rebuild before running');
const config = JSON.parse(fs.readFileSync(path.join(dist, 'staticwebapp.config.json')));
const requests = [], blocked = [], unexpected = [], errors = [], results = [];
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: req.url });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { unexpected.push(req.method + ' ' + req.url); res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        // Deliberately unavailable analytics: collection must not follow this response.
        if (url.pathname === '/api/website-analytics/counter') { res.statusCode = 503; return res.end('{"status":"unavailable"}'); }
        // Deliberately unavailable signup; unauthenticated gateway; public mock session only.
        if (url.pathname === '/api/prospect/session') {
            return res.end(JSON.stringify({ assistant: { publicHelpOnly: true, publicHelpProtocol: 'public-help-v1', runtime: { mode: 'mock' } } }));
        }
        if (['/api/customer-signup/state', '/api/external-customer-signup/state'].includes(url.pathname)) {
            res.statusCode = 410; return res.end('{}');
        }
        if (['/api/auth/me', '/api/dashboard/access', '/api/dashboard/session', '/api/customer-auth/session', '/api/external-customer-auth/session'].includes(url.pathname)) {
            res.statusCode = 401; return res.end('{}');
        }
        unexpected.push(req.method + ' ' + req.url); res.statusCode = 404; return res.end('{}');
    }
    const route = config.routes.find(entry => entry.route === url.pathname);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname === '/signup' ? 'app/signup.html' : url.pathname.slice(1);
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        unexpected.push(req.method + ' ' + req.url); res.statusCode = 404; return res.end();
    }
    res.setHeader('Content-Security-Policy', route?.headers?.['Content-Security-Policy'] || config.globalHeaders['Content-Security-Policy']);
    res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' })[path.extname(file)] || 'text/html');
    res.end(fs.readFileSync(file));
});
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function stress(page, mode) {
    if (mode.includes('wrap')) await page.locator('.home-footer nav a').first().evaluate(node => { node.textContent = 'Public privacy and information handling'; });
    if (mode.includes('double')) await page.evaluate(() => {
        const sizes = [...document.querySelectorAll('body, body *')].map(node => [node, getComputedStyle(node).fontSize]);
        sizes.forEach(([node, size]) => { node.style.fontSize = parseFloat(size) * 2 + 'px'; });
    });
    if (mode.includes('spacing')) await page.evaluate(() => {
        for (const node of document.querySelectorAll('body, body *')) {
            node.style.lineHeight = '1.5'; node.style.letterSpacing = '.12em'; node.style.wordSpacing = '.16em';
            if (node.tagName === 'P') node.style.marginBottom = '2em';
        }
    });
    await frames(page);
}
async function metrics(page) {
    return page.evaluate(() => {
        const rect = node => node.getBoundingClientRect().toJSON();
        const launcher = document.querySelector('.nf-assistant-launcher');
        const footer = document.querySelector('body > .home-footer');
        const links = [...footer.querySelectorAll('a')].map(node => {
            const r = node.getBoundingClientRect();
            const hit = (x, y) => node.contains(document.elementFromPoint(x, y));
            const inViewport = r.left >= 0 && r.right <= innerWidth + .5 && r.top >= 0 && r.bottom <= innerHeight + .5;
            return { href: node.getAttribute('href'), rect: rect(node), inViewport,
                hits: [.1, .5, .9].flatMap(x => [.1, .5, .9].map(y => hit(r.x + r.width * x, r.y + r.height * y))) };
        });
        return { footer: rect(footer), footerScrollWidth: footer.scrollWidth, footerClientWidth: footer.clientWidth,
            documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
            launcher: rect(launcher), launcherStyle: { color: getComputedStyle(launcher).color,
                background: getComputedStyle(launcher).backgroundColor, right: getComputedStyle(launcher).right }, links };
    });
}
const cases = [
    { name: 'desktop-evidence', width: 1188, height: 761 },
    { name: 'desktop-normal', width: 1440, height: 1000 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'phone-390', width: 390, height: 844 },
    { name: 'reflow-320', width: 320, height: 900 },
    { name: 'short', width: 568, height: 320 },
    { name: 'double-320', width: 320, height: 700, stress: 'double' },
    { name: 'double-short', width: 568, height: 320, stress: 'double' },
    { name: 'wrap-spacing-320', width: 320, height: 900, stress: 'wrap-spacing' },
    { name: 'double-wrap-spacing', width: 390, height: 844, stress: 'double-wrap-spacing' },
    { name: 'safe-area', width: 390, height: 844, safe: true }
];
async function run() {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
        for (const route of ['/signup', '/managed-it.html#enquire', '/', '/roadmap.html']) for (const scenario of cases) {
            const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, reducedMotion: 'reduce' });
            const page = await context.newPage(); page.setDefaultTimeout(1500);
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (/Content Security Policy|violates.*directive/i.test(message.text())) errors.push(message.text()); });
            await page.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : (blocked.push(request.request().url()), request.abort()));
            if (scenario.safe) {
                const session = await context.newCDPSession(page);
                await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 34, right: 24 } });
            }
            await page.goto(base + route);
            await page.locator('.home-footer').waitFor(); await frames(page);
            // Wait for actual unavailable/anonymous shell rendering without entering data.
            if (route === '/signup') await page.getByRole('heading', { name: /Signup is unavailable|Sign in to get started|Sign in to continue/ }).first().waitFor();
            await stress(page, scenario.stress || '');
            const launcher = page.locator('[data-assistant-launcher]');
            const footerLinks = page.locator('body > .home-footer a');
            const terms = page.locator('body > .home-footer a[href="/terms.html"]');
            const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
            // Launcher's normal position/action before scrolling to the footer.
            await page.evaluate(() => scrollTo(0, 0)); await frames(page);
            check(await launcher.isVisible(), 'launcher visible before footer');
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
            const closed = await metrics(page);
            for (const link of closed.links) {
                check(link.rect.width >= 43.5 && link.rect.height >= 43.5, '44px footer target: ' + link.href);
                // A footer taller than the viewport is inspected link by link below.
                if (link.inViewport) check(link.hits.every(Boolean), 'full exposed target at footer end: ' + link.href);
            }
            check(closed.footerScrollWidth <= closed.footerClientWidth + 1, 'footer reflows inside own box');
            check(closed.launcher.width === (scenario.width <= 480 ? 56 : 64), 'launcher width retained');
            check(closed.launcherStyle.color === 'rgb(245, 247, 246)' && closed.launcherStyle.background === 'rgb(16, 35, 28)', 'launcher palette retained');
            if (scenario.safe) check(parseFloat(closed.launcherStyle.right) === 36, 'actual24px right safe-area env');
            // Native Tab sequence from immediately before the first footer action.
            await footerLinks.first().focus(); await page.keyboard.press('Shift+Tab');
            const keyboard = [];
            for (let index = 0; index < await footerLinks.count(); index++) {
                await page.keyboard.press('Tab'); await frames(page);
                const focused = await footerLinks.nth(index).evaluate(node => {
                    const r = node.getBoundingClientRect(), s = getComputedStyle(node);
                    return { active: document.activeElement === node, visible: node.matches(':focus-visible'),
                        outline: s.outlineStyle, centerHit: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
                        inside: r.left >= 0 && r.right <= innerWidth + .5 && r.top >= 0 && r.bottom <= innerHeight + .5 };
                });
                keyboard.push(focused);
                check(focused.active && focused.visible && focused.outline !== 'none' && focused.centerHit && focused.inside, 'native visible unobscured Tab action' + index);
            }
            // Exact physical pointer click; no force/dispatchEvent or auto-scroll locator substitute.
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
            const termBox = await terms.boundingBox();
            await page.mouse.click(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
            const pointerNavigated = await page.waitForURL(base + '/terms.html', { timeout: 600, waitUntil: 'load' }).then(() => true, () => false);
            check(pointerNavigated, 'ordinary Terms pointer navigation');
            if (!pointerNavigated && await page.locator('#nofries-assistant-dialog').getAttribute('open') !== null) await page.keyboard.press('Escape');
            await page.goto(base + route); await frames(page); await stress(page, scenario.stress || '');
            // Open at the footer via an unforced launcher action; never send a question.
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
            await launcher.click(); await page.locator('#nofries-assistant-dialog[open]').waitFor(); await frames(page);
            const dialog = page.locator('#nofries-assistant-dialog'), close = page.locator('[data-assistant-close]');
            const open = await dialog.evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), activeInside: node.contains(document.activeElement) }));
            check(open.activeInside, 'existing open focus enters dialog');
            await close.focus(); await page.keyboard.press('Escape'); await frames(page);
            check(await dialog.getAttribute('open') === null && await launcher.evaluate(node => document.activeElement === node), 'Escape closes and restores launcher focus');
            await launcher.click(); await dialog.waitFor({ state: 'visible' });
            await close.click(); await frames(page);
            check(await dialog.getAttribute('open') === null && await launcher.evaluate(node => document.activeElement === node), 'unforced close restores launcher focus');
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
            // Native Enter from the preceding link tests real legal navigation.
            const count = await footerLinks.count(); await footerLinks.nth(count - 2).focus(); await page.keyboard.press('Tab');
            check(await terms.evaluate(node => document.activeElement === node), 'native Tab reaches Terms after close');
            await page.keyboard.press('Enter'); await page.waitForURL(base + '/terms.html', { waitUntil: 'load' });
            check(new URL(page.url()).pathname === '/terms.html', 'native Enter Terms navigation');
            // Capture the actual closed footer rather than the legal destination.
            await page.goto(base + route); await frames(page); await stress(page, scenario.stress || '');
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
            if (['desktop-evidence', 'reflow-320', 'double-wrap-spacing', 'safe-area'].includes(scenario.name)) {
                await page.screenshot({ path: path.join(artifacts, route.replace(/\W/g, '_') + '-' + scenario.name + '.png') });
            }
            results.push({ route, scenario: scenario.name, closed, keyboard, pointerNavigated, open, failures });
            await context.close();
        }
        // Absent assistant and print retain authored footer geometry.
        const page = await browser.newPage({ viewport: { width: 1188, height: 761 } });
        await page.goto(base + '/managed-it.html');
        await page.locator('[data-shared-assistant]').evaluate(node => node.remove());
        assert.equal(await page.locator('.home-footer').evaluate(node => getComputedStyle(node).paddingRight), '0px');
        await page.goto(base + '/managed-it.html'); await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.home-footer').evaluate(node => getComputedStyle(node).paddingRight), '0px');
        await page.close();
    } catch (error) {
        errors.push(error.stack || String(error));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        const after = hashes();
        const receipt = { sourceRoot: root, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
            browser: 'installed Chromium', harnessHash: hash(fs.readFileSync(__filename)), sourceHashes: before, sourceStable: JSON.stringify(before) === JSON.stringify(after),
            results, requests, blocked, unexpected, errors, candidatePassed: results.length === 44 && results.every(row => row.failures.length === 0) && !blocked.length && !unexpected.length && !errors.length };
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ artifacts, cases: results.length, failed: results.filter(row => row.failures.length).map(row => ({ route: row.route, scenario: row.scenario, failures: row.failures })),
            blocked, unexpected, errors, sourceStable: receipt.sourceStable, candidatePassed: receipt.candidatePassed }));
        assert.equal(receipt.sourceStable, true, 'Source/build fingerprints stable');
        assert.equal(receipt.candidatePassed, true, 'All footer/launcher cases pass; inspect results.json');
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
