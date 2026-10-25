'use strict';

// Dormant adapter. The host must bind handle lookup to the reviewed Entra BFF
// session; request fields never establish identity, email verification, or MFA.
const { isProxy } = require('node:util').types;

class EntraB2bIdentityProofError extends Error {
    constructor(code = 'signup_identity_required') {
        super(code);
        this.code = code;
    }
}

const fail = code => { throw new EntraB2bIdentityProofError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HASH = /^[a-f0-9]{64}$/;

function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail();
    }
    return value;
}

function uuid(value) {
    if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) fail();
    return value.toLowerCase();
}

function email(value) {
    if (typeof value !== 'string' || value.length > 254 || value.trim() !== value || !EMAIL.test(value)) fail();
    return value.toLowerCase();
}

function instant(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail();
    return value;
}

function createEntraB2bIdentityVerifier(options = {}) {
    exact(options, ['expectedTenantId', 'identityPolicyId', 'readIdentity']);
    if (typeof options.readIdentity !== 'function' || isProxy(options.readIdentity)) fail('signup_provider_configuration_invalid');
    const expectedTenantId = uuid(options.expectedTenantId);
    if (typeof options.identityPolicyId !== 'string' || !options.identityPolicyId || options.identityPolicyId.trim() !== options.identityPolicyId) {
        fail('signup_provider_configuration_invalid');
    }
    const identityPolicyId = options.identityPolicyId;

    return Object.freeze({
        async verifyIdentity(input) {
            exact(input, ['handle', 'invitationDigest']);
            if (typeof input.handle !== 'string' || !input.handle || input.handle.length > 512 ||
                typeof input.invitationDigest !== 'string' || !HASH.test(input.invitationDigest)) fail();
            let identity;
            try { identity = await options.readIdentity({ handle: input.handle }); }
            catch (_) { fail(); }
            exact(identity, ['provider', 'isAuthenticated', 'tenantId', 'principalId', 'subjectKey', 'email',
                'emailVerified', 'mfaSatisfied', 'verifiedAt', 'expiresAt']);
            const tenantId = uuid(identity.tenantId);
            const principalId = uuid(identity.principalId);
            const subjectKey = `${tenantId}:${principalId}`;
            if (identity.provider !== 'entra-bff' || identity.isAuthenticated !== true ||
                tenantId !== expectedTenantId || identity.subjectKey !== subjectKey ||
                identity.emailVerified !== true || typeof identity.mfaSatisfied !== 'boolean') fail();
            const verifiedAt = instant(identity.verifiedAt), expiresAt = instant(identity.expiresAt);
            if (expiresAt <= verifiedAt || email(identity.email) === '') fail();
            return Object.freeze({ subjectKey, email: email(identity.email), emailVerified: true,
                identityPolicyId, mfaSatisfied: identity.mfaSatisfied, invitationDigest: input.invitationDigest,
                verifiedAt, expiresAt });
        }
    });
}

module.exports = Object.freeze({ EntraB2bIdentityProofError, createEntraB2bIdentityVerifier });
