'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBrowserAuthService, readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createDashboardCustomerSession } = require('../api/shared/dashboardOperatorSession');
const { createCustomerIdentityProviderProfile } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
const { createExternalPasswordAuthentication } = require('../api/shared/customerSignup/externalPasswordAuthentication');
const { createExternalCustomerIdentityPolicy } = require('../api/shared/customerSignup/externalCustomerIdentityPolicy');
const { createCustomerIdentityPolicy } = require('../api/shared/customerSignup/customerAuthority');
const { createRetainedTrialCustomerIdentityPolicy } = require('../api/shared/customerSignup/retainedTrialCustomerIdentityPolicy');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture, clone } = require('./fixtures/retainedTrialReadFixture');

async function fixture() {
    const tenantId = crypto.randomUUID(), clientId = crypto.randomUUID(), staffTenant = crypto.randomUUID(), staffClient = crypto.randomUUID();
    const rawProfile = { kind: 'external-id', tenantId, clientId, authority: 'https://retained-test.ciamlogin.com/',
        issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
        authorizationEndpoint: 'https://retained-test.ciamlogin.com/retained-test.onmicrosoft.com/oauth2/v2.0/authorize' };
    const profile = createCustomerIdentityProviderProfile(rawProfile, { tenantId: staffTenant, clientId: staffClient });
    const f = await retainedTrialFixture({ identity: { policyId: 'synthetic-retained-trial', policyRevision: 1,
        issuer: profile.issuer, identityTenantId: tenantId, oid: crypto.randomUUID(), audience: clientId } });
    // The subject's commercial envelope is genuinely past at the simulated
    // current clock. Authentication uses the actual existing verifier/policy and
    // browser callback/session/proof adapters with a synthetic MSAL transport.
    f.state.subject.expiresAt = Date.parse(f.account.activation.validUntil);
    const now = () => Date.parse(f.state.now), records = { readSubject: async () => clone(f.state.subject) };
    const authentication = createExternalPasswordAuthentication({ profile, userFlowId: 'synthetic-password-flow', now });
    const options = { profile, records, accountStore: f.options.accountStore, ...authentication, now };
    const policy = createRetainedTrialCustomerIdentityPolicy(options);
    const identity = { isAuthenticated: true, tenantId, principalId: f.identity.oid, subjectKey: f.actor };
    const claims = () => ({ aud: clientId, tid: tenantId, oid: f.identity.oid, iss: profile.issuer,
        exp: Math.floor(now() / 1000) + 3600, email: f.email, preferred_username: f.email, name: 'Synthetic retained owner' });
    const store = new MemoryBrowserSessionStore(), proofs = new Map(); let nonceOverride;
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid',
        NOFRIES_ENTRA_TENANT_ID: staffTenant, NOFRIES_ENTRA_CLIENT_ID: staffClient,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-local-fixture-only',
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: clientId, NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-local-fixture-only' };
    const browserAuthOptions = { env, store, customerPolicy: policy, customerIdentityProvider: rawProfile, customerTransport: 'external',
        customerPurpose: 'retained_read',
        clientApplication: { getAuthCodeUrl: async p => {
            const url = new URL(rawProfile.authorizationEndpoint);
            for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: p.redirectUri,
                response_mode: p.responseMode, state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge,
                code_challenge_method: p.codeChallengeMethod })) url.searchParams.set(key, value);
            return url.href;
        },
            acquireTokenByCode: async p => ({ idTokenClaims: { ...claims(), nonce: nonceOverride ?? p.nonce },
                account: { localAccountId: f.identity.oid, tenantId } }), getTokenCache: () => ({ removeAccount: async () => {} }) },
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) } };
    const sessionOptions = { browserAuthOptions, identityPolicy: { ...f.identity },
        proofStore: { createOriginalProof: async (key, value) => { if (proofs.has(key)) throw new Error('duplicate proof'); proofs.set(key, clone(value)); },
            readOriginalProof: async key => proofs.get(key) || null }, clock: f.options.clock,
        readExternalRuntimeEpoch: async () => ({ instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch }),
        newRequestId: crypto.randomUUID, requestBudgetMs: 5000 };
    delete sessionOptions.identityPolicy.oid;
    const session = createDashboardCustomerSession(sessionOptions);
    const browser = createBrowserAuthService({ ...browserAuthOptions, now });
    async function login() {
        const begun = await browser.beginLogin({ returnTo: '/api/retained-results' });
        const callback = { body: { code: 'synthetic-code', state: new URL(begun.location).searchParams.get('state') },
            cookieHeader: begun.cookie.split(';')[0] };
        const result = await session.callbackService.completeLogin(callback);
        return { result, callback, request: { headers: { cookie: result.cookie.split(';')[0] } } };
    }
    return { f, options, policy, identity, claims, authentication, records, profile, rawProfile, browserAuthOptions, browser,
        session, store, proofs, login, now, setNonce: value => { nonceOverride = value; } };
}

