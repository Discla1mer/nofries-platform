'use strict';

// Actual HTTP/composition and emitted-document contracts with synthetic provider,
// Blob and SQL ports. These tests do not establish live CIAM account selection.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createDom } = require('./fixtures/dashboardDom');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const LOGOUT = '/api/external-customer-auth/logout';
const CHOOSE = '/signup?provider=external&account=choose';
const LOGIN = '/api/external-customer-auth/login';
const PRIVATE = 'synthetic-private-error-must-not-escape';
const cookie = value => value.split(';')[0];
const cookieId = value => cookie(value).slice(cookie(value).indexOf('=') + 1);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const authKey = (kind, value) => `browser-auth/${kind}/${digest(cookieId(value))}.json`;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const sources = () => ({ clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
    journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8') });
let warn;
beforeEach(() => { resetAbuseProtectionForTests(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function fixture() {
    let authUrl, exchange;
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ dependencies, state }) {
            dependencies.clock = () => new Date(state.now).toISOString();
            let serial = 0;
            dependencies.cryptoProvider.generatePkceCodes = async () => {
                const verifier = String(++serial).padEnd(64, 'v');
                return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
            };
            const client = dependencies.externalCustomer.client.clientApplication;
            authUrl = jest.fn(async input => {
                const url = new URL(dependencies.externalCustomer.identityProvider.authorizationEndpoint);
                for (const [key, value] of Object.entries({ client_id: uid(102), redirect_uri: input.redirectUri,
                    response_mode: input.responseMode, state: input.state, nonce: input.nonce,
                    code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod,
                    ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.loginHint ? { login_hint: input.loginHint } : {}) })) {
                    url.searchParams.set(key, value);
                }
                return url.href;
            });
            client.getAuthCodeUrl = authUrl;
            exchange = jest.spyOn(client, 'acquireTokenByCode');
        } });
    return Object.assign(h, { authUrl, exchange });
}

function preserved(h, includeSessionProofs = true) {
    return JSON.stringify({ stores: [...h.state.containers].filter(([key]) => !key.endsWith('/nofries-browser-auth') &&
        (includeSessionProofs || !key.endsWith('/dashboard-proofs')))
        .map(([key, store]) => [key, [...store.records].map(([name, bytes]) => [name, digest(bytes)])]),
    registrations: [...h.pool.registrations], receipts: [...h.pool.receipts] });
}
async function setupSession(h) {
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    expect(login.response.headers['set-cookie'].filter(value => value.startsWith('__Host-nofries-external-customer-tx=')))
        .toEqual([expect.stringContaining('Max-Age=0')]);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
    expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
    return { ...login, state };
}
async function saveSetup(h, session) {
    const response = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', session.cookie).set('X-CSRF-Token', session.state.body.csrfToken).send({ accountType: 'consultant',
            organisationName: 'Synthetic retained consultancy', details: { name: 'Synthetic person', role: 'Owner',
                address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
    expect(response.body.state).toEqual({ status: 'continue_authentication' });
    return response;
}
const postLogout = (h, cookies) => h.sameOrigin(request(h.app).post(LOGOUT)).set('Cookie', cookies).type('form').send({});

function documentView(document, { search = '?provider=external', state = { status: 'create_account' }, fetch } = {}) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const assign = jest.fn(), replace = jest.fn(), listeners = {};
    fetch ||= jest.fn(async () => new Response(JSON.stringify({ state, csrfToken: 'x'.repeat(43) }), {
        status: 200, headers: { 'content-type': 'application/json' } }));
    vm.runInNewContext(document.runtime, { document: dom.document,
        window: { fetch, location: { search, hash: '', assign, replace }, addEventListener(name, fn) { listeners[name] = fn; } },
        URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout });
    return { ...dom, fetch, assign, replace, dispose() { listeners.pagehide?.(); } };
}

