const {
    LIFECYCLE_ORDER,
    LIFECYCLE_STATES,
    applyContextFacts,
    buildContextSnapshot,
    cleanText,
    createId,
    createOrganisation: createLifecycleOrganisation,
    normaliseOnboardingDevices,
    normaliseSupportEvidenceEvent,
    operatorExceptions,
    transitionLifecycle
} = require('./lifecycleModel');
const { LifecycleRepositoryError } = require('./lifecycleRepository');
const {
    GATE_IDS,
    MAX_CUSTOMER_MASTER_ENTITLEMENTS,
    MAX_PROOF_EVIDENCE_PER_PERIOD,
    PROOF_PERIOD_CLOSE_TOLERANCE_MS,
    PROOF_SOURCES,
    actorFromAccess,
    buildOnboardingPlan,
    buildProofNarrativeGroundwork,
    canonicalHash,
    cleanEvidenceReference,
    cleanIdempotencyKey,
    createEmptyCustomerMaster,
    evaluateOnboarding,
    externalReferenceKey,
    governedProofPeriods,
    normaliseExternalReference,
    normaliseCustomerMaster,
    normaliseProofEvidence,
    normaliseProofPeriods,
    normaliseProofRequirementLedger,
    normaliseSupportProfile,
    parseProofPeriod,
    proofReadiness,
    proofEvidenceContainsSensitiveData,
    proofEvidenceFingerprint,
    proofEvidenceStableId,
    proofPeriodBounds,
    proofPeriodWriteBoundary,
    requiredProofSourcesForEntitlements,
    resolveProofRequirementsForEntitlements,
    resolveProofRequirementsForPeriod,
    sameActor
} = require('./customerOperations');

const MAX_MESSAGES_PER_CONVERSATION = 80;
const DISCOVERY_SCOPING_TASK = 'discovery_scoping_review';
const PROSPECT_SECURITY_COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROSPECT_SECURITY_IDENTITY_DAILY_MAX = 2;
const PROSPECT_SECURITY_TENANT_DAILY_MAX = 100;
const MAX_SYNCHRONOUS_AUDIT_EXPORT_EVENTS = 5000;
const MAX_SYNCHRONOUS_AUDIT_EXPORT_BYTES = 4 * 1024 * 1024;
const MAX_SYNCHRONOUS_AUDIT_EXPORT_PAGES = 10;
const MAX_SYNCHRONOUS_AUDIT_EXPORT_MS = 10000;
const DATTO_PROVISIONING_LEASE_MS = 5 * 60 * 1000;

