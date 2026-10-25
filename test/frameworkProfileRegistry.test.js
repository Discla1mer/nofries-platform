'use strict';

const syntheticAssessment = require('../examples/ncsc-sme-gap-assessment.json');
const syntheticFrameworkProfile = require('./fixtures/syntheticFrameworkProfile.json');
const {
    FrameworkProfileLookupError,
    FrameworkProfileValidationError,
    calculateFrameworkProfileSha256,
    createFrameworkRegistry,
    publishFrameworkProfile
} = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const {
    EXPECTED_NCSC_FRAMEWORK_PROFILE_SHA256,
    NCSC_FRAMEWORK_ID,
    NCSC_FRAMEWORK_VERSION,
    createNcscFrameworkProfile,
    getDefaultFrameworkRegistry
} = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const {
    EXPECTED_CATALOGUE_SHA256,
    PROFILE_ID,
    PROFILE_VERSION,
    getNcscGapProfile
} = require('../api/shared/securityGap/ncscProfile');
const { evaluateGapAssessment } = require('../api/shared/securityGap/evaluateGapAssessment');

describe('generic framework-profile schema', () => {
    test('adapts the pinned NCSC catalogue without changing legacy IDs or behaviour', () => {
        const legacy = getNcscGapProfile();
        const adapted = createNcscFrameworkProfile();

        expect(adapted).toMatchObject({
            schemaVersion: 1,
            status: 'published',
            framework: {
                id: NCSC_FRAMEWORK_ID,
                version: NCSC_FRAMEWORK_VERSION
            },
            profile: {
                id: PROFILE_ID,
                version: PROFILE_VERSION
            },
            sourceCatalogueSha256: EXPECTED_CATALOGUE_SHA256,
            catalogueSha256: 'd37caa778e84e59c106c784e0892cc30146c62f4c13de68f01ab5cb5e14adb69'
        });
        expect(EXPECTED_NCSC_FRAMEWORK_PROFILE_SHA256).toBe(
            'd37caa778e84e59c106c784e0892cc30146c62f4c13de68f01ab5cb5e14adb69'
        );
        expect(adapted.domains.map((item) => item.id)).toEqual(
            legacy.frameworkFunctions.map((item) => item.id)
        );
        expect(adapted.controls.map((item) => item.id)).toEqual(
            legacy.assessmentItems.map((item) => item.id)
        );
        expect(adapted.questions).toHaveLength(14);
        expect(adapted.controls).toHaveLength(14);
        expect(adapted.domains).toHaveLength(5);

        const criticalControlMappings = adapted.controls
            .filter((control) => control.sourceReferences.some((reference) => (
                reference.referenceId === 'mfa-and-verification'
            )))
            .map((control) => control.id);
        expect(criticalControlMappings).toEqual([
            'NF-NCSC-MCSS-MF-01',
            'NF-NCSC-CC-SV-01'
        ]);
        expect(Object.fromEntries(adapted.controls.map((control) => [
            control.id,
            control.sourceReferences.map((reference) => reference.referenceId)
        ]))).toEqual(Object.fromEntries(legacy.assessmentItems.map((item) => [
            item.id,
            item.criticalControlKeys
        ])));

        const adaptedSourceById = new Map(adapted.sources.map((source) => [source.id, source]));
        const adaptedControlById = new Map(adapted.controls.map((control) => [control.id, control]));
        const adaptedQuestionByControlId = new Map(adapted.questions.map((question) => [
            question.controlId,
            question
        ]));
        legacy.frameworkFunctions.forEach((frameworkFunction) => {
            expect(adapted.domains.find((domain) => domain.id === frameworkFunction.id)).toMatchObject({
                order: frameworkFunction.order,
                title: frameworkFunction.name,
                guidance: { summary: frameworkFunction.outcomeParaphrase }
            });
        });
        legacy.assessmentItems.forEach((item) => {
            const control = adaptedControlById.get(item.id);
            const question = adaptedQuestionByControlId.get(item.id);
            expect(control).toMatchObject({
                domainId: item.frameworkFunctionId,
                order: item.order,
                title: item.displayTitle || item.officialTitle,
                guidance: {
                    summary: item.intent,
                    evidenceExamples: item.evidenceExamples,
                    startingActions: item.startingActions
                }
            });
            expect(question).toMatchObject({
                prompt: item.prompt,
                weight: 1,
                guidance: control.guidance
            });
            expect(control.sourceIds.some((sourceId) => (
                adaptedSourceById.get(sourceId).url === item.sourceUrl
            ))).toBe(true);
        });
        legacy.criticalControls.forEach((criticalControl) => {
            const sourceId = `ncsc-critical-control-${criticalControl.key}`;
            expect(adaptedSourceById.get(sourceId)).toMatchObject({
                title: criticalControl.officialTitle,
                url: criticalControl.guidanceUrl,
                lastVerifiedAt: criticalControl.lastVerifiedAt,
                reviewDueAt: legacy.sources.criticalControls.reviewDueAt,
                reviewCadence: legacy.sources.criticalControls.reviewCadence,
                rightsStatus: 'review_required'
            });
            const reverseMappedItemIds = adapted.controls
                .filter((control) => control.sourceReferences.some((reference) => (
                    reference.sourceId === sourceId
                    && reference.referenceId === criticalControl.key
                    && reference.order === criticalControl.sourceDisplayOrder
                )))
                .map((control) => control.id);
            expect(reverseMappedItemIds).toEqual(criticalControl.assessmentItemIds);
        });
        expect(adaptedSourceById.get('ncsc-framework')).toMatchObject({
            rightsStatus: 'verified',
            licence: legacy.sources.framework.licence,
            licenceUrl: legacy.sources.framework.licenceUrl
        });
        expect(adaptedSourceById.get('ncsc-minimum-standards-2025-v3').licence).toBeUndefined();

        const report = evaluateGapAssessment(syntheticAssessment, {
            generatedAt: '2026-08-31T23:00:00.000Z'
        });
        expect(report.internalReportSha256).toBe(
            'e66ae67e4edbcbfbfce4cb98acd658543022abbf4ea7f7be1ea09af3b5997cfa'
        );
    });

    test('accepts a materially different profile with complete sources, guidance and weights', () => {
        const before = JSON.stringify(syntheticFrameworkProfile);
        const published = publishFrameworkProfile(syntheticFrameworkProfile);

        expect(published.domains).toHaveLength(2);
        expect(published.controls).toHaveLength(3);
        expect(published.questions).toHaveLength(4);
        expect(published.questions.map((question) => question.weight)).toEqual([0.25, 0.75, 1, 2]);
        expect(published.questions.filter((question) => (
            question.controlId === 'SYN-OR-PRE-01'
        ))).toHaveLength(2);
        expect(published.domains[0].title).toBe(published.domains[1].title);
        expect(published.controls[0].title).toBe(published.controls[2].title);
        expect(published.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
        expect(published.controls.every((control) => control.guidance.summary)).toBeTruthy();
        expect(JSON.stringify(syntheticFrameworkProfile)).toBe(before);
    });

    test.each([
        ['framework version', (profile) => { delete profile.framework.version; }, 'required_field_missing'],
        ['profile version', (profile) => { profile.profile.version = 'latest'; }, 'invalid_version'],
        ['domain guidance', (profile) => { delete profile.domains[0].guidance.summary; }, 'required_field_missing'],
        ['control identifier', (profile) => { profile.controls[0].id = ''; }, 'invalid_id'],
        ['question prompt', (profile) => { profile.questions[0].prompt = ''; }, 'non_empty_text_required'],
        ['question weight', (profile) => { profile.questions[0].weight = Number.NaN; }, 'unsupported_number'],
        ['source URL', (profile) => { profile.sources[0].url = 'http://example.test'; }, 'invalid_url'],
        ['blank claim', (profile) => { profile.statements.claim = '   '; }, 'non_empty_text_required'],
        ['out-of-range weight', (profile) => { profile.questions[0].weight = 1001; }, 'invalid_weight']
    ])('rejects an invalid %s field', (_label, mutate, code) => {
        const profile = clone(syntheticFrameworkProfile);
        mutate(profile);
        expectValidationCode(() => publishFrameworkProfile(profile), code);
    });

    test.each([
        ['domain', (profile) => { profile.controls[0].domainId = 'missing-domain'; }, 'unknown_domain'],
        ['control', (profile) => { profile.questions[0].controlId = 'missing-control'; }, 'unknown_control'],
        ['response option', (profile) => { profile.questions[0].responseOptionIds[0] = 'missing-option'; }, 'unknown_response_option'],
        ['source', (profile) => { profile.controls[0].sourceIds[0] = 'missing-source'; }, 'unknown_source']
    ])('rejects a dangling %s reference', (_label, mutate, code) => {
        const profile = clone(syntheticFrameworkProfile);
        mutate(profile);
        expectValidationCode(() => publishFrameworkProfile(profile), code);
    });

    test('requires an independently pinned digest and rejects content changed under that pin', () => {
        const missing = clone(syntheticFrameworkProfile);
        delete missing.catalogueSha256;
        expectValidationCode(() => publishFrameworkProfile(missing), 'catalogue_digest_required');

        const changed = clone(syntheticFrameworkProfile);
        changed.questions[0].weight = 0.5;
        expectValidationCode(() => publishFrameworkProfile(changed), 'catalogue_digest_mismatch');

        const before = JSON.stringify(syntheticFrameworkProfile);
        expect(calculateFrameworkProfileSha256(syntheticFrameworkProfile)).toBe(
            syntheticFrameworkProfile.catalogueSha256
        );
        expect(JSON.stringify(syntheticFrameworkProfile)).toBe(before);
    });

    test('rejects active content, special keys, accessors, sparse arrays and non-plain objects', () => {
        const accessor = clone(syntheticFrameworkProfile);
        Object.defineProperty(accessor.framework, 'title', {
            enumerable: true,
            get() { return 'unsafe'; }
        });
        expectValidationCode(() => publishFrameworkProfile(accessor), 'accessor_rejected');

        const forbidden = clone(syntheticFrameworkProfile);
        Object.defineProperty(forbidden.framework, '__proto__', {
            enumerable: true,
            value: {}
        });
        expectValidationCode(() => publishFrameworkProfile(forbidden), 'forbidden_key');

        const sparse = clone(syntheticFrameworkProfile);
        delete sparse.domains[0];
        expectValidationCode(() => publishFrameworkProfile(sparse), 'sparse_array_rejected');

        const nonPlain = clone(syntheticFrameworkProfile);
        nonPlain.framework = new Map();
        expectValidationCode(() => publishFrameworkProfile(nonPlain), 'non_plain_object');

        const proxied = clone(syntheticFrameworkProfile);
        proxied.framework = new Proxy(proxied.framework, {});
        expectValidationCode(() => publishFrameworkProfile(proxied), 'proxy_rejected');

        const hidden = clone(syntheticFrameworkProfile);
        Object.defineProperty(hidden.framework, 'hidden', {
            enumerable: false,
            value: 'not JSON data'
        });
        expectValidationCode(() => publishFrameworkProfile(hidden), 'non_json_property_rejected');

        const deep = clone(syntheticFrameworkProfile);
        let cursor = deep;
        for (let depth = 0; depth < 256; depth += 1) {
            cursor.extra = {};
            cursor = cursor.extra;
        }
        expectValidationCode(() => publishFrameworkProfile(deep), 'definition_too_deep');

        const hugeText = clone(syntheticFrameworkProfile);
        hugeText.profile.description = 'x'.repeat((1024 * 1024) + 1);
        expectValidationCode(() => publishFrameworkProfile(hugeText), 'profile_too_large');

        const hugeKey = clone(syntheticFrameworkProfile);
        hugeKey.framework[`x${'y'.repeat(256)}`] = true;
        expectValidationCode(() => publishFrameworkProfile(hugeKey), 'property_key_too_long');

        const injectedKey = clone(syntheticFrameworkProfile);
        injectedKey['unexpected\nlog-line'] = true;
        try {
            publishFrameworkProfile(injectedKey);
            throw new Error('Expected an unknown-field validation error');
        } catch (error) {
            expect(error).toBeInstanceOf(FrameworkProfileValidationError);
            expect(error.code).toBe('unknown_field');
            expect(error.path).toBe('$.[unknown]');
            expect(error.message).not.toContain('log-line');
        }
    });

    test.each([
        ['duplicate IDs', (profile) => { profile.domains[1].id = profile.domains[0].id; }, 'duplicate_id'],
        ['duplicate orders', (profile) => { profile.questions[1].order = profile.questions[0].order; }, 'duplicate_order'],
        ['an orphan domain', (profile) => { profile.controls[2].domainId = 'prepare'; }, 'domain_without_control'],
        ['a control without a question', (profile) => { profile.questions[3].controlId = 'SYN-OR-PRE-02'; }, 'control_without_question'],
        ['an unused source', (profile) => {
            profile.sources.push({ ...profile.sources[0], id: 'unused-source' });
        }, 'unused_source'],
        ['an unused response option', (profile) => {
            profile.responseOptions.push({
                id: 'unused-option',
                label: 'Unused',
                applicable: true,
                implementationFactor: null
            });
        }, 'unused_response_option'],
        ['no positive weight', (profile) => {
            profile.questions.forEach((question) => { question.weight = 0; });
        }, 'positive_weight_required'],
        ['a source reference outside declared sources', (profile) => {
            profile.controls[0].sourceReferences[0].sourceId = 'synthetic-exercise-source';
        }, 'source_reference_not_declared'],
        ['response options without an applicable numeric factor', (profile) => {
            profile.responseOptions.forEach((option) => {
                option.applicable = false;
                option.implementationFactor = null;
            });
        }, 'unusable_response_options']
    ])('rejects %s', (_label, mutate, code) => {
        const profile = clone(syntheticFrameworkProfile);
        mutate(profile);
        expectValidationCode(() => publishFrameworkProfile(profile), code);
    });
});

describe('immutable framework registry', () => {
    test('resolves NCSC and synthetic profiles only by exact version and lists them deterministically', () => {
        const registry = createFrameworkRegistry([
            syntheticFrameworkProfile,
            createNcscFrameworkProfile()
        ]);

        expect(registry.listProfiles().map((item) => item.profileId)).toEqual([
            PROFILE_ID,
            'synthetic-operations-resilience-baseline'
        ]);
        expect(registry.getProfile(PROFILE_ID, PROFILE_VERSION).sourceCatalogueSha256).toBe(
            EXPECTED_CATALOGUE_SHA256
        );
        expect(registry.getProfile(
            'synthetic-operations-resilience-baseline',
            '1.0.0'
        ).controls).toHaveLength(3);
        expect(registry.getFramework(NCSC_FRAMEWORK_ID, NCSC_FRAMEWORK_VERSION).id).toBe(
            NCSC_FRAMEWORK_ID
        );
        expect(registry.hasProfile(PROFILE_ID, PROFILE_VERSION)).toBe(true);
        expect(registry.hasProfile(PROFILE_ID, '2026-08-31.2')).toBe(false);
    });

    test.each([
        [PROFILE_ID, undefined, 'invalid_framework_profile_reference'],
        [PROFILE_ID, 'latest', 'invalid_framework_profile_reference'],
        [PROFILE_ID.toUpperCase(), PROFILE_VERSION, 'unsupported_framework_profile'],
        ['unknown-profile', '1.0', 'unsupported_framework_profile'],
        [PROFILE_ID, '2026-08-31.2', 'unsupported_framework_profile']
    ])('does not fall back from profile lookup %#', (profileId, profileVersion, code) => {
        const registry = getDefaultFrameworkRegistry();
        expectLookupCode(() => registry.getProfile(profileId, profileVersion), code);
    });

    test('supports explicit versions while rejecting duplicate or conflicting published versions', () => {
        const secondVersion = clone(syntheticFrameworkProfile);
        secondVersion.profile.version = '1.0.1';
        secondVersion.questions[0].weight = 0.5;
        seal(secondVersion);
        const registry = createFrameworkRegistry([syntheticFrameworkProfile, secondVersion]);
        expect(registry.hasProfile(secondVersion.profile.id, '1.0.0')).toBe(true);
        expect(registry.hasProfile(secondVersion.profile.id, '1.0.1')).toBe(true);

        expectValidationCode(
            () => createFrameworkRegistry([syntheticFrameworkProfile, syntheticFrameworkProfile]),
            'duplicate_profile_version'
        );

        const conflictingFramework = clone(secondVersion);
        conflictingFramework.sources[0].url = 'https://example.test/changed-framework-source';
        seal(conflictingFramework);
        expectValidationCode(
            () => createFrameworkRegistry([syntheticFrameworkProfile, conflictingFramework]),
            'framework_version_conflict'
        );
    });

    test('accepts a bounded multi-profile registry beyond one profile graph budget', () => {
        const profiles = Array.from({ length: 17 }, (_value, index) => {
            const profile = clone(createNcscFrameworkProfile());
            profile.profile.version = `registry-test-${String(index + 1).padStart(2, '0')}`;
            return seal(profile);
        });

        const registry = createFrameworkRegistry(profiles);
        expect(registry.listProfiles()).toHaveLength(17);
        expect(registry.getProfile(PROFILE_ID, 'registry-test-17').profile.version).toBe(
            'registry-test-17'
        );
    });

    test('isolates construction inputs and every returned object from mutation', () => {
        const definition = clone(syntheticFrameworkProfile);
        const registry = createFrameworkRegistry([definition]);
        definition.questions[0].weight = 999;
        definition.sources[0].title = 'Changed outside registry';

        const first = registry.getProfile(definition.profile.id, definition.profile.version);
        expect(first.questions[0].weight).toBe(0.25);
        expect(first.sources[0].title).toBe('Synthetic framework source');
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.questions[0].guidance)).toBe(true);
        expect(() => { first.questions[0].weight = 500; }).toThrow(TypeError);

        const listed = registry.listProfiles();
        expect(Object.isFrozen(listed)).toBe(true);
        expect(() => { listed[0].title = 'Changed'; }).toThrow(TypeError);
        expect(registry.getProfile(definition.profile.id, definition.profile.version).questions[0].weight).toBe(0.25);
        expect(registry.register).toBeUndefined();
        expect(registry.replace).toBeUndefined();
        expect(registry.delete).toBeUndefined();
        expect(getDefaultFrameworkRegistry().listProfiles().map((item) => item.profileId)).toEqual([
            PROFILE_ID
        ]);
    });
});

function seal(profile) {
    profile.catalogueSha256 = calculateFrameworkProfileSha256(profile);
    return profile;
}

function expectValidationCode(action, code) {
    try {
        action();
        throw new Error(`Expected FrameworkProfileValidationError (${code})`);
    } catch (error) {
        expect(error).toBeInstanceOf(FrameworkProfileValidationError);
        expect(error.code).toBe(code);
    }
}

function expectLookupCode(action, code) {
    try {
        action();
        throw new Error(`Expected FrameworkProfileLookupError (${code})`);
    } catch (error) {
        expect(error).toBeInstanceOf(FrameworkProfileLookupError);
        expect(error.code).toBe(code);
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
