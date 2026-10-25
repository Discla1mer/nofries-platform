'use strict';

const crypto = require('crypto');

const {
    PROFILE_ID,
    PROFILE_VERSION,
    getNcscGapProfile
} = require('./ncscProfile');

const EVALUATOR_VERSION = '2026-09-01.1';
const RESPONSE_VALUES = new Set(['yes', 'partial', 'no', 'unknown', 'not_applicable']);
const EVIDENCE_VALUES = new Set(['customer_asserted', 'not_provided']);
const IMPACT_VALUES = new Set(['critical', 'high', 'medium', 'low', 'unspecified']);
const RISK_DECISIONS = new Set(['open', 'treat', 'transfer', 'avoid']);
const NO_FRIES_RESPONSE_WEIGHTS = Object.freeze({ yes: 1, partial: 0.5, no: 0, unknown: 0 });
const NO_FRIES_SEQUENCE_RESPONSE = Object.freeze({ yes: 10, partial: 30, no: 45, unknown: 35 });
const NO_FRIES_SEQUENCE_IMPACT = Object.freeze({ critical: 30, high: 20, medium: 10, low: 0, unspecified: 5 });
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const CANONICAL_UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_REFERENCE = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:-]{0,266}$/;
const DISALLOWED_REFERENCE_NAMESPACES = new Set(['blob', 'data', 'file', 'ftp', 'http', 'https', 'javascript']);

class GapAssessmentValidationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'GapAssessmentValidationError';
        this.code = details.code || 'invalid_gap_assessment';
        this.details = details;
    }
}

function evaluateGapAssessment(input, options = {}) {
    const profile = getNcscGapProfile();
    const assessment = normaliseAssessment(input, profile);
    if (!isPlainObject(options) || !options.generatedAt) {
        throw validationError('A trusted report-generation timestamp is required', {
            code: 'generation_time_required'
        });
    }
    const generatedAt = requiredIsoDateTime(options.generatedAt, 'generatedAt');
    if (generatedAt < assessment.assessedAt) {
        throw validationError('generatedAt cannot precede assessedAt', {
            code: 'generated_before_assessment'
        });
    }
    const itemMap = new Map(profile.assessmentItems.map((item) => [item.id, item]));

    Object.keys(assessment.sourceResponses).forEach((itemId) => {
        if (!itemMap.has(itemId)) {
            throw validationError('The assessment contains an item that is not in the pinned profile', {
                code: 'unknown_assessment_item',
                itemId
            });
        }
    });

    const itemResults = profile.assessmentItems.map((item) => {
        const response = normaliseResponse(assessment.sourceResponses[item.id], item);
        return Object.assign({
            itemId: item.id,
            itemKey: item.key,
            itemType: item.itemType,
            title: item.displayTitle || item.officialTitle,
            frameworkFunctionId: item.frameworkFunctionId,
            criticalControlKeys: [...item.criticalControlKeys],
            applicable: response.response !== 'not_applicable'
        }, response);
    });

    if (!itemResults.some((item) => item.itemType === 'minimum_standard' && item.applicable)) {
        throw validationError('At least one Minimum Standard domain must remain applicable', {
            code: 'insufficient_assessable_scope'
        });
    }

    const summary = buildSummary(itemResults, profile);
    const rankedFindings = itemResults
        .map((result, index) => buildFinding(result, itemMap.get(result.itemId), index))
        .filter(Boolean)
        .sort(sortFindings)
        .map((finding) => addRoadmapTiming(finding, generatedAt));
    const roadmap = buildRoadmap(rankedFindings, generatedAt);
    const functions = buildFunctionSummaries(profile, itemResults, rankedFindings);
    const findings = rankedFindings.map(publicFinding);
    const limitations = buildLimitations(profile, assessment, summary, generatedAt);

    const report = {
        schemaVersion: 1,
        audience: 'internal_assessment',
        evaluatorVersion: EVALUATOR_VERSION,
        generatedAt,
        assessment: {
            assessmentId: assessment.assessmentId,
            organisationId: assessment.organisationId,
            title: assessment.title,
            assessedAt: assessment.assessedAt,
            nextReviewAt: assessment.nextReviewAt,
            scope: assessment.scope
        },
        profile: {
            profileId: profile.profileId,
            profileVersion: profile.profileVersion,
            catalogueSha256: profile.catalogueSha256,
            title: profile.title,
            effectiveFrom: profile.effectiveFrom,
            lastVerifiedAt: profile.lastVerifiedAt,
            basisStatement: profile.basisStatement,
            claimStatement: profile.claimStatement,
            attribution: profile.attribution,
            identifierNote: profile.identifierNote,
            mappingNote: profile.mappingNote,
            sourceScopeStatement: profile.sourceScopeStatement,
            sources: profile.sources
        },
        summary,
        functions,
        findings,
        exceptions: [],
        roadmap,
        itemResults,
        limitations
    };
    return Object.assign({}, report, {
        internalReportSha256: calculateReportSha256(report)
    });
}