function createLifecycleService(options = {}) {
    const repository = options.repository;
    if (!repository) {
        throw new Error('A lifecycle repository is required');
    }
    const now = options.now || (() => new Date());
    const makeId = options.createId || createId;
    const approvedProposalVerifier = options.approvedProposalVerifier || null;
    const retentionPolicy = resolveRetentionPolicy(options.env || process.env);
    const publicUrl = cleanText((options.env || process.env).NOFRIES_PUBLIC_URL || 'https://nofries.nz', 500).replace(/\/$/, '');

    async function readReconciledState(access) {
        let state = await repository.read(access);
        const candidates = discoveryHandoffCandidates(state);
        if (!candidates.length) return state;
        const auditEvents = [];
        try {
            const reconciled = await repository.mutate(access, {
                expectedRevision: state.revision,
                auditEvents
            }, async (current) => {
                discoveryHandoffCandidates(current).forEach(({ organisation, conversation }) => {
                    ensureDiscoveryScopingTask(current, organisation, conversation, {
                        makeId,
                        at: now().toISOString(),
                        auditEvents,
                        backfilled: true
                    });
                });
            });
            return reconciled.state;
        } catch (error) {
            if (!(error instanceof LifecycleRepositoryError) || error.details.code !== 'revision_conflict') throw error;
            return repository.read(access);
        }
    }

    return {
        async bootstrap(access) {
            const state = await readReconciledState(access);
            return buildOperatorBootstrap(state, access, now());
        },

        async searchAgentContext(access, query = '') {
            const state = await repository.read(access);
            return searchAgentDocuments(state, query, publicUrl);
        },

        async fetchAgentContext(access, id) {
            const state = await repository.read(access);
            return fetchAgentDocument(state, id, publicUrl);
        },

        async listOrganisations(access) {
            const state = await repository.read(access);
            return {
                revision: state.revision,
                organisations: state.organisations.map((organisation) => operatorOrganisation(organisation, state))
            };
        },

        async listServiceDeskCustomers(access) {
            const state = await repository.read(access);
            const candidates = state.organisations
                .filter((organisation) => organisation.recordType === 'customer')
                .map((organisation) => serviceDeskCustomerReadiness(organisation, now()));
            const customers = candidates
                .filter((candidate) => candidate.readiness.eligible)
                .map((candidate) => candidate.customer);
            return {
                revision: state.revision,
                customers,
                readiness: {
                    eligible: customers.length > 0,
                    eligibleCustomerCount: customers.length,
                    blockedCustomerCount: candidates.length - customers.length,
                    requirements: [
                        'Customer is active',
                        'Customer set-up is complete',
                        'Every planned computer is verified and identity-matched',
                        'Signed SLA and authorised requesters are current',
                        'RMM evidence is fresh and reconciled'
                    ]
                }
            };
        },

        async requireServiceDeskCustomer(access, customerId, admission = {}) {
            const state = await repository.read(access);
            const organisation = findLinkedOrganisation(state, customerId, false);
            if (!organisation) {
                throw lifecycleError(404, 'Service-desk customer not found', 'service_desk_customer_not_found');
            }
            const candidate = serviceDeskCustomerReadiness(organisation, now());
            if (!candidate.readiness.eligible) {
                throw new LifecycleRepositoryError(
                    409,
                    'Finish customer set-up before opening a service-desk ticket',
                    {
                        code: 'customer_setup_incomplete',
                        customerId: organisation.id,
                        missing: candidate.readiness.missing
                    }
                );
            }
            const requesterEmail = cleanText(admission.requesterEmail, 254).toLowerCase();
            if (requesterEmail) {
                const supportProfile = normaliseSupportProfile(organisation.supportProfile);
                const intakeChannel = cleanText(admission.intakeChannel || 'portal', 40);
                if (!supportProfile.channels.includes(intakeChannel)) {
                    throw lifecycleError(409, 'The requested intake channel is not in the signed support schedule', 'support_intake_channel_not_authorised');
                }
                const atTime = now().getTime();
                const requester = supportProfile.authorisedRequesters.find((item) => (
                    item.email === requesterEmail &&
                    (!item.effectiveFrom || Date.parse(item.effectiveFrom) <= atTime) &&
                    (!item.effectiveTo || Date.parse(item.effectiveTo) > atTime)
                ));
                if (!requester) {
                    throw lifecycleError(403, 'The requester is not authorised for this customer', 'support_requester_not_authorised');
                }
                if (!cleanText(admission.requesterVerificationMethod, 120) || !cleanEvidenceReference(admission.requesterVerificationRef)) {
                    throw lifecycleError(400, 'Record how the requester identity was verified', 'support_requester_verification_required');
                }
            }
            return candidate.customer;
        },

        async getOrganisation(access, organisationId) {
            const state = await repository.read(access);
            const organisation = findOrganisation(state, organisationId);
            return {
                revision: state.revision,
                organisation: operatorOrganisation(organisation, state),
                conversations: state.conversations
                    .filter((conversation) => conversation.organisationId === organisation.id)
                    .map(publicConversation),
                activity: state.audit
                    .filter((event) => event.organisationId === organisation.id)
                    .slice(-100)
                    .reverse()
            };
        },

        async exportOrganisation(access, organisationId) {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const state = await repository.read(access);
                const organisation = findOrganisation(state, organisationId);
                let activity;
                try {
                    activity = await readCompleteOrganisationAudit(
                        repository,
                        access,
                        organisation.id,
                        state.audit,
                        state.revision
                    );
                } catch (error) {
                    if (
                        attempt < 2 && error instanceof LifecycleRepositoryError &&
                        error.details && error.details.code === 'revision_conflict'
                    ) continue;
                    throw error;
                }
                return {
                    exportVersion: 2,
                    exportedAt: now().toISOString(),
                    tenant: {
                        id: state.tenant.id,
                        name: state.tenant.name
                    },
                    organisation: buildContextSnapshot(organisation),
                    conversations: state.conversations
                        .filter((conversation) => conversation.organisationId === organisation.id)
                        .map(publicConversation),
                    activity,
                    aiActivity: state.observability.filter((event) => event.organisationId === organisation.id),
                    operatorCorrections: state.operatorCorrections.filter((event) => event.organisationId === organisation.id),
                    operatorTasks: state.operatorTasks
                        .filter((task) => task.organisationId === organisation.id)
                        .map(publicOperatorTask)
                };
            }
            throw lifecycleError(409, 'Lifecycle data changed during export; retry', 'revision_conflict');
        },

        async deleteOrganisation(access, organisationId, input = {}) {
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (cleanText(input.confirmName, 180) !== organisation.displayName) {
                    throw lifecycleError(400, 'Type the exact organisation name to confirm deletion', 'deletion_confirmation_required');
                }
                const deletionFence = currentScopingDeletionFence(organisation);
                if (!['none', 'completed'].includes(deletionFence.status)) {
                    throw lifecycleError(
                        409,
                        'This lifecycle record is participating in a fenced Sales deletion and cannot be deleted',
                        'scoping_deletion_in_progress'
                    );
                }
                if (organisation.links.salesCustomerId || organisation.scope.salesCustomerId || organisation.scope.assessmentId) {
                    throw lifecycleError(
                        409,
                        'Delete or unlink the connected scoping customer before deleting this lifecycle record',
                        'linked_lifecycle_deletion_blocked'
                    );
                }
                if (organisation.links.dattoRmmSiteUid) {
                    throw lifecycleError(
                        409,
                        'Unlink the Datto RMM site before deleting this lifecycle record',
                        'linked_datto_rmm_deletion_blocked'
                    );
                }
                const priorLifecycleState = organisation.serviceStatus && organisation.serviceStatus.state || organisation.lifecycleState;
                if (organisation.recordType === 'customer' && priorLifecycleState !== 'former') {
                    throw lifecycleError(
                        409,
                        'Complete controlled offboarding before deleting a customer lifecycle record',
                        'customer_deletion_offboarding_required'
                    );
                }
                if (organisation.links.serviceDeskCustomerId) {
                    throw lifecycleError(
                        409,
                        'Unlink the service-desk customer before deleting this lifecycle record',
                        'linked_service_desk_deletion_blocked'
                    );
                }
                const activeExternalReferences = organisation.recordType === 'customer'
                    ? (organisation.customerMaster && organisation.customerMaster.externalRefs || [])
                        .filter((reference) => reference && reference.status !== 'retired')
                    : [];
                if (activeExternalReferences.length) {
                    throw lifecycleError(
                        409,
                        'Retire every active external customer reference before deletion',
                        'active_external_reference_deletion_blocked',
                        { activeReferenceCount: activeExternalReferences.length }
                    );
                }
                const removedScheduleCount = state.schedules
                    .filter((item) => item.organisationId === organisationId)
                    .length;
                state.organisations = state.organisations.filter((item) => item.id !== organisationId);
                state.conversations = state.conversations.filter((item) => item.organisationId !== organisationId);
                state.approvals = state.approvals.filter((item) => item.organisationId !== organisationId);
                state.operatorTasks = state.operatorTasks.filter((item) => item.organisationId !== organisationId);
                state.schedules = state.schedules.filter((item) => item.organisationId !== organisationId);
                state.observability = state.observability.filter((item) => item.organisationId !== organisationId);
                state.operatorCorrections = state.operatorCorrections.filter((item) => item.organisationId !== organisationId);
                auditEvents.push({
                    actorType: 'user',
                    actorId: access.user.email,
                    actorRole: access.user.role,
                    action: 'organisation.deleted',
                    targetType: 'organisation',
                    targetId: organisationId,
                    summary: 'Lifecycle organisation and associated prospect data deleted',
                    details: {
                        priorLifecycleState,
                        removedScheduleCount,
                        historicalControlRunsRetained: true,
                        historicalDeadLettersRetained: true
                    }
                });
                return { organisationId, displayName: organisation.displayName };
            });
            return {
                revision: result.state.revision,
                deleted: true,
                organisationId: result.result.organisationId
            };
        },

        async previewRetention(access) {
            const state = await repository.read(access);
            return retentionPreview(state, retentionPolicy, now());
        },

        async runRetention(access, input = {}) {
            if (input.confirmation !== 'PURGE EXPIRED PROSPECT DATA') {
                throw lifecycleError(400, 'Type the retention confirmation phrase exactly', 'retention_confirmation_required');
            }
            const auditEvents = [];
            const runAt = now();
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const preview = retentionPreview(state, retentionPolicy, runAt);
                const organisationIds = new Set(preview.expiredOrganisations.map((item) => item.organisationId));
                const conversationIds = new Set(state.conversations
                    .filter((conversation) => organisationIds.has(conversation.organisationId))
                    .map((conversation) => conversation.id));
                const rawMessageCutoff = Date.parse(preview.cutoffs.rawMessagesBefore);
                const observabilityCutoff = Date.parse(preview.cutoffs.observabilityBefore);
                const prospectSecurityCutoff = Date.parse(preview.cutoffs.prospectSecurityBefore);

                state.conversations.forEach((conversation) => {
                    if (organisationIds.has(conversation.organisationId)) return;
                    if (conversation.escalation && conversation.escalation.required) return;
                    conversation.messages = conversation.messages.filter((message) => Date.parse(message.at) >= rawMessageCutoff);
                });
                state.organisations = state.organisations.filter((item) => !organisationIds.has(item.id));
                state.conversations = state.conversations.filter((item) => !organisationIds.has(item.organisationId));
                state.approvals = state.approvals.filter((item) => !organisationIds.has(item.organisationId));
                state.operatorTasks = state.operatorTasks.filter((item) => !organisationIds.has(item.organisationId));
                state.operatorCorrections = state.operatorCorrections.filter((item) => !organisationIds.has(item.organisationId));
                state.observability = state.observability.filter((item) => (
                    !organisationIds.has(item.organisationId) && Date.parse(item.at) >= observabilityCutoff
                ));
                state.prospectSecurityEvents = (state.prospectSecurityEvents || []).filter((item) => (
                    Date.parse(item.createdAt) >= prospectSecurityCutoff && Date.parse(item.expiresAt) > runAt.getTime()
                ));
                auditEvents.push({
                    actorType: 'system',
                    actorId: access.user.email,
                    actorRole: access.user.role,
                    action: 'retention.executed',
                    targetType: 'tenant',
                    targetId: access.tenant.key,
                    summary: `${preview.expiredOrganisations.length} expired prospect records and ${preview.expiredRawMessageCount} raw messages processed`,
                    details: {
                        expiredOrganisationCount: preview.expiredOrganisations.length,
                        expiredRawMessageCount: preview.expiredRawMessageCount,
                        expiredObservabilityCount: preview.expiredObservabilityCount,
                        expiredProspectSecurityEventCount: preview.expiredProspectSecurityEventCount
                    }
                });
                return preview;
            });
            return {
                revision: result.state.revision,
                executed: true,
                result: result.result
            };
        },

        async createOrganisation(access, input = {}) {
            if (input.recordType !== undefined && input.recordType !== 'prospect') {
                throw lifecycleError(409, 'Create customers through the approved customer set-up flow', 'dedicated_flow_required');
            }
            if (input.lifecycleState !== undefined && input.lifecycleState !== LIFECYCLE_STATES.PROSPECT) {
                throw lifecycleError(409, 'Advance lifecycle stages through their dedicated flows', 'dedicated_flow_required');
            }
            const auditEvents = [];
            const createdAt = now().toISOString();
            const organisation = createLifecycleOrganisation({
                id: makeId('organisation'),
                displayName: input.displayName,
                recordType: input.recordType,
                lifecycleState: input.lifecycleState,
                sourceChannel: input.sourceChannel || 'operator',
                actorId: access.user.email,
                now: createdAt
            });
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                state.organisations.push(organisation);
                if (Array.isArray(input.facts)) {
                    applyContextFacts(organisation, input.facts, {
                        actorId: access.user.email,
                        source: 'operator',
                        at: createdAt
                    });
                }
                auditEvents.push(audit(access, 'organisation.created', organisation, 'Lifecycle organisation created'));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async createInternalPilotCustomer(access, input = {}) {
            if (input.confirmInternalPilot !== true) {
                throw lifecycleError(400, 'Confirm that this is an isolated No Fries-owned internal pilot', 'internal_pilot_confirmation_required');
            }
            const displayName = cleanText(input.displayName, 180);
            if (!displayName) {
                throw lifecycleError(400, 'Customer name is required', 'customer_name_required');
            }
            const expectedUsers = normalisePilotCount(input.expectedUsers, 'expected_users_invalid');
            const expectedEndpoints = normalisePilotCount(input.expectedEndpoints, 'expected_endpoints_invalid');
            const submittedDevices = Array.isArray(input.devices) ? input.devices : [];
            const hasUnsupportedPlatform = submittedDevices.some((device) => (
                !['windows', 'macos', 'linux'].includes(cleanText(device && device.platform, 80))
            ));
            if (hasUnsupportedPlatform) {
                throw lifecycleError(
                    400,
                    'Internal-pilot computers must use windows, macos or linux',
                    'pilot_device_platform_unsupported'
                );
            }
            const devices = normaliseOnboardingDevices(submittedDevices);
            const submittedDeviceIds = submittedDevices
                .map((device) => cleanText(device && device.id, 180).toLowerCase())
                .filter(Boolean);
            if (!devices.length || devices.length > expectedEndpoints || submittedDeviceIds.length !== devices.length) {
                throw lifecycleError(
                    400,
                    'Provide between one and the expected computer total as named representative pilot devices',
                    'pilot_device_plan_mismatch',
                    { expectedEndpoints, submittedDeviceCount: submittedDeviceIds.length, validDeviceCount: devices.length }
                );
            }
            if (new Set(submittedDeviceIds).size !== submittedDeviceIds.length) {
                throw lifecycleError(400, 'Internal-pilot computers must have unique IDs', 'pilot_device_ids_not_unique');
            }
            const primaryEmail = cleanText(input.primaryEmail || access.user.email, 254).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primaryEmail)) {
                throw lifecycleError(400, 'A valid primary contact email is required', 'primary_email_invalid');
            }
            const createdAt = now().toISOString();
            const organisation = createLifecycleOrganisation({
                id: makeId('organisation'),
                displayName,
                sourceChannel: 'operator_internal_pilot',
                actorId: access.user.email,
                now: createdAt
            });
            const facts = [
                fact('company.name', displayName),
                fact('company.summary', 'No Fries-owned internal customer used to validate the complete managed IT lifecycle.'),
                fact('contacts.primary.name', cleanText(input.primaryContactName || access.user.name || 'No Fries operator', 180)),
                fact('contacts.primary.email', primaryEmail),
                fact('users.estimatedCount', expectedUsers),
                fact('endpoints.estimatedCount', expectedEndpoints),
                fact('locations.items', [cleanText(input.location || displayName, 240)]),
                fact('productivity.platform', cleanText(input.productivityPlatform || 'google_workspace', 80)),
                fact('itProvider.model', 'internal'),
                fact('internalIt.capability', 'part_time'),
                fact('security.tools', ['Datto RMM trial']),
                fact('support.requirements', 'Controlled business-hours endpoint monitoring, support and monthly proof for the internal pilot.'),
                fact('support.frustrations', ['Endpoint baseline and operating evidence are not yet established']),
                fact('commercial.preferredTiming', 'immediately'),
                fact('commercial.decisionProcess', 'Owner-approved internal pilot; production customer rollout requires a separate decision.')
            ];
            applyContextFacts(organisation, facts, {
                actorId: access.user.email,
                source: 'operator_internal_pilot',
                at: createdAt
            });
            organisation.discovery.status = 'complete';
            organisation.discovery.completedAt = createdAt;
            organisation.discovery.summary = 'Internal customer facts approved by the No Fries service owner for the recorded lifecycle pilot device plan.';
            const transitions = [
                LIFECYCLE_STATES.DISCOVERY,
                LIFECYCLE_STATES.SCOPING,
                LIFECYCLE_STATES.PROPOSAL
            ];
            const transitionAudit = [];
            for (const targetState of transitions) {
                const priorState = organisation.lifecycleState;
                transitionLifecycle(organisation, targetState, { actorId: access.user.email, at: createdAt });
                transitionAudit.push({ priorState, targetState });
            }
            organisation.scope.status = 'approved';
            organisation.scope.prefillPreparedAt = createdAt;
            organisation.scope.proposalId = `internal-pilot:${organisation.id}`;
            const proposalSha256 = canonicalHash({
                proposalId: organisation.scope.proposalId,
                displayName,
                expectedUsers,
                expectedEndpoints,
                version: 'internal-pilot-v1'
            });
            organisation.commercialAcceptance = {
                id: makeId('acceptance'),
                idempotencyKey: `internal-pilot:${organisation.id}`,
                kind: 'internal_pilot',
                status: 'verified',
                source: 'internal_pilot',
                sourceEventId: '',
                proposalId: organisation.scope.proposalId,
                proposalVersion: 'internal-pilot-v1',
                proposalSha256,
                acceptedAt: createdAt,
                effectiveDate: createdAt,
                signatory: {
                    name: cleanText(input.primaryContactName || access.user.name || 'No Fries operator', 180),
                    email: primaryEmail,
                    title: 'Internal pilot owner'
                },
                authority: {
                    basis: 'No Fries-owned internal pilot confirmation',
                    evidenceId: `internal-pilot-confirmation:${organisation.id}`,
                    evidenceSha256: canonicalHash({ confirmed: true, organisationId: organisation.id, actor: access.user.email })
                },
                recordedBy: access.user.email,
                recordedAt: createdAt,
                fingerprint: proposalSha256
            };
            organisation.recordType = 'customer';
            organisation.customerMaster = internalPilotCustomerMaster({
                organisation,
                primaryEmail,
                primaryName: organisation.commercialAcceptance.signatory.name,
                expectedUsers,
                expectedEndpoints,
                plannedDeviceCount: devices.length,
                actor: access.user.email,
                at: createdAt,
                proposalSha256
            });
            organisation.supportProfile = internalPilotSupportProfile({
                primaryEmail,
                primaryName: organisation.commercialAcceptance.signatory.name,
                organisationId: organisation.id,
                at: createdAt
            });
            organisation.onboarding = buildOnboardingPlan({
                kind: 'internal_pilot',
                acceptanceId: organisation.commercialAcceptance.id,
                devices: devices.map((device) => Object.assign({}, device, {
                    status: 'planned',
                    owner: device.owner || access.user.email,
                    updatedAt: createdAt,
                    updatedBy: access.user.email
                })),
                owner: access.user.email,
                at: createdAt
            });
            reconcileProofRequirementLedger(organisation, createdAt, { initialiseFromCurrentMaster: true });
            evaluateOnboarding(organisation, createdAt);
            for (const targetState of [LIFECYCLE_STATES.ACCEPTED, LIFECYCLE_STATES.ONBOARDING]) {
                const priorState = organisation.lifecycleState;
                transitionLifecycle(organisation, targetState, { actorId: access.user.email, at: createdAt });
                transitionAudit.push({ priorState, targetState });
            }
            evaluateOnboarding(organisation, createdAt);

            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                if (state.organisations.some((item) => (
                    item.displayName.toLowerCase() === displayName.toLowerCase() ||
                    (isNoFriesHqName(item.displayName) && isNoFriesHqName(displayName))
                ))) {
                    throw lifecycleError(409, 'A lifecycle customer with this name already exists', 'pilot_customer_exists');
                }
                state.organisations.push(organisation);
                auditEvents.push(audit(access, 'organisation.created', organisation, 'Internal pilot customer created'));
                transitionAudit.forEach(({ priorState, targetState }) => auditEvents.push(audit(
                    access,
                    'lifecycle.transitioned',
                    organisation,
                    `Internal pilot moved from ${priorState} to ${targetState}`,
                    '',
                    { priorState, targetState, internalPilot: true }
                )));
                auditEvents.push(audit(
                    access,
                    'onboarding.pilot_started',
                    organisation,
                    `Internal set-up started for ${devices.length} representative computer${devices.length === 1 ? '' : 's'} with approval controls`,
                    '',
                    { expectedUsers, expectedEndpoints, plannedDeviceCount: devices.length, devicePlatforms: organisation.onboarding.devices.map((device) => device.platform) }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async bindApprovedProposal(access, organisationId, input = {}) {
            const proposalId = cleanText(input.proposalId, 180);
            const proposalVersion = cleanText(input.proposalVersion, 120);
            const proposalSha256 = normaliseSha256(input.proposalSha256);
            if (!proposalId || !proposalVersion || !proposalSha256 || input.confirmApprovedProposal !== true) {
                throw lifecycleError(
                    400,
                    'Confirm the exact sealed proposal ID, version and SHA-256',
                    'approved_proposal_binding_evidence_required'
                );
            }
            if (!approvedProposalVerifier || typeof approvedProposalVerifier.verify !== 'function') {
                throw lifecycleError(503, 'Approved proposal verification is unavailable', 'approved_proposal_verification_unavailable');
            }
            const existingState = await repository.read(access);
            const existingOrganisation = findOrganisation(existingState, organisationId);
            if (
                existingOrganisation.lifecycleState === LIFECYCLE_STATES.PROPOSAL &&
                existingOrganisation.scope.proposalId === proposalId &&
                existingOrganisation.scope.proposalVersion === proposalVersion &&
                existingOrganisation.scope.proposalSha256 === proposalSha256
            ) {
                const replayVerification = await approvedProposalVerifier.verify(access, {
                    organisationId: existingOrganisation.id,
                    salesCustomerId: existingOrganisation.scope.salesCustomerId || existingOrganisation.links.salesCustomerId,
                    assessmentId: existingOrganisation.scope.assessmentId,
                    proposalId,
                    proposalVersion,
                    proposalSha256
                });
                assertApprovedProposalVerified(replayVerification);
                return {
                    revision: existingState.revision,
                    organisation: operatorOrganisation(existingOrganisation, existingState)
                };
            }
            const verifiedSalesCustomerId = existingOrganisation.scope.salesCustomerId || existingOrganisation.links.salesCustomerId;
            const verifiedAssessmentId = existingOrganisation.scope.assessmentId;
            if (!verifiedSalesCustomerId || !verifiedAssessmentId) {
                throw lifecycleError(
                    409,
                    'Link the lifecycle record to its Sales customer and assessment before binding a proposal',
                    'scoping_records_required'
                );
            }
            const existingSnapshotBinding = existingOrganisation.scope.proposalId && {
                proposalId: existingOrganisation.scope.proposalId,
                proposalVersion: existingOrganisation.scope.proposalVersion,
                proposalSha256: existingOrganisation.scope.proposalSha256
            };
            if (existingSnapshotBinding && (
                existingSnapshotBinding.proposalId !== proposalId ||
                (existingSnapshotBinding.proposalVersion && existingSnapshotBinding.proposalVersion !== proposalVersion) ||
                (existingSnapshotBinding.proposalSha256 && existingSnapshotBinding.proposalSha256 !== proposalSha256)
            )) {
                throw lifecycleError(409, 'A different approved proposal is already bound to this lifecycle record', 'approved_proposal_binding_conflict');
            }
            if (![LIFECYCLE_STATES.SCOPING, LIFECYCLE_STATES.PROPOSAL].includes(existingOrganisation.lifecycleState)) {
                throw lifecycleError(409, 'The lifecycle record must be in scoping or proposal', 'approved_proposal_binding_state_required');
            }
            assertApprovedProposalVerified(await approvedProposalVerifier.verify(access, {
                organisationId: existingOrganisation.id,
                salesCustomerId: verifiedSalesCustomerId,
                assessmentId: verifiedAssessmentId,
                proposalId,
                proposalVersion,
                proposalSha256
            }));
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const salesCustomerId = organisation.scope.salesCustomerId || organisation.links.salesCustomerId;
                const assessmentId = organisation.scope.assessmentId;
                if (!salesCustomerId || !assessmentId) {
                    throw lifecycleError(
                        409,
                        'Link the lifecycle record to its Sales customer and assessment before binding a proposal',
                        'scoping_records_required'
                    );
                }
                if (salesCustomerId !== verifiedSalesCustomerId || assessmentId !== verifiedAssessmentId) {
                    throw lifecycleError(
                        409,
                        'Lifecycle data changed while the approved proposal was being verified. Reload and try again.',
                        'revision_conflict',
                        { currentRevision: Number(state.revision || 0) }
                    );
                }
                const existingBinding = organisation.scope.proposalId && {
                    proposalId: organisation.scope.proposalId,
                    proposalVersion: organisation.scope.proposalVersion,
                    proposalSha256: organisation.scope.proposalSha256
                };
                if (existingBinding && (
                    existingBinding.proposalId !== proposalId ||
                    (existingBinding.proposalVersion && existingBinding.proposalVersion !== proposalVersion) ||
                    (existingBinding.proposalSha256 && existingBinding.proposalSha256 !== proposalSha256)
                )) {
                    throw lifecycleError(409, 'A different approved proposal is already bound to this lifecycle record', 'approved_proposal_binding_conflict');
                }
                if (![LIFECYCLE_STATES.SCOPING, LIFECYCLE_STATES.PROPOSAL].includes(organisation.lifecycleState)) {
                    throw lifecycleError(409, 'The lifecycle record must be in scoping or proposal', 'approved_proposal_binding_state_required');
                }
                if (
                    existingBinding &&
                    organisation.lifecycleState === LIFECYCLE_STATES.PROPOSAL &&
                    existingBinding.proposalId === proposalId &&
                    existingBinding.proposalVersion === proposalVersion &&
                    existingBinding.proposalSha256 === proposalSha256
                ) return organisation;

                const priorState = organisation.lifecycleState;
                organisation.scope = Object.assign({}, organisation.scope, {
                    status: 'approved',
                    proposalId,
                    proposalVersion,
                    proposalSha256,
                    proposalBoundAt: at,
                    proposalBoundBy: access.user.email
                });
                if (organisation.lifecycleState !== LIFECYCLE_STATES.PROPOSAL) {
                    transitionLifecycle(organisation, LIFECYCLE_STATES.PROPOSAL, { actorId: access.user.email, at });
                }
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'proposal.approved_binding_recorded',
                    organisation,
                    'Lifecycle proposal stage bound to an exact immutable Sales proposal seal',
                    '',
                    {
                        priorState,
                        targetState: LIFECYCLE_STATES.PROPOSAL,
                        salesCustomerId,
                        assessmentId,
                        proposalId,
                        proposalVersion,
                        proposalSha256
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async recordCommercialAcceptance(access, organisationId, input = {}) {
            const idempotencyKey = cleanIdempotencyKey(input.idempotencyKey);
            if (!idempotencyKey) {
                throw lifecycleError(400, 'A stable idempotency key is required', 'idempotency_key_required');
            }
            if (input.confirmCustomerAuthority !== true) {
                throw lifecycleError(400, 'Confirm the customer signatory and acceptance authority', 'customer_authority_confirmation_required');
            }
            const at = now().toISOString();
            const acceptance = normaliseAcceptanceInput(input, access, at, makeId);
            const replayState = await repository.read(access);
            const replayOrganisation = findOrganisation(replayState, organisationId);
            const replayAcceptance = replayOrganisation.commercialAcceptance || {};
            if (replayAcceptance.idempotencyKey === idempotencyKey) {
                if (replayAcceptance.fingerprint !== acceptance.fingerprint) {
                    throw lifecycleError(409, 'The acceptance key is already bound to different evidence', 'acceptance_idempotency_conflict');
                }
                return {
                    revision: replayState.revision,
                    organisation: operatorOrganisation(replayOrganisation, replayState)
                };
            }
            if (replayOrganisation.lifecycleState !== LIFECYCLE_STATES.PROPOSAL) {
                throw lifecycleError(409, 'The lifecycle record must be at proposal before acceptance', 'proposal_state_required');
            }
            if (!replayOrganisation.scope.proposalId || replayOrganisation.scope.proposalId !== acceptance.proposalId) {
                throw lifecycleError(409, 'Acceptance must bind the approved proposal already linked to this record', 'approved_proposal_required');
            }
            if (
                replayOrganisation.scope.proposalVersion !== acceptance.proposalVersion ||
                replayOrganisation.scope.proposalSha256 !== acceptance.proposalSha256
            ) {
                throw lifecycleError(409, 'Acceptance must match the exact proposal version and seal already linked to this record', 'approved_proposal_required');
            }
            if (!approvedProposalVerifier || typeof approvedProposalVerifier.verify !== 'function') {
                throw lifecycleError(
                    503,
                    'Approved proposal verification is unavailable',
                    'approved_proposal_verification_unavailable'
                );
            }
            const verifiedSalesCustomerId = replayOrganisation.scope.salesCustomerId || replayOrganisation.links.salesCustomerId;
            const verifiedAssessmentId = replayOrganisation.scope.assessmentId;
            assertApprovedProposalVerified(await approvedProposalVerifier.verify(access, {
                organisationId: replayOrganisation.id,
                salesCustomerId: verifiedSalesCustomerId,
                assessmentId: verifiedAssessmentId,
                proposalId: acceptance.proposalId,
                proposalVersion: acceptance.proposalVersion,
                proposalSha256: acceptance.proposalSha256
            }));
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const existing = organisation.commercialAcceptance || {};
                if (existing.idempotencyKey === idempotencyKey) {
                    if (existing.fingerprint !== acceptance.fingerprint) {
                        throw lifecycleError(409, 'The acceptance key is already bound to different evidence', 'acceptance_idempotency_conflict');
                    }
                    return organisation;
                }
                if (existing.status === 'verified') {
                    throw lifecycleError(409, 'This customer already has a verified acceptance record', 'commercial_acceptance_exists');
                }
                if (organisation.lifecycleState !== LIFECYCLE_STATES.PROPOSAL) {
                    throw lifecycleError(409, 'The lifecycle record must be at proposal before acceptance', 'proposal_state_required');
                }
                if (!organisation.scope.proposalId || organisation.scope.proposalId !== acceptance.proposalId) {
                    throw lifecycleError(409, 'Acceptance must bind the approved proposal already linked to this record', 'approved_proposal_required');
                }
                if (
                    organisation.scope.proposalVersion !== acceptance.proposalVersion ||
                    organisation.scope.proposalSha256 !== acceptance.proposalSha256
                ) {
                    throw lifecycleError(409, 'Acceptance must match the exact proposal version and seal already linked to this record', 'approved_proposal_required');
                }
                const salesCustomerId = organisation.scope.salesCustomerId || organisation.links.salesCustomerId;
                if (salesCustomerId !== verifiedSalesCustomerId || organisation.scope.assessmentId !== verifiedAssessmentId) {
                    throw lifecycleError(
                        409,
                        'Lifecycle data changed while the approved proposal was being verified. Reload and try again.',
                        'revision_conflict',
                        { currentRevision: Number(state.revision || 0) }
                    );
                }
                organisation.commercialAcceptance = acceptance;
                organisation.recordType = 'customer';
                organisation.customerMaster.customerId = organisation.customerMaster.customerId || organisation.links.salesCustomerId || organisation.id;
                organisation.customerMaster.identity.legalName = organisation.customerMaster.identity.legalName || organisation.displayName;
                organisation.customerMaster.identity.tradingName = organisation.customerMaster.identity.tradingName || organisation.displayName;
                organisation.customerMaster.authority = {
                    authorityMatrixVersion: cleanText(input.authorityMatrixVersion || 'customer-authority-v1', 120),
                    acceptedBy: acceptance.signatory.email,
                    acceptedAt: acceptance.acceptedAt,
                    evidenceRef: acceptance.authority.evidenceId
                };
                organisation.customerMaster.updatedAt = at;
                organisation.customerMaster.revision = Number(organisation.customerMaster.revision || 0) + 1;
                const priorState = organisation.lifecycleState;
                transitionLifecycle(organisation, LIFECYCLE_STATES.ACCEPTED, { actorId: access.user.email, at });
                auditEvents.push(audit(
                    access,
                    'commercial.acceptance_recorded',
                    organisation,
                    'Customer acceptance was verified and bound to an approved proposal fingerprint',
                    '',
                    {
                        acceptanceId: acceptance.id,
                        proposalId: acceptance.proposalId,
                        proposalVersion: acceptance.proposalVersion,
                        proposalSha256: acceptance.proposalSha256,
                        source: acceptance.source,
                        priorState,
                        targetState: LIFECYCLE_STATES.ACCEPTED
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async startCustomerOnboarding(access, organisationId, input = {}) {
            const at = now().toISOString();
            const devices = normaliseOnboardingDevices(input.devices);
            if (!devices.length) {
                throw lifecycleError(400, 'At least one planned device is required', 'onboarding_device_plan_required');
            }
            if (devices.some((device) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(device.owner))) {
                throw lifecycleError(
                    400,
                    'Every external planned device needs an explicit customer/device owner or authorised installer email',
                    'onboarding_device_owner_required'
                );
            }
            const submittedIds = (Array.isArray(input.devices) ? input.devices : [])
                .map((item) => cleanText(item && item.id, 180).toLowerCase())
                .filter(Boolean);
            if (submittedIds.length !== devices.length || new Set(submittedIds).size !== submittedIds.length) {
                throw lifecycleError(400, 'Every planned device needs a unique stable ID', 'onboarding_device_ids_not_unique');
            }
            const master = normaliseCustomerMasterInput(input.customerMaster, input.supportProfile, devices, access, at);
            const rawExternalRefs = input.customerMaster && input.customerMaster.externalRefs;
            if (
                rawExternalRefs !== undefined &&
                (!Array.isArray(rawExternalRefs) || rawExternalRefs.length !== master.externalRefs.length)
            ) {
                throw lifecycleError(
                    409,
                    'Submitted system IDs must be valid and already verified through the governed crosswalk',
                    'external_reference_preverification_required'
                );
            }
            const submittedExternalRefs = master.externalRefs.slice();
            const supportProfile = normaliseSupportProfile(input.supportProfile);
            supportProfile.revision = Math.max(1, Number(supportProfile.revision || 0));
            supportProfile.updatedAt = at;
            supportProfile.updatedBy = access.user.email;
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ACCEPTED || organisation.commercialAcceptance.status !== 'verified') {
                    throw lifecycleError(409, 'Verified acceptance is required before customer onboarding', 'commercial_acceptance_required');
                }
                if (organisation.onboarding.planId) {
                    throw lifecycleError(409, 'This customer already has an onboarding plan', 'onboarding_plan_exists');
                }
                const acceptedMaster = normaliseCustomerMaster(organisation.customerMaster, at);
                master.customerId = acceptedMaster.customerId || organisation.links.salesCustomerId || organisation.id;
                master.identity.legalName = master.identity.legalName || organisation.displayName;
                master.identity.tradingName = master.identity.tradingName || organisation.displayName;
                master.createdAt = acceptedMaster.createdAt || organisation.createdAt || at;
                master.updatedAt = at;
                master.revision = Math.max(1, Number(acceptedMaster.revision || 0) + 1);
                master.authority = Object.assign({}, master.authority, {
                    acceptedBy: organisation.commercialAcceptance.signatory.email,
                    acceptedAt: organisation.commercialAcceptance.acceptedAt,
                    evidenceRef: organisation.commercialAcceptance.authority.evidenceId
                });
                const governedExternalRefs = (organisation.customerMaster.externalRefs || [])
                    .filter((reference) => isGovernedVerifiedExternalReference(reference, at))
                    .map((reference) => Object.assign({}, reference));
                const governedKeys = new Set(governedExternalRefs.map(externalReferenceKey));
                if (submittedExternalRefs.some((reference) => !governedKeys.has(externalReferenceKey(reference)))) {
                    throw lifecycleError(
                        409,
                        'Customer system IDs must be verified through the governed crosswalk before onboarding starts',
                        'external_reference_preverification_required'
                    );
                }
                master.externalRefs = governedExternalRefs;
                assertOnboardingMasterInput(master, supportProfile, devices);
                for (const ref of governedExternalRefs) {
                    assertExternalReferenceAvailable(state, organisation, ref);
                }
                organisation.customerMaster = master;
                organisation.supportProfile = supportProfile;
                organisation.context.endpoints.estimatedCount = master.estate.contractedEndpoints;
                organisation.customerMaster.estate.plannedDevices = devices.length;
                organisation.onboarding = buildOnboardingPlan({
                    kind: 'external',
                    acceptanceId: organisation.commercialAcceptance.id,
                    devices: devices.map((device) => Object.assign({}, device, {
                        owner: device.owner,
                        updatedAt: at,
                        updatedBy: access.user.email
                    })),
                    owner: access.user.email,
                    at
                });
                reconcileProofRequirementLedger(organisation, at, { initialiseFromCurrentMaster: true });
                evaluateOnboarding(organisation, at);
                const priorState = organisation.lifecycleState;
                transitionLifecycle(organisation, LIFECYCLE_STATES.ONBOARDING, { actorId: access.user.email, at });
                evaluateOnboarding(organisation, at);
                auditEvents.push(audit(
                    access,
                    'onboarding.customer_started',
                    organisation,
                    'Versioned G0-G5 customer onboarding started',
                    '',
                    {
                        planId: organisation.onboarding.planId,
                        planVersion: organisation.onboarding.planVersion,
                        deviceCount: devices.length,
                        priorState,
                        targetState: LIFECYCLE_STATES.ONBOARDING
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async addExternalReference(access, organisationId, input = {}) {
            const at = now().toISOString();
            if (cleanText(input.verificationMode, 40).toLowerCase() === 'provider') {
                throw lifecycleError(
                    403,
                    'Provider-verified references can be written only by the dedicated provider integration',
                    'external_reference_provider_verification_reserved'
                );
            }
            const reference = normaliseExternalReference(Object.assign({}, input, {
                id: input.id || makeId('external_ref'),
                createdAt: at,
                verifiedAt: input.status === 'verified' ? input.verifiedAt || at : input.verifiedAt,
                verifiedBy: input.status === 'verified' ? access.user.email : input.verifiedBy,
                retiredAt: input.status === 'retired' ? at : input.retiredAt,
                retiredBy: input.status === 'retired' ? access.user.email : input.retiredBy,
                retirementReason: input.retirementReason
            }));
            if (!reference) {
                throw lifecycleError(400, 'A typed external system reference is required', 'external_reference_invalid');
            }
            if (reference.status === 'verified' && reference.verificationMode === 'manual' && (
                input.confirmManuallyVerified !== true || !reference.evidenceRef
            )) {
                throw lifecycleError(400, 'Manual verification requires confirmation and an evidence reference', 'external_reference_verification_required');
            }
            if (reference.status === 'verified' && Date.parse(reference.verifiedAt) > Date.parse(at) + (5 * 60 * 1000)) {
                throw lifecycleError(400, 'External-reference verification cannot be future-dated', 'external_reference_verification_time_invalid');
            }
            if (reference.status === 'retired' && (
                input.confirmRetirement !== true || !reference.retirementReason || !reference.evidenceRef
            )) {
                throw lifecycleError(
                    400,
                    'Retiring a system reference requires confirmation, a reason and evidence',
                    'external_reference_retirement_evidence_required'
                );
            }
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.recordType !== 'customer') {
                    throw lifecycleError(409, 'External customer references can be added only after acceptance', 'customer_record_required');
                }
                const existing = (organisation.customerMaster.externalRefs || []).find((candidate) => (
                    externalReferenceKey(candidate) === externalReferenceKey(reference)
                ));
                if (existing && existing.verificationMode === 'provider') {
                    throw lifecycleError(
                        409,
                        'This provider-managed reference can be changed only by its dedicated integration',
                        'external_reference_provider_managed'
                    );
                }
                if (reference.status === 'retired' && !existing) {
                    throw lifecycleError(404, 'The system reference to retire was not found', 'external_reference_not_found');
                }
                const saved = reference.status === 'retired'
                    ? Object.assign(existing, {
                        status: 'retired',
                        retiredAt: at,
                        retiredBy: access.user.email,
                        retirementReason: reference.retirementReason
                    })
                    : upsertExternalReference(state, organisation, reference);
                if (saved.status === 'retired') {
                    if (saved.system === 'autotask' && saved.recordType === 'account' && organisation.links.serviceDeskCustomerId === saved.externalId) {
                        organisation.links.serviceDeskCustomerId = '';
                    }
                    if (saved.system === 'datto_rmm' && saved.recordType === 'site' && organisation.links.dattoRmmSiteUid === saved.externalId) {
                        organisation.links.dattoRmmSiteUid = '';
                    }
                }
                organisation.customerMaster.updatedAt = at;
                organisation.customerMaster.revision = Number(organisation.customerMaster.revision || 0) + 1;
                organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
                revokeOpenActivationRequests(organisation, at);
                refreshCustomerOnboarding(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'customer_master.external_reference_saved',
                    organisation,
                    `${reference.system} ${reference.recordType} crosswalk saved`,
                    '',
                    {
                        referenceId: saved.id,
                        system: saved.system,
                        recordType: saved.recordType,
                        status: saved.status,
                        verificationMode: saved.verificationMode,
                        changeEvidenceRef: reference.evidenceRef,
                        retirementReason: reference.retirementReason
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async updateCustomerMaster(access, organisationId, input = {}) {
            const source = input.customerMaster;
            const evidenceRef = cleanEvidenceReference(input.evidenceRef);
            const reason = cleanText(input.reason, 500);
            if (!source || typeof source !== 'object' || Array.isArray(source)) {
                throw lifecycleError(400, 'A complete customer-master replacement is required', 'customer_master_change_required');
            }
            if (!evidenceRef || !reason || input.confirmChange !== true) {
                throw lifecycleError(400, 'Customer-master changes require a reason, evidence reference and explicit confirmation', 'customer_master_change_evidence_required');
            }
            assertExpectedRevisionProvided(input.expectedRevision);
            for (const field of ['customerId', 'externalRefs', 'authority']) {
                if (Object.prototype.hasOwnProperty.call(source, field)) {
                    throw lifecycleError(
                        409,
                        `${field} is controlled by a dedicated identity or authority flow`,
                        'customer_master_immutable_field'
                    );
                }
            }
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                assertCustomerChangeState(organisation);
                const previous = normaliseCustomerMaster(organisation.customerMaster, at);
                const devices = organisation.onboarding && organisation.onboarding.devices || [];
                const replacement = normaliseCustomerMasterInput(source, organisation.supportProfile, devices, access, at);
                replacement.customerId = previous.customerId;
                replacement.externalRefs = previous.externalRefs.map((reference) => Object.assign({}, reference));
                replacement.authority = Object.assign({}, previous.authority);
                replacement.createdAt = previous.createdAt || organisation.createdAt || at;
                replacement.updatedAt = at;
                replacement.revision = Math.max(1, Number(previous.revision || 0) + 1);
                assertOnboardingMasterInput(replacement, organisation.supportProfile, devices, { skipSupportProfile: true });

                organisation.customerMasterHistory = Array.isArray(organisation.customerMasterHistory)
                    ? organisation.customerMasterHistory
                    : [];
                organisation.customerMasterHistory.push({
                    revision: Math.max(1, Number(previous.revision || 0)),
                    changedAt: at,
                    changedBy: access.user.email,
                    reason,
                    evidenceRef,
                    snapshot: previous
                });
                organisation.customerMaster = replacement;
                const proofRequirementLedger = reconcileProofRequirementLedger(organisation, at);
                const proofRequirements = reconcileOrganisationProofRequirements(organisation, at);
                const proofScheduleChanged = refreshExistingMonthlyProofSchedule(state, organisation, at);
                invalidatePendingActivationForCustomerChange(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'customer_master.changed',
                    organisation,
                    'Customer-master profile replaced through the evidence-bound change flow',
                    '',
                    {
                        priorRevision: previous.revision,
                        revision: replacement.revision,
                        reason,
                        evidenceRef,
                        changedSections: Object.keys(source).sort(),
                        proofRequirementsAdded: proofRequirements.addedSources,
                        unresolvedProofEntitlements: proofRequirements.unresolvedEntitlements,
                        proofRequirementLedgerPeriods: proofRequirementLedger.periods,
                        proofScheduleChanged
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async updateSupportProfile(access, organisationId, input = {}) {
            const source = input.supportProfile;
            const evidenceRef = cleanEvidenceReference(input.evidenceRef);
            const reason = cleanText(input.reason, 500);
            if (!source || typeof source !== 'object' || Array.isArray(source)) {
                throw lifecycleError(400, 'A complete support-profile replacement is required', 'support_profile_change_required');
            }
            if (!evidenceRef || !reason || input.confirmChange !== true) {
                throw lifecycleError(400, 'Support-profile changes require a reason, evidence reference and explicit confirmation', 'support_profile_change_evidence_required');
            }
            assertExpectedRevisionProvided(input.expectedRevision);
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                assertCustomerChangeState(organisation);
                const previous = normaliseSupportProfile(organisation.supportProfile);
                const replacement = normaliseSupportProfile(Object.assign({}, source, {
                    revision: Math.max(1, Number(previous.revision || 0) + 1),
                    updatedAt: at,
                    updatedBy: access.user.email
                }));
                assertSupportProfileChange(replacement);

                organisation.supportProfileHistory = Array.isArray(organisation.supportProfileHistory)
                    ? organisation.supportProfileHistory
                    : [];
                organisation.supportProfileHistory.push({
                    revision: Math.max(1, Number(previous.revision || 0)),
                    changedAt: at,
                    changedBy: access.user.email,
                    reason,
                    evidenceRef,
                    snapshot: previous
                });
                organisation.supportProfile = replacement;
                const proofRequirementLedger = reconcileProofRequirementLedger(organisation, at);
                const proofRequirements = reconcileOrganisationProofRequirements(organisation, at);
                invalidatePendingActivationForCustomerChange(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'support_profile.changed',
                    organisation,
                    'Support schedule and authorised-requester profile replaced through the evidence-bound change flow',
                    '',
                    {
                        priorRevision: previous.revision,
                        revision: replacement.revision,
                        reason,
                        evidenceRef,
                        requesterCount: replacement.authorisedRequesters.length,
                        contractStatus: replacement.contractStatus,
                        priorTimezone: previous.timezone,
                        timezone: replacement.timezone,
                        proofRequirementLedgerPeriods: proofRequirementLedger.periods,
                        proofRequirementHistoryIncompletePeriods: proofRequirementLedger.incompletePeriods || 0,
                        proofRequirementsAdded: proofRequirements.addedSources
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async matchOnboardingDevice(access, organisationId, input = {}) {
            const at = now().toISOString();
            const deviceId = cleanText(input.deviceId, 180);
            const providerDeviceUid = cleanText(input.providerDeviceUid, 180);
            if (!deviceId || !providerDeviceUid || input.confirmMatch !== true) {
                throw lifecycleError(400, 'Confirm a planned device and Datto device UID', 'device_match_confirmation_required');
            }
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING) {
                    throw lifecycleError(409, 'Device matching is available only during onboarding', 'onboarding_state_required');
                }
                const device = organisation.onboarding.devices.find((item) => item.id === deviceId);
                if (!device) throw lifecycleError(404, 'Planned onboarding device not found', 'onboarding_device_not_found');
                const observed = (organisation.integrations.dattoRmm.devices || []).find((item) => item.uid === providerDeviceUid);
                if (!observed) {
                    throw lifecycleError(409, 'The Datto device UID is not present in the current snapshot', 'datto_rmm_device_not_observed');
                }
                if (!dattoOperatingSystemMatchesPlatform(device.platform, observed.operatingSystem)) {
                    throw lifecycleError(
                        409,
                        'The observed Datto operating system does not match the planned device platform',
                        'datto_rmm_device_platform_mismatch',
                        {
                            deviceId,
                            plannedPlatform: device.platform,
                            observedOperatingSystem: cleanText(observed.operatingSystem, 240) || 'unknown'
                        }
                    );
                }
                const duplicate = organisation.onboarding.devices.find((item) => (
                    item.id !== device.id && (item.providerRefs || []).some((ref) => ref.system === 'datto_rmm' && ref.externalId === providerDeviceUid)
                ));
                if (duplicate) {
                    throw lifecycleError(409, 'This Datto device is already matched to another planned device', 'datto_rmm_device_match_conflict');
                }
                const priorUid = ((device.providerRefs || []).find((ref) => ref.system === 'datto_rmm') || {}).externalId || '';
                const priorStatus = device.status;
                device.providerRefs = (device.providerRefs || []).filter((ref) => ref.system !== 'datto_rmm');
                device.providerRefs.push({ system: 'datto_rmm', externalId: providerDeviceUid });
                device.matchStatus = 'confirmed';
                if (device.status === 'installer_ready') device.status = 'enrolled';
                device.matchedAt = at;
                device.matchedBy = access.user.email;
                device.lastObservedAt = observed.lastSeen || organisation.integrations.dattoRmm.capturedAt;
                device.sourceSnapshotId = organisation.integrations.dattoRmm.snapshotId;
                device.updatedAt = at;
                device.updatedBy = access.user.email;
                organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
                revokeOpenActivationRequests(organisation, at);
                refreshCustomerOnboarding(organisation, at);
                auditEvents.push(audit(
                    access,
                    'onboarding.device_identity_confirmed',
                    organisation,
                    `${device.label} was matched to a Datto device UID`,
                    '',
                    {
                        deviceId,
                        providerDeviceUid,
                        priorUid,
                        priorStatus,
                        status: device.status,
                        snapshotId: device.sourceSnapshotId
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async recordOnboardingEvidence(access, organisationId, input = {}) {
            const gateId = cleanText(input.gateId, 180);
            if (![GATE_IDS.G1, GATE_IDS.G4].includes(gateId)) {
                throw lifecycleError(400, 'Evidence can be recorded only for the controlled access or monitoring gates', 'onboarding_evidence_gate_invalid');
            }
            const at = now().toISOString();
            const evidence = normaliseOnboardingEvidence(input, access, at, makeId);
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING) {
                    throw lifecycleError(409, 'The customer must be in onboarding', 'onboarding_state_required');
                }
                const gate = organisation.onboarding.gates.find((item) => item.id === gateId);
                if (!gate) throw lifecycleError(404, 'Onboarding gate not found', 'onboarding_gate_not_found');
                if (gateId === GATE_IDS.G4 && !gateDependenciesComplete(organisation.onboarding.gates, gate)) {
                    throw lifecycleError(409, 'Complete G0-G3 before customer monitoring acceptance', 'onboarding_gate_dependencies_incomplete');
                }
                if (gate.evidenceRefs.some((item) => item.id === evidence.id)) return organisation;
                gate.evidenceRefs.push(evidence);
                if (gateId === GATE_IDS.G4) {
                    if (!evidence.customerAcceptedAt || !cleanEvidenceReference(input.customerAuthorityRef)) {
                        throw lifecycleError(400, 'G4 requires customer acceptance time and authority evidence', 'monitoring_customer_acceptance_required');
                    }
                    gate.status = 'complete';
                    gate.completedAt = at;
                    gate.completedBy = access.user.email;
                    gate.blockedReason = '';
                    gate.decision = {
                        approvedBy: access.user.email,
                        approvedAt: at,
                        authorityRef: cleanEvidenceReference(input.customerAuthorityRef)
                    };
                }
                organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
                revokeOpenActivationRequests(organisation, at);
                refreshCustomerOnboarding(organisation, at);
                auditEvents.push(audit(
                    access,
                    'onboarding.evidence_recorded',
                    organisation,
                    `${gate.code || gate.id} evidence recorded`,
                    '',
                    { gateId, evidenceId: evidence.id, source: evidence.source, sourceMode: evidence.sourceMode }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async requestActivation(access, organisationId, input = {}) {
            const idempotencyKey = cleanIdempotencyKey(input.idempotencyKey);
            const customerAuthorityRef = cleanEvidenceReference(input.customerAuthorityRef);
            if (!idempotencyKey || !customerAuthorityRef || input.confirmNoUnresolvedHighRiskExceptions !== true) {
                throw lifecycleError(400, 'Activation requires an idempotency key, customer authority and exception confirmation', 'activation_request_evidence_required');
            }
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING) {
                    throw lifecycleError(409, 'The customer must be in onboarding', 'onboarding_state_required');
                }
                const readiness = evaluateOnboarding(organisation, at);
                if (!readiness.readyForActivation) {
                    throw lifecycleError(409, 'Complete G0-G4 before requesting activation', 'activation_readiness_incomplete', { missing: readiness.missing });
                }
                const payloadSha256 = activationFingerprint(organisation, customerAuthorityRef);
                const existing = organisation.activationRequests.find((item) => item.idempotencyKey === idempotencyKey);
                if (existing) {
                    if (existing.payloadSha256 !== payloadSha256) {
                        throw lifecycleError(409, 'The activation key is bound to different onboarding evidence', 'activation_idempotency_conflict');
                    }
                    return { organisation, request: existing };
                }
                const request = {
                    id: makeId('activation_request'),
                    idempotencyKey,
                    status: 'pending',
                    planId: organisation.onboarding.planId,
                    planRevision: organisation.onboarding.planRevision,
                    payloadSha256,
                    maker: actorFromAccess(access),
                    checker: {},
                    executor: {},
                    customerAuthorityRef,
                    reason: cleanText(input.reason || 'Activate managed service after G0-G4 acceptance', 500),
                    createdAt: at,
                    approvedAt: '',
                    expiresAt: new Date(Date.parse(at) + (48 * 60 * 60 * 1000)).toISOString(),
                    consumedAt: '',
                    rejectedAt: '',
                    revokedAt: ''
                };
                organisation.activationRequests.push(request);
                organisation.onboarding.activationRequestId = request.id;
                auditEvents.push(audit(
                    access,
                    'onboarding.activation_requested',
                    organisation,
                    'G5 activation was requested for independent review',
                    '',
                    { requestId: request.id, planId: request.planId, planRevision: request.planRevision, payloadSha256 },
                    { operationId: request.id }
                ));
                return { organisation, request };
            });
            return {
                revision: result.state.revision,
                request: result.result.request,
                organisation: operatorOrganisation(result.result.organisation, result.state)
            };
        },

        async reviewActivation(access, organisationId, requestId, input = {}) {
            const at = now().toISOString();
            const decision = cleanText(input.decision, 40);
            if (!['approve', 'reject'].includes(decision)) {
                throw lifecycleError(400, 'Choose an explicit activation review decision', 'activation_review_decision_invalid');
            }
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const request = findActivationRequest(organisation, requestId);
                if (request.status === 'approved' && decision === 'approve') return { organisation, request };
                if (request.status !== 'pending') {
                    throw lifecycleError(409, 'The activation request is not awaiting review', 'activation_request_not_pending');
                }
                if (Date.parse(request.expiresAt) <= Date.parse(at)) {
                    request.status = 'expired';
                    throw lifecycleError(409, 'The activation request has expired', 'activation_request_expired');
                }
                const checker = actorFromAccess(access);
                if (sameActor(request.maker, checker)) {
                    throw lifecycleError(409, 'The activation checker must be different from the maker', 'activation_maker_checker_conflict');
                }
                request.checker = checker;
                if (decision === 'reject') {
                    request.status = 'rejected';
                    request.rejectedAt = at;
                    request.reason = cleanText(input.reason, 500) || request.reason;
                } else {
                    request.status = 'approved';
                    request.approvedAt = at;
                }
                auditEvents.push(audit(
                    access,
                    decision === 'approve' ? 'onboarding.activation_approved' : 'onboarding.activation_rejected',
                    organisation,
                    decision === 'approve' ? 'Independent checker approved G5 activation' : 'Independent checker rejected G5 activation',
                    '',
                    { requestId: request.id, decision, reason: cleanText(input.reason, 500) },
                    { operationId: request.id }
                ));
                return { organisation, request };
            });
            return {
                revision: result.state.revision,
                request: result.result.request,
                organisation: operatorOrganisation(result.result.organisation, result.state)
            };
        },

        async executeActivation(access, organisationId, requestId, input = {}) {
            if (input.confirmActivation !== true) {
                throw lifecycleError(400, 'Confirm the controlled move to active service', 'activation_execution_confirmation_required');
            }
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const request = findActivationRequest(organisation, requestId);
                if (request.status === 'consumed') return { organisation, request };
                if (request.status !== 'approved') {
                    throw lifecycleError(409, 'An independently approved activation request is required', 'activation_approval_required');
                }
                if (Date.parse(request.expiresAt) <= Date.parse(at)) {
                    request.status = 'expired';
                    throw lifecycleError(409, 'The activation request has expired', 'activation_request_expired');
                }
                const executor = actorFromAccess(access);
                if (sameActor(request.maker, executor)) {
                    throw lifecycleError(409, 'The activation executor must be different from the maker', 'activation_maker_executor_conflict');
                }
                if (sameActor(request.checker, executor)) {
                    throw lifecycleError(409, 'The activation executor must be different from the checker', 'activation_checker_executor_conflict');
                }
                const readiness = evaluateOnboarding(organisation, at);
                if (!readiness.readyForActivation || activationFingerprint(organisation, request.customerAuthorityRef) !== request.payloadSha256) {
                    request.status = 'revoked';
                    request.revokedAt = at;
                    throw lifecycleError(409, 'Onboarding evidence changed after approval; request a new activation', 'activation_evidence_changed');
                }
                const gate = organisation.onboarding.gates.find((item) => item.id === GATE_IDS.G5);
                request.status = 'consumed';
                request.executor = executor;
                request.consumedAt = at;
                gate.status = 'complete';
                gate.completedBy = access.user.email;
                gate.completedAt = at;
                gate.blockedReason = '';
                gate.decision = { approvedBy: request.checker.email, approvedAt: request.approvedAt, authorityRef: request.customerAuthorityRef };
                organisation.onboarding.activationRequestId = request.id;
                const priorState = organisation.lifecycleState;
                transitionLifecycle(organisation, LIFECYCLE_STATES.ACTIVE, { actorId: access.user.email, at });
                organisation.onboarding.status = 'complete';
                organisation.onboarding.completedAt = at;
                organisation.links.serviceDeskCustomerId = organisation.links.serviceDeskCustomerId || organisation.id;
                organisation.nextAction = {
                    type: 'day_30_service_review',
                    detail: 'Complete the day-30 baseline and service review, then agree the monthly proof rhythm.',
                    timing: 'within 30 days',
                    owner: 'service_manager',
                    dueAt: new Date(Date.parse(at) + (30 * 24 * 60 * 60 * 1000)).toISOString(),
                    status: 'open'
                };
                ensureDefaultSchedules(state, organisation, at, makeId);
                auditEvents.push(audit(
                    access,
                    'lifecycle.transitioned',
                    organisation,
                    `Customer moved from ${priorState} to active after dual control`,
                    '',
                    {
                        priorState,
                        targetState: LIFECYCLE_STATES.ACTIVE,
                        requestId: request.id,
                        maker: request.maker.email,
                        checker: request.checker.email,
                        executor: request.executor.email
                    },
                    { operationId: request.id }
                ));
                return { organisation, request };
            });
            return {
                revision: result.state.revision,
                request: result.result.request,
                organisation: operatorOrganisation(result.result.organisation, result.state)
            };
        },

        async updateServiceStatus(access, organisationId, input = {}) {
            const action = cleanText(input.action, 80);
            const transitions = {
                suspend: { from: ['active'], to: 'suspended' },
                resume: { from: ['suspended'], to: 'active' },
                start_offboarding: { from: ['active', 'suspended'], to: 'offboarding' },
                complete_offboarding: { from: ['offboarding'], to: 'former' }
            };
            const policy = transitions[action];
            const reason = cleanText(input.reason, 500);
            const authorityRef = cleanEvidenceReference(input.customerAuthorityRef);
            if (!policy || !reason || !authorityRef) {
                throw lifecycleError(400, 'A valid service-status action, reason and customer authority are required', 'service_status_evidence_required');
            }
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const current = organisation.serviceStatus && organisation.serviceStatus.state || organisation.lifecycleState;
                if (!policy.from.includes(current)) {
                    throw lifecycleError(409, `Service status cannot move from ${current} using ${action}`, 'service_status_transition_invalid');
                }
                organisation.serviceStatus = {
                    state: policy.to,
                    source: 'lifecycle',
                    sourceRecordId: organisation.id,
                    reason,
                    effectiveAt: at,
                    changedBy: access.user.email,
                    policyVersion: '2026.08'
                };
                organisation.lifecycleState = policy.to;
                const clearedInternalServiceDeskLink = policy.to === 'former' &&
                    organisation.links.serviceDeskCustomerId === organisation.id;
                if (clearedInternalServiceDeskLink) organisation.links.serviceDeskCustomerId = '';
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                const schedulesChanged = setCustomerSchedulesEnabled(state, organisation.id, policy.to === 'active', at);
                auditEvents.push(audit(
                    access,
                    'service.status_changed',
                    organisation,
                    `Service status changed from ${current} to ${policy.to}`,
                    '',
                    {
                        action,
                        priorState: current,
                        targetState: policy.to,
                        reason,
                        authorityRef,
                        schedulesChanged,
                        clearedInternalServiceDeskLink
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async getCustomerProof(access, organisationId, input = {}) {
            const state = await repository.read(access);
            const organisation = findOrganisation(state, organisationId);
            const at = now().toISOString();
            const period = normaliseProofPeriod(input.period, at, organisationProofTimezone(organisation));
            const proof = findOrBuildProof(organisation, period, at);
            return { revision: state.revision, proof: proofWithGroundwork(organisation, proof, at) };
        },

        async recordProofEvidence(access, organisationId, input = {}) {
            const at = now().toISOString();
            const requestedPeriod = normaliseRequestedProofPeriod(input.period);
            assertExpectedRevisionSyntax(input.expectedRevision);
            if (proofEvidenceContainsSensitiveData(input)) {
                throw lifecycleError(
                    400,
                    'Proof evidence must not contain credentials, payment-card data or other secrets',
                    'proof_evidence_sensitive_data'
                );
            }

            const existingState = await repository.read(access);
            const existingOrganisation = findOrganisation(existingState, organisationId);
            if (existingOrganisation.recordType !== 'customer') {
                throw lifecycleError(409, 'Proof belongs to a customer record', 'customer_record_required');
            }
            if (!requestedPeriod) {
                throw lifecycleError(
                    400,
                    'Proof evidence requires an explicit YYYY-MM reporting period',
                    'proof_period_required'
                );
            }
            const period = requestedPeriod;
            const evidence = normaliseProofEvidence([Object.assign({}, input, {
                id: input.id || 'proof_evidence_pending',
                ingestedAt: at,
                recordedBy: access.user.email
            })])[0];
            if (!evidence || !evidence.checksum || !evidence.evidenceRef) {
                throw lifecycleError(400, 'Proof evidence needs a source, checksum, reference and valid timestamps', 'proof_evidence_invalid');
            }
            if (!input.id) evidence.id = proofEvidenceStableId(period, evidence);
            if (Date.parse(evidence.capturedAt) > Date.parse(at) + (5 * 60 * 1000)) {
                throw lifecycleError(400, 'Proof evidence cannot be dated in the future', 'proof_evidence_future_timestamp');
            }

            // An identical retry is a read-only success even when its original optimistic
            // revision is now stale. This prevents retries from adding audit events or
            // advancing the tenant revision while preserving conflict checks for new data.
            const existingProof = existingOrganisation.proofPeriods.find((item) => item.period === period);
            const existingEvidence = existingProof && existingProof.evidenceRefs.find((item) => item.id === evidence.id);
            if (existingEvidence) {
                if (proofEvidenceFingerprint(existingEvidence) !== proofEvidenceFingerprint(evidence)) {
                    throw lifecycleError(409, 'Proof evidence ID is already bound to different evidence', 'proof_evidence_idempotency_conflict', {
                        period,
                        evidenceId: evidence.id
                    });
                }
                return {
                    revision: existingState.revision,
                    created: false,
                    proof: proofWithGroundwork(existingOrganisation, existingProof, at)
                };
            }
            if (existingProof && ['approved', 'issued'].includes(existingProof.status)) {
                throw lifecycleError(409, 'Approved or issued proof is immutable', 'proof_period_immutable', { period });
            }
            if (existingProof && existingProof.evidenceRefs.length >= MAX_PROOF_EVIDENCE_PER_PERIOD) {
                throw lifecycleError(
                    409,
                    'The Proof evidence capacity for this reporting period has been reached',
                    'proof_evidence_capacity_exceeded',
                    { period, maximumEvidence: MAX_PROOF_EVIDENCE_PER_PERIOD }
                );
            }
            assertExpectedRevisionForProofWrite(input.expectedRevision);
            const prospectiveProof = existingProof || createProofPeriod(existingOrganisation, period, at);
            if (!existingProof) assertProofPeriodCreationAllowed(existingOrganisation, prospectiveProof, at);
            assertProofEvidenceCoversPeriod(evidence, prospectiveProof, at);

            const auditEvents = [];
            let result;
            try {
                result = await repository.mutate(access, {
                    expectedRevision: input.expectedRevision,
                    auditEvents
                }, async (state) => {
                    const organisation = findOrganisation(state, organisationId);
                    if (organisation.recordType !== 'customer') throw lifecycleError(409, 'Proof belongs to a customer record', 'customer_record_required');
                    let proof = organisation.proofPeriods.find((item) => item.period === period);
                    if (!proof) {
                        proof = createProofPeriod(organisation, period, at);
                        assertProofPeriodCreationAllowed(organisation, proof, at);
                        organisation.proofPeriods.push(proof);
                    }
                    if (['approved', 'issued'].includes(proof.status)) {
                        throw lifecycleError(409, 'Approved or issued proof is immutable', 'proof_period_immutable', { period });
                    }
                    assertProofEvidenceCoversPeriod(evidence, proof, at);
                    reconcileMutableProofRequirements(organisation, proof, at);
                    const duplicate = proof.evidenceRefs.find((item) => item.id === evidence.id);
                    if (duplicate && proofEvidenceFingerprint(duplicate) !== proofEvidenceFingerprint(evidence)) {
                        throw lifecycleError(409, 'Proof evidence ID is already bound to different evidence', 'proof_evidence_idempotency_conflict', {
                            period,
                            evidenceId: evidence.id
                        });
                    }
                    if (!duplicate && proof.evidenceRefs.length >= MAX_PROOF_EVIDENCE_PER_PERIOD) {
                        throw lifecycleError(
                            409,
                            'The Proof evidence capacity for this reporting period has been reached',
                            'proof_evidence_capacity_exceeded',
                            { period, maximumEvidence: MAX_PROOF_EVIDENCE_PER_PERIOD }
                        );
                    }
                    if (!duplicate) proof.evidenceRefs.push(evidence);
                    const readiness = proofReadiness(proofRequirementView(organisation, proof, at), at);
                    proof.status = readiness.ready ? 'ready' : 'incomplete';
                    proof.updatedAt = at;
                    auditEvents.push(audit(
                        access,
                        'proof.evidence_recorded',
                        organisation,
                        `${evidence.source} evidence recorded for ${period}`,
                        '',
                        { period, evidenceId: evidence.id, source: evidence.source, sourceMode: evidence.sourceMode, freshness: readiness.sources }
                    ));
                    return { organisation, proof, created: !duplicate };
                });
            } catch (error) {
                if (!(error instanceof LifecycleRepositoryError) || error.details.code !== 'revision_conflict') throw error;
                const convergedState = await repository.read(access);
                const convergedOrganisation = findOrganisation(convergedState, organisationId);
                const convergedProof = convergedOrganisation.proofPeriods.find((item) => item.period === period);
                const convergedEvidence = convergedProof && convergedProof.evidenceRefs.find((item) => item.id === evidence.id);
                if (!convergedEvidence) throw error;
                if (proofEvidenceFingerprint(convergedEvidence) !== proofEvidenceFingerprint(evidence)) {
                    throw lifecycleError(409, 'Proof evidence ID is already bound to different evidence', 'proof_evidence_idempotency_conflict', {
                        period,
                        evidenceId: evidence.id
                    });
                }
                return {
                    revision: convergedState.revision,
                    created: false,
                    proof: proofWithGroundwork(convergedOrganisation, convergedProof, at)
                };
            }
            return {
                revision: result.state.revision,
                created: result.result.created,
                proof: proofWithGroundwork(result.result.organisation, result.result.proof, at)
            };
        },

        async approveCustomerProof(access, organisationId, input = {}) {
            const at = now().toISOString();
            const requestedPeriod = normaliseRequestedProofPeriod(input.period);
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (!requestedPeriod) {
                    throw lifecycleError(
                        400,
                        'Proof approval requires an explicit YYYY-MM reporting period',
                        'proof_period_required'
                    );
                }
                assertExpectedRevisionForProofApproval(input.expectedRevision);
                const period = requestedPeriod;
                const proof = organisation.proofPeriods.find((item) => item.period === period);
                if (!proof) throw lifecycleError(404, 'Proof period not found', 'proof_period_not_found');
                if (['approved', 'issued'].includes(proof.status)) {
                    throw lifecycleError(409, 'Approved or issued proof is immutable', 'proof_period_immutable', { period });
                }
                assertProofPeriodClosed(proof, at);
                const requirements = reconcileMutableProofRequirements(organisation, proof, at);
                if (requirements.view.requirementHistoryComplete === false) {
                    throw lifecycleError(
                        409,
                        'Proof cannot be approved until its entitlement requirement history is complete',
                        'proof_requirement_history_incomplete',
                        { entitlementCodesOverflow: requirements.view.entitlementCodesOverflow === true }
                    );
                }
                if (requirements.unresolvedEntitlements.length) {
                    throw lifecycleError(
                        409,
                        'Proof cannot be approved until every active entitlement has a governed evidence-source policy',
                        'proof_entitlement_mapping_required',
                        { entitlements: requirements.unresolvedEntitlements }
                    );
                }
                const readiness = proofReadiness(requirements.view, at);
                if (!readiness.ready) {
                    throw lifecycleError(409, 'Proof cannot be approved while sources are missing, stale, simulated or disabled', 'proof_readiness_incomplete', { missing: readiness.missing });
                }
                if (input.confirmComplete !== true) {
                    throw lifecycleError(400, 'Confirm the proof pack is complete', 'proof_approval_confirmation_required');
                }
                proof.status = 'approved';
                proof.approvedBy = access.user.email;
                proof.approvedAt = at;
                proof.updatedAt = at;
                auditEvents.push(audit(access, 'proof.approved', organisation, `Customer proof approved for ${period}`, '', {
                    period,
                    requiredSources: proof.requiredSources,
                    customerMasterRevision: organisation.customerMaster.revision
                }));
                return proof;
            });
            const organisation = findOrganisation(result.state, organisationId);
            return { revision: result.state.revision, proof: proofWithGroundwork(organisation, result.result, at) };
        },

        async runCustomerControls(access, input = {}) {
            if (input.confirmInternalOnly !== true) {
                throw lifecycleError(400, 'Confirm that this run creates internal operator work only', 'internal_control_run_confirmation_required');
            }
            const scheduledFor = validIsoDate(input.scheduledFor) || now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                state.organisations.filter((organisation) => organisation.recordType === 'customer').forEach((organisation) => {
                    ensureDefaultSchedules(state, organisation, scheduledFor, makeId);
                });
                const generated = [];
                for (const schedule of state.schedules.filter((item) => item.enabled && item.deliveryMode === 'internal')) {
                    if (!schedule.nextDueAt || Date.parse(schedule.nextDueAt) > Date.parse(scheduledFor)) continue;
                    const runId = `control_run_${canonicalHash({
                        scheduleId: schedule.id,
                        scheduledFor: schedule.nextDueAt,
                        templateVersion: schedule.templateVersion
                    }).slice(0, 32)}`;
                    if (state.controlRuns.some((item) => item.id === runId)) continue;
                    const taskId = `operator_task_${canonicalHash({ runId }).slice(0, 32)}`;
                    const organisation = findOrganisation(state, schedule.organisationId);
                    state.operatorTasks.push({
                        id: taskId,
                        organisationId: organisation.id,
                        conversationId: '',
                        type: schedule.jobType,
                        title: controlTaskTitle(schedule.jobType, organisation.displayName),
                        detail: controlTaskDetail(schedule.jobType),
                        status: 'open',
                        priority: schedule.jobType === 'connector_freshness' ? 'high' : 'medium',
                        ownerRole: 'service_owner',
                        source: 'customer_control_scheduler',
                        evidence: { runId, scheduleId: schedule.id, scheduledFor: schedule.nextDueAt, externalWrites: false },
                        createdAt: scheduledFor,
                        createdBy: 'customer_control_scheduler',
                        updatedAt: scheduledFor,
                        updatedBy: 'customer_control_scheduler'
                    });
                    const run = {
                        id: runId,
                        scheduleId: schedule.id,
                        organisationId: organisation.id,
                        jobType: schedule.jobType,
                        scheduledFor: schedule.nextDueAt,
                        status: 'generated',
                        taskId,
                        attemptCount: 1,
                        createdAt: scheduledFor,
                        completedAt: '',
                        lastError: {}
                    };
                    state.controlRuns.push(run);
                    generated.push(run);
                    schedule.nextDueAt = advanceSchedulePast(schedule, schedule.nextDueAt, scheduledFor);
                    schedule.updatedAt = scheduledFor;
                    schedule.revision = Number(schedule.revision || 0) + 1;
                }
                auditEvents.push({
                    actorType: 'user',
                    actorId: access.user.email,
                    actorRole: access.user.role,
                    action: 'customer_controls.run',
                    targetType: 'tenant',
                    targetId: access.tenant.key,
                    summary: `${generated.length} internal customer-control tasks generated`,
                    details: { generated: generated.length, scheduledFor, externalWrites: false }
                });
                return generated;
            });
            return {
                revision: result.state.revision,
                generated: result.result,
                externalWrites: false,
                deadLetters: result.state.deadLetters.filter((item) => item.status === 'open')
            };
        },

        async updateOnboardingDevice(access, organisationId, input = {}) {
            const status = cleanText(input.status, 80);
            if (!['planned', 'installer_ready', 'enrolled', 'verified', 'blocked'].includes(status)) {
                throw lifecycleError(400, 'A valid onboarding device status is required', 'onboarding_device_status_invalid');
            }
            const auditEvents = [];
            const at = now().toISOString();
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING) {
                    throw lifecycleError(409, 'Device enrollment can be updated only during customer set-up', 'onboarding_state_required');
                }
                const deviceId = cleanText(input.deviceId, 180);
                const device = (organisation.onboarding.devices || []).find((item) => item.id === deviceId);
                if (!device) {
                    throw lifecycleError(404, 'Planned onboarding device not found', 'onboarding_device_not_found');
                }
                if (status === 'verified' && !(organisation.integrations.dattoRmm && organisation.integrations.dattoRmm.status === 'linked')) {
                    throw lifecycleError(409, 'Link and sync the Datto site before verifying a device', 'datto_link_required_for_device_verification');
                }
                if (status === 'verified' && organisation.onboarding.planVersion && (
                    device.matchStatus !== 'confirmed' ||
                    !(device.providerRefs || []).some((ref) => ref.system === 'datto_rmm' && ref.externalId)
                )) {
                    throw lifecycleError(
                        409,
                        'Confirm the computer against its Datto device UID before verification',
                        'onboarding_device_identity_match_required'
                    );
                }
                const priorStatus = device.status;
                const nextStatus = {
                    planned: 'installer_ready',
                    installer_ready: 'enrolled',
                    enrolled: 'verified',
                    blocked: 'planned'
                }[priorStatus];
                if (status !== priorStatus && status !== 'blocked' && status !== nextStatus) {
                    throw lifecycleError(
                        409,
                        'Move the computer through each set-up check in order',
                        'onboarding_device_status_sequence_required'
                    );
                }
                if (priorStatus === 'verified' && status === 'blocked') {
                    throw lifecycleError(
                        409,
                        'An active verified computer cannot be downgraded through customer set-up',
                        'verified_device_status_locked'
                    );
                }
                device.status = status;
                device.updatedAt = at;
                device.updatedBy = access.user.email;
                if (status !== priorStatus && organisation.onboarding.planVersion) {
                    organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
                    revokeOpenActivationRequests(organisation, at);
                }
                refreshCustomerOnboarding(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'onboarding.device_status_updated',
                    organisation,
                    `${device.label} enrollment status changed from ${priorStatus} to ${status}`,
                    '',
                    { deviceId: device.id, platform: device.platform, priorStatus, status }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async updateOnboardingGate(access, organisationId, input = {}) {
            const gateId = cleanText(input.gateId, 180);
            const status = cleanText(input.status, 80);
            if (gateId === GATE_IDS.G5) {
                throw lifecycleError(409, 'Activate customers through the dual-control activation flow', 'activation_approval_flow_required');
            }
            if (gateId !== GATE_IDS.G4 || !['pending', 'blocked'].includes(status)) {
                throw lifecycleError(400, 'This onboarding decision cannot be updated manually', 'onboarding_gate_update_invalid');
            }
            const auditEvents = [];
            const at = now().toISOString();
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING) {
                    throw lifecycleError(409, 'The customer must be in onboarding', 'onboarding_state_required');
                }
                const gate = (organisation.onboarding.gates || []).find((item) => item.id === gateId);
                if (!gate) {
                    throw lifecycleError(404, 'Onboarding gate not found', 'onboarding_gate_not_found');
                }
                const priorStatus = gate.status;
                gate.status = status;
                refreshCustomerOnboarding(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'onboarding.gate_updated',
                    organisation,
                    `${gate.title} changed from ${priorStatus} to ${status}`,
                    '',
                    { gateId, priorStatus, status }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async updateOrganisation(access, organisationId, input = {}) {
            if (input.onboarding !== undefined) {
                throw lifecycleError(409, 'Update customer set-up through the dedicated onboarding flow', 'dedicated_flow_required');
            }
            if ([
                LIFECYCLE_STATES.PROPOSAL,
                LIFECYCLE_STATES.ACCEPTED,
                LIFECYCLE_STATES.ONBOARDING,
                LIFECYCLE_STATES.ACTIVE,
                LIFECYCLE_STATES.SUSPENDED,
                LIFECYCLE_STATES.OFFBOARDING,
                LIFECYCLE_STATES.FORMER
            ].includes(input.lifecycleState)) {
                throw lifecycleError(409, 'Move customers into proposal or later stages through dedicated governed flows', 'dedicated_flow_required');
            }
            if (input.links !== undefined) {
                throw lifecycleError(409, 'Manage system identifiers through the typed customer crosswalk', 'external_reference_flow_required');
            }
            if (input.scope && typeof input.scope === 'object' && ['salesCustomerId', 'assessmentId', 'proposalId', 'proposalVersion', 'proposalSha256']
                .some((field) => Object.prototype.hasOwnProperty.call(input.scope, field))) {
                throw lifecycleError(
                    409,
                    'Sales customer, assessment and approved-proposal identifiers use dedicated governed handoffs',
                    'proposal_binding_flow_required'
                );
            }
            if (input.scope && typeof input.scope === 'object' && input.scope.status === 'approved') {
                throw lifecycleError(
                    409,
                    'Approve scope only through the exact sealed-proposal binding flow',
                    'proposal_binding_flow_required'
                );
            }
            const auditEvents = [];
            const operatorCorrections = [];
            const at = now().toISOString();
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (Array.isArray(input.facts)) {
                    const outcome = applyContextFacts(organisation, input.facts, {
                        actorId: access.user.email,
                        source: 'operator',
                        at
                    });
                    if (outcome.applied.length) {
                        operatorCorrections.push({
                            id: makeId('correction'),
                            at,
                            organisationId,
                            correctedBy: access.user.email,
                            fields: outcome.applied.map((item) => item.field),
                            reason: cleanText(input.correctionReason || 'Operator update', 500)
                        });
                    }
                }
                if (input.discoverySummary !== undefined) {
                    organisation.discovery.summary = cleanText(input.discoverySummary, 4000);
                }
                if (Array.isArray(input.discoveryNotes)) {
                    organisation.discovery.notes = cleanStringList(input.discoveryNotes, 100, 2000);
                }
                if (input.scope && typeof input.scope === 'object') {
                    organisation.scope = Object.assign({}, organisation.scope, normaliseScope(input.scope));
                }
                if (input.support && typeof input.support === 'object') {
                    organisation.support = Object.assign({}, organisation.support, normaliseSupportHistory(input.support));
                }
                if (input.nextAction && typeof input.nextAction === 'object') {
                    organisation.nextAction = Object.assign({}, organisation.nextAction, normaliseOrganisationNextAction(input.nextAction));
                }
                if (input.lifecycleState && input.lifecycleState !== organisation.lifecycleState) {
                    transitionLifecycle(organisation, input.lifecycleState, {
                        actorId: access.user.email,
                        at
                    });
                }
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                state.operatorCorrections.push(...operatorCorrections);
                auditEvents.push(audit(access, 'organisation.updated', organisation, cleanText(input.correctionReason || 'Lifecycle organisation updated', 600)));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async claimDattoRmmProvisioning(access, organisationId, input = {}) {
            const at = now().toISOString();
            const keyHash = /^[a-f0-9]{64}$/.test(String(input.provisioningKeyHash || '').toLowerCase())
                ? String(input.provisioningKeyHash).toLowerCase()
                : '';
            if (!keyHash) {
                throw lifecycleError(400, 'A stable Datto provisioning key hash is required', 'datto_rmm_provisioning_key_required');
            }
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState !== LIFECYCLE_STATES.ONBOARDING || organisation.commercialAcceptance.status !== 'verified') {
                    throw lifecycleError(409, 'Verified governed onboarding is required before claiming Datto provisioning', 'datto_rmm_onboarding_claim_not_ready');
                }
                const integration = organisation.integrations.dattoRmm;
                const siteName = governedDattoSiteName(organisation);
                const siteNameKey = dattoSiteNameKey(siteName);
                if (!siteNameKey) {
                    throw lifecycleError(409, 'A governed Datto site name is required', 'datto_rmm_site_name_required');
                }
                const conflictingOrganisation = state.organisations.find((candidate) => {
                    if (!candidate || candidate.id === organisation.id) return false;
                    const candidateIntegration = candidate.integrations && candidate.integrations.dattoRmm || {};
                    const candidateProvisioning = candidateIntegration.provisioning || {};
                    const candidateSiteNameKey = cleanText(candidateProvisioning.siteNameKey, 300) || dattoSiteNameKey(
                        candidateIntegration.siteName || governedDattoSiteName(candidate)
                    );
                    const ownsSiteName = Boolean(
                        candidateIntegration.siteUid ||
                        candidate.links && candidate.links.dattoRmmSiteUid ||
                        ['preparing', 'prepared'].includes(candidateProvisioning.state)
                    );
                    return ownsSiteName && candidateSiteNameKey === siteNameKey;
                });
                if (conflictingOrganisation) {
                    throw lifecycleError(
                        409,
                        'Another lifecycle customer already owns or is preparing this canonical Datto site name',
                        'datto_rmm_site_name_claim_conflict',
                        {
                            siteName,
                            conflictingOrganisationId: conflictingOrganisation.id
                        }
                    );
                }
                const current = integration.provisioning || {};
                if (current.state === 'preparing' && Date.parse(current.leaseUntil || '') > Date.parse(at)) {
                    throw lifecycleError(
                        409,
                        'Datto onboarding preparation is already in progress for this lifecycle record',
                        'datto_rmm_provisioning_in_progress',
                        { leaseUntil: current.leaseUntil }
                    );
                }
                const claim = {
                    state: 'preparing',
                    claimId: makeId('datto_provisioning_claim'),
                    keyHash,
                    siteName,
                    siteNameKey,
                    leaseUntil: new Date(Date.parse(at) + DATTO_PROVISIONING_LEASE_MS).toISOString(),
                    startedAt: at,
                    startedBy: access.user.email,
                    completedAt: '',
                    completedBy: ''
                };
                integration.provisioning = claim;
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'integration.datto_rmm.provisioning_claimed',
                    organisation,
                    'Exclusive Datto onboarding preparation claim acquired',
                    '',
                    { claimId: claim.claimId, keyHash, siteName, siteNameKey, leaseUntil: claim.leaseUntil }
                ));
                return claim;
            });
            return { revision: result.state.revision, claim: result.result };
        },

        async releaseDattoRmmProvisioning(access, organisationId, input = {}) {
            const claimId = cleanText(input.claimId, 180);
            const keyHash = /^[a-f0-9]{64}$/.test(String(input.provisioningKeyHash || '').toLowerCase())
                ? String(input.provisioningKeyHash).toLowerCase()
                : '';
            if (!claimId || !keyHash) {
                throw lifecycleError(400, 'The exact Datto provisioning claim is required', 'datto_rmm_provisioning_claim_required');
            }
            const at = now().toISOString();
            const reasonCode = cleanText(input.reasonCode || 'preparation_failed', 120);
            const auditEvents = [];
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const integration = organisation.integrations.dattoRmm;
                const current = integration.provisioning || {};
                if (current.claimId !== claimId || current.keyHash !== keyHash) {
                    throw lifecycleError(409, 'The Datto provisioning claim has changed', 'datto_rmm_provisioning_claim_conflict');
                }
                if (current.state !== 'preparing') return { released: false };
                integration.provisioning = Object.assign({}, current, {
                    state: 'failed',
                    leaseUntil: '',
                    completedAt: at,
                    completedBy: access.user.email
                });
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'integration.datto_rmm.provisioning_released',
                    organisation,
                    'Datto onboarding preparation claim released after a failed attempt',
                    '',
                    { claimId, keyHash, reasonCode }
                ));
                return { released: true };
            });
            return { revision: result.state.revision, released: result.result.released };
        },

        async syncDattoRmmSnapshot(access, organisationId, input = {}) {
            const auditEvents = [];
            const at = now().toISOString();
            const siteUid = cleanText(input.siteUid, 180);
            const siteName = cleanText(input.siteName, 300);
            const deviceCount = normaliseNonNegativeInteger(input.deviceCount, 'device_count_invalid');
            const openAlertCount = normaliseNonNegativeInteger(input.openAlertCount, 'open_alert_count_invalid');
            const mode = input.mode === 'controlled_write' ? 'controlled_write' : 'readonly';
            const provisioningDisposition = ['created', 'reused'].includes(input.provisioningDisposition)
                ? input.provisioningDisposition
                : '';
            const provisioningKeyHash = /^[a-f0-9]{64}$/.test(String(input.provisioningKeyHash || '').toLowerCase())
                ? String(input.provisioningKeyHash).toLowerCase()
                : '';
            const provisioningClaimId = cleanText(input.provisioningClaimId, 180);
                const preflightConfirmations = input.preflightConfirmations && typeof input.preflightConfirmations === 'object'
                    ? {
                        customerAuthority: input.preflightConfirmations.customerAuthority === true,
                        authorisedDevices: input.preflightConfirmations.authorisedDevices === true,
                        noConflictingManagement: input.preflightConfirmations.noConflictingManagement === true,
                        supportedOperatingSystems: input.preflightConfirmations.supportedOperatingSystems === true,
                        newDeviceApprovalEnabled: input.preflightConfirmations.newDeviceApprovalEnabled === true
                    }
                : {};
            const capturedAt = validIsoDate(input.capturedAt) || at;
            if (Date.parse(capturedAt) > Date.parse(at) + (5 * 60 * 1000)) {
                throw lifecycleError(400, 'Datto evidence cannot be dated in the future', 'datto_rmm_snapshot_time_invalid');
            }
            const observedDevices = normaliseDattoDevices(input.devices);
            if (observedDevices.length && observedDevices.length !== deviceCount) {
                throw lifecycleError(409, 'Datto device evidence does not match the reported count', 'datto_rmm_snapshot_count_conflict');
            }
            if (new Set(observedDevices.map((device) => device.uid)).size !== observedDevices.length) {
                throw lifecycleError(409, 'Datto returned duplicate device identifiers', 'datto_rmm_device_uid_conflict');
            }
            if (!/^[a-z0-9_-]{4,180}$/i.test(siteUid) || !siteName) {
                throw lifecycleError(400, 'A valid Datto RMM site is required', 'datto_rmm_site_required');
            }

            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (!['accepted', 'onboarding', 'active'].includes(organisation.lifecycleState)) {
                    throw lifecycleError(
                        409,
                        'Datto RMM sites can be linked only after a proposal is accepted',
                        'datto_rmm_lifecycle_state_required'
                    );
                }
                const duplicate = state.organisations.find((item) => (
                    item.id !== organisation.id && (
                        item.links.dattoRmmSiteUid === siteUid ||
                        (item.customerMaster && item.customerMaster.externalRefs || []).some((ref) => (
                            ref.status !== 'retired' && ref.system === 'datto_rmm' && ref.recordType === 'site' && ref.externalId === siteUid
                        ))
                    )
                ));
                if (duplicate) {
                    throw lifecycleError(
                        409,
                        'This Datto RMM site is already linked to another lifecycle record',
                        'datto_rmm_site_link_conflict'
                    );
                }
                if (organisation.links.dattoRmmSiteUid && organisation.links.dattoRmmSiteUid !== siteUid) {
                    throw lifecycleError(
                        409,
                        'This lifecycle record is already linked to another Datto RMM site',
                        'datto_rmm_organisation_link_conflict'
                    );
                }

                const currentProvisioning = Object.assign({
                    state: 'idle',
                    claimId: '',
                    keyHash: '',
                    leaseUntil: '',
                    startedAt: '',
                    startedBy: '',
                    completedAt: '',
                    completedBy: ''
                }, organisation.integrations.dattoRmm.provisioning || {});
                if (mode === 'controlled_write' && provisioningDisposition) {
                    if (
                        !provisioningClaimId || !provisioningKeyHash ||
                        currentProvisioning.state !== 'preparing' ||
                        currentProvisioning.claimId !== provisioningClaimId ||
                        currentProvisioning.keyHash !== provisioningKeyHash
                    ) {
                        throw lifecycleError(
                            409,
                            'The controlled Datto snapshot is not bound to the active provisioning claim',
                            'datto_rmm_provisioning_claim_conflict'
                        );
                    }
                }

                const contractedEndpointCount = normaliseOptionalCount(
                    organisation.customerMaster &&
                    organisation.customerMaster.estate &&
                    organisation.customerMaster.estate.contractedEndpoints
                );
                const expectedDeviceCount = contractedEndpointCount == null
                    ? normaliseOptionalCount(organisation.context.endpoints.estimatedCount)
                    : contractedEndpointCount;
                const reconciliationStatus = expectedDeviceCount == null
                    ? 'baseline_missing'
                    : expectedDeviceCount === deviceCount && input.truncated !== true ? 'matched' : 'review_required';
                const snapshotId = `datto_snapshot_${canonicalHash({ siteUid, capturedAt, devices: observedDevices }).slice(0, 24)}`;
                organisation.links.dattoRmmSiteUid = siteUid;
                organisation.integrations.dattoRmm = {
                    status: 'linked',
                    mode,
                    siteUid,
                    siteName,
                    deviceCount,
                    expectedDeviceCount,
                    openAlertCount,
                    reconciliationStatus,
                    capturedAt,
                    freshUntil: new Date(Date.parse(capturedAt) + (24 * 60 * 60 * 1000)).toISOString(),
                    snapshotId,
                    snapshotSha256: canonicalHash({ siteUid, capturedAt, devices: observedDevices }),
                    truncated: input.truncated === true,
                    devices: observedDevices,
                    provisioning: mode === 'controlled_write' && provisioningDisposition
                        ? Object.assign({}, currentProvisioning, {
                            state: 'prepared',
                            leaseUntil: '',
                            completedAt: at,
                            completedBy: access.user.email
                        })
                        : currentProvisioning,
                    lastSyncedAt: at,
                    lastSyncedBy: access.user.email
                };
                upsertExternalReference(state, organisation, {
                    system: 'datto_rmm',
                    recordType: 'site',
                    externalId: siteUid,
                    providerScopeId: cleanText(input.providerScopeId, 180),
                    status: 'verified',
                    verificationMode: 'provider',
                    verifiedAt: capturedAt,
                    verifiedBy: access.user.email,
                    evidenceRef: snapshotId,
                    createdAt: at
                });
                organisation.context.endpoints.managedCount = deviceCount;
                for (const planned of organisation.onboarding.devices || []) {
                    const uid = (planned.providerRefs || []).find((ref) => ref.system === 'datto_rmm');
                    const observed = uid && observedDevices.find((device) => device.uid === uid.externalId);
                    if (observed) {
                        planned.lastObservedAt = observed.lastSeen || capturedAt;
                        planned.sourceSnapshotId = snapshotId;
                    }
                }
                if (organisation.onboarding.planVersion) {
                    organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
                    revokeOpenActivationRequests(organisation, at);
                }
                refreshCustomerOnboarding(organisation, at);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'integration.datto_rmm.snapshot_synced',
                    organisation,
                    mode === 'controlled_write'
                        ? 'Controlled Datto RMM onboarding prepared and site evidence reconciled'
                        : 'Read-only Datto RMM site evidence linked and reconciled',
                    '',
                    {
                        siteUid,
                        siteName,
                        deviceCount,
                        openAlertCount,
                        expectedDeviceCount,
                        reconciliationStatus,
                        capturedAt,
                        snapshotId,
                        truncated: input.truncated === true,
                        mode,
                        provisioningDisposition,
                        provisioningKeyHash,
                        preflightConfirmations
                    }
                ));
                return organisation;
            });
            return { revision: result.state.revision, organisation: operatorOrganisation(result.result, result.state) };
        },

        async prepareScoping(access, organisationId, input = {}) {
            const auditEvents = [];
            const observabilityEvents = [];
            const at = now().toISOString();
            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents,
                observabilityEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (organisation.lifecycleState === LIFECYCLE_STATES.DISCOVERY) {
                    transitionLifecycle(organisation, LIFECYCLE_STATES.SCOPING, {
                        actorId: access.user.email,
                        at
                    });
                }
                if (organisation.lifecycleState !== LIFECYCLE_STATES.SCOPING) {
                    throw lifecycleError(409, 'This organisation is not ready for scoping', 'scoping_state_required');
                }
                organisation.scope.status = 'ready';
                organisation.scope.prefillPreparedAt = at;
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                completeDiscoveryScopingTasks(state, organisation, access, at, auditEvents);
                auditEvents.push(audit(access, 'scoping.prefill_prepared', organisation, 'Known discovery context prepared for /scoping'));
                observabilityEvents.push({
                    organisationId: organisation.id,
                    agent: 'discovery_scoping_agent',
                    model: 'deterministic',
                    eventType: 'agent.handoff',
                    handoff: 'discovery_to_scoping',
                    outcome: 'success',
                    details: {
                        knownFields: Object.values(organisation.fieldStates).filter((field) => field.status === 'known').length,
                        missingFields: organisation.discovery.missingFields.length
                    }
                });
                return organisation;
            });
            return {
                revision: result.state.revision,
                organisation: operatorOrganisation(result.result, result.state),
                handoff: {
                    status: 'prefill_ready',
                    mocked: false,
                    integrationStatus: 'operator_confirmation_required',
                    url: `/scoping?organisationId=${encodeURIComponent(result.result.id)}`,
                    context: buildContextSnapshot(result.result)
                }
            };
        },

        async linkScopingRecords(access, organisationId, input = {}) {
            const auditEvents = [];
            const observabilityEvents = [];
            const at = now().toISOString();
            const salesCustomerId = cleanText(input.salesCustomerId, 180);
            const assessmentId = cleanText(input.assessmentId, 180);
            const operationId = cleanText(input.operationId, 180);
            const operationPayloadHash = normaliseSha256(input.operationPayloadHash);
            const suppliedDeletionFence = normaliseScopingDeletionFenceInput(input, {
                required: input.restoreDeletionClaim === true
            });
            if (suppliedDeletionFence && input.restoreDeletionClaim !== true) {
                throw lifecycleError(
                    400,
                    'Deletion fencing fields may be used only for an explicit compensation restore',
                    'scoping_deletion_restore_required'
                );
            }
            const deletionRestore = input.restoreDeletionClaim === true ? suppliedDeletionFence : null;
            if (input.restoreDeletionClaim === true && !deletionRestore) {
                throw lifecycleError(400, 'Deletion compensation requires the exact source fencing token', 'scoping_deletion_fence_required');
            }
            if (!salesCustomerId || !assessmentId) {
                throw lifecycleError(400, 'Sales customer and assessment links are required', 'scoping_links_required');
            }
            if ((operationId && !operationPayloadHash) || (!operationId && operationPayloadHash)) {
                throw lifecycleError(400, 'Operation ID and payload hash must be supplied together', 'handoff_operation_binding_required');
            }
            if (operationId) {
                const existingState = await repository.read(access);
                const receipt = existingState.inboxReceiptsById[operationId];
                if (receipt) {
                    assertScopingReceiptBinding(receipt, {
                        operationPayloadHash,
                        organisationId,
                        salesCustomerId,
                        assessmentId
                    });
                    const organisation = findOrganisation(existingState, organisationId);
                    const fenceDecision = assertScopingLinkFence(
                        organisation,
                        salesCustomerId,
                        assessmentId,
                        deletionRestore
                    );
                    if (scopingLinksMatch(organisation, salesCustomerId, assessmentId) && !fenceDecision.restoring) {
                        return {
                            revision: existingState.revision,
                            organisation: operatorOrganisation(organisation, existingState)
                        };
                    }
                }
            }

            const result = await repository.mutate(access, {
                expectedRevision: input.expectedRevision,
                auditEvents,
                observabilityEvents
            }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const fenceDecision = assertScopingLinkFence(
                    organisation,
                    salesCustomerId,
                    assessmentId,
                    deletionRestore
                );
                let replayingReceipt = false;
                if (operationId) {
                    const receipt = state.inboxReceiptsById[operationId];
                    if (receipt) {
                        assertScopingReceiptBinding(receipt, {
                            operationPayloadHash,
                            organisationId,
                            salesCustomerId,
                            assessmentId
                        });
                        if (scopingLinksMatch(organisation, salesCustomerId, assessmentId) && !fenceDecision.restoring) return organisation;
                        replayingReceipt = true;
                    }
                }
                if (organisation.lifecycleState !== LIFECYCLE_STATES.SCOPING) {
                    throw lifecycleError(409, 'This organisation is not in scoping', 'scoping_state_required');
                }
                const currentCustomerId = organisation.links.salesCustomerId || organisation.scope.salesCustomerId;
                if (currentCustomerId && currentCustomerId !== salesCustomerId) {
                    throw lifecycleError(409, 'This lifecycle record is already linked to another sales customer', 'scoping_customer_link_conflict');
                }
                if (organisation.scope.assessmentId && organisation.scope.assessmentId !== assessmentId) {
                    throw lifecycleError(409, 'This lifecycle record is already linked to another assessment', 'scoping_assessment_link_conflict');
                }

                organisation.links.salesCustomerId = salesCustomerId;
                organisation.scope.salesCustomerId = salesCustomerId;
                organisation.scope.assessmentId = assessmentId;
                organisation.scope.status = 'in_progress';
                organisation.nextAction = {
                    type: 'close_scoping_gaps',
                    detail: Number(input.remainingGapCount || 0) > 0
                        ? `${Number(input.remainingGapCount)} scoped discovery questions remain unknown`
                        : 'Review the pre-populated scope',
                    timing: '',
                    owner: 'discovery_scoping_agent',
                    dueAt: '',
                    status: 'open'
                };
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                if (fenceDecision.restoring) {
                    organisation.scope.deletionFence = Object.assign({}, fenceDecision.fence, {
                        status: 'compensated',
                        compensatedAt: at,
                        compensatedBy: access.user.email,
                        completedAt: '',
                        completedBy: ''
                    });
                } else if (fenceDecision.clearCompleted) {
                    organisation.scope.deletionFence = emptyScopingDeletionFence();
                }
                if (operationId) {
                    if (replayingReceipt) {
                        Object.assign(state.inboxReceiptsById[operationId], {
                            rematerializedAt: at,
                            rematerializedBy: access.user.email
                        });
                    } else {
                        state.inboxReceiptsById[operationId] = {
                            operationId,
                            payloadHash: operationPayloadHash,
                            kind: 'lifecycle.scoping.link',
                            organisationId,
                            salesCustomerId,
                            assessmentId,
                            receivedAt: at,
                            receivedBy: access.user.email,
                            rematerializedAt: '',
                            rematerializedBy: ''
                        };
                    }
                }
                auditEvents.push(audit(
                    access,
                    replayingReceipt || fenceDecision.restoring ? 'scoping.records_rematerialized' : 'scoping.records_linked',
                    organisation,
                    replayingReceipt || fenceDecision.restoring
                        ? 'Lifecycle scoping links restored from the exact durable handoff receipt'
                        : 'Lifecycle discovery linked to an operator-confirmed sales customer and assessment',
                    '',
                    { salesCustomerId, assessmentId, operationId, operationPayloadHash }
                ));
                observabilityEvents.push({
                    organisationId: organisation.id,
                    agent: 'discovery_scoping_agent',
                    model: 'deterministic',
                    eventType: 'agent.handoff',
                    handoff: 'scoping_prefill_confirmed',
                    outcome: 'success',
                    details: {
                        salesCustomerId,
                        assessmentId,
                        remainingGapCount: Number(input.remainingGapCount || 0)
                    }
                });
                return organisation;
            });

            return {
                revision: result.state.revision,
                organisation: operatorOrganisation(result.result, result.state)
            };
        },

        async unlinkScopingRecords(access, organisationId, input = {}) {
            const auditEvents = [];
            const at = now().toISOString();
            const deletionFenceInput = normaliseScopingDeletionFenceInput(input);
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                const salesCustomerId = cleanText(input.salesCustomerId, 180);
                const currentCustomerId = organisation.links.salesCustomerId || organisation.scope.salesCustomerId;
                if (
                    organisation.recordType !== 'prospect' ||
                    organisation.lifecycleState !== LIFECYCLE_STATES.SCOPING ||
                    organisation.commercialAcceptance && organisation.commercialAcceptance.status === 'verified' ||
                    organisation.scope.proposalId
                ) {
                    throw lifecycleError(
                        409,
                        'Accepted, proposal-bound, onboarding and service records retain their Sales evidence links',
                        'customer_sales_evidence_retention_required'
                    );
                }
                if (salesCustomerId && currentCustomerId && currentCustomerId !== salesCustomerId) {
                    throw lifecycleError(409, 'The lifecycle record is linked to another sales customer', 'scoping_customer_link_conflict');
                }
                const currentAssessmentId = organisation.scope.assessmentId ||
                    organisation.scope.deletionFence && organisation.scope.deletionFence.assessmentId || '';
                const suppliedAssessmentId = cleanText(input.assessmentId, 180);
                if (
                    suppliedAssessmentId &&
                    organisation.scope.assessmentId &&
                    organisation.scope.assessmentId !== suppliedAssessmentId
                ) {
                    throw lifecycleError(409, 'The lifecycle record is linked to another assessment', 'scoping_assessment_link_conflict');
                }
                if (deletionFenceInput) {
                    const fencedCustomerId = salesCustomerId || currentCustomerId ||
                        organisation.scope.deletionFence && organisation.scope.deletionFence.salesCustomerId || '';
                    const fencedAssessmentId = suppliedAssessmentId || currentAssessmentId;
                    assertScopingDeletionFenceAdvance(organisation, deletionFenceInput, {
                        salesCustomerId: fencedCustomerId,
                        assessmentId: fencedAssessmentId
                    });
                    if (!fencedCustomerId || !fencedAssessmentId) {
                        throw lifecycleError(
                            409,
                            'The exact Sales customer and assessment are required to fence lifecycle unlink',
                            'scoping_deletion_links_required'
                        );
                    }
                    organisation.scope.deletionFence = {
                        claimId: deletionFenceInput.claimId,
                        generation: deletionFenceInput.generation,
                        status: 'unlinked',
                        salesCustomerId: fencedCustomerId,
                        assessmentId: fencedAssessmentId,
                        leaseUntil: deletionFenceInput.leaseUntil,
                        unlinkedAt: at,
                        unlinkedBy: access.user.email,
                        compensatedAt: '',
                        compensatedBy: '',
                        completedAt: '',
                        completedBy: ''
                    };
                }
                if (!currentCustomerId && !currentAssessmentId && !deletionFenceInput) return organisation;
                organisation.links.salesCustomerId = '';
                organisation.scope.salesCustomerId = '';
                organisation.scope.assessmentId = '';
                organisation.scope.status = organisation.lifecycleState === LIFECYCLE_STATES.SCOPING ? 'ready' : 'not_started';
                organisation.nextAction = {
                    type: 'review_scoping_link',
                    detail: 'Review whether a new scoping customer should be linked',
                    timing: '',
                    owner: 'operator',
                    dueAt: '',
                    status: 'open'
                };
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'scoping.records_unlinked',
                    organisation,
                    'Deleted sales customer was unlinked from lifecycle scoping',
                    '',
                    {
                        salesCustomerId,
                        deletionClaimId: deletionFenceInput && deletionFenceInput.claimId || '',
                        deletionFenceGeneration: deletionFenceInput && deletionFenceInput.generation || 0
                    }
                ));
                return organisation;
            });
            return {
                revision: result.state.revision,
                organisation: operatorOrganisation(result.result, result.state)
            };
        },

        async completeScopingDeletion(access, organisationId, input = {}) {
            const deletionFenceInput = normaliseScopingDeletionFenceInput(input, { required: true });
            if (!deletionFenceInput) {
                throw lifecycleError(400, 'The exact source deletion fence is required', 'scoping_deletion_fence_required');
            }
            const existingState = await repository.read(access);
            const existingOrganisation = findOrganisation(existingState, organisationId);
            if (completedScopingDeletionReceipt(existingOrganisation, deletionFenceInput)) {
                return {
                    revision: existingState.revision,
                    organisation: operatorOrganisation(existingOrganisation, existingState)
                };
            }
            const auditEvents = [];
            const at = now().toISOString();
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                const organisation = findOrganisation(state, organisationId);
                if (completedScopingDeletionReceipt(organisation, deletionFenceInput)) return organisation;
                const fence = currentScopingDeletionFence(organisation);
                assertExactScopingDeletionFence(fence, deletionFenceInput);
                if (fence.status === 'completed') {
                    recordCompletedScopingDeletionReceipt(organisation, fence, at, access.user.email);
                    return organisation;
                }
                if (!['unlinked', 'compensated'].includes(fence.status)) {
                    throw lifecycleError(
                        409,
                        'Lifecycle deletion can be completed only from its exact fenced unlink or compensation state',
                        'scoping_deletion_state_conflict'
                    );
                }
                if (
                    fence.status === 'compensated' &&
                    !scopingLinksMatch(organisation, fence.salesCustomerId, fence.assessmentId)
                ) {
                    throw lifecycleError(
                        409,
                        'Compensated lifecycle links changed after the deletion fence was recorded',
                        'scoping_deletion_links_conflict'
                    );
                }
                organisation.links.salesCustomerId = '';
                organisation.scope.salesCustomerId = '';
                organisation.scope.assessmentId = '';
                organisation.scope.status = 'ready';
                organisation.scope.deletionFence = Object.assign({}, fence, {
                    status: 'completed',
                    completedAt: at,
                    completedBy: access.user.email
                });
                recordCompletedScopingDeletionReceipt(organisation, fence, at, access.user.email);
                organisation.updatedAt = at;
                organisation.updatedBy = access.user.email;
                auditEvents.push(audit(
                    access,
                    'scoping.deletion_fence_completed',
                    organisation,
                    'Lifecycle scoping unlink finalized after the fenced Sales deletion',
                    '',
                    {
                        salesCustomerId: fence.salesCustomerId,
                        assessmentId: fence.assessmentId,
                        deletionClaimId: fence.claimId,
                        deletionFenceGeneration: fence.generation
                    }
                ));
                return organisation;
            });
            return {
                revision: result.state.revision,
                organisation: operatorOrganisation(result.result, result.state)
            };
        },

        async ensureProspectSession(access, sessionHash, input = {}) {
            const existingState = await repository.read(access);
            const existing = findConversationBySession(existingState, sessionHash, false);
            if (existing) {
                return prospectSessionResponse(existingState, existing);
            }

            const auditEvents = [];
            const at = now().toISOString();
            const admission = normaliseProspectAdmission(input.admission);
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                const concurrent = findConversationBySession(state, sessionHash, false);
                if (concurrent) return concurrent;
                if (admission) {
                    reserveProspectAdmission(state, sessionHash, admission, at);
                }
                const organisation = createLifecycleOrganisation({
                    id: makeId('organisation'),
                    displayName: 'New website prospect',
                    sourceChannel: input.channel === 'voice' ? 'website_voice' : 'website_chat',
                    sourceCampaign: input.campaign,
                    referrer: input.referrer,
                    actorId: 'prospect_agent',
                    now: at
                });
                const conversation = {
                    id: makeId('conversation'),
                    organisationId: organisation.id,
                    sessionHash,
                    channel: input.channel === 'voice' ? 'voice' : 'text',
                    status: 'active',
                    messages: [],
                    summary: '',
                    currentNeed: '',
                    concerns: [],
                    nextAction: { type: 'continue_chat', timing: '', detail: 'Continue discovery' },
                    escalation: { required: false, reason: '', requestedAt: '' },
                    ai: { agent: 'prospect_agent', model: '', runtime: '', confidence: 1, lastRunAt: '' },
                    createdAt: at,
                    updatedAt: at
                };
                state.organisations.push(organisation);
                state.conversations.push(conversation);
                auditEvents.push(audit(access, 'prospect.created', organisation, 'Website prospect session created', conversation.id));
                return conversation;
            });
            return prospectSessionResponse(result.state, result.result);
        },

        async findProspectSession(access, sessionHash) {
            const state = await repository.read(access);
            const conversation = findConversationBySession(state, sessionHash, false);
            return conversation ? prospectSessionResponse(state, conversation) : null;
        },

        async recordProspectSecurityAttempt(access, sessionHash, input = {}) {
            const safeSessionHash = cleanText(sessionHash, 128).toLowerCase();
            const clientKeyHash = cleanText(input.clientKeyHash, 128).toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(safeSessionHash) || !/^[a-f0-9]{64}$/.test(clientKeyHash)) {
                throw lifecycleError(503, 'Prospect security monitoring is not configured', 'prospect_security_not_configured');
            }
            const at = now();
            const atMs = at.getTime();
            const createdAt = at.toISOString();
            const expiresAt = new Date(atMs + retentionPolicy.prospectSecurityDays * 86400000).toISOString();
            const signals = cleanStringList(input.signals, 8, 80);
            const detectorVersion = cleanText(input.detectorVersion || 'classic_v1', 80);
            const auditEvents = [];
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                if (!findConversationBySession(state, safeSessionHash, false)) {
                    throw lifecycleError(
                        404,
                        'Prospect conversation not found',
                        'conversation_not_found'
                    );
                }
                state.prospectSecurityEvents = (Array.isArray(state.prospectSecurityEvents) ? state.prospectSecurityEvents : [])
                    .filter((event) => Date.parse(event.expiresAt) > atMs);
                const counterCutoff = atMs - PROSPECT_SECURITY_COUNTER_WINDOW_MS;
                const tenantRecent = state.prospectSecurityEvents.filter((event) => (
                    event.category === 'prompt_injection' && Date.parse(event.createdAt) >= counterCutoff
                ));
                if (tenantRecent.length >= PROSPECT_SECURITY_TENANT_DAILY_MAX) {
                    throw lifecycleError(
                        429,
                        'Prospect security telemetry quota reached',
                        'prospect_security_persistence_quota',
                        { scope: 'tenant' }
                    );
                }
                const sessionRecent = tenantRecent.filter((event) => event.sessionHash === safeSessionHash);
                const clientRecent = tenantRecent.filter((event) => event.clientKeyHash === clientKeyHash);
                if (
                    sessionRecent.length >= PROSPECT_SECURITY_IDENTITY_DAILY_MAX ||
                    clientRecent.length >= PROSPECT_SECURITY_IDENTITY_DAILY_MAX
                ) {
                    throw lifecycleError(
                        429,
                        'Prospect security telemetry quota reached',
                        'prospect_security_persistence_quota',
                        { scope: 'identity' }
                    );
                }
                const recent = tenantRecent.filter((event) => (
                    event.sessionHash === safeSessionHash || event.clientKeyHash === clientKeyHash
                ));
                const attemptOrdinal = Math.min(recent.length + 1, 999);
                const event = {
                    id: makeId('security_event'),
                    sessionHash: safeSessionHash,
                    clientKeyHash,
                    category: 'prompt_injection',
                    detectorVersion,
                    signals,
                    attemptOrdinal,
                    networkIdentifierAvailable: Boolean(input.networkIdentifierAvailable),
                    action: attemptOrdinal > 1 ? 'strong_warn' : 'warn',
                    createdAt,
                    expiresAt
                };
                state.prospectSecurityEvents.push(event);
                auditEvents.push({
                    actorType: 'system',
                    actorId: 'prospect_security_guard',
                    actorRole: 'public_agent',
                    action: 'prospect.prompt_injection_blocked',
                    targetType: 'security_event',
                    targetId: event.id,
                    summary: 'Public assistant blocked an instruction-manipulation attempt',
                    details: {
                        detectorVersion,
                        signals,
                        attemptOrdinal,
                        networkIdentifierRecorded: event.networkIdentifierAvailable
                    }
                });
                return event;
            });
            return {
                recorded: true,
                attemptOrdinal: result.result.attemptOrdinal,
                action: result.result.action,
                networkIdentifierRecorded: result.result.networkIdentifierAvailable
            };
        },

        async appendProspectMessage(access, sessionHash, role, text) {
            const at = now().toISOString();
            const auditEvents = [];
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                const conversation = findConversationBySession(state, sessionHash);
                const organisation = findOrganisation(state, conversation.organisationId);
                const message = {
                    id: makeId('message'),
                    role: role === 'assistant' ? 'assistant' : 'user',
                    text: cleanText(text, 4000),
                    at
                };
                if (!message.text) {
                    throw lifecycleError(400, 'A message is required', 'message_required');
                }
                conversation.messages.push(message);
                conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
                conversation.updatedAt = at;
                organisation.updatedAt = at;
                organisation.updatedBy = role === 'assistant' ? 'prospect_agent' : 'website_visitor';
                auditEvents.push(audit(
                    access,
                    role === 'assistant' ? 'conversation.assistant_message' : 'conversation.visitor_message',
                    organisation,
                    role === 'assistant' ? 'Prospect agent replied' : 'Visitor message recorded',
                    conversation.id
                ));
                return { conversation, organisation, message };
            });
            return {
                revision: result.state.revision,
                conversation: publicConversation(result.result.conversation),
                organisation: buildContextSnapshot(result.result.organisation)
            };
        },

        async executeProspectTool(access, sessionHash, toolName, args = {}, metadata = {}) {
            const at = now().toISOString();
            const auditEvents = [];
            const observabilityEvents = [];
            const result = await repository.mutate(access, { auditEvents, observabilityEvents }, async (state) => {
                const conversation = findConversationBySession(state, sessionHash);
                const organisation = findOrganisation(state, conversation.organisationId);
                let output;

                if (toolName === 'update_prospect_context') {
                    output = applyContextFacts(organisation, args.facts, {
                        actorId: 'prospect_agent',
                        source: 'website_conversation',
                        at
                    });
                } else if (toolName === 'record_conversation_summary') {
                    conversation.summary = cleanText(args.summary, 4000);
                    conversation.currentNeed = cleanText(args.currentNeed, 1000);
                    conversation.concerns = cleanStringList(args.concerns, 40, 500);
                    organisation.discovery.summary = conversation.summary;
                    output = { saved: true };
                } else if (toolName === 'suggest_next_action') {
                    conversation.nextAction = normaliseConversationNextAction(args);
                    const operatorOwned = ['human_follow_up', 'start_scoping'].includes(conversation.nextAction.type);
                    organisation.nextAction = Object.assign({}, organisation.nextAction, {
                        type: conversation.nextAction.type,
                        detail: conversation.nextAction.detail,
                        timing: conversation.nextAction.timing,
                        owner: operatorOwned ? 'operator' : 'prospect_agent',
                        status: 'open'
                    });
                    if (conversation.nextAction.type === 'human_follow_up') {
                        conversation.escalation = {
                            required: true,
                            reason: conversation.nextAction.detail,
                            requestedAt: at
                        };
                    }
                    output = { saved: true, action: conversation.nextAction };
                } else if (toolName === 'advance_lifecycle') {
                    transitionLifecycle(organisation, args.targetState, {
                        actorId: 'prospect_agent',
                        at,
                        publicAgent: true
                    });
                    output = { lifecycleState: organisation.lifecycleState };
                } else {
                    throw lifecycleError(403, 'The prospect agent is not permitted to use that tool', 'tool_not_permitted');
                }

                conversation.updatedAt = at;
                organisation.updatedAt = at;
                organisation.updatedBy = 'prospect_agent';
                auditEvents.push(audit(access, 'agent.tool_executed', organisation, `${toolName} completed`, conversation.id, {
                    tool: toolName,
                    permission: 'autonomous_record'
                }));
                const task = ensureDiscoveryScopingTask(state, organisation, conversation, {
                    makeId,
                    at,
                    auditEvents,
                    backfilled: false
                });
                if (task && output && typeof output === 'object') {
                    output.operatorTaskId = task.id;
                }
                observabilityEvents.push(observation(organisation, conversation, metadata, {
                    eventType: 'tool.call',
                    tool: toolName,
                    outcome: 'success',
                    latencyMs: metadata.latencyMs
                }));
                observabilityEvents.push(observation(organisation, conversation, metadata, {
                    eventType: 'tool.result',
                    tool: toolName,
                    outcome: 'success',
                    details: toolResultDetails(toolName, output)
                }));
                return { conversation, organisation, output };
            });

            return {
                revision: result.state.revision,
                output: result.result.output,
                context: buildContextSnapshot(result.result.organisation),
                conversation: publicConversation(result.result.conversation)
            };
        },

        async recordAgentRun(access, sessionHash, metadata = {}) {
            const at = now().toISOString();
            const observabilityEvents = [];
            const result = await repository.mutate(access, { observabilityEvents }, async (state) => {
                const conversation = findConversationBySession(state, sessionHash);
                const organisation = findOrganisation(state, conversation.organisationId);
                conversation.ai = Object.assign({}, conversation.ai, {
                    agent: cleanText(metadata.agent || 'prospect_agent', 120),
                    model: cleanText(metadata.model, 120),
                    runtime: cleanText(metadata.runtime, 80),
                    promptVersion: cleanText(metadata.promptVersion, 120),
                    toolSchemaVersion: cleanText(metadata.toolSchemaVersion, 120),
                    policyId: cleanText(metadata.policyId, 120),
                    policyVersion: cleanText(metadata.policyVersion, 120),
                    confidence: normaliseConfidence(metadata.confidence),
                    lastRunAt: at
                });
                conversation.updatedAt = at;
                observabilityEvents.push(observation(organisation, conversation, metadata, {
                    eventType: metadata.eventType || 'agent.run',
                    outcome: metadata.outcome || 'success',
                    latencyMs: metadata.latencyMs,
                    errorCode: metadata.errorCode,
                    escalation: conversation.escalation.required
                }));
                return { conversation, organisation };
            });
            return prospectSessionResponse(result.state, result.result.conversation);
        },

        async getProspectSession(access, sessionHash) {
            const state = await repository.read(access);
            const conversation = findConversationBySession(state, sessionHash);
            return prospectSessionResponse(state, conversation);
        },

        async getSharedContext(access, organisationId) {
            const state = await repository.read(access);
            const organisation = findLinkedOrganisation(state, organisationId, false);
            return organisation ? buildContextSnapshot(organisation) : null;
        },

        async recordServiceEvent(access, customerId, input = {}) {
            const externalCustomerId = cleanText(customerId, 180);
            if (!externalCustomerId) {
                throw lifecycleError(400, 'A service-desk customer link is required', 'service_customer_required');
            }
            const initialState = await repository.read(access);
            if (!findLinkedOrganisation(initialState, externalCustomerId, false)) {
                return {
                    revision: initialState.revision,
                    linked: false,
                    reason: 'organisation_not_linked'
                };
            }

            const event = normaliseSupportEvidenceEvent(Object.assign({}, input, {
                occurredAt: input.occurredAt || now().toISOString()
            }));
            if (!event) {
                throw lifecycleError(400, 'The service evidence event is invalid', 'service_evidence_invalid');
            }
            const recordedAt = now().toISOString();
            if (Date.parse(event.occurredAt) > Date.parse(recordedAt) + (5 * 60 * 1000)) {
                throw lifecycleError(400, 'Service evidence cannot be dated in the future', 'service_evidence_future_timestamp');
            }

            const auditEvents = [];
            const result = await repository.mutate(access, { auditEvents }, async (state) => {
                const organisation = findLinkedOrganisation(state, externalCustomerId);
                const existing = organisation.support.evidence.find((item) => item.id === event.id);
                if (!existing) {
                    organisation.support.evidence.push(event);
                    organisation.support.evidence = organisation.support.evidence.slice(-500);
                }
                organisation.support.ticketIds = cleanStringList(
                    organisation.support.ticketIds.concat(event.ticketId),
                    500,
                    180
                );
                if (!organisation.support.lastTicketAt || event.occurredAt > organisation.support.lastTicketAt) {
                    organisation.support.lastTicketAt = event.occurredAt;
                }
                organisation.support.recurringThemes = recurringSupportThemes(organisation.support.evidence);
                organisation.updatedAt = String(organisation.updatedAt || '').localeCompare(recordedAt) >= 0
                    ? organisation.updatedAt
                    : recordedAt;
                organisation.updatedBy = 'service_desk';
                if (!existing) {
                    auditEvents.push(audit(
                        access,
                        'support.evidence_recorded',
                        organisation,
                        'Service-desk outcome added to the customer proof record',
                        '',
                        { ticketId: event.ticketId, eventType: event.type, simulated: event.simulated }
                    ));
                }
                return { organisation, event: existing || event, created: !existing };
            });
            return {
                revision: result.state.revision,
                linked: true,
                created: result.result.created,
                event: result.result.event,
                organisation: buildContextSnapshot(result.result.organisation)
            };
        }
    };
}

