'use strict';

const {
    parseCustomerPortalMemberships,
    resolveCustomerPortalAccess
} = require('../api/shared/customerPortalAccess');
const {
    createCustomerPortalService,
    projectTicketDetail
} = require('../api/shared/customerPortalService');
const {
    assertCustomerPortalProofRuntimeReady,
    assertCustomerPortalRuntimeEnabled,
    assertCustomerPortalWriteSubjectScope,
    customerPortalBootstrapProofAvailable,
    customerPortalCreateStatus
} = require('../api/shared/customerPortalRuntime');
const { canonicalHash } = require('../api/shared/lifecycle/customerOperations');

const IDENTITY_TENANT = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = '22222222-2222-4222-8222-222222222222';
const OTHER_PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const SUBJECT = `${IDENTITY_TENANT}:${PRINCIPAL}`;
const CREATE_OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const REPLY_OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

function env() {
    return {
        NOFRIES_ENTRA_TENANT_ID: IDENTITY_TENANT,
        NOFRIES_DEFAULT_TENANT_ID: 'workspace-one',
        NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'scope-one',
        NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS: JSON.stringify([{
            subjectKey: SUBJECT,
            workspaceTenantId: 'workspace-one',
            workspaceName: 'No Fries production',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-one',
            contactId: '20',
            displayName: 'Alpine Studio',
            timezone: 'Pacific/Auckland',
            role: 'customer_admin'
        }])
    };
}

function identity(overrides = {}) {
    return Object.assign({
        provider: 'entra-bff',
        tenantId: IDENTITY_TENANT,
        principalId: PRINCIPAL,
        subjectKey: SUBJECT,
        email: 'customer@example.test',
        name: 'Customer User',
        isAuthenticated: true
    }, overrides);
}

function access() {
    const value = resolveCustomerPortalAccess(identity(), env());
    expect(value.allowed).toBe(true);
    return value;
}

function ticket(overrides = {}) {
    return Object.assign({
        id: 'provider-internal-id',
        ticketNumber: 'T20260831.0012',
        companyId: '10',
        portalVisible: true,
        subject: 'Cannot open email',
        status: 'In Progress',
        priority: 'High',
        device: 'Alex laptop',
        createdAt: '2026-08-30T02:00:00.000Z',
        updatedAt: '2026-08-31T02:00:00.000Z',
        description: 'Raw customer description that must never be returned',
        diagnostics: { secret: 'operator-only' },
        notes: [
            { id: 'visible', message: 'We are checking this now.', customerVisible: true, createdAt: '2026-08-31T02:01:00Z' },
            { id: 'internal', message: 'Internal escalation details', customerVisible: false, createdAt: '2026-08-31T02:02:00Z' },
            { id: 'internal-override', message: 'Never publish', customerVisible: true, internal: true, createdAt: '2026-08-31T02:03:00Z' },
            { id: 'unmarked', message: 'No positive visibility flag', createdAt: '2026-08-31T02:04:00Z' },
            { id: 'raw-description', description: 'Raw note description', customerVisible: true, createdAt: '2026-08-31T02:05:00Z' },
            { id: 'alias-visible', message: 'Non-canonical visibility alias', publishToCustomer: true, createdAt: '2026-08-31T02:06:00Z' }
        ]
    }, overrides);
}

function service(providerOverrides = {}) {
    const ticketProvider = Object.assign({
        listTickets: jest.fn(async () => ({ tickets: [ticket()] })),
        getTicketByNumber: jest.fn(async () => ({ ticket: ticket() })),
        getOperationStatus: jest.fn(async (input) => ({
            operationId: input.operationId,
            status: 'pending',
            terminal: false,
            retrySameOperation: true,
            idempotentReplay: false,
            repeatedFromOperationId: ''
        })),
        createTicket: jest.fn(async (input) => ({
            operationId: input.operationId,
            status: 'completed',
            ticket: ticket({ ticketNumber: 'T20260831.0013', subject: input.subject })
        })),
        replyToTicket: jest.fn(async (input) => ({
            operationId: input.operationId,
            status: 'completed',
            ticket: ticket({ notes: [{ message: input.message, customerVisible: true, createdAt: '2026-08-31T03:00:00Z' }] })
        }))
    }, providerOverrides);
    const lifecycleService = {
        requireServiceDeskCustomer: jest.fn(async () => ({ id: 'customer-one' })),
        resolveServiceDeskProviderBinding: jest.fn(async () => ({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-one',
            contactId: '20',
            devices: []
        })),
        getOrganisation: jest.fn(async () => ({
            organisation: {
                organisationId: 'customer-one',
                proofPeriods: [],
                customerMaster: {
                    externalRefs: [{
                        system: 'autotask',
                        recordType: 'company',
                        externalId: '10',
                        status: 'verified'
                    }]
                }
            }
        }))
    };
    const providerAdmission = jest.fn();
    const portal = createCustomerPortalService({
        ticketProvider,
        lifecycleService,
        providerAdmission,
        buildProofView: () => ({
            timezone: 'Pacific/Auckland',
            current: { period: '2026-07', state: 'not_issued', report: null },
            history: []
        }),
        proofForPeriod: (_organisation, period) => period === '2026-06' ? { period, status: 'issued' } : null
    });
    return { portal, ticketProvider, lifecycleService, providerAdmission };
}

