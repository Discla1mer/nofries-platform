'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { createAccountPurposeReader, AccountPurposeError } = require('../api/shared/customerSignup/accountPurpose');
const { createStarterAccountAllocator, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');

// All identities, sessions, enrollments and backing data below are synthetic.
// The readCustomer stub represents the existing trusted composition port; these
// tests do not turn its data flags into authentication or make provider calls.
const AT = Date.parse('2026-10-16T00:00:00.000Z');
const HEADER = 'synthetic-current-customer-cookie';
const TENANT = '10000000-0000-4000-8000-000000000001';
const PRINCIPAL = '10000000-0000-4000-8000-000000000002';
const SUBJECT = TENANT + ':' + PRINCIPAL;
const OTHER = TENANT + ':10000000-0000-4000-8000-000000000003';
const ID = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(accountType = 'company') {
    const records = new Map(), calls = { customer: [], loads: [], purposes: [], writes: 0 };
    let clock = AT, sequence = 0, assignments = null, customerHook = null, purposeHook = null, loadHook = null;
    const store = {
        async load(key) {
            calls.loads.push(key);
            if (loadHook) await loadHook(calls.loads.length);
            return records.has(key) ? clone(records.get(key)) : null;
        },
        async create(key, record) { calls.writes++; records.set(key, { record: clone(record), version: '"v1"' }); return true; },
        async replace() { throw new Error('Unexpected synthetic mutation'); },
    };
    const allocator = createStarterAccountAllocator({ store, now: () => clock, newId: () => ID(++sequence),
        readActivation: async () => null, captureOwner: async () => null });
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: ID(100), subjectKey: SUBJECT,
        providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), email: 'test@example.invalid',
        organisationName: 'Synthetic QA name', accountType, createdAt: AT, verifiedAt: AT, expiresAt: AT + 3600000 };
    const account = await allocator.reserveInitial(proof), slot = account.organisations[0];
    clock = AT + 1000;
    let customer = {
        details: { identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT, principalId: PRINCIPAL,
            subjectKey: SUBJECT, name: 'Synthetic Test User', email: proof.email }, expiresAt: new Date(AT + 3600000).toISOString() },
        current: { schemaVersion: 2, subjectKey: SUBJECT, email: proof.email, revision: 0, status: 'active',
            invitationDigest: 'c'.repeat(64), invitationId: ID(101), tenantId: slot.tenantId, organisationId: slot.organisationId,
            termsVersion: 'synthetic-terms', termsDigest: 'd'.repeat(64), scheduleId: slot.scheduleId,
            scheduleDigest: 'e'.repeat(64), bindingId: slot.bindingId, accountType, expiresAt: AT + 86400000 },
        id: 'synthetic-private-session-handle',
    };
    const readCustomer = async header => {
        calls.customer.push(header);
        if (customerHook) await customerHook(calls.customer.length);
        return header === HEADER && customer !== null ? clone(customer) : null;
    };
    const readPurposeAssignments = async accountId => {
        calls.purposes.push(accountId);
        if (purposeHook) await purposeHook(calls.purposes.length);
        return clone(assignments);
    };
    calls.customer.length = 0; calls.loads.length = 0; calls.writes = 0;
    const options = { readCustomer, accountStore: store, readPurposeAssignments, now: () => clock };
    const mutateAccount = mutate => {
        const key = starterAccountKey(proof.email), retained = clone(records.get(key)); mutate(retained.record); records.set(key, retained);
    };
    return { account, slot, proof, calls, options, records, store, mutateAccount,
        reader: extra => createAccountPurposeReader({ ...options, ...extra }),
        setClock: value => { clock = value; }, setCustomer: value => { customer = clone(value); },
        customer: () => clone(customer), onCustomer: fn => { customerHook = fn; }, onPurpose: fn => { purposeHook = fn; },
        onLoad: fn => { loadHook = fn; }, setAssignments: value => { assignments = clone(value); },
        assign(...purposes) { assignments = { schemaVersion: 1, accountId: account.accountId, revision: 0,
            assignments: purposes.map(purpose => ({ accountId: account.accountId, purpose })) }; },
        activate({ removeIdentity = false, subjectKey = SUBJECT } = {}) {
            mutateAccount(record => {
                if (removeIdentity) delete record.identitySubjectKey;
                const activatedAt = new Date(AT + 500).toISOString();
                record.activation = { subjectKey, receiptId: slot.activationId, activatedAt,
                    validUntil: accountWindow(activatedAt).validUntil };
            });
        },
    };
}

const unavailable = error => error instanceof AccountPurposeError && error.statusCode === 503 &&
    error.code === 'account_purpose_unavailable' && error.message === 'Account-purpose facts are unavailable.';

