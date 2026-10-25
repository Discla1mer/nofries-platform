'use strict';

const {
    calculateFrameworkProfileSha256,
    createFrameworkRegistry
} = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const {
    NCSC_FRAMEWORK_ID,
    NCSC_FRAMEWORK_VERSION,
    createNcscFrameworkProfile
} = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const {
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
} = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');

describe('Accepted NCSC framework-profile package', () => {
    test('publishes the Accepted mapping as a new exact version without changing stable IDs', () => {
        const historical = createNcscFrameworkProfile();
        const accepted = createAcceptedNcscFrameworkProfile();

        expect(accepted).toMatchObject({
            schemaVersion: 1,
            status: 'published',
            publishedAt: '2026-09-02',
            framework: {
                id: NCSC_FRAMEWORK_ID,
                version: ACCEPTED_NCSC_FRAMEWORK_VERSION
            },
            profile: {
                id: historical.profile.id,
                version: ACCEPTED_NCSC_PROFILE_VERSION,
                effectiveFrom: '2025-10-30'
            }
        });
        expect(accepted.profile.version).not.toBe(historical.profile.version);
        expect(historical.framework.version).toBe(NCSC_FRAMEWORK_VERSION);
        expect(historical.profile.version).toBe('2026-08-31.1');
        expect(accepted.domains.map(({ id }) => id)).toEqual(
            historical.domains.map(({ id }) => id)
        );
        expect(accepted.controls.map(({ id }) => id)).toEqual(
            historical.controls.map(({ id }) => id)
        );
        expect(accepted.questions.map(({ id }) => id)).toEqual(
            historical.questions.map(({ id }) => id)
        );
        expect(accepted.questions.map(({ id }) => id)).toEqual(
            accepted.controls.map(({ id }) => `${id}-Q1`)
        );
        expect(accepted.responseOptions).toEqual(historical.responseOptions);
        expect(accepted.questions.every(({ weight }) => weight === 1)).toBe(true);

        expect(accepted.sourceCatalogueSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(accepted.catalogueSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(accepted.sourceCatalogueSha256).not.toBe(historical.sourceCatalogueSha256);
        expect(accepted.catalogueSha256).not.toBe(historical.catalogueSha256);
        expect(new Set([
            accepted.sourceCatalogueSha256,
            accepted.catalogueSha256,
            MINIMUM_STANDARDS_PDF_SHA256
        ])).toHaveProperty('size', 3);
        expect(calculateFrameworkProfileSha256(accepted)).toBe(accepted.catalogueSha256);

        expect(EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256).toBe(
            '26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee'
        );
        expect(EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256).toBe(
            '32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375'
        );
        expect(accepted.sourceCatalogueSha256).toBe(EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256);
        expect(accepted.catalogueSha256).toBe(
            EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256
        );
    });

    test('retains exact source evidence, reuse limits and dedicated guidance URLs', () => {
        const accepted = createAcceptedNcscFrameworkProfile();
        expect(ACCEPTED_NCSC_SPEC_DOCUMENT_ID).toBe(
            '1mENSf3FLcNYBwDLl0TUHbtyGrlsZBFYws8szRau1EM8'
        );
        expect(ACCEPTED_NCSC_SPEC_REVISION).toBe(
            'AIroW36A7NZjeAcTpzgJzaCGH_1TZQXgIYuz3vPdm46LMwdWtBXUwMGQAPGzbAHBSdOReRWSdFXgScIhZN9aMiOtgfmvjftIS51M3Uns9q7e'
        );
        const sourceById = new Map(accepted.sources.map((source) => [source.id, source]));

        Object.entries(GUIDANCE_URL_BY_REFERENCE_ID).forEach(([referenceId, url]) => {
            expect(sourceById.get(`ncsc-critical-control-${referenceId}`)).toMatchObject({
                url,
                rightsStatus: 'review_required'
            });
        });

        expect(sourceById.get('ncsc-framework')).toMatchObject({
            rightsStatus: 'verified',
            licence: 'CC BY 4.0',
            licenceUrl: 'https://creativecommons.org/licenses/by/4.0/'
        });
        expect(sourceById.get('ncsc-minimum-standards-pdf-2025-v3')).toMatchObject({
            version: '2025-v3',
            rightsStatus: 'review_required',
            publishedAt: '2025-10-30',
            lastVerifiedAt: '2026-09-02'
        });
        expect(MINIMUM_STANDARDS_PDF_SHA256).toBe(
            '11035e195bfd2bc3d51e87df5e036acc02feafd4e6dc2f8659c840bb0b07712c'
        );
        expect(sourceById.get('ncsc-critical-controls-2026-08-31')).toMatchObject({
            lastVerifiedAt: '2026-08-31',
            reviewDueAt: '2027-08-31',
            reviewCadence: 'at_least_annually'
        });
        expect(accepted.statements.attribution).toBe(ATTRIBUTION);
        expect(accepted.statements.limitations.join(' ')).toMatch(/publication-date pin/);
        expect(accepted.statements.limitations.join(' ')).toMatch(/logos, emblems, trademarks/);
        expect(accepted.statements.limitations.join(' ')).toMatch(/Third-party material/);
        expect(accepted.statements.limitations.join(' ')).toMatch(/source-specific terms prevail/);
        expect(accepted.statements.limitations.join(' ')).toMatch(/Paid or customer-facing release/);
        expect(accepted.statements.claim).toMatch(/no certification, endorsement, compliance/);

        expect(accepted.controls.filter(({ id }) => id.startsWith('NF-NCSC-CC-')))
            .toHaveLength(4);
        expect(accepted.controls.filter(({ id }) => id.startsWith('NF-NCSC-CC-'))
            .every(({ title }) => title.startsWith('No Fries Critical Control extension — ')))
            .toBe(true);
    });

    test('imports idempotently and fails closed on a conflicting publication', () => {
        const historical = createNcscFrameworkProfile();
        const accepted = createAcceptedNcscFrameworkProfile();
        const mutableHistorical = JSON.parse(JSON.stringify(historical));
        const definitions = [mutableHistorical];
        const definitionsBefore = JSON.stringify(definitions);

        const once = importAcceptedNcscFrameworkProfile(definitions);
        expect(JSON.stringify(definitions)).toBe(definitionsBefore);
        expect(definitions).toHaveLength(1);
        expect(definitions[0]).toBe(mutableHistorical);
        expect(Object.isFrozen(definitions)).toBe(false);
        expect(Object.isFrozen(mutableHistorical)).toBe(false);

        const twice = importAcceptedNcscFrameworkProfile(once);
        expect(once).toHaveLength(2);
        expect(twice).toEqual(once);
        expect(Object.isFrozen(once)).toBe(true);
        expect(Object.isFrozen(twice)).toBe(true);

        const registry = createFrameworkRegistry(twice);
        expect(registry.listProfiles().map(({ profileVersion }) => profileVersion)).toEqual([
            '2026-08-31.1',
            ACCEPTED_NCSC_PROFILE_VERSION
        ]);
        expect(registry.getProfile(
            historical.profile.id,
            historical.profile.version
        ).catalogueSha256).toBe(historical.catalogueSha256);
        const firstLoad = registry.getProfile(historical.profile.id, ACCEPTED_NCSC_PROFILE_VERSION);
        const secondLoad = registry.getProfile(historical.profile.id, ACCEPTED_NCSC_PROFILE_VERSION);
        expect(firstLoad).toEqual(secondLoad);
        expect(firstLoad).not.toBe(secondLoad);
        expect(Object.isFrozen(firstLoad)).toBe(true);

        const conflicting = JSON.parse(JSON.stringify(accepted));
        conflicting.profile.title = 'Conflicting accepted profile';
        delete conflicting.catalogueSha256;
        conflicting.catalogueSha256 = calculateFrameworkProfileSha256(conflicting);
        expect(() => importAcceptedNcscFrameworkProfile([historical, conflicting]))
            .toThrow(expect.objectContaining({
                name: 'NcscFrameworkProfileImportError',
                code: 'accepted_profile_conflict'
            }));
        expect(() => importAcceptedNcscFrameworkProfile(null))
            .toThrow(expect.objectContaining({
                code: 'definition_list_required'
            }));
        expect(() => importAcceptedNcscFrameworkProfile([
            historical,
            accepted,
            accepted
        ])).toThrow(expect.objectContaining({
            code: 'duplicate_accepted_profile'
        }));
        expect(NcscFrameworkProfileImportError.prototype).toBeInstanceOf(Error);
    });
});
