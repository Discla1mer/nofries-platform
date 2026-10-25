'use strict';

const { createHash } = require('node:crypto');

// Shared profile contract for explicitly configured customer-auth composition.
// External production selection remains disabled unless its protected flag is set.
// Inputs must come from reviewed configuration and provider metadata, never a
// request or token. Validation establishes consistency, not provider ownership,
// email verification, MFA, customer authority or permission to activate a tenant.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CIAM_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ciamlogin\.com$/;
const FIELDS = new Set(['kind', 'tenantId', 'clientId', 'authority', 'issuer', 'authorizationEndpoint']);

class CustomerIdentityProviderProfileError extends Error {
    constructor(code) {
        super('Customer identity provider configuration is incomplete or inconsistent.');
        this.name = 'CustomerIdentityProviderProfileError';
        this.code = code;
        this.statusCode = 503;
    }
}

function createCustomerIdentityProviderProfile(configuration, staffIdentity) {
    if (!record(configuration) || Object.keys(configuration).some(key => !FIELDS.has(key))) {
        fail('customer_provider_configuration_invalid');
    }
    const { kind } = configuration;
    if (kind !== 'workforce-b2b' && kind !== 'external-id') fail('customer_provider_kind_invalid');
    if (!record(staffIdentity)) fail('customer_provider_staff_context_missing');
    const staffTenantId = guid(staffIdentity.tenantId);
    const staffClientId = guid(staffIdentity.clientId);
    const tenantId = guid(configuration.tenantId);
    const clientId = guid(configuration.clientId);
    if (clientId === staffClientId) fail('customer_provider_staff_app_reused');
    if ((kind === 'workforce-b2b') !== (tenantId === staffTenantId)) {
        fail('customer_provider_tenant_separation_invalid');
    }

    const authority = providerUrl(configuration.authority);
    const issuer = providerUrl(configuration.issuer);
    const authorization = providerUrl(configuration.authorizationEndpoint);
    const issuerPath = `/${tenantId}/v2.0`;
    if (kind === 'workforce-b2b') {
        if ([authority, issuer, authorization].some(url => url.hostname !== 'login.microsoftonline.com') ||
            !pathIs(authority, `/${tenantId}`) || !pathIs(issuer, issuerPath) ||
            authorization.pathname !== `/${tenantId}/oauth2/v2.0/authorize`) {
            fail('customer_provider_endpoints_inconsistent');
        }
    } else {
        if (!CIAM_HOST.test(authority.hostname)) fail('customer_provider_host_invalid');
        const tenantLabel = authority.hostname.split('.')[0];
        if (GUID.test(tenantLabel) && tenantLabel !== tenantId) fail('customer_provider_endpoints_inconsistent');
        // CIAM discovery can use the tenant domain while its issuer uses the
        // immutable tenant-ID hostname. Only these two pinned hosts are allowed.
        const hosts = new Set([authority.hostname, `${tenantId}.ciamlogin.com`]);
        const tenantPaths = [`/${tenantId}`, `/${tenantLabel}.onmicrosoft.com`];
        if (!hosts.has(issuer.hostname) || !hosts.has(authorization.hostname) ||
            !pathIs(issuer, issuerPath) ||
            !(authority.pathname === '/' || tenantPaths.some(path => pathIs(authority, path))) ||
            !tenantPaths.some(path => authorization.pathname === `${path}/oauth2/v2.0/authorize`)) {
            fail('customer_provider_endpoints_inconsistent');
        }
    }

    return Object.freeze({
        kind, tenantId, clientId,
        authority: authority.href,
        issuer: issuer.href,
        authorizationEndpoint: authorization.href,
        knownAuthorities: Object.freeze([authority.hostname])
    });
}

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function guid(value) {
    if (typeof value !== 'string' || !GUID.test(value.toLowerCase())) fail('customer_provider_identifier_invalid');
    return value.toLowerCase();
}

function providerUrl(value) {
    let url;
    try {
        if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw new Error();
        url = new URL(value);
    } catch (_) {
        fail('customer_provider_url_invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
        fail('customer_provider_url_invalid');
    }
    return url;
}

function pathIs(url, path) {
    return url.pathname === path || url.pathname === `${path}/`;
}

function fail(code) {
    throw new CustomerIdentityProviderProfileError(code);
}

// Call only with an already validated profile. The key is a configuration
// binding, not identity evidence or an authentication credential.
function customerProviderKey(profile) {
    if (!profile) return undefined;
    return createHash('sha256').update(JSON.stringify([
        profile.kind, profile.tenantId, profile.clientId, profile.authority,
        profile.issuer, profile.authorizationEndpoint
    ])).digest('hex');
}

module.exports = { createCustomerIdentityProviderProfile, customerProviderKey, CustomerIdentityProviderProfileError };
