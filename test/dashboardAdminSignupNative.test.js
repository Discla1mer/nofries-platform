'use strict';

// These are actual native-factory pre-SQL boundary tests. A connection is a
// failure; committed persistence is qualified only by the separate PG fixture.
const { createPostgresDashboardAdministrationRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createSignupAuditEnvelope } = require('../api/shared/dashboardAdmin/signupAuditEnvelope');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { isolatedTestUrl } = require('./integration/dashboardAdminSignupPostgres');
const uid = n => '84000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = '2026-10-20T22:00:00.000Z', START = '2026-10-20T21:59:00.000Z', END = '2026-10-20T22:10:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
    const identity = { policyId: 'synthetic-native', policyRevision: 1, issuer: 'https://example.invalid/v2.0',
        identityTenantId: uid(1), oid: uid(2), audience: uid(3) };
    const actor = identity.identityTenantId + ':' + identity.oid, request = {}, state = { now: NOW };
    const capture = { requestId: uid(4), deadline: END, sessionSha256: 'a'.repeat(64), kind: 'operator_dashboard',
        identityPayload: identity, instanceId: uid(5), restoreEpoch: uid(6), issuedAt: START, expiresAt: END,
        discovery: null, operatorIssuanceProof: { schemaVersion: 1, kind: 'operator_dashboard_issuance',
            sessionSha256: 'a'.repeat(64), identitySha256: hash(identity), instanceId: uid(5), restoreEpoch: uid(6), issuedAt: START, expiresAt: END } };
    const grant = { schemaVersion: 2, capability: 'signupList', operatorSubjectKey: actor, provider: 'legacy',
        scope: { kind: 'finite_manifest', manifestSha256: 'c'.repeat(64) }, populationId: 'synthetic-population', indexId: 'synthetic-index',
        authorityRevision: 1, issuedAt: START, expiresAt: END, maxPageSize: 2, maxRows: 4, maxPages: 2,
        fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-audit' };
    const pool = { connect: jest.fn(async () => { throw new Error('SQL must not be reached'); }), end: jest.fn() };
    const options = { pool, clock: () => state.now, instanceId: uid(5), historyBudget: { maxRecords: 64, maxBytes: 1048576, maxDurationMs: 1000 },
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(5), restoreEpoch: uid(6) })), newId: () => uid(9),
        captureRequest: jest.fn(async req => req === request ? clone(capture) : null), authoriseAdministration: jest.fn(() => true) };
    const envelope = () => createSignupAuditEnvelope({ authority: grant, eventId: uid(10), nativeBinding: {
        requestId: capture.requestId, sessionSha256: capture.sessionSha256, instanceId: capture.instanceId, actorSubjectKey: actor },
    serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId: uid(11), actorSubjectKey: actor,
        authoritySha256: hash(grant), requestSha256: hash({ cursor: null }), page: 1, phase: 'attempt', outcome: 'requested', count: 0, occurredAt: NOW } });
    return { options, pool, request, capture, grant, envelope, state };
}

test.each(['validateSignupSession', 'persistSignupAudit', 'reconcileSignupAudit'])('%s defaults off even when ordinary lookup policy grants', async method => {
    const f = fixture(), repository = createPostgresDashboardAdministrationRepository(f.options);
    const args = method === 'validateSignupSession' ? [f.request, f.grant] : [f.request, f.envelope(), f.grant];
    await expect(repository[method](...args)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.options.captureRequest).not.toHaveBeenCalled();
    expect(f.options.authoriseAdministration).not.toHaveBeenCalled();
});

test.each([false, null, undefined, {}, 'true', 1])('explicit listing callback result %p fails before connection', async result => {
    const f = fixture(), policy = jest.fn(async () => result);
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options, authoriseSignupList: policy });
    await expect(repository.validateSignupSession(f.request, f.grant)).rejects.toMatchObject({ statusCode: 403 });
    expect(policy).toHaveBeenCalledTimes(1); expect(f.pool.connect).not.toHaveBeenCalled();
    expect(f.options.authoriseAdministration).not.toHaveBeenCalled();
    expect(policy.mock.calls[0][0]).toEqual({ request: f.request, capture: f.capture, authority: f.grant,
        operationType: 'administration.signup.session', at: NOW });
    expect(Object.isFrozen(policy.mock.calls[0][0].authority.scope)).toBe(true);
});

