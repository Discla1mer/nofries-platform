const crypto = require('crypto');

const DEFAULT_CONTAINER_NAME = 'nofries-browser-auth';
const MAX_RECORD_BYTES = 16 * 1024;

class BrowserSessionStoreError extends Error {
    constructor(code = 'browser_auth_store_unavailable') {
        super('Browser authentication storage is unavailable.');
        this.name = 'BrowserSessionStoreError';
        this.code = code;
        this.statusCode = 503;
    }
}

class MemoryBrowserSessionStore {
    constructor() {
        this.transactions = new Map();
        this.sessions = new Map();
        this.fences = new Map();
    }

    async createTransaction(id, record) {
        if (this.transactions.has(id)) {
            throw new BrowserSessionStoreError('browser_auth_store_conflict');
        }
        this.transactions.set(id, clone(record));
    }

    async consumeTransaction(id, expectedState, customerPurpose) {
        validateConsumptionPurpose(customerPurpose);
        const record = this.transactions.get(id);
        if (!record) return null;
        if (record.customerPurpose !== customerPurpose || expectedState != null && !transactionStateMatches(record, expectedState)) {
            return { matched: false, record: null };
        }
        this.transactions.delete(id);
        const value = clone(record);
        return expectedState == null ? value : { matched: true, record: value };
    }

    async deleteTransaction(id) {
        this.transactions.delete(id);
    }

    async cancelTransaction(id, binding) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        const record = this.transactions.get(id);
        if (!record) return 'missing';
        if (!transactionRealmMatches(record, binding)) return false;
        this.transactions.delete(id);
        return true;
    }

    // Setup sign-out fence: one record per consumed transaction, first writer
    // wins. A callback settles it before issuing a session cookie; sign-out
    // revokes it. Whichever arrives second sees the other's record.
    async settleTransaction(id, binding, sealed) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        validateSealedSession(sealed);
        const existing = this.fences.get(id);
        if (existing) return false;
        this.fences.set(id, fenceRecord(binding, 'settled', sealed));
        return true;
    }

    async revokeTransaction(id, binding) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        if (!this.fences.has(id)) this.fences.set(id, fenceRecord(binding, 'revoked'));
        return fenceOutcome(clone(this.fences.get(id)), binding);
    }

    async createSession(id, record) {
        if (this.sessions.has(id)) {
            throw new BrowserSessionStoreError('browser_auth_store_conflict');
        }
        this.sessions.set(id, clone(record));
    }

    async loadSession(id) {
        const record = this.sessions.get(id);
        return record ? clone(record) : null;
    }

    async deleteSession(id) {
        this.sessions.delete(id);
    }
}