function normaliseAssessment(input, profile) {
    if (!isPlainObject(input)) {
        throw validationError('Assessment input must be an object', { code: 'assessment_object_required' });
    }
    const profileId = cleanRequiredText(input.profileId, 120, 'profileId');
    const profileVersion = cleanRequiredText(input.profileVersion, 80, 'profileVersion');
    if (profileId !== PROFILE_ID || profileVersion !== PROFILE_VERSION) {
        throw validationError('The assessment does not pin the current supported source profile', {
            code: 'unsupported_gap_profile',
            expectedProfileId: PROFILE_ID,
            expectedProfileVersion: PROFILE_VERSION
        });
    }
    if (Object.prototype.hasOwnProperty.call(input, 'targetMaturityLevel')) {
        throw validationError('This high-level domain screen does not assess CS-CMM maturity targets', {
            code: 'maturity_not_supported_in_domain_screen'
        });
    }
    const responses = input.responses == null ? {} : input.responses;
    if (!isPlainObject(responses)) {
        throw validationError('Assessment responses must be an object keyed by profile item ID', {
            code: 'responses_object_required'
        });
    }
    const assessedAt = requiredIsoDateTime(input.assessedAt, 'assessedAt');
    const nextReviewAt = optionalIsoDateTime(input.nextReviewAt, 'nextReviewAt');
    if (nextReviewAt && nextReviewAt <= assessedAt) {
        throw validationError('nextReviewAt must be later than assessedAt', {
            code: 'review_not_after_assessment'
        });
    }
    return {
        assessmentId: cleanIdentifier(input.assessmentId, 'assessmentId'),
        organisationId: cleanIdentifier(input.organisationId, 'organisationId'),
        title: cleanNarrativeRequired(input.title, 240, 'title'),
        profileId,
        profileVersion,
        assessedAt,
        nextReviewAt,
        scope: normaliseScope(input.scope),
        sourceResponses: responses
    };
}

function normaliseScope(scopeInput) {
    if (!isPlainObject(scopeInput)) {
        throw validationError('Assessment scope must be an object', { code: 'scope_object_required' });
    }
    return {
        statement: cleanNarrativeRequired(scopeInput.statement, 3000, 'scope.statement'),
        minimumStandardsScopeRationale: cleanNarrativeRequired(
            scopeInput.minimumStandardsScopeRationale,
            2000,
            'scope.minimumStandardsScopeRationale'
        ),
        inScopeSystems: cleanNarrativeList(scopeInput.inScopeSystems, 60, 300, 'scope.inScopeSystems'),
        exclusions: cleanNarrativeList(scopeInput.exclusions, 40, 500, 'scope.exclusions'),
        sampledSystems: cleanNarrativeList(scopeInput.sampledSystems, 60, 300, 'scope.sampledSystems'),
        notes: cleanNarrative(scopeInput.notes, 3000, 'scope.notes')
    };
}

