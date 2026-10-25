'use strict';

const { SETTING, ENABLED_SETTING, WRITER_CONTRACT, readDashboardAdminBinding, sourceBinding,
    wrapDashboardAdminAccountStore, createBoundDashboardAdministration } = require('../lib/dashboardAdminBindings');
const binding = { schemaVersion: 1, provider: 'legacy', authorityContainer: 'private-approvals',
    populationId: 'synthetic-all-signups', indexId: 'synthetic-current-index', writerContract: WRITER_CONTRACT };
const env = { AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
    NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_DASHBOARD_PROOF_CONTAINER: 'proof-records',
    NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'epoch-records' };

test('absent configuration preserves exact account store and constructs no administration SDK', () => {
    const store = { load() {}, create() {}, replace() {} }, dependencies = {};
    for (const key of ['ManagedIdentityCredential', 'BlobServiceClient']) Object.defineProperty(dependencies, key,
        { get() { throw new Error('SDK accessed while disabled'); } });
    expect(readDashboardAdminBinding({})).toBeNull();
    expect(createBoundDashboardAdministration({}, null, dependencies, null)).toEqual({});
    expect(wrapDashboardAdminAccountStore({ env: {}, accountStore: store })).toBe(store);
});

test.each([{}, { [SETTING]: undefined }, { [SETTING]: '' }])
('disabled guarded environment reads no getters or unrelated descriptors', value => {
    const get = jest.fn(() => { throw new Error('unexpected environment value read'); });
    const descriptors = [];
    const guarded = new Proxy(value, { get, getOwnPropertyDescriptor(target, key) {
        descriptors.push(key);
        if (key !== SETTING) throw new Error('unrelated descriptor read');
        return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    const store = {};
    expect(readDashboardAdminBinding(guarded)).toBeNull();
    expect(wrapDashboardAdminAccountStore({ env: guarded, accountStore: store })).toBe(store);
    expect(createBoundDashboardAdministration(guarded, null, {}, null)).toEqual({});
    expect(get).not.toHaveBeenCalled(); expect(new Set(descriptors)).toEqual(new Set([SETTING]));
});

test('a proxy cannot supply selected administration configuration', () => {
    const get = jest.fn();
    const guarded = new Proxy({ [SETTING]: JSON.stringify(binding) }, { get });
    expect(() => readDashboardAdminBinding(guarded)).toThrow('dashboard_admin_production_configuration_invalid');
    expect(get).not.toHaveBeenCalled();
});

test('ordinary disabled host accepts a guarded environment without selecting credential or admin factories', () => {
    const protectedReads = [], signer = jest.fn(() => { throw new Error('unselected signer'); });
    const guarded = new Proxy({ NODE_ENV: 'test', NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'false' }, {
        get(target, key) {
            if (typeof key === 'string' && (key.startsWith('IDENTITY_') || key.startsWith('NOFRIES_EXTERNAL_CUSTOMER_'))) {
                protectedReads.push(key);
                if (key !== 'NOFRIES_EXTERNAL_CUSTOMER_ENABLED') throw new Error('unselected credential config');
            }
            return target[key];
        }
    });
    expect(typeof createProductionApplication(guarded, { createAppServiceCustomerAssertion: signer })).toBe('function');
    expect(signer).not.toHaveBeenCalled(); expect(protectedReads).toEqual(['NOFRIES_EXTERNAL_CUSTOMER_ENABLED']);
});

test('locator contains no operator/population members and cannot itself supply approval', () => {
    expect(readDashboardAdminBinding({ [SETTING]: JSON.stringify(binding) })).toEqual(binding);
    expect(Object.isFrozen(readDashboardAdminBinding({ [SETTING]: JSON.stringify(binding) }))).toBe(true);
    for (const extra of [{ operatorSubjectKey: 'fabricated' }, { approved: true }, { entries: [] }, { enabled: true }]) {
        expect(() => readDashboardAdminBinding({ [SETTING]: JSON.stringify({ ...binding, ...extra }) })).toThrow();
    }
});

test.each([null, true, '{}', '[]', 'null', '{', 'x'.repeat(2049)])('malformed locator %p fails closed', value => {
    expect(() => readDashboardAdminBinding({ [SETTING]: value })).toThrow('dashboard_admin_production_configuration_invalid');
});

test.each([['provider', 'any'], ['writerContract', 'unfenced'], ['writerContract', 'all_application_account_writes_v1'], ['authorityContainer', '../authority'],
    ['populationId', ''], ['indexId', ''], ['schemaVersion', 2]])('invalid %s is rejected', (field, value) => {
    expect(() => readDashboardAdminBinding({ [SETTING]: JSON.stringify({ ...binding, [field]: value }) })).toThrow();
});

test('accessor configuration cannot execute code while parsing a binding', () => {
    const getter = jest.fn(), input = {};
    Object.defineProperty(input, SETTING, { get: getter });
    expect(() => readDashboardAdminBinding(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
});

test('other provider store is returned unchanged and source hashes bind namespace', () => {
    const accountStore = {};
    expect(wrapDashboardAdminAccountStore({ env: { [SETTING]: JSON.stringify(binding) }, provider: 'external', accountStore })).toBe(accountStore);
    const first = sourceBinding(env, binding, 'legacy-signups').sourceBindingSha256;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceBinding(env, binding, 'different-signups').sourceBindingSha256).not.toBe(first);
    expect(sourceBinding(env, { ...binding, provider: 'external' }, 'legacy-signups').sourceBindingSha256).not.toBe(first);
    expect(sourceBinding({ ...env, AZURE_STORAGE_ACCOUNT_NAME: 'otherdata' }, binding, 'legacy-signups').sourceBindingSha256).not.toBe(first);
});

test.each(['private-approvals', 'customer-authority', 'nofries-browser-auth', 'proof-records', 'epoch-records'])
('source container collision %s is denied', source => {
    expect(() => sourceBinding(env, binding, source)).toThrow();
});

test('authentication storage cannot be selected as application data', () => {
    expect(() => sourceBinding({ ...env, AZURE_STORAGE_ACCOUNT_NAME: env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT }, binding, 'legacy-signups')).toThrow();
});

// End-to-end source composition: only external SDK/SQL transports are synthetic.
// The launcher, policy/index readers, source adapters, staff capture and durable
// native audit all execute. No manually supplied administration callback exists.
const request = require('supertest');
const { Readable } = require('node:stream');
const { createProductionApplication } = require('../lib/productionApplication');
const { runtimeFixture, clone, uid, SUBJECT } = require('./fixtures/dashboardAdminSignupRuntime');
const { fixture: signupFixture } = require('./fixtures/dashboardAdminSignupData');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createSignupIndexMaintenance, INDEX_HEAD_KEY, WRITER_HEAD_KEY, TICKET_PREFIX } = require('../api/shared/dashboardAdmin/signupIndexMaintenance');
const { listingHeadKey, listingRevisionKey } = require('../api/shared/dashboardAdmin/signupListingRecords');

test.each(['legacy', 'external'])('selected %s admin binding retains bounded Consultant client reads without writer state', async provider => {
    const h = await signupFixture(provider), accountId = h.account.accountId;
    const clientPrefix = `customer-starter/starter-clients/${accountId}/`;
    const aliasPrefix = `customer-starter/starter-client-bindings/${accountId}/`;
    const clients = Array.from({ length: 53 }, (_, index) => {
        const slot = Object.fromEntries(Object.keys(h.account.organisations[0]).map((key, field) => [key,
            key === 'kind' ? 'client' : key === 'organisationName' ? `Saved Consultant Client ${index}` : uid(20000 + index * 100 + field)]));
        h.blobs.set(clientPrefix + slot.requestId + '.json', { schemaVersion: 1, accountId, slot });
        h.blobs.set(aliasPrefix + slot.bindingId + '.json', { schemaVersion: 1, accountId,
            bindingId: slot.bindingId, requestId: slot.requestId });
        return slot;
    });
    const pages = [], source = { ...h.accountStore.container, listBlobsFlat(options) {
        expect(options.prefix).toBe(clientPrefix);
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        return { byPage(command) { return (async function* () {
            pages.push({ limit: command.maxPageSize, token: command.continuationToken });
            const names = [...h.blobs.keys()].filter(key => key.startsWith(options.prefix)).sort();
            const offset = command.continuationToken === undefined ? 0 : Number(command.continuationToken);
            const selected = names.slice(offset, offset + command.maxPageSize);
            yield { continuationToken: offset + selected.length < names.length ? String(offset + selected.length) : undefined,
                segment: { blobItems: selected.map(name => ({ name })) } };
        })(); } };
    } };
    const readExternalRuntimeEpoch = jest.fn(() => { throw new Error('UNEXPECTED_WRITER_STATE_READ'); });
    const newId = jest.fn(() => { throw new Error('UNEXPECTED_WRITER_ID'); });
    const wrapped = wrapDashboardAdminAccountStore({ env: { ...env, [SETTING]: JSON.stringify({ ...binding, provider }) },
        dashboard: { instanceId: uid(9000), clock: h.clock, readExternalRuntimeEpoch, newId },
        provider, sourceName: provider + '-signups', source, accountStore: new AzureStarterAccountStore(source) });
    const before = canonical([...h.blobs]);
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    const first = await wrapped.listClients(accountId, { cursor: null, limit: 50 });
    const last = await wrapped.listClients(accountId, { cursor: first.nextCursor, limit: 50 });
    expect([first.clients.length, last.clients.length]).toEqual([50, 3]);
    expect([...first.clients, ...last.clients]).toEqual(clients);
    expect(last.nextCursor).toBeNull();
    expect(pages).toEqual([{ limit: 50, token: undefined }, { limit: 50, token: '50' }]);
    await expect(wrapped.listClients(uid(9999), { cursor: first.nextCursor, limit: 50 }))
        .rejects.toThrow('starter_store_cursor_invalid');
    h.reads.length = 0;
    await expect(wrapped.loadClient(accountId, clients[51].requestId)).resolves.toEqual(clients[51]);
    expect(h.reads).toEqual([clientPrefix + clients[51].requestId + '.json']);
    h.reads.length = 0;
    await expect(wrapped.loadClientByBinding(accountId, clients[51].bindingId)).resolves.toEqual(clients[51]);
    expect(h.reads).toEqual([aliasPrefix + clients[51].bindingId + '.json', clientPrefix + clients[51].requestId + '.json']);
    await expect(wrapped.loadClient(uid(9999), clients[51].requestId)).resolves.toBeNull();
    await expect(wrapped.loadClientByBinding(uid(9999), clients[51].bindingId)).resolves.toBeNull();
    expect(canonical([...h.blobs])).toBe(before); expect(h.writes).toEqual([]);
    expect(readExternalRuntimeEpoch).not.toHaveBeenCalled(); expect(newId).not.toHaveBeenCalled();
    for (const method of ['createClient', 'ensureClientBinding', 'write', 'delete']) expect(wrapped[method]).toBeUndefined();
});

// Positive host journeys include maintenance and multiple audited operations.
// This bounds the whole test; production deadlines and denial test limits remain.
const HOST_TEST_TIMEOUT_MS = 20000;
// Allocation, explicit refresh and three independently guarded 10s page
// requests form one journey; keep every production/request limit unchanged.
const STARTER_ALLOCATION_JOURNEY_TIMEOUT_MS = 40000;
// Preserve the complete same-host regression: five separately guarded 10s
// requests plus synthetic fixture overhead. No runtime or other test limit moves.
const INDEX_MAINTENANCE_JOURNEY_TIMEOUT_MS = 60000;

function externalBindingFixture() {
    const tenantId = uid(1001), clientId = uid(1002);
    const profile = { kind: 'external-id', tenantId, clientId, authority: 'https://synthetic-admin.ciamlogin.com/',
        issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
        authorizationEndpoint: `https://synthetic-admin.ciamlogin.com/${tenantId}/oauth2/v2.0/authorize` };
    return { identityProvider: profile, identityPolicy: { policyId: 'synthetic-external-policy', policyRevision: 1,
        issuer: profile.issuer, identityTenantId: tenantId, audience: clientId },
        client: { clientSecret: 'synthetic-unused-customer-secret' }, starterAuthorityContainer: 'external-signups',
        userFlowId: 'SyntheticEmailPassword', allowNewSignup: false };
}

async function boundHost({ provider = 'legacy', role = 'admin', approval = true, complete = true } = {}) {
    const h = await runtimeFixture({ provider, role, version: 2, twoTenants: true });
    const selected = { ...binding, provider };
    const hostEnv = { ...h.env, NODE_ENV: 'production', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticadminauth', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticadmindata',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true', NOFRIES_DASHBOARD_INSTANCE_ID: h.dashboard.instanceId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: h.dashboard.identityPolicy.policyId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: String(h.dashboard.identityPolicy.policyRevision),
        NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs', NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs',
        NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com', NOFRIES_POSTGRES_DATABASE: 'nofries',
        NOFRIES_POSTGRES_USER: 'nofries_app', NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'false',
        NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'legacy-signups',
        [SETTING]: JSON.stringify(selected), [ENABLED_SETTING]: 'true' };
    const sourceName = provider === 'external' ? 'external-signups' : 'legacy-signups';
    const { sourceBindingSha256 } = sourceBinding(hostEnv, selected, sourceName);
    const stores = new Map(), versions = new Map(), trace = { reads: [], writes: [], lists: [], beforeRead: null, beforeWrite: null, afterWrite: null, maintenance: false };
    let serial = 0;
    function bucket(account, name) {
        const key = account + '/' + name;
        if (!stores.has(key)) stores.set(key, new Map());
        return stores.get(key);
    }
    const source = bucket(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, sourceName);
    const authority = bucket(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, selected.authorityContainer);
    function put(account, name, key, value) {
        bucket(account, name).set(key, Buffer.from(canonical(value)));
        versions.set([account, name, key].join('/'), '"bound-synthetic-' + (++serial) + '"');
    }
    for (const item of h.data) for (const [key, value] of item.blobs) put(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, sourceName, key, value);
    const absent = () => Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
    const conflict = () => Object.assign(new Error('synthetic conditional conflict'), { statusCode: 412, code: 'ConditionNotMet' });
    function container(account, name) {
        return { async getProperties() { return {}; }, getBlockBlobClient(key) { return {
            async download(_offset, _length, options = {}) {
                trace.reads.push({ account, name, key });
                if (trace.beforeRead) await trace.beforeRead({ account, name, key });
                let bytes = bucket(account, name).get(key), etag = versions.get([account, name, key].join('/'));
                if (account === hostEnv.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT && name === hostEnv.NOFRIES_DASHBOARD_PROOF_CONTAINER) {
                    const proof = h.proofs.get(/^dashboard-proofs\/([a-f0-9]{64})\.json$/.exec(key)?.[1]);
                    bytes = proof && Buffer.from(canonical(proof)); etag = '"synthetic-proof"';
                } else if (account === hostEnv.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT && name === hostEnv.NOFRIES_DASHBOARD_EPOCH_CONTAINER) {
                    if (key !== `runtime-epochs/${h.dashboard.instanceId}.json`) throw absent();
                    bytes = Buffer.from(canonical({ instanceId: h.dashboard.instanceId, restoreEpoch: h.state.epoch })); etag = '"synthetic-epoch"';
                }
                if (!bytes) throw absent();
                if (options.conditions?.ifMatch && options.conditions.ifMatch !== etag) throw conflict();
                return { contentLength: bytes.length, etag, readableStreamBody: Readable.from([bytes]) };
            },
            async uploadData(bytes, options = {}) {
                if (!trace.maintenance && (account !== hostEnv.AZURE_STORAGE_ACCOUNT_NAME || name !== sourceName ||
                    !key.startsWith('customer-starter/dashboard-admin-signup-index/'))) throw new Error('UNEXPECTED_HOST_BLOB_WRITE');
                if (trace.beforeWrite) await trace.beforeWrite({ account, name, key });
                trace.writes.push({ account, name, key, value: JSON.parse(bytes.toString()) });
                const current = bucket(account, name).get(key), currentEtag = versions.get([account, name, key].join('/'));
                if (options.conditions?.ifNoneMatch === '*' && current || options.conditions?.ifMatch && options.conditions.ifMatch !== currentEtag) throw conflict();
                put(account, name, key, JSON.parse(bytes.toString()));
                if (trace.afterWrite) await trace.afterWrite({ account, name, key });
            },
            async delete() { throw new Error('UNEXPECTED_DELETE'); }
        }; },
        async *listBlobsFlat(options) {
            if ((!trace.maintenance && options.prefix !== TICKET_PREFIX) || account !== hostEnv.AZURE_STORAGE_ACCOUNT_NAME || name !== sourceName) throw new Error('UNEXPECTED_HOST_POPULATION_SCAN');
            trace.lists.push(options.prefix);
            for (const key of [...bucket(account, name).keys()].sort()) if (key.startsWith(options.prefix)) yield { name: key };
        } };
    }
    const sourceContainer = container(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, sourceName);
    const maintenance = createSignupIndexMaintenance({ container: sourceContainer, accountStore: new AzureStarterAccountStore(sourceContainer),
        provider, populationId: selected.populationId, indexId: selected.indexId, instanceId: h.dashboard.instanceId,
        sourceBindingSha256, writerContract: WRITER_CONTRACT, readExternalRuntimeEpoch: h.dashboard.readExternalRuntimeEpoch,
        clock: h.dashboard.clock, newId: h.dashboard.newId });
    async function rebuild() {
        trace.maintenance = true;
        try { return await maintenance.rebuild({ authoriseMaintenance: async () => true }); }
        finally { trace.maintenance = false; }
    }
    if (complete) await rebuild();
    const target = { instanceId: h.dashboard.instanceId, operatorSubjectKey: SUBJECT, provider,
        populationId: selected.populationId, indexId: selected.indexId, sourceBindingSha256 };
    const policy = { coverage: 'complete_application_signups', approvedAt: h.state.now, validFrom: h.state.now, validUntil: null,
        decisionWindowMs: 3600000, pageSize: 1, fields: ['email', 'organisation', 'accountType', 'milestones'],
        auditPolicy: { reference: 'synthetic-audit', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2',
            retention: { unit: 'calendar_months', count: 13 } } };
    let policyRevision = 0;
    function publishPolicy(status = 'active') {
        const record = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_revision', ...target,
            restoreEpoch: h.state.epoch, revision: ++policyRevision, status, changedAt: h.state.now,
            decisionReference: 'synthetic-ongoing-approval', policy: status === 'active' ? clone(policy) : null };
        const head = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_head', ...target,
            restoreEpoch: record.restoreEpoch, revision: record.revision, status, recordSha256: hash(record) };
        put(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, selected.authorityContainer, listingRevisionKey(target, hash(record)), record);
        put(hostEnv.AZURE_STORAGE_ACCOUNT_NAME, selected.authorityContainer, listingHeadKey(target), head);
    }
    if (approval) publishPolicy();
    const dependencies = {
        ManagedIdentityCredential: class { async getToken() { throw new Error('UNEXPECTED_TOKEN_REQUEST'); } },
        BlobServiceClient: class { constructor(url) { this.account = new URL(url).hostname.split('.')[0]; }
            getContainerClient(name) { return container(this.account, name); } },
        createPostgresPool: () => h.pool, createBrowserSessionStore: () => h.store, clock: h.dashboard.clock,
        clientApplication: h.dashboard.browserAuthOptions.clientApplication, cryptoProvider: h.dashboard.browserAuthOptions.cryptoProvider
    };
    if (provider === 'external') dependencies.externalCustomer = externalBindingFixture();
    trace.reads.length = 0; trace.writes.length = 0; trace.lists.length = 0;
    const app = createProductionApplication(hostEnv, dependencies);
    expect(trace.reads).toEqual([]); expect(trace.writes).toEqual([]); expect(trace.lists).toEqual([]);
    const accountReads = () => trace.reads.filter(x => x.name === sourceName && /customer-starter\/(starter-accounts|starter-setups)\//.test(x.key));
    return { ...h, env: hostEnv, app, dependencies, selected, sourceName, sourceContainer, source, authority, target, policy,
        trace, put, publishPolicy, maintenance, rebuild, accountReads };
}

const boundList = (h, cursor = null, cookie = h.cookie) => request(h.app).post('/api/dashboard-admin/signups')
    .set('Cookie', cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ cursor });
function privateResult(response) {
    expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(response.text).not.toMatch(/subjectKey|accountKey|sourceReferences|sourceBindingSha256|PRIVATE-SYNTHETIC|starter-accounts|recordSha256/);
}

test('listing disable preserves actual writer tracking and reenable cannot reuse an untracked view', async () => {
    const h = await boundHost(), added = await signupFixture('legacy', { seed: 810 });
    h.env[ENABLED_SETTING] = 'false';
    h.app = createProductionApplication(h.env, h.dependencies);
    const capabilities = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', h.cookie);
    expect(capabilities.status).toBe(503); expect(capabilities.body).not.toHaveProperty('signupList');
    const disabled = await boundList(h); expect([404, 503]).toContain(disabled.status);
    expect(disabled.body).not.toHaveProperty('rows');
    expect(h.accountReads()).toEqual([]);
    const { starter, downstream } = starterFactory(h, 'legacy', added);
    h.trace.maintenance = true;
    try { await expect(starter.setup.save(added.proof, added.details)).rejects.toBe(downstream); }
    finally { h.trace.maintenance = false; }
    expect(JSON.parse(h.source.get(WRITER_HEAD_KEY).toString()).state).toBe('dirty');
    h.env[ENABLED_SETTING] = 'true'; h.app = createProductionApplication(h.env, h.dependencies);
    const rows = []; let cursor = null;
    do { const page = await boundList(h, cursor); expect(page.status).toBe(200); rows.push(...page.body.rows); cursor = page.body.nextCursor; } while (cursor);
    expect(rows.map(row => row.email)).toContain(added.account.email);
}, HOST_TEST_TIMEOUT_MS);

test.each([undefined, '', 'false'])('staged locator with visibility %p performs no administration SDK or data reads', value => {
    const input = { ...env, [SETTING]: JSON.stringify(binding), [ENABLED_SETTING]: value };
    const dependencies = {};
    for (const key of ['ManagedIdentityCredential', 'BlobServiceClient']) Object.defineProperty(dependencies, key,
        { get() { throw new Error('SDK accessed while listing disabled'); } });
    expect(createBoundDashboardAdministration(input, null, dependencies, null)).toEqual({});
});

test.each([true, 'TRUE', ' true', '0', null])('noncanonical listing visibility %p cannot select administration', value => {
    expect(() => createBoundDashboardAdministration({ ...env, [SETTING]: JSON.stringify(binding), [ENABLED_SETTING]: value }, null, {}, null))
        .toThrow('dashboard_admin_production_configuration_invalid');
});

test('listing selection never executes an accessor', () => {
    const input = { ...env, [SETTING]: JSON.stringify(binding) }, get = jest.fn(() => 'true');
    Object.defineProperty(input, ENABLED_SETTING, { get });
    expect(() => createBoundDashboardAdministration(input, null, {}, null)).toThrow('dashboard_admin_production_configuration_invalid');
    expect(get).not.toHaveBeenCalled();
});

test('ordinary launcher keeps Improvement Plan default-off and composes its opt-in with audited administration', async () => {
    const h = await boundHost();
    expect(h.dependencies).not.toHaveProperty('dashboardAdministration');
    const disabled = await request(h.app).get('/api/dashboard/improvement/plans');
    expect(disabled.status).toBe(404); expect(disabled.body).toEqual({ code: 'dashboard_not_found' });
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.trace.reads).toEqual([]);

    h.env.NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED = 'true';
    h.app = createProductionApplication(h.env, h.dependencies);
    const denied = await request(h.app).get('/api/dashboard/improvement/plans');
    expect(denied.status).toBe(401); expect(denied.body).toEqual({ code: 'dashboard_authentication_required' });
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.trace.reads).toEqual([]);
    expect(h.state.audit).toEqual([]);

    const listed = await boundList(h);
    expect(listed.status).toBe(200); privateResult(listed); expect(listed.body.rows).toHaveLength(1);
    expect(h.state.audit.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    expect(h.state.trace.some(row => row.sql === 'COMMIT')).toBe(true);
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
}, HOST_TEST_TIMEOUT_MS);

