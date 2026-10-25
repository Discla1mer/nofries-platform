'use strict';

// Optional synthetic, loopback-only presentation check using installed browsers.
// node scripts/tests/ui-styling-browser.cjs [--observe]
// --observe captures the unchanged baseline without enforcing new style targets.
// NOFRIES_STYLING_ARTIFACTS selects an external evidence directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildSignupDocument } = require('../../lib/signupDocument');
const { buildFixtures } = require('../build-ncsc-questionnaire-preview');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file));
const hash = value => createHash('sha256').update(value).digest('hex');
const observe = process.argv.includes('--observe');
const artifacts = process.env.NOFRIES_STYLING_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-ui-styling-'));
fs.mkdirSync(artifacts, { recursive: true });
const sources = ['style.css', 'home.css', 'app/dashboard.css', 'login.html', 'lib/signupDocument.js',
    'js/organisation-setup.js', 'api/shared/customerSignup/signupClient.js', 'api/shared/customerSignup/signupJourney.js',
    'api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js',
    'api/shared/protectedAssets/ncscQuestionnaire.js', 'api/shared/protectedAssets/organisationPicture.js',
    'api/shared/ncscQuestionnaireMetadata.js', 'scripts/build-ncsc-questionnaire-preview.js',
    'scripts/tests/ui-styling-browser.cjs'];
const hashes = () => Object.fromEntries(sources.map(file => [file, hash(read(file))]));
const before = hashes();
const signup = buildSignupDocument({ clientSource: read(sources[6]).toString(), journeySource: read(sources[7]).toString(),
    customerLogin: true, customerTransport: 'external' });
const fixtures = buildFixtures();
const seed = fixtures.tenants[0];
const bundle = sources.slice(8, 12).map(file => read(file)).join('\n');
const glue = `const seed = ${JSON.stringify(seed)}, metadata = ${JSON.stringify(fixtures.metadata)};
    const client = { list: async () => ({ assessments: seed.assessments, nextAfterAssessmentId: null }),
        read: async id => ({ assessment: seed.assessments.find(row => row.assessmentId === id) }),
        create: async () => { throw new Error('Unexpected mutation'); },
        save: async () => { throw new Error('Unexpected mutation'); },
        submit: async () => { throw new Error('Unexpected mutation'); },
        normaliseCommand: value => value, commandByteLength: value => JSON.stringify(value).length };
    NoFriesDashboard.mount(document.getElementById('dashboard'), seed.model, { window,
        initialRoute: location.hash || 'overview',
        mountPicture(child, presentation) { return NoFriesOrganisationPicture.mount(child, { metadata, client,
            organisationId: seed.model.context.organisationId, displayName: seed.model.context.displayName,
            initialAssessmentId: 'assessment-submitted', openCyber: presentation.openCyber }); },
        mountCyber(child) { return NoFriesNcscQuestionnaire.mount(child, { metadata, client,
            organisationId: seed.model.context.organisationId, presentationMode: 'editable' }); } });`;
const document = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Synthetic No Fries styling</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/dashboard.css">' +
    '<body><div id="dashboard"></div><script src="/app.js"></script><script src="/fixture.js"></script></body></html>';
const assets = { '/style.css': 'style.css', '/home.css': 'home.css', '/dashboard.css': 'app/dashboard.css',
    '/js/organisation-setup.js': 'js/organisation-setup.js', '/images/nofrieslogo.png': 'images/nofrieslogo.png', '/favicon.svg': 'favicon.svg' };
const errors = [], blocked = [], results = [];
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { blocked.push(req.method + ' ' + pathname); res.statusCode = 405; return res.end(); }
    if (assets[pathname]) {
        res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(read(assets[pathname]));
    }
    if (pathname === '/api/organisation-setup/state' || pathname === '/api/external-customer-signup/state') {
        res.setHeader('Content-Type', 'application/json');
        if (pathname.includes('organisation-setup')) {
            res.setHeader('x-nofries-customer-sign-in', 'available'); return res.end(JSON.stringify({ state: 'start' }));
        }
        return res.end(JSON.stringify({ state: { status: 'setup_details', email: 'synthetic@example.test' }, csrfToken: 's'.repeat(43) }));
    }
    res.setHeader('Content-Type', 'text/html');
    if (pathname === '/login') return res.end(read('login.html'));
    if (pathname === '/signup') { res.setHeader('Content-Security-Policy', signup.contentSecurityPolicy); return res.end(signup.html); }
    if (pathname === '/dashboard') return res.end(document);
    if (pathname === '/app.js' || pathname === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript'); return res.end(pathname === '/app.js' ? bundle : glue);
    }
    blocked.push(req.method + ' ' + pathname); res.statusCode = 404; res.end();
});

