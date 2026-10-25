'use strict';

const {
    buildProofNarrativeGroundwork,
    canonicalHash,
    governedProofPeriods,
    normaliseCustomerProofSnapshot,
    normaliseProofPublicationEnvelope,
    parseProofPeriod,
    proofPeriodBounds,
    sameActor
} = require('./customerOperations');

const CUSTOMER_PROOF_SNAPSHOT_VERSION = 1;
const CUSTOMER_PROOF_HISTORY_LIMIT = 13;
const PROOF_ACTOR_ROLE_LABELS = Object.freeze({
    admin: 'Administrator',
    service_owner: 'Service owner',
    consultant: 'Consultant',
    authorised_operator: 'Authorised operator'
});
const PROOF_STATEMENT = Object.freeze({
    type: 'nofries_attested_monthly_statement',
    label: 'No Fries-attested monthly statement'
});

// Customer-visible, manually attested metrics are deliberately closed and
// numeric. Labels and units are server-owned so operator-supplied prose cannot
// become an unsupported customer claim.
const CUSTOMER_METRICS = Object.freeze({
    service_desk: metricMap([
        ['tickets.total', 'Tickets recorded', 'tickets'],
        ['tickets.opened', 'Tickets opened', 'tickets'],
        ['tickets.open', 'Tickets open', 'tickets'],
        ['tickets.resolved', 'Tickets resolved', 'tickets'],
        ['tickets.closed', 'Tickets closed', 'tickets'],
        ['sla.met_percent', 'Tickets meeting SLA', '%'],
        ['response.median_minutes', 'Median response time', 'minutes'],
        ['resolution.median_minutes', 'Median resolution time', 'minutes']
    ]),
    datto_rmm: metricMap([
        ['devices.total', 'Managed devices', 'devices'],
        ['devices.monitored', 'Devices monitored', 'devices'],
        ['devices.online', 'Devices online', 'devices'],
        ['patch.compliance_percent', 'Patch compliance', '%'],
        ['alerts.open', 'Open device alerts', 'alerts'],
        ['alerts.resolved', 'Device alerts resolved', 'alerts']
    ]),
    mdr: metricMap([
        ['alerts.reviewed', 'Security alerts reviewed', 'alerts'],
        ['incidents.total', 'Security incidents', 'incidents'],
        ['incidents.contained', 'Security incidents contained', 'incidents'],
        ['threats.blocked', 'Threats blocked', 'threats']
    ]),
    backup: metricMap([
        ['backups.total', 'Backups run', 'backups'],
        ['backups.successful', 'Successful backups', 'backups'],
        ['backup.success_percent', 'Backup success', '%'],
        ['restore.tests_completed', 'Restore tests completed', 'tests']
    ]),
    change: metricMap([
        ['changes.total', 'Changes recorded', 'changes'],
        ['changes.completed', 'Changes completed', 'changes'],
        ['changes.successful', 'Successful changes', 'changes']
    ]),
    risk: metricMap([
        ['risk.total', 'Risks recorded', 'risks'],
        ['risk.assessed', 'Risks assessed', 'risks'],
        ['risks.open', 'Open risks', 'risks'],
        ['risks.closed', 'Risks closed', 'risks']
    ]),
    billing: metricMap([
        ['licensed_users', 'Licensed users', 'users'],
        ['managed_devices', 'Managed devices', 'devices'],
        ['billing.users', 'Billed users', 'users'],
        ['billing.devices', 'Billed devices', 'devices']
    ]),
    roadmap: metricMap([
        ['recommendations.open', 'Open recommendations', 'recommendations'],
        ['recommendations.completed', 'Recommendations completed', 'recommendations'],
        ['roadmap.items', 'Roadmap items', 'items'],
        ['roadmap.completed', 'Roadmap items completed', 'items']
    ])
});

function metricMap(rows) {
    return Object.freeze(Object.fromEntries(rows.map(([key, label, unit]) => [key, Object.freeze({
        label,
        unit,
        kind: unit === '%' ? 'percentage' : unit === 'minutes' ? 'duration' : 'count'
    })])));
}

function customerProofTimezone(organisation) {
    return organisation && organisation.supportProfile && organisation.supportProfile.timezone ||
        organisation && organisation.customerMaster && organisation.customerMaster.serviceSchedule &&
            organisation.customerMaster.serviceSchedule.timezone ||
        'Pacific/Auckland';
}

