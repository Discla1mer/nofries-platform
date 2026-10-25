const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    createNoFriesCatalogueState,
    upgradeNoFriesCatalogueState
} = require('./nofriesCatalogue');
const { normaliseProposalApprovalState } = require('./proposalApprovalSeal');

const SALES_SCHEMA_VERSION = 4;
const DEFAULT_AZURE_STORAGE_TIMEOUT_MS = 10000;
const MAX_OPERATION_PAYLOAD_BYTES = 32 * 1024;
const MAX_OPERATION_PAYLOAD_DEPTH = 6;
const MAX_OPERATION_PAYLOAD_KEYS = 50;
const MAX_OPERATION_PAYLOAD_ITEMS = 100;
const MAX_OPERATION_PAYLOAD_STRING = 4000;
const OPERATION_SCHEMA_VERSION = 1;
const OPERATION_STATUSES = new Set([
    'pending',
    'claimed',
    'retry',
    'completed',
    'cancelled',
    'dead_letter'
]);
const TERMINAL_OPERATION_STATUSES = new Set(['completed', 'cancelled']);
const SENSITIVE_OPERATION_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|connection[_-]?string)/i;
const SENSITIVE_OPERATION_VALUE = /(?:^\s*bearer\s+|accountkey\s*=|sharedaccesssignature\s+|[?&](?:sig|se|sp|sv|spr)=|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[a-z0-9_-]{16,})/i;
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LOCAL_MUTATION_QUEUES = new Map();
const STORED_OPERATION_FIELDS = new Set([
    'schemaVersion',
    'operationId',
    'idempotencyKey',
    'kind',
    'destination',
    'aggregateType',
    'aggregateId',
    'payloadHash',
    'payload',
    'correlationId',
    'causationId',
    'status',
    'attemptCount',
    'nextAttemptAt',
    'leaseOwner',
    'leaseUntil',
    'createdAt',
    'updatedAt',
    'lastAttemptAt',
    'completedAt',
    'lastErrorCode',
    'resultReference'
]);

function createSalesWorkspaceRepository(options = {}) {
    const env = options.env || process.env;
    const provider = String(options.provider || env.NOFRIES_STORAGE_PROVIDER || 'local').trim().toLowerCase();
    if (provider === 'azure') {
        return new AzureSalesWorkspaceRepository(Object.assign({}, options, { env }));
    }
    return new LocalSalesWorkspaceRepository(options);
}

class LocalSalesWorkspaceRepository {
    constructor(options) {
        this.dataDir = options.dataDir;
        this.salesDir = path.join(this.dataDir, 'sales-tenants');
        fs.mkdirSync(this.salesDir, { recursive: true });
    }

    async read(access) {
        const filePath = this.filePath(access);
        const state = readJson(filePath) || createEmptyState(access);
        return normaliseState(state, access);
    }

    async mutate(access, options, mutator) {
        const filePath = this.filePath(access);
        return serialiseLocalMutation(filePath, async () => {
            const state = await this.read(access);
            assertRevision(state, options && options.expectedRevision);
            const result = await mutator(state);
            finishMutation(state, access, options);
            writeJsonAtomically(filePath, state);
            return { state, result };
        });
    }

    filePath(access) {
        return path.join(this.salesDir, `${access.tenant.key}.json`);
    }
}

class AzureSalesWorkspaceRepository {
    constructor(options = {}) {
        const env = options.env || process.env;
        const settings = options.azureSettings || resolveAzureSettings(env);
        this.dataDir = options.dataDir;
        this.connectionString = settings.connectionString;
        this.accountName = settings.accountName;
        this.blobEndpoint = settings.blobEndpoint;
        this.containerName = settings.containerName;
        this.injectedContainer = options.containerClient || null;
        this.injectedService = options.serviceClient || null;
        this.storageTimeoutMs = resolveStorageTimeoutMs(options.storageTimeoutMs, env);
        this.abortControllerFactory = options.abortControllerFactory || defaultAbortControllerFactory;
        this.setTimer = options.setTimeout || setTimeout;
        this.clearTimer = options.clearTimeout || clearTimeout;
        this.container = null;
        this.ready = null;
    }

    async read(access) {
        const loaded = await this.readWithMetadata(access);
        return loaded.state;
    }

