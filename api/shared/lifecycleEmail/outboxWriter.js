'use strict';

// Lifecycle email outbox writes (#151, slice E2). Each function runs on the
// caller's open transaction client, so an enqueue commits or rolls back with the
// business write that caused it. Rows carry identifiers and at most two small
// parameters; no address, name or free text is ever stored (migration 0021).
const crypto = require('node:crypto');

const TYPES = Object.freeze(['welcome', 'result_summary', 'nudge_unfinished', 'reassess_reminder']);
const TEMPLATE_VERSIONS = Object.freeze({ welcome: 'welcome-v1', result_summary: 'result-summary-v1',
    nudge_unfinished: 'nudge-unfinished-v1', reassess_reminder: 'reassess-reminder-v1' });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARAM_KEYS = ['assessmentId', 'gapCount'];

class OutboxWriteError extends Error {
    constructor(code = 'email_outbox_invalid') {
        super('No Fries could not queue the lifecycle email.');
        this.name = 'OutboxWriteError';
        this.code = code;
    }
}
const invalid = () => { throw new OutboxWriteError(); };

// Exactly 'true' turns enqueue on; anything else, including unset, is off.
function lifecycleEmailEnqueueEnabled(env = process.env) {
    return env.NOFRIES_LIFECYCLE_EMAIL_ENQUEUE_ENABLED === 'true';
}

function scopeOf(input) {
    if (!input || typeof input !== 'object') invalid();
    const { tenantId, organisationId, accountId } = input;
    if (typeof tenantId !== 'string' || !ID.test(tenantId) || typeof organisationId !== 'string' ||
        !ID.test(organisationId) || typeof accountId !== 'string' || !UUID.test(accountId)) invalid();
    return { tenantId, organisationId, accountId };
}
function type(value) {
    if (!TYPES.includes(value)) invalid();
    return value;
}
// Mirrors the 0021 params CHECK so a bad value fails before any SQL.
function params(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !PARAM_KEYS.includes(key))) invalid();
    const out = {};
    if (Object.hasOwn(value, 'assessmentId')) {
        if (typeof value.assessmentId !== 'string' || !ID.test(value.assessmentId)) invalid();
        out.assessmentId = value.assessmentId;
    }
    if (Object.hasOwn(value, 'gapCount')) {
        if (!Number.isSafeInteger(value.gapCount) || value.gapCount < 0 || value.gapCount > 1000) invalid();
        out.gapCount = value.gapCount;
    }
    return out;
}
function instant(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid();
    return new Date(value).toISOString();
}

// Returns true when a row was written, false when the dedupe key already exists.
async function enqueue(client, input) {
    const scope = scopeOf(input), emailType = type(input.type);
    if (typeof input.dedupeKey !== 'string' || !ID.test(input.dedupeKey)) invalid();
    const result = await client.query(`INSERT INTO nofries.email_outbox
        (outbox_id, tenant_id, organisation_id, account_id, email_type, dedupe_key, template_version, params, not_before)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
        ON CONFLICT (account_id, organisation_id, email_type, dedupe_key) DO NOTHING`,
    [crypto.randomUUID(), scope.tenantId, scope.organisationId, scope.accountId, emailType, input.dedupeKey,
        TEMPLATE_VERSIONS[emailType], JSON.stringify(params(input.params ?? {})), instant(input.notBefore)]);
    if (!result || ![0, 1].includes(result.rowCount)) invalid();
    return result.rowCount === 1;
}

// Moves this account's pending rows of the given types to cancelled, the only
// update runtime may make.
async function cancelPending(client, input) {
    const scope = scopeOf(input);
    if (!Array.isArray(input.types) || !input.types.length) invalid();
    const types = input.types.map(type);
    const result = await client.query(`UPDATE nofries.email_outbox SET status = 'cancelled'
        WHERE tenant_id = $1 AND organisation_id = $2 AND account_id = $3 AND status = 'pending'
          AND email_type = ANY($4::text[])`,
    [scope.tenantId, scope.organisationId, scope.accountId, types]);
    if (!result || !Number.isSafeInteger(result.rowCount)) invalid();
    return result.rowCount;
}

module.exports = { enqueue, cancelPending, lifecycleEmailEnqueueEnabled, OutboxWriteError, TEMPLATE_VERSIONS };
