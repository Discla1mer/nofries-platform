const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-service-desk-test-'));
process.env.NOFRIES_DATA_DIR = testDataDir;
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_DEV_EMAIL = 'joel@example.com';
process.env.NOFRIES_ALLOWED_EMAILS = 'joel@example.com,consultant@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'joel@example.com';
process.env.NOFRIES_SERVICE_OWNER_EMAILS = 'owner@example.com';
process.env.NOFRIES_DEFAULT_TENANT_ID = 'tenant-a';
process.env.NOFRIES_TENANT_NAME = 'No Fries test tenant';
process.env.NOFRIES_STORAGE_PROVIDER = 'local';
process.env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER = 'local';
process.env.NOFRIES_AGENT_RUNTIME = 'mock';
process.env.NOFRIES_SCOPE_STORAGE_PROVIDER = 'memory';
process.env.NOFRIES_SCOPE_SIGNING_SECRET = 'test-scope-signing-secret-with-at-least-thirty-two-characters';
process.env.RESEND_API_KEY = 'test-resend-key';

const app = require('../server');
const {
    AGENT_IDS,
    TOOL_NAMES
} = require('../api/shared/serviceDesk/agentDefinitions');
const { createMockServiceDeskAdapters } = require('../api/shared/serviceDesk/mockAdapters');
const { createToolGateway } = require('../api/shared/serviceDesk/toolGateway');
const { createServiceDeskService } = require('../api/shared/serviceDesk/agentRuntime');
const {
    ServiceDeskRepositoryError,
    createServiceDeskRepository
} = require('../api/shared/serviceDesk/serviceDeskRepository');
const { getLifecycleService } = require('../api/shared/appLifecycleRuntime');
const {
    resetServiceDeskRuntimeForTests,
    runServiceDeskFunction
} = require('../api/shared/serviceDeskRuntime');
const {
    ROLE_CAPABILITIES,
    tenantStorageKey
} = require('../api/shared/tenantAccess');

let harnessCounter = 0;

