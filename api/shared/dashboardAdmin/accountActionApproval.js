'use strict';

// An independent private action approval. Existing lookup/listing approvals
// cannot satisfy this codec. Reading this record never creates a grant.
const { fields, copy, freeze, subject, uuid, revision, instant, id, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { ACTIONS } = require('./accountActionRecords');
const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };

function accountActionApproval(input) {
    try {
        const value = fields(copy(input, 8192), ['schemaVersion', 'bindingId', 'revision', 'status', 'purpose',
            'operatorSubjectKey', 'instanceId', 'restoreEpoch', 'selector', 'actions', 'approvedAt', 'validFrom',
            'validUntil', 'approvalReference', 'identityPolicy', 'auditPolicy']);
        if (value.schemaVersion !== 1 || value.status !== 'active' || value.purpose !== 'account_support') denied();
        uuid(value.bindingId); revision(value.revision); subject(value.operatorSubjectKey); uuid(value.instanceId); uuid(value.restoreEpoch);
        value.selector = normaliseSelector(value.selector);
        if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > ACTIONS.length + 1 ||
            value.actions.some(action => ![...ACTIONS, 'list_members'].includes(action)) || !equal(value.actions, [...new Set(value.actions)].sort())) denied();
        instant(value.approvedAt); instant(value.validFrom); instant(value.validUntil); id(value.approvalReference);
        if (value.approvedAt > value.validFrom || value.validFrom >= value.validUntil ||
            Date.parse(value.validUntil) - Date.parse(value.validFrom) > 3600000) denied();
        fields(value.identityPolicy, ['policyId', 'policyRevision']);
        id(value.identityPolicy.policyId); revision(value.identityPolicy.policyRevision);
        fields(value.auditPolicy, ['reference', 'revision', 'agreementVersion', 'retention']);
        id(value.auditPolicy.reference); revision(value.auditPolicy.revision);
        fields(value.auditPolicy.retention, ['unit', 'count']);
        // This verifies an existing private policy decision; it accepts no
        // agreement and creates no retention/deletion authority.
        if (value.auditPolicy.agreementVersion !== 'nf-dashboard-2026-09-r2' ||
            value.auditPolicy.retention.unit !== 'calendar_months' || value.auditPolicy.retention.count !== 13) denied();
        return freeze(value);
    } catch (_) { denied(); }
}
module.exports = { accountActionApproval };
