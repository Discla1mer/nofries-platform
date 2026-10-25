const crypto = require('crypto');

const CUSTOMER_MASTER_VERSION = 1;
const ONBOARDING_PLAN_VERSION = 'managed_customer_v1';
const PROOF_VERSION = 1;
const EXTERNAL_SYSTEMS = Object.freeze([
    'sales_workspace',
    'hubspot',
    'apollo',
    'autotask',
    'datto_rmm',
    'kaseya_mdr',
    'backup'
]);
const EXTERNAL_RECORD_TYPES = Object.freeze([
    'customer', 'company', 'deal', 'contact', 'account', 'contract', 'site', 'device', 'organisation', 'tenant'
]);
const PROOF_SOURCES = Object.freeze([
    'service_desk', 'datto_rmm', 'mdr', 'backup', 'change', 'risk', 'billing', 'roadmap'
]);
const MAX_OPEN_PROOF_PERIODS = 60;
const PROOF_WRITABLE_MONTHS = 60;
const MAX_CUSTOMER_MASTER_ENTITLEMENTS = 100;
const MAX_PROOF_EVIDENCE_PER_PERIOD = 500;
const PROOF_PERIOD_CLOSE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_SECRET_SCAN_LENGTH = 500;
const MAX_SECRET_DECODE_PASSES = 256;
const SECRET_DECODE_LIMIT_REACHED = '__proof_secret_decode_limit_reached__';
const BASE_PROOF_SOURCES = Object.freeze([
    'service_desk', 'datto_rmm', 'change', 'risk', 'billing', 'roadmap'
]);
const ENTITLEMENT_PROOF_SOURCES = Object.freeze({
    managed_it_core: Object.freeze([]),
    managed_endpoint: Object.freeze([]),
    managed_endpoint_internal_pilot: Object.freeze([]),
    ai_service_desk: Object.freeze([]),
    datto_rmm: Object.freeze([]),
    microsoft_365_admin: Object.freeze([]),
    google_workspace_admin: Object.freeze([]),
    supplier_coordination: Object.freeze([]),
    monthly_proof: Object.freeze([]),
    customer_onboarding: Object.freeze([]),
    endpoint_security: Object.freeze(['mdr']),
    mdr: Object.freeze(['mdr']),
    endpoint_backup: Object.freeze(['backup']),
    work_file_backup: Object.freeze(['backup']),
    backup: Object.freeze(['backup'])
});
const GATE_IDS = Object.freeze({
    G0: 'authority',
    G1: 'access_readiness',
    G2: 'pilot_devices_verified',
    G3: 'endpoint_reconciliation',
    G4: 'monitoring_acceptance',
    G5: 'active_service_approval'
});

function createEmptyCustomerMaster(at = new Date().toISOString()) {
    return {
        schemaVersion: CUSTOMER_MASTER_VERSION,
        customerId: '',
        identity: { legalName: '', tradingName: '', domains: [] },
        externalRefs: [],
        contacts: {
            sponsor: emptyContact(),
            technical: emptyContact(),
            security: emptyContact(),
            billing: emptyContact(),
            emergencyAfterHours: emptyContact()
        },
        authority: {
            authorityMatrixVersion: '',
            acceptedBy: '',
            acceptedAt: '',
            evidenceRef: ''
        },
        serviceSchedule: {
            agreementId: '',
            version: '',
            contentHash: '',
            startAt: '',
            endAt: '',
            supportHours: '',
            slaId: '',
            timezone: 'Pacific/Auckland'
        },
        entitlements: [],
        entitlementsOverflow: false,
        estate: { contractedUsers: null, contractedEndpoints: null, plannedDevices: null },
        billing: { profileId: '', currency: 'NZD', taxTreatment: '', billingCadence: '' },
        governance: { serviceOwner: '', proofDueRule: 'monthly', nextReviewAt: '' },
        createdAt: at,
        updatedAt: at,
        revision: 0
    };
}

function normaliseCustomerMaster(value, at = new Date().toISOString()) {
    const source = object(value);
    const empty = createEmptyCustomerMaster(at);
    const identity = object(source.identity);
    const contacts = object(source.contacts);
    const authority = object(source.authority);
    const schedule = object(source.serviceSchedule);
    const estate = object(source.estate);
    const billing = object(source.billing);
    const governance = object(source.governance);
    const rawEntitlements = Array.isArray(source.entitlements) ? source.entitlements : [];
    return {
        schemaVersion: CUSTOMER_MASTER_VERSION,
        customerId: cleanText(source.customerId, 180),
        identity: {
            legalName: cleanText(identity.legalName, 220),
            tradingName: cleanText(identity.tradingName, 220),
            domains: uniqueStrings(identity.domains, 30, 253).map((item) => item.toLowerCase())
        },
        externalRefs: normaliseExternalReferences(source.externalRefs),
        contacts: {
            sponsor: normaliseContact(contacts.sponsor),
            technical: normaliseContact(contacts.technical),
            security: normaliseContact(contacts.security),
            billing: normaliseContact(contacts.billing),
            emergencyAfterHours: normaliseContact(contacts.emergencyAfterHours)
        },
        authority: {
            authorityMatrixVersion: cleanText(authority.authorityMatrixVersion, 120),
            acceptedBy: cleanText(authority.acceptedBy, 180),
            acceptedAt: iso(authority.acceptedAt),
            evidenceRef: cleanEvidenceReference(authority.evidenceRef)
        },
        serviceSchedule: {
            agreementId: cleanText(schedule.agreementId, 180),
            version: cleanText(schedule.version, 120),
            contentHash: sha256Value(schedule.contentHash),
            startAt: iso(schedule.startAt),
            endAt: iso(schedule.endAt),
            supportHours: cleanText(schedule.supportHours, 500),
            slaId: cleanText(schedule.slaId, 180),
            timezone: cleanText(schedule.timezone || 'Pacific/Auckland', 80)
        },
        entitlements: rawEntitlements.slice(0, MAX_CUSTOMER_MASTER_ENTITLEMENTS).map((item) => {
            const entitlement = object(item);
            return {
                code: cleanText(entitlement.code, 120),
                name: cleanText(entitlement.name, 220),
                quantity: nullableCount(entitlement.quantity),
                effectiveFrom: iso(entitlement.effectiveFrom),
                effectiveTo: iso(entitlement.effectiveTo)
            };
        }).filter((item) => item.code && item.name),
        entitlementsOverflow: source.entitlementsOverflow === true ||
            rawEntitlements.length > MAX_CUSTOMER_MASTER_ENTITLEMENTS,
        estate: {
            contractedUsers: nullableCount(estate.contractedUsers),
            contractedEndpoints: nullableCount(estate.contractedEndpoints),
            plannedDevices: nullableCount(estate.plannedDevices)
        },
        billing: {
            profileId: cleanText(billing.profileId, 180),
            currency: /^[A-Z]{3}$/.test(String(billing.currency || '').toUpperCase())
                ? String(billing.currency).toUpperCase()
                : 'NZD',
            taxTreatment: cleanText(billing.taxTreatment, 120),
            billingCadence: oneOf(billing.billingCadence, ['monthly', 'quarterly', 'annual', 'one_off'], '')
        },
        governance: {
            serviceOwner: cleanText(governance.serviceOwner, 180),
            proofDueRule: cleanText(governance.proofDueRule || 'monthly', 120),
            nextReviewAt: iso(governance.nextReviewAt)
        },
        createdAt: iso(source.createdAt) || at,
        updatedAt: iso(source.updatedAt) || at,
        revision: nonNegativeInteger(source.revision)
    };
}

function createEmptyCommercialAcceptance() {
    return {
        id: '',
        idempotencyKey: '',
        kind: '',
        status: 'not_started',
        source: '',
        sourceEventId: '',
        proposalId: '',
        proposalVersion: '',
        proposalSha256: '',
        acceptedAt: '',
        effectiveDate: '',
        signatory: { name: '', email: '', title: '' },
        authority: { basis: '', evidenceId: '', evidenceSha256: '' },
        recordedBy: '',
        recordedAt: '',
        fingerprint: ''
    };
}

