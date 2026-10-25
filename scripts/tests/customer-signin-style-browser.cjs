'use strict';

// Optional real-browser presentation check; reuses installed Playwright/Chromium
// and pngjs for native-control pixels. No dependency installation is performed.
// Run: node scripts/tests/customer-signin-style-browser.cjs
// Synthetic loopback GETs only. No sign-in, consent, provider or Azure calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { buildSignupDocument, buildHostedSignupDocument, buildSignupUnavailableDocument } = require('../../lib/signupDocument');
const { createAuthLogoutFunction } = require('../../api/authLogout');
const { BrowserAuthError } = require('../../api/shared/browserAuth');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// The standalone verifier must work on a clean checkout, where dist is absent.
// Generate the exact local package before binding any generated-policy hashes.
execFileSync(process.execPath, [path.join(root, 'scripts/build-static.js')], { cwd: root, stdio: 'pipe' });
const artifacts = fs.mkdtempSync('/tmp/nofries-signin-style-');
fs.chmodSync(artifacts, 0o700);
const sources = { clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js') };
const sourceFiles = ['style.css', 'home.css', 'index.html', 'app/dashboard.html', 'app/dashboard.css', 'images/nofrieslogo.png', 'login.html', 'lib/signupDocument.js', 'api/shared/customerSignup/signupJourney.js',
    'api/shared/customerSignup/signupClient.js', 'js/organisation-setup.js', 'api/authLogout/index.js',
    'staticwebapp.config.json', 'azure/staticwebapp.config.example.json', 'dist/staticwebapp.config.json',
    'shared-assistant.css', 'images/fry-chat.png', 'lib/sharedAssistantDocument.js', 'lib/withSharedAssistantDocument.js', 'lib/withHashBoundSharedAssistantDocument.js',
    'dist/index.html', 'dist/app/dashboard.html', 'dist/login.html',
    'scripts/build-static.js', 'scripts/tests/customer-signin-style-browser.cjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const frozenSources = sourceHashes();
const dynamic = buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' });
const hosted = buildHostedSignupDocument(sources);
const assets = { '/style.css': 'style.css', '/home.css': 'home.css', '/js/organisation-setup.js': 'js/organisation-setup.js',
    '/shared-assistant.css': 'shared-assistant.css', '/images/fry-chat.png': 'images/fry-chat.png',
    '/favicon.svg': 'favicon.svg', '/images/nofrieslogo.png': 'images/nofrieslogo.png' };
const terms = { status: 'terms', termsText: 'Synthetic agreement for rendering only.\nNo consent will be submitted.\n' + 'LongTermsWithoutSpaces'.repeat(12),
    termsVersion: 'synthetic-v1', termsDigest: 'a'.repeat(64), scheduleId: 'synthetic-schedule', scheduleDigest: 'b'.repeat(64),
    scheduleText: 'Synthetic organisation schedule. Saved work and customer data are not accessed.' };
const cases = [
    { name: 'login', path: '/login?provider=legacy', heading: 'Sign up / Sign in', login: true },
    { name: 'login-expired', path: '/login?provider=legacy&signin=expired', heading: 'Sign up / Sign in', login: true },
    { name: 'create', state: { status: 'create_account' }, heading: 'Sign up / Sign in' },
    { name: 'create-retry', state: { status: 'create_account' }, hint: '&signin=retry', heading: 'Restart secure sign-in' },
    { name: 'create-expired', state: { status: 'create_account' }, hint: '&signin=expired', heading: 'Restart secure sign-in' },
    { name: 'choose-account', state: { status: 'create_account' }, hint: '&account=choose', hosted: true, heading: 'Choose your account' },
    { name: 'setup-details', state: { status: 'setup_details', email: 'synthetic@example.test' }, heading: 'Set up your workspace' },
    { name: 'saved-reservation', hosted: true, state: { status: 'setup_details', email: 'synthetic@example.test',
        reservation: { accountType: 'consultant', organisationName: 'Synthetic saved consultancy' } }, heading: 'Set up your workspace' },
    { name: 'resume-setup', state: { status: 'resume_setup', email: 'synthetic@example.test', accountType: 'company',
        organisationName: 'Synthetic saved company' }, heading: 'Resume your workspace setup' },
    { name: 'signin-required', hosted: true, status: 401, state: { status: 'signin_required' }, heading: 'Sign in again' },
    { name: 'continue-manually', state: { status: 'continue_authentication' }, hint: '&signin=expired', heading: 'Continuing account setup' },
    { name: 'terms', hosted: true, state: terms, heading: 'Review your terms' },
    { name: 'resume-acceptance', state: { status: 'resume_acceptance' }, heading: 'Complete account setup' },
    { name: 'pending-preparation', hosted: true, state: { status: 'pending_preparation' }, heading: 'Your organisation is being prepared' },
    { name: 'pending-admission', state: { status: 'pending_admission' }, heading: 'Account setup received' },
    { name: 'unavailable', hosted: true, status: 503, state: { status: 'unavailable' }, heading: 'Signup is unavailable' },
    { name: 'unavailable-document', path: '/unavailable', heading: 'Signup is unavailable', unavailable: true },
    { name: 'signout-uncertain', path: '/signout-uncertain', heading: 'Sign-out was not confirmed', logout: true }
];
let current, base, logoutDocument;
const requests = [], violations = [], pageErrors = [], cspErrors = [], results = [];
const statePaths = ['/api/external-customer-signup/state', '/api/organisation-setup/state'];
const allowedPaths = new Set([...Object.keys(assets), ...statePaths, '/login', '/brand-home', '/brand-dashboard', '/brand-login', '/dynamic', '/hosted', '/unavailable', '/signout-uncertain']);
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || !allowedPaths.has(pathname)) {
        violations.push({ case: current?.name, method: req.method, path: pathname });
        res.statusCode = 405; return res.end();
    }
    if (assets[pathname]) {
        res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        return res.end(fs.readFileSync(path.join(root, assets[pathname])));
    }
    if (statePaths.includes(pathname)) {
        requests.push({ case: current.name, width: current.width, method: req.method, path: pathname });
        res.statusCode = current.status || 200; res.setHeader('Content-Type', 'application/json');
        if (current.login) {
            res.setHeader('x-nofries-customer-sign-in', 'available');
            return res.end(JSON.stringify({ state: 'start' }));
        }
        if (current.status === 401) return res.end(JSON.stringify({ error: 'Signup is unavailable', code: 'signup_signin_required' }));
        return res.end(JSON.stringify({ state: current.state, csrfToken: 's'.repeat(43) }));
    }
    res.setHeader('Content-Type', 'text/html');
    if (pathname === '/brand-home') return res.end(read('dist/index.html'));
    if (pathname === '/brand-dashboard') return res.end(read('dist/app/dashboard.html'));
    if (pathname === '/brand-login') return res.end(read('dist/login.html'));
    if (pathname === '/login') return res.end(read('login.html'));
    if (pathname === '/unavailable') return res.end(buildSignupUnavailableDocument());
    if (pathname === '/signout-uncertain') {
        res.statusCode = logoutDocument.status;
        for (const [name, value] of Object.entries(logoutDocument.headers)) res.setHeader(name, value);
        return res.end(logoutDocument.body);
    }
    const document = pathname === '/hosted' ? hosted : dynamic;
    res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    res.end(document.html);
});

