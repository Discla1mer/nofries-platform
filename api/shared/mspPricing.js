const { MANAGED_IT_POLICY } = require('./managedItPolicy');

// Compatibility exports for existing proposal and catalogue records. New code should
// retain the policyId as well as the legacy version when it persists a price.
const PRICE_VERSION = MANAGED_IT_POLICY.legacyPriceVersion;
// STANDARD_PRICE spreads MANAGED_IT_POLICY.pricing, so it also carries the
// three-tier model (`tiers`) and `recommendedTierId` derived from the policy.
const STANDARD_PRICE = Object.freeze(Object.assign({
    currency: MANAGED_IT_POLICY.currency,
    gstExclusive: MANAGED_IT_POLICY.gstExclusive,
    manualReviewUsers: MANAGED_IT_POLICY.manualReviewThresholds.users,
    manualReviewEndpoints: MANAGED_IT_POLICY.manualReviewThresholds.endpoints,
    manualReviewLocations: MANAGED_IT_POLICY.manualReviewThresholds.locations
}, MANAGED_IT_POLICY.pricing));

// Add-ons (endpoints, locations, onboarding) are tier-independent, so only the
// per-user rate changes between tiers. A caller may request a tier by id or by
// name, case-insensitive; an unknown value falls back to the recommended tier.
function normaliseTierId(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return null;
    const match = STANDARD_PRICE.tiers.find((tier) => tier.id === text || tier.name.toLowerCase() === text);
    return match ? match.id : null;
}

function estimateManagedItPrice(context = {}) {
    const users = positiveNumber(context.users && context.users.estimatedCount);
    const endpoints = positiveNumber(context.endpoints && context.endpoints.estimatedCount);
    const locations = cleanLocations(context.locations && context.locations.items);
    const missing = [];
    if (users == null) missing.push('users');
    if (endpoints == null) missing.push('endpoints');

    if (missing.length) {
        const selectedTierId = normaliseTierId(context.tier) || STANDARD_PRICE.recommendedTierId;
        return {
            version: PRICE_VERSION,
            policyVersion: PRICE_VERSION,
            policyId: MANAGED_IT_POLICY.policyId,
            policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
            serviceName: MANAGED_IT_POLICY.customerFacingServiceName,
            status: 'needs_more_info',
            missing,
            currency: STANDARD_PRICE.currency,
            gstExclusive: STANDARD_PRICE.gstExclusive,
            perUserMonthly: STANDARD_PRICE.perUserMonthly,
            includedEndpointsPerUser: STANDARD_PRICE.includedEndpointsPerUser,
            onboardingFrom: STANDARD_PRICE.onboardingFrom,
            selectedTierId,
            recommendedTierId: STANDARD_PRICE.recommendedTierId
        };
    }

    const includedEndpoints = users * STANDARD_PRICE.includedEndpointsPerUser;
    const billableEndpoints = Math.max(0, endpoints - includedEndpoints);
    const locationCount = Math.max(1, locations.length || 1);
    const billableLocations = Math.max(0, locationCount - STANDARD_PRICE.includedLocations);

    // Tier-independent add-ons are shared across every tier; only the per-user
    // rate differs, so build one breakdown row per tier and pick the selected one.
    const addOnMonthly =
        billableEndpoints * STANDARD_PRICE.additionalEndpointMonthly +
        billableLocations * STANDARD_PRICE.additionalLocationMonthly;
    const tiers = STANDARD_PRICE.tiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        perUserMonthly: tier.perUserMonthly,
        recommended: tier.recommended,
        tagline: tier.tagline,
        monthly: users * tier.perUserMonthly + addOnMonthly
    }));
    const selectedTierId = normaliseTierId(context.tier) || STANDARD_PRICE.recommendedTierId;
    const selectedTier = tiers.find((tier) => tier.id === selectedTierId)
        || tiers.find((tier) => tier.id === STANDARD_PRICE.recommendedTierId);
    const perUser = selectedTier.perUserMonthly;
    const monthly = selectedTier.monthly;
    const onboarding = roundToFive(STANDARD_PRICE.onboardingFrom);

    const reviewReasons = [];
    const platform = String(context.productivity && context.productivity.platform || '').trim();
    if (users > STANDARD_PRICE.manualReviewUsers) reviewReasons.push('a large number of users');
    if (endpoints > STANDARD_PRICE.manualReviewEndpoints) reviewReasons.push('a large number of devices');
    if (locationCount > STANDARD_PRICE.manualReviewLocations) reviewReasons.push('a large number of locations');
    if (platform && !['microsoft_365', 'google_workspace', 'mixed', 'unknown'].includes(platform)) reviewReasons.push('a less common business platform');

    return {
        version: PRICE_VERSION,
        policyVersion: PRICE_VERSION,
        policyId: MANAGED_IT_POLICY.policyId,
        policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
        serviceName: MANAGED_IT_POLICY.customerFacingServiceName,
        status: reviewReasons.length ? 'indicative_review' : 'indicative',
        currency: STANDARD_PRICE.currency,
        gstExclusive: STANDARD_PRICE.gstExclusive,
        users,
        endpoints,
        includedEndpoints,
        additionalEndpoints: billableEndpoints,
        locations: locationCount,
        perUser,
        monthly,
        onboarding,
        tiers,
        selectedTierId: selectedTier.id,
        recommendedTierId: STANDARD_PRICE.recommendedTierId,
        reviewReasons,
        assumptions: [
            'Remote user support during agreed business hours',
            'AI-assisted email helpdesk, with every change approved by Joel, our founder',
            'Support for one main work computer per user',
            'Help with business email and shared work tools where agreed',
            'Microsoft 365 backup is included from the Managed tier',
            'Security hardening and alert handling are included in the Secure tier',
            'Proof every month',
            'Large projects, on-site work, hardware, supplier charges and extra phone usage are agreed separately'
        ]
    };
}

