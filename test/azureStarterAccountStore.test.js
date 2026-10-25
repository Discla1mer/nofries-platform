'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = global.test || require('node:test');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createStarterAccountAllocator, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const SUBJECT = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const AT = Date.parse('2026-09-29T00:00:00.000Z');
function fixture() {
    const blobs = new Map(), calls = []; let loadError = null, writeError = null, loseWrite = false;
    const error = (statusCode, code) => Object.assign(new Error('Synthetic storage result'), { statusCode, code });
    const container = {
        listBlobsFlat(options) {
            calls.push({op:'list',prefix:options.prefix,signal:options.abortSignal});
            return {byPage(command){return(async function*(){
                calls.push({op:'page',limit:command.maxPageSize,token:command.continuationToken});
                const names=[...blobs.keys()].filter(name=>name.startsWith(options.prefix)).sort();
                const offset=command.continuationToken?Number(command.continuationToken):0, selected=names.slice(offset,offset+command.maxPageSize);
                yield{continuationToken:offset+selected.length<names.length?String(offset+selected.length):undefined,segment:{blobItems:selected.map(name=>({name}))}};
            })();}};
        },
        getBlockBlobClient(path) {
        return {
            async download(offset, count, options) {
                calls.push({ op: 'read', path, offset, count, signal: options.abortSignal });
                if (loadError) throw loadError;
                const entry = blobs.get(path); if (!entry) throw error(404, 'BlobNotFound');
                return { etag: entry.etag, contentLength: entry.body.length, readableStreamBody: Readable.from([entry.body]) };
            },
            async uploadData(body, options) {
                calls.push({ op: 'write', path, conditions: options.conditions, headers: options.blobHTTPHeaders, signal: options.abortSignal });
                if (writeError) throw writeError;
                const previous = blobs.get(path);
                if (options.conditions.ifNoneMatch === '*' && previous || options.conditions.ifMatch && options.conditions.ifMatch !== previous?.etag) throw error(412, 'ConditionNotMet');
                blobs.set(path, { body: Buffer.from(body), etag: '"' + crypto.randomUUID() + '"' });
                if (loseWrite) { loseWrite = false; throw error(503, 'ServerBusy'); }
            }
        };
    } };
    let fact = null;
    const store = new AzureStarterAccountStore(container);
    const options = { store, readActivation: async () => fact, captureOwner: async () => ({ subjectKey: SUBJECT, email: 'synthetic@gmail.com' }), now: () => AT + 1000 };
    const allocator = createStarterAccountAllocator(options);
    const proof = { schemaVersion: 1, requestId: crypto.randomUUID(), accountType: 'consultant', organisationName: 'Unrelated workspace',
        email: 'synthetic@gmail.com', status: 'verified', codeHash: null, attempts: 1, createdAt: AT,
        codeExpiresAt: AT + 600000, expiresAt: AT + 86400000, verifiedAt: AT + 1000 };
    return { blobs, calls, container, store, allocator, options, proof, error,
        setLoadError: e => { loadError = e; }, setWriteError: e => { writeError = e; }, loseWrite: () => { loseWrite = true; },
        async active() {
            const account = await allocator.reserveInitial(proof);
            fact = { email: proof.email, subjectKey: SUBJECT, accountId: account.accountId,
                organisationId: account.organisations[0].organisationId, receiptId: crypto.randomUUID(), activatedAt: new Date(AT + 1000).toISOString() };
            return allocator.activate({});
        }
    };
}
test('Azure conditional writes retain the account, activation and three-client cap across fresh service instances', async () => {
    const h = fixture(); h.loseWrite(); const active = await h.active();
    const workers = Array.from({ length: 6 }, () => createStarterAccountAllocator({ ...h.options, store: new AzureStarterAccountStore(h.container) }));
    const results = await Promise.allSettled(workers.map((w, i) => w.reserveClient({}, { requestId: crypto.randomUUID(), organisationName: `Client ${i}` })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'starter_client_limit'));
    const retained = await new AzureStarterAccountStore(h.container).load(starterAccountKey(h.proof.email));
    assert.equal(retained.record.accountId, active.accountId); assert.equal(retained.record.organisations.length, 4);
    assert.deepEqual(retained.record.activation, active.activation);
    assert.ok(h.calls.every(c => c.path.startsWith('customer-starter/starter-accounts/')));
    assert.ok(h.calls.every(c => !c.path.includes(h.proof.email)));
    assert.ok(h.calls.filter(c => c.op === 'read').every(c => c.offset === 0 && c.count === 32769));
    assert.ok(h.calls.filter(c => c.op === 'write').every(c => c.headers.blobCacheControl === 'no-store'));
    assert.equal(typeof h.store.delete, 'undefined');
});
test('storage rejects account rewrites, slot refunds and new client slots before activation', async () => {
    const h = fixture(), pending = await h.allocator.reserveInitial(h.proof), key = starterAccountKey(h.proof.email);
    const stored = await h.store.load(key);
    await assert.rejects(h.store.replace(key, stored.version, { ...pending, createdAt: new Date(AT).toISOString() }), /starter_store_transition_invalid/);
    await assert.rejects(h.store.replace(key, stored.version, { ...pending, email: 'different@gmail.com' }), /starter_store_key_invalid/);
    await h.active(); await h.allocator.reserveClient({}, { requestId: crypto.randomUUID(), organisationName: 'Retained client' });
    const active = await h.store.load(key);
    await assert.rejects(h.store.replace(key, active.version, { ...active.record, organisations: active.record.organisations.slice(0, 1) }), /starter_store_transition_invalid/);
    await assert.rejects(h.store.replace(key, active.version, { ...active.record,
        activation: { ...active.record.activation, receiptId: crypto.randomUUID() } }), /starter_store_transition_invalid/);
    assert.equal((await h.store.load(key)).record.organisations.length, 2);
});
test('conditional conflicts return false while ambiguous failures remain reconcilable by the allocator', async () => {
    const h = fixture(), account = await h.allocator.reserveInitial(h.proof), key = starterAccountKey(h.proof.email);
    assert.equal(await h.store.create(key, account), false);
    assert.equal(await h.store.replace(key, '"stale-etag"', account), false);
    h.setWriteError(h.error(409, 'LeaseAlreadyPresent'));
    const current = await h.store.load(key);
    await assert.rejects(h.store.replace(key, current.version, account), /starter_store_unavailable/);
    h.setWriteError(null); await h.active(); h.loseWrite();
    const command = { requestId: crypto.randomUUID(), organisationName: 'Lost response' };
    const client = await h.allocator.reserveClient({}, command);
    assert.deepEqual(await h.allocator.reserveClient({}, command), client);
});
test('wrong keys and invalid ETags do not reach storage', async () => {
    const h = fixture(), account = await h.allocator.reserveInitial(h.proof); h.calls.length = 0;
    for (const key of ['customer-subjects/x', '../starter-accounts/x', 'starter-accounts/' + 'A'.repeat(64)]) await assert.rejects(h.store.load(key), /starter_store_key_invalid/);
    await assert.rejects(h.store.create(starterAccountKey('different@gmail.com'), account), /starter_store_key_invalid/);
    await assert.rejects(h.store.replace(starterAccountKey(h.proof.email), '*', account), /starter_store_version_invalid/);
    assert.equal(h.calls.length, 0);
});
test('missing container, unreadable content, oversized blobs and corrupt plans fail closed', async () => {
    const h = fixture(), key = starterAccountKey(h.proof.email);
    assert.equal(await h.store.load(key), null);
    h.setLoadError(h.error(404, 'ContainerNotFound')); await assert.rejects(h.store.load(key), /starter_store_unavailable/);
    h.setLoadError(null); await h.allocator.reserveInitial(h.proof);
    const path = [...h.blobs.keys()][0], valid = h.blobs.get(path);
    for (const body of [Buffer.alloc(32769, 32), Buffer.from([0xc3, 0x28]), Buffer.from('{"schemaVersion":1}')]) {
        h.blobs.set(path, { ...valid, body }); await assert.rejects(h.store.load(key), /starter_store_unavailable/);
    }
    h.blobs.set(path, { ...valid, etag: '*' }); await assert.rejects(h.store.load(key), /starter_store_unavailable/);
});

