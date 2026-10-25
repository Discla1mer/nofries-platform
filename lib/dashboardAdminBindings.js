'use strict';

// Locators select existing private stores. They contain no operator, grant or
// population members. Current protected records alone authorise disclosure.
const { types: { isProxy } } = require('node:util');
const { fields, copy, freeze, id, uuid, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const WRITER_CONTRACT = 'all_application_account_writes_v2';
const SETTING = 'NOFRIES_DASHBOARD_ADMIN_BINDING';
const ENABLED_SETTING = 'NOFRIES_DASHBOARD_ADMIN_ENABLED';
const fail = () => { throw new Error('dashboard_admin_production_configuration_invalid'); };
function own(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
}
function container(value) {
    if (typeof value !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) fail();
    return value;
}
function readDashboardAdminBinding(env) {
    try {
        // An unselected binding stays inert for guarded host environments too.
        // Inspect only this descriptor; never execute a selector getter. A
        // proxy can suppress administration, but cannot supply its authority.
        if (!env || typeof env !== 'object' || Array.isArray(env)) fail();
        const descriptor = Object.getOwnPropertyDescriptor(env, SETTING);
        if (!descriptor) return null;
        if (!Object.hasOwn(descriptor, 'value')) fail();
        const raw = descriptor.value;
        if (raw === undefined || raw === '') return null;
        if (isProxy(env)) fail();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048) fail();
        const value = fields(copy(JSON.parse(raw), 2048), ['schemaVersion', 'provider', 'authorityContainer',
            'populationId', 'indexId', 'writerContract']);
        if (value.schemaVersion !== 1 || !['legacy', 'external'].includes(value.provider) || value.writerContract !== WRITER_CONTRACT) fail();
        container(value.authorityContainer); id(value.populationId); id(value.indexId);
        return freeze(value);
    } catch (_) { fail(); }
}
function sourceBinding(env, binding, sourceName) {
    const account = own(env, 'AZURE_STORAGE_ACCOUNT_NAME'), auth = own(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
    if (![account, auth].every(v => typeof v === 'string' && /^[a-z0-9]{3,24}$/.test(v)) || account === auth) fail();
    container(sourceName);
    const forbidden = [own(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth',
        own(env, 'NOFRIES_DASHBOARD_PROOF_CONTAINER'), own(env, 'NOFRIES_DASHBOARD_EPOCH_CONTAINER')];
    if (forbidden.includes(sourceName) || forbidden.includes(binding.authorityContainer) ||
        sourceName === binding.authorityContainer || sourceName === own(env, 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER')) fail();
    return { account, sourceBindingSha256: hash({ provider: binding.provider, storageAccount: account,
        sourceContainer: sourceName, writerContract: WRITER_CONTRACT }) };
}
function indexOptions(env, dashboard, binding, sourceName, source, accountStore) {
    const { sourceBindingSha256 } = sourceBinding(env, binding, sourceName);
    const { createSignupIndexMaintenance } = require('../api/shared/dashboardAdmin/signupIndexMaintenance');
    return createSignupIndexMaintenance({ container: source, accountStore, provider: binding.provider,
        populationId: binding.populationId, indexId: binding.indexId, sourceBindingSha256,
        writerContract: WRITER_CONTRACT, instanceId: own(dashboard, 'instanceId'),
        readExternalRuntimeEpoch: own(dashboard, 'readExternalRuntimeEpoch'), clock: own(dashboard, 'clock'),
        newId: own(dashboard, 'newId') });
}

// Used at the existing shared legacy/external account-store construction site.
// Absence returns the identical store; no index I/O or additional SDK occurs.
function wrapDashboardAdminAccountStore({ env, dashboard, provider, sourceName, source, accountStore }) {
    const binding = readDashboardAdminBinding(env);
    if (!binding || binding.provider !== provider) return accountStore;
    const tracked = indexOptions(env, dashboard, binding, sourceName, source, accountStore).accountStore;
    // The index journals account mutations; bounded client reads still use the
    // original store and its receiver. Do not expose any additional writer port.
    return Object.freeze({ ...tracked, ...Object.fromEntries(
        ['loadClient', 'listClients', 'loadClientByBinding']
            .filter(method => typeof accountStore[method] === 'function')
            .map(method => [method, (...args) => accountStore[method](...args)])) });
}

function openBindings(env, dashboard, dependencies, externalConfiguration) {
    const binding = readDashboardAdminBinding(env);
    if (!binding) return null;
    try {
        const sourceName = binding.provider === 'external'
            ? own(externalConfiguration, 'starterAuthorityContainer') : own(env, 'NOFRIES_STARTER_AUTHORITY_CONTAINER');
        const { account, sourceBindingSha256 } = sourceBinding(env, binding, sourceName);
        if (binding.provider === 'legacy' && sourceName === own(env, 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER') ||
            binding.provider === 'external' && sourceName === own(env, 'NOFRIES_STARTER_AUTHORITY_CONTAINER')) fail();
        const common = Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock',
            'readExternalRuntimeEpoch', 'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId']
            .map(key => [key, own(dashboard, key)]));
        const budget = own(dashboard, 'requestBudgetMs');
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000) fail();
        common.requestBudgetMs = Math.min(budget, 10000);
        const ManagedIdentityCredential = Object.hasOwn(dependencies, 'ManagedIdentityCredential')
            ? own(dependencies, 'ManagedIdentityCredential') : require('@azure/identity').ManagedIdentityCredential;
        const BlobServiceClient = Object.hasOwn(dependencies, 'BlobServiceClient')
            ? own(dependencies, 'BlobServiceClient') : require('@azure/storage-blob').BlobServiceClient;
        if (![ManagedIdentityCredential, BlobServiceClient].every(value => typeof value === 'function' && !isProxy(value))) fail();
        const identity = own(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
        if (identity !== undefined && identity !== '') uuid(identity);
        const credential = identity ? new ManagedIdentityCredential({ clientId: identity }) : new ManagedIdentityCredential();
        const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
            { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
        const source = service.getContainerClient(sourceName);
        const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
        const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
        const accountStore = new AzureStarterAccountStore(source), setupStore = new AzureStarterSetupStore(source);
        const index = indexOptions(env, dashboard, binding, sourceName, source, accountStore);
        return { binding, common, sourceBindingSha256, index, accountStore, setupStore,
            authorityContainer: service.getContainerClient(binding.authorityContainer) };
    } catch (_) { fail(); }
}
function approvalOptions(opened) {
    const { binding, common, sourceBindingSha256, authorityContainer } = opened;
    return { authorityContainer, instanceId: common.instanceId, clock: common.clock,
        readExternalRuntimeEpoch: common.readExternalRuntimeEpoch, requestBudgetMs: common.requestBudgetMs,
        provider: binding.provider, populationId: binding.populationId, indexId: binding.indexId, sourceBindingSha256 };
}
function createBoundDashboardAdministration(env, dashboard, dependencies, externalConfiguration) {
    if (!readDashboardAdminBinding(env)) return Object.freeze({});
    // Once adopted, the writer locator persists through listing disable. Only
    // this separate explicit switch selects the disclosure composition; turning
    // the UI off must not create an interval of untracked account writes.
    const enabled = Object.getOwnPropertyDescriptor(env, ENABLED_SETTING);
    if (!enabled || Object.hasOwn(enabled, 'value') &&
        [undefined, '', 'false'].includes(enabled.value)) return Object.freeze({});
    if (!Object.hasOwn(enabled, 'value') || enabled.value !== 'true') fail();
    const opened = openBindings(env, dashboard, dependencies, externalConfiguration);
    if (!opened) fail();
    try {
        const { binding, common, index, accountStore, setupStore } = opened;
        const { createDashboardAdminSignupListingReader } = require('../api/shared/dashboardAdmin/signupListingStore');
        const approval = createDashboardAdminSignupListingReader({ ...approvalOptions(opened), readCurrentIndex: index.readCurrentIndex });
        const { createSignupDataAdapter } = require('../api/shared/dashboardAdmin/signupDataAdapter');
        const { createFiniteSignupPageReader } = require('../api/shared/dashboardAdmin/finiteSignupIndex');
        const { createDashboardAdminSignupRuntime } = require('../api/shared/dashboardAdmin/signupAuditRuntimeAdapter');
        async function readSignupPage(input, options) {
            const current = await approval.readApprovedIndex(input.authority, options);
            const readEntrySummary = createSignupDataAdapter({ provider: binding.provider,
                sourceReferences: current.sourceReferences, accountStore, setupStore, clock: common.clock });
            const read = createFiniteSignupPageReader({ manifest: current.manifest, readEntrySummary,
                clock: common.clock, resolvePopulationBinding: approval.resolvePopulationBinding,
                requestBudgetMs: common.requestBudgetMs });
            return read(input, options);
        }
        return Object.freeze({ dashboardAdminSignupList: createDashboardAdminSignupRuntime({ ...common, readSignupPage,
            readApprovedState: approval.readApprovedState,
            readApprovedAuthority: approval.readApprovedAuthority, resolvePopulationBinding: approval.resolvePopulationBinding }) });
    } catch (_) { fail(); }
}

// Explicit operator tooling only. Never called or exposed by the HTTP launcher.
// Publication/rebuild callbacks must recheck the separately approved exact action;
// construction performs no read, write, scan or automatic backfill.
function createBoundDashboardAdminMaintenance(env, dashboard, dependencies, externalConfiguration, authorisation) {
    fields(authorisation, ['authoriseMaintenance', 'authorisePublication']);
    if (![authorisation.authoriseMaintenance, authorisation.authorisePublication]
        .every(value => typeof value === 'function' && !isProxy(value))) fail();
    const opened = openBindings(env, dashboard, dependencies, externalConfiguration);
    if (!opened) fail();
    const { createDashboardAdminSignupListingPublisher } = require('../api/shared/dashboardAdmin/signupListingStore');
    const publisher = createDashboardAdminSignupListingPublisher({ ...approvalOptions(opened),
        authorisePublication: authorisation.authorisePublication });
    return Object.freeze({ inspectPopulation: opened.index.inspect,
        rebuildPopulation: (input = {}) => {
            fields(input, Object.hasOwn(input, 'expectedPendingRebuild') ? ['expectedPendingRebuild'] : []);
            return opened.index.rebuild({ ...input, authoriseMaintenance: authorisation.authoriseMaintenance });
        }, inspectApproval: publisher.inspect, publishApproval: publisher.publish });
}

module.exports = { SETTING, ENABLED_SETTING, WRITER_CONTRACT, readDashboardAdminBinding, sourceBinding,
    wrapDashboardAdminAccountStore, createBoundDashboardAdministration, createBoundDashboardAdminMaintenance };
