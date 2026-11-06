'use strict';

// This suite exercises the actual approval codec, runtime and production
// composition. Only the session-capture and native SQL boundaries are mocked;
// PostgreSQL/session authenticity evidence belongs to the native HTTP suite.
jest.mock('../api/shared/dashboardOperatorSession', () => ({ createDashboardOperatorSession: jest.fn() }));
jest.mock('../api/shared/appLifecycle/postgresDashboardRuntimeRepository', () => ({
    createPostgresDashboardAdministrationRepository: jest.fn()
}));

const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { createDashboardOperatorSession: sessionFactory } = require('../api/shared/dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository: nativeFactory } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createDashboardAdminAccountActionRuntime } = require('../api/shared/dashboardAdmin/accountActionRuntime');
const { createProductionDashboardAccountActions } = require('../lib/dashboardAdminAccountActionsProduction');
const { accountActionApproval } = require('../api/shared/dashboardAdmin/accountActionApproval');
const { createDashboardAdminAccountActionService } = require('../api/shared/dashboardAdmin/accountActionService');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

const uid = n => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = '2026-10-28T06:00:00.000Z', ACTOR = uid(1) + ':' + uid(2);
const SELECTOR = { provider: 'external', subjectKey: uid(3) + ':' + uid(4), tenantId: 'synthetic-action-tenant', organisationId: 'synthetic-action-org' };
const PRINCIPAL = { provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR };
const clone = value => JSON.parse(JSON.stringify(value));
const denied = () => new DashboardAdminError(403, 'dashboard_admin_access_denied');
const unavailable = () => new DashboardAdminError(503, 'dashboard_admin_unavailable');

function approval() {
    return { schemaVersion: 1, bindingId: uid(5), revision: 1, status: 'active', purpose: 'account_support',
        operatorSubjectKey: ACTOR, instanceId: uid(6), restoreEpoch: uid(7), selector: clone(SELECTOR),
        actions: ['delete', 'edit', 'restore'], approvedAt: '2026-10-28T05:59:00.000Z', validFrom: NOW,
        validUntil: '2026-10-28T06:30:00.000Z', approvalReference: 'synthetic-action-approval',
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 2 },
        auditPolicy: { reference: 'synthetic-action-retention', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2',
            retention: { unit: 'calendar_months', count: 13 } } };
}

