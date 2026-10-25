const {
    createProviderOperationFence,
    createMemoryFenceStore
} = require('../api/shared/serviceDesk/providerOperationFence');

function scope(overrides = {}) {
    return Object.assign({
        tenantId: 'tenant-one',
        customerId: 'customer-one',
        companyId: '10',
        providerScopeId: 'autotask-production',
        providerIdentitySha256: 'a'.repeat(64),
        operationId: 'operation-00000001',
        operationType: 'autotask.ticket.create',
        request: { companyId: '10', subject: 'Email issue' }
    }, overrides);
}

describe('durable provider operation fence semantics', () => {
    test('returns a terminal exact replay without rotating intent', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const first = await fence.reserve(scope());
        expect(first).toMatchObject({ disposition: 'reserved', status: 'pending' });
        await fence.beginStep(Object.assign(scope(), { step: 'ticket_create' }));
        await fence.applyStep(Object.assign(scope(), { step: 'ticket_create', checkpoint: { ticketId: '700' } }));
        await fence.complete(Object.assign(scope(), { result: { ticketReceipt: { ticketId: '700' } } }));
        const replay = await fence.reserve(scope());
        expect(replay).toMatchObject({ disposition: 'replay', status: 'completed', result: { ticketReceipt: { ticketId: '700' } } });
    });

    test('requires a durable one-time confirmation for a distinct intentional repeat', async () => {
        const store = createMemoryFenceStore();
        const fence = createProviderOperationFence({ store, randomBytes: () => Buffer.alloc(32, 7) });
        await fence.reserve(scope());
        await fence.complete(Object.assign(scope(), { result: { ticketReceipt: { ticketId: '700' } } }));
        const repeated = scope({ operationId: 'operation-00000002' });
        const confirmation = await fence.reserve(repeated);
        expect(confirmation).toMatchObject({
            disposition: 'confirmation_required',
            repeatedFromOperationId: 'operation-00000001',
            repeatToken: expect.any(String)
        });
        const secondInstance = createProviderOperationFence({ store, randomBytes: () => Buffer.alloc(32, 8) });
        const accepted = await secondInstance.reserve(Object.assign({}, repeated, { repeatToken: confirmation.repeatToken }));
        expect(accepted).toMatchObject({ disposition: 'reserved', repeatedFromOperationId: 'operation-00000001' });
        const responseLossReplay = await fence.reserve(Object.assign({}, repeated, { repeatToken: confirmation.repeatToken }));
        expect(responseLossReplay).toMatchObject({ operationId: 'operation-00000002', status: 'pending' });
    });

    test('does not replay an old receipt after the provider identity or scope changes', async () => {
        const store = createMemoryFenceStore();
        const original = createProviderOperationFence({ store });
        await original.reserve(scope());
        await original.complete(Object.assign(scope(), { result: { ticketReceipt: { ticketId: '700' } } }));

        const migrated = createProviderOperationFence({ store });
        await expect(migrated.reserve(scope({ providerIdentitySha256: 'b'.repeat(64) })))
            .rejects.toMatchObject({ details: { code: 'provider_operation_scope_rebound' } });
        await expect(migrated.reserve(scope({ providerScopeId: 'autotask-production-v2' })))
            .rejects.toMatchObject({ details: { code: 'provider_operation_scope_rebound' } });
    });

    test('rolls over more than 5000 terminal operations and replays an archived receipt after restart', async () => {
        const store = createMemoryFenceStore();
        const firstFence = createProviderOperationFence({ store, maxActiveOperations: 2 });
        for (let index = 0; index < 5005; index += 1) {
            const operation = scope({
                operationId: `operation-${String(index).padStart(8, '0')}`,
                request: { companyId: '10', subject: `Request ${index}` }
            });
            await firstFence.reserve(operation);
            await firstFence.complete(Object.assign({}, operation, {
                result: { ticketReceipt: { ticketId: String(700 + index) } }
            }));
        }

        const restarted = createProviderOperationFence({ store, maxActiveOperations: 2 });
        await expect(restarted.reserve(scope({
            operationId: 'operation-00000000',
            request: { companyId: '10', subject: 'Request 0' }
        }))).resolves.toMatchObject({
            status: 'completed',
            disposition: 'replay',
            result: { ticketReceipt: { ticketId: '700' } }
        });
    }, 30000);

    test('publishes hashed actor/requester attribution without legacy field names', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const attributed = scope({
            actorSubjectSha256: 'b'.repeat(64),
            requesterEmailSha256: 'c'.repeat(64),
            intakeChannel: 'customer_portal'
        });
        await fence.reserve(attributed);
        const audit = await fence.audit(attributed);
        expect(audit[0]).toMatchObject({
            actorSubjectSha256: 'b'.repeat(64),
            requesterEmailSha256: 'c'.repeat(64),
            intakeChannel: 'customer_portal'
        });
        expect(audit[0].actorHash).toBeUndefined();
        expect(audit[0].requesterEmailHash).toBeUndefined();
    });

    test('keeps ambiguous provider failures reserved but safely retries explicit known absence', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        await fence.reserve(scope());
        await fence.beginStep(Object.assign(scope(), { step: 'ticket_create' }));
        await fence.failStep(Object.assign(scope(), { step: 'ticket_create', failureCode: 'autotask_unreachable' }));
        const uncertain = await fence.reserve(scope());
        expect(uncertain).toMatchObject({ status: 'uncertain', disposition: 'pending' });

        const safe = scope({ operationId: 'operation-00000003', request: { companyId: '10', subject: 'Printer issue' } });
        await fence.reserve(safe);
        await fence.beginStep(Object.assign(safe, { step: 'ticket_create' }));
        await fence.failStep(Object.assign(safe, {
            step: 'ticket_create',
            failureCode: 'autotask_validation_failed',
            providerEffectAbsent: true
        }));
        const retry = await fence.reserve(safe);
        expect(retry).toMatchObject({ status: 'pending', disposition: 'reserved' });
        expect(retry.steps.ticket_create).toBeUndefined();
    });

    test('retains a resource lock when a later step is definitely absent after an applied effect', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const first = scope({ resourceKey: 'new-ticket' });
        await fence.reserve(first);
        await fence.beginStep(Object.assign({}, first, { step: 'ticket_create' }));
        await fence.applyStep(Object.assign({}, first, {
            step: 'ticket_create',
            checkpoint: { ticketId: '700', ticketNumber: 'T000700' }
        }));
        await fence.beginStep(Object.assign({}, first, { step: 'original_request_note' }));
        await fence.failStep(Object.assign({}, first, {
            step: 'original_request_note',
            failureCode: 'autotask_validation_failed',
            providerEffectAbsent: true
        }));

        await expect(fence.read(first)).resolves.toMatchObject({
            status: 'partial_applied',
            steps: {
                ticket_create: { status: 'applied' },
                original_request_note: { status: 'known_absent' }
            }
        });
        const divergent = scope({
            operationId: 'operation-00000010',
            resourceKey: 'new-ticket',
            request: { companyId: '10', subject: 'Another request' }
        });
        await expect(fence.reserve(divergent)).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'provider_operation_resource_locked', operationId: first.operationId }
        });

        const resumed = await fence.reserve(first);
        expect(resumed).toMatchObject({ status: 'partial_applied', disposition: 'pending' });
        await expect(fence.beginStep(Object.assign({}, first, { step: 'original_request_note' })))
            .resolves.toMatchObject({ status: 'dispatching', attempt: 2 });
    });

    test('cancels only before dispatch and releases the exact ticket resource', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const first = scope({ operationType: 'autotask.ticket.status', resourceKey: 'ticket:700' });
        await fence.reserve(first);
        await fence.cancel(Object.assign({}, first, { failureCode: 'version_conflict' }));
        const second = scope({
            operationId: 'operation-00000004',
            operationType: 'autotask.ticket.status',
            resourceKey: 'ticket:700',
            request: { companyId: '10', status: 'resolved' }
        });
        await expect(fence.reserve(second)).resolves.toMatchObject({ operationId: 'operation-00000004', disposition: 'reserved' });

        await fence.beginStep(Object.assign(second, { step: 'status_note' }));
        await expect(fence.cancel(Object.assign({}, second, { failureCode: 'too_late' })))
            .rejects.toMatchObject({ details: { code: 'provider_operation_state_invalid' } });
    });

    test('blocks a divergent create while the customer new-ticket target is unresolved', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const first = scope({ resourceKey: 'new-ticket' });
        await fence.reserve(first);
        await fence.beginStep(Object.assign({}, first, { step: 'ticket_create' }));
        await fence.failStep(Object.assign({}, first, { step: 'ticket_create', failureCode: 'network_unknown' }));

        const divergent = scope({
            operationId: 'operation-00000009',
            resourceKey: 'new-ticket',
            request: { companyId: '10', subject: 'A different request' }
        });
        await expect(fence.reserve(divergent)).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'provider_operation_resource_locked',
                operationId: 'operation-00000001'
            }
        });
    });

    test('verifies customer note provenance only from the exact terminal ticket and note checkpoints', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        const messageHash = 'd'.repeat(64);
        const input = scope({
            actorSubjectSha256: 'b'.repeat(64),
            requesterEmailSha256: 'c'.repeat(64),
            intakeChannel: 'customer_portal',
            noteMessageSha256: messageHash,
            noteOrigin: 'customer_portal_submission'
        });
        await fence.reserve(input);
        await fence.beginStep(Object.assign({}, input, { step: 'ticket_create' }));
        await fence.applyStep(Object.assign({}, input, { step: 'ticket_create', checkpoint: { ticketId: '700' } }));
        await fence.beginStep(Object.assign({}, input, { step: 'original_request_note' }));
        await fence.applyStep(Object.assign({}, input, { step: 'original_request_note', checkpoint: { noteId: '900' } }));

        const proof = Object.assign({}, input, { operationId: input.operationId, ticketId: '700', noteId: '900' });
        await expect(fence.verifyNoteProvenance(proof)).resolves.toBe(false);
        await fence.complete(Object.assign({}, input, { result: { ticketReceipt: { ticketId: '700' } } }));
        await expect(fence.verifyNoteProvenance(proof)).resolves.toBe(true);
        await expect(fence.verifyNoteProvenance(Object.assign({}, proof, { ticketId: '701' }))).resolves.toBe(false);
        await expect(fence.verifyNoteProvenance(Object.assign({}, proof, { noteId: '901' }))).resolves.toBe(false);
    });

    test('requires fresh exact step and audited evidence for a manual absence resolution', async () => {
        let current = new Date('2026-08-31T00:00:00.000Z');
        const fence = createProviderOperationFence({ store: createMemoryFenceStore(), now: () => new Date(current) });
        const input = scope({ resourceKey: 'new-ticket' });
        const providerTargetKey = `ticket-operation:${'f'.repeat(64)}`;
        const operatorEvidenceRef = 'autotask-operator-case:case-1234';
        await fence.reserve(input);
        await fence.beginStep(Object.assign({}, input, { step: 'ticket_create' }));
        await expect(fence.resolveStepAbsent(Object.assign({}, input, {
            step: 'ticket_create',
            expectedAttempt: 2,
            confirmation: 'CONFIRM PROVIDER EFFECT ABSENT',
            operatorEvidenceRef,
            providerEvidenceRef: `autotask-negative:${'1'.repeat(64)}`,
            providerTargetKey,
            resolverSubjectSha256: 'e'.repeat(64)
        }))).rejects.toMatchObject({ details: { code: 'provider_absence_resolution_conflict' } });
        await expect(fence.recordAbsenceObservation(Object.assign({}, input, {
            step: 'ticket_create',
            expectedAttempt: 1,
            providerTargetKey,
            providerCheckedAt: current.toISOString(),
            providerEvidenceRef: `autotask-negative:${'1'.repeat(64)}`
        }))).resolves.toMatchObject({ ready: false, count: 1 });
        current = new Date('2026-08-31T00:05:59.000Z');
        await expect(fence.recordAbsenceObservation(Object.assign({}, input, {
            step: 'ticket_create',
            expectedAttempt: 1,
            providerTargetKey,
            providerCheckedAt: current.toISOString(),
            providerEvidenceRef: `autotask-negative:${'2'.repeat(64)}`,
            operatorEvidenceRef,
            resolveWhenReady: true,
            confirmation: 'CONFIRM PROVIDER EFFECT ABSENT',
            resolverSubjectSha256: 'e'.repeat(64)
        }))).resolves.toMatchObject({ ready: false, resolved: false, count: 2 });
        current = new Date('2026-08-31T00:06:00.000Z');
        await expect(fence.recordAbsenceObservation(Object.assign({}, input, {
            step: 'ticket_create',
            expectedAttempt: 1,
            providerTargetKey,
            providerCheckedAt: current.toISOString(),
            providerEvidenceRef: `autotask-negative:${'3'.repeat(64)}`,
            operatorEvidenceRef,
            resolveWhenReady: true,
            confirmation: 'CONFIRM PROVIDER EFFECT ABSENT',
            resolverSubjectSha256: 'e'.repeat(64)
        }))).resolves.toMatchObject({
            ready: true,
            resolved: true,
            record: { status: 'pending', steps: { ticket_create: { status: 'known_absent' } } }
        });
        await expect(fence.beginStep(Object.assign({}, input, { step: 'ticket_create' })))
            .resolves.toMatchObject({ status: 'dispatching', attempt: 2 });
        await expect(fence.recordAbsenceObservation(Object.assign({}, input, {
            step: 'ticket_create',
            expectedAttempt: 1,
            providerTargetKey,
            providerCheckedAt: current.toISOString(),
            providerEvidenceRef: `autotask-negative:${'4'.repeat(64)}`
        }))).rejects.toMatchObject({ details: { code: 'provider_absence_resolution_conflict' } });
        const audit = await fence.audit(input);
        expect(audit).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'operation.step_absence_resolved' })
        ]));
    });

    test('caps durable repeat confirmations in the hot ledger', async () => {
        const fence = createProviderOperationFence({ store: createMemoryFenceStore() });
        await fence.reserve(scope());
        await fence.complete(Object.assign(scope(), { result: { ticketReceipt: { ticketId: '700' } } }));
        for (let index = 0; index < 500; index += 1) {
            await expect(fence.reserve(scope({ operationId: `repeat-${String(index).padStart(8, '0')}` })))
                .resolves.toMatchObject({ status: 'confirmation_required' });
        }
        await expect(fence.reserve(scope({ operationId: 'repeat-over-capacity' })))
            .rejects.toMatchObject({ statusCode: 503, details: { code: 'provider_repeat_confirmation_capacity' } });
    }, 30000);
});
