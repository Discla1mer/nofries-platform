'use strict';

// Public website enquiries. Each valid enquiry is emailed to the owner through
// the existing Resend integration and is not stored. Only plain text is sent, so
// submitted content is never interpreted as HTML by the receiving mail client.

const LIMITS = Object.freeze({ name: 120, email: 254, organisation: 160, message: 4000 });
const MIN_MESSAGE = 10;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

class EnquiryError extends Error {
    constructor(code, status, publicMessage) {
        super(code);
        this.code = code;
        this.status = status;
        this.publicMessage = publicMessage;
    }
}

function singleLine(value) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function multiLine(value) {
    return String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
        .trim();
}

function invalid(message) {
    return new EnquiryError('invalid_enquiry', 400, message);
}

function validateEnquiry(input = {}) {
    const name = singleLine(input.name);
    const email = singleLine(input.email).toLowerCase();
    const organisation = singleLine(input.organisation);
    const message = multiLine(input.message);
    if (!name || name.length > LIMITS.name) throw invalid('Please enter your name (up to 120 characters).');
    if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) throw invalid('Please enter a valid email address.');
    if (organisation.length > LIMITS.organisation) throw invalid('Organisation must be 160 characters or fewer.');
    if (message.length < MIN_MESSAGE || message.length > LIMITS.message) {
        throw invalid('Please enter a message between 10 and 4,000 characters.');
    }
    return { name, email, organisation, message };
}

function deliveryConfig(env) {
    const apiKey = String(env.RESEND_API_KEY || '').trim();
    const from = String(env.NOFRIES_ENQUIRY_EMAIL_FROM || env.NOFRIES_SCOPE_EMAIL_FROM || '').trim();
    const to = String(env.NOFRIES_ENQUIRY_TO || 'hello@nofries.nz').trim();
    return apiKey && from && to ? { apiKey, from, to } : null;
}

function createEnquiryService({ env = process.env, fetchImpl = (...args) => fetch(...args), now = () => new Date() } = {}) {
    async function submitEnquiry(input = {}) {
        // Honeypot: people never see the website field, so a filled value is a bot.
        // Report success without sending so the bot gets no signal.
        if (singleLine(input.website)) return { received: true };
        const enquiry = validateEnquiry(input);
        const config = deliveryConfig(env);
        if (!config) {
            throw new EnquiryError('enquiry_unavailable', 503, 'The enquiry form is not available right now. Please email hello@nofries.nz.');
        }
        const text = [
            'New enquiry from the No Fries website',
            '',
            `Name: ${enquiry.name}`,
            `Email: ${enquiry.email}`,
            `Organisation: ${enquiry.organisation || '(not given)'}`,
            `Received: ${now().toISOString()}`,
            '',
            enquiry.message
        ].join('\n');
        const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            signal: AbortSignal.timeout(10000),
            headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: config.from,
                to: [config.to],
                reply_to: enquiry.email,
                subject: `Website enquiry from ${enquiry.name.slice(0, 80)}`,
                text
            })
        });
        if (!response || !response.ok) {
            throw new EnquiryError('enquiry_send_failed', 502, 'Your enquiry could not be sent. Please email hello@nofries.nz.');
        }
        return { received: true };
    }
    function availability() {
        const available = Boolean(deliveryConfig(env));
        return { available, promote: available && env.NOFRIES_ENQUIRY_DELIVERY_VERIFIED === 'true' };
    }
    return { submitEnquiry, availability };
}

module.exports = { createEnquiryService, validateEnquiry, EnquiryError, LIMITS };
