'use strict';

const { Readable } = require('node:stream');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createSignupIndexMaintenance, INDEX_HEAD_KEY, WRITER_CONTRACT, WRITER_HEAD_KEY, TICKET_PREFIX } = require('../api/shared/dashboardAdmin/signupIndexMaintenance');
const { fixture: accountFixture, uid, clone } = require('./fixtures/dashboardAdminSignupData');

const AT = '2026-10-21T00:00:00.000Z', EPOCH = uid(900001), INSTANCE = uid(900002);
const unavailable = { code: 'dashboard_admin_signup_index_unavailable' };
let template;
beforeAll(async () => { template = (await accountFixture('legacy')).account; });
function account(seed = 1) {
    const value = clone(template), start = 10000 + seed * 100;
    value.accountId = uid(start); value.email = `synthetic-index-${seed}@example.invalid`;
    value.setupRequestId = uid(start + 1); value.organisations[0].requestId = value.setupRequestId;
    let next = start + 2;
    for (const key of Object.keys(value.organisations[0])) {
        if (!['requestId', 'kind', 'organisationName'].includes(key)) value.organisations[0][key] = uid(next++);
    }
    return value;
}
const missing = () => Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
const conflict = () => Object.assign(new Error('synthetic CAS'), { statusCode: 412, code: 'ConditionNotMet' });
function harness(records = [], overrides = {}) {
    let serial = 1, sequence = 910000;
    const blobs = new Map(), calls = [], state = { epoch: EPOCH, at: AT, beforeRead: null, beforeWrite: null, afterWrite: null, listing: null };
    const put = (key, value) => { blobs.set(key, { text: canonical(value), etag: `"synthetic-${serial++}"` }); };
    records.forEach(value => put('customer-starter/' + starterAccountKey(value.email) + '.json', value));
    const container = { getBlockBlobClient: jest.fn(key => ({
        async download(offset, maximum, options = {}) {
            calls.push({ kind: 'read', key, options });
            if (state.beforeRead) await state.beforeRead(key, options);
            const found = blobs.get(key); if (!found) throw missing();
            if (options.conditions?.ifMatch && options.conditions.ifMatch !== found.etag) throw conflict();
            const bytes = Buffer.from(found.text);
            return { etag: found.etag, contentLength: bytes.length, readableStreamBody: Readable.from([bytes]), ...found.response };
        },
        async uploadData(bytes, options = {}) {
            calls.push({ kind: 'write', key, options });
            if (state.beforeWrite) await state.beforeWrite(key, options, bytes);
            const found = blobs.get(key);
            if (options.conditions?.ifNoneMatch === '*' && found ||
                options.conditions?.ifMatch && options.conditions.ifMatch !== found?.etag) throw conflict();
            blobs.set(key, { text: bytes.toString(), etag: `"synthetic-${serial++}"` });
            if (state.afterWrite) await state.afterWrite(key, options, bytes);
        }
    })), listBlobsFlat: jest.fn(options => (async function* () {
        calls.push({ kind: 'list', options });
        if (state.listing) { yield* state.listing(options); return; }
        for (const name of [...blobs.keys()].filter(k => k.startsWith(options.prefix)).sort()) yield { name };
    })()) };
    const store = new AzureStarterAccountStore(container);
    const config = { container, accountStore: store, provider: 'legacy', populationId: 'synthetic-population', indexId: 'synthetic-index',
        instanceId: INSTANCE, sourceBindingSha256: hash({ source: 'synthetic-container' }), writerContract: WRITER_CONTRACT,
        readExternalRuntimeEpoch: async () => ({ instanceId: INSTANCE, restoreEpoch: state.epoch }),
        clock: () => state.at, newId: () => uid(sequence++), requestBudgetMs: 5000, ...overrides };
    const index = createSignupIndexMaintenance(config), authoriseMaintenance = jest.fn(async () => true);
    function head() { return JSON.parse(blobs.get(INDEX_HEAD_KEY).text); }
    function revision() { return JSON.parse(blobs.get('customer-starter/dashboard-admin-signup-index/revisions/' + head().recordSha256 + '.json').text); }
    function writerHead() { return JSON.parse(blobs.get(WRITER_HEAD_KEY).text); }
    function ticket(key) { return JSON.parse(blobs.get(TICKET_PREFIX + key.slice('starter-accounts/'.length) + '.json').text); }
    const rebuild = () => index.rebuild({ authoriseMaintenance });
    return { config, index, store, container, blobs, calls, state, put, head, writerHead, ticket, revision, rebuild, authoriseMaintenance };
}

