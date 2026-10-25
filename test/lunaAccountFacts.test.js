'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { createLunaAccountFactsReader } = require('../api/shared/customerSignup/lunaAccountFacts');
const { createStarterAccountAllocator, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { AccountPurposeError } = require('../api/shared/customerSignup/accountPurpose');

// Actual allocator, parsers and account-purpose reader; all authority, identity,
// enrollment and storage ports below are synthetic. No flags authenticate users.
const AT = Date.parse('2026-10-16T00:00:00.000Z');
const TENANT = '10000000-0000-4000-8000-000000000001';
const PRINCIPAL = '10000000-0000-4000-8000-000000000002';
const SUBJECT = TENANT + ':' + PRINCIPAL;
const HEADER = 'synthetic-luna-current-customer';
const ID = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture() {
    const records = new Map(), calls = { customer: 0, account: 0, purpose: 0, writes: 0 };
    let sequence = 0, clock = AT, assignments = null, purposeHook = null, customerHook = null;
    const store = {
        async load(key) { calls.account++; return records.has(key) ? clone(records.get(key)) : null; },
        async create(key, record) { calls.writes++; records.set(key, { record: clone(record), version: '"synthetic-v1"' }); return true; },
        async replace() { calls.writes++; throw new Error('Unexpected synthetic write'); },
    };
    const allocator = createStarterAccountAllocator({ store, now: () => clock, newId: () => ID(++sequence),
        captureOwner: async () => null, readActivation: async () => null });
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: ID(100), subjectKey: SUBJECT,
        providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), email: 'synthetic@example.invalid',
        organisationName: 'Synthetic account', accountType: 'company', createdAt: AT, verifiedAt: AT, expiresAt: AT + 3600000 };
    const account = await allocator.reserveInitial(proof), slot = account.organisations[0];
    clock += 1000;
    let customer = {
        details: { identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT,
            principalId: PRINCIPAL, subjectKey: SUBJECT, email: proof.email }, expiresAt: new Date(AT + 3600000).toISOString() },
        current: { schemaVersion: 2, subjectKey: SUBJECT, email: proof.email, revision: 0, status: 'active',
            invitationDigest: 'c'.repeat(64), invitationId: ID(101), tenantId: slot.tenantId, organisationId: slot.organisationId,
            termsVersion: 'synthetic-terms', termsDigest: 'd'.repeat(64), scheduleId: slot.scheduleId,
            scheduleDigest: 'e'.repeat(64), bindingId: slot.bindingId, accountType: 'company', expiresAt: AT + 86400000 },
        id: 'synthetic-private-session-id',
    };
    const options = {
        readCustomer: async header => {
            calls.customer++;
            if (customerHook) customerHook(calls.customer);
            return header === HEADER && customer !== null ? clone(customer) : null;
        },
        accountStore: store,
        readPurposeAssignments: async accountId => {
            calls.purpose++; assert.equal(accountId, account.accountId);
            if (purposeHook) purposeHook(calls.purpose);
            return clone(assignments);
        },
        now: () => clock,
    };
    calls.account = 0; calls.writes = 0;
    return { account, slot, calls, records, options, store,
        reader: extra => createLunaAccountFactsReader({ ...options, ...extra }),
        assign(...purposes) { assignments = { schemaVersion: 1, accountId: account.accountId, revision: 0,
            assignments: purposes.map(purpose => ({ accountId: account.accountId, purpose })) }; },
        setAssignments(value) { assignments = clone(value); },
        mutateCustomer(fn) { fn(customer); }, setCustomer(value) { customer = clone(value); },
        onPurpose(fn) { purposeHook = fn; }, onCustomer(fn) { customerHook = fn; },
        setClock(value) { clock = value; },
        mutateAccount(fn) { fn(records.get(starterAccountKey(proof.email)).record); },
    };
}

const unavailable = error => error instanceof AccountPurposeError && error.statusCode === 503 &&
    error.code === 'account_purpose_unavailable' && error.message === 'Account-purpose facts are unavailable.';

test('actual stable-account reads translate explicit purpose without exposing profile, identity or grants', async () => {
    for (const [purpose, kind] of [['genuine_customer', 'customer'], ['verified_test', 'test']]) {
        const h = await fixture(); h.assign(purpose);
        const reader = h.reader(), before = clone([...h.records]);
        assert.deepEqual(Object.keys(reader), ['read']);
        const result = await reader.read(HEADER);
        assert.deepEqual(result, { accountId: h.account.accountId, accountCreatedAt: null,
            classification: { kind, source: 'verified_nofries_record' } });
        assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.classification), true);
        for (const privateValue of [SUBJECT, 'synthetic@example.invalid', HEADER, 'synthetic-private-session-id']) {
            assert.ok(!JSON.stringify(result).includes(privateValue));
        }
        assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
        assert.deepEqual([h.calls.customer, h.calls.account, h.calls.purpose], [2, 2, 2]);
    }
});

