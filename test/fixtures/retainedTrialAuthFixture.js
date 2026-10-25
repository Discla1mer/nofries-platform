'use strict';

// Actual callback, password-policy, issuance-proof and session adapters with a
// synthetic MSAL boundary. No provider, credential or network operation occurs.
const crypto = require('node:crypto');
const { createBrowserAuthService } = require('../../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const { createDashboardCustomerSession } = require('../../api/shared/dashboardOperatorSession');
const { createCustomerIdentityProviderProfile } = require('../../api/shared/customerSignup/customerIdentityProviderProfile');
const { createExternalPasswordAuthentication } = require('../../api/shared/customerSignup/externalPasswordAuthentication');
const { createRetainedTrialCustomerIdentityPolicy } = require('../../api/shared/customerSignup/retainedTrialCustomerIdentityPolicy');
const { retainedTrialFixture, clone } = require('./retainedTrialReadFixture');

async function retainedTrialAuthFixture({ client = false, email } = {}) {
    const tenantId = crypto.randomUUID(), clientId = crypto.randomUUID(), staffTenant = crypto.randomUUID(), staffClient = crypto.randomUUID();
    const rawProfile = { kind: 'external-id', tenantId, clientId, authority: 'https://retained-test.ciamlogin.com/',
        issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
        authorizationEndpoint: 'https://retained-test.ciamlogin.com/retained-test.onmicrosoft.com/oauth2/v2.0/authorize' };
    const profile = createCustomerIdentityProviderProfile(rawProfile, { tenantId: staffTenant, clientId: staffClient });
    const f = await retainedTrialFixture({ client, email, identity: { policyId: 'synthetic-retained-trial', policyRevision: 1,
        issuer: profile.issuer, identityTenantId: tenantId, oid: crypto.randomUUID(), audience: clientId } });
    f.state.subject.expiresAt = Date.parse(f.account.activation.validUntil);
    const now = () => Date.parse(f.state.now), records = { readSubject: async () => clone(f.state.subject) };
    const authentication = createExternalPasswordAuthentication({ profile, userFlowId: 'synthetic-password-flow', now });
    const policy = createRetainedTrialCustomerIdentityPolicy({ profile, records, accountStore: f.options.accountStore, ...authentication, now });
    const store = new MemoryBrowserSessionStore(), proofs = new Map(), calls = [];
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: staffTenant, NOFRIES_ENTRA_CLIENT_ID: staffClient,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-local-fixture-only',
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: clientId, NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-local-fixture-only' };
    let badNonce = false, epoch = { instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch };
    const browserAuthOptions = { env, store, customerPolicy: policy, customerIdentityProvider: rawProfile,
        customerTransport: 'external', customerPurpose: 'retained_read',
        clientApplication: { async getAuthCodeUrl(p) {
            calls.push({ kind: 'authorize', redirectUri: p.redirectUri, scopes: p.scopes });
            const url = new URL(rawProfile.authorizationEndpoint);
            for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: p.redirectUri,
                response_mode: p.responseMode, state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge,
                code_challenge_method: p.codeChallengeMethod })) url.searchParams.set(key, value);
            return url.href;
        }, async acquireTokenByCode(p) {
            calls.push({ kind: 'exchange', redirectUri: p.redirectUri, scopes: p.scopes });
            return { idTokenClaims: { aud: clientId, tid: tenantId, oid: f.identity.oid, iss: profile.issuer,
                exp: Math.floor(now() / 1000) + 3600, email: f.email, preferred_username: f.email,
                nonce: badNonce ? 'not-the-original-nonce' : p.nonce },
            account: { localAccountId: f.identity.oid, tenantId } };
        }, getTokenCache: () => ({ removeAccount: async () => { calls.push({ kind: 'cache-disposal' }); } }) },
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) } };
    const identityPolicy = { ...f.identity }; delete identityPolicy.oid;
    const sessionOptions = { browserAuthOptions, identityPolicy,
        proofStore: { createOriginalProof: async (key, value) => {
            if (proofs.has(key)) throw new Error('duplicate proof'); proofs.set(key, clone(value));
        }, readOriginalProof: async key => proofs.get(key) || null }, clock: f.options.clock,
        readExternalRuntimeEpoch: async () => clone(epoch), newRequestId: crypto.randomUUID, requestBudgetMs: 5000 };
    const session = createDashboardCustomerSession(sessionOptions), browser = createBrowserAuthService({ ...browserAuthOptions, now });
    async function begin() {
        const begun = await browser.beginLogin({ returnTo: '/api/retained-results?bindingId=' + f.input.bindingId + '&assessmentId=saved-assessment' });
        return { begun, callback: { body: { code: 'synthetic-code', state: new URL(begun.location).searchParams.get('state') },
            cookieHeader: begun.cookie.split(';')[0] } };
    }
    async function login() {
        const { begun, callback } = await begin();
        const result = await session.callbackService.completeLogin(callback);
        return { begun, callback, result, request: { headers: { cookie: result.cookie.split(';')[0] } } };
    }
    return { f, now, profile, rawProfile, policy, records, authentication, store, proofs, calls,
        env, browserAuthOptions, sessionOptions, session, browser, begin, login,
        badNonce: () => { badNonce = true; }, changeEpoch: () => { epoch.restoreEpoch = crypto.randomUUID(); } };
}

module.exports = { retainedTrialAuthFixture };
