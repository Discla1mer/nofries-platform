'use strict';

const { types } = require('node:util');
const { requireTenantRequestContext } = require('./appLifecycle/tenantRequestContext');
const { getAssessmentProgress } = require('./assessmentLifecycle/assessmentDomain');
const { serialiseAssessmentEvaluation } = require('./assessmentEngine/assessmentEvaluator');
const { acceptedRegistry, acceptedProfile } = require('./assessmentLifecycle/ncscAssessmentSubmission');

const MAX_INPUT_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

class NcscAssessmentError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.name = 'NcscAssessmentError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
function fail(code = 'ncsc_input_invalid', statusCode = 400) {
    throw new NcscAssessmentError(code, statusCode);
}

// Detach before any awaited request-context or database adapter. Inspect data
// descriptors without invoking accessors, Proxy traps, toJSON or iterators.
function detachInput(value) {
    let bytes = 0, nodes = 0;
    const active = new Set();
    function count(amount) {
        bytes += amount;
        if (bytes > MAX_INPUT_BYTES) fail('ncsc_request_too_large', 413);
    }
    function string(value) {
        if (value.length > MAX_INPUT_BYTES) fail('ncsc_request_too_large', 413);
        count(Buffer.byteLength(JSON.stringify(value), 'utf8'));
        return value;
    }
    function visit(value, depth) {
        if (++nodes > 4096 || depth > 16) fail();
        if (value === null) { count(4); return null; }
        if (typeof value === 'string') return string(value);
        if (typeof value === 'boolean') { count(value ? 4 : 5); return value; }
        if (typeof value === 'number') {
            if (!Number.isFinite(value) || Object.is(value, -0)) fail();
            count(String(value).length);
            return value;
        }
        if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) fail();
        const array = Array.isArray(value);
        if (array ? Object.getPrototypeOf(value) !== Array.prototype
            : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
        const keys = Reflect.ownKeys(value);
        if (keys.length > 4096) fail();
        active.add(value);
        let result;
        if (array) {
            const length = Object.getOwnPropertyDescriptor(value, 'length').value;
            if (length > 4096 || keys.length !== length + 1) fail();
            count(2 + Math.max(0, length - 1));
            result = [];
            for (let i = 0; i < length; i += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
                result.push(visit(descriptor.value, depth + 1));
            }
        } else {
            count(2 + Math.max(0, keys.length - 1));
            result = Object.create(null);
            for (const key of keys) {
                if (typeof key !== 'string') fail();
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
                string(key); count(1);
                result[key] = visit(descriptor.value, depth + 1);
            }
        }
        active.delete(value);
        return result;
    }
    return visit(value, 0);
}
function record(value, required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const keys = Object.keys(value);
    if (keys.length !== required.length || keys.some(key => !required.includes(key))) fail();
    return value;
}
function identifier(value) {
    if (typeof value !== 'string' || !ID.test(value)) fail();
    return value;
}
function text(value) {
    if (typeof value !== 'string' || value.length > 4000 || !value.trim()) fail();
    // PostgreSQL JSONB cannot retain NUL or an unpaired UTF-16 surrogate.
    // Inspect code units without normalizing text or changing its length bound.
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) fail();
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const trailing = value.charCodeAt(++index);
            if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) fail();
        }
    }
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail();
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function normaliseNcscCommand(input) {
    const row = record(detachInput(input), ['assessmentId', 'action', 'idempotencyKey', 'expectedRevision', 'payload']);
    const assessmentId = identifier(row.assessmentId), idempotencyKey = identifier(row.idempotencyKey);
    let payload;
    if (row.action === 'create') {
        if (row.expectedRevision !== null) fail();
        const source = record(row.payload, ['scopePopulation']);
        const population = record(source.scopePopulation, ['description']);
        payload = { scopePopulation: { description: text(population.description) } };
    } else if (row.action === 'save') {
        revision(row.expectedRevision);
        const source = record(row.payload, ['responses']);
        if (!Array.isArray(source.responses) || !source.responses.length ||
            source.responses.length > acceptedProfile.questions.length) fail();
        const responses = source.responses.map(value => {
            const answer = record(value, ['itemId', 'optionId', 'rationale']);
            const itemId = identifier(answer.itemId);
            const question = acceptedProfile.questions.find(item => item.id === itemId);
            if (!question) fail();
            const optionId = answer.optionId === null ? null : identifier(answer.optionId);
            let rationale = null;
            if (optionId !== null) {
                if (!question.responseOptionIds.includes(optionId)) fail();
                const option = acceptedProfile.responseOptions.find(item => item.id === optionId);
                if (!option.applicable) rationale = { text: text(record(answer.rationale, ['text']).text) };
                else if (answer.rationale !== null) fail();
            } else if (answer.rationale !== null) fail();
            return { itemId, optionId, rationale };
        });
        if (new Set(responses.map(item => item.itemId)).size !== responses.length) fail();
        responses.sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
        payload = { responses };
    } else if (row.action === 'submit') {
        revision(row.expectedRevision);
        record(row.payload, []);
        payload = {};
    } else fail();
    return freeze({ assessmentId, action: row.action, idempotencyKey, expectedRevision: row.expectedRevision, payload });
}

