'use strict';

// Deadline regressions use a controlled clock and explicit dependency barriers.
const { Readable, PassThrough } = require('node:stream');
const { BlockBlobClient } = require('@azure/storage-blob');
const { ManagedIdentityCredential } = require('@azure/identity');
const { createEnquiryRateLimiter, LIMIT, TIMEOUT_MS, WINDOW_MS, MAX_IN_FLIGHT } = require('../api/shared/enquiryRateLimit');
const { createEnquiryService } = require('../api/shared/enquiry');
const { createEnquiryFunction } = require('../api/enquiry');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const INPUT = { name: 'Review', email: 'review@example.invalid', message: 'Synthetic review enquiry only.' };
const ENV = { RESEND_API_KEY: 'synthetic', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' };
const AT = Date.parse('2026-11-04T00:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
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
beforeEach(() => {
    resetAbuseProtectionForTests();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('real SDK identity acquisition returns 503 before the stalled dependency settles', async () => {
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
        await entered.promise;
        await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
        await result.completion;
        expect(signal.aborted).toBe(true);
        assertUnavailable(result);
        expect(result.fetchImpl).not.toHaveBeenCalled();
        expect(sendRequest).not.toHaveBeenCalled();
    } finally {
        token.reject(new Error('synthetic identity failure'));
        await tick();
    }
    assertUnavailable(result);
    expect(jest.getTimerCount()).toBe(0);
}, 12000);

test('a stalled body is destroyed and returns 503 without waiting for EOF', async () => {
    const stream = new PassThrough();
    const upload = jest.fn();
    const result = request({
        download: async () => ({ date: new Date(AT), etag: '"1"', readableStreamBody: stream }), upload
    });
    try {
        await tick();
        await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
        await result.completion;
        assertUnavailable(result);
        expect(stream.destroyed).toBe(true);
        expect(result.fetchImpl).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    } finally {
        stream.destroy();
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

test.each(['commit', 'conflict', 'error'])('a late upload %s cannot authorise email or retry', async outcome => {
    const commit = deferred(), entered = deferred();
    let stored;
    const upload = jest.fn(async body => {
        entered.resolve(); await commit.promise;
        if (outcome === 'conflict') throw Object.assign(new Error('conflict'), { statusCode: 412, code: 'ConditionNotMet' });
        if (outcome === 'error') throw new Error('synthetic failure');
        stored = body;
    });
    const download = jest.fn(async () => ({ date: new Date(AT), etag: '"1"', readableStreamBody: Readable.from(['{"version":1,"lastObserved":0,"expires":[]}']) }));
    const result = request({
        download, upload
    });
    try {
        await entered.promise;
        await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
        await result.completion;
        assertUnavailable(result);
        expect(result.fetchImpl).not.toHaveBeenCalled();
    } finally {
        commit.resolve();
        await tick();
    }
    assertUnavailable(result);
    if (outcome === 'commit') expect(JSON.parse(stored).expires).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test('a download arriving after timeout is destroyed without a write or send', async () => {
    const read = deferred(), stream = new PassThrough(), upload = jest.fn();
    const result = request({ download: () => read.promise, upload });
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await result.completion;
    assertUnavailable(result);
    read.resolve({ date: new Date(AT), etag: '"1"', readableStreamBody: stream });
    await tick();
    expect(stream.destroyed).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(result.fetchImpl).not.toHaveBeenCalled();
});

test('uncooperative dependencies have bounded retained work and recover after settling', async () => {
    const stuck = deferred(), client = { download: jest.fn(() => stuck.promise) };
    const limiter = createEnquiryRateLimiter({ client });
    const outcomes = Array.from({ length: MAX_IN_FLIGHT }, () => limiter.reserve().catch(error => error.message));
    await expect(limiter.reserve()).rejects.toThrow('enquiry_rate_limit_unavailable');
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await Promise.all(outcomes)).toEqual(Array(MAX_IN_FLIGHT).fill('enquiry_rate_limit_unavailable'));
    await expect(limiter.reserve()).rejects.toThrow('enquiry_rate_limit_unavailable');
    expect(client.download).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    stuck.reject(new Error('late credential failure'));
    await tick();
    client.download.mockRejectedValue(new Error('bounded new request'));
    await expect(limiter.reserve()).rejects.toThrow('enquiry_rate_limit_unavailable');
    expect(client.download).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
    expect(jest.getTimerCount()).toBe(0);
});
