'use strict';
// Loopback built pages only. No production requests, submissions or accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const root = path.resolve(process.env.NOFRIES_A11Y_ROOT || path.join(__dirname, '../..'));
const dist = path.join(root, 'dist');
const config = JSON.parse(fs.readFileSync(path.join(dist, 'staticwebapp.config.json')));
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const results = [], unexpected = [], failures = [];
const evidence = path.resolve(process.env.NOFRIES_A11Y_RESULTS || '/tmp/nofries-public-accessibility.json');
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { unexpected.push(req.method + ' ' + url.pathname); res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/prospect/session') return res.end(JSON.stringify({ assistant: { publicHelpOnly: true, publicHelpProtocol: 'public-help-v1', runtime: { mode: 'mock' } } }));
        if (url.pathname === '/api/organisation-setup/state') {
            res.setHeader('x-nofries-customer-entry', 'legacy');
            return res.end(JSON.stringify({ state: 'start' }));
        }
        if (['/api/auth/me', '/api/dashboard/access', '/api/dashboard/session', '/api/customer-auth/session', '/api/external-customer-auth/session'].includes(url.pathname)) {
            res.writeHead(401); return res.end('{}');
        }
        unexpected.push(req.method + ' ' + url.pathname); res.writeHead(404); return res.end('{}');
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        unexpected.push(req.method + ' ' + url.pathname); res.writeHead(404); return res.end();
    }
    const route = config.routes.find(entry => entry.route === url.pathname);
    res.setHeader('Content-Security-Policy', route?.headers?.['Content-Security-Policy'] || config.globalHeaders['Content-Security-Policy']);
    res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[path.extname(file)] || 'text/html');
    res.end(fs.readFileSync(file));
});
function contrastInPage(selector) {
    const el = document.querySelector(selector), style = getComputedStyle(el);
    const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = a => a.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
    let parent = el, bg;
    while (parent) { bg = getComputedStyle(parent).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)') break; parent = parent.parentElement; }
    const foreground = lum(rgb(style.color)), background = lum(rgb(bg));
    return { color: style.color, background: bg, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
}
async function scan(page, selector) {
    const builder = new AxeBuilder({ page }).withTags(tags);
    const r = await (selector ? builder.include(selector) : builder).analyze();
    return { violations: r.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
        incomplete: r.incomplete.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })) };
}
async function signupContrast(page) {
    // Probe the real candidate stylesheet, even before #58's error UI lands.
    await page.locator('#create-organisation').evaluate(card => {
        const error = document.createElement('p');
        error.id = 'a11y-signup-error-probe'; error.className = 'signup-field-error';
        error.textContent = 'Enter a valid email address.'; card.append(error);
    });
    const selector = '#a11y-signup-error-probe';
    const candidate = await page.evaluate(contrastInPage, selector);
    const candidateScan = await scan(page, selector);
    // Negative control reproduces #58 error ink + #32 cream. It must be caught;
    // it is never substituted for the unmodified candidate check above.
    await page.locator(selector).evaluate(el => { el.style.color = '#ffb59e'; el.style.backgroundColor = '#f6f2ea'; el.style.fontSize = '14px'; });
    const combined = await page.evaluate(contrastInPage, selector);
    const negative = await scan(page, selector);
    assert.ok(combined.ratio < 4.5 && negative.violations.some(v => v.id === 'color-contrast'), 'Detector must catch the reported combined-palette defect');
    // Positive control: the visual owner's existing dark red token value.
    await page.locator(selector).evaluate(el => { el.style.color = '#a3352a'; });
    const corrected = await page.evaluate(contrastInPage, selector);
    assert.ok(corrected.ratio >= 4.5 && !(await scan(page, selector)).violations.some(v => v.id === 'color-contrast'), 'Detector must accept sufficient contrast');
    await page.locator(selector).evaluate(el => el.remove());
    return { candidate, candidateScan, combined, corrected, negativeDetected: true };
}
async function reportHint(page) {
    const hint = page.locator('#report-description-help');
    if (!await hint.count()) {
        const legacy = await page.locator('#report-description').evaluate(el => {
            const s = getComputedStyle(el, '::placeholder');
            return { color: s.color, background: getComputedStyle(el).backgroundColor, text: el.placeholder };
        });
        return { pass: false, legacy };
    }
    const described = (await page.locator('#report-description').getAttribute('aria-describedby') || '').split(/\s+/);
    const value = await page.evaluate(contrastInPage, '#report-description-help');
    const original = await hint.textContent();
    await page.locator('#report-description').fill('Synthetic example: the page did not finish.');
    const retained = await hint.isVisible() && await hint.textContent() === original;
    await page.locator('#report-description').fill('');
    return { pass: retained && described.includes('report-description-help') && described.includes('report-privacy') && value.ratio >= 4.5,
        retainedWhileTyping: retained, ...value };
}
async function doubleText(page) {
    // Snapshot every computed size first; do not compound inherited sizes.
    const count = await page.evaluate(() => {
        const sizes = [...document.querySelectorAll('body, body *')].map(el => [el, parseFloat(getComputedStyle(el).fontSize)]).filter(([, n]) => Number.isFinite(n));
        sizes.forEach(([el, n]) => { el.style.fontSize = n * 2 + 'px'; });
        if (sizes.some(([el, n]) => Math.abs(parseFloat(getComputedStyle(el).fontSize) - n * 2) > .1)) throw new Error('Text did not double');
        return sizes.length;
    });
    assert.ok(count > 20, 'Measured text enlargement, not device scaling');
    return count;
}
async function layout(page) {
    return page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('h1,h2,h3,p,label,input,textarea,select,button,a')].filter(el => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width && r.height && s.visibility !== 'hidden' && !el.matches('.skip-link,.report-skip') &&
                (r.right > innerWidth + 1 || r.left < -1 || el.scrollWidth > el.clientWidth + 1 && ['hidden', 'clip'].includes(s.overflowX));
        }).map(el => ({ tag: el.tagName, id: el.id, class: el.className, text: el.textContent.trim().slice(0, 55) })) }));
}
(async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
        console.log('Chromium ' + browser.version());
        const routes = ['/', '/login', '/managed-it.html', '/privacy.html', '/terms.html', '/roadmap.html', '/report.html'];
        if (fs.existsSync(path.join(dist, 'contact.html'))) routes.push('/contact.html');
        else console.log('Contact form absent: deferred to #42/#43, not a passing contact-form check.');
        for (const route of routes) for (const width of [1280, 320]) for (const scale of [1, 2]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            try {
                const page = await context.newPage(); page.setDefaultTimeout(5000);
                page.on('pageerror', error => unexpected.push(route + ': ' + error.message));
                await page.route('**/*', r => {
                    if (new URL(r.request().url()).origin === base && r.request().method() === 'GET') return r.continue();
                    unexpected.push(r.request().method() + ' ' + new URL(r.request().url()).pathname); return r.abort();
                });
                await page.goto(base + route);
                await page.locator('h1').first().waitFor();
                if (route === '/login') await page.locator('#organisation-email').waitFor();
                const launcher = page.locator('[data-assistant-launcher]');
                await launcher.waitFor();
                // Reveal help before resizing so its text is measured too; no message is sent.
                await launcher.press('Enter');
                await page.locator('#assistant-input').waitFor();
                await page.waitForFunction(() => !document.querySelector('#assistant-input').disabled);
                const doubled = scale === 2 ? await doubleText(page) : 0;
                const help = { axe: await scan(page), layout: await layout(page) };
                await page.getByRole('button', { name: 'Close No Fries chat', exact: true }).press('Enter');
                const closed = { axe: await scan(page), layout: await layout(page) };
                const probe = route === '/login' ? await signupContrast(page) : null;
                const hint = route === '/report.html' ? await reportHint(page) : null;
                const entry = { route, width, scale, doubled, closed, help, probe, hint };
                if (probe && (probe.candidate.ratio < 4.5 || probe.candidateScan.violations.length)) failures.push({ route, width, scale, state: 'signup-error-contrast' });
                if (hint && !hint.pass) failures.push({ route, width, scale, state: 'persistent-report-hint' });
                results.push(entry);
                console.log(JSON.stringify(entry));
                for (const [state, observation] of Object.entries({ closed, help })) {
                    if (observation.axe.violations.length || observation.layout.scrollWidth > width + 1 || observation.layout.overflow.length) failures.push({ route, width, scale, state });
                }
            } finally { await context.close(); }
        }
        assert.deepEqual(unexpected, [], 'Unexpected network request or page error');
        assert.deepEqual(failures, [], 'Public accessibility failures');
    } finally {
        const summary = { cases: results.length, failures, unexpected };
        fs.writeFileSync(evidence, JSON.stringify({ summary, results }, null, 2));
        console.log(JSON.stringify({ ...summary, evidence }));
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Public accessibility\n' +
            `${results.length} cases (1280/320 CSS pixels × 100/200% measured text; help open/closed).\n\n` +
            '| Page | Width | Text | Failing state |\n| --- | ---: | ---: | --- |\n' +
            failures.map(f => `| ${f.route} | ${f.width} | ${f.scale * 100}% | ${f.state} |`).join('\n') + '\n');
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
