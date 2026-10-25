'use strict';

// Source/synthetic recovery contracts only; no hosted identity or Azure calls.
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const request = require('supertest');
const { createDom } = require('./fixtures/dashboardDom');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createBrowserAuthService, BrowserAuthError, clearCustomerTransactionCookie,
    clearExternalCustomerTransactionCookie } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createAuthCallbackFunction } = require('../api/authCallback');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const PRIVATE = 'synthetic-private-provider-code';
const cookie = value => value.split(';')[0];
const cookieId = value => cookie(value).split('=')[1];
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const sources = () => ({ clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
    journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8') });
const terms = { status: 'terms', termsText: 'Synthetic retained agreement.', termsVersion: 'synthetic-v1', termsDigest: 'a'.repeat(64) };
let warning;
beforeEach(() => { resetAbuseProtectionForTests(); warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warning.mockRestore(); });

function authentication(external) {
    const tenant = uid(external ? 101 : 1), app = uid(external ? 102 : 2), subject = uid(3);
    const provider = { kind: 'external-id', tenantId: tenant, clientId: app,
        authority: 'https://synthetic-customer.ciamlogin.com/', issuer: `https://${tenant}.ciamlogin.com/${tenant}/v2.0`,
        authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${tenant}/oauth2/v2.0/authorize` };
    const env = { NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(2), NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-only',
        NOFRIES_ALLOWED_SUBJECTS: `${uid(1)}:${subject}`, ...(external ? {
            NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: app, NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-only' } : {}) };
    let now = NOW, serial = 0, pkce = 0;
    const store = new MemoryBrowserSessionStore(), exchange = jest.fn(async input => ({
        accessToken: PRIVATE, account: { localAccountId: subject }, idTokenClaims: {
            aud: app, tid: tenant, oid: subject, nonce: input.nonce, exp: Math.floor(now / 1000) + 3600,
            email: 'synthetic@example.test', iss: external ? provider.issuer : `https://login.microsoftonline.com/${tenant}/v2.0` } }));
    const service = createBrowserAuthService({ env, store, now: () => now,
        ...(external ? { customerIdentityProvider: provider, customerTransport: 'external' } : {}),
        customerPolicy: { begin: async () => ({ context: { synthetic: true } }),
            verify: async ({ identity }) => ({ expiresAt: now + 3600000, subjectKey: identity.subjectKey }), recheck: async () => {} },
        randomBytes: length => Buffer.alloc(length, ++serial),
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: String(++pkce).padEnd(64, 'v'),
            challenge: crypto.createHash('sha256').update(String(pkce)).digest('base64url') }) },
        clientApplication: { async getAuthCodeUrl(input) {
            const url = new URL(external ? provider.authorizationEndpoint : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
            for (const [key, value] of Object.entries({ client_id: app, redirect_uri: input.redirectUri,
                response_mode: input.responseMode, state: input.state, nonce: input.nonce,
                code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod })) url.searchParams.set(key, value);
            return url.href;
        }, acquireTokenByCode: exchange, getTokenCache: () => ({ removeAccount: async () => {} }) } });
    const handler = createAuthCallbackFunction({ env, service, customerEntry: true,
        clearTransactionCookie: external ? clearExternalCustomerTransactionCookie : clearCustomerTransactionCookie,
        ...(external ? { customerTransport: 'external' } : {}) });
    const invoke = async (started, { missingCookie = false, json = false } = {}) => {
        const context = { log: { warn: jest.fn() } };
        await handler(context, { method: 'POST', headers: { cookie: missingCookie ? '' : cookie(started.cookie),
            accept: json ? 'application/json' : 'text/html', 'user-agent': 'Synthetic recovery test', 'x-forwarded-for': '192.0.2.17' },
        body: { code: PRIVATE, state: new URL(started.location).searchParams.get('state') } });
        expect(JSON.stringify(context)).not.toContain(PRIVATE);
        expect(JSON.stringify(context.log.warn.mock.calls)).not.toContain(PRIVATE);
        return context.res;
    };
    return { service, store, exchange, invoke, setNow(value) { now = value; } };
}

test.each([false, true])('a real five-minute boundary consumes %s customer login before exchange, then manual fresh login uses new state/nonce/PKCE', async external => {
    const f = authentication(external), started = await f.service.beginLogin();
    expect(started.cookie).toContain('Max-Age=300');
    const before = f.store.transactions.get(cookieId(started.cookie));
    expect(before.expiresAt - before.issuedAt).toBe(300000);
    f.setNow(NOW + 300000);
    const expired = await f.invoke(started);
    expect(expired).toMatchObject({ status: 303, headers: {
        Location: `/login?signin=expired&provider=${external ? 'external' : 'legacy'}` } });
    expect(expired.headers['Set-Cookie']).toContain(external ? '__Host-nofries-external-customer-tx=' : '__Host-nofries-customer-tx=');
    expect(expired.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(f.store.transactions.has(cookieId(started.cookie))).toBe(false);
    expect(f.store.sessions.size).toBe(0); expect(f.exchange).not.toHaveBeenCalled();
    expect((await f.invoke(started)).headers.Location).toBe(`/login?signin=retry&provider=${external ? 'external' : 'legacy'}`);
    expect(f.exchange).not.toHaveBeenCalled();
    const fresh = await f.service.beginLogin(), current = f.store.transactions.get(cookieId(fresh.cookie));
    for (const name of ['state', 'nonce', 'codeVerifier']) expect(current[name]).not.toBe(before[name]);
    expect(new URL(fresh.location).origin).toBe(new URL(started.location).origin);
    const completed = await f.service.completeLogin({ cookieHeader: cookie(fresh.cookie),
        body: { code: 'synthetic-fresh-code', state: current.state } });
    expect(completed.identity.subjectKey).toBe(`${uid(external ? 101 : 1)}:${uid(3)}`);
    expect(await f.service.readSession(cookie(completed.cookie))).toEqual(completed.identity);
    expect(f.exchange).toHaveBeenCalledTimes(1); expect(f.store.sessions.size).toBe(1);
});

test.each([false, true])('a missing %s customer transaction cookie stays generic and never exchanges a code', async external => {
    const f = authentication(external), started = await f.service.beginLogin();
    const response = await f.invoke(started, { missingCookie: true });
    expect(response.headers.Location).toBe(`/login?signin=retry&provider=${external ? 'external' : 'legacy'}`);
    expect(f.exchange).not.toHaveBeenCalled(); expect(f.store.sessions.size).toBe(0);
    expect(f.store.transactions.has(cookieId(started.cookie))).toBe(true);
});

test.each([false, true])('expired %s customer JSON callback keeps the generic API response', async external => {
    const f = authentication(external), started = await f.service.beginLogin(); f.setNow(NOW + 300000);
    const response = await f.invoke(started, { json: true });
    expect(response.status).toBe(401); expect(response.body.code).toBe('browser_auth_failed');
    expect(response.headers.Location).toBeUndefined(); expect(JSON.stringify(response)).not.toContain('transaction_expired');
    expect(f.exchange).not.toHaveBeenCalled();
});

test.each([new BrowserAuthError(400, 'browser_auth_code_exchange_failed', PRIVATE),
    Object.assign(new Error(PRIVATE), { code: 'browser_auth_transaction_expired' })])('only the typed expiry category receives the expiry hint', async failure => {
    const context = { log: { warn: jest.fn() } };
    await createAuthCallbackFunction({ customerEntry: true, customerTransport: 'external',
        service: { completeLogin: async () => { throw failure; } } })(context,
    { method: 'POST', headers: { accept: 'text/html', 'x-forwarded-for': '192.0.2.18' }, body: { code: PRIVATE } });
    expect(context.res.headers.Location).toBe('/login?signin=retry&provider=external');
    expect(JSON.stringify(context)).not.toContain(PRIVATE);
    expect(JSON.stringify(context.log.warn.mock.calls)).not.toContain(PRIVATE);
});

test('an expired production-composed attempt leaves durable consent, identity and an existing active session intact', async () => {
    let exchange;
    const h = customerProductionHarness({ configureExternal({ dependencies }) {
        exchange = jest.spyOn(dependencies.clientApplication, 'acquireTokenByCode');
    } }), user = h.addUser(), first = await h.login(user);
    expect(first.response.status).toBe(303);
    expect((await h.consent(first.cookie)).response.status).toBe(200);
    const state = () => request(h.app).get('/api/customer-signup/state').set('Cookie', first.cookie);
    const retainedState = (await state()).body.state;
    const saved = () => ({ registrations: [...h.pool.registrations], receipts: [...h.pool.receipts],
        authority: [...h.getContainer('customer-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')]) });
    const retained = JSON.stringify(saved()), auth = h.getContainer('nofries-browser-auth');
    const activeSessions = () => [...auth.records].filter(([key]) => key.startsWith('browser-auth/sessions/'))
        .map(([key, bytes]) => [key, bytes.toString('base64')]);
    const originalSession = activeSessions(); exchange.mockClear();
    const started = await request(h.app).get('/api/customer-auth/login').set('Cookie', first.cookie);
    expect(started.status).toBe(302);
    const tx = cookie(started.headers['set-cookie'][0]), stateValue = new URL(started.headers.location).searchParams.get('state');
    h.state.now += 300000;
    const callback = () => request(h.app).post('/api/customer-auth/callback').set('Cookie', `${first.cookie}; ${tx}`)
        .set('Accept', 'text/html').type('form').send({ state: stateValue, code: PRIVATE });
    const expired = await callback();
    expect(expired.headers.location).toBe('/login?signin=expired&provider=legacy');
    expect(expired.headers['set-cookie']).toHaveLength(1);
    expect(expired.headers['set-cookie'][0]).toMatch(/^__Host-nofries-customer-tx=;/);
    expect(exchange).not.toHaveBeenCalled(); expect(activeSessions()).toEqual(originalSession);
    expect((await callback()).headers.location).toBe('/login?signin=retry&provider=legacy');
    expect((await state()).body.state).toEqual(retainedState);
    const fresh = await h.login(user, { bootstrap: false });
    expect(fresh.response.status).toBe(303); expect(fresh.cookie).not.toBe(first.cookie);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', fresh.cookie)).body.state).toEqual(retainedState);
    expect(JSON.stringify(saved())).toBe(retained);
    expect(activeSessions()).toEqual(expect.arrayContaining(originalSession));
    expect(JSON.stringify(expired.headers)).not.toContain(PRIVATE);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(PRIVATE);
});

test('an expired production-composed external attempt keeps saved setup, immutable authority and its established session', async () => {
    let exchange;
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ dependencies, state }) {
            dependencies.clock = () => new Date(state.now).toISOString();
            exchange = jest.spyOn(dependencies.externalCustomer.client.clientApplication, 'acquireTokenByCode');
        } });
    const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
    const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
    expect(before.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
    const submitted = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', provisional.cookie).set('X-CSRF-Token', before.body.csrfToken).send({ accountType: 'consultant',
            organisationName: 'Synthetic retained consultancy', details: { name: 'Synthetic representative', role: 'Owner',
                address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
    expect(submitted.body.state).toEqual({ status: 'continue_authentication' });
    const first = await h.loginExternal(); expect(first.response.status).toBe(303);
    const getState = session => request(h.app).get('/api/external-customer-signup/state').set('Cookie', session);
    const retainedState = await getState(first.cookie); expect(retainedState.status).toBe(503);
    // The existing SQL fixture deliberately cannot prepare the starter workspace.
    // Retain its actual state; native PostgreSQL acceptance remains separate.
    expect(retainedState.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const records = h.getContainer('external-starter-authority').records;
    const saved = () => JSON.stringify({ external: [...records].map(([key, bytes]) => [key, bytes.toString('base64')]),
        registrations: [...h.pool.registrations], receipts: [...h.pool.receipts] });
    expect([...records.keys()].some(key => key.includes('/starter-accounts/'))).toBe(true);
    expect([...records.keys()].some(key => key.includes('/starter-setups/'))).toBe(true);
    const authority = JSON.parse([...records].find(([key]) => key.startsWith('customer-subjects/'))[1]);
    expect(authority.subjectKey).toBe(uid(101) + ':' + h.state.externalOid);
    const retained = saved(), auth = h.getContainer('nofries-browser-auth').records;
    const sessionKey = session => 'browser-auth/sessions/' + crypto.createHash('sha256').update(cookieId(session)).digest('hex') + '.json';
    const originalSession = Buffer.from(auth.get(sessionKey(first.cookie)));
    expect(JSON.parse(originalSession).identity.subjectKey).toBe(authority.subjectKey);
    exchange.mockClear();
    const started = await request(h.app).get('/api/external-customer-auth/login').set('Cookie', first.cookie);
    expect(started.status).toBe(302);
    const tx = cookie(started.headers['set-cookie'][0]), state = new URL(started.headers.location).searchParams.get('state');
    const txKey = 'browser-auth/transactions/' + crypto.createHash('sha256').update(cookieId(tx)).digest('hex') + '.json';
    const transaction = JSON.parse(auth.get(txKey));
    expect(transaction.expiresAt - transaction.issuedAt).toBe(300000); h.state.now = transaction.expiresAt;
    const callback = () => request(h.app).post('/api/external-customer-auth/callback')
        .set('Cookie', `${first.cookie}; ${tx}`).set('Accept', 'text/html').type('form').send({ state, code: PRIVATE });
    const expired = await callback();
    expect(expired.headers.location).toBe('/login?signin=expired&provider=external');
    expect(expired.headers['set-cookie']).toHaveLength(1);
    expect(expired.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer-tx=;/);
    expect(auth.has(txKey)).toBe(false); expect(exchange).not.toHaveBeenCalled();
    expect((await callback()).headers.location).toBe('/login?signin=retry&provider=external');
    expect(exchange).not.toHaveBeenCalled(); expect(saved()).toBe(retained);
    expect(auth.get(sessionKey(first.cookie)).equals(originalSession)).toBe(true);
    const existing = await getState(first.cookie);
    expect({ status: existing.status, body: existing.body }).toEqual({ status: retainedState.status, body: retainedState.body });
    const fresh = await h.loginExternal(); expect(fresh.response.status).toBe(303);
    expect(fresh.cookie).not.toBe(first.cookie); expect(exchange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(auth.get(sessionKey(fresh.cookie))).identity.subjectKey).toBe(authority.subjectKey);
    expect(auth.get(sessionKey(first.cookie)).equals(originalSession)).toBe(true);
    const returned = await getState(fresh.cookie);
    expect({ status: returned.status, body: returned.body }).toEqual({ status: retainedState.status, body: retainedState.body });
    expect(saved()).toBe(retained); expect(h.state.delivered).toEqual([]);
    expect(JSON.stringify(expired.headers)).not.toContain(PRIVATE);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(PRIVATE);
});

function runDocument(document, { search = '', state = { status: 'create_account' }, status = 200 } = {}) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const assign = jest.fn(), replace = jest.fn(), listeners = {};
    const fetch = jest.fn(async () => new Response(JSON.stringify({ state, csrfToken: 'x'.repeat(43) }), {
        status, headers: { 'content-type': 'application/json' } }));
    vm.runInNewContext(document.runtime, { document: dom.document,
        window: { fetch, location: { search, hash: '', assign, replace },
            addEventListener(name, fn) { listeners[name] = fn; } },
        URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout });
    return { ...dom, fetch, assign, replace, dispose: () => listeners.pagehide?.() };
}

