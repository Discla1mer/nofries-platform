'use strict';

const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const { createInvitation } = require('../api/shared/customerSignup/invitationAcceptance');
const { createJournaledTermsAcceptance } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createCustomerSignupRuntime, customerSignupErrorResponse } = require('../api/shared/customerSignup/customerSignupRuntime');
const { RETENTION_POLICY_ID } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const TERMS = Object.freeze({ accepted: true, termsVersion: 'synthetic-production-v1', termsDigest: 'a'.repeat(64) });
const SUBJECT = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';

// Real invitation domain, journal SQL and HTTP boundary; only their external
// storage/identity ports are synthetic. This is not a live RLS or Entra test.
function fixture() {
    const f = {
        clock: Date.UTC(2026, 8, 17, 2), records: new Map(), rows: new Map(),
        contexts: new Map(), proofs: new Map(), events: [], dbMode: null,
        storeMode: null, resolveCount: 0, verifyCount: 0, dbCount: 0, readCount: 0, storeReads: 0
    };
    let storeTail = Promise.resolve();
    let dbTail = Promise.resolve();
    f.store = {
        async read(digest) {
            f.storeReads++;
            if (f.readStoreMode) throw new Error('private-blob-read-failure');
            return f.records.has(digest) ? copy(f.records.get(digest)) : null;
        },
        transact(digest, callback) {
        const operation = storeTail.then(async () => {
            f.events.push('invitation-start');
            if (f.storeMode === 'before') { f.storeMode = null; throw new Error('internal-store-failure'); }
            const value = f.records.get(digest);
            const changed = await callback(value ? copy(value) : null);
            if (f.storeMode === 'write') { f.storeMode = null; throw new Error('blob-write-failed'); }
            f.records.set(digest, copy(changed.record));
            f.events.push('invitation-commit');
            if (f.storeMode === 'after') { f.storeMode = null; throw new Error('ambiguous-store-commit'); }
            return copy(changed.result);
        });
        storeTail = operation.catch(() => {});
        return operation;
    } };
    f.database = { withTenantTransaction(tenantId, callback) {
        const operation = dbTail.then(async () => {
            let writing = false, mode;
            const staged = new Map([...f.rows].map(([key, value]) => [key, copy(value)]));
            const result = await callback({ async query(sql, values) {
                assert.equal(values[0], tenantId, 'the journal must use its receipt tenant');
                if (/invitation_id=\$3/.test(sql)) {
                    f.readCount++; f.events.push('journal-lookup');
                    if (f.readMode === 'failure') throw new Error('private-read-failure');
                    const rows = [...staged.values()].filter(row => row.receipt.tenantId === values[0] &&
                        row.receipt.organisationId === values[1] && row.receipt.invitationId === values[2]);
                    return { rows: rows.map(payload => ({ payload: copy(payload) })) };
                }
                const key = values.slice(0, 3).join('|');
                if (/^\s*INSERT INTO nofries\.signup_acceptance_receipts/.test(sql)) {
                    writing = true; f.dbCount++; mode = f.dbMode; f.dbMode = null;
                    f.events.push('journal-start');
                    if (mode === 'before') throw new Error('private-database-detail');
                    assert.equal(values.length, 13);
                    f.events.push('journal-insert');
                    if (staged.has(key)) return { rows: [] };
                    const payload = JSON.parse(values[12]);
                    assert.equal(payload.receipt.tenantId, tenantId);
                    assert.equal(payload.receipt.organisationId, values[1]);
                    assert.equal(payload.receipt.receiptId, values[2]);
                    // Mirror the real database's unique invitation constraint.
                    assert.ok(![...staged.values()].some(row => row.receipt.tenantId === values[0] &&
                        row.receipt.organisationId === values[1] && row.receipt.invitationId === values[3]));
                    staged.set(key, payload);
                    if (mode === 'corrupt') payload.receipt.termsDigest = 'b'.repeat(64);
                    return { rows: [{ payload: copy(payload) }] };
                }
                assert.match(sql, /^\s*SELECT payload FROM nofries\.signup_acceptance_receipts/);
                f.events.push('journal-read');
                return { rows: staged.has(key) ? [{ payload: copy(staged.get(key)) }] : [] };
            } });
            if (writing) {
                if (mode === 'wait') { f.events.push('journal-wait'); await f.commitGate; }
                f.rows = staged; f.events.push('journal-commit');
                if (mode === 'after') throw new Error('ambiguous-database-commit');
            }
            return result;
        });
        dbTail = operation.catch(() => {});
        return operation;
    } };
    f.resolveContext = async req => {
        f.resolveCount++;
        if (f.resolveGate) await f.resolveGate;
        return f.contexts.get(req.sessionKey);
    };
    f.verifyIdentity = async ({ handle, invitationDigest }) => {
        f.verifyCount++;
        const proof = f.proofs.get(handle);
        if (!proof || proof.invitationDigest !== invitationDigest) throw new Error('private-identity-detail');
        return { ...proof, verifiedAt: f.clock, expiresAt: f.clock + 60000, ...f.proofOverride };
    };
    f.options = () => ({ store: f.store, verifyIdentity: f.verifyIdentity, database: f.database,
        resolveContext: f.resolveContext, now: () => f.clock });
    f.build = () => createJournaledTermsAcceptance(f.options());
    f.add = (tag = 'a', tenantId = `tenant-${tag}`, organisationId = `org-${tag}`, subjectKey = SUBJECT) => {
        const issued = createInvitation({ email: `${tag}@example.test`, tenantId, organisationId,
            identityPolicyId: 'synthetic-identity-policy', termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest,
            mfaRequired: true, createdAt: f.clock, expiresAt: f.clock + 3600000 }, { now: () => f.clock });
        f.records.set(issued.record.tokenDigest, copy(issued.record));
        const handle = `server-held-${tag}`;
        f.contexts.set(tag, { invitationToken: issued.invitationToken, identityProofHandle: handle });
        f.proofs.set(handle, { subjectKey, email: `${tag}@example.test`, emailVerified: true,
            identityPolicyId: 'synthetic-identity-policy', mfaSatisfied: true, invitationDigest: issued.record.tokenDigest });
        return { req: { sessionKey: tag }, input: { ...TERMS }, digest: issued.record.tokenDigest,
            token: issued.invitationToken, handle };
    };
    f.command = user => ({ req: user.req, input: user.input });
    f.runtime = () => createCustomerSignupRuntime({
        env: { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: 'https://signup.example.test' },
        loadState: async () => ({ status: 'terms', termsText: 'Synthetic test terms',
            termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest }),
        acceptTerms: f.build(), issueCsrfToken: async () => 'x'.repeat(43),
        validateCsrfToken: async (_req, token) => token === 'x'.repeat(43)
    });
    f.request = user => ({ method: 'POST', sessionKey: user.req.sessionKey,
        headers: { origin: 'https://signup.example.test', 'x-csrf-token': 'x'.repeat(43) }, body: user.input });
    return f;
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('composes the real HTTP handler, invitation acceptance and journal before acknowledging', async () => {
    const f = fixture(), user = f.add();
    const result = await f.runtime().handle(f.request(user), 'terms');
    assert.deepEqual(result, { status: 200, body: { state: { status: 'pending_admission' } } });
    assert.deepEqual(f.events, ['invitation-start', 'journal-lookup', 'journal-start', 'journal-insert', 'journal-commit', 'invitation-commit']);
    assert.equal(f.rows.size, 1);
    const stored = [...f.rows.values()][0];
    assert.equal(stored.receipt.dashboardAccess, false);
    assert.equal(stored.retentionPolicyId, RETENTION_POLICY_ID);
    assert.equal(stored.deleteAfter, Date.UTC(2033, 8, 17, 2));
    for (const secret of [user.token, user.handle]) {
        assert.ok(!JSON.stringify(stored).includes(secret));
        assert.ok(!JSON.stringify(result).includes(secret));
    }
});

test('does not resolve while the durable transaction acknowledgement is delayed', async () => {
    const f = fixture(), user = f.add(); let release;
    f.commitGate = new Promise(resolve => { release = resolve; }); f.dbMode = 'wait';
    let resolved = false;
    const pending = f.build()(f.command(user)).then(value => { resolved = true; return value; });
    await tick(); assert.ok(f.events.includes('journal-wait')); assert.equal(resolved, false);
    assert.equal(f.rows.size, 0); release();
    assert.deepEqual(await pending, { status: 'pending_admission' });
});

test('database failure leaves no transient acceptance and a restarted callback persists one receipt', async () => {
    const f = fixture(), user = f.add(); f.dbMode = 'before';
    await rejectsCode(f.build()(f.command(user)), 'signup_acceptance_journal_unavailable');
    assert.equal(f.records.get(user.digest).status, 'invited');
    assert.equal(f.records.get(user.digest).acceptance, null); assert.equal(f.rows.size, 0);
    f.clock += 1000;
    assert.deepEqual(await f.build()(f.command(user)), { status: 'pending_admission' });
    assert.deepEqual([...f.rows.values()][0].receipt, f.records.get(user.digest).acceptance);
    assert.equal([...f.rows.values()][0].receipt.acceptedAt, f.clock);
    assert.equal(f.records.get(user.digest).revision, 1);
});

test('ambiguous database commit reconciles exactly and creates no duplicate', async () => {
    const f = fixture(), user = f.add(); f.dbMode = 'after';
    await rejectsCode(f.build()(f.command(user)), 'signup_acceptance_journal_unavailable');
    const stored = copy([...f.rows.values()][0]); f.clock += 1000;
    await f.build()(f.command(user));
    assert.equal(f.rows.size, 1); assert.deepEqual([...f.rows.values()][0], stored);
    assert.ok(f.events.includes('journal-read'));
});

test('ambiguous invitation commit never journals a different acceptance on retry', async () => {
    const f = fixture(), user = f.add(); f.storeMode = 'after';
    await rejectsCode(f.build()(f.command(user)), 'signup_store_unavailable');
    const receipt = copy(f.records.get(user.digest).acceptance); assert.equal(f.dbCount, 1);
    assert.deepEqual([...f.rows.values()][0].receipt, receipt);
    await f.build()(f.command(user)); assert.deepEqual([...f.rows.values()][0].receipt, receipt);
});

test('concurrent matching accepts use one immutable receipt', async () => {
    const f = fixture(), user = f.add(), accept = f.build();
    const results = await Promise.all(Array.from({ length: 4 }, () => accept(f.command(user))));
    assert.ok(results.every(value => value.status === 'pending_admission'));
    assert.equal(f.rows.size, 1); assert.equal(f.records.get(user.digest).revision, 1);
});

test('a conflicting durable receipt fails without overwriting the record', async () => {
    const f = fixture(), user = f.add(), accept = f.build(); await accept(f.command(user));
    const row = [...f.rows.values()][0]; row.receipt.termsDigest = 'b'.repeat(64);
    const before = copy(row);
    await rejectsCode(accept(f.command(user)), 'signup_acceptance_journal_conflict');
    assert.deepEqual([...f.rows.values()][0], before);
});

test('the same callback supports another user and organisation without source changes', async () => {
    const f = fixture(), a = f.add('a'), b = f.add('b', 'tenant-b', 'org-b', SUBJECT.replace(/2/g, '3'));
    const accept = f.build(); await accept(f.command(a)); await accept(f.command(b));
    assert.equal(f.rows.size, 2);
    assert.deepEqual([...f.rows.values()].map(row => row.receipt.tenantId).sort(), ['tenant-a', 'tenant-b']);
    assert.ok([...f.rows.values()].every(row => row.receipt.dashboardAccess === false));
});

test('wrong identity cannot reuse an accepted invitation or write the journal', async () => {
    const f = fixture(), user = f.add(), accept = f.build(); await accept(f.command(user));
    f.proofOverride = { subjectKey: SUBJECT.replace(/2/g, '3') };
    await rejectsCode(accept(f.command(user)), 'signup_invitation_unavailable'); assert.equal(f.dbCount, 1);
});

test('revocation blocks replay even after a journal error', async () => {
    const f = fixture(), user = f.add(); f.dbMode = 'before';
    await rejectsCode(f.build()(f.command(user)), 'signup_acceptance_journal_unavailable');
    f.records.get(user.digest).status = 'revoked';
    await rejectsCode(f.build()(f.command(user)), 'signup_invitation_unavailable'); assert.equal(f.rows.size, 0);
});

test('an expired new invitation is rejected before journaling', async () => {
    const f = fixture(), user = f.add(); f.clock += 3600001;
    await rejectsCode(f.build()(f.command(user)), 'signup_invitation_unavailable'); assert.equal(f.dbCount, 0);
});

test('changed terms are rejected and cannot be journaled as the invited version', async () => {
    const f = fixture(), user = f.add(); user.input.termsDigest = 'b'.repeat(64);
    await rejectsCode(f.build()(f.command(user)), 'signup_terms_changed'); assert.equal(f.dbCount, 0);
});

test('missing MFA is denied by the real invitation domain before durable storage', async () => {
    const f = fixture(), user = f.add(); f.proofOverride = { mfaSatisfied: false };
    await rejectsCode(f.build()(f.command(user)), 'signup_invitation_unavailable'); assert.equal(f.dbCount, 0);
});

test('unverified email cannot be replaced by request-supplied verification claims', async () => {
    const f = fixture(), user = f.add(); f.proofOverride = { emailVerified: false };
    user.req.emailVerified = true; user.req.tenantId = 'tenant-b';
    await rejectsCode(f.build()(f.command(user)), 'signup_identity_required'); assert.equal(f.dbCount, 0);
});

test('a lost transient invitation fails closed rather than inventing a new acceptance', async () => {
    const f = fixture(), user = f.add(); f.records.clear();
    await rejectsCode(f.build()(f.command(user)), 'signup_invitation_unavailable'); assert.equal(f.dbCount, 0);
});

test('rejects body-supplied identity and tenant fields before resolving context', async () => {
    for (const key of ['invitationToken', 'identityProofHandle', 'tenantId', 'organisationId', 'subjectKey']) {
        const f = fixture(), user = f.add(); user.input[key] = 'not-trusted';
        await rejectsCode(f.build()(f.command(user)), 'signup_request_invalid');
        assert.equal(f.resolveCount, 0); assert.equal(f.dbCount, 0);
    }
});

test('rejects accessors and proxies without evaluating attacker-controlled properties', async () => {
    const f = fixture(), user = f.add(); let invoked = false;
    const input = { ...TERMS }; Object.defineProperty(input, 'accepted', { enumerable: true, get() { invoked = true; return true; } });
    await rejectsCode(f.build()({ req: user.req, input }), 'signup_request_invalid');
    await rejectsCode(f.build()({ req: user.req, input: new Proxy({ ...TERMS }, { ownKeys() { invoked = true; return []; } }) }), 'signup_request_invalid');
    assert.equal(invoked, false); assert.equal(f.resolveCount, 0);
});

test('snapshots confirmed terms before asynchronous identity context resolution', async () => {
    const f = fixture(), user = f.add(); let release;
    f.resolveGate = new Promise(resolve => { release = resolve; });
    const pending = f.build()(f.command(user));
    user.input.accepted = false; user.input.termsVersion = 'different'; user.input.termsDigest = 'b'.repeat(64);
    release(); await pending; assert.equal([...f.rows.values()][0].receipt.termsVersion, TERMS.termsVersion);
});

test('context resolution failure is sanitised and never writes a receipt', async () => {
    const f = fixture(), user = f.add();
    const accept = createJournaledTermsAcceptance({ ...f.options(), resolveContext: async () => { throw new Error(user.token); } });
    await assert.rejects(accept(f.command(user)), error => error.code === 'signup_identity_required' && !error.message.includes(user.token));
    assert.equal(f.verifyCount, 0); assert.equal(f.dbCount, 0);
});

test('an overbroad context is rejected rather than trusting its organisation or subject', async () => {
    const f = fixture(), user = f.add(); f.contexts.get('a').tenantId = 'attacker-tenant';
    await rejectsCode(f.build()(f.command(user)), 'signup_identity_required'); assert.equal(f.dbCount, 0);
});

test('invalid dependencies fail at construction without starting any transaction', () => {
    const f = fixture();
    for (const changes of [{ database: null }, { resolveContext: null }, { now: 'clock' }, { unexpected: true }]) {
        assert.throws(() => createJournaledTermsAcceptance({ ...f.options(), ...changes }));
    }
    assert.equal(f.dbCount, 0);
});

test('actual HTTP origin, CSRF and request-size guards prevent acceptance', async () => {
    const f = fixture(), user = f.add(), runtime = f.runtime();
    let req = f.request(user); req.headers.origin = 'https://other.example.test';
    await assert.rejects(runtime.handle(req, 'terms'), error => error.statusCode === 403);
    req = f.request(user); req.headers['x-csrf-token'] = 'z'.repeat(43);
    await rejectsCode(runtime.handle(req, 'terms'), 'signup_csrf_invalid');
    req = f.request(user); req.headers['content-length'] = '20000';
    await rejectsCode(runtime.handle(req, 'terms'), 'request_too_large');
    assert.equal(f.resolveCount, 0); assert.equal(f.dbCount, 0);
});

test('actual HTTP runtime returns no success or internal details on journal failure', async () => {
    const f = fixture(), user = f.add(); f.dbMode = 'before';
    let failure;
    await assert.rejects(f.runtime().handle(f.request(user), 'terms'), error => {
        failure = error; return error.statusCode === 503 && error.code === 'signup_unavailable';
    });
    const response = customerSignupErrorResponse(failure);
    assert.deepEqual(response, { status: 503, body: { error: 'Signup is unavailable', code: 'signup_unavailable' } });
    assert.equal(f.rows.size, 0);
});

test('explicit consent is required before any identity or storage work', async () => {
    for (const accepted of [false, 'true', 1, null]) {
        const f = fixture(), user = f.add(); user.input.accepted = accepted;
        await rejectsCode(f.build()(f.command(user)), 'signup_terms_required');
        assert.equal(f.resolveCount, 0); assert.equal(f.dbCount, 0);
    }
});

test('a corrupted insert acknowledgement is not treated as a successful commit', async () => {
    const f = fixture(), user = f.add(); f.dbMode = 'corrupt';
    await rejectsCode(f.build()(f.command(user)), 'signup_acceptance_journal_conflict');
    assert.equal(f.rows.size, 0);
});

test('an invitation-store failure never starts a durable journal transaction', async () => {
    const f = fixture(), user = f.add(); f.storeMode = 'before';
    await rejectsCode(f.build()(f.command(user)), 'signup_store_unavailable');
    assert.equal(f.dbCount, 0); assert.equal(f.records.get(user.digest).status, 'invited');
});

test('two organisations in one tenant keep different immutable acceptance records', async () => {
    const f = fixture(), a = f.add('a', 'tenant-a', 'org-a'), b = f.add('b', 'tenant-a', 'org-b');
    const accept = f.build(); await accept(f.command(a)); await accept(f.command(b));
    assert.equal(f.rows.size, 2);
    assert.deepEqual([...f.rows.values()].map(row => row.receipt.organisationId).sort(), ['org-a', 'org-b']);
});

// The recovery contract is deliberately tested with both the transaction port
// above and the real Azure Blob adapter below. External services remain mocked.
const { createHash } = require('node:crypto');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createPostgresSignupAcceptanceJournal } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const { createInvitationAcceptance } = require('../api/shared/customerSignup/invitationAcceptance');
const { AzureBlobSignupInvitationStore } = require('../api/shared/customerSignup/azureBlobInvitationStore');
const TERMS_TEXT = 'Synthetic production terms for deterministic testing only.';
const TEXT_DIGEST = createHash('sha256').update(TERMS_TEXT).digest('hex');

