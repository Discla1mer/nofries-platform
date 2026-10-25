'use strict';

// Synthetic provider + admission contracts only. This is not hosted signup,
// production customer admission, MFA enforcement or questionnaire acceptance.
const { createBrowserAuthService, readBrowserSessionDetails, BrowserAuthError } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');

const STAFF_TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF_APP = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_TENANT = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_APP = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_OBJECT = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-10-07T00:00:00Z');
const subjectKey = `${CUSTOMER_TENANT}:${CUSTOMER_OBJECT}`;
const cookie = value => value.split(';')[0];

function profile() {
    return { kind: 'external-id', tenantId: CUSTOMER_TENANT, clientId: CUSTOMER_APP,
        authority: 'https://synthetic-customer.ciamlogin.com/',
        issuer: `https://${CUSTOMER_TENANT}.ciamlogin.com/${CUSTOMER_TENANT}/v2.0`,
        authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${CUSTOMER_TENANT}/oauth2/v2.0/authorize` };
}

function harness(overrides = {}) {
    const provider = profile(), store = new MemoryBrowserSessionStore();
    const env = { NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: STAFF_TENANT, NOFRIES_ENTRA_CLIENT_ID: STAFF_APP,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff-secret',
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: CUSTOMER_APP,
        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-customer-secret',
        NOFRIES_ALLOWED_SUBJECTS: `${STAFF_TENANT}:${CUSTOMER_OBJECT}` };
    const customerPolicy = {
        begin: jest.fn(async () => ({ context: { purpose: 'synthetic-admission' } })),
        verify: jest.fn(async ({ identity }) => {
            if (overrides.denyAdmission || identity.subjectKey !== subjectKey) {
                throw new BrowserAuthError(403, 'synthetic_customer_not_admitted');
            }
            return { expiresAt: NOW + 3600000, subjectKey: identity.subjectKey };
        }),
        recheck: jest.fn(async ({ identity, assurance }) => {
            if (identity.subjectKey !== assurance.subjectKey) throw new BrowserAuthError(401, 'synthetic_assurance_invalid');
        })
    };
    const requests = [], configurations = [], removeAccount = jest.fn(async () => {});
    class Client {
        constructor(config) { configurations.push(config); }
        async getAuthCodeUrl(request) {
            requests.push(request);
            const url = new URL(provider.authorizationEndpoint);
            for (const [key, value] of Object.entries({ client_id: CUSTOMER_APP, redirect_uri: request.redirectUri,
                response_mode: request.responseMode, state: request.state, nonce: request.nonce,
                code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod })) {
                url.searchParams.set(key, value);
            }
            return url.href;
        }
        async acquireTokenByCode(request) {
            return { accessToken: 'synthetic-token-not-for-storage', account: { localAccountId: CUSTOMER_OBJECT },
                idTokenClaims: { aud: CUSTOMER_APP, iss: provider.issuer, tid: CUSTOMER_TENANT,
                    oid: CUSTOMER_OBJECT, email: 'customer@example.test', nonce: request.nonce,
                    exp: NOW / 1000 + 3600, ...overrides.claims } };
        }
        getTokenCache() { return { removeAccount }; }
    }
    let serial = 0;
    const options = { env, store, customerPolicy, customerIdentityProvider: provider, now: () => NOW,
        randomBytes: length => Buffer.alloc(length, ++serial), msal: { ConfidentialClientApplication: Client },
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) } };
    const service = createBrowserAuthService(options);
    async function login() {
        const started = await service.beginLogin();
        return service.completeLogin({ cookieHeader: cookie(started.cookie),
            body: { code: 'synthetic-code', state: new URL(started.location).searchParams.get('state') } });
    }
    return { service, options, provider, store, customerPolicy, configurations, requests, removeAccount, login };
}

test('injected customer provider completes ordinary login, logout and relogin with the same immutable identity', async () => {
    const h = harness();
    const first = await h.login();
    expect(first.location).toBe('/signup');
    expect(first.identity.subjectKey).toBe(subjectKey);
    expect(await h.service.readSession(cookie(first.cookie))).toEqual(first.identity);
    expect(h.configurations[0].auth).toMatchObject({ clientId: CUSTOMER_APP,
        authority: h.provider.authority, knownAuthorities: ['synthetic-customer.ciamlogin.com'] });
    expect(h.customerPolicy.verify).toHaveBeenCalledTimes(1);
    expect(h.customerPolicy.recheck).toHaveBeenCalledTimes(1);
    expect(h.removeAccount).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...h.store.sessions.values()])).not.toContain('synthetic-token-not-for-storage');
    const signedOut = await h.service.logout({ cookieHeader: cookie(first.cookie) });
    expect(signedOut.location).toBe('/');
    await expect(h.service.readSession(cookie(first.cookie))).rejects.toMatchObject({ code: 'browser_auth_session_invalid' });
    const second = await h.login();
    expect(second.identity.subjectKey).toBe(first.identity.subjectKey);
    expect(cookie(second.cookie)).not.toBe(cookie(first.cookie));
    expect(h.store.sessions.size).toBe(1);
});

test('standalone reader uses the same customer profile and still rechecks authority', async () => {
    const h = harness(), loggedIn = await h.login();
    const details = await readBrowserSessionDetails(cookie(loggedIn.cookie), h.options);
    expect(details.identity.subjectKey).toBe(subjectKey);
    expect(h.customerPolicy.recheck).toHaveBeenCalledTimes(1);
});

test.each([
    ['staff tenant', { tid: STAFF_TENANT }, 'browser_auth_tenant_not_allowed'],
    ['staff audience', { aud: STAFF_APP }, 'browser_auth_audience_invalid'],
    ['unconfigured issuer', { iss: `https://foreign-customer.ciamlogin.com/${CUSTOMER_TENANT}/v2.0` }, 'browser_auth_issuer_invalid']
])('customer callback rejects %s before customer admission', async (_label, claims, code) => {
    const h = harness({ claims });
    await expect(h.login()).rejects.toMatchObject({ code });
    expect(h.customerPolicy.verify).not.toHaveBeenCalled();
    expect(h.store.sessions.size).toBe(0);
});

