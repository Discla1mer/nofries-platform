'use strict';

const { createCustomerPortalService } = require('../api/shared/customerPortalService');
const { createAutotaskRuntime } = require('../api/shared/serviceDesk/autotaskRuntimeFactory');
const { createProviderOperationFence } = require('../api/shared/serviceDesk/providerOperationFence');

const TEST_ENV = {
    NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
    NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'governed',
    NOFRIES_AUTOTASK_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'scope-one',
    NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID: 'autotask-account-one',
    NOFRIES_AUTOTASK_USERNAME: 'integration@example.test',
    NOFRIES_AUTOTASK_INTEGRATION_CODE: 'integration-code'
};

function durableMemoryStore() {
    const ledgers = new Map();
    const identities = new Map();
    const terminalOperations = new Map();
    const terminalFingerprints = new Map();
    return {
        status() {
            return {
                provider: 'test_durable',
                configured: true,
                durable: true,
                crossInstanceExclusive: true,
                leaseRenewal: true,
                immutableOperationBinding: true,
                terminalReceiptArchive: true,
                boundedDuplicateIntentIndex: true,
                state: 'ready'
            };
        },
        async claimOperationIdentity(scope, binding) {
            const key = `${scope.tenantHash}:${scope.customerHash}:${binding.operationId}`;
            const value = { scopeKey: scope.key, operationType: binding.operationType, fingerprint: binding.fingerprint };
            const prior = identities.get(key);
            if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('operation identity rebound');
            identities.set(key, value);
        },
        async readTerminalOperation(scope, operationId) {
            return clone(terminalOperations.get(`${scope.tenantHash}:${scope.customerHash}:${operationId}`) || null);
        },
        async readTerminalFingerprint(scope, fingerprint, at) {
            const value = terminalFingerprints.get(`${scope.key}:${fingerprint}`);
            return value && Date.parse(value.expiresAt) > at.getTime() ? clone(value) : null;
        },
        async archiveTerminal(scope, record, at) {
            const receipt = {
                schemaVersion: 1,
                scopeKey: scope.key,
                operationId: record.operationId,
                operationType: record.operationType,
                fingerprint: record.fingerprint,
                status: 'completed',
                actorSubjectSha256: record.actorSubjectSha256 || '',
                requesterEmailSha256: record.requesterEmailSha256 || '',
                intakeChannel: record.intakeChannel || '',
                repeatedFromOperationId: record.repeatedFromOperationId || '',
                result: clone(record.result),
                createdAt: record.createdAt,
                completedAt: record.completedAt,
                expiresAt: new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
            };
            terminalOperations.set(`${scope.tenantHash}:${scope.customerHash}:${record.operationId}`, clone(receipt));
            terminalFingerprints.set(`${scope.key}:${record.fingerprint}`, clone(receipt));
            return clone(receipt);
        },
        async read(scope) {
            return clone(ledgers.get(scope.key) || emptyLedger(scope));
        },
        async update(scope, mutate) {
            const ledger = clone(ledgers.get(scope.key) || emptyLedger(scope));
            const result = await mutate(ledger);
            ledger.revision = Number(ledger.revision || 0) + 1;
            ledgers.set(scope.key, clone(ledger));
            return result;
        }
    };
}