function handlers(f, user, changes = {}) {
    user.input.termsDigest = TEXT_DIGEST;
    f.records.get(user.digest).termsDigest = TEXT_DIGEST;
    return createJournaledSignupHandlers({ ...f.options(), resolveTerms: async reference => ({
        termsText: TERMS_TEXT, termsVersion: reference.termsVersion, termsDigest: reference.termsDigest
    }), ...changes });
}

test('digest-only context requires explicit server composition and matching verified identity', async () => {
    const f = fixture(), user = f.add();
    f.contexts.set('a', { invitationDigest: user.digest, identityProofHandle: user.handle });
    const defaultService = handlers(f, user);
    assert.deepEqual(await defaultService.loadState(user.req), { status: 'unavailable' });
    await assert.rejects(defaultService.acceptTerms(f.command(user)));
    const service = handlers(f, user, { contextMode: 'verified-digest' });
    assert.equal((await service.loadState(user.req)).status, 'terms');
    f.proofOverride = { invitationDigest: 'b'.repeat(64) };
    await assert.rejects(service.acceptTerms(f.command(user)));
    assert.equal(f.rows.size, 0);
    f.proofOverride = {};
    await service.acceptTerms(f.command(user));
    assert.equal(f.rows.size, 1);
    assert.deepEqual(await service.loadState(user.req), { status: 'pending_admission' });
    for (const contextMode of [true, false, null, '', 'request']) {
        assert.throws(() => handlers(f, user, { contextMode }), /signup_context_mode_invalid/);
    }
});
const scopeOf = record => ({ tenantId: record.tenantId, organisationId: record.organisationId,
    invitationId: record.invitationId });
