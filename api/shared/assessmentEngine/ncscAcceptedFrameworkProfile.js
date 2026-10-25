'use strict';

const crypto = require('crypto');
const {
    NCSC_FRAMEWORK_ID,
    createNcscFrameworkProfile
} = require('./ncscFrameworkProfile');
const {
    calculateFrameworkProfileSha256,
    publishFrameworkProfile
} = require('./frameworkProfileRegistry');

const ACCEPTED_NCSC_FRAMEWORK_VERSION = 'beta-verified-2026-09-02';
const ACCEPTED_NCSC_PROFILE_VERSION = '2026-09-02.1';
const ACCEPTED_NCSC_SPEC_DOCUMENT_ID = '1mENSf3FLcNYBwDLl0TUHbtyGrlsZBFYws8szRau1EM8';
const ACCEPTED_NCSC_SPEC_REVISION = 'AIroW36A7NZjeAcTpzgJzaCGH_1TZQXgIYuz3vPdm46LMwdWtBXUwMGQAPGzbAHBSdOReRWSdFXgScIhZN9aMiOtgfmvjftIS51M3Uns9q7e';
const MINIMUM_STANDARDS_PDF_SHA256 = '11035e195bfd2bc3d51e87df5e036acc02feafd4e6dc2f8659c840bb0b07712c';
const EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256 = '26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee';
const EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256 = '32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375';

const VERIFIED_AT = '2026-09-02';
const CC_BY_4 = 'CC BY 4.0';
const CC_BY_4_URL = 'https://creativecommons.org/licenses/by/4.0/';
const NCSC_ROOT = 'https://www.ncsc.govt.nz/protect-your-organisation/';

const ATTRIBUTION = 'Adapted by No Fries Limited from the NCSC Cyber Security Framework and Minimum Cyber Security Standards 2025, © Crown copyright, GCSB on behalf of the Crown, licensed under CC BY 4.0. Changes were made for New Zealand SMEs. No NCSC endorsement is implied.';

const GUIDANCE_URL_BY_REFERENCE_ID = Object.freeze({
    'patch-software-systems': `${NCSC_ROOT}patching/`,
    'mfa-and-verification': `${NCSC_ROOT}multi-factor-authentication-and-verification/`,
    'password-manager': `${NCSC_ROOT}password-managers/`,
    'centralised-logging': `${NCSC_ROOT}centralised-logging/`,
    'security-awareness': `${NCSC_ROOT}build-security-awareness-in-your-organisation/`,
    'asset-lifecycle-management': `${NCSC_ROOT}asset-lifecycle-management/`,
    'tested-backups': `${NCSC_ROOT}implement-and-test-backups/`,
    'application-control': `${NCSC_ROOT}application-control/`,
    'least-privilege': `${NCSC_ROOT}principle-of-least-privilege/`,
    'network-separation-segmentation': `${NCSC_ROOT}network-separation-and-segmentation/`
});

const EXTENSION_TITLE_BY_CONTROL_ID = Object.freeze({
    'NF-NCSC-CC-PM-01': 'No Fries Critical Control extension — Provide and use a password manager',
    'NF-NCSC-CC-SV-01': 'No Fries Critical Control extension — Sensitive-request verification check',
    'NF-NCSC-CC-AC-01': 'No Fries Critical Control extension — Implement application control',
    'NF-NCSC-CC-NS-01': 'No Fries Critical Control extension — Implement network segmentation and separation'
});

const REQUIRED_LIMITATIONS = Object.freeze([
    'The profile date 2025-10-30 is the official Minimum Cyber Security Standards 2025 v3 publication-date pin; NCSC did not assert it as an effective date.',
    'NF-NCSC identifiers, questions, function assignments, crosswalks, evidence examples, starting actions, response weights and roadmap order are No Fries interpretations.',
    'The profile is a concise domain-level implementation assessment and does not test every cumulative Minimum Standard requirement.',
    'The profile does not establish Cyber Security Capability Maturity Model attainment.',
    'The profile is not NCSC certification, NCSC endorsement, an official NCSC score, a compliance determination, a formal risk score or a prediction of breach likelihood.',
    'NCSC Crown material reuse requires attribution, a licence link and an indication that changes were made; source-specific terms prevail whenever a source states otherwise.',
    'The NCSC site licence does not automatically cover logos, emblems, trademarks, site design, photography or imagery; those assets are not included.',
    'Third-party material is not licensed by NCSC and requires permission from the relevant owner; no third-party material is included.',
    'Paid or customer-facing release requires a separate legal review of the exact publication and every positively reused source.',
    'Unversioned NCSC pages can change without notice and must be reverified on the recorded review schedule.',
    'Every assessment must state its systems and services in scope, especially business-critical and externally facing systems.'
]);

