const {
    SESSION_COOKIE_NAME
} = require('../api/shared/browserAuth');
const {
    BrowserSessionStoreError,
    MemoryBrowserSessionStore
} = require('../api/shared/browserSessionStore');
const {
    getProductRequestIdentity,
    resetRequestIdentityForTests
} = require('../api/shared/identity');

const TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
const SUBJECT_ID = 'acada13b-5614-49d6-a356-88d816aa0a3c';
const SESSION_ID = Buffer.alloc(32, 19).toString('base64url');
const NOW = Date.parse('2026-08-23T01:00:00.000Z');

function environment(overrides = {}) {
    return Object.assign({
        NODE_ENV: 'production',
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_ENTRA_TENANT_ID: TENANT_ID,
        NOFRIES_ALLOWED_SUBJECTS: `${TENANT_ID}:${SUBJECT_ID}`
    }, overrides);
}

function browserIdentity(overrides = {}) {
    return Object.assign({
        email: 'joel@nofries.nz',
        name: 'Joel Harvey',
        provider: 'entra-bff',
        principalId: SUBJECT_ID,
        tenantId: TENANT_ID,
        subjectKey: `${TENANT_ID}:${SUBJECT_ID}`,
        isAuthenticated: true
    }, overrides);
}

function sessionRecord(overrides = {}) {
    return Object.assign({
        v: 1,
        kind: 'browser_session',
        issuedAt: NOW,
        idleExpiresAt: NOW + (4 * 60 * 60 * 1000),
        absoluteExpiresAt: NOW + (4 * 60 * 60 * 1000),
        identity: browserIdentity()
    }, overrides);
}

function principal(email = 'forged-admin@example.invalid', tenantId = 'forged-tenant') {
    return Buffer.from(JSON.stringify({
        identityProvider: 'aad',
        userId: 'forged-principal-id',
        userDetails: email,
        claims: [
            { typ: 'tid', val: tenantId },
            { typ: 'name', val: 'Forged Administrator' }
        ]
    })).toString('base64');
}

function request(overrides = {}) {
    return Object.assign({
        headers: {},
        body: {},
        query: {}
    }, overrides);
}

async function seededStore(record = sessionRecord()) {
    const store = new MemoryBrowserSessionStore();
    await store.createSession(SESSION_ID, record);
    return store;
}

beforeEach(() => {
    resetRequestIdentityForTests();
});

describe('phase-two product request identity', () => {
    test('keeps legacy SWA identity resolution only while explicitly in swa mode', async () => {
        const env = environment({ NOFRIES_BROWSER_AUTH_MODE: 'swa' });
        const store = {
            loadSession: jest.fn(async () => {
                throw new Error('the BFF store must not be called in SWA mode');
            })
        };
        const identity = await getProductRequestIdentity(request({
            headers: { 'x-ms-client-principal': principal('legacy@example.com', TENANT_ID) }
        }), env, { store });

        expect(identity).toMatchObject({
            email: 'legacy@example.com',
            provider: 'aad',
            tenantId: TENANT_ID,
            isAuthenticated: true
        });
        expect(store.loadSession).not.toHaveBeenCalled();
    });

    test('fails closed for an invalid browser authentication mode', async () => {
        await expect(getProductRequestIdentity(request(), environment({
            NOFRIES_BROWSER_AUTH_MODE: 'password_bypass'
        }), { store: new MemoryBrowserSessionStore() })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'browser_auth_unavailable' }
        });
    });

    test('fails closed when hosted browser authentication mode is omitted', async () => {
        const env = environment();
        delete env.NOFRIES_BROWSER_AUTH_MODE;

        await expect(getProductRequestIdentity(request(), env, {
            store: new MemoryBrowserSessionStore()
        })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'browser_auth_unavailable' }
        });
    });

    test('returns authentication_required when the opaque session cookie is missing', async () => {
        const forgedRequest = request({
            headers: {
                'x-ms-client-principal': principal(),
                'x-nofries-email': 'forged-admin@example.invalid'
            },
            body: { email: 'forged-admin@example.invalid', name: 'Forged Administrator' },
            query: { email: 'forged-admin@example.invalid', name: 'Forged Administrator' }
        });

        await expect(getProductRequestIdentity(
            forgedRequest,
            environment(),
            { store: new MemoryBrowserSessionStore(), now: () => NOW }
        )).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'authentication_required' }
        });
    });

    test('returns only the valid opaque-session identity and ignores every forged legacy identity source', async () => {
        const store = await seededStore();
        const identity = await getProductRequestIdentity(request({
            headers: {
                cookie: `${SESSION_COOKIE_NAME}=${SESSION_ID}`,
                'x-ms-client-principal': principal(),
                'x-nofries-email': 'forged-admin@example.invalid'
            },
            body: { email: 'forged-admin@example.invalid', name: 'Forged Administrator' },
            query: { email: 'forged-admin@example.invalid', name: 'Forged Administrator' }
        }), environment(), { store, now: () => NOW });

        expect(identity).toEqual(browserIdentity());
        expect(identity.email).not.toBe('forged-admin@example.invalid');
        expect(identity.provider).toBe('entra-bff');
    });

    test('maps an expired stored session to authentication_required and deletes it', async () => {
        const store = await seededStore(sessionRecord({
            issuedAt: NOW - (4 * 60 * 60 * 1000),
            idleExpiresAt: NOW,
            absoluteExpiresAt: NOW
        }));

        await expect(getProductRequestIdentity(request({
            headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_ID}` }
        }), environment(), { store, now: () => NOW })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'authentication_required' }
        });
        expect(store.sessions.has(SESSION_ID)).toBe(false);
    });

    test('maps a session-store outage to browser_auth_unavailable rather than authentication failure', async () => {
        const store = {
            loadSession: jest.fn(async () => {
                throw new BrowserSessionStoreError('browser_auth_store_unavailable');
            }),
            deleteSession: jest.fn(async () => {})
        };

        await expect(getProductRequestIdentity(request({
            headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_ID}` }
        }), environment(), { store, now: () => NOW })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'browser_auth_unavailable' }
        });
        expect(store.deleteSession).not.toHaveBeenCalled();
    });
});
