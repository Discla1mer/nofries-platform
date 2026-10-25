'use strict';
const crypto = require('node:crypto');
const { createBrowserAuthService } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createProductionApplication } = require('../lib/productionApplication');
const { denyOutbound, syntheticIdentityEnvironment, signerHarness, realIdentityBoundary,
    offlineMsal, response, flush, GENERIC, CONTEXT, METADATA_BASE, id } = require('./helpers/offlineCustomerSigner');
let escapes;
beforeEach(() => { jest.resetModules(); escapes = denyOutbound(); syntheticIdentityEnvironment(); });
afterEach(() => {
    try { expect(escapes).toEqual([]); }
    finally { jest.restoreAllMocks(); jest.useRealTimers(); }
});

test('actual MSAL authorization construction never invokes the actual signer or discovery', async () => {
    const h = signerHarness(), m = offlineMsal(h.callback);
    const url = new URL(await m.app.getAuthCodeUrl({ ...m.request, state: 'offline-state', nonce: 'offline-nonce' }));
    expect(url.origin + url.pathname).toBe(METADATA_BASE + '/oauth2/v2.0/authorize');
    expect(h.attempts).toHaveLength(0); expect(h.getToken).not.toHaveBeenCalled();
    expect(m.networkClient.sendGetRequestAsync).not.toHaveBeenCalled(); expect(m.calls).toHaveLength(0);
});

test('MOCKED VERIFICATION: actual callback/keys SDK/MSAL maps fresh assertion forms but fake exchange always denies', async () => {
    const h = signerHarness({ mockVerification: true }), m = offlineMsal(h.callback);
    for (let i = 0; i < 2; i++) await expect(m.exchange()).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(m.calls).toHaveLength(2); expect(m.networkClient.sendGetRequestAsync).not.toHaveBeenCalled();
    const ids = [];
    for (const [i, { form }] of m.calls.entries()) {
        const assertion = form.get('client_assertion'), parts = assertion.split('.');
        expect(form.get('client_id')).toBe(CONTEXT.clientId);
        expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        expect(form.get('code_verifier')).toBe(m.request.codeVerifier);
        expect(form.has('client_secret')).toBe(false);
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
        expect(claims).toMatchObject({ iss: CONTEXT.clientId, sub: CONTEXT.clientId, aud: CONTEXT.tokenEndpoint });
        expect(claims.exp - claims.iat).toBe(240); ids.push(claims.jti);
        expect(Buffer.from(parts[2], 'base64url')).toEqual(Buffer.alloc(384));
        expect(JSON.parse(h.calls[i * 2 + 1].body)).toEqual({ alg: 'PS256',
            value: crypto.createHash('sha256').update(parts.slice(0, 2).join('.')).digest('base64url') });
    }
    expect(new Set(ids).size).toBe(2);
});

test.each(['client', 'endpoint'])('actual callback rejects MSAL-resolved %s drift before any Key Vault or token request', async defect => {
    const h = signerHarness(), m = offlineMsal(h.callback,
        defect === 'client' ? { clientId: id(8) } : { endpoint: METADATA_BASE + '/wrong/token' });
    await expect(m.exchange()).rejects.toThrow(GENERIC);
    expect(h.attempts).toHaveLength(0); expect(m.calls).toHaveLength(0);
});

test.each(['native zero signature', 'revoked key', 'wrong wire key', 'missing wire key'])('%s prevents actual MSAL token submission', async defect => {
    const h = signerHarness(), m = offlineMsal(h.callback);
    if (defect === 'revoked key') h.body.attributes.enabled = false;
    if (defect === 'wrong wire key') h.signed.kid += 'changed';
    if (defect === 'missing wire key') delete h.signed.kid;
    await expect(m.exchange()).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(defect === 'revoked key' ? ['GET'] : ['GET', 'POST']);
    expect(m.calls).toHaveLength(0); expect(m.networkClient.sendGetRequestAsync).not.toHaveBeenCalled();
});

test('late sign POST cannot reach MSAL or free capacity before underlying settlement', async () => {
    jest.useFakeTimers();
    const h = signerHarness({ mockVerification: true }), m = offlineMsal(h.callback);
    const original = h.httpClient.sendRequest.getMockImplementation(), pendingResponses = [];
    h.httpClient.sendRequest.mockImplementation(request => {
        if (request.method !== 'POST' || !request.headers.has('authorization')) return original(request);
        h.calls.push({ ...request });
        return new Promise(resolve => pendingResponses.push(() => resolve(response(request, 200, h.signed))));
    });
    const pending = Array.from({ length: 4 }, () => m.exchange().catch(error => error));
    await flush(); await jest.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(pending)).every(e => e.message === GENERIC)).toBe(true);
    expect(pendingResponses).toHaveLength(4);
    expect(h.calls.filter(r => r.method === 'POST').every(r => r.abortSignal.aborted)).toBe(true);
    await expect(m.exchange()).rejects.toThrow(GENERIC);
    expect(pendingResponses).toHaveLength(4); expect(m.calls).toHaveLength(0);
    pendingResponses.forEach(release => release()); await flush(); await jest.advanceTimersByTimeAsync(0);
    expect(h.verify).not.toHaveBeenCalled(); expect(m.calls).toHaveLength(0);
    h.httpClient.sendRequest.mockImplementation(original);
    await expect(m.exchange()).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    expect(m.calls).toHaveLength(1); expect(h.verify).toHaveBeenCalledTimes(1);
});

