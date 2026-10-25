'use strict';

const { Readable } = require('node:stream');
const { createDashboardAuthorityStore } = require('../api/shared/dashboardAuthorityStore');
const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const uid = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const INSTANCE = uid(1), EPOCH = uid(2), SESSION = 'a'.repeat(64);
const proof = () => ({ schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: SESSION,
    identitySha256: 'b'.repeat(64), instanceId: INSTANCE, restoreEpoch: EPOCH,
    issuedAt: '2026-09-12T06:00:00.000Z', expiresAt: '2026-09-12T07:00:00.000Z' });
function container() {
    const records = new Map();
    const download = jest.fn(async key => {
        if (!records.has(key)) throw Object.assign(new Error('private provider detail'), { statusCode: 404, code: 'BlobNotFound' });
        const bytes = records.get(key);
        return { contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
    });
    const upload = jest.fn(async (key, bytes, options) => {
        if (options.conditions.ifNoneMatch !== '*' || records.has(key)) throw Object.assign(new Error('private conflict'), { statusCode: 412 });
        records.set(key, bytes);
    });
    return { records, download, upload, getBlockBlobClient: jest.fn(key => ({
        download: (...args) => download(key, ...args), uploadData: (...args) => upload(key, ...args)
    })) };
}
function harness() {
    const proofs = container(), epochs = container();
    epochs.records.set(`runtime-epochs/${INSTANCE}.json`, Buffer.from(JSON.stringify({ instanceId: INSTANCE, restoreEpoch: EPOCH })));
    const adapter = createDashboardAuthorityStore({ proofContainer: proofs, epochContainer: epochs, instanceId: INSTANCE });
    return { proofs, epochs, ...adapter };
}

test('original proof survives a new adapter and duplicate creation cannot replace it', async () => {
    const h = harness();
    expect(await h.proofStore.createOriginalProof(SESSION, proof())).toBeUndefined();
    const second = createDashboardAuthorityStore({ proofContainer: h.proofs, epochContainer: h.epochs, instanceId: INSTANCE });
    expect(await second.proofStore.readOriginalProof(SESSION)).toEqual(proof());
    await expect(second.proofStore.createOriginalProof(SESSION, { ...proof(), restoreEpoch: uid(9) })).rejects.toThrow('dashboard_authority_store_unavailable');
    expect(await second.proofStore.readOriginalProof(SESSION)).toEqual(proof());
});
test('only missing original proof returns null; missing epoch is unavailable', async () => {
    const h = harness();
    expect(await h.proofStore.readOriginalProof(SESSION)).toBeNull();
    h.epochs.records.clear();
    await expect(h.readExternalRuntimeEpoch()).rejects.toThrow('dashboard_authority_store_unavailable');
});
test.each([409, 412])('reconciles committed proof after lost upload response and %s retry', async statusCode => {
    const h = harness();
    h.proofs.upload.mockImplementationOnce(async (key, bytes) => {
        h.proofs.records.set(key, bytes);
        throw Object.assign(new Error('lost response then retry conflict'), { statusCode });
    });
    await expect(h.proofStore.createOriginalProof(SESSION, proof())).resolves.toBeUndefined();
    await expect(h.proofStore.createOriginalProof(SESSION, proof())).resolves.toBeUndefined();
    expect(await h.proofStore.readOriginalProof(SESSION)).toEqual(proof());
});
test.each([null, { ...proof(), identitySha256: 'c'.repeat(64) }])('rejects malformed or changed proof on conflict', async stored => {
    const h = harness();
    h.proofs.records.set(`dashboard-proofs/${SESSION}.json`, Buffer.from(JSON.stringify(stored)));
    await expect(h.proofStore.createOriginalProof(SESSION, proof())).rejects.toThrow('dashboard_authority_store_unavailable');
});
test('conflict without readable stored proof fails closed', async () => {
    const h = harness();
    h.proofs.upload.mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 412 }));
    await expect(h.proofStore.createOriginalProof(SESSION, proof())).rejects.toThrow('dashboard_authority_store_unavailable');
});
test('every epoch read observes external change and has no write capability', async () => {
    const h = harness();
    expect(await h.readExternalRuntimeEpoch()).toEqual({ instanceId: INSTANCE, restoreEpoch: EPOCH });
    h.epochs.records.set(`runtime-epochs/${INSTANCE}.json`, Buffer.from(JSON.stringify({ instanceId: INSTANCE, restoreEpoch: uid(3) })));
    expect(await h.readExternalRuntimeEpoch()).toEqual({ instanceId: INSTANCE, restoreEpoch: uid(3) });
    expect(h.epochs.download).toHaveBeenCalledTimes(2);
    expect(h.epochs.upload).not.toHaveBeenCalled();
});
test.each(['ContainerNotFound', 'ResourceNotFound', undefined])('404 %s is an unavailable store, not an absent proof', async code => {
    const h = harness();
    h.proofs.download.mockRejectedValue(Object.assign(new Error('private configuration detail'), { statusCode: 404, code }));
    await expect(h.proofStore.readOriginalProof(SESSION)).rejects.toThrow('dashboard_authority_store_unavailable');
});
test.each([
    ['wrong key', SESSION, { ...proof(), sessionSha256: 'c'.repeat(64) }],
    ['wrong instance', SESSION, { ...proof(), instanceId: uid(4) }],
    ['extra field', SESSION, { ...proof(), elevated: true }],
    ['invalid key', '../escape', proof()],
    ['wrong lifetime', SESSION, { ...proof(), expiresAt: proof().issuedAt }]
])('rejects %s before writing proof', async (_, key, input) => {
    const h = harness();
    await expect(h.proofStore.createOriginalProof(key, input)).rejects.toThrow('dashboard_authority_store_unavailable');
    expect(h.proofs.upload).not.toHaveBeenCalled();
});
test.each([
    Buffer.from('x'.repeat(16385)), Buffer.from('{broken'), Buffer.from([0xff]), Buffer.from('null'),
    Buffer.from(JSON.stringify({ ...proof(), sessionSha256: 'c'.repeat(64) }))
])('rejects corrupt stored proof with sanitized error', async bytes => {
    const h = harness(); h.proofs.records.set(`dashboard-proofs/${SESSION}.json`, bytes);
    await expect(h.proofStore.readOriginalProof(SESSION)).rejects.toThrow('dashboard_authority_store_unavailable');
});
test('rejects response body longer than declared length and destroys the stream', async () => {
    const h = harness(), stream = Readable.from([Buffer.from('12345')]);
    h.proofs.download.mockResolvedValue({ contentLength: 2, readableStreamBody: stream });
    await expect(h.proofStore.readOriginalProof(SESSION)).rejects.toThrow('dashboard_authority_store_unavailable');
    expect(stream.destroyed).toBe(true);
});
test('aborts and destroys a stalled response body within the store deadline', async () => {
    jest.useFakeTimers();
    try {
        const h = harness(), stream = new Readable({ read() {} });
        h.proofs.download.mockResolvedValue({ contentLength: 10, readableStreamBody: stream });
        const rejected = expect(h.proofStore.readOriginalProof(SESSION)).rejects.toThrow('dashboard_authority_store_unavailable');
        await jest.advanceTimersByTimeAsync(5000); await rejected;
        expect(stream.destroyed).toBe(true);
    } finally { jest.useRealTimers(); }
});
test.each([{ instanceId: uid(8), restoreEpoch: EPOCH }, { instanceId: INSTANCE, restoreEpoch: EPOCH, extra: true }, { instanceId: INSTANCE, restoreEpoch: 'old' }])('rejects malformed external epoch', async input => {
    const h = harness(); h.epochs.records.set(`runtime-epochs/${INSTANCE}.json`, Buffer.from(JSON.stringify(input)));
    await expect(h.readExternalRuntimeEpoch()).rejects.toThrow('dashboard_authority_store_unavailable');
});

