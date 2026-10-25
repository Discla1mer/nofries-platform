'use strict';

const crypto = require('node:crypto');
const { evaluateAssessment, serialiseAssessmentEvaluation, EVIDENCE_STATES } = require('../assessmentEngine/assessmentEvaluator');
const { normaliseEvidenceSelector } = require('../evidenceLifecycle/evidenceDomain');

const SCOPE = ['tenantId', 'organisationId', 'planId'];
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENT_EVIDENCE = ['documented_current', 'tested_or_observed_current', 'independently_reviewed_current'];
const SUGGESTIONS = Object.freeze({
    implementation: 'Define and implement the missing parts of this control, then record supporting evidence.',
    assessment: 'Confirm the current implementation and scope before deciding what work is needed.',
    applicability: 'Review the not-applicable claim and record an authorised applicability decision.',
    evidence: 'Obtain current supporting evidence for the stated implementation.'
});

class ImprovementPlanError extends Error {
    constructor(code, statusCode = 400) {
        super(`improvement_${code}`); this.name = 'ImprovementPlanError';
        this.code = `improvement_${code}`; this.statusCode = statusCode;
    }
}
function fail(code, status) { throw new ImprovementPlanError(code, status); }

// Dormant trusted-service domain. Selectors, actor IDs and eligible-owner lists
// are consistency inputs, never credentials or grants. Future adapters must
// authenticate, authorise and load tenant-bound state before invoking it.
function createImprovementPlan(scopeInput, evaluatorInput, evaluatorOptions) {
    const scope = fields(copy(scopeInput), [...SCOPE, 'createdAt', 'actorSubjectKey']);
    SCOPE.forEach(key => id(scope[key])); instant(scope.createdAt); subject(scope.actorSubjectKey);
    // Recalculate with ENG-003; never accept caller-supplied score output.
    const evaluation = evaluateAssessment(evaluatorInput, evaluatorOptions);
    if (scope.organisationId !== evaluation.provenance.organisationId) fail('scope_mismatch', 404);
    if (scope.createdAt < evaluation.provenance.scoreAsOf) fail('time_invalid');
    const state = { schemaVersion: 1, ...select(scope), createdAt: scope.createdAt,
        createdBy: scope.actorSubjectKey, source: { provenance: evaluation.provenance,
            evaluationOutputSha256: evaluation.outputSha256 }, proposals: [], commands: [] };
    state.proposals = evaluation.atoms.flatMap(atom => {
        const kind = gapKind(atom);
        if (!kind) return [];
        return [{ actionId: actionId(state, atom.itemId, kind), itemId: atom.itemId,
            controlId: atom.controlId, domainId: atom.domainId, kind,
            response: atom.response, responseOrigin: atom.responseOrigin,
            evidenceState: atom.evidenceState, suggestedAction: SUGGESTIONS[kind] }];
    });
    return freeze(copy(state));
}

function gapKind(atom) {
    if (atom.response === 'approved_not_applicable') return null;
    if (atom.responseOrigin === 'claimed_not_applicable') return 'applicability';
    if (atom.response === 'unknown') return 'assessment';
    if (['no', 'partial'].includes(atom.response)) return 'implementation';
    return CURRENT_EVIDENCE.includes(atom.evidenceState) ? null : 'evidence';
}

function getImprovementPlanView(stateInput) {
    const { state, actions } = replay(stateInput);
    const last = state.commands[state.commands.length - 1];
    return freeze({ schemaVersion: 1, ...select(state), source: state.source,
        revision: state.commands.length, updatedAt: last ? last.at : state.createdAt,
        priority: { status: 'not_calculated', reason: 'priority_adapter_required' },
        actions: [...actions.values()], counts: {
            total: actions.size,
            unassigned: [...actions.values()].filter(action => action.ownerSubjectKey === null).length,
            completed: [...actions.values()].filter(action => action.status === 'completed').length
        } });
}

