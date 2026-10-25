'use strict';

const crypto = require('crypto');

const PROFILE_ID = 'nz-ncsc-mcss-2025-v3-sme';
const PROFILE_VERSION = '2026-08-31.1';
const EXPECTED_CATALOGUE_SHA256 = '5bdde37694c51757bbd470e44bf7fda5936f8193282228897f93a9be2db418a3';
const PROFILE_EFFECTIVE_FROM = '2025-10-30';
const CRITICAL_CONTROLS_VERIFIED_AT = '2026-08-31';

const FRAMEWORK_URL = 'https://www.ncsc.govt.nz/protect-your-organisation/ncsc-cyber-security-framework/';
const MINIMUM_STANDARDS_URL = 'https://www.ncsc.govt.nz/protect-your-organisation/minimum-standards/';
const MINIMUM_STANDARDS_PDF_URL = 'https://www.ncsc.govt.nz/assets/guidance/Documents/NCSC-Minimum-cyber-security-standards-2025-v3.pdf';
const MATURITY_MODEL_URL = 'https://www.ncsc.govt.nz/protect-your-organisation/capability-maturity-model/';
const CRITICAL_CONTROLS_URL = 'https://www.ncsc.govt.nz/protect-your-organisation/summary/';
const NCSC_REUSE_TERMS_URL = 'https://www.ncsc.govt.nz/legal-privacy-and-copyright/';

const STANDARD_URLS = Object.freeze({
    riskManagement: 'https://www.ncsc.govt.nz/protect-your-organisation/risk-management/',
    securityAwareness: 'https://www.ncsc.govt.nz/protect-your-organisation/security-awareness/',
    assetsAndImportance: 'https://www.ncsc.govt.nz/protect-your-organisation/assets-and-their-importance/',
    secureConfiguration: 'https://www.ncsc.govt.nz/protect-your-organisation/secure-configuration-of-software/',
    patching: 'https://www.ncsc.govt.nz/protect-your-organisation/patching-minimum-standards/',
    multiFactorAuthentication: 'https://www.ncsc.govt.nz/protect-your-organisation/multi-factor-authentication/',
    detectUnusualBehaviour: 'https://www.ncsc.govt.nz/protect-your-organisation/detect-unusual-behaviour/',
    leastPrivilege: 'https://www.ncsc.govt.nz/protect-your-organisation/least-privilege/',
    dataRecovery: 'https://www.ncsc.govt.nz/protect-your-organisation/data-recovery/',
    responsePlanning: 'https://www.ncsc.govt.nz/protect-your-organisation/response-planning/'
});

const FRAMEWORK_FUNCTIONS = [
    {
        id: 'guide-govern',
        order: 1,
        name: 'Guide and Govern',
        outcomeParaphrase: 'Leadership, priorities, assurance and everyday guidance make cyber security part of how the organisation operates.',
        sourceUrl: FRAMEWORK_URL
    },
    {
        id: 'identify-understand',
        order: 2,
        name: 'Identify and Understand',
        outcomeParaphrase: 'The organisation knows its important assets, information, exposures, suppliers and security responsibilities.',
        sourceUrl: FRAMEWORK_URL
    },
    {
        id: 'prevent-protect',
        order: 3,
        name: 'Prevent and Protect',
        outcomeParaphrase: 'Practical safeguards reduce real risk and protect the systems and information that matter.',
        sourceUrl: FRAMEWORK_URL
    },
    {
        id: 'detect-contain',
        order: 4,
        name: 'Detect and Contain',
        outcomeParaphrase: 'Abnormal activity can be found, investigated and contained before harm spreads.',
        sourceUrl: FRAMEWORK_URL
    },
    {
        id: 'respond-recover',
        order: 5,
        name: 'Respond and Recover',
        outcomeParaphrase: 'People know how to respond and can restore the most important services in a tested order.',
        sourceUrl: FRAMEWORK_URL
    }
];

