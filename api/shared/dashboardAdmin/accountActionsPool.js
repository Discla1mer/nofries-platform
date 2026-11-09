'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const pools = new WeakMap();
const invalid = () => { throw new Error('dashboard_admin_unavailable'); };

// Only an action context reuses a lease. Nested native checks are read-only
// savepoints; rolling them back restores the outer role, tenant and timeouts.
// Membership transactions acquire native fences before these savepoints.
// Other callers retain the original pool behavior and connection budget.
function accountActionsPool(pool) {
    if (pools.has(pool)) return pools.get(pool);
    const contexts = new AsyncLocalStorage();
    const wrapped = { end: () => pool.end(),
        run: work => contexts.getStore() ? work() : contexts.run({ client: null, depth: 0, sequence: 0 }, work),
        async connect() {
            const state = contexts.getStore();
            if (!state) return pool.connect();
            if (!state.client) {
                if (state.acquiring) invalid();
                state.acquiring = true;
                try { state.client = await pool.connect(); } finally { state.acquiring = false; }
                const client = state.client; state.depth = 1;
                return { query: (...args) => { if (args[0] !== 'ROLLBACK' && (state.depth !== 1 || state.failed)) invalid(); return client.query(...args); },
                    release(discard) { state.client = null; client.release(discard || state.failed || state.depth !== 1); state.depth = 0; } };
            }
            const depth = ++state.depth, point = 'account_action_check_' + (++state.sequence);
            let started = false, released = false;
            return { release(discard) {
                if (released) return; released = true;
                if (discard || started || state.depth !== depth) state.failed = true;
                state.depth--;
            }, async query(sql, values) {
                if (released || state.failed || state.depth !== depth || typeof sql !== 'string') invalid();
                if (sql === 'BEGIN READ ONLY' && !started) {
                    const result = await state.client.query('SAVEPOINT ' + point); started = true; return result;
                }
                if (started && ['COMMIT', 'ROLLBACK'].includes(sql)) {
                    await state.client.query('ROLLBACK TO SAVEPOINT ' + point);
                    const result = await state.client.query('RELEASE SAVEPOINT ' + point); started = false; return result;
                }
                if (!started || !/^(SELECT |SET LOCAL )/.test(sql)) invalid();
                return state.client.query(sql, values);
            } };
        } };
    pools.set(pool, wrapped); pools.set(wrapped, wrapped);
    return Object.freeze(wrapped);
}
module.exports = { accountActionsPool };
