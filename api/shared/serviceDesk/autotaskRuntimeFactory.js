const crypto = require('crypto');
const { createAutotaskClient } = require('./autotaskClient');
const { createAutotaskAdapter } = require('./autotaskAdapter');
const { createProviderOperationFence } = require('./providerOperationFence');
const { parseCanonicalProviderId } = require('./providerIds');
const MAX_NOTE_PROVENANCE_CHECKS = 50;
const NOTE_PROVENANCE_CONCURRENCY = 5;

class AutotaskRuntimeError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createAutotaskRuntime(options = {}) {
    const env = options.env || process.env;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const client = options.client || createAutotaskClient({
        env,
        fetch: options.fetch,
        now: options.now,
        timeoutMs: options.timeoutMs
    });
    const adapter = options.adapter || createAutotaskAdapter({ client, env });
    const operationFence = options.operationFence || createProviderOperationFence({
        env,
        now: options.now,
        blobServiceClient: options.blobServiceClient,
        containerClient: options.containerClient,
        credential: options.credential
    });

    function status() {
        const provider = client.status();
        const mappings = adapter.status();
        const fence = operationFence.status();
        const writeScope = writeScopeStatus(env);
        const providerScopeReady = Boolean(cleanIdentifier(env.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID, 180));
        const providerAccountReady = Boolean(providerAccountId(env));
        return {
            provider: 'autotask',
            sourceOfTruth: true,
            mode: provider.mode,
            configured: provider.configured === true && mappings.configured === true && fence.configured === true &&
                providerScopeReady && providerAccountReady,
            connected: false,
            writeOperationsEnabled: provider.writeOperationsEnabled === true && mappings.configured === true &&
                fence.durable === true && fence.crossInstanceExclusive === true && fence.immutableOperationBinding === true &&
                fence.terminalReceiptArchive === true && fence.boundedDuplicateIntentIndex === true && writeScope.ready === true,
            exactMappings: mappings.exactMappings === true,
            customerVisibleNotes: mappings.customerVisibleNotes === true,
            operationMarkerConfigured: mappings.operationMarkerConfigured === true,
            portalVisibilityReady: mappings.portalVisibilityReady === true,
            priorityMappingVerified: mappings.priorityMapDigestVerified === true,
            dattoRmmSourceMappingReady: mappings.dattoRmmSourceMappingReady === true,
            durableOperationFence: fence.durable === true,
            crossInstanceExclusive: fence.crossInstanceExclusive === true,
            leaseRenewal: fence.leaseRenewal === true,
            immutableOperationBinding: fence.immutableOperationBinding === true,
            terminalReceiptArchive: fence.terminalReceiptArchive === true,
            boundedDuplicateIntentIndex: fence.boundedDuplicateIntentIndex === true,
            statusWritesEnabled: mappings.statusWritesEnabled === true,
            providerScopeReady,
            providerAccountReady,
            writeScope: writeScope.scope,
            writeScopeReady: writeScope.ready,
            state: provider.configured !== true ? provider.state
                : mappings.configured !== true ? mappings.state
                    : !providerScopeReady ? 'provider_scope_required'
                        : !providerAccountReady ? 'provider_account_required'
                        : fence.configured !== true || fence.durable !== true ? 'durable_fence_required' : 'ready'
        };
    }

    async function health() {
        const current = status();
        if (!current.configured) throw runtimeError(503, 'The production service desk is not configured', 'service_desk_provider_not_ready');
        const providerHealth = await client.health();
        return Object.assign({}, current, {
            connected: providerHealth.connected === true,
            checkedAt: providerHealth.checkedAt
        });
    }

    async function listTickets(input = {}) {
        const scope = requireScope(input, env);
        const result = await adapter.listTickets(Object.assign({}, scope, {
            devices: normaliseDevices(input.devices),
            maxPages: input.maxPages,
            maxRecords: input.maxRecords
        }));
        return Object.assign({ provider: 'autotask' }, result, {
            tickets: await Promise.all((result.tickets || []).map((ticket) => verifyTicketNoteOrigins(ticket, scope)))
        });
    }

    async function getTicketByNumber(input = {}) {
        const scope = requireScope(input, env);
        return verifyTicketNoteOrigins(await adapter.getTicketByNumber(Object.assign({}, scope, {
            ticketNumber: input.ticketNumber,
            devices: normaliseDevices(input.devices)
        })), scope);
    }

    async function getTicketById(input = {}) {
        const scope = requireScope(input, env);
        return verifyTicketNoteOrigins(await adapter.getTicketById(Object.assign({}, scope, {
            ticketId: input.ticketId,
            devices: normaliseDevices(input.devices)
        })), scope);
    }

    async function getOperationAudit(input = {}) {
        const scope = requireScope(input, env);
        return operationFence.audit(scope);
    }

    async function getOperationStatus(input = {}) {
        const scope = requireScope(input, env);
        const operationId = requireOperationId(input.operationId);
        const actor = requireActor(input.actor);
        if (actor.source === 'customer_portal' && !actor.emailSha256) {
            throw runtimeError(403, 'A verified customer requester identity is required', 'support_requester_required');
        }
        const record = await operationFence.read(Object.assign({}, scope, {
            operationId,
            requireActorMatch: actor.source === 'customer_portal',
            actorSubjectSha256: actor.subjectSha256,
            requesterEmailSha256: actor.emailSha256
        }));
        if (!record) throw runtimeError(404, 'Provider operation not found', 'provider_operation_not_found');
        return operationStatusProjection(record, actor.source === 'staff_service_desk');
    }