function internalPilotCustomerMaster(options) {
    const master = createEmptyCustomerMaster(options.at);
    master.customerId = options.organisation.id;
    master.identity = {
        legalName: options.organisation.displayName,
        tradingName: options.organisation.displayName,
        domains: []
    };
    const contact = {
        name: options.primaryName,
        email: options.primaryEmail,
        phone: '',
        role: 'Internal pilot owner',
        evidenceRef: `internal-pilot-confirmation:${options.organisation.id}`
    };
    master.contacts = {
        sponsor: Object.assign({}, contact),
        technical: Object.assign({}, contact),
        security: Object.assign({}, contact),
        billing: Object.assign({}, contact),
        emergencyAfterHours: Object.assign({}, contact)
    };
    master.authority = {
        authorityMatrixVersion: 'internal-pilot-v1',
        acceptedBy: options.primaryEmail,
        acceptedAt: options.at,
        evidenceRef: contact.evidenceRef
    };
    master.serviceSchedule = {
        agreementId: `internal-pilot:${options.organisation.id}`,
        version: 'internal-pilot-v1',
        contentHash: options.proposalSha256,
        startAt: options.at,
        endAt: '',
        supportHours: 'No Fries controlled business-hours internal pilot',
        slaId: 'internal-pilot-sla-v1',
        timezone: 'Pacific/Auckland'
    };
    master.entitlements = [{
        code: 'managed_endpoint_internal_pilot',
        name: 'Managed internal-pilot endpoint',
        quantity: options.expectedEndpoints,
        effectiveFrom: options.at,
        effectiveTo: ''
    }];
    master.estate = {
        contractedUsers: options.expectedUsers,
        contractedEndpoints: options.expectedEndpoints,
        plannedDevices: options.plannedDeviceCount
    };
    master.billing = {
        profileId: `internal-pilot-no-charge:${options.organisation.id}`,
        currency: 'NZD',
        taxTreatment: 'internal_no_charge',
        billingCadence: 'monthly'
    };
    master.governance = {
        serviceOwner: options.actor,
        proofDueRule: 'monthly',
        nextReviewAt: new Date(Date.parse(options.at) + (30 * 24 * 60 * 60 * 1000)).toISOString()
    };
    master.externalRefs = [{
        id: `external_ref_sales_${options.organisation.id}`,
        system: 'sales_workspace',
        recordType: 'customer',
        externalId: options.organisation.id,
        providerScopeId: '',
        status: 'verified',
        verificationMode: 'manual',
        verifiedAt: options.at,
        verifiedBy: options.actor,
        evidenceRef: `internal-pilot-confirmation:${options.organisation.id}`,
        createdAt: options.at,
        retiredAt: '',
        retiredBy: '',
        retirementReason: ''
    }];
    master.revision = 1;
    return master;
}

