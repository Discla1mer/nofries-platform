'use strict';

// Scoring v2 (#399): the forked evaluator with graded part-credit answers.
// The v1 evaluator stays byte-identical; nothing selects v2 yet.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const v1 = require('../api/shared/assessmentEngine/assessmentEvaluator');
const v2 = require('../api/shared/assessmentEngine/assessmentEvaluatorV2');
const { ASSESSMENT_EVALUATOR_SOURCE_SHA256 } = require('../api/shared/assessmentEngine/assessmentEvaluatorVersion');
const { ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256, ASSESSMENT_EVALUATOR_V2_VERSION } = require('../api/shared/assessmentEngine/assessmentEvaluatorV2Version');
const { calculateFrameworkProfileSha256, createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createNcscFrameworkProfile, getDefaultFrameworkRegistry } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const syntheticFrameworkProfile = require('./fixtures/syntheticFrameworkProfile.json');

const clone = value => JSON.parse(JSON.stringify(value));
const ENGINE = path.join(__dirname, '../api/shared/assessmentEngine');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ENGINE, file))).digest('hex');

function input(profile, engine, answers) {
    const value = {
        schemaVersion: 1, scoreContractVersion: engine.SCORE_CONTRACT_VERSION,
        organisationId: 'org-test', moduleId: 'module-test', assessmentId: 'assessment-test', assessmentRevision: 'rev-1',
        profileRef: { frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
            profileId: profile.profile.id, profileVersion: profile.profile.version, catalogueSha256: profile.catalogueSha256,
            ...(profile.sourceCatalogueSha256 ? { sourceCatalogueSha256: profile.sourceCatalogueSha256 } : {}) },
        scoreAsOf: '2026-11-17T10:00:00.000Z', scopePopulationSha256: '1'.repeat(64),
        evidenceSnapshot: { id: 'evidence-snapshot-1', sha256: '0'.repeat(64) },
        riskContextSnapshot: { id: 'risk-snapshot-1', sha256: '0'.repeat(64) },
        atomInputs: profile.questions.map((question, index) => ({ itemId: question.id,
            ...(answers[index] ? { response: { optionId: answers[index] } } : {}),
            ...(answers[index] === 'not_applicable' ? { applicabilityClaim: { rationaleSha256: '4'.repeat(64) } } : {}),
            evidenceState: 'not_provided', statedImpact: 'unspecified', priorityOverlay: 'none' }))
    };
    value.evidenceSnapshot.sha256 = engine.calculateEvidenceSnapshotSha256(
        value.atomInputs.map(atom => ({ itemId: atom.itemId, evidenceState: atom.evidenceState })));
    value.riskContextSnapshot.sha256 = engine.calculateRiskContextSnapshotSha256(
        value.atomInputs.map(atom => ({ itemId: atom.itemId, statedImpact: atom.statedImpact, priorityOverlay: atom.priorityOverlay })));
    return value;
}

// The 16-question shape from #399: weights total 31, a standard ladder and an MFA-method ladder with no plain "no".
const WEIGHTS = [1, 2, 1, 2, 3, 2, 1, 2, 3, 3, 1, 2, 3, 1, 2, 2];
const STANDARD = ['yes', 'partly', 'ad_hoc', 'no', 'unknown', 'not_applicable'];
const METHOD = ['key', 'number_matching', 'push', 'authenticator', 'text_code', 'mixed', 'unknown', 'not_applicable'];
function gradedFixture(change) {
    const definition = clone(syntheticFrameworkProfile);
    definition.profile.version = '2.0.0-graded-r1';
    definition.domains = [definition.domains[0]]; definition.controls = [definition.controls[0]];
    definition.responseOptions = [
        { id: 'yes', label: 'Planned and tracked', applicable: true, implementationFactor: 1 },
        { id: 'partly', label: 'Partly in place', applicable: true, implementationFactor: 0.5 },
        { id: 'ad_hoc', label: 'Ad hoc', applicable: true, implementationFactor: 0.25 },
        { id: 'no', label: 'No', applicable: true, implementationFactor: 0 },
        { id: 'unknown', label: 'I do not know', applicable: true, implementationFactor: null },
        { id: 'not_applicable', label: 'Not applicable', applicable: false, implementationFactor: null },
        { id: 'key', label: 'Security key or passkey', applicable: true, implementationFactor: 1 },
        { id: 'number_matching', label: 'Number matching', applicable: true, implementationFactor: 0.85 },
        { id: 'push', label: 'Push notification', applicable: true, implementationFactor: 0.7 },
        { id: 'authenticator', label: 'Authenticator app', applicable: true, implementationFactor: 0.55 },
        { id: 'text_code', label: 'Text or email code only', applicable: true, implementationFactor: 0.3 },
        { id: 'mixed', label: 'A mix including text or email codes', applicable: true, implementationFactor: 0.3 }
    ];
    const template = definition.questions[0];
    definition.questions = WEIGHTS.map((weight, index) => ({ ...clone(template), id: `SYN-V2-Q-${String(index + 1).padStart(2, '0')}`,
        order: index + 1, weight, responseOptionIds: index === 5 ? METHOD.slice() : STANDARD.slice() }));
    if (change) change(definition);
    definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
    const registry = createFrameworkRegistry([definition]);
    return { registry, profile: registry.getProfile(definition.profile.id, definition.profile.version) };
}
// The worked example in #399 (an 8-person firm).
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'text_code', 'unknown', 'partly', 'partly', 'no', 'no', 'no', 'ad_hoc', 'partly', 'no', 'unknown'];