const stateRequest = user => ({ method: 'GET', sessionKey: user.req.sessionKey, headers: {} });
function composedRuntime(f, service) {
    return createCustomerSignupRuntime({ env: { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: 'https://signup.example.test' },
        loadState: service.loadState, acceptTerms: service.acceptTerms,
        issueCsrfToken: async () => 'x'.repeat(43), validateCsrfToken: async (_req, token) => token === 'x'.repeat(43) });
}

test('GET shows the exact terms without accepting or writing anything', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user);
    const before = copy(f.records.get(user.digest));
    const result = await composedRuntime(f, service).handle(stateRequest(user), 'state');
    assert.deepEqual(result.body.state, { status: 'terms', termsText: TERMS_TEXT,
        termsVersion: TERMS.termsVersion, termsDigest: TEXT_DIGEST });
    assert.equal(result.body.csrfToken, 'x'.repeat(43));
    assert.deepEqual(f.records.get(user.digest), before); assert.equal(f.rows.size, 0);
    assert.equal(f.dbCount, 0); assert.ok(!f.events.includes('invitation-start'));
});

test('GET after POST and handler restart reads durable acceptance with a minimal projection', async () => {
    const f = fixture(), user = f.add(); let service = handlers(f, user);
    await composedRuntime(f, service).handle(f.request(user), 'terms');
    const before = JSON.stringify([...f.records]), writes = f.dbCount;
    service = handlers(f, user);
    const result = await composedRuntime(f, service).handle(stateRequest(user), 'state');
    assert.deepEqual(result, { status: 200, body: { state: { status: 'pending_admission' } } });
    assert.equal(f.dbCount, writes); assert.equal(JSON.stringify([...f.records]), before);
    assert.ok(f.readCount >= 3);
});

