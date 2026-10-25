const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    BrowserAuthError,
    COOKIE_NAME,
    SESSION_COOKIE_NAME,
    TRANSACTION_COOKIE_NAME,
    createBrowserAuthService,
    normaliseReturnTo,
    parseFormBody,
    readBrowserSessionCookie
} = require('../api/shared/browserAuth');
const {
    AzureBlobBrowserSessionStore,
    BrowserSessionStoreError,
    MemoryBrowserSessionStore,
    createBrowserSessionStore
} = require('../api/shared/browserSessionStore');
const authLogin = require('../api/authLogin');
const authCallback = require('../api/authCallback');
const authLogout = require('../api/authLogout');
const authSession = require('../api/authSession');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
const CLIENT_ID = 'd414ee2d-73e5-4e5b-bb16-03ef55fea597';
const SUBJECT_ID = 'acada13b-5614-49d6-a356-88d816aa0a3c';
const OTHER_SUBJECT_ID = '888f6a8c-928e-4a91-b214-7f7597797e1b';
const NOW = Date.parse('2026-08-23T01:00:00.000Z');

function environment(overrides = {}) {
    return Object.assign({
        NODE_ENV: 'production',
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        NOFRIES_ENTRA_TENANT_ID: TENANT_ID,
        NOFRIES_ENTRA_CLIENT_ID: CLIENT_ID,
        NOFRIES_ENTRA_CLIENT_SECRET: 'test-only-client-secret',
        NOFRIES_ALLOWED_SUBJECTS: `${TENANT_ID}:${SUBJECT_ID}`,
        NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesauthtest',
        AZURE_STORAGE_ACCOUNT_NAME: 'nofriestest',
        NOFRIES_BROWSER_AUTH_CONTAINER: 'nofries-browser-auth'
    }, overrides);
}