test('the visible setup form posts through production logout, preserving saved setup, SQL receipts and another session', async () => {
    const h = fixture(), legacyUser = h.addUser(), legacy = await h.login(legacyUser);
    expect((await h.consent(legacy.cookie)).response.status).toBe(200);
    const session = await setupSession(h);
    const fetch = jest.fn(async (url, options) => {
        const result = await request(h.app).get(url).set(options.headers).set('Cookie', session.cookie);
        return new Response(result.text, { status: result.status, headers: result.headers });
    });
    const page = documentView(buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' }), { fetch });
    let form;
    try {
        await flush(); expect(page.root.textContent).toContain('Signed in as ' + h.state.externalEmail);
        const forms = page.root.querySelectorAll('form'); expect(forms).toHaveLength(2);
        form = forms.find(value => value.action === LOGOUT);
        expect(form).toBeDefined(); expect(form.method).toBe('post'); expect(form.parentElement).toBe(page.root);
        expect(forms.every(value => value.querySelectorAll('form').length === 0)).toBe(true);
        expect(form.querySelector('button').textContent).toBe('Sign out and change account');
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
    } finally { page.dispose(); }
    await saveSetup(h, session); // Keep the original provisional parent, not an admitted session.
    const authority = h.getContainer('external-starter-authority').records;
    expect([...authority.keys()].some(key => key.includes('/starter-setups/'))).toBe(true);
    expect([...authority.keys()].some(key => key.startsWith('customer-subjects/'))).toBe(true);
    expect(h.pool.receipts.size).toBeGreaterThan(0); expect(h.pool.registrations.size).toBeGreaterThan(0);
    const started = await request(h.app).get(LOGIN).set('Cookie', session.cookie);
    expect(started.status).toBe(302); const tx = cookie(started.headers['set-cookie'][0]);
    const auth = h.getContainer('nofries-browser-auth').records;
    const externalKey = authKey('sessions', session.cookie), txKey = authKey('transactions', tx);
    expect(JSON.parse(auth.get(externalKey)).customerAssurance.stage).toBe('setup');
    const retained = preserved(h), other = [...auth].filter(([key]) => ![externalKey, txKey].includes(key))
        .map(([key, bytes]) => [key, digest(bytes)]);
    const response = await h.sameOrigin(request(h.app).post(form.action)).set('Cookie', `${session.cookie}; ${tx}; ${legacy.cookie}`).type('form').send({});
    expect(response.status).toBe(303); expect(response.headers.location).toBe(CHOOSE);
    expect(response.headers['set-cookie']).toHaveLength(2);
    expect(response.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=;/);
    expect(response.headers['set-cookie'][1]).toMatch(/^__Host-nofries-external-customer-tx=;/);
    for (const value of response.headers['set-cookie']) expect(value).toContain('Max-Age=0');
    expect(auth.has(externalKey)).toBe(false); expect(auth.has(txKey)).toBe(false);
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(other); expect(preserved(h)).toBe(retained);
    h.exchange.mockClear();
    const replay = await request(h.app).post('/api/external-customer-auth/callback').set('Cookie', tx)
        .set('Accept', 'text/html').type('form').send({ state: new URL(started.headers.location).searchParams.get('state'), code: PRIVATE });
    expect(replay.status).toBe(303); expect(replay.headers.location).toBe('/login?signin=retry&provider=external');
    expect(h.exchange).not.toHaveBeenCalled(); expect(preserved(h)).toBe(retained);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
});

test.each([
    ['foreign origin', { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' }],
    ['same origin but cross-site', { Origin: 'https://nofries.nz', 'Sec-Fetch-Site': 'cross-site' }],
    ['missing origin and site', {}]
])('%s cannot end a provisional session', async (_label, headers) => {
    const h = fixture(), session = await setupSession(h), auth = h.getContainer('nofries-browser-auth').records;
    const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]);
    const response = await request(h.app).post(LOGOUT).set(headers).set('Cookie', session.cookie).type('form').send({});
    expect(response.status).toBe(403); expect(response.body.code).toBe('same_origin_required');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before);
});