function normaliseNcscPage(input) {
    const row = record(detachInput(input), ['limit', 'afterAssessmentId']);
    if (!Number.isSafeInteger(row.limit) || row.limit < 1 || row.limit > 100) fail();
    return freeze({ limit: row.limit, afterAssessmentId: row.afterAssessmentId === null
        ? null : identifier(row.afterAssessmentId) });
}
function normaliseNcscSelector(input) {
    const row = record(detachInput(input), ['assessmentId']);
    return freeze({ assessmentId: identifier(row.assessmentId) });
}
function requireNcscContext(input) {
    let context;
    try { context = requireTenantRequestContext(input); }
    catch { fail('ncsc_access_denied', 403); }
    if (!ID.test(context.scope.tenantId) || !ID.test(context.scope.organisationId)) {
        fail('ncsc_selected_scope_unsupported', 400);
    }
    return context;
}

// The durable adapter validates ownership, record hashes and submitted evaluator
// output before projection. These named public fields never include raw state.
function projectNcscSummary({ envelope, revisionSha256 }) {
    const state = envelope.state;
    return freeze({ assessmentId: state.assessmentId, moduleId: state.moduleId,
        profileRef: { frameworkId: state.profileRef.frameworkId, frameworkVersion: state.profileRef.frameworkVersion,
            profileId: state.profileRef.profileId, profileVersion: state.profileRef.profileVersion,
            catalogueSha256: state.profileRef.catalogueSha256, sourceCatalogueSha256: state.profileRef.sourceCatalogueSha256 },
        status: state.status, revision: state.revision, revisionSha256,
        createdAt: state.createdAt, updatedAt: state.updatedAt,
        progress: getAssessmentProgress(state, acceptedRegistry) });
}
function projectNcscDetail({ envelope, revisionSha256 }) {
    const summary = projectNcscSummary({ envelope, revisionSha256 }), state = envelope.state;
    const rationales = new Map(envelope.rationales.map(item => [item.itemId, item]));
    return freeze({ assessmentId: summary.assessmentId, moduleId: summary.moduleId, profileRef: summary.profileRef,
        status: summary.status, revision: summary.revision, revisionSha256: summary.revisionSha256,
        createdAt: summary.createdAt, updatedAt: summary.updatedAt, progress: summary.progress,
        scopePopulation: { description: envelope.scopePopulation.body.description },
        responses: state.responses.map(item => ({ itemId: item.itemId, optionId: item.optionId,
            rationale: item.applicabilityRationaleSha256 === null ? null
                : { text: rationales.get(item.itemId).body.text } })),
        submission: state.submission === null ? null : {
            revision: state.submission.revision, submittedAt: state.submission.submittedAt,
            responseSetSha256: state.submission.responseSetSha256,
            evaluation: JSON.parse(serialiseAssessmentEvaluation(envelope.submission.evaluation))
        } });
}

function createNcscAssessmentService(adapters) {
    if (!adapters || typeof adapters !== 'object' || types.isProxy(adapters) || Array.isArray(adapters) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(adapters))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(adapters), keys = Reflect.ownKeys(adapters);
    if (keys.length !== 2 || keys.some(key => !['repository', 'requestContext'].includes(key) ||
        !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
    const repository = descriptors.repository.value, requestContext = descriptors.requestContext.value;
    if (!repository || !requestContext || typeof requestContext.resolve !== 'function' ||
        ['listNcscAssessments', 'readNcscAssessment', 'executeNcscAssessment']
            .some(key => typeof repository[key] !== 'function')) fail();
    const resolve = requestContext.resolve.bind(requestContext);
    const list = repository.listNcscAssessments.bind(repository), read = repository.readNcscAssessment.bind(repository),
        execute = repository.executeNcscAssessment.bind(repository);
    async function context(request) { return requireNcscContext(await resolve(request)); }
    return Object.freeze({
        async list(request, input) {
            const page = normaliseNcscPage(input);
            return list(await context(request), page);
        },
        async read(request, input) {
            const selector = normaliseNcscSelector(input);
            return read(await context(request), selector);
        },
        async execute(request, input) {
            const command = normaliseNcscCommand(input);
            return execute(await context(request), command);
        }
    });
}

module.exports = { NcscAssessmentError, normaliseNcscCommand, normaliseNcscPage,
    normaliseNcscSelector, requireNcscContext, projectNcscSummary, projectNcscDetail, createNcscAssessmentService };