// Evaluate rendered colors, alpha compositing and inherited surfaces, rather
// than asserting stylesheet tokens. Gradient endpoints give conservative bounds.
function renderedAudit({ focusOnly = false } = {}) {
    const color = value => {
        const parts = value.match(/[\d.]+/g)?.map(Number);
        if (!parts || parts.length < 3) throw new Error('Unsupported computed color: ' + value);
        return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])).concat(1);
    const ratio = (a, b) => {
        const luminance = v => v.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
            .reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
    const surfaces = el => {
        if (!el) return [[255, 255, 255, 1]];
        const style = getComputedStyle(el);
        let backgrounds = surfaces(el.parentElement).map(bg => over(color(style.backgroundColor), bg));
        const stops = style.backgroundImage.match(/rgba?\([^)]*\)/g) || [];
        if (stops.length) backgrounds = backgrounds.flatMap(bg => [bg, ...stops.map(stop => over(color(stop), bg))]);
        return backgrounds;
    };
    const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.name ? '[name=' + el.name + ']' : '') +
        ': ' + (el.textContent || el.value || '').trim().slice(0, 75);
    const minimum = (fg, backgrounds) => Math.min(...backgrounds.map(bg => ratio(over(fg, bg), bg)));
    const visible = el => {
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        return !el.closest('[hidden]') && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom > 0;
    };
    if (focusOnly) {
        const el = document.activeElement, style = getComputedStyle(el), fg = color(style.outlineColor);
        const rect = el.getBoundingClientRect(), extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        return { element: describe(el), documentBoundary: el === document.body || el === document.documentElement,
            key: [...document.querySelectorAll('a[href],button,input,select')].indexOf(el),
            focusVisible: el.matches(':focus-visible'), outline: style.outlineStyle,
            width: parseFloat(style.outlineWidth), contrast: minimum(fg, surfaces(el.parentElement)),
            ringBounds: { top: rect.top - extent, bottom: rect.bottom + extent, left: rect.left - extent,
                right: rect.right + extent, viewportHeight: innerHeight, viewportWidth: innerWidth } };
    }
    const text = [], controls = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        const el = node.parentElement;
        if (!node.textContent.trim() || !visible(el) || el.closest('script,noscript,option') || el.disabled) continue;
        const style = getComputedStyle(el), size = parseFloat(style.fontSize), weight = parseFloat(style.fontWeight);
        text.push({ element: describe(el), contrast: minimum(color(style.color), surfaces(el)),
            required: size >= 24 || size >= 18.66 && weight >= 700 ? 3 : 4.5 });
    }
    for (const el of document.querySelectorAll('input,select')) {
        if (!visible(el)) continue;
        const style = getComputedStyle(el), background = surfaces(el), adjacent = surfaces(el.parentElement);
        controls.push({ element: describe(el), type: el.type, disabled: el.disabled, appearance: style.appearance,
            text: minimum(color(style.color), background), border: Math.min(minimum(color(style.borderTopColor), adjacent),
                minimum(color(style.borderTopColor), background)), borderStyle: style.borderTopStyle,
            width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
            adjacent,
            accent: style.accentColor === 'auto' ? null : minimum(color(style.accentColor), adjacent) });
    }
    const actions = [...document.querySelectorAll('#signup button,#signup a.button')].filter(visible).map(el => {
        const style = getComputedStyle(el);
        return { name: el.textContent.trim(), background: color(style.backgroundColor),
            borderStyle: style.borderTopStyle, borderContrast: minimum(color(style.borderTopColor), surfaces(el.parentElement)) };
    });
    return { text, controls, actions };
}