function environment(overrides = {}) {
    return { NODE_ENV: 'production', NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth123', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata123',
        NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-secret',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_ENTRA_TENANT_ID: uid(6), NOFRIES_ENTRA_CLIENT_ID: uid(7),
        NOFRIES_ALLOWED_SUBJECTS: `${uid(6)}:${uid(8)}`, NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true',
        NOFRIES_DASHBOARD_INSTANCE_ID: INSTANCE, NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: 'internal-operator-policy',
        NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: '0', NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs',
        NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs', NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com',
        NOFRIES_POSTGRES_DATABASE: 'nofries', NOFRIES_POSTGRES_USER: 'nofries_app', ...overrides };
}
function dependencies() {
    const pool = { connect: jest.fn(), end: jest.fn() }, store = require('../api/shared/browserSessionStore').MemoryBrowserSessionStore;
    const credential = { getToken: jest.fn() };
    return { pool, credential,
        ManagedIdentityCredential: jest.fn(function () { return credential; }),
        BlobServiceClient: jest.fn(function () { return { getContainerClient: jest.fn(() => container()) }; }),
        createBrowserSessionStore: jest.fn(() => new store()), createPostgresPool: jest.fn(() => pool) };
}
test.each([undefined, '', 'false'])('disabled configuration performs no provider construction', enabled => {
    const d = dependencies(); expect(createProductionDashboardConfiguration({ NOFRIES_DASHBOARD_RUNTIME_ENABLED: enabled }, d)).toBeNull();
    expect(d.ManagedIdentityCredential).not.toHaveBeenCalled();
});
test.each([
    { NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'TRUE' }, { NODE_ENV: 'development' }, { NOFRIES_REQUIRE_AUTH: 'false' },
    { NOFRIES_DASHBOARD_INSTANCE_ID: 'bad' }, { NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: '-1' },
    { NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-epochs' }, { NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'nofries-browser-auth' },
    { NOFRIES_POSTGRES_HOST: 'attacker.test' }, { NOFRIES_DATABASE_URL: 'postgres://private' },
    { NOFRIES_MANAGED_IDENTITY_CLIENT_ID: 'bad' }
])('invalid enabled configuration fails closed', overrides => {
    expect(() => createProductionDashboardConfiguration(environment(overrides), dependencies())).toThrow('dashboard_production_configuration_invalid');
});
test('production configuration binds managed identity, TLS pool factory and concrete genuine host', () => {
    const d = dependencies(), env = environment({ NOFRIES_MANAGED_IDENTITY_CLIENT_ID: uid(9) });
    const configuration = createProductionDashboardConfiguration(env, d);
    expect(d.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: uid(9) });
    expect(d.createPostgresPool).toHaveBeenCalledWith(expect.objectContaining({ env, credential: d.credential, poolMax: 5 }));
    expect(configuration.identityPolicy).toMatchObject({ audience: uid(7), identityTenantId: uid(6) });
    expect(configuration.newGenerationToken()).toMatch(/^[a-f0-9]{64}$/);
    expect(() => require('../server').createNoFriesApp({ dashboard: configuration })).not.toThrow();
    expect(d.pool.connect).not.toHaveBeenCalled();
});
test('provider initialization detail is never surfaced', () => {
    const d = dependencies(); d.createPostgresPool.mockImplementation(() => { throw new Error('private-secret'); });
    expect(() => createProductionDashboardConfiguration(environment(), d)).toThrow('dashboard_production_configuration_invalid');
});

