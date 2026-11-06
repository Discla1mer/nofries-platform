'use strict';
const { Readable } = require('node:stream');
const missing = () => Object.assign(new Error('synthetic absent'), { statusCode: 404, code: 'BlobNotFound' });
const conflict = () => Object.assign(new Error('synthetic condition'), { statusCode: 412, code: 'ConditionNotMet' });
function versionedBlobs() {
    let sequence = 0;
    const current = new Map(), versions = new Map(), leases = new Map(), calls = [];
    function put(key, value) {
        const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
        const entry = { bytes, etag: '"v' + ++sequence + '"', versionId: 'v' + sequence };
        current.set(key, entry); versions.set(key + ':' + entry.versionId, entry); return entry;
    }
    function client(key, version = null) {
        return {
            async download() {
                const row = version ? versions.get(key + ':' + version) : current.get(key);
                if (!row) throw missing();
                return { ...row, contentLength: row.bytes.length, readableStreamBody: Readable.from([row.bytes]) };
            },
            async uploadData(bytes, options = {}) {
                calls.push(['write', key]); const before = current.get(key), c = options.conditions || {};
                if (c.ifNoneMatch === '*' && before || c.ifMatch && c.ifMatch !== before?.etag || leases.has(key) && leases.get(key) !== c.leaseId) throw conflict();
                return put(key, bytes);
            },
            async delete(options = {}) {
                calls.push(['delete', key]); const before = current.get(key), c = options.conditions || {};
                if (!before) throw missing();
                if (c.ifMatch && c.ifMatch !== before.etag || leases.has(key) && leases.get(key) !== c.leaseId) throw conflict();
                current.delete(key); leases.delete(key);
            },
            withVersion: id => client(key, id),
            getBlobLeaseClient(id) { return {
                async acquireLease(duration) { calls.push(['lease', key]); if (!current.has(key)) throw missing(); if (leases.has(key)) throw conflict();
                    if (duration !== -1) throw new Error('synthetic requires durable lease'); leases.set(key, id); return { leaseId: id }; },
                async renewLease() { if (!current.has(key)) throw missing(); if (leases.get(key) !== id) throw conflict(); },
                async releaseLease() { if (!current.has(key)) throw missing(); if (leases.get(key) !== id) throw conflict(); leases.delete(key); }
            }; }
        };
    }
    return { current, versions, leases, calls, put, container: { getBlockBlobClient: client, async getProperties() { return {}; },
        listBlobsFlat: ({ prefix }) => (async function* () { for (const name of current.keys()) if (name.startsWith(prefix)) yield { name }; })() } };
}
module.exports = { versionedBlobs };

