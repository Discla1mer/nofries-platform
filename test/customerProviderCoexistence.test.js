'use strict';

// Synthetic provider/admission boundaries only. Genuine auth, issuance proofs,
// readers and host composition run with one shared store and three identities.
const { createBrowserAuthService, readBrowserSessionDetails, BrowserAuthError } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createDashboardRuntimeHandlers } = require('../api/shared/dashboardRuntimeHandlers');

const id = n => '92000000-0000-4000-8000-' + String(n).padStart(12, '0');
const now = Date.parse('2026-10-08T00:00:00Z');
const firstCookie = result => (Array.isArray(result.cookie) ? result.cookie[0] : result.cookie).split(';')[0];
const clone = value => JSON.parse(JSON.stringify(value));

test.each(['/dashboard', '/'])('external dashboard entry %s retains provider navigation after its cookie is cleared', async path => {
    const http = require('supertest'), h = fixture();
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    const page = await http(app).get(path).set('Cookie', '__Host-nofries-external-customer=' + 'x'.repeat(43));
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-customer-provider="external"');
    expect(page.text).toContain('href="/login?provider=external"');
    const legacy = await http(app).get(path);
    expect(legacy.status).toBe(200); expect(legacy.text).not.toContain('data-customer-provider="external"');
    const ambiguous = await http(app).get(path).set('Cookie', '__Host-nofries-customer=y; __Host-nofries-external-customer=x');
    expect(ambiguous.status).toBe(401);
});

