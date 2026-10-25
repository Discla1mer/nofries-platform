'use strict';

const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function environment(extra = {}) {
    return { NODE_ENV: 'production', NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth123', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata123',
        NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-provider-only',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_ENTRA_TENANT_ID: id(6), NOFRIES_ENTRA_CLIENT_ID: id(7),
        NOFRIES_ALLOWED_SUBJECTS: `${id(6)}:${id(8)}`, NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true',
        NOFRIES_DASHBOARD_INSTANCE_ID: id(1), NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: 'internal-operator-policy',
        NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: '0', NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs',
        NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs', NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com',
        NOFRIES_POSTGRES_DATABASE: 'nofries', NOFRIES_POSTGRES_USER: 'nofries_app', ...extra };
}
function dependencies() {
    const pool = { connect: jest.fn(), end: jest.fn() };
    return { pool,
        ManagedIdentityCredential: jest.fn(function () { return { getToken: jest.fn() }; }),
        BlobServiceClient: jest.fn(function () {
            return { getContainerClient: jest.fn(() => ({ getBlockBlobClient: jest.fn() })) };
        }),
        createBrowserSessionStore: jest.fn(() => new MemoryBrowserSessionStore()),
        createPostgresPool: jest.fn(() => pool) };
}

test.each([undefined, '', 'false'])('ordinary %j configuration leaves Improvement Plan absent', value => {
    const deps = dependencies();
    const result = createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED: value }), deps);
    expect(result).not.toHaveProperty('improvementEnabled');
    expect(deps.createPostgresPool).toHaveBeenCalledTimes(1);
    expect(deps.pool.connect).not.toHaveBeenCalled();
});

test('explicit opt-in forwards only the fixed capability and constructs no extra clients', () => {
    const deps = dependencies(), env = environment({ NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED: 'true' });
    const result = createProductionDashboardConfiguration(env, deps);
    expect(result.improvementEnabled).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    env.NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED = 'false';
    expect(result.improvementEnabled).toBe(true);
    expect(deps.ManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(deps.BlobServiceClient).toHaveBeenCalledTimes(1);
    expect(deps.createPostgresPool).toHaveBeenCalledTimes(1);
    expect(deps.pool.connect).not.toHaveBeenCalled();
});

test.each([null, false, true, 0, 'TRUE', 'yes', '1', ' true'])('invalid %j opt-in fails before external construction', value => {
    const deps = dependencies();
    expect(() => createProductionDashboardConfiguration(environment({ NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED: value }), deps))
        .toThrow('dashboard_production_configuration_invalid');
    expect(deps.ManagedIdentityCredential).not.toHaveBeenCalled();
    expect(deps.BlobServiceClient).not.toHaveBeenCalled();
    expect(deps.createPostgresPool).not.toHaveBeenCalled();
});

test('disabled dashboard reads no Improvement configuration and creates no clients', () => {
    const deps = dependencies(), env = environment({ NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'false' });
    Object.defineProperty(env, 'NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED', { get() { throw new Error('unexpected read'); } });
    expect(createProductionDashboardConfiguration(env, deps)).toBeNull();
    expect(deps.ManagedIdentityCredential).not.toHaveBeenCalled();
    expect(deps.BlobServiceClient).not.toHaveBeenCalled();
    expect(deps.createPostgresPool).not.toHaveBeenCalled();
});
