'use strict';

const mockAdministrationCallbacks = [];
jest.mock('../api/shared/appLifecycle/postgresDashboardRepository', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardRepository');
    return { ...actual, createPostgresDashboardRepository(options) {
        mockAdministrationCallbacks.push(options);
        return actual.createPostgresDashboardRepository(options);
    } };
});

const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { createHash } = require('node:crypto');
const { createPostgresDashboardAdministrationRepository, createPostgresDashboardRuntimeRepository } =
    require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { hash, projectCurrentRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { normaliseEntitlementState } = require('../api/shared/appLifecycle/entitlementDomain');
const { createAuditEnvelope } = require('../api/shared/dashboardAdmin/auditEnvelope');
const { normaliseSelector } = require('../api/shared/dashboardAdmin/service');
const { fixture, NOW, SUBJECT } = require('./fixtures/dashboardFixture');
const { isolatedTestUrl } = require('./integration/dashboardAdminPostgres');

const uid = n => '81000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));
const BEGIN = new Date(Date.parse(NOW) - 60000).toISOString();
const END = new Date(Date.parse(NOW) + 3600000).toISOString();
const COOKIE_ID = Buffer.alloc(32, 9).toString('base64url');

// Explicit synthetic I/O only. Genuine operator capture, current-record codecs,
// canonical snapshot loader, finite audit writer and transaction wrapper run.
// This double does not establish PostgreSQL RLS, constraints or lock behavior.
async function setup() {
    const state = { now: NOW, allowed: true, trace: [], audit: [], before: null, after: null, lostCommit: false };
    const policy = { policyId: 'synthetic-administration-policy', policyRevision: 1,
        issuer: 'https://login.microsoftonline.com/' + uid(1) + '/v2.0', identityTenantId: uid(1), audience: uid(2) };
    const identity = { ...policy, oid: uid(3) }, actorSubjectKey = identity.identityTenantId + ':' + identity.oid;
    const env = { NOFRIES_PUBLIC_URL: 'https://nofries.invalid', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(2),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-administration-secret', NOFRIES_ALLOWED_SUBJECTS: actorSubjectKey };
    const store = new MemoryBrowserSessionStore();
    await store.createSession(COOKIE_ID, { v: 1, kind: 'browser_session', issuedAt: Date.parse(BEGIN),
        idleExpiresAt: Date.parse(END), absoluteExpiresAt: Date.parse(END), identity: {
            provider: 'entra-bff', isAuthenticated: true, subjectKey: actorSubjectKey,
            principalId: uid(3), tenantId: uid(1), email: 'synthetic@example.invalid', name: 'Synthetic operator' } });
    const sessionSha256 = createHash('sha256').update(Buffer.from('nofries:operator-dashboard-session:v1\0')).update(Buffer.from(COOKIE_ID, 'base64url')).digest('hex');
    state.epoch = uid(5);
    state.originalProof = { schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256,
        identitySha256: hash(identity), instanceId: uid(4), restoreEpoch: state.epoch, issuedAt: BEGIN, expiresAt: END };
    const captureOptions = { browserAuthOptions: { env, store }, identityPolicy: policy,
        proofStore: { createOriginalProof: async () => {}, readOriginalProof: async () => clone(state.originalProof) },
        clock: () => state.now, readExternalRuntimeEpoch: async () => ({ instanceId: uid(4), restoreEpoch: state.epoch }),
        newRequestId: () => uid(6), requestBudgetMs: 60000 };
    const operator = createDashboardOperatorSession(captureOptions);
    const request = new IncomingMessage(new Socket());
    request.headers = { cookie: '__Host-nofries-auth=' + COOKIE_ID };
    const captured = await operator.captureRequest(request);
    state.instance = { schemaVersion: 1, instanceId: uid(4), revision: 1, restoreEpoch: state.epoch,
        ingressStatus: 'enabled', changedAt: BEGIN, evidenceRef: 'synthetic-only', evidenceSha256: 'a'.repeat(64) };
    state.gate = { schemaVersion: 1, sessionSha256, kind: 'operator_dashboard', parentSessionSha256: sessionSha256,
        operatorIssuanceSha256: hash(state.originalProof), identitySha256: hash(identity), identityPayload: identity,
        subjectKey: actorSubjectKey, status: 'active', revision: 0, selectionGeneration: 0, generationToken: 'b'.repeat(64),
        selectedBindingId: null, selectedTenantId: null, selectedOrganisationId: null, discoveryCaseId: null,
        discoveryProofId: null, issuedAt: BEGIN, expiresAt: END, restoreEpoch: state.epoch, instanceId: uid(4),
        createdAt: BEGIN, updatedAt: BEGIN, revokedAt: null };
    const f = fixture(), selector = normaliseSelector({ provider: 'legacy', subjectKey: SUBJECT, ...f.scope });
    const snapshot = { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState,
        entitlementState: f.entitlementState, flags: f.flags, advisorAssignments: [],
        usage: f.entitlementState.grants.map(dataCodec.newUsage) };
    const data = { dashboard_tenants: [snapshot.tenantAggregate.tenant], dashboard_organisations: snapshot.tenantAggregate.organisations,
        dashboard_membership_states: [snapshot.membershipState], dashboard_entitlement_states: [snapshot.entitlementState],
        dashboard_feature_flags: [snapshot.flags], dashboard_advisor_assignments: [], dashboard_usage: snapshot.usage };
    const pool = { end: jest.fn(), connect: jest.fn(async () => {
        let audit = null;
        return { release: jest.fn(), query: async (sql, params = []) => {
            state.trace.push({ sql, params: clone(params) });
            if (state.before) await state.before(sql, params);
            let result = { rows: [], rowCount: 0 };
            if (/^BEGIN/.test(sql)) audit = clone(state.audit);
            else if (sql === 'COMMIT') {
                state.audit = audit; audit = null;
                if (state.lostCommit) { state.lostCommit = false; throw new Error('synthetic lost acknowledgement'); }
            } else if (sql === 'ROLLBACK') audit = null;
            else if (/^(SET LOCAL |SELECT (set_config\(|pg_advisory_))/.test(sql)) { /* fixed controls */ }
            else if (sql.includes('FROM nofries.dashboard_runtime_instance')) result.rows = state.instance ? [projectCurrentRow('instance', clone(state.instance), { receiptId: uid(7) })] : [];
            else if (sql.includes('FROM nofries.dashboard_session_gates')) result.rows = state.gate ? [projectCurrentRow('session', clone(state.gate))] : [];
            else if (sql.includes('FROM nofries.dashboard_runtime_audit')) result.rows = audit.filter(row =>
                row.instance_id === params[0] && row.session_sha256 === params[1] && row.request_id === params[2] &&
                row.payload.lookupRequestId === params[3] && row.payload.phase === params[4]).map(clone);
            else if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit')) {
                const columns = sql.match(/\(([^)]+)\)/)[1].split(', ');
                const row = Object.fromEntries(columns.map((key, i) => [key, ['scope_json', 'payload'].includes(key) ? JSON.parse(params[i]) : params[i]]));
                audit.push(row); result.rowCount = 1;
            } else {
                const table = sql.match(/FROM nofries\.(dashboard_\w+)/)?.[1];
                if (!table || !data[table]) throw new Error('unexpected synthetic SQL');
                result.rows = data[table].filter(payload => payload.tenantId === params[0] &&
                    (table === 'dashboard_tenants' || payload.organisationId === params[1])).map(payload => ({
                    tenant_id: payload.tenantId, organisation_id: payload.organisationId, grant_id: payload.grantId,
                    schema_version: 1, revision: payload.revision, payload: clone(payload) }));
            }
            if (state.after) await state.after(sql, params, result);
            return result;
        } };
    }) };
    const config = { pool, clock: () => state.now, instanceId: uid(4), historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        readExternalRuntimeEpoch: captureOptions.readExternalRuntimeEpoch, newId: () => uid(8),
        captureRequest: jest.fn(req => operator.captureRequest(req)),
        authoriseAdministration: jest.fn(async ({ request: req, capture, selector: target }) => state.allowed && req === request &&
            capture.kind === 'operator_dashboard' && capture.identityPayload.oid === uid(3) &&
            (target === null || JSON.stringify(target) === JSON.stringify(selector))) };
    const repo = createPostgresDashboardAdministrationRepository(config);
    const event = (outcome = 'attempt') => createAuditEnvelope({ selector,
        nativeBinding: { requestId: captured.requestId, sessionSha256, instanceId: uid(4), actorSubjectKey },
        serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_read', requestId: uid(9), actorSubjectKey,
            targetSha256: createHash('sha256').update(JSON.stringify(selector)).digest('hex'), outcome, occurredAt: NOW },
        eventId: outcome === 'attempt' ? uid(10) : uid(11) });
    return { state, config, repo, selector, request, captured, snapshot, event, store, env };
}

