'use strict';

const {
    EXPECTED_CATALOGUE_SHA256,
    PROFILE_ID,
    PROFILE_VERSION,
    calculateCatalogueSha256,
    getNcscGapProfile
} = require('../securityGap/ncscProfile');
const {
    createFrameworkRegistry,
    publishFrameworkProfile
} = require('./frameworkProfileRegistry');

const NCSC_FRAMEWORK_ID = 'nz-ncsc-cyber-security-framework';
const NCSC_FRAMEWORK_VERSION = 'beta-verified-2026-08-31';
const EXPECTED_NCSC_FRAMEWORK_PROFILE_SHA256 = 'd37caa778e84e59c106c784e0892cc30146c62f4c13de68f01ab5cb5e14adb69';
const NCSC_AUTHORITY = 'New Zealand National Cyber Security Centre';
const VERIFIED_AT = '2026-08-31';

function createNcscFrameworkProfile() {
    const sourceProfile = getVerifiedSourceProfile();
    return publishFrameworkProfile(buildNcscFrameworkProfileDefinition(sourceProfile));
}

function buildNcscFrameworkProfileDefinition(sourceProfile) {
    const sourceByItemId = new Map();
    const criticalControlByKey = new Map(sourceProfile.criticalControls.map((control) => [
        control.key,
        control
    ]));
    const sourceByCriticalControlKey = new Map(sourceProfile.criticalControls.map((control) => [
        control.key,
        `ncsc-critical-control-${control.key}`
    ]));
    const sources = [
        source({
            id: 'ncsc-framework',
            title: sourceProfile.sources.framework.title,
            url: sourceProfile.sources.framework.sourceUrl,
            version: NCSC_FRAMEWORK_VERSION,
            rightsStatus: 'verified',
            licence: sourceProfile.sources.framework.licence,
            licenceUrl: sourceProfile.sources.framework.licenceUrl
        }),
        source({
            id: 'ncsc-minimum-standards-2025-v3',
            title: sourceProfile.sources.minimumStandards.title,
            url: sourceProfile.sources.minimumStandards.sourceUrl,
            version: '2025-v3',
            publishedAt: sourceProfile.sources.minimumStandards.publishedAt
        }),
        source({
            id: 'ncsc-critical-controls-2026-08-31',
            title: sourceProfile.sources.criticalControls.title,
            url: sourceProfile.sources.criticalControls.sourceUrl,
            version: 'verified-2026-08-31',
            reviewDueAt: sourceProfile.sources.criticalControls.reviewDueAt,
            reviewCadence: sourceProfile.sources.criticalControls.reviewCadence
        })
    ];

    sourceProfile.minimumStandards.forEach((item) => {
        const sourceId = `ncsc-guidance-${item.key}`;
        sourceByItemId.set(item.id, sourceId);
        sources.push(source({
            id: sourceId,
            title: `${item.officialTitle} guidance`,
            url: item.sourceUrl,
            version: item.sourceVersion,
            publishedAt: item.sourcePublishedAt
        }));
    });

    sourceProfile.criticalControls.forEach((control) => {
        sources.push(source({
            id: sourceByCriticalControlKey.get(control.key),
            title: control.officialTitle,
            url: control.guidanceUrl,
            version: `verified-${control.lastVerifiedAt}`,
            reviewDueAt: sourceProfile.sources.criticalControls.reviewDueAt,
            reviewCadence: sourceProfile.sources.criticalControls.reviewCadence
        }));
    });

    const responseOptionIds = ['yes', 'partial', 'no', 'unknown', 'not_applicable'];

    return {
        schemaVersion: 1,
        status: 'published',
        publishedAt: '2026-09-02',
        framework: {
            id: NCSC_FRAMEWORK_ID,
            version: NCSC_FRAMEWORK_VERSION,
            title: sourceProfile.sources.framework.title,
            authority: NCSC_AUTHORITY,
            description: 'Five cyber-security outcome functions adapted into a version-pinned No Fries assessment catalogue.',
            sourceIds: ['ncsc-framework']
        },
        profile: {
            id: sourceProfile.profileId,
            version: sourceProfile.profileVersion,
            title: sourceProfile.title,
            description: `${sourceProfile.audience}. ${sourceProfile.sourceScopeStatement}`,
            effectiveFrom: sourceProfile.effectiveFrom,
            sourceIds: [
                'ncsc-framework',
                'ncsc-minimum-standards-2025-v3',
                'ncsc-critical-controls-2026-08-31'
            ]
        },
        statements: {
            attribution: sourceProfile.attribution,
            basis: sourceProfile.basisStatement,
            claim: sourceProfile.claimStatement,
            limitations: [
                ...sourceProfile.limitations,
                sourceProfile.identifierNote,
                sourceProfile.mappingNote,
                sourceProfile.sourceScopeStatement
            ]
        },
        sources,
        domains: sourceProfile.frameworkFunctions.map((frameworkFunction) => ({
            id: frameworkFunction.id,
            order: frameworkFunction.order,
            title: frameworkFunction.name,
            guidance: {
                summary: frameworkFunction.outcomeParaphrase,
                evidenceExamples: [],
                startingActions: []
            },
            sourceIds: ['ncsc-framework']
        })),
        controls: sourceProfile.assessmentItems.map((item) => {
            const sourceIds = item.itemType === 'minimum_standard'
                ? [sourceByItemId.get(item.id), 'ncsc-minimum-standards-2025-v3']
                : ['ncsc-critical-controls-2026-08-31'];
            if (item.criticalControlKeys.length > 0 && !sourceIds.includes('ncsc-critical-controls-2026-08-31')) {
                sourceIds.push('ncsc-critical-controls-2026-08-31');
            }
            item.criticalControlKeys.forEach((key) => sourceIds.push(sourceByCriticalControlKey.get(key)));
            return {
                id: item.id,
                domainId: item.frameworkFunctionId,
                order: item.order,
                title: item.displayTitle || item.officialTitle,
                guidance: {
                    summary: item.intent,
                    evidenceExamples: [...item.evidenceExamples],
                    startingActions: [...item.startingActions]
                },
                sourceIds,
                sourceReferences: item.criticalControlKeys.map((key) => ({
                    sourceId: sourceByCriticalControlKey.get(key),
                    referenceId: key,
                    order: criticalControlByKey.get(key).sourceDisplayOrder
                }))
            };
        }),
        questions: sourceProfile.assessmentItems.map((item) => {
            const sourceIds = item.itemType === 'minimum_standard'
                ? [sourceByItemId.get(item.id), 'ncsc-minimum-standards-2025-v3']
                : ['ncsc-critical-controls-2026-08-31'];
            if (item.criticalControlKeys.length > 0 && !sourceIds.includes('ncsc-critical-controls-2026-08-31')) {
                sourceIds.push('ncsc-critical-controls-2026-08-31');
            }
            item.criticalControlKeys.forEach((key) => sourceIds.push(sourceByCriticalControlKey.get(key)));
            return {
                id: `${item.id}-Q1`,
                controlId: item.id,
                order: item.order,
                prompt: item.prompt,
                guidance: {
                    summary: item.intent,
                    evidenceExamples: [...item.evidenceExamples],
                    startingActions: [...item.startingActions]
                },
                weight: 1,
                responseOptionIds: [...responseOptionIds],
                sourceIds
            };
        }),
        responseOptions: [
            { id: 'yes', label: 'Yes', applicable: true, implementationFactor: 1 },
            { id: 'partial', label: 'Partial', applicable: true, implementationFactor: 0.5 },
            { id: 'no', label: 'No', applicable: true, implementationFactor: 0 },
            { id: 'unknown', label: 'Unknown', applicable: true, implementationFactor: null },
            { id: 'not_applicable', label: 'Not applicable', applicable: false, implementationFactor: null }
        ],
        sourceCatalogueSha256: sourceProfile.catalogueSha256,
        catalogueSha256: EXPECTED_NCSC_FRAMEWORK_PROFILE_SHA256
    };
}

