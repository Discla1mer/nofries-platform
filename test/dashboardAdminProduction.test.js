'use strict';

// The actual launcher factory, HTTP handlers, staff capture, native repository,
// exact Blob adapters and audit writer execute here. Only SDK/SQL transport and
// the explicitly synthetic policy/population are substituted. No live binding.
const request = require('supertest');
const { Readable } = require('node:stream');
const { createProductionApplication } = require('../lib/productionApplication');
const { createProductionDashboardAdministration } = require('../lib/dashboardAdminProduction');
const { runtimeFixture, clone, uid, SUBJECT } = require('./fixtures/dashboardAdminSignupRuntime');
const { createEntrySql } = require('./fixtures/dashboardAdminEntrySession');

// This whole-test allowance covers capabilities plus two independently guarded
// page requests. Production request limits and negative-test defaults stay exact.
const PAGED_HOST_JOURNEY_TIMEOUT_MS = 20000;
// Setup and two separately guarded 10s searches share one whole-test budget.
// Each response still must succeed within the unchanged production deadline.
const REPEATED_SEARCH_JOURNEY_TIMEOUT_MS = 30000;

function externalConfiguration() {
    const tenantId = uid(1001), clientId = uid(1002);
    const profile = { kind: 'external-id', tenantId, clientId, authority: 'https://synthetic-admin.ciamlogin.com/',
        issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
        authorizationEndpoint: `https://synthetic-admin.ciamlogin.com/${tenantId}/oauth2/v2.0/authorize` };
    return { identityProvider: profile, identityPolicy: { policyId: 'synthetic-external-policy', policyRevision: 1,
        issuer: profile.issuer, identityTenantId: tenantId, audience: clientId },
        client: { clientSecret: 'synthetic-unused-customer-secret' }, starterAuthorityContainer: 'external-signups',
        userFlowId: 'SyntheticEmailPassword', allowNewSignup: false };
}

async function harness({ provider = 'legacy', role = 'admin', configured = true } = {}) {
    const h = await runtimeFixture({ provider, role, version: 2, twoTenants: true });
    const env = { ...h.env, NODE_ENV: 'production', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticadminauth', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticadmindata',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true', NOFRIES_DASHBOARD_INSTANCE_ID: h.dashboard.instanceId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: h.dashboard.identityPolicy.policyId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: String(h.dashboard.identityPolicy.policyRevision),
        NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs', NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs',
        NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com', NOFRIES_POSTGRES_DATABASE: 'nofries',
        NOFRIES_POSTGRES_USER: 'nofries_app', NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'false',
        NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'legacy-signups' };
    const transport = { clients: [], containers: [], reads: [], writes: [], beforeRead: null };
    const namespace = provider === 'external' ? 'external-signups' : 'legacy-signups';
    const source = new Map(h.data.flatMap(item => [...item.blobs]));
    const dependencies = {
        ManagedIdentityCredential: class { async getToken() { throw new Error('UNEXPECTED_TOKEN_REQUEST'); } },
        BlobServiceClient: class {
            constructor(url) { this.account = new URL(url).hostname.split('.')[0]; transport.clients.push(this.account); }
            getContainerClient(name) {
                const account = this.account; transport.containers.push({ account, name });
                return { async getProperties() { return {}; }, getBlockBlobClient(key) { return {
                    async download() {
                        transport.reads.push({ account, name, key });
                        if (transport.beforeRead) await transport.beforeRead({ account, name, key });
                        let value;
                        if (account === env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT && name === env.NOFRIES_DASHBOARD_PROOF_CONTAINER) {
                            const match = /^dashboard-proofs\/([a-f0-9]{64})\.json$/.exec(key);
                            value = match && h.proofs.get(match[1]);
                        } else if (account === env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT && name === env.NOFRIES_DASHBOARD_EPOCH_CONTAINER &&
                            key === `runtime-epochs/${h.dashboard.instanceId}.json`) {
                            value = { instanceId: h.dashboard.instanceId, restoreEpoch: h.state.epoch };
                        } else if (account === env.AZURE_STORAGE_ACCOUNT_NAME && name === namespace) value = source.get(key);
                        else throw new Error('UNEXPECTED_STORE_NAMESPACE');
                        if (value === undefined || value === null) throw Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
                        const bytes = Buffer.from(JSON.stringify(value));
                        return { contentLength: bytes.length, etag: '"synthetic-production-etag"', readableStreamBody: Readable.from([bytes]) };
                    },
                    async uploadData(bytes) {
                        transport.writes.push({ account, name, key });
                        const match = /^dashboard-proofs\/([a-f0-9]{64})\.json$/.exec(key);
                        if (account !== env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT || name !== env.NOFRIES_DASHBOARD_PROOF_CONTAINER ||
                            !match || h.proofs.has(match[1])) throw new Error('UNEXPECTED_BLOB_WRITE');
                        h.proofs.set(match[1], JSON.parse(bytes.toString()));
                    },
                    async delete() { throw new Error('UNEXPECTED_BLOB_DELETE'); }
                }; }, listBlobsFlat() { throw new Error('UNEXPECTED_POPULATION_SCAN'); } };
            }
        },
        createPostgresPool: () => h.pool, createBrowserSessionStore: () => h.store,
        clock: () => h.state.now, clientApplication: h.dashboard.browserAuthOptions.clientApplication,
        cryptoProvider: h.dashboard.browserAuthOptions.cryptoProvider
    };
    if (provider === 'external') dependencies.externalCustomer = externalConfiguration();
    const listing = { manifest: h.manifest, sourceReferences: h.data.map(item => item.reference),
        readApprovedAuthority: h.readApprovedAuthority,
        resolvePopulationBinding: jest.fn(async () => clone(h.state.binding)) };
    if (configured) dependencies.dashboardAdministration = { lookup: null, signupList: listing };
    const app = createProductionApplication(env, dependencies);
    const dataReads = () => transport.reads.filter(item => item.name === namespace);
    return { ...h, env, dependencies, app, transport, source, listing, namespace, dataReads };
}

