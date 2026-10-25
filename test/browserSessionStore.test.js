'use strict';
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { MemoryBrowserSessionStore, AzureBlobBrowserSessionStore } = require('../api/shared/browserSessionStore');

const id = Buffer.alloc(32, 31).toString('base64url');
const state = Buffer.alloc(32, 32).toString('base64url');
const record = purpose => ({ v: 1, kind: 'oidc_transaction', state,
    customerProviderKey: 'a'.repeat(64), customerTransport: 'external', ...(purpose ? { customerPurpose: purpose } : {}) });
function azure(initial) {
    const calls = []; let current = initial, locked = false, ambiguousDelete = false;
    const missing = () => Object.assign(new Error('synthetic missing'), { statusCode: 404 });
    const blob = {
        getBlobLeaseClient: leaseId => ({ async acquireLease() {
            calls.push('lease');
            if (!current) throw missing();
            if (locked) throw Object.assign(new Error('synthetic contention'), { statusCode: 409 });
            locked = true; return { leaseId };
        }, async releaseLease() { calls.push('release'); locked = false; } }),
        async download() {
            calls.push('read'); if (!current) throw missing();
            return { readableStreamBody: Readable.from([Buffer.from(JSON.stringify(current))]) };
        },
        async delete() {
            calls.push('delete'); current = null; locked = false;
            if (ambiguousDelete) throw new Error('synthetic response lost after delete');
        }
    };
    return { store: new AzureBlobBrowserSessionStore({ containerClient: {
        getProperties: async () => ({}), getBlockBlobClient: () => blob
    } }), calls, loseDeleteResponse() { ambiguousDelete = true; } };
}

for (const purpose of [undefined, 'retained_read']) {
    test(`memory consumption preserves a competing ${purpose || 'ordinary'} transaction`, async () => {
        const store = new MemoryBrowserSessionStore(), value = record(purpose);
        await store.createTransaction(id, value);
        assert.deepEqual(await store.consumeTransaction(id, state, purpose ? undefined : 'retained_read'), { matched: false, record: null });
        assert.equal(store.transactions.size, 1);
        assert.deepEqual(await store.consumeTransaction(id, state, purpose), { matched: true, record: value });
        assert.equal(await store.consumeTransaction(id, state, purpose), null);
    });
    test(`Azure purpose mismatch releases its lease; genuine ${purpose || 'ordinary'} consumption is one use`, async () => {
        const value = record(purpose), h = azure(value);
        assert.deepEqual(await h.store.consumeTransaction(id, state, purpose ? undefined : 'retained_read'), { matched: false, record: null });
        assert.deepEqual(h.calls, ['lease', 'read', 'release']);
        const results = await Promise.all([h.store.consumeTransaction(id, state, purpose), h.store.consumeTransaction(id, state, purpose)]);
        assert.deepEqual(results.filter(Boolean), [{ matched: true, record: value }]);
        assert.equal(results.filter(v => v === null).length, 1);
        assert.equal(h.calls.filter(v => v === 'delete').length, 1);
    });
}

test('setup cancellation does not lease or delete a retained transaction', async () => {
    const h = azure(record('retained_read'));
    assert.equal(await h.store.cancelTransaction(id, { customerTransport: 'external', customerProviderKey: 'a'.repeat(64) }), false);
    assert.deepEqual(h.calls, ['read']);
    assert.equal((await h.store.consumeTransaction(id, state, 'retained_read')).matched, true);
});

test('uncertain Azure deletion returns no transaction and cannot replay the provider exchange', async () => {
    const h = azure(record('retained_read')); h.loseDeleteResponse();
    await assert.rejects(h.store.consumeTransaction(id, state, 'retained_read'), { code: 'browser_auth_store_unavailable' });
    assert.equal(await h.store.consumeTransaction(id, state, 'retained_read'), null);
    assert.equal(h.calls.filter(v => v === 'delete').length, 1);
});

test('unknown consumption purposes are refused before storage effects', async () => {
    const h = azure(record('retained_read'));
    await assert.rejects(h.store.consumeTransaction(id, state, 'dashboard'), { code: 'browser_auth_store_record_invalid' });
    assert.deepEqual(h.calls, []);
});
