'use strict';

const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const { createSessionBoundSignupContinuation, createBrowserSignupContinuation } = require('../api/shared/customerSignup/sessionBoundSignupContinuation');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const copy = value => JSON.parse(JSON.stringify(value));
const SUBJECT = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const DENIED = { status: 'unavailable' };
const RECEIVED = { status: 'pending_admission' };

// Real scoped journal/canonical validation, with synthetic BFF, registration
// and database ports. This does not establish live Entra or PostgreSQL/RLS.
function fixture() {
    const f = { clock: Date.UTC(2026, 8, 17, 4), calls: [], sessionCount: 0, registrationCount: 0, queries: [] };
    f.details = { identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: SUBJECT.split(':')[0],
        principalId: SUBJECT.split(':')[1], subjectKey: SUBJECT, email: 'synthetic@example.test', name: 'Synthetic' },
        expiresAt: new Date(f.clock + 60000).toISOString() };
    f.binding = { subjectKey: SUBJECT, tenantId: 'logical-tenant-a', organisationId: 'org-a', invitationId: 'invite-a',
        receiptId: 'receipt-a', termsVersion: 'terms-a', termsDigest: 'a'.repeat(64), status: 'pending_admission', revision: 1 };
    const { revision, ...receipt } = f.binding;
    f.row = { schemaVersion: 1, retentionPolicyId: 'gov-007-issued-decision-proof-7y-v1',
        deleteAfter: Date.UTC(2033, 8, 17, 4), receipt: { ...receipt, acceptedAt: f.clock, dashboardAccess: false } };
    f.readSessionDetails = async cookie => {
        f.calls.push('session'); f.sessionCount++; assert.equal(cookie, 'opaque-test-cookie');
        if (f.onSession) return f.onSession(f.sessionCount);
        return copy(f.details);
    };
    f.readRegistration = async selector => {
        f.calls.push('registration'); f.registrationCount++;
        assert.deepEqual(selector, { subjectKey: SUBJECT }); assert.ok(Object.isFrozen(selector));
        if (f.onRegistration) return f.onRegistration(f.registrationCount);
        return f.binding;
    };
    f.database = { async withTenantTransaction(tenantId, work) {
        f.calls.push('database'); assert.equal(tenantId, f.expectedTenant || 'logical-tenant-a');
        if (f.onDatabase) await f.onDatabase();
        return work({ async query(sql, params) {
            assert.match(sql, /^SELECT payload FROM nofries\.signup_acceptance_receipts/);
            assert.match(sql, /tenant_id=\$1 AND organisation_id=\$2 AND invitation_id=\$3/);
            f.queries.push(params); return { rows: f.rows || (f.row ? [{ payload: copy(f.row) }] : []) };
        } });
    } };
    f.options = () => ({ readSessionDetails: f.readSessionDetails, readRegistration: f.readRegistration,
        database: f.database, now: () => f.clock });
    f.build = () => createSessionBoundSignupContinuation(f.options());
    f.req = { headers: { cookie: 'opaque-test-cookie' } };
    return f;
}

test('returns minimal durable acknowledgement with fresh session and scope checks', async () => {
    const f = fixture();
    assert.deepEqual(await f.build()(f.req), RECEIVED);
    assert.deepEqual(f.calls, ['session', 'registration', 'database', 'session', 'registration']);
    assert.deepEqual(f.queries, [['logical-tenant-a', 'org-a', 'invite-a']]);
});

test('works without bootstrap/token data and survives handler reconstruction', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.build()(f.req), RECEIVED);
    assert.equal(f.queries.length, 3);
    assert.equal(f.row.receipt.receiptId, 'receipt-a');
});

test('does not read request identity, organisation, email, query or body', async () => {
    const f = fixture();
    for (const key of ['body', 'query', 'identity', 'tenantId', 'organisationId', 'email']) {
        Object.defineProperty(f.req, key, { get() { throw new Error(`must not read ${key}`); } });
    }
    f.req.headers['x-ms-client-principal'] = 'untrusted';
    assert.deepEqual(await f.build()(f.req), RECEIVED);
});

test('supports the real host get-cookie interface, not a body-supplied credential', async () => {
    const f = fixture();
    assert.deepEqual(await f.build()({ get(name) { assert.equal(name, 'cookie'); return 'opaque-test-cookie'; } }), RECEIVED);
});

test('no cookie means no identity, scope or database lookup', async () => {
    const f = fixture();
    for (const req of [null, {}, { headers: {} }, { headers: { cookie: '' } }, { headers: { cookie: 'x'.repeat(4097) } }]) {
        assert.deepEqual(await f.build()(req), DENIED);
    }
    assert.deepEqual(f.calls, []);
});

