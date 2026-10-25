'use strict';

const crypto = require('node:crypto');
const { fields, copy, freeze, uuid, instant, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterSetupSnapshot: verifiedSnapshot } = require('./managedSignupProof');
const { compileStarterSchedule, approvedStarterPlan, usesUnlimitedConsultantPolicy } = require('./customerStarterPlan');
const { workEmail } = require('../organisationSetup');
const ASSERTION_VERSION = 'nf-starter-authority-2026-09-r1';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
function text(value, maximum) {
    if (typeof value !== 'string') fail('starter_details_invalid');
    const result = value.trim().normalize('NFC');
    if (!result || result.length > maximum || /[\u0000-\u001f\u007f-\u009f<>]/u.test(result)) fail('starter_details_invalid');
    return result;
}
function details(input) {
    const value = fields(copy(input, 8192), ['name', 'role', 'address', 'registrationId', 'authorityConfirmed']);
    if (value.authorityConfirmed !== true) fail('starter_authority_required');
    return freeze({ name: text(value.name, 160), role: text(value.role, 120), address: text(value.address, 500),
        registrationId: value.registrationId === null || value.registrationId === '' ? null : text(value.registrationId, 160) });
}
function starterSetupRecord(input) {
    const value = fields(copy(input, 65536), ['schemaVersion', 'accountId', 'requestId', 'planId', 'planSha256',
        'representativeEvidenceId', 'assertion', 'offerInput', 'offer']);
    const plan = approvedStarterPlan(value.planId);
    uuid(value.accountId); uuid(value.requestId); uuid(value.representativeEvidenceId);
    if (value.schemaVersion !== 1 || value.planId !== plan.planId || value.planSha256 !== plan.sha256) fail('starter_details_invalid');
    const assertion = fields(value.assertion, ['version', 'confirmed', 'setupRequestId', 'setupSha256', 'email', 'receivedAt', 'proof']);
    uuid(assertion.setupRequestId); instant(assertion.receivedAt);
    const proof = verifiedSnapshot(assertion.proof, assertion.setupRequestId);
    if (assertion.version !== ASSERTION_VERSION || assertion.confirmed !== true ||
        !/^[a-f0-9]{64}$/.test(assertion.setupSha256) || assertion.email !== workEmail(assertion.email) ||
        assertion.receivedAt < plan.approvedAt || hash(proof) !== assertion.setupSha256 || proof.email !== assertion.email ||
        proof.verifiedAt > Date.parse(assertion.receivedAt) || proof.expiresAt <= Date.parse(assertion.receivedAt) ||
        value.offerInput.contact.authorityEvidenceId !== value.representativeEvidenceId ||
        value.offerInput.contact.email !== assertion.email ||
        (value.offerInput.planId ?? approvedStarterPlan().planId) !== plan.planId ||
        hash(compileStarterSchedule(value.offerInput)) !== hash(value.offer)) fail('starter_details_invalid');
    return freeze(value);
}
const starterSetupKey = organisationId => 'starter-setups/' + uuid(organisationId);

// This service records the person's deliberate authority assertion after mailbox
// verification. It does not accept dashboard terms, invite a user or grant access.
// The only HTTP caller resolves proof from the original opaque setup cookie.
function createStarterSetupDetails({ accounts, store, framework, now = Date.now, newId = crypto.randomUUID }) {
    if (!accounts || !['readInitial', 'reserveInitial'].every(k => typeof accounts[k] === 'function') ||
        !store || !['load', 'create'].every(k => typeof store[k] === 'function') || typeof framework !== 'function') fail('starter_details_configuration_invalid');
    function proof(input) {
        const value = verifiedSnapshot(input, input?.requestId), at = now();
        if (!Number.isSafeInteger(at) || value.verifiedAt > at || value.expiresAt <= at || !Object.hasOwn(value, 'accountType')) fail('starter_proof_invalid');
        return value;
    }
    function match(saved, account, snapshot) {
        const value = starterSetupRecord(saved), slot = account.organisations[0];
        const offer = value.offerInput;
        if (value.accountId !== account.accountId || value.planId !== account.planId || value.planSha256 !== account.planSha256 ||
            value.requestId !== slot.requestId || offer.kind !== 'own' ||
            offer.accountType !== account.accountType || value.assertion.email !== account.email ||
            ['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId'].some(key => offer[key] !== slot[key]) ||
            value.assertion.email !== snapshot.email || value.assertion.setupRequestId === account.setupRequestId &&
                value.assertion.setupSha256 !== account.setupSha256) fail('starter_details_changed');
        return value;
    }
    async function read(input) {
        const snapshot = proof(input), account = await accounts.readInitial(input);
        if (!account) { proof(input); return null; }
        const saved = await store.load(starterSetupKey(account.organisations[0].organisationId));
        proof(input);
        return saved ? match(saved, account, snapshot) : null;
    }
    return Object.freeze({ read,
        async save(input, rawDetails) {
            const snapshot = proof(input), supplied = details(rawDetails);
            const existing = await read(input);
            if (existing && usesUnlimitedConsultantPolicy(existing.offerInput)) fail('starter_details_read_only');
            const account = await accounts.reserveInitial(input), slot = account.organisations[0];
            const key = starterSetupKey(slot.organisationId), before = await store.load(key);
            function same(raw) {
                const saved = match(raw, account, snapshot);
                if (usesUnlimitedConsultantPolicy(saved.offerInput)) fail('starter_details_read_only');
                const { email, authorityEvidenceId, ...retained } = saved.offerInput.contact;
                if (hash(supplied) !== hash(retained)) fail('starter_details_locked');
                proof(input); return saved;
            }
            if (before) return same(before);
            if (account.activation !== null) fail('starter_details_changed');
            const evidenceId = uuid(newId()), plan = approvedStarterPlan(account.planId);
            const offerInput = { tenantId: slot.tenantId, organisationId: slot.organisationId,
                organisationName: slot.organisationName, grantId: slot.grantId, scheduleId: slot.scheduleId,
                kind: 'own', accountType: account.accountType,
                ...(plan.schemaVersion === 2 ? { planId: plan.planId } : {}),
                contact: { ...supplied, email: snapshot.email, authorityEvidenceId: evidenceId }, framework: await framework() };
            proof(input);
            const candidate = starterSetupRecord({ schemaVersion: 1, accountId: account.accountId, requestId: slot.requestId,
                planId: plan.planId, planSha256: plan.sha256, representativeEvidenceId: evidenceId,
                assertion: { version: ASSERTION_VERSION, confirmed: true, setupRequestId: snapshot.requestId,
                    setupSha256: hash(snapshot), email: snapshot.email, receivedAt: new Date(now()).toISOString(), proof: copy(input, 8192) },
                offerInput, offer: compileStarterSchedule(offerInput) });
            proof(input);
            try { await store.create(key, candidate); }
            catch (error) { const observed = await store.load(key); if (!observed) throw error; return same(observed); }
            const observed = await store.load(key);
            if (!observed) fail('starter_details_reconciliation_required');
            return same(observed);
        }
    });
}
module.exports = { createStarterSetupDetails, starterSetupRecord, starterSetupKey, starterRepresentativeDetails: details, ASSERTION_VERSION };
