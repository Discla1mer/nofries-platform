'use strict';

const { isDeepStrictEqual } = require('node:util');
const { MODULE_ID } = require('./ncscAssessmentEvaluator');
const { listsNcscProfile } = require('./ncscProfileSet');
const { createNistNcscCrosswalk } = require('./nistNcscCrosswalk');
const { validateNcscSupportingRecords, hashNcscRecord } = require('../assessmentLifecycle/ncscAssessmentSubmission');

// Only use reviewed partial links where a positive source answer establishes
// a specific part of the wider target question. Never infer a negative or N/A.
const NIST_LINKS = new Set([
    'NF-NCSC-MCSS-AI-01--ID.AM-01',
    'NF-NCSC-MCSS-PA-01--PR.PS-02',
    'NF-NCSC-MCSS-DR-01--PR.DS-11'
]);
// Reviewed against ISO-2's original questions at the exact publication below.
// Other controls, including related topics, have no suggested starting answer.
const ISO_PROFILE_REF = Object.freeze({
    frameworkId: 'iso-iec-27001', frameworkVersion: '2022',
    profileId: 'nf-iso-27001-2022-readiness', profileVersion: '2026-11-19.1',
    catalogueSha256: '88b628987e8117690de70b7be04ddeb60de95cbe27fd96d4353f7107a2758124',
    sourceCatalogueSha256: 'b6b39634dbaf1060b655e99f296dbfcbae1a3b035120ffb2badd5321483b5973'
});
const ISO_LINKS = [
    { sourceQuestionId: 'NF-NCSC-MCSS-AI-01-Q1', targetQuestionId: 'A.5.9-Q1',
        furtherCheck: 'Check that the list connects each important piece of information to its supporting assets and owners.' },
    { sourceQuestionId: 'NF-NCSC-MCSS-PA-01-Q1', targetQuestionId: 'A.8.8-Q1',
        furtherCheck: 'Check who owns each fix, including weaknesses that a patch alone cannot address.' },
    { sourceQuestionId: 'NF-NCSC-MCSS-DR-01-Q1', targetQuestionId: 'A.8.13-Q1',
        furtherCheck: 'Check when you last recovered the information this assessment covers and what the test showed.' }
];
let nistCrosswalk;
function startingLinks(profileRef, crosswalk) {
    if (isDeepStrictEqual(profileRef, ISO_PROFILE_REF)) {
        return ISO_LINKS.map(link => ({ ...link, suggestedOptionId: 'partly_in_place' }));
    }
    if (!isDeepStrictEqual(profileRef, crosswalk.toProfileRef)) return [];
    return crosswalk.records.filter(row => NIST_LINKS.has(row.id) && row.relationship === 'partial')
        .map(row => ({ sourceQuestionId: row.source.questionId, targetQuestionId: row.target.questionId,
            suggestedOptionId: 'partial', furtherCheck: row.omittedTargetScope.join(' ') }));
}

// Server-only projection over an already authorised target, current effective
// framework rows, its explicitly bound NCSC scope and a retained source read.
// The host must obtain these within the same tenant/session generation.
function paidStartingSuggestions({ access, target, selectedSource, retained }, env = process.env) {
    if (env?.NOFRIES_PAID_FRAMEWORKS_ENABLED !== 'true' || !target || target.moduleId !== MODULE_ID ||
        !['created', 'in-progress'].includes(target.status) || !Array.isArray(target.responses) ||
        !target.profileRef || !Array.isArray(access?.entitledFrameworks) || !Array.isArray(access.frameworkFlags) ||
        !listsNcscProfile(access.entitledFrameworks, target.profileRef) ||
        !listsNcscProfile(access.frameworkFlags, target.profileRef)) return [];
    if (!selectedSource || !retained || !target.sourceScopePopulationSha256 ||
        target.sourceScopePopulationSha256 !== selectedSource.scopePopulationSha256) return [];
    // Both sets of links were reviewed against this crosswalk’s pinned NCSC publication.
    nistCrosswalk ??= createNistNcscCrosswalk();
    const links = startingLinks(target.profileRef, nistCrosswalk);
    if (!links.length) return [];
    let envelope;
    try {
        envelope = validateNcscSupportingRecords(retained.envelope);
    } catch (error) {
        if (error.code === 'ncsc_record_invalid') return [];
        throw error;
    }
    if (envelope.tenantId !== access.tenantId || envelope.organisationId !== access.organisationId ||
        envelope.tenantId !== target.tenantId || envelope.organisationId !== target.organisationId ||
        envelope.assessmentId !== selectedSource.assessmentId || envelope.revision !== selectedSource.revision ||
        envelope.scopePopulation.sha256 !== selectedSource.scopePopulationSha256 ||
        !isDeepStrictEqual(target.scopePopulation, envelope.scopePopulation.body) ||
        envelope.state.status !== 'submitted' || !envelope.submission ||
        !isDeepStrictEqual(envelope.state.profileRef, nistCrosswalk.fromProfileRef) ||
        retained.revisionSha256 !== selectedSource.revisionSha256 ||
        hashNcscRecord('version', envelope) !== selectedSource.revisionSha256) return [];

    const positiveAnswers = new Set(envelope.state.responses.filter(row => row.optionId === 'yes').map(row => row.itemId));
    const savedTargets = new Set(target.responses.map(row => row.itemId));
    return links.filter(link => positiveAnswers.has(link.sourceQuestionId) && !savedTargets.has(link.targetQuestionId))
        .map(link => ({
            ...link, label: 'Needs confirmation', sourceOptionId: 'yes',
            source: { assessmentId: envelope.assessmentId, revision: envelope.revision, revisionSha256: retained.revisionSha256,
                scopePopulationSha256: envelope.scopePopulation.sha256, submittedAt: envelope.state.submission.submittedAt }
        }));
}

module.exports = { paidStartingSuggestions };
