'use strict';

// Exercises the Azure binding with the genuine reset coordinator against an
// in-memory container that follows Blob lease, ETag and version rules.
// Synthetic data only. No reset runs against real storage.
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createEmptySignupReset } = require('../../api/shared/customerSignup/emptySignupReset');
const { createAzureEmptySignupResetBinding } = require('../../api/shared/customerSignup/azureEmptySignupResetBinding');
const { starterAccountKey, starterAccountRecord } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan } = require('../../api/shared/customerSignup/customerStarterPlan');
const { authority, subjectHash } = require('../../api/shared/customerSignup/customerAuthority');

const { withCustomerRecordWrite, fenceKey, PREFIX } = require('../../api/shared/customerSignup/azureCustomerWriteFence');

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
        if (conditions.leaseId && !found?.leaseId) throw storageError(412, 'LeaseNotPresentWithBlobOperation');
        if (found?.leaseId && conditions.leaseId !== found.leaseId) throw storageError(412, 'LeaseIdMissing');
        if (conditions.ifNoneMatch === '*' && found) throw storageError(409, 'BlobAlreadyExists');
        if (conditions.ifMatch && found?.etag !== conditions.ifMatch) throw storageError(412, 'ConditionNotMet');
    };
    const download = bytesOf => async () => {
        const found = bytesOf(); if (!found) throw storageError(404, 'BlobNotFound');
        return { etag: found.etag, contentLength: found.bytes.length, readableStreamBody: Readable.from([Buffer.from(found.bytes)]) };
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
    const guards = () => ['account', 'authority'].map(name => containers[name].current.get(fenceKey(KEYS[name])));
    const appWrite = name => withCustomerRecordWrite(containers[name], KEYS[name], async () => {
        const found = containers[name].current.get(KEYS[name]);
        return containers[name].getBlockBlobClient(KEYS[name]).uploadData(original[name].bytes,
            { conditions: found ? { ifMatch: found.etag } : { ifNoneMatch: '*' } });
    });
    return { request, starter, subjects, containers, original, bindingFor, coordinator, guards, appWrite };
}
module.exports = { fixture, azureContainer, KEYS, storageError, uid, PREFIX, fenceKey };
