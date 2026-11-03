'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { fields, copy, uuid, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const held = new AsyncLocalStorage();
const underlyingContainers = new WeakMap();
const KEY = 'customer-starter/reset-writer-fence/control.json';
const CONTRACT = 'external_signup_writers_v1';
const fail = () => { throw new Error('signup_writer_fence_unavailable'); };
// A non-expiring shared lease excludes creating writers as well as replacements.
// A lost process or uncertain reset leaves the lease held. This code never breaks
// a lease or assumes that elapsed time proves another writer has stopped.
function createSignupWriterFence({ container, scopeId }) {
    digest(scopeId);
    // Fence control I/O must never recursively enter a decorated app writer.
    while (underlyingContainers.has(container)) container = underlyingContainers.get(container);
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
            if (reset !== null || current.reset !== null) fail();
            current.assertOpen(); current.pending++;
            try { await current.check(); current.assertOpen(); return await work(); }
            finally { current.pending--; }
        }
        const ready = { schemaVersion: 1, writerContract: CONTRACT, scopeId, reset: null };
        const leaseId = randomUUID(), client = blob(), lease = client.getBlobLeaseClient(leaseId);
        // First use is an immutable protocol record, not a grant or adoption
        // attestation. Production reset separately requires controller approval.
        try { await client.uploadData(Buffer.from(JSON.stringify(ready)), { conditions: { ifNoneMatch: '*' },
            abortSignal: AbortSignal.timeout(4000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
        catch (e) { if (![409, 412].includes(e?.statusCode)) fail(); }
        try { await lease.acquireLease(-1, { abortSignal: AbortSignal.timeout(4000) }); } catch (_) { fail(); }
        let release = reset === null, failed = false;
        const context = { scopeId, reset, open: true, uncertain: false, pending: 0,
            assertOpen() { if (!context.open || context.uncertain) fail(); }, async check() {
            context.assertOpen();
            try { await lease.renewLease({ abortSignal: AbortSignal.timeout(4000) }); }
            catch (_) { context.uncertain = true; fail(); }
            context.assertOpen();
        } };
        try {
            const value = await read();
            if (value.reset !== null) { release = false; fail(); }
            if (reset !== null) {
                fields(reset, ['operationId', 'planSha256']); uuid(reset.operationId); digest(reset.planSha256);
                await client.uploadData(Buffer.from(JSON.stringify({ ...ready, reset })), { conditions: { leaseId },
                    abortSignal: AbortSignal.timeout(4000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            }
            const result = await held.run(context, () => work(Object.freeze({ check: context.check, async complete() {
                if (reset === null) fail();
                context.assertOpen(); context.pending++;
                try {
                    await observe(context, () => client.uploadData(Buffer.from(JSON.stringify(ready)), {
                        conditions: { leaseId }, abortSignal: AbortSignal.timeout(4000) }));
                    context.assertOpen(); release = true;
                } finally { context.pending--; }
            } })));
            context.open = false;
            if (context.pending) { context.uncertain = true; fail(); }
            return result;
        } catch (error) {
            failed = true; throw error;
        } finally {
            context.open = false;
            // Latch retention at owner exit. Late success cannot prove that the
            // callback joined its work, nor may it reopen or release this lease.
            if (context.pending) context.uncertain = true;
            if (release && !context.uncertain) {
                try { await lease.releaseLease({ abortSignal: AbortSignal.timeout(4000) }); }
                catch (_) { context.uncertain = true; if (!failed) fail(); }
            }
        }
    }
    return Object.freeze({ readReset: async () => { try { return (await read()).reset; } catch (e) { if (e?.statusCode === 404 && e.code === 'BlobNotFound') return null; throw e; } }, withWriter: work => run(null, work), withReset: (reset, work) => run(reset, work) });
}
function wrapSignupWriters(value, fence) {
    if (!fence) return Object.freeze(value);
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, port]) => [key,
        typeof port === 'function' ? (...args) => fence.withWriter(() => port(...args)) : port])));
}
// Observe errors before adapters translate or reconcile them. A timed-out
// remote write may still land; even a swallowed error must retain the lease.
function observeWrite(work) { return observe(held.getStore(), work); }
async function observe(context, work) {
    // Recheck ownership immediately before dispatch and after acknowledgement.
    // A deliberate break never allows an old worker to continue or release
    // another holder's lease. Already-dispatched remote writes remain uncertain.
    if (context) { context.assertOpen(); context.pending++; }
    try {
        if (context) { await context.check(); context.assertOpen(); }
        const result = await work();
        if (context) { await context.check(); context.assertOpen(); }
        return result;
    }
    catch (error) {
        if (context && !(error?.statusCode === 412 && error.code === 'ConditionNotMet' ||
            error?.statusCode === 409 && error.code === 'BlobAlreadyExists')) context.uncertain = true;
        throw error;
    } finally { if (context) context.pending--; }
}
function observeContainer(container, fence = null) {
    const write = work => fence ? fence.withWriter(() => observeWrite(work)) : observeWrite(work);
    function wrap(blob) {
        return { download: (...a) => blob.download(...a), getBlobLeaseClient: (...a) => blob.getBlobLeaseClient(...a),
            withVersion: (...a) => wrap(blob.withVersion(...a)),
            uploadData: (...a) => write(() => blob.uploadData(...a)), delete: (...a) => write(() => blob.delete(...a)), deleteIfExists: (...a) => write(() => blob.deleteIfExists(...a)) };
    }
    const wrapped = { getBlockBlobClient: key => wrap(container.getBlockBlobClient(key)),
        getProperties: (...a) => container.getProperties(...a), listBlobsFlat: (...a) => container.listBlobsFlat(...a) };
    underlyingContainers.set(wrapped, container);
    return wrapped;
}
function observePool(pool) {
    return { end: (...a) => pool.end(...a), async connect() {
        const client = await pool.connect();
        return { release: (...a) => client.release(...a), query: (sql, params) =>
            /^(?:INSERT|UPDATE|DELETE|COMMIT)\b/i.test(sql) ? observeWrite(() => client.query(sql, params)) : client.query(sql, params) };
    } };
}
module.exports = { observeWrite, observeContainer, observePool, createSignupWriterFence, wrapSignupWriters, KEY, CONTRACT };

