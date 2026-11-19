'use strict';

// Scoring v2 (#399): the 16-question profile sits beside the accepted profile and nothing selects it yet.
const v2 = require('../api/shared/assessmentEngine/assessmentEvaluatorV2');
const { createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const {
    EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256, createAcceptedNcscFrameworkProfile
} = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const {
    EXPECTED_NCSC_PROFILE_V2_SHA256, NCSC_PROFILE_V2_DISPLAY_TOPICS, NCSC_PROFILE_V2_VERSION, PLANNING_SCORE_STATEMENT,
    createNcscFrameworkProfileV2
} = require('../api/shared/assessmentEngine/ncscFrameworkProfileV2');

const accepted = createAcceptedNcscFrameworkProfile();
const profile = createNcscFrameworkProfileV2();
const registry = createFrameworkRegistry([accepted, profile]);
const IDS = ['NF-NCSC-MCSS-RM-01-Q1', 'NF-NCSC-MCSS-SA-01-Q1', 'NF-NCSC-MCSS-AI-01-Q1', 'NF-NCSC-MCSS-PA-01-Q1',
    'NF-NCSC-MCSS-MF-01-Q1', 'NF-NCSC-MCSS-MF-01-Q2', 'NF-NCSC-MCSS-DU-01-Q1', 'NF-NCSC-MCSS-LP-01-Q1',
    'NF-NCSC-MCSS-DR-01-Q1', 'NF-NCSC-MCSS-DR-01-Q2', 'NF-NCSC-MCSS-RP-01-Q1', 'NF-NCSC-CC-PM-01-Q1',
    'NF-NCSC-CC-SV-01-Q1', 'NF-NCSC-CC-NS-01-Q1', 'NF-NCSC-CC-SU-01-Q1', 'NF-NCSC-CC-EM-01-Q1'];
// The worked example in #399 (an 8-person firm).
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
    'no', 'ad_hoc', 'partly', 'no', 'unknown'];

function input(answers) {
    const value = {
        schemaVersion: 1, scoreContractVersion: v2.SCORE_CONTRACT_VERSION,
        organisationId: 'org-test', moduleId: 'cyber_security', assessmentId: 'assessment-test', assessmentRevision: 'rev-1',
        profileRef: { frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
            profileId: profile.profile.id, profileVersion: profile.profile.version, catalogueSha256: profile.catalogueSha256,
            sourceCatalogueSha256: profile.sourceCatalogueSha256 },
        scoreAsOf: '2026-11-18T10:00:00.000Z', scopePopulationSha256: '1'.repeat(64),
        evidenceSnapshot: { id: 'evidence-snapshot-1', sha256: '0'.repeat(64) },
        riskContextSnapshot: { id: 'risk-snapshot-1', sha256: '0'.repeat(64) },
        atomInputs: profile.questions.map((question, index) => ({ itemId: question.id,
            ...(answers[index] ? { response: { optionId: answers[index] } } : {}),
            evidenceState: 'not_provided', statedImpact: 'unspecified', priorityOverlay: 'none' }))
    };
    value.evidenceSnapshot.sha256 = v2.calculateEvidenceSnapshotSha256(
        value.atomInputs.map(atom => ({ itemId: atom.itemId, evidenceState: atom.evidenceState })));
    value.riskContextSnapshot.sha256 = v2.calculateRiskContextSnapshotSha256(
        value.atomInputs.map(atom => ({ itemId: atom.itemId, statedImpact: atom.statedImpact, priorityOverlay: atom.priorityOverlay })));
    return value;
}

