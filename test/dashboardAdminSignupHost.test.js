'use strict';

// Actual Express/native-request/staff-session composition. Blob records and
// operator/population decisions are synthetic; audit acknowledgements below are
// test doubles and establish no production durability or restore acceptance.
const { createServer, IncomingMessage, request: httpRequest } = require('node:http');
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createFiniteSignupPageReader } = require('../api/shared/dashboardAdmin/finiteSignupIndex');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { fixture, clone } = require('./fixtures/dashboardAdminSignupData');
const { runtimeFixture } = require('./fixtures/dashboardAdminSignupRuntime');

const uid = n => '73000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), ACTOR = uid(2), CLIENT = uid(3), SUBJECT = TENANT + ':' + ACTOR;
const TOKEN = Buffer.alloc(32, 73).toString('base64url'), COOKIE = '__Host-nofries-auth=' + TOKEN;
const syntheticAck = event => ({ schemaVersion: 1, durable: true, eventSha256: hash(event) });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function harness({ provider = 'legacy', role = 'admin', configured = true, reader = true,
    audit = true, requestBudgetMs = 1000 } = {}) {
    const data = await fixture(provider), now = data.clock();
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-signup-host-secret',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: role === 'admin' ? SUBJECT : '',
        NOFRIES_DASHBOARD_ADMIN_SIGNUPS_ENABLED: 'true' };
    const store = new MemoryBrowserSessionStore();
    await store.createSession(TOKEN, { v: 1, kind: 'browser_session',
        issuedAt: Date.parse(now) - 60000, idleExpiresAt: Date.parse(now) + 60000,
        absoluteExpiresAt: Date.parse(now) + 600000,
        identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT,
            principalId: ACTOR, subjectKey: SUBJECT, name: 'Synthetic operator', email: 'operator@example.invalid' } });
    const pool = { connect: jest.fn(async () => { throw new Error('UNEXPECTED_DATABASE_ACCESS'); }), end: jest.fn() };
    const dashboard = { browserAuthOptions: { env, store },
        identityPolicy: { policyId: 'synthetic-signup-host-policy', policyRevision: 1,
            issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
        proofStore: { createOriginalProof: jest.fn(), readOriginalProof: jest.fn(async () => null) },
        clock: data.clock, readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: uid(10), restoreEpoch: uid(11) })),
        newRequestId: () => uid(12), requestBudgetMs: 1000, pool, instanceId: uid(10),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(13), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => uid(14) };
    const grant = { schemaVersion: 1, capability: 'signupList', operatorSubjectKey: SUBJECT, provider,
        tenantId: data.entry.binding.tenantId, populationId: 'synthetic-host-population', indexId: 'synthetic-host-index',
        authorityRevision: 1, issuedAt: new Date(Date.parse(now) - 1000).toISOString(),
        expiresAt: new Date(Date.parse(now) + 60000).toISOString(), maxPageSize: 1, maxRows: 4, maxPages: 4,
        fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-host-audit-policy' };
    const manifest = { schemaVersion: 1, provider, tenantId: grant.tenantId,
        populationId: grant.populationId, indexId: grant.indexId, entries: [data.entry] };
    const state = { grant, binding: { authoritySha256: hash(grant), manifestSha256: hash(manifest) },
        sessionReads: 0, onSessionRead: null };
    const loadSession = store.loadSession.bind(store);
    store.loadSession = async token => {
        state.sessionReads++;
        if (state.onSessionRead) await state.onSessionRead(state.sessionReads);
        return loadSession(token);
    };
    const indexPorts = { manifest, resolvePopulationBinding: jest.fn(async () => state.binding),
        readEntrySummary: jest.fn(data.read), clock: data.clock, requestBudgetMs };
    const read = createFiniteSignupPageReader(indexPorts);
    const ports = { authoriseSignupList: jest.fn(async () => state.grant),
        readSignupPage: reader ? jest.fn((query, context) => read(query, { signal: context.signal })) : null,
        audit: audit ? jest.fn(async event => syntheticAck(event)) : null,
        clock: data.clock, requestBudgetMs };
    const configuration = { dashboard, ...(configured ? { dashboardAdminSignupList: ports } : {}) };
    return { app: createNoFriesApp(configuration), configuration, dashboard, env, store, pool, data,
        grant, state, manifest, indexPorts, read, ports };
}
function list(h, { cursor = null, server = h.app, label, cookie = COOKIE } = {}) {
    let op = request(server).post('/api/dashboard-admin/signups').set('Cookie', cookie)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin');
    if (label) op = op.set('X-Signup-Host-Test', label);
    return op.send({ cursor });
}
function privateError(result, status, code) {
    expect(result.status).toBe(status); expect(result.body).toEqual({ code });
    expect(result.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(result.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(result.text).not.toMatch(/UNEXPECTED_DATABASE_ACCESS|PRIVATE_SOURCE|synthetic-signup-host-secret|operator@example|Private Synthetic/);
}

test.each(['legacy', 'external'])('actual host maps exact %s starter stores and exposes only supported facts', async provider => {
    const h = await harness({ provider });
    const capabilities = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', COOKIE);
    expect(capabilities.body).toEqual({ lookup: false, recovery: [], signupList: true });
    const result = await list(h);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'available', observedAt: h.data.clock(), nextCursor: null, continuation: 'end',
        rows: [{ email: h.data.account.email, organisation: h.data.account.organisations[0].organisationName,
            accountType: 'consultant', milestones: {
                accountSaved: { status: 'recorded', at: h.data.account.createdAt },
                setupSaved: { status: 'recorded', at: h.data.setup.assertion.receivedAt },
                termsAccepted: { status: 'unknown', at: null }, accountActivated: { status: 'unknown', at: null },
                admission: { status: 'unknown', at: null }
            } }] });
    expect(h.data.reads).toEqual([h.data.accountPath, h.data.setupPath]); expect(h.data.writes).toEqual([]);
    expect(result.text).not.toMatch(/starter-accounts|starter-setups|etag|authority|proof|Private Synthetic|PRIVATE-SYNTHETIC-ID|subjectKey|recordId/);
    expect(h.ports.audit.mock.calls.map(([event]) => [event.phase, event.outcome])).toEqual([['attempt', 'requested'], ['outcome', 'available']]);
    expect(h.pool.connect).not.toHaveBeenCalled();
}, 20000); // Whole positive journey only; actual request deadlines stay unchanged.

