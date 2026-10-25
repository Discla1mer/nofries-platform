const { createProductionServiceDeskService } = require('../api/shared/serviceDesk/productionServiceDeskService');

function access() {
    return {
        allowed: true,
        tenant: { id: 'workspace-one', name: 'No Fries', slug: 'nofries' },
        user: {
            identityTenantId: '11111111-1111-4111-8111-111111111111',
            subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
            principalId: '22222222-2222-4222-8222-222222222222',
            email: 'operator@example.test',
            name: 'Operator',
            role: 'admin',
            capabilities: ['service-desk:read', 'service-desk:create', 'service-desk:execute']
        }
    };
}

function runtimeStatus() {
    return {
        provider: 'autotask',
        sourceOfTruth: true,
        configured: true,
        exactMappings: true,
        customerVisibleNotes: true,
        operationMarkerConfigured: true,
        portalVisibilityReady: true,
        priorityMappingVerified: true,
        durableOperationFence: true,
        crossInstanceExclusive: true,
        leaseRenewal: true,
        immutableOperationBinding: true,
        terminalReceiptArchive: true,
        boundedDuplicateIntentIndex: true,
        writeOperationsEnabled: true,
        statusWritesEnabled: false
    };
}

function ticket() {
    return {
        id: '700',
        ticketNumber: 'T20260831.0001',
        companyId: '10',
        status: 'new',
        priority: 'urgent',
        subject: 'Email issue',
        notes: [],
        projectionIssues: [],
        createdAt: '2026-08-31T01:00:00.000Z',
        updatedAt: '2026-08-31T01:00:00.000Z'
    };
}

describe('production operator service desk', () => {
    test('keeps the staff audit actor distinct from the authorised on-behalf requester and priority', async () => {
        const admissions = [];
        const contextProvider = {
            async resolveServiceDeskProviderBinding(_access, customerId, admission) {
                admissions.push(admission);
                return {
                    tenantId: 'workspace-one',
                    customerId,
                    companyId: '10',
                    providerScopeId: 'autotask-production',
                    contactId: '20',
                    devices: []
                };
            },
            async listServiceDeskCustomers() { return { revision: 1, customers: [] }; }
        };
        const runtime = {
            status: runtimeStatus,
            createTicket: jest.fn().mockResolvedValue({
                operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                status: 'completed',
                created: true,
                ticket: ticket()
            }),
            replyToTicket: jest.fn().mockResolvedValue({
                operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                status: 'completed',
                created: true,
                ticket: ticket()
            })
        };
        const service = createProductionServiceDeskService({
            env: {
                NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
                NOFRIES_AUTOTASK_TENANT_ID: '11111111-1111-4111-8111-111111111111',
                NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'autotask-production'
            },
            contextProvider,
            runtime
        });

        await service.createTicket(access(), {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            customerId: 'customer-one',
            requesterEmail: 'requester@example.test',
            intakeChannel: 'portal',
            subject: 'Email issue',
            requestText: 'Cannot authenticate',
            priority: 'urgent'
        });
        expect(runtime.createTicket).toHaveBeenCalledWith(expect.objectContaining({
            priority: 'urgent',
            requesterEmail: 'requester@example.test',
            intakeChannel: 'portal',
            actor: expect.objectContaining({
                subjectKey: access().user.subjectKey,
                email: 'operator@example.test',
                source: 'staff_service_desk'
            })
        }));
        expect(admissions[0]).toMatchObject({ requesterEmail: 'requester@example.test', intakeChannel: 'portal' });

        await service.replyToTicket(access(), 'T20260831.0001', {
            operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            customerId: 'customer-one',
            contactId: '999',
            message: 'We are investigating.'
        });
        expect(admissions[1]).toEqual({});
        expect(runtime.replyToTicket).toHaveBeenCalledWith(expect.objectContaining({
            actor: expect.objectContaining({ source: 'staff_service_desk', email: 'operator@example.test' })
        }));
        expect(runtime.replyToTicket.mock.calls[0][0]).not.toHaveProperty('contactId');
    });

    test('rejects a provider binding that collides with the selected internal customer', async () => {
        const service = createProductionServiceDeskService({
            env: {
                NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
                NOFRIES_AUTOTASK_TENANT_ID: '11111111-1111-4111-8111-111111111111',
                NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'autotask-production'
            },
            contextProvider: {
                async resolveServiceDeskProviderBinding() {
                    return {
                        tenantId: 'workspace-one',
                        customerId: 'different-customer',
                        companyId: '10',
                        providerScopeId: 'autotask-production',
                        devices: []
                    };
                },
                async listServiceDeskCustomers() { return { revision: 1, customers: [] }; }
            },
            runtime: { status: runtimeStatus }
        });
        await expect(service.createTicket(access(), {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            customerId: 'customer-one',
            requesterEmail: 'requester@example.test',
            subject: 'Email issue',
            requestText: 'Cannot authenticate',
            priority: 'normal'
        })).rejects.toMatchObject({ details: { code: 'service_desk_provider_binding_required' } });
    });
});
