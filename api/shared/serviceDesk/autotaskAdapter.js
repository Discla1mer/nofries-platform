const crypto = require('crypto');
const { parseCanonicalProviderId } = require('./providerIds');

const TICKET_FIELDS = Object.freeze([
    'id', 'ticketNumber', 'companyID', 'installedProductID', 'status', 'priority', 'title',
    'source', 'queueID', 'issueType', 'subIssueType', 'contactID',
    'createDate', 'lastActivityDate', 'lastTrackedModificationDateTime', 'userDefinedFields'
]);
const NOTE_FIELDS = Object.freeze(['id', 'ticketID', 'description', 'publish', 'noteType', 'createDateTime']);
const CANONICAL_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const NOTE_ORIGINS = new Set(['customer_portal_submission', 'customer_reply', 'service_desk_update']);
const RESERVED_MARKER_PATTERN = /\[No Fries (?:operation|origin)\b/iu;

class AutotaskAdapterError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createAutotaskAdapter(options = {}) {
    const client = options.client;
    const config = options.config || resolveAutotaskAdapterConfig(options.env || process.env);
    if (!client) throw adapterError(500, 'The Autotask client is required', 'autotask_client_required');

    function status() {
        const missing = config.configurationError ? ['valid Autotask mapping configuration'] : [];
        for (const [key, value] of Object.entries({
            NOFRIES_AUTOTASK_QUEUE_ID: config.queueId,
            NOFRIES_AUTOTASK_SOURCE_ID: config.sourceId,
            NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID: config.dattoRmmSourceId,
            NOFRIES_AUTOTASK_ISSUE_TYPE_ID: config.issueTypeId,
            NOFRIES_AUTOTASK_SUBISSUE_TYPE_ID: config.subIssueTypeId,
            NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_PUBLISH_VALUE: config.customerVisiblePublishValue,
            NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_NOTE_TYPE_ID: config.customerVisibleNoteTypeId,
            NOFRIES_AUTOTASK_OPERATION_UDF_NAME: config.operationUdfName,
            NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_NAME: config.portalVisibleUdfName,
            NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_VALUE_JSON: config.portalVisibleUdfConfigured ? 'configured' : ''
        })) if (!value) missing.push(key);
        if (!config.statusWriteMap.new && !config.statusWriteMap.open) missing.push('NOFRIES_AUTOTASK_STATUS_MAP_JSON.new');
        if (!Object.keys(config.priorityWriteMap).length) missing.push('NOFRIES_AUTOTASK_PRIORITY_MAP_JSON');
        return {
            configured: !config.configurationError && missing.length === 0,
            state: config.configurationError ? 'invalid_configuration' : missing.length ? 'mapping_required' : 'ready',
            provider: 'autotask',
            exactMappings: true,
            customerVisibleNotes: Boolean(config.customerVisiblePublishValue && config.customerVisibleNoteTypeId),
            operationMarkerConfigured: Boolean(config.operationUdfName),
            priorityMapDigestVerified: config.priorityMapDigestVerified === true,
            portalVisibilityReady: Boolean(config.portalVisibleUdfName && config.portalVisibleUdfConfigured),
            dattoRmmSourceMappingReady: Boolean(config.dattoRmmSourceId && config.dattoRmmSourceId !== config.sourceId),
            statusWritesEnabled: config.statusWritesRequested === true && config.statusWriterGovernance === 'exclusive_no_fries',
            missing,
            configurationError: config.configurationError
        };
    }

    async function listTickets(input = {}) {
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const filter = [{ op: 'eq', field: 'companyID', value: Number(companyId) }];
        if (input.portalVisibleOnly === true) filter.push(portalVisibleFilter(config));
        const result = await client.queryTickets(filter, {
            fields: TICKET_FIELDS,
            maxPages: input.maxPages,
            maxRecords: input.maxRecords
        });
        // The provider must not be able to widen an exact company query by
        // returning a row from another company (or a malformed company ID).
        const providerItems = result.items.filter((raw) => parseCanonicalProviderId(raw && raw.companyID) === companyId);
        const visibleItems = input.portalVisibleOnly === true
            ? providerItems.filter((raw) => isPortalVisible(raw, config))
            : providerItems;
        const tickets = visibleItems.map((raw) => projectTicket(raw, [], {
            config,
            devices: input.devices,
            notesTruncated: false
        }));
        return { tickets, pages: result.pages, truncated: result.truncated };
    }

    async function getTicketByNumber(input = {}) {
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const ticketNumber = requireTicketNumber(input.ticketNumber);
        const filter = [
            { op: 'eq', field: 'companyID', value: Number(companyId) },
            { op: 'eq', field: 'ticketNumber', value: ticketNumber }
        ];
        if (input.portalVisibleOnly === true) filter.push(portalVisibleFilter(config));
        const result = await client.queryTickets(filter, { fields: TICKET_FIELDS, maxPages: 20, maxRecords: 2 });
        if (result.truncated || result.items.length > 1) {
            throw adapterError(502, 'Autotask returned more than one exact ticket match', 'autotask_ticket_mapping_ambiguous');
        }
        if (!result.items.length) throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        assertTicketCompany(result.items[0], companyId);
        if (input.portalVisibleOnly === true && !isPortalVisible(result.items[0], config)) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        return projectTicketWithNotes(result.items[0], input);
    }

    async function getTicketById(input = {}) {
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const ticketId = requireNumericId(input.ticketId, 'autotask_ticket_id_invalid');
        const raw = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(raw && raw.id) !== ticketId) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        assertTicketCompany(raw, companyId);
        if (input.portalVisibleOnly === true && !isPortalVisible(raw, config)) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        return projectTicketWithNotes(raw, input);
    }

    async function findTicketByOperationId(input = {}) {
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const operationId = requireOperationId(input.operationId);
        if (!config.operationUdfName) {
            throw adapterError(503, 'The exact Autotask operation marker is not configured', 'autotask_operation_marker_required');
        }
        const result = await client.queryTickets([
            { op: 'eq', field: 'companyID', value: Number(companyId) },
            { op: 'eq', field: config.operationUdfName, udf: true, value: operationId }
        ], { fields: TICKET_FIELDS, maxPages: 20, maxRecords: 2 });
        if (result.truncated || result.items.length > 1) {
            throw adapterError(409, 'The Autotask operation marker is not unique', 'autotask_operation_marker_ambiguous');
        }
        if (result.items.length) {
            assertTicketCompany(result.items[0], companyId);
            if (input.expectedProviderIntentSha256) {
                assertProviderIntent(input, 'create');
                assertExactCreatedTicket(result.items[0], validateCreateInput(input), config);
            }
        }
        if (result.items.length && input.portalVisibleOnly === true && !isPortalVisible(result.items[0], config)) {
            throw adapterError(409, 'The provider ticket is not eligible for the customer portal', 'autotask_portal_visibility_verification_failed');
        }
        return result.items.length ? projectTicketWithNotes(result.items[0], input) : null;
    }

    async function createTicket(input = {}) {
        const validated = validateCreateInput(input);
        const { companyId, operationId, device, openStatus, providerPriority, subject, contactId } = validated;
        try {
            assertProviderIntent(input, 'create');
            if (contactId) {
                if (typeof client.getContact !== 'function') {
                    throw adapterError(503, 'The Autotask contact verification endpoint is unavailable', 'autotask_contact_verification_unavailable');
                }
                const contact = await client.getContact(contactId);
                if (
                    parseCanonicalProviderId(contact && contact.id) !== contactId ||
                    parseCanonicalProviderId(contact && contact.companyID) !== companyId
                ) {
                    throw adapterError(409, 'The Autotask contact does not belong to the mapped company', 'autotask_contact_company_mismatch');
                }
            }
        } catch (error) {
            throw markNotDispatched(error);
        }
        const payload = {
            companyID: Number(companyId),
            queueID: Number(config.queueId),
            source: Number(config.sourceId),
            issueType: Number(config.issueTypeId),
            subIssueType: Number(config.subIssueTypeId),
            status: Number(openStatus),
            priority: Number(providerPriority),
            title: subject,
            description: 'Customer request received through No Fries. The customer-visible ticket note contains the original request.',
            userDefinedFields: [
                { name: config.operationUdfName, value: operationId },
                { name: config.portalVisibleUdfName, value: config.portalVisibleUdfValue }
            ]
        };
        if (device.installedProductId) payload.installedProductID = Number(device.installedProductId);
        if (contactId) payload.contactID = Number(contactId);
        const mutation = await client.createTicket(payload);
        const ticketId = requireNumericId(mutation.itemId || mutation.item && mutation.item.id, 'autotask_create_response_invalid');
        const raw = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(raw && raw.id) !== ticketId) {
            throw adapterError(409, 'Autotask returned a different ticket after creation', 'autotask_create_readback_mismatch');
        }
        assertExactCreatedTicket(raw, validated, config);
        return projectTicketWithNotes(raw, Object.assign({}, input, { ticketId, companyId }));
    }

    async function addCustomerVisibleNote(input = {}) {
        const validated = validateCustomerVisibleNoteInput(input);
        const { ticketId, companyId, message, operationId, origin, contactId } = validated;
        try {
            const current = await client.getTicket(ticketId);
            if (parseCanonicalProviderId(current && current.id) !== ticketId) {
                throw adapterError(404, 'Ticket not found', 'ticket_not_found');
            }
            assertTicketCompany(current, companyId);
            assertPortalVisibility(current, input, config);
            assertProviderIntent(input, 'note');
            if (origin === 'customer_reply') {
                if (typeof client.getContact !== 'function') {
                    throw adapterError(503, 'The Autotask contact verification endpoint is unavailable', 'autotask_contact_verification_unavailable');
                }
                const contact = await client.getContact(contactId);
                if (
                    parseCanonicalProviderId(contact && contact.id) !== contactId ||
                    parseCanonicalProviderId(contact && contact.companyID) !== companyId
                ) {
                    throw adapterError(409, 'The Autotask contact does not belong to the mapped company', 'autotask_contact_company_mismatch');
                }
            }
        } catch (error) {
            throw markNotDispatched(error);
        }
        const marker = noteOperationMarker(operationId);
        const originMarker = noteOriginMarker(origin);
        const notePayload = {
            ticketID: Number(ticketId),
            title: 'Customer update',
            description: `${message}\n\n${originMarker}\n${marker}`,
            publish: Number(config.customerVisiblePublishValue)
        };
        notePayload.noteType = Number(config.customerVisibleNoteTypeId);
        const mutation = await client.createTicketNote(notePayload);
        const noteId = requireNumericId(mutation.itemId || mutation.item && mutation.item.id, 'autotask_note_response_invalid');
        if (typeof client.getTicketNote !== 'function') {
            throw adapterError(503, 'The Autotask note verification endpoint is unavailable', 'autotask_note_readback_unavailable');
        }
        const rawNote = await client.getTicketNote(noteId);
        assertExactCustomerVisibleNote(rawNote, validated, config, noteId);
        const after = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(after && after.id) !== ticketId) {
            throw adapterError(409, 'The Autotask ticket changed during the note write', 'autotask_note_readback_mismatch');
        }
        assertTicketCompany(after, companyId);
        assertPortalVisibility(after, input, config);
        return projectNote(rawNote, config);
    }

    async function findCustomerVisibleNoteByOperationId(input = {}) {
        const ticketId = requireNumericId(input.ticketId, 'autotask_ticket_id_invalid');
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const current = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(current && current.id) !== ticketId) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        assertTicketCompany(current, companyId);
        assertPortalVisibility(current, input, config);
        const operationId = requireOperationId(input.operationId);
        const expectedOrigin = input.origin == null ? '' : requireNoteOrigin(input.origin);
        if (expectedOrigin === 'customer_reply') {
            requireNumericId(input.contactId, 'autotask_contact_mapping_required');
        }
        const expectedMessage = cleanText(input.expectedMessage, 8000);
        if (!expectedMessage) {
            throw adapterError(400, 'The exact expected customer-visible message is required for reconciliation', 'ticket_note_expected_message_required');
        }
        const result = await client.queryTicketNotes([
            { op: 'eq', field: 'ticketID', value: Number(ticketId) }
        ], { fields: NOTE_FIELDS, maxPages: 20, maxRecords: 2000 });
        const exact = result.items.filter((note) => isExactCustomerVisibleNote(note, {
            ticketId,
            operationId,
            message: expectedMessage,
            origin: expectedOrigin || 'service_desk_update'
        }, config));
        if (result.truncated || exact.length > 1) {
            throw adapterError(409, 'The Autotask note operation marker is not unique', 'autotask_note_marker_ambiguous');
        }
        return exact.length ? projectNote(exact[0], config) : null;
    }

    async function hasCustomerVisibleNoteOperationMarker(input = {}) {
        const ticketId = requireNumericId(input.ticketId, 'autotask_ticket_id_invalid');
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const current = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(current && current.id) !== ticketId) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        assertTicketCompany(current, companyId);
        const operationId = requireOperationId(input.operationId);
        const result = await client.queryTicketNotes([
            { op: 'eq', field: 'ticketID', value: Number(ticketId) }
        ], { fields: NOTE_FIELDS, maxPages: 20, maxRecords: 2000 });
        if (result.truncated) {
            throw adapterError(409, 'Autotask note reconciliation was truncated', 'autotask_note_marker_ambiguous');
        }
        return result.items.some((note) => (
            parseCanonicalProviderId(note && note.ticketID) === ticketId &&
            isPositiveCustomerVisible(note, config) &&
            hasExactTerminalOperationMarker(note.description, operationId)
        ));
    }

    async function updateTicketStatus(input = {}) {
        const validated = validateStatusUpdateInput(input);
        const { companyId, ticketId, providerStatus } = validated;
        let before;
        try {
            before = await client.getTicket(ticketId);
            if (parseCanonicalProviderId(before && before.id) !== ticketId) {
                throw adapterError(404, 'Ticket not found', 'ticket_not_found');
            }
            assertTicketCompany(before, companyId);
            assertPortalVisibility(before, input, config);
            const expectedVersion = cleanText(input.expectedProviderVersion, 128);
            const currentVersion = ticketProviderVersion(before);
            if (!expectedVersion || expectedVersion !== currentVersion) {
                throw adapterError(409, 'The ticket changed before the status update', 'autotask_ticket_version_conflict', {
                    currentProviderVersion: currentVersion
                });
            }
            assertProviderIntent(input, 'status');
        } catch (error) {
            throw markNotDispatched(error);
        }
        await client.updateTicket(ticketId, { id: Number(ticketId), status: Number(providerStatus) });
        const after = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(after && after.id) !== ticketId) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        assertTicketCompany(after, companyId);
        if (String(after.status) !== String(providerStatus)) {
            throw adapterError(502, 'Autotask did not confirm the requested status', 'autotask_status_verification_failed');
        }
        return projectTicketWithNotes(after, input);
    }

    async function readRawTicketForVersion(input = {}) {
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const ticketId = requireNumericId(input.ticketId, 'autotask_ticket_id_invalid');
        const raw = await client.getTicket(ticketId);
        if (parseCanonicalProviderId(raw && raw.id) !== ticketId) {
            throw adapterError(404, 'Ticket not found', 'ticket_not_found');
        }
        assertTicketCompany(raw, companyId);
        assertPortalVisibility(raw, input, config);
        return { raw, providerVersion: ticketProviderVersion(raw) };
    }

    async function projectTicketWithNotes(raw, input) {
        const ticketId = requireNumericId(raw && raw.id, 'autotask_ticket_response_invalid');
        const notes = await client.queryTicketNotes([
            { op: 'eq', field: 'ticketID', value: Number(ticketId) }
        ], { fields: NOTE_FIELDS, maxPages: 20, maxRecords: 2000 });
        let verified = raw;
        if (input.portalVisibleOnly === true) {
            verified = await client.getTicket(ticketId);
            if (String(verified && verified.id || '') !== ticketId) {
                throw adapterError(404, 'Ticket not found', 'ticket_not_found');
            }
            assertTicketCompany(verified, input.companyId);
            assertPortalVisibility(verified, input, config);
            const beforeVersion = ticketProviderVersion(raw);
            const afterVersion = ticketProviderVersion(verified);
            if (!beforeVersion || !afterVersion || beforeVersion !== afterVersion) {
                throw adapterError(409, 'The ticket changed while the portal projection was prepared', 'autotask_ticket_projection_changed');
            }
        }
        return projectTicket(verified, notes.items.filter((note) => (
            parseCanonicalProviderId(note && note.ticketID) === ticketId
        )), {
            config,
            devices: input.devices,
            notesTruncated: notes.truncated
        });
    }

    function validateCreateInput(input = {}) {
        assertConfigured();
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const operationId = requireOperationId(input.operationId);
        const device = resolveDeviceForWrite(companyId, input.deviceId, input.devices);
        const openStatus = config.statusWriteMap.new || requireStatusForWrite('open');
        const priority = cleanIdentifier(input.priority, 60);
        const providerPriority = config.priorityWriteMap[priority];
        if (!providerPriority) throw adapterError(409, 'The requested ticket priority has no exact Autotask mapping', 'autotask_priority_mapping_required');
        const subject = cleanText(input.subject, 160);
        if (!subject) throw adapterError(400, 'A ticket subject is required', 'ticket_subject_required');
        assertNoReservedMarker(input.subject);
        const contactId = input.contactId == null || String(input.contactId).trim() === ''
            ? ''
            : requireNumericId(input.contactId, 'autotask_contact_mapping_required');
        return { companyId, operationId, device, openStatus, providerPriority, subject, contactId };
    }

    function validateCustomerVisibleNoteInput(input = {}) {
        assertConfigured();
        const ticketId = requireNumericId(input.ticketId, 'autotask_ticket_id_invalid');
        const companyId = requireNumericId(input.companyId, 'autotask_company_mapping_required');
        const operationId = requireOperationId(input.operationId);
        const message = cleanText(input.message, 8000);
        if (!message) throw adapterError(400, 'A customer-visible message is required', 'ticket_note_required');
        assertNoReservedMarker(input.message);
        const origin = requireNoteOrigin(input.origin || 'service_desk_update');
        const contactId = origin === 'customer_reply'
            ? requireNumericId(input.contactId, 'autotask_contact_mapping_required')
            : '';
        return { ticketId, companyId, operationId, message, origin, contactId };
    }

    function validateStatusUpdateInput(input = {}) {
        assertConfigured();
        if (config.statusWritesRequested !== true || config.statusWriterGovernance !== 'exclusive_no_fries') {
            throw adapterError(409, 'Ticket status writes require an exclusive-writer governance attestation', 'autotask_status_writer_not_exclusive');
        }
        return {
            companyId: requireNumericId(input.companyId, 'autotask_company_mapping_required'),
            ticketId: requireNumericId(input.ticketId, 'autotask_ticket_id_invalid'),
            providerStatus: requireStatusForWrite(input.status)
        };
    }

    function assertConfigured() {
        const current = status();
        if (!current.configured) {
            throw adapterError(503, 'The exact Autotask mappings are not configured', 'autotask_mapping_required', {
                missing: current.missing
            });
        }
    }

    function requireStatusForWrite(status) {
        const canonical = cleanIdentifier(status, 60);
        const provider = config.statusWriteMap[canonical];
        if (!provider) throw adapterError(409, 'The requested ticket status has no exact Autotask mapping', 'autotask_status_mapping_required');
        return provider;
    }

    function providerIntentSha256(action, input = {}) {
        const operation = cleanIdentifier(action, 40);
        let intent;
        if (operation === 'create') {
            const value = validateCreateInput(input);
            intent = {
                operation,
                companyId: value.companyId,
                installedProductId: value.device.installedProductId || '',
                contactId: value.contactId || '',
                queueId: config.queueId,
                sourceId: config.sourceId,
                issueTypeId: config.issueTypeId,
                subIssueTypeId: config.subIssueTypeId,
                statusId: value.openStatus,
                priorityId: value.providerPriority,
                subject: value.subject,
                operationUdfName: config.operationUdfName,
                portalVisibleUdfName: config.portalVisibleUdfName,
                portalVisibleUdfValue: config.portalVisibleUdfValue
            };
        } else if (operation === 'note') {
            const value = validateCustomerVisibleNoteInput(input);
            intent = {
                operation,
                companyId: value.companyId,
                ticketId: value.ticketId,
                messageSha256: sha256(value.message),
                origin: value.origin,
                publish: config.customerVisiblePublishValue,
                noteType: config.customerVisibleNoteTypeId,
                portalVisibleOnly: input.portalVisibleOnly === true,
                portalVisibleUdfName: config.portalVisibleUdfName,
                portalVisibleUdfValue: config.portalVisibleUdfValue
            };
            if (value.origin === 'customer_reply') intent.contactId = value.contactId;
        } else if (operation === 'status') {
            const value = validateStatusUpdateInput(input);
            intent = {
                operation,
                companyId: value.companyId,
                ticketId: value.ticketId,
                providerStatus: value.providerStatus,
                expectedProviderVersion: cleanText(input.expectedProviderVersion, 128)
            };
        } else {
            throw adapterError(400, 'The provider intent type is invalid', 'autotask_provider_intent_invalid');
        }
        return sha256(canonicalJson(intent));
    }

    function providerControlsSha256() {
        return sha256(canonicalJson({
            queueId: config.queueId,
            sourceId: config.sourceId,
            dattoRmmSourceId: config.dattoRmmSourceId,
            issueTypeId: config.issueTypeId,
            subIssueTypeId: config.subIssueTypeId,
            customerVisiblePublishValue: config.customerVisiblePublishValue,
            customerVisibleNoteTypeId: config.customerVisibleNoteTypeId,
            operationUdfName: config.operationUdfName,
            portalVisibleUdfName: config.portalVisibleUdfName,
            portalVisibleUdfValue: config.portalVisibleUdfValue,
            statusWriteMap: config.statusWriteMap,
            priorityWriteMap: config.priorityWriteMap
        }));
    }

    function assertProviderIntent(input, action) {
        const expectedControls = cleanText(input.expectedProviderControlsSha256, 64).toLowerCase();
        if (expectedControls && expectedControls !== providerControlsSha256()) {
            throw adapterError(409, 'The resolved Autotask provider controls changed before dispatch', 'autotask_provider_controls_changed', {
                providerDispatched: false
            });
        }
        const expected = cleanText(input.expectedProviderIntentSha256, 64).toLowerCase();
        if (!expected) return;
        const observed = providerIntentSha256(action, input);
        if (expected !== observed) {
            throw adapterError(409, 'The resolved Autotask provider controls changed before dispatch', 'autotask_provider_intent_changed', {
                providerDispatched: false
            });
        }
    }

    return {
        addCustomerVisibleNote,
        createTicket,
        findCustomerVisibleNoteByOperationId,
        findTicketByOperationId,
        getTicketById,
        getTicketByNumber,
        hasCustomerVisibleNoteOperationMarker,
        listTickets,
        readRawTicketForVersion,
        status,
        updateTicketStatus,
        validateCreateInput,
        validateCustomerVisibleNoteInput,
        validateStatusUpdateInput,
        providerIntentSha256,
        providerControlsSha256
    };
}