class AzureBlobBrowserSessionStore {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.container = options.containerClient || createManagedIdentityContainer(env, options);
        this.ready = null;
    }

    async createTransaction(id, record) {
        await this.create('transactions', id, record);
    }

    async consumeTransaction(id, expectedState, customerPurpose) {
        validateConsumptionPurpose(customerPurpose);
        await this.ensureContainer();
        const blob = this.blob('transactions', id);
        let leaseClient;
        let leaseAcquired = false;
        let deleted = false;
        try {
            const proposedLeaseId = crypto.randomUUID();
            leaseClient = blob.getBlobLeaseClient(proposedLeaseId);
            const acquired = await leaseClient.acquireLease(15);
            leaseAcquired = true;
            const leaseId = acquired.leaseId || proposedLeaseId;
            if (leaseId !== proposedLeaseId) {
                leaseClient = blob.getBlobLeaseClient(leaseId);
            }
            const response = await blob.download(0, undefined, {
                conditions: { leaseId }
            });
            const record = parseRecord(await streamToBuffer(response.readableStreamBody));
            if (record.customerPurpose !== customerPurpose || expectedState != null && !transactionStateMatches(record, expectedState)) {
                return { matched: false, record: null };
            }
            await blob.delete({ conditions: { leaseId } });
            deleted = true;
            return expectedState == null ? record : { matched: true, record };
        } catch (error) {
            if (isMissingOrContended(error)) return null;
            throw storeError(error);
        } finally {
            if (leaseAcquired && !deleted && leaseClient) {
                try {
                    await leaseClient.releaseLease();
                } catch (error) {
                    // The transaction remains short-lived and a later attempt can retry.
                }
            }
        }
    }

    async deleteTransaction(id) {
        await this.remove('transactions', id);
    }

    async cancelTransaction(id, binding) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        await this.ensureContainer();
        const blob = this.blob('transactions', id);
        // A foreign record must not even be leased. The guarded read is repeated
        // under the lease so a concurrent callback cannot win between checks.
        let before;
        try {
            const response = await blob.download(0);
            before = parseRecord(await streamToBuffer(response.readableStreamBody));
        } catch (error) {
            if (error && error.statusCode === 404) return 'missing';
            throw storeError(error);
        }
        if (!transactionRealmMatches(before, binding)) return false;
        let leaseClient, leaseAcquired = false, deleted = false;
        try {
            const proposedLeaseId = crypto.randomUUID();
            leaseClient = blob.getBlobLeaseClient(proposedLeaseId);
            const acquired = await leaseClient.acquireLease(15);
            leaseAcquired = true;
            const leaseId = acquired.leaseId || proposedLeaseId;
            if (leaseId !== proposedLeaseId) leaseClient = blob.getBlobLeaseClient(leaseId);
            const response = await blob.download(0, undefined, { conditions: { leaseId } });
            const record = parseRecord(await streamToBuffer(response.readableStreamBody));
            if (!transactionRealmMatches(record, binding)) return false;
            await blob.delete({ conditions: { leaseId } });
            deleted = true;
            return true;
        } catch (error) {
            // Contention or disappearance after a matching read can mean a
            // callback already consumed it. Neither is confirmed cancellation.
            throw storeError(error);
        } finally {
            if (leaseAcquired && !deleted && leaseClient) {
                try { await leaseClient.releaseLease(); } catch (_) { /* No deletion was acknowledged. */ }
            }
        }
    }

    async settleTransaction(id, binding, sealed) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        validateSealedSession(sealed);
        try {
            await this.create('fences', id, fenceRecord(binding, 'settled', sealed));
            return true;
        } catch (error) {
            // Only a confirmed existing fence means sign-out got there first.
            if (error && error.code === 'browser_auth_store_conflict') return false;
            throw error;
        }
    }

    async revokeTransaction(id, binding) {
        validateOpaqueId(id);
        validateCancellationBinding(binding);
        try {
            await this.create('fences', id, fenceRecord(binding, 'revoked'));
        } catch (error) {
            if (!error || error.code !== 'browser_auth_store_conflict') throw error;
        }
        // Read back whichever record won, including an earlier revocation.
        let record;
        try {
            const response = await this.blob('fences', id).download(0);
            record = parseRecord(await streamToBuffer(response.readableStreamBody));
        } catch (error) {
            throw storeError(error);
        }
        return fenceOutcome(record, binding);
    }

    async createSession(id, record) {
        await this.create('sessions', id, record);
    }

    async loadSession(id) {
        await this.ensureContainer();
        try {
            const response = await this.blob('sessions', id).download(0);
            return parseRecord(await streamToBuffer(response.readableStreamBody));
        } catch (error) {
            if (error && error.statusCode === 404 && error.code === 'BlobNotFound') return null;
            throw storeError(error);
        }
    }

    async deleteSession(id) {
        await this.remove('sessions', id);
    }

    async create(kind, id, record) {
        await this.ensureContainer();
        const body = Buffer.from(JSON.stringify(record), 'utf8');
        if (!body.length || body.length > MAX_RECORD_BYTES) {
            throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
        }
        try {
            await this.blob(kind, id).uploadData(body, {
                conditions: { ifNoneMatch: '*' },
                blobHTTPHeaders: {
                    blobContentType: 'application/json',
                    blobCacheControl: 'no-store'
                }
            });
        } catch (error) {
            if (error && (error.statusCode === 409 || error.statusCode === 412)) {
                throw new BrowserSessionStoreError('browser_auth_store_conflict');
            }
            throw storeError(error);
        }
    }

    async remove(kind, id) {
        await this.ensureContainer();
        try {
            await this.blob(kind, id).deleteIfExists();
        } catch (error) {
            throw storeError(error);
        }
    }

    async ensureContainer() {
        if (!this.ready) {
            // The hosted identity is deliberately scoped to data access on an
            // already-provisioned container; it must not need control-plane or
            // container-creation privileges.
            const pending = this.container.getProperties();
            this.ready = pending;
            pending.catch(() => {
                if (this.ready === pending) this.ready = null;
            });
        }
        try {
            await this.ready;
        } catch (error) {
            throw storeError(error);
        }
    }

    blob(kind, id) {
        return this.container.getBlockBlobClient(
            `browser-auth/${kind}/${sha256(validateOpaqueId(id))}.json`
        );
    }
}

function createBrowserSessionStore(options = {}) {
    if (options.store) return options.store;
    const env = options.env || process.env;
    const requireAuth = String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
    const provider = String(env.NOFRIES_BROWSER_SESSION_STORE || '').trim().toLowerCase();
    if (provider === 'memory') {
        if (requireAuth) {
            throw new BrowserSessionStoreError('browser_auth_store_configuration_invalid');
        }
        return new MemoryBrowserSessionStore();
    }
    if (!provider && !requireAuth) return new MemoryBrowserSessionStore();
    if (provider !== 'azure') {
        throw new BrowserSessionStoreError('browser_auth_store_configuration_invalid');
    }
    return new AzureBlobBrowserSessionStore(Object.assign({}, options, { env }));
}