function normaliseCommercialAcceptance(value) {
    const source = object(value);
    const signatory = object(source.signatory);
    const authority = object(source.authority);
    return {
        id: cleanText(source.id, 180),
        idempotencyKey: cleanIdempotencyKey(source.idempotencyKey),
        kind: oneOf(source.kind, ['external', 'internal_pilot'], ''),
        status: oneOf(source.status, ['not_started', 'verified', 'revoked'], 'not_started'),
        source: oneOf(source.source, ['manual', 'hubspot', 'internal_pilot'], ''),
        sourceEventId: cleanText(source.sourceEventId, 220),
        proposalId: cleanText(source.proposalId, 180),
        proposalVersion: cleanText(source.proposalVersion, 120),
        proposalSha256: sha256Value(source.proposalSha256),
        acceptedAt: iso(source.acceptedAt),
        effectiveDate: iso(source.effectiveDate),
        signatory: {
            name: cleanText(signatory.name, 180),
            email: normaliseEmail(signatory.email),
            title: cleanText(signatory.title, 180)
        },
        authority: {
            basis: cleanText(authority.basis, 240),
            evidenceId: cleanEvidenceReference(authority.evidenceId),
            evidenceSha256: sha256Value(authority.evidenceSha256)
        },
        recordedBy: cleanText(source.recordedBy, 180),
        recordedAt: iso(source.recordedAt),
        fingerprint: sha256Value(source.fingerprint)
    };
}

function createEmptyServiceStatus() {
    return {
        state: 'not_started',
        source: 'lifecycle',
        sourceRecordId: '',
        reason: '',
        effectiveAt: '',
        changedBy: '',
        policyVersion: '2026.08'
    };
}

function normaliseServiceStatus(value) {
    const source = object(value);
    return {
        state: oneOf(source.state, ['not_started', 'onboarding', 'active', 'suspended', 'offboarding', 'former'], 'not_started'),
        source: cleanText(source.source || 'lifecycle', 80),
        sourceRecordId: cleanText(source.sourceRecordId, 180),
        reason: cleanText(source.reason, 500),
        effectiveAt: iso(source.effectiveAt),
        changedBy: cleanText(source.changedBy, 180),
        policyVersion: cleanText(source.policyVersion || '2026.08', 80)
    };
}

function createEmptySupportProfile() {
    return {
        schemaVersion: 1,
        contractStatus: 'not_configured',
        serviceStartAt: '',
        serviceEndAt: '',
        slaScheduleRef: '',
        slaVersion: '',
        timezone: 'Pacific/Auckland',
        supportHours: '',
        channels: [],
        authorisedRequesters: [],
        revision: 0,
        updatedAt: '',
        updatedBy: ''
    };
}

function normaliseSupportProfile(value) {
    const source = object(value);
    return {
        schemaVersion: 1,
        contractStatus: oneOf(source.contractStatus, ['not_configured', 'signed', 'expired', 'suspended'], 'not_configured'),
        serviceStartAt: iso(source.serviceStartAt),
        serviceEndAt: iso(source.serviceEndAt),
        slaScheduleRef: cleanEvidenceReference(source.slaScheduleRef),
        slaVersion: cleanText(source.slaVersion, 120),
        timezone: cleanText(source.timezone || 'Pacific/Auckland', 80),
        supportHours: cleanText(source.supportHours, 500),
        channels: uniqueStrings(source.channels, 10, 40).filter((item) => ['email', 'phone', 'portal'].includes(item)),
        authorisedRequesters: (Array.isArray(source.authorisedRequesters) ? source.authorisedRequesters : [])
            .slice(0, 200)
            .map((item) => {
                const requester = object(item);
                return {
                    name: cleanText(requester.name, 180),
                    email: normaliseEmail(requester.email),
                    role: cleanText(requester.role, 120),
                    verificationMethod: cleanText(requester.verificationMethod, 120),
                    evidenceRef: cleanEvidenceReference(requester.evidenceRef),
                    effectiveFrom: iso(requester.effectiveFrom),
                    effectiveTo: iso(requester.effectiveTo),
                    canApproveRiskyActions: requester.canApproveRiskyActions === true
                };
            })
            .filter((item) => item.email),
        revision: nonNegativeInteger(source.revision),
        updatedAt: iso(source.updatedAt),
        updatedBy: cleanText(source.updatedBy, 180)
    };
}

function normaliseExternalReferences(value) {
    return (Array.isArray(value) ? value : []).slice(0, 300).map((item) => normaliseExternalReference(item)).filter(Boolean);
}

function normaliseExternalReference(value) {
    const source = object(value);
    const system = oneOf(source.system, EXTERNAL_SYSTEMS, '');
    const recordType = oneOf(source.recordType, EXTERNAL_RECORD_TYPES, '');
    const externalId = cleanText(source.externalId, 240);
    if (!system || !recordType || !externalId) return null;
    return {
        id: cleanText(source.id, 180) || createId('external_ref'),
        system,
        recordType,
        externalId,
        providerScopeId: cleanText(source.providerScopeId, 180),
        status: oneOf(source.status, ['pending', 'verified', 'retired'], 'pending'),
        verificationMode: oneOf(source.verificationMode, ['provider', 'manual'], 'manual'),
        verifiedAt: iso(source.verifiedAt),
        verifiedBy: cleanText(source.verifiedBy, 180),
        evidenceRef: cleanEvidenceReference(source.evidenceRef),
        createdAt: iso(source.createdAt),
        retiredAt: iso(source.retiredAt),
        retiredBy: cleanText(source.retiredBy, 180),
        retirementReason: cleanText(source.retirementReason, 500)
    };
}

function externalReferenceKey(value) {
    const ref = normaliseExternalReference(value);
    if (!ref) return '';
    return [ref.system, ref.recordType, ref.providerScopeId.toLowerCase(), ref.externalId.toLowerCase()].join(':');
}

function buildOnboardingPlan(options = {}) {
    const at = options.at || new Date().toISOString();
    const owner = cleanText(options.owner, 180);
    const kind = oneOf(options.kind, ['external', 'internal_pilot'], 'external');
    const devices = normaliseOnboardingDevices(options.devices);
    const acceptanceId = cleanText(options.acceptanceId, 180);
    return {
        planId: options.planId || createId('onboarding_plan'),
        planVersion: ONBOARDING_PLAN_VERSION,
        planRevision: 1,
        kind,
        activationRequestId: '',
        status: 'in_progress',
        startedAt: at,
        completedAt: '',
        blockers: [],
        devices,
        gates: [
            gate('G0', GATE_IDS.G0, 'Commercial acceptance and authority', 'derived', [], owner),
            gate('G1', GATE_IDS.G1, 'Access, contacts, SLA and platform crosswalk ready', 'derived', [GATE_IDS.G0], owner),
            gate('G2', GATE_IDS.G2, 'Planned devices enrolled and identity-matched', 'derived', [GATE_IDS.G1], owner),
            gate('G3', GATE_IDS.G3, 'Expected and observed estate reconciled', 'derived', [GATE_IDS.G2], owner),
            gate('G4', GATE_IDS.G4, 'Customer accepts monitoring and service baseline', 'evidence', [GATE_IDS.G3], owner),
            gate('G5', GATE_IDS.G5, 'Dual-control activation approved and executed', 'governed', [GATE_IDS.G4], 'service_owner')
        ],
        acceptanceId
    };
}

function normaliseOnboardingPlan(value) {
    const source = object(value);
    const plan = {
        planId: cleanText(source.planId, 180),
        planVersion: cleanText(source.planVersion, 80),
        planRevision: Math.max(0, nonNegativeInteger(source.planRevision)),
        kind: oneOf(source.kind, ['external', 'internal_pilot'], ''),
        activationRequestId: cleanText(source.activationRequestId, 180),
        acceptanceId: cleanText(source.acceptanceId, 180)
    };
    return plan;
}

