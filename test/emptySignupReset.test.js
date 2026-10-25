'use strict';

const { createHash } = require('node:crypto');
const { createEmptySignupReset } = require('../api/shared/customerSignup/emptySignupReset');
const { starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan, accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');

const uid = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const CUSTOMER = uid(1) + ':' + uid(2), STAFF = uid(3) + ':' + uid(4);
const EMAIL = 'synthetic-reset@example.test';
const AT = Date.parse('2026-10-23T01:40:00.000Z');
const SECRET = 'PRIVATE_TEST_ERROR_token_SQL_customer_value';
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');

function originals() {
    const plan = approvedStarterPlan();
    const slot = { requestId: uid(11), kind: 'own', organisationName: 'Synthetic reset company',
        ...Object.fromEntries(['tenantId', 'organisationId', 'grantId', 'scheduleId', 'activationId',
            'bootstrapOperationId', 'acceptOperationId', 'publicationOperationId', 'bindingId',
            'authorityId', 'membershipId', 'admissionOperationId'].map((key, i) => [key, uid(20 + i)])) };
    const account = starterAccountRecord({ schemaVersion: 1, accountId: uid(10), planId: plan.planId,
        planSha256: plan.sha256, email: EMAIL, accountType: 'company', setupRequestId: slot.requestId,
        setupSha256: 'a'.repeat(64), createdAt: new Date(AT - 1000).toISOString(), activation: null,
        organisations: [slot], identitySubjectKey: CUSTOMER });
    const entry = authority({ schemaVersion: 2, subjectKey: CUSTOMER, email: EMAIL, revision: 0,
        status: 'active', invitationDigest: 'b'.repeat(64), invitationId: uid(40), tenantId: slot.tenantId,
        organisationId: slot.organisationId, termsVersion: 'synthetic-terms-v1', termsDigest: 'c'.repeat(64),
        scheduleId: slot.scheduleId, scheduleDigest: 'd'.repeat(64), bindingId: slot.bindingId,
        accountType: account.accountType, expiresAt: AT + 1800000 }, CUSTOMER, AT);
    return { account, authority: entry };
}

// This mutex and durable-owner model is only a synthetic port. It cannot attest
// that real application writers participate or supply a production reset adapter.
function fixture({ exclusive = true, storage = true, recovery = true } = {}) {
    const request = { schemaVersion: 1, operationId: uid(70), sourceSha: 'e'.repeat(40), email: EMAIL,
        customerSubjectKey: CUSTOMER, staffSubjectKey: STAFF, providerKey: 'f'.repeat(64),
        createdAt: AT, expiresAt: AT + 600000 };
    const records = originals();
    const keys = { account: 'customer-starter/' + starterAccountKey(EMAIL) + '.json',
        authority: 'customer-subjects/' + subjectHash(CUSTOMER) + '.json' };
    const target = { keys: { ...keys }, containerSha256: sha('https://syntheticreset.blob.core.windows.net/external-authority'), dependencyDigest: '1'.repeat(64),
        ...Object.fromEntries(['account', 'authority'].map(name => [name, {
            record: clone(records[name]), etag: '"' + name + '-v1"', versionId: name + '-original-v1',
            sha256: sha(Buffer.from(JSON.stringify(records[name]))) }])) };
    const versions = new Map(), current = new Map(), originalBytes = {};
    for (const name of ['account', 'authority']) {
        const bytes = Buffer.from(JSON.stringify(records[name])); originalBytes[name] = Buffer.from(bytes);
        versions.set(keys[name] + ':' + target[name].versionId, Buffer.from(bytes));
        current.set(keys[name], { bytes: Buffer.from(bytes), etag: target[name].etag });
    }
    // Records outside the two active pointers are observable preservation sentinels.
    const unrelated = new Map([
        ['staff-subject', Buffer.from('synthetic unchanged staff identity')],
        ['old-claim-context-and-legal-archives', Buffer.from('synthetic retained evidence')],
        ['admission-budget-and-subject-reservation', Buffer.from('synthetic retained fences')]
    ]);
    const unrelatedBefore = [...unrelated].map(([key, bytes]) => [key, bytes.toString('hex')]);
    const h = { request, target, keys, records, versions, current, originalBytes, unrelated, unrelatedBefore,
        events: [], at: AT, retained: false, active: false, owner: null, removes: {}, restores: {},
        onRead: null, onAssert: null, beforeWork: null, afterWork: null };
    const nameFor = key => Object.keys(keys).find(name => keys[name] === key);
    h.inspect = jest.fn(async () => ({ status: 'ready', target: clone(h.target) }));
    // The real adapter must recheck SQL/layout, source binding and immutable
    // versions. This synthetic port returns the same captured target only.
    h.inspectRecovery = jest.fn(async () => ({ status: 'ready', target: clone(h.target) }));
    h.fence = {
        assertCurrent: jest.fn(async () => {
            h.events.push('assert');
            if (!h.active) throw new Error('synthetic mutex not held');
            if (h.onAssert) await h.onAssert(h.fence.assertCurrent.mock.calls.length);
        }),
        retain: jest.fn(async () => { h.events.push('retain'); h.retained = true; }),
        complete: jest.fn(async () => { h.events.push('complete'); h.retained = false; h.owner = null; })
    };
    h.blobs = {
        readCurrent: jest.fn(async key => {
            const name = nameFor(key); if (!name) throw new Error('outside target');
            h.events.push('read_' + name); if (h.onRead) await h.onRead(name);
            const found = current.get(key);
            return found ? { bytes: Buffer.from(found.bytes), etag: found.etag } : null;
        }),
        readVersion: jest.fn(async (key, version) => {
            if (!nameFor(key)) throw new Error('outside target');
            h.events.push('version_' + nameFor(key));
            const bytes = versions.get(key + ':' + version); return bytes ? Buffer.from(bytes) : null;
        }),
        remove: jest.fn(async (key, options) => {
            const name = nameFor(key); if (!name) throw new Error('outside target');
            h.events.push('remove_' + name); expect(h.active).toBe(true);
            expect(options).toEqual({ conditions: { ifMatch: target[name].etag } });
            const fault = h.removes[name]; if (typeof fault === 'function') return fault();
            if (fault === 'before') throw new Error(SECRET);
            if (current.get(key)?.etag !== options.conditions.ifMatch) throw new Error('conditional conflict');
            current.delete(key); if (fault === 'after') throw new Error(SECRET);
        }),
        restore: jest.fn(async (key, bytes, options) => {
            const name = nameFor(key); if (!name) throw new Error('outside target');
            h.events.push('restore_' + name); expect(h.active).toBe(true);
            expect(options).toEqual({ conditions: { ifNoneMatch: '*' } });
            expect(bytes.equals(originalBytes[name])).toBe(true);
            const fault = h.restores[name]; if (typeof fault === 'function') return fault();
            if (fault === 'before') throw new Error(SECRET);
            if (current.has(key)) throw new Error('conditional conflict');
            current.set(key, { bytes: Buffer.from(bytes), etag: '"' + name + '-restored"' });
            if (fault === 'after') throw new Error(SECRET);
        })
    };
    let tail = Promise.resolve();
    h.withExclusiveTarget = jest.fn(async (binding, work) => {
        const previous = tail; let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (h.retained && h.owner !== binding.request.operationId) throw new Error('different pending owner');
            h.owner = binding.request.operationId; h.active = true; h.events.push('enter');
            if (h.beforeWork) await h.beforeWork(binding);
            const answer = await work(h.fence);
            if (h.afterWork) await h.afterWork();
            return answer;
        } finally { h.events.push('leave'); h.active = false; release(); }
    });
    h.reset = createEmptySignupReset({ inspect: h.inspect, now: () => h.at,
        ...(storage ? { blobs: h.blobs } : {}), ...(exclusive ? { withExclusiveTarget: h.withExclusiveTarget } : {}),
        ...(recovery ? { inspectRecovery: h.inspectRecovery } : {}) });
    h.plan = async () => {
        const found = await h.reset.inventory(request); expect(found.status).toBe('ready'); return found.plan;
    };
    h.assertUntouched = () => {
        expect(h.blobs.remove).not.toHaveBeenCalled(); expect(h.blobs.restore).not.toHaveBeenCalled();
        for (const name of ['account', 'authority']) expect(current.get(keys[name]).bytes.equals(originalBytes[name])).toBe(true);
    };
    return h;
}