    async mutate(access, options, mutator) {
        const loaded = await this.readWithMetadata(access);
        assertRevision(loaded.state, options && options.expectedRevision);
        const result = await mutator(loaded.state);
        finishMutation(loaded.state, access, options);

        const body = Buffer.from(JSON.stringify(loaded.state, null, 2), 'utf8');
        const uploadOptions = {
            blobHTTPHeaders: { blobContentType: 'application/json' }
        };
        if (loaded.etag) {
            uploadOptions.conditions = { ifMatch: loaded.etag };
        } else {
            uploadOptions.conditions = { ifNoneMatch: '*' };
        }

        try {
            await this.withStorageDeadline('upload', (abortSignal) => {
                const boundedUploadOptions = withAbortSignal(uploadOptions, abortSignal);
                return this.getBlob(access).uploadData(body, boundedUploadOptions);
            });
        } catch (error) {
            if (error.statusCode === 409 || error.statusCode === 412) {
                throw new SalesRepositoryError(409, 'This workspace changed while you were editing it. Reload and try again.', {
                    code: 'revision_conflict'
                });
            }
            throw error;
        }
        return { state: loaded.state, result };
    }

    async readWithMetadata(access) {
        await this.init();
        const blob = this.getBlob(access);
        try {
            return await this.withStorageDeadline('download', async (abortSignal) => {
                const download = await blob.download(0, undefined, withAbortSignal({}, abortSignal));
                const chunks = [];
                for await (const chunk of download.readableStreamBody) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const state = normaliseState(JSON.parse(Buffer.concat(chunks).toString('utf8')), access);
                return { state, etag: download.etag || null };
            });
        } catch (error) {
            if (error.statusCode !== 404) {
                throw error;
            }
            return { state: createEmptyState(access), etag: null };
        }
    }

    async init() {
        if (!this.ready) {
            const pending = this.withStorageDeadline('container_init', (abortSignal) => (
                this.initClient(abortSignal)
            ));
            this.ready = pending;
            pending.catch(() => {
                if (this.ready === pending) {
                    this.ready = null;
                    this.container = null;
                }
            });
        }
        return this.ready;
    }

    async initClient(abortSignal) {
        let container = this.injectedContainer;
        if (!container) {
            let service = this.injectedService;
            if (!service) {
                const { BlobServiceClient } = require('@azure/storage-blob');
                if (this.connectionString) {
                    service = BlobServiceClient.fromConnectionString(this.connectionString);
                } else {
                    const { DefaultAzureCredential } = require('@azure/identity');
                    service = new BlobServiceClient(this.blobEndpoint, new DefaultAzureCredential());
                }
            }
            container = service.getContainerClient(this.containerName);
        }
        this.container = container;
        await container.createIfNotExists(withAbortSignal({}, abortSignal));
    }

    getBlob(access) {
        return this.container.getBlockBlobClient(`sales/tenants/${access.tenant.key}/workspace.json`);
    }

    async withStorageDeadline(operation, work) {
        let controller = null;
        try {
            controller = this.abortControllerFactory();
        } catch (error) {
            controller = null;
        }
        const abortSignal = controller && controller.signal ? controller.signal : undefined;
        let timer;
        const deadline = new Promise((resolve, reject) => {
            timer = this.setTimer(() => {
                try {
                    if (controller && typeof controller.abort === 'function') {
                        controller.abort();
                    }
                } catch (error) {
                    // The deadline remains authoritative even if an injected signal cannot abort.
                }
                reject(createStorageTimeoutError(operation, this.storageTimeoutMs));
            }, this.storageTimeoutMs);
        });

        try {
            return await Promise.race([
                Promise.resolve().then(() => work(abortSignal)),
                deadline
            ]);
        } finally {
            if (timer !== undefined && timer !== null) {
                this.clearTimer(timer);
            }
        }
    }
}

class SalesRepositoryError extends Error {
    constructor(statusCode, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.details = details || {};
    }
}

function createEmptyState(access) {
    const now = new Date().toISOString();
    return {
        schemaVersion: SALES_SCHEMA_VERSION,
        revision: 0,
        tenant: {
            id: access.tenant.id,
            key: access.tenant.key,
            name: access.tenant.name,
            slug: access.tenant.slug,
            createdAt: now,
            updatedAt: now
        },
        users: {},
        customers: [],
        assessments: [],
        catalogue: createNoFriesCatalogueState(),
        proposals: [],
        dynamicsHandoffs: [],
        operationsById: {},
        operationIdByIdempotencyKey: {},
        customerDeletionReceiptsById: {},
        repairItemsById: {},
        audit: []
    };
}

