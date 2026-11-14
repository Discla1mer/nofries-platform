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

        expect(PRICE_VERSION).toBe('2026.11.1');
        expect(STANDARD_PRICE).toMatchObject({
            perUserMonthly: 99,
            includedEndpointsPerUser: 1,
            onboardingFrom: 750,
            recommendedTierId: 'managed'
        });
        expect(estimate).toMatchObject({
            status: 'needs_more_info',
            missing: ['users', 'endpoints'],
            perUserMonthly: 99,
            includedEndpointsPerUser: 1,
            onboardingFrom: 750,
            recommendedTierId: 'managed'
        });
        expect(estimate).not.toHaveProperty('monthlyMinimum');
    });

    test('charges the recommended tier rate per user and includes one main work computer per user', () => {
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
            perUser: 99,
            monthly: 198,
            onboarding: 750,
            selectedTierId: 'managed',
            recommendedTierId: 'managed'
        });
        expect(estimate.assumptions).toContain('Proof every month');
        const reply = priceReply(estimate);
        expect(reply).toContain('On the Managed plan');
        expect(reply).toContain('NZ$198 + GST per month');
        expect(reply).toContain('NZ$99 + GST per user');
        expect(reply).toContain('Essentials is NZ$59 + GST');
        expect(reply).toContain('Secure is NZ$139 + GST');
        expect(reply).not.toMatch(/\bAI\b|\bscope\b|24\/7/i);
    });

    test('returns a tiers breakdown and honours a selected tier without changing add-ons', () => {
        const context = {
            users: { estimatedCount: 2 },
            endpoints: { estimatedCount: 4 },
            locations: { items: ['Auckland', 'Hamilton'] },
            productivity: { platform: 'microsoft_365' }
        };
        const recommended = estimateManagedItPrice(context);
        // Add-ons: 2 extra computers (NZ$20) + 1 extra location (NZ$125) = NZ$165.
        expect(recommended.tiers).toEqual([
            expect.objectContaining({ id: 'essentials', name: 'Essentials', perUserMonthly: 59, recommended: false, monthly: 283 }),
            expect.objectContaining({ id: 'managed', name: 'Managed', perUserMonthly: 99, recommended: true, monthly: 363 }),
            expect.objectContaining({ id: 'secure', name: 'Secure', perUserMonthly: 139, recommended: false, monthly: 443 })
        ]);
        expect(recommended).toMatchObject({
            additionalEndpoints: 2,
            locations: 2,
            selectedTierId: 'managed',
            perUser: 99,
            monthly: 363,
            onboarding: 750
        });

        const essentials = estimateManagedItPrice({ ...context, tier: 'essentials' });
        expect(essentials).toMatchObject({ selectedTierId: 'essentials', perUser: 59, monthly: 283, onboarding: 750 });
        const secureByName = estimateManagedItPrice({ ...context, tier: 'Secure' });
        expect(secureByName).toMatchObject({ selectedTierId: 'secure', perUser: 139, monthly: 443 });
        expect(priceReply(essentials)).toContain('On the Essentials plan');
        // An unknown tier falls back to the recommended tier.
        const unknown = estimateManagedItPrice({ ...context, tier: 'platinum' });
        expect(unknown.selectedTierId).toBe('managed');
    });

    test('recognises natural pricing questions', () => {
        expect(shouldOfferPrice({}, 'What is the price per user?')).toBe(true);
        expect(shouldOfferPrice({}, 'What is the setup fee?')).toBe(true);
        expect(shouldOfferPrice({}, 'How does support work?')).toBe(false);
    });
});