describe('No Fries mocked three-agent service desk', () => {
    afterAll(() => {
        fs.rmSync(testDataDir, { recursive: true, force: true });
    });

    test('Tool Gateway enforces agent allowlists and tenant boundaries', async () => {
        const tenantId = 'tenant-a';
        const customerId = 'demo-customer';
        const gateway = createToolGateway({
            tenantId,
            customerId,
            adapters: createMockServiceDeskAdapters({ tenantId, customerId })
        });
        const resource = {
            resourceTenantId: tenantId,
            resourceCustomerId: customerId,
            ticketId: 'ticket-1',
            externalTicketId: 'AT-1',
            status: 'In progress',
            note: 'Attempted write'
        };

        await expect(gateway.invoke({
            agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
            tool: TOOL_NAMES.AUTOTASK_TICKET_UPDATE,
            tenantId,
            input: resource
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tool_not_permitted' }
        });

        await expect(gateway.invoke({
            agentId: AGENT_IDS.ACTION_AGENT,
            tool: TOOL_NAMES.DATTO_REMEDIATION_SIMULATE,
            tenantId,
            input: Object.assign({}, resource, {
                recommendationId: 'recommendation-1',
                actionKey: 'clear_outlook_token_cache_and_restart',
                deviceId: 'device-1'
            })
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'approval_required' }
        });

        await expect(gateway.invoke({
            agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
            tool: TOOL_NAMES.DATTO_DEVICE_READ,
            tenantId: 'tenant-b',
            input: Object.assign({}, resource, { deviceId: 'device-1' })
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_boundary_violation' }
        });

        await expect(gateway.invoke({
            agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
            tool: TOOL_NAMES.DATTO_DEVICE_READ,
            tenantId,
            input: Object.assign({}, resource, {
                resourceCustomerId: 'other-customer',
                deviceId: 'device-1'
            })
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'customer_boundary_violation' }
        });

        await expect(gateway.invoke({
            agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
            tool: TOOL_NAMES.DATTO_DEVICE_READ,
            tenantId,
            input: Object.assign({}, resource, {
                resourceTenantId: 'tenant-b',
                deviceId: 'device-1'
            })
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_boundary_violation' }
        });
    });

    test('serves the authorised support runtime without initialising broken storage', async () => {
        const previousProvider = process.env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER;
        process.env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER = 'invalid-provider';
        resetServiceDeskRuntimeForTests();
        try {
            const appContext = { log: { error: jest.fn() } };
            await runServiceDeskFunction(appContext, {
                method: 'GET',
                url: '/api/service-desk/app.js',
                headers: {}
            });
            expect(appContext.res.status).toBe(200);
            expect(appContext.res.headers['Content-Type']).toContain('application/javascript');
            expect(appContext.res.body).toContain('NoFriesSupport');

            const bootstrapContext = { log: { error: jest.fn() } };
            await runServiceDeskFunction(bootstrapContext, {
                method: 'GET',
                url: '/api/service-desk/bootstrap',
                headers: {}
            });
            expect(bootstrapContext.res.status).toBe(500);
        } finally {
            process.env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER = previousProvider;
            resetServiceDeskRuntimeForTests();
        }
    });

    test('tenant repositories do not expose another tenant ticket', async () => {
        const harness = createHarness();
        const tenantA = access('tenant-a', 'admin', 'joel@example.com');
        const tenantB = access('tenant-b', 'admin', 'joel@example.com');
        const created = await harness.service.createTicket(tenantA, ticketInput(0));

        expect(created.ticket.tenantId).toBe('tenant-a');
        expect(created.ticket.clientRequestId).toBe('test-request-0');
        const otherTenant = await harness.service.listTickets(tenantB);
        expect(otherTenant.tickets).toEqual([]);
    });

    test('ticket creation is idempotent for an exact tenant request identity', async () => {
        const harness = createHarness();
        const operator = access('tenant-a', 'admin', 'joel@example.com');
        const first = await harness.service.createTicket(operator, ticketInput(0, {
            clientRequestId: 'support-idempotent-request'
        }));
        const replay = await harness.service.createTicket(operator, ticketInput(first.revision, {
            clientRequestId: 'support-idempotent-request'
        }));

        expect(replay.idempotentReplay).toBe(true);
        expect(replay.revision).toBe(first.revision);
        expect(replay.ticket.id).toBe(first.ticket.id);
        expect((await harness.service.listTickets(operator)).tickets).toHaveLength(1);

        await expect(harness.service.createTicket(operator, ticketInput(first.revision, {
            clientRequestId: 'support-idempotent-request',
            summary: 'Different request details'
        }))).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'ticket_request_id_reused' }
        });
    });

    test('idempotent replay retries lifecycle evidence after a transient sync failure', async () => {
        const recordServiceEvent = jest.fn()
            .mockRejectedValueOnce(new Error('lifecycle storage unavailable'))
            .mockImplementationOnce(async (_access, _customerId, event) => ({
                linked: true,
                created: true,
                event
            }));
        const harness = createHarness({ contextProvider: { recordServiceEvent } });
        const operator = access('tenant-a', 'admin', 'joel@example.com');
        const input = ticketInput(0, { clientRequestId: 'support-lifecycle-retry' });

        const first = await harness.service.createTicket(operator, input);
        const replay = await harness.service.createTicket(operator, ticketInput(first.revision, {
            clientRequestId: 'support-lifecycle-retry'
        }));

        expect(first.contextSync).toMatchObject({ linked: false, reason: 'lifecycle_sync_failed' });
        expect(replay).toMatchObject({
            idempotentReplay: true,
            contextSync: { linked: true, created: true }
        });
        expect(recordServiceEvent).toHaveBeenCalledTimes(2);
        expect(recordServiceEvent.mock.calls[0][2].id).toBe(recordServiceEvent.mock.calls[1][2].id);
        expect(recordServiceEvent.mock.calls[1][2]).toMatchObject({
            id: `service_desk:${first.ticket.id}:ticket_raised`,
            type: 'ticket_raised',
            outcome: 'open',
            occurredAt: first.ticket.createdAt
        });
        expect(replay.contextSync.eventId).toBe(`service_desk-${first.ticket.id}-ticket_raised`);
        expect((await harness.service.listTickets(operator)).tickets).toHaveLength(1);
    });

    test('overlapping same-key creates invoke the provider once and return one ticket', async () => {
        const providerCreate = jest.fn();
        const harness = createHarness({
            adapterFactory(adapterOptions) {
                const adapters = createMockServiceDeskAdapters(adapterOptions);
                const create = adapters.autotask.createTicket;
                adapters.autotask.createTicket = async function (...args) {
                    providerCreate();
                    return create.apply(this, args);
                };
                return adapters;
            }
        });
        const operator = access('tenant-a', 'admin', 'joel@example.com');
        const input = ticketInput(0, { clientRequestId: 'support-overlapping-request' });

        const [first, second] = await Promise.all([
            harness.service.createTicket(operator, input),
            harness.service.createTicket(operator, input)
        ]);

        expect(first.ticket.id).toBe(second.ticket.id);
        expect([first.idempotentReplay, second.idempotentReplay]).toContain(true);
        expect(providerCreate).toHaveBeenCalledTimes(1);
        expect((await harness.service.listTickets(operator)).tickets).toHaveLength(1);
    });

    test('overlapping same-key creates reject different request details before a second provider call', async () => {
        const providerCreate = jest.fn();
        const harness = createHarness({
            adapterFactory(adapterOptions) {
                const adapters = createMockServiceDeskAdapters(adapterOptions);
                const create = adapters.autotask.createTicket;
                adapters.autotask.createTicket = async function (...args) {
                    providerCreate();
                    return create.apply(this, args);
                };
                return adapters;
            }
        });
        const operator = access('tenant-a', 'admin', 'joel@example.com');
        const clientRequestId = 'support-overlapping-mismatch';
        const results = await Promise.allSettled([
            harness.service.createTicket(operator, ticketInput(0, { clientRequestId })),
            harness.service.createTicket(operator, ticketInput(0, {
                clientRequestId,
                summary: 'Different concurrent details'
            }))
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({
            statusCode: 409,
            details: { code: 'ticket_request_id_reused' }
        });
        expect(providerCreate).toHaveBeenCalledTimes(1);
        expect((await harness.service.listTickets(operator)).tickets).toHaveLength(1);
    });

    test('tickets use the authoritative customer and only accept its verified computers', async () => {
        const harness = createHarness();
        const admin = access('tenant-a', 'admin', 'joel@example.com');
        const bootstrap = await harness.service.bootstrap(admin);
        expect(bootstrap).toMatchObject({
            readiness: { eligible: true, eligibleCustomerCount: 1 },
            customers: [{
                id: 'demo-customer',
                name: 'Demo customer',
                devices: [expect.objectContaining({ id: 'demo-win11-07', status: 'verified' })]
            }]
        });

        await expect(harness.service.createTicket(admin, Object.assign(ticketInput(0), {
            customerId: 'made-up-customer'
        }))).rejects.toMatchObject({
            statusCode: 404,
            details: { code: 'service_desk_customer_not_found' }
        });
        await expect(harness.service.createTicket(admin, Object.assign(ticketInput(0), {
            deviceId: 'unverified-device'
        }))).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'verified_device_required' }
        });

        const created = await harness.service.createTicket(admin, Object.assign(ticketInput(0), {
            customerName: 'Forged customer name'
        }));
        expect(created.ticket.customer).toEqual({ id: 'demo-customer', name: 'Demo customer' });
    });

    test('any non-mock agent runtime fails closed', () => {
        const repository = createServiceDeskRepository({
            dataDir: path.join(testDataDir, 'non-mock-runtime'),
            provider: 'local'
        });

        expect(() => createServiceDeskService({
            repository,
            env: { NOFRIES_AGENT_RUNTIME: 'live' }
        })).toThrow(expect.objectContaining({
            statusCode: 503,
            details: { code: 'agent_runtime_not_enabled' }
        }));
    });

    test('execution is denied without explicit, authorised, bound approval and cannot be replayed', async () => {
        const harness = createHarness();
        const maker = access('tenant-a', 'consultant', 'maker@example.com');
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');
        const created = await harness.service.createTicket(maker, ticketInput(0));
        const investigated = await harness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });

        await expect(harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: investigated.revision,
            approvalId: ''
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'approval_required' }
        });

        await expect(harness.service.approveRecommendation(maker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'capability_required' }
        });

        await expect(harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: false
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'approval_confirmation_required' }
        });

        const approved = await harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        });
        const completed = await harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: approved.revision,
            approvalId: approved.ticket.approval.id
        });

        expect(completed.ticket.approval.status).toBe('consumed');
        await expect(harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: completed.revision,
            approvalId: approved.ticket.approval.id
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'approval_consumed' }
        });
    });

    test('customer readiness is revalidated before investigation, approval, and execution', async () => {
        let ready = true;
        const currentCustomer = {
            id: 'demo-customer',
            name: 'Demo customer',
            lifecycleState: 'active',
            onboardingStatus: 'complete',
            devices: [{ id: 'demo-win11-07', status: 'verified' }]
        };
        const requireServiceDeskCustomer = jest.fn(async () => {
            if (!ready) {
                throw new ServiceDeskRepositoryError(409, 'Customer service is no longer active', {
                    code: 'customer_setup_incomplete',
                    missing: ['active_service_required']
                });
            }
            return currentCustomer;
        });
        const harness = createHarness({ contextProvider: { requireServiceDeskCustomer } });
        const maker = access('tenant-a', 'consultant', 'maker@example.com');
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');
        const created = await harness.service.createTicket(maker, ticketInput(0));

        ready = false;
        await expect(harness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'customer_setup_incomplete' }
        });
        expect((await harness.service.getTicket(maker, created.ticket.id)).ticket.status).toBe('open');

        ready = true;
        const investigated = await harness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });
        ready = false;
        await expect(harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'customer_setup_incomplete' }
        });
        expect((await harness.service.getTicket(checker, created.ticket.id)).ticket.approval).toBeNull();

        ready = true;
        const approved = await harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        });
        ready = false;
        await expect(harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: approved.revision,
            approvalId: approved.ticket.approval.id
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'customer_setup_incomplete' }
        });

        const blocked = await harness.service.getTicket(executor, created.ticket.id);
        expect(blocked).toMatchObject({
            revision: approved.revision + 1,
            ticket: {
                status: 'needs_attention',
                stage: 'customer_governance',
                execution: null,
                approval: {
                    status: 'revoked',
                    revokedReason: 'customer_setup_incomplete'
                }
            }
        });
        expect(requireServiceDeskCustomer).toHaveBeenCalledTimes(6);
    });

    test('legacy tickets without requester-admission evidence fail closed at every work stage', async () => {
        const maker = access('tenant-a', 'consultant', 'maker@example.com');
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');

        const investigationHarness = createHarness();
        const investigationCreated = await investigationHarness.service.createTicket(maker, ticketInput(0));
        const investigationLegacy = await investigationHarness.repository.mutate(maker, {
            expectedRevision: investigationCreated.revision
        }, async (state) => {
            delete state.tickets[0].requesterEmail;
            return state.tickets[0];
        });
        await expect(investigationHarness.service.investigateTicket(maker, investigationCreated.ticket.id, {
            expectedRevision: investigationLegacy.state.revision
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'ticket_requester_admission_evidence_required' }
        });
        expect((await investigationHarness.service.getTicket(maker, investigationCreated.ticket.id)).ticket).toMatchObject({
            status: 'open',
            investigation: null
        });

        const approvalHarness = createHarness();
        const approvalCreated = await approvalHarness.service.createTicket(maker, ticketInput(0));
        const approvalInvestigated = await approvalHarness.service.investigateTicket(maker, approvalCreated.ticket.id, {
            expectedRevision: approvalCreated.revision
        });
        const approvalLegacy = await approvalHarness.repository.mutate(maker, {
            expectedRevision: approvalInvestigated.revision
        }, async (state) => {
            delete state.tickets[0].requesterVerificationMethod;
            return state.tickets[0];
        });
        await expect(approvalHarness.service.approveRecommendation(checker, approvalCreated.ticket.id, {
            expectedRevision: approvalLegacy.state.revision,
            recommendationId: approvalInvestigated.ticket.recommendation.id,
            confirmed: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'ticket_requester_admission_evidence_required' }
        });
        expect((await approvalHarness.service.getTicket(checker, approvalCreated.ticket.id)).ticket).toMatchObject({
            status: 'awaiting_approval',
            approval: null
        });

        const executionHarness = createHarness();
        const executionCreated = await executionHarness.service.createTicket(maker, ticketInput(0));
        const executionInvestigated = await executionHarness.service.investigateTicket(maker, executionCreated.ticket.id, {
            expectedRevision: executionCreated.revision
        });
        const executionApproved = await executionHarness.service.approveRecommendation(checker, executionCreated.ticket.id, {
            expectedRevision: executionInvestigated.revision,
            recommendationId: executionInvestigated.ticket.recommendation.id,
            confirmed: true
        });
        const executionLegacy = await executionHarness.repository.mutate(checker, {
            expectedRevision: executionApproved.revision
        }, async (state) => {
            state.tickets[0].requesterVerificationRef = 'token=legacy-secret';
            return state.tickets[0];
        });
        await expect(executionHarness.service.executeApprovedRemediation(executor, executionCreated.ticket.id, {
            expectedRevision: executionLegacy.state.revision,
            approvalId: executionApproved.ticket.approval.id
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'ticket_requester_admission_evidence_required' }
        });

        const blocked = await executionHarness.service.getTicket(executor, executionCreated.ticket.id);
        expect(blocked).toMatchObject({
            revision: executionLegacy.state.revision + 1,
            ticket: {
                status: 'needs_attention',
                stage: 'customer_governance',
                execution: null,
                approval: {
                    status: 'revoked',
                    revokedReason: 'ticket_requester_admission_evidence_required'
                }
            }
        });
    });

    test('risky remediation requires distinct maker, checker, and executor human identities', async () => {
        const sharedPrincipalHarness = createHarness();
        const maker = access('tenant-a', 'admin', 'maker@example.com', 'principal-shared-human');
        const checkerAlias = access('tenant-a', 'service_owner', 'maker.alias@example.com', 'principal-shared-human');
        const created = await sharedPrincipalHarness.service.createTicket(maker, ticketInput(0));
        const investigated = await sharedPrincipalHarness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });

        await expect(sharedPrincipalHarness.service.approveRecommendation(checkerAlias, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'maker_checker_separation_required' }
        });
        const approvalBlocked = await sharedPrincipalHarness.service.getTicket(maker, created.ticket.id);
        expect(approvalBlocked).toMatchObject({
            revision: investigated.revision,
            ticket: { status: 'awaiting_approval', approval: null }
        });

        const makerExecutorHarness = createHarness();
        const makerExecutor = access('tenant-a', 'admin', 'maker-executor@example.com');
        const independentChecker = access('tenant-a', 'service_owner', 'independent-checker@example.com');
        const independentExecutor = access('tenant-a', 'admin', 'independent-executor@example.com');
        const makerExecutorCreated = await makerExecutorHarness.service.createTicket(makerExecutor, ticketInput(0));
        const makerExecutorInvestigated = await makerExecutorHarness.service.investigateTicket(
            makerExecutor,
            makerExecutorCreated.ticket.id,
            { expectedRevision: makerExecutorCreated.revision }
        );
        const makerExecutorApproved = await makerExecutorHarness.service.approveRecommendation(
            independentChecker,
            makerExecutorCreated.ticket.id,
            {
                expectedRevision: makerExecutorInvestigated.revision,
                recommendationId: makerExecutorInvestigated.ticket.recommendation.id,
                confirmed: true
            }
        );

        await expect(makerExecutorHarness.service.executeApprovedRemediation(
            makerExecutor,
            makerExecutorCreated.ticket.id,
            {
                expectedRevision: makerExecutorApproved.revision,
                approvalId: makerExecutorApproved.ticket.approval.id
            }
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'maker_executor_separation_required' }
        });
        const makerExecutionBlocked = await makerExecutorHarness.service.getTicket(
            independentExecutor,
            makerExecutorCreated.ticket.id
        );
        expect(makerExecutionBlocked).toMatchObject({
            revision: makerExecutorApproved.revision,
            ticket: { status: 'approved', execution: null, approval: { status: 'active' } }
        });

        const checkerExecutorHarness = createHarness();
        const independentMaker = access('tenant-a', 'consultant', 'independent-maker@example.com');
        const checkerExecutor = access('tenant-a', 'service_owner', 'checker-executor@example.com');
        const checkerExecutorCreated = await checkerExecutorHarness.service.createTicket(independentMaker, ticketInput(0));
        const checkerExecutorInvestigated = await checkerExecutorHarness.service.investigateTicket(
            independentMaker,
            checkerExecutorCreated.ticket.id,
            { expectedRevision: checkerExecutorCreated.revision }
        );
        const checkerExecutorApproved = await checkerExecutorHarness.service.approveRecommendation(
            checkerExecutor,
            checkerExecutorCreated.ticket.id,
            {
                expectedRevision: checkerExecutorInvestigated.revision,
                recommendationId: checkerExecutorInvestigated.ticket.recommendation.id,
                confirmed: true
            }
        );

        await expect(checkerExecutorHarness.service.executeApprovedRemediation(
            checkerExecutor,
            checkerExecutorCreated.ticket.id,
            {
                expectedRevision: checkerExecutorApproved.revision,
                approvalId: checkerExecutorApproved.ticket.approval.id
            }
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'checker_executor_separation_required' }
        });
        const checkerExecutionBlocked = await checkerExecutorHarness.service.getTicket(
            independentExecutor,
            checkerExecutorCreated.ticket.id
        );
        expect(checkerExecutionBlocked).toMatchObject({
            revision: checkerExecutorApproved.revision,
            ticket: { status: 'approved', execution: null, approval: { status: 'active' } }
        });
    });

    test('risky remediation fails closed when human governance evidence is missing', async () => {
        const identityHarness = createHarness();
        const maker = access('tenant-a', 'admin', 'maker@example.com');
        const noHumanIdentity = access('tenant-a', 'consultant', '', null);
        const created = await identityHarness.service.createTicket(maker, ticketInput(0));
        await expect(identityHarness.service.investigateTicket(noHumanIdentity, created.ticket.id, {
            expectedRevision: created.revision
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'human_identity_required' }
        });

        const investigated = await identityHarness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });
        const withoutMaker = await identityHarness.repository.mutate(maker, {
            expectedRevision: investigated.revision
        }, async (state) => {
            state.tickets[0].recommendation.maker = null;
            return state.tickets[0];
        });
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        await expect(identityHarness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: withoutMaker.state.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'maker_identity_required' }
        });

        const checkerHarness = createHarness();
        const independentMaker = access('tenant-a', 'consultant', 'independent-maker@example.com');
        const independentChecker = access('tenant-a', 'service_owner', 'independent-checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');
        const checkerCreated = await checkerHarness.service.createTicket(independentMaker, ticketInput(0));
        const checkerInvestigated = await checkerHarness.service.investigateTicket(
            independentMaker,
            checkerCreated.ticket.id,
            { expectedRevision: checkerCreated.revision }
        );
        const checkerApproved = await checkerHarness.service.approveRecommendation(
            independentChecker,
            checkerCreated.ticket.id,
            {
                expectedRevision: checkerInvestigated.revision,
                recommendationId: checkerInvestigated.ticket.recommendation.id,
                confirmed: true
            }
        );
        const withoutChecker = await checkerHarness.repository.mutate(independentChecker, {
            expectedRevision: checkerApproved.revision
        }, async (state) => {
            state.tickets[0].approval.checker = null;
            return state.tickets[0];
        });
        await expect(checkerHarness.service.executeApprovedRemediation(executor, checkerCreated.ticket.id, {
            expectedRevision: withoutChecker.state.revision,
            approvalId: checkerApproved.ticket.approval.id
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'checker_identity_required' }
        });
    });

    test('Outlook incident completes investigation, approved simulation, verification, audit, and customer update', async () => {
        const harness = createHarness();
        const maker = access('tenant-a', 'consultant', 'maker@example.com');
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');
        const created = await harness.service.createTicket(maker, ticketInput(0));
        const investigated = await harness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });

        expect(investigated.ticket.status).toBe('awaiting_approval');
        expect(investigated.ticket.investigation.diagnosis).toContain('stale local Outlook authentication token cache');
        expect(investigated.ticket.recommendation).toMatchObject({
            actionKey: 'clear_outlook_token_cache_and_restart',
            risk: 'low',
            approvalRequired: true,
            maker: {
                email: 'maker@example.com',
                principalId: 'principal-maker@example.com'
            }
        });
        expect(investigated.ticket.execution).toBeNull();

        const approved = await harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        });
        const completed = await harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: approved.revision,
            approvalId: approved.ticket.approval.id
        });

        expect(completed.ticket.status).toBe('resolved');
        expect(completed.ticket.execution).toMatchObject({
            simulated: true,
            outcome: 'simulated_success',
            agentId: AGENT_IDS.ACTION_AGENT,
            executor: {
                email: 'executor@example.com',
                principalId: 'principal-executor@example.com'
            }
        });
        expect(completed.ticket.approval.checker).toMatchObject({
            email: 'checker@example.com',
            principalId: 'principal-checker@example.com'
        });
        expect(completed.ticket.verification.passed).toBe(true);
        expect(completed.ticket.verification.checks).toHaveLength(4);
        expect(completed.ticket.verification.checks.every((check) => check.passed)).toBe(true);
        expect(completed.ticket.customerUpdate.preparedByAgent).toBe(AGENT_IDS.SERVICE_MANAGER);
        expect(completed.ticket.customerUpdate.message).toContain('verified');

        const audit = await harness.service.getAudit(executor);
        const actions = audit.events.map((event) => event.action);
        expect(actions).toContain('ticket.created');
        expect(actions).toContain('investigation.completed');
        expect(actions).toContain('remediation.approved');
        expect(actions).toContain('remediation.executed');
        expect(actions).toContain('ticket.customer_update_prepared');
        expect(audit.events.filter((event) => event.action === 'tool.invoked').length).toBeGreaterThanOrEqual(8);
        expect(audit.events.every((event) => event.tenantKey === tenantStorageKey('tenant-a'))).toBe(true);
        const governanceEvents = audit.events.filter((event) => [
            'investigation.completed',
            'remediation.approved',
            'remediation.executed'
        ].includes(event.action));
        expect(governanceEvents).toHaveLength(3);
        expect(governanceEvents.every((event) => (
            event.details.correlationId === investigated.ticket.recommendation.correlationId
        ))).toBe(true);
        expect(governanceEvents.find((event) => event.action === 'remediation.executed').details).toMatchObject({
            makerPrincipalId: 'principal-maker@example.com',
            checkerPrincipalId: 'principal-checker@example.com',
            executorPrincipalId: 'principal-executor@example.com'
        });
    });

    test('technical investigation consumes linked lifecycle context without inventing missing data', async () => {
        const getSharedContext = jest.fn(async () => ({
            organisationId: 'demo-customer',
            displayName: 'Demo customer',
            lifecycleState: 'active',
            context: {
                productivity: { platform: 'microsoft_365', notes: '' },
                itProvider: { model: 'none', name: '', notes: '' },
                internalIt: { capability: 'none', notes: '' },
                security: { tools: ['Microsoft Defender'], concerns: [], notes: '' },
                applications: { important: [], notes: '' }
            },
            discovery: { status: 'complete', summary: 'Microsoft 365 customer', missingFields: [] }
        }));
        const harness = createHarness({ contextProvider: { getSharedContext } });
        const admin = access('tenant-a', 'admin', 'joel@example.com');
        const created = await harness.service.createTicket(admin, ticketInput(0));
        const investigated = await harness.service.investigateTicket(admin, created.ticket.id, {
            expectedRevision: created.revision
        });

        expect(getSharedContext).toHaveBeenCalledWith(admin, 'demo-customer');
        expect(investigated.ticket.investigation.customerContext).toMatchObject({
            status: 'available',
            organisationId: 'demo-customer',
            lifecycleState: 'active',
            productivity: { platform: 'microsoft_365' },
            itProvider: { model: 'none' },
            security: { tools: ['Microsoft Defender'] }
        });
        expect(investigated.ticket.investigation.customerContext.applications.important).toEqual([]);
    });

    test('investigation fails closed when the linked customer context cannot be read', async () => {
        const harness = createHarness({
            contextProvider: {
                getSharedContext: jest.fn().mockRejectedValue(new Error('lifecycle storage unavailable'))
            }
        });
        const admin = access('tenant-a', 'admin', 'joel@example.com');
        const created = await harness.service.createTicket(admin, ticketInput(0));

        await expect(harness.service.investigateTicket(admin, created.ticket.id, {
            expectedRevision: created.revision
        })).rejects.toThrow('lifecycle storage unavailable');

        const unchanged = await harness.service.getTicket(admin, created.ticket.id);
        expect(unchanged.ticket).toMatchObject({ status: 'open', investigation: null, recommendation: null });
    });

    test('service-desk stages write bounded proof events through the shared lifecycle provider', async () => {
        const recordServiceEvent = jest.fn(async (activeAccess, customerId, event) => ({
            linked: true,
            event,
            customerId,
            tenantId: activeAccess.tenant.id
        }));
        const harness = createHarness({ contextProvider: { recordServiceEvent } });
        const maker = access('tenant-a', 'consultant', 'maker@example.com');
        const checker = access('tenant-a', 'service_owner', 'checker@example.com');
        const executor = access('tenant-a', 'admin', 'executor@example.com');
        const created = await harness.service.createTicket(maker, ticketInput(0));
        const investigated = await harness.service.investigateTicket(maker, created.ticket.id, {
            expectedRevision: created.revision
        });
        const approved = await harness.service.approveRecommendation(checker, created.ticket.id, {
            expectedRevision: investigated.revision,
            recommendationId: investigated.ticket.recommendation.id,
            confirmed: true
        });
        const completed = await harness.service.executeApprovedRemediation(executor, created.ticket.id, {
            expectedRevision: approved.revision,
            approvalId: approved.ticket.approval.id
        });

        expect(created.contextSync.linked).toBe(true);
        expect(investigated.contextSync.linked).toBe(true);
        expect(approved.contextSync.linked).toBe(true);
        expect(completed.contextSync.linked).toBe(true);
        expect(recordServiceEvent.mock.calls.map((call) => call[2].type)).toEqual([
            'ticket_raised',
            'recommendation_created',
            'approval_granted',
            'ticket_resolved'
        ]);
        expect(recordServiceEvent).toHaveBeenLastCalledWith(executor, 'demo-customer', expect.objectContaining({
            ticketId: created.ticket.id,
            simulated: true,
            remediation: true,
            requiresAttention: false
        }));
    });

    test('authenticated support API blocks one human from making and approving a remediation', async () => {
        const support = await request(app).get('/support');
        expect(support.status).toBe(200);
        expect(support.headers['cache-control']).toContain('no-store');
        expect(support.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(support.text).toContain('Customer support tickets in Autotask.');
        expect(support.text).toContain('Live production service desk');
        expect(support.text).not.toMatch(/Safe test environment|Simulation only|Service Desk Lab/i);
        expect(support.text).toContain('id="supportRuntime"');
        expect(support.text).toContain('support_timeout');
        expect(support.text).toContain('/api/service-desk/app.js');
        expect(support.text).not.toContain('window.NoFriesSupport = { start };');
        expect((await request(app).get('/js/support-loader.js')).status).toBe(404);

        const lifecycleCustomer = await createActiveLifecycleCustomer(
            getLifecycleService(),
            access('tenant-a', 'admin', 'joel@example.com'),
            'Service Desk Route Customer'
        );

        const bootstrap = await request(app).get('/api/service-desk/bootstrap');
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.headers['cache-control']).toContain('no-store');
        expect(bootstrap.body.runtime).toMatchObject({
            mode: 'mock',
            externalChanges: false,
            approvalRequired: true
        });
        expect(bootstrap.body.agents.map((agent) => agent.name)).toEqual([
            'Service coordinator',
            'Technical review',
            'Approved action'
        ]);
        expect(bootstrap.body).toMatchObject({
            scenario: { category: 'Routine support', name: 'Outlook sign-in' },
            readiness: { eligible: true, eligibleCustomerCount: 1 }
        });
        expect(bootstrap.body.customers).toEqual([
            expect.objectContaining({
                id: lifecycleCustomer.organisationId,
                name: 'Service Desk Route Customer',
                devices: [
                    expect.objectContaining({ id: 'route_windows', status: 'verified' }),
                    expect.objectContaining({ id: 'route_macos', status: 'verified' })
                ]
            })
        ]);
        const routeTicket = ticketInput(bootstrap.body.revision, {
            customerId: lifecycleCustomer.organisationId,
            deviceId: 'route_windows',
            requesterEmail: 'route@example.com',
            requesterVerificationMethod: 'Approved Microsoft identity',
            requesterVerificationRef: 'internal-pilot-register:route-requester'
        });

        const blockedCrossSite = await request(app)
            .post('/api/service-desk/tickets')
            .set('Origin', 'https://attacker.example')
            .send(routeTicket);
        expect(blockedCrossSite.status).toBe(403);
        expect(blockedCrossSite.body.code).toBe('same_origin_required');

        const oversized = await request(app)
            .post('/api/service-desk/tickets')
            .send({ problem: 'x'.repeat((128 * 1024) + 1) });
        expect(oversized.status).toBe(413);
        expect(oversized.body.code).toBe('request_too_large');

        const created = await request(app)
            .post('/api/service-desk/tickets')
            .send(routeTicket);
        expect(created.status).toBe(201);
        expect(created.body.ticket.customer).toEqual({
            id: lifecycleCustomer.organisationId,
            name: 'Service Desk Route Customer'
        });

        const investigated = await request(app)
            .post(`/api/service-desk/tickets/${created.body.ticket.id}/investigate`)
            .send({ expectedRevision: created.body.revision });
        expect(investigated.status).toBe(200);
        expect(investigated.body.ticket.status).toBe('awaiting_approval');

        const blockedApproval = await request(app)
            .post(`/api/service-desk/tickets/${created.body.ticket.id}/approve`)
            .send({
                expectedRevision: investigated.body.revision,
                recommendationId: investigated.body.ticket.recommendation.id,
                confirmed: true
            });
        expect(blockedApproval.status).toBe(409);
        expect(blockedApproval.body.code).toBe('maker_checker_separation_required');

        const audit = await request(app).get('/api/service-desk/audit');
        expect(audit.status).toBe(200);
        expect(audit.body.events.some((event) => event.action === 'investigation.completed')).toBe(true);
        expect(audit.body.events.some((event) => event.action === 'remediation.approved')).toBe(false);
        expect(audit.body.events.some((event) => event.action === 'remediation.executed')).toBe(false);
    });

    test('Azure Function wrapper enforces request size with the shared byte counter', async () => {
        const context = { res: null, log: { error: jest.fn() } };
        await runServiceDeskFunction(context, {
            method: 'POST',
            url: '/api/service-desk/tickets',
            headers: { 'content-length': String((128 * 1024) + 1) },
            body: {}
        });
        expect(context.res.status).toBe(413);
        expect(context.res.body).toMatchObject({ code: 'request_too_large' });
    });
});

