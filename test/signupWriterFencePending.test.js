'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = global.test || require('node:test');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
const { createSignupWriterFence, observeContainer, observeWrite, observePool, KEY } = require('../api/shared/customerSignup/signupWriterFence');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createStarterAccountAllocator, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { createSignupIndexMaintenance, WRITER_CONTRACT } = require('../api/shared/dashboardAdmin/signupIndexMaintenance');
const scopeId = 'a'.repeat(64), marker = { operationId: randomUUID(), planSha256: 'b'.repeat(64) };
const unavailable = /signup_writer_fence_unavailable/;
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function gate() {
    const entered = deferred(), resume = deferred();
    return { entered: entered.promise, resume: resume.resolve, async wait() { entered.resolve(); await resume.promise; } };
}
function harness(hooks = {}) {
    const h = versionedBlobs(); let renewals = 0;
    const container = { ...h.container, getBlockBlobClient(key) {
        const blob = h.container.getBlockBlobClient(key);
        return { ...blob, async uploadData(...args) {
            await hooks.upload?.(key, ...args); return blob.uploadData(...args);
        }, getBlobLeaseClient(id) {
            const lease = blob.getBlobLeaseClient(id);
            return { ...lease, async renewLease(...args) {
                const value = await lease.renewLease(...args);
                await hooks.renew?.(++renewals); return value;
            }, async releaseLease(...args) { await hooks.release?.(); return lease.releaseLease(...args); } };
        } };
    } };
    const fence = createSignupWriterFence({ container, scopeId });
    return { ...h, container, fence, guarded: observeContainer(container, fence) };
}
async function blocked(h) {
    assert.equal(h.leases.has(KEY), true, 'common lease must remain held');
    const other = createSignupWriterFence({ container: h.container, scopeId }); let called = false;
    await assert.rejects(other.withWriter(() => { called = true; }), unavailable);
    await assert.rejects(other.withReset(marker, () => { called = true; }), unavailable);
    assert.equal(called, false);
}
async function canonicalAccount() {
    const at = Date.parse('2026-10-21T00:00:00.000Z');
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: randomUUID(),
        subjectKey: randomUUID() + ':' + randomUUID(), providerKey: 'c'.repeat(64), authenticationSha256: 'd'.repeat(64),
        email: 'synthetic@example.test', organisationName: 'Synthetic Organisation', accountType: 'company',
        createdAt: at, verifiedAt: at, expiresAt: at + 3600000 };
    const store = new AzureStarterAccountStore(versionedBlobs().container);
    const allocator = createStarterAccountAllocator({ store, now: () => at,
        readActivation: async () => null, captureOwner: async () => null });
    return { key: starterAccountKey(proof.email), account: await allocator.reserveInitial(proof) };
}
for (const kind of ['create', 'replace']) test('real index timeout retains the common lease through late account ' + kind, async () => {
    const { key, account } = await canonicalAccount(), blobKey = 'customer-starter/' + key + '.json';
    const upload = gate(), landed = deferred(); let enabled = false;
    const h = harness({ async upload(name) { if (enabled && name === blobKey) await upload.wait(); } });
    const raw = h.container.getBlockBlobClient;
    h.container.getBlockBlobClient = name => { const blob = raw(name); return { ...blob, async uploadData(...args) {
        const result = await blob.uploadData(...args); if (enabled && name === blobKey) landed.resolve(); return result;
    } }; };
    const store = new AzureStarterAccountStore(h.guarded);
    if (kind === 'replace') await store.create(key, account);
    const before = h.current.get(blobKey), instanceId = randomUUID(), restoreEpoch = randomUUID();
    const index = createSignupIndexMaintenance({ container: h.guarded, accountStore: store, provider: 'external',
        populationId: 'synthetic-population', indexId: 'synthetic-index', instanceId, sourceBindingSha256: 'b'.repeat(64),
        writerContract: WRITER_CONTRACT, readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }),
        clock: () => '2026-10-21T00:00:00.000Z', newId: randomUUID, requestBudgetMs: 1000 });
    await index.rebuild({ authoriseMaintenance: async () => true }); enabled = true;
    const rejected = assert.rejects(h.fence.withWriter(() => kind === 'create' ? index.accountStore.create(key, account)
        : index.accountStore.replace(key, before.etag, account)), /dashboard_admin_signup_index_unavailable/);
    await upload.entered; await rejected;
    try { assert.equal(h.current.get(blobKey), before); await blocked(h); }
    finally { upload.resume(); await landed.promise; await turn(); }
    assert.notEqual(h.current.get(blobKey), before); await blocked(h);
});