    async function resolveOperationStepAbsent(input = {}) {
        const scope = requireScope(input, env);
        const operationId = requireOperationId(input.operationId);
        const actor = requireActor(input.actor);
        if (actor.source !== 'staff_service_desk' || actor.role !== 'service_owner') {
            throw runtimeError(403, 'Only the governed service owner can resolve an ambiguous provider dispatch', 'provider_absence_resolution_forbidden');
        }
        const operatorEvidenceRef = requireOperatorEvidenceReference(input.evidenceRef);
        if (input.confirmation !== 'CONFIRM PROVIDER EFFECT ABSENT') {
            throw runtimeError(400, 'The exact provider-absence confirmation is required', 'provider_absence_resolution_invalid');
        }
        if (typeof operationFence.getResolutionContext !== 'function') {
            throw runtimeError(503, 'The durable provider resolution context is unavailable', 'provider_absence_resolution_unavailable');
        }
        const context = await operationFence.getResolutionContext(Object.assign({}, scope, { operationId }));
        const stepName = cleanIdentifier(input.step, 80);
        const expectedAttempt = Number(input.expectedAttempt);
        const step = context.steps && context.steps[stepName];
        if (!step || !Number.isSafeInteger(expectedAttempt) || step.attempt !== expectedAttempt ||
            !['dispatching', 'uncertain'].includes(step.status)) {
            throw runtimeError(409, 'The provider step no longer matches the unresolved attempt', 'provider_absence_resolution_conflict');
        }
        let providerTargetKey = '';
        let queryKind = '';
        if (stepName === 'ticket_create') {
            providerTargetKey = providerAbsenceTargetKey(stepName, operationId);
            queryKind = 'ticket_operation_exact';
            const found = await adapter.findTicketByOperationId(Object.assign({}, scope, {
                operationId,
                portalVisibleOnly: false,
                devices: normaliseDevices(input.devices)
            }));
            if (found) {
                throw runtimeError(409, 'Autotask contains the provider effect; it cannot be marked absent', 'provider_effect_present');
            }
        } else if (['original_request_note', 'reply_note', 'status_note'].includes(stepName)) {
            if (typeof adapter.hasCustomerVisibleNoteOperationMarker !== 'function') {
                throw runtimeError(503, 'The Autotask note reconciliation check is unavailable', 'provider_absence_resolution_unavailable');
            }
            const resourceMatch = String(context.resourceKey || '').match(/^ticket:([1-9][0-9]*)$/);
            const createCheckpoint = context.steps.ticket_create && context.steps.ticket_create.checkpoint;
            const ticketId = parseCanonicalProviderId(
                resourceMatch && resourceMatch[1] || createCheckpoint && createCheckpoint.ticketId
            );
            if (!ticketId) {
                throw runtimeError(409, 'The exact provider target is unavailable', 'provider_absence_resolution_target_invalid');
            }
            providerTargetKey = providerAbsenceTargetKey(stepName, operationId, ticketId);
            queryKind = 'ticket_note_operation_exact';
            const found = await adapter.hasCustomerVisibleNoteOperationMarker(Object.assign({}, scope, {
                ticketId,
                operationId,
                portalVisibleOnly: false
            }));
            if (found) {
                throw runtimeError(409, 'Autotask contains the provider effect; it cannot be marked absent', 'provider_effect_present');
            }
        } else {
            throw runtimeError(409, 'This provider step cannot be safely marked absent', 'provider_absence_resolution_unsupported');
        }
        if (typeof operationFence.recordAbsenceObservation !== 'function') {
            throw runtimeError(503, 'The durable provider settlement observation is unavailable', 'provider_absence_resolution_unavailable');
        }
        const checkedAt = now().toISOString();
        const providerEvidenceRef = providerAbsenceEvidenceRef({
            scope,
            operationId,
            step: stepName,
            expectedAttempt,
            providerTargetKey,
            queryKind,
            checkedAt
        });
        const observation = await operationFence.recordAbsenceObservation(Object.assign({}, scope, {
            operationId,
            step: stepName,
            expectedAttempt,
            providerTargetKey,
            providerCheckedAt: checkedAt,
            providerEvidenceRef,
            operatorEvidenceRef,
            resolveWhenReady: true,
            confirmation: input.confirmation,
            resolverSubjectSha256: actor.subjectSha256
        }));
        if (!observation.resolved) {
            const current = await operationFence.read(Object.assign({}, scope, { operationId }));
            return Object.assign(operationStatusProjection(current, true), {
                absenceSettlementPending: true,
                nextObservationAt: observation.nextObservationAt
            });
        }
        return operationStatusProjection(observation.record, true);
    }

    async function createTicket(input = {}) {
        const scope = requireScope(input, env);
        const operationId = requireOperationId(input.operationId);
        const actor = requireActor(input.actor);
        assertWriteReady(actor);
        const devices = normaliseDevices(input.devices);
        const requesterEmailSha256 = hashEmail(input.requesterEmail || input.actor && input.actor.email);
        const intakeChannel = cleanIdentifier(input.intakeChannel || input.actor && input.actor.source, 40);
        const noteOrigin = actor.source === 'customer_portal' ? 'customer_portal_submission' : 'service_desk_update';
        const contactId = input.contactId == null || String(input.contactId).trim() === ''
            ? ''
            : parseCanonicalProviderId(input.contactId);
        if (actor.source === 'customer_portal' && !contactId) {
            throw runtimeError(409, 'The customer portal requester has no exact governed Autotask contact mapping', 'autotask_contact_mapping_required');
        }
        if (input.contactId != null && String(input.contactId).trim() !== '' && !contactId) {
            throw runtimeError(409, 'The Autotask contact mapping is invalid', 'autotask_contact_mapping_required');
        }
        const request = {
            companyId: scope.companyId,
            customerId: scope.customerId,
            deviceId: cleanText(input.deviceId, 180),
            subject: requiredText(input.subject, 160, 'ticket_subject_required'),
            requestText: requiredText(input.requestText, 8000, 'ticket_request_required'),
            priority: requiredIdentifier(input.priority, 60, 'ticket_priority_required'),
            contactId,
            requesterEmailSha256,
            intakeChannel,
            noteOrigin,
            actorSubjectSha256: actor.subjectSha256
        };
        request.providerControlsSha256 = providerControlsSha256(adapter);
        request.noteMessageSha256 = canonicalNoteMessageSha256(`Original customer request\n\n${request.requestText}`);
        const resolvedCreateInput = Object.assign({}, scope, request, { operationId, devices });
        if (typeof adapter.validateCreateInput === 'function') {
            adapter.validateCreateInput(resolvedCreateInput);
        }
        request.providerIntentSha256 = providerIntentSha256(adapter, 'create', resolvedCreateInput);
        const reservation = await operationFence.reserve(Object.assign({}, scope, {
            operationId,
            operationType: 'autotask.ticket.create',
            resourceKey: 'new-ticket',
            request,
            actorSubjectSha256: actor.subjectSha256,
            requesterEmailSha256,
            intakeChannel,
            noteMessageSha256: request.noteMessageSha256,
            noteOrigin: request.noteOrigin,
            repeatToken: repeatConfirmation(input)
        }));
        const immediate = await resolveImmediateReservation(reservation, operationId, scope, devices, adapter, verifyTicketNoteOrigins);
        if (immediate) return immediate;
        try {
            return await continueCreate({ scope, operationId, request, devices, reservation });
        } catch (error) {
            throw publicMutationError(error, operationId);
        }
    }

