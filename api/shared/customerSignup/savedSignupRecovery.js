'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { fields, copy, uuid, digest, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { authority } = require('./customerAuthority');
const { validateInvitationRecord, validateAcceptanceReceipt, MAX_PROOF_AGE } = require('./invitationAcceptance');

const fail = () => { throw new Error('signup_recovery_unavailable'); };
const AUTHORIZATION_KEYS = ['schemaVersion', 'recoveryId', 'status', 'approvalRef', 'subjectKey', 'accountId',
    'authoritySha256', 'preparationSha256', 'invitationId', 'invitationDigest', 'tenantId', 'organisationId',
    'bindingId', 'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest', 'approvedAt', 'expiresAt', 'receiptId'];
const REFERENCE_KEYS = ['subjectKey', 'tenantId', 'organisationId', 'invitationId',
    'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'];

// This is NEW authority from the existing administrative, runtime-Reader-only
// container. Historical provisioning and an active session cannot supply it:
// the missing transient invitation may have been revoked before it vanished.
function recoveryAuthorization(raw, context, at) {
    const value = fields(copy(raw, 16384), AUTHORIZATION_KEYS);
    if (value.schemaVersion !== 1 || value.status !== 'active' ||
        typeof value.approvalRef !== 'string' || !value.approvalRef || value.approvalRef.length > 180 ||
        value.approvalRef.trim() !== value.approvalRef || /[\x00-\x1f\x7f]/.test(value.approvalRef)) fail();
    for (const key of ['recoveryId', 'accountId', 'bindingId', 'receiptId']) uuid(value[key]);
    for (const key of ['authoritySha256', 'preparationSha256', 'invitationDigest', 'termsDigest', 'scheduleDigest']) digest(value[key]);
    const current = authority(context.authority, context.authority.subjectKey, at);
    if (value.authoritySha256 !== canonicalDigest(current) || value.accountId !== context.accountId ||
        value.preparationSha256 !== context.preparationSha256 ||
        [...REFERENCE_KEYS, 'invitationDigest', 'bindingId'].some(key => value[key] !== current[key])) fail();
    if (!Number.isSafeInteger(value.approvedAt) || !Number.isSafeInteger(value.expiresAt) ||
        value.approvedAt < 0 || value.approvedAt > at || value.expiresAt <= at ||
        value.expiresAt - value.approvedAt > 60 * 60 * 1000) fail();
    const invitation = validateInvitationRecord(context.invitation);
    if (invitation.status !== 'invited' || invitation.acceptance !== null ||
        invitation.tokenDigest !== current.invitationDigest || invitation.expectedEmail !== current.email ||
        invitation.createdAt > at || invitation.expiresAt <= at ||
        value.expiresAt > Math.min(invitation.expiresAt, current.expiresAt) ||
        REFERENCE_KEYS.filter(key => key !== 'subjectKey').some(key => invitation[key] !== current[key])) fail();
    return value;
}

function validateSession(context, at) {
    if (typeof context.sessionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(context.sessionId) ||
        !Number.isSafeInteger(context.verifiedAt) || context.verifiedAt > at || at - context.verifiedAt > MAX_PROOF_AGE ||
        !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= at) fail();

}

function matchingReceipt(raw, approval, invitation) {
    const receipt = validateAcceptanceReceipt(raw);
    if (receipt.receiptId !== approval.receiptId || REFERENCE_KEYS.some(key => receipt[key] !== approval[key]) ||
        receipt.acceptedAt < Math.max(approval.approvedAt, invitation.createdAt) ||
        receipt.acceptedAt >= Math.min(approval.expiresAt, invitation.expiresAt)) fail();
    return receipt;
}
function matchingRegistration(value, receipt) {
    if (!value || value.status !== 'pending_admission' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        [...REFERENCE_KEYS, 'receiptId'].some(key => value[key] !== receipt[key])) fail();
    return value;
}

/**
 * Opt-in original-scope consent recovery. readContext is a server-only reader of
 * current BFF assurance and unchanged inactive starter preparation; readApproval
 * reads independently approved authority. No invitation is reconstructed and no
 * GET writes consent/registration. The ordinary HTTP layer owns origin and CSRF.
 */
