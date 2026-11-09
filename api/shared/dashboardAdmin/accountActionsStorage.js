'use strict';

// Only exact keys, conditional replacement and append-only audit. No delete,
// enumeration, container creation or automatic write retries are exposed.
const { DashboardAdminError } = require('./service');
const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
async function readActionRecord(container, key, signal) {
    const response = await container.getBlockBlobClient(key).download(0, 32769, { abortSignal: signal });
    const chunks = []; let length = 0;
    try {
        if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 32768 ||
            typeof response.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,128}"$/.test(response.etag)) unavailable();
        for await (const chunk of response.readableStreamBody) {
            length += chunk.length;
            if (length > response.contentLength) unavailable();
            chunks.push(chunk);
        }
        if (length !== response.contentLength) unavailable();
        return { record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), etag: response.etag };
    } finally { response.readableStreamBody?.destroy(); }
}
async function writeActionRecord(container, key, record, conditions, signal) {
    const result = await container.getBlockBlobClient(key).uploadData(Buffer.from(JSON.stringify(record)), {
        conditions, abortSignal: signal, blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
    });
    if (typeof result?.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,128}"$/.test(result.etag)) unavailable();
}
module.exports = { readActionRecord, writeActionRecord };
