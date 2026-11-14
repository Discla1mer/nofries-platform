'use strict';

// #151 F3: code_confirmed, submitted and enquiry_sent are counted by their own
// server handlers, best-effort and after the business response is final.
const mockCounted = [];
jest.mock('../api/shared/enquiry', () => {
    const actual = jest.requireActual('../api/shared/enquiry');
    return { ...actual, createEnquiryService: () => ({ availability: () => ({ available: true, promote: false }),
        submitEnquiry: async input => { if (input.fail) throw new actual.EnquiryError('enquiry_send_failed', 502, 'Not sent.'); return { received: true }; } }) };
});
jest.mock('../api/shared/funnelCounts', () => {
    const actual = jest.requireActual('../api/shared/funnelCounts');
    return { ...actual, createServerFunnelCounter: () => event => mockCounted.push(event) };
});

const request = require('supertest');
const { SERVER_FUNNEL_EVENTS, FUNNEL_EVENTS, createServerFunnelCounter, isAssessmentSubmit } = jest.requireActual('../api/shared/funnelCounts');
const { isHoneypotEnquiry } = require('../api/shared/enquiry');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

process.env.NOFRIES_REQUIRE_AUTH = 'false';
const ON = { NOFRIES_FUNNEL_COUNTS_ENABLED: 'true' };
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => { mockCounted.length = 0; resetAbuseProtectionForTests(); });

describe('createServerFunnelCounter', () => {
    test('counts only the three server-side events, never the browser ones', () => {
        expect(SERVER_FUNNEL_EVENTS).toEqual(['code_confirmed', 'submitted', 'enquiry_sent']);
        expect(SERVER_FUNNEL_EVENTS.every(event => FUNNEL_EVENTS.includes(event))).toBe(true);
    });

    test('flag off or no writer means no write at all', async () => {
        const record = jest.fn(async () => {});
        for (const env of [{}, { NOFRIES_FUNNEL_COUNTS_ENABLED: 'TRUE' }, { NOFRIES_FUNNEL_COUNTS_ENABLED: 'false' }]) {
            createServerFunnelCounter({ env, record })('submitted');
        }
        createServerFunnelCounter({ env: ON, record: null })('submitted');
        await flush();
        expect(record).not.toHaveBeenCalled();
    });

    test('flag on writes the NZ day once per call and returns before the write finishes', async () => {
        let finish;
        const record = jest.fn(() => new Promise(resolve => { finish = resolve; }));
        const count = createServerFunnelCounter({ env: ON, record, now: () => new Date('2026-11-12T11:30:00Z') });
        expect(count('enquiry_sent')).toBeUndefined();
        await flush();
        expect(record).toHaveBeenCalledWith('enquiry_sent', '2026-11-13');
        finish();
        for (const event of ['visit', 'first_answer', 'result_viewed', 'signup_started', 'nope']) count(event);
        await flush();
        expect(record).toHaveBeenCalledTimes(1);
    });

    test('the flag is read on every call', async () => {
        const env = {}, record = jest.fn(async () => {});
        const count = createServerFunnelCounter({ env, record });
        count('submitted');
        env.NOFRIES_FUNNEL_COUNTS_ENABLED = 'true';
        count('submitted');
        await flush();
        expect(record).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['rejects', () => Promise.reject(new Error('connection from 203.0.113.9 failed'))],
        ['throws synchronously', () => { throw new Error('pool exhausted for 203.0.113.9'); }]
    ])('a write that %s logs one fixed tag and never throws', async (_name, impl) => {
        const lines = [];
        const log = { warn: (...args) => lines.push(args.join(' ')) };
        expect(() => createServerFunnelCounter({ env: ON, record: jest.fn(impl), log })('code_confirmed')).not.toThrow();
        await flush();
        expect(lines).toEqual(['funnel_count_write_failed']);
    });

    test('a slow write gives up after the timeout with the fixed tag', async () => {
        jest.useFakeTimers();
        try {
            const log = { warn: jest.fn() };
            createServerFunnelCounter({ env: ON, record: () => new Promise(() => {}), log, timeoutMs: 50 })('submitted');
            await Promise.resolve();
            jest.advanceTimersByTime(60);
            await Promise.resolve(); await Promise.resolve();
            expect(log.warn).toHaveBeenCalledWith('funnel_count_write_failed');
        } finally { jest.useRealTimers(); }
    });

    test('a broken logger is swallowed too', async () => {
        const log = { warn: () => { throw new Error('log'); } };
        createServerFunnelCounter({ env: ON, record: async () => { throw new Error('x'); }, log })('submitted');
        await flush();
    });
});

test('isAssessmentSubmit matches only a successful submit', () => {
    const ok = { status: 200, body: { assessment: { status: 'submitted' } } };
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a-1/submit', ok)).toBe(true);
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a-1/save', ok)).toBe(false);
    expect(isAssessmentSubmit('GET', '/ncsc/assessments/a-1/submit', ok)).toBe(false);
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a/b/submit', ok)).toBe(false);
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a-1/submit', { ...ok, status: 503 })).toBe(false);
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a-1/submit', { status: 200, body: { assessment: { status: 'in-progress' } } })).toBe(false);
    expect(isAssessmentSubmit('POST', '/ncsc/assessments/a-1/submit', null)).toBe(false);
});

test('isHoneypotEnquiry flags only a filled website field', () => {
    expect(isHoneypotEnquiry({ website: 'https://bot.example' })).toBe(true);
    for (const input of [{}, { website: '' }, { website: '   ' }, null, undefined]) expect(isHoneypotEnquiry(input)).toBe(false);
});

describe('server wiring', () => {
    const { createNoFriesApp } = require('../server');
    const setupApp = result => createNoFriesApp({ organisationSetup: { handle: jest.fn(async () => result) } });
    const verify = app => request(app).post('/api/organisation-setup/verify').set('Sec-Fetch-Site', 'same-origin').send({ code: '12345678' });

    test('code_confirmed is counted only on the first verification and never reaches the response', async () => {
        const first = await verify(setupApp({ status: 200, body: { state: 'verified' }, codeVerified: true }));
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ state: 'verified' });
        expect(mockCounted).toEqual(['code_confirmed']);
        await verify(setupApp({ status: 200, body: { state: 'verified' } }));
        await verify(setupApp({ status: 400, body: { code: 'verification_code_invalid' } }));
        expect(mockCounted).toEqual(['code_confirmed']);
    });

    test('enquiry_sent is counted after a sent enquiry, not for bots or failures', async () => {
        const app = createNoFriesApp();
        const send = (body, ip) => request(app).post('/api/enquiry').set('Sec-Fetch-Site', 'same-origin').set('X-Forwarded-For', ip).send(body);
        const sent = await send({ name: 'A', email: 'a@example.invalid', message: 'Hello there' }, '192.0.2.31');
        expect(sent.status).toBe(200);
        expect(sent.body).toEqual({ received: true });
        expect(mockCounted).toEqual(['enquiry_sent']);
        expect((await send({ website: 'x' }, '192.0.2.32')).status).toBe(200);
        expect((await send({ fail: true }, '192.0.2.33')).status).toBe(502);
        expect(mockCounted).toEqual(['enquiry_sent']);
    });
});
