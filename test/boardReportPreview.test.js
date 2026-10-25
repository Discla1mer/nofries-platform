'use strict';

const { buildBoardReportPreview, renderBoardReportPreviewHtml } = require('../api/shared/reporting/boardReportPreview');
const { evaluateAssessment, calculateApplicabilityDecisionSha256, calculateEvidenceSnapshotSha256,
    calculateRiskContextSnapshotSha256 } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json');
const copy = value => JSON.parse(JSON.stringify(value));
const input = () => copy(fixture.input);
const registry = createFrameworkRegistry([createAcceptedNcscFrameworkProfile()]);
const options = { registry };
const presentation = { generatedAt: '2026-09-14T09:00:00.000Z' };

function refreshSnapshots(value) {
    value.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(value.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    value.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(value.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
}
function excludedInput() {
    const value = input();
    const decisions = value.atomInputs.map(atom => {
        atom.response = { optionId: 'not_applicable' };
        atom.applicabilityClaim = { rationaleSha256: '4'.repeat(64) };
        const core = { decisionId: `decision-${atom.itemId}`, decisionRevision: 'decision-rev-1',
            organisationId: value.organisationId, moduleId: value.moduleId, assessmentId: value.assessmentId,
            assessmentRevision: value.assessmentRevision, itemId: atom.itemId, frameworkId: value.profileRef.frameworkId,
            frameworkVersion: value.profileRef.frameworkVersion, profileId: value.profileRef.profileId,
            profileVersion: value.profileRef.profileVersion, catalogueSha256: value.profileRef.catalogueSha256,
            scopePopulationSha256: value.scopePopulationSha256, status: 'approved', rationaleSha256: '4'.repeat(64),
            approvedBy: 'synthetic-reviewer', approvedAt: '2026-09-07T09:00:00.000Z' };
        atom.applicabilityDecision = { ...core, decisionSha256: calculateApplicabilityDecisionSha256(core) };
        return copy(atom.applicabilityDecision);
    });
    return { value, evaluatorOptions: { registry,
        applicabilityDecisionRegistry: { getDecision: digest => decisions.find(decision => decision.decisionSha256 === digest) } } };
}

describe('internal board report preview', () => {
    test('preserves independent NCSC golden figures and distinct evidence measures', () => {
        const preview = buildBoardReportPreview(input(), options, presentation);
        expect(preview).toMatchObject({ audience: 'internal_preview', status: 'draft',
            generatedAt: presentation.generatedAt, measures: {
                countsCompletion: { completionNumerator: 12, completionDenominator: 14, completionDisplay: '85.7%',
                    yes: 3, partial: 7, no: 2, unknown: 2, completionStatus: 'provisional' },
                attainment: { lowerCreditUnits: 13, upperCreditUnits: 17, denominatorWeight: 14,
                    lowerDisplay: '46.4%', upperDisplay: '60.7%' },
                evidence: { distribution: { attested: 11, not_provided: 3 },
                    providedCoverage: { numerator: 11, denominator: 14, display: '78.6%' },
                    substantiatedCoverage: { numerator: 0, display: '0.0%' }, testedCoverage: { numerator: 0, display: '0.0%' } },
                remediationPriority: { status: 'not_calculated', reason: 'priority_adapter_required' },
                trend: { status: 'not_requested' }
            } });
        expect(preview.followUp.map(item => item.questionCount)).toEqual([2, 9, 14]);
        expect(preview.limitations.join(' ')).toContain('upper bound is not achieved performance');
        expect(preview.limitations.join(' ')).toContain('remain in the denominator as unknown');
    });

    test('retains all evaluator provenance and digest without treating it as an issuance seal', () => {
        const source = input(), evaluated = evaluateAssessment(source, options);
        const preview = buildBoardReportPreview(source, options, presentation);
        expect(preview.provenance).toEqual(evaluated.provenance);
        expect(preview.sourceEvaluationSha256).toBe(evaluated.outputSha256);
        expect(preview.domains).toEqual(evaluated.domains);
        expect(preview.provenance).toMatchObject({ organisationId: source.organisationId,
            assessmentRevision: source.assessmentRevision, profileRef: source.profileRef,
            scopePopulationSha256: source.scopePopulationSha256, evidenceSnapshot: source.evidenceSnapshot,
            riskContextSnapshot: source.riskContextSnapshot });
        expect(preview).not.toHaveProperty('publicationEnvelope');
        expect(preview).not.toHaveProperty('approvedBy');
        expect(preview.limitations).toContain('Internal draft preview. This report has not been approved or issued.');
    });

    test('repeats deterministically with frozen nested values and no source mutation or ambient clock', () => {
        const source = input(), before = copy(source);
        const now = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('ambient clock called'); });
        try {
            const first = buildBoardReportPreview(source, options, presentation);
            expect(buildBoardReportPreview(source, options, presentation)).toEqual(first);
            expect(renderBoardReportPreviewHtml(source, options, presentation)).toBe(renderBoardReportPreviewHtml(source, options, presentation));
            for (const value of [first, first.provenance, first.measures, first.measures.evidence.distribution,
                first.domains[0], first.followUp[0], first.limitations]) expect(Object.isFrozen(value)).toBe(true);
            expect(() => { first.generatedAt = 'changed'; }).toThrow(TypeError);
            expect(source).toEqual(before);
        } finally { now.mockRestore(); }
    });

    test('generation time changes only preview time and never rewrites the assessment date or digest', () => {
        const first = buildBoardReportPreview(input(), options, presentation);
        const second = buildBoardReportPreview(input(), options, { generatedAt: '2026-09-15T00:00:00.000Z' });
        expect({ ...second, generatedAt: first.generatedAt }).toEqual(first);
        expect(second.provenance.scoreAsOf).toBe('2026-09-07T10:00:00.000Z');
    });

    test('all missing responses stay provisional with a 0–100% range', () => {
        const source = input();
        source.atomInputs.forEach(atom => { delete atom.response; delete atom.applicabilityClaim; });
        const preview = buildBoardReportPreview(source, options, presentation);
        expect(preview.measures.countsCompletion).toMatchObject({ unknown: 14, missing: 14, completionDisplay: '0.0%', completionStatus: 'provisional' });
        expect(preview.measures.attainment).toMatchObject({ lowerDisplay: '0.0%', upperDisplay: '100.0%' });
        const html = renderBoardReportPreviewHtml(source, options, presentation);
        expect(html).toContain('Provisional assessment');
        expect(html).toContain('0.0%–100.0%');
        expect(html).not.toContain('Responses complete');
    });

    test('all trusted exclusions render Not scored rather than zero or complete', () => {
        const { value, evaluatorOptions } = excludedInput();
        const preview = buildBoardReportPreview(value, evaluatorOptions, presentation);
        expect(preview.measures.attainment).toMatchObject({ status: 'not_scored', lowerDisplay: null, upperDisplay: null });
        expect(preview.measures.countsCompletion).toMatchObject({ applicableAtoms: 0, approvedNotApplicableAtoms: 14, completionDisplay: null });
        expect(preview.measures.evidence.substantiatedCoverage).toMatchObject({ denominator: 0, display: null });
        const html = renderBoardReportPreviewHtml(value, evaluatorOptions, presentation);
        expect(html).toContain('Not scored');
        expect(html).not.toContain('Responses complete');
        expect(html).not.toContain('0.0%');
        expect(preview.limitations.join(' ')).toContain('excluded from applicable-question and evidence denominators');
    });

    test('an untrusted applicability decision does not exclude questions', () => {
        const { value } = excludedInput();
        expect(() => buildBoardReportPreview(value, options, presentation)).toThrow();
        expect(() => renderBoardReportPreviewHtml(value, options, presentation)).toThrow();
    });

    test('evidence changes coverage while retaining the independent attainment result', () => {
        const source = input(), first = buildBoardReportPreview(source, options, presentation);
        source.atomInputs.forEach(atom => { atom.evidenceState = 'tested_or_observed_current'; });
        refreshSnapshots(source);
        const changed = buildBoardReportPreview(source, options, presentation);
        expect(changed.measures.attainment).toEqual(first.measures.attainment);
        expect(changed.measures.countsCompletion).toEqual(first.measures.countsCompletion);
        expect(changed.measures.evidence.testedCoverage).toMatchObject({ numerator: 14, display: '100.0%' });
        expect(changed.followUp.find(item => item.kind === 'review_supporting_evidence').questionCount).toBe(0);
        expect(changed.sourceEvaluationSha256).not.toBe(first.sourceEvaluationSha256);
    });

    test('stale, disputed, inaccessible and unavailable evidence remain visible without current credit', () => {
        const source = input();
        ['stale', 'disputed', 'inaccessible', 'unavailable'].forEach((state, index) => { source.atomInputs[index].evidenceState = state; });
        refreshSnapshots(source);
        const preview = buildBoardReportPreview(source, options, presentation);
        expect(preview.measures.evidence.distribution).toMatchObject({ stale: 1, disputed: 1, inaccessible: 1, unavailable: 1 });
        expect(preview.measures.evidence.substantiatedCoverage.numerator).toBe(0);
        const html = renderBoardReportPreviewHtml(source, options, presentation);
        for (const label of ['Stale', 'Disputed', 'Inaccessible', 'Unavailable']) expect(html).toContain(`<th scope="row">${label}</th><td>1</td>`);
    });

    test('HTML shows separate measures, domain identities, follow-up, limits and all provenance fields', () => {
        const html = renderBoardReportPreviewHtml(input(), options, presentation);
        const preview = buildBoardReportPreview(input(), options, presentation);
        expect(html).toContain('<html lang="en-NZ">');
        expect(html).toContain('INTERNAL DRAFT · NOT ISSUED');
        for (const label of ['Response completion', 'Implementation attainment', 'Current supporting evidence',
            'Tested or observed evidence', 'Framework areas', 'Management follow-up', 'Scope and limitations',
            'Reproducibility and provenance', '46.4%–60.7%', '85.7%', 'not a risk-ranked action plan']) expect(html).toContain(label);
        for (const domain of preview.domains) expect(html).toContain(domain.domainId);
        for (const value of [preview.sourceEvaluationSha256, preview.provenance.evaluatorSourceSha256,
            preview.provenance.resolvedInputSha256, preview.provenance.evidenceSnapshot.sha256,
            preview.provenance.riskContextSnapshot.sha256]) expect(html).toContain(value);
        expect(html).toContain('not independent certification');
        expect(html).toContain('no improvement over time is claimed');
        expect(html).not.toMatch(/<script\b|<iframe\b|<form\b|<button\b|<a\b|\bsrc=|\bhref=|\bon\w+=|url\(/i);
    });

    test('does not expose applicability rationale digests, reviewers or individual answer payloads', () => {
        const { value, evaluatorOptions } = excludedInput();
        const preview = buildBoardReportPreview(value, evaluatorOptions, presentation);
        const html = renderBoardReportPreviewHtml(value, evaluatorOptions, presentation);
        expect(preview).not.toHaveProperty('atoms');
        for (const sensitive of ['synthetic-reviewer', '4'.repeat(64), 'decision-NF-NCSC']) {
            expect(JSON.stringify(preview)).not.toContain(sensitive);
            expect(html).not.toContain(sensitive);
        }
    });

    test.each(['build', 'render'])('%s rejects a supplied output object or forged numeric input', mode => {
        const fn = mode === 'build' ? buildBoardReportPreview : renderBoardReportPreviewHtml;
        const preview = buildBoardReportPreview(input(), options, presentation);
        const forged = { ...preview, measures: { attainment: { lowerDisplay: '100.0%' } } };
        expect(() => fn(forged, options, presentation)).toThrow();
        expect(() => fn({ ...input(), attainment: { lowerDisplay: '100.0%' } }, options, presentation)).toThrow();
        const changed = input(); changed.evidenceSnapshot.sha256 = '0'.repeat(64);
        expect(() => fn(changed, options, presentation)).toThrow();
    });

    test.each([undefined, {}, { generatedAt: '2026-02-30T10:00:00.000Z' },
        { generatedAt: '2026-09-14' }, { generatedAt: '2026-09-01T00:00:00.000Z' },
        { generatedAt: presentation.generatedAt, approved: true }])('rejects missing, invalid, retroactive or expanded presentation options %#', value => {
        for (const fn of [buildBoardReportPreview, renderBoardReportPreviewHtml]) {
            expect(() => fn(input(), options, value)).toThrow('board_report_preview_presentation_invalid');
        }
    });

    test('does not invoke accessors while validating presentation or source', () => {
        const getter = jest.fn(() => presentation.generatedAt);
        const accessor = Object.defineProperty({}, 'generatedAt', { enumerable: true, get: getter });
        expect(() => buildBoardReportPreview(input(), options, accessor)).toThrow();
        expect(getter).not.toHaveBeenCalled();
        const source = input();
        Object.defineProperty(source, 'organisationId', { enumerable: true, get: getter });
        expect(() => renderBoardReportPreviewHtml(source, options, presentation)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    test('rejects markup in identifiers and timestamp rather than rendering executable content', () => {
        const source = input(); source.organisationId = '<img src=x onerror=alert(1)>';
        expect(() => renderBoardReportPreviewHtml(source, options, presentation)).toThrow();
        expect(() => renderBoardReportPreviewHtml(input(), options, { generatedAt: '<script>alert(1)</script>' })).toThrow();
    });
});
