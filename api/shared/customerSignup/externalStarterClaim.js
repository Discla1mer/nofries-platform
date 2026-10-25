'use strict';

const { fields, copy, equal, uuid, subject, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createInvitation, validateInvitationRecord } = require('./invitationAcceptance');
const { authority, subjectHash } = require('./customerAuthority');
const { compileStarterProvisioning } = require('./starterProvisioning');
const { starterAccountRecord } = require('./starterAccountAllocation');
const { starterSetupRecord } = require('./starterSetupDetails');
const { starterAuthorityExpiry } = require('./customerStarterPlan');
const fail = () => { const error = new Error('external_starter_claim_reconciliation_required'); error.code = error.message; throw error; };
const LIMIT = 131072;

// Read-only validation shared by status projection and the claim executor.
// Historical offer expiry is not current authentication: the executor separately
// enforces the write deadline, and returning access still uses current authority.
function validateRetainedExternalStarterClaim(retained, { account: rawAccount, details: rawDetails,
    subjectKey, providerKey, identityPolicyId, now = Date.now() }) {
    const account = starterAccountRecord(rawAccount), saved = starterSetupRecord(rawDetails), slot = account.organisations[0];
    subject(subjectKey);
    const expiresAt = Date.parse(saved.assertion.receivedAt) + 7 * 86400000;
    if (saved.assertion.proof.source !== 'external-id-signup' || saved.assertion.proof.subjectKey !== subjectKey ||
        saved.assertion.proof.providerKey !== providerKey || account.identitySubjectKey !== subjectKey ||
        account.accountId !== saved.accountId || slot.requestId !== saved.requestId || account.activation !== null ||
        saved.assertion.email !== account.email || saved.planId !== account.planId || saved.planSha256 !== account.planSha256) fail();
    fields(retained, ['schemaVersion', 'intent', 'providerKey', 'context', 'invitation', 'entry']);
    if (retained.schemaVersion !== 1 || retained.providerKey !== providerKey ||
        retained.intent !== hash({ account, details: saved, subjectKey, providerKey, identityPolicyId })) fail();
    const invitation = validateInvitationRecord(retained.invitation);
    // Validate the original entry at its genuinely recorded creation time.
    // Current active/revoked/expired authority is checked by the caller again.
    if (!Number.isSafeInteger(now) || invitation.createdAt > now) fail();
    const entry = authority(retained.entry, subjectKey, invitation.createdAt);
    fields(retained.context, ['schemaVersion', 'accountId', 'source']);
    const compiled = compileStarterProvisioning({ account, requestId: slot.requestId, source: retained.context.source });
    const expectedEntry = { schemaVersion: 2, subjectKey, email: account.email, revision: 0, status: 'active',
        invitationDigest: invitation.tokenDigest, invitationId: invitation.invitationId,
        tenantId: slot.tenantId, organisationId: slot.organisationId, ...saved.offer.terms,
        scheduleId: slot.scheduleId, scheduleDigest: saved.offer.schedule.scheduleDigest,
        bindingId: slot.bindingId, accountType: account.accountType,
        expiresAt: starterAuthorityExpiry(expiresAt, account.planId) };
    if (retained.context.schemaVersion !== 1 || retained.context.accountId !== account.accountId || compiled.subjectKey !== subjectKey ||
        !equal(compiled.source.offerInput, saved.offerInput) || invitation.tokenDigest !== entry.invitationDigest ||
        invitation.invitationId !== entry.invitationId || invitation.expectedEmail !== account.email || invitation.status !== 'invited' ||
        invitation.identityPolicyId !== identityPolicyId || invitation.mfaRequired !== false || invitation.revision !== 0 || invitation.acceptance !== null ||
        invitation.createdAt < Date.parse(saved.assertion.receivedAt) || invitation.expiresAt !== expiresAt ||
        compiled.source.createdAt !== saved.assertion.receivedAt ||
        ['tenantId', 'organisationId', 'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'].some(k => invitation[k] !== expectedEntry[k]) ||
        !equal(entry, expectedEntry)) fail();
    return { invitation, entry };
}

