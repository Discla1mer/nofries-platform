'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const { createPostgresSignupRegistrationStore, readSignupRegistrationLayout, readSignupRegistrationHeader, lockSignupRegistrationHeader } = require('../api/shared/customerSignup/postgresSignupRegistrationStore');
const SUBJECT = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OTHER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444:22222222-2222-4222-8222-222222222222';
const receipt = (changes = {}) => ({ receiptId: 'receipt-1', invitationId: 'invite-1', subjectKey: SUBJECT,
    tenantId: 'customer-tenant', organisationId: 'organisation-1', termsVersion: 'terms-v1',
    termsDigest: 'a'.repeat(64), acceptedAt: 1700000000000, status: 'pending_admission', dashboardAccess: false, ...changes });
const query = (value, expectedRevision) => ({ subjectKey: value.subjectKey, tenantId: value.tenantId,
    organisationId: value.organisationId, invitationId: value.invitationId, expectedRevision });
const scoped = value => ({ subjectKey: value.subjectKey, tenantId: value.tenantId,
    organisationId: value.organisationId, invitationId: value.invitationId });
// Match the JSON read boundary used by persisted database/Blob records. Jest's
// injected structuredClone can return host-realm prototypes instead of this realm.
const copy = value => JSON.parse(JSON.stringify(value));

// A transactional database PORT simulation, not PostgreSQL or proof of SQL RLS.
// Preserve state across factory instances; serialize transactions and simulate
// rollback and an acknowledged/uncertain COMMIT separately from individual queries.
function harness({ future = false, allowScopedWrites = false } = {}) {
    const h = { rows: new Map(), receipts: new Map(), calls: [], future, catalogRows: null, failQuery: null, failCommit: false, loseCommitReply: false, tail: Promise.resolve() };
    h.database = { withTenantTransaction(tenant, work) {
        const run = h.tail.then(async () => {
            const staged = new Map([...h.rows].map(([key, value]) => [key, copy(value)]));
            const receipts = new Map([...h.receipts].map(([key, value]) => [key, copy(value)]));
            let selectedSubject = null;
            const result = await work({ async query(sql, params) {
                h.calls.push({ tenant, sql, params: copy(params) });
                if (h.failQuery && sql.includes(h.failQuery)) throw new Error('synthetic-driver-secret');
                if (sql.includes('set_config')) { selectedSubject = params[0]; return { rows: [] }; }
                if (sql.includes('pg_catalog.pg_attribute')) return { rows: copy(h.catalogRows ?? (h.future ? [{ is_text: true, not_null: true, scoped_primary_key: true }] : [])) };
                if (sql.includes('nofries.signup_acceptance_receipts')) {
                    assert.equal(params[0], tenant);
                    if (sql.trimStart().startsWith('INSERT')) {
                        assert.equal(params.length, 13);
                        const payload = JSON.parse(params[12]);
                        const key = `${tenant}|${params[1]}|${params[2]}`;
                        if (receipts.has(key)) return { rows: [] };
                        receipts.set(key, payload); return { rows: [{ payload: copy(payload) }] };
                    }
                    const values = [...receipts.values()].filter(value => value.receipt.tenantId === tenant &&
                        value.receipt.organisationId === params[1] &&
                        (sql.includes('AND invitation_id=') ? value.receipt.invitationId : value.receipt.receiptId) === params[2]);
                    return { rows: values.map(payload => ({ payload: copy(payload) })) };
                }
                assert.equal(params[0], tenant);
                assert.equal(params[1], selectedSubject);
                const headerKey = `${tenant}|${selectedSubject}`;
                const entryKey = hash => `${headerKey}|${hash}`;
                const values = () => [...staged.entries()].filter(([key]) => key.startsWith(`${headerKey}|`))
                    .map(([, row]) => row).sort((a, b) => a.row_key.localeCompare(b.row_key));
                if (sql.startsWith('INSERT')) {
                    if (sql.includes('subject_key,row_key,revision,payload')) {
                        const key = entryKey(params[2]);
                        if (staged.has(key)) throw new Error('duplicate-key');
                        const row = { identity_tenant_id: tenant, subject_key: selectedSubject,
                            row_key: params[2], revision: String(params[3]), payload: JSON.parse(params[4]) };
                        staged.set(key, row); return { rows: [copy(row)] };
                    }
                    if (!staged.has(headerKey)) staged.set(headerKey, { identity_tenant_id: tenant,
                        subject_key: selectedSubject, revision: '0', payload: JSON.parse(params[2]), ...(h.future ? { row_key: '' } : {}) });
                    return { rows: [] };
                }
                if (sql.startsWith('SELECT')) {
                    if (sql.includes("row_key>''")) return { rows: values().slice(0, 1).map(row => ({ row_key: row.row_key })) };
                    if (sql.includes("row_key<>''")) return { rows: values().filter(row => row.payload.binding.status === 'pending_admission').slice(0, 2).map(copy) };
                    const key = sql.includes('row_key=$3') ? entryKey(params[2]) : headerKey;
                    return { rows: staged.has(key) ? [copy(staged.get(key))] : [] };
                }
                if (sql.startsWith('UPDATE')) {
                    if (sql.includes('row_key=$3')) {
                        const key = entryKey(params[2]), row = staged.get(key);
                        if (!row) return { rows: [] };
                        const next = { ...row, revision: String(params[3]), payload: JSON.parse(params[4]) };
                        staged.set(key, next); return { rows: [copy(next)] };
                    }
                    const row = staged.get(headerKey);
                    if (!row || String(row.revision) !== String(params[4])) return { rows: [] };
                    const next = { ...row, revision: String(params[2]), payload: JSON.parse(params[3]) };
                    staged.set(headerKey, next); return { rows: [copy(next)] };
                }
                throw new Error('Unexpected SQL');
            } });
            if (h.failCommit) throw new Error('synthetic-commit-secret');
            h.rows = staged; h.receipts = receipts;
            if (h.loseCommitReply) throw new Error('synthetic-commit-reply-lost');
            return result;
        });
        h.tail = run.catch(() => {}); return run;
    } };
    h.store = createPostgresSignupRegistrationStore({ database: h.database, allowScopedWrites });
    return h;
}
const rejectsCode = (operation, code) => assert.rejects(operation, error => error.code === code && !error.message.includes('secret'));

