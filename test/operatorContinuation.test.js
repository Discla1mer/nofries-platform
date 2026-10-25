const fs = require('fs');
const path = require('path');

const operatorSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'operator.js'),
    'utf8'
);
const salesSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'mssp.js'),
    'utf8'
);

describe('approved proposal continuation', () => {
    test('matches the exact Sales handoff and removes manual proposal-ID entry', () => {
        expect(operatorSource).toContain("params.get('salesCustomerId')");
        expect(operatorSource).toContain("params.get('assessmentId')");
        expect(operatorSource).toContain("params.get('proposalId')");
        expect(operatorSource).toContain("params.get('organisationId')");
        expect(operatorSource).toContain('candidate.organisationId === organisationId');
        expect(operatorSource).toContain('candidate.scope.salesCustomerId === salesCustomerId');
        expect(operatorSource).toContain('candidate.scope.assessmentId === assessmentId');
        expect(operatorSource).toContain('bindApprovedProposal(organisation, event.currentTarget, proposalId)');
        expect(operatorSource).toContain('recordCommercialAcceptance(organisation, event.currentTarget, proposalId)');
        expect(operatorSource).toContain("proposalIdOverride || window.prompt('Approved Sales proposal ID:')");
        expect(operatorSource).toContain("hasCapability('customer:accept')");
        expect(operatorSource).toContain("hasCapability('onboarding:write')");
        expect(operatorSource).toContain('href: `/support?customerId=${encodeURIComponent(organisation.organisationId)}`');
    });

    test('only offers acceptance for the exact lifecycle-linked assessment', () => {
        expect(salesSource).toContain('const assessment = assessmentById(proposal.assessmentId)');
        expect(salesSource).toContain('assessment.lifecycleOrganisationId === customer.lifecycleOrganisationId');
        expect(salesSource).toContain('Proposal approved — linked assessment required');
        expect(salesSource).toContain('approvedProposalNotice(proposal, customer, assessment)');
    });
});