function internalPilotSupportProfile(options) {
    return normaliseSupportProfile({
        contractStatus: 'signed',
        serviceStartAt: options.at,
        slaScheduleRef: `internal-pilot-sla:${options.organisationId}`,
        slaVersion: 'internal-pilot-v1',
        timezone: 'Pacific/Auckland',
        supportHours: 'No Fries controlled business hours',
        channels: ['portal', 'email'],
        authorisedRequesters: [{
            name: options.primaryName,
            email: options.primaryEmail,
            role: 'Internal pilot owner',
            verificationMethod: 'Microsoft identity and internal-pilot confirmation',
            evidenceRef: `internal-pilot-confirmation:${options.organisationId}`,
            effectiveFrom: options.at,
            canApproveRiskyActions: true
        }],
        revision: 1,
        updatedAt: options.at,
        updatedBy: options.primaryEmail
    });
}

function normaliseAcceptanceInput(input, access, at, makeId) {
    const proposalId = cleanText(input.proposalId, 180);
    const proposalVersion = cleanText(input.proposalVersion, 120);
    const proposalSha256 = normaliseSha256(input.proposalSha256);
    const acceptedAt = validIsoDate(input.acceptedAt);
    const effectiveDate = validIsoDate(input.effectiveDate);
    const signatoryName = cleanText(input.signatoryName, 180);
    const signatoryEmail = cleanText(input.signatoryEmail, 254).toLowerCase();
    const signatoryTitle = cleanText(input.signatoryTitle, 180);
    const authorityBasis = cleanText(input.authorityBasis, 240);
    const authorityEvidenceId = cleanEvidenceReference(input.authorityEvidenceId);
    const authorityEvidenceSha256 = normaliseSha256(input.authorityEvidenceSha256);
    if (
        !proposalId || !proposalVersion || !proposalSha256 || !acceptedAt || !effectiveDate ||
        !signatoryName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signatoryEmail) || !signatoryTitle ||
        !authorityBasis || !authorityEvidenceId || !authorityEvidenceSha256
    ) {
        throw lifecycleError(400, 'Complete the proposal, signatory and authority evidence fields', 'commercial_acceptance_fields_required');
    }
    if (Date.parse(acceptedAt) > Date.parse(at) + (5 * 60 * 1000)) {
        throw lifecycleError(400, 'Acceptance cannot be dated in the future', 'commercial_acceptance_time_invalid');
    }
    const fingerprint = canonicalHash({
        proposalId,
        proposalVersion,
        proposalSha256,
        acceptedAt,
        effectiveDate,
        signatoryEmail,
        authorityEvidenceId,
        authorityEvidenceSha256
    });
    return {
        id: makeId('acceptance'),
        idempotencyKey: cleanIdempotencyKey(input.idempotencyKey),
        kind: 'external',
        status: 'verified',
        source: input.source === 'hubspot' ? 'hubspot' : 'manual',
        sourceEventId: cleanText(input.sourceEventId, 220),
        proposalId,
        proposalVersion,
        proposalSha256,
        acceptedAt,
        effectiveDate,
        signatory: { name: signatoryName, email: signatoryEmail, title: signatoryTitle },
        authority: { basis: authorityBasis, evidenceId: authorityEvidenceId, evidenceSha256: authorityEvidenceSha256 },
        recordedBy: access.user.email,
        recordedAt: at,
        fingerprint
    };
}

