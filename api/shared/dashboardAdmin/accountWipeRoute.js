'use strict';

// Request shape for staff account reset and delete. Served from the existing
// POST /api/dashboard-admin/accounts/lookup route as a body with the single
// key "wipe", so the Static Web Apps route table does not grow (#365). The
// lookup route has already checked the staff identity, admin role, native
// operator session, same origin and request budget before this runs.
const { createHash } = require('node:crypto');
const SESSION_COOKIE = '__Host-nofries-auth';
// A run that has started continues to the end of this budget even if the
// browser goes away, so a closed tab does not leave a needless partial. The
// handler waits for it (plus the outcome record) before replying; together
// they stay inside the edge's request timeout. A slower delete stops as a
// recorded 'partial' and is finished by approving and applying again.
const RUN_BUDGET_MS = 30000;
const STATUS = Object.freeze({ account_wipe_input_invalid: 400, account_wipe_confirmation_mismatch: 400,
    account_wipe_approval_invalid: 403, account_wipe_account_not_found: 404,
    account_wipe_audit_unavailable: 503, account_wipe_unavailable: 503 });
const invalid = () => { const error = new Error('account_wipe_input_invalid'); error.code = 'account_wipe_input_invalid'; throw error; };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Digest of the staff browser session cookie: the approval is bound to it, so
// a new sign-in (or another browser) cannot use an earlier approval.
function sessionDigest(cookieHeader) {
    const values = String(cookieHeader || '').split(';').map(part => part.trim())
        .filter(part => part.startsWith(SESSION_COOKIE + '=')).map(part => part.slice(SESSION_COOKIE.length + 1));
    if (values.length !== 1 || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{16,4096}$/.test(values[0])) return null;
    return createHash('sha256').update(SESSION_COOKIE + '\0' + values[0]).digest('hex');
}

function createAccountWipeRoute(executor) {
    if (typeof executor?.approve !== 'function' || typeof executor?.execute !== 'function') throw new Error('dashboard_admin_configuration_invalid');
    return async function wipe(input, actor, request, signal) {
        try {
            const sessionSha256 = sessionDigest(request?.headers?.cookie);
            if (!sessionSha256) { const error = new Error(); error.code = 'account_wipe_approval_invalid'; throw error; }
            let body;
            if (exact(input, ['step', 'action', 'email', 'confirmEmail', 'confirmWord']) && input.step === 'approve') {
                body = await executor.approve({ actor, sessionSha256, action: input.action, email: input.email,
                    confirmEmail: input.confirmEmail, confirmWord: input.confirmWord }, signal);
            } else if (exact(input, ['step', 'approvalId', 'email']) && input.step === 'execute') {
                // The deadline also bounds the database transaction from inside, so
                // nothing commits after the reply's budget (see accountWipeRepository).
                const deadline = Date.now() + RUN_BUDGET_MS;
                body = await executor.execute({ actor, sessionSha256, approvalId: input.approvalId, email: input.email, deadline }, AbortSignal.timeout(RUN_BUDGET_MS));
            } else invalid();
            return { status: 200, body };
        } catch (error) {
            const code = typeof error?.code === 'string' && /^account_wipe_[a-z_]+$/.test(error.code) ? error.code : 'account_wipe_unavailable';
            return { status: STATUS[code] || 409, body: { code } };
        }
    };
}

module.exports = { createAccountWipeRoute, sessionDigest, SESSION_COOKIE, RUN_BUDGET_MS };