    async function continueCreate(context) {
        const { scope, operationId, request, devices } = context;
        let ticketCheckpoint = checkpoint(context.reservation, 'ticket_create');
        if (!ticketCheckpoint) {
            const ticketStep = stepStatus(context.reservation, 'ticket_create');
            if (['dispatching', 'uncertain'].includes(ticketStep)) {
                const reconciled = await adapter.findTicketByOperationId(Object.assign({}, scope, request, {
                    operationId,
                    devices,
                    expectedProviderControlsSha256: request.providerControlsSha256,
                    expectedProviderIntentSha256: request.providerIntentSha256
                }));
                if (!reconciled) return pending(operationId, context.reservation.repeatedFromOperationId);
                ticketCheckpoint = minimalTicketCheckpoint(reconciled);
                await operationFence.applyStep(Object.assign({}, scope, {
                    operationId,
                    step: 'ticket_create',
                    checkpoint: ticketCheckpoint,
                    reconciled: true
                }));
            } else {
                ticketCheckpoint = await dispatchStep(scope, operationId, 'ticket_create', async () => {
                    const ticket = await adapter.createTicket(Object.assign({}, scope, request, {
                        operationId,
                        devices,
                        expectedProviderControlsSha256: request.providerControlsSha256,
                        expectedProviderIntentSha256: request.providerIntentSha256
                    }));
                    return minimalTicketCheckpoint(ticket);
                });
            }
        }

        let noteCheckpoint = checkpoint(context.reservation, 'original_request_note');
        if (!noteCheckpoint) {
            const latest = await operationFence.read(Object.assign({}, scope, { operationId }));
            const noteStep = stepStatus(latest, 'original_request_note');
            const expectedMessage = `Original customer request\n\n${request.requestText}`;
            if (['dispatching', 'uncertain'].includes(noteStep)) {
                const note = await adapter.findCustomerVisibleNoteByOperationId(Object.assign({}, scope, {
                    ticketId: ticketCheckpoint.ticketId,
                    operationId,
                    origin: request.noteOrigin,
                    expectedMessage
                }));
                if (!note) return pending(operationId, latest && latest.repeatedFromOperationId);
                noteCheckpoint = { noteId: note.id };
                await operationFence.applyStep(Object.assign({}, scope, {
                    operationId,
                    step: 'original_request_note',
                    checkpoint: noteCheckpoint,
                    reconciled: true
                }));
            } else {
                noteCheckpoint = await dispatchStep(scope, operationId, 'original_request_note', async () => {
                    const note = await adapter.addCustomerVisibleNote(Object.assign({}, scope, {
                        ticketId: ticketCheckpoint.ticketId,
                        operationId,
                        origin: request.noteOrigin,
                        message: expectedMessage,
                        expectedProviderControlsSha256: request.providerControlsSha256
                    }));
                    return { noteId: note.id };
                });
            }
        }
        const rawTicket = await adapter.getTicketById(Object.assign({}, scope, {
            ticketId: ticketCheckpoint.ticketId,
            devices
        }));
        const completed = await operationFence.complete(Object.assign({}, scope, {
            operationId,
            result: { ticketReceipt: minimalTicketCheckpoint(rawTicket) }
        }));
        const ticket = await verifyTicketNoteOrigins(rawTicket, scope);
        return Object.assign({}, { operationId, status: 'completed', ticket, created: true, repeated: false }, {
            repeatedFromOperationId: completed.repeatedFromOperationId || ''
        });
    }