function proofCustomerId(organisation) {
    return safeBoundId(
        organisation && organisation.customerMaster && organisation.customerMaster.customerId ||
        organisation && organisation.id || ''
    );
}

function proofOrganisationDigest(organisation) {
    const organisationId = safeBoundId(organisation && organisation.id);
    return organisationId
        ? canonicalHash({ schema: 'nofries-proof-organisation-v1', organisationId })
        : '';
}

function buildFrozenCustomerProofSnapshot(organisation, proof, at = new Date().toISOString()) {
    const bounds = proofPeriodBounds(proof && proof.period, proof && proof.timezone || customerProofTimezone(organisation));
    if (!proof || !bounds) throw proofError('The Proof reporting period is invalid', 'proof_period_invalid');
    const expectedCustomerId = organisation ? proofCustomerId(organisation) : safeBoundId(proof.customerId);
    if (!expectedCustomerId || safeBoundId(proof.customerId) !== expectedCustomerId) {
        throw proofError('The Proof customer binding is invalid', 'proof_customer_binding_invalid');
    }
    const organisationDigest = organisation
        ? proofOrganisationDigest(organisation)
        : String(proof.customerSnapshot && proof.customerSnapshot.organisationDigest || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(organisationDigest)) {
        throw proofError('The Proof organisation binding is invalid', 'proof_organisation_binding_invalid');
    }
    const groundwork = buildProofNarrativeGroundwork(proof, at);
    if (!groundwork.readyForApproval) {
        throw proofError('Proof must be ready before its customer snapshot can be frozen', 'proof_snapshot_not_ready');
    }
    const evidenceById = new Map((proof.evidenceRefs || []).map((item) => [item.id, item]));
    const receipts = [];
    const sections = groundwork.sections.map((section) => {
        const evidence = evidenceById.get(section.evidenceId);
        const sourceMode = evidence && evidence.sourceMode === 'live' ? 'live' : 'manual';
        const attestation = sourceMode === 'live'
            ? { mode: 'provider_collected', label: 'Provider-collected' }
            : { mode: 'manual_attested', label: 'Manually attested' };
        const receipt = buildEvidenceReceipt(proof, section.source, evidence, attestation.mode);
        if (!receipt) {
            throw proofError('Proof evidence cannot be represented by a customer-safe receipt', 'proof_evidence_receipt_invalid');
        }
        receipts.push(receipt);
        const allowed = CUSTOMER_METRICS[section.source] || {};
        const seenMetricKeys = new Set();
        const metrics = section.claims.map((claim) => {
            const definition = allowed[claim.key];
            if (!definition) return null;
            if (seenMetricKeys.has(claim.key)) {
                const error = proofError(
                    'A Proof section cannot publish the same allowlisted metric more than once',
                    'proof_customer_metric_duplicate'
                );
                error.source = section.source;
                error.metricKey = claim.key;
                throw error;
            }
            seenMetricKeys.add(claim.key);
            const numeric = normaliseNumericMetric(claim.value, definition);
            if (numeric === '') return null;
            return {
                key: claim.key,
                label: definition.label,
                value: numeric,
                unit: definition.unit,
                status: ['positive', 'attention'].includes(claim.status) ? claim.status : 'informational',
                receiptId: receipt.receiptId
            };
        }).filter(Boolean);
        return { source: section.source, receiptId: receipt.receiptId, attestation, metrics };
    });
    const missingMetricSources = sections.filter((section) => section.metrics.length === 0)
        .map((section) => section.source);
    if (missingMetricSources.length) {
        const error = proofError(
            'Every required Proof section needs at least one allowlisted, bounded numeric metric',
            'proof_customer_metrics_required'
        );
        error.sources = missingMetricSources;
        throw error;
    }
    const modes = new Set(sections.map((section) => section.attestation.mode));
    const attestation = modes.size > 1
        ? { mode: 'mixed', label: 'Provider-collected and manually attested' }
        : modes.has('provider_collected')
            ? { mode: 'provider_collected', label: 'Provider-collected' }
            : { mode: 'manual_attested', label: 'Manually attested' };
    const maker = buildPublicProofActor(proof.preparedBy, 'Proof preparer');
    const checker = buildPublicProofActor(proof.checkedBy, 'Proof approver');
    const preparedAt = normaliseIso(proof.preparedAt);
    const approvedAt = normaliseIso(proof.approvedAt || at);
    if (
        !immutableProofActor(proof.preparedBy) || !immutableProofActor(proof.checkedBy) ||
        !maker || !checker || sameActor(proof.preparedBy, proof.checkedBy) || !preparedAt || !approvedAt ||
        Date.parse(preparedAt) > Date.parse(approvedAt)
    ) {
        throw proofError('Proof approval requires distinct, identifiable maker and checker receipts', 'proof_approval_actor_invalid');
    }
    if (receipts.some((receipt) => Date.parse(receipt.capturedAt) > Date.parse(approvedAt))) {
        throw proofError(
            'Proof approval cannot freeze evidence captured after the approval instant',
            'proof_evidence_after_approval'
        );
    }
    return normaliseCustomerProofSnapshot({
        schemaVersion: CUSTOMER_PROOF_SNAPSHOT_VERSION,
        proofId: proof.id,
        customerId: proof.customerId || organisation && organisation.customerMaster && organisation.customerMaster.customerId || '',
        organisationDigest,
        statement: PROOF_STATEMENT,
        period: proof.period,
        timezone: bounds.timezone,
        coverage: {
            periodStart: bounds.periodStart,
            periodEnd: bounds.periodEnd
        },
        attestation,
        approval: {
            maker,
            preparedAt,
            checker,
            approvedAt,
            distinctActors: true
        },
        evidenceReceipts: receipts,
        sections
    });
}

