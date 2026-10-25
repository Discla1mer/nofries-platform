'use strict';

// Closed data contracts only. Validation never issues operator authority or
// establishes that a supplied manifest is currently approved.
const { copy, fields, freeze, subject, id, uuid, digest, instant, revision, hash, equal } =
    require('../appLifecycle/dashboardRuntimeRecords');
const FIELD_SET = Object.freeze(['email', 'organisation', 'accountType', 'milestones']);
const COMMON_SCOPE_KEYS = Object.freeze(['provider', 'populationId', 'indexId']);
const BINDING_KEYS = Object.freeze(['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey']);
const fail = () => { throw new Error('dashboard_admin_signup_authority_invalid'); };
const integer = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;

function normaliseSignupAuthority(input, { actorSubjectKey, now } = {}) {
    const value = copy(input, 4096);
    if (![1, 2].includes(value.schemaVersion)) fail();
    fields(value, ['schemaVersion', 'capability', 'operatorSubjectKey', ...COMMON_SCOPE_KEYS,
        value.schemaVersion === 1 ? 'tenantId' : 'scope', 'authorityRevision', 'issuedAt', 'expiresAt',
        'maxPageSize', 'maxRows', 'maxPages', 'fields', 'auditPolicyId']);
    if (value.capability !== 'signupList' || !['legacy', 'external'].includes(value.provider)) fail();
    subject(value.operatorSubjectKey);
    if (actorSubjectKey !== undefined && value.operatorSubjectKey !== subject(actorSubjectKey)) fail();
    ['populationId', 'indexId', 'auditPolicyId'].forEach(key => id(value[key]));
    if (value.schemaVersion === 1) id(value.tenantId);
    else {
        fields(value.scope, ['kind', 'manifestSha256']);
        if (value.scope.kind !== 'finite_manifest') fail();
        digest(value.scope.manifestSha256);
    }
    revision(value.authorityRevision); instant(value.issuedAt); instant(value.expiresAt);
    if (value.expiresAt <= value.issuedAt || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 3600000 ||
        !integer(value.maxPageSize, 25) || !integer(value.maxRows, 100) || !integer(value.maxPages, 10) ||
        value.maxPageSize > value.maxRows || !equal(value.fields, FIELD_SET)) fail();
    if (now !== undefined && (instant(now), value.issuedAt > now || value.expiresAt <= now)) fail();
    return freeze(value);
}

function normaliseSignupManifest(input) {
    const value = copy(input, 131072);
    if (![1, 2].includes(value.schemaVersion)) fail();
    fields(value, ['schemaVersion', ...COMMON_SCOPE_KEYS, ...(value.schemaVersion === 1 ? ['tenantId'] : []), 'entries']);
    if (!['legacy', 'external'].includes(value.provider) || !Array.isArray(value.entries) || value.entries.length > 100) fail();
    ['populationId', 'indexId', ...(value.schemaVersion === 1 ? ['tenantId'] : [])].forEach(key => id(value[key]));
    const records = new Set(), accounts = new Set();
    for (const entry of value.entries) {
        fields(entry, ['recordId', 'binding']); id(entry.recordId);
        const binding = fields(entry.binding, BINDING_KEYS);
        if (binding.provider !== value.provider || value.schemaVersion === 1 && binding.tenantId !== value.tenantId) fail();
        id(binding.tenantId); id(binding.organisationId); uuid(binding.accountId); uuid(binding.setupRequestId);
        if (binding.subjectKey !== null) subject(binding.subjectKey);
        // Account UUIDs identify one starter account. V2 must not admit a second
        // alias for that account by moving its tenant/organisation binding.
        const identity = value.schemaVersion === 1 ? JSON.stringify([binding.provider, binding.tenantId, binding.accountId]) : binding.accountId;
        if (records.has(entry.recordId) || accounts.has(identity)) fail();
        records.add(entry.recordId); accounts.add(identity);
    }
    return freeze(value);
}

function matchSignupManifest(authority, manifest) {
    if (authority.schemaVersion !== manifest.schemaVersion || COMMON_SCOPE_KEYS.some(key => authority[key] !== manifest[key]) ||
        authority.schemaVersion === 1 && authority.tenantId !== manifest.tenantId ||
        authority.schemaVersion === 2 && authority.scope.manifestSha256 !== hash(manifest)) fail();
    return manifest;
}

module.exports = Object.freeze({ FIELD_SET, COMMON_SCOPE_KEYS, normaliseSignupAuthority, normaliseSignupManifest, matchSignupManifest });