// A claim reserves ownership; it neither delivers an invitation nor accepts
// terms or grants dashboard membership. Its immutable record makes generated
// IDs recoverable before the separate authority write. Completed missing or
// changed authority is never silently recreated.
function createExternalStarterClaim({ container, invitations, identityPolicyId, providerKey, readOtherAuthority, now = Date.now }) {
    if (!container || typeof container.getBlockBlobClient !== 'function' || typeof readOtherAuthority !== 'function' ||
        !/^[a-f0-9]{64}$/.test(providerKey) || typeof identityPolicyId !== 'string' || !identityPolicyId) fail();
    async function read(key) {
        try {
            const response = await container.getBlockBlobClient(key).download(0, LIMIT + 1, { abortSignal: AbortSignal.timeout(5000) });
            let length = 0; const chunks = [];
            try {
                for await (const bytes of response.readableStreamBody) {
                    length += bytes.length; if (length > LIMIT) fail(); chunks.push(bytes);
                }
            } finally { response.readableStreamBody?.destroy(); }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch (error) { if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null; throw error; }
    }
    async function create(key, value) {
        const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > LIMIT) fail();
        try { await container.getBlockBlobClient(key).uploadData(bytes, { conditions: { ifNoneMatch: '*' },
            abortSignal: AbortSignal.timeout(5000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
        catch (error) { if (![409, 412].includes(error?.statusCode)) throw error; }
        return read(key);
    }
    return async function claim({ account: rawAccount, details: rawDetails, subjectKey, beforeMutation }) {
        if (typeof beforeMutation !== 'function') fail();
        subject(subjectKey);
        const account = starterAccountRecord(rawAccount), saved = starterSetupRecord(rawDetails), slot = account.organisations[0];
        if (saved.assertion.proof.source !== 'external-id-signup' || saved.assertion.proof.subjectKey !== subjectKey ||
            account.identitySubjectKey !== subjectKey) fail();
        if (account.accountId !== saved.accountId || slot.requestId !== saved.requestId || account.activation !== null ||
            saved.assertion.email !== account.email || saved.planId !== account.planId || saved.planSha256 !== account.planSha256) fail();
        const expiresAt = Date.parse(saved.assertion.receivedAt) + 7 * 86400000;
        if (expiresAt <= now()) fail();
        const key = `customer-starter/external-claims/${uuid(account.accountId)}.json`;
        const intent = hash({ account, details: saved, subjectKey, providerKey, identityPolicyId });
        await beforeMutation();
        let retained = await read(key);
        if (retained === null) {
            const invitation = createInvitation({ email: account.email, tenantId: slot.tenantId, organisationId: slot.organisationId,
                identityPolicyId, ...saved.offer.terms, scheduleId: slot.scheduleId, scheduleDigest: saved.offer.schedule.scheduleDigest,
                mfaRequired: false, createdAt: now(), expiresAt }, { now }).record;
            const context = { schemaVersion: 1, accountId: account.accountId, source: { offerInput: saved.offerInput,
                subjectKey, issuerSubjectKey: subjectKey, invitationId: invitation.invitationId, createdAt: saved.assertion.receivedAt } };
            const entry = authority({ schemaVersion: 2, subjectKey, email: account.email, revision: 0, status: 'active',
                invitationDigest: invitation.tokenDigest, invitationId: invitation.invitationId,
                tenantId: slot.tenantId, organisationId: slot.organisationId, ...saved.offer.terms,
                scheduleId: slot.scheduleId, scheduleDigest: saved.offer.schedule.scheduleDigest,
                bindingId: slot.bindingId, accountType: account.accountType,
                expiresAt: starterAuthorityExpiry(expiresAt, account.planId) }, subjectKey, now());
            await beforeMutation();
            retained = await create(key, { schemaVersion: 1, intent, providerKey, context, invitation, entry });
        }
        const { invitation, entry } = validateRetainedExternalStarterClaim(retained,
            { account, details: saved, subjectKey, providerKey, identityPolicyId, now: now() });
        authority(entry, subjectKey, now());
        if (await readOtherAuthority(subjectKey) !== null) fail();
        const subjectPath = `customer-subjects/${subjectHash(subjectKey)}.json`, completePath = key.replace('.json', '.complete.json');
        const complete = await read(completePath), existing = await read(subjectPath);
        if (complete !== null) {
            if (!equal(complete, { schemaVersion: 1, claimSha256: hash(retained) }) || !equal(existing, entry)) fail();
            await beforeMutation(); return copy(entry);
        }
        if (existing !== null && !equal(existing, entry) || await readOtherAuthority(subjectKey) !== null) fail();
        await beforeMutation();
        if (!equal(await create(`customer-starter/contexts/${slot.organisationId}.json`, retained.context), retained.context)) fail();
        const beforeInvitation = await invitations.read(invitation.tokenDigest);
        if (beforeInvitation === null) {
            await beforeMutation();
            try { await invitations.create(invitation); }
            catch (error) { if (!equal(await invitations.read(invitation.tokenDigest), invitation)) throw error; }
        } else if (!equal(beforeInvitation, invitation)) fail();
        await beforeMutation();
        if (!equal(await create(subjectPath, entry), entry)) fail();
        const completion = { schemaVersion: 1, claimSha256: hash(retained) };
        if (!equal(await create(completePath, completion), completion)) fail();
        await beforeMutation();
        if (!equal(await read(subjectPath), entry)) fail();
        return copy(entry);
    };
}
module.exports = { createExternalStarterClaim, validateRetainedExternalStarterClaim };
