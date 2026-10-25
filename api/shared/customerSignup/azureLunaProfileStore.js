'use strict';

const { lunaProfileRecord, LunaProfileError, MAX_BYTES } = require('./lunaProfile');
const { uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const ETAG = /^"[^"\r\n]{1,200}"$/;
const fail = () => { throw new LunaProfileError(); };

// Supply an existing private container explicitly. This module has no runtime
// binding or provisioning, and never alters immutable starter account records.
class AzureLunaProfileStore {
    constructor(container) {
        if (!container || typeof container.getBlockBlobClient !== 'function') throw new TypeError('Invalid Luna profile store');
        this.container = container;
    }
    blob(accountId) {
        try { uuid(accountId); } catch (_) { fail(); }
        return this.container.getBlockBlobClient('customer-luna/profiles/' + accountId + '.json');
    }
    checked(accountId, input) {
        const record = lunaProfileRecord(input);
        if (record.accountId !== accountId) fail();
        return record;
    }
    async load(accountId) {
        const blob = this.blob(accountId);
        try {
            const response = await blob.download(0, MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) });
            const chunks = []; let size = 0;
            try {
                if (typeof response.etag !== 'string' || !ETAG.test(response.etag) ||
                    !Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > MAX_BYTES) fail();
                for await (const chunk of response.readableStreamBody) {
                    size += chunk.length; if (size > MAX_BYTES) fail(); chunks.push(chunk);
                }
                if (size !== response.contentLength) fail();
                const record = this.checked(accountId, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
                return { record, version: response.etag };
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail();
        }
    }
    async write(accountId, value, conditions) {
        const body = Buffer.from(JSON.stringify(value));
        if (!body.length || body.length > MAX_BYTES) fail();
        try {
            await this.blob(accountId).uploadData(body, { conditions, abortSignal: AbortSignal.timeout(5000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            return true;
        } catch (error) {
            if (error?.statusCode === 412 && error.code === 'ConditionNotMet' ||
                error?.statusCode === 409 && error.code === 'BlobAlreadyExists') return false;
            fail();
        }
    }
    async create(accountId, input, beforeWrite) {
        const next = this.checked(accountId, input);
        if (next.revision !== 1 || typeof beforeWrite !== 'function') fail();
        await beforeWrite();
        return this.write(accountId, next, { ifNoneMatch: '*' });
    }
    async replace(accountId, version, input, beforeWrite) {
        const next = this.checked(accountId, input);
        if (typeof version !== 'string' || !ETAG.test(version) || typeof beforeWrite !== 'function') fail();
        const before = await this.load(accountId);
        if (!before || before.version !== version) return false;
        if (next.profileCreatedAt !== before.record.profileCreatedAt || next.revision !== before.record.revision + 1 ||
            next.updatedAt < before.record.updatedAt || next.lastMutation.operationId === before.record.lastMutation.operationId) fail();
        // The transition read above can await storage. Revalidate the current
        // account after it, before dispatching a consequential Blob write.
        await beforeWrite();
        return this.write(accountId, next, { ifMatch: version });
    }
}

module.exports = { AzureLunaProfileStore };