test('absent index refuses disclosure and never enumerates or creates coverage automatically', async () => {
    const h = harness([account()]);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect(h.container.listBlobsFlat).not.toHaveBeenCalled();
    expect(h.calls.filter(c => c.kind === 'write')).toHaveLength(0);
});

test.each([0, 1, 3])('explicit fenced rebuild proves complete historical population of %i accounts', async count => {
    const records = Array.from({ length: count }, (_, i) => account(i + 1)), h = harness(records);
    await expect(h.rebuild()).resolves.toMatchObject({ state: 'complete', complete: true, count });
    expect(h.authoriseMaintenance).toHaveBeenCalledTimes(2);
    expect(h.authoriseMaintenance.mock.calls[0][0]).toMatchObject({ action: 'dashboard.signup_index.rebuild', writerContract: WRITER_CONTRACT });
    const result = await h.index.readCurrentIndex();
    expect(result.complete).toBe(true); expect(result.manifest.entries).toHaveLength(count);
    expect(result.sourceBindingSha256).toBe(h.config.sourceBindingSha256);
    expect(Object.isFrozen(result.manifest.entries)).toBe(true);
    expect(result.sourceReferences.map(r => r.accountKey)).toEqual(records.map(a => starterAccountKey(a.email)).sort());
    expect(JSON.stringify(h.revision())).not.toContain('@example.invalid');
    expect(h.container.listBlobsFlat).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'customer-starter/starter-accounts/' }));
    const firstHead = h.calls.findIndex(c => c.kind === 'write' && c.key === WRITER_HEAD_KEY);
    const list = h.calls.findIndex(c => c.kind === 'list');
    expect(firstHead).toBeLessThan(list);
    expect(h.calls.filter(c => c.kind === 'write' && c.key.includes('revisions/'))).toHaveLength(1);
});

test('an absent journal requires explicit initialization before any customer source write', async () => {
    const existing = account(), added = account(2), h = harness([existing]);
    await expect(h.index.accountStore.create(starterAccountKey(added.email), added)).rejects.toMatchObject(unavailable);
    expect(await h.store.load(starterAccountKey(added.email))).toBeNull();
    expect(h.calls.filter(c => c.kind === 'write')).toHaveLength(0);
    await h.rebuild();
    await expect(h.index.accountStore.create(starterAccountKey(added.email), added)).resolves.toBe(true);
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(2);
});

test('complete generation follows later account creation instead of freezing an approved cohort', async () => {
    const first = account(), second = account(2), h = harness([first]); await h.rebuild();
    const before = await h.index.readCurrentIndex();
    await expect(h.index.accountStore.create(starterAccountKey(second.email), second)).resolves.toBe(true);
    const after = await h.index.readCurrentIndex();
    expect(after.revision).toBeGreaterThan(before.revision); expect(after.manifest.entries).toHaveLength(2);
    expect(hash(after.manifest)).not.toBe(hash(before.manifest));
});

test('activation replacement updates the exact retained identity binding', async () => {
    const first = account(), key = starterAccountKey(first.email), h = harness([first]); await h.rebuild();
    const previous = await h.index.accountStore.load(key), subject = uid(11) + ':' + uid(12), at = AT;
    const next = { ...first, activation: { subjectKey: subject, receiptId: first.organisations[0].activationId,
        activatedAt: at, validUntil: accountWindow(at, first.planId).validUntil } };
    await expect(h.index.accountStore.replace(key, previous.version, next)).resolves.toBe(true);
    expect((await h.index.readCurrentIndex()).manifest.entries[0].binding.subjectKey).toBe(subject);
});

test('known conditional conflict returns false with the original complete member retained', async () => {
    const first = account(), key = starterAccountKey(first.email), h = harness([first]); await h.rebuild();
    await expect(h.index.accountStore.create(key, first)).resolves.toBe(false);
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
});

test('genuinely pending account A blocks listing while unrelated account B succeeds', async () => {
    const h = harness(); await h.rebuild();
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const original = h.store.create.bind(h.store);
    const spy = jest.spyOn(h.store, 'create').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const a = account(), b = account(2), writing = h.index.accountStore.create(starterAccountKey(a.email), a);
    await enteredPromise;
    expect(h.writerHead().state).not.toBe('idle');
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    release(); await writing;
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(2);
});