test('repeated initial searches read current exact data without reusing a disclosure receipt', async () => {
    const h = await harness();
    const first = await list(h), second = await list(h);
    expect(first.status).toBe(200); expect(second.body).toEqual(first.body);
    expect(h.data.reads).toHaveLength(4);
    const ids = h.ports.audit.mock.calls.filter(([event]) => event.phase === 'attempt').map(([event]) => event.requestId);
    expect(new Set(ids).size).toBe(2);
});

test('real staff session and environment opt-in strings cannot create absent listing composition', async () => {
    const h = await harness({ configured: false });
    privateError(await list(h), 404, 'dashboard_admin_not_found');
    privateError(await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', COOKIE), 503, 'dashboard_admin_unavailable');
    expect(h.ports.authoriseSignupList).not.toHaveBeenCalled(); expect(h.data.reads).toEqual([]);
    const app = createNoFriesApp({ ...h.configuration, dashboardAdminSignupList: null });
    privateError(await list(h, { server: app }), 404, 'dashboard_admin_not_found');
});

test.each(['authoriseSignupList', 'readSignupPage', 'audit', 'clock', 'requestBudgetMs'])
('incomplete listing composition rejects missing %s before I/O', async key => {
    const h = await harness(), ports = { ...h.ports }; delete ports[key];
    expect(() => createNoFriesApp({ dashboard: h.dashboard, dashboardAdminSignupList: ports }))
        .toThrow(expect.objectContaining({ code: 'browser_auth_dashboard_unavailable' }));
    expect(h.data.reads).toEqual([]); expect(h.pool.connect).not.toHaveBeenCalled();
});

test('listing requires dashboard session composition and captures trusted port functions', async () => {
    const h = await harness();
    expect(() => createNoFriesApp({ dashboardAdminSignupList: h.ports })).toThrow();
    const port = { ...h.ports };
    Object.defineProperty(port, 'audit', { enumerable: true, get() { throw new Error('UNEXPECTED_GETTER'); } });
    expect(() => createNoFriesApp({ dashboard: h.dashboard, dashboardAdminSignupList: port }))
        .toThrow(expect.objectContaining({ code: 'browser_auth_dashboard_unavailable' }));
    const proxy = { ...h.ports, authoriseSignupList: new Proxy(h.ports.authoriseSignupList, {}) };
    expect(() => createNoFriesApp({ dashboard: h.dashboard, dashboardAdminSignupList: proxy })).toThrow();
    h.ports.authoriseSignupList = () => { throw new Error('UNEXPECTED_REPLACEMENT'); };
    expect((await list(h)).status).toBe(200);
});

test.each(['reader', 'audit'])('explicitly absent %s advertises no listing capability and performs no read', async key => {
    const h = await harness({ [key]: false });
    const result = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', COOKIE);
    expect(result.status).toBe(200); expect(result.body).toEqual({ lookup: false, recovery: [], signupList: false });
    privateError(await list(h), 503, 'dashboard_admin_unavailable'); expect(h.data.reads).toEqual([]);
    if (h.ports.audit) expect(h.ports.audit).not.toHaveBeenCalled();
});

test.each(['__Host-nofries-customer=', '__Host-nofries-external-customer='])
('customer cookie %s never reaches the operator/listing decision', async prefix => {
    const h = await harness();
    privateError(await list(h, { cookie: prefix + TOKEN }), 401, 'dashboard_admin_authentication_required');
    expect(h.ports.authoriseSignupList).not.toHaveBeenCalled(); expect(h.ports.audit).not.toHaveBeenCalled();
    expect(h.data.reads).toEqual([]);
});

test('allowed staff Consultant cannot reach listing, including protected assets', async () => {
    const h = await harness({ role: 'consultant' });
    privateError(await list(h), 403, 'dashboard_admin_access_denied');
    for (const path of ['/dashboard-admin', '/api/dashboard-admin/app.js', '/api/dashboard-admin/app.css']) {
        privateError(await request(h.app).get(path).set('Cookie', COOKIE), 403, 'dashboard_admin_access_denied');
    }
    expect(h.ports.authoriseSignupList).not.toHaveBeenCalled(); expect(h.data.reads).toEqual([]);
});

test.each([null, true, { lookup: true }])('missing/lookup-only policy %p never grants listing', async grant => {
    const h = await harness(); h.state.grant = grant;
    privateError(await list(h), 403, 'dashboard_admin_access_denied');
    expect(h.ports.audit).not.toHaveBeenCalled(); expect(h.data.reads).toEqual([]);
});

test.each(['attempt', 'outcome'])('unacknowledged %s audit withholds all row data without retry', async phase => {
    const h = await harness();
    h.ports.audit.mockImplementation(async event => event.phase === phase ? undefined : syntheticAck(event));
    privateError(await list(h), 503, 'dashboard_admin_unavailable');
    expect(h.ports.audit).toHaveBeenCalledTimes(phase === 'attempt' ? 1 : 2);
    expect(h.data.reads).toHaveLength(phase === 'attempt' ? 0 : 2);
});

test.each(['throw', 'missing', 'foreign'])('source %s gives audited unavailable, not verified empty success', async mode => {
    const h = await harness();
    if (mode === 'throw') h.data.duringRead(() => { throw new Error('PRIVATE_SOURCE'); });
    if (mode === 'missing') h.data.blobs.delete(h.data.accountPath);
    if (mode === 'foreign') h.data.blobs.get(h.data.accountPath).accountId = uid(50);
    const result = await list(h);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'unavailable', rows: [], observedAt: null, nextCursor: null, continuation: 'unavailable' });
    expect(h.ports.audit.mock.calls.at(-1)[0]).toMatchObject({ phase: 'outcome', outcome: 'unavailable', count: 0 });
    expect(result.text).not.toContain('PRIVATE_SOURCE'); expect(h.data.reads).toHaveLength(1);
});

