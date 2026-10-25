'use strict';

const { createHash } = require('node:crypto');
const { createAuditEnvelope, normaliseAuditEnvelope, projectAuditRow, verifyAuditRow,
    verifyAuditPhasePair, DashboardAdminAuditEnvelopeError } = require('../api/shared/dashboardAdmin/auditEnvelope');
const { createDashboardAdminService, normaliseSelector } = require('../api/shared/dashboardAdmin/service');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

const ACTOR = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const TARGET = '20000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002';
const NATIVE = '30000000-0000-4000-8000-000000000001';
const LOOKUP = '30000000-0000-4000-8000-000000000002';
const ATTEMPT = '30000000-0000-4000-8000-000000000003';
const TERMINAL = '30000000-0000-4000-8000-000000000004';
const INSTANCE = '30000000-0000-4000-8000-000000000005';
const NOW = '2026-10-19T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const selector = () => ({ provider: 'external', subjectKey: TARGET, tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' });
const binding = () => ({ requestId: NATIVE, sessionSha256: 'a'.repeat(64), instanceId: INSTANCE, actorSubjectKey: ACTOR });
function event(outcome = 'attempt') {
    return { schemaVersion: 1, category: 'dashboard_admin_read', requestId: LOOKUP, actorSubjectKey: ACTOR,
        targetSha256: createHash('sha256').update(JSON.stringify(normaliseSelector(selector()))).digest('hex'), outcome, occurredAt: NOW };
}
function fixture(outcome = 'attempt') {
    return { serviceEvent: event(outcome), selector: selector(), nativeBinding: binding(), eventId: outcome === 'attempt' ? ATTEMPT : TERMINAL };
}
function invalid(work) {
    expect(work).toThrow(DashboardAdminAuditEnvelopeError);
    try { work(); } catch (error) {
        expect(error.message).toBe('dashboard_admin_audit_invalid');
        expect(error.code).toBe('dashboard_admin_audit_invalid'); expect(error.statusCode).toBe(503);
    }
}