const MINIMUM_STANDARDS = [
    standard({
        id: 'NF-NCSC-MCSS-RM-01',
        order: 1,
        key: 'risk-management',
        officialTitle: 'Risk Management',
        sourceUrl: STANDARD_URLS.riskManagement,
        frameworkFunctionId: 'guide-govern',
        prompt: 'Are cyber risks managed through a documented business risk process with tolerance, owners and regular review?',
        intent: 'Make cyber risk visible alongside other business risks and connect treatment decisions to accountable owners.',
        evidenceExamples: ['Risk framework or policy', 'Current cyber risk register', 'Risk appetite or tolerance record', 'Governance review minutes'],
        startingActions: ['Record the most important cyber risks in the business risk register with an owner, treatment and review date.']
    }),
    standard({
        id: 'NF-NCSC-MCSS-SA-01',
        order: 2,
        key: 'security-awareness',
        officialTitle: 'Security Awareness',
        sourceUrl: STANDARD_URLS.securityAwareness,
        frameworkFunctionId: 'guide-govern',
        prompt: 'Do people receive current, role-appropriate security guidance from onboarding onward, with results reported to leadership?',
        intent: 'Give people practical knowledge and a safe reporting path so routine behaviour reduces human-targeted risk.',
        evidenceExamples: ['Training programme', 'Onboarding material', 'Completion records', 'Phishing or reporting exercise results'],
        startingActions: ['Add short onboarding and recurring guidance for suspicious messages, password use, data handling and incident reporting.'],
        criticalControlKeys: ['security-awareness']
    }),
    standard({
        id: 'NF-NCSC-MCSS-AI-01',
        order: 3,
        key: 'assets-and-importance',
        officialTitle: 'Assets and their Importance',
        sourceUrl: STANDARD_URLS.assetsAndImportance,
        frameworkFunctionId: 'identify-understand',
        prompt: 'Is there a current inventory of important hardware, software, cloud services and data with owners and lifecycle status?',
        intent: 'Know what must be protected, who owns it and when it becomes unsupported or should be retired.',
        evidenceExamples: ['Hardware and software inventory', 'Cloud and SaaS register', 'Data classification record', 'End-of-support register'],
        startingActions: ['Create one list of critical and externally facing systems, their owners, suppliers, data and support dates.'],
        criticalControlKeys: ['asset-lifecycle-management']
    }),
    standard({
        id: 'NF-NCSC-MCSS-SC-01',
        order: 4,
        key: 'secure-configuration',
        officialTitle: 'Secure Configuration of Software',
        sourceUrl: STANDARD_URLS.secureConfiguration,
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Are secure configuration baselines applied to new and existing systems, with exceptions reviewed when software changes?',
        intent: 'Reduce avoidable exposure by using repeatable secure settings and keeping configuration drift visible.',
        evidenceExamples: ['Configuration baseline', 'Device or tenant policy export', 'Exception register', 'Configuration review record'],
        startingActions: ['Document a minimum configuration baseline for identity, endpoints, browsers, email and key cloud services.']
    }),
    standard({
        id: 'NF-NCSC-MCSS-PA-01',
        order: 5,
        key: 'patching',
        officialTitle: 'Patching',
        sourceUrl: STANDARD_URLS.patching,
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Are patches prioritised, sourced, tested, deployed and verified through a repeatable process that includes rollback and retirement?',
        intent: 'Keep supported software and firmware current and make every delayed or unavailable patch an explicit risk decision.',
        evidenceExamples: ['Patch policy and targets', 'Patch compliance export', 'Exception register', 'End-of-support replacement plan'],
        startingActions: ['Set patch targets by severity and record every overdue or unsupported system with an owner and treatment.'],
        criticalControlKeys: ['patch-software-systems']
    }),
    standard({
        id: 'NF-NCSC-MCSS-MF-01',
        order: 6,
        key: 'multi-factor-authentication',
        officialTitle: 'Multi-factor Authentication',
        sourceUrl: STANDARD_URLS.multiFactorAuthentication,
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Is MFA enforced for critical, internet-accessible, privileged and relevant third-party access, with failures reviewed?',
        intent: 'Reduce account takeover risk by requiring stronger authentication where stolen credentials would cause material harm.',
        evidenceExamples: ['Identity policy export', 'Privileged account list', 'MFA coverage report', 'Failed-authentication review'],
        startingActions: ['Enforce MFA for administrators, email, remote access, finance and other critical cloud services, then review exclusions.'],
        criticalControlKeys: ['mfa-and-verification']
    }),
    standard({
        id: 'NF-NCSC-MCSS-DU-01',
        order: 7,
        key: 'detect-unusual-behaviour',
        officialTitle: 'Detect Unusual Behaviour',
        sourceUrl: STANDARD_URLS.detectUnusualBehaviour,
        frameworkFunctionId: 'detect-contain',
        prompt: 'Are useful logs from critical and externally facing systems brought together, reviewed and turned into actionable alerts?',
        intent: 'Create enough visibility to recognise abnormal activity, investigate what happened and contain it quickly.',
        evidenceExamples: ['Log source inventory', 'Central logging coverage', 'Alert rules', 'Alert-to-ticket and response samples'],
        startingActions: ['Centralise identity, endpoint, email and critical-service logs and route high-risk alerts to a named response owner.'],
        criticalControlKeys: ['centralised-logging']
    }),
    standard({
        id: 'NF-NCSC-MCSS-LP-01',
        order: 8,
        key: 'least-privilege',
        officialTitle: 'Least Privilege',
        sourceUrl: STANDARD_URLS.leastPrivilege,
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Is access limited to what each person needs, with separate privileged accounts and repeatable joiner, mover, leaver and review processes?',
        intent: 'Limit accidental or malicious change and reduce how far an attacker can move after compromising an account.',
        evidenceExamples: ['Privileged account inventory', 'Access review', 'Joiner-mover-leaver records', 'Privileged activity logs'],
        startingActions: ['Remove routine local administrator access, separate admin identities and schedule regular access reviews.'],
        criticalControlKeys: ['least-privilege']
    }),
    standard({
        id: 'NF-NCSC-MCSS-DR-01',
        order: 9,
        key: 'data-recovery',
        officialTitle: 'Data Recovery',
        sourceUrl: STANDARD_URLS.dataRecovery,
        frameworkFunctionId: 'respond-recover',
        prompt: 'Are critical systems and data backed up to defined recovery requirements, with protected copies and sampled restore tests?',
        intent: 'Make recovery dependable by linking backups, supporting information, roles and tests to business recovery needs.',
        evidenceExamples: ['Backup scope and retention', 'Backup job report', 'Restore test record', 'Recovery roles and runbook'],
        startingActions: ['Confirm critical data coverage and run a sampled restore that records result, elapsed time, owner and follow-up.'],
        criticalControlKeys: ['tested-backups']
    }),
    standard({
        id: 'NF-NCSC-MCSS-RP-01',
        order: 10,
        key: 'response-planning',
        officialTitle: 'Response Planning',
        sourceUrl: STANDARD_URLS.responsePlanning,
        frameworkFunctionId: 'respond-recover',
        prompt: 'Is there a risk-based incident response plan with named responsibilities, management support, contact paths and lessons from exercises or incidents?',
        intent: 'Reduce confusion and delay by preparing a flexible first response and practising it before a serious event.',
        evidenceExamples: ['Incident response plan', 'Contact and escalation list', 'Tabletop record', 'Post-incident actions'],
        startingActions: ['Create a one-page first-hour guide and run a short tabletop for a likely email, account or ransomware incident.']
    })
];