test.each(['legacy', 'external'])('ordinary %s production host reads approved current records and commits both audit phases', async provider => {
    const h = await boundHost({ provider });
    expect(h.dependencies).not.toHaveProperty('dashboardAdministration');
    const capabilities = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', h.cookie);
    expect(capabilities.status).toBe(200); expect(capabilities.body).toEqual({ lookup: false, recovery: [], signupList: true });
    expect(h.accountReads()).toEqual([]);
    const first = await boundList(h); expect(first.status).toBe(200); privateResult(first);
    const second = await boundList(h, first.body.nextCursor); expect(second.status).toBe(200); privateResult(second);
    expect(first.body.rows).toHaveLength(1); expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(second.body.rows).toHaveLength(1); expect(second.body.nextCursor).toBeNull();
    expect([first.body.rows[0].email, second.body.rows[0].email].sort()).toEqual(h.data.map(x => x.account.email).sort());
    expect(new Set(h.data.map(x => x.entry.binding.tenantId)).size).toBe(2);
    for (const row of [first.body.rows[0], second.body.rows[0]]) expect(row).toMatchObject({ accountType: 'consultant',
        milestones: { accountSaved: { status: 'recorded' }, setupSaved: { status: 'recorded' },
            termsAccepted: { status: 'unknown' }, admission: { status: 'unknown' } } });
    expect(h.state.audit.map(x => x.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome', 'attempt', 'outcome']);
    expect(h.state.trace.some(x => x.sql === 'COMMIT')).toBe(true);
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
}, HOST_TEST_TIMEOUT_MS);

test.each(['legacy', 'external'])('ordinary %s listing cannot expose unsupported user or organisation management', async provider => {
    const h = await boundHost({ provider });
    expect(h.dependencies).not.toHaveProperty('dashboardAdministration');
    const before = { source: [...h.source], authority: [...h.authority], gate: clone(h.state.gate) };
    for (const route of ['reset', 'delete', 'grant', 'users', 'organisations', 'users/reset', 'organisations/delete']) {
        const response = await request(h.app).post('/api/dashboard-admin/' + route).set('Cookie', h.cookie)
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin')
            .send({ subjectKey: SUBJECT, tenantId: h.data[0].entry.binding.tenantId,
                organisationId: h.data[0].entry.binding.organisationId });
        expect(response.status).toBe(404); expect(response.body).toEqual({ code: 'dashboard_admin_not_found' });
        privateResult(response);
    }
    for (const method of ['get', 'put', 'patch', 'delete']) {
        const response = await request(h.app)[method]('/api/dashboard-admin/signups').set('Cookie', h.cookie);
        expect(response.status).toBe(405); expect(response.headers.allow).toBe('POST');
        expect(response.body).toEqual({ code: 'dashboard_admin_method_not_allowed' }); privateResult(response);
    }
    expect(h.trace.reads).toEqual([]); expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.state.audit).toEqual([]);
    expect([...h.source]).toEqual(before.source); expect([...h.authority]).toEqual(before.authority);
    expect(h.state.gate).toEqual(before.gate);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
    const capabilities = await request(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', h.cookie);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toEqual({ lookup: false, recovery: [], signupList: true });
    expect(h.accountReads()).toEqual([]); expect(h.trace.writes).toEqual([]); expect(h.state.audit).toEqual([]);
}, HOST_TEST_TIMEOUT_MS);

test('normal host reads authority and population together while retaining all native audit checkpoints', async () => {
    const h = await boundHost();
    expect(h.dependencies).not.toHaveProperty('dashboardAdministration');
    h.state.trace.length = 0;
    const response = await boundList(h);
    expect(response.status).toBe(200); privateResult(response);
    expect(response.body.rows).toHaveLength(1);
    expect(h.accountReads()).toHaveLength(2);
    expect(h.state.audit.map(x => x.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    const head = JSON.parse(h.authority.get(listingHeadKey(h.target)).toString());
    const archiveKey = listingRevisionKey(h.target, head.recordSha256);
    // The split authority/binding ports required 192 coherent walks and 2,994
    // downloads for this request. One walk per existing checkpoint removes
    // duplicate observations while preserving the 308 SQL calls/14 transactions.
    // The independent writer generation now adds six pinned reads per walk.
    expect({ downloads: h.trace.reads.length,
        approvalWalks: h.trace.reads.filter(x => x.name === h.selected.authorityContainer && x.key === archiveKey).length,
        sqlCalls: h.state.trace.length,
        transactions: h.state.trace.filter(x => x.sql.startsWith('BEGIN')).length,
        commits: h.state.trace.filter(x => x.sql === 'COMMIT').length })
        .toEqual({ downloads: 2172, approvalWalks: 98, sqlCalls: 308, transactions: 14, commits: 14 });
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
}, HOST_TEST_TIMEOUT_MS);

test.each(['missing approval', 'incomplete index', 'revoked approval', 'expired approval'])('ordinary host refuses %s without account reads', async defect => {
    const h = await boundHost({ approval: defect !== 'missing approval', complete: defect !== 'incomplete index' });
    if (defect === 'revoked approval') h.publishPolicy('revoked');
    if (defect === 'expired approval') { h.policy.validUntil = new Date(Date.parse(h.state.now) + 1).toISOString(); h.publishPolicy(); h.state.now = h.policy.validUntil; }
    const result = await boundList(h); expect([403, 503]).toContain(result.status); privateResult(result);
    expect(result.body).not.toHaveProperty('rows'); expect(h.accountReads()).toEqual([]);
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
});

test.each(['consultant', 'customer cookie', 'revoked staff'])('ordinary host denies %s before protected policy/index reads', async defect => {
    const h = await boundHost({ role: defect === 'consultant' ? 'consultant' : 'admin' });
    if (defect === 'revoked staff') h.env.NOFRIES_ALLOWED_SUBJECTS = uid(900) + ':' + uid(901);
    const app = defect === 'revoked staff' ? createProductionApplication(h.env, h.dependencies) : h.app;
    const result = await boundList({ ...h, app }, null, defect === 'customer cookie' ? '__Host-nofries_customer=customer-only' : h.cookie);
    expect([401, 403]).toContain(result.status); privateResult(result);
    expect(h.trace.reads.filter(x => x.name === h.selected.authorityContainer || x.name === h.sourceName)).toEqual([]);
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(h.trace.writes).toEqual([]);
});

test('index maintenance adds a new account and invalidates an old cursor without reconstructing the host', async () => {
    const h = await boundHost(), first = await boundList(h);
    expect(first.status).toBe(200);
    const added = await signupFixture('legacy', { seed: 300 });
    h.trace.maintenance = true;
    try { await expect(h.maintenance.accountStore.create(added.reference.accountKey, added.account)).resolves.toBe(true); }
    finally { h.trace.maintenance = false; }
    const old = await boundList(h, first.body.nextCursor); expect([400, 403]).toContain(old.status); privateResult(old);
    const rows = []; let cursor = null;
    do { const page = await boundList(h, cursor); expect(page.status).toBe(200); rows.push(...page.body.rows); cursor = page.body.nextCursor; } while (cursor);
    expect(rows.map(x => x.email).sort()).toEqual([...h.data.map(x => x.account.email), added.account.email].sort());
    expect(rows.find(x => x.email === added.account.email).milestones.setupSaved.status).toBe('unknown');
    expect(h.trace.lists.every(prefix => prefix === TICKET_PREFIX)).toBe(true);
}, INDEX_MAINTENANCE_JOURNEY_TIMEOUT_MS);

test('authority revoked during account loading suppresses rows even after the attempt audit', async () => {
    const h = await boundHost(); let revoked = false;
    h.trace.beforeRead = async ({ name, key }) => {
        if (!revoked && name === h.sourceName && key.startsWith('customer-starter/starter-accounts/')) {
            revoked = true; h.publishPolicy('revoked');
        }
    };
    const result = await boundList(h); expect([403, 503]).toContain(result.status); privateResult(result);
    expect(result.body).not.toHaveProperty('rows'); expect(revoked).toBe(true);
    expect(h.state.audit.some(x => x.payload.serviceEvent.phase === 'attempt')).toBe(true);
    expect(h.state.audit.some(x => x.payload.serviceEvent.outcome === 'available')).toBe(false);
});

test('an unresolved account does not block another actual starter factory; the host refuses until positive closure', async () => {
    const h = await boundHost(), added = await signupFixture('legacy', { seed: 600 });
    h.policy.pageSize = 2; h.publishPolicy();
    let sourceAttempted = false;
    h.trace.beforeWrite = async ({ key }) => { if (key === added.accountPath) {
        sourceAttempted = true; throw new Error('synthetic unknown source outcome');
    } };
    h.trace.maintenance = true;
    try { await expect(h.maintenance.accountStore.create(added.reference.accountKey, added.account)).rejects.toThrow(); }
    finally { h.trace.maintenance = false; }
    expect(sourceAttempted).toBe(true);
    // Absence is observed only in this synthetic transport. It is NOT evidence
    // that the original remote call cannot finish, so listing must stay closed.
    expect(h.source.has(added.accountPath)).toBe(false);
    expect(JSON.parse(h.source.get(WRITER_HEAD_KEY).toString()).state).toBe('dirty');
    h.trace.reads.length = 0; h.trace.writes.length = 0;
    const result = await boundList(h); expect(result.status).toBe(503); privateResult(result);
    expect(result.body.code).toBe('dashboard_admin_unavailable');
    expect(result.body).not.toHaveProperty('rows');
    expect(h.state.audit.some(x => x.payload.serviceEvent.outcome === 'available')).toBe(false);

    const next = await signupFixture('legacy', { seed: 700 });
    const { starter, downstream } = starterFactory(h, 'legacy', next);
    h.trace.maintenance = true; h.trace.reads.length = 0;
    try { await expect(starter.setup.save(next.proof, next.details)).rejects.toBe(downstream); }
    finally { h.trace.maintenance = false; }
    const saved = await new AzureStarterAccountStore(h.sourceContainer).load(next.reference.accountKey);
    expect(saved.record.accountType).toBe('consultant'); expect(saved.record.activation).toBeNull();
    expect(h.trace.reads.some(x => x.key.includes('/dashboard-admin-signup-index/revisions/') ||
        x.name === h.env.NOFRIES_DASHBOARD_EPOCH_CONTAINER)).toBe(false);
    expect(h.trace.writes.filter(x => x.key === added.accountPath)).toEqual([]);
    const stillUnknown = await boundList(h); expect(stillUnknown.status).toBe(503);
    expect(stillUnknown.body).not.toHaveProperty('rows');

    // Only the customer's legitimate conditional retry closes this family.
    // Maintenance never replays its payload or creates a substitute account.
    h.trace.beforeWrite = null; h.trace.maintenance = true;
    try { await expect(h.maintenance.accountStore.create(added.reference.accountKey, added.account)).resolves.toBe(true); }
    finally { h.trace.maintenance = false; }
    const rows = []; let cursor = null;
    do {
        const page = await boundList(h, cursor);
        expect(page.status).toBe(200); privateResult(page); rows.push(...page.body.rows); cursor = page.body.nextCursor;
    } while (cursor);
    expect(rows.map(row => row.email).sort()).toEqual([...h.data.map(item => item.account.email), added.account.email, next.account.email].sort());
    expect(h.trace.writes.filter(x => x.key === added.accountPath)).toHaveLength(1);
}, HOST_TEST_TIMEOUT_MS);

test('complete-population overflow refuses the whole host view instead of selecting its first hundred accounts', async () => {
    const h = await boundHost();
    for (let i = 0; i < 99; i++) {
        const item = await signupFixture('legacy', { seed: 1000 + i });
        h.put(h.env.AZURE_STORAGE_ACCOUNT_NAME, h.sourceName, item.accountPath, item.account);
    }
    await expect(h.rebuild()).resolves.toMatchObject({ state: 'overflow', complete: false, count: null });
    h.trace.reads.length = 0; h.trace.writes.length = 0; h.trace.lists.length = 0;
    const result = await boundList(h); expect(result.status).toBe(503); privateResult(result);
    expect(result.body.code).toBe('dashboard_admin_unavailable');
    expect(result.body).not.toHaveProperty('rows'); expect(h.accountReads()).toEqual([]);
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
});

function starterFactory(h, provider, added) {
    const { createStarterSignupProduction } = require('../lib/starterSignupProduction');
    const downstream = new Error('synthetic-offer-not-bound');
    const starter = createStarterSignupProduction({ env: { ...h.env, NOFRIES_STARTER_AUTHORITY_CONTAINER: h.sourceName },
        dashboard: h.dashboard, database: { async withTenantTransaction(tenantId, work) {
            expect(tenantId).toBe(h.dashboard.identityPolicy.identityTenantId);
            return work({ async query(sql, parameters) {
                // The reader's sole pre-allocation SQL is a bounded catalog
                // observation. Any lifecycle query or mutation still fails.
                expect(sql.replace(/\s+/g, ' ').trim()).toBe("SELECT a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AS is_text, a.attnotnull AS not_null, " +
                    "EXISTS (SELECT 1 FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_attribute t ON t.attrelid=c.oid AND t.attname='identity_tenant_id' AND NOT t.attisdropped " +
                    "JOIN pg_catalog.pg_attribute s ON s.attrelid=c.oid AND s.attname='subject_key' AND NOT s.attisdropped " +
                    "WHERE p.conrelid=c.oid AND p.contype='p' AND p.conkey=ARRAY[t.attnum,s.attnum,a.attnum]::smallint[]) AS scoped_primary_key " +
                    "FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace " +
                    "WHERE n.nspname='nofries' AND c.relname='signup_registrations' AND c.relkind='r' AND a.attname='row_key' AND a.attnum>0 AND NOT a.attisdropped LIMIT 2");
                expect(parameters).toEqual([]); return { rows: [] };
            } });
        } }, policy: { begin: async () => { throw new Error('unused'); },
            verify: async () => { throw new Error('unused'); }, recheck: async () => { throw new Error('unused'); } },
        readCustomer: async () => null, container: h.sourceContainer,
        legacyRecords: { readSubject: async () => null, readTerms: async () => { throw downstream; } },
        starterRecords: { readSubject: async () => null }, graph: {}, invitations: {}, sendMemberInvitation: async () => {},
        ...(provider === 'external' ? { external: { identityPolicy: h.dashboard.identityPolicy, providerKey: added.proof.providerKey } } : {}) });
    return { starter, downstream };
}

test.each(['legacy', 'external'])('actual %s starter factory fences account allocation before a downstream offer failure', async provider => {
    const h = await boundHost({ provider }), added = await signupFixture(provider, { seed: 500 });
    const { starter, downstream } = starterFactory(h, provider, added);
    h.trace.maintenance = true;
    try { await expect(starter.setup.save(added.proof, added.details)).rejects.toBe(downstream); }
    finally { h.trace.maintenance = false; }
    const writes = h.trace.writes;
    const accountPosition = writes.findIndex(x => x.key === added.accountPath);
    expect(accountPosition).toBeGreaterThan(0);
    const before = writes.slice(0, accountPosition).filter(x => x.key === WRITER_HEAD_KEY);
    expect(before.at(-1).value.state).toBe('dirty');
    expect(writes.slice(accountPosition + 1).filter(x => x.key === INDEX_HEAD_KEY)).toEqual([]);
    expect(h.trace.reads.some(x => x.key.includes('/dashboard-admin-signup-index/revisions/'))).toBe(false);
    const index = await h.maintenance.readCurrentIndex();
    expect(index.manifest.entries).toHaveLength(3);
    const allocated = await new AzureStarterAccountStore(h.sourceContainer).load(added.reference.accountKey);
    expect(allocated.record.accountType).toBe('consultant'); expect(allocated.record.activation).toBeNull();
    for (const existing of h.data) expect(JSON.parse(h.source.get(existing.accountPath).toString())).toEqual(existing.account);
    const rows = []; let cursor = null;
    do { const page = await boundList(h, cursor); expect(page.status).toBe(200); rows.push(...page.body.rows); cursor = page.body.nextCursor; } while (cursor);
    expect(rows.map(x => x.email)).toContain(added.account.email);
    expect(h.trace.lists.every(prefix => prefix === TICKET_PREFIX)).toBe(true);
}, STARTER_ALLOCATION_JOURNEY_TIMEOUT_MS);

test.each(['ManagedIdentityCredential', 'BlobServiceClient'].flatMap(key => [null, false, 0, undefined, {}].map(value => [key, value])))
('explicit invalid %s constructor %p cannot fall back to a real SDK', async (key, value) => {
    const h = await boundHost(), constructors = { ManagedIdentityCredential: jest.fn(), BlobServiceClient: jest.fn() };
    const dependencies = { ...constructors, [key]: value };
    expect(() => createBoundDashboardAdministration(h.env, h.dashboard, dependencies, null)).toThrow('dashboard_admin_production_configuration_invalid');
    expect(constructors.ManagedIdentityCredential).not.toHaveBeenCalled(); expect(constructors.BlobServiceClient).not.toHaveBeenCalled();
});

test.each([null, false, 0, {}, [], 'not-a-guid'])('invalid managed identity selector %p cannot construct any SDK', async value => {
    const h = await boundHost(), dependencies = { ManagedIdentityCredential: jest.fn(), BlobServiceClient: jest.fn() };
    expect(() => createBoundDashboardAdministration({ ...h.env, NOFRIES_MANAGED_IDENTITY_CLIENT_ID: value }, h.dashboard, dependencies, null))
        .toThrow('dashboard_admin_production_configuration_invalid');
    expect(dependencies.ManagedIdentityCredential).not.toHaveBeenCalled(); expect(dependencies.BlobServiceClient).not.toHaveBeenCalled();
});

test('configured maintenance factory inspects the same stores but cannot publish or rebuild without exact current authority', async () => {
    const h = await boundHost();
    const { createBoundDashboardAdminMaintenance } = require('../lib/dashboardAdminBindings');
    const authorisation = { authoriseMaintenance: jest.fn(async () => false), authorisePublication: jest.fn(async () => false) };
    const before = { reads: h.trace.reads.length, writes: h.trace.writes.length, lists: h.trace.lists.length };
    const maintenance = createBoundDashboardAdminMaintenance(h.env, h.dashboard, h.dependencies, null, authorisation);
    expect({ reads: h.trace.reads.length, writes: h.trace.writes.length, lists: h.trace.lists.length }).toEqual(before);
    const population = await maintenance.inspectPopulation();
    expect(population.state).toBe('complete');
    const approval = await maintenance.inspectApproval({ operatorSubjectKey: SUBJECT });
    expect(approval.expectedRevision).toBe(1);
    expect(new Set(h.trace.reads.map(x => x.name))).toEqual(new Set([h.sourceName, h.selected.authorityContainer]));
    const record = JSON.parse(h.authority.get(listingRevisionKey(h.target, approval.expectedRecordSha256)).toString());
    const next = { ...record, revision: record.revision + 1, status: 'revoked', policy: null };
    await expect(maintenance.publishApproval({ record: next, expectedRevision: approval.expectedRevision,
        expectedRecordSha256: approval.expectedRecordSha256 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(maintenance.rebuildPopulation()).rejects.toThrow();
    expect(authorisation.authorisePublication).toHaveBeenCalledTimes(1);
    expect(authorisation.authoriseMaintenance).toHaveBeenCalledTimes(1);
    expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
    expect(JSON.parse(h.source.get(INDEX_HEAD_KEY).toString()).state).toBe('complete');
    expect((await boundList(h)).status).toBe(200);
}, HOST_TEST_TIMEOUT_MS);

test.each(['legacy', 'external'])('bound %s maintenance rebuilds and publishes the same source consumed by the ordinary host', async provider => {
    const h = await boundHost({ provider, approval: false, complete: false });
    const { createBoundDashboardAdminMaintenance } = require('../lib/dashboardAdminBindings');
    const record = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_revision', ...h.target,
        restoreEpoch: h.state.epoch, revision: 0, status: 'active', changedAt: h.state.now,
        decisionReference: 'synthetic-bound-maintenance-only', policy: clone(h.policy) };
    const expectedMaintenance = { action: 'dashboard.signup_index.rebuild', instanceId: h.target.instanceId,
        provider, populationId: h.selected.populationId, indexId: h.selected.indexId,
        sourceBindingSha256: h.target.sourceBindingSha256, writerContract: WRITER_CONTRACT, expectedPendingRebuild: null };
    const authorisation = {
        authoriseMaintenance: jest.fn(async input => {
            expect(input).toEqual(expectedMaintenance); expect(Object.isFrozen(input)).toBe(true);
            return true; // Only this exact synthetic target; not operational authority.
        }),
        authorisePublication: jest.fn(async input => {
            expect(input).toEqual({ phase: authorisation.authorisePublication.mock.calls.length === 1 ? 'archive' : 'head',
                record, expectedRevision: null, expectedRecordSha256: null });
            expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.record)).toBe(true);
            return true; // Complete synthetic policy and predecessor checked above.
        })
    };
    const maintenance = createBoundDashboardAdminMaintenance(h.env, h.dashboard, h.dependencies,
        provider === 'external' ? h.dependencies.externalCustomer : null, authorisation);
    expect(h.trace.reads).toEqual([]); expect(h.trace.writes).toEqual([]); expect(h.trace.lists).toEqual([]);
    expect(await maintenance.inspectPopulation()).toMatchObject({ state: 'absent', revision: null,
        restoreEpoch: h.state.epoch, sourceBindingSha256: h.target.sourceBindingSha256 });
    const predecessor = await maintenance.inspectApproval({ operatorSubjectKey: SUBJECT });
    expect(predecessor).toEqual({ expectedRevision: null, expectedRecordSha256: null, restoreEpoch: h.state.epoch });
    const accountsBefore = [...h.source];
    h.trace.maintenance = true;
    try {
        expect(await maintenance.rebuildPopulation()).toMatchObject({ state: 'complete', complete: true, count: 2 });
        expect(await maintenance.publishApproval({ record, expectedRevision: predecessor.expectedRevision,
            expectedRecordSha256: predecessor.expectedRecordSha256 })).toEqual({ schemaVersion: 1,
            targetSha256: hash(h.target), revision: 0, recordSha256: hash(record), status: 'active' });
    } finally { h.trace.maintenance = false; }
    expect(authorisation.authoriseMaintenance).toHaveBeenCalledTimes(2);
    expect(authorisation.authorisePublication.mock.calls.map(([input]) => input.phase)).toEqual(['archive', 'head']);
    expect(h.trace.writes.filter(x => x.name === h.selected.authorityContainer).map(x => x.key))
        .toEqual([listingRevisionKey(h.target, hash(record)), listingHeadKey(h.target)]);
    for (const [key, value] of accountsBefore) expect(h.source.get(key)).toEqual(value);
    expect(h.state.audit).toEqual([]);
    const writeCount = h.trace.writes.length, scanCount = h.trace.lists.length;
    const page = await boundList(h); expect(page.status).toBe(200); privateResult(page);
    expect(page.body.rows).toHaveLength(1); expect(page.body.rows[0].email).toBe(h.data[0].account.email);
    expect(h.state.audit.map(x => x.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    expect(h.state.audit.every(x => x.event_type === 'dashboard.admin.signup_list')).toBe(true);
    expect(h.state.trace.some(x => x.sql === 'COMMIT')).toBe(true);
    expect(h.trace.writes).toHaveLength(writeCount); expect(h.trace.lists).toHaveLength(scanCount);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
}, HOST_TEST_TIMEOUT_MS);