function applyImprovementActionCommand(stateInput, commandInput, trustedContextInput) {
    const { state, actions } = replay(stateInput), command = commandValue(copy(commandInput));
    const context = fields(copy(trustedContextInput), ['tenantId', 'organisationId',
        'actorSubjectKey', 'eligibleOwnerSubjectKeys']);
    id(context.tenantId); id(context.organisationId); subject(context.actorSubjectKey);
    array(context.eligibleOwnerSubjectKeys, 4096).forEach(subject);
    if (new Set(context.eligibleOwnerSubjectKeys).size !== context.eligibleOwnerSubjectKeys.length) fail('owner_invalid');
    assertBinding(state, command);
    if (context.tenantId !== state.tenantId || context.organisationId !== state.organisationId ||
        context.actorSubjectKey !== command.actorSubjectKey) fail('scope_mismatch', 404);
    const previous = state.commands.find(item => item.operationId === command.operationId);
    if (previous) {
        if (canonical(previous) !== canonical(command)) fail('operation_conflict', 409);
        return freeze(state);
    }
    if (state.commands.length >= 1024) fail('history_limit', 409);
    const owner = command.type === 'assign' ? command.payload.ownerSubjectKey :
        actions.get(command.actionId)?.ownerSubjectKey;
    if (['assign', 'start', 'complete'].includes(command.type) &&
        !context.eligibleOwnerSubjectKeys.includes(owner)) fail('owner_ineligible', 409);
    apply(state, actions, command, state.commands.length,
        state.commands.length ? state.commands[state.commands.length - 1].at : state.createdAt);
    // Enforce the same plain-data byte envelope before returning a state that a
    // repository could persist. Otherwise a valid append can make replay fail.
    return freeze(copy({ ...state, commands: [...state.commands, command] }));
}

function replay(input) {
    const state = fields(copy(input), ['schemaVersion', ...SCOPE, 'createdAt', 'createdBy', 'source', 'proposals', 'commands']);
    if (state.schemaVersion !== 1) fail('schema_invalid');
    SCOPE.forEach(key => id(state[key])); instant(state.createdAt); subject(state.createdBy);
    fields(state.source, ['provenance', 'evaluationOutputSha256']); digest(state.source.evaluationOutputSha256);
    const provenance = state.source.provenance;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) fail('source_invalid');
    if (provenance.organisationId !== state.organisationId) fail('scope_mismatch', 404);
    id(provenance.assessmentId); version(provenance.assessmentRevision); id(provenance.moduleId);
    instant(provenance.scoreAsOf);
    if (provenance.scoreAsOf > state.createdAt) fail('time_invalid');
    const actions = new Map(), items = new Set();
    for (const proposal of array(state.proposals, 4096)) {
        fields(proposal, ['actionId', 'itemId', 'controlId', 'domainId', 'kind',
            'response', 'responseOrigin', 'evidenceState', 'suggestedAction']);
        ['itemId', 'controlId', 'domainId'].forEach(key => id(proposal[key]));
        if (!['yes', 'no', 'partial', 'unknown'].includes(proposal.response) ||
            !['direct', 'direct_unknown', 'missing', 'claimed_not_applicable'].includes(proposal.responseOrigin) ||
            !EVIDENCE_STATES.includes(proposal.evidenceState) || gapKind(proposal) !== proposal.kind ||
            !Object.hasOwn(SUGGESTIONS, proposal.kind) || proposal.suggestedAction !== SUGGESTIONS[proposal.kind] ||
            proposal.actionId !== actionId(state, proposal.itemId, proposal.kind) || items.has(proposal.itemId)) fail('proposal_invalid');
        items.add(proposal.itemId);
        actions.set(proposal.actionId, { ...proposal, status: 'open', ownerSubjectKey: null,
            dueDate: null, blockedReason: null, completion: null });
    }
    let at = state.createdAt;
    const operations = new Set();
    array(state.commands, 1024).forEach((raw, index) => {
        const command = commandValue(raw);
        if (operations.has(command.operationId)) fail('history_invalid');
        operations.add(command.operationId); apply(state, actions, command, index, at); at = command.at;
    });
    return { state, actions };
}