function normaliseResponse(rawInput, item) {
    const provided = rawInput !== undefined && rawInput !== null;
    if (provided && !isPlainObject(rawInput)) {
        throw validationError('Each assessment response must be an object', {
            code: 'response_object_required',
            itemId: item.id
        });
    }
    const raw = provided ? rawInput : {};
    rejectPrivilegedResponseClaims(raw, item.id);
    const response = provided ? cleanChoice(raw.response, RESPONSE_VALUES, 'response', item.id) : 'unknown';
    const evidenceAssurance = cleanChoiceOrDefault(
        raw,
        'evidenceAssurance',
        'not_provided',
        EVIDENCE_VALUES,
        item.id
    );
    const evidenceRefs = cleanReferenceList(raw.evidenceRefs, 20, `responses.${item.id}.evidenceRefs`);
    const applicabilityRationale = cleanNarrative(
        raw.applicabilityRationale,
        2000,
        `responses.${item.id}.applicabilityRationale`
    );
    const riskDecision = cleanChoiceOrDefault(raw, 'riskDecision', 'open', RISK_DECISIONS, item.id);
    const dueDate = optionalDate(raw.dueDate, `responses.${item.id}.dueDate`);
    const result = {
        provided,
        response,
        evidenceAssurance,
        evidenceRefs,
        businessImpact: cleanChoiceOrDefault(
            raw,
            'businessImpact',
            'unspecified',
            IMPACT_VALUES,
            item.id
        ),
        applicabilityRationale,
        evidenceSummary: cleanNarrative(raw.evidenceSummary, 3000, `responses.${item.id}.evidenceSummary`),
        notes: cleanNarrative(raw.notes, 3000, `responses.${item.id}.notes`),
        action: cleanNarrative(raw.action, 2000, `responses.${item.id}.action`),
        owner: cleanNarrative(raw.owner, 240, `responses.${item.id}.owner`),
        dueDate,
        residualRisk: cleanNarrative(raw.residualRisk, 3000, `responses.${item.id}.residualRisk`),
        riskDecision
    };

    if (response === 'not_applicable' && !applicabilityRationale) {
        throw validationError('Not-applicable responses require a rationale', {
            code: 'not_applicable_rationale_required',
            itemId: item.id
        });
    }
    if (evidenceAssurance === 'not_provided' && evidenceRefs.length > 0) {
        throw validationError('Evidence references require a customer-asserted evidence state', {
            code: 'evidence_state_reference_mismatch',
            itemId: item.id
        });
    }
    return result;
}

function buildSummary(itemResults, profile) {
    const applicable = itemResults.filter((item) => item.applicable);
    const notApplicable = itemResults.filter((item) => !item.applicable);
    const counts = countBy(applicable, 'response', ['yes', 'partial', 'no', 'unknown']);
    const evidence = countBy(applicable, 'evidenceAssurance', ['customer_asserted', 'not_provided']);
    const numerator = applicable.reduce((sum, item) => sum + NO_FRIES_RESPONSE_WEIGHTS[item.response], 0);
    const denominator = applicable.length;
    const assessedCount = counts.yes + counts.partial + counts.no;
    const missingCount = applicable.filter((item) => !item.provided).length;
    const explicitUnknownCount = applicable.filter((item) => item.provided && item.response === 'unknown').length;
    const upperNumerator = numerator + counts.unknown;
    const referencedItemCount = applicable.filter((item) => item.evidenceRefs.length > 0).length;

    return {
        itemCount: itemResults.length,
        applicableCount: denominator,
        notApplicableCount: notApplicable.length,
        notApplicableReviewRequiredCount: notApplicable.length,
        assessedCount,
        unknownCount: counts.unknown,
        missingCount,
        explicitUnknownCount,
        completionPercent: percent(assessedCount, denominator),
        implementation: {
            yesCount: counts.yes,
            partialCount: counts.partial,
            noCount: counts.no,
            unknownCount: counts.unknown,
            numerator,
            upperNumerator,
            denominator,
            progressLowerPercent: percent(numerator, denominator),
            progressUpperPercent: percent(upperNumerator, denominator),
            formula: profile.responseModel.formula,
            label: 'No Fries implementation-progress range; not an NCSC score'
        },
        evidence: {
            customerAssertedCount: evidence.customer_asserted,
            notProvidedCount: evidence.not_provided,
            referencedItemCount,
            referencedCoveragePercent: percent(referencedItemCount, denominator),
            label: 'Self-assessment evidence state; no assessor verification is represented'
        },
        maturity: {
            model: profile.maturityModel.model,
            assessed: false,
            level: null,
            label: 'CS-CMM maturity is not assessed by this high-level domain screen'
        }
    };
}

