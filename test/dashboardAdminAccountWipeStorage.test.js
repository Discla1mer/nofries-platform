'use strict';
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createAccountWipeStorage } = require('../api/shared/dashboardAdmin/accountWipeStorage');
const { starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan, accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { subjectHash, termsOfferKey } = require('../api/shared/customerSignup/customerAuthority');

const uid = n => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SLOT_IDS = ['tenantId', 'organisationId', 'grantId', 'scheduleId', 'activationId', 'bootstrapOperationId', 'acceptOperationId',
    'publicationOperationId', 'bindingId', 'authorityId', 'membershipId', 'admissionOperationId'];
const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const signal = () => new AbortController().signal;
const sha = value => createHash('sha256').update(value).digest('hex');

function account(n, email, type = 'consultant') {
    const plan = approvedStarterPlan(), subjectKey = uid(1) + ':' + uid(500 + n);
    const slot = { requestId: uid(100 * n + 1), kind: 'own', organisationName: 'Synthetic ' + n, ...Object.fromEntries(SLOT_IDS.map((k, i) => [k, uid(100 * n + 10 + i)])) };
    const at = new Date(NOW - 1000).toISOString();
    const record = starterAccountRecord({ schemaVersion: 1, accountId: uid(100 * n), planId: plan.planId, planSha256: plan.sha256, email, accountType: type,
        setupRequestId: slot.requestId, setupSha256: 'a'.repeat(64), createdAt: new Date(NOW - 5000).toISOString(),
        activation: { subjectKey, receiptId: uid(100 * n + 50), activatedAt: at, validUntil: accountWindow(at, plan.planId).validUntil },
        organisations: [slot], identitySubjectKey: subjectKey });
    return { record, subjectKey, slot };
}
// In-memory container. With versions on, deleting a base blob keeps its
// current content as a previous version, as Azure does.
function container(blobs, { versions = {}, versioning = false, refuseVersions = false, failDelete = null } = {}) {
    const deleted = [], kept = Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, [...v]]));
    const list = ({ prefix, includeVersions }) => {
        const out = [];
        const names = new Set([...blobs.keys(), ...(includeVersions ? Object.keys(kept) : [])]);
        for (const name of [...names].sort()) if (name.startsWith(prefix)) {
            if (blobs.has(name)) out.push({ name, versionId: includeVersions ? 'current' : undefined, isCurrentVersion: true });
            if (includeVersions) for (const v of kept[name] || []) out.push({ name, versionId: v, isCurrentVersion: false });
        }
        const iterator = (async function* () { yield* out; }());
        iterator.byPage = () => (async function* () { yield { segment: { blobItems: out.map(({ name }) => ({ name })) } }; }());
        return iterator;
    };
    const download = name => async () => {
        if (!blobs.has(name)) throw Object.assign(new Error('missing'), { statusCode: 404, code: 'BlobNotFound' });
        const bytes = Buffer.from(JSON.stringify(blobs.get(name)));
        return { etag: '"e"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
    };
    return { deleted, kept, value: {
        listBlobsFlat: list,
        getBlockBlobClient: name => ({ download: download(name) }),
        getBlobClient: name => ({
            withVersion: version => ({ async delete() {
                if (refuseVersions) throw Object.assign(new Error(), { statusCode: 403 });
                kept[name] = (kept[name] || []).filter(v => v !== version); deleted.push(name + '@' + version);
            } }),
            async deleteIfExists() {
                if (failDelete === name) throw new Error('down');
                const had = blobs.delete(name);
                if (had) { deleted.push(name); if (versioning) kept[name] = [...(kept[name] || []), 'was-current']; }
                return { succeeded: had };
            }
        })
    } };
}
function seed(a, blobs, email, session = new Map()) {
    const accountName = 'customer-starter/' + starterAccountKey(email) + '.json';
    blobs.set(accountName, a.record);
    blobs.set(`customer-subjects/${subjectHash(a.subjectKey)}.json`, { invitationDigest: 'b'.repeat(64), email });
    blobs.set(`customer-signup-recoveries/${subjectHash(a.subjectKey)}.json`, { email });
    session.set(`customer-email-proofs/${sha(`${a.subjectKey}\0${'b'.repeat(64)}`)}.json`, {});
    blobs.set(`customer-starter/starter-setups/${a.slot.organisationId}.json`, { email });
    blobs.set(`customer-activations/${a.slot.activationId}.json`, {});
    blobs.set(termsOfferKey(a.slot.tenantId, a.slot.organisationId), {});
    return accountName;
}

