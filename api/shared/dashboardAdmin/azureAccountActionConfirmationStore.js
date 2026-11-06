'use strict';

const { isProxy } = require('node:util').types;
const { copy, fields, digest, equal, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const { actionCommand, MAX_CONFIRMATION_BYTES } = require('./accountActionRecords');

const PREFIX = 'dashboard-admin/account-actions/confirmations/';
const fail = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };

// Immutable, private command retention. The browser receives only a random
// token; its digest selects this blob. There is no list/delete/update operation,
// expiry does not erase evidence, and a process restart cannot lose a receipt's
// target or idempotency key. The enclosing service enforces current authority.
class AzureAccountActionConfirmationStore {
    constructor(container) {
        if (!container || isProxy(container) || typeof container.getBlockBlobClient !== 'function' || isProxy(container.getBlockBlobClient)) fail();
        this.container = container;
    }
    blob(key) {
        try { digest(key); } catch (_) { fail(); }
        return this.container.getBlockBlobClient(PREFIX + key + '.json');
    }
    async load(key) {
        try {
            const response = await this.blob(key).download(0, MAX_CONFIRMATION_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) });
            try {
                if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > MAX_CONFIRMATION_BYTES) fail();
                const chunks = []; let length = 0;
                for await (const chunk of response.readableStreamBody) {
                    if (!Buffer.isBuffer(chunk)) fail();
                    length += chunk.length; if (length > MAX_CONFIRMATION_BYTES) fail(); chunks.push(chunk);
                }
                if (length !== response.contentLength) fail();
                const value = fields(copy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
                    MAX_CONFIRMATION_BYTES), ['schemaVersion', 'tokenSha256', 'command']);
                if (value.schemaVersion !== 1 || value.tokenSha256 !== key) fail();
                return actionCommand(value.command);
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail();
        }
    }
    stateBlob(key) {
        try { digest(key); } catch (_) { fail(); }
        return this.container.getBlockBlobClient('dashboard-admin/customer-action-state/' + key + '.json');
    }
    async readState(key) {
        let response;
        try {
            response = await this.stateBlob(key).download(0, 65537, { abortSignal: AbortSignal.timeout(5000) });
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 65536) fail();
            const chunks = []; let length = 0;
            for await (const chunk of response.readableStreamBody) {
                if (!Buffer.isBuffer(chunk)) fail();
                length += chunk.length; if (length > 65536) fail(); chunks.push(chunk);
            }
            if (length !== response.contentLength) fail();
            const value = copy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), 65536);
            if (hash(value) !== key) fail();
            return value;
        } catch (_) { fail(); }
        finally { response?.readableStreamBody?.destroy(); }
    }
    async writeState(input) {
        const value = copy(input, 65536), key = hash(value), body = Buffer.from(JSON.stringify(value));
        try {
            await this.stateBlob(key).uploadData(body, { conditions: { ifNoneMatch: '*' }, abortSignal: AbortSignal.timeout(5000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
        } catch (_) { /* Reconcile an immutable write; never overwrite customer state. */ }
        if (!equal(await this.readState(key), value)) fail();
        return key;
    }
    async create(key, input, beforeWrite) {
        const command = actionCommand(input), body = Buffer.from(JSON.stringify({ schemaVersion: 1, tokenSha256: key, command }));
        if (body.length > MAX_CONFIRMATION_BYTES || typeof beforeWrite !== 'function' || isProxy(beforeWrite)) fail();
        const blob = this.blob(key);
        await beforeWrite();
        try {
            await blob.uploadData(body, { conditions: { ifNoneMatch: '*' }, abortSignal: AbortSignal.timeout(5000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
        } catch (_) { /* Reconcile one conditional attempt, including acknowledgement loss. */ }
        const stored = await this.load(key);
        if (!stored || !equal(stored, command)) fail();
        return true;
    }
}

module.exports = { AzureAccountActionConfirmationStore, PREFIX };
