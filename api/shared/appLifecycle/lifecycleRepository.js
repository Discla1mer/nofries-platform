const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
    LIFECYCLE_SCHEMA_VERSION,
    LifecycleRepositoryError,
    assertAccess,
    assertRevision,
    createEmptyState,
    finishMutation,
    normaliseState
} = require('./lifecycleState');

const LOCAL_MUTATION_QUEUES = new Map();
const PROOF_PERSISTENCE_RECEIPT_PREFIX = 'lifecycle/verification/monthly-proof/';
const PROOF_PERSISTENCE_RECEIPT_LIMIT = 32;

function createLifecycleRepository(options = {}) {
    const env = options.env || process.env;
    const lifecycleProvider = String(
        options.provider ||
        env.NOFRIES_LIFECYCLE_STORAGE_PROVIDER ||
        ''
    ).trim().toLowerCase();
    const sharedProvider = String(env.NOFRIES_STORAGE_PROVIDER || '').trim().toLowerCase();
    const provider = lifecycleProvider || (sharedProvider === 'postgres' ? 'local' : sharedProvider) || 'local';

    if (provider === 'azure') {
        return new AzureLifecycleRepository(Object.assign({}, options, { env }));
    }
    if (provider === 'postgres') {
        const { PostgresLifecycleRepository } = require('./postgresLifecycleRepository');
        return new PostgresLifecycleRepository(Object.assign({}, options, { env }));
    }
    if (provider !== 'local') {
        throw new LifecycleRepositoryError(500, 'The lifecycle storage provider is not supported', {
            code: 'lifecycle_storage_provider_invalid'
        });
    }
    return new LocalLifecycleRepository(options);
}

class LocalLifecycleRepository {
    constructor(options = {}) {
        if (!options.dataDir) {
            throw new LifecycleRepositoryError(500, 'The local lifecycle data directory is required', {
                code: 'lifecycle_data_dir_required'
            });
        }
        this.lifecycleDir = path.join(options.dataDir, 'lifecycle-tenants');
        fs.mkdirSync(this.lifecycleDir, { recursive: true });
    }

    async read(access) {
        assertAccess(access);
        const state = readJson(this.filePath(access)) || createEmptyState(access);
        return normaliseState(state, access);
    }

    async mutate(access, options = {}, mutator) {
        assertAccess(access);
        return serialiseLocalMutation(access.tenant.key, async () => {
            const state = await this.read(access);
            assertRevision(state, options.expectedRevision);
            const result = await mutator(state);
            finishMutation(state, access, options);
            writeJsonAtomically(this.filePath(access), state);
            return { state, result };
        });
    }

    filePath(access) {
        return path.join(this.lifecycleDir, `${access.tenant.key}.json`);
    }

    async verifyProofPersistence() {
        throw new LifecycleRepositoryError(503, 'Monthly Proof persistence verification requires Azure lifecycle storage', {
            code: 'proof_persistence_requires_azure'
        });
    }
}

class AzureLifecycleRepository {
    constructor(options = {}) {
        this.settings = resolveAzureSettings(options.env || process.env);
        this.container = null;
        this.ready = null;
    }

    async read(access) {
        return (await this.readWithMetadata(access)).state;
    }

    async mutate(access, options = {}, mutator) {
        const loaded = await this.readWithMetadata(access);
        assertRevision(loaded.state, options.expectedRevision);
        const result = await mutator(loaded.state);
        finishMutation(loaded.state, access, options);

        const uploadOptions = {
            blobHTTPHeaders: { blobContentType: 'application/json' }
        };
        if (loaded.etag) {
            uploadOptions.conditions = { ifMatch: loaded.etag };
        } else {
            uploadOptions.conditions = { ifNoneMatch: '*' };
        }

        try {
            await this.getBlob(access).uploadData(
                Buffer.from(JSON.stringify(loaded.state, null, 2), 'utf8'),
                uploadOptions
            );
        } catch (error) {
            if (error.statusCode === 409 || error.statusCode === 412) {
                throw new LifecycleRepositoryError(
                    409,
                    'Lifecycle data changed while you were working. Reload and try again.',
                    { code: 'revision_conflict', currentRevision: loaded.state.revision }
                );
            }
            throw error;
        }
        return { state: loaded.state, result };
    }

