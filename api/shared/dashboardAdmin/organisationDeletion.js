'use strict';

// Recoverable organisation deletion uses the existing suspended lifecycle state.
// No rows, identities, memberships or assessment data are erased. Receipts carry
// IDs, revisions and state only; the typed name never reaches the audit record.
const { dataStorage, dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { createPostgresDashboardRepository } = require('../appLifecycle/postgresDashboardRepository');
const { hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const TYPE = 'dashboard.admin.organisation_deletion';
const PREFIX = 'admin-org-action:';
const fail = () => { throw new DashboardAdminError(409, 'dashboard_admin_conflict'); };
function createOrganisationDeletion({ tx, clock, restoreEpoch, actorSubjectKey }) {
    async function retained(command, snapshot) {
        const rows = await tx.query('SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
            [command.selector.tenantId, command.selector.organisationId, PREFIX + command.operationId]);
        if (!rows.rows.length) return null;
        if (rows.rows.length !== 1) fail();
        const row = rows.rows[0], p = row.payload;
        if (p.operationType !== TYPE || p.intentSha256 !== command.commandSha256 || p.resultSha256 !== hash(p.result) ||
            row.intent_sha256 !== p.intentSha256 || row.result_sha256 !== p.resultSha256 ||
            p.actorSubjectKey !== command.actorSubjectKey || p.result.restoreEpoch !== restoreEpoch ||
            p.tenantId !== command.selector.tenantId || p.organisationId !== command.selector.organisationId ||
            p.operationId !== PREFIX + command.operationId || p.result.action !== command.action ||
            p.occurredAt < command.preparedAt || p.occurredAt >= command.expiresAt) fail();
        dataCodec.assertReceiptIncluded(snapshot, { resultRevisions: p.resultRevisions, reserved: false });
        return { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded',
            version: p.resultSha256, occurredAt: p.occurredAt };
    }
    async function canRecover(selector, snapshot) {
        const rows = await tx.query(`SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2
            AND payload->>'operationType'=$3 AND payload#>>'{result,action}'='archive'
            AND payload#>>'{resultRevisions,organisation}'=$4 LIMIT 2`,
        [selector.tenantId, selector.organisationId, TYPE, String(snapshot.tenantAggregate.organisations[0].revision)]);
        if (rows.rows.length !== 1) return false;
        const row = rows.rows[0], p = row.payload;
        if (p.resultSha256 !== hash(p.result) || row.result_sha256 !== p.resultSha256 ||
            p.result.restoreEpoch !== restoreEpoch || p.result.afterStatus !== 'suspended' ||
            p.tenantId !== selector.tenantId || p.organisationId !== selector.organisationId) return false;
        dataCodec.assertReceiptIncluded(snapshot, { resultRevisions: p.resultRevisions, reserved: false });
        return true;
    }
    async function available(selector, snapshot) {
        const org = snapshot.tenantAggregate.organisations[0];
        // Never remove the acting administrator's own organisation access.
        if (snapshot.membershipState.memberships.some(m => m.subjectKey === actorSubjectKey && m.status === 'active') ||
            snapshot.tenantAggregate.tenant.recordStatus !== 'active') return [];
        if (org.recordStatus === 'active') return ['archive'];
        return org.recordStatus === 'suspended' && await canRecover(selector, snapshot) ? ['unarchive'] : [];
    }
    async function outcome(command) {
        return retained(command, await dataStorage.loadSnapshotForShare(tx, command.selector));
    }
    async function commit(command, snapshot) {
        const previous = await retained(command, snapshot);
        if (previous) return previous;
        if (!(await available(command.selector, snapshot)).includes(command.action)) fail();
        const at = clock(), afterStatus = command.action === 'archive' ? 'suspended' : 'active';
        if (at < command.preparedAt || at >= command.expiresAt) fail();
        const native = { tenantId: command.selector.tenantId, organisationId: command.selector.organisationId,
            operationId: PREFIX + command.operationId + ':transition', actorSubjectKey, type: 'organisation.transition',
            expectedRevisions: command.witness.expectedRevisions, payload: { toStatus: afterStatus } };
        const repository = createPostgresDashboardRepository({ database: { async withTenantTransaction(tenantId, work) {
            if (tenantId !== command.selector.tenantId) fail(); return work(tx);
        } }, clock: () => at, authoriseAdministration: actual => equal(actual, native) });
        const applied = await repository.executeAuthorityCommand(native);
        const result = { action: command.action, restoreEpoch, afterStatus, actorSubjectKey, targetSha256: hash(command.selector) };
        const payload = { schemaVersion: 1, tenantId: command.selector.tenantId, organisationId: command.selector.organisationId,
            operationId: PREFIX + command.operationId, actorSubjectKey, operationType: TYPE, intentSha256: command.commandSha256,
            resultSha256: hash(result), occurredAt: at, expectedRevisions: command.witness.expectedRevisions,
            resultRevisions: applied.resultRevisions, result, event: { schemaVersion: 1, category: TYPE, outcome: 'committed',
                action: command.action, actorSubjectKey, targetSha256: hash(command.selector), operationId: command.operationId } };
        const saved = await tx.query('INSERT INTO nofries.dashboard_operation_receipts (tenant_id,organisation_id,operation_id,schema_version,intent_sha256,result_sha256,payload) VALUES ($1,$2,$3,1,$4,$5,$6::jsonb)',
            [payload.tenantId, payload.organisationId, payload.operationId, payload.intentSha256, payload.resultSha256, JSON.stringify(payload)]);
        if (saved.rowCount !== 1) fail();
        return { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded',
            version: payload.resultSha256, occurredAt: at };
    }
    return { available, commit, outcome };
}
module.exports = { createOrganisationDeletion };