    async function replyToTicket(input = {}) {
        const scope = requireScope(input, env);
        const operationId = requireOperationId(input.operationId);
        const actor = requireActor(input.actor);
        assertWriteReady(actor);
        const devices = normaliseDevices(input.devices);
        const noteOrigin = actor.source === 'customer_portal' ? 'customer_reply' : 'service_desk_update';
        const contactId = actor.source === 'customer_portal'
            ? parseCanonicalProviderId(input.contactId)
            : '';
        if (actor.source === 'customer_portal' && !contactId) {
            throw runtimeError(409, 'The customer portal requester has no exact governed Autotask contact mapping', 'autotask_contact_mapping_required');
        }
        const requesterEmailSha256 = actor.source === 'customer_portal' ? actor.emailSha256 : '';
        const intakeChannel = actor.source === 'customer_portal' ? 'customer_portal' : 'staff_service_desk';
        const ticket = await adapter.getTicketByNumber(Object.assign({}, scope, { ticketNumber: input.ticketNumber, devices }));
        const request = {
            companyId: scope.companyId,
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            message: requiredText(input.message, 8000, 'ticket_reply_required'),
            noteOrigin,
            actorSubjectSha256: actor.subjectSha256
        };
        if (actor.source === 'customer_portal') request.contactId = contactId;
        request.providerControlsSha256 = providerControlsSha256(adapter);
        request.noteMessageSha256 = canonicalNoteMessageSha256(request.message);
        const resolvedReplyInput = Object.assign({}, scope, {
            ticketId: ticket.id,
            operationId,
            message: request.message,
            origin: noteOrigin
        });
        if (actor.source === 'customer_portal') resolvedReplyInput.contactId = contactId;
        if (typeof adapter.validateCustomerVisibleNoteInput === 'function') {
            adapter.validateCustomerVisibleNoteInput(resolvedReplyInput);
        }
        request.providerIntentSha256 = providerIntentSha256(adapter, 'note', resolvedReplyInput);
        const reservation = await operationFence.reserve(Object.assign({}, scope, {
            operationId,
            operationType: 'autotask.ticket.reply',
            resourceKey: `ticket:${ticket.id}`,
            request,
            actorSubjectSha256: actor.subjectSha256,
            requesterEmailSha256,
            intakeChannel,
            noteMessageSha256: request.noteMessageSha256,
            noteOrigin: request.noteOrigin,
            repeatToken: repeatConfirmation(input)
        }));
        const immediate = await resolveImmediateReservation(reservation, operationId, scope, devices, adapter, verifyTicketNoteOrigins);
        if (immediate) return immediate;
        try {
            let replyCheckpoint = checkpoint(reservation, 'reply_note');
            const currentStep = stepStatus(reservation, 'reply_note');
            if (!replyCheckpoint && ['dispatching', 'uncertain'].includes(currentStep)) {
                const reconciliationInput = Object.assign({}, scope, {
                    ticketId: ticket.id,
                    operationId,
                    origin: noteOrigin,
                    expectedMessage: request.message
                });
                if (actor.source === 'customer_portal') reconciliationInput.contactId = contactId;
                const note = await adapter.findCustomerVisibleNoteByOperationId(reconciliationInput);
                if (!note) return pending(operationId, reservation.repeatedFromOperationId);
                replyCheckpoint = { noteId: note.id };
                await operationFence.applyStep(Object.assign({}, scope, {
                    operationId,
                    step: 'reply_note',
                    checkpoint: replyCheckpoint,
                    reconciled: true
                }));
            }
            if (!replyCheckpoint) {
                replyCheckpoint = await dispatchStep(scope, operationId, 'reply_note', async () => {
                    const noteInput = Object.assign({}, scope, {
                        ticketId: ticket.id,
                        operationId,
                        origin: noteOrigin,
                        message: request.message,
                        expectedProviderControlsSha256: request.providerControlsSha256,
                        expectedProviderIntentSha256: request.providerIntentSha256
                    });
                    if (actor.source === 'customer_portal') noteInput.contactId = contactId;
                    const note = await adapter.addCustomerVisibleNote(noteInput);
                    return { noteId: note.id };
                });
            }
            const rawRefreshed = await adapter.getTicketById(Object.assign({}, scope, { ticketId: ticket.id, devices }));
            const completed = await operationFence.complete(Object.assign({}, scope, {
                operationId,
                result: { ticketReceipt: minimalTicketCheckpoint(rawRefreshed) }
            }));
            const refreshed = await verifyTicketNoteOrigins(rawRefreshed, scope);
            return Object.assign({}, { operationId, status: 'completed', ticket: refreshed, created: true, repeated: false }, {
                repeatedFromOperationId: completed.repeatedFromOperationId || ''
            });
        } catch (error) {
            throw publicMutationError(error, operationId);
        }
    }

