const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLifecycleRepository } = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');
const { ROLE_CAPABILITIES } = require('../api/shared/tenantAccess');

describe('lifecycle handoff inbox receipt', () => {
    test('acknowledgement replay bypasses a stale revision but cannot cross organisations', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-lifecycle-inbox-'));
        const repository = createLifecycleRepository({ provider: 'local', dataDir });
        const service = createLifecycleService({ repository });
        const actor = access();
        const first = await prepareScoping(service, actor, 'Receipt One');
        const operationId = 'operation-lifecycle-link-one';
        const operationPayloadHash = 'a'.repeat(64);
        const linked = await service.linkScopingRecords(actor, first.organisation.organisationId, {
            expectedRevision: first.revision,
            salesCustomerId: 'sales-customer-one',
            assessmentId: 'assessment-one',
            operationId,
            operationPayloadHash
        });
        const auditCount = (await repository.read(actor)).audit.length;

        const replay = await service.linkScopingRecords(actor, first.organisation.organisationId, {
            expectedRevision: first.revision,
            salesCustomerId: 'sales-customer-one',
            assessmentId: 'assessment-one',
            operationId,
            operationPayloadHash
        });
        expect(replay.revision).toBe(linked.revision);
        expect((await repository.read(actor)).audit).toHaveLength(auditCount);

        const unlinked = await service.unlinkScopingRecords(actor, first.organisation.organisationId, {
            salesCustomerId: 'sales-customer-one'
        });
        const rematerialized = await service.linkScopingRecords(actor, first.organisation.organisationId, {
            expectedRevision: unlinked.revision,
            salesCustomerId: 'sales-customer-one',
            assessmentId: 'assessment-one',
            operationId,
            operationPayloadHash
        });
        expect(rematerialized.revision).toBe(unlinked.revision + 1);
        expect(rematerialized.organisation).toMatchObject({
            links: { salesCustomerId: 'sales-customer-one' },
            scope: { salesCustomerId: 'sales-customer-one', assessmentId: 'assessment-one' }
        });
        expect((await repository.read(actor)).inboxReceiptsById[operationId]).toMatchObject({
            operationId,
            rematerializedBy: 'owner@example.com',
            rematerializedAt: expect.any(String)
        });

        const second = await prepareScoping(service, actor, 'Receipt Two');
        await expect(service.linkScopingRecords(actor, second.organisation.organisationId, {
            expectedRevision: second.revision,
            salesCustomerId: 'sales-customer-two',
            assessmentId: 'assessment-two',
            operationId,
            operationPayloadHash
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'handoff_operation_payload_conflict' }
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('target-side deletion generations reject stale compensation and completed-link replay', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-lifecycle-fence-'));
        const repository = createLifecycleRepository({ provider: 'local', dataDir });
        const service = createLifecycleService({ repository });
        const actor = access();
        const prepared = await prepareScoping(service, actor, 'Fence Customer');
        const operationId = 'operation-lifecycle-fence-one';
        const operationPayloadHash = 'b'.repeat(64);
        await service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash
        });

        await expect(service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash,
            deletionClaimId: 'deletion-claim-unflagged',
            deletionFenceGeneration: 1
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'scoping_deletion_restore_required' }
        });

        const firstFence = await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            deletionClaimId: 'deletion-claim-one',
            deletionFenceGeneration: 1,
            deletionClaimLeaseUntil: '2099-01-01T00:00:00.000Z'
        });
        await expect(service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-rebound',
            assessmentId: 'assessment-rebound',
            deletionClaimId: 'deletion-claim-one',
            deletionFenceGeneration: 1,
            deletionClaimLeaseUntil: '2099-01-01T00:00:00.000Z'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_fence_conflict' }
        });
        expect((await service.getOrganisation(actor, prepared.organisation.organisationId)).organisation.scope.deletionFence)
            .toMatchObject({
                claimId: 'deletion-claim-one',
                generation: 1,
                salesCustomerId: 'sales-customer-fence',
                assessmentId: 'assessment-fence',
                status: 'unlinked'
            });
        await expect(service.deleteOrganisation(actor, prepared.organisation.organisationId, {
            expectedRevision: firstFence.revision,
            confirmName: 'Fence Customer'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_in_progress' }
        });
        const newerFence = await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            deletionClaimId: 'deletion-claim-two',
            deletionFenceGeneration: 2,
            deletionClaimLeaseUntil: '2099-01-01T00:05:00.000Z'
        });

        await expect(service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: newerFence.revision,
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash,
            restoreDeletionClaim: true,
            deletionClaimId: 'deletion-claim-one',
            deletionFenceGeneration: 1
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_fence_stale' }
        });

        const restored = await service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: newerFence.revision,
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash,
            restoreDeletionClaim: true,
            deletionClaimId: 'deletion-claim-two',
            deletionFenceGeneration: 2
        });
        expect(restored.organisation.scope.deletionFence.status).toBe('compensated');

        const completedAfterCompensation = await service.completeScopingDeletion(
            actor,
            prepared.organisation.organisationId,
            {
                deletionClaimId: 'deletion-claim-two',
                deletionFenceGeneration: 2
            }
        );
        expect(completedAfterCompensation.organisation).toMatchObject({
            links: { salesCustomerId: '' },
            scope: {
                salesCustomerId: '',
                assessmentId: '',
                deletionFence: { status: 'completed' }
            }
        });

        const finalUnlink = await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            deletionClaimId: 'deletion-claim-three',
            deletionFenceGeneration: 3,
            deletionClaimLeaseUntil: '2099-01-01T00:10:00.000Z'
        });
        const completed = await service.completeScopingDeletion(actor, prepared.organisation.organisationId, {
            deletionClaimId: 'deletion-claim-three',
            deletionFenceGeneration: 3
        });
        expect(completed.organisation.scope.deletionFence.status).toBe('completed');
        await expect(service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: completed.revision,
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_completed' }
        });

        const replacement = await service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: completed.revision,
            salesCustomerId: 'sales-customer-replacement',
            assessmentId: 'assessment-replacement',
            operationId: 'operation-lifecycle-fence-replacement',
            operationPayloadHash: 'c'.repeat(64)
        });
        expect(replacement.organisation).toMatchObject({
            links: { salesCustomerId: 'sales-customer-replacement' },
            scope: {
                assessmentId: 'assessment-replacement',
                deletionFence: { status: 'none' }
            }
        });
        const historicalCompletion = await service.completeScopingDeletion(
            actor,
            prepared.organisation.organisationId,
            {
                deletionClaimId: 'deletion-claim-three',
                deletionFenceGeneration: 3
            }
        );
        expect(historicalCompletion.revision).toBe(replacement.revision);
        expect(historicalCompletion.organisation).toMatchObject({
            links: { salesCustomerId: 'sales-customer-replacement' },
            scope: { assessmentId: 'assessment-replacement' }
        });

        await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-replacement',
            assessmentId: 'assessment-replacement',
            deletionClaimId: 'deletion-claim-replacement',
            deletionFenceGeneration: 1,
            deletionClaimLeaseUntil: '2099-01-01T00:15:00.000Z'
        });
        const replacementCompleted = await service.completeScopingDeletion(actor, prepared.organisation.organisationId, {
            deletionClaimId: 'deletion-claim-replacement',
            deletionFenceGeneration: 1
        });
        await expect(service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            deletionClaimId: 'deletion-claim-three',
            deletionFenceGeneration: 3,
            deletionClaimLeaseUntil: '2099-01-01T00:10:00.000Z'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_fence_terminal' }
        });
        expect((await service.getOrganisation(actor, prepared.organisation.organisationId)).organisation.scope.deletionFence)
            .toMatchObject({
                claimId: 'deletion-claim-replacement',
                generation: 1,
                salesCustomerId: 'sales-customer-replacement',
                assessmentId: 'assessment-replacement',
                status: 'completed'
            });
        expect(replacementCompleted.organisation.scope.deletionFence.status).toBe('completed');
        await expect(service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-fence',
            assessmentId: 'assessment-fence',
            operationId,
            operationPayloadHash
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_completed' }
        });
        expect(finalUnlink.revision).toBeLessThan(completed.revision);
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('a different replacement deletion can supersede an old completed fence without losing its receipt', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-lifecycle-replacement-fence-'));
        const repository = createLifecycleRepository({ provider: 'local', dataDir });
        const service = createLifecycleService({ repository });
        const actor = access();
        const prepared = await prepareScoping(service, actor, 'Replacement Fence Customer');
        const operationId = 'operation-lifecycle-old-link';
        const operationPayloadHash = 'd'.repeat(64);

        await service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            salesCustomerId: 'sales-customer-old',
            assessmentId: 'assessment-old',
            operationId,
            operationPayloadHash
        });
        await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-old',
            assessmentId: 'assessment-old',
            deletionClaimId: 'deletion-claim-old',
            deletionFenceGeneration: 4,
            deletionClaimLeaseUntil: '2099-01-01T00:20:00.000Z'
        });
        const oldCompleted = await service.completeScopingDeletion(actor, prepared.organisation.organisationId, {
            deletionClaimId: 'deletion-claim-old',
            deletionFenceGeneration: 4
        });
        expect(oldCompleted.organisation).toMatchObject({
            links: { salesCustomerId: '' },
            scope: {
                salesCustomerId: '',
                assessmentId: '',
                deletionFence: {
                    claimId: 'deletion-claim-old',
                    generation: 4,
                    status: 'completed'
                }
            }
        });

        const replacementUnlinked = await service.unlinkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-new',
            assessmentId: 'assessment-new',
            deletionClaimId: 'deletion-claim-new',
            deletionFenceGeneration: 1,
            deletionClaimLeaseUntil: '2099-01-01T00:25:00.000Z'
        });
        expect(replacementUnlinked.organisation.scope.deletionFence).toMatchObject({
            claimId: 'deletion-claim-new',
            generation: 1,
            salesCustomerId: 'sales-customer-new',
            assessmentId: 'assessment-new',
            status: 'unlinked'
        });
        const replacementCompleted = await service.completeScopingDeletion(actor, prepared.organisation.organisationId, {
            deletionClaimId: 'deletion-claim-new',
            deletionFenceGeneration: 1
        });
        expect(replacementCompleted.organisation.scope.deletionReceipts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                claimId: 'deletion-claim-old',
                generation: 4,
                salesCustomerId: 'sales-customer-old',
                assessmentId: 'assessment-old'
            }),
            expect.objectContaining({
                claimId: 'deletion-claim-new',
                generation: 1,
                salesCustomerId: 'sales-customer-new',
                assessmentId: 'assessment-new'
            })
        ]));
        await expect(service.linkScopingRecords(actor, prepared.organisation.organisationId, {
            salesCustomerId: 'sales-customer-old',
            assessmentId: 'assessment-old',
            operationId,
            operationPayloadHash
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'scoping_deletion_completed' }
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
});

async function prepareScoping(service, actor, displayName) {
    let result = await service.createOrganisation(actor, {
        displayName,
        facts: [{ field: 'company.name', value: displayName, certainty: 'explicit' }]
    });
    result = await service.updateOrganisation(actor, result.organisation.organisationId, {
        expectedRevision: result.revision,
        lifecycleState: 'discovery'
    });
    return service.prepareScoping(actor, result.organisation.organisationId, {
        expectedRevision: result.revision
    });
}

function access() {
    return {
        allowed: true,
        tenant: { id: 'tenant-one', key: 'tenant-one', name: 'Tenant One', slug: 'tenant-one' },
        user: {
            email: 'owner@example.com',
            name: 'Owner',
            role: 'service_owner',
            principalId: 'owner-principal',
            capabilities: ROLE_CAPABILITIES.service_owner.slice()
        }
    };
}
