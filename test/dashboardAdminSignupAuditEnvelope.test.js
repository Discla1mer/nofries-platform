'use strict';

const { createSignupAuditEnvelope, normaliseSignupAuditEnvelope, projectSignupAuditRow,
    verifySignupAuditRow, verifySignupAuditPhasePair, DashboardAdminSignupAuditEnvelopeError } =
    require('../api/shared/dashboardAdmin/signupAuditEnvelope');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const uid = n => '71000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ACTOR = uid(1) + ':' + uid(2), OTHER = uid(1) + ':' + uid(3);
const NOW = '2026-10-20T22:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function authority() {
    return { schemaVersion: 1, capability: 'signupList', operatorSubjectKey: ACTOR,
        provider: 'external', tenantId: 'synthetic-tenant', populationId: 'synthetic-population', indexId: 'synthetic-index',
        authorityRevision: 3, issuedAt: '2026-10-20T21:59:00.000Z', expiresAt: '2026-10-20T22:10:00.000Z',
        maxPageSize: 10, maxRows: 20, maxPages: 2,
        fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-audit-policy' };
}
function input(outcome = 'requested', count = 0) {
    const grant = authority();
    return { authority: grant, eventId: outcome === 'requested' ? uid(4) : uid(5),
        nativeBinding: { requestId: uid(6), sessionSha256: 'a'.repeat(64), instanceId: uid(7), actorSubjectKey: ACTOR },
        serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId: uid(8), actorSubjectKey: ACTOR,
            authoritySha256: hash(grant), requestSha256: hash({ cursor: null }), page: 1,
            phase: outcome === 'requested' ? 'attempt' : 'outcome', outcome, count, occurredAt: NOW } };
}
function invalid(work) { expect(work).toThrow(DashboardAdminSignupAuditEnvelopeError); }
function repairHash(value) { value.event.serviceEventSha256 = hash(value.event.serviceEvent); return value; }

test('preserves original service event and full grant digest without inventing an organisation or exposing grant data', () => {
    const supplied = input(), expected = clone(supplied), result = createSignupAuditEnvelope(supplied);
    expect(result.event.serviceEvent).toEqual(expected.serviceEvent);
    expect(result.event.serviceEventSha256).toBe(hash(expected.serviceEvent));
    expect(result.event.population).toEqual({ provider: 'external', tenantId: 'synthetic-tenant',
        populationId: 'synthetic-population', indexId: 'synthetic-index', auditPolicyId: 'synthetic-audit-policy' });
    expect(result.event.requestId).toBe(uid(6)); expect(result.event.serviceEvent.requestId).toBe(uid(8));
    expect(JSON.stringify(result)).not.toMatch(/maxRows|expiresAt|email|cursor|cookie|token|organisationId/);
    expect(Object.isFrozen(result.event.serviceEvent) && Object.isFrozen(result.event.population)).toBe(true);
    supplied.serviceEvent.count = 9; supplied.authority.tenantId = 'changed'; supplied.nativeBinding.requestId = uid(9);
    expect(result.event.serviceEvent).toEqual(expected.serviceEvent); expect(result.event.requestId).toBe(uid(6));
    const row = projectSignupAuditRow(result);
    expect(row).toEqual(expect.objectContaining({ tenant_id: null, organisation_id: null, scope_json: null,
        authority_id: null, operation_id: null, event_type: 'dashboard.admin.signup_list', event_sha256: hash(result) }));
    expect(verifySignupAuditRow(row, result)).toEqual(row);
});

test.each(['available', 'unavailable', 'denied'])('accepts the finite %s outcome with the immutable attempt', outcome => {
    const attempt = createSignupAuditEnvelope(input()), terminal = createSignupAuditEnvelope(input(outcome, outcome === 'available' ? 2 : 0));
    expect(verifySignupAuditPhasePair(attempt, terminal)).toEqual({ attempt, outcome: terminal });
});

