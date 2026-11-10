'use strict';

// A-001: a returning customer's first sign-in attempt showed "Signup is
// unavailable (NF-SIGNUP-UNCONFIRMED)" and could leave the "Opening your
// account" placeholder on screen. Synthetic data only; no hosted identity.
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const request = require('supertest');
const { createDom } = require('./fixtures/dashboardDom');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');

const STATE = '/api/external-customer-signup/state';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
let warn;
beforeEach(() => { resetAbuseProtectionForTests(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); jest.useRealTimers(); });

describe('root cause: a returning session pinned to an older authority revision', () => {
    async function returningCustomer() {
        const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
            configureExternal({ dependencies, state }) { dependencies.clock = () => new Date(state.now).toISOString(); } });
        const provisional = await h.loginExternal();
        const setup = await request(h.app).get(STATE).set('Cookie', provisional.cookie);
        expect(setup.body.state.status).toBe('setup_details');
        const saved = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
            .set('Cookie', provisional.cookie).set('X-CSRF-Token', setup.body.csrfToken).send({ accountType: 'company',
                organisationName: 'Synthetic returning company', details: { name: 'Synthetic representative', role: 'Owner',
                    address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
        expect(saved.body.state).toEqual({ status: 'continue_authentication' });
        // Returning sign-in: authority now exists, so this session is pinned
        // to its current revision (not a provisional setup session).
        const returning = await h.loginExternal();
        expect(returning.response.status).toBe(303);
        const records = h.getContainer('external-starter-authority').records;
        const [key, bytes] = [...records].find(([name]) => name.startsWith('customer-subjects/'));
        const auth = h.getContainer('nofries-browser-auth').records;
        const sid = 'browser-auth/sessions/' + crypto.createHash('sha256')
            .update(returning.cookie.split(';')[0].split('=')[1]).digest('hex') + '.json';
        expect(JSON.parse(auth.get(sid)).customerAssurance.revision).toBe(JSON.parse(bytes).revision);
        const change = mutate => { const next = JSON.parse(bytes); mutate(next); records.set(key, Buffer.from(JSON.stringify(next))); };
        return { h, cookie: returning.cookie, change, sessionExists: () => auth.has(sid) };
    }
    const state = (h, cookie) => request(h.app).get(STATE).set('Cookie', cookie);

    test('an ordinary authority update since the last sign-in asks for a fresh sign-in, not "signup is unavailable"', async () => {
        const { h, cookie, change, sessionExists } = await returningCustomer();
        change(next => { next.revision++; });
        const first = await state(h, cookie);
        // Before the fix this was 503 signup_unavailable (NF-SIGNUP-UNCONFIRMED)
        // while the server had already deleted the session, so only the second
        // attempt reached sign-in. Now the first attempt says so directly.
        expect(first.status).toBe(401);
        expect(first.body).toEqual({ error: 'Signup is unavailable', code: 'signup_signin_required' });
        expect(first.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-external-customer=; .*Max-Age=0/)]);
        expect(first.headers['set-cookie'][0]).toContain('HttpOnly'); expect(first.headers['set-cookie'][0]).toContain('Secure');
        expect(sessionExists()).toBe(false);
        // The fresh sign-in reruns the full policy and is not denied as stale.
        const fresh = await h.loginExternal();
        expect(fresh.response.status).toBe(303);
        expect((await state(h, fresh.cookie)).status).not.toBe(401);
    });

    test.each([
        ['revoked', next => { next.status = 'revoked'; }],
        ['re-addressed', next => { next.revision++; next.email = 'different-synthetic@example.test'; }]
    ])('a %s account keeps its fail-closed unavailable response and grants nothing', async (_, mutate) => {
        const { h, cookie, change } = await returningCustomer();
        change(mutate);
        const denied = await state(h, cookie);
        expect(denied.status).toBe(503);
        expect(denied.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
        expect(denied.headers['set-cookie']).toBeUndefined();
    });
});

