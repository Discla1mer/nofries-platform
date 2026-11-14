'use strict';

const outbox = require('../api/shared/lifecycleEmail/outboxWriter');
const { enqueueActivationEmails } = require('../api/shared/lifecycleEmail/activationEmails');

const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const scope = { tenantId: 'tenant-a', organisationId: 'organisation-a', accountId: ACCOUNT };
const AT = '2026-11-13T09:00:00.000Z';
const ON = { NOFRIES_LIFECYCLE_EMAIL_ENQUEUE_ENABLED: 'true' };

// An outbox double that honours the 0021 dedupe key and the cancel filter.
function outboxDouble() {
    const rows = [], calls = [];
    return { rows, calls, async query(sql, args) {
        calls.push({ sql, args });
        if (sql.startsWith('INSERT INTO nofries.email_outbox')) {
            const [outboxId, tenantId, organisationId, accountId, type, dedupeKey, templateVersion, params, notBefore] = args;
            if (rows.some(r => r.accountId === accountId && r.organisationId === organisationId && r.type === type && r.dedupeKey === dedupeKey)) return { rows: [], rowCount: 0 };
            rows.push({ outboxId, tenantId, organisationId, accountId, type, dedupeKey, templateVersion, params, notBefore, status: 'pending' });
            return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('UPDATE nofries.email_outbox')) {
            const [tenantId, organisationId, accountId, types] = args;
            const hit = rows.filter(r => r.tenantId === tenantId && r.organisationId === organisationId && r.accountId === accountId &&
                r.status === 'pending' && types.includes(r.type));
            for (const r of hit) r.status = 'cancelled';
            return { rows: [], rowCount: hit.length };
        }
        throw new Error('Unexpected synthetic SQL');
    } };
}

describe('lifecycle email enqueue at activation (#151)', () => {
    test.each([undefined, '', 'TRUE', '1', 'true '])('flag %p queues nothing and issues no SQL', async value => {
        const db = outboxDouble();
        expect(await enqueueActivationEmails(db, { ...scope, activatedAt: AT },
            value === undefined ? {} : { NOFRIES_LIFECYCLE_EMAIL_ENQUEUE_ENABLED: value })).toBe(false);
        expect(db.calls).toEqual([]);
    });

    test('flag on queues a welcome now and an unfinished nudge seven days later, keyed by account', async () => {
        const db = outboxDouble();
        expect(await enqueueActivationEmails(db, { ...scope, activatedAt: AT }, ON)).toBe(true);
        expect(db.rows.map(({ outboxId, ...row }) => row)).toEqual([
            { ...scope, type: 'welcome', dedupeKey: ACCOUNT, templateVersion: 'welcome-v1', params: '{}',
                notBefore: AT, status: 'pending' },
            { ...scope, type: 'nudge_unfinished', dedupeKey: ACCOUNT, templateVersion: 'nudge-unfinished-v2', params: '{}',
                notBefore: '2026-11-20T09:00:00.000Z', status: 'pending' }]);
        expect(db.calls.every(call => /ON CONFLICT \(account_id, organisation_id, email_type, dedupe_key\) DO NOTHING/.test(call.sql))).toBe(true);
        // Only identifiers and timestamps leave the activation; never an address or name.
        expect(JSON.stringify(db.calls.map(call => call.args))).not.toMatch(/@|\s/);
    });

    test('a retried activation, even at a later instant, writes nothing more', async () => {
        const db = outboxDouble();
        await enqueueActivationEmails(db, { ...scope, activatedAt: AT }, ON);
        await enqueueActivationEmails(db, { ...scope, activatedAt: '2026-11-14T09:00:00.000Z' }, ON);
        expect(db.rows).toHaveLength(2);
        expect(db.rows.map(row => row.notBefore)).toEqual([AT, '2026-11-20T09:00:00.000Z']);
    });

    test('the submit cancel moves this nudge to cancelled and a later activation retry never requeues it', async () => {
        const db = outboxDouble();
        await enqueueActivationEmails(db, { ...scope, activatedAt: AT }, ON);
        // The exact cancel the submit path issues for the same starter scope.
        expect(await outbox.cancelPending(db, { ...scope, types: ['nudge_unfinished', 'reassess_reminder'] })).toBe(1);
        await enqueueActivationEmails(db, { ...scope, activatedAt: AT }, ON);
        expect(db.rows.map(row => [row.type, row.status])).toEqual([['welcome', 'pending'], ['nudge_unfinished', 'cancelled']]);
    });

    test('a failed write rejects, so the activation transaction rolls back', async () => {
        const failing = { calls: 0, async query() { this.calls++; throw new Error('synthetic write failure'); } };
        await expect(enqueueActivationEmails(failing, { ...scope, activatedAt: AT }, ON)).rejects.toThrow('synthetic write failure');
        expect(failing.calls).toBe(1);
        const unexpected = { query: async () => ({ rows: [], rowCount: 2 }) };
        await expect(enqueueActivationEmails(unexpected, { ...scope, activatedAt: AT }, ON)).rejects.toBeInstanceOf(outbox.OutboxWriteError);
    });

    test.each([
        ['missing instant', { ...scope }],
        ['invalid instant', { ...scope, activatedAt: 'not a time' }],
        ['non-uuid account', { ...scope, accountId: 'account-a', activatedAt: AT }],
        ['bad tenant', { ...scope, tenantId: 'tenant a', activatedAt: AT }]
    ])('%s fails closed before any SQL', async (_name, input) => {
        const db = outboxDouble();
        await expect(enqueueActivationEmails(db, input, ON)).rejects.toBeInstanceOf(outbox.OutboxWriteError);
        expect(db.calls).toEqual([]);
    });
});
