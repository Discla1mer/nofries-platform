const {
    applyServicePlanReview,
    buildDynamicsPayload,
    buildProposal,
    buildServicePlanView
} = require('../api/shared/salesRuntime');

function recommendation(serviceKey, serviceName, fit, decision = 'pending') {
    return {
        id: `recommendation_${serviceKey}`,
        serviceKey,
        serviceName,
        category: 'Managed IT',
        customerOutcome: `${serviceName} customer outcome`,
        fit,
        reasons: [`${serviceName} matched discovery`],
        missingInformation: [],
        blockers: [],
        review: {
            decision,
            roadmap: fit === 'strong_fit' ? 'now' : 'next',
            estimatedMrr: serviceKey === 'ai-service-desk' ? 40 : 0,
            oneOffRevenue: 0,
            owner: '',
            nextAction: '',
            consultantRationale: '',
            customerOutcome: `${serviceName} customer outcome`
        }
    };
}

function assessment() {
    return {
        id: 'assessment_bundle',
        customerId: 'customer_bundle',
        answers: {},
        recommendations: [
            recommendation('managed-it-core', 'No Fries Lean Managed IT', 'strong_fit'),
            recommendation('ai-service-desk', 'Phone, chat and email support', 'strong_fit'),
            recommendation('endpoint-backup', 'Work-file backup and recovery', 'potential_fit')
        ],
        updatedAt: '2026-08-19T00:00:00.000Z'
    };
}

const access = { user: { email: 'consultant@nofries.nz' } };

describe('bundled Lean Managed IT service plan', () => {
    test('uses lifecycle counts and derives sensible component defaults without mutating legacy reviews', () => {
        const record = assessment();
        const view = buildServicePlanView(record, {
            context: {
                users: { estimatedCount: 2 },
                endpoints: { estimatedCount: 2 },
                locations: { items: ['Auckland'] }
            }
        }, access);

        expect(view.available).toBe(true);
        expect(view.counts).toEqual({ users: 2, endpoints: 2, locations: 1 });
        expect(view.pricing).toMatchObject({ monthly: 238, onboarding: 750 });
        expect(view.components.map((item) => [item.serviceKey, item.status])).toEqual([
            ['ai-service-desk', 'included'],
            ['endpoint-backup', 'needs_confirmation']
        ]);
        expect(record.bundleReview).toBeUndefined();
    });

    test('saves one atomic review and produces one priced proposal and one CRM opportunity', () => {
        const record = assessment();
        applyServicePlanReview(record, {
            counts: { users: 2, endpoints: 2, locations: 1 },
            components: [
                { serviceKey: 'ai-service-desk', status: 'included' },
                { serviceKey: 'endpoint-backup', status: 'needs_confirmation' }
            ],
            owner: 'Joel Harvey',
            consultantRationale: 'One accountable service is the clearest fit.',
            nextAction: 'Review the draft proposal with Joel.'
        }, access);

        expect(record.bundleReview.pricing).toMatchObject({ monthly: 238, onboarding: 750 });
        expect(record.recommendations.find((item) => item.serviceKey === 'managed-it-core').review).toMatchObject({
            decision: 'accepted',
            estimatedMrr: 238,
            oneOffRevenue: 750
        });
        expect(record.recommendations.find((item) => item.serviceKey === 'ai-service-desk').review.estimatedMrr).toBe(40);

        const accepted = record.recommendations.filter((item) => item.review.decision === 'accepted');
        const proposal = buildProposal('proposal_bundle', {
            id: 'customer_bundle',
            name: 'No Fries Limited'
        }, record, accepted, access);

        expect(proposal.commercialModel).toBe('bundled_managed_it');
        expect(proposal.recommendations).toHaveLength(1);
        expect(proposal.bundle.includedComponents.map((item) => item.serviceKey)).toEqual(['ai-service-desk']);
        expect(proposal.bundle.validationComponents.map((item) => item.serviceKey)).toEqual(['endpoint-backup']);
        expect(proposal.pricing).toMatchObject({ users: 2, endpoints: 2, locations: 1, monthly: 238, onboarding: 750 });

        const payload = buildDynamicsPayload({ tenant: { key: 'nofries' } }, {
            id: 'customer_bundle',
            name: 'No Fries Limited'
        }, record, Object.assign({}, proposal, {
            status: 'approved',
            approvedBy: 'consultant@nofries.nz',
            approvedAt: '2026-08-19T01:00:00.000Z'
        }));

        expect(payload.schemaVersion).toBe('2026-08-2');
        expect(payload.opportunities).toHaveLength(1);
        expect(payload.opportunities[0]).toMatchObject({
            serviceKey: 'managed-it-core',
            estimatedMonthlyRevenue: 238,
            estimatedOneOffRevenue: 750,
            owner: 'Joel Harvey'
        });
        expect(payload.opportunities[0].includedComponents).toEqual([
            { serviceKey: 'ai-service-desk', serviceName: 'Phone, chat and email support' }
        ]);
    });

    test('rejects unconfirmed pricing counts', () => {
        expect(() => applyServicePlanReview(assessment(), {
            counts: { users: '', endpoints: 2, locations: 1 },
            components: []
        }, access)).toThrow('Enter a whole number of users');
    });
});