function normaliseState(value, access) {
    const empty = createEmptyState(access);
    const state = migrateSalesState(value && typeof value === 'object' ? value : {});
    state.revision = Number(state.revision || 0);
    state.tenant = Object.assign(empty.tenant, state.tenant || {}, {
        id: access.tenant.id,
        key: access.tenant.key,
        name: access.tenant.name,
        slug: access.tenant.slug
    });
    state.users = state.users && typeof state.users === 'object' ? state.users : {};
    state.customers = Array.isArray(state.customers) ? state.customers : [];
    state.assessments = Array.isArray(state.assessments) ? state.assessments : [];
    const existingCatalogue = state.catalogue && typeof state.catalogue === 'object' ? state.catalogue : null;
    const hasCatalogueData = Boolean(existingCatalogue && (
        existingCatalogue.publishedVersionId ||
        (Array.isArray(existingCatalogue.versions) && existingCatalogue.versions.length)
    ));
    const isLegacyCatalogue = Boolean(existingCatalogue && (
        String(existingCatalogue.publishedVersionId || '').startsWith('catalogue_kordia_') ||
        (Array.isArray(existingCatalogue.versions) && existingCatalogue.versions.some((version) =>
            String(version && version.id || '').startsWith('catalogue_kordia_') ||
            /\bkordia\b/i.test(String(version && version.label || ''))
        ))
    ));
    state.catalogue = hasCatalogueData && !isLegacyCatalogue
        ? Object.assign({ publishedVersionId: null, versions: [] }, existingCatalogue)
        : createNoFriesCatalogueState();
    state.catalogue = upgradeNoFriesCatalogueState(state.catalogue);
    state.catalogue.versions = Array.isArray(state.catalogue.versions) ? state.catalogue.versions : [];
    state.proposals = Array.isArray(state.proposals) ? state.proposals : [];
    assignProposalVersionNumbers(state.proposals);
    state.proposals.forEach(normaliseProposalApprovalState);
    state.dynamicsHandoffs = Array.isArray(state.dynamicsHandoffs) ? state.dynamicsHandoffs : [];
    state.operationsById = normaliseOperationsById(state.operationsById);
    state.operationIdByIdempotencyKey = normaliseOperationIndex(
        state.operationIdByIdempotencyKey,
        state.operationsById
    );
    state.customerDeletionReceiptsById = normaliseRecordMap(
        state.customerDeletionReceiptsById,
        'customer deletion receipt'
    );
    state.repairItemsById = normaliseRecordMap(state.repairItemsById, 'repair item');
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    upsertUser(state, access);
    return state;
}

function migrateSalesState(value) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawVersion = state.schemaVersion == null || state.schemaVersion === ''
        ? 1
        : Number(state.schemaVersion);
    if (!Number.isInteger(rawVersion) || rawVersion < 1) {
        throw new SalesRepositoryError(500, 'The sales workspace schema version is invalid', {
            code: 'invalid_schema_version',
            schemaVersion: state.schemaVersion
        });
    }
    if (rawVersion > SALES_SCHEMA_VERSION) {
        throw new SalesRepositoryError(500, 'The sales workspace was written by a newer application version', {
            code: 'unsupported_schema_version',
            schemaVersion: rawVersion,
            supportedSchemaVersion: SALES_SCHEMA_VERSION
        });
    }

    let version = rawVersion;
    while (version < SALES_SCHEMA_VERSION) {
        if (version === 1) {
            migrateSalesStateV1ToV2(state);
            version = 2;
            continue;
        }
        if (version === 2) {
            migrateSalesStateV2ToV3(state);
            version = 3;
            continue;
        }
        if (version === 3) {
            migrateSalesStateV3ToV4(state);
            version = 4;
            continue;
        }
        throw new SalesRepositoryError(500, 'The sales workspace schema cannot be migrated', {
            code: 'schema_migration_missing',
            schemaVersion: version,
            supportedSchemaVersion: SALES_SCHEMA_VERSION
        });
    }
    state.schemaVersion = SALES_SCHEMA_VERSION;
    return state;
}

function migrateSalesStateV1ToV2(state) {
    state.operationsById = state.operationsById && typeof state.operationsById === 'object'
        ? state.operationsById
        : {};
    state.operationIdByIdempotencyKey = state.operationIdByIdempotencyKey && typeof state.operationIdByIdempotencyKey === 'object'
        ? state.operationIdByIdempotencyKey
        : {};
    state.repairItemsById = state.repairItemsById && typeof state.repairItemsById === 'object'
        ? state.repairItemsById
        : {};
    state.schemaVersion = 2;
}

function migrateSalesStateV2ToV3(state) {
    state.proposals = Array.isArray(state.proposals) ? state.proposals : [];
    assignProposalVersionNumbers(state.proposals);
    state.proposals.forEach(normaliseProposalApprovalState);
    state.schemaVersion = 3;
}

function migrateSalesStateV3ToV4(state) {
    state.customerDeletionReceiptsById = state.customerDeletionReceiptsById &&
        typeof state.customerDeletionReceiptsById === 'object' &&
        !Array.isArray(state.customerDeletionReceiptsById)
        ? state.customerDeletionReceiptsById
        : {};
    state.schemaVersion = 4;
}