test('missing registration returns null and does not create a row', async () => {
    const h = harness(); assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal(h.rows.size, 0); assert.ok(!h.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql)));
});
test('first acceptance persists and selects its exact current binding', async () => {
    const h = harness(), r = receipt(), result = await h.store.registerAcceptance(r);
    assert.equal(result.revision, 1); assert.equal(result.status, 'pending_admission');
    assert.deepEqual(await h.store.readRegistration({ subjectKey: SUBJECT }), result);
    assert.equal(result.tenantId, 'customer-tenant');
    assert.ok(h.calls.every(call => call.tenant === SUBJECT.slice(0, 36)));
    assert.equal(Object.hasOwn(result, 'acceptedAt'), false); assert.equal(Object.hasOwn(result, 'dashboardAccess'), false);
});
test('matching replay preserves revision and avoids a second update', async () => {
    const h = harness(), r = receipt(), first = await h.store.registerAcceptance(r);
    const count = h.calls.filter(call => call.sql.startsWith('UPDATE')).length;
    assert.deepEqual(await h.store.registerAcceptance(r), first);
    assert.equal(h.calls.filter(call => call.sql.startsWith('UPDATE')).length, count);
});
test('a new factory reads persisted state after simulated process restart', async () => {
    const h = harness(), result = await h.store.registerAcceptance(receipt());
    const restarted = createPostgresSignupRegistrationStore({ database: h.database });
    assert.deepEqual(await restarted.readRegistration({ subjectKey: SUBJECT }), result);
});
test('second pending registration clears automatic organisation selection', async () => {
    const h = harness(); await h.store.registerAcceptance(receipt());
    await h.store.registerAcceptance(receipt({ organisationId: 'organisation-2', receiptId: 'receipt-2' }));
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal((await h.store.readForInvitation(scoped(receipt()))).revision, 2);
});
test('explicit selection uses stored scope and a current revision', async () => {
    const h = harness(), second = receipt({ organisationId: 'organisation-2', receiptId: 'receipt-2' });
    await h.store.registerAcceptance(receipt()); await h.store.registerAcceptance(second);
    const selected = await h.store.selectRegistration(query(second, 2));
    assert.equal(selected.revision, 3);
    assert.deepEqual(await h.store.readRegistration({ subjectKey: SUBJECT }), selected);
    await h.store.registerAcceptance(receipt());
    assert.deepEqual(await h.store.readRegistration({ subjectKey: SUBJECT }), selected);
});
test('stale selection does not overwrite a newer selection', async () => {
    const h = harness(), r = receipt(), second = receipt({ organisationId: 'organisation-2', receiptId: 'receipt-2' });
    await h.store.registerAcceptance(r); await h.store.registerAcceptance(second);
    await h.store.selectRegistration(query(r, 2));
    await rejectsCode(h.store.selectRegistration(query(second, 2)), 'signup_registration_conflict');
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).organisationId, r.organisationId);
});
test('selection cannot create a missing subject or invitation', async () => {
    const h = harness(), r = receipt();
    await rejectsCode(h.store.selectRegistration(query(r, 0)), 'signup_registration_not_found');
    assert.equal(h.rows.size, 0); await h.store.registerAcceptance(r);
    await rejectsCode(h.store.selectRegistration(query(receipt({ invitationId: 'unknown' }), 1)), 'signup_registration_not_found');
});
test('revocation persists a tombstone and removes selected continuation', async () => {
    const h = harness(), r = receipt(); await h.store.registerAcceptance(r);
    const result = await h.store.revokeRegistration(query(r, 1));
    assert.equal(result.status, 'revoked'); assert.equal(result.revision, 2);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal((await h.store.readForInvitation(scoped(r))).status, 'revoked');
    await rejectsCode(h.store.registerAcceptance(r), 'signup_registration_revoked');
    await rejectsCode(h.store.selectRegistration(query(r, 2)), 'signup_registration_revoked');
});
test('revocation retry is idempotent after a lost acknowledgement', async () => {
    const h = harness(), r = receipt(); await h.store.registerAcceptance(r);
    h.loseCommitReply = true;
    await rejectsCode(h.store.revokeRegistration(query(r, 1)), 'signup_registration_unavailable');
    h.loseCommitReply = false;
    assert.equal((await h.store.revokeRegistration(query(r, 1))).revision, 2);
});
test('stale revocation does not revoke a changed current registration', async () => {
    const h = harness(), r = receipt(); await h.store.registerAcceptance(r);
    await rejectsCode(h.store.revokeRegistration(query(r, 0)), 'signup_registration_conflict');
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).status, 'pending_admission');
});
test('revoking a selected organisation never switches silently to another', async () => {
    const h = harness(), r = receipt(), second = receipt({ organisationId: 'organisation-2', receiptId: 'receipt-2' });
    await h.store.registerAcceptance(r); await h.store.registerAcceptance(second);
    await h.store.selectRegistration(query(r, 2)); await h.store.revokeRegistration(query(r, 3));
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal((await h.store.readForInvitation(scoped(second))).status, 'pending_admission');
});
for (const changed of [{ receiptId: 'different' }, { termsVersion: 'different' }, { termsDigest: 'b'.repeat(64) }]) {
    test(`matching invitation rejects changed ${Object.keys(changed)[0]}`, async () => {
        const h = harness(); await h.store.registerAcceptance(receipt());
        await rejectsCode(h.store.registerAcceptance(receipt(changed)), 'signup_registration_conflict');
        assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).revision, 1);
    });
}
for (const other of [OTHER, FOREIGN]) {
    test(`another immutable subject is isolated: ${other.slice(0, 8)} ${other.slice(-8)}`, async () => {
        const h = harness(); await h.store.registerAcceptance(receipt());
        assert.equal(await h.store.readRegistration({ subjectKey: other }), null);
        await rejectsCode(h.store.revokeRegistration(query(receipt({ subjectKey: other }), 1)), 'signup_registration_not_found');
        await h.store.registerAcceptance(receipt({ subjectKey: other, organisationId: 'other-organisation' }));
        assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).organisationId, 'organisation-1');
        assert.equal((await h.store.readRegistration({ subjectKey: other })).organisationId, 'other-organisation');
    });
}
test('concurrent matching registrations create one logical binding', async () => {
    const h = harness(), r = receipt(); const results = await Promise.all([h.store.registerAcceptance(r), h.store.registerAcceptance(r)]);
    assert.deepEqual(results[0], results[1]); assert.equal([...h.rows.values()][0].payload.registrations.length, 1);
    assert.ok(h.calls.some(call => call.sql.includes('FOR UPDATE')));
});
test('concurrent different registrations retain both and require selection', async () => {
    const h = harness(); await Promise.all([h.store.registerAcceptance(receipt()),
        h.store.registerAcceptance(receipt({ organisationId: 'organisation-2', receiptId: 'receipt-2' }))]);
    assert.equal([...h.rows.values()][0].payload.registrations.length, 2);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
});
for (const point of ['set_config', 'INSERT', 'SELECT identity_tenant', 'UPDATE']) {
    test(`database failure at ${point} rolls back and returns a redacted error`, async () => {
        const h = harness(); h.failQuery = point;
        await rejectsCode(h.store.registerAcceptance(receipt()), 'signup_registration_unavailable');
        assert.equal(h.rows.size, 0);
    });
}
test('failed commit is not reported as a saved registration', async () => {
    const h = harness(); h.failCommit = true;
    await rejectsCode(h.store.registerAcceptance(receipt()), 'signup_registration_unavailable');
    assert.equal(h.rows.size, 0); h.failCommit = false;
    assert.equal((await h.store.registerAcceptance(receipt())).revision, 1);
});
test('uncertain successful commit is reconciled by a matching retry', async () => {
    const h = harness(); h.loseCommitReply = true;
    await rejectsCode(h.store.registerAcceptance(receipt()), 'signup_registration_unavailable');
    assert.equal(h.rows.size, 1); h.loseCommitReply = false;
    assert.equal((await h.store.registerAcceptance(receipt())).revision, 1);
});
for (const bad of ['', 'joel@example.invalid', SUBJECT.toUpperCase(), `${SUBJECT} `, null, 1]) {
    // All-numeric UUID fixtures are unchanged by uppercasing; use an alpha UUID.
    if (bad === SUBJECT) continue;
    test(`invalid subject is rejected before database I/O: ${String(bad)}`, async () => {
        const h = harness(); await rejectsCode(h.store.readRegistration({ subjectKey: bad }), 'signup_registration_input_invalid');
        assert.equal(h.calls.length, 0);
    });
}
test('untrusted extra fields, getters and proxy inputs never select a subject', async () => {
    const h = harness(); let invoked = false;
    const getter = { get subjectKey() { invoked = true; return SUBJECT; } };
    for (const value of [getter, { subjectKey: SUBJECT, email: 'bad@example.invalid' }, new Proxy({ subjectKey: SUBJECT }, {})]) {
        await rejectsCode(h.store.readRegistration(value), 'signup_registration_input_invalid');
    }
    assert.equal(invoked, false); assert.equal(h.calls.length, 0);
});
test('negative-zero and fractional expected revisions are rejected', async () => {
    const h = harness();
    for (const version of [-0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        await rejectsCode(h.store.selectRegistration(query(receipt(), version)), 'signup_registration_input_invalid');
    }
    assert.equal(h.calls.length, 0);
});
test('SQL-like identifiers remain parameter data and do not enter query text', async () => {
    const h = harness(), r = receipt({ organisationId: "x'; DROP TABLE example; --" });
    await h.store.registerAcceptance(r);
    assert.ok(h.calls.every(call => !call.sql.includes('DROP TABLE')));
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).organisationId, r.organisationId);
});
for (const mutate of [
    row => { row.identity_tenant_id = FOREIGN.slice(0, 36); },
    row => { row.subject_key = OTHER; },
    row => { row.revision = '8'; },
    row => { row.payload.registrations[0].termsDigest = 'bad'; },
    row => { row.payload.registrations[0].subjectKey = OTHER; },
    row => { row.payload.registrations.push(copy(row.payload.registrations[0])); },
    row => { row.payload.selected.organisationId = 'unknown'; },
    row => { row.payload.registrations[0].status = 'revoked'; },
    row => { row.payload.registrations[0].email = 'not-needed@example.invalid'; }
]) {
    test(`malformed stored binding fails closed: ${mutate.toString()}`, async () => {
        const h = harness(); await h.store.registerAcceptance(receipt()); mutate([...h.rows.values()][0]);
        await rejectsCode(h.store.readRegistration({ subjectKey: SUBJECT }), 'signup_registration_record_invalid');
    });
}
test('caller mutation cannot alter the saved registration', async () => {
    const h = harness(), r = receipt(); const result = await h.store.registerAcceptance(r);
    r.organisationId = 'changed'; assert.equal(Object.isFrozen(result), true);
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).organisationId, 'organisation-1');
});
test('oversized or malformed references cannot be registered', async () => {
    const h = harness();
    for (const changes of [{ organisationId: 'x'.repeat(181) }, { tenantId: 'x\n' }, { receiptId: '\ud800' }, { dashboardAccess: true }]) {
        await rejectsCode(h.store.registerAcceptance(receipt(changes)), 'signup_registration_input_invalid');
    }
    assert.equal(h.calls.length, 0);
});
test('registry capacity is bounded and tombstones are not discarded to make room', async () => {
    const h = harness();
    for (let i = 0; i < 128; i += 1) await h.store.registerAcceptance(receipt({ invitationId: `invite-${i}` }));
    await rejectsCode(h.store.registerAcceptance(receipt({ invitationId: 'overflow' })), 'signup_registration_capacity');
    assert.equal([...h.rows.values()][0].payload.registrations.length, 128);
});
test('migration declares exact subject plus identity-tenant RLS and no delete grant', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/0009_signup_registrations.sql'), 'utf8');
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/); assert.match(sql, /FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /current_setting\('nofries\.signup_subject_key', true\)/);
    assert.match(sql, /current_setting\('nofries\.tenant_id', true\)/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON nofries\.signup_registrations TO nofries_runtime/);
    assert.doesNotMatch(sql, /GRANT[^;]*DELETE/i);
    assert.doesNotMatch(sql, /ALTER TABLE nofries\.signup_acceptance_receipts/);
});

