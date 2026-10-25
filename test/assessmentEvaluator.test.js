'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    ASSESSMENT_EVALUATOR_VERSION,
    AssessmentEvaluationError,
    calculateApplicabilityDecisionSha256,
    calculateEvidenceSnapshotSha256,
    calculateRiskContextSnapshotSha256,
    evaluateAssessment,
    serialiseAssessmentEvaluation
} = require('../api/shared/assessmentEngine/assessmentEvaluator');
const {
    ASSESSMENT_EVALUATOR_SOURCE_SHA256
} = require('../api/shared/assessmentEngine/assessmentEvaluatorVersion');
const {
    calculateFrameworkProfileSha256,
    createFrameworkRegistry
} = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const {
    createNcscFrameworkProfile,
    getDefaultFrameworkRegistry
} = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const golden = require('./fixtures/assessmentEvaluatorGolden.json');
const syntheticFrameworkProfile = require('./fixtures/syntheticFrameworkProfile.json');

const SCORE_AS_OF = '2026-09-02T10:00:00.000Z';
const SCOPE_SHA256 = '1'.repeat(64);
const RATIONALE_SHA256 = '4'.repeat(64);

describe('deterministic assessment evaluator', () => {
    test('reproduces PROD-003 example A with exact raw units and one-place display values', () => {
        const profile = createNcscFrameworkProfile();
        expect(profile.questions).toHaveLength(14);
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        input.atomInputs.forEach((atom, index) => {
            if (index < 3) atom.response = { optionId: optionIds.yes };
            else if (index < 10) atom.response = { optionId: optionIds.partial };
            else if (index < 12) atom.response = { optionId: optionIds.no };
            else if (index === 12) atom.response = { optionId: optionIds.unknown };
            else approveNotApplicable(input, atom, optionIds.notApplicable, index);
        });

        const result = evaluateAssessment(
            input,
            evaluationOptions(getDefaultFrameworkRegistry(), input)
        );

        expect(result.countsCompletion).toEqual(golden.prod003ExampleA.countsCompletion);
        expect(result.attainment).toEqual(golden.prod003ExampleA.attainment);
        expect(result.remediationPriority).toEqual({
            status: 'not_calculated',
            reason: 'priority_adapter_required'
        });
        expect(result.trend).toEqual({ status: 'not_requested' });
    });

    test('aggregates weighted leaves rather than averaging displayed parent percentages', () => {
        const { profile, registry } = createWeightedFixture();
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        const responses = [optionIds.yes, optionIds.partial, optionIds.no, optionIds.unknown];
        input.atomInputs.forEach((atom, index) => {
            atom.response = { optionId: responses[index] };
        });

        const result = evaluateAssessment(input, { registry });

        expect(result.countsCompletion).toEqual(golden.weightedAggregation.countsCompletion);
        expect(result.attainment).toEqual(golden.weightedAggregation.attainment);
        expect(sum(result.controls, 'lowerCreditUnits')).toBe(result.attainment.lowerCreditUnits);
        expect(sum(result.controls, 'upperCreditUnits')).toBe(result.attainment.upperCreditUnits);
        expect(sum(result.domains, 'denominatorWeight')).toBe(result.attainment.denominatorWeight);
    });

    test('reproduces PROD-003 example B evidence and missing-response lanes', () => {
        const { profile, registry } = createEqualFixture();
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        input.atomInputs[0].response = { optionId: optionIds.yes };
        input.atomInputs[0].evidenceState = 'documented_current';
        input.atomInputs[1].response = { optionId: optionIds.partial };
        input.atomInputs[1].evidenceState = 'attested';
        approveNotApplicable(input, input.atomInputs[3], optionIds.notApplicable, 3);
        refreshSnapshotDigests(input);

        const result = evaluateAssessment(input, evaluationOptions(registry, input));

        expect(result.countsCompletion).toEqual(golden.prod003ExampleB.countsCompletion);
        expect(result.attainment).toEqual(golden.prod003ExampleB.attainment);
        expect(result.evidence.distribution).toMatchObject({
            not_provided: 1,
            attested: 1,
            documented_current: 1
        });
        expect(result.evidence.providedCoverage).toMatchObject({
            numerator: 2,
            denominator: 3,
            percentTenths: 667,
            display: '66.7%'
        });
        expect(result.evidence.substantiatedCoverage).toMatchObject({
            numerator: 1,
            denominator: 3,
            percentTenths: 333,
            display: '33.3%'
        });
        expect(result.evidence.testedCoverage).toMatchObject({
            numerator: 0,
            denominator: 3,
            percentTenths: 0,
            display: '0.0%'
        });
    });

    test('reproduces PROD-003 example C before and after approved exclusions', () => {
        const { profile, registry } = createTwelveAtomFixture();
        const pending = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        pending.atomInputs.forEach((atom, index) => {
            if (index < 6) atom.response = { optionId: optionIds.yes };
            else if (index < 8) atom.response = { optionId: optionIds.partial };
            else if (index < 10) atom.response = { optionId: optionIds.no };
            else {
                atom.response = { optionId: optionIds.notApplicable };
                atom.applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };
            }
        });
        const approved = clone(pending);
        approved.assessmentRevision = 'rev-2';
        approveNotApplicable(approved, approved.atomInputs[10], optionIds.notApplicable, 10);
        approveNotApplicable(approved, approved.atomInputs[11], optionIds.notApplicable, 11);

        const pendingResult = evaluateAssessment(pending, evaluationOptions(registry, pending));
        const approvedResult = evaluateAssessment(approved, evaluationOptions(registry, approved));

        expect(pendingResult.countsCompletion).toEqual(
            golden.prod003ExampleCPending.countsCompletion
        );
        expect(pendingResult.attainment).toEqual(golden.prod003ExampleCPending.attainment);
        expect(approvedResult.countsCompletion).toEqual(
            golden.prod003ExampleCApproved.countsCompletion
        );
        expect(approvedResult.attainment).toEqual(golden.prod003ExampleCApproved.attainment);
        expect(approvedResult.provenance.applicabilityBasisSha256).not.toBe(
            pendingResult.provenance.applicabilityBasisSha256
        );
    });

    test('is byte-identical when atom and object insertion order change', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'yes' });
        const permuted = reverseObjectKeys(clone(input));
        permuted.atomInputs = permuted.atomInputs.reverse().map(reverseObjectKeys);

        const first = evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() });
        const second = evaluateAssessment(permuted, { registry: getDefaultFrameworkRegistry() });

        expect(second).toEqual(first);
        expect(serialiseAssessmentEvaluation(second)).toBe(serialiseAssessmentEvaluation(first));
        expect(second.outputSha256).toBe(first.outputSha256);
        expect(second.atoms.map((atom) => atom.itemId)).toEqual(first.atoms.map((atom) => atom.itemId));
    });

    test('returns stable frozen output without mutating the caller input', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'partial' });
        const before = clone(input);

        const outputs = Array.from({ length: 20 }, () => evaluateAssessment(
            input,
            { registry: getDefaultFrameworkRegistry() }
        ));

        outputs.forEach((output) => expect(output).toEqual(outputs[0]));
        expect(input).toEqual(before);
        expect(Object.isFrozen(outputs[0])).toBe(true);
        expect(Object.isFrozen(outputs[0].attainment)).toBe(true);
        expect(() => { outputs[0].attainment.lowerCreditUnits = 999; }).toThrow(TypeError);
    });

    test('distinguishes missing, direct unknown and a claimed Not applicable response', () => {
        const { profile, registry } = createWeightedFixture();
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        input.atomInputs[1].response = { optionId: optionIds.unknown };
        input.atomInputs[2].response = { optionId: optionIds.notApplicable };
        input.atomInputs[2].applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };
        input.atomInputs[3].response = { optionId: optionIds.no };

        const result = evaluateAssessment(input, { registry });

        expect(result.countsCompletion).toMatchObject({
            applicableAtoms: 4,
            approvedNotApplicableAtoms: 0,
            claimedNotApplicableAtoms: 1,
            unknown: 3,
            directUnknown: 1,
            missing: 1,
            completionNumerator: 1
        });
        expect(result.atoms.map((atom) => atom.responseOrigin)).toEqual([
            'missing',
            'direct_unknown',
            'claimed_not_applicable',
            'direct'
        ]);
    });

    test('excludes only an exact approved Not applicable decision', () => {
        const { profile, registry } = createWeightedFixture();
        const pending = buildInput(profile, { response: 'yes' });
        const optionIds = responseOptionIds(profile);
        pending.atomInputs[3].response = { optionId: optionIds.notApplicable };
        pending.atomInputs[3].applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };
        const approved = clone(pending);
        approved.assessmentRevision = 'rev-2';
        approveNotApplicable(approved, approved.atomInputs[3], optionIds.notApplicable, 3);

        const pendingResult = evaluateAssessment(pending, evaluationOptions(registry, pending));
        const approvedResult = evaluateAssessment(approved, evaluationOptions(registry, approved));

        expect(pendingResult.countsCompletion).toMatchObject({
            applicableAtoms: 4,
            claimedNotApplicableAtoms: 1,
            approvedNotApplicableAtoms: 0
        });
        expect(approvedResult.countsCompletion).toMatchObject({
            applicableAtoms: 3,
            claimedNotApplicableAtoms: 0,
            approvedNotApplicableAtoms: 1
        });
        expect(approvedResult.provenance.applicabilityBasisSha256).not.toBe(
            pendingResult.provenance.applicabilityBasisSha256
        );
    });

    test('returns explicit not-scored/null results when every atom is approved Not applicable', () => {
        const { profile, registry } = createWeightedFixture();
        const input = buildInput(profile);
        const optionId = responseOptionIds(profile).notApplicable;
        input.atomInputs.forEach((atom, index) => approveNotApplicable(input, atom, optionId, index));

        const result = evaluateAssessment(input, evaluationOptions(registry, input));

        expect(result.status).toBe('not_scored');
        expect(result.countsCompletion).toMatchObject({
            applicableAtoms: 0,
            approvedNotApplicableAtoms: 4,
            completionDenominator: 0,
            completionStatus: 'not_scored',
            completionPercentTenths: null,
            completionDisplay: null
        });
        expect(result.attainment).toMatchObject({
            status: 'not_scored',
            denominatorWeight: 0,
            lowerPercentTenths: null,
            upperPercentTenths: null,
            lowerDisplay: null,
            upperDisplay: null
        });
        expect(result.evidence.providedCoverage.display).toBeNull();
    });

    test('keeps attainment independent from evidence, impact and reserved priority inputs', () => {
        const profile = createNcscFrameworkProfile();
        const baseline = buildInput(profile, { response: 'yes' });
        const changed = clone(baseline);
        changed.atomInputs.forEach((atom, index) => {
            atom.evidenceState = index % 2 === 0 ? 'independently_reviewed_current' : 'disputed';
            atom.statedImpact = 'critical';
            atom.priorityOverlay = 'critical_controls';
        });
        refreshSnapshotDigests(changed);

        const first = evaluateAssessment(baseline, { registry: getDefaultFrameworkRegistry() });
        const second = evaluateAssessment(changed, { registry: getDefaultFrameworkRegistry() });

        expect(second.attainment).toEqual(first.attainment);
        expect(second.countsCompletion).toEqual(first.countsCompletion);
        expect(second.evidence).not.toEqual(first.evidence);
        expect(second.outputSha256).not.toBe(first.outputSha256);
    });

    test('keeps evidence distribution independent from response changes', () => {
        const profile = createNcscFrameworkProfile();
        const yes = buildInput(profile, { response: 'yes' });
        const no = clone(yes);
        const noOption = responseOptionIds(profile).no;
        no.atomInputs.forEach((atom) => { atom.response.optionId = noOption; });

        const first = evaluateAssessment(yes, { registry: getDefaultFrameworkRegistry() });
        const second = evaluateAssessment(no, { registry: getDefaultFrameworkRegistry() });

        expect(second.evidence).toEqual(first.evidence);
        expect(second.attainment).not.toEqual(first.attainment);
    });

    test('keeps every evidence state distinct and applies the accepted coverage ladders', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'yes' });
        const states = [
            'not_provided',
            'attested',
            'documented_current',
            'tested_or_observed_current',
            'independently_reviewed_current',
            'stale',
            'inaccessible',
            'disputed',
            'unavailable'
        ];
        input.atomInputs.forEach((atom, index) => { atom.evidenceState = states[index % states.length]; });
        refreshSnapshotDigests(input);

        const result = evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() });

        expect(Object.keys(result.evidence.distribution)).toEqual(states);
        expect(result.evidence.distribution).toMatchObject({
            not_provided: 2,
            attested: 2,
            documented_current: 2,
            tested_or_observed_current: 2,
            independently_reviewed_current: 2,
            stale: 1,
            inaccessible: 1,
            disputed: 1,
            unavailable: 1
        });
        expect(result.evidence.providedCoverage).toMatchObject({ numerator: 8, denominator: 14 });
        expect(result.evidence.substantiatedCoverage).toMatchObject({ numerator: 6, denominator: 14 });
        expect(result.evidence.testedCoverage).toMatchObject({ numerator: 4, denominator: 14 });
    });

    test('pins the output digest to canonical validated output bytes', () => {
        const profile = createNcscFrameworkProfile();
        const result = evaluateAssessment(
            buildInput(profile, { response: 'partial' }),
            { registry: getDefaultFrameworkRegistry() }
        );
        const core = { ...result };
        delete core.outputSha256;
        const independentlyCalculated = crypto.createHash('sha256')
            .update('nofries:eng003:evaluation-output:v1\0', 'utf8')
            .update(independentCanonicalJson(core), 'utf8')
            .digest('hex');

        expect(result.outputSha256).toBe(independentlyCalculated);
        expect(JSON.parse(serialiseAssessmentEvaluation(result))).toEqual(result);
    });

    test('matches a literal full-output digest golden', () => {
        const profile = createLiteralGoldenProfile();
        const registry = { getProfile() { return clone(profile); } };
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        const responses = [optionIds.yes, optionIds.partial, optionIds.no, optionIds.unknown];
        input.atomInputs.forEach((atom, index) => {
            atom.response = { optionId: responses[index] };
        });

        const result = evaluateAssessment(input, { registry });

        expect(result.outputSha256).toBe(golden.literalOutputSha256);
        expect(result.atoms.map((atom) => atom.itemId)).toEqual(['q1', 'q2', 'q3', 'q4']);
        expect(result.controls.map((control) => control.controlId)).toEqual(['c1', 'c2']);
        expect(result.domains.map((domain) => domain.domainId)).toEqual(['d1', 'd2']);
    });

    test('rounds an exact positive half tie up at the display boundary', () => {
        const { profile, registry } = createEvaluatorFixture(
            [1, 7, 1, 1],
            '1.0.0-rounding-r1'
        );
        const input = buildInput(profile);
        const optionIds = responseOptionIds(profile);
        input.atomInputs[0].response = { optionId: optionIds.partial };
        input.atomInputs[1].response = { optionId: optionIds.no };
        approveNotApplicable(input, input.atomInputs[2], optionIds.notApplicable, 2);
        approveNotApplicable(input, input.atomInputs[3], optionIds.notApplicable, 3);

        const result = evaluateAssessment(input, evaluationOptions(registry, input));

        expect(result.attainment).toMatchObject({
            lowerCreditUnits: 1,
            denominatorWeight: 8,
            lowerPercentTenths: 63,
            lowerDisplay: '6.3%'
        });
    });

    test('fails closed when a governed framework source is past its review date', () => {
        const { profile } = createEqualFixture();
        const definition = clone(profile);
        definition.profile.version = '1.0.0-stale-source';
        definition.sources[0].reviewDueAt = '2026-09-01';
        definition.sources[0].reviewCadence = 'annual';
        definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
        const registry = createFrameworkRegistry([definition]);
        const staleProfile = registry.getProfile(definition.profile.id, definition.profile.version);

        expectEvaluationCode(
            () => evaluateAssessment(buildInput(staleProfile), { registry }),
            'framework_snapshot_stale'
        );
    });

    test('fails closed when score time predates the profile effective date', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile);
        input.scoreAsOf = '2025-10-29T23:59:59.999Z';

        expectEvaluationCode(
            () => evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() }),
            'profile_not_yet_effective'
        );

        input.scoreAsOf = '2025-10-30T00:00:00.000Z';
        expect(() => evaluateAssessment(
            input,
            { registry: getDefaultFrameworkRegistry() }
        )).not.toThrow();
    });

    test('rejects the valid ENG-001 fractional fixture as incompatible with PROD-003-R1', () => {
        const registry = createFrameworkRegistry([syntheticFrameworkProfile]);
        const input = buildInput(syntheticFrameworkProfile);

        expectEvaluationCode(() => evaluateAssessment(input, { registry }), 'invalid_atom_weight');
    });

    test.each([
        ['zero', 0, 'invalid_atom_weight'],
        ['unsupported factor', 0.25, 'unsupported_response_semantics']
    ])('rejects a profile with %s scoring semantics', (_label, value, code) => {
        const definition = clone(createNcscFrameworkProfile());
        definition.profile.version = `invalid-${_label.replace(' ', '-')}`;
        if (_label === 'zero') definition.questions[0].weight = value;
        else definition.responseOptions[0].implementationFactor = value;
        definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
        const registry = createFrameworkRegistry([definition]);
        const profile = registry.getProfile(definition.profile.id, definition.profile.version);

        expectEvaluationCode(() => evaluateAssessment(buildInput(profile), { registry }), code);
    });

    test('does not coerce string catalogue fields into response semantics', () => {
        const profile = createNcscFrameworkProfile();
        const invalidProfile = clone(profile);
        invalidProfile.responseOptions[0].applicable = 'true';
        invalidProfile.responseOptions[0].implementationFactor = '1';
        const registry = { getProfile() { return clone(invalidProfile); } };

        expectEvaluationCode(
            () => evaluateAssessment(buildInput(profile), { registry }),
            'unsupported_response_semantics'
        );
    });

    test.each([
        ['duplicate atom', (input) => { input.atomInputs[1].itemId = input.atomInputs[0].itemId; }, 'duplicate_atom_input'],
        ['unknown atom', (input) => { input.atomInputs[0].itemId = 'unknown-question'; }, 'unknown_atom_input'],
        ['missing atom record', (input) => { input.atomInputs.pop(); }, 'missing_atom_input'],
        ['null response', (input) => { input.atomInputs[0].response = null; }, 'null_response_invalid'],
        ['unknown option', (input) => { input.atomInputs[0].response = { optionId: 'not-a-real-option' }; }, 'response_option_not_allowed'],
        ['extra AI field', (input) => { input.aiGeneratedScore = 99; }, 'unknown_field'],
        ['latest version', (input) => { input.profileRef.profileVersion = 'latest'; }, 'invalid_version'],
        ['wrong catalogue digest', (input) => { input.profileRef.catalogueSha256 = 'f'.repeat(64); }, 'profile_digest_mismatch']
    ])('fails closed for %s', (_label, mutate, code) => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'yes' });
        mutate(input);
        expectEvaluationCode(
            () => evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() }),
            code
        );
    });

    test('requires a rationale for Not applicable and rejects fields on applicable responses', () => {
        const profile = createNcscFrameworkProfile();
        const optionIds = responseOptionIds(profile);
        const noRationale = buildInput(profile, { response: 'yes' });
        noRationale.atomInputs[0].response = { optionId: optionIds.notApplicable };
        const contradictory = buildInput(profile, { response: 'yes' });
        contradictory.atomInputs[0].applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };

        expectEvaluationCode(
            () => evaluateAssessment(noRationale, { registry: getDefaultFrameworkRegistry() }),
            'not_applicable_rationale_required'
        );
        expectEvaluationCode(
            () => evaluateAssessment(contradictory, { registry: getDefaultFrameworkRegistry() }),
            'contradictory_applicability_fields'
        );
    });

    test('rejects Not applicable when the exact question does not permit it', () => {
        const { profile } = createEqualFixture();
        const definition = clone(profile);
        definition.profile.version = '1.0.0-mandatory-atom';
        const notApplicableId = responseOptionIds(definition).notApplicable;
        definition.questions[0].responseOptionIds = definition.questions[0].responseOptionIds
            .filter((optionId) => optionId !== notApplicableId);
        definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
        const registry = createFrameworkRegistry([definition]);
        const mandatoryProfile = registry.getProfile(
            definition.profile.id,
            definition.profile.version
        );
        const input = buildInput(mandatoryProfile);
        input.atomInputs[0].response = { optionId: notApplicableId };
        input.atomInputs[0].applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };

        expectEvaluationCode(
            () => evaluateAssessment(input, { registry }),
            'response_option_not_allowed'
        );
    });

    test('rejects tampered and cross-assessment applicability decisions', () => {
        const profile = createNcscFrameworkProfile();
        const optionId = responseOptionIds(profile).notApplicable;
        const tampered = buildInput(profile, { response: 'yes' });
        approveNotApplicable(tampered, tampered.atomInputs[0], optionId, 0);
        tampered.atomInputs[0].applicabilityDecision.approvedBy = 'different-reviewer';
        const mismatched = buildInput(profile, { response: 'yes' });
        approveNotApplicable(mismatched, mismatched.atomInputs[0], optionId, 0);
        const decision = mismatched.atomInputs[0].applicabilityDecision;
        decision.assessmentId = 'different-assessment';
        const core = { ...decision };
        delete core.decisionSha256;
        decision.decisionSha256 = calculateApplicabilityDecisionSha256(core);

        expectEvaluationCode(
            () => evaluateAssessment(
                tampered,
                evaluationOptions(getDefaultFrameworkRegistry(), tampered)
            ),
            'applicability_decision_digest_mismatch'
        );
        expectEvaluationCode(
            () => evaluateAssessment(
                mismatched,
                evaluationOptions(getDefaultFrameworkRegistry(), mismatched)
            ),
            'applicability_decision_mismatch'
        );
    });

    test('does not accept a self-consistent approval without the trusted decision registry', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'yes' });
        approveNotApplicable(input, input.atomInputs[0], responseOptionIds(profile).notApplicable, 0);

        expectEvaluationCode(
            () => evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() }),
            'applicability_decision_untrusted'
        );
    });

    test('rejects a trusted registry record that differs from the submitted decision', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile, { response: 'yes' });
        approveNotApplicable(input, input.atomInputs[0], responseOptionIds(profile).notApplicable, 0);
        const different = clone(input.atomInputs[0].applicabilityDecision);
        different.approvedBy = 'different-reviewer';
        const options = {
            registry: getDefaultFrameworkRegistry(),
            applicabilityDecisionRegistry: {
                getDecision() { return clone(different); }
            }
        };

        expectEvaluationCode(
            () => evaluateAssessment(input, options),
            'applicability_decision_untrusted'
        );
    });

    test('fails when evidence or risk bodies do not match their pinned snapshot digests', () => {
        const profile = createNcscFrameworkProfile();
        const evidenceMismatch = buildInput(profile, { response: 'yes' });
        evidenceMismatch.atomInputs[0].evidenceState = 'attested';
        const riskMismatch = buildInput(profile, { response: 'yes' });
        riskMismatch.atomInputs[0].statedImpact = 'critical';

        expectEvaluationCode(
            () => evaluateAssessment(evidenceMismatch, { registry: getDefaultFrameworkRegistry() }),
            'evidence_snapshot_mismatch'
        );
        expectEvaluationCode(
            () => evaluateAssessment(riskMismatch, { registry: getDefaultFrameworkRegistry() }),
            'risk_context_snapshot_mismatch'
        );
    });

    test('rejects reuse of one trusted applicability decision identity across atoms', () => {
        const { profile, registry } = createEqualFixture();
        const input = buildInput(profile, { response: 'yes' });
        const optionId = responseOptionIds(profile).notApplicable;
        approveNotApplicable(input, input.atomInputs[0], optionId, 0);
        approveNotApplicable(input, input.atomInputs[1], optionId, 1);
        input.atomInputs[1].applicabilityDecision.decisionId =
            input.atomInputs[0].applicabilityDecision.decisionId;
        const core = { ...input.atomInputs[1].applicabilityDecision };
        delete core.decisionSha256;
        input.atomInputs[1].applicabilityDecision.decisionSha256 =
            calculateApplicabilityDecisionSha256(core);

        expectEvaluationCode(
            () => evaluateAssessment(input, evaluationOptions(registry, input)),
            'duplicate_applicability_decision'
        );
    });

    test('rejects proxy, accessor and sparse-array inputs before scoring', () => {
        const profile = createNcscFrameworkProfile();
        const proxyInput = new Proxy(buildInput(profile), {});
        const accessorInput = buildInput(profile);
        Object.defineProperty(accessorInput, 'trap', { enumerable: true, get() { return 'x'; } });
        const sparseInput = buildInput(profile);
        delete sparseInput.atomInputs[1];

        expectEvaluationCode(
            () => evaluateAssessment(proxyInput, { registry: getDefaultFrameworkRegistry() }),
            'non_plain_object'
        );
        expectEvaluationCode(
            () => evaluateAssessment(accessorInput, { registry: getDefaultFrameworkRegistry() }),
            'non_plain_object'
        );
        expectEvaluationCode(
            () => evaluateAssessment(sparseInput, { registry: getDefaultFrameworkRegistry() }),
            'non_plain_object'
        );
    });

    test('validates a plain-object length field as data rather than array metadata', () => {
        let getterCalled = false;
        const accessor = {};
        Object.defineProperty(accessor, 'length', {
            enumerable: true,
            get() {
                getterCalled = true;
                return 1;
            }
        });
        expectEvaluationCode(
            () => serialiseAssessmentEvaluation(accessor),
            'non_plain_object'
        );
        expect(getterCalled).toBe(false);

        const cycle = {};
        cycle.length = cycle;
        expectEvaluationCode(
            () => serialiseAssessmentEvaluation(cycle),
            'definition_too_complex'
        );

        expectEvaluationCode(
            () => serialiseAssessmentEvaluation({ length: 'x'.repeat((2 * 1024 * 1024) + 1) }),
            'input_too_large'
        );
    });

    test('rejects an oversized dense array before descriptor traversal', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile);
        input.atomInputs = new Array(4097).fill(null);

        expectEvaluationCode(
            () => evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() }),
            'input_too_large'
        );
    });

    test('rejects excessive object fanout before descriptor materialisation', () => {
        const profile = createNcscFrameworkProfile();
        const input = buildInput(profile);
        input.excessiveFanout = Object.fromEntries(
            Array.from({ length: 64001 }, (_unused, index) => [`key${index}`, 0])
        );

        expectEvaluationCode(
            () => evaluateAssessment(input, { registry: getDefaultFrameworkRegistry() }),
            'definition_too_complex'
        );
    });

    test('enforces the canonical byte limit after every primitive contribution', () => {
        const byteLimit = 2 * 1024 * 1024;
        expect(Buffer.byteLength(
            serialiseAssessmentEvaluation('x'.repeat(byteLimit - 2)),
            'utf8'
        )).toBe(byteLimit);
        const originalStringify = JSON.stringify;
        let stringifyCalls = 0;
        let oversizedError;
        JSON.stringify = () => {
            stringifyCalls += 1;
            throw new Error('unexpected JSON.stringify allocation');
        };
        try {
            serialiseAssessmentEvaluation('x'.repeat(byteLimit - 1));
        } catch (error) {
            oversizedError = error;
        } finally {
            JSON.stringify = originalStringify;
        }
        expect(oversizedError).toBeInstanceOf(AssessmentEvaluationError);
        expect(oversizedError.code).toBe('input_too_large');
        expect(stringifyCalls).toBe(0);

        const primitivePadding = 'x'.repeat(byteLimit - 22);
        [0, false, null].forEach((tail) => {
            expectEvaluationCode(
                () => serialiseAssessmentEvaluation({ padding: primitivePadding, tail }),
                'input_too_large'
            );
        });

        expectEvaluationCode(
            () => serialiseAssessmentEvaluation('\u0000'.repeat(Math.floor((byteLimit - 2) / 6) + 1)),
            'input_too_large'
        );

        const escapedKeys = Object.fromEntries(
            Array.from({ length: 1400 }, (_unused, index) => [
                `${'\u0000'.repeat(250)}${String(index).padStart(4, '0')}`,
                0
            ])
        );
        expectEvaluationCode(
            () => serialiseAssessmentEvaluation(escapedKeys),
            'input_too_large'
        );

        const containerHeavy = Object.fromEntries(
            Array.from({ length: 1000 }, (_unused, index) => [
                `k${String(index).padStart(4, '0')}`,
                {}
            ])
        );
        containerHeavy.padding = '';
        const baseBytes = Buffer.byteLength(independentCanonicalJson(containerHeavy), 'utf8');
        containerHeavy.padding = 'x'.repeat((byteLimit + 1) - baseBytes);
        expect(Buffer.byteLength(independentCanonicalJson(containerHeavy), 'utf8')).toBe(byteLimit + 1);
        expectEvaluationCode(
            () => serialiseAssessmentEvaluation(containerHeavy),
            'input_too_large'
        );
    });

    test('does not call clock, randomness, locale, network or AI to calculate numbers', () => {
        const profile = createNcscFrameworkProfile();
        const originalDateNow = Date.now;
        const originalRandom = Math.random;
        const originalFetch = globalThis.fetch;
        Date.now = () => { throw new Error('clock called'); };
        Math.random = () => { throw new Error('random called'); };
        globalThis.fetch = () => { throw new Error('network called'); };
        try {
            const result = evaluateAssessment(
                buildInput(profile, { response: 'partial' }),
                { registry: getDefaultFrameworkRegistry() }
            );
            expect(result.attainment.lowerDisplay).toBe('50.0%');
        } finally {
            Date.now = originalDateNow;
            Math.random = originalRandom;
            globalThis.fetch = originalFetch;
        }

        const source = fs.readFileSync(
            path.join(__dirname, '../api/shared/assessmentEngine/assessmentEvaluator.js'),
            'utf8'
        );
        expect(source).not.toMatch(/require\(['"](?:https?|openai|anthropic|ai)['"]\)/i);
        expect(source).not.toMatch(/Date\.now|Math\.random|globalThis\.fetch|process\.env/);
    });

    test('pins a real evaluator source digest and explicit evaluator version', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../api/shared/assessmentEngine/assessmentEvaluator.js')
        );
        expect(ASSESSMENT_EVALUATOR_SOURCE_SHA256).toBe(
            crypto.createHash('sha256').update(source).digest('hex')
        );
        expect(ASSESSMENT_EVALUATOR_VERSION).toBe('2026-09-02.1');
    });
});

