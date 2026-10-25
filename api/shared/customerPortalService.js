'use strict';

const { canonicalHash } = require('./appLifecycle/customerOperations');
const { PROOF_STATEMENT, proofOrganisationDigest } = require('./appLifecycle/monthlyProof');
const { assertServiceDeskProviderAdmission } = require('./serviceDesk/serviceDeskProviderAdmission');
const { parseCanonicalProviderId } = require('./serviceDesk/providerIds');

const OPEN_STATUSES = new Set(['new', 'open', 'in_progress', 'in progress', 'waiting_customer', 'waiting customer', 'queued']);
const CANONICAL_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TICKET_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPEAT_CONFIRMATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RESERVED_OPERATION_MARKER_PATTERN = /\[No Fries (?:operation|origin)\b/iu;

function createCustomerPortalService(options = {}) {
    if (!options.ticketProvider) throw new Error('A customer portal ticket provider is required.');
    if (!options.lifecycleService) throw new Error('A customer portal lifecycle service is required.');
    if (typeof options.buildProofView !== 'function' || typeof options.proofForPeriod !== 'function') {
        throw new Error('Customer-safe Proof projectors are required.');
    }
    const tickets = options.ticketProvider;
    const lifecycle = options.lifecycleService;
    const buildProofView = options.buildProofView;
    const proofForPeriod = options.proofForPeriod;
    const now = options.now || (() => new Date());
    const env = options.env || process.env;
    const providerAdmission = options.providerAdmission || assertServiceDeskProviderAdmission;

    async function readOrganisation(access) {
        await governedProviderBinding(access);
        const result = await lifecycle.getOrganisation(access, access.customer.id);
        const organisation = result && result.organisation;
        if (!organisation || String(organisation.organisationId || organisation.id || '') !== access.customer.id) {
            throw portalError(404, 'Customer portal record not found', 'customer_portal_not_found');
        }
        return organisation;
    }

    async function boundCustomer(access, operation = 'read') {
        return governedProviderBinding(access, operation);
    }

    async function governedProviderBinding(access, operation = 'read') {
        if (typeof lifecycle.resolveServiceDeskProviderBinding !== 'function') {
            throw portalError(503, 'The customer service-desk binding is unavailable', 'customer_portal_binding_unavailable');
        }
        const admission = {
            requesterEmail: access.user.email,
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Verified by authenticated customer portal identity',
            requesterVerificationRef: `identity:${access.user.subjectKey}`
        };
        if (operation === 'write') {
            admission.contactId = access.customer.contactId;
            admission.requireAutotaskContact = true;
        }
        const binding = await lifecycle.resolveServiceDeskProviderBinding(access, access.customer.id, admission);
        const boundContactId = parseCanonicalProviderId(binding && binding.contactId);
        if (!binding || String(binding.tenantId || '') !== String(access.tenant.id) ||
            String(binding.customerId || '') !== String(access.customer.id) ||
            String(binding.companyId || '') !== String(access.customer.companyId) ||
            String(binding.providerScopeId || '').toLowerCase() !== String(access.customer.providerScopeId || '').toLowerCase() ||
            (operation === 'write' && boundContactId !== parseCanonicalProviderId(access.customer.contactId)) ||
            !Array.isArray(binding.devices)) {
            throw portalError(
                503,
                'The customer service-desk binding is unavailable',
                'customer_portal_binding_unavailable'
            );
        }
        providerAdmission({
            env,
            access,
            binding,
            runtimeStatus: typeof tickets.status === 'function' ? tickets.status() : {},
            operation
        });
        return {
            tenantId: String(binding.tenantId),
            customerId: String(binding.customerId),
            companyId: String(binding.companyId),
            providerScopeId: String(binding.providerScopeId),
            contactId: operation === 'write' ? boundContactId : '',
            devices: binding.devices
        };
    }

    async function listTickets(access) {
        const binding = await boundCustomer(access);
        const values = await callProvider(tickets, ['listCustomerTickets', 'listTickets'], {
            access,
            tenantId: access.tenant.id,
            customerId: access.customer.id,
            companyId: binding.companyId,
            providerScopeId: binding.providerScopeId,
            portalVisibleOnly: true,
            devices: binding.devices
        });
        const projected = ticketCollection(values)
            .filter((ticket) => companyMatches(ticket, binding.companyId) && isPortalVisibleTicket(ticket))
            .map(projectTicketSummary)
            .filter(Boolean)
            .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        return {
            tickets: projected,
            openCount: projected.filter((ticket) => isOpenStatus(ticket.status)).length
        };
    }

    async function getTicket(access, ticketNumber) {
        const exactTicketNumber = requireTicketNumber(ticketNumber);
        const binding = await boundCustomer(access);
        return getBoundTicket(access, exactTicketNumber, binding.companyId, binding.providerScopeId, binding.devices);
    }

    async function getOperationStatus(access, operationId) {
        const exactOperationId = requireOperationId(operationId);
        const binding = await boundCustomer(access);
        let value;
        try {
            value = await callProvider(tickets, ['getOperationStatus'], {
                access,
                tenantId: access.tenant.id,
                customerId: access.customer.id,
                companyId: binding.companyId,
                providerScopeId: binding.providerScopeId,
                portalVisibleOnly: true,
                actor: actorFromAccess(access),
                operationId: exactOperationId
            });
        } catch (error) {
            if (Number(error && error.statusCode) === 404) {
                throw portalError(404, 'Operation not found', 'provider_operation_not_found');
            }
            throw error;
        }
        if (!value || typeof value !== 'object' || value.operationId !== exactOperationId ||
            !['pending', 'completed'].includes(value.status)) {
            throw portalError(502, 'The service desk returned an invalid operation status', 'operation_status_response_invalid');
        }
        const completed = value.status === 'completed';
        return {
            operationId: exactOperationId,
            status: value.status,
            terminal: completed,
            retrySameOperation: !completed,
            idempotentReplay: completed && value.idempotentReplay === true,
            repeatedFromOperationId: cleanText(value.repeatedFromOperationId, 180)
        };
    }

    async function getBoundTicket(access, exactTicketNumber, companyId, providerScopeId, devices) {
        let value;
        try {
            value = await callProvider(tickets, ['getCustomerTicketByNumber', 'getTicketByNumber', 'getTicket'], {
                access,
                tenantId: access.tenant.id,
                customerId: access.customer.id,
                companyId,
                providerScopeId,
                portalVisibleOnly: true,
                devices,
                ticketNumber: exactTicketNumber
            });
        } catch (error) {
            if (Number(error && error.statusCode) === 404) {
                throw portalError(404, 'Ticket not found', 'ticket_not_found');
            }
            throw error;
        }
        const ticket = providerTicket(value);
        if (!ticket || !companyMatches(ticket, companyId) || !isPortalVisibleTicket(ticket) ||
            String(ticketNumberOf(ticket)) !== exactTicketNumber) {
            throw portalError(404, 'Ticket not found', 'ticket_not_found');
        }
        return { ticket: projectTicketDetail(ticket) };
    }

    async function createTicket(access, input = {}) {
        const body = object(input);
        rejectLegacyRepeatToken(body);
        const summary = requiredText(body.summary || body.title, 160, 'Ticket summary is required', 'ticket_summary_required');
        const description = requiredText(body.description || body.problem, 4000, 'Describe what you need help with', 'ticket_description_required');
        rejectReservedOperationMarker(summary);
        rejectReservedOperationMarker(description);
        const operationId = requireOperationId(body.operationId);
        const repeatConfirmationToken = optionalRepeatConfirmationToken(body.repeatConfirmationToken);
        const priority = requireCanonicalPriority(body.priority);
        const binding = await boundCustomer(access, 'write');
        const result = await callProvider(tickets, ['createCustomerTicket', 'createTicket'], {
            access,
            tenantId: access.tenant.id,
            customerId: access.customer.id,
            companyId: binding.companyId,
            providerScopeId: binding.providerScopeId,
            portalVisibleOnly: true,
            devices: binding.devices,
            contactId: binding.contactId,
            actor: actorFromAccess(access),
            operationId,
            summary,
            subject: summary,
            description,
            requestText: description,
            priority,
            deviceId: cleanText(body.deviceId, 180),
            repeatConfirmationToken: repeatConfirmationToken || undefined
        });
        if (result && result.status && result.status !== 'completed') {
            return projectOperationResult(result, operationId);
        }
        const ticket = providerTicket(result);
        if (!ticket || !companyMatches(ticket, binding.companyId) || !isPortalVisibleTicket(ticket)) {
            throw portalError(502, 'The service desk returned an invalid ticket', 'ticket_provider_response_invalid');
        }
        return {
            operationId: cleanText(result && result.operationId || operationId, 180),
            status: 'completed',
            created: result && result.created !== false && result.idempotentReplay !== true,
            repeated: Boolean(result && (result.idempotentReplay === true || result.created === false || result.repeated === true)),
            ticket: projectTicketDetail(ticket)
        };
    }

    async function replyToTicket(access, ticketNumber, input = {}) {
        const exactTicketNumber = requireTicketNumber(ticketNumber);
        const body = object(input);
        rejectLegacyRepeatToken(body);
        const message = requiredText(body.message || body.body, 4000, 'Reply text is required', 'ticket_reply_required');
        rejectReservedOperationMarker(message);
        const operationId = requireOperationId(body.operationId);
        const repeatConfirmationToken = optionalRepeatConfirmationToken(body.repeatConfirmationToken);
        const binding = await boundCustomer(access, 'write');

        // Resolve the exact customer-scoped ticket first. This masks both an unknown
        // number and a number belonging to another company behind the same 404.
        await getBoundTicket(access, exactTicketNumber, binding.companyId, binding.providerScopeId, binding.devices);
        const result = await callProvider(tickets, ['replyToCustomerTicket', 'replyToTicket', 'addTicketReply'], {
            access,
            tenantId: access.tenant.id,
            customerId: access.customer.id,
            companyId: binding.companyId,
            providerScopeId: binding.providerScopeId,
            portalVisibleOnly: true,
            devices: binding.devices,
            contactId: binding.contactId,
            actor: actorFromAccess(access),
            operationId,
            ticketNumber: exactTicketNumber,
            message,
            repeatConfirmationToken: repeatConfirmationToken || undefined,
            customerVisible: true
        });
        if (result && result.status && result.status !== 'completed') {
            return projectOperationResult(result, operationId);
        }
        const ticket = providerTicket(result);
        if (!ticket || !companyMatches(ticket, binding.companyId) || !isPortalVisibleTicket(ticket) ||
            String(ticketNumberOf(ticket)) !== exactTicketNumber) {
            throw portalError(502, 'The service desk returned an invalid ticket', 'ticket_provider_response_invalid');
        }
        return {
            operationId: cleanText(result && result.operationId || operationId, 180),
            status: 'completed',
            created: result && result.created !== false && result.idempotentReplay !== true,
            repeated: Boolean(result && (result.idempotentReplay === true || result.created === false || result.repeated === true)),
            ticket: projectTicketDetail(ticket)
        };
    }

    async function proofView(access) {
        const organisation = await readOrganisation(access);
        const view = buildProofView(organisation, now().toISOString());
        assertProofViewBound(organisation, access.customer.id, view);
        return Object.assign({
            status: 'available',
            proofCustomerId: proofCustomerId(organisation, access.customer.id)
        }, view);
    }

    async function getProofPeriod(access, period) {
        if (!PERIOD_PATTERN.test(String(period || ''))) {
            throw portalError(404, 'Proof report not found', 'proof_report_not_found');
        }
        const organisation = await readOrganisation(access);
        const report = proofForPeriod(organisation, String(period));
        if (!report) throw portalError(404, 'Proof report not found', 'proof_report_not_found');
        assertProofReportBound(organisation, access.customer.id, report, String(period));
        return { report };
    }

    return {
        async bootstrap(access, bootstrapOptions = {}) {
            const proofAvailable = bootstrapOptions.proofAvailable !== false;
            const proofPromise = proofAvailable
                ? proofView(access).catch(function () { return unavailableProof(access); })
                : Promise.resolve(unavailableProof(access));
            const [ticketResult, proof] = await Promise.all([
                listTickets(access),
                proofPromise
            ]);
            return {
                customer: {
                    id: access.customer.id,
                    proofCustomerId: proof.proofCustomerId,
                    displayName: access.customer.displayName,
                    timezone: access.customer.timezone
                },
                user: {
                    name: access.user.name,
                    email: access.user.email,
                    role: access.user.role
                },
                tickets: ticketResult.tickets,
                openTicketCount: ticketResult.openCount,
                proof,
                links: {
                    tickets: '/api/customer-portal/tickets',
                    proofCurrent: '/api/customer-portal/proof/current',
                    proofHistory: '/api/customer-portal/proof/history'
                }
            };
        },
        listTickets,
        getTicket,
        getOperationStatus,
        createTicket,
        replyToTicket,
        async getCurrentProof(access) {
            const proof = await proofView(access);
            return { proofCustomerId: proof.proofCustomerId, timezone: proof.timezone, current: proof.current };
        },
        async getProofHistory(access) {
            const proof = await proofView(access);
            return { proofCustomerId: proof.proofCustomerId, timezone: proof.timezone, history: (proof.history || []).slice(0, 13) };
        },
        getProofPeriod
    };
}

function assertProofViewBound(organisation, membershipCustomerId, view) {
    if (!view || typeof view !== 'object' || !view.current || !Array.isArray(view.history)) {
        throw portalError(503, 'The published Proof record is unavailable', 'proof_report_binding_invalid');
    }
    if (view.current.state === 'issued') {
        assertProofReportBound(organisation, membershipCustomerId, view.current.report, view.current.period);
    } else if (view.current.report) {
        throw portalError(503, 'The published Proof record is unavailable', 'proof_report_binding_invalid');
    }
    const identities = new Set();
    view.history.forEach((report) => {
        assertProofReportBound(organisation, membershipCustomerId, report, report && report.period);
        const identity = `${report.proofId}:${report.customerId}:${report.period}`;
        if (identities.has(identity)) {
            throw portalError(503, 'The published Proof record is unavailable', 'proof_report_binding_invalid');
        }
        identities.add(identity);
    });
}

function assertProofReportBound(organisation, membershipCustomerId, report, period) {
    const expectedCustomerId = String(
        organisation && organisation.customerMaster && organisation.customerMaster.customerId ||
        membershipCustomerId || ''
    );
    const expectedPeriod = String(period || '');
    const expectedOrganisationDigest = proofOrganisationDigest(organisation);
    const source = (Array.isArray(organisation && organisation.proofPeriods) ? organisation.proofPeriods : [])
        .find((candidate) => candidate && candidate.period === expectedPeriod && candidate.status === 'issued');
    if (!report || typeof report !== 'object' || !source ||
        String(source.customerId || expectedCustomerId) !== expectedCustomerId ||
        !report.proofId || String(report.proofId) !== String(source.id) ||
        !report.customerId || String(report.customerId) !== expectedCustomerId ||
        String(report.period || '') !== expectedPeriod ||
        String(report.organisationDigest || '') !== expectedOrganisationDigest ||
        !proofStatementMatches(report.statement) ||
        proofContainsForbiddenIdentity(report) ||
        !/^[a-f0-9]{64}$/.test(String(report.snapshotSha256 || '')) ||
        !report.frozenSnapshot || typeof report.frozenSnapshot !== 'object' || Array.isArray(report.frozenSnapshot) ||
        String(report.frozenSnapshot.proofId || '') !== String(source.id) ||
        String(report.frozenSnapshot.customerId || '') !== expectedCustomerId ||
        String(report.frozenSnapshot.period || '') !== expectedPeriod ||
        String(report.frozenSnapshot.organisationDigest || '') !== expectedOrganisationDigest ||
        !proofStatementMatches(report.frozenSnapshot.statement) ||
        canonicalHash(report.frozenSnapshot) !== report.snapshotSha256 ||
        !source.customerSnapshot || String(source.customerSnapshot.organisationDigest || '') !== expectedOrganisationDigest ||
        String(source.snapshotSha256 || '') !== String(report.snapshotSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(String(report.publicationSha256 || '')) ||
        String(source.publicationSha256 || '') !== String(report.publicationSha256 || '') ||
        !report.publicationEnvelope || typeof report.publicationEnvelope !== 'object' || Array.isArray(report.publicationEnvelope) ||
        canonicalHash(report.publicationEnvelope) !== report.publicationSha256 ||
        String(report.publicationEnvelope.approvedSnapshotSha256 || '') !== String(report.snapshotSha256 || '') ||
        String(report.publicationEnvelope.proofId || '') !== String(source.id) ||
        String(report.publicationEnvelope.customerId || '') !== expectedCustomerId ||
        String(report.publicationEnvelope.period || '') !== expectedPeriod ||
        String(report.publicationEnvelope.organisationDigest || '') !== expectedOrganisationDigest ||
        !proofStatementMatches(report.publicationEnvelope.statement) ||
        String(report.publicationEnvelope.issuedAt || '') !== String(report.issuedAt || '') ||
        String(source.issuedAt || '') !== String(report.issuedAt || '') ||
        canonicalHash(report.publicationEnvelope.issuer || {}) !== canonicalHash(report.issuer || {})) {
        throw portalError(503, 'The published Proof record is unavailable', 'proof_report_binding_invalid');
    }
}

function proofStatementMatches(value) {
    return Boolean(
        value && typeof value === 'object' && !Array.isArray(value) &&
        value.type === PROOF_STATEMENT.type && value.label === PROOF_STATEMENT.label
    );
}

function proofContainsForbiddenIdentity(value, depth = 0) {
    if (depth > 12 || value == null || typeof value !== 'object') return false;
    const forbidden = new Set([
        'actorDigest', 'subjectKey', 'principalId', 'identityTenantId', 'email',
        'providerScopeId', 'companyId', 'providerId', 'recordedBy'
    ]);
    if (Array.isArray(value)) return value.some((item) => proofContainsForbiddenIdentity(item, depth + 1));
    return Object.entries(value).some(([key, item]) => (
        forbidden.has(key) || proofContainsForbiddenIdentity(item, depth + 1)
    ));
}

function projectOperationResult(value, operationId) {
    return {
        operationId: cleanText(value.operationId || operationId, 180),
        status: ['pending', 'confirmation_required'].includes(value.status) ? value.status : 'pending',
        created: false,
        repeated: Boolean(value.repeatedFromOperationId),
        repeatedFromOperationId: cleanText(value.repeatedFromOperationId, 180),
        repeatConfirmationToken: cleanText(value.repeatConfirmationToken, 180),
        ticket: value.ticket ? projectTicketDetail(value.ticket) : null
    };
}

function projectTicketSummary(value) {
    if (!isPortalVisibleTicket(value)) return null;
    const ticketNumber = String(ticketNumberOf(value) || '');
    if (!TICKET_NUMBER_PATTERN.test(ticketNumber)) return null;
    return {
        ticketNumber,
        summary: cleanText(value.summary || value.subject || value.title, 180) || 'Support request',
        status: cleanText(value.status || value.statusLabel, 80) || 'unavailable',
        priority: canonicalPriority(value.priority || value.priorityLabel),
        device: cleanText(
            value.deviceLabel || value.deviceName ||
            (typeof value.device === 'string' ? value.device : value.device && value.device.label),
            180
        ),
        createdAt: safeIso(value.createdAt || value.createDate),
        updatedAt: safeIso(value.updatedAt || value.lastActivityDate || value.createDate)
    };
}

function projectTicketDetail(value) {
    const summary = projectTicketSummary(value);
    if (!summary) return null;
    const rawNotes = Array.isArray(value.notes)
        ? value.notes
        : Array.isArray(value.timeline) ? value.timeline : [];
    return Object.assign({}, summary, {
        notes: rawNotes
            .filter(isPositivelyCustomerVisible)
            .map(projectCustomerNote)
            .filter(Boolean)
            .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    });
}

function projectCustomerNote(value) {
    const body = cleanText(value.message, 8000);
    if (!body) return null;
    const origin = value.originVerified === true
        ? customerNoteOrigin(value.origin)
        : 'service_desk_update';
    const projectedAuthor = cleanText(value.projectedAuthor || value.authorName || value.createdByName, 180);
    return {
        id: cleanText(value.id || value.noteId, 180),
        body,
        createdAt: safeIso(value.createdAt || value.createDateTime || value.date),
        origin,
        author: projectedAuthor || (origin === 'customer_reply'
            ? 'Customer reply'
            : origin === 'customer_request' ? 'Customer request' : 'Service desk update')
    };
}

function isPositivelyCustomerVisible(note) {
    return Boolean(
        note && typeof note === 'object' && note.customerVisible === true &&
        note.internal !== true && note.isInternal !== true
    );
}

function companyMatches(ticket, companyId) {
    const projected = parseCanonicalProviderId(ticket && (
        ticket.companyId || ticket.accountId || ticket.company && ticket.company.id
    ));
    return Boolean(projected && projected === parseCanonicalProviderId(companyId));
}

function isPortalVisibleTicket(ticket) {
    return Boolean(ticket && ticket.portalVisible === true);
}

function ticketNumberOf(ticket) {
    return ticket && (ticket.ticketNumber || ticket.number || ticket.referenceNumber);
}

function ticketCollection(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.tickets)) return value.tickets;
    if (value && Array.isArray(value.items)) return value.items;
    return [];
}

