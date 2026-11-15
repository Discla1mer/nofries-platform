'use strict';

// Microsoft Graph token for removing External ID users, by workload identity
// federation: the App Service managed identity gets a token for
// api://AzureADTokenExchange and presents it as the client assertion of an
// app registration in the External ID tenant. No client secret exists.
// The token is returned to accountWipeIdentity only; it is never logged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TENANT_SETTING = 'NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID';
const CLIENT_SETTING = 'NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID';
const EXCHANGE_SCOPE = 'api://AzureADTokenExchange/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const fail = code => { const error = new Error(code); error.code = code; throw error; };

// Null when neither setting is set (delete is then refused); throws when only
// one is set, either is malformed, or the tenant is not the External ID tenant.
function readAccountWipeGraphSettings(env) {
    const tenantId = env?.[TENANT_SETTING], clientId = env?.[CLIENT_SETTING];
    if ([undefined, ''].includes(tenantId) && [undefined, ''].includes(clientId)) return null;
    if (typeof tenantId !== 'string' || typeof clientId !== 'string' || !UUID.test(tenantId) || !UUID.test(clientId) ||
        tenantId !== env.NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID) fail('account_wipe_identity_configuration_invalid');
    return Object.freeze({ tenantId, clientId });
}

function createAccountWipeGraphToken({ tenantId, clientId, managedIdentityClientId = null, ManagedIdentityCredential, ClientAssertionCredential }) {
    if (!UUID.test(tenantId || '') || !UUID.test(clientId || '') || managedIdentityClientId !== null && !UUID.test(managedIdentityClientId) ||
        typeof ManagedIdentityCredential !== 'function' || typeof ClientAssertionCredential !== 'function') fail('account_wipe_identity_configuration_invalid');
    const managed = managedIdentityClientId ? new ManagedIdentityCredential({ clientId: managedIdentityClientId }) : new ManagedIdentityCredential();
    const credential = new ClientAssertionCredential(tenantId, clientId, async () => {
        const assertion = await managed.getToken(EXCHANGE_SCOPE);
        if (typeof assertion?.token !== 'string' || !assertion.token) fail('account_wipe_identity_unavailable');
        return assertion.token;
    });
    return async function getToken({ signal } = {}) {
        const result = await credential.getToken(GRAPH_SCOPE, signal ? { abortSignal: signal } : undefined);
        if (typeof result?.token !== 'string' || !result.token) fail('account_wipe_identity_unavailable');
        return result.token;
    };
}

module.exports = { readAccountWipeGraphSettings, createAccountWipeGraphToken, TENANT_SETTING, CLIENT_SETTING, EXCHANGE_SCOPE, GRAPH_SCOPE };
