'use strict';
const { externalCustomerConfiguration } = require('../lib/externalCustomerConfiguration');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');
const request = require('supertest');

test.each([undefined, '', 'false'])('external runtime is inactive for flag %j without accessing credentials', value => {
    expect(externalCustomerConfiguration({ NOFRIES_EXTERNAL_CUSTOMER_ENABLED: value,
        get NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET() { throw new Error('must not read'); } })).toBeNull();
});
test.each(['TRUE', 'yes', '1'])('invalid enable flag %s fails', value => {
    expect(() => externalCustomerConfiguration({ NOFRIES_EXTERNAL_CUSTOMER_ENABLED: value })).toThrow();
});
test('explicit configuration selects the managed entry while retaining legacy access; missing profile fails closed', async () => {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now() });
    const x = h.dependencies.externalCustomer, p = x.identityProvider;
    const env = { ...h.env, NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'true', NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED: 'true',
        NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: p.tenantId, NOFRIES_EXTERNAL_CUSTOMER_CLIENT_ID: p.clientId,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY: p.authority, NOFRIES_EXTERNAL_CUSTOMER_ISSUER: p.issuer,
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORIZATION_ENDPOINT: p.authorizationEndpoint,
        NOFRIES_EXTERNAL_CUSTOMER_USER_FLOW_ID: x.userFlowId, NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: x.starterAuthorityContainer,
        NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET: 'synthetic-config-secret' };
    const { externalCustomer: ignored, ...dependencies } = h.dependencies;
    const app = createProductionApplication(env, dependencies);
    expect((await request(app).get('/login')).text).toContain('/api/external-customer-auth/login');
    expect((await request(app).get('/login?provider=legacy')).text).toContain('/api/customer-auth/login');
    const legacyInvitation = await request(app).get('/signup');
    expect(legacyInvitation.text).not.toContain("customerTransport: 'external'");
    expect(legacyInvitation.text).toContain('/api/customer-signup/bootstrap');
    expect(() => createProductionApplication({ ...env, NOFRIES_EXTERNAL_CUSTOMER_ISSUER: '' }, dependencies)).toThrow();
    expect(() => createProductionApplication({ ...env, NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED: undefined }, dependencies)).toThrow();
});