const { createHash } = require('node:crypto');
const { createInvitation } = require('../api/shared/customerSignup/invitationAcceptance');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createSessionBoundSignupContinuation } = require('../api/shared/customerSignup/sessionBoundSignupContinuation');
function composed() {
    const h = harness(); h.at = 1700000000000; h.contextAbsent = false; h.sessionSubject = SUBJECT;
    const termsText = 'Synthetic terms, not a customer agreement.';
    const termsDigest = createHash('sha256').update(termsText).digest('hex');
    const invitation = createInvitation({ email: 'synthetic@example.invalid', tenantId: 'customer-tenant',
        organisationId: 'organisation-1', identityPolicyId: 'synthetic-policy', termsVersion: 'terms-v1', termsDigest,
        mfaRequired: true, createdAt: h.at, expiresAt: h.at + 600000 }, { now: () => h.at });
    h.invitation = invitation.record;
    h.invitationStore = {
        async read() { return copy(h.invitation); },
        async transact(digest, work) {
            const result = await work(copy(h.invitation));
            if (h.failInvitationWrite) throw new Error('synthetic-blob-error');
            if (h.beforeInvitationWrite) await h.beforeInvitationWrite(result.record);
            h.invitation = copy(result.record); return copy(result.result);
        }
    };
    const continuation = createSessionBoundSignupContinuation({ database: h.database,
        readRegistration: h.store.readRegistration, now: () => h.at,
        readSessionDetails: async cookie => cookie === 'synthetic-cookie' && h.sessionSubject ? {
            identity: { provider: 'entra-bff', isAuthenticated: true, subjectKey: h.sessionSubject,
                tenantId: h.sessionSubject.slice(0, 36), principalId: h.sessionSubject.slice(37) },
            expiresAt: new Date(h.at + 60000).toISOString()
        } : null
    });
    h.options = { database: h.database, registrationStore: h.store, store: h.invitationStore,
        now: () => h.at, resolveContext: async () => h.contextAbsent ? null : {
            invitationToken: invitation.invitationToken, identityProofHandle: 'synthetic-proof-handle' },
        resolveTerms: async () => ({ termsText, termsVersion: 'terms-v1', termsDigest }),
        verifyIdentity: async ({ invitationDigest }) => ({ subjectKey: SUBJECT, email: 'synthetic@example.invalid',
            emailVerified: true, identityPolicyId: 'synthetic-policy', mfaSatisfied: true,
            invitationDigest, verifiedAt: 1700000000000, expiresAt: 1700000300000 }),
        loadContinuationState: continuation
    };
    h.handlers = createJournaledSignupHandlers(h.options);
    h.command = { req: { headers: { cookie: 'synthetic-cookie' } },
        input: { accepted: true, termsVersion: 'terms-v1', termsDigest } };
    return h;
}
test('real acceptance composition populates registration after its durable receipt', async () => {
    const h = composed();
    assert.deepEqual(await h.handlers.acceptTerms(h.command), { status: 'pending_admission' });
    const journalIndex = h.calls.findIndex(call => call.sql.includes('INSERT INTO nofries.signup_acceptance_receipts'));
    const registryIndex = h.calls.findIndex(call => call.sql.includes('INSERT INTO nofries.signup_registrations'));
    assert.ok(journalIndex >= 0 && registryIndex > journalIndex);
    assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 1); assert.equal(h.invitation.status, 'accepted');
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).receiptId, h.invitation.acceptance.receiptId);
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'pending_admission' });
});

