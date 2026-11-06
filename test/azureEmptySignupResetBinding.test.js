'use strict';

// Exercises the Azure binding with the genuine reset coordinator against an
// in-memory container that follows Blob lease, ETag and version rules.
// Synthetic data only. No reset runs against real storage.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createEmptySignupReset } = require('../api/shared/customerSignup/emptySignupReset');
const { createAzureEmptySignupResetBinding, FENCE_PREFIX } = require('../api/shared/customerSignup/azureEmptySignupResetBinding');
const { starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan } = require('../api/shared/customerSignup/customerStarterPlan');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');

const uid = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const CUSTOMER = uid(1) + ':' + uid(2), STAFF = uid(3) + ':' + uid(4);
const EMAIL = 'synthetic-fence@example.test';
const AT = Date.parse('2026-11-01T01:00:00.000Z');
const sha = value => createHash('sha256').update(value).digest('hex');
const KEYS = { account: 'customer-starter/' + starterAccountKey(EMAIL) + '.json', authority: 'customer-subjects/' + subjectHash(CUSTOMER) + '.json' };
const storageError = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });

// Follows the Blob rules the binding depends on: leased blobs refuse writes and
// deletes without the lease ID, If-Match/If-None-Match are enforced, every
// write creates a readable version, and versions survive deletion.
function azureContainer() {
    const current = new Map(), versions = new Map(); let serial = 0;
    const store = (key, bytes) => {
        const versionId = 'v' + (++serial), etag = '"e' + serial + '"';
        versions.set(key + '@' + versionId, Buffer.from(bytes));
        current.set(key, { bytes: Buffer.from(bytes), etag, versionId, leaseId: current.get(key)?.leaseId || null });
        return { etag, versionId };
    };
    const checkWrite = (key, conditions = {}) => {
        const found = current.get(key);
        if (found?.leaseId && conditions.leaseId !== found.leaseId) throw storageError(412, 'LeaseIdMissing');
        if (conditions.ifNoneMatch === '*' && found) throw storageError(409, 'BlobAlreadyExists');
        if (conditions.ifMatch && found?.etag !== conditions.ifMatch) throw storageError(412, 'ConditionNotMet');
    };
    const download = bytesOf => async () => {
        const found = bytesOf(); if (!found) throw storageError(404, 'BlobNotFound');
        return { etag: found.etag, readableStreamBody: Readable.from([Buffer.from(found.bytes)]) };
    };
    return { current, versions, store, getBlockBlobClient(key) {
        return {
            download: download(() => current.get(key)),
            withVersion: id => ({ download: download(() => versions.has(key + '@' + id) && { bytes: versions.get(key + '@' + id), etag: '"version"' }) }),
            async uploadData(bytes, { conditions } = {}) { checkWrite(key, conditions); return store(key, bytes); },
            async delete({ conditions } = {}) {
                if (!current.has(key)) throw storageError(404, 'BlobNotFound');
                checkWrite(key, conditions); current.delete(key);
            },
            getBlobLeaseClient(leaseId) { return {
                async acquireLease(duration) {
                    const found = current.get(key); if (!found) throw storageError(404, 'BlobNotFound');
                    if (duration !== -1) throw new Error('only infinite leases are expected');
                    if (found.leaseId && found.leaseId !== leaseId) throw storageError(409, 'LeaseAlreadyPresent');
                    found.leaseId = leaseId;
                },
                async renewLease() {
                    const found = current.get(key); if (!found) throw storageError(404, 'BlobNotFound');
                    if (found.leaseId !== leaseId) throw storageError(409, 'LeaseIdMismatchWithLeaseOperation');
                },
                async releaseLease() {
                    const found = current.get(key); if (!found) throw storageError(404, 'BlobNotFound');
                    if (found.leaseId !== leaseId) throw storageError(409, 'LeaseIdMismatchWithLeaseOperation');
                    found.leaseId = null;
                }
            }; }
        };
    } };
}

