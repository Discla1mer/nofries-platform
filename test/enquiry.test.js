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
        const service = createEnquiryService({ env: ENV, rateLimiter: { reserve: async () => ({ allowed: true }) }, fetchImpl, now: () => new Date('2026-11-02T00:00:00Z') });
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
        await createEnquiryService({ env: { ...ENV, NOFRIES_ENQUIRY_TO: 'sales@example.invalid' }, rateLimiter: { reserve: async () => ({ allowed: true }) }, fetchImpl }).submitEnquiry(VALID);
        expect(calls[0].body.to).toEqual(['sales@example.invalid']);
    });

    test('a filled honeypot reports success without sending', async () => {
        const { fetchImpl } = stubFetch();
        const service = createEnquiryService({ env: ENV, rateLimiter: { reserve: async () => ({ allowed: true }) }, fetchImpl });
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
        const service = createEnquiryService({ env: ENV, rateLimiter: { reserve: async () => ({ allowed: true }) }, fetchImpl });
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

describe('contact form progressive enhancement', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const html = fs.readFileSync(path.join(__dirname, '../contact.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../js/contact.js'), 'utf8');

    test('without JavaScript, submission stays disabled and native submission uses POST', () => {
        expect(html).toMatch(/<form\b[^>]*id="contact-form"[^>]*method="post"/);
        expect(html).toMatch(/<button\b[^>]*id="contact-send"[^>]*type="submit"[^>]*\bdisabled/);
        expect(html).toMatch(/<noscript>[\s\S]*mailto:hello@nofries.nz[\s\S]*<\/noscript>/);
    });

    test('contact home link matches the managed IT accessible name and fields use cream paper', () => {
        expect(html).toMatch(/aria-label="No Fries Managed IT home"/);
        expect(html).toMatch(/<strong>No Fries<\/strong> <span>Managed IT<\/span>/);
        expect(html).not.toMatch(/<strong>No Fries<\/strong><span>Managed IT<\/span>/);
        const css = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');
        const fields = css.match(/\.contact-form input, \.contact-form textarea \{[^}]+\}/);
        expect(fields).not.toBeNull();
        expect(fields[0]).toContain('color: var(--ink)');
        expect(fields[0]).toContain('background: var(--paper)');
        expect(fields[0]).not.toContain('#0a1312');
    });

    function browser(attachFails = false, response, availability = async () => ({ available: true })) {
        const send = { disabled: true };
        const status = { textContent: '' };
        const notice = { hidden: true };
        const values = { ...VALID, website: '' };
        const fetchImpl = jest.fn(async () => response);
        const plausible = jest.fn();
        let submit;
        const form = {
            reportValidity: jest.fn(() => false),
            reset: jest.fn(() => Object.keys(values).forEach(field => { values[field] = ''; })),
            addEventListener(type, handler) {
                expect(send.disabled).toBe(true);
                if (attachFails) throw new Error('Handler unavailable');
                if (type === 'submit') submit = handler;
            }
        };
        const document = {
            body: { dataset: { page: 'contact' } },
            getElementById: id => ({ 'contact-form': form, 'contact-send': send, 'contact-status': status, 'contact-unavailable': notice })[id]
        };
        class FormData {
            constructor(target) { expect(target).toBe(form); }
            get(field) { return values[field]; }
        }
        return {
            send, status, notice, form, values, fetchImpl, plausible,
            run: () => vm.runInNewContext(script, { document, FormData, fetch: fetchImpl, window: { plausible, enquiryAvailability: availability } }),
            submit: () => submit
        };
    }

    test.each(['unconfigured', 'unreachable', 'missing client'])('keeps the form disabled and offers email when %s', async mode => {
        const availability = mode === 'unconfigured' ? async () => ({ available: false }) :
            mode === 'unreachable' ? async () => { throw Error('unavailable'); } : null;
        const page = browser(false, undefined, availability);
        await page.run();
        expect(page.send.disabled).toBe(true);
        expect(page.status.textContent).toContain('Please email hello@nofries.nz');
        expect(page.notice.hidden).toBe(false);
        const event = { preventDefault: jest.fn() };
        await page.submit()(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(page.fetchImpl).not.toHaveBeenCalled();
        expect(page.form.reset).not.toHaveBeenCalled();
    });

    test('enables submission only after attaching a handler that cancels native navigation', async () => {
        const page = browser();
        await page.run();
        expect(page.notice.hidden).toBe(true);
        expect(page.send.disabled).toBe(false);
        const event = { preventDefault: jest.fn() };
        await page.submit()(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    test('a second submit while availability is still being checked does not send a second enquiry', async () => {
        let resolveAvailability;
        const pending = new Promise(resolve => { resolveAvailability = resolve; });
        const response = { ok: true, json: async () => ({ received: true }) };
        const page = browser(false, response, () => pending);
        page.form.reportValidity.mockImplementation(() => true);
        const running = page.run();
        expect(page.send.disabled).toBe(false);
        const first = page.submit()({ preventDefault: jest.fn() });
        expect(page.send.disabled).toBe(true);
        const second = page.submit()({ preventDefault: jest.fn() });
        resolveAvailability({ available: true });
        await Promise.all([running, first, second]);
        expect(page.fetchImpl).toHaveBeenCalledTimes(1);
        expect(page.send.disabled).toBe(false);
        expect(page.status.textContent).toContain('your enquiry has been sent');
    });

    test('leaves submission disabled when handler attachment fails', async () => {
        const page = browser(true);
        await expect(page.run()).rejects.toThrow('Handler unavailable');
        expect(page.send.disabled).toBe(true);
    });

    test('cancels native navigation before validation can fail', async () => {
        const page = browser();
        const event = { preventDefault: jest.fn() };
        page.form.reportValidity.mockImplementation(() => {
            expect(event.preventDefault).toHaveBeenCalledTimes(1);
            throw new Error('Validation unavailable');
        });
        await page.run();
        await expect(page.submit()(event)).rejects.toThrow('Validation unavailable');
        expect(page.fetchImpl).not.toHaveBeenCalled();
        expect(page.form.reset).not.toHaveBeenCalled();
        expect(page.values).toEqual({ ...VALID, website: '' });
    });

    test('no submit control can override the POST fallback with GET', () => {
        const form = html.match(/<form\b[^>]*id="contact-form"[\s\S]*?<\/form>/)[0];
        expect(form).not.toMatch(/\bformmethod\s*=/i);
        expect(form).not.toMatch(/\bformaction\s*=/i);
    });

    test.each([
        ['HTML instead of JSON', '<!doctype html><title>Contact</title>'],
        ['malformed JSON', '{"received":'],
        ['empty body', ''],
        ['null JSON', 'null'],
        ['missing confirmation', '{}'],
        ['false confirmation', '{"received":false}'],
        ['string confirmation', '{"received":"true"}'],
        ['numeric confirmation', '{"received":1}']
    ])('retains the enquiry and reports uncertainty for HTTP 200 with %s', async (_label, body) => {
        const page = browser(false, new Response(body, { status: 200 }));
        await page.run();
        page.form.reportValidity.mockReturnValue(true);
        await page.submit()({ preventDefault: jest.fn() });
        expect(page.status.textContent).toBe('We could not confirm your enquiry was sent. Please email hello@nofries.nz instead.');
        expect(page.form.reset).not.toHaveBeenCalled();
        expect(page.values).toEqual({ ...VALID, website: '' });
        expect(page.plausible).not.toHaveBeenCalled();
        expect(page.send.disabled).toBe(false);
    });

    test('clears the enquiry and reports success only after the API confirms receipt', async () => {
        const page = browser(false, Response.json({ received: true }));
        await page.run();
        page.form.reportValidity.mockReturnValue(true);
        await page.submit()({ preventDefault: jest.fn() });
        expect(page.fetchImpl).toHaveBeenCalledTimes(1);
        expect(page.fetchImpl).toHaveBeenCalledWith('/api/enquiry', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ ...VALID, website: '' })
        });
        expect(page.form.reset).toHaveBeenCalledTimes(1);
        expect(Object.values(page.values).every(value => value === '')).toBe(true);
        expect(page.status.textContent).toBe('Thanks — your enquiry has been sent. We will reply by email.');
        expect(page.plausible).toHaveBeenCalledTimes(1);
        expect(page.plausible).toHaveBeenCalledWith('Enquiry Sent');
        expect(page.send.disabled).toBe(false);
    });

    test.each([429, 503])('retains the enquiry and shows HTTP %s errors even when the response claims receipt', async (status) => {
        const error = 'The enquiry form is not available right now. Please email hello@nofries.nz.';
        const page = browser(false, Response.json({ received: true, error }, { status }));
        await page.run();
        page.form.reportValidity.mockReturnValue(true);
        await page.submit()({ preventDefault: jest.fn() });
        expect(page.status.textContent).toBe(error);
        expect(page.form.reset).not.toHaveBeenCalled();
        expect(page.values).toEqual({ ...VALID, website: '' });
        expect(page.plausible).not.toHaveBeenCalled();
        expect(page.send.disabled).toBe(false);
    });

    test('retains the enquiry and reports uncertainty after a network failure', async () => {
        const page = browser();
        page.fetchImpl.mockRejectedValue(new Error('Network unavailable'));
        await page.run();
        page.form.reportValidity.mockReturnValue(true);
        await page.submit()({ preventDefault: jest.fn() });
        expect(page.status.textContent).toBe('We could not confirm your enquiry was sent. Please email hello@nofries.nz instead.');
        expect(page.form.reset).not.toHaveBeenCalled();
        expect(page.values).toEqual({ ...VALID, website: '' });
        expect(page.plausible).not.toHaveBeenCalled();
        expect(page.send.disabled).toBe(false);
    });
});
