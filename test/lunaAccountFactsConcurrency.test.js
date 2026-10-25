'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { createLunaAccountFactsReader } = require('../api/shared/customerSignup/lunaAccountFacts');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { AccountPurposeError } = require('../api/shared/customerSignup/accountPurpose');

const AT = Date.parse('2026-10-16T00:00:00.000Z');
const ID = n => '30000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));
const unavailable = error => error instanceof AccountPurposeError && error.statusCode === 503 &&
    error.code === 'account_purpose_unavailable' && error.message === 'Account-purpose facts are unavailable.';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// Real allocator, parsers and readers; synthetic identity/enrollment/memory ports.
// A fixture identity is not a provider authentication or production account.
async function fixture() {
    const records = new Map(), customers = new Map(), purposes = new Map(), gates = new Map();
    const calls = { writes: 0, purpose: [] };
    let sequence = 100;
    const store = {
        async load(key) { return records.has(key) ? clone(records.get(key)) : null; },
        async create(key, record) {
            calls.writes++; records.set(key, { record: clone(record), version: '"synthetic-v1"' }); return true;
        },
        async replace() { calls.writes++; throw new Error('Unexpected synthetic write'); },
    };
    const allocator = createStarterAccountAllocator({ store, now: () => AT, newId: () => ID(++sequence),
        captureOwner: async () => null, readActivation: async () => null });
    const accounts = [];
    for (const [index, purpose, kind] of [[1, 'genuine_customer', 'customer'], [2, 'verified_test', 'test']]) {
        const tenantId = ID(index * 10), principalId = ID(index * 10 + 1);
        const subjectKey = tenantId + ':' + principalId, email = 'synthetic-' + index + '@example.invalid';
        const header = 'synthetic-luna-session-' + index;
        const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: ID(++sequence), subjectKey,
            providerKey: String(index).repeat(64), authenticationSha256: 'b'.repeat(64), email,
            organisationName: 'Synthetic account ' + index, accountType: 'company',
            createdAt: AT, verifiedAt: AT, expiresAt: AT + 3600000 };
        const account = await allocator.reserveInitial(proof), slot = account.organisations[0];
        customers.set(header, {
            details: { identity: { provider: 'entra-bff', isAuthenticated: true, tenantId, principalId,
                subjectKey, email }, expiresAt: new Date(AT + 3600000).toISOString() },
            current: { schemaVersion: 2, subjectKey, email, revision: 0, status: 'active',
                invitationDigest: 'c'.repeat(64), invitationId: ID(++sequence), tenantId: slot.tenantId,
                organisationId: slot.organisationId, termsVersion: 'synthetic-terms', termsDigest: 'd'.repeat(64),
                scheduleId: slot.scheduleId, scheduleDigest: 'e'.repeat(64), bindingId: slot.bindingId,
                accountType: 'company', expiresAt: AT + 86400000 },
        });
        purposes.set(account.accountId, { schemaVersion: 1, accountId: account.accountId, revision: 0,
            assignments: [{ accountId: account.accountId, purpose }] });
        accounts.push({ accountId: account.accountId, header, kind });
    }
    calls.writes = 0;
    const reader = createLunaAccountFactsReader({
        readCustomer: async header => customers.has(header) ? clone(customers.get(header)) : null,
        accountStore: store,
        readPurposeAssignments: async accountId => {
            calls.purpose.push(accountId);
            const snapshot = clone(purposes.get(accountId));
            const gate = gates.get(accountId);
            if (gate) {
                gates.delete(accountId); gate.entered.resolve(); await gate.resume.promise;
            }
            return snapshot;
        },
        now: () => AT + 1000,
    });
    return { reader, accounts, customers, purposes, calls, records,
        pause(accountId) {
            const gate = { entered: deferred(), resume: deferred() };
            gates.set(accountId, gate);
            return { entered: gate.entered.promise, release: () => gate.resume.resolve() };
        },
    };
}

function expected(account, kind = account.kind) {
    return { accountId: account.accountId, accountCreatedAt: null,
        classification: { kind, source: 'verified_nofries_record' } };
}

async function enteredBeforeCompletion(gate, pending) {
    await Promise.race([gate.entered, pending.then(() => { throw new Error('Read completed before the controlled overlap'); })]);
}

test('one shared Luna reader keeps concurrent customer/test accounts separate in either completion order', async () => {
    for (const delayedIndex of [0, 1]) {
        const h = await fixture(), slow = h.accounts[delayedIndex], fast = h.accounts[1 - delayedIndex];
        const before = clone([...h.records]), order = [], gate = h.pause(slow.accountId);
        const pending = h.reader.read(slow.header).then(result => { order.push(slow.accountId); return result; });
        try {
            await enteredBeforeCompletion(gate, pending);
            const other = await h.reader.read(fast.header); order.push(fast.accountId);
            assert.deepEqual(other, expected(fast));
            assert.deepEqual(order, [fast.accountId]);
            gate.release();
            const result = await pending;
            assert.deepEqual(result, expected(slow));
            assert.deepEqual(order, [fast.accountId, slow.accountId]);
            assert.notEqual(result, other); assert.notEqual(result.classification, other.classification);
            assert.ok(Object.isFrozen(result) && Object.isFrozen(result.classification));
            assert.ok(Object.isFrozen(other) && Object.isFrozen(other.classification));
            assert.deepEqual(h.calls.purpose, [slow.accountId, fast.accountId, fast.accountId, slow.accountId]);
            assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
        } finally { gate.release(); await pending.catch(() => {}); }
    }
});

test('revoking one overlapping account fails only its read and a fresh read recovers on the same adapter', async () => {
    const h = await fixture(), [revoked, other] = h.accounts, gate = h.pause(revoked.accountId);
    const before = clone([...h.records]), pending = h.reader.read(revoked.header);
    try {
        await enteredBeforeCompletion(gate, pending);
        h.customers.get(revoked.header).current.status = 'revoked';
        assert.deepEqual(await h.reader.read(other.header), expected(other));
        const rejected = assert.rejects(pending, unavailable);
        gate.release(); await rejected;
        h.customers.get(revoked.header).current.status = 'active';
        assert.deepEqual(await h.reader.read(revoked.header), expected(revoked));
        assert.deepEqual(await h.reader.read(other.header), expected(other));
        assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
    } finally { gate.release(); await pending.catch(() => {}); }
});

test('purpose drift in one overlapping read releases no stale fact and retry observes the new purpose', async () => {
    const h = await fixture(), [changed, other] = h.accounts, gate = h.pause(changed.accountId);
    const before = clone([...h.records]), pending = h.reader.read(changed.header);
    try {
        await enteredBeforeCompletion(gate, pending);
        const assignment = h.purposes.get(changed.accountId);
        assignment.revision++; assignment.assignments[0].purpose = 'verified_test';
        assert.deepEqual(await h.reader.read(other.header), expected(other));
        const rejected = assert.rejects(pending, unavailable);
        gate.release(); await rejected;
        assert.deepEqual(await h.reader.read(changed.header), expected(changed, 'test'));
        assert.deepEqual(await h.reader.read(other.header), expected(other));
        assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
    } finally { gate.release(); await pending.catch(() => {}); }
});