function buildInput(profile, options = {}) {
    const optionIds = responseOptionIds(profile);
    const input = {
        schemaVersion: 1,
        scoreContractVersion: 'PROD-003-R1',
        organisationId: 'org-test',
        moduleId: 'module-test',
        assessmentId: 'assessment-test',
        assessmentRevision: 'rev-1',
        profileRef: {
            frameworkId: profile.framework.id,
            frameworkVersion: profile.framework.version,
            profileId: profile.profile.id,
            profileVersion: profile.profile.version,
            catalogueSha256: profile.catalogueSha256,
            ...(profile.sourceCatalogueSha256
                ? { sourceCatalogueSha256: profile.sourceCatalogueSha256 }
                : {})
        },
        scoreAsOf: SCORE_AS_OF,
        scopePopulationSha256: SCOPE_SHA256,
        evidenceSnapshot: { id: 'evidence-snapshot-1', sha256: '0'.repeat(64) },
        riskContextSnapshot: { id: 'risk-snapshot-1', sha256: '0'.repeat(64) },
        atomInputs: profile.questions.map((question) => ({
            itemId: question.id,
            ...(options.response ? { response: { optionId: optionIds[options.response] } } : {}),
            evidenceState: 'not_provided',
            statedImpact: 'unspecified',
            priorityOverlay: 'none'
        }))
    };
    refreshSnapshotDigests(input);
    return input;
}