for (const [label, change] of [
    ['unauthenticated', { isAuthenticated: false }], ['wrong provider', { provider: 'email' }],
    ['mismatched object ID', { principalId: '33333333-3333-4333-8333-333333333333' }],
    ['wrong identity tenant', { tenantId: '44444444-4444-4444-8444-444444444444' }]
]) test(`rejects ${label} session before scope lookup`, async () => {
    const f = fixture(); Object.assign(f.details.identity, change);
    assert.deepEqual(await f.build()(f.req), DENIED); assert.deepEqual(f.calls, ['session']);
});

test('expired and noncanonical session expiry cannot reach the database', async () => {
    const f = fixture();
    for (const expiresAt of [new Date(f.clock).toISOString(), 'bad-date', '2026-09-17', null, 1]) {
        f.details.expiresAt = expiresAt; assert.deepEqual(await f.build()(f.req), DENIED);
    }
    assert.equal(f.queries.length, 0);
});

test('rejects accessor, proxy and object-valued dates without evaluating them', async () => {
    const f = fixture(); let invoked = false;
    const details = { ...f.details };
    Object.defineProperty(details, 'expiresAt', { enumerable: true, get() { invoked = true; return f.details.expiresAt; } });
    f.onSession = async () => details; assert.deepEqual(await f.build()(f.req), DENIED);
    f.onSession = async () => new Proxy(f.details, { ownKeys() { invoked = true; return []; } });
    assert.deepEqual(await f.build()(f.req), DENIED);
    f.onSession = async () => ({ ...f.details, expiresAt: { toString() { invoked = true; return f.details.expiresAt; } } });
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(invoked, false);
});

for (const [label, binding] of [
    ['missing', null], ['ambiguous', []], ['revoked', { status: 'revoked' }],
    ['foreign subject', { subjectKey: SUBJECT.replace(/2/g, '3') }], ['invalid revision', { revision: -1 }],
    ['extra privilege', { dashboardAccess: true }]
]) test(`denies ${label} registration before database lookup`, async () => {
    const f = fixture(); f.onRegistration = async () => binding === null || Array.isArray(binding) ? binding : { ...f.binding, ...binding };
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(f.queries.length, 0);
});

for (const field of ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', 'termsDigest']) {
    test(`rejects mismatched durable receipt ${field}`, async () => {
        const f = fixture();
        f.row.receipt[field] = field === 'subjectKey' ? SUBJECT.replace(/2/g, '3') : field === 'termsDigest' ? 'b'.repeat(64) : 'different';
        assert.deepEqual(await f.build()(f.req), DENIED);
    });
}

test('missing, duplicate, corrupt or already-privileged receipts never acknowledge', async () => {
    for (const mode of ['missing', 'duplicate', 'corrupt', 'access', 'future']) {
        const f = fixture();
        if (mode === 'missing') f.row = null;
        if (mode === 'duplicate') f.rows = [{ payload: copy(f.row) }, { payload: copy(f.row) }];
        if (mode === 'corrupt') f.row.retentionPolicyId = 'wrong-policy';
        if (mode === 'access') f.row.receipt.dashboardAccess = true;
        if (mode === 'future') { f.row.receipt.acceptedAt += 1; f.row.deleteAfter += 1; }
        assert.deepEqual(await f.build()(f.req), DENIED, mode);
    }
});

test('logout or account switch during database work withholds acknowledgement', async () => {
    for (const mode of ['logout', 'switch']) {
        const f = fixture();
        f.onSession = async count => {
            if (count === 1) return copy(f.details);
            if (mode === 'logout') return null;
            const details = copy(f.details); details.identity.principalId = details.identity.principalId.replace(/2/g, '3');
            details.identity.subjectKey = `${details.identity.tenantId}:${details.identity.principalId}`; return details;
        };
        assert.deepEqual(await f.build()(f.req), DENIED);
    }
});

test('scope revocation, revision or terms change during database work fails closed', async () => {
    for (const change of [{ status: 'revoked' }, { revision: 2 }, { termsDigest: 'b'.repeat(64) }, { organisationId: 'other' }]) {
        const f = fixture();
        f.onRegistration = async count => count === 1 ? f.binding : { ...f.binding, ...change };
        assert.deepEqual(await f.build()(f.req), DENIED);
    }
});

test('expiry during scope lookup stops before database access', async () => {
    const f = fixture();
    f.onRegistration = async () => { f.clock += 60000; return f.binding; };
    assert.deepEqual(await f.build()(f.req), DENIED); assert.equal(f.queries.length, 0);
});

