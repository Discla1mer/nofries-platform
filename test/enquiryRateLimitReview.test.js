'use strict';

// Review reproductions: a passing "KNOWN GAP" test confirms the defect remains.
// These are not acceptance assertions for a bounded HTTP response. See the review
// document before treating green CI as release readiness.
const { Readable, PassThrough } = require('node:stream');
const { BlockBlobClient } = require('@azure/storage-blob');
const { ManagedIdentityCredential } = require('@azure/identity');
const { createEnquiryRateLimiter, LIMIT, TIMEOUT_MS, WINDOW_MS } = require('../api/shared/enquiryRateLimit');
const { createEnquiryService } = require('../api/shared/enquiry');
const { createEnquiryFunction } = require('../api/enquiry');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const INPUT = { name: 'Review', email: 'review@example.invalid', message: 'Synthetic review enquiry only.' };
const ENV = { RESEND_API_KEY: 'synthetic', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' };
const AT = Date.parse('2026-11-04T00:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function request(client) {
    const fetchImpl = jest.fn(async () => ({ ok: true }));
    const context = { log: { warn: jest.fn(), error: jest.fn() } };
    const service = createEnquiryService({ env: ENV, fetchImpl, rateLimiter: createEnquiryRateLimiter({ client }) });
    const completion = createEnquiryFunction(service)(context, { headers: { 'sec-fetch-site': 'same-origin' }, body: INPUT });
    return { fetchImpl, context, completion };
}
function assertUnavailable(result) {
    expect(result.context.res.status).toBe(503);
    expect(result.context.res.body.code).toBe('enquiry_rate_limit_unavailable');
    expect(result.context.res.body.error).toContain('was not sent');
    expect(result.context.res.body.error).toContain('hello@nofries.nz');
    expect(result.fetchImpl).not.toHaveBeenCalled();
    expect(result.context.log.warn.mock.calls).toEqual([['enquiry enquiry_rate_limit_unavailable']]);
    expect(result.context.log.error).not.toHaveBeenCalled();
}
beforeEach(() => resetAbuseProtectionForTests());

test('KNOWN GAP: real SDK managed-identity acquisition can outlive the five-second HTTP deadline', async () => {
    const credential = new ManagedIdentityCredential();
    // Intercept only the MSAL dependency; exercise the installed credential and
    // blob authentication pipeline. No real identity endpoint or Azure request.
    const entered = deferred(), token = deferred();
    jest.spyOn(credential.managedIdentityApp, 'getManagedIdentitySource').mockReturnValue('AppService');
    jest.spyOn(credential.managedIdentityApp, 'acquireToken').mockImplementation(() => {
        entered.resolve();
        return token.promise;
    });
    let signal;
    const getToken = credential.getToken.bind(credential);
    jest.spyOn(credential, 'getToken').mockImplementation((scopes, options) => {
        signal = options.abortSignal;
        return getToken(scopes, options);
    });
    const sendRequest = jest.fn(async () => { throw new Error('Unexpected synthetic HTTP transport'); });
    const client = new BlockBlobClient('https://reviewfixture.blob.core.windows.net/enquiry-rate-limit/public-enquiry-v1.json', credential,
        { httpClient: { sendRequest }, retryOptions: { maxTries: 1, tryTimeoutInMs: TIMEOUT_MS } });
    const result = request(client);
    try {
        await Promise.race([entered.promise, delay(1000).then(() => { throw new Error('Token acquisition not reached'); })]);
        await delay(TIMEOUT_MS + 250);
        expect(signal.aborted).toBe(true);
        // Defect: the HTTP handler has not returned its promised 503 guidance.
        expect(result.context.res).toBeUndefined();
        expect(result.fetchImpl).not.toHaveBeenCalled();
        expect(sendRequest).not.toHaveBeenCalled();
    } finally {
        token.reject(new Error('synthetic identity failure'));
        await result.completion;
        jest.restoreAllMocks();
    }
    assertUnavailable(result);
}, 12000);

test('KNOWN GAP: a stalled body that ignores cancellation keeps the HTTP request pending', async () => {
    const controller = new AbortController(), stream = new PassThrough();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const upload = jest.fn();
    const result = request({
        download: async () => ({ date: new Date(AT), etag: '"1"', readableStreamBody: stream }), upload
    });
    try {
        await tick();
        controller.abort();
        await tick();
        expect(result.context.res).toBeUndefined();
        expect(result.fetchImpl).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    } finally {
        stream.end('{"version":1,"lastObserved":0,"expires":[]}');
        await result.completion;
        timeout.mockRestore();
    }
    assertUnavailable(result);
});

test('an ambiguous final-slot commit prevents the racing instance from sending too', async () => {
    let revision = 1;
    let body = JSON.stringify({ version: 1, lastObserved: AT, expires: Array(LIMIT - 1).fill(AT + WINDOW_MS) });
    const readBarrier = deferred();
    let reads = 0;
    function client() {
        return {
            async download() {
                const snapshot = { date: new Date(AT), etag: `"${revision}"`, readableStreamBody: Readable.from([body]) };
                if (++reads <= 2) {
                    if (reads === 2) readBarrier.resolve();
                    await readBarrier.promise;
                }
                return snapshot;
            },
            async upload(next, _size, options) {
                if (options.conditions.ifMatch !== `"${revision}"`) {
                    throw Object.assign(new Error('conflict'), { statusCode: 412, code: 'ConditionNotMet' });
                }
                body = next; revision++;
                throw new Error('Response lost after storage committed');
            }
        };
    }
    const first = request(client()), second = request(client());
    await Promise.all([first.completion, second.completion]);
    expect([first.context.res.status, second.context.res.status].sort()).toEqual([429, 503]);
    expect(first.fetchImpl).not.toHaveBeenCalled();
    expect(second.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(body).expires).toHaveLength(LIMIT);
    expect(revision).toBe(2);
});

test('KNOWN GAP: pending upload delays the 503, but a late commit never authorises email', async () => {
    const controller = new AbortController(), commit = deferred(), entered = deferred();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let stored;
    const result = request({
        download: async () => ({ date: new Date(AT), etag: '"1"', readableStreamBody: Readable.from(['{"version":1,"lastObserved":0,"expires":[]}']) }),
        upload: async body => { entered.resolve(); await commit.promise; stored = body; }
    });
    try {
        await entered.promise;
        controller.abort();
        await tick();
        expect(result.context.res).toBeUndefined();
        expect(result.fetchImpl).not.toHaveBeenCalled();
    } finally {
        commit.resolve();
        await result.completion;
        timeout.mockRestore();
    }
    assertUnavailable(result);
    expect(JSON.parse(stored).expires).toHaveLength(1);
});
