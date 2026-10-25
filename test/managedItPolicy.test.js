const {
    MANAGED_IT_POLICY,
    managedItPolicyCustomerSummary,
    managedItPolicyIdentity,
    managedItPolicyPromptSummary
} = require('../api/shared/managedItPolicy');
const { PRICE_VERSION, STANDARD_PRICE, estimateManagedItPrice } = require('../api/shared/mspPricing');

describe('effective managed IT policy', () => {
    test('owns the complete effective policy while retaining legacy pricing exports', () => {
        expect(MANAGED_IT_POLICY).toMatchObject({
            schemaVersion: 1,
            policyId: 'managed_it_2026_08_4',
            legacyPriceVersion: '2026.08.4',
            effectiveFrom: '2026-08-23',
            customerFacingServiceName: 'No Fries Managed IT',
            pricing: {
                perUserMonthly: 119,
                onboardingFrom: 750,
                additionalEndpointMonthly: 20,
                additionalLocationMonthly: 125
            },
            manualReviewThresholds: { users: 150, endpoints: 200, locations: 5 }
        });
        expect(MANAGED_IT_POLICY.includedServices.length).toBeGreaterThan(0);
        expect(MANAGED_IT_POLICY.optionalServices.length).toBeGreaterThan(0);
        expect(MANAGED_IT_POLICY.exclusions.length).toBeGreaterThan(0);
        expect(Object.isFrozen(MANAGED_IT_POLICY.pricing)).toBe(true);
        expect(PRICE_VERSION).toBe(MANAGED_IT_POLICY.legacyPriceVersion);
        expect(STANDARD_PRICE).toMatchObject({
            currency: 'NZD',
            gstExclusive: true,
            perUserMonthly: 119,
            manualReviewUsers: 150,
            manualReviewLocations: 5
        });
    });

    test('generates customer and prompt summaries from the same policy', () => {
        expect(managedItPolicyCustomerSummary()).toContain('No Fries Managed IT');
        expect(managedItPolicyCustomerSummary()).toContain('NZ$119');
        expect(managedItPolicyPromptSummary()).toContain(MANAGED_IT_POLICY.policyId);
        expect(managedItPolicyIdentity()).toEqual({
            policyId: MANAGED_IT_POLICY.policyId,
            policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
            effectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
            serviceName: MANAGED_IT_POLICY.customerFacingServiceName
        });
        expect(estimateManagedItPrice({})).toMatchObject({
            policyId: MANAGED_IT_POLICY.policyId,
            version: PRICE_VERSION,
            serviceName: MANAGED_IT_POLICY.customerFacingServiceName
        });
    });

    test('retains the established manual-review boundary for larger location counts', () => {
        const estimate = estimateManagedItPrice({
            users: { estimatedCount: 10 },
            endpoints: { estimatedCount: 10 },
            locations: { items: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'] }
        });
        expect(estimate).toMatchObject({
            status: 'indicative_review',
            reviewReasons: ['a large number of locations']
        });
    });
});