function projectTicket(raw, rawNotes, options = {}) {
    const config = options.config || {
        statusReadMap: {},
        priorityReadMap: {},
        deviceReverseMap: {},
        customerVisiblePublishValue: '',
        customerVisibleNoteTypeId: ''
    };
    const projectionIssues = [];
    const ticketId = parseCanonicalProviderId(raw && raw.id);
    const providerStatus = String(raw && raw.status == null ? '' : raw.status);
    const status = config.statusReadMap[providerStatus] || 'unavailable';
    if (status === 'unavailable') projectionIssues.push({ field: 'status', code: 'status_mapping_unavailable' });
    const providerPriority = String(raw && raw.priority == null ? '' : raw.priority);
    const priority = (config.priorityReadMap || {})[providerPriority] || 'unavailable';
    if (priority === 'unavailable') projectionIssues.push({ field: 'priority', code: 'priority_mapping_unavailable' });
    const providerSource = parseCanonicalProviderId(raw && raw.source);
    const source = providerSource && providerSource === config.dattoRmmSourceId
        ? 'datto_rmm'
        : providerSource && providerSource === config.sourceId ? 'no_fries' : 'unavailable';
    if (source === 'unavailable') projectionIssues.push({ field: 'source', code: 'source_mapping_unavailable' });
    let device = '';
    const installedProductId = parseCanonicalProviderId(raw && raw.installedProductID);
    if (installedProductId) {
        device = resolveProjectedDevice(installedProductId, options.devices, config.deviceReverseMap);
        if (!device) projectionIssues.push({ field: 'device', code: 'device_mapping_unavailable' });
    }
    if (options.notesTruncated) projectionIssues.push({ field: 'notes', code: 'notes_truncated' });
    const notes = (Array.isArray(rawNotes) ? rawNotes : [])
        .filter((note) => parseCanonicalProviderId(note && note.ticketID) === ticketId && isPositiveCustomerVisible(note, config))
        .map((note) => projectNote(note, config));
    return {
        id: ticketId,
        ticketNumber: cleanText(raw && raw.ticketNumber, 80),
        companyId: parseCanonicalProviderId(raw && raw.companyID),
        device,
        status,
        priority,
        source,
        subject: cleanText(raw && raw.title, 300),
        createdAt: normaliseIso(raw && raw.createDate),
        updatedAt: normaliseIso(raw && (raw.lastTrackedModificationDateTime || raw.lastActivityDate)),
        providerVersion: ticketProviderVersion(raw),
        portalVisible: isPortalVisible(raw, config),
        notes,
        projectionIssues
    };
}

