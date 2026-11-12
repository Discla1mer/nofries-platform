'use strict';

// The single Resend call shared by website enquiries and lifecycle email. Plain
// text only, so no content is ever interpreted as HTML. Callers map errors.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10000;

function createResendClient({ apiKey, fetchImpl = (...args) => fetch(...args) } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('resend_configuration_invalid');
    async function send({ from, to, subject, text, replyTo, idempotencyKey }) {
        const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        return fetchImpl(RESEND_ENDPOINT, {
            method: 'POST',
            signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
            headers,
            body: JSON.stringify({ from, to: [to], ...(replyTo ? { reply_to: replyTo } : {}), subject, text })
        });
    }
    return Object.freeze({ send });
}

module.exports = { createResendClient, RESEND_ENDPOINT, RESEND_TIMEOUT_MS };