function refreshSnapshotDigests(input) {
    input.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(
        input.atomInputs.map((atom) => ({
            itemId: atom.itemId,
            evidenceState: atom.evidenceState
        }))
    );
    input.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(
        input.atomInputs.map((atom) => ({
            itemId: atom.itemId,
            statedImpact: atom.statedImpact,
            priorityOverlay: atom.priorityOverlay
        }))
    );
}

function responseOptionIds(profile) {
    const output = {};
    profile.responseOptions.forEach((option) => {
        if (!option.applicable) output.notApplicable = option.id;
        else if (option.implementationFactor === 1) output.yes = option.id;
        else if (option.implementationFactor === 0.5) output.partial = option.id;
        else if (option.implementationFactor === 0) output.no = option.id;
        else if (option.implementationFactor === null) output.unknown = option.id;
    });
    return output;
}

function approveNotApplicable(input, atom, optionId, index) {
    atom.response = { optionId };
    atom.applicabilityClaim = { rationaleSha256: RATIONALE_SHA256 };
    const core = {
        decisionId: `decision-${index + 1}`,
        decisionRevision: 'decision-rev-1',
        organisationId: input.organisationId,
        moduleId: input.moduleId,
        assessmentId: input.assessmentId,
        assessmentRevision: input.assessmentRevision,
        itemId: atom.itemId,
        frameworkId: input.profileRef.frameworkId,
        frameworkVersion: input.profileRef.frameworkVersion,
        profileId: input.profileRef.profileId,
        profileVersion: input.profileRef.profileVersion,
        catalogueSha256: input.profileRef.catalogueSha256,
        scopePopulationSha256: input.scopePopulationSha256,
        status: 'approved',
        rationaleSha256: RATIONALE_SHA256,
        approvedBy: 'reviewer-1',
        approvedAt: '2026-09-02T09:00:00.000Z'
    };
    atom.applicabilityDecision = {
        ...core,
        decisionSha256: calculateApplicabilityDecisionSha256(core)
    };
}