function assertApprovedProposalVerified(verification) {
    if (verification && verification.verified === true) return verification;
    const code = verification && verification.code;
    if (code === 'approved_proposal_unsealed') {
        throw lifecycleError(
            409,
            'The approved proposal is not sealed; create and approve a new proposal version',
            'approved_proposal_unsealed'
        );
    }
    if (code === 'approved_proposal_not_found') {
        throw lifecycleError(409, 'The approved proposal could not be found', 'approved_proposal_not_found');
    }
    throw lifecycleError(
        409,
        'The proposal does not match the sealed Sales customer and assessment binding',
        'approved_proposal_binding_mismatch'
    );
}

function normaliseCustomerMasterInput(value, supportProfile, devices, access, at) {
    const source = value && typeof value === 'object' ? value : {};
    const rawEntitlements = Array.isArray(source.entitlements) ? source.entitlements : [];
    if (rawEntitlements.length > MAX_CUSTOMER_MASTER_ENTITLEMENTS) {
        throw lifecycleError(
            400,
            'Customer-master entitlements exceed the governed limit',
            'customer_master_entitlement_limit_exceeded',
            { maximumEntitlements: MAX_CUSTOMER_MASTER_ENTITLEMENTS, submittedEntitlements: rawEntitlements.length }
        );
    }
    const acceptedSource = Object.assign({}, source);
    delete acceptedSource.entitlementsOverflow;
    const master = normaliseCustomerMaster(Object.assign({}, acceptedSource, {
        createdAt: source.createdAt || at,
        updatedAt: at,
        revision: Math.max(1, Number(source.revision || 0))
    }), at);
    master.governance.serviceOwner = master.governance.serviceOwner || access.user.email;
    master.estate.plannedDevices = devices.length;
    if (master.estate.contractedEndpoints == null) master.estate.contractedEndpoints = devices.length;
    if (!master.serviceSchedule.timezone) master.serviceSchedule.timezone = normaliseSupportProfile(supportProfile).timezone;
    return master;
}

function assertOnboardingMasterInput(master, support, devices, options = {}) {
    const missing = [];
    if (!master.identity.legalName) missing.push('legal_name');
    for (const role of ['sponsor', 'security', 'billing', 'emergencyAfterHours']) {
        const contact = master.contacts[role];
        if (!contact.name || !contact.email) missing.push(`${role}_contact`);
    }
    if (!master.serviceSchedule.agreementId || !master.serviceSchedule.version || !master.serviceSchedule.contentHash) missing.push('signed_service_schedule');
    if (!master.serviceSchedule.startAt || !master.serviceSchedule.slaId || !master.serviceSchedule.supportHours) missing.push('service_schedule_terms');
    if (!master.entitlements.length) missing.push('entitlements');
    if (!master.billing.profileId || !master.billing.billingCadence) missing.push('billing_profile');
    if (!options.skipSupportProfile && (
        support.contractStatus !== 'signed' || !support.slaScheduleRef || !support.authorisedRequesters.length
    )) missing.push('support_profile');
    if (!devices.length || master.estate.contractedEndpoints == null || master.estate.contractedEndpoints < devices.length) {
        missing.push('representative_device_plan');
    }
    const verified = master.externalRefs.filter((item) => item.status === 'verified');
    const hubspotCompanies = verified.filter((item) => item.system === 'hubspot' && item.recordType === 'company');
    const autotaskAccounts = verified.filter((item) => item.system === 'autotask' && item.recordType === 'account');
    if (hubspotCompanies.length !== 1) missing.push(hubspotCompanies.length ? 'hubspot_company_crosswalk_ambiguous' : 'hubspot_company_crosswalk');
    if (autotaskAccounts.length !== 1) missing.push(autotaskAccounts.length ? 'autotask_account_crosswalk_ambiguous' : 'autotask_account_crosswalk');
    if (missing.length) {
        throw lifecycleError(409, 'Complete the required customer master before onboarding', 'customer_master_incomplete', { missing });
    }
}

function assertCustomerChangeState(organisation) {
    if (organisation.recordType !== 'customer' || organisation.lifecycleState === LIFECYCLE_STATES.FORMER) {
        throw lifecycleError(
            409,
            'Customer profile changes are allowed only for a retained customer record before it becomes former',
            'customer_change_state_required'
        );
    }
}

function assertSupportProfileChange(profile) {
    if (profile.serviceStartAt && profile.serviceEndAt && Date.parse(profile.serviceEndAt) <= Date.parse(profile.serviceStartAt)) {
        throw lifecycleError(400, 'The support service end must be after its start', 'support_profile_schedule_invalid');
    }
    if (profile.contractStatus !== 'signed') return;
    const requestersValid = profile.authorisedRequesters.length > 0 && profile.authorisedRequesters.every((requester) => (
        requester.name && requester.email && requester.verificationMethod && requester.evidenceRef
    ));
    if (
        !profile.serviceStartAt || !profile.slaScheduleRef || !profile.slaVersion ||
        !profile.supportHours || !profile.channels.length || !requestersValid
    ) {
        throw lifecycleError(
            409,
            'A signed support profile requires current SLA terms, channels and evidence-backed authorised requesters',
            'support_profile_incomplete'
        );
    }
}

function invalidatePendingActivationForCustomerChange(organisation, at) {
    if (organisation.onboarding && organisation.onboarding.planId) {
        organisation.onboarding.planRevision = Number(organisation.onboarding.planRevision || 0) + 1;
        revokeOpenActivationRequests(organisation, at);
        refreshCustomerOnboarding(organisation, at);
    }
}

