'use strict';

const { isProxy } = require('node:util').types;

const fail = () => { throw new Error('dashboard_admin_production_configuration_invalid'); };
const fn = value => typeof value === 'function' && !isProxy(value);
function object(value) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
    return value;
}
function ownValue(value, key) {
    object(value);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
}
function container(value) {
    if (typeof value !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) fail();
    return value;
}

// A trusted composition input, never an environment flag or request parameter.
// This function creates no approved operator, population, grant, SQL schema or
// remote object. The ordinary launcher may select explicitly configured private
// stores, whose current records must independently establish administration.
function createProductionDashboardAdministration(env, dashboard, dependencies = {}, externalConfiguration = null) {
    try {
        object(dependencies);
        const descriptor = Object.getOwnPropertyDescriptor(dependencies, 'dashboardAdministration');
        if (!descriptor) return require('./dashboardAdminBindings').createBoundDashboardAdministration(env, dashboard, dependencies, externalConfiguration);
        if (!Object.hasOwn(descriptor, 'value')) fail();
        const selected = descriptor.value;
        if (selected === null) return Object.freeze({});
        const { copy, fields, freeze, equal, uuid } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
        const configuration = fields(selected, ['lookup', 'signupList']);
        if (configuration.lookup === null && configuration.signupList === null) return Object.freeze({});
        const lookup = configuration.lookup === null ? null : fields(configuration.lookup, ['readApprovedBinding']);
        const signup = configuration.signupList === null ? null : fields(configuration.signupList,
            ['manifest', 'sourceReferences', 'readApprovedAuthority', 'resolvePopulationBinding']);
        if (lookup && !fn(lookup.readApprovedBinding) || signup &&
            ![signup.readApprovedAuthority, signup.resolvePopulationBinding].every(fn)) fail();
        const common = Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock',
            'readExternalRuntimeEpoch', 'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId']
            .map(key => [key, ownValue(dashboard, key)]));
        const budget = ownValue(dashboard, 'requestBudgetMs');
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000) fail();
        common.requestBudgetMs = Math.min(budget, 10000);
        const result = {};
        if (lookup) {
            const { createDashboardAdminRuntime } = require('../api/shared/dashboardAdmin/runtimeAdapter');
            result.dashboardAdmin = createDashboardAdminRuntime({ ...common, readApprovedBinding: lookup.readApprovedBinding });
        }
        if (signup) {
            const { normaliseSignupManifest } = require('../api/shared/dashboardAdmin/signupAuthority');
            const { createSignupDataAdapter } = require('../api/shared/dashboardAdmin/signupDataAdapter');
            const { createFiniteSignupPageReader } = require('../api/shared/dashboardAdmin/finiteSignupIndex');
            const { createDashboardAdminSignupRuntime } = require('../api/shared/dashboardAdmin/signupAuditRuntimeAdapter');
            const manifest = normaliseSignupManifest(signup.manifest);
            const sourceReferences = freeze(copy(signup.sourceReferences, 262144));
            if (!Array.isArray(sourceReferences) || sourceReferences.length !== manifest.entries.length) fail();
            const references = new Map(sourceReferences.map(reference => {
                fields(reference, ['entry', 'accountKey']);
                return [reference.entry?.recordId, reference];
            }));
            if (references.size !== manifest.entries.length || manifest.entries.some(entry => !equal(references.get(entry.recordId)?.entry, entry))) fail();

            // Existing adapter validation runs before SDK construction. Only
            // these exact load functions are later bound; stores' writers and
            // container enumeration are never exposed to the administration.
            let loadAccount, loadSetup;
            const readEntrySummary = createSignupDataAdapter({ provider: manifest.provider, sourceReferences, clock: common.clock,
                accountStore: Object.freeze({ load(key) { if (!loadAccount) fail(); return loadAccount(key); } }),
                setupStore: Object.freeze({ load(key) { if (!loadSetup) fail(); return loadSetup(key); } }) });
            const readSignupPage = createFiniteSignupPageReader({ manifest, readEntrySummary, clock: common.clock,
                resolvePopulationBinding: signup.resolvePopulationBinding, requestBudgetMs: common.requestBudgetMs });
            result.dashboardAdminSignupList = createDashboardAdminSignupRuntime({ ...common, readSignupPage,
                readApprovedAuthority: signup.readApprovedAuthority, resolvePopulationBinding: signup.resolvePopulationBinding });

            const account = ownValue(env, 'AZURE_STORAGE_ACCOUNT_NAME');
            const authAccount = ownValue(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
            if (![account, authAccount].every(value => typeof value === 'string' && /^[a-z0-9]{3,24}$/.test(value)) || account === authAccount) fail();
            const legacyName = ownValue(env, 'NOFRIES_STARTER_AUTHORITY_CONTAINER');
            const environmentExternalName = ownValue(env, 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER');
            let externalName;
            if (externalConfiguration !== null) externalName = ownValue(externalConfiguration, 'starterAuthorityContainer');
            if (manifest.provider === 'external') {
                // ProductionApplication has already selected and validated this
                // external composition. Revalidate its non-secret identity and
                // container linkage without reading client credentials.
                fields(externalConfiguration, ['identityProvider', 'identityPolicy', 'client', 'starterAuthorityContainer',
                    'userFlowId', 'allowNewSignup', ...(Object.hasOwn(externalConfiguration, 'trial') ? ['trial'] : [])]);
                const { createCustomerIdentityProviderProfile } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
                const profile = createCustomerIdentityProviderProfile(copy(externalConfiguration.identityProvider, 16384),
                    { tenantId: common.identityPolicy.identityTenantId, clientId: common.identityPolicy.audience });
                const policy = fields(copy(externalConfiguration.identityPolicy, 16384),
                    ['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'audience']);
                if (profile.kind !== 'external-id' || profile.issuer !== policy.issuer || profile.tenantId !== policy.identityTenantId ||
                    profile.clientId !== policy.audience || typeof policy.policyId !== 'string' || !policy.policyId ||
                    !Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 0 || typeof externalConfiguration.allowNewSignup !== 'boolean') fail();
            }
            const name = container(manifest.provider === 'legacy' ? legacyName : externalName);
            const forbidden = [ownValue(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth',
                ownValue(env, 'NOFRIES_DASHBOARD_PROOF_CONTAINER'), ownValue(env, 'NOFRIES_DASHBOARD_EPOCH_CONTAINER'),
                ownValue(env, 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER'),
                ...(manifest.provider === 'legacy' ? [externalName, environmentExternalName] : [legacyName])];
            if (forbidden.includes(name)) fail();
            const identityClientId = ownValue(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
            if (identityClientId !== undefined && identityClientId !== '') uuid(identityClientId);
            const ManagedIdentityCredential = Object.hasOwn(dependencies, 'ManagedIdentityCredential')
                ? ownValue(dependencies, 'ManagedIdentityCredential') : require('@azure/identity').ManagedIdentityCredential;
            const BlobServiceClient = Object.hasOwn(dependencies, 'BlobServiceClient')
                ? ownValue(dependencies, 'BlobServiceClient') : require('@azure/storage-blob').BlobServiceClient;
            if (![ManagedIdentityCredential, BlobServiceClient].every(fn)) fail();
            const credential = identityClientId ? new ManagedIdentityCredential({ clientId: identityClientId }) : new ManagedIdentityCredential();
            const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
                { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
            const source = service.getContainerClient(name);
            const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
            const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
            const accounts = new AzureStarterAccountStore(source), setups = new AzureStarterSetupStore(source);
            loadAccount = accounts.load.bind(accounts); loadSetup = setups.load.bind(setups);
        }
        return Object.freeze(result);
    } catch (_) { fail(); }
}

module.exports = { createProductionDashboardAdministration };