test.each(['get', 'put'])('%s is not a logout or account-selection mutation', async method => {
    const h = fixture(), session = await setupSession(h), retained = preserved(h);
    const before = [...h.getContainer('nofries-browser-auth').records].map(([key, bytes]) => [key, digest(bytes)]);
    const response = await request(h.app)[method](LOGOUT).set('Cookie', session.cookie);
    expect(response.status).toBe(410); expect(response.headers['set-cookie']).toBeUndefined();
    expect(preserved(h)).toBe(retained);
    expect([...h.getContainer('nofries-browser-auth').records].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before);
});

test('an unconfigured external provider does not install setup logout', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now(), customerClientId: uid(105) });
    const response = await h.sameOrigin(request(h.app).post(LOGOUT)).type('form').send({});
    expect(response.status).toBe(410); expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
});

test('a non-provisional external parent cannot use setup logout to bypass dashboard revocation', async () => {
    const h = fixture(), provisional = await setupSession(h); await saveSetup(h, provisional);
    const established = await h.loginExternal(); expect(established.response.status).toBe(303);
    const started = await request(h.app).get(LOGIN).set('Cookie', established.cookie); expect(started.status).toBe(302);
    const tx = cookie(started.headers['set-cookie'][0]), auth = h.getContainer('nofries-browser-auth').records;
    expect(JSON.parse(auth.get(authKey('sessions', established.cookie))).customerAssurance.stage).toBeUndefined();
    const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]), retained = preserved(h);
    const response = await postLogout(h, `${established.cookie}; ${tx}`);
    expect(response.status).toBe(401); expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before); expect(preserved(h)).toBe(retained);
});

test('a storage failure withholds logout acknowledgement without exposing its error', async () => {
    const h = fixture(), session = await setupSession(h), auth = h.getContainer('nofries-browser-auth');
    const target = authKey('sessions', session.cookie), retained = preserved(h), before = digest(auth.records.get(target));
    const original = auth.getBlockBlobClient;
    auth.getBlockBlobClient = key => key === target ? { download: async () => { throw new Error(PRIVATE); } } : original(key);
    const response = await postLogout(h, session.cookie);
    expect(response.status).toBe(503); expect(response.body.code).toBe('browser_auth_unavailable');
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE); expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
    expect(digest(auth.records.get(target))).toBe(before); expect(preserved(h)).toBe(retained);
});

test.each(['application/json', 'text/html'])('a genuinely pending callback prevents false setup logout acknowledgement for %s', async accept => {
    const h = fixture(), session = await setupSession(h), auth = h.getContainer('nofries-browser-auth').records;
    const started = await request(h.app).get(LOGIN).set('Cookie', session.cookie); expect(started.status).toBe(302);
    const tx = cookie(started.headers['set-cookie'][0]), sidKey = authKey('sessions', session.cookie), txKey = authKey('transactions', tx);
    const parent = Buffer.from(auth.get(sidKey)), retained = preserved(h), customerData = preserved(h, false);
    const proofs = [...h.getContainer('dashboard-proofs').records].map(([key, bytes]) => [key, digest(bytes)]);
    const original = h.exchange.getMockImplementation();
    let input, resume, entered;
    const exchanging = new Promise(resolve => { entered = resolve; });
    h.exchange.mockImplementation(value => { input = value; entered(); return new Promise(resolve => { resume = resolve; }); });
    const callback = request(h.app).post('/api/external-customer-auth/callback').set('Cookie', tx)
        .set('Accept', 'text/html').type('form').send({ state: new URL(started.headers.location).searchParams.get('state'), code: PRIVATE })
        .then(value => value);
    try {
        await exchanging; expect(auth.has(txKey)).toBe(false); // Real callback consumed it before awaiting provider redemption.
        const response = await postLogout(h, `${session.cookie}; ${tx}`).set('Accept', accept);
        expect(response.status).toBe(503); expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).toBeUndefined();
        expect(auth.get(sidKey).equals(parent)).toBe(true); expect(preserved(h)).toBe(retained);
        if (accept === 'text/html') {
            expect(response.headers['content-type']).toMatch(/^text\/html/);
            expect(response.text).toContain('Sign-out was not confirmed'); expect(response.text).toContain('may still finish');
            expect(response.text).toContain('href="/signup?provider=external"');
            expect(response.headers['content-security-policy']).toBeDefined(); expect(response.text).not.toContain(PRIVATE);
        } else expect(response.body.code).toBe('browser_auth_unavailable');
        expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
    } finally { resume(await original(input)); }
    expect((await callback).status).toBe(303); expect(auth.get(sidKey).equals(parent)).toBe(true);
    // The already-running callback may issue its own new session/proof. It must
    // preserve previous proofs and customer data; logout never claimed success.
    expect(preserved(h, false)).toBe(customerData);
    expect([...h.getContainer('dashboard-proofs').records].map(([key, bytes]) => [key, digest(bytes)]))
        .toEqual(expect.arrayContaining(proofs));
});