function commandValue(input) {
    const row = fields(input, [...SCOPE, 'evaluationOutputSha256', 'actionId', 'operationId',
        'expectedRevision', 'actorSubjectKey', 'at', 'type', 'payload']);
    SCOPE.forEach(key => id(row[key])); digest(row.evaluationOutputSha256);
    id(row.actionId); id(row.operationId); subject(row.actorSubjectKey); instant(row.at);
    if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0) fail('revision_invalid');
    if (row.type === 'assign') {
        fields(row.payload, ['ownerSubjectKey', 'dueDate']); subject(row.payload.ownerSubjectKey); date(row.payload.dueDate);
    } else if (row.type === 'block') {
        fields(row.payload, ['reason']); note(row.payload.reason);
    } else if (row.type === 'complete') {
        fields(row.payload, ['note', 'evidenceReference']); note(row.payload.note); evidenceReference(row.payload.evidenceReference, row);
    } else if (row.type === 'reopen') {
        fields(row.payload, ['reason']); note(row.payload.reason);
    } else if (row.type === 'start') fields(row.payload, []);
    else fail('command_invalid');
    return row;
}

function apply(state, actions, command, revision, previousAt) {
    assertBinding(state, command);
    if (command.expectedRevision !== revision) fail('revision_conflict', 409);
    if (command.at < previousAt) fail('time_regression', 409);
    const action = actions.get(command.actionId);
    if (!action) fail('action_not_found', 404);
    if (command.type === 'assign') {
        if (action.status === 'completed') fail('transition_invalid', 409);
        action.ownerSubjectKey = command.payload.ownerSubjectKey; action.dueDate = command.payload.dueDate;
    } else if (command.type === 'start') {
        if (!['open', 'blocked'].includes(action.status) || !action.ownerSubjectKey || !action.dueDate) fail('transition_invalid', 409);
        action.status = 'in_progress'; action.blockedReason = null;
    } else if (command.type === 'block') {
        if (action.status !== 'in_progress') fail('transition_invalid', 409);
        action.status = 'blocked'; action.blockedReason = command.payload.reason;
    } else if (command.type === 'complete') {
        if (!['in_progress', 'blocked'].includes(action.status) || !action.ownerSubjectKey || !action.dueDate) fail('transition_invalid', 409);
        action.status = 'completed'; action.blockedReason = null;
        action.completion = { ...command.payload, completedAt: command.at, completedBy: command.actorSubjectKey,
            evidenceVerification: 'not_verified' };
    } else if (command.type === 'reopen') {
        if (action.status !== 'completed') fail('transition_invalid', 409);
        action.status = 'open'; action.completion = null;
    }
}

function assertBinding(state, command) {
    if (SCOPE.some(key => state[key] !== command[key]) ||
        state.source.evaluationOutputSha256 !== command.evaluationOutputSha256) fail('scope_mismatch', 404);
}
function select(row) { return Object.fromEntries(SCOPE.map(key => [key, row[key]])); }
function actionId(state, itemId, kind) {
    return 'action:' + crypto.createHash('sha256').update('nofries:improvement-action:v1\0')
        .update(canonical({ ...select(state), evaluationOutputSha256: state.source.evaluationOutputSha256, itemId, kind })).digest('hex');
}
function canonical(value) { return serialiseAssessmentEvaluation(value); }
function copy(value) {
    try { return JSON.parse(canonical(value)); } catch (_) { fail('plain_data_required'); }
}
function fields(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('fields_invalid');
    return value;
}
function array(value, max) { if (!Array.isArray(value) || value.length > max) fail('list_invalid'); return value; }
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail('identifier_invalid'); return value; }
function evidenceReference(value, scope) {
    // Preserve the existing evidence ID contract (180 UTF-16 units, valid
    // Unicode and opaque punctuation), rather than assessment identifier rules.
    try { normaliseEvidenceSelector({ tenantId: scope.tenantId, organisationId: scope.organisationId, artefactId: value }); }
    catch (_) { fail('identifier_invalid'); }
    // IDs are inert and must never be dereferenced. Separately exclude explicit
    // locations and executable URI schemes without rewriting opaque identity.
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|vbscript):|[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(value)) fail('identifier_invalid');
}
function version(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(value) ||
        value.toLowerCase() === 'latest') fail('version_invalid');
}
function subject(value) { if (typeof value !== 'string' || !SUBJECT.test(value)) fail('subject_invalid'); }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('digest_invalid'); }
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('time_invalid');
}
function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date_invalid');
    try { instant(value + 'T00:00:00.000Z'); } catch (_) { fail('date_invalid'); }
}
function note(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail('note_invalid');
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

module.exports = { ImprovementPlanError, createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand };
