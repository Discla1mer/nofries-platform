'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');
const { normaliseAssessmentState } = require('./assessmentDomain');
const { createFrameworkRegistry } = require('../assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../assessmentEngine/ncscAcceptedFrameworkProfile');
const { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment } = require('../assessmentEngine/ncscAssessmentEvaluator');
const { SCORE_CONTRACT_VERSION, calculateEvidenceSnapshotSha256,
    calculateRiskContextSnapshotSha256 } = require('../assessmentEngine/assessmentEvaluator');

const acceptedProfile = createAcceptedNcscFrameworkProfile();
const acceptedRegistry = createFrameworkRegistry([acceptedProfile]);
const OWNER_FIELDS = ['tenantId', 'organisationId', 'assessmentId'];
const RECORD_FIELDS = ['schemaVersion', ...OWNER_FIELDS, 'recordedRevision', 'recordedAt'];
const VERSION_FIELDS = ['schemaVersion', ...OWNER_FIELDS, 'revision', 'state',
    'scopePopulation', 'rationales', 'evidence', 'risk', 'submission'];
const HASH_KINDS = new Set(['scope', 'rationale', 'evidence', 'risk', 'version', 'intent', 'receipt', 'policy', 'result']);
const MAX_VERSION_BYTES = 256 * 1024;
const QUESTION_IDS = new Set(acceptedProfile.questions.map(question => question.id));
const OPTIONS = new Map(acceptedProfile.responseOptions.map(option => [option.id, option]));

class NcscCandidateSizeError extends Error {
    constructor() {
        super('ncsc_candidate_too_large');
        this.name = 'NcscCandidateSizeError';
    }
}

/** Check only freshly constructed candidates; retained records keep their
 * corruption classification through the inspector's default mode.
 */
function assertNcscCandidateSize(input) {
    inspectJson(input, MAX_VERSION_BYTES, true);
}

/** Hash detached, bounded plain JSON; never invoke a supplied getter or toJSON. */
function hashNcscRecord(kind, core) {
    if (!HASH_KINDS.has(kind)) invalid();
    const { canonical } = inspectJson(core, kind === 'receipt' ? 1024 * 1024 : MAX_VERSION_BYTES);
    return crypto.createHash('sha256').update(`nofries:ncsc004:${kind}:v1\n${canonical}`).digest('hex');
}

/** Verify the complete retained source records before exposing or evaluating them.
 * A submitted envelope may temporarily have null submission while its result is
 * being built. Durable storage separately requires that result to be present.
 */
function validateNcscSupportingRecords(input) {
    const envelope = inspectJson(input, MAX_VERSION_BYTES).copy;
    exact(envelope, VERSION_FIELDS);
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) ||
        envelope.revision < 0 || envelope.revision > 128) invalid();
    let state;
    try { state = normaliseAssessmentState(envelope.state, acceptedRegistry); }
    catch { invalid(); }
    if (!same(state, envelope.state) || state.moduleId !== MODULE_ID ||
        !same(state.profileRef, ACCEPTED_PROFILE_REF) ||
        !['created', 'in-progress', 'submitted'].includes(state.status) ||
        state.revision !== envelope.revision || OWNER_FIELDS.some(key => envelope[key] !== state[key])) invalid();

    const scope = envelope.scopePopulation;
    validateRecord(scope, [...RECORD_FIELDS, 'actorSubjectKey', 'body', 'sha256'], 'scope', envelope);
    exact(scope.body, ['description']);
    text(scope.body.description);
    if (scope.recordedRevision !== 0 || scope.recordedAt !== state.createdAt ||
        scope.actorSubjectKey !== state.createdBy || scope.sha256 !== state.scopePopulationSha256) invalid();

    if (!Array.isArray(envelope.rationales) || envelope.rationales.length > QUESTION_IDS.size) invalid();
    const responses = new Map(state.responses.map(response => [response.itemId, response]));
    const claims = state.responses.filter(response => !OPTIONS.get(response.optionId).applicable);
    if (envelope.rationales.length !== claims.length) invalid();
    let previousItemId = null;
    for (const rationale of envelope.rationales) {
        validateRecord(rationale, [...RECORD_FIELDS, 'actorSubjectKey', 'itemId', 'body', 'sha256'], 'rationale', envelope);
        exact(rationale.body, ['text']);
        text(rationale.body.text);
        const response = responses.get(rationale.itemId);
        if (!response || OPTIONS.get(response.optionId).applicable ||
            (previousItemId !== null && previousItemId >= rationale.itemId) ||
            rationale.recordedRevision !== response.updatedRevision ||
            rationale.recordedAt !== response.updatedAt ||
            rationale.actorSubjectKey !== response.updatedBy ||
            rationale.sha256 !== response.applicabilityRationaleSha256) invalid();
        previousItemId = rationale.itemId;
    }

    for (const kind of ['evidence', 'risk']) {
        const record = envelope[kind];
        validateRecord(record, [...RECORD_FIELDS, 'profileRef', 'scopePopulationSha256', 'entries', 'sha256'], kind, envelope);
        if (record.recordedRevision !== 0 || record.recordedAt !== state.createdAt ||
            !same(record.profileRef, ACCEPTED_PROFILE_REF) || record.scopePopulationSha256 !== scope.sha256 ||
            !Array.isArray(record.entries) || record.entries.length !== QUESTION_IDS.size ||
            record.entries.some(entry => !entry || !QUESTION_IDS.has(entry.itemId)) ||
            new Set(record.entries.map(entry => entry.itemId)).size !== QUESTION_IDS.size) invalid();
        // ENG003 owns the exact allowed evidence/risk fields and vocabulary.
        try {
            if (kind === 'evidence') calculateEvidenceSnapshotSha256(record.entries);
            else calculateRiskContextSnapshotSha256(record.entries);
        } catch { invalid(); }
    }
    if (envelope.submission !== null) {
        exact(envelope.submission, ['input', 'evaluation']);
        if (state.status !== 'submitted' || !same(envelope.submission, constructSubmission(envelope))) invalid();
    }
    return freeze(envelope);
}

