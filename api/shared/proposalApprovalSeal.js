const crypto = require('crypto');

const PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION = 2;
const PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA = 'nofries.proposal.approved.v2';
const LEGACY_PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION = 1;
const LEGACY_PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA = 'nofries.proposal.approved.v1';

function createProposalApprovalSeal(input = {}) {
    const proposal = object(input.proposal);
    const versionNumber = positiveInteger(proposal.versionNumber, 1);
    const version = `v${versionNumber}`;
    const snapshot = createProposalApprovalSnapshot({
        proposal: Object.assign({}, proposal, { versionNumber }),
        customer: input.customer,
        tenant: input.tenant
    });
    return {
        schemaVersion: PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION,
        status: 'sealed',
        version,
        sha256: hashProposalApprovalSnapshot(snapshot),
        snapshot,
        sealedAt: text(proposal.approvedAt),
        sealedBy: text(proposal.approvedBy).toLowerCase()
    };
}

function createProposalApprovalSnapshot(input = {}) {
    return createProposalApprovalSnapshotForSchema(input, PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA);
}

function createProposalApprovalSnapshotForSchema(input = {}, snapshotSchema) {
    const proposal = object(input.proposal);
    const customer = object(input.customer);
    const tenant = object(input.tenant);
    const versionNumber = positiveInteger(proposal.versionNumber, 1);
    const document = {
        title: text(proposal.title),
        commercialModel: text(proposal.commercialModel || 'service_recommendations'),
        executiveSummary: text(proposal.executiveSummary),
        objectives: stringList(proposal.objectives),
        observations: stringList(proposal.observations),
        recommendations: normaliseJson(array(proposal.recommendations)),
        bundle: proposal.bundle ? customerFacingBundle(proposal.bundle) : null,
        pricing: normaliseJson(object(proposal.pricing)),
        commercial: normaliseJson(object(proposal.commercial)),
        roadmap: normaliseJson(object(proposal.roadmap)),
        assumptions: stringList(proposal.assumptions),
        nextStep: text(proposal.nextStep),
        updatedAt: text(proposal.updatedAt)
    };
    if (snapshotSchema === PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA) {
        document.commercialPolicy = normaliseJson(object(proposal.commercialPolicy));
    }
    return normaliseJson({
        schema: snapshotSchema,
        proposalId: text(proposal.id),
        customerId: text(proposal.customerId),
        assessmentId: text(proposal.assessmentId),
        versionNumber,
        version: `v${versionNumber}`,
        customer: {
            id: text(customer.id || proposal.customerId),
            name: text(customer.name)
        },
        issuer: {
            tenantId: text(tenant.id),
            tenantName: text(tenant.name)
        },
        approval: {
            approvedBy: text(proposal.approvedBy).toLowerCase(),
            approvedAt: text(proposal.approvedAt)
        },
        document
    });
}

function hashProposalApprovalSnapshot(snapshot) {
    return crypto.createHash('sha256').update(stableStringify(normaliseJson(snapshot)), 'utf8').digest('hex');
}

function verifyProposalApprovalSeal(proposalValue, expected = {}) {
    const proposal = object(proposalValue);
    const seal = object(proposal.approvalSeal);
    if (proposal.status !== 'approved') return verificationFailure('proposal_not_approved');
    if (seal.status === 'legacy_unsealed') return verificationFailure('approved_proposal_unsealed');
    if (seal.status !== 'sealed') {
        return verificationFailure('approved_proposal_unsealed');
    }
    const sealSchemaVersion = Number(seal.schemaVersion);
    const expectedSnapshotSchema = snapshotSchemaForSealVersion(sealSchemaVersion);
    if (!expectedSnapshotSchema) return verificationFailure('approval_seal_schema_unsupported');
    if (!seal.snapshot || typeof seal.snapshot !== 'object' || Array.isArray(seal.snapshot)) {
        return verificationFailure('approval_seal_snapshot_missing');
    }
    const snapshot = normaliseJson(seal.snapshot);
    if (snapshot.schema !== expectedSnapshotSchema) {
        return verificationFailure('approval_seal_schema_unsupported');
    }
    const recomputedSha256 = hashProposalApprovalSnapshot(snapshot);
    if (!sha256(seal.sha256) || seal.sha256 !== recomputedSha256) {
        return verificationFailure('approval_seal_hash_mismatch');
    }
    const versionNumber = positiveInteger(proposal.versionNumber, 0);
    const version = versionNumber ? `v${versionNumber}` : '';
    const binding = {
        proposalId: text(proposal.id),
        customerId: text(proposal.customerId),
        assessmentId: text(proposal.assessmentId),
        version,
        sha256: seal.sha256
    };
    if (
        !binding.proposalId || !binding.customerId || !binding.assessmentId || !binding.version ||
        snapshot.proposalId !== binding.proposalId ||
        snapshot.customerId !== binding.customerId ||
        snapshot.assessmentId !== binding.assessmentId ||
        snapshot.version !== binding.version ||
        snapshot.versionNumber !== versionNumber ||
        seal.version !== binding.version ||
        text(seal.sealedAt) !== text(proposal.approvedAt) ||
        text(seal.sealedBy).toLowerCase() !== text(proposal.approvedBy).toLowerCase() ||
        text(snapshot.approval && snapshot.approval.approvedAt) !== text(proposal.approvedAt) ||
        text(snapshot.approval && snapshot.approval.approvedBy).toLowerCase() !== text(proposal.approvedBy).toLowerCase()
    ) {
        return verificationFailure('approval_seal_binding_mismatch');
    }
    const currentSnapshot = createProposalApprovalSnapshotForSchema({
        proposal,
        customer: snapshot.customer,
        tenant: {
            id: snapshot.issuer && snapshot.issuer.tenantId,
            name: snapshot.issuer && snapshot.issuer.tenantName
        }
    }, expectedSnapshotSchema);
    if (hashProposalApprovalSnapshot(currentSnapshot) !== seal.sha256) {
        return verificationFailure('approved_proposal_content_changed');
    }
    for (const field of ['proposalId', 'customerId', 'assessmentId', 'version', 'sha256']) {
        const expectedValue = field === 'sha256' ? text(expected[field]).toLowerCase() : text(expected[field]);
        const bindingValue = field === 'sha256' ? text(binding[field]).toLowerCase() : text(binding[field]);
        if (expected[field] != null && expectedValue !== bindingValue) {
            return verificationFailure('approved_proposal_binding_mismatch', binding);
        }
    }
    return {
        verified: true,
        seal,
        binding
    };
}

