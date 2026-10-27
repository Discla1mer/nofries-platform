'use strict';

// Controlled I/O proves the private capability/ordering/error contract here.
// PostgreSQL locking, rollback, RLS and JSONB guarantees are exercised separately
// by the registered runtime integration suite with its real restricted LOGIN.
// Causal delegates retain the actual transaction helper, error classes and
// permission evaluator. Only the selected regression arms its trusted clock.
let mockAfterWork = null, mockAfterAccess = null;
let mockAfterHostDecision = null, mockHostDataAfterWork = null;
jest.mock('../api/shared/database/postgres', () => {
    const actual = jest.requireActual('../api/shared/database/postgres');
    return { ...actual, createPostgresDatabase(options) {
        const database = actual.createPostgresDatabase(options);
        return Object.freeze({ ...database, withTenantTransaction(tenantId, work) {
            const afterWork = mockAfterWork;
            if (!afterWork) return database.withTenantTransaction(tenantId, work);
            return database.withTenantTransaction(tenantId, async tx => {
                const value = await work(tx);
                afterWork();
                return value;
            });
        } });
    } };
});
jest.mock('../api/shared/appLifecycle/dashboardResourceAuthority', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/dashboardResourceAuthority');
    return { ...actual, resolveNcscAccess(...args) {
        const decision = actual.resolveNcscAccess(...args);
        if (mockAfterAccess) mockAfterAccess();
        return decision;
    } };
});
jest.mock('../api/shared/dashboardAdmission', () => {
    const actual = jest.requireActual('../api/shared/dashboardAdmission');
    return { ...actual, createDashboardAdmissionDecision(adapters) {
        const decide = actual.createDashboardAdmissionDecision(adapters);
        return async (...args) => {
            const value = await decide(...args);
            if (mockAfterHostDecision) await mockAfterHostDecision(value);
            return value;
        };
    } };
});
jest.mock('../api/shared/appLifecycle/postgresDashboardRepository', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardRepository');
    return { ...actual, createPostgresDashboardRepository(options) {
        const after = mockHostDataAfterWork;
        if (!after) return actual.createPostgresDashboardRepository(options);
        return actual.createPostgresDashboardRepository({ ...options, database: {
            ...options.database, withTenantTransaction(tenantId, work) {
                return options.database.withTenantTransaction(tenantId, async tx => {
                    const value = await work(tx);
                    await after(tx, value);
                    return value;
                });
            }
        } });
    } };
});
afterEach(() => { mockAfterWork = null; mockAfterAccess = null;
    mockAfterHostDecision = null; mockHostDataAfterWork = null; });
const crypto = require('node:crypto');
const domain = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { NcscAssessmentError } = require('../api/shared/ncscAssessmentService');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { PostgresDatabaseError } = require('../api/shared/database/postgres');
const { DashboardAuditError } = require('../api/shared/appLifecycle/dashboardAudit');
const { ncscFixture, SUBJECT, createNcscAdapters } = require('./fixtures/ncscAssessmentFixture');
const { createNcscSubmissionQuotaResolver } = require('../lib/ncscSubmissionPolicy');

jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage,
        loadSnapshotForShare: jest.fn(), loadSnapshotForUpdate: jest.fn() } };
});
const { DashboardPersistenceError, dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const NOW = '2026-09-07T09:00:00.000Z';
const START = '2026-09-07T08:00:00.000Z';
const END = '2026-09-07T10:00:00.000Z';
const BUDGET = Object.freeze({ maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 });
const uuid = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
        : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const snake = key => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
const factory = options => require('../api/shared/database/dashboardRequestDatabase').createDashboardRequestDatabase(options);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function caught(work) { try { return Promise.resolve(work()).then(value => ({ value }), error => ({ error })); } catch (error) { return Promise.resolve({ error }); } }
async function expectFailure(work, Type, code, statusCode) {
    const { error } = await caught(work);
    expect(error).toBeInstanceOf(Type);
    expect(error).toMatchObject({ code: Type === DashboardPersistenceError ? 'dashboard_' + code : code, statusCode });
    expect(error.message).not.toMatch(/driver-private|credential|secret/);
    return error;
}
function frozen(value) {
    if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); for (const child of Object.values(value)) frozen(child); }
}

function authorityFixture(options = {}) {
    const fixtureUuid = n => uuid(n + (options.idOffset || 0));
    const example = ncscFixture({ ...options, now: NOW, tenantId: options.tenantId || 'request-guard-tenant', organisationId: options.organisationId || 'request-guard-org', capacity: 3 });
    if (options.membershipEndsAt) {
        example.state.membershipState.memberships[0].validUntil = options.membershipEndsAt;
        example.state.membershipState.invitations[0].validUntil = options.membershipEndsAt;
        example.state.membershipState.invitations[0].expiresAt = options.membershipEndsAt;
    }
    if (options.assignmentEndsAt) example.state.advisorAssignments.forEach(a => { a.validUntil = options.assignmentEndsAt; });
    const identity = { policyId: 'synthetic-runtime-policy', policyRevision: 1,
        issuer: 'https://identity.example.test/runtime/v2.0', identityTenantId: SUBJECT.split(':')[0], oid: SUBJECT.split(':')[1],
        audience: 'synthetic-runtime-client' };
    const member = example.state.membershipState.memberships[0];
    const approved = { schemaVersion: 1, operationType: 'publish_existing_membership', bindingId: fixtureUuid(3), scope: clone(example.scope),
        membershipId: member.membershipId, invitationId: member.invitationId, grantEvidenceId: member.grantEvidenceId,
        identity, validFrom: member.validFrom, validUntil: member.validUntil };
    const admission = domain.applyAdmissionCommand({ predecessor: null, command: { schemaVersion: 1,
        operationType: 'publishAdmissionDecision', operationId: fixtureUuid(4), actorSubjectKey: SUBJECT, authorityId: fixtureUuid(5),
        expectedRevision: null, expectedHeadSha256: null, payload: { target: example.scope,
            identityPolicyRef: { policyId: identity.policyId, policyRevision: identity.policyRevision }, approvedEffectSha256: hash(approved),
            evidenceRefs: [{ kind: 'approval', id: 'synthetic-approval', sha256: '1'.repeat(64) }], validFrom: START, validUntil: options.admissionEndsAt || END } },
        facts: { occurredAt: START } }).record;
    const { schemaVersion, operationType, ...approvedFields } = approved;
    const binding = domain.publishExistingMembershipBinding({ ...approvedFields, receiptId: fixtureUuid(6), operationId: fixtureUuid(7),
        authorityRef: { authorityId: admission.authorityId, revision: admission.revision, sha256: admission.decisionSha256 },
        actorSubjectKey: SUBJECT, at: START, currentAuthority: example.state }).binding;
    const seed = { identityPayload: identity, instanceId: fixtureUuid(1), restoreEpoch: fixtureUuid(2), issuedAt: START, expiresAt: options.sessionEndsAt || END };
    const session = domain.applySessionCommand({ predecessor: null, command: { schemaVersion: 1, operationType: 'activateCustomerSession',
        operationId: fixtureUuid(8), sessionSha256: '2'.repeat(64), actorSubjectKey: SUBJECT, payload: { seed, bindingId: binding.bindingId } },
        facts: { occurredAt: NOW, generationToken: '3'.repeat(64), binding } }).record;
    const instance = { schemaVersion: 1, instanceId: seed.instanceId, revision: 1, restoreEpoch: seed.restoreEpoch,
        ingressStatus: 'enabled', changedAt: START, evidenceRef: 'synthetic-instance-approval', evidenceSha256: '4'.repeat(64) };
    const rows = {
        instance: { instance_id: instance.instanceId, revision: instance.revision, restore_epoch: instance.restoreEpoch,
            ingress_status: instance.ingressStatus, changed_at: instance.changedAt, evidence_ref: instance.evidenceRef,
            evidence_sha256: instance.evidenceSha256, record_sha256: hash(instance), head_receipt_id: fixtureUuid(9) },
        session: Object.fromEntries(Object.entries(session).filter(([key]) => key !== 'schemaVersion').map(([key, value]) => [snake(key), clone(value)])),
        binding: { ...Object.fromEntries(Object.entries(binding).filter(([key]) => !['schemaVersion', 'scope', 'identity', 'origin', 'authorityRef'].includes(key))
            .map(([key, value]) => [snake(key), clone(value)])), tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            identity_payload: clone(identity), binding_origin: binding.origin, authority_id: admission.authorityId,
            authority_revision: admission.revision, authority_sha256: admission.decisionSha256 },
        head: { authority_id: admission.authorityId, tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            head_revision: admission.revision, head_sha256: admission.decisionSha256, status: admission.payload.decision, updated_at: admission.payload.occurredAt },
        admission: { authority_id: admission.authorityId, revision: admission.revision, tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            parent_revision: admission.parentRevision, parent_sha256: admission.parentSha256, decision_sha256: admission.decisionSha256,
            occurred_at: admission.payload.occurredAt, actor_subject_key: admission.payload.actorSubjectKey, payload: clone(admission.payload) }
    };
    const snapshot = { ...clone(example.state), usage: example.state.entitlementState.grants.filter(grant => Object.keys(grant.limits).length)
        .map(grant => ({ schemaVersion: 1, ...example.scope, grantId: grant.grantId, revision: 0,
            counters: Object.fromEntries(Object.keys(grant.limits).map(key => [key, 0])) })) };
    return { example, identity, member, binding, admission, session, instance, rows, snapshot };
}

function harness(fixtureOptions = {}) {
    const f = authorityFixture(fixtureOptions), requests = new WeakMap(); let sequence = 100;
    const state = { at: NOW, trace: [], hook: null, released: 0, releaseDiscards: [], borrows: 0, externalEpoch: f.instance.restoreEpoch, auditRows: new Map() };
    dataStorage.loadSnapshotForShare.mockReset().mockImplementation(async () => clone(f.snapshot));
    dataStorage.loadSnapshotForUpdate.mockReset().mockImplementation(async () => clone(f.snapshot));
    async function answer(sql, params) {
        if (sql === 'SELECT controlled_pending') return { rows: [{ value: 1 }] };
        if (sql === 'SET LOCAL statement_timeout = 0' && params.length === 0) return { rows: [] };
        if (/^(BEGIN|COMMIT|ROLLBACK)(?:\s|$)/i.test(sql) || /^SET LOCAL ROLE (?:nofries_runtime|nofries_dashboard_subject_reader)\b/i.test(sql)
            || /SELECT[\s\S]*(?:set_config|pg_advisory_xact_lock)/i.test(sql)) return { rows: [] };
        const fixed = [['dashboard_runtime_instance', 'instance'], ['dashboard_session_gates', 'session'],
            ['dashboard_identity_bindings', 'binding'], ['dashboard_admission_authorities', 'head'], ['dashboard_admission_decisions', 'admission']];
        for (const [table, key] of fixed) if (new RegExp('FROM nofries\\.' + table + '\\b', 'i').test(sql)) {
            const row = key === 'admission' && f.rows.admissionHistory ? f.rows.admissionHistory[params[1]] : f.rows[key];
            return { rows: row ? [clone(row)] : [] };
        }
        if (/FROM nofries\.dashboard_ncsc_assessments\b/i.test(sql)) return { rows: [] };
        if (/FROM nofries\.dashboard_starter_scopes\b/i.test(sql)) return { rows: [] };
        if (/SELECT octet_length\(\$1::jsonb::text\) AS payload_bytes/i.test(sql)) return { rows: [{ payload_bytes: 1024 }] }; // Synthetic result, not JSONB measurement.
        if (/FROM nofries\.dashboard_runtime_audit\b/i.test(sql)) return { rows: state.auditRows.has(params[0]) ? [clone(state.auditRows.get(params[0]))] : [] };
        if (/INSERT INTO nofries\.dashboard_runtime_audit\b/i.test(sql)) {
            const columns = /dashboard_runtime_audit\s*\(([^)]+)\)/i.exec(sql)[1].split(',').map(value => value.trim());
            const row = Object.fromEntries(columns.map((column, index) => [column, ['payload', 'scope_json'].includes(column) ? JSON.parse(params[index]) : params[index]]));
            state.auditRows.set(row.event_id, row); return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected SQL in fixed unit driver: ' + sql);
    }
    const pool = { end: jest.fn(), connect: jest.fn(async () => {
        state.borrows++; let released = false;
        return { query: async (sql, params = []) => {
            const event = { sql, params: clone(params), phase: 'before' }; state.trace.push(event);
            if (state.hook) await state.hook(event);
            const result = await answer(sql, params);
            if (state.hook) await state.hook({ ...event, phase: 'after', result });
            return result;
        }, release: discard => { expect(released).toBe(false); released = true; state.released++; state.releaseDiscards.push(discard); } };
    }) };
    const quota = createNcscAdapters({ now: () => state.at });
    const options = { pool, clock: jest.fn(() => state.at), instanceId: f.instance.instanceId, historyBudget: { ...BUDGET },
        captureRequest: jest.fn(async request => requests.has(request) ? clone(requests.get(request)) : null),
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: f.instance.instanceId, restoreEpoch: state.externalEpoch })),
        newId: jest.fn(() => uuid(++sequence)), resolveSubmissionQuota: jest.fn(quota.resolveSubmissionQuota) };
    function request(overrides = {}) {
        const original = {};
        requests.set(original, { requestId: uuid(++sequence), deadline: '2026-09-07T09:01:00.000Z', sessionSha256: f.session.sessionSha256,
            kind: 'customer', identityPayload: clone(f.identity), instanceId: f.instance.instanceId, restoreEpoch: f.instance.restoreEpoch,
            issuedAt: START, expiresAt: f.session.expiresAt, operatorIssuanceProof: null, discovery: null, ...overrides });
        return original;
    }
    const binder = () => factory(options);
    const bind = (original = request()) => binder().bindRequest(original, { expectedGeneration: f.session.generationToken });
    async function context(binding) {
        return createTenantRequestContext({ authenticate: async () => binding.identity, resolveScope: async () => binding.scope,
            clock: () => binding.resolvedAt, createRequestId: () => binding.requestId }).resolve({});
    }
    return { ...f, state, options, pool, requests, request, binder, bind, context };
}