function assignProposalVersionNumbers(proposals) {
    const usedByAssessment = new Map();
    const unresolved = [];
    proposals.forEach((proposal, index) => {
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return;
        const key = String(proposal.assessmentId || `unlinked:${proposal.id || index}`);
        const used = usedByAssessment.get(key) || new Set();
        usedByAssessment.set(key, used);
        const candidate = Number(proposal.versionNumber);
        if (Number.isInteger(candidate) && candidate > 0 && !used.has(candidate)) {
            proposal.versionNumber = candidate;
            used.add(candidate);
        } else {
            unresolved.push({ proposal, used });
        }
    });
    unresolved.forEach(({ proposal, used }) => {
        let versionNumber = 1;
        while (used.has(versionNumber)) versionNumber += 1;
        proposal.versionNumber = versionNumber;
        used.add(versionNumber);
    });
}

function enqueueDurableOperation(state, input = {}, options = {}) {
    assertDurableOperationState(state);
    const idempotencyKey = requiredOperationText(input.idempotencyKey, 'idempotency key', 240);
    const kind = requiredOperationText(input.kind, 'operation kind', 120);
    const destination = requiredOperationText(input.destination, 'operation destination', 120);
    const aggregateType = requiredOperationText(input.aggregateType, 'aggregate type', 80);
    const aggregateId = requiredOperationText(input.aggregateId, 'aggregate ID', 180);
    const payload = normaliseOperationPayload(input.payload == null ? {} : input.payload);
    const semanticPayload = {
        kind,
        destination,
        aggregateType,
        aggregateId,
        payload
    };
    const payloadHash = hashOperationPayload(semanticPayload);
    const indexedOperationId = ownValue(state.operationIdByIdempotencyKey, idempotencyKey);
    if (indexedOperationId) {
        const existing = ownValue(state.operationsById, indexedOperationId);
        if (!existing) {
            throw operationStateError('The durable operation index is inconsistent', 'operation_index_corrupt', {
                idempotencyKey,
                operationId: indexedOperationId
            });
        }
        if (existing.payloadHash !== payloadHash) {
            throw new SalesRepositoryError(409, 'That idempotency key is already assigned to different operation content', {
                code: 'operation_idempotency_conflict',
                idempotencyKey,
                operationId: existing.operationId
            });
        }
        return { operation: cloneJson(existing), created: false };
    }

    const makeId = typeof options.createId === 'function' ? options.createId : createId;
    const operationId = requiredOperationText(makeId('operation'), 'operation ID', 180);
    if (ownValue(state.operationsById, operationId)) {
        throw operationStateError('The generated durable operation ID already exists', 'operation_id_conflict', {
            operationId
        });
    }
    const at = operationTimestamp(options.now);
    const operation = {
        schemaVersion: OPERATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey,
        kind,
        destination,
        aggregateType,
        aggregateId,
        payloadHash,
        payload,
        correlationId: optionalOperationText(input.correlationId, 'correlation ID', 180),
        causationId: optionalOperationText(input.causationId, 'causation ID', 180),
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: at,
        leaseOwner: '',
        leaseUntil: '',
        createdAt: at,
        updatedAt: at,
        lastAttemptAt: '',
        completedAt: '',
        lastErrorCode: '',
        resultReference: ''
    };
    state.operationsById[operationId] = operation;
    state.operationIdByIdempotencyKey[idempotencyKey] = operationId;
    return { operation: cloneJson(operation), created: true };
}

function getDurableOperation(state, reference = {}) {
    assertDurableOperationState(state);
    const operation = resolveDurableOperation(state, reference, false);
    return operation ? cloneJson(operation) : null;
}

function updateDurableOperation(state, reference = {}, patch = {}, options = {}) {
    assertDurableOperationState(state);
    const operation = resolveDurableOperation(state, reference, true);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SalesRepositoryError(400, 'A durable operation update is required', {
            code: 'operation_update_required'
        });
    }
    const allowed = new Set([
        'status',
        'attemptCount',
        'nextAttemptAt',
        'leaseOwner',
        'leaseUntil',
        'lastAttemptAt',
        'completedAt',
        'lastErrorCode',
        'resultReference'
    ]);
    const unsupported = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unsupported.length) {
        throw new SalesRepositoryError(400, 'Durable operation immutable fields cannot be changed', {
            code: 'operation_immutable_field',
            fields: unsupported.slice(0, 20)
        });
    }
    if (options.expectedStatus && operation.status !== options.expectedStatus) {
        throw new SalesRepositoryError(409, 'The durable operation status changed before this update', {
            code: 'operation_status_conflict',
            operationId: operation.operationId,
            currentStatus: operation.status
        });
    }

    const nextStatus = Object.prototype.hasOwnProperty.call(patch, 'status')
        ? normaliseOperationStatus(patch.status)
        : operation.status;
    assertOperationStatusTransition(operation.status, nextStatus);
    operation.status = nextStatus;

    if (Object.prototype.hasOwnProperty.call(patch, 'attemptCount')) {
        const attempts = Number(patch.attemptCount);
        if (!Number.isInteger(attempts) || attempts < 0 || attempts > 1000000) {
            throw new SalesRepositoryError(400, 'A valid durable operation attempt count is required', {
                code: 'invalid_operation_attempt_count'
            });
        }
        operation.attemptCount = attempts;
    }
    for (const field of ['nextAttemptAt', 'leaseUntil', 'lastAttemptAt', 'completedAt']) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
            operation[field] = optionalIsoTimestamp(patch[field], field);
        }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'leaseOwner')) {
        operation.leaseOwner = optionalOperationText(patch.leaseOwner, 'lease owner', 180);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastErrorCode')) {
        operation.lastErrorCode = optionalOperationCode(patch.lastErrorCode, 'last error code');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'resultReference')) {
        operation.resultReference = optionalOperationReference(patch.resultReference);
    }
    operation.updatedAt = operationTimestamp(options.now);
    return cloneJson(operation);
}

