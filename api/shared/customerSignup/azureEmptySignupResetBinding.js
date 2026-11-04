'use strict';

// Azure Blob binding for the operator-only empty-signup reset (issue #16).
// Supplies the coordinator's `withExclusiveTarget` port and its `blobs` port.
//
// Retains version-bound target leases and a durable operation fence. The admin
// adapter additionally holds the common signup-writer lease, which excludes
// creation after a pointer is deleted. Target leases alone are insufficient.
// No caller may treat this storage binding as an authorisation decision.
const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^customer-(?:starter|subjects)\/[A-Za-z0-9/_.-]{1,400}\.json$/;
const FENCE_PREFIX = 'customer-starter/empty-signup-reset-fences/';
const MAX_RECORD_BYTES = 65536;
const fail = code => { const error = new Error(code); error.fenceCode = code; throw error; };
const status = error => error?.statusCode ?? error?.status;
const missing = error => status(error) === 404;

async function readBlob(blob, options) {
    let response;
    try { response = await blob.download(0, undefined, options); } catch (error) { if (missing(error)) return null; throw error; }
    const chunks = []; let size = 0;
    for await (const chunk of response.readableStreamBody) {
        size += chunk.length; if (size > MAX_RECORD_BYTES) fail('record_too_large');
        chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), etag: response.etag };
}

function createAzureEmptySignupResetBinding({ accountContainer, authorityContainer, fenceContainer = accountContainer,
    randomUUID = () => crypto.randomUUID(), now = () => Date.now() } = {}) {
    for (const c of [accountContainer, authorityContainer, fenceContainer]) {
        if (!c || typeof c.getBlockBlobClient !== 'function') fail('invalid_configuration');
    }
    const blobFor = key => {
        if (typeof key !== 'string' || !KEY.test(key) || key.includes('..') || key.startsWith(FENCE_PREFIX)) fail('key_outside_target');
        return (key.startsWith('customer-subjects/') ? authorityContainer : accountContainer).getBlockBlobClient(key);
    };
    // Lease IDs of the fence held by this process, by target key.
    const held = new Map();
    const leaseFor = key => { const id = held.get(key); if (!id) fail('fence_required'); return id; };

    async function lease(key, leaseId) {
        try { await blobFor(key).getBlobLeaseClient(leaseId).acquireLease(-1); return true; }
        catch (error) { if (missing(error)) return false; throw error; }
    }
    async function renew(key, leaseId) {
        try { await blobFor(key).getBlobLeaseClient(leaseId).renewLease(); }
        catch (error) { if (!missing(error)) throw error; }
    }
    async function release(key, leaseId) {
        try { await blobFor(key).getBlobLeaseClient(leaseId).releaseLease(); }
        catch (error) { if (!missing(error)) throw error; }
    }

    async function withExclusiveTarget(binding, work) {
        const operationId = binding?.request?.operationId;
        const keys = { account: binding?.plan?.records?.account?.key, authority: binding?.plan?.records?.authority?.key || (binding?.request?.customerSubjectKey ? 'customer-subjects/' + require('./customerAuthority').subjectHash(binding.request.customerSubjectKey) + '.json' : null) };
        if (typeof operationId !== 'string' || !UUID.test(operationId) || typeof work !== 'function') fail('invalid_binding');
        Object.values(keys).forEach(blobFor);
        if (!keys.account.startsWith('customer-starter/') || !keys.authority.startsWith('customer-subjects/')) fail('invalid_binding');
        if (Object.values(keys).some(key => held.has(key))) fail('fence_busy');

        const fenceBlob = fenceContainer.getBlockBlobClient(FENCE_PREFIX +
            crypto.createHash('sha256').update(keys.account).digest('hex') + '.json');
        const holder = randomUUID();
        let record, etag;
        const write = async (next, conditions) => {
            const body = Buffer.from(JSON.stringify(next));
            etag = (await fenceBlob.uploadData(body, { conditions, blobHTTPHeaders: { blobContentType: 'application/json' } })).etag;
            record = next;
        };
        const existing = await readBlob(fenceBlob);
        if (existing) {
            let prior;
            try { prior = JSON.parse(existing.bytes.toString('utf8')); } catch (_) { fail('fence_record_invalid'); }
            if (prior?.schemaVersion !== 1 || prior.operationId !== operationId ||
                prior.keys?.account !== keys.account || prior.keys?.authority !== keys.authority) fail('fence_held_by_other_operation');
            // Same operation resuming after a crash or a retained failure.
            await write({ ...prior, holder, enteredAt: now() }, { ifMatch: existing.etag });
        } else {
            await write({ schemaVersion: 1, operationId, keys, holder, state: 'active', createdAt: now(), enteredAt: now(),
                leaseIds: { account: randomUUID(), authority: randomUUID() } }, { ifNoneMatch: '*' });
        }
        for (const name of ['account', 'authority']) {
            if (!UUID.test(record.leaseIds?.[name] || '')) fail('fence_record_invalid');
            held.set(keys[name], record.leaseIds[name]);
        }
        let settled = false, retaining = false;
        const assertOpen = () => { if (settled) fail('fence_settled'); };
        const releaseOwned = async () => {
            // Conditional deletion is the ownership decision, not a prior read:
            // a superseded holder must never release inherited target leases.
            // Failed/unknown deletion leaves them held for operator recovery.
            await fenceBlob.delete({ conditions: { ifMatch: etag } });
            settled = true;
            for (const name of ['account', 'authority']) await release(keys[name], record.leaseIds[name]);
        };
        const fence = Object.freeze({
            async assertCurrent() {
                assertOpen();
                const current = await readBlob(fenceBlob);
                if (!current || current.etag !== etag) fail('fence_lost');
                for (const name of ['account', 'authority']) await renew(keys[name], record.leaseIds[name]);
            },
            async retain() {
                assertOpen(); retaining = true;
                await write({ ...record, state: 'retained', retainedAt: now() }, { ifMatch: etag });
                settled = true;
            },
            async complete() {
                assertOpen();
                retaining = true; // Do not retry uncertain completion in finally.
                await releaseOwned();
            }
        });
        try {
            for (const name of ['account', 'authority']) await lease(keys[name], record.leaseIds[name]);
            return await work(fence);
        } finally {
            // Nothing was changed if the coordinator neither completed nor tried
            // to retain, so the target is released. A failed or uncertain
            // retain leaves the fence and leases in place for operator review.
            if (!settled && !retaining && !existing) {
                try {
                    await releaseOwned();
                } catch (_) { /* Unreleased leases require review, even if deletion acknowledgement was lost. */ }
            }
            held.delete(keys.account); held.delete(keys.authority);
        }
    }

    const blobs = Object.freeze({
        async readCurrent(key) {
            const found = await readBlob(blobFor(key));
            return found && { bytes: found.bytes, etag: found.etag };
        },
        async readVersion(key, versionId) {
            const found = await readBlob(blobFor(key).withVersion(versionId));
            return found ? found.bytes : null;
        },
        async remove(key, options) {
            const leaseId = leaseFor(key);
            await blobFor(key).delete({ conditions: { ...options?.conditions, leaseId } });
        },
        async restore(key, bytes, options) {
            const leaseId = leaseFor(key);
            await blobFor(key).uploadData(Buffer.from(bytes), { conditions: { ...options?.conditions },
                blobHTTPHeaders: { blobContentType: 'application/json' } });
            await lease(key, leaseId);
        }
    });

    return Object.freeze({ withExclusiveTarget, blobs });
}

module.exports = { createAzureEmptySignupResetBinding, FENCE_PREFIX };

