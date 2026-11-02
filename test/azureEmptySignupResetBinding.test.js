'use strict';
const { fixture, KEYS, storageError, uid, fenceKey } = require('./helpers/emptySignupResetFixture');
const { acquireRecordFence, withCustomerRecordWrite } = require('../api/shared/customerSignup/azureCustomerWriteFence');
const owner = (f, plan) => ({ operationId: f.request.operationId, bindingSha256: plan.bindingSha256 });
const target = (f, plan) => ({ request: f.request, plan });
const marker = guard => JSON.parse(guard.bytes).owner;

test('real coordinator resets and rolls back through persistent shared locks', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    expect(await reset.reset(f.request, plan)).toEqual({ status: 'reset', code: 'active_pointers_absent', phase: 'complete' });
    expect(f.starter.current.has(KEYS.account)).toBe(false);
    expect(f.subjects.current.has(KEYS.authority)).toBe(false);
    expect(f.guards().map(marker)).toEqual([null, null]);
    expect(await f.coordinator(f.bindingFor()).rollback(f.request, plan)).toEqual({ status: 'recovered', code: 'originals_restored', phase: 'complete' });
    for (const name of ['account', 'authority']) expect(f.containers[name].current.get(KEYS[name]).bytes).toEqual(f.original[name].bytes);
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).resolves.toBeDefined();
});

test('a second invocation cannot supersede a live holder, even for the same operation', async () => {
    const f = fixture(), first = f.bindingFor(), second = f.bindingFor();
    const { plan } = await f.coordinator(first).inventory(f.request), entered = jest.fn();
    await first.withExclusiveTarget(target(f, plan), async fence => {
        const leases = f.guards().map(g => g.leaseId);
        await expect(second.withExclusiveTarget(target(f, plan), entered)).rejects.toBeDefined();
        expect(entered).not.toHaveBeenCalled();
        expect(f.guards().map(g => g.leaseId)).toEqual(leases);
        for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toBeDefined();
        await fence.complete();
    });
    expect(f.guards().map(g => g.leaseId)).toEqual([null, null]);
});

test('deleted keys cannot be recreated, including after retain and before recovery', async () => {
    const f = fixture(), first = f.bindingFor(), { plan } = await f.coordinator(first).inventory(f.request);
    await first.withExclusiveTarget(target(f, plan), async fence => {
        await first.blobs.remove(KEYS.account, { conditions: { ifMatch: plan.records.account.etag } });
        await expect(f.appWrite('account')).rejects.toBeDefined();
        await fence.retain();
        await expect(first.blobs.restore(KEYS.account, f.original.account.bytes, { conditions: { ifNoneMatch: '*' } })).rejects.toThrow('fence_required');
    });
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toThrow('fence_held_by_other_operation');
    expect(f.guards().map(marker)).toEqual([owner(f, plan), owner(f, plan)]);
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('recovered');
});

test('failed completion keeps both records fenced even after one marker was cleared', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    await reset.reset(f.request, plan);
    const get = f.subjects.getBlockBlobClient;
    let failed = false;
    f.subjects.getBlockBlobClient = key => {
        const blob = get(key);
        return { ...blob, async uploadData(bytes, options) {
            if (!failed && key === fenceKey(KEYS.authority) && options?.conditions?.leaseId && JSON.parse(bytes).owner === null) {
                failed = true; throw storageError(500, 'ServerBusy');
            }
            return blob.uploadData(bytes, options);
        } };
    };
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('pending');
    expect(failed).toBe(true);
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toThrow('fence_held_by_other_operation');
    expect(f.guards().map(marker)).toEqual([owner(f, plan), owner(f, plan)]);
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('recovered');
});

