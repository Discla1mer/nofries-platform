'use strict';

const { createHash } = require('node:crypto');
const { fields, copy, uuid, digest, revision } = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { workEmail, accountType, setupReferenceKey } = require('../organisationSetup');
const { authority, termsOffer, scheduleArchive, subjectHash, createCustomerRecords } = require('./customerAuthority');
const { provisionCustomerInvitation } = require('./provisionCustomerInvitation');
const MAX_BYTES = 32768;
const fail = () => { throw new Error('setup_provisioning_reconciliation_required'); };
const hash = text => createHash('sha256').update(text).digest('hex');
const key = (kind, requestId) => {
    setupReferenceKey(requestId);
    return `customer-setup-${kind}/${hash('nofries:setup-binding:v1\0' + requestId)}.json`;
};
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);
// Legacy defaults cannot stand in for explicit approval of a newly stored type.
const sameAccountType = (a, b) => Object.hasOwn(a, 'accountType') === Object.hasOwn(b, 'accountType') &&
    accountType(a.accountType) === accountType(b.accountType);
function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 180 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail();
}
function instant(value) { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(); }
function verifiedSnapshot(raw, requestId) {
    const r = fields(copy(raw, 8192), ['schemaVersion', 'requestId', 'organisationName', 'email', 'status',
        'codeHash', 'attempts', 'createdAt', 'codeExpiresAt', 'expiresAt', 'verifiedAt',
        ...(Object.hasOwn(raw, 'accountType') ? ['accountType'] : [])]);
    accountType(r.accountType);
    setupReferenceKey(requestId);
    for (const value of [r.createdAt, r.codeExpiresAt, r.expiresAt, r.verifiedAt]) instant(value);
    if (r.schemaVersion !== 1 || r.requestId !== requestId || r.status !== 'verified' || r.codeHash !== null ||
        !Number.isSafeInteger(r.attempts) || r.attempts < 0 || r.attempts >= 5 ||
        r.email !== workEmail(r.email) || typeof r.organisationName !== 'string' ||
        !r.organisationName || r.organisationName.length > 120 || r.organisationName !== r.organisationName.trim().normalize('NFC') ||
        /[\u0000-\u001f\u007f-\u009f<>]/u.test(r.organisationName) ||
        r.codeExpiresAt !== r.createdAt + 600000 || r.expiresAt !== r.createdAt + 86400000 ||
        r.verifiedAt < r.createdAt || r.verifiedAt >= r.codeExpiresAt) fail();
    return Object.freeze({ requestId, email: r.email, organisationName: r.organisationName,
        ...(Object.hasOwn(r, 'accountType') ? { accountType: r.accountType } : {}),
        createdAt: r.createdAt, verifiedAt: r.verifiedAt, expiresAt: r.expiresAt });
}
function approvalRecord(raw) {
    const a = fields(copy(raw, 16384), ['schemaVersion', 'requestId', 'approvalId', 'representativeAuthorityEvidenceId', 'invitationApprovalEvidenceId',
        'approvedAt', 'organisationName', 'expectedAuthorityRevision', 'email', 'displayName', 'tenantId', 'organisationId',
        'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest', 'expiresAt', 'authorityExpiresAt',
        ...(Object.hasOwn(raw, 'accountType') ? ['accountType'] : [])]);
    accountType(a.accountType);
    if (a.schemaVersion !== 1) fail();
    setupReferenceKey(a.requestId); uuid(a.approvalId);
    for (const name of ['representativeAuthorityEvidenceId', 'invitationApprovalEvidenceId', 'displayName', 'tenantId', 'organisationId', 'termsVersion', 'scheduleId']) identifier(a[name]);
    if (a.displayName !== a.displayName.normalize('NFC') || a.displayName.length > 160 || Buffer.byteLength(a.displayName, 'utf8') > 320) fail();
    if (a.email !== workEmail(a.email) || typeof a.organisationName !== 'string' || !a.organisationName ||
        a.organisationName.length > 120 || a.organisationName !== a.organisationName.trim().normalize('NFC') ||
        /[\u0000-\u001f\u007f-\u009f<>]/u.test(a.organisationName)) fail();
    digest(a.termsDigest); digest(a.scheduleDigest);
    if (a.expectedAuthorityRevision !== null) revision(a.expectedAuthorityRevision);
    for (const value of [a.approvedAt, a.expiresAt, a.authorityExpiresAt]) instant(value);
    if (a.expiresAt <= a.approvedAt || a.expiresAt > a.approvedAt + 7 * 86400000 || a.authorityExpiresAt < a.expiresAt) fail();
    return Object.freeze(a);
}
async function read(container, name) {
    try {
        const response = await container.getBlockBlobClient(name).download(0, MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) });
        let length = 0; const chunks = [];
        try { for await (const bytes of response.readableStreamBody) {
            length += bytes.length; if (length > MAX_BYTES) fail(); chunks.push(bytes);
        } } finally { response.readableStreamBody?.destroy(); }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
        if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
        fail();
    }
}
async function createExact(container, name, value) {
    const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > MAX_BYTES) fail();
    try { await container.getBlockBlobClient(name).uploadData(bytes, { conditions: { ifNoneMatch: '*' },
        abortSignal: AbortSignal.timeout(5000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
    } catch (error) { if (![409, 412].includes(error?.statusCode)) throw error; }
    const saved = await read(container, name);
    if (!saved || !same(saved, value)) fail();
    return saved;
}
function bindingRecord(raw, requestId) {
    const value = fields(copy(raw, MAX_BYTES), ['schemaVersion', 'requestId', 'request', 'approval', 'context', 'createdAt']);
    const a = approvalRecord(value.approval);
    const r = fields(value.request, ['requestId', 'email', 'organisationName', 'createdAt', 'verifiedAt', 'expiresAt',
        ...(Object.hasOwn(value.request, 'accountType') ? ['accountType'] : [])]);
    if (!sameAccountType(r, a)) fail();
    const c = fields(value.context, ['identityTenantId', 'identityPolicyId', 'publicOrigin']);
    uuid(c.identityTenantId); identifier(c.identityPolicyId);
    if (typeof c.publicOrigin !== 'string' || new URL(c.publicOrigin).origin !== c.publicOrigin || !c.publicOrigin.startsWith('https://')) fail();
    for (const time of [r.createdAt, r.verifiedAt, r.expiresAt, value.createdAt]) instant(time);
    if (value.schemaVersion !== 1 || value.requestId !== requestId || a.requestId !== requestId || r.requestId !== requestId ||
        r.email !== a.email || r.organisationName !== a.organisationName || r.verifiedAt < r.createdAt ||
        r.verifiedAt >= r.createdAt + 600000 || r.expiresAt !== r.createdAt + 86400000 ||
        a.approvedAt < r.verifiedAt || value.createdAt < a.approvedAt || value.createdAt >= r.expiresAt ||
        value.createdAt >= a.expiresAt) fail();
    return value;
}
async function currentOffer(records, a, at) {
    const [terms, offered, schedule] = await Promise.all([records.readTerms(a.termsDigest),
        records.readTermsOffer(a.tenantId, a.organisationId), records.readSchedule(a.scheduleId, a.scheduleDigest)]);
    fields(terms, ['termsText', 'termsVersion', 'termsDigest']);
    if (typeof terms.termsText !== 'string' || !terms.termsText || Buffer.byteLength(terms.termsText) > 32768 ||
        terms.termsVersion !== a.termsVersion || terms.termsDigest !== a.termsDigest || hash(terms.termsText) !== a.termsDigest) fail();
    const offer = termsOffer(offered, a, at);
    scheduleArchive(schedule, offer);
    return offer.expiresAt;
}
function completionRecord(raw, binding) {
    const c = fields(copy(raw, 8192), ['schemaVersion', 'requestId', 'bindingSha256', 'result', 'completedAt']);
    fields(c.result, ['subjectKey', 'invitationId', 'status']); instant(c.completedAt);
    const parts = c.result.subjectKey?.split(':');
    if (!parts || parts.length !== 2) fail(); parts.forEach(uuid); identifier(c.result.invitationId);
    if (c.schemaVersion !== 1 || c.requestId !== binding.requestId || c.bindingSha256 !== canonicalDigest(binding) ||
        parts[0] !== binding.context.identityTenantId || c.result.status !== 'pending_admission' || c.completedAt < binding.createdAt) fail();
    return c;
}
async function inspectIdentity(graph, records, a, identityTenantId) {
    const matches = await graph.findGuestsByEmail(a.email);
    if (!Array.isArray(matches) || matches.length > 1) fail();
    if (!matches.length) { if (a.expectedAuthorityRevision !== null) fail(); return; }
    const guest = fields(copy(matches[0], 8192), ['id', 'mail', 'userType']);
    uuid(guest.id);
    if (guest.userType !== 'Guest' || workEmail(guest.mail) !== a.email) fail();
    const subject = `${identityTenantId}:${guest.id}`, prior = await records.readSubject(subject);
    if (prior ? prior.subjectKey !== subject || prior.revision !== a.expectedAuthorityRevision : a.expectedAuthorityRevision !== null) fail();
}

// Administrative entry point only. A fresh mailbox proof and a separate exact
// approval are both necessary. Existing durable binding permits safe recovery
// after transient cleanup, but cannot change scope or authorize a replacement.
async function provisionVerifiedOrganisationSetup({ approval: input, setupStore, authorityContainer,
    identityTenantId, identityPolicyId, publicOrigin, graph, invitations, beforeMutation = async () => {}, inspectOnly = false, now = Date.now }) {
    const a = approvalRecord(input), requestId = a.requestId;
    const context = { identityTenantId, identityPolicyId, publicOrigin };
    const records = createCustomerRecords({ authorityContainer, sessionContainer: null });
    let saved = await read(authorityContainer, key('bindings', requestId));
    let binding;
    if (saved) {
        binding = bindingRecord(saved, requestId);
        if (!same(binding.approval, a) || !same(binding.context, context)) fail();
    } else {
        const reference = (await setupStore.load(setupReferenceKey(requestId)))?.record;
        fields(reference, ['schemaVersion', 'requestId', 'requestKey', 'expiresAt']);
        if (reference.schemaVersion !== 1 || reference.requestId !== requestId || !/^requests\/[a-f0-9]{64}$/.test(reference.requestKey)) fail();
        const record = (await setupStore.load(reference.requestKey))?.record;
        const snapshot = verifiedSnapshot(record, requestId), at = now();
        if (reference.expiresAt !== snapshot.expiresAt || snapshot.expiresAt <= at || a.approvedAt > at || a.expiresAt <= at ||
            snapshot.email !== a.email || snapshot.organisationName !== a.organisationName ||
            !sameAccountType(snapshot, a)) fail();
        await currentOffer(records, a, at);
        await inspectIdentity(graph, records, a, identityTenantId);
        const checkedAt = now();
        binding = bindingRecord({ schemaVersion: 1, requestId, request: snapshot, approval: a, context, createdAt: checkedAt }, requestId);
        // The read-only policy/source guard also gates inspection readiness.
        await beforeMutation();
        if (snapshot.expiresAt <= now() || a.expiresAt <= now()) fail();
        if (inspectOnly) return Object.freeze({ requestId, status: 'ready_to_provision', accessGranted: false });
        try { saved = await createExact(authorityContainer, key('bindings', requestId), binding); }
        catch (error) {
            // A concurrent exact binding may have a different creation instant.
            const concurrent = await read(authorityContainer, key('bindings', requestId));
            if (!concurrent) throw error;
            const candidate = bindingRecord(concurrent, requestId);
            if (!same(candidate.request, snapshot) || !same(candidate.approval, a) || !same(candidate.context, context)) fail();
            saved = candidate;
        }
        binding = bindingRecord(saved, requestId);
    }
    const completed = await read(authorityContainer, key('completions', requestId));
    // Exact historical completion is returned without reopening delivery or
    // asserting that today's policy still permits customer sign-in.
    if (completed) return Object.freeze(completionRecord(completed, binding).result);
    if (a.approvedAt > now() || a.expiresAt <= now() || a.authorityExpiresAt <= now()) fail();
    await currentOffer(records, a, now());
    await beforeMutation();
    // Cloud/source guards can be slow. Re-read the current offer after them,
    // before entering the invitation helper's bounded lease.
    const offerExpiresAt = await currentOffer(records, a, now());
    if (a.expiresAt <= now() || offerExpiresAt <= now()) fail();
    if (inspectOnly) return Object.freeze({ requestId, status: 'ready_to_resume', accessGranted: false });
    const { schemaVersion, requestId: ignoredRequest, approvalId, representativeAuthorityEvidenceId, invitationApprovalEvidenceId,
        approvedAt, organisationName, expectedAuthorityRevision, ...invitationApproval } = a;
    const result = await provisionCustomerInvitation({ requestId, expectedAuthorityRevision, approval: invitationApproval,
        identityTenantId, identityPolicyId, publicOrigin, graph, invitations, authorityContainer, now });
    const completion = { schemaVersion: 1, requestId, bindingSha256: canonicalDigest(binding), result, completedAt: now() };
    completionRecord(completion, binding);
    const prior = await read(authorityContainer, key('completions', requestId));
    if (prior) {
        const valid = completionRecord(prior, binding); if (!same(valid.result, result)) fail();
    } else await createExact(authorityContainer, key('completions', requestId), completion);
    return Object.freeze(result);
}

// Reader-only projection. Its caller has already resolved the original opaque
// browser cookie; requestId is never accepted from a browser query/body here.
async function readOrganisationSetupContinuation({ record, authorityContainer, now = Date.now }) {
    const snapshot = verifiedSnapshot(record, record?.requestId);
    if (snapshot.expiresAt <= now()) return 'pending_activation';
    const raw = await read(authorityContainer, key('bindings', snapshot.requestId));
    if (!raw) return 'pending_activation';
    const binding = bindingRecord(raw, snapshot.requestId);
    if (!same(binding.request, snapshot)) fail();
    const completion = await read(authorityContainer, key('completions', snapshot.requestId));
    if (!completion || binding.approval.expiresAt <= now()) return 'pending_activation';
    const result = completionRecord(completion, binding).result;
    const current = authority(await read(authorityContainer, `customer-subjects/${subjectHash(result.subjectKey)}.json`), result.subjectKey, now());
    if (['email', 'tenantId', 'organisationId', 'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest']
        .some(name => current[name] !== binding.approval[name]) || current.invitationId !== result.invitationId ||
        !sameAccountType(current, binding.approval)) fail();
    return 'check_invitation';
}
module.exports = { provisionVerifiedOrganisationSetup, readOrganisationSetupContinuation,
    approvalRecord, verifiedSnapshot, bindingRecord, key };
