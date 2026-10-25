'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = global.test || require('node:test');
const { createLunaProfileService, lunaProfileRecord, LunaProfileError, MAX_BYTES } = require('../api/shared/customerSignup/lunaProfile');
const { AzureLunaProfileStore } = require('../api/shared/customerSignup/azureLunaProfileStore');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');

const AT = Date.parse('2026-10-16T00:00:00.000Z');
const ID = n => 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));
const error = (statusCode, code) => Object.assign(new Error('synthetic private provider detail'), { statusCode, code });
const denied = (status = 503, code = 'luna_profile_unavailable') => value => value instanceof LunaProfileError &&
    value.statusCode === status && value.code === code && value.message === 'Luna profile request could not be completed.';
const request = (nickname = 'Luna', expectedRevision = 0, operationId = ID(900)) => ({ nickname, expectedRevision, operationId });

// Stateful synthetic private Blob transport. New adapter/service instances share
// only these persisted bytes, never process-local profile state or an auth flag.
function transport() {
    const records = new Map(), calls = { reads: 0, writes: 0 }, paths = [];
    let sequence = 0, downloadHook = null, uploadHook = null, afterUpload = null, responseHook = null;
    return { records, calls, paths,
        onDownload(fn) { downloadHook = fn; }, onUpload(fn) { uploadHook = fn; },
        afterUpload(fn) { afterUpload = fn; }, response(fn) { responseHook = fn; },
        container: { getBlockBlobClient(path) {
            paths.push(path);
            return {
                async download(offset, length, options) {
                    assert.equal(offset, 0); assert.equal(length, MAX_BYTES + 1); assert.ok(options.abortSignal);
                    calls.reads++; if (downloadHook) await downloadHook();
                    const found = records.get(path);
                    if (!found) throw error(404, 'BlobNotFound');
                    const result = { etag: found.version, contentLength: found.body.length, readableStreamBody: Readable.from([found.body]) };
                    return responseHook ? responseHook(result) : result;
                },
                async uploadData(body, options) {
                    calls.writes++; if (uploadHook) await uploadHook();
                    assert.ok(options.abortSignal);
                    assert.deepEqual(options.blobHTTPHeaders, { blobContentType: 'application/json', blobCacheControl: 'no-store' });
                    const prior = records.get(path), conditions = options.conditions;
                    if (conditions.ifNoneMatch === '*' ? !!prior : conditions.ifMatch !== prior?.version) throw error(412, 'ConditionNotMet');
                    assert.ok(conditions.ifNoneMatch === '*' || typeof conditions.ifMatch === 'string');
                    records.set(path, { body: Buffer.from(body), version: '"v' + (++sequence) + '"' });
                    if (afterUpload) await afterUpload();
                },
            };
        } },
    };
}

async function fixture(blob = transport(), offset = 0) {
    let sequence = offset, clock = AT + 1000, active = true, customerHook = null, purpose = null;
    const accounts = new Map(), counts = { accountWrites: 0, customerReads: 0 };
    const accountStore = {
        async load(key) { return accounts.has(key) ? clone(accounts.get(key)) : null; },
        async create(key, record) { counts.accountWrites++; accounts.set(key, { record: clone(record), version: '"account1"' }); return true; },
        async replace() { throw new Error('Unexpected account mutation'); },
    };
    const subjectKey = ID(500 + offset) + ':' + ID(501 + offset), header = 'synthetic-session-' + offset;
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: ID(700 + offset), subjectKey,
        providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), email: 'profile-' + offset + '@example.invalid',
        organisationName: 'Synthetic profile owner', accountType: 'company', createdAt: AT, verifiedAt: AT, expiresAt: AT + 3600000 };
    const allocator = createStarterAccountAllocator({ store: accountStore, captureOwner: async () => null,
        readActivation: async () => null, now: () => AT, newId: () => ID(++sequence) });
    const account = await allocator.reserveInitial(proof), slot = account.organisations[0];
    const customer = { details: { identity: { provider: 'entra-bff', isAuthenticated: true,
        tenantId: ID(500 + offset), principalId: ID(501 + offset), subjectKey, email: proof.email },
        expiresAt: new Date(AT + 3600000).toISOString() },
    current: { schemaVersion: 2, subjectKey, email: proof.email, revision: 0, status: 'active',
        invitationDigest: 'c'.repeat(64), invitationId: ID(701 + offset), tenantId: slot.tenantId, organisationId: slot.organisationId,
        termsVersion: 'synthetic-terms', termsDigest: 'd'.repeat(64), scheduleId: slot.scheduleId,
        scheduleDigest: 'e'.repeat(64), bindingId: slot.bindingId, accountType: 'company', expiresAt: AT + 86400000 } };
    const accountReaderOptions = { accountStore, now: () => clock,
        async readCustomer(cookie) { counts.customerReads++; if (customerHook) customerHook(counts.customerReads);
            return active && cookie === header ? clone(customer) : null; },
        async readPurposeAssignments(accountId) { return purpose === null ? null : { schemaVersion: 1, accountId, revision: 0,
            assignments: [{ accountId, purpose }] }; } };
    counts.accountWrites = 0;
    const store = () => new AzureLunaProfileStore(blob.container);
    return { blob, account, accounts, counts, header, customer, store,
        service: (extra = {}) => createLunaProfileService({ accountReaderOptions, store: store(), now: () => clock, ...extra }),
        revoke() { active = false; }, resume() { active = true; }, purpose(value) { purpose = value; },
        onCustomer(fn) { customerHook = fn; }, clock(value) { clock = value; },
        path: 'customer-luna/profiles/' + account.accountId + '.json',
    };
}

