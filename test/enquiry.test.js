'use strict';

const { createEnquiryService, validateEnquiry, EnquiryError } = require('../api/shared/enquiry');
const { createEnquiryFunction } = require('../api/enquiry');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const VALID = Object.freeze({
    name: 'Aroha Smith',
    email: 'Aroha@Example.co.nz',
    organisation: 'Harbourview Logistics',
    message: 'We need a cyber gap assessment before our insurance renewal.'
});
const ENV = Object.freeze({ RESEND_API_KEY: 'test-key', NOFRIES_ENQUIRY_EMAIL_FROM: 'No Fries <web@example.invalid>' });

function stubFetch(ok = true) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return { ok, status: ok ? 200 : 500 };
    });
    return { calls, fetchImpl };
}

describe('enquiry validation', () => {
    test('normalises a valid enquiry', () => {
        expect(validateEnquiry(VALID)).toEqual({
            name: 'Aroha Smith',
            email: 'aroha@example.co.nz',
            organisation: 'Harbourview Logistics',
            message: VALID.message
        });
    });

    test.each([
        ['missing name', { name: '' }],
        ['long name', { name: 'x'.repeat(121) }],
        ['bad email', { email: 'not-an-email' }],
        ['header injection in email', { email: 'a@example.com\nBcc: b@example.com' }],
        ['long organisation', { organisation: 'x'.repeat(161) }],
        ['short message', { message: 'hi' }],
        ['long message', { message: 'x'.repeat(4001) }]
    ])('rejects %s', (_label, override) => {
        expect(() => validateEnquiry({ ...VALID, ...override })).toThrow(EnquiryError);
    });

    test('flattens control characters out of single-line fields', () => {
        expect(validateEnquiry({ ...VALID, name: 'Aroha\r\nSubject: spam' }).name).toBe('Aroha Subject: spam');
    });
});

describe('enquiry delivery', () => {
    test('emails the owner as plain text with the sender as reply-to', async () => {
        const { calls, fetchImpl } = stubFetch();
        const service = createEnquiryService({ env: ENV, fetchImpl, now: () => new Date('2026-11-02T00:00:00Z') });
        await expect(service.submitEnquiry(VALID)).resolves.toEqual({ received: true });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.resend.com/emails');
        expect(calls[0].options.headers.Authorization).toBe('Bearer test-key');
        expect(calls[0].body).toMatchObject({
            from: ENV.NOFRIES_ENQUIRY_EMAIL_FROM,
            to: ['hello@nofries.nz'],
            reply_to: 'aroha@example.co.nz',
            subject: 'Website enquiry from Aroha Smith'
        });
        expect(calls[0].body.html).toBeUndefined();
        expect(calls[0].body.text).toContain('Organisation: Harbourview Logistics');
        expect(calls[0].body.text).toContain(VALID.message);
    });

    test('honours a configured recipient', async () => {
        const { calls, fetchImpl } = stubFetch();
        await createEnquiryService({ env: { ...ENV, NOFRIES_ENQUIRY_TO: 'sales@example.invalid' }, fetchImpl }).submitEnquiry(VALID);
        expect(calls[0].body.to).toEqual(['sales@example.invalid']);
    });

    test('a filled honeypot reports success without sending', async () => {
        const { fetchImpl } = stubFetch();
        const service = createEnquiryService({ env: ENV, fetchImpl });
        await expect(service.submitEnquiry({ ...VALID, website: 'https://spam.example' })).resolves.toEqual({ received: true });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('unconfigured delivery is unavailable and sends nothing', async () => {
        const { fetchImpl } = stubFetch();
        const service = createEnquiryService({ env: {}, fetchImpl });
        await expect(service.submitEnquiry(VALID)).rejects.toMatchObject({ code: 'enquiry_unavailable', status: 503 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('a provider failure is reported without detail', async () => {
        const { fetchImpl } = stubFetch(false);
        const service = createEnquiryService({ env: ENV, fetchImpl });
        await expect(service.submitEnquiry(VALID)).rejects.toMatchObject({ code: 'enquiry_send_failed', status: 502 });
    });
});

describe('enquiry function', () => {
    beforeEach(() => resetAbuseProtectionForTests());

    function request(body, headers = {}) {
        return { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '192.0.2.80', ...headers }, body };
    }

    test('accepts a same-origin enquiry', async () => {
        const service = { submitEnquiry: jest.fn(async () => ({ received: true })) };
        const context = { log: { error: jest.fn(), warn: jest.fn() } };
        await createEnquiryFunction(service)(context, request(VALID));
        expect(context.res.status).toBe(200);
        expect(context.res.body).toEqual({ received: true });
        expect(service.submitEnquiry).toHaveBeenCalledWith(VALID);
    });

    test('rejects cross-site posts before sending', async () => {
        const service = { submitEnquiry: jest.fn() };
        const context = {};
        await createEnquiryFunction(service)(context, request(VALID, { 'sec-fetch-site': 'cross-site' }));
        expect(context.res.status).toBe(403);
        expect(service.submitEnquiry).not.toHaveBeenCalled();
    });

    test('rate limits repeated enquiries from one client', async () => {
        const service = { submitEnquiry: jest.fn(async () => ({ received: true })) };
        const handler = createEnquiryFunction(service);
        const statuses = [];
        for (let i = 0; i < 6; i += 1) {
            const context = {};
            await handler(context, request(VALID));
            statuses.push(context.res.status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
        expect(service.submitEnquiry).toHaveBeenCalledTimes(5);
    });

    test('returns the public message for validation errors', async () => {
        const service = createEnquiryService({ env: ENV, fetchImpl: jest.fn() });
        const context = {};
        await createEnquiryFunction(service)(context, request({ ...VALID, email: 'nope' }));
        expect(context.res.status).toBe(400);
        expect(context.res.body).toEqual({ error: 'Please enter a valid email address.', code: 'invalid_enquiry' });
    });
});