test('reads the actual stable account format and explicit genuine-customer purpose without selecting join authority', async () => {
    const h = await fixture(); h.assign('genuine_customer');
    const result = await h.reader().read(HEADER);
    assert.equal(result.accountId, h.account.accountId); assert.equal(result.subjectKey, SUBJECT);
    assert.deepEqual(result.purpose, { kind: 'genuine_customer', reason: 'explicit_assignment', revision: 0 });
    assert.deepEqual(result.creation, {
        reservation: { source: 'starter_account_reservation', createdAt: h.account.createdAt },
        preparation: { source: 'dashboard_starter_accounts.created_at', status: 'not_requested', createdAt: null },
        canonical: { source: 'unresolved', createdAt: null },
    });
    assert.deepEqual(h.calls.purposes, [h.account.accountId, h.account.accountId]);
    assert.deepEqual(h.calls.loads, [starterAccountKey(h.proof.email), starterAccountKey(h.proof.email)]);
    assert.equal(h.calls.customer.length, 2); assert.equal(h.calls.writes, 0);
});

test('verified test is a classification fact only and emits no QA quota, entitlement, Founder or access grant', async () => {
    const h = await fixture(); h.assign('verified_test');
    const result = await h.reader().read(HEADER);
    assert.deepEqual(result.purpose, { kind: 'verified_test', reason: 'explicit_assignment', revision: 0 });
    assert.deepEqual(Object.keys(result).sort(), ['accountId', 'creation', 'purpose', 'schemaVersion', 'subjectKey']);
    assert.ok(!JSON.stringify(result).includes(h.proof.email));
    assert.ok(!JSON.stringify(result).includes('synthetic-private-session-handle'));
    for (const field of ['quota', 'qaEligible', 'qaEntitled', 'founder', 'eligible', 'access', 'verified', 'token']) {
        assert.ok(!Object.hasOwn(result, field)); assert.ok(!Object.hasOwn(result.purpose, field));
    }
});

test('missing or explicit unknown purpose remains neutral without changing or writing the existing account', async () => {
    const h = await fixture();
    const before = clone([...h.records]);
    const withoutPurposePort = createAccountPurposeReader({ readCustomer: h.options.readCustomer, accountStore: h.store, now: h.options.now });
    assert.deepEqual((await withoutPurposePort.read(HEADER)).purpose, { kind: 'unknown', reason: 'unassigned', revision: null });
    h.assign('unknown');
    assert.deepEqual((await h.reader().read(HEADER)).purpose, { kind: 'unknown', reason: 'unassigned', revision: 0 });
    assert.deepEqual([...h.records], before); assert.equal(h.calls.writes, 0);
});

test('genuine/test or known/unknown conflicts fail closed; repeated identical assignments do not conflict', async () => {
    const h = await fixture();
    for (const purposes of [['genuine_customer', 'verified_test'], ['verified_test', 'genuine_customer'],
        ['genuine_customer', 'unknown'], ['verified_test', 'unknown']]) {
        h.assign(...purposes);
        assert.deepEqual((await h.reader().read(HEADER)).purpose,
            { kind: 'unknown', reason: 'conflicting_assignments', revision: 0 });
    }
    h.assign('verified_test', 'verified_test');
    assert.equal((await h.reader().read(HEADER)).purpose.kind, 'verified_test');
});

test('request flags/source tags cannot supply identity or purpose and anonymous reads do not query accounts', async () => {
    const h = await fixture(); h.assign('verified_test');
    assert.equal(await h.reader().read(JSON.stringify({ verified: true, source: 'nofries', accountId: h.account.accountId })), null);
    await assert.rejects(h.reader().read({ cookie: HEADER, purpose: 'verified_test', verified: true }), unavailable);
    assert.deepEqual(h.calls.loads, []); assert.deepEqual(h.calls.purposes, []);
    assert.throws(() => createAccountPurposeReader({ verified: true, accountId: h.account.accountId }), TypeError);
});

test('names, email domains, account types and activation never infer account purpose', async () => {
    for (const accountType of ['company', 'consultant']) {
        const h = await fixture(accountType); h.activate();
        assert.equal((await h.reader().read(HEADER)).purpose.kind, 'unknown');
        h.assign('genuine_customer');
        assert.equal((await h.reader().read(HEADER)).purpose.kind, 'genuine_customer');
    }
});

test('email index alone cannot bind an account; subject and every own-slot reference must match', async () => {
    for (const mutate of [record => { record.identitySubjectKey = OTHER; },
        record => { delete record.identitySubjectKey; }, record => { record.organisations[0].bindingId = ID(900); },
        record => { record.organisations[0].tenantId = ID(901); }, record => { record.organisations[0].organisationId = ID(902); },
        record => { record.email = 'another@example.invalid'; }, record => { record.accountType = 'consultant'; }]) {
        const h = await fixture(); h.assign('verified_test'); h.mutateAccount(mutate);
        await assert.rejects(h.reader().read(HEADER), unavailable); assert.deepEqual(h.calls.purposes, []);
    }
});