test('own nickname survives service/store reconstruction without changing original account records or granting facts', async () => {
    const h = await fixture(), initial = clone([...h.accounts]);
    assert.equal(await h.service().read(h.header), null);
    const saved = await h.service().save(h.header, request('  Lu\u0301na  '));
    assert.deepEqual(saved, { accountId: h.account.accountId, revision: 1, nickname: 'Lúna',
        profileCreatedAt: new Date(AT + 1000).toISOString(), updatedAt: new Date(AT + 1000).toISOString() });
    assert.equal(Object.isFrozen(saved), true);
    assert.deepEqual(await h.service().read(h.header), saved);
    assert.deepEqual([...h.accounts], initial); assert.equal(h.counts.accountWrites, 0);
    assert.ok(h.blob.paths.every(path => path === h.path));
    assert.ok(!JSON.stringify(saved).includes('accountCreatedAt'));
    for (const purpose of ['verified_test', 'genuine_customer', 'unknown']) {
        h.purpose(purpose); assert.deepEqual(await h.service().read(h.header), saved);
    }
});

test('two accounts share the transport but can read and edit only their own UUID profile', async () => {
    const blob = transport(), a = await fixture(blob), b = await fixture(blob, 100);
    const own = await a.service().save(a.header, request('A'));
    assert.equal(await b.service().read(b.header), null);
    await b.service().save(b.header, request('B'));
    assert.deepEqual(await a.service().read(a.header), own);
    await assert.rejects(b.service().save(b.header, { ...request('A'), accountId: a.account.accountId }), denied(400, 'luna_profile_input_invalid'));
    assert.equal(blob.records.size, 2);
    const writes = blob.calls.writes, store = a.store();
    for (const alias of [a.account.accountId.toUpperCase(), '../' + a.account.accountId, a.account.accountId + ' ']) {
        await assert.rejects(store.load(alias), denied());
    }
    const forged = JSON.parse(blob.records.get(a.path).body); forged.accountId = b.account.accountId;
    blob.records.get(a.path).body = Buffer.from(JSON.stringify(forged));
    await assert.rejects(a.service().read(a.header), denied());
    assert.equal(blob.calls.writes, writes);
});

test('anonymous, expired, revoked and mismatched-account requests release no profile and make no writes', async () => {
    for (const mode of ['anonymous', 'session-expired', 'authority-expired', 'revoked', 'wrong-binding']) {
        const h = await fixture(); await h.service().save(h.header, request());
        if (mode === 'anonymous') h.revoke();
        if (mode === 'session-expired') h.customer.details.expiresAt = new Date(AT).toISOString();
        if (mode === 'authority-expired') h.customer.current.expiresAt = AT;
        if (mode === 'revoked') h.customer.current.status = 'revoked';
        if (mode === 'wrong-binding') h.customer.current.bindingId = ID(999);
        const before = h.blob.calls.writes, rejection = mode === 'anonymous' ? denied(401, 'luna_profile_unauthenticated') : denied();
        await assert.rejects(h.service().read(h.header), rejection);
        await assert.rejects(h.service().save(h.header, request('Edit', 1, ID(901))), rejection);
        assert.equal(h.blob.calls.writes, before);
    }
});