test('database failure leaves GET at terms and the invitation unaccepted', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.dbMode = 'before';
    await assert.rejects(service.acceptTerms(f.command(user)));
    assert.equal(f.records.get(user.digest).status, 'invited');
    assert.equal((await service.loadState(user.req)).status, 'terms');
    assert.equal(f.rows.size, 0);
});

test('blob failure after journal commit preserves evidence and recovers the same receipt', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.storeMode = 'write';
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_store_unavailable');
    assert.equal(f.records.get(user.digest).status, 'invited'); assert.equal(f.rows.size, 1);
    const receipt = copy([...f.rows.values()][0].receipt);
    assert.deepEqual(await service.loadState(user.req), { status: 'pending_admission' });
    assert.equal(f.records.get(user.digest).status, 'invited', 'GET must not repair storage');
    f.clock += 1000;
    await service.acceptTerms(f.command(user));
    assert.deepEqual(f.records.get(user.digest).acceptance, receipt); assert.equal(f.rows.size, 1);
});

test('a previously durable acceptance can reconcile after invitation expiry with fresh matching identity', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.storeMode = 'write';
    await assert.rejects(service.acceptTerms(f.command(user)));
    const saved = copy([...f.rows.values()][0]); f.clock += 3600001;
    assert.deepEqual(await service.loadState(user.req), { status: 'pending_admission' });
    await service.acceptTerms(f.command(user));
    assert.deepEqual([...f.rows.values()][0], saved);
    assert.deepEqual(f.records.get(user.digest).acceptance, saved.receipt);
});

