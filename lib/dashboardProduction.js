'use strict';

const crypto = require('node:crypto');
const { resolveAppServiceHostConfig } = require('./hostStartup');
const { createPostgresPool } = require('../api/shared/database/postgres');
const { createBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createDashboardAuthorityStore } = require('../api/shared/dashboardAuthorityStore');
const { createNcscSubmissionQuotaResolver, createDurableNcscSubmissionQuotaResolver } = require('./ncscSubmissionPolicy');
const { createNcscPolicyReader } = require('../api/shared/customerSignup/ncscPolicyStore');
const { uuid, id, revision } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

const fail = () => { throw new Error('dashboard_production_configuration_invalid'); };
function container(value) {
    if (typeof value !== 'string' || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value)) fail();
    return value;
}

function createProductionDashboardConfiguration(env = process.env, dependencies = {}) {
    const enabled = env.NOFRIES_DASHBOARD_RUNTIME_ENABLED;
    if (enabled === undefined || enabled === '' || enabled === 'false') return null;
    if (enabled !== 'true') fail();
    try {
        resolveAppServiceHostConfig(env);
        const improvementEnabled = env.NOFRIES_DASHBOARD_IMPROVEMENT_ENABLED;
        if (![undefined, '', 'false', 'true'].includes(improvementEnabled)) fail();
        const ncscEnabled = env.NOFRIES_DASHBOARD_NCSC_ENABLED;
        if (![undefined, '', 'false', 'true'].includes(ncscEnabled)) fail();
        // Keep the packaged path for legacy/operator-only composition. Customer
        // composition reads approved per-organisation records through Reader IAM.
        let ncsc = ncscEnabled === 'true' ? Object.freeze({
            resolveSubmissionQuota: createNcscSubmissionQuotaResolver(
                Object.prototype.hasOwnProperty.call(dependencies, 'ncscPolicies')
                    ? dependencies.ncscPolicies : require('./ncscSubmissionPolicies.json'))
        }) : null;
        const instanceId = uuid(env.NOFRIES_DASHBOARD_INSTANCE_ID);
        const policyId = id(env.NOFRIES_DASHBOARD_IDENTITY_POLICY_ID);
        if (!/^(0|[1-9][0-9]*)$/.test(env.NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION || '')) fail();
        const policyRevision = Number(env.NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION); revision(policyRevision);
        const tenant = uuid(env.NOFRIES_ENTRA_TENANT_ID), audience = uuid(env.NOFRIES_ENTRA_CLIENT_ID);
        const proofName = container(env.NOFRIES_DASHBOARD_PROOF_CONTAINER);
        const epochName = container(env.NOFRIES_DASHBOARD_EPOCH_CONTAINER);
        const sessionName = container(env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth');
        if (new Set([proofName, epochName, sessionName]).size !== 3) fail();
        if (!/^[a-z0-9-]+\.postgres\.database\.azure\.com$/.test(env.NOFRIES_POSTGRES_HOST || '') ||
            env.NOFRIES_DATABASE_URL || env.DATABASE_URL) fail();
        const identityClientId = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID;
        if (identityClientId) uuid(identityClientId);
        const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
        const credential = identityClientId ? new ManagedIdentityCredential({ clientId: identityClientId }) : new ManagedIdentityCredential();
        const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
        const service = new BlobServiceClient(`https://${env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT}.blob.core.windows.net`, credential,
            { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
        if (ncsc && env.NOFRIES_CUSTOMER_SIGNUP_ENABLED === 'true' && !Object.hasOwn(dependencies, 'ncscPolicies')) {
            const account = env.AZURE_STORAGE_ACCOUNT_NAME;
            const authorityName = container(env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER);
            if (typeof account !== 'string' || !/^[a-z0-9]{3,24}$/.test(account) ||
                account === env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT ||
                [proofName, epochName, sessionName].includes(authorityName)) fail();
            const authorityService = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
                { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
            ncsc = Object.freeze({ resolveSubmissionQuota: createDurableNcscSubmissionQuotaResolver(
                createNcscPolicyReader({ authorityContainer: authorityService.getContainerClient(authorityName) })) });
        }
        const authority = createDashboardAuthorityStore({ proofContainer: service.getContainerClient(proofName),
            epochContainer: service.getContainerClient(epochName), instanceId });
        const store = (dependencies.createBrowserSessionStore || createBrowserSessionStore)({ env, credential, serviceClient: service });
        const pool = (dependencies.createPostgresPool || createPostgresPool)({ env, credential, poolMax: 5,
            statementTimeoutMs: 15000, connectionTimeoutMs: 5000, applicationName: 'nofries-dashboard' });
        // Preserve the explicit environment used by the host's other existing
        // routes. It is detached by createNoFriesApp and never emitted to clients.
        return Object.freeze({ browserAuthOptions: { env, store,
            ...Object.fromEntries(['clientApplication', 'cryptoProvider'].filter(key => Object.hasOwn(dependencies, key)).map(key => [key, dependencies[key]])) },
            identityPolicy: { policyId, policyRevision, issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
                identityTenantId: tenant, audience }, ...authority,
            clock: dependencies.clock || (() => new Date().toISOString()), instanceId,
            newRequestId: crypto.randomUUID, newId: crypto.randomUUID, newOperationId: crypto.randomUUID,
            newGenerationToken: () => crypto.randomBytes(32).toString('hex'), requestBudgetMs: 60000,
            historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 }, pool,
            ...(improvementEnabled === 'true' ? { improvementEnabled: true } : {}),
            ...(ncsc ? { ncsc } : {}) });
    } catch (_) { fail(); }
}

module.exports = { createProductionDashboardConfiguration };
