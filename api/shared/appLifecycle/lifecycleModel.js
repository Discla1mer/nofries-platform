const crypto = require('crypto');
const {
    createEmptyCommercialAcceptance,
    createEmptyCustomerMaster,
    createEmptyServiceStatus,
    createEmptySupportProfile,
    normaliseActivationRequests,
    normaliseCommercialAcceptance,
    normaliseCustomerMaster,
    normaliseGate,
    normaliseOnboardingPlan,
    normaliseProofPeriods,
    normaliseProofRequirementLedger,
    normaliseServiceStatus,
    normaliseSupportProfile
} = require('./customerOperations');

const LIFECYCLE_STATES = Object.freeze({
    PROSPECT: 'prospect',
    DISCOVERY: 'discovery',
    SCOPING: 'scoping',
    PROPOSAL: 'proposal',
    ACCEPTED: 'accepted',
    ONBOARDING: 'onboarding',
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    OFFBOARDING: 'offboarding',
    FORMER: 'former'
});

const LIFECYCLE_ORDER = Object.freeze(Object.values(LIFECYCLE_STATES));

const SUPPORT_EVIDENCE_TYPES = Object.freeze([
    'ticket_raised',
    'recommendation_created',
    'approval_granted',
    'ticket_resolved',
    'ticket_needs_attention'
]);

const ONBOARDING_DEVICE_PLATFORMS = Object.freeze(['windows', 'macos', 'linux', 'other']);
const ONBOARDING_DEVICE_STATUSES = Object.freeze(['planned', 'installer_ready', 'enrolled', 'verified', 'blocked']);

const CONTEXT_FIELDS = Object.freeze([
    field('company.name', 'Organisation name', 'text', true),
    field('company.website', 'Website', 'text'),
    field('company.industry', 'Industry', 'text'),
    field('company.summary', 'Reason for looking at No Fries', 'text', true),
    field('contacts.primary.name', 'Primary contact name', 'text', true),
    field('contacts.primary.email', 'Primary contact email', 'email', true),
    field('contacts.primary.phone', 'Primary contact phone', 'text'),
    field('users.estimatedCount', 'Approximate users', 'number', true),
    field('users.notes', 'User notes', 'text'),
    field('endpoints.estimatedCount', 'Approximate endpoints', 'number', true),
    field('endpoints.notes', 'Endpoint notes', 'text'),
    field('locations.items', 'Locations', 'list', true),
    field('locations.notes', 'Location notes', 'text'),
    field('productivity.platform', 'Microsoft 365 or Google Workspace', 'platform', true),
    field('productivity.notes', 'Productivity platform notes', 'text'),
    field('itProvider.model', 'Existing IT provider model', 'providerModel', true),
    field('itProvider.name', 'Existing IT provider', 'text'),
    field('itProvider.notes', 'Existing provider notes', 'text'),
    field('internalIt.capability', 'Internal IT capability', 'internalIt', true),
    field('internalIt.notes', 'Internal IT notes', 'text'),
    field('network.summary', 'Network and environment', 'text'),
    field('security.tools', 'Security tooling', 'list', true),
    field('security.concerns', 'Security concerns', 'list'),
    field('applications.important', 'Important business applications', 'list', true),
    field('support.requirements', 'Support requirements', 'text', true),
    field('support.frustrations', 'Support frustrations', 'list', true),
    field('projects.upcoming', 'Upcoming projects', 'list'),
    field('commercial.preferredTiming', 'Preferred timing', 'timing'),
    field('commercial.decisionProcess', 'Decision process', 'text')
]);

const CONTEXT_FIELD_MAP = new Map(CONTEXT_FIELDS.map((definition) => [definition.path, definition]));

function field(path, label, type, discoveryRequired = false) {
    return Object.freeze({ path, label, type, discoveryRequired });
}