function buildFinding(result, item, profileOrder) {
    if (!result.applicable) return null;

    const findingType = result.response === 'unknown'
        ? 'assessment_gap'
        : result.response === 'yes' ? 'assurance_gap' : 'implementation_gap';
    const sequence = calculateSequence(result, item);
    const action = result.action || defaultFindingAction(result, item);
    return {
        findingId: `finding:${result.itemId}`,
        itemId: result.itemId,
        itemKey: result.itemKey,
        title: result.title,
        frameworkFunctionId: result.frameworkFunctionId,
        findingType,
        status: 'open',
        response: result.response,
        evidenceAssurance: result.evidenceAssurance,
        businessImpact: result.businessImpact,
        sequencingMethod: 'no_fries_sequencing_v1',
        sequencingReasons: sequence.reasons,
        roadmapStage: roadmapStage(sequence.score),
        action,
        owner: result.owner,
        dueDate: result.dueDate,
        riskDecision: result.riskDecision,
        residualRisk: result.residualRisk,
        criticalControlKeys: [...result.criticalControlKeys],
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
        sourceVersion: item.sourceVersion,
        sourceKind: item.sourceKind,
        _noFriesSequenceScore: sequence.score,
        _profileOrder: profileOrder
    };
}

function calculateSequence(result, item) {
    let score = NO_FRIES_SEQUENCE_RESPONSE[result.response] || 0;
    const reasons = [`${result.response} implementation response`];
    score += NO_FRIES_SEQUENCE_IMPACT[result.businessImpact] || 0;
    if (result.businessImpact !== 'unspecified') reasons.push(`${result.businessImpact} business impact`);
    if (item.criticalControlKeys.length) {
        score += 15;
        reasons.push('cross-referenced to the date-stamped NCSC Critical Controls snapshot');
    }
    if (result.evidenceAssurance === 'not_provided') {
        score += 10;
        reasons.push('evidence not provided');
    } else if (result.evidenceAssurance === 'customer_asserted') {
        score += 5;
        reasons.push('customer-asserted evidence only');
    }
    return { score: Math.min(100, score), reasons };
}

function defaultFindingAction(result, item) {
    const title = item.displayTitle || item.officialTitle;
    if (result.response === 'yes') {
        return `Arrange an authorised assessor review of evidence that ${title} is operating as described.`;
    }
    if (result.response === 'unknown') {
        return `Confirm the current ${title} implementation, scope, owner and supporting evidence.`;
    }
    return item.startingActions[0];
}

function roadmapStage(sequenceScore) {
    if (sequenceScore >= 60) return 'now';
    if (sequenceScore >= 35) return 'next';
    return 'later';
}

function addRoadmapTiming(finding, generatedAt) {
    const window = roadmapWindows(generatedAt)[finding.roadmapStage];
    let dueDateStatus = 'not_set';
    if (finding.dueDate) {
        if (finding.dueDate < window.startDate) dueDateStatus = 'earlier_than_recommended';
        else if (finding.dueDate > window.endDate) dueDateStatus = 'later_than_recommended';
        else dueDateStatus = 'within_recommended_window';
    }
    return Object.assign({}, finding, {
        recommendedWindow: Object.assign({}, window),
        dueDateStatus
    });
}

function roadmapWindows(generatedAt) {
    const anchorDate = generatedAt.slice(0, 10);
    return {
        now: { startDate: anchorDate, endDate: addUtcDays(anchorDate, 30) },
        next: { startDate: addUtcDays(anchorDate, 31), endDate: addUtcDays(anchorDate, 60) },
        later: { startDate: addUtcDays(anchorDate, 61), endDate: addUtcDays(anchorDate, 90) }
    };
}

function addUtcDays(date, days) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    const normalised = value.toISOString();
    if (!CANONICAL_UTC_DATE_TIME.test(normalised)) {
        throw validationError('generatedAt falls outside the supported roadmap date range', {
            code: 'invalid_date_time',
            field: 'generatedAt'
        });
    }
    return normalised.slice(0, 10);
}

function sortFindings(left, right) {
    return right._noFriesSequenceScore - left._noFriesSequenceScore || left._profileOrder - right._profileOrder;
}

function buildRoadmap(findings, generatedAt) {
    const active = findings.filter((finding) => finding.status === 'open');
    const windows = roadmapWindows(generatedAt);
    return {
        method: 'no_fries_sequencing_v1',
        methodNote: 'A deterministic No Fries sequencing aid based on response, self-assessment evidence state, a date-stamped Critical Controls cross-reference and stated business impact; not NCSC prioritisation or risk scoring.',
        anchorDate: windows.now.startDate,
        focusActions: active.slice(0, 5).map(publicFinding),
        now: {
            label: '0–30 days',
            startDate: windows.now.startDate,
            endDate: windows.now.endDate,
            actions: active.filter((finding) => finding.roadmapStage === 'now').map(publicFinding)
        },
        next: {
            label: '31–60 days',
            startDate: windows.next.startDate,
            endDate: windows.next.endDate,
            actions: active.filter((finding) => finding.roadmapStage === 'next').map(publicFinding)
        },
        later: {
            label: '61–90 days',
            startDate: windows.later.startDate,
            endDate: windows.later.endDate,
            actions: active.filter((finding) => finding.roadmapStage === 'later').map(publicFinding)
        }
    };
}

