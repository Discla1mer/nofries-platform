const MANAGED_IT_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'managed_it_2026_08_4',
    legacyPriceVersion: '2026.08.4',
    effectiveFrom: '2026-08-23',
    currency: 'NZD',
    gstExclusive: true,
    customerFacingServiceName: 'No Fries Managed IT',
    legacyServiceNames: ['No Fries Lean Managed IT', 'Lean Managed IT'],
    tagline: 'No frills. Proof every month.',
    pricing: {
        perUserMonthly: 119,
        includedEndpointsPerUser: 1,
        includedLocations: 1,
        onboardingFrom: 750,
        additionalEndpointMonthly: 20,
        additionalLocationMonthly: 125,
        additionalEndpointOnboarding: 30,
        additionalLocationOnboarding: 250
    },
    includedServices: [
        'Day-to-day user support during agreed business hours',
        'Phone, chat and email support',
        'Care for one main work computer per user',
        'Administration of agreed business email and shared work tools',
        'Supplier follow-up for agreed services',
        'Monthly service reporting and review'
    ],
    optionalServices: [
        'Threat protection and after-hours security help',
        'Backup of agreed work files'
    ],
    exclusions: [
        'Large projects',
        'On-site work',
        'Hardware',
        'Supplier charges',
        'Extra phone usage'
    ],
    manualReviewThresholds: {
        users: 150,
        endpoints: 200,
        locations: 5
    },
    approvedCustomerLanguage: {
        monthlyBasis: 'per user each month, including one main work computer per user',
        onboardingBasis: 'Initial set-up starts from the policy amount',
        estimateBoundary: 'Indicative prices are confirmed with the service scope before acceptance.'
    }
});

function getManagedItPolicy() {
    return MANAGED_IT_POLICY;
}

function managedItPolicyIdentity() {
    return {
        policyId: MANAGED_IT_POLICY.policyId,
        policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
        effectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
        serviceName: MANAGED_IT_POLICY.customerFacingServiceName
    };
}

function managedItPolicyCustomerSummary() {
    const policy = MANAGED_IT_POLICY;
    const price = policy.pricing;
    return `${policy.customerFacingServiceName} is NZ$${price.perUserMonthly} + GST per user each month, including one main work computer per user. Initial set-up starts at NZ$${price.onboardingFrom} + GST. Extra computers are NZ$${price.additionalEndpointMonthly} + GST each per month and extra locations are NZ$${price.additionalLocationMonthly} + GST each per month. ${policy.approvedCustomerLanguage.estimateBoundary}`;
}

function managedItPolicyPromptSummary() {
    const policy = MANAGED_IT_POLICY;
    return [
        `Authoritative commercial policy: ${policy.policyId}, effective ${policy.effectiveFrom}.`,
        managedItPolicyCustomerSummary(),
        `Included services: ${policy.includedServices.join('; ')}.`,
        `Optional only when selected: ${policy.optionalServices.join('; ')}.`,
        `Agreed separately: ${policy.exclusions.join('; ')}.`
    ].join('\n');
}

function managedItPolicyCacheSegment() {
    return MANAGED_IT_POLICY.policyId.replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

module.exports = {
    MANAGED_IT_POLICY,
    getManagedItPolicy,
    managedItPolicyCacheSegment,
    managedItPolicyCustomerSummary,
    managedItPolicyPromptSummary,
    managedItPolicyIdentity
};
