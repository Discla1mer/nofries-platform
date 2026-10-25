'use strict';

// Unmounted policy at the existing nonce-validated browser-auth seam. Its closed
// purpose marker is rejected by ordinary customer/write policies. It installs no
// cookie, route, issuer, IdP, credentials or commercial authority renewal.
const { BrowserAuthError } = require('../browserAuth');
const { fields, copy, freeze, subject, digest, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { customerProviderKey } = require('./customerIdentityProviderProfile');
const { readRetainedTrialOwner } = require('./retainedTrialAssessmentReader');
const { workEmail } = require('../organisationSetup');
const denied = () => { throw new BrowserAuthError(401, 'browser_auth_retained_read_required'); };
const unavailable = () => new BrowserAuthError(503, 'browser_auth_retained_read_unavailable');
const KEYS = ['stage', 'subjectKey', 'email', 'accountId', 'accountSha256', 'authoritySha256', 'verifiedAt',
    'expiresAt', 'providerKey', 'authentication'];

function createRetainedTrialCustomerIdentityPolicy({ profile, records, accountStore,
    verifyAuthentication, recheckAuthentication, now = Date.now }) {
    if (profile?.kind !== 'external-id' || [records?.readSubject, accountStore?.load, verifyAuthentication,
        recheckAuthentication, now].some(fn => typeof fn !== 'function')) throw new Error('retained_read_policy_configuration_invalid');
    const providerKey = customerProviderKey(profile);
    function clock() { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw unavailable(); return at; }
    async function trustedRead(work) {
        try { return await work(); }
        catch (error) { if (error instanceof BrowserAuthError) throw error; throw unavailable(); }
    }
    function reject(error) { if (error instanceof BrowserAuthError) throw error; denied(); }
    function identityMatches(identity) {
        subject(identity.subjectKey);
        if (identity.tenantId !== profile.tenantId || identity.subjectKey !== profile.tenantId + ':' + identity.principalId) denied();
    }
    function authentication(raw, identity) {
        const p = fields(copy(raw, 4096), ['subjectKey', 'email', 'verifiedAt', 'expiresAt', 'policySha256']);
        const at = clock(); digest(p.policySha256);
        if (p.subjectKey !== identity.subjectKey || p.email !== workEmail(p.email) || !Number.isSafeInteger(p.verifiedAt) ||
            p.verifiedAt < 0 || p.verifiedAt > at || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= at || p.expiresAt <= p.verifiedAt) denied();
        return freeze(p);
    }
    async function owner(identity) {
        identityMatches(identity);
        const value = await readRetainedTrialOwner({ subjectKey: identity.subjectKey,
            readSubject: key => trustedRead(() => records.readSubject(key)),
            accountStore: { load: key => trustedRead(() => accountStore.load(key)) } });
        if (clock() < Date.parse(value.account.activation.validUntil)) denied();
        return value;
    }
    function assurance(raw, identity, current) {
        const value = fields(copy(raw, 16384), KEYS), p = authentication(value.authentication, identity);
        digest(value.accountSha256); digest(value.authoritySha256);
        if (value.stage !== 'retained_read' || value.subjectKey !== identity.subjectKey || value.email !== current.index.email ||
            p.email !== current.index.email || value.accountId !== current.account.accountId ||
            value.accountSha256 !== hash(current.account) || value.authoritySha256 !== hash(current.index) ||
            value.providerKey !== providerKey || value.verifiedAt !== p.verifiedAt || value.expiresAt !== p.expiresAt) denied();
        return p;
    }
    async function enforced(identity, proof) {
        if (await trustedRead(() => recheckAuthentication({ identity, authentication: proof, profile })) !== true) denied();
        authentication(proof, identity);
    }
    const policy = Object.freeze({
        async begin() { return { context: { purpose: 'retained_read' } }; },
        async verify({ identity, claims, context }) {
            try {
                identityMatches(identity); fields(context, ['purpose']);
                if (context.purpose !== 'retained_read' || claims.iss !== profile.issuer || claims.tid !== profile.tenantId ||
                    claims.oid !== identity.principalId || claims.aud !== profile.clientId || !Number.isSafeInteger(claims.exp)) denied();
                const p = authentication(await trustedRead(() => verifyAuthentication({ identity, claims, profile })), identity);
                if (p.expiresAt > claims.exp * 1000) denied();
                await enforced(identity, p);
                const current = await owner(identity);
                const result = freeze({ stage: 'retained_read', subjectKey: identity.subjectKey, email: p.email,
                    accountId: current.account.accountId, accountSha256: hash(current.account), authoritySha256: hash(current.index),
                    verifiedAt: p.verifiedAt, expiresAt: p.expiresAt, providerKey, authentication: p });
                assurance(result, identity, current); await policy.recheck({ identity, assurance: result });
                return result;
            } catch (error) { reject(error); }
        },
        async recheck({ identity, assurance: value }) {
            try {
                const before = await owner(identity), proof = assurance(value, identity, before);
                await enforced(identity, proof);
                const after = await owner(identity);
                if (!equal(before, after)) denied();
                assurance(value, identity, after);
            } catch (error) { reject(error); }
        }
    });
    return policy;
}

module.exports = { createRetainedTrialCustomerIdentityPolicy };
