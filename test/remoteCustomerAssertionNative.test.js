'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRemoteCustomerAssertion, verifyRemoteCustomerSignature } = require('../api/shared/customerSignup/remoteCustomerAssertion');
const fixture = require('./fixtures/customerAssertion/wycheproof-rsa3072-pss.json');
const { certificate, configuration, jwk, keyId, tokenEndpoint, id } = require('./helpers/publicCustomerAssertion');
const publicKey = crypto.createPublicKey({ key: Buffer.from(fixture.publicKeyDer, 'hex'), format: 'der', type: 'spki' });
const good = fixture.tests.find(test => test.result === 'valid');
const binding = { keyId, publicKey };
const response = test => ({ keyId, algorithm: 'PS256', signature: Buffer.from(test.sig, 'hex') });

test('public fixture provenance and policy parameters are pinned', () => {
    expect(fixture).toMatchObject({ keySize: 3072, sha: 'SHA-256', mgfSha: 'SHA-256', saltLength: 32,
        upstreamCommit: '12fd3aaf33eb5fa1f52e026912ee00c054f9d984' });
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,
        'fixtures/customerAssertion/openssl-rsa3072-leaf.pem'))).digest('hex'))
        .toBe('88ae70e2689a20dd5284dd40593c7070e1c7873296c7e5b4fd34630375f92820');
    expect(certificate.publicKey.asymmetricKeyDetails.modulusLength).toBe(3072);
    expect(certificate.ca).toBe(false);
    // These are independent published fixtures, not a matching full JWT vector.
    expect(publicKey.equals(certificate.publicKey)).toBe(false);
});

test.each(fixture.tests)('native PS256 public vector $tcId: $comment ($result)', value => {
    const verify = () => verifyRemoteCustomerSignature(binding, Buffer.from(value.msg, 'hex'), response(value));
    if (value.result === 'valid') expect(verify()).toEqual(Buffer.from(value.sig, 'hex'));
    else { expect(value.result).toBe('invalid'); expect(verify).toThrow('temporarily unavailable'); }
});

test.each(['input', 'signature', 'key', 'algorithm', 'keyId'])('native verifier rejects changed %s', defect => {
    let input = Buffer.from(good.msg, 'hex'), result = response(good), pinned = binding;
    if (defect === 'input') input = Buffer.concat([input, Buffer.from([1])]);
    if (defect === 'signature') result.signature[0] ^= 1;
    if (defect === 'key') pinned = { keyId, publicKey: certificate.publicKey };
    if (defect === 'algorithm') result.algorithm = 'RS256';
    if (defect === 'keyId') result.keyId += 'different';
    expect(() => verifyRemoteCustomerSignature(pinned, input, result)).toThrow('temporarily unavailable');
});

test('native PSS vector fails with wrong salt length or PKCS1 padding', () => {
    const input = Buffer.from(good.msg, 'hex'), signature = Buffer.from(good.sig, 'hex');
    expect(crypto.verify('sha256', input, { key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, signature)).toBe(false);
    expect(crypto.verify('sha256', input, { key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING }, signature)).toBe(false);
});

function nativeCallback(overrides = {}) {
    const readPublicKey = jest.fn(async () => ({ keyId, enabled: true, kty: 'RSA', keyOperations: ['sign', 'verify'],
        n: Buffer.from(jwk.n, 'base64url'), e: Buffer.from(jwk.e, 'base64url'), notBefore: null, expiresAt: null }));
    const signDigest = jest.fn(async () => ({ keyId, algorithm: 'PS256', signature: Buffer.alloc(384) }));
    const callback = createRemoteCustomerAssertion({ enabled: true, configuration: configuration(),
        readPublicKey, signDigest, now: () => Date.parse('2026-10-08T00:00:00Z'), ...overrides });
    return { callback, readPublicKey, signDigest };
}

test('real leaf DER passes native configuration and key binding; zero signature is rejected', async () => {
    const h = nativeCallback();
    await expect(h.callback({ clientId: id(2), tokenEndpoint })).rejects.toThrow('temporarily unavailable');
    expect(h.readPublicKey).toHaveBeenCalledTimes(1);
    expect(h.signDigest).toHaveBeenCalledTimes(1);
});

test.each([Date.parse(certificate.validFrom) - 1, Date.parse(certificate.validTo) - 239000])(
    'native certificate rejects invalid assertion validity window at %s', async at => {
        const h = nativeCallback({ now: () => at });
        await expect(h.callback({ clientId: id(2), tokenEndpoint })).rejects.toThrow('temporarily unavailable');
        expect(h.readPublicKey).not.toHaveBeenCalled(); expect(h.signDigest).not.toHaveBeenCalled();
    });

test('native parser cannot silently ignore trailing DER, even when its hash is pinned', () => {
    const config = configuration(); config.certificateDer = Buffer.concat([config.certificateDer, Buffer.from([0])]);
    config.certificateSha256 = crypto.createHash('sha256').update(config.certificateDer).digest('hex');
    expect(() => nativeCallback({ configuration: config })).toThrow('temporarily unavailable');
});