function assertDurableOperationState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw operationStateError('A sales workspace state is required', 'operation_state_required');
    }
    state.operationsById = normaliseOperationsById(state.operationsById);
    state.operationIdByIdempotencyKey = normaliseOperationIndex(
        state.operationIdByIdempotencyKey,
        state.operationsById
    );
    state.repairItemsById = normaliseRecordMap(state.repairItemsById, 'repair item');
}

function resolveDurableOperation(state, reference, required) {
    const value = reference && typeof reference === 'object' && !Array.isArray(reference)
        ? reference
        : { operationId: reference };
    let operationId = optionalOperationText(value.operationId, 'operation ID', 180);
    const idempotencyKey = optionalOperationText(value.idempotencyKey, 'idempotency key', 240);
    if (!operationId && idempotencyKey) {
        operationId = ownValue(state.operationIdByIdempotencyKey, idempotencyKey) || '';
    }
    const operation = operationId ? ownValue(state.operationsById, operationId) : null;
    if (required && !operation) {
        throw new SalesRepositoryError(404, 'Durable operation not found', {
            code: 'operation_not_found',
            operationId,
            idempotencyKey
        });
    }
    return operation || null;
}

function normaliseOperationsById(value) {
    const source = normaliseRecordMap(value, 'durable operation');
    const result = {};
    for (const [key, rawOperation] of Object.entries(source)) {
        if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
            throw operationStateError('A stored durable operation is invalid', 'invalid_stored_operation', {
                operationId: key
            });
        }
        const operationSchemaVersion = Number(rawOperation.schemaVersion || 1);
        if (!Number.isInteger(operationSchemaVersion) || operationSchemaVersion !== OPERATION_SCHEMA_VERSION) {
            throw operationStateError('A stored durable operation schema version is unsupported', 'unsupported_operation_schema_version', {
                operationId: key,
                schemaVersion: rawOperation.schemaVersion,
                supportedSchemaVersion: OPERATION_SCHEMA_VERSION
            });
        }
        const unsupportedFields = Object.keys(rawOperation).filter((field) => !STORED_OPERATION_FIELDS.has(field));
        if (unsupportedFields.length) {
            throw operationStateError('A stored durable operation contains unsupported fields', 'invalid_stored_operation', {
                operationId: key,
                fields: unsupportedFields.slice(0, 20)
            });
        }
        const operationId = requiredStoredText(rawOperation.operationId || key, 'operation ID', 180);
        if (operationId !== key) {
            throw operationStateError('A stored durable operation ID does not match its record key', 'operation_id_mismatch', {
                operationId,
                recordKey: key
            });
        }
        const operation = Object.assign({}, rawOperation, {
            schemaVersion: operationSchemaVersion,
            operationId,
            idempotencyKey: requiredStoredText(rawOperation.idempotencyKey, 'idempotency key', 240),
            kind: requiredStoredText(rawOperation.kind, 'operation kind', 120),
            destination: requiredStoredText(rawOperation.destination, 'operation destination', 120),
            aggregateType: requiredStoredText(rawOperation.aggregateType, 'aggregate type', 80),
            aggregateId: requiredStoredText(rawOperation.aggregateId, 'aggregate ID', 180),
            payload: normaliseOperationPayload(rawOperation.payload == null ? {} : rawOperation.payload),
            status: normaliseStoredOperationStatus(rawOperation.status),
            attemptCount: normaliseStoredAttemptCount(rawOperation.attemptCount),
            correlationId: optionalStoredText(rawOperation.correlationId, 'correlation ID', 180),
            causationId: optionalStoredText(rawOperation.causationId, 'causation ID', 180),
            leaseOwner: optionalStoredText(rawOperation.leaseOwner, 'lease owner', 180),
            lastErrorCode: optionalStoredCode(rawOperation.lastErrorCode, 'last error code'),
            resultReference: optionalStoredReference(rawOperation.resultReference),
            nextAttemptAt: optionalStoredTimestamp(rawOperation.nextAttemptAt, 'nextAttemptAt'),
            leaseUntil: optionalStoredTimestamp(rawOperation.leaseUntil, 'leaseUntil'),
            createdAt: requiredStoredTimestamp(rawOperation.createdAt, 'createdAt'),
            updatedAt: requiredStoredTimestamp(rawOperation.updatedAt || rawOperation.createdAt, 'updatedAt'),
            lastAttemptAt: optionalStoredTimestamp(rawOperation.lastAttemptAt, 'lastAttemptAt'),
            completedAt: optionalStoredTimestamp(rawOperation.completedAt, 'completedAt')
        });
        const semanticPayload = {
            kind: operation.kind,
            destination: operation.destination,
            aggregateType: operation.aggregateType,
            aggregateId: operation.aggregateId,
            payload: operation.payload
        };
        const expectedHash = hashOperationPayload(semanticPayload);
        if (rawOperation.payloadHash && rawOperation.payloadHash !== expectedHash) {
            throw operationStateError('A stored durable operation payload hash does not match its content', 'operation_payload_hash_mismatch', {
                operationId
            });
        }
        operation.payloadHash = expectedHash;
        result[operationId] = operation;
    }
    return result;
}

