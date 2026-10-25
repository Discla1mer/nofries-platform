'use strict';

// Explicitly enabled adapter; application composition owns its shared callback.
const { createRemoteCustomerAssertion, RemoteCustomerAssertionError } = require('./remoteCustomerAssertion');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPTIONS = new Set(['enabled', 'configuration', 'managedIdentity', 'now']);
const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const fail = () => { throw new RemoteCustomerAssertionError(); };

function identityOptions(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) fail();
    const fields = Object.keys(identity);
    if (!fields.includes('kind')) fail();
    if (identity.kind === 'system-assigned' && fields.length === 1) {
        return { retryOptions: { maxRetries: 0 } };
    }
    if (identity.kind === 'user-assigned' && fields.length === 2 && fields.includes('clientId') &&
        typeof identity.clientId === 'string' && UUID.test(identity.clientId)) {
        return { clientId: identity.clientId, retryOptions: { maxRetries: 0 } };
    }
    fail();
}

function epoch(value) {
    if (value === undefined) return null;
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) fail();
    return value.getTime();
}

function createKeyVaultCustomerAssertion(options = {}, dependencies = {}) {
    try {
        if (options.enabled === undefined || options.enabled === false) return null;
        if (options.enabled !== true || Object.keys(options).some(field => !OPTIONS.has(field))) fail();
        const configuration = { ...options.configuration };
        if (!(configuration.certificateDer instanceof Uint8Array)) fail();
        configuration.certificateDer = Buffer.from(configuration.certificateDer);
        const identity = identityOptions(options.managedIdentity);
        let KeyClient, credential, CryptographyClient, sdkOptions;
        const loaded = new WeakMap();
        const { keyId, keyName, vaultOrigin } = configuration;
        // Validate all pins before loading the SDK or constructing credentials.
        const callback = createRemoteCustomerAssertion({ enabled: true, configuration,
            ...(options.now === undefined ? {} : { now: options.now }),
            async readPublicKey({ keyId: requested, signal }) {
                if (requested !== keyId || signal.aborted) fail();
                const version = new URL(keyId).pathname.split('/')[3];
                // Per-read SDK cache lifetime; the credential and its request
                // budget remain owned once by this assertion factory.
                const keyClient = new KeyClient(vaultOrigin, credential, sdkOptions());
                const value = await keyClient.getKey(keyName, { version, abortSignal: signal,
                    requestOptions: { timeout: 5000 } });
                const key = value?.key, properties = value?.properties;
                if (signal.aborted || value?.id !== keyId || value.name !== keyName ||
                    key?.kid !== keyId || properties?.id !== keyId || properties.version !== version ||
                    properties.vaultUrl !== vaultOrigin || PRIVATE_FIELDS.some(field => key[field] !== undefined)) fail();
                const result = { keyId, enabled: properties.enabled, kty: key.kty,
                    keyOperations: value.keyOperations, n: key.n, e: key.e,
                    notBefore: epoch(properties.notBefore), expiresAt: epoch(properties.expiresOn) };
                // Only these public fields may reach CryptographyClient. The
                // callback validates modulus, exponent, dates and operations
                // before signDigest can consume this per-operation value.
                loaded.set(signal, { id: keyId, name: keyName, keyType: key.kty,
                    keyOperations: [...(value.keyOperations || [])],
                    key: { kid: keyId, kty: key.kty, n: Buffer.from(key.n), e: Buffer.from(key.e),
                        keyOps: [...(value.keyOperations || [])] },
                    properties: { id: keyId, version, vaultUrl: vaultOrigin, enabled: properties.enabled,
                        notBefore: properties.notBefore, expiresOn: properties.expiresOn } });
                return result;
            },
            async signDigest({ keyId: requested, algorithm, digest, signal }) {
                try {
                    if (requested !== keyId || algorithm !== 'PS256' || signal.aborted ||
                        !(digest instanceof Uint8Array) || digest.length !== 32) fail();
                    const publicKey = loaded.get(signal);
                    if (!publicKey) fail();
                    const client = new CryptographyClient(publicKey, credential, sdkOptions());
                    let wireKeyId;
                    const response = await client.sign('PS256', Buffer.from(digest), { abortSignal: signal,
                        requestOptions: { timeout: 5000 },
                        onResponse(raw) {
                            if (raw.status !== 200) return;
                            const body = raw.parsedBody ?? raw.body ?? JSON.parse(raw.bodyAsText || 'null');
                            if (body?.kid !== keyId) fail();
                            wireKeyId = body.kid;
                        } });
                    // SDK4.10.2 returns its configured keyID. Require the wire
                    // response ID too, then the caller verifies the signature.
                    if (signal.aborted || wireKeyId !== keyId || response.keyID !== keyId || response.algorithm !== 'PS256') fail();
                    return { keyId: wireKeyId, algorithm: response.algorithm, signature: response.result };
                } finally { loaded.delete(signal); }
            }
        });
        const createCredential = dependencies.createCredential;
        if (createCredential !== undefined && (typeof createCredential !== 'function' ||
            dependencies.ManagedIdentityCredential !== undefined)) fail();
        KeyClient = dependencies.KeyClient || require('@azure/keyvault-keys').KeyClient;
        CryptographyClient = dependencies.CryptographyClient || require('@azure/keyvault-keys').CryptographyClient;
        const httpClient = dependencies.httpClient;
        sdkOptions = () => ({ serviceVersion: '2025-07-01', retryOptions: { maxRetries: 0 }, redirectOptions: { maxRetries: 0 },
            disableChallengeResourceVerification: false,
            ...(httpClient === undefined ? {} : { httpClient }) });
        if (createCredential) credential = createCredential();
        else {
            const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
            credential = new ManagedIdentityCredential(identity);
        }
        if (!credential || typeof credential.getToken !== 'function') fail();
        return callback;
    } catch (_) { throw new RemoteCustomerAssertionError(); }
}

module.exports = { createKeyVaultCustomerAssertion };
