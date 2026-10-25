const RAW_DISCOVERY_PATTERN = /\?\s*(?:—|-{1,2}|:)/;
const STALE_NEXT_STEP_PATTERN = /prepare\s+(?:the\s+)?(?:managed\s+it\s+)?proposal(?:\s*\/\s*agreement)?/i;
const SECRET_REVIEW_NOTE_PATTERN = /no passwords?,?\s*(?:access tokens?|recovery codes?)/i;
const { MANAGED_IT_POLICY } = require('./managedItPolicy');

const CURRENT_PROPOSAL_PRICING = Object.freeze({
    policyId: MANAGED_IT_POLICY.policyId,
    policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
    policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
    serviceName: MANAGED_IT_POLICY.customerFacingServiceName,
    currency: MANAGED_IT_POLICY.currency,
    gstExclusive: MANAGED_IT_POLICY.gstExclusive,
    perUserMonthly: MANAGED_IT_POLICY.pricing.perUserMonthly,
    includedEndpointsPerUser: MANAGED_IT_POLICY.pricing.includedEndpointsPerUser,
    includedLocations: MANAGED_IT_POLICY.pricing.includedLocations,
    onboardingFrom: MANAGED_IT_POLICY.pricing.onboardingFrom,
    additionalEndpointMonthly: MANAGED_IT_POLICY.pricing.additionalEndpointMonthly,
    additionalLocationMonthly: MANAGED_IT_POLICY.pricing.additionalLocationMonthly,
    additionalEndpointOnboarding: MANAGED_IT_POLICY.pricing.additionalEndpointOnboarding,
    additionalLocationOnboarding: MANAGED_IT_POLICY.pricing.additionalLocationOnboarding
});

const CURRENT_COMMERCIAL_POLICY = Object.freeze({
    policyId: MANAGED_IT_POLICY.policyId,
    policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
    effectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
    serviceName: MANAGED_IT_POLICY.customerFacingServiceName
});

function assessProposalCommercialPolicy(proposalValue = {}) {
    const proposal = object(proposalValue);
    const pricing = object(proposal.pricing);
    const commercialPolicy = object(proposal.commercialPolicy);
    const mismatchedFields = [];

    comparePolicyFields('pricing', pricing, CURRENT_PROPOSAL_PRICING, mismatchedFields);
    comparePolicyFields('commercialPolicy', commercialPolicy, CURRENT_COMMERCIAL_POLICY, mismatchedFields);

    const current = mismatchedFields.length === 0;
    return {
        status: current ? 'current' : 'migration_required',
        approvalAllowed: current,
        code: current ? '' : 'commercial_policy_migration_required',
        currentPolicy: Object.assign({}, CURRENT_COMMERCIAL_POLICY),
        storedPolicy: {
            pricingPolicyId: clean(pricing.policyId),
            pricingPolicyVersion: clean(pricing.policyVersion),
            commercialPolicyId: clean(commercialPolicy.policyId),
            commercialPolicyVersion: clean(commercialPolicy.policyVersion)
        },
        mismatchedFields
    };
}

function createCommercialSummary(assessment = {}, pricing = {}) {
    const answers = assessment.answers || {};
    return normaliseCommercialSummary({
        userCount: exactCountFromAnswer(answers['estate.users']),
        managedEndpointCount: exactCountFromAnswer(answers['estate.endpoints']),
        locationCount: exactLocationCount(answers['estate.locations']),
        onboardingFeeExGst: pricing.onboardingFrom,
        termMonths: null,
        plannedStart: '',
        confirmed: false
    }, pricing);
}

function normaliseCommercialSummary(value = {}, pricing = {}, fallback = {}, options = {}) {
    const source = Object.assign({}, fallback || {}, value || {});
    const userCount = optionalInteger(source.userCount, 1);
    const managedEndpointCount = optionalInteger(source.managedEndpointCount, 0);
    const locationCount = optionalInteger(source.locationCount, 0);
    const allowPolicyDefaults = options.allowPolicyDefaults !== false;
    const onboardingDefault = money(
        pricing.onboardingFrom,
        allowPolicyDefaults ? MANAGED_IT_POLICY.pricing.onboardingFrom : null
    );
    const onboardingFeeExGst = money(source.onboardingFeeExGst, onboardingDefault);
    const termMonths = optionalInteger(source.termMonths, 1);
    const plannedStart = /^\d{4}-\d{2}-\d{2}$/.test(String(source.plannedStart || ''))
        ? String(source.plannedStart)
        : '';
    const calculatedMonthlyTotal = calculateMonthlyTotal({
        userCount,
        managedEndpointCount,
        locationCount
    }, pricing, { allowPolicyDefaults });
    const monthlyTotalExGst = calculatedMonthlyTotal == null && !allowPolicyDefaults
        ? money(source.monthlyTotalExGst, null)
        : calculatedMonthlyTotal;

    return {
        userCount,
        managedEndpointCount,
        locationCount,
        onboardingFeeExGst,
        termMonths,
        plannedStart,
        confirmed: source.confirmed === true || source.confirmed === 'true' || source.confirmed === 'on',
        monthlyTotalExGst
    };
}