async function buildLogoutFailureFixture() {
    let called = 0;
    const warnings = [], context = { log: { warn: value => warnings.push(value) } };
    const origin = 'https://synthetic.example.test';
    await createAuthLogoutFunction({ setupAccountChange: true, env: { NOFRIES_PUBLIC_URL: origin },
        service: { logout: async () => { called++; throw new BrowserAuthError(401, 'browser_auth_transaction_invalid'); } } })(context,
    { method: 'POST', headers: { accept: 'text/html', origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '192.0.2.20' }, body: {} });
    const response = context.res;
    assert.equal(called, 1); assert.equal(response.status, 401);
    assert.equal(response.headers.Location, undefined); assert.equal(response.headers['Set-Cookie'], undefined);
    assert.ok(Buffer.byteLength(response.body, 'utf8') <= 20 * 1024, 'Actual emitted logout page exceeds 20 KiB');
    assert.doesNotMatch(response.body, /<script\b/i);
    assert.match(response.body, /href="\/signup\?provider=external"/);
    assert.match(response.body, /may still finish/);
    assert.match(response.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.match(response.headers['Content-Security-Policy'], /form-action 'none'/);
    assert.deepEqual(warnings, ['Browser sign-out failed: browser_auth_transaction_invalid']);
    const route = '/api/external-customer-auth/logout';
    const normalizePolicy = policy => policy.split(';').map(part => part.trim()).filter(Boolean).join('; ');
    const routePolicies = ['staticwebapp.config.json', 'azure/staticwebapp.config.example.json', 'dist/staticwebapp.config.json'].map(file => {
        const config = JSON.parse(read(file));
        const rule = config.routes.find(candidate => (!candidate.methods || candidate.methods.includes('POST')) &&
            (candidate.route.endsWith('*') ? route.startsWith(candidate.route.slice(0, -1)) : candidate.route === route));
        assert.equal(rule?.route, route, file + ': earlier route shadows the exact POST logout rule');
        assert.deepEqual(rule.methods, ['POST']);
        const policy = rule.headers['Content-Security-Policy'];
        assert.equal(normalizePolicy(policy), normalizePolicy(response.headers['Content-Security-Policy']), file + ': backend/edge policies differ');
        return { file, matchedRoute: rule.route, methods: rule.methods, policy, bytes: Buffer.byteLength(read(file), 'utf8') };
    });
    const generated = routePolicies.at(-1);
    assert.ok(generated.bytes <= 20000, 'Generated static configuration exceeds its unchanged 20000-byte limit');
    // Local ordered-route model only: use the generated edge policy in Chromium,
    // without asserting which same-named header Azure actually chooses live.
    return { ...response, headers: { ...response.headers, 'Content-Security-Policy': generated.policy },
        routePolicies, backendPolicy: response.headers['Content-Security-Policy'] };
}

async function recoveryHierarchy(page, audit, name) {
    const choose = page.locator('a[href="/api/external-customer-auth/login?account=choose"]:visible');
    if (['create-expired', 'resume-setup', 'signin-required', 'unavailable'].includes(current.name)) {
        assert.equal(await choose.count(), 1, name + ': another-account action is duplicated or missing');
    }
    if (['setup-details', 'saved-reservation', 'continue-manually'].includes(current.name)) {
        assert.equal(await choose.count(), 0, name + ': another-account footer duplicates protected sign-out');
        const form = page.locator('form[action="/api/external-customer-auth/logout"]');
        assert.equal(await form.count(), 1); assert.equal(await form.getAttribute('method'), 'post');
        assert.ok(await form.getByRole('button', { name: 'Sign out and change account', exact: true }).isVisible());
    }
    if (['resume-setup', 'unavailable'].includes(current.name)) {
        const primary = audit.actions.filter(action => action.background[3] === 1 && action.background[0] >= 200 &&
            action.background[1] >= 150 && action.background[2] <= 60);
        assert.equal(primary.length, 1, name + ': recovery must have one yellow primary action');
        const secondary = audit.actions.find(action => action.name === 'Sign in again');
        assert.ok(secondary && secondary.background[3] === 0 && secondary.borderStyle !== 'none' && secondary.borderContrast >= 3,
            name + ': sign-in recovery needs a readable outlined secondary action');
    }
}

async function reportLinkCheck(page, name) {
    if (current.login) return null;
    const fragments = ['/report.html#kind=feedback&screen=signup', '/report.html#kind=error&screen=signup',
        '/report.html#kind=error&screen=signup&code=signup_unavailable'];
    const links = await page.locator('a[href*="report.html"]').evaluateAll(nodes => nodes.map(el => ({
        href: el.getAttribute('href'), target: el.target, rel: el.rel, name: el.getAttribute('aria-label')
    })));
    assert.ok(links.length, name + ': missing report access');
    for (const link of links) {
        assert.ok(fragments.includes(link.href), name + ': report link includes unreviewed context');
        const url = new URL(link.href, base);
        assert.equal(url.origin, base); assert.equal(url.pathname, '/report.html'); assert.equal(url.search, '');
        assert.equal(new URLSearchParams(url.hash.slice(1)).has('step'), false);
        assert.equal(link.target, '_blank');
        assert.ok(['noopener', 'noreferrer'].every(value => link.rel.split(/\s+/).includes(value)));
        assert.match(link.name, /opens in a new tab/i);
    }
    const visible = page.getByRole('link', { name: /^Report / });
    assert.equal(await visible.count(), 1, name + ': report access is duplicated or missing');
    const href = await visible.getAttribute('href');
    assert.equal(href, current.name === 'unavailable' ? fragments[2] : current.logout ? fragments[1] : fragments[0]);
    // The composer is a separate pending feature. Never click its link here.
    return { href, visible: 1, target: '_blank', dependency: 'Report composer pending; navigation was not exercised.' };
}

async function nativeCheckboxBoundary(locator, adjacent, name) {
    // Native Chromium borders are painted by the user agent and are absent from
    // computed CSS. Sample each actual unchecked edge against its surroundings.
    const png = PNG.sync.read(await locator.screenshot({ path: path.join(artifacts, name + '-checkbox.png') }));
    const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    assert.equal(contrast([0, 0, 0], [255, 255, 255]), 21);
    const edges = [[], [], [], []];
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
        const pixel = [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
        const value = Math.min(...adjacent.map(bg => contrast(pixel, bg)));
        if (x >= png.width / 3 && x < png.width * 2 / 3) {
            if (y < png.height / 4) edges[0].push(value);
            if (y >= png.height * 3 / 4) edges[1].push(value);
        }
        if (y >= png.height / 3 && y < png.height * 2 / 3) {
            if (x < png.width / 4) edges[2].push(value);
            if (x >= png.width * 3 / 4) edges[3].push(value);
        }
    }
    const contrasts = edges.map(edge => Math.max(...edge));
    assert.ok(contrasts.every(value => value >= 3), `${name}: native checkbox boundary contrasts ${JSON.stringify(contrasts)}`);
    return contrasts;
}

async function keyboardChecks(page, card, name) {
    const skip = page.locator('.skip-link');
    // Rendering focuses its heading. Reach the real skip link from that focus.
    for (let n = 0; n < 60 && !await skip.evaluate(el => el === document.activeElement); n++) await page.keyboard.press('Shift+Tab');
    assert.ok(await skip.evaluate(el => el === document.activeElement), name + ': keyboard cannot reach skip link');
    const before = page.url(); await page.keyboard.press('Enter');
    assert.ok(await page.locator(card).evaluate(el => el === document.activeElement), name + ': skip target did not receive focus');
    if (current.state) assert.equal(page.url(), before, name + ': generated skip changed the URL');
    const expected = await page.locator('a[href],button,input,select').evaluateAll(nodes => nodes.filter(el => {
        const r = el.getBoundingClientRect(); return !el.disabled && !el.closest('[hidden]') && r.width > 0 && r.height > 0 && el.tabIndex >= 0;
    }).length);
    const seen = new Set(), focus = [];
    for (let n = 0; n <= expected + 4; n++) {
        await page.keyboard.press('Tab');
        const item = await page.evaluate(renderedAudit, { focusOnly: true });
        // Chromium briefly focuses the viewport when traversal wraps; it is
        // not an interactive control and the next Tab must reach the skip link.
        if (item.documentBoundary) continue;
        if (seen.has(item.key)) break;
        seen.add(item.key);
        assert.ok(item.focusVisible && item.outline !== 'none' && item.width >= 2 && item.contrast >= 3,
            `${name}: unreadable keyboard focus ${JSON.stringify(item)}`);
        const ringFits = item.ringBounds.top >= -.5 && item.ringBounds.bottom <= item.ringBounds.viewportHeight + .5 &&
            item.ringBounds.left >= -.5 && item.ringBounds.right <= item.ringBounds.viewportWidth + .5;
        if (!ringFits || name === 'unavailable-320-text-200' && item.element === 'button: Check setup status' ||
            name === 'login-1440' && item.element === 'a: Privacy') {
            await page.screenshot({ path: path.join(artifacts, 'focus-ring-' + name + '.png') });
        }
        if (name === 'unavailable-320-text-200' && item.element.startsWith('a#signup-skip:')) {
            await page.screenshot({ path: path.join(artifacts, 'focus-ring-skip-' + name + '.png') });
        }
        assert.ok(ringFits, `${name}: keyboard focus ring clipped by viewport ${JSON.stringify(item)}`);
        focus.push(item);
        if (await page.locator('input[type="checkbox"]').evaluateAll(nodes => nodes.includes(document.activeElement))) {
            await page.keyboard.press('Space');
            assert.ok(await page.evaluate(() => document.activeElement.checked), name + ': keyboard did not toggle checkbox');
            await page.keyboard.press('Space');
        }
        if (await page.locator('select:enabled').evaluateAll(nodes => nodes.includes(document.activeElement))) {
            const initial = await page.evaluate(() => document.activeElement.value);
            await page.keyboard.press('ArrowDown');
            assert.notEqual(await page.evaluate(() => document.activeElement.value), initial, name + ': keyboard did not change account type');
            await page.keyboard.press('ArrowUp');
            assert.equal(await page.evaluate(() => document.activeElement.value), initial);
        }
    }
    assert.equal(seen.size, expected, name + ': not all enabled controls were reachable by Tab: ' + JSON.stringify(focus));
    return focus;
}

async function brandChecks(page, name) {
    const brand = await page.evaluate(() => {
        const body = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
        const logo = document.querySelector('.brand-logo'), card = [...document.querySelectorAll('.organisation-card, #dashboardStatusPanel')]
            .find(node => node.getBoundingClientRect().width > 0);
        return { tokens: Object.fromEntries(['--page', '--paper', '--line', '--muted', '--green', '--yellow', '--ink']
            .map(token => [token, body.getPropertyValue(token).trim()])),
            rootTokens: Object.fromEntries(['--page', '--paper', '--line', '--muted', '--green', '--yellow', '--ink']
                .map(token => [token, root.getPropertyValue(token).trim()])),
            logo: { path: logo.getAttribute('src'), width: logo.getBoundingClientRect().width,
                height: logo.getBoundingClientRect().height, loaded: logo.complete && logo.naturalWidth === 1024 },
            icons: [...document.querySelectorAll('link[rel="icon"]')].map(icon => ({ path: icon.getAttribute('href'), type: icon.type })),
            font: body.fontFamily, card: card ? getComputedStyle(card).backgroundColor : null };
    });
    assert.deepEqual(brand.tokens, brand.rootTokens, name + ': page overrides the shared brand palette');
    assert.deepEqual(brand.tokens, { '--page': '#08100f', '--paper': '#111b1a', '--line': '#2a3b38', '--muted': '#a9bbb7',
        '--green': '#6cd8c9', '--yellow': '#ffd400', '--ink': '#f6faf9' }, name + ': shared brand palette drift');
    assert.deepEqual(brand.logo, { path: '/images/nofrieslogo.png', width: 44, height: 44, loaded: true }, name + ': canonical logo drift');
    assert.deepEqual(brand.icons, [{ path: '/images/nofrieslogo.png', type: 'image/png' }], name + ': missing or placeholder tab icon');
    assert.match(brand.font, /^Inter, ui-sans-serif, system-ui/);
    if (brand.card) assert.equal(brand.card, 'rgb(17, 27, 26)', name + ': account surface drift');
    return brand;
}

async function headingBoundsCheck(page, name, expectedHeading) {
    const headings = await page.locator('.signup-card h1').evaluateAll(elements => elements.map(el => {
        const card = el.closest('.signup-card'), box = card.getBoundingClientRect(), style = getComputedStyle(card);
        const range = document.createRange(); range.selectNodeContents(el);
        return { text: el.textContent, fontSize: getComputedStyle(el).fontSize,
            clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
            left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
            right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
            glyphs: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right })) };
    }));
    for (const heading of headings) {
        assert.equal(heading.text, expectedHeading, name + ': full heading must remain unchanged');
        assert.ok(heading.glyphs.length > 0, name + ': heading has no rendered text');
        assert.ok(heading.scrollWidth <= heading.clientWidth + 1, name + ': heading text overflows its box: ' + JSON.stringify(heading));
        for (const glyph of heading.glyphs) assert.ok(glyph.left >= heading.left - 1 && glyph.right <= heading.right + 1,
            name + ': heading text extends beyond card content: ' + JSON.stringify(heading));
    }
    return headings;
}

