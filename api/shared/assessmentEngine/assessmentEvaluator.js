'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');

const {
    ASSESSMENT_EVALUATOR_SOURCE_SHA256,
    ASSESSMENT_EVALUATOR_VERSION
} = require('./assessmentEvaluatorVersion');

const INPUT_SCHEMA_VERSION = 1;
const OUTPUT_SCHEMA_VERSION = 1;
const SCORE_CONTRACT_VERSION = 'PROD-003-R1';
const EVALUATOR_ID = 'no-fries-deterministic-assessment-evaluator';
const ROUNDING_RULE = 'decimal-half-up-one-place-v1';
const MAPPING_VERSION = 'framework-profile-question-mapping-v1';
const WEIGHT_SET_VERSION = 'prod-003-r1-profile-integer-weights-v1';
const CREDIT_UNIT_SCALE = 2;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_UTC_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

if (!SHA256_PATTERN.test(ASSESSMENT_EVALUATOR_SOURCE_SHA256)) {
    throw new Error('Assessment evaluator source digest is not pinned');
}

const EVIDENCE_STATES = Object.freeze([
    'not_provided',
    'attested',
    'documented_current',
    'tested_or_observed_current',
    'independently_reviewed_current',
    'stale',
    'inaccessible',
    'disputed',
    'unavailable'
]);
const EVIDENCE_STATE_SET = new Set(EVIDENCE_STATES);
const PROVIDED_EVIDENCE_STATES = new Set([
    'attested',
    'documented_current',
    'tested_or_observed_current',
    'independently_reviewed_current'
]);
const SUBSTANTIATED_EVIDENCE_STATES = new Set([
    'documented_current',
    'tested_or_observed_current',
    'independently_reviewed_current'
]);
const TESTED_EVIDENCE_STATES = new Set([
    'tested_or_observed_current',
    'independently_reviewed_current'
]);
const STATED_IMPACTS = new Set(['critical', 'high', 'medium', 'low', 'unspecified']);
const PRIORITY_OVERLAYS = new Set(['none', 'critical_controls']);
const SCORE_CONTRACT_RESPONSE_SEMANTICS = Object.freeze({
    'true:1': 'yes',
    'true:0.5': 'partial',
    'true:0': 'no',
    'true:null': 'unknown',
    'false:null': 'not_applicable'
});

const LIMITS = Object.freeze({
    inputBytes: 2 * 1024 * 1024,
    profileBytes: 4 * 1024 * 1024,
    graphNodes: 64000,
    graphDepth: 96,
    keyBytes: 256,
    atomInputs: 4096
});

const DECISION_CORE_KEYS = Object.freeze([
    'decisionId',
    'decisionRevision',
    'organisationId',
    'moduleId',
    'assessmentId',
    'assessmentRevision',
    'itemId',
    'frameworkId',
    'frameworkVersion',
    'profileId',
    'profileVersion',
    'catalogueSha256',
    'scopePopulationSha256',
    'status',
    'rationaleSha256',
    'approvedBy',
    'approvedAt'
]);

class AssessmentEvaluationError extends Error {
    constructor(code, path, itemId) {
        super(`Assessment evaluation failed (${code})`);
        this.name = 'AssessmentEvaluationError';
        this.code = code;
        this.path = path;
        if (itemId) this.itemId = itemId;
    }
}

function evaluateAssessment(input, options) {
    inspectJsonGraph(input, '$', LIMITS.inputBytes);
    const dependencies = copyRegistryOptions(options);
    const header = copyInputHeader(input);
    const profile = resolveProfile(dependencies.registry, header.profileRef);
    const compiled = compileProfile(profile, header.profileRef, header.scoreAsOf);
    const normalized = normalizeInput(input, header, compiled, dependencies);
    const atoms = compiled.questions.map((question) => normalizeAtom(
        normalized.atomInputById.get(question.id),
        question,
        normalized,
        compiled
    ));

    assertSnapshotBindings(atoms, normalized);
    assertCountReconciliation(atoms);
    assertUniqueApplicabilityDecisions(atoms);

    const overall = aggregateAtoms(atoms);
    const atomsByControl = groupAtoms(atoms, 'controlId');
    const atomsByDomain = groupAtoms(atoms, 'domainId');
    const controls = compiled.controls.map((control) => ({
        controlId: control.id,
        domainId: control.domainId,
        ...aggregateAtoms(atomsByControl.get(control.id) || [])
    }));
    const domains = compiled.domains.map((domain) => ({
        domainId: domain.id,
        ...aggregateAtoms(atomsByDomain.get(domain.id) || [])
    }));

    const canonicalAtomInputs = atoms.map((atom) => atom.canonicalInput);
    const approvedDecisions = atoms
        .filter((atom) => atom.applicabilityDecisionSha256)
        .map((atom) => ({
            itemId: atom.itemId,
            decisionId: atom.applicabilityDecisionId,
            decisionSha256: atom.applicabilityDecisionSha256
        }));
    const resolvedInputSha256 = hashCanonical('nofries:eng003:resolved-input:v1', {
        ...normalized.canonicalHeader,
        atomInputs: canonicalAtomInputs
    });
    const applicabilityBasisSha256 = hashCanonical(
        'nofries:eng003:applicability-basis:v1',
        approvedDecisions
    );

    const outputCore = {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        status: overall.attainment.status,
        provenance: {
            evaluatorId: EVALUATOR_ID,
            evaluatorVersion: ASSESSMENT_EVALUATOR_VERSION,
            evaluatorSourceSha256: ASSESSMENT_EVALUATOR_SOURCE_SHA256,
            scoreContractVersion: SCORE_CONTRACT_VERSION,
            roundingRule: ROUNDING_RULE,
            organisationId: normalized.organisationId,
            moduleId: normalized.moduleId,
            assessmentId: normalized.assessmentId,
            assessmentRevision: normalized.assessmentRevision,
            profileRef: normalized.profileRef,
            scoreAsOf: normalized.scoreAsOf,
            scopePopulationSha256: normalized.scopePopulationSha256,
            evidenceSnapshot: normalized.evidenceSnapshot,
            riskContextSnapshot: normalized.riskContextSnapshot,
            mappingVersion: MAPPING_VERSION,
            mappingSha256: compiled.mappingSha256,
            weightSetVersion: WEIGHT_SET_VERSION,
            weightSetSha256: compiled.weightSetSha256,
            scoredAtomSetSha256: compiled.scoredAtomSetSha256,
            applicabilityBasisSha256,
            resolvedInputSha256
        },
        countsCompletion: overall.countsCompletion,
        attainment: overall.attainment,
        evidence: overall.evidence,
        atoms: atoms.map(publicAtom),
        controls,
        domains,
        remediationPriority: {
            status: 'not_calculated',
            reason: 'priority_adapter_required'
        },
        trend: {
            status: 'not_requested'
        }
    };
    const outputSha256 = hashCanonical('nofries:eng003:evaluation-output:v1', outputCore);
    return deepFreeze({ ...outputCore, outputSha256 });
}

function copyRegistryOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        fail('registry_required', '$options.registry');
    }
    if (utilTypes.isProxy(options)) fail('non_plain_object', '$options');
    if (Object.getPrototypeOf(options) !== Object.prototype) {
        fail('registry_required', '$options.registry');
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    Object.values(descriptors).forEach((descriptor) => {
        if (descriptor.get || descriptor.set || !descriptor.enumerable) {
            fail('non_plain_object', '$options');
        }
    });
    const keys = Object.keys(options);
    if (keys.some((key) => !['registry', 'applicabilityDecisionRegistry'].includes(key))) {
        fail('unknown_field', '$options.[unknown]');
    }
    if (!Object.hasOwn(options, 'registry')) fail('registry_required', '$options.registry');
    const registry = copyPrivilegedRegistry(
        options.registry,
        'getProfile',
        '$options.registry',
        'registry_required'
    );
    let applicabilityDecisionRegistry = null;
    if (Object.hasOwn(options, 'applicabilityDecisionRegistry')) {
        applicabilityDecisionRegistry = copyPrivilegedRegistry(
            options.applicabilityDecisionRegistry,
            'getDecision',
            '$options.applicabilityDecisionRegistry',
            'applicability_decision_registry_invalid'
        );
    }
    return { registry, applicabilityDecisionRegistry };
}

function copyPrivilegedRegistry(value, methodName, path, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
        fail(code, path);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code, path);
    const descriptor = Object.getOwnPropertyDescriptor(value, methodName);
    if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'function') {
        fail(code, path);
    }
    return value;
}

function copyInputHeader(input) {
    assertPlainObject(input, '$');
    assertExactKeys(input, [
        'schemaVersion',
        'scoreContractVersion',
        'organisationId',
        'moduleId',
        'assessmentId',
        'assessmentRevision',
        'profileRef',
        'scoreAsOf',
        'scopePopulationSha256',
        'evidenceSnapshot',
        'riskContextSnapshot',
        'atomInputs'
    ], [], '$');
    if (input.schemaVersion !== INPUT_SCHEMA_VERSION) {
        fail('unsupported_input_schema_version', '$.schemaVersion');
    }
    if (input.scoreContractVersion !== SCORE_CONTRACT_VERSION) {
        fail('unsupported_score_contract_version', '$.scoreContractVersion');
    }
    const profileRef = copyProfileRef(input.profileRef);
    return {
        organisationId: copyIdentifier(input.organisationId, '$.organisationId'),
        moduleId: copyIdentifier(input.moduleId, '$.moduleId'),
        assessmentId: copyIdentifier(input.assessmentId, '$.assessmentId'),
        assessmentRevision: copyVersion(input.assessmentRevision, '$.assessmentRevision'),
        profileRef,
        scoreAsOf: copyCanonicalUtcDateTime(input.scoreAsOf, '$.scoreAsOf'),
        scopePopulationSha256: copySha256(input.scopePopulationSha256, '$.scopePopulationSha256'),
        evidenceSnapshot: copySnapshot(input.evidenceSnapshot, '$.evidenceSnapshot'),
        riskContextSnapshot: copySnapshot(input.riskContextSnapshot, '$.riskContextSnapshot')
    };
}

function copyProfileRef(value) {
    const path = '$.profileRef';
    assertPlainObject(value, path);
    assertExactKeys(value, [
        'frameworkId',
        'frameworkVersion',
        'profileId',
        'profileVersion',
        'catalogueSha256'
    ], ['sourceCatalogueSha256'], path);
    const profileRef = {
        frameworkId: copyIdentifier(value.frameworkId, `${path}.frameworkId`),
        frameworkVersion: copyVersion(value.frameworkVersion, `${path}.frameworkVersion`),
        profileId: copyIdentifier(value.profileId, `${path}.profileId`),
        profileVersion: copyVersion(value.profileVersion, `${path}.profileVersion`),
        catalogueSha256: copySha256(value.catalogueSha256, `${path}.catalogueSha256`)
    };
    if (Object.hasOwn(value, 'sourceCatalogueSha256')) {
        profileRef.sourceCatalogueSha256 = copySha256(
            value.sourceCatalogueSha256,
            `${path}.sourceCatalogueSha256`
        );
    }
    return profileRef;
}

function copySnapshot(value, path) {
    assertPlainObject(value, path);
    assertExactKeys(value, ['id', 'sha256'], [], path);
    return {
        id: copyIdentifier(value.id, `${path}.id`),
        sha256: copySha256(value.sha256, `${path}.sha256`)
    };
}

function resolveProfile(registry, profileRef) {
    let profile;
    try {
        profile = registry.getProfile(profileRef.profileId, profileRef.profileVersion);
    } catch {
        fail('unsupported_framework_profile', '$.profileRef');
    }
    inspectJsonGraph(profile, '$.resolvedProfile', LIMITS.profileBytes);
    return profile;
}

