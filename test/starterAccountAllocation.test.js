'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = global.test || require('node:test');
const { createStarterAccountAllocator, starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const SUBJECT = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000003';
const START = Date.parse('2026-09-29T00:00:00.000Z');
// Match the durable store's JSON boundary, including under Jest's VM realm.
const clone = value => JSON.parse(JSON.stringify(value));
function harness(accountType = 'consultant') {
    const records = new Map(); let at = START + 1000, activation = null, actor = { subjectKey: SUBJECT, email: 'synthetic@gmail.com' };
    let loseCreate = false, loseReplace = false, beforeReplace = null;
    const store = {
        async load(key) { return records.has(key) ? clone(records.get(key)) : null; },
        async create(key, record) {
            if (records.has(key)) throw new Error('conflict');
            records.set(key, { record: clone(record), version: 1 });
            if (loseCreate) { loseCreate = false; throw new Error('lost acknowledgement'); }
        },
        async replace(key, version, record) {
            if (beforeReplace) { const f = beforeReplace; beforeReplace = null; await f(); }
            const previous = records.get(key);
            if (!previous || previous.version !== version) return false;
            records.set(key, { record: clone(record), version: version + 1 });
            if (loseReplace) { loseReplace = false; throw new Error('lost acknowledgement'); }
            return true;
        }
    };
    const options = { store, now: () => at, readActivation: async () => clone(activation), captureOwner: async () => clone(actor) };
    const allocator = createStarterAccountAllocator(options);
    const proof = { schemaVersion: 1, requestId: crypto.randomUUID(), accountType, organisationName: 'Unrelated consulting name',
        email: actor.email, status: 'verified', codeHash: null, attempts: 1, createdAt: START,
        codeExpiresAt: START + 600000, expiresAt: START + 86400000, verifiedAt: START + 1000 };
    return { allocator, options, proof, records,
        client: organisationName => ({ requestId: crypto.randomUUID(), organisationName }),
        setTime: value => { at = value; }, setOwner: value => { actor = value; },
        setActivation: value => { activation = value; }, getActivation: () => clone(activation),
        loseCreate: () => { loseCreate = true; }, loseReplace: () => { loseReplace = true; },
        beforeReplace: action => { beforeReplace = action; },
        async active() {
            const reserved = await allocator.reserveInitial(proof);
            activation = { email: proof.email, subjectKey: SUBJECT, accountId: reserved.accountId,
                organisationId: reserved.organisations[0].organisationId, receiptId: crypto.randomUUID(), activatedAt: new Date(at).toISOString() };
            return allocator.activate({});
        }
    };
}
test('concurrent verified retries reserve one durable account and one set of server IDs', async () => {
    const h = harness(); h.loseCreate();
    const values = await Promise.all(Array.from({ length: 12 }, () => h.allocator.reserveInitial(h.proof)));
    assert.equal(new Set(values.map(v => v.accountId)).size, 1); assert.equal(h.records.size, 1);
    assert.deepEqual(values[0], values[11]); assert.equal(values[0].activation, null);
    assert.equal(values[0].organisations.length, 1);
    assert.doesNotMatch(starterAccountKey(h.proof.email), /synthetic|gmail/);
    assert.deepEqual(await h.allocator.reserveInitial({ ...h.proof, requestId: crypto.randomUUID() }), values[0]);
    await assert.rejects(h.allocator.reserveInitial({ ...h.proof, requestId: crypto.randomUUID(), organisationName: 'Different company' }), /starter_account_exists/);
    await assert.rejects(h.allocator.reserveInitial({ ...h.proof, requestId: crypto.randomUUID(), accountType: 'company' }), /starter_account_exists/);
    await assert.rejects(h.allocator.reserveInitial({ ...h.proof, verifiedAt: START }), /starter_request_changed/);
});
test('fresh email verification recovers the original account after the first setup cookie expires', async () => {
    const h = harness(), account = await h.active();
    const createdAt = START + 2 * 86400000;
    h.setTime(createdAt + 1000);
    const fresh = { ...h.proof, requestId: crypto.randomUUID(), createdAt, codeExpiresAt: createdAt + 600000,
        expiresAt: createdAt + 86400000, verifiedAt: createdAt + 1000 };
    const resumed = await h.allocator.reserveInitial(fresh);
    assert.deepEqual(resumed, account); assert.equal(h.records.size, 1);
    assert.equal(resumed.activation.validUntil, '2026-10-13T00:00:01.000Z');
});
test('unverified, stale, future or untyped proofs allocate nothing', async () => {
    const h = harness();
    const untyped = { ...h.proof }; delete untyped.accountType;
    for (const proof of [{ ...h.proof, status: 'pending' }, { ...h.proof, verifiedAt: START + 2000 }, untyped]) {
        await assert.rejects(h.allocator.reserveInitial(proof));
    }
    h.setTime(h.proof.expiresAt);
    await assert.rejects(h.allocator.reserveInitial(h.proof), /starter_proof_invalid/);
    assert.equal(h.records.size, 0);
});
test('activation comes from the canonical receipt, starts once and reconciles a lost acknowledgement', async () => {
    const h = harness(); h.loseReplace(); const account = await h.active();
    assert.equal(account.activation.validUntil, '2026-10-13T00:00:01.000Z');
    h.setTime(START + 86400000);
    assert.deepEqual(await h.allocator.activate({ accepted: true, activatedAt: '2099-01-01' }), account);
    h.setActivation({ ...h.getActivation(), activatedAt: new Date(START + 86400000).toISOString() });
    await assert.rejects(h.allocator.activate({}), /starter_activation_changed/);
    assert.equal([...h.records.values()][0].record.activation.activatedAt, '2026-09-29T00:00:01.000Z');
});
test('receipt scope and owner cannot be substituted and changed evidence fails before activation', async () => {
    const h = harness(), reserved = await h.allocator.reserveInitial(h.proof);
    const valid = { email: h.proof.email, subjectKey: SUBJECT, accountId: reserved.accountId,
        organisationId: reserved.organisations[0].organisationId, receiptId: crypto.randomUUID(), activatedAt: new Date(START + 1000).toISOString() };
    for (const change of [{ accountId: crypto.randomUUID() }, { organisationId: crypto.randomUUID() }, { activatedAt: '2026-10-01T00:00:00.000Z' }]) {
        h.setActivation({ ...valid, ...change }); await assert.rejects(h.allocator.activate({}), /starter_activation_invalid/);
    }
    let reads = 0;
    const changed = createStarterAccountAllocator({ ...h.options, readActivation: async () => ++reads === 1 ? valid : { ...valid, unexpected: true } });
    await assert.rejects(changed.activate({}));
    assert.equal([...h.records.values()][0].record.activation, null);
});
test('concurrent consultants can reserve exactly three client organisations, even with separate workers', async () => {
    const h = harness(); await h.active();
    const workers = Array.from({ length: 10 }, () => createStarterAccountAllocator(h.options));
    const attempts = await Promise.allSettled(workers.map((worker, i) => worker.reserveClient({}, h.client(`Client ${i}`))));
    assert.equal(attempts.filter(v => v.status === 'fulfilled').length, 3);
    assert.ok(attempts.filter(v => v.status === 'rejected').every(v => v.reason.code === 'starter_client_limit'));
    const saved = [...h.records.values()][0].record;
    assert.equal(saved.organisations.length, 4);
    assert.equal(new Set(saved.organisations.map(v => v.tenantId)).size, 4);
    assert.equal(new Set(saved.organisations.map(v => v.organisationId)).size, 4);
});
test('lost client response and retries at capacity retain the same scope without spending another slot', async () => {
    const h = harness(); await h.active(); h.loseReplace(); const command = h.client('First client');
    const first = await h.allocator.reserveClient({}, command);
    await h.allocator.reserveClient({}, h.client('Second client'));
    await h.allocator.reserveClient({}, h.client('Third client'));
    assert.deepEqual(await h.allocator.reserveClient({}, command), first);
    await assert.rejects(h.allocator.reserveClient({}, { ...command, organisationName: 'Different client' }), /starter_request_changed/);
    await assert.rejects(h.allocator.reserveClient({}, { ...command, tenantId: crypto.randomUUID() }));
    assert.equal([...h.records.values()][0].record.organisations.length, 4);
});
test('company, pending and foreign-subject requests cannot add client organisations', async () => {
    const company = harness('company'); await company.active();
    await assert.rejects(company.allocator.reserveClient({}, company.client('Client')), /starter_client_setup_denied/);
    const h = harness(); await h.allocator.reserveInitial(h.proof);
    await assert.rejects(h.allocator.reserveClient({}, h.client('Client')), /starter_client_setup_denied/);
    await h.active(); h.setOwner({ subjectKey: OTHER, email: h.proof.email });
    await assert.rejects(h.allocator.reserveClient({}, h.client('Client')), /starter_client_setup_denied/);
    h.setOwner({ subjectKey: SUBJECT, email: 'another@gmail.com' });
    await assert.rejects(h.allocator.reserveClient({}, h.client('Client')), /starter_account_missing/);
    assert.equal([...h.records.values()][0].record.organisations.length, 1);
});
test('revocation during a committed reservation denies its response and retains the charged slot', async () => {
    const h = harness(); await h.active();
    h.beforeReplace(() => h.setOwner({ subjectKey: OTHER, email: h.proof.email }));
    await assert.rejects(h.allocator.reserveClient({}, h.client('Client')), /starter_owner_changed/);
    assert.equal([...h.records.values()][0].record.organisations.length, 2);
});
test('expiry refuses new and repeated reservations while retaining all saved records', async () => {
    const h = harness(), active = await h.active(), command = h.client('Retained client');
    await h.allocator.reserveClient({}, command); const before = clone([...h.records.values()]);
    h.setTime(Date.parse(active.activation.validUntil));
    await assert.rejects(h.allocator.reserveClient({}, command), /starter_client_setup_denied/);
    await assert.rejects(h.allocator.reserveClient({}, h.client('Too late')), /starter_client_setup_denied/);
    assert.deepEqual([...h.records.values()], before);
});
test('expiry during the final identity recheck cannot return a usable reservation', async () => {
    const h = harness(), active = await h.active(); let captures = 0;
    const allocator = createStarterAccountAllocator({ ...h.options, captureOwner: async () => {
        if (++captures === 3) h.setTime(Date.parse(active.activation.validUntil));
        return { subjectKey: SUBJECT, email: h.proof.email };
    } });
    await assert.rejects(allocator.reserveClient({}, h.client('At the boundary')), /starter_client_setup_denied/);
    assert.equal([...h.records.values()][0].record.organisations.length, 2);
});
test('tampered plan, duplicate scope IDs and anonymous activation fail the durable record codec', async () => {
    const h = harness(), active = await h.active();
    assert.throws(() => starterAccountRecord({ ...active, planId: 'unlimited' }));
    const duplicate = clone(active); duplicate.organisations[0].organisationId = duplicate.organisations[0].tenantId;
    assert.throws(() => starterAccountRecord(duplicate));
    assert.throws(() => starterAccountRecord({ ...active, activation: { ...active.activation, subjectKey: 'browser-supplied' } }));
});

test('reader floor traverses retained legacy and sidecar clients without invoking any writer', async () => {
    const h=harness(),account=await h.active();
    for(let i=0;i<3;i++) await h.allocator.reserveClient({},h.client('Legacy '+i));
    const before=JSON.stringify([...h.records]), clients=new Map(), calls=[];
    const rows=Array.from({length:107},(_,i)=>Object.fromEntries(Object.keys(account.organisations[0]).map(k=>[k,
        k==='kind'?'client':k==='organisationName'?'Retained '+i:crypto.randomUUID()]))).sort((a,b)=>a.requestId.localeCompare(b.requestId));
    rows.forEach(slot=>clients.set(slot.requestId,slot));
    h.options.store.loadClient=async(accountId,requestId)=>{assert.equal(accountId,account.accountId);calls.push('read');return clone(clients.get(requestId)||null);};
    h.options.store.listClients=async(accountId,{cursor,limit})=>{assert.equal(accountId,account.accountId);assert.ok(limit<=50);calls.push('list');
        const offset=cursor===null?0:Number(cursor);return{clients:clone(rows.slice(offset,offset+limit)),nextCursor:offset+limit<rows.length?String(offset+limit):null};};
    const reader=createStarterAccountAllocator(h.options), seen=[],sizes=[];let cursor=null;
    do{const page=await reader.listClients({}, {cursor,limit:50});seen.push(...page.clients);sizes.push(page.clients.length);cursor=page.nextCursor;}while(cursor!==null);
    assert.deepEqual(sizes,[50,50,10]);assert.equal(new Set(seen.map(slot=>slot.requestId)).size,110);
    assert.deepEqual(await reader.readClient({},rows[60].requestId),rows[60]);
    assert.equal(await reader.readClient({},crypto.randomUUID()),null);
    assert.equal(JSON.stringify([...h.records]),before);assert.deepEqual(calls,['list','list','list','read','read']);
    assert.equal(typeof h.options.store.createClient,'undefined');assert.equal(typeof h.options.store.ensureClientBinding,'undefined');
    await assert.rejects(reader.reserveClient({},h.client('Fourth historical client')),/starter_client_limit/);
});
test('reader cursor and final ownership checks reject changed or foreign pages without effects', async () => {
    const h=harness(),account=await h.active();
    const slot=Object.fromEntries(Object.keys(account.organisations[0]).map(k=>[k,k==='kind'?'client':k==='organisationName'?'Saved':crypto.randomUUID()]));
    h.options.store.listClients=async()=>({clients:[slot],nextCursor:'next'});
    const first=await h.allocator.listClients({},{}),decoded=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
    decoded.accountId=crypto.randomUUID();
    await assert.rejects(h.allocator.listClients({}, {cursor:Buffer.from(JSON.stringify(decoded)).toString('base64url')}),/starter_cursor_invalid/);
    h.options.store.loadClient=async()=>{h.setOwner({subjectKey:OTHER,email:h.proof.email});return slot;};
    await assert.rejects(h.allocator.readClient({},slot.requestId),/starter_owner_changed/);
    h.setOwner({subjectKey:SUBJECT,email:h.proof.email});h.setTime(Date.parse(account.activation.validUntil));
    await assert.rejects(h.allocator.listClients({},{}),/starter_client_setup_denied/);
});
