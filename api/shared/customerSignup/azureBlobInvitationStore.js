'use strict';

const { validateInvitationRecord } = require('./invitationAcceptance');

const MAX_RECORD_BYTES = 32 * 1024;
const HASH = /^[a-f0-9]{64}$/;

class SignupInvitationStoreError extends Error {
    constructor(code = 'signup_store_unavailable') {
        super(code);
        this.name = 'SignupInvitationStoreError';
        this.code = code;
        this.statusCode = 503;
    }
}

class SignupInvitationCallbackError extends Error {
    constructor(cause) { super('signup_callback_failed'); this.cause = cause; }
}

class AzureBlobSignupInvitationStore {
    constructor(options = {}) {
        if (!options.containerClient || typeof options.containerClient.getProperties !== 'function' ||
            typeof options.containerClient.getBlockBlobClient !== 'function') {
            throw new SignupInvitationStoreError('signup_store_configuration_invalid');
        }
        this.container = options.containerClient;
        this.ready = null;
    }

    async read(digest) {
        validateDigest(digest);
        await this.ensureContainer();
        try {
            const downloaded = await this.blob(digest).download(0, undefined);
            const record = validateStoredRecord(decode(await streamToBuffer(downloaded.readableStreamBody)));
            if (record.tokenDigest !== digest) throw new SignupInvitationStoreError('signup_store_record_invalid');
            return clone(record);
        } catch (error) {
            if (error && Number(error.statusCode) === 404) return null;
            throw storeError(error);
        }
    }

    async create(record) {
        const validated = validateStoredRecord(record);
        const digest = validated.tokenDigest;
        const body = encode(validated);
        await this.ensureContainer();
        try {
            await this.blob(digest).uploadData(body, {
                conditions: { ifNoneMatch: '*' },
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
            });
        } catch (error) {
            if (error && [409, 412].includes(Number(error.statusCode))) {
                throw new SignupInvitationStoreError('signup_store_conflict');
            }
            throw storeError(error);
        }
    }

    async transact(digest, work) {
        validateDigest(digest);
        if (typeof work !== 'function') throw new SignupInvitationStoreError('signup_store_configuration_invalid');
        await this.ensureContainer();
        const blob = this.blob(digest);
        let lease;
        let acquired = false;
        try {
            lease = blob.getBlobLeaseClient();
            let response;
            try { response = await lease.acquireLease(15); }
            catch (error) {
                if (error && Number(error.statusCode) === 404) {
                    try { return await work(null); } catch (callbackError) { throw new SignupInvitationCallbackError(callbackError); }
                }
                throw error;
            }
            acquired = true;
            const leaseId = response && response.leaseId;
            if (typeof leaseId !== 'string' || !leaseId) throw new SignupInvitationStoreError();
            let downloaded;
            try { downloaded = await blob.download(0, undefined, { conditions: { leaseId } }); }
            catch (error) {
                if (error && Number(error.statusCode) === 404) {
                    try { return await work(null); } catch (callbackError) { throw new SignupInvitationCallbackError(callbackError); }
                }
                throw error;
            }
            if (typeof downloaded.etag !== 'string' || !downloaded.etag) throw new SignupInvitationStoreError();
            const current = validateStoredRecord(decode(await streamToBuffer(downloaded.readableStreamBody)));
            if (current.tokenDigest !== digest) throw new SignupInvitationStoreError('signup_store_record_invalid');
            let outcome;
            try { outcome = await work(clone(current)); }
            catch (callbackError) { throw new SignupInvitationCallbackError(callbackError); }
            if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) ||
                !Object.hasOwn(outcome, 'record') || !Object.hasOwn(outcome, 'result')) {
                throw new SignupInvitationStoreError('signup_store_transaction_invalid');
            }
            const next = validateStoredRecord(outcome.record);
            if (next.tokenDigest !== digest) throw new SignupInvitationStoreError('signup_store_record_invalid');
            await blob.uploadData(encode(next), {
                conditions: { leaseId, ifMatch: downloaded.etag },
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
            });
            return clone(outcome.result);
        } catch (error) {
            if (error instanceof SignupInvitationCallbackError) throw error.cause;
            if (error instanceof SignupInvitationStoreError) throw error;
            throw storeError(error);
        } finally {
            if (acquired && lease) {
                try { await lease.releaseLease(); } catch (_) { /* the finite lease permits a safe retry */ }
            }
        }
    }

    async ensureContainer() {
        if (!this.ready) {
            const pending = this.container.getProperties();
            this.ready = pending;
            pending.catch(() => { if (this.ready === pending) this.ready = null; });
        }
        try { await this.ready; } catch (error) { throw storeError(error); }
    }

    blob(digest) {
        return this.container.getBlockBlobClient(`browser-auth/customer-signup/invitations/${validateDigest(digest)}.json`);
    }
}

function validateDigest(value) {
    if (typeof value !== 'string' || !HASH.test(value)) {
        throw new SignupInvitationStoreError('signup_store_identifier_invalid');
    }
    return value;
}

function validateStoredRecord(record) {
    try {
        const validated = validateInvitationRecord(record);
        validateDigest(validated.tokenDigest);
        return validated;
    } catch (_) { throw new SignupInvitationStoreError('signup_store_record_invalid'); }
}

function encode(record) {
    let body;
    try { body = Buffer.from(JSON.stringify(record), 'utf8'); } catch (_) { throw new SignupInvitationStoreError('signup_store_record_invalid'); }
    if (!body.length || body.length > MAX_RECORD_BYTES) throw new SignupInvitationStoreError('signup_store_record_invalid');
    return body;
}

function decode(buffer) {
    try {
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_RECORD_BYTES) throw new Error();
        const value = JSON.parse(buffer.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
    } catch (_) { throw new SignupInvitationStoreError('signup_store_record_invalid'); }
}

async function streamToBuffer(stream) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new SignupInvitationStoreError('signup_store_record_invalid');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > MAX_RECORD_BYTES) throw new SignupInvitationStoreError('signup_store_record_invalid');
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

function storeError(error) {
    return error instanceof SignupInvitationStoreError ? error : new SignupInvitationStoreError();
}

function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { throw new SignupInvitationStoreError('signup_store_record_invalid'); }
}

module.exports = Object.freeze({ AzureBlobSignupInvitationStore, SignupInvitationStoreError });