test('normal admin refresh closes an existing exact key without replaying the source call', async () => {
    const h = harness(); await h.rebuild(); const a = account(), key = starterAccountKey(a.email);
    jest.spyOn(h.store, 'create').mockRejectedValueOnce(new Error('synthetic uncertain network'));
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    h.put('customer-starter/' + key + '.json', a);
    expect(h.writerHead().state).not.toBe('idle');
    expect((await h.index.readCurrentIndex()).manifest.entries[0].binding.accountId).toBe(a.accountId);
    expect(h.store.create).toHaveBeenCalledTimes(1);
});

test('retry of a settled create closes its original condition and preserves the adapter conflict result', async () => {
    const h = harness(); await h.rebuild(); const a = account(), key = starterAccountKey(a.email);
    h.state.afterWrite = async path => { if (path === 'customer-starter/' + key + '.json') throw new Error('synthetic lost ack'); };
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    expect(await h.store.load(key)).not.toBeNull(); expect(h.writerHead().state).not.toBe('idle');
    await expect(h.index.accountStore.create(key, a)).resolves.toBe(false);
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
    expect((await h.store.load(key)).record).toEqual(a);
});

test('lost index-head acknowledgement reconciles only the exact intended immutable generation', async () => {
    const h = harness([account()]); let once = true;
    h.state.afterWrite = async key => { if (key === INDEX_HEAD_KEY && once) { once = false; throw new Error('synthetic lost index ack'); } };
    await expect(h.rebuild()).resolves.toMatchObject({ complete: true });
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
});

test('100-to-101 account growth makes coverage explicitly unavailable without rejecting the customer account', async () => {
    const h = harness(Array.from({ length: 100 }, (_, i) => account(i + 1))); await h.rebuild();
    const next = account(101), key = starterAccountKey(next.email);
    await expect(h.index.accountStore.create(key, next)).resolves.toBe(true);
    expect(await h.store.load(key)).not.toBeNull();
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect(h.head().state).toBe('overflow');
    expect(h.revision().sourceReferences).toEqual([]);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    const further = account(102);
    await expect(h.index.accountStore.create(starterAccountKey(further.email), further)).resolves.toBe(true);
    expect(h.head().state).toBe('overflow');
});

test('historical overflow is explicit and never publishes a truncated first 100', async () => {
    const h = harness(Array.from({ length: 101 }, (_, i) => account(i + 1)));
    await expect(h.rebuild()).resolves.toEqual({ complete: false, count: null, revision: 0, state: 'overflow' });
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect(h.revision().sourceReferences).toHaveLength(0);
});

test.each([
    ['wrong prefix', () => [{ name: 'other/private.json' }]],
    ['duplicate entry', h => { const name = [...h.blobs.keys()][0]; return [{ name }, { name }]; }],
    ['listed account missing', () => [{ name: 'customer-starter/starter-accounts/' + '0'.repeat(64) + '.json' }]]
])('rebuild refuses %s and retains its exclusive pending fence', async (_, items) => {
    const h = harness([account()]); h.state.listing = async function* () { yield* items(h); };
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.writerHead().state).not.toBe('idle'); await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test('missing maintenance approval denies before any index write or enumeration', async () => {
    const h = harness([account()]); h.authoriseMaintenance.mockResolvedValue(false);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.calls.filter(c => c.kind === 'write' || c.kind === 'list')).toHaveLength(0);
});

test('revoked maintenance approval after enumeration leaves the generation nonlistable', async () => {
    const h = harness([account()]); h.authoriseMaintenance.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable); expect(h.writerHead().state).not.toBe('idle');
});

test('restore epoch changes during enumeration forbid complete publication', async () => {
    const a = account(), h = harness([a]);
    h.state.listing = async function* () { yield { name: 'customer-starter/' + starterAccountKey(a.email) + '.json' }; h.state.epoch = uid(900003); };
    await expect(h.rebuild()).rejects.toMatchObject(unavailable); expect(h.writerHead().state).not.toBe('idle');
});

test('restored old epoch is unavailable instead of automatically rebuilding coverage', async () => {
    const h = harness([account()]); await h.rebuild(); h.state.epoch = uid(900003);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
});

test('a new configuration cannot use a separate population alias to bypass the source fence', async () => {
    const h = harness([account()]); await h.rebuild();
    const other = createSignupIndexMaintenance({ ...h.config, populationId: 'other-population' });
    await expect(other.readCurrentIndex()).rejects.toMatchObject(unavailable);
    await expect(other.accountStore.create(starterAccountKey(account(2).email), account(2))).rejects.toMatchObject(unavailable);
});