function compileProfile(profile, profileRef, scoreAsOf) {
    assertPlainObject(profile, '$.resolvedProfile');
    if (
        !profile.framework
        || !profile.profile
        || profile.framework.id !== profileRef.frameworkId
        || profile.framework.version !== profileRef.frameworkVersion
        || profile.profile.id !== profileRef.profileId
        || profile.profile.version !== profileRef.profileVersion
    ) {
        fail('profile_identity_mismatch', '$.profileRef');
    }
    if (profile.catalogueSha256 !== profileRef.catalogueSha256) {
        fail('profile_digest_mismatch', '$.profileRef.catalogueSha256');
    }
    const hasSourceDigest = Object.hasOwn(profile, 'sourceCatalogueSha256');
    const refHasSourceDigest = Object.hasOwn(profileRef, 'sourceCatalogueSha256');
    if (
        hasSourceDigest !== refHasSourceDigest
        || (hasSourceDigest && profile.sourceCatalogueSha256 !== profileRef.sourceCatalogueSha256)
    ) {
        fail('framework_snapshot_stale', '$.profileRef.sourceCatalogueSha256');
    }
    if (!Array.isArray(profile.domains) || !Array.isArray(profile.controls) || !Array.isArray(profile.questions)) {
        fail('profile_scoring_incompatible', '$.resolvedProfile');
    }
    if (!Array.isArray(profile.responseOptions)) {
        fail('profile_scoring_incompatible', '$.resolvedProfile.responseOptions');
    }
    if (
        profile.domains.length > 64
        || profile.controls.length > 512
        || profile.questions.length > 1024
        || profile.responseOptions.length > 32
    ) {
        fail('profile_scoring_incompatible', '$.resolvedProfile');
    }
    assertProfileEffective(profile.profile, scoreAsOf);
    assertFrameworkSourcesCurrent(profile.sources, scoreAsOf);

    const domainById = uniqueById(profile.domains, '$.resolvedProfile.domains');
    const controlById = uniqueById(profile.controls, '$.resolvedProfile.controls');
    const optionById = uniqueById(profile.responseOptions, '$.resolvedProfile.responseOptions');

    const domains = profile.domains.map((domain, index) => {
        if (!Number.isSafeInteger(domain.order) || domain.order < 1) {
            fail('profile_scoring_incompatible', `$.resolvedProfile.domains[${index}].order`);
        }
        return { id: domain.id, order: domain.order };
    }).sort(compareDomain);
    const domainOrderById = new Map(domains.map((domain, index) => [domain.id, index]));

    const controls = profile.controls.map((control, index) => {
        const domain = domainById.get(control.domainId);
        if (!domain || !Number.isSafeInteger(control.order) || control.order < 1) {
            fail('profile_scoring_incompatible', `$.resolvedProfile.controls[${index}]`);
        }
        return {
            id: control.id,
            domainId: control.domainId,
            order: control.order,
            sourceReferences: normalizeSourceReferences(
                control.sourceReferences,
                `$.resolvedProfile.controls[${index}].sourceReferences`
            )
        };
    }).sort((left, right) => (
        domainOrderById.get(left.domainId) - domainOrderById.get(right.domainId)
        || left.order - right.order
        || compareAscii(left.id, right.id)
    ));
    const normalizedControlById = new Map(controls.map((control) => [control.id, control]));

    const questions = profile.questions.map((question, index) => {
        const control = controlById.get(question.controlId);
        if (!control) {
            fail('profile_scoring_incompatible', `$.resolvedProfile.questions[${index}].controlId`);
        }
        if (!Number.isSafeInteger(question.order) || question.order < 1) {
            fail('profile_scoring_incompatible', `$.resolvedProfile.questions[${index}].order`);
        }
        if (!Number.isSafeInteger(question.weight) || question.weight < 1 || question.weight > 1000) {
            fail('invalid_atom_weight', `$.resolvedProfile.questions[${index}].weight`, question.id);
        }
        if (!Array.isArray(question.responseOptionIds)) {
            fail('unsupported_response_semantics', `$.resolvedProfile.questions[${index}].responseOptionIds`, question.id);
        }
        const semanticsByOptionId = new Map();
        const semanticCounts = new Map([
            ['yes', 0],
            ['partial', 0],
            ['no', 0],
            ['unknown', 0],
            ['not_applicable', 0]
        ]);
        question.responseOptionIds.forEach((optionId) => {
            const option = optionById.get(optionId);
            if (!option) {
                fail('unsupported_response_semantics', `$.resolvedProfile.questions[${index}].responseOptionIds`, question.id);
            }
            const semantic = classifyResponseOption(option, question.id);
            semanticsByOptionId.set(optionId, semantic);
            semanticCounts.set(semantic, semanticCounts.get(semantic) + 1);
        });
        if (
            ['yes', 'partial', 'no', 'unknown'].some((semantic) => semanticCounts.get(semantic) !== 1)
            || semanticCounts.get('not_applicable') > 1
        ) {
            fail('unsupported_response_semantics', `$.resolvedProfile.questions[${index}].responseOptionIds`, question.id);
        }
        const domain = domainById.get(control.domainId);
        return {
            id: question.id,
            controlId: question.controlId,
            domainId: control.domainId,
            domainOrder: domain.order,
            controlOrder: control.order,
            questionOrder: question.order,
            weight: question.weight,
            semanticsByOptionId,
            sourceReferences: normalizedControlById.get(question.controlId).sourceReferences
        };
    }).sort(compareQuestion);

    const questionById = new Map();
    questions.forEach((question) => {
        if (questionById.has(question.id)) {
            fail('profile_scoring_incompatible', '$.resolvedProfile.questions');
        }
        questionById.set(question.id, question);
    });
    const maximumCreditUnits = questions.reduce(
        (total, question) => total + (BigInt(question.weight) * BigInt(CREDIT_UNIT_SCALE)),
        0n
    );
    if (maximumCreditUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail('arithmetic_out_of_bounds', '$.resolvedProfile.questions');
    }

    const mapping = questions.map((question) => ({
        itemId: question.id,
        controlId: question.controlId,
        domainId: question.domainId,
        domainOrder: question.domainOrder,
        controlOrder: question.controlOrder,
        questionOrder: question.questionOrder,
        sourceReferences: question.sourceReferences
    }));
    const weights = questions.map((question) => ({
        itemId: question.id,
        weight: question.weight
    }));
    return {
        domains,
        controls,
        questions,
        questionById,
        mappingSha256: hashCanonical('nofries:eng003:mapping:v1', mapping),
        weightSetSha256: hashCanonical('nofries:eng003:weight-set:v1', weights),
        scoredAtomSetSha256: hashCanonical(
            'nofries:eng003:scored-atom-set:v1',
            questions.map((question) => ({ itemId: question.id }))
        )
    };
}

function uniqueById(items, path) {
    const output = new Map();
    items.forEach((item, index) => {
        if (!item || typeof item.id !== 'string' || output.has(item.id)) {
            fail('profile_scoring_incompatible', `${path}[${index}].id`);
        }
        output.set(item.id, item);
    });
    return output;
}

function assertProfileEffective(profileMetadata, scoreAsOf) {
    if (!Object.hasOwn(profileMetadata, 'effectiveFrom')) return;
    const path = '$.resolvedProfile.profile.effectiveFrom';
    const effectiveFrom = copyDateOnly(profileMetadata.effectiveFrom, path);
    if (scoreAsOf.slice(0, 10) < effectiveFrom) {
        fail('profile_not_yet_effective', path);
    }
}