test('consumes actual unchanged listing-service events and preserves its digest acknowledgement contract', async () => {
    const envelopes = [], original = [];
    const service = createSignupListService({ authoriseSignupList: async () => authority(),
        readSignupPage: async () => { throw new Error('synthetic unavailable source'); }, clock: () => NOW, requestBudgetMs: 1000,
        audit: async (event, grant) => {
            original.push(event);
            const value = createSignupAuditEnvelope({ ...input(), authority: grant, serviceEvent: event,
                eventId: envelopes.length ? uid(5) : uid(4) });
            envelopes.push(value);
            // Synthetic ACK only: this test does not establish native durability.
            return { schemaVersion: 1, durable: true, eventSha256: value.event.serviceEventSha256 };
        } });
    const result = await service.list({ provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR }, { cursor: null });
    expect(result.status).toBe('unavailable');
    expect(original.map(value => [value.phase, value.outcome])).toEqual([['attempt', 'requested'], ['outcome', 'unavailable']]);
    expect(envelopes.map(value => value.event.serviceEvent)).toEqual(original);
    expect(verifySignupAuditPhasePair(...envelopes).outcome).toEqual(envelopes[1]);
});

test.each(['provider', 'tenantId', 'populationId', 'indexId', 'authorityRevision', 'issuedAt', 'expiresAt',
    'maxPageSize', 'maxRows', 'maxPages', 'fields', 'auditPolicyId'])('full grant digest detects changed %s', field => {
    const value = input();
    if (field === 'fields') value.authority.fields.reverse();
    else if (typeof value.authority[field] === 'number') value.authority[field]++;
    else if (field === 'provider') value.authority[field] = 'legacy';
    else if (field.endsWith('At')) value.authority[field] = value.authority[field].replace('.000Z', '.001Z');
    else value.authority[field] += '-changed';
    invalid(() => createSignupAuditEnvelope(value));
});

test.each([
    ['expired grant', v => { v.authority.expiresAt = NOW; }],
    ['future grant', v => { v.authority.issuedAt = '2026-10-20T22:00:00.001Z'; }],
    ['overlong grant', v => { v.authority.expiresAt = '2026-10-21T00:00:00.000Z'; }],
    ['wrong capability', v => { v.authority.capability = 'lookup'; }],
    ['wrong operator', v => { v.authority.operatorSubjectKey = OTHER; }],
    ['page over grant bound', v => { v.serviceEvent.page = 3; }],
    ['count over grant bound', v => { v.serviceEvent.count = 11; }],
    ['page zero', v => { v.serviceEvent.page = 0; }],
    ['negative zero count', v => { v.serviceEvent.count = -0; }],
    ['fractional count', v => { v.serviceEvent.count = 0.1; }],
    ['wrong fields', v => { v.authority.fields = ['email']; }],
    ['invalid maximum', v => { v.authority.maxRows = 101; }],
    ['page wider than rows', v => { v.authority.maxRows = 1; }],
    ['unknown grant field', v => { v.authority.approved = true; }],
    ['foreign native actor', v => { v.nativeBinding.actorSubjectKey = OTHER; }],
    ['missing native session', v => { v.nativeBinding.sessionSha256 = null; }],
    ['unknown native field', v => { v.nativeBinding.cookie = 'synthetic-excluded'; }],
    ['wrong category', v => { v.serviceEvent.category = 'dashboard_admin_read'; }],
    ['raw cursor field', v => { v.serviceEvent.cursor = 'synthetic-excluded'; }],
    ['wrong service schema', v => { v.serviceEvent.schemaVersion = '1'; }],
    ['malformed event ID', v => { v.eventId = 'not-an-id'; }],
    ['noncanonical time', v => { v.serviceEvent.occurredAt = '2026-10-20T22:00:00Z'; }]
])('rejects %s even if the supplied grant hash is recomputed', (_name, change) => {
    const value = input('available', 1); change(value); value.serviceEvent.authoritySha256 = hash(value.authority);
    invalid(() => createSignupAuditEnvelope(value));
});

test.each([['attempt', 'available', 0], ['attempt', 'requested', 1], ['outcome', 'requested', 0],
    ['terminal', 'available', 1], ['outcome', 'denied', 1], ['outcome', 'unavailable', 1], ['outcome', 'found', 0]])
