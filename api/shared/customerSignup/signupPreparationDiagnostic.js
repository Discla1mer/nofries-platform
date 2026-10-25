'use strict';

const { isProxy } = require('node:util').types;

// Request-local diagnostic values only. Error objects, query text, parameters
// and customer/request data never become recorder or carrier values.
const CHECKPOINTS = Object.freeze([
    'request_validation', 'provider_read', 'provider_compile', 'provider_recheck',
    'external_epoch', 'database_connect', 'transaction_begin', 'database_context',
    'instance_fence', 'instance_read', 'instance_codec', 'starter_account_insert',
    'starter_account_lock', 'starter_scope_read', 'starter_scope_insert',
    'bootstrap_initialisation', 'bootstrap_execute', 'bootstrap_tenant_read',
    'bootstrap_tenant_insert', 'bootstrap_child_read', 'bootstrap_child_write',
    'bootstrap_receipt_read', 'bootstrap_receipt_write', 'final_instance_check',
    'transaction_timeout', 'transaction_commit', 'transaction_rollback', 'unknown'
]);
const SQL_STATE_FAMILIES = Object.freeze([
    'connection', 'data_exception', 'integrity_constraint', 'transaction_state',
    'database_authorization', 'transaction_rollback', 'access_or_schema',
    'resource_limit', 'object_state_or_lock', 'operator_intervention',
    'trigger_or_procedure', 'unavailable'
]);
const TRANSACTION_OUTCOMES = Object.freeze(['not_started', 'unknown', 'committed', 'rolled_back']);
const checkpoints = new Set(CHECKPOINTS);
const families = Object.freeze({
    '08': 'connection', '22': 'data_exception', '23': 'integrity_constraint',
    '25': 'transaction_state', '28': 'database_authorization',
    '40': 'transaction_rollback', '42': 'access_or_schema', '53': 'resource_limit',
    '55': 'object_state_or_lock', '57': 'operator_intervention', 'P0': 'trigger_or_procedure'
});
const recorders = new WeakMap();
const snapshots = new WeakSet();
const carriers = new WeakMap();
const objectKey = value => value !== null && (typeof value === 'object' || typeof value === 'function') && !isProxy(value);

function sqlStateFamily(error) {
    try {
        if (!objectKey(error)) return 'unavailable';
        const code = Object.getOwnPropertyDescriptor(error, 'code');
        if (!code || !Object.hasOwn(code, 'value') || typeof code.value !== 'string' ||
            code.value.length !== 5 || !/^[A-Z0-9]{5}$/.test(code.value)) return 'unavailable';
        const family = code.value.slice(0, 2);
        return Object.hasOwn(families, family) ? families[family] : 'unavailable';
    } catch (_) { return 'unavailable'; }
}

function ownedSnapshot(state) {
    if (!state.enabled || state.failure === null) return null;
    // Preserve the first failure's location/family, but summarize both bounded
    // attempts conservatively: a later uncertain transaction is not a rollback.
    let transactionOutcome = 'not_started';
    if (state.knownCommit) transactionOutcome = 'committed';
    else if (state.failedAttempt.outcome === 'unknown' || state.attempt.outcome === 'unknown') transactionOutcome = 'unknown';
    else if (state.failedAttempt.outcome === 'rolled_back' || state.attempt.outcome === 'rolled_back') transactionOutcome = 'rolled_back';
    const value = Object.freeze({ checkpoint: state.failure.checkpoint,
        sqlStateFamily: state.failure.sqlStateFamily,
        transactionOutcome });
    snapshots.add(value);
    return value;
}

function commandTag(result) {
    try {
        if (!objectKey(result)) return null;
        const command = Object.getOwnPropertyDescriptor(result, 'command');
        if (!command || !Object.hasOwn(command, 'value')) return null;
        if (command.value === 'COMMIT') return 'commit';
        if (command.value === 'ROLLBACK') return 'rollback';
    } catch (_) {}
    return null;
}

