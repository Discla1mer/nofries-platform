// Regression coverage for the "sign-in error on first attempt" finding.
//
// Root cause: the pending OIDC authorization-code transaction (the
// __Host-nofries-auth-tx cookie plus its server record) lived for only five
// minutes. A *first* interactive sign-in routinely takes longer than that --
// the user types credentials, answers an MFA challenge and clears consent
// prompts at the identity provider. When the window elapsed, the form_post
// callback arrived with the transaction expired (or the cookie already gone),
// so completeLogin threw browser_auth_transaction_expired / _missing and the
// user was bounced to /login?signin=retry. The retry reused the IdP's freshly
// established SSO session, completed in seconds and "worked on the second try".
//
// The fix widens the transaction window to ten minutes while keeping every
// security property: the cookie stays __Host- + Secure + HttpOnly +
// SameSite=None, the transaction is still one-time (atomically consumed) and
// PKCE/state/nonce-bound. These tests pin the corrected cookie attributes,
// prove a slow-but-in-window first attempt now succeeds, and confirm a missing
// or past-window transaction still fails closed with the right error.

const {
    createBrowserAuthService
} = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');

const TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
const CLIENT_ID = 'd414ee2d-73e5-4e5b-bb16-03ef55fea597';
const SUBJECT_ID = 'acada13b-5614-49d6-a356-88d816aa0a3c';
const NOW = Date.parse('2026-08-23T01:00:00.000Z');
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function environment(overrides = {}) {
    return Object.assign({
        NODE_ENV: 'production',
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        NOFRIES_ENTRA_TENANT_ID: TENANT_ID,
        NOFRIES_ENTRA_CLIENT_ID: CLIENT_ID,
        NOFRIES_ENTRA_CLIENT_SECRET: 'test-only-client-secret',
        NOFRIES_ALLOWED_SUBJECTS: `${TENANT_ID}:${SUBJECT_ID}`,
        NOFRIES_BROWSER_SESSION_STORE: 'memory'
    }, overrides);
}

function protocol() {
    const calls = {};
    const cryptoProvider = {
        generatePkceCodes: jest.fn(async () => ({
            verifier: 'v'.repeat(64),
            challenge: 'c'.repeat(43)
        }))
    };
    const clientApplication = {
        getAuthCodeUrl: jest.fn(async (request) => {
            calls.urlRequest = request;
            const url = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
            url.searchParams.set('client_id', CLIENT_ID);
            url.searchParams.set('redirect_uri', request.redirectUri);
            url.searchParams.set('response_mode', request.responseMode);
            url.searchParams.set('state', request.state);
            url.searchParams.set('nonce', request.nonce);
            url.searchParams.set('code_challenge', request.codeChallenge);
            url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
            return url.href;
        }),
        acquireTokenByCode: jest.fn(async () => ({
            account: { tenantId: TENANT_ID, localAccountId: SUBJECT_ID, username: 'joel@example.com', name: 'Joel Harvey' },
            idTokenClaims: {
                aud: CLIENT_ID,
                iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
                tid: TENANT_ID,
                oid: SUBJECT_ID,
                preferred_username: 'joel@example.com',
                name: 'Joel Harvey',
                nonce: calls.urlRequest && calls.urlRequest.nonce,
                exp: Math.floor(NOW / 1000) + 3600
            }
        })),
        getTokenCache: jest.fn(() => ({ removeAccount: jest.fn(async () => {}) }))
    };
    return { calls, clientApplication, cryptoProvider };
}

function harness(options = {}) {
    const provider = protocol();
    const store = new MemoryBrowserSessionStore();
    const env = options.env || environment();
    let counter = 1;
    const service = createBrowserAuthService({
        env,
        store,
        now: options.now || (() => NOW),
        randomBytes: (length) => Buffer.alloc(length, counter++),
        clientApplication: provider.clientApplication,
        cryptoProvider: provider.cryptoProvider
    });
    return Object.assign({ service, store, env }, provider);
}

function requestCookie(setCookie) {
    return String(setCookie).split(';')[0];
}

function cookieValue(setCookie) {
    const pair = requestCookie(setCookie);
    return pair.slice(pair.indexOf('=') + 1);
}

describe('sign-in first-attempt reliability (transaction window)', () => {
    test('the transaction cookie keeps the standards-correct attributes for a cross-site form_post round-trip', async () => {
        const h = harness();
        const started = await h.service.beginLogin({ returnTo: '/operator' });

        // __Host- prefix + Secure + Path=/ + no Domain, HttpOnly so script can
        // never read it, and SameSite=None so the IdP's cross-site form_post
        // carries it back on the callback.
        expect(requestCookie(started.cookie)).toBe(`__Host-nofries-auth-tx=${cookieValue(started.cookie)}`);
        expect(cookieValue(started.cookie)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(started.cookie).toContain('Path=/');
        expect(started.cookie).toContain('HttpOnly');
        expect(started.cookie).toContain('Secure');
        expect(started.cookie).toContain('SameSite=None');
        expect(started.cookie).not.toMatch(/(?:^|;)\s*Domain=/i);

        // The corrected ten-minute window, reflected in both the cookie Max-Age
        // and the server record, so neither side expires ahead of the other.
        expect(started.cookie).toContain('Max-Age=600');
        expect(h.store.transactions.get(cookieValue(started.cookie)).expiresAt).toBe(NOW + TRANSACTION_TTL_MS);
    });

    test('a slow first sign-in that lands just inside the ten-minute window now completes', async () => {
        // Six minutes of interactive IdP time would have expired the old
        // five-minute transaction and bounced the user to signin=retry.
        let current = NOW;
        const h = harness({ now: () => current });
        const started = await h.service.beginLogin({ returnTo: '/operator' });
        current += 6 * 60 * 1000;

        const completed = await h.service.completeLogin({
            body: { code: 'one-time-code', state: h.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(completed.location).toBe('/operator');
        expect(requestCookie(completed.cookie)).toBe(`__Host-nofries-auth=${cookieValue(completed.cookie)}`);
        await expect(h.service.readSession(requestCookie(completed.cookie)))
            .resolves.toMatchObject({ subjectKey: `${TENANT_ID}:${SUBJECT_ID}` });
    });

    test('a callback with no transaction cookie still fails closed as transaction_missing', async () => {
        const h = harness();
        const started = await h.service.beginLogin({ returnTo: '/operator' });
        await expect(h.service.completeLogin({
            body: { code: 'one-time-code', state: h.calls.urlRequest.state },
            cookieHeader: ''
        })).rejects.toMatchObject({ statusCode: 401, code: 'browser_auth_transaction_missing' });
        // The genuine transaction is untouched, so the real callback still works.
        const completed = await h.service.completeLogin({
            body: { code: 'one-time-code', state: h.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(completed.location).toBe('/operator');
    });

    test('a transaction past the ten-minute window still expires', async () => {
        let current = NOW;
        const h = harness({ now: () => current });
        const started = await h.service.beginLogin({ returnTo: '/operator' });
        current += TRANSACTION_TTL_MS + 1;
        await expect(h.service.completeLogin({
            body: { code: 'one-time-code', state: h.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ code: 'browser_auth_transaction_expired' });
    });
});
