const { createApprovedProposalVerifier } = require('../api/shared/proposalApprovalProvider');
const {
    createProposalApprovalSeal,
    hashProposalApprovalSnapshot
} = require('../api/shared/proposalApprovalSeal');

describe('approved proposal provider binding', () => {
    test('verifies the sealed sales proposal against the exact lifecycle crosswalk', async () => {
        const proposal = proposalFixture();
        proposal.approvalSeal = createProposalApprovalSeal({
            proposal,
            customer: { id: 'sales-customer-one', name: 'Customer One Limited' },
            tenant: { id: 'tenant-one', name: 'Tenant One' }
        });
        const verifier = createApprovedProposalVerifier({
            repository: repositoryFor(proposal)
        });

        const verified = await verifier.verify(access(), {
            organisationId: 'organisation-one',
            salesCustomerId: 'sales-customer-one',
            assessmentId: 'assessment-one',
            proposalId: 'proposal-one',
            proposalVersion: 'v2',
            proposalSha256: proposal.approvalSeal.sha256
        });

        expect(verified).toMatchObject({
            verified: true,
            organisationId: 'organisation-one',
            binding: {
                proposalId: 'proposal-one',
                customerId: 'sales-customer-one',
                assessmentId: 'assessment-one',
                version: 'v2'
            }
        });
    });

    test('rejects a cross-customer link and any seal tampering', async () => {
        const proposal = proposalFixture();
        proposal.approvalSeal = createProposalApprovalSeal({
            proposal,
            customer: { id: 'sales-customer-one', name: 'Customer One Limited' },
            tenant: { id: 'tenant-one', name: 'Tenant One' }
        });
        const verifier = createApprovedProposalVerifier({ repository: repositoryFor(proposal) });
        const expected = {
            organisationId: 'wrong-organisation',
            salesCustomerId: 'sales-customer-one',
            assessmentId: 'assessment-one',
            proposalId: 'proposal-one',
            proposalVersion: 'v2',
            proposalSha256: proposal.approvalSeal.sha256
        };
        await expect(verifier.verify(access(), expected)).resolves.toMatchObject({
            verified: false,
            code: 'approved_proposal_binding_mismatch'
        });

        proposal.approvalSeal.snapshot.issuer.tenantId = 'wrong-tenant';
        proposal.approvalSeal.sha256 = hashProposalApprovalSnapshot(proposal.approvalSeal.snapshot);
        expected.organisationId = 'organisation-one';
        expected.proposalSha256 = proposal.approvalSeal.sha256;
        await expect(verifier.verify(access(), expected)).resolves.toMatchObject({
            verified: false,
            code: 'approved_proposal_binding_mismatch'
        });

        proposal.approvalSeal.snapshot.issuer.tenantId = 'tenant-one';
        proposal.approvalSeal.sha256 = hashProposalApprovalSnapshot(proposal.approvalSeal.snapshot);
        expected.proposalSha256 = proposal.approvalSeal.sha256;
        proposal.approvalSeal.snapshot.document.title = 'Tampered title';
        await expect(verifier.verify(access(), expected)).resolves.toMatchObject({
            verified: false,
            code: 'approved_proposal_binding_mismatch'
        });
    });
});

function repositoryFor(proposal) {
    return {
        async read() {
            return {
                tenant: { id: 'tenant-one', key: 'tenant-one', name: 'Tenant One' },
                proposals: [proposal],
                customers: [{
                    id: 'sales-customer-one',
                    name: 'Customer One Limited',
                    lifecycleOrganisationId: 'organisation-one'
                }],
                assessments: [{
                    id: 'assessment-one',
                    customerId: 'sales-customer-one',
                    lifecycleOrganisationId: 'organisation-one'
                }]
            };
        }
    };
}

function proposalFixture() {
    return {
        id: 'proposal-one',
        customerId: 'sales-customer-one',
        assessmentId: 'assessment-one',
        versionNumber: 2,
        status: 'approved',
        title: 'Managed IT proposal',
        commercialModel: 'bundled_managed_it',
        executiveSummary: 'A governed managed service.',
        objectives: ['Reliable support'],
        observations: ['Two devices'],
        recommendations: [{ serviceKey: 'managed-it-core', serviceName: 'Lean Managed IT', roadmap: 'now' }],
        pricing: { monthly: 500, onboarding: 250 },
        commercial: { confirmed: true, termMonths: 12 },
        roadmap: { now: ['Lean Managed IT'], next: [], later: [] },
        assumptions: ['Customer provides access'],
        nextStep: 'Sign the agreement',
        updatedAt: '2026-08-21T01:00:00.000Z',
        approvedAt: '2026-08-21T01:00:00.000Z',
        approvedBy: 'owner@example.com'
    };
}

function access() {
    return {
        tenant: { id: 'tenant-one', key: 'tenant-one', name: 'Tenant One' },
        user: { email: 'owner@example.com', role: 'service_owner', capabilities: [] }
    };
}