describe('scoring v2 profile', () => {
    test('is published beside the accepted profile, which is unchanged', () => {
        expect(accepted.catalogueSha256).toBe(EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256);
        expect(profile.catalogueSha256).toBe(EXPECTED_NCSC_PROFILE_V2_SHA256);
        expect(profile.profile).toMatchObject({ id: accepted.profile.id, version: NCSC_PROFILE_V2_VERSION });
        expect(NCSC_PROFILE_V2_VERSION).not.toBe(accepted.profile.version);
        expect(registry.getProfile(accepted.profile.id, accepted.profile.version).questions).toHaveLength(14);
        expect(registry.getProfile(profile.profile.id, NCSC_PROFILE_V2_VERSION).questions).toHaveLength(16);
        expect(Object.isFrozen(profile)).toBe(true);
    });

    test('has the 16 questions in order, with weights totalling 31 across the five domains', () => {
        expect(profile.questions.map(question => question.id)).toEqual(IDS);
        expect(profile.questions.map(question => question.weight)).toEqual([1, 2, 1, 2, 3, 2, 1, 2, 3, 3, 1, 2, 3, 1, 2, 2]);
        expect(profile.questions.reduce((sum, question) => sum + question.weight, 0)).toBe(31);
        expect(profile.domains.map(domain => domain.id)).toEqual(accepted.domains.map(domain => domain.id));
        const controlIds = profile.controls.map(control => control.id);
        expect(controlIds).not.toContain('NF-NCSC-MCSS-SC-01');
        expect(controlIds).not.toContain('NF-NCSC-CC-AC-01');
        expect(controlIds).toEqual(expect.arrayContaining(['NF-NCSC-CC-SU-01', 'NF-NCSC-CC-EM-01']));
        profile.controls.forEach(control => expect(control.title).not.toMatch(/extension/i));
        profile.questions.forEach(question => expect(question.guidance.startingActions).toHaveLength(1));
    });

    test('offers the standard ladder everywhere except the login-method question', () => {
        const factor = Object.fromEntries(profile.responseOptions.map(option => [option.id, option.implementationFactor]));
        expect(factor).toMatchObject({ yes: 1, partly: 0.5, ad_hoc: 0.25, no: 0, unknown: null, not_applicable: null,
            mfa_key: 1, mfa_number_matching: 0.85, mfa_push: 0.7, mfa_authenticator: 0.55, mfa_text_code: 0.3, mfa_mixed: 0.3, mfa_none: 0 });
        profile.questions.forEach(question => {
            const method = question.id === 'NF-NCSC-MCSS-MF-01-Q2';
            expect(question.responseOptionIds.includes('mfa_key')).toBe(method);
            expect(question.responseOptionIds.includes('yes')).toBe(!method);
            expect(question.responseOptionIds.includes('not_applicable')).toBe(!method);
            expect(question.responseOptionIds).toContain('unknown');
        });
    });

    test('reproduces the worked example with the graded evaluator: 7.85 of 31 is 25.3%', () => {
        const result = v2.evaluateAssessment(input(EXAMPLE), { registry });
        expect(result.attainment).toMatchObject({ status: 'scored', creditUnitScale: 100, lowerCreditUnits: 785,
            denominatorWeight: 31, lowerDisplay: '25.3%' });
        expect(result.countsCompletion).toMatchObject({ totalAtoms: 16, applicableAtoms: 16, unknown: 2 });
        expect(result.provenance).toMatchObject({ scoreContractVersion: 'PROD-003-R2' });
    });

    test('scores every answer on every question, and no extra login step earns nothing', () => {
        const top = profile.questions.map(question => (question.id === 'NF-NCSC-MCSS-MF-01-Q2' ? 'mfa_key' : 'yes'));
        expect(v2.evaluateAssessment(input(top), { registry }).attainment.lowerDisplay).toBe('100.0%');
        const none = top.slice(); none[4] = 'no'; none[5] = 'mfa_none';
        expect(v2.evaluateAssessment(input(none), { registry }).attainment.lowerCreditUnits).toBe(2600);
        profile.questions.forEach((question, index) => question.responseOptionIds
            .filter(optionId => optionId !== 'not_applicable').forEach(optionId => {
                const answers = top.slice(); answers[index] = optionId;
                expect(v2.evaluateAssessment(input(answers), { registry }).attainment.status).toBe('scored');
            }));
    });

    test('carries the planning-score wording and the three display topics', () => {
        expect(profile.statements.limitations).toContain(PLANNING_SCORE_STATEMENT);
        expect(profile.statements.limitations).toEqual(expect.arrayContaining(accepted.statements.limitations));
        expect(JSON.stringify(profile)).not.toMatch(/maturity level|certified/i);
        expect(NCSC_PROFILE_V2_DISPLAY_TOPICS.map(topic => topic.title)).toEqual(['People & Access', 'Systems & Protection', 'Backup & Recovery']);
        expect(NCSC_PROFILE_V2_DISPLAY_TOPICS.flatMap(topic => topic.questionIds).sort()).toEqual(IDS.slice().sort());
    });
});
