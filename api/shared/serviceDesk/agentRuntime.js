const crypto = require('crypto');
const {
    AGENT_IDS,
    TOOL_NAMES,
    publicAgentDefinitions
} = require('./agentDefinitions');
const {
    OUTLOOK_ACTION_KEY,
    createMockServiceDeskAdapters
} = require('./mockAdapters');
const { createToolGateway } = require('./toolGateway');
const { assertCapability } = require('../tenantAccess');
const { ServiceDeskRepositoryError } = require('./serviceDeskRepository');

const APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_TICKETS = 500;

function createServiceDeskService(options = {}) {
    const repository = options.repository;
    const env = options.env || process.env;
    const runtimeMode = String(env.NOFRIES_AGENT_RUNTIME || 'mock').trim().toLowerCase();
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const createId = typeof options.createId === 'function' ? options.createId : defaultCreateId;
    const adapterFactory = options.adapterFactory || createMockServiceDeskAdapters;
    const contextProvider = options.contextProvider || null;
    const ticketCreateLocks = new Map();

    if (!repository) {
        throw serviceDeskError(500, 'The service-desk repository is required', 'service_desk_not_configured');
    }
    if (runtimeMode !== 'mock') {
        throw serviceDeskError(
            503,
            'Milestone 1 only permits the deterministic mock agent runtime',
            'agent_runtime_not_enabled'
        );
    }

    return {
        async bootstrap(access) {
            assertCapability(access, 'service-desk:read');
            const [state, customerDirectory] = await Promise.all([
                repository.read(access),
                loadCustomerDirectory(access)
            ]);
            return {
                revision: state.revision,
                tenant: {
                    id: access.tenant.id,
                    name: access.tenant.name,
                    slug: access.tenant.slug
                },
                user: {
                    email: access.user.email,
                    name: access.user.name,
                    role: access.user.role,
                    capabilities: access.user.capabilities.filter((item) => item.startsWith('service-desk:'))
                },
                runtime: {
                    mode: 'mock',
                    externalChanges: false,
                    approvalRequired: true,
                    orchestration: 'service-manager-with-specialist-tools'
                },
                agents: publicAgentDefinitions(),
                customers: customerDirectory.customers,
                readiness: customerDirectory.readiness,
                scenario: {
                    category: 'Routine support',
                    name: 'Outlook sign-in',
                    incidentType: 'outlook_authentication'
                },
                demo: {
                    affectedUser: 'alex.taylor@example.invalid',
                    incidentType: 'outlook_authentication',
                    summary: 'Outlook keeps asking for my password',
                    problem: 'Outlook opens, then repeatedly asks me to sign in and will not connect to the mailbox.'
                },
                tickets: state.tickets.slice(-25).reverse().map(publicTicket)
            };
        },

        async listTickets(access) {
            assertCapability(access, 'service-desk:read');
            const state = await repository.read(access);
            return {
                revision: state.revision,
                tickets: state.tickets.slice().reverse().map(publicTicket)
            };
        },

        async getTicket(access, ticketId) {
            assertCapability(access, 'service-desk:read');
            const state = await repository.read(access);
            return {
                revision: state.revision,
                ticket: publicTicket(findTicket(state, ticketId, access))
            };
        },

        async createTicket(access, input = {}) {
            assertCapability(access, 'service-desk:create');
            const requestedTicket = validateTicketInput(input);
            return withTicketCreateLock(access, requestedTicket.clientRequestId, async () => {
            const currentState = await repository.read(access);
            const existingTicket = currentState.tickets.find((ticket) => (
                ticket.clientRequestId === requestedTicket.clientRequestId
            ));
            if (existingTicket) {
                assertIdempotentTicketRequest(existingTicket, requestedTicket);
                return idempotentTicketResponse(access, currentState, existingTicket);
            }
            const customer = await requireCustomer(access, requestedTicket.customerId, requestedTicket);
            const device = (customer.devices || []).find((item) => (
                cleanIdentifier(item.id, 120) === requestedTicket.deviceId && item.status === 'verified'
            ));
            if (!device) {
                throw serviceDeskError(
                    409,
                    'Choose a verified computer from the selected customer set-up',
                    'verified_device_required'
                );
            }
            const ticketInput = Object.assign({}, requestedTicket, {
                customerId: cleanIdentifier(customer.id, 120),
                customerName: cleanText(customer.name, 180),
                deviceId: cleanIdentifier(device.id, 120)
            });
            const ticketId = deterministicTicketId(access, ticketInput.clientRequestId);
            const at = now().toISOString();
            const auditEvents = [];

            let mutation;
            try {
                mutation = await repository.mutate(access, {
                    expectedRevision: input.expectedRevision,
                    auditEvents
                }, async (state) => {
                const concurrentTicket = state.tickets.find((ticket) => (
                    ticket.id === ticketId ||
                    ticket.clientRequestId === ticketInput.clientRequestId
                ));
                if (concurrentTicket) {
                    assertIdempotentTicketRequest(concurrentTicket, ticketInput);
                    throw serviceDeskError(
                        409,
                        'This ticket changed while you were working. Reload and try again.',
                        'revision_conflict',
                        { currentRevision: Number(state.revision || 0) }
                    );
                }
                if (state.tickets.length >= MAX_TICKETS) {
                    throw serviceDeskError(409, 'The mock tenant has reached its ticket limit', 'ticket_limit_reached');
                }

                const gateway = makeGateway(access, ticketInput.customerId);
                const external = await gateway.invoke({
                    agentId: AGENT_IDS.SERVICE_MANAGER,
                    tool: TOOL_NAMES.AUTOTASK_TICKET_CREATE,
                    tenantId: access.tenant.id,
                    input: {
                        resourceTenantId: access.tenant.id,
                        resourceCustomerId: ticketInput.customerId,
                        idempotencyKey: ticketInput.clientRequestId,
                        ticketId,
                        summary: ticketInput.summary,
                        problem: ticketInput.problem,
                        affectedUser: ticketInput.affectedUser,
                        deviceId: ticketInput.deviceId
                    }
                });

                const ticket = {
                    id: ticketId,
                    clientRequestId: ticketInput.clientRequestId,
                    tenantId: access.tenant.id,
                    tenantKey: access.tenant.key,
                    externalTicketId: external.externalTicketId,
                    customer: {
                        id: ticketInput.customerId,
                        name: ticketInput.customerName
                    },
                    incidentType: ticketInput.incidentType,
                    summary: ticketInput.summary,
                    problem: ticketInput.problem,
                    affectedUser: ticketInput.affectedUser,
                    requesterEmail: ticketInput.requesterEmail,
                    intakeChannel: ticketInput.intakeChannel,
                    requesterVerificationMethod: ticketInput.requesterVerificationMethod,
                    requesterVerificationRef: ticketInput.requesterVerificationRef,
                    deviceId: ticketInput.deviceId,
                    severity: 'medium',
                    status: 'open',
                    stage: 'triage',
                    simulated: true,
                    createdBy: access.user.email,
                    createdAt: at,
                    updatedAt: at,
                    investigation: null,
                    recommendation: null,
                    approval: null,
                    execution: null,
                    verification: null,
                    customerUpdate: null,
                    timeline: []
                };
                appendTimeline(ticket, {
                    at,
                    actorType: 'agent',
                    actorId: AGENT_IDS.SERVICE_MANAGER,
                    title: 'Request accepted and ticket opened',
                    detail: `Created mock Autotask ticket ${external.externalTicketId} and retained ownership of the response.`
                }, createId);
                state.tickets.push(ticket);
                auditEvents.push(userAudit(access, 'ticket.created', ticket, 'Service request captured'));
                auditEvents.push(...gateway.drainAuditEvents());
                return ticket;
                });
            } catch (error) {
                if (error && error.details && error.details.code === 'revision_conflict') {
                    const latestState = await repository.read(access);
                    const winner = latestState.tickets.find((ticket) => (
                        ticket.clientRequestId === ticketInput.clientRequestId
                    ));
                    if (winner) {
                        assertIdempotentTicketRequest(winner, ticketInput);
                        return idempotentTicketResponse(access, latestState, winner);
                    }
                }
                throw error;
            }

            const contextSync = await syncLifecycleEvent(
                access,
                mutation.result,
                ticketRaisedLifecycleEvent(mutation.result)
            );

            return {
                revision: mutation.state.revision,
                ticket: publicTicket(mutation.result),
                contextSync
            };
            });
        },

        async investigateTicket(access, ticketId, input = {}) {
            assertCapability(access, 'service-desk:investigate');
            const maker = requireHumanIdentity(access);
            const auditEvents = [];
            const mutation = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const ticket = findTicket(state, ticketId, access);
                await requireCurrentTicketCustomer(access, ticket);
                if (ticket.recommendation) {
                    throw serviceDeskError(409, 'This ticket already has an investigation and recommendation', 'already_investigated');
                }
                if (ticket.status !== 'open') {
                    throw serviceDeskError(409, 'This ticket is not ready for investigation', 'invalid_ticket_state');
                }

                const gateway = makeGateway(access, ticket.customer.id);
                const baseInput = {
                    resourceTenantId: access.tenant.id,
                    resourceCustomerId: ticket.customer.id,
                    ticketId: ticket.id,
                    externalTicketId: ticket.externalTicketId,
                    status: ticket.status,
                    summary: ticket.summary,
                    affectedUser: ticket.affectedUser,
                    deviceId: ticket.deviceId
                };
                ticket.status = 'investigating';
                ticket.stage = 'investigation';

                const customerContext = contextProvider && typeof contextProvider.getSharedContext === 'function'
                    ? await contextProvider.getSharedContext(access, ticket.customer.id)
                    : null;

                const ticketEvidence = await gateway.invoke({
                    agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                    tool: TOOL_NAMES.AUTOTASK_TICKET_READ,
                    tenantId: access.tenant.id,
                    input: baseInput
                });
                const [deviceEvidence, authEvidence, runbookEvidence] = await Promise.all([
                    gateway.invoke({
                        agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                        tool: TOOL_NAMES.DATTO_DEVICE_READ,
                        tenantId: access.tenant.id,
                        input: baseInput
                    }),
                    gateway.invoke({
                        agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                        tool: TOOL_NAMES.DATTO_OUTLOOK_AUTH_READ,
                        tenantId: access.tenant.id,
                        input: baseInput
                    }),
                    gateway.invoke({
                        agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                        tool: TOOL_NAMES.IT_GLUE_RUNBOOK_SEARCH,
                        tenantId: access.tenant.id,
                        input: Object.assign({}, baseInput, {
                            query: `${ticket.summary} ${ticket.problem}`
                        })
                    })
                ]);

                const investigatedAt = now().toISOString();
                const runbook = runbookEvidence.results[0];
                if (!runbook) {
                    throw serviceDeskError(422, 'No approved mock runbook matched this incident', 'runbook_not_found');
                }

                const recommendationId = createId('recommendation');
                const correlationId = `service_desk:${ticket.id}:${recommendationId}`;
                ticket.investigation = {
                    agentId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                    maker,
                    startedAt: ticket.updatedAt,
                    completedAt: investigatedAt,
                    observations: [
                        `Device ${deviceEvidence.hostname} is online and its core health checks are healthy.`,
                        `Outlook recorded ${authEvidence.tokenRefreshFailures} token refresh failures in ${authEvidence.failureWindowMinutes} minutes.`,
                        'Microsoft 365 service health and network reachability are healthy.',
                        `Matched approved internal runbook ${runbook.id}.`
                    ],
                    diagnosis: 'The evidence is consistent with a stale local Outlook authentication token cache, not a Microsoft 365 outage or general device failure.',
                    customerContext: compactCustomerContext(customerContext, ticket.customer),
                    evidence: {
                        ticket: ticketEvidence,
                        device: deviceEvidence,
                        outlookAuthentication: authEvidence,
                        runbook
                    }
                };
                ticket.recommendation = {
                    id: recommendationId,
                    correlationId,
                    actionKey: OUTLOOK_ACTION_KEY,
                    title: 'Reset the local Outlook authentication token cache and restart Outlook',
                    rationale: 'The device and Microsoft 365 service are healthy; the failures are isolated to the local token cache.',
                    risk: 'low',
                    scope: `One simulated action on ${ticket.deviceId} for ${ticket.affectedUser}`,
                    approvalRequired: true,
                    runbookId: runbook.id,
                    createdByAgent: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                    maker,
                    createdAt: investigatedAt
                };
                ticket.status = 'awaiting_approval';
                ticket.stage = 'approval';
                ticket.updatedAt = investigatedAt;
                appendTimeline(ticket, {
                    at: investigatedAt,
                    actorType: 'agent',
                    actorId: AGENT_IDS.TECHNICAL_INVESTIGATOR,
                    title: 'Read-only investigation completed',
                    detail: ticket.investigation.diagnosis
                }, createId);
                appendTimeline(ticket, {
                    at: investigatedAt,
                    actorType: 'agent',
                    actorId: AGENT_IDS.SERVICE_MANAGER,
                    title: 'Recommendation held for human approval',
                    detail: 'No remediation has run. An administrator or service owner must explicitly approve the exact proposed action.'
                }, createId);
                auditEvents.push(...gateway.drainAuditEvents());
                auditEvents.push(agentAudit(
                    AGENT_IDS.TECHNICAL_INVESTIGATOR,
                    'investigation.completed',
                    ticket,
                    'Outlook authentication incident investigated with read-only evidence',
                    governanceAuditDetails(ticket, { maker })
                ));
                return ticket;
            });

            const contextSync = await syncLifecycleEvent(access, mutation.result, {
                type: 'recommendation_created',
                category: mutation.result.incidentType,
                summary: mutation.result.recommendation && mutation.result.recommendation.title,
                outcome: 'awaiting_approval',
                occurredAt: mutation.result.recommendation && mutation.result.recommendation.createdAt,
                simulated: mutation.result.simulated,
                requiresAttention: true
            });

            return {
                revision: mutation.state.revision,
                ticket: publicTicket(mutation.result),
                contextSync
            };
        },

        async approveRecommendation(access, ticketId, input = {}) {
            assertCapability(access, 'service-desk:approve');
            if (input.confirmed !== true) {
                throw serviceDeskError(
                    400,
                    'Explicit confirmation is required before approving a remediation',
                    'approval_confirmation_required'
                );
            }
            const checker = requireHumanIdentity(access);

            const auditEvents = [];
            const mutation = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const ticket = findTicket(state, ticketId, access);
                await requireCurrentTicketCustomer(access, ticket);
                if (!ticket.recommendation || ticket.status !== 'awaiting_approval') {
                    throw serviceDeskError(409, 'This ticket is not awaiting approval', 'invalid_ticket_state');
                }
                if (String(input.recommendationId || '') !== ticket.recommendation.id) {
                    throw serviceDeskError(409, 'The recommendation changed before approval', 'recommendation_mismatch');
                }
                if (ticket.approval) {
                    throw serviceDeskError(409, 'This recommendation has already been approved', 'already_approved');
                }
                const maker = requireStoredHumanIdentity(
                    ticket.recommendation.maker,
                    'maker_identity_required',
                    'The recommendation does not contain a verified human maker identity'
                );
                if (sameHumanIdentity(maker, checker)) {
                    throw serviceDeskError(
                        409,
                        'The recommendation maker cannot approve their own remediation',
                        'maker_checker_separation_required'
                    );
                }

                const approvedAt = now();
                ticket.approval = {
                    id: createId('approval'),
                    ticketId: ticket.id,
                    recommendationId: ticket.recommendation.id,
                    actionKey: ticket.recommendation.actionKey,
                    status: 'active',
                    approvedBy: access.user.email,
                    approvedRole: access.user.role,
                    checker,
                    approvedAt: approvedAt.toISOString(),
                    expiresAt: new Date(approvedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
                    consumedAt: ''
                };
                ticket.status = 'approved';
                ticket.stage = 'execution';
                ticket.updatedAt = approvedAt.toISOString();
                appendTimeline(ticket, {
                    at: approvedAt.toISOString(),
                    actorType: 'user',
                    actorId: access.user.email,
                    title: 'Remediation explicitly approved',
                    detail: `${access.user.email} approved only ${ticket.recommendation.title}.`
                }, createId);
                auditEvents.push(userAudit(
                    access,
                    'remediation.approved',
                    ticket,
                    'Bound approval issued for one recommendation and one action',
                    governanceAuditDetails(ticket, { maker, checker })
                ));
                return ticket;
            });

            const contextSync = await syncLifecycleEvent(access, mutation.result, {
                type: 'approval_granted',
                category: mutation.result.incidentType,
                summary: mutation.result.recommendation && mutation.result.recommendation.title,
                outcome: 'approved',
                occurredAt: mutation.result.approval && mutation.result.approval.approvedAt,
                simulated: mutation.result.simulated
            });

            return {
                revision: mutation.state.revision,
                ticket: publicTicket(mutation.result),
                contextSync
            };
        },

        async executeApprovedRemediation(access, ticketId, input = {}) {
            assertCapability(access, 'service-desk:execute');
            const executor = requireHumanIdentity(access);
            const auditEvents = [];
            let customerGovernanceError = null;
            const mutation = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const ticket = findTicket(state, ticketId, access);
                const governance = assertExecutableApproval(ticket, input.approvalId, now(), executor);
                try {
                    await requireCurrentTicketCustomer(access, ticket);
                } catch (error) {
                    const blockedAt = now().toISOString();
                    customerGovernanceError = error;
                    ticket.approval.status = 'revoked';
                    ticket.approval.revokedAt = blockedAt;
                    ticket.approval.revokedReason = cleanIdentifier(
                        error && error.details && error.details.code || 'customer_governance_changed',
                        120
                    );
                    ticket.status = 'needs_attention';
                    ticket.stage = 'customer_governance';
                    ticket.updatedAt = blockedAt;
                    appendTimeline(ticket, {
                        at: blockedAt,
                        actorType: 'system',
                        actorId: 'customer-lifecycle-policy',
                        title: 'Approval revoked after customer readiness changed',
                        detail: 'Execution was blocked because the current customer, service, requester, SLA, device, or RMM evidence no longer met the service-desk admission controls.'
                    }, createId);
                    auditEvents.push(agentAudit(
                        AGENT_IDS.SERVICE_MANAGER,
                        'remediation.approval_revoked',
                        ticket,
                        'Execution blocked and the outstanding approval revoked after customer readiness changed',
                        governanceAuditDetails(ticket, {
                            maker: governance.maker,
                            checker: governance.checker,
                            executor
                        })
                    ));
                    return ticket;
                }
                ticket.approval.executor = executor;

                const gateway = makeGateway(access, ticket.customer.id);
                const baseInput = {
                    resourceTenantId: access.tenant.id,
                    resourceCustomerId: ticket.customer.id,
                    ticketId: ticket.id,
                    externalTicketId: ticket.externalTicketId,
                    recommendationId: ticket.recommendation.id,
                    actionKey: ticket.recommendation.actionKey,
                    deviceId: ticket.deviceId,
                    affectedUser: ticket.affectedUser,
                    approval: ticket.approval
                };

                const execution = await gateway.invoke({
                    agentId: AGENT_IDS.ACTION_AGENT,
                    tool: TOOL_NAMES.DATTO_REMEDIATION_SIMULATE,
                    tenantId: access.tenant.id,
                    input: baseInput
                });
                const verification = await gateway.invoke({
                    agentId: AGENT_IDS.ACTION_AGENT,
                    tool: TOOL_NAMES.DATTO_REMEDIATION_VERIFY,
                    tenantId: access.tenant.id,
                    input: Object.assign({}, baseInput, { execution })
                });

                const completedAt = now().toISOString();
                const resolved = verification.passed === true;
                const customerMessage = resolved
                    ? 'We found a stale Outlook sign-in token on the affected computer. The approved reset was simulated successfully, and we verified that all four checks passed. No Microsoft 365 outage or wider device fault was identified.'
                    : 'The approved simulated action completed, but verification did not pass. No further action has been taken and the ticket needs human review.';

                await gateway.invoke({
                    agentId: AGENT_IDS.SERVICE_MANAGER,
                    tool: TOOL_NAMES.AUTOTASK_TICKET_UPDATE,
                    tenantId: access.tenant.id,
                    input: Object.assign({}, baseInput, {
                        status: resolved ? 'Complete' : 'Waiting customer',
                        note: customerMessage
                    })
                });

                ticket.execution = Object.assign({}, execution, {
                    agentId: AGENT_IDS.ACTION_AGENT,
                    approvalId: ticket.approval.id,
                    correlationId: operationCorrelationId(ticket),
                    executor
                });
                ticket.verification = Object.assign({}, verification, {
                    agentId: AGENT_IDS.ACTION_AGENT
                });
                ticket.approval.status = 'consumed';
                ticket.approval.consumedAt = completedAt;
                ticket.customerUpdate = {
                    preparedByAgent: AGENT_IDS.SERVICE_MANAGER,
                    channel: 'ticket',
                    subject: resolved ? 'Outlook access restored' : 'Outlook issue needs further review',
                    message: customerMessage,
                    preparedAt: completedAt
                };
                ticket.status = resolved ? 'resolved' : 'needs_attention';
                ticket.stage = resolved ? 'complete' : 'verification';
                ticket.updatedAt = completedAt;
                ticket.resolvedAt = resolved ? completedAt : '';
                appendTimeline(ticket, {
                    at: completedAt,
                    actorType: 'agent',
                    actorId: AGENT_IDS.ACTION_AGENT,
                    title: 'Approved remediation simulated',
                    detail: 'The Action Agent executed only the action bound to the approval.'
                }, createId);
                appendTimeline(ticket, {
                    at: completedAt,
                    actorType: 'agent',
                    actorId: AGENT_IDS.ACTION_AGENT,
                    title: resolved ? 'Verification passed' : 'Verification needs review',
                    detail: `${verification.checks.filter((check) => check.passed).length} of ${verification.checks.length} checks passed.`
                }, createId);
                appendTimeline(ticket, {
                    at: completedAt,
                    actorType: 'agent',
                    actorId: AGENT_IDS.SERVICE_MANAGER,
                    title: 'Ticket and customer update prepared',
                    detail: customerMessage
                }, createId);
                auditEvents.push(...gateway.drainAuditEvents());
                auditEvents.push(agentAudit(
                    AGENT_IDS.ACTION_AGENT,
                    'remediation.executed',
                    ticket,
                    'One approval-bound mock remediation executed and verified',
                    governanceAuditDetails(ticket, {
                        maker: governance.maker,
                        checker: governance.checker,
                        executor
                    })
                ));
                auditEvents.push(agentAudit(
                    AGENT_IDS.SERVICE_MANAGER,
                    'ticket.customer_update_prepared',
                    ticket,
                    'Ticket outcome documented for the customer',
                    governanceAuditDetails(ticket, {
                        maker: governance.maker,
                        checker: governance.checker,
                        executor
                    })
                ));
                return ticket;
            });

            if (customerGovernanceError) {
                throw customerGovernanceError;
            }

            const resolved = mutation.result.status === 'resolved';
            const contextSync = await syncLifecycleEvent(access, mutation.result, {
                type: resolved ? 'ticket_resolved' : 'ticket_needs_attention',
                category: mutation.result.incidentType,
                summary: mutation.result.customerUpdate && mutation.result.customerUpdate.subject || mutation.result.summary,
                outcome: mutation.result.status,
                occurredAt: mutation.result.updatedAt,
                simulated: mutation.result.simulated,
                requiresAttention: !resolved,
                remediation: true
            });

            return {
                revision: mutation.state.revision,
                ticket: publicTicket(mutation.result),
                contextSync
            };
        },

        async getAudit(access) {
            assertCapability(access, 'service-desk:audit:read');
            const state = await repository.read(access);
            return {
                revision: state.revision,
                events: state.audit.slice(-500).reverse()
            };
        }
    };

    async function loadCustomerDirectory(access) {
        if (!contextProvider || typeof contextProvider.listServiceDeskCustomers !== 'function') {
            throw serviceDeskError(503, 'The customer set-up directory is unavailable', 'customer_directory_unavailable');
        }
        return contextProvider.listServiceDeskCustomers(access);
    }

    async function requireCustomer(access, customerId, admission) {
        if (!contextProvider || typeof contextProvider.requireServiceDeskCustomer !== 'function') {
            throw serviceDeskError(503, 'The customer set-up directory is unavailable', 'customer_directory_unavailable');
        }
        return contextProvider.requireServiceDeskCustomer(access, customerId, admission);
    }

    async function requireCurrentTicketCustomer(access, ticket) {
        const admission = requireStoredRequesterAdmissionEvidence(ticket);
        const customer = await requireCustomer(access, ticket.customer.id, admission);
        const deviceIsCurrent = Array.isArray(customer && customer.devices) && customer.devices.some((device) => (
            cleanIdentifier(device && device.id, 120) === cleanIdentifier(ticket.deviceId, 120) &&
            device.status === 'verified'
        ));
        if (!deviceIsCurrent) {
            throw serviceDeskError(
                409,
                'The ticket computer is no longer a current verified device for this customer',
                'verified_device_required'
            );
        }
        return customer;
    }

    function makeGateway(access, customerId) {
        return createToolGateway({
            tenantId: access.tenant.id,
            customerId,
            adapters: adapterFactory({ tenantId: access.tenant.id, customerId }),
            now
        });
    }

    async function withTicketCreateLock(access, clientRequestId, task) {
        const key = `${access.tenant.key}:${clientRequestId}`;
        const previous = ticketCreateLocks.get(key) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        ticketCreateLocks.set(key, gate);
        await previous;
        try {
            return await task();
        } finally {
            release();
            if (ticketCreateLocks.get(key) === gate) {
                ticketCreateLocks.delete(key);
            }
        }
    }

    async function idempotentTicketResponse(access, state, ticket) {
        const contextSync = await syncLifecycleEvent(access, ticket, ticketRaisedLifecycleEvent(ticket));
        return {
            revision: state.revision,
            ticket: publicTicket(ticket),
            contextSync,
            idempotentReplay: true
        };
    }

    function ticketRaisedLifecycleEvent(ticket) {
        return {
            type: 'ticket_raised',
            category: ticket.incidentType,
            summary: ticket.summary,
            outcome: 'open',
            occurredAt: ticket.createdAt,
            simulated: ticket.simulated
        };
    }

    async function syncLifecycleEvent(access, ticket, event) {
        if (!contextProvider || typeof contextProvider.recordServiceEvent !== 'function') {
            return { linked: false, reason: 'context_provider_not_configured' };
        }
        try {
            const result = await contextProvider.recordServiceEvent(access, ticket.customer.id, Object.assign({}, event, {
                id: `service_desk:${ticket.id}:${event.type}`,
                ticketId: ticket.id,
                source: 'service_desk'
            }));
            return {
                linked: result && result.linked === true,
                created: result && result.created === true,
                reason: cleanIdentifier(result && result.reason, 120),
                eventId: cleanIdentifier(result && result.event && result.event.id, 220)
            };
        } catch (error) {
            return {
                linked: false,
                reason: 'lifecycle_sync_failed',
                code: cleanIdentifier(error && error.details && error.details.code || 'unknown', 120)
            };
        }
    }
}

