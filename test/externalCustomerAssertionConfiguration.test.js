'use strict';
const { externalCustomerConfiguration } = require('../lib/externalCustomerConfiguration');
const { createProductionApplication } = require('../lib/productionApplication');
const { createBrowserAuthService } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createExternalCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { configuration, id } = require('./helpers/publicCustomerAssertion');
const { options, transport } = require('./helpers/syntheticAppServiceTransport');
const { denyOutbound, syntheticIdentityEnvironment, keyVaultTransport, apiRequire, offlineMsal } = require('./helpers/offlineCustomerSigner');

let escapes;
beforeEach(() => { escapes = denyOutbound(); syntheticIdentityEnvironment(); });
afterEach(() => { try { expect(escapes).toEqual([]); } finally { jest.restoreAllMocks(); } });

function fixture() {
    const c = configuration(), identity = options(), t = transport(), vault = keyVaultTransport();
    const env = { NODE_ENV: 'test', NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: id(5), NOFRIES_ENTRA_CLIENT_ID: id(6),
        NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'true', NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED: 'false',
        NOFRIES_EXTERNAL_CUSTOMER_CREDENTIAL_MODE: 'app-service-assertion',
        NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: id(1), NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID: c.clientId,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY: 'https://synthetic-customer.ciamlogin.com/',
        NOFRIES_EXTERNAL_CUSTOMER_ISSUER: `https://${id(1)}.ciamlogin.com/${id(1)}/v2.0`,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORIZATION_ENDPOINT: c.tokenEndpoint.replace(/\/token$/, '/authorize'),
        NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT: c.tokenEndpoint,
        NOFRIES_EXTERNAL_CUSTOMER_USER_FLOW_ID: 'SyntheticEmailPassword',
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-starter-authority',
        NOFRIES_EXTERNAL_CUSTOMER_VAULT_ORIGIN: c.vaultOrigin, NOFRIES_EXTERNAL_CUSTOMER_KEY_NAME: c.keyName,
        NOFRIES_EXTERNAL_CUSTOMER_KEY_ID: c.keyId,
        NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER: c.certificateDer.toString('base64'),
        NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_SHA256: c.certificateSha256,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_KIND: identity.identity.kind,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_CLIENT_ID: identity.identity.clientId,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_TENANT_ID: identity.tenantId, ...identity.env };
    const credentials = [], sdk = apiRequire('@azure/keyvault-keys');
    class KeyClient extends sdk.KeyClient {
        constructor(url, credential, settings) { super(url, credential, settings); credentials.push(credential); }
    }
    return { env, t, vault, credentials,
        dependencies: { customerAssertion: { identityRequest: t.request, httpClient: vault.httpClient, KeyClient } } };
}

test.each([undefined, '', 'false'])('disabled strategy %j reads no selector, pin, secret or dependency', enabled => {
    const env = new Proxy({ NODE_ENV: 'test', NOFRIES_EXTERNAL_CUSTOMER_ENABLED: enabled }, { get(target, key) {
        if (typeof key === 'string' && (key.startsWith('IDENTITY_') || key.startsWith('NOFRIES_EXTERNAL_CUSTOMER_')) &&
            key !== 'NOFRIES_EXTERNAL_CUSTOMER_ENABLED') throw new Error('disabled read');
        return target[key];
    } });
    const dependencies = { get customerAssertion() { throw new Error('disabled dependency read'); } };
    expect(externalCustomerConfiguration(env, dependencies)).toBeNull();
    expect(typeof createProductionApplication(env, dependencies)).toBe('function');
});

test('mixed assertion/secret config is rejected by presence without reading the secret or constructing transport', () => {
    const h = fixture(), read = jest.fn(() => { throw new Error('secret read'); });
    Object.defineProperty(h.env, 'NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET', { get: read, enumerable: true });
    expect(() => createProductionApplication(h.env, h.dependencies)).toThrow('external_customer_configuration_invalid');
    expect(read).not.toHaveBeenCalled(); expect(h.t.request).not.toHaveBeenCalled(); expect(h.credentials).toEqual([]);
});

