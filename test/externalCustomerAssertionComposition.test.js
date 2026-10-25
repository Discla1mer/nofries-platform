'use strict';
// Real launcher, customer services, HTTP callback and session boundaries.
// Only local HTTP is allowed; identity/vault/provider transports are synthetic.
const request = require('supertest');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { configuration } = require('./helpers/publicCustomerAssertion');
const { options, transport } = require('./helpers/syntheticAppServiceTransport');
const { keyVaultTransport, apiRequire } = require('./helpers/offlineCustomerSigner');
const msal = apiRequire('@azure/msal-node');
let escapes;
beforeEach(() => {
    escapes = [];
    const deny = name => () => { escapes.push(name); throw new Error('offline-only'); };
    const original = http.request;
    jest.spyOn(http, 'request').mockImplementation(function (value, ...rest) {
        const url = typeof value === 'string' || value instanceof URL ? new URL(value) : value;
        if (!['127.0.0.1', '::1'].includes(url.hostname || url.host) ||
            !/^\/(?:api\/|signup|login)/.test(url.pathname || url.path || '')) return deny('nonlocal-http')();
        return original.call(this, value, ...rest);
    });
    jest.spyOn(https, 'request').mockImplementation(deny('https'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(deny('fetch'));
    for (const name of ['sign', 'createSign', 'generateKeyPair', 'generateKeyPairSync']) jest.spyOn(crypto, name).mockImplementation(deny(name));
});
afterEach(() => { try { expect(escapes).toEqual([]); } finally { jest.restoreAllMocks(); } });

function fixture(defect = 'native signature') {
    const t = transport(defect === 'identity' ? { status: 400, body: { error_description: 'OFFLINE_PRIVATE_FAILURE' } } : {});
    const vault = keyVaultTransport(), pins = configuration(), identity = options(), clients = [], credentials = [];
    if (defect === 'revoked') vault.body.attributes.enabled = false;
    const sdk = apiRequire('@azure/keyvault-keys');
    class KeyClient extends sdk.KeyClient {
        constructor(url, credential, settings) { super(url, credential, settings); credentials.push(credential); }
    }
    let externalProvider, completedExchanges = 0;
    jest.spyOn(msal, 'ConfidentialClientApplication').mockImplementation(function ({ auth }) {
        clients.push(auth);
        return { getAuthCodeUrl: input => externalProvider.getAuthCodeUrl(input),
            async acquireTokenByCode(input) {
                // The provider boundary invokes exactly the callback supplied by
                // production's MSAL constructor, using its configured identity.
                await auth.clientAssertion({ clientId: auth.clientId,
                    tokenEndpoint: `https://synthetic-customer.ciamlogin.com/${uid(101)}/oauth2/v2.0/token` });
                completedExchanges++;
                return externalProvider.acquireTokenByCode(input);
            }, getTokenCache: () => externalProvider.getTokenCache() };
    });
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env, dependencies }) {
            const selected = dependencies.externalCustomer, profile = selected.identityProvider;
            externalProvider = selected.client.clientApplication;
            Object.assign(env, { NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'true', NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED: 'true',
                NOFRIES_EXTERNAL_CUSTOMER_CREDENTIAL_MODE: 'app-service-assertion',
                NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: profile.tenantId, NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID: profile.clientId,
                NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY: profile.authority, NOFRIES_EXTERNAL_CUSTOMER_ISSUER: profile.issuer,
                NOFRIES_EXTERNAL_CUSTOMER_AUTHORIZATION_ENDPOINT: profile.authorizationEndpoint,
                NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT: profile.authorizationEndpoint.replace(/\/authorize$/, '/token'),
                NOFRIES_EXTERNAL_CUSTOMER_USER_FLOW_ID: selected.userFlowId,
                NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: selected.starterAuthorityContainer,
                NOFRIES_EXTERNAL_CUSTOMER_VAULT_ORIGIN: pins.vaultOrigin, NOFRIES_EXTERNAL_CUSTOMER_KEY_NAME: pins.keyName,
                NOFRIES_EXTERNAL_CUSTOMER_KEY_ID: pins.keyId, NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER: pins.certificateDer.toString('base64'),
                NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_SHA256: pins.certificateSha256,
                NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_KIND: identity.identity.kind,
                NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_CLIENT_ID: identity.identity.clientId,
                NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_TENANT_ID: identity.tenantId, ...identity.env });
            dependencies.customerAssertion = { identityRequest: t.request, httpClient: vault.httpClient, KeyClient };
            delete dependencies.externalCustomer;
        } });
    return { ...h, t, vault, clients, credentials, completedExchanges: () => completedExchanges };
}