function proofSnapshotValid(proof, organisation = null) {
    const snapshot = normaliseCustomerProofSnapshot(proof && proof.customerSnapshot);
    if (
        !proof || !snapshot || snapshot.schemaVersion !== CUSTOMER_PROOF_SNAPSHOT_VERSION ||
        !snapshot.proofId || snapshot.proofId !== proof.id ||
        !snapshot.customerId || snapshot.customerId !== proof.customerId ||
        !/^[a-f0-9]{64}$/.test(snapshot.organisationDigest) ||
        (organisation && snapshot.organisationDigest !== proofOrganisationDigest(organisation)) ||
        !snapshot.statement || snapshot.statement.type !== PROOF_STATEMENT.type || snapshot.statement.label !== PROOF_STATEMENT.label ||
        !snapshot.period || snapshot.period !== proof.period ||
        !snapshot.timezone || snapshot.timezone !== proof.timezone ||
        !snapshot.coverage.periodStart || !snapshot.coverage.periodEnd ||
        !snapshot.approval || !snapshot.approval.approvedAt ||
        !snapshot.approval.preparedAt || snapshot.approval.preparedAt !== proof.preparedAt ||
        Date.parse(snapshot.approval.preparedAt) > Date.parse(snapshot.approval.approvedAt) ||
        snapshot.approval.approvedAt !== proof.approvedAt ||
        !snapshot.approval.maker || !snapshot.approval.checker || snapshot.approval.distinctActors !== true ||
        !/^[a-f0-9]{64}$/.test(String(proof.snapshotSha256 || ''))
    ) return false;
    if (canonicalHash(proof.customerSnapshot) !== proof.snapshotSha256 || canonicalHash(snapshot) !== proof.snapshotSha256) return false;
    try {
        const rebuilt = buildFrozenCustomerProofSnapshot(organisation, proof, proof.approvedAt);
        return canonicalHash(rebuilt) === proof.snapshotSha256;
    } catch (_error) {
        return false;
    }
}

