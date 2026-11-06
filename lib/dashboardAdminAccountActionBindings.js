'use strict';

const { isProxy } = require('node:util').types;
const { fields, copy, uuid } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const SETTING = 'NOFRIES_DASHBOARD_ADMIN_ACTION_BINDING';
const fail = () => { throw new Error('dashboard_admin_account_actions_configuration_invalid'); };
function own(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value)) fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && !Object.hasOwn(d, 'value')) fail();
    return d?.value;
}
function bindProductionAccountActions(env, dependencies) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(env, SETTING);
    if (!descriptor) return null;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    const raw = descriptor.value;
    if (raw === undefined || raw === '') return null;
    if (isProxy(env)) fail();
    try {
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048) fail();
        const binding = fields(copy(JSON.parse(raw), 2048), ['schemaVersion', 'authorityContainer', 'stateContainer']);
        if (binding.schemaVersion !== 1) fail();
        const names = [binding.authorityContainer, binding.stateContainer];
        const forbidden = ['NOFRIES_BROWSER_AUTH_CONTAINER', 'NOFRIES_DASHBOARD_PROOF_CONTAINER',
            'NOFRIES_DASHBOARD_EPOCH_CONTAINER', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER',
            'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER'].map(key => own(env, key));
        forbidden.push('nofries-browser-auth');
        if (names[0] === names[1] || names.some(name => typeof name !== 'string' ||
            !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) || forbidden.includes(name))) fail();
        const account = own(env, 'AZURE_STORAGE_ACCOUNT_NAME'), auth = own(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
        if (![account, auth].every(v => typeof v === 'string' && /^[a-z0-9]{3,24}$/.test(v)) || account === auth) fail();
        const ManagedIdentityCredential = own(dependencies, 'ManagedIdentityCredential') || require('@azure/identity').ManagedIdentityCredential;
        const BlobServiceClient = own(dependencies, 'BlobServiceClient') || require('@azure/storage-blob').BlobServiceClient;
        if ([ManagedIdentityCredential, BlobServiceClient].some(v => typeof v !== 'function' || isProxy(v))) fail();
        const identity = own(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
        if (identity !== undefined && identity !== '') uuid(identity);
        const credential = identity ? new ManagedIdentityCredential({ clientId: identity }) : new ManagedIdentityCredential();
        const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
            { retryOptions: { maxTries: 1, tryTimeoutInMs: 4000 } });
        const { createAccountActionBindingReader } = require('../api/shared/dashboardAdmin/accountActionBindingStore');
        const { AzureAccountActionConfirmationStore } = require('../api/shared/dashboardAdmin/azureAccountActionConfirmationStore');
        return dashboard => ({ readApprovedActionBinding: createAccountActionBindingReader({
            container: service.getContainerClient(binding.authorityContainer), clock: own(dashboard, 'clock') }),
        confirmationStore: new AzureAccountActionConfirmationStore(service.getContainerClient(binding.stateContainer)) });
    } catch (_) { fail(); }
}
module.exports = { SETTING, bindProductionAccountActions };
