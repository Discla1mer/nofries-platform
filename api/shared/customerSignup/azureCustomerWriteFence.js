'use strict';

// Stable lock blobs are never deleted. Infinite leases deliberately fail closed
// on process loss or an uncertain mutation; only a quiesced operator may recover
// such a lease. A lease ID is private to one invocation, never a takeover token.
const { randomUUID, createHash } = require('node:crypto');
const PREFIX = 'customer-write-fences/v1/';
const KEY = /^(?:customer-starter\/starter-accounts|customer-subjects)\/[a-f0-9]{64}\.json$/;
const fail = code => { throw Object.assign(new Error(code), { fenceCode: code }); };
const missing = error => error?.statusCode === 404 && error.code === 'BlobNotFound';
const matches = (a, b) => a === b || a !== null && b !== null &&
    a.operationId === b.operationId && a.bindingSha256 === b.bindingSha256;
const fenceKey = key => {
    if (typeof key !== 'string' || !KEY.test(key)) fail('key_outside_target');
    return PREFIX + createHash('sha256').update(key).digest('hex') + '.json';
};
async function readBlob(blob) {
    let response;
    try { response = await blob.download(0, 65537, { abortSignal: AbortSignal.timeout(5000) }); }
    catch (error) { if (missing(error)) return null; throw error; }
    const chunks = []; let size = 0;
    try { for await (const chunk of response.readableStreamBody) {
        size += chunk.length; if (size > 65536) fail('record_too_large'); chunks.push(Buffer.from(chunk));
    } } finally { response.readableStreamBody?.destroy(); }
    return { bytes: Buffer.concat(chunks), etag: response.etag };
}
async function acquireRecordFence(container, key, owner = null) {
    if (!container || typeof container.getBlockBlobClient !== 'function') fail('invalid_configuration');
    const blob = container.getBlockBlobClient(fenceKey(key));
    const encode = owner => Buffer.from(JSON.stringify({ schemaVersion: 1, owner }));
    try { await blob.uploadData(encode(null), { conditions: { ifNoneMatch: '*' } }); }
    catch (error) {
        if (!(error?.statusCode === 409 && error.code === 'BlobAlreadyExists' ||
            error?.statusCode === 412 && error.code === 'ConditionNotMet')) throw error;
    }
    const leaseId = randomUUID(), lease = blob.getBlobLeaseClient(leaseId);
    await lease.acquireLease(-1);
    let closed = false, retained = false;
    const assertCurrent = async () => { if (closed) fail('fence_settled'); await lease.renewLease(); };
    // Admission errors cause no target mutation and can release this invocation's
    // unique lease. A malformed marker is never overwritten or cleared.
    try {
        const found = await readBlob(blob), record = JSON.parse(found.bytes.toString('utf8'));
        if (record?.schemaVersion !== 1 || !Object.hasOwn(record, 'owner') ||
            record.owner !== null && (!/^[a-f0-9-]{36}$/.test(record.owner?.operationId) ||
                !/^[a-f0-9]{64}$/.test(record.owner?.bindingSha256))) fail('fence_record_invalid');
        if (record.owner !== null && !matches(record.owner, owner)) fail('fence_held_by_other_operation');
        retained = record.owner !== null;
    } catch (error) { try { await lease.releaseLease(); } catch (_) {} throw error; }
    return Object.freeze({
        assertCurrent, retained,
        async mark(next) {
            await assertCurrent();
            await blob.uploadData(encode(next), { conditions: { leaseId },
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
        },
        async release() {
            if (closed) fail('fence_settled'); closed = true;
            await lease.releaseLease();
        }
    });
}
async function withCustomerRecordWrite(container, key, work) {
    if (typeof work !== 'function') fail('invalid_configuration');
    const lock = await acquireRecordFence(container, key);
    // Do not release on an uncertain write: a timed-out request may still apply.
    const result = await work();
    // The write has finished. A failed release leaves a safe, orphaned lock;
    // reporting the write as failed would invite an unsafe repeat.
    try { await lock.release(); } catch (_) {}
    return result;
}
module.exports = { acquireRecordFence, withCustomerRecordWrite, readBlob, fenceKey, PREFIX };
