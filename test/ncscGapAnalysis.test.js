'use strict';

const syntheticAssessment = require('../examples/ncsc-sme-gap-assessment.json');
const {
    EXPECTED_CATALOGUE_SHA256,
    PROFILE_ID,
    PROFILE_VERSION,
    calculateCatalogueSha256,
    getNcscGapProfile
} = require('../api/shared/securityGap/ncscProfile');
const {
    GapAssessmentValidationError,
    evaluateGapAssessment: evaluateGapAssessmentCore,
    projectCustomerGapReport
} = require('../api/shared/securityGap/evaluateGapAssessment');

describe('NCSC-aligned security gap profile', () => {
    test('pins the five Framework functions, ten Minimum Standard domains and four labelled extensions', () => {
        const profile = getNcscGapProfile();
        const extensions = profile.assessmentItems.filter((item) => item.itemType === 'critical_control_extension');
        const standards = profile.assessmentItems.filter((item) => item.itemType === 'minimum_standard');

        expect(profile.profileId).toBe(PROFILE_ID);
        expect(profile.profileVersion).toBe(PROFILE_VERSION);
        expect(profile.frameworkFunctions).toHaveLength(5);
        expect(profile.minimumStandards).toHaveLength(10);
        expect(extensions).toHaveLength(4);
        expect(profile.assessmentItems).toHaveLength(14);
        expect(profile.criticalControls).toHaveLength(10);
        expect(profile.catalogueSha256).toBe('5bdde37694c51757bbd470e44bf7fda5936f8193282228897f93a9be2db418a3');
        expect(profile.catalogueSha256).toBe(EXPECTED_CATALOGUE_SHA256);
        expect(calculateCatalogueSha256(profile)).toBe(profile.catalogueSha256);
        expect(unique(profile.frameworkFunctions.map((item) => item.id))).toHaveLength(5);
        expect(unique(profile.assessmentItems.map((item) => item.id))).toHaveLength(14);
        expect(standards.every((item) => item.sourceKind === 'ncsc_minimum_standard_adaptation')).toBe(true);
        expect(standards.every((item) => item.assessmentMode === 'high_level_domain_screen')).toBe(true);
        expect(extensions.every((item) => item.sourceKind === 'no_fries_sme_extension')).toBe(true);
        expect(profile.identifierNote).toContain('not NCSC-issued');
        expect(profile.mappingNote).toContain('No Fries interpretations');
        expect(profile.sourceScopeStatement).toContain('business-critical and externally facing systems');
        expect(profile.responseModel.adaptationNote).toContain('No Fries domain-screening prompts');
        expect(profile.maturityModel.assessmentSupport).toBe('reference_only');
    });

    test('keeps every mapping source-pinned, dated and bidirectionally consistent', () => {
        const profile = getNcscGapProfile();
        const functionIds = new Set(profile.frameworkFunctions.map((item) => item.id));
        const itemMap = new Map(profile.assessmentItems.map((item) => [item.id, item]));
        const criticalControlMap = new Map(profile.criticalControls.map((item) => [item.key, item]));

        profile.assessmentItems.forEach((item) => {
            expect(functionIds.has(item.frameworkFunctionId)).toBe(true);
            expect(item.sourceUrl).toMatch(/^https:\/\/www\.ncsc\.govt\.nz\//);
            item.criticalControlKeys.forEach((key) => {
                const control = criticalControlMap.get(key);
                expect(control).toBeDefined();
                expect(control.assessmentItemIds).toContain(item.id);
            });
        });
        profile.minimumStandards.forEach((item) => {
            expect(item.sourceUrl).not.toBe(profile.sources.minimumStandards.sourceUrl);
        });
        profile.criticalControls.forEach((control) => {
            expect(control.lastVerifiedAt).toBe('2026-08-31');
            expect(control.sourceDisplayOrder).toBeGreaterThan(0);
            expect(control.assessmentItemIds.length).toBeGreaterThan(0);
            control.assessmentItemIds.forEach((itemId) => expect(itemMap.has(itemId)).toBe(true));
        });
        expect(profile.sources.framework.licence).toBe('CC BY 4.0');
        expect(profile.sources.framework.licenceUrl).toMatch(/^https:\/\/www\.ncsc\.govt\.nz\//);
        expect(profile.sources.minimumStandards.title).toContain('2025 v3');
        expect(profile.sources.criticalControls.reviewDueAt).toBe('2027-08-31');
    });

    test('returns a defensive clone instead of mutable shared catalogue state', () => {
        const first = getNcscGapProfile();
        first.frameworkFunctions[0].name = 'Changed by caller';
        first.assessmentItems.length = 0;

        const second = getNcscGapProfile();
        expect(second.frameworkFunctions[0].name).toBe('Guide and Govern');
        expect(second.assessmentItems).toHaveLength(14);
    });
});

describe('NCSC-aligned security gap evaluator', () => {
    test('produces a transparent, deterministic domain screen and dated roadmap', () => {
        const inputBefore = JSON.stringify(syntheticAssessment);
        const options = { generatedAt: '2026-08-31T23:00:00.000Z' };
        const first = evaluateGapAssessment(syntheticAssessment, options);
        const second = evaluateGapAssessment(syntheticAssessment, options);

        expect(first).toEqual(second);
        expect(JSON.stringify(syntheticAssessment)).toBe(inputBefore);
        expect(first.audience).toBe('internal_assessment');
        expect(first.summary).toMatchObject({
            itemCount: 14,
            applicableCount: 13,
            notApplicableCount: 1,
            notApplicableReviewRequiredCount: 1,
            assessedCount: 12,
            unknownCount: 1,
            missingCount: 0,
            explicitUnknownCount: 1,
            completionPercent: 92.3
        });
        expect(first.summary.implementation).toMatchObject({
            yesCount: 3,
            partialCount: 7,
            noCount: 2,
            unknownCount: 1,
            numerator: 6.5,
            upperNumerator: 7.5,
            denominator: 13,
            progressLowerPercent: 50,
            progressUpperPercent: 57.7
        });
        expect(first.summary.implementation.label).toContain('not an NCSC score');
        expect(first.summary.evidence).toEqual({
            customerAssertedCount: 11,
            notProvidedCount: 2,
            referencedItemCount: 7,
            referencedCoveragePercent: 53.8,
            label: 'Self-assessment evidence state; no assessor verification is represented'
        });
        expect(first.summary.maturity).toEqual({
            model: 'NCSC CS-CMM',
            assessed: false,
            level: null,
            label: 'CS-CMM maturity is not assessed by this high-level domain screen'
        });
        expect(first.profile.catalogueSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(first.functions).toHaveLength(5);
        expect(first.functions.reduce((sum, item) => sum + item.itemCount, 0)).toBe(14);
        expect(first.functions.every((item) => Object.hasOwn(item, 'outcomeParaphrase'))).toBe(true);
        expect(first.findings).toHaveLength(13);
        expect(first.findings[0]).toMatchObject({
            itemId: 'NF-NCSC-CC-PM-01',
            sequencingMethod: 'no_fries_sequencing_v1',
            roadmapStage: 'now',
            dueDateStatus: 'within_recommended_window'
        });
        expect(first.findings.every((finding) => !Object.hasOwn(finding, 'priorityScore'))).toBe(true);
        expect(first.findings.every((finding) => !Object.keys(finding).some((key) => key.startsWith('_')))).toBe(true);
        expect(first.exceptions).toEqual([]);

        const roadmapItems = [
            ...first.roadmap.now.actions,
            ...first.roadmap.next.actions,
            ...first.roadmap.later.actions
        ];
        expect(roadmapItems).toHaveLength(13);
        expect(first.roadmap).toMatchObject({
            method: 'no_fries_sequencing_v1',
            anchorDate: '2026-08-31',
            now: { startDate: '2026-08-31', endDate: '2026-09-30' },
            next: { startDate: '2026-10-01', endDate: '2026-10-30' },
            later: { startDate: '2026-10-31', endDate: '2026-11-29' }
        });
        expect(first.roadmap.focusActions).toHaveLength(5);
        expect(first.roadmap.methodNote).toContain('not NCSC prioritisation or risk scoring');
    });

    test('keeps missing applicable items visible without silently treating them as failures', () => {
        const input = clone(syntheticAssessment);
        input.responses = {};
        const report = evaluateGapAssessment(input);

        expect(report.summary).toMatchObject({
            applicableCount: 14,
            assessedCount: 0,
            unknownCount: 14,
            missingCount: 14,
            explicitUnknownCount: 0,
            completionPercent: 0
        });
        expect(report.summary.implementation).toMatchObject({
            numerator: 0,
            upperNumerator: 14,
            denominator: 14,
            progressLowerPercent: 0,
            progressUpperPercent: 100
        });
        expect(report.summary.evidence.notProvidedCount).toBe(14);
        expect(report.summary.maturity.assessed).toBe(false);
        expect(report.findings).toHaveLength(14);
        expect(report.limitations.some((item) => item.includes('implementation-progress range'))).toBe(true);
    });

    test('requires an N/A rationale and refuses a screen with no assessable Minimum Standard domain', () => {
        const missingRationale = clone(syntheticAssessment);
        delete missingRationale.responses['NF-NCSC-CC-NS-01'].applicabilityRationale;
        expectValidationCode(() => evaluateGapAssessment(missingRationale), 'not_applicable_rationale_required');

        const allNotApplicable = clone(syntheticAssessment);
        const profile = getNcscGapProfile();
        allNotApplicable.responses = Object.fromEntries(profile.assessmentItems.map((item) => [
            item.id,
            { response: 'not_applicable', applicabilityRationale: 'Synthetic scope rationale.' }
        ]));
        expectValidationCode(() => evaluateGapAssessment(allNotApplicable), 'insufficient_assessable_scope');
    });

    test('reserves maturity, evidence verification and risk acceptance for stronger future workflows', () => {
        const target = clone(syntheticAssessment);
        target.targetMaturityLevel = 2;
        expectValidationCode(() => evaluateGapAssessment(target), 'maturity_not_supported_in_domain_screen');

        const maturity = clone(syntheticAssessment);
        maturity.responses['NF-NCSC-MCSS-MF-01'].maturityLevel = 3;
        expectValidationCode(() => evaluateGapAssessment(maturity), 'maturity_not_supported_in_domain_screen');

        const verified = clone(syntheticAssessment);
        verified.responses['NF-NCSC-MCSS-SA-01'].evidenceAssurance = 'verified';
        expectValidationCode(() => evaluateGapAssessment(verified), 'privileged_evidence_assurance_not_supported');

        const accepted = clone(syntheticAssessment);
        accepted.responses['NF-NCSC-MCSS-SC-01'].riskDecision = 'accept';
        expectValidationCode(() => evaluateGapAssessment(accepted), 'privileged_risk_acceptance_not_supported');
    });

    test('rejects explicitly supplied falsy enum values instead of applying defaults', () => {
        const itemId = 'NF-NCSC-CC-PM-01';
        const cases = [
            ['evidenceAssurance', 'invalid_evidenceassurance'],
            ['businessImpact', 'invalid_businessimpact'],
            ['riskDecision', 'invalid_riskdecision']
        ];
        const invalidValues = [false, 0, '', null, undefined];

        cases.forEach(([field, code]) => {
            invalidValues.forEach((value) => {
                const input = clone(syntheticAssessment);
                input.responses[itemId][field] = value;
                expectValidationCode(() => evaluateGapAssessment(input), code);
            });
        });

        const omitted = clone(syntheticAssessment);
        delete omitted.responses[itemId].evidenceAssurance;
        delete omitted.responses[itemId].businessImpact;
        delete omitted.responses[itemId].riskDecision;
        const result = evaluateGapAssessment(omitted).itemResults.find((item) => item.itemId === itemId);
        expect(result).toMatchObject({
            evidenceAssurance: 'not_provided',
            businessImpact: 'unspecified',
            riskDecision: 'open'
        });
    });

    test('accepts only opaque evidence references and rejects obvious secret material', () => {
        const linkReference = clone(syntheticAssessment);
        linkReference.responses['NF-NCSC-MCSS-SA-01'].evidenceRefs = ['https://example.test/evidence'];
        expectValidationCode(() => evaluateGapAssessment(linkReference), 'invalid_evidence_reference');

        const secretNarrative = clone(syntheticAssessment);
        secretNarrative.responses['NF-NCSC-MCSS-SA-01'].evidenceSummary = 'password=supersecret';
        expectValidationCode(() => evaluateGapAssessment(secretNarrative), 'secret_like_content_rejected');

        const mismatchedState = clone(syntheticAssessment);
        mismatchedState.responses['NF-NCSC-CC-PM-01'].evidenceRefs = ['evidence:synthetic-record'];
        expectValidationCode(() => evaluateGapAssessment(mismatchedState), 'evidence_state_reference_mismatch');

        const secretAction = clone(syntheticAssessment);
        secretAction.responses['NF-NCSC-MCSS-SA-01'].action = 'password=supersecret';
        expectValidationCode(() => evaluateGapAssessment(secretAction), 'secret_like_content_rejected');

        const secretSystem = clone(syntheticAssessment);
        secretSystem.scope.inScopeSystems = ['AKIA1234567890ABCDEF'];
        expectValidationCode(() => evaluateGapAssessment(secretSystem), 'secret_like_content_rejected');
    });

    test('requires explicit RFC 3339 offsets and consistent assessment chronology', () => {
        expectValidationCode(() => evaluateGapAssessmentCore(syntheticAssessment), 'generation_time_required');

        const timezoneLess = clone(syntheticAssessment);
        timezoneLess.assessedAt = '2026-08-31T22:00:00';
        expectValidationCode(() => evaluateGapAssessment(timezoneLess), 'invalid_date_time');

        const impossibleLeapDay = clone(syntheticAssessment);
        impossibleLeapDay.assessedAt = '2026-02-29T12:00:00Z';
        expectValidationCode(() => evaluateGapAssessment(impossibleLeapDay), 'invalid_date_time');

        const impossibleMonthDay = clone(syntheticAssessment);
        impossibleMonthDay.nextReviewAt = '2026-11-31T12:00:00+13:00';
        expectValidationCode(() => evaluateGapAssessment(impossibleMonthDay), 'invalid_date_time');

        const invalidEndOfDay = clone(syntheticAssessment);
        invalidEndOfDay.assessedAt = '2026-08-31T24:00:00Z';
        expectValidationCode(() => evaluateGapAssessment(invalidEndOfDay), 'invalid_date_time');

        const upperYearBoundary = clone(syntheticAssessment);
        upperYearBoundary.assessedAt = '9999-12-31T23:59:58-14:00';
        expectValidationCode(() => evaluateGapAssessment(upperYearBoundary), 'invalid_date_time');

        const lowerYearBoundary = clone(syntheticAssessment);
        lowerYearBoundary.assessedAt = '0000-01-01T00:00:00+14:00';
        expectValidationCode(() => evaluateGapAssessment(lowerYearBoundary), 'invalid_date_time');

        const roadmapOverflow = clone(syntheticAssessment);
        roadmapOverflow.assessedAt = '9999-12-30T00:00:00Z';
        delete roadmapOverflow.nextReviewAt;
        expectValidationCode(() => evaluateGapAssessment(roadmapOverflow, {
            generatedAt: '9999-12-31T00:00:00Z'
        }), 'invalid_date_time');

        const validLeapDay = clone(syntheticAssessment);
        validLeapDay.assessedAt = '2028-02-29T12:00:00+13:00';
        validLeapDay.nextReviewAt = '2028-03-01T12:00:00+13:00';
        const validLeapDayReport = evaluateGapAssessment(validLeapDay, {
            generatedAt: '2028-02-29T00:00:00Z'
        });
        expect(validLeapDayReport.assessment.assessedAt).toBe('2028-02-28T23:00:00.000Z');

        const earlyReview = clone(syntheticAssessment);
        earlyReview.nextReviewAt = '2026-08-30T22:00:00.000Z';
        expectValidationCode(() => evaluateGapAssessment(earlyReview), 'review_not_after_assessment');

        expectValidationCode(() => evaluateGapAssessment(syntheticAssessment, {
            generatedAt: '2026-08-31T21:59:59.000Z'
        }), 'generated_before_assessment');
    });

    test('rejects overlong identifiers and structured values instead of coercing them', () => {
        const longIdentifier = clone(syntheticAssessment);
        longIdentifier.assessmentId = `a${'b'.repeat(180)}`;
        expectValidationCode(() => evaluateGapAssessment(longIdentifier), 'text_limit_exceeded');

        const structuredScopeEntry = clone(syntheticAssessment);
        structuredScopeEntry.scope.inScopeSystems = [{ name: 'not a string' }];
        expectValidationCode(() => evaluateGapAssessment(structuredScopeEntry), 'array_string_required');

        const structuredNarrative = clone(syntheticAssessment);
        structuredNarrative.scope.notes = { text: 'not a string' };
        expectValidationCode(() => evaluateGapAssessment(structuredNarrative), 'text_string_required');
    });

    test('creates an allowlisted customer projection without internal evidence or sampled-system detail', () => {
        const input = clone(syntheticAssessment);
        input.responses['NF-NCSC-MCSS-RM-01'].evidenceSummary = 'Internal review narrative <script>alert(1)</script>';
        input.responses['NF-NCSC-MCSS-RM-01'].notes = 'Internal-only note';
        input.responses['NF-NCSC-MCSS-RM-01'].residualRisk = 'Internal residual-risk discussion';
        const internal = evaluateGapAssessment(input);
        const customer = projectCustomerGapReport(internal);
        const encoded = JSON.stringify(customer);

        expect(customer.audience).toBe('customer');
        expect(customer.assessment).not.toHaveProperty('organisationId');
        expect(customer.assessment.scope).not.toHaveProperty('sampledSystems');
        expect(customer.assessment.scope).not.toHaveProperty('notes');
        expect(customer.assessment.scope.minimumStandardsScopeRationale).toContain('business-critical');
        expect(encoded).not.toContain('synthetic:training-completion-2026');
        expect(encoded).not.toContain('Internal-only note');
        expect(encoded).not.toContain('Internal residual-risk discussion');
        expect(encoded).not.toContain('<script>');
        expect(findKeys(customer, new Set([
            'evidenceRefs',
            'evidenceSummary',
            'notes',
            'residualRisk',
            'decisionBy',
            'decisionEvidenceRef'
        ]))).toEqual([]);
        expect(customer.contentSafetyNote).toContain('output-encoded');
        expect(customer.sourceReportSha256).toBe(internal.internalReportSha256);

        const mutated = clone(internal);
        mutated.summary.internalOnly = 'must not project';
        expectValidationCode(() => projectCustomerGapReport(mutated), 'invalid_customer_report_source');
    });

    test('warns when the Critical Controls snapshot passes its scheduled review date', () => {
        const overdueAssessment = evaluateGapAssessment(syntheticAssessment, {
            generatedAt: '2027-01-01T00:00:00.000Z'
        });
        expect(overdueAssessment.limitations.some((item) => item.includes('past its recorded next-review date'))).toBe(true);

        const report = evaluateGapAssessment(syntheticAssessment, {
            generatedAt: '2027-09-01T00:00:00.000Z'
        });

        expect(report.limitations.some((item) => item.includes('past its scheduled review date'))).toBe(true);
    });

    test('rejects response IDs and profile versions outside the pinned registry', () => {
        const unknownItem = clone(syntheticAssessment);
        unknownItem.responses['NF-UNKNOWN-01'] = { response: 'no' };
        expectValidationCode(() => evaluateGapAssessment(unknownItem), 'unknown_assessment_item');

        const wrongProfile = clone(syntheticAssessment);
        wrongProfile.profileVersion = 'latest';
        expectValidationCode(() => evaluateGapAssessment(wrongProfile), 'unsupported_gap_profile');
    });

    test('keeps customer claims within a high-level, non-conformance boundary', () => {
        const report = evaluateGapAssessment(syntheticAssessment);
        const claim = `${report.profile.basisStatement} ${report.profile.claimStatement}`;

        expect(claim).toContain('High-level No Fries domain screening');
        expect(claim).toContain('adapted for SME use');
        expect(claim).toContain('does not assess every Minimum Standard requirement');
        expect(claim).toContain('not an NCSC certification, endorsement, official NCSC score');
    });
});

function expectValidationCode(action, code) {
    try {
        action();
        throw new Error(`Expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(GapAssessmentValidationError);
        expect(error.code).toBe(code);
    }
}

function evaluateGapAssessment(input, options = {}) {
    return evaluateGapAssessmentCore(input, Object.assign({
        generatedAt: '2026-08-31T23:00:00.000Z'
    }, options));
}

function findKeys(value, blocked, path = '$') {
    if (Array.isArray(value)) {
        return value.flatMap((item, index) => findKeys(item, blocked, `${path}[${index}]`));
    }
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => {
        const current = `${path}.${key}`;
        const found = blocked.has(key) ? [current] : [];
        return found.concat(findKeys(child, blocked, current));
    });
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function unique(values) {
    return [...new Set(values)];
}
