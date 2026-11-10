'use strict';

// Source/synthetic contracts only. No provider logout, live account selection,
// Azure access or customer acceptance is established by these tests.
const crypto = require('node:crypto');
const { createBrowserAuthService } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore, AzureBlobBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createExternalCustomerIdentityPolicy } = require('../api/shared/customerSignup/externalCustomerIdentityPolicy');
const { customerProviderKey } = require('../api/shared/customerSignup/customerIdentityProviderProfile');

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const TENANT = '33333333-3333-4333-8333-333333333333';
const APP = '44444444-4444-4444-8444-444444444444';
const SUBJECT = '55555555-5555-4555-8555-555555555555';
const STAFF = '11111111-1111-4111-8111-111111111111';
const STAFF_APP = '22222222-2222-4222-8222-222222222222';
const COOKIE = '__Host-nofries-external-customer';
const TX_COOKIE = COOKIE + '-tx';
const atom = value => value.split(';')[0];
const id = value => atom(value).split('=')[1];
const clone = value => JSON.parse(JSON.stringify(value));
const opaque = n => Buffer.alloc(32, n).toString('base64url');
const profile = { kind: 'external-id', tenantId: TENANT, clientId: APP,
    authority: 'https://synthetic-customer.ciamlogin.com/',
    issuer: `https://${TENANT}.ciamlogin.com/${TENANT}/v2.0`,
    authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${TENANT}/oauth2/v2.0/authorize` };
const binding = { customerTransport: 'external', customerProviderKey: customerProviderKey(profile) };

function harness({ external = true, mutateUrl, purpose, legacy = false } = {}) {
    const store = new MemoryBrowserSessionStore();
    let now = NOW, serial = 0, pkce = 0;
    const requests = [], admission = { reserve: jest.fn(async () => {}), recheck: jest.fn(async () => {}) };
    const removeAccount = jest.fn(async () => {});
    const basePolicy = createExternalCustomerIdentityPolicy({ profile, records: { readSubject: async () => null },
        allowNewSignup: true, signupAdmission: admission, now: () => now,
        verifyAuthentication: async ({ identity }) => ({ subjectKey: identity.subjectKey,
            email: 'synthetic@example.test', verifiedAt: now, expiresAt: now + 3600000, policySha256: 'a'.repeat(64) }),
        recheckAuthentication: async () => true });
    const policy = { ...basePolicy, begin: async () => ({ ...await basePolicy.begin(), loginHint: 'previous@example.test' }) };
    const env = { NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ENTRA_TENANT_ID: STAFF, NOFRIES_ENTRA_CLIENT_ID: STAFF_APP,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff-secret', NOFRIES_ALLOWED_SUBJECTS: `${STAFF}:${SUBJECT}`,
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: APP, NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-customer-secret' };
    const exchange = jest.fn(async input => ({ account: { localAccountId: SUBJECT },
        idTokenClaims: { aud: external ? APP : STAFF_APP, tid: external ? TENANT : STAFF, oid: SUBJECT,
            iss: external ? profile.issuer : `https://login.microsoftonline.com/${STAFF}/v2.0`,
            email: 'synthetic@example.test', nonce: input.nonce, exp: Math.floor(now / 1000) + 3600 } }));
    const service = createBrowserAuthService({ env, store, now: () => now,
        ...(purpose ? { customerPurpose: purpose } : {}),
        ...(legacy ? { customerPolicy: policy } : {}),
        ...(external ? { customerPolicy: policy, customerIdentityProvider: profile, customerTransport: 'external' } : {}),
        randomBytes: length => Buffer.alloc(length, ++serial),
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: String(++pkce).padEnd(64, 'v'),
            challenge: crypto.createHash('sha256').update(String(pkce)).digest('base64url') }) },
        clientApplication: { async getAuthCodeUrl(input) {
            requests.push(input);
            const url = new URL(external ? profile.authorizationEndpoint : `https://login.microsoftonline.com/${STAFF}/oauth2/v2.0/authorize`);
            for (const [name, value] of Object.entries({ client_id: external ? APP : STAFF_APP,
                redirect_uri: input.redirectUri, response_mode: input.responseMode, state: input.state,
                nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod,
                ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.loginHint ? { login_hint: input.loginHint } : {}) })) {
                url.searchParams.set(name, value);
            }
            if (mutateUrl) mutateUrl(url);
            return url.href;
        }, acquireTokenByCode: exchange, getTokenCache: () => ({ removeAccount }) } });
    async function callback(started) {
        return service.completeLogin({ cookieHeader: atom(started.cookie),
            body: { code: 'synthetic-only-code', state: new URL(started.location).searchParams.get('state') } });
    }
    async function login() { return callback(await service.beginLogin()); }
    return { service, store, requests, exchange, admission, removeAccount, callback, login, setNow: value => { now = value; } };
}