function publicFinding(finding) {
    const result = Object.assign({}, finding);
    delete result._noFriesSequenceScore;
    delete result._profileOrder;
    return result;
}

function buildFunctionSummaries(profile, itemResults, findings) {
    return profile.frameworkFunctions.map((frameworkFunction) => {
        const items = itemResults.filter((item) => item.frameworkFunctionId === frameworkFunction.id);
        const applicable = items.filter((item) => item.applicable);
        const counts = countBy(applicable, 'response', ['yes', 'partial', 'no', 'unknown']);
        const numerator = applicable.reduce((sum, item) => sum + NO_FRIES_RESPONSE_WEIGHTS[item.response], 0);
        const upperNumerator = numerator + counts.unknown;
        return {
            id: frameworkFunction.id,
            name: frameworkFunction.name,
            outcomeParaphrase: frameworkFunction.outcomeParaphrase,
            itemCount: items.length,
            applicableCount: applicable.length,
            assessedCount: counts.yes + counts.partial + counts.no,
            unknownCount: counts.unknown,
            implementationProgressLowerPercent: percent(numerator, applicable.length),
            implementationProgressUpperPercent: percent(upperNumerator, applicable.length),
            referencedEvidenceItemCount: applicable.filter((item) => item.evidenceRefs.length > 0).length,
            openFindingCount: findings.filter((finding) => (
                finding.frameworkFunctionId === frameworkFunction.id && finding.status === 'open'
            )).length
        };
    });
}

function buildLimitations(profile, assessment, summary, generatedAt) {
    const limitations = [...profile.limitations];
    if (!assessment.scope.inScopeSystems.length) {
        limitations.push('No in-scope systems were listed; results cannot be tied to a defined system population.');
    }
    if (!assessment.scope.sampledSystems.length) {
        limitations.push('No sampled systems were recorded; results may rely on description rather than observed implementation.');
    }
    if (!assessment.scope.exclusions.length) {
        limitations.push('No exclusions were recorded; readers should confirm whether the assessment covered the complete intended scope.');
    }
    if (!assessment.nextReviewAt) {
        limitations.push('No next review date was recorded.');
    } else if (generatedAt > assessment.nextReviewAt) {
        limitations.push('The assessment is past its recorded next-review date; refresh the responses and scope before relying on current posture.');
    }
    limitations.push('Evidence states in this screen are customer-asserted or not provided; no assessor verification or operating-effectiveness conclusion is represented.');
    if (summary.unknownCount > 0) {
        limitations.push('One or more applicable items are unresolved; the implementation-progress range shows the resulting uncertainty.');
    }
    if (generatedAt.slice(0, 10) > profile.sources.criticalControls.reviewDueAt) {
        limitations.push('The date-stamped Critical Controls snapshot is past its scheduled review date and must be reverified before being described as current.');
    }
    return unique(limitations);
}