function createOrganisation(options = {}) {
    if (options.recordType !== undefined || options.lifecycleState !== undefined) {
        throw modelError(409, 'New lifecycle records must begin as prospects', 'initial_lifecycle_state_forbidden');
    }
    const now = options.now || new Date().toISOString();
    const id = options.id || createId('organisation');
    const context = createEmptyContext();
    const fieldStates = createFieldStates(now);
    const organisation = {
        id,
        recordType: 'prospect',
        lifecycleState: LIFECYCLE_STATES.PROSPECT,
        displayName: cleanText(options.displayName || 'New website prospect', 180),
        source: {
            channel: cleanText(options.sourceChannel || 'operator', 80),
            campaign: cleanText(options.sourceCampaign, 160),
            referrer: cleanText(options.referrer, 500),
            firstSeenAt: now
        },
        context,
        fieldStates,
        discovery: {
            status: 'not_started',
            notes: [],
            summary: '',
            missingFields: discoveryMissingFields({ context, fieldStates }),
            completedAt: ''
        },
        scope: {
            status: 'not_started',
            salesCustomerId: '',
            assessmentId: '',
            prefillPreparedAt: '',
            proposalId: '',
            proposalVersion: '',
            proposalSha256: '',
            proposalBoundAt: '',
            proposalBoundBy: '',
            deletionFence: createEmptyScopingDeletionFence(),
            deletionReceipts: []
        },
        onboarding: {
            status: 'not_started',
            planId: '',
            planVersion: '',
            planRevision: 0,
            kind: '',
            acceptanceId: '',
            activationRequestId: '',
            gates: [],
            devices: [],
            blockers: [],
            startedAt: '',
            completedAt: ''
        },
        support: {
            ticketIds: [],
            recurringThemes: [],
            lastTicketAt: '',
            evidence: []
        },
        nextAction: {
            type: 'continue_discovery',
            detail: 'Continue useful discovery',
            timing: '',
            owner: 'prospect_agent',
            dueAt: '',
            status: 'open'
        },
        links: {
            salesCustomerId: '',
            serviceDeskCustomerId: '',
            dattoRmmSiteUid: ''
        },
        commercialAcceptance: createEmptyCommercialAcceptance(),
        customerMaster: createEmptyCustomerMaster(now),
        customerMasterHistory: [],
        serviceStatus: createEmptyServiceStatus(),
        supportProfile: createEmptySupportProfile(),
        supportProfileHistory: [],
        activationRequests: [],
        proofPeriods: [],
        proofRequirementLedger: [],
        integrations: createEmptyIntegrations(),
        createdBy: cleanText(options.actorId || 'system', 180),
        createdAt: now,
        updatedBy: cleanText(options.actorId || 'system', 180),
        updatedAt: now
    };
    return normaliseOrganisation(organisation);
}

function createEmptyContext() {
    return {
        company: { name: '', website: '', industry: '', summary: '' },
        contacts: {
            primary: { name: '', email: '', phone: '' },
            others: []
        },
        users: { estimatedCount: null, notes: '' },
        endpoints: { estimatedCount: null, managedCount: null, deviceTypes: [], notes: '' },
        locations: { items: [], notes: '' },
        productivity: { platform: 'unknown', notes: '' },
        itProvider: { model: 'unknown', name: '', notes: '' },
        internalIt: { capability: 'unknown', notes: '' },
        network: { summary: '', sites: [], internetProviders: [] },
        security: { tools: [], concerns: [], notes: '' },
        applications: { important: [], notes: '' },
        support: { requirements: '', frustrations: [], hours: 'unknown', notes: '' },
        projects: { upcoming: [], notes: '' },
        commercial: { preferredTiming: '', decisionProcess: '', notes: '' }
    };
}

function createFieldStates(at = new Date().toISOString()) {
    return Object.fromEntries(CONTEXT_FIELDS.map((definition) => [definition.path, {
        status: 'unknown',
        source: 'not_provided',
        certainty: 'unknown',
        updatedAt: at,
        updatedBy: 'system'
    }]));
}

