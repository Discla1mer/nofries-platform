'use strict';

// Structural inspection of customer sign-in authority records for the staff
// console. Read-only DATA contracts: nothing here authenticates a customer,
// and nothing in the console writes these records.
const { copy, fields, freeze, subject, id, uuid, digest, instant, revision, hash } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { subjectHash } = require('../customerSignup/customerAuthority');
const fail = () => { throw new Error('dashboard_admin_customer_authority_invalid'); };
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

module.exports = Object.freeze({ normaliseCustomerAuthoritySource, inspectCustomerAuthority });