function expectClosed(result) {
    expect(Object.keys(result).sort()).toEqual(['code', 'phase', 'status']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result)).not.toContain(CUSTOMER);
}

test('inventory produces an immutable bound plan without storage reads, fence acquisition or mutation', async () => {
    const h = fixture(), plan = await h.plan();
    expect(plan.operationId).toBe(h.request.operationId);
    expect(plan.records.account.key).toBe(h.keys.account);
    expect(plan.records.authority.key).toBe(h.keys.authority);
    for (const value of [plan, plan.records, plan.records.account, plan.records.authority]) expect(Object.isFrozen(value)).toBe(true);
    expect(h.withExclusiveTarget).not.toHaveBeenCalled(); expect(h.blobs.readVersion).not.toHaveBeenCalled();
    expect(h.blobs.readCurrent).not.toHaveBeenCalled(); h.assertUntouched();
});

test('default construction cannot mutate without an exclusive participating-writer port', async () => {
    const h = fixture({ exclusive: false }), plan = await h.plan();
    for (const operation of ['reset', 'rollback']) {
        expect(await h.reset[operation](h.request, plan)).toEqual({ status: 'blocked', code: 'writer_fence_unavailable', phase: 'admission' });
    }
    expect(h.blobs.readVersion).not.toHaveBeenCalled(); h.assertUntouched();
});