function normaliseOrganisation(value) {
    const source = value && typeof value === 'object' ? value : {};
    const now = new Date().toISOString();
    const empty = createOrganisationShell(now);
    const organisation = Object.assign(empty, source);
    organisation.recordType = source.recordType === 'customer' ? 'customer' : 'prospect';
    organisation.lifecycleState = normaliseLifecycleState(source.lifecycleState);
    organisation.context = deepMerge(createEmptyContext(), source.context || {});
    organisation.fieldStates = Object.assign(createFieldStates(now), source.fieldStates || {});
    organisation.discovery = Object.assign(empty.discovery, source.discovery || {});
    organisation.scope = Object.assign(empty.scope, source.scope || {});
    organisation.scope.deletionFence = normaliseScopingDeletionFence(
        source.scope && source.scope.deletionFence
    );
    organisation.scope.deletionReceipts = normaliseScopingDeletionReceipts(
        source.scope && source.scope.deletionReceipts
    );
    organisation.onboarding = Object.assign(empty.onboarding, source.onboarding || {});
    organisation.support = Object.assign(empty.support, source.support || {});
    organisation.nextAction = Object.assign(empty.nextAction, source.nextAction || {});
    organisation.links = Object.assign(empty.links, source.links || {});
    organisation.commercialAcceptance = normaliseCommercialAcceptance(source.commercialAcceptance);
    organisation.customerMaster = normaliseCustomerMaster(source.customerMaster, organisation.createdAt || now);
    organisation.customerMasterHistory = normaliseCustomerMasterHistory(source.customerMasterHistory);
    organisation.serviceStatus = normaliseServiceStatus(source.serviceStatus);
    organisation.supportProfile = normaliseSupportProfile(source.supportProfile);
    organisation.supportProfileHistory = normaliseSupportProfileHistory(source.supportProfileHistory);
    organisation.activationRequests = normaliseActivationRequests(source.activationRequests);
    organisation.proofPeriods = normaliseProofPeriods(source.proofPeriods);
    organisation.proofRequirementLedger = normaliseProofRequirementLedger(source.proofRequirementLedger);
    organisation.integrations = {
        dattoRmm: normaliseDattoRmmIntegration(source.integrations && source.integrations.dattoRmm)
    };
    organisation.discovery.notes = cleanStringList(organisation.discovery.notes, 100, 2000);
    organisation.onboarding = Object.assign(organisation.onboarding, normaliseOnboardingPlan(organisation.onboarding));
    organisation.onboarding.gates = (Array.isArray(organisation.onboarding.gates) ? organisation.onboarding.gates : [])
        .map(normaliseGate)
        .filter((gate) => gate.id && gate.title);
    organisation.onboarding.devices = normaliseOnboardingDevices(organisation.onboarding.devices);
    organisation.onboarding.blockers = cleanStringList(organisation.onboarding.blockers, 100, 1000);
    organisation.support.ticketIds = cleanStringList(organisation.support.ticketIds, 500, 180);
    organisation.support.recurringThemes = cleanStringList(organisation.support.recurringThemes, 100, 500);
    organisation.support.evidence = (Array.isArray(organisation.support.evidence) ? organisation.support.evidence : [])
        .map(normaliseSupportEvidenceEvent)
        .filter(Boolean)
        .slice(-500);
    organisation.discovery.missingFields = discoveryMissingFields(organisation);
    const companyName = contextValue(organisation.context, 'company.name');
    if (companyName) {
        organisation.displayName = cleanText(companyName, 180);
    }
    return organisation;
}

function createOrganisationShell(now) {
    return {
        id: '',
        recordType: 'prospect',
        lifecycleState: LIFECYCLE_STATES.PROSPECT,
        displayName: 'New website prospect',
        source: { channel: 'unknown', campaign: '', referrer: '', firstSeenAt: now },
        context: createEmptyContext(),
        fieldStates: createFieldStates(now),
        discovery: { status: 'not_started', notes: [], summary: '', missingFields: [], completedAt: '' },
        scope: {
            status: 'not_started',
            salesCustomerId: '',
            assessmentId: '',
            prefillPreparedAt: '',
            proposalId: '',
            proposalVersion: '',
            proposalSha256: '',
            proposalBoundAt: '',
            proposalBoundBy: '',
            deletionFence: createEmptyScopingDeletionFence(),
            deletionReceipts: []
        },
        onboarding: {
            status: 'not_started',
            planId: '',
            planVersion: '',
            planRevision: 0,
            kind: '',
            acceptanceId: '',
            activationRequestId: '',
            gates: [],
            devices: [],
            blockers: [],
            startedAt: '',
            completedAt: ''
        },
        support: { ticketIds: [], recurringThemes: [], lastTicketAt: '', evidence: [] },
        nextAction: { type: 'continue_discovery', detail: '', timing: '', owner: '', dueAt: '', status: 'open' },
        links: { salesCustomerId: '', serviceDeskCustomerId: '', dattoRmmSiteUid: '' },
        commercialAcceptance: createEmptyCommercialAcceptance(),
        customerMaster: createEmptyCustomerMaster(now),
        customerMasterHistory: [],
        serviceStatus: createEmptyServiceStatus(),
        supportProfile: createEmptySupportProfile(),
        supportProfileHistory: [],
        activationRequests: [],
        proofPeriods: [],
        proofRequirementLedger: [],
        integrations: createEmptyIntegrations(),
        createdBy: 'system',
        createdAt: now,
        updatedBy: 'system',
        updatedAt: now
    };
}

