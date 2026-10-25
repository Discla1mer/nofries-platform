'use strict';

const { copy, fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { projectImprovementActionPlanPresentation } = require('./improvementActionPlanPresentation');

const SCOPE = Object.freeze(['tenantId', 'organisationId', 'planId']);
const SOURCE = Object.freeze(['assessmentId', 'assessmentRevision', 'scoreAsOf', 'evaluationOutputSha256']);
const MISSING_INPUTS = freeze([
    { input: 'priorityMethod', state: 'not_defined', reason: 'priority_adapter_required' },
    { input: 'statedImpact', state: 'not_exposed', reason: 'per_item_impact_not_retained' },
    { input: 'priorityOverlay', state: 'not_exposed', reason: 'per_item_overlay_not_retained' },
    { input: 'riskContextSnapshot', state: 'not_exposed', reason: 'risk_snapshot_not_exposed' },
    { input: 'evidenceSnapshot', state: 'not_exposed', reason: 'evidence_snapshot_not_exposed' },
    { input: 'frameworkProfile', state: 'not_exposed', reason: 'profile_version_not_exposed' }
]);

class ImprovementActionPriorityStateError extends Error {
    constructor(code = 'improvement_priority_unavailable', statusCode = 503) {
        super(code); this.name = 'ImprovementActionPriorityStateError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
const fail = (code, status) => { throw new ImprovementActionPriorityStateError(code, status); };
function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw new Error();
}
function selectionValue(input) {
    try {
        const selection = fields(copy(input, 4096), ['scope', 'planRevision', 'source']);
        fields(selection.scope, SCOPE); Object.values(selection.scope).forEach(identifier);
        if (!Number.isSafeInteger(selection.planRevision) || selection.planRevision < 0 || selection.planRevision > 1024) throw new Error();
        const source = fields(selection.source, SOURCE);
        identifier(source.assessmentId); instant(source.scoreAsOf);
        if (typeof source.assessmentRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(source.assessmentRevision) ||
            source.assessmentRevision.toLowerCase() === 'latest' || typeof source.evaluationOutputSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(source.evaluationOutputSha256)) throw new Error();
        return selection;
    } catch { fail('improvement_priority_input_invalid', 400); }
}

// Pure diagnostic for a trusted host, not an authorization or evidence boundary.
// A missing list field means unavailable basis, not absent real-world evidence.
// The expected selection checks consistency only; the caller still owns current
// request authority through disclosure. No ranking, lookup or state change occurs.
function projectImprovementActionPriorityState(listInput, selectionInput) {
    const selection = selectionValue(selectionInput);
    let list;
    try { list = projectImprovementActionPlanPresentation(listInput); }
    catch { fail(); }
    if (SCOPE.some(key => list.scope[key] !== selection.scope[key])) fail('improvement_priority_scope_mismatch', 404);
    if (list.planRevision !== selection.planRevision || SOURCE.some(key => list.source[key] !== selection.source[key])) {
        fail('improvement_priority_selection_conflict', 409);
    }
    return freeze({ schemaVersion: 1, scope: list.scope, planRevision: list.planRevision, source: list.source, asOf: list.asOf,
        priority: list.priority,
        scheduling: { order: list.order, dueDateBasis: list.dueDateBasis, riskRanking: false },
        missingInputs: copy(MISSING_INPUTS) });
}

module.exports = Object.freeze({ ImprovementActionPriorityStateError, projectImprovementActionPriorityState });
