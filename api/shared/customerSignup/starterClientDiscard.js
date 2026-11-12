'use strict';

// Discarding draft client organisations and counting the client limit at
// activation (#151). Off unless NOFRIES_STARTER_CLIENT_DISCARD_ENABLED is
// 'true' AND migration 0019 is present. With either missing, every caller keeps
// the earlier rule: a client place is used when the draft is reserved.
const { uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const { CLIENT_RESERVATION_CEILING } = require('./starterAccountAllocation');
const fail = code => { const error = new Error(code); error.code = code; throw error; };

// The runtime has no migration-ledger privilege. This bounded catalog read only
// recognises the 0019 column and ordinal bound; it grants nothing.
async function readStarterDiscardLayout(tx) {
    const result = await tx.query(`SELECT
        EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'discarded_at'
            AND a.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype AND NOT a.attnotnull AND NOT a.attisdropped) AS has_column,
        EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid
            AND k.conname = 'dashboard_starter_scopes_ordinal_bound') AS has_bound
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'nofries' AND c.relname = 'dashboard_starter_scopes' AND c.relkind = 'r'`, []);
    const row = result?.rows?.[0];
    if (!Array.isArray(result?.rows) || result.rows.length !== 1 || typeof row.has_column !== 'boolean' ||
        typeof row.has_bound !== 'boolean') fail('starter_discard_layout_invalid');
    // Both arrive in one migration transaction; one without the other is drift.
    if (row.has_column !== row.has_bound) fail('starter_discard_layout_invalid');
    return row.has_column;
}

function createStarterDiscardGate({ enabled, readLayout }) {
    if (typeof readLayout !== 'function') fail('starter_configuration_invalid');
    let present = false;
    // A present schema is remembered (0019 is forward-only); an absent one is
    // read again next time, so applying the migration needs no restart.
    return async function ready() {
        if (enabled !== true) return false;
        if (!present) present = await readLayout() === true;
        return present;
    };
}

// Requires nofries.subject_key to be set to the account's owner in `tx`.
async function readStarterClientUse(tx, accountId) {
    uuid(accountId);
    const result = await tx.query(`SELECT organisation_id, activation IS NOT NULL AS activated, discarded_at IS NOT NULL AS discarded
        FROM nofries.dashboard_starter_scopes WHERE account_id = $1 AND ordinal > 0 ORDER BY ordinal LIMIT $2`,
    [accountId, CLIENT_RESERVATION_CEILING + 1]);
    if (!Array.isArray(result?.rows) || result.rows.length > CLIENT_RESERVATION_CEILING) fail('starter_record_invalid');
    const scopes = new Map();
    for (const row of result.rows) {
        uuid(row.organisation_id);
        if (typeof row.activated !== 'boolean' || typeof row.discarded !== 'boolean' || row.activated && row.discarded ||
            scopes.has(row.organisation_id)) fail('starter_record_invalid');
        scopes.set(row.organisation_id, Object.freeze({ activated: row.activated, discarded: row.discarded }));
    }
    const activated = [...scopes.values()].filter(scope => scope.activated).length;
    return Object.freeze({ scopes, activated });
}

// Places left to add a client: the plan limit less activated clients, and never
// more than the reservations the account record can still hold.
function starterClientsRemaining({ limit, activated, reserved }) {
    for (const value of [limit, activated, reserved]) if (!Number.isSafeInteger(value) || value < 0) fail('starter_record_invalid');
    return Math.max(0, Math.min(limit - activated, CLIENT_RESERVATION_CEILING - reserved));
}

// Requires the draft's tenant, organisation and owner subject in `tx`. Returns
// 'discarded' (now or before), or refuses when it is not an unactivated draft.
async function discardStarterDraft(tx, { tenantId, organisationId, subjectKey }) {
    const changed = await tx.query(`UPDATE nofries.dashboard_starter_scopes SET discarded_at = date_trunc('milliseconds', clock_timestamp())
        WHERE tenant_id = $1 AND organisation_id = $2 AND subject_key = $3 AND ordinal > 0 AND activation IS NULL AND discarded_at IS NULL
        RETURNING tenant_id`, [tenantId, organisationId, subjectKey]);
    if (changed?.rows?.length === 1) return 'discarded';
    const found = await tx.query(`SELECT discarded_at IS NOT NULL AS discarded FROM nofries.dashboard_starter_scopes
        WHERE tenant_id = $1 AND organisation_id = $2 AND subject_key = $3 AND ordinal > 0`, [tenantId, organisationId, subjectKey]);
    if (found?.rows?.length === 1 && found.rows[0].discarded === true) return 'discarded';
    fail('starter_client_not_draft');
}

module.exports = { readStarterDiscardLayout, createStarterDiscardGate, readStarterClientUse, starterClientsRemaining,
    discardStarterDraft };
