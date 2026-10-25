'use strict';
// Public-only replay through actual source and SDKs. No signing or key generation
// happens in these tests, and the in-memory token endpoint always rejects.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { externalCustomerConfiguration } = require('../lib/externalCustomerConfiguration');
const fixture = require('./fixtures/customerAssertion/native-callback-public.json');
const { jwk: otherPublicKey } = require('./helpers/publicCustomerAssertion');
const { options, transport } = require('./helpers/syntheticAppServiceTransport');
const { denyOutbound, syntheticIdentityEnvironment, keyVaultTransport, offlineMsal, GENERIC, id } = require('./helpers/offlineCustomerSigner');
const certificate = new crypto.X509Certificate(Buffer.from(fixture.certificateDer, 'base64'));
const context = { clientId: fixture.clientId, tokenEndpoint: fixture.tokenEndpoint };
const REAL_TIME_APIS = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'Intl', 'Temporal',
    'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
let escapes;

beforeEach(() => {
    escapes = denyOutbound();
    syntheticIdentityEnvironment();
    jest.spyOn(crypto, 'createPrivateKey').mockImplementation(() => { escapes.push('private-key-import'); throw new Error('offline_private_key_forbidden'); });
    expect(jest.isMockFunction(crypto.verify)).toBe(false);
});
afterEach(() => {
    try { expect(escapes).toEqual([]); }
    finally { jest.useRealTimers(); jest.restoreAllMocks(); }
});

function configured(vector, defect) {
    // The SDK checks key expiry with new Date(); freeze it with Date.now() while
    // retaining real transport deadlines and task scheduling.
    jest.useFakeTimers({ doNotFake: REAL_TIME_APIS,
        now: vector.nowMs + (defect === 'timestamp' ? 1000 : 0) });
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(defect === 'uuid' ? id(99) : vector.jti);
    const identity = options(), identityTransport = transport(), vault = keyVaultTransport();
    Object.assign(vault.body.key, { n: fixture.publicJwk.n, e: fixture.publicJwk.e });
    Object.assign(vault.body.attributes, { nbf: Date.parse(certificate.validFrom) / 1000,
        exp: Date.parse(certificate.validTo) / 1000 });
    vault.signed.value = vector.signature;
    if (defect === 'signature') {
        const changed = Buffer.from(vector.signature, 'base64url'); changed[0] ^= 1;
        vault.signed.value = changed.toString('base64url');
    }
    if (defect === 'public key') vault.body.key.n = otherPublicKey.n;
    const env = { NODE_ENV: 'test', NOFRIES_ENTRA_TENANT_ID: id(5), NOFRIES_ENTRA_CLIENT_ID: id(6),
        NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'true', NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED: 'false',
        NOFRIES_EXTERNAL_CUSTOMER_CREDENTIAL_MODE: 'app-service-assertion',
        NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: id(1), NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID: fixture.clientId,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY: 'https://synthetic-customer.ciamlogin.com/',
        NOFRIES_EXTERNAL_CUSTOMER_ISSUER: `https://${id(1)}.ciamlogin.com/${id(1)}/v2.0`,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORIZATION_ENDPOINT: fixture.tokenEndpoint.replace(/\/token$/, '/authorize'),
        NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT: fixture.tokenEndpoint,
        NOFRIES_EXTERNAL_CUSTOMER_USER_FLOW_ID: 'SyntheticEmailPassword',
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-starter-authority',
        NOFRIES_EXTERNAL_CUSTOMER_VAULT_ORIGIN: new URL(fixture.keyId).origin,
        NOFRIES_EXTERNAL_CUSTOMER_KEY_NAME: 'customer-assertion', NOFRIES_EXTERNAL_CUSTOMER_KEY_ID: fixture.keyId,
        NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER: fixture.certificateDer,
        NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_SHA256: fixture.certificateSha256,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_KIND: identity.identity.kind,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_CLIENT_ID: identity.identity.clientId,
        NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_TENANT_ID: identity.tenantId, ...identity.env };
    const selected = externalCustomerConfiguration(env, { customerAssertion: {
        identityRequest: identityTransport.request, httpClient: vault.httpClient } });
    expect(Object.keys(selected.client)).toEqual(['clientAssertion']);
    return { callback: selected.client.clientAssertion, identityTransport, vault };
}