function applyContextFacts(organisation, facts, options = {}) {
    const actorId = cleanText(options.actorId || 'system', 180);
    const source = cleanText(options.source || 'operator', 80);
    const at = options.at || new Date().toISOString();
    const applied = [];
    const ignored = [];

    for (const rawFact of Array.isArray(facts) ? facts.slice(0, 30) : []) {
        const definition = CONTEXT_FIELD_MAP.get(String(rawFact && rawFact.field || ''));
        if (!definition) {
            ignored.push({ field: cleanText(rawFact && rawFact.field, 120), reason: 'unsupported_field' });
            continue;
        }
        const value = normaliseFactValue(definition, rawFact.value);
        if (value == null || value === '' || (Array.isArray(value) && !value.length) || value === 'unknown') {
            ignored.push({ field: definition.path, reason: 'empty_or_unknown' });
            continue;
        }
        setContextValue(organisation.context, definition.path, value);
        organisation.fieldStates[definition.path] = {
            status: 'known',
            source,
            certainty: rawFact.certainty === 'inferred' ? 'inferred' : 'explicit',
            updatedAt: at,
            updatedBy: actorId
        };
        applied.push({ field: definition.path, value });
    }

    organisation.updatedAt = at;
    organisation.updatedBy = actorId;
    organisation.discovery.status = organisation.lifecycleState === LIFECYCLE_STATES.PROSPECT
        ? 'collecting'
        : organisation.discovery.status;
    organisation.discovery.missingFields = discoveryMissingFields(organisation);
    const companyName = contextValue(organisation.context, 'company.name');
    if (companyName) {
        organisation.displayName = cleanText(companyName, 180);
    }
    return { applied, ignored };
}

function transitionLifecycle(organisation, targetState, options = {}) {
    const target = normaliseLifecycleState(targetState);
    const currentIndex = LIFECYCLE_ORDER.indexOf(organisation.lifecycleState);
    const targetIndex = LIFECYCLE_ORDER.indexOf(target);
    if (targetIndex !== currentIndex + 1) {
        throw modelError(409, `Lifecycle cannot move from ${organisation.lifecycleState} to ${target}`, 'invalid_lifecycle_transition');
    }
    if (options.publicAgent && target !== LIFECYCLE_STATES.DISCOVERY) {
        throw modelError(403, 'The public prospect agent cannot make that lifecycle change', 'public_lifecycle_transition_denied');
    }
    if (target === LIFECYCLE_STATES.ACCEPTED && (!organisation.commercialAcceptance || organisation.commercialAcceptance.status !== 'verified')) {
        throw modelError(409, 'Verified commercial acceptance is required', 'commercial_acceptance_required');
    }
    if (target === LIFECYCLE_STATES.ONBOARDING) {
        const gates = organisation.onboarding && organisation.onboarding.gates || [];
        const authority = gates.find((gate) => gate.id === 'authority');
        if (!organisation.onboarding.planId || !authority || authority.status !== 'complete') {
            throw modelError(409, 'A governed onboarding plan with verified authority is required', 'onboarding_plan_required');
        }
    }
    if (target === LIFECYCLE_STATES.ACTIVE) {
        const gates = organisation.onboarding && organisation.onboarding.gates || [];
        const activation = (organisation.activationRequests || []).find((item) => item.id === organisation.onboarding.activationRequestId);
        if (gates.length !== 6 || !gates.every((gate) => gate.status === 'complete') || !activation || activation.status !== 'consumed') {
            throw modelError(409, 'A consumed dual-control activation is required', 'activation_approval_required');
        }
    }
    organisation.lifecycleState = target;
    if (target === LIFECYCLE_STATES.DISCOVERY) {
        organisation.discovery.status = 'collecting';
    }
    if (target === LIFECYCLE_STATES.SCOPING) {
        organisation.scope.status = 'ready';
    }
    if (target === LIFECYCLE_STATES.ONBOARDING) {
        organisation.onboarding.status = 'ready';
        organisation.serviceStatus = Object.assign(createEmptyServiceStatus(), organisation.serviceStatus, {
            state: 'onboarding',
            source: 'lifecycle',
            effectiveAt: options.at || new Date().toISOString(),
            changedBy: cleanText(options.actorId || 'system', 180)
        });
    }
    if (target === LIFECYCLE_STATES.ACTIVE) {
        organisation.recordType = 'customer';
        organisation.serviceStatus = Object.assign(createEmptyServiceStatus(), organisation.serviceStatus, {
            state: 'active',
            source: 'lifecycle',
            effectiveAt: options.at || new Date().toISOString(),
            changedBy: cleanText(options.actorId || 'system', 180)
        });
    }
    organisation.updatedAt = options.at || new Date().toISOString();
    organisation.updatedBy = cleanText(options.actorId || 'system', 180);
    return organisation;
}