function normaliseOperationIndex(value, operationsById) {
    const source = normaliseRecordMap(value, 'durable operation index');
    const result = {};
    for (const [idempotencyKey, operationIdValue] of Object.entries(source)) {
        const safeKey = requiredStoredText(idempotencyKey, 'idempotency key', 240);
        const operationId = requiredStoredText(operationIdValue, 'operation ID', 180);
        const operation = ownValue(operationsById, operationId);
        if (!operation || operation.idempotencyKey !== safeKey) {
            throw operationStateError('The durable operation index is inconsistent', 'operation_index_corrupt', {
                idempotencyKey: safeKey,
                operationId
            });
        }
        result[safeKey] = operationId;
    }
    for (const operation of Object.values(operationsById)) {
        const indexed = ownValue(result, operation.idempotencyKey);
        if (indexed && indexed !== operation.operationId) {
            throw operationStateError('Two durable operations use the same idempotency key', 'operation_index_duplicate', {
                idempotencyKey: operation.idempotencyKey
            });
        }
        result[operation.idempotencyKey] = operation.operationId;
    }
    return result;
}

function normaliseRecordMap(value, label) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw operationStateError(`The stored ${label} map is invalid`, 'invalid_operation_record_map');
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (!key || UNSAFE_RECORD_KEYS.has(key)) {
            throw operationStateError(`The stored ${label} record key is invalid`, 'invalid_operation_record_key');
        }
        result[key] = item;
    }
    return result;
}

function normaliseOperationPayload(value, depth = 0, pathParts = [], seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw invalidOperationPayload(pathParts, 'non_finite_number');
        }
        return value;
    }
    if (typeof value === 'string') {
        if (value.length > MAX_OPERATION_PAYLOAD_STRING || SENSITIVE_OPERATION_VALUE.test(value)) {
            throw invalidOperationPayload(pathParts, 'unsafe_string');
        }
        return value;
    }
    if (typeof value !== 'object' || depth >= MAX_OPERATION_PAYLOAD_DEPTH || seen.has(value)) {
        throw invalidOperationPayload(pathParts, 'unsupported_value');
    }
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        if (value.length > MAX_OPERATION_PAYLOAD_ITEMS) {
            seen.delete(value);
            throw invalidOperationPayload(pathParts, 'too_many_items');
        }
        result = value.map((item, index) => normaliseOperationPayload(
            item,
            depth + 1,
            pathParts.concat(String(index)),
            seen
        ));
    } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            seen.delete(value);
            throw invalidOperationPayload(pathParts, 'unsupported_object');
        }
        const entries = Object.entries(value);
        if (entries.length > MAX_OPERATION_PAYLOAD_KEYS) {
            seen.delete(value);
            throw invalidOperationPayload(pathParts, 'too_many_keys');
        }
        result = {};
        for (const [key, item] of entries) {
            if (!key || key.length > 120 || UNSAFE_RECORD_KEYS.has(key) || SENSITIVE_OPERATION_KEY.test(key)) {
                seen.delete(value);
                throw invalidOperationPayload(pathParts.concat(key), 'unsafe_key');
            }
            result[key] = normaliseOperationPayload(item, depth + 1, pathParts.concat(key), seen);
        }
    }
    seen.delete(value);
    if (depth === 0 && Buffer.byteLength(stableStringify(result), 'utf8') > MAX_OPERATION_PAYLOAD_BYTES) {
        throw invalidOperationPayload(pathParts, 'payload_too_large');
    }
    return result;
}

