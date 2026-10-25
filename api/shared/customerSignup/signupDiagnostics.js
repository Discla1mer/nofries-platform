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
            const event = preparation ? Object.freeze({ ...base, preparation }) : base;
            // Diagnostics are best effort: a synchronous throw or asynchronous
            // rejection must never change authentication or admission results.
            Promise.resolve(sink(event)).catch(() => {});
        } catch (_) { /* Keep the existing application result even if logging fails. */ }
    };
}

module.exports = Object.freeze({ createSignupDiagnostics });
