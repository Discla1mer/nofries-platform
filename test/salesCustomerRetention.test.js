const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-sales-retention-'));
const mockLifecycleService = {
    getOrganisation: jest.fn(),
    linkScopingRecords: jest.fn(),
    unlinkScopingRecords: jest.fn(),
    completeScopingDeletion: jest.fn()
};

process.env.NOFRIES_DATA_DIR = mockDataDir;
process.env.NOFRIES_STORAGE_PROVIDER = 'local';
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_DEV_EMAIL = 'admin@example.com';
process.env.NOFRIES_ALLOWED_EMAILS = 'admin@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
process.env.NOFRIES_TENANT_NAME = 'Sales retention test';

jest.mock('../api/shared/appLifecycleRuntime', () => ({
    getLifecycleService: () => mockLifecycleService
}));

const {
    resetSalesRuntimeForTests,
    runSalesFunction
} = require('../api/shared/salesRuntime');
const { createSalesWorkspaceRepository } = require('../api/shared/salesWorkspaceRepository');
const { resolveTenantAccess } = require('../api/shared/tenantAccess');

const access = resolveTenantAccess({
    email: 'admin@example.com',
    name: 'Admin',
    isAuthenticated: false
});
const seedRepository = createSalesWorkspaceRepository({ dataDir: mockDataDir });

let mockOrganisation;
let mockLifecycleRevision;
let mockAfterTargetReceipt;
let mockAfterTargetUnlink;
let mockTargetEffects;
let mockTargetReceipts;
let mockDeletionFence;

beforeAll(() => {
    resetSalesRuntimeForTests();
});