test('missing setup remains unknown while exact account evidence is visible', async () => {
    const h = await harness(); h.data.blobs.delete(h.data.setupPath);
    const result = await list(h); expect(result.status).toBe(200);
    expect(result.body.rows[0].milestones.setupSaved).toEqual({ status: 'unknown', at: null });
    expect(result.body.rows[0].email).toBe(h.data.account.email);
});

test.each(['attempt', 'read', 'outcome'])('policy revocation during %s prevents disclosure', async phase => {
    const h = await harness();
    if (phase === 'read') h.data.duringRead(() => { h.state.grant = null; h.state.binding = null; });
    else h.ports.audit.mockImplementation(async event => { if (event.phase === phase) h.state.grant = null; return syntheticAck(event); });
    privateError(await list(h), 403, 'dashboard_admin_access_denied');
    if (phase === 'attempt') expect(h.data.reads).toEqual([]);
});

test('revoked staff session after successful source/audit withholds buffered data', async () => {
    const h = await harness();
    h.ports.audit.mockImplementation(async event => {
        if (event.phase === 'outcome') await h.store.deleteSession(TOKEN);
        return syntheticAck(event);
    });
    privateError(await list(h), 401, 'dashboard_admin_authentication_required');
    expect(h.data.reads).toHaveLength(2); expect(h.ports.audit).toHaveBeenCalledTimes(2);
});