function projectCustomerGapReport(report) {
    const expectedProfile = getNcscGapProfile();
    const validSource = isPlainObject(report) &&
        report.audience === 'internal_assessment' &&
        report.schemaVersion === 1 &&
        report.evaluatorVersion === EVALUATOR_VERSION &&
        report.profile &&
        report.profile.profileId === expectedProfile.profileId &&
        report.profile.profileVersion === expectedProfile.profileVersion &&
        report.profile.catalogueSha256 === expectedProfile.catalogueSha256 &&
        typeof report.internalReportSha256 === 'string' &&
        report.internalReportSha256 === calculateReportSha256(report);
    if (!validSource) {
        throw validationError('A supported internal gap report is required for customer projection', {
            code: 'invalid_customer_report_source'
        });
    }
    const customerFindings = report.findings.map(customerFinding);
    return {
        schemaVersion: report.schemaVersion,
        customerProjectionVersion: 1,
        audience: 'customer',
        evaluatorVersion: report.evaluatorVersion,
        sourceReportSha256: report.internalReportSha256,
        generatedAt: report.generatedAt,
        assessment: {
            assessmentId: report.assessment.assessmentId,
            title: report.assessment.title,
            assessedAt: report.assessment.assessedAt,
            nextReviewAt: report.assessment.nextReviewAt,
            scope: {
                statement: report.assessment.scope.statement,
                minimumStandardsScopeRationale: report.assessment.scope.minimumStandardsScopeRationale,
                inScopeSystems: [...report.assessment.scope.inScopeSystems],
                exclusions: [...report.assessment.scope.exclusions]
            }
        },
        profile: customerProfile(report.profile),
        summary: customerSummary(report.summary),
        functions: report.functions.map(customerFunctionSummary),
        findings: customerFindings,
        exceptions: [],
        roadmap: {
            method: report.roadmap.method,
            methodNote: report.roadmap.methodNote,
            anchorDate: report.roadmap.anchorDate,
            focusActions: report.roadmap.focusActions.map(customerFinding),
            now: customerRoadmapBucket(report.roadmap.now),
            next: customerRoadmapBucket(report.roadmap.next),
            later: customerRoadmapBucket(report.roadmap.later)
        },
        itemResults: report.itemResults.map(customerItemResult),
        limitations: [...report.limitations],
        contentSafetyNote: 'All text remains untrusted data and must be output-encoded by the HTML, PDF or CSV renderer.'
    };
}

function customerProfile(profile) {
    const result = pick(profile, [
        'profileId',
        'profileVersion',
        'catalogueSha256',
        'title',
        'effectiveFrom',
        'lastVerifiedAt',
        'basisStatement',
        'claimStatement',
        'attribution',
        'identifierNote',
        'mappingNote',
        'sourceScopeStatement'
    ]);
    result.sources = {
        framework: pick(profile.sources.framework, [
            'title', 'status', 'sourceUrl', 'licence', 'licenceUrl', 'attributionRequired'
        ]),
        minimumStandards: pick(profile.sources.minimumStandards, [
            'title', 'publishedAt', 'sourceUrl', 'pdfUrl', 'maturityModelUrl', 'adoptionNote'
        ]),
        criticalControls: pick(profile.sources.criticalControls, [
            'title', 'sourceUrl', 'lastVerifiedAt', 'reviewDueAt', 'reviewCadence'
        ])
    };
    return result;
}

function customerSummary(summary) {
    const result = pick(summary, [
        'itemCount',
        'applicableCount',
        'notApplicableCount',
        'notApplicableReviewRequiredCount',
        'assessedCount',
        'unknownCount',
        'missingCount',
        'explicitUnknownCount',
        'completionPercent'
    ]);
    result.implementation = pick(summary.implementation, [
        'yesCount',
        'partialCount',
        'noCount',
        'unknownCount',
        'numerator',
        'upperNumerator',
        'denominator',
        'progressLowerPercent',
        'progressUpperPercent',
        'formula',
        'label'
    ]);
    result.evidence = pick(summary.evidence, [
        'customerAssertedCount',
        'notProvidedCount',
        'referencedItemCount',
        'referencedCoveragePercent',
        'label'
    ]);
    result.maturity = pick(summary.maturity, ['model', 'assessed', 'level', 'label']);
    return result;
}

function customerFunctionSummary(summary) {
    return pick(summary, [
        'id',
        'name',
        'outcomeParaphrase',
        'itemCount',
        'applicableCount',
        'assessedCount',
        'unknownCount',
        'implementationProgressLowerPercent',
        'implementationProgressUpperPercent',
        'referencedEvidenceItemCount',
        'openFindingCount'
    ]);
}

function customerRoadmapBucket(bucket) {
    return {
        label: bucket.label,
        startDate: bucket.startDate,
        endDate: bucket.endDate,
        actions: bucket.actions.map(customerFinding)
    };
}

function customerFinding(finding) {
    return pick(finding, [
        'findingId',
        'itemId',
        'itemKey',
        'title',
        'frameworkFunctionId',
        'findingType',
        'status',
        'response',
        'evidenceAssurance',
        'businessImpact',
        'sequencingMethod',
        'sequencingReasons',
        'roadmapStage',
        'recommendedWindow',
        'dueDateStatus',
        'action',
        'owner',
        'dueDate',
        'riskDecision',
        'criticalControlKeys',
        'sourceUrl',
        'sourceTitle',
        'sourceVersion',
        'sourceKind'
    ]);
}