function buildProofPublicationEnvelope(proof, issuer, issuedAt = new Date().toISOString(), organisation = null) {
    const publicIssuer = buildPublicProofActor(issuer, 'Proof issuer');
    const issued = normaliseIso(issuedAt);
    if (!proofSnapshotValid(proof, organisation)) {
        throw proofError('The approved Proof snapshot cannot be bound for publication', 'proof_snapshot_integrity_failed');
    }
    if (
        !immutableProofActor(issuer) || !publicIssuer || !issued ||
        sameActor(issuer, proof.preparedBy) || sameActor(issuer, proof.checkedBy) ||
        Date.parse(issued) < Date.parse(proof.approvedAt)
    ) {
        throw proofError('Proof issue metadata is invalid', 'proof_publication_receipt_invalid');
    }
    return normaliseProofPublicationEnvelope({
        schemaVersion: 1,
        approvedSnapshotSha256: proof.snapshotSha256,
        proofId: proof.id,
        customerId: proof.customerId,
        organisationDigest: proof.customerSnapshot.organisationDigest,
        statement: PROOF_STATEMENT,
        period: proof.period,
        issuedAt: issued,
        issuer: publicIssuer
    });
}

function publicationEnvelopeValid(proof, organisation = null) {
    const envelope = normaliseProofPublicationEnvelope(proof && proof.publicationEnvelope);
    if (
        !proof || proof.status !== 'issued' || !proofSnapshotValid(proof, organisation) || !envelope ||
        canonicalHash(proof.publicationEnvelope) !== proof.publicationSha256 ||
        !/^[a-f0-9]{64}$/.test(String(proof.publicationSha256 || '')) ||
        envelope.approvedSnapshotSha256 !== proof.snapshotSha256 ||
        envelope.proofId !== proof.id || envelope.customerId !== proof.customerId || envelope.period !== proof.period ||
        envelope.organisationDigest !== proof.customerSnapshot.organisationDigest ||
        (organisation && envelope.organisationDigest !== proofOrganisationDigest(organisation)) ||
        !envelope.statement || envelope.statement.type !== PROOF_STATEMENT.type || envelope.statement.label !== PROOF_STATEMENT.label ||
        !envelope.issuedAt || envelope.issuedAt !== proof.issuedAt || Date.parse(envelope.issuedAt) < Date.parse(proof.approvedAt) ||
        !immutableProofActor(proof.issuedBy) ||
        sameActor(proof.issuedBy, proof.preparedBy) || sameActor(proof.issuedBy, proof.checkedBy) ||
        !envelope.issuer
    ) return false;
    const expectedIssuer = buildPublicProofActor(proof.issuedBy, 'Proof issuer');
    return Boolean(
        expectedIssuer && canonicalHash(envelope.issuer) === canonicalHash(expectedIssuer) &&
        canonicalHash(envelope) === proof.publicationSha256
    );
}

function publishedProofForPeriod(organisation, period) {
    if (!parseProofPeriod(period)) return null;
    const proof = (organisation && Array.isArray(organisation.proofPeriods) ? organisation.proofPeriods : [])
        .find((item) => item.period === period && item.status === 'issued');
    if (!proof || proof.customerId !== proofCustomerId(organisation) || !publicationEnvelopeValid(proof, organisation)) return null;
    return publicReport(proof);
}

function buildCustomerProofPortalView(organisation, at = new Date().toISOString()) {
    const timezone = customerProofTimezone(organisation);
    const currentPeriod = governedProofPeriods(at, timezone)[1] || '';
    const currentProof = currentPeriod
        ? (organisation && Array.isArray(organisation.proofPeriods) ? organisation.proofPeriods : [])
            .find((item) => item.period === currentPeriod)
        : null;
    let currentState = 'not_issued';
    let currentReport = null;
    if (!currentPeriod) {
        currentState = 'unavailable';
    } else if (currentProof && currentProof.status === 'issued') {
        currentReport = publishedProofForPeriod(organisation, currentPeriod);
        currentState = currentReport ? 'issued' : 'unavailable';
    }
    const history = (organisation && Array.isArray(organisation.proofPeriods) ? organisation.proofPeriods : [])
        .filter((item) => item.status === 'issued' && item.period !== currentPeriod)
        .sort((left, right) => right.period.localeCompare(left.period))
        .map((item) => publishedProofForPeriod(organisation, item.period))
        .filter(Boolean)
        .slice(0, CUSTOMER_PROOF_HISTORY_LIMIT);
    return {
        timezone,
        current: {
            period: currentPeriod,
            state: currentState,
            report: currentReport
        },
        history
    };
}