    async readWithMetadata(access) {
        assertAccess(access);
        await this.init();
        const blob = this.getBlob(access);
        try {
            const download = await blob.download();
            const chunks = [];
            for await (const chunk of download.readableStreamBody) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return {
                state: normaliseState(JSON.parse(Buffer.concat(chunks).toString('utf8')), access),
                etag: download.etag || null
            };
        } catch (error) {
            if (error.statusCode !== 404) {
                throw error;
            }
            return { state: createEmptyState(access), etag: null };
        }
    }

    async init() {
        if (!this.ready) {
            this.ready = this.initClient();
        }
        return this.ready;
    }

    async initClient() {
        const { BlobServiceClient } = require('@azure/storage-blob');
        let service;
        if (this.settings.connectionString) {
            service = BlobServiceClient.fromConnectionString(this.settings.connectionString);
        } else {
            const { DefaultAzureCredential } = require('@azure/identity');
            service = new BlobServiceClient(this.settings.blobEndpoint, new DefaultAzureCredential());
        }
        this.container = service.getContainerClient(this.settings.containerName);
        await this.container.createIfNotExists();
    }

    getBlob(access) {
        return this.container.getBlockBlobClient(`lifecycle/tenants/${access.tenant.key}/workspace.json`);
    }

    async verifyProofPersistence(options = {}) {
        const operationId = String(options.operationId || '').trim();
        const releaseSha = String(options.releaseSha || '').trim().toLowerCase();
        if (!operationId || operationId.length > 500 || !/^[a-f0-9]{40}$/.test(releaseSha)) {
            throw new LifecycleRepositoryError(500, 'Monthly Proof persistence verification identity is invalid', {
                code: 'proof_persistence_identity_invalid'
            });
        }
        await this.init();
        const operationSha256 = sha256(operationId);
        const payload = {
            schemaVersion: 1,
            kindSha256: sha256('nofries-monthly-proof-persistence-canary-v1'),
            operationSha256,
            releaseSha256: sha256(releaseSha)
        };
        const payloadText = JSON.stringify(payload);
        const payloadSha256 = sha256(payloadText);
        const blob = this.container.getBlockBlobClient(
            `${PROOF_PERSISTENCE_RECEIPT_PREFIX}${operationSha256}.json`
        );
        try {
            await blob.uploadData(Buffer.from(payloadText, 'utf8'), {
                blobHTTPHeaders: { blobContentType: 'application/json' },
                conditions: { ifNoneMatch: '*' }
            });
        } catch (error) {
            if (!isConditionalConflict(error)) throw error;
        }

        const firstRead = await downloadBlobText(blob);
        if (firstRead.text !== payloadText) {
            throw new LifecycleRepositoryError(503, 'Monthly Proof persistence canary content did not match', {
                code: 'proof_persistence_read_mismatch'
            });
        }

        let duplicateRejected = false;
        try {
            await blob.uploadData(Buffer.from(payloadText, 'utf8'), {
                blobHTTPHeaders: { blobContentType: 'application/json' },
                conditions: { ifNoneMatch: '*' }
            });
        } catch (error) {
            if (!isConditionalConflict(error)) throw error;
            duplicateRejected = true;
        }
        if (!duplicateRejected) {
            throw new LifecycleRepositoryError(503, 'Monthly Proof persistence canary accepted a duplicate create', {
                code: 'proof_persistence_duplicate_not_rejected'
            });
        }

        const replayRead = await downloadBlobText(blob);
        if (replayRead.text !== payloadText || replayRead.etag !== firstRead.etag) {
            throw new LifecycleRepositoryError(503, 'Monthly Proof persistence canary replay was not stable', {
                code: 'proof_persistence_replay_mismatch'
            });
        }
        await pruneProofPersistenceReceipts(
            this.container,
            `${PROOF_PERSISTENCE_RECEIPT_PREFIX}${operationSha256}.json`,
            PROOF_PERSISTENCE_RECEIPT_LIMIT
        );
        const receiptSha256 = sha256(JSON.stringify({
            schemaVersion: 1,
            operationSha256,
            payloadSha256,
            duplicateRejected: true,
            replayMatched: true,
            retainedContentAddressedReceipt: true,
            retentionLimit: PROOF_PERSISTENCE_RECEIPT_LIMIT
        }));
        return {
            verified: true,
            receiptSha256,
            operationSha256,
            payloadSha256,
            retained: true,
            retentionLimit: PROOF_PERSISTENCE_RECEIPT_LIMIT
        };
    }
}