function projectNote(note) {
    const claimedOrigin = noteOrigin(note && note.description);
    return {
        id: parseCanonicalProviderId(note && note.id),
        message: stripOperationMarker(cleanText(note && note.description, 8000)),
        createdAt: normaliseIso(note && note.createDateTime),
        customerVisible: true,
        origin: 'service_desk_update',
        originVerified: false,
        _providerOperationId: noteOperationId(note && note.description),
        _claimedOrigin: claimedOrigin
    };
}

function isPositiveCustomerVisible(note, config) {
    if (!note || typeof note !== 'object') return false;
    return Boolean(
        config.customerVisiblePublishValue &&
        config.customerVisibleNoteTypeId &&
        String(note.publish == null ? '' : note.publish) === String(config.customerVisiblePublishValue) &&
        String(note.noteType == null ? '' : note.noteType) === String(config.customerVisibleNoteTypeId)
    );
}

function hasExactTerminalOperationMarker(value, operationId) {
    const marker = noteOperationMarker(operationId);
    const lines = String(value || '').replace(/\r\n?/g, '\n').trimEnd().split('\n').map((line) => line.trim());
    return lines[lines.length - 1] === marker && lines.filter((line) => line === marker).length === 1;
}

function ticketProviderVersion(ticket) {
    const id = parseCanonicalProviderId(ticket && ticket.id);
    const tracked = normaliseIso(ticket && ticket.lastTrackedModificationDateTime);
    const status = cleanText(ticket && ticket.status, 40);
    if (!id || !tracked || !status) return '';
    return Buffer.from(JSON.stringify({ id, status, lastTrackedModificationDateTime: tracked }), 'utf8').toString('base64url');
}

