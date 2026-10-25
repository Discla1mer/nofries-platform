'use strict';

const { copy, fields, freeze, instant, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseEvidenceSelector } = require('../evidenceLifecycle/evidenceDomain');
const LABELS = freeze({
    status: { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed' },
    kind: { implementation: 'Implementation gap', assessment: 'Assessment needed',
        applicability: 'Applicability review', evidence: 'Evidence gap' },
    response: { yes: 'Yes', no: 'No', partial: 'Partly implemented', unknown: 'Unknown' },
    responseOrigin: { direct: 'Recorded response', direct_unknown: 'Recorded as unknown',
        missing: 'No response recorded', claimed_not_applicable: 'Not-applicable claim awaiting approval' },
    evidenceState: { not_provided: 'Not provided', attested: 'Self-attested', documented_current: 'Documented as current',
        tested_or_observed_current: 'Tested or observed as current', independently_reviewed_current: 'Independently reviewed as current',
        stale: 'Stale', inaccessible: 'Inaccessible', disputed: 'Disputed', unavailable: 'Unavailable' },
    history: { assign: 'Assigned', start: 'Started', block: 'Blocked', complete: 'Completed', reopen: 'Reopened' }
});
const NOTICES = freeze({
    priority: 'Risk priority has not been calculated.',
    order: 'Ordered by due date, then action ID. This is not a risk ranking.',
    evidence: 'Completion records workflow progress. Evidence references are unverified, downloads are unavailable, and scores are unchanged.',
    owner: 'Owner references do not confirm current membership or permission.'
});
class ImprovementActionPlanPresentationError extends Error {
    constructor() {
        super('improvement_presentation_unavailable');
        this.name = 'ImprovementActionPlanPresentationError'; this.code = 'improvement_presentation_unavailable';
        this.statusCode = 503; delete this.stack; Object.freeze(this);
    }
}
const fail = () => { throw new ImprovementActionPlanPresentationError(); };
function label(kind, value) {
    if (typeof value !== 'string' || !Object.hasOwn(LABELS[kind], value)) fail();
    return LABELS[kind][value];
}
function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail();
}
function integer(value, maximum) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum || Object.is(value, -0)) fail();
}
function text(value, maximum = 1000) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail();
}
function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
    instant(value + 'T00:00:00.000Z');
}
function countSet(value) {
    fields(value, ['total', 'unassigned', 'overdue', 'byStatus']);
    for (const key of ['total', 'unassigned', 'overdue']) integer(value[key], 4096);
    fields(value.byStatus, Object.keys(LABELS.status));
    for (const count of Object.values(value.byStatus)) integer(count, 4096);
    if (Object.values(value.byStatus).reduce((sum, count) => sum + count, 0) !== value.total ||
        value.unassigned > value.total || value.overdue > value.total) fail();
}
function evidenceReference(value) {
    // Retain opaque Unicode identifiers as text. Nothing here dereferences them.
    normaliseEvidenceSelector({ tenantId: 'selector', organisationId: 'selector', artefactId: value });
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|vbscript):|[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(value)) fail();
}
function eventValue(event, model, revisions) {
    fields(event, ['revision', 'at', 'type', 'details']);
    integer(event.revision, model.planRevision);
    if (!event.revision || revisions.has(event.revision)) fail();
    revisions.add(event.revision); instant(event.at);
    if (event.at < model.source.scoreAsOf || event.at > model.updatedAt) fail();
    const eventLabel = label('history', event.type), details = event.details;
    if (event.type === 'assign') {
        fields(details, ['ownerSubjectKey', 'dueDate']); subject(details.ownerSubjectKey); date(details.dueDate);
    } else if (event.type === 'start') fields(details, []);
    else if (event.type === 'block' || event.type === 'reopen') {
        fields(details, ['reason']); text(details.reason);
    } else {
        fields(details, ['note', 'evidenceReference', 'evidenceVerification', 'durableLinkStatus']);
        text(details.note); evidenceReference(details.evidenceReference);
        if (details.evidenceVerification !== 'not_verified' || details.durableLinkStatus !== 'not_established') fail();
    }
    return { ...event, label: eventLabel };
}
function actionValue(action, model, revisions) {
    fields(action, ['actionId', 'itemId', 'controlId', 'domainId', 'status', 'ownerSubjectKey', 'ownerEligibility',
        'dueDate', 'isOverdue', 'blockedReason', 'rationale', 'completion', 'evidence', 'history']);
    for (const key of ['actionId', 'itemId', 'controlId', 'domainId']) identifier(action[key]);
    const status = label('status', action.status);
    if (action.ownerEligibility !== 'not_checked' || typeof action.isOverdue !== 'boolean') fail();
    if (action.ownerSubjectKey === null) {
        if (action.dueDate !== null) fail();
    } else { subject(action.ownerSubjectKey); date(action.dueDate); }
    if (action.status === 'blocked') text(action.blockedReason);
    else if (action.blockedReason !== null) fail();
    if (action.status === 'completed') {
        fields(action.completion, ['at', 'note']); instant(action.completion.at); text(action.completion.note);
        if (action.completion.at < model.source.scoreAsOf || action.completion.at > model.updatedAt) fail();
    } else if (action.completion !== null) fail();
    if (action.isOverdue && (action.status === 'completed' || action.dueDate === null)) fail();
    const rationale = fields(action.rationale, ['kind', 'response', 'responseOrigin', 'suggestedAction']);
    text(rationale.suggestedAction);
    const evidence = fields(action.evidence, ['assessmentState', 'completionReference', 'completionVerification',
        'durableLinkStatus', 'downloadAllowed', 'scoreEffect']);
    if (evidence.durableLinkStatus !== 'not_established' || evidence.downloadAllowed !== false || evidence.scoreEffect !== 'none') fail();
    if (action.completion === null) {
        if (evidence.completionReference !== null || evidence.completionVerification !== 'not_recorded') fail();
    } else {
        evidenceReference(evidence.completionReference);
        if (evidence.completionVerification !== 'not_verified') fail();
    }
    if (!Array.isArray(action.history) || action.history.length > 1024) fail();
    let previousRevision = 0, previousAt = model.source.scoreAsOf;
    const history = action.history.map(event => {
        const result = eventValue(event, model, revisions);
        if (event.revision <= previousRevision || event.at < previousAt) fail();
        previousRevision = event.revision; previousAt = event.at;
        return result;
    });
    return { ...action, history, labels: { status, kind: label('kind', rationale.kind),
        response: label('response', rationale.response), responseOrigin: label('responseOrigin', rationale.responseOrigin),
        evidenceState: label('evidenceState', evidence.assessmentState),
        owner: action.ownerSubjectKey === null ? 'Unassigned' : 'Assigned (eligibility not checked)' } };
}