test('missing, explicit unknown and conflicting genuine/test assignments remain unknown without changing signup data', async () => {
    const h = await fixture(), before = clone([...h.records]);
    for (const purposes of [null, [], ['unknown'], ['genuine_customer', 'verified_test'],
        ['verified_test', 'genuine_customer'], ['genuine_customer', 'unknown'], ['verified_test', 'unknown']]) {
        if (purposes === null) h.setAssignments(null); else h.assign(...purposes);
        assert.deepEqual((await h.reader().read(HEADER)).classification, { kind: 'unknown', source: 'unknown' });
    }
    const noEnrollment = createLunaAccountFactsReader({ readCustomer: h.options.readCustomer, accountStore: h.store, now: h.options.now });
    assert.equal((await noEnrollment.read(HEADER)).classification.kind, 'unknown');
    assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
});

test('recorded reservation and subject-RLS preparation times remain unresolved canonical creation', async () => {
    const h = await fixture(); h.assign('genuine_customer'); const queries = [];
    const database = { async withTenantTransaction(tenantId, work) {
        assert.equal(tenantId, h.slot.tenantId);
        return work({ async query(sql, params) {
            queries.push({ sql, params });
            return { rows: sql.includes('set_config') ? [] : [{ account_id: h.account.accountId,
                subject_key: SUBJECT, account_type: 'company', created_at: new Date(AT + 500) }] };
        } });
    } };
    const result = await h.reader({ database }).read(HEADER);
    assert.equal(result.accountCreatedAt, null); assert.equal(result.classification.kind, 'customer');
    assert.deepEqual(queries[0].params, [SUBJECT]); assert.deepEqual(queries[1].params, [h.account.accountId, SUBJECT]);
    assert.ok(queries.every(({ sql }) => /^SELECT\b/.test(sql)));
    assert.deepEqual(Object.keys(result), ['accountId', 'accountCreatedAt', 'classification']);
});

test('anonymous or missing-account reads return null rather than facts from caller account IDs or flags', async () => {
    const h = await fixture(); h.assign('verified_test');
    assert.equal(await h.reader().read('not-a-session'), null);
    assert.deepEqual([h.calls.account, h.calls.purpose], [0, 0]);
    await assert.rejects(h.reader().read({ cookie: HEADER, accountId: h.account.accountId, verified: true }), unavailable);
    h.records.clear(); assert.equal(await h.reader().read(HEADER), null); assert.equal(h.calls.purpose, 0);
    assert.throws(() => createLunaAccountFactsReader({ accountId: h.account.accountId, verified: true }), TypeError);
    assert.throws(() => h.reader({ accountCreatedAt: { source: 'nofries_account_created_at', valueMs: AT } }), TypeError);
});

test('the wrapper preserves exact account ownership and current commercial/session expiry checks', async () => {
    for (const mutate of [
        h => h.mutateAccount(account => { account.identitySubjectKey = TENANT + ':' + ID(999); }),
        h => h.mutateAccount(account => { account.organisations[0].bindingId = ID(999); }),
        h => h.mutateCustomer(customer => { customer.current.expiresAt = AT; }),
        h => h.mutateCustomer(customer => { customer.details.expiresAt = new Date(AT).toISOString(); }),
    ]) {
        const h = await fixture(); h.assign('genuine_customer'); mutate(h);
        await assert.rejects(h.reader().read(HEADER), unavailable); assert.equal(h.calls.purpose, 0);
    }
});

test('a purpose or identity change during the actual reader rechecks releases no normalized facts', async () => {
    for (const change of ['purpose', 'identity', 'expiry']) {
        const h = await fixture(); h.assign('genuine_customer');
        if (change === 'purpose') h.onPurpose(n => { if (n === 2) h.assign('verified_test'); });
        if (change === 'identity') h.onCustomer(n => { if (n === 2) h.mutateCustomer(customer => { customer.current.revision++; }); });
        if (change === 'expiry') h.onPurpose(() => h.setClock(AT + 3600000));
        await assert.rejects(h.reader().read(HEADER), unavailable); assert.equal(h.calls.writes, 0);
    }
});

test('invalid cross-account enrollment and provider outages retain the existing unavailable error', async () => {
    const h = await fixture();
    h.setAssignments({ schemaVersion: 1, accountId: ID(999), revision: 0,
        assignments: [{ accountId: ID(999), purpose: 'verified_test' }] });
    await assert.rejects(h.reader().read(HEADER), unavailable);
    const failed = h.reader({ readPurposeAssignments: async () => { throw new Error(HEADER + ' private@example.invalid'); } });
    await assert.rejects(failed.read(HEADER), unavailable);
});

test('repeated reads revalidate purpose and current customer instead of caching a prior classification', async () => {
    const h = await fixture(), reader = h.reader(); h.assign('genuine_customer');
    assert.equal((await reader.read(HEADER)).classification.kind, 'customer');
    h.assign('verified_test'); assert.equal((await reader.read(HEADER)).classification.kind, 'test');
    h.mutateCustomer(customer => { customer.current.status = 'revoked'; });
    await assert.rejects(reader.read(HEADER), unavailable);
    assert.equal(h.calls.writes, 0);
});
