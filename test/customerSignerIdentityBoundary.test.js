'use strict';
// Real identity4.13.1 + MSAL managed-identity internals, synthetic HTTP only.
const { denyOutbound, syntheticIdentityEnvironment, realIdentityBoundary, signerHarness,
    captureIdentityLogs, response, flush, GENERIC, CONTEXT, IDENTITY_HEADER, ERROR_DETAIL,
    apiRequire, id } = require('./helpers/offlineCustomerSigner');
let escapes, logging;
// MSAL caches its managed-identity source/transport statically; isolate scenarios.
beforeEach(() => { jest.resetModules(); escapes = denyOutbound(); syntheticIdentityEnvironment(); });
afterEach(() => {
    try { expect(escapes).toEqual([]); }
    finally { logging?.restore(); logging = null; jest.restoreAllMocks(); jest.useRealTimers(); }
});

test.each([{ kind: 'system-assigned' }, { kind: 'user-assigned', clientId: id(7) }])(
    'actual managed identity SDK %j reaches only synthetic App Service HTTP and fails closed', async identity => {
        const real = realIdentityBoundary(), h = signerHarness({ identityBoundary: real, managedIdentity: identity });
        const error = await h.callback(CONTEXT).catch(value => value);
        expect(apiRequire('@azure/identity/package.json').version).toBe('4.13.1');
        expect(real.instances[0]).toBeInstanceOf(apiRequire('@azure/identity').ManagedIdentityCredential);
        expect(real.optionsReceived).toEqual([{ retryOptions: { maxRetries: 0 },
            ...(identity.clientId ? { clientId: identity.clientId } : {}) }]);
        expect(real.requests).toHaveLength(1);
        expect(new URL(real.requests[0].url).searchParams.get('client_id')).toBe(identity.clientId || null);
        expect(error.message).toBe(GENERIC); expect(error.cause).toBeUndefined();
        expect(h.attempts.map(r => r.method)).toEqual(['GET']); expect(h.calls).toHaveLength(0);
    });

test('actual identity delay outlives outer abort; four callbacks retain capacity until HTTP settles', async () => {
    jest.useFakeTimers();
    const real = realIdentityBoundary(), delayed = [];
    real.httpClient.sendRequest.mockImplementation(request => {
        real.requests.push(request);
        return new Promise(resolve => delayed.push(() => resolve(response(request, 400,
            { error: 'invalid_request', error_description: ERROR_DETAIL }))));
    });
    const h = signerHarness({ identityBoundary: real });
    const pending = Array.from({ length: 4 }, () => h.callback(CONTEXT).catch(e => e));
    await flush(); await jest.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(pending)).every(e => e.message === GENERIC)).toBe(true);
    expect(real.requests.length).toBeGreaterThan(0);
    expect(h.attempts).toHaveLength(4);
    expect(h.attempts.every(r => r.abortSignal.aborted)).toBe(true);
    // This is the reviewed upstream limitation, not guaranteed cancellation.
    expect(real.requests.every(r => !r.abortSignal || !r.abortSignal.aborted)).toBe(true);
    const count = real.requests.length;
    await expect(h.callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(real.requests).toHaveLength(count); expect(h.attempts).toHaveLength(4);
    delayed.forEach(release => release()); await flush(); await jest.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(0); expect(h.attempts.every(r => r.method === 'GET')).toBe(true);
    // After the failed underlying acquisition settles, a new call can try once.
    real.httpClient.sendRequest.mockImplementation(async request => {
        real.requests.push(request); return response(request, 400, { error: 'invalid_request', error_description: ERROR_DETAIL });
    });
    await expect(h.callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(h.attempts).toHaveLength(5);
});

test.each(['verbose', 'error'])('characterizes identity %s error detail propagation despite sanitized outward failure', async level => {
    logging = captureIdentityLogs(level);
    const real = realIdentityBoundary(), h = signerHarness({ identityBoundary: real });
    const error = await h.callback(CONTEXT).catch(value => value);
    const logged = logging.output.join('\n');
    expect(logged).toContain('ManagedIdentityCredential');
    expect(error.message).toBe(GENERIC); expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(ERROR_DETAIL);
    expect(logged).not.toContain(IDENTITY_HEADER);
    // Promotion gap: upstream verbose error logging preserves response details.
    // Passing this characterization does not satisfy an error-redaction gate.
    expect(logged).toContain(ERROR_DETAIL);
});

test.each([403, 429, 503])('actual identity HTTP %s is not retried and does not proceed to signing', async status => {
    const real = realIdentityBoundary();
    real.httpClient.sendRequest.mockImplementation(async request => {
        real.requests.push(request);
        return response(request, status, { error: 'offline_denied', error_description: ERROR_DETAIL }, { 'retry-after': '0' });
    });
    const h = signerHarness({ identityBoundary: real });
    await expect(h.callback(CONTEXT)).rejects.toThrow(GENERIC);
    expect(real.requests).toHaveLength(1); expect(h.calls).toHaveLength(0);
});

test('real identity network failure is sanitized outward without another request', async () => {
    logging = captureIdentityLogs();
    const real = realIdentityBoundary();
    real.httpClient.sendRequest.mockImplementation(async request => {
        real.requests.push(request);
        throw Object.assign(new Error('OFFLINE_NETWORK_DETAIL'), { code: 'ECONNREFUSED' });
    });
    const h = signerHarness({ identityBoundary: real });
    const error = await h.callback(CONTEXT).catch(value => value);
    expect(error.message).toBe(GENERIC); expect(error.cause).toBeUndefined();
    expect(real.requests).toHaveLength(1); expect(h.calls).toHaveLength(0);
    expect(logging.output.join('\n')).toContain('network_error');
    expect(logging.output.join('\n')).not.toContain('OFFLINE_NETWORK_DETAIL');
    expect(logging.output.join('\n')).not.toContain(IDENTITY_HEADER);
});