function assertFrameworkSourcesCurrent(sources, scoreAsOf) {
    if (!Array.isArray(sources)) {
        fail('profile_scoring_incompatible', '$.resolvedProfile.sources');
    }
    const scoreDate = scoreAsOf.slice(0, 10);
    sources.forEach((source, index) => {
        if (!source || typeof source !== 'object') {
            fail('profile_scoring_incompatible', `$.resolvedProfile.sources[${index}]`);
        }
        if (Object.hasOwn(source, 'reviewDueAt')) {
            const reviewDueAt = copyDateOnly(
                source.reviewDueAt,
                `$.resolvedProfile.sources[${index}].reviewDueAt`
            );
            if (scoreDate > reviewDueAt) {
                fail('framework_snapshot_stale', `$.resolvedProfile.sources[${index}].reviewDueAt`);
            }
        }
    });
}

function normalizeSourceReferences(value, path) {
    if (!Array.isArray(value)) fail('profile_scoring_incompatible', path);
    return value.map((reference, index) => {
        if (!reference || typeof reference !== 'object') {
            fail('profile_scoring_incompatible', `${path}[${index}]`);
        }
        if (
            typeof reference.sourceId !== 'string'
            || typeof reference.referenceId !== 'string'
            || !Number.isSafeInteger(reference.order)
            || reference.order < 1
        ) {
            fail('profile_scoring_incompatible', `${path}[${index}]`);
        }
        return {
            sourceId: reference.sourceId,
            referenceId: reference.referenceId,
            order: reference.order
        };
    }).sort((left, right) => (
        left.order - right.order
        || compareAscii(left.sourceId, right.sourceId)
        || compareAscii(left.referenceId, right.referenceId)
    ));
}

function classifyResponseOption(option, itemId) {
    if (
        typeof option.applicable !== 'boolean'
        || (
            option.implementationFactor !== null
            && (
                typeof option.implementationFactor !== 'number'
                || !Number.isFinite(option.implementationFactor)
                || Object.is(option.implementationFactor, -0)
            )
        )
    ) {
        fail('unsupported_response_semantics', '$.resolvedProfile.responseOptions', itemId);
    }
    const key = `${String(option.applicable)}:${String(option.implementationFactor)}`;
    const semantic = SCORE_CONTRACT_RESPONSE_SEMANTICS[key];
    if (!semantic) fail('unsupported_response_semantics', '$.resolvedProfile.responseOptions', itemId);
    return semantic;
}

