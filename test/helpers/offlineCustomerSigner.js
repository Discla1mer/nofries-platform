'use strict';
// Test-only composition. No transport delegates to a network implementation.
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const apiRequire = createRequire(require.resolve('../../api/shared/customerSignup/keyVaultCustomerAssertion'));
const { createHttpHeaders } = apiRequire('@azure/core-rest-pipeline');
const { createKeyVaultCustomerAssertion } = require('../../api/shared/customerSignup/keyVaultCustomerAssertion');
const { configuration, keyBody, keyId, tokenEndpoint, id } = require('./publicCustomerAssertion');
const GENERIC = 'Customer authentication is temporarily unavailable.';
const AUTHORITY = 'https://synthetic-customer.ciamlogin.com/';
const METADATA_BASE = tokenEndpoint.replace(/\/oauth2\/v2\.0\/token$/, '');
const IDENTITY_ENDPOINT = 'http://127.0.0.1:47111/offline-identity';
const IDENTITY_HEADER = 'OFFLINE_HEADER_NOT_A_CREDENTIAL';
const FAKE_TOKEN = 'OFFLINE_NOT_A_REAL_TOKEN';
const ERROR_DETAIL = 'OFFLINE_IDENTITY_ERROR_DETAIL';
const CONTEXT = { clientId: id(2), tokenEndpoint };
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };

function denyOutbound() {
    const escapes = [];
    const deny = name => () => { escapes.push(name); throw new Error('offline_network_escape_' + name); };
    for (const [name, object, method] of [
        ['socket', require('node:net').Socket.prototype, 'connect'],
        ['tls', require('node:tls'), 'connect'],
        ['http', require('node:http'), 'request'], ['httpGet', require('node:http'), 'get'],
        ['https', require('node:https'), 'request'], ['httpsGet', require('node:https'), 'get'],
        ['dns', require('node:dns'), 'lookup'],
        ['spawn', require('node:child_process'), 'spawn'],
        ['execFile', require('node:child_process'), 'execFile'],
        ['execFileSync', require('node:child_process'), 'execFileSync'],
        ['exec', require('node:child_process'), 'exec']
    ]) jest.spyOn(object, method).mockImplementation(deny(name));
    jest.spyOn(globalThis, 'fetch').mockImplementation(deny('fetch'));
    jest.spyOn(crypto, 'sign').mockImplementation(deny('local-sign'));
    jest.spyOn(crypto, 'createSign').mockImplementation(deny('local-createSign'));
    jest.spyOn(crypto, 'generateKeyPair').mockImplementation(deny('key-generation'));
    jest.spyOn(crypto, 'generateKeyPairSync').mockImplementation(deny('key-generation-sync'));
    return escapes;
}

function syntheticIdentityEnvironment() {
    // Replace rather than inspect/copy the executor's environment credentials.
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test',
        IDENTITY_ENDPOINT, IDENTITY_HEADER });
}

function response(request, status, body, headers = {}) {
    return { request, status, headers: createHttpHeaders({ 'content-type': 'application/json', ...headers }),
        bodyAsText: JSON.stringify(body) };
}

function realIdentityBoundary() {
    const { ManagedIdentityCredential } = apiRequire('@azure/identity');
    const requests = [], instances = [], optionsReceived = [];
    const httpClient = { sendRequest: jest.fn(async request => {
        requests.push(request);
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.origin + url.pathname !== IDENTITY_ENDPOINT ||
            url.searchParams.get('resource') !== 'https://vault.azure.net' ||
            request.headers.get('x-identity-header') !== IDENTITY_HEADER) throw new Error('offline_identity_request_mismatch');
        return response(request, 400, { error: 'invalid_request', error_description: ERROR_DETAIL });
    }) };
    class TransportOnlyManagedIdentity extends ManagedIdentityCredential {
        constructor(options) {
            super({ ...options, httpClient });
            optionsReceived.push(options); instances.push(this);
        }
    }
    return { ManagedIdentityCredential: TransportOnlyManagedIdentity, httpClient, requests, instances, optionsReceived };
}