function buildContextSnapshot(organisation) {
    const normalised = normaliseOrganisation(organisation);
    return {
        organisationId: normalised.id,
        displayName: normalised.displayName,
        recordType: normalised.recordType,
        lifecycleState: normalised.lifecycleState,
        context: normalised.context,
        fieldStates: normalised.fieldStates,
        discovery: {
            status: normalised.discovery.status,
            notes: normalised.discovery.notes,
            summary: normalised.discovery.summary,
            missingFields: normalised.discovery.missingFields,
            completedAt: normalised.discovery.completedAt
        },
        scope: normalised.scope,
        onboarding: normalised.onboarding,
        support: normalised.support,
        nextAction: normalised.nextAction,
        links: normalised.links,
        commercialAcceptance: normalised.commercialAcceptance,
        customerMaster: normalised.customerMaster,
        customerMasterHistory: normalised.customerMasterHistory,
        serviceStatus: normalised.serviceStatus,
        supportProfile: normalised.supportProfile,
        supportProfileHistory: normalised.supportProfileHistory,
        activationRequests: normalised.activationRequests,
        proofPeriods: normalised.proofPeriods,
        integrations: normalised.integrations,
        updatedAt: normalised.updatedAt
    };
}

function normaliseCustomerMasterHistory(value) {
    return (Array.isArray(value) ? value : []).slice(-100).map((item) => {
        const source = item && typeof item === 'object' ? item : {};
        const changedAt = normaliseIsoDate(source.changedAt);
        return {
            revision: normaliseHistoryRevision(source.revision),
            changedAt,
            changedBy: cleanText(source.changedBy, 180),
            reason: cleanText(source.reason, 500),
            evidenceRef: cleanText(source.evidenceRef, 500),
            snapshot: normaliseCustomerMaster(source.snapshot, changedAt || new Date().toISOString())
        };
    }).filter((item) => item.revision > 0 && item.changedAt && item.evidenceRef);
}

function normaliseSupportProfileHistory(value) {
    return (Array.isArray(value) ? value : []).slice(-100).map((item) => {
        const source = item && typeof item === 'object' ? item : {};
        return {
            revision: normaliseHistoryRevision(source.revision),
            changedAt: normaliseIsoDate(source.changedAt),
            changedBy: cleanText(source.changedBy, 180),
            reason: cleanText(source.reason, 500),
            evidenceRef: cleanText(source.evidenceRef, 500),
            snapshot: normaliseSupportProfile(source.snapshot)
        };
    }).filter((item) => item.revision > 0 && item.changedAt && item.evidenceRef);
}

function normaliseHistoryRevision(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
}

function discoveryMissingFields(organisation) {
    const context = organisation.context || createEmptyContext();
    const fieldStates = organisation.fieldStates || {};
    return CONTEXT_FIELDS
        .filter((definition) => definition.discoveryRequired)
        .filter((definition) => {
            const state = fieldStates[definition.path];
            const value = contextValue(context, definition.path);
            return !state || state.status !== 'known' || value == null || value === '' || value === 'unknown' || (Array.isArray(value) && !value.length);
        })
        .map((definition) => ({ field: definition.path, label: definition.label, status: 'unknown' }));
}