function retainedClient(h,account,label){
    const slot=Object.fromEntries(Object.keys(account.organisations[0]).map(k=>[k,k==='kind'?'client':k==='organisationName'?label:crypto.randomUUID()]));
    const path='customer-starter/starter-clients/'+account.accountId+'/'+slot.requestId+'.json';
    h.blobs.set(path,{body:Buffer.from(JSON.stringify({schemaVersion:1,accountId:account.accountId,slot})),etag:'"retained"'});
    const alias='customer-starter/starter-client-bindings/'+account.accountId+'/'+slot.bindingId+'.json';
    h.blobs.set(alias,{body:Buffer.from(JSON.stringify({schemaVersion:1,accountId:account.accountId,bindingId:slot.bindingId,requestId:slot.requestId})),etag:'"retained"'});
    return{slot,path,alias};
}
test('reader floor exposes finite retained sidecar and exact alias reads without a new-format write port',async()=>{
    const h=fixture(),account=await h.active(),rows=Array.from({length:107},(_,i)=>retainedClient(h,account,'Saved '+i));
    const before=JSON.stringify([...h.blobs]),store=new AzureStarterAccountStore(h.container);h.calls.length=0;
    const seen=[],sizes=[];let cursor=null;
    do{const page=await store.listClients(account.accountId,{cursor,limit:50});seen.push(...page.clients);sizes.push(page.clients.length);cursor=page.nextCursor;}while(cursor!==null);
    assert.deepEqual(sizes,[50,50,7]);assert.equal(new Set(seen.map(slot=>slot.requestId)).size,107);
    assert.equal(h.calls.filter(call=>call.op==='list').length,3);
    assert.ok(h.calls.filter(call=>call.op==='page').every(call=>call.limit===50));
    h.calls.length=0;assert.deepEqual(await store.loadClientByBinding(account.accountId,rows[70].slot.bindingId),rows[70].slot);
    assert.deepEqual(h.calls.map(call=>call.op),['read','read']);assert.equal(h.calls[0].count,1025);assert.equal(h.calls[1].count,8193);
    assert.equal(await store.loadClientByBinding(account.accountId,crypto.randomUUID()),null);
    assert.equal(JSON.stringify([...h.blobs]),before);assert.equal(typeof store.createClient,'undefined');assert.equal(typeof store.ensureClientBinding,'undefined');
});
test('retained aliases and sidecar pages reject foreign, corrupt or oversized data without writes',async()=>{
    const h=fixture(),account=await h.active(),first=retainedClient(h,account,'First'),second=retainedClient(h,account,'Second');
    const original=h.blobs.get(first.alias),foreign=crypto.randomUUID();
    h.blobs.set('customer-starter/starter-client-bindings/'+foreign+'/'+first.slot.bindingId+'.json',original);
    await assert.rejects(h.store.loadClientByBinding(foreign,first.slot.bindingId),/starter_store_unavailable/);
    for(const change of [{bindingId:second.slot.bindingId},{requestId:second.slot.requestId},{requestId:crypto.randomUUID()}]){
        h.blobs.set(first.alias,{...original,body:Buffer.from(JSON.stringify({...JSON.parse(original.body),...change}))});
        await assert.rejects(h.store.loadClientByBinding(account.accountId,first.slot.bindingId));
    }
    for(const body of [Buffer.alloc(1025,32),Buffer.from([0xc3,0x28]),Buffer.from('{}')]){
        h.blobs.set(first.alias,{...original,body});await assert.rejects(h.store.loadClientByBinding(account.accountId,first.slot.bindingId));
    }
    h.blobs.set(first.alias,original);
    const page=await h.store.listClients(account.accountId,{cursor:null,limit:1});
    await assert.rejects(h.store.listClients(foreign,{cursor:page.nextCursor,limit:1}),/starter_store_cursor_invalid/);
    const secondBlob=h.blobs.get(second.path);h.blobs.set(second.path,h.blobs.get(first.path));
    await assert.rejects(h.store.loadClient(account.accountId,second.slot.requestId),/starter_store_unavailable/);h.blobs.set(second.path,secondBlob);
    for(const items of [[{name:'../foreign.json'}],Array.from({length:51},()=>({name:'x'}))]){
        const store=new AzureStarterAccountStore({...h.container,listBlobsFlat(){return{byPage(){return(async function*(){yield{segment:{blobItems:items}}})();}};}});
        h.calls.length=0;await assert.rejects(store.listClients(account.accountId,{cursor:null,limit:50}),/starter_store_unavailable/);
        assert.equal(h.calls.filter(call=>['write','read'].includes(call.op)).length,0);
    }
});
