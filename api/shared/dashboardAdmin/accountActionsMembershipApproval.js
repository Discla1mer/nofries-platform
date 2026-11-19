'use strict';
const { fields, copy, hash, equal, uuid, digest, revision, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { accountActionApproval } = require('./accountActionApproval');
const { readActionRecord } = require('./accountActionsStorage');
const { DashboardAdminError } = require('./service');
const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };
const keys = ['grant', 'operationId', 'sessionSha256', 'expectedMembershipRevision', 'authoritySha256', 'sourceSha256', 'auditConfigurationSha256'];
// The approval is issued by the acting staff admin to themselves: the sole
// allowlisted admin is authorised over every customer by design (owner
// decision, 19 Nov 2026, PR #474). Recorded explicitly on every approval and
// action record. Records written before this field existed omit it; when
// present it must be exactly this value. It grants nothing.
const APPROVAL_AUTHORITY = 'self_issued_sole_admin';
const authorityKeys = value => value && typeof value === 'object' && Object.hasOwn(value, 'approvalAuthority') ? ['approvalAuthority'] : [];
function checkAuthority(value) { if (authorityKeys(value).length && value.approvalAuthority !== APPROVAL_AUTHORITY) denied(); }
function validateMembershipApproval(raw, expected, context, action, policy, at) {
    const record = fields(copy(raw, 8192), [...keys, ...authorityKeys(raw)]), grant = accountActionApproval(record.grant);
    checkAuthority(record);
    uuid(record.operationId); revision(record.expectedMembershipRevision);
    for (const key of ['sessionSha256', 'authoritySha256', 'sourceSha256', 'auditConfigurationSha256']) digest(record[key]);
    if (!equal(Object.fromEntries(keys.slice(1).map(key => [key, record[key]])), expected) ||
        grant.bindingId !== expected.operationId || grant.operatorSubjectKey !== context.operatorSubjectKey ||
        grant.instanceId !== context.instanceId || grant.restoreEpoch !== context.restoreEpoch ||
        !equal(grant.actions, [action]) || !equal(grant.auditPolicy, policy) ||
        grant.approvedAt !== grant.validFrom || at < grant.validFrom || at >= grant.validUntil ||
        Date.parse(grant.validUntil) - Date.parse(grant.validFrom) > 900000) denied();
    return grant;
}
async function readMembershipApproval(container, operationId, clock) {
    const path = `dashboard-admin-account-actions/${operationId}/`, signal = AbortSignal.timeout(5000);
    // An operation nobody approved is a refusal, not a storage outage.
    const read = async name => {
        try { return (await readActionRecord(container, path + name, signal)).record; }
        catch (error) { if (error?.statusCode === 404) denied(); throw error; }
    };
    const record = await read('approval.json'), raw = await read('approval-terminal.json');
    const audit = fields(copy(raw, 8192), ['schemaVersion', 'operationId', 'actorSubjectKey', 'action', 'selector', 'targetSha256',
        'before', 'proposedAfter', 'approvalSha256', 'context', 'phase', 'outcome', 'after', 'occurredAt', ...authorityKeys(raw)]);
    checkAuthority(audit);
    const grant = accountActionApproval(record.grant); instant(audit.occurredAt);
    const from = grant.actions[0] === 'suspend' ? 'active' : 'suspended', to = grant.actions[0] === 'suspend' ? 'suspended' : 'active';
    if (audit.schemaVersion !== 1 || audit.phase !== 'terminal' || audit.operationId !== operationId || audit.outcome !== 'succeeded' ||
        audit.approvalSha256 !== hash(record) || grant.actions.length !== 1 || !['suspend', 'restore'].includes(grant.actions[0]) ||
        audit.action !== 'approve-' + grant.actions[0] || audit.actorSubjectKey !== grant.operatorSubjectKey ||
        !equal(audit.selector, grant.selector) || audit.targetSha256 !== hash(grant.selector) ||
        !equal(audit.context, { instanceId: grant.instanceId, restoreEpoch: grant.restoreEpoch }) ||
        !equal(audit.before, { status: from }) || !equal(audit.proposedAfter, { status: to }) ||
        !equal(audit.after, { status: 'approved', expiresAt: grant.validUntil }) || audit.occurredAt > instant(clock()) ||
        audit.occurredAt < grant.validFrom || audit.occurredAt >= grant.validUntil) denied();
    return record;
}
module.exports = { validateMembershipApproval, readMembershipApproval, APPROVAL_AUTHORITY, authorityKeys };