function emptyLedger(scope) {
    return {
        schemaVersion: 2,
        scopeKey: scope.key,
        revision: 0,
        operations: {},
        operationTombstones: {},
        resourceLocks: {},
        repeatConfirmations: {},
        audit: []
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function fakeAdapter() {
    const tickets = [];
    let sequence = 0;
    const adapter = {
        createCount: 0,
        status() {
            return {
                configured: true,
                exactMappings: true,
                customerVisibleNotes: true,
                operationMarkerConfigured: true,
                portalVisibilityReady: true,
                priorityMapDigestVerified: true,
                statusWritesEnabled: false,
                state: 'ready'
            };
        },
        async listTickets() { return { tickets: tickets.map(clone) }; },
        async getTicketByNumber(input) {
            const value = tickets.find((ticket) => ticket.ticketNumber === input.ticketNumber && ticket.companyId === input.companyId);
            if (!value) throw providerNotFound();
            return clone(value);
        },
        async getTicketById(input) {
            const value = tickets.find((ticket) => ticket.id === input.ticketId && ticket.companyId === input.companyId);
            if (!value) throw providerNotFound();
            return clone(value);
        },
        async createTicket(input) {
            adapter.createCount += 1;
            sequence += 1;
            const ticket = {
                id: String(700 + sequence),
                ticketNumber: `T20260831.${String(sequence).padStart(4, '0')}`,
                companyId: input.companyId,
                portalVisible: true,
                device: '',
                status: 'new',
                priority: input.priority,
                portalVisible: true,
                subject: input.subject,
                createdAt: '2026-08-31T01:00:00.000Z',
                updatedAt: '2026-08-31T01:00:00.000Z',
                notes: [],
                providerVersion: `v${sequence}`,
                operationId: input.operationId
            };
            tickets.push(ticket);
            return clone(ticket);
        },
        async addCustomerVisibleNote(input) {
            const ticket = tickets.find((candidate) => candidate.id === input.ticketId);
            const note = {
                id: `note-${ticket.notes.length + 1}`,
                message: input.message,
                customerVisible: true,
                createdAt: '2026-08-31T01:01:00.000Z',
                operationId: input.operationId
            };
            ticket.notes.push(note);
            ticket.updatedAt = '2026-08-31T01:01:00.000Z';
            return clone(note);
        },
        async findTicketByOperationId(input) {
            const value = tickets.find((ticket) => ticket.operationId === input.operationId);
            return value ? clone(value) : null;
        },
        async findCustomerVisibleNoteByOperationId(input) {
            const ticket = tickets.find((candidate) => candidate.id === input.ticketId);
            const value = ticket && ticket.notes.find((note) => note.operationId === input.operationId);
            return value ? clone(value) : null;
        }
    };
    return adapter;
}

function providerNotFound() {
    const error = new Error('not found');
    error.statusCode = 404;
    error.details = { code: 'autotask_ticket_not_found', providerEffectAbsent: true };
    return error;
}

function customerAccess() {
    return {
        tenant: { id: 'workspace-one' },
        customer: {
            id: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-one',
            contactId: '20',
            displayName: 'Alpine Studio',
            timezone: 'Pacific/Auckland'
        },
        user: {
            subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
            identityTenantId: '11111111-1111-4111-8111-111111111111',
            name: 'Customer Admin',
            email: 'customer@example.test',
            role: 'customer_admin'
        }
    };
}

function lifecycleService() {
    return {
        async requireServiceDeskCustomer() { return { id: 'customer-one' }; },
        async resolveServiceDeskProviderBinding() {
            return { tenantId: 'workspace-one', customerId: 'customer-one', companyId: '10', providerScopeId: 'scope-one', contactId: '20', devices: [] };
        },
        async getOrganisation() {
            return {
                organisation: {
                    organisationId: 'customer-one',
                    customerMaster: {
                        externalRefs: [{
                            system: 'autotask',
                            recordType: 'company',
                            externalId: '10',
                            status: 'verified'
                        }]
                    },
                    proofPeriods: []
                }
            };
        }
    };
}

describe('customer portal through the production Autotask runtime', () => {
    test('separates idempotent replay from an explicitly confirmed intentional repeat', async () => {
        const adapter = fakeAdapter();
        const operationFence = createProviderOperationFence({ store: durableMemoryStore() });
        const autotask = createAutotaskRuntime({
            env: TEST_ENV,
            client: {
                status: () => ({ configured: true, writeOperationsEnabled: true, mode: 'production', state: 'ready' })
            },
            adapter,
            operationFence
        });
        const portal = createCustomerPortalService({
            ticketProvider: autotask,
            lifecycleService: lifecycleService(),
            env: TEST_ENV,
            buildProofView: () => ({ timezone: 'Pacific/Auckland', current: { state: 'not_issued' }, history: [] }),
            proofForPeriod: () => null
        });
        const request = {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            summary: 'Cannot open email',
            description: 'Outlook shows an authentication message.',
            priority: 'urgent'
        };

        const created = await portal.createTicket(customerAccess(), request);
        expect(created).toMatchObject({ status: 'completed', created: true, repeated: false });
        expect(created.ticket.priority).toBe('urgent');
        expect(adapter.createCount).toBe(1);

        const recovered = await portal.createTicket(customerAccess(), request);
        expect(recovered).toMatchObject({ status: 'completed', created: false, repeated: true });
        expect(recovered.ticket.ticketNumber).toBe(created.ticket.ticketNumber);
        expect(adapter.createCount).toBe(1);

        const intentional = await portal.createTicket(customerAccess(), Object.assign({}, request, {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
        }));
        expect(intentional).toMatchObject({
            status: 'confirmation_required',
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
            repeatConfirmationToken: expect.any(String)
        });
        expect(adapter.createCount).toBe(1);

        const confirmed = await portal.createTicket(customerAccess(), Object.assign({}, request, {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
            repeatConfirmationToken: intentional.repeatConfirmationToken
        }));
        expect(confirmed).toMatchObject({ status: 'completed', created: true });
        expect(confirmed.ticket.ticketNumber).not.toBe(created.ticket.ticketNumber);
        expect(adapter.createCount).toBe(2);
    });
});
