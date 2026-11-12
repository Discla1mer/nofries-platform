'use strict';

// Explicit local-only proof for 0022. Each run creates and drops its own
// synthetic database and restricted role; no application database is selected.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../scripts/db-migrate');

const MIGRATION = '0022_funnel_daily_counts.sql';
const EVENTS = ['visit', 'signup_started', 'code_confirmed', 'first_answer', 'submitted', 'result_viewed', 'enquiry_sent'];
const UPSERT = `INSERT INTO nofries.funnel_daily_counts (day, event, count) VALUES ($1, $2, 1)
    ON CONFLICT (day, event) DO UPDATE SET count = funnel_daily_counts.count + 1`;
const quoteIdentifier = value => `"${String(value).replace(/"/g, '""')}"`;
const quoteLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
function urlFor(value, overrides = {}) {
    const parsed = new URL(value);
    if (overrides.database) parsed.pathname = `/${overrides.database}`;
    if (overrides.username) parsed.username = overrides.username;
    if (overrides.password) parsed.password = overrides.password;
    return parsed.toString();
}
function localTestUrl(env = process.env) {
    const value = String(env.NOFRIES_TEST_DATABASE_URL || '').trim();
    if (!value) return null;
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.search || parsed.hash) {
        throw new Error('Funnel count proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();

test('0022 stores aggregate counts only, with no identifying or tenant columns', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../database/migrations', MIGRATION), 'utf8');
    const table = sql.slice(sql.indexOf('CREATE TABLE nofries.funnel_daily_counts'), sql.indexOf(');', sql.indexOf('CREATE TABLE')));
    expect(table).not.toMatch(/tenant|account|organisation|subject|\bip\b|address|user_agent|referr|cookie|session/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b[^;]*TO nofries_runtime/i);
    expect(sql).not.toMatch(/FOR (ALL|DELETE) TO nofries_runtime/i);
});

test('native discovery accepts only explicit loopback test URLs', () => {
    const ci = 'postgresql://synthetic@127.0.0.1:5432/test';
    expect(localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci })).toBe(ci);
    expect(localTestUrl({ NOFRIES_DATABASE_URL: ci })).toBeNull();
    for (const value of ['postgresql://synthetic@database.invalid/test', 'https://localhost/test', `${ci}?host=database.invalid`, `${ci}#x`]) {
        expect(() => localTestUrl({ NOFRIES_TEST_DATABASE_URL: value })).toThrow(/loopback-only/);
    }
});