class NcscFrameworkProfileImportError extends Error {
    constructor(code) {
        super(`NCSC framework profile import failed (${code})`);
        this.name = 'NcscFrameworkProfileImportError';
        this.code = code;
    }
}

function createAcceptedNcscFrameworkProfile() {
    const definition = buildAcceptedNcscFrameworkProfileDefinition();
    const sourceDigest = digest(buildAcceptedSourceSeed(definition));
    assertPinnedDigest(
        EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256,
        sourceDigest,
        'accepted_source_digest_mismatch'
    );
    definition.sourceCatalogueSha256 = sourceDigest;

    const profileDigest = calculateFrameworkProfileSha256(definition);
    assertPinnedDigest(
        EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256,
        profileDigest,
        'accepted_profile_digest_mismatch'
    );
    definition.catalogueSha256 = profileDigest;

    return publishFrameworkProfile(definition);
}

function importAcceptedNcscFrameworkProfile(definitions = []) {
    if (!Array.isArray(definitions)) {
        throw new NcscFrameworkProfileImportError('definition_list_required');
    }

    const published = definitions.map((definition) => publishFrameworkProfile(definition));
    const accepted = createAcceptedNcscFrameworkProfile();
    const sameTuple = published.filter((definition) => (
        definition.profile.id === accepted.profile.id
        && definition.profile.version === accepted.profile.version
    ));

    if (sameTuple.length > 1) {
        throw new NcscFrameworkProfileImportError('duplicate_accepted_profile');
    }
    if (sameTuple.length === 1) {
        if (sameTuple[0].catalogueSha256 !== accepted.catalogueSha256) {
            throw new NcscFrameworkProfileImportError('accepted_profile_conflict');
        }
        return Object.freeze([...published]);
    }
    return Object.freeze([...published, accepted]);
}

