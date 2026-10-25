const { MANAGED_IT_POLICY } = require('./managedItPolicy');

// Compatibility exports for existing proposal and catalogue records. New code should
// retain the policyId as well as the legacy version when it persists a price.
const PRICE_VERSION = MANAGED_IT_POLICY.legacyPriceVersion;
const STANDARD_PRICE = Object.freeze(Object.assign({
    currency: MANAGED_IT_POLICY.currency,
    gstExclusive: MANAGED_IT_POLICY.gstExclusive,
    manualReviewUsers: MANAGED_IT_POLICY.manualReviewThresholds.users,
    manualReviewEndpoints: MANAGED_IT_POLICY.manualReviewThresholds.endpoints,
    manualReviewLocations: MANAGED_IT_POLICY.manualReviewThresholds.locations
}, MANAGED_IT_POLICY.pricing));

function estimateManagedItPrice(context = {}) {
    const users = positiveNumber(context.users && context.users.estimatedCount);
    const endpoints = positiveNumber(context.endpoints && context.endpoints.estimatedCount);
    const locations = cleanLocations(context.locations && context.locations.items);
    const missing = [];
    if (users == null) missing.push('users');
    if (endpoints == null) missing.push('endpoints');

    if (missing.length) {
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
            onboardingFrom: STANDARD_PRICE.onboardingFrom
        };
    }

    const includedEndpoints = users * STANDARD_PRICE.includedEndpointsPerUser;
    const billableEndpoints = Math.max(0, endpoints - includedEndpoints);
    const locationCount = Math.max(1, locations.length || 1);
    const billableLocations = Math.max(0, locationCount - STANDARD_PRICE.includedLocations);

    const monthly =
        users * STANDARD_PRICE.perUserMonthly +
        billableEndpoints * STANDARD_PRICE.additionalEndpointMonthly +
        billableLocations * STANDARD_PRICE.additionalLocationMonthly;
    const onboarding = roundToFive(
        STANDARD_PRICE.onboardingFrom +
        billableEndpoints * STANDARD_PRICE.additionalEndpointOnboarding +
        billableLocations * STANDARD_PRICE.additionalLocationOnboarding
    );

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
        monthly,
        onboarding,
        reviewReasons,
        assumptions: [
            'Remote user support during agreed business hours',
            'Phone, chat and email support',
            'Support and device care for one main work computer per user',
            'Help with business email and shared work tools where agreed',
            'Threat protection and after-hours security help only when listed in the service schedule',
            'Backup of agreed work files only when listed in the service schedule',
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
        return `I can work out an indicative monthly total once I have ${label}. ${MANAGED_IT_POLICY.customerFacingServiceName} is NZ$${STANDARD_PRICE.perUserMonthly.toLocaleString('en-NZ')} + GST per user each month and includes one main work computer per user. Initial set-up starts at NZ$${STANDARD_PRICE.onboardingFrom.toLocaleString('en-NZ')} + GST.`;
    }

    const review = estimate.reviewReasons && estimate.reviewReasons.length
        ? ` Because this includes ${estimate.reviewReasons.join(' and ')}, we will confirm the details before agreeing the service.`
        : ' This is a guide. We confirm exactly what is included before the service starts.';
    return `Based on ${estimate.users} ${estimate.users === 1 ? 'user' : 'users'}, ${estimate.endpoints} ${estimate.endpoints === 1 ? 'device' : 'devices'} and ${estimate.locations} ${estimate.locations === 1 ? 'location' : 'locations'}, the current No Fries estimate is NZ$${estimate.monthly.toLocaleString('en-NZ')} + GST per month, with initial set-up from NZ$${estimate.onboarding.toLocaleString('en-NZ')} + GST.${review}`;
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
