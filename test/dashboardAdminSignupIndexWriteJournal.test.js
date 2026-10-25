'use strict';

const { copy, fields, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createSignupIndexWriteJournal, WRITER_HEAD_KEY, TICKET_PREFIX, MAX_TICKETS_PER_SCAN } =
    require('../api/shared/dashboardAdmin/signupIndexWriteJournal');
const { uid } = require('./fixtures/dashboardAdminSignupData');

const A = 'starter-accounts/' + 'a'.repeat(64), B = 'starter-accounts/' + 'b'.repeat(64);
const digest = 'c'.repeat(64);
const denied = 'synthetic_journal_unavailable';
const fail = () => { throw new Error(denied); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    let serial = 1, next = 500000;
    const blobs = new Map(), sources = new Map(), calls = [];
    const state = { beforeRead: null, beforeWrite: null, afterWrite: null, listing: null, expired: false };
    const context = { signal: new AbortController().signal, check() { if (state.expired) fail(); return '2026-10-21T00:00:00.000Z'; } };
    const target = { provider: 'legacy', populationId: 'synthetic-population', indexId: 'synthetic-index',
        instanceId: uid(499999), sourceBindingSha256: 'd'.repeat(64), writerContract: 'all_application_account_writes_v2' };
    async function read(ctx, key, maximum, expected = null) {
        ctx.check(); calls.push({ action: 'read', key }); if (state.beforeRead) await state.beforeRead(key);
        ctx.check(); const found = blobs.get(key);
        if (!found) { if (expected) fail(); return null; }
        if (expected && expected !== found.etag) fail();
        return { value: copy(found.value, maximum), etag: found.etag };
    }
    async function upload(ctx, key, value, conditions) {
        ctx.check(); calls.push({ action: 'write', key, value: copy(value), conditions });
        if (state.beforeWrite) await state.beforeWrite(key, value, conditions);
        ctx.check(); const found = blobs.get(key);
        if (conditions.ifNoneMatch === '*' && found || conditions.ifMatch && conditions.ifMatch !== found?.etag) fail();
        blobs.set(key, { value: copy(value), etag: '"synthetic-' + serial++ + '"' });
        if (state.afterWrite) await state.afterWrite(key, value, conditions);
        ctx.check();
    }
    const container = { listBlobsFlat(options) { return (async function* () {
        if (state.listing) { yield* state.listing(options); return; }
        for (const name of [...blobs.keys()].filter(key => key.startsWith(options.prefix)).sort()) yield { name };
    })(); } };
    const config = { target, read, upload, container, fail, newId: () => uid(next++),
        checkpoint(value) { fields(value, ['writerEpoch', 'writerGeneration']); },
        reference(value) { fields(value, ['accountKey', 'value']); if (![A, B].includes(value.accountKey)) fail(); },
        async loadAccount(ctx, key) { ctx.check(); return sources.get(key) ?? null; } };
    const journal = createSignupIndexWriteJournal(config);
    const ref = (key, value = 'current') => ({ accountKey: key, value });
    const currentHead = () => blobs.get(WRITER_HEAD_KEY).value;
    const currentTicket = key => blobs.get(journal.ticketKey(key)).value;
    return { journal, config, context, blobs, sources, calls, state, ref, currentHead, currentTicket,
        init: () => journal.initialise(context), register: (key = A, kind = 'create', expected = null, candidate = digest) =>
            journal.register(context, kind, key, expected, candidate),
        async pin() { return journal.pin(context); },
        async publish(pinned) { return journal.publish(context, pinned, {
            writerEpoch: pinned.value.writerEpoch, writerGeneration: pinned.value.generation }); } };
}

test('ordinary registration cannot initialize missing durability', async () => {
    const h = fixture(); await expect(h.register()).rejects.toThrow(denied);
    expect(h.calls.some(call => call.action === 'write')).toBe(false);
});

test('registration persists prepared then generation then issued, without an index dependency', async () => {
    const h = fixture(); await h.init(); h.calls.length = 0;
    await h.register();
    const writes = h.calls.filter(call => call.action === 'write');
    expect(writes.map(call => call.key)).toEqual([h.journal.ticketKey(A), WRITER_HEAD_KEY, h.journal.ticketKey(A)]);
    expect(writes[0].value.family.phase).toBe('prepared');
    expect(writes[1].value.generation).toBe(1); expect(writes[1].value.state).toBe('dirty');
    expect(writes[2].value.family).toMatchObject({ phase: 'issued', generation: 1 });
    expect(h.calls.every(call => call.key === WRITER_HEAD_KEY || call.key.startsWith(TICKET_PREFIX))).toBe(true);
});

