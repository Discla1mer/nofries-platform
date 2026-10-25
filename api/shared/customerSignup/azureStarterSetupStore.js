'use strict';

const { starterSetupRecord, starterSetupKey } = require('./starterSetupDetails');
const MAX_BYTES = 65536;
const fail = () => { throw new Error('starter_details_store_unavailable'); };
// Immutable representative evidence and accepted-offer source are durable. They
// deliberately sit outside the browser-auth/ prefix's ephemeral lifecycle.
class AzureStarterSetupStore {
    constructor(container) {
        if (!container || typeof container.getBlockBlobClient !== 'function') fail();
        this.container = container;
    }
    blob(key) {
        if (typeof key !== 'string' || !/^starter-setups\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key)) fail();
        return this.container.getBlockBlobClient('customer-starter/' + key + '.json');
    }
    check(key, raw) {
        const value = starterSetupRecord(raw);
        if (key !== starterSetupKey(value.offerInput.organisationId)) fail();
        return value;
    }
    async load(key) {
        const blob = this.blob(key);
        try {
            const response = await blob.download(0, MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) });
            let size = 0; const chunks = [];
            try {
                if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > MAX_BYTES) fail();
                for await (const chunk of response.readableStreamBody) { size += chunk.length; if (size > MAX_BYTES) fail(); chunks.push(chunk); }
                if (size !== response.contentLength) fail();
                return this.check(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail();
        }
    }
    async create(key, raw) {
        const bytes = Buffer.from(JSON.stringify(this.check(key, raw)));
        if (bytes.length > MAX_BYTES) fail();
        try {
            await this.blob(key).uploadData(bytes, { conditions: { ifNoneMatch: '*' }, abortSignal: AbortSignal.timeout(5000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            return true;
        } catch (error) {
            if (error?.statusCode === 412 && error.code === 'ConditionNotMet' ||
                error?.statusCode === 409 && error.code === 'BlobAlreadyExists') return false;
            fail();
        }
    }
}
module.exports = { AzureStarterSetupStore };
