const { assertCapability } = require('../tenantAccess');
const { createAutotaskRuntime } = require('./autotaskRuntimeFactory');
const { assertServiceDeskProviderAdmission } = require('./serviceDeskProviderAdmission');
const { parseCanonicalProviderId } = require('./providerIds');

function createProductionServiceDeskService(options = {}) {
    const env = options.env || process.env;
    const contextProvider = options.contextProvider;
    const runtime = options.runtime || createAutotaskRuntime({ env });
    if (!contextProvider || typeof contextProvider.resolveServiceDeskProviderBinding !== 'function') {
        throw serviceError(503, 'The governed customer provider directory is unavailable', 'customer_provider_directory_unavailable');
    }

    async function bindingFor(access, customerId, admission = {}) {
        const binding = await contextProvider.resolveServiceDeskProviderBinding(access, customerId, admission);
        const expectedScope = String(env.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID || '').trim().toLowerCase();
        if (
            !binding || String(binding.tenantId || '') !== String(access.tenant && access.tenant.id || '') ||
            String(binding.customerId || '') !== String(customerId || '') ||
            !expectedScope || String(binding.providerScopeId || '').trim().toLowerCase() !== expectedScope ||
            !parseCanonicalProviderId(binding && binding.companyId)
        ) {
            throw serviceError(409, 'The selected customer has no exact production provider binding', 'service_desk_provider_binding_required');
        }
        assertServiceDeskProviderAdmission({ env, access, binding, runtimeStatus: runtime.status(), operation: 'read' });
        return binding;
    }

    async function writeBindingFor(access, customerId, admission = {}) {
        const binding = await bindingFor(access, customerId, admission);
        assertServiceDeskProviderAdmission({ env, access, binding, runtimeStatus: runtime.status(), operation: 'write' });
        return binding;
    }

    async function directory(access) {
        const value = await contextProvider.listServiceDeskCustomers(access);
        return value && typeof value === 'object' ? value : { revision: 0, customers: [], readiness: { eligible: false } };
    }

    return {
        async bootstrap(access) {
            assertCapability(access, 'service-desk:read');
            const customerDirectory = await directory(access);
            const tickets = await loadAllTickets(access, customerDirectory.customers);
            const status = runtime.status();
            return {
                revision: customerDirectory.revision,
                tenant: { id: access.tenant.id, name: access.tenant.name, slug: access.tenant.slug },
                user: {
                    email: access.user.email,
                    name: access.user.name,
                    role: access.user.role,
                    capabilities: access.user.capabilities.filter((item) => item.startsWith('service-desk:'))
                },
                runtime: {
                    mode: 'production',
                    provider: 'autotask',
                    sourceOfTruth: true,
                    externalChanges: status.writeOperationsEnabled === true,
                    durableOperationFence: status.durableOperationFence === true,
                    statusWritesEnabled: status.statusWritesEnabled === true,
                    providerAccountReady: status.providerAccountReady === true,
                    portalVisibilityReady: status.portalVisibilityReady === true,
                    priorityMappingVerified: status.priorityMappingVerified === true,
                    dattoRmmSourceMappingReady: status.dattoRmmSourceMappingReady === true
                },
                agents: [],
                customers: customerDirectory.customers,
                readiness: customerDirectory.readiness,
                scenario: { category: 'Live support', name: 'Autotask service desk' },
                demo: {},
                tickets: tickets.slice(0, 100)
            };
        },

        async listTickets(access) {
            assertCapability(access, 'service-desk:read');
            const customerDirectory = await directory(access);
            return {
                revision: customerDirectory.revision,
                tickets: await loadAllTickets(access, customerDirectory.customers)
            };
        },

        async getTicket(access, identifier, input = {}) {
            assertCapability(access, 'service-desk:read');
            const customerDirectory = await directory(access);
            const matches = [];
            for (const customer of selectedCustomers(customerDirectory.customers, input.customerId)) {
                const binding = await bindingFor(access, customer.id);
                try {
                    const providerTicketId = parseCanonicalProviderId(identifier);
                    const ticket = providerTicketId
                        ? await runtime.getTicketById(Object.assign({}, binding, { ticketId: providerTicketId }))
                        : await runtime.getTicketByNumber(Object.assign({}, binding, { ticketNumber: identifier }));
                    matches.push(publicTicket(ticket, customer));
                } catch (error) {
                    if (!(error && error.details && error.details.code === 'ticket_not_found')) throw error;
                }
            }
            if (matches.length !== 1) {
                throw serviceError(matches.length ? 409 : 404, matches.length ? 'The ticket mapping is ambiguous' : 'Ticket not found', matches.length ? 'ticket_mapping_ambiguous' : 'ticket_not_found');
            }
            return { revision: 0, ticket: matches[0] };
        },

        async getTicketByNumber(access, ticketNumber, input = {}) {
            return this.getTicket(access, ticketNumber, input);
        },

        async createTicket(access, input = {}) {
            assertCapability(access, 'service-desk:create');
            const customerId = requiredId(input.customerId, 'service_desk_customer_required');
            const admission = staffCustomerIntakeAdmission(access, input);
            const binding = await writeBindingFor(access, customerId, admission);
            const result = await runtime.createTicket(Object.assign({}, binding, {
                operationId: input.operationId,
                repeatConfirmationToken: input.repeatConfirmationToken,
                actor: serverActor(access),
                deviceId: input.deviceId,
                subject: input.subject || input.summary,
                requestText: input.requestText || input.problem,
                priority: input.priority,
                requesterEmail: admission.requesterEmail,
                intakeChannel: admission.intakeChannel
            }));
            return publicMutation(result, { id: customerId, name: customerNameFromInput(input) });
        },

        async replyToTicket(access, ticketNumber, input = {}) {
            assertCapability(access, 'service-desk:create');
            const customerId = requiredId(input.customerId, 'service_desk_customer_required');
            const binding = await writeBindingFor(access, customerId);
            const result = await runtime.replyToTicket(Object.assign({}, staffReplyBinding(binding), {
                operationId: input.operationId,
                repeatConfirmationToken: input.repeatConfirmationToken,
                actor: serverActor(access),
                ticketNumber,
                message: input.message
            }));
            return publicMutation(result, { id: customerId, name: customerNameFromInput(input) });
        },

        async updateTicketStatus(access, ticketNumber, input = {}) {
            assertCapability(access, 'service-desk:execute');
            const customerId = requiredId(input.customerId, 'service_desk_customer_required');
            const binding = await writeBindingFor(access, customerId);
            const result = await runtime.updateTicketStatus(Object.assign({}, binding, {
                operationId: input.operationId,
                repeatConfirmationToken: input.repeatConfirmationToken,
                actor: serverActor(access),
                ticketNumber,
                status: input.status,
                message: input.message,
                expectedProviderVersion: input.expectedProviderVersion
            }));
            return publicMutation(result, { id: customerId, name: customerNameFromInput(input) });
        },

        async investigateTicket() { throw unavailable(); },
        async approveRecommendation() { throw unavailable(); },
        async executeApprovedRemediation() { throw unavailable(); },

        async getAudit(access) {
            assertCapability(access, 'service-desk:audit:read');
            const customerDirectory = await directory(access);
            const events = [];
            for (const customer of customerDirectory.customers) {
                const binding = await bindingFor(access, customer.id);
                events.push(...await runtime.getOperationAudit(binding));
            }
            return { revision: 0, events: events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 500) };
        },

        async getOperationStatus(access, operationId, input = {}) {
            assertCapability(access, 'service-desk:read');
            const customerId = requiredId(input.customerId, 'service_desk_customer_required');
            const binding = await bindingFor(access, customerId);
            return runtime.getOperationStatus(Object.assign({}, binding, {
                operationId,
                actor: serverActor(access)
            }));
        },

        async resolveOperationStepAbsent(access, operationId, input = {}) {
            assertCapability(access, 'service-desk:execute');
            if (access.user.role !== 'service_owner') {
                throw serviceError(403, 'Only the service owner can resolve an ambiguous provider dispatch', 'provider_absence_resolution_forbidden');
            }
            const customerId = requiredId(input.customerId, 'service_desk_customer_required');
            const binding = await writeBindingFor(access, customerId);
            return runtime.resolveOperationStepAbsent(Object.assign({}, binding, {
                operationId,
                actor: serverActor(access),
                step: input.step,
                expectedAttempt: input.expectedAttempt,
                confirmation: input.confirmation,
                evidenceRef: input.evidenceRef
            }));
        }
    };

    async function loadAllTickets(access, customers) {
        const tickets = [];
        for (const customer of customers) {
            const binding = await bindingFor(access, customer.id);
            const result = await runtime.listTickets(binding);
            tickets.push(...result.tickets.map((ticket) => publicTicket(ticket, customer)));
        }
        return tickets.sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    }
}