function source({
    id,
    title,
    url,
    version,
    publishedAt,
    rightsStatus = 'review_required',
    licence,
    licenceUrl,
    reviewDueAt,
    reviewCadence
}) {
    const value = {
        id,
        title,
        url,
        authority: NCSC_AUTHORITY,
        version,
        lastVerifiedAt: VERIFIED_AT,
        rightsStatus
    };
    if (publishedAt) value.publishedAt = publishedAt;
    if (licence && licenceUrl) {
        value.licence = licence;
        value.licenceUrl = licenceUrl;
    }
    if (reviewDueAt && reviewCadence) {
        value.reviewDueAt = reviewDueAt;
        value.reviewCadence = reviewCadence;
    }
    return value;
}

function getVerifiedSourceProfile() {
    const sourceProfile = getNcscGapProfile();
    if (
        sourceProfile.profileId !== PROFILE_ID
        || sourceProfile.profileVersion !== PROFILE_VERSION
        || sourceProfile.catalogueSha256 !== EXPECTED_CATALOGUE_SHA256
        || calculateCatalogueSha256(sourceProfile) !== EXPECTED_CATALOGUE_SHA256
    ) {
        throw new Error('NCSC source profile no longer matches the pinned generic-profile adapter');
    }
    return sourceProfile;
}

let defaultFrameworkRegistry;

function getDefaultFrameworkRegistry() {
    if (!defaultFrameworkRegistry) {
        defaultFrameworkRegistry = createFrameworkRegistry([createNcscFrameworkProfile()]);
    }
    return defaultFrameworkRegistry;
}

module.exports = {
    EXPECTED_NCSC_FRAMEWORK_PROFILE_SHA256,
    NCSC_FRAMEWORK_ID,
    NCSC_FRAMEWORK_VERSION,
    createNcscFrameworkProfile,
    getDefaultFrameworkRegistry
};