test.each(['dynamic', 'hosted'])('%s choose-account marker performs one state read and requires a manual fixed login action', async kind => {
    const document = kind === 'hosted' ? buildHostedSignupDocument(sources())
        : buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
    const page = documentView(document, { search: '?provider=external&account=choose&code=' + PRIVATE });
    try {
        await flush(); expect(page.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(page.root.querySelector('h1').textContent).toBe('Choose your account');
        expect(page.root.textContent).not.toContain(PRIVATE); expect(page.root.querySelectorAll('form')).toHaveLength(0);
        expect(document.contentSecurityPolicy).toContain(`'sha256-${crypto.createHash('sha256').update(document.runtime).digest('base64')}'`);
        expect(document.contentSecurityPolicy).not.toContain('unsafe-inline');
        page.root.querySelector('button').click();
        expect(page.assign).toHaveBeenCalledTimes(1); expect(page.assign).toHaveBeenCalledWith(LOGIN + '?account=choose');
        expect(page.fetch).toHaveBeenCalledTimes(1);
    } finally { page.dispose(); }
});

test.each(['?provider=external&account=choose&account=choose', '?provider=external&account=choose&account=other',
    '?provider=external&account=other', '?provider=external&account=https%3A%2F%2Funtrusted.invalid', '?provider=legacy&account=choose'])
('untrusted or legacy marker %s never selects an external account', async search => {
    const page = documentView(buildHostedSignupDocument(sources()), { search });
    try {
        await flush(); expect(page.root.querySelector('h1').textContent).toBe('Sign up / Sign in');
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(page.fetch.mock.calls.map(([url]) => url)).toEqual([search.includes('legacy') ? '/api/customer-signup/state' : '/api/external-customer-signup/state']);
        page.root.querySelector('button').click();
        expect(page.assign).toHaveBeenCalledWith(search.includes('legacy') ? '/api/customer-auth/login' : LOGIN);
    } finally { page.dispose(); }
});

test.each(['setup_details', 'continue_authentication'])('a forged choose marker preserves authoritative %s and never posts logout', async status => {
    const page = documentView(buildHostedSignupDocument(sources()), { search: '?provider=external&account=choose',
        state: { status, ...(status === 'setup_details' ? { email: 'synthetic@example.test' } : {}) } });
    try {
        await flush(); expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(page.root.querySelector('h1').textContent).toBe(status === 'setup_details' ? 'Set up your workspace' : 'Continuing account setup');
        const forms = page.root.querySelectorAll('form'), logout = forms.find(form => form.action === LOGOUT);
        expect(logout).toBeDefined(); expect(logout.method).toBe('post'); expect(logout.parentElement).toBe(page.root);
        expect(forms.every(form => form.querySelectorAll('form').length === 0)).toBe(true);
        expect(page.fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([['/api/external-customer-signup/state', 'GET']]);
    } finally { page.dispose(); }
});

test('the native logout submit is disabled while another setup mutation awaits acknowledgement', async () => {
    const dom = createDom(); let settle;
    const completeSetup = jest.fn(() => new Promise(resolve => { settle = resolve; }));
    const client = { load: async () => ({ status: 'setup_details', email: 'synthetic@example.test' }), createAccount: jest.fn(),
        acceptTerms: jest.fn(), completeSetup };
    const view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
    try {
        await view.ready; const forms = dom.root.querySelectorAll('form'), setup = forms.find(form => !form.action);
        const logout = forms.find(form => form.action === LOGOUT); expect(logout.querySelector('button').disabled).toBeFalsy();
        setup.reportValidity = () => true; setup.querySelector('select').value = 'company';
        for (const input of setup.querySelectorAll('input')) { input.value = 'Synthetic value'; if (input.type === 'checkbox') input.checked = true; }
        for (const submit of setup.events.submit) submit({ preventDefault() {} });
        expect(completeSetup).toHaveBeenCalledTimes(1); expect(logout.querySelector('button').disabled).toBe(true);
        expect(dom.root.getAttribute('aria-busy')).toBe('true');
        settle({ status: 'continue_authentication' }); await flush();
        expect(dom.root.querySelector('form').action).toBe(LOGOUT); expect(dom.root.querySelector('form').querySelector('button').disabled).toBeFalsy();
    } finally { view.dispose(); }
});

test('the real choose login forwards prompt login without a hint and creates fresh state, nonce and PKCE', async () => {
    const h = fixture(), session = await setupSession(h); h.authUrl.mockClear(); h.exchange.mockClear();
    const auth = h.getContainer('nofries-browser-auth').records, sidKey = authKey('sessions', session.cookie), parent = Buffer.from(auth.get(sidKey));
    const old = await request(h.app).get(LOGIN).set('Cookie', session.cookie); expect(old.status).toBe(302);
    const oldInput = h.authUrl.mock.calls[0][0], before = preserved(h);
    const chosen = await request(h.app).get(LOGIN + '?account=choose').set('Cookie', session.cookie); expect(chosen.status).toBe(302);
    const input = h.authUrl.mock.calls[1][0], url = new URL(chosen.headers.location);
    expect(input.prompt).toBe('login'); expect(input.loginHint).toBeUndefined();
    expect(url.searchParams.getAll('prompt')).toEqual(['login']); expect(url.searchParams.has('login_hint')).toBe(false);
    for (const field of ['state', 'nonce', 'codeChallenge']) expect(input[field]).not.toBe(oldInput[field]);
    expect(input.redirectUri).toBe('https://nofries.nz/api/external-customer-auth/callback');
    expect(url.origin).toBe(new URL(old.headers.location).origin); expect(preserved(h)).toBe(before);
    const stored = JSON.parse(auth.get(authKey('transactions', cookie(chosen.headers['set-cookie'][0]))));
    expect(url.searchParams.get('code_challenge')).toBe(crypto.createHash('sha256').update(stored.codeVerifier).digest('base64url'));
    expect(auth.get(sidKey).equals(parent)).toBe(true);
    expect(h.exchange).not.toHaveBeenCalled();
});

test.each(['/api/customer-auth/login?account=choose', LOGIN + '?account=other', LOGIN + '?account=choose&account=choose',
    LOGIN + '?account=https%3A%2F%2Funtrusted.invalid'])('invalid account selection %s creates no external transaction', async route => {
    const h = fixture(), auth = h.getContainer('nofries-browser-auth').records;
    const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]);
    const response = await request(h.app).get(route).set('Accept', 'application/json');
    expect(response.status).toBe(400); expect(response.headers['set-cookie']).toBeUndefined();
    expect(h.authUrl).not.toHaveBeenCalled(); expect(h.exchange).not.toHaveBeenCalled();
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before);
});

