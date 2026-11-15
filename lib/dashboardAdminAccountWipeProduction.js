'use strict';

// Production composition of staff account reset and delete. Called by the
// staff console composition only when suspend/restore composed and
// NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE is exactly 'true'. Nothing here runs a
// wipe; it builds the ports the executor needs:
//   - database: the runtime pool, used through SET LOCAL ROLE nofries_account_wipe
//     inside each wipe transaction. Each approval and run first checks that the
//     login may SET that role, and refuses with account_wipe_role_unavailable if not;
//   - storage: both starter authority containers and the browser-auth (session)
//     container, by the App Service managed identity;
//   - External ID: Graph by workload identity federation. With the Graph settings
//     unset (or unusable) delete is refused before anything is touched; reset works.
const { isProxy } = require('node:util').types;
const WIPE_SETTING = 'NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE';
const LEGACY_INDEX_SETTINGS = Object.freeze(['NOFRIES_DASHBOARD_ADMIN_BINDING', 'NOFRIES_DASHBOARD_ADMIN_ENABLED']);
const ROLE_PROBE = "SELECT pg_has_role(current_user, 'nofries_account_wipe', 'SET') AS ok";
const fail = () => { throw new Error('dashboard_admin_staff_configuration_invalid'); };
const value = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

// The probe is bounded by the run deadline (at most PROBE_CAP_MS): the wait
// for a connection is raced against it, and a connection that arrives after
// giving up is released as broken; the probe runs in a transaction with
// statement_timeout set to the time left.
const PROBE_CAP_MS = 5000;
function createRoleProbe(pool, now = Date.now) {
    return async function ensureRole({ signal, deadline } = {}) {
        const until = Math.min(now() + PROBE_CAP_MS, deadline ?? Infinity);
        const left = () => { const ms = Math.floor(until - now()); if (ms <= 0 || signal?.aborted) throw new Error('account_wipe_timed_out'); return ms; };
        let timer, late = false;
        const pending = pool.connect();
        let client;
        try {
            client = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { late = true; reject(new Error('timeout')); }, left()); })]);
        } catch (error) {
            if (late) pending.then(connection => connection.release(true), () => {});
            throw error;
        } finally { clearTimeout(timer); }
        // Every probe query is bounded client-side too; a stalled one breaks the
        // connection, which is destroyed without anything queued behind it.
        const { createBoundedSender } = require('../api/shared/dashboardAdmin/accountWipeQuery');
        const sender = createBoundedSender(client, signal);
        const send = (sql, params) => sender.send(sql, params, left(), 'account_wipe_timed_out');
        let allowed = false, discard = false;
        try {
            await send('BEGIN');
            await send("SELECT set_config('statement_timeout', $1, true)", [String(left())]);
            allowed = (await send(ROLE_PROBE)).rows?.[0]?.ok === true;
            await send('COMMIT');
        } catch (error) {
            discard = true;
            if (!sender.broken) { try { await sender.send('ROLLBACK', undefined, 1000, 'account_wipe_unavailable'); } catch (_) { /* discarded below */ } }
            throw error;
        } finally { client.release(discard); }
        if (!allowed) throw new Error('account_wipe_role_unavailable');
    };
}

function createAuditWriter(auditContainer) {
    const { writeActionRecord } = require('../api/shared/dashboardAdmin/accountActionsStorage');
    return async function audit(event, signal) {
        if (event?.category !== 'dashboard_admin_account_wipe' || !['approval', 'attempt', 'outcome', 'approval_refused', 'execute_refused'].includes(event.phase) ||
            typeof event.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(event.operationId)) fail();
        // 3 s: the outcome write must fit the executor's reserve in the run budget.
        await writeActionRecord(auditContainer, `dashboard-admin-account-wipes/${event.operationId}/${event.phase}.json`, event,
            { ifNoneMatch: '*' }, signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000));
    };
}

// The database-done fact of a partial delete, digest-only, so a retry after a
// restart can finish an account whose subject is no longer discoverable.
// Overwritten in place (no create-only condition); it is not an audit record.
function createRetryMarkers(auditContainer) {
    const { readActionRecord, writeActionRecord } = require('../api/shared/dashboardAdmin/accountActionsStorage');
    const key = digest => { if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) fail(); return `dashboard-admin-account-wipes/retry/${digest}.json`; };
    return Object.freeze({
        async read(digest) {
            try { return (await readActionRecord(auditContainer, key(digest), AbortSignal.timeout(3000))).record; }
            catch (error) { if (error?.statusCode === 404) return null; throw error; }
        },
        write: (digest, record) => writeActionRecord(auditContainer, key(digest), record, {}, AbortSignal.timeout(3000))
    });
}

// settings: from readStaffAdminSettings. services: { storage, auth } Blob
// service clients for the customer and browser-auth storage accounts.
function composeAccountWipe({ env, settings, pool, services, auditContainer, dependencies = {}, log = console.warn }) {
    if (!pool || typeof pool.connect !== 'function' || isProxy(pool)) fail();
    const { createAccountWipeExecutor } = require('../api/shared/dashboardAdmin/accountWipeExecutor');
    const { createAccountWipeStorage } = require('../api/shared/dashboardAdmin/accountWipeStorage');
    const { createAccountWipeRepository } = require('../api/shared/dashboardAdmin/accountWipeRepository');
    const { createAccountWipeIdentity } = require('../api/shared/dashboardAdmin/accountWipeIdentity');
    const { readAccountWipeGraphSettings, createAccountWipeGraphToken } = require('../api/shared/dashboardAdmin/accountWipeGraphToken');
    const { createAccountWipeRoute } = require('../api/shared/dashboardAdmin/accountWipeRoute');
    const sessionContainer = services.auth.getContainerClient(value(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth');
    const sources = settings.sources.filter(source => source.kind !== 'legacy_admin')
        .map(source => ({ kind: source.kind, storage: createAccountWipeStorage(services.storage.getContainerClient(source.container), sessionContainer) }));
    let identity = null;
    try {
        const graph = readAccountWipeGraphSettings(env);
        if (graph) {
            const credentials = require('@azure/identity');
            const getToken = createAccountWipeGraphToken({ ...graph, managedIdentityClientId: settings.identityClientId,
                ManagedIdentityCredential: value(dependencies, 'ManagedIdentityCredential') || credentials.ManagedIdentityCredential,
                ClientAssertionCredential: value(dependencies, 'ClientAssertionCredential') || credentials.ClientAssertionCredential });
            identity = createAccountWipeIdentity({ tenantId: graph.tenantId, getToken });
        }
    } catch (_) {
        identity = null;
        try { log('[dashboard-admin-account-wipe] account_wipe_identity_configuration_invalid'); } catch (_) { /* no logging authority */ }
    }
    const executor = createAccountWipeExecutor({ sources, repository: createAccountWipeRepository(pool), identity,
        ensureRole: createRoleProbe(pool), audit: createAuditWriter(auditContainer), retryMarkers: createRetryMarkers(auditContainer), targetDigest: settings.targetDigest,
        legacyIndexConfigured: LEGACY_INDEX_SETTINGS.some(key => ![undefined, '', 'false'].includes(value(env, key))) });
    return createAccountWipeRoute(executor);
}

module.exports = { composeAccountWipe, createRetryMarkers, createRoleProbe, WIPE_SETTING, LEGACY_INDEX_SETTINGS, ROLE_PROBE };