('rejects incoherent phase %s/outcome %s/count %s', (phase, outcome, count) => {
    const value = input(); Object.assign(value.serviceEvent, { phase, outcome, count }); invalid(() => createSignupAuditEnvelope(value));
});

test.each(['session', 'instance', 'native request', 'service request', 'actor', 'population', 'authority', 'request digest', 'page', 'time', 'event ID'])
('phase pairing rejects changed %s', change => {
    const attempt = createSignupAuditEnvelope(input()), terminal = clone(createSignupAuditEnvelope(input('available', 1)));
    if (change === 'session') terminal.sessionSha256 = 'b'.repeat(64);
    if (change === 'instance') terminal.instanceId = uid(9);
    if (change === 'native request') terminal.event.requestId = uid(9);
    if (change === 'service request') terminal.event.serviceEvent.requestId = uid(9);
    if (change === 'actor') terminal.event.actorSubjectKey = terminal.event.serviceEvent.actorSubjectKey = OTHER;
    if (change === 'population') terminal.event.population.indexId = 'other';
    if (change === 'authority') terminal.event.serviceEvent.authoritySha256 = 'b'.repeat(64);
    if (change === 'request digest') terminal.event.serviceEvent.requestSha256 = 'b'.repeat(64);
    if (change === 'page') terminal.event.serviceEvent.page = 2;
    if (change === 'time') terminal.event.occurredAt = terminal.event.serviceEvent.occurredAt = '2026-10-20T21:59:59.999Z';
    if (change === 'event ID') terminal.event.eventId = attempt.event.eventId;
    repairHash(terminal); invalid(() => verifySignupAuditPhasePair(attempt, terminal));
});

test.each([
    ['event_id', uid(9)], ['session_sha256', 'b'.repeat(64)], ['instance_id', uid(9)], ['authority_id', uid(9)],
    ['request_id', uid(9)], ['tenant_id', 'synthetic-tenant'], ['organisation_id', 'fake-org'], ['scope_json', {}],
    ['occurred_at', '2026-10-20T22:00:00.001Z'], ['event_type', 'dashboard.admin.lookup'],
    ['event_sha256', 'b'.repeat(64)], ['operation_id', uid(9)], ['payload', null]
])('readback rejects wrong %s', (key, value) => {
    const expected = createSignupAuditEnvelope(input()), row = clone(projectSignupAuditRow(expected));
    row[key] = value; invalid(() => verifySignupAuditRow(row, expected));
});

test('closed envelope detects altered original event/hash/header and never trusts a supplied durable flag', () => {
    const expected = createSignupAuditEnvelope(input());
    for (const change of [v => { v.event.serviceEvent.authoritySha256 = 'b'.repeat(64); },
        v => { v.event.serviceEventSha256 = 'b'.repeat(64); }, v => { v.event.actorSubjectKey = OTHER; },
        v => { v.authorityId = uid(9); }, v => { v.event.eventType = 'dashboard.admin.lookup'; },
        v => { v.event.population.organisationId = 'invented'; }, v => { v.durable = true; }]) {
        const value = clone(expected); change(value); invalid(() => normaliseSignupAuditEnvelope(value));
    }
});

test('JSONB ordering and native pg Date do not change exact readback', () => {
    const expected = createSignupAuditEnvelope(input()), row = clone(projectSignupAuditRow(expected));
    row.payload.serviceEvent = Object.fromEntries(Object.entries(row.payload.serviceEvent).reverse());
    row.payload.population = Object.fromEntries(Object.entries(row.payload.population).reverse());
    row.occurred_at = new Date(NOW); row.occurred_at.toISOString = () => { throw new Error('must not run'); };
    expect(verifySignupAuditRow(row, expected)).toEqual(projectSignupAuditRow(expected));
});