test('a new expired invitation cannot be converted to accepted state by GET or retry', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.clock += 3600001;
    assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_invitation_unavailable');
    assert.equal(f.rows.size, 0); assert.equal(f.records.get(user.digest).status, 'invited');
});

test('revocation is never undone by a durable receipt during read or retry', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.storeMode = 'write';
    await assert.rejects(service.acceptTerms(f.command(user)));
    f.records.get(user.digest).status = 'revoked'; const before = copy([...f.rows.values()][0]);
    assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_invitation_unavailable');
    assert.equal(f.records.get(user.digest).status, 'revoked'); assert.deepEqual([...f.rows.values()][0], before);
});

test('a different subject cannot claim a durable receipt after an incomplete blob write', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.storeMode = 'write';
    await assert.rejects(service.acceptTerms(f.command(user)));
    f.proofOverride = { subjectKey: SUBJECT.replace(/2/g, '3') };
    assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_invitation_unavailable');
    assert.equal(f.rows.size, 1); assert.equal(f.records.get(user.digest).status, 'invited');
});

test('legacy transient-only acceptance is not durable GET success but explicit retry repairs it', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user);
    const legacy = createInvitationAcceptance({ store: f.store, verifyIdentity: f.verifyIdentity, now: () => f.clock });
    await legacy.accept({ ...f.contexts.get('a'), ...user.input });
    const original = copy(f.records.get(user.digest).acceptance);
    assert.equal(f.rows.size, 0); assert.equal((await service.loadState(user.req)).status, 'terms');
    assert.equal(f.rows.size, 0, 'GET cannot invent durable consent');
    await service.acceptTerms(f.command(user));
    assert.deepEqual([...f.rows.values()][0].receipt, original);
});

test('a deleted bootstrap fails closed but does not delete existing durable proof', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); await service.acceptTerms(f.command(user));
    const saved = copy([...f.rows.values()][0]); f.records.clear();
    assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
    assert.deepEqual([...f.rows.values()][0], saved);
    const receipt = await createPostgresSignupAcceptanceJournal({ database: f.database })
        .readForInvitation(scopeOf(saved.receipt));
    assert.deepEqual(receipt, saved.receipt);
});

test('GET reports unavailable on a database read failure instead of trusting transient status', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); await service.acceptTerms(f.command(user));
    f.readMode = 'failure'; const before = f.dbCount;
    assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' }); assert.equal(f.dbCount, before);
});