describe('read-only portfolio request authority', () => {
    const { ImprovementActionListError } = require('../api/shared/improvementPlan/improvementActionListProjection');
    function portfolioHarness(options = {}) {
        const f = harness(options), second = authorityFixture({ ...options, tenantId: 'portfolio-second-tenant',
            organisationId: 'portfolio-second-org', idOffset: 1000 });
        f.options.improvementEnabled = true;
        const clients = [f, second];
        for (const client of clients) {
            client.snapshot.entitlementState.grants.find(g => g.grantId === 'synthetic-product').modules.push('improvement_plan');
            client.snapshot.entitlementState.grants.forEach(g => g.modules.sort());
            for (const assignment of client.snapshot.advisorAssignments) {
                assignment.modules = ['improvement_plan']; assignment.permissions = ['improvement.read'];
            }
        }
        const snapshot = async (_, target) => {
            const found = clients.find(client => client.example.scope.tenantId === target.tenantId && client.example.scope.organisationId === target.organisationId);
            if (!found) throw new Error('unexpected tenant');
            return clone(found.snapshot);
        };
        dataStorage.loadSnapshotForShare.mockImplementation(snapshot);
        dataStorage.loadSnapshotForUpdate.mockImplementation(snapshot);
        f.state.hook = async event => {
            if (event.phase === 'after') {
                if (event.sql.startsWith('SELECT binding_id, organisation_label, tenant_id')) {
                    event.result.rows = clients.filter(client => !event.params[2] || client.binding.bindingId > event.params[2])
                        .slice(0, event.params[3]).map(client => ({ binding_id: client.binding.bindingId,
                            organisation_label: client.binding.organisationLabel, ...Object.fromEntries(['tenant_id', 'organisation_id', 'identity_sha256', 'subject_key']
                                .map(key => [key, client.rows.binding[key]])) }));
                } else {
                    const tables = [['dashboard_identity_bindings', 'binding', 'bindingId'],
                        ['dashboard_admission_authorities', 'head', 'authorityId'], ['dashboard_admission_decisions', 'admission', 'authorityId']];
                    for (const [table, key, identifier] of tables) if (event.sql.includes('FROM nofries.' + table)) {
                        const found = clients.find(client => (identifier === 'bindingId' ? client.binding.bindingId : client.admission.authorityId) === event.params[0]);
                        event.result.rows = found && found.rows[key] ? [clone(found.rows[key])] : [];
                    }
                }
            }
            if (f.state.queueHook) await f.state.queueHook(event);
        };
        const binder = f.binder();
        const bindPortfolio = (request = f.request()) => binder.bindPortfolioRequest(request, { expectedGeneration: f.session.generationToken });
        return { ...f, second, clients, binder, bindPortfolio };
    }
    async function readTarget(f, portfolio, bindingId, work = async () => 'retained-action') {
        const binding = await portfolio.bindTarget(bindingId), context = await f.context(binding);
        const pair = binding.createOperation('improvement.list', context);
        try { return await pair.database.withTenantTransaction(binding.scope.tenantId, tx => work(pair, tx, context)); }
        finally { pair.finish(); }
    }
    test('reads two independently authorised tenants without changing selected binding or generation', async () => {
        const f = portfolioHarness(), original = clone(f.rows.session), portfolio = await f.bindPortfolio();
        const page = await portfolio.listBindings({ afterBindingId: null, limit: 10 });
        expect(page.bindings.map(row => row.bindingId)).toEqual(f.clients.map(client => client.binding.bindingId));
        expect(page.bindings.every(row => Object.keys(row).sort().join(',') === 'bindingId,organisationLabel')).toBe(true);
        for (const target of page.bindings) {
            await expect(readTarget(f, portfolio, target.bindingId, async (pair, tx, context) => {
                await tx.query('SELECT controlled_pending');
                const event = pair.audit.createEvent(context, { action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
                await pair.audit.writeEvent(event);
                return context.scope.organisationId;
            })).resolves.toBe(f.clients.find(client => client.binding.bindingId === target.bindingId).example.scope.organisationId);
        }
        await portfolio.finish();
        expect(f.rows.session).toEqual(original);
        expect([...f.state.auditRows.values()].map(row => row.organisation_id)).toEqual(f.clients.map(client => client.example.scope.organisationId));
        expect(f.state.trace.some(row => /UPDATE nofries\.dashboard_session_gates/.test(row.sql))).toBe(false);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test('refuses unenumerated targets, substituted contexts and every write operation', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        await expect(portfolio.bindTarget(f.second.binding.bindingId)).rejects.toMatchObject({ code: 'improvement_list_access_denied' });
        await portfolio.listBindings({ afterBindingId: null, limit: 10 });
        const first = await portfolio.bindTarget(f.binding.bindingId), second = await portfolio.bindTarget(f.second.binding.bindingId);
        const firstContext = await f.context(first), secondContext = await f.context(second);
        expect(() => second.createOperation('improvement.list', firstContext)).toThrow(ImprovementActionListError);
        expect(() => second.createOperation('improvement.execute', secondContext)).toThrow();
        await expect(readTarget(f, portfolio, f.second.binding.bindingId, (_, tx) => tx.query('DELETE FROM nofries.dashboard_improvement_heads')))
            .rejects.toMatchObject({ code: 'improvement_list_unavailable' });
        expect(f.state.trace.some(row => row.sql.startsWith('DELETE'))).toBe(false);
        await portfolio.finish();
    });
    test('rechecks earlier successful targets before aggregate disclosure and withholds a revoked result', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 10 });
        await readTarget(f, portfolio, f.binding.bindingId);
        await readTarget(f, portfolio, f.second.binding.bindingId);
        f.snapshot.flags.enabled.improvement_plan = false;
        await expect(portfolio.finish()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
        await expect(portfolio.listBindings({ afterBindingId: null, limit: 1 })).rejects.toMatchObject({ code: 'improvement_list_unavailable' });
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['binding', 'admission', 'membership', 'entitlement'])('independently rejects a target with revoked %s', async kind => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 10 });
        if (kind === 'binding') f.second.rows.binding = null;
        if (kind === 'admission') f.second.rows.head = null;
        if (kind === 'membership') f.second.snapshot.membershipState.memberships[0].status = 'revoked';
        if (kind === 'entitlement') f.second.snapshot.flags.enabled.improvement_plan = false;
        await expect(readTarget(f, portfolio, f.second.binding.bindingId)).rejects.toMatchObject({ code: 'improvement_list_access_denied' });
        await expect(readTarget(f, portfolio, f.binding.bindingId)).resolves.toBe('retained-action');
        await portfolio.finish();
    });
    test('rejects a directory result from another subject before minting target authority', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        f.state.queueHook = event => {
            if (event.phase === 'after' && event.sql.startsWith('SELECT binding_id, organisation_label, tenant_id')) event.result.rows[0].subject_key = 'foreign-subject';
        };
        await expect(portfolio.listBindings({ afterBindingId: null, limit: 10 })).rejects.toMatchObject({ code: 'improvement_list_unavailable' });
    });
    test('pins request mode and rejects reuse as selected-organisation authority', async () => {
        const f = portfolioHarness(), request = f.request(), portfolio = await f.bindPortfolio(request);
        expect(await f.bindPortfolio(request)).toBe(portfolio);
        await expect(f.binder.bindRequest(request, { expectedGeneration: f.session.generationToken })).rejects.toMatchObject({ code: 'dashboard_access_denied' });
        await portfolio.finish();
    });
    test('withholds the aggregate when the parent generation changes between target reads and finish', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 1 });
        await readTarget(f, portfolio, f.binding.bindingId);
        f.rows.session.generation_token = '9'.repeat(64);
        await expect(portfolio.finish()).rejects.toMatchObject({ code: 'improvement_list_access_denied' });
    });
    test('retains target expiry checks after final COMMIT settles', async () => {
        const cutoff = '2026-09-07T09:00:01.000Z';
        const f = portfolioHarness({ grantEndsAt: cutoff }), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 1 });
        await readTarget(f, portfolio, f.binding.bindingId);
        f.state.queueHook = event => { if (event.phase === 'after' && event.sql === 'COMMIT') f.state.at = cutoff; };
        await expect(portfolio.finish()).rejects.toMatchObject({ code: 'improvement_list_access_denied' });
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['target', 'deadline'])('rechecks %s expiry in the caller continuation after finish resolves', async boundary => {
        const cutoff = '2026-09-07T09:00:01.000Z';
        const f = portfolioHarness(boundary === 'target' ? { grantEndsAt: cutoff } : {}), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 1 });
        await readTarget(f, portfolio, f.binding.bindingId);
        await portfolio.finish();
        expect(portfolio.assertDisclosure()).toBe(NOW);
        f.state.at = boundary === 'target' ? cutoff : '2026-09-07T09:01:00.000Z';
        expect(() => portfolio.assertDisclosure()).toThrow(ImprovementActionListError);
        try { portfolio.assertDisclosure(); } catch (error) {
            expect(error.code).toBe(boundary === 'target' ? 'improvement_list_access_denied' : 'improvement_list_unavailable');
        }
        f.state.at = NOW;
        expect(() => portfolio.assertDisclosure()).toThrow(ImprovementActionListError);
    });
    test('takes final shared-client SHARE locks in scope order without upgrading or changing action-read locks', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        await portfolio.listBindings({ afterBindingId: null, limit: 10 });
        await readTarget(f, portfolio, f.binding.bindingId);
        await readTarget(f, portfolio, f.second.binding.bindingId);
        const actionUpdateReads = dataStorage.loadSnapshotForUpdate.mock.calls.length;
        expect(actionUpdateReads).toBeGreaterThan(0);
        dataStorage.loadSnapshotForShare.mockClear();
        await portfolio.finish();
        expect(dataStorage.loadSnapshotForShare.mock.calls.map(([, target]) => target.tenantId))
            .toEqual([f.second.example.scope.tenantId, f.example.scope.tenantId]);
        expect(dataStorage.loadSnapshotForUpdate).toHaveBeenCalledTimes(actionUpdateReads);
        expect(portfolio.assertDisclosure()).toBe(NOW);
    });
    test('supports bounded directory continuation and rejects malformed bounds', async () => {
        const f = portfolioHarness(), portfolio = await f.bindPortfolio();
        for (const limit of [0, 11, 1.5]) await expect(portfolio.listBindings({ afterBindingId: null, limit })).rejects.toMatchObject({ statusCode: 400 });
        const first = await portfolio.listBindings({ afterBindingId: null, limit: 1 });
        expect(first.nextAfterBindingId).toBe(f.binding.bindingId);
        const second = await portfolio.listBindings({ afterBindingId: first.nextAfterBindingId, limit: 1 });
        expect(second.bindings).toEqual([{ bindingId: f.second.binding.bindingId, organisationLabel: f.second.binding.organisationLabel }]);
        expect(second.nextAfterBindingId).toBeNull();
        await portfolio.finish();
    });
});