test('hostile proxies/getters/cycles/oversized input do not execute or disclose supplied diagnostics', () => {
    let calls = 0;
    const accessor = input(); Object.defineProperty(accessor.serviceEvent, 'count', { enumerable: true, get() { calls++; return 0; } });
    invalid(() => createSignupAuditEnvelope(accessor));
    invalid(() => createSignupAuditEnvelope(new Proxy(input(), { ownKeys() { calls++; throw new Error('private'); } })));
    const cyclic = input(); cyclic.authority.extra = cyclic; invalid(() => createSignupAuditEnvelope(cyclic));
    const large = input(); large.authority.indexId = 'x'.repeat(17000); invalid(() => createSignupAuditEnvelope(large));
    const expected = createSignupAuditEnvelope(input()), row = clone(projectSignupAuditRow(expected));
    Object.defineProperty(row, 'payload', { enumerable: true, get() { calls++; return null; } });
    invalid(() => verifySignupAuditRow(row, expected));
    const dateRow = clone(projectSignupAuditRow(expected));
    dateRow.occurred_at = new Proxy(new Date(NOW), { getPrototypeOf() { calls++; return Date.prototype; } });
    invalid(() => verifySignupAuditRow(dateRow, expected)); expect(calls).toBe(0);
});

test('v2 envelope binds finite manifest while retaining unchanged original service event', () => {
    const value = input(); value.authority.schemaVersion = 2; delete value.authority.tenantId;
    value.authority.scope = { kind: 'finite_manifest', manifestSha256: 'd'.repeat(64) };
    value.serviceEvent.authoritySha256 = hash(value.authority);
    const envelope = createSignupAuditEnvelope(value);
    expect(envelope.event.schemaVersion).toBe(2);
    expect(envelope.event.population).toEqual({ provider: 'external', scope: value.authority.scope,
        populationId: 'synthetic-population', indexId: 'synthetic-index', auditPolicyId: 'synthetic-audit-policy' });
    expect(envelope.event.serviceEvent).toEqual(value.serviceEvent);
    expect(verifySignupAuditRow(projectSignupAuditRow(envelope), envelope)).toEqual(projectSignupAuditRow(envelope));
    expect(JSON.stringify(envelope)).not.toMatch(/tenantId|organisationId|entries|email|accountId|setupRequestId/);
});

test.each(['mixed-tenant', 'null-scope', 'missing-digest', 'extra-scope', 'wildcard', 'wrong-version', 'digest-change'])('v2 closed population rejects %s', mode => {
    const value = input(); value.authority.schemaVersion = 2; delete value.authority.tenantId;
    value.authority.scope = { kind: 'finite_manifest', manifestSha256: 'd'.repeat(64) };
    value.serviceEvent.authoritySha256 = hash(value.authority);
    const envelope = clone(createSignupAuditEnvelope(value));
    if (mode === 'mixed-tenant') envelope.event.population.tenantId = 'unexpected';
    if (mode === 'null-scope') envelope.event.population.scope = null;
    if (mode === 'missing-digest') delete envelope.event.population.scope.manifestSha256;
    if (mode === 'extra-scope') envelope.event.population.scope.approved = true;
    if (mode === 'wildcard') envelope.event.population.scope.kind = 'all_tenants';
    if (mode === 'wrong-version') envelope.event.schemaVersion = 1;
    if (mode === 'digest-change') {
        value.authority.scope.manifestSha256 = 'e'.repeat(64);
        invalid(() => createSignupAuditEnvelope(value)); return;
    }
    invalid(() => normaliseSignupAuditEnvelope(envelope));
});

test('immutable phase pair and exact readback reject v1/v2 substitution', () => {
    const first = input(), second = input('available', 1);
    second.authority.schemaVersion = 2; delete second.authority.tenantId;
    second.authority.scope = { kind: 'finite_manifest', manifestSha256: 'd'.repeat(64) };
    second.serviceEvent.authoritySha256 = hash(second.authority);
    const v1 = createSignupAuditEnvelope(first), v2 = createSignupAuditEnvelope(second);
    invalid(() => verifySignupAuditPhasePair(v1, v2));
    invalid(() => verifySignupAuditRow(projectSignupAuditRow(v1), v2));
});
