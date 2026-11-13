'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createResendClient } = require('../api/shared/lifecycleEmail/resendClient');
const { TEMPLATES, PLACEHOLDERS, FOOTER, renderTemplate } = require('../api/shared/lifecycleEmail/templates');
const { TEMPLATE_VERSIONS } = require('../api/shared/lifecycleEmail/templateVersions');

test('website enquiries still send through the extracted Resend client', async () => {
    let created;
    await jest.isolateModulesAsync(async () => {
        const actual = jest.requireActual('../api/shared/lifecycleEmail/resendClient');
        created = jest.fn(actual.createResendClient);
        jest.doMock('../api/shared/lifecycleEmail/resendClient', () => ({ ...actual, createResendClient: created }));
        const { createEnquiryService } = require('../api/shared/enquiry');
        const fetchImpl = jest.fn(async () => ({ ok: true }));
        await createEnquiryService({ env: { RESEND_API_KEY: 'k', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' }, fetchImpl,
            rateLimiter: { reserve: async () => ({ allowed: true }) } }).submitEnquiry({ name: 'Aroha', email: 'aroha@example.invalid',
            message: 'We would like an assessment please.' });
        expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'k' }));
});

// Until #244 makes the outbox writer import templateVersions.js, fail if the
// versions it enqueues drift from the ones the sender can render.
test('the outbox writer and the templates use the same template versions', () => {
    const writer = path.join(__dirname, '../api/shared/lifecycleEmail/outboxWriter.js');
    const enqueued = fs.existsSync(writer) ? require(writer).TEMPLATE_VERSIONS : TEMPLATE_VERSIONS;
    expect(enqueued).toEqual(TEMPLATE_VERSIONS);
    for (const [type, version] of Object.entries(enqueued)) expect(() => renderTemplate(type, version,
        { signInUrl: 'https://nofries.nz/', unsubscribeUrl: 'https://nofries.nz/' })).not.toThrow();
});

describe('lifecycle email templates', () => {
    test('every template uses only the allowed placeholders and carries no name, result or score', () => {
        for (const [type, versions] of Object.entries(TEMPLATES)) {
            for (const [version, template] of Object.entries(versions)) {
                expect(version).toBe(TEMPLATE_VERSIONS[type]);
                const source = [template.subject, ...template.lines, ...FOOTER].join('\n');
                for (const [, name] of source.matchAll(/\{\{([^}]*)\}\}/g)) expect(PLACEHOLDERS).toContain(name);
                expect(source).not.toMatch(/assessmentId|gapCount|score|\{\{name/i);
                const text = renderTemplate(type, version, { signInUrl: 'https://nofries.nz/dashboard', unsubscribeUrl: 'https://nofries.nz/dashboard' }).text;
                expect(text).not.toMatch(/\{\{/);
                expect(text).toMatch(/^Kia ora,\n/);
                expect(text).toContain('unsubscribe: https://nofries.nz/dashboard');
                expect(text).not.toMatch(/<[a-z]/i);
            }
        }
        expect(Object.keys(TEMPLATES).sort()).toEqual(Object.keys(TEMPLATE_VERSIONS).sort());
        expect(() => renderTemplate('welcome', 'welcome-v9', { signInUrl: 'https://nofries.nz/', unsubscribeUrl: 'https://nofries.nz/' }))
            .toThrow('template_unknown');
        expect(() => renderTemplate('welcome', 'welcome-v1', { signInUrl: 'javascript:alert(1)', unsubscribeUrl: 'https://nofries.nz/' })).toThrow();
    });
});

test('the Resend client posts plain text with a 10 second timeout and the idempotency key', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true })), timeout = jest.spyOn(AbortSignal, 'timeout');
    await createResendClient({ apiKey: ' key ', fetchImpl }).send({ from: 'a@example.invalid', to: 'b@example.invalid', subject: 's', text: 't', idempotencyKey: 'id-1' });
    expect(timeout).toHaveBeenCalledWith(10000); timeout.mockRestore();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json', 'Idempotency-Key': 'id-1' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ from: 'a@example.invalid', to: ['b@example.invalid'], subject: 's', text: 't' });
});