describe('customer portal immutable membership', () => {
    test('authorises only the exact canonical tid:oid subject and derives customer scope from membership', () => {
        expect(resolveCustomerPortalAccess(identity({ email: 'forged-admin@nofries.nz' }), env())).toMatchObject({
            allowed: true,
            user: { actorId: SUBJECT, role: 'customer_admin' },
            tenant: { id: 'workspace-one' },
            customer: { id: 'customer-one', companyId: '10', providerScopeId: 'scope-one' }
        });

        const wrongSubject = `${IDENTITY_TENANT}:${OTHER_PRINCIPAL}`;
        expect(resolveCustomerPortalAccess(identity({
            principalId: OTHER_PRINCIPAL,
            subjectKey: wrongSubject,
            email: 'customer@example.test'
        }), env())).toMatchObject({ allowed: false, reason: 'customer_membership_required' });
    });

    test('rejects a mismatched subject claim, non-BFF identity, duplicates and malformed configuration', () => {
        expect(resolveCustomerPortalAccess(identity({ subjectKey: `${IDENTITY_TENANT}:${OTHER_PRINCIPAL}` }), env()))
            .toMatchObject({ allowed: false, reason: 'immutable_subject_required' });
        expect(resolveCustomerPortalAccess(identity({ provider: 'azure-static-web-apps' }), env()))
            .toMatchObject({ allowed: false, reason: 'immutable_subject_required' });
        expect(parseCustomerPortalMemberships('not-json')).toEqual([]);
        expect(parseCustomerPortalMemberships(JSON.stringify({
            [SUBJECT]: JSON.parse(env().NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)[0]
        }))).toEqual([]);
        expect(parseCustomerPortalMemberships(JSON.stringify([
            JSON.parse(env().NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)[0],
            JSON.parse(env().NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)[0]
        ]))).toEqual([]);
    });

    test.each(['0', '01', '9007199254740992', '-1', '1.5'])('rejects a non-canonical or unsafe provider company ID (%s)', (companyId) => {
        const membership = JSON.parse(env().NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)[0];
        membership.companyId = companyId;
        const configured = Object.assign(env(), {
            NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS: JSON.stringify([membership])
        });
        expect(parseCustomerPortalMemberships(configured.NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)).toEqual([]);
        expect(resolveCustomerPortalAccess(identity(), configured)).toMatchObject({
            allowed: false,
            reason: 'customer_membership_not_configured'
        });
    });

    test.each(['', '00', '9007199254740992', 'contact-20'])('rejects a missing or non-canonical governed contact ID (%s)', (contactId) => {
        const membership = JSON.parse(env().NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS)[0];
        membership.contactId = contactId;
        expect(parseCustomerPortalMemberships(JSON.stringify([membership]))).toEqual([]);
    });

    test.each([
        ['identity tenant', { NOFRIES_ENTRA_TENANT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'identity_tenant_mismatch'],
        ['workspace', { NOFRIES_DEFAULT_TENANT_ID: 'workspace-two' }, 'customer_workspace_mismatch'],
        ['provider scope', { NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'scope-two' }, 'customer_provider_scope_mismatch']
    ])('denies a membership bound to the wrong deployment %s', (_name, overrides, reason) => {
        expect(resolveCustomerPortalAccess(identity(), Object.assign(env(), overrides)))
            .toMatchObject({ allowed: false, reason });
    });

    test('fails closed when any deployment identity, workspace or provider binding is absent', () => {
        const incomplete = env();
        delete incomplete.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID;
        expect(resolveCustomerPortalAccess(identity(), incomplete)).toMatchObject({
            allowed: false,
            reason: 'customer_deployment_binding_not_configured'
        });
    });

    test.each(['', 'not-an-email', 'customer@localhost'])('fails closed without a verified requester email (%s)', (email) => {
        expect(resolveCustomerPortalAccess(identity({ email }), env())).toMatchObject({
            allowed: false,
            reason: 'verified_requester_email_required'
        });
    });
});

describe('customer portal emergency runtime controls', () => {
    test('fails closed for all reads unless the portal is explicitly enabled', () => {
        expect(() => assertCustomerPortalRuntimeEnabled({}, false)).toThrow(expect.objectContaining({
            statusCode: 503,
            details: { code: 'customer_portal_disabled' }
        }));
        expect(() => assertCustomerPortalRuntimeEnabled({ NOFRIES_CUSTOMER_PORTAL_ENABLED: 'false' }, false))
            .toThrow(expect.objectContaining({ details: { code: 'customer_portal_disabled' } }));
    });

    test('allows reads but blocks writes unless the independent write gate is explicitly enabled', () => {
        const readsOnly = { NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true' };
        expect(() => assertCustomerPortalRuntimeEnabled(readsOnly, false)).not.toThrow();
        expect(() => assertCustomerPortalRuntimeEnabled(readsOnly, true)).toThrow(expect.objectContaining({
            statusCode: 503,
            details: { code: 'customer_portal_writes_disabled' }
        }));
        expect(() => assertCustomerPortalRuntimeEnabled({
            NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true',
            NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'true',
            NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'governed'
        }, true)).not.toThrow();
    });

    test('strictly gates Proof routes while tickets and bootstrap degrade independently', () => {
        const unavailable = () => { throw new Error('scheduler unavailable'); };
        expect(() => assertCustomerPortalProofRuntimeReady({}, 'bootstrap', 'GET', unavailable)).not.toThrow();
        expect(() => assertCustomerPortalProofRuntimeReady({}, 'proof/current', 'GET', unavailable))
            .toThrow(expect.objectContaining({ statusCode: 503, details: { code: 'monthly_proof_runtime_unavailable' } }));
        expect(() => assertCustomerPortalProofRuntimeReady({}, 'tickets', 'POST', unavailable)).not.toThrow();
        expect(() => assertCustomerPortalProofRuntimeReady({}, 'tickets', 'GET', unavailable)).not.toThrow();
        expect(() => assertCustomerPortalProofRuntimeReady({ NOFRIES_REQUIRE_AUTH: 'false' }, 'bootstrap', 'GET', unavailable)).not.toThrow();
        expect(customerPortalBootstrapProofAvailable({}, unavailable)).toBe(false);
        expect(customerPortalBootstrapProofAvailable({}, () => ({ status: 'ready' }))).toBe(true);
    });

    test('preserves integrity-checked issued Proof reads only for the exact emergency read-only vector', () => {
        const emergency = {
            NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true',
            NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'false',
            NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'disabled',
            NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'disabled',
            NOFRIES_AUTOTASK_MODE: 'readonly',
            NOFRIES_AUTOTASK_WRITE_ENABLED: 'false',
            NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'false',
            NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
        };
        const unavailable = () => { throw new Error('scheduler unavailable'); };
        const disabledHealth = () => ({ enabled: false, status: 'disabled' });
        expect(assertCustomerPortalProofRuntimeReady(
            emergency, 'proof/current', 'GET', unavailable, disabledHealth
        )).toEqual({ enabled: false, status: 'disabled' });
        expect(customerPortalBootstrapProofAvailable(emergency, unavailable, disabledHealth)).toBe(true);
        expect(() => assertCustomerPortalProofRuntimeReady(
            { ...emergency, NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'local' },
            'proof/current', 'GET', unavailable, disabledHealth
        )).toThrow(expect.objectContaining({ details: { code: 'monthly_proof_runtime_unavailable' } }));
    });

    test('uses an exact canary subject before opening governed customer-admin writes', () => {
        const base = {
            NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true',
            NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'true',
            NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'canary',
            NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS: JSON.stringify([SUBJECT])
        };
        expect(() => assertCustomerPortalRuntimeEnabled(base, true)).not.toThrow();
        expect(() => assertCustomerPortalWriteSubjectScope(base, access(), true)).not.toThrow();
        expect(() => assertCustomerPortalWriteSubjectScope(Object.assign({}, base, {
            NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS: JSON.stringify([`${IDENTITY_TENANT}:${OTHER_PRINCIPAL}`])
        }), access(), true)).toThrow(expect.objectContaining({
            statusCode: 403,
            details: { code: 'customer_portal_write_scope_denied' }
        }));
        expect(() => assertCustomerPortalRuntimeEnabled(Object.assign({}, base, {
            NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS: '@Microsoft.KeyVault(VaultName=unresolved)'
        }), true)).toThrow(expect.objectContaining({ details: { code: 'customer_portal_canary_subjects_invalid' } }));
        expect(() => assertCustomerPortalRuntimeEnabled(Object.assign({}, base, {
            NOFRIES_CUSTOMER_PORTAL_CANARY_SUBJECTS: JSON.stringify([SUBJECT, SUBJECT])
        }), true)).toThrow(expect.objectContaining({ details: { code: 'customer_portal_canary_subjects_invalid' } }));

        const governed = Object.assign({}, base, { NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'governed' });
        expect(() => assertCustomerPortalWriteSubjectScope(governed, access(), true)).not.toThrow();
        expect(() => assertCustomerPortalWriteSubjectScope(governed, {
            user: { role: 'customer_user', subjectKey: SUBJECT }
        }, true)).toThrow(expect.objectContaining({ details: { code: 'customer_portal_write_scope_denied' } }));
    });
});

describe('customer portal create HTTP semantics', () => {
    test('uses 201 only for a new ticket, 200 for idempotent recovery and 202 while unresolved', () => {
        expect(customerPortalCreateStatus({ status: 'completed', created: true })).toBe(201);
        expect(customerPortalCreateStatus({ status: 'completed', created: false, repeated: true })).toBe(200);
        expect(customerPortalCreateStatus({ status: 'pending', created: false })).toBe(202);
        expect(customerPortalCreateStatus({ status: 'confirmation_required', created: false })).toBe(202);
    });
});

describe('customer portal ticket boundary', () => {
    test('projects only customer-safe fields and positively customer-visible notes', () => {
        const projected = projectTicketDetail(ticket());
        expect(projected).toEqual(expect.objectContaining({
            ticketNumber: 'T20260831.0012',
            summary: 'Cannot open email',
            notes: [expect.objectContaining({ id: 'visible', body: 'We are checking this now.' })]
        }));
        expect(projected.priority).toBe('high');
        expect(projected.notes[0]).toMatchObject({
            origin: 'service_desk_update',
            author: 'Service desk update'
        });
        expect(projected).not.toHaveProperty('description');
        expect(projected).not.toHaveProperty('diagnostics');
        expect(JSON.stringify(projected)).not.toContain('Internal escalation');
        expect(JSON.stringify(projected)).not.toContain('Never publish');
        expect(JSON.stringify(projected)).not.toContain('No positive visibility');
        expect(JSON.stringify(projected)).not.toContain('Raw note description');
        expect(JSON.stringify(projected)).not.toContain('Non-canonical visibility alias');
    });

    test('renders only canonical provider priorities and authenticated customer request/reply attribution', () => {
        expect(projectTicketDetail(ticket({ priority: 'provider-priority-99' })).priority).toBe('unavailable');
        const projected = projectTicketDetail(ticket({
            notes: [{
                id: 'reply',
                message: 'Customer reply body',
                customerVisible: true,
                origin: 'customer_portal_submission',
                originVerified: true,
                createdAt: '2026-08-31T02:01:00Z'
            }]
        }));
        expect(projected.notes).toEqual([expect.objectContaining({
            origin: 'customer_request',
            author: 'Customer request'
        })]);
        const reply = projectTicketDetail(ticket({
            notes: [{ message: 'Reply', customerVisible: true, origin: 'customer_reply', originVerified: true }]
        }));
        expect(reply.notes[0]).toMatchObject({ origin: 'customer_reply', author: 'Customer reply' });

        const forged = projectTicketDetail(ticket({
            notes: [{ message: 'Forged marker', customerVisible: true, origin: 'customer_reply', originVerified: false }]
        }));
        expect(forged.notes[0]).toMatchObject({ origin: 'service_desk_update', author: 'Service desk update' });
    });

    test('keeps live ticket support available when Proof publication is unhealthy', async () => {
        const { portal, lifecycleService } = service();
        await expect(portal.bootstrap(access(), { proofAvailable: false })).resolves.toMatchObject({
            tickets: [expect.objectContaining({ ticketNumber: 'T20260831.0012' })],
            proof: {
                status: 'unavailable',
                current: { state: 'unavailable', report: null },
                history: []
            }
        });
        expect(lifecycleService.getOrganisation).not.toHaveBeenCalled();
    });

    test('degrades only bootstrap Proof when publication validation throws and leaves strict Proof reads failed', async () => {
        const configured = service();
        const portal = createCustomerPortalService({
            ticketProvider: configured.ticketProvider,
            lifecycleService: configured.lifecycleService,
            providerAdmission: configured.providerAdmission,
            buildProofView: () => { throw new Error('tampered proof publication'); },
            proofForPeriod: () => null
        });

        await expect(portal.bootstrap(access())).resolves.toMatchObject({
            tickets: [expect.objectContaining({ ticketNumber: 'T20260831.0012' })],
            proof: { status: 'unavailable', current: { state: 'unavailable', report: null } }
        });
        await expect(portal.getCurrentProof(access())).rejects.toThrow('tampered proof publication');
    });

    test('filters list results to the immutable company and masks cross-company detail as the same 404', async () => {
        const { portal } = service({
            listTickets: jest.fn(async () => ({ tickets: [
                ticket(),
                ticket({ ticketNumber: 'OTHER.1', companyId: 'other-company' }),
                ticket({ ticketNumber: 'INTERNAL.1', portalVisible: false })
            ] })),
            getTicketByNumber: jest.fn(async () => ({
                ticket: ticket({ companyId: 'other-company' })
            }))
        });
        await expect(portal.listTickets(access())).resolves.toMatchObject({
            tickets: [expect.objectContaining({ ticketNumber: 'T20260831.0012' })],
            openCount: 1
        });
        await expect(portal.getTicket(access(), 'T20260831.0012')).rejects.toMatchObject({
            statusCode: 404,
            details: { code: 'ticket_not_found' }
        });
    });

    test('masks a same-company internal-only ticket behind the same 404', async () => {
        expect(projectTicketDetail(ticket({ portalVisible: false }))).toBeNull();
        const { portal } = service({
            getTicketByNumber: jest.fn(async () => ({
                ticket: ticket({ ticketNumber: 'INTERNAL.1', portalVisible: false })
            }))
        });
        await expect(portal.getTicket(access(), 'INTERNAL.1')).rejects.toMatchObject({
            statusCode: 404,
            details: { code: 'ticket_not_found' }
        });
    });

    test.each([
        ['inactive', 'active_service_required'],
        ['offboarded', 'active_service_status_required'],
        ['expired SLA', 'signed_sla_required'],
        ['stale RMM', 'fresh_rmm_reconciliation_required'],
        ['missing Autotask mapping', 'autotask_company_mapping_required']
    ])('fails closed when governed lifecycle eligibility is %s', async (_name, code) => {
        const { portal, lifecycleService, ticketProvider } = service();
        const error = new Error('Customer service is not eligible');
        error.statusCode = 409;
        error.details = { code };
        lifecycleService.resolveServiceDeskProviderBinding.mockRejectedValueOnce(error);
        await expect(portal.listTickets(access())).rejects.toMatchObject({
            statusCode: 409,
            details: { code }
        });
        expect(ticketProvider.listTickets).not.toHaveBeenCalled();
    });

    test('treats membership company scope as secondary to the governed provider binding', async () => {
        const { portal, lifecycleService, ticketProvider } = service();
        lifecycleService.resolveServiceDeskProviderBinding.mockResolvedValueOnce({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '99',
            providerScopeId: 'scope-one',
            devices: []
        });
        await expect(portal.listTickets(access())).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'customer_portal_binding_unavailable' }
        });
        expect(ticketProvider.listTickets).not.toHaveBeenCalled();
    });

    test('rejects a provider-scope rebind before any provider request', async () => {
        const { portal, lifecycleService, ticketProvider, providerAdmission } = service();
        lifecycleService.resolveServiceDeskProviderBinding.mockResolvedValueOnce({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-two',
            devices: []
        });
        await expect(portal.listTickets(access())).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'customer_portal_binding_unavailable' }
        });
        expect(providerAdmission).not.toHaveBeenCalled();
        expect(ticketProvider.listTickets).not.toHaveBeenCalled();
    });

    test('runs provider admission with the governed scope for reads and writes', async () => {
        const { portal, providerAdmission, lifecycleService } = service();
        await portal.listTickets(access());
        await portal.createTicket(access(), {
            summary: 'Priority support',
            description: 'This request exercises governed write admission.',
            priority: 'high',
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'
        });
        expect(providerAdmission).toHaveBeenNthCalledWith(1, expect.objectContaining({
            operation: 'read',
            binding: expect.objectContaining({ providerScopeId: 'scope-one' })
        }));
        expect(providerAdmission).toHaveBeenNthCalledWith(2, expect.objectContaining({
            operation: 'write',
            binding: expect.objectContaining({ providerScopeId: 'scope-one' })
        }));
        expect(lifecycleService.resolveServiceDeskProviderBinding).toHaveBeenNthCalledWith(2, expect.anything(), 'customer-one', expect.objectContaining({
            contactId: '20',
            requesterEmail: 'customer@example.test',
            requireAutotaskContact: true
        }));
    });

    test('rejects a governed contact rebind before a portal write reaches Autotask', async () => {
        const { portal, lifecycleService, ticketProvider } = service();
        lifecycleService.resolveServiceDeskProviderBinding.mockResolvedValueOnce({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-one',
            contactId: '21',
            devices: []
        });
        await expect(portal.createTicket(access(), {
            summary: 'Contact binding test',
            description: 'This live write must use the governed requester contact.',
            priority: 'normal',
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10'
        })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'customer_portal_binding_unavailable' }
        });
        expect(ticketProvider.createTicket).not.toHaveBeenCalled();
    });

    test('requires an exact ticket number instead of fuzzy or case-insensitive matching', async () => {
        const { portal, ticketProvider } = service();
        await expect(portal.getTicket(access(), 't20260831.0012')).rejects.toMatchObject({
            statusCode: 404,
            details: { code: 'ticket_not_found' }
        });
        expect(ticketProvider.getTicketByNumber).toHaveBeenCalledWith(expect.objectContaining({
            companyId: '10',
            ticketNumber: 't20260831.0012'
        }));
    });

    test('polls only the actor-bound durable operation in the governed customer scope and drops internal state', async () => {
        const getOperationStatus = jest.fn(async (input) => ({
            operationId: input.operationId,
            status: 'completed',
            terminal: true,
            retrySameOperation: false,
            idempotentReplay: true,
            repeatedFromOperationId: '',
            providerState: 'completed',
            steps: [{ name: 'ticket_create', checkpoint: { ticketId: 'provider-secret' } }]
        }));
        const { portal } = service({ getOperationStatus });
        const result = await portal.getOperationStatus(access(), CREATE_OPERATION);
        expect(getOperationStatus).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            providerScopeId: 'scope-one',
            portalVisibleOnly: true,
            operationId: CREATE_OPERATION,
            actor: expect.objectContaining({ actorId: SUBJECT, email: 'customer@example.test' })
        }));
        expect(result).toEqual({
            operationId: CREATE_OPERATION,
            status: 'completed',
            terminal: true,
            retrySameOperation: false,
            idempotentReplay: true,
            repeatedFromOperationId: ''
        });
        expect(result).not.toHaveProperty('providerState');
        expect(result).not.toHaveProperty('steps');
    });

    test('rejects a mismatched operation status response instead of adopting another operation', async () => {
        const { portal } = service({
            getOperationStatus: jest.fn(async () => ({
                operationId: REPLY_OPERATION,
                status: 'completed'
            }))
        });
        await expect(portal.getOperationStatus(access(), CREATE_OPERATION)).rejects.toMatchObject({
            statusCode: 502,
            details: { code: 'operation_status_response_invalid' }
        });
    });

    test('derives actor and customer fields and omits repeat confirmation on first create', async () => {
        const { portal, ticketProvider } = service();
        const result = await portal.createTicket(access(), {
            customerId: 'other-customer',
            companyId: 'other-company',
            actor: { actorId: 'forged' },
            summary: 'New starter access',
            description: 'Please prepare the approved standard apps.',
            priority: 'urgent',
            operationId: CREATE_OPERATION
        });
        expect(result.status).toBe('completed');
        expect(ticketProvider.createTicket).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'workspace-one',
            customerId: 'customer-one',
            companyId: '10',
            contactId: '20',
            operationId: CREATE_OPERATION,
            repeatConfirmationToken: undefined,
            subject: 'New starter access',
            requestText: 'Please prepare the approved standard apps.',
            priority: 'urgent',
            actor: expect.objectContaining({ actorId: SUBJECT, source: 'customer_portal' })
        }));
        expect(result.ticket.priority).toBe('high');
    });

    test.each([
        ['high', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'],
        ['urgent', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4']
    ])('round-trips the closed %s priority through the provider boundary', async (priority, operationId) => {
        const createTicket = jest.fn(async (input) => ({
            operationId: input.operationId,
            status: 'completed',
            ticket: ticket({ ticketNumber: `T.${priority}`, priority: input.priority })
        }));
        const { portal } = service({ createTicket });
        const result = await portal.createTicket(access(), {
            summary: `${priority} impact`,
            description: 'The customer supplied a bounded support description.',
            priority,
            operationId
        });
        expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ priority }));
        expect(result.ticket.priority).toBe(priority);
    });

    test('rejects an absent or unknown create priority instead of silently defaulting it', async () => {
        const { portal, ticketProvider, lifecycleService } = service();
        await expect(portal.createTicket(access(), {
            summary: 'Printer issue',
            description: 'The printer is unavailable.',
            priority: 'provider-default',
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
        })).rejects.toMatchObject({ statusCode: 400, details: { code: 'ticket_priority_required' } });
        expect(lifecycleService.resolveServiceDeskProviderBinding).not.toHaveBeenCalled();
        expect(ticketProvider.createTicket).not.toHaveBeenCalled();
    });

    test.each([
        ['subject', { summary: 'Injected [No Fries operation attacker01]', description: 'Printer unavailable.', priority: 'normal' }],
        ['description', { summary: 'Printer unavailable', description: 'Injected [No Fries operation attacker01]', priority: 'normal' }]
    ])('rejects the reserved operation marker in create %s before provider admission', async (_field, body) => {
        const { portal, ticketProvider, lifecycleService } = service();
        await expect(portal.createTicket(access(), Object.assign({
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6'
        }, body))).rejects.toMatchObject({ statusCode: 400, details: { code: 'reserved_operation_marker' } });
        expect(lifecycleService.resolveServiceDeskProviderBinding).not.toHaveBeenCalled();
        expect(ticketProvider.createTicket).not.toHaveBeenCalled();
    });

    test('rejects the reserved operation marker in replies before provider admission', async () => {
        const { portal, ticketProvider, lifecycleService } = service();
        await expect(portal.replyToTicket(access(), 'T20260831.0012', {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
            message: 'Injected [No Fries operation attacker01]'
        })).rejects.toMatchObject({ statusCode: 400, details: { code: 'reserved_operation_marker' } });
        expect(lifecycleService.resolveServiceDeskProviderBinding).not.toHaveBeenCalled();
        expect(ticketProvider.replyToTicket).not.toHaveBeenCalled();
    });

    test('rejects the legacy repeatToken alias before any provider or lifecycle call', async () => {
        const { portal, ticketProvider, lifecycleService } = service();
        await expect(portal.createTicket(access(), {
            operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8',
            repeatToken: 'legacy_repeat_token_12345',
            summary: 'Printer issue',
            description: 'The approved office printer is unavailable.'
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'repeat_confirmation_field_invalid' }
        });
        expect(lifecycleService.resolveServiceDeskProviderBinding).not.toHaveBeenCalled();
        expect(ticketProvider.createTicket).not.toHaveBeenCalled();
    });

    test('preflights replies through exact customer-scoped detail and preserves confirmation tokens', async () => {
        const { portal, ticketProvider } = service({
            replyToTicket: jest.fn(async () => ({
                operationId: 'op-one',
                status: 'confirmation_required',
                repeatConfirmationToken: 'confirmation_token_123456789'
            }))
        });
        const result = await portal.replyToTicket(access(), 'T20260831.0012', {
            message: 'This is still affecting the team.',
            operationId: REPLY_OPERATION,
            actor: { actorId: 'forged' }
        });
        expect(ticketProvider.getTicketByNumber).toHaveBeenCalledTimes(1);
        expect(ticketProvider.replyToTicket).toHaveBeenCalledWith(expect.objectContaining({
            actor: expect.objectContaining({ actorId: SUBJECT }),
            contactId: '20',
            customerVisible: true
        }));
        expect(result).toMatchObject({
            status: 'confirmation_required',
            repeatConfirmationToken: 'confirmation_token_123456789'
        });
    });
});