test('expiry or a backwards clock during database access withholds success', async () => {
    for (const delta of [60000, -1]) {
        const f = fixture(); f.onDatabase = async () => { f.clock += delta; };
        assert.deepEqual(await f.build()(f.req), DENIED);
    }
});

test('snapshots registration primitives before provider objects can mutate', async () => {
    const f = fixture(); f.onDatabase = async () => { f.binding.receiptId = 'changed-after-read'; };
    assert.deepEqual(await f.build()(f.req), DENIED);
    assert.deepEqual(f.queries[0], ['logical-tenant-a', 'org-a', 'invite-a']);
});

test('provider errors are sanitised and a subsequent explicit retry can succeed', async () => {
    for (const port of ['onSession', 'onRegistration', 'onDatabase']) {
        const f = fixture(); f[port] = async () => { throw new Error('private-details-and-secret'); };
        assert.deepEqual(await f.build()(f.req), DENIED);
        f[port] = null; assert.deepEqual(await f.build()(f.req), RECEIVED);
    }
});

test('a different user and logical organisation use the same implementation', async () => {
    const f = fixture(), other = SUBJECT.replace(/2/g, '3');
    f.details.identity.principalId = other.split(':')[1]; f.details.identity.subjectKey = other;
    f.binding.subjectKey = other; f.binding.tenantId = 'logical-tenant-b'; f.binding.organisationId = 'org-b';
    f.row.receipt.subjectKey = other; f.row.receipt.tenantId = 'logical-tenant-b'; f.row.receipt.organisationId = 'org-b';
    f.expectedTenant = 'logical-tenant-b';
    f.readRegistration = async selector => { assert.equal(selector.subjectKey, other); return copy(f.binding); };
    assert.deepEqual(await f.build()(f.req), RECEIVED);
});

function composition(continuation, resolveContext = async () => null) {
    return createJournaledSignupHandlers({
        store: { read: async () => null, transact: async () => { throw new Error('must not write'); } },
        verifyIdentity: async () => { throw new Error('missing original identity proof'); },
        database: { withTenantTransaction: async () => { throw new Error('must not query this invitation store'); } },
        resolveContext, resolveTerms: async () => { throw new Error('must not accept or load new terms'); },
        loadContinuationState: continuation
    });
}

test('composes the session-bound path only after explicit bootstrap absence', async () => {
    const f = fixture(); assert.deepEqual(await composition(f.build()).loadState(f.req), RECEIVED);
});

test('does not turn a thrown, malformed or rejected invitation into continuation', async () => {
    let calls = 0;
    const continuation = async () => { calls++; return RECEIVED; };
    for (const value of [undefined, {}, { invitationToken: 'invalid', identityProofHandle: 'x' }]) {
        assert.deepEqual(await composition(continuation, async () => value).loadState({}), DENIED);
    }
    assert.deepEqual(await composition(continuation, async () => { throw new Error('revoked'); }).loadState({}), DENIED);
    assert.equal(calls, 0);
});

test('rejects an overbroad continuation projection or access-granting state', async () => {
    for (const value of [{ ...RECEIVED, subjectKey: SUBJECT }, { status: 'active' }, { status: 'terms' }, null]) {
        assert.deepEqual(await composition(async () => value).loadState({}), DENIED);
    }
});

test('post-bootstrap continuation cannot be used to accept terms or issue access', async () => {
    const f = fixture(), handlers = composition(f.build());
    await assert.rejects(handlers.acceptTerms({ req: f.req, input: {
        accepted: true, termsVersion: 'terms-a', termsDigest: 'a'.repeat(64)
    } }), error => error.code === 'signup_identity_required');
    assert.deepEqual(f.calls, []);
});

test('invalid dependency and browser-auth configuration is rejected before I/O', () => {
    const f = fixture();
    for (const change of [{ readSessionDetails: null }, { readRegistration: null }, { now: null }, { extra: true }]) {
        assert.throws(() => createSessionBoundSignupContinuation({ ...f.options(), ...change }));
    }
    for (const auth of [{}, { env: {}, store: {} }, { env: { NOFRIES_REQUIRE_AUTH: 'false',
        NOFRIES_BROWSER_AUTH_MODE: 'swa', NOFRIES_ENTRA_TENANT_ID: SUBJECT.split(':')[0], NOFRIES_ALLOWED_SUBJECTS: SUBJECT }, store: {} }]) {
        assert.throws(() => createBrowserSignupContinuation({ browserAuthOptions: auth, readRegistration: f.readRegistration, database: f.database }));
    }
    assert.deepEqual(f.calls, []);
});