function normaliseGate(value) {
    const source = object(value);
    return {
        code: oneOf(source.code, ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'], ''),
        id: cleanText(source.id, 180),
        title: cleanText(source.title, 300),
        type: oneOf(source.type, ['derived', 'evidence', 'governed'], 'derived'),
        status: oneOf(source.status, ['pending', 'in_progress', 'blocked', 'complete'], 'pending'),
        required: source.required !== false,
        owner: cleanText(source.owner, 180),
        ownerRole: cleanText(source.ownerRole, 80),
        dependencies: uniqueStrings(source.dependencies, 10, 180),
        evidenceRefs: normaliseEvidenceReferences(source.evidenceRefs),
        completedBy: cleanText(source.completedBy, 180),
        completedAt: iso(source.completedAt),
        blockedReason: cleanText(source.blockedReason, 500),
        decision: normaliseDecision(source.decision),
        exceptions: normaliseExceptions(source.exceptions)
    };
}

function normaliseActivationRequests(value) {
    return (Array.isArray(value) ? value : []).slice(-100).map((item) => {
        const source = object(item);
        return {
            id: cleanText(source.id, 180),
            idempotencyKey: cleanIdempotencyKey(source.idempotencyKey),
            status: oneOf(source.status, ['pending', 'approved', 'rejected', 'expired', 'consumed', 'revoked'], 'pending'),
            planId: cleanText(source.planId, 180),
            planRevision: nonNegativeInteger(source.planRevision),
            payloadSha256: sha256Value(source.payloadSha256),
            maker: normaliseActor(source.maker),
            checker: normaliseActor(source.checker),
            executor: normaliseActor(source.executor),
            customerAuthorityRef: cleanEvidenceReference(source.customerAuthorityRef),
            reason: cleanText(source.reason, 500),
            createdAt: iso(source.createdAt),
            approvedAt: iso(source.approvedAt),
            expiresAt: iso(source.expiresAt),
            consumedAt: iso(source.consumedAt),
            rejectedAt: iso(source.rejectedAt),
            revokedAt: iso(source.revokedAt)
        };
    }).filter((item) => item.id && item.idempotencyKey);
}

function normaliseProofPeriods(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
        const source = object(item);
        const status = oneOf(source.status, ['collecting', 'incomplete', 'ready', 'approved', 'issued'], 'collecting');
        const requiredSources = uniqueStrings(source.requiredSources, 20, 80)
            .filter((itemValue) => PROOF_SOURCES.includes(itemValue));
        const rawEvidence = Array.isArray(source.evidenceRefs) ? source.evidenceRefs : [];
        const protectedPeriod = ['approved', 'issued'].includes(status);
        const evidenceRefsOverflow = !protectedPeriod && (
            source.evidenceRefsOverflow === true || rawEvidence.length > MAX_PROOF_EVIDENCE_PER_PERIOD
        );
        const selectedEvidence = protectedPeriod
            ? rawEvidence
            : selectOpenProofEvidence(rawEvidence, requiredSources);
        return {
            schemaVersion: PROOF_VERSION,
            id: cleanText(source.id, 180),
            customerId: cleanText(source.customerId, 180),
            period: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(source.period || '')) ? source.period : '',
            timezone: cleanText(source.timezone || 'Pacific/Auckland', 80),
            status,
            requiredSources,
            evidenceRefs: normaliseProofEvidence(selectedEvidence, { preserveAll: protectedPeriod }),
            evidenceRefsOverflow,
            approvedBy: cleanText(source.approvedBy, 180),
            approvedAt: iso(source.approvedAt),
            issuedAt: iso(source.issuedAt),
            createdAt: iso(source.createdAt),
            updatedAt: iso(source.updatedAt)
        };
    }).filter((item) => item.id && item.period);
}

function normaliseProofRequirementLedger(value) {
    const byPeriod = new Map();
    (Array.isArray(value) ? value : []).forEach((item) => {
        const source = object(item);
        const parsed = parseProofPeriod(source.period);
        if (!parsed) return;
        const existing = byPeriod.get(parsed.period) || {
            period: parsed.period,
            timezone: '',
            entitlementCodes: [],
            entitlementCodesOverflow: false,
            requiredSources: [],
            historyComplete: null,
            throughMasterRevision: 0,
            updatedAt: ''
        };
        const timezone = normaliseProofTimezone(source.timezone);
        if (timezone) existing.timezone = timezone;
        const entitlementCodes = Array.from(new Set(existing.entitlementCodes.concat(
            (Array.isArray(source.entitlementCodes) ? source.entitlementCodes : [])
                .map(normaliseEntitlementCode)
                .filter(Boolean)
        ))).sort();
        existing.entitlementCodesOverflow = existing.entitlementCodesOverflow ||
            source.entitlementCodesOverflow === true || entitlementCodes.length > 100;
        existing.entitlementCodes = entitlementCodes.slice(0, 100);
        const selectedSources = new Set(existing.requiredSources.concat(
            uniqueStrings(source.requiredSources, 20, 80).filter((entry) => PROOF_SOURCES.includes(entry))
        ));
        existing.requiredSources = PROOF_SOURCES.filter((entry) => selectedSources.has(entry));
        const sourceHistoryComplete = source.historyComplete === true;
        existing.historyComplete = existing.historyComplete == null
            ? sourceHistoryComplete
            : existing.historyComplete && sourceHistoryComplete;
        existing.throughMasterRevision = Math.max(
            existing.throughMasterRevision,
            nonNegativeInteger(source.throughMasterRevision)
        );
        const updatedAt = iso(source.updatedAt);
        if (updatedAt && (!existing.updatedAt || updatedAt > existing.updatedAt)) existing.updatedAt = updatedAt;
        byPeriod.set(parsed.period, existing);
    });
    return Array.from(byPeriod.values()).map((entry) => Object.assign(entry, {
        historyComplete: entry.historyComplete === true
    }))
        .sort((left, right) => right.period.localeCompare(left.period));
}

function normaliseProofEvidence(value, options = {}) {
    const rawEvidence = Array.isArray(value) ? value : [];
    const selectedEvidence = options.preserveAll === true
        ? rawEvidence
        : rawEvidence.slice(-MAX_PROOF_EVIDENCE_PER_PERIOD);
    return selectedEvidence.map((item) => {
        const source = object(item);
        if (proofEvidenceContainsSensitiveData(source)) return null;
        const providerSource = oneOf(source.source, PROOF_SOURCES, '');
        const capturedAt = iso(source.capturedAt);
        if (!providerSource || !capturedAt) return null;
        const evidence = {
            id: cleanText(source.id, 180) || createId('proof_evidence'),
            source: providerSource,
            category: cleanText(source.category, 120),
            sourceMode: oneOf(source.sourceMode, ['live', 'manual', 'simulated', 'disabled'], 'manual'),
            providerRecordId: cleanText(source.providerRecordId, 220),
            evidenceRef: cleanEvidenceReference(source.evidenceRef),
            checksum: sha256Value(source.checksum),
            periodStart: iso(source.periodStart),
            periodEnd: iso(source.periodEnd),
            capturedAt,
            ingestedAt: iso(source.ingestedAt),
            freshUntil: iso(source.freshUntil),
            recordedBy: cleanText(source.recordedBy, 180),
            facts: normaliseProofFacts(source.facts)
        };
        return proofEvidenceContainsSensitiveData(evidence) ? null : evidence;
    }).filter(Boolean);
}

function selectOpenProofEvidence(value, requiredSources) {
    const evidence = Array.isArray(value) ? value : [];
    if (evidence.length <= MAX_PROOF_EVIDENCE_PER_PERIOD) return evidence;
    const selectedIndices = new Set();
    (Array.isArray(requiredSources) ? requiredSources : []).forEach((requiredSource) => {
        for (let index = evidence.length - 1; index >= 0; index -= 1) {
            if (oneOf(object(evidence[index]).source, PROOF_SOURCES, '') !== requiredSource) continue;
            selectedIndices.add(index);
            break;
        }
    });
    for (let index = evidence.length - 1;
        index >= 0 && selectedIndices.size < MAX_PROOF_EVIDENCE_PER_PERIOD;
        index -= 1) {
        selectedIndices.add(index);
    }
    return Array.from(selectedIndices).sort((left, right) => left - right).map((index) => evidence[index]);
}

function normaliseProofFacts(value) {
    return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => {
        const source = object(item);
        const key = cleanText(source.key, 120).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
        const factValue = cleanText(source.value, 500);
        const label = cleanText(source.label || key.replace(/[_.-]+/g, ' '), 160);
        const unit = cleanText(source.unit, 60);
        if (!key || !factValue || proofFactContainsSensitiveData(source)) return null;
        return {
            key,
            label,
            value: factValue,
            unit,
            status: oneOf(source.status, ['positive', 'informational', 'attention', 'unknown'], 'informational')
        };
    }).filter(Boolean);
}

function proofFactsContainSensitiveData(value) {
    return (Array.isArray(value) ? value : []).some(proofFactContainsSensitiveData);
}

function proofEvidenceContainsSensitiveData(value) {
    const source = object(value);
    if (proofFactsContainSensitiveData(source.facts)) return true;
    // Check every free-text or externally supplied identifier that survives
    // evidence normalisation. Checksums, timestamps, period/source enums and the
    // optimistic revision are structural metadata; scanning them as prose can
    // misclassify legitimate hashes or dates as payment-card candidates.
    return [
        source.id,
        source.category,
        source.providerRecordId,
        source.evidenceRef,
        source.recordedBy
    ].some(containsSecretLikeValue);
}

