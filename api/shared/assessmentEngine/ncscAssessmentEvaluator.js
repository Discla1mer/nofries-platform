'use strict';

const { types: utilTypes } = require('util');
const { AssessmentEvaluationError, evaluateAssessment } = require('./assessmentEvaluator');
const { createFrameworkRegistry } = require('./frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('./ncscAcceptedFrameworkProfile');

// Source-only explicit compatibility adapter. No default runtime registration,
// tenant/provider admission, legacy conversion or independent arithmetic exists.
const accepted = createAcceptedNcscFrameworkProfile();
const registry = createFrameworkRegistry([accepted]);
const MODULE_ID = 'cyber_security';
const ACCEPTED_PROFILE_REF = Object.freeze({
    frameworkId: accepted.framework.id,
    frameworkVersion: accepted.framework.version,
    profileId: accepted.profile.id,
    profileVersion: accepted.profile.version,
    catalogueSha256: accepted.catalogueSha256,
    sourceCatalogueSha256: accepted.sourceCatalogueSha256
});

/** The full ENG-003 input tuple remains explicit and is never filled or upgraded.
 * Only an independently trusted applicability-decision registry may be supplied.
 * Authentication, organisation scope and immutable snapshot authority remain the
 * caller's responsibility. The returned numeric result is not an access token.
 */
function evaluateAcceptedNcscAssessment(input, options = {}) {
    if (!options || typeof options !== 'object' || utilTypes.isProxy(options) ||
        Object.getPrototypeOf(options) !== Object.prototype) invalidOptions();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => key !== 'applicabilityDecisionRegistry' ||
        !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) invalidOptions();
    const dependencies = { registry };
    if (Object.hasOwn(descriptors, 'applicabilityDecisionRegistry')) {
        dependencies.applicabilityDecisionRegistry = descriptors.applicabilityDecisionRegistry.value;
    }
    // Let ENG-003 validate the entire plain-data input before reading properties;
    // no getter, alternate profile, digest mismatch or partial result bypass.
    const result = evaluateAssessment(input, dependencies);
    if (result.provenance.moduleId !== MODULE_ID) {
        throw new AssessmentEvaluationError('ncsc_module_unsupported', '$.moduleId');
    }
    return result;
}

function invalidOptions() {
    throw new AssessmentEvaluationError('ncsc_options_invalid', '$options');
}

module.exports = { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment };
