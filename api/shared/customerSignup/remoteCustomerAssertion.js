'use strict';

// Customer assertion boundary. No Azure client, credential, runtime selection or
// production caller is provided here. Ports are supplied by the separately
// testable managed-identity adapter; no private key or secret is an accepted input.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIG_FIELDS = new Set(['clientId', 'tokenEndpoint', 'vaultOrigin', 'keyName',
    'keyId', 'certificateDer', 'certificateSha256']);
const OPTION_FIELDS = new Set(['enabled', 'configuration', 'readPublicKey', 'signDigest', 'now']);
const TIMEOUT_MS = 5000;
const MAX_OUTSTANDING = 4;
const LIFETIME_SECONDS = 240;
const CLOCK_SKEW_SECONDS = 30;

class RemoteCustomerAssertionError extends Error {
    constructor() {
        super('Customer authentication is temporarily unavailable.');
        this.name = 'RemoteCustomerAssertionError';
        this.code = 'customer_assertion_unavailable';
        this.statusCode = 503;
    }
}
const fail = () => { throw new RemoteCustomerAssertionError(); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function publicBytes(value, expectedLength) {
    if (!(value instanceof Uint8Array) || value.length !== expectedLength) fail();
    return Buffer.from(value);
}

function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value)) fail();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.href !== value || url.username || url.password ||
        url.port || url.search || url.hash) fail();
    return url;
}

function configurationSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).some(field => !CONFIG_FIELDS.has(field))) fail();
    const { clientId, tokenEndpoint, vaultOrigin, keyName, keyId, certificateSha256 } = raw;
    if (typeof clientId !== 'string' || !UUID.test(clientId)) fail();
    const token = httpsUrl(tokenEndpoint);
    const tenantPath = token.pathname.split('/')[1];
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.ciamlogin\.com$/.test(token.hostname) ||
        !(UUID.test(tenantPath) || /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.onmicrosoft\.com$/.test(tenantPath)) ||
        token.pathname !== `/${tenantPath}/oauth2/v2.0/token`) fail();
    if (typeof vaultOrigin !== 'string' ||
        !/^https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net$/.test(vaultOrigin) ||
        typeof keyName !== 'string' || !/^[A-Za-z0-9-]{1,127}$/.test(keyName)) fail();
    const keyUrl = httpsUrl(keyId);
    const prefix = `/keys/${keyName}/`;
    if (keyUrl.origin !== vaultOrigin || !keyUrl.pathname.startsWith(prefix) ||
        !/^[a-f0-9]{32}$/.test(keyUrl.pathname.slice(prefix.length))) fail();
    if (!(raw.certificateDer instanceof Uint8Array) || raw.certificateDer.length < 128 ||
        raw.certificateDer.length > 16384 || typeof certificateSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(certificateSha256)) fail();
    const der = Buffer.from(raw.certificateDer);
    const thumbprint = hash(der);
    if (thumbprint.toString('hex') !== certificateSha256) fail();
    const certificate = new crypto.X509Certificate(der);
    // Reject PEM, a second certificate, or trailing data in a supposed DER pin.
    if (!der.equals(certificate.raw) || certificate.ca !== false) fail();
    const publicKey = certificate.publicKey;
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'rsa' ||
        publicKey.asymmetricKeyDetails?.modulusLength !== 3072) fail();
    const jwk = publicKey.export({ format: 'jwk' });
    if (jwk.kty !== 'RSA' || jwk.e !== 'AQAB' || typeof jwk.n !== 'string') fail();
    const modulus = Buffer.from(jwk.n, 'base64url');
    if (modulus.length !== 384 || modulus.toString('base64url') !== jwk.n) fail();
    const validFrom = Date.parse(certificate.validFrom), validTo = Date.parse(certificate.validTo);
    if (!Number.isSafeInteger(validFrom) || !Number.isSafeInteger(validTo) || validFrom >= validTo) fail();
    return { clientId, tokenEndpoint, keyId, thumbprint: thumbprint.toString('base64url'),
        publicKey, modulus, exponent: Buffer.from([1, 0, 1]), validFrom, validTo };
}

function validWindow(value, nbf, exp) {
    // The port maps SDK dates to epoch milliseconds. Missing notBefore/expiry
    // is allowed for the key; the pinned certificate always bounds validity.
    if (value.notBefore !== null && (!Number.isSafeInteger(value.notBefore) || value.notBefore > nbf)) fail();
    if (value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < exp)) fail();
}