function proofFactContainsSensitiveData(value) {
    const source = object(value);
    const fields = [source.key, source.label, source.value, source.unit];
    if (fields.some(containsSecretLikeValue)) return true;
    const hasValue = cleanText(source.value, 500) || cleanText(source.unit, 60);
    if (!hasValue) return false;
    const sensitiveName = [source.key, source.label].some(isSensitiveFactFieldName);
    if (!sensitiveName) return false;
    return !isAllowlistedSensitiveFactMetric(source);
}

function evaluateOnboarding(organisation, at = new Date().toISOString()) {
    const onboarding = organisation.onboarding || {};
    const gates = Array.isArray(onboarding.gates) ? onboarding.gates : [];
    if (!gates.length) return { readyForActivation: false, missing: ['onboarding_plan_required'] };
    const byId = new Map(gates.map((item) => [item.id, item]));
    const acceptance = normaliseCommercialAcceptance(organisation.commercialAcceptance);
    const master = normaliseCustomerMaster(organisation.customerMaster, at);
    const support = normaliseSupportProfile(organisation.supportProfile);
    const datto = object(organisation.integrations && organisation.integrations.dattoRmm);
    const devices = normaliseOnboardingDevices(onboarding.devices);
    const nowMs = Date.parse(at);

    setDerivedGate(byId.get(GATE_IDS.G0), acceptance.status === 'verified', 'Verified customer acceptance and authority evidence are required', at);
    const masterMissing = customerMasterMissing(master, support, onboarding.kind);
    const dattoLinked = datto.status === 'linked' && Boolean(datto.siteUid);
    setDerivedGate(
        byId.get(GATE_IDS.G1),
        masterMissing.length === 0 && dattoLinked,
        masterMissing.length ? `Customer master missing: ${masterMissing.join(', ')}` : 'A verified Datto site crosswalk is required',
        at
    );

    const deviceMissing = [];
    if (!devices.length) deviceMissing.push('planned_devices');
    devices.forEach((device) => {
        if (device.status !== 'verified') deviceMissing.push(`${device.id}:verified`);
        if (device.matchStatus !== 'confirmed' || !device.providerRefs.some((ref) => ref.system === 'datto_rmm' && ref.externalId)) {
            deviceMissing.push(`${device.id}:provider_identity`);
        }
    });
    setDerivedGate(byId.get(GATE_IDS.G2), deviceMissing.length === 0, `Device work incomplete: ${deviceMissing.join(', ')}`, at);

    const snapshotAt = Date.parse(datto.capturedAt || datto.lastSyncedAt || '');
    const snapshotFresh = Number.isFinite(snapshotAt) && Number.isFinite(nowMs) && nowMs - snapshotAt >= 0 && nowMs - snapshotAt <= 24 * 60 * 60 * 1000;
    const observedUids = new Set((Array.isArray(datto.devices) ? datto.devices : []).map((item) => cleanText(item.uid, 180)).filter(Boolean));
    const mappedUids = devices.flatMap((device) => device.providerRefs
        .filter((ref) => ref.system === 'datto_rmm')
        .map((ref) => ref.externalId));
    const exactMappings = mappedUids.length === devices.length && new Set(mappedUids).size === mappedUids.length && mappedUids.every((uid) => observedUids.has(uid));
    const countsMatch = datto.expectedDeviceCount != null && datto.deviceCount === datto.expectedDeviceCount;
    const reconciliationReady = dattoLinked && datto.truncated !== true && snapshotFresh && countsMatch && exactMappings;
    const reconciliationReason = !snapshotFresh
        ? 'Datto evidence is missing or stale'
        : datto.truncated === true
            ? 'Datto snapshot was truncated'
            : !countsMatch
                ? 'Expected and observed device counts do not match'
                : !exactMappings ? 'Every planned device must map to one observed Datto UID' : '';
    setDerivedGate(byId.get(GATE_IDS.G3), reconciliationReady, reconciliationReason, at);

    const ordered = [GATE_IDS.G0, GATE_IDS.G1, GATE_IDS.G2, GATE_IDS.G3, GATE_IDS.G4, GATE_IDS.G5];
    ordered.forEach((id, index) => {
        const gateValue = byId.get(id);
        if (!gateValue || gateValue.status === 'complete' || index === 0) return;
        const dependencyIncomplete = gateValue.dependencies.some((dependency) => byId.get(dependency) && byId.get(dependency).status !== 'complete');
        if (dependencyIncomplete && gateValue.status !== 'blocked') {
            gateValue.status = 'pending';
            gateValue.blockedReason = 'Complete the prerequisite gates first';
        }
    });
    if (byId.get(GATE_IDS.G4) && byId.get(GATE_IDS.G4).status === 'complete' && byId.get(GATE_IDS.G3).status !== 'complete') {
        resetGate(byId.get(GATE_IDS.G4));
    }
    const monitoringGate = byId.get(GATE_IDS.G4);
    if (monitoringGate && monitoringGate.status === 'complete') {
        const currentEvidence = (monitoringGate.evidenceRefs || [])
            .slice()
            .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))[0];
        const evidenceFresh = currentEvidence && currentEvidence.sourceMode !== 'simulated' && (
            !currentEvidence.validUntil || Date.parse(currentEvidence.validUntil) > nowMs
        );
        const highRiskException = (monitoringGate.exceptions || []).some((item) => item.status === 'open' && item.severity === 'high');
        if (!evidenceFresh || highRiskException) {
            resetGate(monitoringGate);
            monitoringGate.blockedReason = highRiskException
                ? 'Resolve the high-risk onboarding exception before activation'
                : 'Monitoring acceptance evidence is missing, simulated or stale';
        }
    }
    if (byId.get(GATE_IDS.G5) && byId.get(GATE_IDS.G5).status === 'complete' && organisation.lifecycleState !== 'active') {
        resetGate(byId.get(GATE_IDS.G5));
    }

    onboarding.gates = ordered.map((id) => byId.get(id)).filter(Boolean);
    onboarding.devices = devices;
    onboarding.blockers = onboarding.gates
        .filter((item) => item.status === 'blocked')
        .map((item) => `${item.code || item.id}: ${item.blockedReason}`);
    const readyForActivation = ordered.slice(0, 5).every((id) => byId.get(id) && byId.get(id).status === 'complete');
    if (organisation.lifecycleState !== 'active') {
        onboarding.status = onboarding.blockers.length ? 'blocked' : 'in_progress';
    }
    onboarding.planRevision = Math.max(1, nonNegativeInteger(onboarding.planRevision));
    return {
        readyForActivation,
        missing: onboarding.gates.filter((item) => item.status !== 'complete').map((item) => item.id),
        snapshotFresh,
        exactMappings
    };
}

function customerMasterMissing(master, supportProfile, kind) {
    const missing = [];
    if (!master.customerId) missing.push('customer_id');
    if (!master.identity.legalName) missing.push('legal_name');
    for (const role of ['sponsor', 'security', 'billing', 'emergencyAfterHours']) {
        const contact = master.contacts[role];
        if (!contact.name || !contact.email) missing.push(`${role}_contact`);
    }
    if (!master.serviceSchedule.agreementId || !master.serviceSchedule.version || !master.serviceSchedule.contentHash) missing.push('signed_service_schedule');
    if (!master.serviceSchedule.startAt || !master.serviceSchedule.slaId || !master.serviceSchedule.supportHours) missing.push('service_schedule_terms');
    if (!master.entitlements.length) missing.push('entitlements');
    if (!master.billing.profileId || !master.billing.billingCadence) missing.push('billing_profile');
    if (supportProfile.contractStatus !== 'signed' || !supportProfile.slaScheduleRef || !supportProfile.authorisedRequesters.length) {
        missing.push('support_profile');
    }
    const activeRefs = master.externalRefs.filter((item) => item.status === 'verified');
    if (!activeRefs.some((item) => item.system === 'datto_rmm' && item.recordType === 'site')) missing.push('datto_site_crosswalk');
    if (kind === 'external') {
        if (!activeRefs.some((item) => item.system === 'hubspot' && item.recordType === 'company')) missing.push('hubspot_company_crosswalk');
        if (!activeRefs.some((item) => item.system === 'autotask' && item.recordType === 'account')) missing.push('autotask_account_crosswalk');
    }
    return uniqueStrings(missing, 40, 120);
}