function fixture() {
    const state = { bytes: 1, sequence: 20 }, store = new MemoryBrowserSessionStore(), proofs = new Map();
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.example.test',
        NOFRIES_ENTRA_TENANT_ID: id(1), NOFRIES_ENTRA_CLIENT_ID: id(2), NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff',
        NOFRIES_ALLOWED_SUBJECTS: id(1) + ':' + id(3), NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: id(4),
        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-legacy' };
    const profile = { kind: 'external-id', tenantId: id(6), clientId: id(7),
        authority: 'https://synthetic-coexistence.ciamlogin.com/',
        issuer: 'https://' + id(6) + '.ciamlogin.com/' + id(6) + '/v2.0',
        authorizationEndpoint: 'https://synthetic-coexistence.ciamlogin.com/' + id(6) + '/oauth2/v2.0/authorize' };
    const subjects = {
        staff: { tenant: id(1), client: id(2), oid: id(3), issuer: 'https://login.microsoftonline.com/' + id(1) + '/v2.0' },
        legacy: { tenant: id(1), client: id(4), oid: id(5), issuer: 'https://login.microsoftonline.com/' + id(1) + '/v2.0' },
        external: { tenant: id(6), client: id(7), oid: id(8), issuer: profile.issuer }
    };
    const client = subjectForRequest => ({
        async getAuthCodeUrl(input) {
            const who = subjectForRequest(input);
            const endpoint = who.tenant === id(6) ? profile.authorizationEndpoint : 'https://login.microsoftonline.com/' + id(1) + '/oauth2/v2.0/authorize';
            return endpoint + '?' + new URLSearchParams({ client_id: who.client, redirect_uri: input.redirectUri,
                response_mode: input.responseMode, state: input.state, nonce: input.nonce,
                code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod });
        },
        async acquireTokenByCode(input) {
            const who = subjectForRequest(input);
            return { idTokenClaims: { tid: who.tenant, aud: who.client, oid: who.oid, iss: who.issuer,
                nonce: input.nonce, exp: now / 1000 + 3600, email: 'same-display-email@example.test' }, account: { localAccountId: who.oid } };
        },
        getTokenCache() { return { async removeAccount() {} }; }
    });
    const admission = who => ({
        async begin() { return { context: { kind: 'synthetic-pre-admission' } }; },
        async verify({ identity }) {
            if (identity.subjectKey !== who.tenant + ':' + who.oid) throw new BrowserAuthError(403, 'synthetic_denied');
            return { subjectKey: identity.subjectKey, expiresAt: now + 3600000 };
        },
        async recheck({ identity, assurance }) {
            if (identity.subjectKey !== who.tenant + ':' + who.oid || assurance.subjectKey !== identity.subjectKey) {
                throw new BrowserAuthError(401, 'synthetic_denied');
            }
        }
    });
    const baseAuth = { env, store, randomBytes: size => Buffer.alloc(size, state.bytes++),
        cryptoProvider: { async generatePkceCodes() { return { verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }; } },
        clientApplication: client(input => input.redirectUri.endsWith('/api/customer-auth/callback') ? subjects.legacy : subjects.staff) };
    const externalClient = client(() => subjects.external), legacyPolicy = admission(subjects.legacy), externalPolicy = admission(subjects.external);
    const externalAuth = { ...baseAuth,
        env: { ...env, NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: id(7), NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-external' },
        clientApplication: externalClient, customerPolicy: externalPolicy, customerIdentityProvider: profile, customerTransport: 'external' };
    const identityPolicy = who => ({ policyId: 'synthetic-' + who.client, policyRevision: 1,
        issuer: who.issuer, identityTenantId: who.tenant, audience: who.client });
    const options = { browserAuthOptions: baseAuth, identityPolicy: identityPolicy(subjects.staff),
        proofStore: {
            async createOriginalProof(key, value) { if (proofs.has(key)) throw new Error('collision'); proofs.set(key, clone(value)); },
            async readOriginalProof(key) { return proofs.has(key) ? clone(proofs.get(key)) : null; }
        },
        clock: () => new Date(now).toISOString(), readExternalRuntimeEpoch: async () => ({ instanceId: id(9), restoreEpoch: id(10) }),
        newRequestId: () => id(++state.sequence), requestBudgetMs: 1000,
        pool: { async connect() { throw new Error('No SQL is expected in auth-only coexistence tests'); }, async end() {} },
        instanceId: id(9), historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => id(++state.sequence), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => id(++state.sequence),
        customer: { policy: legacyPolicy, async resolveActivationBinding() { throw new Error('not used'); } },
        externalCustomer: { policy: externalPolicy, identityProvider: profile, identityPolicy: identityPolicy(subjects.external),
            client: { clientSecret: 'synthetic-external', clientApplication: externalClient },
            async resolveActivationBinding() { throw new Error('not used'); } } };
    return { state, store, proofs, subjects, profile, options, baseAuth, externalAuth,
        legacyAuth: { ...baseAuth, customerPolicy: legacyPolicy } };
}
async function login(services) {
    const started = await services.login.beginLogin();
    const input = { cookieHeader: firstCookie(started), body: { code: 'synthetic-code', state: new URL(started.location).searchParams.get('state') } };
    const result = await services.callback.completeLogin(input);
    return { started, input, result, cookie: firstCookie(result) };
}

const queueCapabilityHeader = 'X-NoFries-Dashboard-Capabilities';
const queueCapabilityRequests = [
    { name: 'old client without header', raw: [], advertised: false },
    { name: 'exact capability', raw: [queueCapabilityHeader, 'work-queue-v1'], advertised: true }
];
const otherQueueCapabilityRequests = [
    { name: 'lowercase header name', raw: [queueCapabilityHeader.toLowerCase(), 'work-queue-v1'], advertised: true },
    { name: 'mixed-case header name', raw: ['x-NoFries-DASHBOARD-capabilities', 'work-queue-v1'], advertised: true },
    { name: 'duplicate exact values', raw: [queueCapabilityHeader, 'work-queue-v1', queueCapabilityHeader, 'work-queue-v1'], advertised: false },
    { name: 'case-insensitive duplicate', raw: [queueCapabilityHeader, 'work-queue-v1', queueCapabilityHeader.toLowerCase(), 'work-queue-v1'], advertised: false },
    { name: 'duplicate unknown value', raw: [queueCapabilityHeader, 'work-queue-v1', queueCapabilityHeader, 'unknown'], advertised: false },
    { name: 'comma-combined values', raw: [queueCapabilityHeader, 'work-queue-v1, work-queue-v1'], advertised: false },
    { name: 'combined with unknown capability', raw: [queueCapabilityHeader, 'work-queue-v1, unknown'], advertised: false },
    { name: 'unknown version', raw: [queueCapabilityHeader, 'work-queue-v2'], advertised: false },
    { name: 'value case changed', raw: [queueCapabilityHeader, 'WORK-QUEUE-V1'], advertised: false },
    { name: 'leading whitespace', raw: [queueCapabilityHeader, ' work-queue-v1'], advertised: false },
    { name: 'trailing whitespace', raw: [queueCapabilityHeader, 'work-queue-v1 '], advertised: false },
    { name: 'empty value', raw: [queueCapabilityHeader, ''], advertised: false },
    { name: 'non-token value', raw: [queueCapabilityHeader, 'work queue v1'], advertised: false },
    { name: 'normalized header without raw occurrence', raw: [], normalizedOnly: 'work-queue-v1', advertised: false }
];
const queueCapabilityCases = [
    ...[true, false].flatMap(enabled => ['staff', 'legacy', 'external'].flatMap(provider =>
        (provider === 'staff' ? [null] : ['consultant', 'company', null]).flatMap(accountType =>
            queueCapabilityRequests.map(request => ({ enabled, provider, accountType, request, header: request.name }))))),
    ...['legacy', 'external'].flatMap(provider => otherQueueCapabilityRequests.map(request =>
        ({ enabled: true, provider, accountType: 'consultant', request, header: request.name })))
];
test.each(queueCapabilityCases)
('session capability preserves old wire shape unless negotiated ($enabled, $provider, $accountType, $header)', async ({ enabled, provider, accountType, request: capability }) => {
    const h = fixture();
    if (enabled) h.options.improvementEnabled = true;
    const binding = jest.fn(async () => ({ bindingId: id(90), scope: { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' },
        ...(accountType ? { accountType } : {}) }));
    h.options.customer.resolveActivationBinding = binding;
    h.options.externalCustomer.resolveActivationBinding = binding;
    // Isolate only the already-validated persisted session projection. Provider
    // login/recheck, approved account binding and the HTTP response are genuine;
    // native request tests separately cover SQL authority and tenant isolation.
    const readSession = jest.fn(async () => ({ purpose: provider === 'staff' ? 'operator_dashboard' : 'customer',
        expiresAt: new Date(now + 3600000).toISOString(), generation: 'a'.repeat(64), selectedBindingId: id(90) }));
    let host;
    jest.isolateModules(() => {
        const runtime = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
        const replacement = jest.spyOn(runtime, 'createPostgresDashboardRuntimeRepository').mockReturnValue({ readSession });
        try { host = require('../api/shared/dashboardRuntimeHandlers').createDashboardRuntimeHandlers(h.options); }
        finally { replacement.mockRestore(); }
    });
    const services = provider === 'staff' ? host.authServices : provider === 'legacy' ? host.authServices.customer : host.authServices.externalCustomer;
    const issued = await login(services);
    const request = () => {
        const req = new (require('node:http').IncomingMessage)(new (require('node:net').Socket)());
        req.method = 'GET'; req.url = '/api/dashboard/session';
        req.headers = { cookie: issued.cookie }; req.rawHeaders = ['cookie', issued.cookie, ...capability.raw];
        for (let index = 0; index < capability.raw.length; index += 2) {
            const name = capability.raw[index].toLowerCase(), value = capability.raw[index + 1];
            req.headers[name] = Object.hasOwn(req.headers, name) ? req.headers[name] + ', ' + value : value;
        }
        if (capability.normalizedOnly) req.headers[queueCapabilityHeader.toLowerCase()] = capability.normalizedOnly;
        req.complete = true; req.push(null); return req;
    };
    const response = await host.handleRequest(request());
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    const advertised = enabled && accountType === 'consultant' && capability.advertised;
    expect(response.body).toEqual({ schemaVersion: 1, authenticated: true,
        purpose: provider === 'staff' ? 'operator_dashboard' : 'customer',
        expiresAt: new Date(now + 3600000).toISOString(), generation: 'a'.repeat(64), selectedBindingId: id(90),
        ...(accountType ? { accountType } : {}), ...(advertised ? { workQueueAvailable: true } : {}) });
    expect(binding).toHaveBeenCalledTimes(provider === 'staff' ? 0 : 1);
    expect(readSession).toHaveBeenCalledTimes(1);
    // A previously advertised capability does not survive lost authentication.
    h.store.sessions.clear();
    const denied = await host.handleRequest(request());
    expect(denied.status).toBe(401); expect(denied.body).not.toHaveProperty('workQueueAvailable');
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(binding).toHaveBeenCalledTimes(provider === 'staff' ? 0 : 1);
});

test('direct dashboard composer rejects an environment secret accessor without invoking it', () => {
    const h = fixture(), read = jest.fn(() => { throw new Error('legacy secret read'); });
    h.options.externalCustomer.client = { clientAssertion: jest.fn() };
    Object.defineProperty(h.baseAuth.env, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET', { get: read, enumerable: true });
    expect(() => createDashboardRuntimeHandlers(h.options)).toThrow(expect.objectContaining({ code: 'browser_auth_dashboard_unavailable' }));
    expect(read).not.toHaveBeenCalled();
});

test('direct dashboard composer isolates the assertion environment and retains staff and legacy login', async () => {
    const h = fixture(), clientAssertion = jest.fn();
    h.options.externalCustomer.client = { clientAssertion,
        clientApplication: h.options.externalCustomer.client.clientApplication };
    const services = createDashboardRuntimeHandlers(h.options).authServices;
    for (const [service, clientId] of [[services, id(2)], [services.customer, id(4)], [services.externalCustomer, id(7)]]) {
        const started = await service.login.beginLogin();
        expect(new URL(started.location).searchParams.get('client_id')).toBe(clientId);
    }
    expect(h.baseAuth.env.NOFRIES_ENTRA_CLIENT_SECRET).toBe('synthetic-staff');
    expect(h.baseAuth.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET).toBe('synthetic-legacy');
    expect(clientAssertion).not.toHaveBeenCalled();
});

test('explicit external transport has its own fixed callback and transaction cookie', async () => {
    const h = fixture(), auth = createBrowserAuthService({ ...h.externalAuth, now: () => now });
    const started = await auth.beginLogin();
    expect(new URL(started.location).searchParams.get('redirect_uri')).toBe('https://nofries.example.test/api/external-customer-auth/callback');
    expect(firstCookie(started)).toMatch(/^__Host-nofries-external-customer-tx=/);
});

test('staff, legacy and external callbacks and readers coexist without changing stored immutable subjects', async () => {
    const h = fixture(), host = createDashboardRuntimeHandlers(h.options), services = host.authServices;
    const issued = [await login(services), await login(services.customer), await login(services.externalCustomer)];
    const expected = [h.subjects.staff, h.subjects.legacy, h.subjects.external], allCookies = issued.map(value => value.cookie).join('; ');
    const snapshot = clone([...h.store.sessions]);
    for (const [i, service] of [services, services.customer, services.externalCustomer].entries()) {
        const read = await service.session.readSessionDetails(allCookies);
        expect(read.identity.subjectKey).toBe(expected[i].tenant + ':' + expected[i].oid);
    }
    expect([...h.store.sessions]).toEqual(snapshot);
    expect(h.proofs.size).toBe(3);
    expect(issued[2].result.cookie).toEqual(expect.arrayContaining([
        expect.stringMatching(/^__Host-nofries-auth=;.*Max-Age=0/),
        expect.stringMatching(/^__Host-nofries-customer=;.*Max-Age=0/)
    ]));
    expect(issued[1].result.cookie).toEqual(expect.arrayContaining([expect.stringMatching(/^__Host-nofries-external-customer=;.*Max-Age=0/)]));
});

test('external cookie is invisible to legacy/staff readers and standalone external reads retain the same subject', async () => {
    const h = fixture(), services = createDashboardRuntimeHandlers(h.options).authServices;
    const external = await login(services.externalCustomer), snapshot = clone([...h.store.sessions]);
    await expect(services.customer.session.readSessionDetails(external.cookie)).resolves.toBeNull();
    await expect(services.session.readSessionDetails(external.cookie)).resolves.toBeNull();
    expect((await readBrowserSessionDetails(external.cookie, { ...h.externalAuth, now: () => now })).identity.subjectKey).toBe(id(6) + ':' + id(8));
    expect([...h.store.sessions]).toEqual(snapshot);
});

test('external customer cannot activate accounts despite an administrator-list overlap, while the operator hook remains active', async () => {
    const http = require('supertest'), h = fixture();
    const externalSubject = h.subjects.external.tenant + ':' + h.subjects.external.oid;
    h.baseAuth.env.NOFRIES_ADMIN_SUBJECTS = externalSubject + ';' + h.subjects.staff.tenant + ':' + h.subjects.staff.oid;
    const read = jest.fn(async () => { throw new Error('Synthetic activation approval unavailable'); });
    const writeCompletion = jest.fn(async () => {});
    h.options.activation = { read, writeCompletion };
    h.options.pool.connect = jest.fn(h.options.pool.connect);
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    async function signIn(prefix) {
        const started = await http(app).get(prefix + '/login');
        expect(started.status).toBe(302);
        const result = await http(app).post(prefix + '/callback')
            .set('Cookie', started.headers['set-cookie'][0].split(';')[0]).type('form')
            .send({ code: 'synthetic-code', state: new URL(started.headers.location).searchParams.get('state') });
        expect(result.status).toBe(303);
        return result.headers['set-cookie'][0].split(';')[0];
    }
    const externalCookie = await signIn('/api/external-customer-auth');
    expect(externalCookie).toMatch(/^__Host-nofries-external-customer=/);
    const sessions = clone([...h.store.sessions]), proofs = clone([...h.proofs]);
    expect([...h.proofs.values()].map(value => value.kind)).toEqual(['customer_dashboard_issuance']);
    for (const phase of ['prepare', 'activate']) {
        const result = await http(app).post('/api/dashboard/session').set('Cookie', externalCookie)
            .set('Origin', h.baseAuth.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
            .send({ action: 'customer_activation', activationId: id(97), phase });
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ code: 'dashboard_access_denied' });
        expect(result.headers['set-cookie']).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled(); expect(writeCompletion).not.toHaveBeenCalled();
    expect(h.options.pool.connect).not.toHaveBeenCalled();
    const staffView = await http(app).get('/api/auth/session').set('Cookie', externalCookie);
    expect(staffView.status).toBe(401); expect(staffView.body.authenticated).toBe(false);
    expect((await readBrowserSessionDetails(externalCookie, { ...h.externalAuth, now: () => now })).identity.subjectKey)
        .toBe(externalSubject);
    expect([...h.store.sessions]).toEqual(sessions); expect([...h.proofs]).toEqual(proofs);

    // A genuine staff callback reaches the same approval reader before SQL.
    // The customer result therefore cannot pass through an absent/inert hook.
    const operatorCookie = await signIn('/api/auth');
    expect(operatorCookie).toMatch(/^__Host-nofries-auth=/);
    const operator = await http(app).post('/api/dashboard/session').set('Cookie', operatorCookie)
        .set('Origin', h.baseAuth.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
        .send({ action: 'customer_activation', activationId: id(97), phase: 'prepare' });
    expect(operator.status).toBe(503);
    expect(operator.body).toEqual({ code: 'dashboard_unavailable' });
    expect(read).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(id(97));
    expect(writeCompletion).not.toHaveBeenCalled(); expect(h.options.pool.connect).not.toHaveBeenCalled();
});

test('renaming an external customer cookie cannot create an operator session or damage another returning customer parent', async () => {
    const http = require('supertest'), h = fixture();
    h.options.pool.connect = jest.fn(h.options.pool.connect);
    const services = createDashboardRuntimeHandlers(h.options).authServices;
    const retained = await login(services.externalCustomer), forgedParent = await login(services.externalCustomer);
    const proofs = clone([...h.proofs]);
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    const forged = forgedParent.cookie.replace('__Host-nofries-external-customer=', '__Host-nofries-auth=');
    const result = await http(app).get('/api/auth/session').set('Cookie', forged);
    expect(result.status).toBe(401); expect(result.body.authenticated).toBe(false);
    expect([...h.proofs]).toEqual(proofs);
    expect([...h.proofs.values()].map(value => value.kind)).toEqual([
        'customer_dashboard_issuance', 'customer_dashboard_issuance'
    ]);
    expect(h.options.pool.connect).not.toHaveBeenCalled();
    // A rejected renamed parent may be deleted by the existing fail-closed
    // cleanup. It must neither acquire staff authority nor revoke another one.
    expect((await services.externalCustomer.session.readSessionDetails(retained.cookie)).identity.subjectKey)
        .toBe(h.subjects.external.tenant + ':' + h.subjects.external.oid);
    expect((await http(app).get('/api/auth/session').set('Cookie', retained.cookie)).body.authenticated).toBe(false);
});

test('an interrupted legacy attempt survives an external callback sent with its original cookie name', async () => {
    const h = fixture(), services = createDashboardRuntimeHandlers(h.options).authServices;
    const legacy = await services.customer.login.beginLogin();
    const input = { cookieHeader: firstCookie(legacy), body: { code: 'synthetic-code', state: new URL(legacy.location).searchParams.get('state') } };
    await expect(services.externalCustomer.callback.completeLogin(input)).rejects.toMatchObject({ code: 'browser_auth_transaction_missing' });
    const completed = await services.customer.callback.completeLogin(input);
    expect(completed.identity.subjectKey).toBe(id(1) + ':' + id(5));
    await expect(services.customer.callback.completeLogin(input)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
    expect(h.proofs.size).toBe(1);
});

test('external namespace binding rejects a copied legacy transport transaction even with the same provider profile', async () => {
    const h = fixture(), legacyTransport = { ...h.externalAuth }; delete legacyTransport.customerTransport;
    const old = createBrowserAuthService({ ...legacyTransport, now: () => now });
    const external = createBrowserAuthService({ ...h.externalAuth, now: () => now });
    const started = await old.beginLogin();
    await expect(external.completeLogin({ cookieHeader: firstCookie(started).replace('__Host-nofries-customer-tx', '__Host-nofries-external-customer-tx'),
        body: { code: 'synthetic-code', state: new URL(started.location).searchParams.get('state') } })).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
    expect(h.store.sessions.size).toBe(0);
});

test.each(['staff', 'missing profile', 'arbitrary path'])('external transport rejects %s configuration', kind => {
    const h = fixture(), options = { ...h.externalAuth, now: () => now };
    if (kind === 'staff') delete options.customerPolicy;
    if (kind === 'missing profile') delete options.customerIdentityProvider;
    if (kind === 'arbitrary path') options.customerTransport = '/custom/callback';
    expect(() => createBrowserAuthService(options)).toThrow(BrowserAuthError);
});

test('external composition rejects reusing the legacy customer app', () => {
    const h = fixture(); h.options.externalCustomer.identityProvider.clientId = id(4);
    h.options.externalCustomer.identityPolicy.audience = id(4);
    expect(() => createDashboardRuntimeHandlers(h.options)).toThrow(BrowserAuthError);
});

test('HTTP routes clear only the failed callback transaction and reject ambiguous customer cookies without reads', async () => {
    const http = require('supertest'), h = fixture();
    const load = jest.spyOn(h.store, 'loadSession');
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    const legacy = await http(app).get('/api/customer-auth/login');
    expect(legacy.status).toBe(302);
    const legacyCookie = legacy.headers['set-cookie'][0].split(';')[0];
    const external = await http(app).get('/api/external-customer-auth/login');
    expect(external.status).toBe(302);
    const externalCookie = external.headers['set-cookie'][0].split(';')[0];
    const mismatched = await http(app).post('/api/external-customer-auth/callback')
        .set('Cookie', externalCookie).type('form').send({ code: 'synthetic', state: new URL(legacy.headers.location).searchParams.get('state') });
    expect(mismatched.status).toBe(400);
    expect(mismatched.headers['set-cookie']).toBeUndefined();
    expect(h.store.transactions.size).toBe(2);
    const rejected = await http(app).post('/api/external-customer-auth/callback')
        .set('Cookie', externalCookie).type('form').send({ error: 'access_denied', state: new URL(external.headers.location).searchParams.get('state') });
    expect(rejected.status).toBe(400);
    expect(rejected.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-external-customer-tx=;.*Max-Age=0/)]);
    const completed = await http(app).post('/api/customer-auth/callback').set('Cookie', legacyCookie)
        .type('form').send({ code: 'synthetic', state: new URL(legacy.headers.location).searchParams.get('state') });
    expect(completed.status).toBe(303);
    const legacySession = completed.headers['set-cookie'][0].split(';')[0];
    const again = await http(app).get('/api/external-customer-auth/login');
    const returned = await http(app).post('/api/external-customer-auth/callback').set('Cookie', again.headers['set-cookie'][0].split(';')[0])
        .type('form').send({ code: 'synthetic', state: new URL(again.headers.location).searchParams.get('state') });
    expect(returned.status).toBe(303);
    expect(returned.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=/);
    const before = clone([...h.store.sessions]);
    load.mockClear();
    const ambiguous = await http(app).get('/api/dashboard/session')
        .set('Cookie', legacySession + '; ' + returned.headers['set-cookie'][0].split(';')[0]);
    expect(ambiguous.status).toBe(401);
    expect(load).not.toHaveBeenCalled();
    expect([...h.store.sessions]).toEqual(before);
});

test('both customer callback retries preserve their selected provider', async () => {
    const http = require('supertest'), h = fixture();
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    for (const [route, destination] of [
        ['/api/external-customer-auth', '/login?signin=retry&provider=external'],
        ['/api/customer-auth', '/login?signin=retry&provider=legacy']
    ]) {
        const started = await http(app).get(route + '/login');
        const failed = await http(app).post(route + '/callback').set('Accept', 'text/html')
            .set('Cookie', started.headers['set-cookie'][0].split(';')[0]).type('form')
            .send({ error: 'access_denied', state: new URL(started.headers.location).searchParams.get('state') });
        expect(failed.status).toBe(303); expect(failed.headers.location).toBe(destination);
    }
});

test('both customer login-start retries preserve their selected provider without changing staff or JSON failures', async () => {
    const http = require('supertest'), h = fixture();
    const fail = jest.fn(async () => { throw new BrowserAuthError(503, 'browser_auth_unavailable'); });
    h.baseAuth.clientApplication.getAuthCodeUrl = fail;
    h.options.externalCustomer.client.clientApplication.getAuthCodeUrl = fail;
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    for (const [route, provider] of [['/api/customer-auth', 'legacy'], ['/api/external-customer-auth', 'external']]) {
        const html = await http(app).get(route + '/login').set('Accept', 'text/html');
        expect(html.status).toBe(303); expect(html.headers.location).toBe('/login?signin=retry&provider=' + provider);
        expect(html.headers['set-cookie']).toBeUndefined();
        const json = await http(app).get(route + '/login').set('Accept', 'application/json');
        expect(json.status).toBe(503); expect(json.body.code).toBe('browser_auth_unavailable');
        expect(json.headers.location).toBeUndefined(); expect(json.headers['set-cookie']).toBeUndefined();
    }
    const staff = await http(app).get('/api/auth/login').set('Accept', 'text/html');
    expect(staff.status).toBe(503); expect(staff.headers.location).toBeUndefined();
    expect(staff.body.code).toBe('browser_auth_unavailable');
    expect(fail).toHaveBeenCalledTimes(5);
});

test.each([{ customerTransport: 'external' }, { customerEntry: true, customerTransport: 'legacy' },
    { customerEntry: true, customerTransport: 'https://untrusted.invalid' }])('customer login transport rejects unsupported configuration %j', options => {
    expect(() => require('../api/authLogin').createAuthLoginFunction(options)).toThrow('browser_auth_login_transport_invalid');
});

test('shared signup and retry pages use the selected service without reading a different customer', async () => {
    const http = require('supertest'), h = fixture();
    function signup(label) {
        return { env: h.baseAuth.env, loadState: jest.fn(async () => ({ status: 'create_account' })),
            acceptTerms: jest.fn(async () => { throw new Error(label + ' must not accept'); }),
            issueCsrfToken: async () => 's'.repeat(43), validateCsrfToken: async () => false };
    }
    const legacy = signup('legacy'), external = signup('external');
    const app = require('../server').createNoFriesApp({ dashboard: h.options, customerSignup: legacy, externalCustomerSignup: external });
    const externalCookie = '__Host-nofries-external-customer=' + 'x'.repeat(43), legacyCookie = '__Host-nofries-customer=' + 'y'.repeat(43);
    async function exerciseManualEntry(path, cookie, stateRoute, destination) {
        const page = await http(app).get(path).set('Cookie', cookie);
        expect(page.status).toBe(200);
        const { createDom } = require('./fixtures/dashboardDom'), vm = require('node:vm');
        const dom = createDom(), events = {}, create = dom.document.createElement;
        dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
        dom.document.getElementById = name => name === 'signup' ? dom.root : null;
        const fetch = jest.fn(async (url, options) => {
            const result = await http(app).get(url).set('Cookie', cookie);
            expect(options.method).toBe('GET');
            return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
        });
        const assign = jest.fn(), replace = jest.fn();
        vm.runInNewContext(page.text.match(/<script>([\s\S]*?)<\/script>/)[1], {
            document: dom.document, window: { fetch, location: { search: new URL(path, 'https://synthetic.invalid').search,
                hash: '', assign, replace }, addEventListener(name, fn) { events[name] = fn; } },
            AbortController, TextDecoder, URLSearchParams, setTimeout, clearTimeout
        });
        try {
            for (let i = 0; i < 5; i++) {
                await Promise.all(fetch.mock.results.filter(result => result.type === 'return').map(result => result.value));
                await new Promise(setImmediate);
            }
            expect(fetch.mock.calls.map(([url]) => url)).toEqual([stateRoute]);
            expect(assign).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
            dom.root.querySelector('button').click();
            expect(assign.mock.calls).toEqual([[destination]]); expect(replace).not.toHaveBeenCalled();
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally { events.pagehide?.(); }
    }
    for (const [path, destination] of [
        ['/signup', '/api/external-customer-auth/login'],
        ['/login?signin=retry&provider=external', '/api/external-customer-auth/login'],
        ['/signup?provider=external&account=choose', '/api/external-customer-auth/login?account=choose']
    ]) {
        await exerciseManualEntry(path, externalCookie, '/api/external-customer-signup/state', destination);
        expect(legacy.loadState).not.toHaveBeenCalled();
    }
    expect(external.loadState).toHaveBeenCalledTimes(3);
    await exerciseManualEntry('/signup', legacyCookie, '/api/customer-signup/state', '/api/customer-auth/login');
    expect(legacy.loadState).toHaveBeenCalledTimes(1); expect(external.loadState).toHaveBeenCalledTimes(3);
    external.loadState.mockClear(); legacy.loadState.mockClear();
    for (const path of ['/signup', '/login?provider=external', '/api/customer-signup/state', '/api/external-customer-signup/state']) {
        expect((await http(app).get(path).set('Cookie', legacyCookie + '; ' + externalCookie)).status).toBe(401);
    }
    expect(external.loadState).not.toHaveBeenCalled(); expect(legacy.loadState).not.toHaveBeenCalled();
    expect((await http(app).get('/login?provider=https://untrusted.invalid')).status).toBe(400);
});

test('external signup remains unavailable without an explicitly configured signup service', async () => {
    const http = require('supertest'), h = fixture();
    const app = require('../server').createNoFriesApp({ dashboard: h.options });
    const result = await http(app).get('/login?signin=retry&provider=external');
    expect(result.status).toBe(503); expect(result.text).toContain('Signup is unavailable');
    expect(result.text).not.toContain('organisation-form');
});

function publicEntryFixture({ defaultExternal = true, legacy = true, setupState = { state: 'start' }, setupStatus = 200 } = {}) {
    const h = fixture();
    const signup = () => ({ env: h.baseAuth.env, loadState: async () => ({ status: 'create_account' }),
        acceptTerms: async () => { throw new Error('No acceptance expected'); },
        issueCsrfToken: async () => 's'.repeat(43), validateCsrfToken: async () => false });
    if (!legacy) delete h.options.customer;
    const setup = setupState === null ? null : { handle: jest.fn(async () => ({ status: setupStatus, body: setupState })) };
    const app = require('../server').createNoFriesApp({ dashboard: h.options,
        ...(legacy ? { customerSignup: signup() } : {}), externalCustomerSignup: signup(),
        ...(defaultExternal ? { customerEntry: 'external' } : {}),
        ...(setup ? { organisationSetup: setup } : {}) });
    return { app, setup };
}

test.each([
    ['fresh default', '', { state: 'start' }, 'external'],
    ['legacy customer', '__Host-nofries-customer=' + 'l'.repeat(43), { state: 'start' }, 'legacy'],
    ['legacy continuation', '__Host-nofries_org_setup=' + 's'.repeat(43),
        { state: 'awaiting_code', requestId: id(201), accountType: null, emailHint: 's***@example.test' }, 'legacy'],
    ['external customer with old setup', '__Host-nofries-external-customer=' + 'e'.repeat(43) + '; __Host-nofries_org_setup=' + 's'.repeat(43),
        { state: 'verified', requestId: id(202), accountType: 'company', organisationName: 'Synthetic preserved',
            accessGranted: false, nextStep: 'details_required' }, 'external']
])('automatic static entry preserves %s without authentication or cookie mutation', async (_label, cookie, state, expected) => {
    const http = require('supertest'), h = publicEntryFixture({ setupState: state });
    const response = await http(h.app).get('/api/organisation-setup/state')
        .set('X-NoFries-Customer-Entry', 'auto').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(_label === 'external customer with old setup' ? { state: 'sign_in' } : state);
    expect(response.headers['x-nofries-customer-entry']).toBe(expected);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(h.setup.handle).toHaveBeenCalledTimes(_label === 'external customer with old setup' ? 0 : 1);
});

test.each(['unavailable', 'invalid projection', 'thrown failure'])('selected external entry does not read legacy setup with %s', async failure => {
    const http = require('supertest'), h = publicEntryFixture({ setupStatus: failure === 'unavailable' ? 503 : 200,
        setupState: failure === 'unavailable' ? { code: 'setup_unavailable' } : { state: 'verified', privateLegacyValue: 'must-not-read' } });
    if (failure === 'thrown failure') h.setup.handle.mockRejectedValue(new Error('Legacy store unavailable'));
    const result = await http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto')
        .set('Cookie', '__Host-nofries-external-customer=' + 'e'.repeat(43) + '; __Host-nofries_org_setup=' + 's'.repeat(43));
    expect(result.status).toBe(200); expect(result.body).toEqual({ state: 'sign_in' });
    expect(result.headers['x-nofries-customer-entry']).toBe('external');
    expect(result.headers['set-cookie']).toBeUndefined(); expect(h.setup.handle).not.toHaveBeenCalled();
});

test('external-cookie shortcut stays confined to marked entry and preserves ambiguity and availability gates', async () => {
    const http = require('supertest'), cookie = '__Host-nofries-external-customer=' + 'e'.repeat(43);
    const h = publicEntryFixture({ setupStatus: 503, setupState: { code: 'setup_unavailable' } });
    const explicit = await http(h.app).get('/api/organisation-setup/state').set('Cookie', cookie);
    expect(explicit.status).toBe(503); expect(explicit.headers['x-nofries-customer-entry']).toBeUndefined();
    expect(h.setup.handle).toHaveBeenCalledTimes(1); h.setup.handle.mockClear();
    for (const added of ['; __Host-nofries-customer=' + 'l'.repeat(43), '; __Host-nofries_org_setup=malformed']) {
        const failed = await http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto').set('Cookie', cookie + added);
        expect([401, 503]).toContain(failed.status); expect(failed.headers['x-nofries-customer-entry']).toBeUndefined();
        expect(failed.headers['set-cookie']).toBeUndefined();
    }
    expect(h.setup.handle).not.toHaveBeenCalled();
    const inactive = publicEntryFixture({ defaultExternal: false });
    const failed = await http(inactive.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto').set('Cookie', cookie);
    expect(failed.status).toBe(503); expect(failed.headers['x-nofries-customer-entry']).toBeUndefined();
    expect(inactive.setup.handle).not.toHaveBeenCalled();
});

test.each([
    '__Host-nofries-customer=l; __Host-nofries-external-customer=e',
    '__Host-nofries_org_setup=bad',
    '__Host-nofries_org_setup=' + 's'.repeat(43) + '; __Host-nofries_org_setup=' + 't'.repeat(43),
    '__Host-nofries_org_setup=' + 's'.repeat(43) + '; __Host-nofries_org_setup',
    '__Host-nofries_org_setup=' + 's'.repeat(43) + '; __Host-nofries_org_setup =bad',
    '__Host-nofries_org_setup',
    '__Host-nofries_org_setup =bad'
])('automatic static entry refuses ambiguous or invalid present cookie %s', async cookie => {
    const http = require('supertest'), h = publicEntryFixture();
    const response = await http(h.app).get('/api/organisation-setup/state')
        .set('X-NoFries-Customer-Entry', 'auto').set('Cookie', cookie);
    expect([401, 503]).toContain(response.status);
    expect(response.body).toEqual({ code: 'setup_unavailable' });
    expect(response.headers['x-nofries-customer-sign-in']).toBe('available');
    expect(response.headers['x-nofries-customer-entry']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(h.setup.handle).not.toHaveBeenCalled();
});

test('external-only fallback is confined to the marked canonical default-entry GET', async () => {
    const http = require('supertest'), h = publicEntryFixture({ legacy: false, setupState: null });
    const response = await http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto');
    expect(response.status).toBe(200); expect(response.body).toEqual({ state: 'sign_in' });
    expect(response.headers['x-nofries-customer-entry']).toBe('external');
    expect(response.headers['x-nofries-customer-sign-in']).toBeUndefined();
    for (const request of [
        http(h.app).get('/api/organisation-setup/state'),
        http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'unknown'),
        http(h.app).get('/api/organisation-setup/state?provider=legacy').set('X-NoFries-Customer-Entry', 'auto'),
        http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto').send({ unexpected: true }),
        http(h.app).post('/api/organisation-setup/request').set('X-NoFries-Customer-Entry', 'auto').send({ email: 'synthetic@example.test' }),
        http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto').set('Cookie', '__Host-nofries-customer=l')
    ]) {
        const result = await request;
        expect(result.status).toBe(503);
        expect(result.headers['x-nofries-customer-entry']).toBeUndefined();
        expect(result.headers['set-cookie']).toBeUndefined();
    }
});

test('default entry retains disabled-default legacy selection and never emits a hint on setup failure', async () => {
    const http = require('supertest'), legacy = publicEntryFixture({ defaultExternal: false });
    const result = await http(legacy.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto');
    expect(result.status).toBe(200); expect(result.headers['x-nofries-customer-entry']).toBe('legacy');
    const failed = publicEntryFixture({ setupStatus: 503, setupState: { code: 'setup_unavailable' } });
    const failure = await http(failed.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto');
    expect(failure.status).toBe(503); expect(failure.headers['x-nofries-customer-entry']).toBeUndefined();
    expect(failure.headers['x-nofries-customer-sign-in']).toBe('available');
});

test.each([true, false])('missing setup reader preserves unknown progress with legacy runtime=%s', async legacy => {
    const http = require('supertest'), h = publicEntryFixture({ legacy, setupState: null });
    const result = await http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto')
        .set('Cookie', '__Host-nofries_org_setup=' + 's'.repeat(43));
    expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'setup_unavailable' });
    expect(result.headers['x-nofries-customer-entry']).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['x-nofries-customer-sign-in']).toBe(legacy ? 'available' : undefined);
});

test('an external customer cookie keeps precedence over unreadable old setup without clearing it', async () => {
    const http = require('supertest'), h = publicEntryFixture({ legacy: false, setupState: null });
    const result = await http(h.app).get('/api/organisation-setup/state').set('X-NoFries-Customer-Entry', 'auto')
        .set('Cookie', '__Host-nofries-external-customer=' + 'e'.repeat(43) + '; __Host-nofries_org_setup=' + 's'.repeat(43));
    expect(result.status).toBe(200); expect(result.body).toEqual({ state: 'sign_in' });
    expect(result.headers['x-nofries-customer-entry']).toBe('external');
    expect(result.headers['set-cookie']).toBeUndefined();
});