test('a boolean witness or incomplete fence cannot substitute for the exclusive port', async () => {
    const h = fixture(), plan = await h.plan();
    for (const withExclusiveTarget of [true, false, async (_, work) => work({ assertCurrent: async () => {} })]) {
        const reset = createEmptySignupReset({ inspect: h.inspect, blobs: h.blobs, withExclusiveTarget, now: () => AT });
        expect((await reset.reset(h.request, plan)).code).toBe('writer_fence_unavailable');
    }
    h.assertUntouched();
});

test('an absent storage binding fails before reading or acquiring the fence', async () => {
    const h = fixture({ storage: false }), plan = await h.plan();
    expect((await h.reset.reset(h.request, plan)).code).toBe('storage_binding_unavailable');
    expect(h.withExclusiveTarget).not.toHaveBeenCalled(); h.assertUntouched();
});

test('rollback requires its own current dependency inspector before acquiring the fence', async () => {
    const h = fixture({ recovery: false }), plan = await h.plan();
    expect(await h.reset.rollback(h.request, plan)).toEqual({ status: 'blocked', code: 'recovery_binding_unavailable', phase: 'admission' });
    expect(h.withExclusiveTarget).not.toHaveBeenCalled(); h.assertUntouched();
});

test('success conditionally removes only account then authority and verifies absence before completing the fence', async () => {
    const h = fixture(), plan = await h.plan();
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome).toEqual({ status: 'reset', code: 'active_pointers_absent', phase: 'complete' }); expectClosed(outcome);
    expect(h.blobs.remove.mock.calls.map(([key]) => key)).toEqual([h.keys.account, h.keys.authority]);
    expect(h.blobs.restore).not.toHaveBeenCalled(); expect(h.current.size).toBe(0);
    expect(h.fence.complete).toHaveBeenCalledTimes(1); expect(h.fence.retain).not.toHaveBeenCalled();
    expect(h.events.indexOf('complete')).toBeGreaterThan(h.events.lastIndexOf('read_authority'));
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect([...h.unrelated].map(([key, bytes]) => [key, bytes.toString('hex')])).toEqual(h.unrelatedBefore);
});

test('blocked or throwing inspectors return fixed output without adapter or exception text', async () => {
    const h = fixture();
    h.inspect.mockResolvedValueOnce({ status: 'blocked', code: SECRET, target: SECRET });
    expect(await h.reset.inventory(h.request)).toEqual({ status: 'blocked', code: 'inventory_blocked', phase: 'inventory', plan: null });
    h.inspect.mockRejectedValueOnce(new Error(SECRET));
    expect(await h.reset.inventory(h.request)).toEqual({ status: 'blocked', code: 'inventory_unavailable', phase: 'inventory' });
    h.assertUntouched(); expect(h.withExclusiveTarget).not.toHaveBeenCalled();
});

