'use strict';

// Dormant request boundary. No route, runtime composition or feature is installed.
const { requireTenantRequestContext } = require('../appLifecycle/tenantRequestContext');
const { copy, fields, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseEvidenceSelector } = require('../evidenceLifecycle/evidenceDomain');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class ImprovementPlanServiceError extends Error {
    constructor(code = 'improvement_unavailable', statusCode = 503) {
        super(code); this.name = 'ImprovementPlanServiceError';
        this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
function fail(code = 'improvement_input_invalid', status = 400) { throw new ImprovementPlanServiceError(code, status); }
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail(); return value; }
function revision(value, maximum) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum || Object.is(value, -0)) fail();
    return value;
}
function note(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail();
    return value;
}
function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
    const at = value + 'T00:00:00.000Z';
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) fail();
    return value;
}
function normaliseImprovementCommand(input) {
    try {
        // Existing codec rejects accessors, proxies, cycles, invalid Unicode and
        // unpersistable JSON. Capture all caller data before the first await.
        const row = fields(copy(input, 16384), ['planId', 'type', 'operationId', 'expectedRevision', 'actionId', 'payload']);
        identifier(row.planId); identifier(row.operationId);
        if (row.type === 'generate') {
            if (row.expectedRevision !== null || row.actionId !== null) fail();
            const source = fields(row.payload, ['assessmentId', 'assessmentRevision', 'assessmentRevisionSha256']);
            identifier(source.assessmentId); revision(source.assessmentRevision, 128);
            if (typeof source.assessmentRevisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.assessmentRevisionSha256)) fail();
        } else {
            identifier(row.actionId); revision(row.expectedRevision, 1023);
            if (row.type === 'assign') {
                const payload = fields(row.payload, ['ownerSubjectKey', 'dueDate']);
                if (typeof payload.ownerSubjectKey !== 'string' || !SUBJECT.test(payload.ownerSubjectKey)) fail();
                date(payload.dueDate);
            } else if (row.type === 'start') fields(row.payload, []);
            else if (row.type === 'block' || row.type === 'reopen') note(fields(row.payload, ['reason']).reason);
            else if (row.type === 'complete') {
                const payload = fields(row.payload, ['note', 'evidenceReference']); note(payload.note);
                normaliseEvidenceSelector({ tenantId: 'selector', organisationId: 'selector', artefactId: payload.evidenceReference });
                if (/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|vbscript):|[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(payload.evidenceReference)) fail();
            } else fail();
        }
        return freeze(row);
    } catch { fail(); }
}
function normaliseImprovementSelector(input) {
    try { return freeze({ planId: identifier(fields(copy(input, 1024), ['planId']).planId) }); }
    catch { fail(); }
}
function requireImprovementContext(input) {
    try {
        const context = requireTenantRequestContext(input);
        identifier(context.scope.tenantId); identifier(context.scope.organisationId);
        return context;
    } catch { fail('improvement_access_denied', 403); }
}
function serviceError(error) {
    return error instanceof ImprovementPlanServiceError ? error : new ImprovementPlanServiceError();
}
function createImprovementPlanService(adapters) {
    let resolve, read, execute;
    try {
        const settings = fields(adapters, ['repository', 'requestContext']);
        if (typeof settings.repository?.readImprovementPlan !== 'function' ||
            typeof settings.repository?.executeImprovementPlan !== 'function' ||
            typeof settings.requestContext?.resolve !== 'function') fail();
        resolve = settings.requestContext.resolve.bind(settings.requestContext);
        read = settings.repository.readImprovementPlan.bind(settings.repository);
        execute = settings.repository.executeImprovementPlan.bind(settings.repository);
    } catch { fail(); }
    return Object.freeze({
        async read(request, input) {
            const selector = normaliseImprovementSelector(input);
            try { return await read(requireImprovementContext(await resolve(request)), selector); }
            catch (error) { throw serviceError(error); }
        },
        async execute(request, input) {
            const command = normaliseImprovementCommand(input);
            try { return await execute(requireImprovementContext(await resolve(request)), command); }
            catch (error) { throw serviceError(error); }
        }
    });
}
module.exports = Object.freeze({ ImprovementPlanServiceError, normaliseImprovementCommand,
    normaliseImprovementSelector, requireImprovementContext, createImprovementPlanService, serviceError });
