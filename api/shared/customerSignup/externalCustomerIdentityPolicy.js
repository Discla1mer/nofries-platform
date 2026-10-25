'use strict';

const { BrowserAuthError } = require('../browserAuth');
const { fields, copy, freeze, subject, digest, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { workEmail } = require('../organisationSetup');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { authority } = require('./customerAuthority');
const { customerProviderKey } = require('./customerIdentityProviderProfile');
const fail = () => { throw new BrowserAuthError(401, 'browser_auth_external_customer_required'); };

// The mandatory provider port receives only the nonce-bound MSAL exchange. It
// must establish provider authentication and signup mailbox provenance for the
// exact tenant/app. It does not require or attest MFA: standard email/password
// signup verifies the mailbox separately from any sign-in MFA policy. An email
// or username alone is not ownership evidence.
function createExternalCustomerIdentityPolicy({ profile, records,
    verifyAuthentication, recheckAuthentication, allowNewSignup, signupAdmission, now = Date.now }) {
    if (profile?.kind !== 'external-id' || [verifyAuthentication, recheckAuthentication, records?.readSubject].some(fn => typeof fn !== 'function')) {
        throw new Error('external_customer_policy_configuration_invalid');
    }
    const providerKey = customerProviderKey(profile);
    if (allowNewSignup === true && (!signupAdmission ||
        !['reserve', 'recheck'].every(key => typeof signupAdmission[key] === 'function'))) {
        throw new Error('external_customer_admission_configuration_invalid');
    }
    function identityMatches(identity) {
        subject(identity.subjectKey);
        if (identity.tenantId !== profile.tenantId || identity.subjectKey !== profile.tenantId + ':' + identity.principalId) fail();
    }
    function authentication(raw, identity) {
        const value = fields(copy(raw, 4096), ['subjectKey', 'email', 'verifiedAt', 'expiresAt', 'policySha256']);
        digest(value.policySha256);
        if (value.subjectKey !== identity.subjectKey || value.email !== workEmail(value.email) ||
            !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt < 0 || value.verifiedAt > now() ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now() || value.expiresAt <= value.verifiedAt) fail();
        return freeze(value);
    }
    async function current(identity) {
        identityMatches(identity);
        const raw = await records.readSubject(identity.subjectKey);
        return raw === null ? null : authority(raw, identity.subjectKey, now());
    }
    async function enforced(identity, proof) {
        if (await recheckAuthentication({ identity, authentication: proof, profile }) !== true) fail();
        authentication(proof, identity);
    }
    function assurance(raw, identity, record) {
        const value = fields(copy(raw, 8192), ['subjectKey', 'email', 'invitationDigest', 'revision',
            'verifiedAt', 'expiresAt', 'providerKey', 'authoritySha256', 'authentication']);
        const proof = authentication(value.authentication, identity);
        if (!record || value.subjectKey !== identity.subjectKey || value.email !== record.email || proof.email !== record.email ||
            value.invitationDigest !== record.invitationDigest || value.revision !== record.revision ||
            value.providerKey !== providerKey || value.authoritySha256 !== canonicalDigest(record) ||
            value.verifiedAt !== proof.verifiedAt || value.expiresAt !== Math.min(proof.expiresAt, record.expiresAt) || value.expiresAt <= now()) fail();
        return proof;
    }
    const policy = Object.freeze({
        async begin() { return { context: { verifiedEmail: null } }; },
        async verify({ identity, claims, context }) {
            identityMatches(identity); fields(context, ['verifiedEmail']);
            if (claims.iss !== profile.issuer || claims.tid !== profile.tenantId || claims.oid !== identity.principalId ||
                claims.aud !== profile.clientId) fail();
            const proof = authentication(await verifyAuthentication({ identity, claims, profile }), identity);
            if (!Number.isSafeInteger(claims.exp) || proof.expiresAt > claims.exp * 1000) fail();
            await enforced(identity, proof);
            const record = await current(identity);
            if (record === null && allowNewSignup !== true) fail();
            if (record === null) {
                await signupAdmission.reserve(identity.subjectKey);
                return freeze({ stage: 'setup', subjectKey: identity.subjectKey,
                    email: proof.email, verifiedAt: proof.verifiedAt, expiresAt: proof.expiresAt,
                    providerKey, authentication: proof });
            }
            if (!record || record.email !== proof.email) fail();
            const result = freeze({ subjectKey: identity.subjectKey, email: record.email,
                invitationDigest: record.invitationDigest, revision: record.revision, verifiedAt: proof.verifiedAt,
                expiresAt: Math.min(proof.expiresAt, record.expiresAt), providerKey,
                authoritySha256: canonicalDigest(record), authentication: proof });
            await policy.recheck({ identity, assurance: result });
            return result;
        },
        async recheck({ identity, assurance: value }) {
            if (value?.stage === 'setup') {
                if (allowNewSignup !== true) fail();
                fields(value, ['stage', 'subjectKey', 'email', 'verifiedAt', 'expiresAt', 'providerKey', 'authentication']);
                const proof = authentication(value.authentication, identity);
                if (value.subjectKey !== identity.subjectKey || value.email !== proof.email ||
                    value.verifiedAt !== proof.verifiedAt || value.expiresAt !== proof.expiresAt || value.providerKey !== providerKey) fail();
                // Existing revocation still denies. Creating authority never
                // upgrades this session; only a new callback can admit it.
                await current(identity);
                await enforced(identity, proof);
                await signupAdmission.recheck(identity.subjectKey);
                return;
            }
            const before = await current(identity), proof = assurance(value, identity, before);
            await enforced(identity, proof);
            const after = await current(identity);
            if (!equal(before, after)) fail();
            assurance(value, identity, after);
        }
    });
    return policy;
}
module.exports = { createExternalCustomerIdentityPolicy };