test('listing authority revoked only at final host disclosure cannot release a completed page', async () => {
    const h = await harness();
    h.state.onSessionRead = async count => { if (count === 3) h.state.grant = null; };
    privateError(await list(h), 403, 'dashboard_admin_access_denied');
    expect(h.state.sessionReads).toBe(3); expect(h.data.reads).toHaveLength(2);
    expect(h.ports.audit.mock.calls.at(-1)[0]).toMatchObject({ phase: 'outcome', outcome: 'available' });
});

test('a page that becomes stale during the outcome audit is withheld by the actual host', async () => {
    const h = await harness();
    h.ports.audit.mockImplementation(async event => {
        if (event.phase === 'outcome') h.data.setTime(Date.parse(h.data.clock()) + 31000);
        return syntheticAck(event);
    });
    privateError(await list(h), 503, 'dashboard_admin_unavailable');
    expect(h.data.reads).toHaveLength(2); expect(h.ports.audit).toHaveBeenCalledTimes(2);
});

test('deadline aborts data continuation; late account completion cannot read setup or disclose', async () => {
    const h = await harness({ requestBudgetMs: 50 }), entered = deferred(), finish = deferred();
    h.data.duringRead(async () => { entered.resolve(); await finish.promise; });
    const response = list(h).then(value => value);
    await entered.promise;
    const result = await response; privateError(result, 503, 'dashboard_admin_unavailable');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.ports.readSignupPage.mock.calls[0][1].signal.aborted).toBe(true);
    finish.resolve(); await settle(); await settle();
    expect(h.data.reads).toEqual([h.data.accountPath]); expect(h.ports.audit).toHaveBeenCalledTimes(1);
});

