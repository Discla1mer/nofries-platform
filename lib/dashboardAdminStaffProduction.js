'use strict';

// Environment-only staff console composition. Authority is the allowlisted
// staff admin's own workforce login plus the native operator session gate and
// restore epoch; no per-customer approval record, locator JSON or publication
// step is involved. Invalid settings log one safe line and leave administration
// off; they never stop the host. These settings grant nothing by themselves:
// the host still checks subject allowlist, admin role and the native gate.
const { isProxy } = require('node:util').types;
const { hash, uuid } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { normaliseCustomerAuthoritySource } = require('../api/shared/dashboardAdmin/customerAuthorityExpiry');

const ENABLED_SETTING = 'NOFRIES_DASHBOARD_ADMIN_ENABLED';
const SOURCES = Object.freeze([
    ['legacy_admin', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
    ['legacy_starter', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
    ['external_starter', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID']
]);
const COMMON = Object.freeze(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
    'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId']);
const fail = () => { throw new Error('dashboard_admin_staff_configuration_invalid'); };
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT = /^[a-z0-9]{3,24}$/;

function own(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
}
const container = value => { if (typeof value !== 'string' || !CONTAINER.test(value)) fail(); return value; };
const flag = (env, key) => {
    const value = own(env, key);
    if ([undefined, '', 'false'].includes(value)) return false;
    if (value !== 'true') fail();
    return true;
};

// Returns null while the console is off; throws for anything that is set but
// unusable. Only non-secret identifiers are read; nothing here opens storage.
function readStaffAdminSettings(env) {
    if (!flag(env, ENABLED_SETTING)) return null;
    const account = own(env, 'AZURE_STORAGE_ACCOUNT_NAME'), authAccount = own(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
    if (![account, authAccount].every(value => typeof value === 'string' && ACCOUNT.test(value)) || account === authAccount) fail();
    const reserved = [own(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth',
        own(env, 'NOFRIES_DASHBOARD_PROOF_CONTAINER'), own(env, 'NOFRIES_DASHBOARD_EPOCH_CONTAINER')].map(container);
    const sources = SOURCES.filter(([, setting]) => ![undefined, ''].includes(own(env, setting))).map(([kind, setting, tenantSetting]) => {
        const tenant = own(env, tenantSetting); uuid(tenant);
        return normaliseCustomerAuthoritySource({ schemaVersion: 1, kind, storageAccount: account, container: container(own(env, setting)),
            providerKind: kind === 'external_starter' ? 'external-id' : 'workforce-b2b', providerTenantId: tenant,
            providerConfigurationSha256: hash({ kind, tenant }) });
    });
    const names = sources.map(source => source.container);
    if (!names.length || new Set(names).size !== names.length || names.some(name => reserved.includes(name))) fail();
    const identityClientId = own(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
    if (identityClientId !== undefined && identityClientId !== '') uuid(identityClientId);
    return Object.freeze({ account, sources: Object.freeze(sources), identityClientId: identityClientId || null });
}

function blobService(settings, dependencies, retryOptions) {
    const dependency = (key, fallback) => {
        const value = Object.hasOwn(dependencies, key) ? own(dependencies, key) : fallback();
        if (typeof value !== 'function' || isProxy(value)) fail();
        return value;
    };
    const ManagedIdentityCredential = dependency('ManagedIdentityCredential', () => require('@azure/identity').ManagedIdentityCredential);
    const BlobServiceClient = dependency('BlobServiceClient', () => require('@azure/storage-blob').BlobServiceClient);
    const credential = settings.identityClientId ? new ManagedIdentityCredential({ clientId: settings.identityClientId }) : new ManagedIdentityCredential();
    return new BlobServiceClient(`https://${settings.account}.blob.core.windows.net`, credential, { retryOptions });
}

function compose(env, dashboard, dependencies) {
    const settings = readStaffAdminSettings(env);
    if (!settings) return {};
    if (!dashboard || typeof dashboard !== 'object' || isProxy(dashboard) || !dependencies || typeof dependencies !== 'object' || isProxy(dependencies)) fail();
    const common = Object.fromEntries(COMMON.map(key => [key, own(dashboard, key)]));
    const budget = own(dashboard, 'requestBudgetMs');
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000) fail();
    common.requestBudgetMs = Math.min(budget, 10000);
    const { createDashboardAdminRuntime } = require('../api/shared/dashboardAdmin/runtimeAdapter');
    const { createAccountLookupReader } = require('../api/shared/dashboardAdmin/accountLookupStore');
    // Lookup reads only; a single attempt keeps bounded scans within budget.
    const service = blobService(settings, dependencies, { maxTries: 1, tryTimeoutInMs: 4000 });
    const sources = settings.sources.map(source => ({ source, container: service.getContainerClient(source.container) }));
    return { dashboardAdmin: createDashboardAdminRuntime(common),
        dashboardAdminAccountLookup: createAccountLookupReader(sources, () => Date.parse(common.clock())) };
}

function createStaffDashboardAdministration(env, dashboard, dependencies = {}) {
    try { return Object.freeze(compose(env, dashboard, dependencies)); }
    catch (_) {
        try { console.warn('[dashboard-admin] dashboard_admin_configuration_invalid'); } catch (_) { /* no logging authority */ }
        return Object.freeze({});
    }
}

module.exports = { ENABLED_SETTING, readStaffAdminSettings, createStaffDashboardAdministration };