function resolveAutotaskAdapterConfig(env = {}) {
    let configurationError = '';
    let statusWriteMap = {};
    let priorityWriteMap = {};
    let deviceMap = {};
    let portalVisibleUdfValue = null;
    let portalVisibleUdfConfigured = false;
    try {
        statusWriteMap = numericMapping(env.NOFRIES_AUTOTASK_STATUS_MAP_JSON, 'NOFRIES_AUTOTASK_STATUS_MAP_JSON');
        priorityWriteMap = numericMapping(env.NOFRIES_AUTOTASK_PRIORITY_MAP_JSON, 'NOFRIES_AUTOTASK_PRIORITY_MAP_JSON');
        deviceMap = numericMapping(env.NOFRIES_AUTOTASK_DEVICE_MAP_JSON || '{}', 'NOFRIES_AUTOTASK_DEVICE_MAP_JSON', true);
        const portalValue = JSON.parse(String(env.NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_VALUE_JSON || ''));
        if (portalValue !== true) {
            throw new Error('NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_VALUE_JSON must be literal true');
        }
        portalVisibleUdfValue = portalValue;
        portalVisibleUdfConfigured = true;
    } catch (error) {
        configurationError = error.message;
    }
    const statusReadMap = {};
    for (const [canonical, provider] of Object.entries(statusWriteMap)) {
        if (statusReadMap[String(provider)] && statusReadMap[String(provider)] !== canonical) {
            configurationError = 'NOFRIES_AUTOTASK_STATUS_MAP_JSON values must be unique';
        }
        statusReadMap[String(provider)] = cleanIdentifier(canonical, 60);
    }
    const deviceReverseMap = {};
    for (const [key, provider] of Object.entries(deviceMap)) {
        if (deviceReverseMap[String(provider)] && deviceReverseMap[String(provider)] !== key) {
            configurationError = 'NOFRIES_AUTOTASK_DEVICE_MAP_JSON values must be unique';
        }
        deviceReverseMap[String(provider)] = key;
    }
    const priorityReadMap = {};
    for (const [canonical, provider] of Object.entries(priorityWriteMap)) {
        if (priorityReadMap[String(provider)] && priorityReadMap[String(provider)] !== canonical) {
            configurationError = 'NOFRIES_AUTOTASK_PRIORITY_MAP_JSON values must be unique';
        }
        priorityReadMap[String(provider)] = cleanIdentifier(canonical, 60);
    }
    const configuredPriorities = Object.keys(priorityWriteMap).sort();
    if (
        configuredPriorities.length !== CANONICAL_PRIORITIES.length ||
        configuredPriorities.some((value, index) => value !== CANONICAL_PRIORITIES.slice().sort()[index])
    ) {
        configurationError = 'NOFRIES_AUTOTASK_PRIORITY_MAP_JSON must map exactly low, normal, high and urgent';
    }
    const configuredPriorityDigest = cleanText(env.NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256, 64).toLowerCase();
    const priorityMapSha256 = canonicalPriorityMapSha256(priorityWriteMap);
    if (!/^[a-f0-9]{64}$/.test(configuredPriorityDigest) || configuredPriorityDigest !== priorityMapSha256) {
        configurationError = 'NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256 must match the resolved canonical priority map';
    }
    const operationUdfName = cleanText(env.NOFRIES_AUTOTASK_OPERATION_UDF_NAME || 'NoFriesOperationId', 120);
    const portalVisibleUdfName = cleanText(env.NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_NAME, 120);
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,44}$/.test(operationUdfName)) {
        configurationError = 'NOFRIES_AUTOTASK_OPERATION_UDF_NAME must be an exact Autotask UDF name';
    }
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,44}$/.test(portalVisibleUdfName) || portalVisibleUdfName === operationUdfName) {
        configurationError = 'NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_NAME must be a distinct exact Autotask UDF name';
    }
    const sourceId = numericEnv(env.NOFRIES_AUTOTASK_SOURCE_ID);
    const dattoRmmSourceId = numericEnv(env.NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID);
    if (sourceId && dattoRmmSourceId && sourceId === dattoRmmSourceId) {
        configurationError = 'NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID must be distinct from NOFRIES_AUTOTASK_SOURCE_ID';
    }
    return {
        queueId: numericEnv(env.NOFRIES_AUTOTASK_QUEUE_ID),
        sourceId,
        dattoRmmSourceId,
        issueTypeId: numericEnv(env.NOFRIES_AUTOTASK_ISSUE_TYPE_ID),
        subIssueTypeId: numericEnv(env.NOFRIES_AUTOTASK_SUBISSUE_TYPE_ID),
        customerVisiblePublishValue: numericEnv(env.NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_PUBLISH_VALUE),
        customerVisibleNoteTypeId: numericEnv(env.NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_NOTE_TYPE_ID),
        operationUdfName,
        portalVisibleUdfName,
        portalVisibleUdfValue,
        portalVisibleUdfConfigured,
        statusWriterGovernance: cleanIdentifier(env.NOFRIES_AUTOTASK_STATUS_WRITER_GOVERNANCE, 80),
        statusWritesRequested: String(env.NOFRIES_AUTOTASK_STATUS_WRITES_ENABLED || 'false').trim().toLowerCase() === 'true',
        statusWriteMap,
        statusReadMap,
        priorityWriteMap,
        priorityReadMap,
        priorityMapSha256,
        priorityMapDigestVerified: Boolean(priorityMapSha256 && priorityMapSha256 === configuredPriorityDigest),
        deviceMap,
        deviceReverseMap,
        configurationError
    };
}