test('a crash after deletion cannot be taken over until the old process is quiesced', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    // Model process loss without running its finally block. Only this synthetic
    // fixture breaks leases, after the old invocation is permanently stopped.
    for (const name of ['account', 'authority']) {
        const lock = await acquireRecordFence(f.containers[name], KEYS[name], owner(f, plan));
        await lock.mark(owner(f, plan));
    }
    f.starter.current.delete(KEYS.account);
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('blocked');
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toBeDefined();
    for (const guard of f.guards()) guard.leaseId = null;
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('recovered');
});

test('uncertain target effects retain leases and refuse automatic recovery', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    const get = f.subjects.getBlockBlobClient;
    f.subjects.getBlockBlobClient = key => ({ ...get(key), async delete() { throw storageError(503, 'ServerBusy'); } });
    expect((await reset.reset(f.request, plan)).status).toBe('pending');
    expect(f.guards().every(g => g.leaseId !== null)).toBe(true);
    expect((await f.coordinator(f.bindingFor()).rollback(f.request, plan)).status).toBe('blocked');
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toBeDefined();
});

test('uncertain application writes keep their lock across new writer instances', async () => {
    const f = fixture();
    await expect(withCustomerRecordWrite(f.starter, KEYS.account, async () => {
        throw storageError(503, 'ServerBusy');
    })).rejects.toBeDefined();
    await expect(f.appWrite('account')).rejects.toBeDefined();
});

test('completion cleanup failure never becomes a retained-but-writable pending result', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    const get = f.subjects.getBlockBlobClient;
    f.subjects.getBlockBlobClient = key => {
        const blob = get(key);
        return { ...blob, getBlobLeaseClient(id) { const lease = blob.getBlobLeaseClient(id);
            return { ...lease, async releaseLease() { throw storageError(503, 'ServerBusy'); } }; } };
    };
    expect((await reset.reset(f.request, plan)).status).toBe('reset');
    expect(f.guards().map(marker)).toEqual([null, null]);
    await expect(f.appWrite('authority')).rejects.toBeDefined();
});

test('retention is bound to the original plan and operation', async () => {
    const f = fixture(), binding = f.bindingFor(), { plan } = await f.coordinator(binding).inventory(f.request);
    await binding.withExclusiveTarget(target(f, plan), fence => fence.retain());
    for (const changed of [ { request: { ...f.request, operationId: uid(71) }, plan },
        { request: f.request, plan: { ...plan, bindingSha256: '0'.repeat(64) } } ]) {
        await expect(f.bindingFor().withExclusiveTarget(changed, jest.fn())).rejects.toThrow('fence_held_by_other_operation');
    }
    expect(f.guards().map(marker)).toEqual([owner(f, plan), owner(f, plan)]);
});

test('an untouched refusal releases its own locks and preserves the records', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    await f.appWrite('authority');
    expect(await reset.reset(f.request, plan)).toMatchObject({ status: 'blocked', code: 'record_changed' });
    expect(f.guards().map(marker)).toEqual([null, null]);
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).resolves.toBeDefined();
});

test('an untouched failed recovery never clears an earlier retained fence', async () => {
    const f = fixture(), binding = f.bindingFor(), { plan } = await f.coordinator(binding).inventory(f.request);
    await binding.withExclusiveTarget(target(f, plan), fence => fence.retain());
    await f.bindingFor().withExclusiveTarget(target(f, plan), async () => 'blocked');
    expect(f.guards().map(marker)).toEqual([owner(f, plan), owner(f, plan)]);
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toThrow('fence_held_by_other_operation');
});

test('ports refuse unrelated keys and writes outside their exact invocation', async () => {
    const f = fixture(), binding = f.bindingFor();
    for (const key of ['customer-starter/../x.json', 'customer-write-fences/v1/x.json', 'customer-subjects/x.json']) {
        await expect(binding.blobs.readCurrent(key)).rejects.toThrow('key_outside_target');
    }
    await expect(binding.blobs.remove(KEYS.account, {})).rejects.toThrow('fence_required');
    await expect(binding.blobs.restore(KEYS.account, Buffer.from('x'), {})).rejects.toThrow('fence_required');
});