function keyVaultTransport() {
    const calls = [], attempts = [], body = keyBody();
    const signed = { kid: keyId, value: Buffer.alloc(384).toString('base64url') };
    const httpClient = { sendRequest: jest.fn(async request => {
        attempts.push({ ...request });
        const url = new URL(request.url);
        if (url.origin !== new URL(keyId).origin || url.searchParams.size !== 1 ||
            url.searchParams.get('api-version') !== '2025-07-01' ||
            !((request.method === 'GET' && url.origin + url.pathname === keyId) ||
            (request.method === 'POST' && url.origin + url.pathname === keyId + '/sign'))) throw new Error('offline_keyvault_request_mismatch');
        if (!request.headers.has('authorization')) return response(request, 401, {}, {
            'www-authenticate': `Bearer authorization="https://login.microsoftonline.com/${id(1)}", resource="https://vault.azure.net"`
        });
        calls.push({ ...request });
        return response(request, 200, request.method === 'GET' ? body : signed);
    }) };
    return { calls, attempts, body, signed, httpClient };
}

function signerHarness({ identityBoundary, mockVerification = false, managedIdentity = { kind: 'system-assigned' } } = {}) {
    const transport = keyVaultTransport();
    const getToken = jest.fn(async () => ({ token: FAKE_TOKEN, expiresOnTimestamp: Date.now() + 3600000 }));
    const credential = identityBoundary?.ManagedIdentityCredential || class FakeIdentity { getToken(...args) { return getToken(...args); } };
    // Positive transport/form tests deliberately mock verification of zero bytes.
    // This cannot establish a valid signature or a native positive callback.
    const verify = mockVerification ? jest.spyOn(crypto, 'verify').mockReturnValue(true) : null;
    const callback = createKeyVaultCustomerAssertion({ enabled: true,
        configuration: configuration(), managedIdentity }, { ManagedIdentityCredential: credential, httpClient: transport.httpClient });
    return { callback, ...transport, getToken, verify };
}

function offlineMsal(callback, { clientId = id(2), endpoint = tokenEndpoint, staff = false } = {}) {
    const { ConfidentialClientApplication } = apiRequire('@azure/msal-node');
    const calls = [];
    const metadataBase = staff ? `https://login.microsoftonline.com/${id(5)}` : METADATA_BASE;
    const authority = staff ? metadataBase : AUTHORITY;
    const token = staff ? metadataBase + '/oauth2/v2.0/token' : endpoint;
    const networkClient = {
        sendGetRequestAsync: jest.fn(async () => { throw new Error('offline_discovery_forbidden'); }),
        sendPostRequestAsync: jest.fn(async (url, options) => {
            if (url.split('?')[0] !== token) throw new Error('offline_token_endpoint_mismatch');
            calls.push({ url, form: new URLSearchParams(options.body) });
            return { status: 400, headers: {}, body: { error: 'invalid_grant', error_description: 'offline_exchange_always_denied' } };
        })
    };
    const app = new ConfidentialClientApplication({ auth: { clientId, authority,
        knownAuthorities: [new URL(authority).hostname],
        authorityMetadata: JSON.stringify({ authorization_endpoint: metadataBase + '/oauth2/v2.0/authorize',
            token_endpoint: token, issuer: metadataBase + '/v2.0', jwks_uri: metadataBase + '/discovery/v2.0/keys',
            end_session_endpoint: metadataBase + '/oauth2/v2.0/logout' }),
        ...(staff ? { clientSecret: 'OFFLINE_STAFF_PLACEHOLDER' } : { clientAssertion: callback }) },
    system: { networkClient, loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false } } });
    const request = { code: 'OFFLINE_NOT_AN_AUTHORIZATION_CODE',
        redirectUri: 'https://nofries.example.test/api/external-customer-auth/callback',
        scopes: ['openid', 'profile'], codeVerifier: 'v'.repeat(64) };
    return { app, calls, networkClient, request, exchange: () => app.acquireTokenByCode(request) };
}

function captureIdentityLogs(level = 'verbose') {
    const { AzureLogger, setLogLevel, getLogLevel } = apiRequire('@azure/logger');
    const previous = getLogLevel(), output = [];
    jest.spyOn(AzureLogger, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    setLogLevel(level);
    return { output, restore: () => setLogLevel(previous) };
}

module.exports = { apiRequire, denyOutbound, syntheticIdentityEnvironment, realIdentityBoundary, keyVaultTransport,
    signerHarness, offlineMsal, captureIdentityLogs, response, flush, GENERIC, CONTEXT,
    IDENTITY_ENDPOINT, IDENTITY_HEADER, FAKE_TOKEN, ERROR_DETAIL, METADATA_BASE, id };
