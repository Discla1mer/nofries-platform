const path = require('path');
const os = require('os');
const { createSalesWorkspaceRepository } = require('./salesWorkspaceRepository');
const { verifyProposalApprovalSeal } = require('./proposalApprovalSeal');

function createApprovedProposalVerifier(options = {}) {
    const dataDir = options.dataDir || process.env.NOFRIES_DATA_DIR || path.join(os.tmpdir(), 'nofries-data');
    const repository = options.repository || createSalesWorkspaceRepository({ dataDir });

    return {
        async verify(access, expected = {}) {
            const state = await repository.read(access);
            const proposal = state.proposals.find((item) => item.id === expected.proposalId);
            if (!proposal) {
                return failure('approved_proposal_not_found');
            }
            const customer = state.customers.find((item) => item.id === proposal.customerId);
            const assessment = state.assessments.find((item) => item.id === proposal.assessmentId);
            if (!customer || !assessment) {
                return failure('approved_proposal_binding_mismatch');
            }
            const verified = verifyProposalApprovalSeal(proposal, {
                proposalId: expected.proposalId,
                customerId: expected.salesCustomerId,
                assessmentId: expected.assessmentId,
                version: expected.proposalVersion,
                sha256: expected.proposalSha256
            });
            if (!verified || verified.verified !== true) {
                return failure(normaliseVerificationCode(verified && verified.code));
            }
            const snapshot = verified.seal && verified.seal.snapshot || {};
            const issuer = snapshot.issuer || {};
            const sealedCustomer = snapshot.customer || {};
            if (
                issuer.tenantId !== state.tenant.id ||
                sealedCustomer.id !== customer.id ||
                customer.id !== expected.salesCustomerId ||
                assessment.id !== expected.assessmentId ||
                assessment.customerId !== customer.id ||
                customer.lifecycleOrganisationId !== expected.organisationId ||
                assessment.lifecycleOrganisationId !== expected.organisationId
            ) {
                return failure('approved_proposal_binding_mismatch');
            }
            return Object.assign({}, verified, {
                tenantKey: state.tenant.key,
                organisationId: expected.organisationId
            });
        }
    };
}

function normaliseVerificationCode(code) {
    if (code === 'approved_proposal_unsealed' || code === 'approved_proposal_legacy_unsealed') {
        return 'approved_proposal_unsealed';
    }
    if (code === 'approved_proposal_not_found') return code;
    return 'approved_proposal_binding_mismatch';
}

function failure(code) {
    return { verified: false, code };
}

module.exports = {
    createApprovedProposalVerifier
};