const CRITICAL_CONTROL_EXTENSIONS = [
    extension({
        id: 'NF-NCSC-CC-PM-01',
        order: 11,
        key: 'password-manager',
        officialTitle: 'Provide and use a password manager',
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Does the organisation provide and govern a password manager that people actually use for unique passwords and approved sharing?',
        intent: 'Make strong, unique credentials and controlled sharing easier than password reuse or informal storage.',
        evidenceExamples: ['Approved password manager', 'User coverage', 'Sharing policy', 'Shared credential migration record'],
        startingActions: ['Select an organisation-managed password manager and migrate shared, privileged and high-value credentials first.'],
        criticalControlKeys: ['password-manager']
    }),
    extension({
        id: 'NF-NCSC-CC-SV-01',
        order: 12,
        key: 'sensitive-request-verification',
        officialTitle: 'Implement multi-factor authentication and verification',
        displayTitle: 'No Fries sensitive-request verification check',
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Do payment, credential, account-recovery and sensitive-data changes require a trusted verification step outside the original request?',
        intent: 'Stop stolen accounts, impersonation and social engineering from turning a message or helpdesk request into a high-impact change.',
        evidenceExamples: ['Payment-change procedure', 'Helpdesk identity check', 'Out-of-band approval record', 'Exception or fraud test'],
        startingActions: ['Require out-of-band verification for payment-detail, password-reset, MFA-reset and sensitive-data requests.'],
        criticalControlKeys: ['mfa-and-verification']
    }),
    extension({
        id: 'NF-NCSC-CC-AC-01',
        order: 13,
        key: 'application-control',
        officialTitle: 'Implement application control',
        frameworkFunctionId: 'prevent-protect',
        prompt: 'Are unapproved or risky applications, scripts, macros and file types restricted on systems where they could cause material harm?',
        intent: 'Reduce malware and ransomware execution by controlling what can run, starting with high-impact users and systems.',
        evidenceExamples: ['Application control policy', 'Endpoint policy export', 'Pilot results', 'Blocked application events'],
        startingActions: ['Pilot monitored application control on finance, administrator and executive devices before wider enforcement.'],
        criticalControlKeys: ['application-control']
    }),
    extension({
        id: 'NF-NCSC-CC-NS-01',
        order: 14,
        key: 'network-separation-segmentation',
        officialTitle: 'Implement network segmentation and separation',
        frameworkFunctionId: 'detect-contain',
        prompt: 'Are users, guests, administration, backups and important services separated so one compromise cannot freely spread?',
        intent: 'Limit attacker movement and make sensitive systems easier to monitor, isolate and protect.',
        evidenceExamples: ['Network and trust diagram', 'Firewall or access policy', 'Segmentation test', 'Remote administration path'],
        startingActions: ['Separate guest, user, administration, backup and critical-service access and test the intended boundaries.'],
        criticalControlKeys: ['network-separation-segmentation']
    })
];