function priceReply(estimate) {
    if (!estimate || estimate.status === 'needs_more_info') {
        const missing = estimate && estimate.missing || ['users', 'endpoints'];
        const label = missing.length === 2
            ? 'rough user and device counts'
            : missing[0] === 'users' ? 'a rough user count' : 'a rough device count';
        const tierPhrase = STANDARD_PRICE.tiers.map((tier, index) => {
            const marker = tier.recommended ? ' (recommended)' : '';
            const prefix = index === 0 ? '' : index === STANDARD_PRICE.tiers.length - 1 ? ' and ' : ', ';
            return `${prefix}${tier.name} at NZ$${tier.perUserMonthly.toLocaleString('en-NZ')} + GST${marker}`;
        }).join('');
        return `I can work out an indicative monthly total once I have ${label}. ${MANAGED_IT_POLICY.customerFacingServiceName} comes in three tiers per user each month: ${tierPhrase}, each including one main work computer per user. Initial set-up starts at NZ$${STANDARD_PRICE.onboardingFrom.toLocaleString('en-NZ')} + GST.`;
    }

    const review = estimate.reviewReasons && estimate.reviewReasons.length
        ? ` Because this includes ${estimate.reviewReasons.join(' and ')}, we will confirm the details before agreeing the service.`
        : ' This is a guide. We confirm exactly what is included before the service starts.';
    const tiers = Array.isArray(estimate.tiers) ? estimate.tiers : [];
    const selected = tiers.find((tier) => tier.id === estimate.selectedTierId) || tiers[0] || null;
    const sorted = [...tiers].sort((a, b) => a.perUserMonthly - b.perUserMonthly);
    const lower = sorted[0];
    const higher = sorted[sorted.length - 1];
    const planName = selected ? selected.name : 'Managed';
    const perUser = Number.isFinite(estimate.perUser) ? estimate.perUser : (selected ? selected.perUserMonthly : STANDARD_PRICE.perUserMonthly);
    const alternatives = lower && higher && lower.id !== higher.id
        ? ` ${lower.name} is NZ$${lower.perUserMonthly.toLocaleString('en-NZ')} + GST and ${higher.name} is NZ$${higher.perUserMonthly.toLocaleString('en-NZ')} + GST per user if you want less or more cover.`
        : '';
    return `On the ${planName} plan, based on ${estimate.users} ${estimate.users === 1 ? 'user' : 'users'}, ${estimate.endpoints} ${estimate.endpoints === 1 ? 'device' : 'devices'} and ${estimate.locations} ${estimate.locations === 1 ? 'location' : 'locations'}, the current No Fries estimate is NZ$${estimate.monthly.toLocaleString('en-NZ')} + GST per month (NZ$${perUser.toLocaleString('en-NZ')} + GST per user), with initial set-up from NZ$${estimate.onboarding.toLocaleString('en-NZ')} + GST.${alternatives}${review}`;
}

function shouldOfferPrice(context = {}, message = '') {
    return /\b(price|pricing|cost|quote|how much|monthly|per user|setup fee|set-up fee|onboarding fee)\b/i.test(String(message || ''));
}

function positiveNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function cleanLocations(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 50);
}

function roundToFive(value) {
    return Math.round(Number(value || 0) / 5) * 5;
}

module.exports = {
    PRICE_VERSION,
    STANDARD_PRICE,
    estimateManagedItPrice,
    priceReply,
    shouldOfferPrice
};
