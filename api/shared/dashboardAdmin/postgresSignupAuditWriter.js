'use strict';

// Transaction-only mechanics. The native owner supplies an already fenced,
// deadline-bound transaction and owns COMMIT, final authority and acknowledgement.
const { normaliseSignupAuditEnvelope, projectSignupAuditRow, verifySignupAuditRow,
    verifySignupAuditPhasePair } = require('./signupAuditEnvelope');
const { isProxy } = require('node:util').types;

const COLUMNS = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
    'tenant_id', 'organisation_id', 'scope_json', 'occurred_at', 'event_type', 'event_sha256', 'operation_id', 'payload'];
const PHASE_LOCK_FAMILY = 71005;
class DashboardAdminSignupAuditWriterError extends Error {
    constructor() { super('dashboard_admin_signup_audit_unavailable'); this.code = this.message; this.statusCode = 503; }
}
const unavailable = () => { throw new DashboardAdminSignupAuditWriterError(); };
function inputs(tx, input, originalAttempt) {
    if (!tx || isProxy(tx) || typeof tx.query !== 'function' || isProxy(tx.query)) unavailable();
    const envelope = normaliseSignupAuditEnvelope(input);
    let attempt = null;
    if (envelope.event.serviceEvent.phase === 'outcome') attempt = verifySignupAuditPhasePair(originalAttempt, envelope).attempt;
    else if (originalAttempt !== null) unavailable();
    return { envelope, attempt };
}
function slot(value) {
    return [value.instanceId, value.sessionSha256, value.event.requestId,
        value.event.serviceEvent.requestId, value.event.serviceEvent.phase];
}
async function read(tx, envelope) {
    const result = await tx.query(`SELECT ${COLUMNS.join(', ')} FROM nofries.dashboard_runtime_audit
        WHERE event_type='dashboard.admin.signup_list' AND instance_id=$1 AND session_sha256=$2
          AND request_id=$3 AND payload->'serviceEvent'->>'requestId'=$4 AND payload->'serviceEvent'->>'phase'=$5`, slot(envelope));
    if (!result || isProxy(result)) unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(result, 'rows'), rows = descriptor?.value;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || isProxy(rows) || !Array.isArray(rows) || rows.length > 1 ||
        Reflect.ownKeys(rows).length !== rows.length + 1) unavailable();
    if (!rows.length) return null;
    const first = Object.getOwnPropertyDescriptor(rows, '0');
    if (!first || !Object.hasOwn(first, 'value')) unavailable();
    return verifySignupAuditRow(first.value, envelope);
}
async function phase(tx, input, originalAttempt, reconcile) {
    try {
        // Detach data before waiting for the transaction lock. Reuse the native
        // phase-lock family after session71001 and instance71002; a type prefix
        // separates this identity from lookup while preserving lock order.
        const { envelope, attempt } = inputs(tx, input, originalAttempt);
        const expected = projectSignupAuditRow(envelope);
        await tx.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))',
            [PHASE_LOCK_FAMILY, JSON.stringify(['dashboard.admin.signup_list', ...slot(envelope).slice(0, 4)])]);
        if (attempt && !await read(tx, attempt)) unavailable();
        if (await read(tx, envelope)) return;
        if (reconcile) unavailable();
        // scope_json is NOT NULL in the existing table: unscoped events carry
        // JSONB null, while tenant_id and organisation_id carry SQL NULL.
        const values = COLUMNS.map(key => ['scope_json', 'payload'].includes(key)
            ? JSON.stringify(expected[key]) : expected[key]);
        const result = await tx.query(`INSERT INTO nofries.dashboard_runtime_audit (${COLUMNS.join(', ')})
            VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})`, values);
        if (!result || isProxy(result) || Object.getOwnPropertyDescriptor(result, 'rowCount')?.value !== 1) unavailable();
        // No durable ACK is returned: INSERT evidence is provisional until the
        // native owner confirms commit (or exact reconciliation) and authority.
    } catch (_) { unavailable(); }
}
async function persistSignupAudit(tx, envelope, attempt = null) { await phase(tx, envelope, attempt, false); }
async function reconcileSignupAudit(tx, envelope, attempt = null) { await phase(tx, envelope, attempt, true); }
module.exports = Object.freeze({ persistSignupAudit, reconcileSignupAudit, DashboardAdminSignupAuditWriterError });