function publicReport(proof) {
    const snapshot = normaliseCustomerProofSnapshot(proof.customerSnapshot);
    const publicationEnvelope = normaliseProofPublicationEnvelope(proof.publicationEnvelope);
    return {
        schemaVersion: snapshot.schemaVersion,
        proofId: snapshot.proofId,
        customerId: snapshot.customerId,
        organisationDigest: snapshot.organisationDigest,
        statement: snapshot.statement,
        period: snapshot.period,
        timezone: snapshot.timezone,
        periodStart: snapshot.coverage.periodStart,
        periodEnd: snapshot.coverage.periodEnd,
        preparedAt: snapshot.approval.preparedAt,
        approvedAt: snapshot.approval.approvedAt,
        approval: snapshot.approval,
        issuedAt: publicationEnvelope.issuedAt,
        issuer: publicationEnvelope.issuer,
        snapshotSha256: proof.snapshotSha256,
        publicationSha256: proof.publicationSha256,
        frozenSnapshot: snapshot,
        publicationEnvelope,
        attestation: snapshot.attestation,
        evidenceReceipts: snapshot.evidenceReceipts,
        sections: snapshot.sections
    };
}

function buildEvidenceReceipt(proof, source, evidence, mode) {
    if (!evidence) return null;
    const evidenceSha256 = String(evidence.checksum || '').trim().toLowerCase();
    const capturedAt = normaliseIso(evidence.capturedAt);
    const periodStart = normaliseIso(evidence.periodStart);
    const periodEnd = normaliseIso(evidence.periodEnd);
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256) || !capturedAt || !periodStart || !periodEnd) return null;
    const receiptSeed = {
        schema: 'nofries-proof-evidence-receipt-v1',
        proofId: String(proof.id || ''),
        customerId: String(proof.customerId || ''),
        period: String(proof.period || ''),
        source,
        evidenceId: String(evidence.id || ''),
        evidenceSha256,
        capturedAt,
        periodStart,
        periodEnd,
        mode
    };
    return {
        receiptId: `receipt_${canonicalHash(receiptSeed).slice(0, 32)}`,
        source,
        mode,
        evidenceSha256,
        capturedAt,
        periodStart,
        periodEnd
    };
}

function buildPublicProofActor(actor, label) {
    const source = actor && typeof actor === 'object' && !Array.isArray(actor) ? actor : {};
    if (!immutableProofActor(source)) return null;
    const role = Object.prototype.hasOwnProperty.call(PROOF_ACTOR_ROLE_LABELS, source.role)
        ? source.role
        : 'authorised_operator';
    return {
        role,
        roleLabel: PROOF_ACTOR_ROLE_LABELS[role],
        label
    };
}

function immutableProofActor(actor) {
    const source = actor && typeof actor === 'object' && !Array.isArray(actor) ? actor : {};
    const subjectKey = safeIdentityValue(source.subjectKey, 380);
    const identityTenantId = safeIdentityValue(source.identityTenantId, 180);
    const principalId = safeIdentityValue(source.principalId, 180);
    return Boolean(
        subjectKey && identityTenantId && principalId &&
        subjectKey === `${identityTenantId}:${principalId}`
    );
}

function safeIdentityValue(value, maximumLength) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, maximumLength);
}

function safeBoundId(value) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 180);
}

function normaliseIso(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normaliseNumericMetric(value, definition) {
    const candidate = String(value == null ? '' : value).trim();
    if (!/^(?:\d+|\d*\.\d+)$/.test(candidate)) return '';
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric) || numeric < 0) return '';
    if (definition.kind === 'count' && (!Number.isSafeInteger(numeric) || numeric > 1_000_000_000)) return '';
    if (definition.kind === 'percentage' && numeric > 100) return '';
    if (definition.kind === 'duration' && numeric > 525_600) return '';
    return String(numeric);
}

function proofError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

module.exports = {
    CUSTOMER_METRICS,
    CUSTOMER_PROOF_HISTORY_LIMIT,
    CUSTOMER_PROOF_SNAPSHOT_VERSION,
    PROOF_STATEMENT,
    buildProofPublicationEnvelope,
    buildCustomerProofPortalView,
    buildFrozenCustomerProofSnapshot,
    customerProofTimezone,
    publicationEnvelopeValid,
    proofCustomerId,
    proofOrganisationDigest,
    proofSnapshotValid,
    publicReport,
    publishedProofForPeriod
};