describe('scoring v2 evaluator', () => {
    test('has its own pinned digest and version, and leaves the v1 evaluator byte-identical', () => {
        expect(ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256).toBe(sha('assessmentEvaluatorV2.js'));
        expect(ASSESSMENT_EVALUATOR_V2_VERSION).toBe('2026-11-17.1');
        expect(v2.ASSESSMENT_EVALUATOR_VERSION).toBe('2026-11-17.1');
        expect(v2.SCORE_CONTRACT_VERSION).toBe('PROD-003-R2');
        expect(v2.CREDIT_UNIT_SCALE).toBe(100);
        // The v1 digest the dashboard client checks before showing any existing result.
        expect(ASSESSMENT_EVALUATOR_SOURCE_SHA256).toBe('d27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e');
        expect(sha('assessmentEvaluator.js')).toBe(ASSESSMENT_EVALUATOR_SOURCE_SHA256);
        expect(v1.ASSESSMENT_EVALUATOR_VERSION).toBe('2026-09-02.1');
        const source = fs.readFileSync(path.join(ENGINE, 'assessmentEvaluatorV2.js'), 'utf8');
        expect(source).not.toMatch(/Date\.now|Math\.random|globalThis\.fetch|process\.env/);
        expect(source).not.toMatch(/require\(['"]\.\/assessmentEvaluator(Version)?['"]\)/);
    });

    test('reproduces the worked example: 7.85 of 31 is 25.3%, with two unconfirmed answers', () => {
        const { registry, profile } = gradedFixture();
        const result = v2.evaluateAssessment(input(profile, v2, EXAMPLE), { registry });
        expect(result.attainment).toMatchObject({ status: 'scored', creditUnitScale: 100, lowerCreditUnits: 785,
            denominatorWeight: 31, lowerPercentTenths: 253, lowerDisplay: '25.3%' });
        // Unconfirmed answers still earn nothing in the headline figure; the upper figure assumes both are fully in place.
        expect(result.attainment.upperCreditUnits).toBe(785 + 100 + 200);
        expect(result.countsCompletion).toMatchObject({ totalAtoms: 16, applicableAtoms: 16, yes: 0, partial: 9, no: 5, unknown: 2, directUnknown: 2 });
        expect(result.atoms.map(atom => atom.responseCreditHundredths)).toEqual([0, 25, 50, 50, 50, 30, null, 50, 50, 0, 0, 0, 25, 50, 0, null]);
        expect(result.atoms.map(atom => atom.lowerCreditUnits)).toEqual([0, 50, 50, 100, 150, 60, 0, 100, 150, 0, 0, 0, 75, 50, 0, 0]);
        expect(result.provenance).toMatchObject({ evaluatorVersion: '2026-11-17.1', evaluatorSourceSha256: ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256,
            scoreContractVersion: 'PROD-003-R2' });
        expect(Object.isFrozen(result)).toBe(true);
        expect(v2.evaluateAssessment(input(profile, v2, EXAMPLE), { registry }).outputSha256).toBe(result.outputSha256);
    });

    test('every rung of both ladders earns its stated credit', () => {
        const { registry, profile } = gradedFixture();
        const credit = (index, optionId) => {
            const answers = EXAMPLE.slice(); answers[index] = optionId;
            return v2.evaluateAssessment(input(profile, v2, answers), { registry }).atoms[index];
        };
        expect(['yes', 'partly', 'ad_hoc', 'no'].map(id => credit(4, id).lowerCreditUnits)).toEqual([300, 150, 75, 0]);
        expect(['key', 'number_matching', 'push', 'authenticator', 'text_code', 'mixed'].map(id => credit(5, id).lowerCreditUnits))
            .toEqual([200, 170, 140, 110, 60, 60]);
        expect(credit(5, 'key').response).toBe('yes');
        expect(credit(5, 'push').response).toBe('partial');
        expect(credit(5, 'unknown')).toMatchObject({ response: 'unknown', lowerCreditUnits: 0, upperCreditUnits: 200, responseCreditHundredths: null });
    });

    test('a claimed not-applicable answer stays in the score as unconfirmed until it is approved', () => {
        const { registry, profile } = gradedFixture();
        const answers = EXAMPLE.slice(); answers[13] = 'not_applicable';
        const result = v2.evaluateAssessment(input(profile, v2, answers), { registry });
        expect(result.attainment.denominatorWeight).toBe(31);
        expect(result.atoms[13]).toMatchObject({ response: 'unknown', responseOrigin: 'claimed_not_applicable', lowerCreditUnits: 0, applicable: true });
        expect(result.countsCompletion.claimedNotApplicableAtoms).toBe(1);
    });

    test('a missing answer counts as unconfirmed', () => {
        const { registry, profile } = gradedFixture();
        const answers = EXAMPLE.slice(); answers[0] = null;
        const result = v2.evaluateAssessment(input(profile, v2, answers), { registry });
        expect(result.atoms[0]).toMatchObject({ response: 'unknown', responseOrigin: 'missing', lowerCreditUnits: 0 });
        expect(result.attainment.lowerCreditUnits).toBe(785);
    });

    test('on the current 14-question profile it gives the same percentages and counts as v1', () => {
        const profile = createNcscFrameworkProfile(), registry = getDefaultFrameworkRegistry();
        const ids = {};
        profile.responseOptions.forEach(option => {
            if (!option.applicable) ids.notApplicable = option.id;
            else ids[{ 1: 'yes', 0.5: 'partial', 0: 'no', null: 'unknown' }[String(option.implementationFactor)]] = option.id;
        });
        const patterns = [
            profile.questions.map((_q, i) => i < 3 ? ids.yes : i < 10 ? ids.partial : i < 12 ? ids.no : i === 12 ? ids.unknown : null),
            profile.questions.map((_q, i) => [ids.yes, ids.partial, ids.no, ids.unknown, null][i % 5]),
            profile.questions.map(() => ids.partial), profile.questions.map(() => ids.yes), profile.questions.map(() => null)
        ];
        for (const answers of patterns) {
            const before = v1.evaluateAssessment(input(profile, v1, answers), { registry });
            const after = v2.evaluateAssessment(input(profile, v2, answers), { registry });
            expect(after.countsCompletion).toEqual(before.countsCompletion);
            expect(after.evidence).toEqual(before.evidence);
            for (const key of ['status', 'denominatorWeight', 'lowerPercentTenths', 'upperPercentTenths', 'lowerDisplay', 'upperDisplay']) {
                expect(after.attainment[key]).toEqual(before.attainment[key]);
            }
            expect(after.attainment.lowerCreditUnits).toBe(before.attainment.lowerCreditUnits * 50);
            expect(after.attainment.upperCreditUnits).toBe(before.attainment.upperCreditUnits * 50);
            expect(after.atoms.map(atom => [atom.itemId, atom.response, atom.responseOrigin, atom.applicable]))
                .toEqual(before.atoms.map(atom => [atom.itemId, atom.response, atom.responseOrigin, atom.applicable]));
            expect(after.domains.map(row => [row.domainId, row.attainment.lowerPercentTenths, row.attainment.upperPercentTenths]))
                .toEqual(before.domains.map(row => [row.domainId, row.attainment.lowerPercentTenths, row.attainment.upperPercentTenths]));
        }
    });

    test('refuses an input written for the v1 score contract', () => {
        const { registry, profile } = gradedFixture();
        const value = input(profile, v2, EXAMPLE); value.scoreContractVersion = 'PROD-003-R1';
        expect(() => v2.evaluateAssessment(value, { registry })).toThrow(expect.objectContaining({ code: 'unsupported_score_contract_version' }));
    });

    test.each([
        ['a factor finer than hundredths', d => { d.responseOptions[2].implementationFactor = 0.255; }],
        ['two full-credit answers on one question', d => { d.questions[5].responseOptionIds.push('yes'); }],
        ['no full-credit answer', d => { d.questions[0].responseOptionIds = ['partly', 'ad_hoc', 'no', 'unknown', 'not_applicable']; }],
        ['no part-credit answer', d => { d.questions[0].responseOptionIds = ['yes', 'no', 'unknown', 'not_applicable']; }],
        ['no "I do not know" answer', d => { d.questions[0].responseOptionIds = ['yes', 'partly', 'no', 'not_applicable']; }],
        ['two zero-credit answers', d => { d.responseOptions.push({ id: 'never', label: 'Never', applicable: true, implementationFactor: 0 });
            d.questions[0].responseOptionIds.push('never'); }]
    ])('refuses a profile with %s', (_name, change) => {
        const { registry, profile } = gradedFixture(change);
        expect(() => v2.evaluateAssessment(input(profile, v2, EXAMPLE), { registry }))
            .toThrow(expect.objectContaining({ code: 'unsupported_response_semantics' }));
    });

    test('the v1 evaluator still refuses a graded profile, so v2 results can never be scored by v1', () => {
        const { registry, profile } = gradedFixture();
        expect(() => v1.evaluateAssessment(input(profile, v1, EXAMPLE), { registry }))
            .toThrow(expect.objectContaining({ code: 'unsupported_response_semantics' }));
    });
});
