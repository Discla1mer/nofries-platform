'use strict';

// Data validation only. A supplied grant/native binding is not proof of current
// authority, session authenticity, restore state or COMMIT. The native owner
// establishes those facts before creating and retaining an envelope.
const { isProxy } = require('node:util').types;
const { copy, fields, freeze, hash, equal, uuid, digest, instant, subject, id } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSignupAuthority } = require('./signupAuthority');

const MAX_BYTES = 16384;
const SERVICE_FIELDS = ['schemaVersion', 'category', 'requestId', 'actorSubjectKey', 'authoritySha256',
    'requestSha256', 'page', 'phase', 'outcome', 'count', 'occurredAt'];
const POPULATION_FIELDS = ['provider', 'tenantId', 'populationId', 'indexId', 'auditPolicyId'];
const ROW_FIELDS = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
    'tenant_id', 'organisation_id', 'scope_json', 'occurred_at', 'event_type', 'event_sha256', 'operation_id', 'payload'];
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;

class DashboardAdminSignupAuditEnvelopeError extends Error {
    constructor() { super('dashboard_admin_signup_audit_invalid'); this.code = this.message; this.statusCode = 503; }
}
const invalid = () => { throw new DashboardAdminSignupAuditEnvelopeError(); };
const checked = work => { try { return work(); } catch (_) { invalid(); } };

function population(value, version) {
    const keys = version === 1 ? POPULATION_FIELDS : ['provider', 'scope', 'populationId', 'indexId', 'auditPolicyId'];
    fields(value, keys);
    if (![1, 2].includes(version) || !['legacy', 'external'].includes(value.provider)) invalid();
    keys.filter(key => !['provider', 'scope'].includes(key)).forEach(key => id(value[key]));
    if (version === 2) {
        fields(value.scope, ['kind', 'manifestSha256']);
        if (value.scope.kind !== 'finite_manifest') invalid();
        digest(value.scope.manifestSha256);
    }
    return value;
}
function serviceEvent(value) {
    fields(value, SERVICE_FIELDS);
    if (value.schemaVersion !== 1 || value.category !== 'dashboard_admin_signup_list') invalid();
    uuid(value.requestId); subject(value.actorSubjectKey); digest(value.authoritySha256); digest(value.requestSha256); instant(value.occurredAt);
    if (!integer(value.page, 1, 10) || !integer(value.count, 0, 25) ||
        !(value.phase === 'attempt' && value.outcome === 'requested' && value.count === 0 ||
            value.phase === 'outcome' && (value.outcome === 'available' ||
                ['unavailable', 'denied'].includes(value.outcome) && value.count === 0))) invalid();
    return value;
}
function grant(input, event) {
    const value = normaliseSignupAuthority(input, { actorSubjectKey: event.actorSubjectKey, now: event.occurredAt });
    if (event.page > value.maxPages || event.count > value.maxPageSize || hash(value) !== event.authoritySha256) invalid();
    return value;
}
function envelope(input) {
    const value = fields(copy(input, MAX_BYTES), ['sessionSha256', 'instanceId', 'authorityId', 'event']);
    digest(value.sessionSha256); uuid(value.instanceId);
    if (value.authorityId !== null) invalid();
    const event = fields(value.event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt',
        'actorSubjectKey', 'population', 'serviceEvent', 'serviceEventSha256']);
    if (![1, 2].includes(event.schemaVersion) || event.eventType !== 'dashboard.admin.signup_list') invalid();
    uuid(event.eventId); uuid(event.requestId); instant(event.occurredAt); subject(event.actorSubjectKey);
    population(event.population, event.schemaVersion); serviceEvent(event.serviceEvent); digest(event.serviceEventSha256);
    if (event.actorSubjectKey !== event.serviceEvent.actorSubjectKey || event.occurredAt !== event.serviceEvent.occurredAt ||
        event.serviceEventSha256 !== hash(event.serviceEvent)) invalid();
    return freeze(value);
}
function normaliseSignupAuditEnvelope(input) { return checked(() => envelope(input)); }
function createSignupAuditEnvelope(input) {
    return checked(() => {
        const value = fields(copy(input, MAX_BYTES), ['serviceEvent', 'authority', 'nativeBinding', 'eventId']);
        const original = serviceEvent(value.serviceEvent), authority = grant(value.authority, original);
        const native = fields(value.nativeBinding, ['requestId', 'sessionSha256', 'instanceId', 'actorSubjectKey']);
        uuid(native.requestId); digest(native.sessionSha256); uuid(native.instanceId); subject(native.actorSubjectKey);
        if (native.actorSubjectKey !== original.actorSubjectKey) invalid();
        return envelope({ sessionSha256: native.sessionSha256, instanceId: native.instanceId, authorityId: null,
            event: { schemaVersion: authority.schemaVersion, eventType: 'dashboard.admin.signup_list', eventId: value.eventId,
                requestId: native.requestId, occurredAt: original.occurredAt, actorSubjectKey: native.actorSubjectKey,
                population: Object.fromEntries((authority.schemaVersion === 1 ? POPULATION_FIELDS :
                    ['provider', 'scope', 'populationId', 'indexId', 'auditPolicyId']).map(key => [key, authority[key]])),
                serviceEvent: original, serviceEventSha256: hash(original) } });
    });
}
function row(value) {
    const event = value.event;
    // A population can span organisations. Do not manufacture an organisation
    // scope. The exact provider and tenant or finite manifest remain in the payload.
    return freeze({ event_id: event.eventId, session_sha256: value.sessionSha256, instance_id: value.instanceId,
        authority_id: null, request_id: event.requestId, tenant_id: null, organisation_id: null, scope_json: null,
        occurred_at: event.occurredAt, event_type: event.eventType, event_sha256: hash(value), operation_id: null, payload: event });
}
function projectSignupAuditRow(input) { return checked(() => row(envelope(input))); }
function verifySignupAuditRow(input, expectedInput) {
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
function verifySignupAuditPhasePair(attemptInput, outcomeInput) {
    return checked(() => {
        const attempt = envelope(attemptInput), outcome = envelope(outcomeInput);
        if (attempt.event.serviceEvent.phase !== 'attempt' || outcome.event.serviceEvent.phase !== 'outcome' ||
            attempt.event.eventId === outcome.event.eventId || outcome.event.occurredAt < attempt.event.occurredAt) invalid();
        const correlation = value => ({ sessionSha256: value.sessionSha256, instanceId: value.instanceId,
            nativeRequestId: value.event.requestId, population: value.event.population,
            actorSubjectKey: value.event.actorSubjectKey, requestId: value.event.serviceEvent.requestId,
            authoritySha256: value.event.serviceEvent.authoritySha256, requestSha256: value.event.serviceEvent.requestSha256,
            page: value.event.serviceEvent.page });
        if (!equal(correlation(attempt), correlation(outcome))) invalid();
        return freeze({ attempt, outcome });
    });
}

module.exports = Object.freeze({ DashboardAdminSignupAuditEnvelopeError, createSignupAuditEnvelope,
    normaliseSignupAuditEnvelope, projectSignupAuditRow, verifySignupAuditRow, verifySignupAuditPhasePair });