describe('customer portal Proof customer binding', () => {
    function issuedReport(customerId = 'proof-customer-one', proofId = 'proof-customer-one-2026-07') {
        const period = '2026-07';
        const issuedAt = '2026-08-05T02:00:00.000Z';
        const organisationDigest = canonicalHash({ schema: 'nofries-proof-organisation-v1', organisationId: 'customer-one' });
        const statement = { type: 'nofries_attested_monthly_statement', label: 'No Fries-attested monthly statement' };
        const issuer = { role: 'service_owner', roleLabel: 'Service owner', label: 'Proof issuer' };
        const approval = {
            maker: { role: 'consultant', roleLabel: 'Consultant', label: 'Proof preparer' },
            preparedAt: '2026-08-03T02:00:00.000Z',
            checker: { role: 'service_owner', roleLabel: 'Service owner', label: 'Proof approver' },
            approvedAt: '2026-08-04T02:00:00.000Z',
            distinctActors: true
        };
        const frozenSnapshot = {
            schemaVersion: 1,
            proofId,
            customerId,
            organisationDigest,
            statement,
            period,
            approval,
            sections: []
        };
        const snapshotSha256 = canonicalHash(frozenSnapshot);
        const publicationEnvelope = {
            schemaVersion: 1,
            approvedSnapshotSha256: snapshotSha256,
            proofId,
            customerId,
            organisationDigest,
            statement,
            period,
            issuedAt,
            issuer
        };
        return {
            proofId,
            customerId,
            organisationDigest,
            statement,
            period,
            approvedAt: '2026-08-04T02:00:00.000Z',
            approval,
            issuedAt,
            issuer,
            snapshotSha256,
            frozenSnapshot,
            publicationEnvelope,
            publicationSha256: canonicalHash(publicationEnvelope),
            sections: [],
            evidenceReceipts: []
        };
    }

    function proofPortal(report, sourceReport = issuedReport()) {
        const proof = {
            id: sourceReport.proofId,
            customerId: sourceReport.customerId,
            period: sourceReport.period,
            status: 'issued',
            snapshotSha256: sourceReport.snapshotSha256,
            publicationSha256: sourceReport.publicationSha256,
            issuedAt: sourceReport.issuedAt,
            customerSnapshot: sourceReport.frozenSnapshot
        };
        return createCustomerPortalService({
            ticketProvider: {
                listTickets: jest.fn(async () => ({ tickets: [] }))
            },
            lifecycleService: {
                requireServiceDeskCustomer: jest.fn(async () => ({ id: 'customer-one' })),
                resolveServiceDeskProviderBinding: jest.fn(async () => ({
                    tenantId: 'workspace-one', customerId: 'customer-one', companyId: '10', providerScopeId: 'scope-one', devices: []
                })),
                getOrganisation: jest.fn(async () => ({
                    organisation: {
                        id: 'customer-one',
                        organisationId: 'customer-one',
                        customerMaster: {
                            customerId: 'proof-customer-one',
                            externalRefs: [{
                                system: 'autotask',
                                recordType: 'company',
                                externalId: '10',
                                status: 'verified'
                            }]
                        },
                        proofPeriods: [proof]
                    }
                }))
            },
            buildProofView: () => ({
                timezone: 'Pacific/Auckland',
                current: { period: '2026-07', state: 'issued', report },
                history: []
            }),
            proofForPeriod: () => report,
            providerAdmission: jest.fn()
        });
    }

    test('returns only a report whose snapshot and publication receipts bind to the distinct Proof customer ID', async () => {
        const report = issuedReport();
        await expect(proofPortal(report).getProofPeriod(access(), '2026-07')).resolves.toEqual({ report });
    });

    test('exposes the distinct safe Proof customer binding in bootstrap', async () => {
        const report = issuedReport();
        await expect(proofPortal(report).bootstrap(access())).resolves.toMatchObject({
            customer: { id: 'customer-one', proofCustomerId: 'proof-customer-one' },
            proof: { status: 'available', proofCustomerId: 'proof-customer-one' }
        });
    });

    test('fails closed when the publication envelope hash or issuer binding is changed', async () => {
        const source = issuedReport();
        const tampered = Object.assign({}, source, {
            publicationEnvelope: Object.assign({}, source.publicationEnvelope, { issuedAt: '2026-08-06T02:00:00.000Z' })
        });
        await expect(proofPortal(tampered, source).getProofPeriod(access(), '2026-07')).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'proof_report_binding_invalid' }
        });
    });

    test('rejects stale statements, organisation bindings and public identity digests', async () => {
        const source = issuedReport();
        const unsafe = Object.assign({}, source, {
            issuer: Object.assign({}, source.issuer, { actorDigest: 'a'.repeat(64) })
        });
        await expect(proofPortal(unsafe, source).getProofPeriod(access(), '2026-07')).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'proof_report_binding_invalid' }
        });

        const wrongStatement = Object.assign({}, source, {
            statement: { type: 'draft', label: 'Draft' }
        });
        await expect(proofPortal(wrongStatement, source).getProofPeriod(access(), '2026-07')).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'proof_report_binding_invalid' }
        });
    });

    test('fails closed for another customer report in the same period without returning its checksum', async () => {
        const crossCustomer = issuedReport('proof-customer-two', 'proof-customer-two-2026-07');
        const crossCustomerChecksum = crossCustomer.snapshotSha256;
        const portal = proofPortal(crossCustomer);
        let observed;
        try {
            await portal.getProofPeriod(access(), '2026-07');
        } catch (error) {
            observed = error;
        }
        expect(observed).toMatchObject({
            statusCode: 503,
            details: { code: 'proof_report_binding_invalid' }
        });
        expect(JSON.stringify(observed)).not.toContain(crossCustomerChecksum);
        expect(JSON.stringify(observed)).not.toContain('proof-customer-two');
    });
});
