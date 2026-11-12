'use strict';
const fs = require('node:fs');
const { READ_ONLY_CHECKS, READ_ONLY_PATHS, runSmoke, formatReport } = require('../scripts/post-release-smoke');
const { buildSignupDocument, buildHostedSignupDocument, buildSignupUnavailableDocument } = require('../lib/signupDocument');
const read = path => fs.readFileSync(require.resolve(path), 'utf8');
const sources = { clientSource: read('../api/shared/customerSignup/signupClient.js'),
    journeySource: read('../api/shared/customerSignup/signupJourney.js') };
const legacy = buildSignupDocument({ ...sources, customerLogin: true }).html;
const external = buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' }).html;
// Use the real static builder's document, not a hand-written detector fixture.
const hosted = buildHostedSignupDocument(sources).html;
const signup = READ_ONLY_CHECKS.find(check => check.name === 'signup starts at create_account');
const state = status => ({ status, text: JSON.stringify({ state: { status: 'create_account' } }) });
const check = (html, legacyStatus, externalStatus) => signup.check([{ status: 200, text: html }, state(legacyStatus), state(externalStatus)]);
test('generated hosted signup accepts healthy default legacy with inactive external', () => {
    expect(hosted).toContain("customerTransport: 'external'");
    expect(check(hosted, 200, 410)).toBeNull();
});
test('generated hosted signup cannot hide broken default legacy behind healthy external', () => {
    expect(check(hosted, 503, 200)).toBe('/api/customer-signup/state: expected create_account, got HTTP 503');
});
test.each([
    ['legacy', legacy, 200, 410, null],
    ['legacy', legacy, 503, 200, '/api/customer-signup/state: expected create_account, got HTTP 503'],
    ['external', external, 410, 200, null],
    ['external', external, 200, 503, '/api/external-customer-signup/state: expected create_account, got HTTP 503']
])('generated server-selected %s follows only its selected endpoint', (_, html, a, b, expected) => {
    expect(check(html, a, b)).toBe(expected);
});
test.each([
    ['unavailable', buildSignupUnavailableDocument()],
    ['empty', '<html></html>'],
    ['two independent bootstraps', legacy + external],
    ['changed hosted default', hosted.replace("if (providers[0] === 'external')", "if (providers[0] === 'legacy')")],
    ['missing legacy bootstrap', hosted.replace('createSignupClient({ fetch: window.fetch.bind(window),\ncreateAccount:', 'unrecognisedLegacyBootstrap:')]
])('unrecognised %s fails closed even when both endpoints are healthy', (_, html) => {
    expect(check(html, 200, 200)).toBe('signup provider selection unavailable');
});

// Smoke is independent of visual copy, classes and arrows.
const visualGateway = '<html><body data-page="dashboard-home"><h1 id="home-title">Clearer IT.<br><em>Confident<br>next steps.</em></h1>' +
    '<a class="button homepage-primary" href="/login?intent=create">Create account <span aria-hidden="true">→</span></a>' +
    '<a class="homepage-login" href="/login?intent=login">Log in</a></body></html>';
test.each(['current public', 'earlier counterpart', 'simplified'])('full read-only smoke accepts %s visual copy', async copy => {
    const simplified = copy === 'simplified';
    const sha = 'a'.repeat(40), calls = [];
    const html = simplified ? hosted.replace(/Opening your account/g, 'Welcome').replace(/Checking your sign-in and workspace access…/g, '') : hosted;
    const gateway = simplified ? visualGateway.replace('Create account', 'Sign up').replace('→', '')
        : copy === 'earlier counterpart' ? visualGateway.replace('Clearer IT.<br><em>Confident<br>next steps.</em>', 'Your risk <br><em>posture on <br>a page.</em>') : visualGateway;
    const report = await runSmoke({ baseUrl: 'https://example.invalid', expectSha: sha, fetchImpl: async (url, init) => {
        calls.push({ path: url.pathname, init });
        const path = url.pathname;
        if (path === '/signup' || path === '/login' || path === '/dashboard') return new Response(path === '/dashboard' ? gateway : path === '/login' ? login : html,
            { headers: { 'content-type': 'text/html' } });
        if (path === '/api/health' || path === '/release.json') return new Response(JSON.stringify({ status: 'ok', releaseSha: sha }));
        if (path === '/api/customer-signup/state') return new Response(state(200).text);
        if (path === '/api/external-customer-signup/state') return new Response('{}', { status: 410 });
        if (path.includes('organisation-setup/state')) return new Response(JSON.stringify({ state: 'start' }), { headers: { 'content-type': 'application/json', 'x-nofries-customer-entry': 'legacy' } });
        if (path === '/api/dashboard/login') return new Response(null, { status: 302, headers: { location: '/login' } });
        return new Response('{}', { status: 401 });
    } });
    expect(report).toMatchObject({ ok: true, readOnly: true });
    expect(formatReport(report)).toContain('PASS post-release smoke: 11/11 checks passed.');
    expect(calls.map(call => call.path).sort()).toEqual([...READ_ONLY_PATHS].sort());
    for (const { path, init } of calls) {
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
        expect(init.body).toBeUndefined(); expect(init.headers).toEqual({ Accept: 'application/json, text/html', ...(path === '/api/organisation-setup/state' ? { 'X-NoFries-Customer-Entry': 'auto' } : {}) });
    }
});
const login = read('../login.html'), externalLogin = login.replace('<body ', '<body data-customer-provider="external" ');
const setup = READ_ONLY_CHECKS.find(c => c.name === 'organisation setup is available');
test.each([
    ['automatic legacy', login, 200, 'legacy', 503, 200, 503, true],
    ['broken selected legacy', login, 503, 'legacy', 200, 200, 200, false],
    ['missing automatic selection', login, 200, '', 200, 200, 200, false],
    ['automatic external handoff', login, 200, 'external', 503, 503, 200, true],
    ['broken external handoff', login, 200, 'external', 200, 200, 503, false],
    ['explicit external', externalLogin, 503, '', 200, 503, 200, true],
    ['broken selected external', externalLogin, 200, 'legacy', 503, 200, 200, false],
    ['legacy signup fallback', legacy, 503, '', 503, 200, 503, true],
    ['external signup fallback', external, 503, '', 503, 503, 200, true],
    ['unknown login', '<html></html>', 200, 'legacy', 200, 200, 200, false]
])('login follows %s without an inactive provider masking failure', (_, html, a, entry, b, c, d, ok) => {
    const setupState = status => ({ status, entry, type: 'application/json', text: '{"state":"start"}' });
    expect(setup.check([{ status: 200, text: html }, setupState(a), setupState(b), state(c), state(d)]) === null).toBe(ok);
});