function list(h, cursor = null) {
    return request(h.app).post('/api/dashboard-admin/signups').set('Cookie', h.cookie)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ cursor });
}
function safeError(result, code) {
    expect(result.body).toEqual({ code });
    expect(result.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(result.text).not.toMatch(/UNEXPECTED_|synthetic-secret|PRIVATE-SYNTHETIC|subjectKey|accountKey|starter-accounts/);
}

test.each(['legacy', 'external'])('actual production factory reads bounded %s tenants through native committed audit', async provider => {
    const h = await harness({ provider });
    const caps = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', h.cookie);
    expect(caps.status).toBe(200); expect(caps.body).toEqual({ lookup: false, recovery: [], signupList: true });
    expect(h.dataReads()).toEqual([]);
    const first = await list(h);
    expect(first.status).toBe(200); expect(first.body.status).toBe('available');
    expect(first.body.rows).toHaveLength(1); expect(first.body.nextCursor).toEqual(expect.any(String));
    const next = await list(h, first.body.nextCursor);
    expect(next.status).toBe(200); expect(next.body.nextCursor).toBeNull();
    expect([first.body.rows[0].email, next.body.rows[0].email]).toEqual(h.data.map(item => item.account.email));
    expect(new Set(h.data.map(item => item.entry.binding.tenantId)).size).toBe(2);
    for (const response of [first, next]) {
        expect(response.body.rows[0]).toMatchObject({ accountType: 'consultant', milestones: {
            accountSaved: { status: 'recorded' }, setupSaved: { status: 'recorded' },
            termsAccepted: { status: 'unknown' }, admission: { status: 'unknown' } } });
        expect(response.text).not.toMatch(/subjectKey|starter-accounts|accountId|setupRequestId|PRIVATE-SYNTHETIC|authoritySha256/);
    }
    expect(h.dataReads().map(item => item.key)).toEqual(h.data.flatMap(item => [item.accountPath, item.setupPath]));
    expect(h.state.audit.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome', 'attempt', 'outcome']);
    expect(h.state.audit.every(row => row.event_type === 'dashboard.admin.signup_list')).toBe(true);
    expect(h.transport.writes).toEqual([]);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
    expect(h.state.trace.some(({ sql }) => sql === 'COMMIT')).toBe(true);
}, PAGED_HOST_JOURNEY_TIMEOUT_MS);

test('missing trusted composition stays unavailable despite environment strings and a genuine admin session', async () => {
    const h = await harness({ configured: false });
    h.env.NOFRIES_DASHBOARD_ADMIN_ENABLED = 'true';
    h.env.NOFRIES_DASHBOARD_ADMIN_SIGNUP_LIST_ENABLED = 'true';
    h.app = createProductionApplication(h.env, h.dependencies);
    const document = await request(h.app).get('/dashboard-admin').set('Cookie', h.cookie);
    expect(document.status).toBe(503); safeError(document, 'dashboard_admin_unavailable');
    const result = await list(h); expect(result.status).toBe(404); safeError(result, 'dashboard_admin_not_found');
    expect(h.dataReads()).toEqual([]); expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.transport.containers.some(item => item.name === h.namespace)).toBe(false);
});

test.each([null, { lookup: null, signupList: null }])('explicit inactive composition %p needs no dashboard or SDK dependency', config => {
    const unused = () => { throw new Error('UNEXPECTED_DEPENDENCY_READ'); };
    const dependencies = { dashboardAdministration: config };
    for (const name of ['ManagedIdentityCredential', 'BlobServiceClient']) Object.defineProperty(dependencies, name, { get: unused });
    expect(createProductionDashboardAdministration(new Proxy({}, { get: unused }), null, dependencies)).toEqual({});
});

test('optional dependency accessor is rejected without invocation or unrelated enumeration', async () => {
    const h = await harness({ configured: false }), getter = jest.fn(() => { throw new Error('UNEXPECTED_ACCESSOR'); });
    Object.defineProperty(h.dependencies, 'dashboardAdministration', { enumerable: true, get: getter });
    expect(() => createProductionApplication(h.env, h.dependencies)).toThrow('dashboard_admin_production_configuration_invalid');
    expect(getter).not.toHaveBeenCalled(); expect(h.dataReads()).toEqual([]);
});

test.each(['missing', 'duplicate', 'foreign', 'extra'])('invalid %s source references fail before an administration SDK client', async defect => {
    const h = await harness({ configured: false }), refs = clone(h.listing.sourceReferences);
    if (defect === 'missing') refs.pop();
    if (defect === 'duplicate') refs[1] = clone(refs[0]);
    if (defect === 'foreign') refs[1].entry.binding.tenantId = 'foreign-tenant';
    if (defect === 'extra') refs.push({ ...clone(refs[0]), entry: { ...clone(refs[0].entry), recordId: 'extra-record' } });
    h.dependencies.dashboardAdministration = { lookup: null, signupList: { ...h.listing, sourceReferences: refs } };
    const count = h.transport.clients.length;
    expect(() => createProductionDashboardAdministration(h.env, h.dashboard, h.dependencies)).toThrow('dashboard_admin_production_configuration_invalid');
    expect(h.transport.clients).toHaveLength(count); expect(h.dataReads()).toEqual([]);
});

test.each(['auth-account', 'proof-container', 'epoch-container', 'authority-container', 'other-provider'])
('source namespace collision %s is rejected', async defect => {
    const h = await harness({ configured: false });
    h.dependencies.dashboardAdministration = { lookup: null, signupList: h.listing };
    if (defect === 'auth-account') h.env.AZURE_STORAGE_ACCOUNT_NAME = h.env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT;
    if (defect === 'proof-container') h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER = h.env.NOFRIES_DASHBOARD_PROOF_CONTAINER;
    if (defect === 'epoch-container') h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER = h.env.NOFRIES_DASHBOARD_EPOCH_CONTAINER;
    if (defect === 'authority-container') h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER = h.env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER;
    const external = externalConfiguration();
    if (defect === 'other-provider') external.starterAuthorityContainer = h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER;
    const count = h.transport.clients.length;
    expect(() => createProductionDashboardAdministration(h.env, h.dashboard, h.dependencies, external)).toThrow();
    expect(h.transport.clients).toHaveLength(count);
});

test('external manifest cannot fall back to the legacy source when external binding is absent', async () => {
    const h = await harness({ configured: false, provider: 'external' });
    h.dependencies.dashboardAdministration = { lookup: null, signupList: h.listing };
    expect(() => createProductionDashboardAdministration(h.env, h.dashboard, h.dependencies)).toThrow();
    expect(h.dataReads()).toEqual([]);
});

test('staff Consultant is denied before approval, data or SQL', async () => {
    const h = await harness({ role: 'consultant' });
    const result = await list(h); expect(result.status).toBe(403); safeError(result, 'dashboard_admin_access_denied');
    expect(h.readApprovedAuthority).not.toHaveBeenCalled(); expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.dataReads()).toEqual([]);
});

