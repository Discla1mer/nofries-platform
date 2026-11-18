'use strict';

// Scoring v2 (#399): the cyber-security profiles this build can read, each bound
// to the evaluator its results were scored with. A retained assessment is always
// handled with the profile and evaluator named by its own stored profile
// reference; nothing here converts or upgrades one profile to another.
const { types: utilTypes } = require('util');
const v1Engine = require('./assessmentEvaluator');
const v2Engine = require('./assessmentEvaluatorV2');
const { ASSESSMENT_EVALUATOR_SOURCE_SHA256 } = require('./assessmentEvaluatorVersion');
const { ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256 } = require('./assessmentEvaluatorV2Version');
const { createFrameworkRegistry } = require('./frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('./ncscAcceptedFrameworkProfile');
const { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment } = require('./ncscAssessmentEvaluator');
const { createNcscFrameworkProfileV2 } = require('./ncscFrameworkProfileV2');

const REF_FIELDS = Object.freeze(['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion',
    'catalogueSha256', 'sourceCatalogueSha256']);

function context(profile, engine, evaluatorSourceSha256, evaluate) {
    const registry = createFrameworkRegistry([profile]);
    const profileRef = Object.freeze({ frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
        profileId: profile.profile.id, profileVersion: profile.profile.version,
        catalogueSha256: profile.catalogueSha256, sourceCatalogueSha256: profile.sourceCatalogueSha256 });
    return Object.freeze({ profile, registry, profileRef,
        questionIds: Object.freeze(profile.questions.map(question => question.id)),
        scoreContractVersion: engine.SCORE_CONTRACT_VERSION,
        evaluatorVersion: engine.ASSESSMENT_EVALUATOR_VERSION,
        evaluatorSourceSha256,
        calculateEvidenceSnapshotSha256: engine.calculateEvidenceSnapshotSha256,
        calculateRiskContextSnapshotSha256: engine.calculateRiskContextSnapshotSha256,
        evaluate: evaluate || (input => {
            const result = engine.evaluateAssessment(input, { registry });
            if (result.provenance.moduleId !== MODULE_ID) {
                throw new engine.AssessmentEvaluationError('ncsc_module_unsupported', '$.moduleId');
            }
            return result;
        }) });
}

const ACCEPTED_NCSC_CONTEXT = context(createAcceptedNcscFrameworkProfile(), v1Engine,
    ASSESSMENT_EVALUATOR_SOURCE_SHA256, input => evaluateAcceptedNcscAssessment(input));
const NCSC_V2_CONTEXT = context(createNcscFrameworkProfileV2(), v2Engine, ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256);
const CONTEXTS = Object.freeze([ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT]);
if (REF_FIELDS.some(field => ACCEPTED_NCSC_CONTEXT.profileRef[field] !== ACCEPTED_PROFILE_REF[field])) {
    throw new Error('Accepted NCSC profile reference does not match its pinned adapter');
}

/** The context whose full reference equals `profileRef`, or null. The reference
 * must be a plain object with exactly the six fields as own string data
 * properties, each read once; nothing is defaulted and no getter is invoked.
 */
function ncscProfileContext(profileRef) {
    if (!profileRef || typeof profileRef !== 'object' || Array.isArray(profileRef) || utilTypes.isProxy(profileRef) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(profileRef)) ||
        Reflect.ownKeys(profileRef).length !== REF_FIELDS.length) return null;
    const values = {};
    for (const field of REF_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(profileRef, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
        values[field] = descriptor.value;
    }
    return CONTEXTS.find(candidate => REF_FIELDS.every(field => values[field] === candidate.profileRef[field])) || null;
}

module.exports = { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT, ncscProfileContext };
