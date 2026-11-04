'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { fields, copy, uuid, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const held = new AsyncLocalStorage();
const KEY = 'customer-starter/reset-writer-fence/control.json';
const CONTRACT = 'external_signup_writers_v1';
const fail = () => { throw new Error('signup_writer_fence_unavailable'); };
// A non-expiring shared lease excludes creating writers as well as replacements.
// A lost process or uncertain reset leaves the lease held. This code never breaks
// a lease or assumes that elapsed time proves another writer has stopped.
function createSignupWriterFence({ container, scopeId }) {
    digest(scopeId);
    const blob = () => container.getBlockBlobClient(KEY);
    async function read() {
        const response = await blob().download(0, 2049, { abortSignal: AbortSignal.timeout(4000) });
        try {
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 2048) fail();
            let size = 0; const chunks = [];
            for await (const b of response.readableStreamBody) { size += b.length; if (size > 2048) fail(); chunks.push(b); }
            if (size !== response.contentLength) fail();
            const value = fields(copy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), 2048),
                ['schemaVersion', 'writerContract', 'scopeId', 'reset']);
            if (value.schemaVersion !== 1 || value.writerContract !== CONTRACT || value.scopeId !== scopeId) fail();
            if (value.reset !== null) { fields(value.reset, ['operationId', 'planSha256']); uuid(value.reset.operationId); digest(value.reset.planSha256); }
            return value;
        } finally { response.readableStreamBody?.destroy(); }
    }
    async function run(reset, work) {
        if (typeof work !== 'function') fail();
        const current = held.getStore();
        if (current?.scopeId === scopeId) {
            if (reset !== null || current.reset !== null || !current.open) fail();
            await current.check(); return work();
        }
        const ready = { schemaVersion: 1, writerContract: CONTRACT, scopeId, reset: null };
        const leaseId = randomUUID(), client = blob(), lease = client.getBlobLeaseClient(leaseId);
        // First use is an immutable protocol record, not a grant or adoption
        // attestation. Production reset separately requires controller approval.
        try { await client.uploadData(Buffer.from(JSON.stringify(ready)), { conditions: { ifNoneMatch: '*' },
            abortSignal: AbortSignal.timeout(4000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
        catch (e) { if (![409, 412].includes(e?.statusCode)) fail(); }
        try { await lease.acquireLease(-1, { abortSignal: AbortSignal.timeout(4000) }); } catch (_) { fail(); }
        let release = reset === null;
        const context = { scopeId, reset, open: true, uncertain: false, async check() {
            if (!context.open || context.uncertain) fail();
            await lease.renewLease({ abortSignal: AbortSignal.timeout(4000) });
        } };
        try {
            const value = await read();
            if (value.reset !== null) { release = false; fail(); }
            if (reset !== null) {
                fields(reset, ['operationId', 'planSha256']); uuid(reset.operationId); digest(reset.planSha256);
                await client.uploadData(Buffer.from(JSON.stringify({ ...ready, reset })), { conditions: { leaseId },
                    abortSignal: AbortSignal.timeout(4000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            }
            return await held.run(context, () => work(Object.freeze({ check: context.check, async complete() {
                if (reset === null) fail(); await context.check();
                await client.uploadData(Buffer.from(JSON.stringify(ready)), { conditions: { leaseId }, abortSignal: AbortSignal.timeout(4000) });
                release = true;
            } })));
        } finally {
            context.open = false;
            if (release && !context.uncertain) { try { await lease.releaseLease({ abortSignal: AbortSignal.timeout(4000) }); } catch (_) { fail(); } }
        }
    }
    return Object.freeze({ readReset: async () => { try { return (await read()).reset; } catch (e) { if (e?.statusCode === 404 && e.code === 'BlobNotFound') return null; throw e; } }, withWriter: work => run(null, work), withReset: (reset, work) => run(reset, work) });
}
function wrapSignupWriters(value, fence) {
    if (!fence) return value;
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, port]) => [key,
        typeof port === 'function' ? (...args) => fence.withWriter(() => port(...args)) : port])));
}
// Observe errors before adapters translate or reconcile them. A timed-out
// remote write may still land; even a swallowed error must retain the lease.
async function observeWrite(work) {
    const context = held.getStore();
    if (context && (!context.open || context.uncertain)) fail();
    try { return await work(); }
    catch (error) {
        if (context && !(error?.statusCode === 412 && error.code === 'ConditionNotMet' ||
            error?.statusCode === 409 && error.code === 'BlobAlreadyExists')) context.uncertain = true;
        throw error;
    }
}
function observeContainer(container) {
    function wrap(blob) {
        return { download: (...a) => blob.download(...a), getBlobLeaseClient: (...a) => blob.getBlobLeaseClient(...a),
            withVersion: (...a) => wrap(blob.withVersion(...a)),
            uploadData: (...a) => observeWrite(() => blob.uploadData(...a)), delete: (...a) => observeWrite(() => blob.delete(...a)), deleteIfExists: (...a) => observeWrite(() => blob.deleteIfExists(...a)) };
    }
    return { getBlockBlobClient: key => wrap(container.getBlockBlobClient(key)),
        getProperties: (...a) => container.getProperties(...a), listBlobsFlat: (...a) => container.listBlobsFlat(...a) };
}
function observePool(pool) {
    return { end: (...a) => pool.end(...a), async connect() {
        const client = await pool.connect();
        return { release: (...a) => client.release(...a), query: (sql, params) =>
            /^(?:INSERT|UPDATE|DELETE|COMMIT)\b/i.test(sql) ? observeWrite(() => client.query(sql, params)) : client.query(sql, params) };
    } };
}
module.exports = { observeWrite, observeContainer, observePool, createSignupWriterFence, wrapSignupWriters, KEY, CONTRACT };