const CRITICAL_CONTROLS = [
    criticalControl('patch-software-systems', 1, 'Patch your software and systems', 'https://www.ncsc.govt.nz/protect-your-organisation/patching/', ['NF-NCSC-MCSS-PA-01']),
    criticalControl('mfa-and-verification', 2, 'Implement multi-factor authentication and verification', 'https://www.ncsc.govt.nz/protect-your-organisation/multi-factor-authentication-and-verification/', ['NF-NCSC-MCSS-MF-01', 'NF-NCSC-CC-SV-01']),
    criticalControl('password-manager', 3, 'Provide and use a password manager', CRITICAL_CONTROLS_URL, ['NF-NCSC-CC-PM-01']),
    criticalControl('centralised-logging', 4, 'Centralised logging', CRITICAL_CONTROLS_URL, ['NF-NCSC-MCSS-DU-01']),
    criticalControl('security-awareness', 5, 'Build security awareness in your organisation', 'https://www.ncsc.govt.nz/protect-your-organisation/build-security-awareness-in-your-organisation/', ['NF-NCSC-MCSS-SA-01']),
    criticalControl('asset-lifecycle-management', 6, 'Asset lifecycle management', 'https://www.ncsc.govt.nz/protect-your-organisation/asset-lifecycle-management/', ['NF-NCSC-MCSS-AI-01']),
    criticalControl('tested-backups', 7, 'Implement and test backups', CRITICAL_CONTROLS_URL, ['NF-NCSC-MCSS-DR-01']),
    criticalControl('application-control', 8, 'Implement application control', 'https://www.ncsc.govt.nz/protect-your-organisation/application-control/', ['NF-NCSC-CC-AC-01']),
    criticalControl('least-privilege', 9, 'Enforce the principle of least privilege', 'https://www.ncsc.govt.nz/protect-your-organisation/principle-of-least-privilege/', ['NF-NCSC-MCSS-LP-01']),
    criticalControl('network-separation-segmentation', 10, 'Implement network segmentation and separation', 'https://www.ncsc.govt.nz/protect-your-organisation/network-separation-and-segmentation/', ['NF-NCSC-CC-NS-01'])
];

