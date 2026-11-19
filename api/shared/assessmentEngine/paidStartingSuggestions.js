'use strict';

const { isDeepStrictEqual } = require('node:util');
const { MODULE_ID } = require('./ncscAssessmentEvaluator');
const { ACCEPTED_NCSC_CONTEXT, listsNcscProfile } = require('./ncscProfileSet');
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
    catalogueSha256: '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d',
    sourceCatalogueSha256: '66ce68bdf0d8ea2d271c52f68d6505b7a50f69f8d8d5ce40bcf833320caef1fd'
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
function startingLinks(profileRef) {
    if (isDeepStrictEqual(profileRef, ISO_PROFILE_REF)) {
        return ISO_LINKS.map(link => ({ ...link, suggestedOptionId: 'partly_in_place' }));
    }
    nistCrosswalk ??= createNistNcscCrosswalk();
    if (!isDeepStrictEqual(profileRef, nistCrosswalk.toProfileRef)) return [];
    return nistCrosswalk.records.filter(row => NIST_LINKS.has(row.id) && row.relationship === 'partial')
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
    const links = startingLinks(target.profileRef);
    if (!links.length) return [];
    const envelope = validateNcscSupportingRecords(retained.envelope);
    if (envelope.tenantId !== access.tenantId || envelope.organisationId !== access.organisationId ||
        envelope.tenantId !== target.tenantId || envelope.organisationId !== target.organisationId ||
        envelope.assessmentId !== selectedSource.assessmentId || envelope.revision !== selectedSource.revision ||
        envelope.scopePopulation.sha256 !== selectedSource.scopePopulationSha256 ||
        envelope.state.status !== 'submitted' || !envelope.submission ||
        !isDeepStrictEqual(envelope.state.profileRef, ACCEPTED_NCSC_CONTEXT.profileRef) ||
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