test.each(['dynamic', 'hosted'].flatMap(kind => ['retry', 'expired', undefined].map(hint => [kind, hint])))
('%s external continuation with recovery %s preserves the manual link while ordinary continuation retains automatic navigation', async (kind, hint) => {
    const document = kind === 'hosted' ? buildHostedSignupDocument(sources())
        : buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
    const f = runDocument(document, { search: '?provider=external' + (hint ? '&signin=' + hint : ''),
        state: { status: 'continue_authentication' } });
    try {
        await flush(); expect(f.root.querySelector('h1').textContent).toBe('Continuing account setup');
        expect(f.root.querySelector('a').textContent).toBe('Continue securely');
        expect(f.root.querySelector('a').href).toBe('/api/external-customer-auth/login');
        expect(f.root.querySelector('button').textContent).toBe('Sign out and change account');
        expect(f.root.querySelector('button').type).toBe('submit'); expect(f.assign).not.toHaveBeenCalled();
        if (hint) expect(f.replace).not.toHaveBeenCalled();
        else { expect(f.replace).toHaveBeenCalledTimes(1); expect(f.replace).toHaveBeenCalledWith('/api/external-customer-auth/login'); }
        expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
    } finally { f.dispose(); }
});

test.each(['dynamic-legacy', 'dynamic-external', 'hosted-legacy', 'hosted-external'].flatMap(kind =>
    ['retry', 'expired'].map(hint => [kind, hint])))('%s executes bounded %s recovery under its matching CSP and restarts only after a click', async (kind, hint) => {
    const external = kind.endsWith('external'), document = kind.startsWith('hosted')
        ? buildHostedSignupDocument(sources()) : buildSignupDocument({ ...sources(), customerLogin: true,
            ...(external ? { customerTransport: 'external' } : {}) });
    expect(document.html).toContain(`<script>${document.runtime}</script>`);
    expect(document.contentSecurityPolicy).toContain(`'sha256-${crypto.createHash('sha256').update(document.runtime).digest('base64')}'`);
    expect(document.contentSecurityPolicy).not.toContain('unsafe-inline');
    const f = runDocument(document, { search: `?provider=${external ? 'external' : 'legacy'}&signin=${hint}&code=${PRIVATE}` });
    try {
        await flush(); expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([`/api/${external ? 'external-' : ''}customer-signup/state`]);
        expect(f.assign).not.toHaveBeenCalled(); expect(f.replace).not.toHaveBeenCalled();
        expect(f.root.querySelector('h1').textContent).toBe('Restart secure sign-in');
        expect(f.root.textContent).toContain(hint === 'expired' ? 'expired or is no longer valid' : 'Sign-in did not finish');
        expect(f.root.textContent).not.toContain(PRIVATE);
        const choose = Array.from(f.root.querySelectorAll('a')).find(link => link.textContent === 'Sign in with another account');
        if (external) {
            expect(f.root.textContent).toContain('If you finished creating your account, sign in with the same email and password.');
            expect(choose.href).toBe('/api/external-customer-auth/login?account=choose');
        } else {
            expect(f.root.textContent).toContain('Your saved setup and work are kept.'); expect(choose).toBeUndefined();
        }
        f.root.querySelector('button').click();
        expect(f.assign).toHaveBeenCalledTimes(1);
        expect(f.assign).toHaveBeenCalledWith(`/api/${external ? 'external-' : ''}customer-auth/login`);
        expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { f.dispose(); await flush(); }
});

test.each(['?provider=external&signin=expired&signin=retry', '?provider=external&signin=expired&signin=expired',
    '?provider=external&signin=unknown', '?provider=external&signin=', '?provider=external&signin=https%3A%2F%2Fevil.invalid'])
('generated hosted recovery ignores ambiguous or unknown hint %s', async search => {
    const f = runDocument(buildHostedSignupDocument(sources()), { search });
    try {
        await flush(); expect(f.root.querySelector('h1').textContent).toBe('Sign up / Sign in');
        expect(f.root.textContent).not.toContain('If you finished creating');
        expect(f.assign).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
        f.root.querySelector('button').click(); expect(f.assign).toHaveBeenCalledWith('/api/external-customer-auth/login');
    } finally { f.dispose(); await flush(); }
});

test.each([terms, { status: 'setup_details', email: 'retained@example.test' }, { status: 'resume_acceptance' },
    { status: 'pending_preparation' }, { status: 'pending_admission' }, { status: 'continue_to_dashboard', accountType: 'consultant' }])
('forged recovery hint cannot replace authenticated %j progress', async state => {
    const dom = createDom(), client = { load: jest.fn(async () => state), createAccount: jest.fn(),
        acceptTerms: jest.fn(), resumeAcceptance: jest.fn(), completeSetup: jest.fn() };
    const view = mountSignupJourney(dom.root, client, { customerTransport: 'external', signInRecovery: 'expired' });
    try {
        await view.ready; expect(dom.root.textContent).not.toContain('Restart secure sign-in');
        expect(dom.root.textContent).not.toContain('If you finished creating');
        expect(client.createAccount).not.toHaveBeenCalled(); expect(client.acceptTerms).not.toHaveBeenCalled();
        if (state.status === 'terms') expect(dom.root.querySelector('input').checked).toBe(false);
        if (state.status === 'setup_details') expect(dom.root.textContent).toContain(state.email);
        if (state.status === 'continue_to_dashboard') expect(dom.root.querySelector('a').href).toBe('/dashboard#organisations');
    } finally { view.dispose(); }
});

test.each([{ status: 503, state: { status: 'create_account' } }, { status: 200, state: { status: 'unexpected' } }])
('a recovery hint cannot manufacture account state after an unavailable read %j', async failure => {
    const f = runDocument(buildHostedSignupDocument(sources()), { ...failure, search: '?provider=external&signin=expired' });
    try {
        await flush(); expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
        expect(f.root.textContent).not.toContain('If you finished creating');
        expect(f.assign).not.toHaveBeenCalled(); expect(f.replace).not.toHaveBeenCalled();
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(f.root.textContent).toContain('Do not create another account or submit your details again.');
        expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { f.dispose(); }
});

test.each([
    ['?provider=external&signin=retry&code=' + PRIVATE, '', '/signup?provider=external&signin=retry'],
    ['?provider=external&signin=expired&returnTo=https%3A%2F%2Fevil.invalid', '', '/signup?provider=external&signin=expired'],
    ['?provider=external&signin=expired&signin=retry', '', '/signup?provider=external'],
    ['?provider=external&signin=unknown', '', '/signup?provider=external'],
    ['?provider=external&signin=expired', '#private-fragment', '/signup?provider=invalid'],
    ['?provider=external&provider=legacy&signin=expired', '', '/signup?provider=invalid']
])('external login handoff forwards only the single fixed recovery hint from %s', (search, hash, target) => {
    const replace = jest.fn(), fetch = jest.fn(() => { throw new Error('No legacy request is allowed'); });
    vm.runInNewContext(fs.readFileSync('js/organisation-setup.js', 'utf8'), {
        document: { getElementById: id => id === 'organisation-form' ? {} : null },
        window: { location: { search, hash, replace } }, URLSearchParams, fetch });
    expect(replace).toHaveBeenCalledTimes(1); expect(replace).toHaveBeenCalledWith(target);
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(replace.mock.calls)).not.toMatch(/private|evil|code=/);
});
