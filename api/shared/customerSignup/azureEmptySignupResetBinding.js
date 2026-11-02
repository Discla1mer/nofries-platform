'use strict';

// Operator port only. Every application writer must use the shared record lock
// before this binding is activated. Target deletion never deletes its lock.
const { AsyncLocalStorage } = require('node:async_hooks');
const { acquireRecordFence, readBlob, fenceKey } = require('./azureCustomerWriteFence');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { fenceCode: code }); };
function createAzureEmptySignupResetBinding({ accountContainer, authorityContainer } = {}) {
    for (const c of [accountContainer, authorityContainer]) {
        if (!c || typeof c.getBlockBlobClient !== 'function') fail('invalid_configuration');
    }
    const context = new AsyncLocalStorage();
    const containerFor = key => { fenceKey(key); return key.startsWith('customer-subjects/') ? authorityContainer : accountContainer; };
    const blobFor = key => containerFor(key).getBlockBlobClient(key);
    const current = async key => {
        const held = context.getStore();
        if (!held || held.closed || held.settling || !held.keys.includes(key)) fail('fence_required');
        await held.locks[held.keys.indexOf(key)].assertCurrent();
        if (held.closed || held.settling) fail('fence_required');
        return held;
    };
    const mutation = async (key, effect) => {
        const held = context.getStore();
        if (!held || held.closed || held.settling) fail('fence_required');
        held.pending++;
        try {
            await current(key);
            if (held.closed || held.settling) fail('fence_required');
            held.touched = true;
            try { return await effect(); } catch (error) { held.uncertain = true; throw error; }
        } finally { held.pending--; }
    };
    async function withExclusiveTarget(binding, work) {
        const operationId = binding?.request?.operationId, bindingSha256 = binding?.plan?.bindingSha256;
        const keys = [binding?.plan?.records?.account?.key, binding?.plan?.records?.authority?.key];
        if (!UUID.test(operationId || '') || !/^[a-f0-9]{64}$/.test(bindingSha256 || '') || typeof work !== 'function') fail('invalid_binding');
        keys.forEach(containerFor);
        if (!keys[0].startsWith('customer-starter/') || !keys[1].startsWith('customer-subjects/')) fail('invalid_binding');
        const owner = { operationId, bindingSha256 }, held = { keys, locks: [], closed: false,
            touched: false, uncertain: false, pending: 0, settling: false };
        try { for (const key of keys) held.locks.push(await acquireRecordFence(containerFor(key), key, owner)); }
        catch (error) {
            for (const lock of held.locks) { try { await lock.release(); } catch (_) {} }
            throw error;
        }
        let settled = false, uncertainMarker = false;
        const mark = async next => {
            uncertainMarker = true;
            for (const lock of held.locks) await lock.mark(next);
            uncertainMarker = false;
        };
        const settle = async next => {
            if (held.closed) fail('fence_settled');
            if (held.settling || held.pending) fail('fence_busy');
            if (next === null && held.uncertain) fail('mutation_outcome_unconfirmed');
            held.settling = true;
            try { await mark(next); } catch (error) { held.settling = false; throw error; }
            // Commit the outcome before cleanup. Release failures never turn a
            // completed operation back into a pending, supposedly retained one.
            settled = true; held.closed = true;
            if (!held.uncertain) for (const lock of held.locks) { try { await lock.release(); } catch (_) {} }
        };
        const fence = Object.freeze({
            async assertCurrent() { if (held.closed) fail('fence_settled'); for (const lock of held.locks) await lock.assertCurrent(); },
            retain: () => settle(owner), complete: () => settle(null)
        });
        try {
            await mark(owner);
            const result = await context.run(held, () => work(fence));
            if (held.pending) fail('fence_outcome_unconfirmed');
            return result;
        } finally {
            // A failed/uncertain marker write leaves all locks held. Otherwise an
            // untouched refusal can clear its markers, and a write keeps them.
            if (!settled && !uncertainMarker) {
                try { await settle(held.touched || held.locks.some(lock => lock.retained) ? owner : null); } catch (_) {}
            }
            held.closed = true;
        }
    }
    const blobs = Object.freeze({
        async readCurrent(key) { return readBlob(blobFor(key)); },
        async readVersion(key, versionId) { return (await readBlob(blobFor(key).withVersion(versionId)))?.bytes ?? null; },
        remove: (key, options) => mutation(key, () => blobFor(key).delete({ conditions: { ...options?.conditions } })),
        restore: (key, bytes, options) => mutation(key, () => blobFor(key).uploadData(Buffer.from(bytes),
            { conditions: { ...options?.conditions }, blobHTTPHeaders: { blobContentType: 'application/json' } }))
    });
    return Object.freeze({ withExclusiveTarget, blobs });
}
module.exports = { createAzureEmptySignupResetBinding };
