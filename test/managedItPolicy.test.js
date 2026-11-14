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
            policyId: 'managed_it_2026_11_1',
            legacyPriceVersion: '2026.11.1',
            effectiveFrom: '2026-11-09',
            customerFacingServiceName: 'No Fries Managed IT',
            pricing: {
                // Top-level per-user rate mirrors the recommended tier (Managed).
                perUserMonthly: 99,
                onboardingFrom: 750,
                additionalEndpointMonthly: 20,
                additionalLocationMonthly: 125,
                recommendedTierId: 'managed'
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
            perUserMonthly: 99,
            manualReviewUsers: 150,
            manualReviewLocations: 5
        });
    });

    test('defines the three managed-IT tiers with correct rates, names and the recommended flag', () => {
        const tiers = MANAGED_IT_POLICY.pricing.tiers;
        expect(tiers.map((tier) => [tier.id, tier.name, tier.perUserMonthly])).toEqual([
            ['essentials', 'Essentials', 59],
            ['managed', 'Managed', 99],
            ['secure', 'Secure', 139]
        ]);
        expect(MANAGED_IT_POLICY.pricing.recommendedTierId).toBe('managed');
        expect(tiers.filter((tier) => tier.recommended).map((tier) => tier.id)).toEqual(['managed']);
        expect(tiers.find((tier) => tier.id === 'essentials').inheritsFromTierId).toBeNull();
        expect(tiers.find((tier) => tier.id === 'managed').inheritsFromTierId).toBe('essentials');
        expect(tiers.find((tier) => tier.id === 'secure').inheritsFromTierId).toBe('managed');
        expect(tiers.find((tier) => tier.id === 'managed').additionalFeatures)
            .toContain('Dealing with your other IT vendors');
    });

    test('generates customer and prompt summaries from the same policy', () => {
        expect(managedItPolicyCustomerSummary()).toContain('No Fries Managed IT');
        expect(managedItPolicyCustomerSummary()).toContain('three tiers');
        expect(managedItPolicyCustomerSummary()).toContain('Essentials at NZ$59');
        expect(managedItPolicyCustomerSummary()).toContain('Managed at NZ$99 (recommended)');
        expect(managedItPolicyCustomerSummary()).toContain('Secure at NZ$139');
        expect(managedItPolicyCustomerSummary()).not.toContain('24/7');
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

    test('customer-facing policy text names no individual and offers on-site work by arrangement', () => {
        const customerText = [
            managedItPolicyPromptSummary(),
            ...estimateManagedItPrice({}).assumptions || [],
            ...estimateManagedItPrice({ users: { estimatedCount: 5 }, endpoints: { estimatedCount: 5 } }).assumptions
        ].join('\n');
        expect(customerText).not.toMatch(/\bJoel\b|\bfounder\b/i);
        expect(customerText).not.toMatch(/agreed business hours/);
        expect(MANAGED_IT_POLICY.exclusions.join(' ')).not.toMatch(/on-site/i);
        expect(MANAGED_IT_POLICY.optionalServices).toEqual(expect.arrayContaining([
            'On-site work by arrangement, quoted separately',
            'Microsoft 365 backup on Essentials, available as an add-on, quoted on request'
        ]));
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
