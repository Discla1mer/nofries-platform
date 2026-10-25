'use strict';

// Private record codecs only. No policy, population or access is created here.
const { copy, fields, freeze, equal, hash, uuid, id, revision, instant, subject, digest } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { FIELD_SET, normaliseSignupAuthority, normaliseSignupManifest } = require('./signupAuthority');
const TARGET = ['instanceId', 'operatorSubjectKey', 'provider', 'populationId', 'indexId', 'sourceBindingSha256'];
const fail = () => { throw new Error('dashboard_admin_signup_listing_record_invalid'); };

function listingTarget(input) {
    const value = fields(copy(input, 2048), TARGET);
    uuid(value.instanceId); subject(value.operatorSubjectKey);
    if (!['legacy', 'external'].includes(value.provider)) fail();
    id(value.populationId); id(value.indexId); digest(value.sourceBindingSha256);
    return freeze(value);
}
const targetOf = value => Object.fromEntries(TARGET.map(key => [key, value[key]]));
const targetHash = target => hash({ recordType: 'dashboard_admin_signup_policy', ...listingTarget(target) });
const listingHeadKey = target => `dashboard-admin-signup-policy-heads/${targetHash(target)}.json`;
function listingRevisionKey(target, sha256) {
    digest(sha256);
    return `dashboard-admin-signup-policy-revisions/${targetHash(target)}/${sha256}.json`;
}
function listingPolicy(input) {
    const value = fields(copy(input, 4096), ['coverage', 'approvedAt', 'validFrom', 'validUntil',
        'decisionWindowMs', 'pageSize', 'fields', 'auditPolicy']);
    if (value.coverage !== 'complete_application_signups' || !equal(value.fields, FIELD_SET)) fail();
    instant(value.approvedAt); instant(value.validFrom);
    if (value.approvedAt > value.validFrom || value.validUntil !== null &&
        (instant(value.validUntil), value.validUntil <= value.validFrom)) fail();
    if (!Number.isSafeInteger(value.decisionWindowMs) || value.decisionWindowMs < 1000 || value.decisionWindowMs > 3600000 ||
        !Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 25) fail();
    const audit = fields(value.auditPolicy, ['reference', 'revision', 'agreementVersion', 'retention']);
    id(audit.reference); revision(audit.revision);
    fields(audit.retention, ['unit', 'count']);
    if (audit.agreementVersion !== 'nf-dashboard-2026-09-r2' ||
        audit.retention.unit !== 'calendar_months' || audit.retention.count !== 13) fail();
    return freeze(value);
}
function listingHead(input, target) {
    const value = fields(copy(input, 4096), ['schemaVersion', 'recordType', ...TARGET,
        'restoreEpoch', 'revision', 'status', 'recordSha256']);
    if (value.schemaVersion !== 1 || value.recordType !== 'dashboard_admin_signup_policy_head' ||
        !equal(listingTarget(targetOf(value)), listingTarget(target)) || !['active', 'revoked'].includes(value.status)) fail();
    uuid(value.restoreEpoch); revision(value.revision); digest(value.recordSha256);
    return freeze(value);
}
function listingRevision(input, head) {
    const value = fields(copy(input, 8192), ['schemaVersion', 'recordType', ...TARGET,
        'restoreEpoch', 'revision', 'status', 'changedAt', 'decisionReference', 'policy']);
    if (value.schemaVersion !== 1 || value.recordType !== 'dashboard_admin_signup_policy_revision' ||
        !equal(listingTarget(targetOf(value)), targetOf(head)) || hash(value) !== head.recordSha256 ||
        !['restoreEpoch', 'revision', 'status'].every(key => value[key] === head[key])) fail();
    uuid(value.restoreEpoch); revision(value.revision); instant(value.changedAt); id(value.decisionReference);
    if (value.status === 'active') {
        value.policy = listingPolicy(value.policy);
        if (value.policy.approvedAt !== value.changedAt) fail();
    } else if (value.status !== 'revoked' || value.policy !== null) fail();
    return freeze(value);
}

function completeListingIndex(input, target, restoreEpoch) {
    const value = fields(copy(input, 393216), ['manifest', 'sourceReferences', 'revision', 'restoreEpoch', 'complete', 'sourceBindingSha256']);
    revision(value.revision); uuid(value.restoreEpoch);
    digest(value.sourceBindingSha256);
    if (value.complete !== true || value.restoreEpoch !== restoreEpoch || value.sourceBindingSha256 !== target.sourceBindingSha256) fail();
    value.manifest = normaliseSignupManifest(value.manifest);
    const manifest = value.manifest;
    if (manifest.schemaVersion !== 2 || ['provider', 'populationId', 'indexId'].some(key => manifest[key] !== target[key]) ||
        !Array.isArray(value.sourceReferences) || value.sourceReferences.length !== manifest.entries.length) fail();
    const references = new Map(), accountKeys = new Set();
    for (const reference of value.sourceReferences) {
        fields(reference, ['entry', 'accountKey']);
        if (!reference.entry || references.has(reference.entry.recordId) ||
            typeof reference.accountKey !== 'string' || !/^starter-accounts\/[a-f0-9]{64}$/.test(reference.accountKey) ||
            accountKeys.has(reference.accountKey)) fail();
        references.set(reference.entry.recordId, reference.entry); accountKeys.add(reference.accountKey);
    }
    if (manifest.entries.some(entry => !equal(entry, references.get(entry.recordId)))) fail();
    return freeze(value);
}

function decisionRevision(policyRevision, indexRevision) {
    revision(policyRevision); revision(indexRevision);
    // Injectively encode both revisions; overflow refuses instead of truncating
    // a hash or allowing distinct generations to share a revision.
    const a = BigInt(policyRevision), b = BigInt(indexRevision), sum = a + b;
    const paired = sum * (sum + 1n) / 2n + b;
    if (paired > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(paired);
}
function listingDecision(record, index, at) {
    instant(at);
    if (record.status !== 'active') return null;
    const policy = listingPolicy(record.policy);
    if (at < policy.validFrom || policy.validUntil !== null && at >= policy.validUntil) return null;
    const start = Date.parse(policy.validFrom), now = Date.parse(at);
    const issued = start + Math.floor((now - start) / policy.decisionWindowMs) * policy.decisionWindowMs;
    const expires = Math.min(issued + policy.decisionWindowMs,
        policy.validUntil === null ? Infinity : Date.parse(policy.validUntil));
    const rows = index.manifest.entries.length, pages = Math.max(1, Math.ceil(rows / policy.pageSize));
    // An authorised complete population is never silently cut to a traversal
    // limit. A larger population requires a compatible bounded index contract.
    if (rows > 100 || pages > 10) fail();
    return normaliseSignupAuthority({ schemaVersion: 2, capability: 'signupList',
        operatorSubjectKey: record.operatorSubjectKey, provider: record.provider,
        populationId: record.populationId, indexId: record.indexId,
        scope: { kind: 'finite_manifest', manifestSha256: hash(index.manifest) },
        authorityRevision: decisionRevision(record.revision, index.revision),
        issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString(),
        maxPageSize: Math.min(policy.pageSize, Math.max(1, rows)), maxRows: Math.max(1, rows), maxPages: pages,
        fields: FIELD_SET, auditPolicyId: policy.auditPolicy.reference }, { actorSubjectKey: record.operatorSubjectKey, now: at });
}

module.exports = Object.freeze({ listingTarget, listingPolicy, listingHead, listingRevision,
    listingHeadKey, listingRevisionKey, completeListingIndex, decisionRevision, listingDecision });