function protocol(overrides = {}) {
    const calls = {};
    const removeAccount = jest.fn(async () => {});
    const cryptoProvider = {
        generatePkceCodes: jest.fn(async () => ({
            verifier: 'v'.repeat(64),
            challenge: 'c'.repeat(43)
        }))
    };
    const clientApplication = {
        getAuthCodeUrl: jest.fn(async (request) => {
            calls.urlRequest = request;
            if (typeof overrides.authorizationUrl === 'function') return overrides.authorizationUrl(request);
            if (overrides.authorizationUrl) return overrides.authorizationUrl;
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
        acquireTokenByCode: jest.fn(async (request) => {
            calls.tokenRequest = request;
            if (overrides.tokenError) throw overrides.tokenError;
            return {
                accessToken: 'server-access-token-never-stored',
                idToken: 'server-id-token-never-stored',
                account: {
                    tenantId: TENANT_ID,
                    localAccountId: SUBJECT_ID,
                    username: 'Joel@example.com',
                    name: 'Joel Harvey'
                },
                idTokenClaims: Object.assign({
                    aud: CLIENT_ID,
                    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
                    tid: TENANT_ID,
                    oid: SUBJECT_ID,
                    preferred_username: 'Joel@example.com',
                    name: 'Joel Harvey',
                    nonce: calls.urlRequest && calls.urlRequest.nonce,
                    exp: Math.floor(NOW / 1000) + 3600
                }, overrides.claims || {})
            };
        }),
        getTokenCache: jest.fn(() => ({ removeAccount }))
    };
    return { calls, clientApplication, cryptoProvider, removeAccount };
}

function serviceHarness(options = {}) {
    const provider = protocol(options.protocol || {});
    const store = options.store || new MemoryBrowserSessionStore();
    const env = options.env || environment();
    let counter = 1;
    const service = createBrowserAuthService({
        env,
        store,
        now: options.now || (() => NOW),
        randomBytes: options.randomBytes || ((length) => Buffer.alloc(length, counter++)),
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

function canonicalHeaders(extra = {}) {
    return Object.assign({
        host: 'nofries.nz',
        'user-agent': 'Cloud Browser',
        'x-forwarded-for': '203.0.113.5'
    }, extra);
}

function functionContext() {
    return {
        log: {
            error: jest.fn(),
            warn: jest.fn(),
            info: jest.fn()
        }
    };
}

beforeEach(() => {
    resetAbuseProtectionForTests();
});

describe('opaque same-domain Entra browser authentication', () => {
    test.each(['/dashboard', '/dashboard#cyber-security'])('dashboard return path survives the genuine one-use login transaction: %s', async (returnTo) => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin({ returnTo });
        expect(harness.store.transactions.get(cookieValue(started.cookie)).returnTo).toBe(returnTo);
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-dashboard-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(completed.location).toBe(returnTo);
        expect(await harness.service.readSession(requestCookie(completed.cookie))).toMatchObject({ subjectKey: `${TENANT_ID}:${SUBJECT_ID}` });
        expect(harness.store.transactions.has(cookieValue(started.cookie))).toBe(false);
    });

    test.each(['/dashboard/', '/dashboard-admin', '/dashboard/other', 'https://attacker.invalid/dashboard', '//attacker.invalid/dashboard', '/dashboard\\\\@attacker.invalid', '/dashboard%0d%0aLocation:%20https://attacker.invalid', '/dashboard#%0d%0a', '/dashboard?next=%5c%5cattacker.invalid'])('dashboard fixed return path still rejects unsafe or neighbouring destination %s', (returnTo) => {
        expect(() => normaliseReturnTo(returnTo, 'https://nofries.nz', '/operator')).toThrow(expect.objectContaining({ code: 'browser_auth_return_path_invalid' }));
    });

    test.each(['/portal', '/portal#cyber-security', '/portal?view=overview'])('returns a verified login to the exact portal destination %s', async (returnTo) => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin({ returnTo });
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(completed.location).toBe(returnTo);
        expect(await harness.service.readSession(requestCookie(completed.cookie))).toMatchObject({ subjectKey: `${TENANT_ID}:${SUBJECT_ID}` });
    });

    test('expired portal sessions can begin a new exact-path login without reviving the old session', async () => {
        let current = NOW;
        const harness = serviceHarness({ now: () => current });
        const first = await harness.service.beginLogin({ returnTo: '/portal' });
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state }, cookieHeader: requestCookie(first.cookie)
        });
        current += 4 * 60 * 60 * 1000;
        await expect(harness.service.readSession(requestCookie(completed.cookie))).rejects.toMatchObject({ code: 'browser_auth_session_expired' });
        const next = await harness.service.beginLogin({ returnTo: '/portal' });
        expect(harness.store.transactions.get(cookieValue(next.cookie)).returnTo).toBe('/portal');
        expect(harness.store.sessions.has(cookieValue(completed.cookie))).toBe(false);
    });

    test.each(['/portal/', '/portal-admin', '/portal/other', 'https://attacker.invalid/portal', '//attacker.invalid/portal', '/portal\\\\@attacker.invalid', '/portal%0d%0aLocation:%20https://attacker.invalid'])('portal fix does not permit neighbouring or unsafe return path %s', (returnTo) => {
        expect(() => normaliseReturnTo(returnTo, 'https://nofries.nz', '/operator')).toThrow(expect.objectContaining({ code: 'browser_auth_return_path_invalid' }));
    });

    test('starts a tenant-specific code flow and stores a five-minute PKCE transaction server-side', async () => {
        const harness = serviceHarness();
        const result = await harness.service.beginLogin({ returnTo: '/operator?organisationId=org-1' });
        const url = new URL(result.location);
        const opaqueId = cookieValue(result.cookie);

        expect(url.origin).toBe('https://login.microsoftonline.com');
        expect(url.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
        expect(harness.clientApplication.getAuthCodeUrl).toHaveBeenCalledWith(expect.objectContaining({
            scopes: ['openid', 'profile', 'email'],
            redirectUri: 'https://nofries.nz/api/auth/callback',
            responseMode: 'form_post',
            codeChallengeMethod: 'S256'
        }));
        expect(opaqueId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(requestCookie(result.cookie)).toBe(`${TRANSACTION_COOKIE_NAME}=${opaqueId}`);
        expect(result.cookie).not.toContain(`${SESSION_COOKIE_NAME}=`);
        expect(result.cookie).toContain('Path=/');
        expect(result.cookie).toContain('HttpOnly');
        expect(result.cookie).toContain('Secure');
        expect(result.cookie).toContain('SameSite=None');
        expect(result.cookie).toContain('Max-Age=300');
        expect(result.cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
        expect(result.cookie).not.toContain(harness.calls.urlRequest.state);
        expect(result.cookie).not.toContain('organisationId');

        const record = harness.store.transactions.get(opaqueId);
        expect(record).toMatchObject({
            kind: 'oidc_transaction',
            state: harness.calls.urlRequest.state,
            nonce: harness.calls.urlRequest.nonce,
            codeVerifier: 'v'.repeat(64),
            returnTo: '/operator?organisationId=org-1',
            expiresAt: NOW + (5 * 60 * 1000)
        });
    });

    test('consumes the transaction once, validates nonce through MSAL and stores only verified identity', async () => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin({ returnTo: '/support' });
        const transactionId = cookieValue(started.cookie);
        const completed = await harness.service.completeLogin({
            body: `code=one-time-code&state=${encodeURIComponent(harness.calls.urlRequest.state)}`,
            cookieHeader: requestCookie(started.cookie)
        });

        expect(harness.clientApplication.acquireTokenByCode).toHaveBeenCalledWith({
            code: 'one-time-code',
            scopes: ['openid', 'profile', 'email'],
            redirectUri: 'https://nofries.nz/api/auth/callback',
            codeVerifier: 'v'.repeat(64),
            nonce: harness.calls.urlRequest.nonce
        });
        expect(harness.removeAccount).toHaveBeenCalledTimes(1);
        expect(harness.store.transactions.has(transactionId)).toBe(false);
        expect(completed.location).toBe('/support');
        expect(requestCookie(completed.cookie)).toBe(`${SESSION_COOKIE_NAME}=${cookieValue(completed.cookie)}`);
        expect(completed.cookie).not.toContain(`${TRANSACTION_COOKIE_NAME}=`);
        expect(completed.cookie).toContain('SameSite=Lax');
        expect(completed.cookie).toContain('Max-Age=14400');
        expect(completed.cookie).toContain('Path=/');
        expect(completed.cookie).toContain('HttpOnly');
        expect(completed.cookie).toContain('Secure');
        expect(completed.cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
        expect(completed.cookie).not.toContain('server-access-token');
        expect(completed.cookie).not.toContain('server-id-token');

        const sessionRecord = harness.store.sessions.get(cookieValue(completed.cookie));
        expect(JSON.stringify(sessionRecord)).not.toContain('server-access-token');
        expect(JSON.stringify(sessionRecord)).not.toContain('server-id-token');
        await expect(harness.service.readSession(requestCookie(completed.cookie))).resolves.toEqual({
            email: 'joel@example.com',
            name: 'Joel Harvey',
            provider: 'entra-bff',
            principalId: SUBJECT_ID,
            tenantId: TENANT_ID,
            subjectKey: `${TENANT_ID}:${SUBJECT_ID}`,
            isAuthenticated: true
        });
        await expect(harness.service.readSessionDetails(requestCookie(completed.cookie))).resolves.toMatchObject({
            expiresAt: '2026-08-23T05:00:00.000Z',
            identity: { email: 'joel@example.com' }
        });

        await expect(harness.service.completeLogin({
            body: { code: 'replayed-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ statusCode: 401, code: 'browser_auth_transaction_invalid' });
        expect(harness.clientApplication.acquireTokenByCode).toHaveBeenCalledTimes(1);
    });

    test('preserves a transaction on state mismatch so the later valid callback succeeds', async () => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin();
        const transactionId = cookieValue(started.cookie);
        const validState = harness.calls.urlRequest.state;
        await expect(harness.service.completeLogin({
            body: { code: 'one-time-code', state: 'a'.repeat(43) },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ statusCode: 400, code: 'browser_auth_state_invalid' });
        expect(harness.clientApplication.acquireTokenByCode).not.toHaveBeenCalled();
        expect(harness.store.transactions.has(transactionId)).toBe(true);

        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: validState },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(completed.cookie).toContain(`${SESSION_COOKIE_NAME}=`);
        expect(harness.store.transactions.has(transactionId)).toBe(false);
        expect(harness.clientApplication.acquireTokenByCode).toHaveBeenCalledTimes(1);
    });

    test('consumes a matching transaction when the provider code exchange fails', async () => {
        const harness = serviceHarness({
            protocol: { tokenError: new Error('provider unavailable') }
        });
        const started = await harness.service.beginLogin();
        const transactionId = cookieValue(started.cookie);
        const validState = harness.calls.urlRequest.state;

        await expect(harness.service.completeLogin({
            body: { code: 'one-time-code', state: validState },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ statusCode: 400, code: 'browser_auth_code_exchange_failed' });
        expect(harness.store.transactions.has(transactionId)).toBe(false);

        await expect(harness.service.completeLogin({
            body: { code: 'replayed-code', state: validState },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ statusCode: 401, code: 'browser_auth_transaction_invalid' });
        expect(harness.clientApplication.acquireTokenByCode).toHaveBeenCalledTimes(1);
    });

    test('rejects expired transactions and deletes expired sessions', async () => {
        let current = NOW;
        const harness = serviceHarness({ now: () => current });
        const started = await harness.service.beginLogin();
        current += (5 * 60 * 1000);
        await expect(harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ code: 'browser_auth_transaction_expired' });

        current = NOW;
        const second = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(second.cookie)
        });
        const sessionId = cookieValue(completed.cookie);
        current += (4 * 60 * 60 * 1000);
        await expect(harness.service.readSession(requestCookie(completed.cookie)))
            .rejects.toMatchObject({ code: 'browser_auth_session_expired' });
        expect(harness.store.sessions.has(sessionId)).toBe(false);
    });

    test.each([
        [{ nonce: 'wrong-nonce' }, 'browser_auth_nonce_invalid'],
        [{ tid: null }, 'browser_auth_tenant_not_allowed'],
        [{ tid: '11111111-1111-4111-8111-111111111111' }, 'browser_auth_tenant_not_allowed'],
        [{ iss: 'https://attacker.invalid/v2.0' }, 'browser_auth_issuer_invalid'],
        [{ aud: '11111111-1111-4111-8111-111111111111' }, 'browser_auth_audience_invalid'],
        [{ oid: null }, 'browser_auth_subject_missing'],
        [{ oid: OTHER_SUBJECT_ID, preferred_username: 'joel@example.com' }, 'browser_auth_subject_not_allowed']
    ])('rejects invalid or unapproved immutable claims %#', async (claims, code) => {
        const harness = serviceHarness({ protocol: { claims } });
        const started = await harness.service.beginLogin();
        await expect(harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        })).rejects.toMatchObject({ code });
        expect(harness.store.sessions.size).toBe(0);
    });

    test('revokes an existing session when its subject allowlist entry is removed', async () => {
        const env = environment();
        const harness = serviceHarness({ env });
        const started = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        env.NOFRIES_ALLOWED_SUBJECTS = `${TENANT_ID}:${OTHER_SUBJECT_ID}`;
        await expect(harness.service.readSession(requestCookie(completed.cookie)))
            .rejects.toMatchObject({ code: 'browser_auth_session_revoked' });
        expect(harness.store.sessions.size).toBe(0);
    });

    test('rejects a stored session after the configured tenant changes', async () => {
        const env = environment();
        const harness = serviceHarness({ env });
        const started = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        env.NOFRIES_ENTRA_TENANT_ID = '11111111-1111-4111-8111-111111111111';
        await expect(harness.service.readSession(requestCookie(completed.cookie)))
            .rejects.toMatchObject({ code: 'browser_auth_session_tenant_invalid' });
    });

    test('fails closed without deleting a valid session during a temporary allowlist configuration error', async () => {
        const env = environment();
        const harness = serviceHarness({ env });
        const started = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        env.NOFRIES_ALLOWED_SUBJECTS = 'invalid-entry';
        await expect(harness.service.readSession(requestCookie(completed.cookie)))
            .rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_allowed_subjects_invalid' });
        expect(harness.store.sessions.size).toBe(1);
    });

    test('rejects an authorization URL that does not preserve S256 PKCE parameters', async () => {
        const harness = serviceHarness({
            protocol: {
                authorizationUrl(request) {
                    const url = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
                    url.searchParams.set('client_id', CLIENT_ID);
                    url.searchParams.set('redirect_uri', request.redirectUri);
                    url.searchParams.set('response_mode', 'form_post');
                    url.searchParams.set('state', request.state);
                    url.searchParams.set('nonce', request.nonce);
                    url.searchParams.set('code_challenge', request.codeChallenge);
                    url.searchParams.set('code_challenge_method', 'plain');
                    return url.href;
                }
            }
        });
        await expect(harness.service.beginLogin())
            .rejects.toMatchObject({ code: 'browser_auth_provider_url_invalid' });
        expect(harness.store.transactions.size).toBe(0);
    });

    test('logout deletes the opaque server session and clears the cookie', async () => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        expect(harness.store.sessions.size).toBe(1);
        const result = await harness.service.logout({
            cookieHeader: requestCookie(completed.cookie),
            returnTo: '/'
        });
        expect(harness.store.sessions.size).toBe(0);
        expect(result.cookie).toContain('Max-Age=0');
        await expect(harness.service.readSession(requestCookie(completed.cookie)))
            .rejects.toMatchObject({ code: 'browser_auth_session_invalid' });
    });

    test.each([
        'https://attacker.invalid/operator',
        '//attacker.invalid/operator',
        '/operator\\@attacker.invalid',
        '/unknown',
        '/operator%0d%0aLocation:%20https://attacker.invalid'
    ])('rejects unsafe returnTo value %s', (value) => {
        expect(() => normaliseReturnTo(value, 'https://nofries.nz', '/operator')).toThrow(expect.objectContaining({
            code: 'browser_auth_return_path_invalid'
        }));
    });

    test('fails closed on non-GUID authority, bad public URL and missing subject membership', () => {
        expect(() => serviceHarness({ env: environment({ NOFRIES_ENTRA_TENANT_ID: 'consumers' }) }))
            .toThrow(expect.objectContaining({ code: 'browser_auth_tenant_invalid' }));
        expect(() => serviceHarness({ env: environment({ NOFRIES_PUBLIC_URL: 'http://nofries.nz' }) }))
            .toThrow(expect.objectContaining({ code: 'browser_auth_public_url_invalid' }));
        expect(() => serviceHarness({ env: environment({ NOFRIES_ALLOWED_SUBJECTS: '' }) }))
            .toThrow(expect.objectContaining({ code: 'browser_auth_allowed_subjects_missing' }));
    });

    test('parses one form-post value per field and rejects duplicate or oversized callbacks', () => {
        expect(parseFormBody('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
        expect(() => parseFormBody('code=one&code=two')).toThrow(expect.objectContaining({
            code: 'browser_auth_callback_invalid'
        }));
        expect(() => parseFormBody(`code=${'x'.repeat(17000)}`)).toThrow(expect.objectContaining({
            statusCode: 413
        }));
    });
});

describe('browser authentication storage', () => {
    test('uses memory only for explicit local auth-off mode', () => {
        expect(createBrowserSessionStore({
            env: { NOFRIES_REQUIRE_AUTH: 'false', NOFRIES_BROWSER_SESSION_STORE: 'memory' }
        }))
            .toBeInstanceOf(MemoryBrowserSessionStore);
        expect(() => createBrowserSessionStore({
            env: { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_SESSION_STORE: 'memory' }
        })).toThrow(expect.objectContaining({ code: 'browser_auth_store_configuration_invalid' }));
        expect(() => createBrowserSessionStore({
            env: { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_SESSION_STORE: 'azure' }
        })).toThrow(BrowserSessionStoreError);
        expect(createBrowserSessionStore({
            env: { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_SESSION_STORE: 'azure' },
            containerClient: { getProperties: jest.fn() }
        })).toBeInstanceOf(AzureBlobBrowserSessionStore);
    });

    test('uses an existing Azure container and hashes opaque IDs before blob paths', async () => {
        const paths = [];
        const blob = { uploadData: jest.fn(async () => {}) };
        const container = {
            getProperties: jest.fn(async () => ({})),
            getBlockBlobClient: jest.fn((value) => {
                paths.push(value);
                return blob;
            })
        };
        const store = new AzureBlobBrowserSessionStore({ containerClient: container });
        const id = Buffer.alloc(32, 21).toString('base64url');
        await store.createSession(id, { v: 1, kind: 'browser_session' });
        expect(container.getProperties).toHaveBeenCalledTimes(1);
        expect(container.createIfNotExists).toBeUndefined();
        expect(paths).toEqual([
            `browser-auth/sessions/${crypto.createHash('sha256').update(id).digest('hex')}.json`
        ]);
        expect(paths[0]).not.toContain(id);
    });

    test('requires a browser-auth account isolated from application data', () => {
        const serviceClient = { getContainerClient: jest.fn(() => ({ getProperties: jest.fn() })) };
        expect(() => createBrowserSessionStore({
            env: {
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_BROWSER_SESSION_STORE: 'azure',
                AZURE_STORAGE_ACCOUNT_NAME: 'nofriestest',
                NOFRIES_AZURE_CONTAINER: 'nofries-workspace'
            },
            serviceClient
        })).toThrow(expect.objectContaining({ code: 'browser_auth_store_configuration_invalid' }));
        expect(() => createBrowserSessionStore({
            env: {
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_BROWSER_SESSION_STORE: 'azure',
                NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriestest',
                AZURE_STORAGE_ACCOUNT_NAME: 'nofriestest'
            },
            serviceClient
        })).toThrow(expect.objectContaining({ code: 'browser_auth_store_configuration_invalid' }));

        createBrowserSessionStore({
            env: {
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_BROWSER_SESSION_STORE: 'azure',
                NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesauthtest',
                AZURE_STORAGE_ACCOUNT_NAME: 'nofriestest',
                NOFRIES_AZURE_CONTAINER: 'nofries-workspace'
            },
            serviceClient
        });
        expect(serviceClient.getContainerClient).toHaveBeenCalledWith('nofries-browser-auth');
    });

    test('atomically permits only one concurrent Azure transaction consume', async () => {
        let leased = false;
        let deleted = false;
        const record = { v: 1, kind: 'oidc_transaction' };
        const blob = {
            getBlobLeaseClient: jest.fn((leaseId) => ({
                acquireLease: jest.fn(async () => {
                    if (deleted) throw Object.assign(new Error('missing'), { statusCode: 404 });
                    if (leased) throw Object.assign(new Error('leased'), { statusCode: 409 });
                    leased = true;
                    return { leaseId };
                }),
                releaseLease: jest.fn(async () => {
                    leased = false;
                })
            })),
            download: jest.fn(async () => ({
                readableStreamBody: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.from(JSON.stringify(record), 'utf8');
                    }
                }
            })),
            delete: jest.fn(async () => {
                deleted = true;
                leased = false;
            })
        };
        const store = new AzureBlobBrowserSessionStore({
            containerClient: {
                getProperties: jest.fn(async () => ({})),
                getBlockBlobClient: jest.fn(() => blob)
            }
        });
        const id = Buffer.alloc(32, 27).toString('base64url');
        const results = await Promise.all([
            store.consumeTransaction(id),
            store.consumeTransaction(id)
        ]);
        expect(results.filter(Boolean)).toEqual([record]);
        expect(results.filter((value) => value === null)).toHaveLength(1);
        expect(blob.delete).toHaveBeenCalledTimes(1);
    });

    test('Azure state mismatch releases its lease without deleting the transaction, then permits the valid state', async () => {
        const validState = Buffer.alloc(32, 31).toString('base64url');
        const record = { v: 1, kind: 'oidc_transaction', state: validState };
        const releaseLease = jest.fn(async () => {});
        const blob = {
            getBlobLeaseClient: jest.fn((leaseId) => ({
                acquireLease: jest.fn(async () => ({ leaseId })),
                releaseLease
            })),
            download: jest.fn(async () => ({
                readableStreamBody: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.from(JSON.stringify(record), 'utf8');
                    }
                }
            })),
            delete: jest.fn(async () => {})
        };
        const store = new AzureBlobBrowserSessionStore({
            containerClient: {
                getProperties: jest.fn(async () => ({})),
                getBlockBlobClient: jest.fn(() => blob)
            }
        });
        const id = Buffer.alloc(32, 29).toString('base64url');

        await expect(store.consumeTransaction(id, Buffer.alloc(32, 30).toString('base64url')))
            .resolves.toEqual({ matched: false, record: null });
        expect(blob.delete).not.toHaveBeenCalled();
        expect(releaseLease).toHaveBeenCalledTimes(1);

        await expect(store.consumeTransaction(id, validState))
            .resolves.toEqual({ matched: true, record });
        expect(blob.delete).toHaveBeenCalledTimes(1);
    });
});

