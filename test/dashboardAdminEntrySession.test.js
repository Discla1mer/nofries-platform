'use strict';

const { entrySessionFixture, clone, uid } = require('./fixtures/dashboardAdminEntrySession');
const PURPOSE = { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' };
const CUSTOMER = '__Host-nofries-customer=' + Buffer.alloc(32, 92).toString('base64url');
const EXTERNAL = '__Host-nofries-external-customer=' + Buffer.alloc(32, 93).toString('base64url');
let warnings;
beforeEach(() => { warnings = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
    expect(warnings.mock.calls.flat().join(' ')).not.toMatch(/synthetic-|secret|entry@example|__Host-/);
    warnings.mockRestore();
});
function session(h, method, cookie, headers = PURPOSE, body = { operationId: h.nextId() }) {
    let op = h.send(method, '/api/dashboard/session').set(headers);
    if (cookie) op = op.set('Cookie', cookie);
    if (method === 'post') op = op.set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(body);
    return op;
}
function noEffects(h) {
    expect(h.state.trace).toEqual([]);
    for (const spy of [...Object.values(h.storeSpies), ...Object.values(h.proofStore), h.readExternalRuntimeEpoch,
        h.dashboard.newRequestId, h.dashboard.newOperationId, h.pool.connect,
        ...Object.values(h.customerSpies.legacy.policy), h.customerSpies.legacy.resolveActivationBinding,
        ...Object.values(h.customerSpies.external.policy), h.customerSpies.external.resolveActivationBinding,
        ...Object.values(h.customerSpies.activation)]) expect(spy).not.toHaveBeenCalled();
}
function privateFailure(result, status, code) {
    expect(result.status).toBe(status); expect(result.body).toEqual({ code });
    expect(result.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(result.text).not.toMatch(/entry@example|synthetic-|sessionSha256|oid|scope|identity|cookie|secret/);
}

test('actual callback then explicit operator initialization creates the genuine gate, receipt and audit without seeded session state', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    expect(h.proofs.size).toBe(1); expect(h.state.tables.dashboard_session_gates).toEqual([]);
    const needed = await session(h, 'get', cookie);
    privateFailure(needed, 409, 'dashboard_initialization_required');
    expect(h.state.tables.dashboard_session_gates).toEqual([]);
    expect(h.state.tables.dashboard_runtime_receipts).toEqual([]);
    const operationId = h.nextId();
    expect((await session(h, 'post', cookie, PURPOSE, { operationId })).body).toEqual({ schemaVersion: 1, initialized: true });
    expect(h.state.tables.dashboard_session_gates).toHaveLength(1);
    expect(h.state.tables.dashboard_session_gates[0]).toMatchObject({ kind: 'operator_dashboard', status: 'active', selected_binding_id: null });
    expect(h.state.tables.dashboard_runtime_receipts).toHaveLength(1);
    expect(h.state.tables.dashboard_runtime_receipts[0]).toMatchObject({ operation_type: 'initializeOperatorSession', operation_id: operationId });
    expect(h.state.tables.dashboard_runtime_audit).toHaveLength(1);
    const ready = await session(h, 'get', cookie);
    expect(ready.status).toBe(200); expect(ready.body).toMatchObject({ authenticated: true, purpose: 'operator_dashboard', selectedBindingId: null });
    expect(h.state.tables.dashboard_runtime_audit).toHaveLength(2);
    for (const group of [h.customerSpies.legacy, h.customerSpies.external]) {
        expect(group.resolveActivationBinding).not.toHaveBeenCalled(); expect(group.policy.recheck).not.toHaveBeenCalled();
    }
});

test.each(['get', 'post'])('%s refuses every competing customer cookie before authentication or state work', async method => {
    for (const competing of [CUSTOMER, EXTERNAL, CUSTOMER + '; ' + EXTERNAL, '__Host-nofries-customer=',
        '  __Host-nofries-external-customer=invalid', '__Host-nofries-customer =invalid']) {
        for (const mixed of [false, true]) {
            const h = entrySessionFixture(), { cookie } = await h.login();
            const tables = clone(h.state.tables), parents = [...h.store.sessions.entries()].map(clone);
            h.resetObservations();
            const result = await session(h, method, mixed ? cookie + '; ' + competing : competing);
            privateFailure(result, 403, 'dashboard_access_denied'); noEffects(h);
            expect(h.state.tables).toEqual(tables); expect([...h.store.sessions.entries()].map(clone)).toEqual(parents);
        }
    }
});

test.each(['get', 'post'])('%s rejects customer cookie names even when customer transports are not composed', async method => {
    const h = entrySessionFixture({ customer: false, externalCustomer: false }), { cookie } = await h.login();
    h.resetObservations();
    privateFailure(await session(h, method, cookie + '; ' + EXTERNAL), 403, 'dashboard_access_denied'); noEffects(h);
});

test.each(['', 'customer', 'Operator_Dashboard', 'operator_dashboard, operator_dashboard', 'operator_dashboard; customer'])
('rejects malformed purpose %p before I/O', async purpose => {
    const h = entrySessionFixture(), { cookie } = await h.login(); h.resetObservations();
    privateFailure(await session(h, 'get', cookie, { 'X-Nofries-Dashboard-Purpose': purpose }), 400, 'dashboard_input_invalid'); noEffects(h);
});

test.each(['get', 'post'])('%s rejects duplicate exact purpose headers over the actual HTTP transport', async method => {
    const h = entrySessionFixture(), { cookie } = await h.login(); h.resetObservations();
    privateFailure(await session(h, method, cookie,
        { 'X-Nofries-Dashboard-Purpose': ['operator_dashboard', 'operator_dashboard'] }), 400, 'dashboard_input_invalid'); noEffects(h);
});

test.each(['/api/dashboard/organisations', '/api/dashboard/bootstrap', '/api/dashboard/modules/overview'])
('purpose header on non-session route %s fails before providers', async path => {
    const h = entrySessionFixture(), { cookie } = await h.login(); h.resetObservations();
    privateFailure(await h.send('get', path).set('Cookie', cookie).set(PURPOSE), 400, 'dashboard_input_invalid'); noEffects(h);
});

test.each([
    {}, { operationId: 'invalid' }, { operationId: uid(300), purpose: 'operator_dashboard' },
    { operationId: uid(301), subjectKey: 'excluded' },
    { action: 'customer_activation', activationId: uid(302), phase: 'prepare' }
])('operator-purpose POST keeps a closed initialization command %p', async body => {
    const h = entrySessionFixture({ activation: true }), { cookie } = await h.login(); h.resetObservations();
    privateFailure(await session(h, 'post', cookie, PURPOSE, body), 400, 'dashboard_input_invalid'); noEffects(h);
});

test.each([{}, { Origin: 'https://foreign.invalid', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'https://entry-session.invalid', 'Sec-Fetch-Site': 'cross-site' }])
('operator-purpose POST retains exact same-origin protection %p', async headers => {
    const h = entrySessionFixture(), { cookie } = await h.login(); h.resetObservations();
    privateFailure(await h.send('post', '/api/dashboard/session').set('Cookie', cookie).set(PURPOSE).set(headers)
        .send({ operationId: h.nextId() }), 403, 'dashboard_access_denied'); noEffects(h);
});

test('a customer cookie arriving after the initial session check cannot activate a customer through the entry POST', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    privateFailure(await session(h, 'get', cookie), 409, 'dashboard_initialization_required');
    h.resetObservations();
    privateFailure(await session(h, 'post', cookie + '; ' + CUSTOMER), 403, 'dashboard_access_denied'); noEffects(h);
    expect(h.state.tables.dashboard_session_gates).toEqual([]); expect(h.state.tables.dashboard_runtime_receipts).toEqual([]);
    expect((await session(h, 'post', cookie)).status).toBe(200);
    expect(h.state.tables.dashboard_session_gates[0].kind).toBe('operator_dashboard');
});