function assertExternalReferenceAvailable(state, organisation, reference) {
    const key = externalReferenceKey(reference);
    const conflict = state.organisations.find((item) => (
        item.id !== organisation.id &&
        (item.customerMaster && item.customerMaster.externalRefs || []).some((candidate) => (
            candidate.status !== 'retired' && externalReferenceKey(candidate) === key
        ))
    ));
    if (conflict) {
        throw lifecycleError(409, 'This provider record is already mapped to another customer', 'external_reference_conflict', {
            system: reference.system,
            recordType: reference.recordType,
            conflictingOrganisationId: conflict.id
        });
    }
}

function isGovernedVerifiedExternalReference(value, at) {
    const reference = normaliseExternalReference(value);
    const verifiedAt = Date.parse(reference && reference.verifiedAt || '');
    return Boolean(
        reference &&
        reference.status === 'verified' &&
        Number.isFinite(verifiedAt) &&
        verifiedAt <= Date.parse(at) + (5 * 60 * 1000) &&
        reference.verifiedBy &&
        reference.evidenceRef
    );
}

function upsertExternalReference(state, organisation, value) {
    const reference = normaliseExternalReference(value);
    if (!reference) throw lifecycleError(400, 'A typed external reference is required', 'external_reference_invalid');
    assertExternalReferenceAvailable(state, organisation, reference);
    organisation.customerMaster = organisation.customerMaster || createEmptyCustomerMaster();
    organisation.customerMaster.externalRefs = Array.isArray(organisation.customerMaster.externalRefs)
        ? organisation.customerMaster.externalRefs
        : [];
    assertExternalReferenceSlotAvailable(organisation, reference);
    const key = externalReferenceKey(reference);
    const existing = organisation.customerMaster.externalRefs.find((item) => externalReferenceKey(item) === key);
    if (existing) {
        if (existing.status === 'verified' && reference.status === 'pending') return existing;
        Object.assign(existing, reference, { id: existing.id, createdAt: existing.createdAt || reference.createdAt });
    } else {
        organisation.customerMaster.externalRefs.push(reference);
    }
    const saved = existing || reference;
    if (saved.status === 'verified') {
        if (saved.system === 'sales_workspace' && saved.recordType === 'customer') organisation.links.salesCustomerId = saved.externalId;
        if (saved.system === 'autotask' && saved.recordType === 'account') organisation.links.serviceDeskCustomerId = saved.externalId;
        if (saved.system === 'datto_rmm' && saved.recordType === 'site') organisation.links.dattoRmmSiteUid = saved.externalId;
    }
    return saved;
}

function assertExternalReferenceSlotAvailable(organisation, reference) {
    const singletonSlots = new Set([
        'hubspot:company',
        'autotask:account',
        'datto_rmm:site',
        'kaseya_mdr:tenant',
        'kaseya_mdr:organisation',
        'backup:tenant'
    ]);
    if (reference.status === 'retired' || !singletonSlots.has(`${reference.system}:${reference.recordType}`)) return;
    const providerScopeId = cleanText(reference.providerScopeId, 180).toLowerCase();
    const conflicting = (organisation.customerMaster.externalRefs || []).find((candidate) => (
        candidate.status !== 'retired' &&
        candidate.system === reference.system &&
        candidate.recordType === reference.recordType &&
        cleanText(candidate.providerScopeId, 180).toLowerCase() === providerScopeId &&
        externalReferenceKey(candidate) !== externalReferenceKey(reference)
    ));
    if (conflicting) {
        throw lifecycleError(
            409,
            'Retire the existing customer-system mapping before verifying a replacement',
            'external_reference_slot_conflict',
            { existingReferenceId: conflicting.id, system: reference.system, recordType: reference.recordType }
        );
    }
}

function normaliseDattoDevices(value) {
    return (Array.isArray(value) ? value : []).slice(0, 2500).map((item) => ({
        uid: cleanText(item && (item.uid || item.deviceUid), 180),
        hostname: cleanText(item && item.hostname, 240),
        operatingSystem: cleanText(item && (item.operatingSystem || item.os), 240),
        lastSeen: validIsoDate(item && item.lastSeen),
        online: item && item.online === true
    })).filter((item) => item.uid);
}

function refreshCustomerOnboarding(organisation, at) {
    if (organisation.onboarding && organisation.onboarding.planVersion) {
        return evaluateOnboarding(organisation, at);
    }
    refreshOnboardingProgress(organisation);
    return { readyForActivation: false, missing: ['legacy_onboarding_plan'] };
}

function revokeOpenActivationRequests(organisation, at) {
    for (const request of organisation.activationRequests || []) {
        if (!['pending', 'approved'].includes(request.status)) continue;
        request.status = 'revoked';
        request.revokedAt = at;
    }
    if (organisation.onboarding) organisation.onboarding.activationRequestId = '';
    const gate = organisation.onboarding && organisation.onboarding.gates.find((item) => item.id === GATE_IDS.G5);
    if (gate && gate.status !== 'complete') {
        gate.status = 'pending';
        gate.completedAt = '';
        gate.completedBy = '';
        gate.blockedReason = 'Onboarding evidence changed; request a new activation';
    }
}

function normaliseOnboardingEvidence(input, access, at, makeId) {
    const sourceMode = ['live', 'manual', 'simulated'].includes(input.sourceMode) ? input.sourceMode : 'manual';
    const reference = cleanEvidenceReference(input.evidenceRef || input.reference);
    const capturedAt = validIsoDate(input.capturedAt) || at;
    const checksum = normaliseSha256(input.checksum);
    if (!reference || !checksum || sourceMode === 'simulated') {
        throw lifecycleError(400, 'Onboarding evidence requires a non-simulated reference and SHA-256 checksum', 'onboarding_evidence_invalid');
    }
    if (Date.parse(capturedAt) > Date.parse(at) + (5 * 60 * 1000)) {
        throw lifecycleError(400, 'Onboarding evidence cannot be dated in the future', 'onboarding_evidence_time_invalid');
    }
    const customerAcceptedAt = validIsoDate(input.customerAcceptedAt);
    if (customerAcceptedAt && Date.parse(customerAcceptedAt) > Date.parse(at) + (5 * 60 * 1000)) {
        throw lifecycleError(
            400,
            'Customer monitoring acceptance cannot be dated in the future',
            'monitoring_customer_acceptance_time_invalid'
        );
    }
    if (customerAcceptedAt && Date.parse(customerAcceptedAt) > Date.parse(capturedAt)) {
        throw lifecycleError(
            400,
            'Customer monitoring acceptance must not be later than its captured evidence',
            'monitoring_customer_acceptance_order_invalid'
        );
    }
    const validUntil = validIsoDate(input.validUntil);
    if (validUntil && Date.parse(validUntil) <= Date.parse(at)) {
        throw lifecycleError(409, 'Onboarding evidence has already expired', 'onboarding_evidence_stale');
    }
    return {
        id: cleanText(input.evidenceId, 180) || makeId('evidence'),
        type: cleanText(input.evidenceType || 'onboarding_attestation', 120),
        source: cleanText(input.source || 'operator', 120),
        sourceMode,
        reference,
        checksum,
        capturedAt,
        validUntil,
        customerAcceptedAt,
        recordedBy: access.user.email
    };
}

function activationFingerprint(organisation, customerAuthorityRef) {
    return canonicalHash({
        organisationId: organisation.id,
        planId: organisation.onboarding.planId,
        planRevision: organisation.onboarding.planRevision,
        gates: organisation.onboarding.gates.slice(0, 5).map((gate) => ({
            id: gate.id,
            status: gate.status,
            evidence: (gate.evidenceRefs || []).map((item) => ({ id: item.id, checksum: item.checksum, validUntil: item.validUntil }))
        })),
        devices: organisation.onboarding.devices.map((device) => ({
            id: device.id,
            status: device.status,
            matchStatus: device.matchStatus,
            providerRefs: device.providerRefs
        })),
        customerMasterRevision: organisation.customerMaster.revision,
        dattoSnapshotSha256: organisation.integrations.dattoRmm.snapshotSha256,
        customerAuthorityRef
    });
}

function findActivationRequest(organisation, requestId) {
    const request = (organisation.activationRequests || []).find((item) => item.id === cleanText(requestId, 180));
    if (!request) throw lifecycleError(404, 'Activation request not found', 'activation_request_not_found');
    return request;
}

function normaliseProofPeriod(value, at, timezone) {
    const requested = normaliseRequestedProofPeriod(value);
    return requested || lastCompletedProofPeriod(at, timezone);
}

function normaliseRequestedProofPeriod(value) {
    const requested = String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim();
    const parsed = requested ? parseProofPeriod(requested) : null;
    if (requested && !parsed) {
        throw lifecycleError(400, 'Proof period must use YYYY-MM', 'proof_period_invalid');
    }
    return parsed ? parsed.period : '';
}

function lastCompletedProofPeriod(at, timezone) {
    const period = governedProofPeriods(at, timezone)[1];
    if (!period) {
        throw lifecycleError(
            409,
            'Proof cannot be selected until its customer timezone is valid',
            'proof_timezone_invalid',
            { timezone: cleanText(timezone, 80) }
        );
    }
    return period;
}

function organisationProofTimezone(organisation) {
    return organisation && organisation.supportProfile && organisation.supportProfile.timezone ||
        organisation && organisation.customerMaster && organisation.customerMaster.serviceSchedule && organisation.customerMaster.serviceSchedule.timezone ||
        'Pacific/Auckland';
}

function findOrBuildProof(organisation, period, at) {
    return organisation.proofPeriods.find((item) => item.period === period) || createProofPeriod(organisation, period, at);
}

function proofWithGroundwork(organisation, proof, at) {
    const view = proofRequirementView(organisation, proof, at);
    const coverage = proofPeriodBounds(view.period, view.timezone || 'Pacific/Auckland');
    return Object.assign({}, view, {
        coverage: coverage ? {
            periodStart: coverage.periodStart,
            periodEnd: coverage.periodEnd
        } : null,
        readiness: proofReadiness(view, at),
        narrativeGroundwork: buildProofNarrativeGroundwork(view, at)
    });
}

function proofRequirementView(organisation, proof, at) {
    if (['approved', 'issued'].includes(proof.status)) {
        return Object.assign({}, proof, {
            unresolvedEntitlements: [],
            requirementHistoryComplete: true,
            entitlementCodesOverflow: false
        });
    }
    const resolution = resolveOrganisationProofRequirementsForPeriod(
        organisation,
        proof.period,
        proof.timezone || organisation.supportProfile && organisation.supportProfile.timezone || 'Pacific/Auckland'
    );
    return Object.assign({}, proof, {
        requiredSources: mergeProofSources(proof.requiredSources, resolution.requiredSources),
        unresolvedEntitlements: resolution.unresolvedEntitlements,
        requirementHistoryComplete: resolution.requirementHistoryComplete,
        entitlementCodesOverflow: resolution.entitlementCodesOverflow === true
    });
}

function reconcileMutableProofRequirements(organisation, proof, at) {
    const view = proofRequirementView(organisation, proof, at);
    if (['approved', 'issued'].includes(proof.status)) {
        return { view, changed: false, addedSources: [], unresolvedEntitlements: [] };
    }
    const previousSources = Array.isArray(proof.requiredSources) ? proof.requiredSources.slice() : [];
    const addedSources = view.requiredSources.filter((source) => !previousSources.includes(source));
    const sourcesChanged = canonicalHash(previousSources) !== canonicalHash(view.requiredSources);
    const readiness = proofReadiness(view, at);
    const nextStatus = proof.status === 'collecting' ? 'collecting' : readiness.ready ? 'ready' : 'incomplete';
    const statusChanged = proof.status !== nextStatus;
    if (sourcesChanged) proof.requiredSources = view.requiredSources;
    if (statusChanged) proof.status = nextStatus;
    if (sourcesChanged || statusChanged) proof.updatedAt = at;
    return {
        view: Object.assign({}, proof, {
            unresolvedEntitlements: view.unresolvedEntitlements,
            requirementHistoryComplete: view.requirementHistoryComplete,
            entitlementCodesOverflow: view.entitlementCodesOverflow === true
        }),
        changed: sourcesChanged || statusChanged,
        addedSources,
        unresolvedEntitlements: view.unresolvedEntitlements
    };
}

function reconcileOrganisationProofRequirements(organisation, at) {
    const addedSources = new Set();
    const unresolvedEntitlements = new Set();
    (organisation.proofPeriods || []).forEach((proof) => {
        const result = reconcileMutableProofRequirements(organisation, proof, at);
        result.addedSources.forEach((source) => addedSources.add(source));
        result.unresolvedEntitlements.forEach((code) => unresolvedEntitlements.add(code));
    });
    return {
        addedSources: PROOF_SOURCES.filter((source) => addedSources.has(source)),
        unresolvedEntitlements: Array.from(unresolvedEntitlements).sort()
    };
}

function refreshExistingMonthlyProofSchedule(state, organisation, at) {
    const schedule = state.schedules.find((item) => (
        item.organisationId === organisation.id && item.jobType === 'monthly_proof'
    ));
    if (!schedule) return false;
    const resolution = resolveProofRequirementsForEntitlements(
        organisation.customerMaster && organisation.customerMaster.entitlements,
        at
    );
    if (canonicalHash(schedule.requiredSources) === canonicalHash(resolution.requiredSources)) return false;
    schedule.requiredSources = resolution.requiredSources;
    schedule.updatedAt = at;
    schedule.revision = Number(schedule.revision || 0) + 1;
    return true;
}

function mergeProofSources(existing, required) {
    const selected = new Set([].concat(Array.isArray(existing) ? existing : [], Array.isArray(required) ? required : []));
    return PROOF_SOURCES.filter((source) => selected.has(source));
}

function createProofPeriod(organisation, period, at) {
    const timezone = organisationProofTimezone(organisation);
    const requirements = resolveOrganisationProofRequirementsForPeriod(
        organisation,
        period,
        timezone
    );
    return normaliseProofPeriods([{
        id: `proof_${organisation.id}_${period}`,
        customerId: organisation.customerMaster.customerId || organisation.id,
        period,
        timezone,
        status: 'collecting',
        requiredSources: requirements.requiredSources,
        evidenceRefs: [],
        createdAt: at,
        updatedAt: at
    }])[0];
}

function proofEntitlementsForOrganisation(organisation) {
    const entitlements = [];
    (Array.isArray(organisation.customerMasterHistory) ? organisation.customerMasterHistory : []).forEach((entry) => {
        const snapshot = entry && entry.snapshot || {};
        const snapshotEnd = Date.parse(entry && entry.changedAt || '');
        (Array.isArray(snapshot.entitlements) ? snapshot.entitlements : []).forEach((entitlement) => {
            const copy = Object.assign({}, entitlement);
            const explicitEnd = Date.parse(copy.effectiveTo || '');
            if (Number.isFinite(snapshotEnd) && (!Number.isFinite(explicitEnd) || explicitEnd > snapshotEnd)) {
                copy.effectiveTo = new Date(snapshotEnd).toISOString();
            }
            entitlements.push(copy);
        });
    });
    entitlements.push(...(
        Array.isArray(organisation.customerMaster && organisation.customerMaster.entitlements)
            ? organisation.customerMaster.entitlements.map((item) => Object.assign({}, item))
            : []
    ));
    return entitlements;
}

function resolveOrganisationProofRequirementsForPeriod(organisation, period, timezone) {
    const requestedBounds = proofPeriodBounds(period, timezone);
    const liveResolution = resolveProofRequirementsForPeriod(
        proofEntitlementsForOrganisation(organisation),
        period,
        timezone
    );
    const ledger = normaliseProofRequirementLedger(organisation.proofRequirementLedger)
        .find((entry) => entry.period === period);
    const currentRevision = Number(organisation.customerMaster && organisation.customerMaster.revision || 0);
    const historyRevisions = customerMasterHistoryRevisionSet(organisation);
    const customerMasterOverflow = customerMasterEntitlementsOverflow(organisation);
    if (!ledger) {
        const entitlementCodesOverflow = liveResolution.entitlementCodesOverflow === true || customerMasterOverflow;
        return Object.assign({}, liveResolution, {
            requirementHistoryComplete: Boolean(requestedBounds) && !entitlementCodesOverflow &&
                hasContiguousMasterHistory(historyRevisions, 1, currentRevision),
            entitlementCodesOverflow
        });
    }
    const ledgerResolution = resolveProofRequirementsForPeriod(
        ledger.entitlementCodes.map((code) => ({ code, quantity: 1 })),
        period,
        timezone
    );
    const entitlementCodes = Array.from(new Set(
        (liveResolution.entitlementCodes || []).concat(ledger.entitlementCodes)
    )).sort();
    const entitlementCodesOverflow = customerMasterOverflow || ledger.entitlementCodesOverflow === true ||
        liveResolution.entitlementCodesOverflow === true || entitlementCodes.length > 100;
    const ledgerTimezoneMatches = Boolean(requestedBounds && ledger.timezone === requestedBounds.timezone);
    return {
        requiredSources: mergeProofSources(
            liveResolution.requiredSources,
            mergeProofSources(ledger.requiredSources, ledgerResolution.requiredSources)
        ),
        unresolvedEntitlements: Array.from(new Set(
            liveResolution.unresolvedEntitlements.concat(ledgerResolution.unresolvedEntitlements)
        )).sort(),
        entitlementCodes: entitlementCodes.slice(0, 100),
        entitlementCodesOverflow,
        requirementHistoryComplete: ledgerTimezoneMatches &&
            ledger.historyComplete === true && !entitlementCodesOverflow
    };
}

function reconcileProofRequirementLedger(organisation, at, options = {}) {
    const timezone = organisationProofTimezone(organisation);
    const governedPeriods = governedProofPeriods(at, timezone);
    if (!governedPeriods.length) return { periods: 0 };
    const priorEntries = new Map(
        normaliseProofRequirementLedger(organisation.proofRequirementLedger)
            .map((entry) => [entry.period, entry])
    );
    const entitlements = proofEntitlementsForOrganisation(organisation);
    const currentRevision = Number(organisation.customerMaster && organisation.customerMaster.revision || 0);
    const historyRevisions = customerMasterHistoryRevisionSet(organisation);
    const initialiseFromCurrentMaster = options.initialiseFromCurrentMaster === true && priorEntries.size === 0;
    const customerMasterOverflow = customerMasterEntitlementsOverflow(organisation);
    const nextEntries = governedPeriods.map((period) => {
        const prior = priorEntries.get(period);
        const existing = prior || {
            period,
            timezone,
            entitlementCodes: [],
            entitlementCodesOverflow: false,
            requiredSources: [],
            historyComplete: false,
            throughMasterRevision: 0,
            updatedAt: ''
        };
        const resolution = resolveProofRequirementsForPeriod(entitlements, period, timezone);
        const entitlementCodes = Array.from(new Set(
            existing.entitlementCodes.concat(resolution.entitlementCodes || [])
        )).sort();
        const entitlementCodesOverflow = customerMasterOverflow || existing.entitlementCodesOverflow === true ||
            resolution.entitlementCodesOverflow === true || entitlementCodes.length > 100;
        const historyComplete = initialiseFromCurrentMaster
            ? currentRevision > 0
            : proofRequirementHistoryComplete(
                prior,
                currentRevision,
                historyRevisions,
                timezone
            );
        return {
            period,
            timezone,
            entitlementCodes: entitlementCodes.slice(0, 100),
            entitlementCodesOverflow,
            requiredSources: mergeProofSources(existing.requiredSources, resolution.requiredSources),
            historyComplete,
            throughMasterRevision: currentRevision,
            updatedAt: at
        };
    });
    organisation.proofRequirementLedger = normaliseProofRequirementLedger(nextEntries);
    return {
        periods: organisation.proofRequirementLedger.length,
        incompletePeriods: organisation.proofRequirementLedger.filter((entry) => !entry.historyComplete).length,
        overflowPeriods: organisation.proofRequirementLedger.filter((entry) => entry.entitlementCodesOverflow).length
    };
}

function proofRequirementHistoryComplete(existing, currentRevision, historyRevisions, timezone) {
    if (!existing || existing.historyComplete !== true) {
        return !existing && hasContiguousMasterHistory(historyRevisions, 1, currentRevision);
    }
    const throughRevision = Number(existing.throughMasterRevision || 0);
    if (throughRevision < 1 || throughRevision > currentRevision) return false;
    const startRevision = existing.timezone && existing.timezone !== timezone ? 1 : throughRevision;
    return hasContiguousMasterHistory(historyRevisions, startRevision, currentRevision);
}

function customerMasterHistoryRevisionSet(organisation) {
    return new Set((Array.isArray(organisation.customerMasterHistory) ? organisation.customerMasterHistory : [])
        .map((entry) => Number(entry && entry.revision || 0))
        .filter((revision) => Number.isInteger(revision) && revision > 0));
}

function customerMasterEntitlementsOverflow(organisation) {
    if (organisation.customerMaster && organisation.customerMaster.entitlementsOverflow === true) return true;
    return (Array.isArray(organisation.customerMasterHistory) ? organisation.customerMasterHistory : [])
        .some((entry) => entry && entry.snapshot && entry.snapshot.entitlementsOverflow === true);
}

function hasContiguousMasterHistory(revisions, startRevision, currentRevision) {
    if (!Number.isInteger(currentRevision) || currentRevision < 1) return false;
    if (!Number.isInteger(startRevision) || startRevision < 1 || startRevision > currentRevision) return false;
    const expectedCount = currentRevision - startRevision;
    if (expectedCount === 0) return true;
    if (expectedCount > revisions.size) return false;
    const selected = Array.from(revisions)
        .filter((revision) => revision >= startRevision && revision < currentRevision)
        .sort((left, right) => left - right);
    return selected.length === expectedCount && selected.every((revision, index) => (
        revision === startRevision + index
    ));
}

function assertProofPeriodCreationAllowed(organisation, proof, at) {
    const boundary = proofPeriodWriteBoundary(
        organisation.proofPeriods,
        proof.period,
        proof.timezone || 'Pacific/Auckland',
        at
    );
    if (boundary.allowed) return;
    if (boundary.code === 'proof_timezone_invalid') {
        throw lifecycleError(409, 'Proof cannot be created until its customer timezone is valid', boundary.code, {
            period: proof.period,
            timezone: proof.timezone || ''
        });
    }
    if (boundary.code === 'proof_period_out_of_window') {
        throw lifecycleError(409, 'Proof period is outside the governed reporting window', boundary.code, {
            period: proof.period,
            earliestPeriod: boundary.earliestPeriod,
            latestPeriod: boundary.latestPeriod
        });
    }
    throw lifecycleError(409, 'The open Proof-period capacity has been reached', boundary.code, {
        period: proof.period,
        maximumOpenPeriods: boundary.maximumOpenPeriods
    });
}

function assertProofEvidenceCoversPeriod(evidence, proof, at) {
    const bounds = proofPeriodBounds(proof.period, proof.timezone || 'Pacific/Auckland');
    const periodStart = Date.parse(evidence.periodStart || '');
    const periodEnd = Date.parse(evidence.periodEnd || '');
    if (
        !bounds || !Number.isFinite(periodStart) || !Number.isFinite(periodEnd) ||
        periodEnd < periodStart || periodStart > bounds.startMs || periodEnd < bounds.endInclusiveMs
    ) {
        throw lifecycleError(
            400,
            'Proof evidence must explicitly cover the complete reporting month in the customer timezone',
            'proof_evidence_period_coverage_required',
            {
                period: proof.period,
                timezone: proof.timezone || '',
                requiredPeriodStart: bounds && bounds.periodStart || '',
                requiredPeriodEnd: bounds && bounds.periodEnd || ''
            }
        );
    }
    const current = Date.parse(at || '');
    const capturedAt = Date.parse(evidence.capturedAt || '');
    const ingestedAt = Date.parse(evidence.ingestedAt || '');
    if (
        !Number.isFinite(current) || !Number.isFinite(capturedAt) || !Number.isFinite(ingestedAt) ||
        current + PROOF_PERIOD_CLOSE_TOLERANCE_MS < bounds.endExclusiveMs ||
        capturedAt + PROOF_PERIOD_CLOSE_TOLERANCE_MS < bounds.endExclusiveMs ||
        ingestedAt + PROOF_PERIOD_CLOSE_TOLERANCE_MS < bounds.endExclusiveMs
    ) {
        throw lifecycleError(
            409,
            'Proof evidence cannot claim complete-month coverage before the customer reporting month has ended',
            'proof_evidence_period_not_closed',
            { period: proof.period, timezone: proof.timezone || '', periodClosesAt: new Date(bounds.endExclusiveMs).toISOString() }
        );
    }
}

function assertProofPeriodClosed(proof, at) {
    const bounds = proofPeriodBounds(proof.period, proof.timezone || 'Pacific/Auckland');
    const current = Date.parse(at || '');
    if (!bounds || !Number.isFinite(current) || current < bounds.endExclusiveMs) {
        throw lifecycleError(
            409,
            'Proof cannot be approved before the customer reporting month has ended',
            'proof_period_not_closed',
            {
                period: proof.period,
                timezone: proof.timezone || '',
                periodClosesAt: bounds ? new Date(bounds.endExclusiveMs).toISOString() : ''
            }
        );
    }
}

function ensureDefaultSchedules(state, organisation, at, makeId) {
    const definitions = [
        { jobType: 'connector_freshness', cadence: 'daily', offsetDays: 1, requiredSources: ['datto_rmm', 'mdr', 'backup'] },
        { jobType: 'sla_exception_review', cadence: 'daily', offsetDays: 1, requiredSources: ['service_desk'] },
        {
            jobType: 'monthly_proof',
            cadence: 'monthly',
            offsetDays: 30,
            requiredSources: requiredProofSourcesForEntitlements(
                organisation.customerMaster && organisation.customerMaster.entitlements,
                at
            )
        },
        { jobType: 'managed_count_reconciliation', cadence: 'monthly', offsetDays: 30, requiredSources: ['datto_rmm', 'billing'] },
        { jobType: 'quarterly_service_review', cadence: 'quarterly', offsetDays: 90, requiredSources: ['risk', 'roadmap'] }
    ];
    for (const definition of definitions) {
        const existing = state.schedules.find((item) => item.organisationId === organisation.id && item.jobType === definition.jobType);
        if (existing) {
            if (definition.jobType === 'monthly_proof' && canonicalHash(existing.requiredSources) !== canonicalHash(definition.requiredSources)) {
                existing.requiredSources = definition.requiredSources;
                existing.updatedAt = at;
                existing.revision = Number(existing.revision || 0) + 1;
            }
            continue;
        }
        state.schedules.push({
            id: makeId('schedule'),
            organisationId: organisation.id,
            jobType: definition.jobType,
            cadence: definition.cadence,
            timezone: organisation.supportProfile.timezone || 'Pacific/Auckland',
            nextDueAt: new Date(Date.parse(at) + (definition.offsetDays * 24 * 60 * 60 * 1000)).toISOString(),
            enabled: organisation.serviceStatus.state === 'active',
            templateVersion: '1',
            deliveryMode: 'internal',
            requiredSources: definition.requiredSources,
            createdAt: at,
            updatedAt: at,
            revision: 1
        });
    }
}

function setCustomerSchedulesEnabled(state, organisationId, enabled, at) {
    let changed = 0;
    for (const schedule of state.schedules.filter((item) => item.organisationId === organisationId)) {
        if (schedule.enabled === enabled) continue;
        schedule.enabled = enabled;
        schedule.updatedAt = at;
        schedule.revision = Number(schedule.revision || 0) + 1;
        changed += 1;
    }
    return changed;
}

function nextScheduleDueAt(schedule, currentDueAt) {
    const days = { daily: 1, monthly: 30, quarterly: 90 }[schedule.cadence] || 1;
    return new Date(Date.parse(currentDueAt) + (days * 24 * 60 * 60 * 1000)).toISOString();
}

