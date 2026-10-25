const crypto = require('crypto');
const { createAutotaskRuntime } = require('../api/shared/serviceDesk/autotaskRuntimeFactory');
const { createMemoryFenceStore, createProviderOperationFence } = require('../api/shared/serviceDesk/providerOperationFence');

function runtimeHarness(adapterOverrides = {}) {
    const adapter = Object.assign({
        status: () => ({
            configured: true,
            exactMappings: true,
            customerVisibleNotes: true,
            operationMarkerConfigured: true,
            portalVisibilityReady: true,
            priorityMapDigestVerified: true,
            statusWritesEnabled: false,
            state: 'ready'
        }),
        validateCreateInput: jest.fn()
    }, adapterOverrides);
    const operationFence = {
        status: () => ({
            configured: true,
            durable: true,
            crossInstanceExclusive: true,
            leaseRenewal: true,
            immutableOperationBinding: true,
            terminalReceiptArchive: true,
            boundedDuplicateIntentIndex: true,
            state: 'ready'
        }),
        reserve: jest.fn()
    };
    const runtime = createAutotaskRuntime({
        env: {
            NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'governed',
            NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'autotask-production',
            NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID: 'autotask-account-one',
            NOFRIES_AUTOTASK_USERNAME: 'integration@example.test',
            NOFRIES_AUTOTASK_INTEGRATION_CODE: 'integration-code'
        },
        client: {
            status: () => ({ configured: true, writeOperationsEnabled: true, mode: 'controlled_write', state: 'ready' })
        },
        adapter,
        operationFence
    });
    return { adapter, operationFence, runtime };
}

function staffCreate(overrides = {}) {
    return Object.assign({
        tenantId: 'workspace-one',
        customerId: 'customer-one',
        companyId: '10',
        providerScopeId: 'autotask-production',
        devices: [],
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        subject: 'Email issue',
        requestText: 'Outlook cannot authenticate.',
        priority: 'high',
        requesterEmail: 'requester@example.test',
        intakeChannel: 'portal',
        actor: {
            subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
            email: 'operator@example.test',
            source: 'staff_service_desk',
            role: 'admin'
        }
    }, overrides);
}

function resolutionHarness(overrides = {}) {
    let current = new Date('2026-08-31T00:00:00.000Z');
    const now = () => new Date(current);
    const operationFence = createProviderOperationFence({ store: createMemoryFenceStore(), now });
    const adapter = Object.assign({
        status: () => ({
            configured: true,
            exactMappings: true,
            customerVisibleNotes: true,
            operationMarkerConfigured: true,
            portalVisibilityReady: true,
            priorityMapDigestVerified: true,
            dattoRmmSourceMappingReady: true,
            statusWritesEnabled: false,
            state: 'ready'
        }),
        findTicketByOperationId: jest.fn().mockResolvedValue(null),
        hasCustomerVisibleNoteOperationMarker: jest.fn().mockResolvedValue(false)
    }, overrides.adapter);
    const env = {
        NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'governed',
        NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'autotask-production',
        NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID: 'autotask-account-one'
    };
    const runtime = createAutotaskRuntime({
        env,
        now,
        client: {
            status: () => ({ configured: true, writeOperationsEnabled: true, mode: 'controlled_write', state: 'ready' })
        },
        adapter,
        operationFence
    });
    const operationId = overrides.operationId || 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const scope = {
        tenantId: 'workspace-one',
        customerId: 'customer-one',
        companyId: '10',
        providerScopeId: 'autotask-production',
        providerIdentitySha256: crypto.createHash('sha256')
            .update('autotask\u0000autotask-account-one', 'utf8')
            .digest('hex'),
        operationId,
        operationType: overrides.operationType || 'autotask.ticket.create',
        resourceKey: overrides.resourceKey || 'new-ticket',
        request: { subject: 'Ambiguous provider dispatch' }
    };
    const input = {
        tenantId: scope.tenantId,
        customerId: scope.customerId,
        companyId: scope.companyId,
        providerScopeId: scope.providerScopeId,
        operationId,
        step: overrides.step || 'ticket_create',
        expectedAttempt: 1,
        confirmation: 'CONFIRM PROVIDER EFFECT ABSENT',
        evidenceRef: 'operator-case:provider-timeout-1234',
        actor: {
            subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
            email: 'owner@example.test',
            source: 'staff_service_desk',
            role: 'service_owner'
        }
    };
    return {
        adapter,
        input,
        now,
        operationFence,
        runtime,
        scope,
        setCurrent(value) { current = new Date(value); }
    };
}

