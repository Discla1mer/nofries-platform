'use strict';

// The single Resend call shared by website enquiries and lifecycle email. Plain
// text only, so no content is ever interpreted as HTML. Callers map errors.
// Optional extra message headers are limited to the RFC 8058 unsubscribe pair.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10000;
const MESSAGE_HEADERS = Object.freeze(['List-Unsubscribe', 'List-Unsubscribe-Post']);

function messageHeaders(headers) {
    if (!headers) return null;
    const entries = Object.entries(headers);
    if (!entries.length || entries.some(([name, value]) => !MESSAGE_HEADERS.includes(name) ||
        typeof value !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(value))) throw new Error('resend_headers_invalid');
    return Object.fromEntries(entries);
}

function createResendClient({ apiKey, fetchImpl = (...args) => fetch(...args) } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('resend_configuration_invalid');
    async function send({ from, to, subject, text, replyTo, idempotencyKey, headers: extra }) {
        const message = messageHeaders(extra);
        const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        return fetchImpl(RESEND_ENDPOINT, {
            method: 'POST',
            signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
            headers,
            body: JSON.stringify({ from, to: [to], ...(replyTo ? { reply_to: replyTo } : {}), subject, text,
                ...(message ? { headers: message } : {}) })
        });
    }
    return Object.freeze({ send });
}

module.exports = { createResendClient, RESEND_ENDPOINT, RESEND_TIMEOUT_MS };
