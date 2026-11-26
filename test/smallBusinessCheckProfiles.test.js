'use strict';

const { createAiUseFrameworkProfile } = require('../api/shared/assessmentEngine/aiUseFrameworkProfile');
const { createItOptimisationFrameworkProfile } = require('../api/shared/assessmentEngine/itOptimisationFrameworkProfile');
const { calculateFrameworkProfileSha256 } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');

describe.each([
    ['AI use check', createAiUseFrameworkProfile, ['ai_tools', 'ai_data', 'ai_staff', 'ai_review']],
    ['IT optimisation check', createItOptimisationFrameworkProfile,
        ['it_licences', 'it_devices', 'it_backups', 'it_access', 'it_support']]
])('%s', (title, make, domains) => {
    test('publishes ten distinct questions against the intended topics', () => {
        const profile = make();
        expect(profile.profile.title).toBe(title);
        expect(profile.domains.map(domain => domain.id)).toEqual(domains);
        expect(profile.questions).toHaveLength(10);
        expect(new Set(profile.questions.map(question => question.controlId)).size).toBe(10);
        expect(profile.questions.map(q => q.controlId)).toEqual(profile.controls.map(c => c.id));
        for (const domain of domains) expect(profile.controls.some(c => c.domainId === domain)).toBe(true);
        for (const question of profile.questions) {
            expect(question.prompt).toMatch(/\?$/);
            expect(question.guidance.evidenceExamples[0]).toBeTruthy();
            expect(question.guidance.startingActions[0]).toBeTruthy();
            expect(question.responseOptionIds).toEqual(['yes', 'partial', 'no', 'unknown']);
            expect(question.weight).toBe(1);
        }
    });

    test('keeps partial credit distinct from an unknown answer and verifies the pinned catalogue', () => {
        const profile = make();
        expect(profile.responseOptions.map(({ id, implementationFactor }) => [id, implementationFactor]))
            .toEqual([['yes', 1], ['partial', 0.5], ['no', 0], ['unknown', null]]);
        expect(calculateFrameworkProfileSha256(profile)).toBe(profile.catalogueSha256);
        expect(make()).toEqual(profile);
        expect(Object.isFrozen(profile.questions[0])).toBe(true);
    });
});