test('a valid provider identity still cannot create a session when customer admission denies it', async () => {
    const h = harness({ denyAdmission: true });
    await expect(h.login()).rejects.toMatchObject({ code: 'synthetic_customer_not_admitted' });
    expect(h.store.sessions.size).toBe(0);
});

test('the same email on another immutable subject still reaches the admission denial', async () => {
    const h = harness({ claims: { oid: '66666666-6666-4666-8666-666666666666' } });
    await expect(h.login()).rejects.toMatchObject({ code: 'synthetic_customer_not_admitted' });
    expect(h.customerPolicy.verify).toHaveBeenCalledWith(expect.objectContaining({
        identity: expect.objectContaining({ email: 'customer@example.test', subjectKey: `${CUSTOMER_TENANT}:66666666-6666-4666-8666-666666666666` })
    }));
    expect(h.store.sessions.size).toBe(0);
});

test('customer provider configuration cannot be injected into a staff login', () => {
    const h = harness();
    expect(() => createBrowserAuthService({ ...h.options, customerPolicy: null }))
        .toThrow(expect.objectContaining({ code: 'browser_auth_customer_provider_requires_policy' }));
});

test('customer profile must match the configured dedicated client', () => {
    const h = harness();
    expect(() => createBrowserAuthService({ ...h.options, customerIdentityProvider: { ...h.provider, clientId: '77777777-7777-4777-8777-777777777777' } }))
        .toThrow(expect.objectContaining({ code: 'browser_auth_customer_provider_client_mismatch' }));
});

test('a session from an injected provider is not reinterpreted by another customer app profile', async () => {
    const h = harness(), loggedIn = await h.login();
    const otherApp = '77777777-7777-4777-8777-777777777777';
    await expect(readBrowserSessionDetails(cookie(loggedIn.cookie), { ...h.options,
        env: { ...h.options.env, NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: otherApp },
        customerIdentityProvider: { ...h.provider, clientId: otherApp } }))
        .rejects.toMatchObject({ code: 'browser_auth_session_provider_invalid' });
});
