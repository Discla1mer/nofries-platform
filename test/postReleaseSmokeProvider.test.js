'use strict';
const fs = require('node:fs');
const { READ_ONLY_CHECKS, READ_ONLY_PATHS, runSmoke, formatReport } = require('../scripts/post-release-smoke');
const { buildSignupDocument, buildHostedSignupDocument, buildSignupUnavailableDocument } = require('../lib/signupDocument');
const { withHashBoundSharedAssistantDocument } = require('../lib/withHashBoundSharedAssistantDocument');
const read = path => fs.readFileSync(require.resolve(path), 'utf8');
const sources = { clientSource: read('../api/shared/customerSignup/signupClient.js'),
    journeySource: read('../api/shared/customerSignup/signupJourney.js') };
const legacy = buildSignupDocument({ ...sources, customerLogin: true }).html;
const external = buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' }).html;
// Use the real static builder's document + assistant composition, not a hand-written detector fixture.
const hosted = withHashBoundSharedAssistantDocument(buildHostedSignupDocument(sources), {
    prospectSource: read('../js/prospect-assistant.js'), sharedSource: read('../js/shared-assistant.js') }).html;
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
        if (path === '/signup' || path === '/login' || path === '/dashboard') return new Response(path === '/dashboard' ? gateway : html,
            { headers: { 'content-type': 'text/html' } });
        if (path === '/api/health' || path === '/release.json') return new Response(JSON.stringify({ status: 'ok', releaseSha: sha }));
        if (path === '/api/customer-signup/state') return new Response(state(200).text);
        if (path === '/api/external-customer-signup/state') return new Response('{}', { status: 410 });
        if (path.includes('organisation-setup/state')) return new Response(JSON.stringify({ state: 'start' }));
        if (path === '/api/dashboard/login') return new Response(null, { status: 302, headers: { location: '/login' } });
        return new Response('{}', { status: 401 });
    } });
    expect(report).toMatchObject({ ok: true, readOnly: true });
    expect(formatReport(report)).toContain('PASS post-release smoke: 11/11 checks passed.');
    expect(calls.map(call => call.path).sort()).toEqual([...READ_ONLY_PATHS].sort());
    for (const { init } of calls) {
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
        expect(init.body).toBeUndefined(); expect(Object.keys(init.headers)).toEqual(['Accept']);
    }
});
