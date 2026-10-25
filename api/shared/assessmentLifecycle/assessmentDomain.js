'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');
const { resolveOrganisation } = require('../appLifecycle/tenantDomain');
const { publishFrameworkProfile } = require('../assessmentEngine/frameworkProfileRegistry');

const SCHEMA_VERSION = 1;
const STATUSES = Object.freeze(['created', 'in-progress', 'submitted', 'reviewed', 'archived']);
const SCOPE_FIELDS = ['tenantId', 'organisationId', 'assessmentId'];
const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256'];
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RESPONSES = 1024;

class AssessmentDomainError extends Error {
    constructor(code, statusCode = 400) {
        super(`assessment_${code}`);
        this.name = 'AssessmentDomainError';
        this.code = `assessment_${code}`;
        this.statusCode = statusCode;
    }
}
function fail(code, statusCode) { throw new AssessmentDomainError(code, statusCode); }

// Trusted-service inputs only. Actor IDs and tenant selectors are not credentials.
function normaliseAssessmentCommand(input) {
    const row = object(input, [...SCOPE_FIELDS, 'action', 'payload', 'expectedRevision',
        'actorSubjectKey', 'now', 'idempotencyKey']);
    if (!['create', 'start', 'save', 'submit', 'review', 'archive'].includes(row.action)) fail('action_invalid');
    let payload;
    if (row.action === 'create') {
        const source = object(row.payload, ['moduleId', 'profileRef', 'scopePopulationSha256']);
        if (row.expectedRevision !== null) fail('revision_invalid');
        payload = { moduleId: identifier(source.moduleId), profileRef: profileReference(source.profileRef),
            scopePopulationSha256: sha256(source.scopePopulationSha256) };
    } else {
        revision(row.expectedRevision);
        if (row.action === 'save') {
            const source = object(row.payload, ['responses']);
            const responses = list(source.responses).map(item => {
                const response = object(item, ['itemId', 'optionId', 'applicabilityRationaleSha256']);
                return { itemId: identifier(response.itemId),
                    optionId: response.optionId === null ? null : identifier(response.optionId),
                    applicabilityRationaleSha256: response.applicabilityRationaleSha256 === null
                        ? null : sha256(response.applicabilityRationaleSha256) };
            });
            if (!responses.length) fail('responses_required');
            uniqueResponses(responses);
            payload = { responses: responses.sort(compareItems) };
        } else payload = object(row.payload, []);
    }
    return freeze({ ...scopeOf(row), action: row.action, payload,
        expectedRevision: row.expectedRevision, actorSubjectKey: subject(row.actorSubjectKey),
        now: instant(row.now), idempotencyKey: identifier(row.idempotencyKey) });
}

function createAssessment(tenantAggregate, commandInput, registry) {
    const command = normaliseAssessmentCommand(commandInput);
    if (command.action !== 'create') fail('action_invalid');
    assertAssessmentOrganisation(tenantAggregate, command, true);
    const profile = resolveProfile(command.payload.profileRef, registry);
    if (profile.profile.effectiveFrom > command.now.slice(0, 10) || profile.publishedAt > command.now.slice(0, 10)) {
        fail('profile_not_yet_effective', 409);
    }
    return normaliseAssessmentState({ schemaVersion: SCHEMA_VERSION, ...scopeOf(command),
        ...command.payload, status: 'created', revision: 0,
        createdAt: command.now, createdBy: command.actorSubjectKey,
        updatedAt: command.now, updatedBy: command.actorSubjectKey,
        responses: [], submission: null, review: null, archive: null }, registry);
}

