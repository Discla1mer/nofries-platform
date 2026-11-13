'use strict';

// Native check of the link-unsubscribe write (#151 E6): it runs as
// nofries_runtime under the account's subject key, is idempotent, never moves an
// earlier unsubscribe, and cannot write for another subject's account.
const crypto = require('node:crypto');
const { createUnsubscribeWriter } = require('../../api/shared/lifecycleEmail/unsubscribeEndpoint');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();

module.exports = function registerLifecycleEmailUnsubscribeTests() {
(target ? describe : describe.skip)('lifecycle email link unsubscribe (native)', () => {
    const accounts = [0, 1].map(() => ({ accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}` }));
    let pool, record;
    const prefs = async accountId => (await pool.query(`SELECT email_type, source, unsubscribed_at FROM nofries.email_preferences
        WHERE account_id=$1 ORDER BY email_type`, [accountId])).rows;

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 2, application_name: 'email-unsubscribe-native' });
        record = createUnsubscribeWriter({ pool });
        for (const a of accounts) {
            await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
                VALUES ($1,$2,$3,'company')`, [a.accountId, crypto.randomBytes(32).toString('hex'), a.subjectKey]);
        }
    });
    afterAll(async () => {
        if (!pool) return;
        try {
            const ids = accounts.map(a => a.accountId);
            await pool.query('DELETE FROM nofries.email_preferences WHERE account_id = ANY($1::uuid[])', [ids]);
            await pool.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id = ANY($1::uuid[])', [ids]);
        } finally { await pool.end(); }
    });

    test('records an unsubscribe under the subject, idempotently and without moving the first time', async () => {
        const [own] = accounts;
        await record({ ...own, emailType: 'nudge_unfinished' });
        const first = await prefs(own.accountId);
        expect(first).toEqual([{ email_type: 'nudge_unfinished', source: 'link', unsubscribed_at: expect.any(Date) }]);
        await record({ ...own, emailType: 'nudge_unfinished' });
        expect(await prefs(own.accountId)).toEqual(first);
    });

    test('re-records a settings resubscribe as a link unsubscribe', async () => {
        const [own] = accounts;
        await pool.query(`INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
            VALUES ($1,'reassess_reminder',NULL,'settings')`, [own.accountId]);
        await record({ ...own, emailType: 'reassess_reminder' });
        expect((await prefs(own.accountId)).find(row => row.email_type === 'reassess_reminder'))
            .toEqual({ email_type: 'reassess_reminder', source: 'link', unsubscribed_at: expect.any(Date) });
    });

    test('cannot write for another subject or without a subject', async () => {
        const [own, other] = accounts;
        await expect(record({ accountId: other.accountId, subjectKey: own.subjectKey, emailType: 'welcome' })).rejects.toMatchObject({ code: '42501' });
        await expect(record({ accountId: own.accountId, subjectKey: '', emailType: 'welcome' })).rejects.toMatchObject({ code: '42501' });
        expect(await prefs(other.accountId)).toEqual([]);
        expect((await prefs(own.accountId)).map(row => row.email_type)).not.toContain('welcome');
    });
});
};
