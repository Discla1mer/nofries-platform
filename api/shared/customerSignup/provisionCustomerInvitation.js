'use strict';

const { randomUUID } = require('node:crypto');
const { uuid, fields, copy, revision } = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { createInvitation } = require('./invitationAcceptance');
const { createEntraB2bInvitationService } = require('./entraB2bInvitation');
const { subjectHash, authority } = require('./customerAuthority');
const conflict = () => { throw new Error('signup_invitation_reconciliation_required'); };
async function read(blob) {
    try {
        const value = await blob.download(0, 32769, { abortSignal: AbortSignal.timeout(5000) });
        let size = 0; const chunks = [];
        try { for await (const bytes of value.readableStreamBody) {
            size += bytes.length; if (size > 32768) conflict(); chunks.push(bytes);
        } } finally { value.readableStreamBody?.destroy(); }
        if (typeof value.etag !== 'string' || !value.etag) conflict();
        return { record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), etag: value.etag };
    } catch (error) {
        if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
        throw error;
    }
}
const upload = (blob, record, conditions) => blob.uploadData(Buffer.from(JSON.stringify(record)), {
    conditions, abortSignal: AbortSignal.timeout(5000),
    blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
});

// Legacy provisioning writes its administrative container. The fixed starter
// path uses a separate container and cannot replace an existing authority.
// Stable request IDs fence delivery; ETags and an explicit predecessor revision
// protect replacements. No membership is created. Ambiguous Graph delivery
// requires reconciliation, while acknowledged delivery can resume finalization.
async function provisionCustomerInvitation({ requestId, expectedAuthorityRevision = null, approval: input,
    identityTenantId, identityPolicyId, publicOrigin, graph, invitations, authorityContainer, now = Date.now,
    initialBindingId = null, readOtherAuthority = async () => null, verifyDelivery = async () => true,
    sendMemberInvitation }) {
    requestId = uuid(requestId);
    if (initialBindingId !== null) uuid(initialBindingId);
    if (typeof readOtherAuthority !== 'function' || typeof verifyDelivery !== 'function' || initialBindingId !== null && expectedAuthorityRevision !== null) conflict();
    if (expectedAuthorityRevision !== null) revision(expectedAuthorityRevision);
    if (sendMemberInvitation !== undefined && (typeof sendMemberInvitation !== 'function' || typeof graph.findUsersByEmail !== 'function')) conflict();
    const findAccounts = sendMemberInvitation ? graph.findUsersByEmail : graph.findGuestsByEmail;
    const approval = fields(copy(input, 16384), ['email', 'displayName', 'tenantId', 'organisationId',
        'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest', 'expiresAt', 'authorityExpiresAt',
        ...(Object.hasOwn(input, 'accountType') ? ['accountType'] : [])]);
    if (Object.hasOwn(approval, 'accountType') && !['company', 'consultant'].includes(approval.accountType)) conflict();
    if (!Number.isSafeInteger(approval.authorityExpiresAt) || approval.authorityExpiresAt <= now()) conflict();
    const intent = canonicalDigest({ approval, identityTenantId, identityPolicyId, publicOrigin, expectedAuthorityRevision,
        ...(initialBindingId !== null ? { initialBindingId } : {}) });
    const attemptBlob = authorityContainer.getBlockBlobClient(`customer-invitation-attempts/${requestId}.json`);
    let saved = await read(attemptBlob);
    if (!saved) {
        const invitation = createInvitation({ email: approval.email, tenantId: approval.tenantId,
            organisationId: approval.organisationId, identityPolicyId, termsVersion: approval.termsVersion,
            termsDigest: approval.termsDigest, scheduleId: approval.scheduleId, scheduleDigest: approval.scheduleDigest,
            mfaRequired: true, createdAt: now(), expiresAt: approval.expiresAt }, { now });
        // Validate provider configuration before reserving a delivery attempt.
        createEntraB2bInvitationService({ tenantId: identityTenantId, redirectUrl: `${publicOrigin}/signup`,
            bootstrapToken: invitation.invitationToken, findGuestsByEmail: findAccounts, createInvitation: graph.createInvitation,
            ...(sendMemberInvitation ? { sendMemberInvitation } : {}) });
        try { await upload(attemptBlob, { schemaVersion: 1, intent, phase: 'prepared', ...invitation }, { ifNoneMatch: '*' }); }
        catch (error) { if (![409, 412].includes(error?.statusCode)) throw error; }
    }
    const lease = attemptBlob.getBlobLeaseClient(randomUUID());
    const acquired = await lease.acquireLease(60);
    if (typeof acquired?.leaseId !== 'string' || !acquired.leaseId) conflict();
    try {
        saved = await read(attemptBlob);
        if (!saved || saved.record.schemaVersion !== 1 || saved.record.intent !== intent) conflict();
        let attempt = saved.record;
        async function checkpoint(next) {
            await upload(attemptBlob, next, { ifMatch: saved.etag, leaseId: acquired.leaseId });
            saved = await read(attemptBlob);
            if (!saved || canonicalDigest(saved.record) !== canonicalDigest(next)) conflict();
            attempt = saved.record;
        }
        if (attempt.phase === 'complete') return Object.freeze(copy(attempt.result));
        if (attempt.phase === 'delivering') conflict(); // Never blindly resend.
        if (attempt.phase === 'prepared') {
            if (attempt.record.expiresAt <= now()) conflict();
            try { await invitations.create(attempt.record); }
            catch (error) {
                if (error?.code !== 'signup_store_conflict' ||
                    canonicalDigest(await invitations.read(attempt.record.tokenDigest)) !== canonicalDigest(attempt.record)) throw error;
            }
            let prior = null, priorSubject = null;
            async function deliver(action) {
                if (await verifyDelivery() !== true) conflict();
                const { invitationToken: discardedCapability, ...reserved } = attempt;
                await checkpoint({ ...reserved, phase: 'delivering', prior, priorSubject });
                if (await verifyDelivery() !== true) conflict();
                return action();
            }
            const provider = createEntraB2bInvitationService({ tenantId: identityTenantId, redirectUrl: `${publicOrigin}/signup`,
                bootstrapToken: attempt.invitationToken,
                ...(sendMemberInvitation ? { sendMemberInvitation: body => deliver(() => sendMemberInvitation(body)) } : {}),
                async findGuestsByEmail(email) {
                    const matches = await findAccounts(email);
                    if (Array.isArray(matches) && matches.length === 1) {
                        priorSubject = `${uuid(identityTenantId)}:${uuid(matches[0].id)}`;
                        if (await readOtherAuthority(priorSubject) !== null) conflict();
                        prior = await read(authorityContainer.getBlockBlobClient(`customer-subjects/${subjectHash(priorSubject)}.json`));
                        if (prior ? prior.record.subjectKey !== priorSubject || prior.record.revision !== expectedAuthorityRevision : expectedAuthorityRevision !== null) conflict();
                    } else if (expectedAuthorityRevision !== null) conflict();
                    return matches;
                },
                async createInvitation(body) {
                    return deliver(() => graph.createInvitation(body));
                }
            });
            const guest = await provider.resolveOrInvite({ email: approval.email, displayName: approval.displayName });
            if (priorSubject && guest.subjectKey !== priorSubject) conflict();
            if (await readOtherAuthority(guest.subjectKey) !== null) conflict();
            const entry = authority({ schemaVersion: 2, subjectKey: guest.subjectKey, email: guest.email,
                revision: prior ? expectedAuthorityRevision + 1 : 0, status: 'active',
                invitationDigest: attempt.record.tokenDigest, invitationId: attempt.record.invitationId,
                tenantId: approval.tenantId, organisationId: approval.organisationId,
                termsVersion: approval.termsVersion, termsDigest: approval.termsDigest,
                scheduleId: approval.scheduleId, scheduleDigest: approval.scheduleDigest,
                bindingId: initialBindingId, expiresAt: approval.authorityExpiresAt,
                ...(Object.hasOwn(approval, 'accountType') ? { accountType: approval.accountType } : {}) }, guest.subjectKey, now());
            await checkpoint({ ...attempt, phase: 'delivered', entry });
        }
        if (attempt.phase !== 'delivered') conflict();
        const entry = authority(attempt.entry, attempt.entry.subjectKey, now());
        const subjectBlob = authorityContainer.getBlockBlobClient(`customer-subjects/${subjectHash(entry.subjectKey)}.json`);
        const current = await read(subjectBlob);
        if (!current || canonicalDigest(current.record) !== canonicalDigest(entry)) {
            if (attempt.prior ? !current || current.etag !== attempt.prior.etag ||
                canonicalDigest(current.record) !== canonicalDigest(attempt.prior.record) : current !== null) conflict();
            await upload(subjectBlob, entry, current ? { ifMatch: current.etag } : { ifNoneMatch: '*' });
        }
        const result = { subjectKey: entry.subjectKey, invitationId: entry.invitationId, status: 'pending_admission' };
        await checkpoint({ ...attempt, phase: 'complete', result });
        return Object.freeze(result);
    } finally { await lease.releaseLease(); }
}
module.exports = { provisionCustomerInvitation };
