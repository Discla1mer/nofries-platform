'use strict';
const { fields, copy, equal, hash, uuid, instant, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataStorage, dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { normaliseSelector, DashboardAdminError } = require('./service');
const fail = () => { throw new DashboardAdminError(409, 'dashboard_admin_conflict'); };

// Every intervening membership revision must have both a successful staff
// audit and its matching native receipt. Unknown or same-member changes stop
// recovery; a different member's verified action does not invalidate it.
async function verifyRestore(tx, selector, snapshot, context, readTerminal, now) {
    let expected = snapshot.membershipState.revision;
    const rows = await tx.query(`SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2
        AND payload->>'operationType'='membership.command' AND (payload#>>'{resultRevisions,membership}')::bigint <= $3
        ORDER BY (payload#>>'{resultRevisions,membership}')::bigint DESC LIMIT 101`, [selector.tenantId, selector.organisationId, expected]);
    for (const row of rows.rows) {
        uuid(row.operation_id);
        const audit = fields(copy(await readTerminal(row.operation_id), 32768), ['schemaVersion', 'operationId', 'actorSubjectKey',
            'action', 'selector', 'targetSha256', 'before', 'proposedAfter', 'approvalSha256', 'commandSha256',
            'context', 'nativeCommand', 'resultSha256', 'phase', 'outcome', 'after', 'occurredAt']);
        const target = normaliseSelector(audit.selector), command = dataCodec.normaliseCommand(audit.nativeCommand);
        const from = audit.action === 'suspend' ? 'active' : 'suspended', to = audit.action === 'suspend' ? 'suspended' : 'active';
        digest(audit.approvalSha256); digest(audit.commandSha256); digest(audit.resultSha256); instant(audit.occurredAt);
        if (audit.schemaVersion !== 1 || audit.phase !== 'terminal' || audit.outcome !== 'succeeded' ||
            !['suspend', 'restore'].includes(audit.action) || audit.operationId !== row.operation_id ||
            audit.actorSubjectKey !== command.actorSubjectKey || audit.operationId !== command.operationId ||
            target.tenantId !== selector.tenantId || target.organisationId !== selector.organisationId ||
            command.tenantId !== target.tenantId || command.organisationId !== target.organisationId ||
            audit.targetSha256 !== hash(target) || !equal(audit.context, context) || audit.occurredAt > now ||
            !equal(audit.before, { status: from }) || !equal(audit.proposedAfter, { status: to }) || !equal(audit.after, { status: to }) ||
            command.type !== 'membership.command' || command.payload.action !== (audit.action === 'suspend' ? 'suspend' : 'resume')) fail();
        const member = snapshot.membershipState.memberships.find(value => value.membershipId === command.payload.payload.membershipId);
        if (!member || member.subjectKey !== target.subjectKey) fail();
        const result = await dataStorage.readOperationReceipt(tx, command, hash({ command, initialState: null }), snapshot);
        if (!result || hash(result) !== audit.resultSha256 || result.resultRevisions.membership !== expected--) fail();
        if (target.subjectKey === selector.subjectKey) {
            if (!equal(target, selector) || audit.action !== 'suspend' || member.status !== 'suspended') fail();
            return true;
        }
    }
    fail();
}
module.exports = { verifyRestore };
