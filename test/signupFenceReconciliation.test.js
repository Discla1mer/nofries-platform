'use strict';
const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { randomUUID } = require('node:crypto');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
const { createSignupWriterFence, observeWrite, KEY, CONTRACT } = require('../api/shared/customerSignup/signupWriterFence');
const scopeId = 'a'.repeat(64), reset = { operationId: randomUUID(), planSha256: 'b'.repeat(64) };
const unavailable = /signup_writer_fence_unavailable/;
function gate() {
    let enter, resume;
    const entered = new Promise(resolve => { enter = resolve; });
    const resumed = new Promise(resolve => { resume = resolve; });
    return { entered, resume, async wait() { enter(); await resumed; } };
}
function fixture(hooks = {}) {
    const h = versionedBlobs();
    const container = { ...h.container, getBlockBlobClient(key) {
        const blob = h.container.getBlockBlobClient(key);
        return { ...blob, async uploadData(bytes, options) {
            await hooks.beforeUpload?.(key, bytes, options);
            const result = await blob.uploadData(bytes, options);
            await hooks.afterUpload?.(key, bytes, options); return result;
        } };
    } };
    const restart = () => createSignupWriterFence({ container, scopeId });
    return { ...h, restart, fence: restart(), record: () => JSON.parse(h.current.get(KEY).bytes) };
}
async function refuses(h) {
    let dispatched = false;
    for (let n = 0; n < 2; n++) {
        const fence = h.restart();
        await assert.rejects(fence.withWriter(() => { dispatched = true; }), unavailable);
        await assert.rejects(fence.withReset(reset, () => { dispatched = true; }), unavailable);
        // Model a further loss/break, not an implementation recovery action.
        h.leases.delete(KEY);
    }
    assert.equal(dispatched, false);
}
for (const loss of ['lease remains held', 'lease lost before late acknowledgement']) test('pending writer excludes reset/retry/restart: ' + loss, async () => {
    const h = fixture(), delayed = gate(); let account = null, authority = null, late;
    await assert.rejects(h.fence.withWriter(async () => {
        late = observeWrite(async () => { await delayed.wait(); account = 'old account'; }).catch(error => error);
        await delayed.entered; throw new Error('simulated process exit');
    }), /simulated process exit/);
    assert.equal(h.record().reset, null);
    if (loss.startsWith('lease lost')) h.leases.delete(KEY);
    await refuses(h); assert.ok(h.record().writer); delayed.resume(); assert.match((await late).message, unavailable);
    assert.equal(account, 'old account'); assert.equal(authority, null);
    // A physical partial effect may land, but no reset or successor can adopt it.
    assert.ok(h.record().writer); await refuses(h);
});
for (const point of ['before intent', 'after persisted intent']) test('unknown intent acknowledgement dispatches no application write: ' + point, async () => {
    const hook = async (key, bytes, options) => {
        if (key === KEY && options.conditions?.leaseId && JSON.parse(bytes).writer) throw new Error('unknown intent');
    };
    const h = fixture({ [point === 'before intent' ? 'beforeUpload' : 'afterUpload']: hook }); let dispatched = false;
    await assert.rejects(h.fence.withWriter(() => { dispatched = true; }), /unknown intent/);
    assert.equal(dispatched, false); assert.equal(h.leases.has(KEY), true);
    if (point === 'after persisted intent') { h.leases.delete(KEY); await refuses(h); }
});
test('successful intent is durable before application dispatch and cleared only after joined success', async () => {
    const h = fixture();
    assert.equal(await h.fence.withWriter(async () => {
        assert.ok(h.record().writer); await observeWrite(async () => { assert.ok(h.record().writer); }); return 'done';
    }), 'done');
    assert.equal(h.record().writer, null); assert.equal(h.record().reset, null); assert.equal(h.leases.has(KEY), false);
    await h.restart().withWriter(() => 'retry');
});
test('infinite lease is never expired by wall clock or a retry deadline', async () => {
    const h = fixture(); await h.fence.withReset(reset, () => 'retained');
    const originalNow = Date.now;
    try { Date.now = () => Number.MAX_SAFE_INTEGER; await assert.rejects(h.restart().withWriter(() => {}), unavailable); }
    finally { Date.now = originalNow; }
    assert.deepEqual(h.record().reset, reset);
});
test('lost lease after a joined write cannot clear durable intent or report success', async () => {
    const h = fixture(); let effects = 0;
    await assert.rejects(h.fence.withWriter(async () => {
        await observeWrite(async () => { effects++; }); h.leases.delete(KEY);
    }), unavailable);
    assert.equal(effects, 1); assert.ok(h.record().writer); await refuses(h);
});
test('retained reset blocks writers and same-operation restart even after lease loss', async () => {
    const h = fixture(); await h.fence.withReset(reset, () => 'pending');
    h.leases.delete(KEY); await refuses(h); assert.deepEqual(h.record().reset, reset);
});
test('completion refuses a pending observed write; late acknowledgement cannot clear reset', async () => {
    const h = fixture(), delayed = gate(); let late;
    await assert.rejects(h.fence.withReset(reset, async control => {
        late = observeWrite(() => delayed.wait()).catch(error => error); await delayed.entered;
        await control.complete();
    }), unavailable);
    h.leases.delete(KEY); await refuses(h); delayed.resume(); await late;
    assert.deepEqual(h.record().reset, reset); await refuses(h);
});
test('completion requests are terminal and only successful owner settlement clears reset', async () => {
    const h = fixture(); let effects = 0;
    await h.fence.withReset(reset, async control => {
        await control.complete(); assert.deepEqual(h.record().reset, reset);
        await assert.rejects(observeWrite(() => { effects++; }), unavailable);
        await assert.rejects(control.complete(), unavailable);
    });
    assert.equal(effects, 0); assert.equal(h.record().reset, null);
});
test('callback failure after awaited completion retains reset across restart and lease loss', async () => {
    const h = fixture();
    await assert.rejects(h.fence.withReset(reset, async control => { await control.complete(); throw new Error('exit after complete'); }), /exit after complete/);
    h.leases.delete(KEY); await refuses(h); assert.deepEqual(h.record().reset, reset);
});
test('a stale final clear cannot overwrite a new holder after lease loss', async () => {
    const delayed = gate(); let enabled = true;
    const h = fixture({ async beforeUpload(key, bytes, options) {
        const value = JSON.parse(bytes);
        if (enabled && key === KEY && options.conditions?.leaseId && !value.writer && !value.reset) await delayed.wait();
    } });
    const old = assert.rejects(h.fence.withWriter(() => 'joined'), /synthetic condition/);
    await delayed.entered; h.leases.delete(KEY);
    // An independent successor sees the persisted intent and cannot erase it.
    await assert.rejects(h.restart().withReset(reset, () => {}), unavailable);
    const before = h.current.get(KEY); enabled = false; delayed.resume(); await old;
    assert.equal(h.current.get(KEY), before); assert.ok(h.record().writer);
});
for (const schema of ['legacy idle', 'legacy retained', 'malformed writer']) test('unqualified control quarantined without auto migration: ' + schema, async () => {
    const h = fixture();
    h.put(KEY, schema === 'malformed writer'
        ? { schemaVersion: 2, writerContract: CONTRACT, scopeId, writer: { operationId: 'forged' }, reset: null }
        : { schemaVersion: 1, writerContract: CONTRACT, scopeId, reset: schema === 'legacy retained' ? reset : null });
    const before = h.current.get(KEY); await refuses(h); assert.equal(h.current.get(KEY), before);
});