function fixture(options = {}) {
    const state = { now: NOW, approval: approval(), gateReady: true, nativeState: 'ready', beforeQuery: null,
        afterPolicy: null, captures: 0, queries: [], records: new Map(), capture: {
            kind: 'operator_dashboard', instanceId: uid(6), restoreEpoch: uid(7), identityPayload: {
                identityTenantId: uid(1), oid: uid(2), policyId: 'synthetic-operator-policy', policyRevision: 2
            }
        } };
    const session = { captureRequest: jest.fn(async () => { state.captures++; return clone(state.capture); }) };
    const sourceStore = { loadSession: jest.fn(async () => null), createSession: jest.fn(), deleteSession: jest.fn() };
    const proofStore = { readOriginalProof: jest.fn(async () => null), createOriginalProof: jest.fn() };
    const config = { browserAuthOptions: { store: sourceStore, env: {} },
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 2, issuer: 'https://issuer.invalid',
            identityTenantId: uid(1), audience: uid(8) }, proofStore, clock: () => state.now,
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(6), restoreEpoch: uid(7) })),
        newRequestId: () => uid(9), requestBudgetMs: 1000, pool: { connect: jest.fn(() => { throw new Error('NO_REAL_SQL'); }) },
        instanceId: uid(6), historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 }, newId: () => uid(10),
        readApprovedActionBinding: jest.fn(async () => clone(state.approval)), confirmationStore: {
            create: jest.fn(async (key, value, beforeWrite) => { await beforeWrite(); state.records.set(key, value); return true; }),
            load: jest.fn(async key => state.records.get(key) || null),
            writeState: jest.fn(async value => { state.records.set(hash(value), value); return hash(value); }),
            readState: jest.fn(async key => state.records.get(key))
        }, ...options };
    let nativeConfiguration;
    async function query(label) {
        if (state.beforeQuery) await state.beforeQuery(label);
        nativeConfiguration.beforeQuery(label);
        state.queries.push(label);
    }
    async function validate(request, selector, action) {
        const capture = await nativeConfiguration.captureRequest(request);
        await query('native_gate');
        if (!state.gateReady) throw denied();
        const policy = await nativeConfiguration.authoriseAccountAction({ request, selector, action, capture });
        if (state.afterPolicy) await state.afterPolicy({ request, selector, action, capture });
        return { state: state.nativeState, authoritySha256: policy.authoritySha256 };
    }
    const inspection = () => ({ selector: clone(SELECTOR), version: hash('synthetic-version'),
        displayName: 'Immutable Organisation', displayLabel: null, membership: { membershipId: 'synthetic-member', status: 'active',
            validFrom: NOW, validUntil: '2027-01-01T00:00:00.000Z' }, actions: ['delete', 'edit', 'restore'], witness: { synthetic: true } });
    const repository = {
        validateAccountActionSession: jest.fn(validate),
        inspectAccountAction: jest.fn(async (request, selector) => { await validate(request, selector, null); await query('inspect'); return inspection(); }),
        commitAccountAction: jest.fn(async (request, command) => {
            await validate(request, command.selector, command.action); await query('effect'); await query('COMMIT');
            return { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded',
                version: hash('synthetic-result'), occurredAt: state.now };
        }),
        accountActionOutcome: jest.fn(async (request, command) => { await validate(request, command.selector, command.action); await query('outcome'); return null; })
    };
    sessionFactory.mockImplementation(() => session);
    nativeFactory.mockImplementation(input => { nativeConfiguration = input; return repository; });
    const runtime = createDashboardAdminAccountActionRuntime(config);
    function request() { const req = new IncomingMessage(new Socket()); req.method = 'POST'; req.url = '/api/dashboard-admin/actions/inspect'; req.headers = {}; return req; }
    function context(req, overrides = {}) {
        return { request: req, principal: PRINCIPAL, signal: new AbortController().signal, check: () => state.now,
            beforeCommit: jest.fn(async () => true), ...overrides };
    }
    function serviceFor(req, selectedRuntime = runtime) {
        return createDashboardAdminAccountActionService({ ...selectedRuntime,
            authoriseOperator: input => selectedRuntime.authoriseOperator({ ...input, request: req }),
            adapter: Object.fromEntries(['inspect', 'commit', 'outcome'].map(method => [method,
                (input, ctx) => selectedRuntime.adapter[method](input, { ...ctx, request: req })])) });
    }
    const authorise = (req, selector = SELECTOR, action = 'edit', principal = PRINCIPAL) =>
        runtime.authoriseOperator({ principal, selector, action, request: req });
    return { state, config, runtime, request, context, authorise, serviceFor, repository, sourceStore, proofStore,
        get nativeConfiguration() { return nativeConfiguration; } };
}

beforeEach(() => { nativeFactory.mockReset(); sessionFactory.mockReset(); });

test('approval is a closed independent action grant with exact retention policy', () => {
    const input = approval(), result = accountActionApproval(input);
    expect(result).toEqual(input); expect(Object.isFrozen(result.selector)).toBe(true);
    input.actions.pop(); expect(result.actions).toEqual(['delete', 'edit', 'restore']);
});

test.each([
    ['lookup purpose', a => { a.purpose = 'account_read'; }], ['read action', a => { a.actions = ['dashboard.authority.read']; }],
    ['missing retention', a => { delete a.auditPolicy; }], ['retention shortened', a => { a.auditPolicy.retention.count = 12; }],
    ['day retention', a => { a.auditPolicy.retention = { unit: 'days', count: 395 }; }],
    ['changed agreement', a => { a.auditPolicy.agreementVersion = 'unknown'; }], ['extra field', a => { a.email = 'private@example.invalid'; }],
    ['duplicate actions', a => { a.actions = ['edit', 'edit']; }], ['unsorted actions', a => { a.actions = ['edit', 'delete']; }],
    ['empty actions', a => { a.actions = []; }], ['revoked', a => { a.status = 'revoked'; }],
    ['oversized grant window', a => { a.validUntil = '2026-10-28T08:00:00.000Z'; }],
    ['email identity', a => { a.operatorSubjectKey = 'staff@example.invalid'; }]
])('approval rejects %s', (_label, change) => {
    const value = approval(); change(value);
    expect(() => accountActionApproval(value)).toThrow('dashboard_admin_access_denied');
});

