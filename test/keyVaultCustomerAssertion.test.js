'use strict';
// Real keys SDK, wholly offline HTTP and identity doubles. Successful callback
// tests explicitly mock signature verification; returned signatures are zeros.
const crypto = require('node:crypto');
const { createHttpHeaders } = require('@azure/core-rest-pipeline');
const { createKeyVaultCustomerAssertion } = require('../api/shared/customerSignup/keyVaultCustomerAssertion');
const { configuration, keyBody, keyId, tokenEndpoint, id } = require('./helpers/publicCustomerAssertion');
const CONTEXT = { clientId: id(2), tokenEndpoint };
const GENERIC = 'Customer authentication is temporarily unavailable.';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function harness({ identity = { kind: 'system-assigned' }, nativeVerification = false } = {}) {
    const calls = [], attempts = [], body = keyBody();
    const signed = { kid: keyId, value: Buffer.alloc(384).toString('base64url') };
    const getToken = jest.fn(async () => ({ token: 'OFFLINE_NOT_A_REAL_TOKEN', expiresOnTimestamp: Date.now() + 3600000 }));
    const ManagedIdentityCredential = jest.fn(function () { this.getToken = getToken; });
    const httpClient = { sendRequest: jest.fn(async request => {
        attempts.push({ ...request, headers: createHttpHeaders(request.headers.toJSON()) });
        // Any unexpected URL/method is denied by this transport, never sent.
        const url = new URL(request.url);
        if (url.origin !== 'https://synthetic-vault.vault.azure.net' ||
            url.searchParams.size !== 1 || url.searchParams.get('api-version') !== '2025-07-01' ||
            !((request.method === 'GET' && url.origin + url.pathname === keyId) ||
            (request.method === 'POST' && url.origin + url.pathname === keyId + '/sign'))) throw new Error('offline_unexpected_request');
        if (!request.headers.has('authorization')) return { request, status: 401,
            headers: createHttpHeaders({ 'www-authenticate': `Bearer authorization="https://login.microsoftonline.com/${id(1)}", resource="https://vault.azure.net"` }), bodyAsText: '{}' };
        calls.push({ ...request });
        return { request, status: 200, headers: createHttpHeaders({ 'content-type': 'application/json' }),
            bodyAsText: JSON.stringify(request.method === 'GET' ? body : signed) };
    }) };
    const verify = nativeVerification ? null : jest.spyOn(crypto, 'verify').mockReturnValue(true);
    const options = { enabled: true, configuration: configuration(), managedIdentity: identity };
    const dependencies = { ManagedIdentityCredential, httpClient };
    Object.defineProperty(dependencies, 'DefaultAzureCredential', { get() { throw new Error('ambient fallback forbidden'); } });
    return { options, dependencies, calls, attempts, body, signed, getToken, ManagedIdentityCredential, httpClient, verify,
        create: () => createKeyVaultCustomerAssertion(options, dependencies) };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('uses the pinned official keys SDK in both governed closures', () => {
    const root = require('../package-lock.json'), api = require('../api/package-lock.json');
    const installed = require('@azure/keyvault-keys/package.json');
    expect(installed.version).toBe('4.10.2');
    for (const lock of [root, api]) {
        expect(lock.packages[''].dependencies['@azure/keyvault-keys']).toBe('4.10.2');
        expect(lock.packages['node_modules/@azure/keyvault-keys'].version).toBe(installed.version);
    }
});

test.each([undefined, false])('disabled %s performs no config, dependency or credential access', enabled => {
    const options = { enabled }, dependencies = new Proxy({}, { get() { throw new Error('no dependency access'); } });
    for (const field of ['configuration', 'managedIdentity', 'now']) Object.defineProperty(options, field, {
        get() { throw new Error('no config access'); }
    });
    expect(createKeyVaultCustomerAssertion(options, dependencies)).toBeNull();
});

test.each([{ kind: 'system-assigned' }, { kind: 'user-assigned', clientId: id(7) }])(
    'selects explicit identity %j and executes exact SDK versioned GET/digest POST without local signing', async identity => {
        const h = harness({ identity });
        const sign = jest.spyOn(crypto, 'sign').mockImplementation(() => { throw new Error('local signing forbidden'); });
        const createSign = jest.spyOn(crypto, 'createSign').mockImplementation(() => { throw new Error('local signing forbidden'); });
        const callback = h.create();
        expect(h.ManagedIdentityCredential).toHaveBeenCalledWith({ retryOptions: { maxRetries: 0 },
            ...(identity.clientId ? { clientId: identity.clientId } : {}) });
        expect(h.calls).toHaveLength(0); expect(h.getToken).not.toHaveBeenCalled();
        const value = await callback(CONTEXT), input = value.split('.').slice(0, 2).join('.');
        expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']);
        expect(h.attempts.filter(r => !r.headers.has('authorization')).every(r => r.body === null)).toBe(true);
        const sent = JSON.parse(h.calls[1].body);
        expect(sent).toEqual({ alg: 'PS256', value: crypto.createHash('sha256').update(input).digest('base64url') });
        expect(h.calls.every(r => r.abortSignal instanceof AbortSignal && r.timeout === 5000)).toBe(true);
        expect(sign).not.toHaveBeenCalled(); expect(createSign).not.toHaveBeenCalled();
    });

test('root deployment closure also preserves exact digest transport with its locked dependencies', async () => {
    const h = harness();
    const { KeyClient, CryptographyClient } = require('@azure/keyvault-keys');
    Object.assign(h.dependencies, { KeyClient, CryptographyClient });
    const value = await h.create()(CONTEXT), input = value.split('.').slice(0, 2).join('.');
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(h.calls[1].body)).toEqual({ alg: 'PS256',
        value: crypto.createHash('sha256').update(input).digest('base64url') });
});