function invalidOperationPayload(pathParts, reason) {
    return new SalesRepositoryError(400, 'Durable operation payload contains unsupported or sensitive content', {
        code: 'invalid_operation_payload',
        path: pathParts.length ? pathParts.join('.') : '',
        reason
    });
}

function hashOperationPayload(value) {
    return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function stableStringify(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function requiredOperationText(value, label, maxLength) {
    const text = optionalOperationText(value, label, maxLength);
    if (!text) {
        throw new SalesRepositoryError(400, `A durable operation ${label} is required`, {
            code: 'invalid_operation_field',
            field: label
        });
    }
    return text;
}

function optionalOperationText(value, label, maxLength) {
    if (value == null || value === '') return '';
    if (
        typeof value !== 'string' ||
        value !== value.trim() ||
        !value ||
        value.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new SalesRepositoryError(400, `A durable operation ${label} is invalid`, {
            code: 'invalid_operation_field',
            field: label
        });
    }
    if (UNSAFE_RECORD_KEYS.has(value) || SENSITIVE_OPERATION_VALUE.test(value)) {
        throw new SalesRepositoryError(400, `A durable operation ${label} is unsafe`, {
            code: 'invalid_operation_field',
            field: label
        });
    }
    return value;
}

function optionalOperationCode(value, label) {
    const text = optionalOperationText(value, label, 120);
    if (text && !/^[a-z0-9][a-z0-9_.:-]*$/i.test(text)) {
        throw new SalesRepositoryError(400, `A durable operation ${label} is invalid`, {
            code: 'invalid_operation_field',
            field: label
        });
    }
    return text;
}

function optionalOperationReference(value) {
    const text = optionalOperationText(value, 'result reference', 500);
    if (text && !/^[a-z0-9][a-z0-9_./:#-]*$/i.test(text)) {
        throw new SalesRepositoryError(400, 'A durable operation result reference is invalid', {
            code: 'invalid_operation_field',
            field: 'result reference'
        });
    }
    return text;
}

function normaliseOperationStatus(value) {
    const status = String(value || '');
    if (!OPERATION_STATUSES.has(status)) {
        throw new SalesRepositoryError(400, 'A valid durable operation status is required', {
            code: 'invalid_operation_status'
        });
    }
    return status;
}

function assertOperationStatusTransition(current, next) {
    if (current === next) return;
    if (TERMINAL_OPERATION_STATUSES.has(current)) {
        throw new SalesRepositoryError(409, 'A terminal durable operation cannot be reopened', {
            code: 'operation_terminal',
            currentStatus: current
        });
    }
    const allowed = {
        pending: new Set(['claimed', 'completed', 'cancelled', 'dead_letter']),
        claimed: new Set(['retry', 'completed', 'cancelled', 'dead_letter']),
        retry: new Set(['claimed', 'completed', 'cancelled', 'dead_letter']),
        dead_letter: new Set(['retry', 'cancelled'])
    };
    if (!allowed[current] || !allowed[current].has(next)) {
        throw new SalesRepositoryError(409, 'That durable operation status transition is not allowed', {
            code: 'invalid_operation_status_transition',
            currentStatus: current,
            requestedStatus: next
        });
    }
}

function optionalIsoTimestamp(value, field) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value !== value.trim() || !Number.isFinite(Date.parse(value))) {
        throw new SalesRepositoryError(400, 'A durable operation timestamp is invalid', {
            code: 'invalid_operation_timestamp',
            field
        });
    }
    return new Date(value).toISOString();
}

function operationTimestamp(value) {
    const candidate = typeof value === 'function' ? value() : value;
    if (candidate == null) return new Date().toISOString();
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate.toISOString();
    return optionalIsoTimestamp(candidate, 'updatedAt');
}

function requiredStoredText(value, label, maxLength) {
    try {
        return requiredOperationText(value, label, maxLength);
    } catch (error) {
        throw operationStateError(`A stored durable operation ${label} is invalid`, 'invalid_stored_operation');
    }
}

function optionalStoredText(value, label, maxLength) {
    try {
        return optionalOperationText(value, label, maxLength);
    } catch (error) {
        throw operationStateError(`A stored durable operation ${label} is invalid`, 'invalid_stored_operation');
    }
}

function optionalStoredCode(value, label) {
    try {
        return optionalOperationCode(value, label);
    } catch (error) {
        throw operationStateError(`A stored durable operation ${label} is invalid`, 'invalid_stored_operation');
    }
}

function optionalStoredReference(value) {
    try {
        return optionalOperationReference(value);
    } catch (error) {
        throw operationStateError('A stored durable operation result reference is invalid', 'invalid_stored_operation');
    }
}

function requiredStoredTimestamp(value, field) {
    const timestamp = optionalStoredTimestamp(value, field);
    if (!timestamp) {
        throw operationStateError('A stored durable operation timestamp is missing', 'invalid_stored_operation', { field });
    }
    return timestamp;
}

function optionalStoredTimestamp(value, field) {
    try {
        return optionalIsoTimestamp(value, field);
    } catch (error) {
        throw operationStateError('A stored durable operation timestamp is invalid', 'invalid_stored_operation', { field });
    }
}

function normaliseStoredOperationStatus(value) {
    try {
        return normaliseOperationStatus(value || 'pending');
    } catch (error) {
        throw operationStateError('A stored durable operation status is invalid', 'invalid_stored_operation');
    }
}

function normaliseStoredAttemptCount(value) {
    const attempts = Number(value || 0);
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 1000000) {
        throw operationStateError('A stored durable operation attempt count is invalid', 'invalid_stored_operation');
    }
    return attempts;
}