function portalVisibleFilter(config) {
    if (!config.portalVisibleUdfName || config.portalVisibleUdfConfigured !== true) {
        throw adapterError(503, 'The exact customer portal ticket visibility policy is not configured', 'autotask_portal_visibility_required');
    }
    return { op: 'eq', field: config.portalVisibleUdfName, udf: true, value: config.portalVisibleUdfValue };
}

function isPortalVisible(ticket, config) {
    if (!config || !config.portalVisibleUdfName || config.portalVisibleUdfConfigured !== true) return false;
    const fields = Array.isArray(ticket && ticket.userDefinedFields) ? ticket.userDefinedFields : [];
    const exact = fields.filter((field) => cleanText(field && field.name, 45) === config.portalVisibleUdfName);
    return exact.length === 1 && JSON.stringify(exact[0].value) === JSON.stringify(config.portalVisibleUdfValue);
}

function resolveDeviceForWrite(companyId, requestedDeviceId, devices) {
    const deviceId = cleanText(requestedDeviceId, 180);
    if (!deviceId) return { id: '', installedProductId: '' };
    const device = (Array.isArray(devices) ? devices : []).find((candidate) => cleanText(candidate && candidate.id, 180) === deviceId);
    if (!device) throw adapterError(409, 'The selected device has no current exact customer mapping', 'autotask_device_mapping_required');
    const installedProductId = numericEnv(device.autotaskInstalledProductId);
    if (!installedProductId) throw adapterError(409, 'The selected device has no exact Autotask installed-product mapping', 'autotask_device_mapping_required');
    const mappedCompanyId = device.companyId ? parseCanonicalProviderId(device.companyId) : companyId;
    if (!mappedCompanyId || mappedCompanyId !== companyId) {
        throw adapterError(403, 'The selected device belongs to another Autotask company', 'autotask_device_company_mismatch');
    }
    return { id: deviceId, installedProductId };
}