function proofReadiness(proof, at = new Date().toISOString()) {
    const current = Date.parse(at);
    const unresolvedEntitlements = uniqueStrings(proof.unresolvedEntitlements, 100, 120);
    const evidenceIdCounts = (proof.evidenceRefs || []).reduce((counts, evidence) => {
        const id = cleanText(evidence && evidence.id, 180);
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
        return counts;
    }, new Map());
    const sourceRows = proof.requiredSources.map((source) => {
        const candidates = proof.evidenceRefs.filter((item) => item.source === source);
        const evaluated = candidates.map((evidence) => ({
            evidence,
            state: evidenceIdCounts.get(evidence.id) > 1
                ? 'identity_conflict'
                : proofEvidenceState(evidence, proof, current)
        })).sort(compareProofEvidenceCandidates);
        const selected = evaluated[0];
        const evidence = selected && selected.evidence;
        const state = selected && selected.state || 'missing';
        return { source, state, evidenceId: evidence && evidence.id || '', capturedAt: evidence && evidence.capturedAt || '' };
    });
    const unresolved = unresolvedEntitlements.map((code) => `entitlement:${code}:unresolved`);
    const incompleteRequirementHistory = proof.requirementHistoryComplete === false
        ? ['requirement_history:incomplete']
        : [];
    const incompleteEvidenceHistory = proof.evidenceRefsOverflow === true
        ? ['evidence_history:overflow']
        : [];
    return {
        ready: sourceRows.every((item) => item.state === 'fresh') &&
            unresolved.length === 0 && incompleteRequirementHistory.length === 0 &&
            incompleteEvidenceHistory.length === 0,
        sources: sourceRows,
        missing: sourceRows.filter((item) => item.state !== 'fresh')
            .map((item) => `${item.source}:${item.state}`)
            .concat(unresolved, incompleteRequirementHistory, incompleteEvidenceHistory),
        unresolvedEntitlements
    };
}

function requiredProofSourcesForEntitlements(entitlements, at = new Date().toISOString()) {
    return resolveProofRequirementsForEntitlements(entitlements, at).requiredSources;
}

function resolveProofRequirementsForEntitlements(entitlements, at = new Date().toISOString()) {
    const effectiveAt = Date.parse(at);
    const active = proofEntitlements(entitlements).filter((item) => {
        const source = object(item);
        const from = Date.parse(source.effectiveFrom || '');
        const to = Date.parse(source.effectiveTo || '');
        if (Number.isFinite(from) && Number.isFinite(effectiveAt) && from > effectiveAt) return false;
        if (Number.isFinite(to) && Number.isFinite(effectiveAt) && to <= effectiveAt) return false;
        return true;
    });
    return proofRequirementsForActiveEntitlements(active);
}

function resolveProofRequirementsForPeriod(entitlements, period, timezone = 'Pacific/Auckland') {
    const bounds = proofPeriodBounds(period, timezone);
    const candidates = proofEntitlements(entitlements);
    const overlapping = bounds ? candidates.filter((item) => {
        const source = object(item);
        const from = Date.parse(source.effectiveFrom || '');
        const to = Date.parse(source.effectiveTo || '');
        if (Number.isFinite(from) && from >= bounds.endExclusiveMs) return false;
        if (Number.isFinite(to) && to <= bounds.startMs) return false;
        return true;
    }) : candidates;
    const allEntitlementCodes = Array.from(new Set(overlapping.map((item) => (
        normaliseEntitlementCode(object(item).code)
    )).filter(Boolean))).sort();
    return Object.assign(proofRequirementsForActiveEntitlements(overlapping), {
        entitlementCodes: allEntitlementCodes.slice(0, 100),
        entitlementCodesOverflow: allEntitlementCodes.length > 100
    });
}

function proofRequirementsForActiveEntitlements(active) {
    const selectedSources = new Set(BASE_PROOF_SOURCES);
    const unresolvedEntitlements = [];
    active.forEach((item) => {
        const suppliedCode = cleanText(object(item).code, 120);
        const code = normaliseEntitlementCode(suppliedCode);
        if (!Object.prototype.hasOwnProperty.call(ENTITLEMENT_PROOF_SOURCES, code)) {
            if (suppliedCode) unresolvedEntitlements.push(suppliedCode);
            return;
        }
        ENTITLEMENT_PROOF_SOURCES[code].forEach((source) => selectedSources.add(source));
    });
    return {
        requiredSources: PROOF_SOURCES.filter((source) => selectedSources.has(source)),
        unresolvedEntitlements: uniqueStrings(unresolvedEntitlements, 100, 120)
    };
}

function proofPeriodWriteBoundary(proofPeriods, period, timezone, at = new Date().toISOString()) {
    const requested = parseProofPeriod(period);
    const currentPeriod = localProofPeriod(at, timezone);
    const current = parseProofPeriod(currentPeriod);
    if (!requested || !current) return { allowed: false, code: 'proof_timezone_invalid' };
    const earliestIndex = current.index - (PROOF_WRITABLE_MONTHS - 1);
    if (requested.index < earliestIndex || requested.index > current.index) {
        return {
            allowed: false,
            code: 'proof_period_out_of_window',
            earliestPeriod: proofPeriodFromIndex(earliestIndex),
            latestPeriod: current.period
        };
    }
    const existing = (Array.isArray(proofPeriods) ? proofPeriods : []).some((item) => item && item.period === requested.period);
    const openPeriodCount = (Array.isArray(proofPeriods) ? proofPeriods : [])
        .filter((item) => item && !['approved', 'issued'].includes(item.status)).length;
    if (!existing && openPeriodCount >= MAX_OPEN_PROOF_PERIODS) {
        return { allowed: false, code: 'proof_period_capacity_exceeded', maximumOpenPeriods: MAX_OPEN_PROOF_PERIODS };
    }
    return { allowed: true, code: '', earliestPeriod: proofPeriodFromIndex(earliestIndex), latestPeriod: current.period };
}

function governedProofPeriods(at = new Date().toISOString(), timezone = 'Pacific/Auckland') {
    const current = parseProofPeriod(localProofPeriod(at, timezone));
    if (!current) return [];
    return Array.from({ length: PROOF_WRITABLE_MONTHS }, (_, offset) => (
        proofPeriodFromIndex(current.index - offset)
    ));
}

function proofPeriodBounds(period, timezone = 'Pacific/Auckland') {
    const parsed = parseProofPeriod(period);
    const zone = normaliseProofTimezone(timezone);
    if (!parsed || !zone) return null;
    const nextMonth = parsed.month === 12
        ? { year: parsed.year + 1, month: 1 }
        : { year: parsed.year, month: parsed.month + 1 };
    const startMs = zonedDateStartMs(parsed.year, parsed.month, 1, zone);
    const endExclusiveMs = zonedDateStartMs(nextMonth.year, nextMonth.month, 1, zone);
    if (!Number.isFinite(startMs) || !Number.isFinite(endExclusiveMs) || endExclusiveMs <= startMs) return null;
    return {
        period: parsed.period,
        timezone: zone,
        startMs,
        endExclusiveMs,
        endInclusiveMs: endExclusiveMs - 1,
        periodStart: new Date(startMs).toISOString(),
        periodEnd: new Date(endExclusiveMs - 1).toISOString()
    };
}

function proofEvidenceState(evidence, proof, current) {
    if (!evidence.evidenceRef || !evidence.checksum) return 'invalid';
    const bounds = proofPeriodBounds(proof.period, proof.timezone || 'Pacific/Auckland');
    if (!bounds) return 'period_invalid';
    const periodStart = Date.parse(evidence.periodStart || '');
    const periodEnd = Date.parse(evidence.periodEnd || '');
    if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) return 'coverage_missing';
    if (periodEnd < periodStart) return 'coverage_invalid';
    if (periodStart > bounds.startMs || periodEnd < bounds.endInclusiveMs) return 'coverage_mismatch';
    if (!Number.isFinite(current) || current < bounds.endExclusiveMs) return 'period_open';
    const capturedAt = Date.parse(evidence.capturedAt || '');
    const ingestedAt = Date.parse(evidence.ingestedAt || '');
    if (
        !Number.isFinite(capturedAt) || !Number.isFinite(ingestedAt) ||
        capturedAt + PROOF_PERIOD_CLOSE_TOLERANCE_MS < bounds.endExclusiveMs ||
        ingestedAt + PROOF_PERIOD_CLOSE_TOLERANCE_MS < bounds.endExclusiveMs
    ) return 'capture_before_period_end';
    if (['simulated', 'disabled'].includes(evidence.sourceMode)) return evidence.sourceMode;
    const freshUntil = Date.parse(evidence.freshUntil || '');
    if (!Number.isFinite(freshUntil) || freshUntil < current) return 'stale';
    return 'fresh';
}

