'use strict';

const {
    createCustomerIdentityProviderProfile: createProfile,
    CustomerIdentityProviderProfileError
} = require('../api/shared/customerSignup/customerIdentityProviderProfile');

const STAFF = Object.freeze({ tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222' });
const CUSTOMER_TENANT = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_APP = '44444444-4444-4444-8444-444444444444';

function workforce() {
    const authority = `https://login.microsoftonline.com/${STAFF.tenantId}`;
    return { kind: 'workforce-b2b', tenantId: STAFF.tenantId, clientId: CUSTOMER_APP,
        authority, issuer: `${authority}/v2.0`, authorizationEndpoint: `${authority}/oauth2/v2.0/authorize` };
}

function external() {
    return { kind: 'external-id', tenantId: CUSTOMER_TENANT, clientId: CUSTOMER_APP,
        authority: 'https://synthetic-customer.ciamlogin.com/',
        issuer: `https://${CUSTOMER_TENANT}.ciamlogin.com/${CUSTOMER_TENANT}/v2.0`,
        authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${CUSTOMER_TENANT}/oauth2/v2.0/authorize` };
}

test('represents the existing separate customer app in the workforce tenant without altering staff configuration', () => {
    const input = workforce();
    const profile = createProfile(input, STAFF);
    expect(profile).toEqual({ ...input, knownAuthorities: ['login.microsoftonline.com'] });
    expect(STAFF.clientId).toBe('22222222-2222-4222-8222-222222222222');
});

test('keeps the external customer issuer and tenant independent of the staff provider', () => {
    const input = external();
    const profile = createProfile(input, STAFF);
    expect(profile).toEqual({ ...input, knownAuthorities: ['synthetic-customer.ciamlogin.com'] });
    expect(profile.tenantId).not.toBe(STAFF.tenantId);
    expect(profile.clientId).not.toBe(STAFF.clientId);
});

test('accepts the tenant-domain discovery route without deriving an issuer from it', () => {
    const input = external();
    input.authorizationEndpoint = 'https://synthetic-customer.ciamlogin.com/synthetic-customer.onmicrosoft.com/oauth2/v2.0/authorize';
    expect(createProfile(input, STAFF).issuer).toBe(input.issuer);
});

test('copies and freezes settings so a later caller cannot alter provider trust', () => {
    const input = external();
    const profile = createProfile(input, STAFF);
    input.tenantId = STAFF.tenantId;
    expect(profile.tenantId).toBe(CUSTOMER_TENANT);
    expect(() => { profile.issuer = workforce().issuer; }).toThrow(TypeError);
    expect(() => profile.knownAuthorities.push('foreign.example.test')).toThrow(TypeError);
});

test.each(['kind', 'tenantId', 'clientId', 'authority', 'issuer', 'authorizationEndpoint'])
('rejects missing %s instead of falling back to staff configuration', field => {
    const input = external(); delete input[field];
    expect(() => createProfile(input, STAFF)).toThrow(CustomerIdentityProviderProfileError);
});

test.each([
    ['external customer tenant equals staff', { tenantId: STAFF.tenantId }],
    ['customer app equals staff', { clientId: STAFF.clientId }],
    ['generic tenant', { tenantId: 'common' }],
    ['foreign authority host', { authority: 'https://foreign.example.test/' }],
    ['another customer issuer', { issuer: `https://another-customer.ciamlogin.com/${CUSTOMER_TENANT}/v2.0` }],
    ['issuer routes to staff tenant', { issuer: `https://${CUSTOMER_TENANT}.ciamlogin.com/${STAFF.tenantId}/v2.0` }],
    ['authorization routes to staff tenant', { authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${STAFF.tenantId}/oauth2/v2.0/authorize` }],
    ['workforce authority in external profile', { authority: workforce().authority }],
    ['query in configured endpoint', { authorizationEndpoint: external().authorizationEndpoint + '?client_id=untrusted' }],
    ['userinfo in authority', { authority: 'https://hidden@synthetic-customer.ciamlogin.com/' }],
    ['insecure authority', { authority: 'http://synthetic-customer.ciamlogin.com/' }],
    ['unknown password field', { password: 'synthetic-password-not-a-real-secret' }]
])('rejects inconsistent or unsafe provider configuration: %s', (_label, change) => {
    expect(() => createProfile({ ...external(), ...change }, STAFF)).toThrow(CustomerIdentityProviderProfileError);
});

test('requires staff context to enforce separation', () => {
    expect(() => createProfile(external())).toThrow(CustomerIdentityProviderProfileError);
});

test('rejects a workforce profile routed to a different tenant', () => {
    expect(() => createProfile({ ...workforce(), tenantId: CUSTOMER_TENANT }, STAFF)).toThrow(CustomerIdentityProviderProfileError);
});

test('configuration errors never include supplied values', () => {
    const input = external(); input.authority = 'https://user:synthetic-sensitive-value@synthetic-customer.ciamlogin.com/';
    try {
        createProfile(input, STAFF);
        throw new Error('expected rejection');
    } catch (error) {
        expect(error).toBeInstanceOf(CustomerIdentityProviderProfileError);
        expect(error.statusCode).toBe(503);
        expect(String(error)).not.toContain('synthetic-sensitive-value');
    }
});
