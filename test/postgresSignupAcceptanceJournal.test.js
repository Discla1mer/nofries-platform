'use strict';

const { RETENTION_POLICY_ID, SignupAcceptanceJournalError, createPostgresSignupAcceptanceJournal } =
    require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT = Object.freeze({ receiptId: 'receipt-1', invitationId: 'invite-1',
    subjectKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    tenantId: 'sample-alpha', organisationId: 'sample-alpha-org', termsVersion: 'pilot-v1',
    termsDigest: 'a'.repeat(64), acceptedAt: Date.parse('2026-09-16T00:00:00.000Z'),
    status: 'pending_admission', dashboardAccess: false });

function fixture(rows = null) {
    const queries = [];
    const tx = { query: jest.fn(async (text, params) => {
        queries.push({ text, params });
        if (text.startsWith('INSERT')) {
            const payload = JSON.parse(params[12]);
            return { rows: rows === null ? [{ payload }] : rows };
        }
        return { rows };
    }) };
    const database = { withTenantTransaction: jest.fn(async (tenant, work) => work(tx)) };
    return { database, journal: createPostgresSignupAcceptanceJournal({ database }), queries, tx };
}

test('appends exact tenant-scoped decision proof with seven-year retention metadata', async () => {
    const f = fixture();
    await expect(f.journal.persist(RECEIPT)).resolves.toEqual(RECEIPT);
    expect(f.database.withTenantTransaction).toHaveBeenCalledWith('sample-alpha', expect.any(Function));
    const params = f.queries[0].params, payload = JSON.parse(params[12]);
    expect(params.slice(0, 11)).toEqual(['sample-alpha', 'sample-alpha-org', 'receipt-1', 'invite-1',
        RECEIPT.subjectKey, 'pilot-v1', RECEIPT.termsDigest, null, null, RECEIPT.acceptedAt, RETENTION_POLICY_ID]);
    expect(payload).toEqual({ schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
        deleteAfter: Date.parse('2033-09-16T00:00:00.000Z'), receipt: RECEIPT });
});

test('projects a scheduled receipt into immutable schedule columns and payload', async () => {
    const receipt = { ...RECEIPT, scheduleId: 'schedule-1', scheduleDigest: 'b'.repeat(64) };
    const f = fixture();
    await expect(f.journal.persist(receipt)).resolves.toEqual(receipt);
    expect(f.queries[0].params.slice(7, 10)).toEqual([
        receipt.scheduleId, receipt.scheduleDigest, receipt.acceptedAt
    ]);
    expect(JSON.parse(f.queries[0].params[12]).receipt).toEqual(receipt);
});

test('uses calendar retention and clamps leap day to the destination month', async () => {
    const receipt = { ...RECEIPT, acceptedAt: Date.parse('2028-02-29T12:34:56.789Z') };
    const f = fixture();
    await expect(f.journal.persist(receipt)).resolves.toEqual(receipt);
    expect(JSON.parse(f.queries[0].params[12]).deleteAfter).toBe(Date.parse('2035-02-28T12:34:56.789Z'));
});

test('reconciles an identical existing receipt without rewriting it', async () => {
    const payload = { schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
        deleteAfter: Date.parse('2033-09-16T00:00:00.000Z'), receipt: RECEIPT };
    const f = fixture([]);
    f.tx.query.mockImplementationOnce(async () => ({ rows: [] }))
        .mockImplementationOnce(async () => ({ rows: [{ payload }] }));
    await expect(f.journal.persist(RECEIPT)).resolves.toEqual(RECEIPT);
    expect(f.tx.query).toHaveBeenCalledTimes(2);
    expect(f.queries).toHaveLength(0);
});

test('fails closed on conflicting, missing and provider records', async () => {
    const conflict = fixture([]);
    conflict.tx.query.mockImplementationOnce(async () => ({ rows: [] }))
        .mockImplementationOnce(async () => ({ rows: [{ payload: { schemaVersion: 1 } }] }));
    await expect(conflict.journal.persist(RECEIPT)).rejects.toMatchObject({ code: 'signup_acceptance_journal_record_invalid' });
    const missing = fixture([]);
    await expect(missing.journal.persist(RECEIPT)).rejects.toBeInstanceOf(SignupAcceptanceJournalError);
    const unavailable = fixture(); unavailable.tx.query.mockRejectedValueOnce(new Error('private'));
    await expect(unavailable.journal.persist(RECEIPT)).rejects.toMatchObject({ code: 'signup_acceptance_journal_unavailable' });
});

test.each([
    { ...RECEIPT, dashboardAccess: true },
    { ...RECEIPT, tenantId: ' other' },
    { ...RECEIPT, termsDigest: 'bad' },
    { ...RECEIPT, extra: 'field' }
])('rejects malformed receipt %# before opening a transaction', async receipt => {
    const f = fixture();
    await expect(f.journal.persist(receipt)).rejects.toMatchObject({ code: 'signup_acceptance_receipt_invalid' });
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
});

test('migration is forced-RLS append-only decision proof with no runtime mutation grant', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../database/migrations/0008_signup_acceptance_receipts.sql'), 'utf8');
    expect(sql).toContain('ALTER TABLE nofries.signup_acceptance_receipts FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('FOR INSERT TO nofries_runtime');
    expect(sql).toContain('FOR SELECT TO nofries_runtime');
    expect(sql).toContain('GRANT SELECT, INSERT ON nofries.signup_acceptance_receipts TO nofries_runtime');
    expect(sql).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)/);
    expect(sql).toContain("retention_policy_id = 'gov-007-issued-decision-proof-7y-v1'");
    expect(sql).toContain("interval '7 years'");
    expect(sql).not.toContain('schedule_id text');
    const scheduleSql = fs.readFileSync(path.resolve(__dirname, '../database/migrations/0010_signup_acceptance_schedule.sql'), 'utf8');
    expect(scheduleSql).toContain('ADD COLUMN schedule_id text');
    expect(scheduleSql).toContain("payload -> 'receipt' ->> 'scheduleDigest' = schedule_digest");
    expect(scheduleSql).toContain("payload -> 'receipt' ?& ARRAY['receiptId','invitationId','subjectKey'");
});

test.each([
    payload => Object.assign(new (class StoredReceipt {})(), payload),
    payload => Object.defineProperty({ ...payload }, 'receipt', { enumerable: true, get: () => payload.receipt })
])('rejects non-data stored journal payloads during reconciliation %#', async mutate => {
    const payload = { schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
        deleteAfter: Date.parse('2033-09-16T00:00:00.000Z'), receipt: RECEIPT };
    const f = fixture([]);
    f.tx.query.mockImplementationOnce(async () => ({ rows: [] }))
        .mockImplementationOnce(async () => ({ rows: [{ payload: mutate(payload) }] }));
    await expect(f.journal.persist(RECEIPT)).rejects.toMatchObject({ code: 'signup_acceptance_journal_record_invalid' });
});