function providerTicket(value) {
    if (!value || typeof value !== 'object') return null;
    return value.ticket && typeof value.ticket === 'object' ? value.ticket : value;
}

async function callProvider(provider, names, input) {
    const name = names.find((candidate) => typeof provider[candidate] === 'function');
    if (!name) throw portalError(503, 'The production service desk is unavailable', 'ticket_provider_unavailable');
    return provider[name](input);
}

function actorFromAccess(access) {
    return {
        actorId: access.user.subjectKey,
        subjectKey: access.user.subjectKey,
        name: access.user.name,
        email: access.user.email,
        role: access.user.role,
        source: 'customer_portal'
    };
}

function requireTicketNumber(value) {
    const result = String(value || '');
    if (!TICKET_NUMBER_PATTERN.test(result)) {
        throw portalError(404, 'Ticket not found', 'ticket_not_found');
    }
    return result;
}

function requireOperationId(value) {
    const result = String(value || '').trim();
    if (!OPERATION_ID_PATTERN.test(result)) {
        throw portalError(400, 'A stable operation ID is required', 'operation_id_required');
    }
    return result;
}

function optionalRepeatConfirmationToken(value) {
    const result = String(value || '').trim();
    if (!result) return '';
    if (!REPEAT_CONFIRMATION_PATTERN.test(result)) {
        throw portalError(400, 'The repeat confirmation is invalid', 'repeat_confirmation_invalid');
    }
    return result;
}

