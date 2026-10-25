const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    SERVICE_DESK_SCHEMA_VERSION,
    ServiceDeskRepositoryError,
    assertAccess,
    assertRevision,
    createEmptyState,
    finishMutation,
    normaliseState
} = require('./serviceDeskState');

function createServiceDeskRepository(options = {}) {
    const env = options.env || process.env;
    const provider = String(
        options.provider ||
        env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER ||
        env.NOFRIES_STORAGE_PROVIDER ||
        'local'
    ).trim().toLowerCase();

    if (provider === 'azure') {
        return new AzureServiceDeskRepository(Object.assign({}, options, { env }));
    }
    if (provider === 'postgres') {
        const { PostgresServiceDeskRepository } = require('./postgresServiceDeskRepository');
        return new PostgresServiceDeskRepository(Object.assign({}, options, { env }));
    }
    if (provider !== 'local') {
        throw new ServiceDeskRepositoryError(500, 'The service-desk storage provider is not supported', {
            code: 'service_desk_storage_provider_invalid'
        });
    }
    return new LocalServiceDeskRepository(options);
}

class LocalServiceDeskRepository {
    constructor(options = {}) {
        if (!options.dataDir) {
            throw new ServiceDeskRepositoryError(500, 'The local service-desk data directory is required', {
                code: 'service_desk_data_dir_required'
            });
        }
        this.serviceDeskDir = path.join(options.dataDir, 'service-desk-tenants');
        this.mutationQueues = new Map();
        fs.mkdirSync(this.serviceDeskDir, { recursive: true });
    }

    async read(access) {
        assertAccess(access);
        const state = readJson(this.filePath(access)) || createEmptyState(access);
        return normaliseState(state, access);
    }

    async mutate(access, options = {}, mutator) {
        const filePath = this.filePath(access);
        const previous = this.mutationQueues.get(filePath) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        this.mutationQueues.set(filePath, gate);
        await previous;
        try {
            const state = await this.read(access);
            assertRevision(state, options.expectedRevision);
            const result = await mutator(state);
            finishMutation(state, access, options);
            writeJsonAtomically(filePath, state);
            return { state, result };
        } finally {
            release();
            if (this.mutationQueues.get(filePath) === gate) {
                this.mutationQueues.delete(filePath);
            }
        }
    }

    filePath(access) {
        return path.join(this.serviceDeskDir, `${access.tenant.key}.json`);
    }
}

class AzureServiceDeskRepository {
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
                throw new ServiceDeskRepositoryError(
                    409,
                    'This ticket changed while you were working. Reload and try again.',
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
        return this.container.getBlockBlobClient(
            `service-desk/tenants/${access.tenant.key}/workspace.json`
        );
    }
}

function resolveAzureSettings(env) {
    const connectionString = String(env.AZURE_STORAGE_CONNECTION_STRING || '').trim();
    const accountName = String(env.AZURE_STORAGE_ACCOUNT_NAME || '').trim();
    if (!connectionString && !accountName) {
        throw new ServiceDeskRepositoryError(500, 'Azure service-desk storage is not configured', {
            code: 'service_desk_storage_not_configured'
        });
    }
    return {
        connectionString,
        blobEndpoint: accountName ? `https://${accountName}.blob.core.windows.net` : '',
        containerName: String(
            env.NOFRIES_SERVICE_DESK_CONTAINER ||
            env.NOFRIES_AZURE_CONTAINER ||
            'nofries-workspace'
        ).trim()
    };
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function writeJsonAtomically(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

module.exports = {
    SERVICE_DESK_SCHEMA_VERSION,
    ServiceDeskRepositoryError,
    createEmptyState,
    createServiceDeskRepository
};
