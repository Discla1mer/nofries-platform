'use strict';

// Scoring v2 (#399): new starter organisations name the v2 profile only while
// NOFRIES_NCSC_PROFILE_V2 is exactly 'true'; their schedule then compiles.
const { starterFramework } = require('../lib/starterSignupProduction');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');
const { compileStarterSchedule } = require('../api/shared/customerSignup/customerStarterPlan');

test('flag off: new starters keep the accepted 14-question profile', () => {
    for (const env of [{}, { NOFRIES_NCSC_PROFILE_V2: 'false' }, { NOFRIES_NCSC_PROFILE_V2: 'TRUE' }]) {
        const f = starterFramework(env);
        expect(f.profileId).toBe(ACCEPTED_NCSC_CONTEXT.profileRef.profileId);
        expect(f.version).toBe(ACCEPTED_NCSC_CONTEXT.profileRef.profileVersion);
        expect(f.scoringVersion).toBe(ACCEPTED_NCSC_CONTEXT.evaluatorVersion);
    }
});

test('flag on: new starters name the v2 profile and its evaluator', () => {
    const f = starterFramework({ NOFRIES_NCSC_PROFILE_V2: 'true' });
    expect(f).toEqual({ moduleId: 'cyber_security', profileId: NCSC_V2_CONTEXT.profileRef.profileId,
        version: NCSC_V2_CONTEXT.profileRef.profileVersion, scoringVersion: NCSC_V2_CONTEXT.evaluatorVersion });
    expect(NCSC_V2_CONTEXT.questionIds).toHaveLength(16);
});

test('a v2 starter schedule names the v2 profile in its retained text', () => {
    const crypto = require('node:crypto');
    const framework = starterFramework({ NOFRIES_NCSC_PROFILE_V2: 'true' });
    const { schedule } = compileStarterSchedule({ tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID(),
        organisationName: 'Synthetic v2 test', accountType: 'company', kind: 'own', grantId: crypto.randomUUID(),
        scheduleId: crypto.randomUUID(), contact: { name: 'Synthetic Tester', role: 'Tester', email: 'tester@gmail.com',
            address: 'Synthetic address', registrationId: null, authorityEvidenceId: 'synthetic-declaration' }, framework });
    expect(schedule.scheduleText).toContain(`Assessment: ${JSON.stringify(framework.profileId)}; version: ${JSON.stringify(framework.version)}`);
});
