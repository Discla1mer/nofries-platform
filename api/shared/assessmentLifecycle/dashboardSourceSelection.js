'use strict';

// Unwired, read-only selection over already-authorised retained sources.
// This is not an authority check, a new score, or a current-state inference.
const { validateNcscSupportingRecords, hashNcscRecord } = require('./ncscAssessmentSubmission');
const { getAssessmentProgress } = require('./assessmentDomain');
const { acceptedRegistry } = require('./ncscAssessmentSubmission');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail() { throw new Error('dashboard_source_selection_invalid'); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function reference(value) {
    if (value === null) return;
    exact(value, ['assessmentId', 'revision', 'revisionSha256', 'scopePopulationSha256']);
    if (typeof value.assessmentId !== 'string' || !ID.test(value.assessmentId) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > 128 ||
        typeof value.revisionSha256 !== 'string' || !HASH.test(value.revisionSha256) ||
        typeof value.scopePopulationSha256 !== 'string' || !HASH.test(value.scopePopulationSha256)) fail();
}
function selectDashboardSources(input) {
    exact(input, ['tenantId', 'organisationId', 'baseline', 'draft', 'complete', 'versions']);
    for (const key of ['tenantId', 'organisationId']) {
        if (typeof input[key] !== 'string' || !ID.test(input[key])) fail();
    }
    reference(input.baseline); reference(input.draft);
    if (typeof input.complete !== 'boolean' || !Array.isArray(input.versions) || input.versions.length > 100) fail();
    const versions = new Map(), scopes = new Map();
    for (const source of input.versions) {
        exact(source, ['envelope', 'revisionSha256']);
        let envelope;
        try { envelope = validateNcscSupportingRecords(source.envelope); } catch { fail(); }
        if (envelope.tenantId !== input.tenantId || envelope.organisationId !== input.organisationId ||
            typeof source.revisionSha256 !== 'string' || !HASH.test(source.revisionSha256) ||
            hashNcscRecord('version', envelope) !== source.revisionSha256 ||
            (envelope.state.status === 'submitted') !== (envelope.submission !== null)) fail();
        const scopeHash = envelope.state.scopePopulationSha256;
        if (scopes.has(envelope.assessmentId) && scopes.get(envelope.assessmentId) !== scopeHash) fail();
        scopes.set(envelope.assessmentId, scopeHash);
        const key = `${envelope.assessmentId}:${envelope.revision}`;
        if (versions.has(key) && versions.get(key).revisionSha256 !== source.revisionSha256) fail();
        versions.set(key, { envelope, revisionSha256: source.revisionSha256 });
    }
    function select(ref, baseline) {
        if (ref === null) return { status: 'unselected', source: null };
        const version = versions.get(`${ref.assessmentId}:${ref.revision}`);
        if (!version) return { status: input.complete ? 'not_found' : 'not_loaded', source: null };
        const { envelope, revisionSha256 } = version, state = envelope.state;
        if (revisionSha256 !== ref.revisionSha256 || state.scopePopulationSha256 !== ref.scopePopulationSha256) fail();
        if (baseline ? state.status !== 'submitted' : !['created', 'in-progress'].includes(state.status)) fail();
        return { status: 'selected', source: {
            assessmentId: envelope.assessmentId, revision: envelope.revision, revisionSha256,
            scopePopulationSha256: state.scopePopulationSha256,
            scopeDescription: envelope.scopePopulation.body.description,
            profileRef: { ...state.profileRef }, status: state.status, savedAt: state.updatedAt,
            progress: getAssessmentProgress(state, acceptedRegistry),
            submittedAt: baseline ? state.submission.submittedAt : null,
            evaluationSha256: baseline ? envelope.submission.evaluation.outputSha256 : null
        } };
    }
    const baseline = select(input.baseline, true), draft = select(input.draft, false);
    return freeze({ coverage: input.complete ? 'complete' : 'partial', baseline, draft,
        scopeRelation: !baseline.source || !draft.source ? 'unavailable'
            : baseline.source.assessmentId === draft.source.assessmentId ? 'same_assessment' : 'not_established' });
}
module.exports = { selectDashboardSources };