test.each(['clientAssertion', 'clientSecret'])('direct signup composer excludes the legacy secret before copying for %s', credential => {
    const h = customerProductionHarness({ starter: true, external: true });
    const dashboard = createProductionDashboardConfiguration(h.env, h.dependencies);
    const env = { ...h.env }, read = jest.fn(() => { throw new Error('legacy secret read'); });
    Object.defineProperty(env, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET', { get: read, enumerable: true });
    const value = credential === 'clientAssertion' ? jest.fn() : 'synthetic-selected-external';
    const external = { ...h.dependencies.externalCustomer, client: { [credential]: value } };
    const composed = createExternalCustomerSignupConfiguration(env, dashboard, h.dependencies, external);
    expect(composed.customer.client[credential]).toBe(value);
    const selected = composed.customerSignup.env;
    expect(Object.hasOwn(selected, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET')).toBe(credential === 'clientSecret');
    if (credential === 'clientSecret') expect(selected.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET).toBe(value);
    expect(selected.NOFRIES_ENTRA_CLIENT_SECRET).toBe(h.env.NOFRIES_ENTRA_CLIENT_SECRET);
    expect(Object.getOwnPropertyDescriptor(env, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET').get).toBe(read);
    expect(read).not.toHaveBeenCalled();
});

test.each([
    ['unknown mode', { NOFRIES_EXTERNAL_CUSTOMER_CREDENTIAL_MODE: 'automatic' }],
    ['other token endpoint', { NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT: `https://other.ciamlogin.com/${id(1)}/oauth2/v2.0/token` }],
    ['other tenant', { NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT: `https://synthetic-customer.ciamlogin.com/${id(9)}/oauth2/v2.0/token` }],
    ['staff client', { NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID: id(6) }],
    ['noncanonical certificate', { NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER: 'YQ' }],
    ['oversized certificate', { NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER: 'A'.repeat(22000) }],
    ['wrong pin', { NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_SHA256: '0'.repeat(64) }],
    ['unversioned key', { NOFRIES_EXTERNAL_CUSTOMER_KEY_ID: 'https://synthetic-vault.vault.azure.net/keys/customer-assertion' }],
    ['missing hosting tenant', { NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_TENANT_ID: undefined }],
    ['missing hosting client', { NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_CLIENT_ID: undefined }]
])('invalid %s fails before any request', (_label, delta) => {
    const h = fixture(); Object.assign(h.env, delta);
    expect(() => externalCustomerConfiguration(h.env, h.dependencies)).toThrow();
    expect(h.t.request).not.toHaveBeenCalled(); expect(h.vault.httpClient.sendRequest).not.toHaveBeenCalled();
});

test('actual configured factory shares one credential across operations and native rejection prevents token submission', async () => {
    const h = fixture(), reads = [];
    const env = new Proxy(h.env, { get(target, key) {
        if (typeof key === 'string' && key.endsWith('CLIENT_SECRET')) { reads.push(key); throw new Error('secret read'); }
        return target[key];
    } });
    const selected = externalCustomerConfiguration(env, h.dependencies);
    expect(Object.keys(selected.client)).toEqual(['clientAssertion']); expect(reads).toEqual([]);
    expect(h.t.request).not.toHaveBeenCalled();
    const m = offlineMsal(selected.client.clientAssertion);
    await expect(m.exchange()).rejects.toThrow(); await expect(m.exchange()).rejects.toThrow();
    expect(h.credentials.length).toBe(2); expect(new Set(h.credentials).size).toBe(1);
    expect(h.t.calls).toHaveLength(2); expect(m.calls).toHaveLength(0);
    expect(h.vault.calls.filter(call => call.method === 'POST')).toHaveLength(2);
});

test.each(['staff', 'legacy', 'mixed', 'not callable'])('browser rejects %s assertion credentials before MSAL', kind => {
    const h = fixture(), selected = externalCustomerConfiguration(h.env, h.dependencies);
    const env = { ...h.env, NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: id(2) };
    const policy = { begin() {}, verify() {}, recheck() {} };
    const input = { env, store: new MemoryBrowserSessionStore(), customerPolicy: policy,
        customerIdentityProvider: selected.identityProvider, customerTransport: 'external',
        clientAssertion: selected.client.clientAssertion };
    if (kind === 'staff') { delete input.customerPolicy; delete input.customerIdentityProvider; delete input.customerTransport; }
    if (kind === 'legacy') delete input.customerTransport;
    if (kind === 'mixed') Object.defineProperty(env, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET', { get() { throw new Error('must not read'); } });
    if (kind === 'not callable') input.clientAssertion = 'not-a-callback';
    expect(() => createBrowserAuthService(input)).toThrow(expect.objectContaining({ code: 'browser_auth_customer_credential_invalid' }));
    expect(h.t.request).not.toHaveBeenCalled();
});
