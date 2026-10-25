'use strict';

// The first describe exercises composition and closed inputs without a database.
// The second requires a real restricted PostgreSQL connection. Test providers
// and identities are explicit synthetic facts, never production policy/proof.
// Selected timing regressions delegate to the genuine helper. The historical
// suite takes the identical direct path when no delegate is installed.
let mockResourceAfterWork = null;
let mockRuntimeAfterReconcile = null;
let mockAfterHostDecision = null;
jest.mock('../../api/shared/dashboardAdmission', () => {
    const actual = jest.requireActual('../../api/shared/dashboardAdmission');
    return { ...actual, createDashboardAdmissionDecision(adapters) {
        const decide = actual.createDashboardAdmissionDecision(adapters);
        return async (...args) => {
            const value = await decide(...args);
            if (mockAfterHostDecision) await mockAfterHostDecision(value);
            return value;
        };
    } };
});
jest.mock('../../api/shared/appLifecycle/dashboardOnboardingDomain', () => {
    const actual = jest.requireActual('../../api/shared/appLifecycle/dashboardOnboardingDomain');
    return { ...actual, reconcileAcceptanceReceipt(facts) {
        const result = actual.reconcileAcceptanceReceipt(facts);
        if (mockRuntimeAfterReconcile) mockRuntimeAfterReconcile(facts, result);
        return result;
    } };
});
jest.mock('../../api/shared/database/postgres', () => {
    const actual = jest.requireActual('../../api/shared/database/postgres');
    return { ...actual, createPostgresDatabase(options) {
        const database = actual.createPostgresDatabase(options);
        return Object.freeze({ ...database, withTenantTransaction(tenantId, work) {
            const afterWork = mockResourceAfterWork;
            if (!afterWork) return database.withTenantTransaction(tenantId, work);
            return database.withTenantTransaction(tenantId, async tx => {
                const value = await work(tx); afterWork(); return value;
            });
        } });
    } };
});
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const domain = require('../../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createTenantAggregate } = require('../../api/shared/appLifecycle/tenantDomain');
const { createMembershipState, applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { createPostgresDatabase } = require('../../api/shared/database/postgres');
const { createPostgresDashboardRepository, DashboardPersistenceError } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { NcscAssessmentError } = require('../../api/shared/ncscAssessmentService');
const { createDashboardResourceRuntime } = require('../../api/shared/dashboardRuntime');
const { ncscFixture, createNcscAdapters, createCommand, saveCommand, submitCommand,
    SUBJECT: NCSC_SUBJECT } = require('../fixtures/ncscAssessmentFixture');
const { applyMigrations } = require('../../scripts/db-migrate');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const START = '2026-09-07T00:00:00.000Z';
const NOW = '2026-09-07T01:00:00.000Z';
const ACCEPT_BEFORE = '2026-09-07T04:00:00.000Z';
const END = '2027-09-07T00:00:00.000Z';
const BUDGET = Object.freeze({ maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 });
const uid = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const DATA_TABLES = Object.freeze(['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states',
    'dashboard_entitlement_states', 'dashboard_feature_flags', 'dashboard_advisor_assignments',
    'dashboard_usage', 'dashboard_operation_receipts']);
const RUNTIME_TABLES = Object.freeze(['dashboard_runtime_instance', 'dashboard_admission_authorities',
    'dashboard_admission_decisions', 'dashboard_onboarding_cases', 'dashboard_onboarding_proofs',
    'dashboard_onboarding_decisions', 'dashboard_identity_bindings', 'dashboard_session_gates',
    'dashboard_runtime_receipts', 'dashboard_runtime_audit']);
const NCSC_TABLES = Object.freeze(['dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts']);
const RUNTIME_METHODS = Object.freeze(['initializeOperatorSession', 'activateCustomerSession',
    'recordProofAndActivateDiscovery', 'selectBinding', 'revokeSession', 'createCase', 'approveCase',
    'revokeCase', 'denyCase', 'expireCase', 'acceptStagedOnboarding', 'publishExistingMembershipBinding',
    'readSession', 'discoverBindings', 'lookupCaseCapability', 'readOnboardingStatus', 'recordRuntimeEvent']);
const MAINTENANCE_METHODS = Object.freeze(['publishAdmissionDecision', 'withdrawAdmissionDecision',
    'initializeRuntimeInstance', 'fenceRestoreEpoch', 'enableRuntimeIngress']);
const RECEIPT_COLUMNS = Object.freeze(['receipt_id', 'anchor_kind', 'anchor_session_sha256', 'anchor_case_id',
    'anchor_authority_id', 'anchor_binding_id', 'anchor_instance_id', 'tenant_id', 'organisation_id', 'operation_id',
    'operation_type', 'intent_sha256', 'result_sha256', 'occurred_at', 'actor_subject_key', 'payload',
    'runtime_instance_id', 'scope_json', 'audit_event_id', 'audit_event_sha256', 'acceptance_case_id',
    'related_case_id', 'related_proof_id', 'related_identity_sha256', 'instance_result_revision', 'instance_result_sha256']);
const EMPTY_REVISIONS = Object.freeze({ tenant: null, organisation: null, membership: null,
    entitlement: null, flags: null, advisorAssignments: [], usage: [] });

function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const hash = value => digest(canonical(value));
function identity(oid = uid(2)) {
    return { policyId: 'synthetic-runtime-policy', policyRevision: 1,
        issuer: 'https://identity.example.test/runtime/v2.0', identityTenantId: uid(1), oid,
        audience: 'synthetic-runtime-client' };
}
const subject = value => value.identityTenantId + ':' + value.oid;
function template(scope = { tenantId: 'synthetic-runtime-tenant', organisationId: 'synthetic-runtime-org' }, bindingId = uid(20), kind = 'bootstrap') {
    const result = { schemaVersion: 1, kind, scope: clone(scope), bindingId,
        membership: { invitationId: 'approved-invitation', membershipId: 'approved-member', roles: ['admin'],
            validFrom: START, validUntil: END, grantEvidenceId: 'synthetic-role-approval' } };
    if (kind === 'bootstrap') result.bootstrap = {
        tenantAggregate: createTenantAggregate({ schemaVersion: 1,
            tenant: { schemaVersion: 1, tenantId: scope.tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 },
            organisations: [{ schemaVersion: 1, ...scope, displayName: 'Synthetic organisation', domains: [], recordStatus: 'active', revision: 0 }] }),
        entitlementState: { schemaVersion: 1, ...scope, revision: 0, grants: [{ ...scope,
            grantId: 'synthetic-base-grant', code: 'dashboard_score', status: 'active', validFrom: START, validUntil: END,
            agreementRef: 'synthetic-approved-agreement', modules: ['overview'], frameworks: [],
            limits: { memberships: 8 }, coverage: [], actions: [] }] },
        flags: { ...scope, revision: 0, enabled: { dashboard: true, overview: true }, frameworks: [] }, advisorGrants: [] };
    return result;
}
function commandFor(method) {
    const operationId = uid(30), authorityRef = { authorityId: uid(31), revision: 0, sha256: 'a'.repeat(64) };
    const expected = { operationId, caseId: uid(32), expectedRevision: 1, expectedHeadSha256: 'b'.repeat(64) };
    if (['initializeOperatorSession', 'recordProofAndActivateDiscovery', 'revokeSession'].includes(method)) return { operationId };
    if (method === 'activateCustomerSession') return { operationId, bindingId: uid(20) };
    if (method === 'selectBinding') return { operationId, bindingId: uid(20), expectedGeneration: 'c'.repeat(64) };
    if (method === 'createCase') return { operationId, caseId: uid(32), templateRef: 'synthetic-template-v1', template: template(), acceptBefore: ACCEPT_BEFORE, authorityRef };
    if (method === 'approveCase') return { ...expected, approvalId: uid(33), acceptBefore: ACCEPT_BEFORE, authorityRef };
    if (['revokeCase', 'denyCase'].includes(method)) return { ...expected, authorityRef };
    if (method === 'expireCase') return expected;
    if (method === 'acceptStagedOnboarding') return { operationId, approvalId: uid(33), approvalRevision: 2 };
    if (method === 'publishExistingMembershipBinding') return { operationId, bindingId: uid(20), scope: template().scope,
        membershipId: 'approved-member', invitationId: 'approved-invitation', grantEvidenceId: 'synthetic-role-approval',
        identity: identity(), validFrom: START, validUntil: END, authorityRef };
    if (['publishAdmissionDecision', 'withdrawAdmissionDecision'].includes(method)) return {
        operationId, actorSubjectKey: subject(identity()), authorityId: uid(31), expectedRevision: null, expectedHeadSha256: null,
        payload: { target: template().scope, identityPolicyRef: { policyId: identity().policyId, policyRevision: 1 },
            approvedEffectSha256: hash(domain.normaliseTemplate(template())), evidenceRefs: [{ kind: 'approval', id: 'synthetic-approval', sha256: 'd'.repeat(64) }],
            validFrom: START, validUntil: END } };
    return { operationId, actorSubjectKey: subject(identity()), expectedRevision: null, expectedRecordSha256: null,
        restoreEpoch: uid(41), evidenceRef: 'synthetic-restore-evidence', evidenceSha256: 'e'.repeat(64) };
}
function modules() { return require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository'); }
function noDatabaseOptions(maintenance = false) {
    const pool = { connect: jest.fn(async () => { throw new Error('SQL must not be borrowed'); }), end: jest.fn() };
    const options = { pool, clock: jest.fn(() => NOW), instanceId: uid(40), historyBudget: { ...BUDGET },
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(40), restoreEpoch: uid(41) })), newId: jest.fn(() => uid(50)) };
    if (maintenance) options.authoriseMaintenanceOperation = jest.fn(() => false);
    else Object.assign(options, { captureRequest: jest.fn(async () => null), readVerifiedOnboardingProof: jest.fn(async () => null),
        readPreparedCaseCapability: jest.fn(async () => null), authoriseOperatorOperation: jest.fn(() => false),
        newGenerationToken: jest.fn(() => 'f'.repeat(64)) });
    return options;
}
function instantiate(options, maintenance = false) {
    return modules()[maintenance ? 'createPostgresDashboardMaintenanceRepository' : 'createPostgresDashboardRuntimeRepository'](options);
}
function expectError(error, code, statusCode) {
    expect(error).toBeInstanceOf(domain.DashboardOnboardingError);
    expect(error).toMatchObject({ code, statusCode });
    expect(error.message).not.toMatch(/SQL must|synthetic driver|credential/i);
}
async function rejectsCode(work, code, statusCode) {
    const result = await settled(Promise.resolve().then(work));
    expectError(result.error, code, statusCode);
    return result.error;
}
function deeplyFrozen(value) {
    if (!value || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(deeplyFrozen);
}

const atMillis = milliseconds => new Date(Date.parse(NOW) + milliseconds).toISOString();
const isRuntimeTimeout = sql => sql === "SELECT set_config('statement_timeout', $1, true)";
const isRuntimeReset = sql => sql === 'SET LOCAL statement_timeout = 0';
async function timingPhase(latch, result) {
    return Promise.race([latch.promise, result.then(() => { throw new Error('operation settled before required timing phase'); })]);
}
function timingLatch() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
// This driver acknowledges only transaction/role/GUC/fence controls. It stops
// at the first retained SELECT and never supplies synthetic stored authority.
function rawTimingControl({ method = 'initializeOperatorSession', duration = 1000,
    capturedDuration = duration, elapsed = 0 } = {}) {
    const maintenance = method === 'initializeRuntimeInstance';
    const options = noDatabaseOptions(maintenance);
    const state = { now: NOW, clockCalls: 0, trace: [], before: null, after: null, borrow: null, stopped: 0 };
    options.clock = jest.fn(() => { state.clockCalls++; return state.now; });
    options.historyBudget = { ...BUDGET, maxDurationMs: duration };
    const seed = { sessionSha256: '1'.repeat(64), kind: 'operator_dashboard', identityPayload: identity(),
        instanceId: uid(40), restoreEpoch: uid(41), issuedAt: START, expiresAt: END, discovery: null,
        operatorIssuanceProof: domain.normaliseOperatorIssuanceProof({ schemaVersion: 1,
            kind: 'operator_dashboard_issuance', sessionSha256: '1'.repeat(64), identitySha256: hash(identity()),
            instanceId: uid(40), restoreEpoch: uid(41), issuedAt: START, expiresAt: END }) };
    if (!maintenance) options.captureRequest = jest.fn(async () => {
        state.now = atMillis(elapsed);
        return { requestId: uid(72), deadline: atMillis(capturedDuration), ...seed };
    });
    if (maintenance) options.readExternalRuntimeEpoch = jest.fn(async () => {
        state.now = atMillis(elapsed); return { instanceId: uid(40), restoreEpoch: uid(41) };
    });
    const client = { release: jest.fn(), query: jest.fn(async (sql, params) => {
        state.trace.push({ sql, params: params === undefined ? undefined : clone(params) });
        if (state.before) await state.before(sql, params);
        if (/\bFROM nofries\./i.test(sql)) {
            state.stopped++; throw new Error('synthetic driver stops before retained authority');
        }
        if (!/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE |SET LOCAL statement_timeout = 0|SELECT (set_config\(|pg_advisory_))/i.test(sql)) {
            throw new Error('unexpected SQL in control-only driver');
        }
        const result = { rows: [], rowCount: 0 };
        if (state.after) await state.after(sql, params);
        return result;
    }) };
    options.pool = { end: jest.fn(), connect: jest.fn(async () => {
        if (method === 'lookupCaseCapability') state.now = atMillis(elapsed);
        if (state.borrow) await state.borrow();
        return client;
    }) };
    const repository = instantiate(options, maintenance);
    const invoke = () => method === 'lookupCaseCapability'
        ? repository.lookupCaseCapability({ capability: Buffer.alloc(32, 12).toString('base64url') })
        : maintenance ? repository.initializeRuntimeInstance(commandFor(method))
            : repository.initializeOperatorSession(Object.freeze({ syntheticTimingRequest: true }), commandFor(method));
    return { state, options, client, invoke };
}
function expectRemainingPreparations(trace, maximum) {
    let live = false, targets = 0;
    for (let index = 0; index < trace.length; index++) {
        const event = trace[index];
        if (/^BEGIN(?: READ ONLY)?$/.test(event.sql)) { expect(index === 0 || !isRuntimeTimeout(trace[index - 1].sql)).toBe(true); live = true; continue; }
        if (isRuntimeReset(event.sql)) continue;
        if (event.sql === 'ROLLBACK') { live = false; continue; }
        if (isRuntimeTimeout(event.sql)) {
            expect(live).toBe(true); expect(event.params).toHaveLength(1);
            expect(event.params[0]).toMatch(/^[1-9][0-9]*$/);
            expect(Number(event.params[0])).toBeLessThanOrEqual(maximum);
            expect(index === 0 || !isRuntimeTimeout(trace[index - 1].sql)).toBe(true);
            continue;
        }
        expect(live).toBe(true); expect(trace[index - 1].sql).toBe("SELECT set_config('statement_timeout', $1, true)");
        targets++;
        if (event.sql === 'COMMIT') live = false;
    }
    expect(targets).toBeGreaterThan(0);
}

module.exports = function registerDashboardRuntimePostgresTests() {
    describe('Dashboard runtime closed composition without SQL', () => {
        test('exports only fixed runtime, maintenance and administration factories without a raw database capability', () => {
            expect(Object.keys(modules()).sort()).toEqual(['createPostgresDashboardAdministrationRepository', 'createPostgresDashboardMaintenanceRepository', 'createPostgresDashboardRuntimeRepository']);
            for (const maintenance of [false, true]) {
                const options = noDatabaseOptions(maintenance), repository = instantiate(options, maintenance);
                expect(Object.keys(repository).sort()).toEqual([...(maintenance ? MAINTENANCE_METHODS : RUNTIME_METHODS)].sort());
                expect(Object.isFrozen(repository)).toBe(true);
                expect(options.pool.connect).not.toHaveBeenCalled();
                expect(options.pool.end).not.toHaveBeenCalled();
                expect(options.clock).not.toHaveBeenCalled();
            }
        });
        for (const maintenance of [false, true]) {
            const label = maintenance ? 'maintenance' : 'runtime';
            for (const key of Object.keys(noDatabaseOptions(maintenance))) {
                test(`${label} requires explicit ${key} before any provider or pool use`, () => {
                    const options = noDatabaseOptions(maintenance); delete options[key];
                    let error; try { instantiate(options, maintenance); } catch (caught) { error = caught; }
                    expectError(error, 'onboarding_input_invalid', 400);
                    if (options.pool) expect(options.pool.connect).not.toHaveBeenCalled();
                });
            }
            test.each([
                ['records zero', { ...BUDGET, maxRecords: 0 }], ['records negative zero', { ...BUDGET, maxRecords: -0 }],
                ['records ceiling', { ...BUDGET, maxRecords: 4097 }], ['bytes ceiling', { ...BUDGET, maxBytes: 67108865 }],
                ['duration ceiling', { ...BUDGET, maxDurationMs: 60001 }], ['fraction', { ...BUDGET, maxRecords: 1.5 }],
                ['missing', { maxRecords: 1, maxBytes: 100 }], ['extra', { ...BUDGET, reset: true }]
            ])(`${label} rejects invalid explicit history budget: %s`, (_label, historyBudget) => {
                const options = { ...noDatabaseOptions(maintenance), historyBudget };
                let error; try { instantiate(options, maintenance); } catch (caught) { error = caught; }
                expectError(error, 'onboarding_input_invalid', 400);
                expect(options.pool.connect).not.toHaveBeenCalled();
            });
            test(`${label} does not evaluate configuration getters or proxies`, () => {
                let hooks = 0;
                const options = noDatabaseOptions(maintenance);
                Object.defineProperty(options, 'historyBudget', { enumerable: true, get() { hooks++; return BUDGET; } });
                for (const value of [options, new Proxy(noDatabaseOptions(maintenance), { ownKeys() { hooks++; return []; } })]) {
                    let error; try { instantiate(value, maintenance); } catch (caught) { error = caught; }
                    expectError(error, 'onboarding_input_invalid', 400);
                }
                expect(hooks).toBe(0);
            });
        }
        const mutations = [...RUNTIME_METHODS.slice(0, 12), ...MAINTENANCE_METHODS];
        test.each(mutations)('%s rejects injected authority/callback before the first provider or SQL access', async method => {
            const maintenance = MAINTENANCE_METHODS.includes(method), options = noDatabaseOptions(maintenance);
            const repository = instantiate(options, maintenance), command = { ...commandFor(method), sql: () => true };
            await rejectsCode(() => maintenance ? repository[method](command) : repository[method]({}, command), 'onboarding_input_invalid', 400);
            expect(options.pool.connect).not.toHaveBeenCalled(); expect(options.clock).not.toHaveBeenCalled();
            expect(options.readExternalRuntimeEpoch).not.toHaveBeenCalled();
            if (!maintenance) expect(options.captureRequest).not.toHaveBeenCalled();
        });
        test.each(['getter', 'proxy', 'symbol key', 'NUL', 'lone high surrogate', 'lone low surrogate'])('rejects %s command without running hostile hooks', async variant => {
            const options = noDatabaseOptions(), repository = instantiate(options); let hooks = 0;
            let command = { operationId: uid(60) };
            if (variant === 'getter') Object.defineProperty(command, 'operationId', { enumerable: true, get() { hooks++; return uid(60); } });
            else if (variant === 'proxy') command = new Proxy(command, { ownKeys() { hooks++; return ['operationId']; } });
            else if (variant === 'symbol key') command[Symbol('unexpected-command-key')] = true;
            else command.operationId = variant === 'NUL' ? '\u0000' : variant === 'lone high surrogate' ? '\ud800' : '\udc00';
            await rejectsCode(() => repository.initializeOperatorSession({}, command), 'onboarding_input_invalid', 400);
            expect(hooks).toBe(0); expect(options.captureRequest).not.toHaveBeenCalled(); expect(options.pool.connect).not.toHaveBeenCalled();
        });
        test.each([['null', 'onboarding_access_denied', 403], ['throw', 'onboarding_unavailable', 503], ['reject', 'onboarding_unavailable', 503]])(
            'capture %s has a fixed sanitized result before database access', async (kind, code, status) => {
                const options = noDatabaseOptions();
                options.captureRequest = jest.fn(() => { if (kind === 'throw') throw Object.assign(new Error('synthetic driver credential'), { code: 'attacker', statusCode: 201 });
                    return kind === 'reject' ? Promise.reject(new Error('synthetic driver credential')) : null; });
                const request = Object.freeze({ syntheticRequest: true });
                await rejectsCode(() => instantiate(options).initializeOperatorSession(request, { operationId: uid(60) }), code, status);
                expect(options.captureRequest).toHaveBeenCalledWith(request); expect(options.pool.connect).not.toHaveBeenCalled();
            });
        test.each(['bad', '2026-02-30T00:00:00.000Z', '9999-12-31T23:59:59.999Z'])('invalid/overflowing clock %s cannot enter SQL', async time => {
            const options = noDatabaseOptions(); options.clock = () => time;
            await rejectsCode(() => instantiate(options).initializeOperatorSession({}, { operationId: uid(60) }), 'onboarding_unavailable', 503);
            expect(options.pool.connect).not.toHaveBeenCalled(); expect(options.captureRequest).not.toHaveBeenCalled();
        });
        test.each(['', 'a'.repeat(64), 'A'.repeat(42), 'A'.repeat(42) + '=', 'A'.repeat(42) + 'B'])('rejects noncanonical bearer locator without capture or SQL (%s)', async capability => {
            const options = noDatabaseOptions();
            await rejectsCode(() => instantiate(options).lookupCaseCapability({ capability }), 'onboarding_input_invalid', 400);
            expect(options.captureRequest).not.toHaveBeenCalled(); expect(options.pool.connect).not.toHaveBeenCalled();
        });
        test('directory and event schemas cannot introduce a caller tenant or mutation-success audit', async () => {
            const options = noDatabaseOptions(), repository = instantiate(options);
            await rejectsCode(() => repository.discoverBindings({}, { limit: 10, afterBindingId: null, tenantId: 'foreign' }), 'onboarding_input_invalid', 400);
            await rejectsCode(() => repository.recordRuntimeEvent({}, { eventId: uid(60), action: 'acceptStagedOnboarding', outcome: 'succeeded', resourceKey: 'case', operationId: uid(61) }), 'onboarding_input_invalid', 400);
            expect(options.captureRequest).not.toHaveBeenCalled(); expect(options.pool.connect).not.toHaveBeenCalled();
        });
        test.each([
            ['initializeOperatorSession', 'customer'], ['createCase', 'customer'], ['approveCase', 'customer'],
            ['revokeCase', 'customer'], ['denyCase', 'customer'], ['expireCase', 'customer'],
            ['publishExistingMembershipBinding', 'customer'], ['activateCustomerSession', 'onboarding_discovery'],
            ['recordProofAndActivateDiscovery', 'customer'], ['acceptStagedOnboarding', 'customer'],
            ['selectBinding', 'onboarding_discovery']
        ])('%s cannot borrow SQL with otherwise-valid wrong purpose %s', async (method, kind) => {
            const options = noDatabaseOptions();
            options.captureRequest = jest.fn(async () => ({ requestId: uid(70), deadline: '2026-09-07T01:01:00.000Z',
                sessionSha256: '1'.repeat(64), kind, identityPayload: identity(), instanceId: uid(40), restoreEpoch: uid(41),
                issuedAt: START, expiresAt: END, operatorIssuanceProof: null,
                discovery: kind === 'onboarding_discovery' ? { caseId: uid(32), proofId: uid(71) } : null }));
            await rejectsCode(() => instantiate(options)[method]({}, commandFor(method)), 'onboarding_access_denied', 403);
            expect(options.pool.connect).not.toHaveBeenCalled();
        });
    });

    describe('Dashboard runtime F timing controls without stored SQL authority', () => {
        test.each(['initializeOperatorSession', 'initializeRuntimeInstance', 'lookupCaseCapability'])(
            'FU01 %s prepares only the remaining configured allowance for each raw target', async method => {
                const f = rawTimingControl({ method, elapsed: 200 });
                await rejectsCode(f.invoke, 'onboarding_unavailable', 503);
                expect(f.state.stopped).toBe(1); expectRemainingPreparations(f.state.trace, 800);
                expect(f.client.release).toHaveBeenCalledTimes(1);
                if (method === 'lookupCaseCapability') {
                    expect(f.options.captureRequest).not.toHaveBeenCalled();
                    expect(f.options.readExternalRuntimeEpoch).not.toHaveBeenCalled();
                }
            });
        test('FU02 raw initialization intersects capture deadline before elapsed capture time', async () => {
            const f = rawTimingControl({ duration: 3000, capturedDuration: 1200, elapsed: 200 });
            await rejectsCode(f.invoke, 'onboarding_unavailable', 503);
            expect(f.state.stopped).toBe(1); expectRemainingPreparations(f.state.trace, 1000);
        });
        test.each(['deadline', 'regression'])('FU03 a settled raw borrow at %s sends no SQL and releases once', async variant => {
            const f = rawTimingControl(), borrowed = timingLatch(), releaseBorrow = timingLatch();
            f.state.borrow = async () => { borrowed.resolve(); await releaseBorrow.promise; };
            const result = settled(f.invoke());
            try {
                await borrowed.promise; expect(f.client.query).not.toHaveBeenCalled();
                expect(f.client.release).not.toHaveBeenCalled();
                f.state.now = variant === 'deadline' ? atMillis(1000) : atMillis(-1);
            } finally { releaseBorrow.resolve(); await result; }
            expectError((await result).error, 'onboarding_unavailable', 503);
            f.state.now = NOW; await Promise.resolve();
            expect(f.client.query).not.toHaveBeenCalled(); expect(f.client.release).toHaveBeenCalledTimes(1);
        });
        test('FU04 successful raw BEGIN crossing deadline is rolled back before role or GUC work', async () => {
            const f = rawTimingControl();
            f.state.after = sql => { if (sql === 'BEGIN') f.state.now = atMillis(1000); };
            await rejectsCode(f.invoke, 'onboarding_unavailable', 503);
            expect(f.state.trace.map(row => row.sql)).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 0', 'ROLLBACK']);
            expect(f.client.release).toHaveBeenCalledTimes(1);
        });
        test('FU05 held raw timeout preparation settles before refusing its unsent target', async () => {
            const f = rawTimingControl(), entered = timingLatch(), releaseSet = timingLatch(); let held = false;
            f.state.before = async sql => {
                if (!held && isRuntimeTimeout(sql)) { held = true; entered.resolve(); await releaseSet.promise; }
            };
            const result = settled(f.invoke());
            try {
                await timingPhase(entered, result);
                expect(f.state.trace.map(row => row.sql)).toEqual(['BEGIN', "SELECT set_config('statement_timeout', $1, true)"]);
                expect(f.client.release).not.toHaveBeenCalled(); f.state.now = atMillis(1000);
            } finally { releaseSet.resolve(); await result; }
            expectError((await result).error, 'onboarding_unavailable', 503);
            expect(f.state.trace.map(row => row.sql)).toEqual(['BEGIN', "SELECT set_config('statement_timeout', $1, true)",
                'SET LOCAL statement_timeout = 0', 'ROLLBACK']);
            expect(f.client.release).toHaveBeenCalledTimes(1);
        });
        test('FU06 one positive millisecond is preserved separately from cleanup zero', async () => {
            const f = rawTimingControl({ duration: 1 });
            await rejectsCode(f.invoke, 'onboarding_unavailable', 503);
            expect(f.state.stopped).toBe(1); expectRemainingPreparations(f.state.trace, 1);
            expect(f.state.trace.filter(row => isRuntimeTimeout(row.sql)).every(row => row.params[0] === '1')).toBe(true);
            expect(f.state.trace.filter(row => isRuntimeReset(row.sql))).toEqual([{ sql: 'SET LOCAL statement_timeout = 0', params: undefined }]);
        });
        test.each(['acknowledged', '25P02', 'driver failure'])(
            'FU07 F raw cleanup awaits reset %s and actual rollback without another clock sample', async variant => {
                const f = rawTimingControl(), reset = timingLatch(), releaseReset = timingLatch(), rollback = timingLatch(), releaseRollback = timingLatch();
                let cleanupClocks;
                f.state.after = sql => { if (sql === 'BEGIN') f.state.now = atMillis(1000); };
                f.state.before = async sql => {
                    if (isRuntimeReset(sql)) {
                        cleanupClocks = f.state.clockCalls; reset.resolve(); await releaseReset.promise;
                        if (variant !== 'acknowledged') throw Object.assign(new Error('synthetic driver reset failure'), { code: variant === '25P02' ? '25P02' : '08006' });
                    }
                    if (sql === 'ROLLBACK') {
                        if (cleanupClocks === undefined) reset.reject(new Error('Actual rollback arrived before the required reset'));
                        rollback.resolve(); await releaseRollback.promise;
                    }
                };
                const result = settled(f.invoke());
                try {
                    await timingPhase(reset, result); expect(f.client.release).not.toHaveBeenCalled();
                    expect(f.state.trace.some(row => row.sql === 'ROLLBACK')).toBe(false);
                    releaseReset.resolve(); await timingPhase(rollback, result);
                    expect(f.state.clockCalls).toBe(cleanupClocks); expect(f.client.release).not.toHaveBeenCalled();
                } finally { releaseReset.resolve(); releaseRollback.resolve(); await result; }
                expectError((await result).error, 'onboarding_unavailable', 503);
                expect(f.state.trace.map(row => row.sql)).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 0', 'ROLLBACK']);
                expect(f.client.release).toHaveBeenCalledTimes(1);
            });
        test('FU08 actual raw rollback failure keeps the existing settled fallback and discard path', async () => {
            const f = rawTimingControl(), first = timingLatch(), releaseFirst = timingLatch(), second = timingLatch(), releaseSecond = timingLatch();
            let rollbacks = 0;
            f.state.after = sql => { if (sql === 'BEGIN') f.state.now = atMillis(1000); };
            f.state.before = async sql => {
                if (sql !== 'ROLLBACK') return;
                rollbacks++;
                if (rollbacks === 1) { first.resolve(); await releaseFirst.promise; }
                else { second.resolve(); await releaseSecond.promise; }
                throw Object.assign(new Error('synthetic driver actual rollback failure'), { code: '08006' });
            };
            const result = settled(f.invoke());
            try {
                await timingPhase(first, result); expect(f.client.release).not.toHaveBeenCalled(); releaseFirst.resolve();
                await timingPhase(second, result); expect(f.client.release).not.toHaveBeenCalled();
            } finally { releaseFirst.resolve(); releaseSecond.resolve(); await result; }
            expectError((await result).error, 'onboarding_unavailable', 503);
            expect(rollbacks).toBe(2); expect(f.client.release).toHaveBeenCalledTimes(1);
            expect(f.client.release.mock.calls[0][0]).toBeTruthy();
            expect(f.state.trace.map(row => row.sql)).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 0', 'ROLLBACK',
                'SET LOCAL statement_timeout = 0', 'ROLLBACK']);
        });
    });
    registerRealPostgresTests();
};

function registerRealPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    const describeDatabase = testUrl ? describe : describe.skip;
    describeDatabase('Dashboard runtime with real restricted PostgreSQL', () => {
        const runKey = crypto.randomBytes(8).toString('hex');
        const databaseName = `nofries_runtime_contract_${runKey}`;
        const runtimeRole = `nf_runtime_contract_${runKey}`;
        const maintenanceRole = `nf_maintenance_contract_${runKey}`;
        const password = `synthetic-only-${runKey}`;
        let controlPool, ownerPool, runtimePool, maintenancePool;
        let closeOwner, closeRuntime, closeMaintenance, databaseCreated = false;
        let runtimeRoleCreated = false, maintenanceRoleCreated = false, sequence = 1000, fixture;
        const reconstructionPoolClosers = [];
        const nextId = () => uid(++sequence);

        beforeAll(async () => {
            const { Pool } = require('pg');
            controlPool = new Pool({ connectionString: testUrl, max: 1, application_name: `runtime-control-${runKey}` });
            await controlPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); databaseCreated = true;
            const ownerUrl = new URL(testUrl); ownerUrl.pathname = '/' + databaseName;
            ownerPool = new Pool({ connectionString: ownerUrl.toString(), max: 2, application_name: `runtime-owner-${runKey}` });
            closeOwner = trackPoolClientEnds(ownerPool);
            const migrationClient = await ownerPool.connect();
            try { await applyMigrations({ client: migrationClient }); } finally { migrationClient.release(); }
            await controlPool.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            runtimeRoleCreated = true;
            await controlPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(runtimeRole)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            await controlPool.query(`CREATE ROLE ${quoteIdentifier(maintenanceRole)} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            maintenanceRoleCreated = true;
            await controlPool.query(`GRANT nofries_dashboard_maintenance TO ${quoteIdentifier(maintenanceRole)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            const roleUrl = role => { const url = new URL(ownerUrl); url.username = role; url.password = password; return url.toString(); };
            runtimePool = new Pool({ connectionString: roleUrl(runtimeRole), max: 1, connectionTimeoutMillis: 5000,
                application_name: `runtime-contract-${runKey}` });
            closeRuntime = trackPoolClientEnds(runtimePool);
            maintenancePool = new Pool({ connectionString: roleUrl(maintenanceRole), max: 1, connectionTimeoutMillis: 5000,
                application_name: `maintenance-contract-${runKey}` });
            closeMaintenance = trackPoolClientEnds(maintenancePool);
        });
        afterAll(async () => {
            if (closeRuntime) await closeRuntime();
            if (closeMaintenance) await closeMaintenance();
            if (closeOwner) await closeOwner();
            if (controlPool) {
                try {
                    if (databaseCreated) await controlPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
                    if (runtimeRoleCreated) await controlPool.query(`DROP ROLE ${quoteIdentifier(runtimeRole)}`);
                    if (maintenanceRoleCreated) await controlPool.query(`DROP ROLE ${quoteIdentifier(maintenanceRole)}`);
                } finally { await controlPool.end(); }
            }
        });

        function tracedPool(rawPool, state) {
            return { end: () => rawPool.end(), async connect() {
                state.borrows++; if (state.beforeBorrow) await state.beforeBorrow();
                const client = await rawPool.connect();
                let released = false;
                return { async query(text, params) {
                    const sql = typeof text === 'string' ? text : text.text;
                    const event = { sql, params: clone(params || []), phase: 'before', backendPid: client.processID };
                    state.trace.push(event);
                    if (state.hook) await state.hook(event);
                    const result = await client.query(text, params);
                    if (state.hook) await state.hook({ ...event, phase: 'after', result });
                    return result;
                }, release(discard) { if (!released) { released = true; state.releases++; client.release(discard); } } };
            } };
        }
        function harness({ historyBudget = BUDGET, rawRuntimePool = runtimePool, resourceIdentity = null } = {}) {
            const instanceId = nextId(), restoreEpoch = nextId(), operatorIdentity = resourceIdentity ? clone(resourceIdentity) : identity(nextId()),
                customerIdentity = resourceIdentity ? clone(resourceIdentity) : identity(nextId());
            const scope = { tenantId: `runtime-${runKey}-${++sequence}`, organisationId: 'same-organisation-id' };
            const registry = new WeakMap(), proofs = new WeakMap(), capabilities = new WeakMap();
            const state = { now: NOW, instanceId, restoreEpoch, borrows: 0, releases: 0, trace: [], hook: null,
                ids: 0, tokens: 0, captures: 0, externalReads: 0, policyCalls: [], deniedOperations: new Set() };
            const restrictedPool = tracedPool(rawRuntimePool, state);
            const privilegedPool = tracedPool(maintenancePool, state);
            const newId = () => { state.ids++; return nextId(); };
            const newGenerationToken = () => { state.tokens++; return digest(`synthetic-token-${nextId()}`); };
            const external = async () => { state.externalReads++; return { instanceId, restoreEpoch: state.restoreEpoch }; };
            const options = { pool: restrictedPool, clock: () => state.now, instanceId, historyBudget: clone(historyBudget),
                captureRequest: async request => { state.captures++; return registry.has(request) ? clone(registry.get(request)) : null; },
                readExternalRuntimeEpoch: external,
                readVerifiedOnboardingProof: async request => proofs.has(request) ? clone(proofs.get(request)) : null,
                readPreparedCaseCapability: async (request, supplied) => {
                    const value = capabilities.get(request);
                    return value && value.caseId === supplied.caseId && value.operationId === supplied.operationId ? clone(value) : null;
                },
                authoriseOperatorOperation: facts => {
                    state.policyCalls.push(facts);
                    return ['createCase', 'approveCase', 'revokeCase', 'denyCase', 'expireCase', 'publishExistingMembershipBinding'].includes(facts.operationType)
                        && facts.capture.kind === 'operator_dashboard' && subject(facts.capture.identityPayload) === subject(operatorIdentity)
                        && !state.deniedOperations.has(facts.operationType);
                }, newId, newGenerationToken };
            const maintenanceOptions = { pool: privilegedPool, clock: () => state.now, instanceId, historyBudget: clone(historyBudget),
                readExternalRuntimeEpoch: external, newId,
                authoriseMaintenanceOperation: facts => {
                    state.policyCalls.push(facts);
                    return MAINTENANCE_METHODS.includes(facts.operationType) && facts.command.actorSubjectKey === subject(operatorIdentity)
                        && facts.command.evidenceRef !== 'unapproved-evidence' && !state.deniedOperations.has(facts.operationType);
                } };
            const repository = instantiate(options), maintenance = instantiate(maintenanceOptions, true);
            function session(kind, principal, discovery = null, proofless = false) {
                const result = { sessionSha256: digest(nextId()), kind, identityPayload: clone(principal), instanceId,
                    restoreEpoch: state.restoreEpoch, issuedAt: START, expiresAt: END, discovery, operatorIssuanceProof: null };
                if (kind === 'operator_dashboard' && !proofless) result.operatorIssuanceProof = {
                    schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: result.sessionSha256,
                    identitySha256: hash(principal), instanceId, restoreEpoch: result.restoreEpoch, issuedAt: result.issuedAt, expiresAt: result.expiresAt };
                return result;
            }
            function discoverySession(proof) {
                return { ...session('onboarding_discovery', proof.identity, { caseId: proof.caseId, proofId: proof.proofId }),
                    issuedAt: proof.verifiedAt, expiresAt: proof.freshUntil };
            }
            function request(seed, proof, requestFields = {}) {
                const result = Object.freeze({ ...requestFields, syntheticRequestId: nextId() });
                registry.set(result, { requestId: nextId(), deadline: new Date(Date.parse(state.now) + 60000).toISOString(), ...clone(seed) });
                if (proof) proofs.set(result, clone(proof));
                return result;
            }
            const operatorSeed = session('operator_dashboard', operatorIdentity);
            const operator = () => request(operatorSeed);
            function instanceCommand(before = null, epoch = state.restoreEpoch) {
                return { operationId: nextId(), actorSubjectKey: subject(operatorIdentity), expectedRevision: before ? before.revision : null,
                    expectedRecordSha256: before ? hash(before) : null, restoreEpoch: epoch,
                    evidenceRef: 'synthetic-runtime-approval', evidenceSha256: digest('synthetic-runtime-approval') };
            }
            async function initialize() {
                const firstCommand = instanceCommand();
                const first = await maintenance.initializeRuntimeInstance(firstCommand);
                const enableCommand = instanceCommand(first.record), enabled = await maintenance.enableRuntimeIngress(enableCommand);
                const initialCommand = { operationId: nextId() }, initialized = await repository.initializeOperatorSession(operator(), initialCommand);
                return { firstCommand, first, enableCommand, enabled, initialCommand, initialized };
            }
            function admissionCommand(selected, before = null) {
                return { operationId: nextId(), actorSubjectKey: subject(operatorIdentity), authorityId: before ? before.authorityId : nextId(),
                    expectedRevision: before ? before.revision : null, expectedHeadSha256: before ? before.decisionSha256 : null,
                    payload: { target: clone(selected.scope), identityPolicyRef: { policyId: customerIdentity.policyId, policyRevision: customerIdentity.policyRevision },
                        approvedEffectSha256: hash(domain.normaliseTemplate(selected)), evidenceRefs: [{ kind: 'approval', id: 'synthetic-approved-effect', sha256: digest('synthetic-approved-effect') }],
                        validFrom: START, validUntil: END } };
            }
            async function createCase(selected = template(scope, nextId()), { acceptBefore = ACCEPT_BEFORE, admissionValidUntil = END, prepareOnly = false } = {}) {
                const admissionInput = admissionCommand(selected); admissionInput.payload.validUntil = admissionValidUntil;
                const admission = await maintenance.publishAdmissionDecision(admissionInput);
                const authorityRef = { authorityId: admission.record.authorityId, revision: admission.record.revision, sha256: admission.record.decisionSha256 };
                const rawCapability = crypto.randomBytes(32), capability = rawCapability.toString('base64url');
                const command = { operationId: nextId(), caseId: nextId(), templateRef: 'synthetic-template-v1',
                    template: selected, acceptBefore, authorityRef };
                const req = operator(); capabilities.set(req, { caseId: command.caseId, operationId: command.operationId, capabilitySha256: digest(rawCapability) });
                const result = prepareOnly ? null : await repository.createCase(req, command);
                return { selected, admissionInput, admission, authorityRef, command, request: req, result, capability };
            }
            async function bind(example, { freshUntil = ACCEPT_BEFORE, prepareOnly = false } = {}) {
                const operationId = nextId();
                const proof = { proofId: nextId(), caseId: example.command.caseId, scope: clone(example.selected.scope),
                    caseRevision: example.result.case.revision, identity: clone(customerIdentity), authenticationSha256: digest(nextId()),
                    verifiedAt: state.now, freshUntil, operationId };
                const seed = discoverySession(proof);
                const req = request(seed, proof), result = prepareOnly ? null : await repository.recordProofAndActivateDiscovery(req, { operationId });
                return { ...example, proof, discoverySeed: seed, discoveryRequest: req, bound: result, bindCommand: { operationId } };
            }
            async function approve(example, { acceptBefore = ACCEPT_BEFORE, prepareOnly = false } = {}) {
                const command = { operationId: nextId(), caseId: example.command.caseId, expectedRevision: example.bound.case.revision,
                    expectedHeadSha256: example.bound.case.headSha256, approvalId: nextId(), acceptBefore, authorityRef: example.authorityRef };
                const result = prepareOnly ? null : await repository.approveCase(operator(), command);
                return { ...example, approveCommand: command, approved: result };
            }
            async function accepted(selected) {
                const example = await approve(await bind(await createCase(selected)));
                const command = { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: example.approved.case.revision };
                const result = await repository.acceptStagedOnboarding(request(example.discoverySeed, example.proof), command);
                return { ...example, acceptCommand: command, accepted: result };
            }
            async function seedCanonical(principal = operatorIdentity, validUntil = END, prepareCanonical = null) {
                const selected = template(scope, nextId()), owner = selected.bootstrap.tenantAggregate;
                let membershipState = createMembershipState(owner, scope, NOW);
                membershipState = applyMembershipCommand(membershipState, owner, { ...scope, expectedRevision: membershipState.revision,
                    actorSubjectKey: subject(operatorIdentity), now: NOW, action: 'invite', payload: {
                        invitationId: 'existing-invitation', subjectKey: subject(principal), roles: ['admin'], validFrom: START,
                        validUntil, grantEvidenceId: 'existing-approved-role', expiresAt: validUntil } });
                membershipState = applyMembershipCommand(membershipState, owner, { ...scope, expectedRevision: membershipState.revision,
                    actorSubjectKey: subject(principal), now: NOW, action: 'accept', payload: { invitationId: 'existing-invitation', membershipId: 'existing-member' } });
                const initial = { tenantAggregate: owner, membershipState, entitlementState: selected.bootstrap.entitlementState,
                    flags: selected.bootstrap.flags, advisorAssignments: [] };
                if (prepareCanonical) prepareCanonical(initial);
                const command = { ...scope, operationId: nextId(), actorSubjectKey: subject(operatorIdentity), type: 'organisation.initialise',
                    expectedRevisions: clone(EMPTY_REVISIONS), payload: {} };
                // Existing DATA assumes its caller has supplied canonical-role
                // composition. Only this legacy seed helper enters that role;
                // runtime repository pools above remain transparent LOGIN pools.
                const seedPool = { end: () => restrictedPool.end(), async connect() {
                    const client = await restrictedPool.connect();
                    return { release: value => client.release(value), async query(text, parameters) {
                        const result = await client.query(text, parameters);
                        if (text === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                        return result;
                    } };
                } };
                const canonicalRepository = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: seedPool }),
                    clock: () => state.now, authoriseAdministration: supplied => supplied.type === 'organisation.initialise'
                        && supplied.tenantId === scope.tenantId && supplied.organisationId === scope.organisationId
                        && supplied.operationId === command.operationId && supplied.actorSubjectKey === subject(operatorIdentity) });
                const result = await canonicalRepository.initialiseOrganisation(command, initial);
                return { selected, initial, command, result };
            }
            async function publicationSetup(validUntil = END, prepareCanonical = null) {
                const canonicalSeed = await seedCanonical(customerIdentity, validUntil, prepareCanonical);
                const approvedEffect = { schemaVersion: 1, operationType: 'publish_existing_membership', bindingId: nextId(),
                    scope: clone(scope), membershipId: 'existing-member', invitationId: 'existing-invitation', grantEvidenceId: 'existing-approved-role',
                    identity: clone(customerIdentity), validFrom: START, validUntil };
                const admissionInput = admissionCommand(canonicalSeed.selected);
                admissionInput.payload.approvedEffectSha256 = hash(approvedEffect);
                const admission = await maintenance.publishAdmissionDecision(admissionInput);
                const { schemaVersion, operationType, ...grant } = approvedEffect;
                const command = { operationId: nextId(), ...grant, authorityRef: { authorityId: admission.record.authorityId,
                    revision: admission.record.revision, sha256: admission.record.decisionSha256 } };
                return { canonicalSeed, approvedEffect, admissionInput, admission, command };
            }
            return { state, scope, instanceId, operatorIdentity, customerIdentity, registry, proofs, capabilities, options, maintenanceOptions,
                repository, maintenance, restrictedPool, privilegedPool, session, discoverySession, request, operatorSeed, operator, initialize, instanceCommand,
                admissionCommand, createCase, bind, approve, accepted, seedCanonical, publicationSetup };
        }
        afterEach(async () => {
            mockResourceAfterWork = null; mockRuntimeAfterReconcile = null; mockAfterHostDecision = null;
            if (fixture) fixture.state.hook = null;
            const closed = await Promise.allSettled(reconstructionPoolClosers.splice(0).map(close => close()));
            const failure = closed.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        });
        beforeEach(async () => {
            require('../../api/shared/abuseProtection').resetAbuseProtectionForTests();
            // This database belongs only to this synthetic suite. Include all
            // assessment and evidence children in the same explicit owner reset
            // so PostgreSQL can honor their foreign keys without CASCADE.
            const tables = [...DATA_TABLES, ...RUNTIME_TABLES, 'dashboard_ncsc_assessment_revisions',
                'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts',
                'dashboard_evidence_revisions', 'dashboard_evidence_heads', 'dashboard_evidence_receipts',
                'signup_acceptance_receipts', 'signup_registrations', 'dashboard_starter_scopes', 'dashboard_starter_accounts',
                'dashboard_improvement_revisions', 'dashboard_improvement_heads'];
            await ownerPool.query('TRUNCATE ' + tables.map(table => 'nofries.' + table).join(', '));
            fixture = harness();
        });
        test.each([false, true])('new starter signup atomically grants fixed allowances and replays after lost COMMIT=%s', async loseCommit => {
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const { createStarterAccountAllocator } = require('../../api/shared/customerSignup/starterAccountAllocation');
            const { compileStarterProvisioning } = require('../../api/shared/customerSignup/starterProvisioning');
            const { createPostgresSignupAcceptanceJournal } = require('../../api/shared/customerSignup/postgresSignupAcceptanceJournal');
            const { createPostgresSignupRegistrationStore } = require('../../api/shared/customerSignup/postgresSignupRegistrationStore');
            let saved;
            const accountStore = { load: async () => saved || null,
                create: async (_, record) => { saved = { record, version: '1' }; return true; }, replace: async () => false };
            const allocator = createStarterAccountAllocator({ store: accountStore, now: Date.now,
                readActivation: async () => null, captureOwner: async () => null });
            const requestId = nextId(), at = Date.now();
            const account = await allocator.reserveInitial({ schemaVersion: 1, requestId, email: 'synthetic@gmail.com',
                organisationName: 'Unrelated synthetic company', accountType: 'company', status: 'verified', codeHash: null,
                attempts: 0, createdAt: at - 1000, verifiedAt: at, codeExpiresAt: at + 599000, expiresAt: at + 86399000 });
            const slot = account.organisations[0], customer = subject(f.customerIdentity);
            const source = { offerInput: { ...Object.fromEntries(['tenantId','organisationId','organisationName','grantId','scheduleId','kind'].map(k => [k, slot[k]])),
                accountType: 'company', contact: { name: 'Synthetic User', role: 'Owner', address: 'Synthetic address', registrationId: null,
                    email: account.email, authorityEvidenceId: nextId() }, framework: { moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' } },
                subjectKey: customer, issuerSubjectKey: customer, invitationId: nextId(), createdAt: new Date().toISOString() };
            const provisioning = { account, requestId, source }, p = compileStarterProvisioning(provisioning);
            const runtime = instantiate({ ...f.options, clock: () => new Date().toISOString(),
                readStarterProvisioning: async () => ({ provisioning, deadline: new Date(Date.now() + 60000).toISOString() }) });
            const seed = f.session('customer', f.customerIdentity);
            // The customer adapter checks its issuance proof before capture;
            // operatorIssuanceProof remains null for a genuine customer capture.
            const request = f.request(seed);
            const first = await runtime.starterProvisioning(request, { requestId, phase: 'prepare' });
            expect(first.status).toBe('prepared');
            expect(await runtime.starterProvisioning(request, { requestId, phase: 'prepare' })).toEqual(first);
            expect((await ownerPool.query('SELECT activated_at FROM nofries.dashboard_starter_accounts')).rows[0].activated_at).toBeNull();
            await expect(runtime.starterProvisioning(request, { requestId, phase: 'activate' })).rejects.toThrow();
            const database = createPostgresDatabase({ pool: { end: () => runtimePool.end(), async connect() {
                const client = await runtimePool.connect();
                return { release: discard => client.release(discard), async query(sql, params) {
                    const result = await client.query(sql, params);
                    if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                    return result;
                } };
            } } });
            const receipt = { receiptId: nextId(), invitationId: p.invitationId, subjectKey: customer, ...p.scope, ...p.terms,
                scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest, acceptedAt: Date.now(), status: 'pending_admission', dashboardAccess: false };
            await createPostgresSignupAcceptanceJournal({ database }).persist(receipt);
            await createPostgresSignupRegistrationStore({ database }).registerAcceptance(receipt);
            let activationPid, lost = false;
            if (loseCommit) f.state.hook = event => {
                if (event.phase === 'after' && event.sql.startsWith('UPDATE nofries.dashboard_starter_scopes SET activation=')) activationPid = event.backendPid;
                if (!lost && activationPid === event.backendPid && event.phase === 'after' && event.sql === 'COMMIT') {
                    lost = true; throw new Error('Synthetic lost response after genuine starter activation COMMIT');
                }
            };
            const result = await runtime.starterProvisioning(request, { requestId, phase: 'activate' });
            expect(lost).toBe(loseCommit); f.state.hook = null;
            expect(result.status).toBe('activated'); expect(result.bindingId).toBe(slot.bindingId);
            expect(Date.parse(result.validUntil) - Date.parse(result.activatedAt)).toBe(14 * 86400000);
            const again = await runtime.starterProvisioning(request, { requestId, phase: 'activate' });
            expect(again).toEqual(result);
            const usages = await ownerPool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1', [slot.tenantId]);
            expect(usages.rows[0].payload.counters).toEqual({ memberships: 1, assessment_runs: 0, ai_requests: 0, evidence_bytes: 0, report_exports: 0 });
            expect((await ownerPool.query('SELECT count(*) FROM nofries.dashboard_identity_bindings WHERE tenant_id=$1', [slot.tenantId])).rows[0].count).toBe('1');
            await expect(runtime.starterProvisioning(f.operator(), { requestId, phase: 'activate' })).rejects.toThrow();
        });
        test.each([false, true])('client saved acceptance explicitly completes its original registration after interruption (lost acknowledgement: %s)', async loseAcknowledgement => {
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const h = customerProductionHarness({ pool: f.restrictedPool, instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch,
                identity: { ...f.customerIdentity, audience: uid(7) }, now: Date.now(), starter: true, external: true, customerClientId: uid(105) });
            const post = (path, cookie, body, csrf) => h.sameOrigin(request(h.app).post(path)).set('Cookie', cookie)
                .set('X-CSRF-Token', csrf).send(body);
            const details = { name: 'Synthetic Representative', role: 'Consultant', address: 'Synthetic address', registrationId: '', authorityConfirmed: true };
            const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
            const initial = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            expect((await post('/api/external-customer-signup/setup', provisional.cookie,
                { accountType: 'consultant', organisationName: 'Synthetic consultant workspace', details }, initial.body.csrfToken)).status).toBe(200);
            const login = await h.loginExternal(); expect(login.response.status).toBe(303);
            expect((await h.consentExternal(login.cookie)).response.body.state.status).toBe('continue_to_dashboard');
            const list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
            expect(list.body.state).toEqual({ status: 'clients', clients: [], remaining: 3 });
            const requestId = nextId(), clientPost = body => post('/api/customer-signup/clients', login.cookie, body, list.body.csrfToken);
            const offered = await clientPost({ action: 'create', requestId, organisationName: 'Saved synthetic client', details });
            expect(offered.body.state.status).toBe('terms');
            const client = (await ownerPool.query('SELECT preparation FROM nofries.dashboard_starter_scopes WHERE ordinal=1')).rows[0].preparation;
            const scope = [client.scope.tenantId, client.scope.organisationId];
            const receipt = async () => (await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts WHERE tenant_id=$1 AND organisation_id=$2', scope)).rows;
            const registration = async () => (await ownerPool.query('SELECT revision,payload FROM nofries.signup_registrations WHERE subject_key=$1', [client.subjectKey])).rows;
            const beforeAccount = [...h.getContainer('external-starter-authority').records]
                .filter(([key]) => key.startsWith('customer-starter/starter-accounts/')).map(([key, bytes]) => [key, bytes.toString('base64')]);
            // Completion without a durable receipt never creates consent.
            expect((await clientPost({ action: 'resume_acceptance', requestId })).status).toBeGreaterThanOrEqual(400);
            expect(await receipt()).toEqual([]);
            expect((await clientPost({ action: 'resume', requestId })).body.state.status).toBe('terms');
            let interrupted = false;
            f.state.hook = event => {
                if (!interrupted && event.phase === 'before' && /^(?:INSERT INTO|UPDATE) nofries\.signup_registrations\b/.test(event.sql.trimStart())) {
                    interrupted = true; throw new Error('Synthetic registration failure after durable consent');
                }
            };
            const { termsVersion, termsDigest, scheduleId, scheduleDigest } = offered.body.state;
            const accepted = await clientPost({ action: 'accept', requestId, terms: { accepted: true, termsVersion, termsDigest, scheduleId, scheduleDigest } });
            expect(interrupted).toBe(true); expect(accepted.status).toBe(503); f.state.hook = null;
            const originalReceipt = await receipt(), originalRegistration = await registration();
            expect(originalReceipt).toHaveLength(1);
            expect(originalRegistration[0].payload.registrations.some(value => value.organisationId === client.scope.organisationId)).toBe(false);
            const listed = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
            expect(listed.body.state).toMatchObject({ remaining: 2, clients: [{ requestId, status: 'pending' }] });
            expect((await clientPost({ action: 'resume', requestId })).body.state).toEqual({ status: 'resume_acceptance' });
            expect(await receipt()).toEqual(originalReceipt); expect(await registration()).toEqual(originalRegistration);
            // A fresh authenticated return discovers the same saved client;
            // completion uses its current session CSRF, not a transferred token.
            const returned = await h.loginExternal(); expect(returned.response.status).toBe(303); login.cookie = returned.cookie;
            const currentList = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
            expect(currentList.body.state).toEqual(listed.body.state); list.body.csrfToken = currentList.body.csrfToken;
            expect((await clientPost({ action: 'resume', requestId })).body.state).toEqual({ status: 'resume_acceptance' });
            const complete = { action: 'resume_acceptance', requestId };
            // The same origin/session CSRF and closed payload remain mandatory.
            for (const denied of [
                request(h.app).post('/api/customer-signup/clients').set('Cookie', login.cookie).set('X-CSRF-Token', list.body.csrfToken).send(complete),
                post('/api/customer-signup/clients', login.cookie, complete, 'x'.repeat(43)),
                clientPost({ ...complete, terms: { accepted: true } }), clientPost({ ...complete, requestId: nextId() })
            ]) expect((await denied).status).toBeGreaterThanOrEqual(400);
            expect(await receipt()).toEqual(originalReceipt); expect(await registration()).toEqual(originalRegistration);
            // Deleting the invitation cannot recreate authority from the receipt.
            const invitations = h.getContainer('nofries-browser-auth').records;
            const context = JSON.parse(h.getContainer('external-starter-authority').records.get(`customer-starter/contexts/${client.scope.organisationId}.json`));
            const contextKey = `customer-starter/contexts/${client.scope.organisationId}.json`;
            const originalContext = h.getContainer('external-starter-authority').records.get(contextKey);
            h.getContainer('external-starter-authority').records.set(contextKey, Buffer.from(JSON.stringify({ ...context,
                source: { ...context.source, subjectKey: `${uid(1)}:${uid(2)}` } })));
            expect((await clientPost(complete)).status).toBeGreaterThanOrEqual(400);
            expect(await registration()).toEqual(originalRegistration);
            h.getContainer('external-starter-authority').records.set(contextKey, originalContext);
            const invitationKey = `browser-auth/customer-signup/invitations/${context.invitation.tokenDigest}.json`;
            const originalInvitation = invitations.get(invitationKey); expect(originalInvitation).toBeDefined();
            invitations.delete(invitationKey);
            expect((await clientPost(complete)).status).toBeGreaterThanOrEqual(400);
            expect(await registration()).toEqual(originalRegistration); invitations.set(invitationKey, originalInvitation);
            let registrationPid, lost = false;
            if (loseAcknowledgement) f.state.hook = event => {
                if (event.phase === 'after' && event.sql.trimStart().startsWith('UPDATE nofries.signup_registrations')) registrationPid = event.backendPid;
                if (!lost && event.phase === 'after' && event.sql === 'COMMIT' && event.backendPid === registrationPid) {
                    lost = true; throw new Error('Synthetic lost registration COMMIT acknowledgement');
                }
            };
            const completed = await clientPost(complete); f.state.hook = null;
            expect(lost).toBe(loseAcknowledgement);
            expect(completed.status).toBe(loseAcknowledgement ? 503 : 200);
            if (!loseAcknowledgement) expect(completed.body.state.status).toBe('ready');
            const repeated = await clientPost(complete);
            expect({ status: repeated.status, state: repeated.body.state.status }).toEqual({ status: 200, state: 'ready' });
            const finalRegistration = await registration();
            expect(finalRegistration[0].payload.registrations.filter(value => value.organisationId === client.scope.organisationId)).toHaveLength(1);
            expect(finalRegistration[0].payload.registrations.find(value => value.organisationId === client.scope.organisationId).receiptId)
                .toBe(originalReceipt[0].payload.receipt.receiptId);
            expect(await receipt()).toEqual(originalReceipt);
            expect((await clientPost(complete)).body.state.status).toBe('ready');
            expect(await registration()).toEqual(finalRegistration);
            expect([...h.getContainer('external-starter-authority').records]
                .filter(([key]) => key.startsWith('customer-starter/starter-accounts/')).map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(beforeAccount);
            const windows = (await ownerPool.query("SELECT activation->>'validFrom' AS start,activation->>'validUntil' AS stop FROM nofries.dashboard_starter_scopes ORDER BY ordinal")).rows;
            expect(windows).toHaveLength(2); expect(windows[0]).toEqual(windows[1]);
            const { createPostgresSignupRegistrationStore } = require('../../api/shared/customerSignup/postgresSignupRegistrationStore');
            const store = createPostgresSignupRegistrationStore({ database: createPostgresDatabase({ pool: ownerPool }) });
            await store.revokeRegistration({ subjectKey: client.subjectKey, ...client.scope, invitationId: client.invitationId,
                expectedRevision: Number(finalRegistration[0].revision) });
            const revoked = await registration();
            expect((await clientPost(complete)).status).toBeGreaterThanOrEqual(400);
            expect(await registration()).toEqual(revoked); expect(await receipt()).toEqual(originalReceipt);
        });
        test.each([[false, 'elapsed recovery'], [true, 'committed receipt recovery'], [false, 'future receipt denial']])('fresh external callback after expiry (receipt committed before expiry: %s; case: %s)', async (afterReceiptCommit, clockCase) => {
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const h = customerProductionHarness({ pool: f.restrictedPool, instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch,
                identity: { ...f.customerIdentity, audience: uid(7) }, now: Date.now(), starter: true, external: true, customerClientId: uid(105) });
            const advanced = 5 * 60000 + 1000, elapsedRecovery = clockCase === 'elapsed recovery';
            const recoveryExpected = clockCase !== 'future receipt denial', elapsedOffset = elapsedRecovery ? 0 : advanced;
            h.state.clockOffset = 0;
            const details = { name: 'Synthetic Representative', role: 'Consultant', address: 'Synthetic address', registrationId: '', authorityConfirmed: true };
            const post = (path, cookie, body, csrf) => h.sameOrigin(request(h.app).post(path)).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body);
            const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
            const initial = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            expect((await post('/api/external-customer-signup/setup', provisional.cookie,
                { accountType: 'consultant', organisationName: 'Synthetic consultant workspace', details }, initial.body.csrfToken)).status).toBe(200);
            let login = await h.loginExternal(); expect(login.response.status).toBe(303);
            expect((await h.consentExternal(login.cookie)).response.body.state.status).toBe('continue_to_dashboard');
            let list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
            const requestId = nextId(), clientPost = body => post('/api/customer-signup/clients', login.cookie, body, list.body.csrfToken);
            const offered = await clientPost({ action: 'create', requestId, organisationName: 'Saved synthetic client', details });
            expect(offered.body.state.status).toBe('terms');
            const termsOpenedAt = Date.now();
            const client = (await ownerPool.query('SELECT preparation FROM nofries.dashboard_starter_scopes WHERE ordinal=1')).rows[0].preparation;
            const scope = [client.scope.tenantId, client.scope.organisationId];
            const receipts = async () => (await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts WHERE tenant_id=$1 AND organisation_id=$2', scope)).rows;
            const registrations = async () => (await ownerPool.query('SELECT payload FROM nofries.signup_registrations WHERE subject_key=$1', [client.subjectKey])).rows;
            const savedAccount = [...h.getContainer('external-starter-authority').records]
                .filter(([key]) => key.startsWith('customer-starter/starter-accounts/')).map(([key, bytes]) => [key, bytes.toString('base64')]);
            const originalWindow = (await ownerPool.query("SELECT activation->>'validFrom' AS start,activation->>'validUntil' AS stop FROM nofries.dashboard_starter_scopes WHERE ordinal=0")).rows[0];
            const { termsVersion, termsDigest, scheduleId, scheduleDigest } = offered.body.state;
            const accept = { action: 'accept', requestId, terms: { accepted: true, termsVersion, termsDigest, scheduleId, scheduleDigest } };
            const activationClockSql = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at`;
            const nativeActivationTimes = [], previousHook = f.state.hook;
            expect(previousHook).toBe(null);
            let receiptPid, expired = false;
            f.state.hook = event => {
                // Observe genuine SQL time without rewriting its result or any
                // receipt. Native RLS and transaction-time guards still execute.
                if (event.phase === 'after' && event.sql === activationClockSql) {
                    expect(event.result.rows).toHaveLength(1);
                    const nativeAt = Date.parse(event.result.rows[0].occurred_at);
                    expect(Number.isFinite(nativeAt)).toBe(true);
                    nativeActivationTimes.push(nativeAt);
                }
                if (afterReceiptCommit && event.phase === 'after' && event.sql.trimStart().startsWith('INSERT INTO nofries.signup_acceptance_receipts')) receiptPid = event.backendPid;
                if (afterReceiptCommit && !expired && event.phase === 'after' && event.sql === 'COMMIT' && event.backendPid === receiptPid) {
                    expired = true; h.state.clockOffset = elapsedOffset;
                }
            };
            try {
                if (elapsedRecovery) {
                    // The pre-receipt success case must let both real clocks
                    // elapse. Wait only between requests, never inside COMMIT.
                    // Advancing the app alone instead creates a future receipt.
                    const expiresAfter = termsOpenedAt + advanced;
                    while (Date.now() < expiresAfter) await new Promise(resolve => setTimeout(resolve, Math.min(30000, expiresAfter - Date.now())));
                    expect(Date.now() - termsOpenedAt).toBeGreaterThanOrEqual(advanced);
                } else if (!afterReceiptCommit) h.state.clockOffset = elapsedOffset;
                const stale = await clientPost(accept);
                expect(stale.status).toBe(401); expect(stale.body.code).toBe('starter_reauthentication_required');
                expect(expired).toBe(afterReceiptCommit);
                const savedReceipts = await receipts(); expect(savedReceipts).toHaveLength(afterReceiptCommit ? 1 : 0);
                expect((await registrations())[0].payload.registrations.some(value => value.organisationId === client.scope.organisationId)).toBe(false);
                expect((await clientPost(accept)).status).toBe(401); expect(await receipts()).toEqual(savedReceipts);
                // Real elapsed time or the explicitly synthetic post-receipt
                // offset persists through the genuine application callback.
                // Provider success and Blob remain synthetic fixtures; the
                // application callback, PostgreSQL and its clock are genuine.
                login = await h.loginExternal(); expect(login.response.status).toBe(303); expect(h.state.clockOffset).toBe(elapsedOffset);
                list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
                expect(list.status).toBe(200); expect(list.body.state).toMatchObject({ remaining: 2, clients: [{ requestId, status: 'pending' }] });
                const resumed = await clientPost({ action: 'resume', requestId }); expect(resumed.status).toBe(200);
                if (afterReceiptCommit) expect(resumed.body.state).toEqual({ status: 'resume_acceptance' });
                else expect(resumed.body.state).toEqual(offered.body.state);
                const completed = await clientPost(afterReceiptCommit ? { action: 'resume_acceptance', requestId } : accept);
                expect(completed.status).toBe(recoveryExpected ? 200 : 503);
                expect(nativeActivationTimes.length).toBeGreaterThan(0);
                const finalReceipts = await receipts(); expect(finalReceipts).toHaveLength(1);
                if (afterReceiptCommit) expect(finalReceipts).toEqual(savedReceipts);
                const finalRegistration = (await registrations())[0].payload.registrations.filter(value => value.organisationId === client.scope.organisationId);
                if (recoveryExpected) {
                    expect(completed.body.state.status).toBe('ready');
                    expect(finalReceipts[0].payload.receipt.acceptedAt).toBeLessThanOrEqual(nativeActivationTimes.at(-1));
                    expect(finalRegistration).toHaveLength(1); expect(finalRegistration[0].receiptId).toBe(finalReceipts[0].payload.receipt.receiptId);
                    expect((await clientPost({ action: 'resume', requestId })).body.state.status).toBe('ready');
                    expect(await receipts()).toEqual(finalReceipts);
                } else {
                    expect(finalReceipts[0].payload.receipt.acceptedAt).toBeGreaterThan(nativeActivationTimes.at(-1));
                    expect((await ownerPool.query('SELECT activation FROM nofries.dashboard_starter_scopes WHERE ordinal=1')).rows[0].activation).toBe(null);
                    expect(finalRegistration.length).toBeLessThanOrEqual(1);
                    if (finalRegistration.length) expect(finalRegistration[0].receiptId).toBe(finalReceipts[0].payload.receipt.receiptId);
                }
                expect((await ownerPool.query('SELECT preparation FROM nofries.dashboard_starter_scopes WHERE ordinal=1')).rows[0].preparation).toEqual(client);
                const windows = (await ownerPool.query("SELECT activation->>'validFrom' AS start,activation->>'validUntil' AS stop FROM nofries.dashboard_starter_scopes ORDER BY ordinal")).rows;
                expect(windows).toEqual(recoveryExpected ? [originalWindow, originalWindow] : [originalWindow, { start: null, stop: null }]);
                expect([...h.getContainer('external-starter-authority').records]
                    .filter(([key]) => key.startsWith('customer-starter/starter-accounts/')).map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(savedAccount);
                expect((await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie)).body.state.remaining).toBe(2);
                expect(h.state.clockOffset).toBe(elapsedOffset);
            } finally { f.state.hook = previousHook; }
        }, 7 * 60000);
        test.each([['company', 'Guest'], ['consultant', 'Guest'], ['consultant', 'Member'], ['company', 'External'], ['consultant', 'External'],
            ['company', 'ExternalAssertion'], ['consultant', 'ExternalAssertion']])('production %s %s journey verifies email, accepts real terms and opens its dashboard without manual admission', async (accountType, userType) => {
            const external = userType.startsWith('External'), assertionCalls = [];
            const graphAttempts = { requests: 0, tokenScopes: 0 };
            const expectNoGraphAttempts = () => {
                if (external) expect(graphAttempts).toEqual({ requests: 0, tokenScopes: 0 });
            };
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const { subjectHash } = require('../../api/shared/customerSignup/customerAuthority');
            const reconstruct = accountType === 'company' && userType === 'ExternalAssertion';
            function journeyPool(label) {
                const { Pool } = require('pg');
                const raw = new Pool({ ...runtimePool.options, application_name: `journey-${label}-${runKey}` });
                const close = trackPoolClientEnds(raw);
                reconstructionPoolClosers.push(close);
                return { raw, close, restricted: tracedPool(raw, f.state) };
            }
            async function connectionIdentity(raw) {
                const result = await raw.query(`SELECT pg_backend_pid() AS backend_pid, current_user AS actor,
                    session_user AS session, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
                    FROM pg_roles WHERE rolname = current_user`);
                expect(result.rows).toHaveLength(1);
                expect(result.rows[0]).toMatchObject({ actor: runtimeRole, session: runtimeRole,
                    rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false });
                return result.rows[0];
            }
            async function retainedBusinessHashes() {
                const tables = [...DATA_TABLES, ...NCSC_TABLES, 'dashboard_starter_accounts', 'dashboard_starter_scopes',
                    'signup_acceptance_receipts', 'signup_registrations', 'dashboard_identity_bindings',
                    'dashboard_runtime_instance', 'dashboard_admission_authorities', 'dashboard_admission_decisions'];
                const records = {};
                for (const table of tables) {
                    const result = await ownerPool.query(`SELECT to_jsonb(retained) AS record FROM nofries.${table} retained
                        ORDER BY to_jsonb(retained)::text`);
                    records[table] = { count: result.rows.length, sha256: hash(result.rows) };
                }
                return records;
            }
            const firstJourneyPool = reconstruct ? journeyPool('original') : null;
            const originalConnection = firstJourneyPool ? await connectionIdentity(firstJourneyPool.raw) : null;
            const h = customerProductionHarness({ pool: firstJourneyPool?.restricted || f.restrictedPool, instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch,
                identity: { ...f.customerIdentity, audience: uid(7) }, now: Date.now(), starter: true, external, customerClientId: external ? uid(105) : null,
                ...(external ? { configureExternal({ dependencies }) {
                    // Count before denying: a caught provider failure must still
                    // expose any Graph dependency throughout this customer journey.
                    const isGraphTarget = value => {
                        try { return ['graph.microsoft.com', 'graph.windows.net'].includes(new URL(value).hostname); }
                        catch { return false; }
                    };
                    const fetch = dependencies.fetch;
                    dependencies.fetch = async function (...args) {
                        if (isGraphTarget(args[0]?.url || args[0])) {
                            graphAttempts.requests++;
                            throw new Error('Synthetic external customer Graph request denied');
                        }
                        return fetch.apply(this, args);
                    };
                    const Credential = dependencies.ManagedIdentityCredential;
                    dependencies.ManagedIdentityCredential = class extends Credential {
                        async getToken(scopes, ...args) {
                            if ((Array.isArray(scopes) ? scopes : [scopes]).some(scope =>
                                typeof scope === 'string' && scope.split(/\s+/).some(isGraphTarget))) {
                                graphAttempts.tokenScopes++;
                                throw new Error('Synthetic external customer Graph token scope denied');
                            }
                            return super.getToken(scopes, ...args);
                        }
                    };
                    if (userType !== 'ExternalAssertion') return;
                    const selected = dependencies.externalCustomer, clientApplication = selected.client.clientApplication;
                    // Synthetic provider-success evidence only. Actual factory,
                    // crypto failure and transport ownership have separate tests;
                    // this callback neither signs nor obtains any real token.
                    const clientAssertion = async context => { assertionCalls.push(context); return 'OFFLINE_ASSERTION_PLACEHOLDER'; };
                    const acquire = clientApplication.acquireTokenByCode;
                    clientApplication.acquireTokenByCode = async input => {
                        await clientAssertion({ clientId: selected.identityProvider.clientId,
                            tokenEndpoint: selected.identityProvider.authorizationEndpoint.replace(/\/authorize$/, '/token') });
                        return acquire(input);
                    };
                    selected.client = { clientAssertion, clientApplication };
                } } : {}) });
            expectNoGraphAttempts();
            if (userType === 'Member') h.state.directoryUsers = [{ id: h.state.oid, mail: null,
                userPrincipalName: 'synthetic_gmail.com#EXT#@resource.example.test', otherMails: ['synthetic@gmail.com'],
                proxyAddresses: [], accountEnabled: true, userType }];
            const post = (path, cookie, body, setupRequestId) => {
                const pending = h.sameOrigin(request(h.app).post(path)).set('Cookie', cookie || '');
                if (setupRequestId) pending.set('X-NoFries-Setup-Request', setupRequestId);
                return pending.send(body);
            };
            const details = { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true };
            if (external) {
                const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
                const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
                expect(before.body.state).toEqual({ status: 'setup_details', email: 'synthetic@gmail.com' });
                expect((await request(h.app).get('/api/dashboard/session').set('Cookie', provisional.cookie)).status).toBeGreaterThanOrEqual(400);
                const submitted = await post('/api/external-customer-signup/setup', provisional.cookie,
                    { accountType, organisationName: 'Unrelated synthetic business', details }).set('X-CSRF-Token', before.body.csrfToken);
                expect({ status: submitted.status, body: submitted.body }).toEqual({ status: 200, body: { state: { status: 'continue_authentication' } } });
                expect(h.state.delivered).toEqual([]);
                expect((await request(h.app).get('/api/dashboard/session').set('Cookie', provisional.cookie)).status).toBeGreaterThanOrEqual(400);
                expectNoGraphAttempts();
            } else {
                const start = await post('/api/organisation-setup/request', '', { organisationName: 'Unrelated synthetic business', email: 'synthetic@gmail.com', accountType });
                expect(start.status).toBe(202);
                const setupCookie = start.headers['set-cookie'][0].split(';')[0], code = h.state.delivered.find(d => d.kind === 'code').text.match(/\b\d{8}\b/)[0];
                const verified = await post('/api/organisation-setup/verify', setupCookie, { code }, start.body.requestId);
                expect(verified.status).toBe(200); expect(verified.body.nextStep).toBe('details_required');
                const submitted = await post('/api/organisation-setup/details', setupCookie, details, verified.body.requestId);
                expect(submitted.status).toBe(200); expect(submitted.body.nextStep).toBe('account_found');
            }
            const preparedAccounts = (await ownerPool.query('SELECT activated_at FROM nofries.dashboard_starter_accounts')).rows;
            if (external) expect(preparedAccounts).toHaveLength(0);
            else expect(preparedAccounts[0].activated_at).toBeNull();
            const delivered = h.state.delivered.find(d => d.kind === (userType === 'Member' ? 'member_invitation' : 'invitation'));
            const continuationUrl = external ? null : userType === 'Member' ? delivered.text.match(/https:\/\/nofries\.nz\/signup#invitation=[A-Za-z0-9_-]{43}/)[0] : delivered.inviteRedirectUrl;
            if (userType === 'Member') expect(h.state.delivered.some(d => d.kind === 'invitation')).toBe(false);
            const invitationToken = external ? null : new URLSearchParams(new URL(continuationUrl).hash.slice(1)).get('invitation');
            const authorityContainer = h.getContainer(external ? 'external-starter-authority' : 'starter-authority');
            const externalLogin = external ? await h.loginExternal() : null;
            const customerSubject = external ? h.dependencies.externalCustomer.identityProvider.tenantId + ':' + h.state.externalOid : subject(f.customerIdentity);
            const current = JSON.parse(authorityContainer.records.get(`customer-subjects/${subjectHash(customerSubject)}.json`));
            const login = externalLogin || await h.login({ authority: current, invitationToken }); expect(login.response.status).toBe(303);
            if (external) {
                expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_acceptance_receipts')).rows[0].count).toBe('0');
                expect((await ownerPool.query('SELECT count(*) FROM nofries.dashboard_identity_bindings')).rows[0].count).toBe('0');
                const invitations = h.getContainer('nofries-browser-auth').records;
                const key = `browser-auth/customer-signup/invitations/${current.invitationDigest}.json`;
                const original = invitations.get(key), invitation = JSON.parse(original);
                expect(invitation.mfaRequired).toBe(false);
                const offered = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
                expect(offered.body.state.status).toBe('terms');
                // Password-only external assurance cannot satisfy an invitation
                // that demands MFA; no false MFA assertion crosses the adapter.
                invitations.set(key, Buffer.from(JSON.stringify({ ...invitation, mfaRequired: true })));
                try {
                    const denied = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
                    expect({ status: denied.status, body: denied.body }).toEqual({ status: 200, body: { state: { status: 'unavailable' } } });
                    // Reuse the previously offered terms/CSRF to prove the mutation
                    // rechecks current MFA requirements, regardless of HTTP state status.
                    const blocked = await post('/api/external-customer-signup/terms', login.cookie, {
                        accepted: true, termsVersion: offered.body.state.termsVersion, termsDigest: offered.body.state.termsDigest,
                        scheduleId: offered.body.state.scheduleId, scheduleDigest: offered.body.state.scheduleDigest
                    }).set('X-CSRF-Token', offered.body.csrfToken);
                    expect(blocked.status).toBeGreaterThanOrEqual(400);
                    expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_acceptance_receipts')).rows[0].count).toBe('0');
                    expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_registrations')).rows[0].count).toBe('0');
                    expect((await ownerPool.query('SELECT count(*) FROM nofries.dashboard_identity_bindings')).rows[0].count).toBe('0');
                } finally { invitations.set(key, original); }
                expectNoGraphAttempts();
            }
            const consent = external ? await h.consentExternal(login.cookie) : await h.consent(login.cookie);
            expect(consent.before.body.state.status).toBe('terms'); expect({ status: consent.response.status, body: consent.response.body }).toMatchObject({
                status: 200, body: { state: { status: 'continue_to_dashboard', accountType } } });
            const again = await request(h.app).get(external ? '/api/external-customer-signup/state' : '/api/customer-signup/state').set('Cookie', login.cookie);
            expect(again.body.state.status).toBe('continue_to_dashboard');
            const session = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
            expect(session.status).toBe(200); expect(session.body.accountType).toBe(accountType);
            const directory = await request(h.app).get('/api/dashboard/organisations?limit=50').set('Cookie', login.cookie);
            expect(directory.status).toBe(200); expect(directory.body.bindings).toHaveLength(1);
            expectNoGraphAttempts();
            const { createProductionDashboardConfiguration } = require('../../lib/dashboardProduction');
            const { createProductionCustomerSignupConfiguration, createExternalCustomerSignupConfiguration } = require('../../lib/customerSignupProduction');
            const { starterAccountKey } = require('../../api/shared/customerSignup/starterAccountAllocation');
            const retainedAccount = JSON.parse(authorityContainer.records.get(`customer-starter/${starterAccountKey(current.email)}.json`));
            const ownSlot = retainedAccount.organisations[0];
            const quota = (external ? createExternalCustomerSignupConfiguration(h.env,
                createProductionDashboardConfiguration(h.env, h.dependencies), h.dependencies, h.dependencies.externalCustomer)
                : createProductionCustomerSignupConfiguration(h.env,
                    createProductionDashboardConfiguration(h.env, h.dependencies), h.dependencies)).resolveStarterQuota;
            const quotaSelection = { tenantId: current.tenantId, organisationId: current.organisationId,
                assessmentId: 'assessment-a', actorSubjectKey: current.subjectKey, moduleId: 'cyber_security',
                profileRef: require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF,
                productGrantId: ownSlot.grantId, agreementRef: ownSlot.scheduleId,
                expectedRevision: 1, submissionRevision: 2, at: retainedAccount.activation.activatedAt };
            expect(await quota(quotaSelection)).toMatchObject({ policyId: ownSlot.activationId,
                validFrom: retainedAccount.activation.activatedAt, validUntil: retainedAccount.activation.validUntil });
            await expect(quota({ ...quotaSelection, at: retainedAccount.activation.validUntil })).rejects.toThrow();
            for (const replacement of [{ productGrantId: nextId() }, { agreementRef: nextId() },
                { productGrantId: nextId(), agreementRef: nextId() }]) {
                expect(await quota({ ...quotaSelection, ...replacement, at: retainedAccount.activation.validUntil })).toBeNull();
            }
            const generationHeader = 'X-NoFries-Dashboard-Generation';
            const assessmentPost = command => {
                const { action, assessmentId, ...body } = command;
                return post('/api/dashboard/ncsc/assessments' + (action === 'create' ? '' : '/' + assessmentId + '/' + action),
                    login.cookie, action === 'create' ? { assessmentId, ...body } : body).set(generationHeader, session.body.generation);
            };
            expect((await assessmentPost(createCommand())).status).toBe(201);
            const saved = await assessmentPost(saveCommand()); expect(saved.status).toBe(200);
            const resumed = await request(h.app).get('/api/dashboard/ncsc/assessments/assessment-a').set('Cookie', login.cookie).set(generationHeader, session.body.generation);
            expect(resumed.status).toBe(200); expect(resumed.body.assessment).toEqual(saved.body.assessment);
            expectNoGraphAttempts();
            if (external) {
                const originalBinding = session.body.selectedBindingId, originalCookie = login.cookie;
                const originalGeneration = session.body.generation;
                const businessBefore = reconstruct ? await retainedBusinessHashes() : null;
                const authorityBefore = reconstruct ? hash([...authorityContainer.records]
                    .map(([key, value]) => [key, digest(value)]).sort(([a], [b]) => a.localeCompare(b))) : null;
                const logout = await post('/api/dashboard/logout', login.cookie, {}).set(generationHeader, session.body.generation);
                expect(logout.status).toBe(200);
                expect((await request(h.app).get('/api/dashboard/session').set('Cookie', originalCookie)).status).toBe(401);
                if (reconstruct) {
                    const originalApp = h.app, originalPool = h.pool;
                    // Same-process application/pool reconstruction only. SQL is
                    // real; managed identity, assertion and Blob remain fixtures.
                    await firstJourneyPool.close();
                    await expect(firstJourneyPool.raw.query('SELECT 1')).rejects.toThrow();
                    const replacement = journeyPool('reconstructed');
                    const freshConnection = await connectionIdentity(replacement.raw);
                    const { backend_pid: oldPid, ...oldRole } = originalConnection;
                    const { backend_pid: newPid, ...newRole } = freshConnection;
                    expect(newPid).not.toBe(oldPid);
                    expect(newRole).toEqual(oldRole);
                    h.recomposeWithPool(replacement.restricted);
                    expect(h.pool).not.toBe(originalPool);
                    expect(h.app).not.toBe(originalApp);
                }
                const returned = await h.loginExternal(); expect(returned.response.status).toBe(303);
                if (reconstruct) expect(returned.cookie).not.toBe(originalCookie);
                login.cookie = returned.cookie;
                const uninitialized = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
                expect({ status: uninitialized.status, body: uninitialized.body }).toEqual({
                    status: 409, body: { code: 'dashboard_initialization_required' } });
                // A fresh login deliberately requires the ordinary served loader
                // to initialize its new gate; login alone does not reuse the old one.
                const { servedDashboard } = require('../helpers/servedDashboard');
                const rendered = await servedDashboard({ app: h.app, cookie: login.cookie,
                    now: new Date(h.state.now).toISOString(), origin: h.env.NOFRIES_PUBLIC_URL,
                    ...(accountType === 'consultant' ? { chooseOrganisationLabel: directory.body.bindings[0].organisationLabel } : {}) });
                expect({ state: rendered.state, hidden: rendered.hidden }).toEqual({ state: 'ready', hidden: false });
                expect(rendered.trace).toEqual(expect.arrayContaining([
                    { url: '/api/dashboard/session', method: 'get', status: 409 },
                    { url: '/api/dashboard/session', method: 'post', status: 200 }
                ]));
                if (accountType === 'consultant') expect(rendered.trace).toContainEqual({ url: '/api/dashboard/selection', method: 'post', status: 200 });
                const fresh = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
                expect(fresh.status).toBe(200); expect(fresh.body.selectedBindingId).toBe(originalBinding);
                if (reconstruct) expect(fresh.body.generation).not.toBe(originalGeneration);
                session.body = fresh.body;
                const savedAgain = await request(h.app).get('/api/dashboard/ncsc/assessments/assessment-a')
                    .set('Cookie', login.cookie).set(generationHeader, session.body.generation);
                expect(savedAgain.status).toBe(200); expect(savedAgain.body.assessment).toEqual(saved.body.assessment);
                expect(JSON.parse(authorityContainer.records.get(`customer-starter/${starterAccountKey(current.email)}.json`))).toEqual(retainedAccount);
                expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_acceptance_receipts')).rows[0].count).toBe('1');
                if (reconstruct) {
                    expect(await retainedBusinessHashes()).toEqual(businessBefore);
                    expect(hash([...authorityContainer.records].map(([key, value]) => [key, digest(value)])
                        .sort(([a], [b]) => a.localeCompare(b)))).toBe(authorityBefore);
                    expect((await request(h.app).get('/api/dashboard/session').set('Cookie', originalCookie)).status).toBe(401);
                }
                if (userType === 'ExternalAssertion') {
                    expect(assertionCalls).toHaveLength(3);
                    expect(new Set(assertionCalls.map(value => value.clientId))).toEqual(new Set([h.dependencies.externalCustomer.identityProvider.clientId]));
                    expect(h.dependencies.externalCustomer.client).not.toHaveProperty('clientSecret');
                }
                expectNoGraphAttempts();
            }
            const submittedAssessment = await assessmentPost(submitCommand()); expect(submittedAssessment.status).toBe(200);
            expect(submittedAssessment.body.assessment).toMatchObject({ revision: 2, status: 'submitted' });
            expect((await assessmentPost(submitCommand())).body).toEqual(submittedAssessment.body);
            if (accountType === 'company') {
                for (let n = 2; n <= 6; n++) {
                    const id = 'synthetic-' + n;
                    expect((await assessmentPost(createCommand(id, 'create-' + n))).status).toBe(201);
                    expect((await assessmentPost(saveCommand(id, 0, 'save-' + n))).status).toBe(200);
                    const final = await assessmentPost(submitCommand(id, 1, 'submit-' + n));
                    expect(final.status).toBe(n <= 5 ? 200 : 409);
                    if (n === 6) expect(final.body.code).toBe('ncsc_quota_exceeded');
                }
                expect((await ownerPool.query('SELECT payload FROM nofries.dashboard_usage')).rows[0].payload.counters.assessment_runs).toBe(5);
            }
            if (accountType === 'company') {
                const denied = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie); expect(denied.status).toBeGreaterThanOrEqual(400);
            } else {
                expect(session.body.clientSetupAvailable).toBe(true);
                let list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
                expect(list.body.state.remaining).toBe(3);
                const { dataStorage } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
                const { normaliseEntitlementState } = require('../../api/shared/appLifecycle/entitlementDomain');
                const ownScope = { tenantId: current.tenantId, organisationId: current.organisationId };
                // A live membership does not by itself keep client creation
                // available after the parent product or dashboard is disabled.
                for (const change of ['product', 'dashboard']) {
                    async function enabled(value) {
                        await createPostgresDatabase({ pool: ownerPool }).withTenantTransaction(ownScope.tenantId, async tx => {
                            const snapshot = await dataStorage.loadSnapshotForUpdate(tx, ownScope);
                            if (change === 'product') {
                                await dataStorage.updateEntitlementState(tx, normaliseEntitlementState({ ...snapshot.entitlementState,
                                    revision: snapshot.entitlementState.revision + 1,
                                    grants: snapshot.entitlementState.grants.map(g => ({ ...g, status: value ? 'active' : 'suspended' })) }, snapshot.tenantAggregate));
                            } else await dataStorage.updateFlags(tx, { ...snapshot.flags, revision: snapshot.flags.revision + 1,
                                enabled: { ...snapshot.flags.enabled, dashboard: value } });
                        });
                    }
                    await enabled(false);
                    const denied = await post('/api/customer-signup/clients', login.cookie,
                        { action: 'create', requestId: nextId(), organisationName: 'Denied synthetic client', details }).set('X-CSRF-Token', list.body.csrfToken);
                    expect(denied.status).toBeGreaterThanOrEqual(400);
                    await enabled(true);
                    list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
                    expect(list.body.state.remaining).toBe(3);
                }
                h.state.clockOffset = 5 * 60000 + 1000;
                const stale = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
                expect(stale.status).toBe(401); expect(stale.body.code).toBe('starter_reauthentication_required');
                // The page was loaded while proof was fresh. Expiry while the
                // form is open must not reserve a client slot on submission.
                for (let attempt = 0; attempt < 2; attempt++) {
                    const staleCreate = await post('/api/customer-signup/clients', login.cookie,
                        { action: 'create', requestId: nextId(), organisationName: 'Expired proof client', details }).set('X-CSRF-Token', list.body.csrfToken);
                    expect(staleCreate.status).toBe(401);
                    expect(staleCreate.body.code).toBe('starter_reauthentication_required');
                }
                h.state.clockOffset = 0;
                list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie);
                expect(list.body.state).toEqual({ status: 'clients', clients: [], remaining: 3 });
                const requestId = nextId(), create = { action: 'create', requestId, organisationName: 'Synthetic client', details };
                const clientPost = body => h.sameOrigin(request(h.app).post('/api/customer-signup/clients')).set('Cookie', login.cookie).set('X-CSRF-Token', list.body.csrfToken).send(body);
                const offered = await clientPost(create); expect({ status: offered.status, body: offered.body }).toMatchObject({
                    status: 200, body: { state: { status: 'terms' } } });
                const repeated = await clientPost(create); expect(repeated.body.state).toEqual(offered.body.state);
                const { termsVersion, termsDigest, scheduleId, scheduleDigest } = offered.body.state;
                const accepted = await clientPost({ action: 'accept', requestId, terms: { accepted: true, termsVersion, termsDigest, scheduleId, scheduleDigest } });
                expect(accepted.status).toBe(200); expect(accepted.body.state.status).toBe('ready');
                const windows = (await ownerPool.query("SELECT activation->>'validFrom' AS start,activation->>'validUntil' AS stop FROM nofries.dashboard_starter_scopes ORDER BY ordinal")).rows;
                expect(windows).toHaveLength(2); expect(windows[0]).toEqual(windows[1]);
                list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie); expect(list.body.state.remaining).toBe(2);
                const two = await request(h.app).get('/api/dashboard/organisations?limit=50').set('Cookie', login.cookie);
                expect(two.body.bindings).toHaveLength(2);
                const client = two.body.bindings.find(b => b.bindingId !== session.body.selectedBindingId);
                const switched = await post('/api/dashboard/selection', login.cookie, { operationId: nextId(), bindingId: client.bindingId, expectedGeneration: session.body.generation });
                expect(switched.status).toBe(200);
                const foreign = await request(h.app).get('/api/dashboard/ncsc/assessments/assessment-a').set('Cookie', login.cookie).set(generationHeader, switched.body.generation);
                expect(foreign.status).toBe(404);
                for (let n = 2; n <= 3; n++) {
                    expect((await clientPost({ action: 'create', requestId: nextId(), organisationName: 'Synthetic client ' + n, details })).status).toBe(200);
                }
                const full = await clientPost({ action: 'create', requestId: nextId(), organisationName: 'Fourth synthetic client', details });
                expect(full.status).toBe(409); expect(full.body.code).toBe('starter_client_limit');
                // The real membership state, not a BFF or immutable plan, governs
                // further client operations after an owner revocation.
                await createPostgresDatabase({ pool: ownerPool }).withTenantTransaction(current.tenantId, async tx => {
                    const scope = { tenantId: current.tenantId, organisationId: current.organisationId };
                    const snapshot = await dataStorage.loadSnapshotForShare(tx, scope);
                    const next = applyMembershipCommand(snapshot.membershipState, snapshot.tenantAggregate, {
                        ...scope, expectedRevision: snapshot.membershipState.revision, actorSubjectKey: current.subjectKey,
                        now: new Date().toISOString(), action: 'suspend', payload: { membershipId: snapshot.membershipState.memberships[0].membershipId } });
                    await dataStorage.updateMembershipState(tx, next);
                });
                expect((await request(h.app).get('/api/customer-signup/clients').set('Cookie', login.cookie)).status).toBeGreaterThanOrEqual(400);
            }
            expect(h.state.delivered.filter(d => ['invitation', 'member_invitation'].includes(d.kind))).toHaveLength(external ? 0 : 1);
            expectNoGraphAttempts();
        });
        test('completed external claim retains canonical SQL activation across an unacknowledged Blob mirror and the initial offer deadline', async () => {
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const { starterAccountKey } = require('../../api/shared/customerSignup/starterAccountAllocation');
            const h = customerProductionHarness({ pool: f.restrictedPool, instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch,
                identity: { ...f.customerIdentity, audience: uid(7) }, now: Date.now(), starter: true, external: true, customerClientId: uid(105) });
            const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
            const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            const saved = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup')).set('Cookie', provisional.cookie)
                .set('X-CSRF-Token', before.body.csrfToken).send({ accountType: 'consultant', organisationName: 'Synthetic retained Consultant',
                    details: { name: 'Synthetic representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
            expect(saved.status).toBe(200);
            const login = await h.loginExternal(); expect(login.response.status).toBe(303);
            const starter = h.getContainer('external-starter-authority'), accountKey = `customer-starter/${starterAccountKey(h.state.externalEmail)}.json`;
            const allocated = JSON.parse(starter.records.get(accountKey)), original = starter.getBlockBlobClient.bind(starter);
            let interrupted = false;
            starter.getBlockBlobClient = key => {
                const blob = original(key), upload = blob.uploadData.bind(blob);
                if (key === accountKey) blob.uploadData = async (bytes, ...args) => {
                    if (JSON.parse(bytes).activation !== null) { interrupted = true; throw new Error('Synthetic lost Blob activation acknowledgement'); }
                    return upload(bytes, ...args);
                };
                return blob;
            };
            const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
            let accepted;
            try { accepted = await h.consentExternal(login.cookie); }
            finally { warning.mockRestore(); }
            expect(interrupted).toBe(true); expect(accepted.response.status).toBe(503);
            expect(JSON.parse(starter.records.get(accountKey))).toEqual(allocated);
            const canonical = (await ownerPool.query('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')).rows[0];
            expect(canonical.activation).not.toBeNull();
            const receipts = (await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows;
            expect(receipts).toHaveLength(1);
            expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_registrations')).rows[0].count).toBe('1');
            starter.getBlockBlobClient = original;
            const later = Date.now() + 8 * 86400000, clock = jest.spyOn(Date, 'now').mockReturnValue(later);
            h.state.now = later; f.state.now = new Date(later).toISOString();
            try {
                const fresh = await h.loginExternal(); expect(fresh.response.status).toBe(303);
                const resumed = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', fresh.cookie);
                expect({ status: resumed.status, body: resumed.body }).toMatchObject({ status: 200,
                    body: { state: { status: 'continue_to_dashboard', accountType: 'consultant' } } });
                const mirrored = JSON.parse(starter.records.get(accountKey));
                expect({ ...mirrored, activation: null }).toEqual(allocated);
                expect(mirrored.activation.activatedAt).toBe(canonical.activation.validFrom);
                expect(mirrored.activation.validUntil).toBe(canonical.activation.validUntil);
                expect((await ownerPool.query('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')).rows[0]).toEqual(canonical);
                expect((await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows).toEqual(receipts);
                expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_registrations')).rows[0].count).toBe('1');
            } finally { clock.mockRestore(); }
        });
        test.each([false, true])('approved saved Consultant recovery records actual consent and reaches its original workspace without operator authority (activation interrupted: %s)', async interruptActivation => {
            const f = fixture; f.state.now = new Date().toISOString(); await f.initialize();
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const { subjectHash } = require('../../api/shared/customerSignup/customerAuthority');
            const { starterAccountKey } = require('../../api/shared/customerSignup/starterAccountAllocation');
            const { prepareRecoveryAuthorization } = require('../../api/shared/customerSignup/savedSignupRecovery');
            const h = customerProductionHarness({ pool: f.restrictedPool, instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch,
                identity: { ...f.customerIdentity, audience: uid(7) }, now: Date.now(), starter: true });
            const email = 'preserved-consultant@example.invalid', organisationName = 'Original synthetic Consultant workspace';
            h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
                otherMails: [], proxyAddresses: [], accountEnabled: true, userType: 'Member' }];
            const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
                .send({ organisationName, email, accountType: 'consultant' });
            expect(start.status).toBe(202);
            const setupCookie = start.headers['set-cookie'][0].split(';')[0];
            const setupPost = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
                .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
            const code = h.state.delivered.find(d => d.kind === 'code').text.match(/\b\d{8}\b/)[0];
            expect((await setupPost('verify').send({ code })).body.nextStep).toBe('details_required');
            expect((await setupPost('details').send({ name: 'Synthetic saved representative', role: 'Owner',
                address: 'Synthetic saved address', registrationId: '', authorityConfirmed: true })).status).toBe(200);
            const starter = h.getContainer('starter-authority'), auth = h.getContainer('nofries-browser-auth');
            const authorityKey = `customer-subjects/${subjectHash(subject(f.customerIdentity))}.json`;
            const current = JSON.parse(starter.records.get(authorityKey));
            const accountKey = `customer-starter/${starterAccountKey(email)}.json`;
            const account = JSON.parse(starter.records.get(accountKey)), slot = account.organisations[0];
            const beforeScope = (await ownerPool.query('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')).rows[0];
            expect(beforeScope.activation).toBeNull(); expect(account.activation).toBeNull();
            const invitationKey = `browser-auth/customer-signup/invitations/${current.invitationDigest}.json`;
            const invitation = JSON.parse(auth.records.get(invitationKey));
            const invitationToken = h.state.delivered.find(d => d.kind === 'member_invitation').text.match(/#invitation=([A-Za-z0-9_-]{43})/)[1];
            const login = await h.login({ authority: current, invitationToken }); expect(login.response.status).toBe(303);
            auth.records.delete(invitationKey);
            const get = () => request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
            const blobSnapshot = () => [...starter.records].map(([key, value]) => [key, value.toString('base64')]);
            const beforeBlobs = blobSnapshot(), beforeSql = await exportAll();
            const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try { expect((await get()).body).toEqual({ state: { status: 'unavailable' } }); }
            finally { warning.mockRestore(); }
            expect(blobSnapshot()).toEqual(beforeBlobs); expect(await exportAll()).toEqual(beforeSql);
            expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_acceptance_receipts')).rows[0].count).toBe('0');
            const at = Date.now();
            const approval = prepareRecoveryAuthorization({ context: { authority: current, accountId: account.accountId,
                preparationSha256: hash(beforeScope.preparation), invitation, sessionId: crypto.randomBytes(32).toString('base64url'),
                verifiedAt: at, expiresAt: at + 3600000 }, approvalRef: 'synthetic-exact-customer-recovery-approval',
                approvedAt: at, expiresAt: at + 600000 });
            const approvalKey = `customer-signup-recoveries/${subjectHash(current.subjectKey)}.json`;
            h.getContainer('customer-authority').records.set(approvalKey, Buffer.from(JSON.stringify(approval)));
            const terms = await get(); expect(terms.status).toBe(200);
            expect(terms.body.state).toMatchObject({ status: 'terms', termsVersion: current.termsVersion,
                termsDigest: current.termsDigest, scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest });
            expect(terms.body.state.scheduleText).toContain(organisationName);
            expect(blobSnapshot()).toEqual(beforeBlobs); expect(await exportAll()).toEqual(beforeSql);
            expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_registrations')).rows[0].count).toBe('0');
            let interrupted = false;
            if (interruptActivation) f.state.hook = event => {
                if (event.phase === 'before' && event.sql.startsWith('UPDATE nofries.dashboard_starter_scopes SET activation=')) {
                    interrupted = true; throw new Error('Synthetic failure before original workspace activation');
                }
            };
            const accepted = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms'))
                .set('Cookie', login.cookie).set('X-CSRF-Token', terms.body.csrfToken).send({ accepted: true,
                    termsVersion: current.termsVersion, termsDigest: current.termsDigest,
                    scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest });
            expect(interrupted).toBe(interruptActivation); f.state.hook = null;
            if (interruptActivation) {
                expect(accepted.status).toBe(503);
                expect((await ownerPool.query('SELECT activation FROM nofries.dashboard_starter_scopes')).rows[0].activation).toBeNull();
                expect(JSON.parse(starter.records.get(accountKey))).toEqual(account);
                // Actual consent and its current registration survived the
                // failed activation. Approval expiry cannot force more consent
                // or reconstruct authority; ordinary continuation must finish.
                h.state.clockOffset = 10 * 60000 + 1000;
                expect((await get()).body.state).toEqual({ status: 'continue_to_dashboard', accountType: 'consultant' });
            } else expect({ status: accepted.status, body: accepted.body }).toMatchObject({ status: 200,
                body: { state: { status: 'continue_to_dashboard', accountType: 'consultant' } } });
            const receipt = (await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows[0].payload.receipt;
            expect(receipt).toMatchObject({ receiptId: approval.receiptId, invitationId: current.invitationId,
                subjectKey: current.subjectKey, tenantId: current.tenantId, organisationId: current.organisationId,
                termsVersion: current.termsVersion, termsDigest: current.termsDigest,
                scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest });
            expect(receipt.acceptedAt).toBeGreaterThanOrEqual(at);
            const afterScope = (await ownerPool.query('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')).rows[0];
            expect(afterScope.preparation).toEqual(beforeScope.preparation);
            const activated = JSON.parse(starter.records.get(accountKey));
            expect({ ...activated, activation: null }).toEqual(account);
            expect(Date.parse(activated.activation.validUntil) - Date.parse(activated.activation.activatedAt)).toBe(14 * 86400000);
            expect(activated.activation.activatedAt).toBe(afterScope.activation.validFrom);
            const retainedBefore = beforeBlobs.filter(([key]) => key !== accountKey);
            expect(blobSnapshot().filter(([key]) => key !== accountKey)).toEqual(retainedBefore);
            expect(auth.records.has(invitationKey)).toBe(false); expect(h.state.delivered).toHaveLength(2);
            const session = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
            expect(session.status).toBe(200); expect(session.body.accountType).toBe('consultant');
            expect(session.body.selectedBindingId).toBe(slot.bindingId);
            const directory = await request(h.app).get('/api/dashboard/organisations?limit=50').set('Cookie', login.cookie);
            expect(directory.status).toBe(200); expect(directory.body.bindings).toHaveLength(1);
            expect(directory.body.bindings[0]).toEqual({ bindingId: slot.bindingId, organisationLabel: organisationName });
            expect((await ownerPool.query('SELECT binding_id,tenant_id,organisation_id,subject_key FROM nofries.dashboard_identity_bindings')).rows)
                .toEqual([{ binding_id: slot.bindingId, tenant_id: slot.tenantId, organisation_id: slot.organisationId, subject_key: current.subjectKey }]);
            const gates = (await ownerPool.query('SELECT kind,operator_issuance_sha256 FROM nofries.dashboard_session_gates WHERE subject_key=$1', [current.subjectKey])).rows;
            expect(gates).toEqual([{ kind: 'customer', operator_issuance_sha256: null }]);
            expect(h.env.NOFRIES_ALLOWED_SUBJECTS).not.toContain(current.subjectKey);
            expect(h.env.NOFRIES_ADMIN_SUBJECTS).toBeUndefined();
            expect((await get()).body.state.status).toBe('continue_to_dashboard');
            expect(JSON.parse(starter.records.get(accountKey))).toEqual(activated);
            expect((await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows).toEqual([{ payload: expect.objectContaining({ receipt }) }]);
            expect((await ownerPool.query('SELECT count(*) FROM nofries.signup_registrations')).rows[0].count).toBe('1');
        });
        async function exportAll() {
            const result = {};
            for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES]) {
                const rows = await ownerPool.query(`SELECT to_jsonb(row_value) AS value FROM nofries.${table} row_value ORDER BY to_jsonb(row_value)::text`);
                result[table] = rows.rows.map(row => row.value);
            }
            return result;
        }
        async function unchangedFailure(work, code = 'onboarding_access_denied', statusCode = 403) {
            const before = await exportAll();
            await rejectsCode(work, code, statusCode);
            expect(await exportAll()).toEqual(before);
        }
        function acceptanceCommitFault(f, operationId, phase, inject) {
            const active = new Map(); let transactionSequence = 0;
            const observed = { receiptMarkers: 0, faults: 0, lookupCommits: 0, marker: null, fault: null, recoverySql: [], recoveryTrace: [] };
            f.state.hook = async event => {
                if (observed.faults && event.phase === 'before') { observed.recoverySql.push(event.sql); observed.recoveryTrace.push(event); }
                if (event.phase === 'after' && /^BEGIN\s*$/i.test(event.sql)) {
                    active.set(event.backendPid, { transaction: ++transactionSequence, backendPid: event.backendPid, armed: false });
                }
                const transaction = active.get(event.backendPid);
                if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_receipts\b/i.test(event.sql)
                    && event.params.includes(operationId)) {
                    expect(transaction).toBeDefined();
                    observed.receiptMarkers++; transaction.armed = true;
                    observed.marker = { transaction: transaction.transaction, backendPid: event.backendPid };
                }
                if (/^COMMIT\s*$/i.test(event.sql)) {
                    if (!observed.faults && transaction && transaction.armed && event.phase === phase) {
                        observed.faults++; observed.fault = { transaction: transaction.transaction, backendPid: event.backendPid };
                        await inject();
                    } else if (!observed.faults && event.phase === 'after') observed.lookupCommits++;
                }
                if (event.phase === 'after' && /^(COMMIT|ROLLBACK)\s*$/i.test(event.sql)) active.delete(event.backendPid);
            };
            return observed;
        }
        function expectAcceptanceCommitFault(observed) {
            expect(observed.lookupCommits).toBe(1);
            expect(observed.receiptMarkers).toBe(1); expect(observed.faults).toBe(1);
            expect(observed.fault).toEqual(observed.marker);
            expect(Number.isSafeInteger(observed.fault.backendPid) && observed.fault.backendPid > 0).toBe(true);
            expect(observed.fault.transaction).toBe(2);
        }
        async function rows(table, column, value) {
            return (await ownerPool.query(`SELECT to_jsonb(row_value) AS value FROM nofries.${table} row_value WHERE ${column} = $1 ORDER BY to_jsonb(row_value)::text`, [value])).rows.map(row => row.value);
        }
        async function insertRetainedReceipt(client, row) {
            // to_jsonb exports the required JSONB literal null as JS null.
            // jsonb_populate_record would turn it into forbidden SQL NULL;
            // restore only this nonnullable JSON field explicitly. All ordinary
            // nullable anchor/reference columns keep their original SQL null.
            const projection = RECEIPT_COLUMNS.map(column => column === 'scope_json'
                ? "COALESCE(restored.scope_json,'null'::jsonb)" : 'restored.' + column).join(', ');
            return client.query(`INSERT INTO nofries.dashboard_runtime_receipts (${RECEIPT_COLUMNS.join(', ')})
                SELECT ${projection} FROM jsonb_populate_record(NULL::nofries.dashboard_runtime_receipts,$1::jsonb) AS restored`, [JSON.stringify(row)]);
        }
        async function scopedSql(f, seed, extras, work, role = 'nofries_runtime', commit = false) {
            const client = await f.restrictedPool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SET LOCAL ROLE ' + role);
                const settings = { tenant_id: '', organisation_id: '', case_id: '', binding_id: '', authority_id: '', capability_sha256: '',
                    runtime_instance_id: f.instanceId, session_sha256: seed ? seed.sessionSha256 : '', session_kind: seed ? seed.kind : '',
                    identity_sha256: seed ? hash(seed.identityPayload) : '', subject_key: seed ? subject(seed.identityPayload) : '', request_id: nextId(), ...extras };
                for (const [name, value] of Object.entries(settings)) await client.query('SELECT set_config($1,$2,true)', ['nofries.' + name, value]);
                const result = await work(client);
                await client.query(commit ? 'COMMIT' : 'ROLLBACK');
                return result;
            } catch (error) { try { await client.query('ROLLBACK'); } catch (_) { /* Preserve the decisive SQL assertion. */ } throw error;
            } finally { client.release(); }
        }

        // Resource positives use the actual NCSC accepted-profile fixture and
        // public DATA initialization/publication APIs. This helper supplies only
        // synthetic trusted identity, quota and time; it never primes the role
        // for the resource runtime or substitutes its paired SQL audit.
        async function resourceSetup({ role = 'admin', service = false, rawRuntimePool = runtimePool,
            purpose = 'customer', exampleOptions = {}, historyBudget = BUDGET, prepareExample = null, productionIdentity = null } = {}) {
            const principal = productionIdentity || { ...identity(), identityTenantId: NCSC_SUBJECT.split(':')[0], oid: NCSC_SUBJECT.split(':')[1] };
            const f = harness({ rawRuntimePool, resourceIdentity: principal, historyBudget });
            await f.initialize();
            const quota = createNcscAdapters({ now: () => f.state.now });
            const resourceOptions = { pool: f.restrictedPool, clock: () => f.state.now, instanceId: f.instanceId,
                historyBudget: clone(historyBudget), captureRequest: f.options.captureRequest,
                readExternalRuntimeEpoch: f.options.readExternalRuntimeEpoch, newId: f.options.newId,
                resolveSubmissionQuota: selection => quota.resolveSubmissionQuota(selection) };
            async function addResource(selectedScope, options = {}, tenantRecord = null) {
                const example = ncscFixture({ now: f.state.now, ...selectedScope, role, service, ...exampleOptions, ...options });
                if (tenantRecord) example.state.tenantAggregate.tenant = clone(tenantRecord);
                if (prepareExample) prepareExample(example);
                if (exampleOptions.membershipEndsAt) {
                    example.state.membershipState.memberships[0].validUntil = exampleOptions.membershipEndsAt;
                    example.state.membershipState.invitations[0].validUntil = exampleOptions.membershipEndsAt;
                    example.state.membershipState.invitations[0].expiresAt = exampleOptions.membershipEndsAt;
                }
                const command = { ...example.scope, operationId: nextId(), actorSubjectKey: NCSC_SUBJECT, type: 'organisation.initialise',
                    expectedRevisions: { ...clone(EMPTY_REVISIONS), tenant: tenantRecord ? tenantRecord.revision : null }, payload: {} };
                const seedPool = { end: () => f.restrictedPool.end(), async connect() {
                    const client = await f.restrictedPool.connect();
                    return { release: value => client.release(value), async query(sql, params) {
                        const result = await client.query(sql, params); if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime'); return result;
                    } };
                } };
                const canonicalRepository = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: seedPool }),
                    clock: () => f.state.now, authoriseAdministration: value => value.tenantId === example.scope.tenantId
                        && value.organisationId === example.scope.organisationId && value.actorSubjectKey === NCSC_SUBJECT
                        && ((value.type === command.type && value.operationId === command.operationId) || value.type === 'membership.command' || value.type === 'flags.update') });
                let canonicalResult = await canonicalRepository.initialiseOrganisation(command, example.state);
                async function mutateMembership(action, payload) {
                    canonicalResult = await canonicalRepository.executeAuthorityCommand({ ...example.scope, operationId: nextId(),
                        actorSubjectKey: NCSC_SUBJECT, type: 'membership.command', expectedRevisions: clone(canonicalResult.resultRevisions), payload: { action, payload } });
                    return canonicalResult;
                }
                const member = example.state.membershipState.memberships[0];
                const effect = { schemaVersion: 1, operationType: 'publish_existing_membership', bindingId: nextId(), scope: example.scope,
                    membershipId: member.membershipId, invitationId: member.invitationId, grantEvidenceId: member.grantEvidenceId,
                    identity: principal, validFrom: member.validFrom, validUntil: member.validUntil };
                const admissionCommand = { operationId: nextId(), actorSubjectKey: NCSC_SUBJECT, authorityId: nextId(),
                    expectedRevision: null, expectedHeadSha256: null, payload: { target: example.scope,
                        identityPolicyRef: { policyId: principal.policyId, policyRevision: principal.policyRevision }, approvedEffectSha256: hash(effect),
                        evidenceRefs: [{ kind: 'approval', id: 'synthetic-resource-approval', sha256: digest('synthetic-resource-approval') }],
                        validFrom: START, validUntil: END } };
                const admission = await f.maintenance.publishAdmissionDecision(admissionCommand);
                const { schemaVersion, operationType, ...grant } = effect;
                const publication = await f.repository.publishExistingMembershipBinding(f.operator(), { ...grant, operationId: nextId(),
                    authorityRef: { authorityId: admission.record.authorityId, revision: admission.record.revision, sha256: admission.record.decisionSha256 } });
                async function mutateFlags(enabled) {
                    canonicalResult = await canonicalRepository.executeAuthorityCommand({ ...example.scope, operationId: nextId(),
                        actorSubjectKey: NCSC_SUBJECT, type: 'flags.update', expectedRevisions: clone(canonicalResult.resultRevisions),
                        payload: { ...clone(example.state.flags), revision: canonicalResult.resultRevisions.flags + 1,
                            enabled: { ...example.state.flags.enabled, ...enabled } } });
                    return canonicalResult;
                }
                return { example, member, admission, admissionCommand, publication, canonicalRepository, mutateMembership, mutateFlags };
            }
            const target = await addResource(f.scope);
            const seed = purpose === 'operator_dashboard' ? f.operatorSeed : f.session(purpose, principal);
            let selected;
            if (purpose === 'operator_dashboard') {
                const gate = (await rows('dashboard_session_gates', 'session_sha256', seed.sessionSha256))[0];
                selected = await f.repository.selectBinding(f.request(seed), { operationId: nextId(), bindingId: target.publication.binding.bindingId,
                    expectedGeneration: gate.generation_token });
            } else selected = await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: target.publication.binding.bindingId });
            async function bindResource({ selectedSeed = seed, generation = selected.record.generationToken,
                overrides = {}, original = f.request(selectedSeed) } = {}) {
                const runtime = createDashboardResourceRuntime({ ...resourceOptions, ...overrides });
                const facade = await runtime.forRequest(original, { expectedGeneration: generation });
                return { facade, context: await facade.requestContext.resolve(original), original };
            }
            const bound = await bindResource();
            return { ...f, ...target, ...bound, seed, selected, quota, resourceOptions, bindResource, addResource };
        }
        require('./improvementPlanRecovery')({ resourceSetup,
            getPools: () => ({ ownerPool, controlPool, runtimePool, maintenancePool }), testUrl, maintenanceRole });
        async function newCustomerActivationSetup({ shortWindow = false, memberLimit = null, memberRole = 'admin' } = {}) {
            const request = require('supertest');
            const { customerProductionHarness, uid: customerId } = require('../helpers/customerProductionHarness');
            const codec = require('../../api/shared/customerSignup/customerActivation');
            const tenant = nextId(), principal = { ...identity(), identityTenantId: tenant, oid: nextId(),
                issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience: nextId() };
            const admin = { ...principal, oid: customerId(99) };
            const f = harness({ resourceIdentity: admin }); fixture = f; await f.initialize();
            const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal, adminSubject: subject(admin),
                instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now) });
            const user = h.addUser({ ...f.scope, prepared: false });
            const selected = clone(template(f.scope, nextId())), tenantAggregate = selected.bootstrap.tenantAggregate;
            if (memberLimit !== null) selected.bootstrap.entitlementState.grants[0].limits.memberships = memberLimit;
            let membershipState = createMembershipState(tenantAggregate, f.scope, NOW);
            const expiresAt = new Date(Date.parse(NOW) + (shortWindow ? 30000 : 3600000)).toISOString();
            membershipState = applyMembershipCommand(membershipState, tenantAggregate, { ...f.scope,
                expectedRevision: 0, actorSubjectKey: subject(admin), now: NOW, action: 'invite', payload: {
                    invitationId: user.record.invitationId, subjectKey: subject(principal), roles: [memberRole], validFrom: NOW,
                    validUntil: END, grantEvidenceId: 'synthetic-explicit-role-approval', expiresAt } });
            const candidate = { schemaVersion: 1, activationId: nextId(), approvalRef: 'synthetic-explicit-customer-approval',
                approvedBy: subject(admin), approvedAt: NOW, expiresAt,
                authoritySha256: hash(user.authority), authorityRevision: user.authority.revision,
                subjectKey: subject(principal), invitationId: user.record.invitationId, membershipId: 'synthetic-new-customer-member',
                termsVersion: h.termsVersion, termsDigest: h.termsDigest, scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest,
                scope: f.scope, identity: principal, bootstrapOperationId: nextId(), acceptOperationId: nextId(),
                publicationOperationId: nextId(), bindingId: selected.bindingId, bootstrapExpectedRevisions: clone(EMPTY_REVISIONS),
                initialState: { tenantAggregate, membershipState, entitlementState: selected.bootstrap.entitlementState,
                    flags: selected.bootstrap.flags, advisorAssignments: [] } };
            const admissionInput = f.admissionCommand(selected);
            admissionInput.payload.approvedEffectSha256 = hash(codec.activationPublicationEffect(candidate));
            const admission = await f.maintenance.publishAdmissionDecision(admissionInput);
            const approval = codec.normaliseActivationApproval({ ...candidate, authorityRef: { authorityId: admission.record.authorityId,
                revision: admission.record.revision, sha256: admission.record.decisionSha256 } });
            h.getContainer('customer-authority').records.set(codec.activationKey(approval.activationId), Buffer.from(JSON.stringify(approval)));
            h.getContainer('customer-authority').records.set(codec.activationReferenceKey(user.authority), Buffer.from(JSON.stringify(codec.activationReference(approval))));
            h.state.oid = admin.oid;
            const start = await request(h.app).get('/api/auth/login?returnTo=%2Fdashboard');
            const callback = await request(h.app).post('/api/auth/callback').set('Cookie', start.headers['set-cookie'][0].split(';')[0]).type('form')
                .send({ code: 'synthetic-code', state: new URL(start.headers.location).searchParams.get('state') });
            expect(callback.status).toBe(303);
            const operatorCookie = callback.headers['set-cookie'].find(value => value.startsWith('__Host-nofries-auth=')).split(';')[0];
            expect((await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', operatorCookie).send({ operationId: nextId() })).status).toBe(200);
            const action = phase => h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', operatorCookie)
                .send({ action: 'customer_activation', activationId: approval.activationId, phase });
            return { f, h, user, approval, admissionInput, request, codec, operatorCookie, action };
        }
        test('production operator route prepares an empty-membership organisation then processes genuine customer consent and preserves isolation/revocation', async () => {
            const a = await newCustomerActivationSetup({ memberLimit: 1 }), { f, h, user, approval, request, action, codec } = a;
            const accessSnapshot = async () => {
                const saved = await exportAll();
                for (const table of ['signup_acceptance_receipts', 'signup_registrations']) {
                    saved[table] = (await ownerPool.query(`SELECT to_jsonb(row_value) AS value FROM nofries.${table} row_value ORDER BY to_jsonb(row_value)::text`)).rows;
                }
                return saved;
            };
            const manifest = jest.spyOn(require('../../api/shared/releaseIdentity'), 'getReleaseIdentity')
                .mockReturnValue({ releaseSha: 'f'.repeat(40) }); // External release stamp only; no handler/proof substitution.
            try {
                const initialLogin = await h.login(user); expect(initialLogin.response.status).toBe(303);
                expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', initialLogin.cookie)).body.state.status).toBe('pending_preparation');
                expect((await action('activate')).status).toBeGreaterThanOrEqual(400);
                const prepared = await action('prepare'); expect(prepared.status).toBe(200);
                expect(prepared.body).toMatchObject({ phase: 'prepared', next: 'customer_terms' });
                expect((await action('prepare')).status).toBe(200); // Same immutable operation is replayed.
                const stateRow = (await ownerPool.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2', [f.scope.tenantId, f.scope.organisationId])).rows[0];
                expect(stateRow.payload.memberships).toEqual([]);
                expect((await ownerPool.query('SELECT binding_id FROM nofries.dashboard_identity_bindings')).rows).toEqual([]);
                const beforeUnboundAccess = await accessSnapshot();
                // Missing approved binding is an unavailable production authority
                // provider (503); it must never reach the SQL session mutator.
                const unbound = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', initialLogin.cookie).send({ operationId: nextId() });
                expect(unbound.status).toBe(503); expect(unbound.body).toEqual({ code: 'dashboard_unavailable' });
                expect(await accessSnapshot()).toEqual(beforeUnboundAccess);
                const consent = await h.consent(initialLogin.cookie); expect(consent.response.status).toBe(200);
                expect(consent.response.body.state.status).toBe('pending_admission');
                const activated = await action('activate'); expect(activated.status).toBe(200);
                expect(activated.body).toMatchObject({ phase: 'activated', next: 'owner_finalisation' });
                expect((await action('activate')).status).toBe(200);
                const receipt = (await ownerPool.query('SELECT payload FROM nofries.signup_acceptance_receipts WHERE tenant_id=$1 AND organisation_id=$2', [f.scope.tenantId, f.scope.organisationId])).rows[0].payload.receipt;
                const accepted = (await ownerPool.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2', [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
                expect(accepted.memberships).toHaveLength(1);
                expect(accepted.memberships[0]).toMatchObject({ subjectKey: approval.subjectKey, createdBy: approval.subjectKey,
                    createdAt: new Date(receipt.acceptedAt).toISOString() });
                const quota = (await ownerPool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2',
                    [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
                expect(quota.revision).toBe(1); expect(quota.counters.memberships).toBe(1);
                const reserve = codec.buildActivationCommands(approval).reserveMembership;
                const seedPool = { end: () => f.restrictedPool.end(), async connect() {
                    const client = await f.restrictedPool.connect();
                    return { release: value => client.release(value), async query(sql, params) {
                        const result = await client.query(sql, params);
                        if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                        return result;
                    } };
                } };
                const data = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: seedPool }),
                    clock: () => f.state.now, authoriseAdministration: () => false });
                await expect(data.reserveInitialMembership(reserve)).rejects.toThrow(/administration_denied/);
                await expect(data.reserveUsage({ ...reserve, operationId: nextId(), expectedRevisions: {
                    ...reserve.expectedRevisions, usage: [{ grantId: reserve.payload.grantId, revision: 1 }] } })).rejects.toThrow(/limit_exceeded/);
                const completion = JSON.parse(h.getContainer('nofries-browser-auth').records.get(codec.completionKey(approval.activationId)));
                const quotaReceipt = (await ownerPool.query('SELECT payload FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                    [f.scope.tenantId, f.scope.organisationId, reserve.operationId])).rows[0].payload;
                expect(completion.result).toMatchObject({ schemaVersion: 2, bindingId: approval.bindingId, acceptanceReceiptId: receipt.receiptId,
                    membershipReservationOperationId: reserve.operationId, membershipReservationResultSha256: hash(quotaReceipt.result),
                    membershipReservationResult: quotaReceipt.result });
                // Only the separate owner CAS changes this external fixture. The
                // production controller's exact CAS is covered in its own tests.
                user.authority.bindingId = approval.bindingId; user.authority.revision++; user.save();
                const beforeStaleSession = await accessSnapshot();
                // The authority CAS invalidates the old BFF assurance. Its
                // provider refuses it before any SQL session mutation.
                const stale = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', initialLogin.cookie).send({ operationId: nextId() });
                expect(stale.status).toBe(401); expect(stale.body).toEqual({ code: 'dashboard_authentication_required' });
                expect(await accessSnapshot()).toEqual(beforeStaleSession);
                const fresh = await h.login(user, { bootstrap: false }); expect(fresh.response.status).toBe(303);
                expect((await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', fresh.cookie).send({ operationId: nextId() })).status).toBe(200);
                const session = await request(h.app).get('/api/dashboard/session').set('Cookie', fresh.cookie);
                expect(session.status).toBe(200); expect(session.body.selectedBindingId).toBe(approval.bindingId);
                const directory = await request(h.app).get('/api/dashboard/organisations').set('Cookie', fresh.cookie);
                expect(directory.body.bindings.map(value => value.bindingId)).toEqual([approval.bindingId]);
                const foreign = h.addUser({ oid: nextId(), ...f.scope, bindingId: approval.bindingId });
                const foreignLogin = await h.login(foreign);
                expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', foreignLogin.cookie)).body.state.status).toBe('pending_preparation');
                expect((await h.consent(foreignLogin.cookie)).response.status).toBe(403);
                expect((await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', foreignLogin.cookie).send({ operationId: nextId() })).status).toBe(503);
                await f.maintenance.withdrawAdmissionDecision({ operationId: nextId(), actorSubjectKey: subject(f.operatorIdentity),
                    authorityId: approval.authorityRef.authorityId, expectedRevision: approval.authorityRef.revision,
                    expectedHeadSha256: approval.authorityRef.sha256, payload: { ...a.admissionInput.payload, evidenceRefs: [{ kind: 'approval', id: 'synthetic-revocation', sha256: digest('synthetic-revocation') }] } });
                expect((await request(h.app).get('/api/dashboard/session').set('Cookie', fresh.cookie)).status).toBe(403);
                expect((await action('activate')).status).toBeGreaterThanOrEqual(400);
                expect((await ownerPool.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2', [f.scope.tenantId, f.scope.organisationId])).rows[0].payload).toEqual(accepted);
            } finally { manifest.mockRestore(); }
            await loginClean();
        });
        test('first-user quota failure rolls back membership and binding together and retries charge only once', async () => {
            const manifest = jest.spyOn(require('../../api/shared/releaseIdentity'), 'getReleaseIdentity')
                .mockReturnValue({ releaseSha: 'f'.repeat(40) });
            try {
            const { f, h, user, approval, action } = await newCustomerActivationSetup({ memberLimit: 1 });
            expect((await action('prepare')).status).toBe(200);
            const login = await h.login(user); expect((await h.consent(login.cookie)).response.status).toBe(200);
            let failures = 0;
            f.state.hook = event => {
                if (event.phase === 'after' && /^UPDATE nofries.dashboard_usage\b/.test(event.sql) && !failures++) throw new Error('synthetic quota failure');
            };
            try { expect((await action('activate')).status).toBeGreaterThanOrEqual(400); }
            finally { f.state.hook = null; }
            expect(failures).toBe(1);
            const snapshot = async table => (await ownerPool.query(`SELECT payload FROM nofries.${table} WHERE tenant_id=$1 AND organisation_id=$2`,
                [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
            expect((await snapshot('dashboard_membership_states')).memberships).toEqual([]);
            expect((await snapshot('dashboard_usage')).counters.memberships).toBe(0);
            expect((await ownerPool.query('SELECT binding_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [approval.bindingId])).rows).toEqual([]);
            expect((await action('activate')).status).toBe(200); expect((await action('activate')).status).toBe(200);
            expect((await snapshot('dashboard_membership_states')).memberships).toHaveLength(1);
            expect((await snapshot('dashboard_usage')).counters.memberships).toBe(1);
            await loginClean();
            } finally { manifest.mockRestore(); }
        });
        test('completion independently reads the committed quota receipt and a missing readback retries without a second charge', async () => {
            const manifest = jest.spyOn(require('../../api/shared/releaseIdentity'), 'getReleaseIdentity')
                .mockReturnValue({ releaseSha: 'f'.repeat(40) });
            try {
                const { f, h, user, approval, action, codec } = await newCustomerActivationSetup({ memberLimit: 1 });
                expect((await action('prepare')).status).toBe(200);
                const login = await h.login(user); expect((await h.consent(login.cookie)).response.status).toBe(200);
                const reservationId = codec.buildActivationCommands(approval).reserveMembership.operationId;
                let missingReads = 0;
                f.state.hook = event => {
                    if (event.phase === 'after' && /^SELECT \* FROM nofries.dashboard_operation_receipts\b/.test(event.sql) &&
                        event.params[2] === reservationId && event.result.rows.length === 1) {
                        missingReads++; event.result.rows = [];
                    }
                };
                try { expect((await action('activate')).status).toBe(503); }
                finally { f.state.hook = null; }
                expect(missingReads).toBe(1);
                expect(h.getContainer('nofries-browser-auth').records.has(codec.completionKey(approval.activationId))).toBe(false);
                const usage = async () => (await ownerPool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2',
                    [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
                expect((await usage()).counters.memberships).toBe(1);
                expect((await action('activate')).status).toBe(200);
                expect((await usage()).counters.memberships).toBe(1);
                expect((await usage()).revision).toBe(1);
                expect(h.getContainer('nofries-browser-auth').records.has(codec.completionKey(approval.activationId))).toBe(true);
                await loginClean();
            } finally { manifest.mockRestore(); }
        });
        test('an explicitly approved first viewer consumes a seat without acquiring member-management permission', async () => {
            const manifest = jest.spyOn(require('../../api/shared/releaseIdentity'), 'getReleaseIdentity')
                .mockReturnValue({ releaseSha: 'f'.repeat(40) });
            try {
            const { f, h, user, action } = await newCustomerActivationSetup({ memberLimit: 1, memberRole: 'viewer' });
            expect((await action('prepare')).status).toBe(200);
            const login = await h.login(user); expect((await h.consent(login.cookie)).response.status).toBe(200);
            expect((await action('activate')).status).toBe(200);
            const membership = (await ownerPool.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2',
                [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
            expect(membership.memberships[0].roles).toEqual(['viewer']);
            const usage = (await ownerPool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2',
                [f.scope.tenantId, f.scope.organisationId])).rows[0].payload;
            expect(usage.counters.memberships).toBe(1);
            await loginClean();
            } finally { manifest.mockRestore(); }
        });
        test.each(['approval', 'authority'])('new customer preparation withholds COMMIT when %s expires during final timeout setup', async cutoffKind => {
            const a = await newCustomerActivationSetup({ shortWindow: true }), { f, h, user, approval, action, codec } = a;
            if (cutoffKind === 'authority') {
                user.authority.expiresAt = Date.parse(NOW) + 10000; user.save();
                const changed = { ...approval, authoritySha256: hash(user.authority) };
                h.getContainer('customer-authority').records.set(codec.activationKey(approval.activationId), Buffer.from(JSON.stringify(changed)));
            }
            const cutoff = cutoffKind === 'authority' ? user.authority.expiresAt : Date.parse(approval.expiresAt);
            const before = await exportAll(); let final = false, expired = 0, commits = 0;
            mockResourceAfterWork = () => { final = true; };
            f.state.hook = event => {
                if (final && !expired && event.phase === 'after' && isRuntimeTimeout(event.sql)) {
                    expired++; h.state.now = cutoff; f.state.now = new Date(cutoff).toISOString();
                }
                if (final && event.phase === 'before' && event.sql === 'COMMIT') commits++;
            };
            expect((await action('prepare')).status).toBeGreaterThanOrEqual(400);
            f.state.hook = null; mockResourceAfterWork = null;
            expect(expired).toBe(1); expect(commits).toBe(0); expect(await exportAll()).toEqual(before);
            await loginClean();
        });

        test.each(['another operation', 'another initial state'])('an organisation prepared for %s does not permit this approval to record consent', async defect => {
            const { f, h, user, approval, action, codec, request } = await newCustomerActivationSetup();
            const changed = clone(approval);
            if (defect === 'another operation') changed.bootstrapOperationId = nextId();
            else changed.initialState.entitlementState.grants[0].limits.memberships++;
            const records = h.getContainer('customer-authority').records;
            records.set(codec.activationKey(approval.activationId), Buffer.from(JSON.stringify(changed)));
            expect((await action('prepare')).status).toBe(200);
            records.set(codec.activationKey(approval.activationId), Buffer.from(JSON.stringify(approval)));
            const before = await exportAll(), login = await h.login(user);
            const result = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
            expect(result.status).toBe(200); expect(result.body.state.status).toBe('pending_preparation');
            expect(result.body.csrfToken).toBeUndefined();
            expect((await h.consent(login.cookie)).response.status).toBe(403);
            expect((await ownerPool.query('SELECT receipt_id FROM nofries.signup_acceptance_receipts WHERE tenant_id=$1 AND organisation_id=$2',
                [f.scope.tenantId, f.scope.organisationId])).rows).toEqual([]);
            expect(await exportAll()).toEqual(before);
            await loginClean();
        });

        test.each([undefined, 'company', 'consultant'])('production launcher HTTP joins %p signup to dashboard activation, isolation and revocation', async accountType => {
            const request = require('supertest');
            const { customerProductionHarness } = require('../helpers/customerProductionHarness');
            const { servedDashboard } = require('../helpers/servedDashboard');
            const tenant = NCSC_SUBJECT.split(':')[0];
            const principal = { ...identity(), identityTenantId: tenant, oid: NCSC_SUBJECT.split(':')[1],
                issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience: nextId() };
            const f = await resourceSetup({ productionIdentity: principal });
            const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal,
                instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now) });
            const anotherOwned = await f.addResource({ tenantId: f.scope.tenantId + '-separate', organisationId: 'separate-owned-org' });
            const user = h.addUser({ ...f.scope, bindingId: anotherOwned.publication.binding.bindingId });
            if (accountType) { user.authority.accountType = accountType; user.save(); }
            expect((await request(h.app).get('/signup')).status).toBe(200);
            let login = await h.login(user); expect(login.response.status).toBe(303);
            const consent = await h.consent(login.cookie);
            expect(consent.before.body.state.status).toBe('terms');
            expect(consent.response.status).toBe(200);
            expect(consent.response.body.state).toEqual({ status: 'continue_to_dashboard', ...(accountType ? { accountType } : {}) });
            const persistedSchedule = (await ownerPool.query(
                `SELECT schedule_id,schedule_digest,payload FROM nofries.signup_acceptance_receipts
                 WHERE tenant_id=$1 AND organisation_id=$2 AND invitation_id=$3`,
                [f.scope.tenantId, f.scope.organisationId, user.record.invitationId]
            )).rows[0];
            expect(persistedSchedule).toEqual(expect.objectContaining({
                schedule_id: user.scheduleId, schedule_digest: user.scheduleDigest
            }));
            expect(persistedSchedule.payload.receipt).toEqual(expect.objectContaining({
                invitationId: user.record.invitationId,
                scheduleId: user.scheduleId,
                scheduleDigest: user.scheduleDigest
            }));
            const wrongScope = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', login.cookie)
                .send({ operationId: nextId() });
            expect(wrongScope.status).toBe(403);
            user.authority.bindingId = f.publication.binding.bindingId; user.authority.revision++; user.save();
            login = await h.login(user, { bootstrap: false }); expect(login.response.status).toBe(303);
            user.deleteBootstrap();
            expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie)).body.state.status).toBe('continue_to_dashboard');
            expect((await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie)).status).toBe(409);
            const landing = await servedDashboard({ app: h.app, cookie: login.cookie, now: f.state.now, origin: h.env.NOFRIES_PUBLIC_URL });
            if (accountType === 'consultant') {
                expect(landing.state).toBe('selection'); expect(landing.hidden).toBe(true);
                expect(landing.trace.some(item => item.url === '/api/dashboard/bootstrap')).toBe(false);
            }
            const rendered = accountType === 'consultant' ? await servedDashboard({ app: h.app, cookie: login.cookie,
                now: f.state.now, origin: h.env.NOFRIES_PUBLIC_URL, hash: '#overview' }) : landing;
            expect(rendered.state).toBe('ready'); expect(rendered.hidden).toBe(false);
            expect(landing.trace).toEqual(expect.arrayContaining([
                { url: '/api/dashboard/session', method: 'post', status: 200 }
            ]));
            const session = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
            expect(session.status).toBe(200); expect(session.body.purpose).toBe('customer');
            expect(session.body.accountType).toBe(accountType);
            expect(session.body.selectedBindingId).toBe(f.publication.binding.bindingId);
            const directory = await request(h.app).get('/api/dashboard/organisations').set('Cookie', login.cookie);
            expect(directory.status).toBe(200);
            const availableBindings = (accountType === 'consultant'
                ? [f.publication.binding.bindingId, anotherOwned.publication.binding.bindingId] : [f.publication.binding.bindingId]).sort();
            expect(directory.body.bindings.map(value => value.bindingId)).toEqual(availableBindings);
            expect(directory.body.nextAfterBindingId).toBeNull();
            const afterApproved = await request(h.app).get('/api/dashboard/organisations?afterBindingId=' + f.publication.binding.bindingId)
                .set('Cookie', login.cookie);
            expect(afterApproved.status).toBe(200);
            expect(afterApproved.body.bindings.map(value => value.bindingId)).toEqual(availableBindings.filter(id => id > f.publication.binding.bindingId));
            const bootstrap = await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', login.cookie)
                .set('X-NoFries-Dashboard-Generation', session.body.generation);
            expect(bootstrap.status).toBe(200);
            expect(rendered.text).toContain(bootstrap.body.context.displayName);
            expect(rendered.trace).toEqual(expect.arrayContaining([
                expect.objectContaining({ url: '/api/dashboard/app.js', status: 200 }),
                expect.objectContaining({ url: '/api/dashboard/dashboard.css', status: 200 })
            ]));
            const switchOwned = await h.sameOrigin(request(h.app).post('/api/dashboard/selection')).set('Cookie', login.cookie)
                .send({ operationId: nextId(), bindingId: anotherOwned.publication.binding.bindingId, expectedGeneration: session.body.generation });
            expect(switchOwned.status).toBe(accountType === 'consultant' ? 200 : 403);
            if (accountType === 'consultant') {
                const clientView = await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', login.cookie)
                    .set('X-NoFries-Dashboard-Generation', switchOwned.body.generation);
                expect(clientView.status).toBe(200);
                expect(clientView.body.context.organisationId).toBe('separate-owned-org');
                expect((await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', login.cookie)
                    .set('X-NoFries-Dashboard-Generation', session.body.generation)).status).toBe(403);
                const back = await h.sameOrigin(request(h.app).post('/api/dashboard/selection')).set('Cookie', login.cookie)
                    .send({ operationId: nextId(), bindingId: f.publication.binding.bindingId, expectedGeneration: switchOwned.body.generation });
                expect(back.status).toBe(200); session.body.generation = back.body.generation;
            }
            const secondPrincipal = { ...principal, oid: nextId() };
            const foreign = harness({ resourceIdentity: secondPrincipal }); await foreign.initialize();
            const setup = await foreign.publicationSetup();
            const other = await foreign.repository.publishExistingMembershipBinding(foreign.operator(), setup.command);
            const denied = await h.sameOrigin(request(h.app).post('/api/dashboard/selection')).set('Cookie', login.cookie)
                .send({ operationId: nextId(), bindingId: other.binding.bindingId, expectedGeneration: session.body.generation });
            expect(denied.status).toBe(403);
            const additional = h.addUser({ oid: secondPrincipal.oid, ...foreign.scope, bindingId: other.binding.bindingId });
            const additionalLogin = await h.login(additional); expect(additionalLogin.response.status).toBe(303);
            expect((await h.consent(additionalLogin.cookie)).response.status).toBe(200);
            const additionalActivation = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', additionalLogin.cookie)
                .send({ operationId: nextId() });
            expect(additionalActivation.status).toBe(200);
            const own = await request(h.app).get('/api/dashboard/session').set('Cookie', additionalLogin.cookie);
            expect(own.status).toBe(200); expect(own.body.selectedBindingId).toBe(other.binding.bindingId);
            // A third subject cannot adopt the first customer's binding, even
            // when an administrative signup record mistakenly points at it.
            const second = h.addUser({ oid: nextId(), ...f.scope, bindingId: f.publication.binding.bindingId });
            const secondLogin = await h.login(second); expect(secondLogin.response.status).toBe(303);
            expect((await h.consent(secondLogin.cookie)).response.status).toBe(403);
            const wrongIdentity = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', secondLogin.cookie)
                .send({ operationId: nextId() });
            expect(wrongIdentity.status).toBe(503);
            await f.mutateMembership('suspend', { membershipId: f.member.membershipId });
            expect((await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', login.cookie)
                .set('X-NoFries-Dashboard-Generation', session.body.generation)).status).toBe(403);
            const revoked = await servedDashboard({ app: h.app, cookie: login.cookie, now: f.state.now, origin: h.env.NOFRIES_PUBLIC_URL, hash: '#overview' });
            expect(revoked.state).toBe('denied'); expect(revoked.hidden).toBe(true); expect(revoked.text).toBe('');
        });

        async function evidenceResourceSetup() {
            const f = await resourceSetup({ prepareExample(example) {
                const product = example.state.entitlementState.grants.find(g => g.grantId === 'synthetic-product');
                product.modules = [...product.modules, 'evidence'].sort();
                example.state.flags.enabled.evidence = true;
            } });
            const { evidenceFixture } = require('../fixtures/evidenceMetadataFixture');
            const { createPostgresEvidenceStore } = require('../../api/shared/evidenceLifecycle/postgresEvidenceStore');
            const synthetic = evidenceFixture({ now: f.state.now, tenantId: f.scope.tenantId, organisationId: f.scope.organisationId });
            expect(synthetic.scope).toEqual(f.scope);
            expect({ tenantId: synthetic.command.tenantId, organisationId: synthetic.command.organisationId }).toEqual(f.scope);
            // Synthetic seeding uses the established restricted LOGIN and its
            // explicit runtime role, satisfying the store's real role/RLS fence.
            const seedPool = { end: () => f.restrictedPool.end(), async connect() {
                const client = await f.restrictedPool.connect();
                return { release: value => client.release(value), async query(sql, params) {
                    const result = await client.query(sql, params);
                    if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                    return result;
                } };
            } };
            const store = createPostgresEvidenceStore({ database: createPostgresDatabase({ pool: seedPool }) });
            await store.execute(synthetic.command);
            return { ...f, artefactId: synthetic.command.artefactId };
        }
        test('evidence runtime reads quarantined metadata and writes its audit on the same restricted transaction', async () => {
            const f = await evidenceResourceSetup(), boundary = f.state.trace.length;
            const result = await f.facade.evidence.readEvidenceMetadata(f.context, { artefactId: f.artefactId });
            expect(result).toMatchObject({ schemaVersion: 1, evidence: { artefactId: f.artefactId, revision: 0, versions: [{ quarantine: { state: 'quarantined' } }] } });
            expect(JSON.stringify(result)).not.toMatch(/private-source|private-policy|actorSubjectKey|governanceRefs/);
            const trace = f.state.trace.slice(boundary);
            const evidenceReads = trace.filter(e => e.phase === 'before' && /FROM nofries\.dashboard_evidence_revisions/.test(e.sql));
            const audits = trace.filter(e => e.phase === 'before' && /INSERT INTO nofries\.dashboard_runtime_audit/.test(e.sql));
            expect(evidenceReads.length).toBeGreaterThan(0); expect(audits).toHaveLength(1);
            expect(new Set([...evidenceReads, ...audits].map(e => e.backendPid)).size).toBe(1);
            expect(trace.filter(e => e.phase === 'before' && e.sql === 'BEGIN')).toHaveLength(1);
            expect(trace.filter(e => e.phase === 'before' && e.sql === 'COMMIT')).toHaveLength(1);
            const durable = await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256);
            expect(durable.filter(row => row.payload.action === 'evidence.read')).toHaveLength(1);
            await loginClean();
        });
        test('evidence runtime rechecks revoked module authority on a retained request context', async () => {
            const f = await evidenceResourceSetup();
            expect(await f.facade.evidence.readEvidenceMetadata(f.context, { artefactId: f.artefactId })).toHaveProperty('evidence.artefactId', f.artefactId);
            await f.mutateFlags({ evidence: false });
            const before = await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256);
            const result = await settled(f.facade.evidence.readEvidenceMetadata(f.context, { artefactId: f.artefactId }));
            expect(result.error).toMatchObject({ code: 'evidence_access_denied', statusCode: 403 });
            expect(result.value).toBeUndefined();
            expect(await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256)).toEqual(before);
            await loginClean();
        });
        test('evidence runtime lost COMMIT response never discloses an unproved read outcome', async () => {
            const f = await evidenceResourceSetup(); let audited = false, lost = false;
            f.state.hook = event => {
                if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit/.test(event.sql)) audited = true;
                if (audited && !lost && event.phase === 'after' && event.sql === 'COMMIT') {
                    lost = true; throw new Error('Synthetic lost evidence COMMIT response');
                }
            };
            const outcome = await settled(f.facade.evidence.readEvidenceMetadata(f.context, { artefactId: f.artefactId }));
            expect(lost).toBe(true); expect(outcome.value).toBeUndefined();
            expect(outcome.error).toMatchObject({ code: 'evidence_unavailable', statusCode: 503 });
            const durable = await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256);
            expect(durable.filter(row => row.payload.action === 'evidence.read')).toHaveLength(1);
            await loginClean();
        });
        test('evidence runtime audit failure rolls back without metadata disclosure or evidence mutation', async () => {
            const f = await evidenceResourceSetup();
            const before = await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256);
            let failed = false;
            f.state.hook = event => {
                if (!failed && event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit/.test(event.sql)) {
                    failed = true; throw new Error('Synthetic audit delivery failure');
                }
            };
            const outcome = await settled(f.facade.evidence.readEvidenceMetadata(f.context, { artefactId: f.artefactId }));
            expect(failed).toBe(true); expect(outcome.error).toMatchObject({ code: 'evidence_unavailable', statusCode: 503 });
            expect(outcome.value).toBeUndefined();
            expect(await rows('dashboard_runtime_audit', 'session_sha256', f.seed.sessionSha256)).toEqual(before);
            f.state.hook = null;
            const fresh = await f.bindResource();
            expect(await fresh.facade.evidence.readEvidenceMetadata(fresh.context, { artefactId: f.artefactId }))
                .toMatchObject({ evidence: { revision: 0 } });
            await loginClean();
        });
        async function loginClean() {
            const client = await runtimePool.connect();
            try {
                expect((await client.query('SELECT current_user AS role,session_user AS login')).rows[0]).toEqual({ role: runtimeRole, login: runtimeRole });
                for (const setting of ['tenant_id', 'organisation_id', 'session_sha256', 'subject_key', 'identity_sha256', 'runtime_instance_id', 'request_id']) {
                    expect(['', null]).toContain((await client.query('SELECT current_setting($1,true) AS value', ['nofries.' + setting])).rows[0].value);
                }
            } finally { client.release(); }
        }
        function ncscCommitFault(f, command, phase, inject) {
            const active = new Map(); let sequence = 0;
            const observed = { markers: 0, faults: 0, unarmedCommits: 0, marker: null, fault: null, recovery: [] };
            f.state.hook = async event => {
                if (observed.faults && event.phase === 'before') observed.recovery.push(event.sql);
                if (event.phase === 'after' && /^BEGIN(?: READ ONLY)?$/.test(event.sql)) active.set(event.backendPid, { transaction: ++sequence, backendPid: event.backendPid, armed: false });
                const current = active.get(event.backendPid);
                if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts\b/.test(event.sql)
                    && JSON.stringify(event.params.slice(0, 4)) === JSON.stringify([f.scope.tenantId, f.scope.organisationId, command.assessmentId, command.idempotencyKey])) {
                    expect(current).toBeDefined(); current.armed = true; observed.markers++;
                    observed.marker = { transaction: current.transaction, backendPid: current.backendPid };
                }
                if (event.sql === 'COMMIT') {
                    if (!observed.faults && current && current.armed && event.phase === phase) {
                        observed.faults++; observed.fault = { transaction: current.transaction, backendPid: current.backendPid }; await inject();
                    } else if (!observed.faults && event.phase === 'after') observed.unarmedCommits++;
                }
                if (event.phase === 'after' && /^(COMMIT|ROLLBACK)$/.test(event.sql)) active.delete(event.backendPid);
            };
            return observed;
        }
        function gate(timeout = 5000) {
            let yes, no, timer, completed = false;
            const promise = new Promise((resolve, reject) => { yes = resolve; no = reject; });
            promise.catch(() => {});
            return { get promise() {
                // Setup is outside the bounded contention phase. Start each
                // timer only when its particular phase is actually awaited.
                if (timeout && !completed && !timer) timer = setTimeout(() => no(new Error('The bounded PostgreSQL phase barrier was not reached')), timeout);
                return promise;
            }, resolve() { completed = true; clearTimeout(timer); yes(); } };
        }
        async function actualBlockedBy(waiter, holder) {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const result = await ownerPool.query('SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [waiter]);
                if (result.rows[0]?.wait_event_type === 'Lock' && result.rows[0].blockers.includes(holder)) return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('The two actual PostgreSQL backends did not establish the expected lock conflict');
        }

        describe('G host resource and original runtime event', () => {
            const cutoff = atMillis(1000);
            const modules = ['overview', 'ai_governance', 'cyber_security', 'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services'];
            const newPairs = [...modules.map(key => ['readDashboardAdmission', 'module:' + key]),
                ['readDashboardBootstrap', 'bootstrap'], ['readDashboardAsset', 'asset:app.js'],
                ['readDashboardAsset', 'asset:dashboard.css'], ['readDashboardReadiness', 'readiness']];
            const auditColumns = ['event_id', 'session_sha256', 'instance_id', 'authority_id', 'request_id',
                'tenant_id', 'organisation_id', 'occurred_at', 'event_type', 'event_sha256', 'operation_id', 'payload', 'scope_json'];
            function host(f, route = 'bootstrap', overrides = {}, seed = f.seed) {
                const original = f.request(seed, undefined, { method: 'GET' }), runtime = createDashboardResourceRuntime({ ...f.resourceOptions, ...overrides });
                return { original, capture: f.registry.get(original), runtime,
                    invoke: () => runtime.handleHostResource(original, { route,
                        expectedGeneration: ['app.js', 'dashboard.css'].includes(route) ? null : f.selected.record.generationToken }) };
            }
            function wire(value, code, status) {
                expect(value).toMatchObject({ status, body: { code }, isRaw: false });
                expect(Object.keys(value).sort()).toEqual(['status', 'headers', 'body', 'isRaw'].sort());
                expect(Object.keys(value.body)).toEqual(['code']);
                expect(JSON.stringify(value)).not.toMatch(/driver-private|credential|secret/);
            }
            function observeHost(f, call) {
                const active = new Map(), observed = { trace: [], markers: 0, commits: 0, unarmedCommits: 0, marker: null,
                    onEvent: null, onCommit: null, serial: 0 };
                observed.isTarget = event => {
                    if (!/^INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) return false;
                    const cols = /dashboard_runtime_audit\s*\(([^)]+)\)/.exec(event.sql)[1].split(',').map(v => v.trim());
                    const payload = JSON.parse(event.params[cols.indexOf('payload')]);
                    return payload.requestId === call.capture.requestId && /^readDashboard/.test(payload.action);
                };
                f.state.hook = async event => {
                    if (event.phase === 'after' && /^BEGIN(?: READ ONLY)?$/.test(event.sql))
                        active.set(event.backendPid, { number: ++observed.serial, backendPid: event.backendPid, marked: false });
                    const tx = active.get(event.backendPid);
                    observed.trace.push({ ...event, transaction: tx?.number ?? null });
                    if (event.phase === 'after' && observed.isTarget(event)) {
                        expect(tx).toBeDefined(); tx.marked = true; observed.markers++;
                        observed.marker = { backendPid: event.backendPid, transaction: tx.number };
                    }
                    if (observed.onEvent) await observed.onEvent(event, tx);
                    if (event.phase === 'after' && event.sql === 'COMMIT') {
                        if (tx?.marked) { observed.commits++; if (observed.onCommit) await observed.onCommit(event, tx); }
                        else if (!observed.markers) observed.unarmedCommits++;
                    }
                    if (event.phase === 'after' && /^(COMMIT|ROLLBACK)$/.test(event.sql)) active.delete(event.backendPid);
                };
                observed.business = () => observed.trace.filter(row => row.phase === 'before' && row.backendPid === observed.marker?.backendPid
                    && row.transaction === observed.marker?.transaction);
                return observed;
            }
            async function onlyEvent(before, call, action, resourceKey, outcome = 'succeeded') {
                const after = await exportAll(), added = after.dashboard_runtime_audit.filter(row => !before.dashboard_runtime_audit.some(old => old.event_id === row.event_id));
                expect(added).toHaveLength(1); const row = added[0];
                const event = { schemaVersion: 1, eventType: 'dashboard.runtime', eventId: row.event_id,
                    requestId: call.capture.requestId, occurredAt: NOW, actorSubjectKey: subject(call.capture.identityPayload),
                    scope: { tenantId: row.tenant_id, organisationId: row.organisation_id }, action, resourceKey, outcome, operationId: null };
                expect(row.payload).toEqual(event); expect(row.session_sha256).toBe(call.capture.sessionSha256);
                expect(row.instance_id).toBe(call.capture.instanceId); expect(row.scope_json).toEqual(event.scope);
                expect(row.event_sha256).toBe(hash({ sessionSha256: row.session_sha256, instanceId: row.instance_id,
                    authorityId: row.authority_id, event }));
                for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES].filter(table => table !== 'dashboard_runtime_audit'))
                    expect(after[table]).toEqual(before[table]);
                expect(after.dashboard_runtime_audit.filter(item => item.event_id !== row.event_id)).toEqual(before.dashboard_runtime_audit);
                return row;
            }
            function noBusinessCommit(observed) {
                expect(observed.unarmedCommits).toBe(1); expect(observed.commits).toBe(0);
                expect(observed.trace.filter(row => row.phase === 'before' && row.sql === 'ROLLBACK')).toHaveLength(1);
            }
            function readOnlyRecovery(observed) {
                const first = observed.trace.findIndex(row => row.phase === 'after' && row.sql === 'COMMIT' && row.transaction === observed.marker.transaction);
                const later = observed.trace.slice(first + 1).filter(row => row.phase === 'before');
                expect(later.some(row => /^BEGIN/.test(row.sql))).toBe(true);
                expect(later.filter(row => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(row.sql))).toEqual([]);
            }
            async function shortSession(f) {
                const seed = { ...f.session('customer', f.customerIdentity), expiresAt: cutoff };
                f.selected = await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: f.publication.binding.bindingId });
                f.seed = seed;
            }
            function prepareTiming(kind) {
                return example => {
                    const product = example.state.entitlementState.grants.find(grant => grant.grantId === 'synthetic-product');
                    if (kind === 'product') product.validUntil = cutoff;
                    if (kind === 'advisor' || kind === 'neighbor') example.state.advisorAssignments.forEach(assignment => { assignment.validUntil = cutoff; });
                    if (kind === 'service') example.state.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').validUntil = cutoff;
                    if (kind === 'neighbor') {
                        for (const row of [...example.state.membershipState.memberships, ...example.state.membershipState.invitations]) row.roles = ['viewer', 'fractional_advisor'];
                        example.state.flags.enabled.cyber_security = false;
                    }
                };
            }
            async function flagsSnapshot(f, enabled) { return f.mutateFlags(enabled); }

            test('HN-P01 host bootstrap event and final decision share one max1 restricted transaction', async () => {
                const f = await resourceSetup(), call = host(f), before = await exportAll(), observed = observeHost(f, call);
                const entered = gate(), release = gate(0), initialBorrows = f.state.borrows; let disclosed = false;
                observed.onEvent = async event => { if (event.phase === 'before' && observed.isTarget(event)) { entered.resolve(); await release.promise; } };
                const result = settled(call.invoke()).then(value => { disclosed = true; return value; });
                try {
                    await Promise.race([entered.promise, result.then(value => { throw value.error || new Error('Host settled before audit marker'); })]);
                    expect(disclosed).toBe(false); expect(f.state.borrows - f.state.releases).toBe(1);
                } finally { release.resolve(); await result; f.state.hook = null; }
                expect((await result).value.status).toBe(200); expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                expect(observed.unarmedCommits).toBe(1);
                const business = observed.business(); expect(business.filter(row => /FROM nofries\.dashboard_entitlement_states/.test(row.sql)).length).toBeGreaterThanOrEqual(2);
                expect(business.filter(row => observed.isTarget(row))).toHaveLength(1);
                const row = await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap');
                expect(row.authority_id).toBe(f.admission.record.authorityId); expect(f.quota.policySelections).toEqual([]);
                expect(f.state.borrows - initialBorrows).toBe(2);
                expect(f.state.borrows).toBe(f.state.releases); await loginClean();
            });
            test('HN-P02 selected operator assets use null transport and current selection authority', async () => {
                const f = await resourceSetup({ purpose: 'operator_dashboard' });
                for (const route of ['app.js', 'dashboard.css']) {
                    const call = host(f, route), before = await exportAll(), response = await call.invoke();
                    expect(response.status).toBe(200); expect(response.isRaw).toBe(true);
                    const expectedBytes = route === 'app.js' ? ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
                        .map(file => fs.readFileSync(path.resolve(__dirname, '../../api/shared/protectedAssets', file), 'utf8')).join('\n')
                        : fs.readFileSync(path.resolve(__dirname, '../../app/dashboard.css'), 'utf8');
                    expect(response.body).toBe(expectedBytes);
                    await onlyEvent(before, call, 'readDashboardAsset', 'asset:' + route);
                }
                const next = await f.addResource({ tenantId: f.scope.tenantId, organisationId: 'host-next-org' }, {}, f.example.state.tenantAggregate.tenant);
                f.selected = await f.repository.selectBinding(f.request(f.seed), { operationId: nextId(), bindingId: next.publication.binding.bindingId,
                    expectedGeneration: f.selected.record.generationToken });
                const call = host(f, 'app.js'), before = await exportAll(); expect((await call.invoke()).status).toBe(200);
                const row = await onlyEvent(before, call, 'readDashboardAsset', 'asset:app.js'); expect(row.organisation_id).toBe('host-next-org');
                await loginClean();
            });
            test('HN-P03 discovery unselected and foreign contexts cannot acquire a host resource', async () => {
                const f = await resourceSetup(), discovery = await f.bind(await f.createCase(template({ tenantId: 'host-discovery-' + nextId(), organisationId: 'case-org' }, nextId())));
                const unselected = f.session('operator_dashboard', f.operatorIdentity); await f.repository.initializeOperatorSession(f.request(unselected), { operationId: nextId() });
                const foreign = { ...clone(f.seed), identityPayload: { ...f.seed.identityPayload, oid: nextId() } };
                for (const seed of [discovery.discoverySeed, unselected, foreign]) {
                    const before = await exportAll(); wire(await host(f, 'bootstrap', {}, seed).invoke(), 'dashboard_access_denied', 403);
                    expect(await exportAll()).toEqual(before); expect(f.state.borrows).toBe(f.state.releases);
                }
                expect(f.quota.policySelections).toEqual([]);
            });
            test('HN-P04 stable known module denial commits one denied event before403', async () => {
                const f = await resourceSetup(), call = host(f, 'modules/ai_governance'), before = await exportAll(), observed = observeHost(f, call);
                wire(await call.invoke(), 'dashboard_access_denied', 403); f.state.hook = null;
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                await onlyEvent(before, call, 'readDashboardAdmission', 'module:ai_governance', 'denied'); await loginClean();
            });
            test('HN-P05 required audit failure outranks stable module denial with known rollback', async () => {
                const f = await resourceSetup(), call = host(f, 'modules/ai_governance'), before = await exportAll(), observed = observeHost(f, call);
                let faults = 0; observed.onEvent = event => { if (event.phase === 'before' && observed.isTarget(event)) { faults++; throw new Error('driver-private audit credential'); } };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null;
                expect(faults).toBe(1); noBusinessCommit(observed); expect(await exportAll()).toEqual(before); await loginClean();
            });
            test('HN-P06 fresh epoch refusal after settled event work rolls back403', async () => {
                const f = await resourceSetup(), call = host(f), before = await exportAll(), observed = observeHost(f, call);
                observed.onEvent = event => { if (event.phase === 'after' && observed.isTarget(event)) f.state.restoreEpoch = nextId(); };
                wire(await call.invoke(), 'dashboard_access_denied', 403); f.state.hook = null;
                expect(observed.markers).toBe(1); noBusinessCommit(observed); expect(await exportAll()).toEqual(before); await loginClean();
            });
            async function competingSelection(hostFirst) {
                const { Pool } = require('pg'), url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000 }), close = trackPoolClientEnds(pool);
                let f, one, two, held, waiter, release;
                try {
                    f = await resourceSetup({ rawRuntimePool: pool });
                    const next = await f.addResource({ tenantId: f.scope.tenantId, organisationId: 'host-lock-next' }, {}, f.example.state.tenantAggregate.tenant);
                    const call = host(f), command = { operationId: nextId(), bindingId: next.publication.binding.bindingId, expectedGeneration: f.selected.record.generationToken };
                    const before = await exportAll(), observed = observeHost(f, call); held = gate(); waiter = gate(); release = gate(0);
                    let holderPid, waiterPid, holding = false;
                    observed.onEvent = async event => {
                        const holdHere = hostFirst ? event.phase === 'after' && observed.isTarget(event)
                            : event.phase === 'after' && event.sql === 'SELECT pg_advisory_xact_lock($1::integer, hashtext($2))'
                                && event.params[0] === 71001 && event.params[1] === f.seed.sessionSha256;
                        if (!holding && holdHere) { holding = true; holderPid = event.backendPid; held.resolve(); await release.promise; }
                        else if (holding && event.phase === 'before' && event.backendPid !== holderPid
                            && /^SELECT pg_advisory_xact_lock(?:_shared)?\(\$1::integer, hashtext\(\$2\)\)$/.test(event.sql)
                            && event.params[0] === 71001 && event.params[1] === f.seed.sessionSha256) { waiterPid = event.backendPid; waiter.resolve(); }
                    };
                    const change = () => f.repository.selectBinding(f.request(f.seed), command);
                    one = settled(hostFirst ? call.invoke() : change());
                    await Promise.race([held.promise, one.then(out => { throw out.error || new Error('First participant missed its lock'); })]);
                    two = settled(hostFirst ? change() : call.invoke());
                    await Promise.race([waiter.promise, two.then(out => { throw out.error || new Error('Second participant did not wait'); })]);
                    expect(waiterPid).not.toBe(holderPid); await actualBlockedBy(waiterPid, holderPid); release.resolve();
                    const [first, second] = await Promise.all([one, two]), response = hostFirst ? first.value : second.value;
                    expect((hostFirst ? second : first).error).toBeUndefined();
                    if (hostFirst) expect(response.status).toBe(200); else wire(response, 'dashboard_access_denied', 403);
                    const traceBeforeLaterRequest = clone(observed.trace); f.state.hook = null;
                    const after = await exportAll(), hostEvents = after.dashboard_runtime_audit.filter(row => row.request_id === call.capture.requestId);
                    expect(hostEvents).toHaveLength(hostFirst ? 1 : 0);
                    expect(after.dashboard_runtime_receipts.filter(row => row.operation_id === command.operationId)).toHaveLength(1);
                    for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES]
                        .filter(table => !['dashboard_session_gates', 'dashboard_runtime_receipts', 'dashboard_runtime_audit'].includes(table)))
                        expect(after[table]).toEqual(before[table]);
                    const addedReceipts = after.dashboard_runtime_receipts.filter(row => !before.dashboard_runtime_receipts.some(old => old.receipt_id === row.receipt_id));
                    expect(addedReceipts).toHaveLength(1); expect(addedReceipts[0].operation_id).toBe(command.operationId);
                    expect(after.dashboard_runtime_receipts.filter(row => row.operation_id !== command.operationId)).toEqual(before.dashboard_runtime_receipts);
                    const mutationEventId = addedReceipts[0].audit_event_id;
                    expect(after.dashboard_runtime_audit.filter(row => row.event_id !== mutationEventId && row.request_id !== call.capture.requestId)).toEqual(before.dashboard_runtime_audit);
                    expect(after.dashboard_runtime_audit.filter(row => row.event_id === mutationEventId)).toHaveLength(1);
                    const oldGate = before.dashboard_session_gates.find(row => row.session_sha256 === f.seed.sessionSha256);
                    const newGate = after.dashboard_session_gates.find(row => row.session_sha256 === f.seed.sessionSha256);
                    expect(after.dashboard_session_gates.filter(row => row.session_sha256 !== f.seed.sessionSha256))
                        .toEqual(before.dashboard_session_gates.filter(row => row.session_sha256 !== f.seed.sessionSha256));
                    const selectionKeys = ['selected_binding_id', 'selected_tenant_id', 'selected_organisation_id', 'selection_generation', 'generation_token', 'revision', 'updated_at'];
                    for (const key of Object.keys(oldGate).filter(key => !selectionKeys.includes(key))) expect(newGate[key]).toEqual(oldGate[key]);
                    expect(newGate.selected_binding_id).toBe(command.bindingId); expect(newGate.generation_token).not.toBe(command.expectedGeneration);
                    expect(newGate.selection_generation).toBe(oldGate.selection_generation + 1); expect(newGate.revision).toBe(oldGate.revision + 1);
                    const resourcePid = hostFirst ? holderPid : waiterPid;
                    const participants = traceBeforeLaterRequest.filter(row => row.backendPid === resourcePid && row.phase === 'before');
                    expect(participants.some(row => /^(?:COMMIT|ROLLBACK)$/.test(row.sql))).toBe(true);
                    if (hostFirst) expect(observed.business().some(row => /FROM nofries\.dashboard_tenants[\s\S]*FOR SHARE/.test(row.sql))).toBe(true);
                    const later = await host(f).invoke(); wire(later, 'dashboard_access_denied', 403);
                    expect(await exportAll()).toEqual(after);
                } finally {
                    if (release) release.resolve();
                    try { if (one) await one; if (two) await two; } finally { if (f) f.state.hook = null; await close(); }
                }
            }
            test('HN-P07 host-first protected read serializes real selection change', () => competingSelection(true));
            test('HN-P08 selection-first change denies the real waiting host', () => competingSelection(false));
            test('HN-P09 proved lost COMMIT returns a fresh changed eligible projection', async () => {
                const f = await resourceSetup(); let recovery = false, changed = false, mutationInterval, afterFixtureMutation;
                const call = host(f);
                f.state.beforeBorrow = async () => {
                    if (recovery && !changed) {
                        // tracedPool reserves the pending borrow counter before
                        // this hook; the actual Pool.connect has not happened.
                        expect(f.state.borrows).toBe(f.state.releases + 1); changed = true;
                        const start = f.state.trace.length;
                        await flagsSnapshot(f, { cyber_security: false });
                        mutationInterval = [start, f.state.trace.length]; afterFixtureMutation = await exportAll();
                    }
                };
                let firstProjection; mockAfterHostDecision = value => { if (!firstProjection && value.outcome === 'succeeded') firstProjection = clone(value.projection); };
                const observed = observeHost(f, call); observed.onCommit = () => { recovery = true; throw new Error('driver-private lost COMMIT response'); };
                let response;
                try { response = await call.invoke(); } finally { f.state.hook = null; f.state.beforeBorrow = null; mockAfterHostDecision = null; }
                expect(response.status).toBe(200); expect(changed).toBe(true); expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                expect(response.body.modules).not.toEqual(firstProjection.modules);
                const snapshot = await f.canonicalRepository.readAdmissionSnapshot(f.scope, { authenticated: true, subjectKey: NCSC_SUBJECT });
                const expected = await require('../../api/shared/dashboardService').createDashboardBufferedService({ authenticate: async () => ({ authenticated: true, subjectKey: NCSC_SUBJECT }),
                    resolveScope: async () => f.scope, loadSnapshot: async () => snapshot, clock: () => f.state.now }).handleResource({ method: 'GET' }, 'bootstrap');
                expect(response).toEqual(expected.response);
                const stored = await exportAll(), event = stored.dashboard_runtime_audit.filter(row => row.request_id === call.capture.requestId);
                expect(event).toHaveLength(1); expect(event[0].payload.outcome).toBe('succeeded');
                expect(stored).toEqual(afterFixtureMutation);
                const recoveryDml = f.state.trace.filter((row, index) => index >= mutationInterval[1]
                    && /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(row.sql)); expect(recoveryDml).toEqual([]);
                expect(f.quota.policySelections).toEqual([]); await loginClean();
            });
            test('HN-P10 readiness audit is unscoped for operator and customer only', async () => {
                const f = await resourceSetup();
                for (const seed of [f.operatorSeed, f.seed]) {
                    const event = { eventId: nextId(), action: 'readDashboardReadiness', outcome: 'succeeded', resourceKey: 'readiness', operationId: null };
                    const request = f.request(seed), before = await exportAll();
                    expect(await f.repository.recordRuntimeEvent(request, event)).toEqual({ schemaVersion: 1, eventId: event.eventId, recorded: true });
                    const after = await exportAll(), row = after.dashboard_runtime_audit.find(row => row.event_id === event.eventId);
                    expect(row).toMatchObject({ authority_id: null, tenant_id: null, organisation_id: null, scope_json: null, session_sha256: seed.sessionSha256 });
                    expect(row.payload).toMatchObject({ scope: null, actorSubjectKey: subject(seed.identityPayload), requestId: f.registry.get(request).requestId });
                    for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES].filter(table => table !== 'dashboard_runtime_audit')) expect(after[table]).toEqual(before[table]);
                }
                const discovery = await f.bind(await f.createCase(template({ tenantId: 'host-readiness-' + nextId(), organisationId: 'case' }, nextId())));
                await unchangedFailure(() => f.repository.recordRuntimeEvent(discovery.discoveryRequest,
                    { eventId: nextId(), action: 'readDashboardReadiness', outcome: 'succeeded', resourceKey: 'readiness', operationId: null }));
            });
            test('HN-P11 foreign session cannot adopt a standalone host event ID', async () => {
                const f = await resourceSetup(), command = { eventId: nextId(), action: 'readDashboardReadiness', outcome: 'succeeded', resourceKey: 'readiness', operationId: null };
                await f.repository.recordRuntimeEvent(f.request(f.seed), command);
                const other = f.session('customer', f.customerIdentity); await f.repository.activateCustomerSession(f.request(other), { operationId: nextId(), bindingId: f.publication.binding.bindingId });
                await unchangedFailure(() => f.repository.recordRuntimeEvent(f.request(other), command), 'onboarding_unavailable', 503);
            });
            function auditRow(f, action, resourceKey, { outcome = 'succeeded', maintenance = false, mutation = false } = {}) {
                const eventId = nextId(), operationId = mutation ? nextId() : null, requestId = maintenance ? operationId : nextId();
                const scope = maintenance && resourceKey === 'instance' ? null : clone(f.scope);
                const event = { schemaVersion: 1, eventType: 'dashboard.runtime', eventId, requestId, occurredAt: NOW,
                    actorSubjectKey: NCSC_SUBJECT, scope, action, outcome, resourceKey, operationId };
                const envelope = { sessionSha256: maintenance ? null : f.seed.sessionSha256, instanceId: f.instanceId,
                    authorityId: scope ? f.admission.record.authorityId : null, event };
                return { event_id: eventId, session_sha256: envelope.sessionSha256, instance_id: f.instanceId,
                    authority_id: envelope.authorityId, request_id: requestId, tenant_id: scope?.tenantId ?? null,
                    organisation_id: scope?.organisationId ?? null, occurred_at: NOW, event_type: event.eventType,
                    event_sha256: hash(envelope), operation_id: operationId, payload: event, scope_json: scope };
            }
            function insertAudit(client, row) {
                return client.query(`INSERT INTO nofries.dashboard_runtime_audit (${auditColumns.join(',')})
                    SELECT ${auditColumns.map(column => column === 'scope_json' ? "COALESCE(v.scope_json,'null'::jsonb)" : 'v.' + column).join(',')}
                    FROM jsonb_populate_record(NULL::nofries.dashboard_runtime_audit,$1::jsonb) v`, [JSON.stringify(row)]);
            }
            test('HN-P12 forward0006 validates all retained pairs and exact new reads', async () => {
                const f = await resourceSetup(), snapshot = await exportAll(), isolated = `nf_host_migration_${runKey}_${++sequence}`;
                const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-host-prior-'));
                const all = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-host-through-0006-'));
                const cleanup = [() => fs.rmSync(directory, { recursive: true, force: true }),
                    () => fs.rmSync(all, { recursive: true, force: true })];
                try {
                    copyRuntimeMigrationBaseline(all);
                    for (const file of fs.readdirSync(all).filter(file => /^000[1-5]_.*\.sql$/.test(file))) fs.copyFileSync(path.join(all, file), path.join(directory, file));
                    await controlPool.query(`CREATE DATABASE ${quoteIdentifier(isolated)}`); cleanup.push(() => controlPool.query(`DROP DATABASE ${quoteIdentifier(isolated)}`));
                    const { Pool } = require('pg'), url = new URL(testUrl); url.pathname = '/' + isolated;
                    const pool = new Pool({ connectionString: url.toString(), max: 1 }); cleanup.push(trackPoolClientEnds(pool));
                    await controlPool.query(`REVOKE nofries_dashboard_maintenance FROM ${quoteIdentifier(maintenanceRole)}`);
                    cleanup.push(() => controlPool.query(`GRANT nofries_dashboard_maintenance TO ${quoteIdentifier(maintenanceRole)} WITH INHERIT FALSE,SET TRUE,ADMIN FALSE`));
                    const client = await pool.connect();
                    try {
                        expect((await applyMigrations({ client, migrationsDir: directory })).applied).toHaveLength(5);
                        await client.query('BEGIN');
                        for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES]) {
                            for (const row of snapshot[table]) {
                                const columns = Object.keys(row), projection = columns.map(column => column === 'scope_json'
                                    ? "COALESCE(v.scope_json,'null'::jsonb)" : 'v.' + quoteIdentifier(column)).join(',');
                                await client.query(`INSERT INTO nofries.${table} (${columns.map(quoteIdentifier).join(',')})
                                    SELECT ${projection} FROM jsonb_populate_record(NULL::nofries.${table},$1::jsonb) v`, [JSON.stringify(row)]);
                            }
                        }
                        const mutations = [['initializeOperatorSession', 'session'], ['activateCustomerSession', 'session'], ['recordProofAndActivateDiscovery', 'session'],
                            ['selectBinding', 'session'], ['revokeSession', 'session'], ['createCase', 'case'], ['approveCase', 'case'], ['revokeCase', 'case'],
                            ['denyCase', 'case'], ['expireCase', 'case'], ['acceptStagedOnboarding', 'case'], ['publishExistingMembershipBinding', 'binding'],
                            ['publishAdmissionDecision', 'admission'], ['withdrawAdmissionDecision', 'admission'], ['initializeRuntimeInstance', 'instance'],
                            ['fenceRestoreEpoch', 'instance'], ['enableRuntimeIngress', 'instance']];
                        for (const [action, resourceKey] of mutations) await insertAudit(client, auditRow(f, action, resourceKey,
                            { mutation: true, maintenance: ['admission', 'instance'].includes(resourceKey) }));
                        for (const [action, resourceKey] of [['readSession', 'session'], ['discoverBindings', 'binding'], ['readOnboardingStatus', 'case']])
                            await insertAudit(client, auditRow(f, action, resourceKey));
                        const operation = auditRow(f, 'readSession', 'session'); operation.event_type = 'dashboard.operation';
                        operation.payload = { schemaVersion: 1, eventType: 'dashboard.operation', eventId: operation.event_id,
                            requestId: operation.request_id, actorSubjectKey: NCSC_SUBJECT, ...f.scope, action: 'assessment.read',
                            module: 'cyber_security', result: 'succeeded', occurredAt: NOW };
                        operation.event_sha256 = hash({ sessionSha256: operation.session_sha256, instanceId: operation.instance_id,
                            authorityId: operation.authority_id, event: operation.payload }); await insertAudit(client, operation); await client.query('COMMIT');
                        const audits = async () => (await client.query('SELECT to_jsonb(a) AS value FROM nofries.dashboard_runtime_audit a ORDER BY event_id')).rows;
                        const constraints = async () => (await client.query(`SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
                            JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='nofries' AND c.conname<>'dashboard_audit_payload' ORDER BY c.conname,c.conrelid`)).rows;
                        const policies = async () => (await client.query("SELECT * FROM pg_policies WHERE schemaname='nofries' ORDER BY tablename,policyname")).rows;
                        const privileges = async () => (await client.query("SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='nofries' ORDER BY table_name,grantee,privilege_type")).rows;
                        const before = await audits(), beforeConstraints = await constraints(), beforePolicies = await policies(), beforePrivileges = await privileges();
                        expect((await applyMigrations({ client, migrationsDir: all })).applied).toEqual(['0006_dashboard_host_events.sql']);
                        expect(await audits()).toEqual(before); expect(await constraints()).toEqual(beforeConstraints);
                        expect(await policies()).toEqual(beforePolicies); expect(await privileges()).toEqual(beforePrivileges);
                        const replay = await applyMigrations({ client, migrationsDir: all }); expect(replay.applied).toEqual([]); expect(replay.skipped).toHaveLength(6);
                        await client.query('BEGIN');
                        for (const [action, resourceKey] of newPairs) await insertAudit(client, auditRow(f, action, resourceKey));
                        for (const outcome of ['denied', 'failed']) await insertAudit(client, auditRow(f, 'readDashboardBootstrap', 'bootstrap', { outcome }));
                        await client.query('COMMIT'); expect(await audits()).toHaveLength(before.length + 14);
                    } finally { client.release(); }
                } finally {
                    const errors = []; for (const action of cleanup.reverse()) { try { await action(); } catch (error) { errors.push(error); } }
                    if (errors.length) throw new AggregateError(errors, 'Owned host migration cleanup failed');
                }
            });
            test('HN-P13 new CHECK pairs and existing actor RLS reject malformed combinations', async () => {
                const f = await resourceSetup(), before = await exportAll(), base = auditRow(f, 'readDashboardBootstrap', 'bootstrap');
                const mutations = [row => { row.payload.resourceKey = 'session'; }, row => { row.payload.extra = true; },
                    row => { row.operation_id = nextId(); row.payload.operationId = row.operation_id; }, row => { row.session_sha256 = null; },
                    row => { row.payload.requestId = nextId(); }, row => { row.payload.occurredAt = atMillis(1); },
                    row => { row.payload.scope.organisationId = 'foreign'; }];
                const client = await ownerPool.connect();
                try {
                    await client.query('BEGIN');
                    for (const mutate of mutations) {
                        await client.query('SAVEPOINT valid_control'); await insertAudit(client, base); await client.query('ROLLBACK TO SAVEPOINT valid_control');
                        const row = clone(base); mutate(row); const result = await settled(insertAudit(client, row));
                        expect(result.error).toMatchObject({ code: '23514' }); expect(result.error.constraint).toBeTruthy();
                        await client.query('ROLLBACK TO SAVEPOINT valid_control');
                    }
                    await client.query('ROLLBACK');
                } finally { client.release(); }
                const actorNull = clone(base); actorNull.payload.actorSubjectKey = null;
                const scope = { tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId,
                    authority_id: f.admission.record.authorityId, request_id: base.request_id };
                await scopedSql(f, f.seed, scope, tx => insertAudit(tx, base));
                const refusal = await settled(scopedSql(f, f.seed, scope, tx => insertAudit(tx, actorNull)));
                expect(refusal.error).toMatchObject({ code: '42501' }); expect(await exportAll()).toEqual(before);
            });
            test('HN-P14 malformed retained host event is503 before replay intent handling', async () => {
                const f = await resourceSetup(), command = { eventId: nextId(), action: 'readDashboardReadiness', outcome: 'succeeded', resourceKey: 'readiness', operationId: null };
                const original = await f.repository.recordRuntimeEvent(f.request(f.seed), command), before = await exportAll();
                expect(await f.repository.recordRuntimeEvent(f.request(f.seed), command)).toEqual(original);
                for (const variant of ['hash', 'projection']) {
                    let changed = 0; f.state.hook = event => {
                        if (event.phase === 'after' && /FROM nofries\.dashboard_runtime_audit\b/.test(event.sql) && event.params.includes(command.eventId)) {
                            expect(event.result.rows).toHaveLength(1); changed++;
                            if (variant === 'hash') event.result.rows[0].event_sha256 = 'f'.repeat(64);
                            else event.result.rows[0].request_id = nextId();
                        }
                    };
                    await rejectsCode(() => f.repository.recordRuntimeEvent(f.request(f.seed), command), 'onboarding_record_invalid', 503);
                    f.state.hook = null; expect(changed).toBe(1); expect(await exportAll()).toEqual(before);
                }
            });
            test('HN-P15 actual JSONB measurement faults cannot permit an audit insertion', async () => {
                for (const variant of ['oversize', 'null', 'extra', 'driver']) {
                    let armed = false, faults = 0, measured;
                    const observedPool = { end: () => runtimePool.end(), async connect() {
                        const client = await runtimePool.connect();
                        return { processID: client.processID, release: value => client.release(value), async query(sql, parameters) {
                            const result = await client.query(sql, parameters);
                            if (armed && /SELECT octet_length\(\$1::jsonb::text\) AS payload_bytes/.test(sql)
                                && parameters?.some(value => typeof value === 'string' && value.includes('readDashboardBootstrap'))) {
                                faults++;
                                if (variant === 'driver') return client.query('SELECT 1/0');
                                if (variant === 'oversize') { const value = await client.query('SELECT octet_length($1::jsonb::text) AS payload_bytes', [JSON.stringify({ synthetic: 'x'.repeat(17000) })]); measured = value.rows[0].payload_bytes; return value; }
                                if (variant === 'null') return { ...result, rows: [{ payload_bytes: null }] };
                                return { ...result, rows: [{ payload_bytes: result.rows[0].payload_bytes, extra: true }] };
                            }
                            return result;
                        } };
                    } };
                    const f = await resourceSetup({ rawRuntimePool: observedPool }), before = await exportAll(), call = host(f); armed = true;
                    wire(await call.invoke(), 'dashboard_unavailable', 503); armed = false;
                    expect(faults).toBe(1); if (variant === 'oversize') expect(measured).toBeGreaterThan(16384);
                    expect(await exportAll()).toEqual(before); expect(f.state.borrows).toBe(f.state.releases); await loginClean();
                }
            });
            test('HP01 advisor cutoff after actual COMMIT timeout preparation withholds dispatch', async () => {
                const f = await resourceSetup({ role: 'fractional_advisor', service: true, prepareExample: prepareTiming('advisor') });
                const call = host(f, 'modules/cyber_security'), before = await exportAll(), observed = observeHost(f, call); let final = false, decisions = 0, prepared = 0;
                mockAfterHostDecision = value => { expect(value.outcome).toBe('succeeded'); if (++decisions === 2) final = true; };
                observed.onEvent = event => { if (final && event.phase === 'after' && isRuntimeTimeout(event.sql)) { prepared++; f.state.now = cutoff; } };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null; mockAfterHostDecision = null;
                expect(prepared).toBe(1); expect(decisions).toBe(2); noBusinessCommit(observed); expect(await exportAll()).toEqual(before); await loginClean();
            });
            test('HP02 fractional service cutoff at genuine helper after-work rolls back without COMMIT', async () => {
                const f = await resourceSetup({ role: 'fractional_advisor', service: true, prepareExample: prepareTiming('service') });
                const call = host(f, 'modules/cyber_security'), before = await exportAll(), observed = observeHost(f, call); let completed = 0;
                mockResourceAfterWork = () => { completed++; f.state.now = cutoff; };
                wire(await call.invoke(), 'dashboard_unavailable', 503); mockResourceAfterWork = null; f.state.hook = null;
                expect(completed).toBe(1); noBusinessCommit(observed); expect(await exportAll()).toEqual(before); await loginClean();
            });
            test('HP03 product cutoff after acknowledged COMMIT retains event and withholds body', async () => {
                const f = await resourceSetup({ prepareExample: prepareTiming('product') }), call = host(f), before = await exportAll(), observed = observeHost(f, call);
                observed.onCommit = () => { f.state.now = cutoff; };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null;
                expect(observed.commits).toBe(1); expect(observed.trace.filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap'); await loginClean();
            });
            test('HP04 current base expires only after actual helper client release', async () => {
                const f = await resourceSetup(); await shortSession(f); let committed = false, releasedSample = false;
                const call = host(f, 'bootstrap', { clock: () => {
                    if (committed && f.state.borrows === f.state.releases) { releasedSample = true; return cutoff; }
                    return NOW;
                } }), before = await exportAll(), observed = observeHost(f, call);
                observed.onCommit = () => { committed = true; };
                wire(await call.invoke(), 'dashboard_access_denied', 403); f.state.hook = null;
                expect(releasedSample).toBe(true); expect(observed.commits).toBe(1); expect(observed.trace.filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap'); await loginClean();
            });
            test('HP05 disabled advisor neighbor drift refuses a still-allowed bootstrap', async () => {
                const f = await resourceSetup({ role: 'fractional_advisor', service: true, prepareExample: prepareTiming('neighbor') });
                const call = host(f), before = await exportAll(), observed = observeHost(f, call); let decisions = 0;
                mockAfterHostDecision = value => {
                    expect(value.outcome).toBe('succeeded'); expect(value.projection.modules).toContainEqual({ key: 'cyber_security', state: 'disabled' });
                    if (++decisions === 2) f.state.now = cutoff;
                };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null; mockAfterHostDecision = null;
                expect(decisions).toBe(2); noBusinessCommit(observed); expect(await exportAll()).toEqual(before); await loginClean();
            });
            async function knownCommitThenDeadline(base) {
                const f = await resourceSetup(base ? {} : { prepareExample: prepareTiming('product') }); if (base) await shortSession(f);
                let committed = false; const samples = [];
                const call = host(f, 'bootstrap', { clock: () => {
                    if (!committed) return NOW; const at = samples.length ? atMillis(2000) : cutoff; samples.push(at); return at;
                } }, { ...f.seed, deadline: atMillis(2000) });
                const before = await exportAll(), observed = observeHost(f, call); observed.onCommit = () => { committed = true; };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null;
                expect(samples).toEqual([cutoff, atMillis(2000)]); expect(observed.commits).toBe(1);
                expect(observed.trace.filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap');
                const ids = f.state.ids, traceLength = f.state.trace.length;
                wire(await call.invoke(), 'dashboard_unavailable', 503); expect(f.state.ids).toBe(ids); expect(f.state.trace).toHaveLength(traceLength);
            }
            test('HP06 known COMMIT product failure then deadline never renews its event slot', () => knownCommitThenDeadline(false));
            test('HP07 known COMMIT base denial then deadline keeps persistent503 priority', () => knownCommitThenDeadline(true));
            test('HP08 proved success can become denied only at a fresh late recovery sample', async () => {
                const f = await resourceSetup({ prepareExample: prepareTiming('product') }), call = host(f), before = await exportAll(), observed = observeHost(f, call);
                let recovery = false, recoveryDecisions = 0;
                observed.onCommit = () => { recovery = true; throw new Error('driver-private lost host COMMIT'); };
                mockAfterHostDecision = value => { if (recovery && ++recoveryDecisions === 1) { expect(value.outcome).toBe('succeeded'); f.state.now = cutoff; } };
                wire(await call.invoke(), 'dashboard_access_denied', 403); f.state.hook = null; mockAfterHostDecision = null;
                expect(recoveryDecisions).toBe(1); expect(observed.markers).toBe(1); readOnlyRecovery(observed);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap'); await loginClean();
            });
            test('HP09 proved denied event cannot disclose a newly allowed product', async () => {
                const f = await resourceSetup({ prepareExample: example => { example.state.entitlementState.grants.find(grant => grant.grantId === 'synthetic-product').validFrom = cutoff; } });
                const call = host(f), before = await exportAll(), observed = observeHost(f, call);
                observed.onCommit = () => { f.state.now = cutoff; throw new Error('driver-private lost denied COMMIT'); };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null;
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(1); readOnlyRecovery(observed);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap', 'denied'); await loginClean();
            });
            test('HP10 actual uncertain COMMIT with absent original event remains ambiguous', async () => {
                const f = await resourceSetup(), call = host(f), before = await exportAll(), observed = observeHost(f, call); let removed = 0;
                observed.onCommit = async () => {
                    removed = (await ownerPool.query('DELETE FROM nofries.dashboard_runtime_audit WHERE request_id=$1', [call.capture.requestId])).rowCount;
                    throw new Error('driver-private lost COMMIT response');
                };
                wire(await call.invoke(), 'dashboard_outcome_ambiguous', 503); f.state.hook = null;
                expect(removed).toBe(1); expect(observed.markers).toBe(1); readOnlyRecovery(observed); expect(await exportAll()).toEqual(before);
            });
            test.each(['retained', 'absent', 'inconsistent'])
            ('HP14 uncertain COMMIT and revoked binding keep an unproved %s event ambiguous', async eventState => {
                const f = await resourceSetup(), call = host(f), observed = observeHost(f, call);
                let afterCommit, revoked = 0, changed = 0;
                observed.onCommit = async () => {
                    // The owner fixture installs the valid terminal binding
                    // after the real host COMMIT; recovery uses the restricted LOGIN.
                    revoked = (await ownerPool.query("UPDATE nofries.dashboard_identity_bindings SET revision=1,status='revoked',updated_at=$1 WHERE binding_id=$2",
                        [f.state.now, f.publication.binding.bindingId])).rowCount;
                    if (eventState === 'absent') changed = (await ownerPool.query(
                        'DELETE FROM nofries.dashboard_runtime_audit WHERE request_id=$1', [call.capture.requestId])).rowCount;
                    if (eventState === 'inconsistent') changed = (await ownerPool.query(
                        'UPDATE nofries.dashboard_runtime_audit SET event_sha256=$1 WHERE request_id=$2',
                        ['f'.repeat(64), call.capture.requestId])).rowCount;
                    afterCommit = await exportAll();
                    throw new Error('driver-private lost revoked host COMMIT');
                };
                wire(await call.invoke(), 'dashboard_outcome_ambiguous', 503); f.state.hook = null;
                expect(revoked).toBe(1); expect(changed).toBe(eventState === 'retained' ? 0 : 1);
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(1); readOnlyRecovery(observed);
                const settledCommit = observed.trace.findIndex(row => row.phase === 'after' && row.sql === 'COMMIT'
                    && row.transaction === observed.marker.transaction);
                const recovery = observed.trace.slice(settledCommit + 1).filter(row => row.phase === 'before');
                expect(recovery.some(row => /FROM nofries\.dashboard_identity_bindings/.test(row.sql))).toBe(true);
                expect(recovery.filter(row => /FROM nofries\.dashboard_runtime_audit/.test(row.sql))).toEqual([]);
                expect(await exportAll()).toEqual(afterCommit);
                expect(f.state.borrows).toBe(f.state.releases); await loginClean();
            });
            test('HP11 exhausted uncertain COMMIT cannot fund a new recovery BEGIN', async () => {
                const f = await resourceSetup(), call = host(f, 'bootstrap', {}, { ...f.seed, deadline: atMillis(1000) }), before = await exportAll(), observed = observeHost(f, call);
                observed.onCommit = () => { f.state.now = cutoff; throw new Error('driver-private lost late COMMIT'); };
                wire(await call.invoke(), 'dashboard_outcome_ambiguous', 503); f.state.hook = null;
                expect(observed.commits).toBe(1);
                expect(observed.trace.filter(row => row.phase === 'before' && /^BEGIN/.test(row.sql))).toHaveLength(2);
                await onlyEvent(before, call, 'readDashboardBootstrap', 'bootstrap');
            });
            test('HP12 genuine rollback response failure preserves control uncertainty and discard', async () => {
                const discards = [], observedPool = { end: () => runtimePool.end(), async connect() {
                    const client = await runtimePool.connect(); return { processID: client.processID,
                        query: (...args) => client.query(...args), release: discard => { discards.push(discard); client.release(discard); } };
                } };
                const f = await resourceSetup({ rawRuntimePool: observedPool }), call = host(f), before = await exportAll(), observed = observeHost(f, call);
                let rollbackFailures = 0;
                observed.onEvent = event => {
                    if (event.phase === 'after' && observed.isTarget(event)) f.state.restoreEpoch = nextId();
                    if (event.phase === 'after' && event.sql === 'ROLLBACK' && rollbackFailures === 0) {
                        rollbackFailures++; f.state.restoreEpoch = f.seed.restoreEpoch; throw new Error('driver-private actual ROLLBACK response failure');
                    }
                };
                wire(await call.invoke(), 'dashboard_outcome_ambiguous', 503); f.state.hook = null;
                expect(rollbackFailures).toBe(1); expect(discards.some(Boolean)).toBe(true); expect(await exportAll()).toEqual(before);
                expect(f.state.borrows).toBe(f.state.releases);
            });
            test('HP13 proved recovery seals a fresh buffer before a same-success service drift', async () => {
                const f = await resourceSetup({ prepareExample: example => {
                    const product = example.state.entitlementState.grants[0];
                    example.state.entitlementState.grants.push({ ...clone(product), grantId: 'host-display-service', code: 'managed_endpoint',
                        validFrom: START, validUntil: cutoff, modules: ['services'], frameworks: [], limits: {}, coverage: ['device'], actions: ['view'] });
                    example.state.flags.enabled['service:managed_endpoint'] = true;
                } });
                const call = host(f, 'modules/services'), before = await exportAll(), observed = observeHost(f, call); let recovery = false, decisions = 0;
                observed.onCommit = () => { recovery = true; throw new Error('driver-private original COMMIT response failure'); };
                mockAfterHostDecision = value => { if (recovery && ++decisions === 1) { expect(value.outcome).toBe('succeeded'); f.state.now = cutoff; } };
                wire(await call.invoke(), 'dashboard_unavailable', 503); f.state.hook = null; mockAfterHostDecision = null;
                expect(decisions).toBe(1); expect(observed.markers).toBe(1); readOnlyRecovery(observed);
                await onlyEvent(before, call, 'readDashboardAdmission', 'module:services');
            });
        });

        describe('F runtime final authority and remaining transaction allowance', () => {
            const cutoff = atMillis(1000), longProof = atMillis(10000);
            function shortOperator(f, expiresAt = cutoff) {
                const seed = f.session('operator_dashboard', f.operatorIdentity);
                seed.expiresAt = expiresAt; seed.operatorIssuanceProof.expiresAt = expiresAt;
                return seed;
            }
            function observeOperation(f, operationId, onCommit = null) {
                const start = f.state.trace.length, active = new Map();
                const observed = { start, markers: 0, commits: 0, marker: null, transaction: 0, after: null };
                f.state.hook = async event => {
                    if (event.phase === 'after' && /^BEGIN(?: READ ONLY)?$/.test(event.sql))
                        active.set(event.backendPid, { number: ++observed.transaction, marked: false });
                    const tx = active.get(event.backendPid);
                    if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_receipts\b/.test(event.sql)
                        && event.params.includes(operationId)) {
                        expect(tx).toBeDefined(); tx.marked = true; observed.markers++;
                        observed.marker = { backendPid: event.backendPid, transaction: tx.number };
                    }
                    if (event.phase === 'after' && event.sql === 'COMMIT' && tx?.marked) {
                        observed.commits++; if (onCommit) await onCommit(event);
                    }
                    if (observed.after) await observed.after(event, tx);
                    if (event.phase === 'after' && /^(COMMIT|ROLLBACK)$/.test(event.sql)) active.delete(event.backendPid);
                };
                observed.trace = () => f.state.trace.slice(start);
                return observed;
            }
            function receiptAt(snapshot, operationId) {
                const rows = snapshot.dashboard_runtime_receipts.filter(row => row.operation_id === operationId);
                expect(rows).toHaveLength(1); return rows[0];
            }
            function expectUnsent(observed, expectedBegins = 2) {
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(0);
                const trace = observed.trace();
                expect(trace.filter(row => row.sql === 'BEGIN')).toHaveLength(expectedBegins);
                expect(trace.filter(row => row.sql === 'COMMIT')).toHaveLength(expectedBegins - 1);
                expect(trace.filter(row => row.sql === 'ROLLBACK')).toHaveLength(1);
                expect(trace.at(-1).sql).toBe('ROLLBACK');
            }
            async function preparedAcceptance(f, { caseBefore = ACCEPT_BEFORE, approvalBefore = caseBefore,
                proofUntil = longProof, selected, admissionUntil = END } = {}) {
                return f.approve(await f.bind(await f.createCase(selected, { acceptBefore: caseBefore,
                    admissionValidUntil: admissionUntil }), { freshUntil: proofUntil }), { acceptBefore: approvalBefore });
            }
            function acceptanceCommand(example) {
                return { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: example.approved.case.revision };
            }
            async function verifyReplay(f, invoke, expected, before) {
                const ids = f.state.ids, tokens = f.state.tokens;
                expect(await invoke()).toEqual(expected);
                expect(await exportAll()).toEqual(before); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            }
            test.each(['authority expiry', 'authority then invocation expiry'])(
                'FP01 directory audit COMMIT with %s withholds hints without changing its known outcome', async variant => {
                    const f = fixture; await f.initialize(); const example = await f.accepted();
                    const seed = { ...f.session('customer', f.customerIdentity), expiresAt: cutoff };
                    await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId });
                    expect((await f.repository.discoverBindings(f.request(seed), { limit: 10, afterBindingId: null })).bindings)
                        .toEqual([{ bindingId: example.selected.bindingId, organisationLabel: 'Synthetic organisation' }]);
                    const before = await exportAll(), start = f.state.trace.length, borrows = f.state.borrows;
                    let auditPid, audits = 0, committed = false, samples = 0; const postCommitPhases = [];
                    const repository = instantiate({ ...f.options, clock: () => {
                        if (!committed) return f.state.now;
                        samples++;
                        const released = f.state.borrows === f.state.releases;
                        const at = variant === 'authority expiry' ? (released ? cutoff : NOW) : samples > 1 ? atMillis(2000) : cutoff;
                        postCommitPhases.push({ released, at }); return at;
                    } });
                    f.state.hook = event => {
                        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) { audits++; auditPid = event.backendPid; }
                        if (event.phase === 'after' && event.sql === 'COMMIT' && event.backendPid === auditPid) committed = true;
                    };
                    await rejectsCode(() => repository.discoverBindings(f.request({ ...seed, deadline: atMillis(2000) }),
                        { limit: 10, afterBindingId: null }), variant === 'authority expiry' ? 'onboarding_access_denied' : 'onboarding_unavailable',
                    variant === 'authority expiry' ? 403 : 503);
                    f.state.hook = null;
                    expect(committed).toBe(true); expect(audits).toBe(1); expect(samples).toBeGreaterThanOrEqual(2);
                    if (variant === 'authority expiry') {
                        expect(postCommitPhases.filter(phase => !phase.released).every(phase => phase.at === NOW)).toBe(true);
                        expect(postCommitPhases.filter(phase => phase.released)).toEqual([{ released: true, at: cutoff }]);
                    } else expect(postCommitPhases).toEqual([{ released: false, at: cutoff }, { released: false, at: atMillis(2000) }]);
                    const trace = f.state.trace.slice(start);
                    expect(trace.filter(row => row.sql === 'COMMIT')).toHaveLength(2);
                    expect(trace.filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                    expect(f.state.borrows - borrows).toBe(2); expect(f.state.borrows).toBe(f.state.releases);
                    const after = await exportAll();
                    expect(after.dashboard_runtime_audit).toHaveLength(before.dashboard_runtime_audit.length + 1);
                    for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES].filter(table => table !== 'dashboard_runtime_audit')) expect(after[table]).toEqual(before[table]);
                });
            test('FP02 raw initialization keeps its produced gate and committed receipt when original issuance expires after COMMIT', async () => {
                const f = fixture; await f.initialize(); const seed = shortOperator(f), command = { operationId: nextId() };
                const observed = observeOperation(f, command.operationId, () => { f.state.now = cutoff; });
                await rejectsCode(() => f.repository.initializeOperatorSession(f.request(seed), command), 'onboarding_access_denied', 403);
                f.state.hook = null;
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                expect(observed.trace().filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                expect(observed.trace().filter(row => row.sql === 'BEGIN')).toHaveLength(1);
                const stored = await exportAll(), receipt = receiptAt(stored, command.operationId);
                expect(receipt.payload.result.record).toMatchObject({ sessionSha256: seed.sessionSha256, status: 'active', revision: 0, selectedBindingId: null });
                expect(stored.dashboard_session_gates.find(row => row.session_sha256 === seed.sessionSha256)).toBeDefined();
                expect(stored.dashboard_runtime_audit.find(row => row.event_id === receipt.audit_event_id)).toBeDefined();
            });
            test.each(['admission', 'binding and member'])(
                'FP03 selected session %s expiry at actual helper COMMIT preparation rolls back its audit', async variant => {
                    const f = fixture; await f.initialize(); const selected = template(f.scope, nextId());
                    if (variant === 'binding and member') selected.membership.validUntil = cutoff;
                    const example = await preparedAcceptance(f, { selected, admissionUntil: variant === 'admission' ? cutoff : END });
                    const command = acceptanceCommand(example);
                    await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
                    const seed = f.session('customer', f.customerIdentity);
                    await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: selected.bindingId });
                    const before = await exportAll(), start = f.state.trace.length; let callbacks = 0;
                    mockResourceAfterWork = () => { callbacks++; f.state.now = cutoff; };
                    await rejectsCode(() => f.repository.readSession(f.request(seed)), 'onboarding_access_denied', 403);
                    mockResourceAfterWork = null;
                    expect(callbacks).toBe(1); expect(await exportAll()).toEqual(before);
                    const trace = f.state.trace.slice(start);
                    expect(trace.filter(row => row.sql === 'COMMIT')).toHaveLength(1); // completed locator only
                    expect(trace.filter(row => row.sql === 'ROLLBACK')).toHaveLength(1);
                    expect(trace.filter(row => /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(row.sql))).toHaveLength(1);
                });
            test('FP04 accepted status checks its lawful proof/discovery cutoff after actual final receipt reconciliation', async () => {
                const f = fixture; await f.initialize(); const example = await preparedAcceptance(f, { proofUntil: cutoff });
                const command = acceptanceCommand(example);
                await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
                const before = await exportAll(), start = f.state.trace.length; let audited = false, finalReconciles = 0;
                f.state.hook = event => { if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) audited = true; };
                mockRuntimeAfterReconcile = facts => { if (audited && facts.caseState.caseId === example.command.caseId) {
                    finalReconciles++; f.state.now = cutoff;
                } };
                await rejectsCode(() => f.repository.readOnboardingStatus(f.request(example.discoverySeed, example.proof)), 'onboarding_access_denied', 403);
                mockRuntimeAfterReconcile = null; f.state.hook = null;
                expect(audited).toBe(true); expect(finalReconciles).toBe(1);
                expect(example.discoverySeed.expiresAt).toBe(example.proof.freshUntil);
                expect(await exportAll()).toEqual(before);
                expect(f.state.trace.slice(start).filter(row => row.sql === 'ROLLBACK')).toHaveLength(1);
            });
            test.each(['create case', 'approve case', 'accept coupled case and approval window', 'accept approval window'])(
                'FP05 fresh %s expiry after known COMMIT denies disclosure while a separate proven replay remains current-only', async variant => {
                    const f = fixture; await f.initialize(); let command, invoke, expected;
                    if (variant === 'create case') {
                        const example = await f.createCase(undefined, { acceptBefore: cutoff, prepareOnly: true });
                        command = example.command; invoke = () => f.repository.createCase(example.request, command);
                    } else if (variant === 'approve case') {
                        const bound = await f.bind(await f.createCase(undefined, { acceptBefore: longProof }), { freshUntil: atMillis(500) });
                        f.state.now = atMillis(600); // approving an expired candidate proof is already lawful
                        const example = await f.approve(bound, { acceptBefore: cutoff, prepareOnly: true });
                        command = example.approveCommand; invoke = () => f.repository.approveCase(f.operator(), command);
                    } else {
                        const example = await preparedAcceptance(f, { caseBefore: variant === 'accept coupled case and approval window' ? cutoff : longProof,
                            approvalBefore: cutoff });
                        if (variant === 'accept coupled case and approval window') expect(example.approveCommand.acceptBefore).toBe(example.command.acceptBefore);
                        else expect(example.approveCommand.acceptBefore < example.command.acceptBefore).toBe(true);
                        command = acceptanceCommand(example);
                        invoke = () => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
                    }
                    const observed = observeOperation(f, command.operationId, () => { f.state.now = cutoff; });
                    await rejectsCode(invoke, 'onboarding_access_denied', 403); f.state.hook = null;
                    expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                    expect(observed.trace().filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                    const committed = await exportAll(); expected = receiptAt(committed, command.operationId).payload.result;
                    expect(expected.case).toBeDefined();
                    expect(committed.dashboard_runtime_audit.find(row => row.event_id === receiptAt(committed, command.operationId).audit_event_id)).toBeDefined();
                    await verifyReplay(f, invoke, expected, committed);
                });
            test('FP06 publication evaluates the approved customer target rather than its different operator actor', async () => {
                const control = fixture; await control.initialize(); const valid = await control.publicationSetup();
                expect(subject(valid.command.identity)).not.toBe(subject(control.operatorIdentity));
                const published = await control.repository.publishExistingMembershipBinding(control.operator(), valid.command);
                await verifyReplay(control, () => control.repository.publishExistingMembershipBinding(control.operator(), valid.command), published, await exportAll());
                const f = harness(); await f.initialize(); const example = await f.publicationSetup(cutoff);
                const before = await exportAll(), observed = observeOperation(f, example.command.operationId); let callbacks = 0;
                mockResourceAfterWork = () => { callbacks++; f.state.now = cutoff; };
                await rejectsCode(() => f.repository.publishExistingMembershipBinding(f.operator(), example.command), 'onboarding_access_denied', 403);
                mockResourceAfterWork = null; f.state.hook = null;
                expect(callbacks).toBe(1); expectUnsent(observed, 1); expect(await exportAll()).toEqual(before);
            });
            test('FP07 unaccepted compound discovery retains its case deadline after its proof and gate have committed', async () => {
                const f = fixture; await f.initialize();
                const example = await f.bind(await f.createCase(undefined, { acceptBefore: cutoff }), { freshUntil: longProof, prepareOnly: true });
                const observed = observeOperation(f, example.bindCommand.operationId, () => { f.state.now = cutoff; });
                await rejectsCode(() => f.repository.recordProofAndActivateDiscovery(example.discoveryRequest, example.bindCommand), 'onboarding_access_denied', 403);
                f.state.hook = null;
                expect(observed.markers).toBe(1); expect(observed.commits).toBe(1);
                expect(observed.trace().filter(row => row.sql === 'ROLLBACK')).toEqual([]);
                const stored = await exportAll();
                expect(receiptAt(stored, example.bindCommand.operationId).payload.result.case.status).toBe('identity_verified');
                expect(stored.dashboard_onboarding_proofs.find(row => row.proof_id === example.proof.proofId)).toBeDefined();
                expect(stored.dashboard_session_gates.find(row => row.session_sha256 === example.discoverySeed.sessionSha256)).toBeDefined();
            });
            test('FP08 lost acceptance response retires fresh-window evidence before the first current-only recovery refresh', async () => {
                const f = fixture; await f.initialize(); const example = await preparedAcceptance(f, { caseBefore: cutoff, approvalBefore: cutoff });
                const command = acceptanceCommand(example); let committed, ids, tokens;
                const observed = acceptanceCommitFault(f, command.operationId, 'after', async () => {
                    committed = await exportAll(); ids = f.state.ids; tokens = f.state.tokens; f.state.now = cutoff;
                    throw new Error('synthetic response lost after actual acceptance COMMIT');
                });
                const result = await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
                f.state.hook = null; expectAcceptanceCommitFault(observed);
                expect(result).toEqual(receiptAt(committed, command.operationId).payload.result);
                expect(await exportAll()).toEqual(committed); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
                expect(observed.recoverySql.filter(sql => sql === 'BEGIN')).toHaveLength(1);
                expect(observed.recoverySql.filter(sql => /^(INSERT|UPDATE|DELETE|TRUNCATE)\s/i.test(sql))).toEqual([]);
                const tail = f.state.trace.slice(f.state.trace.findLastIndex(row => row.sql === 'BEGIN'));
                expectRemainingPreparations(tail, 59000);
            });
            test.each(['deadline', 'regression', 'invalid clock'])(
                'FP09 lost acceptance response preserves latched %s without a recovery BEGIN', async variant => {
                    const f = fixture; await f.initialize(); const example = await preparedAcceptance(f), command = acceptanceCommand(example);
                    let failed = false, samples = 0, committed;
                    const repository = instantiate({ ...f.options, clock: () => {
                        if (!failed) return f.state.now;
                        samples++; return samples > 1 ? NOW : variant === 'deadline' ? atMillis(60000) : variant === 'regression' ? atMillis(-1) : 'invalid-clock';
                    } });
                    const observed = acceptanceCommitFault(f, command.operationId, 'after', async () => {
                        committed = await exportAll(); failed = true; throw new Error('synthetic lost actual COMMIT response');
                    });
                    await rejectsCode(() => repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command), 'onboarding_unavailable', 503);
                    f.state.hook = null; expectAcceptanceCommitFault(observed); expect(samples).toBeGreaterThanOrEqual(1);
                    expect(observed.recoverySql.filter(sql => sql === 'BEGIN')).toEqual([]);
                    expect(await exportAll()).toEqual(committed); receiptAt(committed, command.operationId);
                });
            test.each(['late helper borrow', 'expiry after COMMIT timeout SET', 'failed COMMIT timeout SET'])(
                'FP10 scoped %s preserves definite control ownership', async variant => {
                    const f = fixture; await f.initialize(); const example = await preparedAcceptance(f, { caseBefore: cutoff });
                    const command = acceptanceCommand(example), before = await exportAll();
                    const observed = observeOperation(f, command.operationId); let prepared = false, intercepted = 0, borrows = 0;
                    if (variant === 'late helper borrow') f.state.beforeBorrow = () => { if (++borrows === 2) f.state.now = atMillis(60000); };
                    else {
                        mockResourceAfterWork = () => { expect(observed.markers).toBe(1); prepared = true; };
                        observed.after = event => {
                            if (!prepared || !isRuntimeTimeout(event.sql)) return;
                            if (variant === 'failed COMMIT timeout SET' && event.phase === 'before') {
                                prepared = false; intercepted++; throw new Error('synthetic COMMIT preparation setter failure');
                            }
                            if (variant === 'expiry after COMMIT timeout SET' && event.phase === 'after') {
                                prepared = false; intercepted++; f.state.now = cutoff;
                            }
                        };
                    }
                    try {
                        await rejectsCode(() => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command),
                            variant === 'expiry after COMMIT timeout SET' ? 'onboarding_access_denied' : 'onboarding_unavailable',
                            variant === 'expiry after COMMIT timeout SET' ? 403 : 503);
                    } finally { mockResourceAfterWork = null; f.state.beforeBorrow = null; f.state.hook = null; }
                    expect(await exportAll()).toEqual(before); expect(f.state.borrows).toBe(f.state.releases);
                    if (variant === 'late helper borrow') {
                        expect(borrows).toBe(2); expect(observed.markers).toBe(0);
                        expect(observed.trace().filter(row => row.sql === 'BEGIN')).toHaveLength(1);
                        expect(observed.trace().filter(row => row.sql === 'COMMIT')).toHaveLength(1);
                        const trace = observed.trace(), locatorEnd = trace.findLastIndex(row => row.sql === 'COMMIT');
                        expect(trace.slice(locatorEnd + 1)).toEqual([]); // no helper BEGIN, tenant GUC or query after late acquire
                    } else { expect(intercepted).toBe(1); expectUnsent(observed); }
                });
            test('FP11 raw initialization withholds COMMIT when its final-gate timeout preparation observes expiry', async () => {
                const f = fixture; await f.initialize();
                async function attempt(expire) {
                    const seed = shortOperator(f), command = { operationId: nextId() }, observed = observeOperation(f, command.operationId);
                    let gateLoaded = false, setter = null;
                    observed.after = (event, tx) => {
                        if (event.phase === 'after' && tx?.marked && /FROM nofries\.dashboard_session_gates\b/.test(event.sql)) gateLoaded = true;
                        if (gateLoaded && !setter && event.phase === 'after' && isRuntimeTimeout(event.sql)) {
                            setter = { backendPid: event.backendPid, index: f.state.trace.length - 1 };
                            if (expire) f.state.now = cutoff;
                        }
                    };
                    const before = await exportAll();
                    const result = await settled(f.repository.initializeOperatorSession(f.request(seed), command)); f.state.hook = null;
                    expect(gateLoaded).toBe(true); expect(setter).not.toBeNull();
                    expect(setter.backendPid).toBe(observed.marker.backendPid);
                    if (!expire) { expect(result.error).toBeUndefined(); expect(f.state.trace[setter.index + 1].sql).toBe('COMMIT'); }
                    else { expectError(result.error, 'onboarding_access_denied', 403); expectUnsent(observed, 1); expect(await exportAll()).toEqual(before); }
                }
                await attempt(false); await attempt(true);
            });
            test('FP12 standalone audit recovers its lost COMMIT response with original metadata and remaining allowance', async () => {
                const f = fixture; await f.initialize();
                const command = { eventId: nextId(), action: 'readSession', outcome: 'denied', resourceKey: 'session', operationId: null };
                const start = f.state.trace.length; let marked = false, fault = 0, committed, ids, auditPid, lookupCommits = 0;
                f.state.hook = async event => {
                    if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql) && event.params.includes(command.eventId)) { marked = true; auditPid = event.backendPid; }
                    if (!marked && event.phase === 'after' && event.sql === 'COMMIT') lookupCommits++;
                    if (marked && !fault && event.phase === 'after' && event.sql === 'COMMIT') {
                        expect(event.backendPid).toBe(auditPid); fault++; committed = await exportAll(); ids = f.state.ids; f.state.now = cutoff;
                        throw new Error('synthetic standalone event COMMIT response lost');
                    }
                };
                expect(await f.repository.recordRuntimeEvent(f.operator(), command)).toEqual({ schemaVersion: 1, eventId: command.eventId, recorded: true });
                f.state.hook = null; expect(marked).toBe(true); expect(fault).toBe(1); expect(lookupCommits).toBe(1); expect(f.state.ids).toBe(ids);
                expect(await exportAll()).toEqual(committed);
                const trace = f.state.trace.slice(start), last = trace.findLastIndex(row => row.sql === 'BEGIN');
                expect(trace.filter(row => row.sql === 'BEGIN')).toHaveLength(3); // locator, event write, one recovery
                expect(trace.slice(last).filter(row => /^(INSERT|UPDATE|DELETE|TRUNCATE)\s/.test(row.sql))).toEqual([]);
                expectRemainingPreparations(trace.slice(last), 59000);
            });
            test.each(['healthy scoped refusal', 'already aborted raw initializer'])(
                'FP13 F-owned %s resets best-effort and restores the measured restricted backend', async variant => {
                    const settingsSql = `SELECT current_user AS role, session_user AS login,
                        current_setting('statement_timeout') AS statement_timeout,
                        COALESCE(current_setting('nofries.tenant_id',true),'') AS tenant_id,
                        COALESCE(current_setting('nofries.organisation_id',true),'') AS organisation_id,
                        COALESCE(current_setting('nofries.session_sha256',true),'') AS session_sha256,
                        COALESCE(current_setting('nofries.subject_key',true),'') AS subject_key,
                        COALESCE(current_setting('nofries.identity_sha256',true),'') AS identity_sha256,
                        COALESCE(current_setting('nofries.runtime_instance_id',true),'') AS runtime_instance_id,
                        COALESCE(current_setting('nofries.request_id',true),'') AS request_id`;
                    const observed = { markers: 0, cleanup: [], errors: [], releases: [] };
                    let active = false, f, command;
                    const observedPool = { end: () => runtimePool.end(), async connect() {
                        const client = await runtimePool.connect();
                        return { processID: client.processID, async query(sql, params) {
                            const cleanup = active && observed.backendPid === client.processID && (isRuntimeReset(sql) || sql === 'ROLLBACK');
                            if (cleanup) observed.cleanup.push({ sql, phase: 'before', params: clone(params || []) });
                            if (cleanup && sql === 'ROLLBACK' && variant === 'healthy scoped refusal')
                                observed.resetTimeout = (await client.query('SHOW statement_timeout')).rows[0].statement_timeout;
                            let result;
                            try { result = await client.query(sql, params); }
                            catch (error) { if (cleanup) observed.errors.push({ sql, code: error.code, backendPid: client.processID }); throw error; }
                            if (cleanup) {
                                observed.cleanup.push({ sql, phase: 'after' });
                                if (sql === 'ROLLBACK') observed.restored = (await client.query(settingsSql)).rows[0];
                            }
                            if (active && /INSERT INTO nofries\.dashboard_runtime_receipts\b/.test(sql) && params.includes(command.operationId)) {
                                observed.markers++; observed.backendPid = client.processID;
                                observed.inTransaction = (await client.query(settingsSql)).rows[0];
                                if (variant === 'already aborted raw initializer') {
                                    try { await client.query('SELECT 1 / 0'); }
                                    catch (error) { observed.errors.push({ sql: 'SELECT 1 / 0', code: error.code, backendPid: client.processID }); throw error; }
                                    throw new Error('The real division-by-zero control unexpectedly succeeded');
                                }
                            }
                            return result;
                        }, release(discard) {
                            if (active && observed.backendPid === client.processID) observed.releases.push({ discard, rollbackSettled: Boolean(observed.restored) });
                            client.release(discard);
                        } };
                    } };
                    try {
                        f = harness({ rawRuntimePool: observedPool }); await f.initialize(); let invoke;
                        if (variant === 'healthy scoped refusal') {
                            const example = await preparedAcceptance(f, { caseBefore: cutoff }); command = acceptanceCommand(example);
                            invoke = () => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
                        } else {
                            command = { operationId: nextId() }; const seed = f.session('operator_dashboard', f.operatorIdentity);
                            invoke = () => f.repository.initializeOperatorSession(f.request(seed), command);
                        }
                        const baselineClient = await runtimePool.connect(); let baseline, baselinePid;
                        try { baselinePid = baselineClient.processID; baseline = (await baselineClient.query(settingsSql)).rows[0]; }
                        finally { baselineClient.release(); }
                        const before = await exportAll(), boundary = f.state.trace.length;
                        active = true;
                        if (variant === 'healthy scoped refusal') mockResourceAfterWork = () => {
                            expect(observed.markers).toBe(1); f.state.now = cutoff;
                        };
                        await rejectsCode(invoke, variant === 'healthy scoped refusal' ? 'onboarding_access_denied' : 'onboarding_unavailable',
                            variant === 'healthy scoped refusal' ? 403 : 503);
                        expect(observed.markers).toBe(1); expect(observed.backendPid).toBe(baselinePid);
                        expect(observed.inTransaction).toMatchObject({ role: 'nofries_runtime', login: runtimeRole });
                        expect(observed.inTransaction.statement_timeout).not.toBe('0');
                        if (variant === 'healthy scoped refusal') expect(observed.inTransaction).toMatchObject({ tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId });
                        expect(observed.cleanup.filter(event => event.phase === 'before')).toEqual([
                            { sql: 'SET LOCAL statement_timeout = 0', phase: 'before', params: [] }, { sql: 'ROLLBACK', phase: 'before', params: [] }]);
                        expect(observed.cleanup.at(-1)).toEqual({ sql: 'ROLLBACK', phase: 'after' });
                        if (variant === 'healthy scoped refusal') {
                            expect(observed.errors).toEqual([]); expect(observed.resetTimeout).toBe('0');
                        } else expect(observed.errors).toEqual([
                            { sql: 'SELECT 1 / 0', code: '22012', backendPid: baselinePid },
                            { sql: 'SET LOCAL statement_timeout = 0', code: '25P02', backendPid: baselinePid }]);
                        expect(observed.restored).toEqual(baseline);
                        expect(observed.releases).toEqual([{ discard: false, rollbackSettled: true }]);
                        const trace = f.state.trace.slice(boundary);
                        expect(trace.filter(event => event.sql === 'BEGIN')).toHaveLength(variant === 'healthy scoped refusal' ? 2 : 1);
                        expect(trace.filter(event => event.sql === 'COMMIT')).toHaveLength(variant === 'healthy scoped refusal' ? 1 : 0);
                        expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(1);
                        expect(f.state.borrows).toBe(f.state.releases); expect(await exportAll()).toEqual(before); await loginClean();
                    } finally { active = false; mockResourceAfterWork = null; if (f) f.state.hook = null; }
                });
            test('FP14 remaining F lifetime cancels a genuine restricted raw session fence before holder release', async () => {
                const url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const { Pool } = require('pg'), parallel = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                    application_name: `runtime-f-timeout-${runKey}` }), closeParallel = trackPoolClientEnds(parallel);
                const sqlErrors = [], waiter = gate(); let f, holder, operation, holderReleased = false;
                const observedPool = { end: () => parallel.end(), async connect() {
                    const client = await parallel.connect();
                    return { processID: client.processID, async query(...args) {
                        try { return await client.query(...args); }
                        catch (error) { if (error.code === '57014') sqlErrors.push({ code: error.code, sql: args[0], backendPid: client.processID, holderReleased }); throw error; }
                    }, release: discard => client.release(discard) };
                } };
                try {
                    f = harness({ rawRuntimePool: observedPool }); await f.initialize();
                    const seed = { ...f.session('operator_dashboard', f.operatorIdentity), deadline: atMillis(1200) }, request = f.request(seed);
                    const before = await exportAll();
                    holder = await parallel.connect(); await holder.query('BEGIN');
                    await holder.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))', [71001, seed.sessionSha256]);
                    let waiterPid;
                    f.state.hook = event => { if (event.phase === 'before' && /pg_advisory_xact_lock\(/.test(event.sql)
                        && Number(event.params[0]) === 71001) { waiterPid = event.backendPid; waiter.resolve(); } };
                    operation = settled(f.repository.initializeOperatorSession(request, { operationId: nextId() }));
                    await Promise.race([waiter.promise, operation.then(() => { throw new Error('F operation settled before its required session fence'); })]);
                    expect(waiterPid).not.toBe(holder.processID); await actualBlockedBy(waiterPid, holder.processID);
                    const timeout = gate(5000); let outcome;
                    try { outcome = await Promise.race([operation, timeout.promise]); } finally { timeout.resolve(); }
                    expectError(outcome.error, 'onboarding_unavailable', 503);
                    expect(sqlErrors).toHaveLength(1); expect(sqlErrors[0]).toMatchObject({ code: '57014', backendPid: waiterPid, holderReleased: false });
                    expect(sqlErrors[0].sql).toMatch(/pg_advisory_xact_lock\(/);
                    expect(await exportAll()).toEqual(before);
                } finally {
                    waiter.resolve();
                    try {
                        if (holder) {
                            let discard = false;
                            try { await holder.query('ROLLBACK'); } catch (error) { discard = true; throw error; }
                            finally { holderReleased = true; holder.release(discard); }
                        }
                    } finally {
                        if (f) f.state.hook = null;
                        try { if (operation) await operation; } finally { await closeParallel(); }
                    }
                }
            });
        });

        describe('request-bound NCSC resources on the restricted LOGIN', () => {
            // This resource boundary deliberately has different public error
            // constructors from the older onboarding repository. Keep the old
            // domain helper unchanged and assert the exact resource classes.
            function expectResourceError(error, code, statusCode) {
                const Type = code.startsWith('ncsc_') ? NcscAssessmentError
                    : code.startsWith('dashboard_') ? DashboardPersistenceError : null;
                expect(Type).not.toBeNull();
                expect(error).toBeInstanceOf(Type);
                expect(error).toMatchObject({ code, statusCode });
                expect(error.message).not.toMatch(/SQL must|synthetic driver|credential/i);
            }
            async function rejectsResourceCode(work, code, statusCode) {
                const result = await settled(Promise.resolve().then(work));
                expectResourceError(result.error, code, statusCode);
                return result.error;
            }
            async function unchangedResourceFailure(work, code, statusCode) {
                const before = await exportAll();
                await rejectsResourceCode(work, code, statusCode);
                expect(await exportAll()).toEqual(before);
            }
            test.each(['customer', 'operator_dashboard'])('%s preserves admission and create/save/submit/read/list without duplicate mutation audits', async purpose => {
                const f = await resourceSetup({ purpose }), before = await exportAll();
                const admission = await f.facade.admission.readAdmissionSnapshot(f.context.scope, f.context.identity);
                expect(Object.keys(admission).sort()).toEqual(['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments', 'summary'].sort());
                expect(admission.summary).toBeNull(); expect(Array.isArray(admission.advisorAssignments)).toBe(false);
                expect(await exportAll()).toEqual(before);
                const create = await f.facade.ncsc.executeNcscAssessment(f.context, createCommand());
                expect(create).toMatchObject({ action: 'create', assessment: { assessmentId: 'assessment-a', revision: 0 } });
                const saved = await f.facade.ncsc.executeNcscAssessment(f.context, saveCommand());
                const submitted = await f.facade.ncsc.executeNcscAssessment(f.context, submitCommand());
                expect(saved.assessment.revision).toBe(1); expect(submitted.assessment).toMatchObject({ revision: 2, status: 'submitted' });
                const writes = await exportAll();
                expect(writes.dashboard_runtime_audit).toEqual(before.dashboard_runtime_audit);
                expect(writes.dashboard_ncsc_assessment_receipts).toHaveLength(3);
                expect(writes.dashboard_ncsc_assessment_revisions).toHaveLength(3);
                expect(writes.dashboard_usage.find(row => row.grant_id === 'synthetic-product').payload.counters.assessment_runs).toBe(1);
                expect(f.quota.policySelections).toHaveLength(1);
                const detail = await f.facade.ncsc.readNcscAssessment(f.context, { assessmentId: 'assessment-a' });
                expect(detail.assessment).toEqual(submitted.assessment);
                const list = await f.facade.ncsc.listNcscAssessments(f.context, { limit: 10, afterAssessmentId: null });
                expect(list.assessments.map(item => item.assessmentId)).toEqual(['assessment-a']);
                expect((await exportAll()).dashboard_runtime_audit).toHaveLength(before.dashboard_runtime_audit.length + 2);
                await loginClean();
            });
            test('same tenant and cross-tenant scopes retain colliding assessment and idempotency IDs independently', async () => {
                const f = await resourceSetup();
                await f.facade.ncsc.executeNcscAssessment(f.context, createCommand('collision', 'same-key', 'First organisation'));
                const tenant = f.example.state.tenantAggregate.tenant;
                const second = await f.addResource({ tenantId: f.scope.tenantId, organisationId: 'second-organisation' }, {}, tenant);
                const third = await f.addResource({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId });
                let generation = f.selected.record.generationToken;
                for (const [target, description] of [[second, 'Second organisation'], [third, 'Other tenant']]) {
                    const selected = await f.repository.selectBinding(f.request(f.seed), { operationId: nextId(),
                        bindingId: target.publication.binding.bindingId, expectedGeneration: generation }); generation = selected.record.generationToken;
                    const bound = await f.bindResource({ generation });
                    const created = await bound.facade.ncsc.executeNcscAssessment(bound.context, createCommand('collision', 'same-key', description));
                    expect(created.assessment.scopePopulation.description).toBe(description);
                    const list = await bound.facade.ncsc.listNcscAssessments(bound.context, { limit: 10, afterAssessmentId: null });
                    expect(list.assessments).toHaveLength(1);
                }
                const stored = await exportAll(); expect(stored.dashboard_ncsc_assessments).toHaveLength(3);
                expect(stored.dashboard_ncsc_assessment_receipts).toHaveLength(3);
                await unchangedResourceFailure(() => f.facade.ncsc.readNcscAssessment(f.context, { assessmentId: 'collision' }), 'ncsc_access_denied', 403);
                await loginClean();
            });
            test.each(['stale generation', 'foreign full identity', 'absent gate', 'revoked gate', 'unselected gate', 'discovery', 'external epoch', 'missing operator proof'])
            ('denies %s without resource effects', async variant => {
                const f = await resourceSetup({ purpose: variant === 'missing operator proof' ? 'operator_dashboard' : 'customer' });
                let seed = clone(f.seed), generation = f.selected.record.generationToken;
                if (variant === 'stale generation') generation = 'f'.repeat(64);
                if (variant === 'foreign full identity') seed.identityPayload.policyRevision++;
                if (variant === 'absent gate') seed.sessionSha256 = digest(nextId());
                if (variant === 'revoked gate') await f.repository.revokeSession(f.request(seed), { operationId: nextId() });
                if (variant === 'unselected gate') {
                    seed = f.session('operator_dashboard', f.operatorIdentity);
                    const initialized = await f.repository.initializeOperatorSession(f.request(seed), { operationId: nextId() });
                    generation = initialized.record.generationToken;
                }
                if (variant === 'discovery') { seed.kind = 'onboarding_discovery'; seed.discovery = { caseId: nextId(), proofId: nextId() }; }
                if (variant === 'external epoch') f.state.restoreEpoch = nextId();
                if (variant === 'missing operator proof') seed.operatorIssuanceProof = null;
                await unchangedResourceFailure(() => f.bindResource({ selectedSeed: seed, generation }), 'dashboard_access_denied', 403);
                await loginClean();
            });
            test('retains admission birth revision zero when a valid later authority head is active', async () => {
                const f = await resourceSetup();
                const next = await f.maintenance.publishAdmissionDecision({ ...clone(f.admissionCommand), operationId: nextId(),
                    expectedRevision: 0, expectedHeadSha256: f.admission.record.decisionSha256 });
                expect(next.record.revision).toBe(1);
                const bound = await f.bindResource();
                expect((await bound.facade.ncsc.listNcscAssessments(bound.context, { limit: 1, afterAssessmentId: null })).assessments).toEqual([]);
                const binding = (await rows('dashboard_identity_bindings', 'binding_id', f.publication.binding.bindingId))[0];
                expect(binding.authority_revision).toBe(0); expect(binding.authority_sha256).toBe(f.admission.record.decisionSha256);
            });
            test.each(['birth digest', 'birth scope'])('rejects corrupted %s from the typed row boundary without normalizing a fake historical head', async variant => {
                const f = await resourceSetup(); let changed = 0;
                await f.maintenance.publishAdmissionDecision({ ...clone(f.admissionCommand), operationId: nextId(),
                    expectedRevision: 0, expectedHeadSha256: f.admission.record.decisionSha256 });
                const bound = await f.bindResource();
                f.state.hook = event => {
                    if (event.phase === 'after' && /FROM nofries\.dashboard_admission_decisions/.test(event.sql) && event.params[1] === 0 && event.result.rows.length) {
                        const row = event.result.rows[0];
                        if (variant === 'birth digest') row.decision_sha256 = 'f'.repeat(64); else row.organisation_id = 'foreign-organisation'; changed++;
                    }
                };
                // The real SELECT succeeds; this models a corrupt driver record,
                // not a SQL-valid update of immutable FK-protected history.
                await unchangedResourceFailure(() => bound.facade.ncsc.listNcscAssessments(bound.context, { limit: 1, afterAssessmentId: null }), 'ncsc_unavailable', 503);
                expect(changed).toBeGreaterThan(0); f.state.hook = null; await loginClean();
            });
            test('withdrawal of selected admission denies an already-created facade at its next resource operation', async () => {
                const f = await resourceSetup();
                await f.maintenance.withdrawAdmissionDecision({ ...clone(f.admissionCommand), operationId: nextId(),
                    expectedRevision: 0, expectedHeadSha256: f.admission.record.decisionSha256 });
                await unchangedResourceFailure(() => f.facade.ncsc.executeNcscAssessment(f.context, createCommand()), 'ncsc_access_denied', 403);
                await loginClean();
            });
            test('a same-subject replacement membership cannot use the old binding or reach quota and assessment writes', async () => {
                const f = await resourceSetup();
                await f.mutateMembership('remove', { membershipId: f.member.membershipId });
                await f.mutateMembership('invite', { invitationId: 'replacement-invitation', subjectKey: NCSC_SUBJECT, roles: ['admin'],
                    validFrom: f.member.validFrom, validUntil: f.member.validUntil, grantEvidenceId: 'replacement-approved-role', expiresAt: f.member.validUntil });
                await f.mutateMembership('accept', { invitationId: 'replacement-invitation', membershipId: 'replacement-member' });
                const boundary = f.state.trace.length;
                await unchangedResourceFailure(() => f.facade.ncsc.executeNcscAssessment(f.context, createCommand()), 'ncsc_access_denied', 403);
                expect(f.quota.policySelections).toHaveLength(0);
                expect(f.state.trace.slice(boundary).some(event => /dashboard_ncsc_|INSERT INTO nofries\.dashboard_runtime_audit/.test(event.sql))).toBe(false);
                const tenantLocks = f.state.trace.slice(boundary).filter(event => /FROM nofries\.dashboard_tenants/.test(event.sql));
                expect(tenantLocks).toHaveLength(1); expect(tenantLocks[0].sql).toMatch(/FOR UPDATE/); await loginClean();
            });
            test.each(['selection', 'logout', 'instance', 'admission', 'membership'].flatMap(family => ['resource first', 'revoker first'].map(order => [family, order])))
            ('%s fencing with %s proves a real two-backend lock wait and correct final authority', async (family, order) => {
                const url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const { Pool } = require('pg'), parallel = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                    application_name: `resource-lock-${runKey}` }), closeParallel = trackPoolClientEnds(parallel);
                const held = gate(), release = gate(0), waiter = gate(); let resourcePromise, revokePromise;
                try {
                    const f = await resourceSetup({ rawRuntimePool: parallel }); let holderPid, waiterPid;
                    const currentInstance = (await rows('dashboard_runtime_instance', 'instance_id', f.instanceId))[0];
                    const instance = { schemaVersion: 1, instanceId: currentInstance.instance_id, revision: currentInstance.revision,
                        restoreEpoch: currentInstance.restore_epoch, ingressStatus: currentInstance.ingress_status, changedAt: new Date(currentInstance.changed_at).toISOString(),
                        evidenceRef: currentInstance.evidence_ref, evidenceSha256: currentInstance.evidence_sha256 };
                    const revoke = () => family === 'selection' ? f.repository.selectBinding(f.request(f.seed), { operationId: nextId(),
                        bindingId: f.publication.binding.bindingId, expectedGeneration: f.selected.record.generationToken })
                        : family === 'logout' ? f.repository.revokeSession(f.request(f.seed), { operationId: nextId() })
                            : family === 'instance' ? f.maintenance.fenceRestoreEpoch(f.instanceCommand(instance))
                                : family === 'admission' ? f.maintenance.withdrawAdmissionDecision({ ...clone(f.admissionCommand), operationId: nextId(),
                                    expectedRevision: 0, expectedHeadSha256: f.admission.record.decisionSha256 })
                                    : f.mutateMembership('suspend', { membershipId: f.member.membershipId });
                    const familyNumber = ['selection', 'logout'].includes(family) ? 71001 : family === 'instance' ? 71002 : 71003;
                    const exclusive = event => family === 'membership' ? /FROM nofries\.dashboard_tenants[\s\S]*FOR UPDATE/.test(event.sql)
                        : /pg_advisory_xact_lock\(/.test(event.sql) && Number(event.params[0]) === familyNumber;
                    const shared = event => family === 'membership' ? /FROM nofries\.dashboard_tenants[\s\S]*FOR UPDATE/.test(event.sql)
                        : /pg_advisory_xact_lock_shared\(/.test(event.sql) && Number(event.params[0]) === familyNumber;
                    f.state.hook = async event => {
                        const holds = order === 'resource first' ? event.phase === 'after' && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts/.test(event.sql)
                            : event.phase === 'after' && exclusive(event);
                        if (!holderPid && holds) { holderPid = event.backendPid; held.resolve(); await release.promise; }
                        if (holderPid && event.backendPid !== holderPid && event.phase === 'before'
                            && (order === 'resource first' ? exclusive(event) : shared(event))) {
                            waiterPid = event.backendPid; waiter.resolve();
                        }
                    };
                    const traceBoundary = f.state.trace.length;
                    if (order === 'resource first') { resourcePromise = settled(f.facade.ncsc.executeNcscAssessment(f.context, createCommand())); await held.promise; revokePromise = settled(revoke()); }
                    else { revokePromise = settled(revoke()); await held.promise; resourcePromise = settled(f.facade.ncsc.executeNcscAssessment(f.context, createCommand())); }
                    await waiter.promise; expect(waiterPid).not.toBe(holderPid); await actualBlockedBy(waiterPid, holderPid); release.resolve();
                    const [resource, revocation] = await Promise.all([resourcePromise, revokePromise]); expect(revocation.error).toBeUndefined();
                    if (order === 'resource first') expect(resource.value).toMatchObject({ action: 'create' });
                    else expectResourceError(resource.error, 'ncsc_access_denied', 403);
                    // Capture only the resource participant's completed transaction,
                    // before another operation can reuse its pooled backend.
                    const resourcePid = order === 'resource first' ? holderPid : waiterPid;
                    const resourceTrace = f.state.trace.slice(traceBoundary).filter(event => event.backendPid === resourcePid);
                    expect(resourceTrace[0].sql).toBe('BEGIN');
                    expect(resourceTrace.filter(event => /^BEGIN(?: READ ONLY)?$/.test(event.sql))).toHaveLength(1);
                    expect(resourceTrace[resourceTrace.length - 1].sql).toBe(order === 'resource first' ? 'COMMIT' : 'ROLLBACK');
                    const locks = resourceTrace.filter(event => /FROM nofries\.dashboard_tenants/.test(event.sql));
                    if (order === 'resource first') expect(locks.length).toBeGreaterThan(0);
                    expect(locks.every(event => /FOR UPDATE/.test(event.sql) && !/FOR SHARE/.test(event.sql))).toBe(true);
                    const committed = await exportAll();
                    expect(committed.dashboard_ncsc_assessment_receipts).toHaveLength(order === 'resource first' ? 1 : 0);
                    f.state.hook = null;
                    await unchangedResourceFailure(() => f.facade.ncsc.executeNcscAssessment(f.context, createCommand('later', 'later')), 'ncsc_access_denied', 403);
                } finally { release.resolve(); held.resolve(); waiter.resolve(); await Promise.all([resourcePromise, revokePromise].filter(Boolean)); await closeParallel(); }
            });
            test('late checked pool acquisition releases its real LOGIN without starting a canonical transaction', async () => {
                const f = await resourceSetup(); let late = false;
                const pool = { end: () => f.restrictedPool.end(), async connect() {
                    const client = await f.restrictedPool.connect(); if (late) f.state.now = '2026-09-07T01:01:00.000Z'; return client;
                } };
                const bound = await f.bindResource({ overrides: { pool } }); late = true;
                const boundary = f.state.trace.length, before = await exportAll(), releases = f.state.releases;
                await rejectsResourceCode(() => bound.facade.ncsc.executeNcscAssessment(bound.context, createCommand()), 'ncsc_unavailable', 503);
                expect(f.state.trace.slice(boundary)).toEqual([]); expect(f.state.releases).toBe(releases + 1);
                expect(await exportAll()).toEqual(before); await loginClean();
            });
            test.each(['future capture', 'future selected gate', 'revoked binding'])('current %s cannot disclose resources', async variant => {
                const f = await resourceSetup(); let seed = clone(f.seed), generation = f.selected.record.generationToken;
                if (variant === 'future capture') seed.issuedAt = '2026-09-07T01:00:01.000Z';
                if (variant === 'future selected gate') {
                    f.state.now = '2026-09-07T01:00:01.000Z';
                    const selected = await f.repository.selectBinding(f.request(seed), { operationId: nextId(),
                        bindingId: f.publication.binding.bindingId, expectedGeneration: generation }); generation = selected.record.generationToken;
                    f.state.now = NOW;
                }
                if (variant === 'revoked binding') {
                    // Binding has a closed active0 -> revoked1 lifecycle. The
                    // owner fixture installs that exact terminal current row;
                    // resource work still uses only the restricted LOGIN.
                    await ownerPool.query("UPDATE nofries.dashboard_identity_bindings SET revision=1,status='revoked',updated_at=$1 WHERE binding_id=$2",
                        [f.state.now, f.publication.binding.bindingId]);
                    await unchangedResourceFailure(() => f.facade.ncsc.listNcscAssessments(f.context, { limit: 1, afterAssessmentId: null }), 'ncsc_access_denied', 403);
                } else await unchangedResourceFailure(() => f.bindResource({ selectedSeed: seed, generation }), 'dashboard_access_denied', 403);
                await loginClean();
            });
            test('paired read audit uses the only checked-out connection and persists the exact original eleven-field event', async () => {
                const f = await resourceSetup(), before = await exportAll(); let competing, competingResolved = false, activePid = null;
                f.state.hook = event => {
                    if (event.phase === 'before' && /INSERT INTO nofries\.dashboard_runtime_audit/.test(event.sql)) {
                        activePid = event.backendPid;
                        competing = runtimePool.connect().then(client => { competingResolved = true; client.release(); });
                        expect(competingResolved).toBe(false);
                    }
                };
                const borrows = f.state.borrows;
                await f.facade.ncsc.listNcscAssessments(f.context, { limit: 10, afterAssessmentId: null });
                expect(f.state.borrows).toBe(borrows + 1); await competing; expect(competingResolved).toBe(true);
                const newRows = (await exportAll()).dashboard_runtime_audit.filter(row => !before.dashboard_runtime_audit.some(old => old.event_id === row.event_id));
                expect(newRows).toHaveLength(1); const row = newRows[0];
                expect(row.operation_id).toBeNull(); expect(row.scope_json).toEqual(f.scope);
                expect(row.payload).toEqual({ schemaVersion: 1, eventType: 'dashboard.operation', eventId: row.event_id,
                        requestId: f.context.requestId, actorSubjectKey: NCSC_SUBJECT, ...f.scope, action: 'assessment.read',
                        module: 'cyber_security', result: 'succeeded', occurredAt: f.state.now });
                expect(hash({ sessionSha256: f.seed.sessionSha256, instanceId: f.instanceId,
                    authorityId: f.admission.record.authorityId, event: row.payload })).toBe(row.event_sha256);
                expect(f.state.trace.some(event => event.backendPid === activePid && /octet_length\(\$1::jsonb::text\)/.test(event.sql))).toBe(true);
                const measured = await ownerPool.query('SELECT octet_length(payload::text) AS bytes FROM nofries.dashboard_runtime_audit WHERE event_id=$1', [row.event_id]);
                expect(measured.rows[0].bytes).toBeLessThanOrEqual(16384); await loginClean();
            });
            test.each(['read audit insert', 'version insert', 'head insert', 'receipt insert', 'usage update'])
            ('a failure after %s rolls back every one of the 21 tables', async target => {
                const f = await resourceSetup(); let command = createCommand();
                if (target === 'usage update') { await f.facade.ncsc.executeNcscAssessment(f.context, command);
                    await f.facade.ncsc.executeNcscAssessment(f.context, saveCommand()); command = submitCommand(); }
                const pattern = target === 'read audit insert' ? /INSERT INTO nofries\.dashboard_runtime_audit/
                    : target === 'version insert' ? /INSERT INTO nofries\.dashboard_ncsc_assessment_revisions/
                        : target === 'head insert' ? /INSERT INTO nofries\.dashboard_ncsc_assessments\b/
                            : target === 'receipt insert' ? /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts/
                                : /UPDATE nofries\.dashboard_usage/;
                let injected = 0; f.state.hook = event => { if (!injected && event.phase === 'after' && pattern.test(event.sql)) { injected++; throw new Error('Synthetic post-write fault'); } };
                await unchangedResourceFailure(() => target === 'read audit insert'
                    ? f.facade.ncsc.listNcscAssessments(f.context, { limit: 10, afterAssessmentId: null })
                    : f.facade.ncsc.executeNcscAssessment(f.context, command), 'ncsc_unavailable', 503);
                expect(injected).toBe(1); f.state.hook = null; await loginClean();
            });
            test('real paired audit denial survives both sanitizers as 403 after a known rollback', async () => {
                const f = await resourceSetup(); let changed = 0;
                f.state.hook = event => { if (!changed && event.phase === 'after' && /FROM nofries\.dashboard_ncsc_assessments/.test(event.sql)) {
                    changed++; const old = f.registry.get(f.original); f.registry.set(f.original, { ...old, identityPayload: { ...old.identityPayload, policyRevision: 2 } });
                } };
                await unchangedResourceFailure(() => f.facade.ncsc.listNcscAssessments(f.context, { limit: 10, afterAssessmentId: null }), 'ncsc_access_denied', 403);
                expect(changed).toBe(1); f.state.hook = null; await loginClean();
            });
            test('arbitrary provider errors with copied denial fields stay unavailable', async () => {
                const f = await resourceSetup(), bound = await f.bindResource({ overrides: {
                    readExternalRuntimeEpoch: async () => ({ instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch }) } });
                // The original factory keeps its trusted function identity; its
                // throw is armed by a later capture, after binding has succeeded.
                let fail = false;
                const next = await f.bindResource({ overrides: { readExternalRuntimeEpoch: async () => {
                    if (fail) throw { name: 'DashboardPersistenceError', code: 'dashboard_access_denied', statusCode: 403 };
                    return { instanceId: f.instanceId, restoreEpoch: f.state.restoreEpoch };
                } } }); fail = true;
                expect(bound.context.scope).toEqual(f.scope);
                await unchangedResourceFailure(() => next.facade.ncsc.listNcscAssessments(next.context, { limit: 1, afterAssessmentId: null }), 'ncsc_unavailable', 503);
                await loginClean();
            });
            test.each(['membership and binding', 'product', 'advisor service', 'fresh quota'])
            ('final awaited authority check denies %s expiry after business writes', async kind => {
                const cutoff = '2026-09-07T01:00:01.000Z';
                const f = await resourceSetup({ role: kind === 'advisor service' ? 'fractional_advisor' : 'admin', service: kind === 'advisor service',
                    exampleOptions: kind === 'product' ? { grantEndsAt: cutoff } : kind === 'advisor service' ? { serviceEndsAt: cutoff }
                        : kind === 'membership and binding' ? { membershipEndsAt: cutoff } : {} });
                if (kind === 'advisor service') {
                    const snapshot = await f.facade.admission.readAdmissionSnapshot(f.context.scope, f.context.identity);
                    expect(Array.isArray(snapshot.advisorAssignments)).toBe(false);
                    expect(snapshot.advisorAssignments.cyber_security).toMatchObject({ membershipId: f.member.membershipId, subjectKey: NCSC_SUBJECT });
                }
                const quota = createNcscAdapters({ now: () => f.state.now }, { validUntil: cutoff });
                let armed = false, advanced = 0;
                const bound = await f.bindResource({ overrides: {
                    ...(kind === 'fresh quota' ? { resolveSubmissionQuota: quota.resolveSubmissionQuota } : {}),
                    captureRequest: async original => {
                        const captured = await f.options.captureRequest(original);
                        // The receipt marker only arms this fault. DATA performs
                        // its own last access check at the original valid time;
                        // expiry occurs in the guard's later awaited recapture.
                        if (armed) { armed = false; advanced++; f.state.now = cutoff; }
                        return captured;
                    }
                } });
                let command = createCommand();
                if (kind === 'fresh quota') { await bound.facade.ncsc.executeNcscAssessment(bound.context, command);
                    await bound.facade.ncsc.executeNcscAssessment(bound.context, saveCommand()); command = submitCommand(); }
                f.state.hook = event => { if (!advanced && event.phase === 'after' && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts/.test(event.sql)) armed = true; };
                await unchangedResourceFailure(() => bound.facade.ncsc.executeNcscAssessment(bound.context, command), 'ncsc_access_denied', 403);
                expect(advanced).toBe(1); f.state.hook = null; await loginClean();
            });
            test.each(['product', 'advisor service', 'quota'].flatMap(kind => ['before COMMIT', 'after acknowledged COMMIT'].map(boundary => [kind, boundary])))
            ('%s expiry %s preserves actual restricted transaction outcomes', async (kind, boundary) => {
                const cutoff = '2026-09-07T01:00:01.000Z';
                const f = await resourceSetup({ role: kind === 'advisor service' ? 'fractional_advisor' : 'admin', service: kind === 'advisor service',
                    exampleOptions: kind === 'product' ? { grantEndsAt: cutoff } : kind === 'advisor service' ? { serviceEndsAt: cutoff } : {} });
                const quota = createNcscAdapters({ now: () => f.state.now }, { validUntil: cutoff });
                const bound = await f.bindResource({ overrides: kind === 'quota' ? { resolveSubmissionQuota: quota.resolveSubmissionQuota } : {} });
                let command = createCommand();
                if (kind === 'quota') {
                    await bound.facade.ncsc.executeNcscAssessment(bound.context, command);
                    await bound.facade.ncsc.executeNcscAssessment(bound.context, saveCommand()); command = submitCommand();
                }
                const before = await exportAll(), start = f.state.trace.length;
                let marker = null, markers = 0, advanced = 0, commits = 0;
                f.state.hook = e => {
                    if (e.phase === 'after' && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts/.test(e.sql)
                        && JSON.stringify(e.params.slice(0, 4)) === JSON.stringify([f.scope.tenantId, f.scope.organisationId, command.assessmentId, command.idempotencyKey])) {
                        markers++; marker = e.backendPid;
                    }
                    if (e.phase === 'after' && e.sql === 'COMMIT' && marker === e.backendPid) {
                        commits++;
                        if (boundary === 'after acknowledged COMMIT') { advanced++; f.state.now = cutoff; }
                    }
                };
                if (boundary === 'before COMMIT') mockResourceAfterWork = () => {
                    expect(marker).not.toBeNull(); advanced++; f.state.now = cutoff;
                };
                try {
                    await rejectsResourceCode(() => bound.facade.ncsc.executeNcscAssessment(bound.context, command), 'ncsc_access_denied', 403);
                    expect(markers).toBe(1); expect(advanced).toBe(1); expect(Number.isSafeInteger(marker)).toBe(true);
                    const trace = f.state.trace.slice(start).filter(e => e.backendPid === marker);
                    expect(trace.filter(e => e.sql === 'BEGIN')).toHaveLength(1);
                    const after = await exportAll();
                    if (boundary === 'before COMMIT') {
                        expect(commits).toBe(0); expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(0);
                        expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1); expect(after).toEqual(before);
                    } else {
                        expect(commits).toBe(1); expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(0);
                        expect(after.dashboard_ncsc_assessment_receipts).toHaveLength(before.dashboard_ncsc_assessment_receipts.length + 1);
                        expect(after.dashboard_ncsc_assessment_revisions).toHaveLength(before.dashboard_ncsc_assessment_revisions.length + 1);
                        const receipt = after.dashboard_ncsc_assessment_receipts.find(row => row.assessment_id === command.assessmentId && row.idempotency_key === command.idempotencyKey);
                        expect(receipt).toBeDefined(); expect(receipt.payload.result.assessment.revision).toBe(kind === 'quota' ? 2 : 0);
                        const head = after.dashboard_ncsc_assessments.find(row => row.assessment_id === command.assessmentId);
                        expect(head).toMatchObject({ revision: kind === 'quota' ? 2 : 0, payload_sha256: receipt.version_sha256 });
                        expect(receipt.payload.event).toMatchObject({ tenantId: f.scope.tenantId, organisationId: f.scope.organisationId, action: 'assessment.write', result: 'succeeded' });
                        expect(receipt.payload.event.eventId).toBeTruthy(); expect(after.dashboard_runtime_audit).toEqual(before.dashboard_runtime_audit);
                        if (kind === 'quota') {
                            expect(quota.policySelections).toHaveLength(1);
                            expect(after.dashboard_usage.find(row => row.grant_id === 'synthetic-product').payload.counters.assessment_runs).toBe(1);
                            mockResourceAfterWork = null; f.state.hook = null;
                            const replay = await f.bindResource({ overrides: { resolveSubmissionQuota: () => { throw new Error('Fresh quota forbidden during receipt replay'); } } });
                            expect(await replay.facade.ncsc.executeNcscAssessment(replay.context, command)).toEqual(receipt.payload.result);
                            expect(await exportAll()).toEqual(after);
                        }
                    }
                } finally { mockResourceAfterWork = null; f.state.hook = null; }
                await loginClean();
            });
            test.each(['healthy application refusal', 'already aborted SQL'])
            ('cleanup resets only the local timeout and restores the restricted connection after %s', async variant => {
                const resetSql = 'SET LOCAL statement_timeout = 0';
                const settingsSql = `SELECT current_user AS role, session_user AS login,
                    current_setting('statement_timeout') AS statement_timeout,
                    COALESCE(current_setting('nofries.tenant_id',true),'') AS tenant_id,
                    COALESCE(current_setting('nofries.organisation_id',true),'') AS organisation_id,
                    COALESCE(current_setting('nofries.session_sha256',true),'') AS session_sha256,
                    COALESCE(current_setting('nofries.subject_key',true),'') AS subject_key,
                    COALESCE(current_setting('nofries.identity_sha256',true),'') AS identity_sha256,
                    COALESCE(current_setting('nofries.runtime_instance_id',true),'') AS runtime_instance_id,
                    COALESCE(current_setting('nofries.request_id',true),'') AS request_id`;
                const cutoff = '2026-09-07T01:00:01.000Z', observed = { markers: 0, cleanup: [], errors: [], releases: [] };
                const command = createCommand(); let active = false, f;
                const observedPool = { end: () => runtimePool.end(), async connect() {
                    const client = await runtimePool.connect();
                    return { processID: client.processID, async query(sql, params) {
                        const cleanup = active && observed.backendPid === client.processID && (sql === resetSql || sql === 'ROLLBACK');
                        if (cleanup) observed.cleanup.push({ sql, phase: 'before', params: clone(params || []) });
                        if (cleanup && sql === 'ROLLBACK' && variant === 'healthy application refusal') {
                            observed.resetTimeout = (await client.query('SHOW statement_timeout')).rows[0].statement_timeout;
                        }
                        let result;
                        try { result = await client.query(sql, params); }
                        catch (error) {
                            if (cleanup) observed.errors.push({ sql, code: error.code, backendPid: client.processID });
                            throw error;
                        }
                        if (cleanup) {
                            observed.cleanup.push({ sql, phase: 'after' });
                            if (sql === 'ROLLBACK') observed.restored = (await client.query(settingsSql)).rows[0];
                        }
                        if (active && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts\b/.test(sql)
                            && JSON.stringify(params.slice(0, 4)) === JSON.stringify([f.scope.tenantId, f.scope.organisationId, command.assessmentId, command.idempotencyKey])) {
                            observed.markers++; observed.backendPid = client.processID;
                            observed.inTransaction = (await client.query(settingsSql)).rows[0];
                            if (variant === 'already aborted SQL') {
                                // This is a real server error in the current restricted transaction,
                                // not a thrown substitute for SQLSTATE 22012 or 25P02.
                                try { await client.query('SELECT 1 / 0'); }
                                catch (error) { observed.errors.push({ sql: 'SELECT 1 / 0', code: error.code, backendPid: client.processID }); throw error; }
                                throw new Error('The real division-by-zero control unexpectedly succeeded');
                            }
                        }
                        return result;
                    }, release(discard) {
                        if (active && observed.backendPid === client.processID) observed.releases.push({ discard, rollbackSettled: Boolean(observed.restored) });
                        client.release(discard);
                    } };
                } };
                try {
                    f = await resourceSetup({ rawRuntimePool: observedPool, exampleOptions: { grantEndsAt: cutoff } });
                    const bound = await f.bindResource({ selectedSeed: { ...f.seed, deadline: '2026-09-07T01:00:02.000Z' } });
                    const baselineClient = await runtimePool.connect(); let baseline, baselinePid;
                    try { baselinePid = baselineClient.processID; baseline = (await baselineClient.query(settingsSql)).rows[0]; }
                    finally { baselineClient.release(); }
                    const before = await exportAll(), boundary = f.state.trace.length, borrows = f.state.borrows;
                    active = true;
                    if (variant === 'healthy application refusal') mockResourceAfterWork = () => {
                        expect(observed.markers).toBe(1); f.state.now = cutoff;
                    };
                    await rejectsResourceCode(() => bound.facade.ncsc.executeNcscAssessment(bound.context, command),
                        variant === 'healthy application refusal' ? 'ncsc_access_denied' : 'ncsc_unavailable',
                        variant === 'healthy application refusal' ? 403 : 503);
                    expect(observed.markers).toBe(1); expect(observed.backendPid).toBe(baselinePid);
                    expect(observed.inTransaction).toMatchObject({ role: 'nofries_runtime', login: runtimeRole,
                        tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId });
                    expect(observed.inTransaction.statement_timeout).not.toBe('0');
                    expect(observed.cleanup.filter(e => e.phase === 'before')).toEqual([
                        { sql: resetSql, phase: 'before', params: [] }, { sql: 'ROLLBACK', phase: 'before', params: [] }]);
                    expect(observed.cleanup.at(-1)).toEqual({ sql: 'ROLLBACK', phase: 'after' });
                    if (variant === 'healthy application refusal') {
                        expect(observed.errors).toEqual([]); expect(observed.resetTimeout).toBe('0');
                        expect(observed.cleanup.filter(e => e.sql === resetSql && e.phase === 'after')).toHaveLength(1);
                    } else {
                        expect(observed.errors).toEqual([
                            { sql: 'SELECT 1 / 0', code: '22012', backendPid: baselinePid },
                            { sql: resetSql, code: '25P02', backendPid: baselinePid }]);
                        expect(observed.cleanup.filter(e => e.sql === resetSql && e.phase === 'after')).toHaveLength(0);
                    }
                    expect(observed.restored).toEqual(baseline);
                    expect(observed.releases).toEqual([{ discard: false, rollbackSettled: true }]);
                    const trace = f.state.trace.slice(boundary);
                    expect(trace.filter(e => e.sql === 'BEGIN')).toHaveLength(1);
                    expect(trace.filter(e => e.sql === 'COMMIT')).toHaveLength(0);
                    expect(trace.filter(e => e.sql === 'ROLLBACK')).toHaveLength(1);
                    expect(f.state.borrows - borrows).toBe(1); expect(f.state.borrows).toBe(f.state.releases);
                    expect(await exportAll()).toEqual(before); await loginClean();
                } finally { active = false; mockResourceAfterWork = null; if (f) f.state.hook = null; }
            });
            test('remaining request lifetime cancels an actual restricted fence wait before holder release', async () => {
                const url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const { Pool } = require('pg'), parallel = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                    application_name: `resource-timeout-${runKey}` }), closeParallel = trackPoolClientEnds(parallel);
                const sqlErrors = [], waiter = gate(); let f, holder, operation, holderReleased = false;
                const observedPool = { end: () => parallel.end(), async connect() {
                    const client = await parallel.connect();
                    return { processID: client.processID, async query(...args) {
                        try { return await client.query(...args); }
                        catch (error) { if (error.code === '57014') sqlErrors.push({ code: error.code, sql: args[0], backendPid: client.processID, holderReleased }); throw error; }
                    }, release: discard => client.release(discard) };
                } };
                try {
                    f = await resourceSetup({ rawRuntimePool: observedPool });
                    const deadline = new Date(Date.parse(f.state.now) + 1200).toISOString();
                    const bound = await f.bindResource({ selectedSeed: { ...f.seed, deadline } });
                    const before = await exportAll();
                    holder = await parallel.connect(); await holder.query('BEGIN');
                    await holder.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))', [71001, f.seed.sessionSha256]);
                    let waiterPid;
                    f.state.hook = e => { if (e.phase === 'before' && /pg_advisory_xact_lock_shared/.test(e.sql)
                        && Number(e.params[0]) === 71001) { waiterPid = e.backendPid; waiter.resolve(); } };
                    operation = settled(bound.facade.ncsc.executeNcscAssessment(bound.context, createCommand()));
                    await waiter.promise; expect(waiterPid).not.toBe(holder.processID); await actualBlockedBy(waiterPid, holder.processID);
                    const timeout = gate(5000), outcome = await Promise.race([operation, timeout.promise]); timeout.resolve();
                    expectResourceError(outcome.error, 'ncsc_unavailable', 503);
                    expect(sqlErrors).toHaveLength(1);
                    expect(sqlErrors[0]).toMatchObject({ code: '57014', backendPid: waiterPid, holderReleased: false });
                    expect(sqlErrors[0].sql).toMatch(/pg_advisory_xact_lock_shared/);
                    expect(await exportAll()).toEqual(before); f.state.hook = null;
                } finally {
                    waiter.resolve();
                    try {
                        if (holder) {
                            let discard = false;
                            try { await holder.query('ROLLBACK'); }
                            catch (error) { discard = true; throw error; }
                            finally { holderReleased = true; holder.release(discard); }
                        }
                    } finally {
                        if (f) f.state.hook = null;
                        try { if (operation) await operation; }
                        finally { await closeParallel(); }
                    }
                }
            });
            test('committed submission replay remains exact after its original quota policy expires and never reselects quota', async () => {
                const f = await resourceSetup(), quota = createNcscAdapters({ now: () => f.state.now }, { validUntil: '2026-09-07T01:00:01.000Z' });
                const bound = await f.bindResource({ overrides: { resolveSubmissionQuota: quota.resolveSubmissionQuota } });
                await bound.facade.ncsc.executeNcscAssessment(bound.context, createCommand()); await bound.facade.ncsc.executeNcscAssessment(bound.context, saveCommand());
                const command = submitCommand(), original = await bound.facade.ncsc.executeNcscAssessment(bound.context, command);
                f.state.now = '2026-09-07T01:00:02.000Z';
                const replay = await f.bindResource({ overrides: { resolveSubmissionQuota: () => { throw new Error('Replay must not select a new policy'); } } });
                const before = await exportAll();
                expect(await replay.facade.ncsc.executeNcscAssessment(replay.context, command)).toEqual(original);
                expect(await exportAll()).toEqual(before); expect(quota.policySelections).toHaveLength(1);
            });
            test.each(['lost response', 'absent commit', 'late known commit', 'recovery denial', 'exhausted recovery'])
            ('%s targets only the exact NCSC receipt transaction and preserves original recovery semantics', async variant => {
                const f = await resourceSetup(); let command = createCommand(), quota;
                if (variant === 'lost response') {
                    await f.facade.ncsc.executeNcscAssessment(f.context, command);
                    await f.facade.ncsc.executeNcscAssessment(f.context, saveCommand()); command = submitCommand();
                    quota = createNcscAdapters({ now: () => f.state.now }, { validUntil: '2026-09-07T01:00:01.000Z' });
                    f.resourceOptions.resolveSubmissionQuota = quota.resolveSubmissionQuota;
                }
                const before = await exportAll();
                const phase = variant === 'absent commit' ? 'before' : 'after';
                const observed = ncscCommitFault(f, command, phase, async () => {
                    if (variant === 'lost response') f.state.now = '2026-09-07T01:00:02.000Z';
                    if (variant === 'late known commit' || variant === 'exhausted recovery') f.state.now = '2026-09-07T01:01:00.000Z';
                    if (variant === 'recovery denial') { const old = f.registry.get(f.original); f.registry.set(f.original, { ...old, identityPayload: { ...old.identityPayload, policyRevision: 2 } }); }
                    if (variant !== 'late known commit') throw new Error('Synthetic target COMMIT response failure');
                });
                Object.assign(f, await f.bindResource());
                const outcome = await settled(f.facade.ncsc.executeNcscAssessment(f.context, command));
                expect(observed.unarmedCommits).toBe(1);
                expect(observed.marker.transaction).toBe(2);
                expect(observed.markers).toBe(1); expect(observed.faults).toBe(1); expect(observed.marker).toEqual(observed.fault);
                expect(Number.isSafeInteger(observed.marker.backendPid)).toBe(true);
                expect(observed.recovery.filter(sql => /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+nofries\./i.test(sql))).toEqual([]);
                const after = await exportAll();
                if (variant === 'lost response') {
                    expect(outcome.value).toMatchObject({ action: 'submit', assessment: { revision: 2, status: 'submitted' } });
                    expect(after.dashboard_ncsc_assessment_receipts).toHaveLength(3);
                    expect(observed.recovery.filter(sql => sql === 'BEGIN')).toHaveLength(1);
                    expect(quota.policySelections).toHaveLength(1);
                    expect(after.dashboard_usage.find(row => row.grant_id === 'synthetic-product').payload.counters.assessment_runs).toBe(1);
                } else {
                    const code = ['absent commit', 'exhausted recovery'].includes(variant) ? 'ncsc_outcome_ambiguous' : variant === 'recovery denial' ? 'ncsc_access_denied' : 'ncsc_unavailable';
                    expectResourceError(outcome.error, code, variant === 'recovery denial' ? 403 : 503);
                    if (variant === 'absent commit') expect(after).toEqual(before);
                    else expect(after.dashboard_ncsc_assessment_receipts).toHaveLength(1);
                    if (variant === 'exhausted recovery') expect(observed.recovery.filter(sql => sql === 'BEGIN')).toHaveLength(0);
                }
                f.state.hook = null; await loginClean();
                if (variant === 'late known commit' || variant === 'lost response') {
                    const retry = await f.bindResource({ overrides: { resolveSubmissionQuota: () => { throw new Error('Replay cannot select quota'); } } }), stable = await exportAll();
                    expect((await retry.facade.ncsc.executeNcscAssessment(retry.context, command)).assessment.revision).toBe(variant === 'lost response' ? 2 : 0);
                    expect(await exportAll()).toEqual(stable);
                }
            });
            test.each(['fresh valid but no committed receipt', 'fresh denied'])
            ('failed rollback after private denial preserves %s recovery classification', async variant => {
                const f = await resourceSetup(), originalCapture = clone(f.registry.get(f.original)), before = await exportAll();
                let denied = false, failedRollback = false;
                f.state.hook = event => {
                    if (!denied && event.phase === 'after' && /INSERT INTO nofries\.dashboard_ncsc_assessment_receipts/.test(event.sql)) {
                        denied = true; f.registry.set(f.original, { ...originalCapture, identityPayload: { ...originalCapture.identityPayload, policyRevision: 2 } });
                    }
                    // The actual rollback reaches PostgreSQL and settles before
                    // its response is hidden. The helper discards that client;
                    // a fresh real transaction must not inherit its denial latch.
                    if (denied && !failedRollback && event.phase === 'after' && event.sql === 'ROLLBACK') {
                        failedRollback = true;
                        if (variant === 'fresh valid but no committed receipt') f.registry.set(f.original, originalCapture);
                        throw new Error('Synthetic lost rollback acknowledgement');
                    }
                };
                await rejectsResourceCode(() => f.facade.ncsc.executeNcscAssessment(f.context, createCommand()),
                    variant === 'fresh denied' ? 'ncsc_access_denied' : 'ncsc_outcome_ambiguous', variant === 'fresh denied' ? 403 : 503);
                expect(denied).toBe(true); expect(failedRollback).toBe(true); expect(await exportAll()).toEqual(before);
                f.state.hook = null; await loginClean();
            });
        });

        test('has all ten forced-RLS nonowner tables without seeded runtime admission', async () => {
            const result = await ownerPool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nofries' AND c.relname=ANY($1::text[])`, [RUNTIME_TABLES]);
            expect(result.rows).toHaveLength(10);
            for (const row of result.rows) { expect(row.relrowsecurity).toBe(true); expect(row.relforcerowsecurity).toBe(true);
                expect(['nofries_runtime', 'nofries_dashboard_maintenance', runtimeRole, maintenanceRole]).not.toContain(row.owner); }
            expect(await rows('dashboard_runtime_instance', 'instance_id', fixture.instanceId)).toEqual([]);
            expect((await ownerPool.query('SELECT count(*)::integer AS n FROM nofries.dashboard_admission_authorities')).rows[0].n).toBe(0);
        });

        describe('I ordinary operator logout with genuine parent capture', () => {
            // Only identity-provider protocol, original parent/proof storage and
            // time are synthetic. The callback, capture, logout composition and
            // restricted PostgreSQL repository are the genuine public factories.
            async function operatorLogoutSetup({ presentGate = false, proofless = false, rawRuntimePool = runtimePool } = {}) {
                const { createBrowserAuthService } = require('../../api/shared/browserAuth');
                const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
                const { createDashboardOperatorSession } = require('../../api/shared/dashboardOperatorSession');
                const { createDashboardOperatorLogoutService } = require('../../api/shared/dashboardOperatorLogout');
                const tenant = nextId(), client = nextId(), oid = nextId();
                const principal = { policyId: 'synthetic-logout-policy', policyRevision: 0,
                    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, identityTenantId: tenant, audience: client, oid };
                const f = harness({ rawRuntimePool, resourceIdentity: principal }); fixture = f;
                const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
                    NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ENTRA_CLIENT_ID: client,
                    NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-logout-test-secret', NOFRIES_ALLOWED_SUBJECTS: `${tenant}:${oid}` };
                const store = new MemoryBrowserSessionStore(), proofs = new Map(), operations = [];
                const deletion = { attempts: 0, beforeDelete: null };
                const remove = store.deleteSession.bind(store);
                store.deleteSession = jest.fn(async id => {
                    deletion.attempts++;
                    if (deletion.beforeDelete) await deletion.beforeDelete(id);
                    await remove(id);
                });
                const clientApplication = {
                    getAuthCodeUrl: async params => {
                        const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
                        for (const [key, value] of Object.entries({ client_id: client, redirect_uri: params.redirectUri,
                            response_mode: 'form_post', state: params.state, nonce: params.nonce,
                            code_challenge: params.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
                        return url.href;
                    },
                    acquireTokenByCode: async params => ({ idTokenClaims: { aud: client, tid: tenant, oid,
                        iss: principal.issuer, nonce: params.nonce, exp: Math.floor(Date.parse(f.state.now) / 1000) + 3600,
                        name: 'Synthetic logout operator', preferred_username: 'logout@example.invalid' },
                    account: { localAccountId: oid, tenantId: tenant },
                    accessToken: 'synthetic-unpersisted-access', idToken: 'synthetic-unpersisted-id' }),
                    getTokenCache: () => ({ removeAccount: async () => {} })
                };
                const browserAuthOptions = { env, store, clientApplication,
                    cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
                    randomBytes: size => crypto.randomBytes(size) };
                const original = createBrowserAuthService({ ...browserAuthOptions, now: () => Date.parse(f.state.now) });
                const { oid: ignoredSubject, ...identityPolicy } = principal;
                const adapter = createDashboardOperatorSession({ browserAuthOptions, identityPolicy,
                    proofStore: {
                        async createOriginalProof(key, record) {
                            if (proofs.has(key)) throw new Error('synthetic original proof collision');
                            proofs.set(key, clone(record));
                        },
                        readOriginalProof: async key => proofs.has(key) ? clone(proofs.get(key)) : null
                    }, clock: f.options.clock, readExternalRuntimeEpoch: f.options.readExternalRuntimeEpoch,
                    newRequestId: nextId, requestBudgetMs: 60000 });
                const started = await original.beginLogin({ returnTo: '/portal' });
                const login = await (proofless && !presentGate ? original : adapter.callbackService).completeLogin({
                    body: { code: 'synthetic-login', state: new URL(started.location).searchParams.get('state') },
                    cookieHeader: started.cookie.split(';')[0] });
                const cookieHeader = login.cookie.split(';')[0], parentId = cookieHeader.split('=')[1];
                const retainedParent = clone(store.sessions.get(parentId));
                const request = () => Object.freeze({ headers: Object.freeze({ cookie: cookieHeader }) });
                const capture = await adapter.captureRequest(request());
                const repository = instantiate({ ...f.options, captureRequest: adapter.captureRequest });
                const initial = await f.maintenance.initializeRuntimeInstance(f.instanceCommand());
                await f.maintenance.enableRuntimeIngress(f.instanceCommand(initial.record));
                if (presentGate) await repository.initializeOperatorSession(request(), { operationId: nextId() });
                if (proofless) proofs.delete(capture.sessionSha256);
                const { captureRequest: ignoredCapture, ...runtimeOptions } = f.options;
                const service = createDashboardOperatorLogoutService({ browserAuthOptions,
                    captureRequest: adapter.captureRequest, runtimeOptions,
                    newOperationId: () => { const operationId = nextId(); operations.push(operationId); return operationId; } });
                const invoke = () => service.logout({ cookieHeader, returnTo: '/portal?signedOut=1' });
                return { f, store, proofs, deletion, operations, adapter, capture, parentId, retainedParent,
                    request, repository, invoke };
            }
            function logoutResult(value) {
                expect(Object.keys(value).sort()).toEqual(['cookie', 'location']);
                expect(value.location).toBe('/portal?signedOut=1');
                expect(value.cookie).toMatch(/^__Host-nofries-auth=;/);
                expect(value.cookie).toContain('Max-Age=0');
            }
            function logoutFailure(error) {
                const { BrowserAuthError } = require('../../api/shared/browserAuth');
                expect(error).toBeInstanceOf(BrowserAuthError); expect(error.statusCode).toBe(503);
                expect(error.message).not.toMatch(/synthetic|driver|COMMIT|SQL|private/);
            }
            async function persistedLogout(h, operationId) {
                const gates = await rows('dashboard_session_gates', 'session_sha256', h.capture.sessionSha256);
                const receipts = await rows('dashboard_runtime_receipts', 'operation_id', operationId);
                const audits = await rows('dashboard_runtime_audit', 'operation_id', operationId);
                expect(gates).toHaveLength(1); expect(gates[0].status).toBe('revoked');
                expect(receipts).toHaveLength(1); expect(audits).toHaveLength(1);
                expect(receipts[0]).toMatchObject({ operation_type: 'revokeSession', anchor_session_sha256: h.capture.sessionSha256,
                    audit_event_id: audits[0].event_id });
                expect(receipts[0].payload.result.record.status).toBe('revoked');
                expect(audits[0]).toMatchObject({ session_sha256: h.capture.sessionSha256,
                    payload: { action: 'revokeSession', outcome: 'succeeded', operationId } });
                return gates[0];
            }
            async function noResurrection(h) {
                // Restoring this exact synthetic original parent simulates a
                // delayed browser-store reader; only the permanent SQL gate may
                // decide whether its still-valid original proof can initialize.
                h.store.sessions.set(h.parentId, clone(h.retainedParent));
                const before = await exportAll();
                await rejectsCode(() => h.repository.initializeOperatorSession(h.request(), { operationId: nextId() }),
                    'onboarding_access_denied', 403);
                expect(await exportAll()).toEqual(before);
            }

            test.each([false, true].flatMap(presentGate => [false, true].map(proofless => [presentGate, proofless])))
            ('IP01 ordinary logout with present gate=%s and proofless parent=%s commits before parent deletion', async (presentGate, proofless) => {
                const h = await operatorLogoutSetup({ presentGate, proofless }); let observed = false;
                h.deletion.beforeDelete = async () => {
                    observed = true; expect(h.store.sessions.has(h.parentId)).toBe(true);
                    const retained = await persistedLogout(h, h.operations[0]);
                    expect(retained.revision).toBe(presentGate ? 1 : 0);
                    expect(retained.operator_issuance_sha256).toBe(presentGate ? hash(h.capture.operatorIssuanceProof) : null);
                    expect(h.f.state.trace.at(-1).sql).toBe('COMMIT');
                };
                logoutResult(await h.invoke()); expect(observed).toBe(true);
                expect(h.store.deleteSession).toHaveBeenCalledTimes(1); expect(h.store.sessions.has(h.parentId)).toBe(false);
                expect(h.operations).toHaveLength(1); await noResurrection(h); await loginClean();
            });

            test.each([false, true])('IP02 pending real SQL with failed audit=%s cannot explicitly delete the parent', async fail => {
                const h = await operatorLogoutSetup(), before = await exportAll(), held = gate(), release = gate(0);
                let pending, intercepted = false;
                h.f.state.hook = async event => {
                    if (!intercepted && event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)
                        && event.params.includes(h.operations[0])) {
                        intercepted = true; held.resolve(); await release.promise;
                        if (fail) throw new Error('synthetic private audit acknowledgement failure');
                    }
                };
                try {
                    pending = settled(h.invoke()); await timingPhase(held, pending);
                    expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.store.sessions.has(h.parentId)).toBe(true);
                    expect(await exportAll()).toEqual(before); release.resolve();
                    const result = await pending; expect(intercepted).toBe(true);
                    if (fail) {
                        logoutFailure(result.error); expect(h.store.deleteSession).not.toHaveBeenCalled();
                        expect(h.store.sessions.has(h.parentId)).toBe(true); expect(await exportAll()).toEqual(before);
                        expect(h.f.state.trace.at(-1).sql).toBe('ROLLBACK');
                    } else { logoutResult(result.value); await persistedLogout(h, h.operations[0]); }
                } finally { release.resolve(); held.resolve(); if (pending) await pending; h.f.state.hook = null; }
            });

            test.each(['before', 'after'])('IP03 lost COMMIT at %s uses the actual receipt reconciliation before cleanup', async phase => {
                const h = await operatorLogoutSetup(), before = await exportAll();
                // The operation ID is server-generated only once invocation has
                // read its valid parent. Arm against that actual ID, not a
                // substituted operation or a fabricated successful receipt.
                let faulted = false, marked = false, faultBoundary = null;
                h.deletion.beforeDelete = () => {
                    expect(faulted).toBe(true);
                    expect(h.f.state.trace.slice(faultBoundary).some(event => /FROM nofries\.dashboard_runtime_receipts\b/.test(event.sql))).toBe(true);
                    expect(h.f.state.trace.at(-1).sql).toBe('COMMIT');
                };
                h.f.state.hook = event => {
                    if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_receipts\b/.test(event.sql)
                        && event.params.includes(h.operations[0])) marked = true;
                    if (!faulted && marked && event.sql === 'COMMIT' && event.phase === phase) {
                        faulted = true; faultBoundary = h.f.state.trace.length;
                        expect(h.store.deleteSession).not.toHaveBeenCalled(); expect(h.store.sessions.has(h.parentId)).toBe(true);
                        throw new Error('synthetic driver lost COMMIT acknowledgement');
                    }
                };
                const result = await settled(h.invoke()); h.f.state.hook = null;
                expect(marked).toBe(true); expect(faulted).toBe(true); expect(h.operations).toHaveLength(1);
                const recovery = h.f.state.trace.slice(faultBoundary);
                expect(recovery.filter(event => event.sql === 'BEGIN')).toHaveLength(1);
                expect(recovery.filter(event => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(event.sql))).toEqual([]);
                expect(recovery.some(event => /FROM nofries\.dashboard_runtime_receipts\b/.test(event.sql))).toBe(true);
                if (phase === 'after') {
                    logoutResult(result.value); await persistedLogout(h, h.operations[0]);
                    expect(h.store.deleteSession).toHaveBeenCalledTimes(1); expect(h.store.sessions.has(h.parentId)).toBe(false);
                    await noResurrection(h);
                } else {
                    logoutFailure(result.error); expect(h.store.deleteSession).not.toHaveBeenCalled();
                    expect(h.store.sessions.has(h.parentId)).toBe(true); expect(await exportAll()).toEqual(before);
                }
            });

            test('IP04 committed tombstone survives parent-delete failure and a fresh retry only finishes cleanup', async () => {
                const h = await operatorLogoutSetup(); let retained;
                h.deletion.beforeDelete = async () => {
                    retained = await persistedLogout(h, h.operations[0]);
                    if (h.deletion.attempts === 1) throw new Error('synthetic browser store delete failure');
                };
                logoutFailure((await settled(h.invoke())).error);
                expect(h.store.sessions.has(h.parentId)).toBe(true); expect(h.store.deleteSession).toHaveBeenCalledTimes(1);
                const first = await persistedLogout(h, h.operations[0]); expect(first).toEqual(retained);
                logoutResult(await h.invoke()); expect(h.store.sessions.has(h.parentId)).toBe(false);
                expect(h.store.deleteSession).toHaveBeenCalledTimes(2); expect(h.operations).toHaveLength(2);
                expect(h.operations[1]).not.toBe(h.operations[0]);
                expect(await persistedLogout(h, h.operations[1])).toEqual(first);
                await persistedLogout(h, h.operations[0]); await noResurrection(h);
            });

            test.each(['initialize first', 'logout first'])('IP05 absent-gate %s uses two actual SQL lock contenders and never resurrects', async order => {
                const url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const { Pool } = require('pg'), parallel = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                    application_name: `operator-logout-lock-${runKey}` }), closeParallel = trackPoolClientEnds(parallel);
                const held = gate(), release = gate(0), waiter = gate(); let initializePromise, logoutPromise, h;
                try {
                    h = await operatorLogoutSetup({ rawRuntimePool: parallel }); let holderPid, waiterPid;
                    const initializeOperation = nextId();
                    const exclusiveSession = event => /^SELECT pg_advisory_xact_lock\(\$1::integer, hashtext\(\$2\)\)$/.test(event.sql)
                        && Number(event.params[0]) === 71001 && event.params[1] === h.capture.sessionSha256;
                    h.f.state.hook = async event => {
                        if (!holderPid && event.phase === 'after' && exclusiveSession(event)) {
                            holderPid = event.backendPid; held.resolve(); await release.promise;
                        }
                        if (holderPid && event.backendPid !== holderPid && event.phase === 'before' && exclusiveSession(event)) {
                            waiterPid = event.backendPid; waiter.resolve();
                        }
                    };
                    const initialize = () => settled(h.repository.initializeOperatorSession(h.request(), { operationId: initializeOperation }));
                    if (order === 'initialize first') { initializePromise = initialize(); await timingPhase(held, initializePromise); logoutPromise = settled(h.invoke()); }
                    else { logoutPromise = settled(h.invoke()); await timingPhase(held, logoutPromise); initializePromise = initialize(); }
                    await timingPhase(waiter, order === 'initialize first' ? logoutPromise : initializePromise);
                    expect(waiterPid).not.toBe(holderPid); await actualBlockedBy(waiterPid, holderPid);
                    expect(h.store.deleteSession).not.toHaveBeenCalled(); release.resolve();
                    const [initialized, loggedOut] = await Promise.all([initializePromise, logoutPromise]);
                    logoutResult(loggedOut.value);
                    if (order === 'initialize first') expect(initialized.value.record.status).toBe('active');
                    else expectError(initialized.error, 'onboarding_access_denied', 403);
                    h.f.state.hook = null;
                    const tombstone = await persistedLogout(h, h.operations[0]);
                    expect(tombstone.revision).toBe(order === 'initialize first' ? 1 : 0);
                    expect(await rows('dashboard_runtime_receipts', 'operation_id', initializeOperation))
                        .toHaveLength(order === 'initialize first' ? 1 : 0);
                    expect(h.store.deleteSession).toHaveBeenCalledTimes(1); expect(h.store.sessions.has(h.parentId)).toBe(false);
                    await noResurrection(h);
                } finally {
                    release.resolve(); held.resolve(); waiter.resolve();
                    await Promise.all([initializePromise, logoutPromise].filter(Boolean));
                    if (h) h.f.state.hook = null; await closeParallel();
                }
            });
        });

        describe('J installed internal dashboard HTTP journey', () => {
            const http = require('supertest');
            const origin = 'https://nofries.invalid';
            const generationHeader = 'X-NoFries-Dashboard-Generation';

            beforeEach(() => require('../../api/shared/abuseProtection').resetAbuseProtectionForTests());

            // The only doubles here are trusted OIDC/PKCE, time and durable
            // parent/proof providers. Every HTTP request uses the actual server
            // constructor and its genuine H/I/repository/resource composition.
            // Administration below is explicit synthetic setup, never a route.
            async function httpSetup({ rawRuntimePool = runtimePool, base = null, principal: suppliedPrincipal = null,
                requestBudgetMs = 60000, publish = true, prepareCanonical = null, ncsc = null, membershipValidUntil = END,
                customerProvider = false, improvementEnabled = false,
                appFactory = options => require('../../server').createNoFriesApp(options) } = {}) {
                const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
                const tenant = base ? base.operatorIdentity.identityTenantId : nextId();
                const client = base ? base.operatorIdentity.audience : nextId();
                const staffPrincipal = suppliedPrincipal || { policyId: 'synthetic-http-policy', policyRevision: 0,
                    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, identityTenantId: tenant,
                    audience: client, oid: nextId() };
                const customerTenant = customerProvider ? nextId() : null;
                const externalProfile = customerProvider ? { kind: 'external-id', tenantId: customerTenant, clientId: nextId(),
                    authority: 'https://synthetic-http.ciamlogin.com/',
                    issuer: `https://${customerTenant}.ciamlogin.com/${customerTenant}/v2.0`,
                    authorizationEndpoint: `https://synthetic-http.ciamlogin.com/${customerTenant}/oauth2/v2.0/authorize` } : null;
                const principal = externalProfile ? { policyId: 'synthetic-external-http-policy', policyRevision: 0,
                    issuer: externalProfile.issuer, identityTenantId: customerTenant, audience: externalProfile.clientId, oid: nextId() } : staffPrincipal;
                const coexist = customerProvider === 'coexist';
                const legacyPrincipal = coexist ? { ...staffPrincipal, audience: nextId(), oid: nextId() } : null;
                const externalCallback = coexist ? '/external-customer-auth/callback' : '/customer-auth/callback';
                const f = base || harness({ rawRuntimePool, resourceIdentity: principal }); fixture = f;
                if (!base) await f.initialize();
                const state = { now: NOW, beforeLoad: null, beforeProof: null, beforeDelete: null,
                    parentLoads: 0, proofReads: 0, deletes: 0, operations: [] };
                const store = new MemoryBrowserSessionStore(), proofs = new Map();
                const load = store.loadSession.bind(store), remove = store.deleteSession.bind(store);
                store.loadSession = jest.fn(async id => {
                    state.parentLoads++;
                    if (state.beforeLoad) await state.beforeLoad(id);
                    return load(id);
                });
                store.deleteSession = jest.fn(async id => {
                    state.deletes++;
                    if (state.beforeDelete) await state.beforeDelete(id);
                    return remove(id);
                });
                const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: origin,
                    NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ENTRA_CLIENT_ID: client,
                    NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-http-provider-only',
                    NOFRIES_ALLOWED_SUBJECTS: subject(staffPrincipal),
                    ...(externalProfile ? { NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: coexist ? legacyPrincipal.audience : externalProfile.clientId,
                        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-external-provider-only' } : {}) };
                const browserAuthOptions = { env, store, clientApplication: {
                    getAuthCodeUrl: async params => {
                        const customer = externalProfile && params.redirectUri.endsWith(externalCallback);
                        const selectedClient = coexist && params.redirectUri.endsWith('/customer-auth/callback') ? legacyPrincipal.audience : client;
                        const url = new URL(customer ? externalProfile.authorizationEndpoint : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
                        for (const [key, value] of Object.entries({ client_id: customer ? principal.audience : selectedClient, redirect_uri: params.redirectUri,
                            response_mode: 'form_post', state: params.state, nonce: params.nonce,
                            code_challenge: params.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
                        return url.href;
                    },
                    acquireTokenByCode: async params => {
                        const selected = externalProfile && params.redirectUri.endsWith(externalCallback) ? principal :
                            coexist && params.redirectUri.endsWith('/customer-auth/callback') ? legacyPrincipal : staffPrincipal;
                        return { idTokenClaims: { aud: selected.audience, tid: selected.identityTenantId, oid: selected.oid,
                        iss: selected.issuer, nonce: params.nonce, exp: Math.floor(Date.parse(state.now) / 1000) + 3600,
                        name: 'Synthetic HTTP operator', preferred_username: 'http@example.invalid' },
                        account: { localAccountId: selected.oid, tenantId: selected.identityTenantId },
                        accessToken: 'synthetic-unpersisted-access', idToken: 'synthetic-unpersisted-id' };
                    },
                    getTokenCache: () => ({ removeAccount: async () => {} })
                }, cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
                randomBytes: size => crypto.randomBytes(size) };
                const { oid: ignoredOid, ...identityPolicy } = staffPrincipal;
                const dashboard = { browserAuthOptions, identityPolicy, proofStore: {
                    async createOriginalProof(key, record) {
                        if (proofs.has(key)) throw new Error('synthetic conditional proof collision');
                        proofs.set(key, clone(record));
                    },
                    async readOriginalProof(key) {
                        state.proofReads++;
                        if (state.beforeProof) await state.beforeProof(key);
                        return proofs.has(key) ? clone(proofs.get(key)) : null;
                    }
                }, clock: () => state.now, readExternalRuntimeEpoch: f.options.readExternalRuntimeEpoch,
                newRequestId: nextId, requestBudgetMs, pool: f.restrictedPool, instanceId: f.instanceId,
                historyBudget: clone(BUDGET), newId: f.options.newId, newGenerationToken: f.options.newGenerationToken,
                newOperationId: () => { const value = nextId(); state.operations.push(value); return value; } };
                if (ncsc) dashboard.ncsc = ncsc;
                if (improvementEnabled) dashboard.improvementEnabled = true;
                if (externalProfile) {
                    const { oid: customerOid, ...customerIdentityPolicy } = principal;
                    // Explicit pre-admitted synthetic contract. This does not
                    // implement real provider signup, mailbox proof or MFA.
                    const requireSubject = identity => {
                        if (identity.subjectKey !== subject(principal)) throw new Error('synthetic subject not admitted');
                    };
                    dashboard.customer = { identityProvider: externalProfile, identityPolicy: customerIdentityPolicy,
                        policy: {
                            async begin() { return { context: { kind: 'synthetic-pre-admission' } }; },
                            async verify({ identity }) { requireSubject(identity); return { subjectKey: identity.subjectKey,
                                expiresAt: Date.parse(state.now) + 3600000 }; },
                            async recheck({ identity, assurance }) { requireSubject(identity);
                                if (assurance.subjectKey !== identity.subjectKey) throw new Error('synthetic assurance mismatch'); }
                        },
                        async resolveActivationBinding() { return { bindingId: h.binding.bindingId, scope: clone(h.binding.scope) }; }
                    };
                    if (coexist) {
                        dashboard.externalCustomer = { ...dashboard.customer,
                            client: { clientSecret: 'synthetic-external-provider-only', clientApplication: browserAuthOptions.clientApplication } };
                        dashboard.customer = {
                            policy: {
                                async begin() { return { context: { kind: 'synthetic-legacy-pre-admission' } }; },
                                async verify({ identity }) {
                                    if (identity.subjectKey !== subject(legacyPrincipal)) throw new Error('synthetic legacy subject mismatch');
                                    return { subjectKey: identity.subjectKey, expiresAt: Date.parse(state.now) + 3600000 };
                                },
                                async recheck({ identity, assurance }) {
                                    if (identity.subjectKey !== subject(legacyPrincipal) || assurance.subjectKey !== identity.subjectKey) throw new Error('synthetic legacy assurance mismatch');
                                }
                            },
                            async resolveActivationBinding() { throw new Error('No legacy binding is assigned by this external fixture'); }
                        };
                    }
                }
                const app = appFactory({ dashboard });
                const h = { f, app, state, store, proofs, principal, cookie: null, parentId: null, parent: null,
                    sessionSha256: null, binding: null };
                h.get = (route, generation, cookie = h.cookie) => {
                    let req = http(app).get('/api/dashboard/' + route);
                    if (cookie) req = req.set('Cookie', cookie);
                    if (generation !== undefined) req = req.set(generationHeader, generation);
                    return req;
                };
                h.post = (route, body, cookie = h.cookie) => {
                    let req = http(app).post('/api/dashboard/' + route).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
                    if (cookie) req = req.set('Cookie', cookie);
                    return req.send(body);
                };
                h.ordinaryLogout = () => http(app).post('/api/auth/logout').set('Cookie', h.cookie)
                    // The ordinary Function's existing policy accepts the
                    // same-origin Fetch Metadata form without an Origin.
                    .set('Sec-Fetch-Site', 'same-origin').type('form').send({ returnTo: '/portal?signedOut=1' });
                h.login = async (asCustomer = Boolean(externalProfile)) => {
                    const proofKeys = new Set(proofs.keys());
                    const external = asCustomer && asCustomer !== 'legacy' && coexist;
                    const authPath = external ? '/api/external-customer-auth' : asCustomer ? '/api/customer-auth' : '/api/auth';
                    const started = await http(app).get(authPath + '/login?returnTo=%2Fportal');
                    expect(started.status).toBe(302);
                    const transactionCookie = started.headers['set-cookie'][0].split(';')[0];
                    const callback = await http(app).post(authPath + '/callback').set('Cookie', transactionCookie)
                        .type('form').send({ code: 'synthetic-code', state: new URL(started.headers.location).searchParams.get('state') });
                    expect(callback.status).toBe(303);
                    expect(callback.headers.location).toBe(external ? '/signup?provider=external' : asCustomer ? '/signup' : '/portal');
                    h.cookie = callback.headers['set-cookie'].find(value => value.startsWith(external ? '__Host-nofries-external-customer=' : asCustomer ? '__Host-nofries-customer=' : '__Host-nofries-auth=')).split(';')[0];
                    h.parentId = h.cookie.slice(h.cookie.indexOf('=') + 1);
                    h.parent = clone(store.sessions.get(h.parentId));
                    // Inspect the trusted fixture's original-proof store; no
                    // private value returned over HTTP becomes setup authority.
                    const issuedKeys = [...proofs.keys()].filter(key => !proofKeys.has(key));
                    expect(issuedKeys).toHaveLength(1); h.sessionSha256 = issuedKeys[0];
                    expect(proofs.get(h.sessionSha256)).toMatchObject({ kind: asCustomer ? 'customer_dashboard_issuance' : 'operator_dashboard_issuance',
                        identitySha256: hash(asCustomer === 'legacy' ? { ...identityPolicy, audience: legacyPrincipal.audience, oid: legacyPrincipal.oid } : asCustomer ? principal : staffPrincipal), instanceId: f.instanceId });
                    return callback;
                };
                h.addBinding = async (nextScope = null) => {
                    const originalScope = clone(f.scope), originalPrincipal = clone(f.customerIdentity);
                    try {
                        if (nextScope) Object.assign(f.scope, nextScope);
                        Object.assign(f.customerIdentity, principal);
                        const prepared = await f.publicationSetup(membershipValidUntil, prepareCanonical);
                        const publication = await f.repository.publishExistingMembershipBinding(f.operator(), prepared.command);
                        return { prepared, publication, bindingId: publication.binding.bindingId, scope: clone(f.scope) };
                    } finally { Object.assign(f.scope, originalScope); Object.assign(f.customerIdentity, originalPrincipal); }
                };
                h.initialize = async () => {
                    const operationId = nextId(), result = await h.post('session', { operationId });
                    httpJson(result, 200); expect(result.body).toEqual({ schemaVersion: 1, initialized: true });
                    await mutationProof(h, operationId, /^__Host-nofries-(?:external-)?customer=/.test(h.cookie) ? 'activateCustomerSession' : 'initializeOperatorSession');
                    return operationId;
                };
                h.select = async (binding = h.binding, expectedGeneration = null) => {
                    if (expectedGeneration === null) {
                        const read = await h.get('session'); httpJson(read, 200); expectedGeneration = read.body.generation;
                    }
                    const operationId = nextId(), response = await h.post('selection', { operationId,
                        bindingId: binding.bindingId, expectedGeneration });
                    httpJson(response, 200); expect(Object.keys(response.body).sort()).toEqual(['generation', 'schemaVersion', 'selectedBindingId']);
                    expect(response.body.selectedBindingId).toBe(binding.bindingId);
                    await mutationProof(h, operationId, 'selectBinding');
                    return response.body.generation;
                };
                if (publish) h.binding = await h.addBinding();
                await h.login();
                return h;
            }
            function evidenceSeedDatabase(h) {
                const seedPool = { end: () => h.f.restrictedPool.end(), async connect() {
                    const client = await h.f.restrictedPool.connect();
                    return { release: value => client.release(value), async query(sql, params) {
                        const result = await client.query(sql, params);
                        if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                        return result;
                    } };
                } };
                return createPostgresDatabase({ pool: seedPool });
            }
            async function evidenceHttpSetup() {
                const h = await httpSetup({ prepareCanonical(initial) {
                    initial.entitlementState.grants[0].modules = ['evidence', 'overview'];
                    initial.flags.enabled.evidence = true;
                } });
                await h.initialize(); h.generation = await h.select();
                const { evidenceFixture } = require('../fixtures/evidenceMetadataFixture');
                const synthetic = evidenceFixture({ now: h.state.now, tenantId: h.binding.scope.tenantId,
                    organisationId: h.binding.scope.organisationId });
                expect(synthetic.scope).toEqual(h.binding.scope);
                synthetic.command.actorSubjectKey = subject(h.principal);
                const store = require('../../api/shared/evidenceLifecycle/postgresEvidenceStore').createPostgresEvidenceStore({ database: evidenceSeedDatabase(h) });
                await store.execute(synthetic.command);
                h.artefactId = synthetic.command.artefactId;
                h.evidenceRoute = 'evidence?artefactId=' + encodeURIComponent(h.artefactId);
                return h;
            }
            test('HTTP evidence returns only quarantined metadata with one genuine read audit', async () => {
                const h = await evidenceHttpSetup(), before = await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256);
                const response = await h.get(h.evidenceRoute, h.generation);
                httpJson(response, 200);
                expect(response.body).toMatchObject({ schemaVersion: 1, evidence: { artefactId: h.artefactId, revision: 0,
                    versions: [{ quarantine: { state: 'quarantined', reason: 'content-unverified' } }] } });
                expect(JSON.stringify(response.body)).not.toMatch(/private-source|private-policy|actorSubjectKey|governanceRefs/);
                const after = await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256);
                expect(after).toHaveLength(before.length + 1);
                expect(after.filter(row => row.payload.action === 'evidence.read')).toHaveLength(1);
                httpJson(await h.get('evidence?artefactId=absent', h.generation), 404, 'evidence_not_found');
                await loginClean();
            });
            test('HTTP evidence follows current selected tenant and refuses stale selection generation', async () => {
                const h = await evidenceHttpSetup();
                httpJson(await h.get(h.evidenceRoute, h.generation), 200);
                const other = await h.addBinding({ tenantId: 'evidence-other-' + nextId(), organisationId: h.binding.scope.organisationId });
                const nextGeneration = await h.select(other, h.generation);
                httpJson(await h.get(h.evidenceRoute, h.generation), 403, 'evidence_access_denied');
                httpJson(await h.get(h.evidenceRoute, nextGeneration), 404, 'evidence_not_found');
                await loginClean();
            });
            test('HTTP evidence fresh module revocation prevents another disclosure or read audit', async () => {
                const h = await evidenceHttpSetup();
                httpJson(await h.get(h.evidenceRoute, h.generation), 200);
                const seed = h.binding.prepared.canonicalSeed;
                const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
                    authoriseAdministration: command => command.type === 'flags.update' && command.tenantId === h.binding.scope.tenantId
                        && command.organisationId === h.binding.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
                await repository.executeAuthorityCommand({ ...h.binding.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
                    type: 'flags.update', expectedRevisions: clone(seed.result.resultRevisions), payload: { ...clone(seed.initial.flags),
                        revision: seed.result.resultRevisions.flags + 1, enabled: { ...seed.initial.flags.enabled, evidence: false } } });
                const before = await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256);
                httpJson(await h.get(h.evidenceRoute, h.generation), 403, 'evidence_access_denied');
                expect(await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256)).toEqual(before);
                await loginClean();
            });
            async function ncscHttpSetup({ capacity = 1, role = 'admin', configured = true, membershipValidUntil = END,
                separateAdvisorWriteUntil = null, customerProvider = false, improvementEnabled = false, appFactory } = {}) {
                const quota = createNcscAdapters({ now: () => NOW });
                const h = await httpSetup({ membershipValidUntil, customerProvider, improvementEnabled, appFactory, ncsc: configured ? { resolveSubmissionQuota: quota.resolveSubmissionQuota } : null, prepareCanonical(initial) {
                    // Domain-created membership rows are frozen. Replace this
                    // synthetic seed's values without mutating domain output.
                    initial.membershipState = { ...initial.membershipState,
                        invitations: initial.membershipState.invitations.map(row => ({ ...row, roles: [role] })),
                        memberships: initial.membershipState.memberships.map(row => ({ ...row, roles: [role] })) };
                    const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
                    const frameworks = [{ moduleId: 'cyber_security', profileId: ACCEPTED_PROFILE_REF.profileId,
                        version: ACCEPTED_PROFILE_REF.profileVersion }];
                    initial.entitlementState = { ...initial.entitlementState,
                        grants: initial.entitlementState.grants.map((grant, index) => index === 0 ? { ...grant,
                            modules: ['cyber_security', ...(improvementEnabled ? ['improvement_plan'] : []), 'overview'], frameworks: clone(frameworks),
                            limits: { ...grant.limits, assessment_runs: capacity } } : grant) };
                    initial.flags = { ...initial.flags, enabled: { ...initial.flags.enabled, cyber_security: true },
                        frameworks: clone(frameworks) };
                    if (improvementEnabled) initial.flags.enabled.improvement_plan = true;
                    if (separateAdvisorWriteUntil) {
                        const member = initial.membershipState.memberships[0];
                        const scope = { tenantId: initial.membershipState.tenantId, organisationId: initial.membershipState.organisationId };
                        initial.entitlementState.grants = [...initial.entitlementState.grants, { ...scope,
                            grantId: 'synthetic-service', code: 'fractional_advisory', status: 'active', validFrom: START, validUntil: END,
                            agreementRef: 'synthetic-advisor-agreement', modules: ['services'], frameworks: [], limits: {},
                            coverage: ['synthetic-target'], actions: ['view'] }];
                        initial.flags.enabled['service:fractional_advisory'] = true;
                        initial.advisorAssignments = ['read', 'write'].map(permission => ({ schemaVersion: 1, ...scope,
                            assignmentId: 'synthetic-advisor-' + permission, membershipId: member.membershipId,
                            subjectKey: member.subjectKey, status: 'active', validFrom: START,
                            validUntil: permission === 'write' ? separateAdvisorWriteUntil : END,
                            modules: ['cyber_security'], permissions: ['assessment.' + permission],
                            grantEvidenceId: 'synthetic-advisor-' + permission + '-approval', revision: 0, updatedAt: NOW }));
                    }
                } });
                await h.initialize();
                if (customerProvider) {
                    const session = await h.get('session'); httpJson(session, 200);
                    expect(session.body.selectedBindingId).toBe(h.binding.bindingId); h.generation = session.body.generation;
                } else h.generation = await h.select();
                h.quota = quota;
                h.ncscPost = (command, generation = h.generation) => {
                    const { action, assessmentId, ...body } = command;
                    const route = 'ncsc/assessments' + (action === 'create' ? '' : '/' + assessmentId + '/' + action);
                    return h.post(route, action === 'create' ? { assessmentId, ...body } : body)
                        .set(generationHeader, generation);
                };
                return h;
            }
            test.each(['admin', 'viewer'])('HTTP configured NCSC %s receives guarded metadata and truthful presentation', async role => {
                const h = await ncscHttpSetup({ role });
                const bootstrap = await h.get('bootstrap', h.generation); httpJson(bootstrap, 200);
                if (role === 'admin') {
                    expect(bootstrap.body.modules.find(value => value.key === 'cyber_security')).toMatchObject({ state: 'ready' });
                    const detail = await h.get('modules/cyber_security', h.generation); httpJson(detail, 200);
                    expect(detail.body.module.state).toBe('ready'); expect(detail.body.presentationMode).toBe('editable');
                    expect(detail.body.metadata).toEqual(require('../../api/shared/ncscQuestionnaireMetadata').createNcscQuestionnaireMetadata());
                } else {
                    // Canonical VIEWER grants overview/services/issued reports,
                    // not assessment.read. UI metadata must preserve that policy.
                    expect(bootstrap.body.modules.some(value => value.key === 'cyber_security')).toBe(false);
                    const beforeDenial = await exportAll();
                    httpJson(await h.get('modules/cyber_security', h.generation), 403, 'dashboard_access_denied');
                    const before = await exportAll();
                    const denialAudits = before.dashboard_runtime_audit.filter(row =>
                        !beforeDenial.dashboard_runtime_audit.some(previous => previous.event_id === row.event_id));
                    expect(denialAudits).toHaveLength(1);
                    expect(denialAudits[0]).toMatchObject({ session_sha256: h.sessionSha256,
                        tenant_id: h.binding.scope.tenantId, organisation_id: h.binding.scope.organisationId,
                        payload: { action: 'readDashboardAdmission', outcome: 'denied' } });
                    expect({ ...before, dashboard_runtime_audit: beforeDenial.dashboard_runtime_audit }).toEqual(beforeDenial);
                    httpJson(await h.get('ncsc/assessments', h.generation), 403, 'ncsc_access_denied');
                    httpJson(await h.ncscPost(createCommand()), 403, 'ncsc_access_denied');
                    expect(await exportAll()).toEqual(before);
                }
                await loginClean();
            });
            test('HTTP NCSC independent advisor read/write grants permit editing only while the write grant is live', async () => {
                const cutoff = '2026-09-07T01:00:01.000Z';
                const h = await ncscHttpSetup({ role: 'fractional_advisor', separateAdvisorWriteUntil: cutoff });
                const editable = await h.get('modules/cyber_security', h.generation); httpJson(editable, 200);
                expect(editable.body.presentationMode).toBe('editable');
                httpJson(await h.ncscPost(createCommand()), 201);
                h.state.now = cutoff; h.f.state.now = cutoff;
                const readonly = await h.get('modules/cyber_security', h.generation); httpJson(readonly, 200);
                expect(readonly.body.presentationMode).toBe('read-only');
                const detail = await h.get('ncsc/assessments/assessment-a', h.generation); httpJson(detail, 200);
                expect(detail.body.assessment.revision).toBe(0);
                const before = await exportAll();
                httpJson(await h.ncscPost(saveCommand()), 403, 'ncsc_access_denied');
                expect(await exportAll()).toEqual(before); await loginClean();
            });
            test('HTTP NCSC membership expiry withdraws editable metadata and mutation access', async () => {
                const cutoff = '2026-09-07T01:00:01.000Z';
                const h = await ncscHttpSetup({ membershipValidUntil: cutoff });
                const detail = await h.get('modules/cyber_security', h.generation); httpJson(detail, 200);
                expect(detail.body.presentationMode).toBe('editable');
                h.state.now = cutoff; h.f.state.now = cutoff;
                const before = await exportAll();
                httpJson(await h.get('modules/cyber_security', h.generation), 403, 'dashboard_access_denied');
                httpJson(await h.ncscPost(createCommand()), 403, 'ncsc_access_denied');
                expect(await exportAll()).toEqual(before); await loginClean();
            });
            test('HTTP unconfigured NCSC stays planned without questionnaire metadata or installed routes', async () => {
                const h = await ncscHttpSetup({ configured: false });
                const bootstrap = await h.get('bootstrap', h.generation); httpJson(bootstrap, 200);
                expect(bootstrap.body.modules.find(value => value.key === 'cyber_security')).toMatchObject({ state: 'planned' });
                const detail = await h.get('modules/cyber_security', h.generation); httpJson(detail, 200);
                expect(detail.body.module.state).toBe('planned');
                expect(detail.body.metadata).toBeUndefined(); expect(detail.body.presentationMode).toBeUndefined();
                httpJson(await h.get('ncsc/assessments', h.generation), 404, 'dashboard_not_found');
                await loginClean();
            });
            test.each([true, 'coexist'])('HTTP external customer saves questionnaire answers then logs out and relogs into the same immutable binding (%s)', async customerProvider => {
                const h = await ncscHttpSetup({ customerProvider });
                const binding = clone(h.binding), identityBefore = clone(h.parent.identity), firstCookie = h.cookie;
                const firstParentId = h.parentId, firstSession = h.sessionSha256;
                httpJson(await h.ncscPost(createCommand()), 201);
                const saved = await h.ncscPost(saveCommand()); httpJson(saved, 200);
                const before = await exportAll();
                const logout = await h.post('logout', {}); httpJson(logout, 200);
                expect(logout.headers['set-cookie'][0]).toMatch(customerProvider === 'coexist' ? /^__Host-nofries-external-customer=;.*Max-Age=0/ : /^__Host-nofries-customer=;.*Max-Age=0/);
                expect(h.store.sessions.has(firstParentId)).toBe(false);
                await httpTombstone(h);
                httpJson(await h.get('session', undefined, firstCookie), 401, 'dashboard_authentication_required');
                await h.login(); await h.initialize();
                const session = await h.get('session'); httpJson(session, 200);
                expect(session.body.purpose).toBe('customer');
                expect(session.body.selectedBindingId).toBe(binding.bindingId);
                expect(h.parent.identity.subjectKey).toBe(identityBefore.subjectKey);
                expect(h.sessionSha256).not.toBe(firstSession);
                h.generation = session.body.generation;
                const resumed = await h.get('ncsc/assessments/assessment-a', h.generation); httpJson(resumed, 200);
                expect(resumed.body.assessment).toEqual(saved.body.assessment);
                const after = await exportAll();
                for (const table of [...DATA_TABLES, ...NCSC_TABLES, 'dashboard_identity_bindings']) expect(after[table]).toEqual(before[table]);
                // Same application, separate staff authority and cookie. Staff
                // initialization does not adopt the external customer's binding.
                await h.login(false); await h.initialize();
                const staffSession = await h.get('session'); httpJson(staffSession, 200);
                expect(staffSession.body.purpose).toBe('operator_dashboard');
                expect(staffSession.body.selectedBindingId).toBeNull();
                expect(h.parent.identity.subjectKey).not.toBe(identityBefore.subjectKey);
                if (customerProvider === 'coexist') {
                    await h.login('legacy');
                    const legacyIdentity = clone(h.parent.identity);
                    expect(legacyIdentity.subjectKey).not.toBe(identityBefore.subjectKey);
                    httpJson(await h.get('session'), 409, 'dashboard_initialization_required');
                    // Same display email does not supply an external binding to
                    // a legacy subject. A new external login resumes its own data.
                    await h.login(); await h.initialize();
                    const externalSession = await h.get('session'); httpJson(externalSession, 200);
                    expect(externalSession.body.selectedBindingId).toBe(binding.bindingId);
                    const retained = await h.get('ncsc/assessments/assessment-a', externalSession.body.generation); httpJson(retained, 200);
                    expect(retained.body.assessment).toEqual(saved.body.assessment);
                    const unchanged = await exportAll();
                    for (const table of [...DATA_TABLES, ...NCSC_TABLES, 'dashboard_identity_bindings']) expect(unchanged[table]).toEqual(before[table]);
                }
                await loginClean();
            });
            test('HTTP NCSC synthetic HQ creates, saves, resumes and submits once on the restricted LOGIN', async () => {
                const h = await ncscHttpSetup();
                const empty = await h.get('ncsc/assessments?limit=10', h.generation); httpJson(empty, 200);
                expect(empty.body.assessments).toEqual([]);
                const created = await h.ncscPost(createCommand()); httpJson(created, 201);
                expect(created.body.assessment).toMatchObject({ assessmentId: 'assessment-a', revision: 0 });
                const saved = await h.ncscPost(saveCommand()); httpJson(saved, 200);
                const resumed = await h.get('ncsc/assessments/assessment-a', h.generation); httpJson(resumed, 200);
                expect(resumed.body.assessment).toEqual(saved.body.assessment);
                const submitted = await h.ncscPost(submitCommand()); httpJson(submitted, 200);
                expect(submitted.body.assessment).toMatchObject({ revision: 2, status: 'submitted' });
                const before = await exportAll();
                const replay = await h.ncscPost(submitCommand()); httpJson(replay, 200);
                expect(replay.body).toEqual(submitted.body); expect(await exportAll()).toEqual(before);
                expect(before.dashboard_ncsc_assessment_receipts).toHaveLength(3);
                expect(before.dashboard_ncsc_assessment_revisions).toHaveLength(3);
                expect(before.dashboard_usage.find(row => row.grant_id === 'synthetic-base-grant').payload.counters.assessment_runs).toBe(1);
                const listed = await h.get('ncsc/assessments?limit=1', h.generation); httpJson(listed, 200);
                expect(listed.body.assessments.map(value => value.assessmentId)).toEqual(['assessment-a']);
                httpJson(await h.ncscPost(createCommand('assessment-b', 'create-b')), 201);
                httpJson(await h.ncscPost(saveCommand('assessment-b', 0, 'save-b')), 200);
                const full = await exportAll();
                httpJson(await h.ncscPost(submitCommand('assessment-b', 1, 'submit-b')), 409, 'ncsc_quota_exceeded');
                expect(await exportAll()).toEqual(full); await loginClean();
            });
            test('HTTP NCSC rejects absent parent, foreign origin and stale tenant selection without mutation', async () => {
                const h = await ncscHttpSetup();
                httpJson(await h.ncscPost(createCommand()), 201);
                const before = await exportAll();
                httpJson(await h.get('ncsc/assessments', h.generation, null), 401, 'dashboard_authentication_required');
                const command = createCommand('forbidden', 'foreign-create');
                const { action, ...body } = command;
                httpJson(await h.post('ncsc/assessments', body).set(generationHeader, h.generation)
                    .set('Origin', 'https://foreign.invalid'), 403, 'dashboard_access_denied');
                expect(await exportAll()).toEqual(before);
                const other = await h.addBinding({ tenantId: 'ncsc-http-other-' + nextId(), organisationId: h.binding.scope.organisationId });
                const generation = await h.select(other, h.generation);
                httpJson(await h.get('ncsc/assessments/assessment-a', h.generation), 403, 'ncsc_access_denied');
                httpJson(await h.get('ncsc/assessments/assessment-a', generation), 404, 'ncsc_not_found');
                await loginClean();
            });
            test.each(['before', 'after'])('HTTP NCSC lost COMMIT %s acknowledgement retains exact receipt recovery', async phase => {
                const h = await ncscHttpSetup(), command = createCommand();
                const before = await exportAll();
                const observed = ncscCommitFault(h.f, command, phase, () => { throw new Error('Synthetic HTTP NCSC COMMIT acknowledgement loss'); });
                const outcome = await h.ncscPost(command); h.f.state.hook = null;
                expect(observed.markers).toBe(1); expect(observed.faults).toBe(1); expect(observed.fault).toEqual(observed.marker);
                expect(observed.recovery.filter(sql => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+nofries\./i.test(sql))).toEqual([]);
                if (phase === 'before') {
                    httpJson(outcome, 503, 'ncsc_outcome_ambiguous'); expect(await exportAll()).toEqual(before);
                } else {
                    httpJson(outcome, 201); expect((await exportAll()).dashboard_ncsc_assessment_receipts).toHaveLength(1);
                }
                const retried = await h.ncscPost(command); httpJson(retried, 201);
                if (phase === 'after') expect(retried.body).toEqual(outcome.body);
                expect((await exportAll()).dashboard_ncsc_assessment_receipts).toHaveLength(1); await loginClean();
            });
            test('HTTP NCSC current module revocation prevents read and save with no retained effects', async () => {
                const h = await ncscHttpSetup(); httpJson(await h.ncscPost(createCommand()), 201);
                const seed = h.binding.prepared.canonicalSeed;
                const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
                    authoriseAdministration: command => command.type === 'flags.update' && command.tenantId === h.binding.scope.tenantId
                        && command.organisationId === h.binding.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
                await repository.executeAuthorityCommand({ ...h.binding.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
                    type: 'flags.update', expectedRevisions: clone(seed.result.resultRevisions), payload: { ...clone(seed.initial.flags),
                        revision: seed.result.resultRevisions.flags + 1, enabled: { ...seed.initial.flags.enabled, cyber_security: false } } });
                const before = await exportAll();
                httpJson(await h.get('ncsc/assessments/assessment-a', h.generation), 403, 'ncsc_access_denied');
                httpJson(await h.ncscPost(saveCommand()), 403, 'ncsc_access_denied');
                expect(await exportAll()).toEqual(before); await loginClean();
            });
            function httpJson(response, status, code) {
                expect(response.status).toBe(status);
                expect(response.headers['cache-control']).toMatch(/private/);
                expect(response.headers['cache-control']).toMatch(/no-store/);
                expect(response.headers['content-type']).toMatch(/^application\/json\b/);
                expect(response.headers.location).toBeUndefined();
                if (code) expect(response.body).toEqual({ code });
            }
            async function mutationProof(h, operationId, operationType) {
                const receipts = await rows('dashboard_runtime_receipts', 'operation_id', operationId);
                const audits = await rows('dashboard_runtime_audit', 'operation_id', operationId);
                expect(receipts).toHaveLength(1); expect(audits).toHaveLength(1);
                expect(receipts[0]).toMatchObject({ operation_type: operationType, anchor_session_sha256: h.sessionSha256,
                    audit_event_id: audits[0].event_id });
                expect(audits[0]).toMatchObject({ session_sha256: h.sessionSha256,
                    payload: { action: operationType, outcome: 'succeeded', operationId } });
                return receipts[0];
            }
            async function httpTombstone(h) {
                const retained = await rows('dashboard_session_gates', 'session_sha256', h.sessionSha256);
                expect(retained).toHaveLength(1); expect(retained[0].status).toBe('revoked');
                return retained[0];
            }
            async function httpNoResurrection(h) {
                h.store.sessions.set(h.parentId, clone(h.parent));
                const before = await exportAll();
                httpJson(await h.post('session', { operationId: nextId() }), 403, 'dashboard_access_denied');
                expect(await exportAll()).toEqual(before);
            }
            function auditFor(event, action) {
                return /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql) && event.params.some(value => {
                    if (typeof value !== 'string' || !value.startsWith('{')) return false;
                    try { return JSON.parse(value).action === action; } catch (_) { return false; }
                });
            }
            async function parallelHttp(work) {
                const { Pool } = require('pg'), url = new URL(testUrl);
                url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
                const pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                    application_name: `http-runtime-lock-${runKey}` }), close = trackPoolClientEnds(pool);
                try { await work(pool); } finally { await close(); }
            }

            test.each(['ordinary', 'dashboard'])('JP01 actual login, own directory, guarded assets and %s logout retain audited boundaries', async logout => {
                const h = await httpSetup(), before = await exportAll();
                httpJson(await h.get('session'), 409, 'dashboard_initialization_required');
                expect(await rows('dashboard_session_gates', 'session_sha256', h.sessionSha256)).toEqual([]);
                expect(await exportAll()).toEqual(before);
                await h.initialize();
                const session = await h.get('session'); httpJson(session, 200);
                expect(Object.keys(session.body).sort()).toEqual(['authenticated', 'expiresAt', 'generation', 'purpose', 'schemaVersion', 'selectedBindingId']);
                expect(session.body).toMatchObject({ schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', selectedBindingId: null });
                const directory = await h.get('organisations?limit=1'); httpJson(directory, 200);
                expect(directory.body).toEqual({ schemaVersion: 1,
                    bindings: [{ bindingId: h.binding.bindingId, organisationLabel: 'Synthetic organisation' }], nextAfterBindingId: null });
                const generation = await h.select(h.binding, session.body.generation);
                for (const route of ['bootstrap', 'modules/overview']) {
                    const response = await h.get(route, generation); httpJson(response, 200);
                    expect(response.text).not.toContain(h.parentId); expect(response.text).not.toContain(h.sessionSha256);
                    expect(response.text).not.toContain(h.principal.oid); expect(response.text).toContain('overview');
                }
                for (const route of ['app.js', 'dashboard.css']) {
                    const response = await h.get(route); expect(response.status).toBe(200);
                    expect(response.headers['cache-control']).toMatch(/private.*no-store/);
                    expect(response.headers['content-type']).toMatch(route === 'app.js' ? /javascript/ : /^text\/css/);
                    const expected = route === 'app.js' ? ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
                        .map(file => fs.readFileSync(path.resolve(__dirname, '../../api/shared/protectedAssets', file), 'utf8')).join('\n')
                        : fs.readFileSync(path.resolve(__dirname, '../../app/dashboard.css'), 'utf8');
                    expect(response.text).toBe(expected);
                }
                const audits = await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256);
                for (const action of ['readSession', 'discoverBindings', 'readDashboardBootstrap', 'readDashboardAdmission'])
                    expect(audits.filter(row => row.payload.action === action)).toHaveLength(1);
                expect(audits.filter(row => row.payload.action === 'readDashboardAsset')).toHaveLength(2);
                expect(audits.filter(row => row.payload.action.startsWith('readDashboard')).every(row =>
                    row.tenant_id === h.binding.scope.tenantId && row.organisation_id === h.binding.scope.organisationId)).toBe(true);
                h.state.beforeDelete = async () => {
                    await mutationProof(h, h.state.operations[0], 'revokeSession'); await httpTombstone(h);
                    expect(h.store.sessions.has(h.parentId)).toBe(true); expect(h.f.state.trace.at(-1).sql).toBe('COMMIT');
                };
                const response = await (logout === 'ordinary' ? h.ordinaryLogout() : h.post('logout', {}));
                if (logout === 'ordinary') { expect(response.status).toBe(303); expect(response.headers.location).toBe('/portal?signedOut=1'); }
                else { httpJson(response, 200); expect(response.body).toEqual({ schemaVersion: 1, loggedOut: true }); }
                expect(response.headers['set-cookie'][0]).toMatch(/^__Host-nofries-auth=;.*Max-Age=0/);
                expect(h.state.deletes).toBe(1); expect(h.store.sessions.has(h.parentId)).toBe(false);
                httpJson(await h.get('bootstrap', generation), 401, 'dashboard_authentication_required');
                await httpNoResurrection(h); expect(h.f.state.borrows).toBe(h.f.state.releases); await loginClean();
            });

            test('JP02 installed session precedence distinguishes an absent parent from bad generation without H or SQL', async () => {
                const h = await httpSetup(), before = await exportAll();
                let borrows = h.f.state.borrows, proofReads = h.state.proofReads;
                httpJson(await h.get('bootstrap', 'bad', null), 401, 'dashboard_authentication_required');
                expect(h.f.state.borrows).toBe(borrows); expect(h.state.proofReads).toBe(proofReads);
                httpJson(await h.get('bootstrap', 'bad'), 403, 'dashboard_access_denied');
                expect(h.f.state.borrows).toBe(borrows); expect(h.state.proofReads).toBe(proofReads);
                h.state.now = new Date(Math.min(h.parent.idleExpiresAt, h.parent.absoluteExpiresAt)).toISOString();
                httpJson(await h.get('bootstrap', 'bad'), 401, 'dashboard_authentication_required');
                expect(h.f.state.borrows).toBe(borrows); expect(h.state.proofReads).toBe(proofReads);
                expect(await exportAll()).toEqual(before);
            });

            test.each(['missing', 'wrong', 'epoch'])('JP03 valid browser parent with %s original authority never initializes through HTTP', async kind => {
                const h = await httpSetup(), before = await exportAll();
                if (kind === 'missing') h.proofs.delete(h.sessionSha256);
                if (kind === 'wrong') h.proofs.set(h.sessionSha256, { ...h.proofs.get(h.sessionSha256), identitySha256: digest('foreign-original') });
                if (kind === 'epoch') h.f.state.restoreEpoch = nextId();
                httpJson(await h.get('session'), 403, 'dashboard_access_denied');
                httpJson(await h.post('session', { operationId: nextId() }), 403, 'dashboard_access_denied');
                expect(await exportAll()).toEqual(before); expect(h.state.deletes).toBe(0);
            });

            test('JP04 two configured apps retain own principal, directory and scope during concurrent requests', async () => {
                await parallelHttp(async pool => {
                    const a = await httpSetup({ rawRuntimePool: pool });
                    const b = await httpSetup({ base: a.f, principal: { ...a.principal, oid: nextId() }, publish: false });
                    b.binding = await b.addBinding({ tenantId: 'http-other-' + nextId(), organisationId: 'other-org' });
                    await Promise.all([a.initialize(), b.initialize()]);
                    const [da, db] = await Promise.all([a.get('organisations'), b.get('organisations')]);
                    httpJson(da, 200); httpJson(db, 200);
                    expect(da.body.bindings.map(row => row.bindingId)).toEqual([a.binding.bindingId]);
                    expect(db.body.bindings.map(row => row.bindingId)).toEqual([b.binding.bindingId]);
                    const [ga, gb] = await Promise.all([a.select(), b.select()]);
                    const [ra, rb] = await Promise.all([a.get('bootstrap', ga), b.get('bootstrap', gb)]);
                    httpJson(ra, 200); httpJson(rb, 200);
                    expect(ra.text).not.toContain(b.binding.scope.tenantId); expect(rb.text).not.toContain(a.binding.scope.tenantId);
                    httpJson(await a.post('selection', { operationId: nextId(), bindingId: b.binding.bindingId, expectedGeneration: ga }), 403, 'dashboard_access_denied');
                    const before = await exportAll();
                    httpJson(await b.get('bootstrap', gb, a.cookie), 401, 'dashboard_authentication_required');
                    expect(await exportAll()).toEqual(before); expect(a.f.state.borrows).toBe(a.f.state.releases);
                });
            });

            test('JP05 lawful HTTP switch preserves original selection replay and rejects stale generation', async () => {
                const h = await httpSetup(); await h.initialize(); const first = await h.select();
                const next = await h.addBinding({ tenantId: 'http-switch-' + nextId(), organisationId: 'next-org' });
                const command = { operationId: nextId(), bindingId: next.bindingId, expectedGeneration: first };
                const switched = await h.post('selection', command); httpJson(switched, 200);
                const snapshot = await exportAll();
                const replay = await h.post('selection', command); httpJson(replay, 200); expect(replay.body).toEqual(switched.body);
                expect(await exportAll()).toEqual(snapshot);
                httpJson(await h.get('bootstrap', first), 403, 'dashboard_access_denied');
                httpJson(await h.get('bootstrap', switched.body.generation), 200);
                await mutationProof(h, command.operationId, 'selectBinding');
            });

            test.each(['discoverBindings', 'readDashboardBootstrap'])('JP06 %s audit fault prevents HTTP disclosure and rolls back its entire write', async action => {
                const h = await httpSetup(); await h.initialize(); const generation = await h.select(), before = await exportAll();
                let faults = 0;
                h.f.state.hook = event => {
                    if (event.phase === 'before' && auditFor(event, action)) { faults++; throw new Error('synthetic private HTTP audit failure'); }
                };
                try { httpJson(await h.get(action === 'discoverBindings' ? 'organisations' : 'bootstrap',
                    action === 'discoverBindings' ? undefined : generation), 503, 'dashboard_unavailable'); }
                finally { h.f.state.hook = null; }
                expect(faults).toBe(1); expect(await exportAll()).toEqual(before);
                expect(h.f.state.trace.at(-1).sql).toBe('ROLLBACK'); expect(h.f.state.borrows).toBe(h.f.state.releases);
            });

            test.each(['before', 'after'])('JP07 HTTP initialization lost COMMIT %s acknowledgement requires its original receipt proof', async phase => {
                const h = await httpSetup(), before = await exportAll(), operationId = nextId();
                let marked = false, faulted = false, boundary = null;
                h.f.state.hook = event => {
                    if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_receipts\b/.test(event.sql)
                        && event.params.includes(operationId)) marked = true;
                    if (marked && !faulted && event.sql === 'COMMIT' && event.phase === phase) {
                        faulted = true; boundary = h.f.state.trace.length; throw new Error('synthetic HTTP COMMIT acknowledgement lost');
                    }
                };
                let result;
                try { result = await h.post('session', { operationId }); } finally { h.f.state.hook = null; }
                expect(marked).toBe(true); expect(faulted).toBe(true);
                const recovery = h.f.state.trace.slice(boundary);
                expect(recovery.some(event => /FROM nofries\.dashboard_runtime_receipts\b/.test(event.sql))).toBe(true);
                expect(recovery.filter(event => /^(?:INSERT INTO|UPDATE|DELETE FROM) nofries\./.test(event.sql))).toEqual([]);
                if (phase === 'after') {
                    httpJson(result, 200); expect(result.body).toEqual({ schemaVersion: 1, initialized: true });
                    await mutationProof(h, operationId, 'initializeOperatorSession');
                } else { httpJson(result, 503, 'dashboard_outcome_ambiguous'); expect(await exportAll()).toEqual(before); }
                expect(h.f.state.borrows).toBe(h.f.state.releases);
            });

            test('JP08 committed HTTP logout survives parent-delete failure and a new request completes cleanup', async () => {
                const h = await httpSetup(); await h.initialize();
                h.state.beforeDelete = async () => {
                    await httpTombstone(h);
                    if (h.state.deletes === 1) throw new Error('synthetic parent-delete provider failure');
                };
                const failed = await h.post('logout', {}); httpJson(failed, 503, 'dashboard_unavailable');
                expect(failed.headers['set-cookie']).toBeUndefined(); expect(h.store.sessions.has(h.parentId)).toBe(true);
                const first = await httpTombstone(h); await mutationProof(h, h.state.operations[0], 'revokeSession');
                const retry = await h.post('logout', {}); httpJson(retry, 200);
                expect(retry.body).toEqual({ schemaVersion: 1, loggedOut: true });
                expect(await httpTombstone(h)).toEqual(first); expect(h.state.deletes).toBe(2);
                await mutationProof(h, h.state.operations[1], 'revokeSession'); await httpNoResurrection(h);
            });

            test.each(['initialize first', 'logout first'])('JP09 absent HTTP gate: %s establishes real lock contention without resurrection', async order => {
                await parallelHttp(async pool => {
                    const h = await httpSetup({ rawRuntimePool: pool }), held = gate(), release = gate(0), waiter = gate();
                    let first, second, holderPid, waiterPid;
                    const operationId = nextId();
                    const sessionLock = event => /^SELECT pg_advisory_xact_lock\(\$1::integer, hashtext\(\$2\)\)$/.test(event.sql)
                        && Number(event.params[0]) === 71001 && event.params[1] === h.sessionSha256;
                    h.f.state.hook = async event => {
                        if (!holderPid && event.phase === 'after' && sessionLock(event)) {
                            holderPid = event.backendPid; held.resolve(); await release.promise;
                        } else if (holderPid && event.backendPid !== holderPid && event.phase === 'before' && sessionLock(event)) {
                            waiterPid = event.backendPid; waiter.resolve();
                        }
                    };
                    const initialize = () => h.post('session', { operationId }), logout = () => h.post('logout', {});
                    try {
                        first = settled(Promise.resolve(order === 'initialize first' ? initialize() : logout()));
                        await timingPhase(held, first);
                        second = settled(Promise.resolve(order === 'initialize first' ? logout() : initialize()));
                        await timingPhase(waiter, second); expect(waiterPid).not.toBe(holderPid); await actualBlockedBy(waiterPid, holderPid);
                        expect(h.state.deletes).toBe(0); release.resolve();
                        const [one, two] = await Promise.all([first, second]);
                        const initialized = order === 'initialize first' ? one.value : two.value;
                        const loggedOut = order === 'initialize first' ? two.value : one.value;
                        httpJson(loggedOut, 200);
                        if (order === 'initialize first') httpJson(initialized, 200);
                        else httpJson(initialized, 403, 'dashboard_access_denied');
                        h.f.state.hook = null;
                        expect((await httpTombstone(h)).revision).toBe(order === 'initialize first' ? 1 : 0);
                        expect(await rows('dashboard_runtime_receipts', 'operation_id', operationId)).toHaveLength(order === 'initialize first' ? 1 : 0);
                        await httpNoResurrection(h);
                    } finally {
                        release.resolve(); held.resolve(); waiter.resolve(); await Promise.all([first, second].filter(Boolean)); h.f.state.hook = null;
                    }
                });
            });

            test.each(['selection', 'logout'].flatMap(action => [true, false].map(resourceFirst => [action, resourceFirst])))
            ('JP10 HTTP resource versus %s with resource first=%s retains actual session-lock order', async (action, resourceFirst) => {
                await parallelHttp(async pool => {
                    const h = await httpSetup({ rawRuntimePool: pool }); await h.initialize(); const generation = await h.select();
                    const next = action === 'selection' ? await h.addBinding({ tenantId: 'http-race-' + nextId(), organisationId: 'next-org' }) : null;
                    const before = await exportAll(), held = gate(), release = gate(0), waiter = gate();
                    let first, second, holderPid, waiterPid;
                    const sessionLock = event => /^SELECT pg_advisory_xact_lock(?:_shared)?\(\$1::integer, hashtext\(\$2\)\)$/.test(event.sql)
                        && Number(event.params[0]) === 71001 && event.params[1] === h.sessionSha256;
                    h.f.state.hook = async event => {
                        const holdHere = resourceFirst ? auditFor(event, 'readDashboardBootstrap')
                            : sessionLock(event) && !event.sql.includes('_shared');
                        if (!holderPid && event.phase === 'after' && holdHere) {
                            holderPid = event.backendPid; held.resolve(); await release.promise;
                        } else if (holderPid && event.backendPid !== holderPid && event.phase === 'before' && sessionLock(event)) {
                            waiterPid = event.backendPid; waiter.resolve();
                        }
                    };
                    const change = () => action === 'logout' ? h.post('logout', {}) : h.post('selection', {
                        operationId: nextId(), bindingId: next.bindingId, expectedGeneration: generation });
                    try {
                        first = settled(Promise.resolve(resourceFirst ? h.get('bootstrap', generation) : change())); await timingPhase(held, first);
                        second = settled(Promise.resolve(resourceFirst ? change() : h.get('bootstrap', generation))); await timingPhase(waiter, second);
                        expect(waiterPid).not.toBe(holderPid); await actualBlockedBy(waiterPid, holderPid); release.resolve();
                        const [one, two] = await Promise.all([first, second]);
                        httpJson(resourceFirst ? two.value : one.value, 200);
                        if (resourceFirst) httpJson(one.value, 200); else httpJson(two.value, 403, 'dashboard_access_denied');
                        h.f.state.hook = null;
                        const after = await exportAll(), added = after.dashboard_runtime_audit
                            .filter(row => !before.dashboard_runtime_audit.some(old => old.event_id === row.event_id));
                        expect(added.filter(row => row.payload.action === 'readDashboardBootstrap')).toHaveLength(resourceFirst ? 1 : 0);
                        for (const table of [...DATA_TABLES, ...RUNTIME_TABLES, ...NCSC_TABLES]
                            .filter(table => !['dashboard_session_gates', 'dashboard_runtime_receipts', 'dashboard_runtime_audit'].includes(table)))
                            expect(after[table]).toEqual(before[table]);
                        if (action === 'logout') await httpNoResurrection(h);
                    } finally {
                        release.resolve(); held.resolve(); waiter.resolve(); await Promise.all([first, second].filter(Boolean)); h.f.state.hook = null;
                    }
                });
            });

            test.each(['pre-context', 'proof', 'ordinary logout'])('JP11 expiry while %s provider is pending waits for settlement and acquires no SQL', async phase => {
                const h = await httpSetup({ requestBudgetMs: 1000 }), entered = gate(), release = gate(0);
                const before = await exportAll(), borrows = h.f.state.borrows; let pending, completed = false;
                const hold = async () => { entered.resolve(); await release.promise; };
                if (phase === 'proof') h.state.beforeProof = hold; else h.state.beforeLoad = hold;
                try {
                    pending = Promise.resolve(phase === 'ordinary logout' ? h.ordinaryLogout() : h.post('session', { operationId: nextId() }))
                        .then(value => { completed = true; return value; });
                    await timingPhase(entered, settled(pending)); h.state.now = atMillis(1000);
                    await new Promise(resolve => setImmediate(resolve));
                    expect(completed).toBe(false); expect(h.f.state.borrows).toBe(borrows); expect(h.state.deletes).toBe(0);
                    release.resolve(); const response = await pending;
                    if (phase === 'ordinary logout') {
                        expect(response.status).toBe(503); expect(response.body.code).toBe('browser_auth_unavailable');
                    } else httpJson(response, 503, 'dashboard_unavailable');
                    expect(response.headers['set-cookie']).toBeUndefined(); expect(h.f.state.borrows).toBe(borrows);
                    expect(h.state.deletes).toBe(0); expect(await exportAll()).toEqual(before);
                } finally { release.resolve(); entered.resolve(); if (pending) await pending; h.state.beforeLoad = null; h.state.beforeProof = null; }
            });

            test('JP12 expiry after committed revoke awaits real parent deletion and never claims rollback', async () => {
                const h = await httpSetup({ requestBudgetMs: 1000 }); await h.initialize();
                const entered = gate(), release = gate(0); let pending, completed = false, retained;
                h.state.beforeDelete = async () => { retained = await httpTombstone(h); entered.resolve(); await release.promise; };
                try {
                    pending = Promise.resolve(h.post('logout', {})).then(value => { completed = true; return value; });
                    await timingPhase(entered, settled(pending)); h.state.now = atMillis(1000);
                    await new Promise(resolve => setImmediate(resolve)); expect(completed).toBe(false);
                    expect(h.store.sessions.has(h.parentId)).toBe(true); expect(h.f.state.borrows).toBe(h.f.state.releases);
                    const boundary = h.f.state.trace.length; release.resolve();
                    const response = await pending; httpJson(response, 503, 'dashboard_unavailable');
                    expect(response.headers['set-cookie']).toBeUndefined(); expect(h.store.sessions.has(h.parentId)).toBe(false);
                    expect(await httpTombstone(h)).toEqual(retained); await mutationProof(h, h.state.operations[0], 'revokeSession');
                    expect(h.f.state.trace.slice(boundary).some(event => event.sql === 'ROLLBACK')).toBe(false);
                } finally { release.resolve(); entered.resolve(); if (pending) await pending; h.state.beforeDelete = null; }
            });

            test('JP13 a genuinely blocked SQL statement keeps its client until settlement after host expiry', async () => {
                const h = await httpSetup({ requestBudgetMs: 1000 }), before = await exportAll();
                const holder = await ownerPool.connect(), entered = gate(); let pending, completed = false, waiterPid, locked = false;
                try {
                    await holder.query('SELECT pg_advisory_lock($1::integer, hashtext($2))', [71001, h.sessionSha256]); locked = true;
                    h.f.state.hook = event => {
                        if (event.phase === 'before' && /^SELECT pg_advisory_xact_lock\(\$1::integer, hashtext\(\$2\)\)$/.test(event.sql)
                            && Number(event.params[0]) === 71001 && event.params[1] === h.sessionSha256) {
                            waiterPid = event.backendPid; entered.resolve();
                        }
                    };
                    pending = Promise.resolve(h.post('session', { operationId: nextId() })).then(value => { completed = true; return value; });
                    await timingPhase(entered, settled(pending)); expect(waiterPid).not.toBe(holder.processID);
                    await actualBlockedBy(waiterPid, holder.processID); h.state.now = atMillis(1000);
                    expect(completed).toBe(false); expect(h.f.state.borrows - h.f.state.releases).toBe(1);
                    const timeouts = h.f.state.trace.filter(event => isRuntimeTimeout(event.sql));
                    expect(timeouts.length).toBeGreaterThan(0); expect(timeouts.every(event => Number(event.params[0]) > 0)).toBe(true);
                    await holder.query('SELECT pg_advisory_unlock($1::integer, hashtext($2))', [71001, h.sessionSha256]); locked = false;
                    httpJson(await pending, 503, 'dashboard_unavailable');
                    expect(h.f.state.borrows).toBe(h.f.state.releases); expect(h.f.state.trace.at(-1).sql).toBe('ROLLBACK');
                    expect(await exportAll()).toEqual(before);
                } finally {
                    if (locked) await holder.query('SELECT pg_advisory_unlock($1::integer, hashtext($2))', [71001, h.sessionSha256]);
                    holder.release(); entered.resolve(); if (pending) await pending; h.f.state.hook = null;
                }
            });

            test('JP14 expired request in app A cannot poison a concurrent valid request in app B', async () => {
                await parallelHttp(async pool => {
                    const a = await httpSetup({ rawRuntimePool: pool, requestBudgetMs: 1000 });
                    const b = await httpSetup({ base: a.f, principal: { ...a.principal, oid: nextId() }, publish: false });
                    b.binding = await b.addBinding({ tenantId: 'http-budget-' + nextId(), organisationId: 'other-org' });
                    await Promise.all([a.initialize(), b.initialize()]); const generation = await b.select();
                    const entered = gate(), release = gate(0); let pending;
                    a.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
                    try {
                        pending = Promise.resolve(a.get('session')); await timingPhase(entered, settled(pending));
                        a.state.now = atMillis(1000); httpJson(await b.get('bootstrap', generation), 200);
                        release.resolve(); httpJson(await pending, 503, 'dashboard_unavailable');
                        httpJson(await b.get('bootstrap', generation), 200);
                    } finally { release.resolve(); entered.resolve(); if (pending) await pending; a.state.beforeLoad = null; }
                });
            });

            describe('Improvement Plan actual HTTP and native retained actions', () => {
                beforeAll(async () => {
                    // The governed migration is installed by this suite's
                    // existing unique disposable loopback database setup.
                    const selected = new URL(testUrl);
                    if (!['postgres:', 'postgresql:'].includes(selected.protocol) ||
                        !['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname) || selected.search || selected.hash) {
                        throw new Error('Improvement HTTP proof requires the existing loopback disposable PostgreSQL harness.');
                    }
                    const ledger = await ownerPool.query('SELECT migration_id FROM nofries.schema_migrations WHERE migration_id=$1',
                        ['0016_dashboard_improvement_plans.sql']);
                    expect(ledger.rows).toEqual([{ migration_id: '0016_dashboard_improvement_plans.sql' }]);
                });
                async function improvementHttpSetup(options = {}) {
                    const h = await ncscHttpSetup({ ...options, improvementEnabled: true });
                    httpJson(await h.ncscPost(createCommand()), 201);
                    const responses = require('../fixtures/ncscAssessmentFixture').allResponses('no');
                    httpJson(await h.ncscPost(saveCommand('assessment-a', 0, 'save-a', responses)), 200);
                    const submitted = await h.ncscPost(submitCommand()); httpJson(submitted, 200);
                    h.generateImprovement = () => ({ planId: 'plan-a', type: 'generate', operationId: 'generate-a',
                        expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-a',
                            assessmentRevision: submitted.body.assessment.revision,
                            assessmentRevisionSha256: submitted.body.assessment.revisionSha256 } });
                    h.improvementCommand = (plan, type, payload = {}, operationId = `${type}-${plan.revision}`) => ({
                        planId: plan.planId, type, operationId, expectedRevision: plan.revision,
                        actionId: plan.actions[0].actionId, payload });
                    h.improvementPost = (command, generation = h.generation) =>
                        h.post('improvement/execute', command).set(generationHeader, generation);
                    h.improvementGet = (method = 'list', filters = {}, generation = h.generation) => {
                        const values = { planId: 'plan-a', ...filters };
                        return h.get('improvement/' + method + '?' + Object.entries(values)
                            .map(([key, value]) => key + '=' + encodeURIComponent(String(value))).join('&'), generation);
                    };
                    return h;
                }
                async function improvementRows(h) {
                    const values = [h.binding.scope.tenantId, h.binding.scope.organisationId];
                    const result = {};
                    for (const table of ['dashboard_improvement_heads', 'dashboard_improvement_revisions']) {
                        result[table] = (await ownerPool.query(`SELECT to_jsonb(row_value) AS value FROM nofries.${table} row_value
                            WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY to_jsonb(row_value)::text`, values)).rows.map(row => row.value);
                    }
                    return result;
                }
                async function improvementSnapshot(h) {
                    return { ...await exportAll(), ...await improvementRows(h) };
                }
                // Optional local qualification only: normal CI does not register
                // a skipped case or require the optional browser tooling.
                if (process.env.NOFRIES_TEST_IMPROVEMENT_GENERATED_BROWSER === '1') {
                    require('./improvementPlanGeneratedBrowser')({ ncscHttpSetup, httpJson, testUrl,
                        getOwnerPool: () => ownerPool, loginClean, subject });
                }

                test('HTTP Improvement Plan stays absent by default without private native reads', async () => {
                    const h = await ncscHttpSetup(), boundary = h.f.state.trace.length, before = await improvementSnapshot(h);
                    httpJson(await h.get('improvement/list?planId=plan-a', h.generation), 404, 'dashboard_not_found');
                    httpJson(await h.get('improvement/view?planId=plan-a', h.generation), 404, 'dashboard_not_found');
                    httpJson(await h.post('improvement/execute', {}).set(generationHeader, h.generation), 404, 'dashboard_not_found');
                    expect(h.f.state.trace).toHaveLength(boundary); expect(await improvementSnapshot(h)).toEqual(before);
                    await loginClean();
                });

                test('HTTP Improvement commands, retained list/view and replay use the same real rows and transaction-paired native audit', async () => {
                    const h = await improvementHttpSetup(), original = await exportAll();
                    const generated = await h.improvementPost(h.generateImprovement()); httpJson(generated, 200);
                    expect(generated.body.plan).toMatchObject({ planId: 'plan-a', revision: 0 });
                    expect(generated.body.plan.actions.length).toBeGreaterThan(0);
                    const actor = subject(h.principal), assigned = await h.improvementPost(h.improvementCommand(generated.body.plan, 'assign', {
                        ownerSubjectKey: actor, dueDate: '2026-09-06' })); httpJson(assigned, 200);
                    const started = await h.improvementPost(h.improvementCommand(assigned.body.plan, 'start')); httpJson(started, 200);
                    const blocked = await h.improvementPost(h.improvementCommand(started.body.plan, 'block', {
                        reason: 'Synthetic dependency awaiting review.' })); httpJson(blocked, 200);
                    const filtered = await h.improvementGet('list', { status: 'blocked', owner: actor, overdueOnly: true }); httpJson(filtered, 200);
                    expect(filtered.body.actions).toHaveLength(1);
                    expect(filtered.body.actions[0]).toMatchObject({ status: 'blocked', ownerSubjectKey: actor,
                        dueDate: '2026-09-06', isOverdue: true, blockedReason: 'Synthetic dependency awaiting review.' });
                    const completed = await h.improvementPost(h.improvementCommand(blocked.body.plan, 'complete', {
                        note: 'Synthetic completion awaiting evidence review.', evidenceReference: 'synthetic:evidence:completion' }));
                    httpJson(completed, 200);
                    const reopened = await h.improvementPost(h.improvementCommand(completed.body.plan, 'reopen', {
                        reason: 'Synthetic review requires follow-up.' })); httpJson(reopened, 200);
                    const listed = await h.improvementGet(); httpJson(listed, 200);
                    const action = listed.body.actions.find(row => row.actionId === assigned.body.plan.actions[0].actionId);
                    expect(listed.body).toMatchObject({ planRevision: 5, scope: { ...h.binding.scope, planId: 'plan-a' },
                        priority: { status: 'not_calculated', reason: 'priority_adapter_required' } });
                    expect(action).toMatchObject({ status: 'open', ownerSubjectKey: actor,
                        evidence: { completionVerification: 'not_recorded', downloadAllowed: false, scoreEffect: 'none' } });
                    expect(action.history.map(row => row.type)).toEqual(['assign', 'start', 'block', 'complete', 'reopen']);
                    const view = await h.improvementGet('view'); httpJson(view, 200);
                    const readable = view.body.actions.find(row => row.actionId === action.actionId);
                    expect(view.body).toMatchObject({ presentationVersion: 1, planRevision: 5 });
                    expect(readable.history.map(row => row.label)).toEqual(['Assigned', 'Started', 'Blocked', 'Completed', 'Reopened']);

                    const beforeReplay = await improvementSnapshot(h), replay = await h.improvementPost(h.generateImprovement());
                    httpJson(replay, 200); expect(replay.body).toEqual(generated.body);
                    expect(await improvementSnapshot(h)).toEqual(beforeReplay);
                    const after = await exportAll();
                    for (const table of [...DATA_TABLES, ...NCSC_TABLES]) expect(after[table]).toEqual(original[table]);
                    const revisions = (await ownerPool.query(`SELECT revision,xmin::text AS transaction_id
                        FROM nofries.dashboard_improvement_revisions WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY revision`,
                    [h.binding.scope.tenantId, h.binding.scope.organisationId])).rows;
                    const audits = (await ownerPool.query(`SELECT payload,xmin::text AS transaction_id,session_sha256,authority_id
                        FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1 AND payload->>'module'='improvement_plan'`,
                    [h.sessionSha256])).rows;
                    expect(revisions.map(row => row.revision)).toEqual([0, 1, 2, 3, 4, 5]);
                    expect(audits.filter(row => row.payload.action === 'improvement.write').map(row => row.transaction_id).sort())
                        .toEqual(revisions.map(row => row.transaction_id).sort());
                    expect(audits.filter(row => row.payload.action === 'improvement.read')).toHaveLength(3);
                    for (const row of audits) expect(row).toMatchObject({ session_sha256: h.sessionSha256,
                        authority_id: h.binding.prepared.command.authorityRef.authorityId,
                        payload: { actorSubjectKey: actor, ...h.binding.scope, module: 'improvement_plan', result: 'succeeded' } });
                    expect(h.f.state.borrows).toBe(h.f.state.releases); await loginClean();
                });

                test('HTTP Improvement denies missing parent, stale generation, foreign origin and forged scope without action effects', async () => {
                    const h = await improvementHttpSetup(), before = await improvementSnapshot(h);
                    httpJson(await h.get('improvement/list?planId=plan-a', h.generation, null), 401, 'dashboard_authentication_required');
                    httpJson(await h.get('improvement/list?planId=plan-a'), 403, 'dashboard_access_denied');
                    httpJson(await h.improvementPost(h.generateImprovement(), digest('synthetic-wrong-generation')), 403, 'improvement_access_denied');
                    httpJson(await h.improvementPost(h.generateImprovement()).set('Origin', 'https://foreign.invalid'), 403, 'dashboard_access_denied');
                    httpJson(await h.improvementPost({ ...h.generateImprovement(), tenantId: 'forged-tenant' }), 400, 'improvement_input_invalid');
                    httpJson(await h.get('improvement/list?planId=plan-a&tenantId=forged-tenant', h.generation), 400, 'dashboard_input_invalid');
                    expect(await improvementSnapshot(h)).toEqual(before); await loginClean();
                });

                test('HTTP Improvement list and commands follow current selected tenant rather than caller plan identifiers', async () => {
                    const h = await improvementHttpSetup(), generated = await h.improvementPost(h.generateImprovement()); httpJson(generated, 200);
                    const firstBinding = h.binding;
                    const other = await h.addBinding({ tenantId: 'improvement-http-other-' + nextId(), organisationId: firstBinding.scope.organisationId });
                    const generation = await h.select(other, h.generation), before = await improvementSnapshot(h);
                    httpJson(await h.improvementGet('list', {}, h.generation), 403, 'improvement_list_access_denied');
                    httpJson(await h.improvementGet('list', {}, generation), 404, 'improvement_list_not_found');
                    httpJson(await h.improvementPost(h.improvementCommand(generated.body.plan, 'assign', {
                        ownerSubjectKey: subject(h.principal), dueDate: '2026-09-08' }), generation), 404, 'improvement_not_found');
                    expect(await improvementSnapshot(h)).toEqual(before);
                    const originalRows = await improvementRows(h);
                    expect(originalRows.dashboard_improvement_revisions).toHaveLength(1); await loginClean();
                });

                test('HTTP Improvement current module revocation blocks reads and commands without retained effects', async () => {
                    const h = await improvementHttpSetup(), generated = await h.improvementPost(h.generateImprovement()); httpJson(generated, 200);
                    const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
                        authoriseAdministration: command => ['authority.read', 'flags.update'].includes(command.type) && command.tenantId === h.binding.scope.tenantId
                            && command.organisationId === h.binding.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
                    // NCSC submission advances usage after the original seed.
                    // Bind this sole flag change to the current canonical vector.
                    const current = await repository.readAuthoritySnapshot(h.binding.scope,
                        { authenticated: true, subjectKey: subject(h.principal) });
                    await repository.executeAuthorityCommand({ ...h.binding.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
                        type: 'flags.update', expectedRevisions: clone(current.revisions), payload: { ...clone(current.snapshot.flags),
                            revision: current.revisions.flags + 1, enabled: { ...current.snapshot.flags.enabled, improvement_plan: false } } });
                    const before = await improvementSnapshot(h);
                    httpJson(await h.improvementGet(), 403, 'improvement_list_access_denied');
                    httpJson(await h.improvementGet('view'), 403, 'improvement_list_access_denied');
                    httpJson(await h.improvementPost(h.improvementCommand(generated.body.plan, 'assign', {
                        ownerSubjectKey: subject(h.principal), dueDate: '2026-09-08' })), 403, 'improvement_access_denied');
                    expect(await improvementSnapshot(h)).toEqual(before); await loginClean();
                });

                test('HTTP Improvement audit failure after actual insertion rolls back action revision and audit together', async () => {
                    const h = await improvementHttpSetup(), before = await improvementSnapshot(h); let failed = false;
                    h.f.state.hook = event => {
                        if (!failed && event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)
                            && JSON.parse(event.params.at(-1)).action === 'improvement.write') {
                            failed = true; throw new Error('Synthetic HTTP action audit insertion failure');
                        }
                    };
                    let outcome;
                    try { outcome = await h.improvementPost(h.generateImprovement()); } finally { h.f.state.hook = null; }
                    expect(failed).toBe(true); httpJson(outcome, 503, 'improvement_unavailable');
                    expect(await improvementSnapshot(h)).toEqual(before);
                    httpJson(await h.improvementPost(h.generateImprovement()), 200);
                    expect((await improvementRows(h)).dashboard_improvement_revisions).toHaveLength(1); await loginClean();
                });

                test.each(['before', 'after'])('HTTP Improvement lost COMMIT %s acknowledgement retains source reconciliation without repeat writes', async phase => {
                    const h = await improvementHttpSetup(), before = await improvementSnapshot(h);
                    let armed = false, failed = false; const recovery = [];
                    h.f.state.hook = event => {
                        if (failed && event.phase === 'before') recovery.push(event.sql);
                        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_improvement_revisions\b/.test(event.sql)) armed = true;
                        if (!failed && armed && event.sql === 'COMMIT' && event.phase === phase) {
                            failed = true; throw new Error('Synthetic HTTP improvement COMMIT acknowledgement loss');
                        }
                    };
                    let outcome;
                    try { outcome = await h.improvementPost(h.generateImprovement()); } finally { h.f.state.hook = null; }
                    expect(failed).toBe(true);
                    expect(recovery.filter(sql => /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+nofries\./i.test(sql))).toEqual([]);
                    if (phase === 'before') {
                        httpJson(outcome, 503, 'improvement_outcome_ambiguous'); expect(await improvementSnapshot(h)).toEqual(before);
                    } else {
                        httpJson(outcome, 200);
                        expect((await improvementRows(h)).dashboard_improvement_revisions).toHaveLength(1);
                    }
                    const retried = await h.improvementPost(h.generateImprovement()); httpJson(retried, 200);
                    if (phase === 'after') expect(retried.body).toEqual(outcome.body);
                    expect((await improvementRows(h)).dashboard_improvement_revisions).toHaveLength(1); await loginClean();
                });

                test('HTTP Improvement editor exposes current self assignment and all retained progress transitions with paired audit', async () => {
                    const h = await improvementHttpSetup();
                    const generated = await h.improvementPost(h.generateImprovement()); httpJson(generated, 200);
                    let plan = generated.body.plan;
                    const actionId = plan.actions[0].actionId, actor = subject(h.principal);
                    const check = async expected => {
                        const response = await h.improvementGet('editor'); httpJson(response, 200);
                        expect(Object.keys(response.body).sort()).toEqual(['actions', 'asOf', 'canWrite', 'ownerChoices', 'planRevision', 'schemaVersion', 'scope']);
                        expect(response.body).toMatchObject({ schemaVersion: 1, scope: { ...h.binding.scope, planId: plan.planId },
                            planRevision: plan.revision, canWrite: true, ownerChoices: [{ subjectKey: actor, label: 'Assign to me' }] });
                        expect(response.body.actions.find(row => row.actionId === actionId).commands).toEqual(expected);
                        expect(response.body.actions.map(row => row.actionId).sort()).toEqual(plan.actions.map(row => row.actionId).sort());
                    };
                    await check(['assign']);
                    for (const [type, payload, expected] of [
                        ['assign', { ownerSubjectKey: actor, dueDate: '2026-09-08' }, ['assign', 'start']],
                        ['start', {}, ['assign', 'block', 'complete']],
                        ['block', { reason: 'Synthetic dependency requires review.' }, ['assign', 'start', 'complete']],
                        ['complete', { note: 'Synthetic completion awaits evidence review.', evidenceReference: 'synthetic:evidence:editor' }, ['reopen']],
                        ['reopen', { reason: 'Synthetic review requests more work.' }, ['assign', 'start']]
                    ]) {
                        const response = await h.improvementPost(h.improvementCommand(plan, type, payload)); httpJson(response, 200);
                        plan = response.body.plan; await check(expected);
                    }
                    const view = await h.improvementGet('view'); httpJson(view, 200);
                    const action = view.body.actions.find(row => row.actionId === actionId);
                    expect(action).toMatchObject({ status: 'open', ownerSubjectKey: actor, dueDate: '2026-09-08' });
                    expect(action.history.map(row => row.type)).toEqual(['assign', 'start', 'block', 'complete', 'reopen']);
                    expect((await improvementRows(h)).dashboard_improvement_revisions).toHaveLength(6);
                    const audits = (await rows('dashboard_runtime_audit', 'session_sha256', h.sessionSha256));
                    expect(audits.filter(row => row.payload.action === 'improvement.write')).toHaveLength(6);
                    expect(audits.filter(row => row.payload.action === 'improvement.read')).toHaveLength(7);
                    const before = await improvementSnapshot(h);
                    httpJson(await h.improvementPost({ ...h.improvementCommand(plan, 'assign', { ownerSubjectKey: actor, dueDate: '2026-09-09' }),
                        expectedRevision: 0 }), 409, 'improvement_revision_conflict');
                    expect(await improvementSnapshot(h)).toEqual(before); await loginClean();
                });

                test('HTTP Improvement editor refuses forged selectors and stale or foreign selection before exposing owner metadata', async () => {
                    const h = await improvementHttpSetup(); httpJson(await h.improvementPost(h.generateImprovement()), 200);
                    let boundary = h.f.state.trace.length;
                    httpJson(await h.improvementGet('editor', { ownerSubjectKey: subject(h.principal) }), 400, 'dashboard_input_invalid');
                    expect(h.f.state.trace).toHaveLength(boundary);
                    httpJson(await h.improvementGet('editor', { planId: 'missing-plan' }), 404, 'improvement_not_found');
                    const other = await h.addBinding({ tenantId: 'editor-other-' + nextId(), organisationId: h.binding.scope.organisationId });
                    const generation = await h.select(other, h.generation);
                    httpJson(await h.get('improvement/editor?planId=plan-a', h.generation), 403, 'improvement_list_access_denied');
                    httpJson(await h.get('improvement/editor?planId=plan-a', generation), 404, 'improvement_not_found');
                    expect((await improvementRows(h)).dashboard_improvement_revisions).toHaveLength(1); await loginClean();
                });

                test('HTTP Improvement plan index reloads retained identities and pages them before selecting the same native detail', async () => {
                    const h = await improvementHttpSetup(), generated = {};
                    for (const planId of ['plan-c', 'plan-a', 'plan-b']) {
                        const result = await h.improvementPost({ ...h.generateImprovement(), planId, operationId: 'generate-' + planId });
                        httpJson(result, 200); generated[planId] = result.body;
                    }
                    const assigned = await h.improvementPost(h.improvementCommand(generated['plan-b'].plan, 'assign', {
                        ownerSubjectKey: subject(h.principal), dueDate: '2026-09-08' }, 'assign-plan-b')); httpJson(assigned, 200);

                    // Recreate the actual server and complete a fresh callback,
                    // native initialization and selection over the same records.
                    // Nothing maps an assessment ID or browser storage to a plan.
                    const restarted = await httpSetup({ base: h.f, principal: h.principal, publish: false,
                        ncsc: { resolveSubmissionQuota: h.quota.resolveSubmissionQuota }, improvementEnabled: true });
                    restarted.binding = h.binding; await restarted.initialize(); const generation = await restarted.select();
                    const first = await restarted.get('improvement/plans?limit=2', generation); httpJson(first, 200);
                    expect(first.body).toMatchObject({ schemaVersion: 1, scope: h.binding.scope,
                        plans: [{ planId: 'plan-a', planRevision: 0 }, { planId: 'plan-b', planRevision: 1 }], nextAfterPlanId: 'plan-b' });
                    const last = await restarted.get('improvement/plans?limit=2&afterPlanId=' + encodeURIComponent(first.body.nextAfterPlanId), generation);
                    httpJson(last, 200); expect(last.body).toMatchObject({ plans: [{ planId: 'plan-c', planRevision: 0 }], nextAfterPlanId: null });
                    const selected = first.body.plans.find(plan => plan.planId === 'plan-b');
                    const view = await restarted.get('improvement/view?planId=' + encodeURIComponent(selected.planId), generation); httpJson(view, 200);
                    expect(view.body).toMatchObject({ planRevision: assigned.body.plan.revision,
                        scope: { ...h.binding.scope, planId: selected.planId } });
                    expect(view.body.actions.find(action => action.actionId === assigned.body.plan.actions[0].actionId).ownerSubjectKey)
                        .toBe(subject(h.principal));
                    const before = await improvementSnapshot(h);
                    const replay = await h.improvementPost({ ...h.generateImprovement(), planId: 'plan-b', operationId: 'generate-plan-b' });
                    httpJson(replay, 200); expect(replay.body).toEqual(generated['plan-b']); expect(await improvementSnapshot(h)).toEqual(before);
                    const reads = (await rows('dashboard_runtime_audit', 'session_sha256', restarted.sessionSha256))
                        .filter(row => row.payload.action === 'improvement.read');
                    expect(reads).toHaveLength(3);
                    for (const row of reads) expect(row.payload).toMatchObject({ ...h.binding.scope,
                        actorSubjectKey: subject(h.principal), module: 'improvement_plan', result: 'succeeded' });
                    expect((await improvementRows(h)).dashboard_improvement_heads).toHaveLength(3); await loginClean();
                });

                test('HTTP Improvement plan index applies current tenant selection, generation and revocation to every page', async () => {
                    const h = await improvementHttpSetup(); httpJson(await h.improvementPost(h.generateImprovement()), 200);
                    const other = await h.addBinding({ tenantId: 'improvement-index-other-' + nextId(), organisationId: h.binding.scope.organisationId });
                    const generation = await h.select(other, h.generation);
                    httpJson(await h.get('improvement/plans?limit=1', h.generation), 403, 'improvement_list_access_denied');
                    const empty = await h.get('improvement/plans?limit=1', generation); httpJson(empty, 200);
                    expect(empty.body).toMatchObject({ scope: other.scope, plans: [], nextAfterPlanId: null });

                    const seed = other.prepared.canonicalSeed;
                    const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
                        authoriseAdministration: command => command.type === 'flags.update' && command.tenantId === other.scope.tenantId
                            && command.organisationId === other.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
                    await repository.executeAuthorityCommand({ ...other.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
                        type: 'flags.update', expectedRevisions: clone(seed.result.resultRevisions), payload: { ...clone(seed.initial.flags),
                            revision: seed.result.resultRevisions.flags + 1, enabled: { ...seed.initial.flags.enabled, improvement_plan: false } } });
                    const before = await improvementSnapshot(h);
                    httpJson(await h.get('improvement/plans?limit=1', generation), 403, 'improvement_list_access_denied');
                    expect(await improvementSnapshot(h)).toEqual(before);
                    expect((await improvementRows(h)).dashboard_improvement_heads).toHaveLength(1); await loginClean();
                });
            });
        });

        test('initializes fenced instance, enables explicitly, and retains original operator issuance across gate retry', async () => {
            const f = fixture;
            const init = f.instanceCommand(), first = await f.maintenance.initializeRuntimeInstance(init);
            expect(first).toMatchObject({ outcome: 'initialized', record: { instanceId: f.instanceId, revision: 0, ingressStatus: 'fenced' } });
            deeplyFrozen(first);
            await unchangedFailure(() => f.repository.readSession(f.operator()));
            const enable = f.instanceCommand(first.record), enabled = await f.maintenance.enableRuntimeIngress(enable);
            expect(enabled).toMatchObject({ outcome: 'enabled', record: { revision: 1, ingressStatus: 'enabled' } });
            const before = await exportAll();
            expect(await f.repository.readSession(f.operator())).toEqual({ schemaVersion: 1, state: 'initialization_required' });
            expect(await exportAll()).toEqual(before); // No gate means no possible gate-referencing audit.
            const command = { operationId: nextId() }, result = await f.repository.initializeOperatorSession(f.operator(), command);
            expect(result.record).toMatchObject({ kind: 'operator_dashboard', revision: 0, selectedBindingId: null,
                operatorIssuanceSha256: hash(f.operatorSeed.operatorIssuanceProof) });
            const saved = await exportAll(), ids = f.state.ids, tokens = f.state.tokens;
            expect(await f.repository.initializeOperatorSession(f.operator(), command)).toEqual(result);
            expect(await exportAll()).toEqual(saved); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
        });

        test('missing original issuance cannot recreate an absent operator gate, and proofless logout leaves a permanent tombstone', async () => {
            const f = fixture; await f.initialize();
            const seed = f.session('operator_dashboard', f.operatorIdentity, null, true), request = f.request(seed);
            await unchangedFailure(() => f.repository.initializeOperatorSession(request, { operationId: nextId() }));
            const command = { operationId: nextId() }, tombstone = await f.repository.revokeSession(request, command);
            expect(tombstone.record).toMatchObject({ kind: 'operator_dashboard', status: 'revoked', revision: 0, operatorIssuanceSha256: null });
            const before = await exportAll();
            expect(await f.repository.revokeSession(f.request(seed), command)).toEqual(tombstone);
            expect(await exportAll()).toEqual(before);
            const forged = { ...seed, operatorIssuanceProof: { ...f.operatorSeed.operatorIssuanceProof, sessionSha256: seed.sessionSha256 } };
            await unchangedFailure(() => f.repository.initializeOperatorSession(f.request(forged), { operationId: nextId() }));
        });

        test('all bootstrap acceptance effects, original DATA reference, typed binding and runtime receipt commit once', async () => {
            const f = fixture; f.state.now = atMillis(-200); await f.initialize();
            const prepared = await f.approve(await f.bind(await f.createCase()));
            const acceptCommand = { operationId: nextId(), approvalId: prepared.approveCommand.approvalId, approvalRevision: 2 };
            const boundary = f.state.trace.length; let routed = false;
            f.state.hook = event => { if (!routed && event.phase === 'after' && event.sql === 'COMMIT') { routed = true; f.state.now = NOW; } };
            const example = { ...prepared, acceptCommand, accepted: await f.repository.acceptStagedOnboarding(f.request(prepared.discoverySeed, prepared.proof), acceptCommand) };
            f.state.hook = null; expect(routed).toBe(true);
            const completeTrace = f.state.trace.slice(boundary), business = completeTrace.slice(completeTrace.findLastIndex(row => row.sql === 'BEGIN'));
            expectRemainingPreparations(business, 59800);
            expect(business.some(row => /set_config\('nofries.tenant_id'/.test(row.sql))).toBe(true);
            expect(business.some(row => /INSERT INTO nofries.dashboard_membership_states/.test(row.sql))).toBe(true);
            expect(business.at(-1).sql).toBe('COMMIT');
            expect(example.accepted).toEqual({ case: { caseId: example.command.caseId, revision: 3,
                headSha256: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'accepted' },
                binding: { bindingId: example.selected.bindingId, membershipId: example.selected.membership.membershipId,
                    revision: 0, status: 'active', updatedAt: NOW }, acceptedAt: NOW });
            deeplyFrozen(example.accepted);
            const stored = await exportAll();
            const membership = stored.dashboard_membership_states.find(row => row.tenant_id === f.scope.tenantId);
            expect(membership).toBeDefined();
            const members = membership.payload || membership.state || membership.membership_state;
            expect(JSON.stringify(members)).toContain(subject(f.customerIdentity));
            const canonicalReceipt = stored.dashboard_operation_receipts.filter(row => row.tenant_id === f.scope.tenantId);
            expect(canonicalReceipt).toHaveLength(1);
            const receipts = stored.dashboard_runtime_receipts.filter(row => row.payload && row.payload.instanceId === f.instanceId);
            const acceptance = receipts.find(row => row.payload.operationType === 'acceptStagedOnboarding').payload;
            expect(acceptance.result).toEqual(example.accepted);
            expect(acceptance.originalFacts.dataReference).toMatchObject({ schemaVersion: 1, operationType: 'organisation.initialise', ...f.scope,
                intentSha256: expect.stringMatching(/^[a-f0-9]{64}$/), resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
            expect(domain.normaliseAcceptanceReceipt(acceptance.originalFacts.domainReceipt).effect.initialState.membershipState.memberships)
                .toEqual(members.memberships);
            const core = { ...acceptance }; delete core.receiptSha256;
            expect(hash(core)).toBe(acceptance.receiptSha256);
            const ids = f.state.ids, tokens = f.state.tokens;
            expect(await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), example.acceptCommand)).toEqual(example.accepted);
            expect(await exportAll()).toEqual(stored); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
        });

        test('a fresh customer with no gate locates only its own binding, activates, selects and replays without resetting a later selection', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const successor = await f.accepted(template({ tenantId: f.scope.tenantId + '-selection-c', organisationId: f.scope.organisationId }, nextId()));
            const seed = f.session('customer', f.customerIdentity), absent = f.request(seed);
            await unchangedFailure(() => f.repository.discoverBindings(absent, { limit: 10, afterBindingId: null }));
            const activate = { operationId: nextId(), bindingId: example.selected.bindingId };
            const activation = await f.repository.activateCustomerSession(absent, activate);
            expect(activation.record).toMatchObject({ kind: 'customer', selectedBindingId: example.selected.bindingId, revision: 0 });
            const selected = { operationId: nextId(), bindingId: example.selected.bindingId, expectedGeneration: activation.record.generationToken };
            const first = await f.repository.selectBinding(f.request(seed), selected);
            const second = await f.repository.selectBinding(f.request(seed), { ...selected, bindingId: successor.selected.bindingId, operationId: nextId(), expectedGeneration: first.record.generationToken });
            expect(second.record.revision).toBe(2);
            const before = await exportAll(), ids = f.state.ids, tokens = f.state.tokens;
            expect(await f.repository.selectBinding(f.request(seed), selected)).toEqual(first);
            expect(await exportAll()).toEqual(before); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            expect(await f.repository.readSession(f.request(seed))).toEqual({ schemaVersion: 1, state: 'ready', purpose: 'customer',
                expiresAt: END, generation: second.record.generationToken, selectedBindingId: successor.selected.bindingId });
            expect(await f.repository.discoverBindings(f.request(seed), { limit: 2, afterBindingId: null })).toEqual({ schemaVersion: 1,
                bindings: [example.selected.bindingId, successor.selected.bindingId].sort().map(bindingId => ({ bindingId, organisationLabel: 'Synthetic organisation' })), nextAfterBindingId: null });
            await unchangedFailure(() => f.repository.selectBinding(f.request(seed), { ...selected, operationId: nextId() }), 'onboarding_conflict', 409);
            await f.repository.revokeCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId,
                expectedRevision: 3, expectedHeadSha256: example.accepted.case.headSha256, authorityRef: example.authorityRef });
            const terminal = await exportAll(), terminalIds = f.state.ids, terminalTokens = f.state.tokens;
            await unchangedFailure(() => f.repository.selectBinding(f.request(seed), selected));
            expect(f.state.ids).toBe(terminalIds); expect(f.state.tokens).toBe(terminalTokens);
            expect(terminal.dashboard_runtime_receipts.find(row => row.operation_id === selected.operationId))
                .toEqual(before.dashboard_runtime_receipts.find(row => row.operation_id === selected.operationId));
            expect(await f.repository.readSession(f.request(seed))).toMatchObject({ selectedBindingId: successor.selected.bindingId,
                generation: second.record.generationToken });
        });

        test.each(['foreign subject', 'same subject changed policy', 'revoked gate'])('directory/activation reject %s without disclosing scope or mutating rows', async variant => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const principal = clone(f.customerIdentity);
            if (variant === 'foreign subject') principal.oid = nextId();
            if (variant === 'same subject changed policy') principal.policyRevision++;
            const seed = f.session('customer', principal);
            if (variant === 'revoked gate') {
                await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId });
                await f.repository.revokeSession(f.request(seed), { operationId: nextId() });
            }
            await unchangedFailure(() => f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId }));
            await unchangedFailure(() => f.repository.discoverBindings(f.request(seed), { limit: 10, afterBindingId: null }));
        });

        test('directory keyset pages retain both exact-identity organisations without returning their scope', async () => {
            const f = fixture; await f.initialize(); const first = await f.accepted();
            const second = await f.accepted(template({ tenantId: f.scope.tenantId + '-second', organisationId: f.scope.organisationId }, nextId()));
            const seed = f.session('customer', f.customerIdentity);
            await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: first.selected.bindingId });
            const page1 = await f.repository.discoverBindings(f.request(seed), { limit: 1, afterBindingId: null });
            expect(page1.bindings).toHaveLength(1); expect(page1.nextAfterBindingId).toBe(page1.bindings[0].bindingId);
            const page2 = await f.repository.discoverBindings(f.request(seed), { limit: 1, afterBindingId: page1.nextAfterBindingId });
            expect(page2.nextAfterBindingId).toBeNull();
            expect([...page1.bindings, ...page2.bindings].map(row => row.bindingId)).toEqual([first.selected.bindingId, second.selected.bindingId].sort());
            for (const row of [...page1.bindings, ...page2.bindings]) expect(Object.keys(row).sort()).toEqual(['bindingId', 'organisationLabel']);
        });

        test('capability lookup hashes decoded 32 bytes and remains a locator without capture, gate or audit', async () => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            const before = await exportAll(), captures = f.state.captures;
            expect(await f.repository.lookupCaseCapability({ capability: example.capability })).toEqual({ caseId: example.command.caseId,
                scope: f.scope, status: 'awaiting_identity', acceptBefore: ACCEPT_BEFORE });
            expect(await f.repository.lookupCaseCapability({ capability: Buffer.alloc(32, 71).toString('base64url') })).toBeNull();
            expect(f.state.captures).toBe(captures); expect(await exportAll()).toEqual(before);
        });

        test('compound proof, first case bind and discovery gate share one immutable operation and exact retry', async () => {
            const f = fixture; await f.initialize(); const example = await f.bind(await f.createCase());
            expect(example.bound).toMatchObject({ case: { caseId: example.command.caseId, revision: 1, status: 'identity_verified' },
                proof: { proofId: example.proof.proofId, proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, caseOutcome: 'bound' });
            expect(example.bound.proof.proofSha256).toBe(domain.createIdentityProof(example.proof).proofSha256);
            const before = await exportAll(), ids = f.state.ids, tokens = f.state.tokens;
            expect(await f.repository.recordProofAndActivateDiscovery(f.request(example.discoverySeed, example.proof), example.bindCommand)).toEqual(example.bound);
            expect(await exportAll()).toEqual(before); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            await unchangedFailure(() => f.repository.discoverBindings(f.request(example.discoverySeed, example.proof), { limit: 10, afterBindingId: null }));
        });

        test.each(['different session', 'reused authentication', 'same subject changed identity'])('compound proof cannot adopt %s occurrence', async variant => {
            const f = fixture; await f.initialize(); const example = await f.bind(await f.createCase());
            let proof = clone(example.proof), seed = clone(example.discoverySeed), command = { operationId: nextId() };
            if (variant === 'different session') { seed.sessionSha256 = digest(nextId()); command = example.bindCommand; }
            else {
                proof = { ...proof, proofId: nextId(), caseRevision: 1, operationId: command.operationId };
                if (variant === 'same subject changed identity') { proof.identity.policyRevision++; proof.authenticationSha256 = digest(nextId()); seed.identityPayload = clone(proof.identity); }
                seed = f.discoverySession(proof);
            }
            const before = await exportAll(); const outcome = await settled(f.repository.recordProofAndActivateDiscovery(f.request(seed, proof), command));
            expect(outcome.error).toBeInstanceOf(domain.DashboardOnboardingError);
            expect([403, 409]).toContain(outcome.error.statusCode); expect(await exportAll()).toEqual(before);
        });

        test('existing-organisation acceptance preserves original members, nonmembership authority and DATA receipt', async () => {
            const f = fixture; await f.initialize(); const original = await f.seedCanonical();
            const before = await exportAll();
            const example = await f.accepted(template(f.scope, nextId(), 'existing_organisation'));
            const after = await exportAll();
            for (const table of ['dashboard_tenants', 'dashboard_organisations', 'dashboard_entitlement_states', 'dashboard_feature_flags',
                'dashboard_advisor_assignments', 'dashboard_usage', 'dashboard_operation_receipts']) expect(after[table]).toEqual(before[table]);
            const state = after.dashboard_membership_states.find(row => row.tenant_id === f.scope.tenantId).payload;
            expect(state.memberships).toContainEqual(original.initial.membershipState.memberships[0]);
            expect(state.memberships).toHaveLength(2);
            expect(state.memberships.find(row => row.membershipId === example.selected.membership.membershipId).subjectKey).toBe(subject(f.customerIdentity));
            const receipt = after.dashboard_runtime_receipts.find(row => row.operation_id === example.acceptCommand.operationId).payload;
            expect(receipt.originalFacts.dataReference).toBeNull();
        });

        test.each(['revokeCase', 'denyCase', 'expireCase'])('%s can perform terminal cleanup after admission withdrawal and acceptance expiry', async method => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            const withdrawal = f.admissionCommand(example.selected, example.admission.record);
            const withdrawn = await f.maintenance.withdrawAdmissionDecision(withdrawal);
            f.state.now = '2026-09-07T05:00:00.000Z';
            const command = { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 0, expectedHeadSha256: example.result.case.headSha256 };
            if (method !== 'expireCase') command.authorityRef = { authorityId: withdrawn.record.authorityId,
                revision: withdrawn.record.revision, sha256: withdrawn.record.decisionSha256 };
            const result = await f.repository[method](f.operator(), command);
            expect(result.case.status).toBe(method === 'revokeCase' ? 'revoked' : method === 'denyCase' ? 'denied' : 'expired');
            expect(result.case.revision).toBe(1); expect(result.binding).toBeNull();
            const before = await exportAll();
            expect(await f.repository[method](f.operator(), command)).toEqual(result);
            expect(await exportAll()).toEqual(before);
        });

        test('premature expire keeps 1A access-denied classification and status read does not expire a case', async () => {
            const f = fixture; await f.initialize(); const example = await f.bind(await f.createCase(undefined, { acceptBefore: atMillis(1000) }), { freshUntil: atMillis(10000) });
            await unchangedFailure(() => f.repository.expireCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId,
                expectedRevision: 1, expectedHeadSha256: example.bound.case.headSha256 }));
            const before = (await exportAll()).dashboard_onboarding_decisions; f.state.now = atMillis(1000);
            const result = await f.repository.readOnboardingStatus(f.request(example.discoverySeed, example.proof));
            expect(result).toEqual({ schemaVersion: 1, status: 'identity_verified', approval: null, receipt: null });
            expect((await exportAll()).dashboard_onboarding_decisions).toEqual(before);
        });

        test('accepted revoke atomically removes canonical member and binding while preserving acceptance history', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const before = await exportAll();
            for (const method of ['denyCase', 'expireCase']) {
                const command = { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 3, expectedHeadSha256: example.accepted.case.headSha256 };
                if (method === 'denyCase') command.authorityRef = example.authorityRef;
                await unchangedFailure(() => f.repository[method](f.operator(), command), 'onboarding_conflict', 409);
            }
            const command = { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 3,
                expectedHeadSha256: example.accepted.case.headSha256, authorityRef: example.authorityRef };
            f.state.now = '2026-09-07T05:00:00.000Z';
            const revoked = await f.repository.revokeCase(f.operator(), command);
            expect(revoked).toMatchObject({ case: { revision: 4, status: 'revoked' }, binding: { bindingId: example.selected.bindingId, status: 'revoked', revision: 1 } });
            const after = await exportAll();
            expect(after.dashboard_operation_receipts).toEqual(before.dashboard_operation_receipts);
            expect(after.dashboard_runtime_receipts.find(row => row.operation_id === example.acceptCommand.operationId))
                .toEqual(before.dashboard_runtime_receipts.find(row => row.operation_id === example.acceptCommand.operationId));
            expect(after.dashboard_membership_states.find(row => row.tenant_id === f.scope.tenantId).payload.memberships[0].status).toBe('removed');
            const replayIds = f.state.ids, replayTokens = f.state.tokens;
            expect(await f.repository.revokeCase(f.operator(), command)).toEqual(revoked);
            expect(await exportAll()).toEqual(after); expect(f.state.ids).toBe(replayIds); expect(f.state.tokens).toBe(replayTokens);
            await unchangedFailure(() => f.repository.readOnboardingStatus(f.request(example.discoverySeed, example.proof)));
            await unchangedFailure(() => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), example.acceptCommand));
        });

        test.each(['false', 'truthy', 'Promise', 'thenable', 'throw'])('named operator policy %s denies and rolls back every candidate row', async kind => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            let hooks = 0;
            const answers = { false: () => false, truthy: () => 1, Promise: () => Promise.resolve(true),
                thenable: () => ({ then() { hooks++; } }), throw: () => { throw new Error('synthetic driver credential'); } };
            const repository = instantiate({ ...f.options, authoriseOperatorOperation: answers[kind] });
            await unchangedFailure(() => repository.denyCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId,
                expectedRevision: 0, expectedHeadSha256: example.result.case.headSha256, authorityRef: example.authorityRef }));
            expect(hooks).toBe(0);
        });

        test.each(['false', 'Promise', 'throw'])('maintenance policy %s cannot initialize an enabled or provisional instance', async kind => {
            const f = fixture;
            const authoriseMaintenanceOperation = kind === 'false' ? () => false : kind === 'Promise' ? () => Promise.resolve(true)
                : () => { throw new Error('synthetic driver credential'); };
            const maintenance = instantiate({ ...f.maintenanceOptions, authoriseMaintenanceOperation }, true);
            await unchangedFailure(() => maintenance.initializeRuntimeInstance(f.instanceCommand()));
        });

        test.each(['proof', 'gate', 'audit', 'receipt'])('compound %s insertion failure rolls back proof, case bind and session together', async point => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            const target = { proof: 'dashboard_onboarding_proofs', gate: 'dashboard_session_gates', audit: 'dashboard_runtime_audit', receipt: 'dashboard_runtime_receipts' }[point];
            let injected = false;
            f.state.hook = async event => { if (!injected && event.phase === 'after' && new RegExp('INSERT INTO nofries\\.' + target + '\\b', 'i').test(event.sql)) {
                injected = true; throw new Error('synthetic driver failure after actual insert'); } };
            await unchangedFailure(() => f.bind(example), 'onboarding_unavailable', 503);
            expect(injected).toBe(true); f.state.hook = null;
        });

        test.each(['canonical member', 'audit', 'receipt'])('bootstrap failure after %s write rolls back both DATA and runtime effects', async point => {
            const f = fixture; await f.initialize(); const example = await f.approve(await f.bind(await f.createCase()));
            const target = { 'canonical member': 'dashboard_membership_states', audit: 'dashboard_runtime_audit', receipt: 'dashboard_runtime_receipts' }[point];
            let injected = false;
            f.state.hook = async event => { if (!injected && event.phase === 'after' && new RegExp('INSERT INTO nofries\\.' + target + '\\b', 'i').test(event.sql)) {
                injected = true; throw new Error('synthetic driver failure after actual insert'); } };
            const command = { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: 2 };
            await unchangedFailure(() => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command), 'onboarding_unavailable', 503);
            expect(injected).toBe(true); f.state.hook = null;
        });

        test('lost COMMIT response reconciles once using original committed acceptance and performs no recovery writes', async () => {
            const f = fixture; await f.initialize(); const example = await f.approve(await f.bind(await f.createCase()));
            const command = { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: 2 };
            let committed, ids, tokens;
            const observed = acceptanceCommitFault(f, command.operationId, 'after', async () => {
                committed = await exportAll(); ids = f.state.ids; tokens = f.state.tokens; f.state.now = atMillis(1000); throw new Error('synthetic response lost after genuine COMMIT');
            });
            const result = await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
            f.state.hook = null;
            expectAcceptanceCommitFault(observed); expect(result.case.status).toBe('accepted'); expect(await exportAll()).toEqual(committed);
            expect(observed.recoverySql.filter(sql => /^BEGIN\s*$/i.test(sql))).toHaveLength(1);
            expect(observed.recoverySql.filter(sql => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?nofries\./i.test(sql))).toEqual([]);
            expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            expectRemainingPreparations(observed.recoveryTrace.slice(observed.recoveryTrace.findLastIndex(row => row.sql === 'BEGIN')), 59000);
        });

        test('restore fencing preserves old gate rows and original receipts but denies old epoch authentication', async () => {
            const f = fixture, initialized = await f.initialize();
            const fenceCommand = f.instanceCommand(initialized.enabled.record), fenced = await f.maintenance.fenceRestoreEpoch(fenceCommand);
            expect(fenced).toMatchObject({ outcome: 'fenced', record: { revision: 2, ingressStatus: 'fenced' } });
            await unchangedFailure(() => f.repository.readSession(f.operator()));
            const nextEpoch = nextId(); f.state.restoreEpoch = nextEpoch;
            const replaced = await f.maintenance.fenceRestoreEpoch(f.instanceCommand(fenced.record, nextEpoch));
            expect(replaced.record).toMatchObject({ revision: 3, restoreEpoch: nextEpoch, ingressStatus: 'fenced' });
            const enabled = await f.maintenance.enableRuntimeIngress(f.instanceCommand(replaced.record));
            expect(enabled.record).toMatchObject({ revision: 4, restoreEpoch: nextEpoch, ingressStatus: 'enabled' });
            const gates = await rows('dashboard_session_gates', 'instance_id', f.instanceId);
            expect(gates).toHaveLength(1); expect(gates[0].restore_epoch).toBe(f.operatorSeed.restoreEpoch);
            await unchangedFailure(() => f.repository.initializeOperatorSession(f.operator(), initialized.initialCommand));
            const before = await exportAll();
            expect(await f.maintenance.fenceRestoreEpoch(fenceCommand)).toEqual(fenced);
            expect(await exportAll()).toEqual(before);
        });

        test('new epoch cannot replace enabled ingress without the explicit same-epoch fence', async () => {
            const f = fixture, initialized = await f.initialize();
            const command = f.instanceCommand(initialized.enabled.record, nextId()); f.state.restoreEpoch = command.restoreEpoch;
            // Current external epoch already differs from the enabled record,
            // so current authority denial precedes a transition precondition.
            await unchangedFailure(() => f.maintenance.fenceRestoreEpoch(command));
        });

        test('ready session, directory and onboarding status audit before disclosure on pool max1', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const customerSeed = f.session('customer', f.customerIdentity);
            await f.repository.activateCustomerSession(f.request(customerSeed), { operationId: nextId(), bindingId: example.selected.bindingId });
            for (const [action, work, expectedScope] of [
                ['readSession', () => f.repository.readSession(f.request(customerSeed)), f.scope],
                ['discoverBindings', () => f.repository.discoverBindings(f.request(customerSeed), { limit: 10, afterBindingId: null }), null],
                ['readOnboardingStatus', () => f.repository.readOnboardingStatus(f.request(example.discoverySeed, example.proof)), f.scope]
            ]) {
                const before = await rows('dashboard_runtime_audit', 'instance_id', f.instanceId), start = f.state.trace.length;
                const result = await work(); deeplyFrozen(result);
                const after = await rows('dashboard_runtime_audit', 'instance_id', f.instanceId);
                expect(after).toHaveLength(before.length + 1);
                const audit = after.find(row => !before.some(prior => prior.event_id === row.event_id));
                expect(audit.payload).toMatchObject({ action, outcome: 'succeeded', scope: expectedScope, operationId: null });
                expect(audit.scope_json).toEqual(expectedScope);
                expect(audit.event_sha256).toBe(hash({ sessionSha256: audit.session_sha256,
                    instanceId: audit.instance_id, authorityId: audit.authority_id, event: audit.payload }));
                const trace = f.state.trace.slice(start).map(event => event.sql);
                const insert = trace.findIndex(sql => /INSERT INTO nofries\.dashboard_runtime_audit\b/i.test(sql));
                expect(insert).toBeGreaterThan(-1);
                expect(trace.slice(insert + 1).some(sql => /^COMMIT\s*$/i.test(sql))).toBe(true);
                expect(f.state.borrows).toBe(f.state.releases);
            }
        });

        test.each(['captured issuance', 'current gate update'])('readSession denies a future %s before disclosing or auditing success', async variant => {
            const f = fixture; await f.initialize();
            const later = '2026-09-07T01:10:00.000Z', seed = f.session('operator_dashboard', f.operatorIdentity);
            if (variant === 'captured issuance') {
                seed.issuedAt = later; seed.operatorIssuanceProof.issuedAt = later;
            } else {
                // Create a valid active gate through the real operation at its
                // actual time, then start a separate earlier-clock invocation.
                f.state.now = later;
                await f.repository.initializeOperatorSession(f.request(seed), { operationId: nextId() });
                f.state.now = NOW;
            }
            const borrows = f.state.borrows;
            await unchangedFailure(() => f.repository.readSession(f.request(seed)));
            if (variant === 'captured issuance') expect(f.state.borrows).toBe(borrows);
            else {
                expect(f.state.trace.some(event => /FROM nofries\.dashboard_session_gates/.test(event.sql))).toBe(true);
                f.state.now = later;
                expect((await f.repository.readSession(f.request(seed))).state).toBe('ready');
            }
        });

        test.each(['readSession', 'discoverBindings', 'readOnboardingStatus'])('%s cannot disclose buffered success when its mandatory audit fails', async method => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const seed = f.session('customer', f.customerIdentity);
            await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId });
            let injected = false;
            f.state.hook = event => { if (!injected && event.phase === 'before' && /INSERT INTO nofries\.dashboard_runtime_audit\b/i.test(event.sql)) {
                injected = true; throw new Error('synthetic audit failure'); } };
            await unchangedFailure(() => method === 'readOnboardingStatus' ? f.repository[method](f.request(example.discoverySeed, example.proof))
                : method === 'discoverBindings' ? f.repository[method](f.request(seed), { limit: 10, afterBindingId: null })
                    : f.repository[method](f.request(seed)), 'onboarding_unavailable', 503);
            expect(injected).toBe(true); f.state.hook = null;
        });

        test('known original event retry retains original time and rejects changed event intent', async () => {
            const f = fixture; await f.initialize();
            const command = { eventId: nextId(), action: 'readSession', outcome: 'denied', resourceKey: 'session', operationId: null };
            const result = await f.repository.recordRuntimeEvent(f.operator(), command);
            expect(result).toEqual({ schemaVersion: 1, eventId: command.eventId, recorded: true });
            const before = await exportAll(); f.state.now = '2026-09-07T01:00:01.000Z';
            expect(await f.repository.recordRuntimeEvent(f.operator(), command)).toEqual(result);
            expect(await exportAll()).toEqual(before);
            await unchangedFailure(() => f.repository.recordRuntimeEvent(f.operator(), { ...command, outcome: 'succeeded' }), 'onboarding_conflict', 409);
            const host = { eventId: nextId(), action: 'readDashboardReadiness', outcome: 'succeeded', resourceKey: 'readiness', operationId: null };
            const hostResult = await f.repository.recordRuntimeEvent(f.operator(), host), hostBefore = await exportAll();
            f.state.now = '2026-09-07T01:00:02.000Z';
            expect(await f.repository.recordRuntimeEvent(f.operator(), host)).toEqual(hostResult);
            expect(await exportAll()).toEqual(hostBefore);
            await unchangedFailure(() => f.repository.recordRuntimeEvent(f.operator(), { ...host, outcome: 'denied' }), 'onboarding_conflict', 409);
            await unchangedFailure(() => f.repository.recordRuntimeEvent(f.operator(), { ...host, action: 'readSession', resourceKey: 'session' }), 'onboarding_conflict', 409);
        });

        test('routing lookup releases its client and rechecks an external epoch change before activation', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const seed = f.session('customer', f.customerIdentity), before = await exportAll(); let sawLookup = false, changed = false;
            f.state.hook = event => { if (event.phase === 'after' && /SELECT[\s\S]*FROM nofries\.dashboard_identity_bindings/i.test(event.sql)) sawLookup = true; };
            f.state.beforeBorrow = () => { if (sawLookup && !changed) { changed = true; f.state.restoreEpoch = nextId(); } };
            await rejectsCode(() => f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId }), 'onboarding_access_denied', 403);
            f.state.hook = null; f.state.beforeBorrow = null;
            expect(changed).toBe(true); expect(f.state.borrows).toBe(f.state.releases); expect(await exportAll()).toEqual(before);
        });

        test('directory cannot renew its budget in the private event transaction', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const seed = f.session('customer', f.customerIdentity);
            await f.repository.activateCustomerSession(f.request(seed), { operationId: nextId(), bindingId: example.selected.bindingId });
            let found = false;
            f.state.hook = event => { if (event.phase === 'after' && /SELECT[\s\S]*FROM nofries\.dashboard_identity_bindings/i.test(event.sql)) found = true; };
            f.state.beforeBorrow = () => { if (found) f.state.now = '2026-09-07T01:01:00.000Z'; };
            await unchangedFailure(() => f.repository.discoverBindings(f.request(seed), { limit: 10, afterBindingId: null }), 'onboarding_unavailable', 503);
            f.state.hook = null; f.state.beforeBorrow = null; expect(found).toBe(true);
        });

        test('all local settings and narrowed role are cleared after lookup, success and rollback on the same pooled client', async () => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            await f.repository.lookupCaseCapability({ capability: example.capability });
            await f.repository.readSession(f.operator());
            f.state.deniedOperations.add('denyCase');
            await unchangedFailure(() => f.repository.denyCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId,
                expectedRevision: 0, expectedHeadSha256: example.result.case.headSha256, authorityRef: example.authorityRef }));
            const client = await runtimePool.connect();
            try {
                expect((await client.query('SELECT current_user AS role,session_user AS login')).rows[0]).toEqual({ role: runtimeRole, login: runtimeRole });
                for (const suffix of ['tenant_id', 'runtime_instance_id', 'session_sha256', 'session_kind', 'identity_sha256', 'subject_key',
                    'organisation_id', 'case_id', 'binding_id', 'authority_id', 'capability_sha256', 'request_id']) {
                    const value = (await client.query('SELECT current_setting($1,true) AS value', ['nofries.' + suffix])).rows[0].value;
                    expect(value === null || value === '').toBe(true);
                }
            } finally { client.release(); }
        });

        test('reader roles have no inheritance path to maintenance/owner and no update or hidden-table privileges', async () => {
            const names = ['nofries_runtime', 'nofries_dashboard_subject_reader', 'nofries_dashboard_capability_reader', 'nofries_dashboard_maintenance'];
            const roles = (await ownerPool.query('SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])', [names])).rows;
            expect(roles).toHaveLength(4);
            for (const role of roles.filter(row => row.rolname !== 'nofries_runtime')) expect(role).toMatchObject({ rolsuper: false, rolinherit: false,
                rolcreaterole: false, rolcreatedb: false, rolcanlogin: false, rolreplication: false, rolbypassrls: false });
            const edges = (await ownerPool.query(`WITH RECURSIVE reachable AS (
                SELECT m.roleid,m.member,m.set_option,m.inherit_option,m.admin_option FROM pg_auth_members m WHERE m.member=$1::regrole
                UNION SELECT m.roleid,m.member,m.set_option,m.inherit_option,m.admin_option FROM pg_auth_members m JOIN reachable r ON m.member=r.roleid)
                SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,set_option,inherit_option,admin_option FROM reachable`, [runtimeRole])).rows;
            expect(edges.some(edge => edge.role === 'nofries_dashboard_subject_reader' && edge.set_option && !edge.inherit_option && !edge.admin_option)).toBe(true);
            expect(edges.some(edge => edge.role === 'nofries_dashboard_capability_reader' && edge.set_option && !edge.inherit_option && !edge.admin_option)).toBe(true);
            expect(edges.map(edge => edge.role)).not.toContain('nofries_dashboard_maintenance');
            for (const role of ['nofries_dashboard_subject_reader', 'nofries_dashboard_capability_reader']) {
                for (const table of [...DATA_TABLES, ...RUNTIME_TABLES]) {
                    const privileges = (await ownerPool.query("SELECT has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [role, 'nofries.' + table])).rows[0];
                    expect(privileges.allowed).toBe(false);
                }
            }
        });

        test('restricted runtime cannot modify maintenance heads or immutable proof/receipt/audit columns', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const client = await f.restrictedPool.connect();
            try {
                await client.query('SET ROLE nofries_runtime'); // Explicit test-owned privilege probe only.
                for (const sql of [
                    'UPDATE nofries.dashboard_runtime_instance SET ingress_status=ingress_status',
                    'UPDATE nofries.dashboard_admission_authorities SET status=status',
                    'UPDATE nofries.dashboard_admission_decisions SET payload=payload',
                    'UPDATE nofries.dashboard_onboarding_proofs SET proof_sha256=proof_sha256',
                    'UPDATE nofries.dashboard_onboarding_decisions SET payload=payload',
                    'UPDATE nofries.dashboard_runtime_receipts SET payload=payload',
                    'UPDATE nofries.dashboard_runtime_audit SET payload=payload',
                    'UPDATE nofries.dashboard_identity_bindings SET identity_sha256=identity_sha256',
                    'UPDATE nofries.dashboard_session_gates SET expires_at=expires_at'
                ]) {
                    const result = await settled(client.query(sql)); expect(result.error).toMatchObject({ code: '42501' });
                }
                const noContext = await client.query('SELECT binding_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [example.selected.bindingId]);
                expect(noContext.rows).toEqual([]);
            } finally { await client.query('RESET ROLE'); client.release(); }
        });

        test.each(['session', 'authority', 'instance'])('%s history traverses more than 256 real successors without truncation and detects missing interior receipts', async family => {
            const f = fixture, initialization = await f.initialize();
            let original, originalCommand, replay, current, anchorColumn, anchor;
            if (family === 'session') {
                const example = await f.accepted(), seed = f.session('customer', f.customerIdentity);
                originalCommand = { operationId: nextId(), bindingId: example.selected.bindingId };
                original = await f.repository.activateCustomerSession(f.request(seed), originalCommand); current = original.record;
                anchorColumn = 'anchor_session_sha256'; anchor = seed.sessionSha256;
                replay = () => f.repository.activateCustomerSession(f.request(seed), originalCommand);
                for (let i = 0; i < 257; i++) current = (await f.repository.selectBinding(f.request(seed), {
                    operationId: nextId(), bindingId: example.selected.bindingId, expectedGeneration: current.generationToken })).record;
                expect(current.revision).toBe(257);
            } else if (family === 'authority') {
                const selected = template(f.scope, nextId()); originalCommand = f.admissionCommand(selected);
                original = await f.maintenance.publishAdmissionDecision(originalCommand); current = original.record;
                anchorColumn = 'anchor_authority_id'; anchor = current.authorityId;
                replay = () => f.maintenance.publishAdmissionDecision(originalCommand);
                for (let i = 0; i < 257; i++) current = (await f.maintenance[i % 2 === 0 ? 'withdrawAdmissionDecision' : 'publishAdmissionDecision'](f.admissionCommand(selected, current))).record;
                expect(current.revision).toBe(257);
            } else {
                originalCommand = initialization.firstCommand; original = initialization.first; current = initialization.enabled.record;
                anchorColumn = 'anchor_instance_id'; anchor = f.instanceId;
                replay = () => f.maintenance.initializeRuntimeInstance(originalCommand);
                for (let i = 0; i < 257; i++) current = (await f.maintenance[i % 2 === 0 ? 'fenceRestoreEpoch' : 'enableRuntimeIngress'](f.instanceCommand(current))).record;
                expect(current.revision).toBe(258);
            }
            const before = await exportAll(), ids = f.state.ids, tokens = f.state.tokens, traceStart = f.state.trace.length;
            expect(await replay()).toEqual(original); expect(await exportAll()).toEqual(before);
            expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            const pages = f.state.trace.slice(traceStart).filter(event => /FROM nofries\.dashboard_runtime_receipts\b/i.test(event.sql) && /\bLIMIT\s+\$/i.test(event.sql));
            expect(pages.length).toBeGreaterThan(16);
            for (const page of pages) { const parameter = Number(/\bLIMIT\s+\$(\d+)/i.exec(page.sql)[1]);
                expect(Number(page.params[parameter - 1])).toBeGreaterThan(0); expect(Number(page.params[parameter - 1])).toBeLessThanOrEqual(16); }
            const retained = (await rows('dashboard_runtime_receipts', anchorColumn, anchor))
                .sort((left, right) => left.payload.result.record.revision - right.payload.result.record.revision);
            expect(retained.length).toBeGreaterThan(257);
            for (const index of [16, retained.length - 17]) {
                const removed = retained[index];
                // No FK references these non-head historical receipt rows. Keep
                // their genuine audit and newer head to test actual missing lineage.
                await ownerPool.query('DELETE FROM nofries.dashboard_runtime_receipts WHERE receipt_id=$1', [removed.receipt_id]);
                await unchangedFailure(replay, 'onboarding_record_invalid', 503);
                await insertRetainedReceipt(ownerPool, removed);
            }
            expect(await replay()).toEqual(original);
        }, 180000);

        test.each([
            ['records', { maxRecords: 1, maxBytes: BUDGET.maxBytes, maxDurationMs: 60000 }],
            ['bytes', { maxRecords: BUDGET.maxRecords, maxBytes: 1, maxDurationMs: 60000 }]
        ])('aggregate %s exhaustion exposes no retained success and performs no repair', async (_kind, historyBudget) => {
            const f = fixture, initialization = await f.initialize();
            const repository = instantiate({ ...f.options, historyBudget });
            const before = await exportAll(), ids = f.state.ids, tokens = f.state.tokens;
            await rejectsCode(() => repository.initializeOperatorSession(f.operator(), initialization.initialCommand), 'onboarding_unavailable', 503);
            expect(await exportAll()).toEqual(before); expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
        });

        test.each(['case', 'admission'])('%s compact head consumes its own record before following decision evidence', async kind => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            const headTable = kind === 'case' ? 'dashboard_onboarding_cases' : 'dashboard_admission_authorities';
            const decisionTable = kind === 'case' ? 'dashboard_onboarding_decisions' : 'dashboard_admission_decisions';
            // Case routing and authoritative work each normalize instance+gate
            // before this head (four records). Maintenance reads one instance.
            const recordsAtHead = kind === 'case' ? 5 : 2;
            for (const extraDecision of [0, 1]) {
                const historyBudget = { ...BUDGET, maxRecords: recordsAtHead + extraDecision };
                const repository = instantiate(kind === 'case' ? { ...f.options, historyBudget } : { ...f.maintenanceOptions, historyBudget }, kind === 'admission');
                const start = f.state.trace.length, ids = f.state.ids;
                await unchangedFailure(() => kind === 'case'
                    ? repository.denyCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 0,
                        expectedHeadSha256: example.result.case.headSha256, authorityRef: example.authorityRef })
                    : repository.withdrawAdmissionDecision(f.admissionCommand(example.selected, example.admission.record)), 'onboarding_unavailable', 503);
                const queries = f.state.trace.slice(start);
                expect(queries.some(event => new RegExp('FROM nofries\\.' + headTable + '\\b').test(event.sql) && /head_revision/.test(event.sql))).toBe(true);
                const evidence = queries.filter(event => new RegExp('FROM nofries\\.' + decisionTable + '\\b').test(event.sql));
                expect(evidence).toHaveLength(extraDecision);
                if (kind === 'case' && extraDecision) { const index = Number(/LIMIT\s+\$(\d+)/.exec(evidence[0].sql)[1]); expect(evidence[0].params[index - 1]).toBe(1); }
                // A fresh candidate may allocate IDs after all retained evidence
                // has loaded; only the exhausted-before-evidence case proves
                // the earlier no-allocation boundary. Neither may persist.
                if (extraDecision === 0) expect(f.state.ids).toBe(ids);
            }
        });

        test.each(['deadline', 'clock regression'])('a %s reached during real SQL settles the transaction before client reuse', async variant => {
            const f = fixture; await f.initialize(); let crossed = false;
            f.state.hook = event => { if (!crossed && event.phase === 'after' && /SELECT[\s\S]*FROM nofries\.dashboard_session_gates/i.test(event.sql)) {
                crossed = true; f.state.now = variant === 'deadline' ? '2026-09-07T01:01:00.000Z' : '2026-09-07T00:59:59.999Z';
            } };
            await unchangedFailure(() => f.repository.readSession(f.operator()), 'onboarding_unavailable', 503);
            expect(crossed).toBe(true); expect(f.state.borrows).toBe(f.state.releases); f.state.hook = null; f.state.now = NOW;
            expect((await f.repository.readSession(f.operator())).state).toBe('ready');
        });

        test('a late known COMMIT remains committed and only a new explicit invocation receives a fresh recovery budget', async () => {
            const f = fixture; await f.initialize(); const example = await f.approve(await f.bind(await f.createCase()));
            const command = { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: 2 };
            const observed = acceptanceCommitFault(f, command.operationId, 'after', () => {
                f.state.now = '2026-09-07T01:01:00.000Z';
            });
            await rejectsCode(() => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command), 'onboarding_unavailable', 503);
            f.state.hook = null;
            expectAcceptanceCommitFault(observed); expect(f.state.borrows).toBe(f.state.releases);
            expect(observed.recoverySql).toEqual([]);
            const committed = await exportAll(), ids = f.state.ids, tokens = f.state.tokens;
            expect(committed.dashboard_runtime_receipts.filter(row => row.operation_id === command.operationId)).toHaveLength(1);
            const result = await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command);
            expect(result.acceptedAt).toBe(NOW); expect(await exportAll()).toEqual(committed);
            expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
        });

        test.each(['changed retained hash', 'oversized retained payload'])('%s is record-invalid503 after a real SELECT, never a new-input413', async variant => {
            const f = fixture, initialization = await f.initialize(); let substituted = false;
            f.state.hook = event => {
                if (substituted || event.phase !== 'after' || !/FROM nofries\.dashboard_runtime_receipts\b/i.test(event.sql)) return;
                const row = event.result.rows.find(value => value.payload && value.payload.operationType === 'initializeOperatorSession');
                if (!row) return;
                substituted = true; row.payload = clone(row.payload);
                if (variant === 'changed retained hash') row.payload.receiptSha256 = 'a'.repeat(64);
                else row.payload.stableIntent.retainedCorruption = 'x'.repeat(524289);
            };
            // Driver-corruption classification is intentionally separate from
            // PostgreSQL's physical CHECK/FK rejection cases below.
            await unchangedFailure(() => f.repository.initializeOperatorSession(f.operator(), initialization.initialCommand), 'onboarding_record_invalid', 503);
            expect(substituted).toBe(true); f.state.hook = null;
        });

        test('publishes an existing approved membership without fabricating case history or changing canonical membership', async () => {
            const f = fixture; await f.initialize(); const setup = await f.publicationSetup();
            const before = await exportAll();
            const result = await f.repository.publishExistingMembershipBinding(f.operator(), setup.command);
            expect(result).toEqual({ binding: { bindingId: setup.command.bindingId, membershipId: 'existing-member',
                status: 'active', revision: 0, updatedAt: NOW } }); deeplyFrozen(result);
            const stored = await exportAll();
            for (const table of DATA_TABLES) expect(stored[table]).toEqual(before[table]);
            expect(stored.dashboard_onboarding_cases).toEqual([]); expect(stored.dashboard_onboarding_proofs).toEqual([]);
            const binding = stored.dashboard_identity_bindings[0];
            expect(binding.binding_origin).toBe('existing_membership'); expect(binding.case_id).toBeNull(); expect(binding.acceptance_receipt_id).toBeNull();
            const receipt = stored.dashboard_runtime_receipts.find(row => row.operation_id === setup.command.operationId).payload;
            const reconstructed = domain.normalisePublicationReceipt(receipt.originalFacts.domainReceipt);
            expect(reconstructed.binding.subjectKey).toBe(subject(f.customerIdentity));
            expect(receipt.originalFacts.dataReference).toBeNull(); expect(receipt.anchorKind).toBe('binding');
            const ids = f.state.ids;
            expect(await f.repository.publishExistingMembershipBinding(f.operator(), setup.command)).toEqual(result);
            expect(await exportAll()).toEqual(stored); expect(f.state.ids).toBe(ids);
        });

        test.each(['bindingId', 'membershipId', 'invitationId', 'grantEvidenceId', 'identity', 'validUntil'])('publication admission pins approved %s independently of execution facts', async field => {
            const f = fixture; await f.initialize(); const setup = await f.publicationSetup();
            const command = clone(setup.command); command.operationId = nextId();
            if (field === 'identity') command.identity.policyRevision++;
            else if (field === 'validUntil') command.validUntil = '2027-09-06T00:00:00.000Z';
            else command[field] = field === 'bindingId' ? nextId() : command[field] + '-changed';
            const changedEffect = { ...clone(setup.approvedEffect), [field]: clone(command[field]) };
            expect(hash(changedEffect)).not.toBe(hash(setup.approvedEffect));
            await unchangedFailure(() => f.repository.publishExistingMembershipBinding(f.operator(), command));
        });

        test('a fresh same-principal discovery session replays accepted receipt using its exact original audit link', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            f.state.now = '2026-09-07T05:00:00.000Z';
            const operationId = nextId(), proof = { ...clone(example.proof), proofId: nextId(), caseRevision: 3,
                operationId, authenticationSha256: digest(nextId()), verifiedAt: f.state.now, freshUntil: '2026-09-07T06:00:00.000Z' };
            const seed = f.discoverySession(proof);
            const result = await f.repository.recordProofAndActivateDiscovery(f.request(seed, proof), { operationId });
            expect(result.caseOutcome).toBe('preserved'); expect(result.case).toEqual(example.accepted.case);
            const before = await exportAll();
            expect(await f.repository.acceptStagedOnboarding(f.request(seed, proof), example.acceptCommand)).toEqual(example.accepted);
            expect(await exportAll()).toEqual(before);
            const status = await f.repository.readOnboardingStatus(f.request(seed, proof));
            expect(status.receipt).toEqual({ operationId: example.acceptCommand.operationId, acceptedAt: NOW });
        });

        test('accepted status retains original time after consumed approval deadline with fresh proof and currently valid member/binding', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            f.state.now = '2026-09-07T05:00:00.000Z';
            const operationId = nextId(), proof = { ...clone(example.proof), proofId: nextId(), caseRevision: 3, operationId,
                authenticationSha256: digest(nextId()), verifiedAt: f.state.now, freshUntil: '2026-09-07T06:00:00.000Z' };
            const seed = f.discoverySession(proof);
            await f.repository.recordProofAndActivateDiscovery(f.request(seed, proof), { operationId });
            const result = await f.repository.readOnboardingStatus(f.request(seed, proof));
            expect(result.receipt).toEqual({ operationId: example.acceptCommand.operationId, acceptedAt: NOW });
            expect(result.approval.acceptBefore).toBe(ACCEPT_BEFORE);
        });

        test('subject reader exposes only fixed own binding routing columns and refuses hidden authority columns', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const own = f.session('customer', f.customerIdentity), foreign = f.session('customer', identity(nextId()));
            const select = client => client.query('SELECT binding_id,tenant_id,organisation_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [example.selected.bindingId]);
            expect((await scopedSql(f, own, {}, select, 'nofries_dashboard_subject_reader')).rows).toEqual([
                { binding_id: example.selected.bindingId, tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId }]);
            expect((await scopedSql(f, foreign, {}, select, 'nofries_dashboard_subject_reader')).rows).toEqual([]);
            expect((await scopedSql(f, own, { identity_sha256: '' }, select, 'nofries_dashboard_subject_reader')).rows).toEqual([]);
            for (const sql of ['SELECT * FROM nofries.dashboard_identity_bindings', 'SELECT membership_id FROM nofries.dashboard_identity_bindings',
                'SELECT * FROM nofries.dashboard_membership_states', 'SELECT * FROM nofries.dashboard_onboarding_proofs',
                'SELECT * FROM nofries.dashboard_runtime_receipts', 'SELECT * FROM nofries.dashboard_runtime_audit']) {
                const result = await settled(scopedSql(f, own, {}, client => client.query(sql), 'nofries_dashboard_subject_reader'));
                expect(result.error).toMatchObject({ code: '42501' });
            }
            // The internal locator's absence-of-gate exception does not extend
            // to the public directory method or disclose these two scope fields.
            await unchangedFailure(() => f.repository.discoverBindings(f.request(own), { limit: 10, afterBindingId: null }));
        });

        test('case locator is exact active operator or own discovery case and never customer/foreign/empty context', async () => {
            const f = fixture; await f.initialize(); const example = await f.bind(await f.createCase());
            const other = await f.createCase(template({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId }, nextId()));
            const select = (client, caseId) => client.query('SELECT case_id,tenant_id,organisation_id FROM nofries.dashboard_onboarding_cases WHERE case_id=$1', [caseId]);
            for (const seed of [f.operatorSeed, example.discoverySeed]) {
                const result = await scopedSql(f, seed, { case_id: example.command.caseId }, client => select(client, example.command.caseId), 'nofries_dashboard_subject_reader');
                expect(result.rows).toEqual([{ case_id: example.command.caseId, tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId }]);
            }
            const customer = f.session('customer', f.customerIdentity);
            for (const [seed, extras, target] of [[customer, { case_id: example.command.caseId }, example.command.caseId],
                [example.discoverySeed, { case_id: other.command.caseId }, other.command.caseId],
                [f.operatorSeed, { case_id: '' }, example.command.caseId],
                [f.operatorSeed, { case_id: example.command.caseId, session_sha256: '' }, example.command.caseId]]) {
                expect((await scopedSql(f, seed, extras, client => select(client, target), 'nofries_dashboard_subject_reader')).rows).toEqual([]);
            }
            const hidden = await settled(scopedSql(f, f.operatorSeed, { case_id: example.command.caseId }, client =>
                client.query('SELECT status,capability_sha256 FROM nofries.dashboard_onboarding_cases'), 'nofries_dashboard_subject_reader'));
            expect(hidden.error).toMatchObject({ code: '42501' });
        });

        test.each(['createCase', 'approveCase', 'revokeCase'])('same-case %s receipt cannot satisfy the typed acceptance FK for case head or binding', async wrongType => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            await f.repository.revokeCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 3,
                expectedHeadSha256: example.accepted.case.headSha256, authorityRef: example.authorityRef });
            const all = await exportAll(), receipt = all.dashboard_runtime_receipts.find(row => row.operation_type === wrongType && row.anchor_case_id === example.command.caseId);
            expect(receipt).toBeDefined();
            const caseRow = all.dashboard_onboarding_cases[0], binding = all.dashboard_identity_bindings[0];
            const context = { tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId, case_id: example.command.caseId, binding_id: binding.binding_id };
            const update = async (client, receiptId) => {
                const result = await client.query('UPDATE nofries.dashboard_onboarding_cases SET accepted_receipt_id=$1 WHERE case_id=$2', [receiptId, caseRow.case_id]);
                expect(result.rowCount).toBe(1); await client.query('SET CONSTRAINTS ALL IMMEDIATE');
            };
            await scopedSql(f, f.operatorSeed, context, client => update(client, caseRow.accepted_receipt_id)); // restricted valid control
            const rejected = await settled(scopedSql(f, f.operatorSeed, context, client => update(client, receipt.receipt_id)));
            expect(rejected.error).toMatchObject({ code: '23503' }); expect(await exportAll()).toEqual(all);
            // Remove only this synthetic row as owner. No selected gate references
            // it. Reinsert through the real runtime role to exercise INSERT/FK,
            // because birth columns correctly have no runtime UPDATE privilege.
            await ownerPool.query('DELETE FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [binding.binding_id]);
            const absent = await exportAll();
            const insert = async (client, value) => { await client.query('INSERT INTO nofries.dashboard_identity_bindings SELECT * FROM jsonb_populate_record(NULL::nofries.dashboard_identity_bindings,$1::jsonb)', [JSON.stringify(value)]);
                await client.query('SET CONSTRAINTS ALL IMMEDIATE'); };
            await scopedSql(f, f.operatorSeed, context, client => insert(client, binding)); // rollback leaves fixture absent
            const wrong = await settled(scopedSql(f, f.operatorSeed, context, client => insert(client, { ...binding, acceptance_receipt_id: receipt.receipt_id })));
            expect(wrong.error).toMatchObject({ code: '23503' }); expect(await exportAll()).toEqual(absent);
        });

        test('SQL enforces active0/revoked1 binding lifecycle and equal session revision/generation counters', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted();
            const scope = { tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId, binding_id: example.selected.bindingId };
            const correct = client => client.query('UPDATE nofries.dashboard_identity_bindings SET revision=revision,status=status WHERE binding_id=$1', [example.selected.bindingId]);
            expect((await scopedSql(f, f.operatorSeed, scope, correct)).rowCount).toBe(1);
            const before = await exportAll();
            const binding = await settled(scopedSql(f, f.operatorSeed, scope, client => client.query(
                'UPDATE nofries.dashboard_identity_bindings SET revision=1 WHERE binding_id=$1', [example.selected.bindingId])));
            expect(binding.error).toMatchObject({ code: '23514' });
            const gateControl = await scopedSql(f, f.operatorSeed, {}, client => client.query('UPDATE nofries.dashboard_session_gates SET revision=revision WHERE session_sha256=$1', [f.operatorSeed.sessionSha256]));
            expect(gateControl.rowCount).toBe(1);
            const gate = await settled(scopedSql(f, f.operatorSeed, {}, client => client.query('UPDATE nofries.dashboard_session_gates SET selection_generation=1 WHERE session_sha256=$1', [f.operatorSeed.sessionSha256])));
            expect(gate.error).toMatchObject({ code: '23514' }); expect(await exportAll()).toEqual(before);
        });

        test('audit scope projection is JSON null, and wrong operation/hash linkage cannot satisfy a receipt FK', async () => {
            const f = fixture; const initialized = await f.initialize();
            const all = await exportAll(), original = all.dashboard_runtime_receipts.find(row => row.operation_id === initialized.initialCommand.operationId);
            const event = all.dashboard_runtime_audit.find(row => row.event_id === original.audit_event_id);
            expect(original.scope_json).toBeNull(); expect(event.scope_json).toBeNull();
            const sqlNulls = (await ownerPool.query('SELECT scope_json IS NULL AS sql_null FROM nofries.dashboard_runtime_audit WHERE event_id=$1', [event.event_id])).rows[0];
            expect(sqlNulls.sql_null).toBe(false);
            // The operator gate references no session receipt by SQL FK. Keep
            // the genuine event while independently testing receipt insertion.
            await ownerPool.query('DELETE FROM nofries.dashboard_runtime_receipts WHERE receipt_id=$1', [original.receipt_id]);
            const before = await exportAll();
            const insert = async (client, value) => { await insertRetainedReceipt(client, value);
                await client.query('SET CONSTRAINTS ALL IMMEDIATE'); };
            await scopedSql(f, f.operatorSeed, {}, client => insert(client, original));
            const wrong = clone(original); wrong.audit_event_sha256 = 'a'.repeat(64); wrong.payload.auditEventSha256 = wrong.audit_event_sha256;
            const core = { ...wrong.payload }; delete core.receiptSha256; wrong.payload.receiptSha256 = hash(core);
            const result = await settled(scopedSql(f, f.operatorSeed, {}, client => insert(client, wrong)));
            expect(result.error).toMatchObject({ code: '23503' }); expect(await exportAll()).toEqual(before);
        });

        test('all ten tables reject an empty or foreign relevant scope while the same restricted control can read its exact row', async () => {
            const f = fixture; await f.initialize(); const example = await f.accepted(); const all = await exportAll();
            const context = { tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId, case_id: example.command.caseId,
                authority_id: example.authorityRef.authorityId, binding_id: example.selected.bindingId };
            const createReceipt = all.dashboard_runtime_receipts.find(row => row.operation_id === example.command.operationId);
            const cases = [
                ['dashboard_runtime_instance', 'instance_id', f.instanceId, 'runtime_instance_id', nextId()],
                ['dashboard_admission_authorities', 'authority_id', example.authorityRef.authorityId, 'authority_id', nextId()],
                ['dashboard_admission_decisions', 'authority_id', example.authorityRef.authorityId, 'authority_id', nextId()],
                ['dashboard_onboarding_cases', 'case_id', example.command.caseId, 'case_id', nextId()],
                ['dashboard_onboarding_proofs', 'proof_id', example.proof.proofId, 'case_id', nextId()],
                ['dashboard_onboarding_decisions', 'case_id', example.command.caseId, 'case_id', nextId()],
                ['dashboard_identity_bindings', 'binding_id', example.selected.bindingId, 'binding_id', nextId()],
                ['dashboard_session_gates', 'session_sha256', f.operatorSeed.sessionSha256, 'session_sha256', digest(nextId())],
                ['dashboard_runtime_receipts', 'receipt_id', createReceipt.receipt_id, 'case_id', nextId()],
                ['dashboard_runtime_audit', 'event_id', createReceipt.audit_event_id, 'runtime_instance_id', nextId()]
            ];
            for (const [table, column, value, setting, foreign] of cases) {
                const query = client => client.query(`SELECT count(*)::integer AS n FROM nofries.${table} WHERE ${column}=$1`, [value]);
                expect((await scopedSql(f, f.operatorSeed, context, query)).rows[0].n).toBeGreaterThan(0);
                for (const replacement of ['', foreign]) expect((await scopedSql(f, f.operatorSeed, { ...context, [setting]: replacement }, query)).rows[0].n).toBe(0);
            }
        });

        test('new proof occurrences preserve three independent SQL uniqueness keys', async () => {
            const f = fixture; await f.initialize(); const example = await f.bind(await f.createCase());
            const original = (await rows('dashboard_onboarding_proofs', 'proof_id', example.proof.proofId))[0];
            const context = { tenant_id: f.scope.tenantId, organisation_id: f.scope.organisationId, case_id: example.command.caseId };
            const freshProof = domain.createIdentityProof({ ...clone(example.proof), proofId: nextId(), authenticationSha256: digest(nextId()), operationId: nextId() });
            const fresh = { ...clone(original), proof_id: freshProof.proofId, authentication_sha256: freshProof.authenticationSha256,
                operation_id: freshProof.operationId, proof_sha256: freshProof.proofSha256 };
            const insert = client => client.query('INSERT INTO nofries.dashboard_onboarding_proofs SELECT * FROM jsonb_populate_record(NULL::nofries.dashboard_onboarding_proofs,$1::jsonb)', [JSON.stringify(fresh)]);
            await scopedSql(f, example.discoverySeed, context, insert); // same-role valid control, rolled back
            const before = await exportAll();
            for (const field of ['proof_id', 'authentication_sha256', 'operation_id']) {
                const value = { ...fresh, [field]: original[field] };
                const result = await settled(scopedSql(f, example.discoverySeed, context, client => client.query(
                    'INSERT INTO nofries.dashboard_onboarding_proofs SELECT * FROM jsonb_populate_record(NULL::nofries.dashboard_onboarding_proofs,$1::jsonb)', [JSON.stringify(value)])));
                expect(result.error).toMatchObject({ code: '23505' }); expect(await exportAll()).toEqual(before);
            }
        });

        test('concurrent selection with one expected token commits one winner and leaves the losing operation absent', async () => {
            const url = new URL(testUrl); url.pathname = '/' + databaseName; url.username = runtimeRole; url.password = password;
            const { Pool } = require('pg');
            const parallelPool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000,
                application_name: `runtime-real-contention-${runKey}` });
            const closeParallel = trackPoolClientEnds(parallelPool);
            let release, timer;
            try {
                const f = harness({ rawRuntimePool: parallelPool }); await f.initialize(); const example = await f.accepted();
                const seed = f.session('customer', f.customerIdentity), activation = await f.repository.activateCustomerSession(f.request(seed),
                    { operationId: nextId(), bindingId: example.selected.bindingId });
                const commands = [nextId(), nextId()].map(operationId => ({ operationId, bindingId: example.selected.bindingId,
                    expectedGeneration: activation.record.generationToken }));
                const arrivals = new Set();
                const barrier = new Promise((resolve, reject) => { release = resolve;
                    timer = setTimeout(() => reject(new Error('Two actual PostgreSQL backends did not reach the session fence')), 5000); });
                barrier.catch(() => {}); // Keep an early setup failure from creating an unhandled timer rejection.
                f.state.hook = async event => {
                    if (event.phase !== 'before' || !/pg_advisory_xact_lock\(/.test(event.sql) || Number(event.params[0]) !== 71001 || event.params[1] !== seed.sessionSha256) return;
                    expect(Number.isSafeInteger(event.backendPid) && event.backendPid > 0).toBe(true);
                    arrivals.add(event.backendPid);
                    if (arrivals.size === 2) { clearTimeout(timer); release(); }
                    await barrier;
                };
                const outcomes = await Promise.all(commands.map(command => settled(f.repository.selectBinding(f.request(seed), command))));
                expect(arrivals.size).toBe(2); expect(outcomes.filter(result => result.value)).toHaveLength(1);
                const loser = outcomes.findIndex(result => result.error); expectError(outcomes[loser].error, 'onboarding_conflict', 409);
                const stored = await exportAll();
                expect(stored.dashboard_runtime_receipts.filter(row => row.operation_id === commands[loser].operationId)).toHaveLength(0);
                expect(stored.dashboard_session_gates.find(row => row.session_sha256 === seed.sessionSha256).revision).toBe(1);
            } finally { clearTimeout(timer); if (release) release(); await closeParallel(); }
        });

        test('intent is detached before a delayed capture so caller mutation cannot retarget a later SQL write', async () => {
            const f = fixture; await f.initialize(); const example = await f.createCase();
            const command = { operationId: nextId(), caseId: example.command.caseId, expectedRevision: 0,
                expectedHeadSha256: example.result.case.headSha256, authorityRef: clone(example.authorityRef) };
            const original = clone(command), originalProvider = f.options.captureRequest;
            let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; }); let first = true;
            const repository = instantiate({ ...f.options, captureRequest: async request => {
                if (first) { first = false; entered(); await gate; } return originalProvider(request);
            } });
            const resultPromise = repository.denyCase(f.operator(), command); await waiting;
            command.operationId = nextId(); command.caseId = nextId(); command.authorityRef.sha256 = 'f'.repeat(64); release();
            const result = await resultPromise;
            expect(result.case.caseId).toBe(original.caseId); expect(result.case.status).toBe('denied');
            const stored = await exportAll();
            expect(stored.dashboard_runtime_receipts.filter(row => row.operation_id === original.operationId)).toHaveLength(1);
            expect(stored.dashboard_runtime_receipts.filter(row => row.operation_id === command.operationId)).toHaveLength(0);
        });

        test('canonical-fit candidate with actual JSONB text overflow returns definitive413 before any case/audit/receipt write', async () => {
            const f = fixture; await f.initialize();
            const selected = template(f.scope, nextId()), baseGrant = clone(selected.bootstrap.entitlementState.grants[0]);
            const caseId = nextId(), operationId = nextId(), authorityRef = { authorityId: nextId(), revision: 0, sha256: 'a'.repeat(64) };
            const candidate = count => {
                const value = clone(selected);
                value.bootstrap.entitlementState.grants = Array.from({ length: count }, (_, index) => ({ ...clone(baseGrant),
                    grantId: 'synthetic-size-grant-' + String(index).padStart(4, '0'), status: index === 0 ? 'active' : 'suspended' }));
                return value;
            };
            // Bounded pure fixture search finds the existing canonical record
            // boundary; PostgreSQL below is authoritative for JSONB text bytes.
            let low = 1, high = 700;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                try { domain.createOnboardingCase({ caseId, templateRef: 'synthetic-template-v1', template: candidate(middle),
                    acceptBefore: ACCEPT_BEFORE, initiatorSubjectKey: subject(f.operatorIdentity), authorityRef, operationId, createdAt: NOW }); low = middle;
                } catch (error) { expectError(error, 'onboarding_request_too_large', 413); high = middle - 1; }
            }
            expect(low).toBeGreaterThan(10);
            const largeTemplate = candidate(low - 4);
            const admissionInput = f.admissionCommand(largeTemplate), admission = await f.maintenance.publishAdmissionDecision(admissionInput);
            const ref = { authorityId: admission.record.authorityId, revision: admission.record.revision, sha256: admission.record.decisionSha256 };
            const command = { operationId, caseId, templateRef: 'synthetic-template-v1', template: largeTemplate, acceptBefore: ACCEPT_BEFORE, authorityRef: ref };
            const request = f.operator(); f.capabilities.set(request, { caseId, operationId, capabilitySha256: digest(Buffer.alloc(32, 82)) });
            const measured = [];
            f.state.hook = event => {
                if (event.phase === 'after' && /SELECT octet_length\(\$1::jsonb::text\) AS payload_bytes/i.test(event.sql)) {
                    const value = JSON.parse(event.params[0]);
                    measured.push({ canonicalBytes: Buffer.byteLength(canonical(value)), actualBytes: Number(event.result.rows[0].payload_bytes) });
                }
            };
            await unchangedFailure(() => f.repository.createCase(request, command), 'onboarding_request_too_large', 413);
            f.state.hook = null;
            expect(measured.some(value => value.canonicalBytes <= 262144 && value.actualBytes > 262144)).toBe(true);
            expect((await exportAll()).dashboard_onboarding_cases).toEqual([]);
            // A corrected fresh operation remains possible; a known413 is not
            // an uncertain committed mutation and does not consume a case ID.
            const corrected = await f.createCase(); expect(corrected.result.case.status).toBe('awaiting_identity');
        });

        test('maintenance can publish a future interval and withdraw it after expiry without a current-time SQL CHECK', async () => {
            const f = fixture; await f.initialize(); const selected = template(f.scope, nextId()), command = f.admissionCommand(selected);
            command.payload.validFrom = '2026-09-07T02:00:00.000Z'; command.payload.validUntil = '2026-09-07T02:30:00.000Z';
            const original = await f.maintenance.publishAdmissionDecision(command);
            expect(original.record.payload.decision).toBe('eligible');
            expect(original.record.payload.occurredAt).toBe(NOW);
            f.state.now = '2026-09-07T03:00:00.000Z';
            const withdrawal = { ...clone(command), operationId: nextId(), expectedRevision: original.record.revision, expectedHeadSha256: original.record.decisionSha256 };
            const result = await f.maintenance.withdrawAdmissionDecision(withdrawal);
            expect(result.record.payload.decision).toBe('withdrawn'); expect(result.record.revision).toBe(1);
            const before = await exportAll(); expect(await f.maintenance.withdrawAdmissionDecision(withdrawal)).toEqual(result);
            expect(await exportAll()).toEqual(before);
        });

        test('operator logout after its original parent expiry remains a valid permanent revocation', async () => {
            const f = fixture; await f.initialize(); const seed = f.session('operator_dashboard', f.operatorIdentity);
            seed.expiresAt = '2026-09-07T01:00:00.001Z'; seed.operatorIssuanceProof.expiresAt = seed.expiresAt;
            await f.repository.initializeOperatorSession(f.request(seed), { operationId: nextId() });
            f.state.now = '2026-09-07T01:00:00.002Z';
            const result = await f.repository.revokeSession(f.request(seed), { operationId: nextId() });
            expect(result.record).toMatchObject({ status: 'revoked', revision: 1, revokedAt: f.state.now });
            await unchangedFailure(() => f.repository.readSession(f.request(seed)));
        });

        test('commit failure with no committed receipt performs exactly one read-only reconciliation and stays ambiguous', async () => {
            const f = fixture; await f.initialize(); const example = await f.approve(await f.bind(await f.createCase()));
            const command = { operationId: nextId(), approvalId: example.approveCommand.approvalId, approvalRevision: 2 };
            const before = await exportAll(); let ids, tokens;
            const observed = acceptanceCommitFault(f, command.operationId, 'before', () => {
                ids = f.state.ids; tokens = f.state.tokens; f.state.now = atMillis(1000);
                throw new Error('synthetic failure before real commit, then genuine rollback');
            });
            await rejectsCode(() => f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command), 'onboarding_outcome_ambiguous', 503);
            f.state.hook = null;
            expectAcceptanceCommitFault(observed); expect(await exportAll()).toEqual(before);
            expect(observed.recoverySql.filter(sql => /^BEGIN\s*$/i.test(sql))).toHaveLength(1);
            expect(observed.recoverySql.filter(sql => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?nofries\./i.test(sql))).toEqual([]);
            expect(f.state.ids).toBe(ids); expect(f.state.tokens).toBe(tokens);
            expectRemainingPreparations(observed.recoveryTrace.slice(observed.recoveryTrace.findLastIndex(row => row.sql === 'BEGIN')), 59000);
            expect((await f.repository.acceptStagedOnboarding(f.request(example.discoverySeed, example.proof), command)).case.status).toBe('accepted');
        });

        test.each(['null', 'zero', 'negative', 'string', 'extra field', 'two rows'])('malformed measured JSONB result %s is unavailable503 with full rollback', async variant => {
            const f = fixture; await f.initialize(); const example = await f.createCase(); let changed = false;
            f.state.hook = event => {
                if (changed || event.phase !== 'after' || !/SELECT octet_length\(\$1::jsonb::text\) AS payload_bytes/i.test(event.sql)) return;
                changed = true;
                const original = event.result.rows[0].payload_bytes;
                if (variant === 'extra field') event.result.rows = [{ payload_bytes: original, trusted: true }];
                else if (variant === 'two rows') event.result.rows = [{ payload_bytes: original }, { payload_bytes: original }];
                else event.result.rows = [{ payload_bytes: { null: null, zero: 0, negative: -1, string: String(original) }[variant] }];
            };
            // This is a corrupt driver-result test after genuine PostgreSQL
            // execution, distinct from actual byte-limit/RLS evidence.
            await unchangedFailure(() => f.repository.denyCase(f.operator(), { operationId: nextId(), caseId: example.command.caseId,
                expectedRevision: 0, expectedHeadSha256: example.result.case.headSha256, authorityRef: example.authorityRef }), 'onboarding_unavailable', 503);
            expect(changed).toBe(true); f.state.hook = null;
        });

        test.each(['column privilege', 'schema CREATE', 'outgoing role edge',
            'incoming subject-reader LOGIN', 'incoming capability-reader nested group',
            'incoming maintenance admin-only edge', 'malformed intended runtime edge', 'clean exact reader reuse'])
        ('migration validates %s without normalizing unrelated membership or leaving partial tables', async variant => {
            const isolatedName = `nf_runtime_baseline_${runKey}_${++sequence}`;
            const caseRole = `nf_runtime_edge_${runKey}_${sequence}`;
            const nestedLogin = `nf_runtime_nested_${runKey}_${sequence}`;
            const priorDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-runtime-prior-migrations-'));
            const migrationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-runtime-through-0006-'));
            const cleanup = [() => fs.rmSync(priorDirectory, { recursive: true, force: true }),
                () => fs.rmSync(migrationDirectory, { recursive: true, force: true })];
            try {
                copyRuntimeMigrationBaseline(migrationDirectory);
                for (const name of ['0001_core_service_desk.sql', '0002_lifecycle.sql', '0003_dashboard.sql', '0004_ncsc_assessments.sql']) {
                    fs.copyFileSync(path.join(migrationDirectory, name), path.join(priorDirectory, name));
                }
                await controlPool.query(`CREATE DATABASE ${quoteIdentifier(isolatedName)}`);
                cleanup.push(() => controlPool.query(`DROP DATABASE ${quoteIdentifier(isolatedName)}`));
                const url = new URL(testUrl); url.pathname = '/' + isolatedName;
                const { Pool } = require('pg'); const pool = new Pool({ connectionString: url.toString(), max: 1,
                    application_name: `runtime-baseline-negative-${runKey}` });
                cleanup.push(trackPoolClientEnds(pool));
                const client = await pool.connect();
                try {
                    await applyMigrations({ client, migrationsDir: priorDirectory });
                    // This suite's unique maintenance LOGIN is installed only
                    // after its first migration. Remove that test-owned edge
                    // during serial reuse checks so it cannot mask the actual
                    // condition, then restore its exact options in finally.
                    await controlPool.query(`REVOKE nofries_dashboard_maintenance FROM ${quoteIdentifier(maintenanceRole)}`);
                    cleanup.push(() => controlPool.query(`GRANT nofries_dashboard_maintenance TO ${quoteIdentifier(maintenanceRole)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`));
                    const incoming = async () => (await client.query(`SELECT granted.rolname AS capability, member.rolname AS member,
                        membership.set_option,membership.inherit_option,membership.admin_option
                        FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid
                        JOIN pg_roles member ON member.oid=membership.member
                        WHERE granted.rolname=ANY($1::text[]) ORDER BY granted.rolname,member.rolname`,
                    [['nofries_dashboard_subject_reader', 'nofries_dashboard_capability_reader', 'nofries_dashboard_maintenance']])).rows;
                    const intended = ['nofries_dashboard_capability_reader', 'nofries_dashboard_subject_reader'].map(capability => ({
                        capability, member: 'nofries_runtime', set_option: true, inherit_option: false, admin_option: false }));
                    expect(await incoming()).toEqual(intended);
                    if (variant === 'column privilege') {
                        await client.query('CREATE TABLE nofries.synthetic_runtime_privilege (value text)');
                        await client.query('GRANT SELECT(value) ON nofries.synthetic_runtime_privilege TO nofries_dashboard_subject_reader');
                    } else if (variant === 'schema CREATE') {
                        await client.query('GRANT CREATE ON SCHEMA nofries TO nofries_dashboard_capability_reader');
                    } else if (variant === 'outgoing role edge') {
                        await controlPool.query(`CREATE ROLE ${quoteIdentifier(caseRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
                        cleanup.push(() => controlPool.query(`DROP ROLE ${quoteIdentifier(caseRole)}`));
                        await controlPool.query(`GRANT ${quoteIdentifier(caseRole)} TO nofries_dashboard_subject_reader WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
                        cleanup.push(() => controlPool.query(`REVOKE ${quoteIdentifier(caseRole)} FROM nofries_dashboard_subject_reader`));
                    } else if (variant.startsWith('incoming ')) {
                        const grouped = variant === 'incoming capability-reader nested group';
                        const adminOnly = variant === 'incoming maintenance admin-only edge';
                        const capability = grouped ? 'nofries_dashboard_capability_reader' : adminOnly ? 'nofries_dashboard_maintenance' : 'nofries_dashboard_subject_reader';
                        await controlPool.query(`CREATE ROLE ${quoteIdentifier(caseRole)} ${grouped ? 'NOLOGIN' : 'LOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS`);
                        cleanup.push(() => controlPool.query(`DROP ROLE ${quoteIdentifier(caseRole)}`));
                        if (grouped) {
                            await controlPool.query(`CREATE ROLE ${quoteIdentifier(nestedLogin)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS`);
                            cleanup.push(() => controlPool.query(`DROP ROLE ${quoteIdentifier(nestedLogin)}`));
                            await controlPool.query(`GRANT ${quoteIdentifier(caseRole)} TO ${quoteIdentifier(nestedLogin)} WITH INHERIT TRUE, SET TRUE, ADMIN FALSE`);
                            cleanup.push(() => controlPool.query(`REVOKE ${quoteIdentifier(caseRole)} FROM ${quoteIdentifier(nestedLogin)}`));
                        }
                        await controlPool.query(`GRANT ${quoteIdentifier(capability)} TO ${quoteIdentifier(caseRole)} WITH ${adminOnly
                            ? 'INHERIT FALSE, SET FALSE, ADMIN TRUE' : 'INHERIT TRUE, SET TRUE, ADMIN FALSE'}`);
                        cleanup.push(() => controlPool.query(`REVOKE ${quoteIdentifier(capability)} FROM ${quoteIdentifier(caseRole)}`));
                        const exposed = (await client.query("SELECT pg_has_role($1,$2,'MEMBER') AS member,pg_has_role($1,$2,'USAGE') AS inherited,pg_has_role($1,$2,'SET') AS can_set",
                            [grouped ? nestedLogin : caseRole, capability])).rows[0];
                        expect(exposed).toEqual({ member: true, inherited: !adminOnly, can_set: !adminOnly });
                    } else if (variant === 'malformed intended runtime edge') {
                        await controlPool.query('GRANT nofries_dashboard_subject_reader TO nofries_runtime WITH INHERIT TRUE, SET TRUE, ADMIN FALSE');
                        cleanup.push(() => controlPool.query('GRANT nofries_dashboard_subject_reader TO nofries_runtime WITH INHERIT FALSE, SET TRUE, ADMIN FALSE'));
                    }
                    const retainedIncoming = await incoming();
                    if (variant.startsWith('incoming ')) expect(retainedIncoming).toHaveLength(3);
                    if (variant === 'malformed intended runtime edge') expect(retainedIncoming.find(row => row.capability === 'nofries_dashboard_subject_reader').inherit_option).toBe(true);
                    let underlying;
                    const observedClient = { async query(text, parameters) {
                        try { return await client.query(text, parameters); }
                        catch (error) { if (error.code === 'P0001') underlying = { code: error.code, message: error.message }; throw error; }
                    } };
                    const result = await settled(applyMigrations({ client: observedClient, migrationsDir: migrationDirectory }));
                    if (variant === 'clean exact reader reuse') {
                        expect(result.error).toBeUndefined(); expect(result.value.applied).toEqual(['0005_dashboard_runtime.sql', '0006_dashboard_host_events.sql']);
                        expect(underlying).toBeUndefined(); expect(await incoming()).toEqual(intended);
                        const replay = await applyMigrations({ client, migrationsDir: migrationDirectory });
                        expect(replay.applied).toEqual([]); expect(replay.skipped).toEqual(expect.arrayContaining(['0005_dashboard_runtime.sql', '0006_dashboard_host_events.sql']));
                    } else {
                        expect(result.error).toMatchObject({ code: 'database_migration_apply_failed', migrationId: '0005_dashboard_runtime.sql' });
                        expect(underlying).toEqual({ code: 'P0001', message: 'dashboard_runtime_role_baseline_invalid' });
                    }
                    // Includes exact malformed membership flags: rejection must
                    // precede the intended GRANT, not silently repair the edge.
                    expect(await incoming()).toEqual(retainedIncoming);
                    expect((await client.query("SELECT count(*)::integer AS n FROM nofries.schema_migrations WHERE migration_id='0005_dashboard_runtime.sql'")).rows[0].n)
                        .toBe(variant === 'clean exact reader reuse' ? 1 : 0);
                    const tables = await client.query("SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nofries' AND c.relname=ANY($1::text[])", [RUNTIME_TABLES]);
                    expect(tables.rows[0].n).toBe(variant === 'clean exact reader reuse' ? 10 : 0);
                    expect((await client.query("SELECT count(*)::integer AS n FROM nofries.schema_migrations WHERE migration_id='0006_dashboard_host_events.sql'")).rows[0].n)
                        .toBe(variant === 'clean exact reader reuse' ? 1 : 0);
                    if (['column privilege', 'schema CREATE', 'outgoing role edge'].includes(variant)) {
                        const preserved = variant === 'column privilege'
                            ? await client.query("SELECT has_column_privilege('nofries_dashboard_subject_reader','nofries.synthetic_runtime_privilege','value','SELECT') AS value")
                            : variant === 'schema CREATE'
                                ? await client.query("SELECT has_schema_privilege('nofries_dashboard_capability_reader','nofries','CREATE') AS value")
                                : await client.query("SELECT pg_has_role('nofries_dashboard_subject_reader',$1,'MEMBER') AS value", [caseRole]);
                        expect(preserved.rows[0].value).toBe(true);
                    }
                } finally { client.release(); }
            } finally {
                // All cleanup is scoped to synthetic roles/edges and the owned
                // isolated database; try every step even if one cleanup fails.
                const failures = [];
                for (const release of cleanup.reverse()) { try { await release(); } catch (error) { failures.push(error); } }
                if (failures.length) throw new AggregateError(failures, 'Synthetic migration fixture cleanup failed');
            }
        });
    });
}

function quoteIdentifier(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
function quoteLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

// These causal tests concern exactly the historical 0005/0006 migration, not
// later additive schemas. Preserve their full-schema equality assertions.
function copyRuntimeMigrationBaseline(target) {
    const source = path.resolve(__dirname, '../../database/migrations');
    for (const name of ['0001_core_service_desk.sql', '0002_lifecycle.sql',
        '0003_dashboard.sql', '0004_ncsc_assessments.sql',
        '0005_dashboard_runtime.sql', '0006_dashboard_host_events.sql']) {
        fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
}