test.each(['__Host-nofries-customer', '__Host-nofries-external-customer'])('customer cookie %s cannot acquire admin authority', async name => {
    const h = await harness(); h.cookie = name + '=' + h.cookie.split('=')[1];
    const result = await list(h); expect(result.status).toBe(401); safeError(result, 'dashboard_admin_authentication_required');
    expect(h.readApprovedAuthority).not.toHaveBeenCalled(); expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.dataReads()).toEqual([]);
});

test.each(['grant', 'population', 'gate', 'restore'])('current %s revocation withholds rows through the real factory', async target => {
    const h = await harness();
    if (target === 'grant') h.state.grant = null;
    if (target === 'population') h.state.binding = null;
    if (target === 'gate') h.state.gate.status = 'revoked';
    if (target === 'restore') h.state.epoch = uid(990);
    const result = await list(h);
    expect([403, 503]).toContain(result.status);
    expect(result.text).not.toContain(h.data[0].account.email); expect(h.dataReads()).toEqual([]);
    expect(h.state.audit).toEqual([]);
});

test('revocation during actual Blob data read withholds the already-buffered row', async () => {
    const h = await harness();
    h.transport.beforeRead = ({ name }) => { if (name === h.namespace) h.state.grant = null; };
    const result = await list(h); expect([403, 503]).toContain(result.status);
    expect(result.text).not.toContain(h.data[0].account.email);
    expect(h.state.audit.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt']);
});

test.each(['attempt', 'outcome'])('native %s audit failure prevents production-host disclosure', async phase => {
    const h = await harness(); let inserts = 0;
    h.state.before = sql => { if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit') && ++inserts === (phase === 'attempt' ? 1 : 2)) throw new Error('PRIVATE_AUDIT_FAILURE'); };
    const result = await list(h); expect(result.status).toBe(503); safeError(result, 'dashboard_admin_unavailable');
    expect(result.text).not.toContain(h.data[0].account.email);
    expect(h.dataReads()).toHaveLength(phase === 'attempt' ? 0 : 2);
    expect(h.state.audit).toHaveLength(phase === 'attempt' ? 0 : 1);
});

test('missing exact account is unavailable and audited rather than fabricated empty success', async () => {
    const h = await harness(); h.source.delete(h.data[0].accountPath);
    const result = await list(h); expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'unavailable', rows: [], observedAt: null, nextCursor: null, continuation: 'unavailable' });
    expect(h.state.audit.map(row => row.payload.serviceEvent.outcome)).toEqual(['requested', 'unavailable']);
    expect(h.transport.writes).toEqual([]);
});