// Pure trusted-host output formatting, not an authentication or authorization
// boundary. Retained facts are copied, never ranked, re-timed or looked up in a
// current catalogue. The caller still owns genuine request-lifetime disclosure.
function projectImprovementActionPlanPresentation(input) {
    try {
        const model = fields(copy(input, 2097152), ['schemaVersion', 'scope', 'planRevision', 'updatedAt', 'asOf',
            'dueDateBasis', 'source', 'priority', 'order', 'filters', 'counts', 'actions']);
        if (model.schemaVersion !== 1 || model.dueDateBasis !== 'UTC_calendar_day' || model.order !== 'due_date_then_action_id') fail();
        fields(model.scope, ['tenantId', 'organisationId', 'planId']); Object.values(model.scope).forEach(identifier);
        integer(model.planRevision, 1024); instant(model.updatedAt); instant(model.asOf);
        fields(model.source, ['assessmentId', 'assessmentRevision', 'scoreAsOf', 'evaluationOutputSha256']);
        identifier(model.source.assessmentId); instant(model.source.scoreAsOf);
        if (typeof model.source.assessmentRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(model.source.assessmentRevision) ||
            model.source.assessmentRevision.toLowerCase() === 'latest' || typeof model.source.evaluationOutputSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(model.source.evaluationOutputSha256) ||
            model.source.scoreAsOf > model.updatedAt || model.updatedAt > model.asOf) fail();
        fields(model.priority, ['status', 'reason']);
        if (model.priority.status !== 'not_calculated' || model.priority.reason !== 'priority_adapter_required') fail();
        fields(model.filters, ['status', 'owner', 'overdueOnly']);
        if (model.filters.status !== 'all') label('status', model.filters.status);
        if (!['all', 'unassigned'].includes(model.filters.owner)) subject(model.filters.owner);
        if (typeof model.filters.overdueOnly !== 'boolean') fail();
        fields(model.counts, ['all', 'visible']); countSet(model.counts.all); countSet(model.counts.visible);
        for (const key of ['total', 'unassigned', 'overdue']) if (model.counts.visible[key] > model.counts.all[key]) fail();
        for (const key of Object.keys(LABELS.status)) if (model.counts.visible.byStatus[key] > model.counts.all.byStatus[key]) fail();
        if (!Array.isArray(model.actions) || model.actions.length > 4096 || model.actions.length !== model.counts.visible.total) fail();
        const revisions = new Set(), ids = new Set();
        const actions = model.actions.map(action => {
            const result = actionValue(action, model, revisions);
            if (ids.has(action.actionId)) fail(); ids.add(action.actionId);
            if (model.filters.status !== 'all' && action.status !== model.filters.status ||
                model.filters.owner === 'unassigned' && action.ownerSubjectKey !== null ||
                !['all', 'unassigned'].includes(model.filters.owner) && action.ownerSubjectKey !== model.filters.owner ||
                model.filters.overdueOnly && !action.isOverdue) fail();
            return result;
        });
        if (revisions.size > 1024 || actions.filter(action => action.ownerSubjectKey === null).length !== model.counts.visible.unassigned ||
            actions.filter(action => action.isOverdue).length !== model.counts.visible.overdue) fail();
        for (const key of Object.keys(LABELS.status)) {
            if (actions.filter(action => action.status === key).length !== model.counts.visible.byStatus[key]) fail();
        }
        return freeze({ ...model, actions, presentationVersion: 1, notices: { ...NOTICES } });
    } catch { fail(); }
}
module.exports = Object.freeze({ ImprovementActionPlanPresentationError, projectImprovementActionPlanPresentation });
