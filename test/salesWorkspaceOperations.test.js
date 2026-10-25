const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    SALES_SCHEMA_VERSION,
    createEmptyState,
    createSalesWorkspaceRepository,
    enqueueDurableOperation,
    getDurableOperation,
    updateDurableOperation
} = require('../api/shared/salesWorkspaceRepository');

function access() {
    return {
        allowed: true,
        tenant: {
            id: 'tenant-id',
            key: 'tenant-key',
            name: 'Test tenant',
            slug: 'test-tenant'
        },
        user: {
            email: 'admin@example.com',
            name: 'Admin User',
            role: 'admin'
        }
    };
}

function operationInput(overrides = {}) {
    return Object.assign({
        idempotencyKey: 'tenant-key:lifecycle-scoping-link:organisation-1',
        kind: 'lifecycle.scoping.link',
        destination: 'lifecycle',
        aggregateType: 'customer',
        aggregateId: 'customer-1',
        correlationId: 'correlation-1',
        payload: {
            assessmentId: 'assessment-1',
            organisationId: 'organisation-1',
            remainingGapCount: 3
        }
    }, overrides);
}

describe('sales workspace durable operations', () => {
    let dataDir;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-sales-operations-'));
    });

    afterEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('migrates schema v1 explicitly and initializes all additive control maps', async () => {
        const repository = createSalesWorkspaceRepository({ provider: 'local', dataDir });
        const salesDir = path.join(dataDir, 'sales-tenants');
        fs.mkdirSync(salesDir, { recursive: true });
        fs.writeFileSync(path.join(salesDir, 'tenant-key.json'), JSON.stringify({
            schemaVersion: 1,
            revision: 4,
            tenant: {},
            users: {},
            customers: [{ id: 'existing-customer' }],
            assessments: [],
            proposals: [],
            dynamicsHandoffs: [],
            audit: []
        }));

        const migrated = await repository.read(access());

        expect(migrated.schemaVersion).toBe(SALES_SCHEMA_VERSION);
        expect(migrated.revision).toBe(4);
        expect(migrated.customers).toEqual([{ id: 'existing-customer' }]);
        expect(migrated.operationsById).toEqual({});
        expect(migrated.operationIdByIdempotencyKey).toEqual({});
        expect(migrated.customerDeletionReceiptsById).toEqual({});
        expect(migrated.repairItemsById).toEqual({});
    });

    test('fails closed when a workspace has an unknown future schema version', async () => {
        const repository = createSalesWorkspaceRepository({ provider: 'local', dataDir });
        const salesDir = path.join(dataDir, 'sales-tenants');
        fs.mkdirSync(salesDir, { recursive: true });
        fs.writeFileSync(path.join(salesDir, 'tenant-key.json'), JSON.stringify({
            schemaVersion: SALES_SCHEMA_VERSION + 1,
            revision: 1
        }));

        await expect(repository.read(access())).rejects.toMatchObject({
            statusCode: 500,
            details: {
                code: 'unsupported_schema_version',
                schemaVersion: SALES_SCHEMA_VERSION + 1,
                supportedSchemaVersion: SALES_SCHEMA_VERSION
            }
        });
    });

    test('commits the source change and durable operation in one workspace mutation', async () => {
        const repository = createSalesWorkspaceRepository({ provider: 'local', dataDir });
        const result = await repository.mutate(access(), { expectedRevision: 0 }, (state) => {
            state.customers.push({ id: 'customer-1', name: 'Example Limited' });
            return enqueueDurableOperation(state, operationInput(), {
                createId: () => 'operation-1',
                now: new Date('2026-08-21T00:00:00.000Z')
            });
        });

        expect(result.result).toMatchObject({
            created: true,
            operation: {
                operationId: 'operation-1',
                status: 'pending',
                attemptCount: 0,
                nextAttemptAt: '2026-08-21T00:00:00.000Z'
            }
        });

        const stored = await repository.read(access());
        expect(stored.customers).toEqual([expect.objectContaining({ id: 'customer-1' })]);
        expect(stored.operationsById['operation-1']).toMatchObject({
            idempotencyKey: operationInput().idempotencyKey,
            aggregateId: 'customer-1'
        });
        expect(stored.operationIdByIdempotencyKey[operationInput().idempotencyKey]).toBe('operation-1');
    });

    test('does not persist either source data or the operation when the workspace mutation fails', async () => {
        const repository = createSalesWorkspaceRepository({ provider: 'local', dataDir });

        await expect(repository.mutate(access(), { expectedRevision: 0 }, (state) => {
            state.customers.push({ id: 'customer-1', name: 'Example Limited' });
            enqueueDurableOperation(state, operationInput(), {
                createId: () => 'operation-1',
                now: '2026-08-21T00:00:00.000Z'
            });
            throw new Error('injected source mutation failure');
        })).rejects.toThrow('injected source mutation failure');

        const stored = await repository.read(access());
        expect(stored.revision).toBe(0);
        expect(stored.customers).toEqual([]);
        expect(stored.operationsById).toEqual({});
        expect(stored.operationIdByIdempotencyKey).toEqual({});
    });

    test('reuses the operation for the same idempotency key and semantic payload', () => {
        const state = createEmptyState(access());
        const first = enqueueDurableOperation(state, operationInput(), {
            createId: () => 'operation-1',
            now: '2026-08-21T00:00:00.000Z'
        });
        const replay = enqueueDurableOperation(state, operationInput({
            payload: {
                remainingGapCount: 3,
                organisationId: 'organisation-1',
                assessmentId: 'assessment-1'
            }
        }), {
            createId: () => 'operation-should-not-be-created',
            now: '2026-08-22T00:00:00.000Z'
        });

        expect(first.created).toBe(true);
        expect(replay.created).toBe(false);
        expect(replay.operation.operationId).toBe('operation-1');
        expect(replay.operation.payloadHash).toBe(first.operation.payloadHash);
        expect(Object.keys(state.operationsById)).toEqual(['operation-1']);
    });

    test('rejects reuse of an idempotency key for different operation content', () => {
        const state = createEmptyState(access());
        enqueueDurableOperation(state, operationInput(), {
            createId: () => 'operation-1',
            now: '2026-08-21T00:00:00.000Z'
        });

        expect(() => enqueueDurableOperation(state, operationInput({
            payload: Object.assign({}, operationInput().payload, { assessmentId: 'assessment-2' })
        }))).toThrow(expect.objectContaining({
            statusCode: 409,
            details: expect.objectContaining({ code: 'operation_idempotency_conflict' })
        }));
    });

    test('reads by ID or idempotency key and returns a defensive copy', () => {
        const state = createEmptyState(access());
        const created = enqueueDurableOperation(state, operationInput(), {
            createId: () => 'operation-1',
            now: '2026-08-21T00:00:00.000Z'
        });

        const byId = getDurableOperation(state, { operationId: 'operation-1' });
        const byKey = getDurableOperation(state, { idempotencyKey: created.operation.idempotencyKey });
        byId.payload.assessmentId = 'changed-outside-state';

        expect(byKey.operationId).toBe('operation-1');
        expect(state.operationsById['operation-1'].payload.assessmentId).toBe('assessment-1');
    });

    test('updates mutable delivery fields while preserving operation identity and content', () => {
        const state = createEmptyState(access());
        const created = enqueueDurableOperation(state, operationInput(), {
            createId: () => 'operation-1',
            now: '2026-08-21T00:00:00.000Z'
        });
        const updated = updateDurableOperation(state, { operationId: 'operation-1' }, {
            status: 'claimed',
            attemptCount: 1,
            leaseOwner: 'worker-1',
            leaseUntil: '2026-08-21T00:05:00.000Z',
            lastAttemptAt: '2026-08-21T00:00:30.000Z'
        }, {
            expectedStatus: 'pending',
            now: '2026-08-21T00:00:30.000Z'
        });

        expect(updated).toMatchObject({
            operationId: 'operation-1',
            payloadHash: created.operation.payloadHash,
            status: 'claimed',
            attemptCount: 1,
            leaseOwner: 'worker-1'
        });
        expect(() => updateDurableOperation(state, 'operation-1', {
            payload: { organisationId: 'other' }
        })).toThrow(expect.objectContaining({
            statusCode: 400,
            details: expect.objectContaining({ code: 'operation_immutable_field' })
        }));
    });

    test('prevents reopening a terminal operation', () => {
        const state = createEmptyState(access());
        enqueueDurableOperation(state, operationInput(), {
            createId: () => 'operation-1',
            now: '2026-08-21T00:00:00.000Z'
        });
        updateDurableOperation(state, 'operation-1', {
            status: 'completed',
            completedAt: '2026-08-21T00:01:00.000Z',
            resultReference: 'lifecycle/organisation-1'
        });

        expect(() => updateDurableOperation(state, 'operation-1', {
            status: 'retry'
        })).toThrow(expect.objectContaining({
            statusCode: 409,
            details: expect.objectContaining({ code: 'operation_terminal' })
        }));
    });

    test.each([
        [{ credentials: 'not-allowed' }, 'unsafe_key'],
        [{ nested: { apiToken: 'not-allowed' } }, 'unsafe_key'],
        [{ note: 'Bearer this-is-not-allowed' }, 'unsafe_string'],
        [{ certificate: '-----BEGIN PRIVATE KEY-----' }, 'unsafe_string']
    ])('rejects secret-bearing durable operation payloads', (payload, reason) => {
        const state = createEmptyState(access());

        expect(() => enqueueDurableOperation(state, operationInput({ payload }))).toThrow(expect.objectContaining({
            statusCode: 400,
            details: expect.objectContaining({ code: 'invalid_operation_payload', reason })
        }));
        expect(state.operationsById).toEqual({});
    });
});