test('served signup HTTP journey journals consent, resumes after bootstrap removal and denies revocation', async () => {
    const request = require('supertest');
    const { createNoFriesApp } = require('../server');
    const h = composed(), csrf = 'z'.repeat(43);
    const app = createNoFriesApp({ customerSignup: {
        env: { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: 'https://nofries.invalid' },
        ...h.handlers,
        issueCsrfToken: async () => csrf,
        validateCsrfToken: async (_req, value) => value === csrf
    } });
    assert.equal((await request(app).get('/signup')).status, 200);
    const state = await request(app).get('/api/customer-signup/state').set('Cookie', 'synthetic-cookie');
    assert.equal(state.status, 200);
    assert.equal(state.body.state.status, 'terms');
    const accepted = await request(app).post('/api/customer-signup/terms')
        .set('Origin', 'https://nofries.invalid').set('Cookie', 'synthetic-cookie')
        .set('X-CSRF-Token', state.body.csrfToken).send(h.command.input);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { state: { status: 'pending_admission' } });
    assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 1);
    const saved = h.invitation.acceptance;
    h.contextAbsent = true; h.invitation = null;
    const resumed = await request(app).get('/api/customer-signup/state').set('Cookie', 'synthetic-cookie');
    assert.deepEqual(resumed.body, { state: { status: 'pending_admission' } });
    h.sessionSubject = OTHER;
    assert.deepEqual((await request(app).get('/api/customer-signup/state').set('Cookie', 'synthetic-cookie')).body,
        { state: { status: 'unavailable' } });
    h.sessionSubject = SUBJECT;
    await h.store.revokeRegistration(query(saved, 1));
    assert.deepEqual((await request(app).get('/api/customer-signup/state').set('Cookie', 'synthetic-cookie')).body,
        { state: { status: 'unavailable' } });
    assert.equal(h.receipts.size, 1);
});
test('real returning continuation uses the registry after temporary invitation deletion', async () => {
    const h = composed(); await h.handlers.acceptTerms(h.command); h.invitation = null; h.contextAbsent = true;
    const before = h.calls.filter(call => /^(INSERT|UPDATE)/.test(call.sql)).length;
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'pending_admission' });
    assert.equal(h.calls.filter(call => /^(INSERT|UPDATE)/.test(call.sql)).length, before);
    h.sessionSubject = OTHER;
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'unavailable' });
});
test('failed registration write withholds acknowledgement and preserves recoverable receipt', async () => {
    const h = composed(); h.failQuery = 'UPDATE nofries.signup_registrations';
    await assert.rejects(h.handlers.acceptTerms(h.command));
    assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 0); assert.equal(h.invitation.status, 'invited');
    const originalReceiptId = [...h.receipts.values()][0].receipt.receiptId;
    h.failQuery = null;
    const before = h.calls.length;
    assert.equal((await h.handlers.loadState(h.command.req)).status, 'resume_acceptance');
    assert.ok(h.calls.slice(before).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    await h.handlers.resumeAcceptance({ req: h.command.req });
    assert.equal(h.receipts.size, 1); assert.equal(h.invitation.acceptance.receiptId, originalReceiptId);
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).receiptId, originalReceiptId);
});
test('missing invitation never recreates a registration from a durable receipt', async () => {
    const h = composed(); h.failQuery = 'UPDATE nofries.signup_registrations';
    await assert.rejects(h.handlers.acceptTerms(h.command));
    assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 0);
    h.failQuery = null; h.invitation = null; h.contextAbsent = true;
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'unavailable' });
    await assert.rejects(h.handlers.resumeAcceptance({ req: h.command.req }),
        error => error.code === 'signup_identity_required');
    assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 0);
});
test('journal failure prevents any registration population', async () => {
    const h = composed(); h.failQuery = 'INSERT INTO nofries.signup_acceptance_receipts';
    await assert.rejects(h.handlers.acceptTerms(h.command));
    assert.equal(h.receipts.size, 0); assert.equal(h.rows.size, 0); assert.equal(h.invitation.status, 'invited');
    assert.ok(!h.calls.some(call => call.sql.includes('INSERT INTO nofries.signup_registrations')));
});
test('failed temporary invitation write can retry without replacing registration or receipt', async () => {
    const h = composed(); h.failInvitationWrite = true;
    await assert.rejects(h.handlers.acceptTerms(h.command));
    assert.equal(h.invitation.status, 'invited'); assert.equal(h.receipts.size, 1); assert.equal(h.rows.size, 1);
    const original = await h.store.readRegistration({ subjectKey: SUBJECT }); h.failInvitationWrite = false;
    await h.handlers.acceptTerms(h.command);
    assert.deepEqual(await h.store.readRegistration({ subjectKey: SUBJECT }), original);
});
test('both invitation and returning paths respect current registration revocation', async () => {
    const h = composed(); await h.handlers.acceptTerms(h.command);
    const r = h.invitation.acceptance; await h.store.revokeRegistration(query(r, 1));
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'unavailable' });
    await assert.rejects(h.handlers.acceptTerms(h.command));
    h.contextAbsent = true; h.invitation = null;
    assert.deepEqual(await h.handlers.loadState(h.command.req), { status: 'unavailable' });
    assert.equal((await h.store.readForInvitation(scoped(r))).status, 'revoked'); assert.equal(h.receipts.size, 1);
});
test('revocation between registry write and recheck withholds acceptance success', async () => {
    const h = composed(); let once = true;
    h.handlers = createJournaledSignupHandlers({ ...h.options, registrationStore: {
        registerAcceptance: h.store.registerAcceptance,
        async readForInvitation(ref) {
            const result = await h.store.readForInvitation(ref);
            if (once) { once = false; await h.store.revokeRegistration({ ...ref, expectedRevision: result.revision }); }
            return h.store.readForInvitation(ref);
        }
    } });
    await assert.rejects(h.handlers.acceptTerms(h.command));
    assert.equal(h.invitation.status, 'invited'); assert.equal(h.receipts.size, 1);
});
for (const change of ['revocation', 'revision']) {
    test(`acceptance rejects registration ${change} during the final invitation write`, async () => {
        const h = composed();
        h.beforeInvitationWrite = async record => {
            const current = await h.store.readForInvitation(scoped(record.acceptance));
            if (change === 'revocation') await h.store.revokeRegistration(query(record.acceptance, current.revision));
            else await h.store.registerAcceptance(receipt({ invitationId: 'another-invitation' }));
        };
        await assert.rejects(h.handlers.acceptTerms(h.command), error =>
            ['signup_registration_unavailable', 'signup_registration_changed'].includes(error.code));
        assert.equal(h.invitation.status, 'accepted');
        assert.equal(h.receipts.size, 1);
        if (change === 'revocation') {
            h.beforeInvitationWrite = null;
            await assert.rejects(h.handlers.acceptTerms(h.command));
            assert.equal((await h.store.readForInvitation(scoped(h.invitation.acceptance))).status, 'revoked');
        }
    });
}