test('historical activation can bind a legacy account but never replaces current customer authentication', async () => {
    const h = await fixture(); h.activate({ removeIdentity: true }); h.assign('genuine_customer');
    assert.equal((await h.reader().read(HEADER)).purpose.kind, 'genuine_customer');
    const expired = h.customer(); expired.details.expiresAt = new Date(AT + 999).toISOString(); h.setCustomer(expired);
    await assert.rejects(h.reader().read(HEADER), unavailable);
    h.setCustomer(null); assert.equal(await h.reader().read(HEADER), null);
    const other = await fixture(); other.activate({ subjectKey: OTHER });
    await assert.rejects(other.reader().read(HEADER), unavailable);
    const wrongReceipt = await fixture(); wrongReceipt.activate({ removeIdentity: true });
    wrongReceipt.mutateAccount(record => { record.activation.receiptId = ID(999); });
    await assert.rejects(wrongReceipt.reader().read(HEADER), unavailable);
});

test('current authority/session denial or a changed current customer fails closed after async reads', async () => {
    const h = await fixture(); h.assign('verified_test');
    h.onCustomer(n => { if (n === 2) { const changed = h.customer(); changed.current.revision = 1; h.setCustomer(changed); } });
    await assert.rejects(h.reader().read(HEADER), unavailable);
    const denied = await fixture(); denied.onCustomer(() => { throw new Error('Synthetic expired Blob authority despite fresh SSO'); });
    await assert.rejects(denied.reader().read(HEADER), unavailable); assert.deepEqual(denied.calls.loads, []);
    const expired = await fixture(); expired.onPurpose(() => expired.setClock(AT + 3600000));
    await assert.rejects(expired.reader().read(HEADER), unavailable);
});

test('expiry or clock rollback during account loading stops later purpose and SQL reads', async () => {
    for (const at of [AT + 3600000, AT + 999]) {
        const h = await fixture(); let transactions = 0;
        h.onLoad(() => h.setClock(at));
        const database = { async withTenantTransaction() { transactions++; throw new Error('Unexpected SQL read'); } };
        await assert.rejects(h.reader({ database }).read(HEADER), unavailable);
        assert.deepEqual(h.calls.purposes, []); assert.equal(transactions, 0);
    }
});

test('expiry during SQL context setup stops the account-row read and purpose lookup', async () => {
    const h = await fixture(); const queries = [];
    const database = { async withTenantTransaction(_, work) { return work({ async query(sql) {
        queries.push(sql); h.setClock(AT + 3600000); return { rows: [] };
    } }); } };
    await assert.rejects(h.reader({ database }).read(HEADER), unavailable);
    assert.equal(queries.length, 1); assert.match(queries[0], /set_config/);
    assert.deepEqual(h.calls.purposes, []);
});

test('changed immutable account facts, malformed stores and provider errors cannot yield purpose grants or leak details', async () => {
    const h = await fixture(); h.assign('verified_test');
    h.onLoad(n => { if (n === 2) h.mutateAccount(record => { record.createdAt = new Date(AT - 1000).toISOString(); }); });
    await assert.rejects(h.reader().read(HEADER), unavailable);
    const bad = await fixture(); bad.mutateAccount(record => { record.unexpected = true; });
    await assert.rejects(bad.reader().read(HEADER), unavailable);
    const failed = await fixture();
    await assert.rejects(failed.reader({ accountStore: { async load() { throw new Error(HEADER + ' private@example.invalid'); } } }).read(HEADER), unavailable);
    const absent = await fixture(); absent.records.clear();
    assert.equal(await absent.reader().read(HEADER), null); assert.deepEqual(absent.calls.purposes, []);
});

test('purpose snapshots must be explicit versioned stable-account assignments with no caller claims', async () => {
    const h = await fixture();
    const base = { schemaVersion: 1, accountId: h.account.accountId, revision: 0,
        assignments: [{ accountId: h.account.accountId, purpose: 'verified_test' }] };
    for (const value of [{ ...base, accountId: ID(999) }, { ...base, revision: -1 }, { ...base, schemaVersion: 2 },
        { ...base, assignments: [{ accountId: ID(999), purpose: 'verified_test' }] },
        { ...base, assignments: [{ accountId: h.account.accountId, purpose: 'test@example.invalid' }] },
        { ...base, verified: true }, { ...base, assignments: [{ ...base.assignments[0], source: 'verified' }] }]) {
        h.setAssignments(value); await assert.rejects(h.reader().read(HEADER), unavailable);
    }
});

