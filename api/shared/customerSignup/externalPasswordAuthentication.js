'use strict';

const { BrowserAuthError } = require('../browserAuth');
const { fields, copy, freeze, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { customerProviderKey } = require('./customerIdentityProviderProfile');
const { workEmail } = require('../organisationSetup');
const fail = () => { throw new BrowserAuthError(401, 'browser_auth_external_customer_required'); };

// Called only after the server's nonce-bound authorization-code exchange.
// Deployment must associate this dedicated app with the reviewed standard
// Email-with-password signup flow. That provider flow owns signup verification;
// this adapter does not invent an email_verified/MFA claim or poll tenant policy.
// Email is contact data, never an identity key or permission to adopt an account.
function createExternalPasswordAuthentication({ profile, userFlowId, now = Date.now }) {
    if (profile?.kind !== 'external-id' || typeof userFlowId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(userFlowId) || typeof now !== 'function') fail();
    const providerKey = customerProviderKey(profile);
    const policySha256 = canonicalDigest({ providerKey, userFlowId, method: 'email-with-password', version: 1 });
    function sameProvider(identity, supplied) {
        subject(identity.subjectKey);
        if (customerProviderKey(supplied) !== providerKey || identity.tenantId !== profile.tenantId ||
            identity.subjectKey !== profile.tenantId + ':' + identity.principalId || identity.isAuthenticated !== true) fail();
    }
    function checked(identity, raw) {
        const value = fields(copy(raw, 4096), ['subjectKey', 'email', 'verifiedAt', 'expiresAt', 'policySha256']);
        const at = now();
        if (!Number.isSafeInteger(at) || value.subjectKey !== identity.subjectKey || value.policySha256 !== policySha256 ||
            value.email !== workEmail(value.email) || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt < 0 ||
            value.verifiedAt > at || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= at ||
            value.expiresAt <= value.verifiedAt || value.expiresAt > value.verifiedAt + 3600000) fail();
        return freeze(value);
    }
    return Object.freeze({
        async verifyAuthentication({ identity, claims, profile: supplied }) {
            sameProvider(identity, supplied);
            if (!claims || claims.iss !== profile.issuer || claims.tid !== profile.tenantId ||
                claims.aud !== profile.clientId || claims.oid !== identity.principalId ||
                !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()) fail();
            const at = now();
            return checked(identity, { subjectKey: identity.subjectKey, email: workEmail(claims.email),
                verifiedAt: at, expiresAt: Math.min(claims.exp * 1000, at + 3600000), policySha256 });
        },
        async recheckAuthentication({ identity, authentication, profile: supplied }) {
            sameProvider(identity, supplied); checked(identity, authentication); return true;
        }
    });
}
module.exports = { createExternalPasswordAuthentication };