test('real callback/capture seams admit a fresh read-purpose session after Blob expiry and read one result', async () => {
    const h = await fixture();
    const login = await h.login(), capture = await h.session.captureRequest(login.request);
    assert.equal(capture.kind, 'customer'); assert.equal(h.proofs.size, 1);
    const record = await h.store.loadSession(login.result.cookie.split(';')[0].split('=')[1]);
    assert.equal(record.customerAssurance.stage, 'retained_read');
    assert.equal(record.customerAssurance.expiresAt, record.customerAssurance.authentication.expiresAt);
    assert.ok(record.customerAssurance.expiresAt > h.f.state.subject.expiresAt);
    const result = await createRetainedTrialAssessmentReader({ ...h.f.options, captureRequest: h.session.captureRequest }).read(login.request, h.f.input);
    assert.equal(result.readOnly, true); assert.equal(result.assessment.submission.revision, 2);
    assert.equal(h.f.selected.snapshot.usage[0].counters.assessment_runs, 0);
});

test('same retained-read assurance is rejected by both ordinary customer policies even while Blob authority is live', async () => {
    const h = await fixture(); h.f.state.subject.expiresAt = h.now() + 7200000;
    const value = await h.policy.verify({ identity: h.identity, claims: h.claims(), context: (await h.policy.begin()).context });
    const external = createExternalCustomerIdentityPolicy({ profile: h.profile, records: h.records, ...h.authentication, now: h.now });
    await assert.rejects(external.recheck({ identity: h.identity, assurance: value }));
    const legacy = createCustomerIdentityPolicy({ records: h.records, verifyMfaPolicy: async () => true, authenticationContext: 'c1', now: h.now });
    await assert.rejects(legacy.recheck({ identity: h.identity, assurance: value }));
    const login = await h.login();
    await assert.rejects(readBrowserSessionDetails(login.request.headers.cookie, { ...h.browserAuthOptions, customerPolicy: external, now: h.now }));
});

test('missing callback issuance proof and nonce mismatch deny genuine capture/issuance', async () => {
    const h = await fixture(), login = await h.login(); h.proofs.clear();
    assert.equal(await h.session.captureRequest(login.request), null);
    const other = await fixture(); other.setNonce('wrong-nonce');
    await assert.rejects(other.login()); assert.equal(other.proofs.size, 0);
});

test('real callback is one use and real capture rechecks revocation during result I/O', async () => {
    const h = await fixture(), login = await h.login();
    await assert.rejects(h.session.callbackService.completeLogin(login.callback)); assert.equal(h.proofs.size, 1);
    h.f.state.hook = sql => { if (sql.includes('dashboard_ncsc_assessment_revisions')) h.f.state.subject.status = 'revoked'; };
    await assert.rejects(createRetainedTrialAssessmentReader({ ...h.f.options, captureRequest: h.session.captureRequest })
        .read(login.request, h.f.input), { code: 'retained_read_denied' });
});

for (const change of ['revocation', 'owner', 'revision', 'expiry', 'provider']) test(`current ${change} invalidates read-purpose recheck`, async () => {
    const h = await fixture(), value = await h.policy.verify({ identity: h.identity, claims: h.claims(), context: (await h.policy.begin()).context });
    if (change === 'revocation') h.f.state.subject.status = 'revoked';
    if (change === 'owner') h.f.state.account.identitySubjectKey = crypto.randomUUID() + ':' + crypto.randomUUID();
    if (change === 'revision') h.f.state.subject.revision++;
    if (change === 'expiry') h.f.state.now = new Date(value.expiresAt).toISOString();
    const supplied = change === 'provider' ? { ...clone(value), providerKey: '0'.repeat(64) } : value;
    await assert.rejects(h.policy.recheck({ identity: h.identity, assurance: supplied }));
});

test('rechecks detect owner changes during provider I/O and never create an account or renew authority', async () => {
    const h = await fixture(), before = JSON.stringify(h.f.state.account), originalExpiry = h.f.state.subject.expiresAt;
    const value = await h.policy.verify({ identity: h.identity, claims: h.claims(), context: (await h.policy.begin()).context });
    const changed = createRetainedTrialCustomerIdentityPolicy({ ...h.options, recheckAuthentication: async () => {
        h.f.state.subject.bindingId = crypto.randomUUID(); return true;
    } });
    await assert.rejects(changed.recheck({ identity: h.identity, assurance: value }));
    assert.equal(JSON.stringify(h.f.state.account), before); assert.equal(h.f.state.subject.expiresAt, originalExpiry);
});

test('provider or current-store outages remain unavailable rather than authenticated or revoked', async () => {
    const h = await fixture(), value = await h.policy.verify({ identity: h.identity, claims: h.claims(), context: (await h.policy.begin()).context });
    for (const port of [{ recheckAuthentication: async () => { throw new Error('synthetic provider outage'); } },
        { records: { readSubject: async () => { throw new Error('synthetic store outage'); } } },
        { accountStore: { load: async () => { throw new Error('synthetic account outage'); } } }]) {
        const policy = createRetainedTrialCustomerIdentityPolicy({ ...h.options, ...port });
        await assert.rejects(policy.recheck({ identity: h.identity, assurance: value }), { statusCode: 503 });
    }
});