test('inventory and delete remove every record of the account, proof then sign-in first and account last, and nothing shared or foreign', async () => {
    const blobs = new Map(), sessionBlobs = new Map(), email = 'wipe@example.test', other = 'keep@example.test';
    const a = account(1, email), b = account(2, other);
    const accountName = seed(a, blobs, email, sessionBlobs); seed(b, blobs, other, sessionBlobs);
    const client = { requestId: uid(901), kind: 'client', organisationName: 'Client', ...Object.fromEntries(SLOT_IDS.map((k, i) => [k, uid(910 + i)])) };
    blobs.set(`customer-starter/starter-clients/${a.record.accountId}/${client.requestId}.json`, { schemaVersion: 1, accountId: a.record.accountId, slot: client });
    blobs.set(`customer-starter/starter-client-bindings/${a.record.accountId}/${client.bindingId}.json`, {});
    blobs.set(`customer-starter/starter-setups/${client.organisationId}.json`, {});
    blobs.set('customer-terms/' + 'c'.repeat(64) + '.json', {}); blobs.set('customer-schedules/' + 'd'.repeat(64) + '.json', {});
    const keepBefore = [...blobs.keys()].filter(name => !name.includes(a.record.accountId) && !name.includes(starterAccountKey(email).slice(17)));
    const c = container(blobs), sc = container(sessionBlobs), storage = createAccountWipeStorage(c.value, sc.value);
    const found = await storage.inventory(email, signal());
    expect(found.tenantIds).toEqual([a.slot.tenantId, client.tenantId]); expect(found.subjectKey).toBe(a.subjectKey);
    const counts = await storage.delete(found, signal());
    expect(sc.deleted).toEqual([`customer-email-proofs/${sha(`${a.subjectKey}\0${'b'.repeat(64)}`)}.json`]);
    expect(sessionBlobs.size).toBe(1);
    expect(c.deleted[0]).toBe(`customer-subjects/${subjectHash(a.subjectKey)}.json`);
    expect(c.deleted.at(-1)).toBe(accountName);
    expect(counts).toEqual({ blobs: 10, versions: 0, versionsRemaining: 0 });
    for (const name of blobs.keys()) expect(keepBefore).toContain(name);
    expect(blobs.has('customer-terms/' + 'c'.repeat(64) + '.json')).toBe(true);
    expect(blobs.has('customer-starter/' + starterAccountKey(other) + '.json')).toBe(true);
});

test('with versioning on, every version is deleted including the one the base delete leaves behind', async () => {
    const blobs = new Map(), email = 'versions@example.test', a = account(1, email, 'company'); seed(a, blobs, email);
    const name = `customer-subjects/${subjectHash(a.subjectKey)}.json`;
    const ok = container(new Map(blobs), { versions: { [name]: ['v1', 'v2'] }, versioning: true });
    const storage = createAccountWipeStorage(ok.value, container(new Map()).value);
    const counts = await storage.delete(await storage.inventory(email, signal()), signal());
    expect(Object.values(ok.kept).every(list => list.length === 0)).toBe(true);
    expect(counts.versions).toBeGreaterThanOrEqual(3); expect(counts.versionsRemaining).toBe(0);
    const refused = container(new Map(blobs), { versions: { [name]: ['v1'] }, refuseVersions: true });
    const second = createAccountWipeStorage(refused.value, container(new Map()).value);
    expect((await second.delete(await second.inventory(email, signal()), signal())).versionsRemaining).toBe(1);
});

test('an unknown email has no inventory; a failed delete keeps the account record and a retry still finds the proof', async () => {
    const blobs = new Map(), sessionBlobs = new Map(), email = 'partial@example.test', a = account(1, email, 'company'), accountName = seed(a, blobs, email, sessionBlobs);
    expect(await createAccountWipeStorage(container(blobs).value, container(sessionBlobs).value).inventory('nobody@example.test', signal())).toBeNull();
    const failName = `customer-starter/starter-setups/${a.slot.organisationId}.json`;
    const failing = createAccountWipeStorage(container(blobs, { failDelete: failName }).value, container(sessionBlobs).value);
    await expect(failing.delete(await failing.inventory(email, signal()), signal())).rejects.toMatchObject({ code: 'account_wipe_storage_unavailable' });
    expect(blobs.has(accountName)).toBe(true);
    expect(sessionBlobs.size).toBe(0);
    expect(blobs.has(`customer-subjects/${subjectHash(a.subjectKey)}.json`)).toBe(false);
    const retry = createAccountWipeStorage(container(blobs).value, container(sessionBlobs).value);
    await retry.delete(await retry.inventory(email, signal()), signal());
    expect(blobs.size).toBe(0);
});

test('both containers are required', () => {
    expect(() => createAccountWipeStorage(container(new Map()).value)).toThrow('account_wipe_configuration_invalid');
});