function resolveProjectedDevice(installedProductId, devices, fallbackMap) {
    const canonicalInstalledProductId = parseCanonicalProviderId(installedProductId);
    if (!canonicalInstalledProductId) return '';
    const governedDevices = Array.isArray(devices) ? devices : null;
    const exact = (governedDevices || []).filter((device) => (
        parseCanonicalProviderId(device && device.autotaskInstalledProductId) === canonicalInstalledProductId
    ));
    if (exact.length === 1) return cleanText(exact[0].id, 180);
    if (exact.length > 1) return '';
    if (governedDevices) return '';
    const fallback = fallbackMap && fallbackMap[canonicalInstalledProductId];
    return fallback ? cleanText(String(fallback).split(':').pop(), 180) : '';
}

function assertTicketCompany(ticket, companyId) {
    if (!parseCanonicalProviderId(ticket && ticket.companyID) ||
        parseCanonicalProviderId(ticket && ticket.companyID) !== parseCanonicalProviderId(companyId)) {
        throw adapterError(404, 'Ticket not found', 'ticket_not_found');
    }
}

function assertPortalVisibility(ticket, input, config) {
    if (input && input.portalVisibleOnly === true && !isPortalVisible(ticket, config)) {
        throw adapterError(404, 'Ticket not found', 'ticket_not_found');
    }
}