test('external fresh credentials are deliberate, strip the old hint and retain fresh state/nonce/PKCE and five-minute binding', async () => {
    const h = harness(), ordinary = await h.service.beginLogin(), fresh = await h.service.beginLogin({ selectAccount: true });
    expect(h.requests[0].prompt).toBeUndefined(); expect(h.requests[0].loginHint).toBe('previous@example.test');
    expect(h.requests[1].prompt).toBe('login'); expect(h.requests[1]).not.toHaveProperty('loginHint');
    expect(new URL(fresh.location).searchParams.getAll('prompt')).toEqual(['login']);
    expect(new URL(fresh.location).searchParams.has('login_hint')).toBe(false);
    const before = h.store.transactions.get(id(ordinary.cookie)), after = h.store.transactions.get(id(fresh.cookie));
    for (const key of ['state', 'nonce', 'codeVerifier']) expect(after[key]).not.toBe(before[key]);
    expect(after).toMatchObject({ ...binding, expiresAt: NOW + 300000, returnTo: '/signup' });
    expect(fresh.cookie).toContain('Max-Age=300');
    expect((await h.callback(fresh)).identity.subjectKey).toBe(`${TENANT}:${SUBJECT}`);
});

test('staff account selection remains unchanged and setup logout/selectAccount are refused without storage effects', async () => {
    const h = harness({ external: false });
    await h.service.beginLogin(); expect(h.requests[0].prompt).toBe('select_account');
    const before = clone([...h.store.transactions]);
    await expect(h.service.beginLogin({ selectAccount: true })).rejects.toMatchObject({ code: 'browser_auth_account_change_invalid' });
    await expect(h.service.logoutSetup({ cookieHeader: '' })).rejects.toMatchObject({ code: 'browser_auth_account_change_invalid' });
    expect([...h.store.transactions]).toEqual(before);
    expect(await h.login()).not.toHaveProperty('cookies');
});

test.each([false, 'login', 1, null])('non-true special request %s is rejected before a transaction', async value => {
    const h = harness();
    await expect(h.service.beginLogin({ selectAccount: value })).rejects.toMatchObject({ code: 'browser_auth_account_change_invalid' });
    expect(h.requests).toHaveLength(0); expect(h.store.transactions.size).toBe(0);
});

test.each([
    ['missing prompt', url => url.searchParams.delete('prompt')],
    ['wrong prompt', url => url.searchParams.set('prompt', 'select_account')],
    ['duplicate prompt', url => url.searchParams.append('prompt', 'login')],
    ['old hint', url => url.searchParams.set('login_hint', 'previous@example.test')],
    ['foreign origin', url => { url.hostname = 'foreign.example.test'; }],
    ['arbitrary redirect', url => url.searchParams.set('redirect_uri', 'https://foreign.example.test/')]
])('special request validates its trusted constructed URL: %s', async (_label, mutateUrl) => {
    const h = harness({ mutateUrl });
    await expect(h.service.beginLogin({ selectAccount: true })).rejects.toMatchObject({ code: 'browser_auth_provider_url_invalid' });
    expect(h.store.transactions.size).toBe(0);
});