test.each([null, {}, { kind: 'default' }, { kind: 'user-assigned' },
    { kind: 'system-assigned', clientId: id(7) }, { kind: 'user-assigned', clientId: 'bad' },
    { kind: 'user-assigned', clientId: id(7), objectId: id(8) },
    Object.assign(Object.create({ kind: 'system-assigned' }), { unexpected: true })])('rejects ambiguous identity %j before construction', identity => {
    const h = harness({ identity });
    expect(h.create).toThrow(GENERIC); expect(h.ManagedIdentityCredential).not.toHaveBeenCalled();
});

test('invalid configuration or mixed secret fails before SDK/credential construction', () => {
    const h = harness(); h.options.configuration.keyId += '/latest';
    expect(h.create).toThrow(GENERIC); expect(h.ManagedIdentityCredential).not.toHaveBeenCalled();
    h.options.configuration = configuration(); h.options.clientSecret = 'OFFLINE_INVALID';
    expect(h.create).toThrow(GENERIC); expect(h.ManagedIdentityCredential).not.toHaveBeenCalled();
});

test('SDK normalizes epoch-second key validity into dates then adapter epoch milliseconds', async () => {
    const h = harness(), callback = h.create();
    h.body.attributes.nbf = Math.floor(Date.now() / 1000) + 3600;
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET']);
});

test.each(['changed version', 'private field', 'disabled', 'expired', 'bad dates', 'changed modulus'])('rejects %s metadata before POST', async defect => {
    const h = harness();
    if (defect === 'changed version') h.body.key.kid = keyId.replace(/a{32}$/, 'b'.repeat(32));
    if (defect === 'private field') h.body.key.d = 'NOT_A_KEY';
    if (defect === 'disabled') h.body.attributes.enabled = false;
    if (defect === 'expired') h.body.attributes.exp = 1;
    if (defect === 'bad dates') h.body.attributes.exp = 'not-a-time';
    if (defect === 'changed modulus') h.body.key.n = Buffer.alloc(384, 0xb7).toString('base64url');
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET']);
});

test.each(['missing kid', 'wrong kid', 'wrong signature'])('rejects wire signing response: %s', async defect => {
    const h = harness();
    if (defect === 'missing kid') delete h.signed.kid;
    if (defect === 'wrong kid') h.signed.kid = keyId.replace(/a{32}$/, 'b'.repeat(32));
    if (defect === 'wrong signature') h.signed.value = Buffer.alloc(383).toString('base64url');
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']);
    expect(h.verify).not.toHaveBeenCalled();
});

test.each([403, 429, 503, 307])('HTTP %s is not retried or redirected and errors stay generic', async status => {
    const h = harness();
    h.httpClient.sendRequest.mockImplementation(async request => {
        h.calls.push({ ...request });
        return { request, status, headers: createHttpHeaders({ 'content-type': 'application/json',
            'retry-after': '0', location: 'https://forbidden.example.test/' }),
        bodyAsText: JSON.stringify({ error: { code: 'Denied', message: 'SENSITIVE_OFFLINE_BODY' } }) };
    });
    const error = await h.create()(CONTEXT).catch(value => value);
    expect(error.message).toBe(GENERIC); expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('SENSITIVE'); expect(h.calls).toHaveLength(1);
});

test('native signature verification rejects the offline zero response after real SDK transport', async () => {
    const h = harness({ nativeVerification: true });
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']);
});