test('concurrent competing-cookie POST has no effects while a genuine operator GET is pending', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    let held = false;
    h.state.beforeSql = async ({ sql }) => { if (!held && sql === 'BEGIN') { held = true; entered(); await hold; } };
    const pending = Promise.resolve(session(h, 'get', cookie));
    try {
        await ready;
        const trace = clone(h.state.trace), loads = h.storeSpies.loadSession.mock.calls.length;
        privateFailure(await session(h, 'post', cookie + '; ' + EXTERNAL), 403, 'dashboard_access_denied');
        expect(h.state.trace).toEqual(trace); expect(h.storeSpies.loadSession.mock.calls).toHaveLength(loads);
        expect(h.customerSpies.external.resolveActivationBinding).not.toHaveBeenCalled();
        expect(h.state.tables.dashboard_session_gates).toEqual([]);
    } finally { release(); }
    privateFailure(await pending, 409, 'dashboard_initialization_required');
});

test('same native operation ID is idempotent across repeated explicit initialization', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login(), body = { operationId: h.nextId() };
    expect((await session(h, 'post', cookie, PURPOSE, body)).status).toBe(200);
    const tables = clone(h.state.tables);
    expect((await session(h, 'post', cookie, PURPOSE, body)).status).toBe(200);
    expect(h.state.tables).toEqual(tables);
});