test.each(['sourceBindingSha256', 'provider', 'instanceId'])('wrong configured %s cannot consume retained coverage', async field => {
    const h = harness([account()]); await h.rebuild();
    const changed = field === 'sourceBindingSha256' ? 'a'.repeat(64) : field === 'provider' ? 'external' : uid(987654);
    const other = createSignupIndexMaintenance({ ...h.config, [field]: changed });
    await expect(other.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test('index rollback is rejected after a later complete revision has been observed', async () => {
    const h = harness([account()]); await h.rebuild(); const old = clone(h.blobs.get(INDEX_HEAD_KEY));
    await h.index.readCurrentIndex(); const second = account(2);
    await h.index.accountStore.create(starterAccountKey(second.email), second);
    await h.index.readCurrentIndex();
    h.blobs.set(INDEX_HEAD_KEY, old);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test.each(['changed head', 'noncanonical archive', 'missing archive'])('read rejects %s', async variant => {
    const h = harness([account()]); await h.rebuild();
    const archive = 'customer-starter/dashboard-admin-signup-index/revisions/' + h.head().recordSha256 + '.json';
    if (variant === 'missing archive') h.blobs.delete(archive);
    else if (variant === 'noncanonical archive') h.blobs.get(archive).text += '\n';
    else h.state.beforeRead = async (key, options) => {
        if (key === INDEX_HEAD_KEY && options.conditions?.ifMatch) h.blobs.get(key).etag = '"changed"';
    };
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test('head CAS conflict prevents the original account write', async () => {
    const h = harness(); await h.rebuild(); const create = jest.spyOn(h.store, 'create'), a = account();
    h.state.beforeWrite = async key => { if (key === WRITER_HEAD_KEY) throw conflict(); };
    await expect(h.index.accountStore.create(starterAccountKey(a.email), a)).rejects.toMatchObject(unavailable);
    expect(create).not.toHaveBeenCalled(); expect(h.head().state).toBe('complete');
});

test('pre-aborted index reads make no source call', async () => {
    const h = harness([account()]), controller = new AbortController(); controller.abort();
    await expect(h.index.readCurrentIndex({ signal: controller.signal })).rejects.toMatchObject(unavailable);
    expect(h.calls).toHaveLength(0);
});

test('an original account write completing after deadline cannot publish a complete generation', async () => {
    jest.useFakeTimers();
    try {
        const h = harness([], { requestBudgetMs: 10000 }); await h.rebuild();
        let enter, finish;
        const entered = new Promise(resolve => { enter = resolve; });
        const held = new Promise(resolve => { finish = resolve; });
        const a = account(), key = starterAccountKey(a.email), original = h.store.create.bind(h.store);
        jest.spyOn(h.store, 'create').mockImplementationOnce(async (...args) => { enter(); await held; return original(...args); });
        const writing = h.index.accountStore.create(key, a), rejected = expect(writing).rejects.toMatchObject(unavailable);
        await entered; await jest.advanceTimersByTimeAsync(10001); await rejected;
        expect(h.writerHead().state).not.toBe('idle');
        const retained = h.head(); finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(h.head()).toEqual(retained); expect(h.writerHead().state).not.toBe('idle');
        expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
    } finally { jest.useRealTimers(); }
});

test('invalid replacement identity is refused before acquiring the population fence', async () => {
    const first = account(), key = starterAccountKey(first.email), h = harness([first]); await h.rebuild();
    const loaded = await h.store.load(key), before = h.head();
    await expect(h.index.accountStore.replace(key, loaded.version, { ...first, accountId: uid(999999) })).rejects.toMatchObject(unavailable);
    expect(h.head()).toEqual(before);
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
});

test('known stale replacement preserves the complete index without a write', async () => {
    const first = account(), key = starterAccountKey(first.email), h = harness([first]); await h.rebuild(); const before = h.head();
    await expect(h.index.accountStore.replace(key, '"stale"', first)).resolves.toBe(false);
    expect(h.head()).toEqual(before);
});

test('malformed source identity cannot become a complete index member', async () => {
    const first = account(), h = harness([first]), path = 'customer-starter/' + starterAccountKey(first.email) + '.json';
    const changed = { ...first, accountType: 'administrator' }; h.put(path, changed);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.writerHead().state).not.toBe('idle');
});

test('a source account UUID alias is rejected across distinct emails and scopes', async () => {
    const first = account(), second = account(2); second.accountId = first.accountId;
    const h = harness([first, second]); await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.writerHead().state).not.toBe('idle');
});

test('unknown underlying account return values leave pending instead of treating truthiness as acknowledgement', async () => {
    const h = harness(); await h.rebuild(); const first = account();
    jest.spyOn(h.store, 'create').mockResolvedValueOnce({ success: true });
    await expect(h.index.accountStore.create(starterAccountKey(first.email), first)).rejects.toMatchObject(unavailable);
    expect(h.writerHead().state).not.toBe('idle');
});

test('acknowledged original write preserves true despite a missing readback and leaves the index pending', async () => {
    const h = harness(); await h.rebuild(); const first = account();
    jest.spyOn(h.store, 'create').mockResolvedValueOnce(true);
    await expect(h.index.accountStore.create(starterAccountKey(first.email), first)).resolves.toBe(true);
    expect(h.writerHead().state).not.toBe('idle');
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test('source binding changes while head is reread cannot release an old complete generation', async () => {
    const h = harness([account()]); await h.rebuild();
    h.state.beforeRead = async (key, options) => {
        if (key === INDEX_HEAD_KEY && options.conditions?.ifMatch) h.put(key, { ...h.head(), sourceBindingSha256: 'f'.repeat(64) });
    };
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
});

test('clock rollback prevents source reads after a complete observation', async () => {
    const h = harness([account()]); await h.rebuild(); await h.index.readCurrentIndex();
    h.state.at = '2026-10-20T00:00:00.000Z'; const before = h.calls.length;
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable); expect(h.calls).toHaveLength(before);
});

test('an exact failed read-only rebuild can be explicitly superseded without releasing its fence', async () => {
    const h = harness([account()]); h.state.listing = async function* () { throw new Error('synthetic listing failed'); };
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    const observed = await h.index.inspect(); expect(observed).toMatchObject({ state: 'pending', operationKind: 'rebuild' });
    h.state.listing = null;
    const expectedPendingRebuild = { headSha256: observed.headSha256, operationId: observed.operationId };
    await expect(h.index.rebuild({ authoriseMaintenance: h.authoriseMaintenance, expectedPendingRebuild }))
        .resolves.toMatchObject({ complete: true, count: 1 });
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
    expect(h.authoriseMaintenance.mock.calls.at(-1)[0].expectedPendingRebuild).toEqual(expectedPendingRebuild);
});

test('retrying a stale rebuild fence cannot replace a newer complete generation', async () => {
    const h = harness([account()]); h.state.listing = async function* () { throw new Error('synthetic failed'); };
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    const observed = await h.index.inspect(), expectedPendingRebuild = { headSha256: observed.headSha256, operationId: observed.operationId };
    h.state.listing = null; await h.index.rebuild({ authoriseMaintenance: h.authoriseMaintenance, expectedPendingRebuild });
    const current = h.head();
    await expect(h.index.rebuild({ authoriseMaintenance: h.authoriseMaintenance, expectedPendingRebuild })).rejects.toMatchObject(unavailable);
    expect(h.head()).toEqual(current);
});

test('rebuild retry never clears an uncertain account write even with its exact observed identifiers', async () => {
    const h = harness(); await h.rebuild(); const a = account();
    jest.spyOn(h.store, 'create').mockRejectedValueOnce(new Error('synthetic uncertain'));
    await expect(h.index.accountStore.create(starterAccountKey(a.email), a)).rejects.toMatchObject(unavailable);
    const observed = await h.index.inspect(), expectedPendingRebuild = { headSha256: observed.headSha256, operationId: observed.operationId };
    await expect(h.index.rebuild({ authoriseMaintenance: h.authoriseMaintenance, expectedPendingRebuild })).rejects.toMatchObject(unavailable);
    expect(h.writerHead().state).not.toBe('idle');
});

test('a superseded old rebuild cannot publish after the new rebuild finishes', async () => {
    const a = account(), h = harness([a]); let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.listing = async function* () { enter(); await held; yield { name: 'customer-starter/' + starterAccountKey(a.email) + '.json' }; };
    const original = h.rebuild(), originalRejected = expect(original).rejects.toMatchObject(unavailable);
    await entered;
    const observed = await h.index.inspect(), expectedPendingRebuild = { headSha256: observed.headSha256, operationId: observed.operationId };
    h.state.listing = null;
    await h.index.rebuild({ authoriseMaintenance: h.authoriseMaintenance, expectedPendingRebuild });
    const published = h.head(); finish(); await originalRejected;
    expect(h.head()).toEqual(published); expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
});

test('a later account creation recovers a settled lost acknowledgement without losing either member', async () => {
    const h = harness(); await h.rebuild(); const a = account(), b = account(2), key = starterAccountKey(a.email);
    h.state.afterWrite = async path => { if (path === 'customer-starter/' + key + '.json') throw new Error('synthetic lost ack'); };
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    expect((await h.index.readCurrentIndex()).manifest.entries.map(entry => entry.binding.accountId).sort())
        .toEqual([a.accountId, b.accountId].sort());
});

test.each(['create', 'replace'])('a settled %s finalizer cannot supersede the subsequent customer generation', async kind => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), h = harness(kind === 'replace' ? [a] : []);
    await h.rebuild(); const previous = kind === 'replace' ? await h.store.load(key) : null;
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.afterWrite = async path => { if (path === 'customer-starter/' + key + '.json') { enter(); await held; } };
    const original = kind === 'create' ? h.index.accountStore.create(key, a) : h.index.accountStore.replace(key, previous.version, a);
    await entered;
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    const published = h.head(); finish(); await expect(original).resolves.toBe(true);
    expect(h.head()).toEqual(published); expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(2);
});

test.each(['create', 'replace'])('positive closure prevents a delayed original %s from writing after recovery', async kind => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), path = 'customer-starter/' + key + '.json';
    const h = harness(kind === 'replace' ? [a] : []); await h.rebuild();
    const previous = kind === 'replace' ? await h.store.load(key) : null;
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.beforeWrite = async written => { if (written === path) { enter(); await held; } };
    const original = kind === 'create' ? h.index.accountStore.create(key, a) : h.index.accountStore.replace(key, previous.version, a);
    await entered;
    // Model an earlier conditional attempt settling while the original SDK
    // request is delayed. Its valid value deliberately differs from candidate.
    const settled = { ...a, activation: { subjectKey: uid(31) + ':' + uid(32), receiptId: a.organisations[0].activationId,
        activatedAt: AT, validUntil: accountWindow(AT, a.planId).validUntil } };
    h.put(path, settled);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    const published = h.head(); finish(); await expect(original).resolves.toBe(false);
    expect((await h.store.load(key)).record).toEqual(settled); expect(h.head()).toEqual(published);
    const member = (await h.index.readCurrentIndex()).manifest.entries.find(entry => entry.binding.accountId === a.accountId);
    expect(member.binding.subjectKey).toBe(settled.activation.subjectKey);
});

test('lost replacement acknowledgement recovers using changed ETag and retains the activated subject', async () => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), h = harness([a]); await h.rebuild();
    const previous = await h.store.load(key), subjectKey = uid(41) + ':' + uid(42);
    const next = { ...a, activation: { subjectKey, receiptId: a.organisations[0].activationId,
        activatedAt: AT, validUntil: accountWindow(AT, a.planId).validUntil } };
    h.state.afterWrite = async path => { if (path === 'customer-starter/' + key + '.json') throw new Error('synthetic lost ack'); };
    await expect(h.index.accountStore.replace(key, previous.version, next)).rejects.toMatchObject(unavailable);
    expect((await h.store.load(key)).version).not.toBe(previous.version);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    const member = (await h.index.readCurrentIndex()).manifest.entries.find(entry => entry.binding.accountId === a.accountId);
    expect(member.binding.subjectKey).toBe(subjectKey);
});