test('proof expiry during registration I/O still prevents acknowledgement', async () => {
    const h = composed(); h.handlers = createJournaledSignupHandlers({ ...h.options, registrationStore: {
        async registerAcceptance(r) { const result = await h.store.registerAcceptance(r); h.at += 300001; return result; },
        readForInvitation: h.store.readForInvitation
    } });
    await assert.rejects(h.handlers.acceptTerms(h.command), error => error.code === 'signup_identity_required');
    assert.equal(h.invitation.status, 'invited'); assert.equal(h.receipts.size, 1);
});
test('proof expiry during the post-write registration read withholds acknowledgement', async () => {
    const h = composed(); let reads = 0;
    h.handlers = createJournaledSignupHandlers({ ...h.options, registrationStore: {
        registerAcceptance: h.store.registerAcceptance,
        async readForInvitation(ref) {
            const result = await h.store.readForInvitation(ref);
            if (++reads === 2) h.at += 300001;
            return result;
        }
    } });
    await assert.rejects(h.handlers.acceptTerms(h.command), error => error.code === 'signup_identity_required');
    assert.equal(reads, 2);
    assert.equal(h.invitation.status, 'accepted');
    assert.equal(h.receipts.size, 1);
});
for (const registryEnabled of [true, false]) {
    test(`proof expiry during invitation persistence fails with registry ${registryEnabled}`, async () => {
        const h = composed();
        if (!registryEnabled) {
            const { registrationStore, ...options } = h.options;
            h.handlers = createJournaledSignupHandlers(options);
        }
        h.beforeInvitationWrite = async () => { h.at += 300001; };
        await assert.rejects(h.handlers.acceptTerms(h.command), error => error.code === 'signup_identity_required');
        assert.equal(h.invitation.status, 'accepted');
        assert.equal(h.receipts.size, 1);
    });
}
test('caller cannot replace the organisation or identity through terms input', async () => {
    const h = composed(); h.command.input.subjectKey = OTHER;
    await assert.rejects(h.handlers.acceptTerms(h.command)); assert.equal(h.calls.length, 0);
});
test('invalid registration-store dependency is rejected rather than ignored', () => {
    const h = composed();
    for (const registrationStore of [null, undefined, {}, { registerAcceptance() {} }]) {
        assert.throws(() => createJournaledSignupHandlers({ ...h.options, registrationStore }), /signup_registration_store_required/);
    }
});
test('legacy unconfigured composition retains previous behaviour without registry writes', async () => {
    const h = composed(), { registrationStore, ...options } = h.options;
    const handlers = createJournaledSignupHandlers(options);
    assert.deepEqual(await handlers.acceptTerms(h.command), { status: 'pending_admission' });
    assert.deepEqual(await handlers.loadState(h.command.req), { status: 'pending_admission' });
    assert.equal(h.rows.size, 0); assert.equal(h.receipts.size, 1);
});


test('invitation GET rechecks identity after the added registration I/O', async () => {
    const h = composed(); await h.handlers.acceptTerms(h.command);
    const handlers = createJournaledSignupHandlers({ ...h.options, registrationStore: {
        registerAcceptance: h.store.registerAcceptance,
        async readForInvitation(ref) { const result = await h.store.readForInvitation(ref); h.at += 300001; return result; }
    } });
    assert.deepEqual(await handlers.loadState(h.command.req), { status: 'unavailable' });
});

for (const contextMode of ['token', 'verified-digest']) for (const elapsed of [299999, 300000, 300001]) {
    test(`invitation GET checks proof at final registration read plus ${elapsed}ms with ${contextMode}`, async () => {
        const h = composed();
        if (contextMode === 'verified-digest') {
            const resolve = h.options.resolveContext;
            h.options = { ...h.options, contextMode, async resolveContext(req) {
                const context = await resolve(req);
                return { invitationDigest: require('../api/shared/customerSignup/invitationAcceptance').tokenDigest(context.invitationToken),
                    identityProofHandle: context.identityProofHandle };
            } };
            h.handlers = createJournaledSignupHandlers(h.options);
        }
        await h.handlers.acceptTerms(h.command);
        let reads = 0;
        const handlers = createJournaledSignupHandlers({ ...h.options, registrationStore: {
            registerAcceptance: h.store.registerAcceptance,
            async readForInvitation(ref) {
                const result = await h.store.readForInvitation(ref);
                if (++reads === 2) h.at += elapsed;
                return result;
            }
        } });
        const before = h.calls.filter(call => /^(INSERT|UPDATE)/.test(call.sql)).length;
        assert.deepEqual(await handlers.loadState(h.command.req), {
            status: elapsed < 300000 ? 'pending_admission' : 'unavailable'
        });
        assert.equal(reads, 2);
        assert.equal(h.calls.filter(call => /^(INSERT|UPDATE)/.test(call.sql)).length, before);
        assert.equal(h.receipts.size, 1);
    });
}

test('invitation GET rejects proof older than maximum age after final registration I/O', async () => {
    const h = composed(); await h.handlers.acceptTerms(h.command);
    let reads = 0;
    const handlers = createJournaledSignupHandlers({ ...h.options,
        async verifyIdentity(input) { return { ...await h.options.verifyIdentity(input), expiresAt: h.at + 600000 }; },
        registrationStore: {
            registerAcceptance: h.store.registerAcceptance,
            async readForInvitation(ref) {
                const result = await h.store.readForInvitation(ref);
                if (++reads === 2) h.at += 300001;
                return result;
            }
        }
    });
    assert.deepEqual(await handlers.loadState(h.command.req), { status: 'unavailable' });
    assert.equal(reads, 2);
});

test('terms GET rechecks proof after awaiting exact terms text', async () => {
    const h = composed();
    const handlers = createJournaledSignupHandlers({ ...h.options,
        async resolveTerms(input) {
            const terms = await h.options.resolveTerms(input);
            h.at += 300001;
            return terms;
        }
    });
    assert.deepEqual(await handlers.loadState(h.command.req), { status: 'unavailable' });
    assert.equal(h.receipts.size, 0);
});

test('receipt-only GET rechecks proof after the last journal read', async () => {
    const h = composed(); await h.handlers.acceptTerms(h.command);
    const { registrationStore, ...options } = h.options;
    let reads = 0;
    const handlers = createJournaledSignupHandlers({ ...options, database: {
        async withTenantTransaction(tenant, work) {
            const result = await h.database.withTenantTransaction(tenant, work);
            if (++reads === 2) h.at += 300001;
            return result;
        }
    } });
    assert.deepEqual(await handlers.loadState(h.command.req), { status: 'unavailable' });
    assert.equal(reads, 2);
    assert.equal(h.receipts.size, 1);
});


for (const change of ['revocation', 'revision']) {
    test(`invitation GET rejects registration ${change} during final identity lookup`, async () => {
        const h = composed(); await h.handlers.acceptTerms(h.command);
        let reads = 0;
        const handlers = createJournaledSignupHandlers({ ...h.options,
            async verifyIdentity(input) {
                const identity = await h.options.verifyIdentity(input);
                if (++reads === 2) {
                    const current = await h.store.readRegistration({ subjectKey: SUBJECT });
                    if (change === 'revocation') await h.store.revokeRegistration(query(h.invitation.acceptance, current.revision));
                    else await h.store.registerAcceptance(receipt({ invitationId: 'another-invitation' }));
                }
                return identity;
            }
        });
        assert.deepEqual(await handlers.loadState(h.command.req), { status: 'unavailable' });
        assert.equal(reads, 2);
        assert.equal(h.receipts.size, 1);
        assert.equal(h.invitation.status, 'accepted');
    });
}

test('JSON persistence fixtures keep local prototypes with an injected host clone', () => {
    const observed = JSON.parse(vm.runInNewContext(`
        const copy = (${copy.toString()});
        const source = {
            receipt: { receiptId: 'fixture-receipt', subjectKey: 'fixture-subject',
                acceptedAt: 1700000000000, dashboardAccess: false },
            nested: [{ value: 'retained', empty: null }]
        };
        const before = JSON.stringify(source);
        const saved = copy(source);
        const observed = {
            sameData: JSON.stringify(saved) === before,
            localRoot: Object.getPrototypeOf(saved) === Object.prototype,
            localReceipt: Object.getPrototypeOf(saved.receipt) === Object.prototype,
            localArray: Object.getPrototypeOf(saved.nested) === Array.prototype,
            localChild: Object.getPrototypeOf(saved.nested[0]) === Object.prototype,
            detached: saved !== source && saved.receipt !== source.receipt &&
                saved.nested !== source.nested && saved.nested[0] !== source.nested[0]
        };
        saved.receipt.receiptId = 'changed';
        saved.nested[0].value = 'changed';
        saved.nested.push({ value: 'new' });
        observed.sourceUnchanged = JSON.stringify(source) === before;
        JSON.stringify(observed);
    `, { structuredClone }));
    for (const [check, passed] of Object.entries(observed)) assert.equal(passed, true, check);
});