function assertExactCreatedTicket(ticket, expected, config) {
    assertTicketCompany(ticket, expected.companyId);
    const exactIds = [
        ['source', config.sourceId],
        ['queueID', config.queueId],
        ['issueType', config.issueTypeId],
        ['subIssueType', config.subIssueTypeId],
        ['status', expected.openStatus],
        ['priority', expected.providerPriority]
    ];
    if (exactIds.some(([field, value]) => parseCanonicalProviderId(ticket && ticket[field]) !== value)) {
        throw adapterError(409, 'The created Autotask ticket did not match the resolved provider controls', 'autotask_create_readback_mismatch');
    }
    if (cleanText(ticket && ticket.title, 160) !== expected.subject) {
        throw adapterError(409, 'The created Autotask ticket title did not match', 'autotask_create_readback_mismatch');
    }
    const installedProductId = parseCanonicalProviderId(ticket && ticket.installedProductID);
    if (installedProductId !== (expected.device.installedProductId || '')) {
        throw adapterError(409, 'The created Autotask ticket device did not match', 'autotask_create_readback_mismatch');
    }
    if (expected.contactId && parseCanonicalProviderId(ticket && ticket.contactID) !== expected.contactId) {
        throw adapterError(409, 'The created Autotask ticket contact did not match', 'autotask_create_readback_mismatch');
    }
    if (
        !hasExactUdfValue(ticket, config.operationUdfName, expected.operationId) ||
        !hasExactUdfValue(ticket, config.portalVisibleUdfName, config.portalVisibleUdfValue)
    ) {
        throw adapterError(409, 'The created Autotask ticket markers did not match', 'autotask_create_readback_mismatch');
    }
}

