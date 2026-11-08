'use strict';

const { Readable } = require('node:stream');
const { createEnquiryRateLimiter, LIMIT, WINDOW_MS, TIMEOUT_MS } = require('../api/shared/enquiryRateLimit');
const { createEnquiryService } = require('../api/shared/enquiry');
const { createEnquiryFunction, errorResult } = require('../api/enquiry');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const INPUT = { name: 'Private Person', email: 'private@example.invalid', message: 'Private enquiry text for testing only.' };
const ENV = { RESEND_API_KEY: 'test-only', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' };
const START = Date.parse('2026-11-04T00:00:00Z');

function storage() {
    let body = JSON.stringify({ version: 1, lastObserved: 0, expires: [] }), revision = 0;
    const store = {
        at: START,
        client() {
            return {
                download: jest.fn(async () => ({ date: new Date(store.at), etag: `"${revision}"`, readableStreamBody: Readable.from([body]) })),
                upload: jest.fn(async (next, size, options) => {
                    expect(size).toBe(Buffer.byteLength(next));
                    if (options.conditions.ifMatch !== `"${revision}"`) throw Object.assign(new Error('conflict'), { statusCode: 412, code: 'ConditionNotMet' });
                    body = next; revision += 1;
                })
            };
        },
        body: () => body,
        replace: value => { body = value; }
    };
    return store;
}

beforeEach(() => resetAbuseProtectionForTests());

test('independent instances and reconstructed limiters share one rolling budget, with no PII', async () => {
    const store = storage();
    for (let i = 0; i < LIMIT; i += 1) {
        expect(await createEnquiryRateLimiter({ client: store.client() }).reserve()).toEqual({ allowed: true });
    }
    expect(await createEnquiryRateLimiter({ client: store.client() }).reserve()).toEqual({ allowed: false, retryAfter: 3606 });
    store.at += WINDOW_MS;
    expect((await createEnquiryRateLimiter({ client: store.client() }).reserve()).allowed).toBe(false);
    store.at += TIMEOUT_MS + 1000;
    expect((await createEnquiryRateLimiter({ client: store.client() }).reserve()).allowed).toBe(true);
    expect(Object.keys(JSON.parse(store.body()))).toEqual(['version', 'lastObserved', 'expires']);
});

test('racing writers cannot both spend the final permit', async () => {
    const store = storage();
    for (let i = 0; i < LIMIT - 1; i += 1) await createEnquiryRateLimiter({ client: store.client() }).reserve();
    const results = await Promise.all(Array.from({ length: 30 }, () => createEnquiryRateLimiter({ client: store.client() }).reserve()));
    expect(results.filter(x => x.allowed)).toHaveLength(1);
    expect(JSON.parse(store.body()).expires).toHaveLength(LIMIT);
});

test.each(['missing', 'denied', 'timeout', 'corrupt', 'oversized', 'clock reversal', 'write failure', 'ambiguous write', 'contention'])('%s fails closed without email or PII in logs/response', async mode => {
    const store = storage(), client = store.client();
    const sensitive = Object.assign(new Error(JSON.stringify(INPUT)), { statusCode: mode === 'missing' ? 404 : 403 });
    if (['missing', 'denied', 'timeout'].includes(mode)) client.download.mockRejectedValue(sensitive);
    if (mode === 'corrupt') store.replace(JSON.stringify(INPUT));
    if (mode === 'oversized') store.replace('x'.repeat(1025));
    if (mode === 'clock reversal') store.replace(JSON.stringify({ version: 1, lastObserved: START + 1, expires: [] }));
    if (mode === 'write failure') client.upload.mockRejectedValue(sensitive);
    if (mode === 'ambiguous write') {
        const write = client.upload.getMockImplementation();
        client.upload.mockImplementation(async (...args) => { await write(...args); throw sensitive; });
    }
    if (mode === 'contention') client.upload.mockRejectedValue(Object.assign(sensitive, { statusCode: 412, code: 'ConditionNotMet' }));
    const fetchImpl = jest.fn(), log = { warn: jest.fn(), error: jest.fn() };
    const service = createEnquiryService({ env: ENV, fetchImpl, rateLimiter: createEnquiryRateLimiter({ client }) });
    const context = { log };
    await createEnquiryFunction(service)(context, { headers: { 'sec-fetch-site': 'same-origin' }, body: INPUT });
    expect(context.res.status).toBe(503);
    expect(context.res.body.error).toContain('was not sent');
    expect(context.res.body.error).toContain('hello@nofries.nz');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn.mock.calls).toEqual([['enquiry enquiry_rate_limit_unavailable']]);
    for (const value of Object.values(INPUT)) expect(JSON.stringify([context.res, log.warn.mock.calls, log.error.mock.calls])).not.toContain(value);
    if (mode === 'ambiguous write') expect(JSON.parse(store.body()).expires).toHaveLength(1);
    if (mode === 'contention') expect(client.upload).toHaveBeenCalledTimes(8);
});

test('exhaustion returns 429 with Retry-After and no provider request', async () => {
    const store = storage();
    for (let i = 0; i < LIMIT; i += 1) await createEnquiryRateLimiter({ client: store.client() }).reserve();
    const fetchImpl = jest.fn(), context = { log: { warn: jest.fn(), error: jest.fn() } };
    await createEnquiryFunction(createEnquiryService({ env: ENV, fetchImpl, rateLimiter: createEnquiryRateLimiter({ client: store.client() }) }))(
        context, { headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.99' }, body: INPUT });
    expect(context.res.status).toBe(429);
    expect(context.res.headers['Retry-After']).toBe('3606');
    expect(context.res.body.error).toContain('was not sent');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(context.log.warn).not.toHaveBeenCalled();
});

test('missing configuration cannot fall back to an in-memory limit', async () => {
    const fetchImpl = jest.fn();
    await expect(createEnquiryService({ env: ENV, fetchImpl }).submitEnquiry(INPUT)).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
});

test('transport failures consume their permit and never expose raw provider errors', async () => {
    const store = storage(), fetchImpl = jest.fn(async () => { throw new Error(JSON.stringify(INPUT)); });
    const service = createEnquiryService({ env: ENV, fetchImpl, rateLimiter: createEnquiryRateLimiter({ client: store.client() }) });
    const log = { warn: jest.fn(), error: jest.fn() }, context = { log };
    await createEnquiryFunction(service)(context, { headers: { 'sec-fetch-site': 'same-origin' }, body: INPUT });
    expect(context.res.status).toBe(502);
    expect(JSON.parse(store.body()).expires).toHaveLength(1);
    expect(log.warn.mock.calls).toEqual([['enquiry enquiry_send_failed']]);
    errorResult(new Error(JSON.stringify(INPUT)), context);
    expect(log.error.mock.calls).toEqual([['enquiry unexpected_error']]);
});

test('a write completed after the deadline cannot authorise a send', async () => {
    const store = storage(), client = store.client(), write = client.upload.getMockImplementation();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    client.upload.mockImplementation(async (...args) => {
        await write(...args);
        clock.mockReturnValue(TIMEOUT_MS + 1);
    });
    try {
        await expect(createEnquiryRateLimiter({ client }).reserve()).rejects.toThrow('enquiry_rate_limit_unavailable');
        expect(JSON.parse(store.body()).expires).toHaveLength(1);
    } finally { clock.mockRestore(); }
});