function evaluationOptions(registry, input) {
    const decisions = new Map(input.atomInputs
        .filter((atom) => atom.applicabilityDecision)
        .map((atom) => [
            atom.applicabilityDecision.decisionSha256,
            clone(atom.applicabilityDecision)
        ]));
    if (decisions.size === 0) return { registry };
    return {
        registry,
        applicabilityDecisionRegistry: {
            getDecision(decisionSha256) {
                const decision = decisions.get(decisionSha256);
                if (!decision) throw new Error('Decision is not trusted');
                return clone(decision);
            }
        }
    };
}

function createWeightedFixture() {
    return createEvaluatorFixture([1, 3, 2, 4], '1.0.0-scoring-r1');
}

function createEqualFixture() {
    return createEvaluatorFixture([1, 1, 1, 1], '1.0.0-equal-r1');
}

function createEvaluatorFixture(weights, version) {
    const definition = clone(syntheticFrameworkProfile);
    definition.profile.version = version;
    definition.responseOptions.push({
        id: 'unknown',
        label: 'Unknown',
        applicable: true,
        implementationFactor: null
    });
    definition.questions.forEach((question, index) => {
        question.weight = weights[index];
        question.responseOptionIds.push('unknown');
    });
    definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
    const registry = createFrameworkRegistry([definition]);
    return {
        profile: registry.getProfile(definition.profile.id, definition.profile.version),
        registry
    };
}

