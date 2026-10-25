'use strict';
const { createInvitation, createInvitationAcceptance, tokenDigest } = require('../api/shared/customerSignup/invitationAcceptance');
const NOW = Date.parse('2026-09-12T07:00:00.000Z');
const SUBJECT = '10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002';
const OTHER = SUBJECT.replace('20000000', '30000000');
const issuanceClock = { now: () => NOW };
function setup() {
    let clock = NOW;
    const seed = { email: 'tester@example.invalid', tenantId: 'sample-alpha', organisationId: 'sample-alpha-org',
        identityPolicyId: 'reviewed-customer-policy-v1', termsVersion: 'pilot-1', termsDigest: 'a'.repeat(64),
        mfaRequired: true, createdAt: NOW, expiresAt: NOW + 3600000 };
    const invitation = createInvitation(seed, issuanceClock);
    let record = invitation.record, tail = Promise.resolve(), commits = 0;
    // Test-only serialized transaction. Not a production persistence adapter.
    const store = { transact: jest.fn((digest, change) => {
        const job = tail.then(() => {
            const next = change(structuredClone(record));
            record = structuredClone(next.record); commits++;
            return structuredClone(next.result);
        });
        tail = job.catch(() => {});
        return job;
    }) };
    const proof = { subjectKey: SUBJECT, email: seed.email, emailVerified: true, identityPolicyId: seed.identityPolicyId,
        mfaSatisfied: true, invitationDigest: record.tokenDigest, verifiedAt: NOW, expiresAt: NOW + 300000 };
    const verifyIdentity = jest.fn(async () => ({ ...proof }));
    const service = createInvitationAcceptance({ store, verifyIdentity, now: () => clock });
    const input = { invitationToken: invitation.invitationToken, identityProofHandle: 'synthetic-server-session-handle',
        termsVersion: seed.termsVersion, termsDigest: seed.termsDigest, accepted: true };
    return { seed, input, proof, store, verifyIdentity, service, invitation,
        setRecord(value) { record = value; }, getRecord: () => structuredClone(record), commits: () => commits,
        setClock(value) { clock = value; } };
}
test('creates an opaque invitation with no password, role, grant or raw-token storage', () => {
    const f = setup();
    expect(f.invitation.invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenDigest(f.input.invitationToken)).toBe(f.getRecord().tokenDigest);
    expect(JSON.stringify(f.getRecord())).not.toContain(f.input.invitationToken);
    expect(f.getRecord()).not.toHaveProperty('roles');
    expect(createInvitation(f.seed, issuanceClock).invitationToken).not.toBe(f.input.invitationToken);
});
test('rejects an email whose case-folded form exceeds the storage limit', () => {
    const f = setup();
    const expandingEmail = `İİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİİ@x.co`;
    expect(expandingEmail.length).toBeLessThanOrEqual(254);
    expect(expandingEmail.toLowerCase().length).toBeGreaterThan(254);
    expect(() => createInvitation({ ...f.seed, email: expandingEmail }, issuanceClock)).toThrow('signup_unavailable');
});

