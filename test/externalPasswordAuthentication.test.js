'use strict';
const { createExternalPasswordAuthentication } = require('../api/shared/customerSignup/externalPasswordAuthentication');
const { createCustomerIdentityProviderProfile } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
const { uid } = require('./helpers/customerProductionHarness');
const profile = createCustomerIdentityProviderProfile({ kind: 'external-id', tenantId: uid(101), clientId: uid(102),
    authority: 'https://synthetic-customer.ciamlogin.com/', issuer: `https://${uid(101)}.ciamlogin.com/${uid(101)}/v2.0`,
    authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${uid(101)}/oauth2/v2.0/authorize` }, { tenantId: uid(1), clientId: uid(2) });
const identity = { tenantId: profile.tenantId, principalId: uid(103), subjectKey: profile.tenantId + ':' + uid(103), isAuthenticated: true };
function fixture() {
    let now = 1791428400000;
    const options = { profile, userFlowId: 'SyntheticEmailPassword', now: () => now };
    const adapter = createExternalPasswordAuthentication(options);
    const claims = { iss: profile.issuer, tid: profile.tenantId, oid: identity.principalId, aud: profile.clientId,
        exp: now / 1000 + 7200, email: 'synthetic@example.test' };
    return { options, adapter, claims, expire() { now += 3600000; } };
}
test('the real callback adapter requires no undocumented email_verified or MFA claim and binds its proof to immutable subject/profile/expiry', async () => {
    const f = fixture(), authentication = await f.adapter.verifyAuthentication({ identity, claims: f.claims, profile });
    expect(authentication.email).toBe('synthetic@example.test');
    expect(authentication.expiresAt - authentication.verifiedAt).toBe(3600000);
    expect(authentication).not.toHaveProperty('mfaSatisfied');
    expect(await f.adapter.recheckAuthentication({ identity, authentication, profile })).toBe(true);
    await expect(f.adapter.recheckAuthentication({ identity: { ...identity, principalId: uid(104), subjectKey: profile.tenantId + ':' + uid(104) }, authentication, profile })).rejects.toThrow();
    const changed = createExternalPasswordAuthentication({ ...f.options, userFlowId: 'DifferentFlow' });
    await expect(changed.recheckAuthentication({ identity, authentication, profile })).rejects.toThrow();
    f.expire(); await expect(f.adapter.recheckAuthentication({ identity, authentication, profile })).rejects.toThrow();
});
test.each([{ email: undefined }, { email: 'not-mail' }, { oid: uid(104) }, { exp: 0 }, { aud: uid(2) }, { tid: uid(1) }, { iss: 'https://untrusted.invalid' }])('invalid callback claims %j fail closed', async change => {
    const f = fixture();
    await expect(f.adapter.verifyAuthentication({ identity, claims: { ...f.claims, ...change }, profile })).rejects.toThrow();
});
test('mutable preferred_username is neither mailbox provenance nor an identity fallback', async () => {
    const f = fixture(), claims = { ...f.claims, email: undefined, preferred_username: 'synthetic@example.test' };
    await expect(f.adapter.verifyAuthentication({ identity, claims, profile })).rejects.toThrow();
});