function hasExactUdfValue(ticket, name, value) {
    const fields = Array.isArray(ticket && ticket.userDefinedFields) ? ticket.userDefinedFields : [];
    const exact = fields.filter((field) => cleanText(field && field.name, 45) === name);
    return exact.length === 1 && JSON.stringify(exact[0].value) === JSON.stringify(value);
}

function isExactCustomerVisibleNote(note, expected, config, expectedNoteId = '') {
    return Boolean(
        (!expectedNoteId || parseCanonicalProviderId(note && note.id) === expectedNoteId) &&
        parseCanonicalProviderId(note && note.ticketID) === expected.ticketId &&
        isPositiveCustomerVisible(note, config) &&
        hasExactTerminalOperationMarker(note && note.description, expected.operationId) &&
        noteOrigin(note && note.description) === expected.origin &&
        stripOperationMarker(cleanText(note && note.description, 8000)) === expected.message
    );
}

function assertExactCustomerVisibleNote(note, expected, config, expectedNoteId) {
    if (!isExactCustomerVisibleNote(note, expected, config, expectedNoteId)) {
        throw adapterError(409, 'The Autotask note readback did not match the requested customer-visible note', 'autotask_note_readback_mismatch');
    }
}

function numericMapping(value, label, allowEmpty = false) {
    let parsed;
    try {
        parsed = JSON.parse(String(value == null || value === '' ? '{}' : value));
    } catch (error) {
        throw new Error(`${label} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
    const result = {};
    for (const [key, raw] of Object.entries(parsed)) {
        const safeKey = cleanIdentifier(key, 240);
        const number = numericEnv(raw);
        if (!safeKey || !number) throw new Error(`${label} contains an invalid mapping`);
        if (Object.prototype.hasOwnProperty.call(result, safeKey)) throw new Error(`${label} contains an ambiguous mapping`);
        result[safeKey] = number;
    }
    if (!allowEmpty && !Object.keys(result).length) throw new Error(`${label} must contain at least one mapping`);
    return result;
}

function canonicalPriorityMapSha256(value) {
    const source = value && typeof value === 'object' ? value : {};
    const canonical = {};
    for (const priority of CANONICAL_PRIORITIES) canonical[priority] = String(source[priority] || '');
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function numericEnv(value) {
    return parseCanonicalProviderId(value);
}

function requireNumericId(value, code) {
    const id = parseCanonicalProviderId(value);
    if (!id) throw adapterError(409, 'An exact Autotask mapping is required', code);
    return id;
}

function requireOperationId(value) {
    const id = cleanText(value, 180);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,179}$/.test(id)) throw adapterError(400, 'A stable operation ID is required', 'operation_id_required');
    return id;
}

function requireTicketNumber(value) {
    const number = cleanText(value, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(number)) throw adapterError(400, 'A valid exact ticket number is required', 'ticket_number_invalid');
    return number;
}

function noteOperationMarker(operationId) {
    return `[No Fries operation ${operationId}]`;
}

function noteOriginMarker(origin) {
    return `[No Fries origin ${requireNoteOrigin(origin)}]`;
}

function noteOrigin(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').trimEnd().split('\n').map((line) => line.trim());
    const operationIndex = lines.length - 1;
    const match = operationIndex > 0 && lines[operationIndex - 1].match(/^\[No Fries origin ([a-z_]{1,40})\]$/u);
    return match && NOTE_ORIGINS.has(match[1]) ? match[1] : 'service_desk_update';
}

function noteOperationId(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').trimEnd().split('\n').map((line) => line.trim());
    const terminal = lines[lines.length - 1] || '';
    const match = terminal.match(/^\[No Fries operation ([A-Za-z0-9][A-Za-z0-9._:-]{7,179})\]$/u);
    return match && lines.filter((line) => line === terminal).length === 1 ? match[1] : '';
}

function stripOperationMarker(value) {
    return String(value || '')
        .replace(/\s*(?:\[No Fries origin [a-z_]{1,40}\]\s*)?\[No Fries operation [A-Za-z0-9][A-Za-z0-9._:-]{7,179}\]\s*$/u, '')
        .trim();
}

function requireNoteOrigin(value) {
    const origin = cleanIdentifier(value, 40);
    if (!NOTE_ORIGINS.has(origin)) {
        throw adapterError(400, 'The customer-visible note origin is invalid', 'ticket_note_origin_invalid');
    }
    return origin;
}

function assertNoReservedMarker(value) {
    if (RESERVED_MARKER_PATTERN.test(String(value == null ? '' : value))) {
        throw adapterError(400, 'Customer text contains a reserved service-desk operation marker', 'reserved_operation_marker');
    }
}

function markNotDispatched(error) {
    if (error instanceof AutotaskAdapterError) {
        error.details = Object.assign({}, error.details, { providerDispatched: false });
        return error;
    }
    return adapterError(503, 'Autotask could not verify the ticket before the note write', 'autotask_note_preflight_failed', {
        providerDispatched: false,
    });
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function adapterError(statusCode, message, code, details) {
    return new AutotaskAdapterError(statusCode, message, code, details);
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function cleanIdentifier(value, maximum) {
    return cleanText(value, maximum).toLowerCase();
}

function normaliseIso(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

module.exports = {
    AutotaskAdapterError,
    canonicalPriorityMapSha256,
    createAutotaskAdapter,
    parseCanonicalProviderId,
    isPositiveCustomerVisible,
    hasExactTerminalOperationMarker,
    isPortalVisible,
    noteOrigin,
    noteOriginMarker,
    noteOperationMarker,
    projectTicket,
    resolveAutotaskAdapterConfig,
    ticketProviderVersion
};