test.each(['dynamic', 'hosted'])('a failed external account-choice start retains its validated marker through the %s manual retry page', async kind => {
    const h = fixture(), retained = preserved(h), auth = h.getContainer('nofries-browser-auth').records;
    const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]);
    h.authUrl.mockRejectedValueOnce(new Error(PRIVATE));
    const failed = await request(h.app).get(LOGIN + '?account=choose').set('Accept', 'text/html');
    expect(failed.status).toBe(303);
    expect(failed.headers.location).toBe('/login?signin=retry&provider=external&account=choose');
    expect(failed.headers['set-cookie']).toBeUndefined(); expect(h.exchange).not.toHaveBeenCalled();
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before); expect(preserved(h)).toBe(retained);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
    const replace = jest.fn();
    vm.runInNewContext(fs.readFileSync('js/organisation-setup.js', 'utf8'), {
        document: { getElementById: id => id === 'organisation-form' ? {} : null },
        window: { location: { search: new URL(failed.headers.location, h.env.NOFRIES_PUBLIC_URL).search, hash: '', replace } },
        URLSearchParams });
    expect(replace).toHaveBeenCalledWith('/signup?provider=external&signin=retry&account=choose');
    const fetch = jest.fn(async (url, options) => {
        const state = await request(h.app).get(url).set(options.headers);
        return new Response(state.text, { status: state.status, headers: state.headers });
    });
    const document = kind === 'hosted' ? buildHostedSignupDocument(sources())
        : buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
    const page = documentView(document, { search: new URL(replace.mock.calls[0][0], h.env.NOFRIES_PUBLIC_URL).search, fetch });
    try {
        await flush(); expect(page.root.querySelector('h1').textContent).toBe('Choose your account');
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
        page.root.querySelector('button').click(); expect(page.assign).toHaveBeenCalledWith(LOGIN + '?account=choose');
        const next = await request(h.app).get(page.assign.mock.calls[0][0]); expect(next.status).toBe(302);
        expect(new URL(next.headers.location).searchParams.getAll('prompt')).toEqual(['login']);
        expect(h.authUrl.mock.calls[1][0].loginHint).toBeUndefined(); expect(preserved(h)).toBe(retained);
    } finally { page.dispose(); }
});

