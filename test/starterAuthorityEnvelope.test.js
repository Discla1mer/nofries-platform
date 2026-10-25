'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = global.test || require('node:test');
const { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, approvedStarterPlan, accountWindow, starterAuthorityExpiry,
    compileStarterPreparation, compileStarterActivation } = require('../api/shared/customerSignup/customerStarterPlan');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails } = require('../api/shared/customerSignup/starterSetupDetails');
const { createExternalStarterClaim, validateRetainedExternalStarterClaim } = require('../api/shared/customerSignup/externalStarterClaim');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const DAY = 86400000;
const clone = value => JSON.parse(JSON.stringify(value));
const projected = at => Date.parse(accountWindow(new Date(at).toISOString(), THREE_MONTH_PLAN_ID).validUntil);

for (const [deadline, expected] of [
    ['2027-01-31T00:00:00.000Z', '2027-04-30T23:59:59.999Z'],
    ['2027-01-31T18:12:34.567Z', '2027-04-30T23:59:59.999Z'],
    ['2027-01-30T12:34:56.789Z', '2027-04-30T12:34:56.789Z'],
    ['2026-11-29T09:00:00.123Z', '2027-02-28T23:59:59.999Z'],
    ['2026-11-28T09:00:00.123Z', '2027-02-28T09:00:00.123Z'],
    ['2027-11-30T00:00:00.000Z', '2028-02-29T23:59:59.999Z'],
    ['2027-11-29T09:00:00.123Z', '2028-02-29T09:00:00.123Z'],
    ['2028-02-29T09:00:00.123Z', '2028-05-29T09:00:00.123Z'],
    ['2027-02-01T00:00:00.000Z', '2027-05-01T00:00:00.000Z'],
    ['2026-10-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z'],
    ['2026-10-15T12:00:00.123Z', '2027-01-15T12:00:00.123Z']
]) test(`new authority envelope covers clamping before ${deadline}`, () => {
    const expiry = Date.parse(deadline), end = starterAuthorityExpiry(expiry, THREE_MONTH_PLAN_ID);
    assert.equal(end, Date.parse(expected));
    assert.ok(end >= projected(expiry));
    assert.ok(end - projected(expiry) < DAY, 'the envelope adds less than one UTC day');
    const floor = Date.parse(approvedStarterPlan(THREE_MONTH_PLAN_ID).approvedAt);
    // Samples span the whole seven-day offer, both sides of each midnight,
    // and the final permitted millisecond. Activation at the deadline is closed.
    for (let day = 0; day <= 7; day++) for (const offset of [-1, 0, 1, 12 * 3600000]) {
        const start = expiry - day * DAY - offset;
        if (start >= floor && start < expiry) assert.ok(projected(start) <= end, new Date(start).toISOString());
    }
});

test('legacy authority arithmetic is exact and the new envelope still rejects pre-approval dates', () => {
    for (const at of [1, Date.parse('2027-01-31T00:00:00.000Z'), Date.parse('2027-11-30T23:59:59.999Z')]) {
        assert.equal(starterAuthorityExpiry(at, LEGACY_PLAN_ID), at + 14 * DAY);
    }
    assert.throws(() => starterAuthorityExpiry(Date.parse('2026-10-14T23:59:59.999Z'), THREE_MONTH_PLAN_ID));
});