    async function updateTicketStatus(input = {}) {
        if (adapter.status().statusWritesEnabled !== true) {
            throw runtimeError(409, 'Ticket status updates are read-only until exclusive-writer governance is verified', 'autotask_status_writer_not_exclusive');
        }
        const scope = requireScope(input, env);
        const operationId = requireOperationId(input.operationId);
        const actor = requireActor(input.actor);
        assertWriteReady(actor);
        const devices = normaliseDevices(input.devices);
        const ticket = await adapter.getTicketByNumber(Object.assign({}, scope, { ticketNumber: input.ticketNumber, devices }));
        const expectedProviderVersion = cleanText(input.expectedProviderVersion, 128);
        if (!expectedProviderVersion || ticket.providerVersion !== expectedProviderVersion) {
            throw runtimeError(409, 'The ticket changed before the status update', 'autotask_ticket_version_conflict', {
                currentProviderVersion: ticket.providerVersion
            });
        }
        const request = {
            companyId: scope.companyId,
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            status: cleanIdentifier(input.status, 60),
            expectedProviderVersion,
            message: optionalCustomerText(input.message, 8000) || `A status change to ${cleanIdentifier(input.status, 60)} has been requested.`,
            noteOrigin: 'service_desk_update',
            actorSubjectSha256: actor.subjectSha256
        };
        request.providerControlsSha256 = providerControlsSha256(adapter);
        request.noteMessageSha256 = canonicalNoteMessageSha256(request.message);
        const resolvedStatusNoteInput = Object.assign({}, scope, {
            ticketId: ticket.id,
            operationId,
            message: request.message,
            origin: request.noteOrigin
        });
        const resolvedStatusPatchInput = Object.assign({}, scope, {
            ticketId: ticket.id,
            status: request.status,
            expectedProviderVersion
        });
        if (typeof adapter.validateCustomerVisibleNoteInput === 'function') {
            adapter.validateCustomerVisibleNoteInput(resolvedStatusNoteInput);
        }
        if (typeof adapter.validateStatusUpdateInput === 'function') {
            adapter.validateStatusUpdateInput(resolvedStatusPatchInput);
        }
        request.noteProviderIntentSha256 = providerIntentSha256(adapter, 'note', resolvedStatusNoteInput);
        request.statusProviderIntentSha256 = providerIntentSha256(adapter, 'status', resolvedStatusPatchInput);
        const reservation = await operationFence.reserve(Object.assign({}, scope, {
            operationId,
            operationType: 'autotask.ticket.status',
            resourceKey: `ticket:${ticket.id}`,
            request,
            actorSubjectSha256: actor.subjectSha256,
            requesterEmailSha256: '',
            intakeChannel: actor.source === 'customer_portal' ? 'customer_portal' : 'staff_service_desk',
            noteMessageSha256: request.noteMessageSha256,
            noteOrigin: request.noteOrigin,
            repeatToken: repeatConfirmation(input)
        }));
        const immediate = await resolveImmediateReservation(reservation, operationId, scope, devices, adapter, verifyTicketNoteOrigins);
        if (immediate) return immediate;
        try {
            let beforeNote;
            try {
                beforeNote = await adapter.readRawTicketForVersion(Object.assign({}, scope, { ticketId: ticket.id }));
            } catch (error) {
                await operationFence.cancel(Object.assign({}, scope, {
                    operationId,
                    failureCode: error && error.details && error.details.code || 'autotask_status_preflight_failed'
                })).catch(() => {});
                if (error && typeof error === 'object') {
                    error.details = Object.assign({}, error.details, { providerDispatched: false });
                }
                throw error;
            }
            if (beforeNote.providerVersion !== expectedProviderVersion && !checkpoint(reservation, 'status_note')) {
                await operationFence.cancel(Object.assign({}, scope, {
                    operationId,
                    failureCode: 'autotask_ticket_version_conflict'
                })).catch(() => {});
                throw runtimeError(409, 'The ticket changed before the status update', 'autotask_ticket_version_conflict', {
                    currentProviderVersion: beforeNote.providerVersion
                });
            }
            let noteCheckpoint = checkpoint(reservation, 'status_note');
            const noteState = stepStatus(reservation, 'status_note');
            if (!noteCheckpoint && ['dispatching', 'uncertain'].includes(noteState)) {
                const note = await adapter.findCustomerVisibleNoteByOperationId(Object.assign({}, scope, {
                    ticketId: ticket.id,
                    operationId,
                    origin: request.noteOrigin,
                    expectedMessage: request.message
                }));
                if (!note) return pending(operationId, reservation.repeatedFromOperationId);
                const afterNote = await adapter.readRawTicketForVersion(Object.assign({}, scope, { ticketId: ticket.id }));
                if (afterNote.providerVersion !== expectedProviderVersion) return pending(operationId, reservation.repeatedFromOperationId);
                noteCheckpoint = { noteId: note.id, providerVersionAfterNote: afterNote.providerVersion };
                await operationFence.applyStep(Object.assign({}, scope, {
                    operationId,
                    step: 'status_note',
                    checkpoint: noteCheckpoint,
                    reconciled: true
                }));
            }
            if (!noteCheckpoint) {
                noteCheckpoint = await dispatchStep(scope, operationId, 'status_note', async () => {
                    const note = await adapter.addCustomerVisibleNote(Object.assign({}, scope, {
                        ticketId: ticket.id,
                        operationId,
                        origin: request.noteOrigin,
                        message: request.message,
                        expectedProviderControlsSha256: request.providerControlsSha256,
                        expectedProviderIntentSha256: request.noteProviderIntentSha256
                    }));
                    const afterNote = await adapter.readRawTicketForVersion(Object.assign({}, scope, { ticketId: ticket.id }));
                    if (afterNote.providerVersion !== expectedProviderVersion) {
                        throw runtimeError(409, 'The ticket changed while the status note was recorded', 'autotask_ticket_version_conflict', {
                            currentProviderVersion: afterNote.providerVersion
                        });
                    }
                    return { noteId: note.id, providerVersionAfterNote: afterNote.providerVersion };
                });
            }
            const immediatelyBeforePatch = await adapter.readRawTicketForVersion(Object.assign({}, scope, { ticketId: ticket.id }));
            if (
                !noteCheckpoint.providerVersionAfterNote ||
                noteCheckpoint.providerVersionAfterNote !== expectedProviderVersion ||
                immediatelyBeforePatch.providerVersion !== expectedProviderVersion
            ) {
                return pending(operationId, reservation.repeatedFromOperationId);
            }
            let statusCheckpoint = checkpoint(reservation, 'status_patch');
            const patchState = stepStatus(reservation, 'status_patch');
            if (!statusCheckpoint && ['dispatching', 'uncertain'].includes(patchState)) {
                const observed = await adapter.getTicketById(Object.assign({}, scope, { ticketId: ticket.id, devices }));
                if (observed.status !== request.status) return pending(operationId, reservation.repeatedFromOperationId);
                statusCheckpoint = minimalTicketCheckpoint(observed);
                await operationFence.applyStep(Object.assign({}, scope, {
                    operationId,
                    step: 'status_patch',
                    checkpoint: statusCheckpoint,
                    reconciled: true
                }));
            }
            if (!statusCheckpoint) {
                statusCheckpoint = await dispatchStep(scope, operationId, 'status_patch', async () => {
                    const updated = await adapter.updateTicketStatus(Object.assign({}, scope, {
                        ticketId: ticket.id,
                        expectedProviderVersion: noteCheckpoint.providerVersionAfterNote,
                        status: request.status,
                        devices,
                        expectedProviderControlsSha256: request.providerControlsSha256,
                        expectedProviderIntentSha256: request.statusProviderIntentSha256
                    }));
                    return minimalTicketCheckpoint(updated);
                });
            }
            const rawRefreshed = await adapter.getTicketById(Object.assign({}, scope, { ticketId: ticket.id, devices }));
            const completed = await operationFence.complete(Object.assign({}, scope, {
                operationId,
                result: { ticketReceipt: minimalTicketCheckpoint(rawRefreshed) }
            }));
            const refreshed = await verifyTicketNoteOrigins(rawRefreshed, scope);
            return Object.assign({}, { operationId, status: 'completed', ticket: refreshed, created: true, repeated: false }, {
                repeatedFromOperationId: completed.repeatedFromOperationId || ''
            });
        } catch (error) {
            throw publicMutationError(error, operationId);
        }
    }

    async function dispatchStep(scope, operationId, step, invoke) {
        const started = await operationFence.beginStep(Object.assign({}, scope, { operationId, step }));
        if (started.status === 'applied') return started.checkpoint;
        try {
            const result = await invoke();
            await operationFence.applyStep(Object.assign({}, scope, { operationId, step, checkpoint: result }));
            return result;
        } catch (error) {
            const definitelyNotDispatched = Boolean(error && error.details && error.details.providerDispatched === false);
            let operationStatus = '';
            try {
                await operationFence.failStep(Object.assign({}, scope, {
                    operationId,
                    step,
                    providerEffectAbsent: definitelyNotDispatched || Boolean(error && error.details && error.details.providerEffectAbsent === true),
                    failureCode: error && error.details && error.details.code
                }));
                const latest = await operationFence.read(Object.assign({}, scope, { operationId }));
                operationStatus = latest && latest.status || '';
            } catch (fenceError) {}
            if (error && typeof error === 'object') {
                error.details = Object.assign({}, error.details, operationStatus ? { operationStatus } : {});
            }
            throw error;
        }
    }