test('revocation during a storage read blocks disclosure and prevents an edit before its write', async () => {
    for (const action of ['read', 'save']) {
        const h = await fixture(); await h.service().save(h.header, request());
        h.blob.onDownload(() => h.revoke()); const before = h.blob.calls.writes;
        await assert.rejects(action === 'read' ? h.service().read(h.header) : h.service().save(h.header, request('Edit', 1, ID(901))),
            denied(401, 'luna_profile_unauthenticated'));
        assert.equal(h.blob.calls.writes, before);
    }
});

test('revocation during an acknowledged or lost-ack write denies the response and permits later authorized recovery', async () => {
    for (const lostAck of [false, true]) {
        const h = await fixture();
        h.blob.afterUpload(() => { h.revoke(); if (lostAck) throw new Error('private lost response'); });
        await assert.rejects(h.service().save(h.header, request()), denied(401, 'luna_profile_unauthenticated'));
        assert.equal(h.blob.records.size, 1); h.resume(); h.blob.afterUpload(null);
        assert.equal((await h.service().read(h.header)).nickname, 'Luna');
    }
});

test('revocation during the adapter replacement preflight prevents dispatch of any new write', async () => {
    const h = await fixture(), first = await h.service().save(h.header, request());
    let downloads = 0;
    h.blob.onDownload(() => { if (++downloads === 2) h.revoke(); });
    const before = h.blob.calls.writes;
    await assert.rejects(h.service().save(h.header, request('Must not commit', 1, ID(901))),
        denied(401, 'luna_profile_unauthenticated'));
    assert.equal(h.blob.calls.writes, before);
    h.resume(); h.blob.onDownload(null);
    assert.deepEqual(await h.service().read(h.header), first);
});

test('a repeated operation is acknowledged without rewriting and cannot be reused for a different nickname', async () => {
    const h = await fixture(), first = await h.service().save(h.header, request());
    h.clock(AT + 2000);
    assert.deepEqual(await h.service().save(h.header, request()), first); assert.equal(h.blob.calls.writes, 1);
    await assert.rejects(h.service().save(h.header, request('Different')), denied(409, 'luna_profile_conflict'));
    await assert.rejects(h.service().save(h.header, request('Luna', 1)), denied(409, 'luna_profile_conflict'));
    const second = await h.service().save(h.header, request('Edited', 1, ID(901)));
    assert.equal(second.profileCreatedAt, first.profileCreatedAt); assert.equal(second.revision, 2);
    await assert.rejects(h.service().save(h.header, request()), denied(409, 'luna_profile_conflict'));
    assert.deepEqual(await h.service().read(h.header), second); assert.equal(h.blob.calls.writes, 2);
});

test('lost acknowledgement is reconciled from exact durable bytes for initial and replacement saves', async () => {
    const h = await fixture();
    h.blob.afterUpload(() => { throw new Error('private provider response lost'); });
    const first = await h.service().save(h.header, request());
    h.clock(AT + 2000);
    const second = await h.service().save(h.header, request('Changed', 1, ID(901)));
    assert.equal(first.revision, 1); assert.equal(second.revision, 2);
    assert.deepEqual(await h.service().read(h.header), second); assert.equal(h.blob.calls.writes, 2);
});

test('simultaneous create and replace attempts have one CAS winner without overwriting the winner', async () => {
    for (const initial of [true, false]) {
        const h = await fixture(); if (!initial) await h.service().save(h.header, request());
        let waiting = 0, release;
        const barrier = new Promise(resolve => { release = resolve; });
        h.blob.onUpload(async () => { if (++waiting === 2) release(); await barrier; });
        const writes = h.blob.calls.writes, revision = initial ? 0 : 1;
        const outcomes = await Promise.allSettled([
            h.service().save(h.header, request('Left', revision, ID(902))),
            h.service().save(h.header, request('Right', revision, ID(903))),
        ]);
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
        const failure = outcomes.find(result => result.status === 'rejected');
        assert.ok(denied(409, 'luna_profile_conflict')(failure.reason));
        assert.deepEqual(await h.service().read(h.header), outcomes.find(result => result.status === 'fulfilled').value);
        assert.equal(h.blob.calls.writes - writes, 2);
    }
});