describe('Dashboard request database closed trusted composition', () => {
    test('exports only the binding factory and rejects extra capabilities before any dependency is called', () => {
        const f = harness();
        expect(Object.keys(require('../api/shared/database/dashboardRequestDatabase'))).toEqual(['createDashboardRequestDatabase']);
        expect(Object.keys(f.binder())).toEqual(['bindRequest', 'handleHostResource', 'bindPortfolioRequest']);
        expect(() => factory({ ...f.options, database: {} })).toThrow(DashboardPersistenceError);
        expect(f.options.clock).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['pool', 'clock', 'instanceId', 'historyBudget', 'captureRequest', 'readExternalRuntimeEpoch', 'newId', 'resolveSubmissionQuota'])
    ('requires explicit %s with no permissive default', async key => {
        const f = harness(), options = { ...f.options }; delete options[key];
        await expectFailure(() => factory(options), DashboardPersistenceError, 'dependencies_invalid', 400);
        expect(f.options.clock).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each([{}, { ...BUDGET, maxRecords: 0 }, { ...BUDGET, maxRecords: 4097 }, { ...BUDGET, maxBytes: 67108865 },
        { ...BUDGET, maxDurationMs: 60001 }, { ...BUDGET, maxBytes: 1.5 }, { ...BUDGET, reset: true }])
    ('rejects an invalid explicit budget before I/O: %j', async historyBudget => {
        const f = harness(); await expectFailure(() => factory({ ...f.options, historyBudget }), DashboardPersistenceError, 'dependencies_invalid', 400);
        expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['getter', 'proxy', 'symbol'])('does not invoke hostile %s configuration hooks', async kind => {
        const f = harness(); let hooks = 0, options = { ...f.options };
        if (kind === 'getter') Object.defineProperty(options, 'clock', { enumerable: true, get() { hooks++; return f.options.clock; } });
        if (kind === 'proxy') options = new Proxy(options, { ownKeys() { hooks++; return []; } });
        if (kind === 'symbol') options[Symbol('unexpected')] = true;
        await expectFailure(() => factory(options), DashboardPersistenceError, 'dependencies_invalid', 400);
        expect(hooks).toBe(0); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each([{}, { expectedGeneration: null }, { expectedGeneration: '3'.repeat(63) }, { expectedGeneration: 'A'.repeat(64) },
        { expectedGeneration: 3 }, { expectedGeneration: '3'.repeat(64), tenantId: 'caller-selected' }])
    ('rejects missing or malformed generation without capturing a request: %j', async selector => {
        const f = harness(); await expectFailure(() => f.binder().bindRequest(f.request(), selector), DashboardPersistenceError, 'access_denied', 403);
        expect(f.options.captureRequest).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each([['null', 'access_denied', 403], ['throw', 'unavailable', 503], ['rejection', 'unavailable', 503]])
    ('classifies %s capture without exposing provider details', async (kind, code, status) => {
        const f = harness(); f.options.captureRequest = jest.fn(kind === 'null' ? async () => null
            : kind === 'throw' ? () => { throw new Error('driver-private credential'); } : async () => { throw new Error('driver-private credential'); });
        await expectFailure(() => f.bind(), DashboardPersistenceError, code, status); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['malformed', 'overflow'])('treats %s invocation clock as unavailable, not caller input', async kind => {
        const f = harness(); f.state.at = kind === 'malformed' ? 'not-an-instant' : '9999-12-31T23:59:59.999Z';
        await expectFailure(() => f.bind(), DashboardPersistenceError, 'unavailable', 503); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test('caches the first synchronous clock failure on the original request and cannot restart its budget', async () => {
        const f = harness(), original = f.request(), binder = f.binder(), selector = { expectedGeneration: f.session.generationToken };
        f.state.at = 'invalid-clock'; const first = binder.bindRequest(original, selector);
        f.state.at = NOW; const second = binder.bindRequest(original, selector);
        expect(second).toBe(first); await expectFailure(() => first, DashboardPersistenceError, 'unavailable', 503);
        expect(f.options.clock).toHaveBeenCalledTimes(1); expect(f.options.captureRequest).not.toHaveBeenCalled();
        expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test('coalesces the original request before a pending capture and cannot replace its generation', async () => {
        const f = harness(), hold = deferred(), entered = deferred(), original = f.request(), read = f.options.captureRequest;
        let first = true; f.options.captureRequest = jest.fn(async request => { if (first) { first = false; entered.resolve(); await hold.promise; } return read(request); });
        const binder = f.binder(), selector = { expectedGeneration: f.session.generationToken };
        const one = binder.bindRequest(original, selector), two = binder.bindRequest(original, selector);
        expect(two).toBe(one); await entered.promise;
        await expectFailure(() => binder.bindRequest(original, { expectedGeneration: 'f'.repeat(64) }), DashboardPersistenceError, 'access_denied', 403);
        expect(f.options.captureRequest).toHaveBeenCalledTimes(1); expect(f.pool.connect).not.toHaveBeenCalled();
        hold.resolve(); const binding = await one;
        expect(await two).toBe(binding); expect(binding.scope).toEqual(f.example.scope); frozen(binding);
        expect(Object.keys(binding).sort()).toEqual(['requestId', 'identity', 'scope', 'resolvedAt', 'createOperation'].sort());
        expect(binding.identity).toEqual({ authenticated: true, subjectKey: SUBJECT });
        expect(f.state.borrows).toBe(f.state.released);
    });
});

describe('Dashboard request operation ownership and paired audit', () => {
    test('reserves its closed operation pair before SQL and allows sequential owners only after finish', async () => {
        const f = harness(), binding = await f.bind(), before = f.state.borrows;
        await expectFailure(() => binding.createOperation('host.resource'), DashboardPersistenceError, 'unavailable', 503);
        const pair = binding.createOperation('admission.read');
        expect(Object.keys(pair).sort()).toEqual(['database', 'audit', 'clock', 'resolveSubmissionQuota', 'finish'].sort());
        expect(Object.keys(pair.database)).toEqual(['withTenantTransaction']);
        expect(Object.keys(pair.audit).sort()).toEqual(['createEvent', 'writeEvent']);
        await expectFailure(() => binding.createOperation('ncsc.read'), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.borrows).toBe(before);
        expect(await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => 'settled')).toBe('settled');
        pair.finish();
        const next = binding.createOperation('ncsc.read');
        await expectFailure(() => pair.clock(), DashboardPersistenceError, 'unavailable', 503);
        expect(await next.database.withTenantTransaction(f.example.scope.tenantId, async () => 'next')).toBe('next'); next.finish();
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['arbitrary.query', '', null])('cannot acquire an undeclared operation %j', async operation => {
        const f = harness(), binding = await f.bind(), before = f.state.borrows;
        await expectFailure(() => binding.createOperation(operation), DashboardPersistenceError, 'unavailable', 503);
        expect(f.state.borrows).toBe(before);
    });
    test('pending finish neither releases a client nor transfers the owner while a query settles', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.read'), hold = deferred(), entered = deferred();
        const released = f.state.released;
        f.state.hook = async event => { if (event.phase === 'before' && event.sql === 'SELECT controlled_pending') { entered.resolve(); await hold.promise; } };
        const pending = caught(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async tx => tx.query('SELECT controlled_pending')));
        await entered.promise;
        await expectFailure(() => pair.finish(), NcscAssessmentError, 'ncsc_unavailable', 503);
        await expectFailure(() => binding.createOperation('ncsc.list'), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.released).toBe(released);
        hold.resolve(); const outcome = await pending; expect(outcome.value).toEqual({ rows: [{ value: 1 }] });
        expect(f.state.released).toBe(released + 1); pair.finish();
        const next = binding.createOperation('ncsc.list'); next.finish();
    });
    test('deadline exhaustion waits for a pending provider before rollback and client release', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('admission.read'), hold = deferred(), entered = deferred();
        let armed = true;
        f.options.captureRequest.mockImplementation(async request => { if (armed) { armed = false; entered.resolve(); await hold.promise; } return clone(f.requests.get(request)); });
        const before = f.state.released, pending = caught(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => true));
        await entered.promise; f.state.at = '2026-09-07T09:01:00.000Z';
        await expectFailure(() => pair.finish(), DashboardPersistenceError, 'unavailable', 503);
        expect(f.state.released).toBe(before); hold.resolve();
        const result = await pending; expect(result.error).toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 });
        pair.finish(); expect(f.state.borrows).toBe(f.state.released);
    });
    test('uses one active connection for authentic repeated audit delivery and rejects a copied envelope', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), pair = binding.createOperation('ncsc.read');
        const before = f.state.borrows;
        await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            const event = pair.audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
            await expectFailure(() => pair.audit.writeEvent(clone(event)), NcscAssessmentError, 'ncsc_unavailable', 503);
            expect(await pair.audit.writeEvent(event)).toEqual({ eventId: event.eventId, delivery: 'acknowledged' });
            expect(await pair.audit.writeEvent(event)).toEqual({ eventId: event.eventId, delivery: 'acknowledged' });
            expect(f.state.borrows).toBe(before + 1);
        });
        pair.finish();
        expect(f.state.auditRows.size).toBe(1);
        expect(f.state.trace.filter(event => /INSERT INTO nofries\.dashboard_runtime_audit/.test(event.sql))).toHaveLength(1);
        const row = [...f.state.auditRows.values()][0];
        expect(row.operation_id).toBeNull();
        expect(row.event_sha256).toBe(hash({ sessionSha256: f.session.sessionSha256, instanceId: f.instance.instanceId,
            authorityId: f.admission.authorityId, event: row.payload }));
        expect(row.payload).toMatchObject({ requestId: binding.requestId, ...f.example.scope, actorSubjectKey: SUBJECT });
    });
    test('an event or sink from a finished operation cannot attach to a later active owner', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), first = binding.createOperation('ncsc.read'); let event;
        await first.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            event = first.audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
        }); first.finish();
        const second = binding.createOperation('ncsc.read'), before = f.state.auditRows.size;
        await second.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            await expectFailure(() => first.audit.writeEvent(event), NcscAssessmentError, 'ncsc_unavailable', 503);
            await expectFailure(() => second.audit.writeEvent(event), NcscAssessmentError, 'ncsc_unavailable', 503);
        }); second.finish(); expect(f.state.auditRows.size).toBe(before);
    });
    test('a sink outside its transaction cannot borrow a connection', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), pair = binding.createOperation('ncsc.read');
        let event;
        await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            event = pair.audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
        });
        const before = f.state.borrows;
        await expectFailure(() => pair.audit.writeEvent(event), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.borrows).toBe(before); pair.finish();
    });
    test('a prematurely returned callback cannot release a pending query or write an audit after finalization starts', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), pair = binding.createOperation('ncsc.read');
        const entered = deferred(), hold = deferred(); let event, detachedQuery;
        f.state.hook = async value => { if (value.phase === 'before' && value.sql === 'SELECT controlled_pending') { entered.resolve(); await hold.promise; } };
        const released = f.state.released, pending = caught(() => pair.database.withTenantTransaction(f.example.scope.tenantId, tx => {
            event = pair.audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
            detachedQuery = tx.query('SELECT controlled_pending'); return 'premature';
        }));
        await entered.promise; await new Promise(resolve => setImmediate(resolve));
        expect(f.state.released).toBe(released);
        await expectFailure(() => pair.audit.writeEvent(event), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.auditRows.size).toBe(0);
        hold.resolve(); expect(await detachedQuery).toEqual({ rows: [{ value: 1 }] });
        const outcome = await pending; expect(outcome.error).toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        expect(f.state.trace.at(-1).sql).toBe('ROLLBACK'); expect(f.state.released).toBe(released + 1); pair.finish();
    });
    test('an already-entered audit stops after its pending lookup when its callback has prematurely finalized', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), pair = binding.createOperation('ncsc.read');
        const entered = deferred(), hold = deferred(); let detachedAudit;
        f.state.hook = async value => { if (value.phase === 'before' && /FROM nofries\.dashboard_runtime_audit/.test(value.sql)) {
            entered.resolve(); await hold.promise;
        } };
        const released = f.state.released, pending = caught(() => pair.database.withTenantTransaction(f.example.scope.tenantId, () => {
            const event = pair.audit.createEvent(context, { action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
            detachedAudit = caught(() => pair.audit.writeEvent(event)); return 'premature';
        }));
        await entered.promise; await new Promise(resolve => setImmediate(resolve)); expect(f.state.released).toBe(released);
        const boundary = f.state.trace.length; hold.resolve();
        expect((await detachedAudit).error).toBeInstanceOf(DashboardAuditError);
        expect((await pending).error).toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        expect(f.state.trace.slice(boundary).map(event => event.sql)).toEqual(['SET LOCAL statement_timeout = 0', 'ROLLBACK']);
        expect(f.state.auditRows.size).toBe(0); pair.finish();
    });
    test('private current-authority denial survives actual audit and NCSC sanitizers after rollback', async () => {
        const f = harness(), original = f.request(), binding = await f.bind(original), context = await f.context(binding), pair = binding.createOperation('ncsc.list');
        const repository = createPostgresDashboardRepository({ database: pair.database, clock: pair.clock, authoriseAdministration: () => false,
            ncsc: { audit: pair.audit, resolveSubmissionQuota: pair.resolveSubmissionQuota } });
        let changed = false;
        f.state.hook = async event => { if (!changed && event.phase === 'after' && /FROM nofries\.dashboard_ncsc_assessments/.test(event.sql)) {
            changed = true; f.requests.set(original, { ...f.requests.get(original), identityPayload: { ...f.identity, policyRevision: 2 } });
        } };
        await expectFailure(() => repository.listNcscAssessments(context, { limit: 10, afterAssessmentId: null }), NcscAssessmentError, 'ncsc_access_denied', 403);
        expect(changed).toBe(true); expect(f.state.trace.at(-1).sql).toBe('ROLLBACK'); pair.finish();
    });
    test('a copied denial-shaped provider failure cannot acquire the private denial latch', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context(binding), pair = binding.createOperation('ncsc.list');
        f.options.readExternalRuntimeEpoch.mockRejectedValue({ name: 'DashboardPersistenceError', code: 'access_denied', statusCode: 403 });
        const repository = createPostgresDashboardRepository({ database: pair.database, clock: pair.clock, authoriseAdministration: () => false,
            ncsc: { audit: pair.audit, resolveSubmissionQuota: pair.resolveSubmissionQuota } });
        await expectFailure(() => repository.listNcscAssessments(context, { limit: 10, afterAssessmentId: null }), NcscAssessmentError, 'ncsc_unavailable', 503);
        pair.finish(); expect(f.state.borrows).toBe(f.state.released);
    });
    test('genuine commit failure preserves the PostgreSQL error constructor for the original recovery layer', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        f.state.hook = event => { if (event.phase === 'before' && event.sql === 'COMMIT') throw new Error('driver-private commit'); };
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => true), PostgresDatabaseError, 'postgres_commit_failed', 500);
        pair.finish(); expect(f.state.borrows).toBe(f.state.released);
    });
});

describe('Dashboard request checked clock, quota and shared budget', () => {
    test.each(['regression', 'deadline'])('actual DATA sampling first encounters %s through its supplied paired clock', async kind => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('admission.read');
        const dataClock = jest.fn(() => { f.state.at = kind === 'regression' ? START : '2026-09-07T09:01:00.000Z'; return pair.clock(); });
        const repository = createPostgresDashboardRepository({ database: pair.database, clock: dataClock, authoriseAdministration: () => false });
        await expectFailure(() => repository.readAdmissionSnapshot(binding.scope, binding.identity), DashboardPersistenceError, 'unavailable', 503);
        expect(dataClock).toHaveBeenCalledTimes(1); expect(dataStorage.loadSnapshotForShare).toHaveBeenCalledTimes(2);
        expect(f.state.trace.at(-1).sql).toBe('ROLLBACK'); pair.finish();
        const before = f.state.borrows;
        await expectFailure(() => binding.createOperation('admission.read'), DashboardPersistenceError, 'unavailable', 503);
        expect(f.state.borrows).toBe(before);
    });
    test.each(['regression', 'deadline'])('a %s first sampled through the paired clock remains exhausted for later operations', async kind => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            f.state.at = kind === 'regression' ? START : '2026-09-07T09:01:00.000Z'; return pair.clock();
        }), NcscAssessmentError, 'ncsc_unavailable', 503); pair.finish();
        const before = f.state.borrows;
        await expectFailure(() => binding.createOperation('ncsc.read'), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.borrows).toBe(before);
    });
    test('one record budget is consumed by sequential operations, rather than reset per operation', async () => {
        const f = harness(); f.options.historyBudget.maxRecords = 60;
        const binding = await f.bind(); let successes = 0, exhausted = false;
        for (let i = 0; i < 8; i++) {
            let pair;
            try { pair = binding.createOperation('admission.read'); await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => true); successes++; }
            catch (error) { expect(error).toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 }); exhausted = true; break; }
            finally { if (pair) pair.finish(); }
        }
        expect(exhausted).toBe(true); expect(successes).toBeGreaterThan(0); expect(successes).toBeLessThan(8); expect(f.state.borrows).toBe(f.state.released);
    });
    test('carries the packaged empty-policy denial through the production request guard', async () => {
        const f = harness();
        f.options.resolveSubmissionQuota.mockImplementation(createNcscSubmissionQuotaResolver({ schemaVersion: 1, policies: [] }));
        const binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        const product = f.snapshot.entitlementState.grants.find(grant => grant.code === 'dashboard_govern');
        const selection = { ...f.example.scope, assessmentId: 'quota-assessment', actorSubjectKey: SUBJECT, moduleId: 'cyber_security',
            profileRef: require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
            productGrantId: product.grantId, agreementRef: product.agreementRef, expectedRevision: 1, submissionRevision: 2, at: NOW };
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId,
            async () => pair.resolveSubmissionQuota(selection)), NcscAssessmentError, 'ncsc_submission_unavailable', 409);
        expect(f.options.resolveSubmissionQuota).toHaveBeenCalledTimes(1);
        expect(f.state.trace.at(-1).sql).toBe('ROLLBACK');
        pair.finish(); expect(f.state.borrows).toBe(f.state.released);
    });
    test('keeps other synchronous quota provider failures ambiguous', async () => {
        const f = harness();
        f.options.resolveSubmissionQuota.mockImplementation(() => { throw Object.assign(new Error('driver-private provider'),
            { code: 'ncsc_submission_unavailable' }); });
        const binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        const product = f.snapshot.entitlementState.grants.find(grant => grant.code === 'dashboard_govern');
        const selection = { ...f.example.scope, assessmentId: 'quota-assessment', actorSubjectKey: SUBJECT, moduleId: 'cyber_security',
            profileRef: require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
            productGrantId: product.grantId, agreementRef: product.agreementRef, expectedRevision: 1, submissionRevision: 2, at: NOW };
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId,
            async () => pair.resolveSubmissionQuota(selection)), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(f.state.trace.at(-1).sql).toBe('ROLLBACK');
        pair.finish(); expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['thenable', 'getter'])('rejects a %s quota synchronously without awaiting or invoking hooks', async kind => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.execute'); let hooks = 0;
        const candidate = kind === 'thenable' ? { then() { hooks++; } }
            : Object.defineProperty({}, 'then', { enumerable: true, get() { hooks++; } });
        f.options.resolveSubmissionQuota.mockReturnValue(candidate);
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            const product = f.snapshot.entitlementState.grants.find(grant => grant.code === 'dashboard_govern');
            const selection = { ...f.example.scope, assessmentId: 'quota-assessment', actorSubjectKey: SUBJECT, moduleId: 'cyber_security',
                profileRef: require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
                productGrantId: product.grantId, agreementRef: product.agreementRef, expectedRevision: 1, submissionRevision: 2, at: NOW };
            expect(() => pair.resolveSubmissionQuota(selection)).toThrow(NcscAssessmentError);
            expect(f.options.resolveSubmissionQuota).toHaveBeenCalledTimes(1); expect(hooks).toBe(0);
        }), NcscAssessmentError, 'ncsc_unavailable', 503);
        pair.finish();
    });
    test('retains a detached successful quota policy and denies if its interval expires at final authorization', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        const product = f.snapshot.entitlementState.grants.find(grant => grant.code === 'dashboard_govern');
        const selection = { ...f.example.scope, assessmentId: 'quota-assessment', actorSubjectKey: SUBJECT, moduleId: 'cyber_security',
            profileRef: require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
            productGrantId: product.grantId, agreementRef: product.agreementRef, expectedRevision: 1, submissionRevision: 2, at: NOW };
        const policy = createNcscAdapters({ now: () => NOW }, { validUntil: '2026-09-07T09:00:01.000Z' }).resolveSubmissionQuota(selection);
        f.options.resolveSubmissionQuota.mockReturnValue(policy);
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            const result = pair.resolveSubmissionQuota(selection); expect(Object.keys(result)).toHaveLength(13); frozen(result);
            policy.validUntil = END; f.state.at = '2026-09-07T09:00:01.000Z';
        }), NcscAssessmentError, 'ncsc_access_denied', 403); pair.finish();
        expect(f.options.resolveSubmissionQuota).toHaveBeenCalledTimes(1);
    });
});