    async function verifyTicketNoteOrigins(ticket, scope) {
        const source = ticket && typeof ticket === 'object' ? ticket : {};
        const rawNotes = Array.isArray(source.notes) ? source.notes : [];
        const notes = rawNotes.map((raw) => {
            const note = Object.assign({}, raw);
            note.origin = 'service_desk_update';
            note.originVerified = false;
            return note;
        });
        const candidates = notes
            .map((note, index) => ({ note, index }))
            .filter(({ note }) => (
                ['customer_portal_submission', 'customer_reply'].includes(cleanIdentifier(note._claimedOrigin, 40)) &&
                cleanText(note._providerOperationId, 180)
            ));
        const selected = candidates.slice(0, MAX_NOTE_PROVENANCE_CHECKS);
        for (let offset = 0; offset < selected.length; offset += NOTE_PROVENANCE_CONCURRENCY) {
            await Promise.all(selected.slice(offset, offset + NOTE_PROVENANCE_CONCURRENCY).map(async ({ note }) => {
                const claimedOrigin = cleanIdentifier(note._claimedOrigin, 40);
                const providerOperationId = cleanText(note._providerOperationId, 180);
                if (typeof operationFence.verifyNoteProvenance !== 'function') return;
                const verified = await operationFence.verifyNoteProvenance(Object.assign({}, scope, {
                    operationId: providerOperationId,
                    noteMessageSha256: canonicalNoteMessageSha256(note.message),
                    noteOrigin: claimedOrigin,
                    ticketId: source.id,
                    noteId: note.id
                }));
                if (verified) {
                    note.origin = claimedOrigin;
                    note.originVerified = true;
                }
            }));
        }
        for (const note of notes) {
            delete note._claimedOrigin;
            delete note._providerOperationId;
        }
        const projectionIssues = Array.isArray(source.projectionIssues) ? source.projectionIssues.slice() : [];
        if (candidates.length > selected.length) {
            projectionIssues.push({ field: 'notes', code: 'note_origin_verification_truncated' });
        }
        return Object.assign({}, source, { notes, projectionIssues });
    }

    function assertWriteReady(actor) {
        const current = status();
        if (!current.writeOperationsEnabled) {
            throw runtimeError(503, 'The production Autotask service desk is not ready for writes', 'service_desk_provider_not_ready');
        }
        const writeScope = String(env.NOFRIES_SERVICE_DESK_WRITE_SCOPE || '').trim().toLowerCase();
        if (writeScope === 'canary') {
            const subjects = parseCanarySubjects(env.NOFRIES_SERVICE_DESK_CANARY_STAFF_SUBJECTS);
            if (!subjects.includes(actor.subjectKey)) {
                throw runtimeError(403, 'Service-desk writes are restricted to the signed canary identity', 'service_desk_canary_write_scope');
            }
            return;
        }
        if (writeScope !== 'governed') {
            throw runtimeError(503, 'The production service-desk write scope is not configured', 'service_desk_write_scope_required');
        }
        const customerAdmin = actor.source === 'customer_portal' && actor.role === 'customer_admin';
        const governedStaff = actor.source === 'staff_service_desk' && ['admin', 'service_owner', 'consultant'].includes(actor.role);
        if (!customerAdmin && !governedStaff) {
            throw runtimeError(403, 'This identity is not admitted for governed service-desk writes', 'service_desk_write_actor_not_admitted');
        }
    }

    return {
        createTicket,
        getTicketById,
        getTicketByNumber,
        getOperationAudit,
        getOperationStatus,
        health,
        listTickets,
        replyToTicket,
        resolveOperationStepAbsent,
        status,
        updateTicketStatus
    };
}

async function resolveImmediateReservation(reservation, requestedOperationId, scope, devices, adapterOverride, verifyTicket) {
    if (reservation.disposition === 'confirmation_required') {
        return {
            operationId: reservation.operationId,
            status: 'confirmation_required',
            repeatConfirmationToken: reservation.repeatToken,
            repeatedFromOperationId: reservation.repeatedFromOperationId || ''
        };
    }
    if (reservation.status === 'completed') {
        const receipt = reservation.result && reservation.result.ticketReceipt;
        if (!receipt || !receipt.ticketId) {
            throw runtimeError(503, 'The completed operation receipt is unavailable', 'provider_operation_receipt_invalid');
        }
        const projected = await adapterOverride.getTicketById(Object.assign({}, scope, {
            ticketId: receipt.ticketId,
            devices
        }));
        const ticket = typeof verifyTicket === 'function' ? await verifyTicket(projected, scope) : projected;
        return {
            operationId: reservation.operationId,
            status: 'completed',
            ticket,
            idempotentReplay: true,
            created: false,
            repeated: true,
            repeatedFromOperationId: reservation.repeatedFromOperationId || ''
        };
    }
    if (reservation.operationId !== requestedOperationId) {
        return pending(reservation.operationId, reservation.repeatedFromOperationId);
    }
    if (reservation.disposition === 'pending' && reservation.operationId) return null;
    return null;
}

function pending(operationId, repeatedFromOperationId) {
    return { operationId, status: 'pending', repeatedFromOperationId: repeatedFromOperationId || '' };
}