function buildNcscSubmission(envelopeInput) {
    const envelope = validateNcscSupportingRecords(envelopeInput);
    if (envelope.state.status !== 'submitted') {
        const error = new Error('ncsc_state_conflict');
        error.code = 'ncsc_state_conflict';
        error.statusCode = 409;
        throw error;
    }
    return envelope.submission || constructSubmission(envelope);
}

function constructSubmission(envelope) {
    const { state } = envelope;
    const responses = new Map(state.responses.map(response => [response.itemId, response]));
    const evidence = new Map(envelope.evidence.entries.map(entry => [entry.itemId, entry]));
    const risk = new Map(envelope.risk.entries.map(entry => [entry.itemId, entry]));
    const input = freeze({ schemaVersion: 1, scoreContractVersion: SCORE_CONTRACT_VERSION,
        organisationId: envelope.organisationId, moduleId: MODULE_ID,
        assessmentId: envelope.assessmentId, assessmentRevision: `rev-${state.submission.revision}`,
        profileRef: { ...ACCEPTED_PROFILE_REF }, scoreAsOf: state.submission.submittedAt,
        scopePopulationSha256: envelope.scopePopulation.sha256,
        evidenceSnapshot: { id: `evidence-${envelope.evidence.sha256}`,
            sha256: calculateEvidenceSnapshotSha256(envelope.evidence.entries) },
        riskContextSnapshot: { id: `risk-${envelope.risk.sha256}`,
            sha256: calculateRiskContextSnapshotSha256(envelope.risk.entries) },
        atomInputs: acceptedProfile.questions.map(question => {
            const response = responses.get(question.id), evidenceEntry = evidence.get(question.id), riskEntry = risk.get(question.id);
            return { itemId: question.id, response: { optionId: response.optionId },
                evidenceState: evidenceEntry.evidenceState, statedImpact: riskEntry.statedImpact,
                priorityOverlay: riskEntry.priorityOverlay,
                ...(response.applicabilityRationaleSha256 === null ? {} :
                    { applicabilityClaim: { rationaleSha256: response.applicabilityRationaleSha256 } }) };
        }) });
    // No decision registry is composed here. A rationale remains a pending claim.
    let evaluation;
    try { evaluation = evaluateAcceptedNcscAssessment(input); }
    catch { invalid(); }
    return freeze({ input, evaluation });
}

function validateRecord(record, fields, kind, envelope) {
    exact(record, fields);
    if (record.schemaVersion !== 1 || OWNER_FIELDS.some(key => record[key] !== envelope[key]) ||
        typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) invalid();
    const { sha256, ...core } = record;
    if (hashNcscRecord(kind, core) !== sha256) invalid();
}

function exact(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) invalid();
}
function text(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) invalid();
}
function same(left, right) {
    return inspectJson(left, MAX_VERSION_BYTES).canonical === inspectJson(right, MAX_VERSION_BYTES).canonical;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
function invalid() {
    const error = new Error('ncsc_record_invalid');
    error.code = 'ncsc_record_invalid';
    error.statusCode = 503;
    throw error;
}

function inspectJson(input, maxBytes, candidate = false) {
    const ancestors = new Set();
    let bytes = 0, nodes = 0;
    function count(value) {
        bytes += Buffer.byteLength(value, 'utf8');
        if (bytes > maxBytes) {
            if (candidate) throw new NcscCandidateSizeError();
            invalid();
        }
        return value;
    }
    function visit(value, depth) {
        if (depth > 64 || ++nodes > 64000) invalid();
        if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))) {
            if (typeof value === 'string' && value.length > maxBytes) invalid();
            return { copy: value, canonical: count(JSON.stringify(value)) };
        }
        if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
        if (array && value.length > 64000) invalid();
        const keys = Reflect.ownKeys(value);
        if (array) {
            if (keys.length !== value.length + 1) invalid();
        } else if (keys.length > 64000 || keys.some(key => typeof key !== 'string' ||
            ['__proto__', 'prototype', 'constructor'].includes(key) || Buffer.byteLength(key, 'utf8') > 256)) invalid();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        ancestors.add(value);
        const copy = array ? [] : {}, parts = [];
        count(array ? '[]' : '{}');
        const orderedKeys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : keys.sort();
        for (const key of orderedKeys) {
            const descriptor = descriptors[key];
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
            if (parts.length) count(',');
            const prefix = array ? '' : count(`${JSON.stringify(key)}:`);
            const child = visit(descriptor.value, depth + 1);
            if (array) copy.push(child.copy);
            else copy[key] = child.copy;
            parts.push(prefix + child.canonical);
        }
        ancestors.delete(value);
        return { copy, canonical: array ? `[${parts.join(',')}]` : `{${parts.join(',')}}` };
    }
    return visit(input, 0);
}

module.exports = { acceptedRegistry, acceptedProfile, hashNcscRecord,
    validateNcscSupportingRecords, buildNcscSubmission,
    assertNcscCandidateSize, NcscCandidateSizeError };