test.each(['native signature', 'revoked', 'identity'])('real assertion composition fails closed on %s through the HTTP callback', async defect => {
    const h = fixture(defect), legacy = h.addUser({ email: h.state.externalEmail });
    const records = h.getContainer('customer-authority').records, before = [...records].map(([k, v]) => [k, v.toString()]);
    expect(h.t.request).not.toHaveBeenCalled();
    const login = await h.loginExternal();
    expect(login.response.status).toBeGreaterThanOrEqual(400);
    expect(login.response.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-external-customer-tx=;.*Max-Age=0/)]);
    expect(h.completedExchanges()).toBe(0);
    expect(h.clients.length).toBeGreaterThan(0);
    expect(new Set(h.clients.map(c => c.clientAssertion)).size).toBe(1);
    h.clients.forEach(c => { expect(c.clientId).toBe(uid(102)); expect(c).not.toHaveProperty('clientSecret'); });
    expect(h.getContainer('external-starter-authority').records.size).toBe(0);
    expect([...records].map(([k, v]) => [k, v.toString()])).toEqual(before);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0); expect(h.state.delivered).toEqual([]);
    expect(JSON.stringify(login.response.body)).not.toContain('OFFLINE_PRIVATE_FAILURE');
    const calls = h.t.calls.length;
    expect((await h.login(legacy)).response.status).toBe(303);
    expect(h.t.calls).toHaveLength(calls);
    expect((await request(h.app).get('/api/auth/login')).status).toBe(302);
    expect(h.t.calls).toHaveLength(calls);
});

test('multiple actual customer callbacks reuse one signer credential and preserve independent staff/legacy sessions', async () => {
    const h = fixture();
    await h.loginExternal(); await h.loginExternal();
    expect(h.credentials).toHaveLength(2); expect(new Set(h.credentials).size).toBe(1);
    expect(new Set(h.clients.map(c => c.clientAssertion)).size).toBe(1);
    expect(h.t.calls).toHaveLength(2); expect(h.completedExchanges()).toBe(0);
    expect((await request(h.app).get('/api/dashboard/session')).status).toBe(401);
    const denied = await h.sameOrigin(request(h.app).post('/api/dashboard/logout')).send({});
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(h.t.calls).toHaveLength(2);
});

test('HTTP callbacks retain the shared four-request budget after timeout until transports actually close', async () => {
    const h = fixture(); Object.assign(h.t.config, { phase: 'headers', ignoreDestroy: true });
    const results = await Promise.all(Array.from({ length: 5 }, () => h.loginExternal()));
    results.forEach(value => expect(value.response.status).toBeGreaterThanOrEqual(400));
    expect(h.t.calls).toHaveLength(4); expect(new Set(h.credentials).size).toBe(1);
    expect(h.completedExchanges()).toBe(0);
    expect((await h.loginExternal()).response.status).toBeGreaterThanOrEqual(400);
    expect(h.t.calls).toHaveLength(4);
    h.t.calls.forEach(call => call.close()); delete h.t.config.phase;
    expect((await h.loginExternal()).response.status).toBeGreaterThanOrEqual(400);
    expect(h.t.calls).toHaveLength(5); expect(h.completedExchanges()).toBe(0);
    expect(h.getContainer('external-starter-authority').records.size).toBe(0);
}, 15000);