function advanceSchedulePast(schedule, currentDueAt, horizon) {
    let next = nextScheduleDueAt(schedule, currentDueAt);
    let guard = 0;
    while (Date.parse(next) <= Date.parse(horizon) && guard < 400) {
        next = nextScheduleDueAt(schedule, next);
        guard += 1;
    }
    return next;
}

function controlTaskTitle(jobType, customerName) {
    const labels = {
        connector_freshness: 'Review connector freshness',
        sla_exception_review: 'Review SLA exceptions',
        monthly_proof: 'Prepare monthly customer proof',
        managed_count_reconciliation: 'Reconcile managed counts and billing',
        quarterly_service_review: 'Prepare quarterly service review'
    };
    return `${labels[jobType] || 'Review customer control'} · ${customerName}`;
}

function controlTaskDetail(jobType) {
    const details = {
        connector_freshness: 'Check the most recent successful reads for every required customer connector. Stale data blocks proof.',
        sla_exception_review: 'Review open support exceptions and overdue responses against the signed customer schedule.',
        monthly_proof: 'Collect complete, fresh source evidence and prepare the customer proof pack. Do not issue incomplete proof.',
        managed_count_reconciliation: 'Compare contracted, planned, observed and billed users/devices and resolve differences.',
        quarterly_service_review: 'Review outcomes, risks, roadmap, access and continuity evidence with the customer.'
    };
    return details[jobType] || 'Review the controlled customer work item.';
}

function normaliseSha256(value) {
    const hash = cleanText(value, 64).toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function fact(field, value) {
    return { field, value, certainty: 'explicit' };
}

function serviceDeskCustomerReadiness(organisation, at = new Date()) {
    const onboarding = organisation.onboarding || {};
    const devices = Array.isArray(onboarding.devices) ? onboarding.devices : [];
    const verifiedDevices = devices.filter((device) => device.status === 'verified');
    const customerMaster = normaliseCustomerMaster(organisation.customerMaster, organisation.createdAt);
    const supportProfile = normaliseSupportProfile(organisation.supportProfile);
    const datto = organisation.integrations && organisation.integrations.dattoRmm || {};
    const currentTime = at instanceof Date ? at.getTime() : Date.parse(at);
    const readinessAt = new Date(currentTime).toISOString();
    const contractCurrent = supportProfile.contractStatus === 'signed' &&
        (!supportProfile.serviceStartAt || Date.parse(supportProfile.serviceStartAt) <= currentTime) &&
        (!supportProfile.serviceEndAt || Date.parse(supportProfile.serviceEndAt) > currentTime);
    const serviceSchedule = customerMaster.serviceSchedule || {};
    const serviceScheduleCurrent = Boolean(
        serviceSchedule.agreementId && serviceSchedule.version && serviceSchedule.contentHash &&
        serviceSchedule.slaId && serviceSchedule.startAt &&
        Date.parse(serviceSchedule.startAt) <= currentTime &&
        (!serviceSchedule.endAt || Date.parse(serviceSchedule.endAt) > currentTime)
    );
    const currentExternalRefs = customerMaster.externalRefs.filter((reference) => (
        isGovernedVerifiedExternalReference(reference, readinessAt)
    ));
    const externalCrosswalksCurrent = onboarding.kind !== 'external' || (
        currentExternalRefs.filter((reference) => reference.system === 'hubspot' && reference.recordType === 'company').length === 1 &&
        currentExternalRefs.filter((reference) => reference.system === 'autotask' && reference.recordType === 'account').length === 1
    );
    const rmmFresh = datto.status === 'linked' && datto.truncated !== true &&
        Number.isFinite(Date.parse(datto.capturedAt || datto.lastSyncedAt)) &&
        currentTime - Date.parse(datto.capturedAt || datto.lastSyncedAt) >= 0 &&
        currentTime - Date.parse(datto.capturedAt || datto.lastSyncedAt) <= 24 * 60 * 60 * 1000;
    const observedDeviceUidCounts = new Map();
    for (const observed of Array.isArray(datto.devices) ? datto.devices : []) {
        const uid = cleanText(observed && (observed.uid || observed.deviceUid), 180);
        if (uid) observedDeviceUidCounts.set(uid, (observedDeviceUidCounts.get(uid) || 0) + 1);
    }
    const mappedDeviceUids = [];
    const currentDeviceMappings = devices.length > 0 && devices.every((device) => {
        const dattoRefs = (Array.isArray(device.providerRefs) ? device.providerRefs : [])
            .filter((ref) => ref && ref.system === 'datto_rmm' && cleanText(ref.externalId, 180));
        if (dattoRefs.length !== 1) return false;
        const deviceUid = cleanText(dattoRefs[0].externalId, 180);
        mappedDeviceUids.push(deviceUid);
        return observedDeviceUidCounts.get(deviceUid) === 1 && Boolean(datto.snapshotId) && device.sourceSnapshotId === datto.snapshotId;
    }) && new Set(mappedDeviceUids).size === mappedDeviceUids.length;
    const missing = [];
    if (organisation.recordType !== 'customer') missing.push('customer_record_required');
    if (organisation.lifecycleState !== LIFECYCLE_STATES.ACTIVE) missing.push('active_service_required');
    if (!organisation.serviceStatus || organisation.serviceStatus.state !== 'active') missing.push('active_service_status_required');
    if (onboarding.status !== 'complete') missing.push('customer_setup_complete_required');
    if (!devices.length || verifiedDevices.length !== devices.length || verifiedDevices.some((device) => device.matchStatus !== 'confirmed')) {
        missing.push('verified_devices_required');
    }
    if (!contractCurrent || !supportProfile.slaScheduleRef) missing.push('signed_sla_required');
    if (!serviceScheduleCurrent) missing.push('current_service_schedule_required');
    if (!externalCrosswalksCurrent) missing.push('current_customer_crosswalk_required');
    if (!supportProfile.authorisedRequesters.length) missing.push('authorised_requester_required');
    if (!rmmFresh || datto.reconciliationStatus !== 'matched') {
        missing.push('fresh_rmm_reconciliation_required');
    }
    if (!currentDeviceMappings) missing.push('current_device_identity_reconciliation_required');
    return {
        readiness: {
            eligible: missing.length === 0,
            missing
        },
        customer: {
            id: organisation.id,
            name: organisation.displayName,
            lifecycleState: organisation.lifecycleState,
            onboardingStatus: onboarding.status || 'not_started',
            serviceStatus: organisation.serviceStatus && organisation.serviceStatus.state || 'not_started',
            supportProfile: {
                contractStatus: supportProfile.contractStatus,
                serviceStartAt: supportProfile.serviceStartAt,
                serviceEndAt: supportProfile.serviceEndAt,
                slaScheduleRef: supportProfile.slaScheduleRef,
                timezone: supportProfile.timezone,
                channels: supportProfile.channels,
                authorisedRequesters: supportProfile.authorisedRequesters
            },
            devices: verifiedDevices.map((device) => ({
                id: device.id,
                label: device.label,
                platform: device.platform,
                status: device.status,
                matchStatus: device.matchStatus
            }))
        }
    };
}

function normaliseProspectAdmission(value) {
    if (value == null) return null;
    const source = value && typeof value === 'object' ? value : {};
    const clientKeyHash = cleanText(source.clientKeyHash, 128).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(clientKeyHash)) {
        throw lifecycleError(503, 'Prospect admission is not configured', 'prospect_admission_not_configured');
    }
    return {
        clientKeyHash,
        burstWindowMs: boundedPositiveInteger(source.burstWindowMs, 10 * 60 * 1000),
        burstMax: boundedPositiveInteger(source.burstMax, 3),
        clientWindowMs: boundedPositiveInteger(source.clientWindowMs, 24 * 60 * 60 * 1000),
        clientMax: boundedPositiveInteger(source.clientMax, 8),
        globalHourWindowMs: boundedPositiveInteger(source.globalHourWindowMs, 60 * 60 * 1000),
        globalHourMax: boundedPositiveInteger(source.globalHourMax, 30),
        globalDayWindowMs: boundedPositiveInteger(source.globalDayWindowMs, 24 * 60 * 60 * 1000),
        globalDayMax: boundedPositiveInteger(source.globalDayMax, 100)
    };
}

function boundedPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 365 * 24 * 60 * 60 * 1000
        ? parsed
        : fallback;
}

function reserveProspectAdmission(state, sessionHash, policy, at) {
    const nowMs = Date.parse(at);
    const maximumWindow = Math.max(
        policy.burstWindowMs,
        policy.clientWindowMs,
        policy.globalHourWindowMs,
        policy.globalDayWindowMs
    );
    const admissions = (Array.isArray(state.prospectAdmissions) ? state.prospectAdmissions : [])
        .filter((item) => {
            const created = Date.parse(item && item.createdAt);
            return Number.isFinite(created) && nowMs - created >= 0 && nowMs - created < maximumWindow;
        });
    state.prospectAdmissions = admissions;
    if (admissions.some((item) => item.sessionHash === sessionHash)) return;

    const checks = [
        { windowMs: policy.burstWindowMs, max: policy.burstMax, clientOnly: true },
        { windowMs: policy.clientWindowMs, max: policy.clientMax, clientOnly: true },
        { windowMs: policy.globalHourWindowMs, max: policy.globalHourMax, clientOnly: false },
        { windowMs: policy.globalDayWindowMs, max: policy.globalDayMax, clientOnly: false }
    ];
    for (const check of checks) {
        const recent = admissions.filter((item) => {
            if (check.clientOnly && item.clientKeyHash !== policy.clientKeyHash) return false;
            return nowMs - Date.parse(item.createdAt) < check.windowMs;
        });
        if (recent.length >= check.max) {
            const oldest = Math.min(...recent.map((item) => Date.parse(item.createdAt)));
            const retryAfterSeconds = Math.max(1, Math.ceil((check.windowMs - (nowMs - oldest)) / 1000));
            throw lifecycleError(
                429,
                'Too many new enquiries have been started. Please wait and try again, or email hello@nofries.nz.',
                'prospect_creation_limited',
                { retryAfterSeconds }
            );
        }
    }
    admissions.push({
        sessionHash: cleanText(sessionHash, 128),
        clientKeyHash: policy.clientKeyHash,
        createdAt: at
    });
}

function normalisePilotCount(value, code) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 50) {
        throw lifecycleError(400, 'Internal pilot counts must be whole numbers between 1 and 50', code);
    }
    return number;
}

function deviceGateId(device) {
    return `device_${cleanText(device && device.id, 140).replace(/[^a-z0-9_-]+/gi, '_')}`;
}

function buildPilotOnboardingGates(devices, owner) {
    const deviceGates = devices.map((device) => ({
        id: deviceGateId(device),
        title: `Set up and check ${device.label} (${device.platform === 'macos' ? 'macOS' : prettyCategory(device.platform)})`,
        status: 'pending',
        owner,
        dependencies: ['datto_site_link']
    }));
    return [
        {
            id: 'authority',
            title: 'Confirm authority and the internal-pilot boundaries',
            status: 'complete',
            owner,
            dependencies: []
        },
        {
            id: 'datto_site_link',
            title: 'Link the dedicated Datto RMM customer site',
            status: 'pending',
            owner,
            dependencies: ['authority']
        },
        ...deviceGates,
        {
            id: 'endpoint_reconciliation',
            title: 'Match expected and Datto-reported computer counts',
            status: 'pending',
            owner: 'onboarding_coordinator',
            dependencies: ['datto_site_link', ...deviceGates.map((gate) => gate.id)]
        },
        {
            id: 'monitoring_acceptance',
            title: 'Approve starting monitoring checks and Proof every month',
            status: 'pending',
            owner,
            dependencies: ['endpoint_reconciliation', ...deviceGates.map((gate) => gate.id)]
        },
        {
            id: 'active_service_approval',
            title: 'Approve the move to active service',
            status: 'pending',
            owner,
            dependencies: ['monitoring_acceptance']
        }
    ];
}

function gateDependenciesComplete(gates, gate) {
    const statuses = new Map((gates || []).map((item) => [item.id, item.status]));
    return (gate.dependencies || []).every((dependency) => statuses.get(dependency) === 'complete');
}

function updateGate(gates, gateId, status) {
    const gate = (gates || []).find((item) => item.id === gateId);
    if (gate) gate.status = status;
    return gate;
}

function applyDattoSnapshotToOnboarding(organisation, deviceCount, expectedDeviceCount) {
    const onboarding = organisation.onboarding || {};
    if (!Array.isArray(onboarding.gates) || !onboarding.gates.length) return;
    updateGate(onboarding.gates, 'datto_site_link', 'complete');
    updateGate(
        onboarding.gates,
        'endpoint_reconciliation',
        expectedDeviceCount != null && deviceCount === expectedDeviceCount ? 'complete' : 'blocked'
    );
    refreshOnboardingProgress(organisation);
}

function refreshOnboardingProgress(organisation) {
    const onboarding = organisation.onboarding || {};
    const gates = Array.isArray(onboarding.gates) ? onboarding.gates : [];
    const devices = Array.isArray(onboarding.devices) ? onboarding.devices : [];
    devices.forEach((device) => {
        const gateStatus = device.status === 'verified'
            ? 'complete'
            : device.status === 'blocked'
                ? 'blocked'
                : device.status === 'planned'
                    ? 'pending'
                    : 'in_progress';
        updateGate(gates, deviceGateId(device), gateStatus);
    });
    const datto = organisation.integrations && organisation.integrations.dattoRmm;
    if (datto && datto.status === 'linked') {
        updateGate(gates, 'datto_site_link', 'complete');
        updateGate(
            gates,
            'endpoint_reconciliation',
            datto.expectedDeviceCount != null && datto.deviceCount === datto.expectedDeviceCount ? 'complete' : 'blocked'
        );
    }
    const derivedBlockers = [];
    if (datto && datto.status === 'linked' && datto.reconciliationStatus === 'review_required') {
        derivedBlockers.push(`Datto reports ${datto.deviceCount} of ${datto.expectedDeviceCount} expected devices`);
    }
    devices.filter((device) => device.status === 'blocked').forEach((device) => {
        derivedBlockers.push(`${device.label} enrollment is blocked`);
    });
    onboarding.blockers = derivedBlockers;
    if (organisation.lifecycleState === LIFECYCLE_STATES.ACTIVE) {
        onboarding.status = 'complete';
        return;
    }
    onboarding.status = gates.some((gate) => gate.status === 'blocked') ? 'blocked' : 'in_progress';
    const nextGate = gates.find((gate) => gate.status !== 'complete');
    organisation.nextAction = nextGate ? {
        type: 'onboarding_gate',
        detail: nextGate.title,
        timing: 'next',
        owner: nextGate.owner || 'onboarding_coordinator',
        dueAt: '',
        status: 'open'
    } : {
        type: 'active_service_approval',
        detail: 'Approve transition to active managed service.',
        timing: 'next',
        owner: 'service_owner',
        dueAt: '',
        status: 'open'
    };
}

function buildAgenticManagementPlan(organisation) {
    const onboarding = organisation.onboarding || {};
    if (!Array.isArray(onboarding.gates) || !onboarding.gates.length) return null;
    const nextGate = onboarding.gates.find((gate) => gate.status !== 'complete');
    const datto = organisation.integrations && organisation.integrations.dattoRmm || {};
    return {
        coordinator: {
            id: 'onboarding_coordinator',
            name: 'Customer Lifecycle Coordinator',
            mode: 'read_only_recommend'
        },
        status: organisation.lifecycleState === LIFECYCLE_STATES.ACTIVE ? 'active_service' : onboarding.status,
        nextAction: nextGate ? nextGate.title : organisation.nextAction.detail,
        approvalRequired: true,
        externalChanges: false,
        evidence: {
            dattoLinked: datto.status === 'linked',
            expectedDevices: organisation.context && organisation.context.endpoints && organisation.context.endpoints.estimatedCount,
            dattoDevices: datto.deviceCount,
            openAlerts: datto.openAlertCount
        },
        guardrail: 'The coordinator may read the customer record and Datto information to recommend the next action. Site changes, software installation, monitoring acceptance and fixes require approval.'
    };
}

function discoveryHandoffCandidates(state) {
    return state.conversations.flatMap((conversation) => {
        const organisation = state.organisations.find((item) => item.id === conversation.organisationId);
        if (!organisation || !isDiscoveryScopingHandoff(organisation, conversation)) return [];
        const exists = state.operatorTasks.some((task) => (
            task.type === DISCOVERY_SCOPING_TASK &&
            task.organisationId === organisation.id &&
            task.conversationId === conversation.id
        ));
        return exists ? [] : [{ organisation, conversation }];
    });
}

function isDiscoveryScopingHandoff(organisation, conversation) {
    if (organisation.lifecycleState !== LIFECYCLE_STATES.DISCOVERY) return false;
    const nextActionType = conversation.nextAction && conversation.nextAction.type;
    if (['human_follow_up', 'start_scoping'].includes(nextActionType)) return true;
    return Boolean(
        conversation.escalation && conversation.escalation.required &&
        organisation.nextAction && organisation.nextAction.owner === 'operator'
    );
}

function ensureDiscoveryScopingTask(state, organisation, conversation, options) {
    if (!isDiscoveryScopingHandoff(organisation, conversation)) return null;
    const existing = state.operatorTasks.find((task) => (
        task.type === DISCOVERY_SCOPING_TASK &&
        task.organisationId === organisation.id &&
        task.conversationId === conversation.id
    ));
    if (existing) return null;

    const at = options.at;
    const task = {
        id: options.makeId('operator_task'),
        organisationId: organisation.id,
        conversationId: conversation.id,
        type: DISCOVERY_SCOPING_TASK,
        title: 'Review discovery and prepare scoping',
        detail: cleanText(
            conversation.nextAction && conversation.nextAction.detail ||
            organisation.nextAction && organisation.nextAction.detail ||
            'Review the prospect conversation, verify field provenance and prepare the scoping handoff.',
            1200
        ),
        status: 'open',
        priority: conversation.escalation && conversation.escalation.required ? 'high' : 'medium',
        ownerRole: 'service_owner',
        source: 'prospect_agent_handoff',
        evidence: {
            lifecycleState: organisation.lifecycleState,
            nextActionType: conversation.nextAction && conversation.nextAction.type || '',
            missingCoreFieldCount: organisation.discovery.missingFields.length,
            missingCoreFields: organisation.discovery.missingFields.slice(0, 30).map((item) => item.field),
            knownFieldCount: Object.values(organisation.fieldStates).filter((field) => field.status === 'known').length,
            conversationUpdatedAt: conversation.updatedAt,
            backfilled: options.backfilled === true
        },
        createdAt: at,
        createdBy: options.backfilled ? 'lifecycle_task_reconciler' : 'prospect_agent',
        updatedAt: at,
        updatedBy: options.backfilled ? 'lifecycle_task_reconciler' : 'prospect_agent',
        completedAt: '',
        completedBy: '',
        outcome: ''
    };
    state.operatorTasks.push(task);
    options.auditEvents.push({
        actorType: options.backfilled ? 'system' : 'agent',
        actorId: task.createdBy,
        actorRole: options.backfilled ? 'system' : 'public_agent',
        action: 'operator_task.created',
        targetType: 'operator_task',
        targetId: task.id,
        organisationId: organisation.id,
        conversationId: conversation.id,
        summary: 'Discovery-to-scoping review task created',
        details: {
            taskType: task.type,
            ownerRole: task.ownerRole,
            source: task.source,
            backfilled: options.backfilled === true,
            missingCoreFieldCount: task.evidence.missingCoreFieldCount
        }
    });
    return task;
}

function completeDiscoveryScopingTasks(state, organisation, access, at, auditEvents) {
    state.operatorTasks
        .filter((task) => (
            task.organisationId === organisation.id &&
            task.type === DISCOVERY_SCOPING_TASK &&
            task.status === 'open'
        ))
        .forEach((task) => {
            task.status = 'completed';
            task.updatedAt = at;
            task.updatedBy = access.user.email;
            task.completedAt = at;
            task.completedBy = access.user.email;
            task.outcome = 'Scoping context prepared';
            auditEvents.push({
                actorType: 'user',
                actorId: access.user.email,
                actorRole: access.user.role,
                action: 'operator_task.completed',
                targetType: 'operator_task',
                targetId: task.id,
                organisationId: organisation.id,
                conversationId: task.conversationId,
                summary: 'Discovery-to-scoping review task completed',
                details: {
                    taskType: task.type,
                    outcome: task.outcome,
                    lifecycleState: organisation.lifecycleState
                }
            });
        });
}

function buildOperatorBootstrap(state, access, at = new Date()) {
    const organisations = state.organisations.map((organisation) => operatorOrganisation(organisation, state));
    const exceptions = organisations.flatMap((organisation) => organisation.exceptions).sort(sortExceptions);
    const operatorTasks = state.operatorTasks
        .map(publicOperatorTask)
        .sort(sortOperatorTasks);
    const serviceProof = buildServiceProof(organisations, at);
    const byState = Object.fromEntries(LIFECYCLE_ORDER.map((lifecycleState) => [
        lifecycleState,
        organisations.filter((organisation) => organisation.lifecycleState === lifecycleState).length
    ]));
    const recentObservability = state.observability.slice(-500);
    const aiCost = recentObservability.reduce((total, event) => total + Number(event.approximateCostUsd || 0), 0);
    return {
        product: { name: 'No Fries', mode: 'management-by-exception', schemaVersion: state.schemaVersion },
        revision: state.revision,
        tenant: state.tenant,
        user: access.user,
        counts: {
            organisations: organisations.length,
            exceptions: exceptions.length,
            conversations: state.conversations.filter((item) => item.status === 'active').length,
            approvals: state.approvals.filter((item) => item.status === 'pending').length + serviceProof.pendingApprovals,
            operatorTasks: operatorTasks.filter((task) => task.status === 'open').length,
            openDeadLetters: state.deadLetters.filter((item) => item.status === 'open').length,
            enabledSchedules: state.schedules.filter((item) => item.enabled).length
        },
        lifecycle: byState,
        organisations,
        exceptions: exceptions.slice(0, 100),
        approvals: state.approvals.filter((item) => item.status === 'pending').slice(0, 100),
        operatorTasks: operatorTasks.slice(0, 100),
        customerControls: {
            externalWrites: false,
            schedules: state.schedules.slice(-200),
            recentRuns: state.controlRuns.slice(-100).reverse(),
            deadLetters: state.deadLetters.filter((item) => item.status === 'open').slice(-100).reverse()
        },
        ai: {
            recentRuns: recentObservability.filter((event) => event.eventType === 'agent.run').length,
            toolCalls: recentObservability.filter((event) => event.eventType === 'tool.call').length,
            toolResults: recentObservability.filter((event) => event.eventType === 'tool.result').length,
            handoffs: recentObservability.filter((event) => event.eventType === 'agent.handoff').length,
            errors: recentObservability.filter((event) => event.outcome === 'error').length,
            approximateCostUsd: Math.round(aiCost * 1000000) / 1000000
        },
        serviceProof,
        activity: state.audit.slice(-100).reverse()
    };
}

function operatorOrganisation(organisation, state) {
    const conversations = state.conversations.filter((item) => item.organisationId === organisation.id);
    const latestConversation = conversations.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return Object.assign(buildContextSnapshot(organisation), {
        source: organisation.source,
        createdAt: organisation.createdAt,
        conversation: latestConversation ? publicConversation(latestConversation) : null,
        conversationCount: conversations.length,
        operatorTasks: state.operatorTasks
            .filter((task) => task.organisationId === organisation.id)
            .map(publicOperatorTask)
            .sort(sortOperatorTasks),
        exceptions: operatorExceptions(organisation, conversations),
        agenticManagement: buildAgenticManagementPlan(organisation)
    });
}

function prospectSessionResponse(state, conversation) {
    const organisation = findOrganisation(state, conversation.organisationId);
    return {
        revision: state.revision,
        conversation: publicConversation(conversation),
        organisation: buildContextSnapshot(organisation)
    };
}

function publicConversation(conversation) {
    return {
        id: conversation.id,
        organisationId: conversation.organisationId,
        channel: conversation.channel,
        status: conversation.status,
        messages: conversation.messages.slice(-40),
        summary: conversation.summary,
        currentNeed: conversation.currentNeed,
        concerns: conversation.concerns,
        nextAction: conversation.nextAction,
        escalation: conversation.escalation,
        ai: conversation.ai,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt
    };
}

function publicOperatorTask(task) {
    return {
        id: task.id,
        organisationId: task.organisationId,
        conversationId: task.conversationId,
        type: task.type,
        title: task.title,
        detail: task.detail,
        status: task.status,
        priority: task.priority,
        ownerRole: task.ownerRole,
        source: task.source,
        evidence: task.evidence,
        createdAt: task.createdAt,
        createdBy: task.createdBy,
        updatedAt: task.updatedAt,
        updatedBy: task.updatedBy,
        completedAt: task.completedAt,
        completedBy: task.completedBy,
        outcome: task.outcome
    };
}

function searchAgentDocuments(state, query, publicUrl) {
    const terms = cleanText(query, 500).toLowerCase().split(/\s+/).filter(Boolean);
    const organisationDocuments = state.organisations.map((organisation) => {
        const conversation = state.conversations
            .filter((item) => item.organisationId === organisation.id)
            .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
        const searchable = [
            organisation.displayName,
            organisation.lifecycleState,
            organisation.context.company.summary,
            organisation.context.contacts.primary.name,
            organisation.context.contacts.primary.email,
            organisation.discovery.summary,
            organisation.nextAction.detail,
            conversation && conversation.currentNeed,
            conversation && conversation.summary
        ].filter(Boolean).join(' ').toLowerCase();
        return {
            id: `organisation:${organisation.id}`,
            title: `${organisation.displayName} · ${prettyCategory(organisation.lifecycleState)}`,
            url: `${publicUrl}/operator#organisation-${encodeURIComponent(organisation.id)}`,
            searchable,
            updatedAt: organisation.updatedAt
        };
    });
    const taskDocuments = state.operatorTasks.map((task) => {
        const organisation = state.organisations.find((item) => item.id === task.organisationId);
        return {
            id: `operator-task:${task.id}`,
            title: `${task.title} · ${organisation && organisation.displayName || task.organisationId}`,
            url: `${publicUrl}/operator#organisation-${encodeURIComponent(task.organisationId)}`,
            searchable: [task.title, task.detail, task.status, task.priority, task.ownerRole, task.source, organisation && organisation.displayName]
                .filter(Boolean).join(' ').toLowerCase(),
            updatedAt: task.updatedAt
        };
    });
    return organisationDocuments.concat(taskDocuments)
        .filter((document) => !terms.length || terms.every((term) => document.searchable.includes(term)))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        .slice(0, 20)
        .map(({ id, title, url }) => ({ id, title, url }));
}

