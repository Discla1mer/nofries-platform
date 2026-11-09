'use strict';
const { isProxy } = require('node:util').types;
const { hash, uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseCustomerAuthoritySource } = require('./customerAuthorityExpiry');
const fail = () => { throw new Error('dashboard_admin_configuration_invalid'); };
function own(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (item && !Object.hasOwn(item, 'value')) fail();
    return item?.value;
}
const name = value => { if (typeof value !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) fail(); return value; };

// Invalid optional actions never take down listing or application startup.
// These locators supply no grant: scoped protected approvals remain mandatory.
function createBoundAccountActions(env, dashboard, dependencies, opened) {
    try {
        if (own(env, 'NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS') !== 'true') return {};
        const account = own(env, 'AZURE_STORAGE_ACCOUNT_NAME'), authAccount = own(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
        if (![account, authAccount].every(value => typeof value === 'string' && /^[a-z0-9]{3,24}$/.test(value)) || account === authAccount) fail();
        const specs = [
            ['legacy_admin', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
            ['legacy_starter', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
            ['external_starter', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID']
        ];
        const sources = specs.map(([kind, setting, tenantSetting]) => {
            const tenant = own(env, tenantSetting); uuid(tenant);
            return normaliseCustomerAuthoritySource({ schemaVersion: 1, kind, storageAccount: account, container: name(own(env, setting)),
                providerKind: kind === 'external_starter' ? 'external-id' : 'workforce-b2b', providerTenantId: tenant,
                providerConfigurationSha256: hash({ kind, tenant }) });
        });
        const reserved = [name(own(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth'),
            name(own(env, 'NOFRIES_DASHBOARD_PROOF_CONTAINER')), name(own(env, 'NOFRIES_DASHBOARD_EPOCH_CONTAINER')),
            name(opened.binding.authorityContainer)];
        const auditName = name(own(env, 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER'));
        const authorityNames = sources.map(source => source.container);
        if (new Set(authorityNames).size !== 3 || authorityNames.some(value => reserved.includes(value)) ||
            [...authorityNames, ...reserved].includes(auditName)) fail();
        const identity = own(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
        if (identity !== undefined && identity !== '') uuid(identity);
        const Credential = Object.hasOwn(dependencies, 'ManagedIdentityCredential') ? own(dependencies, 'ManagedIdentityCredential') : require('@azure/identity').ManagedIdentityCredential;
        const Service = Object.hasOwn(dependencies, 'BlobServiceClient') ? own(dependencies, 'BlobServiceClient') : require('@azure/storage-blob').BlobServiceClient;
        if ([Credential, Service].some(value => typeof value !== 'function' || isProxy(value))) fail();
        const credential = identity ? new Credential({ clientId: identity }) : new Credential();
        const service = new Service(`https://${account}.blob.core.windows.net`, credential, { retryOptions: { maxTries: 1, tryTimeoutInMs: 4000 } });
        const configuration = { sources: sources.map(source => ({ source, authorityContainer: service.getContainerClient(source.container) })),
            auditContainer: service.getContainerClient(auditName), auditPolicy: { reference: 'dashboard-admin-account-actions', revision: 1,
                agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
        const { createDashboardAdminApprovalReader } = require('./approvalStore');
        const approval = createDashboardAdminApprovalReader({ authorityContainer: service.getContainerClient(opened.binding.authorityContainer),
            ...Object.fromEntries(['instanceId', 'clock', 'readExternalRuntimeEpoch', 'requestBudgetMs'].map(key => [key, opened.common[key]])) });
        const dashboardAdmin = require('./runtimeAdapter').createDashboardAdminRuntime({ ...opened.common, readApprovedBinding: approval.readApprovedBinding });
        // Validate construction now, so no malformed optional runtime reaches the host.
        require('./accountActionsRuntime').createAccountActionsRuntime(configuration, dashboard, async () => fail());
        return { dashboardAdmin, dashboardAdminAccountActions: configuration };
    } catch (_) {
        try { console.warn('[dashboard-admin-account-actions] dashboard_admin_unavailable'); } catch (_) { /* no logging authority */ }
        return {};
    }
}
module.exports = { createBoundAccountActions };