function createHarness(options = {}) {
    harnessCounter += 1;
    const dataDir = path.join(testDataDir, `harness-${harnessCounter}`);
    const repository = createServiceDeskRepository({
        dataDir,
        provider: 'local',
        env: { NOFRIES_AGENT_RUNTIME: 'mock' }
    });
    let sequence = 0;
    const defaultCustomer = {
        id: 'demo-customer',
        name: 'Demo customer',
        lifecycleState: 'active',
        onboardingStatus: 'complete',
        devices: [{ id: 'demo-win11-07', label: 'Demo Windows 11 computer', platform: 'windows', status: 'verified' }]
    };
    const defaultContextProvider = {
        async listServiceDeskCustomers() {
            return {
                revision: 0,
                customers: [defaultCustomer],
                readiness: { eligible: true, eligibleCustomerCount: 1, blockedCustomerCount: 0 }
            };
        },
        async requireServiceDeskCustomer(activeAccess, customerId) {
            if (customerId !== defaultCustomer.id) {
                throw new ServiceDeskRepositoryError(404, 'Service-desk customer not found', {
                    code: 'service_desk_customer_not_found'
                });
            }
            return defaultCustomer;
        },
        async getSharedContext() {
            return null;
        },
        async recordServiceEvent() {
            return { linked: true, created: true };
        }
    };
    const service = createServiceDeskService({
        repository,
        env: { NOFRIES_AGENT_RUNTIME: 'mock' },
        adapterFactory: options.adapterFactory,
        contextProvider: Object.assign({}, defaultContextProvider, options.contextProvider || {}),
        createId(prefix) {
            sequence += 1;
            return `${prefix}_${harnessCounter}_${sequence}`;
        }
    });
    return { repository, service };
}