beforeEach(() => {
    mockLifecycleRevision = 10;
    mockAfterTargetReceipt = null;
    mockAfterTargetUnlink = null;
    mockTargetEffects = 0;
    mockTargetReceipts = new Set();
    mockDeletionFence = { claimId: '', generation: 0, status: 'none', salesCustomerId: '', assessmentId: '' };
    mockOrganisation = scopingOrganisation(`organisation-${Date.now()}-${Math.random()}`);

    mockLifecycleService.getOrganisation.mockReset().mockImplementation(async () => ({
        revision: mockLifecycleRevision,
        organisation: clone(mockOrganisation)
    }));
    mockLifecycleService.linkScopingRecords.mockReset().mockImplementation(async (_access, organisationId, input) => {
        if (mockDeletionFence.status === 'unlinked') {
            if (
                input.restoreDeletionClaim !== true ||
                input.deletionClaimId !== mockDeletionFence.claimId ||
                input.deletionFenceGeneration !== mockDeletionFence.generation
            ) {
                throw lifecycleError('scoping_deletion_fence_stale');
            }
        }
        if (
            mockDeletionFence.status === 'completed' &&
            (input.salesCustomerId === mockDeletionFence.salesCustomerId || input.assessmentId === mockDeletionFence.assessmentId)
        ) {
            throw lifecycleError('scoping_deletion_completed');
        }
        const materialized = mockOrganisation.links.salesCustomerId === input.salesCustomerId &&
            mockOrganisation.scope.salesCustomerId === input.salesCustomerId &&
            mockOrganisation.scope.assessmentId === input.assessmentId;
        if (!mockTargetReceipts.has(input.operationId) || !materialized) {
            mockTargetReceipts.add(input.operationId);
            mockTargetEffects += 1;
            mockOrganisation.organisationId = organisationId;
            mockOrganisation.links.salesCustomerId = input.salesCustomerId;
            mockOrganisation.scope.salesCustomerId = input.salesCustomerId;
            mockOrganisation.scope.assessmentId = input.assessmentId;
            mockOrganisation.scope.status = 'in_progress';
            mockLifecycleRevision += 1;
            if (mockAfterTargetReceipt) await mockAfterTargetReceipt(input);
        }
        if (input.restoreDeletionClaim === true && ['none', 'unlinked'].includes(mockDeletionFence.status)) {
            mockDeletionFence = Object.assign({}, mockDeletionFence, {
                claimId: input.deletionClaimId,
                generation: input.deletionFenceGeneration,
                status: 'compensated',
                salesCustomerId: input.salesCustomerId,
                assessmentId: input.assessmentId
            });
        } else if (mockDeletionFence.status === 'completed') {
            mockDeletionFence = { claimId: '', generation: 0, status: 'none', salesCustomerId: '', assessmentId: '' };
        }
        return {
            revision: mockLifecycleRevision,
            organisation: clone(mockOrganisation)
        };
    });
    mockLifecycleService.unlinkScopingRecords.mockReset().mockImplementation(async (_access, _organisationId, input) => {
        if (mockDeletionFence.generation > Number(input.deletionFenceGeneration || 0)) {
            throw lifecycleError('scoping_deletion_fence_stale');
        }
        if (
            mockDeletionFence.generation === Number(input.deletionFenceGeneration || 0) &&
            mockDeletionFence.claimId &&
            mockDeletionFence.claimId !== input.deletionClaimId
        ) {
            throw lifecycleError('scoping_deletion_fence_conflict');
        }
        if (
            mockDeletionFence.generation === Number(input.deletionFenceGeneration || 0) &&
            mockDeletionFence.claimId === input.deletionClaimId &&
            ['compensated', 'completed'].includes(mockDeletionFence.status)
        ) {
            throw lifecycleError('scoping_deletion_fence_terminal');
        }
        mockDeletionFence = {
            claimId: input.deletionClaimId,
            generation: input.deletionFenceGeneration,
            status: 'unlinked',
            salesCustomerId: input.salesCustomerId,
            assessmentId: input.assessmentId
        };
        mockOrganisation.links.salesCustomerId = '';
        mockOrganisation.scope.salesCustomerId = '';
        mockOrganisation.scope.assessmentId = '';
        mockOrganisation.scope.status = 'ready';
        mockLifecycleRevision += 1;
        if (mockAfterTargetUnlink) await mockAfterTargetUnlink();
        return {
            revision: mockLifecycleRevision,
            organisation: clone(mockOrganisation)
        };
    });
    mockLifecycleService.completeScopingDeletion.mockReset().mockImplementation(async (_access, _organisationId, input) => {
        if (
            mockDeletionFence.claimId !== input.deletionClaimId ||
            mockDeletionFence.generation !== input.deletionFenceGeneration
        ) {
            throw lifecycleError('scoping_deletion_fence_stale');
        }
        if (!['unlinked', 'compensated', 'completed'].includes(mockDeletionFence.status)) {
            throw lifecycleError('scoping_deletion_state_conflict');
        }
        if (mockDeletionFence.status === 'compensated') {
            if (
                mockOrganisation.links.salesCustomerId !== mockDeletionFence.salesCustomerId ||
                mockOrganisation.scope.assessmentId !== mockDeletionFence.assessmentId
            ) {
                throw lifecycleError('scoping_deletion_links_conflict');
            }
            mockOrganisation.links.salesCustomerId = '';
            mockOrganisation.scope.salesCustomerId = '';
            mockOrganisation.scope.assessmentId = '';
            mockOrganisation.scope.status = 'ready';
        }
        mockDeletionFence.status = 'completed';
        mockLifecycleRevision += 1;
        return { revision: mockLifecycleRevision, organisation: clone(mockOrganisation) };
    });
});

afterAll(() => {
    fs.rmSync(mockDataDir, { recursive: true, force: true });
});

