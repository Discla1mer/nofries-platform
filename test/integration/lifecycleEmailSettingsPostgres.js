'use strict';

// Native check of signed-in email settings (#151 E7): runtime may turn a type
// off and back on only for its own subject's activated account, a link
// unsubscribe stays off, and another subject can neither read nor change rows.
const crypto = require('node:crypto');
const { createEmailSettingsStore } = require('../../api/shared/lifecycleEmail/emailSettingsStore');
const { createUnsubscribeWriter } = require('../../api/shared/lifecycleEmail/unsubscribeEndpoint');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();

module.exports = function registerLifecycleEmailSettingsTests() {
(target ? describe : describe.skip)('lifecycle email signed-in settings (native)', () => {
    const accounts = [0, 1, 2].map(() => ({ accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}` }));
    let pool, store, record;
    const row = async (accountId, type) => (await pool.query(`SELECT source, unsubscribed_at FROM nofries.email_preferences
        WHERE account_id=$1 AND email_type=$2`, [accountId, type])).rows[0];
    async function asRuntime(subjectKey, sql, params) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE nofries_runtime');
            await client.query("SELECT set_config('nofries.subject_key', $1, true)", [subjectKey]);
            return await client.query(sql, params);
        } finally { await client.query('ROLLBACK'); client.release(); }
    }

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 2, application_name: 'email-settings-native' });
        store = createEmailSettingsStore({ pool });
        record = createUnsubscribeWriter({ pool });
        for (const [index, a] of accounts.entries()) {
            await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type,created_at,activated_at)
                VALUES ($1,$2,$3,'company',clock_timestamp() - interval '1 hour',CASE WHEN $4 THEN clock_timestamp() END)`,
            [a.accountId, crypto.randomBytes(32).toString('hex'), a.subjectKey, index < 2]);
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

    test('turns a type off without moving its time, then back on, under the subject', async () => {
        const [own] = accounts;
        expect(await store.read(own.subjectKey)).toEqual([]);
        expect(await store.change(own.subjectKey, 'result_summary', 'off')).toBe('changed');
        const first = await row(own.accountId, 'result_summary');
        expect(first).toEqual({ source: 'settings', unsubscribed_at: expect.any(Date) });
        expect(await store.change(own.subjectKey, 'result_summary', 'off')).toBe('unchanged');
        expect(await row(own.accountId, 'result_summary')).toEqual(first);
        expect(await store.change(own.subjectKey, 'result_summary', 'on')).toBe('changed');
        expect(await row(own.accountId, 'result_summary')).toEqual({ source: 'settings', unsubscribed_at: null });
        expect(await store.read(own.subjectKey)).toEqual([{ type: 'result_summary', off: false, source: 'settings' }]);
        expect(await store.change(own.subjectKey, 'result_summary', 'on')).toBe('unchanged');
    });

    test('a link unsubscribe stays off, including one made after a settings unsubscribe', async () => {
        const [own] = accounts;
        await record({ ...own, emailType: 'nudge_unfinished' });
        expect(await store.change(own.subjectKey, 'nudge_unfinished', 'on')).toBe('link_locked');
        expect((await row(own.accountId, 'nudge_unfinished')).unsubscribed_at).toEqual(expect.any(Date));
        await store.change(own.subjectKey, 'reassess_reminder', 'off');
        const before = await row(own.accountId, 'reassess_reminder');
        await record({ ...own, emailType: 'reassess_reminder' });
        expect(await row(own.accountId, 'reassess_reminder')).toEqual({ source: 'link', unsubscribed_at: before.unsubscribed_at });
        expect(await store.change(own.subjectKey, 'reassess_reminder', 'on')).toBe('link_locked');
        expect(await store.change(own.subjectKey, 'reassess_reminder', 'off')).toBe('unchanged');
        expect(await row(own.accountId, 'reassess_reminder')).toEqual({ source: 'link', unsubscribed_at: before.unsubscribed_at });
    });

    test('another subject cannot read or change these rows, and an unactivated account has no settings', async () => {
        const [own, other, pending] = accounts;
        expect((await asRuntime(other.subjectKey, 'SELECT * FROM nofries.email_preferences WHERE account_id=$1', [own.accountId])).rows).toEqual([]);
        expect((await asRuntime(other.subjectKey, `UPDATE nofries.email_preferences SET unsubscribed_at = NULL, source = 'settings'
            WHERE account_id=$1`, [own.accountId])).rowCount).toBe(0);
        await expect(asRuntime(other.subjectKey, `INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
            VALUES ($1,'welcome',clock_timestamp(),'settings')`, [own.accountId])).rejects.toMatchObject({ code: '42501' });
        await expect(asRuntime(own.subjectKey, 'DELETE FROM nofries.email_preferences WHERE account_id=$1', [own.accountId]))
            .rejects.toMatchObject({ code: '42501' });
        expect((await row(own.accountId, 'nudge_unfinished')).source).toBe('link');
        expect(await store.read(other.subjectKey)).toEqual([]);
        expect(await store.read(pending.subjectKey)).toBeNull();
        expect(await store.change(pending.subjectKey, 'result_summary', 'off')).toBeNull();
        expect(await row(pending.accountId, 'result_summary')).toBeUndefined();
    });
});
};