const PROFILE_BODY = {
    schemaVersion: 1,
    profileId: PROFILE_ID,
    profileVersion: PROFILE_VERSION,
    title: 'NCSC-aligned foundational cyber-security gap screen',
    effectiveFrom: PROFILE_EFFECTIVE_FROM,
    lastVerifiedAt: CRITICAL_CONTROLS_VERIFIED_AT,
    audience: 'New Zealand small and medium-sized organisations',
    attribution: 'Adapted by No Fries from the New Zealand National Cyber Security Centre Cyber Security Framework, Minimum Cyber Security Standards and Critical Controls.',
    identifierNote: 'Identifiers beginning NF-NCSC are issued by No Fries for traceability; they are not NCSC-issued control identifiers.',
    mappingNote: 'Framework-function assignments for extension checks and cross-references between Minimum Standard domains and Critical Controls are No Fries interpretations.',
    sourceScopeStatement: 'The NCSC Minimum Cyber Security Standards apply to business-critical and externally facing systems where applicable; each No Fries screen must explain how its scope adapts that boundary.',
    basisStatement: 'High-level No Fries domain screening informed by the NCSC Minimum Cyber Security Standards 2025 v3, adapted for SME use, with a date-stamped Critical Controls cross-reference snapshot verified 31 August 2026.',
    claimStatement: 'This screen does not assess every Minimum Standard requirement or establish CS-CMM conformance. It is not an NCSC certification, endorsement, official NCSC score, compliance determination or prediction of breach likelihood.',
    sources: {
        framework: {
            title: 'NCSC Cyber Security Framework',
            status: 'beta',
            sourceUrl: FRAMEWORK_URL,
            licence: 'CC BY 4.0',
            licenceUrl: NCSC_REUSE_TERMS_URL,
            attributionRequired: true
        },
        minimumStandards: {
            title: 'Minimum Cyber Security Standards 2025 v3',
            publishedAt: '2025-10-30',
            sourceUrl: MINIMUM_STANDARDS_URL,
            pdfUrl: MINIMUM_STANDARDS_PDF_URL,
            maturityModelUrl: MATURITY_MODEL_URL,
            adoptionNote: 'Designed for GCISO-mandated agencies; non-mandated organisations may adopt the guidance.'
        },
        criticalControls: {
            title: 'NCSC Critical Controls snapshot',
            sourceUrl: CRITICAL_CONTROLS_URL,
            lastVerifiedAt: CRITICAL_CONTROLS_VERIFIED_AT,
            reviewDueAt: '2027-08-31',
            reviewCadence: 'at_least_annually'
        }
    },
    maturityModel: {
        model: 'NCSC CS-CMM',
        sourceUrl: MATURITY_MODEL_URL,
        minimumStandardsPlanningLevel: 2,
        assessmentSupport: 'reference_only',
        planningNote: 'Level 2 is the official minimum for mandated agencies. This high-level screen does not determine CS-CMM attainment; a future requirement-level assessment is needed for that.',
        levels: [
            { level: 1, key: 'informal', name: 'Informal' },
            { level: 2, key: 'planned-tracked', name: 'Planned & Tracked' },
            { level: 3, key: 'standardised', name: 'Standardised' },
            { level: 4, key: 'quantitatively-controlled', name: 'Quantitatively Controlled' }
        ]
    },
    responseModel: {
        ncscSelfAssessmentResponseLabels: ['yes', 'partial', 'no'],
        noFriesExtensions: ['unknown', 'not_applicable'],
        adaptationNote: 'Responses apply to concise No Fries domain-screening prompts, not to every requirement in the NCSC self-assessment questionnaire.',
        noFriesImplementationWeights: { yes: 1, partial: 0.5, no: 0, unknown: 0 },
        planningConventionNote: 'The 0.5 value for Partial is a No Fries planning convention, not an NCSC weight.',
        evidenceAssurance: ['customer_asserted', 'not_provided'],
        formula: 'No Fries implementation-progress range: lower = (yes + 0.5 × partial) ÷ applicable items; upper = (yes + 0.5 × partial + unknown) ÷ applicable items. Missing is treated as unknown, and justified not-applicable is excluded.'
    },
    limitations: [
        'The Framework is beta and its five functions do not yet provide a final official measurement method.',
        'The Minimum Standards cover foundational practices, not the complete cyber-security spectrum.',
        'The Minimum Standards are adapted here for SME use and are not mandatory across the New Zealand economy.',
        'This high-level domain screen does not test each cumulative Minimum Standard requirement and does not determine a CS-CMM level.',
        'The Critical Controls list can change and must be reverified at least annually.'
    ],
    frameworkFunctions: FRAMEWORK_FUNCTIONS,
    minimumStandards: MINIMUM_STANDARDS,
    criticalControls: CRITICAL_CONTROLS,
    assessmentItems: [...MINIMUM_STANDARDS, ...CRITICAL_CONTROL_EXTENSIONS]
};