test('request closure, staff separation, normalization and one-hour bounds reject malformed or malicious inputs', async () => {
    const h = fixture();
    const cases = [null, [], {}, { ...h.request, extra: SECRET }, { ...h.request, schemaVersion: 2 },
        { ...h.request, email: 'Synthetic-reset@example.test' }, { ...h.request, email: SECRET },
        { ...h.request, operationId: '../../' + SECRET }, { ...h.request, sourceSha: 'f'.repeat(39) },
        { ...h.request, providerKey: SECRET }, { ...h.request, staffSubjectKey: CUSTOMER },
        { ...h.request, customerSubjectKey: STAFF, staffSubjectKey: STAFF },
        { ...h.request, createdAt: AT + 1 }, { ...h.request, createdAt: -1 },
        { ...h.request, expiresAt: AT }, { ...h.request, expiresAt: AT + 3600001 },
        { ...h.request, expiresAt: Infinity }, { ...h.request, expiresAt: AT + 0.5 }];
    for (const input of cases) expect(await h.reset.inventory(input)).toEqual({ status: 'blocked', code: 'inventory_unavailable', phase: 'inventory' });
    expect(h.inspect).not.toHaveBeenCalled(); h.assertUntouched();
    const valid = await h.reset.inventory({ ...h.request, expiresAt: AT + 3600000 }); expect(valid.status).toBe('ready');
});

