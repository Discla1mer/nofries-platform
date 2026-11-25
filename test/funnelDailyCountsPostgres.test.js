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

    test('completion reader suppresses small cohorts and measures only saves through submission in the 90-day window', async () => {
        const { readCompletionStats } = require('../api/shared/funnelCounts');
        const capability = 'nofries_completion_stats_reader';
        expect(await readCompletionStats(runtimePool)).toBeNull();
        const rights = await ownerPool.query(`SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper
            FROM pg_roles WHERE rolname=$1`, [capability]);
        expect(rights.rows).toEqual([{ rolcanlogin: false, rolinherit: false, rolbypassrls: false, rolsuper: false }]);
        const grants = await ownerPool.query(`SELECT c.relname,
            has_any_column_privilege($1,c.oid,'SELECT') AS read,
            has_any_column_privilege($1,c.oid,'UPDATE,INSERT') OR has_table_privilege($1,c.oid,'DELETE,TRUNCATE') AS write
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='nofries' AND c.relkind IN ('r','p','v','m','f')`, [capability]);
        expect(grants.rows.filter(row => row.read || row.write)).toEqual([
            { relname: 'dashboard_ncsc_assessment_revisions', read: true, write: false }]);
        const tenantId = crypto.randomUUID(), organisationId = crypto.randomUUID();
        await ownerPool.query('INSERT INTO nofries.dashboard_tenants VALUES ($1,1,0,$2)', [tenantId,
            { schemaVersion: 1, tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 }]);
        await ownerPool.query('INSERT INTO nofries.dashboard_organisations (tenant_id,organisation_id,schema_version,revision,payload) VALUES ($1,$2,1,0,$3)',
            [tenantId, organisationId, { schemaVersion: 1, tenantId, organisationId, displayName: 'Synthetic organisation', domains: [],
                recordStatus: 'active', revision: 0 }]);
        async function seed(id, ageDays, minutes, submitted = true) {
            const start = Date.now() - ageDays * 86400000;
            const stamp = offset => new Date(start + offset * 60000).toISOString();
            let parent = null;
            for (const revision of submitted ? [0, 1, 2] : [0]) {
                const identity = { tenantId, organisationId, assessmentId: id, revision };
                const state = { ...identity, createdAt: stamp(0), updatedAt: stamp([0, minutes, minutes + 30][revision]),
                    submission: revision ? { submittedAt: stamp(minutes), revision: 1 } : null };
                const payload = { ...identity, schemaVersion: 1, state, scopePopulation: null, rationales: [], evidence: [], risk: null,
                    submission: state.submission };
                const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
                await ownerPool.query(`INSERT INTO nofries.dashboard_ncsc_assessment_revisions
                    (tenant_id,organisation_id,assessment_id,revision,schema_version,payload_sha256,parent_revision,parent_sha256,payload)
                    VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
                [tenantId, organisationId, id, revision, digest, revision ? revision - 1 : null, parent, payload]);
                parent = digest;
            }
        }
        await controlPool.query(`GRANT nofries_completion_stats_reader TO ${quoteIdentifier(role)} WITH SET TRUE, INHERIT FALSE`);
        try {
            await seed('old', 91, 2);
            await seed('unfinished', 1, 2, false);
            for (let i = 0; i < 9; i++) await seed('assessment-' + i, 1, i < 5 ? 2 : 20);
            expect(await readCompletionStats(runtimePool)).toEqual({ count: null, elapsedMedian: null, elapsedP80: null, activeMedian: null, activeP80: null });
            await seed('tenth', 89, 20);
            expect(await readCompletionStats(runtimePool)).toEqual({ count: 10, elapsedMedian: 11, elapsedP80: 20, activeMedian: 3.5, activeP80: 5 });
        } finally { await controlPool.query(`REVOKE nofries_completion_stats_reader FROM ${quoteIdentifier(role)}`); }
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

    test('the staff reader returns the 30-day window under the runtime role, read-only', async () => {
        const { createFunnelCountReader } = require('../api/shared/funnelCounts');
        const view = await createFunnelCountReader({ pool: runtimePool, now: () => new Date('2026-11-06T11:30:00Z') })();
        expect(view.to).toBe('2026-11-07');
        expect(view.days).toHaveLength(30);
        expect(view.days.find(row => row.day === '2026-11-07').counts.result_viewed).toBe(2);
        expect(view.days.find(row => row.day === '2026-11-05').counts).toMatchObject({ visit: 10000000, first_answer: 0 });
        const client = await runtimePool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query('SET LOCAL ROLE nofries_runtime');
            expect((await capture(client.query(UPSERT, ['2026-11-07', 'visit']))).error).toMatchObject({ code: '25006' });
        } finally { await client.query('ROLLBACK'); client.release(); }
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
