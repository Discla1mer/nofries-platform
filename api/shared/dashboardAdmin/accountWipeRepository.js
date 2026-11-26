'use strict';

// Staff account reset and delete in PostgreSQL. One transaction per call, run
// as the nofries_account_wipe capability (migration 0025), whose policies see
// only the tenant, account and subject named in transaction-local settings.
// Statements and table names are fixed here; callers supply identifiers only.
// Returns per-table row counts and never any row content.
const { uuid, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { createBoundedSender } = require('./accountWipeQuery');
// Client-side cap per query when no run deadline is given.
const UNTIMED_QUERY_MS = 30000, ROLLBACK_MS = 1000, COMMIT_MIN_MS = 1000;

// Children before parents. Reset clears an organisation's working data and
// keeps its tenant, membership, entitlement and sign-in bindings, so the
// account can still sign in and start again.
const RESET_TABLES = Object.freeze([
    // A contact request is the organisation's own working data (0026); nothing references it.
    'dashboard_contact_requests',
    'dashboard_representative_details',
    'dashboard_improvement_heads', 'dashboard_improvement_revisions',
    'dashboard_iso_report_decisions', 'dashboard_iso_report_artifacts',
    'dashboard_evidence_heads', 'dashboard_evidence_receipts', 'dashboard_evidence_revisions',
    'dashboard_framework_revisions',
    'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts', 'dashboard_ncsc_assessment_revisions'
]);
// Delete also removes everything that records the organisation itself.
// Referencing rows go before the rows they reference wherever the foreign key
// is not deferrable (0005: receipts and audit before bindings, bindings before
// admission decisions, onboarding proofs before decisions and cases); the
// deferrable cycles are complete by COMMIT.
const DELETE_TENANT_TABLES = Object.freeze([...RESET_TABLES,
    // Enrollment belongs to the retained agreement, not the cleared working data.
    'dashboard_deferred_agreements', 'dashboard_paid_framework_access', 'email_outbox',
    // The organisation's own profile (0035) is kept on reset, like its name.
    'dashboard_organisation_profiles',
    'dashboard_runtime_receipts', 'dashboard_runtime_audit', 'dashboard_identity_bindings',
    'dashboard_onboarding_proofs', 'dashboard_onboarding_decisions', 'dashboard_onboarding_cases',
    'dashboard_admission_decisions', 'dashboard_admission_authorities', 'dashboard_operation_receipts',
    'dashboard_usage', 'dashboard_advisor_assignments', 'dashboard_feature_flags', 'dashboard_entitlement_states',
    'dashboard_membership_states', 'signup_acceptance_receipts', 'dashboard_starter_scopes',
    'dashboard_organisations', 'dashboard_tenants'
]);
// Customer and onboarding-discovery session gates reference bindings and
// onboarding proofs without
// deferral, so they go first, after the receipts and audit rows that reference
// those sessions; the account and subject rows go last.
const DELETE_FIRST_TABLES = Object.freeze(['dashboard_runtime_receipts', 'dashboard_runtime_audit', 'dashboard_session_gates']);
const DELETE_ACCOUNT_TABLES = Object.freeze(['email_preferences', 'dashboard_starter_accounts', 'signup_registrations']);
const MAX_TENANTS = 64;
const lockTables = mode => mode === 'delete'
    ? [...new Set([...DELETE_FIRST_TABLES, ...DELETE_TENANT_TABLES, ...DELETE_ACCOUNT_TABLES])] : [...RESET_TABLES];
const fail = code => { const error = new Error(code); error.code = code; throw error; };
// PostgreSQL conditions the console explains; anything else is unavailable.
// 23503: a row the wipe cannot see (a staff or other person's session, or a
// row in an organisation outside this account) still references one being
// deleted. 55P03: a customer writer held a table past the lock timeout.
// 57014: a statement ran into the remaining run budget (statement_timeout).
const DATABASE_CODES = Object.freeze({ '23503': 'account_wipe_reference_blocked', '55P03': 'account_wipe_busy', '57014': 'account_wipe_timed_out' });

function target(input, mode) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('account_wipe_target_invalid');
    const keys = Object.keys(input).sort().join(',');
    if (keys !== 'accountId,subjectKey,tenantIds') fail('account_wipe_target_invalid');
    // Only the read-only probe runs without a sign-in subject (an unfinished signup).
    uuid(input.accountId); if (!(mode === 'probe' && input.subjectKey === null)) subject(input.subjectKey);
    if (!Array.isArray(input.tenantIds) || !input.tenantIds.length || input.tenantIds.length > MAX_TENANTS ||
        new Set(input.tenantIds).size !== input.tenantIds.length) fail('account_wipe_target_invalid');
    input.tenantIds.forEach(id => uuid(id));
    return Object.freeze({ accountId: input.accountId, subjectKey: input.subjectKey, tenantIds: Object.freeze([...input.tenantIds]) });
}