test('request accessors, proxies and object-valued scalar fields are rejected without invocation or coercion', async () => {
    const h = fixture(), get = jest.fn(() => h.request.email), coerce = jest.fn(() => h.request.operationId);
    const accessor = { ...h.request }; Object.defineProperty(accessor, 'email', { enumerable: true, get });
    const trap = jest.fn(); const proxy = new Proxy(h.request, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    const fields = ['operationId', 'sourceSha', 'providerKey'];
    const values = fields.map(key => ({ ...h.request, [key]: { toString: coerce } }));
    for (const input of [accessor, proxy, ...values]) expect((await h.reset.inventory(input)).status).toBe('blocked');
    expect(get).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled(); expect(coerce).not.toHaveBeenCalled();
    expect(h.inspect).not.toHaveBeenCalled(); h.assertUntouched();
});

test('inventory rejects unknown target metadata or substituted exact keys without exposing it', async () => {
    const mutations = [target => { target.extra = SECRET; }, target => { target.keys.account = '../../' + SECRET; },
        target => { target.keys.extra = SECRET; }, target => { target.account.extra = SECRET; },
        target => { target.authority.extra = SECRET; }, target => { target.account.versionId = '../' + SECRET; },
        target => { target.authority.etag = '"bad\n' + SECRET + '"'; }];
    for (const mutate of mutations) {
        const h = fixture(); mutate(h.target);
        const outcome = await h.reset.inventory(h.request);
        expect(outcome).toEqual({ status: 'blocked', code: 'inventory_unavailable', phase: 'inventory' });
        expect(JSON.stringify(outcome)).not.toContain(SECRET); h.assertUntouched();
    }
});

test('mutated, forged or cross-request plans never reach storage or the exclusive port', async () => {
    const h = fixture(), plan = await h.plan();
    const mutations = [p => { p.extra = SECRET; }, p => { p.schemaVersion = 2; }, p => { p.operationId = uid(99); },
        p => { p.bindingSha256 = '9'.repeat(64); }, p => { p.requestSha256 = '9'.repeat(64); },
        p => { p.records.extra = SECRET; }, p => { p.records.account.extra = SECRET; },
        p => { p.records.account.key = h.keys.authority; }, p => { p.records.authority.versionId = '../../' + SECRET; },
        p => { p.records.authority.etag = 'bad'; }, p => { p.records.authority.sha256 = SECRET; }];
    for (const mutate of mutations) {
        const changed = clone(plan); mutate(changed);
        const outcome = await h.reset.reset(h.request, changed); expectClosed(outcome);
        expect(outcome).toEqual({ status: 'blocked', code: 'invalid_plan', phase: 'admission' });
    }
    expect((await h.reset.reset({ ...h.request, email: 'other@example.test' }, plan)).code).toBe('invalid_plan');
    expect(h.withExclusiveTarget).not.toHaveBeenCalled(); expect(h.blobs.readVersion).not.toHaveBeenCalled(); h.assertUntouched();
});

test('expired request is refused at admission while expiry during fence acquisition stops before reads', async () => {
    const h = fixture(), plan = await h.plan(); h.at = h.request.expiresAt;
    expect((await h.reset.reset(h.request, plan)).code).toBe('invalid_plan'); expect(h.withExclusiveTarget).not.toHaveBeenCalled();
    h.at = AT; h.beforeWork = async () => { h.at = h.request.expiresAt; };
    expect(await h.reset.reset(h.request, plan)).toEqual({ status: 'blocked', code: 'plan_expired', phase: 'admission' });
    expect(h.blobs.readVersion).not.toHaveBeenCalled(); h.assertUntouched();
});

test.each(['dependencyDigest', 'account ETag', 'blocked'])('inventory %s drift is detected inside the fence before any delete', async defect => {
    const h = fixture(), plan = await h.plan();
    h.beforeWork = async () => {
        if (defect === 'dependencyDigest') h.target.dependencyDigest = '8'.repeat(64);
        else if (defect === 'account ETag') h.target.account.etag = '"new-account-v2"';
        else h.inspect.mockResolvedValue({ status: 'blocked', code: SECRET });
    };
    expect(await h.reset.reset(h.request, plan)).toEqual({ status: 'blocked', code: 'inventory_changed', phase: 'inventory_recheck' });
    h.assertUntouched(); expect(h.fence.complete).not.toHaveBeenCalled();
});

test.each(['missing', 'corrupt', 'wrong type', 'oversize'])('immutable recovery version %s prevents all deletion', async defect => {
    const h = fixture(), plan = await h.plan(), key = h.keys.authority + ':' + h.target.authority.versionId;
    if (defect === 'missing') h.versions.delete(key);
    if (defect === 'corrupt') h.versions.set(key, Buffer.from(SECRET));
    if (defect === 'oversize') h.versions.set(key, Buffer.alloc(16385));
    if (defect === 'wrong type') h.blobs.readVersion.mockResolvedValueOnce(SECRET);
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('blocked'); expectClosed(outcome); h.assertUntouched();
    expect(h.fence.complete).not.toHaveBeenCalled();
});

test.each(['foreign account email', 'foreign authority scope', 'activated account', 'invalid UTF8'])('hash-matching original with %s is rejected by actual record validation', async defect => {
    const h = fixture();
    const name = defect === 'foreign authority scope' ? 'authority' : 'account';
    const record = clone(h.records[name]);
    if (defect === 'foreign account email') record.email = 'other@example.test';
    if (defect === 'foreign authority scope') record.organisationId = uid(90);
    if (defect === 'activated account') {
        record.activation = { subjectKey: CUSTOMER, receiptId: uid(91), activatedAt: record.createdAt,
            validUntil: accountWindow(record.createdAt, record.planId).validUntil };
        starterAccountRecord(record); // valid codec, but the reset policy must refuse activation.
    }
    const bytes = Buffer.from(JSON.stringify(record));
    if (defect === 'invalid UTF8') {
        const offset = bytes.indexOf('Synthetic reset company'); expect(offset).toBeGreaterThan(0); bytes[offset] = 0xff;
    }
    h.target[name] = { ...h.target[name], record, sha256: sha(bytes) };
    h.versions.set(h.keys[name] + ':' + h.target[name].versionId, bytes);
    h.current.set(h.keys[name], { bytes: Buffer.from(bytes), etag: h.target[name].etag });
    const plan = await h.plan(), outcome = await h.reset.reset(h.request, plan);
    expect(outcome).toEqual({ status: 'blocked', code: 'recovery_unavailable', phase: 'recovery_read' }); expectClosed(outcome);
    expect(h.blobs.remove).not.toHaveBeenCalled(); expect(h.blobs.restore).not.toHaveBeenCalled();
});

test.each(['account', 'authority'])('a current %s conflict is preserved and never conditionally overwritten', async name => {
    const h = fixture(), plan = await h.plan(), foreign = Buffer.from(SECRET);
    h.current.set(h.keys[name], { bytes: foreign, etag: '"foreign"' });
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('blocked'); expect(outcome.code).toBe('record_changed');
    expect(h.current.get(h.keys[name]).bytes.equals(foreign)).toBe(true);
    expect(h.blobs.remove.mock.calls.filter(([key]) => key === h.keys[name])).toHaveLength(0);
    expect(h.blobs.remove).not.toHaveBeenCalled(); expect(h.fence.retain).not.toHaveBeenCalled();
    expectClosed(outcome);
});

test('same bytes under a new ETag still stop reset before mutation', async () => {
    const h = fixture(), plan = await h.plan(); h.current.get(h.keys.account).etag = '"foreign-revision"';
    expect((await h.reset.reset(h.request, plan)).code).toBe('record_changed'); h.assertUntouched();
});

test.each(['account', 'authority'])('a lost %s delete acknowledgement is reconciled once without another delete', async name => {
    const h = fixture(), plan = await h.plan(); h.removes[name] = 'after';
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('reset'); expectClosed(outcome);
    expect(h.blobs.remove.mock.calls.filter(([key]) => key === h.keys[name])).toHaveLength(1);
    expect(h.current.size).toBe(0); expect(h.fence.complete).toHaveBeenCalledTimes(1);
});

test.each(['account', 'authority'])('a %s delete failure before effect retains the fence without retry', async name => {
    const h = fixture(), plan = await h.plan(); h.removes[name] = 'before';
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome).toEqual({ status: 'pending', code: 'mutation_not_applied', phase: 'reconcile_' + name });
    expect(h.blobs.remove.mock.calls.filter(([key]) => key === h.keys[name])).toHaveLength(1);
    expect(h.current.has(h.keys.authority)).toBe(true);
    expect(h.current.has(h.keys.account)).toBe(name === 'account');
    expect(h.fence.retain).toHaveBeenCalledTimes(1); expect(h.retained).toBe(true);
    expect(h.fence.complete).not.toHaveBeenCalled(); expectClosed(outcome);
});