function syntheticNcscPolicies() {
    return { schemaVersion: 1, policies: [{ schemaVersion: 1, tenantId: 'synthetic-a', organisationId: 'synthetic-org',
        productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement', moduleId: 'cyber_security',
        profileRef: { ...require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF },
        policyId: 'synthetic-policy', policyRevision: 0,
        validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z',
        limit: 'assessment_runs', amount: 1 }] };
}
test.each([undefined, '', 'false'])('NCSC absent or disabled %p preserves unavailable routes', async enabled => {
    const d = dependencies();
    const env = environment();
    if (enabled !== undefined) env.NOFRIES_DASHBOARD_NCSC_ENABLED = enabled;
    const configuration = createProductionDashboardConfiguration(env, d);
    expect(configuration).not.toHaveProperty('ncsc');
    const response = await require('supertest')(require('../server').createNoFriesApp({ dashboard: configuration }))
        .get('/api/dashboard/ncsc/assessments');
    expect(response.status).toBe(404); expect(d.pool.connect).not.toHaveBeenCalled();
});
test.each(['TRUE', '1', true, ' true '])('invalid NCSC flag %p fails before provider construction', enabled => {
    const d = dependencies();
    expect(() => createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_NCSC_ENABLED: enabled }), d))
        .toThrow('dashboard_production_configuration_invalid');
    expect(d.ManagedIdentityCredential).not.toHaveBeenCalled();
});
test('an explicitly undefined environment property remains rejected by the genuine host', () => {
    const d = dependencies();
    const configuration = createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_NCSC_ENABLED: undefined }), d);
    expect(() => require('../server').createNoFriesApp({ dashboard: configuration })).toThrow('No Fries could not complete sign-in.');
    expect(d.pool.connect).not.toHaveBeenCalled();
});
test('NCSC opt-in with empty packaged policies registers authenticated draft routes but denies submission', async () => {
    const d = dependencies();
    const configuration = createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_NCSC_ENABLED: 'true' }), d);
    const response = await require('supertest')(require('../server').createNoFriesApp({ dashboard: configuration }))
        .get('/api/dashboard/ncsc/assessments');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('dashboard_authentication_required');
    expect(d.pool.connect).not.toHaveBeenCalled();
    expect(() => configuration.ncsc.resolveSubmissionQuota({
        tenantId: 'synthetic-a', organisationId: 'synthetic-org', assessmentId: 'synthetic-assessment',
        actorSubjectKey: `${uid(6)}:${uid(8)}`, moduleId: 'cyber_security',
        profileRef: { ...require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF },
        productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement',
        expectedRevision: 1, submissionRevision: 2, at: '2026-09-16T00:00:00.000Z'
    })).toThrow('ncsc_submission_policy_unavailable');
});
test('reviewed policies wire genuine NCSC HTTP routes while retaining authentication', async () => {
    const d = dependencies(); d.ncscPolicies = syntheticNcscPolicies();
    const configuration = createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_NCSC_ENABLED: 'true' }), d);
    expect(typeof configuration.ncsc.resolveSubmissionQuota).toBe('function');
    const response = await require('supertest')(require('../server').createNoFriesApp({ dashboard: configuration }))
        .get('/api/dashboard/ncsc/assessments');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('dashboard_authentication_required');
    expect(d.pool.connect).not.toHaveBeenCalled();
});

test('customer production NCSC reads the existing separate authority container without granting any write capability', async () => {
    const d = dependencies(), authority = container();
    d.BlobServiceClient.mockImplementation(function (url) {
        return { getContainerClient: jest.fn(name => url.includes('syntheticdata123') && name === 'customer-authority' ? authority : container()) };
    });
    const configuration = createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_NCSC_ENABLED: 'true',
        NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'true', NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority' }), d);
    const input = { tenantId: 'synthetic-a', organisationId: 'synthetic-org', assessmentId: 'synthetic-assessment',
        actorSubjectKey: `${uid(6)}:${uid(8)}`, moduleId: 'cyber_security',
        profileRef: { ...require('../api/shared/assessmentEngine/ncscAssessmentEvaluator').ACCEPTED_PROFILE_REF },
        productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement',
        expectedRevision: 1, submissionRevision: 2, at: '2026-09-28T00:00:00.000Z' };
    await expect(configuration.ncsc.resolveSubmissionQuota(input)).rejects.toMatchObject({ code: 'ncsc_submission_unavailable' });
    expect(authority.download).toHaveBeenCalledTimes(1); expect(authority.upload).not.toHaveBeenCalled();
    expect(d.pool.connect).not.toHaveBeenCalled();
});