test('unresolved A allows B and every registration advances the generation', async () => {
    const h = fixture(); await h.init(); await h.register(A); await h.register(B);
    expect(h.currentHead().generation).toBe(2);
    expect(h.currentTicket(A).family.phase).toBe('issued'); expect(h.currentTicket(B).family.phase).toBe('issued');
    const pinned = await h.pin(); await expect(h.journal.scan(h.context, pinned)).rejects.toThrow(denied);
});

test('same-predicate retries remain one issued family and retain actual-source semantics', async () => {
    const h = fixture(); await h.init(); const first = await h.register(A), family = h.currentTicket(A).family;
    await h.register(A, 'create', null, 'e'.repeat(64));
    expect(h.currentTicket(A).family).toMatchObject({ familyId: family.familyId, phase: 'issued', generation: 2,
        initialCandidateSha256: digest });
    expect(h.currentHead().generation).toBe(2);
    await expect(h.journal.settle(h.context, first)).resolves.toBe(false);
    h.sources.set(A, { version: '"source-1"', reference: h.ref(A, 'actual winner') });
    await expect(h.journal.settle(h.context, first)).resolves.toBe(true);
    expect(h.currentTicket(A)).toMatchObject({ family: null, latest: { generation: 2, reference: h.ref(A, 'actual winner') } });
    expect([...h.blobs.keys()].filter(key => key.startsWith(TICKET_PREFIX))).toHaveLength(1);
});

test('an incompatible uncertain predicate blocks that account but not another one', async () => {
    const h = fixture(); await h.init(); await h.register(A, 'replace', '"source-1"');
    await expect(h.register(A, 'replace', '"source-2"')).rejects.toThrow(denied);
    await expect(h.register(B)).resolves.toMatchObject({ accountKey: B });
});

test.each(['before generation', 'after generation'])('prepared cancellation fences a writer stalled %s', async position => {
    const h = fixture(); await h.init(); const entered = deferred(), held = deferred(); let once = true;
    h.state.beforeWrite = async (key, value) => {
        if (once && (position === 'before generation' ? key === WRITER_HEAD_KEY && value.generation === 1
            : key === h.journal.ticketKey(A) && value.family?.phase === 'issued')) {
            once = false; entered.resolve(); await held.promise;
        }
    };
    const writing = h.register(), rejected = expect(writing).rejects.toThrow(denied);
    await entered.promise;
    const pinned = await h.pin(); await h.journal.scan(h.context, pinned); await h.publish(pinned);
    expect(h.currentTicket(A).family).toBeNull(); held.resolve(); await rejected;
    expect(h.currentTicket(A).family).toBeNull(); expect(h.sources.size).toBe(0);
});

test('a writer invalidates an in-flight read-only build even when already dirty', async () => {
    const h = fixture(); await h.init(); const pinned = await h.pin(); await h.register(B);
    await expect(h.publish(pinned)).rejects.toThrow(denied);
    expect(h.currentHead()).toMatchObject({ generation: 1, state: 'dirty' });
});

test.each(['not committed', 'committed'])('ambiguous issuance %s is reconciled before source permission is returned', async outcome => {
    const h = fixture(); await h.init();
    const reject = async (key, value) => { if (key === h.journal.ticketKey(A) && value.family?.phase === 'issued') fail(); };
    h.state[outcome === 'committed' ? 'afterWrite' : 'beforeWrite'] = reject;
    if (outcome === 'committed') await expect(h.register()).resolves.toMatchObject({ accountKey: A });
    else await expect(h.register()).rejects.toThrow(denied);
    expect(h.currentTicket(A).family.phase).toBe(outcome === 'committed' ? 'issued' : 'prepared');
});

test('an unreadable ambiguous issued ticket never grants source permission', async () => {
    const h = fixture(); await h.init();
    h.state.afterWrite = async (key, value) => {
        if (key === h.journal.ticketKey(A) && value.family?.phase === 'issued') {
            h.state.beforeRead = async readKey => { if (readKey === key) fail(); }; fail();
        }
    };
    await expect(h.register()).rejects.toThrow(denied); expect(h.currentTicket(A).family.phase).toBe('issued');
});

test.each(['absent', 'unchanged'])('replacement closure refuses %s source evidence', async evidence => {
    const h = fixture(); await h.init(); const receipt = await h.register(A, 'replace', '"source-1"');
    if (evidence === 'unchanged') h.sources.set(A, { version: '"source-1"', reference: h.ref(A) });
    await expect(h.journal.settle(h.context, receipt)).resolves.toBe(false);
    const pinned = await h.pin(); await expect(h.journal.scan(h.context, pinned)).rejects.toThrow(denied);
});