function requireStoredRequesterAdmissionEvidence(ticket) {
    const admission = {
        requesterEmail: cleanText(ticket && ticket.requesterEmail, 254).toLowerCase(),
        intakeChannel: cleanIdentifier(ticket && ticket.intakeChannel, 40),
        requesterVerificationMethod: cleanText(ticket && ticket.requesterVerificationMethod, 120),
        requesterVerificationRef: cleanText(ticket && ticket.requesterVerificationRef, 500)
    };
    const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admission.requesterEmail);
    const channelIsValid = ['email', 'phone', 'portal'].includes(admission.intakeChannel);
    const verificationIsSafe = Boolean(
        admission.requesterVerificationMethod &&
        admission.requesterVerificationRef &&
        !/(?:authorization|bearer|token=|password|secret|api[_-]?key)/i.test(admission.requesterVerificationRef)
    );

    if (!emailIsValid || !channelIsValid || !verificationIsSafe) {
        throw serviceDeskError(
            409,
            'The ticket does not contain complete, safe requester-admission evidence and must be reviewed before work continues',
            'ticket_requester_admission_evidence_required'
        );
    }
    return admission;
}

function assertExecutableApproval(ticket, approvalId, currentTime, executor) {
    if (!ticket.recommendation || !ticket.approval) {
        throw serviceDeskError(409, 'An approved recommendation is required', 'approval_required');
    }
    if (ticket.status !== 'approved' || ticket.approval.status !== 'active') {
        throw serviceDeskError(409, 'This approval is not active', 'approval_consumed');
    }
    if (String(approvalId || '') !== ticket.approval.id) {
        throw serviceDeskError(409, 'The supplied approval does not match this ticket', 'approval_mismatch');
    }
    if (
        ticket.approval.ticketId !== ticket.id ||
        ticket.approval.recommendationId !== ticket.recommendation.id ||
        ticket.approval.actionKey !== ticket.recommendation.actionKey
    ) {
        throw serviceDeskError(409, 'The approval is not bound to the current recommendation', 'approval_mismatch');
    }
    if (new Date(ticket.approval.expiresAt).getTime() <= currentTime.getTime()) {
        throw serviceDeskError(409, 'The remediation approval has expired', 'approval_expired');
    }
    const maker = requireStoredHumanIdentity(
        ticket.recommendation.maker,
        'maker_identity_required',
        'The recommendation does not contain a verified human maker identity'
    );
    const checker = requireStoredHumanIdentity(
        ticket.approval.checker,
        'checker_identity_required',
        'The approval does not contain a verified human checker identity'
    );
    if (sameHumanIdentity(maker, checker)) {
        throw serviceDeskError(
            409,
            'The recommendation maker cannot approve their own remediation',
            'maker_checker_separation_required'
        );
    }
    if (sameHumanIdentity(maker, executor)) {
        throw serviceDeskError(
            409,
            'The recommendation maker cannot execute their own remediation',
            'maker_executor_separation_required'
        );
    }
    if (sameHumanIdentity(checker, executor)) {
        throw serviceDeskError(
            409,
            'The approval checker cannot execute the remediation they approved',
            'checker_executor_separation_required'
        );
    }
    return { maker, checker };
}