for (const initial of [true, false]) for (const winner of [0, 1]) {
    test(`identical concurrent ${initial ? 'create' : 'replace'} retries return durable winner ${winner} across clock ticks`, async () => {
        for (const lostAck of [false, true]) {
            const h = await fixture();
            if (!initial) await h.service().save(h.header, request());
            const revision = initial ? 0 : 1, writes = h.blob.calls.writes;
            const arrivals = [], releases = [];
            const entered = [0, 1].map(index => new Promise(resolve => { arrivals[index] = resolve; }));
            let uploads = 0;
            h.blob.onUpload(async () => {
                const index = uploads++;
                const gate = new Promise(resolve => { releases[index] = resolve; });
                arrivals[index](); await gate;
            });
            if (lostAck) h.blob.afterUpload(() => { throw new Error('Synthetic lost acknowledgement'); });
            h.clock(AT + 2000);
            const first = h.service().save(h.header, request('  Lu\u0301na  ', revision, ID(902)));
            await entered[0];
            h.clock(AT + 3000);
            const second = h.service().save(h.header, request('Lúna', revision, ID(902)));
            await entered[1];
            const pending = [first, second], settled = Promise.allSettled(pending);
            // Complete either request first, after both captured distinct times.
            releases[winner]();
            const committed = await pending[winner];
            releases[1 - winner]();
            const outcomes = await settled;
            assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled']);
            assert.deepEqual(outcomes[0].value, committed); assert.deepEqual(outcomes[1].value, committed);
            assert.equal(committed.updatedAt, new Date(AT + (winner === 0 ? 2000 : 3000)).toISOString());
            assert.equal(committed.profileCreatedAt, initial ? committed.updatedAt : new Date(AT + 1000).toISOString());
            assert.equal(committed.revision, revision + 1);
            assert.equal(h.blob.records.get(h.path).version, '"v' + (revision + 1) + '"');
            assert.equal(h.blob.calls.writes - writes, 2);
            assert.deepEqual(await h.service().read(h.header), committed);
            // A subsequent retry must recover without another conditional write.
            assert.deepEqual(await h.service().save(h.header, request('Lúna', revision, ID(902))), committed);
            assert.equal(h.blob.calls.writes - writes, 2);
        }
    });
}

test('concurrent reuse of an operation ID for a different nickname remains a conflict', async () => {
    const h = await fixture(); let release, entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let uploads = 0;
    h.blob.onUpload(async () => { if (++uploads === 1) { entered(); await gate; } });
    const pending = h.service().save(h.header, request('Original', 0, ID(902)));
    const rejected = assert.rejects(pending, denied(409, 'luna_profile_conflict'));
    await arrived; h.clock(AT + 2000);
    const winner = await h.service().save(h.header, request('Different', 0, ID(902)));
    release(); await rejected;
    assert.deepEqual(await h.service().read(h.header), winner);
    assert.equal(h.blob.records.get(h.path).version, '"v1"');
});

test('ambiguous uncommitted writes and newer competing records are never reported as successful', async () => {
    for (const competing of [false, true]) {
        const h = await fixture();
        if (competing) {
            h.blob.afterUpload(() => {
                const record = JSON.parse(h.blob.records.get(h.path).body);
                record.revision++; record.nickname = 'Successor'; record.lastMutation = { operationId: ID(905), expectedRevision: 1 };
                h.blob.records.set(h.path, { body: Buffer.from(JSON.stringify(record)), version: '"successor"' });
                throw new Error('lost response');
            });
        } else h.blob.onUpload(() => { throw new Error('no commit'); });
        await assert.rejects(h.service().save(h.header, request()), denied());
        assert.equal(h.blob.calls.writes, 1);
        assert.equal((await h.service().read(h.header))?.nickname || null, competing ? 'Successor' : null);
    }
});

