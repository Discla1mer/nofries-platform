'use strict';

// Private transaction port. The native administration repository supplies the
// already gated transaction; this module owns no pool, identity or permission.
const { copy, fields, freeze, hash, equal, uuid, digest, instant, revision, subject, id } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataStorage, dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { createPostgresDashboardRepository } = require('../appLifecycle/postgresDashboardRepository');
const { actionCommand, displayLabel } = require('./accountActionRecords');
const { DashboardAdminError, normaliseSelector } = require('./service');

const { auditResult, hydrate } = require('./accountActionState');
const TYPE = 'dashboard.admin.account_action';
const PREFIX = 'admin-account-action:';
const MAX_RECOVERY_CHAIN = 128;
const fail = (status = 503, code = 'unavailable') => { throw new DashboardAdminError(status, 'dashboard_admin_' + code); };
const scopeOf = selector => ({ tenantId: selector.tenantId, organisationId: selector.organisationId });
const reference = value => ({ operationId: value.result.command.operationId,
    commandSha256: value.intentSha256, resultVersion: value.result.receipt.version });
function receiptRef(input) {
    if (input === null) return null;
    fields(input, ['operationId', 'commandSha256', 'resultVersion']);
    uuid(input.operationId); digest(input.commandSha256); digest(input.resultVersion); return input;
}
function member(input) {
    fields(input, ['tenantId', 'organisationId', 'subjectKey', 'roles', 'validFrom', 'validUntil', 'grantEvidenceId',
        'membershipId', 'invitationId', 'status', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
    for (const key of ['tenantId', 'organisationId', 'grantEvidenceId', 'membershipId', 'invitationId']) id(input[key]);
    for (const key of ['subjectKey', 'createdBy', 'updatedBy']) subject(input[key]);
    for (const key of ['validFrom', 'validUntil', 'createdAt', 'updatedAt']) instant(input[key]);
    if (!['active', 'suspended', 'removed'].includes(input.status) || input.validFrom >= input.validUntil ||
        input.createdAt >= input.validUntil || input.updatedAt < input.createdAt || !Array.isArray(input.roles) ||
        !input.roles.length || new Set(input.roles).size !== input.roles.length ||
        input.roles.some(role => !['admin', 'editor', 'viewer', 'fractional_advisor'].includes(role))) fail();
    return input;
}
function witness(input, selector, actor) {
    const value = fields(copy(input, 16384), ['schemaVersion', 'restoreEpoch', 'authoritySha256',
        'expectedRevisions', 'membership', 'label', 'restoreReceipt']);
    if (value.schemaVersion !== 1) fail();
    uuid(value.restoreEpoch); digest(value.authoritySha256); member(value.membership);
    if (value.membership.subjectKey !== selector.subjectKey || value.membership.tenantId !== selector.tenantId ||
        value.membership.organisationId !== selector.organisationId) fail();
    // Reuse the canonical DATA revision-vector codec without manufacturing any
    // authority, command or write.
    dataCodec.normaliseCommand({ ...scopeOf(selector), operationId: 'witness-validation', actorSubjectKey: actor,
        type: 'membership.command', expectedRevisions: value.expectedRevisions, payload: {} });
    fields(value.label, ['revision', 'displayLabel', 'receipt']); revision(value.label.revision);
    if (value.label.displayLabel !== null) displayLabel(value.label.displayLabel);
    receiptRef(value.label.receipt); receiptRef(value.restoreReceipt);
    if ((value.label.revision === 0) !== (value.label.receipt === null) ||
        value.label.revision === 0 && value.label.displayLabel !== null ||
        value.label.revision > 0 && value.label.displayLabel === null) fail();
    return freeze(value);
}
function stored(row) {
    try {
        const value = fields(copy(row.payload, 65536), ['schemaVersion', 'tenantId', 'organisationId', 'operationId',
            'actorSubjectKey', 'operationType', 'intentSha256', 'resultSha256', 'occurredAt',
            'expectedRevisions', 'resultRevisions', 'result', 'event']);
        const result = fields(value.result, ['command', 'receipt', 'membership', 'labelRevision', 'restoreEpoch', 'authoritySha256']);
        const command = actionCommand(result.command), proof = witness(command.witness, command.selector, command.actorSubjectKey);
        const receipt = fields(result.receipt, ['operationId', 'commandSha256', 'status', 'version', 'occurredAt']);
        member(result.membership); revision(result.labelRevision); uuid(result.restoreEpoch); digest(result.authoritySha256);
        if (row.schema_version !== 1 || value.schemaVersion !== 1 || row.tenant_id !== value.tenantId ||
            row.organisation_id !== value.organisationId || row.operation_id !== value.operationId ||
            row.intent_sha256 !== value.intentSha256 || row.result_sha256 !== value.resultSha256 ||
            value.operationType !== TYPE || value.operationId !== PREFIX + command.operationId ||
            value.intentSha256 !== command.commandSha256 || value.resultSha256 !== hash(result) ||
            value.actorSubjectKey !== command.actorSubjectKey || !equal(scopeOf(value), scopeOf(command.selector)) ||
            !equal(value.expectedRevisions, proof.expectedRevisions) || result.restoreEpoch !== proof.restoreEpoch ||
            result.authoritySha256 !== proof.authoritySha256 || !['edit', 'delete', 'restore'].includes(command.action) ||
            receipt.operationId !== command.operationId || receipt.commandSha256 !== command.commandSha256 ||
            receipt.status !== 'succeeded' || receipt.occurredAt !== value.occurredAt ||
            result.membership.subjectKey !== command.selector.subjectKey || !equal(scopeOf(result.membership), scopeOf(command.selector))) fail();
        instant(value.occurredAt); digest(receipt.version);
        if (value.occurredAt < command.preparedAt || value.occurredAt >= command.expiresAt ||
            result.labelRevision !== proof.label.revision + (command.action === 'edit' ? 1 : 0)) fail();
        dataCodec.normaliseCommand({ ...scopeOf(value), operationId: 'receipt-validation', actorSubjectKey: value.actorSubjectKey,
            type: 'membership.command', expectedRevisions: value.resultRevisions, payload: {} });
        const expected = copy(proof.expectedRevisions);
        if (command.action !== 'edit') expected.membership++;
        if (!equal(expected, value.resultRevisions)) fail();
        const previous = proof.membership, after = result.membership;
        if (command.action === 'edit') {
            if (!equal(previous, after)) fail();
        } else {
            const from = command.action === 'delete' ? 'active' : 'suspended';
            const to = command.action === 'delete' ? 'suspended' : 'active';
            if (previous.status !== from || after.status !== to || after.updatedBy !== command.actorSubjectKey ||
                after.updatedAt !== value.occurredAt || !equal({ ...previous, status: null, updatedAt: null, updatedBy: null },
                    { ...after, status: null, updatedAt: null, updatedBy: null })) fail();
        }
        if (receipt.version !== hash({ selector: command.selector, resultRevisions: value.resultRevisions,
            membership: after, labelRevision: result.labelRevision, restoreEpoch: result.restoreEpoch, commandSha256: command.commandSha256 })) fail();
        const event = { schemaVersion: 1, category: TYPE, outcome: 'committed', action: command.action,
            actorSubjectKey: command.actorSubjectKey, targetSha256: hash(command.selector), operationId: command.operationId };
        if (!equal(event, value.event)) fail();
        return freeze(value);
    } catch (_) { fail(); }
}

function createPostgresAccountActionDataAdapter({ tx, clock, restoreEpoch, authoritySha256, actorSubjectKey, newId, stateStore, listMembers = false }) {
    if (!tx || typeof tx.query !== 'function' || typeof clock !== 'function' || typeof newId !== 'function') fail();
    uuid(restoreEpoch); digest(authoritySha256); subject(actorSubjectKey);
    const now = () => instant(clock());
    const deletion = require('./organisationDeletion').createOrganisationDeletion({ tx, clock: now, restoreEpoch, actorSubjectKey });
    function bound(command) {
        const proof = witness(command.witness, command.selector, command.actorSubjectKey);
        if (command.actorSubjectKey !== actorSubjectKey || proof.restoreEpoch !== restoreEpoch ||
            proof.authoritySha256 !== authoritySha256) fail(403, 'access_denied');
        return proof;
    }
    async function one(command) {
        const rows = await tx.query('SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
            [command.selector.tenantId, command.selector.organisationId, PREFIX + command.operationId]);
        if (!rows.rows.length) return null;
        if (rows.rows.length !== 1) fail();
        const value = stored(await hydrate(rows.rows[0], stateStore));
        if (!equal(value.result.command, command)) fail(409, 'conflict');
        return value;
    }
    async function history(selector, kind) {
        const rows = await tx.query(`SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2
            AND payload->>'operationType'=$3 AND payload#>>'{result,selector,subjectKey}'=$4
            AND payload#>>'{result,selector,provider}'=$5 AND payload#>>'{result,action}'=$6
            ORDER BY ${kind === 'delete' ? "(payload#>>'{resultRevisions,membership}')::bigint" : "(payload#>>'{result,labelRevision}')::bigint"} DESC LIMIT 2`,
        [selector.tenantId, selector.organisationId, TYPE, selector.subjectKey, selector.provider, kind]);
        const values = [];
        for (const row of rows.rows) values.push(stored(await hydrate(row, stateStore)));
        if (values.some(value => !equal(value.result.command.selector, selector)) ||
            values.length > 1 && (kind === 'delete'
                ? values[0].resultRevisions.membership <= values[1].resultRevisions.membership
                : values[0].result.labelRevision <= values[1].result.labelRevision)) fail();
        return values[0] || null;
    }
    // Prove that a retained admin mutation really has its matching native
    // membership receipt. A later member's administrative action must not
    // manufacture evidence for the selected member.
    async function nativeReceipt(value, snapshot) {
        const command = value.result.command, proof = command.witness;
        const native = dataCodec.normaliseCommand({ ...scopeOf(command.selector),
            operationId: 'admin-membership:' + command.operationId, actorSubjectKey: command.actorSubjectKey,
            type: 'membership.command', expectedRevisions: proof.expectedRevisions,
            payload: { action: command.action === 'delete' ? 'suspend' : 'resume',
                payload: { membershipId: proof.membership.membershipId } } });
        const result = await dataStorage.readOperationReceipt(tx, native, hash({ command: native, initialState: null }), snapshot);
        return result !== null && equal(result.resultRevisions, value.resultRevisions);
    }
    async function recoveryIncluded(recovery, selector, current, snapshot) {
        const start = recovery.resultRevisions.membership, end = dataCodec.revisionVector(snapshot).membership;
        if (end < start || end - start > MAX_RECOVERY_CHAIN || !await nativeReceipt(recovery, snapshot)) return false;
        if (end === start) return true;
        // Every intervening membership revision must be accounted for by a
        // validated admin+native receipt for a different member. Unknown,
        // same-member or missing changes remain ineligible for restoration.
        const rows = await tx.query(`SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2
            AND payload->>'operationType'=$3 AND payload#>>'{result,action}' IN ('delete','restore')
            AND (payload#>>'{resultRevisions,membership}')::bigint > $4
            AND (payload#>>'{resultRevisions,membership}')::bigint <= $5
            ORDER BY (payload#>>'{resultRevisions,membership}')::bigint ASC LIMIT ${MAX_RECOVERY_CHAIN + 1}`,
        [selector.tenantId, selector.organisationId, TYPE, start, end]);
        if (rows.rows.length !== end - start) return false;
        let expected = start;
        for (const row of rows.rows) {
            const next = stored(await hydrate(row, stateStore)); expected++;
            if (next.resultRevisions.membership !== expected || next.result.restoreEpoch !== restoreEpoch || next.occurredAt > now() ||
                next.result.command.selector.subjectKey === selector.subjectKey ||
                next.result.membership.membershipId === current.membershipId || !await nativeReceipt(next, snapshot)) return false;
        }
        return expected === end;
    }
    async function inspectLoaded(selector, snapshot) {
        const members = snapshot.membershipState.memberships.filter(row => row.subjectKey === selector.subjectKey && row.status !== 'removed');
        if (members.length !== 1) fail(403, 'access_denied');
        const current = members[0], at = now(), revisions = dataCodec.revisionVector(snapshot);
        if (snapshot.membershipState.updatedAt > at || current.updatedAt > at) fail();
        const lastLabel = await history(selector, 'edit');
        if (lastLabel) {
            dataCodec.assertReceiptIncluded(snapshot, { resultRevisions: lastLabel.resultRevisions, reserved: false });
            if (lastLabel.occurredAt > at) fail();
        }
        const label = lastLabel ? { revision: lastLabel.result.labelRevision,
            displayLabel: lastLabel.result.command.patch.displayLabel, receipt: reference(lastLabel) } :
            { revision: 0, displayLabel: null, receipt: null };
        let recovery = current.status === 'suspended' ? await history(selector, 'delete') : null;
        if (recovery) {
            dataCodec.assertReceiptIncluded(snapshot, { resultRevisions: recovery.resultRevisions, reserved: false });
            if (recovery.occurredAt > at) fail();
        }
        if (recovery && (!equal(recovery.result.membership, current) || recovery.result.restoreEpoch !== restoreEpoch ||
            !await recoveryIncluded(recovery, selector, current, snapshot))) recovery = null;
        const privateProof = { schemaVersion: 1, restoreEpoch, authoritySha256, expectedRevisions: revisions,
            membership: current, label, restoreReceipt: recovery ? reference(recovery) : null };
        const displayName = snapshot.tenantAggregate.organisations[0].displayName;
        const version = hash({ selector, displayName, displayLabel: label.displayLabel, witness: privateProof });
        const actions = ['edit', ...await deletion.available(selector, snapshot)];
        if (selector.subjectKey !== actorSubjectKey && current.validFrom <= at && at < current.validUntil) {
            if (current.status === 'active') actions.push('delete');
            else if (recovery && snapshot.tenantAggregate.tenant.recordStatus === 'active' &&
                snapshot.tenantAggregate.organisations[0].recordStatus === 'active') actions.push('restore');
        }
        return freeze({ selector, version, displayName, displayLabel: label.displayLabel,
            membership: Object.fromEntries(['membershipId', 'status', 'validFrom', 'validUntil'].map(key => [key, current[key]])),
            actions, witness: privateProof,
            ...(listMembers ? { members: snapshot.membershipState.memberships.map(row => ({
                membershipId: row.membershipId, subjectKey: row.subjectKey, status: row.status, roles: row.roles,
                validFrom: row.validFrom, validUntil: row.validUntil,
                effectiveStatus: row.status !== 'active' ? row.status : at < row.validFrom ? 'not_started' : at >= row.validUntil ? 'expired' : 'active'
            })), invitations: snapshot.membershipState.invitations.map(row => ({
                invitationId: row.invitationId, subjectKey: row.subjectKey, status: row.status, roles: row.roles,
                validFrom: row.validFrom, validUntil: row.validUntil, expiresAt: row.expiresAt
            })) } : {}) });
    }
    async function inspect(input) {
        const selector = normaliseSelector(input), snapshot = await dataStorage.loadSnapshotForShare(tx, selector);
        const observed = await inspectLoaded(selector, snapshot), operationId = 'admin-account-inspection:' + uuid(newId());
        const occurredAt = now(), targetSha256 = hash(selector);
        const result = { schemaVersion: 1, observedVersion: observed.version, targetSha256, authoritySha256, restoreEpoch };
        const intentSha256 = hash({ actorSubjectKey, operationId, ...result });
        const event = { schemaVersion: 1, category: 'dashboard.admin.account_inspection', outcome: 'observed',
            actorSubjectKey, targetSha256, operationId };
        const payload = { schemaVersion: 1, ...scopeOf(selector), operationId, actorSubjectKey,
            operationType: 'dashboard.admin.account_inspection', intentSha256, resultSha256: hash(result), occurredAt,
            expectedRevisions: observed.witness.expectedRevisions, resultRevisions: observed.witness.expectedRevisions, result, event };
        // The independent action grant includes its retention/audit policy. A
        // successful transactional audit is required before disclosing PII;
        // failures return no account details and never pretend an audit exists.
        const saved = await tx.query('INSERT INTO nofries.dashboard_operation_receipts (tenant_id,organisation_id,operation_id,schema_version,intent_sha256,result_sha256,payload) VALUES ($1,$2,$3,1,$4,$5,$6::jsonb)',
            [selector.tenantId, selector.organisationId, operationId, intentSha256, payload.resultSha256, JSON.stringify(payload)]);
        if (saved.rowCount !== 1) fail();
        return observed;
    }
    async function outcome(input) {
        const command = actionCommand(input); bound(command);
        if (['archive', 'unarchive'].includes(command.action)) return deletion.outcome(command);
        // SHARE is the same tenant-row fence held UPDATE by commit. Acquire it
        // before even an absent-receipt result, so reconciliation waits for an
        // already dispatched mutation and reads one coherent canonical state.
        // This ordinary transaction performs no DML or effect retry.
        const snapshot = await dataStorage.loadSnapshotForShare(tx, command.selector);
        const value = await one(command);
        if (value === null) return null;
        // SELECT-only reconciliation verifies the retained effect is included by
        // current canonical state, including after database restoration.
        dataCodec.assertReceiptIncluded(snapshot, { resultRevisions: value.resultRevisions, reserved: false });
        const current = snapshot.membershipState.memberships.find(row => row.membershipId === value.result.membership.membershipId);
        if (!current || current.subjectKey !== command.selector.subjectKey ||
            snapshot.membershipState.revision === value.resultRevisions.membership && !equal(current, value.result.membership)) fail();
        const immutable = row => ({ ...row, status: null, updatedAt: null, updatedBy: null });
        if (!equal(immutable(current), immutable(value.result.membership)) || current.updatedAt < value.result.membership.updatedAt) fail();
        if (value.occurredAt > now()) fail();
        return value.result.receipt;
    }
    async function commit(input) {
        const command = actionCommand(input), proof = bound(command), selector = command.selector;
        if (!['edit', 'delete', 'restore', 'archive', 'unarchive'].includes(command.action)) fail(409, 'conflict');
        const snapshot = await dataStorage.loadSnapshotForUpdate(tx, selector);
        if (['archive', 'unarchive'].includes(command.action)) {
            const original = await deletion.outcome(command);
            if (original !== null) return original;
        }
        const original = await one(command);
        if (original !== null) return outcome(command);
        const before = await inspectLoaded(selector, snapshot), at = now();
        if (at < command.preparedAt || at >= command.expiresAt || before.version !== command.expectedVersion ||
            !equal(before.witness, proof) || !before.actions.includes(command.action)) fail(409, 'conflict');
        if (['archive', 'unarchive'].includes(command.action)) return deletion.commit(command, snapshot);
        let resultRevisions = proof.expectedRevisions, after = proof.membership;
        if (command.action === 'edit') {
            if (command.patch.displayLabel === before.displayLabel || !Number.isSafeInteger(proof.label.revision + 1)) fail(409, 'conflict');
        } else {
            const nativeCommand = { ...scopeOf(selector), operationId: 'admin-membership:' + command.operationId,
                actorSubjectKey, type: 'membership.command', expectedRevisions: proof.expectedRevisions,
                payload: { action: command.action === 'delete' ? 'suspend' : 'resume', payload: { membershipId: proof.membership.membershipId } } };
            const database = { async withTenantTransaction(tenantId, work) {
                if (tenantId !== selector.tenantId) fail(403, 'access_denied'); return work(tx);
            } };
            const repository = createPostgresDashboardRepository({ database, clock: () => at,
                authoriseAdministration: actual => equal(actual, nativeCommand) });
            const result = await repository.executeAuthorityCommand(nativeCommand); resultRevisions = result.resultRevisions;
            const updated = await dataStorage.loadSnapshotForShare(tx, selector);
            after = updated.membershipState.memberships.find(row => row.membershipId === proof.membership.membershipId);
        }
        const labelRevision = proof.label.revision + (command.action === 'edit' ? 1 : 0);
        const receipt = { operationId: command.operationId, commandSha256: command.commandSha256,
            status: 'succeeded', version: hash({ selector, resultRevisions, membership: after,
                labelRevision, restoreEpoch, commandSha256: command.commandSha256 }), occurredAt: at };
        const state = { command, receipt, membership: after, labelRevision, restoreEpoch, authoritySha256 };
        const result = auditResult(state);
        // Retain customer state before committing SQL. An orphan immutable blob
        // grants no authority; missing/corrupt state prevents reconciliation.
        if (await stateStore.writeState(state) !== result.stateSha256) fail();
        now();
        const event = { schemaVersion: 1, category: TYPE, outcome: 'committed', action: command.action,
            actorSubjectKey, targetSha256: hash(selector), operationId: command.operationId };
        const payload = { schemaVersion: 1, ...scopeOf(selector), operationId: PREFIX + command.operationId,
            actorSubjectKey, operationType: TYPE, intentSha256: command.commandSha256, resultSha256: hash(result),
            occurredAt: at, expectedRevisions: proof.expectedRevisions, resultRevisions, result, event };
        const saved = await tx.query('INSERT INTO nofries.dashboard_operation_receipts (tenant_id,organisation_id,operation_id,schema_version,intent_sha256,result_sha256,payload) VALUES ($1,$2,$3,1,$4,$5,$6::jsonb)',
            [selector.tenantId, selector.organisationId, payload.operationId, payload.intentSha256, payload.resultSha256, JSON.stringify(payload)]);
        if (saved.rowCount !== 1) fail();
        return freeze(receipt);
    }
    return Object.freeze({ inspect, commit, outcome });
}

module.exports = { createPostgresAccountActionDataAdapter };