function operationStatusProjection(record, includeResolutionDetails) {
    const rawStatus = String(record && record.status || 'pending');
    const terminal = rawStatus === 'completed';
    const output = {
        operationId: cleanText(record && record.operationId, 180),
        status: terminal ? 'completed' : 'pending',
        terminal,
        retrySameOperation: !terminal,
        idempotentReplay: terminal,
        repeatedFromOperationId: cleanText(record && record.repeatedFromOperationId, 180)
    };
    if (includeResolutionDetails) {
        output.providerState = rawStatus;
        output.unresolvedSteps = Object.entries(record && record.steps || {})
            .filter(([, value]) => ['dispatching', 'uncertain'].includes(value && value.status))
            .map(([step, value]) => ({
                step,
                status: value.status,
                attempt: Number(value.attempt || 0)
            }));
    }
    return output;
}

function checkpoint(reservation, step) {
    const value = reservation && reservation.steps && reservation.steps[step];
    return value && value.status === 'applied' ? value.checkpoint : null;
}

function stepStatus(reservation, step) {
    const value = reservation && reservation.steps && reservation.steps[step];
    return value && value.status || 'not_started';
}

function minimalTicketCheckpoint(ticket) {
    return {
        ticketId: parseCanonicalProviderId(ticket && ticket.id),
        ticketNumber: cleanText(ticket && ticket.ticketNumber, 80),
        companyId: parseCanonicalProviderId(ticket && ticket.companyId),
        providerVersion: cleanText(ticket && ticket.providerVersion, 128)
    };
}

function providerControlsSha256(adapter) {
    if (adapter && typeof adapter.providerControlsSha256 === 'function') {
        const value = String(adapter.providerControlsSha256() || '').trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(value)) return value;
        throw runtimeError(503, 'The Autotask provider control fingerprint is unavailable', 'autotask_provider_controls_unavailable');
    }
    // Test adapters do not dispatch provider HTTP requests. Keep their request
    // identity deterministic without weakening the production adapter contract.
    return crypto.createHash('sha256').update('non-provider-test-adapter-controls-v1', 'utf8').digest('hex');
}

function providerIntentSha256(adapter, action, input) {
    if (adapter && typeof adapter.providerIntentSha256 === 'function') {
        const value = String(adapter.providerIntentSha256(action, input) || '').trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(value)) return value;
        throw runtimeError(503, 'The resolved Autotask provider intent fingerprint is unavailable', 'autotask_provider_intent_unavailable');
    }
    const semanticInput = Object.assign({}, input || {});
    delete semanticInput.operationId;
    delete semanticInput.expectedProviderIntentSha256;
    delete semanticInput.expectedProviderControlsSha256;
    return crypto.createHash('sha256').update(canonicalJson({ action, input: semanticInput }), 'utf8').digest('hex');
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function canonicalNoteMessageSha256(value) {
    return crypto.createHash('sha256').update(cleanText(value, 8000), 'utf8').digest('hex');
}

function providerAbsenceTargetKey(step, operationId, ticketId = '') {
    const operationHash = crypto.createHash('sha256').update(String(operationId), 'utf8').digest('hex');
    if (step === 'ticket_create') return `ticket-operation:${operationHash}`;
    const canonicalTicketId = parseCanonicalProviderId(ticketId);
    if (!canonicalTicketId) {
        throw runtimeError(409, 'The exact provider target is unavailable', 'provider_absence_resolution_target_invalid');
    }
    return `ticket-note:${canonicalTicketId}:${operationHash}`;
}

function providerAbsenceEvidenceRef(input) {
    const digest = crypto.createHash('sha256').update(canonicalJson({
        provider: 'autotask',
        providerScopeId: input.scope.providerScopeId,
        providerIdentitySha256: input.scope.providerIdentitySha256,
        customerId: input.scope.customerId,
        companyId: input.scope.companyId,
        operationId: input.operationId,
        step: input.step,
        expectedAttempt: input.expectedAttempt,
        providerTargetKey: input.providerTargetKey,
        queryKind: input.queryKind,
        checkedAt: input.checkedAt,
        observedPresent: false
    }), 'utf8').digest('hex');
    return `autotask-negative:${digest}`;
}

function requireOperatorEvidenceReference(value) {
    const reference = cleanText(value, 240);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,239}$/.test(reference) || /(?:token|secret|password|credential)=/i.test(reference)) {
        throw runtimeError(400, 'A non-secret operator evidence reference is required', 'provider_absence_resolution_invalid');
    }
    return reference;
}

function requireScope(input, env = {}) {
    const tenantId = cleanIdentifier(input.tenantId, 180);
    const customerId = cleanIdentifier(input.customerId, 180);
    const companyId = parseCanonicalProviderId(input.companyId);
    const providerScopeId = cleanIdentifier(input.providerScopeId, 180);
    const configuredProviderScopeId = cleanIdentifier(env.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID, 180);
    const accountId = providerAccountId(env);
    if (
        !tenantId || !customerId || !companyId ||
        !providerScopeId || !configuredProviderScopeId || providerScopeId !== configuredProviderScopeId || !accountId
    ) {
        throw runtimeError(
            409,
            'An exact tenant, customer, company and Autotask provider identity mapping is required',
            'service_desk_provider_binding_required'
        );
    }
    const providerIdentitySha256 = crypto.createHash('sha256')
        .update(`autotask\u0000${accountId}`, 'utf8')
        .digest('hex');
    return {
        tenantId,
        customerId,
        companyId,
        providerScopeId,
        providerIdentitySha256,
        portalVisibleOnly: input.portalVisibleOnly === true
    };
}

function providerAccountId(env) {
    const value = cleanIdentifier(env.NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID, 180);
    return /^[a-z0-9][a-z0-9._:-]{2,179}$/.test(value) ? value : '';
}