function calculateMonthlyTotal(commercial = {}, pricing = {}, options = {}) {
    const users = optionalInteger(commercial.userCount, 1);
    const endpoints = optionalInteger(commercial.managedEndpointCount, 0);
    const locations = optionalInteger(commercial.locationCount, 0);
    if (users == null || endpoints == null || locations == null) return null;

    const allowPolicyDefaults = options.allowPolicyDefaults !== false;
    const perUser = money(
        pricing.perUserMonthly,
        allowPolicyDefaults ? MANAGED_IT_POLICY.pricing.perUserMonthly : null
    );
    const additionalEndpoint = money(
        pricing.additionalEndpointMonthly,
        allowPolicyDefaults ? MANAGED_IT_POLICY.pricing.additionalEndpointMonthly : null
    );
    const additionalLocation = money(
        pricing.additionalLocationMonthly,
        allowPolicyDefaults ? MANAGED_IT_POLICY.pricing.additionalLocationMonthly : null
    );
    if (perUser == null || additionalEndpoint == null || additionalLocation == null) return null;
    const additionalEndpoints = Math.max(0, endpoints - users);
    const additionalLocations = Math.max(0, locations - 1);
    return roundMoney(
        (users * perUser) +
        (additionalEndpoints * additionalEndpoint) +
        (additionalLocations * additionalLocation)
    );
}

function validateProposalDraft(input = {}) {
    const proposal = input.proposal || {};
    const customer = input.customer || {};
    const commercial = normaliseCommercialSummary(proposal.commercial, proposal.pricing || input.pricing || {});
    const warnings = [];
    const add = (code, section, message, blocking = false) => {
        warnings.push({
            code,
            severity: blocking ? 'blocking' : 'warning',
            section,
            message,
            blocking
        });
    };

    if (!clean(proposal.title)) {
        add('proposal_title_required', 'Title', 'Add a customer-facing proposal title.', true);
    } else if (clean(customer.name) && !clean(proposal.title).toLowerCase().includes(clean(customer.name).toLowerCase())) {
        add('customer_name_mismatch', 'Title', `Use the current customer name, ${clean(customer.name)}, in the proposal title.`, true);
    }
    if (!clean(proposal.executiveSummary)) {
        add('executive_summary_required', 'Executive summary', 'Add a short executive summary based on confirmed information.', true);
    }

    const rawSections = [];
    for (const observation of proposal.observations || []) {
        if (RAW_DISCOVERY_PATTERN.test(clean(observation))) rawSections.push('Agreed observations');
    }
    for (const item of proposal.recommendations || []) {
        if (RAW_DISCOVERY_PATTERN.test(clean(item.why)) || RAW_DISCOVERY_PATTERN.test(clean(item.outcome))) {
            rawSections.push(item.serviceName || 'Recommended service');
        }
    }
    if (rawSections.length) {
        add('raw_discovery_copy', 'Customer wording', `Rewrite raw discovery questions or notes in ${unique(rawSections).join(', ')}.`, true);
    }

    const supportText = flattenProposalText(proposal).toLowerCase();
    if (/phone|telephone/.test(supportText) && /no need for (?:phone|telephone)|phone support (?:is )?not required/.test(supportText)) {
        add('support_channel_contradiction', 'Support channels', 'The proposal both includes and rejects telephone support. Confirm the intended support channels.', true);
    }
    if (/support bot|chatbot/.test(supportText)) {
        add('support_bot_unconfirmed', 'Support channels', 'Do not promise a customer support bot unless that operational service has been explicitly confirmed.', true);
    }
    if ((proposal.assumptions || []).some((item) => SECRET_REVIEW_NOTE_PATTERN.test(clean(item)))) {
        add('internal_review_note', 'Important notes', 'Move the password and token review note out of the customer proposal.', false);
    }
    if (STALE_NEXT_STEP_PATTERN.test(clean(proposal.nextStep))) {
        add('stale_next_step', 'Next step', 'The next step still says to prepare the proposal even though the proposal already exists.', true);
    }

    for (const item of proposal.recommendations || []) {
        if (!clean(item.serviceName) || !clean(item.outcome) || !clean(item.why)) {
            add('service_wording_incomplete', item.serviceName || 'Recommended service', 'Each service needs a clear name, customer outcome and reason.', true);
        }
        if (['next', 'later'].includes(clean(item.roadmap).toLowerCase())) {
            add('timing_needs_context', item.serviceName || 'Recommended service', `Replace “${titleCase(item.roadmap)}” with a specific phase or date in the issued proposal.`, false);
        }
    }

    if (commercial.userCount == null) {
        add('exact_user_count_required', 'Commercial summary', 'Confirm the exact number of supported people.', true);
    }
    if (commercial.managedEndpointCount == null) {
        add('exact_endpoint_count_required', 'Commercial summary', 'Confirm the exact number of managed computers.', true);
    }
    if (commercial.locationCount == null) {
        add('exact_location_count_required', 'Commercial summary', 'Confirm the exact number of supported locations.', true);
    }
    if (commercial.monthlyTotalExGst == null) {
        add('monthly_total_required', 'Commercial summary', 'Calculate the final monthly total from confirmed quantities.', true);
    }
    if (!commercial.confirmed) {
        add('commercial_confirmation_required', 'Commercial summary', 'Confirm the quantities and commercial figures before approval.', true);
    }
    if (!commercial.termMonths) {
        add('term_not_recorded', 'Commercial summary', 'Record the proposed agreement term before issuing the final agreement.', false);
    }
    if (!commercial.plannedStart) {
        add('start_date_not_recorded', 'Commercial summary', 'Record the planned service start date when agreed.', false);
    }
    if (input.requireCurrentCommercialPolicy === true) {
        const policyStatus = assessProposalCommercialPolicy(proposal);
        if (!policyStatus.approvalAllowed) {
            add(
                'commercial_policy_migration_required',
                'Commercial policy',
                'This draft retains older or incomplete commercial-policy data. Create a new proposal under the current policy before approval.',
                true
            );
        }
    }

    return uniqueWarnings(warnings);
}

