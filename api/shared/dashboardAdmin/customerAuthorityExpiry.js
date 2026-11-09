'use strict';

// DATA/proposal contracts, not authentication or approval issuance. Executors
// verify approval provenance, current authority and exact ETags, and audit writes.
// Scheduled schema-2 records cannot be extended: retained-trial readers require
// revision zero until separately verified expiry-only provenance exists.
const { copy, fields, freeze, subject, id, uuid, digest, instant, revision, hash, equal } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { subjectHash } = require('../customerSignup/customerAuthority');
const PURPOSE = 'customer_authority_expiry_extension';
const MAX_EXTENSION_MS = 90 * 24 * 60 * 60 * 1000;
const fail = () => { throw new Error('dashboard_admin_customer_authority_expiry_invalid'); };
const iso = value => {
    if (!Number.isSafeInteger(value) || value <= 0) fail();
    return instant(new Date(value).toISOString());
};
function etag(value) {
    if (typeof value !== 'string' || !/^"[\x21\x23-\x7e]{1,128}"$/.test(value)) fail();
}
function target(input) {
    const value = fields(copy(input, 2048), ['sourceSha256', 'subjectKey', 'tenantId', 'organisationId']);
    digest(value.sourceSha256); subject(value.subjectKey); id(value.tenantId); id(value.organisationId);
    return freeze(value);
}
function context(input) {
    const value = fields(copy(input, 2048), ['operatorSubjectKey', 'sessionSha256', 'instanceId', 'restoreEpoch',
        'identityPolicySha256', 'auditConfigurationSha256']);
    subject(value.operatorSubjectKey); digest(value.sessionSha256); digest(value.identityPolicySha256);
    // Binds independently approved audit configuration, not new retention permission.
    digest(value.auditConfigurationSha256);
    uuid(value.instanceId); uuid(value.restoreEpoch); return freeze(value);
}

function normaliseCustomerAuthoritySource(input) {
    const value = fields(copy(input, 2048), ['schemaVersion', 'kind', 'storageAccount', 'container',
        'providerKind', 'providerTenantId', 'providerConfigurationSha256']);
    if (value.schemaVersion !== 1 || !['legacy_admin', 'legacy_starter', 'external_starter'].includes(value.kind) ||
        value.providerKind !== (value.kind === 'external_starter' ? 'external-id' : 'workforce-b2b') ||
        typeof value.storageAccount !== 'string' || !/^[a-z0-9]{3,24}$/.test(value.storageAccount) ||
        typeof value.container !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.container)) fail();
    uuid(value.providerTenantId); digest(value.providerConfigurationSha256);
    return freeze(value);
}

// Structural schema-1/2 inspection, never authority(raw, subject, oldClock).
// Revocation and expiry are DATA here; neither is an authentication grant.
function authorityData(raw, expected) {
    const value = copy(raw, 16384), scheduled = ['scheduleId', 'scheduleDigest'].some(key => Object.hasOwn(value, key));
    fields(value, ['schemaVersion', 'subjectKey', 'email', 'revision', 'status', 'invitationDigest', 'invitationId',
        'tenantId', 'organisationId', 'termsVersion', 'termsDigest', ...(scheduled ? ['scheduleId', 'scheduleDigest'] : []),
        'bindingId', 'expiresAt', ...(Object.hasOwn(value, 'accountType') ? ['accountType'] : [])]);
    if (value.schemaVersion !== (scheduled ? 2 : 1) || !['active', 'revoked'].includes(value.status) ||
        ['subjectKey', 'tenantId', 'organisationId'].some(key => value[key] !== expected[key]) ||
        typeof value.email !== 'string' || value.email !== value.email.trim().toLowerCase() ||
        value.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) ||
        Object.hasOwn(value, 'accountType') && !['company', 'consultant'].includes(value.accountType)) fail();
    subject(value.subjectKey); revision(value.revision); iso(value.expiresAt);
    ['invitationDigest', 'termsDigest', ...(scheduled ? ['scheduleDigest'] : [])].forEach(key => digest(value[key]));
    if (value.bindingId !== null) uuid(value.bindingId);
    for (const key of ['invitationId', 'tenantId', 'organisationId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) {
        if (typeof value[key] !== 'string' || !value[key] || value[key].length > 180 || /[\x00-\x1f\x7f]/.test(value[key])) fail();
    }
    return freeze(value);
}
function observation(input, expected, now) {
    instant(now);
    const value = fields(copy(input, 24576), ['source', 'blobName', 'etag', 'observedAt', 'record']);
    value.source = normaliseCustomerAuthoritySource(value.source);
    instant(value.observedAt);
    if (value.observedAt > now || Date.parse(now) - Date.parse(value.observedAt) > 30000 ||
        hash(value.source) !== expected.sourceSha256 || value.source.providerTenantId !== expected.subjectKey.slice(0, 36) ||
        value.blobName !== `customer-subjects/${subjectHash(expected.subjectKey)}.json`) fail();
    if (value.record === null) { if (value.etag !== null) fail(); }
    else { etag(value.etag); value.record = authorityData(value.record, expected); }
    return freeze(value);
}
function project(value, now) {
    const r = value.record;
    return freeze({ status: r === null ? 'missing' : r.status === 'revoked' ? 'revoked' : r.expiresAt <= Date.parse(now) ? 'expired' : 'active',
        expiresAt: r === null ? null : iso(r.expiresAt), revision: r?.revision ?? null,
        authoritySha256: r === null ? null : hash(r), etag: value.etag, observedAt: value.observedAt });
}
function inspectCustomerAuthority(input, expected, now) {
    return project(observation(input, target(expected), now), now);
}