test.each([
    ['/api/customer-auth/login?account=choose', 'legacy'],
    [LOGIN + '?account=other', 'external'],
    [LOGIN + '?account=choose&account=choose', 'external'],
    [LOGIN + '?account=https%3A%2F%2Funtrusted.invalid', 'external']
])('invalid HTML account marker %s cannot persist choice in a retry destination', async (route, provider) => {
    const h = fixture(), auth = h.getContainer('nofries-browser-auth').records;
    const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]);
    const response = await request(h.app).get(route).set('Accept', 'text/html');
    expect(response.status).toBe(303); expect(response.headers.location).toBe('/login?signin=retry&provider=' + provider);
    expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers.location).not.toMatch(/account=|untrusted/);
    expect(h.authUrl).not.toHaveBeenCalled(); expect(h.state.authRequests).toEqual([]);
    expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before);
});

test('the static login handoff carries only a single fixed account marker, without fetching or logging out', () => {
    const replace = jest.fn(), fetch = jest.fn();
    vm.runInNewContext(fs.readFileSync('js/organisation-setup.js', 'utf8'), {
        document: { getElementById: id => id === 'organisation-form' ? {} : null },
        window: { location: { search: '?provider=external&account=choose&returnTo=https%3A%2F%2Funtrusted.invalid', hash: '', replace } },
        URLSearchParams, fetch });
    expect(replace).toHaveBeenCalledWith(CHOOSE); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(replace.mock.calls)).not.toContain('untrusted');
});