describe('journey: opening failure is a sign-in error with a working retry', () => {
    function mount(load, options = { customerTransport: 'external' }) {
        const dom = createDom(), create = dom.document.createElement;
        dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
        const client = { load: jest.fn(load), createAccount: jest.fn(), acceptTerms: jest.fn(), completeSetup: jest.fn() };
        return { ...dom, client, view: mountSignupJourney(dom.root, client, options) };
    }
    const buttons = f => f.root.querySelectorAll('button').map(node => node.textContent);

    test('a failed first read shows the returning-user message, not the signup verdict, and Try again re-reads state', async () => {
        let attempt = 0;
        const f = mount(async () => { if (++attempt === 1) throw new Error('synthetic-private-failure'); return { status: 'signin_required' }; });
        try {
            await f.view.ready;
            expect(f.root.querySelector('h1').textContent).toBe('We could not open your account');
            expect(f.root.textContent).toContain('Error code: NF-SIGNIN-UNCONFIRMED');
            expect(f.root.textContent).toContain('You do not need to sign up again.');
            expect(f.root.textContent).not.toMatch(/Signup is unavailable|NF-SIGNUP-UNCONFIRMED|synthetic-private/);
            expect(buttons(f)).toEqual(['Try again']);
            expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual(expect.arrayContaining([
                '/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose']));
            expect(f.root.getAttribute('aria-busy')).toBe('false'); expect(f.document.activeElement.tagName).toBe('H1');
            f.root.querySelector('button').click(); await flush();
            expect(f.client.load).toHaveBeenCalledTimes(2);
            expect(f.root.querySelector('h1').textContent).toBe('Sign in again');
            expect(f.client.createAccount).not.toHaveBeenCalled();
        } finally { f.view.dispose(); }
    });

    test('a retry that fails again keeps the retry available', async () => {
        const f = mount(async () => { throw new Error('synthetic'); });
        try {
            await f.view.ready;
            f.root.querySelector('button').click(); await flush();
            expect(f.client.load).toHaveBeenCalledTimes(2);
            expect(f.root.querySelector('h1').textContent).toBe('We could not open your account');
            expect(buttons(f)).toEqual(['Try again']); expect(f.root.querySelector('button').disabled).toBeFalsy();
        } finally { f.view.dispose(); }
    });

    test('a first read that never answers ends at the bound in the error state, with retry', async () => {
        jest.useFakeTimers();
        const f = mount(() => new Promise(() => {}));
        try {
            expect(f.root.getAttribute('aria-busy')).toBe('true');
            await jest.advanceTimersByTimeAsync(30000); await f.view.ready;
            expect(f.root.querySelector('h1').textContent).toBe('We could not open your account');
            expect(f.root.getAttribute('aria-busy')).toBe('false'); expect(buttons(f)).toEqual(['Try again']);
        } finally { f.view.dispose(); }
    });

    test('signup-unavailable stays a separate path: explicit server state and later failures keep NF-SIGNUP-UNCONFIRMED', async () => {
        const explicit = mount(async () => ({ status: 'unavailable' }));
        try {
            await explicit.view.ready;
            expect(explicit.root.querySelector('h1').textContent).toBe('Signup is unavailable');
            expect(explicit.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
            expect(explicit.root.textContent).not.toContain('NF-SIGNIN-UNCONFIRMED');
        } finally { explicit.view.dispose(); }
        let attempt = 0;
        const later = mount(async () => { if (++attempt === 1) return { status: 'pending_admission' }; throw new Error('synthetic'); });
        try {
            await later.view.ready;
            later.root.querySelector('button').click(); await flush();
            expect(later.root.querySelector('h1').textContent).toBe('Signup is unavailable');
            expect(later.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        } finally { later.view.dispose(); }
    });

    test('the real client maps a 503 opening read to the sign-in error', async () => {
        const fetch = jest.fn(async () => new Response(JSON.stringify({ error: 'Signup is unavailable', code: 'signup_unavailable' }),
            { status: 503, headers: { 'content-type': 'application/json' } }));
        const client = createSignupClient({ fetch, createAccount: jest.fn(), customerTransport: 'external' });
        const dom = createDom(), create = dom.document.createElement;
        dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
        const view = mountSignupJourney(dom.root, client, { customerTransport: 'external', entryIntent: 'login' });
        try {
            await view.ready;
            expect(dom.root.querySelector('h1').textContent).toBe('We could not open your account');
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally { view.dispose(); client.dispose(); }
    });
});

describe('document: the opening placeholder always ends', () => {
    const clientSource = fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8');
    // A view that never renders stands in for any script path that fails to
    // replace the placeholder (stalled navigation, a hung mount, etc).
    const stalledView = "module.exports = { mountSignupJourney: () => ({ ready: new Promise(() => {}), dispose() {} }) };";
    // The heading the served document shows while opening (from #154).
    const OPENING = /<h1>([^<]+)<\/h1>/.exec(buildSignupDocument({ clientSource, journeySource: stalledView, customerLogin: true, customerTransport: 'external' }).html)[1];
    test('the backstop recognises the served opening heading', () => {
        expect(OPENING).toBe('Signing you in');
        expect(buildHostedSignupDocument({ clientSource, journeySource: stalledView }).html).toContain(`<h1>${OPENING}</h1>`);
    });
    function run(runtime) {
        const dom = createDom(), create = dom.document.createElement;
        dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
        const placeholder = dom.document.createElement('h1'); placeholder.textContent = OPENING;
        dom.root.append(placeholder);
        dom.document.getElementById = id => id === 'signup' ? dom.root : null;
        const listeners = {}, reload = jest.fn();
        const window = { fetch: jest.fn(() => new Promise(() => {})), location: { search: '?provider=external', hash: '', assign: jest.fn(), replace: jest.fn(), reload },
            history: { replaceState: jest.fn() }, addEventListener(name, fn) { listeners[name] = fn; } };
        vm.runInNewContext(runtime, { document: dom.document, window, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout });
        return { ...dom, reload, listeners };
    }
    const runtimes = () => [
        ['dynamic', buildSignupDocument({ clientSource, journeySource: stalledView, customerLogin: true, customerTransport: 'external' }).runtime],
        ['hosted', buildHostedSignupDocument({ clientSource, journeySource: stalledView }).runtime]
    ];

    test.each([0, 1])('a stalled opening is replaced by an error with Try again (%#)', async index => {
        jest.useFakeTimers();
        const page = run(runtimes()[index][1]);
        await jest.advanceTimersByTimeAsync(44999);
        expect(page.root.querySelector('h1').textContent).toBe(OPENING);
        await jest.advanceTimersByTimeAsync(1);
        expect(page.root.querySelector('h1').textContent).toBe('We could not open your account');
        expect(page.root.textContent).toContain('Error code: NF-SIGNIN-UNCONFIRMED');
        expect(page.root.textContent).not.toContain('Signup is unavailable');
        const retry = page.root.querySelector('button');
        expect(retry.textContent).toBe('Try again');
        expect(page.root.querySelector('a').href).toBe('/api/external-customer-auth/login');
        retry.click(); expect(page.reload).toHaveBeenCalledTimes(1);
    });

    test('leaving the page stops the backstop, and a back/forward-cache restore re-checks state', async () => {
        jest.useFakeTimers();
        const page = run(runtimes()[0][1]);
        page.listeners.pagehide();
        await jest.advanceTimersByTimeAsync(60000);
        expect(page.root.querySelector('h1').textContent).toBe(OPENING);
        page.listeners.pageshow({ persisted: false }); expect(page.reload).not.toHaveBeenCalled();
        page.listeners.pageshow({ persisted: true }); expect(page.reload).toHaveBeenCalledTimes(1);
    });

    test('a rendered view is never overwritten by the backstop', async () => {
        jest.useFakeTimers();
        const journeySource = fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8');
        const runtime = buildSignupDocument({ clientSource, journeySource, customerLogin: true, customerTransport: 'external' }).runtime;
        const page = run(runtime);
        await jest.advanceTimersByTimeAsync(30000);
        expect(page.root.querySelector('h1').textContent).toBe('We could not open your account');
        expect(page.root.querySelector('button').textContent).toBe('Try again');
        await jest.advanceTimersByTimeAsync(30000);
        expect(page.root.querySelectorAll('h1')).toHaveLength(1);
        expect(page.reload).not.toHaveBeenCalled();
    });
});