for (const field of ['termsDigest', 'termsVersion', 'subjectKey', 'acceptedAt']) {
    test(`a mismatching durable ${field} is not silently repaired`, async () => {
        const f = fixture(), user = f.add(), service = handlers(f, user); await service.acceptTerms(f.command(user));
        const row = [...f.rows.values()][0];
        row.receipt[field] = field === 'acceptedAt' ? row.receipt.acceptedAt + 1 :
            field === 'subjectKey' ? SUBJECT.replace(/2/g, '3') : field === 'termsDigest' ? 'b'.repeat(64) : 'other';
        const before = copy(row);
        assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
        await assert.rejects(service.acceptTerms(f.command(user)));
        assert.deepEqual([...f.rows.values()][0], before);
    });
}

for (const proofOverride of [{ emailVerified: false }, { mfaSatisfied: false },
    { identityPolicyId: 'other-policy' }, { email: 'other@example.test' },
    { expiresAt: 0 }, { verifiedAt: 0 }]) {
    test(`GET rechecks identity assurance ${JSON.stringify(proofOverride)}`, async () => {
        const f = fixture(), user = f.add(), service = handlers(f, user); await service.acceptTerms(f.command(user));
        f.proofOverride = proofOverride;
        assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' }); assert.equal(f.dbCount, 1);
    });
}

test('displayed terms must match the version and exact UTF-8 digest', async () => {
    for (const delta of [{ termsText: 'altered text' }, { termsVersion: 'other' },
        { termsDigest: 'b'.repeat(64) }, { termsText: '' }, { termsText: 'x'.repeat(32769) }]) {
        const f = fixture(), user = f.add(), service = handlers(f, user, { resolveTerms: async () => ({
            termsText: TERMS_TEXT, termsVersion: TERMS.termsVersion, termsDigest: TEXT_DIGEST, ...delta }) });
        assert.deepEqual(await service.loadState(user.req), { status: 'unavailable' });
        assert.equal(f.rows.size, 0);
    }
});

test('direct POST requires currently applicable exact terms before any durable write', async () => {
    const invalidResolvers = [
        async () => null,
        async () => { throw new Error('withdrawn'); },
        async () => ({ termsText: 'altered text', termsVersion: TERMS.termsVersion, termsDigest: TEXT_DIGEST }),
        async () => ({ termsText: TERMS_TEXT, termsVersion: 'withdrawn-version', termsDigest: TEXT_DIGEST }),
        async () => ({ termsText: TERMS_TEXT, termsVersion: TERMS.termsVersion, termsDigest: 'b'.repeat(64) })
    ];
    for (const resolveTerms of invalidResolvers) {
        const f = fixture(), user = f.add(); let registrations = 0;
        const service = handlers(f, user, { resolveTerms, registrationStore: {
            async registerAcceptance() { registrations++; throw new Error('must not register'); },
            async readForInvitation() { return null; }
        } });
        await rejectsCode(service.acceptTerms(f.command(user)), 'signup_terms_unavailable');
        assert.equal(f.dbCount, 0); assert.equal(f.rows.size, 0); assert.equal(registrations, 0);
        assert.equal(f.records.get(user.digest).status, 'invited');
    }
});

test('new consent validates offer applicability at the immutable receipt timestamp', async () => {
    const f = fixture(), user = f.add(); let observed;
    const service = handlers(f, user, { resolveTerms: async reference => {
        observed = copy(reference);
        return { termsText: TERMS_TEXT, termsVersion: reference.termsVersion, termsDigest: reference.termsDigest };
    } });
    await service.acceptTerms(f.command(user));
    const receipt = copy([...f.rows.values()][0].receipt);
    assert.equal(observed.acceptedAt, receipt.acceptedAt);
    assert.equal(observed.acceptedAt, f.clock);
});

test('resume honors a revoked invitation while its record still exists', async () => {
    const f = fixture(), user = f.add(); let registrationCalls = 0;
    const registrationStore = {
        async registerAcceptance() {
            registrationCalls++;
            throw new Error('synthetic-registration-failure');
        },
        async readForInvitation() { throw new Error('must not read registration after invitation revocation'); }
    };
    const service = handlers(f, user, { registrationStore });
    await assert.rejects(service.acceptTerms(f.command(user)));
    assert.equal(f.rows.size, 1); assert.equal(f.records.get(user.digest).status, 'invited');
    f.records.get(user.digest).status = 'revoked';
    await rejectsCode(service.resumeAcceptance({ req: user.req }), 'signup_invitation_unavailable');
    assert.equal(registrationCalls, 1);
});

test('withdrawal cannot erase or block reconciliation of an existing durable receipt', async () => {
    const f = fixture(), user = f.add(); let available = true;
    const service = handlers(f, user, { resolveTerms: async reference => {
        if (!available) throw new Error('withdrawn');
        return { termsText: TERMS_TEXT, termsVersion: reference.termsVersion, termsDigest: reference.termsDigest };
    } });
    f.storeMode = 'write';
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_store_unavailable');
    const receipt = copy([...f.rows.values()][0].receipt);
    available = false;
    await service.acceptTerms(f.command(user));
    assert.deepEqual(f.records.get(user.digest).acceptance, receipt);
    assert.deepEqual([...f.rows.values()][0].receipt, receipt);
});

test('read-only journal lookup is tenant and organisation scoped, including hostile parameters', async () => {
    const f = fixture(), user = f.add('a', "tenant-a' OR '1'='1", 'org-a'); await f.build()(f.command(user));
    const journal = createPostgresSignupAcceptanceJournal({ database: f.database });
    const expected = copy([...f.rows.values()][0].receipt);
    assert.deepEqual(await journal.readForInvitation(scopeOf(expected)), expected);
    assert.equal(await journal.readForInvitation({ ...scopeOf(expected), tenantId: 'other' }), null);
    assert.equal(await journal.readForInvitation({ ...scopeOf(expected), organisationId: 'other' }), null);
    assert.equal(f.dbCount, 1);
});