describe('the setup form traverses the Static Web Apps routing boundary', () => {
    let configs, builtDocument, temporary;
    beforeAll(() => {
        const root = path.resolve(__dirname, '..');
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-account-change-static-'));
        // Reuse dashboardPackaging's isolated real-build fixture pattern. No
        // shared dist directory or source/configuration file is modified.
        const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
        for (const file of ['package.json', 'scripts/build-static.js', 'staticwebapp.config.json', ...PUBLIC_ROOT_FILES]) {
            fs.mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
            fs.copyFileSync(path.join(root, file), path.join(temporary, file));
        }
        for (const name of ['api', 'app', 'assets', 'images', 'js', 'lib', 'azure']) {
            fs.cpSync(path.join(root, name), path.join(temporary, name), { recursive: true,
                filter: source => !path.relative(root, source).split(path.sep).includes('node_modules') });
        }
        execFileSync(process.execPath, [path.join(temporary, 'scripts/build-static.js')], { cwd: temporary, stdio: 'pipe' });
        configs = {
            source: JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'))),
            example: JSON.parse(fs.readFileSync(path.join(root, 'azure/staticwebapp.config.example.json'))),
            built: JSON.parse(fs.readFileSync(path.join(temporary, 'dist/staticwebapp.config.json')))
        };
        const html = fs.readFileSync(path.join(temporary, 'dist/app/signup.html'), 'utf8');
        builtDocument = { runtime: html.match(/<script>([\s\S]*?)<\/script>/)[1] };
        expect(builtDocument.runtime).toBe(buildHostedSignupDocument(sources()).runtime);
    });
    afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
    // Same first-path-and-method/default-role semantics as the existing
    // externalHostedRouting helper; this is a source model, not an Azure probe.
    const matched = (config, method, url) => config.routes.find(route =>
        (route.route.endsWith('*') ? url.startsWith(route.route.slice(0, -1)) : route.route === url) &&
        (!route.methods || route.methods.includes(method)));
    const roles = route => route?.allowedRoles ?? ['anonymous'];
    function fronted(app, config, passed) {
        const edge = express();
        edge.use((req, res, next) => {
            const route = matched(config, req.method, req.path);
            // Only an application BFF cookie is supplied. No platform principal
            // or authenticated SWA role is manufactured from that cookie.
            if (!route || !roles(route).includes('anonymous')) return res.sendStatus(401);
            passed.push([req.method, req.path]); next();
        });
        edge.use(app); return edge;
    }

    test.each(['source', 'example', 'built'])('%s permits only the exact anonymous POST ahead of the protected catch-all', name => {
        const config = configs[name], rule = matched(config, 'POST', LOGOUT);
        expect(rule?.route).toBe(LOGOUT); expect(rule.methods).toEqual(['POST']); expect(roles(rule)).toEqual(['anonymous']);
        expect(rule.headers['Cache-Control']).toContain('no-store');
        expect(config.routes.indexOf(rule)).toBeLessThan(config.routes.findIndex(value => value.route === '/api/*'));
        const reference = matched(configs.source, 'POST', LOGOUT);
        expect(roles(rule)).toEqual(roles(reference)); expect(rule.methods).toEqual(reference.methods);
        const normalizedHeaders = headers => Object.fromEntries(Object.entries(headers).map(([key, value]) =>
            [key, value.replace(/([,;])\s+/g, '$1')]));
        const expectedHeaders = name === 'built' ? { ...reference.headers, 'Cache-Control': 'no-store' } : reference.headers;
        expect(normalizedHeaders(rule.headers)).toEqual(normalizedHeaders(expectedHeaders));
        for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
            expect(matched(config, method, LOGOUT)?.route).toBe('/api/*');
            expect(roles(matched(config, method, LOGOUT))).toEqual(['authenticated']);
        }
        for (const target of [LOGOUT + '/admin', LOGOUT + '-extra', LOGOUT + '/', '/api/private-account-change']) {
            expect(roles(matched(config, 'POST', target))).toEqual(['authenticated']);
        }
    });

    test('removing the exact route causally denies the real native form with401; the built rule reaches only the guarded303 logout', async () => {
        const h = fixture(), session = await setupSession(h), auth = h.getContainer('nofries-browser-auth').records;
        const started = await request(h.app).get(LOGIN).set('Cookie', session.cookie); expect(started.status).toBe(302);
        const tx = cookie(started.headers['set-cookie'][0]), cookies = `${session.cookie}; ${tx}`;
        const sidKey = authKey('sessions', session.cookie), txKey = authKey('transactions', tx), retained = preserved(h);
        const before = [...auth].map(([key, bytes]) => [key, digest(bytes)]), passed = [];
        const edge = fronted(h.app, configs.built, passed);
        const fetch = jest.fn(async (url, options) => {
            const response = await request(edge).get(url).set(options.headers).set('Cookie', session.cookie);
            return new Response(response.text, { status: response.status, headers: response.headers });
        });
        const page = documentView(builtDocument, { search: '?provider=external', fetch });
        let native;
        try {
            await Promise.all(page.fetch.mock.results.map(result => result.value)); await flush();
            native = page.root.querySelectorAll('form').find(form => form.action === LOGOUT);
            expect(native).toBeDefined(); expect(native.method).toBe('post');
            expect(native.querySelector('button').textContent).toBe('Sign out and change account');
            expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        } finally { page.dispose(); }
        const removed = { ...configs.built, routes: configs.built.routes.filter(rule => rule.route !== LOGOUT) }, blocked = [];
        const preFix = await h.sameOrigin(request(fronted(h.app, removed, blocked)).post(native.action))
            .set('Cookie', cookies).type('form').send({});
        expect(preFix.status).toBe(401); expect(blocked).toEqual([]); expect(preFix.headers['set-cookie']).toBeUndefined();
        expect([...auth].map(([key, bytes]) => [key, digest(bytes)])).toEqual(before); expect(preserved(h)).toBe(retained);
        const foreign = await request(edge).post(native.action).set('Origin', 'https://untrusted.invalid')
            .set('Sec-Fetch-Site', 'cross-site').set('Cookie', cookies).type('form').send({});
        expect(foreign.status).toBe(403); expect(foreign.body.code).toBe('same_origin_required');
        expect(foreign.headers['set-cookie']).toBeUndefined(); expect(preserved(h)).toBe(retained);
        for (const [method, target] of [['get', LOGOUT], ['delete', LOGOUT], ['post', LOGOUT + '/admin'], ['post', '/api/private-account-change']]) {
            const boundary = await request(edge)[method](target).set('Cookie', cookies);
            expect(boundary.status).toBe(401); expect(boundary.headers['set-cookie']).toBeUndefined();
        }
        const success = await h.sameOrigin(request(edge).post(native.action)).set('Cookie', cookies).type('form').send({});
        expect(success.status).toBe(303); expect(success.headers.location).toBe(CHOOSE);
        expect(success.headers['set-cookie']).toHaveLength(2);
        expect(success.headers['set-cookie'].map(value => value.split('=')[0]))
            .toEqual(['__Host-nofries-external-customer', '__Host-nofries-external-customer-tx']);
        for (const value of success.headers['set-cookie']) expect(value).toContain('Max-Age=0');
        expect(auth.has(sidKey)).toBe(false); expect(auth.has(txKey)).toBe(false);
        expect([...auth].map(([key, bytes]) => [key, digest(bytes)]))
            .toEqual(before.filter(([key]) => ![sidKey, txKey].includes(key)));
        expect(preserved(h)).toBe(retained);
        expect(passed).toEqual([['GET', '/api/external-customer-signup/state'], ['POST', LOGOUT], ['POST', LOGOUT]]);
    });
});