function operatorExceptions(organisation, conversations = []) {
    const exceptions = [];
    const related = conversations.filter((conversation) => conversation.organisationId === organisation.id);
    const latestConversation = related.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (latestConversation && latestConversation.escalation && latestConversation.escalation.required) {
        exceptions.push(exception('human_contact', 'Human contact requested', latestConversation.escalation.reason || 'The prospect asked for human follow-up', 'high'));
    }
    if (organisation.nextAction && organisation.nextAction.status === 'open' && organisation.nextAction.dueAt) {
        const due = Date.parse(organisation.nextAction.dueAt);
        if (Number.isFinite(due) && due < Date.now()) {
            exceptions.push(exception('overdue_next_action', 'Next action is overdue', organisation.nextAction.detail, 'high'));
        }
    }
    if (organisation.lifecycleState === LIFECYCLE_STATES.DISCOVERY && organisation.discovery.missingFields.length) {
        exceptions.push(exception(
            'discovery_gaps',
            `${organisation.discovery.missingFields.length} discovery gaps`,
            organisation.discovery.missingFields.slice(0, 3).map((item) => item.label).join(', '),
            'medium'
        ));
    }
    if (latestConversation && Number(latestConversation.ai && latestConversation.ai.confidence || 1) < 0.6) {
        exceptions.push(exception('low_ai_confidence', 'Low AI confidence', 'Review the latest discovery summary', 'medium'));
    }
    const dattoRmm = organisation.integrations && organisation.integrations.dattoRmm;
    if (dattoRmm && dattoRmm.status === 'linked') {
        if (dattoRmm.reconciliationStatus === 'review_required') {
            exceptions.push(exception(
                'datto_device_count_mismatch',
                'Datto device count needs review',
                `${dattoRmm.deviceCount} Datto devices do not match the ${dattoRmm.expectedDeviceCount} expected endpoints`,
                'medium'
            ));
        }
        if (Number(dattoRmm.openAlertCount || 0) > 0) {
            exceptions.push(exception(
                'datto_open_alerts',
                `${dattoRmm.openAlertCount} Datto alerts open`,
                `Review open alerts for ${dattoRmm.siteName || organisation.displayName}`,
                'medium'
            ));
        }
    }
    const latestTicketEvents = new Map();
    for (const event of organisation.support && organisation.support.evidence || []) {
        if (event.simulated) continue;
        const current = latestTicketEvents.get(event.ticketId);
        if (!current || String(event.occurredAt).localeCompare(String(current.occurredAt)) >= 0) {
            latestTicketEvents.set(event.ticketId, event);
        }
    }
    for (const event of latestTicketEvents.values()) {
        if (!event.requiresAttention) continue;
        const approval = event.type === 'recommendation_created';
        exceptions.push(exception(
            approval ? 'service_approval_required' : 'service_ticket_needs_attention',
            approval ? 'Service action needs approval' : 'Service ticket needs attention',
            event.summary || event.ticketId,
            'high'
        ));
    }
    return exceptions.map((item) => Object.assign({ organisationId: organisation.id, organisationName: organisation.displayName }, item));
}

function exception(code, title, detail, priority) {
    return { code, title, detail: cleanText(detail, 500), priority };
}

function normaliseFactValue(definition, value) {
    if (definition.type === 'number') {
        const match = String(value == null ? '' : value).replace(/,/g, '').match(/\d+/);
        if (!match) return null;
        const number = Number(match[0]);
        return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
    }
    if (definition.type === 'list') {
        const list = Array.isArray(value) ? value : String(value || '').split(/\||;|\n/);
        return cleanStringList(list, 40, 240);
    }
    if (definition.type === 'email') {
        const email = cleanText(value, 254).toLowerCase();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    }
    if (definition.type === 'platform') {
        return normaliseChoice(value, ['microsoft_365', 'google_workspace', 'mixed', 'other']);
    }
    if (definition.type === 'providerModel') {
        return normaliseChoice(value, ['managed_provider', 'internal', 'hybrid', 'none']);
    }
    if (definition.type === 'internalIt') {
        return normaliseChoice(value, ['none', 'part_time', 'full_time', 'team']);
    }
    if (definition.type === 'timing') {
        const text = cleanText(value, 2000);
        const timing = text.match(/\b(asap|immediately|this month|next month|this quarter|next quarter|within \d+ (?:days?|weeks?|months?))\b/i);
        return timing ? timing[1].toLowerCase() : text;
    }
    return cleanText(value, 2000);
}

function normaliseChoice(value, allowed) {
    const choice = String(value || '').trim().toLowerCase();
    return allowed.includes(choice) ? choice : null;
}

function contextValue(context, path) {
    return path.split('.').reduce((value, segment) => value && value[segment], context);
}

function setContextValue(context, path, value) {
    const segments = path.split('.');
    let cursor = context;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!cursor[segment] || typeof cursor[segment] !== 'object') {
            cursor[segment] = {};
        }
        cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
}

function normaliseLifecycleState(value) {
    return LIFECYCLE_ORDER.includes(value) ? value : LIFECYCLE_STATES.PROSPECT;
}

function cleanStringList(value, maxItems, maxLength) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean)))
        .slice(0, maxItems);
}

function createEmptyIntegrations() {
    return {
        dattoRmm: {
            status: 'not_connected',
            mode: 'readonly',
            siteUid: '',
            siteName: '',
            deviceCount: null,
            expectedDeviceCount: null,
            openAlertCount: null,
            reconciliationStatus: 'not_started',
            capturedAt: '',
            freshUntil: '',
            snapshotId: '',
            snapshotSha256: '',
            truncated: false,
            devices: [],
            provisioning: {
                state: 'idle',
                claimId: '',
                keyHash: '',
                siteName: '',
                siteNameKey: '',
                leaseUntil: '',
                startedAt: '',
                startedBy: '',
                completedAt: '',
                completedBy: ''
            },
            lastSyncedAt: '',
            lastSyncedBy: ''
        }
    };
}