for (const stage of ['nested entry', 'observed pre-check', 'upload', 'post-ack check', 'COMMIT']) {
    for (const exit of ['race', 'all', 'detached']) test(stage + ' pending at callback ' + exit + ' retains the owner', async () => {
        const paused = gate(), finish = deferred(), reason = new Error('synthetic callback failure');
        const renewal = { 'nested entry': 1, 'observed pre-check': 2, 'post-ack check': 3 }[stage];
        const h = harness({ async renew(n) { if (n === renewal) await paused.wait(); },
            async upload(key) { if (stage === 'upload' && key === 'target') await paused.wait(); } });
        const queries = [];
        const pool = observePool({ end() {}, async connect() { return { release() {}, async query(sql) {
            if (sql === 'COMMIT') await paused.wait(); queries.push(sql);
        } }; } });
        const client = await pool.connect(); let late;
        const operation = h.fence.withWriter(async () => {
            late = stage === 'COMMIT' ? client.query('COMMIT') : h.guarded.getBlockBlobClient('target').uploadData(Buffer.from('{}'));
            // Attach immediately, including detached work; observe its final refusal below.
            const observed = late.catch(async error => {
                if (stage === 'COMMIT') await client.query('ROLLBACK');
                return error;
            }); late = observed;
            if (exit === 'detached') { await paused.entered; return 'unexpected success'; }
            const failure = finish.promise.then(() => { throw reason; });
            return exit === 'race' ? Promise.race([observed, failure]) : Promise.all([observed, failure]);
        });
        const rejected = assert.rejects(operation, exit === 'detached' ? unavailable : error => error === reason);
        await paused.entered; finish.resolve(); await rejected;
        try { await blocked(h); } finally { paused.resume(); }
        assert.match((await late).message, unavailable);
        assert.equal(h.current.has('target'), ['upload', 'post-ack check'].includes(stage));
        assert.deepEqual(queries, stage === 'COMMIT' ? ['COMMIT', 'ROLLBACK'] : []);
        await blocked(h);
    });
}

for (const outcome of ['success', 'failure', 'swallowed failure']) test('late observed ' + outcome + ' cannot unlock a closed owner', async () => {
    const h = harness(), paused = gate(), reason = new Error('synthetic callback failure'); let late;
    await assert.rejects(h.fence.withWriter(async () => {
        late = observeWrite(async () => { await paused.wait(); if (outcome !== 'success') throw new Error('synthetic upload failure'); });
        late = late.catch(error => outcome === 'swallowed failure' ? null : error);
        await paused.entered; throw reason;
    }), error => error === reason);
    await blocked(h); paused.resume(); await late; await blocked(h);
});