function normaliseAssessmentState(input, registry) {
    const row = object(input, ['schemaVersion', ...SCOPE_FIELDS, 'moduleId', 'profileRef',
        'scopePopulationSha256', 'status', 'revision', 'createdAt', 'createdBy',
        'updatedAt', 'updatedBy', 'responses', 'submission', 'review', 'archive']);
    if (row.schemaVersion !== SCHEMA_VERSION) fail('schema_unsupported');
    if (!STATUSES.includes(row.status)) fail('status_invalid');
    const profileRef = profileReference(row.profileRef), profile = resolveProfile(profileRef, registry);
    const state = { schemaVersion: SCHEMA_VERSION, ...scopeOf(row), moduleId: identifier(row.moduleId),
        profileRef, scopePopulationSha256: sha256(row.scopePopulationSha256), status: row.status,
        revision: revision(row.revision), createdAt: instant(row.createdAt), createdBy: subject(row.createdBy),
        updatedAt: instant(row.updatedAt), updatedBy: subject(row.updatedBy) };
    if (state.updatedAt < state.createdAt || profile.profile.effectiveFrom > state.createdAt.slice(0, 10) ||
        profile.publishedAt > state.createdAt.slice(0, 10)) fail('time_invalid');
    state.responses = list(row.responses).map(item => {
        const response = object(item, ['itemId', 'optionId', 'applicabilityRationaleSha256',
            'profileRef', 'updatedAt', 'updatedBy', 'updatedRevision']);
        const retainedRef = profileReference(response.profileRef);
        if (canonicalJson(retainedRef) !== canonicalJson(profileRef)) fail('response_profile_mismatch', 409);
        const value = { itemId: identifier(response.itemId), optionId: identifier(response.optionId),
            applicabilityRationaleSha256: response.applicabilityRationaleSha256 === null
                ? null : sha256(response.applicabilityRationaleSha256),
            profileRef: retainedRef, updatedAt: instant(response.updatedAt),
            updatedBy: subject(response.updatedBy), updatedRevision: revision(response.updatedRevision) };
        validateResponse(value, profile);
        if (value.updatedRevision < 1 || value.updatedRevision > state.revision ||
            value.updatedAt < state.createdAt || value.updatedAt > state.updatedAt) fail('response_history_invalid');
        return value;
    }).sort(compareItems);
    uniqueResponses(state.responses);
    state.submission = row.submission === null ? null : normaliseStamp(row.submission, 'submitted', state, ['responseSetSha256']);
    state.review = row.review === null ? null : normaliseStamp(row.review, 'reviewed', state);
    state.archive = row.archive === null ? null : normaliseStamp(row.archive, 'archived', state, ['previousStatus']);
    validateLifecycle(state, profile);
    return freeze(state);
}

function applyAssessmentCommand(stateInput, tenantAggregate, commandInput, registry) {
    const command = normaliseAssessmentCommand(commandInput);
    const state = normaliseAssessmentState(stateInput, registry);
    assertScope(state, command);
    assertAssessmentOrganisation(tenantAggregate, command, command.action !== 'archive');
    if (command.expectedRevision !== state.revision) fail('revision_conflict', 409);
    if (!Number.isSafeInteger(state.revision + 1)) fail('revision_exhausted', 409);
    if (command.now < state.updatedAt) fail('time_regression', 409);
    const next = { ...state, revision: state.revision + 1,
        updatedAt: command.now, updatedBy: command.actorSubjectKey };
    const stamp = verb => ({ revision: next.revision,
        [`${verb}At`]: command.now, [`${verb}By`]: command.actorSubjectKey });
    if (command.action === 'start') {
        if (state.status !== 'created') fail('transition_not_allowed', 409);
        next.status = 'in-progress';
    } else if (command.action === 'save') {
        if (!['created', 'in-progress'].includes(state.status)) fail('responses_sealed', 409);
        const profile = resolveProfile(state.profileRef, registry);
        const responses = new Map(state.responses.map(response => [response.itemId, response]));
        for (const response of command.payload.responses) {
            validateResponse(response, profile);
            if (response.optionId === null) responses.delete(response.itemId);
            else responses.set(response.itemId, { ...response, profileRef: state.profileRef,
                updatedAt: command.now, updatedBy: command.actorSubjectKey, updatedRevision: next.revision });
        }
        next.responses = [...responses.values()].sort(compareItems);
        next.status = 'in-progress';
    } else if (command.action === 'submit') {
        if (state.status !== 'in-progress') fail('transition_not_allowed', 409);
        const profile = resolveProfile(state.profileRef, registry);
        if (state.responses.length !== profile.questions.length) fail('responses_incomplete', 409);
        next.status = 'submitted';
        next.submission = { ...stamp('submitted'), responseSetSha256: responseDigest(state) };
    } else if (command.action === 'review') {
        if (state.status !== 'submitted') fail('transition_not_allowed', 409);
        next.status = 'reviewed';
        next.review = stamp('reviewed');
    } else if (command.action === 'archive') {
        if (state.status === 'archived') fail('transition_not_allowed', 409);
        next.status = 'archived';
        next.archive = { ...stamp('archived'), previousStatus: state.status };
    } else fail('transition_not_allowed', 409);
    return normaliseAssessmentState(next, registry);
}