test('malformed journal references cannot start a database transaction or invoke getters', async () => {
    const f = fixture(), journal = createPostgresSignupAcceptanceJournal({ database: f.database }); let invoked = false;
    const valid = { tenantId: 't', organisationId: 'o', invitationId: 'i' };
    const getter = { ...valid }; Object.defineProperty(getter, 'tenantId', { enumerable: true, get() { invoked = true; return 't'; } });
    for (const value of [null, [], { ...valid, extra: 'x' }, { ...valid, tenantId: '' },
        { ...valid, invitationId: 'i\n' }, getter, new Proxy(valid, { ownKeys() { invoked = true; return []; } })]) {
        await rejectsCode(journal.readForInvitation(value), 'signup_acceptance_reference_invalid');
    }
    assert.equal(invoked, false); assert.equal(f.dbCount, 0); assert.equal(f.readCount, 0);
});

test('readback rejects duplicate rows, corrupt retention metadata and wrong-scope payloads', async () => {
    const f = fixture(), user = f.add(); await f.build()(f.command(user)); const row = copy([...f.rows.values()][0]);
    const scope = scopeOf(row.receipt);
    const bad = copy(row); bad.retentionPolicyId = 'short-retention';
    const foreign = copy(row); foreign.receipt.organisationId = 'foreign';
    for (const rows of [[{ payload: row }, { payload: row }], [{ payload: bad }], [{ payload: foreign }], [{ payload: null }], null]) {
        const journal = createPostgresSignupAcceptanceJournal({ database: { withTenantTransaction: async (tenant, work) => {
            assert.equal(tenant, scope.tenantId); return work({ query: async () => ({ rows }) });
        } } });
        await assert.rejects(journal.readForInvitation(scope));
    }
});

test('proof expiry during database commit returns no success and a fresh retry keeps the receipt', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); let release;
    f.commitGate = new Promise(resolve => { release = resolve; }); f.dbMode = 'wait';
    const pending = service.acceptTerms(f.command(user)); await tick(); f.clock += 60001; release();
    await rejectsCode(pending, 'signup_identity_required');
    assert.equal(f.records.get(user.digest).status, 'invited'); assert.equal(f.rows.size, 1);
    const receipt = copy([...f.rows.values()][0].receipt);
    await service.acceptTerms(f.command(user)); assert.deepEqual(f.records.get(user.digest).acceptance, receipt);
});

test('request-supplied receipt and authority fields cannot replace the server context on GET', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user); f.contexts.clear();
    assert.deepEqual(await service.loadState({ ...user.req, body: { ...user.input, subjectKey: SUBJECT,
        invitationToken: user.token, identityProofHandle: user.handle }, tenantId: 'tenant-a' }), { status: 'unavailable' });
    assert.equal(f.dbCount, 0); assert.equal(f.readCount, 0);
});

function realBlobStore(f) {
    const io = { reads: 0, writes: 0, leases: 0, releases: 0, failWrite: false, loseLease: false, missing: false };
    const etags = new Map();
    const client = {
        getProperties: async () => ({}),
        getBlockBlobClient(path) {
            const match = /^browser-auth\/customer-signup\/invitations\/([a-f0-9]{64})\.json$/.exec(path);
            assert.ok(match); const digest = match[1]; let leaseActive = false;
            return {
                getBlobLeaseClient() { return {
                    async acquireLease(seconds) { assert.equal(seconds, 15); io.leases++; leaseActive = true; return { leaseId: 'synthetic-lease' }; },
                    async releaseLease() { io.releases++; leaseActive = false; }
                }; },
                async download(_offset, _count, options) {
                    io.reads++; if (io.missing || !f.records.has(digest)) throw Object.assign(new Error('missing'), { statusCode: 404 });
                    if (options) assert.equal(options.conditions.leaseId, 'synthetic-lease');
                    const bytes = io.badBytes || Buffer.from(JSON.stringify(f.records.get(digest)));
                    return { etag: String(etags.get(digest) || 1), readableStreamBody: (async function* () { yield bytes; })() };
                },
                async uploadData(bytes, options) {
                    io.writes++; assert.equal(options.conditions.leaseId, 'synthetic-lease');
                    assert.equal(options.conditions.ifMatch, String(etags.get(digest) || 1));
                    if (!leaseActive || io.failWrite || io.loseLease) {
                        io.failWrite = false; io.loseLease = false;
                        throw Object.assign(new Error('synthetic precondition failure'), { statusCode: 412 });
                    }
                    f.records.set(digest, JSON.parse(bytes.toString('utf8'))); etags.set(digest, (etags.get(digest) || 1) + 1);
                }
            };
        }
    };
    return { store: new AzureBlobSignupInvitationStore({ containerClient: client }), io };
}

test('actual Blob read adapter uses no lease, write or raw invitation token', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f);
    const record = await store.read(user.digest);
    assert.deepEqual(record, f.records.get(user.digest)); record.expectedEmail = 'changed@example.test';
    assert.notEqual(record.expectedEmail, f.records.get(user.digest).expectedEmail);
    assert.equal(io.leases, 0); assert.equal(io.writes, 0);
    io.missing = true; assert.equal(await store.read(user.digest), null);
});

