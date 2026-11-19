'use strict';

// Contact request retention (#455): dashboard contact requests are kept for 24
// months from requested_at, then deleted. Off unless
// NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED is exactly 'true'.
//
// Once a day the job checks that the database login may SET ROLE
// nofries_contact_request_retention (migration 0027) and does not inherit it.
// If not, it logs one code and does nothing. If so, it deletes in bounded batches, each in its own
// transaction under SET LOCAL ROLE and a statement timeout. The role sees only
// rows older than 24 months (row security), so a bug here cannot reach a
// newer row. Logs carry a fixed code and a count, never row contents or ids.
// Nothing here throws to the host.
const { createPostgresPool } = require('./database/postgres');

const ROLE = 'nofries_contact_request_retention';
// SET must be held and USAGE must not: a grant WITH INHERIT TRUE would let the
// login's ordinary queries use the role's policies without SET ROLE.
const ROLE_PROBE = `SELECT pg_has_role(current_user, '${ROLE}', 'SET') AS can_set,
    pg_has_role(current_user, '${ROLE}', 'USAGE') AS inherited`;
const BATCH = 500;
const MAX_BATCHES = 20;
const STATEMENT_TIMEOUT_MS = 15000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
// The policy already limits the role to rows past 24 months; the same cut-off
// is repeated here so the statement says what it does.
const PURGE_SQL = `DELETE FROM nofries.dashboard_contact_requests
    WHERE (tenant_id, request_id) IN (SELECT tenant_id, request_id FROM nofries.dashboard_contact_requests
        WHERE requested_at < now() - interval '24 months' ORDER BY requested_at LIMIT $1)
      AND requested_at < now() - interval '24 months'`;

const retentionEnabled = env => env.NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED === 'true';

function createContactRequestRetention({ pool, log = defaultLog, batchSize = BATCH, maxBatches = MAX_BATCHES }) {
    async function purgeBatch() {
        const client = await pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
            await client.query(`SET LOCAL ROLE ${ROLE}`);
            const result = await client.query(PURGE_SQL, [batchSize]);
            await client.query('COMMIT');
            return Number(result.rowCount) || 0;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
            throw error;
        } finally { client.release(discard); }
    }
    async function runOnce() {
        let probe;
        try { probe = (await pool.query(ROLE_PROBE)).rows?.[0]; }
        catch (_) { return report('retention_probe_failed', 0); }
        if (probe?.can_set !== true) return report('retention_role_unavailable', 0);
        if (probe.inherited !== false) return report('retention_role_inherited', 0);
        let deleted = 0;
        try {
            for (let batch = 0; batch < maxBatches; batch += 1) {
                const count = await purgeBatch();
                deleted += count;
                if (count < batchSize) return report('retention_completed', deleted);
            }
            return report('retention_batch_limit', deleted);
        } catch (_) { return report('retention_failed', deleted); }
    }
    function report(code, deleted) {
        try { log({ code, deleted }); } catch (_) { /* logging must not stop the job */ }
        return { code, deleted };
    }
    return Object.freeze({ runOnce });
}

// The App Service runtime login, by managed identity, as the account wipe uses.
function createProductionPool(env, dependencies = {}) {
    const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID
        ? new ManagedIdentityCredential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new ManagedIdentityCredential();
    return (dependencies.createPostgresPool || createPostgresPool)({ env, poolMax: 1, statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        connectionTimeoutMs: 5000, applicationName: 'nofries-contact-retention', credential });
}

// Never throws. The first run is a few minutes after start, then daily.
let active = null;
function startContactRequestRetention({ env = process.env, dependencies, setTimeoutImpl = setTimeout,
    setIntervalImpl = setInterval, log = defaultLog } = {}) {
    if (!retentionEnabled(env)) return null;
    if (active) return active;
    let job;
    try { job = createContactRequestRetention({ pool: createProductionPool(env, dependencies), log }); }
    catch (_) {
        try { log({ code: 'retention_start_failed', deleted: 0 }); } catch (__) { /* nothing more to do */ }
        return null;
    }
    let running = false;
    async function tick() {
        if (running) return null;
        running = true;
        try { return await job.runOnce(); } catch (_) { return null; } finally { running = false; }
    }
    const first = setTimeoutImpl(tick, FIRST_RUN_DELAY_MS); first?.unref?.();
    const timer = setIntervalImpl(tick, INTERVAL_MS); timer?.unref?.();
    const handle = Object.freeze({ tick, stop() { clearTimeout(first); clearInterval(timer); if (active === handle) active = null; } });
    active = handle;
    return handle;
}

function defaultLog({ code, deleted }) {
    console.info(JSON.stringify({ event: 'contact_request_retention', code, deleted }));
}

module.exports = { createContactRequestRetention, startContactRequestRetention, retentionEnabled, PURGE_SQL, ROLE, ROLE_PROBE,
    BATCH, MAX_BATCHES, STATEMENT_TIMEOUT_MS, FIRST_RUN_DELAY_MS, INTERVAL_MS };