function normaliseDattoRmmIntegration(value) {
    const source = value && typeof value === 'object' ? value : {};
    const empty = createEmptyIntegrations().dattoRmm;
    return {
        status: ['not_connected', 'linked', 'error'].includes(source.status) ? source.status : empty.status,
        mode: ['readonly', 'controlled_write'].includes(source.mode) ? source.mode : empty.mode,
        siteUid: cleanText(source.siteUid, 180),
        siteName: cleanText(source.siteName, 300),
        deviceCount: normaliseCount(source.deviceCount),
        expectedDeviceCount: normaliseCount(source.expectedDeviceCount),
        openAlertCount: normaliseCount(source.openAlertCount),
        reconciliationStatus: ['not_started', 'baseline_missing', 'matched', 'review_required'].includes(source.reconciliationStatus)
            ? source.reconciliationStatus
            : empty.reconciliationStatus,
        capturedAt: normaliseIsoDate(source.capturedAt),
        freshUntil: normaliseIsoDate(source.freshUntil),
        snapshotId: cleanText(source.snapshotId, 180),
        snapshotSha256: /^[a-f0-9]{64}$/.test(String(source.snapshotSha256 || '').toLowerCase())
            ? String(source.snapshotSha256).toLowerCase()
            : '',
        truncated: source.truncated === true,
        devices: (Array.isArray(source.devices) ? source.devices : []).slice(0, 2500).map((item) => ({
            uid: cleanText(item && (item.uid || item.deviceUid), 180),
            hostname: cleanText(item && item.hostname, 240),
            operatingSystem: cleanText(item && (item.operatingSystem || item.os), 240),
            lastSeen: normaliseIsoDate(item && item.lastSeen),
            online: item && item.online === true
        })).filter((item) => item.uid),
        provisioning: normaliseDattoRmmProvisioning(source.provisioning),
        lastSyncedAt: normaliseIsoDate(source.lastSyncedAt),
        lastSyncedBy: cleanText(source.lastSyncedBy, 180)
    };
}

function normaliseDattoRmmProvisioning(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        state: ['idle', 'preparing', 'prepared', 'failed'].includes(source.state) ? source.state : 'idle',
        claimId: cleanText(source.claimId, 180),
        keyHash: /^[a-f0-9]{64}$/.test(String(source.keyHash || '').toLowerCase())
            ? String(source.keyHash).toLowerCase()
            : '',
        siteName: cleanText(source.siteName, 300),
        siteNameKey: cleanText(source.siteNameKey, 300).toLocaleLowerCase('en-NZ').replace(/\s+/g, ' '),
        leaseUntil: normaliseIsoDate(source.leaseUntil),
        startedAt: normaliseIsoDate(source.startedAt),
        startedBy: cleanText(source.startedBy, 180),
        completedAt: normaliseIsoDate(source.completedAt),
        completedBy: cleanText(source.completedBy, 180)
    };
}

function normaliseCount(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
}