test('client disconnect after the complete POST body stops later data reads and outcome audit', async () => {
    const h = await harness(), entered = deferred(), finish = deferred(), closed = deferred(), finishedRead = deferred();
    h.data.duringRead(async key => { if (key === h.data.accountPath) { entered.resolve(); await finish.promise; } });
    const read = h.ports.readSignupPage.getMockImplementation();
    h.ports.readSignupPage.mockImplementation(async (query, context) => {
        try { return await read(query, context); } finally { finishedRead.resolve(); }
    });
    const server = createServer((req, res) => { res.once('close', () => closed.resolve()); h.app(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const body = JSON.stringify({ cursor: null });
    const client = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/api/dashboard-admin/signups',
        method: 'POST', headers: { cookie: COOKIE, origin: h.env.NOFRIES_PUBLIC_URL,
            'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    client.on('error', () => {});
    try {
        client.end(body); await entered.promise;
        // The request is complete; native request.aborted alone misses this case.
        client.destroy(); await closed.promise;
        finish.resolve(); await finishedRead.promise; await settle(); await settle();
        expect(h.data.reads).toEqual([h.data.accountPath]);
        expect(h.ports.audit.mock.calls.map(([event]) => event.phase)).toEqual(['attempt']);
        expect(h.ports.readSignupPage.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
        finish.resolve(); client.destroy(); await new Promise(resolve => server.close(resolve));
    }
});

test('concurrent host calls keep their own native policy/read/audit context', async () => {
    const h = await harness(), entered = [], seen = new Map(), both = deferred();
    const server = createServer((req, res) => { seen.set(req.headers['x-signup-host-test'], req); h.app(req, res); });
    h.ports.readSignupPage.mockImplementation(async (query, context) => {
        const label = context.request.headers['x-signup-host-test'];
        expect(context.request).toBeInstanceOf(IncomingMessage); expect(context.request).toBe(seen.get(label));
        expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(query.authority)).toBe(true);
        entered.push(label); if (entered.length === 2) both.resolve();
        await both.promise;
        return h.read(query, { signal: context.signal });
    });
    const results = await Promise.all([list(h, { server, label: 'first' }), list(h, { server, label: 'second' })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(entered.sort()).toEqual(['first', 'second']);
    for (const [input] of h.ports.authoriseSignupList.mock.calls) {
        expect(input.request).toBe(seen.get(input.request.headers['x-signup-host-test']));
        expect(input).toMatchObject({ principal: { subjectKey: SUBJECT }, capability: 'signupList' });
        expect(Object.isFrozen(input)).toBe(true);
    }
    for (const [event, grant, context] of h.ports.audit.mock.calls) {
        expect(context.request).toBe(seen.get(context.request.headers['x-signup-host-test']));
        expect(grant).toEqual(h.grant); expect(Object.isFrozen(context)).toBe(true);
        expect(event).not.toHaveProperty('request'); expect(event).not.toHaveProperty('email');
    }
});

test('opaque continuation is one-use and bound to the original approved traversal', async () => {
    const h = await harness(), summary = await h.data.read(h.data.entry);
    h.data.reads.length = 0;
    const second = clone(summary.record); second.recordId = 'synthetic-second-record';
    second.binding.accountId = uid(60); second.account.binding.accountId = uid(60); second.setup.binding.accountId = uid(60);
    second.account.value.accountId = uid(60); second.setup.value.accountId = uid(60);
    second.account.value.email = 'second-synthetic@example.invalid';
    const page = (record, nextCursor) => ({ schemaVersion: 1, provider: h.grant.provider, tenantId: h.grant.tenantId,
        populationId: h.grant.populationId, indexId: h.grant.indexId, snapshotId: 'synthetic-host-snapshot',
        observedAt: h.data.clock(), status: 'available', records: [record], nextCursor });
    // These two page summaries isolate host continuation; the first success test
    // above separately exercises the actual finite index and Blob data adapter.
    h.ports.readSignupPage.mockResolvedValueOnce(page(summary.record, 'private-source-next'))
        .mockResolvedValueOnce(page(second, null));
    const first = await list(h); expect(first.status).toBe(200);
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(first.text).not.toContain('private-source-next');
    const next = await list(h, { cursor: first.body.nextCursor }); expect(next.status).toBe(200);
    expect(next.body.rows[0].email).toBe('second-synthetic@example.invalid');
    expect(h.ports.readSignupPage.mock.calls[1][0]).toMatchObject({ cursor: 'private-source-next', snapshotId: 'synthetic-host-snapshot' });
    privateError(await list(h, { cursor: first.body.nextCursor }), 400, 'dashboard_admin_input_invalid');
    expect(h.ports.readSignupPage).toHaveBeenCalledTimes(2);
});

test('listing accepts only its bounded same-origin request and offers no recovery route', async () => {
    const h = await harness();
    privateError(await request(h.app).post('/api/dashboard-admin/signups').set('Cookie', COOKIE)
        .set('Origin', 'https://foreign.invalid').send({ cursor: null }), 403, 'dashboard_admin_access_denied');
    privateError(await request(h.app).post('/api/dashboard-admin/signups').set('Cookie', COOKIE)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
        .send({ cursor: null, email: 'target@example.invalid' }), 400, 'dashboard_admin_input_invalid');
    privateError(await request(h.app).get('/api/dashboard-admin/signups').set('Cookie', COOKIE), 405, 'dashboard_admin_method_not_allowed');
    for (const suffix of ['reset', 'delete', 'grant', 'signups/extra']) {
        privateError(await request(h.app).post('/api/dashboard-admin/' + suffix).set('Cookie', COOKIE)
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).send({}), 404, 'dashboard_admin_not_found');
    }
    expect(h.data.reads).toEqual([]); expect(h.ports.audit).not.toHaveBeenCalled();
});

// These additional host cases run the actual native repository, checked
// transaction and audit writer against a synthetic SQL transport. Unlike the
// older port-isolation cases above, no durable acknowledgement is stubbed.
// PostgreSQL RLS/constraints/lock qualification remains the dedicated native gate.
async function nativeHarness(options = {}) {
    const h = await runtimeFixture(options);
    h.app = createNoFriesApp({ dashboard: h.dashboard, dashboardAdminSignupList: h.runtime });
    return h;
}
function nativeList(h, { cursor = null, server = h.app, cookie = h.cookie } = {}) {
    return request(server).post('/api/dashboard-admin/signups').set('Cookie', cookie)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ cursor });
}

test.each(['legacy', 'external'])('actual native host lists two finite %s customer tenants with independently committed page audits', async provider => {
    const h = await nativeHarness({ provider, version: 2, twoTenants: true });
    expect(h.data[0].entry.binding.tenantId).not.toBe(h.data[1].entry.binding.tenantId);
    const first = await nativeList(h); expect(first.status).toBe(200); expect(first.body.continuation).toBe('more');
    expect(first.body.rows.map(row => row.email)).toEqual([h.data[0].account.email]);
    const second = await nativeList(h, { cursor: first.body.nextCursor });
    expect(second.status).toBe(200); expect(second.body.continuation).toBe('end');
    expect(second.body.rows.map(row => row.email)).toEqual([h.data[1].account.email]);
    expect(h.state.audit).toHaveLength(4);
    expect(h.state.audit.map(row => [row.payload.schemaVersion, row.payload.serviceEvent.phase, row.payload.serviceEvent.page]))
        .toEqual([[2, 'attempt', 1], [2, 'outcome', 1], [2, 'attempt', 2], [2, 'outcome', 2]]);
    expect(h.state.audit.every(row => row.scope_json === null && row.tenant_id === null && row.organisation_id === null)).toBe(true);
    privateError(await nativeList(h, { cursor: first.body.nextCursor }), 400, 'dashboard_admin_input_invalid');
    for (const result of [first, second]) expect(result.text).not.toMatch(/manifestSha256|recordId|accountId|tenantId|scope|sessionSha256|PRIVATE/);
    for (const data of h.data) expect(data.writes).toEqual([]);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
});

test('actual native host repeats current searches with independent audit request slots', async () => {
    const h = await nativeHarness();
    const first = await nativeList(h), second = await nativeList(h);
    expect(first.status).toBe(200); expect(second.body).toEqual(first.body);
    expect(h.state.audit).toHaveLength(4);
    expect(new Set(h.state.audit.map(row => row.request_id)).size).toBe(2);
    expect(new Set(h.state.audit.map(row => row.payload.serviceEvent.requestId)).size).toBe(2);
});

test.each(['absent', 'customer cookie', 'consultant', 'missing issuance'])('actual native host admits no data or SQL write for %s', async mode => {
    const h = await nativeHarness({ role: mode === 'consultant' ? 'consultant' : 'admin', withProof: mode !== 'missing issuance' });
    if (mode === 'absent') h.app = createNoFriesApp({ dashboard: h.dashboard });
    const result = await nativeList(h, { cookie: mode === 'customer cookie'
        ? h.cookie.replace('__Host-nofries-auth', '__Host-nofries-customer') : h.cookie });
    const status = mode === 'absent' ? 404 : mode === 'customer cookie' ? 401 : 403;
    expect(result.status).toBe(status); expect(h.state.audit).toEqual([]); expect(h.data[0].reads).toEqual([]);
    if (mode !== 'missing issuance') expect(h.pool.connect).not.toHaveBeenCalled();
});

test.each(['grant', 'population', 'gate'])('actual native host withholds rows when %s is revoked after outcome commit', async mode => {
    const h = await nativeHarness({ version: 2 }); let outcome = false;
    h.state.after = async (sql, params) => {
        if (sql.startsWith('INSERT INTO')) outcome = JSON.parse(params.at(-1)).serviceEvent.phase === 'outcome';
        if (sql === 'COMMIT' && outcome) {
            if (mode === 'grant') h.state.grant = null;
            if (mode === 'population') h.state.binding = null;
            if (mode === 'gate') h.state.gate.status = 'revoked';
        }
    };
    const result = await nativeList(h); privateError(result, 503, 'dashboard_admin_unavailable');
    expect(h.state.audit).toHaveLength(2); expect(result.body).not.toHaveProperty('rows');
});

test('actual native host reconciles a lost outcome COMMIT once without repeating reads or inserts', async () => {
    const h = await nativeHarness();
    h.state.after = async (sql, params) => {
        if (sql.startsWith('INSERT INTO') && JSON.parse(params.at(-1)).serviceEvent.phase === 'outcome') h.state.loseCommit = true;
    };
    expect((await nativeList(h)).status).toBe(200); expect(h.readSignupPage).toHaveBeenCalledTimes(1);
    expect(h.state.trace.filter(({ sql }) => sql.startsWith('INSERT INTO'))).toHaveLength(2);
    expect(h.state.audit).toHaveLength(2);
});

test('actual native host full-body disconnect during provisional audit prevents COMMIT and account reads', async () => {
    const h = await nativeHarness(), entered = deferred(), resume = deferred(), closed = deferred(), rollback = deferred();
    h.state.after = async sql => {
        if (sql.startsWith('INSERT INTO')) { entered.resolve(); await resume.promise; }
        if (sql === 'ROLLBACK') rollback.resolve();
    };
    const server = createServer((req, res) => { res.once('close', () => closed.resolve()); h.app(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const body = JSON.stringify({ cursor: null });
    const client = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/api/dashboard-admin/signups', method: 'POST',
        headers: { cookie: h.cookie, origin: h.env.NOFRIES_PUBLIC_URL, 'sec-fetch-site': 'same-origin',
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    client.on('error', () => {});
    try {
        client.end(body); await entered.promise; client.destroy(); await closed.promise;
        resume.resolve(); await rollback.promise; await settle();
        expect(h.state.audit).toEqual([]); expect(h.data[0].reads).toEqual([]);
        const insert = h.state.trace.findIndex(({ sql }) => sql.startsWith('INSERT INTO'));
        expect(h.state.trace.slice(insert).some(({ sql }) => sql === 'COMMIT')).toBe(false);
    } finally { resume.resolve(); client.destroy(); await new Promise(resolve => server.close(resolve)); }
});
