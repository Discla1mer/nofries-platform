'use strict';

// Fixed retained-read mechanics. This port cannot edit an assessment, extend a
// commercial grant or replace an audit. Its caller owns the fenced transaction
// and has checked current authentication, original ownership and exact scope.
const crypto = require('node:crypto');
const { createDashboardAudit } = require('../appLifecycle/dashboardAudit');
const { createTenantRequestContext } = require('../appLifecycle/tenantRequestContext');
const { normaliseSessionRecord } = require('../appLifecycle/dashboardOnboardingDomain');
const { copy, fields, hash, equal, projectCurrentRow } = require('../appLifecycle/dashboardRuntimeRecords');

const AUDIT_COLUMNS = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
    'tenant_id', 'organisation_id', 'scope_json', 'occurred_at', 'event_type', 'event_sha256', 'operation_id', 'payload'];
const fail = () => { throw new Error('retained_read_audit_unavailable'); };

async function insert(tx, table, row, jsonColumns) {
    const keys = Object.keys(row), values = keys.map(key => jsonColumns.includes(key) ? JSON.stringify(row[key]) : row[key]);
    const result = await tx.query(`INSERT INTO nofries.${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})`, values);
    if (result?.rowCount !== 1) fail();
}

async function createRetainedTrialReadAudit({ capture, slot, clock }) {
    const actor = capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid;
    const scope = { tenantId: slot.tenantId, organisationId: slot.organisationId };
    const context = await createTenantRequestContext({
        authenticate: async () => ({ authenticated: true, subjectKey: actor }),
        resolveScope: async () => scope, clock, createRequestId: () => capture.requestId
    }).resolve({});
    let activeTransaction = null;
    const audit = createDashboardAudit({ clock, createEventId: crypto.randomUUID,
        async writeEvent(event) {
            const tx = activeTransaction;
            if (!tx) fail();
            const envelope = { sessionSha256: capture.sessionSha256, instanceId: capture.instanceId,
                authorityId: slot.authorityId, event };
            const expected = { event_id: event.eventId, session_sha256: capture.sessionSha256,
                instance_id: capture.instanceId, authority_id: slot.authorityId, request_id: capture.requestId,
                tenant_id: slot.tenantId, organisation_id: slot.organisationId, scope_json: scope,
                occurred_at: event.occurredAt, event_type: event.eventType, event_sha256: hash(envelope), operation_id: null, payload: event };
            const result = await tx.query(`SELECT ${AUDIT_COLUMNS.join(', ')} FROM nofries.dashboard_runtime_audit WHERE event_id=$1`, [event.eventId]);
            if (!Array.isArray(result?.rows) || result.rows.length > 1) fail();
            if (result.rows.length === 1) {
                const raw = fields(result.rows[0], AUDIT_COLUMNS);
                const row = copy({ ...raw, occurred_at: raw.occurred_at instanceof Date ? raw.occurred_at.toISOString() : raw.occurred_at }, 16384);
                if (!equal(row, expected)) fail();
                return;
            }
            await insert(tx, 'dashboard_runtime_audit', expected, ['scope_json', 'payload']);
        } });
    // Keep this exact branded event/id/time through uncertainty. A repeated
    // attempt still checks current authority; its audit is never rewritten.
    const event = audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
    const generationToken = crypto.randomBytes(32).toString('hex');
    return Object.freeze({ async persist(tx, existingGate, checkTime) {
        if (activeTransaction || checkTime() < event.occurredAt) fail();
        if (existingGate === null) {
            const at = checkTime();
            const gate = normaliseSessionRecord({ schemaVersion: 1, kind: 'customer', sessionSha256: capture.sessionSha256,
                parentSessionSha256: null, operatorIssuanceSha256: null, identitySha256: hash(capture.identityPayload),
                identityPayload: capture.identityPayload, subjectKey: actor, status: 'active', revision: 0, selectionGeneration: 0,
                generationToken, selectedBindingId: slot.bindingId, selectedTenantId: slot.tenantId,
                selectedOrganisationId: slot.organisationId, discoveryCaseId: null, discoveryProofId: null,
                issuedAt: capture.issuedAt, expiresAt: capture.expiresAt, restoreEpoch: capture.restoreEpoch,
                instanceId: capture.instanceId, createdAt: at, updatedAt: at, revokedAt: null });
            await insert(tx, 'dashboard_session_gates', projectCurrentRow('session', gate), ['identity_payload']);
        }
        activeTransaction = tx;
        try {
            const receipt = await audit.writeEvent(event);
            if (receipt.delivery !== 'acknowledged' || receipt.eventId !== event.eventId) fail();
            checkTime();
        } finally { activeTransaction = null; }
    } });
}

module.exports = { createRetainedTrialReadAudit };