function normalizeInput(input, header, compiled, dependencies) {
    if (!Array.isArray(input.atomInputs)) {
        fail('atom_inputs_array_required', '$.atomInputs');
    }
    if (input.atomInputs.length > LIMITS.atomInputs) {
        fail('input_too_large', '$.atomInputs');
    }
    const atomInputById = new Map();
    input.atomInputs.forEach((value, index) => {
        const path = `$.atomInputs[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, [
            'itemId',
            'evidenceState',
            'statedImpact',
            'priorityOverlay'
        ], ['response', 'applicabilityClaim', 'applicabilityDecision'], path);
        const itemId = copyIdentifier(value.itemId, `${path}.itemId`);
        if (atomInputById.has(itemId)) fail('duplicate_atom_input', path, itemId);
        if (!compiled.questionById.has(itemId)) fail('unknown_atom_input', path, itemId);
        atomInputById.set(itemId, {
            raw: value,
            path,
            itemId,
            evidenceState: copyEnum(
                value.evidenceState,
                EVIDENCE_STATE_SET,
                'invalid_evidence_state',
                `${path}.evidenceState`,
                itemId
            ),
            statedImpact: copyEnum(
                value.statedImpact,
                STATED_IMPACTS,
                'invalid_business_impact',
                `${path}.statedImpact`,
                itemId
            ),
            priorityOverlay: copyEnum(
                value.priorityOverlay,
                PRIORITY_OVERLAYS,
                'invalid_priority_overlay',
                `${path}.priorityOverlay`,
                itemId
            )
        });
    });
    compiled.questions.forEach((question) => {
        if (!atomInputById.has(question.id)) {
            fail('missing_atom_input', '$.atomInputs', question.id);
        }
    });
    if (atomInputById.size !== compiled.questions.length) {
        fail('count_reconciliation_failed', '$.atomInputs');
    }

    const canonicalHeader = {
        schemaVersion: INPUT_SCHEMA_VERSION,
        scoreContractVersion: SCORE_CONTRACT_VERSION,
        organisationId: header.organisationId,
        moduleId: header.moduleId,
        assessmentId: header.assessmentId,
        assessmentRevision: header.assessmentRevision,
        profileRef: header.profileRef,
        scoreAsOf: header.scoreAsOf,
        scopePopulationSha256: header.scopePopulationSha256,
        evidenceSnapshot: header.evidenceSnapshot,
        riskContextSnapshot: header.riskContextSnapshot
    };
    return {
        ...header,
        canonicalHeader,
        atomInputById,
        applicabilityDecisionRegistry: dependencies.applicabilityDecisionRegistry
    };
}

function normalizeAtom(atomInput, question, input) {
    const { raw, path, itemId } = atomInput;
    const hasResponse = Object.hasOwn(raw, 'response');
    const hasClaim = Object.hasOwn(raw, 'applicabilityClaim');
    const hasDecision = Object.hasOwn(raw, 'applicabilityDecision');
    let optionId = null;
    let semantic = 'unknown';
    let responseOrigin = 'missing';
    let applicabilityClaimSha256 = null;
    let applicabilityDecisionId = null;
    let applicabilityDecisionSha256 = null;

    if (hasResponse) {
        if (raw.response === null) fail('null_response_invalid', `${path}.response`, itemId);
        assertPlainObject(raw.response, `${path}.response`);
        assertExactKeys(raw.response, ['optionId'], [], `${path}.response`);
        optionId = copyIdentifier(raw.response.optionId, `${path}.response.optionId`);
        if (!question.semanticsByOptionId.has(optionId)) {
            fail('response_option_not_allowed', `${path}.response.optionId`, itemId);
        }
        semantic = question.semanticsByOptionId.get(optionId);
        responseOrigin = semantic === 'unknown' ? 'direct_unknown' : 'direct';
    }

    if (!hasResponse && (hasClaim || hasDecision)) {
        fail('contradictory_applicability_fields', path, itemId);
    }
    if (semantic !== 'not_applicable' && (hasClaim || hasDecision)) {
        fail('contradictory_applicability_fields', path, itemId);
    }

    if (semantic === 'not_applicable') {
        if (!hasClaim) fail('not_applicable_rationale_required', path, itemId);
        applicabilityClaimSha256 = copyApplicabilityClaim(
            raw.applicabilityClaim,
            `${path}.applicabilityClaim`,
            itemId
        );
        if (hasDecision) {
            const decision = copyAndVerifyDecision(
                raw.applicabilityDecision,
                `${path}.applicabilityDecision`,
                itemId,
                input,
                applicabilityClaimSha256
            );
            applicabilityDecisionId = decision.decisionId;
            applicabilityDecisionSha256 = decision.decisionSha256;
            responseOrigin = 'approved_not_applicable';
            semantic = 'approved_not_applicable';
        } else {
            responseOrigin = 'claimed_not_applicable';
            semantic = 'unknown';
        }
    }

    const applicable = semantic !== 'approved_not_applicable';
    const credit = creditForSemantic(semantic, question.weight);
    const canonicalInput = {
        itemId,
        response: hasResponse ? { optionId } : null,
        responseOrigin,
        evidenceState: atomInput.evidenceState,
        statedImpact: atomInput.statedImpact,
        priorityOverlay: atomInput.priorityOverlay,
        applicabilityClaimSha256,
        applicabilityDecisionId,
        applicabilityDecisionSha256
    };
    return {
        itemId,
        controlId: question.controlId,
        domainId: question.domainId,
        weight: question.weight,
        optionId,
        semantic,
        responseOrigin,
        applicable,
        evidenceState: atomInput.evidenceState,
        statedImpact: atomInput.statedImpact,
        priorityOverlay: atomInput.priorityOverlay,
        lowerCreditUnits: credit.lowerCreditUnits,
        upperCreditUnits: credit.upperCreditUnits,
        applicabilityClaimSha256,
        applicabilityDecisionId,
        applicabilityDecisionSha256,
        canonicalInput
    };
}

function copyApplicabilityClaim(value, path, itemId) {
    assertPlainObject(value, path);
    assertExactKeys(value, ['rationaleSha256'], [], path);
    return copySha256(value.rationaleSha256, `${path}.rationaleSha256`, itemId);
}

function copyAndVerifyDecision(value, path, itemId, input, rationaleSha256) {
    assertPlainObject(value, path);
    assertExactKeys(value, [...DECISION_CORE_KEYS, 'decisionSha256'], [], path);
    const core = copyDecisionCore(value, path);
    const decisionSha256 = copySha256(value.decisionSha256, `${path}.decisionSha256`, itemId);
    const calculated = hashCanonical('nofries:eng003:applicability-decision:v1', core);
    if (decisionSha256 !== calculated) {
        fail('applicability_decision_digest_mismatch', `${path}.decisionSha256`, itemId);
    }
    if (
        core.organisationId !== input.organisationId
        || core.moduleId !== input.moduleId
        || core.assessmentId !== input.assessmentId
        || core.assessmentRevision !== input.assessmentRevision
        || core.itemId !== itemId
        || core.frameworkId !== input.profileRef.frameworkId
        || core.frameworkVersion !== input.profileRef.frameworkVersion
        || core.profileId !== input.profileRef.profileId
        || core.profileVersion !== input.profileRef.profileVersion
        || core.catalogueSha256 !== input.profileRef.catalogueSha256
        || core.scopePopulationSha256 !== input.scopePopulationSha256
        || core.rationaleSha256 !== rationaleSha256
        || core.approvedAt > input.scoreAsOf
    ) {
        fail('applicability_decision_mismatch', path, itemId);
    }
    const trustedRegistry = input.applicabilityDecisionRegistry;
    if (!trustedRegistry) fail('applicability_decision_untrusted', path, itemId);
    let trustedValue;
    try {
        trustedValue = trustedRegistry.getDecision(decisionSha256);
    } catch {
        fail('applicability_decision_untrusted', path, itemId);
    }
    inspectJsonGraph(trustedValue, '$trustedApplicabilityDecision', 65536);
    assertPlainObject(trustedValue, '$trustedApplicabilityDecision');
    assertExactKeys(
        trustedValue,
        [...DECISION_CORE_KEYS, 'decisionSha256'],
        [],
        '$trustedApplicabilityDecision'
    );
    const trustedCore = copyDecisionCore(trustedValue, '$trustedApplicabilityDecision');
    const trustedSha256 = copySha256(
        trustedValue.decisionSha256,
        '$trustedApplicabilityDecision.decisionSha256',
        itemId
    );
    if (
        trustedSha256 !== decisionSha256
        || hashCanonical('nofries:eng003:applicability-decision:v1', trustedCore) !== trustedSha256
        || canonicalJson(trustedCore) !== canonicalJson(core)
    ) {
        fail('applicability_decision_untrusted', path, itemId);
    }
    return { ...core, decisionSha256 };
}

function copyDecisionCore(value, path) {
    return {
        decisionId: copyIdentifier(value.decisionId, `${path}.decisionId`),
        decisionRevision: copyVersion(value.decisionRevision, `${path}.decisionRevision`),
        organisationId: copyIdentifier(value.organisationId, `${path}.organisationId`),
        moduleId: copyIdentifier(value.moduleId, `${path}.moduleId`),
        assessmentId: copyIdentifier(value.assessmentId, `${path}.assessmentId`),
        assessmentRevision: copyVersion(value.assessmentRevision, `${path}.assessmentRevision`),
        itemId: copyIdentifier(value.itemId, `${path}.itemId`),
        frameworkId: copyIdentifier(value.frameworkId, `${path}.frameworkId`),
        frameworkVersion: copyVersion(value.frameworkVersion, `${path}.frameworkVersion`),
        profileId: copyIdentifier(value.profileId, `${path}.profileId`),
        profileVersion: copyVersion(value.profileVersion, `${path}.profileVersion`),
        catalogueSha256: copySha256(value.catalogueSha256, `${path}.catalogueSha256`),
        scopePopulationSha256: copySha256(
            value.scopePopulationSha256,
            `${path}.scopePopulationSha256`
        ),
        status: copyLiteral(value.status, 'approved', `${path}.status`),
        rationaleSha256: copySha256(value.rationaleSha256, `${path}.rationaleSha256`),
        approvedBy: copyIdentifier(value.approvedBy, `${path}.approvedBy`),
        approvedAt: copyCanonicalUtcDateTime(value.approvedAt, `${path}.approvedAt`)
    };
}

function calculateApplicabilityDecisionSha256(value) {
    inspectJsonGraph(value, '$', 65536);
    assertPlainObject(value, '$');
    assertExactKeys(value, DECISION_CORE_KEYS, [], '$');
    const core = copyDecisionCore(value, '$');
    return hashCanonical('nofries:eng003:applicability-decision:v1', core);
}

function creditForSemantic(semantic, weight) {
    if (semantic === 'yes') {
        return { lowerCreditUnits: weight * CREDIT_UNIT_SCALE, upperCreditUnits: weight * CREDIT_UNIT_SCALE };
    }
    if (semantic === 'partial') {
        return { lowerCreditUnits: weight, upperCreditUnits: weight };
    }
    if (semantic === 'no') {
        return { lowerCreditUnits: 0, upperCreditUnits: 0 };
    }
    if (semantic === 'approved_not_applicable') {
        return { lowerCreditUnits: 0, upperCreditUnits: 0 };
    }
    return { lowerCreditUnits: 0, upperCreditUnits: weight * CREDIT_UNIT_SCALE };
}

function publicAtom(atom) {
    return {
        itemId: atom.itemId,
        controlId: atom.controlId,
        domainId: atom.domainId,
        weight: atom.weight,
        responseOptionId: atom.optionId,
        response: atom.semantic,
        responseOrigin: atom.responseOrigin,
        applicable: atom.applicable,
        evidenceState: atom.evidenceState,
        statedImpact: atom.statedImpact,
        priorityOverlay: atom.priorityOverlay,
        lowerCreditUnits: atom.lowerCreditUnits,
        upperCreditUnits: atom.upperCreditUnits,
        applicabilityClaimSha256: atom.applicabilityClaimSha256,
        applicabilityDecisionId: atom.applicabilityDecisionId,
        applicabilityDecisionSha256: atom.applicabilityDecisionSha256
    };
}

function aggregateAtoms(atoms) {
    const counts = {
        totalAtoms: atoms.length,
        applicableAtoms: 0,
        approvedNotApplicableAtoms: 0,
        claimedNotApplicableAtoms: 0,
        yes: 0,
        partial: 0,
        no: 0,
        unknown: 0,
        directUnknown: 0,
        missing: 0,
        completionNumerator: 0,
        completionDenominator: 0,
        completionStatus: 'not_scored',
        completionPercentTenths: null,
        completionDisplay: null
    };
    const distribution = Object.fromEntries(EVIDENCE_STATES.map((state) => [state, 0]));
    let lowerCreditUnits = 0n;
    let upperCreditUnits = 0n;
    let denominatorWeight = 0n;
    let provided = 0;
    let substantiated = 0;
    let tested = 0;

    atoms.forEach((atom) => {
        if (!atom.applicable) {
            counts.approvedNotApplicableAtoms += 1;
            return;
        }
        counts.applicableAtoms += 1;
        counts.completionDenominator += 1;
        denominatorWeight += BigInt(atom.weight);
        lowerCreditUnits += BigInt(atom.lowerCreditUnits);
        upperCreditUnits += BigInt(atom.upperCreditUnits);
        distribution[atom.evidenceState] += 1;
        if (PROVIDED_EVIDENCE_STATES.has(atom.evidenceState)) provided += 1;
        if (SUBSTANTIATED_EVIDENCE_STATES.has(atom.evidenceState)) substantiated += 1;
        if (TESTED_EVIDENCE_STATES.has(atom.evidenceState)) tested += 1;

        if (atom.semantic === 'yes' || atom.semantic === 'partial' || atom.semantic === 'no') {
            counts[atom.semantic] += 1;
            counts.completionNumerator += 1;
        } else {
            counts.unknown += 1;
            if (atom.responseOrigin === 'missing') counts.missing += 1;
            if (atom.responseOrigin === 'direct_unknown') counts.directUnknown += 1;
            if (atom.responseOrigin === 'claimed_not_applicable') {
                counts.claimedNotApplicableAtoms += 1;
            }
        }
    });

    if (counts.completionDenominator > 0) {
        counts.completionStatus = counts.unknown > 0 ? 'provisional' : 'complete';
        counts.completionPercentTenths = ratioToPercentTenths(
            BigInt(counts.completionNumerator),
            BigInt(counts.completionDenominator)
        );
        counts.completionDisplay = formatPercentTenths(counts.completionPercentTenths);
    }
    const denominatorWeightNumber = checkedNumber(denominatorWeight);
    const denominatorCreditUnits = denominatorWeight * BigInt(CREDIT_UNIT_SCALE);
    const scored = denominatorWeight > 0n;
    const lowerPercentTenths = scored
        ? ratioToPercentTenths(lowerCreditUnits, denominatorCreditUnits)
        : null;
    const upperPercentTenths = scored
        ? ratioToPercentTenths(upperCreditUnits, denominatorCreditUnits)
        : null;

    return {
        countsCompletion: counts,
        attainment: {
            status: scored ? 'scored' : 'not_scored',
            creditUnitScale: CREDIT_UNIT_SCALE,
            lowerCreditUnits: checkedNumber(lowerCreditUnits),
            upperCreditUnits: checkedNumber(upperCreditUnits),
            denominatorWeight: denominatorWeightNumber,
            lowerPercentTenths,
            upperPercentTenths,
            lowerDisplay: lowerPercentTenths === null ? null : formatPercentTenths(lowerPercentTenths),
            upperDisplay: upperPercentTenths === null ? null : formatPercentTenths(upperPercentTenths)
        },
        evidence: {
            distribution,
            denominator: counts.applicableAtoms,
            providedCoverage: buildCoverage(provided, counts.applicableAtoms),
            substantiatedCoverage: buildCoverage(substantiated, counts.applicableAtoms),
            testedCoverage: buildCoverage(tested, counts.applicableAtoms)
        }
    };
}

function groupAtoms(atoms, key) {
    const groups = new Map();
    atoms.forEach((atom) => {
        let group = groups.get(atom[key]);
        if (!group) {
            group = [];
            groups.set(atom[key], group);
        }
        group.push(atom);
    });
    return groups;
}

function buildCoverage(numerator, denominator) {
    const percentTenths = denominator === 0
        ? null
        : ratioToPercentTenths(BigInt(numerator), BigInt(denominator));
    return {
        numerator,
        denominator,
        percentTenths,
        display: percentTenths === null ? null : formatPercentTenths(percentTenths)
    };
}

function assertCountReconciliation(atoms) {
    const aggregate = aggregateAtoms(atoms);
    const counts = aggregate.countsCompletion;
    if (
        counts.totalAtoms !== counts.applicableAtoms + counts.approvedNotApplicableAtoms
        || counts.applicableAtoms !== counts.yes + counts.partial + counts.no + counts.unknown
        || counts.unknown !== counts.directUnknown + counts.missing + counts.claimedNotApplicableAtoms
    ) {
        fail('count_reconciliation_failed', '$.atomInputs');
    }
}

function assertSnapshotBindings(atoms, input) {
    const evidenceSha256 = hashCanonical(
        'nofries:eng003:evidence-snapshot-body:v1',
        atoms.map((atom) => ({
            itemId: atom.itemId,
            evidenceState: atom.evidenceState
        })).sort((left, right) => compareAscii(left.itemId, right.itemId))
    );
    if (evidenceSha256 !== input.evidenceSnapshot.sha256) {
        fail('evidence_snapshot_mismatch', '$.evidenceSnapshot.sha256');
    }
    const riskSha256 = hashCanonical(
        'nofries:eng003:risk-context-snapshot-body:v1',
        atoms.map((atom) => ({
            itemId: atom.itemId,
            priorityOverlay: atom.priorityOverlay,
            statedImpact: atom.statedImpact
        })).sort((left, right) => compareAscii(left.itemId, right.itemId))
    );
    if (riskSha256 !== input.riskContextSnapshot.sha256) {
        fail('risk_context_snapshot_mismatch', '$.riskContextSnapshot.sha256');
    }
}

function calculateEvidenceSnapshotSha256(entries) {
    inspectJsonGraph(entries, '$', LIMITS.inputBytes);
    if (!Array.isArray(entries)) fail('atom_inputs_array_required', '$');
    const normalized = normalizeSnapshotEntries(entries, 'evidence');
    return hashCanonical('nofries:eng003:evidence-snapshot-body:v1', normalized);
}

function calculateRiskContextSnapshotSha256(entries) {
    inspectJsonGraph(entries, '$', LIMITS.inputBytes);
    if (!Array.isArray(entries)) fail('atom_inputs_array_required', '$');
    const normalized = normalizeSnapshotEntries(entries, 'risk');
    return hashCanonical('nofries:eng003:risk-context-snapshot-body:v1', normalized);
}

function normalizeSnapshotEntries(entries, kind) {
    const ids = new Set();
    return entries.map((entry, index) => {
        const path = `$[${index}]`;
        assertPlainObject(entry, path);
        const itemId = copyIdentifier(entry.itemId, `${path}.itemId`);
        if (ids.has(itemId)) fail('duplicate_atom_input', path, itemId);
        ids.add(itemId);
        if (kind === 'evidence') {
            assertExactKeys(entry, ['itemId', 'evidenceState'], [], path);
            return {
                itemId,
                evidenceState: copyEnum(
                    entry.evidenceState,
                    EVIDENCE_STATE_SET,
                    'invalid_evidence_state',
                    `${path}.evidenceState`,
                    itemId
                )
            };
        }
        assertExactKeys(entry, ['itemId', 'statedImpact', 'priorityOverlay'], [], path);
        return {
            itemId,
            priorityOverlay: copyEnum(
                entry.priorityOverlay,
                PRIORITY_OVERLAYS,
                'invalid_priority_overlay',
                `${path}.priorityOverlay`,
                itemId
            ),
            statedImpact: copyEnum(
                entry.statedImpact,
                STATED_IMPACTS,
                'invalid_business_impact',
                `${path}.statedImpact`,
                itemId
            )
        };
    }).sort((left, right) => compareAscii(left.itemId, right.itemId));
}

function assertUniqueApplicabilityDecisions(atoms) {
    const decisionIds = new Set();
    const decisionDigests = new Set();
    atoms.forEach((atom) => {
        if (!atom.applicabilityDecisionId) return;
        if (
            decisionIds.has(atom.applicabilityDecisionId)
            || decisionDigests.has(atom.applicabilityDecisionSha256)
        ) {
            fail('duplicate_applicability_decision', '$.atomInputs', atom.itemId);
        }
        decisionIds.add(atom.applicabilityDecisionId);
        decisionDigests.add(atom.applicabilityDecisionSha256);
    });
}

function ratioToPercentTenths(numerator, denominator) {
    if (numerator < 0n || denominator <= 0n) fail('arithmetic_out_of_bounds', '$');
    const scaled = numerator * 1000n;
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    return checkedNumber(quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

function formatPercentTenths(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('arithmetic_out_of_bounds', '$');
    return `${Math.floor(value / 10)}.${value % 10}%`;
}

function checkedNumber(value) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
        fail('arithmetic_out_of_bounds', '$');
    }
    return Number(value);
}

function serialiseAssessmentEvaluation(value) {
    inspectJsonGraph(value, '$', LIMITS.inputBytes);
    return canonicalJson(value);
}

function hashCanonical(domain, value) {
    return crypto.createHash('sha256')
        .update(domain, 'utf8')
        .update('\u0000', 'utf8')
        .update(canonicalJson(value), 'utf8')
        .digest('hex');
}

function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
            fail('canonicalisation_failed', '$');
        }
        return String(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            fail('canonicalisation_failed', '$');
        }
        return `{${Object.keys(value).sort(compareAscii).map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(',')}}`;
    }
    fail('canonicalisation_failed', '$');
}

function inspectJsonGraph(value, path, byteLimit) {
    let nodes = 0;
    let bytes = 0;
    const addBytes = (amount) => {
        bytes += amount;
        if (bytes > byteLimit) fail('input_too_large', path);
    };
    const addCanonicalStringBytes = (string) => {
        // Every UTF-16 code unit contributes at least one output byte. Reject
        // obviously oversized strings before walking them or allocating an
        // escaped copy through JSON.stringify.
        if (string.length + 2 > byteLimit - bytes) fail('input_too_large', path);
        addBytes(2);
        let pending = 0;
        for (let index = 0; index < string.length; index += 1) {
            const code = string.charCodeAt(index);
            if (
                code === 0x22 || code === 0x5c || code === 0x08 ||
                code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
            ) {
                pending += 2;
            } else if (code <= 0x1f) {
                pending += 6;
            } else if (code >= 0xd800 && code <= 0xdbff) {
                const next = string.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    pending += 4;
                    index += 1;
                } else {
                    pending += 6;
                }
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                pending += 6;
            } else if (code <= 0x7f) {
                pending += 1;
            } else if (code <= 0x7ff) {
                pending += 2;
            } else {
                pending += 3;
            }
            if (pending >= 4096) {
                addBytes(pending);
                pending = 0;
            }
        }
        addBytes(pending);
    };
    const active = new WeakSet();
    const stack = [{ value, path, depth: 0, leaving: false }];
    while (stack.length > 0) {
        const entry = stack.pop();
        const current = entry.value;
        if (entry.leaving) {
            active.delete(current);
            continue;
        }
        nodes += 1;
        if (nodes > LIMITS.graphNodes) fail('definition_too_complex', path);
        if (entry.depth > LIMITS.graphDepth) fail('definition_too_complex', path);
        if (current === null) {
            addBytes(4);
            continue;
        }
        if (typeof current === 'boolean') {
            addBytes(current ? 4 : 5);
            continue;
        }
        if (typeof current === 'string') {
            addCanonicalStringBytes(current);
            continue;
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                fail('canonicalisation_failed', entry.path);
            }
            addBytes(Buffer.byteLength(String(current), 'utf8'));
            continue;
        }
        if (typeof current !== 'object') fail('canonicalisation_failed', entry.path);
        if (utilTypes.isProxy(current)) fail('non_plain_object', entry.path);
        const isArray = Array.isArray(current);
        if (isArray && current.length > LIMITS.atomInputs) {
            fail('input_too_large', entry.path);
        }
        const prototype = Object.getPrototypeOf(current);
        if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            fail('non_plain_object', entry.path);
        }
        if (active.has(current)) fail('definition_too_complex', entry.path);
        active.add(current);
        stack.push({ ...entry, leaving: true });
        const keys = Reflect.ownKeys(current);
        if (keys.length > LIMITS.graphNodes) {
            fail('definition_too_complex', entry.path);
        }
        if (keys.some((key) => typeof key === 'symbol')) fail('non_plain_object', entry.path);
        if (isArray) {
            for (let index = 0; index < current.length; index += 1) {
                if (!Object.hasOwn(current, index)) fail('non_plain_object', entry.path);
            }
            const allowed = new Set(['length', ...Array.from({ length: current.length }, (_unused, index) => String(index))]);
            if (keys.some((key) => !allowed.has(key))) fail('non_plain_object', entry.path);
        }
        const itemCount = isArray ? current.length : keys.length;
        addBytes(2 + Math.max(0, itemCount - 1));
        const descriptors = Object.getOwnPropertyDescriptors(current);
        Object.keys(descriptors).reverse().forEach((key) => {
            if (Buffer.byteLength(key, 'utf8') > LIMITS.keyBytes) fail('input_too_large', entry.path);
            if (FORBIDDEN_KEYS.has(key)) fail('forbidden_key', entry.path);
            const descriptor = descriptors[key];
            if (descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
                fail('non_plain_object', entry.path);
            }
            const isArrayLength = isArray && key === 'length';
            if (!isArrayLength && (!descriptor.enumerable || descriptor.value === undefined)) {
                fail('canonicalisation_failed', entry.path);
            }
            if (!isArrayLength) {
                if (!isArray) {
                    addCanonicalStringBytes(key);
                    addBytes(1);
                }
                stack.push({
                    value: descriptor.value,
                    path: isArray ? `${entry.path}[${key}]` : `${entry.path}.*`,
                    depth: entry.depth + 1,
                    leaving: false
                });
            }
        });
    }
}

function assertPlainObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('input_object_required', path);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('non_plain_object', path);
}

function assertExactKeys(value, required, optional, path) {
    const allowed = new Set([...required, ...optional]);
    Object.keys(value).forEach((key) => {
        if (!allowed.has(key)) fail('unknown_field', `${path}.[unknown]`);
    });
    required.forEach((key) => {
        if (!Object.hasOwn(value, key)) fail('required_field_missing', `${path}.${key}`);
    });
}

function copyIdentifier(value, path) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('invalid_identifier', path);
    return value;
}

function copyVersion(value, path) {
    if (
        typeof value !== 'string'
        || !VERSION_PATTERN.test(value)
        || value.toLowerCase() === 'latest'
    ) {
        fail('invalid_version', path);
    }
    return value;
}

function copySha256(value, path, itemId) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        fail('invalid_sha256', path, itemId);
    }
    return value;
}

function copyCanonicalUtcDateTime(value, path) {
    if (typeof value !== 'string') fail('invalid_score_as_of', path);
    const match = CANONICAL_UTC_DATE_TIME.exec(value);
    if (!match) fail('invalid_score_as_of', path);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        year < 1
        || month < 1
        || month > 12
        || day < 1
        || day > monthDays[month - 1]
        || hour > 23
        || minute > 59
        || second > 59
    ) {
        fail('invalid_score_as_of', path);
    }
    return value;
}

function copyDateOnly(value, path) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        fail('profile_scoring_incompatible', path);
    }
    const [year, month, day] = value.split('-').map(Number);
    const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        year < 1
        || month < 1
        || month > 12
        || day < 1
        || day > monthDays[month - 1]
    ) {
        fail('profile_scoring_incompatible', path);
    }
    return value;
}

function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function copyEnum(value, allowed, code, path, itemId) {
    if (typeof value !== 'string' || !allowed.has(value)) fail(code, path, itemId);
    return value;
}

function copyLiteral(value, expected, path) {
    if (value !== expected) fail('applicability_decision_mismatch', path);
    return value;
}

function compareDomain(left, right) {
    return left.order - right.order || compareAscii(left.id, right.id);
}

function compareQuestion(left, right) {
    return left.domainOrder - right.domainOrder
        || compareAscii(left.domainId, right.domainId)
        || left.controlOrder - right.controlOrder
        || compareAscii(left.controlId, right.controlId)
        || left.questionOrder - right.questionOrder
        || compareAscii(left.id, right.id);
}

function compareAscii(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

function fail(code, path, itemId) {
    throw new AssessmentEvaluationError(code, path, itemId);
}

module.exports = {
    ASSESSMENT_EVALUATOR_VERSION,
    AssessmentEvaluationError,
    CREDIT_UNIT_SCALE,
    EVALUATOR_ID,
    EVIDENCE_STATES,
    INPUT_SCHEMA_VERSION,
    OUTPUT_SCHEMA_VERSION,
    SCORE_CONTRACT_VERSION,
    calculateApplicabilityDecisionSha256,
    calculateEvidenceSnapshotSha256,
    calculateRiskContextSnapshotSha256,
    evaluateAssessment,
    serialiseAssessmentEvaluation
};