function createTwelveAtomFixture() {
    const definition = clone(syntheticFrameworkProfile);
    definition.profile.version = '1.0.0-twelve-atom-r1';
    definition.domains = [definition.domains[0]];
    definition.controls = [definition.controls[0]];
    const template = definition.questions[0];
    definition.questions = Array.from({ length: 12 }, (_unused, index) => ({
        ...clone(template),
        id: `SYN-C-Q-${String(index + 1).padStart(2, '0')}`,
        order: index + 1,
        weight: 1,
        responseOptionIds: [...template.responseOptionIds, 'unknown']
    }));
    definition.responseOptions.push({
        id: 'unknown',
        label: 'Unknown',
        applicable: true,
        implementationFactor: null
    });
    definition.catalogueSha256 = calculateFrameworkProfileSha256(definition);
    const registry = createFrameworkRegistry([definition]);
    return {
        profile: registry.getProfile(definition.profile.id, definition.profile.version),
        registry
    };
}

function createLiteralGoldenProfile() {
    return {
        framework: { id: 'framework-test', version: '1.0' },
        profile: { id: 'profile-test', version: '1.0' },
        catalogueSha256: 'a'.repeat(64),
        sources: [],
        domains: [
            { id: 'd1', order: 1 },
            { id: 'd2', order: 2 }
        ],
        controls: [
            { id: 'c1', domainId: 'd1', order: 1, sourceReferences: [] },
            { id: 'c2', domainId: 'd2', order: 1, sourceReferences: [] }
        ],
        questions: [
            {
                id: 'q1', controlId: 'c1', order: 1, weight: 1,
                responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'na']
            },
            {
                id: 'q2', controlId: 'c1', order: 2, weight: 3,
                responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'na']
            },
            {
                id: 'q3', controlId: 'c2', order: 1, weight: 2,
                responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'na']
            },
            {
                id: 'q4', controlId: 'c2', order: 2, weight: 4,
                responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'na']
            }
        ],
        responseOptions: [
            { id: 'yes', applicable: true, implementationFactor: 1 },
            { id: 'partial', applicable: true, implementationFactor: 0.5 },
            { id: 'no', applicable: true, implementationFactor: 0 },
            { id: 'unknown', applicable: true, implementationFactor: null },
            { id: 'na', applicable: false, implementationFactor: null }
        ]
    };
}

function expectEvaluationCode(action, code) {
    try {
        action();
        throw new Error(`Expected AssessmentEvaluationError (${code})`);
    } catch (error) {
        expect(error).toBeInstanceOf(AssessmentEvaluationError);
        expect(error.code).toBe(code);
        expect(error.message).not.toContain('unknown-question');
    }
}

function sum(groups, field) {
    return groups.reduce((total, group) => total + group.attainment[field], 0);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function reverseObjectKeys(value) {
    return Object.fromEntries(Object.entries(value).reverse());
}

function independentCanonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${independentCanonicalJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}