test('actual Blob read rejects oversized and malformed record bytes', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f);
    for (const bytes of [Buffer.alloc(32769), Buffer.from('{bad'), Buffer.from('{}')]) {
        io.badBytes = bytes; await assert.rejects(store.read(user.digest));
    }
    io.badBytes = Buffer.from(JSON.stringify({ ...f.records.get(user.digest), tokenDigest: 'f'.repeat(64) }));
    await assert.rejects(store.read(user.digest)); assert.equal(io.writes, 0); assert.equal(io.leases, 0);
});

test('actual Blob transaction reconciles a journal commit after conditional upload failure', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f); f.store = store;
    const service = handlers(f, user); io.failWrite = true;
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_store_unavailable');
    assert.equal(f.rows.size, 1); assert.equal(f.records.get(user.digest).status, 'invited');
    const receipt = copy([...f.rows.values()][0].receipt);
    assert.deepEqual(await service.loadState(user.req), { status: 'pending_admission' });
    assert.equal(io.leases, 1, 'GET must not acquire another lease');
    await service.acceptTerms(f.command(user));
    assert.deepEqual(f.records.get(user.digest).acceptance, receipt); assert.equal(f.rows.size, 1);
    assert.equal(io.releases, io.leases);
});

test('actual Blob transaction does not upload accepted state when the database fails', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f); f.store = store;
    const service = handlers(f, user); f.dbMode = 'before';
    await rejectsCode(service.acceptTerms(f.command(user)), 'signup_acceptance_journal_unavailable');
    assert.equal(io.writes, 0); assert.equal(io.releases, 1); assert.equal(f.rows.size, 0);
    assert.equal(f.records.get(user.digest).status, 'invited');
});

test('a read-only registration guard stops fresh consent before SQL insert or accepted Blob upload', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f); f.store = store;
    const calls = [];
    const registrationStore = {
        async assertAcceptanceWritable(command) { calls.push(copy(command)); throw new Error('signup_registration_read_only'); },
        async registerAcceptance() { throw new Error('must not attempt registration'); },
        async readForInvitation() { throw new Error('must not read a registration after the guard rejects'); }
    };
    const service = handlers(f, user, { registrationStore }), before = copy(f.records.get(user.digest));
    await assert.rejects(service.acceptTerms(f.command(user)));
    assert.deepEqual(calls, [{ subjectKey: SUBJECT }]);
    assert.equal(f.dbCount, 0, 'no receipt INSERT may be attempted');
    assert.equal(f.rows.size, 0); assert.equal(io.writes, 0, 'no accepted Blob upload may be attempted');
    assert.deepEqual(f.records.get(user.digest), before);
    assert.equal(io.releases, io.leases);
});

test('a read-only registration guard stops receipt-present consent and resume retries without SQL or Blob rewrites', async () => {
    const f = fixture(), user = f.add(), { store, io } = realBlobStore(f); f.store = store;
    const initial = handlers(f, user); io.failWrite = true;
    await assert.rejects(initial.acceptTerms(f.command(user)));
    assert.equal(f.rows.size, 1); assert.equal(f.records.get(user.digest).status, 'invited');
    const receiptBefore = copy([...f.rows.values()][0]), invitationBefore = copy(f.records.get(user.digest));
    f.dbCount = 0; io.writes = 0;
    const calls = [];
    let registrationAttempts = 0;
    const service = handlers(f, user, { registrationStore: {
        async assertAcceptanceWritable(command) { calls.push(copy(command)); throw new Error('signup_registration_read_only'); },
        async registerAcceptance() { registrationAttempts++; throw new Error('must not attempt registration'); },
        async readForInvitation() { return null; }
    } });
    await assert.rejects(service.acceptTerms(f.command(user)));
    await assert.rejects(service.resumeAcceptance({ req: user.req }));
    assert.deepEqual(calls, [{ subjectKey: SUBJECT }, { subjectKey: SUBJECT }]);
    assert.equal(registrationAttempts, 0); assert.equal(f.dbCount, 0, 'even an idempotent receipt INSERT is a write attempt');
    assert.equal(io.writes, 0); assert.deepEqual([...f.rows.values()], [receiptBefore]);
    assert.deepEqual(f.records.get(user.digest), invitationBefore); assert.equal(io.releases, io.leases);
});

test('malformed optional registration write guards reject at construction before any storage work', () => {
    const f = fixture(); let invoked = false;
    const proxied = new Proxy(async () => {}, { apply() { invoked = true; } });
    for (const guard of [undefined, null, false, 0, 'guard', {}, proxied]) {
        assert.throws(() => createJournaledTermsAcceptance({ ...f.options(), registrationStore: {
            async registerAcceptance() {}, async readForInvitation() {}, assertAcceptanceWritable: guard
        } }), /signup_registration_store_required/);
    }
    assert.equal(invoked, false); assert.equal(f.dbCount, 0); assert.equal(f.storeReads, 0);
    assert.equal(f.resolveCount, 0); assert.deepEqual(f.events, []);
});

test('the composed GET/POST pair retains the existing HTTP origin and CSRF gate', async () => {
    const f = fixture(), user = f.add(), service = handlers(f, user), runtime = composedRuntime(f, service);
    await runtime.handle(stateRequest(user), 'state');
    const before = f.readCount;
    const req = f.request(user); req.headers.origin = 'https://attacker.example.test';
    await assert.rejects(runtime.handle(req, 'terms'), error => error.statusCode === 403);
    req.headers.origin = 'https://signup.example.test'; req.headers['x-csrf-token'] = 'z'.repeat(43);
    await rejectsCode(runtime.handle(req, 'terms'), 'signup_csrf_invalid');
    assert.equal(f.dbCount, 0); assert.equal(f.readCount, before);
});