describe('browser auth Azure Functions', () => {
    test('declares four explicit anonymous HTTP routes', () => {
        const definitions = ['authLogin', 'authCallback', 'authLogout', 'authSession'].map((folder) => (
            JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', folder, 'function.json'), 'utf8'))
        ));
        const triggers = definitions.map((definition) => definition.bindings.find((binding) => binding.type === 'httpTrigger'));
        expect(triggers.map((trigger) => [trigger.route, trigger.methods, trigger.authLevel])).toEqual([
            ['auth/login', ['get'], 'anonymous'],
            ['auth/callback', ['post'], 'anonymous'],
            ['auth/logout', ['post'], 'anonymous'],
            ['auth/session', ['get'], 'anonymous']
        ]);
    });

    test('login remains usable when the linked SWA proxy rewrites the request host', async () => {
        const service = {
            beginLogin: jest.fn(async () => ({
                location: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
                cookie: `${TRANSACTION_COOKIE_NAME}=${Buffer.alloc(32, 1).toString('base64url')}; Path=/; HttpOnly; Secure; SameSite=None`
            }))
        };
        const handler = authLogin.createAuthLoginFunction({ service, env: environment() });
        const context = functionContext();
        await handler(context, {
            method: 'GET',
            query: { returnTo: '/operator' },
            headers: canonicalHeaders()
        });
        expect(context.res.status).toBe(302);
        expect(service.beginLogin).toHaveBeenCalledWith({ returnTo: '/operator' });

        const rewritten = functionContext();
        await handler(rewritten, {
            method: 'GET',
            headers: canonicalHeaders({
                host: 'nofries-web-api-flex.azurewebsites.net',
                'x-forwarded-host': ''
            })
        });
        expect(rewritten.res.status).toBe(302);
        expect(rewritten.res.headers.Location).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);

        const callerControlledProxyHeaders = functionContext();
        await handler(callerControlledProxyHeaders, {
            method: 'GET',
            headers: canonicalHeaders({ 'x-forwarded-host': 'nofries.nz, attacker.invalid' })
        });
        expect(callerControlledProxyHeaders.res.status).toBe(302);
        expect(callerControlledProxyHeaders.res.headers.Location).toBe(
            `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`
        );
        expect(service.beginLogin).toHaveBeenCalledTimes(3);
    });

    test('callback sets only the session cookie with a 303 and returns generic failures', async () => {
        const service = {
            completeLogin: jest.fn(async () => ({
                location: '/operator',
                cookie: `${SESSION_COOKIE_NAME}=${Buffer.alloc(32, 2).toString('base64url')}; Path=/; HttpOnly; Secure; SameSite=Lax`
            }))
        };
        const handler = authCallback.createAuthCallbackFunction({ service, env: environment() });
        const context = functionContext();
        await handler(context, {
            method: 'POST',
            body: 'code=secret-code&state=secret-state',
            headers: canonicalHeaders({ cookie: `${TRANSACTION_COOKIE_NAME}=${Buffer.alloc(32, 1).toString('base64url')}` })
        });
        expect(context.res).toMatchObject({ status: 303, headers: { Location: '/operator' } });
        expect(context.res.headers['Set-Cookie']).toContain(`${SESSION_COOKIE_NAME}=`);
        expect(context.res.headers['Set-Cookie']).not.toContain(`${TRANSACTION_COOKIE_NAME}=`);

        const failureService = {
            completeLogin: jest.fn(async () => {
                throw new BrowserAuthError(400, 'browser_auth_code_exchange_failed');
            })
        };
        const failureHandler = authCallback.createAuthCallbackFunction({ service: failureService, env: environment() });
        const failed = functionContext();
        await failureHandler(failed, {
            method: 'POST',
            body: 'code=secret-code&state=secret-state',
            headers: canonicalHeaders({ cookie: `${TRANSACTION_COOKIE_NAME}=secret-transaction` })
        });
        expect(failed.res.status).toBe(400);
        expect(JSON.stringify(failed.res)).not.toContain('secret-code');
        expect(failed.res.headers['Set-Cookie']).toBeUndefined();
        expect(failed.log.warn).toHaveBeenCalledWith(
            'Browser sign-in callback failed: browser_auth_code_exchange_failed'
        );
    });

    test('a failed matching callback never clears or replaces an active session', async () => {
        const harness = serviceHarness();
        const first = await harness.service.beginLogin({ returnTo: '/operator' });
        const active = await harness.service.completeLogin({
            body: { code: 'first-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(first.cookie)
        });
        const activeSessionCookie = requestCookie(active.cookie);
        expect(harness.store.sessions.size).toBe(1);

        const second = await harness.service.beginLogin({ returnTo: '/support' });
        const secondTransactionId = cookieValue(second.cookie);
        const secondState = harness.calls.urlRequest.state;
        harness.clientApplication.acquireTokenByCode.mockRejectedValueOnce(new Error('provider unavailable'));
        const callback = authCallback.createAuthCallbackFunction({ service: harness.service, env: harness.env });
        const failed = functionContext();
        await callback(failed, {
            method: 'POST',
            body: `code=second-code&state=${encodeURIComponent(secondState)}`,
            headers: canonicalHeaders({
                cookie: `${activeSessionCookie}; ${requestCookie(second.cookie)}`
            })
        });

        expect(failed.res.status).toBe(400);
        expect(failed.res.headers['Set-Cookie']).toContain(`${TRANSACTION_COOKIE_NAME}=`);
        expect(failed.res.headers['Set-Cookie']).toContain('Max-Age=0');
        expect(failed.res.headers['Set-Cookie']).not.toContain(`${SESSION_COOKIE_NAME}=`);
        expect(harness.store.transactions.has(secondTransactionId)).toBe(false);
        expect(harness.store.sessions.size).toBe(1);
        await expect(harness.service.readSession(activeSessionCookie)).resolves.toMatchObject({
            principalId: SUBJECT_ID,
            provider: 'entra-bff'
        });
    });

    test('an invalid transaction clears only the transaction cookie, never an active session cookie', async () => {
        const handler = authCallback.createAuthCallbackFunction({
            service: {
                completeLogin: jest.fn(async () => {
                    throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
                })
            },
            env: environment()
        });
        const context = functionContext();
        await handler(context, {
            method: 'POST',
            body: 'code=secret-code&state=secret-state',
            headers: canonicalHeaders({
                cookie: `${SESSION_COOKIE_NAME}=${Buffer.alloc(32, 2).toString('base64url')}; ` +
                    `${TRANSACTION_COOKIE_NAME}=${Buffer.alloc(32, 3).toString('base64url')}`
            })
        });

        expect(context.res.status).toBe(401);
        expect(context.res.headers['Set-Cookie']).toContain(`${TRANSACTION_COOKIE_NAME}=`);
        expect(context.res.headers['Set-Cookie']).toContain('Max-Age=0');
        expect(context.res.headers['Set-Cookie']).not.toContain(`${SESSION_COOKIE_NAME}=`);
    });

    test('session endpoint asynchronously returns only the minimal identity projection', async () => {
        const service = {
            readSessionDetails: jest.fn(async () => ({
                expiresAt: '2026-08-23T05:00:00.000Z',
                identity: {
                    email: 'joel@example.com',
                    name: 'Joel Harvey',
                    tenantId: TENANT_ID,
                    principalId: SUBJECT_ID,
                    accessToken: 'must-not-return'
                }
            }))
        };
        const handler = authSession.createAuthSessionFunction({ service, env: environment() });
        const context = functionContext();
        await handler(context, {
            method: 'GET',
            headers: canonicalHeaders({ cookie: `${COOKIE_NAME}=${Buffer.alloc(32, 2).toString('base64url')}` })
        });
        expect(context.res.body).toEqual({
            authenticated: true,
            user: {
                email: 'joel@example.com',
                name: 'Joel Harvey',
                tenantId: TENANT_ID,
                principalId: SUBJECT_ID
            },
            expiresAt: '2026-08-23T05:00:00.000Z'
        });
        expect(JSON.stringify(context.res.body)).not.toContain('token');
    });

    test('logout accepts exact origin or trusted same-origin metadata, then awaits deletion', async () => {
        const service = {
            logout: jest.fn(async () => ({ location: '/', cookie: `${COOKIE_NAME}=; Max-Age=0` }))
        };
        const handler = authLogout.createAuthLogoutFunction({ service, env: environment() });
        const sessionCookie = `${COOKIE_NAME}=${Buffer.alloc(32, 2).toString('base64url')}`;

        for (const headers of [
            canonicalHeaders({
                host: 'nofries-web-api-flex.azurewebsites.net',
                origin: 'https://nofries.nz',
                cookie: sessionCookie
            }),
            canonicalHeaders({
                host: 'nofries-web-api-flex.azurewebsites.net',
                origin: 'https://nofries.nz',
                'sec-fetch-site': 'same-origin',
                cookie: sessionCookie
            }),
            canonicalHeaders({
                host: 'nofries-web-api-flex.azurewebsites.net',
                origin: 'null',
                'sec-fetch-site': 'same-origin',
                cookie: sessionCookie
            }),
            canonicalHeaders({
                host: 'nofries-web-api-flex.azurewebsites.net',
                'sec-fetch-site': 'same-origin',
                cookie: sessionCookie
            })
        ]) {
            const accepted = functionContext();
            await handler(accepted, { method: 'POST', body: 'returnTo=%2F', headers });
            expect(accepted.res.status).toBe(303);
        }
        expect(service.logout).toHaveBeenCalledTimes(4);
        expect(service.logout).toHaveBeenCalledWith(expect.objectContaining({
            cookieHeader: expect.stringContaining(COOKIE_NAME)
        }));

        for (const headers of [
            canonicalHeaders(),
            canonicalHeaders({ origin: 'null' }),
            canonicalHeaders({ origin: 'https://nofries.nz/' }),
            canonicalHeaders({ origin: 'not a URL', 'sec-fetch-site': 'same-origin' }),
            canonicalHeaders({ origin: 'https://attacker.invalid', 'sec-fetch-site': 'same-origin' }),
            canonicalHeaders({ origin: 'https://nofries.nz:444', 'sec-fetch-site': 'same-origin' }),
            canonicalHeaders({ origin: 'https://nofries.nz', 'sec-fetch-site': 'cross-site' })
        ]) {
            const blocked = functionContext();
            await handler(blocked, { method: 'POST', body: 'returnTo=%2F', headers });
            expect(blocked.res.status).toBe(403);
        }

        const wrongMethod = functionContext();
        await handler(wrongMethod, { method: 'GET', headers: canonicalHeaders() });
        expect(wrongMethod.res).toMatchObject({
            status: 405,
            headers: { Allow: 'POST' },
            body: { code: 'method_not_allowed' }
        });
        expect(service.logout).toHaveBeenCalledTimes(4);
    });

    test('logout preserves the browser cookie when server-side revocation fails', async () => {
        const service = {
            logout: jest.fn(async () => {
                throw new BrowserAuthError(503, 'browser_auth_store_unavailable');
            })
        };
        const handler = authLogout.createAuthLogoutFunction({ service, env: environment() });
        const context = functionContext();

        await handler(context, {
            method: 'POST',
            body: 'returnTo=%2F',
            headers: canonicalHeaders({
                origin: 'https://nofries.nz',
                'sec-fetch-site': 'same-origin',
                cookie: `${COOKIE_NAME}=${Buffer.alloc(32, 3).toString('base64url')}`
            })
        });

        expect(context.res.status).toBe(503);
        expect(context.res.body).toMatchObject({ code: 'browser_auth_unavailable' });
        expect(context.res.headers['Set-Cookie']).toBeUndefined();
    });

    test('session endpoint returns 401 and clears an invalid opaque session', async () => {
        const handler = authSession.createAuthSessionFunction({
            service: {
                readSessionDetails: jest.fn(async () => {
                    throw new BrowserAuthError(401, 'browser_auth_session_invalid');
                })
            },
            env: environment()
        });
        const context = functionContext();
        await handler(context, {
            method: 'GET',
            headers: canonicalHeaders({ cookie: `${COOKIE_NAME}=tampered` })
        });
        expect(context.res.status).toBe(401);
        expect(context.res.headers['Set-Cookie']).toContain('Max-Age=0');
    });

    test('standalone async session lookup accepts an injected store and returns no tokens', async () => {
        const harness = serviceHarness();
        const started = await harness.service.beginLogin();
        const completed = await harness.service.completeLogin({
            body: { code: 'one-time-code', state: harness.calls.urlRequest.state },
            cookieHeader: requestCookie(started.cookie)
        });
        await expect(readBrowserSessionCookie(requestCookie(completed.cookie), {
            env: harness.env,
            store: harness.store,
            now: () => NOW
        })).resolves.toMatchObject({ principalId: SUBJECT_ID });
    });
});