function staffReplyBinding(binding = {}) {
    return {
        tenantId: binding.tenantId,
        customerId: binding.customerId,
        companyId: binding.companyId,
        providerScopeId: binding.providerScopeId,
        devices: Array.isArray(binding.devices) ? binding.devices : []
    };
}

function publicMutation(result, customer) {
    const output = {
        operationId: result.operationId,
        status: result.status,
        repeatedFromOperationId: result.repeatedFromOperationId || '',
        idempotentReplay: result.idempotentReplay === true,
        created: result.status === 'completed' && result.idempotentReplay !== true,
        repeated: result.idempotentReplay === true
    };
    if (result.repeatConfirmationToken) output.repeatConfirmationToken = result.repeatConfirmationToken;
    if (result.ticket) output.ticket = publicTicket(result.ticket, customer);
    return output;
}

function publicTicket(ticket, customer) {
    const source = ticket && typeof ticket === 'object' ? ticket : {};
    const notes = (Array.isArray(source.notes) ? source.notes : []).map((note) => ({
        id: String(note && note.id || ''),
        message: String(note && note.message || ''),
        createdAt: String(note && note.createdAt || ''),
        customerVisible: note && note.customerVisible === true,
        origin: ['customer_portal_submission', 'customer_reply'].includes(String(note && note.origin || '')) &&
            note && note.originVerified === true
            ? String(note.origin)
            : 'service_desk_update',
        originVerified: note && note.originVerified === true
    }));
    return {
        id: String(source.id || ''),
        ticketNumber: String(source.ticketNumber || ''),
        companyId: String(source.companyId || ''),
        device: String(source.device || ''),
        source: ['datto_rmm', 'no_fries'].includes(String(source.source || '')) ? String(source.source) : 'unavailable',
        status: String(source.status || 'unavailable'),
        priority: String(source.priority || 'unavailable'),
        subject: String(source.subject || ''),
        createdAt: String(source.createdAt || ''),
        updatedAt: String(source.updatedAt || ''),
        providerVersion: String(source.providerVersion || ''),
        portalVisible: source.portalVisible === true,
        notes,
        projectionIssues: Array.isArray(source.projectionIssues) ? source.projectionIssues.map((issue) => ({
            field: String(issue && issue.field || ''),
            code: String(issue && issue.code || '')
        })) : [],
        customer: { id: customer && customer.id || '', name: customer && customer.name || '' },
        summary: String(source.subject || ''),
        problem: '',
        simulated: false,
        stage: source.status === 'resolved' || source.status === 'closed' ? 'complete' : 'service'
    };
}