describe('finite native administration capability', () => {
    test.each(['postgresql://example.invalid/nofries_ci', 'postgresql://localhost/nofries_production',
        'postgresql://localhost/nofries_ci?host=example.invalid', 'postgresql://127.0.0.1/nofries_ci#override',
        'https://localhost/nofries_ci', ''])('native fixture rejects unsafe control target before loading PostgreSQL: %s', value => {
        expect(() => isolatedTestUrl(value)).toThrow('administration_native_tests_require_isolated_database');
    });

    test.each(['postgresql://127.0.0.1/nofries_ci', 'postgres://localhost/nofries_test_admin', 'postgresql://[::1]/nofries_test'])('native fixture accepts isolated control target: %s', value => {
        expect(isolatedTestUrl(value)).toBe(value);
    });

    test('query host override is rejected without loading or constructing a PostgreSQL client', () => {
        const mockPgLoad = jest.fn(() => { throw new Error('PostgreSQL must not be loaded for rejected targets'); });
        try {
            jest.isolateModules(() => {
                jest.doMock('pg', mockPgLoad);
                const nativeFixture = require('./integration/dashboardAdminPostgres');
                expect(() => nativeFixture.isolatedTestUrl('postgresql://127.0.0.1/nofries_ci?host=example.invalid')).toThrow('administration_native_tests_require_isolated_database');
                expect(mockPgLoad).not.toHaveBeenCalled();
            });
        } finally { jest.dontMock('pg'); }
    });
    test('explicit closed dependencies and separate method set leave ordinary runtime API unchanged', async () => {
        const h = await setup();
        expect(Object.keys(h.repo).sort()).toEqual(['persistAudit', 'persistSignupAudit', 'readAuthoritySnapshot',
            'reconcileAudit', 'reconcileSignupAudit', 'validateSession', 'validateSignupSession']);
        for (const name of ['captureRequest', 'authoriseAdministration', 'clock', 'pool']) {
            expect(() => createPostgresDashboardAdministrationRepository({ ...h.config, [name]: undefined })).toThrow();
        }
        expect(() => createPostgresDashboardAdministrationRepository({ ...h.config, maintenance: true })).toThrow();
        const { authoriseAdministration, ...shared } = h.config;
        const runtime = createPostgresDashboardRuntimeRepository({ ...shared, readVerifiedOnboardingProof: async () => null,
            readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false, newGenerationToken: () => 'a'.repeat(64) });
        expect(runtime.validateSession).toBeUndefined();
        expect(runtime.persistAudit).toBeUndefined();
        for (const name of ['validateSignupSession', 'persistSignupAudit', 'reconcileSignupAudit']) expect(runtime[name]).toBeUndefined();
    });

    test('genuine operator capture and current gate validate with no data writes or public session audit', async () => {
        const h = await setup();
        const result = await h.repo.validateSession(h.request, h.selector);
        expect(result).toEqual({ schemaVersion: 1, state: 'ready', purpose: 'operator_dashboard', capture: h.captured });
        expect(Object.isFrozen(result.capture.identityPayload)).toBe(true);
        expect(h.state.trace[0].sql).toBe('BEGIN READ ONLY');
        expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql))).toBe(false);
        expect(h.state.audit).toEqual([]);
        expect(h.state.trace.filter(({ sql }) => sql.includes('pg_advisory_xact_lock_shared')).map(({ params }) => params[0])).toEqual([71001, 71002]);
    });

    test('canonical snapshot keeps usage and complete revisions in one fenced SHARE transaction', async () => {
        const h = await setup();
        const result = await h.repo.readAuthoritySnapshot(h.request, h.selector);
        expect(result).toEqual({ snapshot: { ...h.snapshot,
            entitlementState: normaliseEntitlementState(h.snapshot.entitlementState, h.snapshot.tenantAggregate) },
        revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: NOW });
        expect(h.state.trace.filter(({ sql }) => /^BEGIN/.test(sql))).toHaveLength(1);
        expect(h.state.trace.find(({ sql }) => sql.includes('FROM nofries.dashboard_tenants')).sql).toContain('FOR SHARE');
        expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql))).toBe(false);
        expect(h.config.authoriseAdministration.mock.calls.every(([context]) => context.request === h.request && context.selector.subjectKey === h.selector.subjectKey)).toBe(true);
        const retained = mockAdministrationCallbacks.at(-1);
        expect(retained.authoriseAdministration({ tenantId: h.selector.tenantId, organisationId: h.selector.organisationId,
            actorSubjectKey: h.captured.identityPayload.identityTenantId + ':' + h.captured.identityPayload.oid, type: 'authority.read' })).toBe(false);
        const observed = h.state.trace.length;
        await expect(retained.database.withTenantTransaction(h.selector.tenantId, async () => {})).rejects.toMatchObject({ statusCode: 403 });
        expect(h.state.trace).toHaveLength(observed);
    });

    test.each(['customer', 'onboarding_discovery', 'missing proof', 'missing gate', 'revoked gate', 'fenced ingress', 'gate proof mismatch', 'restore epoch'])('refuses %s without snapshot or audit writes', async mode => {
        const h = await setup();
        if (['customer', 'onboarding_discovery'].includes(mode)) h.config.captureRequest.mockImplementation(async () => ({ ...clone(h.captured), kind: mode,
            operatorIssuanceProof: null, discovery: mode === 'customer' ? null : { caseId: uid(20), proofId: uid(21) } }));
        if (mode === 'missing proof') h.state.originalProof = null;
        if (mode === 'missing gate') h.state.gate = null;
        if (mode === 'revoked gate') Object.assign(h.state.gate, { status: 'revoked', revision: 1, selectionGeneration: 1, updatedAt: NOW, revokedAt: NOW });
        if (mode === 'fenced ingress') h.state.instance.ingressStatus = 'fenced';
        if (mode === 'gate proof mismatch') h.state.gate.operatorIssuanceSha256 = '0'.repeat(64);
        if (mode === 'restore epoch') h.state.epoch = uid(22);
        await expect(h.repo.readAuthoritySnapshot(h.request, h.selector)).rejects.toMatchObject({ statusCode: 403 });
        expect(h.state.trace.some(({ sql }) => sql.includes('FROM nofries.dashboard_tenants') || /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    });

    test.each([false, null, {}, 'true'])('policy requires literal true: %p', async value => {
        const h = await setup(); h.config.authoriseAdministration.mockResolvedValue(value);
        await expect(h.repo.validateSession(h.request)).rejects.toMatchObject({ statusCode: 403 });
        expect(h.config.pool.connect).not.toHaveBeenCalled();
    });

    test.each(['provider', 'subjectKey', 'tenantId', 'organisationId'])('denies changed exact selector %s before database work', async key => {
        const h = await setup();
        const selector = { ...h.selector, [key]: key === 'provider' ? 'external' : key === 'subjectKey' ? uid(1) + ':' + uid(23) : 'another-scope' };
        await expect(h.repo.readAuthoritySnapshot(h.request, selector)).rejects.toMatchObject({ statusCode: 403 });
        expect(h.config.pool.connect).not.toHaveBeenCalled();
    });

    test.each(['policy', 'gate', 'proof', 'clock'])('withholds buffered snapshot after late %s change', async mode => {
        const h = await setup();
        h.state.after = async sql => {
            if (!sql.includes('FROM nofries.dashboard_usage')) return;
            if (mode === 'policy') h.state.allowed = false;
            if (mode === 'gate') Object.assign(h.state.gate, { status: 'revoked', revision: 1, selectionGeneration: 1, updatedAt: NOW, revokedAt: NOW });
            if (mode === 'proof') h.state.originalProof = null;
            if (mode === 'clock') h.state.now = new Date(Date.parse(NOW) + 60000).toISOString();
        };
        await expect(h.repo.readAuthoritySnapshot(h.request, h.selector)).rejects.toMatchObject({ statusCode: mode === 'clock' ? 503 : 403 });
        expect(h.state.trace.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    });

    test('synchronous dispatch guard can stop COMMIT after timeout preparation and no result is released', async () => {
        const h = await setup();
        const repo = createPostgresDashboardAdministrationRepository({ ...h.config, beforeQuery(sql) { if (sql === 'COMMIT') throw new Error('synthetic expired grant'); } });
        await expect(repo.readAuthoritySnapshot(h.request, h.selector)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.state.trace.some(({ sql }) => sql === 'COMMIT')).toBe(false);
        expect(h.state.trace.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    });

    test('acknowledges immutable phases after COMMIT and reconciliation performs only data SELECT', async () => {
        const h = await setup(), attempt = h.event(), terminal = h.event('found');
        await expect(h.repo.persistAudit(h.request, attempt, h.selector)).resolves.toBe(true);
        await expect(h.repo.persistAudit(h.request, terminal, h.selector, attempt)).resolves.toBe(true);
        const start = h.state.trace.length;
        await expect(h.repo.reconcileAudit(h.request, terminal, h.selector, attempt)).resolves.toBe(true);
        const trace = h.state.trace.slice(start);
        expect(trace[0].sql).toBe('BEGIN READ ONLY');
        expect(trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql))).toBe(false);
        expect(h.state.audit).toHaveLength(2);
    });

    test('uncertain COMMIT is typed ambiguous, never reinserts and exact readback does not repeat snapshot', async () => {
        const h = await setup(), attempt = h.event();
        h.state.lostCommit = true;
        await expect(h.repo.persistAudit(h.request, attempt, h.selector)).rejects.toMatchObject({ code: 'onboarding_outcome_ambiguous', statusCode: 503 });
        expect(h.state.audit).toHaveLength(1);
        const start = h.state.trace.length;
        await expect(h.repo.reconcileAudit(h.request, attempt, h.selector)).resolves.toBe(true);
        expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql) || sql.includes('FROM nofries.dashboard_tenants'))).toBe(false);
    });

    test.each(['native request', 'actor', 'scope', 'target digest'])('rejects mismatched audit %s before INSERT', async mode => {
        const h = await setup(), envelope = clone(h.event());
        if (mode === 'native request') envelope.event.requestId = uid(24);
        if (mode === 'actor') envelope.event.actorSubjectKey = uid(1) + ':' + uid(25);
        if (mode === 'scope') envelope.event.scope.organisationId = 'another-scope';
        if (mode === 'target digest') envelope.event.targetSha256 = '0'.repeat(64);
        await expect(h.repo.persistAudit(h.request, envelope, h.selector)).rejects.toMatchObject({ statusCode: 403 });
        expect(h.config.pool.connect).not.toHaveBeenCalled();
    });
});