test.each([false, true])('owned setup session can be removed %s after expiry, then repeated safely without touching competing records', async expired => {
    const h = harness(), completed = await h.login(), pending = await h.service.beginLogin();
    const otherId = opaque(210), otherTx = opaque(211), kept = { v: 1, kind: 'browser_session', purpose: 'synthetic-retained' };
    await h.store.createSession(otherId, kept); await h.store.createTransaction(otherTx, { kind: 'synthetic-retained' });
    if (expired) h.setNow(NOW + 3600000);
    const header = `${atom(completed.cookie)}; ${atom(pending.cookie)}; __Host-nofries-auth=${otherId}; __Host-nofries-customer=${otherId}; __Host-nofries-customer-tx=${otherTx}`;
    const result = await h.service.logoutSetup({ cookieHeader: header });
    expect(result.location).toBe('/signup?provider=external&account=choose');
    expect(result.cookie).toHaveLength(2);
    expect(result.cookie.map(atom)).toEqual([COOKIE + '=', TX_COOKIE + '=']);
    for (const value of result.cookie) expect(value).toContain('Max-Age=0');
    expect(h.store.sessions.has(id(completed.cookie))).toBe(false); expect(h.store.transactions.has(id(pending.cookie))).toBe(false);
    expect(h.store.sessions.get(otherId)).toEqual(kept); expect(h.store.transactions.get(otherTx)).toEqual({ kind: 'synthetic-retained' });
    await expect(h.service.logoutSetup({ cookieHeader: header })).rejects.toMatchObject({ code: 'browser_auth_account_change_pending' });
    expect(await h.service.logoutSetup({ cookieHeader: '' })).toEqual(result);
    await expect(h.callback(pending)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
    expect(h.exchange).toHaveBeenCalledTimes(1); expect(h.admission.reserve).toHaveBeenCalledTimes(1);
});

test('missing session is idempotent without a transaction cookie; a missing named transaction is ambiguous', async () => {
    const h = harness(), remove = jest.spyOn(h.store, 'deleteSession');
    await h.service.logoutSetup({ cookieHeader: '' });
    await h.service.logoutSetup({ cookieHeader: `${COOKIE}=${opaque(88)}` });
    await expect(h.service.logoutSetup({ cookieHeader: `${COOKIE}=${opaque(88)}; ${TX_COOKIE}=${opaque(89)}` }))
        .rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_account_change_pending' });
    expect(remove).not.toHaveBeenCalled(); expect(h.store.sessions.size).toBe(0);
});

test.each([
    ['admitted assurance', record => { delete record.customerAssurance.stage; }],
    ['foreign provider', record => { record.customerProviderKey = 'b'.repeat(64); }],
    ['legacy transport', record => { delete record.customerTransport; }],
    ['staff record', record => { delete record.customerAssurance; delete record.customerProviderKey; delete record.customerTransport; }],
    ['foreign tenant', record => { record.identity.tenantId = STAFF; record.identity.subjectKey = `${STAFF}:${SUBJECT}`; }],
    ['wrong subject assurance', record => { record.customerAssurance.subjectKey = `${TENANT}:${STAFF_APP}`; }],
    ['wrong assurance provider', record => { record.customerAssurance.providerKey = 'b'.repeat(64); }],
    ['malformed proof', record => { record.customerAssurance.authentication.expiresAt = 0; }],
    ['extra record field', record => { record.unowned = true; }],
    ['invalid idle expiry', record => { record.idleExpiresAt = record.issuedAt; }]
])('transplanted or malformed session (%s) is refused before even cancelling a valid pending transaction', async (_label, mutate) => {
    const h = harness(), completed = await h.login(), pending = await h.service.beginLogin();
    mutate(h.store.sessions.get(id(completed.cookie))); h.setNow(NOW + 3600000);
    const before = clone([...h.store.sessions]), txBefore = clone([...h.store.transactions]);
    const cancel = jest.spyOn(h.store, 'cancelTransaction'), remove = jest.spyOn(h.store, 'deleteSession');
    await expect(h.service.logoutSetup({ cookieHeader: `${atom(completed.cookie)}; ${atom(pending.cookie)}` })).rejects.toHaveProperty('code');
    expect([...h.store.sessions]).toEqual(before); expect([...h.store.transactions]).toEqual(txBefore);
    expect(cancel).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

test.each([
    `${COOKIE}=invalid`, `${TX_COOKIE}=invalid`, `${TX_COOKIE}=${opaque(41)}; ${TX_COOKIE}=${opaque(42)}`
])('both own cookies are parsed before storage effects: %s', async malformed => {
    const h = harness(), completed = await h.login(), read = jest.spyOn(h.store, 'loadSession'), remove = jest.spyOn(h.store, 'deleteSession');
    await expect(h.service.logoutSetup({ cookieHeader: `${atom(completed.cookie)}; ${malformed}` })).rejects.toMatchObject({ code: 'browser_auth_cookie_invalid' });
    expect(read).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

test('caller return URLs are rejected rather than converted into logout navigation authority', async () => {
    const h = harness(), completed = await h.login(), remove = jest.spyOn(h.store, 'deleteSession');
    await expect(h.service.logoutSetup({ cookieHeader: atom(completed.cookie), returnTo: 'https://foreign.example.test/' }))
        .rejects.toMatchObject({ code: 'browser_auth_account_change_invalid' });
    expect(remove).not.toHaveBeenCalled();
});

test.each(['loadSession', 'cancelTransaction', 'deleteSession'])('storage failure at %s provides no success and preserves safe retry', async method => {
    const h = harness(), completed = await h.login(), pending = await h.service.beginLogin();
    const header = `${atom(completed.cookie)}; ${atom(pending.cookie)}`;
    jest.spyOn(h.store, method).mockRejectedValueOnce(new Error('synthetic-private-error'));
    await expect(h.service.logoutSetup({ cookieHeader: header })).rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    if (method !== 'deleteSession') expect(h.store.transactions.has(id(pending.cookie))).toBe(true);
    expect(h.store.sessions.has(id(completed.cookie))).toBe(true);
    if (method === 'deleteSession') {
        await expect(h.service.logoutSetup({ cookieHeader: header })).rejects.toMatchObject({ code: 'browser_auth_account_change_pending' });
        // The five-minute transaction cookie can naturally expire. With no
        // transaction named, only the still-bound setup session is removed.
        h.setNow(NOW + 300000);
        expect((await h.service.logoutSetup({ cookieHeader: atom(completed.cookie) })).cookie).toHaveLength(2);
    } else expect((await h.service.logoutSetup({ cookieHeader: header })).cookie).toHaveLength(2);
    expect(h.store.sessions.has(id(completed.cookie))).toBe(false);
});

test('lost deletion acknowledgements remain errors, then a repeated cleanup observes absence', async () => {
    const h = harness(), completed = await h.login(), remove = h.store.deleteSession.bind(h.store);
    jest.spyOn(h.store, 'deleteSession').mockImplementationOnce(async key => { await remove(key); throw new Error('acknowledgement lost'); });
    await expect(h.service.logoutSetup({ cookieHeader: atom(completed.cookie) })).rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(h.store.sessions.size).toBe(0);
    expect((await h.service.logoutSetup({ cookieHeader: atom(completed.cookie) })).cookie).toHaveLength(2);
});

test('lost transaction-cancellation acknowledgement keeps the setup session; named missing retry remains ambiguous until cookie expiry', async () => {
    const h = harness(), completed = await h.login(), pending = await h.service.beginLogin();
    const cancel = h.store.cancelTransaction.bind(h.store), header = `${atom(completed.cookie)}; ${atom(pending.cookie)}`;
    jest.spyOn(h.store, 'cancelTransaction').mockImplementationOnce(async (...args) => {
        await cancel(...args); throw new Error('acknowledgement lost');
    });
    await expect(h.service.logoutSetup({ cookieHeader: header })).rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(h.store.transactions.has(id(pending.cookie))).toBe(false); expect(h.store.sessions.has(id(completed.cookie))).toBe(true);
    await expect(h.service.logoutSetup({ cookieHeader: header })).rejects.toMatchObject({ code: 'browser_auth_account_change_pending' });
    expect(h.store.sessions.has(id(completed.cookie))).toBe(true);
    h.setNow(NOW + 300000);
    expect((await h.service.logoutSetup({ cookieHeader: atom(completed.cookie) })).cookie).toHaveLength(2);
    expect(h.store.sessions.has(id(completed.cookie))).toBe(false);
});

test.each([null, undefined])('unverified cancellation result %s cannot clear a session or claim success', async result => {
    const h = harness(), completed = await h.login(), pending = await h.service.beginLogin();
    jest.spyOn(h.store, 'cancelTransaction').mockResolvedValueOnce(result);
    await expect(h.service.logoutSetup({ cookieHeader: `${atom(completed.cookie)}; ${atom(pending.cookie)}` }))
        .rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(h.store.sessions.has(id(completed.cookie))).toBe(true);
});

test.each([
    { v: 2, kind: 'oidc_transaction', ...binding },
    { v: 1, kind: 'browser_session', ...binding },
    { v: 1, kind: 'oidc_transaction', customerTransport: 'legacy', customerProviderKey: binding.customerProviderKey },
    { v: 1, kind: 'oidc_transaction', customerProviderKey: 'b'.repeat(64), customerTransport: 'external' }
])('foreign transaction cannot be removed through the external cookie', async record => {
    const h = harness(), completed = await h.login(), key = opaque(99);
    await h.store.createTransaction(key, record); const remove = jest.spyOn(h.store, 'deleteSession');
    await expect(h.service.logoutSetup({ cookieHeader: `${atom(completed.cookie)}; ${TX_COOKIE}=${key}` }))
        .rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
    expect(h.store.transactions.get(key)).toEqual(record); expect(remove).not.toHaveBeenCalled();
});

function blobHarness(record, { acquireError, downloadError, deleteError, underLease, releaseError } = {}) {
    let stored = record === null ? null : clone(record), leased = false;
    const releaseLease = jest.fn(async () => { leased = false; if (releaseError) throw releaseError; });
    const acquireLease = jest.fn(async () => {
        if (acquireError) throw acquireError;
        if (leased) throw Object.assign(new Error('contention'), { statusCode: 409 });
        leased = true; return {};
    });
    const blob = {
        getBlobLeaseClient: jest.fn(() => ({ acquireLease, releaseLease })),
        download: jest.fn(async (_offset, _length, options) => {
            if (downloadError) throw downloadError;
            if (stored === null) throw Object.assign(new Error('absent'), { statusCode: 404 });
            const value = options && underLease ? underLease : stored;
            return { readableStreamBody: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)); } } };
        }),
        delete: jest.fn(async options => { expect(options.conditions.leaseId).toBeTruthy();
            if (deleteError) throw deleteError; stored = null; leased = false; }),
        deleteIfExists: jest.fn(async () => { throw new Error('unguarded deletion must not be used'); })
    };
    const store = new AzureBlobBrowserSessionStore({ containerClient: {
        getProperties: jest.fn(async () => ({})), getBlockBlobClient: jest.fn(() => blob) } });
    return { store, blob, acquireLease, releaseLease, read: () => stored };
}

test('Azure cancellation checks the realm before lease and again under lease, then deletes once and makes replay absent', async () => {
    const f = blobHarness({ v: 1, kind: 'oidc_transaction', state: opaque(8), ...binding }), key = opaque(9);
    expect(await f.store.cancelTransaction(key, binding)).toBe(true);
    expect(f.blob.download).toHaveBeenNthCalledWith(1, 0);
    expect(f.blob.download.mock.calls[1][2].conditions.leaseId).toBeTruthy();
    expect(f.blob.delete).toHaveBeenCalledTimes(1); expect(f.blob.deleteIfExists).not.toHaveBeenCalled();
    expect(await f.store.cancelTransaction(key, binding)).toBe('missing');
    expect(await f.store.consumeTransaction(key, opaque(8))).toBeNull();
});

test.each([false, true])('Azure foreign record is preserved %s under a lease without falsely reporting success', async changedUnderLease => {
    const foreign = { v: 1, kind: 'oidc_transaction', ...binding, customerProviderKey: 'c'.repeat(64) };
    const f = blobHarness(changedUnderLease ? { ...foreign, ...binding } : foreign,
        changedUnderLease ? { underLease: foreign } : {});
    expect(await f.store.cancelTransaction(opaque(10), binding)).toBe(false);
    expect(f.blob.delete).not.toHaveBeenCalled();
    if (changedUnderLease) expect(f.releaseLease).toHaveBeenCalledTimes(1);
    else expect(f.acquireLease).not.toHaveBeenCalled();
});

test.each([404, 409, 412, 500])('Azure lease failure %s after a matching read remains ambiguous rather than absent success', async statusCode => {
    const f = blobHarness({ v: 1, kind: 'oidc_transaction', ...binding },
        { acquireError: Object.assign(new Error('synthetic-error'), { statusCode }) });
    await expect(f.store.cancelTransaction(opaque(11), binding)).rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(f.blob.delete).not.toHaveBeenCalled();
});

test('Azure deletion failure releases the lease and never becomes confirmed cancellation', async () => {
    const f = blobHarness({ v: 1, kind: 'oidc_transaction', ...binding }, { deleteError: new Error('acknowledgement unknown') });
    await expect(f.store.cancelTransaction(opaque(12), binding)).rejects.toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(f.releaseLease).toHaveBeenCalledTimes(1); expect(f.read()).not.toBeNull();
});

test('a callback consumed before cancellation cannot be represented as globally revoked', async () => {
    const h = harness(), started = await h.service.beginLogin();
    const completed = await h.callback(started);
    expect(h.store.transactions.has(id(started.cookie))).toBe(false);
    await expect(h.service.logoutSetup({ cookieHeader: atom(started.cookie) }))
        .rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_account_change_pending' });
    // The already-issued session is not named by this request. The operation
    // cancels current pending attempts only, never discovers/deletes all sessions.
    expect(h.store.sessions.has(id(completed.cookie))).toBe(true);
});

test('an already-consumed in-flight callback blocks setup logout without deleting the old session, then completes and clears its transaction cookie', async () => {
    const h = harness(), original = await h.login(), pending = await h.service.beginLogin();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
    const exchange = h.exchange.getMockImplementation();
    h.exchange.mockImplementationOnce(async input => { entered(); await gate; return exchange(input); });
    const completion = h.callback(pending); await reached;
    expect(h.store.transactions.has(id(pending.cookie))).toBe(false);
    await expect(h.service.logoutSetup({ cookieHeader: `${atom(original.cookie)}; ${atom(pending.cookie)}` }))
        .rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_account_change_pending' });
    expect(h.store.sessions.has(id(original.cookie))).toBe(true);
    release(); const late = await completion;
    expect(h.store.sessions.has(id(late.cookie))).toBe(true);
    expect(id(late.cookie)).not.toBe(id(original.cookie));
    expect(late.cookies).toEqual([late.cookie, expect.stringContaining(TX_COOKIE + '=;')]);
    expect(late.cookies[1]).toContain('Max-Age=0');
});

test('Azure simultaneous callback consume and cancellation have one winner; lease contention is not cancellation success', async () => {
    const record = { v: 1, kind: 'oidc_transaction', state: opaque(16), ...binding };
    const f = blobHarness(record), key = opaque(17);
    const results = await Promise.allSettled([f.store.cancelTransaction(key, binding), f.store.consumeTransaction(key, record.state)]);
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toMatchObject({ code: 'browser_auth_store_unavailable' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: { matched: true, record } });
    expect(f.blob.delete).toHaveBeenCalledTimes(1);
});

test.each([false, true])('a %s callback whose exchange crosses transaction expiry is refused before customer admission or session issuance', async external => {
    const h = harness({ external }), started = await h.service.beginLogin(), exchange = h.exchange.getMockImplementation();
    h.exchange.mockImplementationOnce(async input => {
        const result = await exchange(input); h.setNow(NOW + 300000); return result;
    });
    await expect(h.callback(started)).rejects.toMatchObject({ code: 'browser_auth_transaction_expired', clearTransactionCookie: true });
    expect(h.admission.reserve).not.toHaveBeenCalled(); expect(h.store.sessions.size).toBe(0);
    expect(h.removeAccount).toHaveBeenCalledTimes(1);
    await expect(h.callback(started)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
});

test.each([false, true])('a %s callback whose token-cache cleanup crosses expiry issues no session', async external => {
    const h = harness({ external }), started = await h.service.beginLogin();
    h.removeAccount.mockImplementationOnce(async () => { h.setNow(NOW + 300000); });
    await expect(h.callback(started)).rejects.toMatchObject({ code: 'browser_auth_transaction_expired', clearTransactionCookie: true });
    expect(h.store.sessions.size).toBe(0);
});

test.each([false, true])('a %s callback whose session save crosses expiry deletes only its new record before returning any cookie', async external => {
    const h = harness({ external }), keptId = opaque(200), retained = { kind: 'synthetic-retained-record' };
    await h.store.createSession(keptId, retained);
    const started = await h.service.beginLogin(), save = h.store.createSession.bind(h.store), remove = jest.spyOn(h.store, 'deleteSession');
    jest.spyOn(h.store, 'createSession').mockImplementationOnce(async (...args) => { await save(...args); h.setNow(NOW + 300000); });
    await expect(h.callback(started)).rejects.toMatchObject({ code: 'browser_auth_transaction_expired', clearTransactionCookie: true });
    expect(remove).toHaveBeenCalledTimes(1); expect(remove.mock.calls[0][0]).not.toBe(keptId);
    expect([...h.store.sessions]).toEqual([[keptId, retained]]);
});

test.each([false, true])('a %s expired post-save cleanup ambiguity remains unavailable and never returns a session cookie', async external => {
    const h = harness({ external }), started = await h.service.beginLogin(), save = h.store.createSession.bind(h.store);
    jest.spyOn(h.store, 'createSession').mockImplementationOnce(async (...args) => { await save(...args); h.setNow(NOW + 300000); });
    jest.spyOn(h.store, 'deleteSession').mockRejectedValueOnce(new Error('cleanup acknowledgement unknown'));
    await expect(h.callback(started)).rejects.toMatchObject({ statusCode: 503, code: 'browser_auth_store_unavailable', clearTransactionCookie: true });
    expect(h.store.sessions.size).toBe(1);
    await expect(h.callback(started)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
});


test('external registration requests a fresh create prompt without reusing a previous login hint or transaction', async () => {
    const h = harness(), ordinary = await h.service.beginLogin(), registration = await h.service.beginLogin({ registration: true });
    expect(h.requests[1].prompt).toBe('create'); expect(h.requests[1]).not.toHaveProperty('loginHint');
    expect(new URL(registration.location).searchParams.getAll('prompt')).toEqual(['create']);
    expect(new URL(registration.location).searchParams.has('login_hint')).toBe(false);
    const before = h.store.transactions.get(id(ordinary.cookie)), after = h.store.transactions.get(id(registration.cookie));
    for (const key of ['state', 'nonce', 'codeVerifier']) expect(after[key]).not.toBe(before[key]);
    expect(after).toMatchObject({ ...binding, expiresAt: NOW + 300000, returnTo: '/signup' });
    expect(after).not.toHaveProperty('registration');
    expect((await h.callback(registration)).identity.subjectKey).toBe(`${TENANT}:${SUBJECT}`);
    await expect(h.callback(registration)).rejects.toMatchObject({ code: 'browser_auth_transaction_invalid' });
    expect(h.exchange).toHaveBeenCalledTimes(1);
});

test.each([false, undefined, null, 0, 'true'])('registration presence must be exactly true: %s', async registration => {
    const h = harness();
    await expect(h.service.beginLogin({ registration })).rejects.toMatchObject({ code: 'browser_auth_registration_invalid' });
    expect(h.requests).toHaveLength(0); expect(h.store.transactions.size).toBe(0);
});

test.each([
    ['staff', { external: false }, {}], ['legacy', { external: false, legacy: true }, {}],
    ['retained read', { purpose: 'retained_read' }, {}],
    ['account choice', {}, { selectAccount: true }], ['false account choice', {}, { selectAccount: false }]
])('registration is unavailable for %s before provider or store work', async (_label, options, input) => {
    const h = harness(options);
    await expect(h.service.beginLogin({ registration: true, ...input })).rejects.toHaveProperty('code');
    expect(h.requests).toHaveLength(0); expect(h.store.transactions.size).toBe(0);
});

test.each([
    ['missing prompt', url => url.searchParams.delete('prompt')],
    ['ordinary prompt', url => url.searchParams.set('prompt', 'login')],
    ['duplicate prompt', url => url.searchParams.append('prompt', 'create')],
    ['old hint', url => url.searchParams.set('login_hint', 'previous@example.test')],
    ['foreign origin', url => { url.hostname = 'foreign.example.test'; }],
    ['redirect', url => url.searchParams.set('redirect_uri', 'https://foreign.example.test/')],
    ['state', url => url.searchParams.set('state', 'different')],
    ['nonce', url => url.searchParams.set('nonce', 'different')],
    ['PKCE', url => url.searchParams.set('code_challenge', 'different')]
])('registration retains trusted URL guards: %s', async (_label, mutateUrl) => {
    const h = harness({ mutateUrl });
    await expect(h.service.beginLogin({ registration: true })).rejects.toMatchObject({ code: 'browser_auth_provider_url_invalid' });
    expect(h.store.transactions.size).toBe(0);
});