async function publicBrandChecks(browser) {
    // Actual static-package documents, including Fry's existing wrapper, with
    // page scripts disabled: no session/state/provider request is needed.
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    const pages = ['/brand-home', '/brand-dashboard', '/brand-login'];
    await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === base && req.method() === 'GET' && (pages.includes(url.pathname) || Object.hasOwn(assets, url.pathname))) return route.continue();
        violations.push({ case: 'public-brand', method: req.method(), path: url.pathname, external: url.origin !== base });
        return route.abort();
    });
    try {
        const page = await context.newPage();
        for (const width of [1440, 768, 390, 320]) for (const target of pages) {
            const name = target.slice(1) + '-' + width;
            await page.setViewportSize({ width, height: 900 }); await page.goto(base + target);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': horizontal overflow');
            const brand = await brandChecks(page, name);
            await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
            results.push({ name, scriptsDisabled: true, brand });
        }
    } finally { await context.close(); }
}

async function main() {
    logoutDocument = await buildLogoutFailureFixture();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true });
    try {
        await publicBrandChecks(browser);
        const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
        await context.route('**/*', route => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin === base && req.method() === 'GET' && allowedPaths.has(url.pathname)) return route.continue();
            violations.push({ case: current?.name, method: req.method(), path: url.pathname, external: url.origin !== base });
            return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', event => { if (/Content Security Policy|Refused to/i.test(event.text())) cspErrors.push(event.text()); });
        const renderCases = [1440, 768, 390, 320].flatMap(width => cases.map(scenario => ({ width, scenario, textScale: 1 })));
        // Root-font enlargement models 200% text resizing independently of
        // viewport reflow. Check both emitted and state-rendered error headings.
        for (const width of [1440, 768, 390, 320]) for (const scenario of cases.filter(item =>
            ['unavailable', 'unavailable-document'].includes(item.name))) renderCases.push({ width, scenario, textScale: 2 });
        for (const width of [1440, 320]) for (const scenario of cases.filter(item =>
            ['login', 'pending-preparation'].includes(item.name))) renderCases.push({ width, scenario, textScale: 2 });
        for (const { width, scenario, textScale } of renderCases) {
            current = { ...scenario, width }; const name = scenario.name + '-' + width + (textScale === 2 ? '-text-200' : ''), before = requests.length;
            await page.setViewportSize({ width, height: 900 });
            const target = scenario.path || '/' + (scenario.hosted ? 'hosted' : 'dynamic') + '?provider=external' + (scenario.hint || '');
            await page.goto(base + target);
            await page.getByRole('heading', { name: scenario.heading, exact: true }).waitFor();
            const card = scenario.login ? '#create-organisation' : scenario.logout ? await page.locator('.skip-link').getAttribute('href') : '#signup';
            assert.match(card, /^#[A-Za-z][\w-]*$/, name + ': skip target must be a fixed local fragment');
            await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-busy') !== 'true', card);
            assert.equal(requests.length - before, scenario.unavailable || scenario.logout ? 0 : 1, name + ': unexpected state request count');
            assert.equal(page.url(), base + target, name + ': automatic navigation');
            if (textScale === 2) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': horizontal overflow');
            const headings = await headingBoundsCheck(page, name, scenario.heading);
            if (scenario.name === 'login-expired') assert.match(await page.locator('#organisation-status').textContent(), /expired/);
            if (scenario.name === 'saved-reservation') {
                assert.ok(await page.getByRole('combobox').isDisabled());
                assert.equal(await page.getByRole('combobox').inputValue(), 'consultant');
                assert.ok(await page.getByLabel('Company or consultancy name', { exact: true }).isDisabled());
                assert.equal(await page.getByLabel('Company or consultancy name', { exact: true }).inputValue(), 'Synthetic saved consultancy');
            }
            if (scenario.name === 'terms') {
                assert.equal(await page.getByRole('checkbox').isChecked(), false);
                assert.ok(await page.getByRole('button', { name: 'Accept and continue', exact: true }).isDisabled());
            }
            await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
            const brand = await brandChecks(page, name);
            const audit = await page.evaluate(renderedAudit);
            await recoveryHierarchy(page, audit, name);
            const report = await reportLinkCheck(page, name);
            for (const item of audit.text) assert.ok(item.contrast >= item.required, `${name}: text contrast ${JSON.stringify(item)}`);
            for (const item of audit.controls) {
                if (item.type !== 'checkbox') assert.ok(item.text >= 4.5, `${name}: control text contrast ${JSON.stringify(item)}`);
                if (item.type === 'checkbox' && item.appearance === 'auto') {
                    item.nativeBoundary = await nativeCheckboxBoundary(page.getByRole('checkbox'), item.adjacent, name);
                } else assert.ok(item.borderStyle !== 'none' && item.border >= 3, `${name}: control boundary contrast ${JSON.stringify(item)}`);
                if (item.type === 'checkbox') assert.ok(item.width >= 20 && item.height >= 20 && item.accent >= 3,
                    `${name}: checkbox readability ${JSON.stringify(item)}`);
            }
            const focus = await keyboardChecks(page, card, name);
            if (scenario.name === 'terms') {
                assert.equal(await page.getByRole('checkbox').isChecked(), false);
                assert.ok(await page.getByRole('button', { name: 'Accept and continue', exact: true }).isDisabled());
            }
            results.push({ name, textScale, headings, brand, text: audit.text, controls: audit.controls, actions: audit.actions, report, focus });
            assert.deepEqual(violations, []); assert.deepEqual(pageErrors, []); assert.deepEqual(cspErrors, []);
        }
        assert.deepEqual(sourceHashes(), frozenSources, 'Presentation source changed during the browser run');
        console.log(JSON.stringify({ passed: true, screens: results.length, browser: browser.version(), artifacts }));
    } finally {
        fs.writeFileSync(path.join(artifacts, 'browser-results.json'), JSON.stringify({ sourceHashes: frozenSources,
            browser: browser.version(), logoutDocument: { status: logoutDocument.status,
                bytes: Buffer.byteLength(logoutDocument.body, 'utf8'), contentSecurityPolicy: logoutDocument.headers['Content-Security-Policy'],
                backendPolicy: logoutDocument.backendPolicy, routePolicies: logoutDocument.routePolicies,
                scope: 'Local ordered-route/backend model; Azure effective header precedence was not observed.' },
            results, requests, violations, pageErrors, cspErrors,
            scope: 'Synthetic loopback rendering only; no authentication, consent, admission, deployment or production acceptance.' }, null, 2) + '\n', { mode: 0o600 });
        await browser.close();
    }
}
main().catch(error => { console.error(error); console.error('Private browser evidence: ' + artifacts); process.exitCode = 1; })
    .finally(() => { server.closeAllConnections(); server.close(); });
