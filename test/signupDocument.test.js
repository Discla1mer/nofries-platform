'use strict';

const request = require('supertest');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const { URLSearchParams } = require('node:url');
const { createNoFriesApp } = require('../server');
const { buildSignupDocument } = require('../lib/signupDocument');
const { createDom } = require('./fixtures/dashboardDom');
const { normaliseReturnTo } = require('../api/shared/browserAuth');
const sources = () => ({
    clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
    journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8')
});
const token = 'x'.repeat(43);
const terms = { status: 'terms', termsText: 'Synthetic HTTP terms, not a production agreement.',
    termsVersion: 'synthetic-v1', termsDigest: 'a'.repeat(64) };

test('external signup document executes only fixed external state/terms routes and login', async () => {
    const { runtime, html } = buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
    expect(html).toContain('href="/api/external-customer-auth/login?account=choose">Return to sign in');
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const fetch = jest.fn(async (_url, options) => new Response(JSON.stringify({
        state: options.method === 'POST' ? { status: 'create_account' } : terms, csrfToken: token
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const assign = jest.fn(), listeners = {};
    vm.runInNewContext(runtime, { document: dom.document, window: { fetch, location: { assign },
        addEventListener(name, fn) { listeners[name] = fn; } }, AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    await settle();
    const checkbox = dom.root.querySelector('input'); checkbox.checked = true;
    for (const fn of checkbox.events.change) fn();
    dom.root.querySelector('button').click(); await settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state', '/api/external-customer-signup/terms']);
    expect(dom.root.querySelector('a').href).toBe('/');
    dom.root.querySelector('button').click();
    expect(assign).toHaveBeenCalledWith('/api/external-customer-auth/login');
    listeners.pagehide();
});

test.each(['/signup', '/signup/'])('unconfigured host serves an honest unavailable page at %s', async path => {
    const response = await request(createNoFriesApp()).get(path);
    expect(response.status).toBe(503);
    expect(response.text).toContain('Signup is unavailable');
    expect(response.text).not.toContain('<script>');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
});

test('actual served document executes the existing client/view through HTTP state and consent routes', async () => {
    let accepted = false;
    const app = createNoFriesApp({ customerSignup: {
        env: { NOFRIES_PUBLIC_URL: 'https://nofries.invalid', NODE_ENV: 'production' },
        loadState: async () => accepted ? { status: 'pending_admission' } : terms,
        issueCsrfToken: async () => token,
        validateCsrfToken: async (_req, value) => value === token,
        acceptTerms: async ({ input }) => {
            expect(input).toEqual({ accepted: true, termsVersion: terms.termsVersion, termsDigest: terms.termsDigest });
            accepted = true; return { status: 'pending_admission' };
        }
    } });
    const page = await request(app).get('/signup');
    expect(page.status).toBe(200);
    const runtime = page.text.match(/<script>([\s\S]*?)<\/script>/)[1];
    const hash = crypto.createHash('sha256').update(runtime).digest('base64');
    expect(page.headers['content-security-policy']).toContain(`'sha256-${hash}'`);
    const dom = createDom();
    const create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    let pending = Promise.resolve();
    const fetch = jest.fn((url, options) => {
        pending = (async () => {
            const req = options.method === 'POST' ? request(app).post(url) : request(app).get(url);
            req.set(options.headers);
            if (options.method === 'POST') req.set('Origin', 'https://nofries.invalid').send(options.body);
            const response = await req;
            let read = false;
            return { status: response.status, redirected: false,
                headers: { get: name => response.headers[name] },
                body: { getReader: () => ({ async read() {
                    if (read) return { done: true };
                    read = true; return { done: false, value: Buffer.from(response.text) };
                }, async cancel() {} }) }
            };
        })();
        return pending;
    });
    const listeners = {};
    vm.runInNewContext(runtime, { document: dom.document,
        window: { fetch, location: { assign: jest.fn() }, addEventListener: (name, fn) => { listeners[name] = fn; } },
        AbortController, URLSearchParams, TextDecoder: require('node:util').TextDecoder, setTimeout, clearTimeout });
    const settle = async () => { await pending; for (let i = 0; i < 30; i++) await Promise.resolve(); };
    await settle();
    const box = dom.root.querySelector('input');
    expect(box.checked).toBe(false);
    box.checked = true; for (const fn of box.events.change) fn();
    dom.root.querySelector('button').click();
    await settle();
    expect(accepted).toBe(true);
    expect(dom.root.textContent).toContain('Account setup received');
    expect(dom.root.textContent).toContain('You do not have dashboard access yet');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/customer-signup/state', '/api/customer-signup/terms']);
    listeners.pagehide();
});

test('page bundle rejects script termination and keeps the provider destination fixed', () => {
    expect(() => buildSignupDocument({ ...sources(), clientSource: '</script><script>bad()</script>' })).toThrow();
    const doc = buildSignupDocument(sources());
    expect(doc.runtime).toContain("window.location.assign('/api/auth/login?returnTo=%2Fsignup')");
    expect(doc.contentSecurityPolicy).not.toContain('unsafe-inline');
    expect(normaliseReturnTo('/signup', 'https://nofries.invalid', '/')).toBe('/signup');
    for (const target of ['https://evil.invalid/signup', '//evil.invalid/signup', '/signup/other']) {
        expect(() => normaliseReturnTo(target, 'https://nofries.invalid', '/')).toThrow();
    }
});

test.each(['#invitation=invalid-private-value', '#invitation=' + 'x'.repeat(43)])('failed invitation bootstrap leaves an accessible error without leaking the fragment: %s', async fragment => {
    const { runtime } = buildSignupDocument(sources());
    const dom = createDom();
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const fetch = jest.fn(async () => ({ status: 503 }));
    const history = { replaceState: jest.fn() }, assign = jest.fn(), replace = jest.fn();
    vm.runInNewContext(runtime, { document: dom.document,
        window: { fetch, history, location: { hash: fragment, assign, replace }, addEventListener: jest.fn() },
        AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/signup');
    expect(dom.root.textContent).toContain('Signup is unavailable');
    expect(dom.root.textContent).not.toContain(fragment.slice(12));
    expect(dom.document.activeElement.tagName).toBe('H1');
    expect(dom.root.querySelector('input')).toBeNull();
    expect(dom.root.querySelector('button')).toBeNull();
    expect(assign).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(fragment.includes('invalid') ? [] : ['/api/customer-signup/bootstrap']);
});

test.each([
    [{ status: 'continue_to_dashboard', accountType: 'company' }, '/dashboard'],
    [{ status: 'continue_to_dashboard', accountType: 'consultant' }, '/dashboard#organisations'],
    [{ status: 'continue_to_dashboard' }, '/dashboard'],
    [{ status: 'terms', ...terms }, null],
    [{ status: 'pending_admission' }, null],
    [{ status: 'continue_to_dashboard', accountType: 'https://untrusted.invalid' }, null]
])('only a validated ready account automatically opens its fixed dashboard: %j', async (state, destination) => {
    const { runtime } = buildSignupDocument({ ...sources(), customerLogin: true });
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const replace = jest.fn(), listeners = {};
    const fetch = jest.fn(async () => new Response(JSON.stringify({ state, csrfToken: token }), {
        status: 200, headers: { 'content-type': 'application/json' }
    }));
    vm.runInNewContext(runtime, { document: dom.document,
        window: { fetch, location: { replace, assign: jest.fn() }, addEventListener(name, fn) { listeners[name] = fn; } },
        AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    if (destination) expect(replace).toHaveBeenCalledWith(destination);
    else expect(replace).not.toHaveBeenCalled();
    // Loading an existing account never submits consent or activation commands.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/customer-signup/state');
    if (state.status === 'terms') expect(dom.root.querySelector('input').checked).toBe(false);
    listeners.pagehide();
});

test('production document exchanges the invitation fragment through HTTP before loading state', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness(), user = h.addUser();
    const page = await request(h.app).get('/signup');
    const runtime = page.text.match(/<script>([\s\S]*?)<\/script>/)[1];
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    let pending = Promise.resolve(), cookie = '';
    const fetch = jest.fn((url, options) => {
        pending = (async () => {
            let call = options.method === 'POST' ? request(h.app).post(url) : request(h.app).get(url);
            call = call.set(options.headers).set('Cookie', cookie);
            if (options.method === 'POST') call = h.sameOrigin(call).send(options.body);
            const response = await call;
            if (response.headers['set-cookie']) cookie = response.headers['set-cookie'][0].split(';')[0];
            return new Response(response.status === 204 ? null : response.text, { status: response.status, headers: response.headers });
        })();
        return pending;
    });
    const history = { replaceState: jest.fn() }, assign = jest.fn(), listeners = {};
    vm.runInNewContext(runtime, { document: dom.document,
        window: { fetch, history, location: { hash: '#invitation=' + user.invitationToken, assign }, addEventListener(name, fn) { listeners[name] = fn; } },
        AbortController, URLSearchParams, TextDecoder: require('node:util').TextDecoder, setTimeout, clearTimeout });
    for (let i = 0; i < 5; i++) { await pending; await new Promise(setImmediate); }
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/signup');
    expect(cookie).toBe('__Host-nofries-signup=' + user.invitationToken);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/customer-signup/bootstrap', '/api/customer-signup/state']);
    expect(dom.root.textContent).toContain('Sign up / Sign in');
    dom.root.querySelector('button').click();
    // Existing invitations must work even when organisation setup is disabled.
    expect(assign).toHaveBeenCalledWith('/api/customer-auth/login');
    listeners.pagehide();
});

test.each(['/login', '/login?signin=retry'])('returning customers can enter %s when email setup is disabled', async path => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness();
    const entry = await request(h.app).get('/api/dashboard/login');
    expect(entry.status).toBe(303); expect(entry.headers.location).toBe('/login');
    const page = await request(h.app).get(path);
    expect(page.status).toBe(200); expect(page.headers['cache-control']).toContain('no-store');
    expect(page.text).not.toContain('/api/organisation-setup/state');
    const runtime = page.text.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(page.headers['content-security-policy']).toContain("'sha256-" + crypto.createHash('sha256').update(runtime).digest('base64') + "'");
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const assign = jest.fn(), replace = jest.fn(), listeners = {};
    const fetch = jest.fn(async (url, options) => {
        const response = await request(h.app).get(url).set(options.headers);
        return new Response(response.text, { status: response.status, headers: response.headers });
    });
    vm.runInNewContext(runtime, { document: dom.document,
        window: { fetch, location: { assign, replace }, addEventListener(name, fn) { listeners[name] = fn; } },
        AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/customer-signup/state']);
    expect(assign).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    dom.root.querySelector('button').click();
    expect(assign).toHaveBeenCalledWith('/api/customer-auth/login');
    listeners.pagehide();
});

test('production reads a maximum-byte schedule whose JSON archive exceeds the default record limit', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const scheduleText = '"'.repeat(32768);
    const h = customerProductionHarness(), user = h.addUser({ scheduleText });
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    const consent = await h.consent(login.cookie);
    expect(consent.before.status).toBe(200);
    expect(consent.before.body.state).toEqual(expect.objectContaining({
        status: 'terms', scheduleText, scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest
    }));
    expect(consent.response.status).toBe(200);
    expect(h.pool.receipts.size).toBe(1);
});

test('production rejects schedule controls that would exceed the client response envelope', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness(), user = h.addUser({ scheduleText: '\u0001'.repeat(22000) });
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    const state = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state.status).toBe('unavailable');
    expect(h.pool.receipts.size).toBe(0);
});

test('schedule archives allow distinct IDs with identical approved bytes', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness();
    const scheduleText = 'Identical synthetic schedule bytes.';
    const first = h.addUser({ oid: '30000000-0000-4000-8000-000000000011',
        tenantId: 'tenant-schedule', organisationId: 'org-one', scheduleText });
    const second = h.addUser({ oid: '30000000-0000-4000-8000-000000000012',
        tenantId: 'tenant-schedule', organisationId: 'org-two', scheduleText });
    expect(first.scheduleDigest).toBe(second.scheduleDigest);
    expect(first.scheduleId).not.toBe(second.scheduleId);
    expect(first.scheduleArchiveKey).not.toBe(second.scheduleArchiveKey);
    const firstLogin = await h.login(first);
    const firstState = await request(h.app).get('/api/customer-signup/state').set('Cookie', firstLogin.cookie);
    expect(firstState.body.state).toEqual(expect.objectContaining({
        status: 'terms', scheduleId: first.scheduleId, scheduleText
    }));
    const secondLogin = await h.login(second);
    const secondState = await request(h.app).get('/api/customer-signup/state').set('Cookie', secondLogin.cookie);
    expect(secondState.body.state).toEqual(expect.objectContaining({
        status: 'terms', scheduleId: second.scheduleId, scheduleText
    }));
});

test('current terms offers are isolated when tenants reuse an organisation identifier', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness();
    const first = h.addUser({ oid: '30000000-0000-4000-8000-000000000001',
        tenantId: 'tenant-one', organisationId: 'shared-org' });
    const second = h.addUser({ oid: '30000000-0000-4000-8000-000000000002',
        tenantId: 'tenant-two', organisationId: 'shared-org' });
    first.withdrawOffer();
    const firstLogin = await h.login(first);
    const firstState = await request(h.app).get('/api/customer-signup/state').set('Cookie', firstLogin.cookie);
    expect(firstState.body.state.status).toBe('unavailable');
    const secondLogin = await h.login(second);
    const secondConsent = await h.consent(secondLogin.cookie);
    expect(secondConsent.before.body.state.status).toBe('terms');
    expect(secondConsent.response.status).toBe(200);
    expect(h.pool.receipts.size).toBe(1);
});

test('production direct POST denies a withdrawn organisation offer while retaining canonical terms', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness(), user = h.addUser();
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    const before = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(before.body.state).toEqual(expect.objectContaining({ status: 'terms',
        scheduleId: user.scheduleId, scheduleText: user.scheduleText, scheduleDigest: user.scheduleDigest }));
    expect(h.getContainer('customer-authority').records.has(`customer-terms/${h.termsDigest}.json`)).toBe(true);
    user.withdrawOffer();
    const response = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms'))
        .set('Cookie', login.cookie).set('X-CSRF-Token', before.body.csrfToken)
        .send({ accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest,
            scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('signup_unavailable');
    expect(h.pool.receipts.size).toBe(0);
    expect(h.getContainer('customer-authority').records.has(`customer-terms/${h.termsDigest}.json`)).toBe(true);
});

test('a withdrawn organisation offer does not hide an existing durable acceptance', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness(), user = h.addUser();
    const login = await h.login(user);
    expect((await h.consent(login.cookie)).response.status).toBe(200);
    expect(h.pool.receipts.size).toBe(1);
    const receipt = [...h.pool.receipts.values()][0].receipt;
    expect(receipt).toEqual(expect.objectContaining({ scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest }));
    user.withdrawOffer();
    expect(JSON.parse(h.getContainer('customer-authority').records
        .get(user.scheduleArchiveKey).toString())).toEqual({ schemaVersion: 1,
        scheduleId: user.scheduleId, scheduleText: user.scheduleText, scheduleDigest: user.scheduleDigest });
    const state = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state.status).toBe('pending_admission');
    expect(h.pool.receipts.size).toBe(1);
    expect(h.getContainer('customer-authority').records.has(`customer-terms/${h.termsDigest}.json`)).toBe(true);
});

test('registration failure remains recoverable with its invitation after offer withdrawal without new consent', async () => {
    const { customerProductionHarness, signupSql } = require('./helpers/customerProductionHarness');
    const pool = signupSql(), connect = pool.connect.bind(pool); let failRegistration = true;
    pool.connect = async () => {
        const client = await connect(), query = client.query.bind(client);
        client.query = async (sql, params) => {
            if (failRegistration && sql.startsWith('INSERT') && sql.includes('nofries.signup_registrations')) {
                failRegistration = false; throw new Error('synthetic registration failure');
            }
            return query(sql, params);
        };
        return client;
    };
    const h = customerProductionHarness({ pool }), user = h.addUser();
    const login = await h.login(user);
    const first = await h.consent(login.cookie);
    expect(first.response.status).toBe(503);
    expect(pool.receipts.size).toBe(1);
    user.withdrawOffer();
    const recovery = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(recovery.body.state).toEqual({ status: 'resume_acceptance' });
    expect(recovery.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const resumed = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms'))
        .set('Cookie', login.cookie).set('X-CSRF-Token', recovery.body.csrfToken).send({ resume: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.state.status).toBe('pending_admission');
    expect(pool.receipts.size).toBe(1);
});

test.each(['company', 'consultant'])('delivered managed signup document posts %s details only after provider authentication and continues through a fixed callback route', async accountType => {
    const { runtime } = buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {}, reportValidity: () => true });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const fetch = jest.fn(async (_url, options) => new Response(JSON.stringify({
        state: options.method === 'POST' ? { status: 'continue_authentication' } : { status: 'setup_details', email: 'synthetic@example.test' },
        ...(options.method === 'POST' ? {} : { csrfToken: token })
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const replace = jest.fn(), listeners = {};
    vm.runInNewContext(runtime, { document: dom.document, window: { fetch, location: { replace },
        addEventListener(name, fn) { listeners[name] = fn; } }, AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    await settle();
    expect(dom.root.textContent).toContain('Set up your workspace');
    const values = { organisationName: 'Synthetic company', name: 'Synthetic Person', role: 'Owner', address: 'Synthetic address', registrationId: '' };
    for (const field of dom.root.querySelectorAll('input')) {
        if (field.name === 'authorityConfirmed') field.checked = true;
        else field.value = values[field.name];
    }
    dom.root.querySelector('select').value = accountType;
    const form = dom.root.querySelector('form');
    for (const fn of form.events.submit) fn({ preventDefault() {} });
    await settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state', '/api/external-customer-signup/setup']);
    const options = fetch.mock.calls[1][1];
    expect(options.headers['X-CSRF-Token']).toBe(token);
    expect(JSON.parse(options.body)).toEqual({ accountType, organisationName: values.organisationName, details: {
        name: values.name, role: values.role, address: values.address, registrationId: '', authorityConfirmed: true } });
    expect(replace).toHaveBeenCalledWith('/api/external-customer-auth/login');
    listeners.pagehide();
});
