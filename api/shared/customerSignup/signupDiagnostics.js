'use strict';

const { isProxy } = require('node:util').types;
const { annotateSignupDiagnostic } = require('./signupSupportContext');
const { readPreparationDiagnostic } = require('./signupPreparationDiagnostic');

// This is a server-only vocabulary, not a projection of requests, records or
// provider errors. Neither error messages nor stack traces may reach the sink.
const CODES = new Set([
    'signup_state_unavailable', 'signup_continuation_unavailable',
    'signup_identity_required', 'signup_invitation_unavailable', 'signup_record_invalid',
    'signup_store_unavailable', 'signup_store_record_invalid', 'signup_store_identifier_invalid',
    'signup_acceptance_journal_unavailable', 'signup_acceptance_journal_record_invalid',
    'signup_acceptance_journal_conflict', 'signup_acceptance_receipt_invalid', 'signup_acceptance_reference_invalid',
    'signup_registration_unavailable', 'signup_registration_record_invalid', 'signup_registration_revoked',
    'signup_registration_not_found', 'signup_registration_conflict', 'signup_registration_changed',
    'signup_terms_unavailable', 'signup_request_invalid',
    'starter_store_unavailable', 'starter_details_store_unavailable', 'starter_details_locked',
    'starter_account_exists', 'starter_request_changed', 'external_starter_claim_reconciliation_required',
    'postgres_connection_failed', 'postgres_begin_failed', 'postgres_tenant_context_failed',
    'postgres_query_failed', 'postgres_commit_failed', 'postgres_rollback_failed',
    'onboarding_input_invalid', 'onboarding_record_invalid',
    'browser_auth_customer_required', 'browser_auth_customer_store_unavailable',
    'browser_auth_customer_mfa_required', 'browser_auth_customer_mfa_unavailable',
    'browser_auth_session_invalid', 'browser_auth_session_expired'
]);
const STAGES = new Set([
    'customer_session', 'organisation_preparation', 'signup_state', 'admission_projection',
    'setup_session', 'setup_retained_read', 'setup_save', 'setup_claim',
    'signup_context', 'signup_continuation', 'invitation_inspection', 'acceptance_journal',
    'registration', 'identity_recheck', 'registration_recheck', 'terms_offer', 'proof_recheck',
    'continuation_request', 'continuation_clock', 'continuation_session', 'continuation_registration',
    'continuation_recovery_reference', 'continuation_receipt', 'continuation_receipt_match',
    'continuation_session_recheck', 'continuation_reference_recheck', 'continuation_registration_recheck'
]);

// Server-only fixed vocabulary. Never retain error text, SQL or customer data.
const PHASES = Object.freeze(['passive_state', 'passive_starter', 'preparation_before', 'preparation_after']);
const CHECKPOINTS = Object.freeze([
    'unknown', 'account_match', 'retained_preparation', 'registration_layout',
    'owner_read', 'owner_match', 'scope_transaction', 'scope_context', 'scope_query',
    'scope_cardinality', 'preparation_decode', 'preparation_match', 'activation_decode',
    'binding_query', 'binding_decode', 'binding_match', 'snapshot_read', 'membership_read',
    'entitlement_read', 'admission_query', 'admission_decode', 'admission_match',
    'scope_transaction_completion', 'completion_receipt', 'completion_registration',
    'completion_match', 'completion_invitation', 'completion_recheck', 'scope_missing',
    'preparation_recheck', 'passive_journal', 'passive_registration', 'passive_binding',
    'passive_binding_match'
]);
const phases = new Set(PHASES), checkpoints = new Set(CHECKPOINTS);
const families = Object.freeze({
    '08': 'connection', '22': 'data_exception', '23': 'integrity_constraint',
    '25': 'transaction_state', '28': 'database_authorization',
    '40': 'transaction_rollback', '42': 'access_or_schema', '53': 'resource_limit',
    '55': 'object_state_or_lock', '57': 'operator_intervention', 'P0': 'trigger_or_procedure'
});
const carriers = new WeakMap();
const objectKey = value => value !== null && (typeof value === 'object' || typeof value === 'function') && !isProxy(value);
function sqlFamily(error) {
    try {
        if (!objectKey(error)) return null;
        const field = Object.getOwnPropertyDescriptor(error, 'code');
        if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' ||
            !/^[A-Z0-9]{5}$/.test(field.value)) return null;
        return families[field.value.slice(0, 2)] || null;
    } catch (_) { return null; }
}
function createSignupReadDiagnostic(phase) {
    let enabled = phases.has(phase), checkpoint = 'unknown', failure = null;
    const recorder = Object.freeze({
        mark(value) { if (enabled && checkpoints.has(value)) checkpoint = value; },
        suspend() { enabled = false; },
        resume(value) { if (phases.has(value)) { phase = value; checkpoint = 'unknown'; enabled = true; } },
        capture(error) {
            try {
                if (!enabled || failure !== null) return;
                const sqlStateFamily = sqlFamily(error);
                failure = Object.freeze({ phase, checkpoint, ...(sqlStateFamily ? { sqlStateFamily } : {}) });
            } catch (_) { /* Diagnostic failure cannot alter the operation. */ }
        },
        attach(error) {
            try {
                if (!enabled || !objectKey(error) || carriers.has(error)) return error;
                recorder.capture(error);
                if (failure !== null) carriers.set(error, failure);
            } catch (_) { /* Preserve the original error. */ }
            return error;
        }
    });
    return recorder;
}
function readSignupReadDiagnostic(error) {
    try { return objectKey(error) ? carriers.get(error) || null : null; }
    catch (_) { return null; }
}


function createSignupDiagnostics({ now = Date.now, sink = () => {} } = {}) {
    if (typeof now !== 'function' || isProxy(now) || typeof sink !== 'function' || isProxy(sink)) {
        throw new TypeError('signup_diagnostics_dependencies_required');
    }
    return function report(stage, error, fallback = 'signup_state_unavailable') {
        try {
            let code = CODES.has(fallback) ? fallback : 'signup_state_unavailable';
            if (error && typeof error === 'object' && !isProxy(error)) {
                const field = Object.getOwnPropertyDescriptor(error, 'code');
                if (field && Object.hasOwn(field, 'value') && CODES.has(field.value)) code = field.value;
            }
            const at = now();
            if (!Number.isSafeInteger(at) || at < 0) return;
            const base = annotateSignupDiagnostic(Object.freeze({ timestamp: new Date(at).toISOString(), code,
                stage: STAGES.has(stage) ? stage : 'signup_state' }));
            // Only an owned failed preparation result can carry this fixed,
            // server-only detail. Annotate the original event first so public
            // metadata and support-reference selection keep their exact contract.
            const preparation = readPreparationDiagnostic(error);
            const workspaceRead = readSignupReadDiagnostic(error);
            const event = preparation || workspaceRead ? Object.freeze({ ...base,
                ...(preparation ? { preparation } : {}), ...(workspaceRead ? { workspaceRead } : {}) }) : base;
            // Diagnostics are best effort: a synchronous throw or asynchronous
            // rejection must never change authentication or admission results.
            Promise.resolve(sink(event)).catch(() => {});
        } catch (_) { /* Keep the existing application result even if logging fails. */ }
    };
}

module.exports = Object.freeze({ createSignupDiagnostics, createSignupReadDiagnostic, readSignupReadDiagnostic, PHASES, CHECKPOINTS });