function compareProofEvidenceCandidates(left, right) {
    const stateWeight = {
        fresh: 0,
        stale: 1,
        simulated: 2,
        disabled: 3,
        period_open: 4,
        capture_before_period_end: 5,
        coverage_mismatch: 6,
        coverage_missing: 7,
        coverage_invalid: 8,
        period_invalid: 9,
        identity_conflict: 10,
        invalid: 11
    };
    const stateDifference = (stateWeight[left.state] ?? 10) - (stateWeight[right.state] ?? 10);
    if (stateDifference) return stateDifference;
    const capturedDifference = String(right.evidence.capturedAt).localeCompare(String(left.evidence.capturedAt));
    if (capturedDifference) return capturedDifference;
    const modeWeight = { live: 0, manual: 1, simulated: 2, disabled: 3 };
    return (modeWeight[left.evidence.sourceMode] ?? 4) - (modeWeight[right.evidence.sourceMode] ?? 4);
}

function proofEntitlements(value) {
    return (Array.isArray(value) ? value : []).filter((item) => {
        const quantity = object(item).quantity;
        return quantity !== 0 && quantity !== '0';
    });
}

function parseProofPeriod(value) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || year < 1 || year > 9998) return null;
    return { period: `${match[1]}-${match[2]}`, year, month, index: (year * 12) + month - 1 };
}

function proofPeriodFromIndex(index) {
    const year = Math.floor(index / 12);
    const month = index - (year * 12) + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function localProofPeriod(at, timezone) {
    const zone = normaliseProofTimezone(timezone);
    const instant = new Date(at);
    if (!zone || !Number.isFinite(instant.getTime())) return '';
    const parts = zonedDateParts(instant.getTime(), zone);
    return parts ? `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}` : '';
}

function normaliseProofTimezone(value) {
    const timezone = cleanText(value || 'Pacific/Auckland', 80);
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(0));
        return timezone;
    } catch (error) {
        return '';
    }
}

function zonedDateStartMs(year, month, day, timezone) {
    const targetKey = (year * 10000) + (month * 100) + day;
    const nominal = utcDateMs(year, month - 1, day);
    let low = nominal - (48 * 60 * 60 * 1000);
    let high = nominal + (48 * 60 * 60 * 1000);
    while (low < high) {
        const midpoint = low + Math.floor((high - low) / 2);
        const parts = zonedDateParts(midpoint, timezone);
        if (!parts) return Number.NaN;
        const key = (parts.year * 10000) + (parts.month * 100) + parts.day;
        if (key >= targetKey) high = midpoint;
        else low = midpoint + 1;
    }
    const parts = zonedDateParts(low, timezone);
    const key = parts && (parts.year * 10000) + (parts.month * 100) + parts.day;
    return key === targetKey ? low : Number.NaN;
}

function zonedDateParts(instantMs, timezone) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA-u-nu-latn', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date(instantMs));
        return {
            year: Number(parts.find((item) => item.type === 'year').value),
            month: Number(parts.find((item) => item.type === 'month').value),
            day: Number(parts.find((item) => item.type === 'day').value)
        };
    } catch (error) {
        return null;
    }
}

function utcDateMs(year, monthIndex, day) {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, monthIndex, day);
    return date.getTime();
}

function buildProofNarrativeGroundwork(proof, at = new Date().toISOString()) {
    const readiness = proofReadiness(proof, at);
    const evidenceById = new Map((proof.evidenceRefs || []).map((item) => [item.id, item]));
    const sections = readiness.sources.map((sourceRow) => {
        const evidence = evidenceById.get(sourceRow.evidenceId);
        const facts = evidence && evidence.facts || [];
        const claimFacts = sourceRow.state === 'fresh'
            ? facts.filter((fact) => fact.status !== 'unknown')
            : [];
        const claims = claimFacts.map((fact) => ({
            claimId: canonicalHash({ evidenceId: evidence.id, key: fact.key, value: fact.value }).slice(0, 24),
            source: sourceRow.source,
            evidenceId: evidence.id,
            evidenceRef: evidence.evidenceRef,
            capturedAt: evidence.capturedAt,
            key: fact.key,
            label: fact.label,
            value: fact.value,
            unit: fact.unit,
            status: fact.status
        }));
        const diagnostics = [];
        if (sourceRow.state !== 'fresh') {
            diagnostics.push({
                code: `evidence_${sourceRow.state}`,
                evidenceId: sourceRow.evidenceId,
                message: `${sourceRow.source} evidence is ${sourceRow.state} and cannot support a customer claim.`
            });
        }
        facts.filter((fact) => fact.status === 'unknown').forEach((fact) => {
            diagnostics.push({
                code: 'fact_unknown',
                evidenceId: evidence && evidence.id || '',
                key: fact.key,
                message: `${fact.label || fact.key} is unknown and cannot support a customer claim.`
            });
        });
        return {
            source: sourceRow.source,
            state: sourceRow.state,
            evidenceId: sourceRow.evidenceId,
            claims,
            diagnostics
        };
    });
    const missingFacts = sections.filter((section) => section.state === 'fresh' && !section.claims.length)
        .map((section) => section.source);
    return {
        schemaVersion: 1,
        period: proof.period,
        evidenceFingerprint: canonicalHash({
            period: proof.period,
            timezone: proof.timezone,
            requiredSources: proof.requiredSources,
            evidence: (proof.evidenceRefs || []).map((item) => ({
                id: item.id,
                source: item.source,
                checksum: item.checksum,
                evidenceRef: item.evidenceRef,
                periodStart: item.periodStart,
                periodEnd: item.periodEnd,
                capturedAt: item.capturedAt,
                facts: item.facts
            }))
        }),
        readyForDraft: readiness.ready && !missingFacts.length,
        readyForApproval: readiness.ready,
        missingEvidence: readiness.missing,
        missingFacts,
        diagnostics: sections.flatMap((section) => section.diagnostics.map((item) => Object.assign({ source: section.source }, item))),
        sections
    };
}

function actorFromAccess(access) {
    const user = access && access.user || {};
    const principalId = cleanText(user.principalId, 180).toLowerCase();
    const identityTenantId = cleanText(user.identityTenantId, 180).toLowerCase();
    const subjectKey = cleanText(user.subjectKey, 380).toLowerCase() || (
        identityTenantId && principalId ? `${identityTenantId}:${principalId}` : ''
    );
    return {
        principalId,
        identityTenantId,
        subjectKey,
        email: normaliseEmail(user.email),
        role: cleanText(user.role, 80)
    };
}

function sameActor(left, right) {
    const a = normaliseActor(left);
    const b = normaliseActor(right);
    if (a.subjectKey || b.subjectKey) {
        if (a.subjectKey && b.subjectKey) {
            return a.subjectKey === b.subjectKey || Boolean(a.email && b.email && a.email === b.email);
        }
        // Mixed canonical/legacy records use only conservative legacy matches;
        // an explicit migration is required before the legacy side gains a
        // canonical subject identity.
        return Boolean(
            (a.principalId && b.principalId && a.principalId === b.principalId) ||
            (a.email && b.email && a.email === b.email)
        );
    }
    return Boolean(
        (a.principalId && b.principalId && a.principalId === b.principalId) ||
        (a.email && b.email && a.email === b.email)
    );
}