describe('Autotask production runtime admission boundaries', () => {
    test('binds the exact governed portal contact into reply validation and the durable request', async () => {
        const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const getTicketByNumber = jest.fn().mockResolvedValue({
            id: '700',
            ticketNumber: 'T20260831.0001',
            companyId: '10'
        });
        const validateCustomerVisibleNoteInput = jest.fn();
        const { adapter, operationFence, runtime } = runtimeHarness({
            getTicketByNumber,
            validateCustomerVisibleNoteInput
        });
        operationFence.reserve.mockResolvedValue({
            disposition: 'confirmation_required',
            operationId,
            repeatToken: 'confirmation_token_123456',
            repeatedFromOperationId: ''
        });
        await expect(runtime.replyToTicket({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'autotask-production',
            contactId: '20',
            devices: [],
            operationId,
            ticketNumber: 'T20260831.0001',
            message: 'The issue is still occurring.',
            actor: {
                subjectKey: '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333',
                email: 'customer@example.test',
                source: 'customer_portal',
                role: 'customer_admin'
            }
        })).resolves.toMatchObject({ status: 'confirmation_required', operationId });
        expect(validateCustomerVisibleNoteInput).toHaveBeenCalledWith(expect.objectContaining({
            companyId: '10',
            contactId: '20',
            origin: 'customer_reply'
        }));
        expect(operationFence.reserve).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ contactId: '20', noteOrigin: 'customer_reply' })
        }));
        expect(adapter.getTicketByNumber).toHaveBeenCalledTimes(1);
    });

    test('rejects a portal reply without an exact contact before any provider read or reservation', async () => {
        const getTicketByNumber = jest.fn();
        const { operationFence, runtime } = runtimeHarness({ getTicketByNumber });
        await expect(runtime.replyToTicket({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'autotask-production',
            contactId: 'forged-contact',
            devices: [],
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            ticketNumber: 'T20260831.0001',
            message: 'The issue is still occurring.',
            actor: {
                subjectKey: '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333',
                email: 'customer@example.test',
                source: 'customer_portal',
                role: 'customer_admin'
            }
        })).rejects.toMatchObject({ details: { code: 'autotask_contact_mapping_required' } });
        expect(getTicketByNumber).not.toHaveBeenCalled();
        expect(operationFence.reserve).not.toHaveBeenCalled();
    });

    test('rejects a reserved operation marker from a staff create before reservation or provider validation', async () => {
        const { adapter, operationFence, runtime } = runtimeHarness();
        await expect(runtime.createTicket(staffCreate({
            subject: 'Forged [No Fries operation attacker-operation-01]'
        }))).rejects.toMatchObject({ details: { code: 'reserved_operation_marker' } });
        expect(adapter.validateCreateInput).not.toHaveBeenCalled();
        expect(operationFence.reserve).not.toHaveBeenCalled();
    });

    test('releases deterministic validation failures before any durable reservation or provider call', async () => {
        const validationError = Object.assign(new Error('device mapping invalid'), {
            statusCode: 409,
            details: { code: 'autotask_device_mapping_required' }
        });
        const validateCreateInput = jest.fn(() => { throw validationError; });
        const providerCreate = jest.fn();
        const { operationFence, runtime } = runtimeHarness({ validateCreateInput, createTicket: providerCreate });
        await expect(runtime.createTicket(staffCreate({ deviceId: 'ambiguous-device' })))
            .rejects.toBe(validationError);
        expect(operationFence.reserve).not.toHaveBeenCalled();
        expect(providerCreate).not.toHaveBeenCalled();
    });

    test('resolves an ambiguous create only after two exact negative reads beyond the provider execution horizon', async () => {
        const harness = resolutionHarness();
        await harness.operationFence.reserve(harness.scope);
        await harness.operationFence.beginStep(Object.assign({}, harness.scope, { step: 'ticket_create' }));
        const observe = jest.spyOn(harness.operationFence, 'recordAbsenceObservation');
        const directResolve = jest.spyOn(harness.operationFence, 'resolveStepAbsent');

        await expect(harness.runtime.resolveOperationStepAbsent(harness.input)).resolves.toMatchObject({
            status: 'pending',
            absenceSettlementPending: true,
            unresolvedSteps: [{ step: 'ticket_create', attempt: 1 }]
        });
        harness.setCurrent('2026-08-31T00:05:59.000Z');
        await expect(harness.runtime.resolveOperationStepAbsent(harness.input)).resolves.toMatchObject({
            status: 'pending',
            absenceSettlementPending: true
        });
        harness.setCurrent('2026-08-31T00:06:00.000Z');
        await expect(harness.runtime.resolveOperationStepAbsent(harness.input)).resolves.toMatchObject({
            status: 'pending',
            providerState: 'pending',
            unresolvedSteps: []
        });

        expect(harness.adapter.findTicketByOperationId).toHaveBeenCalledTimes(3);
        expect(observe).toHaveBeenCalledWith(expect.objectContaining({
            providerTargetKey: expect.stringMatching(/^ticket-operation:[a-f0-9]{64}$/),
            providerEvidenceRef: expect.stringMatching(/^autotask-negative:[a-f0-9]{64}$/),
            operatorEvidenceRef: harness.input.evidenceRef,
            providerCheckedAt: '2026-08-31T00:06:00.000Z',
            resolveWhenReady: true
        }));
        expect(directResolve).not.toHaveBeenCalled();
        await expect(harness.operationFence.beginStep(Object.assign({}, harness.scope, { step: 'ticket_create' })))
            .resolves.toMatchObject({ status: 'dispatching', attempt: 2 });
    });

    test('does not count a provider read failure or a delayed provider effect as absence', async () => {
        const harness = resolutionHarness();
        await harness.operationFence.reserve(harness.scope);
        await harness.operationFence.beginStep(Object.assign({}, harness.scope, { step: 'ticket_create' }));
        harness.adapter.findTicketByOperationId.mockRejectedValueOnce(new Error('provider timeout'));
        await expect(harness.runtime.resolveOperationStepAbsent(harness.input)).rejects.toThrow('provider timeout');

        harness.setCurrent('2026-08-31T00:06:01.000Z');
        harness.adapter.findTicketByOperationId.mockResolvedValueOnce({ id: '700' });
        await expect(harness.runtime.resolveOperationStepAbsent(harness.input))
            .rejects.toMatchObject({ details: { code: 'provider_effect_present' } });

        harness.setCurrent('2026-08-31T00:07:00.000Z');
        await expect(harness.runtime.resolveOperationStepAbsent(harness.input)).resolves.toMatchObject({
            absenceSettlementPending: true
        });
        const status = await harness.operationFence.read(harness.scope);
        expect(status.steps.ticket_create.absenceObservation.count).toBe(1);
    });

    test('rejects stale attempts and unsupported or unresolved targets before a provider read', async () => {
        const stale = resolutionHarness();
        await stale.operationFence.reserve(stale.scope);
        await stale.operationFence.beginStep(Object.assign({}, stale.scope, { step: 'ticket_create' }));
        await expect(stale.runtime.resolveOperationStepAbsent(Object.assign({}, stale.input, { expectedAttempt: 2 })))
            .rejects.toMatchObject({ details: { code: 'provider_absence_resolution_conflict' } });
        expect(stale.adapter.findTicketByOperationId).not.toHaveBeenCalled();

        const unsupported = resolutionHarness({ step: 'status_patch' });
        await unsupported.operationFence.reserve(unsupported.scope);
        await unsupported.operationFence.beginStep(Object.assign({}, unsupported.scope, { step: 'status_patch' }));
        await expect(unsupported.runtime.resolveOperationStepAbsent(unsupported.input))
            .rejects.toMatchObject({ details: { code: 'provider_absence_resolution_unsupported' } });
        expect(unsupported.adapter.findTicketByOperationId).not.toHaveBeenCalled();
        expect(unsupported.adapter.hasCustomerVisibleNoteOperationMarker).not.toHaveBeenCalled();

        const missingTarget = resolutionHarness({
            operationType: 'autotask.ticket.reply',
            resourceKey: 'new-ticket',
            step: 'reply_note'
        });
        await missingTarget.operationFence.reserve(missingTarget.scope);
        await missingTarget.operationFence.beginStep(Object.assign({}, missingTarget.scope, { step: 'reply_note' }));
        await expect(missingTarget.runtime.resolveOperationStepAbsent(missingTarget.input))
            .rejects.toMatchObject({ details: { code: 'provider_absence_resolution_target_invalid' } });
        expect(missingTarget.adapter.hasCustomerVisibleNoteOperationMarker).not.toHaveBeenCalled();
    });
});
