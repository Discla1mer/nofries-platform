'use strict';

// Selected only by explicit, default-off external-customer composition.
// Hosting identity metadata must come from authorized readback.
const { createAppServiceCredential } = require('./appServiceCredential');
const { createKeyVaultCustomerAssertion } = require('./keyVaultCustomerAssertion');
const { RemoteCustomerAssertionError } = require('./remoteCustomerAssertion');
const FIELDS = new Set(['enabled', 'configuration', 'managedIdentity', 'managedIdentityTenantId', 'env', 'now']);
const DEPENDENCIES = new Set(['identityRequest', 'httpClient', 'KeyClient', 'CryptographyClient']);
const fail = () => { throw new RemoteCustomerAssertionError(); };

function createAppServiceCustomerAssertion(options = {}, dependencies = {}) {
    try {
        if (options.enabled === undefined || options.enabled === false) return null;
        if (options.enabled !== true || Reflect.ownKeys(options).some(key => !FIELDS.has(key)) ||
            Reflect.ownKeys(dependencies).some(key => !DEPENDENCIES.has(key))) fail();
        const identity = { ...options.managedIdentity };
        const env = options.env, tenantId = options.managedIdentityTenantId;
        const now = options.now;
        // The separate hosting MI client ID is checked against REST response
        // metadata even for system identity. Never use a principal ID, customer
        // app client ID or CIAM tenant as an inferred default.
        return createKeyVaultCustomerAssertion({ enabled: true, configuration: options.configuration,
            managedIdentity: identity.kind === 'system-assigned' ? { kind: identity.kind } : identity,
            ...(now === undefined ? {} : { now }) }, {
            createCredential() {
                // Called once, after assertion pins are validated. Fresh SDK
                // clients share this object, its four slots and operation memo.
                return createAppServiceCredential({ enabled: true, env, identity, tenantId },
                    { request: dependencies.identityRequest, ...(now === undefined ? {} : { now }) });
            },
            get KeyClient() { return dependencies.KeyClient; },
            get CryptographyClient() { return dependencies.CryptographyClient; },
            get httpClient() { return dependencies.httpClient; }
        });
    } catch (_) { throw new RemoteCustomerAssertionError(); }
}

module.exports = { createAppServiceCustomerAssertion };
