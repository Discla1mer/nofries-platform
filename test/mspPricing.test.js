const {
    PRICE_VERSION,
    STANDARD_PRICE,
    estimateManagedItPrice,
    priceReply,
    shouldOfferPrice
} = require('../api/shared/mspPricing');

describe('No Fries per-user pricing', () => {
    test('publishes the per-user rate and setup starting price when counts are missing', () => {
        const estimate = estimateManagedItPrice({});

        expect(PRICE_VERSION).toBe('2026.08.4');
        expect(STANDARD_PRICE).toMatchObject({
            perUserMonthly: 119,
            includedEndpointsPerUser: 1,
            onboardingFrom: 750
        });
        expect(estimate).toMatchObject({
            status: 'needs_more_info',
            missing: ['users', 'endpoints'],
            perUserMonthly: 119,
            includedEndpointsPerUser: 1,
            onboardingFrom: 750
        });
        expect(estimate).not.toHaveProperty('monthlyMinimum');
    });

    test('charges NZ$119 per user and includes one main work computer per user', () => {
        const estimate = estimateManagedItPrice({
            users: { estimatedCount: 2 },
            endpoints: { estimatedCount: 2 },
            locations: { items: ['Auckland'] },
            productivity: { platform: 'google_workspace' }
        });

        expect(estimate).toMatchObject({
            status: 'indicative',
            users: 2,
            endpoints: 2,
            includedEndpoints: 2,
            additionalEndpoints: 0,
            locations: 1,
            monthly: 238,
            onboarding: 750
        });
        expect(estimate.assumptions).toContain('Proof every month');
        expect(priceReply(estimate)).toContain('NZ$238 + GST per month');
        expect(priceReply(estimate)).not.toMatch(/\bAI\b|\bscope\b/i);
    });

    test('adds extra computers and locations without changing the per-user rate', () => {
        const estimate = estimateManagedItPrice({
            users: { estimatedCount: 2 },
            endpoints: { estimatedCount: 4 },
            locations: { items: ['Auckland', 'Hamilton'] },
            productivity: { platform: 'microsoft_365' }
        });

        expect(estimate).toMatchObject({
            additionalEndpoints: 2,
            locations: 2,
            monthly: 403,
            onboarding: 1060
        });
    });

    test('recognises natural pricing questions', () => {
        expect(shouldOfferPrice({}, 'What is the price per user?')).toBe(true);
        expect(shouldOfferPrice({}, 'What is the setup fee?')).toBe(true);
        expect(shouldOfferPrice({}, 'How does support work?')).toBe(false);
    });
});
