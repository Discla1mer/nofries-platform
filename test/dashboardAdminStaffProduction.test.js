'use strict';

// Settings-only staff console composition. The native runtime and account
// lookup reader are the real modules; only SDK constructors are substituted.
const { readStaffAdminSettings, createStaffDashboardAdministration, STAFF_CONSOLE_SETTING: ENABLED_SETTING } = require('../lib/dashboardAdminStaffProduction');
const { Readable } = require('node:stream');
const { createProductionDashboardAdministration } = require('../lib/dashboardAdminProduction');
const uid = n => '91000000-0000-4000-8000-' + String(n).padStart(12, '0');
const base = () => ({ [ENABLED_SETTING]: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', NOFRIES_SCOPE_SIGNING_SECRET: 'k'.repeat(32), AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
    NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs', NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs',
    NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER: 'admin-audit', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(2),
    NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'legacy-signups',
    NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-signups' });
function sdk() {
    const clients = [], containers = [], writes = [];
    return { clients, containers, writes,
        ManagedIdentityCredential: jest.fn(function (options) { this.options = options; }),
        BlobServiceClient: class { constructor(url, credential, options) { clients.push({ url, credential, options }); }
            getContainerClient(name) { containers.push(name); return { getBlockBlobClient(key) { return {
                download() { throw new Error('PRIVATE_UNEXPECTED_READ'); },
                async uploadData(bytes, options) { writes.push({ name, key, record: JSON.parse(bytes.toString()), conditions: options.conditions }); return { etag: '"w"' }; } }; },
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
test.each([undefined, '', 'false'])('lookup flag %p keeps the whole console off even with the console flag on', value => {
    const env = { ...base(), NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: value };
    expect(readStaffAdminSettings(env)).toBeNull();
    expect(createStaffDashboardAdministration(env, dashboard(), sdk())).toEqual({}); expect(warning).not.toHaveBeenCalled();
});
test('the audit target digest is an HMAC under a derived key, not a plain or prefixed hash of the email', () => {
    const crypto = require('node:crypto'), email = 'someone@example.invalid';
    const digest = readStaffAdminSettings(base()).targetDigest(email);
    expect(digest).toMatch(/^[0-9a-f]{64}$/); expect(digest).toBe(readStaffAdminSettings(base()).targetDigest(email));
    expect(digest).not.toBe(crypto.createHash('sha256').update(email).digest('hex'));
    expect(digest).not.toBe(crypto.createHash('sha256').update('nofries:dashboard-admin-account-lookup:v1\0' + email).digest('hex'));
    expect(digest).not.toBe(crypto.createHmac('sha256', 'k'.repeat(32)).update(email).digest('hex'));
    expect(readStaffAdminSettings({ ...base(), NOFRIES_SCOPE_SIGNING_SECRET: 'z'.repeat(32) }).targetDigest(email)).not.toBe(digest);
    expect(JSON.stringify(readStaffAdminSettings(base()))).not.toContain('kkkk');
});
test('settings select every configured authority source and the managed identity without opening storage', () => {
    const settings = readStaffAdminSettings({ ...base(), NOFRIES_MANAGED_IDENTITY_CLIENT_ID: uid(9) });
    expect(settings.sources.map(source => [source.kind, source.container, source.providerTenantId])).toEqual([
        ['legacy_admin', 'customer-authority', uid(1)], ['legacy_starter', 'legacy-signups', uid(1)], ['external_starter', 'external-signups', uid(2)]]);
    expect(settings).toMatchObject({ account: 'syntheticdata', identityClientId: uid(9), auditContainer: 'admin-audit' });
    const partial = readStaffAdminSettings({ ...base(), NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: '' });
    expect(partial.sources.map(source => source.kind)).toEqual(['legacy_admin', 'legacy_starter']); expect(partial.identityClientId).toBeNull();
});
test.each([['TRUE', ENABLED_SETTING], ['1', ENABLED_SETTING], ['Synthetic', 'AZURE_STORAGE_ACCOUNT_NAME'], ['syntheticauth', 'AZURE_STORAGE_ACCOUNT_NAME'],
    ['bad-tenant', 'NOFRIES_ENTRA_TENANT_ID'], ['../x', 'NOFRIES_STARTER_AUTHORITY_CONTAINER'], ['legacy-signups', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER'],
    ['dashboard-proofs', 'NOFRIES_STARTER_AUTHORITY_CONTAINER'], ['nofries-browser-auth', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER'],
    ['admin-audit', 'NOFRIES_STARTER_AUTHORITY_CONTAINER'], ['', 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER'], ['legacy-signups', 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER'],
    ['dashboard-proofs', 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER'], ['nofries-browser-auth', 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER'],
    ['TRUE', 'NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP'], ['short', 'NOFRIES_SCOPE_SIGNING_SECRET'], ['not-a-guid', 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID']])('invalid value %p for %s fails closed and logs one safe line', (value, key) => {
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
    // A legacy listing locator's approval container can never be a customer source.
    const locator = JSON.stringify({ schemaVersion: 1, provider: 'legacy', authorityContainer: 'legacy-signups', populationId: 'p', indexId: 'i', writerContract: 'all_application_account_writes_v2' });
    expect(() => readStaffAdminSettings({ ...base(), NOFRIES_DASHBOARD_ADMIN_BINDING: locator })).toThrow();
    expect(readStaffAdminSettings({ ...base(), NOFRIES_DASHBOARD_ADMIN_BINDING: locator.replace('legacy-signups', 'private-approvals') })).toBeTruthy();
    // An unusable locator names no approval container and does not switch the console off.
    expect(readStaffAdminSettings({ ...base(), NOFRIES_DASHBOARD_ADMIN_BINDING: '{' })).toBeTruthy();
    expect(createStaffDashboardAdministration(base(), null, sdk())).toEqual({});
    expect(createStaffDashboardAdministration(base(), { ...dashboard(), requestBudgetMs: 0 }, sdk())).toEqual({});
    expect(warning).toHaveBeenCalledTimes(2);
});
test('composition builds the staff runtime and bounded lookup reader with one-attempt managed-identity clients', () => {
    const dependencies = sdk(), env = { ...base(), NOFRIES_MANAGED_IDENTITY_CLIENT_ID: uid(9) };
    const ports = createStaffDashboardAdministration(env, dashboard(), dependencies);
    expect(Object.keys(ports).sort()).toEqual(['dashboardAdmin', 'dashboardAdminAccountLookup']);
    expect(ports.dashboardAdmin.authoriseOperator).toEqual(expect.any(Function)); expect(ports.dashboardAdmin.requestBudgetMs).toBe(10000);
    expect(ports.dashboardAdminAccountLookup.read).toEqual(expect.any(Function));
    expect(dependencies.ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: uid(9) });
    expect(dependencies.clients).toEqual([{ url: 'https://syntheticdata.blob.core.windows.net', credential: expect.any(Object), options: { retryOptions: { maxTries: 1, tryTimeoutInMs: 4000 } } }]);
    expect(dependencies.containers).toEqual(['customer-authority', 'legacy-signups', 'external-signups', 'admin-audit']);
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

test('the lookup audit writer stores one create-only digest-only record per request and fails closed', async () => {
    const dependencies = sdk(), { audit } = createStaffDashboardAdministration(base(), dashboard(), dependencies).dashboardAdminAccountLookup;
    const event = { category: 'dashboard_admin_account_lookup', requestId: '12345678-1234-4123-8123-123456789abc', actorSha256: 'a'.repeat(64), targetSha256: 'b'.repeat(64),
        status: 200, count: 2, truncated: false, occurredAt: '2026-11-10T00:00:00.000Z', email: 'leak@example.invalid', rows: [{ email: 'leak@example.invalid' }] };
    await audit(event);
    expect(dependencies.writes).toEqual([{ name: 'admin-audit', key: 'dashboard-admin-account-lookups/12345678-1234-4123-8123-123456789abc.json', conditions: { ifNoneMatch: '*' },
        record: { schemaVersion: 1, category: 'dashboard_admin_account_lookup', requestId: event.requestId, actorSha256: event.actorSha256, targetSha256: event.targetSha256,
            status: 200, count: 2, truncated: false, occurredAt: event.occurredAt } }]);
    await expect(audit({ ...event, requestId: 'not-a-request-id' })).rejects.toThrow();
    const failing = sdk(); failing.BlobServiceClient = class extends failing.BlobServiceClient {
        getContainerClient(name) { return { getBlockBlobClient() { return { async uploadData() { throw Object.assign(new Error('PRIVATE_CONFLICT'), { statusCode: 412 }); } }; } }; } };
    await expect(createStaffDashboardAdministration(base(), dashboard(), failing).dashboardAdminAccountLookup.audit(event)).rejects.toThrow();
});