test('repeated searches read current data and commit distinct audit pairs', async () => {
    const h = await harness();
    expect((await list(h)).status).toBe(200); expect((await list(h)).status).toBe(200);
    expect(h.dataReads()).toHaveLength(4);
    expect(new Set(h.state.audit.map(row => row.payload.serviceEvent.requestId)).size).toBe(2);
    expect(h.state.audit).toHaveLength(4);
}, REPEATED_SEARCH_JOURNEY_TIMEOUT_MS);

test('lookup-only composition reuses existing native runtime without constructing signup stores', async () => {
    const h = await harness({ configured: false }), readApprovedBinding = jest.fn(async () => null);
    h.dependencies.dashboardAdministration = { lookup: { readApprovedBinding }, signupList: null };
    const count = h.transport.clients.length;
    const composed = createProductionDashboardAdministration(h.env, h.dashboard, h.dependencies);
    expect(Object.keys(composed)).toEqual(['dashboardAdmin']);
    expect(h.transport.clients).toHaveLength(count);
    h.app = createProductionApplication(h.env, h.dependencies);
    const result = await request(h.app).get('/dashboard-admin').set('Cookie', h.cookie);
    expect(result.status).toBe(403); safeError(result, 'dashboard_admin_access_denied');
    expect(readApprovedBinding).toHaveBeenCalledWith({ operatorSubjectKey: SUBJECT, purpose: 'signup_support' });
    expect(h.dataReads()).toEqual([]);
});

