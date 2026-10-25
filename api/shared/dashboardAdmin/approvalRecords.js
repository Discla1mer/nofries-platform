'use strict';

// Closed private approval codecs. These validate records; they grant no access.
const { copy, fields, freeze, equal, hash, uuid, id, revision, instant, subject, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError, normaliseSelector } = require('./service');
const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };

function approvedBinding(input) {
    const value = fields(copy(input, 8192), ['schemaVersion', 'bindingId', 'revision', 'status', 'action', 'purpose',
        'operatorSubjectKey', 'instanceId', 'selector', 'approvedAt', 'validFrom', 'validUntil', 'approvalReference',
        'identityPolicy', 'auditPolicy']);
    if (value.schemaVersion !== 1 || value.status !== 'active' || value.action !== 'dashboard.authority.read' ||
        value.purpose !== 'signup_support') denied();
    uuid(value.bindingId); revision(value.revision); subject(value.operatorSubjectKey); uuid(value.instanceId);
    value.selector = normaliseSelector(value.selector);
    instant(value.approvedAt); instant(value.validFrom); instant(value.validUntil); id(value.approvalReference);
    if (value.approvedAt > value.validFrom || value.validFrom >= value.validUntil ||
        Date.parse(value.validUntil) - Date.parse(value.validFrom) > 3600000) denied();
    fields(value.identityPolicy, ['policyId', 'policyRevision']); id(value.identityPolicy.policyId); revision(value.identityPolicy.policyRevision);
    fields(value.auditPolicy, ['reference', 'revision', 'agreementVersion', 'retention']);
    id(value.auditPolicy.reference); revision(value.auditPolicy.revision);
    if (value.auditPolicy.agreementVersion !== 'nf-dashboard-2026-09-r2') denied();
    fields(value.auditPolicy.retention, ['unit', 'count']);
    // Clause 10 specifies thirteen calendar months from each security/audit
    // event. A fixed day count changes that promise across calendar boundaries.
    // This validates a private approval; it does not implement deletion or
    // establish that the proposed lookup is covered by the operating policy.
    if (value.auditPolicy.retention.unit !== 'calendar_months' || value.auditPolicy.retention.count !== 13) denied();
    return freeze(value);
}

const PURPOSE = 'signup_support';
const TARGET_FIELDS = ['operatorSubjectKey', 'purpose', 'instanceId'];
function approvalTarget(input) {
    const value = fields(copy(input, 1024), TARGET_FIELDS);
    subject(value.operatorSubjectKey); uuid(value.instanceId);
    if (value.purpose !== PURPOSE) denied();
    return freeze(value);
}
const targetOf = value => Object.fromEntries(TARGET_FIELDS.map(key => [key, value[key]]));
const targetHash = target => hash({ recordType: 'dashboard_admin_approval', ...approvalTarget(target) });
const headKey = target => `dashboard-admin-approval-heads/${targetHash(target)}.json`;
const revisionKey = (target, sha256) => {
    digest(sha256);
    return `dashboard-admin-approval-revisions/${targetHash(target)}/${sha256}.json`;
};
function approvalHead(input, target) {
    const value = fields(copy(input, 2048), ['schemaVersion', 'recordType', ...TARGET_FIELDS,
        'restoreEpoch', 'revision', 'status', 'recordSha256']);
    if (value.schemaVersion !== 1 || value.recordType !== 'dashboard_admin_approval_head' ||
        !equal(approvalTarget(targetOf(value)), approvalTarget(target)) || !['active', 'revoked'].includes(value.status)) denied();
    uuid(value.restoreEpoch); revision(value.revision); digest(value.recordSha256);
    return freeze(value);
}
function approvalRevision(input, head) {
    const value = fields(copy(input, 16384), ['schemaVersion', 'recordType', ...TARGET_FIELDS,
        'restoreEpoch', 'revision', 'status', 'changedAt', 'decisionReference', 'binding']);
    if (value.schemaVersion !== 1 || value.recordType !== 'dashboard_admin_approval_revision' ||
        !equal(approvalTarget(targetOf(value)), targetOf(head)) ||
        !['restoreEpoch', 'revision', 'status'].every(key => value[key] === head[key]) || hash(value) !== head.recordSha256) denied();
    uuid(value.restoreEpoch); revision(value.revision); instant(value.changedAt); id(value.decisionReference);
    if (value.status === 'active') {
        const binding = approvedBinding(value.binding);
        if (!equal(targetOf(binding), targetOf(value)) || binding.revision !== value.revision ||
            binding.approvedAt !== value.changedAt || binding.approvalReference !== value.decisionReference) denied();
        value.binding = binding;
    } else if (value.status !== 'revoked' || value.binding !== null) denied();
    return freeze(value);
}

module.exports = Object.freeze({ approvedBinding, approvalTarget, approvalHead, approvalRevision, headKey, revisionKey });