const calculatedCatalogueSha256 = calculateCatalogueSha256(PROFILE_BODY);
if (calculatedCatalogueSha256 !== EXPECTED_CATALOGUE_SHA256) {
    throw new Error('NCSC gap catalogue changed without an explicit profile version and digest update');
}
const PROFILE = deepFreeze(Object.assign({}, PROFILE_BODY, {
    catalogueSha256: EXPECTED_CATALOGUE_SHA256
}));

function standard(definition) {
    return Object.assign({
        itemType: 'minimum_standard',
        sourceKind: 'ncsc_minimum_standard_adaptation',
        assessmentMode: 'high_level_domain_screen',
        sourceTitle: 'Minimum Cyber Security Standards 2025 v3',
        sourceVersion: '2025-v3',
        sourcePublishedAt: '2025-10-30',
        sourceUrl: MINIMUM_STANDARDS_URL,
        defaultTargetMaturityLevel: null,
        criticalControlKeys: []
    }, definition);
}

function extension(definition) {
    const extensionItem = Object.assign({
        itemType: 'critical_control_extension',
        sourceKind: 'no_fries_sme_extension',
        assessmentMode: 'implementation',
        sourceTitle: 'NCSC Critical Controls: Summary',
        sourceVersion: `verified-${CRITICAL_CONTROLS_VERIFIED_AT}`,
        sourcePublishedAt: '',
        sourceUrl: CRITICAL_CONTROLS_URL,
        defaultTargetMaturityLevel: null,
        criticalControlKeys: []
    }, definition);
    extensionItem.displayTitle = extensionItem.displayTitle || extensionItem.officialTitle;
    return extensionItem;
}

function criticalControl(key, order, officialTitle, guidanceUrl, assessmentItemIds) {
    return {
        key,
        sourceDisplayOrder: order,
        officialTitle,
        sourceUrl: CRITICAL_CONTROLS_URL,
        guidanceUrl,
        lastVerifiedAt: CRITICAL_CONTROLS_VERIFIED_AT,
        assessmentItemIds
    };
}

function getNcscGapProfile() {
    return clone(PROFILE);
}

function calculateCatalogueSha256(profile) {
    const payload = clone(profile || PROFILE_BODY);
    delete payload.catalogueSha256;
    return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}

module.exports = {
    CRITICAL_CONTROLS_VERIFIED_AT,
    EXPECTED_CATALOGUE_SHA256,
    PROFILE_ID,
    PROFILE_VERSION,
    calculateCatalogueSha256,
    getNcscGapProfile
};