function customerItemResult(item) {
    return pick(item, [
        'itemId',
        'itemKey',
        'itemType',
        'title',
        'frameworkFunctionId',
        'criticalControlKeys',
        'applicable',
        'provided',
        'response',
        'evidenceAssurance',
        'businessImpact',
        'applicabilityRationale',
        'action',
        'owner',
        'dueDate',
        'riskDecision'
    ]);
}

function pick(value, fields) {
    return fields.reduce((result, field) => {
        if (Object.prototype.hasOwnProperty.call(value, field)) result[field] = cloneJson(value[field]);
        return result;
    }, {});
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function calculateReportSha256(report) {
    const payload = cloneJson(report);
    delete payload.internalReportSha256;
    return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function countBy(items, field, allowedValues) {
    return allowedValues.reduce((counts, value) => {
        counts[value] = items.filter((item) => item[field] === value).length;
        return counts;
    }, {});
}

function rejectPrivilegedResponseClaims(raw, itemId) {
    if (String(raw.evidenceAssurance || '').trim().toLowerCase() === 'verified') {
        throw validationError('Customer assessment input cannot mark evidence as verified', {
            code: 'privileged_evidence_assurance_not_supported',
            itemId
        });
    }
    if (String(raw.riskDecision || '').trim().toLowerCase() === 'accept') {
        throw validationError('Risk acceptance requires a future authorised approval workflow', {
            code: 'privileged_risk_acceptance_not_supported',
            itemId
        });
    }
    const privilegedFields = [
        'maturityLevel',
        'decisionBy',
        'decisionAt',
        'decisionEvidenceRef',
        'verifiedBy',
        'verifiedAt'
    ];
    const supplied = privilegedFields.filter((field) => Object.prototype.hasOwnProperty.call(raw, field));
    if (supplied.length) {
        const code = supplied.includes('maturityLevel')
            ? 'maturity_not_supported_in_domain_screen'
            : 'privileged_assessment_field_not_supported';
        throw validationError('The assessment contains fields reserved for a future authorised workflow', {
            code,
            itemId,
            fields: supplied
        });
    }
}

function cleanReferenceList(value, maximumItems, field) {
    const references = cleanStringList(value, maximumItems, 300, field);
    references.forEach((reference, index) => {
        const namespace = reference.split(':', 1)[0].toLowerCase();
        if (!OPAQUE_REFERENCE.test(reference) || DISALLOWED_REFERENCE_NAMESPACES.has(namespace)) {
            throw validationError(`${field} entries must be opaque, non-link references`, {
                code: 'invalid_evidence_reference',
                field,
                index
            });
        }
        assertNoLikelySecret(reference, `${field}[${index}]`);
    });
    return references;
}

function cleanNarrativeList(value, maximumItems, maximumLength, field) {
    const items = cleanStringList(value, maximumItems, maximumLength, field);
    items.forEach((item, index) => assertNoLikelySecret(item, `${field}[${index}]`));
    return items;
}

function percent(numerator, denominator) {
    return denominator ? roundOne((numerator / denominator) * 100) : null;
}

function roundOne(value) {
    return Math.round((value + Number.EPSILON) * 10) / 10;
}

function cleanChoice(value, allowed, field, itemId) {
    if (typeof value !== 'string') {
        throw validationError(`Invalid ${field}`, {
            code: `invalid_${field.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
            itemId,
            field
        });
    }
    const cleaned = value.trim().toLowerCase();
    if (!allowed.has(cleaned)) {
        throw validationError(`Invalid ${field}`, {
            code: `invalid_${field.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
            itemId,
            field
        });
    }
    return cleaned;
}

function cleanChoiceOrDefault(raw, field, defaultValue, allowed, itemId) {
    const value = Object.prototype.hasOwnProperty.call(raw, field) ? raw[field] : defaultValue;
    return cleanChoice(value, allowed, field, itemId);
}

function cleanIdentifier(value, field) {
    const cleaned = cleanRequiredText(value, 180, field);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cleaned)) {
        throw validationError(`${field} contains unsupported characters`, {
            code: 'invalid_identifier',
            field
        });
    }
    return cleaned;
}

function cleanRequiredText(value, maximum, field) {
    const cleaned = cleanOptionalText(value, maximum, field);
    if (!cleaned) {
        throw validationError(`${field} is required`, { code: 'required_field', field });
    }
    return cleaned;
}

function cleanNarrativeRequired(value, maximum, field) {
    const cleaned = cleanRequiredText(value, maximum, field);
    assertNoLikelySecret(cleaned, field);
    return cleaned;
}

function cleanNarrative(value, maximum, field) {
    const cleaned = cleanOptionalText(value, maximum, field);
    assertNoLikelySecret(cleaned, field);
    return cleaned;
}

function assertNoLikelySecret(value, field) {
    if (!value) return;
    const likelySecret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj|live|test)-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:password|passwd|pwd|client_secret|accountkey)\s*[:=]\s*\S{4,}/i;
    if (likelySecret.test(value)) {
        throw validationError(`${field} appears to contain secret material`, {
            code: 'secret_like_content_rejected',
            field
        });
    }
}