test.each(['legacy', 'external'])('fresh staff callback through production factory opens %s listing only after explicit operator initialization', async provider => {
    const h = await harness({ provider });
    const pool = createEntrySql(h.state, { instanceId: h.dashboard.instanceId,
        restoreEpoch: h.state.epoch, now: Date.parse(h.state.now) });
    h.dependencies.createPostgresPool = () => pool;
    h.app = createProductionApplication(h.env, h.dependencies);
    expect(h.state.tables.dashboard_session_gates).toEqual([]);
    const start = await request(h.app).get('/api/auth/login?returnTo=%2Fdashboard-admin%2Fentry');
    expect(start.status).toBe(302);
    const callback = await request(h.app).post('/api/auth/callback').set('Cookie', start.headers['set-cookie'][0].split(';')[0])
        .type('form').send({ code: 'synthetic-production-entry', state: new URL(start.headers.location).searchParams.get('state') });
    expect(callback.status).toBe(303); expect(callback.headers.location).toBe('/dashboard-admin/entry');
    h.cookie = callback.headers['set-cookie'].find(value => value.startsWith('__Host-nofries-auth=')).split(';')[0];
    expect(h.state.tables.dashboard_session_gates).toEqual([]);
    const entry = await request(h.app).get('/dashboard-admin/entry').set('Cookie', h.cookie);
    expect(entry.status).toBe(200); expect(entry.text).toContain('adminEntryOpen');
    expect(h.state.tables.dashboard_session_gates).toEqual([]); expect(h.dataReads()).toEqual([]);
    const denied = await list(h); expect(denied.status).toBe(403); expect(h.dataReads()).toEqual([]);
    const session = method => request(h.app)[method]('/api/dashboard/session').set('Cookie', h.cookie)
        .set('X-Nofries-Dashboard-Purpose', 'operator_dashboard');
    const before = await session('get');
    expect(before.status).toBe(409); expect(before.body).toEqual({ code: 'dashboard_initialization_required' });
    const initialized = await session('post').set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
        .send({ operationId: uid(997) });
    expect(initialized.status).toBe(200); expect(initialized.body).toEqual({ schemaVersion: 1, initialized: true });
    const after = await session('get');
    expect(after.status).toBe(200); expect(after.body.purpose).toBe('operator_dashboard');
    expect(h.state.tables.dashboard_session_gates).toHaveLength(1);
    const listed = await list(h); expect(listed.status).toBe(200); expect(listed.body.rows[0].email).toBe(h.data[0].account.email);
    const audits = h.state.tables.dashboard_runtime_audit.filter(row => row.event_type === 'dashboard.admin.signup_list');
    expect(audits.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    expect(h.state.trace.filter(({ sql }) => /INSERT INTO nofries\.dashboard_session_gates/.test(sql))).toHaveLength(1);
    expect(h.transport.writes.every(item => item.name === h.env.NOFRIES_DASHBOARD_PROOF_CONTAINER)).toBe(true);
    expect(h.transport.reads.every(item => !/registrations|invitations|acceptance/.test(item.key))).toBe(true);
});