function comparePolicyFields(prefix, actual, expected, mismatchedFields) {
    Object.keys(expected).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(actual, field) || actual[field] !== expected[field]) {
            mismatchedFields.push(`${prefix}.${field}`);
        }
    });
}

function exactCountFromAnswer(answer) {
    if (!answer) return null;
    if (answer.exactValue !== '' && answer.exactValue != null && Number.isInteger(Number(answer.exactValue)) && Number(answer.exactValue) >= 0) {
        return Number(answer.exactValue);
    }
    const value = clean(answer.value);
    if (/^\d+$/.test(value)) return Number(value);
    const notes = clean(answer.notes);
    const match = notes.match(/(?:exact(?:ly)?|confirmed|currently|we have|there are)?\s*(\d{1,5})\s*(?:people|users?|staff|employees?|computers?|devices?|endpoints?|locations?|offices?|sites?)/i);
    return match ? Number(match[1]) : null;
}

function exactLocationCount(answer) {
    const exact = exactCountFromAnswer(answer);
    if (exact != null) return exact;
    const value = clean(answer && answer.value).toLowerCase();
    if (value === 'one') return 1;
    if (value === 'remote_only') return 0;
    return null;
}

function flattenProposalText(proposal) {
    return [
        proposal.title,
        proposal.executiveSummary,
        ...(proposal.objectives || []),
        ...(proposal.observations || []),
        ...(proposal.assumptions || []),
        proposal.nextStep,
        ...(proposal.recommendations || []).flatMap((item) => [item.serviceName, item.outcome, item.why, item.confirm])
    ].map(clean).filter(Boolean).join('\n');
}

function uniqueWarnings(warnings) {
    const seen = new Set();
    return warnings.filter((warning) => {
        const key = `${warning.code}:${warning.section}:${warning.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function unique(values) {
    return Array.from(new Set(values));
}

function optionalInteger(value, minimum) {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum ? number : null;
}

function money(value, fallback) {
    if (value === '' || value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? roundMoney(number) : fallback;
}

function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
}

function titleCase(value) {
    return clean(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clean(value) {
    return String(value == null ? '' : value).trim();
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

module.exports = {
    RAW_DISCOVERY_PATTERN,
    STALE_NEXT_STEP_PATTERN,
    assessProposalCommercialPolicy,
    calculateMonthlyTotal,
    createCommercialSummary,
    exactCountFromAnswer,
    normaliseCommercialSummary,
    validateProposalDraft
};