function normaliseIsoDate(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function normaliseSupportEvidenceEvent(value) {
    const source = value && typeof value === 'object' ? value : {};
    const type = SUPPORT_EVIDENCE_TYPES.includes(source.type) ? source.type : '';
    const ticketId = cleanText(source.ticketId, 180);
    const occurredAtTime = Date.parse(String(source.occurredAt || ''));
    if (!type || !ticketId || !Number.isFinite(occurredAtTime)) return null;
    return {
        id: cleanText(source.id, 220) || `service_desk:${ticketId}:${type}`,
        type,
        ticketId,
        category: cleanText(source.category, 120),
        summary: cleanText(source.summary, 500),
        outcome: cleanText(source.outcome, 120),
        occurredAt: new Date(occurredAtTime).toISOString(),
        source: cleanText(source.source || 'service_desk', 80),
        simulated: source.simulated === true,
        requiresAttention: source.requiresAttention === true,
        remediation: source.remediation === true
    };
}

function createEmptyScopingDeletionFence() {
    return {
        claimId: '',
        generation: 0,
        status: 'none',
        salesCustomerId: '',
        assessmentId: '',
        leaseUntil: '',
        unlinkedAt: '',
        unlinkedBy: '',
        compensatedAt: '',
        compensatedBy: '',
        completedAt: '',
        completedBy: ''
    };
}

function normaliseScopingDeletionFence(value) {
    const source = value && typeof value === 'object' ? value : {};
    const generation = Number(source.generation || 0);
    return {
        claimId: cleanText(source.claimId, 180),
        generation: Number.isInteger(generation) && generation >= 0 ? generation : 0,
        status: ['none', 'unlinked', 'compensated', 'completed'].includes(source.status)
            ? source.status
            : 'none',
        salesCustomerId: cleanText(source.salesCustomerId, 180),
        assessmentId: cleanText(source.assessmentId, 180),
        leaseUntil: normaliseIsoDate(source.leaseUntil),
        unlinkedAt: normaliseIsoDate(source.unlinkedAt),
        unlinkedBy: cleanText(source.unlinkedBy, 180),
        compensatedAt: normaliseIsoDate(source.compensatedAt),
        compensatedBy: cleanText(source.compensatedBy, 180),
        completedAt: normaliseIsoDate(source.completedAt),
        completedBy: cleanText(source.completedBy, 180)
    };
}

function normaliseScopingDeletionReceipts(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
        const source = item && typeof item === 'object' ? item : {};
        const generation = Number(source.generation || 0);
        return {
            claimId: cleanText(source.claimId, 180),
            generation: Number.isInteger(generation) && generation > 0 ? generation : 0,
            salesCustomerId: cleanText(source.salesCustomerId, 180),
            assessmentId: cleanText(source.assessmentId, 180),
            completedAt: normaliseIsoDate(source.completedAt),
            completedBy: cleanText(source.completedBy, 180)
        };
    }).filter((item) => (
        item.claimId &&
        item.generation > 0 &&
        item.salesCustomerId &&
        item.assessmentId &&
        item.completedAt
    ));
}

function normaliseOnboardingDevices(value) {
    return (Array.isArray(value) ? value : []).slice(0, 50).map((item) => {
        const source = item && typeof item === 'object' ? item : {};
        const label = cleanText(source.label, 180);
        if (!label) return null;
        const platform = ONBOARDING_DEVICE_PLATFORMS.includes(source.platform) ? source.platform : 'other';
        const status = ONBOARDING_DEVICE_STATUSES.includes(source.status) ? source.status : 'planned';
        return {
            id: cleanText(source.id, 180) || createId('onboarding_device'),
            label,
            platform,
            status,
            owner: cleanText(source.owner, 180),
            notes: cleanText(source.notes, 500),
            providerRefs: (Array.isArray(source.providerRefs) ? source.providerRefs : []).slice(0, 10).map((ref) => ({
                system: ['datto_rmm', 'kaseya_mdr', 'backup'].includes(ref && ref.system) ? ref.system : '',
                externalId: cleanText(ref && ref.externalId, 180)
            })).filter((ref) => ref.system && ref.externalId),
            matchStatus: ['unmatched', 'suggested', 'confirmed', 'conflict'].includes(source.matchStatus)
                ? source.matchStatus
                : 'unmatched',
            matchedAt: normaliseIsoDate(source.matchedAt),
            matchedBy: cleanText(source.matchedBy, 180),
            lastObservedAt: normaliseIsoDate(source.lastObservedAt),
            sourceSnapshotId: cleanText(source.sourceSnapshotId, 180),
            updatedAt: normaliseIsoDate(source.updatedAt),
            updatedBy: cleanText(source.updatedBy, 180)
        };
    }).filter(Boolean);
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function deepMerge(target, source) {
    const output = Array.isArray(target) ? target.slice() : Object.assign({}, target);
    Object.entries(source || {}).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            output[key] = value.slice();
        } else if (value && typeof value === 'object') {
            output[key] = deepMerge(output[key] && typeof output[key] === 'object' ? output[key] : {}, value);
        } else {
            output[key] = value;
        }
    });
    return output;
}

function modelError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = { code };
    return error;
}

function createId(prefix) {
    return `${prefix}_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
}

module.exports = {
    CONTEXT_FIELDS,
    CONTEXT_FIELD_MAP,
    LIFECYCLE_ORDER,
    LIFECYCLE_STATES,
    SUPPORT_EVIDENCE_TYPES,
    applyContextFacts,
    buildContextSnapshot,
    cleanText,
    createEmptyContext,
    createFieldStates,
    createId,
    createOrganisation,
    discoveryMissingFields,
    normaliseOrganisation,
    normaliseOnboardingDevices,
    normaliseSupportEvidenceEvent,
    operatorExceptions,
    transitionLifecycle
};
