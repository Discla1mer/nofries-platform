'use strict';

// Native check of migration 0024: a 'link' email preference is permanent in the
// database. Runtime (under the account's subject) cannot clear, re-time or
// relabel one; 'settings' rows still toggle; the unsubscribe upsert still
// passes; and a settings re-enable that races a link unsubscribe loses. Runs
// on the disposable CI database only; synthetic rows are removed by the owner.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { UPSERT_SQL } = require('../../api/shared/lifecycleEmail/unsubscribeEndpoint');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const MIGRATION = '0024_email_preferences_link_guard.sql';
const GUARD = { message: 'email_preference_link_permanent' };

module.exports = function registerEmailPreferencesLinkGuardTests() {
(target ? describe : describe.skip)('email preferences link guard (migration 0024)', () => {
    const account = { accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}` };
    let pool;
    const row = async emailType => (await pool.query(`SELECT source, unsubscribed_at FROM nofries.email_preferences
        WHERE account_id=$1 AND email_type=$2`, [account.accountId, emailType])).rows[0];
    const seed = (emailType, source, off = true) => pool.query(`INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
        VALUES ($1,$2,CASE WHEN $4 THEN clock_timestamp() END,$3)`, [account.accountId, emailType, source, off]);

    async function begin(client) {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE nofries_runtime');
        await client.query("SELECT set_config('nofries.subject_key', $1, true)", [account.subjectKey]);
    }
    async function runtime(sql, params = []) {
        const client = await pool.connect();
        try {
            await begin(client);
            const result = await client.query(sql, params);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 3, application_name: 'email-preferences-link-guard' });
        await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
            VALUES ($1,$2,$3,'company')`, [account.accountId, crypto.randomBytes(32).toString('hex'), account.subjectKey]);
    });
    afterEach(async () => {
        await pool.query('DELETE FROM nofries.email_preferences WHERE account_id=$1', [account.accountId]);
    });
    afterAll(async () => {
        if (!pool) return;
        try {
            await pool.query('DELETE FROM nofries.email_preferences WHERE account_id=$1', [account.accountId]);
            await pool.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id=$1', [account.accountId]);
        } finally { await pool.end(); }
    });

    test('runtime cannot clear, re-time or relabel a link row, nor insert one without a time', async () => {
        await seed('welcome', 'link');
        const before = await row('welcome');
        for (const set of ['unsubscribed_at=NULL', "source='settings'", "unsubscribed_at=NULL, source='settings'",
            'unsubscribed_at=clock_timestamp()']) {
            await expect(runtime(`UPDATE nofries.email_preferences SET ${set} WHERE account_id=$1 AND email_type='welcome'`,
                [account.accountId])).rejects.toMatchObject(GUARD);
        }
        await expect(runtime(`INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
            VALUES ($1,'result_summary',NULL,'link')`, [account.accountId])).rejects.toMatchObject(GUARD);
        expect(await row('welcome')).toEqual(before);
        expect(await row('result_summary')).toBeUndefined();
        // The owner is bound too; an unchanged update still passes.
        await expect(pool.query("UPDATE nofries.email_preferences SET source='settings' WHERE account_id=$1", [account.accountId]))
            .rejects.toMatchObject(GUARD);
        await runtime("UPDATE nofries.email_preferences SET source='link' WHERE account_id=$1 AND email_type='welcome'", [account.accountId]);
        expect(await row('welcome')).toEqual(before);
    });

    test('settings rows still toggle, and the unsubscribe upsert still turns one into a permanent link row', async () => {
        await runtime(`INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
            VALUES ($1,'nudge_unfinished',clock_timestamp(),'settings')`, [account.accountId]);
        for (const value of ['NULL', 'clock_timestamp()', 'NULL']) {
            await runtime(`UPDATE nofries.email_preferences SET unsubscribed_at=${value} WHERE account_id=$1 AND email_type='nudge_unfinished'`,
                [account.accountId]);
        }
        expect(await row('nudge_unfinished')).toEqual({ source: 'settings', unsubscribed_at: null });
        await runtime(UPSERT_SQL, [account.accountId, 'nudge_unfinished']);
        const linked = await row('nudge_unfinished');
        expect(linked).toEqual({ source: 'link', unsubscribed_at: expect.any(Date) });
        await runtime(UPSERT_SQL, [account.accountId, 'nudge_unfinished']);
        await runtime(UPSERT_SQL, [account.accountId, 'reassess_reminder']);
        expect(await row('nudge_unfinished')).toEqual(linked);
        expect(await row('reassess_reminder')).toEqual({ source: 'link', unsubscribed_at: expect.any(Date) });
    });

    test('the unsubscribe upsert keeps the time of a settings row that is already off', async () => {
        await seed('reassess_reminder', 'settings');
        const before = await row('reassess_reminder');
        await runtime(UPSERT_SQL, [account.accountId, 'reassess_reminder']);
        await runtime(UPSERT_SQL, [account.accountId, 'reassess_reminder']);
        // Main's upsert leaves an earlier settings unsubscribe as it is; the E7
        // upsert (COALESCE) relabels it 'link' with its original time. Both pass the guard.
        const source = /COALESCE\(email_preferences\.unsubscribed_at/.test(UPSERT_SQL) ? 'link' : 'settings';
        expect(await row('reassess_reminder')).toEqual({ source, unsubscribed_at: before.unsubscribed_at });
    });

    test('a settings re-enable waiting on an open link unsubscribe fails once the link commits', async () => {
        await seed('result_summary', 'settings', false);
        const link = await pool.connect();
        const settings = await pool.connect();
        try {
            await begin(link);
            await link.query(UPSERT_SQL, [account.accountId, 'result_summary']);
            await begin(settings);
            const pid = (await settings.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const reenable = settings.query(`UPDATE nofries.email_preferences SET unsubscribed_at=NULL, source='settings'
                WHERE account_id=$1 AND email_type='result_summary'`, [account.accountId]).then(() => null, error => error);
            for (let i = 0; ; i += 1) {
                const waiting = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
                if (waiting && waiting.wait_event_type === 'Lock') break;
                if (i > 200) throw new Error('settings_update_never_waited');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            await link.query('COMMIT');
            expect(await reenable).toMatchObject(GUARD);
            await settings.query('ROLLBACK');
        } finally {
            for (const client of [link, settings]) {
                await client.query('ROLLBACK').catch(() => {});
                client.release();
            }
        }
        expect(await row('result_summary')).toEqual({ source: 'link', unsubscribed_at: expect.any(Date) });
    });

    test('installs one invoker guard with a fixed search path and no EXECUTE grant', async () => {
        const fn = (await pool.query(`SELECT p.prosecdef, p.proconfig,
                has_function_privilege('nofries_runtime', p.oid, 'EXECUTE') AS runtime_execute,
                has_function_privilege('nofries_email_dispatcher', p.oid, 'EXECUTE') AS dispatcher_execute
            FROM pg_proc p WHERE p.oid = 'nofries.guard_email_preference()'::regprocedure`)).rows[0];
        expect(fn).toEqual({ prosecdef: false, proconfig: ['search_path=pg_catalog, nofries'],
            runtime_execute: false, dispatcher_execute: false });
        const triggers = (await pool.query(`SELECT tgname, tgenabled FROM pg_trigger
            WHERE tgrelid = 'nofries.email_preferences'::regclass AND NOT tgisinternal`)).rows;
        expect(triggers).toEqual([{ tgname: 'email_preferences_link_guard', tgenabled: 'O' }]);
    });

    test('refuses to install over a link row without a time, an existing guard, or a runtime that may skip triggers', async () => {
        const sql = fs.readFileSync(path.join(__dirname, '../../database/migrations', MIGRATION), 'utf8');
        const undo = `DROP TRIGGER email_preferences_link_guard ON nofries.email_preferences;
            DROP FUNCTION nofries.guard_email_preference();`;
        const client = await pool.connect();
        try {
            for (const [setup, expected] of [[undo, null], ['', 'email_preferences_link_guard_precondition'],
                [`${undo} GRANT SET ON PARAMETER session_replication_role TO nofries_runtime;`, 'email_preferences_link_guard_precondition'],
                [`${undo} INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
                    VALUES ('${account.accountId}','welcome',NULL,'link');`, 'email_preferences_link_rows_invalid']]) {
                await client.query('BEGIN');
                try {
                    await client.query(setup);
                    if (expected) await expect(client.query(sql)).rejects.toMatchObject({ message: expected });
                    else await client.query(sql);
                } finally { await client.query('ROLLBACK'); }
            }
        } finally { client.release(); }
    });

    test('migrating twice is clean', async () => {
        const client = await pool.connect();
        try {
            const result = await applyMigrations({ client });
            expect(result.applied).toEqual([]);
            expect(result.skipped).toContain(MIGRATION);
        } finally { client.release(); }
    });
});
};