(testUrl ? describe : describe.skip)('funnel daily counts with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `funnel_counts_${run}`, role = `funnel_runtime_${run}`, password = `synthetic-local-funnel-${run}`;
    let controlPool, ownerPool, runtimePool, databaseCreated = false, roleCreated = false;
    const capture = promise => promise.then(value => ({ value }), error => ({ error }));
    const countFor = async (day, event) => (await ownerPool.query(
        'SELECT count FROM nofries.funnel_daily_counts WHERE day=$1 AND event=$2', [day, event])).rows.map(row => Number(row.count));

    beforeAll(async () => {
        const { Pool } = require('pg');
        controlPool = new Pool({ connectionString: testUrl, max: 2 });
        await controlPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); databaseCreated = true;
        ownerPool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName }), max: 4 });
        await applyMigrations({ pool: ownerPool });
        await controlPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
        roleCreated = true;
        await controlPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(role)}`);
        runtimePool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName, username: role, password }),
            max: 10, statement_timeout: 15000 });
    }, 30000);
    afterAll(async () => {
        if (runtimePool) await runtimePool.end();
        if (ownerPool) await ownerPool.end();
        if (controlPool) {
            try {
                if (databaseCreated) await controlPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
                if (roleCreated) await controlPool.query(`DROP ROLE ${quoteIdentifier(role)}`);
            } finally { await controlPool.end(); }
        }
    });

    test('table forces RLS, has only aggregate columns, and runtime has no DELETE or TRUNCATE', async () => {
        const rel = (await ownerPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='nofries.funnel_daily_counts'::regclass")).rows[0];
        expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const columns = (await ownerPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='nofries' AND table_name='funnel_daily_counts' ORDER BY ordinal_position")).rows;
        expect(columns.map(row => row.column_name)).toEqual(['day', 'event', 'count']);
        const privileges = (await runtimePool.query("SELECT has_table_privilege(current_user,'nofries.funnel_daily_counts','SELECT') AS read,has_table_privilege(current_user,'nofries.funnel_daily_counts','INSERT') AS insert,has_table_privilege(current_user,'nofries.funnel_daily_counts','UPDATE') AS update,has_column_privilege(current_user,'nofries.funnel_daily_counts','count','UPDATE') AS update_count,has_column_privilege(current_user,'nofries.funnel_daily_counts','day','UPDATE') AS update_day,has_table_privilege(current_user,'nofries.funnel_daily_counts','DELETE') AS delete,has_table_privilege(current_user,'nofries.funnel_daily_counts','TRUNCATE') AS truncate")).rows[0];
        expect(privileges).toEqual({ read: true, insert: true, update: false, update_count: true, update_day: false, delete: false, truncate: false });
    });

    test('every listed event is accepted and an unknown event is rejected', async () => {
        for (const event of EVENTS) await runtimePool.query(UPSERT, ['2026-11-01', event]);
        expect((await ownerPool.query("SELECT count(*)::integer AS n FROM nofries.funnel_daily_counts WHERE day='2026-11-01'")).rows[0].n).toBe(EVENTS.length);
        for (const event of ['page_view', 'Visit', '', 'visit ']) {
            const result = await capture(runtimePool.query(UPSERT, ['2026-11-01', event]));
            expect(result.error).toMatchObject({ code: '23514' });
        }
        expect((await capture(runtimePool.query(UPSERT, ['2026-11-01', null]))).error).toMatchObject({ code: '23502' });
    });

    test('concurrent runtime upserts sum exactly', async () => {
        const total = 200;
        await Promise.all(Array.from({ length: total }, () => runtimePool.query(UPSERT, ['2026-11-02', 'submitted'])));
        expect(await countFor('2026-11-02', 'submitted')).toEqual([total]);
        expect(await countFor('2026-11-02', 'visit')).toEqual([]);
    });

    test('runtime cannot DELETE, TRUNCATE or rekey rows', async () => {
        await runtimePool.query(UPSERT, ['2026-11-03', 'visit']);
        for (const sql of ['DELETE FROM nofries.funnel_daily_counts', 'TRUNCATE nofries.funnel_daily_counts',
            "UPDATE nofries.funnel_daily_counts SET day='2026-11-04' WHERE day='2026-11-03'",
            "UPDATE nofries.funnel_daily_counts SET event='submitted' WHERE day='2026-11-03'"]) {
            expect((await capture(runtimePool.query(sql))).error).toMatchObject({ code: '42501' });
        }
        expect(await countFor('2026-11-03', 'visit')).toEqual([1]);
    });

    test('the count CHECK holds at both bounds', async () => {
        for (const value of [-1, 10000001]) {
            const result = await capture(runtimePool.query('INSERT INTO nofries.funnel_daily_counts (day,event,count) VALUES ($1,$2,$3)', ['2026-11-05', 'visit', value]));
            expect(result.error).toMatchObject({ code: '23514' });
        }
        await runtimePool.query('INSERT INTO nofries.funnel_daily_counts (day,event,count) VALUES ($1,$2,$3)', ['2026-11-05', 'visit', 10000000]);
        expect((await capture(runtimePool.query(UPSERT, ['2026-11-05', 'visit'])))
            .error).toMatchObject({ code: '23514' });
        await runtimePool.query('INSERT INTO nofries.funnel_daily_counts (day,event) VALUES ($1,$2)', ['2026-11-05', 'first_answer']);
        expect(await countFor('2026-11-05', 'first_answer')).toEqual([0]);
        expect(await countFor('2026-11-05', 'visit')).toEqual([10000000]);
    });

    test('two endpoint posts through the runtime writer sum to 2 for the NZ day', async () => {
        const { createFunnelCountWriter, handleFunnelCountRequest } = require('../api/shared/funnelCounts');
        const record = createFunnelCountWriter({ pool: runtimePool });
        const now = () => new Date('2026-11-06T11:30:00Z');
        for (let i = 0; i < 2; i += 1) {
            const result = await handleFunnelCountRequest({ method: 'POST', body: { event: 'result_viewed' },
                headers: { 'sec-fetch-site': 'same-origin' } }, { env: { NOFRIES_FUNNEL_COUNTS_ENABLED: 'true' }, record, now });
            expect(result.status).toBe(204);
        }
        expect(await countFor('2026-11-07', 'result_viewed')).toEqual([2]);
        expect(await countFor('2026-11-06', 'result_viewed')).toEqual([]);
    });

    test('migrating twice is clean and records 0022 once', async () => {
        const again = await applyMigrations({ pool: ownerPool });
        expect(again.applied).toEqual([]);
        expect(again.skipped).toContain(MIGRATION);
        expect((await ownerPool.query('SELECT migration_id FROM nofries.schema_migrations WHERE migration_id=$1', [MIGRATION])).rows)
            .toEqual([{ migration_id: MIGRATION }]);
        expect((await ownerPool.query("SELECT policyname,cmd FROM pg_policies WHERE schemaname='nofries' AND tablename='funnel_daily_counts' ORDER BY policyname")).rows)
            .toEqual([{ policyname: 'funnel_daily_counts_runtime_insert', cmd: 'INSERT' },
                { policyname: 'funnel_daily_counts_runtime_select', cmd: 'SELECT' },
                { policyname: 'funnel_daily_counts_runtime_update', cmd: 'UPDATE' }]);
    });
});
