'use strict';

const { Readable } = require('node:stream');
const { AzureBlobSignupInvitationStore, SignupInvitationStoreError } =
    require('../api/shared/customerSignup/azureBlobInvitationStore');

const DIGEST = 'a'.repeat(64);
const record = (overrides = {}) => ({ schemaVersion: 1, invitationId: 'invite-1', tokenDigest: DIGEST,
    expectedEmail: 'matty@example.nz', tenantId: 'sample-alpha', organisationId: 'sample-alpha-org',
    identityPolicyId: 'pilot-entra-b2b-mfa-v1', termsVersion: 'pilot-v1', termsDigest: 'b'.repeat(64),
    mfaRequired: true, createdAt: 1000, expiresAt: 2000, status: 'invited', revision: 0, acceptance: null,
    ...overrides });

function fixture(initial = null) {
    let body = initial && Buffer.from(JSON.stringify(initial));
    let etag = '"1"';
    let leased = false;
    const uploads = [];
    const lease = {
        acquireLease: jest.fn(async () => { leased = true; return { leaseId: 'lease-1' }; }),
        releaseLease: jest.fn(async () => { leased = false; })
    };
    const blob = {
        getBlobLeaseClient: jest.fn(() => lease),
        download: jest.fn(async () => {
            if (!body) throw Object.assign(new Error('missing'), { statusCode: 404 });
            return { etag, readableStreamBody: Readable.from([body]) };
        }),
        uploadData: jest.fn(async (value, options) => {
            if (options.conditions.ifNoneMatch === '*' && body) throw Object.assign(new Error('exists'), { statusCode: 412 });
            if (options.conditions.leaseId && !leased) throw new Error('lease required');
            body = Buffer.from(value); etag = '"2"'; uploads.push({ body: JSON.parse(body), options });
        })
    };
    const container = {
        getProperties: jest.fn(async () => ({})),
        getBlockBlobClient: jest.fn(name => { expect(name).toBe(`browser-auth/customer-signup/invitations/${DIGEST}.json`); return blob; })
    };
    return { blob, container, lease, store: new AzureBlobSignupInvitationStore({ containerClient: container }), uploads };
}

test('creates an invitation once in the private signup namespace', async () => {
    const f = fixture();
    await f.store.create(record());
    expect(f.uploads[0].options).toMatchObject({ conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
    await expect(f.store.create(record())).rejects.toMatchObject({ code: 'signup_store_conflict' });
});

test('lease-protects a transaction and returns a detached result', async () => {
    const f = fixture(record());
    const result = await f.store.transact(DIGEST, current => ({
        record: { ...current, status: 'accepted', revision: 1, acceptance: { receiptId: 'receipt-1',
            invitationId: 'invite-1', subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
            tenantId: 'sample-alpha', organisationId: 'sample-alpha-org', termsVersion: 'pilot-v1',
            termsDigest: 'b'.repeat(64), acceptedAt: 1500, status: 'pending_admission', dashboardAccess: false } },
        result: { status: 'pending_admission' }
    }));
    expect(result).toEqual({ status: 'pending_admission' });
    expect(f.uploads[0]).toMatchObject({ body: { tokenDigest: DIGEST, status: 'accepted', revision: 1 },
        options: { conditions: { leaseId: 'lease-1', ifMatch: '"1"' } } });
    expect(f.lease.releaseLease).toHaveBeenCalledTimes(1);
});

test('missing invitation reaches the domain callback without creating a record', async () => {
    const f = fixture();
    const callback = jest.fn(() => { throw Object.assign(new Error('unavailable'), { code: 'domain_error' }); });
    await expect(f.store.transact(DIGEST, callback)).rejects.toMatchObject({ code: 'domain_error' });
    expect(callback).toHaveBeenCalledWith(null);
    expect(f.blob.uploadData).not.toHaveBeenCalled();
});

test.each([
    ['changed digest', current => ({ record: { ...current, tokenDigest: 'b'.repeat(64) }, result: {} })],
    ['malformed outcome', () => ({ result: {} })]
])('rejects %s without committing', async (_name, callback) => {
    const f = fixture(record());
    await expect(f.store.transact(DIGEST, callback)).rejects.toBeInstanceOf(SignupInvitationStoreError);
    expect(f.uploads).toHaveLength(0);
    expect(f.lease.releaseLease).toHaveBeenCalledTimes(1);
});

test('fails closed on corrupt and provider records', async () => {
    const f = fixture({ tokenDigest: 'bad' });
    await expect(f.store.transact(DIGEST, () => null)).rejects.toMatchObject({ code: 'signup_store_record_invalid' });
    const unavailable = fixture(record()); unavailable.blob.download.mockRejectedValueOnce(new Error('private detail'));
    await expect(unavailable.store.transact(DIGEST, () => null)).rejects.toMatchObject({ code: 'signup_store_unavailable' });
    expect(() => new AzureBlobSignupInvitationStore({})).toThrow('signup_store_configuration_invalid');
});

test('rejects extra secret-bearing fields before persistence', async () => {
    const f = fixture();
    await expect(f.store.create({ ...record(), invitationToken: 'raw-secret-token' }))
        .rejects.toMatchObject({ code: 'signup_store_record_invalid' });
    expect(f.blob.uploadData).not.toHaveBeenCalled();
});

test.each([
    () => Object.assign(new (class InvitationRecord {})(), record()),
    () => {
        const value = record();
        Object.defineProperty(value, 'expectedEmail', { enumerable: true, get: () => 'matty@example.nz' });
        return value;
    }
])('rejects non-data invitation records before cloning or persistence %#', async makeRecord => {
    const f = fixture();
    await expect(f.store.create(makeRecord())).rejects.toMatchObject({ code: 'signup_store_record_invalid' });
    expect(f.blob.uploadData).not.toHaveBeenCalled();
});

test('upload-time 404 never replays the transaction callback', async () => {
    const f = fixture(record());
    f.blob.uploadData.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 404 }));
    const callback = jest.fn(current => ({ record: current, result: { status: 'pending_admission' } }));
    await expect(f.store.transact(DIGEST, callback)).rejects.toMatchObject({ code: 'signup_store_unavailable' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toMatchObject({ tokenDigest: DIGEST });
});

test('missing ETag fails before invoking the transaction callback', async () => {
    const f = fixture(record());
    f.blob.download.mockResolvedValueOnce({ readableStreamBody: Readable.from([Buffer.from(JSON.stringify(record()))]) });
    const callback = jest.fn();
    await expect(f.store.transact(DIGEST, callback)).rejects.toMatchObject({ code: 'signup_store_unavailable' });
    expect(callback).not.toHaveBeenCalled();
});
