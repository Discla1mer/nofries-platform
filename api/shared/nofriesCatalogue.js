const CATALOGUE_VERSION_ID = 'catalogue_nofries_msp_2026_08_23_v4';
const LEGACY_CATALOGUE_VERSION_IDS = new Set([
    'catalogue_nofries_msp_2026_08_16',
    'catalogue_nofries_msp_2026_08_18_v2',
    'catalogue_nofries_msp_2026_08_19_v3'
]);
const CATALOGUE_SOURCE = 'No Fries Managed IT service guide — 23 August 2026';
const PUBLISHED_AT = '2026-08-23T09:00:00.000Z';

const DEFINITIONS = [
    {
        key: 'managed-it-core',
        name: 'No Fries Managed IT',
        category: 'Managed IT',
        outcome: 'One accountable No Fries Managed IT service for day-to-day support, device care, business-app administration, supplier follow-up and Proof every month.',
        ideal: 'Small and mid-sized organisations that want straightforward remote support without the cost and complexity of a large provider.',
        gaps: ['Slow or inconsistent IT support', 'Unclear ownership', 'Multiple suppliers without one accountable operator'],
        prerequisites: ['Confirm people, devices, locations, important applications, the main business platform and the current support model.'],
        disqualifiers: ['A requirement for unlimited 24/7 staffed user support or specialist industrial technology support as part of the standard monthly service.'],
        questions: ['How many people and work computers need support?', 'What is not working well with the current IT support model?'],
        evidence: ['Confirmed user and device counts', 'Current provider and supplier list', 'Agreed service limits'],
        related: ['ai-service-desk', 'datto-rmm', 'microsoft-365-admin', 'google-workspace-admin', 'endpoint-security', 'endpoint-backup', 'monthly-proof'],
        strong: [
            { questionId: 'business.concerns', values: ['slow_support', 'recurring_issues', 'no_ownership', 'provider_cost', 'capacity'] },
            { questionId: 'priorities.procurement', values: ['active', 'budgeted'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['reliable_support', 'ownership', 'security', 'resilience', 'cost', 'growth'] }
        ],
        disqualifierRules: [
            { questionId: 'support.hours', values: ['24x7'] },
            { questionId: 'support.delivery', values: ['onsite_heavy'] }
        ]
    },
    {
        key: 'ai-service-desk',
        name: 'Phone, chat and email support',
        category: 'Everyday support',
        outcome: 'Requests are recorded, handled, approved where needed and closed only after the result is checked and confirmed.',
        ideal: 'Organisations that want responsive support without the cost of a large staffed service desk.',
        gaps: ['Slow request logging', 'Poor follow-through', 'Repeated common support work'],
        prerequisites: ['Confirm authorised callers, support channels, identity checks, approval rules, call privacy settings and after-hours contacts.'],
        disqualifiers: ['The standard service is not an emergency service and does not replace separately contracted 24/7 staffed user support.'],
        questions: ['How should users contact support?', 'Which common changes need customer approval?'],
        evidence: ['Caller and requester verification rules', 'Approved support steps and action types', 'Service history', 'Confirmed closure and hand-off records'],
        related: ['managed-it-core', 'datto-rmm', 'supplier-coordination', 'monthly-proof'],
        strong: [
            { questionId: 'support.frustrations', values: ['slow_response', 'poor_follow_through', 'recurring'] },
            { questionId: 'business.concerns', values: ['slow_support', 'recurring_issues', 'no_ownership', 'capacity'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['reliable_support', 'ownership', 'cost'] },
            { questionId: 'support.delivery', values: ['remote_first', 'mixed'] }
        ]
    },
    {
        key: 'datto-rmm',
        name: 'Managed device care',
        category: 'Device care',
        outcome: 'A clear device list, regular health checks and updates, remote support and approved repeatable fixes for covered computers.',
        ideal: 'Organisations that need consistent care for company computers and dependable remote support.',
        gaps: ['No reliable device list', 'Inconsistent updates', 'Slow or manual remote support'],
        prerequisites: ['Confirm supported operating systems, approximate device count and any unsupported or specialist devices.'],
        disqualifiers: ['Unsupported legacy or specialist devices that cannot be safely managed through the standard tooling.'],
        questions: ['How many computers and supported servers need care?', 'Are devices company-owned or mixed with personal devices?'],
        evidence: ['Device list', 'Update status', 'Device-care coverage'],
        related: ['managed-it-core', 'ai-service-desk', 'endpoint-security', 'endpoint-backup'],
        strong: [
            { questionId: 'support.frustrations', values: ['recurring', 'slow_response', 'poor_follow_through'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['reliable_support', 'ownership', 'cost'] },
            { questionId: 'estate.endpoints', values: ['under_10', '10_24', '25_49', '50_99', '100_249', '250_plus'] }
        ]
    },
    {
        key: 'microsoft-365-admin',
        name: 'Microsoft 365 support',
        category: 'Business apps',
        outcome: 'Day-to-day Microsoft 365 help for users, sign-in protection, licences, groups and staff joining, moving or leaving.',
        ideal: 'Microsoft 365 organisations that want day-to-day administration included with No Fries Managed IT.',
        gaps: ['Manual user administration', 'Inconsistent access changes', 'No clear owner for Microsoft 365 operational tasks'],
        prerequisites: ['Confirm the Microsoft account, administrator access and licence responsibilities during set-up.'],
        disqualifiers: ['Major Microsoft 365 migrations or redesigns are separately quoted work rather than routine monthly support.'],
        questions: ['Is Microsoft 365 the main productivity platform?', 'Who currently performs user and access administration?'],
        evidence: ['Business account and administrator list', 'Sign-in protection status', 'Staff-change service check'],
        related: ['managed-it-core', 'ai-service-desk', 'endpoint-security', 'monthly-proof'],
        strong: [
            { questionId: 'productivity.platform', values: ['microsoft_365'] }
        ],
        potential: [
            { questionId: 'productivity.platform', values: ['mixed'] }
        ]
    },
    {
        key: 'google-workspace-admin',
        name: 'Google Workspace support',
        category: 'Business apps',
        outcome: 'Day-to-day Google Workspace help for users, sign-in protection, licences, groups and staff joining, moving or leaving.',
        ideal: 'Google Workspace organisations that want day-to-day administration included with No Fries Managed IT.',
        gaps: ['Manual user administration', 'Inconsistent access changes', 'No clear owner for Google Workspace operational tasks'],
        prerequisites: ['Confirm the Google Workspace account, delegated administrator access and licence responsibilities during set-up.'],
        disqualifiers: ['Major Google Workspace migrations, application engineering or redesigns are separately quoted work.'],
        questions: ['Is Google Workspace the main productivity platform?', 'Who currently performs user and access administration?'],
        evidence: ['Business account and administrator list', 'Two-step verification status', 'Staff-change service check'],
        related: ['managed-it-core', 'ai-service-desk', 'endpoint-security', 'monthly-proof'],
        strong: [
            { questionId: 'productivity.platform', values: ['google_workspace'] }
        ],
        potential: [
            { questionId: 'productivity.platform', values: ['mixed'] }
        ]
    },
    {
        key: 'endpoint-security',
        name: 'Threat protection and after-hours security help',
        category: 'Protection',
        outcome: 'The agreed threat protection, alert review and urgent protective action for covered devices, with serious events passed to the right contacts.',
        ideal: 'Organisations without consistent device protection or dependable after-hours security help.',
        gaps: ['No consistent device protection', 'Business-hours-only security response', 'Unclear after-hours contact process'],
        prerequisites: ['Confirm covered devices, the selected protection plan, compatibility, approval rules and after-hours contacts.'],
        disqualifiers: ['Specialist security monitoring, digital forensics or industrial technology requirements need a separate security service.'],
        questions: ['Which threat-protection service is in use today?', 'What happens when a serious alert appears after hours?'],
        evidence: ['Selected protection services', 'Covered-device protection status', 'After-hours contacts', 'Approved protective actions'],
        related: ['managed-it-core', 'datto-rmm', 'ai-service-desk', 'monthly-proof'],
        strong: [
            { questionId: 'security.monitoring', values: ['absent', 'business_hours'] },
            { questionId: 'security.endpoint', values: ['absent', 'partial'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['security'] },
            { questionId: 'business.concerns', values: ['cyber_risk'] }
        ]
    },
    {
        key: 'endpoint-backup',
        name: 'Work-file backup and recovery',
        category: 'Resilience',
        outcome: 'Agreed work files on covered devices are backed up, checked and available for supported restore requests when backup is listed in the customer schedule.',
        ideal: 'Organisations that need a simple managed work-file recovery service alongside No Fries Managed IT.',
        gaps: ['Unverified device backups', 'No practical restore process', 'Important local work files not covered'],
        prerequisites: ['Confirm the selected backup service, covered work files, file-selection rules, retention and what is already protected elsewhere.'],
        disqualifiers: ['Complex server, application or large-scale disaster recovery requirements need separate design and pricing.'],
        questions: ['What important data is held on endpoints?', 'When was a restore last tested?'],
        evidence: ['Selected backup service', 'Backup coverage', 'Backup status', 'Restore test result'],
        related: ['managed-it-core', 'datto-rmm', 'monthly-proof'],
        strong: [
            { questionId: 'resilience.backups', values: ['absent', 'untested', 'partial'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['resilience'] },
            { questionId: 'business.concerns', values: ['backup_risk'] }
        ]
    },
    {
        key: 'supplier-coordination',
        name: 'Supplier follow-up',
        category: 'Everyday support',
        outcome: 'No Fries owns the support path when an internet provider, software company, hardware supplier or other agreed third party needs to be involved.',
        ideal: 'Organisations that lose time coordinating several technology suppliers when something goes wrong.',
        gaps: ['No single owner across suppliers', 'Repeated hand-offs between providers', 'Unclear supplier contacts'],
        prerequisites: ['Record the agreed supplier list and support contacts during set-up.'],
        disqualifiers: ['Commercial buying, major network redesign and project delivery are quoted separately.'],
        questions: ['Which suppliers are critical to day-to-day operations?', 'Which support problems commonly bounce between suppliers?'],
        evidence: ['Supplier list', 'Support contacts', 'Service history'],
        related: ['managed-it-core', 'ai-service-desk', 'monthly-proof'],
        strong: [
            { questionId: 'operations.ownership', values: ['mixed', 'fragmented'] },
            { questionId: 'support.frustrations', values: ['supplier_bounce'] }
        ],
        potential: [
            { questionId: 'operations.suppliers', values: ['one_two', 'three_plus'] }
        ]
    },
    {
        key: 'monthly-proof',
        name: 'Proof every month',
        category: 'Reporting and advice',
        outcome: 'A clear monthly record of what is covered, device health, protection, backup, support activity, open issues and named next actions.',
        ideal: 'Organisations that want practical proof of what No Fries Managed IT is doing and what should improve next.',
        gaps: ['Little visibility of provider activity', 'No practical improvement plan', 'Repeat issues are not turned into lasting fixes'],
        prerequisites: ['Agree what is included and the service information available during set-up.'],
        disqualifiers: [],
        questions: ['What should leadership be able to see each month?', 'Which recurring IT issues should be tracked to permanent resolution?'],
        evidence: ['Coverage measures', 'Request and alert records', 'Open issues with owners and due dates'],
        related: ['managed-it-core', 'ai-service-desk', 'datto-rmm', 'endpoint-security', 'endpoint-backup'],
        strong: [
            { questionId: 'support.frustrations', values: ['visibility', 'recurring'] }
        ],
        potential: [
            { questionId: 'business.priorities', values: ['cost', 'security', 'resilience', 'ownership'] }
        ]
    },
    {
        key: 'customer-onboarding',
        name: 'Getting started with No Fries Managed IT',
        category: 'Set-up',
        outcome: 'A careful move from the agreed service into supported people, covered devices, support channels and a recorded starting position.',
        ideal: 'A prospect that has agreed the No Fries service and is ready to get started.',
        gaps: ['No reliable starting inventory', 'Unknown administrative access', 'Unclear handover from an incumbent provider'],
        prerequisites: ['Signed agreement, confirmed customer contacts, users, devices, locations, administrator access and the current provider hand-over plan.'],
        disqualifiers: ['Do not begin live set-up until the final agreement and required access approvals are complete.'],
        questions: ['Who can approve access and software deployment?', 'Is an incumbent provider handover required?'],
        evidence: ['Signed service schedule', 'Set-up checklist', 'Typical-device test results', 'Support-channel and service checks'],
        related: ['managed-it-core', 'ai-service-desk', 'datto-rmm', 'microsoft-365-admin', 'google-workspace-admin', 'endpoint-security', 'endpoint-backup'],
        strong: [
            { questionId: 'priorities.procurement', values: ['active', 'budgeted'] },
            { questionId: 'priorities.next_step', values: ['proposal', 'technical_validation'] }
        ],
        potential: [
            { questionId: 'operations.incumbent_handover', values: ['yes'] }
        ]
    }
];

function createService(definition) {
    return {
        id: `service_${definition.key.replace(/[^a-z0-9]+/g, '_')}`,
        key: definition.key,
        name: definition.name,
        category: definition.category,
        customerOutcome: definition.outcome,
        idealCustomer: definition.ideal || '',
        gapIndicators: definition.gaps || [],
        prerequisites: definition.prerequisites || [],
        disqualifiers: definition.disqualifiers || [],
        discoveryQuestions: definition.questions || [],
        evidenceRequired: definition.evidence || [],
        relatedServices: definition.related || [],
        salesOwner: '',
        sourceDocuments: [CATALOGUE_SOURCE],
        classification: 'internal',
        rules: {
            strong: definition.strong || [],
            potential: definition.potential || [],
            prerequisites: definition.prerequisiteRules || [],
            disqualifiers: definition.disqualifierRules || []
        }
    };
}

const NOFRIES_SERVICES = DEFINITIONS.map(createService);

function createNoFriesCatalogueState() {
    const services = clone(NOFRIES_SERVICES);
    return {
        publishedVersionId: CATALOGUE_VERSION_ID,
        versions: [createPublishedVersion(services, 4)]
    };
}

function upgradeNoFriesCatalogueState(existingCatalogue) {
    const source = existingCatalogue && typeof existingCatalogue === 'object'
        ? clone(existingCatalogue)
        : null;
    if (!source || !Array.isArray(source.versions) || !source.versions.length) {
        return createNoFriesCatalogueState();
    }
    if (source.versions.some((version) => version && version.id === CATALOGUE_VERSION_ID)) {
        return source;
    }
    if (!LEGACY_CATALOGUE_VERSION_IDS.has(String(source.publishedVersionId || ''))) {
        return source;
    }

    const versions = source.versions.map((version) => {
        if (!version || version.id !== source.publishedVersionId) return version;
        return Object.assign({}, version, { status: 'superseded' });
    });
    const highestVersion = versions.reduce((highest, version) => (
        Math.max(highest, Number(version && version.versionNumber || 0))
    ), 1);
    versions.push(createPublishedVersion(clone(NOFRIES_SERVICES), Math.max(4, highestVersion + 1)));
    return {
        publishedVersionId: CATALOGUE_VERSION_ID,
        versions
    };
}

function createPublishedVersion(services, versionNumber) {
    return {
        id: CATALOGUE_VERSION_ID,
        versionNumber,
        label: 'No Fries Managed IT catalogue — 23 August 2026',
        status: 'published',
        serviceCount: services.length,
        services,
        warnings: [],
        importedBy: 'system:catalogue-seed',
        importedAt: PUBLISHED_AT,
        publishedBy: 'system:catalogue-seed',
        publishedAt: PUBLISHED_AT
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = {
    CATALOGUE_VERSION_ID,
    NOFRIES_SERVICE_COUNT: NOFRIES_SERVICES.length,
    createNoFriesCatalogueState,
    upgradeNoFriesCatalogueState
};
