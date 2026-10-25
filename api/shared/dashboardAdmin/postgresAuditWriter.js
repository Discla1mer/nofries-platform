'use strict';

// Transaction-only mechanics. The native owner supplies an already fenced,
// deadline-bound transaction and owns COMMIT and acknowledgement. These helpers
// do not authenticate supplied envelopes or return an authorization capability.
const { normaliseAuditEnvelope, projectAuditRow, verifyAuditRow, verifyAuditPhasePair } = require('./auditEnvelope');
const { isProxy } = require('node:util').types;

const COLUMNS = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
    'tenant_id', 'organisation_id', 'scope_json', 'occurred_at', 'event_type', 'event_sha256', 'operation_id', 'payload'];
const PHASE_LOCK_FAMILY = 71005;

class DashboardAdminAuditWriterError extends Error {
    constructor() { super('dashboard_admin_audit_unavailable'); this.code = this.message; this.statusCode = 503; }
}
const unavailable = () => { throw new DashboardAdminAuditWriterError(); };

function inputs(tx, input, originalAttempt) {
    if (!tx || isProxy(tx) || typeof tx.query !== 'function' || isProxy(tx.query)) unavailable();
    const envelope = normaliseAuditEnvelope(input);
    let attempt = null;
    if (envelope.event.phase === 'terminal') attempt = verifyAuditPhasePair(originalAttempt, envelope).attempt;
    else if (originalAttempt !== null) unavailable();
    return { envelope, attempt };
}
function slot(envelope, phase = envelope.event.phase) {
    return [envelope.instanceId, envelope.sessionSha256, envelope.event.requestId, envelope.event.lookupRequestId, phase];
}
async function lock(tx, envelope) {
    // The native owner takes session71001 and instance71002 before this lock.
    // Both phases share one lock; hash collisions only serialize extra work.
    await tx.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))',
        [PHASE_LOCK_FAMILY, JSON.stringify(slot(envelope).slice(0, 4))]);
}
async function read(tx, envelope) {
    const result = await tx.query(`SELECT ${COLUMNS.join(', ')} FROM nofries.dashboard_runtime_audit
        WHERE event_type='dashboard.admin.lookup' AND instance_id=$1 AND session_sha256=$2
          AND request_id=$3 AND payload->>'lookupRequestId'=$4 AND payload->>'phase'=$5`, slot(envelope));
    if (!result || isProxy(result) || !Array.isArray(result.rows) || result.rows.length > 1) unavailable();
    return result.rows.length ? verifyAuditRow(result.rows[0], envelope) : null;
}
async function phase(tx, input, originalAttempt, reconcile) {
    try {
        // Detach all caller data before the first asynchronous boundary.
        const { envelope, attempt } = inputs(tx, input, originalAttempt);
        const expected = projectAuditRow(envelope);
        await lock(tx, envelope);
        if (attempt && !await read(tx, attempt)) unavailable();
        if (await read(tx, envelope)) return;
        if (reconcile) unavailable();
        const values = COLUMNS.map(key => ['scope_json', 'payload'].includes(key) ? JSON.stringify(expected[key]) : expected[key]);
        const result = await tx.query(`INSERT INTO nofries.dashboard_runtime_audit (${COLUMNS.join(', ')})
            VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})`, values);
        if (!result || isProxy(result) || result.rowCount !== 1) unavailable();
        // No acknowledgement is returned here: even an exact INSERT result is
        // provisional until the native owner confirms COMMIT/current authority.
    } catch (_) { unavailable(); }
}
async function persistAudit(tx, envelope, attempt = null) { await phase(tx, envelope, attempt, false); }
async function reconcileAudit(tx, envelope, attempt = null) { await phase(tx, envelope, attempt, true); }

module.exports = Object.freeze({ persistAudit, reconcileAudit, DashboardAdminAuditWriterError });