function selectedCustomers(customers, customerId) {
    const all = Array.isArray(customers) ? customers : [];
    if (!customerId) return all;
    const match = all.filter((customer) => customer.id === customerId);
    if (!match.length) throw serviceError(404, 'Service-desk customer not found', 'service_desk_customer_not_found');
    return match;
}

function serverActor(access) {
    return {
        subjectKey: access.user.subjectKey || access.user.immutableSubject || '',
        principalId: access.user.principalId || '',
        email: access.user.email || '',
        source: 'staff_service_desk',
        role: access.user.role
    };
}

function staffCustomerIntakeAdmission(access, input) {
    const requesterEmail = String(input.requesterEmail || '').trim().toLowerCase();
    if (!requesterEmail) throw serviceError(400, 'Record the authorised customer requester for an on-behalf-of ticket', 'support_requester_required');
    return {
        requesterEmail,
        intakeChannel: input.intakeChannel || 'portal',
        requesterVerificationMethod: 'Verified by authenticated No Fries operator',
        requesterVerificationRef: `identity:${access.user.subjectKey || access.user.principalId || access.user.email}`
    };
}

function customerNameFromInput(input) { return String(input.customerName || '').trim().slice(0, 180); }
function requiredId(value, code) {
    const id = String(value || '').trim().slice(0, 180);
    if (!id) throw serviceError(400, 'A customer is required', code);
    return id;
}
function unavailable() { return serviceError(409, 'Mock remediation actions are not available on the production Autotask desk', 'production_action_not_supported'); }
function serviceError(statusCode, message, code, details = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = Object.assign({ code }, details);
    return error;
}

module.exports = {
    createProductionServiceDeskService,
    publicTicket
};