function createSavedSignupRecovery({ readContext, readApproval, readInvitation, resolveTerms,
    journal, registrations, now = Date.now }) {
    if (registrations && Object.hasOwn(registrations, 'assertAcceptanceWritable') &&
        (typeof registrations.assertAcceptanceWritable !== 'function' || isProxy(registrations.assertAcceptanceWritable))) {
        throw new TypeError('signup_registration_store_required');
    }
    async function capture(req) {
        const context = await readContext(req);
        if (context === null) return null;
        const approval = await readApproval(context.authority.subjectKey);
        if (approval === null) return null;
        // Existing, expired or revoked invitation state uses the ordinary path;
        // a recovery record must never override a still-present invitation.
        if (await readInvitation(context.authority.invitationDigest) !== null) return null;
        const detached = copy(context, 65536);
        const approved = recoveryAuthorization(approval, detached, now());
        validateSession(detached, now());
        return { context: detached, approval: approved };
    }
    async function recheck(req, initial) {
        const latest = await capture(req);
        if (!latest || !equal(latest, initial)) fail();
        recoveryAuthorization(latest.approval, latest.context, now());
        validateSession(latest.context, now());
    }
    const reference = approval => Object.fromEntries(['tenantId', 'organisationId', 'invitationId'].map(key => [key, approval[key]]));
    const registrationReference = approval => ({ ...reference(approval), subjectKey: approval.subjectKey });
    async function state(initial) {
        const { approval, context } = initial;
        const receipt = await journal.readForInvitation(reference(approval));
        const registered = await registrations.readForInvitation(registrationReference(approval));
        if (receipt === null) {
            // A registration without proof is inconsistent, including tombstones.
            if (registered !== null) fail();
            return { receipt: null, registered: null };
        }
        const saved = matchingReceipt(receipt, approval, context.invitation);
        if (registered !== null) matchingRegistration(registered, saved);
        return { receipt: saved, registered };
    }
    async function termsFor(initial) {
        const terms = fields(copy(await resolveTerms(Object.fromEntries(REFERENCE_KEYS.filter(key =>
            !['subjectKey', 'invitationId'].includes(key)).map(key => [key, initial.approval[key]]))), 262144),
        ['termsText', 'termsVersion', 'termsDigest', 'scheduleId', 'scheduleText', 'scheduleDigest']);
        // resolveTerms must validate the CURRENT offer and exact archive bytes.
        if (['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'].some(key => terms[key] !== initial.approval[key])) fail();
        for (const [text, digest] of [['termsText', 'termsDigest'], ['scheduleText', 'scheduleDigest']]) {
            if (typeof terms[text] !== 'string' || !terms[text] || terms[text].length > 32768 ||
                createHash('sha256').update(terms[text], 'utf8').digest('hex') !== terms[digest]) fail();
        }
        return terms;
    }
    async function complete(req, initial, receipt) {
        await recheck(req, initial);
        if (registrations.assertAcceptanceWritable) await registrations.assertAcceptanceWritable({ subjectKey: receipt.subjectKey });
        const registered = matchingRegistration(await registrations.registerAcceptance(receipt), receipt);
        await recheck(req, initial);
        const latest = matchingRegistration(await registrations.readForInvitation(registrationReference(initial.approval)), receipt);
        if (latest.revision !== registered.revision) fail();
        await recheck(req, initial);
        return { status: 'pending_admission' };
    }
    return Object.freeze({
        async loadState(req) {
            const initial = await capture(req); if (!initial) return null;
            const saved = await state(initial);
            const terms = saved.receipt ? null : await termsFor(initial);
            await recheck(req, initial);
            return saved.receipt ? { status: saved.registered ? 'pending_admission' : 'resume_acceptance' }
                : { status: 'terms', ...terms };
        },
        async acceptTerms({ req, input }) {
            const initial = await capture(req); if (!initial) return null;
            const submitted = fields(copy(input, 16384), ['accepted', 'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest']);
            if (submitted.accepted !== true || ['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest']
                .some(key => submitted[key] !== initial.approval[key])) fail();
            let saved = await state(initial);
            if (!saved.receipt) {
                await termsFor(initial);
                await recheck(req, initial);
                // Recheck durable state after awaited offer/identity reads. A
                // revoked registration or earlier receipt is never overwritten.
                saved = await state(initial);
                await recheck(req, initial);
                if (!saved.receipt) {
                    await termsFor(initial);
                    const at = now(); recoveryAuthorization(initial.approval, initial.context, at);
                    validateSession(initial.context, at);
                    const receipt = validateAcceptanceReceipt({ receiptId: initial.approval.receiptId,
                        ...Object.fromEntries(REFERENCE_KEYS.map(key => [key, initial.approval[key]])),
                        acceptedAt: at, status: 'pending_admission', dashboardAccess: false });
                    if (registrations.assertAcceptanceWritable) await registrations.assertAcceptanceWritable({ subjectKey: receipt.subjectKey });
                    validateSession(initial.context, now());
                    await journal.persist(receipt);
                    // Lost responses are handled by a later explicit retry using
                    // this approval's stable receipt ID and original timestamp.
                    saved = { receipt };
                }
            }
            return complete(req, initial, saved.receipt);
        },
        async resumeAcceptance({ req }) {
            const initial = await capture(req); if (!initial) return null;
            const saved = await state(initial);
            if (!saved.receipt) fail(); // No invented consent from a resume click.
            return complete(req, initial, saved.receipt);
        }
    });
}

// Used only to prepare an exact reviewable authorization from private verified
// inputs. Calling this compiler cannot publish authority or accept any terms.
function prepareRecoveryAuthorization({ context, approvalRef, approvedAt, expiresAt, recoveryId = randomUUID(), receiptId = randomUUID() }) {
    const current = context.authority;
    const candidate = { schemaVersion: 1, recoveryId, status: 'active', approvalRef,
        ...Object.fromEntries(REFERENCE_KEYS.map(key => [key, current[key]])), accountId: context.accountId,
        authoritySha256: canonicalDigest(current), preparationSha256: context.preparationSha256,
        invitationDigest: current.invitationDigest, bindingId: current.bindingId,
        approvedAt, expiresAt, receiptId };
    return recoveryAuthorization(candidate, context, approvedAt);
}
module.exports = { createSavedSignupRecovery, recoveryAuthorization, prepareRecoveryAuthorization };
