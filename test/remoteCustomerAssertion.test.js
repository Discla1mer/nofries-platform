'use strict';

// Offline contract tests only. The DER is deliberately invalid, the public RSA
// modulus has no corresponding private key in this fixture, and every returned
// "signature" is zero bytes. Positive certificate parsing/verification are
// explicitly mocked; no credential, actual signature or token is generated.
const crypto = require('node:crypto');
const { createRemoteCustomerAssertion } = require('../api/shared/customerSignup/remoteCustomerAssertion');
const id = n => '83000000-0000-4000-8000-' + String(n).padStart(12, '0');
const AT = Date.parse('2026-10-08T00:00:00Z');
const KEY_ID = 'https://synthetic-vault.vault.azure.net/keys/customer-assertion/' + 'a'.repeat(32);
const TOKEN = `https://synthetic-customer.ciamlogin.com/${id(1)}/oauth2/v2.0/token`;
const CONTEXT = { clientId: id(2), tokenEndpoint: TOKEN };
const GENERIC = 'Customer authentication is temporarily unavailable.';

function fixture() {
    const der = Buffer.alloc(256, 0x5c), n = Buffer.alloc(384, 0xb7), e = Buffer.from([1, 0, 1]);
    const publicKey = crypto.createPublicKey({ format: 'jwk', key: {
        kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url')
    } });
    const certificate = { raw: der, ca: false, publicKey,
        validFrom: new Date(AT - 3600000).toUTCString(), validTo: new Date(AT + 3600000).toUTCString() };
    const parser = jest.spyOn(crypto, 'X509Certificate').mockImplementation(() => certificate);
    const verify = jest.spyOn(crypto, 'verify').mockReturnValue(true);
    const key = { keyId: KEY_ID, enabled: true, kty: 'RSA', keyOperations: ['sign', 'verify'], n, e,
        notBefore: AT - 3600000, expiresAt: AT + 3600000 };
    const result = { keyId: KEY_ID, algorithm: 'PS256', signature: Buffer.alloc(384) };
    const options = { enabled: true, now: () => AT, configuration: {
        clientId: id(2), tokenEndpoint: TOKEN, vaultOrigin: 'https://synthetic-vault.vault.azure.net',
        keyName: 'customer-assertion', keyId: KEY_ID, certificateDer: der,
        certificateSha256: crypto.createHash('sha256').update(der).digest('hex')
    }, readPublicKey: jest.fn(async () => key), signDigest: jest.fn(async () => result) };
    return { options, certificate, key, result, parser, verify, create: () => createRemoteCustomerAssertion(options) };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each([undefined, false])('disabled %s never reads configuration or transport getters', enabled => {
    const options = { enabled };
    for (const name of ['configuration', 'readPublicKey', 'signDigest', 'now']) {
        Object.defineProperty(options, name, { get() { throw new Error('must not read'); } });
    }
    expect(createRemoteCustomerAssertion(options)).toBeNull();
});

test.each([null, { enabled: 'true' }, { enabled: 'false' }])('malformed options fail generically', options => {
    expect(() => createRemoteCustomerAssertion(options)).toThrow(GENERIC);
});

test('rejects mixed credential options without transport work', () => {
    const h = fixture(); h.options.clientSecret = 'UNUSABLE_MOCK_VALUE';
    expect(h.create).toThrow(GENERIC);
    expect(h.options.readPublicKey).not.toHaveBeenCalled();
});

test('mock success binds claims, hashes input once and verifies PS256 with salt32', async () => {
    const h = fixture(), callback = h.create();
    const value = await callback(CONTEXT), parts = value.split('.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', 'x5t#S256':
        Buffer.from(h.options.configuration.certificateSha256, 'hex').toString('base64url') });
    expect(claims).toEqual({ iss: id(2), sub: id(2), aud: TOKEN, jti: expect.any(String),
        iat: AT / 1000, nbf: AT / 1000 - 30, exp: AT / 1000 + 240 });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(300);
    const input = Buffer.from(parts.slice(0, 2).join('.'), 'ascii');
    const signed = h.options.signDigest.mock.calls[0][0];
    expect(signed).toEqual({ keyId: KEY_ID, algorithm: 'PS256',
        digest: crypto.createHash('sha256').update(input).digest(), signal: expect.any(AbortSignal) });
    expect(signed.digest).toHaveLength(32);
    expect(h.verify).toHaveBeenCalledWith('sha256', input, { key: h.certificate.publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.alloc(384));
    const next = JSON.parse(Buffer.from((await callback(CONTEXT)).split('.')[1], 'base64url'));
    expect(next.jti).not.toBe(claims.jti);
    expect(h.options.readPublicKey).toHaveBeenCalledTimes(2);
    expect(h.options.signDigest).toHaveBeenCalledTimes(2);
});

test.each([
    ['clientId', id(9)], ['tokenEndpoint', TOKEN + '?different=1']
])('callback %s drift fails before key reads or signing', async (field, value) => {
    const h = fixture(), callback = h.create();
    await expect(callback({ ...CONTEXT, [field]: value })).rejects.toThrow(GENERIC);
    expect(h.options.readPublicKey).not.toHaveBeenCalled();
    expect(h.options.signDigest).not.toHaveBeenCalled();
});

test.each([
    ['keyId', KEY_ID.replace(/a{32}$/, '')],
    ['keyId', KEY_ID.replace(/a{32}$/, 'latest')],
    ['keyId', KEY_ID + '?version=latest'],
    ['keyId', KEY_ID + '#different'],
    ['keyId', KEY_ID.replace('/keys/', '/keys/%2e%2e/')],
    ['keyId', KEY_ID.replace('synthetic-vault', 'different-vault')],
    ['keyId', KEY_ID.replace('customer-assertion', 'staff-assertion')],
    ['keyId', KEY_ID.replace('https://', 'https://user@')],
    ['keyId', KEY_ID.replace('.net/', '.net:443/')],
    ['tokenEndpoint', TOKEN.replace('https:', 'http:')],
    ['tokenEndpoint', TOKEN.replace('ciamlogin.com', 'example.test')],
    ['tokenEndpoint', TOKEN.replace('/token', '/authorize')],
    ['clientId', 'not-a-client-id'],
    ['certificateSha256', 'a'.repeat(64)],
    ['clientSecret', 'UNUSABLE_MOCK_VALUE']
])('rejects invalid pinned configuration %s: %s', (field, value) => {
    const h = fixture(); h.options.configuration[field] = value;
    expect(h.create).toThrow(GENERIC);
    expect(h.options.readPublicKey).not.toHaveBeenCalled();
    expect(h.options.signDigest).not.toHaveBeenCalled();
});

test('configuration is copied; later public metadata mutation cannot change the pin', async () => {
    const h = fixture(), callback = h.create();
    h.options.configuration.clientId = id(8);
    h.options.configuration.keyId = KEY_ID.replace('customer-assertion', 'changed');
    h.options.configuration.certificateDer.fill(0);
    await expect(callback(CONTEXT)).resolves.toEqual(expect.any(String));
    expect(h.options.readPublicKey.mock.calls[0][0].keyId).toBe(KEY_ID);
});

test.each([
    ['ca', true], ['raw', Buffer.alloc(256, 0x99)],
    ['validFrom', 'not-a-date'], ['validTo', 'not-a-date'],
    ['publicKey', { type: 'private' }],
    ['publicKey', { type: 'public', asymmetricKeyType: 'rsa', asymmetricKeyDetails: { modulusLength: 2048 } }]
])('rejects invalid certificate %s', (field, value) => {
    const h = fixture(); h.certificate[field] = value;
    expect(h.create).toThrow(GENERIC);
});

test.each([
    ['validFrom', AT], ['validTo', AT + 239000]
])('certificate %s must cover the entire assertion window', async (field, value) => {
    const h = fixture(); h.certificate[field] = new Date(value).toUTCString();
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.options.readPublicKey).not.toHaveBeenCalled();
});

