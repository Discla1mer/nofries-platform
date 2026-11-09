'use strict';
const { BrowserAuthError } = require('./browserAuth');
const { BrowserSessionStoreError } = require('./browserSessionStore');
// Fixed application codes only: error classes do not make provider text safe.
const FAILURE_CODES = new Set([
    'authentication_required', 'browser_auth_account_selection_invalid', 'browser_auth_allowed_subjects_invalid',
    'browser_auth_allowed_subjects_missing', 'browser_auth_audience_invalid', 'browser_auth_callback_invalid',
    'browser_auth_callback_purpose_ambiguous', 'browser_auth_callback_too_large', 'browser_auth_client_id_invalid',
    'browser_auth_client_secret_missing', 'browser_auth_code_exchange_failed', 'browser_auth_code_missing',
    'browser_auth_cookie_invalid', 'browser_auth_cookie_too_large', 'browser_auth_dashboard_unavailable',
    'browser_auth_dependency_missing', 'browser_auth_email_invalid', 'browser_auth_http_failure',
    'browser_auth_identity_invalid', 'browser_auth_issuer_invalid', 'browser_auth_nonce_invalid',
    'browser_auth_pkce_invalid', 'browser_auth_pkce_unavailable', 'browser_auth_provider_rejected',
    'browser_auth_provider_unavailable', 'browser_auth_provider_url_invalid', 'browser_auth_public_url_invalid',
    'browser_auth_random_unavailable', 'browser_auth_registration_invalid', 'browser_auth_return_path_invalid',
    'browser_auth_session_expired', 'browser_auth_session_invalid', 'browser_auth_session_provider_invalid',
    'browser_auth_session_purpose_invalid', 'browser_auth_session_revoked', 'browser_auth_session_tenant_invalid',
    'browser_auth_state_invalid', 'browser_auth_state_missing', 'browser_auth_store_configuration_invalid',
    'browser_auth_store_conflict', 'browser_auth_store_identifier_invalid', 'browser_auth_store_record_invalid',
    'browser_auth_store_unavailable', 'browser_auth_subject_missing', 'browser_auth_subject_not_allowed',
    'browser_auth_tenant_invalid', 'browser_auth_tenant_not_allowed', 'browser_auth_token_cache_cleanup_failed',
    'browser_auth_token_expired', 'browser_auth_transaction_expired', 'browser_auth_transaction_invalid',
    'browser_auth_transaction_missing', 'browser_auth_transaction_store_unavailable', 'method_not_allowed',
    'rate_limited', 'request_blocked',
]);
function logSafeFailure(context, error) {
    if (context?.staffAuthFailureLogged) return;
    if (context) context.staffAuthFailureLogged = true;
    let code = 'browser_auth_unexpected';
    try {
        const candidate = error instanceof BrowserAuthError || error instanceof BrowserSessionStoreError ? error.code : null;
        code = FAILURE_CODES.has(candidate) ? candidate : 'browser_auth_unexpected';
        if (code === 'browser_auth_dashboard_unavailable' && error.diagnosticStage === 'transaction_store') {
            code = 'browser_auth_transaction_store_unavailable';
        }
    } catch (_) { /* Untrusted exception accessors are not diagnostics. */ }
    try {
        const message = `Browser sign-in start failed: ${code}`;
        if (context?.log && typeof context.log.warn === 'function') {
            try { context.log.warn(message); return; } catch (_) { /* Try the host logger. */ }
        }
        console.warn(message);
    } catch (_) { /* Diagnostics cannot replace the original response. */ }
}
module.exports = { logSafeFailure };