for (const mode of ['nested', 'observed', 'complete']) test('owner closes between check resolution and ' + mode + ' dispatch', async () => {
    const entered = deferred(), renewal = deferred(), callback = deferred();
    const h = versionedBlobs(); let dispatches = 0, late;
    const container = { ...h.container, getBlockBlobClient(key) {
        const blob = h.container.getBlockBlobClient(key);
        return { ...blob, uploadData(...args) {
            if (args[1]?.conditions?.leaseId && JSON.parse(args[0]).reset === null) dispatches++;
            return blob.uploadData(...args);
        }, getBlobLeaseClient(id) {
            const lease = blob.getBlobLeaseClient(id);
            return { ...lease, renewLease() { entered.resolve(); return renewal.promise; } };
        } };
    } };
    const fence = createSignupWriterFence({ container, scopeId });
    const body = control => {
        late = (mode === 'nested' ? fence.withWriter(() => { dispatches++; }) : mode === 'observed'
            ? observeWrite(() => { dispatches++; }) : control.complete()).catch(error => error);
        return callback.promise;
    };
    const owner = mode === 'complete' ? fence.withReset(marker, body) : fence.withWriter(body);
    const rejected = assert.rejects(owner, unavailable);
    await entered.promise;
    // Queue check() first, then close the owner before its awaiting caller resumes.
    renewal.resolve(); callback.resolve();
    await rejected; assert.match((await late).message, unavailable);
    assert.equal(dispatches, 0); await blocked({ ...h, container });
    if (mode === 'complete') assert.deepEqual(await fence.readReset(), marker);
});

for (const stage of ['pre-check', 'clear', 'post-check']) {
    for (const exit of ['success', 'failure']) test('detached reset completion at ' + stage + ' with callback ' + exit, async () => {
        const paused = gate(), reason = new Error('synthetic reset failure'); let completion;
        const h = harness({ async renew(n) { if (n === ({ 'pre-check': 1, 'post-check': 2 }[stage])) await paused.wait(); },
            async upload(key, bytes, options) {
                if (stage === 'clear' && key === KEY && options.conditions?.leaseId && JSON.parse(bytes).reset === null) await paused.wait();
            } });
        const result = h.fence.withReset(marker, async control => {
            completion = control.complete().catch(error => error); await paused.entered;
            if (exit === 'failure') throw reason;
        });
        await assert.rejects(result, exit === 'success' ? unavailable : error => error === reason);
        try { await blocked(h); } finally { paused.resume(); }
        assert.match((await completion).message, unavailable); await blocked(h);
        // An already-dispatched clear can land. The retained lease, not marker bytes, excludes successors.
        assert.deepEqual(await h.fence.readReset(), stage === 'pre-check' ? marker : null);
    });
}

test('settled conflicts reconcile; settled swallowed uncertainty retains without changing the callback result', async () => {
    for (const error of [Object.assign(new Error('conflict'), { statusCode: 412, code: 'ConditionNotMet' }),
        Object.assign(new Error('exists'), { statusCode: 409, code: 'BlobAlreadyExists' }), new Error('uncertain')]) {
        const h = harness();
        assert.equal(await h.fence.withWriter(async () => {
            await observeWrite(async () => { throw error; }).catch(() => {}); return 'reconciled';
        }), 'reconciled');
        assert.equal(h.leases.has(KEY), error.message === 'uncertain');
    }
});
test('cleanup release failures do not replace the original callback failure', async () => {
    for (const fails of [false, true]) {
        const reason = new Error('synthetic callback failure'), h = harness({ async release() { throw new Error('synthetic release failure'); } });
        await assert.rejects(h.fence.withWriter(() => { if (fails) throw reason; return 'ok'; }), fails ? error => error === reason : unavailable);
        await blocked(h);
    }
});
test('joined nesting, reset completion and detached stale control preserve normal ownership', async () => {
    const h = harness(); let saved;
    assert.equal(await h.fence.withWriter(() => h.fence.withWriter(async () => {
        await h.guarded.getBlockBlobClient('target').uploadData(Buffer.from('{}')); return 'joined';
    })), 'joined');
    assert.equal(h.leases.has(KEY), false);
    await h.fence.withReset(marker, async control => { saved = control; await control.complete(); });
    assert.equal(h.leases.has(KEY), false); assert.equal(await h.fence.readReset(), null);
    const before = h.current.get(KEY);
    await assert.rejects(saved.complete(), unavailable); assert.equal(h.current.get(KEY), before);
});
