'use strict';

const { Readable } = require('node:stream');
const { createMembershipAction } = require('../../api/shared/dashboardAdmin/accountActionsMembership');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataCodec, dataStorage } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { verifyRestore } = require('../../api/shared/dashboardAdmin/accountActionsProvenance');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { fixture: dashboardFixture, NOW, SUBJECT } = require('./dashboardFixture');
const clone = value => JSON.parse(JSON.stringify(value)), uid = n => '91000000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = { provider: 'entra-bff', isAuthenticated: true, subjectKey: uid(1) + ':' + uid(2) };
function fixture() {
    const f = dashboardFixture(), snapshot = { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState,
        entitlementState: f.entitlementState, flags: f.flags, advisorAssignments: [], usage: f.entitlementState.grants.map(dataCodec.newUsage) };
    const state = { snapshot: clone(snapshot), trace: [], rows: new Map(), receipts: new Map(), approvals: new Map(), fail: '', committed: 0 };
    const tx = { async query(sql, p) {
        if (sql.startsWith('INSERT')) { state.receipts.set(p[2], { tenant_id: p[0], organisation_id: p[1], operation_id: p[2],
            schema_version: 1, intent_sha256: p[3], result_sha256: p[4], payload: JSON.parse(p[5]) }); return { rowCount: 1 }; }
        return { rows: sql.includes('ORDER BY') ? [...state.receipts.values()].reverse().slice(0, 101) : [state.receipts.get(p[2])].filter(Boolean) };
    } };
    const selector = { provider: 'external', subjectKey: SUBJECT, ...f.scope };
    const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'authority',
        providerKind: 'external-id', providerTenantId: SUBJECT.slice(0, 36), providerConfigurationSha256: 'a'.repeat(64) };
    const record = { schemaVersion: 1, subjectKey: SUBJECT, email: 'synthetic@example.invalid', revision: 0,
        status: 'active', invitationDigest: 'b'.repeat(64), invitationId: 'synthetic-invitation', ...f.scope,
        termsVersion: 'synthetic-terms', termsDigest: 'c'.repeat(64), bindingId: null, expiresAt: Date.parse(NOW) + 86400000 };
    const authorityContainer = { url: 'https://syntheticstore.blob.core.windows.net/authority', getBlockBlobClient: () => ({ async download() {
        const bytes = Buffer.from(JSON.stringify(record));
        return { contentLength: bytes.length, etag: '"authority"', readableStreamBody: Readable.from([bytes]) };
    } }) };
    const auditContainer = { url: 'https://syntheticstore.blob.core.windows.net/audit', getBlockBlobClient: key => ({ async download() {
        if (!state.rows.has(key)) throw Object.assign(new Error(), { statusCode: 404 });
        const bytes = Buffer.from(JSON.stringify(state.rows.get(key)));
        return { contentLength: bytes.length, etag: '"audit"', readableStreamBody: Readable.from([bytes]) };
    }, async uploadData(bytes, options) {
        state.trace.push(key);
        if (state.fail && key.endsWith(state.fail)) throw new Error('PRIVATE_PROVIDER_DETAIL');
        if (options.conditions.ifNoneMatch !== '*' || state.rows.has(key)) throw Object.assign(new Error(), { statusCode: 412 });
        state.rows.set(key, JSON.parse(bytes.toString())); return { etag: '"audit"' };
    } }) };
    const identityPolicy = { policyId: 'synthetic-staff-policy', policyRevision: 1 };
    const context = { operatorSubjectKey: actor.subjectKey, sessionSha256: 'd'.repeat(64), instanceId: uid(3),
        restoreEpoch: uid(4), identityPolicySha256: hash(identityPolicy) };
    const auditPolicy = { reference: 'synthetic-audit', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } };
    const approval = { schemaVersion: 1, bindingId: uid(5), revision: 1, status: 'active', purpose: 'account_support',
        operatorSubjectKey: actor.subjectKey, instanceId: context.instanceId, restoreEpoch: context.restoreEpoch,
        selector, actions: ['restore', 'suspend'], approvedAt: NOW, validFrom: NOW,
        validUntil: new Date(Date.parse(NOW) + 3600000).toISOString(), approvalReference: 'synthetic-approval', identityPolicy, auditPolicy };
    const config = { source, authorityContainer, auditContainer, identityPolicy, auditPolicy, clock: () => NOW,
        readContext: jest.fn(async () => clone(context)), readApprovedAction: jest.fn(async ({ operationId }) => clone(state.approvals.get(operationId))),
        createRepository: (guard, allowed) => ({ verifyRestore: (selector, snapshot, read) =>
            verifyRestore(tx, selector, snapshot, { instanceId: context.instanceId, restoreEpoch: context.restoreEpoch }, read, NOW), async readAuthoritySnapshot() {
            await guard(); return { snapshot: clone(state.snapshot), revisions: dataCodec.revisionVector(state.snapshot), evaluatedAt: NOW };
        }, async executeAuthorityCommand(command) {
            await guard(); if (!allowed(command)) throw new Error('not allowed');
            if (hash(command.expectedRevisions) !== hash(dataCodec.revisionVector(state.snapshot))) throw Object.assign(new Error(), { statusCode: 409 });
            const membershipState = applyMembershipCommand(state.snapshot.membershipState, state.snapshot.tenantAggregate,
                { ...f.scope, actorSubjectKey: actor.subjectKey, now: NOW, expectedRevision: command.expectedRevisions.membership, ...command.payload });
            await guard(); state.snapshot.membershipState = membershipState; state.committed++;
            return dataStorage.saveOperationReceipt(tx, command, hash({ command, initialState: null }), state.snapshot, NOW);
        } }) };
    let sequence = 10;
    const input = () => ({ selector, operationId: uid(sequence++), confirmationEmail: record.email,
        expectedMembershipRevision: state.snapshot.membershipState.revision });
    const run = (action, value = input()) => {
        if (!action.startsWith('approve-') && !state.approvals.has(value.operationId)) {
            const recordApproval = {
            grant: { ...clone(approval), bindingId: value.operationId, actions: approval.actions.includes(action) ? [action] : approval.actions,
                validUntil: new Date(Date.parse(NOW) + 900000).toISOString() }, operationId: value.operationId, sessionSha256: context.sessionSha256,
            expectedMembershipRevision: value.expectedMembershipRevision, authoritySha256: hash(record), sourceSha256: hash(source),
            auditConfigurationSha256: hash({ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url }) };
            state.approvals.set(value.operationId, recordApproval);
            const path = `dashboard-admin-account-actions/${value.operationId}/`;
            if (!state.rows.has(path + 'approval.json')) {
                state.rows.set(path + 'approval.json', clone(recordApproval));
                state.rows.set(path + 'approval-terminal.json', { schemaVersion: 1, operationId: value.operationId, actorSubjectKey: actor.subjectKey,
                    action: 'approve-' + action, selector: clone(value.selector), targetSha256: hash(value.selector),
                    before: { status: action === 'suspend' ? 'active' : 'suspended' }, proposedAfter: { status: action === 'suspend' ? 'suspended' : 'active' },
                    approvalSha256: hash(recordApproval), context: { instanceId: context.instanceId, restoreEpoch: context.restoreEpoch },
                    phase: 'terminal', outcome: 'succeeded', after: { status: 'approved', expiresAt: recordApproval.grant.validUntil }, occurredAt: NOW });
            }
        }
        return createMembershipAction(config).execute(actor, value, { request: {}, signal: new AbortController().signal }, action);
    };
    return { config, context, approval, record, state, snapshot, selector, input, run, f };
}
module.exports = { fixture, actor, uid, clone, NOW, SUBJECT };
