'use strict';

// Staff notification for a newly stored dashboard contact request (#409). One
// plain-text email to the enquiry mailbox, sent through the website enquiry
// delivery settings and charged against the shared enquiry email budget. It
// carries the organisation display name, the topic label and the NZ date only:
// no assessment content, no customer email address and no request free text.
// Every outcome is logged as a code; nothing here can reject to the caller.

const registry = require('./protectedAssets/dashboardRegistry');
const { deliveryConfig } = require('./enquiry');
const { createEnquiryRateLimiter, isEnquiryRateLimitConfigured } = require('./enquiryRateLimit');
const { createResendClient } = require('./lifecycleEmail/resendClient');

const TOPIC_LABELS = Object.freeze(Object.fromEntries([['results', 'Results'],
    ...registry.services.map(service => [service.key, service.label])]));
const ADMIN_LINE = 'Open the No Fries dashboard admin to see the request and who to contact.';
const NAME_NOTE = 'The organisation name is as the customer entered it.';
const NAME_LIMIT = 180;

function isContactRequestEmailEnabled(env) {
    return env.NOFRIES_CONTACT_REQUEST_EMAIL_ENABLED === 'true';
}

// Control characters (C0, DEL, C1 including NEL) and line/paragraph separators
// become spaces; Unicode format characters (bidi overrides, zero-width) are
// removed, so the customer-supplied name cannot reorder or hide text.
function singleLine(value, limit) {
    return String(typeof value === 'string' ? value : '').replace(/\p{Cf}+/gu, '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function nzDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('contact_request_email_date_invalid');
    return new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function contactRequestEmailText(notice) {
    const topic = TOPIC_LABELS[notice && notice.topic];
    if (!topic) throw new Error('contact_request_email_topic_invalid');
    return [
        'A dashboard customer asked No Fries to contact them.',
        '',
        `Organisation: ${singleLine(notice.organisationName, NAME_LIMIT) || '(no display name)'}`,
        NAME_NOTE,
        `Topic: ${topic}`,
        `Requested: ${nzDate(notice.requestedAt)}`,
        '',
        ADMIN_LINE
    ].join('\n');
}

function defaultLog(code) {
    console.info(JSON.stringify({ event: 'contact_request_email', code }));
}

function createContactRequestNotifier({ env = process.env, fetchImpl = (...args) => fetch(...args),
    rateLimiter, log = defaultLog } = {}) {
    let limiter = rateLimiter;
    async function send(notice) {
        if (!isContactRequestEmailEnabled(env)) return 'contact_request_email_disabled';
        let text;
        try { text = contactRequestEmailText(notice); } catch (_) { return 'contact_request_email_invalid'; }
        const config = deliveryConfig(env);
        // Only once enquiry delivery has been verified (docs/enquiry-activation.md).
        if (!config || !isEnquiryRateLimitConfigured(env) || env.NOFRIES_ENQUIRY_DELIVERY_VERIFIED !== 'true') return 'contact_request_email_unavailable';
        let reservation;
        try {
            limiter ||= createEnquiryRateLimiter({ env });
            reservation = await limiter.reserve();
            if (!reservation || typeof reservation.allowed !== 'boolean') throw new Error();
        } catch (_) { return 'contact_request_email_rate_limit_unavailable'; }
        if (!reservation.allowed) return 'contact_request_email_rate_limited';
        try {
            const response = await createResendClient({ apiKey: config.apiKey, fetchImpl }).send({
                from: config.from, to: config.to, subject: 'Dashboard contact request', text });
            return response && response.ok ? 'contact_request_email_sent' : 'contact_request_email_send_failed';
        } catch (_) { return 'contact_request_email_send_failed'; }
    }
    return async function notifyContactRequest(notice) {
        let code;
        try { code = await send(notice); } catch (_) { code = 'contact_request_email_failed'; }
        try { log(code); } catch (_) { /* logging never fails the caller */ }
        return code;
    };
}

module.exports = { createContactRequestNotifier, contactRequestEmailText, isContactRequestEmailEnabled, TOPIC_LABELS, ADMIN_LINE, NAME_NOTE };
