'use strict';

const { createPostgresDatabase } = require('../database/postgres');
const { createPostgresDashboardRepository } = require('../appLifecycle/postgresDashboardRepository');
const { accountActionsPool } = require('./accountActionsPool');
const { digest, uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const { verifyRestore } = require('./accountActionsProvenance');

// The canonical repository owns locks, revision comparisons, scoped membership
// transitions and immutable operation receipts. Recheck native authority before
// each mutation and COMMIT; failure rolls the transaction back.
function createAccountActionsRepository(pool, clock, guard, authoriseAdministration, context) {
    const fences = [[71001, digest(context.sessionSha256)], [71002, uuid(context.instanceId)]];
    pool = accountActionsPool(pool);
    const guarded = { end: () => pool.end(), async connect() {
        await guard();
        const client = await pool.connect();
        return { release: discard => client.release(discard), async query(sql, values) {
            if (/^(?:UPDATE |INSERT |COMMIT$)/.test(sql)) await guard();
            const result = await client.query(sql, values);
            // Acquire native fences before any validation savepoint so restoring
            // its settings cannot let revocation overtake the membership COMMIT.
            if (sql === 'BEGIN') {
                await client.query('SET LOCAL ROLE nofries_runtime');
                for (const fence of fences) await client.query('SELECT pg_advisory_xact_lock_shared($1::integer, hashtext($2))', fence);
            }
            return result;
        } };
    } };
    const database = createPostgresDatabase({ pool: guarded });
    const repository = { ...createPostgresDashboardRepository({ database, clock, authoriseAdministration }),
        verifyRestore: (selector, snapshot, readTerminal) => database.withTenantTransaction(selector.tenantId,
            tx => verifyRestore(tx, selector, snapshot, { instanceId: context.instanceId, restoreEpoch: context.restoreEpoch }, readTerminal, clock())) };
    return Object.freeze(Object.fromEntries(Object.entries(repository).map(([key, fn]) =>
        [key, (...args) => pool.run(() => fn(...args))])));
}
module.exports = { createAccountActionsRepository };