function canonicalHash(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function comparableProofEvidence(value) {
    const evidence = Object.assign({}, value || {});
    delete evidence.ingestedAt;
    delete evidence.recordedBy;
    return evidence;
}

function proofEvidenceFingerprint(value) {
    return canonicalHash(comparableProofEvidence(value));
}

function proofEvidenceStableId(period, value) {
    const evidence = comparableProofEvidence(value);
    delete evidence.id;
    return `proof_evidence_${canonicalHash({ period: cleanText(period, 20), evidence }).slice(0, 40)}`;
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function gate(code, id, title, type, dependencies, owner) {
    return {
        code,
        id,
        title,
        type,
        status: 'pending',
        required: true,
        owner,
        ownerRole: code === 'G5' ? 'service_owner' : 'onboarding_coordinator',
        dependencies,
        evidenceRefs: [],
        completedBy: '',
        completedAt: '',
        blockedReason: '',
        decision: { approvedBy: '', approvedAt: '', authorityRef: '' },
        exceptions: []
    };
}

function setDerivedGate(gateValue, complete, reason, at) {
    if (!gateValue) return;
    if (complete) {
        gateValue.status = 'complete';
        gateValue.completedBy = gateValue.completedBy || 'lifecycle_evaluator';
        gateValue.completedAt = gateValue.completedAt || at;
        gateValue.blockedReason = '';
    } else {
        gateValue.status = 'blocked';
        gateValue.completedBy = '';
        gateValue.completedAt = '';
        gateValue.blockedReason = cleanText(reason, 500);
    }
}

function resetGate(gateValue) {
    gateValue.status = 'pending';
    gateValue.completedBy = '';
    gateValue.completedAt = '';
    gateValue.blockedReason = 'Prerequisite evidence changed';
    gateValue.decision = { approvedBy: '', approvedAt: '', authorityRef: '' };
}

function normaliseEvidenceReferences(value) {
    return (Array.isArray(value) ? value : []).slice(-100).map((item) => {
        const source = object(item);
        return {
            id: cleanText(source.id, 180) || createId('evidence'),
            type: cleanText(source.type, 120),
            source: cleanText(source.source, 120),
            sourceMode: oneOf(source.sourceMode, ['live', 'manual', 'simulated'], 'manual'),
            reference: cleanEvidenceReference(source.reference),
            checksum: sha256Value(source.checksum),
            capturedAt: iso(source.capturedAt),
            validUntil: iso(source.validUntil),
            customerAcceptedAt: iso(source.customerAcceptedAt),
            recordedBy: cleanText(source.recordedBy, 180)
        };
    }).filter((item) => item.reference && item.capturedAt);
}

function normaliseDecision(value) {
    const source = object(value);
    return {
        approvedBy: cleanText(source.approvedBy, 180),
        approvedAt: iso(source.approvedAt),
        authorityRef: cleanEvidenceReference(source.authorityRef)
    };
}

function normaliseExceptions(value) {
    return (Array.isArray(value) ? value : []).slice(-50).map((item) => {
        const source = object(item);
        return {
            id: cleanText(source.id, 180) || createId('onboarding_exception'),
            severity: oneOf(source.severity, ['low', 'medium', 'high'], 'medium'),
            reason: cleanText(source.reason, 500),
            owner: cleanText(source.owner, 180),
            dueAt: iso(source.dueAt),
            customerAcceptedAt: iso(source.customerAcceptedAt),
            status: oneOf(source.status, ['open', 'resolved'], 'open')
        };
    }).filter((item) => item.reason);
}

function normaliseActor(value) {
    const source = object(value);
    const principalId = cleanText(source.principalId, 180).toLowerCase();
    const identityTenantId = cleanText(source.identityTenantId, 180).toLowerCase();
    const subjectKey = cleanText(source.subjectKey, 380).toLowerCase() || (
        identityTenantId && principalId ? `${identityTenantId}:${principalId}` : ''
    );
    return {
        principalId,
        identityTenantId,
        subjectKey,
        email: normaliseEmail(source.email),
        role: cleanText(source.role, 80)
    };
}

function emptyContact() {
    return { name: '', email: '', phone: '', role: '', evidenceRef: '' };
}

function normaliseContact(value) {
    const source = object(value);
    return {
        name: cleanText(source.name, 180),
        email: normaliseEmail(source.email),
        phone: cleanText(source.phone, 80),
        role: cleanText(source.role, 120),
        evidenceRef: cleanEvidenceReference(source.evidenceRef)
    };
}

function normaliseEmail(value) {
    const email = cleanText(value, 254).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanEvidenceReference(value) {
    if (containsSecretLikeValue(value)) return '';
    const reference = cleanText(value, 500);
    if (!reference || containsSecretLikeValue(reference)) return '';
    return reference;
}

function containsSecretLikeValue(value) {
    const text = String(value == null ? '' : value);
    if (!text) return false;
    const structuralPrefix = text.slice(0, (MAX_SECRET_SCAN_LENGTH * 2) + 32);
    if (/\bBasic\s+[A-Za-z0-9+\/_=-]{501}/i.test(structuralPrefix)) return true;
    const candidates = decodedSecretCandidates(text);
    return candidates.some((candidate) => {
        if (candidate === SECRET_DECODE_LIMIT_REACHED) return true;
        if (/\b(?:password|passphrase|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|token|secret|recovery\s+code)["']?\s*(?:is|=|:)\s*["']?\S+/i.test(candidate)) return true;
        if (/\b(?:proxy-)?authorization\s*(?:=|:)\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/i.test(candidate)) return true;
        if (containsStandaloneBasicCredential(candidate)) return true;
        if (/\bBearer\s+[A-Za-z0-9._~+\/-]{10,}/i.test(candidate)) return true;
        if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/i.test(candidate)) return true;
        if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(candidate)) return true;
        if (/\bAKIA[A-Z0-9]{16}\b/.test(candidate)) return true;
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(candidate)) return true;
        if (referenceUrlContainsSecret(candidate)) return true;
        return paymentCardCandidates(candidate).some(luhnValid);
    });
}

function referenceUrlContainsSecret(value) {
    try {
        const reference = String(value || '').trim();
        if (/(?:[?&;#])(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passphrase|secret|sig|signature|x-amz-credential|x-amz-signature|x-goog-signature)=\S+/i.test(reference)) return true;
        const parsed = new URL(reference, 'https://proof-reference.invalid/');
        if (parsed.username || parsed.password) return true;
        const queryParameters = Array.from(parsed.searchParams.entries());
        const fragmentParameters = Array.from(new URLSearchParams(parsed.hash.replace(/^#/, '')).entries());
        return queryParameters.concat(fragmentParameters).some(([key, parameterValue]) => (
            Boolean(parameterValue) && isSensitiveReferenceParameter(key)
        ));
    } catch (error) {
        return false;
    }
}

function decodedSecretCandidates(value) {
    const initial = String(value || '').slice(0, MAX_SECRET_SCAN_LENGTH);
    const candidates = new Set([initial]);
    let current = initial;
    let stable = false;
    for (let attempt = 0; attempt < MAX_SECRET_DECODE_PASSES; attempt += 1) {
        try {
            const decoded = decodeURIComponent(current);
            if (!decoded || decoded === current) {
                stable = true;
                break;
            }
            candidates.add(decoded);
            current = decoded;
        } catch (error) {
            if (/%[0-9a-f]{2}/i.test(current)) candidates.add(SECRET_DECODE_LIMIT_REACHED);
            stable = true;
            break;
        }
    }
    if (!stable) {
        try {
            if (decodeURIComponent(current) !== current) candidates.add(SECRET_DECODE_LIMIT_REACHED);
        } catch (error) {
            // The bounded candidate cannot be decoded further.
        }
    }
    const queue = Array.from(candidates);
    let decodePasses = 0;
    while (queue.length && decodePasses < MAX_SECRET_DECODE_PASSES) {
        const candidate = queue.shift();
        const encodedValues = Array.from(new Set([candidate.trim()].concat(
            Array.from(candidate.matchAll(/(?:^|[^A-Za-z0-9+\/_-])([A-Za-z0-9+\/_-]{12,500}={0,2})(?![A-Za-z0-9+\/_=-])/g), (match) => match[1]),
            whitespaceFoldedBase64Candidates(candidate, 250)
        )));
        for (let index = 0; index < encodedValues.length; index += 1) {
            if (decodePasses >= MAX_SECRET_DECODE_PASSES) break;
            const encoded = encodedValues[index];
            decodePasses += 1;
            const decoded = decodeInspectableBase64(encoded);
            if (!decoded || candidates.has(decoded)) continue;
            candidates.add(decoded);
            queue.push(decoded);
        }
    }
    return Array.from(candidates);
}

function whitespaceFoldedBase64Candidates(value, limit) {
    const text = String(value || '').slice(0, MAX_SECRET_SCAN_LENGTH);
    const tokens = Array.from(text.matchAll(/[A-Za-z0-9+\/_-]+={0,2}/g), (match) => ({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length
    }));
    const candidates = new Set();
    const addRange = (start, end) => {
        if (start < 0 || end >= tokens.length || end - start < 1 || candidates.size >= limit) return;
        const combined = tokens.slice(start, end + 1).map((token) => token.value).join('');
        if (combined.length >= 12 && combined.length <= MAX_SECRET_SCAN_LENGTH) candidates.add(combined);
    };
    const whitespaceSeparated = (left, right) => {
        const separator = text.slice(left.end, right.start);
        return Boolean(separator) && /^[\t\n\r ]+$/.test(separator);
    };
    // Join the maximal whitespace-connected run from every possible starting
    // token, stopping once Base64 padding marks the encoded value's end. This
    // covers fixed-width and uneven exporter/clipboard folds while preserving
    // the bounded scan and candidate budgets. Starting at each token also keeps
    // surrounding Base64-alphabet prose from hiding an embedded folded value.
    for (let start = 0; start < tokens.length && candidates.size < limit; start += 1) {
        let end = start;
        while (
            end + 1 < tokens.length &&
            !/=+$/.test(tokens[end].value) &&
            whitespaceSeparated(tokens[end], tokens[end + 1])
        ) {
            end += 1;
        }
        addRange(start, end);
    }
    return Array.from(candidates);
}

function decodeInspectableBase64(value) {
    const encoded = String(value || '').trim();
    if (!/^[A-Za-z0-9+\/_-]{8,}={0,2}$/.test(encoded) || encoded.length % 4 === 1) return '';
    const standard = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    try {
        const decoded = Buffer.from(padded, 'base64');
        // This scanner intentionally accepts non-canonical trailing Base64 bits:
        // prose suffixes must not hide an earlier credential-bearing decoded run.
        if (!decoded.length) return '';
        return (decoded.toString('latin1').match(/[\t\n\r\x20-\x7e]{8,}/g) || []).join('\n');
    } catch (error) {
        return '';
    }
}

function containsStandaloneBasicCredential(value) {
    const matches = String(value || '').matchAll(/\bBasic\s+([A-Za-z0-9+\/_-]{8,500}={0,2})(?![A-Za-z0-9+\/_=-])/gi);
    for (const match of matches) {
        const decoded = decodePrintableBase64(match[1]);
        if (decoded && /^[^:\s]{1,256}:[^\r\n]{1,1024}$/.test(decoded)) return true;
    }
    return false;
}

function decodePrintableBase64(value) {
    const encoded = String(value || '').trim();
    if (!/^[A-Za-z0-9+\/_-]{8,}={0,2}$/.test(encoded) || encoded.length % 4 === 1) return '';
    const standard = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    try {
        const decoded = Buffer.from(padded, 'base64');
        if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== standard) return '';
        const text = decoded.toString('utf8');
        return /^[\t\n\r\x20-\x7e]+$/.test(text) ? text : '';
    } catch (error) {
        return '';
    }
}

function isSensitiveReferenceParameter(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return [
        'token', 'access_token', 'refresh_token', 'api_key', 'client_secret', 'password', 'passphrase',
        'secret', 'sig', 'signature', 'x_amz_credential', 'x_amz_signature', 'x_goog_signature'
    ].includes(key);
}

function isSensitiveFactFieldName(value) {
    const name = String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return /(?:^| )(?:passwords?|passphrases?|pins?|tokens?|access tokens?|refresh tokens?|api keys?|client secrets?|private keys?|recovery codes?|authorization|credentials?|secrets?)(?: |$)/.test(name);
}

function isAllowlistedSensitiveFactMetric(value) {
    const source = object(value);
    const names = [source.key, source.label].map((name) => (
        String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    ));
    const sensitiveNames = names.filter((name) => isSensitiveFactFieldName(name));
    if (!sensitiveNames.length || !sensitiveNames.every((name) => (
        /^(?:password|credential)_(?:reset|resets|age|age_days|count|counts|expiry|expiry_date|last_changed|last_change_date)$/.test(name)
    ))) return false;
    const factValue = cleanText(source.value, 500);
    const unit = cleanText(source.unit, 60).toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(factValue)) return !unit || /^(?:count|counts|day|days|hour|hours|month|months|percent|%)$/.test(unit);
    return /^\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?z)?$/i.test(factValue);
}

function normaliseEntitlementCode(value) {
    return cleanText(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function paymentCardCandidates(value) {
    return (String(value || '').match(/(?<![A-Za-z0-9])(?:\d[ -]?){13,19}(?![A-Za-z0-9])/g) || [])
        .map((candidate) => candidate.replace(/\D/g, ''))
        .filter((candidate) => candidate.length >= 13 && candidate.length <= 19);
}

function luhnValid(value) {
    let sum = 0;
    let doubleDigit = false;
    for (let index = value.length - 1; index >= 0; index -= 1) {
        let digit = Number(value[index]);
        if (doubleDigit) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        doubleDigit = !doubleDigit;
    }
    return sum > 0 && sum % 10 === 0;
}

function cleanIdempotencyKey(value) {
    const key = cleanText(value, 180);
    return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,179}$/.test(key) ? key : '';
}

function sha256Value(value) {
    const hash = cleanText(value, 64).toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function iso(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function nullableCount(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
}

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : 0;
}

function uniqueStrings(value, maxItems, maxLength) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean))).slice(0, maxItems);
}

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function createId(prefix) {
    return `${prefix}_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
}

function normaliseOnboardingDevices(value) {
    return (Array.isArray(value) ? value : []).slice(0, 500).map((item) => {
        const source = object(item);
        const label = cleanText(source.label, 180);
        if (!label) return null;
        const providerRefs = (Array.isArray(source.providerRefs) ? source.providerRefs : []).slice(0, 10).map((refValue) => {
            const ref = object(refValue);
            return {
                system: oneOf(ref.system, ['datto_rmm', 'kaseya_mdr', 'backup'], ''),
                externalId: cleanText(ref.externalId, 180)
            };
        }).filter((ref) => ref.system && ref.externalId);
        return {
            id: cleanText(source.id, 180) || createId('onboarding_device'),
            label,
            platform: oneOf(source.platform, ['windows', 'macos', 'linux', 'other'], 'other'),
            status: oneOf(source.status, ['planned', 'installer_ready', 'enrolled', 'verified', 'blocked'], 'planned'),
            owner: cleanText(source.owner, 180),
            notes: cleanText(source.notes, 500),
            providerRefs,
            matchStatus: oneOf(source.matchStatus, ['unmatched', 'suggested', 'confirmed', 'conflict'], 'unmatched'),
            matchedAt: iso(source.matchedAt),
            matchedBy: cleanText(source.matchedBy, 180),
            lastObservedAt: iso(source.lastObservedAt),
            sourceSnapshotId: cleanText(source.sourceSnapshotId, 180),
            updatedAt: iso(source.updatedAt),
            updatedBy: cleanText(source.updatedBy, 180)
        };
    }).filter(Boolean);
}

module.exports = {
    CUSTOMER_MASTER_VERSION,
    BASE_PROOF_SOURCES,
    EXTERNAL_RECORD_TYPES,
    EXTERNAL_SYSTEMS,
    GATE_IDS,
    MAX_CUSTOMER_MASTER_ENTITLEMENTS,
    MAX_PROOF_EVIDENCE_PER_PERIOD,
    ONBOARDING_PLAN_VERSION,
    PROOF_PERIOD_CLOSE_TOLERANCE_MS,
    PROOF_SOURCES,
    actorFromAccess,
    buildProofNarrativeGroundwork,
    buildOnboardingPlan,
    canonicalHash,
    cleanEvidenceReference,
    cleanIdempotencyKey,
    createEmptyCommercialAcceptance,
    createEmptyCustomerMaster,
    createEmptyServiceStatus,
    createEmptySupportProfile,
    customerMasterMissing,
    evaluateOnboarding,
    externalReferenceKey,
    governedProofPeriods,
    normaliseActivationRequests,
    normaliseCommercialAcceptance,
    normaliseCustomerMaster,
    normaliseExternalReference,
    normaliseExternalReferences,
    normaliseGate,
    normaliseOnboardingPlan,
    normaliseProofPeriods,
    normaliseProofRequirementLedger,
    normaliseProofEvidence,
    normaliseServiceStatus,
    normaliseSupportProfile,
    parseProofPeriod,
    proofReadiness,
    proofEvidenceContainsSensitiveData,
    proofEvidenceFingerprint,
    proofEvidenceStableId,
    proofFactsContainSensitiveData,
    proofPeriodBounds,
    proofPeriodWriteBoundary,
    requiredProofSourcesForEntitlements,
    resolveProofRequirementsForEntitlements,
    resolveProofRequirementsForPeriod,
    sameActor
};