function browser(m, { staff = false } = {}) {
    const store = new MemoryBrowserSessionStore();
    // Existing production constructor still requires this fake configuration
    // placeholder even when an assertion MSAL client is test-injected. This is
    // not secretless production strategy composition or runtime wiring.
    const env = { NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: id(5), NOFRIES_ENTRA_CLIENT_ID: id(6), NOFRIES_ENTRA_CLIENT_SECRET: 'OFFLINE_STAFF_PLACEHOLDER',
        NOFRIES_ALLOWED_SUBJECTS: id(5) + ':' + id(9), NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: id(2),
        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'OFFLINE_CONFIG_PLACEHOLDER_NEVER_SENT' };
    const policy = { begin: jest.fn(async () => ({ context: { kind: 'offline-customer' } })),
        verify: jest.fn(async () => { throw new Error('token must never reach policy'); }),
        recheck: jest.fn(async () => { throw new Error('no session exists'); }) };
    const service = createBrowserAuthService({ env, store, clientApplication: m.app,
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
        ...(staff ? {} : { customerPolicy: policy, customerTransport: 'external', customerIdentityProvider: {
            kind: 'external-id', tenantId: id(1), clientId: id(2), authority: 'https://synthetic-customer.ciamlogin.com/',
            issuer: `https://${id(1)}.ciamlogin.com/${id(1)}/v2.0`,
            authorizationEndpoint: METADATA_BASE + '/oauth2/v2.0/authorize' } }) });
    const createSession = jest.spyOn(store, 'createSession');
    return { service, store, policy, createSession };
}
async function begin(b) {
    const value = await b.service.beginLogin();
    return { cookieHeader: value.cookie.split(';')[0], body: {
        code: 'OFFLINE_NOT_AN_AUTHORIZATION_CODE', state: new URL(value.location).searchParams.get('state') } };
}

test.each(['native signature', 'revoked key', 'identity failure', 'identity timeout'])(
    'browser transaction creates no token/session/success cookie on %s', async defect => {
        if (defect === 'identity timeout') jest.useFakeTimers();
        const real = defect.startsWith('identity') ? realIdentityBoundary() : undefined;
        const releases = [];
        if (defect === 'identity timeout') real.httpClient.sendRequest.mockImplementation(request =>
            new Promise(resolve => releases.push(() => resolve(response(request, 400, { error: 'invalid_request' })))));
        const h = signerHarness({ identityBoundary: real }), m = offlineMsal(h.callback), b = browser(m);
        if (defect === 'revoked key') h.body.attributes.enabled = false;
        const existing = Object.freeze({ preserved: 'synthetic-existing-record' });
        b.store.sessions.set('existing-offline-record', existing);
        const input = await begin(b);
        const pending = b.service.completeLogin(input).catch(error => error);
        if (defect === 'identity timeout') { await flush(); await jest.advanceTimersByTimeAsync(5000); }
        const error = await pending;
        expect(error).toMatchObject({ code: 'browser_auth_code_exchange_failed', clearTransactionCookie: true });
        expect(error.cookie).toBeUndefined(); expect(error.identity).toBeUndefined(); expect(error.cause).toBeUndefined();
        expect(m.calls).toHaveLength(0); expect(b.createSession).not.toHaveBeenCalled();
        expect(b.store.transactions.size).toBe(0);
        expect([...b.store.sessions]).toEqual([['existing-offline-record', existing]]);
        expect(b.policy.verify).not.toHaveBeenCalled(); expect(b.policy.recheck).not.toHaveBeenCalled();
        await expect(b.service.completeLogin(input)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
        releases.forEach(release => release()); await flush();
        expect(m.calls).toHaveLength(0); expect(b.createSession).not.toHaveBeenCalled();
    });

test('independent staff browser/MSAL failure never invokes customer identity or signing', async () => {
    const h = signerHarness(), customer = offlineMsal(h.callback), staff = offlineMsal(null, { staff: true, clientId: id(6) });
    const b = browser(staff, { staff: true });
    await expect(b.service.completeLogin(await begin(b))).rejects.toMatchObject({ code: 'browser_auth_code_exchange_failed' });
    expect(h.attempts).toHaveLength(0); expect(h.getToken).not.toHaveBeenCalled();
    expect(customer.calls).toHaveLength(0); expect(staff.calls).toHaveLength(1);
    expect(staff.calls[0].form.get('client_secret')).toBe('OFFLINE_STAFF_PLACEHOLDER');
    expect(staff.calls[0].form.has('client_assertion')).toBe(false); expect(b.createSession).not.toHaveBeenCalled();
});

test.each([undefined, '', 'false'])('production composition with external flag %j reads no external credential or pin', enabled => {
    const externalReads = [];
    const env = new Proxy({ NODE_ENV: 'test', NOFRIES_EXTERNAL_CUSTOMER_ENABLED: enabled }, { get(target, key) {
        if (typeof key === 'string' && key.startsWith('NOFRIES_EXTERNAL_CUSTOMER_')) {
            externalReads.push(key);
            if (key !== 'NOFRIES_EXTERNAL_CUSTOMER_ENABLED') throw new Error('disabled_external_configuration_read');
        }
        return target[key];
    } });
    const ManagedIdentityCredential = jest.fn(() => { throw new Error('disabled_identity_construction'); });
    const app = createProductionApplication(env, { ManagedIdentityCredential });
    expect(typeof app).toBe('function'); expect(ManagedIdentityCredential).not.toHaveBeenCalled();
    expect(externalReads).toEqual(['NOFRIES_EXTERNAL_CUSTOMER_ENABLED']);
});