test.each([
    ['keyId', KEY_ID.replace(/a{32}$/, 'b'.repeat(32))],
    ['enabled', false], ['kty', 'EC'], ['keyOperations', ['verify']],
    ['keyOperations', ['sign', 'decrypt']], ['n', Buffer.alloc(384, 0xa1)],
    ['e', Buffer.from([1, 0, 3])], ['notBefore', AT], ['expiresAt', AT + 239000],
    ['expiresAt', undefined]
])('key %s mismatch fails before signing', async (field, value) => {
    const h = fixture(); h.key[field] = value;
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.options.signDigest).not.toHaveBeenCalled();
});

test('unbounded key dates still use the pinned certificate validity window', async () => {
    const h = fixture(); h.key.notBefore = null; h.key.expiresAt = null;
    await expect(h.create()(CONTEXT)).resolves.toEqual(expect.any(String));
});

test.each([
    ['keyId', KEY_ID.replace(/a{32}$/, 'b'.repeat(32))],
    ['algorithm', 'RS256'], ['signature', Buffer.alloc(383)], ['signature', 'not-bytes']
])('signature response %s mismatch cannot return an assertion', async (field, value) => {
    const h = fixture(); h.result[field] = value;
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.verify).not.toHaveBeenCalled();
});

test('real native verifier rejects zero bytes against the public-only RSA3072 fixture', async () => {
    const h = fixture(); h.verify.mockRestore();
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
});