function fetchAgentDocument(state, id, publicUrl) {
    const documentId = cleanText(id, 240);
    if (documentId.startsWith('organisation:')) {
        const organisationId = documentId.slice('organisation:'.length);
        const organisation = findOrganisation(state, organisationId);
        const conversations = state.conversations
            .filter((item) => item.organisationId === organisation.id)
            .map((conversation) => ({
                id: conversation.id,
                status: conversation.status,
                channel: conversation.channel,
                summary: conversation.summary,
                currentNeed: conversation.currentNeed,
                concerns: conversation.concerns,
                nextAction: conversation.nextAction,
                escalation: conversation.escalation,
                updatedAt: conversation.updatedAt
            }));
        const tasks = state.operatorTasks
            .filter((task) => task.organisationId === organisation.id)
            .map(publicOperatorTask)
            .sort(sortOperatorTasks);
        const activity = state.audit
            .filter((event) => event.organisationId === organisation.id)
            .slice(-100);
        const document = {
            record: buildContextSnapshot(organisation),
            conversations,
            operatorTasks: tasks,
            activity
        };
        return {
            id: documentId,
            title: `${organisation.displayName} lifecycle record`,
            text: JSON.stringify(document, null, 2),
            url: `${publicUrl}/operator#organisation-${encodeURIComponent(organisation.id)}`,
            metadata: {
                type: 'lifecycle_record',
                lifecycleState: organisation.lifecycleState,
                recordType: organisation.recordType,
                openOperatorTasks: tasks.filter((task) => task.status === 'open').length,
                revision: state.revision
            }
        };
    }
    if (documentId.startsWith('operator-task:')) {
        const taskId = documentId.slice('operator-task:'.length);
        const task = state.operatorTasks.find((item) => item.id === taskId);
        if (!task) throw lifecycleError(404, 'Operator task not found', 'operator_task_not_found');
        const organisation = findOrganisation(state, task.organisationId);
        const document = {
            task: publicOperatorTask(task),
            organisation: {
                organisationId: organisation.id,
                displayName: organisation.displayName,
                lifecycleState: organisation.lifecycleState,
                nextAction: organisation.nextAction
            },
            activity: state.audit.filter((event) => event.targetType === 'operator_task' && event.targetId === task.id)
        };
        return {
            id: documentId,
            title: `${task.title} · ${organisation.displayName}`,
            text: JSON.stringify(document, null, 2),
            url: `${publicUrl}/operator#organisation-${encodeURIComponent(organisation.id)}`,
            metadata: {
                type: 'operator_task',
                status: task.status,
                priority: task.priority,
                lifecycleState: organisation.lifecycleState,
                revision: state.revision
            }
        };
    }
    throw lifecycleError(404, 'Agent document not found', 'agent_document_not_found');
}

function findOrganisation(state, id) {
    const organisation = state.organisations.find((item) => item.id === id);
    if (!organisation) throw lifecycleError(404, 'Organisation not found', 'organisation_not_found');
    return organisation;
}

async function readCompleteOrganisationAudit(repository, access, organisationId, fallbackAudit, expectedRevision) {
    const startedAt = Date.now();
    let serializedBytes = 0;
    const appendEvents = (target, values) => {
        for (const event of values) {
            serializedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
            if (
                target.length >= MAX_SYNCHRONOUS_AUDIT_EXPORT_EVENTS ||
                serializedBytes > MAX_SYNCHRONOUS_AUDIT_EXPORT_BYTES ||
                Date.now() - startedAt > MAX_SYNCHRONOUS_AUDIT_EXPORT_MS
            ) {
                throw lifecycleError(
                    413,
                    'Lifecycle audit history is too large for a synchronous export',
                    'lifecycle_audit_export_limit_exceeded',
                    {
                        maxEvents: MAX_SYNCHRONOUS_AUDIT_EXPORT_EVENTS,
                        maxBytes: MAX_SYNCHRONOUS_AUDIT_EXPORT_BYTES
                    }
                );
            }
            target.push(event);
        }
    };
    if (!repository || typeof repository.readAudit !== 'function') {
        const events = [];
        appendEvents(events, (Array.isArray(fallbackAudit) ? fallbackAudit : [])
            .filter((event) => event.organisationId === organisationId));
        return events;
    }
    const events = [];
    let afterSequence = -1;
    let throughSequence = null;
    for (let pageNumber = 1; pageNumber <= MAX_SYNCHRONOUS_AUDIT_EXPORT_PAGES; pageNumber += 1) {
        const page = await repository.readAudit(access, {
            organisationId,
            afterSequence,
            throughSequence,
            expectedRevision: throughSequence == null ? expectedRevision : null,
            limit: 500
        });
        const pageEvents = Array.isArray(page && page.events) ? page.events : [];
        appendEvents(events, pageEvents.filter((event) => event.organisationId === organisationId));
        if (!page || page.hasMore !== true) return events;
        if (pageNumber >= MAX_SYNCHRONOUS_AUDIT_EXPORT_PAGES) {
            throw lifecycleError(
                413,
                'Lifecycle audit history is too large for a synchronous export',
                'lifecycle_audit_export_limit_exceeded',
                {
                    maxEvents: MAX_SYNCHRONOUS_AUDIT_EXPORT_EVENTS,
                    maxBytes: MAX_SYNCHRONOUS_AUDIT_EXPORT_BYTES
                }
            );
        }
        const nextSequence = Number(page.nextSequence);
        const boundary = Number(page.throughSequence);
        if (
            !pageEvents.length || !Number.isInteger(nextSequence) || nextSequence <= afterSequence ||
            !Number.isInteger(boundary) || boundary < nextSequence
        ) {
            throw lifecycleError(503, 'Lifecycle audit export is temporarily unavailable', 'lifecycle_audit_page_invalid');
        }
        afterSequence = nextSequence;
        throughSequence = boundary;
    }
    throw lifecycleError(413, 'Lifecycle audit history is too large for a synchronous export', 'lifecycle_audit_export_limit_exceeded');
}

function findLinkedOrganisation(state, id, required = true) {
    const target = cleanText(id, 180);
    const organisation = state.organisations.find((item) => (
        item.id === target ||
        item.links.serviceDeskCustomerId === target ||
        item.links.salesCustomerId === target ||
        item.links.dattoRmmSiteUid === target
    ));
    if (!organisation && required) {
        throw lifecycleError(404, 'Organisation not found', 'organisation_not_found');
    }
    return organisation || null;
}

function findConversationBySession(state, sessionHash, required = true) {
    const conversation = state.conversations.find((item) => item.sessionHash === sessionHash);
    if (!conversation && required) {
        throw lifecycleError(404, 'Prospect conversation not found', 'conversation_not_found');
    }
    return conversation || null;
}

function normaliseConversationNextAction(value) {
    const allowed = ['continue_chat', 'human_follow_up', 'send_scope', 'start_scoping', 'book_meeting', 'none'];
    const type = allowed.includes(value.type) ? value.type : 'continue_chat';
    return {
        type,
        timing: cleanText(value.timing, 180),
        detail: cleanText(value.detail, 1000)
    };
}

function normaliseOrganisationNextAction(value) {
    const output = {};
    if (value.type !== undefined) output.type = cleanText(value.type, 80);
    if (value.detail !== undefined) output.detail = cleanText(value.detail, 1000);
    if (value.timing !== undefined) output.timing = cleanText(value.timing, 180);
    if (value.owner !== undefined) output.owner = cleanText(value.owner, 180);
    if (value.dueAt !== undefined) output.dueAt = validIsoDate(value.dueAt);
    if (value.status !== undefined) output.status = ['open', 'completed', 'cancelled'].includes(value.status) ? value.status : 'open';
    return output;
}

function normaliseLinks(value) {
    const output = {};
    if (value.salesCustomerId !== undefined) output.salesCustomerId = cleanText(value.salesCustomerId, 180);
    if (value.serviceDeskCustomerId !== undefined) output.serviceDeskCustomerId = cleanText(value.serviceDeskCustomerId, 180);
    return output;
}

function normaliseNonNegativeInteger(value, code) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 1000000) {
        throw lifecycleError(400, 'Datto RMM snapshot counts must be non-negative integers', code);
    }
    return number;
}

function normaliseOptionalCount(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
}

function normaliseScope(value) {
    const output = {};
    if (value.status !== undefined) {
        output.status = ['not_started', 'ready', 'in_progress', 'complete', 'approved'].includes(value.status)
            ? value.status
            : 'not_started';
    }
    for (const field of ['salesCustomerId', 'assessmentId', 'proposalId']) {
        if (value[field] !== undefined) output[field] = cleanText(value[field], 180);
    }
    return output;
}

function normaliseOnboarding(value) {
    const output = {};
    if (value.status !== undefined) {
        output.status = ['not_started', 'ready', 'in_progress', 'blocked', 'complete'].includes(value.status)
            ? value.status
            : 'not_started';
    }
    if (Array.isArray(value.gates)) {
        output.gates = value.gates.slice(0, 100).map((gate) => ({
            id: cleanText(gate && gate.id, 180) || createId('onboarding_gate'),
            title: cleanText(gate && gate.title, 300),
            status: ['pending', 'ready', 'in_progress', 'blocked', 'complete'].includes(gate && gate.status)
                ? gate.status
                : 'pending',
            owner: cleanText(gate && gate.owner, 180),
            dependencies: cleanStringList(gate && gate.dependencies, 30, 180)
        })).filter((gate) => gate.title);
    }
    if (Array.isArray(value.devices)) output.devices = normaliseOnboardingDevices(value.devices);
    if (Array.isArray(value.blockers)) output.blockers = cleanStringList(value.blockers, 100, 1000);
    if (value.startedAt !== undefined) output.startedAt = validIsoDate(value.startedAt);
    if (value.completedAt !== undefined) output.completedAt = validIsoDate(value.completedAt);
    return output;
}

function normaliseSupportHistory(value) {
    const output = {};
    if (Array.isArray(value.ticketIds)) output.ticketIds = cleanStringList(value.ticketIds, 500, 180);
    if (Array.isArray(value.recurringThemes)) output.recurringThemes = cleanStringList(value.recurringThemes, 100, 500);
    if (value.lastTicketAt !== undefined) output.lastTicketAt = validIsoDate(value.lastTicketAt);
    if (Array.isArray(value.evidence)) {
        output.evidence = value.evidence.map(normaliseSupportEvidenceEvent).filter(Boolean).slice(-500);
    }
    return output;
}

function recurringSupportThemes(events) {
    const counts = new Map();
    for (const event of events || []) {
        if (event.simulated || event.type !== 'ticket_raised' || !event.category) continue;
        counts.set(event.category, (counts.get(event.category) || 0) + 1);
    }
    return Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .sort((left, right) => right[1] - left[1])
        .map(([category]) => prettyCategory(category))
        .slice(0, 100);
}

function buildServiceProof(organisations, at) {
    const current = at instanceof Date ? at : new Date(at);
    const period = Number.isFinite(current.getTime()) ? current.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
    const allEvents = organisations.flatMap((organisation) => (
        organisation.support && organisation.support.evidence || []
    ));
    const events = allEvents.filter((event) => String(event.occurredAt).startsWith(period));
    const operationalEvents = events.filter((event) => !event.simulated);
    const latestByTicket = new Map();
    for (const event of allEvents) {
        if (event.simulated) continue;
        const currentEvent = latestByTicket.get(event.ticketId);
        if (!currentEvent || String(event.occurredAt).localeCompare(String(currentEvent.occurredAt)) >= 0) {
            latestByTicket.set(event.ticketId, event);
        }
    }
    const currentAttention = Array.from(latestByTicket.values()).filter((event) => event.requiresAttention);
    return {
        period,
        ticketsRaised: operationalEvents.filter((event) => event.type === 'ticket_raised').length,
        ticketsResolved: operationalEvents.filter((event) => event.type === 'ticket_resolved').length,
        remediations: operationalEvents.filter((event) => event.remediation).length,
        evidenceEvents: operationalEvents.length,
        simulatedEvents: events.filter((event) => event.simulated).length,
        needsAttention: currentAttention.length,
        pendingApprovals: currentAttention.filter((event) => event.type === 'recommendation_created').length,
        recentEvents: events.slice().sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt))).slice(0, 20)
    };
}

function prettyCategory(value) {
    return cleanText(value, 120)
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function audit(access, action, organisation, summary, conversationId = '', details = {}, metadata = {}) {
    return Object.assign({
        actorType: access.user && access.user.role === 'public_agent' ? 'agent' : 'user',
        actorId: access.user && access.user.email || 'system',
        actorRole: access.user && access.user.role || '',
        action,
        targetType: 'organisation',
        targetId: organisation.id,
        organisationId: organisation.id,
        conversationId,
        summary,
        details
    }, metadata || {});
}

function observation(organisation, conversation, metadata, overrides) {
    return Object.assign({
        organisationId: organisation.id,
        conversationId: conversation.id,
        agent: cleanText(metadata.agent || 'prospect_agent', 120),
        model: cleanText(metadata.model, 120),
        providerModel: metadata.providerModel,
        runtime: metadata.runtime,
        reasoningEffort: metadata.reasoningEffort,
        promptVersion: metadata.promptVersion,
        toolSchemaVersion: metadata.toolSchemaVersion,
        outputSchemaVersion: metadata.outputSchemaVersion,
        policyId: metadata.policyId,
        policyVersion: metadata.policyVersion,
        policyEffectiveFrom: metadata.policyEffectiveFrom,
        releaseSha: metadata.releaseSha,
        releaseRunId: metadata.releaseRunId,
        inputTokens: metadata.inputTokens,
        cachedInputTokens: metadata.cachedInputTokens,
        cacheWriteTokens: metadata.cacheWriteTokens,
        outputTokens: metadata.outputTokens,
        reasoningTokens: metadata.reasoningTokens,
        totalTokens: metadata.totalTokens,
        toolFailures: metadata.toolFailures,
        approximateCostUsd: metadata.approximateCostUsd,
        traceId: metadata.traceId,
        details: metadata.details
    }, overrides || {});
}

function sortExceptions(a, b) {
    const weight = { high: 0, medium: 1, low: 2 };
    return (weight[a.priority] || 3) - (weight[b.priority] || 3);
}

function sortOperatorTasks(a, b) {
    const statusWeight = { open: 0, completed: 1, cancelled: 2 };
    const priorityWeight = { high: 0, medium: 1, low: 2 };
    const statusDifference = (statusWeight[a.status] ?? 3) - (statusWeight[b.status] ?? 3);
    if (statusDifference) return statusDifference;
    const priorityDifference = (priorityWeight[a.priority] ?? 3) - (priorityWeight[b.priority] ?? 3);
    if (priorityDifference) return priorityDifference;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
}

function toolResultDetails(toolName, output) {
    if (toolName === 'update_prospect_context') {
        return {
            appliedFields: Array.isArray(output && output.applied) ? output.applied.map((item) => item.field).slice(0, 30) : [],
            ignoredCount: Array.isArray(output && output.ignored) ? output.ignored.length : 0
        };
    }
    if (toolName === 'suggest_next_action') {
        return { nextActionType: cleanText(output && output.action && output.action.type, 80) };
    }
    if (toolName === 'advance_lifecycle') {
        return { lifecycleState: cleanText(output && output.lifecycleState, 80) };
    }
    return { saved: Boolean(output && output.saved) };
}

function cleanStringList(value, maxItems, maxLength) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean))).slice(0, maxItems);
}

function normaliseConfidence(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

function resolveRetentionPolicy(env) {
    return {
        rawConversationDays: retentionDays(env.NOFRIES_RETENTION_RAW_CONVERSATION_DAYS, 90, 30, 730),
        abandonedProspectDays: retentionDays(env.NOFRIES_RETENTION_ABANDONED_PROSPECT_DAYS, 180, 60, 1095),
        observabilityDays: retentionDays(env.NOFRIES_RETENTION_OBSERVABILITY_DAYS, 365, 90, 2190),
        prospectSecurityDays: retentionDays(env.NOFRIES_RETENTION_PROSPECT_SECURITY_DAYS, 30, 7, 365)
    };
}

function retentionPreview(state, policy, at) {
    const atTime = at instanceof Date ? at.getTime() : Date.parse(at);
    const rawMessagesBefore = new Date(atTime - (policy.rawConversationDays * 86400000)).toISOString();
    const abandonedProspectsBefore = new Date(atTime - (policy.abandonedProspectDays * 86400000)).toISOString();
    const observabilityBefore = new Date(atTime - (policy.observabilityDays * 86400000)).toISOString();
    const prospectSecurityBefore = new Date(atTime - (policy.prospectSecurityDays * 86400000)).toISOString();
    const abandonedCutoff = Date.parse(abandonedProspectsBefore);
    const rawCutoff = Date.parse(rawMessagesBefore);
    const observabilityCutoff = Date.parse(observabilityBefore);
    const prospectSecurityCutoff = Date.parse(prospectSecurityBefore);

    const expiredOrganisations = state.organisations.filter((organisation) => {
        if (organisation.recordType !== 'prospect') return false;
        if (!['prospect', 'discovery'].includes(organisation.lifecycleState)) return false;
        if (organisation.links.salesCustomerId || organisation.links.serviceDeskCustomerId || organisation.links.dattoRmmSiteUid) return false;
        if (organisation.scope.salesCustomerId || organisation.scope.assessmentId || organisation.scope.proposalId) return false;
        const conversations = state.conversations.filter((item) => item.organisationId === organisation.id);
        if (conversations.some((item) => item.escalation && item.escalation.required)) return false;
        const updatedAt = Date.parse(organisation.updatedAt);
        return Number.isFinite(updatedAt) && updatedAt < abandonedCutoff;
    }).map((organisation) => ({
        organisationId: organisation.id,
        displayName: organisation.displayName,
        lifecycleState: organisation.lifecycleState,
        updatedAt: organisation.updatedAt
    }));

    const expiredOrganisationIds = new Set(expiredOrganisations.map((item) => item.organisationId));
    const expiredRawMessageCount = state.conversations.reduce((total, conversation) => {
        if (conversation.escalation && conversation.escalation.required) return total;
        return total + conversation.messages.filter((message) => (
            !expiredOrganisationIds.has(conversation.organisationId) && Date.parse(message.at) < rawCutoff
        )).length;
    }, 0);
    const expiredObservabilityCount = state.observability.filter((event) => (
        !expiredOrganisationIds.has(event.organisationId) && Date.parse(event.at) < observabilityCutoff
    )).length;
    const expiredProspectSecurityEventCount = (state.prospectSecurityEvents || []).filter((event) => (
        Date.parse(event.createdAt) < prospectSecurityCutoff || Date.parse(event.expiresAt) <= atTime
    )).length;

    return {
        policy,
        previewedAt: new Date(atTime).toISOString(),
        cutoffs: {
            rawMessagesBefore,
            abandonedProspectsBefore,
            observabilityBefore,
            prospectSecurityBefore
        },
        expiredOrganisations,
        expiredRawMessageCount,
        expiredObservabilityCount,
        expiredProspectSecurityEventCount
    };
}

function retentionDays(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function emptyScopingDeletionFence() {
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

function currentScopingDeletionFence(organisation) {
    return Object.assign(
        emptyScopingDeletionFence(),
        organisation && organisation.scope && organisation.scope.deletionFence || {}
    );
}

function completedScopingDeletionReceipt(organisation, expected) {
    const receipts = organisation && organisation.scope && Array.isArray(organisation.scope.deletionReceipts)
        ? organisation.scope.deletionReceipts
        : [];
    const receipt = receipts.find((candidate) => candidate && candidate.claimId === expected.claimId);
    if (!receipt) return null;
    if (Number(receipt.generation || 0) !== expected.generation) {
        throw lifecycleError(
            409,
            'The completed deletion claim is bound to another fence generation',
            'scoping_deletion_fence_conflict'
        );
    }
    return receipt;
}

function recordCompletedScopingDeletionReceipt(organisation, fence, completedAt, completedBy) {
    const receipts = Array.isArray(organisation.scope.deletionReceipts)
        ? organisation.scope.deletionReceipts
        : [];
    const existing = receipts.find((candidate) => candidate && candidate.claimId === fence.claimId);
    if (existing) {
        if (Number(existing.generation || 0) !== Number(fence.generation || 0)) {
            throw lifecycleError(
                409,
                'The completed deletion claim is bound to another fence generation',
                'scoping_deletion_fence_conflict'
            );
        }
        return existing;
    }
    const receipt = {
        claimId: fence.claimId,
        generation: Number(fence.generation || 0),
        salesCustomerId: fence.salesCustomerId,
        assessmentId: fence.assessmentId,
        completedAt,
        completedBy
    };
    organisation.scope.deletionReceipts = receipts.concat(receipt);
    return receipt;
}

function normaliseScopingDeletionFenceInput(input = {}, options = {}) {
    const claimId = cleanText(input.deletionClaimId, 180);
    const rawGeneration = input.deletionFenceGeneration;
    const hasGeneration = rawGeneration != null && rawGeneration !== '';
    if (!claimId && !hasGeneration) return null;
    const generation = Number(rawGeneration);
    if (!claimId || !Number.isInteger(generation) || generation <= 0) {
        throw lifecycleError(400, 'A valid deletion claim ID and positive fence generation are required', 'scoping_deletion_fence_invalid');
    }
    const leaseUntil = validIsoDate(input.deletionClaimLeaseUntil);
    if (options.required !== true && input.deletionClaimLeaseUntil && !leaseUntil) {
        throw lifecycleError(400, 'The deletion-claim lease time is invalid', 'scoping_deletion_fence_invalid');
    }
    return { claimId, generation, leaseUntil };
}

function assertExactScopingDeletionFence(fence, expected) {
    if (fence.claimId !== expected.claimId || Number(fence.generation || 0) !== expected.generation) {
        throw lifecycleError(409, 'A newer or different lifecycle deletion fence is authoritative', 'scoping_deletion_fence_stale');
    }
}

function assertScopingDeletionFenceAdvance(organisation, incoming, links = {}) {
    if (completedScopingDeletionReceipt(organisation, incoming)) {
        throw lifecycleError(
            409,
            'This deletion claim has already completed and cannot be replayed',
            'scoping_deletion_fence_terminal'
        );
    }
    const fence = currentScopingDeletionFence(organisation);
    if (fence.status === 'none') return;
    const sameLinks = fence.salesCustomerId === links.salesCustomerId &&
        fence.assessmentId === links.assessmentId;
    if (fence.status === 'completed' && !sameLinks) return;
    if (!sameLinks) {
        throw lifecycleError(
            409,
            'The lifecycle deletion fence is bound to different Sales links',
            'scoping_deletion_fence_conflict'
        );
    }
    if (Number(fence.generation || 0) > incoming.generation) {
        throw lifecycleError(409, 'A newer lifecycle deletion fence is already active', 'scoping_deletion_fence_stale');
    }
    if (Number(fence.generation || 0) === incoming.generation && fence.claimId !== incoming.claimId) {
        throw lifecycleError(409, 'This lifecycle fence generation belongs to another deletion claim', 'scoping_deletion_fence_conflict');
    }
    if (
        Number(fence.generation || 0) === incoming.generation &&
        fence.claimId === incoming.claimId &&
        ['compensated', 'completed'].includes(fence.status)
    ) {
        throw lifecycleError(409, 'This deletion fence has already reached a later terminal state', 'scoping_deletion_fence_terminal');
    }
}

function assertScopingLinkFence(organisation, salesCustomerId, assessmentId, deletionRestore) {
    const historicalDeletion = completedScopingLinkDeletionReceipt(
        organisation,
        salesCustomerId,
        assessmentId
    );
    if (historicalDeletion) {
        throw lifecycleError(
            409,
            'A completed deletion receipt prevents replay of the removed Sales links',
            'scoping_deletion_completed'
        );
    }
    const fence = currentScopingDeletionFence(organisation);
    if (fence.status === 'unlinked') {
        if (deletionRestore) {
            assertExactScopingDeletionFence(fence, deletionRestore);
            return { restoring: true, clearCompleted: false, fence };
        }
        throw lifecycleError(409, 'Lifecycle scoping is fenced for an in-progress Sales deletion', 'scoping_deletion_in_progress');
    }
    if (deletionRestore) {
        if (fence.status === 'none' && scopingLinksMatch(organisation, salesCustomerId, assessmentId)) {
            return {
                restoring: true,
                clearCompleted: false,
                fence: Object.assign(emptyScopingDeletionFence(), {
                    claimId: deletionRestore.claimId,
                    generation: deletionRestore.generation,
                    status: 'unlinked',
                    salesCustomerId,
                    assessmentId,
                    leaseUntil: deletionRestore.leaseUntil
                })
            };
        }
        assertExactScopingDeletionFence(fence, deletionRestore);
        if (fence.status === 'compensated') {
            return { restoring: false, clearCompleted: false, fence };
        }
        throw lifecycleError(409, 'The lifecycle deletion fence is not available for compensation', 'scoping_deletion_state_conflict');
    }
    if (fence.status === 'completed') {
        if (fence.salesCustomerId === salesCustomerId || fence.assessmentId === assessmentId) {
            throw lifecycleError(409, 'A completed deletion fence prevents replay of the removed Sales links', 'scoping_deletion_completed');
        }
        return { restoring: false, clearCompleted: true, fence };
    }
    return { restoring: false, clearCompleted: false, fence };
}

function completedScopingLinkDeletionReceipt(organisation, salesCustomerId, assessmentId) {
    const receipts = organisation && organisation.scope && Array.isArray(organisation.scope.deletionReceipts)
        ? organisation.scope.deletionReceipts
        : [];
    return receipts.find((receipt) => receipt && (
        receipt.salesCustomerId === salesCustomerId ||
        receipt.assessmentId === assessmentId
    )) || null;
}

function assertScopingReceiptBinding(receipt, expected) {
    if (
        receipt.payloadHash !== expected.operationPayloadHash ||
        receipt.organisationId !== expected.organisationId ||
        receipt.salesCustomerId !== expected.salesCustomerId ||
        receipt.assessmentId !== expected.assessmentId
    ) {
        throw lifecycleError(
            409,
            'The handoff operation ID is bound to different content',
            'handoff_operation_payload_conflict'
        );
    }
}

function scopingLinksMatch(organisation, salesCustomerId, assessmentId) {
    const currentCustomerId = organisation.links.salesCustomerId || organisation.scope.salesCustomerId;
    return currentCustomerId === salesCustomerId && organisation.scope.assessmentId === assessmentId;
}

function validIsoDate(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function isNoFriesHqName(value) {
    const name = cleanText(value, 180).toLowerCase().replace(/\s+/g, ' ');
    return /^(no fries (?:hq|headquarters))(?: (?:workshop|internal pilot|pilot))?$/.test(name);
}

function governedDattoSiteName(organisation) {
    const displayName = cleanText(organisation && organisation.displayName, 300);
    return isNoFriesHqName(displayName) ? 'No Fries Headquarters' : displayName;
}

function dattoSiteNameKey(value) {
    const name = cleanText(value, 300).toLocaleLowerCase('en-NZ').replace(/\s+/g, ' ');
    return isNoFriesHqName(name) ? 'no fries headquarters' : name;
}

function assertExpectedRevisionProvided(expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') {
        throw lifecycleError(
            400,
            'The current lifecycle revision is required for this full-profile replacement',
            'expected_revision_required'
        );
    }
}

function assertExpectedRevisionSyntax(expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') return;
    const revision = Number(expectedRevision);
    if (!Number.isInteger(revision) || revision < 0) {
        throw lifecycleError(400, 'A valid lifecycle revision is required', 'invalid_revision');
    }
}

function assertExpectedRevisionForProofWrite(expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') {
        throw lifecycleError(
            400,
            'The current lifecycle revision is required for new proof evidence',
            'expected_revision_required'
        );
    }
}

function assertExpectedRevisionForProofApproval(expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') {
        throw lifecycleError(
            400,
            'The current lifecycle revision is required for proof approval',
            'expected_revision_required'
        );
    }
}

function lifecycleError(statusCode, message, code, details = {}) {
    return new LifecycleRepositoryError(statusCode, message, Object.assign({ code }, details));
}

function dattoOperatingSystemMatchesPlatform(platformValue, operatingSystemValue) {
    const platform = cleanText(platformValue, 40).toLowerCase();
    const operatingSystem = cleanText(operatingSystemValue, 240).toLowerCase();
    if (!operatingSystem) return false;
    if (platform === 'windows') return /\bwindows\b/.test(operatingSystem);
    if (platform === 'macos') return /\b(mac\s?os|os\s*x|darwin)\b/.test(operatingSystem);
    if (platform === 'linux') return /\b(linux|ubuntu|debian|fedora|centos|red\s*hat|suse)\b/.test(operatingSystem);
    return false;
}

module.exports = {
    createLifecycleService,
    publicConversation
};