test('revoked native gate is refused despite a still-valid staff parent', async () => {
    const { createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');
    const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
    const h = entrySessionFixture(), { cookie } = await h.login();
    expect((await session(h, 'post', cookie)).status).toBe(200);
    const d = h.dashboard;
    const capture = createDashboardOperatorSession(Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock',
        'readExternalRuntimeEpoch', 'newRequestId', 'requestBudgetMs'].map(key => [key, d[key]])));
    const runtime = createPostgresDashboardRuntimeRepository({ pool: h.pool, clock: d.clock, instanceId: d.instanceId,
        historyBudget: d.historyBudget, readExternalRuntimeEpoch: d.readExternalRuntimeEpoch, newId: d.newId,
        newGenerationToken: d.newGenerationToken, captureRequest: capture.captureRequest,
        readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false });
    await runtime.revokeSession({ headers: { cookie } }, { operationId: h.nextId() });
    expect(h.state.tables.dashboard_session_gates[0].status).toBe('revoked');
    expect(h.store.sessions.size).toBe(1);
    const before = clone(h.state.tables);
    privateFailure(await session(h, 'get', cookie), 403, 'dashboard_access_denied');
    privateFailure(await session(h, 'post', cookie), 403, 'dashboard_access_denied');
    expect(h.state.tables).toEqual(before);
});

test('expired parent cannot use a retained ready gate', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    expect((await session(h, 'post', cookie)).status).toBe(200);
    h.state.now = Date.parse([...h.proofs.values()][0].expiresAt);
    const tables = clone(h.state.tables); h.resetObservations();
    privateFailure(await session(h, 'get', cookie), 401, 'dashboard_authentication_required');
    expect(h.state.tables).toEqual(tables); expect(h.state.trace).toEqual([]);
});

test('header-absent staff GET/POST retain the existing protocol', async () => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    privateFailure(await session(h, 'get', cookie, {}), 409, 'dashboard_initialization_required');
    expect((await session(h, 'post', cookie, {})).body).toEqual({ schemaVersion: 1, initialized: true });
    const ready = await session(h, 'get', cookie, {});
    expect(ready.status).toBe(200); expect(ready.body.purpose).toBe('operator_dashboard');
});

test.each(['__Host-nofries-customer', '__Host-nofries-external-customer'])
('header-absent %s still selects its original configured authentication path', async name => {
    const h = entrySessionFixture(), { cookie } = await h.login();
    h.resetObservations();
    privateFailure(await session(h, 'get', name + '=' + cookie.split('=')[1], {}), 401, 'dashboard_authentication_required');
    expect(h.storeSpies.loadSession).toHaveBeenCalled(); expect(h.pool.connect).not.toHaveBeenCalled();
});