const scopeHash = value => createHash('sha256').update(JSON.stringify([value.tenantId, value.organisationId, value.invitationId])).digest('hex');
const subjectHeader = (h, subjectKey = SUBJECT) => h.rows.get(`${subjectKey.slice(0, 36)}|${subjectKey}`);
const scopeRow = (h, value) => h.rows.get(`${value.subjectKey.slice(0, 36)}|${value.subjectKey}|${scopeHash(value)}`);
const scopedReceipt = index => receipt({ organisationId: `organisation-${index}`, invitationId: `invite-${index}`, receiptId: `receipt-${index}` });

test('scoped writes are an explicit source capability and require the supported future layout', async () => {
    const h = harness({ future: true });
    await rejectsCode(h.store.registerScopedAcceptance(receipt()), 'signup_registration_read_only');
    assert.equal(h.calls.length, 0); assert.equal(h.rows.size, 0);
    const old = harness({ allowScopedWrites: true });
    await rejectsCode(old.store.registerScopedAcceptance(receipt()), 'signup_registration_layout_required');
    assert.equal(old.rows.size, 0);
    for (const allowScopedWrites of [null, 1, 'true', {}]) {
        assert.throws(() => createPostgresSignupRegistrationStore({ database: h.database, allowScopedWrites }), /signup_registration_database_required/);
    }
});

test('future layout retains exact legacy writes, receipt replays and the historical aggregate bound', async () => {
    const h = harness({ future: true, allowScopedWrites: true }), first = receipt();
    await h.store.registerAcceptance(first);
    const before = copy(subjectHeader(h));
    assert.equal(await h.store.readStorageMode({ subjectKey: SUBJECT }), 'legacy');
    await h.store.registerScopedAcceptance(first);
    assert.deepEqual(subjectHeader(h), before); assert.equal(h.rows.size, 1);
    for (let index = 2; index <= 128; index += 1) await h.store.registerAcceptance(scopedReceipt(index));
    await rejectsCode(h.store.registerAcceptance(scopedReceipt(129)), 'signup_registration_capacity');
    assert.equal(subjectHeader(h).payload.schemaVersion, 1); assert.equal(h.rows.size, 1);
});