describe('Sales handoff convergence and customer evidence retention', () => {
    test('reports pending when the lifecycle receipt is durable but the Sales completion acknowledgement conflicts', async () => {
        mockOrganisation.displayName = 'Acknowledgement Conflict Ltd';
        const preview = await callSales('GET', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`);
        expect(preview.status).toBe(200);

        mockAfterTargetReceipt = async (input) => {
            const concurrent = await callSales('PATCH', `/api/sales/customers/${input.salesCustomerId}`, {
                notes: 'Concurrent source update after target receipt'
            });
            expect(concurrent.status).toBe(200);
            mockAfterTargetReceipt = null;
        };

        const first = await callSales('POST', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`, {
            expectedRevision: preview.body.revision,
            lifecycleRevision: preview.body.lifecycleRevision,
            confirmOrganisationId: mockOrganisation.organisationId,
            mode: 'create'
        });

        expect(first.status).toBe(202);
        expect(first.body).toMatchObject({
            convergence: 'pending',
            targetReceipt: 'recorded',
            retrySafe: true,
            operation: { status: 'claimed' }
        });

        const operation = await callSales('GET', `/api/sales/operations/${first.body.operation.operationId}`);
        expect(operation.status).toBe(200);
        expect(operation.body.operation).toMatchObject({
            status: 'claimed',
            resultReference: ''
        });

        const retryPreview = await callSales('GET', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`);
        const retry = await callSales('POST', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`, {
            expectedRevision: retryPreview.body.revision,
            lifecycleRevision: retryPreview.body.lifecycleRevision,
            confirmOrganisationId: mockOrganisation.organisationId,
            mode: 'resume'
        });

        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({
            convergence: 'completed',
            operation: {
                operationId: first.body.operation.operationId,
                status: 'completed'
            }
        });
        expect(mockTargetEffects).toBe(1);
    });

    test('does not delete a linked Sales customer when lifecycle unlink fails', async () => {
        mockOrganisation.displayName = 'Unlink Failure Ltd';
        const linked = await createLinkedCustomer();
        const unlinkError = new Error('Lifecycle evidence must be retained');
        unlinkError.statusCode = 409;
        unlinkError.details = { code: 'customer_sales_evidence_retention_required' };
        mockLifecycleService.unlinkScopingRecords.mockRejectedValueOnce(unlinkError);

        const blocked = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('customer_sales_evidence_retention_required');
        const retained = await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`);
        expect(retained.status).toBe(200);

        const deleted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: retained.body.revision,
            confirmName: mockOrganisation.displayName
        });
        expect(deleted.status).toBe(200);
        expect(deleted.body.lifecycleUnlink).toMatchObject({ status: 'completed' });
        expect(mockLifecycleService.unlinkScopingRecords).toHaveBeenCalledTimes(2);
        expect((await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`)).status).toBe(404);
    });

    test('an authoritative missing Lifecycle target lets the exact source deletion converge', async () => {
        mockOrganisation.displayName = 'Missing Lifecycle Target Ltd';
        const linked = await createLinkedCustomer();
        mockLifecycleService.unlinkScopingRecords.mockRejectedValueOnce(lifecycleNotFoundError());

        const deleted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(deleted.status).toBe(200);
        expect(deleted.body).toMatchObject({
            deleted: true,
            customerId: linked.body.customer.id,
            lifecycleUnlink: { status: 'not_found' }
        });
        expect(mockLifecycleService.completeScopingDeletion).not.toHaveBeenCalled();
        const state = await seedRepository.read(access);
        expect(state.customerDeletionReceiptsById[linked.body.customer.id]).toMatchObject({
            status: 'target_completed',
            lifecycleOutcome: 'not_found'
        });
    });

    test('deleting an unaccepted scoping handoff releases its durable idempotency key for re-handoff', async () => {
        mockOrganisation.displayName = 'Re-handoff Customer Ltd';
        const first = await createLinkedCustomer();
        const firstCustomerId = first.body.customer.id;
        const firstOperationId = first.body.operation.operationId;

        const deleted = await callSales('DELETE', `/api/sales/customers/${firstCustomerId}`, {
            expectedRevision: first.body.revision,
            confirmName: mockOrganisation.displayName
        });
        expect(deleted.status).toBe(200);

        const afterDeletion = await seedRepository.read(access);
        expect(afterDeletion.operationsById[firstOperationId]).toBeUndefined();
        expect(Object.values(afterDeletion.operationIdByIdempotencyKey)).not.toContain(firstOperationId);

        const second = await createLinkedCustomer();
        expect(second.body.customer.id).not.toBe(firstCustomerId);
        expect(second.body.operation.operationId).not.toBe(firstOperationId);
        expect(second.body.operation.status).toBe('completed');
        expect(mockTargetEffects).toBe(2);
    });

    test('a completed handoff revalidates and restores missing lifecycle materialization', async () => {
        mockOrganisation.displayName = 'Receipt Reconciliation Ltd';
        const first = await createLinkedCustomer();

        mockOrganisation.links.salesCustomerId = '';
        mockOrganisation.scope.salesCustomerId = '';
        mockOrganisation.scope.assessmentId = '';
        mockOrganisation.scope.status = 'ready';
        mockLifecycleRevision += 1;

        const retryPreview = await callSales('GET', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`);
        const replay = await callSales('POST', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`, {
            expectedRevision: retryPreview.body.revision,
            lifecycleRevision: retryPreview.body.lifecycleRevision,
            confirmOrganisationId: mockOrganisation.organisationId,
            mode: 'resume'
        });

        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({
            convergence: 'completed',
            operation: { operationId: first.body.operation.operationId, status: 'completed' },
            lifecycle: {
                links: { salesCustomerId: first.body.customer.id },
                scope: { assessmentId: first.body.assessment.id }
            }
        });
        expect(mockTargetEffects).toBe(2);
    });

    test('a concurrent Sales edit after lifecycle unlink compensates the exact target link before deletion fails', async () => {
        mockOrganisation.displayName = 'Deletion Compensation Ltd';
        const linked = await createLinkedCustomer();
        mockAfterTargetUnlink = async () => {
            const concurrent = await callSales('PATCH', `/api/sales/customers/${linked.body.customer.id}`, {
                notes: 'Concurrent source update during deletion'
            });
            expect(concurrent.status).toBe(200);
            mockAfterTargetUnlink = null;
        };

        const blocked = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('revision_conflict');
        const retained = await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`);
        expect(retained.status).toBe(200);
        expect(retained.body.customer.notes).toBe('Concurrent source update during deletion');
        expect(retained.body.customer.deletionClaim).toBeUndefined();
        expect(mockOrganisation).toMatchObject({
            links: { salesCustomerId: linked.body.customer.id },
            scope: {
                salesCustomerId: linked.body.customer.id,
                assessmentId: linked.body.assessment.id,
                status: 'in_progress'
            }
        });
        expect(mockTargetEffects).toBe(2);
    });

    test('target deletion between unlink and a source conflict releases the claim and retries as not found', async () => {
        mockOrganisation.displayName = 'Target Disappearance Ltd';
        const linked = await createLinkedCustomer();
        mockAfterTargetUnlink = async () => {
            const concurrent = await callSales('PATCH', `/api/sales/customers/${linked.body.customer.id}`, {
                notes: 'Concurrent source update before target disappeared'
            });
            expect(concurrent.status).toBe(200);
            mockLifecycleService.linkScopingRecords.mockRejectedValueOnce(lifecycleNotFoundError());
            mockAfterTargetUnlink = null;
        };

        const conflicted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(conflicted.status).toBe(409);
        expect(conflicted.body.code).toBe('revision_conflict');
        const retained = await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`);
        expect(retained.status).toBe(200);
        expect(retained.body.customer.deletionClaim).toBeUndefined();

        mockLifecycleService.unlinkScopingRecords.mockRejectedValueOnce(lifecycleNotFoundError());
        const deleted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: retained.body.revision,
            confirmName: mockOrganisation.displayName
        });
        expect(deleted.status).toBe(200);
        expect(deleted.body.lifecycleUnlink.status).toBe('not_found');
        expect((await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`)).status).toBe(404);
    });

    test('a durable deletion claim fences a second delete before it can unlink lifecycle', async () => {
        mockOrganisation.displayName = 'Concurrent Deletion Fence Ltd';
        const linked = await createLinkedCustomer();
        let concurrentDelete;
        mockAfterTargetUnlink = async () => {
            mockAfterTargetUnlink = null;
            concurrentDelete = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
                confirmName: mockOrganisation.displayName
            });
        };

        const deleted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(deleted.status).toBe(200);
        expect(concurrentDelete).toMatchObject({
            status: 409,
            body: { code: 'customer_deletion_in_progress' }
        });
        expect(mockLifecycleService.unlinkScopingRecords).toHaveBeenCalledTimes(1);
        expect((await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`)).status).toBe(404);
        expect(mockOrganisation).toMatchObject({
            links: { salesCustomerId: '' },
            scope: { salesCustomerId: '', assessmentId: '', status: 'ready' }
        });
    });

    test('an active deletion claim fences completed-handoff replay during the unlink window', async () => {
        mockOrganisation.displayName = 'Deletion Handoff Fence Ltd';
        const linked = await createLinkedCustomer();
        let concurrentHandoff;
        mockAfterTargetUnlink = async () => {
            mockAfterTargetUnlink = null;
            const preview = await callSales('GET', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`);
            concurrentHandoff = await callSales('POST', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`, {
                expectedRevision: preview.body.revision,
                lifecycleRevision: preview.body.lifecycleRevision,
                confirmOrganisationId: mockOrganisation.organisationId,
                mode: 'resume'
            });
        };

        const deleted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(deleted.status).toBe(200);
        expect(concurrentHandoff).toMatchObject({
            status: 409,
            body: { code: 'customer_deletion_in_progress' }
        });
        expect(mockTargetEffects).toBe(1);
        expect(mockOrganisation).toMatchObject({
            links: { salesCustomerId: '' },
            scope: { salesCustomerId: '', assessmentId: '', status: 'ready' }
        });
    });

    test('a durable source-deletion receipt recovers exact target completion after late compensation', async () => {
        mockOrganisation.displayName = 'Deletion Completion Recovery Ltd';
        const linked = await createLinkedCustomer();
        const completionError = lifecycleError('temporary_lifecycle_completion_failure');
        mockLifecycleService.completeScopingDeletion.mockImplementationOnce(async () => {
            // Model a timed-out source write that commits after the caller has
            // restored the same fenced Lifecycle links as compensation.
            mockDeletionFence.status = 'compensated';
            mockOrganisation.links.salesCustomerId = linked.body.customer.id;
            mockOrganisation.scope.salesCustomerId = linked.body.customer.id;
            mockOrganisation.scope.assessmentId = linked.body.assessment.id;
            mockOrganisation.scope.status = 'in_progress';
            mockLifecycleRevision += 1;
            throw completionError;
        });

        const interrupted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(interrupted.status).toBe(409);
        expect(interrupted.body).toMatchObject({
            code: 'customer_deletion_target_completion_failed',
            completionErrorCode: 'temporary_lifecycle_completion_failure'
        });
        expect((await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`)).status).toBe(404);
        const pendingState = await seedRepository.read(access);
        expect(pendingState.customerDeletionReceiptsById[linked.body.customer.id]).toMatchObject({
            customerId: linked.body.customer.id,
            customerName: mockOrganisation.displayName,
            lifecycleOrganisationId: mockOrganisation.organisationId,
            assessmentId: linked.body.assessment.id,
            status: 'source_deleted',
            deletionClaimId: expect.any(String),
            deletionFenceGeneration: 1
        });

        const recovered = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            // A terminal retry is bound by the exact durable receipt rather than a
            // stale whole-workspace revision from before the source delete.
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(recovered.status).toBe(200);
        expect(recovered.body).toMatchObject({
            deleted: true,
            recovered: true,
            customerId: linked.body.customer.id,
            lifecycleUnlink: { status: 'completed' }
        });
        const completedState = await seedRepository.read(access);
        expect(completedState.customerDeletionReceiptsById[linked.body.customer.id]).toMatchObject({
            status: 'target_completed',
            targetCompletedAt: expect.any(String),
            targetCompletedBy: 'admin@example.com'
        });
        expect(mockLifecycleService.completeScopingDeletion).toHaveBeenCalledTimes(2);
    });

    test('a pending source receipt converges when the completed Lifecycle target was later deleted', async () => {
        mockOrganisation.displayName = 'Deleted Completion Target Ltd';
        const linked = await createLinkedCustomer();
        const lostResponse = lifecycleError('lifecycle_completion_response_lost');
        mockLifecycleService.completeScopingDeletion.mockImplementationOnce(async () => {
            mockDeletionFence.status = 'completed';
            mockOrganisation.links.salesCustomerId = '';
            mockOrganisation.scope.salesCustomerId = '';
            mockOrganisation.scope.assessmentId = '';
            mockOrganisation.scope.status = 'ready';
            mockLifecycleRevision += 1;
            throw lostResponse;
        });

        const interrupted = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: linked.body.revision,
            confirmName: mockOrganisation.displayName
        });
        expect(interrupted.status).toBe(409);
        expect(interrupted.body.code).toBe('customer_deletion_target_completion_failed');
        mockLifecycleService.completeScopingDeletion.mockRejectedValueOnce(lifecycleNotFoundError());

        const recovered = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            confirmName: mockOrganisation.displayName
        });

        expect(recovered.status).toBe(200);
        expect(recovered.body).toMatchObject({
            deleted: true,
            recovered: true,
            lifecycleUnlink: { status: 'not_found', lifecycleRevision: 0 }
        });
        const state = await seedRepository.read(access);
        expect(state.customerDeletionReceiptsById[linked.body.customer.id]).toMatchObject({
            status: 'target_completed',
            lifecycleOutcome: 'not_found'
        });
    });

    test('an expired deletion claim can be fenced over to recover an interrupted unlink saga', async () => {
        mockOrganisation.displayName = 'Deletion Claim Recovery Ltd';
        const linked = await createLinkedCustomer();
        const interrupted = await seedRepository.mutate(access, {
            expectedRevision: linked.body.revision,
            action: 'test.deletion_claim_interrupted',
            targetType: 'customer',
            targetId: linked.body.customer.id,
            summary: 'Seed an expired interrupted deletion claim'
        }, (state) => {
            const customer = state.customers.find((candidate) => candidate.id === linked.body.customer.id);
            customer.deletionClaim = {
                id: 'expired-deletion-claim',
                status: 'claimed',
                claimedAt: '2026-08-20T00:00:00.000Z',
                claimedBy: 'former-worker@example.com',
                leaseUntil: '2026-08-20T00:05:00.000Z',
                lifecycleOrganisationId: mockOrganisation.organisationId,
                assessmentId: linked.body.assessment.id
            };
            return customer;
        });
        mockOrganisation.links.salesCustomerId = '';
        mockOrganisation.scope.salesCustomerId = '';
        mockOrganisation.scope.assessmentId = '';
        mockOrganisation.scope.status = 'ready';
        mockLifecycleRevision += 1;

        const recovered = await callSales('DELETE', `/api/sales/customers/${linked.body.customer.id}`, {
            expectedRevision: interrupted.state.revision,
            confirmName: mockOrganisation.displayName
        });

        expect(recovered.status).toBe(200);
        expect(recovered.body.deleted).toBe(true);
        expect((await callSales('GET', `/api/sales/customers/${linked.body.customer.id}`)).status).toBe(404);
        expect(mockLifecycleService.unlinkScopingRecords).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['approved', null],
        ['draft', { schemaVersion: 1, status: 'sealed', version: 'v1', sha256: 'a'.repeat(64) }]
    ])('blocks deletion when customer evidence is %s or sealed', async (status, approvalSeal) => {
        const current = await seedRepository.read(access);
        const name = `Retained ${status} ${current.revision}`;
        const created = await callSales('POST', '/api/sales/customers', {
            expectedRevision: current.revision,
            name
        });
        expect(created.status).toBe(201);

        const seeded = await seedRepository.mutate(access, {
            expectedRevision: created.body.revision,
            action: 'test.proposal_seeded',
            targetType: 'proposal',
            targetId: `proposal-${created.body.customer.id}`,
            summary: 'Test retention evidence'
        }, (state) => {
            state.proposals.push({
                id: `proposal-${created.body.customer.id}`,
                customerId: created.body.customer.id,
                assessmentId: `assessment-${created.body.customer.id}`,
                versionNumber: 1,
                title: 'Retained proposal',
                status,
                approvalSeal,
                recommendations: [],
                dynamics: { status: 'not_sent', sentAt: '', handoffId: '', recordUrl: '' }
            });
        });

        const blocked = await callSales('DELETE', `/api/sales/customers/${created.body.customer.id}`, {
            expectedRevision: seeded.state.revision,
            confirmName: name
        });
        expect(blocked.status).toBe(409);
        expect(blocked.body).toMatchObject({
            code: 'approved_proposal_retention_required',
            proposalId: `proposal-${created.body.customer.id}`
        });
        expect((await callSales('GET', `/api/sales/customers/${created.body.customer.id}`)).status).toBe(200);
        expect(mockLifecycleService.unlinkScopingRecords).not.toHaveBeenCalled();
    });

    test('rejects an unsealed legacy approval before attempting a live Dynamics write', async () => {
        const current = await seedRepository.read(access);
        const created = await callSales('POST', '/api/sales/customers', {
            expectedRevision: current.revision,
            name: `Legacy Approval ${current.revision}`
        });
        expect(created.status).toBe(201);

        const assessmentId = `assessment-legacy-${created.body.customer.id}`;
        const proposalId = `proposal-legacy-${created.body.customer.id}`;
        const seeded = await seedRepository.mutate(access, {
            expectedRevision: created.body.revision,
            action: 'test.legacy_approval_seeded',
            targetType: 'proposal',
            targetId: proposalId,
            summary: 'Test legacy approval'
        }, (state) => {
            state.assessments.push({
                id: assessmentId,
                customerId: created.body.customer.id,
                status: 'completed',
                recommendations: [],
                answers: {},
                completedAt: '2026-08-20T00:00:00.000Z'
            });
            state.proposals.push({
                id: proposalId,
                customerId: created.body.customer.id,
                assessmentId,
                versionNumber: 1,
                title: 'Legacy approved proposal',
                status: 'approved',
                recommendations: [],
                nextStep: 'Confirm next step',
                approvedBy: 'admin@example.com',
                approvedAt: '2026-08-20T00:00:00.000Z',
                dynamics: { status: 'not_sent', sentAt: '', handoffId: '', recordUrl: '' }
            });
        });

        const handoff = await callSales('POST', '/api/sales/integrations/dynamics/handoff', {
            expectedRevision: seeded.state.revision,
            proposalId,
            confirmed: true
        });
        expect(handoff.status).toBe(409);
        expect(handoff.body).toMatchObject({
            code: 'approved_proposal_unsealed',
            proposalId
        });
    });
});

async function createLinkedCustomer() {
    const preview = await callSales('GET', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`);
    const linked = await callSales('POST', `/api/sales/lifecycle-handoffs/${mockOrganisation.organisationId}`, {
        expectedRevision: preview.body.revision,
        lifecycleRevision: preview.body.lifecycleRevision,
        confirmOrganisationId: mockOrganisation.organisationId,
        mode: 'create'
    });
    expect(linked.status).toBe(201);
    expect(linked.body.convergence).toBe('completed');
    return linked;
}

async function callSales(method, url, body) {
    const context = {
        bindingData: {},
        log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() }
    };
    await runSalesFunction(context, {
        method,
        url,
        headers: { 'x-forwarded-for': '198.51.100.50' },
        body
    });
    return context.res;
}

function scopingOrganisation(organisationId) {
    return {
        organisationId,
        recordType: 'prospect',
        displayName: 'Scoping Customer Ltd',
        lifecycleState: 'scoping',
        context: {},
        fieldStates: {},
        discovery: { summary: '', missingFields: [] },
        links: { salesCustomerId: '' },
        scope: { status: 'ready', salesCustomerId: '', assessmentId: '' },
        nextAction: {}
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function lifecycleError(code) {
    const error = new Error(code);
    error.statusCode = 409;
    error.details = { code };
    return error;
}

function lifecycleNotFoundError() {
    const error = new Error('Organisation not found');
    error.statusCode = 404;
    error.details = { code: 'organisation_not_found' };
    return error;
}