test('SDK uses only the injected managed-identity token boundary for a valid vault challenge', async () => {
    const h = harness(), original = h.httpClient.sendRequest.getMockImplementation(); let challenged = false;
    h.httpClient.sendRequest.mockImplementation(async request => {
        if (!challenged) {
            challenged = true;
            return { request, status: 401, headers: createHttpHeaders({
                'www-authenticate': `Bearer authorization="https://login.microsoftonline.com/${id(1)}", resource="https://vault.azure.net"`
            }), bodyAsText: '{}' };
        }
        return original(request);
    });
    await expect(h.create()(CONTEXT)).resolves.toEqual(expect.any(String));
    expect(h.getToken).toHaveBeenCalled();
    expect(h.getToken.mock.calls[0][0]).toEqual(['https://vault.azure.net/.default']);
});

test('abort-ignoring SDK transport cannot escape the total deadline or free capacity early', async () => {
    jest.useFakeTimers();
    const h = harness(), releases = [];
    h.httpClient.sendRequest.mockImplementation(request => { h.calls.push({ ...request }); return new Promise(resolve => releases.push(() =>
        resolve({ request, status: 200, headers: createHttpHeaders({ 'content-type': 'application/json' }),
            bodyAsText: JSON.stringify(h.body) }))); });
    const callback = h.create(), pending = Array.from({ length: 4 }, () => callback(CONTEXT).catch(e => e));
    await flush(); await jest.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(pending)).every(e => e.message === GENERIC)).toBe(true);
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls).toHaveLength(4); expect(h.calls.every(r => r.abortSignal.aborted)).toBe(true);
    releases.forEach(release => release()); await flush(); await jest.advanceTimersByTimeAsync(0);
    expect(h.calls.every(r => r.method === 'GET')).toBe(true); expect(h.verify).not.toHaveBeenCalled();
});

test('unrelated challenge resource is rejected before even the fake token provider', async () => {
    const h = harness();
    h.httpClient.sendRequest.mockImplementation(async request => ({ request, status: 401,
        headers: createHttpHeaders({ 'www-authenticate': 'Bearer resource="https://unrelated.example.test"' }), bodyAsText: '{}' }));
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.getToken).not.toHaveBeenCalled(); expect(h.httpClient.sendRequest).toHaveBeenCalledTimes(1);
});

test.each([403, 429, 503, 307])('sign-stage HTTP %s cannot retry, redirect or return an assertion', async status => {
    const h = harness(), original = h.httpClient.sendRequest.getMockImplementation();
    h.httpClient.sendRequest.mockImplementation(async request => {
        if (request.method !== 'POST' || !request.headers.has('authorization')) return original(request);
        h.calls.push({ ...request });
        return { request, status, headers: createHttpHeaders({ 'content-type': 'application/json',
            'retry-after': '0', location: 'https://unrelated.example.test/' }),
        bodyAsText: JSON.stringify({ error: { code: 'Denied', message: 'SENSITIVE_OFFLINE_BODY' } }) };
    });
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']); expect(h.verify).not.toHaveBeenCalled();
});

test('each callback fetches fresh metadata; revoked key cannot use the prior public-key object', async () => {
    const h = harness(), callback = h.create();
    await expect(callback(CONTEXT)).resolves.toEqual(expect.any(String));
    h.body.attributes.enabled = false;
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST', 'GET']);
    expect(h.verify).toHaveBeenCalledTimes(1);
});

test('missing optional validity dates are accepted only within the pinned certificate window', async () => {
    const h = harness(); delete h.body.attributes.nbf; delete h.body.attributes.exp;
    await expect(h.create()(CONTEXT)).resolves.toEqual(expect.any(String));
    expect(h.calls.map(r => r.method)).toEqual(['GET', 'POST']);
});

test('verbose SDK logging excludes fake bearer, digest, signature and assertion values', async () => {
    const apiRequire = require('node:module').createRequire(require.resolve('../api/shared/customerSignup/keyVaultCustomerAssertion'));
    const { AzureLogger, setLogLevel, getLogLevel } = apiRequire('@azure/logger');
    const level = getLogLevel(), output = [];
    jest.spyOn(AzureLogger, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    setLogLevel('verbose');
    try {
        const h = harness(), value = await h.create()(CONTEXT);
        const digest = JSON.parse(h.calls[1].body).value, logged = output.join('\n');
        expect(logged).toContain('Request:');
        for (const forbidden of ['OFFLINE_NOT_A_REAL_TOKEN', digest, h.signed.value, value]) {
            expect(logged).not.toContain(forbidden);
        }
    } finally { setLogLevel(level); }
});
