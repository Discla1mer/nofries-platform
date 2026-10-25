'use strict';

// Existing tenant members cannot receive a B2B guest invitation. Deliver the
// same mailbox capability through the already configured signup mail service.
function createStarterInvitationEmail({ env, fetch: send = globalThis.fetch }) {
    return async function sendMemberInvitation({ email, redirectUrl }) {
        if (!env.RESEND_API_KEY || !env.NOFRIES_SCOPE_EMAIL_FROM) throw new Error('setup_delivery_unconfirmed');
        const url = new URL(redirectUrl);
        if (url.origin !== env.NOFRIES_PUBLIC_URL || url.pathname !== '/signup' || url.search ||
            url.username || url.password || !/^#invitation=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error('setup_delivery_unconfirmed');
        const response = await send('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: env.NOFRIES_SCOPE_EMAIL_FROM, to: [email],
                subject: 'Continue your No Fries account setup',
                text: 'Continue the No Fries signup you requested:\n\n' + url.href +
                    '\n\nSign in with the existing Microsoft account associated with this email address and complete MFA. ' +
                    'You will review the terms before activating your dashboard. No subscription or account access has been activated. ' +
                    'If you did not request this, ignore this email. Do not forward this link.' }) });
        if (!response.ok) throw new Error('setup_delivery_unconfirmed');
    };
}
module.exports = { createStarterInvitationEmail };