function fixture() {
    const plan = approvedStarterPlan();
    const slot = { requestId: uid(11), kind: 'own', organisationName: 'Synthetic fence company',
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
    const starter = azureContainer(), subjects = azureContainer(), records = { account, authority: entry };
    const containers = { account: starter, authority: subjects }, original = {};
    for (const name of ['account', 'authority']) {
        const bytes = Buffer.from(JSON.stringify(records[name]));
        original[name] = { bytes, ...containers[name].store(KEYS[name], bytes), record: records[name] };
    }
    const request = { schemaVersion: 1, operationId: uid(70), sourceSha: 'e'.repeat(40), email: EMAIL,
        customerSubjectKey: CUSTOMER, staffSubjectKey: STAFF, providerKey: 'f'.repeat(64), createdAt: AT, expiresAt: AT + 600000 };
    const target = () => ({ keys: { ...KEYS }, containerSha256: '1'.repeat(64), dependencyDigest: '2'.repeat(64),
        ...Object.fromEntries(['account', 'authority'].map(name => [name, { record: JSON.parse(JSON.stringify(original[name].record)),
            etag: original[name].etag, versionId: original[name].versionId, sha256: sha(original[name].bytes) }])) });
    const bindingFor = () => createAzureEmptySignupResetBinding({ accountContainer: starter, authorityContainer: subjects, now: () => AT });
    const coordinator = binding => createEmptySignupReset({ ...binding, now: () => AT,
        inspect: async () => ({ status: 'ready', target: target() }), inspectRecovery: async () => ({ status: 'ready', target: target() }) });
    const fenceKeys = () => [...starter.current.keys()].filter(key => key.startsWith(FENCE_PREFIX));
    const leases = () => ['account', 'authority'].map(name => containers[name].current.get(KEYS[name])?.leaseId || null);
    // An application writer: conditional update with the current ETag and no lease ID.
    const appWrite = async name => {
        const blob = containers[name].getBlockBlobClient(KEYS[name]), found = containers[name].current.get(KEYS[name]);
        return blob.uploadData(Buffer.from(JSON.stringify(original[name].record)), { conditions: { ifMatch: found.etag } });
    };
    return { request, starter, subjects, containers, original, bindingFor, coordinator, fenceKeys, leases, appWrite };
}

test('a reset through the real coordinator removes both records and leaves no fence or lease', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor());
    const { plan } = await reset.inventory(f.request);
    expect(await reset.reset(f.request, plan)).toEqual({ status: 'reset', code: 'active_pointers_absent', phase: 'complete' });
    expect(f.starter.current.has(KEYS.account)).toBe(false);
    expect(f.subjects.current.has(KEYS.authority)).toBe(false);
    expect(f.fenceKeys()).toEqual([]);
});

test('while the fence is held, application writers are refused; after completion they succeed', async () => {
    const f = fixture(), binding = f.bindingFor();
    await binding.withExclusiveTarget({ request: f.request, plan: { records: { account: { key: KEYS.account }, authority: { key: KEYS.authority } } } },
        async fence => {
            await fence.assertCurrent();
            expect(f.fenceKeys()).toHaveLength(1);
            for (const name of ['account', 'authority']) await expect(f.appWrite(name)).rejects.toMatchObject({ statusCode: 412 });
            await fence.complete();
        });
    expect(f.leases()).toEqual([null, null]);
    for (const name of ['account', 'authority']) await expect(f.appWrite(name)).resolves.toBeDefined();
});