function access(tenantId, role, email, principalId = `principal-${email}`) {
    return {
        allowed: true,
        user: {
            email,
            name: role === 'admin' ? 'Joel' : 'Consultant',
            principalId,
            role,
            capabilities: ROLE_CAPABILITIES[role].slice()
        },
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: `Tenant ${tenantId}`,
            slug: tenantId
        },
        authentication: {
            required: false,
            authenticated: false,
            provider: 'test'
        }
    };
}

function ticketInput(expectedRevision, overrides = {}) {
    return Object.assign({
        expectedRevision,
        clientRequestId: `test-request-${expectedRevision}`,
        customerId: 'demo-customer',
        customerName: 'Demo customer',
        affectedUser: 'alex.taylor@example.invalid',
        requesterEmail: 'alex.taylor@example.invalid',
        intakeChannel: 'portal',
        requesterVerificationMethod: 'Authenticated test portal session',
        requesterVerificationRef: 'test-identity:alex-taylor',
        deviceId: 'demo-win11-07',
        incidentType: 'outlook_authentication',
        summary: 'Outlook keeps asking for my password',
        problem: 'Outlook opens, then repeatedly asks me to sign in and will not connect to the mailbox.'
    }, overrides);
}

async function createActiveLifecycleCustomer(service, operator, displayName) {
    const created = await service.createInternalPilotCustomer(operator, {
        displayName,
        primaryContactName: 'Route Test Admin',
        primaryEmail: 'route@example.com',
        expectedUsers: 1,
        expectedEndpoints: 2,
        location: 'Auckland',
        productivityPlatform: 'microsoft_365',
        devices: [
            { id: 'route_windows', label: 'Route Windows computer', platform: 'windows' },
            { id: 'route_macos', label: 'Route macOS computer', platform: 'macos' }
        ],
        confirmInternalPilot: true
    });
    const linked = await service.syncDattoRmmSnapshot(operator, created.organisation.organisationId, {
        expectedRevision: created.revision,
        siteUid: 'site_service_desk_route',
        siteName: displayName,
        deviceCount: 2,
        openAlertCount: 0,
        capturedAt: new Date().toISOString(),
        devices: [
            { deviceUid: 'route-datto-windows', hostname: 'route-windows', operatingSystem: 'Windows 11', lastSeen: new Date().toISOString(), online: true },
            { deviceUid: 'route-datto-macos', hostname: 'route-macos', operatingSystem: 'macOS', lastSeen: new Date().toISOString(), online: true }
        ]
    });
    let matched = await service.matchOnboardingDevice(operator, created.organisation.organisationId, {
        expectedRevision: linked.revision,
        deviceId: 'route_windows',
        providerDeviceUid: 'route-datto-windows',
        confirmMatch: true
    });
    matched = await service.matchOnboardingDevice(operator, created.organisation.organisationId, {
        expectedRevision: matched.revision,
        deviceId: 'route_macos',
        providerDeviceUid: 'route-datto-macos',
        confirmMatch: true
    });
    const windows = await advanceOnboardingDevice(service, operator, created.organisation.organisationId, 'route_windows', matched);
    const macos = await advanceOnboardingDevice(service, operator, created.organisation.organisationId, 'route_macos', windows);
    const monitoringAcceptedAt = new Date().toISOString();
    const accepted = await service.recordOnboardingEvidence(operator, created.organisation.organisationId, {
        expectedRevision: macos.revision,
        gateId: 'monitoring_acceptance',
        evidenceId: 'route-monitoring-acceptance',
        evidenceRef: 'internal-pilot-register:route-monitoring',
        checksum: 'a'.repeat(64),
        capturedAt: monitoringAcceptedAt,
        validUntil: new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString(),
        customerAcceptedAt: monitoringAcceptedAt,
        customerAuthorityRef: 'internal-pilot-register:route-owner'
    });
    const requested = await service.requestActivation(operator, created.organisation.organisationId, {
        expectedRevision: accepted.revision,
        idempotencyKey: `activate:${created.organisation.organisationId}:v1`,
        customerAuthorityRef: 'internal-pilot-register:route-owner',
        confirmNoUnresolvedHighRiskExceptions: true
    });
    const checker = access(operator.tenant.id, 'service_owner', 'onboarding-checker@example.com');
    const executor = access(operator.tenant.id, 'admin', 'onboarding-executor@example.com');
    const reviewed = await service.reviewActivation(checker, created.organisation.organisationId, requested.request.id, {
        expectedRevision: requested.revision,
        decision: 'approve'
    });
    const active = await service.executeActivation(executor, created.organisation.organisationId, requested.request.id, {
        expectedRevision: reviewed.revision,
        confirmActivation: true
    });
    return active.organisation;
}

async function advanceOnboardingDevice(service, operator, organisationId, deviceId, initial) {
    let current = initial;
    for (const status of ['installer_ready', 'enrolled', 'verified']) {
        current = await service.updateOnboardingDevice(operator, organisationId, {
            expectedRevision: current.revision,
            deviceId,
            status
        });
    }
    return current;
}