function getAssessmentProgress(stateInput, registry) {
    const state = normaliseAssessmentState(stateInput, registry), profile = resolveProfile(state.profileRef, registry);
    const options = new Map(profile.responseOptions.map(option => [option.id, option]));
    return freeze({ total: profile.questions.length, answered: state.responses.length,
        missing: profile.questions.length - state.responses.length,
        unknown: state.responses.filter(row => options.get(row.optionId).applicable &&
            options.get(row.optionId).implementationFactor === null).length,
        notApplicableClaims: state.responses.filter(row => !options.get(row.optionId).applicable).length });
}

function normaliseAssessmentSelector(input) { return freeze(scopeOf(object(input, SCOPE_FIELDS))); }

function assertAssessmentOrganisation(tenantAggregate, selector, requireActive = false) {
    const aggregate = tenantAggregate;
    const scope = scopeOf(selector);
    let organisation;
    try { organisation = resolveOrganisation(aggregate, { tenantId: scope.tenantId, organisationId: scope.organisationId }); }
    catch (error) {
        if (error.statusCode === 404) fail('not_found', 404);
        throw error;
    }
    if (requireActive && (aggregate.tenant.recordStatus !== 'active' || organisation.recordStatus !== 'active')) {
        fail('organisation_inactive', 409);
    }
}

function validateLifecycle(state, profile) {
    const effectiveStatus = state.archive ? state.archive.previousStatus : state.status;
    if ((state.status === 'archived') !== Boolean(state.archive) ||
        !STATUSES.includes(effectiveStatus) || effectiveStatus === 'archived') fail('history_invalid');
    const needsSubmission = ['submitted', 'reviewed'].includes(effectiveStatus);
    if (needsSubmission !== Boolean(state.submission) || (effectiveStatus === 'reviewed') !== Boolean(state.review)) {
        fail('history_invalid');
    }
    if (effectiveStatus === 'created' && (state.responses.length ||
        (state.archive ? state.revision !== 1 : state.revision !== 0))) fail('history_invalid');
    if (effectiveStatus !== 'created' && state.revision < 1) fail('history_invalid');
    if (!state.archive && effectiveStatus === 'created' &&
        (state.createdAt !== state.updatedAt || state.createdBy !== state.updatedBy)) fail('history_invalid');
    if (state.submission) {
        if (state.responses.length !== profile.questions.length ||
            state.submission.responseSetSha256 !== responseDigest(state) ||
            state.responses.some(row => row.updatedRevision >= state.submission.revision ||
                row.updatedAt > state.submission.submittedAt)) fail('submission_mismatch', 409);
    }
    if (state.review && (state.review.revision !== state.submission.revision + 1 ||
        state.review.reviewedAt < state.submission.submittedAt)) fail('history_invalid');
    if (state.archive) {
        // Entering in-progress and then archiving require separate mutations,
        // including when no response was saved. Archive never edits responses.
        if ((state.archive.previousStatus === 'in-progress' && state.archive.revision < 2) ||
            state.responses.some(row => row.updatedRevision >= state.archive.revision)) fail('history_invalid');
        const prior = state.review || state.submission;
        if (prior && (state.archive.revision !== prior.revision + 1 ||
            state.archive.archivedAt < (state.review ? state.review.reviewedAt : state.submission.submittedAt))) fail('history_invalid');
    }
    const latest = state.archive || state.review || state.submission;
    const verb = state.archive ? 'archived' : state.review ? 'reviewed' : 'submitted';
    if (latest && (latest.revision !== state.revision || latest[`${verb}At`] !== state.updatedAt ||
        latest[`${verb}By`] !== state.updatedBy)) fail('history_invalid');
}

function normaliseStamp(input, verb, state, extras = []) {
    const row = object(input, ['revision', `${verb}At`, `${verb}By`, ...extras]);
    const stamp = { revision: revision(row.revision), [`${verb}At`]: instant(row[`${verb}At`]),
        [`${verb}By`]: subject(row[`${verb}By`]) };
    if (stamp.revision < 1 || stamp.revision > state.revision || stamp[`${verb}At`] < state.createdAt ||
        stamp[`${verb}At`] > state.updatedAt) fail('history_invalid');
    if (extras.includes('responseSetSha256')) stamp.responseSetSha256 = sha256(row.responseSetSha256);
    if (extras.includes('previousStatus')) {
        if (!STATUSES.includes(row.previousStatus) || row.previousStatus === 'archived') fail('history_invalid');
        stamp.previousStatus = row.previousStatus;
    }
    return stamp;
}

