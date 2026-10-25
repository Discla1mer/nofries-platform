'use strict';

const { starterAccountRecord, starterAccountKey, starterClientRecord } = require('./starterAccountAllocation');
const { hash, uuid, fields, copy, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const MAX_BYTES = 32768;
const fail = code => { const error = new Error(code); error.code = code; throw error; };

const CLIENT_BYTES = 8192;
const clientPrefix = accountId => { uuid(accountId); return 'customer-starter/starter-clients/' + accountId + '/'; };
function clientEnvelope(accountId, requestId, input) {
    const value = fields(copy(input, CLIENT_BYTES), ['schemaVersion', 'accountId', 'slot']);
    if (value.schemaVersion !== 1 || value.accountId !== accountId) fail('starter_store_record_invalid');
    const slot = starterClientRecord(accountId, value.slot);
    if (slot.requestId !== requestId) fail('starter_store_record_invalid');
    return slot;
}
function bindingEnvelope(accountId, bindingId, input) {
    const value = fields(copy(input, 1024), ['schemaVersion', 'accountId', 'bindingId', 'requestId']);
    if (value.schemaVersion !== 1 || value.accountId !== accountId || value.bindingId !== bindingId) fail('starter_store_record_invalid');
    uuid(value.requestId); return value;
}
function cursorToken(accountId, cursor) {
    if (cursor === null) return undefined;
    if (typeof cursor !== 'string' || !cursor.length || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('starter_store_cursor_invalid');
    try {
        const bytes = Buffer.from(cursor, 'base64url');
        if (bytes.toString('base64url') !== cursor) fail('starter_store_cursor_invalid');
        const value = fields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['schemaVersion', 'accountId', 'token']);
        if (value.schemaVersion !== 1 || value.accountId !== accountId || typeof value.token !== 'string' || !value.token.length || value.token.length > 4096) fail('starter_store_cursor_invalid');
        return value.token;
    } catch { fail('starter_store_cursor_invalid'); }
}
function nextCursor(accountId, token) {
    if (token === undefined || token === null || token === '') return null;
    if (typeof token !== 'string' || token.length > 4096) fail('starter_store_record_invalid');
    return Buffer.from(JSON.stringify({ schemaVersion: 1, accountId, token })).toString('base64url');
}

// Durable account/capacity records have their own prefix. They are not short
// lived browser sessions, have no TTL and must be included in recovery. This
// adapter grants no authority and never writes the independent authority store.
class AzureStarterAccountStore {
    constructor(container) {
        if (!container || typeof container.getBlockBlobClient !== 'function') fail('starter_store_configuration_invalid');
        this.container = container;
    }
    blob(key) {
        if (typeof key !== 'string' || !/^starter-accounts\/[a-f0-9]{64}$/.test(key)) fail('starter_store_key_invalid');
        return this.container.getBlockBlobClient('customer-starter/' + key + '.json');
    }
    checked(key, input) {
        const value = starterAccountRecord(input);
        if (starterAccountKey(value.email) !== key) fail('starter_store_key_invalid');
        return value;
    }
    async load(key) {
        const blob = this.blob(key);
        try {
            const response = await blob.download(0, MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) });
            const chunks = []; let size = 0;
            try {
                if (typeof response.etag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(response.etag) ||
                    !Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > MAX_BYTES) fail('starter_store_record_invalid');
                for await (const chunk of response.readableStreamBody) {
                    size += chunk.length; if (size > MAX_BYTES) fail('starter_store_record_invalid'); chunks.push(chunk);
                }
                if (size !== response.contentLength) fail('starter_store_record_invalid');
                const record = this.checked(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
                return { record, version: response.etag };
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail('starter_store_unavailable');
        }
    }
    async write(key, value, conditions) {
        const body = Buffer.from(JSON.stringify(value));
        if (!body.length || body.length > MAX_BYTES) fail('starter_store_record_invalid');
        try {
            await this.blob(key).uploadData(body, { conditions, abortSignal: AbortSignal.timeout(5000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            return true;
        } catch (error) {
            if (error?.statusCode === 412 && error.code === 'ConditionNotMet' ||
                error?.statusCode === 409 && error.code === 'BlobAlreadyExists') return false;
            fail('starter_store_unavailable');
        }
    }
    async create(key, input) {
        const value = this.checked(key, input);
        if (value.activation !== null || value.organisations.length !== 1) fail('starter_store_transition_invalid');
        return this.write(key, value, { ifNoneMatch: '*' });
    }
    clientBlob(accountId, requestId) {
        uuid(requestId);
        return this.container.getBlockBlobClient(clientPrefix(accountId) + requestId + '.json');
    }
    async loadClient(accountId, requestId, signal = AbortSignal.timeout(5000)) {
        const blob = this.clientBlob(accountId, requestId);
        try {
            signal.throwIfAborted();
            const response = await blob.download(0, CLIENT_BYTES + 1, { abortSignal: signal });
            const chunks = []; let size = 0;
            try {
                if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > CLIENT_BYTES) fail('starter_store_record_invalid');
                for await (const chunk of response.readableStreamBody) {
                    size += chunk.length; if (size > CLIENT_BYTES) fail('starter_store_record_invalid'); chunks.push(chunk);
                }
                signal.throwIfAborted();
                if (size !== response.contentLength) fail('starter_store_record_invalid');
                return clientEnvelope(accountId, requestId, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail('starter_store_unavailable');
        }
    }
    bindingBlob(accountId, bindingId) {
        uuid(accountId); uuid(bindingId);
        return this.container.getBlockBlobClient('customer-starter/starter-client-bindings/' + accountId + '/' + bindingId + '.json');
    }
    async loadClientBinding(accountId, bindingId, signal = AbortSignal.timeout(5000)) {
        const blob = this.bindingBlob(accountId, bindingId);
        try {
            signal.throwIfAborted();
            const response = await blob.download(0, 1025, { abortSignal: signal });
            const chunks = []; let size = 0;
            try {
                if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 1024) fail('starter_store_record_invalid');
                for await (const chunk of response.readableStreamBody) {
                    size += chunk.length; if (size > 1024) fail('starter_store_record_invalid'); chunks.push(chunk);
                }
                signal.throwIfAborted();
                if (size !== response.contentLength) fail('starter_store_record_invalid');
                return bindingEnvelope(accountId, bindingId, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            } finally { response.readableStreamBody?.destroy(); }
        } catch (error) {
            if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
            fail('starter_store_unavailable');
        }
    }
    async loadClientByBinding(accountId, bindingId) {
        const signal = AbortSignal.timeout(5000), alias = await this.loadClientBinding(accountId, bindingId, signal);
        if (alias === null) return null;
        const slot = await this.loadClient(accountId, alias.requestId, signal);
        if (slot === null || slot.bindingId !== bindingId || slot.requestId !== alias.requestId) fail('starter_store_record_invalid');
        signal.throwIfAborted(); return slot;
    }
    async listClients(accountId, input) {
        const command = fields(copy(input, 16384), ['cursor', 'limit']);
        const prefix = clientPrefix(accountId), token = cursorToken(accountId, command.cursor);
        if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 50 ||
            typeof this.container.listBlobsFlat !== 'function') fail('starter_store_configuration_invalid');
        const signal = AbortSignal.timeout(5000);
        let pages;
        try {
            pages = this.container.listBlobsFlat({ prefix, abortSignal: signal }).byPage({ continuationToken: token, maxPageSize: command.limit });
            const result = await pages.next(); signal.throwIfAborted();
            if (result.done) return freeze({ clients: [], nextCursor: null });
            const page = result.value, items = page?.segment?.blobItems;
            if (!Array.isArray(items) || items.length > command.limit ||
                page.continuationToken && page.continuationToken === token) fail('starter_store_record_invalid');
            let previous = null;
            const requestIds = items.map(item => {
                if (typeof item?.name !== 'string' || !item.name.startsWith(prefix) || !item.name.endsWith('.json') ||
                    previous !== null && item.name <= previous) fail('starter_store_record_invalid');
                previous = item.name;
                const requestId = item.name.slice(prefix.length, -5); uuid(requestId); return requestId;
            });
            const clients = [];
            for (const requestId of requestIds) {
                signal.throwIfAborted();
                const slot = await this.loadClient(accountId, requestId, signal);
                if (slot === null) fail('starter_store_record_invalid');
                clients.push(slot);
            }
            signal.throwIfAborted();
            return freeze({ clients, nextCursor: nextCursor(accountId, page.continuationToken) });
        } catch { fail('starter_store_unavailable'); }
        finally { if (pages?.return) await pages.return(); }
    }
    async replace(key, version, input) {
        const next = this.checked(key, input);
        if (typeof version !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(version)) fail('starter_store_version_invalid');
        const before = await this.load(key);
        if (!before || before.version !== version) return false;
        const { activation, organisations, ...identity } = before.record;
        const { activation: nextActivation, organisations: nextOrganisations, ...nextIdentity } = next;
        if (hash(identity) !== hash(nextIdentity) || activation && hash(activation) !== hash(nextActivation) ||
            nextOrganisations.length < organisations.length || nextOrganisations.length > organisations.length + 1 ||
            hash(nextOrganisations.slice(0, organisations.length)) !== hash(organisations) ||
            !activation && nextOrganisations.length !== organisations.length) fail('starter_store_transition_invalid');
        return this.write(key, next, { ifMatch: version });
    }
}

module.exports = { AzureStarterAccountStore };
