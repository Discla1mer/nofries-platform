'use strict';

const { types } = require('node:util');
const { apiSecurityHeaders } = require('./securityHeaders');
const { TenantRequestContextError } = require('./appLifecycle/tenantRequestContext');
const { NcscAssessmentError, normaliseNcscCommand, normaliseNcscPage,
    normaliseNcscSelector } = require('./ncscAssessmentService');

const PUBLIC_ERRORS = Object.freeze({
    ncsc_input_invalid: 400, ncsc_selected_scope_unsupported: 400, ncsc_access_denied: 403,
    ncsc_not_found: 404, ncsc_method_not_allowed: 405, ncsc_request_too_large: 413,
    ncsc_revision_conflict: 409, ncsc_idempotency_conflict: 409, ncsc_state_conflict: 409,
    ncsc_quota_exceeded: 409, ncsc_submission_unavailable: 409, ncsc_unavailable: 503, ncsc_outcome_ambiguous: 503
});
function invalid() { throw new NcscAssessmentError('ncsc_input_invalid', 400); }
function record(value, required, optional = []) {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
    if (keys.length > allowed.length) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') ||
        !descriptors[key].enumerable) || required.some(key => !Object.hasOwn(descriptors, key))) invalid();
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function requestField(request, key) {
    if (!request || typeof request !== 'object' || types.isProxy(request)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) invalid();
    return descriptor.value;
}
function response(status, body, headers = {}) {
    return { status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }),
        body, isRaw: false };
}
function errorResponse(error) {
    if (error instanceof TenantRequestContextError) return response(403, { code: 'ncsc_access_denied' });
    const code = error instanceof NcscAssessmentError && Object.hasOwn(PUBLIC_ERRORS, error.code)
        ? error.code : 'ncsc_unavailable';
    return response(PUBLIC_ERRORS[code], { code });
}
function routeSelection(relativeRoute) {
    if (relativeRoute === '') return { kind: 'collection', allow: 'GET, POST' };
    if (typeof relativeRoute !== 'string' || relativeRoute.length > 127) return null;
    const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,119})(?:\/(save|submit))?$/.exec(relativeRoute);
    if (!match) return null;
    return { assessmentId: match[1], kind: match[2] || 'item', allow: match[2] ? 'POST' : 'GET' };
}
function page(query) {
    const values = record(query, [], ['limit', 'afterAssessmentId']);
    let limit = 50;
    if (Object.hasOwn(values, 'limit')) {
        if (typeof values.limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(values.limit)) invalid();
        limit = Number(values.limit);
    }
    return normaliseNcscPage({ limit,
        afterAssessmentId: Object.hasOwn(values, 'afterAssessmentId') ? values.afterAssessmentId : null });
}
function mutationCommand(request, selected) {
    const suppliedQuery = requestField(request, 'query');
    record(suppliedQuery === undefined ? {} : suppliedQuery, []);
    const create = selected.kind === 'collection';
    const envelope = record(requestField(request, 'body'), create
        ? ['assessmentId', 'idempotencyKey', 'expectedRevision', 'payload']
        : ['idempotencyKey', 'expectedRevision', 'payload']);
    return normaliseNcscCommand({ assessmentId: create ? envelope.assessmentId : selected.assessmentId,
        action: create ? 'create' : selected.kind, idempotencyKey: envelope.idempotencyKey,
        expectedRevision: envelope.expectedRevision, payload: envelope.payload });
}

/** Dormant source adapter. The separately composed host supplies both branded
 * request context and its complete browser mutation/CSRF policy. No route,
 * environment, session or permissive mutation policy is installed here.
 */
function createNcscAssessmentHandlers(adapters) {
    const { service, guardMutation } = record(adapters, ['service', 'guardMutation']);
    if (!service || typeof guardMutation !== 'function' ||
        ['list', 'read', 'execute'].some(key => typeof service[key] !== 'function')) invalid();
    const list = service.list.bind(service), read = service.read.bind(service), execute = service.execute.bind(service);
    return Object.freeze({
        async handleRequest(request, relativeRoute) {
            const selected = routeSelection(relativeRoute);
            if (!selected) return response(404, { code: 'ncsc_not_found' });
            try {
                const method = requestField(request, 'method');
                if (!selected.allow.split(', ').includes(method)) {
                    return response(405, { code: 'ncsc_method_not_allowed' }, { Allow: selected.allow });
                }
                if (method === 'POST') {
                    // Retain initial intent before the trusted guard can await or
                    // mutate its host request. Denial still takes precedence over
                    // a captured input failure, and no service runs before approval.
                    let command, parseError;
                    try { command = mutationCommand(request, selected); } catch (error) { parseError = error; }
                    let allowed = false;
                    try { allowed = await guardMutation(request); } catch { /* Fail closed without exposing the guard. */ }
                    if (allowed !== true) return response(403, { code: 'ncsc_access_denied' });
                    if (parseError) throw parseError;
                    return response(selected.kind === 'collection' ? 201 : 200, await execute(request, command));
                }
                const suppliedQuery = requestField(request, 'query');
                const query = suppliedQuery === undefined ? {} : suppliedQuery;
                const body = requestField(request, 'body');
                if (body !== undefined) invalid();
                if (selected.kind === 'collection') return response(200, await list(request, page(query)));
                record(query, []);
                return response(200, await read(request, normaliseNcscSelector({ assessmentId: selected.assessmentId })));
            } catch (error) { return errorResponse(error); }
        }
    });
}

module.exports = { createNcscAssessmentHandlers };
