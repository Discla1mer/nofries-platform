'use strict';

// Native check of migration 0023: the email dispatcher reads exactly account_id
// and subject_key of starter accounts, across tenants, and nothing else. Runs on
// the disposable CI database only; synthetic rows are removed by the owner.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const MIGRATION = '0023_email_dispatcher_subject_lookup.sql';

module.exports = function registerEmailDispatcherSubjectLookupTests() {
(target ? describe : describe.skip)('email dispatcher subject lookup (migration 0023)', () => {
    const accounts = [0, 1].map(() => ({ accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}` }));
    let pool;

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 2, application_name: 'email-dispatcher-lookup' });
        for (const a of accounts) {
            await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
                VALUES ($1,$2,$3,'company')`, [a.accountId, crypto.randomBytes(32).toString('hex'), a.subjectKey]);
        }
    });
    afterAll(async () => {
        if (!pool) return;
        try {
            await pool.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id = ANY($1::uuid[])', [accounts.map(a => a.accountId)]);
        } finally { await pool.end(); }
    });

    async function dispatcher(sql, params = []) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE nofries_email_dispatcher');
            return await client.query(sql, params);
        } finally { await client.query('ROLLBACK'); client.release(); }
    }

    test('reads account_id and subject_key for every account, with no subject setting', async () => {
        const ids = accounts.map(a => a.accountId);
        const rows = (await dispatcher('SELECT account_id, subject_key FROM nofries.dashboard_starter_accounts WHERE account_id = ANY($1::uuid[]) ORDER BY account_id', [ids])).rows;
        expect(rows).toEqual(accounts.map(a => ({ account_id: a.accountId, subject_key: a.subjectKey }))
            .sort((x, y) => x.account_id.localeCompare(y.account_id)));
    });

    test('cannot read email_sha256 or any other column, nor write', async () => {
        for (const column of ['email_sha256', 'account_type', 'created_at', 'activated_at', '*']) {
            await expect(dispatcher(`SELECT ${column} FROM nofries.dashboard_starter_accounts LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
        }
        await expect(dispatcher('SELECT 1 FROM nofries.dashboard_starter_accounts WHERE email_sha256 IS NOT NULL')).rejects.toMatchObject({ code: '42501' });
        await expect(dispatcher("UPDATE nofries.dashboard_starter_accounts SET activated_at=clock_timestamp() WHERE account_id=$1", [accounts[0].accountId]))
            .rejects.toMatchObject({ code: '42501' });
        await expect(dispatcher('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id=$1', [accounts[0].accountId]))
            .rejects.toMatchObject({ code: '42501' });
        await expect(dispatcher(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
            VALUES ($1,$2,$3,'company')`, [crypto.randomUUID(), 'a'.repeat(64), `${crypto.randomUUID()}:${crypto.randomUUID()}`]))
            .rejects.toMatchObject({ code: '42501' });
    });

    test('still cannot read starter scopes or any assessment table', async () => {
        const tables = (await pool.query(`SELECT relname FROM pg_class WHERE relnamespace='nofries'::regnamespace AND relkind IN ('r','p')
            AND (relname LIKE 'dashboard_ncsc_assessment%' OR relname = 'dashboard_starter_scopes') ORDER BY relname`)).rows.map(r => r.relname);
        expect(tables.length).toBeGreaterThan(1);
        for (const table of tables) {
            await expect(dispatcher(`SELECT 1 FROM nofries.${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
        }
    });

    test('adds one SELECT policy for the dispatcher and leaves the runtime policy unchanged', async () => {
        const policies = (await pool.query(`SELECT policyname, permissive, roles::text[] AS roles, cmd, qual FROM pg_policies
            WHERE schemaname='nofries' AND tablename='dashboard_starter_accounts' ORDER BY policyname`)).rows;
        expect(policies).toEqual([
            { policyname: 'starter_accounts_email_dispatcher', permissive: 'PERMISSIVE', roles: ['nofries_email_dispatcher'], cmd: 'SELECT', qual: 'true' },
            { policyname: 'starter_accounts_subject', permissive: 'PERMISSIVE', roles: ['nofries_runtime'], cmd: 'ALL',
                qual: "(subject_key = NULLIF(current_setting('nofries.subject_key'::text, true), ''::text))" }]);
    });

    test('refuses to widen a role that drifted from the 0021 baseline', async () => {
        const sql = fs.readFileSync(path.join(__dirname, '../../database/migrations', MIGRATION), 'utf8');
        const undo = `DROP POLICY starter_accounts_email_dispatcher ON nofries.dashboard_starter_accounts;
            REVOKE SELECT (account_id, subject_key) ON nofries.dashboard_starter_accounts FROM nofries_email_dispatcher;`;
        const client = await pool.connect();
        try {
            for (const [drift, expected] of [['', null],
                ['GRANT SELECT (tenant_id) ON nofries.dashboard_starter_scopes TO nofries_email_dispatcher;', 'email_dispatcher_role_baseline_invalid'],
                ['GRANT nofries_email_dispatcher TO nofries_runtime;', 'email_dispatcher_role_baseline_invalid']]) {
                await client.query('BEGIN');
                try {
                    await client.query(undo + drift);
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