async function externalClaimFixture() {
    const at = Date.parse('2027-01-24T00:00:00.000Z'), subjectKey = crypto.randomUUID() + ':' + crypto.randomUUID();
    const providerKey = 'c'.repeat(64), identityPolicyId = 'synthetic-calendar-envelope', blobs = new Map(), invitationRows = new Map();
    let accountRow;
    const accounts = createStarterAccountAllocator({ planId: THREE_MONTH_PLAN_ID, now: () => at,
        readActivation: async () => null, captureOwner: async () => null,
        store: { load: async () => accountRow ? clone(accountRow) : null,
            create: async (_, record) => { accountRow = { record: clone(record), version: 1 }; return true; }, replace: async () => false } });
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId: crypto.randomUUID(), subjectKey, providerKey,
        authenticationSha256: 'd'.repeat(64), email: 'synthetic@example.test', organisationName: 'Synthetic Calendar Consultant',
        accountType: 'consultant', createdAt: at, verifiedAt: at, expiresAt: at + 3600000 };
    const setupRows = new Map(), details = createStarterSetupDetails({ accounts, now: () => at,
        framework: async () => ({ moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' }),
        store: { load: async key => setupRows.get(key) || null, create: async (key, value) => { setupRows.set(key, clone(value)); return true; } } });
    const saved = await details.save(proof, { name: 'Synthetic Owner', role: 'Owner', address: 'Synthetic address', registrationId: null, authorityConfirmed: true });
    const account = await accounts.readInitial(proof);
    const container = { getBlockBlobClient(key) { return {
        async download() {
            const bytes = blobs.get(key);
            if (!bytes) throw Object.assign(new Error('missing'), { statusCode: 404, code: 'BlobNotFound' });
            return { contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
        },
        async uploadData(bytes, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' });
            if (blobs.has(key)) throw Object.assign(new Error('exists'), { statusCode: 412 });
            blobs.set(key, Buffer.from(bytes));
        }
    }; } };
    const claim = createExternalStarterClaim({ container, providerKey, identityPolicyId, now: () => at,
        readOtherAuthority: async () => null, invitations: { read: async key => invitationRows.get(key) || null,
            create: async record => { invitationRows.set(record.tokenDigest, clone(record)); return true; } } });
    return { claim, account, saved, subjectKey, providerKey, identityPolicyId, blobs, at };
}

test('actual external claim persists and replays an envelope covering the original account and its later client', async () => {
    const f = await externalClaimFixture(), input = { account: f.account, details: f.saved,
        subjectKey: f.subjectKey, beforeMutation: async () => {} };
    const entry = await f.claim(input), path = `customer-subjects/${subjectHash(f.subjectKey)}.json`;
    const expected = Date.parse('2027-04-30T23:59:59.999Z');
    assert.equal(entry.expiresAt, expected);
    assert.deepEqual(JSON.parse(f.blobs.get(path)), entry);
    const retained = JSON.parse([...f.blobs.entries()].find(([key]) => /external-claims\/.*\.json$/.test(key) && !key.endsWith('.complete.json'))[1]);
    assert.equal(retained.invitation.expiresAt, Date.parse('2027-01-31T00:00:00.000Z'));
    assert.equal(retained.entry.expiresAt, expected);
    assert.deepEqual(validateRetainedExternalStarterClaim(retained, { account: f.account, details: f.saved, subjectKey: f.subjectKey,
        providerKey: f.providerKey, identityPolicyId: f.identityPolicyId, now: f.at }).entry, entry);
    const snapshot = [...f.blobs.entries()].map(([key, bytes]) => [key, bytes.toString()]);
    assert.deepEqual(await f.claim(input), entry);
    assert.deepEqual([...f.blobs.entries()].map(([key, bytes]) => [key, bytes.toString()]), snapshot);
    const start = '2027-01-30T12:34:56.789Z', accountEnd = accountWindow(start, THREE_MONTH_PLAN_ID).validUntil;
    assert.equal(accountEnd, '2027-04-30T12:34:56.789Z');
    const clientAt = '2027-04-30T12:00:00.000Z';
    assert.deepEqual(authority(entry, f.subjectKey, Date.parse(clientAt)), entry);
    const preparation = compileStarterPreparation({ offerInput: { ...f.saved.offerInput, kind: 'client',
        tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID(), grantId: crypto.randomUUID(), scheduleId: crypto.randomUUID() },
        subjectKey: f.subjectKey, issuerSubjectKey: f.subjectKey, invitationId: crypto.randomUUID(), createdAt: clientAt });
    const receipt = { receiptId: crypto.randomUUID(), invitationId: preparation.invitationId, subjectKey: f.subjectKey,
        ...preparation.scope, ...preparation.terms, scheduleId: preparation.schedule.scheduleId,
        scheduleDigest: preparation.schedule.scheduleDigest, acceptedAt: Date.parse(clientAt), status: 'pending_admission', dashboardAccess: false };
    const compiled = compileStarterActivation({ preparation, accountId: f.account.accountId, activationId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(), acceptance: receipt, occurredAt: clientAt, accountActivatedAt: start });
    assert.equal(compiled.activationIntent.validUntil, accountEnd);
    assert.throws(() => compileStarterActivation({ preparation, accountId: f.account.accountId, activationId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(), acceptance: receipt, occurredAt: accountEnd, accountActivatedAt: start }));
});
