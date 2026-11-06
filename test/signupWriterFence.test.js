'use strict';
const { createSignupWriterFence, observeWrite, observeContainer, observePool, KEY } = require('../api/shared/customerSignup/signupWriterFence');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
const op = '10000000-0000-4000-8000-000000000001', scopeId = 'a'.repeat(64);
function fixture() { const h = versionedBlobs(); return { ...h, fence: createSignupWriterFence({ container: h.container, scopeId }) }; }
test('independent writers and reset cannot enter the same durable lease', async () => {
    const h = fixture(), other = createSignupWriterFence({ container: h.container, scopeId });
    let entered, finish;
    const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { finish = resolve; });
    const running = h.fence.withWriter(async () => { entered(); await wait; });
    await ready;
    await expect(other.withWriter(async () => {})).rejects.toThrow('signup_writer_fence_unavailable');
    await expect(other.withReset({ operationId: op, planSha256: scopeId }, async () => {})).rejects.toThrow();
    finish(); await running;
    expect(h.leases.size).toBe(0);
    await other.withWriter(async () => {});
});
test('nested setup and claim ports share the same lease', async () => {
    const h = fixture(); let called = 0;
    await h.fence.withWriter(() => h.fence.withWriter(async () => { called++; }));
    expect(called).toBe(1); expect(h.calls.filter(c => c[0] === 'lease')).toHaveLength(1);
});
test('reset excludes creating a missing pointer and releases only on explicit completion', async () => {
    const h = fixture();
    await h.fence.withReset({ operationId: op, planSha256: scopeId }, async guard => {
        await expect(h.fence.withWriter(() => h.container.getBlockBlobClient('account').uploadData(Buffer.from('x')))).rejects.toThrow();
        expect((await h.fence.readReset()).operationId).toBe(op); await guard.complete();
    });
    await h.fence.withWriter(() => h.container.getBlockBlobClient('account').uploadData(Buffer.from('x')));
    expect(h.current.has('account')).toBe(true);
});
test('crash or ambiguous effect retains the non-expiring lease and never retries or breaks it', async () => {
    const h = fixture();
    await expect(h.fence.withReset({ operationId: op, planSha256: scopeId }, async () => { throw new Error('synthetic uncertainty'); })).rejects.toThrow();
    expect(h.leases.has(KEY)).toBe(true);
    await expect(h.fence.withWriter(async () => {})).rejects.toThrow();
    await expect(h.fence.withReset({ operationId: op, planSha256: scopeId }, async () => {})).rejects.toThrow();
});
test('swallowed remote-write errors still retain the lease and forbid subsequent effects', async () => {
    const h = fixture(); const later = jest.fn();
    await h.fence.withWriter(async () => {
        try { await observeWrite(async () => { throw new Error('synthetic timeout'); }); } catch (_) { /* existing reconciliation */ }
        await expect(observeWrite(later)).rejects.toThrow();
    });
    expect(later).not.toHaveBeenCalled(); expect(h.leases.has(KEY)).toBe(true);
});
test('SDK and database wrappers observe failures before caller error translation', async () => {
    const h = fixture(), wrapped = observeContainer({ getBlockBlobClient: () => ({ uploadData: async () => { throw new Error(); } }) });
    await h.fence.withWriter(async () => { try { await wrapped.getBlockBlobClient('x').uploadData(Buffer.from('x')); } catch (_) {} });
    expect(h.leases.has(KEY)).toBe(true);
    const next = fixture(), query = jest.fn(async sql => { if (sql === 'COMMIT') throw new Error(); return {}; });
    const pool = observePool({ connect: async () => ({ query, release() {} }), end() {} });
    await next.fence.withWriter(async () => { const client = await pool.connect(); try { await client.query('COMMIT'); } catch (_) {} await client.query('ROLLBACK'); });
    expect(query).toHaveBeenCalledWith('ROLLBACK', undefined); expect(next.leases.has(KEY)).toBe(true);
});

test('validation failure without an observed ambiguous write releases the writer lease', async () => {
    const h = fixture();
    await expect(h.fence.withWriter(async () => { throw new Error('synthetic invalid request'); })).rejects.toThrow();
    expect(h.leases.size).toBe(0); await h.fence.withWriter(async () => {});
});