function createManagedIdentityContainer(env, options) {
    const accountName = String(
        options.accountName ||
        env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT ||
        ''
    ).trim();
    const applicationDataAccount = String(env.AZURE_STORAGE_ACCOUNT_NAME || '').trim().toLowerCase();
    if (!/^[a-z0-9]{3,24}$/.test(accountName) ||
        (applicationDataAccount && accountName.toLowerCase() === applicationDataAccount)) {
        throw new BrowserSessionStoreError('browser_auth_store_configuration_invalid');
    }
    const containerName = String(
        options.containerName ||
        env.NOFRIES_BROWSER_AUTH_CONTAINER ||
        DEFAULT_CONTAINER_NAME
    ).trim().toLowerCase();
    if (!/^(?!.*--)[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(containerName)) {
        throw new BrowserSessionStoreError('browser_auth_store_configuration_invalid');
    }
    try {
        const { BlobServiceClient } = require('@azure/storage-blob');
        let service = options.serviceClient;
        if (!service) {
            const { ManagedIdentityCredential } = require('@azure/identity');
            const managedIdentityClientId = String(
                options.managedIdentityClientId || env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID || ''
            ).trim();
            const credential = options.credential || (
                managedIdentityClientId
                    ? new ManagedIdentityCredential({ clientId: managedIdentityClientId })
                    : new ManagedIdentityCredential()
            );
            service = new BlobServiceClient(
                `https://${accountName}.blob.core.windows.net`,
                credential
            );
        }
        return service.getContainerClient(containerName);
    } catch (error) {
        throw storeError(error);
    }
}

function validateOpaqueId(id) {
    const value = String(id || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
        throw new BrowserSessionStoreError('browser_auth_store_identifier_invalid');
    }
    try {
        if (Buffer.from(value, 'base64url').length !== 32 || Buffer.from(Buffer.from(value, 'base64url')).toString('base64url') !== value) {
            throw new Error('invalid identifier');
        }
    } catch (error) {
        throw new BrowserSessionStoreError('browser_auth_store_identifier_invalid');
    }
    return value;
}

function parseRecord(buffer) {
    try {
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_RECORD_BYTES) {
            throw new Error('invalid record size');
        }
        const value = JSON.parse(buffer.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('invalid record');
        }
        return value;
    } catch (error) {
        throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
    }
}

async function streamToBuffer(stream) {
    const chunks = [];
    let size = 0;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
    }
    for await (const chunk of stream) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > MAX_RECORD_BYTES) {
            throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

function isMissingOrContended(error) {
    return Boolean(error && [404, 409, 412].includes(Number(error.statusCode)));
}

function storeError(error) {
    if (error instanceof BrowserSessionStoreError) return error;
    return new BrowserSessionStoreError();
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function transactionStateMatches(record, expectedState) {
    const stored = Buffer.from(String(record && record.state || ''), 'utf8');
    const returned = Buffer.from(String(expectedState || ''), 'utf8');
    return stored.length > 0 && stored.length === returned.length && crypto.timingSafeEqual(stored, returned);
}

function validateConsumptionPurpose(purpose) {
    if (purpose !== undefined && purpose !== 'retained_read') {
        throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
    }
}

function validateCancellationBinding(binding) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).length !== 2 ||
        !Object.hasOwn(binding, 'customerTransport') || !Object.hasOwn(binding, 'customerProviderKey') ||
        binding.customerTransport !== 'external' ||
        typeof binding.customerProviderKey !== 'string' || !/^[0-9a-f]{64}$/.test(binding.customerProviderKey)) {
        throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
    }
}

function transactionRealmMatches(record, binding) {
    return Boolean(record && record.v === 1 && record.kind === 'oidc_transaction' &&
        record.customerPurpose === undefined &&
        record.customerTransport === binding.customerTransport &&
        record.customerProviderKey === binding.customerProviderKey);
}

const FENCE_KIND = 'oidc_transaction_fence';

function validateSealedSession(sealed) {
    if (typeof sealed !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/.test(sealed)) {
        throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
    }
}

function fenceRecord(binding, state, sealed) {
    return { v: 1, kind: FENCE_KIND, state, customerTransport: binding.customerTransport,
        customerProviderKey: binding.customerProviderKey, ...(state === 'settled' ? { sealed } : {}) };
}

// false: another realm's fence; null: revoked, so no callback can still issue
// a session; { sealed }: a callback already issued the sealed session.
function fenceOutcome(record, binding) {
    if (!record || record.v !== 1 || record.kind !== FENCE_KIND ||
        record.customerTransport !== binding.customerTransport ||
        record.customerProviderKey !== binding.customerProviderKey) return false;
    if (record.state === 'revoked' && !Object.hasOwn(record, 'sealed')) return null;
    if (record.state === 'settled') {
        validateSealedSession(record.sealed);
        return { sealed: record.sealed };
    }
    throw new BrowserSessionStoreError('browser_auth_store_record_invalid');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = {
    AzureBlobBrowserSessionStore,
    BrowserSessionStoreError,
    MemoryBrowserSessionStore,
    createBrowserSessionStore,
    validateOpaqueId
};