test('strict commands reject malformed nickname, aliases, injected facts and accessors before storage', async () => {
    const h = await fixture();
    const malformed = ['', 'x'.repeat(41), 'abc\u202e', 'a\nb', '<script>', '\ud800', 42].map(value => request(value));
    malformed.push({ ...request(), expectedRevision: -1 }, { ...request(), expectedRevision: Number.MAX_SAFE_INTEGER },
        { ...request(), operationId: ID(900).toUpperCase() }, { ...request(), verified: true },
        Object.defineProperty(request(), 'nickname', { enumerable: true, get() { throw new Error('must not run'); } }));
    for (const input of malformed) await assert.rejects(h.service().save(h.header, input), denied(400, 'luna_profile_input_invalid'));
    assert.equal(h.blob.calls.writes, 0); assert.equal(h.blob.calls.reads, 0);
});

test('foreign, unknown-version, extra-field and future timestamp records fail closed without changing stored bytes', async () => {
    const h = await fixture(); await h.service().save(h.header, request());
    const original = Buffer.from(h.blob.records.get(h.path).body);
    for (const mutate of [v => { v.accountId = ID(999); }, v => { v.schemaVersion = 2; }, v => { v.score = 9000; },
        v => { v.updatedAt = v.profileCreatedAt = new Date(AT + 3000).toISOString(); }, v => { v.lastMutation.expectedRevision = 9; }]) {
        const value = JSON.parse(original); mutate(value); const body = Buffer.from(JSON.stringify(value));
        h.blob.records.set(h.path, { body, version: '"invalid"' });
        await assert.rejects(h.service().read(h.header), denied());
        assert.deepEqual(h.blob.records.get(h.path).body, body);
    }
    assert.equal(h.blob.calls.writes, 1);
});

test('bounded Blob reads reject malformed encoding, size, ETag, missing stream and non-not-found errors', async () => {
    const h = await fixture(); await h.service().save(h.header, request());
    for (const alter of [r => ({ ...r, etag: '*' }), r => ({ ...r, contentLength: MAX_BYTES + 1 }),
        r => ({ ...r, contentLength: r.contentLength + 1 }), r => ({ ...r, readableStreamBody: null }),
        r => ({ ...r, contentLength: 1, readableStreamBody: Readable.from([Buffer.from([0xff])]) }),
        r => ({ ...r, readableStreamBody: Readable.from([Buffer.alloc(MAX_BYTES + 1)]) })]) {
        h.blob.response(alter); await assert.rejects(h.store().load(h.account.accountId), denied());
    }
    h.blob.response(null);
    for (const fault of [error(403, 'AuthorizationFailure'), error(404, 'ContainerNotFound')]) {
        h.blob.onDownload(() => { throw fault; }); await assert.rejects(h.store().load(h.account.accountId), denied());
    }
});

test('adapter enforces record transition and stale ETags while preserving the original profile', async () => {
    const h = await fixture(), store = h.store(); await h.service().save(h.header, request());
    const before = await store.load(h.account.accountId), next = clone(before.record);
    next.revision = 2; next.lastMutation = { operationId: ID(901), expectedRevision: 1 }; next.nickname = 'Next';
    const authorized = async () => {};
    assert.equal(await store.replace(h.account.accountId, '"old"', next, authorized), false);
    for (const mutate of [v => { v.profileCreatedAt = new Date(AT).toISOString(); }, v => { v.revision = 3; v.lastMutation.expectedRevision = 2; },
        v => { v.lastMutation.operationId = before.record.lastMutation.operationId; }]) {
        const value = clone(next); mutate(value); await assert.rejects(store.replace(h.account.accountId, before.version, value, authorized), denied());
    }
    await assert.rejects(store.create(h.account.accountId, next, authorized), denied());
    await assert.rejects(store.replace(h.account.accountId, before.version, next), denied());
    assert.deepEqual(await store.load(h.account.accountId), before); assert.equal(h.blob.calls.writes, 1);
    assert.equal(Object.isFrozen(lunaProfileRecord(before.record).lastMutation), true);
});

test('nonmonotonic clock and current identity change during reader rechecks cannot write a nickname', async () => {
    const h = await fixture(); let reads = 0;
    await assert.rejects(h.service({ now: () => ++reads === 1 ? AT + 1000 : AT }).save(h.header, request()), denied());
    h.onCustomer(n => { if (n % 2 === 0) h.customer.current.revision++; });
    await assert.rejects(h.service().save(h.header, request()), denied());
    assert.equal(h.blob.calls.writes, 0);
});