function buildAcceptedNcscFrameworkProfileDefinition() {
    const definition = clone(createNcscFrameworkProfile());
    delete definition.catalogueSha256;
    delete definition.sourceCatalogueSha256;

    definition.publishedAt = VERIFIED_AT;
    definition.framework.version = ACCEPTED_NCSC_FRAMEWORK_VERSION;
    definition.framework.description = 'Five NCSC cyber-security outcome functions adapted into a version-pinned No Fries implementation assessment.';
    definition.framework.sourceIds = ['ncsc-framework', 'ncsc-reuse-terms'];

    definition.profile.version = ACCEPTED_NCSC_PROFILE_VERSION;
    definition.profile.description = 'A version-pinned implementation assessment for New Zealand small and medium-sized organisations. The recorded date is the Minimum Cyber Security Standards 2025 v3 publication date, not an NCSC-asserted effective date.';
    definition.profile.sourceIds = [
        'ncsc-framework',
        'ncsc-minimum-standards-2025-v3',
        'ncsc-minimum-standards-pdf-2025-v3',
        'ncsc-critical-controls-2026-08-31',
        'ncsc-capability-maturity-model',
        'ncsc-reuse-terms'
    ];

    definition.statements = {
        attribution: ATTRIBUTION,
        basis: 'No Fries adaptation of the NCSC Cyber Security Framework, Minimum Cyber Security Standards 2025 v3 and a Critical Controls snapshot verified 2026-08-31, under the Accepted NCSC-001 specification.',
        claim: 'A deterministic No Fries implementation assessment aligned to recorded NCSC sources; it makes no certification, endorsement, compliance, formal-risk or maturity-attainment claim.',
        limitations: [...REQUIRED_LIMITATIONS]
    };

    definition.sources.forEach((source) => {
        if (source.id === 'ncsc-framework') {
            source.rightsStatus = 'verified';
            source.licence = CC_BY_4;
            source.licenceUrl = CC_BY_4_URL;
        } else {
            source.rightsStatus = 'review_required';
            delete source.licence;
            delete source.licenceUrl;
        }
        if (source.id !== 'ncsc-critical-controls-2026-08-31') {
            source.lastVerifiedAt = VERIFIED_AT;
        }
        if (source.id === 'ncsc-framework') {
            source.version = ACCEPTED_NCSC_FRAMEWORK_VERSION;
        }
        if (source.id.startsWith('ncsc-critical-control-')) {
            const referenceId = source.id.slice('ncsc-critical-control-'.length);
            const guidanceUrl = GUIDANCE_URL_BY_REFERENCE_ID[referenceId];
            if (!guidanceUrl) {
                throw new NcscFrameworkProfileImportError('unknown_critical_control_guidance');
            }
            source.url = guidanceUrl;
            source.version = `verified-${VERIFIED_AT}`;
        }
    });

    definition.sources.push(
        acceptedSource({
            id: 'ncsc-minimum-standards-pdf-2025-v3',
            title: 'Minimum Cyber Security Standards 2025 v3 PDF',
            url: 'https://www.ncsc.govt.nz/assets/guidance/Documents/NCSC-Minimum-cyber-security-standards-2025-v3.pdf',
            version: '2025-v3',
            publishedAt: '2025-10-30'
        }),
        acceptedSource({
            id: 'ncsc-capability-maturity-model',
            title: 'NCSC Cyber Security Capability Maturity Model',
            url: `${NCSC_ROOT}capability-maturity-model/`,
            version: 'reference-verified-2026-09-02'
        }),
        acceptedSource({
            id: 'ncsc-reuse-terms',
            title: 'NCSC legal, privacy and copyright terms',
            url: 'https://www.ncsc.govt.nz/legal-privacy-and-copyright/',
            version: 'live-verified-2026-09-02'
        })
    );

    definition.controls.forEach((control) => {
        if (EXTENSION_TITLE_BY_CONTROL_ID[control.id]) {
            control.title = EXTENSION_TITLE_BY_CONTROL_ID[control.id];
        }
    });

    return definition;
}

function buildAcceptedSourceSeed(definition) {
    return {
        acceptedSpecification: {
            documentId: ACCEPTED_NCSC_SPEC_DOCUMENT_ID,
            revisionId: ACCEPTED_NCSC_SPEC_REVISION,
            acceptedAt: VERIFIED_AT
        },
        upstreamEvidence: {
            minimumStandardsVersion: '2025-v3',
            minimumStandardsPublishedAt: '2025-10-30',
            minimumStandardsPdfRetrievedAt: VERIFIED_AT,
            minimumStandardsPdfSha256: MINIMUM_STANDARDS_PDF_SHA256,
            criticalControlsSnapshotAt: '2026-08-31',
            criticalControlsReviewDueAt: '2027-08-31'
        },
        framework: definition.framework,
        profile: definition.profile,
        statements: definition.statements,
        sources: definition.sources,
        domains: definition.domains,
        controls: definition.controls,
        questions: definition.questions,
        responseOptions: definition.responseOptions
    };
}

function acceptedSource({ id, title, url, version, publishedAt }) {
    const source = {
        id,
        title,
        url,
        authority: 'New Zealand National Cyber Security Centre',
        version,
        lastVerifiedAt: VERIFIED_AT,
        rightsStatus: 'review_required'
    };
    if (publishedAt) source.publishedAt = publishedAt;
    return source;
}

function assertPinnedDigest(expected, actual, code) {
    if (expected !== actual) {
        throw new NcscFrameworkProfileImportError(code);
    }
}

function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
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

module.exports = {
    ACCEPTED_NCSC_FRAMEWORK_VERSION,
    ACCEPTED_NCSC_PROFILE_VERSION,
    ACCEPTED_NCSC_SPEC_DOCUMENT_ID,
    ACCEPTED_NCSC_SPEC_REVISION,
    ATTRIBUTION,
    EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256,
    EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256,
    GUIDANCE_URL_BY_REFERENCE_ID,
    MINIMUM_STANDARDS_PDF_SHA256,
    NcscFrameworkProfileImportError,
    createAcceptedNcscFrameworkProfile,
    importAcceptedNcscFrameworkProfile
};