function validateKey(value, binding, nbf, exp) {
    if (!value || value.keyId !== binding.keyId || value.enabled !== true || value.kty !== 'RSA' ||
        !Array.isArray(value.keyOperations) || !value.keyOperations.includes('sign') ||
        value.keyOperations.some(op => op !== 'sign' && op !== 'verify') ||
        !publicBytes(value.n, 384).equals(binding.modulus) ||
        !publicBytes(value.e, 3).equals(binding.exponent)) fail();
    validWindow(value, nbf, exp);
}

// Shared native verification boundary, also exercised with public-only upstream
// verification vectors. Arbitrary fixture messages are not client assertions.
function verifyRemoteCustomerSignature(binding, input, result) {
    try {
        if (!result || result.keyId !== binding.keyId || result.algorithm !== 'PS256' ||
            !(input instanceof Uint8Array) || binding.publicKey.type !== 'public' ||
            binding.publicKey.asymmetricKeyType !== 'rsa' ||
            binding.publicKey.asymmetricKeyDetails?.modulusLength !== 3072) fail();
        const signature = publicBytes(result.signature, 384);
        if (!crypto.verify('sha256', input, { key: binding.publicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)) fail();
        return signature;
    } catch (_) { throw new RemoteCustomerAssertionError(); }
}

function createRemoteCustomerAssertion(options = {}) {
    // Do not destructure options before this check: disabled callers may carry
    // lazy configuration/credential getters which must never be evaluated.
    try {
        if (options.enabled === undefined || options.enabled === false) return null;
        if (options.enabled !== true || Object.keys(options).some(field => !OPTION_FIELDS.has(field))) fail();
        const binding = configurationSnapshot(options.configuration);
        const { readPublicKey, signDigest, now = Date.now } = options;
        if (typeof readPublicKey !== 'function' || typeof signDigest !== 'function' || typeof now !== 'function') fail();
        let outstanding = 0;
        return async function remoteCustomerAssertion(context) {
            let timer;
            try {
                if (!context || context.clientId !== binding.clientId || context.tokenEndpoint !== binding.tokenEndpoint ||
                    outstanding >= MAX_OUTSTANDING) fail();
                const startedAt = now();
                if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail();
                const iat = Math.floor(startedAt / 1000), nbf = iat - CLOCK_SKEW_SECONDS;
                const exp = iat + LIFETIME_SECONDS;
                if (nbf * 1000 < binding.validFrom || exp * 1000 > binding.validTo) fail();
                const abort = new AbortController();
                const current = () => {
                    const at = now();
                    if (abort.signal.aborted || !Number.isSafeInteger(at) || at < startedAt ||
                        at - startedAt >= TIMEOUT_MS || at >= exp * 1000) fail();
                };
                const deadline = new Promise((_, reject) => {
                    timer = setTimeout(() => { abort.abort(); reject(new RemoteCustomerAssertionError()); }, TIMEOUT_MS);
                });
                outstanding++;
                const operation = (async () => {
                    const key = await readPublicKey({ keyId: binding.keyId, signal: abort.signal });
                    current();
                    validateKey(key, binding, nbf * 1000, exp * 1000);
                    const header = { alg: 'PS256', typ: 'JWT', 'x5t#S256': binding.thumbprint };
                    const claims = { iss: binding.clientId, sub: binding.clientId, aud: binding.tokenEndpoint,
                        jti: crypto.randomUUID(), iat, nbf, exp };
                    const input = Buffer.from(`${encoded(header)}.${encoded(claims)}`, 'ascii');
                    // signDigest maps to CryptographyClient.sign, never signData.
                    const result = await signDigest({ keyId: binding.keyId, algorithm: 'PS256',
                        digest: hash(input), signal: abort.signal });
                    current();
                    const signature = verifyRemoteCustomerSignature(binding, input, result);
                    current();
                    return `${input.toString('ascii')}.${signature.toString('base64url')}`;
                })();
                // Do not free capacity when Promise.race times out. A transport
                // ignoring AbortSignal retains its slot until it really settles.
                operation.then(() => { outstanding--; }, () => { outstanding--; });
                return await Promise.race([operation, deadline]);
            } catch (_) {
                // Do not propagate SDK bodies, causes or credential metadata.
                throw new RemoteCustomerAssertionError();
            } finally { clearTimeout(timer); }
        };
    } catch (_) { throw new RemoteCustomerAssertionError(); }
}

module.exports = { createRemoteCustomerAssertion, RemoteCustomerAssertionError, verifyRemoteCustomerSignature };