function validateResponse(response, profile) {
    const question = profile.questions.find(item => item.id === response.itemId);
    if (!question) fail('question_unknown');
    if (response.optionId === null) {
        if (response.applicabilityRationaleSha256 !== null) fail('rationale_invalid');
        return;
    }
    if (!question.responseOptionIds.includes(response.optionId)) fail('response_option_invalid');
    const option = profile.responseOptions.find(item => item.id === response.optionId);
    if (option.applicable && response.applicabilityRationaleSha256 !== null) fail('rationale_invalid');
    if (!option.applicable && response.applicabilityRationaleSha256 === null) fail('not_applicable_rationale_required');
}

function resolveProfile(reference, registry) {
    if (!registry || typeof registry.getProfile !== 'function') fail('registry_required');
    let profile;
    try { profile = publishFrameworkProfile(registry.getProfile(reference.profileId, reference.profileVersion)); }
    catch { fail('profile_unavailable', 409); }
    const resolved = { frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
        profileId: profile.profile.id, profileVersion: profile.profile.version, catalogueSha256: profile.catalogueSha256,
        ...(profile.sourceCatalogueSha256 ? { sourceCatalogueSha256: profile.sourceCatalogueSha256 } : {}) };
    if (canonicalJson(reference) !== canonicalJson(resolved)) fail('profile_mismatch', 409);
    return profile;
}

function profileReference(input) {
    const row = object(input, PROFILE_FIELDS, ['sourceCatalogueSha256']);
    return { frameworkId: identifier(row.frameworkId), frameworkVersion: version(row.frameworkVersion),
        profileId: identifier(row.profileId), profileVersion: version(row.profileVersion),
        catalogueSha256: sha256(row.catalogueSha256),
        ...(Object.hasOwn(row, 'sourceCatalogueSha256') ? { sourceCatalogueSha256: sha256(row.sourceCatalogueSha256) } : {}) };
}
function responseDigest(state) {
    return digest('nofries:assessment-responses:v1', { ...scopeOf(state), moduleId: state.moduleId,
        profileRef: state.profileRef, scopePopulationSha256: state.scopePopulationSha256, responses: state.responses });
}
function assessmentCommandFingerprint(commandInput) {
    const { now, idempotencyKey, ...intent } = normaliseAssessmentCommand(commandInput);
    return digest('nofries:assessment-command:v1', intent);
}
function digest(namespace, value) { return crypto.createHash('sha256').update(`${namespace}\n${canonicalJson(value)}`).digest('hex'); }
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function scopeOf(row) { return Object.fromEntries(SCOPE_FIELDS.map(key => [key, identifier(row[key])])); }
function assertScope(state, selector) {
    if (SCOPE_FIELDS.some(key => state[key] !== selector[key])) fail('not_found', 404);
}
function uniqueResponses(responses) {
    if (new Set(responses.map(row => row.itemId)).size !== responses.length) fail('response_duplicate');
}
function compareItems(a, b) { return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0; }
function object(value, required, optional = []) {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    const allowed = [...required, ...optional];
    if (keys.some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) ||
        required.some(key => !Object.hasOwn(descriptors, key))) fail('shape_invalid');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function list(value) {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_RESPONSES || Reflect.ownKeys(value).length !== value.length + 1) fail('collection_invalid');
    const output = [];
    for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('collection_invalid');
        output.push(descriptor.value);
    }
    return output;
}
function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail('identifier_invalid');
    return value;
}
function version(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(value) || value.toLowerCase() === 'latest') fail('version_invalid');
    return value;
}
function sha256(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('digest_invalid');
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || !SUBJECT.test(value)) fail('subject_invalid');
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail('revision_invalid');
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('time_invalid');
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

module.exports = { SCHEMA_VERSION, STATUSES, AssessmentDomainError, normaliseAssessmentCommand,
    normaliseAssessmentSelector, assertAssessmentOrganisation, createAssessment, normaliseAssessmentState,
    applyAssessmentCommand, getAssessmentProgress, assessmentCommandFingerprint };
