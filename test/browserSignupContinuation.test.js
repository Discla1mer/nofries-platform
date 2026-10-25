'use strict';

const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { SESSION_COOKIE_NAME } = require('../api/shared/browserAuth');
const { createBrowserSignupContinuation } = require('../api/shared/customerSignup/sessionBoundSignupContinuation');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createCustomerSignupRuntime } = require('../api/shared/customerSignup/customerSignupRuntime');
const SUBJECT = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const DENIED = { status: 'unavailable' };
const RECEIVED = { status: 'pending_admission' };

// Actual BFF cookie/session validation and HTTP/journal code. Only the durable
// registration/database ports and browser storage backend are synthetic.
async function fixture() {
    const f = { clock: Date.UTC(2026, 8, 17, 4), lookups: 0, queries: 0 };
    f.store = new MemoryBrowserSessionStore();
    f.id = Buffer.alloc(32, 7).toString('base64url');
    f.cookie = `${SESSION_COOKIE_NAME}=${f.id}`;
    f.identity = { provider: 'entra-bff', isAuthenticated: true, tenantId: SUBJECT.split(':')[0],
        principalId: SUBJECT.split(':')[1], subjectKey: SUBJECT, email: 'test@example.test', name: 'Test' };
    await f.store.createSession(f.id, { v: 1, kind: 'browser_session', issuedAt: f.clock,
        idleExpiresAt: f.clock + 60000, absoluteExpiresAt: f.clock + 60000, identity: f.identity });
    f.env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_ENTRA_TENANT_ID: f.identity.tenantId, NOFRIES_ALLOWED_SUBJECTS: SUBJECT };
    f.binding = { subjectKey: SUBJECT, tenantId: 'application-tenant', organisationId: 'organisation',
        invitationId: 'invitation', receiptId: 'receipt', termsVersion: 'synthetic-v1',
        termsDigest: 'a'.repeat(64), status: 'pending_admission', revision: 1 };
    const { revision, ...receipt } = f.binding;
    f.payload = { schemaVersion: 1, retentionPolicyId: 'gov-007-issued-decision-proof-7y-v1',
        deleteAfter: Date.UTC(2033, 8, 17, 4), receipt: { ...receipt, acceptedAt: f.clock, dashboardAccess: false } };
    f.database = { async withTenantTransaction(tenantId, work) {
        assert.equal(tenantId, 'application-tenant');
        return work({ async query(sql, values) {
            f.queries++;
            assert.match(sql, /^SELECT payload FROM nofries\.signup_acceptance_receipts/);
            assert.deepEqual(values, ['application-tenant', 'organisation', 'invitation']);
            if (f.beforeReturn) await f.beforeReturn();
            return { rows: [{ payload: JSON.parse(JSON.stringify(f.payload)) }] };
        } });
    } };
    f.readRegistration = async ({ subjectKey }) => { assert.equal(subjectKey, SUBJECT); f.lookups++; return f.binding; };
    f.build = () => createBrowserSignupContinuation({ browserAuthOptions: { env: f.env, store: f.store },
        readRegistration: f.readRegistration, database: f.database, now: () => f.clock });
    f.req = { method: 'GET', headers: { cookie: f.cookie } };
    return f;
}

test('actual BFF cookie connects to durable continuation through the existing HTTP state route', async () => {
    const f = await fixture();
    const handlers = createJournaledSignupHandlers({
        store: { read: async () => { throw new Error('bootstrap has gone'); }, transact: async () => { throw new Error('no writes'); } },
        verifyIdentity: async () => { throw new Error('no new acceptance'); }, database: f.database,
        resolveContext: async () => null, resolveTerms: async () => { throw new Error('no new terms'); },
        loadContinuationState: f.build()
    });
    const runtime = createCustomerSignupRuntime({ env: { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: 'https://nofries.example.test' },
        ...handlers, issueCsrfToken: async () => { throw new Error('no consent form for existing receipt'); }, validateCsrfToken: async () => false });
    assert.deepEqual(await runtime.handle(f.req, 'state'), { status: 200, body: { state: RECEIVED } });
    assert.equal(f.lookups, 2); assert.equal(f.queries, 1);
});

test('actual reader rejects forged, duplicate and absent cookies even with identity headers', async () => {
    const f = await fixture();
    for (const cookie of ['', `${SESSION_COOKIE_NAME}=forged`, `${f.cookie}; ${f.cookie}`,
        `${SESSION_COOKIE_NAME}=${Buffer.alloc(32, 9).toString('base64url')}`]) {
        assert.deepEqual(await f.build()({ headers: { cookie, 'x-ms-client-principal': 'untrusted' }, identity: f.identity }), DENIED);
    }
    assert.equal(f.lookups, 0); assert.equal(f.queries, 0);
});

test('actual session expiry withholds continuation before organisation lookup', async () => {
    const f = await fixture(); f.clock += 60000;
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(f.lookups, 0);
});

test('a changed allowed-subject policy is enforced by the actual BFF reader', async () => {
    const f = await fixture(); f.env.NOFRIES_ALLOWED_SUBJECTS = SUBJECT.replace(/2/g, '3');
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(f.lookups, 0);
});

test('actual session deletion during journal I/O is caught by the second read', async () => {
    const f = await fixture(); f.beforeReturn = () => f.store.deleteSession(f.id);
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(f.queries, 1);
});

test('receipt and session tenant are not confused with the application organisation scope', async () => {
    const f = await fixture();
    assert.notEqual(f.binding.tenantId, f.identity.tenantId);
    assert.deepEqual(await f.build()(f.req), RECEIVED);
});