function validateTicketInput(input) {
    const clientRequestId = cleanIdentifier(input.clientRequestId, 120);
    const customerId = cleanIdentifier(input.customerId, 120);
    const affectedUser = cleanText(input.affectedUser, 254).toLowerCase();
    const deviceId = cleanIdentifier(input.deviceId, 120);
    const problem = cleanText(input.problem, 4000);
    const summary = cleanText(input.summary || problem, 180);
    const incidentType = cleanIdentifier(input.incidentType || 'outlook_authentication', 80);
    const requesterEmail = cleanText(input.requesterEmail || affectedUser, 254).toLowerCase();
    const intakeChannel = cleanIdentifier(input.intakeChannel || 'portal', 40);
    const requesterVerificationMethod = cleanText(input.requesterVerificationMethod, 120);
    const requesterVerificationRef = cleanText(input.requesterVerificationRef, 500);

    if (!clientRequestId) {
        throw serviceDeskError(400, 'A ticket request identity is required', 'ticket_request_id_required');
    }
    if (!customerId || !affectedUser || !deviceId || !problem || !summary) {
        throw serviceDeskError(400, 'Customer, user, device, summary, and problem are required', 'ticket_fields_required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(affectedUser)) {
        throw serviceDeskError(400, 'A valid affected-user email is required', 'affected_user_invalid');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) {
        throw serviceDeskError(400, 'A valid requester email is required', 'requester_email_invalid');
    }
    if (!['email', 'phone', 'portal'].includes(intakeChannel)) {
        throw serviceDeskError(400, 'A supported intake channel is required', 'intake_channel_invalid');
    }
    if (!requesterVerificationMethod || !requesterVerificationRef || /(?:authorization|bearer|token=|password|secret|api[_-]?key)/i.test(requesterVerificationRef)) {
        throw serviceDeskError(400, 'Record a safe requester-verification method and evidence reference', 'requester_verification_required');
    }
    if (incidentType !== 'outlook_authentication') {
        throw serviceDeskError(422, 'Milestone 1 supports only the mocked Outlook authentication incident', 'incident_type_not_supported');
    }
    if (/password\s*[:=]|secret\s*[:=]|bearer\s+[a-z0-9._-]+/i.test(problem)) {
        throw serviceDeskError(400, 'Do not include passwords, secrets, or access tokens in a ticket', 'sensitive_data_rejected');
    }

    return {
        clientRequestId,
        customerId,
        requesterEmail,
        intakeChannel,
        requesterVerificationMethod,
        requesterVerificationRef,
        affectedUser,
        deviceId,
        problem,
        summary,
        incidentType
    };
}

function assertIdempotentTicketRequest(ticket, requested) {
    const matches = (
        ticket.customer && ticket.customer.id === requested.customerId &&
        ticket.requesterEmail === requested.requesterEmail &&
        ticket.intakeChannel === requested.intakeChannel &&
        ticket.requesterVerificationMethod === requested.requesterVerificationMethod &&
        ticket.requesterVerificationRef === requested.requesterVerificationRef &&
        ticket.affectedUser === requested.affectedUser &&
        ticket.deviceId === requested.deviceId &&
        ticket.summary === requested.summary &&
        ticket.problem === requested.problem &&
        ticket.incidentType === requested.incidentType
    );
    if (!matches) {
        throw serviceDeskError(
            409,
            'This ticket request identity has already been used for different details',
            'ticket_request_id_reused'
        );
    }
}

function findTicket(state, ticketId, access) {
    const id = String(ticketId || '').trim();
    const ticket = state.tickets.find((item) => item.id === id);
    if (!ticket) {
        throw serviceDeskError(404, 'Ticket not found', 'ticket_not_found');
    }
    if (ticket.tenantId !== access.tenant.id || ticket.tenantKey !== access.tenant.key) {
        throw serviceDeskError(403, 'The ticket is outside the active tenant', 'tenant_boundary_violation');
    }
    return ticket;
}

function publicTicket(ticket) {
    return JSON.parse(JSON.stringify(ticket));
}

function compactCustomerContext(context, fallbackCustomer) {
    if (!context) {
        return {
            status: 'unknown',
            customerId: fallbackCustomer.id,
            customerName: fallbackCustomer.name,
            note: 'No linked lifecycle context was found. The investigator did not infer missing customer information.'
        };
    }
    return {
        status: 'available',
        organisationId: context.organisationId,
        displayName: context.displayName,
        lifecycleState: context.lifecycleState,
        productivity: context.context && context.context.productivity,
        itProvider: context.context && context.context.itProvider,
        internalIt: context.context && context.context.internalIt,
        security: context.context && context.context.security,
        applications: context.context && context.context.applications,
        discovery: context.discovery
    };
}

function appendTimeline(ticket, event, createId) {
    ticket.timeline.push(Object.assign({ id: createId('timeline') }, event));
}

function userAudit(access, action, ticket, summary, details = {}) {
    return {
        actorType: 'user',
        actorId: access.user.email,
        actorName: access.user.name || access.user.email,
        actorRole: access.user.role,
        action,
        targetType: 'ticket',
        targetId: ticket.id,
        ticketId: ticket.id,
        summary,
        details
    };
}

function agentAudit(agentId, action, ticket, summary, details = {}) {
    return {
        actorType: 'agent',
        actorId: agentId,
        actorName: agentId === AGENT_IDS.SERVICE_MANAGER
            ? 'Service Manager'
            : agentId === AGENT_IDS.TECHNICAL_INVESTIGATOR
                ? 'Technical Investigator'
                : 'Action Agent',
        action,
        targetType: 'ticket',
        targetId: ticket.id,
        ticketId: ticket.id,
        summary,
        details: Object.assign({ simulated: true }, details)
    };
}

function requireHumanIdentity(access) {
    const identity = normaliseHumanIdentity(access && access.user);
    if (!identity) {
        throw serviceDeskError(
            403,
            'A verified human identity is required for this service-desk action',
            'human_identity_required'
        );
    }
    return identity;
}

function requireStoredHumanIdentity(value, code, message) {
    const identity = normaliseHumanIdentity(value);
    if (!identity) {
        throw serviceDeskError(409, message, code);
    }
    return identity;
}

function normaliseHumanIdentity(value) {
    const email = cleanText(value && value.email, 254).toLowerCase();
    const principalId = cleanIdentifier(value && value.principalId, 180);
    if (!email && !principalId) {
        return null;
    }
    return {
        identityKey: principalId ? `principal:${principalId}` : `email:${email}`,
        principalId,
        email,
        role: cleanIdentifier(value && value.role, 80)
    };
}

function sameHumanIdentity(left, right) {
    return Boolean(
        left &&
        right &&
        (
            (left.principalId && right.principalId && left.principalId === right.principalId) ||
            (left.email && right.email && left.email === right.email) ||
            (left.identityKey && right.identityKey && left.identityKey === right.identityKey)
        )
    );
}

function operationCorrelationId(ticket) {
    return cleanText(
        ticket && ticket.recommendation && ticket.recommendation.correlationId ||
        `service_desk:${ticket && ticket.id || 'unknown'}:${ticket && ticket.recommendation && ticket.recommendation.id || 'unknown'}`,
        500
    );
}

function governanceAuditDetails(ticket, actors = {}) {
    const details = { correlationId: operationCorrelationId(ticket) };
    for (const label of ['maker', 'checker', 'executor']) {
        const identity = normaliseHumanIdentity(actors[label]);
        if (!identity) {
            continue;
        }
        details[`${label}IdentityKey`] = identity.identityKey;
        details[`${label}PrincipalId`] = identity.principalId;
        details[`${label}Email`] = identity.email;
        details[`${label}Role`] = identity.role;
    }
    return details;
}

function serviceDeskError(statusCode, message, code, details = {}) {
    return new ServiceDeskRepositoryError(statusCode, message, Object.assign({ code }, details));
}

function cleanText(value, limit) {
    return String(value || '').trim().slice(0, limit);
}

function cleanIdentifier(value, limit = 180) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9@._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, limit);
}

function deterministicTicketId(access, clientRequestId) {
    const digest = crypto.createHash('sha256')
        .update(`${access.tenant.key}:${clientRequestId}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `ticket_${digest}`;
}

function defaultCreateId(prefix) {
    return `${prefix}_${typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`}`;
}

module.exports = {
    APPROVAL_TTL_MS,
    createServiceDeskService,
    validateTicketInput
};