async function pruneProofPersistenceReceipts(container, protectedName, limit) {
    if (!container || typeof container.listBlobsFlat !== 'function') {
        throw new LifecycleRepositoryError(503, 'Monthly Proof persistence receipt retention is unavailable', {
            code: 'proof_persistence_retention_unavailable'
        });
    }
    const receipts = [];
    for await (const item of container.listBlobsFlat({ prefix: PROOF_PERSISTENCE_RECEIPT_PREFIX })) {
        if (!item || !/^lifecycle\/verification\/monthly-proof\/[a-f0-9]{64}\.json$/.test(String(item.name || ''))) continue;
        const properties = item.properties || {};
        const createdAt = Date.parse(properties.createdOn || properties.lastModified || '') || 0;
        receipts.push({ name: item.name, createdAt });
    }
    receipts.sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
    const removable = receipts.filter((item) => item.name !== protectedName);
    const deleteCount = Math.max(0, receipts.length - limit);
    for (const item of removable.slice(0, deleteCount)) {
        const oldReceipt = container.getBlockBlobClient(item.name);
        if (!oldReceipt || typeof oldReceipt.deleteIfExists !== 'function') {
            throw new LifecycleRepositoryError(503, 'Monthly Proof persistence receipt retention is unavailable', {
                code: 'proof_persistence_retention_unavailable'
            });
        }
        await oldReceipt.deleteIfExists();
    }
}

async function serialiseLocalMutation(key, work) {
    const previous = LOCAL_MUTATION_QUEUES.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(work);
    LOCAL_MUTATION_QUEUES.set(key, queued);
    try {
        return await queued;
    } finally {
        if (LOCAL_MUTATION_QUEUES.get(key) === queued) LOCAL_MUTATION_QUEUES.delete(key);
    }
}

function resolveAzureSettings(env) {
    const connectionString = String(env.AZURE_STORAGE_CONNECTION_STRING || '').trim();
    const accountName = String(env.AZURE_STORAGE_ACCOUNT_NAME || '').trim();
    if (!connectionString && !accountName) {
        throw new LifecycleRepositoryError(500, 'Azure lifecycle storage is not configured', {
            code: 'lifecycle_storage_not_configured'
        });
    }
    return {
        connectionString,
        blobEndpoint: accountName ? `https://${accountName}.blob.core.windows.net` : '',
        containerName: String(
            env.NOFRIES_LIFECYCLE_CONTAINER ||
            env.NOFRIES_AZURE_CONTAINER ||
            'nofries-workspace'
        ).trim()
    };
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function writeJsonAtomically(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
    const tempPath = `${filePath}.${process.pid}.${suffix}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

async function downloadBlobText(blob) {
    const download = await blob.download();
    const chunks = [];
    for await (const chunk of download.readableStreamBody) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return {
        text: Buffer.concat(chunks).toString('utf8'),
        etag: download.etag || ''
    };
}

function isConditionalConflict(error) {
    return error && (error.statusCode === 409 || error.statusCode === 412);
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
    LIFECYCLE_SCHEMA_VERSION,
    PROOF_PERSISTENCE_RECEIPT_LIMIT,
    LifecycleRepositoryError,
    createEmptyState,
    createLifecycleRepository,
    normaliseState
};