function expectExactDigest(h, vector) {
    expect(h.identityTransport.calls).toHaveLength(1);
    expect(h.vault.calls.map(call => call.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(h.vault.calls[1].body)).toEqual({ alg: 'PS256', value: vector.digestSha256 });
}

test('pinned disposable fixture contains only a matching public RSA3072 leaf and native PS256 vectors', () => {
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,
        'fixtures/customerAssertion/native-callback-public.json'))).digest('hex'))
        .toBe('49f59153ac05f87b22ba4481779f90a803c3eedf7d202432e242fd39c77a6135');
    expect(Object.keys(fixture).sort()).toEqual(['schemaVersion', 'purpose', 'generatedUtc', 'pythonVersion',
        'cryptographyVersion', 'algorithm', 'hash', 'mgfHash', 'saltLength', 'clientId', 'tokenEndpoint',
        'keyId', 'certificateDer', 'certificateSha256', 'publicJwk', 'vectors'].sort());
    expect(Object.keys(fixture.publicJwk).sort()).toEqual(['e', 'kty', 'n']);
    expect(fixture).toMatchObject({ schemaVersion: 1, algorithm: 'PS256', hash: 'SHA-256', mgfHash: 'SHA-256', saltLength: 32 });
    expect(certificate.ca).toBe(false);
    expect(certificate.subject).toContain('DISPOSABLE OFFLINE TEST - NEVER REGISTER');
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.publicKey.asymmetricKeyDetails.modulusLength).toBe(3072);
    expect(certificate.publicKey.export({ format: 'jwk' })).toEqual(fixture.publicJwk);
    expect(crypto.createHash('sha256').update(certificate.raw).digest('hex')).toBe(fixture.certificateSha256);
    expect(fixture.vectors).toHaveLength(2);
    expect(new Set(fixture.vectors.map(vector => vector.jti)).size).toBe(2);
    for (const vector of fixture.vectors) {
        expect(Object.keys(vector).sort()).toEqual(['nowMs', 'jti', 'signingInput', 'digestSha256', 'signature'].sort());
        const signature = Buffer.from(vector.signature, 'base64url'), input = Buffer.from(vector.signingInput, 'ascii');
        expect(signature).toHaveLength(384);
        expect(crypto.createHash('sha256').update(input).digest('base64url')).toBe(vector.digestSha256);
        expect(crypto.verify('sha256', input, { key: certificate.publicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)).toBe(true);
        expect(crypto.verify('sha256', input, { key: certificate.publicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, signature)).toBe(false);
    }
});

test.each(fixture.vectors)('actual configured callback returns a natively verified JWT for $jti', async vector => {
    const h = configured(vector);
    await expect(h.callback(context)).resolves.toBe(`${vector.signingInput}.${vector.signature}`);
    expectExactDigest(h, vector);
});

test.each(fixture.vectors)('actual MSAL submits native callback JWT $jti only to the rejecting offline endpoint', async vector => {
    const h = configured(vector), msal = offlineMsal(h.callback);
    await expect(msal.exchange()).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    expectExactDigest(h, vector);
    expect(msal.networkClient.sendGetRequestAsync).not.toHaveBeenCalled();
    expect(msal.calls).toHaveLength(1);
    const form = msal.calls[0].form;
    expect(form.get('client_assertion')).toBe(`${vector.signingInput}.${vector.signature}`);
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(form.get('client_id')).toBe(fixture.clientId);
    expect(form.get('code_verifier')).toBe(msal.request.codeVerifier);
    expect(form.has('client_secret')).toBe(false);
});

test.each(['signature', 'uuid', 'timestamp', 'public key'])('changed %s prevents native callback token submission', async defect => {
    const vector = fixture.vectors[0], h = configured(vector, defect), msal = offlineMsal(h.callback);
    await expect(msal.exchange()).rejects.toThrow(GENERIC);
    expect(msal.calls).toHaveLength(0);
    expect(h.identityTransport.calls).toHaveLength(1);
    expect(h.vault.calls.map(call => call.method)).toEqual(defect === 'public key' ? ['GET'] : ['GET', 'POST']);
    if (defect === 'uuid' || defect === 'timestamp') {
        expect(JSON.parse(h.vault.calls[1].body).value).not.toBe(vector.digestSha256);
    }
});
