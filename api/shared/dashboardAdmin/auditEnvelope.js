'use strict';

// Dormant data codec only: supplied native bindings are not authenticity,
// authority, current-session or COMMIT evidence. A future trusted writer must
// establish those facts and durable phase uniqueness before using this data.
// The dormant native adapter imports this pure codec; it performs no I/O and
// grants no capability.
const { createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { copy, fields, freeze, hash, equal, uuid, digest, instant, scope, subject } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector } = require('./service');

const MAX_BYTES = 16384;
const EVENT_FIELDS = ['schemaVersion', 'eventType', 'eventId', 'requestId', 'lookupRequestId',
    'occurredAt', 'actorSubjectKey', 'scope', 'category', 'targetSha256', 'phase', 'outcome'];
const ROW_FIELDS = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
    'tenant_id', 'organisation_id', 'scope_json', 'occurred_at', 'event_type', 'event_sha256',
    'operation_id', 'payload'];
const TERMINAL_OUTCOMES = ['found', 'not_found', 'unavailable'];

class DashboardAdminAuditEnvelopeError extends Error {
    constructor() { super('dashboard_admin_audit_invalid'); this.code = this.message; this.statusCode = 503; }
}
function invalid() { throw new DashboardAdminAuditEnvelopeError(); }
function checked(work) {
    try { return work(); } catch (_) { invalid(); }
}
function envelope(input) {
    const value = fields(copy(input, MAX_BYTES), ['sessionSha256', 'instanceId', 'authorityId', 'event']);
    digest(value.sessionSha256); uuid(value.instanceId);
    if (value.authorityId !== null) invalid();
    const event = fields(value.event, EVENT_FIELDS);
    if (event.schemaVersion !== 1 || event.eventType !== 'dashboard.admin.lookup' ||
        event.category !== 'dashboard_admin_read') invalid();
    uuid(event.eventId); uuid(event.requestId); uuid(event.lookupRequestId);
    instant(event.occurredAt); subject(event.actorSubjectKey); scope(event.scope); digest(event.targetSha256);
    if (!(event.phase === 'attempt' && event.outcome === 'attempt' ||
        event.phase === 'terminal' && TERMINAL_OUTCOMES.includes(event.outcome))) invalid();
    return freeze(value);
}
function normaliseAuditEnvelope(input) { return checked(() => envelope(input)); }

function createAuditEnvelope(input) {
    return checked(() => {
        const value = fields(copy(input, MAX_BYTES), ['serviceEvent', 'selector', 'nativeBinding', 'eventId']);
        const event = fields(value.serviceEvent, ['schemaVersion', 'category', 'requestId',
            'actorSubjectKey', 'targetSha256', 'outcome', 'occurredAt']);
        const binding = fields(value.nativeBinding, ['requestId', 'sessionSha256', 'instanceId', 'actorSubjectKey']);
        uuid(binding.requestId); digest(binding.sessionSha256); uuid(binding.instanceId); subject(binding.actorSubjectKey);
        const selector = normaliseSelector(value.selector);
        // This intentionally matches service.lookup's JSON.stringify digest,
        // rather than the canonical hashing used for the durable envelope.
        const target = createHash('sha256').update(JSON.stringify(selector)).digest('hex');
        if (event.schemaVersion !== 1 || event.category !== 'dashboard_admin_read' ||
            event.actorSubjectKey !== binding.actorSubjectKey || event.targetSha256 !== target) invalid();
        return envelope({ sessionSha256: binding.sessionSha256, instanceId: binding.instanceId,
            authorityId: null, event: { schemaVersion: 1, eventType: 'dashboard.admin.lookup',
                eventId: value.eventId, requestId: binding.requestId, lookupRequestId: event.requestId,
                occurredAt: event.occurredAt, actorSubjectKey: event.actorSubjectKey,
                scope: { tenantId: selector.tenantId, organisationId: selector.organisationId },
                category: event.category, targetSha256: event.targetSha256,
                phase: event.outcome === 'attempt' ? 'attempt' : 'terminal', outcome: event.outcome } });
    });
}

function row(value) {
    const event = value.event;
    return freeze({ event_id: event.eventId, session_sha256: value.sessionSha256,
        instance_id: value.instanceId, authority_id: null, request_id: event.requestId,
        tenant_id: event.scope.tenantId, organisation_id: event.scope.organisationId,
        scope_json: event.scope, occurred_at: event.occurredAt, event_type: event.eventType,
        event_sha256: hash(value), operation_id: null, payload: event });
}
function projectAuditRow(input) { return checked(() => row(envelope(input))); }

// This compares supplied data only. Even an exact row is not an acknowledgement
// unless a trusted writer obtained it under current native/session/restore gates.
function verifyAuditRow(input, expectedInput) {
    return checked(() => {
        const expected = envelope(expectedInput);
        fields(input, ROW_FIELDS);
        const source = {};
        for (const key of ROW_FIELDS) {
            const value = input[key];
            source[key] = key === 'occurred_at' && !isProxy(value) && value instanceof Date
                ? Date.prototype.toISOString.call(value) : value;
        }
        const found = fields(copy(source, MAX_BYTES), ROW_FIELDS);
        const retained = envelope({ sessionSha256: found.session_sha256, instanceId: found.instance_id,
            authorityId: found.authority_id, event: found.payload });
        if (!equal(found, row(retained)) || !equal(retained, expected)) invalid();
        return freeze(found);
    });
}

// A structural relationship check, not proof that the attempt was committed or
// that no other terminal exists. Those remain transaction/schema obligations.
function verifyAuditPhasePair(attemptInput, terminalInput) {
    return checked(() => {
        const attempt = envelope(attemptInput), terminal = envelope(terminalInput);
        if (attempt.event.phase !== 'attempt' || terminal.event.phase !== 'terminal' ||
            attempt.event.eventId === terminal.event.eventId ||
            terminal.event.occurredAt < attempt.event.occurredAt) invalid();
        const correlation = value => ({ sessionSha256: value.sessionSha256, instanceId: value.instanceId,
            requestId: value.event.requestId, lookupRequestId: value.event.lookupRequestId,
            actorSubjectKey: value.event.actorSubjectKey, scope: value.event.scope,
            targetSha256: value.event.targetSha256 });
        if (!equal(correlation(attempt), correlation(terminal))) invalid();
        return freeze({ attempt, terminal });
    });
}

module.exports = Object.freeze({ DashboardAdminAuditEnvelopeError, createAuditEnvelope,
    normaliseAuditEnvelope, projectAuditRow, verifyAuditRow, verifyAuditPhasePair });
