'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const forge = require('node-forge');

// Parser regressions informed by digitalbazaar/forge PRs #1152 and #1157:
// ceba34402e329f0365134f23fe19898756527d65 and
// 683ab3344899cc08a581e4d5675a33e87aff7b04. These signatures are constructed
// with an ephemeral synthetic private key; they are not a forgery proof.
const UPSTREAM_INTEGRITY = 'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==';
const MESSAGE = Buffer.from('No Fries synthetic RSA DigestInfo regression');
const DIGEST = crypto.createHash('sha256').update(MESSAGE).digest();
const WRONG_DIGEST = Buffer.from(DIGEST.map((byte, index) => index === 0 ? byte ^ 1 : byte));
const SHA256_OID = Buffer.from('608648016503040201', 'hex');
const INVALID_DIGEST_INFO = 'ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value.';
let fixtureDirectory, upstream, privatePem, publicPem, privateKey, publicKey, upstreamPublicKey;

beforeAll(() => {
    const archive = path.join(__dirname, '../vendor/node-forge-rsa-validated/upstream-node-forge-1.4.0.tgz');
    const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
    expect(integrity).toBe(UPSTREAM_INTEGRITY);
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-forge-baseline-'));
    execFileSync('tar', ['-xzf', archive, '-C', fixtureDirectory], { stdio: 'pipe' });
    upstream = require(path.join(fixtureDirectory, 'package/lib'));
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
    privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    privateKey = forge.pki.privateKeyFromPem(privatePem);
    publicKey = forge.pki.publicKeyFromPem(publicPem);
    upstreamPublicKey = upstream.pki.publicKeyFromPem(publicPem);
});

afterAll(() => {
    if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

// Independent, bounded DER construction keeps the input bytes explicit instead
// of depending on Forge's encoder to create the malformed ASN.1 structures.
function der(tag, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.concat(value);
    if (bytes.length >= 128) throw new Error('Synthetic DER helper accepts short lengths only');
    return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

function encodedDigestInfo({ parameters, extraChild = false, indefinite = false } = {}) {
    const algorithm = [der(0x06, SHA256_OID)];
    if (parameters !== undefined) algorithm.push(der(0x05, parameters));
    if (extraChild) algorithm.push(der(0x04, Buffer.from('nested garbage')));
    const body = Buffer.concat([der(0x30, algorithm), der(0x04, DIGEST)]);
    return indefinite
        ? Buffer.concat([Buffer.from([0x30, 0x80]), body, Buffer.from([0, 0])])
        : der(0x30, body);
}

function signatureFor(options) {
    return crypto.privateEncrypt({ key: privatePem, padding: crypto.constants.RSA_PKCS1_PADDING },
        encodedDigestInfo(options)).toString('binary');
}

test.each([
    ['extra nested child after OID and NULL', { parameters: Buffer.alloc(0), extraChild: true }],
    ['extra nested child after OID without NULL', { extraChild: true }],
    ...[1, 8, 32].map(length => [`nonempty NULL of ${length} bytes`, { parameters: Buffer.alloc(length, 0x78) }])
])('rejects %s that pristine Forge 1.4.0 accepts', (_label, options) => {
    const signature = signatureFor(options);
    expect(upstreamPublicKey.verify(DIGEST.toString('binary'), signature)).toBe(true);
    expect(() => publicKey.verify(DIGEST.toString('binary'), signature)).toThrow(INVALID_DIGEST_INFO);
});

test.each([
    ['absent NULL', {}],
    ['empty NULL', { parameters: Buffer.alloc(0) }],
    ['legacy BER indefinite outer sequence', { parameters: Buffer.alloc(0), indefinite: true }]
])('preserves valid RSA verification with %s and rejects a different digest', (_label, options) => {
    const signature = signatureFor(options);
    expect(publicKey.verify(DIGEST.toString('binary'), signature)).toBe(true);
    expect(publicKey.verify(WRONG_DIGEST.toString('binary'), signature)).toBe(false);
});

test('verifies a native Node RSA-SHA256 signature and rejects a different digest', () => {
    const signature = crypto.sign('sha256', MESSAGE, privatePem);
    expect(publicKey.verify(DIGEST.toString('binary'), signature.toString('binary'))).toBe(true);
    expect(publicKey.verify(WRONG_DIGEST.toString('binary'), signature.toString('binary'))).toBe(false);
});

test('preserves PSS verification against native Node signatures', () => {
    const pss = forge.pss.create({ md: forge.md.sha256.create(),
        mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 32 });
    const signature = crypto.sign('sha256', MESSAGE, { key: privatePem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('binary');
    expect(publicKey.verify(DIGEST.toString('binary'), signature, pss)).toBe(true);
    expect(publicKey.verify(WRONG_DIGEST.toString('binary'), signature, pss)).toBe(false);
});

test('preserves explicit NONE signature verification', () => {
    const signature = privateKey.sign(DIGEST.toString('binary'), 'NONE');
    expect(publicKey.verify(DIGEST.toString('binary'), signature, 'NONE')).toBe(true);
    expect(publicKey.verify(WRONG_DIGEST.toString('binary'), signature, 'NONE')).toBe(false);
});

test('preserves encrypted PKCS#12 key and certificate round trips', () => {
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = publicKey;
    certificate.serialNumber = '01';
    certificate.validity.notBefore = new Date('2026-01-01T00:00:00.000Z');
    certificate.validity.notAfter = new Date('2027-01-01T00:00:00.000Z');
    const attributes = [{ name: 'commonName', value: 'Synthetic No Fries test certificate' }];
    certificate.setSubject(attributes);
    certificate.setIssuer(attributes);
    certificate.sign(privateKey, forge.md.sha256.create());
    expect(certificate.verify(certificate)).toBe(true);
    const password = 'synthetic-test-password';
    const encoded = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password,
        { algorithm: 'aes256', count: 2048 })).getBytes();
    const recovered = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(encoded), password);
    const keyOid = forge.pki.oids.pkcs8ShroudedKeyBag, certOid = forge.pki.oids.certBag;
    const keys = recovered.getBags({ bagType: keyOid })[keyOid];
    const certificates = recovered.getBags({ bagType: certOid })[certOid];
    expect(keys).toHaveLength(1);
    expect(certificates).toHaveLength(1);
    expect(keys[0].key.n.toString(16)).toBe(publicKey.n.toString(16));
    expect(certificates[0].cert.publicKey.n.toString(16)).toBe(publicKey.n.toString(16));
    const digest = forge.md.sha256.create().update(MESSAGE.toString('binary'));
    const signature = keys[0].key.sign(digest);
    expect(publicKey.verify(DIGEST.toString('binary'), signature)).toBe(true);
    expect(() => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(encoded), 'incorrect-test-password')).toThrow();
});
