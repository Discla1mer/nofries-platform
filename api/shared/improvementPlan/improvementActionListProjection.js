'use strict';

const { copy, fields, freeze, instant, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { getImprovementPlanView } = require('./improvementPlanDomain');
const STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'completed']);
const SCOPE = Object.freeze(['tenantId', 'organisationId', 'planId']);
class ImprovementActionListError extends Error {
    constructor(code = 'improvement_list_unavailable', statusCode = 503) {
        super(code); this.name = 'ImprovementActionListError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
const fail = (code, status) => { throw new ImprovementActionListError(code, status); };
function optionsValue(input) {
    try {
        const options = fields(copy(input, 4096), ['scope', 'asOf', 'filters']);
        fields(options.scope, SCOPE);
        if (SCOPE.some(key => typeof options.scope[key] !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(options.scope[key]))) throw new Error();
        instant(options.asOf);
        const filters = fields(options.filters, ['status', 'owner', 'overdueOnly']);
        if (!['all', ...STATUSES].includes(filters.status) || typeof filters.overdueOnly !== 'boolean') throw new Error();
        if (!['all', 'unassigned'].includes(filters.owner)) subject(filters.owner);
        return options;
    } catch { fail('improvement_list_input_invalid', 400); }
}
function eventDetails(command) {
    const payload = command.payload;
    if (command.type === 'assign') return { ownerSubjectKey: payload.ownerSubjectKey, dueDate: payload.dueDate };
    if (command.type === 'block' || command.type === 'reopen') return { reason: payload.reason };
    if (command.type === 'complete') return { note: payload.note, evidenceReference: payload.evidenceReference,
        evidenceVerification: 'not_verified', durableLinkStatus: 'not_established' };
    return {};
}
function counts(rows) {
    return { total: rows.length, unassigned: rows.filter(row => row.ownerSubjectKey === null).length,
        overdue: rows.filter(row => row.isOverdue).length,
        byStatus: Object.fromEntries(STATUSES.map(status => [status, rows.filter(row => row.status === status).length])) };
}

// Pure trusted-host projection, not an authorization boundary. The host must load
// authenticated, tenant-bound retained state and check current access through
// disclosure. Scope only checks consistency; retained owner IDs prove no current
// membership. Never pass untrusted state or expose this as a public endpoint.
function projectImprovementActionList(stateInput, optionsInput) {
    const options = optionsValue(optionsInput);
    let state, view;
    try { state = copy(stateInput, 2097152); view = getImprovementPlanView(state); }
    catch { fail(); }
    if (SCOPE.some(key => view[key] !== options.scope[key])) fail('improvement_list_scope_mismatch', 404);
    if (options.asOf < view.updatedAt) fail('improvement_list_time_conflict', 409);
    const day = options.asOf.slice(0, 10), history = new Map(view.actions.map(action => [action.actionId, []]));
    state.commands.forEach((command, index) => history.get(command.actionId).push({ revision: index + 1,
        at: command.at, type: command.type, details: eventDetails(command) }));
    const rows = view.actions.map(action => ({ actionId: action.actionId, itemId: action.itemId,
        controlId: action.controlId, domainId: action.domainId, status: action.status,
        ownerSubjectKey: action.ownerSubjectKey, ownerEligibility: 'not_checked', dueDate: action.dueDate,
        isOverdue: action.status !== 'completed' && action.dueDate !== null && action.dueDate < day,
        blockedReason: action.blockedReason,
        rationale: { kind: action.kind, response: action.response, responseOrigin: action.responseOrigin,
            suggestedAction: action.suggestedAction },
        completion: action.completion === null ? null : { at: action.completion.completedAt, note: action.completion.note },
        evidence: { assessmentState: action.evidenceState,
            completionReference: action.completion?.evidenceReference ?? null,
            completionVerification: action.completion === null ? 'not_recorded' : 'not_verified',
            durableLinkStatus: 'not_established', downloadAllowed: false, scoreEffect: 'none' },
        history: history.get(action.actionId) }));
    // Operational due-date order is not remediation priority or a risk score.
    rows.sort((a, b) => {
        const left = a.dueDate ?? '9999-99-99', right = b.dueDate ?? '9999-99-99';
        return left < right ? -1 : left > right ? 1 : a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0;
    });
    const filters = options.filters;
    const visible = rows.filter(row => (filters.status === 'all' || row.status === filters.status) &&
        (filters.owner === 'all' || (filters.owner === 'unassigned' ? row.ownerSubjectKey === null : row.ownerSubjectKey === filters.owner)) &&
        (!filters.overdueOnly || row.isOverdue));
    return freeze({ schemaVersion: 1, scope: options.scope, planRevision: view.revision,
        updatedAt: view.updatedAt, asOf: options.asOf, dueDateBasis: 'UTC_calendar_day',
        source: { assessmentId: view.source.provenance.assessmentId,
            assessmentRevision: view.source.provenance.assessmentRevision,
            scoreAsOf: view.source.provenance.scoreAsOf, evaluationOutputSha256: view.source.evaluationOutputSha256 },
        priority: { status: 'not_calculated', reason: 'priority_adapter_required' },
        order: 'due_date_then_action_id', filters, counts: { all: counts(rows), visible: counts(visible) }, actions: visible });
}
module.exports = Object.freeze({ ImprovementActionListError, projectImprovementActionList });
