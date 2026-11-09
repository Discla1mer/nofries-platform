'use strict';

const { createDashboardAdminApprovalReader } = require('../api/shared/dashboardAdmin/approvalStore');
const { uuid } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { isProxy } = require('node:util').types;

// This locator selects a reader, never an approval or a signup writer/index.
function createEnvironmentLookupReader(env, dashboard, dependencies) {
    const own = key => {
        const descriptor = Object.getOwnPropertyDescriptor(env, key);
        if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new Error();
        return descriptor?.value;
    };
    const name = own('NOFRIES_DASHBOARD_ADMIN_LOOKUP_AUTHORITY_CONTAINER');
    if (name === undefined || name === '') return null;
    const enabled = own('NOFRIES_DASHBOARD_ADMIN_ENABLED');
    if ([undefined, '', 'false'].includes(enabled)) return null;
    if (isProxy(env) || isProxy(dependencies)) throw new Error();
    if (enabled !== 'true' || typeof name !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error();
    const account = own('AZURE_STORAGE_ACCOUNT_NAME'), auth = own('NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
    if (![account, auth].every(value => typeof value === 'string' && /^[a-z0-9]{3,24}$/.test(value)) || account === auth ||
        ['NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER',
            'NOFRIES_DASHBOARD_PROOF_CONTAINER', 'NOFRIES_DASHBOARD_EPOCH_CONTAINER'].some(key => name === own(key)) ||
        name === (own('NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth')) throw new Error();
    const clientId = own('NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
    if (clientId !== undefined && clientId !== '') uuid(clientId);
    const dependency = (key, fallback) => {
        const descriptor = Object.getOwnPropertyDescriptor(dependencies, key);
        if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || isProxy(descriptor.value))) throw new Error();
        return descriptor ? descriptor.value : fallback();
    };
    const ManagedIdentityCredential = dependency('ManagedIdentityCredential', () => require('@azure/identity').ManagedIdentityCredential);
    const BlobServiceClient = dependency('BlobServiceClient', () => require('@azure/storage-blob').BlobServiceClient);
    const credential = clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
    return createDashboardAdminApprovalReader({ authorityContainer: service.getContainerClient(name),
        instanceId: dashboard.instanceId, clock: dashboard.clock, readExternalRuntimeEpoch: dashboard.readExternalRuntimeEpoch,
        requestBudgetMs: Math.min(dashboard.requestBudgetMs, 10000) });
}

module.exports = { createEnvironmentLookupReader };
