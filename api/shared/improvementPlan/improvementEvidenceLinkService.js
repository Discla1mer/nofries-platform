'use strict';

// Unmounted read-only reference resolution. This service never saves a link.
const { copy, fields, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseEvidenceSelector } = require('../evidenceLifecycle/evidenceDomain');
const { normaliseImprovementSelector, requireImprovementContext } = require('./improvementPlanService');

class ImprovementEvidenceLinkError extends Error {
    constructor(code = 'improvement_evidence_unavailable', statusCode = 503) {
        super(code); this.name = 'ImprovementEvidenceLinkError';
        this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
function fail(code = 'improvement_evidence_input_invalid', status = 400) {
    throw new ImprovementEvidenceLinkError(code, status);
}
function normaliseImprovementEvidenceSelector(input) {
    try {
        const value = fields(copy(input, 4096), ['planId', 'planRevision', 'actionId', 'artefactId', 'evidenceVersionId']);
        normaliseImprovementSelector({ planId: value.planId });
        if (!Number.isSafeInteger(value.planRevision) || value.planRevision < 0 || value.planRevision > 1024 ||
            Object.is(value.planRevision, -0) || typeof value.actionId !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value.actionId)) fail();
        for (const artefactId of [value.artefactId, value.evidenceVersionId]) {
            // Evidence artefact and version IDs share the existing opaque Unicode codec.
            normaliseEvidenceSelector({ tenantId: 'selector', organisationId: 'selector', artefactId });
        }
        return freeze(value);
    } catch { fail(); }
}
function requireImprovementEvidenceContext(input) {
    try { return requireImprovementContext(input); }
    catch { fail('improvement_evidence_access_denied', 403); }
}
function linkError(error) {
    if (error instanceof ImprovementEvidenceLinkError) return error;
    if (['improvement_access_denied', 'evidence_access_denied'].includes(error?.code)) {
        return new ImprovementEvidenceLinkError('improvement_evidence_access_denied', 403);
    }
    if (['improvement_not_found', 'evidence_not_found'].includes(error?.code)) {
        return new ImprovementEvidenceLinkError('improvement_evidence_not_found', 404);
    }
    return new ImprovementEvidenceLinkError();
}
function createImprovementEvidenceLinkService(adapters) {
    let resolveContext, resolveLink;
    try {
        const settings = fields(adapters, ['repository', 'requestContext']);
        if (typeof settings.repository?.resolveImprovementEvidenceLink !== 'function' ||
            typeof settings.requestContext?.resolve !== 'function') fail();
        resolveContext = settings.requestContext.resolve.bind(settings.requestContext);
        resolveLink = settings.repository.resolveImprovementEvidenceLink.bind(settings.repository);
    } catch { fail(); }
    return Object.freeze({
        async resolve(request, input) {
            const selector = normaliseImprovementEvidenceSelector(input);
            try {
                const context = requireImprovementEvidenceContext(await resolveContext(request));
                return await resolveLink(context, selector);
            } catch (error) { throw linkError(error); }
        }
    });
}
module.exports = Object.freeze({ ImprovementEvidenceLinkError, normaliseImprovementEvidenceSelector,
    requireImprovementEvidenceContext, createImprovementEvidenceLinkService, linkError });