test.each(['customer', 'onboarding_discovery', 'missing-proof', 'wrong-actor', 'expired-grant', 'mixed-scope', 'unknown-field', 'wildcard'])('rejects %s before policy and SQL', async mode => {
    const f = fixture(), policy = jest.fn(async () => true);
    if (mode === 'customer') { f.capture.kind = 'customer'; f.capture.operatorIssuanceProof = null; }
    if (mode === 'onboarding_discovery') { f.capture.kind = mode; f.capture.operatorIssuanceProof = null; f.capture.discovery = { caseId: uid(20), proofId: uid(21) }; }
    if (mode === 'missing-proof') f.capture.operatorIssuanceProof = null;
    if (mode === 'wrong-actor') f.grant.operatorSubjectKey = uid(1) + ':' + uid(22);
    if (mode === 'expired-grant') f.grant.expiresAt = NOW;
    if (mode === 'mixed-scope') f.grant.tenantId = 'another-tenant';
    if (mode === 'unknown-field') f.grant.approved = true;
    if (mode === 'wildcard') f.grant.scope.kind = 'all_tenants';
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options, authoriseSignupList: policy });
    await expect(repository.validateSignupSession(f.request, f.grant)).rejects.toHaveProperty('statusCode');
    expect(policy).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
});

test('grant expiry during awaited approval withholds connection', async () => {
    const f = fixture();
    f.grant.expiresAt = '2026-10-20T22:00:00.001Z';
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options,
        authoriseSignupList: async () => { f.state.now = f.grant.expiresAt; return true; } });
    await expect(repository.validateSignupSession(f.request, f.grant)).rejects.toHaveProperty('statusCode');
    expect(f.pool.connect).not.toHaveBeenCalled();
});

test('callback mutating caller grant cannot alter already detached authority', async () => {
    const f = fixture();
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options,
        authoriseSignupList: async input => { f.grant.scope.manifestSha256 = 'f'.repeat(64);
            expect(input.authority.scope.manifestSha256).toBe('c'.repeat(64)); return false; } });
    await expect(repository.validateSignupSession(f.request, f.grant)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.pool.connect).not.toHaveBeenCalled();
});

test.each(['population', 'native-request', 'authority-hash', 'event-time'])('reconstructs %s binding before any SQL', async mode => {
    const f = fixture(), envelope = clone(f.envelope());
    if (mode === 'population') envelope.event.population.scope.manifestSha256 = 'f'.repeat(64);
    if (mode === 'native-request') envelope.event.requestId = uid(30);
    if (mode === 'authority-hash') envelope.event.serviceEvent.authoritySha256 = 'f'.repeat(64);
    if (mode === 'event-time') envelope.event.occurredAt = envelope.event.serviceEvent.occurredAt = END;
    envelope.event.serviceEventSha256 = hash(envelope.event.serviceEvent);
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options, authoriseSignupList: async () => true });
    await expect(repository.persistSignupAudit(f.request, envelope, f.grant)).rejects.toHaveProperty('statusCode');
    expect(f.pool.connect).not.toHaveBeenCalled();
});

test.each(['postgres://example.invalid/nofries_test', 'postgres://localhost/production',
    'postgres://localhost/nofries_test?ssl=true', 'postgres://localhost/nofries_test#x'])('native fixture refuses non-disposable target %s', value => {
    expect(() => isolatedTestUrl(value)).toThrow('administration_native_tests_require_isolated_database');
});
test('native fixture permits only existing explicitly configured isolated test target', () => {
    expect(isolatedTestUrl('postgres://localhost/nofries_test')).toBe('postgres://localhost/nofries_test');
});

test('authority is detached before the asynchronous capture boundary', async () => {
    const f = fixture(), original = clone(f.grant);
    f.options.captureRequest = async () => { f.grant.scope.manifestSha256 = 'f'.repeat(64); return clone(f.capture); };
    const policy = jest.fn(async input => { expect(input.authority).toEqual(original); return false; });
    const repository = createPostgresDashboardAdministrationRepository({ ...f.options, authoriseSignupList: policy });
    await expect(repository.validateSignupSession(f.request, f.grant)).rejects.toMatchObject({ statusCode: 403 });
    expect(policy).toHaveBeenCalledTimes(1); expect(f.pool.connect).not.toHaveBeenCalled();
});