async function capture(page, name, width) {
    const sample = await page.evaluate(() => {
        const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = value => rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const contrast = el => {
            let surface = el;
            while (surface.parentElement && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
            const a = luminance(getComputedStyle(el).color), b = luminance(getComputedStyle(surface).backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        };
        const texts = [...document.querySelectorAll('.organisation-card .field-help, .signup-help, .signup-report-help, .picture-source, .picture-metric p, .picture-domain-detail')]
            .filter(visible).map(el => ({ selector: el.className, fontSize: parseFloat(getComputedStyle(el).fontSize), contrast: contrast(el) }));
        const card = document.querySelector('.organisation-card');
        return { viewportWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            cardWidth: card?.getBoundingClientRect().width, texts,
            introVisible: !!document.querySelector('.access-intro') && visible(document.querySelector('.access-intro')) };
    });
    assert.ok(sample.scrollWidth <= width, name + ': horizontal overflow');
    for (const text of sample.texts) assert.ok(text.contrast >= 4.5, name + ': supporting-text contrast ' + text.selector);
    if (!observe) {
        for (const text of sample.texts) assert.ok(text.fontSize >= 14, name + ': small supporting text ' + text.selector);
        if (width === 820 && sample.cardWidth) {
            assert.ok(sample.cardWidth >= 520, name + ': tablet form is too narrow');
            assert.equal(sample.introVisible, false, name + ': tablet form should take the available column');
        }
    }
    await page.screenshot({ path: path.join(artifacts, name + '-' + width + '.png'), fullPage: true });
    const detail = { overview: '.picture-metrics', assessment: '.ncsc-answer', results: '.ncsc-results' }[name];
    if (detail) await page.locator(detail).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    else await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(artifacts, name + '-' + width + '-viewport.png') });
    results.push({ name, width, ...sample });
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser, page, failure = null;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true, args: ['--no-sandbox'] });
        page = await browser.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            if (new URL(route.request().url()).origin === base && route.request().method() === 'GET') return route.continue();
            blocked.push('external or mutation'); return route.abort();
        });
        for (const width of [1440, 1024, 820, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(base + '/login?provider=legacy');
            await page.locator('#organisation-returning').waitFor();
            await capture(page, 'login', width);
            await page.goto(base + '/signup');
            await page.getByRole('checkbox').waitFor();
            assert.equal(await page.getByRole('checkbox').isChecked(), false);
            await capture(page, 'signup', width);
            await page.goto(base + '/dashboard');
            await page.locator('.picture-metric').first().waitFor();
            await capture(page, 'overview', width);
            await page.goto(base + '/dashboard?view=cyber#cyber-security');
            await page.locator('.ncsc-assessment-list button').first().click();
            await page.locator('.ncsc-answer').waitFor();
            await page.locator('.ncsc-questionnaire select').selectOption({ index: 0 });
            const selected = await page.locator('.ncsc-answer input:checked').inputValue();
            await capture(page, 'assessment', width);
            assert.equal(await page.locator('.ncsc-answer input:checked').inputValue(), selected);
            await page.goto(base + '/dashboard?view=results#cyber-security');
            await page.locator('.ncsc-assessment-list button').last().click();
            await page.locator('.ncsc-result-value').first().waitFor();
            await capture(page, 'results', width);
        }
        assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(hashes(), before);
        console.log(JSON.stringify({ passed: true, observe, screens: results.length, artifacts, browser: browser.version() }));
    } catch (error) {
        failure = error.message;
        if (page) {
            await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
            fs.writeFileSync(path.join(artifacts, 'failure.txt'), await page.locator('body').innerText());
        }
        throw error;
    }
    finally {
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ passed: failure === null, failure, observe,
            syntheticOnly: true, results, errors, blocked, sourceHashesBefore: before, sourceHashesAfter: hashes(),
            browser: browser?.version() }, null, 2));
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
