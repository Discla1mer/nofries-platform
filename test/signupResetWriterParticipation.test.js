'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = global.test || require('node:test');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
const { createSignupWriterFence, observeContainer, observePool, wrapSignupWriters, KEY, CONTRACT } = require('../api/shared/customerSignup/signupWriterFence');
const { signupWriterFence } = require('../lib/signupWriterFenceProduction');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
const { createStarterAccountAllocator, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails, starterSetupKey } = require('../api/shared/customerSignup/starterSetupDetails');
const { createExternalStarterClaim } = require('../api/shared/customerSignup/externalStarterClaim');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const scopeId = 'a'.repeat(64), operationId = randomUUID(), planSha256 = 'b'.repeat(64);
const marker = { operationId, planSha256 };
const env = { AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'external-starter',
    NOFRIES_SIGNUP_RESET_WRITER_CONTRACT: CONTRACT };
const settle = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness() {
    const h = versionedBlobs(), fence = createSignupWriterFence({ container: h.container, scopeId });
    return { ...h, fence, guarded: observeContainer(h.container, fence) };
}
async function accountFixture(h) {
    const at = Date.parse('2026-10-20T00:00:00.000Z'), subjectKey = randomUUID() + ':' + randomUUID();
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: randomUUID(), subjectKey,
        providerKey: 'c'.repeat(64), authenticationSha256: 'd'.repeat(64), email: 'synthetic@example.test',
        organisationName: 'Synthetic Organisation', accountType: 'company', createdAt: at, verifiedAt: at, expiresAt: at + 3600000 };
    const store = new AzureStarterAccountStore(h.guarded);
    const accounts = createStarterAccountAllocator({ store, now: () => at, readActivation: async () => null, captureOwner: async () => null });
    const setup = createStarterSetupDetails({ accounts, now: () => at,
        framework: async () => ({ moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' }),
        store: new AzureStarterSetupStore(h.guarded) });
    const details = { name: 'Synthetic Owner', role: 'Owner', address: 'Synthetic address', registrationId: null, authorityConfirmed: true };
    const invitations = new Map();
    const claim = createExternalStarterClaim({ container: h.guarded, providerKey: proof.providerKey, identityPolicyId: 'synthetic-policy',
        now: () => at, readOtherAuthority: async () => null,
        invitations: { read: async k => invitations.get(k) || null, create: async r => invitations.set(r.tokenDigest, r) } });
    return { store, accounts, setup, details, proof, async claim() {
        const account = await accounts.readInitial(proof), saved = await setup.read(proof);
        return claim({ account, details: saved, subjectKey, beforeMutation: async () => {} });
    } };
}
test('real account create/replace and organisation setup writers refuse a held reset and work after completion', async () => {
    const h = harness(), f = await accountFixture(h), entered = settle(), done = settle();
    const resetting = h.fence.withReset(marker, async fence => { entered.resolve(); await done.promise; await fence.complete(); });
    await entered.promise;
    await assert.rejects(f.accounts.reserveInitial(f.proof));
    await assert.rejects(f.setup.save(f.proof, f.details));
    assert.equal([...h.current.keys()].filter(k => k !== KEY).length, 0);
    done.resolve(); await resetting;
    const account = await f.accounts.reserveInitial(f.proof), saved = await f.store.load(starterAccountKey(f.proof.email));
    assert.equal(await f.store.replace(starterAccountKey(f.proof.email), saved.version, account), true);
    const setupStore = new AzureStarterSetupStore(h.guarded);
    await f.setup.save(f.proof, f.details);
    const setupKey = starterSetupKey(account.organisations[0].organisationId), details = await setupStore.load(setupKey);
    await h.container.getBlockBlobClient('customer-starter/' + setupKey + '.json').delete();
    await h.fence.withReset(marker, async fence => {
        await assert.rejects(setupStore.create(setupKey, details));
        assert.equal(h.current.has('customer-starter/' + setupKey + '.json'), false);
        const before = h.current.get('customer-starter/' + starterAccountKey(f.proof.email) + '.json');
        await assert.rejects(f.store.replace(starterAccountKey(f.proof.email), before.etag, account));
        assert.equal(h.current.get('customer-starter/' + starterAccountKey(f.proof.email) + '.json'), before);
        await fence.complete();
    });
    assert.equal(await setupStore.create(setupKey, details), true);
});
test('real External ID claim cannot recreate subject/context records after reset deletion', async () => {
    const h = harness(), f = await accountFixture(h);
    await f.setup.save(f.proof, f.details);
    const account = await f.accounts.readInitial(f.proof), entered = settle(), done = settle();
    const resetting = h.fence.withReset(marker, async fence => { entered.resolve(); await done.promise; await fence.complete(); });
    await entered.promise;
    await assert.rejects(f.claim(), /signup_writer_fence_unavailable/);
    assert.equal(h.current.has('customer-subjects/' + subjectHash(f.proof.subjectKey) + '.json'), false);
    assert.equal(h.current.has('customer-starter/contexts/' + account.organisations[0].organisationId + '.json'), false);
    done.resolve(); await resetting;
    await h.fence.withWriter(() => f.claim());
    assert.equal(h.current.has('customer-subjects/' + subjectHash(f.proof.subjectKey) + '.json'), true);
    assert.equal(h.current.has('customer-starter/contexts/' + account.organisations[0].organisationId + '.json'), true);
});
test('absent account pointer cannot be recreated by a separate worker while common reset fence is retained', async () => {
    const h = harness(), f = await accountFixture(h);
    await f.accounts.reserveInitial(f.proof);
    const key = 'customer-starter/' + starterAccountKey(f.proof.email) + '.json';
    await h.fence.withReset(marker, async () => { await h.container.getBlockBlobClient(key).delete(); });
    const other = createSignupWriterFence({ container: h.container, scopeId });
    await assert.rejects(other.withWriter(() => f.accounts.reserveInitial(f.proof)), /signup_writer_fence_unavailable/);
    assert.equal(h.current.has(key), false);
});
test('breaking a reset lease leaves its durable marker blocking every new writer and the old reset', async () => {
    const h = harness(); let stale;
    await h.fence.withReset(marker, async fence => { stale = fence; h.leases.delete(KEY); });
    const other = createSignupWriterFence({ container: h.container, scopeId });
    let dispatched = false;
    await assert.rejects(other.withWriter(() => { dispatched = true; }), /signup_writer_fence_unavailable/);
    await assert.rejects(stale.complete(), /signup_writer_fence_unavailable/);
    assert.equal(dispatched, false); assert.deepEqual(await h.fence.readReset(), marker);
    assert.equal(typeof other.breakLease, 'undefined');
});
test('a deliberate break between app writes refuses the next Blob write and SQL commit', async () => {
    for (const sql of [false, true]) {
        const h = harness(), queries = [];
        const pool = observePool({ end() {}, async connect() { return { release() {}, async query(q) { queries.push(q); return { rows: [] }; } }; } });
        await assert.rejects(h.fence.withWriter(async () => {
            await h.guarded.getBlockBlobClient('customer-starter/contexts/synthetic.json').uploadData(Buffer.from('{}'));
            h.leases.delete(KEY); // Simulated explicit operator break; never a production API.
            if (sql) await (await pool.connect()).query('COMMIT');
            else await h.guarded.getBlockBlobClient('customer-subjects/synthetic.json').uploadData(Buffer.from('{}'));
        }), /signup_writer_fence_unavailable/);
        assert.equal(h.current.has('customer-subjects/synthetic.json'), false); assert.deepEqual(queries, []);
    }
});
test('break during a dispatched write is uncertain; no later write and no successor lease release', async () => {
    const h = harness(), original = h.container.getBlockBlobClient;
    const wrapped = observeContainer({ getBlockBlobClient(key) { const blob = original(key); return { ...blob, async uploadData(...args) {
        const value = await blob.uploadData(...args); h.leases.set(KEY, 'successor'); return value;
    } }; } }, h.fence);
    await assert.rejects(h.fence.withWriter(async () => {
        await wrapped.getBlockBlobClient('customer-subjects/synthetic.json').uploadData(Buffer.from('{}'));
        throw new Error('must not continue');
    }), /signup_writer_fence_unavailable/);
    assert.equal(h.leases.get(KEY), 'successor');
    assert.equal(h.current.has('customer-subjects/synthetic.json'), true); // acknowledgement cannot undo the dispatched effect
});
test('shared organisation SQL entrypoint blocks INSERT/UPDATE/DELETE/COMMIT and succeeds with no reset', async () => {
    const h = harness(), queries = [];
    const pool = observePool({ end() {}, async connect() { return { release() {}, async query(sql) { queries.push(sql); return { rows: [] }; } }; } });
    const writers = wrapSignupWriters({ async prepareOrganisation() { const c = await pool.connect();
        for (const sql of ['INSERT INTO nofries.dashboard_organisations VALUES ($1)', 'UPDATE nofries.dashboard_starter_accounts SET activation=$1',
            'DELETE FROM nofries.dashboard_starter_scopes WHERE subject_key=$1', 'COMMIT']) await c.query(sql, ['synthetic']);
    } }, h.fence);
    await h.fence.withReset(marker, async fence => {
        await assert.rejects(writers.prepareOrganisation()); assert.deepEqual(queries, []); await fence.complete();
    });
    await writers.prepareOrganisation(); assert.equal(queries.length, 4); assert.equal(queries[3], 'COMMIT');
});
test('production selector is off by default, rejects unknown contract and safely unwraps decorated containers', async () => {
    const h = harness(); assert.equal(signupWriterFence({}, h.container, true), null);
    assert.equal(signupWriterFence(env, h.container, false), null);
    assert.throws(() => signupWriterFence({ ...env, NOFRIES_SIGNUP_RESET_WRITER_CONTRACT: 'unknown' }, h.container, true));
    const source = signupWriterFence(env, h.container, true);
    const nested = signupWriterFence(env, observeContainer(h.container, source), true);
    await source.withWriter(() => nested.withWriter(() => Promise.resolve()));
    const record = JSON.parse(h.current.get(KEY).bytes);
    assert.equal(record.scopeId, hash({ account: env.AZURE_STORAGE_ACCOUNT_NAME, container: env.NOFRIES_STARTER_AUTHORITY_CONTAINER, writerContract: CONTRACT }));
});
test('real starter composition keeps the client factory synchronous and performs no I/O until invocation', async () => {
    const { createStarterSignupProduction } = require('../lib/starterSignupProduction');
    const h = versionedBlobs(), tenant = randomUUID(), client = randomUUID(); let reads = 0;
    const noIO = async () => { throw new Error('unexpected construction I/O'); };
    const policy = { policyId: 'synthetic', policyRevision: 1, issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, identityTenantId: tenant, audience: client };
    const selected = { ...env, NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ENTRA_CLIENT_ID: client,
        NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-test-only-not-a-credential' };
    const pool = { connect: noIO, end: noIO }, database = { withTenantTransaction: noIO };
    const dashboard = { identityPolicy: policy, clock: () => '2026-10-20T00:00:00.000Z', pool, instanceId: randomUUID(),
        readExternalRuntimeEpoch: noIO, newRequestId: randomUUID, newId: randomUUID, newGenerationToken: () => 'a'.repeat(64),
        requestBudgetMs: 10000, historyBudget: { maxRecords: 100, maxBytes: 65536, maxDurationMs: 10000 },
        proofStore: { createOriginalProof: noIO, readOriginalProof: noIO }, browserAuthOptions: { env: selected,
            store: Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction', 'createSession', 'loadSession', 'deleteSession'].map(k => [k, noIO])) } };
    const starter = createStarterSignupProduction({ env: selected, dashboard, database, policy: { begin: noIO, verify: noIO, recheck: noIO }, container: h.container,
        legacyRecords: {}, starterRecords: {}, graph: null, invitations: { read: noIO, compareAndSet: noIO, transact: noIO },
        readCustomer: async () => { reads++; return null; }, external: { identityPolicy: policy } });
    const clients = starter.clientOperations({ verifyIdentity: noIO });
    assert.equal(typeof clients.then, 'undefined'); assert.equal(typeof clients.list, 'function'); assert.equal(typeof clients.execute, 'function');
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(h.calls, []);
    const fence = signupWriterFence(selected, h.container, true);
    await fence.withReset(marker, async current => {
        await assert.rejects(clients.list({ headers: {} }, {}), /signup_writer_fence_unavailable/);
        await assert.rejects(clients.execute({ headers: {} }, {}), /signup_writer_fence_unavailable/);
        assert.equal(reads, 0); await current.complete();
    });
    await assert.rejects(clients.list({ headers: {} }, {}), /starter_signup_unavailable/);
    assert.equal(reads, 1);
});