test.each(['absent create', 'unchanged replacement'])('%s remains unresolved while unrelated onboarding proceeds', async kind => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), replacing = kind === 'unchanged replacement';
    const h = harness(replacing ? [a] : []); await h.rebuild();
    const previous = replacing ? await h.store.load(key) : null;
    jest.spyOn(h.store, replacing ? 'replace' : 'create').mockRejectedValueOnce(new Error('synthetic unknown outcome'));
    const original = replacing ? h.index.accountStore.replace(key, previous.version, a) : h.index.accountStore.create(key, a);
    await expect(original).rejects.toMatchObject(unavailable); const pending = h.head();
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.head()).toEqual(pending); expect(h.ticket(key).family.phase).toBe('issued');
    expect((await h.store.load(starterAccountKey(b.email))).record).toEqual(b);
});

test.each(['wrong key', 'invalid ETag', 'changed account UUID', 'changed epoch', 'changed source binding'])
('listing rejects %s without blocking the next customer account', async fault => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), h = harness([a]); await h.rebuild();
    jest.spyOn(h.store, 'create').mockRejectedValueOnce(new Error('synthetic unknown'));
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    if (fault === 'wrong key') h.put('customer-starter/' + key + '.json', b);
    if (fault === 'invalid ETag') h.blobs.get('customer-starter/' + key + '.json').etag = 'invalid';
    if (fault === 'changed account UUID') h.put('customer-starter/' + key + '.json', { ...a, accountId: uid(999990) });
    if (fault === 'changed epoch') h.state.epoch = uid(900003);
    if (fault === 'changed source binding') h.put(INDEX_HEAD_KEY, { ...h.head(), sourceBindingSha256: 'e'.repeat(64) });
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect((await h.store.load(starterAccountKey(b.email))).record).toEqual(b);
});