test('changed state after a failed conditional delete is never classified as the original record', async () => {
    const h = fixture(), plan = await h.plan();
    h.removes.account = () => { h.current.set(h.keys.account, { bytes: Buffer.from(SECRET), etag: '"foreign"' }); throw new Error(SECRET); };
    expect(await h.reset.reset(h.request, plan)).toEqual({ status: 'pending', code: 'record_changed', phase: 'reconcile_account' });
    expect(h.blobs.remove).toHaveBeenCalledTimes(1); expect(h.current.get(h.keys.account).bytes.toString()).toBe(SECRET);
    expect(h.fence.retain).toHaveBeenCalledTimes(1);
});

test('a failed reconciliation read retains the uncertain effect and does not repeat it', async () => {
    const h = fixture(), plan = await h.plan(); let reads = 0;
    h.onRead = name => { if (name === 'account' && ++reads === 3) throw new Error(SECRET); };
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('pending'); expect(outcome.phase).toBe('reconcile_account'); expectClosed(outcome);
    expect(h.blobs.remove).toHaveBeenCalledTimes(1); expect(h.current.has(h.keys.account)).toBe(false);
    expect(h.current.has(h.keys.authority)).toBe(true); expect(h.fence.retain).toHaveBeenCalledTimes(1);
});

test('deadline crossed after account deletion retains the partial fence and stops before authority deletion', async () => {
    const h = fixture(), plan = await h.plan();
    h.removes.account = () => { h.current.delete(h.keys.account); h.at = h.request.expiresAt; };
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('pending'); expect(outcome.code).toBe('plan_expired');
    expect(h.blobs.remove).toHaveBeenCalledTimes(1); expect(h.current.has(h.keys.authority)).toBe(true);
    expect(h.fence.retain).toHaveBeenCalledTimes(1);
});

test('expiry crossed while awaiting the last fence assertion stops before the first deletion', async () => {
    const h = fixture(), plan = await h.plan(); let reads = 0, arm = false;
    h.onRead = name => { if (name === 'account' && ++reads === 2) arm = true; };
    h.onAssert = () => { if (arm) h.at = h.request.expiresAt; };
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('blocked'); expect(outcome.code).toBe('plan_expired'); h.assertUntouched();
});

test('fence loss before work prevents deletion; loss after effect keeps the uncertain operation pending', async () => {
    const h = fixture(), plan = await h.plan();
    h.onAssert = () => { throw new Error(SECRET); };
    expect((await h.reset.reset(h.request, plan)).status).toBe('blocked'); h.assertUntouched();
    h.onAssert = () => { if (!h.current.has(h.keys.account)) throw new Error(SECRET); };
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.status).toBe('pending'); expectClosed(outcome);
    expect(h.blobs.remove).toHaveBeenCalledTimes(1); expect(h.fence.retain).toHaveBeenCalledTimes(1);
});

test('failure to confirm fence retention or completion remains pending without replay', async () => {
    const h = fixture(), plan = await h.plan(); h.removes.account = 'before';
    h.fence.retain.mockRejectedValue(new Error(SECRET));
    expect((await h.reset.reset(h.request, plan)).code).toBe('fence_retention_unconfirmed');
    expect(h.blobs.remove).toHaveBeenCalledTimes(1);
    const complete = fixture(), p = await complete.plan();
    complete.fence.complete.mockRejectedValue(new Error(SECRET));
    const outcome = await complete.reset.reset(complete.request, p);
    expect(outcome.status).toBe('pending'); expectClosed(outcome);
    expect(complete.blobs.remove).toHaveBeenCalledTimes(2); expect(complete.fence.retain).toHaveBeenCalledTimes(1);
});