test('only the fixed external create intent becomes a registration request', async () => {
    const service = { beginLogin: jest.fn(async () => ({ location: 'https://synthetic.example.test/authorize', cookie: 'synthetic=only' })) };
    const handler = authLogin.createAuthLoginFunction({ service, env: environment(), customerEntry: true, customerTransport: 'external' });
    const context = functionContext();
    await handler(context, { method: 'GET', query: { intent: 'create' }, headers: canonicalHeaders() });
    expect(context.res.status).toBe(302);
    expect(service.beginLogin).toHaveBeenCalledWith({ returnTo: undefined, registration: true });
});

test.each([
    ['login', { intent: 'login' }, { customerEntry: true, customerTransport: 'external' }],
    ['empty', { intent: '' }, { customerEntry: true, customerTransport: 'external' }],
    ['duplicate', { intent: ['create', 'create'] }, { customerEntry: true, customerTransport: 'external' }],
    ['account conflict', { intent: 'create', account: 'choose' }, { customerEntry: true, customerTransport: 'external' }],
    ['staff', { intent: 'create' }, {}], ['legacy', { intent: 'create' }, { customerEntry: true }]
])('invalid registration query %s is refused before starting provider work', async (_label, query, options) => {
    const service = { beginLogin: jest.fn() }, context = functionContext();
    const handler = authLogin.createAuthLoginFunction({ service, env: environment(), ...options });
    await handler(context, { method: 'GET', query, headers: canonicalHeaders({ accept: 'application/json' }) });
    expect(context.res.status).toBe(400); expect(service.beginLogin).not.toHaveBeenCalled();
});