test('an account ticket CAS failure blocks only that account', async () => {
    const a = account(), b = account(2), key = starterAccountKey(a.email), h = harness([a]); await h.rebuild();
    jest.spyOn(h.store, 'create').mockRejectedValueOnce(new Error('synthetic unknown'));
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    const pending = h.head(), ownTicket = TICKET_PREFIX + key.slice('starter-accounts/'.length) + '.json';
    h.state.beforeWrite = async path => { if (path === ownTicket) throw conflict(); };
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    expect(h.head()).toEqual(pending); expect((await h.store.load(starterAccountKey(b.email))).record).toEqual(b);
});

test.each([true, false])('customer creation preempts read-only rebuild while preserving prior complete=%s', async complete => {
    const a = account(), b = account(2), h = harness([a]); if (complete) await h.rebuild();
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.listing = async function* () { enter(); await held; yield { name: 'customer-starter/' + starterAccountKey(a.email) + '.json' }; };
    const rebuilding = h.rebuild(), rejected = expect(rebuilding).rejects.toMatchObject(unavailable);
    await entered; await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    const published = h.blobs.get(INDEX_HEAD_KEY)?.text; finish(); await rejected;
    expect(h.blobs.get(INDEX_HEAD_KEY)?.text).toBe(published); h.state.listing = null;
    if (complete) expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(2);
    else {
        expect(h.writerHead().checkpoint).toBeNull(); await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
        await expect(h.rebuild()).resolves.toMatchObject({ complete: true, count: 2 });
    }
});