function cleanOptionalText(value, maximum, field = 'value') {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw validationError(`${field} must be a string`, {
            code: 'text_string_required',
            field
        });
    }
    const cleaned = value.trim();
    if (cleaned.length > maximum) {
        throw validationError(`${field} exceeds the maximum length`, {
            code: 'text_limit_exceeded',
            field,
            maximum
        });
    }
    return cleaned;
}

function cleanStringList(value, maximumItems, maximumLength, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw validationError(`${field} must be an array`, { code: 'array_required', field });
    }
    if (value.length > maximumItems) {
        throw validationError(`${field} contains too many entries`, { code: 'array_limit_exceeded', field });
    }
    return unique(value.map((item, index) => {
        if (typeof item !== 'string') {
            throw validationError(`${field} entries must be strings`, {
                code: 'array_string_required',
                field,
                index
            });
        }
        return cleanOptionalText(item, maximumLength, `${field}[${index}]`);
    }).filter(Boolean));
}

function requiredIsoDateTime(value, field) {
    const cleaned = optionalIsoDateTime(value, field);
    if (!cleaned) throw validationError(`${field} is required`, { code: 'required_field', field });
    return cleaned;
}

function optionalIsoDateTime(value, field) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') {
        throw validationError(`${field} must be an ISO date-time`, { code: 'invalid_date_time', field });
    }
    const cleaned = value.trim();
    if (cleaned.length > 80) {
        throw validationError(`${field} must be an ISO date-time`, { code: 'invalid_date_time', field });
    }
    const match = RFC3339_DATE_TIME.exec(cleaned);
    const parsed = Date.parse(cleaned);
    if (!match || !validRfc3339Components(match) || !Number.isFinite(parsed)) {
        throw validationError(`${field} must be an RFC 3339 date-time with a UTC offset`, {
            code: 'invalid_date_time',
            field
        });
    }
    const normalised = new Date(parsed).toISOString();
    if (!CANONICAL_UTC_DATE_TIME.test(normalised)) {
        throw validationError(`${field} falls outside the supported date-time range`, {
            code: 'invalid_date_time',
            field
        });
    }
    return normalised;
}

function validRfc3339Components(match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
    const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

    return month >= 1
        && month <= 12
        && day >= 1
        && day <= daysInMonth(year, month)
        && hour >= 0
        && hour <= 23
        && minute >= 0
        && minute <= 59
        && second >= 0
        && second <= 59
        && offsetHour >= 0
        && offsetHour <= 23
        && offsetMinute >= 0
        && offsetMinute <= 59;
}

function daysInMonth(year, month) {
    if (month === 2) {
        const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        return leapYear ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function optionalDate(value, field) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') {
        throw validationError(`${field} must use YYYY-MM-DD`, { code: 'invalid_date', field });
    }
    const cleaned = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        throw validationError(`${field} must use YYYY-MM-DD`, { code: 'invalid_date', field });
    }
    const parsed = new Date(`${cleaned}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== cleaned) {
        throw validationError(`${field} is not a valid date`, { code: 'invalid_date', field });
    }
    return cleaned;
}

function unique(values) {
    return [...new Set(values)];
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validationError(message, details) {
    return new GapAssessmentValidationError(message, details);
}

module.exports = {
    EVALUATOR_VERSION,
    GapAssessmentValidationError,
    evaluateGapAssessment,
    projectCustomerGapReport
};