test('issuance rejects future timestamps and expired invitations against a trusted clock', () => {
    const f = setup(), future = NOW + 365 * 86400000;
    expect(() => createInvitation({ ...f.seed, createdAt: future, expiresAt: future + 3600000 }, issuanceClock)).toThrow();
    expect(() => createInvitation({ ...f.seed, createdAt: NOW - 60001 }, issuanceClock)).toThrow();
    expect(() => createInvitation(f.seed, { now: () => f.seed.expiresAt })).toThrow();
    expect(createInvitation({ ...f.seed, createdAt: NOW - 60000 }, issuanceClock).record.createdAt).toBe(NOW);
    expect(createInvitation({ ...f.seed, expiresAt: NOW + 7 * 86400000 }, issuanceClock).record.expiresAt).toBe(NOW + 7 * 86400000);
});
test('accepted receipt survives invitation expiry but replay still requires fresh matching identity', async () => {
    const f = setup(), receipt = await f.service.accept(f.input), original = f.getRecord();
    const later = f.seed.expiresAt + 1;
    f.setClock(later);
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_identity_required');
    f.proof.verifiedAt = later; f.proof.expiresAt = later + 300000;
    expect(await f.service.accept(f.input)).toEqual(receipt);
    expect(f.getRecord()).toEqual(original);
    f.proof.subjectKey = OTHER;
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_invitation_unavailable');
    expect(f.getRecord()).toEqual(original);
});
test('verified email and explicit current terms produce only a pending-admission receipt', async () => {
    const f = setup(), result = await f.service.accept(f.input);
    expect(result).toMatchObject({ subjectKey: SUBJECT, status: 'pending_admission', dashboardAccess: false,
        tenantId: 'sample-alpha', organisationId: 'sample-alpha-org', acceptedAt: NOW });
    expect(f.getRecord().status).toBe('accepted');
    expect(f.getRecord().revision).toBe(1);
    expect(f.verifyIdentity).toHaveBeenCalledWith({ handle: f.input.identityProofHandle,
        invitationDigest: f.getRecord().tokenDigest });
    expect(JSON.stringify(result)).not.toMatch(/tester@|synthetic-server|password|cookie|roles/);
});
test('concurrent same-subject acceptance preserves one immutable receipt and revision', async () => {
    const f = setup();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.service.accept(f.input)));
    expect(new Set(receipts.map(r => r.receiptId)).size).toBe(1);
    expect(f.getRecord().revision).toBe(1);
    expect(receipts.every(r => r.dashboardAccess === false)).toBe(true);
});
test('same email cannot reuse an accepted invitation with another immutable identity', async () => {
    const f = setup(); await f.service.accept(f.input); f.proof.subjectKey = OTHER;
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_invitation_unavailable');
    expect(f.getRecord().acceptance.subjectKey).toBe(SUBJECT);
});
test.each([
    ['unverified email', p => { p.emailVerified = false; }],
    ['invalid subject', p => { p.subjectKey = 'tester@example.invalid'; }],
    ['wrong invitation', p => { p.invitationDigest = 'b'.repeat(64); }],
    ['future verification', p => { p.verifiedAt = NOW + 1; }],
    ['stale verification', p => { p.verifiedAt = NOW - 300001; }],
    ['expired proof', p => { p.expiresAt = NOW; }],
    ['extra identity assertion', p => { p.admin = true; }]
])('rejects %s before durable mutation', async (_name, change) => {
    const f = setup(); change(f.proof);
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_identity_required');
    expect(f.store.transact).not.toHaveBeenCalled();
});
test.each([
    ['another email', f => { f.proof.email = 'another@example.invalid'; }],
    ['Gmail-style plus alias', f => { f.proof.email = 'tester+alias@example.invalid'; }],
    ['another policy', f => { f.proof.identityPolicyId = 'unapproved'; }],
    ['missing MFA', f => { f.proof.mfaSatisfied = false; }],
    ['revoked invitation', f => { f.setRecord({ ...f.getRecord(), status: 'revoked' }); }],
    ['missing invitation', f => { f.setRecord(null); }],
    ['expired invitation', f => { f.setRecord({ ...f.getRecord(), createdAt: NOW - 10000, expiresAt: NOW }); }],
    ['wrong stored digest', f => { f.setRecord({ ...f.getRecord(), tokenDigest: 'b'.repeat(64) }); }]
])('denies %s without committing', async (_name, change) => {
    const f = setup(); change(f);
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_invitation_unavailable');
    expect(f.commits()).toBe(0);
});
test.each(['termsVersion', 'termsDigest'])('rejects changed %s without accepting old terms', async field => {
    const f = setup(); f.input[field] = field === 'termsVersion' ? 'old-terms' : 'b'.repeat(64);
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_terms_changed');
    expect(f.commits()).toBe(0);
});
test.each([false, null, 'true', 1])('requires literal true consent: %s', async accepted => {
    const f = setup(); f.input.accepted = accepted;
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_terms_required');
    expect(f.verifyIdentity).not.toHaveBeenCalled();
});
test('rejects forged browser identity fields and malformed token before verifier', async () => {
    const f = setup();
    await expect(f.service.accept({ ...f.input, emailVerified: true })).rejects.toThrow();
    await expect(f.service.accept({ ...f.input, invitationToken: 'x'.repeat(100000) })).rejects.toThrow();
    expect(f.verifyIdentity).not.toHaveBeenCalled();
});
test('rechecks proof expiry under the transaction lock', async () => {
    const f = setup(), original = f.store.transact;
    f.store.transact = (...args) => { f.setClock(NOW + 300000); return original(...args); };
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_identity_required');
    expect(f.commits()).toBe(0);
});
test('stored corruption fails closed and does not become a fresh invitation', async () => {
    const f = setup(); f.setRecord({ ...f.getRecord(), status: 'accepted', acceptance: null });
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_record_invalid');
    expect(f.commits()).toBe(0);
});
test('revoked accepted record cannot regain access through idempotent replay', async () => {
    const f = setup(); await f.service.accept(f.input);
    f.setRecord({ ...f.getRecord(), status: 'revoked', revision: 2 });
    await expect(f.service.accept(f.input)).rejects.toThrow('signup_invitation_unavailable');
});
test('verifier and store exceptions are sanitized', async () => {
    const f = setup(); f.verifyIdentity.mockRejectedValueOnce(new Error('private-provider-detail'));
    await expect(f.service.accept(f.input)).rejects.toThrow(/^signup_identity_required$/);
    f.store.transact.mockRejectedValueOnce(new Error('private-connection-string'));
    await expect(f.service.accept(f.input)).rejects.toThrow(/^signup_store_unavailable$/);
});
test('invitation creation rejects unbounded expiry and malformed approved terms', () => {
    const f = setup();
    expect(() => createInvitation({ ...f.seed, expiresAt: NOW + 8 * 86400000 }, issuanceClock)).toThrow();
    expect(() => createInvitation({ ...f.seed, expiresAt: NOW }, issuanceClock)).toThrow();
    expect(() => createInvitation({ ...f.seed, termsDigest: 'not-a-hash' }, issuanceClock)).toThrow();
    expect(() => createInvitation({ ...f.seed, mfaRequired: 'false' }, issuanceClock)).toThrow();
    expect(() => createInvitation({ ...f.seed, termsDigest: ['a'.repeat(64)] }, issuanceClock)).toThrow();
    expect(() => createInvitation(new Proxy(f.seed, {}), issuanceClock)).toThrow();
});
test.each([
    ['email', f => { f.proof.email = 'other@example.invalid'; }],
    ['policy', f => { f.proof.identityPolicyId = 'other'; }],
    ['MFA', f => { f.proof.mfaSatisfied = false; }],
    ['revocation', f => { f.setRecord({ ...f.getRecord(), status: 'revoked' }); }],
    ['terms', f => { f.input.termsVersion = 'old'; }]
])('expired accepted receipt still enforces %s', async (_label, mutate) => {
    const f = setup(); await f.service.accept(f.input);
    f.setClock(f.seed.expiresAt);
    f.proof.verifiedAt = f.seed.expiresAt; f.proof.expiresAt = f.seed.expiresAt + 300000;
    mutate(f); const record = f.getRecord();
    await expect(f.service.accept(f.input)).rejects.toThrow();
    expect(f.getRecord()).toEqual(record); expect(f.commits()).toBe(1);
});
