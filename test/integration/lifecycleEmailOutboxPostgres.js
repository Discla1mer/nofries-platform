'use strict';

// Native check of migration 0021 (lifecycle email outbox and preferences) as the
// restricted runtime and dispatcher roles, on the disposable CI database only.
// Synthetic rows use per-run identifiers and are removed by the owner afterwards.
const crypto = require('node:crypto');
const { applyMigrations } = require('../../scripts/db-migrate');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const MIGRATION = '0021_lifecycle_email_outbox.sql';
const ENQUEUE = `INSERT INTO nofries.email_outbox
    (outbox_id, tenant_id, organisation_id, account_id, email_type, dedupe_key, template_version, params)
    VALUES ($1,$2,$3,$4,$5,$6,'welcome-v1',$7::jsonb)
    ON CONFLICT (account_id, organisation_id, email_type, dedupe_key) DO NOTHING`;

module.exports = function registerLifecycleEmailOutboxTests() {
(target ? describe : describe.skip)('lifecycle email outbox and preferences (migration 0021)', () => {
    const run = crypto.randomBytes(6).toString('hex');
    const party = () => ({ tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID(),
        accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}` });
    const a = party(), b = party();
    let pool;

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 3, application_name: `email-outbox-${run}` });
        for (const p of [a, b]) {
            await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
                VALUES ($1,$2,$3,'company')`, [p.accountId, crypto.randomBytes(32).toString('hex'), p.subjectKey]);
            const preparation = { planId: 'nf-starter-2026-09-r1', kind: 'own', subjectKey: p.subjectKey, accountType: 'company',
                scope: { tenantId: p.tenantId, organisationId: p.organisationId } };
            await pool.query(`INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,
                ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,'company',$4,0,$5,$6,$7::jsonb)`,
            [p.tenantId, p.organisationId, p.accountId, p.subjectKey, crypto.randomUUID(), crypto.randomUUID(), JSON.stringify(preparation)]);
        }
    });
    afterAll(async () => {
        if (!pool) return;
        try {
            const ids = [a.accountId, b.accountId];
            await pool.query('DELETE FROM nofries.email_outbox WHERE account_id = ANY($1::uuid[])', [ids]);
            await pool.query('DELETE FROM nofries.email_preferences WHERE account_id = ANY($1::uuid[])', [ids]);
            await pool.query('DELETE FROM nofries.dashboard_starter_scopes WHERE account_id = ANY($1::uuid[])', [ids]);
            await pool.query('DELETE FROM nofries.dashboard_starter_accounts WHERE account_id = ANY($1::uuid[])', [ids]);
        } finally { await pool.end(); }
    });

    // Run work in one transaction as a restricted role; commit unless it throws.
    async function as(role, p, work, client) {
        const own = !client;
        if (own) client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('nofries.tenant_id',$1,true), set_config('nofries.organisation_id',$2,true),
                set_config('nofries.subject_key',$3,true)`, p ? [p.tenantId, p.organisationId, p.subjectKey] : ['', '', '']);
            await client.query(`SET LOCAL ROLE ${role}`);
            const result = await work(client);
            if (own) await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK'); throw error;
        } finally { if (own) client.release(); }
    }
    const runtime = (p, work) => as('nofries_runtime', p, work);
    const dispatcher = (work, client) => as('nofries_email_dispatcher', null, work, client);
    const enqueue = (p, key, params = {}, id = crypto.randomUUID()) => runtime(p, c =>
        c.query(ENQUEUE, [id, p.tenantId, p.organisationId, p.accountId, 'welcome', key, JSON.stringify(params)]));
    const statusOf = async id => (await pool.query('SELECT status FROM nofries.email_outbox WHERE outbox_id=$1', [id])).rows[0]?.status;

    test('forces RLS, stores no recipient content and grants no DELETE', async () => {
        const tables = (await pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
            WHERE relnamespace='nofries'::regnamespace AND relname IN ('email_outbox','email_preferences') ORDER BY relname`)).rows;
        expect(tables).toEqual([
            { relname: 'email_outbox', relrowsecurity: true, relforcerowsecurity: true },
            { relname: 'email_preferences', relrowsecurity: true, relforcerowsecurity: true }]);
        const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
            WHERE table_schema='nofries' AND table_name='email_outbox' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
        expect(columns).toEqual(['outbox_id', 'tenant_id', 'organisation_id', 'account_id', 'email_type', 'dedupe_key',
            'template_version', 'params', 'status', 'attempts', 'not_before', 'locked_until', 'created_at', 'sent_at',
            'last_error_code', 'provider_message_id']);
        const role = (await pool.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole
            FROM pg_roles WHERE rolname='nofries_email_dispatcher'`)).rows;
        expect(role).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false }]);
        for (const grantee of ['nofries_runtime', 'nofries_email_dispatcher']) {
            for (const table of ['nofries.email_outbox', 'nofries.email_preferences']) {
                const r = (await pool.query("SELECT has_table_privilege($1,$2,'DELETE') AS d, has_table_privilege($1,$2,'TRUNCATE') AS t",
                    [grantee, table])).rows[0];
                expect(r).toEqual({ d: false, t: false });
            }
        }
    });

    test('a duplicate enqueue with ON CONFLICT DO NOTHING is a no-op', async () => {
        const first = crypto.randomUUID();
        expect((await enqueue(a, 'dup-key', { assessmentId: 'assessment-1' }, first)).rowCount).toBe(1);
        expect((await enqueue(a, 'dup-key', { assessmentId: 'assessment-1' })).rowCount).toBe(0);
        const rows = (await pool.query("SELECT outbox_id FROM nofries.email_outbox WHERE account_id=$1 AND dedupe_key='dup-key'", [a.accountId])).rows;
        expect(rows).toEqual([{ outbox_id: first }]);
    });

    test('tenant A cannot see or cancel tenant B rows, but can cancel its own', async () => {
        const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
        await enqueue(a, 'iso-key', {}, mine);
        await enqueue(b, 'iso-key', {}, theirs);
        expect((await runtime(a, c => c.query('SELECT outbox_id FROM nofries.email_outbox WHERE outbox_id=$1', [theirs]))).rows).toEqual([]);
        expect((await runtime(a, c => c.query("UPDATE nofries.email_outbox SET status='cancelled' WHERE outbox_id=$1", [theirs]))).rowCount).toBe(0);
        expect(await statusOf(theirs)).toBe('pending');
        await expect(runtime(a, c => c.query(ENQUEUE, [crypto.randomUUID(), b.tenantId, b.organisationId, b.accountId, 'welcome', 'forged', '{}'])))
            .rejects.toMatchObject({ code: '42501' });
        expect((await runtime(a, c => c.query("UPDATE nofries.email_outbox SET status='cancelled' WHERE outbox_id=$1", [mine]))).rowCount).toBe(1);
        expect(await statusOf(mine)).toBe('cancelled');
        // cancelled is terminal for runtime
        expect((await runtime(a, c => c.query("UPDATE nofries.email_outbox SET status='cancelled' WHERE outbox_id=$1", [mine]))).rowCount).toBe(0);
    });

    test('runtime cannot enqueue for an account outside its own subject, tenant and organisation scope', async () => {
        const forged = (p, account, org = p.organisationId) => runtime(p, c => c.query(ENQUEUE,
            [crypto.randomUUID(), p.tenantId, org, account, 'welcome', `mixed-${crypto.randomUUID()}`, '{}']));
        await expect(forged(a, b.accountId)).rejects.toMatchObject({ code: '42501' });
        await expect(forged({ ...a, subjectKey: b.subjectKey }, a.accountId)).rejects.toMatchObject({ code: '42501' });
        await expect(forged({ ...a, organisationId: b.organisationId }, a.accountId)).rejects.toMatchObject({ code: '42501' });
        await expect(forged(a, a.accountId, b.organisationId)).rejects.toMatchObject({ code: '42501' });
        expect((await pool.query('SELECT count(*)::int AS n FROM nofries.email_outbox WHERE account_id=$1 AND dedupe_key LIKE $2',
            [b.accountId, 'mixed-%'])).rows[0].n).toBe(0);
    });

    test('runtime cannot set sent or any delivery column, nor enqueue a non-pending row', async () => {
        const id = crypto.randomUUID();
        await enqueue(a, 'sent-key', {}, id);
        await expect(runtime(a, c => c.query("UPDATE nofries.email_outbox SET status='sent', sent_at=clock_timestamp() WHERE outbox_id=$1", [id])))
            .rejects.toMatchObject({ code: '42501' });
        await expect(runtime(a, c => c.query("UPDATE nofries.email_outbox SET status='sent' WHERE outbox_id=$1", [id])))
            .rejects.toMatchObject({ code: '42501' });
        await expect(runtime(a, c => c.query('UPDATE nofries.email_outbox SET attempts=1 WHERE outbox_id=$1', [id])))
            .rejects.toMatchObject({ code: '42501' });
        await expect(runtime(a, c => c.query(`INSERT INTO nofries.email_outbox
            (outbox_id,tenant_id,organisation_id,account_id,email_type,dedupe_key,template_version,status,sent_at)
            VALUES ($1,$2,$3,$4,'welcome','sent-direct','welcome-v1','sent',clock_timestamp())`,
            [crypto.randomUUID(), a.tenantId, a.organisationId, a.accountId]))).rejects.toMatchObject({ code: '42501' });
        await expect(runtime(a, c => c.query('DELETE FROM nofries.email_outbox WHERE outbox_id=$1', [id])))
            .rejects.toMatchObject({ code: '42501' });
        expect(await statusOf(id)).toBe('pending');
    });

    test('the params CHECK rejects extra keys, wrong types and oversize objects', async () => {
        for (const params of [{ assessmentId: 'x', email: 'someone@example.invalid' }, { name: 'x' }, { gapCount: '3' },
            { assessmentId: 'x'.repeat(600) }, []]) {
            await expect(enqueue(a, `bad-${crypto.randomUUID()}`, params)).rejects.toMatchObject({ code: '23514' });
        }
        expect((await enqueue(a, 'good-params', { assessmentId: 'assessment-2', gapCount: 4 })).rowCount).toBe(1);
    });

    test('the dispatcher cannot read any assessment table or other schema data', async () => {
        const tables = (await pool.query(`SELECT relname FROM pg_class WHERE relnamespace='nofries'::regnamespace
            AND relkind IN ('r','p','v','m') AND relname NOT IN ('email_outbox','email_preferences') ORDER BY relname`)).rows.map(r => r.relname);
        expect(tables.filter(t => t.startsWith('dashboard_ncsc_assessment')).length).toBeGreaterThan(0);
        for (const table of tables) {
            const r = (await pool.query("SELECT has_table_privilege('nofries_email_dispatcher',$1,'SELECT') AS s, has_any_column_privilege('nofries_email_dispatcher',$1,'SELECT') AS c",
                ['nofries.' + table])).rows[0];
            expect({ table, ...r }).toEqual({ table, s: false, c: false });
        }
        for (const table of tables.filter(t => t.startsWith('dashboard_ncsc_assessment'))) {
            await expect(dispatcher(c => c.query(`SELECT 1 FROM nofries.${table} LIMIT 1`))).rejects.toMatchObject({ code: '42501' });
        }
        const members = (await pool.query(`SELECT count(*)::int AS n FROM pg_auth_members
            WHERE member='nofries_email_dispatcher'::regrole OR (roleid='nofries_email_dispatcher'::regrole AND (set_option OR inherit_option))`)).rows[0];
        expect(members.n).toBe(0);
    });

    test('two concurrent FOR UPDATE SKIP LOCKED claimers get disjoint rows', async () => {
        for (let i = 0; i < 6; i += 1) await enqueue(b, `claim-${i}`);
        const claim = `SELECT outbox_id FROM nofries.email_outbox WHERE status='pending' AND tenant_id=$1
            ORDER BY not_before, outbox_id LIMIT 3 FOR UPDATE SKIP LOCKED`;
        const one = await pool.connect(), two = await pool.connect();
        try {
            let first, second;
            await dispatcher(async c => {
                first = (await c.query(claim, [b.tenantId])).rows.map(r => r.outbox_id);
                await dispatcher(async d => { second = (await d.query(claim, [b.tenantId])).rows.map(r => r.outbox_id); }, two);
                await two.query('COMMIT');
                await c.query(`UPDATE nofries.email_outbox SET status='sending', attempts=attempts+1,
                    locked_until=clock_timestamp()+interval '5 minutes' WHERE outbox_id = ANY($1::uuid[])`, [first]);
            }, one);
            await one.query('COMMIT');
            expect(first).toHaveLength(3); expect(second).toHaveLength(3);
            expect(first.filter(id => second.includes(id))).toEqual([]);
            const states = (await pool.query('SELECT status, attempts FROM nofries.email_outbox WHERE outbox_id = ANY($1::uuid[])', [first])).rows;
            expect(states).toEqual(Array(3).fill({ status: 'sending', attempts: 1 }));
        } finally { one.release(); two.release(); }
    });

    test('preferences are scoped to the signed-in subject; the dispatcher reads all', async () => {
        await runtime(a, c => c.query("INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source) VALUES ($1,'nudge_unfinished',clock_timestamp(),'settings')", [a.accountId]));
        await expect(runtime(a, c => c.query("INSERT INTO nofries.email_preferences (account_id,email_type,source) VALUES ($1,'welcome','settings')", [b.accountId])))
            .rejects.toMatchObject({ code: '42501' });
        expect((await runtime(b, c => c.query('SELECT 1 FROM nofries.email_preferences WHERE account_id=$1', [a.accountId]))).rows).toEqual([]);
        expect((await runtime(b, c => c.query("UPDATE nofries.email_preferences SET unsubscribed_at=NULL WHERE account_id=$1", [a.accountId]))).rowCount).toBe(0);
        await dispatcher(c => c.query("INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source) VALUES ($1,'welcome',clock_timestamp(),'link')", [b.accountId]));
        const seen = (await dispatcher(c => c.query('SELECT account_id FROM nofries.email_preferences WHERE account_id = ANY($1::uuid[]) ORDER BY email_type', [[a.accountId, b.accountId]]))).rows;
        expect(seen.map(r => r.account_id).sort()).toEqual([a.accountId, b.accountId].sort());
    });

    test('migrating twice is clean', async () => {
        const client = await pool.connect();
        try {
            const result = await applyMigrations({ client });
            expect(result.applied).toEqual([]);
            expect(result.skipped).toContain(MIGRATION);
        } finally { client.release(); }
        const ledger = (await pool.query('SELECT checksum_sha256 FROM nofries.schema_migrations WHERE migration_id=$1', [MIGRATION])).rows;
        expect(ledger).toEqual([{ checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    });
});
};