// An optional run deadline (epoch ms, with an optional AbortSignal) is
// enforced inside the transaction: before every statement the remaining time
// is checked and statement_timeout lowered to it, lock_timeout is at most the
// remaining time, and the time left is checked again immediately before COMMIT,
// which is never sent after the deadline. Expiry rolls back with
// account_wipe_timed_out: nothing is committed. A COMMIT whose result is not
// known (connection lost or cancelled during it) is account_wipe_commit_unknown.
function createAccountWipeRepository(pool, { now = Date.now } = {}) {
    if (!pool || typeof pool.connect !== 'function' || typeof now !== 'function') fail('account_wipe_configuration_invalid');
    async function run(input, mode, options = {}) {
        const scope = target(input, mode), counts = {};
        if (!options || typeof options !== 'object' || options.deadline !== undefined && !Number.isFinite(options.deadline) ||
            options.signal !== undefined && typeof options.signal?.aborted !== 'boolean') fail('account_wipe_target_invalid');
        const add = (table, n) => { counts[table] = (counts[table] || 0) + n; };
        const timed = options.deadline !== undefined;
        const remaining = () => {
            const left = Math.floor(options.deadline - now());
            if (left <= 0 || options.signal?.aborted) fail('account_wipe_timed_out');
            return left;
        };
        // Waiting for a connection counts against the deadline. One that arrives
        // after giving up is released as broken, never used.
        let client;
        if (!timed) client = await pool.connect();
        else {
            const left = remaining();
            let timer, late = false;
            const pending = pool.connect();
            try {
                client = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { late = true; reject(new Error('timeout')); }, left); })]);
            } catch (_) {
                if (late) { pending.then(connection => connection.release(true), () => {}); fail('account_wipe_timed_out'); }
                fail('account_wipe_unavailable');
            } finally { clearTimeout(timer); }
        }
        // Every query goes through the bounded sender: a stalled answer breaks the
        // connection (destroyed below, nothing queued behind it) at the deadline.
        const sender = createBoundedSender(client, options.signal);
        const db = { async query(sql, params) {
            if (!timed) return sender.send(sql, params, UNTIMED_QUERY_MS, 'account_wipe_timed_out');
            if (sql !== 'BEGIN') await sender.send("SELECT set_config('statement_timeout', $1, true)", [String(remaining())], remaining(), 'account_wipe_timed_out');
            return sender.send(sql, params, remaining(), 'account_wipe_timed_out');
        } };
        let discard = false;
        try {
            await db.query('BEGIN');
            // Fails when the login is not granted the role (SET TRUE) or 0025 is absent.
            try { await db.query('SET LOCAL ROLE nofries_account_wipe'); }
            catch (error) { if (error?.code === 'account_wipe_timed_out') throw error; fail('account_wipe_role_unavailable'); }
            // Serialise with customer writers (evidence, assessments, plans) for the
            // whole wipe: no row can be added or changed in these tables until
            // COMMIT. Reads continue. DELETE privilege is enough for this mode; a
            // busy table fails the call after the lock timeout and nothing changes.
            if (timed) await db.query("SELECT set_config('lock_timeout', $1, true)", [String(Math.min(5000, remaining()))]);
            else await db.query("SET LOCAL lock_timeout = '5s'");
            if (mode !== 'probe') await db.query(`LOCK TABLE ${lockTables(mode).map(table => 'nofries.' + table).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
            await db.query("SELECT set_config('nofries.wipe_account_id', $1, true), set_config('nofries.wipe_subject_key', $2, true)",
                [scope.accountId, scope.subjectKey ?? '']);
            // The wipe role sees the account row only under the expected subject, so
            // an account row under another subject (or with no subject known) would
            // look absent. Its preferences (by account) and its tenants' rows are
            // visible, and any of them left means the database still holds it.
            const found = result => result?.rows?.[0]?.found === true;
            async function held() {
                if (found(await db.query('SELECT EXISTS (SELECT 1 FROM nofries.email_preferences WHERE account_id = $1) AS found', [scope.accountId]))) return true;
                for (const tenantId of scope.tenantIds) {
                    await db.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantId]);
                    if (found(await db.query('SELECT (EXISTS (SELECT 1 FROM nofries.dashboard_starter_scopes WHERE tenant_id = $1) OR ' +
                        'EXISTS (SELECT 1 FROM nofries.dashboard_tenants WHERE tenant_id = $1)) AS found', [tenantId]))) return true;
                }
                return false;
            }
            if (mode === 'probe') {
                // Read only: whether the database holds anything of an account
                // with no recorded sign-in subject. Nothing is locked or changed.
                const result = Object.freeze({ mode, held: await held() });
                await sender.send('ROLLBACK', undefined, ROLLBACK_MS, 'account_wipe_unavailable');
                return result;
            }
            // The account must exist under this subject before anything is removed.
            const owner = await db.query('SELECT 1 FROM nofries.dashboard_starter_accounts WHERE account_id = $1 AND subject_key = $2',
                [scope.accountId, scope.subjectKey]);
            if (owner.rowCount !== 1) {
                // "Not found" only when nothing of the account is left.
                if (await held()) fail('account_wipe_subject_mismatch');
                fail('account_wipe_account_not_found');
            }
            // Every tenant must belong to this account before anything is deleted;
            // a foreign tenant id aborts the whole call.
            for (const tenantId of scope.tenantIds) {
                await db.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantId]);
                const scoped = await db.query('SELECT 1 FROM nofries.dashboard_starter_scopes WHERE tenant_id = $1 AND account_id = $2',
                    [tenantId, scope.accountId]);
                if (scoped.rowCount !== 1) fail('account_wipe_tenant_mismatch');
            }
            if (mode === 'delete') {
                // Rows tied to the customer's sessions and to no tenant (for example the
                // organisation directory read), then the sessions themselves. Session
                // rows in a tenant go with that tenant below; one in a tenant this
                // account does not own makes the delete fail, never reach across.
                const sessions = "SELECT session_sha256 FROM nofries.dashboard_session_gates WHERE subject_key = $1 AND kind IN ('customer', 'onboarding_discovery')";
                add('dashboard_runtime_receipts', (await db.query(`DELETE FROM nofries.dashboard_runtime_receipts WHERE tenant_id IS NULL AND anchor_session_sha256 IN (${sessions})`,
                    [scope.subjectKey])).rowCount);
                add('dashboard_runtime_audit', (await db.query(`DELETE FROM nofries.dashboard_runtime_audit WHERE tenant_id IS NULL AND session_sha256 IN (${sessions})`,
                    [scope.subjectKey])).rowCount);
                add('dashboard_session_gates', (await db.query("DELETE FROM nofries.dashboard_session_gates WHERE subject_key = $1 AND kind IN ('customer', 'onboarding_discovery')",
                    [scope.subjectKey])).rowCount);
            }
            for (const tenantId of scope.tenantIds) {
                await db.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantId]);
                for (const table of mode === 'delete' ? DELETE_TENANT_TABLES : RESET_TABLES) {
                    add(table, (await db.query(`DELETE FROM nofries.${table} WHERE tenant_id = $1`, [tenantId])).rowCount);
                }
            }
            if (mode === 'delete') {
                await db.query("SELECT set_config('nofries.wipe_tenant_id', '', true)");
                add('email_preferences', (await db.query('DELETE FROM nofries.email_preferences WHERE account_id = $1', [scope.accountId])).rowCount);
                add('dashboard_starter_accounts', (await db.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id = $1 AND subject_key = $2',
                    [scope.accountId, scope.subjectKey])).rowCount);
                add('signup_registrations', (await db.query('DELETE FROM nofries.signup_registrations WHERE subject_key = $1', [scope.subjectKey])).rowCount);
            }
            if (timed) remaining();
            // statement_timeout does not cover COMMIT, so its wait is bounded here
            // (at least 1 s): no answer in time, or any failure, is an unknown outcome.
            try { await sender.send('COMMIT', undefined, timed ? Math.max(COMMIT_MIN_MS, options.deadline - now()) : UNTIMED_QUERY_MS, 'account_wipe_commit_unknown'); }
            catch (_) { fail('account_wipe_commit_unknown'); }
            return Object.freeze({ mode, tenants: scope.tenantIds.length, counts: Object.freeze(counts) });
        } catch (error) {
            discard = true;
            // A query still in flight (a stalled one, or a COMMIT whose result is
            // unknown) blocks the connection: PostgreSQL runs one query at a time, so
            // nothing is queued behind it and the connection is destroyed. Otherwise
            // the connection is idle in the transaction and a bounded ROLLBACK is sent.
            if (!sender.broken && error?.code !== 'account_wipe_commit_unknown') {
                try { await sender.send('ROLLBACK', undefined, ROLLBACK_MS, 'account_wipe_unavailable'); }
                catch (_) { /* The connection is discarded below. */ }
            }
            if (typeof error.code === 'string' && error.code.startsWith('account_wipe_')) throw error;
            fail(DATABASE_CODES[error?.code] || 'account_wipe_unavailable');
        } finally { client.release(discard); }
    }
    return Object.freeze({ reset: (input, options) => run(input, 'reset', options), delete: (input, options) => run(input, 'delete', options),
        probe: (input, options) => run(input, 'probe', options) });
}

module.exports = { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES, DELETE_FIRST_TABLES, DELETE_ACCOUNT_TABLES };