function rejectLegacyRepeatToken(value) {
    if (Object.prototype.hasOwnProperty.call(value, 'repeatToken')) {
        throw portalError(400, 'Use only repeatConfirmationToken for an intentional repeat', 'repeat_confirmation_field_invalid');
    }
}

function rejectReservedOperationMarker(value) {
    if (RESERVED_OPERATION_MARKER_PATTERN.test(String(value || ''))) {
        throw portalError(400, 'Support request text contains a reserved service-desk marker', 'reserved_operation_marker');
    }
}

function requireCanonicalPriority(value) {
    const priority = String(value || '').trim().toLowerCase();
    if (!CANONICAL_PRIORITIES.has(priority)) {
        throw portalError(400, 'Choose a valid support impact', 'ticket_priority_required');
    }
    return priority;
}

function canonicalPriority(value) {
    const priority = String(value || '').trim().toLowerCase();
    return CANONICAL_PRIORITIES.has(priority) ? priority : 'unavailable';
}

function customerNoteOrigin(value) {
    const origin = String(value || '').trim().toLowerCase();
    if (origin === 'customer_portal_submission') return 'customer_request';
    if (['customer_reply', 'customer_portal_reply'].includes(origin)) return 'customer_reply';
    return 'service_desk_update';
}

function proofCustomerId(organisation, fallback) {
    return cleanText(
        organisation && organisation.customerMaster && organisation.customerMaster.customerId || fallback,
        180
    );
}

function unavailableProof(access) {
    return {
        status: 'unavailable',
        proofCustomerId: '',
        timezone: access.customer.timezone,
        current: { period: '', state: 'unavailable', report: null },
        history: []
    };
}

function requiredText(value, maximum, message, code) {
    const result = cleanText(value, maximum);
    if (!result) throw portalError(400, message, code);
    return result;
}

function isOpenStatus(value) {
    return OPEN_STATUSES.has(String(value || '').trim().toLowerCase());
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).trim().slice(0, maximum);
}

function safeIso(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function portalError(statusCode, message, code, details = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = Object.assign({ code }, details);
    return error;
}

module.exports = {
    createCustomerPortalService,
    isPositivelyCustomerVisible,
    projectCustomerNote,
    projectTicketDetail,
    projectTicketSummary
};
