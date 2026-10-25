const {
    assertServiceDeskProviderAdmission
} = require('../api/shared/serviceDesk/serviceDeskProviderAdmission');

function env(overrides = {}) {
    return Object.assign({
        NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
        NOFRIES_AUTOTASK_TENANT_ID: 'tenant-one'
    }, overrides);
}

function runtime(overrides = {}) {
    return Object.assign({
        provider: 'autotask',
        sourceOfTruth: true,
        configured: true,
        writeOperationsEnabled: true,
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
        boundedDuplicateIntentIndex: true
    }, overrides);
}

const access = { tenant: { id: 'workspace-one' }, user: { identityTenantId: 'tenant-one' } };
const binding = { tenantId: 'workspace-one', customerId: 'customer-one', companyId: '10' };

describe('production service desk admission', () => {
    test('admits only the exact tenant-bound durable Autotask source of truth', () => {
        expect(assertServiceDeskProviderAdmission({ env: env(), access, binding, runtimeStatus: runtime(), operation: 'write' }))
            .toMatchObject({ admitted: true, provider: 'autotask', operation: 'write' });
    });

    test.each([
        [env({ NOFRIES_SERVICE_DESK_PROVIDER: 'mock' }), runtime(), 'service_desk_provider_not_selected'],
        [env({ NOFRIES_AUTOTASK_TENANT_ID: 'tenant-two' }), runtime(), 'autotask_tenant_binding_mismatch'],
        [env(), runtime({ durableOperationFence: false }), 'service_desk_provider_not_ready'],
        [env(), runtime({ writeOperationsEnabled: false }), 'service_desk_writes_disabled']
    ])('fails closed for a missing production control', (environment, current, code) => {
        expect(() => assertServiceDeskProviderAdmission({ env: environment, access, binding, runtimeStatus: current, operation: 'write' }))
            .toThrow(expect.objectContaining({ details: { code } }));
    });
});