test('preserves supplied IDs and time, minimises the target, freezes copies and uses the existing canonical envelope hash', () => {
    const input = fixture(), value = createAuditEnvelope(input), repeated = createAuditEnvelope(input);
    expect(value).toEqual(repeated);
    expect(value.event.requestId).toBe(NATIVE); expect(value.event.lookupRequestId).toBe(LOOKUP);
    expect(value.event.eventId).toBe(ATTEMPT); expect(value.event.occurredAt).toBe(NOW);
    expect(value.event.scope).toEqual({ tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' });
    expect(JSON.stringify(value)).not.toContain(TARGET); expect(JSON.stringify(value)).not.toContain('external');
    expect(Object.isFrozen(value) && Object.isFrozen(value.event) && Object.isFrozen(value.event.scope)).toBe(true);
    input.nativeBinding.requestId = LOOKUP; input.selector.tenantId = 'changed'; input.serviceEvent.occurredAt = 'changed';
    expect(value.event.requestId).toBe(NATIVE); expect(value.event.occurredAt).toBe(NOW);
    const row = projectAuditRow(value);
    expect(Object.keys(row)).toHaveLength(13); expect(row.event_sha256).toBe(hash(value));
    expect(row.authority_id).toBeNull(); expect(row.operation_id).toBeNull();
    expect(verifyAuditRow(row, value)).toEqual(row);
});

test('accepts actual unchanged service attempt/terminal events and exactly its selector hash serialisation', async () => {
    const events = [];
    const service = createDashboardAdminService({ authoriseOperator: () => true,
        readAuthoritySnapshot: async () => { throw new Error('Synthetic reader unavailable'); },
        audit: async value => { events.push(value); return true; }, clock: () => NOW, requestBudgetMs: 1000 });
    const supplied = { organisationId: 'synthetic-organisation', tenantId: 'synthetic-tenant', subjectKey: TARGET, provider: 'external' };
    const result = await service.lookup({ provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR }, supplied);
    expect(result.result.status).toBe('unavailable'); expect(events.map(e => e.outcome)).toEqual(['attempt', 'unavailable']);
    const values = events.map((serviceEvent, i) => createAuditEnvelope({ serviceEvent, selector: supplied,
        nativeBinding: binding(), eventId: i ? TERMINAL : ATTEMPT }));
    expect(values[0].event.lookupRequestId).toBe(events[0].requestId);
    expect(values[1].event.lookupRequestId).toBe(events[0].requestId);
    expect(values.every(value => value.event.requestId === NATIVE)).toBe(true);
    expect(verifyAuditPhasePair(...values)).toEqual({ attempt: values[0], terminal: values[1] });
});

test.each(['found', 'not_found', 'unavailable'])('admits only the finite terminal %s outcome', outcome => {
    const value = createAuditEnvelope(fixture(outcome)); expect(value.event.phase).toBe('terminal');
    expect(verifyAuditPhasePair(createAuditEnvelope(fixture()), value).terminal).toEqual(value);
});

test.each([
    ['foreign actor', v => { v.nativeBinding.actorSubjectKey = TARGET; }],
    ['changed provider', v => { v.selector.provider = 'legacy'; }],
    ['changed subject', v => { v.selector.subjectKey = ACTOR; }],
    ['changed tenant', v => { v.selector.tenantId = 'other'; }],
    ['changed organisation', v => { v.selector.organisationId = 'other'; }],
    ['unknown selector field', v => { v.selector.email = 'synthetic@example.invalid'; }],
    ['unknown event field', v => { v.serviceEvent.token = 'synthetic forbidden field'; }],
    ['unknown context field', v => { v.nativeBinding.cookie = 'synthetic forbidden field'; }],
    ['wrong schema', v => { v.serviceEvent.schemaVersion = '1'; }],
    ['wrong category', v => { v.serviceEvent.category = 'dashboard.runtime'; }],
    ['unknown outcome', v => { v.serviceEvent.outcome = 'denied'; }],
    ['malformed lookup ID', v => { v.serviceEvent.requestId = 'not-an-id'; }],
    ['malformed native ID', v => { v.nativeBinding.requestId = 'not-an-id'; }],
    ['malformed event ID', v => { v.eventId = 'not-an-id'; }],
    ['malformed session digest', v => { v.nativeBinding.sessionSha256 = 'A'.repeat(64); }],
    ['noncanonical phase time', v => { v.serviceEvent.occurredAt = '2026-10-19T00:00:00Z'; }]
])('rejects %s without returning a capability or disclosing supplied values', (_name, change) => {
    const input = fixture(); change(input); invalid(() => createAuditEnvelope(input));
});

test.each([
    ['authority', v => { v.authorityId = INSTANCE; }],
    ['operation field', v => { v.event.operationId = ATTEMPT; }],
    ['event type', v => { v.event.eventType = 'dashboard.runtime'; }],
    ['category', v => { v.event.category = 'other'; }],
    ['attempt phase/outcome', v => { v.event.outcome = 'found'; }],
    ['terminal phase/outcome', v => { v.event.phase = 'terminal'; }],
    ['null scope', v => { v.event.scope = null; }],
    ['extra scope', v => { v.event.scope.provider = 'external'; }],
    ['extra envelope field', v => { v.proof = 'synthetic excluded field'; }]
])('closed envelope rejects %s', (_name, change) => {
    const value = clone(createAuditEnvelope(fixture())); change(value); invalid(() => normaliseAuditEnvelope(value));
});

test.each([
    ['event_id', '30000000-0000-4000-8000-000000000006'], ['session_sha256', 'b'.repeat(64)],
    ['instance_id', ATTEMPT], ['authority_id', INSTANCE], ['request_id', LOOKUP], ['tenant_id', 'other'],
    ['organisation_id', 'other'], ['scope_json', { tenantId: 'other', organisationId: 'synthetic-organisation' }],
    ['occurred_at', '2026-10-19T00:00:00.001Z'], ['event_type', 'dashboard.runtime'],
    ['event_sha256', '0'.repeat(64)], ['operation_id', ATTEMPT], ['payload', null]
])('readback rejects mismatched %s, including otherwise well-formed retained data', (key, replacement) => {
    const expected = createAuditEnvelope(fixture()), supplied = clone(projectAuditRow(expected));
    supplied[key] = replacement; invalid(() => verifyAuditRow(supplied, expected));
});

test('JSONB key order and a genuine pg Date preserve exact readback, without calling an overridden method', () => {
    const expected = createAuditEnvelope(fixture()), source = projectAuditRow(expected);
    const supplied = Object.fromEntries(Object.entries(clone(source)).reverse());
    supplied.payload = Object.fromEntries(Object.entries(supplied.payload).reverse());
    supplied.scope_json = Object.fromEntries(Object.entries(supplied.scope_json).reverse());
    supplied.occurred_at = new Date(NOW); supplied.occurred_at.toISOString = () => { throw new Error('must not execute'); };
    expect(verifyAuditRow(supplied, expected)).toEqual(source);
    supplied.extra = 'synthetic'; invalid(() => verifyAuditRow(supplied, expected));
});

test.each(['native request', 'lookup', 'actor', 'scope', 'target', 'session', 'instance', 'time', 'event ID', 'phase'])
    ('phase pairing rejects changed %s and cannot acknowledge a different terminal', changed => {
        const attempt = createAuditEnvelope(fixture()), terminal = clone(createAuditEnvelope(fixture('found')));
        if (changed === 'native request') terminal.event.requestId = ATTEMPT;
        if (changed === 'lookup') terminal.event.lookupRequestId = ATTEMPT;
        if (changed === 'actor') terminal.event.actorSubjectKey = TARGET;
        if (changed === 'scope') terminal.event.scope.tenantId = 'other';
        if (changed === 'target') terminal.event.targetSha256 = 'b'.repeat(64);
        if (changed === 'session') terminal.sessionSha256 = 'b'.repeat(64);
        if (changed === 'instance') terminal.instanceId = ATTEMPT;
        if (changed === 'time') terminal.event.occurredAt = '2026-10-18T23:59:59.999Z';
        if (changed === 'event ID') terminal.event.eventId = ATTEMPT;
        if (changed === 'phase') terminal.event.phase = 'attempt';
        invalid(() => verifyAuditPhasePair(attempt, terminal));
    });

test('exact retained terminal cannot be relabelled, re-timed or recreated under new IDs', () => {
    const found = createAuditEnvelope(fixture('found')), retained = projectAuditRow(found);
    for (const change of [v => { v.event.outcome = 'not_found'; }, v => { v.event.occurredAt = '2026-10-19T00:00:00.001Z'; },
        v => { v.event.eventId = ATTEMPT; }, v => { v.event.requestId = LOOKUP; }]) {
        const different = clone(found); change(different); invalid(() => verifyAuditRow(retained, different));
    }
});

test('rejects proxies/accessors/cycles/oversized values without evaluating data getters or exposing diagnostics', () => {
    let calls = 0;
    const accessor = fixture(); Object.defineProperty(accessor.serviceEvent, 'outcome', { enumerable: true, get() { calls++; return 'attempt'; } });
    invalid(() => createAuditEnvelope(accessor));
    const proxy = new Proxy(fixture(), { ownKeys() { calls++; throw new Error('synthetic private diagnostic'); } });
    invalid(() => createAuditEnvelope(proxy)); expect(calls).toBe(0);
    const cycle = fixture(); cycle.selector.extra = cycle; invalid(() => createAuditEnvelope(cycle));
    const large = fixture(); large.selector.tenantId = 'x'.repeat(17000); invalid(() => createAuditEnvelope(large));
    const expected = createAuditEnvelope(fixture()), row = clone(projectAuditRow(expected));
    Object.defineProperty(row, 'payload', { enumerable: true, get() { calls++; return null; } });
    invalid(() => verifyAuditRow(row, expected)); expect(calls).toBe(0);
    const dateRow = clone(projectAuditRow(expected));
    dateRow.occurred_at = new Proxy(new Date(NOW), { getPrototypeOf() { calls++; return Date.prototype; } });
    invalid(() => verifyAuditRow(dateRow, expected)); expect(calls).toBe(0);
});