function normaliseDevices(value) {
    const devices = Array.isArray(value) ? value : [];
    const ids = new Set();
    const installed = new Set();
    return devices.map((item) => {
        const device = {
            id: cleanText(item && item.id, 180),
            dattoDeviceUid: cleanText(item && item.dattoDeviceUid, 180),
            autotaskInstalledProductId: parseCanonicalProviderId(item && item.autotaskInstalledProductId),
            companyId: parseCanonicalProviderId(item && item.companyId)
        };
        if (!device.id || ids.has(device.id)) throw runtimeError(409, 'The customer device mapping is ambiguous', 'service_desk_device_mapping_ambiguous');
        ids.add(device.id);
        if (item && item.autotaskInstalledProductId != null && item.autotaskInstalledProductId !== '' && !device.autotaskInstalledProductId) {
            throw runtimeError(409, 'The Autotask device mapping is ambiguous', 'service_desk_device_mapping_ambiguous');
        }
        if (item && item.companyId != null && item.companyId !== '' && !device.companyId) {
            throw runtimeError(409, 'The Autotask device mapping is ambiguous', 'service_desk_device_mapping_ambiguous');
        }
        if (device.autotaskInstalledProductId) {
            if (installed.has(device.autotaskInstalledProductId)) {
                throw runtimeError(409, 'The Autotask device mapping is ambiguous', 'service_desk_device_mapping_ambiguous');
            }
            installed.add(device.autotaskInstalledProductId);
        }
        return device;
    });
}

function requireActor(value) {
    const source = value && typeof value === 'object' ? value : {};
    const subjectKey = cleanIdentifier(source.subjectKey, 240);
    const key = subjectKey || cleanText(source.principalId, 240);
    if (!key) throw runtimeError(403, 'A verified server-side actor identity is required', 'service_desk_actor_required');
    return {
        subjectSha256: crypto.createHash('sha256').update(key, 'utf8').digest('hex'),
        emailSha256: optionalEmailSha256(source.email),
        subjectKey,
        source: cleanIdentifier(source.source, 80),
        role: cleanIdentifier(source.role, 80)
    };
}

function parseCanarySubjects(value) {
    let parsed;
    try {
        parsed = JSON.parse(String(value || ''));
    } catch (error) {
        throw runtimeError(503, 'The signed canary write scope is not configured', 'service_desk_canary_subjects_invalid');
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10) {
        throw runtimeError(503, 'The signed canary write scope is not configured', 'service_desk_canary_subjects_invalid');
    }
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const subjects = parsed.map((item) => String(item || '').trim().toLowerCase());
    if (subjects.some((item) => !pattern.test(item)) || new Set(subjects).size !== subjects.length) {
        throw runtimeError(503, 'The signed canary write scope is not configured', 'service_desk_canary_subjects_invalid');
    }
    return subjects;
}

function writeScopeStatus(env) {
    const scope = String(env.NOFRIES_SERVICE_DESK_WRITE_SCOPE || '').trim().toLowerCase();
    if (scope === 'governed') return { scope, ready: true };
    if (scope !== 'canary') return { scope, ready: false };
    try {
        parseCanarySubjects(env.NOFRIES_SERVICE_DESK_CANARY_STAFF_SUBJECTS);
        return { scope, ready: true };
    } catch (error) {
        return { scope, ready: false };
    }
}

function publicMutationError(error, operationId) {
    if (error instanceof AutotaskRuntimeError && error.details && error.details.operationId) return error;
    const providerEffectAbsent = Boolean(error && error.details && (
        error.details.providerEffectAbsent === true || error.details.providerDispatched === false
    ));
    const partialApplied = Boolean(error && error.details && error.details.operationStatus === 'partial_applied');
    const originalStatus = Number(error && error.statusCode || 500);
    const safeStatus = originalStatus >= 400 && originalStatus < 500 ? originalStatus : 503;
    const safeCode = providerEffectAbsent && !partialApplied
        ? cleanIdentifier(error && error.details && error.details.code, 120) || 'provider_request_rejected'
        : 'provider_operation_pending';
    return runtimeError(
        safeStatus,
        providerEffectAbsent && !partialApplied
            ? 'Autotask rejected the request before applying it'
            : 'The provider outcome could not be confirmed; the operation remains safely reserved',
        safeCode,
        { operationId, status: providerEffectAbsent && !partialApplied ? 'known_absent' : 'pending' }
    );
}

function requireOperationId(value) {
    const id = cleanText(value, 180);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/.test(id)) throw runtimeError(400, 'A stable operation ID is required', 'operation_id_required');
    return id;
}

function repeatConfirmation(input) {
    if (input && Object.prototype.hasOwnProperty.call(input, 'repeatToken')) {
        throw runtimeError(400, 'Use only repeatConfirmationToken for an intentional repeat', 'repeat_confirmation_field_invalid');
    }
    const token = String(input && input.repeatConfirmationToken || '').trim();
    if (!token) return '';
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw runtimeError(409, 'The repeat confirmation is invalid or expired', 'repeat_confirmation_invalid');
    return token;
}

function requiredText(value, maximum, code) {
    assertNoReservedOperationMarker(value);
    const text = cleanText(value, maximum);
    if (!text) throw runtimeError(400, 'Required service-desk text is missing', code);
    return text;
}

function optionalCustomerText(value, maximum) {
    if (value == null || String(value).trim() === '') return '';
    assertNoReservedOperationMarker(value);
    return cleanText(value, maximum);
}

function assertNoReservedOperationMarker(value) {
    if (/\[No Fries (?:operation|origin)\b/iu.test(String(value == null ? '' : value))) {
        throw runtimeError(400, 'Customer text contains a reserved service-desk operation marker', 'reserved_operation_marker');
    }
}

function requiredIdentifier(value, maximum, code) {
    const identifier = cleanIdentifier(value, maximum);
    if (!identifier) throw runtimeError(400, 'A required service-desk value is missing', code);
    return identifier;
}

function hashEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw runtimeError(400, 'A verified requester email is required', 'support_requester_required');
    }
    return crypto.createHash('sha256').update(email, 'utf8').digest('hex');
}

function optionalEmailSha256(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw runtimeError(400, 'The verified actor email is invalid', 'service_desk_actor_email_invalid');
    }
    return crypto.createHash('sha256').update(email, 'utf8').digest('hex');
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function cleanIdentifier(value, maximum) { return cleanText(value, maximum).toLowerCase(); }
function runtimeError(statusCode, message, code, details) { return new AutotaskRuntimeError(statusCode, message, code, details); }

module.exports = {
    AutotaskRuntimeError,
    createAutotaskRuntime,
    parseCanonicalProviderId
};