test('real native parser rejects the invalid mock DER without a key read', () => {
    const h = fixture(); h.parser.mockRestore();
    expect(h.create).toThrow(GENERIC);
    expect(h.options.readPublicKey).not.toHaveBeenCalled();
});

test.each(['readPublicKey', 'signDigest'])('%s errors are generic, silent and are not retried', async port => {
    const h = fixture(), consoleSpies = ['log', 'warn', 'error'].map(name => jest.spyOn(console, name));
    h.options[port].mockRejectedValue(Object.assign(new Error('SENSITIVE_MOCK_REQUEST_BODY'), { statusCode: 429 }));
    const error = await h.create()(CONTEXT).catch(value => value);
    expect(error.message).toBe(GENERIC);
    expect(error.code).toBe('customer_assertion_unavailable');
    expect(error.statusCode).toBe(503); expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('SENSITIVE');
    expect(h.options[port]).toHaveBeenCalledTimes(1);
    consoleSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
});

test.each(['readPublicKey', 'signDigest'])('late %s completion cannot escape timeout or continue signing', async port => {
    jest.useFakeTimers();
    const h = fixture(); let resolve;
    h.options[port].mockImplementation(() => new Promise(done => { resolve = done; }));
    const callback = h.create(), pending = callback(CONTEXT).catch(error => error);
    await jest.advanceTimersByTimeAsync(5000);
    expect((await pending).message).toBe(GENERIC);
    expect(h.options[port].mock.calls[0][0].signal.aborted).toBe(true);
    resolve(port === 'readPublicKey' ? h.key : h.result);
    await jest.advanceTimersByTimeAsync(0);
    if (port === 'readPublicKey') expect(h.options.signDigest).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
});

test('abort-ignoring operations retain the four-request cap until actual settlement', async () => {
    jest.useFakeTimers();
    const h = fixture(), resolves = [];
    h.options.readPublicKey.mockImplementation(() => new Promise(resolve => resolves.push(resolve)));
    const callback = h.create();
    const requests = Array.from({ length: 4 }, () => callback(CONTEXT).catch(error => error));
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.options.readPublicKey).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(requests)).every(error => error.message === GENERIC)).toBe(true);
    await expect(callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.options.readPublicKey).toHaveBeenCalledTimes(4);
    resolves.forEach(resolve => resolve(h.key));
    await jest.advanceTimersByTimeAsync(0);
    h.options.readPublicKey.mockResolvedValue(h.key);
    await expect(callback(CONTEXT)).resolves.toEqual(expect.any(String));
    expect(h.options.signDigest).toHaveBeenCalledTimes(1);
});

test('public-key read and signing share one total deadline', async () => {
    jest.useFakeTimers();
    const h = fixture(); let releaseRead, releaseSign;
    h.options.readPublicKey.mockImplementation(() => new Promise(resolve => { releaseRead = resolve; }));
    h.options.signDigest.mockImplementation(() => new Promise(resolve => { releaseSign = resolve; }));
    const pending = h.create()(CONTEXT).catch(error => error);
    await jest.advanceTimersByTimeAsync(4000);
    releaseRead(h.key);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.options.signDigest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending).message).toBe(GENERIC);
    expect(h.options.signDigest.mock.calls[0][0].signal.aborted).toBe(true);
    releaseSign(h.result);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.verify).not.toHaveBeenCalled();
});

test('clock deadline after public-key read stops before signing', async () => {
    const h = fixture(); let at = AT; h.options.now = () => at;
    h.options.readPublicKey.mockImplementation(async () => { at += 5000; return h.key; });
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.options.signDigest).not.toHaveBeenCalled();
});

test.each([AT - 1, AT + 5000, NaN])('clock drift %s rejects a response without returning an assertion', async value => {
    const h = fixture(); let at = AT; h.options.now = () => at;
    h.options.signDigest.mockImplementation(async () => { at = value; return h.result; });
    await expect(h.create()(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.verify).not.toHaveBeenCalled();
});
