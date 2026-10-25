const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');

const NOW = '2026-08-31T12:00:00.000Z';

describe('customer portal governed lifecycle provider binding', () => {
    test('requires the portal contact to be a current verified Autotask contact on the same customer and provider scope', async () => {
        const organisation = eligibleCustomer();
        const repository = {
            read: jest.fn(async () => ({ organisations: [organisation] }))
        };
        const service = createLifecycleService({
            repository,
            now: () => new Date(NOW),
            env: {
                NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'scope-one',
                NOFRIES_AUTOTASK_DEVICE_MAP_JSON: JSON.stringify({ '10:datto-device-one': '1001' })
            }
        });
        const admission = {
            requesterEmail: 'customer@example.test',
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Verified authenticated customer portal identity',
            requesterVerificationRef: 'identity:portal-customer-one',
            contactId: '20',
            requireAutotaskContact: true
        };

        await expect(service.resolveServiceDeskProviderBinding(access(), 'customer-one', admission)).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'autotask_contact_mapping_required' }
        });

        organisation.customerMaster.externalRefs.push(verifiedAutotaskRef('contact', '20'));
        await expect(service.resolveServiceDeskProviderBinding(access(), 'customer-one', admission)).resolves.toEqual({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            contactId: '20',
            providerScopeId: 'scope-one',
            devices: [{
                id: 'device-one',
                dattoDeviceUid: 'datto-device-one',
                autotaskInstalledProductId: '1001',
                companyId: '10'
            }]
        });
    });
});

function eligibleCustomer() {
    return {
        id: 'customer-one',
        displayName: 'Customer One',
        recordType: 'customer',
        lifecycleState: 'active',
        createdAt: '2026-08-01T00:00:00.000Z',
        serviceStatus: { state: 'active' },
        onboarding: {
            kind: 'external',
            status: 'complete',
            devices: [{
                id: 'device-one',
                label: 'Customer laptop',
                platform: 'windows',
                status: 'verified',
                matchStatus: 'confirmed',
                providerRefs: [{ system: 'datto_rmm', externalId: 'datto-device-one' }],
                sourceSnapshotId: 'snapshot-one'
            }]
        },
        integrations: {
            dattoRmm: {
                status: 'linked',
                truncated: false,
                capturedAt: NOW,
                reconciliationStatus: 'matched',
                snapshotId: 'snapshot-one',
                devices: [{ uid: 'datto-device-one' }]
            }
        },
        supportProfile: {
            contractStatus: 'signed',
            serviceStartAt: '2026-08-01T00:00:00.000Z',
            slaScheduleRef: 'contract-register:customer-one:sla',
            channels: ['portal'],
            authorisedRequesters: [{
                name: 'Customer Admin',
                email: 'customer@example.test',
                role: 'Customer administrator',
                effectiveFrom: '2026-08-01T00:00:00.000Z'
            }]
        },
        customerMaster: {
            customerId: 'proof-customer-one',
            serviceSchedule: {
                agreementId: 'agreement-one',
                version: 'v1',
                contentHash: 'a'.repeat(64),
                startAt: '2026-08-01T00:00:00.000Z',
                slaId: 'sla-one'
            },
            externalRefs: [
                verifiedExternalRef('hubspot', 'company', 'hubspot-company-one'),
                verifiedAutotaskRef('account', '10')
            ]
        }
    };
}

function verifiedAutotaskRef(recordType, externalId) {
    return verifiedExternalRef('autotask', recordType, externalId, 'scope-one');
}

function verifiedExternalRef(system, recordType, externalId, providerScopeId = '') {
    return {
        system,
        recordType,
        externalId,
        providerScopeId,
        status: 'verified',
        verificationMode: 'manual',
        verifiedAt: '2026-08-30T12:00:00.000Z',
        verifiedBy: 'service-owner@example.test',
        evidenceRef: `crosswalk-register:${system}:${recordType}:${externalId}`,
        createdAt: '2026-08-30T12:00:00.000Z'
    };
}

function access() {
    return {
        user: { email: 'customer@example.test' },
        tenant: { id: 'workspace-one' }
    };
}