describe('Dashboard request guard pre-work and recovery regressions', () => {
    test('a validly hashed future instance head cannot establish current ingress', async () => {
        const f = harness(), future = { ...f.instance, changedAt: '2026-09-07T09:00:01.000Z' };
        f.rows.instance.changed_at = future.changedAt; f.rows.instance.record_sha256 = hash(future);
        await expectFailure(() => f.bind(), DashboardPersistenceError, 'access_denied', 403);
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled(); expect(f.state.borrows).toBe(f.state.released);
    });
    test('a valid future admission decision with retained birth remains ineligible before business work', async () => {
        const f = harness(), payload = f.admission.payload;
        const next = domain.applyAdmissionCommand({ predecessor: f.admission, command: { schemaVersion: 1,
            operationType: 'publishAdmissionDecision', operationId: uuid(90), actorSubjectKey: SUBJECT, authorityId: f.admission.authorityId,
            expectedRevision: 0, expectedHeadSha256: f.admission.decisionSha256, payload: { target: f.example.scope,
                identityPolicyRef: payload.identityPolicyRef, approvedEffectSha256: payload.approvedEffectSha256,
                evidenceRefs: payload.evidenceRefs, validFrom: payload.validFrom, validUntil: payload.validUntil } },
            facts: { occurredAt: '2026-09-07T09:00:01.000Z' } }).record;
        f.rows.admissionHistory = { 0: clone(f.rows.admission), 1: { ...clone(f.rows.admission), revision: 1, parent_revision: 0,
            parent_sha256: f.admission.decisionSha256, decision_sha256: next.decisionSha256, occurred_at: next.payload.occurredAt, payload: next.payload } };
        f.rows.head = { ...f.rows.head, head_revision: 1, head_sha256: next.decisionSha256, updated_at: next.payload.occurredAt };
        const binding = await f.bind(), pair = binding.createOperation('ncsc.read'), work = jest.fn();
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, work), NcscAssessmentError, 'ncsc_access_denied', 403);
        expect(work).not.toHaveBeenCalled(); pair.finish();
    });
    test('actual DATA refuses a genuine branded context resolved in the future', async () => {
        const f = harness(), binding = await f.bind(), context = await f.context({ ...binding, resolvedAt: '2026-09-07T09:00:01.000Z' });
        const pair = binding.createOperation('ncsc.list'), repository = createPostgresDashboardRepository({ database: pair.database,
            clock: pair.clock, authoriseAdministration: () => false, ncsc: { audit: pair.audit, resolveSubmissionQuota: pair.resolveSubmissionQuota } });
        await expectFailure(() => repository.listNcscAssessments(context, { limit: 1, afterAssessmentId: null }), NcscAssessmentError, 'ncsc_access_denied', 403);
        expect(f.state.auditRows.size).toBe(0); pair.finish();
    });
    test.each(['admission.read', 'ncsc.execute'])('%s rejects a replaced same-subject membership before the callback or quota provider', async operation => {
        const f = harness(), binding = await f.bind();
        const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
        let membership = clone(f.snapshot.membershipState);
        const apply = (action, payload) => { membership = applyMembershipCommand(membership, f.snapshot.tenantAggregate,
            { ...f.example.scope, action, payload, expectedRevision: membership.revision, actorSubjectKey: SUBJECT, now: NOW }); };
        apply('remove', { membershipId: f.member.membershipId });
        apply('invite', { invitationId: 'replacement-invitation', subjectKey: SUBJECT, roles: ['admin'], validFrom: f.member.validFrom,
            validUntil: f.member.validUntil, grantEvidenceId: 'replacement-role-approval', expiresAt: END });
        apply('accept', { invitationId: 'replacement-invitation', membershipId: 'replacement-member' });
        f.snapshot.membershipState = membership;
        const work = jest.fn(), pair = binding.createOperation(operation);
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, work),
            operation === 'admission.read' ? DashboardPersistenceError : NcscAssessmentError,
            operation === 'admission.read' ? 'access_denied' : 'ncsc_access_denied', 403);
        expect(work).not.toHaveBeenCalled(); expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
        expect(f.state.auditRows.size).toBe(0);
        const selected = operation === 'ncsc.execute' ? dataStorage.loadSnapshotForUpdate : dataStorage.loadSnapshotForShare;
        const other = operation === 'ncsc.execute' ? dataStorage.loadSnapshotForShare : dataStorage.loadSnapshotForUpdate;
        expect(selected).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled(); pair.finish();
    });
    test('a late canonical connection settles and releases with zero BEGIN or other SQL', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('admission.read');
        const connect = f.pool.connect.getMockImplementation(), before = f.state.trace.length, released = f.state.released;
        f.pool.connect.mockImplementation(async () => { const client = await connect(); f.state.at = '2026-09-07T09:01:00.000Z'; return client; });
        const work = jest.fn();
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, work), DashboardPersistenceError, 'unavailable', 503);
        expect(work).not.toHaveBeenCalled(); expect(f.state.trace).toHaveLength(before); expect(f.state.released).toBe(released + 1); pair.finish();
    });
    test.each(['fresh valid but unprovable', 'fresh current denial'])('uncertain rollback does not carry an old denial into %s reconciliation', async variant => {
        const f = harness(), original = f.request(), capture = clone(f.requests.get(original)), binding = await f.bind(original), pair = binding.createOperation('ncsc.execute');
        f.state.hook = event => { if (event.phase === 'before' && event.sql === 'ROLLBACK') throw new Error('Synthetic failed rollback'); };
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            f.requests.set(original, { ...capture, identityPayload: { ...f.identity, policyRevision: 2 } });
        }), PostgresDatabaseError, 'postgres_rollback_failed', 500);
        f.state.hook = null;
        if (variant === 'fresh valid but unprovable') f.requests.set(original, capture);
        const work = jest.fn(() => { throw new NcscAssessmentError('ncsc_outcome_ambiguous', 503); });
        await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, work), NcscAssessmentError,
            variant === 'fresh valid but unprovable' ? 'ncsc_outcome_ambiguous' : 'ncsc_access_denied', variant === 'fresh valid but unprovable' ? 503 : 403);
        expect(work).toHaveBeenCalledTimes(variant === 'fresh valid but unprovable' ? 1 : 0); pair.finish();
        expect(f.state.borrows).toBe(f.state.released);
    });
});