test('uncertain outer fence outcome reports pending after effect, with no new mutation attempt', async () => {
    const h = fixture(), plan = await h.plan(); h.afterWork = () => { throw new Error(SECRET); };
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome).toEqual({ status: 'pending', code: 'fence_outcome_unconfirmed', phase: 'fence_completion' });
    expect(h.blobs.remove).toHaveBeenCalledTimes(2); expectClosed(outcome);
});

test('the synthetic exclusive model serializes work and refuses a different operation while a partial fence is retained', async () => {
    const h = fixture(), plan = await h.plan(); h.removes.authority = 'before';
    expect((await h.reset.reset(h.request, plan)).status).toBe('pending');
    const different = { ...h.request, operationId: uid(71) }, next = await h.reset.inventory(different);
    const outcome = await h.reset.reset(different, next.plan);
    expect(outcome.code).toBe('fence_outcome_unconfirmed'); expect(outcome.status).toBe('blocked');
    expect(h.blobs.remove).toHaveBeenCalledTimes(2); expect(h.retained).toBe(true);
});

test.each(['partial', 'complete'])('rollback restores original account before authority after a %s reset', async mode => {
    const h = fixture(), plan = await h.plan(); if (mode === 'partial') h.removes.authority = 'before';
    expect((await h.reset.reset(h.request, plan)).status).toBe(mode === 'partial' ? 'pending' : 'reset');
    h.events.length = 0;
    const outcome = await h.reset.rollback(h.request, plan);
    expect(outcome).toEqual({ status: 'recovered', code: 'originals_restored', phase: 'complete' }); expectClosed(outcome);
    const restored = h.blobs.restore.mock.calls.map(([key]) => key);
    expect(restored).toEqual(mode === 'partial' ? [h.keys.account] : [h.keys.account, h.keys.authority]);
    for (const name of ['account', 'authority']) expect(h.current.get(h.keys[name]).bytes.equals(h.originalBytes[name])).toBe(true);
    expect(h.retained).toBe(false);
});

test('rollback can run after approval and authority expiry and preserves exact old bytes and expiry', async () => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan);
    h.at = AT + 7200000;
    expect((await h.reset.rollback(h.request, plan)).status).toBe('recovered');
    for (const name of ['account', 'authority']) expect(h.current.get(h.keys[name]).bytes.equals(h.originalBytes[name])).toBe(true);
    expect(JSON.parse(h.current.get(h.keys.authority).bytes).expiresAt).toBe(h.records.authority.expiresAt);
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect(h.inspectRecovery).toHaveBeenCalledTimes(1); // current dependencies are checked without treating absent pointers as new inventory.
});

test.each(['account', 'authority'])('rollback never replaces foreign %s state', async name => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan);
    const foreign = Buffer.from(SECRET); h.current.set(h.keys[name], { bytes: foreign, etag: '"foreign"' });
    const outcome = await h.reset.rollback(h.request, plan);
    expect(outcome.status).toBe('blocked'); expect(outcome.code).toBe('record_changed');
    expect(h.current.get(h.keys[name]).bytes.equals(foreign)).toBe(true);
    expect(h.blobs.restore).not.toHaveBeenCalled(); expectClosed(outcome);
});

test.each(['account', 'authority'])('lost %s restore acknowledgement is reconciled without a repeat restore', async name => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan); h.restores[name] = 'after';
    expect((await h.reset.rollback(h.request, plan)).status).toBe('recovered');
    expect(h.blobs.restore.mock.calls.filter(([key]) => key === h.keys[name])).toHaveLength(1);
});

test('restore failure with absence remains pending and keeps authority absent until account restoration is verified', async () => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan); h.restores.account = 'before';
    expect(await h.reset.rollback(h.request, plan)).toEqual({ status: 'pending', code: 'mutation_unconfirmed', phase: 'reconcile_account' });
    expect(h.blobs.restore).toHaveBeenCalledTimes(1); expect(h.current.size).toBe(0); expect(h.retained).toBe(true);
});

test('rollback is an idempotent byte-preserving no-op when originals already exist under new ETags', async () => {
    const h = fixture(), plan = await h.plan();
    h.current.get(h.keys.account).etag = '"same-content-new-revision"';
    expect((await h.reset.rollback(h.request, plan)).status).toBe('recovered');
    expect(h.blobs.restore).not.toHaveBeenCalled(); expect(h.blobs.remove).not.toHaveBeenCalled();
});

