'use strict';

// Settings-only staff console composition. The native runtime and account
// lookup reader are the real modules; only SDK constructors are substituted.
const { readStaffAdminSettings, createStaffDashboardAdministration, ENABLED_SETTING } = require('../lib/dashboardAdminStaffProduction');
const { createProductionDashboardAdministration } = require('../lib/dashboardAdminProduction');
const uid = n => '91000000-0000-4000-8000-' + String(n).padStart(12, '0');
const base = () => ({ [ENABLED_SETTING]: 'true', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
    NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs', NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs',
    NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(2),
    NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'legacy-signups',
    NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-signups' });
function sdk() {
    const clients = [], containers = [];
    return { clients, containers,
        ManagedIdentityCredential: jest.fn(function (options) { this.options = options; }),
        BlobServiceClient: class { constructor(url, credential, options) { clients.push({ url, credential, options }); }
            getContainerClient(name) { containers.push(name); return { getBlockBlobClient() { throw new Error('PRIVATE_UNEXPECTED_READ'); },
                listBlobsFlat() { throw new Error('PRIVATE_UNEXPECTED_SCAN'); } }; } } };
}
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const authEnv = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://staff-console.invalid', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(6),
    NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff-console-secret', NOFRIES_ALLOWED_SUBJECTS: uid(1) + ':' + uid(7), NOFRIES_ADMIN_SUBJECTS: uid(1) + ':' + uid(7) };
const dashboard = () => ({ browserAuthOptions: { env: authEnv, store: new MemoryBrowserSessionStore() },
    identityPolicy: { policyId: 'synthetic-policy', policyRevision: 1, issuer: 'https://login.microsoftonline.com/' + uid(1) + '/v2.0', identityTenantId: uid(1), audience: uid(6) },
    proofStore: { createOriginalProof: async () => {}, readOriginalProof: async () => null }, clock: () => '2026-11-10T00:00:00.000Z',
    readExternalRuntimeEpoch: async () => ({}), newRequestId: () => uid(3), requestBudgetMs: 30000,
    pool: { connect: async () => { throw new Error('PRIVATE_UNEXPECTED_SQL'); }, end: async () => {} }, instanceId: uid(4),
    historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 }, newId: () => uid(5) });
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/synthetic|PRIVATE|@/); warning.mockRestore(); });

test.each([undefined, '', 'false'])('flag %p leaves the console off without reading any other setting', value => {
    const env = base(); env[ENABLED_SETTING] = value;
    Object.defineProperty(env, 'AZURE_STORAGE_ACCOUNT_NAME', { get() { throw new Error('PRIVATE_GETTER'); } });
    expect(readStaffAdminSettings(env)).toBeNull();
    expect(createStaffDashboardAdministration(env, null, {})).toEqual({}); expect(warning).not.toHaveBeenCalled();
});
test('settings select every configured authority source and the managed identity without opening storage', () => {
    const settings = readStaffAdminSettings({ ...base(), NOFRIES_MANAGED_IDENTITY_CLIENT_ID: uid(9) });
    expect(settings.sources.map(source => [source.kind, source.container, source.providerTenantId])).toEqual([
        ['legacy_admin', 'customer-authority', uid(1)], ['legacy_starter', 'legacy-signups', uid(1)], ['external_starter', 'external-signups', uid(2)]]);
    expect(settings).toMatchObject({ account: 'syntheticdata', identityClientId: uid(9) });
    const partial = readStaffAdminSettings({ ...base(), NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: '' });
    expect(partial.sources.map(source => source.kind)).toEqual(['legacy_admin', 'legacy_starter']); expect(partial.identityClientId).toBeNull();
});
test.each([['TRUE', ENABLED_SETTING], ['1', ENABLED_SETTING], ['Synthetic', 'AZURE_STORAGE_ACCOUNT_NAME'], ['syntheticauth', 'AZURE_STORAGE_ACCOUNT_NAME'],
    ['bad-tenant', 'NOFRIES_ENTRA_TENANT_ID'], ['../x', 'NOFRIES_STARTER_AUTHORITY_CONTAINER'], ['legacy-signups', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER'],
    ['dashboard-proofs', 'NOFRIES_STARTER_AUTHORITY_CONTAINER'], ['nofries-browser-auth', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER'],
    ['not-a-guid', 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID']])('invalid value %p for %s fails closed and logs one safe line', (value, key) => {
    const env = { ...base(), [key]: value }, dependencies = sdk();
    expect(() => readStaffAdminSettings(env)).toThrow();
    expect(createStaffDashboardAdministration(env, dashboard(), dependencies)).toEqual({});
    expect(warning.mock.calls).toEqual([['[dashboard-admin] dashboard_admin_configuration_invalid']]);
    expect(dependencies.clients).toEqual([]);
});
test('no configured source, an accessor setting or a missing native dashboard leave administration off', () => {
    const none = { ...base(), NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: '', NOFRIES_STARTER_AUTHORITY_CONTAINER: '', NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: '' };
    expect(() => readStaffAdminSettings(none)).toThrow();
    const getter = base(); Object.defineProperty(getter, 'NOFRIES_STARTER_AUTHORITY_CONTAINER', { get() { return 'legacy-signups'; } });
    expect(() => readStaffAdminSettings(getter)).toThrow();
    expect(createStaffDashboardAdministration(base(), null, sdk())).toEqual({});
    expect(createStaffDashboardAdministration(base(), { ...dashboard(), requestBudgetMs: 0 }, sdk())).toEqual({});
    expect(warning).toHaveBeenCalledTimes(2);
});
test('composition builds the staff runtime and bounded lookup reader with one-attempt managed-identity clients', () => {
    const dependencies = sdk(), env = { ...base(), NOFRIES_MANAGED_IDENTITY_CLIENT_ID: uid(9) };
    const ports = createStaffDashboardAdministration(env, dashboard(), dependencies);
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountLookup']);
    expect(ports.dashboardAdmin.authoriseOperator).toEqual(expect.any(Function)); expect(ports.dashboardAdmin.requestBudgetMs).toBe(10000);
    expect(ports.dashboardAdminAccountLookup).toEqual(expect.any(Function));
    expect(dependencies.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: uid(9) });
    expect(dependencies.clients).toEqual([{ url: 'https://syntheticdata.blob.core.windows.net', credential: expect.any(Object), options: { retryOptions: { maxTries: 1, tryTimeoutInMs: 4000 } } }]);
    expect(dependencies.containers).toEqual(['customer-authority', 'legacy-signups', 'external-signups']);
    expect(warning).not.toHaveBeenCalled();
    const system = sdk(); createStaffDashboardAdministration(base(), dashboard(), system);
    expect(system.ManagedIdentityCredential).toHaveBeenCalledWith();
});
test.each(['ManagedIdentityCredential', 'BlobServiceClient'])('a broken %s dependency disables administration instead of failing startup', key => {
    const dependencies = { ...sdk(), [key]: class { constructor() { throw new Error('PRIVATE_SDK'); } } };
    expect(createStaffDashboardAdministration(base(), dashboard(), dependencies)).toEqual({});
    expect(warning).toHaveBeenCalledTimes(1);
});
test('the launcher composition prefers the staff console over a legacy listing locator and never requires one', () => {
    const dependencies = sdk();
    const ports = createProductionDashboardAdministration(base(), dashboard(), dependencies, null);
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountLookup']);
    const trusted = createProductionDashboardAdministration(base(), dashboard(), { ...dependencies, dashboardAdministration: null }, null);
    expect(trusted).toEqual({});
});
