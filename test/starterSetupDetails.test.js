'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = global.test || require('node:test');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails, starterSetupRecord } = require('../api/shared/customerSignup/starterSetupDetails');
const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
const { compileStarterSchedule, CONSULTANT_ORGANISATION_POLICY } = require('../api/shared/customerSignup/customerStarterPlan');
const { createOrganisationSetup, COOKIE } = require('../api/shared/organisationSetup');
const clone = value => JSON.parse(JSON.stringify(value));
const START = Date.parse('2026-09-29T06:30:00.000Z');
const DATA = { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true };
function fixture(type = 'company') {
    let now = START + 1000, lose = false, duringLoad = null, errorOnRead = null;
    const blobs = new Map(), accountRows = new Map(); let writes = 0;
    const accounts = createStarterAccountAllocator({ now: () => now,
        captureOwner: async () => { throw new Error('unused'); }, readActivation: async () => { throw new Error('unused'); },
        store: { async load(key) { return accountRows.has(key) ? clone(accountRows.get(key)) : null; },
            async create(key, record) { if (accountRows.has(key)) return false; accountRows.set(key, { record: clone(record), version: '1' }); return true; },
            async replace() { throw new Error('unused'); } } });
    const container = { getBlockBlobClient(key) { return {
        async download() {
            if (duringLoad) { const f = duringLoad; duringLoad = null; f(); }
            if (errorOnRead) throw errorOnRead;
            const body = blobs.get(key);
            if (!body) throw Object.assign(new Error(), { statusCode: 404, code: 'BlobNotFound' });
            return { contentLength: body.length, readableStreamBody: Readable.from([body]) };
        },
        async uploadData(body, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' });
            if (blobs.has(key)) throw Object.assign(new Error(), { statusCode: 412, code: 'ConditionNotMet' });
            blobs.set(key, Buffer.from(body)); writes++;
            if (lose) { lose = false; throw new Error('Lost acknowledgement'); }
        }
    }; } };
    const store = new AzureStarterSetupStore(container);
    const options = { accounts, store, now: () => now, framework: async () => ({ moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: '1.0' }) };
    const service = createStarterSetupDetails(options);
    const proof = { schemaVersion: 1, requestId: crypto.randomUUID(), organisationName: 'Unrelated Test Name', email: 'synthetic@gmail.com',
        accountType: type, status: 'verified', codeHash: null, attempts: 0, createdAt: START, codeExpiresAt: START + 600000,
        expiresAt: START + 86400000, verifiedAt: START + 1000 };
    return { service, options, proof, blobs, accountRows, store, writes: () => writes, now: () => now,
        setTime: value => { now = value; }, lose: () => { lose = true; }, duringLoad: f => { duringLoad = f; },
        readError: e => { errorOnRead = e; } };
}
test('verified personal email and explicit details produce an immutable scoped offer without access or a trial clock', async () => {
    const f = fixture('consultant'); assert.equal(await f.service.read(f.proof), null); assert.equal(f.accountRows.size, 0);
    const saved = await f.service.save(f.proof, DATA);
    assert.equal(saved.offerInput.accountType, 'consultant'); assert.equal(saved.offerInput.contact.email, 'synthetic@gmail.com');
    assert.equal(saved.offerInput.contact.authorityEvidenceId, saved.representativeEvidenceId);
    assert.equal(saved.assertion.setupRequestId, f.proof.requestId); assert.equal(saved.assertion.confirmed, true);
    assert.equal(saved.assertion.receivedAt, new Date(f.now()).toISOString());
    assert.match(saved.offer.schedule.scheduleText, /14 days from account activation/);
    assert.match(saved.offer.schedule.scheduleText, /up to 3 client organisations/);
    assert.equal([...f.accountRows.values()][0].record.activation, null);
    assert.equal(saved.membership, undefined); assert.equal(saved.acceptance, undefined);
    assert.deepEqual(await f.service.read(f.proof), saved);
    assert.ok([...f.blobs.keys()][0].startsWith('customer-starter/starter-setups/'));
});
test('false authority, browser-selected scope/plan/email and malformed details create no records', async () => {
    const f = fixture();
    for (const change of [{ authorityConfirmed: false }, { authorityConfirmed: 'true' }, { email: 'foreign@example.org' },
        { tenantId: crypto.randomUUID() }, { planId: 'unlimited' }, { name: '<script>' }, { address: '' }]) {
        await assert.rejects(f.service.save(f.proof, { ...DATA, ...change }));
    }
    assert.equal(f.accountRows.size, 0); assert.equal(f.writes(), 0);
    await assert.rejects(f.service.save({ ...f.proof, status: 'awaiting_code' }, DATA));
    f.setTime(f.proof.expiresAt); await assert.rejects(f.service.save(f.proof, DATA));
    assert.equal(f.writes(), 0);
});
test('new-policy own details are readable before any client and cannot enter the historical reservation writer', async () => {
    const f = fixture('consultant'), saved = clone(await f.service.save(f.proof, DATA));
    saved.offerInput.consultantOrganisationPolicy = CONSULTANT_ORGANISATION_POLICY;
    saved.offer = compileStarterSchedule(saved.offerInput);
    const key = [...f.blobs.keys()][0], bytes = Buffer.from(JSON.stringify(saved));
    f.blobs.set(key, bytes);
    let attempts = 0;
    const reader = createStarterSetupDetails({ ...f.options, accounts: { ...f.options.accounts,
        async reserveInitial() { attempts++; throw new Error('must_not_write'); } } });
    assert.deepEqual(await reader.read(f.proof), saved);
    await assert.rejects(reader.save(f.proof, DATA), /starter_details_read_only/);
    assert.equal(attempts, 0);
    assert.deepEqual(f.blobs.get(key), bytes);
    assert.equal([...f.accountRows.values()][0].record.organisations.length, 1);
});
for (const phase of ['load', 'create_conflict']) test('a new-policy declaration winning ' + phase + ' reconciliation never resumes a writer', async () => {
    const f = fixture('consultant'), saved = clone(await f.service.save(f.proof, DATA));
    saved.offerInput.consultantOrganisationPolicy = CONSULTANT_ORGANISATION_POLICY;
    saved.offer = compileStarterSchedule(saved.offerInput);
    const key = [...f.blobs.keys()][0];
    let loads = 0, creates = 0;
    const service = createStarterSetupDetails({ ...f.options, store: {
        async load() { loads++; return loads === 1 || phase === 'create_conflict' && loads === 2 ? null : clone(saved); },
        async create(_key, value) {
            creates++; assert.equal(value.offerInput.consultantOrganisationPolicy, undefined);
            f.blobs.set(key, Buffer.from(JSON.stringify(saved)));
            throw new Error('Synthetic concurrent writer/lost acknowledgement');
        }
    } });
    await assert.rejects(service.save(f.proof, DATA), /starter_details_read_only/);
    assert.equal(creates, phase === 'create_conflict' ? 1 : 0);
    assert.equal([...f.accountRows.values()][0].record.organisations.length, 1);
});
test('concurrent retries, process restart and lost responses retain one declaration and exact schedule', async () => {
    const f = fixture(); f.lose();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.service.save(f.proof, DATA)));
    assert.equal(f.writes(), 1); assert.equal(f.accountRows.size, 1);
    for (const result of results) assert.deepEqual(result, results[0]);
    const restarted = createStarterSetupDetails(f.options);
    assert.deepEqual(await restarted.save(f.proof, { ...DATA, name: '  Synthetic Representative  ' }), results[0]);
    await assert.rejects(restarted.save(f.proof, { ...DATA, role: 'Changed' }), /starter_details_locked/);
    assert.equal(f.writes(), 1);
});
test('fresh verification resumes the original declaration without altering its evidence or period', async () => {
    const f = fixture(), original = await f.service.save(f.proof, DATA), at = START + 2 * 86400000;
    f.setTime(at + 1000);
    const fresh = { ...f.proof, requestId: crypto.randomUUID(), createdAt: at, codeExpiresAt: at + 600000,
        expiresAt: at + 86400000, verifiedAt: at + 1000 };
    assert.deepEqual(await f.service.save(fresh, DATA), original);
    assert.deepEqual(await f.service.read(fresh), original);
    assert.equal(f.writes(), 1);
});
test('expiry during I/O denies continuation while retaining any already saved evidence', async () => {
    const f = fixture(), saved = await f.service.save(f.proof, DATA);
    f.duringLoad(() => f.setTime(f.proof.expiresAt));
    await assert.rejects(f.service.read(f.proof), /starter_proof_invalid/);
    assert.equal(f.blobs.size, 1); assert.equal(saved.assertion.confirmed, true);
});
test('corrupt declarations, foreign scopes and storage errors fail closed', async () => {
    const f = fixture(), saved = await f.service.save(f.proof, DATA);
    assert.throws(() => starterSetupRecord({ ...saved, assertion: { ...saved.assertion, confirmed: false } }));
    assert.throws(() => starterSetupRecord({ ...saved, offer: { ...saved.offer, representativeAuthorityEvidenceId: 'forged' } }));
    const key = [...f.blobs.keys()][0];
    f.blobs.set(key, Buffer.from(JSON.stringify({ ...saved, accountId: crypto.randomUUID() })));
    await assert.rejects(f.service.read(f.proof), /starter_details_changed/);
    f.readError({ statusCode: 404, code: 'ContainerNotFound' });
    await assert.rejects(f.service.read(f.proof), /starter_details_store_unavailable/);
});
test('HTTP details require the verified opaque session and same origin, and GET never submits a declaration', async () => {
    const f = fixture(); let saves = 0;
    const token = Buffer.alloc(32, 3).toString('base64url'), requestKey = 'requests/' + crypto.createHash('sha256').update(token).digest('hex');
    const records = new Map([[requestKey, { record: clone(f.proof), version: 'v1' }]]);
    const setup = createOrganisationSetup({ origin: 'https://nofries.nz', now: f.now, sendEmail: async () => { throw new Error('unused'); },
        store: { async load(k) { return records.get(k) || null; }, async create(k, r) { if(records.has(k))return false; records.set(k,{record:r,version:'v1'});return true; }, async replace() { throw new Error('unused'); } },
        starterSetup: { read: async record => await f.service.read(record) ? 'pending_activation' : 'details_required',
            save: async (record, input) => { saves++; return f.service.save(record, input); } } });
    const headers = { origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: COOKIE + '=' + token,
        'x-nofries-setup-request': f.proof.requestId };
    const request = { method: 'POST', path: '/api/organisation-setup/details', headers, body: DATA };
    assert.equal((await setup.handle({ ...request, headers: { ...headers, origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await setup.handle({ ...request, headers: { origin: headers.origin, 'content-type': 'application/json' } })).status, 401);
    const state = await setup.handle({ method: 'GET', path: '/api/organisation-setup/state', headers });
    assert.equal(state.body.nextStep, 'details_required'); assert.equal(saves, 0);
    for (const requestId of [undefined, crypto.randomUUID()]) {
        const changed = await setup.handle({ ...request, headers: { ...headers, 'x-nofries-setup-request': requestId } });
        assert.equal(changed.status, 409); assert.equal(changed.body.code, 'setup_changed'); assert.equal(saves, 0);
    }
    assert.equal((await setup.handle(request)).body.nextStep, 'pending_activation'); assert.equal(saves, 1);
    const record = records.get(requestKey).record;
    records.set(requestKey, { record: { ...record, status: 'awaiting_code' }, version: 'v2' });
    assert.equal((await setup.handle(request)).status, 403); assert.equal(saves, 1);
});