test('a concurrent foreign record materialized during restore is preserved and never overwritten', async () => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan);
    h.restores.account = () => { h.current.set(h.keys.account, { bytes: Buffer.from(SECRET), etag: '"foreign"' }); throw new Error(SECRET); };
    const outcome = await h.reset.rollback(h.request, plan);
    expect(outcome).toEqual({ status: 'pending', code: 'record_changed', phase: 'reconcile_account' });
    expect(h.current.get(h.keys.account).bytes.toString()).toBe(SECRET); expect(h.blobs.restore).toHaveBeenCalledTimes(1);
    expect(h.current.has(h.keys.authority)).toBe(false);
});

test.each(['blocked', 'drift', 'error'])('rollback dependency recheck %s prevents either restoration', async defect => {
    const h = fixture(), plan = await h.plan(); await h.reset.reset(h.request, plan);
    if (defect === 'blocked') h.inspectRecovery.mockResolvedValue({ status: 'blocked', detail: SECRET });
    if (defect === 'drift') h.target.dependencyDigest = '2'.repeat(64);
    if (defect === 'error') h.inspectRecovery.mockRejectedValue(new Error(SECRET));
    const outcome = await h.reset.rollback(h.request, plan);
    expect(outcome.status).toBe('blocked'); expectClosed(outcome);
    expect(h.blobs.restore).not.toHaveBeenCalled(); expect(h.current.size).toBe(0);
});

test('invalid clock before work or after an effect cannot bypass the reset deadline', async () => {
    const h = fixture(), plan = await h.plan();
    h.beforeWork = () => { h.at = NaN; };
    expect((await h.reset.reset(h.request, plan)).code).toBe('plan_expired'); h.assertUntouched();
    const partial = fixture(), nextPlan = await partial.plan();
    partial.removes.account = () => { partial.current.delete(partial.keys.account); partial.at = NaN; };
    const outcome = await partial.reset.reset(partial.request, nextPlan);
    expect(outcome.status).toBe('pending'); expect(outcome.code).toBe('plan_expired');
    expect(partial.blobs.remove).toHaveBeenCalledTimes(1); expect(partial.fence.retain).toHaveBeenCalledTimes(1);
});

test('an arbitrary outer return without invoking the protected work cannot claim reset success', async () => {
    const h = fixture(), plan = await h.plan();
    h.withExclusiveTarget.mockResolvedValue({ status: 'reset', code: SECRET, phase: 'complete' });
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome).toEqual({ status: 'blocked', code: 'fence_outcome_unconfirmed', phase: 'admission' }); expectClosed(outcome);
    h.assertUntouched();
});

test('a late callback after the exclusive port returned cannot start storage work', async () => {
    const h = fixture(), plan = await h.plan(); let callback;
    h.withExclusiveTarget.mockImplementation(async (_, work) => { callback = work; });
    expect((await h.reset.reset(h.request, plan)).code).toBe('fence_outcome_unconfirmed');
    expect((await callback(h.fence)).code).toBe('fence_outcome_unconfirmed');
    expect(h.blobs.readVersion).not.toHaveBeenCalled(); h.assertUntouched();
});

test('two concurrent callbacks cannot issue a delete under the invalid exclusive port', async () => {
    const h = fixture(), plan = await h.plan();
    h.withExclusiveTarget.mockImplementation(async (_, work) => {
        h.active = true;
        try { return (await Promise.all([work(h.fence), work(h.fence)]))[0]; }
        finally { h.active = false; }
    });
    const outcome = await h.reset.reset(h.request, plan);
    expect(outcome.code).toBe('fence_outcome_unconfirmed'); expect(outcome.status).toBe('blocked');
    h.assertUntouched();
});

test('a duplicated callback or substituted result after completion is pending and never repeats effects', async () => {
    for (const defect of ['repeat callback', 'substitute result']) {
        const h = fixture(), plan = await h.plan();
        h.withExclusiveTarget.mockImplementation(async (_, work) => {
            h.active = true;
            try {
                const answer = await work(h.fence);
                return defect === 'repeat callback' ? work(h.fence) : { ...answer, code: SECRET };
            } finally { h.active = false; }
        });
        const outcome = await h.reset.reset(h.request, plan);
        expect(outcome.code).toBe('fence_outcome_unconfirmed'); expect(outcome.status).toBe('pending');
        expectClosed(outcome); expect(h.blobs.remove).toHaveBeenCalledTimes(2);
    }
});
