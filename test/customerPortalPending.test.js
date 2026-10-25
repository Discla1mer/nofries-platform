'use strict';

const { webcrypto } = require('crypto');
const {
    MAX_RECORDS,
    MAX_STORAGE_BYTES,
    STORAGE_KEY,
    createStore,
    operationDisposition,
    payloadHash
} = require('../api/shared/protectedAssets/portalPending');

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

describe('customer portal refresh-safe pending operations', () => {
    test('treats pending 409 payloads as unresolved instead of terminal', () => {
        expect(operationDisposition({ status: 'pending', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' })).toBe('pending');
        expect(operationDisposition({ status: 'confirmation_required' })).toBe('pending');
        expect(operationDisposition({ status: 'known_absent' })).toBe('terminal');
        expect(operationDisposition({ status: 'rejected' })).toBe('terminal');
        expect(operationDisposition({ code: 'provider_operation_pending' })).toBe('unknown');
    });
    test('recovers an operation after refresh without storing ticket text or confirmation tokens', async () => {
        const storage = memoryStorage();
        const now = () => Date.parse('2026-08-31T02:00:00.000Z');
        const hash = await payloadHash({
            summary: 'Private ticket summary',
            description: 'Private ticket body',
            priority: 'urgent'
        }, webcrypto);
        const firstPage = createStore({ storage, customerScope: 'customer-one', now });
        firstPage.remember({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            action: 'create',
            target: '',
            payloadHash: hash,
            timestamp: now(),
            repeatConfirmationToken: 'must-never-persist',
            description: 'must-never-persist'
        });

        const serialized = storage.getItem(STORAGE_KEY);
        expect(serialized).not.toContain('Private ticket');
        expect(serialized).not.toContain('must-never-persist');
        expect(Object.keys(JSON.parse(serialized)[0]).sort()).toEqual([
            'action', 'customerScope', 'operationId', 'payloadHash', 'target', 'timestamp'
        ]);

        const refreshedPage = createStore({ storage, customerScope: 'customer-one', now });
        expect(refreshedPage.find('create', '')).toMatchObject({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            payloadHash: hash,
            customerScope: 'customer-one'
        });
    });

    test('validates and adopts a different durable operation ID for the same payload hash after network loss', async () => {
        const storage = memoryStorage();
        const now = () => Date.parse('2026-08-31T02:00:00.000Z');
        const hash = await payloadHash({ message: 'Private reply body' }, webcrypto);
        const store = createStore({ storage, customerScope: 'customer-one', now });
        const pending = store.remember({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            action: 'reply',
            target: 'T20260831.0012',
            payloadHash: hash,
            timestamp: now()
        });
        expect(store.adopt(pending, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', hash)).toMatchObject({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
        });
        expect(() => store.adopt(pending, 'not-an-operation-id', hash)).toThrow('durable operation');
        expect(() => store.adopt(pending, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'b'.repeat(64)))
            .toThrow('durable operation');
    });

    test('warns on stale metadata without forgetting an unresolved provider operation', () => {
        const storage = memoryStorage();
        const start = Date.parse('2026-08-30T00:00:00.000Z');
        createStore({ storage, customerScope: 'customer-one', now: () => start }).remember({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            action: 'reply',
            target: 'T20260831.0012',
            payloadHash: 'a'.repeat(64),
            timestamp: start
        });
        const otherCustomer = createStore({ storage, customerScope: 'customer-two', now: () => start });
        expect(otherCustomer.find('reply', 'T20260831.0012')).toBeNull();

        const expired = createStore({
            storage,
            customerScope: 'customer-one',
            now: () => start + (25 * 60 * 60 * 1000)
        });
        expect(expired.load()).toHaveLength(1);
        expect(expired.hadExpired()).toBe(true);

        const current = createStore({ storage, customerScope: 'customer-one', now: () => start });
        current.remember({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
            action: 'create',
            target: '',
            payloadHash: 'b'.repeat(64),
            timestamp: start
        });
        expect(() => current.clearTerminal('create', '', 'pending')).toThrow('Only a terminal operation');
        expect(current.find('create', '')).not.toBeNull();
        current.clearTerminal('create', '', 'completed');
        expect(current.find('create', '')).toBeNull();
    });

    test('rejects a 21st unresolved operation without dropping the newest or any existing customer scope', () => {
        const storage = memoryStorage();
        const now = () => Date.parse('2026-08-31T12:00:00.000Z');
        const firstCustomer = createStore({ storage, customerScope: 'customer-one', now });
        for (let index = 0; index < MAX_RECORDS; index += 1) {
            firstCustomer.remember({
                operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
                action: 'reply',
                target: `TICKET-${index}`,
                payloadHash: String(index % 10).repeat(64),
                timestamp: now() + index
            });
        }
        const before = storage.getItem(STORAGE_KEY);
        expect(firstCustomer.find('reply', `TICKET-${MAX_RECORDS - 1}`)).toMatchObject({
            operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(MAX_RECORDS - 1).padStart(12, '0')}`
        });

        const secondCustomer = createStore({ storage, customerScope: 'customer-two', now });
        expect(() => secondCustomer.remember({
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            action: 'create',
            target: '',
            payloadHash: 'b'.repeat(64),
            timestamp: now() + MAX_RECORDS
        })).toThrow('storage is full');
        expect(storage.getItem(STORAGE_KEY)).toBe(before);
        expect(firstCustomer.load()).toHaveLength(MAX_RECORDS);
        expect(secondCustomer.load()).toEqual([]);
    });

    test('rejects any invalid record and oversized serialized data without overwriting or sending past it', () => {
        const storage = memoryStorage();
        const valid = {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'create',
            target: '',
            payloadHash: 'a'.repeat(64),
            customerScope: 'customer-one',
            timestamp: Date.parse('2026-08-31T12:00:00.000Z')
        };
        const store = createStore({
            storage,
            customerScope: 'customer-one',
            now: () => valid.timestamp
        });
        const corrupted = JSON.stringify([valid, { invalid: true }]);
        storage.setItem(STORAGE_KEY, corrupted);
        expect(() => store.load()).toThrow('recovery data is invalid');
        expect(() => store.remember(Object.assign({}, valid, {
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        }))).toThrow('recovery data is invalid');
        expect(storage.getItem(STORAGE_KEY)).toBe(corrupted);

        const oversized = JSON.stringify([{ invalid: 'x'.repeat(MAX_STORAGE_BYTES) }]);
        storage.setItem(STORAGE_KEY, oversized);
        expect(() => store.load()).toThrow('safe recovery limit');
        expect(storage.getItem(STORAGE_KEY)).toBe(oversized);
    });

    test('rejects duplicate recovery slots without collapsing or overwriting either unresolved record', () => {
        const storage = memoryStorage();
        const timestamp = Date.parse('2026-08-31T12:00:00.000Z');
        const first = {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'reply',
            target: 'TICKET-ONE',
            payloadHash: 'a'.repeat(64),
            customerScope: 'customer-one',
            timestamp
        };
        const duplicate = Object.assign({}, first, {
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            payloadHash: 'b'.repeat(64),
            timestamp: timestamp + 1
        });
        const raw = JSON.stringify([first, duplicate]);
        storage.setItem(STORAGE_KEY, raw);
        const store = createStore({ storage, customerScope: 'customer-one', now: () => timestamp });

        expect(() => store.load()).toThrow('duplicate slot');
        expect(() => store.remember(first)).toThrow('duplicate slot');
        expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    });

    test('allows only same-payload replacement or durable-ID adoption in an occupied recovery slot', () => {
        const storage = memoryStorage();
        const now = () => Date.parse('2026-08-31T12:00:00.000Z');
        const store = createStore({ storage, customerScope: 'customer-one', now });
        const first = store.remember({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'create',
            target: '',
            payloadHash: 'a'.repeat(64),
            timestamp: now()
        });
        expect(() => store.remember(Object.assign({}, first, {
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        }))).toThrow('validated durable operation adoption');
        expect(store.adopt(first, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', first.payloadHash)).toMatchObject({
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        });
        expect(() => store.remember({
            operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            action: 'create',
            target: '',
            payloadHash: 'c'.repeat(64),
            timestamp: now()
        })).toThrow('different unresolved operation');
        expect(store.find('create', '')).toMatchObject({
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            payloadHash: 'a'.repeat(64)
        });
    });
});