describe('Dashboard final observed authority and remaining SQL lifetime', () => {
    const CUTOFF = '2026-09-07T09:00:01.000Z';
    const SHORT = '2026-09-07T09:00:01.200Z';
    const TIMEOUT = "SELECT set_config('statement_timeout', $1, true)";
    function selection(f) {
        const product = f.snapshot.entitlementState.grants.find(g => g.code === 'dashboard_govern');
        return { ...f.example.scope, assessmentId: 'final-quota', actorSubjectKey: SUBJECT, moduleId: 'cyber_security',
            profileRef: require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
            productGrantId: product.grantId, agreementRef: product.agreementRef, expectedRevision: 1, submissionRevision: 2, at: NOW };
    }
    function fixtureFor(kind) {
        return harness(kind === 'session/capture' ? { sessionEndsAt: CUTOFF }
            : kind === 'binding/member' ? { membershipEndsAt: CUTOFF }
                : kind === 'admission' ? { admissionEndsAt: CUTOFF }
                    : kind === 'product/framework' ? { grantEndsAt: CUTOFF }
                        : kind === 'advisor assignment' ? { role: 'fractional_advisor', service: true, assignmentEndsAt: CUTOFF }
                            : kind === 'advisor service' ? { role: 'fractional_advisor', service: true, serviceEndsAt: CUTOFF } : {});
    }
    async function execute(f, binding, work = async () => true) {
        const pair = binding.createOperation('ncsc.execute');
        try { return await pair.database.withTenantTransaction(f.example.scope.tenantId, tx => work(pair, tx)); }
        finally { pair.finish(); }
    }
    function noCommit(f, boundary) {
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(0);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
        expect(trace.slice(-2).map(e => e.sql)).toEqual(['SET LOCAL statement_timeout = 0', 'ROLLBACK']);
        expect(f.state.borrows).toBe(f.state.released);
    }
    test.each(['session/capture', 'binding/member', 'admission', 'product/framework', 'deadline'])
    ('asynchronous quota read cannot outlive %s authority or request budget', async kind => {
        const f = fixtureFor(kind), binding = await f.bind(), boundary = f.state.trace.length;
        const started = deferred(), hold = deferred();
        f.options.resolveSubmissionQuota.mockImplementation(value => {
            const retained = createNcscAdapters({ now: () => NOW }).resolveSubmissionQuota(value);
            started.resolve(); return hold.promise.then(() => retained);
        });
        const pending = execute(f, binding, pair => pair.resolveSubmissionQuota(selection(f)));
        await started.promise;
        f.state.at = kind === 'deadline' ? '2026-09-07T09:01:00.000Z' : CUTOFF;
        hold.resolve();
        await expectFailure(() => pending, NcscAssessmentError, kind === 'deadline' ? 'ncsc_unavailable' : 'ncsc_access_denied', kind === 'deadline' ? 503 : 403);
        noCommit(f, boundary);
    });
    test('an unawaited asynchronous quota cannot commit its owning transaction', async () => {
        const f = harness(), binding = await f.bind(), boundary = f.state.trace.length;
        const started = deferred(), hold = deferred();
        f.options.resolveSubmissionQuota.mockImplementation(value => {
            const retained = createNcscAdapters({ now: () => NOW }).resolveSubmissionQuota(value);
            started.resolve(); return hold.promise.then(() => retained);
        });
        const pending = execute(f, binding, async pair => { pair.resolveSubmissionQuota(selection(f)); return 'too-early'; });
        await started.promise; await new Promise(resolve => setImmediate(resolve)); hold.resolve();
        await expectFailure(() => pending, NcscAssessmentError, 'ncsc_unavailable', 503); noCommit(f, boundary);
    });
    test('rejected asynchronous policy yields unavailable and rolls back without a commit', async () => {
        const f = harness(), binding = await f.bind(), boundary = f.state.trace.length;
        f.options.resolveSubmissionQuota.mockImplementation(() => Promise.reject(new Error('private store failure')));
        await expectFailure(() => execute(f, binding, pair => pair.resolveSubmissionQuota(selection(f))),
            NcscAssessmentError, 'ncsc_unavailable', 503); noCommit(f, boundary);
    });
    test('a pending quota provider times out and late completion cannot revive the transaction', async () => {
        const f = harness(), binding = await f.bind(), boundary = f.state.trace.length;
        const started = deferred(), hold = deferred();
        let retained;
        f.options.resolveSubmissionQuota.mockImplementation(value => {
            retained = createNcscAdapters({ now: () => NOW }).resolveSubmissionQuota(value);
            started.resolve(); return hold.promise;
        });
        jest.useFakeTimers();
        try {
            const pending = execute(f, binding, pair => pair.resolveSubmissionQuota(selection(f)));
            const rejected = expectFailure(() => pending, NcscAssessmentError, 'ncsc_unavailable', 503);
            await started.promise; await jest.advanceTimersByTimeAsync(10000); await rejected;
            noCommit(f, boundary); const settled = f.state.trace.length;
            hold.resolve(retained); await Promise.resolve(); await Promise.resolve();
            expect(f.state.trace).toHaveLength(settled);
        } finally { jest.useRealTimers(); }
    });
    test.each(['session/capture', 'binding/member', 'admission', 'product/framework', 'advisor assignment', 'advisor service', 'quota'])
    ('the first sample after actual final predicates rechecks %s', async kind => {
        const f = fixtureFor(kind), binding = await f.bind();
        if (kind === 'quota') f.options.resolveSubmissionQuota.mockImplementation(createNcscAdapters({ now: () => f.state.at }, { validUntil: CUTOFF }).resolveSubmissionQuota);
        const work = async pair => { if (kind === 'quota') pair.resolveSubmissionQuota(selection(f)); return 'valid-before-cutoff'; };
        expect(await execute(f, binding, work)).toBe('valid-before-cutoff');
        const boundary = f.state.trace.length; let armed = 0;
        mockAfterAccess = () => { if (!armed) { armed++; f.state.at = CUTOFF; } };
        await expectFailure(() => execute(f, binding, work), NcscAssessmentError, 'ncsc_access_denied', 403);
        expect(armed).toBe(1); noCommit(f, boundary);
    });
    test.each(['authority', 'deadline'])('pre-COMMIT %s failure retains its original known-rollback classification', async kind => {
        const f = fixtureFor('session/capture'), binding = await f.bind(), boundary = f.state.trace.length; let armed = 0;
        mockAfterWork = () => { armed++; f.state.at = kind === 'authority' ? CUTOFF : '2026-09-07T09:01:00.000Z'; };
        await expectFailure(() => execute(f, binding), NcscAssessmentError, kind === 'authority' ? 'ncsc_access_denied' : 'ncsc_unavailable', kind === 'authority' ? 403 : 503);
        expect(armed).toBe(1); noCommit(f, boundary);
    });
    test.each(['authority', 'deadline'])('acknowledged COMMIT followed by %s expiry withholds disclosure without rollback', async kind => {
        const f = fixtureFor('session/capture'), binding = await f.bind(), boundary = f.state.trace.length, borrows = f.state.borrows;
        f.state.hook = e => { if (e.phase === 'after' && e.sql === 'COMMIT') f.state.at = kind === 'authority' ? CUTOFF : '2026-09-07T09:01:00.000Z'; };
        await expectFailure(() => execute(f, binding), NcscAssessmentError, kind === 'authority' ? 'ncsc_access_denied' : 'ncsc_unavailable', kind === 'authority' ? 403 : 503);
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(1); expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(0);
        expect(f.state.borrows - borrows).toBe(1); expect(f.state.borrows).toBe(f.state.released);
    });
    test('known COMMIT authority expiry followed by the request deadline retains unavailable priority', async () => {
        const f = fixtureFor('session/capture'), binding = await f.bind(), boundary = f.state.trace.length; let committed = false, samples = 0;
        f.state.hook = e => { if (e.phase === 'after' && e.sql === 'COMMIT') committed = true; };
        f.options.clock.mockImplementation(() => committed ? (++samples === 1 ? CUTOFF : '2026-09-07T09:01:00.000Z') : f.state.at);
        await expectFailure(() => execute(f, binding), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(samples).toBeGreaterThanOrEqual(2);
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(1); expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(0);
        expect(trace.filter(e => e.sql === 'BEGIN')).toHaveLength(1); expect(f.state.borrows).toBe(f.state.released);
    });
    test('a real COMMIT response failure remains PostgreSQL uncertainty when final authority also expires', async () => {
        const f = fixtureFor('session/capture'), binding = await f.bind();
        f.state.hook = e => { if (e.phase === 'after' && e.sql === 'COMMIT') { f.state.at = CUTOFF; throw new Error('driver-private response lost'); } };
        await expectFailure(() => execute(f, binding), PostgresDatabaseError, 'postgres_commit_failed', 500);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test('failed rollback preserves uncertainty and the next attempt clears only the expired quota frame', async () => {
        const f = harness(), binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        f.options.resolveSubmissionQuota.mockImplementation(createNcscAdapters({ now: () => f.state.at }, { validUntil: CUTOFF }).resolveSubmissionQuota);
        mockAfterWork = () => { f.state.at = CUTOFF; };
        f.state.hook = e => { if (e.phase === 'before' && e.sql === 'ROLLBACK') throw new Error('driver-private rollback lost'); };
        try {
            await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => pair.resolveSubmissionQuota(selection(f))), PostgresDatabaseError, 'postgres_rollback_failed', 500);
            expect(f.state.trace.slice(-2).map(e => e.sql)).toEqual(['SET LOCAL statement_timeout = 0', 'ROLLBACK']);
            expect(f.state.releaseDiscards.at(-1)).toBe(true);
            mockAfterWork = null; f.state.hook = null;
            const work = jest.fn(() => { throw new NcscAssessmentError('ncsc_outcome_ambiguous', 503); });
            await expectFailure(() => pair.database.withTenantTransaction(f.example.scope.tenantId, work), NcscAssessmentError, 'ncsc_outcome_ambiguous', 503);
            expect(work).toHaveBeenCalledTimes(1); expect(f.options.resolveSubmissionQuota).toHaveBeenCalledTimes(1);
        } finally { pair.finish(); }
    });
    test.each(['authority expiry', 'driver failure'])('COMMIT timeout preparation %s never sends COMMIT', async kind => {
        const f = fixtureFor('session/capture'), binding = await f.bind(), boundary = f.state.trace.length; let ready = false, injected = 0;
        mockAfterWork = () => { ready = true; };
        f.state.hook = e => { if (ready && e.sql === TIMEOUT && e.phase === (kind === 'authority expiry' ? 'after' : 'before') && !injected) {
            injected++; if (kind === 'authority expiry') f.state.at = CUTOFF; else throw new Error('driver-private timeout preparation');
        } };
        await expectFailure(() => execute(f, binding), NcscAssessmentError, kind === 'authority expiry' ? 'ncsc_access_denied' : 'ncsc_unavailable', kind === 'authority expiry' ? 403 : 503);
        expect(injected).toBe(1); noCommit(f, boundary);
    });
    test.each(['capture elapsed', 'routing elapsed'])('%s reduces every later statement timeout from the original captured deadline', async kind => {
        const f = harness(), original = f.request({ deadline: SHORT }); let moved = false;
        if (kind === 'capture elapsed') {
            const capture = f.options.captureRequest.getMockImplementation();
            f.options.captureRequest.mockImplementation(async request => { const value = await capture(request); if (!moved) { moved = true; f.state.at = '2026-09-07T09:00:00.200Z'; } return value; });
        } else f.state.hook = e => { if (!moved && e.phase === 'after' && e.sql === 'COMMIT') { moved = true; f.state.at = '2026-09-07T09:00:00.500Z'; } };
        const binding = await f.bind(original), boundary = kind === 'capture elapsed' ? 0 : f.state.trace.length;
        await execute(f, binding);
        const settings = f.state.trace.slice(boundary).filter(e => e.sql === TIMEOUT); expect(settings.length).toBeGreaterThan(0);
        for (const setting of settings) { expect(setting.params[0]).toMatch(/^[1-9][0-9]*$/); expect(Number(setting.params[0])).toBeLessThanOrEqual(kind === 'capture elapsed' ? 1000 : 700); }
        expect(moved).toBe(true);
    });
    test('a positive one-millisecond remaining lifetime is never rounded to disabled timeout zero', async () => {
        const f = harness(), binding = await f.bind(f.request({ deadline: '2026-09-07T09:00:00.001Z' }));
        await execute(f, binding);
        const settings = f.state.trace.filter(e => e.sql === TIMEOUT); expect(settings.length).toBeGreaterThan(0);
        expect(settings.every(e => e.params[0] === '1')).toBe(true);
    });
    test('a timeout SET reaching the exact deadline prevents the target tenant GUC but still rolls back', async () => {
        const f = harness(), binding = await f.bind(f.request({ deadline: SHORT })), boundary = f.state.trace.length; let changed = 0;
        f.state.hook = e => { if (!changed && e.phase === 'after' && e.sql === TIMEOUT) { changed++; f.state.at = SHORT; } };
        await expectFailure(() => execute(f, binding), NcscAssessmentError, 'ncsc_unavailable', 503);
        expect(changed).toBe(1); noCommit(f, boundary);
        expect(f.state.trace.slice(boundary).filter(e => /set_config\('nofries\.tenant_id'/.test(e.sql))).toHaveLength(0);
    });
    test('concurrent queries prepare FIFO timeout-target pairs only after the preceding target settles', async () => {
        const f = harness(), binding = await f.bind(f.request({ deadline: SHORT })), entered = deferred(), release = deferred();
        let start, operation;
        f.state.hook = async e => { if (e.sql === 'SELECT controlled_pending' && e.params[0] === 1 && e.phase === 'before') { entered.resolve(); await release.promise; } };
        try {
            operation = execute(f, binding, async (_pair, tx) => { start = f.state.trace.length; await Promise.all([
                tx.query('SELECT controlled_pending', [1]), tx.query('SELECT controlled_pending', [2])]); return true; });
            const settledOperation = caught(() => operation); // Attach immediately even if a broken driver rejects early.
            await entered.promise; await new Promise(resolve => setImmediate(resolve));
            expect(f.state.trace.slice(start).filter(e => e.sql === 'SELECT controlled_pending')).toHaveLength(1);
            expect(f.state.trace.slice(start).filter(e => e.sql === TIMEOUT)).toHaveLength(1);
            f.state.at = '2026-09-07T09:00:00.500Z'; release.resolve();
            expect((await settledOperation).error).toBeUndefined();
            const trace = f.state.trace.slice(start), second = trace.findIndex(e => e.sql === 'SELECT controlled_pending' && e.params[0] === 2);
            expect(second).toBeGreaterThan(0); expect(trace[second - 1]).toMatchObject({ sql: TIMEOUT, params: ['700'] });
        } finally { release.resolve(); if (operation) await caught(() => operation); }
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['acknowledged reset', 'aborted transaction reset rejection', 'other reset rejection'])
    ('cleanup waits for %s and actual rollback without renewing authority or releasing its client', async variant => {
        const f = fixtureFor('session/capture'), binding = await f.bind(), pair = binding.createOperation('ncsc.execute');
        const resetEntered = deferred(), resetRelease = deferred(), rollbackEntered = deferred(), rollbackRelease = deferred();
        const released = f.state.released, borrowed = f.state.borrows, start = f.state.trace.length;
        let cleanupStart, cleanupClockCalls, resetAcknowledged = 0, pending;
        mockAfterWork = () => { f.state.at = CUTOFF; };
        f.state.hook = async event => {
            if (event.sql === 'SET LOCAL statement_timeout = 0') {
                expect(event.params).toEqual([]);
                if (event.phase === 'after') { resetAcknowledged++; return; }
                cleanupStart = f.state.trace.length - 1; cleanupClockCalls = f.options.clock.mock.calls.length;
                resetEntered.resolve(); await resetRelease.promise;
                if (variant !== 'acknowledged reset') {
                    const error = new Error('driver-private cleanup reset refused');
                    error.code = variant === 'aborted transaction reset rejection' ? '25P02' : '08006';
                    throw error;
                }
            }
            if (event.sql === 'ROLLBACK' && event.phase === 'before') {
                rollbackEntered.resolve(); await rollbackRelease.promise;
            }
        };
        try {
            pending = caught(() => pair.database.withTenantTransaction(f.example.scope.tenantId, async () => true));
            expect(await Promise.race([resetEntered.promise.then(() => true), rollbackEntered.promise.then(() => false), pending.then(() => false)])).toBe(true);
            await new Promise(resolve => setImmediate(resolve));
            expect(f.state.trace.slice(cleanupStart).map(e => e.sql)).toEqual(['SET LOCAL statement_timeout = 0']);
            expect(f.state.released).toBe(released); expect(f.options.clock.mock.calls.length).toBe(cleanupClockCalls);
            resetRelease.resolve();
            expect(await Promise.race([rollbackEntered.promise.then(() => true), pending.then(() => false)])).toBe(true);
            await new Promise(resolve => setImmediate(resolve));
            expect(f.state.trace.slice(cleanupStart).map(e => e.sql)).toEqual(['SET LOCAL statement_timeout = 0', 'ROLLBACK']);
            expect(f.state.released).toBe(released); expect(f.options.clock.mock.calls.length).toBe(cleanupClockCalls);
            expect(resetAcknowledged).toBe(variant === 'acknowledged reset' ? 1 : 0);
            rollbackRelease.resolve();
            const outcome = await pending;
            expect(outcome.error).toBeInstanceOf(NcscAssessmentError);
            expect(outcome.error).toMatchObject({ code: 'ncsc_access_denied', statusCode: 403 });
            expect(outcome.error.message).not.toMatch(/driver-private|25P02|08006/);
            const trace = f.state.trace.slice(start);
            expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(0);
            expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
            expect(f.state.borrows - borrowed).toBe(1); expect(f.state.released - released).toBe(1);
            expect(f.state.releaseDiscards.at(-1)).toBe(false);
        } finally {
            resetRelease.resolve(); rollbackRelease.resolve();
            if (pending) await pending;
            pair.finish();
        }
    });
});

const HOST_MODULES = ['overview', 'ai_governance', 'cyber_security', 'it_optimisation',
    'improvement_plan', 'evidence', 'board_reports', 'services'];
const HOST_END = '2026-09-07T09:00:01.000Z';
function hostRequest(f, overrides = {}) { const request = f.request(overrides); request.method = 'GET'; return request; }
function hostRead(f, route = 'bootstrap', request = hostRequest(f), binder = f.binder()) {
    return binder.handleHostResource(request, { route,
        expectedGeneration: ['app.js', 'dashboard.css'].includes(route) ? null : f.session.generationToken });
}
function hostEnvelope(f, action = 'readDashboardBootstrap', resourceKey = 'bootstrap') {
    return { sessionSha256: f.session.sessionSha256, instanceId: f.instance.instanceId,
        authorityId: f.admission.authorityId, event: { schemaVersion: 1, eventType: 'dashboard.runtime',
            eventId: uuid(700), requestId: uuid(701), occurredAt: NOW, actorSubjectKey: SUBJECT,
            scope: clone(f.example.scope), action, outcome: 'succeeded', resourceKey, operationId: null } };
}
function hostBusinessTrace(f) {
    // The locator owns its first COMMIT; it is not a host business commit.
    const firstCommit = f.state.trace.findIndex(event => event.sql === 'COMMIT');
    return f.state.trace.slice(firstCommit + 1);
}
function expectHostSettled(f, committed) {
    expect(f.state.borrows).toBe(f.state.released);
    const trace = hostBusinessTrace(f);
    expect(trace.filter(event => event.sql === 'COMMIT')).toHaveLength(committed ? 1 : 0);
    expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(committed ? 0 : 1);
    expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
}

describe('Dashboard host fixed operation and temporal projection', () => {
    test('HN-G01 pure event metadata is the exact fifteen-read-pair and eleven-route contract', () => {
        const events = require('../api/shared/appLifecycle/dashboardRuntimeEvents'), f = harness();
        expect(Object.keys(events).sort()).toEqual(['RUNTIME_READ_RESOURCES', 'hostResourceForRoute',
            'normaliseRuntimeReadEventInput', 'normaliseRuntimeReadAudit'].sort());
        expect(events.RUNTIME_READ_RESOURCES).toEqual({ readSession: ['session'], discoverBindings: ['binding'],
            readOnboardingStatus: ['case'], readDashboardAdmission: HOST_MODULES.map(key => 'module:' + key),
            readDashboardBootstrap: ['bootstrap'], readDashboardAsset: ['asset:app.js', 'asset:dashboard.css'],
            readDashboardReadiness: ['readiness'] });
        frozen(events.RUNTIME_READ_RESOURCES);
        const routes = [['bootstrap', 'readDashboardBootstrap', 'bootstrap', null, true],
            ...HOST_MODULES.map(key => ['modules/' + key, 'readDashboardAdmission', 'module:' + key, key, true]),
            ['app.js', 'readDashboardAsset', 'asset:app.js', null, false],
            ['dashboard.css', 'readDashboardAsset', 'asset:dashboard.css', null, false]];
        for (const [route, action, resourceKey, moduleKey, requiresGeneration] of routes) {
            const value = events.hostResourceForRoute(route);
            expect(value).toEqual({ route, action, resourceKey, moduleKey, requiresGeneration }); frozen(value);
            const input = { eventId: uuid(700), action, outcome: 'succeeded', resourceKey, operationId: null };
            const normal = events.normaliseRuntimeReadEventInput(input);
            expect(normal).toEqual(input); expect(normal).not.toBe(input); frozen(normal);
            const envelope = hostEnvelope(f, action, resourceKey), audit = events.normaliseRuntimeReadAudit(envelope);
            expect(audit).toEqual(envelope); expect(audit.event).not.toBe(envelope.event); frozen(audit);
        }
        expect(() => events.hostResourceForRoute('readiness')).toThrow();
    });
    test('HN-G02 pure event validation rejects malformed metadata without granting authority', async () => {
        const events = require('../api/shared/appLifecycle/dashboardRuntimeEvents'), f = harness(); let getters = 0;
        const good = { eventId: uuid(700), action: 'readDashboardBootstrap', outcome: 'succeeded', resourceKey: 'bootstrap', operationId: null };
        const accessor = { ...good }; Object.defineProperty(accessor, 'outcome', { enumerable: true, get() { getters++; return 'succeeded'; } });
        for (const value of [{ ...good, resourceKey: 'session' }, { ...good, action: 'createCase', resourceKey: 'case' },
            { ...good, operationId: uuid(1) }, { ...good, outcome: 'allowed' }, { ...good, actorSubjectKey: SUBJECT },
            { ...good, scope: f.example.scope }, { ...good, eventId: 'not-a-uuid' }, accessor]) {
            expect(() => events.normaliseRuntimeReadEventInput(value)).toThrow();
        }
        const malformed = hostEnvelope(f); malformed.event.occurredAt = 9;
        expect(() => events.normaliseRuntimeReadAudit(malformed)).toThrow(); expect(getters).toBe(0);
        const binding = await f.bind(), pair = binding.createOperation('admission.read');
        await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            await expectFailure(() => pair.audit.writeEvent(events.normaliseRuntimeReadAudit(hostEnvelope(f)).event),
                DashboardPersistenceError, 'unavailable', 503);
        });
        await pair.finish(); expect(f.state.auditRows.size).toBe(0);
    });
    test('HN-G03 host transport refusals precede configured work', async () => {
        const f = harness(), binder = f.binder(); let getters = 0;
        const good = { route: 'bootstrap', expectedGeneration: f.session.generationToken };
        const accessor = { ...good }; Object.defineProperty(accessor, 'route', { enumerable: true, get() { getters++; return 'bootstrap'; } });
        const symbol = { ...good, [Symbol('scope')]: true };
        for (const selector of [{ ...good, expectedGeneration: null }, { route: 'app.js', expectedGeneration: f.session.generationToken },
            { ...good, expectedGeneration: 'A'.repeat(64) }, { ...good, expectedGeneration: 'a'.repeat(63) },
            { ...good, eventId: uuid(9) }, { ...good, actor: SUBJECT }, { ...good, work: () => true }, accessor, symbol,
            { ...good, route: '/api/dashboard/bootstrap?scope=other' }, { ...good, route: 'readiness' }]) {
            await expectFailure(() => binder.handleHostResource(f.request(), selector), DashboardPersistenceError, 'access_denied', 403);
        }
        for (const original of [null, 1, 'request', new Proxy({}, { ownKeys() { getters++; return []; } })]) await expectFailure(() => binder.handleHostResource(original, good), DashboardPersistenceError, 'access_denied', 403);
        expect(getters).toBe(0); expect(f.options.clock).not.toHaveBeenCalled(); expect(f.options.captureRequest).not.toHaveBeenCalled();
        expect(f.options.newId).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
    test('HN-G04 original host request coalesces before work and retains a failed entry', async () => {
        const f = harness(), binder = f.binder(), original = hostRequest(f), hold = deferred(), entered = deferred();
        const capture = f.options.captureRequest; let reentrant, firstCapture = true;
        f.options.captureRequest.mockImplementation(async request => {
            if (firstCapture) { firstCapture = false; reentrant = hostRead(f, 'bootstrap', original, binder); entered.resolve(); await hold.promise; }
            return f.requests.has(request) ? clone(f.requests.get(request)) : null;
        });
        const one = hostRead(f, 'bootstrap', original, binder), two = hostRead(f, 'bootstrap', original, binder);
        await entered.promise; expect(two).toBe(one); expect(reentrant).toBe(one);
        await expectFailure(() => hostRead(f, 'modules/overview', original, binder), DashboardPersistenceError, 'access_denied', 403);
        hold.resolve(); const response = await one; expect(await two).toBe(response); expect(response.status).toBe(200);
        expect(f.options.newId).toHaveBeenCalledTimes(1); frozen(response);
        const calls = f.options.clock.mock.calls.length, sql = f.state.trace.length;
        expect(await hostRead(f, 'bootstrap', original, binder)).toBe(response);
        expect(f.options.clock).toHaveBeenCalledTimes(calls); expect(f.state.trace).toHaveLength(sql);
        const broken = hostRequest(f); f.options.captureRequest.mockRejectedValue(new Error('driver-private credential'));
        const failed = hostRead(f, 'bootstrap', broken, binder);
        await expectFailure(() => failed, DashboardPersistenceError, 'unavailable', 503);
        const failedCalls = f.options.captureRequest.mock.calls.length;
        expect(hostRead(f, 'bootstrap', broken, binder)).toBe(failed);
        await expectFailure(() => failed, DashboardPersistenceError, 'unavailable', 503);
        expect(f.options.captureRequest).toHaveBeenCalledTimes(failedCalls);
        expect(capture).toBe(f.options.captureRequest);
    });
    test('HN-G05 both entrypoints share one original request allocation', async () => {
        for (const hostFirst of [false, true]) {
            const f = harness(), binder = f.binder(), original = hostRequest(f), hold = deferred(), entered = deferred();
            let initial = true; f.options.captureRequest.mockImplementation(async request => {
                if (initial) { initial = false; entered.resolve(); await hold.promise; }
                return clone(f.requests.get(request));
            });
            const selector = { expectedGeneration: f.session.generationToken };
            const one = hostFirst ? hostRead(f, 'bootstrap', original, binder) : binder.bindRequest(original, selector);
            const settled = caught(() => one); await entered.promise;
            const before = { clock: f.options.clock.mock.calls.length, ids: f.options.newId.mock.calls.length, borrows: f.state.borrows };
            await expectFailure(() => hostFirst ? binder.bindRequest(original, selector) : hostRead(f, 'bootstrap', original, binder),
                DashboardPersistenceError, 'access_denied', 403);
            expect({ clock: f.options.clock.mock.calls.length, ids: f.options.newId.mock.calls.length, borrows: f.state.borrows }).toEqual(before);
            hold.resolve(); expect((await settled).error).toBeUndefined(); expect(f.state.borrows).toBe(f.state.released);
        }
    });
    test('HN-G06 premature DATA continuation drains before release and loses SQL ownership', async () => {
        const f = harness(), entered = deferred(), release = deferred(); let client, pending, settled = false;
        f.state.hook = async event => { if (event.phase === 'before' && event.sql === 'SELECT controlled_pending') { entered.resolve(); await release.promise; } };
        mockHostDataAfterWork = async tx => {
            if (client) return; client = tx; pending = caught(() => tx.query('SELECT controlled_pending'));
        };
        const result = caught(() => hostRead(f)).then(value => { settled = true; return value; });
        try {
            await Promise.race([entered.promise, result.then(out => { throw out.error || new Error('Host returned before controlled query'); })]);
            await Promise.resolve(); expect(settled).toBe(false);
            expect(f.state.borrows - f.state.released).toBe(1);
            release.resolve(); await pending;
            await expectFailure(async () => { const out = await result; if (out.error) throw out.error; return out.value; }, DashboardPersistenceError, 'unavailable', 503);
            const before = f.state.trace.length;
            const stale = await caught(() => client.query('SELECT stale_host_continuation'));
            expect(stale.error).toBeInstanceOf(Error); expect(stale.value).toBeUndefined();
            expect(f.state.trace).toHaveLength(before); expectHostSettled(f, false);
        } finally { release.resolve(); await result; if (pending) await pending; }
    });
    test('HN-G07 operational DATA failure beats a buffered module denial', async () => {
        const errors = [() => new Error('driver-private secret'),
            () => new (require('../api/shared/dashboardAdmission').DashboardAdmissionError)(),
            () => Object.assign(new Error('driver-private'), { code: 'dashboard_access_denied', statusCode: 403 })];
        for (const [index, makeError] of errors.entries()) {
            const f = harness(); f.snapshot.flags.enabled.cyber_security = false; let deniedDecisions = 0;
            mockHostDataAfterWork = index === 0 ? async () => { throw makeError(); } : null;
            mockAfterHostDecision = index === 0 ? null : decision => {
                expect(decision).toEqual({ outcome: 'denied', projection: null }); deniedDecisions++; throw makeError();
            };
            await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
            expect(deniedDecisions).toBe(index === 0 ? 0 : 1);
            expectHostSettled(f, false); expect(f.state.auditRows.size).toBe(0);
        }
    });
    test('HN-G08 a final typed denial cannot rewrite an original successful slot', async () => {
        const f = harness(); let decisions = 0;
        mockAfterHostDecision = async value => {
            if (++decisions === 1) { expect(value.outcome).toBe('succeeded'); f.snapshot.flags.enabled.cyber_security = false; f.snapshot.flags.revision++; }
        };
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
        for (const row of f.state.auditRows.values()) expect(row.payload.outcome).toBe('succeeded');
        // This controlled driver establishes no COMMIT and no rewritten event;
        // real SQL tests separately establish durable rollback of inserted rows.
    });
    test.each(['retained', 'absent', 'inconsistent'])
    ('HN-G10 uncertain COMMIT with revoked binding keeps an unproved %s event ambiguous', async eventState => {
        const f = harness(); let lost = false, recoveryStart;
        f.state.hook = event => {
            if (event.phase !== 'after' || event.sql !== 'COMMIT' || lost || !f.state.auditRows.size) return;
            lost = true; recoveryStart = f.state.trace.length;
            f.rows.binding.status = 'revoked'; f.rows.binding.revision = 1; f.rows.binding.updated_at = NOW;
            if (eventState === 'absent') f.state.auditRows.clear();
            if (eventState === 'inconsistent') for (const row of f.state.auditRows.values()) row.event_sha256 = 'f'.repeat(64);
            throw new Error('driver-private lost host COMMIT response');
        };
        await expectFailure(() => hostRead(f), DashboardPersistenceError, 'outcome_ambiguous', 503);
        expect(lost).toBe(true);
        const recovery = f.state.trace.slice(recoveryStart);
        expect(recovery.some(event => /^BEGIN/.test(event.sql))).toBe(true);
        expect(recovery.some(event => /FROM nofries\.dashboard_identity_bindings/.test(event.sql))).toBe(true);
        expect(recovery.filter(event => /FROM nofries\.dashboard_runtime_audit/.test(event.sql))).toEqual([]);
        expect(recovery.filter(event => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(event.sql))).toEqual([]);
        expect(f.options.newId).toHaveBeenCalledTimes(1);
        expect(f.state.auditRows.size).toBe(eventState === 'absent' ? 0 : 1);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test('HN-G11 event-proved recovery retains a later genuine authority denial', async () => {
        const f = harness(); let lost = false, decisions = 0, recoveryStart;
        f.snapshot.entitlementState.grants.find(grant => grant.grantId === 'synthetic-product').validUntil = HOST_END;
        f.state.hook = event => {
            if (event.phase !== 'after' || event.sql !== 'COMMIT' || lost || !f.state.auditRows.size) return;
            lost = true; recoveryStart = f.state.trace.length;
            throw new Error('driver-private lost host COMMIT response');
        };
        mockAfterHostDecision = value => {
            if (lost && ++decisions === 1) { expect(value.outcome).toBe('succeeded'); f.state.at = HOST_END; }
        };
        await expectFailure(() => hostRead(f), DashboardPersistenceError, 'access_denied', 403);
        expect(lost).toBe(true); expect(decisions).toBe(1);
        const recovery = f.state.trace.slice(recoveryStart);
        expect(recovery.filter(event => /FROM nofries\.dashboard_runtime_audit/.test(event.sql))).toHaveLength(1);
        expect(recovery.filter(event => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(event.sql))).toEqual([]);
        expect(f.options.newId).toHaveBeenCalledTimes(1); expect(f.state.auditRows.size).toBe(1);
        expect([...f.state.auditRows.values()][0].payload.outcome).toBe('succeeded');
        expect(f.state.borrows).toBe(f.state.released);
    });

    test('HN-G09 initial final and event work retain one finite ledger', async () => {
        const sufficient = harness(); expect((await hostRead(sufficient)).status).toBe(200); expectHostSettled(sufficient, true);
        const f = harness(); f.options.historyBudget = { ...BUDGET, maxRecords: 12 };
        await expectFailure(() => hostRead(f), DashboardPersistenceError, 'unavailable', 503);
        expect(f.state.trace.some(event => /dashboard_admission_decisions/.test(event.sql))).toBe(true);
        expect(hostBusinessTrace(f).some(event => event.sql === 'COMMIT')).toBe(false);
        expect(f.state.borrows).toBe(f.state.released); expect(f.options.newId.mock.calls.length).toBeLessThanOrEqual(1);
    });

    async function sealedScenario(kind) {
        const advisor = kind === 'overlap';
        const f = harness(advisor ? { role: 'fractional_advisor', service: true } : {});
        const product = f.snapshot.entitlementState.grants.find(grant => grant.grantId === 'synthetic-product');
        let route = advisor ? 'modules/cyber_security' : 'bootstrap';
        if (kind === 'future') { product.validFrom = HOST_END; route = 'modules/cyber_security'; }
        else if (kind === 'product') product.validUntil = HOST_END;
        else if (kind === 'overlap') {
            const service = f.snapshot.entitlementState.grants.find(grant => grant.code === 'fractional_advisory');
            service.validUntil = HOST_END;
            f.snapshot.entitlementState.grants.push({ ...clone(service), grantId: 'synthetic-service-overlap', validFrom: NOW, validUntil: END });
        } else if (kind === 'handoff' || kind === 'subscription') {
            product.validUntil = HOST_END;
            f.snapshot.entitlementState.grants.push({ ...clone(product), grantId: 'synthetic-successor-product', validFrom: HOST_END,
                validUntil: END, code: kind === 'subscription' ? 'dashboard_score' : product.code });
        } else if (kind === 'displayed-service') {
            route = 'modules/services'; f.snapshot.entitlementState.grants.push({ ...clone(product), grantId: 'synthetic-displayed-service',
                code: 'managed_endpoint', validFrom: START, validUntil: HOST_END, modules: ['services'], frameworks: [], limits: {},
                coverage: ['synthetic-device'], actions: ['view'] });
            f.snapshot.flags.enabled['service:managed_endpoint'] = true;
        }
        let decisions = 0, sealedTrace, sealedProviders, first;
        mockAfterHostDecision = value => {
            decisions++; if (decisions === 1) first = clone(value);
            if (decisions === 2) {
                expect(value.outcome).toBe(first.outcome); sealedTrace = f.state.trace.length;
                sealedProviders = f.options.captureRequest.mock.calls.length + f.options.readExternalRuntimeEpoch.mock.calls.length;
                f.state.at = HOST_END;
            }
        };
        const result = await caught(() => hostRead(f, route)); expect(decisions).toBe(2);
        const late = f.state.trace.slice(sealedTrace);
        expect(late.filter(event => !/^(COMMIT|ROLLBACK|SET LOCAL statement_timeout = 0)$/.test(event.sql)
            && !/set_config\('statement_timeout'/.test(event.sql))).toEqual([]);
        expect(f.options.captureRequest.mock.calls.length + f.options.readExternalRuntimeEpoch.mock.calls.length).toBe(sealedProviders);
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
        return { f, result, first };
    }
    test('HG01 product expiry after genuine final decision refuses at sealed tail', async () => {
        const { f, result } = await sealedScenario('product');
        expect(result.error).toBeInstanceOf(DashboardPersistenceError); expect(result.error.code).toBe('dashboard_unavailable'); expectHostSettled(f, false);
    });
    test('HG02 retained future product cannot turn a sealed denied buffer into success', async () => {
        const { f, result, first } = await sealedScenario('future'); expect(first.outcome).toBe('denied');
        expect(result.error).toBeInstanceOf(DashboardPersistenceError); expect(result.error.code).toBe('dashboard_unavailable'); expectHostSettled(f, false);
    });
    test('HG03 guarded fractional service cutoff keeps a live overlapping grant', async () => {
        const { f, result } = await sealedScenario('overlap'); expect(result.error).toBeUndefined(); expect(result.value.status).toBe(200); expectHostSettled(f, true);
    });
    test('HG04 adjacent product handoff with unchanged display vector remains allowed', async () => {
        const { f, result } = await sealedScenario('handoff'); expect(result.error).toBeUndefined(); expect(result.value.status).toBe(200); expectHostSettled(f, true);
    });
    test('HG05 ordinary service display drift refuses although its route stays permitted', async () => {
        const { f, result } = await sealedScenario('displayed-service');
        expect(result.error).toBeInstanceOf(DashboardPersistenceError); expect(result.error.code).toBe('dashboard_unavailable'); expectHostSettled(f, false);
    });
    test('HG06 bootstrap subscription-only drift refuses the stale buffer', async () => {
        const { f, result } = await sealedScenario('subscription');
        expect(result.error).toBeInstanceOf(DashboardPersistenceError); expect(result.error.code).toBe('dashboard_unavailable'); expectHostSettled(f, false);
    });
});

// Evidence guard regressions use actual policy evaluation and the controlled
// SQL driver above; durable rollback and RLS have separate PostgreSQL coverage.
describe('request-bound evidence read settlement', () => {
    const CUTOFF = '2026-09-07T09:00:01.000Z';
    const ErrorType = () => require('../api/shared/evidenceMetadataService').EvidenceMetadataError;
    function evidenceHarness(options = {}) {
        const f = harness(options);
        f.snapshot.entitlementState.grants.find(g => g.grantId === 'synthetic-product').modules.push('evidence');
        f.snapshot.entitlementState.grants.forEach(g => g.modules.sort());
        f.snapshot.flags.enabled.evidence = true;
        for (const assignment of f.snapshot.advisorAssignments) {
            assignment.modules = ['evidence']; assignment.permissions = ['evidence.read'];
        }
        return f;
    }
    async function execute(f, binding, work = async () => 'private-metadata') {
        const pair = binding.createOperation('evidence.read');
        try { return await pair.database.withTenantTransaction(f.example.scope.tenantId, tx => work(pair, tx)); }
        finally { await pair.finish(); }
    }
    test('takes direct UPDATE authority locks and never invokes submission quota', async () => {
        const f = evidenceHarness(), binding = await f.bind();
        expect(await execute(f, binding)).toBe('private-metadata');
        expect(dataStorage.loadSnapshotForUpdate).toHaveBeenCalled();
        expect(dataStorage.loadSnapshotForShare).not.toHaveBeenCalled();
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['module', 'product', 'advisor'])('revoked %s authority after work refuses before COMMIT', async kind => {
        const f = evidenceHarness(kind === 'advisor' ? { role: 'fractional_advisor', service: true } : {}), binding = await f.bind();
        const boundary = f.state.trace.length;
        await expectFailure(() => execute(f, binding, async () => {
            if (kind === 'module') f.snapshot.flags.enabled.evidence = false;
            if (kind === 'product') f.snapshot.entitlementState.grants.find(g => g.grantId === 'synthetic-product').validUntil = NOW;
            if (kind === 'advisor') f.snapshot.advisorAssignments[0].permissions = ['assessment.read'];
            return 'must-not-disclose';
        }), ErrorType(), 'evidence_access_denied', 403);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(e => e.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(['membership', 'product', 'advisor'])('acknowledged COMMIT crossing %s expiry withholds buffered metadata', async kind => {
        const options = kind === 'membership' ? { membershipEndsAt: CUTOFF } : kind === 'product'
            ? { grantEndsAt: CUTOFF } : { role: 'fractional_advisor', service: true, assignmentEndsAt: CUTOFF };
        const f = evidenceHarness(options), binding = await f.bind(), boundary = f.state.trace.length;
        f.state.hook = e => { if (e.phase === 'after' && e.sql === 'COMMIT') f.state.at = CUTOFF; };
        await expectFailure(() => execute(f, binding), ErrorType(), 'evidence_access_denied', 403);
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(1);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(0);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test('pre-COMMIT expiry rolls back and retains the typed evidence refusal', async () => {
        const f = evidenceHarness({ grantEndsAt: CUTOFF }), binding = await f.bind(), boundary = f.state.trace.length;
        mockAfterWork = () => { f.state.at = CUTOFF; };
        await expectFailure(() => execute(f, binding), ErrorType(), 'evidence_access_denied', 403);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(e => e.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test('pairs the fixed evidence read event and rejects mutation/module aliases', async () => {
        const f = evidenceHarness(), binding = await f.bind(), context = await f.context(binding);
        await execute(f, binding, async pair => {
            const event = pair.audit.createEvent(context, { action: 'evidence.read', result: 'succeeded', module: 'evidence' });
            await pair.audit.writeEvent(event);
        });
        expect(f.state.auditRows.size).toBe(1);
        for (const row of f.state.auditRows.values()) expect(row.payload).toMatchObject({ action: 'evidence.read', module: 'evidence' });
        for (const action of ['evidence.write', 'evidence.read']) {
            await expectFailure(() => execute(f, binding, async pair => pair.audit.createEvent(context, {
                action, result: 'succeeded', module: action === 'evidence.read' ? 'cyber_security' : 'evidence' })),
            ErrorType(), 'evidence_unavailable', 503);
        }
        expect(f.state.auditRows.size).toBe(1);
    });
});

describe('configured NCSC host presentation remains authority-bound', () => {
    function configured(options = {}) { const f = harness(options); f.options.ncscEnabled = true; return f; }
    test.each(['admin', 'editor'])('current %s authority receives accepted metadata and editable module', async role => {
        const f = configured({ role });
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ module: { key: 'cyber_security', state: 'ready' }, presentationMode: 'editable' });
        expect(result.body.metadata).toEqual(require('../api/shared/ncscQuestionnaireMetadata').createNcscQuestionnaireMetadata());
        frozen(result); expectHostSettled(f, true);
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
    test('bootstrap advertises ready only for configured accepted NCSC and does not expose module metadata', async () => {
        const f = configured(), result = await hostRead(f);
        expect(result.status).toBe(200);
        expect(result.body.modules.find(row => row.key === 'cyber_security').state).toBe('ready');
        expect(result.body.metadata).toBeUndefined(); expect(result.body.presentationMode).toBeUndefined();
    });
    test('without opt-in the accepted profile stays planned without metadata', async () => {
        const f = harness(), result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.module.state).toBe('planned');
        expect(result.body.metadata).toBeUndefined(); expect(result.body.presentationMode).toBeUndefined();
    });
    test('a normal viewer cannot acquire assessment read or edit through presentation', async () => {
        const f = configured({ role: 'viewer' }), result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(403); expect(result.body).toEqual({ code: 'dashboard_access_denied' });
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
    test.each([false, true])('advisor write permission %s determines presentation without expanding authority', async editable => {
        const f = configured({ role: 'fractional_advisor', service: true });
        for (const assignment of f.snapshot.advisorAssignments) assignment.permissions = editable
            ? ['assessment.read', 'assessment.write'] : ['assessment.read'];
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.module.state).toBe('ready');
        expect(result.body.presentationMode).toBe(editable ? 'editable' : 'read-only');
        expect(result.body.metadata.questions.length).toBeGreaterThan(0);
        expectHostSettled(f, true);
    });
    test('independent normal editor authority survives unrelated advisor expiry', async () => {
        const f = configured({ role: 'editor', withAdvisor: true, service: true, assignmentEndsAt: HOST_END });
        let decisions = 0;
        mockAfterHostDecision = () => { if (++decisions === 2) f.state.at = HOST_END; };
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.presentationMode).toBe('editable');
        expect(decisions).toBe(2); expectHostSettled(f, true);
    });
    test.each([false, true])('expired advisor with write=%s cannot release sealed metadata', async editable => {
        const f = configured({ role: 'fractional_advisor', service: true, assignmentEndsAt: HOST_END });
        for (const assignment of f.snapshot.advisorAssignments) assignment.permissions = editable
            ? ['assessment.read', 'assessment.write'] : ['assessment.read'];
        let decisions = 0;
        mockAfterHostDecision = decision => {
            expect(decision.outcome).toBe('succeeded');
            if (++decisions === 2) f.state.at = HOST_END;
        };
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
    });
    test('matching unaccepted profile entitlement and flag remains planned', async () => {
        const f = configured();
        const product = f.snapshot.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
        product.frameworks[0].version = 'unaccepted-version';
        f.snapshot.flags.frameworks[0].version = 'unaccepted-version';
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.module.state).toBe('planned');
        expect(result.body.metadata).toBeUndefined(); expect(result.body.presentationMode).toBeUndefined();
    });
    test('accepted product with mismatched feature profile cannot expose ready questionnaire', async () => {
        const f = configured(); f.snapshot.flags.frameworks[0].version = 'unaccepted-version';
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(403); expect(result.body).toEqual({ code: 'dashboard_access_denied' });
    });
    test('optional activation accepts only explicit own true without invoking getters', () => {
        const f = harness(), getter = jest.fn(() => true);
        for (const ncscEnabled of [false, null, 1, 'true', undefined]) {
            expect(() => factory({ ...f.options, ncscEnabled })).toThrow(DashboardPersistenceError);
        }
        const accessor = { ...f.options };
        Object.defineProperty(accessor, 'ncscEnabled', { get: getter, enumerable: true });
        expect(() => factory(accessor)).toThrow(DashboardPersistenceError); expect(getter).not.toHaveBeenCalled();
        expect(f.pool.connect).not.toHaveBeenCalled();
    });
});

describe('NCSC presentation uses independent write-assignment authority', () => {
    function separate({ writeUntil = END, secondWriteFrom = null } = {}) {
        const f = harness({ role: 'fractional_advisor', service: true }); f.options.ncscEnabled = true;
        const original = clone(f.snapshot.advisorAssignments[0]);
        f.snapshot.advisorAssignments = [
            { ...original, assignmentId: 'synthetic-read-only', permissions: ['assessment.read'] },
            { ...original, assignmentId: 'synthetic-write-only', permissions: ['assessment.write'], validUntil: writeUntil }
        ];
        if (secondWriteFrom) f.snapshot.advisorAssignments.push({ ...original, assignmentId: 'synthetic-second-write',
            permissions: ['assessment.write'], validFrom: secondWriteFrom });
        return f;
    }
    test('separate read and write grants match genuine write policy and allow editable presentation', async () => {
        const f = separate();
        expect(() => require('../api/shared/appLifecycle/dashboardResourceAuthority').resolveNcscAccess(f.snapshot,
            { scope: f.example.scope, identity: { subjectKey: SUBJECT }, resolvedAt: NOW }, 'assessment.write', NOW)).not.toThrow();
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.presentationMode).toBe('editable');
        expect(dataStorage.loadSnapshotForShare).toHaveBeenCalledTimes(5);
        expectHostSettled(f, true);
    });
    test('fresh request after write-only expiry retains read-only metadata', async () => {
        const f = separate({ writeUntil: HOST_END }); f.state.at = HOST_END;
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.presentationMode).toBe('read-only');
        expect(result.body.metadata.questions.length).toBeGreaterThan(0);
        expect(() => require('../api/shared/appLifecycle/dashboardResourceAuthority').resolveNcscAccess(f.snapshot,
            { scope: f.example.scope, identity: { subjectKey: SUBJECT }, resolvedAt: NOW }, 'assessment.write', HOST_END))
            .toThrow(NcscAssessmentError);
    });
    test('write-only expiry after final decision withholds editable buffer despite read staying permitted', async () => {
        const f = separate({ writeUntil: HOST_END }); let decisions = 0;
        mockAfterHostDecision = decision => { expect(decision.outcome).toBe('succeeded'); if (++decisions === 2) f.state.at = HOST_END; };
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
    });
    test('two current write grants deny edit presentation while read remains permitted', async () => {
        const f = separate({ secondWriteFrom: START });
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.status).toBe(200); expect(result.body.presentationMode).toBe('read-only');
        expect(() => require('../api/shared/appLifecycle/dashboardResourceAuthority').resolveNcscAccess(f.snapshot,
            { scope: f.example.scope, identity: { subjectKey: SUBJECT }, resolvedAt: NOW }, 'assessment.write', NOW))
            .toThrow(NcscAssessmentError);
    });
    test('future write grant activation causing ambiguity invalidates sealed editable presentation', async () => {
        const f = separate({ secondWriteFrom: HOST_END }); let decisions = 0;
        mockAfterHostDecision = () => { if (++decisions === 2) f.state.at = HOST_END; };
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
    });
    test('future write grant activation cannot promote an already sealed read-only presentation', async () => {
        const f = separate(); f.snapshot.advisorAssignments[1].validFrom = HOST_END;
        let decisions = 0;
        mockAfterHostDecision = () => { if (++decisions === 2) f.state.at = HOST_END; };
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
    });
    test('proved lost-COMMIT recovery derives fresh read-only mode after independent write expires', async () => {
        const f = separate({ writeUntil: HOST_END }); let lost = false, recoveryStart;
        f.state.hook = event => {
            if (event.phase !== 'after' || event.sql !== 'COMMIT' || lost || !f.state.auditRows.size) return;
            lost = true; recoveryStart = f.state.trace.length; f.state.at = HOST_END;
            throw new Error('synthetic lost COMMIT response');
        };
        const result = await hostRead(f, 'modules/cyber_security');
        expect(lost).toBe(true); expect(result.status).toBe(200); expect(result.body.presentationMode).toBe('read-only');
        const recovery = f.state.trace.slice(recoveryStart);
        expect(recovery.filter(event => /FROM nofries\.dashboard_runtime_audit/.test(event.sql))).toHaveLength(1);
        expect(recovery.filter(event => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(event.sql))).toEqual([]);
        expect(f.options.newId).toHaveBeenCalledTimes(1); expect(f.state.borrows).toBe(f.state.released);
    });
    test('mismatched canonical write snapshot cannot supply edit authority', async () => {
        const f = separate(); let calls = 0;
        dataStorage.loadSnapshotForShare.mockImplementation(async () => {
            const snapshot = clone(f.snapshot);
            if (++calls === 3) snapshot.flags.revision++;
            return snapshot;
        });
        await expectFailure(() => hostRead(f, 'modules/cyber_security'), DashboardPersistenceError, 'unavailable', 503);
        expectHostSettled(f, false); expect(f.state.auditRows.size).toBe(0);
    });
    test('default-off host keeps its original three snapshot reads and planned presentation', async () => {
        const f = separate(); delete f.options.ncscEnabled;
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.body.module.state).toBe('planned'); expect(result.body.presentationMode).toBeUndefined();
        expect(dataStorage.loadSnapshotForShare).toHaveBeenCalledTimes(3);
    });
});

// Improvement source binding uses the real request/session and audit adapters.
// This controlled driver proves transaction ordering, not PostgreSQL durability.
describe('explicit request-bound improvement operations', () => {
    const { ImprovementPlanServiceError } = require('../api/shared/improvementPlan/improvementPlanService');
    const { ImprovementActionListError } = require('../api/shared/improvementPlan/improvementActionListProjection');
    const CUTOFF = '2026-09-07T09:00:01.000Z';
    const cases = [
        ['improvement.list', ImprovementActionListError, 'improvement_list', 'improvement.read'],
        ['improvement.execute', ImprovementPlanServiceError, 'improvement', 'improvement.write']
    ];
    function improvementHarness(options = {}) {
        const f = harness(options);
        f.options.improvementEnabled = true;
        f.snapshot.entitlementState.grants.find(g => g.grantId === 'synthetic-product').modules.push('improvement_plan');
        f.snapshot.entitlementState.grants.forEach(g => g.modules.sort());
        for (const assignment of f.snapshot.advisorAssignments) {
            assignment.modules = ['improvement_plan']; assignment.permissions = ['improvement.read', 'improvement.write'];
        }
        return f;
    }
    async function execute(f, binding, context, operation, work = async () => 'retained-result', assertCurrentAt) {
        const pair = binding.createOperation(operation, context);
        try { return await pair.database.withTenantTransaction(f.example.scope.tenantId, tx => work(pair, tx), assertCurrentAt); }
        finally { pair.finish(); }
    }
    test.each([false, null, undefined, 0, 1, 'true', {}, []])('rejects explicit invalid opt-in %p before I/O', value => {
        const f = harness();
        expect(() => factory({ ...f.options, improvementEnabled: value })).toThrow(DashboardPersistenceError);
        expect(f.options.clock).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test('rejects an accessor opt-in without invoking it', () => {
        const f = harness(), getter = jest.fn(() => true);
        Object.defineProperty(f.options, 'improvementEnabled', { enumerable: true, get: getter });
        expect(() => factory(f.options)).toThrow(DashboardPersistenceError);
        expect(getter).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
    });
    test.each(cases)('%s remains unavailable by default without business I/O', async (operation, Type, prefix) => {
        const f = harness(), binding = await f.bind(), boundary = f.state.trace.length;
        await expectFailure(() => binding.createOperation(operation), Type, prefix + '_unavailable', 503);
        expect(f.state.trace).toHaveLength(boundary);
        const existing = binding.createOperation('admission.read'); existing.finish();
    });
    test.each(cases)('%s requires an exact canonical branded context before business I/O', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        const foreign = await f.context({ ...binding, requestId: uuid(999) });
        for (const candidate of [undefined, clone(context), foreign]) {
            await expectFailure(() => binding.createOperation(operation, candidate), Type, prefix + '_access_denied', 403);
        }
        expect(f.state.trace).toHaveLength(boundary);
        expect(await execute(f, binding, context, operation)).toBe('retained-result');
    });
    test.each(cases)('%s takes UPDATE directly and acknowledges only its paired canonical event', async (operation, Type, prefix, action) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        const before = f.state.borrows;
        await execute(f, binding, context, operation, async pair => {
            const event = pair.audit.createEvent(context, { action, module: 'improvement_plan', result: 'succeeded' });
            await expectFailure(() => pair.audit.writeEvent(clone(event)), Type, prefix + '_unavailable', 503);
            const receipt = await pair.audit.writeEvent(event);
            expect(receipt).toEqual({ eventId: event.eventId, delivery: 'acknowledged' });
            expect(Object.isFrozen(receipt)).toBe(true);
            await pair.audit.writeEvent(event);
        });
        expect(f.state.borrows - before).toBe(1);
        expect(dataStorage.loadSnapshotForUpdate).toHaveBeenCalledTimes(2);
        expect(dataStorage.loadSnapshotForShare).not.toHaveBeenCalled();
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
        expect(f.state.auditRows.size).toBe(1);
        expect([...f.state.auditRows.values()][0].payload).toMatchObject({ action, module: 'improvement_plan',
            requestId: context.requestId, actorSubjectKey: context.identity.subjectKey, ...context.scope });
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => /INSERT INTO nofries\.dashboard_runtime_audit/.test(e.sql))).toHaveLength(1);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(1);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(cases)('%s refuses a different action and rolls back the entered transaction', async (operation, Type, prefix, action) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        await expectFailure(() => execute(f, binding, context, operation, async pair => {
            const event = pair.audit.createEvent(context, { action: action === 'improvement.read' ? 'improvement.write' : 'improvement.read',
                module: 'improvement_plan', result: 'succeeded' });
            await pair.audit.writeEvent(event);
        }), Type, prefix + '_unavailable', 503);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(e => e.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
        expect(f.state.auditRows.size).toBe(0);
    });
    test.each(cases)('%s denies missing module access before calling business work', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), work = jest.fn();
        f.snapshot.flags.enabled.improvement_plan = false;
        await expectFailure(() => execute(f, binding, context, operation, work), Type, prefix + '_access_denied', 403);
        expect(work).not.toHaveBeenCalled(); expect(f.state.auditRows.size).toBe(0);
    });
    test.each(cases)('%s rejects authority revoked during work before COMMIT', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        await expectFailure(() => execute(f, binding, context, operation, async () => {
            f.snapshot.flags.enabled.improvement_plan = false; return 'must-not-disclose';
        }), Type, prefix + '_access_denied', 403);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(e => e.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test.each(cases)('%s withholds disclosure after acknowledged COMMIT crosses access expiry', async (operation, Type, prefix) => {
        const f = improvementHarness({ grantEndsAt: CUTOFF }), binding = await f.bind(), context = await f.context(binding);
        const boundary = f.state.trace.length;
        f.state.hook = event => { if (event.phase === 'after' && event.sql === 'COMMIT') f.state.at = CUTOFF; };
        await expectFailure(() => execute(f, binding, context, operation), Type, prefix + '_access_denied', 403);
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(1);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(0);
        expect(f.state.borrows).toBe(f.state.released);
    });
    test.each(cases)('%s aborts before COMMIT when the deadline expires after callback finalization', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        mockAfterWork = () => { f.state.at = '2026-09-07T09:01:00.000Z'; };
        await expectFailure(() => execute(f, binding, context, operation), Type, prefix + '_unavailable', 503);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(e => e.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test.each(cases)('%s rejects nonfunction assertions before transaction I/O', async (operation, Type, prefix) => {
        for (const assertion of [null, false, 1, {}, []]) {
            const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
            const work = jest.fn();
            await expectFailure(() => execute(f, binding, context, operation, work, assertion), Type, prefix + '_unavailable', 503);
            expect(work).not.toHaveBeenCalled(); expect(f.state.trace).toHaveLength(boundary);
        }
    });
    test('rejects an assertion on admission.read before transaction I/O', async () => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        const work = jest.fn(), assertion = jest.fn();
        await expectFailure(() => execute(f, binding, context, 'admission.read', work, assertion), DashboardPersistenceError, 'unavailable', 503);
        expect(work).not.toHaveBeenCalled(); expect(assertion).not.toHaveBeenCalled(); expect(f.state.trace).toHaveLength(boundary);
    });
    test.each(cases)('%s samples its successful assertion after work and retires it at settlement', async operation => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding);
        const pair = binding.createOperation(operation, context);
        let workFinished = false;
        const assertion = jest.fn(at => { expect(workFinished).toBe(true); expect(at).toBe(NOW); });
        expect(await pair.database.withTenantTransaction(f.example.scope.tenantId, async () => {
            pair.clock(); expect(assertion).not.toHaveBeenCalled(); workFinished = true; return 'retained-result';
        }, assertion)).toBe('retained-result');
        expect(assertion).toHaveBeenCalled();
        const count = assertion.mock.calls.length;
        pair.clock(); expect(assertion).toHaveBeenCalledTimes(count); pair.finish();
    });
    test.each(cases)('%s does not run its assertion when business work fails', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), assertion = jest.fn();
        await expectFailure(() => execute(f, binding, context, operation, async () => {
            throw new Error('driver-private work');
        }, assertion), Type, prefix + '_unavailable', 503);
        expect(assertion).not.toHaveBeenCalled();
    });
    test.each(cases)('%s requires an assertion to return undefined without inspecting returned thenables', async (operation, Type, prefix) => {
        const then = jest.fn(), getter = jest.fn(() => then), thenable = {};
        Object.defineProperty(thenable, 'then', { get: getter });
        for (const result of [true, null, 0, NaN, {}, thenable]) {
            const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
            await expectFailure(() => execute(f, binding, context, operation, undefined, () => result), Type, prefix + '_unavailable', 503);
            expect(f.state.trace.slice(boundary).some(event => event.sql === 'COMMIT')).toBe(false);
        }
        expect(getter).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled();
    });
    test.each(cases)('%s rejects an asynchronous assertion without awaiting or allowing COMMIT', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        await expectFailure(() => execute(f, binding, context, operation, undefined, async () => {
            throw new Error('driver-private asynchronous assertion');
        }), Type, prefix + '_unavailable', 503);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(event => event.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test.each(cases)('%s sanitizes an arbitrary assertion failure', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding);
        await expectFailure(() => execute(f, binding, context, operation, undefined, () => {
            throw new Error('driver-private credential secret');
        }), Type, prefix + '_unavailable', 503);
    });
    test.each(cases)('%s rechecks its assertion after awaited COMMIT timeout preparation', async operation => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        let expired = false;
        f.state.hook = event => {
            if (event.phase === 'after' && event.sql === "SELECT set_config('statement_timeout', $1, true)" &&
                dataStorage.loadSnapshotForUpdate.mock.calls.length === 2) expired = true;
        };
        await expectFailure(() => execute(f, binding, context, operation, undefined, () => {
            if (expired) throw new ImprovementPlanServiceError('improvement_owner_ineligible', 409);
        }), ImprovementPlanServiceError, 'improvement_owner_ineligible', 409);
        expect(expired).toBe(true);
        const trace = f.state.trace.slice(boundary);
        expect(trace.some(event => event.sql === 'COMMIT')).toBe(false);
        expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test.each(cases)('%s withholds its result when the assertion expires after acknowledged COMMIT', async operation => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        let committed = false;
        f.state.hook = event => { if (event.phase === 'after' && event.sql === 'COMMIT') committed = true; };
        await expectFailure(() => execute(f, binding, context, operation, undefined, () => {
            if (committed) throw new ImprovementPlanServiceError('improvement_owner_ineligible', 409);
        }), ImprovementPlanServiceError, 'improvement_owner_ineligible', 409);
        const trace = f.state.trace.slice(boundary);
        expect(trace.filter(event => event.sql === 'COMMIT')).toHaveLength(1);
        expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(0);
    });
    test.each(cases)('%s assertion cannot recursively sample its paired clock', async (operation, Type, prefix) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding);
        let captured;
        await expectFailure(() => execute(f, binding, context, operation, async pair => { captured = pair; }, () => {
            // Even catching the nested refusal cannot turn the assertion valid.
            try { captured.clock(); } catch (_) { /* Deliberate hostile trusted callback. */ }
        }), Type, prefix + '_unavailable', 503);
    });
    test.each([['improvement_not_found', 404], ['improvement_owner_ineligible', 409], ['improvement_access_denied', 403]])
    ('improvement.list preserves a branded editor %s failure after awaited work', async (code, status) => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        const error = new ImprovementPlanServiceError(code, status);
        await expect(execute(f, binding, context, 'improvement.list', async () => {
            await Promise.resolve(); throw error;
        })).rejects.toBe(error);
        expect(f.state.trace.slice(boundary).some(event => event.sql === 'COMMIT')).toBe(false);
        expect(f.state.trace.slice(boundary).filter(event => event.sql === 'ROLLBACK')).toHaveLength(1);
    });
    test('does not introduce an improvement evidence-resolution operation', async () => {
        const f = improvementHarness(), binding = await f.bind(), context = await f.context(binding), boundary = f.state.trace.length;
        await expectFailure(() => binding.createOperation('improvement.evidence', context), DashboardPersistenceError, 'unavailable', 503);
        expect(f.state.trace).toHaveLength(boundary);
    });
});

describe('mounted Improvement Plan readiness projection', () => {
    function configured(options = {}) {
        const f = harness(options); f.options.improvementEnabled = true;
        f.snapshot.entitlementState.grants.find(row => row.grantId === 'synthetic-product').modules.push('improvement_plan');
        f.snapshot.entitlementState.grants.forEach(row => row.modules.sort());
        return f;
    }
    test.each(['admin', 'editor'])('configured %s receives a ready module without inferred editing authority', async role => {
        const f = configured({ role }), result = await hostRead(f, 'modules/improvement_plan');
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ module: { key: 'improvement_plan', state: 'ready' },
            summary: { state: 'empty', attention: [], metrics: [] }, admissionGranted: false, providerAccessGranted: false });
        expect(result.body.metadata).toBeUndefined(); expect(result.body.presentationMode).toBeUndefined();
        expect(dataStorage.loadSnapshotForUpdate).not.toHaveBeenCalled();
        expect(dataStorage.loadSnapshotForShare).toHaveBeenCalledTimes(3);
        frozen(result); expectHostSettled(f, true);
    });
    test('bootstrap readiness uses the existing opt-in without promoting other planned workspaces', async () => {
        const f = configured(), result = await hostRead(f);
        expect(result.body.modules.find(row => row.key === 'improvement_plan').state).toBe('ready');
        expect(result.body.modules.find(row => row.key === 'cyber_security').state).toBe('planned');
        expect(result.body.metadata).toBeUndefined(); expect(result.body.presentationMode).toBeUndefined();
        expectHostSettled(f, true);
    });
    test.each(['bootstrap', 'modules/improvement_plan'])('default-off %s retains planned display and existing shape', async route => {
        const f = configured(); delete f.options.improvementEnabled;
        const result = await hostRead(f, route);
        const module = route === 'bootstrap' ? result.body.modules.find(row => row.key === 'improvement_plan') : result.body.module;
        expect(module.state).toBe('planned'); expect(result.body.metadata).toBeUndefined();
        expect(result.body.presentationMode).toBeUndefined(); expectHostSettled(f, true);
    });
    test('a disabled Improvement feature remains disabled in bootstrap and denies module access', async () => {
        const f = configured(); f.snapshot.flags.enabled.improvement_plan = false;
        const result = await hostRead(f);
        expect(result.body.modules.find(row => row.key === 'improvement_plan').state).toBe('disabled');
        const direct = configured(); direct.snapshot.flags.enabled.improvement_plan = false;
        const denial = await hostRead(direct, 'modules/improvement_plan');
        expect(denial.status).toBe(403); expect(denial.body).toEqual({ code: 'dashboard_access_denied' });
    });
    test('an opt-in cannot expose Improvement outside the current product entitlement', async () => {
        const f = configured(); f.snapshot.entitlementState.grants[0].modules = ['cyber_security', 'overview', 'services'];
        const result = await hostRead(f);
        expect(result.body.modules.some(row => row.key === 'improvement_plan')).toBe(false);
        expectHostSettled(f, true);
    });
    test('an ordinary viewer remains denied despite configured mounted readiness', async () => {
        const f = configured({ role: 'viewer' }), result = await hostRead(f, 'modules/improvement_plan');
        expect(result.status).toBe(403); expect(result.body).toEqual({ code: 'dashboard_access_denied' });
        expect(f.options.resolveSubmissionQuota).not.toHaveBeenCalled();
    });
    test('a scoped read-only advisor can receive readiness without a write or Cyber grant', async () => {
        const f = configured({ role: 'fractional_advisor', service: true });
        for (const assignment of f.snapshot.advisorAssignments) {
            assignment.modules = ['improvement_plan']; assignment.permissions = ['improvement.read'];
        }
        const result = await hostRead(f, 'modules/improvement_plan');
        expect(result.status).toBe(200); expect(result.body.module.state).toBe('ready');
        expect(result.body.presentationMode).toBeUndefined(); expect(result.body.metadata).toBeUndefined();
        expectHostSettled(f, true);
    });
    test('revocation after the first admission cannot disclose an initially ready projection', async () => {
        const f = configured(); let decisions = 0;
        mockAfterHostDecision = value => {
            if (++decisions === 1) { expect(value.outcome).toBe('succeeded');
                f.snapshot.flags.enabled.improvement_plan = false; f.snapshot.flags.revision++; }
        };
        await expectFailure(() => hostRead(f, 'modules/improvement_plan'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
        expect([...f.state.auditRows.values()][0].payload.outcome).toBe('succeeded');
    });
    test('product expiry after the final decision prevents COMMIT of a ready projection', async () => {
        const f = configured({ grantEndsAt: HOST_END }); let decisions = 0;
        mockAfterHostDecision = () => { if (++decisions === 2) f.state.at = HOST_END; };
        await expectFailure(() => hostRead(f, 'modules/improvement_plan'), DashboardPersistenceError, 'unavailable', 503);
        expect(decisions).toBe(2); expectHostSettled(f, false);
    });
    test('product expiry after acknowledged COMMIT withholds ready display without claiming rollback', async () => {
        const f = configured({ grantEndsAt: HOST_END });
        f.state.hook = event => {
            if (event.phase === 'after' && event.sql === 'COMMIT' && f.state.auditRows.size) f.state.at = HOST_END;
        };
        await expectFailure(() => hostRead(f, 'modules/improvement_plan'), DashboardPersistenceError, 'unavailable', 503);
        expectHostSettled(f, true); expect(f.state.auditRows.size).toBe(1);
    });
    test('combined opt-ins preserve the independently qualified NCSC metadata behavior', async () => {
        const f = configured(); f.options.ncscEnabled = true;
        const result = await hostRead(f, 'modules/cyber_security');
        expect(result.body.module.state).toBe('ready'); expect(result.body.presentationMode).toBe('editable');
        expect(result.body.metadata).toEqual(require('../api/shared/ncscQuestionnaireMetadata').createNcscQuestionnaireMetadata());
        expectHostSettled(f, true);
    });
});