test('a failure after deleting the account retains the fence across process loss and rollback restores it', async () => {
    const f = fixture(), first = f.bindingFor(), reset = f.coordinator(first);
    const { plan } = await reset.inventory(f.request);
    const subjects = f.subjects.getBlockBlobClient;
    f.subjects.getBlockBlobClient = key => {
        const blob = subjects.call(f.subjects, key);
        return { ...blob, delete: async () => { throw storageError(500, 'ServerBusy'); } };
    };
    expect(await reset.reset(f.request, plan)).toMatchObject({ status: 'pending' });
    f.subjects.getBlockBlobClient = subjects;
    // The account is gone, the authority is still leased and the fence remains.
    expect(f.starter.current.has(KEYS.account)).toBe(false);
    expect(f.fenceKeys()).toHaveLength(1);
    expect(JSON.parse(f.starter.current.get(f.fenceKeys()[0]).bytes)).toMatchObject({ state: 'retained', operationId: f.request.operationId });
    await expect(f.appWrite('authority')).rejects.toMatchObject({ statusCode: 412 });

    // A different operation cannot take the target.
    const other = f.coordinator(f.bindingFor()), otherRequest = { ...f.request, operationId: uid(71) };
    const otherPlan = (await other.inventory(otherRequest)).plan;
    expect((await other.reset(otherRequest, otherPlan)).status).toBe('blocked');

    // A new process resumes the same operation and rolls back.
    const recovered = await f.coordinator(f.bindingFor()).rollback(f.request, plan);
    expect(recovered).toEqual({ status: 'recovered', code: 'originals_restored', phase: 'complete' });
    for (const name of ['account', 'authority']) {
        expect(f.containers[name].current.get(KEYS[name]).bytes.equals(f.original[name].bytes)).toBe(true);
    }
    expect(f.fenceKeys()).toEqual([]);
    expect(f.leases()).toEqual([null, null]);
});

test('a second holder of the same operation invalidates the first holder', async () => {
    const f = fixture(), target = { records: { account: { key: KEYS.account }, authority: { key: KEYS.authority } } };
    const first = f.bindingFor(), second = f.bindingFor();
    await first.withExclusiveTarget({ request: f.request, plan: target }, async fenceA => {
        await fenceA.assertCurrent();
        await expect(first.withExclusiveTarget({ request: f.request, plan: target }, async () => {})).rejects.toThrow('fence_busy');
        await second.withExclusiveTarget({ request: f.request, plan: target }, async fenceB => {
            await expect(fenceA.assertCurrent()).rejects.toThrow('fence_lost');
            await fenceB.assertCurrent();
            await fenceB.complete();
        });
    });
    expect(f.fenceKeys()).toEqual([]);
});

test('an untouched blocked run releases the fence and leases', async () => {
    const f = fixture(), reset = f.coordinator(f.bindingFor()), { plan } = await reset.inventory(f.request);
    // Change the authority so the coordinator refuses before any mutation.
    await f.appWrite('authority');
    expect(await reset.reset(f.request, plan)).toMatchObject({ status: 'blocked', code: 'record_changed' });
    expect(f.fenceKeys()).toEqual([]);
    expect(f.leases()).toEqual([null, null]);
    expect(f.starter.current.has(KEYS.account)).toBe(true);
});

test('the blobs port refuses keys outside the target and writes outside a held fence', async () => {
    const f = fixture(), { blobs } = f.bindingFor();
    for (const key of ['dashboard-proofs/x.json', FENCE_PREFIX + 'x.json', 'customer-starter/../x.json']) {
        await expect(blobs.readCurrent(key)).rejects.toThrow('key_outside_target');
    }
    await expect(blobs.remove(KEYS.account, { conditions: { ifMatch: f.original.account.etag } })).rejects.toThrow('fence_required');
    await expect(blobs.restore(KEYS.account, Buffer.from('x'), { conditions: { ifNoneMatch: '*' } })).rejects.toThrow('fence_required');
    expect(f.starter.current.has(KEYS.account)).toBe(true);
});

test('only the gated reset adapter imports the binding', () => {
    const root = path.join(__dirname, '..'), found = [];
    const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') visit(file);
        else if (entry.isFile() && /\.js$/.test(entry.name) && !file.endsWith('azureEmptySignupResetBinding.js') &&
            fs.readFileSync(file, 'utf8').includes('azureEmptySignupResetBinding')) found.push(path.relative(root, file));
    } };
    for (const dir of ['api', 'lib', 'scripts', 'connector-functions']) visit(path.join(root, dir));
    for (const file of ['server.js', 'app-service.js', 'connector-server.js']) {
        if (fs.readFileSync(path.join(root, file), 'utf8').includes('azureEmptySignupResetBinding')) found.push(file);
    }
    expect(found).toEqual(['api/shared/dashboardAdmin/emptySignupResetAdapter.js']);
});
