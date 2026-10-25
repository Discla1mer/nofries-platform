'use strict';

// Inactive unless the reviewed deployment explicitly enables it. Values come
// from protected server configuration; no request can select a tenant or client.
// This reads no remote policy, provisions no resource and emits no credential.
// ADMISSION_ENABLED gates No Fries authority, not hosted provider registration.
// Returning-only activation also requires the existing flow's reviewed
// isSignUpAllowed=false setting; that provider operation is a separate gate.
function externalCustomerConfiguration(env, dependencies = {}) {
    const enabled = env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED;
    if ([undefined, '', 'false'].includes(enabled)) return null;
    if (enabled !== 'true' || !['true', 'false'].includes(env.NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED)) {
        throw new Error('external_customer_configuration_invalid');
    }
    const identityProvider = {
        kind: 'external-id', tenantId: env.NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID,
        clientId: env.NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID,
        authority: env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY,
        issuer: env.NOFRIES_EXTERNAL_CUSTOMER_ISSUER,
        authorizationEndpoint: env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORIZATION_ENDPOINT
    };
    const mode = env.NOFRIES_EXTERNAL_CUSTOMER_CREDENTIAL_MODE;
    let client;
    if (mode === 'app-service-assertion') {
        // Presence is enough to reject a mixed configuration; never evaluate a
        // secret getter or read a secret value in assertion mode.
        if (Object.hasOwn(env, 'NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET')) {
            throw new Error('external_customer_configuration_invalid');
        }
        const { createCustomerIdentityProviderProfile } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
        const profile = createCustomerIdentityProviderProfile(identityProvider,
            { tenantId: env.NOFRIES_ENTRA_TENANT_ID, clientId: env.NOFRIES_ENTRA_CLIENT_ID });
        const tokenEndpoint = env.NOFRIES_EXTERNAL_CUSTOMER_TOKEN_ENDPOINT;
        if (tokenEndpoint !== profile.authorizationEndpoint.replace(/\/authorize$/, '/token')) {
            throw new Error('external_customer_configuration_invalid');
        }
        const encoded = env.NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_DER;
        if (typeof encoded !== 'string' || encoded.length > 21848 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new Error('external_customer_configuration_invalid');
        }
        const certificateDer = Buffer.from(encoded, 'base64');
        if (certificateDer.toString('base64') !== encoded) throw new Error('external_customer_configuration_invalid');
        const { createAppServiceCustomerAssertion } = require('../api/shared/customerSignup/appServiceCustomerAssertion');
        client = { clientAssertion: createAppServiceCustomerAssertion({ enabled: true,
            configuration: { clientId: profile.clientId, tokenEndpoint,
                vaultOrigin: env.NOFRIES_EXTERNAL_CUSTOMER_VAULT_ORIGIN,
                keyName: env.NOFRIES_EXTERNAL_CUSTOMER_KEY_NAME,
                keyId: env.NOFRIES_EXTERNAL_CUSTOMER_KEY_ID, certificateDer,
                certificateSha256: env.NOFRIES_EXTERNAL_CUSTOMER_CERTIFICATE_SHA256 },
            managedIdentity: { kind: env.NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_KIND,
                clientId: env.NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_CLIENT_ID },
            managedIdentityTenantId: env.NOFRIES_EXTERNAL_CUSTOMER_IDENTITY_TENANT_ID,
            env
        }, dependencies.customerAssertion) };
    } else if (mode === undefined || mode === 'client-secret') {
        client = { clientSecret: env.NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET };
    } else {
        throw new Error('external_customer_configuration_invalid');
    }
    return {
        identityProvider,
        identityPolicy: { policyId: 'nofries-external-email-password-v1', policyRevision: 1,
            issuer: identityProvider.issuer, identityTenantId: identityProvider.tenantId, audience: identityProvider.clientId },
        userFlowId: env.NOFRIES_EXTERNAL_CUSTOMER_USER_FLOW_ID,
        starterAuthorityContainer: env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER,
        allowNewSignup: env.NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED === 'true',
        client
    };
}
module.exports = { externalCustomerConfiguration };