function createPreparationDiagnostic() {
    const state = { enabled: false, checkpoint: 'unknown', attemptId: 0, knownCommit: false,
        attempt: { outcome: 'not_started', commitUncertain: false },
        failure: null, failedAttempt: null };
    const attemptFor = attemptId => {
        if (attemptId !== undefined && (!Number.isSafeInteger(attemptId) || attemptId < 0)) return null;
        if (attemptId === undefined || attemptId === state.attemptId) return state.attempt;
        if (state.failure !== null && attemptId === state.failure.attemptId) return state.failedAttempt;
        return null;
    };
    const recorder = Object.freeze({
        enable() { try { state.enabled = true; } catch (_) {} },
        mark(checkpoint) {
            try {
                const previous = state.checkpoint;
                if (state.enabled && checkpoints.has(checkpoint)) state.checkpoint = checkpoint;
                return previous;
            } catch (_) { return 'unknown'; }
        },
        current() { try { return state.checkpoint; } catch (_) { return 'unknown'; } },
        beginAttempt() {
            try {
                if (state.enabled && state.attemptId < Number.MAX_SAFE_INTEGER) {
                    state.attemptId++;
                    state.attempt = { outcome: 'not_started', commitUncertain: false };
                }
                return state.attemptId;
            } catch (_) { return 0; }
        },
        currentAttempt() { try { return state.attemptId; } catch (_) { return 0; } },
        control(kind, attemptId) {
            try {
                if (!state.enabled) return;
                const attempt = attemptFor(attemptId);
                if (!attempt) return;
                // Any acknowledged commit belongs to this invocation, even if
                // recovery later fails. Keep the first checkpoint/family, but
                // never describe an invocation with a known commit as rolled back.
                if (kind === 'commit_ok') state.knownCommit = true;
                if (attempt.outcome === 'committed') return;
                switch (kind) {
                    case 'begin_sent':
                    case 'begin_ok':
                    case 'commit_sent':
                        attempt.outcome = 'unknown'; break;
                    case 'commit_failed':
                        attempt.commitUncertain = true;
                        attempt.outcome = 'unknown'; break;
                    case 'commit_ok':
                        attempt.outcome = 'committed'; break;
                    case 'rollback_ok':
                        attempt.outcome = attempt.commitUncertain ? 'unknown' : 'rolled_back'; break;
                    case 'rollback_failed':
                        attempt.outcome = 'unknown'; break;
                    default: break;
                }
            } catch (_) {}
        },
        acknowledge(kind, result, attemptId) {
            try {
                if (!state.enabled) return;
                const command = commandTag(result);
                if (kind === 'COMMIT' || kind === 'commit') {
                    // A resolved COMMIT may actually acknowledge ROLLBACK.
                    // Promise fulfillment alone does not establish a commit.
                    recorder.control(command === 'commit' ? 'commit_ok' :
                        command === 'rollback' ? 'rollback_ok' : 'commit_failed', attemptId);
                } else if (kind === 'ROLLBACK' || kind === 'rollback') {
                    recorder.control(command === 'rollback' ? 'rollback_ok' : 'rollback_failed', attemptId);
                }
            } catch (_) {}
        },
        fail(error, checkpoint, attemptId) {
            try {
                if (!state.enabled || state.failure !== null) return;
                const attempt = attemptFor(attemptId);
                state.failure = {
                    checkpoint: checkpoints.has(checkpoint) ? checkpoint : state.checkpoint,
                    sqlStateFamily: sqlStateFamily(error),
                    attemptId: attempt ? attemptId === undefined ? state.attemptId : attemptId : -1
                };
                // Keep only the current attempt and the first failed attempt.
                // Recovery cannot rewrite this attempt's outcome; a known
                // commit anywhere still overrides it at snapshot disclosure.
                state.failedAttempt = attempt || { outcome: 'unknown', commitUncertain: false };
            } catch (_) {}
        },
        snapshot() { try { return ownedSnapshot(state); } catch (_) { return null; } }
    });
    recorders.set(recorder, state);
    return recorder;
}