function operationStateError(message, code, details = {}) {
    return new SalesRepositoryError(500, message, Object.assign({ code }, details));
}

function ownValue(value, key) {
    return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function finishMutation(state, access, options = {}) {
    const now = new Date().toISOString();
    state.revision = Number(state.revision || 0) + 1;
    state.tenant.updatedAt = now;
    upsertUser(state, access, now);
    const previous = state.audit[state.audit.length - 1];
    const event = {
        id: createId('audit'),
        at: now,
        actorEmail: access.user.email,
        actorRole: access.user.role,
        action: String(options.action || 'workspace.updated').slice(0, 120),
        targetType: String(options.targetType || '').slice(0, 80),
        targetId: String(options.targetId || '').slice(0, 180),
        summary: String(options.summary || '').slice(0, 500),
        correlationId: String(access.requestContext && access.requestContext.correlationId || '').slice(0, 180),
        previousHash: previous && previous.integritySha256 || ''
    };
    event.integritySha256 = crypto.createHash('sha256').update(stableStringify(event), 'utf8').digest('hex');
    state.audit.push(event);
}

function upsertUser(state, access, at = new Date().toISOString()) {
    if (!access || !access.user || !access.user.email) {
        return;
    }
    const existing = state.users[access.user.email] || {
        email: access.user.email,
        createdAt: at
    };
    existing.name = access.user.name || existing.name || '';
    existing.role = access.user.role;
    existing.lastSeenAt = at;
    state.users[access.user.email] = existing;
}

function assertRevision(state, expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') {
        return;
    }
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) {
        throw new SalesRepositoryError(400, 'A valid workspace revision is required', {
            code: 'invalid_revision'
        });
    }
    if (Number(state.revision || 0) !== expected) {
        throw new SalesRepositoryError(409, 'This workspace changed while you were editing it. Reload and try again.', {
            code: 'revision_conflict',
            currentRevision: Number(state.revision || 0)
        });
    }
}

function resolveAzureSettings(env) {
    const connectionString = String(env.AZURE_STORAGE_CONNECTION_STRING || '').trim();
    const accountName = String(env.AZURE_STORAGE_ACCOUNT_NAME || '').trim();
    if (!connectionString && !accountName) {
        throw new SalesRepositoryError(500, 'Azure sales workspace storage is not configured');
    }
    return {
        connectionString,
        accountName,
        blobEndpoint: accountName ? `https://${accountName}.blob.core.windows.net` : '',
        containerName: String(
            env.NOFRIES_SALES_CONTAINER ||
            env.NOFRIES_AZURE_CONTAINER ||
            'nofries-workspace'
        ).trim()
    };
}

function resolveStorageTimeoutMs(configured, env) {
    const value = configured == null || configured === ''
        ? env.NOFRIES_SALES_STORAGE_TIMEOUT_MS || env.NOFRIES_STORAGE_TIMEOUT_MS
        : configured;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULT_AZURE_STORAGE_TIMEOUT_MS;
}

function defaultAbortControllerFactory() {
    return typeof AbortController === 'function' ? new AbortController() : null;
}

function withAbortSignal(options, abortSignal) {
    return abortSignal
        ? Object.assign({}, options, { abortSignal })
        : Object.assign({}, options);
}

function createStorageTimeoutError(operation, timeoutMs) {
    return new SalesRepositoryError(503, 'Workspace storage took too long to respond. Please try again.', {
        code: 'storage_timeout',
        operation,
        timeoutMs
    });
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
    const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
    const tempPath = `${filePath}.${process.pid}.${suffix}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
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

function createId(prefix) {
    if (typeof crypto.randomUUID === 'function') {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

module.exports = {
    AzureSalesWorkspaceRepository,
    DEFAULT_AZURE_STORAGE_TIMEOUT_MS,
    SALES_SCHEMA_VERSION,
    SalesRepositoryError,
    createEmptyState,
    createSalesWorkspaceRepository,
    enqueueDurableOperation,
    getDurableOperation,
    updateDurableOperation
};
