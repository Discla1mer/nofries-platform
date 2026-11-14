'use strict';

// Staff account reset and delete in PostgreSQL. One transaction per call, run
// as the nofries_account_wipe capability (migration 0025), whose policies see
// only the tenant, account and subject named in transaction-local settings.
// Statements and table names are fixed here; callers supply identifiers only.
// Returns per-table row counts and never any row content.
const { uuid, subject } = require('../appLifecycle/dashboardRuntimeRecords');

// Children before parents. Reset clears an organisation's working data and
// keeps its tenant, membership, entitlement and sign-in bindings, so the
// account can still sign in and start again.
const RESET_TABLES = Object.freeze([
    'dashboard_improvement_heads', 'dashboard_improvement_revisions',
    'dashboard_evidence_heads', 'dashboard_evidence_receipts', 'dashboard_evidence_revisions',
    'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts', 'dashboard_ncsc_assessment_revisions'
]);
// Delete also removes everything that records the organisation itself.
// Referencing rows go before the rows they reference wherever the foreign key
// is not deferrable (0005: receipts and audit before bindings, bindings before
// admission decisions, onboarding proofs before decisions and cases); the
// deferrable cycles are complete by COMMIT.
const DELETE_TENANT_TABLES = Object.freeze([...RESET_TABLES,
    'email_outbox',
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

function target(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('account_wipe_target_invalid');
    const keys = Object.keys(input).sort().join(',');
    if (keys !== 'accountId,subjectKey,tenantIds') fail('account_wipe_target_invalid');
    uuid(input.accountId); subject(input.subjectKey);
    if (!Array.isArray(input.tenantIds) || !input.tenantIds.length || input.tenantIds.length > MAX_TENANTS ||
        new Set(input.tenantIds).size !== input.tenantIds.length) fail('account_wipe_target_invalid');
    input.tenantIds.forEach(id => uuid(id));
    return Object.freeze({ accountId: input.accountId, subjectKey: input.subjectKey, tenantIds: Object.freeze([...input.tenantIds]) });
}

function createAccountWipeRepository(pool) {
    if (!pool || typeof pool.connect !== 'function') fail('account_wipe_configuration_invalid');
    async function run(input, mode) {
        const scope = target(input), counts = {};
        const add = (table, n) => { counts[table] = (counts[table] || 0) + n; };
        const client = await pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE nofries_account_wipe');
            // Serialise with customer writers (evidence, assessments, plans) for the
            // whole wipe: no row can be added or changed in these tables until
            // COMMIT. Reads continue. DELETE privilege is enough for this mode; a
            // busy table fails the call after the lock timeout and nothing changes.
            await client.query("SET LOCAL lock_timeout = '5s'");
            await client.query(`LOCK TABLE ${lockTables(mode).map(table => 'nofries.' + table).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
            await client.query("SELECT set_config('nofries.wipe_account_id', $1, true), set_config('nofries.wipe_subject_key', $2, true)",
                [scope.accountId, scope.subjectKey]);
            // The account must exist under this subject before anything is removed.
            const owner = await client.query('SELECT 1 FROM nofries.dashboard_starter_accounts WHERE account_id = $1 AND subject_key = $2',
                [scope.accountId, scope.subjectKey]);
            if (owner.rowCount !== 1) fail('account_wipe_account_not_found');
            // Every tenant must belong to this account before anything is deleted;
            // a foreign tenant id aborts the whole call.
            for (const tenantId of scope.tenantIds) {
                await client.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantId]);
                const scoped = await client.query('SELECT 1 FROM nofries.dashboard_starter_scopes WHERE tenant_id = $1 AND account_id = $2',
                    [tenantId, scope.accountId]);
                if (scoped.rowCount !== 1) fail('account_wipe_tenant_mismatch');
            }
            if (mode === 'delete') {
                // Rows tied to the customer's sessions and to no tenant (for example the
                // organisation directory read), then the sessions themselves. Session
                // rows in a tenant go with that tenant below; one in a tenant this
                // account does not own makes the delete fail, never reach across.
                const sessions = "SELECT session_sha256 FROM nofries.dashboard_session_gates WHERE subject_key = $1 AND kind IN ('customer', 'onboarding_discovery')";
                add('dashboard_runtime_receipts', (await client.query(`DELETE FROM nofries.dashboard_runtime_receipts WHERE tenant_id IS NULL AND anchor_session_sha256 IN (${sessions})`,
                    [scope.subjectKey])).rowCount);
                add('dashboard_runtime_audit', (await client.query(`DELETE FROM nofries.dashboard_runtime_audit WHERE tenant_id IS NULL AND session_sha256 IN (${sessions})`,
                    [scope.subjectKey])).rowCount);
                add('dashboard_session_gates', (await client.query("DELETE FROM nofries.dashboard_session_gates WHERE subject_key = $1 AND kind IN ('customer', 'onboarding_discovery')",
                    [scope.subjectKey])).rowCount);
            }
            for (const tenantId of scope.tenantIds) {
                await client.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantId]);
                for (const table of mode === 'delete' ? DELETE_TENANT_TABLES : RESET_TABLES) {
                    add(table, (await client.query(`DELETE FROM nofries.${table} WHERE tenant_id = $1`, [tenantId])).rowCount);
                }
            }
            if (mode === 'delete') {
                await client.query("SELECT set_config('nofries.wipe_tenant_id', '', true)");
                add('email_preferences', (await client.query('DELETE FROM nofries.email_preferences WHERE account_id = $1', [scope.accountId])).rowCount);
                add('dashboard_starter_accounts', (await client.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id = $1 AND subject_key = $2',
                    [scope.accountId, scope.subjectKey])).rowCount);
                add('signup_registrations', (await client.query('DELETE FROM nofries.signup_registrations WHERE subject_key = $1', [scope.subjectKey])).rowCount);
            }
            await client.query('COMMIT');
            return Object.freeze({ mode, tenants: scope.tenantIds.length, counts: Object.freeze(counts) });
        } catch (error) {
            discard = true;
            try { await client.query('ROLLBACK'); } catch (_) { /* The connection is discarded below. */ }
            if (typeof error.code === 'string' && error.code.startsWith('account_wipe_')) throw error;
            fail('account_wipe_unavailable');
        } finally { client.release(discard); }
    }
    return Object.freeze({ reset: input => run(input, 'reset'), delete: input => run(input, 'delete') });
}

module.exports = { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES, DELETE_FIRST_TABLES, DELETE_ACCOUNT_TABLES };