test('scoped registration exceeds 128 without growing the header or issuing an unbounded subject read', async () => {
    const h = harness({ future: true, allowScopedWrites: true });
    for (let index = 1; index <= 260; index += 1) await h.store.registerScopedAcceptance(scopedReceipt(index));
    assert.equal(h.rows.size, 261); assert.equal(subjectHeader(h).revision, '260');
    assert.equal(subjectHeader(h).payload.schemaVersion, 2);
    assert.deepEqual(Object.keys(subjectHeader(h).payload), ['schemaVersion', 'subjectKey', 'revision', 'selected']);
    assert.ok(Buffer.byteLength(JSON.stringify(subjectHeader(h).payload)) < 512);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    const before = h.calls.length;
    const restarted = createPostgresSignupRegistrationStore({ database: h.database });
    assert.equal((await restarted.readForInvitation(scoped(scopedReceipt(259)))).revision, 260);
    assert.equal(await restarted.readStorageMode({ subjectKey: SUBJECT }), 'scoped');
    assert.ok(h.calls.slice(before).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    const selects = h.calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM nofries.signup_registrations'));
    assert.ok(selects.every(call => /LIMIT [12]\b/.test(call.sql)));
    assert.ok(selects.filter(call => call.sql.includes("pending_admission")).every(call => call.sql.includes("row_key<>''") && /LIMIT 2\b/.test(call.sql)));
    assert.ok(h.calls.every(call => !/schema_migrations|GRANT|DISABLE ROW|DELETE/.test(call.sql)));
});

test('conversion copies all 128 historical bindings and tombstones atomically without changing receipt bytes', async () => {
    const h = harness({ future: true, allowScopedWrites: true });
    for (let index = 1; index <= 128; index += 1) await h.store.registerAcceptance(scopedReceipt(index));
    await h.store.revokeRegistration(query(scopedReceipt(2), 128));
    await h.store.selectRegistration(query(scopedReceipt(1), 129));
    const before = copy(subjectHeader(h).payload), next = scopedReceipt(129);
    assert.equal((await h.store.registerScopedAcceptance(next)).revision, 131);
    assert.equal(h.rows.size, 130); assert.equal(subjectHeader(h).payload.selected, null);
    for (const binding of before.registrations) {
        assert.deepEqual(scopeRow(h, binding).payload.binding, binding);
        assert.equal(scopeRow(h, binding).payload.revision, 130);
    }
    assert.equal((await h.store.readForInvitation(scoped(scopedReceipt(2)))).status, 'revoked');
    await rejectsCode(h.store.registerScopedAcceptance(scopedReceipt(2)), 'signup_registration_revoked');
    assert.equal((await h.store.readForInvitation(scoped(scopedReceipt(1)))).revision, 131);
});

test('default reader can recover scoped entries and revoke but cannot register even an exact replay', async () => {
    const h = harness({ future: true, allowScopedWrites: true }), r = receipt();
    const saved = await h.store.registerScopedAcceptance(r);
    const reader = createPostgresSignupRegistrationStore({ database: h.database });
    assert.deepEqual(await reader.readRegistration({ subjectKey: SUBJECT }), saved);
    const start = h.calls.length;
    for (const value of [r, scopedReceipt(2)]) await rejectsCode(reader.registerAcceptance(value), 'signup_registration_read_only');
    assert.ok(h.calls.slice(start).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    const revoked = await reader.revokeRegistration(query(r, 1));
    assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revision, 2);
    assert.equal(await reader.readRegistration({ subjectKey: SUBJECT }), null);
    await rejectsCode(h.store.registerAcceptance(r), 'signup_registration_revoked');
});

test('scoped mutation projects global revision, preserves deliberate null selection and never switches on revoke', async () => {
    const h = harness({ future: true, allowScopedWrites: true }), first = scopedReceipt(1), second = scopedReceipt(2);
    await h.store.registerScopedAcceptance(first); await h.store.registerScopedAcceptance(second);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal((await h.store.registerAcceptance(first)).revision, 2);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    const selected = await h.store.selectRegistration(query(first, 2)); assert.equal(selected.revision, 3);
    assert.equal((await h.store.readForInvitation(scoped(second))).revision, 3);
    assert.deepEqual(await h.store.selectRegistration(query(first, 3)), selected);
    assert.equal((await h.store.registerScopedAcceptance(second)).revision, 3);
    assert.deepEqual(await h.store.readRegistration({ subjectKey: SUBJECT }), selected);
    await h.store.revokeRegistration(query(first, 3));
    assert.equal((await h.store.revokeRegistration(query(first, 0))).revision, 4);
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    assert.equal((await h.store.readForInvitation(scoped(second))).status, 'pending_admission');
    await rejectsCode(h.store.selectRegistration(query(second, 3)), 'signup_registration_conflict');
    await rejectsCode(h.store.registerScopedAcceptance(first), 'signup_registration_revoked');
});

test('concurrent scoped same-request replay creates one binding and different requests retain both', async () => {
    const h = harness({ future: true, allowScopedWrites: true }), first = scopedReceipt(1), second = scopedReceipt(2);
    const same = await Promise.all([h.store.registerScopedAcceptance(first), h.store.registerScopedAcceptance(first)]);
    assert.deepEqual(same[0], same[1]); assert.equal(h.rows.size, 2);
    await Promise.all([h.store.registerScopedAcceptance(second), h.store.registerScopedAcceptance(scopedReceipt(3))]);
    assert.equal(h.rows.size, 4); assert.equal(subjectHeader(h).revision, '3');
    assert.equal(await h.store.readRegistration({ subjectKey: SUBJECT }), null);
    const writes = h.calls.filter(call => /^(INSERT|UPDATE)/.test(call.sql));
    assert.ok(writes.every(call => call.tenant === SUBJECT.slice(0, 36)));
    assert.ok(h.calls.some(call => call.sql.includes("row_key='' LIMIT 2 FOR UPDATE")));
});

for (const failCommit of [true, false]) test(`scoped conversion reconciles ${failCommit ? 'rolled back' : 'uncertain committed'} transaction`, async () => {
    const h = harness({ future: true, allowScopedWrites: true }), first = scopedReceipt(1), second = scopedReceipt(2);
    await h.store.registerAcceptance(first); const before = copy(subjectHeader(h));
    h.failCommit = failCommit; h.loseCommitReply = !failCommit;
    await rejectsCode(h.store.registerScopedAcceptance(second), 'signup_registration_unavailable');
    if (failCommit) { assert.deepEqual(subjectHeader(h), before); assert.equal(h.rows.size, 1); }
    else { assert.equal(subjectHeader(h).payload.schemaVersion, 2); assert.equal(h.rows.size, 3); }
    h.failCommit = false; h.loseCommitReply = false;
    assert.equal((await h.store.registerScopedAcceptance(second)).revision, 2);
    assert.equal(h.rows.size, 3); assert.equal(subjectHeader(h).payload.selected, null);
    assert.equal((await h.store.readForInvitation(scoped(first))).revision, 2);
});

for (const changed of [{ receiptId: 'different' }, { termsVersion: 'different' }, { termsDigest: 'b'.repeat(64) },
    { scheduleId: 'different', scheduleDigest: 'c'.repeat(64) }]) {
    test(`scoped hash hit compares full receipt binding: ${Object.keys(changed)[0]}`, async () => {
        const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
        await rejectsCode(h.store.registerScopedAcceptance(receipt(changed)), 'signup_registration_conflict');
        assert.equal(subjectHeader(h).revision, '1');
    });
}
test('scoped replay cannot omit an existing signed schedule', async () => {
    const h = harness({ future: true, allowScopedWrites: true });
    await h.store.registerScopedAcceptance(receipt({ scheduleId: 'schedule-1', scheduleDigest: 'c'.repeat(64) }));
    await rejectsCode(h.store.registerScopedAcceptance(receipt()), 'signup_registration_conflict');
});

for (const other of [OTHER, FOREIGN]) test(`scoped point reads and mutations isolate subject ${other}`, async () => {
    const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
    assert.equal(await h.store.readForInvitation(scoped(receipt({ subjectKey: other }))), null);
    await rejectsCode(h.store.revokeRegistration(query(receipt({ subjectKey: other }), 1)), 'signup_registration_not_found');
    await h.store.registerScopedAcceptance(receipt({ subjectKey: other, receiptId: 'other-receipt' }));
    assert.equal((await h.store.readRegistration({ subjectKey: SUBJECT })).receiptId, 'receipt-1');
    assert.equal((await h.store.readRegistration({ subjectKey: other })).receiptId, 'other-receipt');
});

test('scope hash is only an index: punctuation and Unicode retain exact tenant, organisation and invitation identity', async () => {
    const h = harness({ future: true, allowScopedWrites: true }), r = receipt({ tenantId: 'tenant[,]"\\', organisationId: '漢字 😀', invitationId: 'invitation/\\[,]"' });
    const result = await h.store.registerScopedAcceptance(r);
    assert.deepEqual(await h.store.readForInvitation(scoped(r)), result);
    assert.equal(scopeRow(h, r).row_key, scopeHash(r));
    for (const changes of [{ tenantId: 'foreign' }, { organisationId: 'other' }, { invitationId: 'other' }]) {
        assert.equal(await h.store.readForInvitation(scoped({ ...r, ...changes })), null);
    }
});

for (const mutate of [
    row => { row.identity_tenant_id = FOREIGN.slice(0, 36); },
    row => { row.subject_key = OTHER; },
    row => { row.row_key = 'a'.repeat(64); },
    row => { row.payload.subjectKey = OTHER; },
    row => { row.payload.binding.subjectKey = OTHER; },
    row => { row.payload.binding.organisationId = 'swapped'; },
    row => { row.payload.binding.tenantId = 'foreign'; },
    row => { row.payload.binding.invitationId = 'swapped'; },
    row => { row.payload.binding.termsDigest = 'invalid'; },
    row => { row.payload.binding.extra = true; },
    row => { row.payload.binding.status = 'revoked'; },
    row => { row.payload.revision = 2; row.revision = '2'; },
    row => { row.revision = '2'; },
    row => { row.payload.extra = true; }
]) test(`malformed scoped point record fails closed: ${mutate.toString()}`, async () => {
    const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
    mutate(scopeRow(h, receipt()));
    await rejectsCode(h.store.readRegistration({ subjectKey: SUBJECT }), 'signup_registration_record_invalid');
    await rejectsCode(h.store.registerScopedAcceptance(receipt()), 'signup_registration_record_invalid');
});

for (const missingHeader of [true, false]) test(`orphan scoped rows fail closed with ${missingHeader ? 'no' : 'legacy'} header`, async () => {
    const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
    if (missingHeader) h.rows.delete(`${SUBJECT.slice(0, 36)}|${SUBJECT}`);
    else subjectHeader(h).payload = { schemaVersion: 1, subjectKey: SUBJECT, revision: 1, selected: null, registrations: [] };
    const before = h.calls.length;
    await rejectsCode(h.store.readStorageMode({ subjectKey: SUBJECT }), 'signup_registration_record_invalid');
    await rejectsCode(h.store.registerScopedAcceptance(scopedReceipt(2)), 'signup_registration_record_invalid');
    assert.ok(h.calls.slice(before).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    assert.ok(h.calls.slice(before).some(call => call.sql.includes("row_key>'' ORDER BY row_key LIMIT 1")));
});

for (const catalogRows of [[{ is_text: false, not_null: true, scoped_primary_key: true }],
    [{ is_text: true, not_null: false, scoped_primary_key: true }], [{ is_text: true, not_null: true, scoped_primary_key: false }],
    [{ is_text: true, not_null: true }], [{ is_text: true, not_null: true, scoped_primary_key: true, extra: true }], [{}, {}]]) {
    test(`partial or unknown layout fails closed: ${JSON.stringify(catalogRows)}`, async () => {
        const h = harness({ future: true, allowScopedWrites: true }); h.catalogRows = catalogRows;
        await rejectsCode(h.store.readStorageMode({ subjectKey: SUBJECT }), 'signup_registration_record_invalid');
        await rejectsCode(h.store.registerScopedAcceptance(receipt()), 'signup_registration_record_invalid');
        assert.equal(h.rows.size, 0);
    });
}

test('layout is discovered per transaction across additive DDL rather than cached for the process lifetime', async () => {
    const h = harness({ allowScopedWrites: true }); await h.store.registerAcceptance(receipt());
    h.future = true; subjectHeader(h).row_key = '';
    assert.equal((await h.store.registerScopedAcceptance(scopedReceipt(2))).revision, 2);
    assert.equal(await h.store.readStorageMode({ subjectKey: SUBJECT }), 'scoped');
});

test('exported transaction helpers validate mode with exact bounded locks and no separate transaction', async () => {
    const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
    const before = h.calls.length;
    await h.database.withTenantTransaction(SUBJECT.slice(0, 36), async tx => {
        await tx.query("SELECT set_config('nofries.signup_subject_key', $1, true)", [SUBJECT]);
        assert.deepEqual(await readSignupRegistrationHeader(tx, SUBJECT), { subjectKey: SUBJECT, storageMode: 'scoped' });
        assert.deepEqual(await lockSignupRegistrationHeader(tx, SUBJECT), { subjectKey: SUBJECT, storageMode: 'scoped' });
        await rejectsCode(readSignupRegistrationHeader(tx, SUBJECT, { lock: 'DELETE' }), 'signup_registration_input_invalid');
        await rejectsCode(readSignupRegistrationHeader(tx, SUBJECT, { extra: true }), 'signup_registration_input_invalid');
    });
    assert.ok(h.calls.slice(before).some(call => call.sql.includes("row_key='' LIMIT 2 FOR SHARE")));
    assert.ok(h.calls.slice(before).some(call => call.sql.includes("row_key='' LIMIT 2 FOR UPDATE")));
    assert.ok(h.calls.slice(before).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
});

test('per-effect writable assertion fails before journal effects for the default reader on scoped subjects', async () => {
    const h = harness({ future: true, allowScopedWrites: true }); await h.store.registerScopedAcceptance(receipt());
    const reader = createPostgresSignupRegistrationStore({ database: h.database }), before = copy([...h.rows]), start = h.calls.length;
    await rejectsCode(reader.assertAcceptanceWritable({ subjectKey: SUBJECT }), 'signup_registration_read_only');
    assert.equal(await h.store.assertAcceptanceWritable({ subjectKey: SUBJECT }), undefined);
    assert.deepEqual([...h.rows], before);
    assert.ok(h.calls.slice(start).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
});

test('per-effect writable assertion preserves legacy SQL and absent-subject behaviour without creating registrations', async () => {
    for (const future of [false]) {
        const h = harness({ future });
        assert.equal(await h.store.assertAcceptanceWritable({ subjectKey: SUBJECT }), undefined); assert.equal(h.rows.size, 0);
        await h.store.registerAcceptance(receipt()); const start = h.calls.length;
        assert.equal(await h.store.assertAcceptanceWritable({ subjectKey: SUBJECT }), undefined);
        assert.equal(subjectHeader(h).payload.schemaVersion, 1);
        assert.ok(h.calls.slice(start).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
        const before = h.calls.length;
        await rejectsCode(h.store.assertAcceptanceWritable({ subjectKey: SUBJECT, scoped: true }), 'signup_registration_input_invalid');
        assert.equal(h.calls.length, before);
    }
});

test('missing-header orphan probe rechecks once when a concurrent first acceptance committed a valid header', async () => {
    const h = harness({ future: true, allowScopedWrites: true });
    await h.store.registerScopedAcceptance(scopedReceipt(1)); await h.store.registerScopedAcceptance(scopedReceipt(2));
    const calls = []; let headerReads = 0;
    const tx = { async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('pg_catalog.pg_attribute')) return { rows: [{ is_text: true, not_null: true, scoped_primary_key: true }] };
        assert.deepEqual(params, [SUBJECT.slice(0, 36), SUBJECT]);
        if (sql.includes("row_key>''")) return { rows: [{ row_key: scopeHash(scopedReceipt(1)) }] };
        assert.match(sql, /row_key='' LIMIT 2 FOR SHARE/);
        headerReads += 1; return { rows: headerReads === 1 ? [] : [copy(subjectHeader(h))] };
    } };
    assert.deepEqual(await readSignupRegistrationHeader(tx, SUBJECT), { subjectKey: SUBJECT, storageMode: 'scoped' });
    assert.equal(headerReads, 2); assert.equal(calls.length, 4);
    assert.ok(calls.every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
});

for (const headerKind of ['absent', 'legacy', 'scoped']) test(`default recovery capability closes all registration effects on scoped SQL with ${headerKind} header`, async () => {
    const h = harness({ future: true, allowScopedWrites: true }), r = receipt();
    if (headerKind === 'legacy') await h.store.registerAcceptance(r);
    if (headerKind === 'scoped') await h.store.registerScopedAcceptance(r);
    const recovery = createPostgresSignupRegistrationStore({ database: h.database });
    const before = copy([...h.rows]), start = h.calls.length;
    for (const operation of [() => recovery.registerAcceptance(r), () => recovery.registerAcceptance(scopedReceipt(2)),
        () => recovery.registerScopedAcceptance(r), () => recovery.assertAcceptanceWritable({ subjectKey: SUBJECT })]) {
        await rejectsCode(operation(), 'signup_registration_read_only');
    }
    assert.deepEqual([...h.rows], before);
    assert.ok(h.calls.slice(start).every(call => !/^(INSERT|UPDATE)/.test(call.sql)));
    assert.ok(h.calls.slice(start).every(call => !call.sql.includes('FROM nofries.signup_registrations')));
    assert.equal(await recovery.readStorageLayout({ subjectKey: SUBJECT }), 'scoped');
    assert.equal(await recovery.readStorageMode({ subjectKey: SUBJECT }), headerKind === 'absent' ? null : headerKind);
    assert.equal(await h.store.assertAcceptanceWritable({ subjectKey: SUBJECT }), undefined);
    if (headerKind !== 'absent') {
        assert.equal((await recovery.readForInvitation(scoped(r))).receiptId, r.receiptId);
        await recovery.revokeRegistration(query(r, 1));
        assert.equal((await recovery.readForInvitation(scoped(r))).status, 'revoked');
    }
});

test('layout API reports schema independently of header format and repeats the fixed bounded catalog read', async () => {
    const h = harness();
    assert.equal(await h.store.readStorageLayout({ subjectKey: SUBJECT }), 'legacy');
    await h.store.registerAcceptance(receipt());
    assert.equal(await h.store.readStorageLayout({ subjectKey: SUBJECT }), 'legacy');
    h.future = true; subjectHeader(h).row_key = '';
    assert.equal(await h.store.readStorageLayout({ subjectKey: SUBJECT }), 'scoped');
    assert.equal(await h.store.readStorageMode({ subjectKey: SUBJECT }), 'legacy');
    const calls = [];
    const tx = { async query(sql, params) { calls.push({ sql, params });
        return { rows: [{ is_text: true, not_null: true, scoped_primary_key: true }] }; } };
    assert.equal(await readSignupRegistrationLayout(tx), 'scoped');
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, []);
    assert.match(calls[0].sql, /pg_catalog\.pg_attribute/); assert.match(calls[0].sql, /LIMIT 2/);
    assert.doesNotMatch(calls[0].sql, /set_config|schema_migrations|FROM nofries\.signup_registrations|GRANT|INSERT|UPDATE/);
    const start = h.calls.length;
    await rejectsCode(h.store.readStorageLayout({ subjectKey: SUBJECT, layout: 'legacy' }), 'signup_registration_input_invalid');
    assert.equal(h.calls.length, start);
});