function command(input) {
    const value = fields(copy(input, 4096), ['schemaVersion', 'purpose', 'operationId', 'target',
        'beforeSha256', 'beforeEtag', 'beforeRevision', 'beforeExpiresAt', 'newExpiresAt']);
    if (value.schemaVersion !== 1 || value.purpose !== PURPOSE) fail();
    uuid(value.operationId); value.target = target(value.target); digest(value.beforeSha256); etag(value.beforeEtag);
    revision(value.beforeRevision); instant(value.beforeExpiresAt); instant(value.newExpiresAt);
    if (value.beforeRevision === Number.MAX_SAFE_INTEGER || value.newExpiresAt <= value.beforeExpiresAt) fail();
    return freeze(value);
}
function customerAuthorityExpiryCommandHash(input, actor) {
    return hash({ recordType: PURPOSE, command: command(input), context: context(actor) });
}
function approval(input, proposed, actor, now) {
    const value = fields(copy(input, 8192), ['schemaVersion', 'purpose', 'status', 'approvalId', 'revision',
        'context', 'commandSha256', 'approvedExpiresAt', 'issuedAt', 'expiresAt']);
    if (value.schemaVersion !== 1 || value.purpose !== PURPOSE || value.status !== 'active') fail();
    uuid(value.approvalId); revision(value.revision); value.context = context(value.context); digest(value.commandSha256);
    for (const key of ['approvedExpiresAt', 'issuedAt', 'expiresAt']) instant(value[key]);
    if (!equal(value.context, actor) || value.commandSha256 !== customerAuthorityExpiryCommandHash(proposed, actor) ||
        value.approvedExpiresAt !== proposed.newExpiresAt || value.issuedAt > now || value.expiresAt <= now ||
        value.issuedAt >= value.expiresAt || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 3600000) fail();
    return freeze(value);
}

function planCustomerAuthorityExpiry(input, now) {
    const raw = fields(copy(input, 49152), ['observation', 'command', 'context', 'approval']);
    instant(now);
    const proposed = command(raw.command), actor = context(raw.context);
    const seen = observation(raw.observation, proposed.target, now), before = seen.record;
    const approved = approval(raw.approval, proposed, actor, now);
    // The server's current time bounds the extension, never approval timestamps.
    if (before === null || before.schemaVersion !== 1 || before.status !== 'active' || before.expiresAt > Date.parse(now) ||
        proposed.newExpiresAt <= now || Date.parse(proposed.newExpiresAt) - Date.parse(now) > MAX_EXTENSION_MS ||
        proposed.beforeSha256 !== hash(before) ||
        proposed.beforeEtag !== seen.etag || proposed.beforeRevision !== before.revision ||
        proposed.beforeExpiresAt !== iso(before.expiresAt)) fail();
    const after = { ...before, expiresAt: Date.parse(proposed.newExpiresAt), revision: before.revision + 1 };
    // No entitlement, membership, binding, invitation, terms or schedule renewal.
    return freeze({ schemaVersion: 1, purpose: PURPOSE, command: proposed, context: actor,
        commandSha256: customerAuthorityExpiryCommandHash(proposed, actor), source: seen.source, blobName: seen.blobName,
        before: { sha256: hash(before), etag: seen.etag, revision: before.revision, expiresAt: iso(before.expiresAt) },
        after: { sha256: hash(after), record: after }, approval: approved, approvalSha256: hash(approved),
        observedAt: seen.observedAt, plannedAt: now });
}

module.exports = Object.freeze({ normaliseCustomerAuthoritySource, inspectCustomerAuthority,
    customerAuthorityExpiryCommandHash, planCustomerAuthorityExpiry });
