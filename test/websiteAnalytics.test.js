'use strict';
const { Readable } = require('stream');
const { createStore, validEvent } = require('../api/shared/websiteAnalytics');
const home = { event: 'view', page: 'home', referrer: 'direct', device: 'desktop' };
function container() {
    let data, etag = 0, fail;
    const blob = {
        async download() { if (!data) throw { statusCode: 404, code: 'BlobNotFound' }; return { etag: String(etag), readableStreamBody: Readable.from([data]) }; },
        async uploadData(value, options) {
            if (fail) { const error = fail; fail = null; throw error; }
            if (options.conditions.ifNoneMatch && data || options.conditions.ifMatch && options.conditions.ifMatch !== String(etag)) throw { statusCode: 412, code: 'ConditionNotMet' };
            data = Buffer.from(value); etag++;
        }
    };
    return { getProperties: async () => ({}), getBlockBlobClient: () => blob, fail: e => { fail = e; }, raw: () => data && JSON.parse(data), set: d => { data = Buffer.from(JSON.stringify(d)); etag++; } };
}
test('concurrent create and update preserve real page views and independent event marginals', async () => {
    const c = container(), store = createStore(c, () => new Date('2026-10-28T00:00:00Z'));
    await Promise.all([store.record(home), store.record(home)]);
    await store.record({ event: 'create-click' });
    expect(c.raw()).toMatchObject({ home: 2, start: '2026-10-28', days: { '2026-10-28': { pages: { home: 2 }, devices: { desktop: 2 }, referrers: { direct: 2 }, createClicks: 1 } } });
});
test('uncertain write failure is not retried and cannot fabricate a count', async () => {
    const c = container(), store = createStore(c); c.fail({ code: 'ETIMEDOUT' });
    await expect(store.record(home)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(await store.read()).toBeNull();
});
test('prunes daily buckets on write while preserving cumulative count', async () => {
    const c = container(), store = createStore(c, () => new Date('2026-10-28T00:00:00Z'));
    c.set({ version: 1, start: '2026-01-01', home: 4, days: { '2026-01-01': { pages: { home: 4 }, referrers: {}, devices: {}, createClicks: 0, signupEntries: 0 } } });
    await store.record(home); expect(c.raw().home).toBe(5); expect(Object.keys(c.raw().days)).toEqual(['2026-10-28']);
});
test('accepts only finite event fields', () => {
    expect(validEvent(home)).toBe(true); expect(validEvent({ ...home, url: '/?token=secret' })).toBe(false);
    expect(validEvent({ event: 'create-click', device: 'mobile' })).toBe(false);
});
test('only proven conditional conflicts are retried and retry count is bounded', async () => {
    let uploads = 0;
    const c = { getProperties: async () => ({}), getBlockBlobClient: () => ({
        download: async () => { throw { statusCode: 404, code: 'BlobNotFound' }; },
        uploadData: async () => { uploads++; throw { statusCode: 412, code: 'ConditionNotMet' }; }
    }) };
    await expect(createStore(c).record(home)).rejects.toMatchObject({ statusCode: 412 });
    expect(uploads).toBe(3);
});
test('missing container cannot be mistaken for a missing aggregate', async () => {
    let uploads = 0;
    const c = { getProperties: async () => { throw { statusCode: 404, code: 'ContainerNotFound' }; }, getBlockBlobClient: () => ({ uploadData: async () => { uploads++; } }) };
    await expect(createStore(c).record(home)).rejects.toMatchObject({ code: 'ContainerNotFound' });
    expect(uploads).toBe(0);
});
test('production adapter uses managed identity and existing configured container with conditional writes', async () => {
    const { productionStore } = require('../api/shared/websiteAnalytics');
    const calls = {}; const client = container();
    class ManagedIdentityCredential { constructor(options) { calls.identity = options; } }
    class BlobServiceClient { constructor(url, credential, options) { Object.assign(calls, { url, credential, options }); } getContainerClient(name) { calls.container = name; return client; } }
    const env = { NOFRIES_WEBSITE_ANALYTICS_ENABLED: 'true', AZURE_STORAGE_ACCOUNT_NAME: 'nofriesdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesauth', NOFRIES_AZURE_CONTAINER: 'analytics-existing', NOFRIES_MANAGED_IDENTITY_CLIENT_ID: 'test-client' };
    const store = productionStore(env, { ManagedIdentityCredential, BlobServiceClient });
    await store.record(home);
    expect(calls).toMatchObject({ url: 'https://nofriesdata.blob.core.windows.net', container: 'analytics-existing', identity: { clientId: 'test-client' }, options: { retryOptions: { maxTries: 1 } } });
    expect(calls.credential).toBeInstanceOf(ManagedIdentityCredential);
    expect(client.raw().home).toBe(1);
    expect(productionStore({ ...env, AZURE_STORAGE_ACCOUNT_NAME: 'nofriesauth' }, { ManagedIdentityCredential, BlobServiceClient })).toBeNull();
    expect(productionStore({ ...env, AZURE_STORAGE_ACCOUNT_NAME: 'NOFRIESAUTH', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: ' nofriesauth ' }, { ManagedIdentityCredential, BlobServiceClient })).toBeNull();
    expect(productionStore({ ...env, NOFRIES_WEBSITE_ANALYTICS_ENABLED: 'false' }, { ManagedIdentityCredential, BlobServiceClient })).toBeNull();
});
test('oversize stored document is rejected rather than reset', async () => {
    let writes = 0;
    const c = { getProperties: async () => ({}), getBlockBlobClient: () => ({
        download: async () => ({ etag: 'v1', readableStreamBody: Readable.from([Buffer.alloc(65537)]) }),
        uploadData: async () => { writes++; }
    }) };
    await expect(createStore(c).record(home)).rejects.toThrow('aggregate too large');
    expect(writes).toBe(0);
});
test('a stalled container check times out without a later write', async () => {
    jest.useFakeTimers();
    try {
        let finish; let writes = 0;
        const c = { getProperties: () => new Promise(resolve => { finish = resolve; }), getBlockBlobClient: () => ({ download: async () => { throw { statusCode: 404, code: 'BlobNotFound' }; }, uploadData: async () => { writes++; } }) };
        const operation = createStore(c).record(home);
        const check = expect(operation).rejects.toThrow('aggregate timeout');
        await jest.advanceTimersByTimeAsync(5000); await check;
        finish(); await Promise.resolve(); await Promise.resolve();
        expect(writes).toBe(0);
    } finally { jest.useRealTimers(); }
});
test('invalid or future dates fail closed; staff reads filter stale buckets without rewriting', async () => {
    const c = container(), store = createStore(c, () => new Date('2026-10-28T00:00:00Z'));
    const row = { pages: { home: 2 }, devices: {}, referrers: {}, createClicks: 0, signupEntries: 0 };
    for (const dates of [{ '2026-02-30': row }, { '2026-10-29': row }]) {
        c.set({ version: 1, start: '2026-01-01', home: 2, days: dates });
        await expect(store.read()).rejects.toThrow(); await expect(store.record(home)).rejects.toThrow();
    }
    c.set({ version: 1, start: '2026-01-01', home: 2, days: { '2026-01-01': row } });
    expect(await store.read()).toMatchObject({ home: 2, days: {} });
    expect(c.raw().days['2026-01-01']).toEqual(row);
});
test('a committed upload with a lost response is never retried', async () => {
    let uploads = 0, body;
    const c = { getProperties: async () => ({}), getBlockBlobClient: () => ({
        download: async () => { if (!body) throw { statusCode: 404, code: 'BlobNotFound' }; return { etag: 'v1', readableStreamBody: Readable.from([body]) }; },
        uploadData: async value => { uploads++; body = Buffer.from(value); throw { code: 'ETIMEDOUT' }; }
    }) };
    await expect(createStore(c).record(home)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(uploads).toBe(1); expect(JSON.parse(body).home).toBe(1);
});