test('approval proxy and accessor code is never invoked', () => {
    const getter = jest.fn(), trap = jest.fn(), value = approval();
    Object.defineProperty(value, 'actions', { get: getter, enumerable: true });
    expect(() => accountActionApproval(value)).toThrow();
    expect(() => accountActionApproval(new Proxy(approval(), { ownKeys: trap }))).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test('real runtime refreshes independent action approval for authorization and native operations', async () => {
    const h = fixture(), req = h.request();
    await expect(h.authorise(req)).resolves.toBe(true);
    const result = await h.runtime.adapter.inspect(SELECTOR, h.context(req));
    expect(result.displayName).toBe('Immutable Organisation'); expect(h.config.readApprovedActionBinding).toHaveBeenCalledTimes(2);
    expect(h.nativeConfiguration.authoriseAdministration()).toBe(false);
    for (const [query] of h.config.readApprovedActionBinding.mock.calls) {
        expect(query).toEqual({ operatorSubjectKey: ACTOR, purpose: 'account_support', instanceId: uid(6), selector: SELECTOR });
        expect(Object.isFrozen(query)).toBe(true);
    }
    expect(h.config.pool.connect).not.toHaveBeenCalled();
});

test('source-only runtime cannot mutate underlying parent sessions or issuance proofs', async () => {
    const h = fixture(), selected = sessionFactory.mock.calls[0][0];
    await expect(selected.browserAuthOptions.store.createSession()).rejects.toMatchObject({ statusCode: 503 });
    await expect(selected.browserAuthOptions.store.deleteSession()).rejects.toMatchObject({ statusCode: 503 });
    await expect(selected.proofStore.createOriginalProof()).rejects.toMatchObject({ statusCode: 503 });
    expect(h.sourceStore.createSession).not.toHaveBeenCalled(); expect(h.sourceStore.deleteSession).not.toHaveBeenCalled();
    expect(h.proofStore.createOriginalProof).not.toHaveBeenCalled();
});

test('read-only grant cannot authorize actions or advertise action capability', async () => {
    const h = fixture(); h.state.approval.purpose = 'account_lookup'; h.state.approval.actions = ['dashboard.authority.read'];
    await expect(h.serviceFor(h.request()).capabilities(PRINCIPAL)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.inspectAccountAction).not.toHaveBeenCalled(); expect(h.repository.commitAccountAction).not.toHaveBeenCalled();
});

test.each(['provider', 'subjectKey', 'tenantId', 'organisationId'])('approval scope cannot be substituted through %s', async field => {
    const h = fixture(), selected = { ...SELECTOR, [field]: field === 'provider' ? 'legacy' : field === 'subjectKey' ? uid(20) + ':' + uid(21) : 'another-scope' };
    await expect(h.authorise(h.request(), selected)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.queries).not.toContain('effect');
});

test.each([
    ['binding revision', h => { h.state.approval.revision++; }],
    ['action removed', h => { h.state.approval.actions = ['delete', 'restore']; }],
    ['identity policy', h => { h.state.capture.identityPayload.policyRevision++; }],
    ['restore epoch', h => { h.state.capture.restoreEpoch = uid(30); }],
    ['operator', h => { h.state.capture.identityPayload.oid = uid(31); }],
    ['capture kind', h => { h.state.capture.kind = 'customer_dashboard'; }],
    ['approval revoked', h => { h.state.approval.status = 'revoked'; }],
    ['audit policy revision', h => { h.state.approval.auditPolicy.revision++; }]
])('a current %s change cannot reuse the pinned request approval', async (_name, change) => {
    const h = fixture(), req = h.request(); await h.authorise(req); change(h);
    await expect(h.runtime.adapter.commit({ selector: SELECTOR, action: 'edit' }, h.context(req))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.queries).not.toContain('effect'); expect(h.state.queries).not.toContain('COMMIT');
});

test('same request cannot change selected organisation after an earlier authorization', async () => {
    const h = fixture(), req = h.request(); await h.authorise(req);
    await expect(h.authorise(req, { ...SELECTOR, organisationId: 'different' })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.config.readApprovedActionBinding).toHaveBeenCalledTimes(1);
});

test('adapter ports require a previously authorized genuine request and current precommit approval', async () => {
    const h = fixture(), req = h.request();
    await expect(h.runtime.adapter.inspect(SELECTOR, h.context(req))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.inspectAccountAction).not.toHaveBeenCalled();
    await h.authorise(req);
    await expect(h.runtime.adapter.commit({ selector: SELECTOR, action: 'edit' }, h.context(req, {
        beforeCommit: async () => { throw denied(); }
    }))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.commitAccountAction).not.toHaveBeenCalled();
});

test.each(['plain request', 'proxy request', 'customer principal', 'foreign principal'])('runtime refuses %s', async mode => {
    const h = fixture(); let req = h.request(), actor = PRINCIPAL;
    if (mode === 'plain request') req = { method: 'POST' };
    if (mode === 'proxy request') req = new Proxy(req, {});
    if (mode === 'customer principal') actor = { ...actor, provider: 'external' };
    if (mode === 'foreign principal') actor = { ...actor, subjectKey: uid(40) + ':' + uid(41) };
    await expect(h.authorise(req, SELECTOR, 'edit', actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.queries).not.toContain('effect');
});

test.each(['gate denied', 'gate not ready', 'capture failed'])('no capability or source operation when native %s', async mode => {
    const h = fixture();
    if (mode === 'gate denied') h.state.gateReady = false;
    if (mode === 'gate not ready') h.state.nativeState = 'unavailable';
    if (mode === 'capture failed') sessionFactory.mock.results[0].value.captureRequest.mockRejectedValue(denied());
    await expect(h.serviceFor(h.request()).capabilities(PRINCIPAL)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.inspectAccountAction).not.toHaveBeenCalled(); expect(h.repository.commitAccountAction).not.toHaveBeenCalled();
});

test.each(['signal', 'context expiry', 'request abort', 'wall deadline', 'backwards clock'])('%s during native await prevents the next SQL effect', async mode => {
    const h = fixture(), req = h.request(); await h.authorise(req);
    const controller = new AbortController(), expired = { value: false };
    const ctx = h.context(req, { signal: controller.signal, check() { if (expired.value) throw new DashboardAdminError(409, 'dashboard_admin_conflict'); return h.state.now; } });
    let wall;
    h.state.beforeQuery = async label => {
        if (label !== 'effect') return;
        if (mode === 'signal') controller.abort();
        if (mode === 'context expiry') expired.value = true;
        if (mode === 'request abort') req.aborted = true;
        if (mode === 'wall deadline') { const original = Date.now(); wall = jest.spyOn(Date, 'now').mockReturnValue(original + 1001); }
        if (mode === 'backwards clock') h.state.now = '2026-10-28T05:59:59.000Z';
    };
    try {
        await expect(h.runtime.adapter.commit({ selector: SELECTOR, action: 'edit' }, ctx)).rejects.toBeInstanceOf(Error);
    } finally { wall?.mockRestore(); }
    expect(h.state.queries).not.toContain('effect'); expect(h.state.queries).not.toContain('COMMIT');
});

test('approval expiry reached during approval read denies before source SQL', async () => {
    const h = fixture(); h.config.readApprovedActionBinding.mockImplementation(async () => { h.state.now = h.state.approval.validUntil; return clone(h.state.approval); });
    await expect(h.authorise(h.request())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.inspectAccountAction).not.toHaveBeenCalled();
});

test('native query callback cannot be invoked outside a bound request invocation', () => {
    const h = fixture(); expect(() => h.nativeConfiguration.beforeQuery('COMMIT')).toThrow('dashboard_admin_unavailable');
});

test('service translates private native/provider failures to fixed unavailable code', async () => {
    const h = fixture(); h.repository.validateAccountActionSession.mockRejectedValue(new Error('PRIVATE_DATABASE_DIAGNOSTIC'));
    await expect(h.serviceFor(h.request()).capabilities(PRINCIPAL)).rejects.toMatchObject({ code: 'dashboard_admin_access_denied', statusCode: 403 });
    const g = fixture(), req = g.request();
    g.repository.inspectAccountAction.mockRejectedValue(new Error('PRIVATE_DATABASE_DIAGNOSTIC'));
    await expect(g.serviceFor(req).inspect(PRINCIPAL, SELECTOR)).rejects.toMatchObject({ code: 'dashboard_admin_unavailable', statusCode: 503 });
});

test('native session 503 retains unavailable semantics across the action policy boundary', async () => {
    const h = fixture();
    // Native runtime errors have their own class/code rather than being
    // DashboardAdminError. Their availability classification must survive.
    h.repository.validateAccountActionSession.mockRejectedValue(Object.assign(new Error('PRIVATE_NATIVE_DATABASE_DETAIL'),
        { statusCode: 503, code: 'onboarding_unavailable' }));
    await expect(h.serviceFor(h.request()).capabilities(PRINCIPAL)).rejects.toMatchObject({
        code: 'dashboard_admin_unavailable', statusCode: 503, message: 'dashboard_admin_unavailable' });
    expect(h.repository.inspectAccountAction).not.toHaveBeenCalled();
});

test('production composition is inert unless the explicit own source option exists', () => {
    const getter = jest.fn(), dashboard = {};
    Object.defineProperty(dashboard, 'clock', { get: getter });
    expect(createProductionDashboardAccountActions(dashboard)).toEqual({});
    expect(createProductionDashboardAccountActions(dashboard, { dashboardAccountActions: null })).toEqual({});
    expect(createProductionDashboardAccountActions(dashboard, Object.create({ dashboardAccountActions: {} }))).toEqual({});
    expect(getter).not.toHaveBeenCalled(); expect(nativeFactory).not.toHaveBeenCalled(); expect(sessionFactory).not.toHaveBeenCalled();
});

test('explicit production composition returns real isolated runtime ports and caps its request budget', () => {
    const h = fixture(), dashboard = { ...h.config, requestBudgetMs: 60000 };
    const result = createProductionDashboardAccountActions(dashboard, { dashboardAccountActions: {
        readApprovedActionBinding: h.config.readApprovedActionBinding, confirmationStore: h.config.confirmationStore } });
    expect(Object.keys(result)).toEqual(['dashboardAdminAccountActions']);
    expect(result.dashboardAdminAccountActions.requestBudgetMs).toBe(10000);
    expect(Object.keys(result.dashboardAdminAccountActions.adapter)).toEqual(['inspect', 'commit', 'outcome']);
});

test('production withholds reset despite approval, settings, injected adapter and a retained confirmation', async () => {
    const { tokenDigest } = require('../api/shared/dashboardAdmin/accountActionService');
    const { commandDigest } = require('../api/shared/dashboardAdmin/accountActionRecords');
    const reset = { inspect: jest.fn(), commit: jest.fn(), outcome: jest.fn() };
    const h = fixture(); h.state.approval.actions = ['delete', 'edit', 'reset', 'restore'];
    const production = createProductionDashboardAccountActions(h.config, { dashboardAccountActions: {
        readApprovedActionBinding: h.config.readApprovedActionBinding,
        confirmationStore: h.config.confirmationStore, signupReset: reset
    } }, { NOFRIES_DASHBOARD_ADMIN_RESET_SOURCE_SHA: 'a'.repeat(40),
        NOFRIES_SIGNUP_RESET_WRITER_CONTRACT: 'external_signup_writers_v1' }).dashboardAdminAccountActions;
    const service = () => h.serviceFor(h.request(), production);
    expect((await service().inspect(PRINCIPAL, SELECTOR)).actions).not.toContain('reset');
    await expect(service().prepare(PRINCIPAL, { selector: SELECTOR, action: 'reset', patch: null,
        confirmationName: 'Immutable Organisation' })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.records.size).toBe(0);
    const command = { schemaVersion: 1, operationId: uid(90), actorSubjectKey: ACTOR, selector: SELECTOR,
        expectedVersion: hash('synthetic-version'), action: 'reset', patch: null, preparedAt: NOW,
        expiresAt: '2026-10-28T06:05:00.000Z', witness: {
            authoritySha256: hash(h.state.approval), restoreEpoch: uid(7)
        } };
    const token = Buffer.alloc(32, 91).toString('base64url');
    h.state.records.set(tokenDigest(token), { ...command, commandSha256: commandDigest(command) });
    await expect(service().execute(PRINCIPAL, { confirmationToken: token })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.commitAccountAction).not.toHaveBeenCalled();
    for (const method of Object.values(reset)) expect(method).not.toHaveBeenCalled();
    // The reset hold must not remove the existing non-reset action capability.
    const preview = await service().prepare(PRINCIPAL, { selector: SELECTOR, action: 'edit', patch: { displayLabel: 'Staff label' } });
    expect((await service().execute(PRINCIPAL, { confirmationToken: preview.confirmationToken })).status).toBe('succeeded');
    expect(h.repository.commitAccountAction).toHaveBeenCalledTimes(1);
});

test.each([undefined, false, {}, { readApprovedActionBinding: async () => null },
    { readApprovedActionBinding: null, confirmationStore: {} }, new Proxy({}, {})])('malformed explicit production selection rejects: %p', selected => {
    const h = fixture();
    expect(() => createProductionDashboardAccountActions(h.config, { dashboardAccountActions: selected }))
        .toThrow('dashboard_admin_account_actions_configuration_invalid');
});

test('production refuses accessor/proxy configuration without invoking its code', () => {
    const h = fixture(), getter = jest.fn(), trap = jest.fn(), dependencies = {};
    Object.defineProperty(dependencies, 'dashboardAccountActions', { get: getter });
    expect(() => createProductionDashboardAccountActions(h.config, dependencies)).toThrow();
    expect(() => createProductionDashboardAccountActions(h.config, new Proxy({}, { getOwnPropertyDescriptor: trap }))).toThrow();
    const dashboard = { ...h.config };
    Object.defineProperty(dashboard, 'clock', { get: getter, enumerable: true });
    expect(() => createProductionDashboardAccountActions(dashboard, { dashboardAccountActions: {
        readApprovedActionBinding: h.config.readApprovedActionBinding, confirmationStore: h.config.confirmationStore } })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test.each([null, false, {}, { create: async () => true, load: null }, new Proxy({ create() {}, load() {} }, {})])
('runtime rejects unavailable durable confirmation store before exposing ports: %p', confirmationStore => {
    const h = fixture();
    expect(() => createDashboardAdminAccountActionRuntime({ ...h.config, confirmationStore })).toThrow('dashboard_admin_unavailable');
});

test('runtime refuses a confirmation store accessor without invoking it', () => {
    const h = fixture(), getter = jest.fn(), confirmationStore = { create: async () => true };
    Object.defineProperty(confirmationStore, 'load', { get: getter, enumerable: true });
    expect(() => createDashboardAdminAccountActionRuntime({ ...h.config, confirmationStore })).toThrow('dashboard_admin_unavailable');
    expect(getter).not.toHaveBeenCalled();
});


test('capability checks do not pin the first target; each selected target requires its own current approval', async () => {
    const h = fixture(), req = h.request(), selected = { ...SELECTOR, organisationId: 'second-authorised-organisation' };
    h.config.readApprovedActionBinding.mockImplementation(async query => ({ ...approval(), selector: clone(query.selector || SELECTOR) }));
    await expect(h.authorise(req, null, null)).resolves.toBe(true);
    await expect(h.authorise(req, selected, 'edit')).resolves.toBe(true);
    expect(h.config.readApprovedActionBinding.mock.calls.at(-1)[0].selector).toEqual(selected);
    await expect(h.authorise(req, SELECTOR, 'edit')).rejects.toHaveProperty('statusCode', 403);
});