function materialiseProposalApprovalSnapshot(sealValue) {
    const seal = object(sealValue);
    const snapshot = object(seal.snapshot);
    const document = object(snapshot.document);
    return {
        proposal: Object.assign({}, normaliseJson(document), {
            id: text(snapshot.proposalId),
            customerId: text(snapshot.customerId),
            assessmentId: text(snapshot.assessmentId),
            versionNumber: positiveInteger(snapshot.versionNumber, 1),
            status: 'approved',
            approvedBy: text(snapshot.approval && snapshot.approval.approvedBy),
            approvedAt: text(snapshot.approval && snapshot.approval.approvedAt),
            approvalSeal: seal
        }),
        customer: normaliseJson(object(snapshot.customer)),
        tenant: {
            id: text(snapshot.issuer && snapshot.issuer.tenantId),
            name: text(snapshot.issuer && snapshot.issuer.tenantName)
        }
    };
}

function normaliseProposalApprovalState(proposalValue) {
    const proposal = object(proposalValue);
    proposal.versionNumber = positiveInteger(proposal.versionNumber, 1);
    if (proposal.status === 'approved' && (!proposal.approvalSeal || typeof proposal.approvalSeal !== 'object')) {
        proposal.approvalSeal = {
            schemaVersion: PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION,
            status: 'legacy_unsealed',
            version: `v${proposal.versionNumber}`,
            sha256: '',
            snapshot: null,
            sealedAt: text(proposal.approvedAt),
            sealedBy: text(proposal.approvedBy).toLowerCase()
        };
    }
    return proposal;
}

function customerFacingBundle(value) {
    const source = object(value);
    return normaliseJson({
        serviceKey: text(source.serviceKey),
        serviceName: text(source.serviceName),
        outcome: text(source.outcome),
        why: text(source.why),
        confirm: text(source.confirm),
        includedComponents: array(source.includedComponents),
        validationComponents: array(source.validationComponents)
    });
}

function verificationFailure(code, binding) {
    return {
        verified: false,
        code,
        binding: binding || null
    };
}

function snapshotSchemaForSealVersion(value) {
    if (value === PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION) return PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA;
    if (value === LEGACY_PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION) return LEGACY_PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA;
    return '';
}

function normaliseJson(value) {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(normaliseJson);
    if (typeof value !== 'object') return null;
    const result = {};
    Object.keys(value).sort().forEach((key) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return;
        const item = normaliseJson(value[key]);
        if (item !== undefined) result[key] = item;
    });
    return result;
}

function stableStringify(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function stringList(value) {
    return array(value).map(text);
}

function text(value) {
    return String(value == null ? '' : value).trim();
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sha256(value) {
    return /^[a-f0-9]{64}$/.test(text(value).toLowerCase());
}

module.exports = {
    LEGACY_PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION,
    LEGACY_PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA,
    PROPOSAL_APPROVAL_SEAL_SCHEMA_VERSION,
    PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA,
    createProposalApprovalSeal,
    createProposalApprovalSnapshot,
    hashProposalApprovalSnapshot,
    materialiseProposalApprovalSnapshot,
    normaliseProposalApprovalState,
    verifyProposalApprovalSeal
};