test.each([true, false])('index publication failure preserves definitive source result %s', async result => {
    const a = account(), key = starterAccountKey(a.email), h = harness(result ? [] : [a]); await h.rebuild();
    h.state.beforeWrite = async (path, options, bytes) => {
        if (path === INDEX_HEAD_KEY && JSON.parse(bytes).state === 'complete') throw conflict();
    };
    await expect(h.index.accountStore.create(key, a)).resolves.toBe(result);
    expect(h.writerHead().state).not.toBe('idle'); await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect((await h.store.load(key)).record).toEqual(a);
    h.state.beforeWrite = null;
    await expect(h.rebuild()).resolves.toMatchObject({ complete: true, count: 1 });
});

test('index finalization deadline preserves an already acknowledged source result and cannot publish late', async () => {
    jest.useFakeTimers();
    try {
        const a = account(), key = starterAccountKey(a.email), h = harness([], { requestBudgetMs: 10000 }); await h.rebuild();
        let enter, finish;
        const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
        h.state.beforeRead = async path => { if (path === 'customer-starter/' + key + '.json') { enter(); await held; } };
        const writing = h.index.accountStore.create(key, a); await entered;
        await jest.advanceTimersByTimeAsync(10001); await expect(writing).resolves.toBe(true);
        const pending = h.head(); finish(); await jest.advanceTimersByTimeAsync(0); expect(h.head()).toEqual(pending);
        expect(h.writerHead().state).not.toBe('idle');
        expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(1);
    } finally { jest.useRealTimers(); }
});

test.each(['writerContract', 'sourceBindingSha256', 'newId', 'requestBudgetMs'])('invalid %s is rejected before I/O', field => {
    const h = harness();
    expect(() => createSignupIndexMaintenance({ ...h.config, [field]: null })).toThrow('dashboard_admin_signup_index_unavailable');
    expect(h.calls).toHaveLength(0);
});