test('advanced replacement ETag closes the family and allows a different next predicate', async () => {
    const h = fixture(); await h.init(); const old = await h.register(A, 'replace', '"source-1"');
    h.sources.set(A, { version: '"source-2"', reference: h.ref(A, 'activated') });
    await h.journal.settle(h.context, old); const next = await h.register(A, 'replace', '"source-2"');
    expect(next.familyId).not.toBe(old.familyId);
    await expect(h.journal.settle(h.context, old)).resolves.toBe(false);
    expect(h.currentTicket(A).family.familyId).toBe(next.familyId);
});

test('a delayed settlement CAS cannot clear a newer family', async () => {
    const h = fixture(); await h.init(); const old = await h.register(A);
    h.sources.set(A, { version: '"source-1"', reference: h.ref(A) });
    const entered = deferred(), held = deferred(); let once = true;
    h.state.beforeWrite = async (key, value) => {
        if (once && key === h.journal.ticketKey(A) && value.family === null) { once = false; entered.resolve(); await held.promise; }
    };
    const settlement = h.journal.settle(h.context, old), rejected = expect(settlement).rejects.toThrow(denied);
    await entered.promise; const next = await h.register(A, 'replace', '"source-1"');
    held.resolve(); await rejected; expect(h.currentTicket(A).family.familyId).toBe(next.familyId);
});

test.each(['wrong prefix', 'duplicate', 'missing'])('ticket traversal refuses %s without a checkpoint', async variant => {
    const h = fixture(); await h.init(); await h.register(A);
    h.sources.set(A, { version: '"source-1"', reference: h.ref(A) });
    h.state.listing = async function* () {
        if (variant === 'wrong prefix') yield { name: 'other/private.json' };
        else if (variant === 'missing') yield { name: h.journal.ticketKey(B) };
        else { yield { name: h.journal.ticketKey(A) }; yield { name: h.journal.ticketKey(A) }; }
    };
    const pinned = await h.pin(); await expect(h.journal.scan(h.context, pinned)).rejects.toThrow(denied);
    expect(h.currentHead().checkpoint).toBeNull();
});

test('finite ticket-scan exhaustion refuses completeness without limiting unrelated registrations', async () => {
    const h = fixture(); await h.init(); const writerEpoch = h.currentHead().writerEpoch;
    for (let i = 0; i <= MAX_TICKETS_PER_SCAN; i++) {
        const key = 'starter-accounts/' + i.toString(16).padStart(64, '0');
        h.blobs.set(h.journal.ticketKey(key), { etag: '"ticket-' + i + '"', value: {
            schemaVersion: 2, recordType: 'dashboard_admin_signup_write_ticket', ...h.config.target,
            writerEpoch, accountKey: key, revision: 0, latest: null, family: null } });
    }
    const pinned = await h.pin(); await expect(h.journal.scan(h.context, pinned)).rejects.toThrow(denied);
    await expect(h.register(B)).resolves.toMatchObject({ accountKey: B });
});

test('writer epoch change cannot discard an earlier issued family', async () => {
    const h = fixture(); await h.init(); await h.register(A);
    h.blobs.get(WRITER_HEAD_KEY).value.writerEpoch = uid(999999);
    await expect(h.register(B)).rejects.toThrow(denied);
    expect(h.currentTicket(A).family.phase).toBe('issued');
});

test('a fresh process also refuses tickets from another writer epoch', async () => {
    const h = fixture(); await h.init(); await h.register(A);
    h.blobs.get(WRITER_HEAD_KEY).value.writerEpoch = uid(999999);
    const fresh = createSignupIndexWriteJournal(h.config), pinned = await fresh.pin(h.context);
    await expect(fresh.scan(h.context, pinned)).rejects.toThrow(denied);
});

test.each(['target', 'revision'])('writer head %s corruption is refused', async field => {
    const h = fixture(); await h.init(); await h.register(A); await h.journal.loadHead(h.context);
    const value = h.blobs.get(WRITER_HEAD_KEY).value;
    if (field === 'target') value.sourceBindingSha256 = '0'.repeat(64); else value.revision--;
    await expect(h.register(B)).rejects.toThrow(denied);
});

test('explicit retry binds the exact current read-only fence', async () => {
    const h = fixture(); await h.init(); const first = await h.pin();
    const expected = { headSha256: hash(first.value), operationId: first.value.fenceId };
    const second = await h.journal.pin(h.context, expected);
    await expect(h.journal.pin(h.context, expected)).rejects.toThrow(denied);
    await expect(h.publish(first)).rejects.toThrow(denied); await h.journal.scan(h.context, second); await h.publish(second);
    expect(h.currentHead().state).toBe('idle');
});