function attachPreparationDiagnostic(error, recorder) {
    try {
        if (!objectKey(error) || !objectKey(recorder)) return error;
        const state = recorders.get(recorder);
        if (!state) return error;
        const value = ownedSnapshot(state);
        if (value !== null) carriers.set(error, value);
    } catch (_) {}
    return error;
}

function readPreparationDiagnostic(error) {
    try {
        if (!objectKey(error)) return null;
        const value = carriers.get(error);
        return value && snapshots.has(value) ? value : null;
    } catch (_) { return null; }
}

function queryCheckpoint(sql) {
    try {
        if (typeof sql !== 'string' || sql.length > 16384) return null;
        if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') return 'transaction_begin';
        if (sql === 'COMMIT') return 'transaction_commit';
        if (sql === 'ROLLBACK') return 'transaction_rollback';
        if (sql === 'SET LOCAL statement_timeout = 0' ||
            sql === "SELECT set_config('statement_timeout', $1, true)") return 'transaction_timeout';
        if (sql === 'SET LOCAL ROLE nofries_runtime' ||
            sql.startsWith("SELECT set_config('nofries.runtime_instance_id', $1, true)") ||
            sql === "SELECT set_config('nofries.tenant_id', $1, true)" ||
            sql === "SELECT set_config('nofries.tenant_id', $1, true), set_config('nofries.organisation_id', $2, true)") return 'database_context';
        if (sql === 'SELECT pg_advisory_xact_lock($1::integer, hashtext($2))' ||
            sql === 'SELECT pg_advisory_xact_lock_shared($1::integer, hashtext($2))') return 'instance_fence';
        if (sql === 'SELECT instance_id, revision, restore_epoch, ingress_status, changed_at, evidence_ref, evidence_sha256, record_sha256, head_receipt_id FROM nofries.dashboard_runtime_instance WHERE instance_id = $1') return 'instance_read';
        if (sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts (')) return 'starter_account_insert';
        if (sql.startsWith('SELECT account_id,email_sha256,subject_key,account_type,activated_at FROM nofries.dashboard_starter_accounts ')) return 'starter_account_lock';
        if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes ')) return 'starter_scope_read';
        if (sql.startsWith('INSERT INTO nofries.dashboard_starter_scopes (')) return 'starter_scope_insert';
        if (sql === 'SELECT * FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR UPDATE' ||
            sql === 'SELECT * FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR SHARE') return 'bootstrap_tenant_read';
        if (sql.startsWith('INSERT INTO nofries.dashboard_tenants (')) return 'bootstrap_tenant_insert';
        if (sql.startsWith('SELECT * FROM nofries.dashboard_operation_receipts WHERE ')) return 'bootstrap_receipt_read';
        if (sql.startsWith('INSERT INTO nofries.dashboard_operation_receipts (')) return 'bootstrap_receipt_write';
        if (/^SELECT \* FROM nofries\.(?:dashboard_organisations|dashboard_membership_states|dashboard_entitlement_states|dashboard_feature_flags|dashboard_advisor_assignments|dashboard_usage) WHERE /.test(sql)) return 'bootstrap_child_read';
        if (/^INSERT INTO nofries\.(?:dashboard_organisations|dashboard_membership_states|dashboard_entitlement_states|dashboard_feature_flags|dashboard_advisor_assignments|dashboard_usage) \(/.test(sql) ||
            /^UPDATE nofries\.(?:dashboard_organisations|dashboard_membership_states|dashboard_entitlement_states|dashboard_feature_flags|dashboard_advisor_assignments|dashboard_usage) SET /.test(sql)) return 'bootstrap_child_write';
        return null;
    } catch (_) { return null; }
}

module.exports = Object.freeze({ createPreparationDiagnostic, attachPreparationDiagnostic,
    readPreparationDiagnostic, queryCheckpoint, CHECKPOINTS, SQL_STATE_FAMILIES, TRANSACTION_OUTCOMES });