test('a purpose revision change or changed facts under the same revision requires reconciliation', async () => {
    for (const changeRevision of [true, false]) {
        const h = await fixture(); h.assign('verified_test');
        h.onPurpose(n => { if (n === 2) {
            h.setAssignments({ schemaVersion: 1, accountId: h.account.accountId, revision: changeRevision ? 1 : 0,
                assignments: [{ accountId: h.account.accountId, purpose: 'genuine_customer' }] });
        } });
        await assert.rejects(h.reader().read(HEADER), unavailable);
    }
});

test('existing subject-RLS PostgreSQL read binds stable account and subject and preserves both timestamp observations', async () => {
    const h = await fixture(); h.assign('genuine_customer'); const queries = [];
    const preparationAt = new Date(AT + 250).toISOString();
    const database = { async withTenantTransaction(tenantId, work) {
        assert.equal(tenantId, h.slot.tenantId);
        return work({ async query(sql, params) {
            queries.push({ sql, params });
            if (sql.includes('set_config')) return { rows: [] };
            return { rows: [{ account_id: h.account.accountId, subject_key: SUBJECT, account_type: 'company', created_at: new Date(preparationAt) }] };
        } });
    } };
    const result = await h.reader({ database }).read(HEADER);
    assert.deepEqual(queries[0].params, [SUBJECT]);
    assert.deepEqual(queries[1].params, [h.account.accountId, SUBJECT]);
    assert.match(queries[1].sql, /WHERE account_id = \$1 AND subject_key = \$2$/);
    assert.ok(queries.every(row => /^SELECT /.test(row.sql)));
    assert.equal(result.creation.reservation.createdAt, h.account.createdAt);
    assert.deepEqual(result.creation.preparation,
        { source: 'dashboard_starter_accounts.created_at', status: 'recorded', createdAt: preparationAt });
    assert.deepEqual(result.creation.canonical, { source: 'unresolved', createdAt: null });
});

test('missing PostgreSQL preparation is distinct from not reading it and never substitutes a canonical date', async () => {
    const h = await fixture();
    const result = await h.reader({ database: { async withTenantTransaction(_, work) {
        return work({ async query() { return { rows: [] }; } });
    } } }).read(HEADER);
    assert.equal(result.creation.preparation.status, 'not_found');
    assert.deepEqual(result.creation.canonical, { source: 'unresolved', createdAt: null });
});

test('cross-account, duplicate, malformed or future preparation rows fail closed without choosing reservation as fallback', async () => {
    const h = await fixture();
    const row = { account_id: h.account.accountId, subject_key: SUBJECT, account_type: 'company', created_at: new Date(AT + 250) };
    for (const rows of [[{ ...row, account_id: ID(999) }], [{ ...row, subject_key: OTHER }],
        [{ ...row, account_type: 'consultant' }], [row, row], [{ ...row, created_at: 'not-a-date' }],
        [{ ...row, created_at: new Date(AT + 2000) }]]) {
        const database = { async withTenantTransaction(_, work) { return work({ async query(sql) {
            return { rows: sql.includes('set_config') ? [] : rows };
        } }); } };
        await assert.rejects(h.reader({ database }).read(HEADER), unavailable);
    }
});

test('constructor and data getters/proxies are rejected without invoking an untrusted getter', async () => {
    const h = await fixture(); let getterCalls = 0;
    const options = { accountStore: h.store };
    Object.defineProperty(options, 'readCustomer', { enumerable: true, get() { getterCalls++; return h.options.readCustomer; } });
    assert.throws(() => createAccountPurposeReader(options), TypeError); assert.equal(getterCalls, 0);
    assert.throws(() => createAccountPurposeReader(new Proxy(h.options, {})), TypeError);
    assert.throws(() => h.reader({ readPurposeAssignments: null }), TypeError);
    const raw = h.customer(); Object.defineProperty(raw, 'current', { enumerable: true, get() { getterCalls++; return {}; } });
    await assert.rejects(h.reader({ readCustomer: async () => raw }).read(HEADER), unavailable);
    assert.equal(getterCalls, 0);
});

test('reads through the actual Azure account adapter using synthetic Blob downloads and no Blob writes', async () => {
    const h = await fixture(); h.assign('verified_test'); const paths = [];
    const bytes = Buffer.from(JSON.stringify(h.account));
    const accountStore = new AzureStarterAccountStore({ getBlockBlobClient(path) {
        paths.push(path);
        return { async download() { return { etag: '"synthetic-v1"', contentLength: bytes.length,
            readableStreamBody: { async *[Symbol.asyncIterator]() { yield bytes; }, destroy() {} } }; },
        async uploadData() { throw new Error('Unexpected Blob write'); } };
    } });
    const result = await h.reader({ accountStore }).read(HEADER);
    assert.equal(result.accountId, h.account.accountId); assert.equal(result.purpose.kind, 'verified_test');
    assert.deepEqual(paths, Array(2).fill('customer-starter/' + starterAccountKey(h.proof.email) + '.json'));
});