test('ordinary source writes do not read the index, archives or native administration epoch', async () => {
    const epoch = jest.fn(async () => ({ instanceId: INSTANCE, restoreEpoch: EPOCH }));
    const h = harness([], { readExternalRuntimeEpoch: epoch }); await h.rebuild(); const a = account(), b = account(2);
    const before = epoch.mock.calls.length, start = h.calls.length;
    epoch.mockRejectedValue(new Error('synthetic administration database unavailable'));
    h.state.beforeRead = async path => {
        if (path === INDEX_HEAD_KEY || path.includes('/revisions/')) throw new Error('synthetic archive unavailable');
    };
    await expect(h.index.accountStore.create(starterAccountKey(a.email), a)).resolves.toBe(true);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    expect(epoch).toHaveBeenCalledTimes(before);
    expect(h.calls.slice(start).filter(call => call.kind === 'read' &&
        (call.key === INDEX_HEAD_KEY || call.key.includes('/revisions/')))).toHaveLength(0);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    epoch.mockResolvedValue({ instanceId: INSTANCE, restoreEpoch: EPOCH }); h.state.beforeRead = null;
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(2);
});

test('legacy index heads cannot silently initialize a new journal or erase an unknown v1 operation', async () => {
    const h = harness([account()]); h.put(INDEX_HEAD_KEY, { schemaVersion: 1, state: 'pending' });
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.blobs.has(WRITER_HEAD_KEY)).toBe(false);
    expect(h.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('failed initial historical scan permits journaled onboarding but never automatic historical coverage', async () => {
    const a = account(), b = account(2), h = harness([a]);
    h.state.listing = async function* (options) {
        if (options.prefix === 'customer-starter/starter-accounts/') throw new Error('synthetic history unavailable');
    };
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    await expect(h.index.readCurrentIndex()).rejects.toMatchObject(unavailable);
    expect(h.writerHead().checkpoint).toBeNull(); h.state.listing = null;
    await expect(h.rebuild()).resolves.toMatchObject({ complete: true, count: 2 });
});

test('normal refresh cancels a prepared writer that already invalidated the generation', async () => {
    const h = harness(); await h.rebuild(); const a = account(), key = starterAccountKey(a.email);
    const create = jest.spyOn(h.store, 'create'); let enter, finish, once = true;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.beforeWrite = async (path, options, bytes) => {
        if (once && path.startsWith(TICKET_PREFIX) && JSON.parse(bytes).family?.phase === 'issued') {
            once = false; enter(); await held;
        }
    };
    const writing = h.index.accountStore.create(key, a), rejected = expect(writing).rejects.toMatchObject(unavailable);
    await entered; expect(h.ticket(key).family.phase).toBe('prepared');
    expect((await h.index.readCurrentIndex()).manifest.entries).toHaveLength(0);
    const published = h.head(); finish(); await rejected;
    expect(create).not.toHaveBeenCalled(); expect(h.head()).toEqual(published); expect(h.ticket(key).family).toBeNull();
});

test('a genuine same-account create retry closes the family without replaying its saved candidate', async () => {
    const h = harness(); await h.rebuild(); const old = account(), key = starterAccountKey(old.email);
    const retry = { ...old, accountId: uid(999990) }; let enter, finish, once = true;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { finish = resolve; });
    h.state.beforeWrite = async path => {
        if (once && path === 'customer-starter/' + key + '.json') { once = false; enter(); await held; }
    };
    const original = h.index.accountStore.create(key, old); await entered;
    const familyId = h.ticket(key).family.familyId;
    await expect(h.index.accountStore.create(key, retry)).resolves.toBe(true);
    expect(h.ticket(key).family).toBeNull(); expect(h.writerHead().generation).toBe(2);
    expect((await h.index.readCurrentIndex()).manifest.entries[0].binding.accountId).toBe(retry.accountId);
    const published = h.head(); finish(); await expect(original).resolves.toBe(false);
    expect(h.head()).toEqual(published); expect((await h.store.load(key)).record).toEqual(retry);
    expect(familyId).toBeTruthy();
});

test('unresolved families survive runtime epoch changes while unrelated source writes proceed', async () => {
    const h = harness(); await h.rebuild(); const a = account(), b = account(2), key = starterAccountKey(a.email);
    jest.spyOn(h.store, 'create').mockRejectedValueOnce(new Error('synthetic uncertain'));
    await expect(h.index.accountStore.create(key, a)).rejects.toMatchObject(unavailable);
    const family = h.ticket(key).family; h.state.epoch = uid(900003);
    await expect(h.index.accountStore.create(starterAccountKey(b.email), b)).resolves.toBe(true);
    await expect(h.rebuild()).rejects.toMatchObject(unavailable);
    expect(h.ticket(key).family).toEqual(family);
});
