'use strict';

// Native checks of migration 0026 (#427, part of #409), registered by the existing disposable
// PostgreSQL suite. Each run creates and drops its own synthetic database and
// restricted role; no application database is selected.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const registry = require('../../api/shared/protectedAssets/dashboardRegistry');
const { RESET_TABLES, DELETE_TENANT_TABLES } = require('../../api/shared/dashboardAdmin/accountWipeRepository');

const MIGRATION = '0026_dashboard_contact_requests.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../database/migrations', MIGRATION), 'utf8');
const INSERT = `INSERT INTO nofries.dashboard_contact_requests
    (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
const SUBJECT = '50000000-0000-4000-8000-000000000001:50000000-0000-4000-8000-000000000002';
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
        throw new Error('Contact request proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();

module.exports = function registerDashboardContactRequestTests() {
test('0026 stores no message, email or assessment content and gives runtime no rewrite', () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE nofries.dashboard_contact_requests'), sql.indexOf('ALTER TABLE'));
    expect(table).not.toMatch(/\bemail\b|message|answer|payload|score|jsonb|\bip\b|user_agent|cookie/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*TO nofries_runtime/i);
    expect(sql).not.toMatch(/FOR (ALL|UPDATE|DELETE) TO nofries_runtime/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|TRUNCATE|ALL)\b[^;]*TO nofries_account_wipe/i);
});

test('the topic list is "results" plus every dashboard service key', () => {
    const list = /topic IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z0-9_]+)'/g).map(item => item.slice(1, -1));
    expect(list).toEqual(['results', ...registry.services.map(service => service.key)]);
});

// The wipe locks every table in its list, so the table joins that list only in the change that first
// writes to it, which can ship only after 0026 is applied. Until then nothing can create a row.
test('the account wipe does not name the table before the migration can be applied', () => {
    expect(RESET_TABLES).not.toContain('dashboard_contact_requests');
    expect(DELETE_TENANT_TABLES).not.toContain('dashboard_contact_requests');
});

(testUrl ? describe : describe.skip)('dashboard contact requests with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `contact_requests_${run}`, role = `contact_runtime_${run}`, password = `synthetic-local-contact-${run}`;
    const tenantA = crypto.randomUUID(), tenantB = crypto.randomUUID(), orgA = crypto.randomUUID(), orgB = crypto.randomUUID();
    let controlPool, ownerPool, runtimePool, databaseCreated = false, roleCreated = false;
    const capture = promise => promise.then(value => ({ value }), error => ({ error }));
    // Run statements as the runtime role inside one transaction bound to a tenant.
    async function asTenant(tenantId, work, bound = {}) {
        const client = await runtimePool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('nofries.tenant_id', $1, true), set_config('nofries.organisation_id', $2, true), set_config('nofries.subject_key', $3, true)",
                [tenantId, bound.organisation ?? ({ [tenantA]: orgA, [tenantB]: orgB })[tenantId] ?? '', bound.subject ?? SUBJECT]);
            const result = await capture(Promise.resolve().then(() => work(client)));
            await client.query(result.error ? 'ROLLBACK' : 'COMMIT');
            return result;
        } finally { client.release(); }
    }
    // `??` keeps an empty string an explicit (invalid) value instead of the default.
    const row = (tenantId, organisationId, overrides = {}) => [tenantId, organisationId, overrides.requestId ?? crypto.randomUUID(),
        overrides.subject ?? SUBJECT, overrides.topic ?? 'results', overrides.consent ?? 'contact-request-v1',
        overrides.day ?? '2026-11-18', overrides.at ?? `${overrides.day ?? '2026-11-18'}T01:00:00.000Z`];
    const all = async () => (await ownerPool.query(
        'SELECT tenant_id, topic, requested_day::text AS day FROM nofries.dashboard_contact_requests ORDER BY tenant_id, topic, requested_day')).rows;

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
            max: 4, statement_timeout: 15000 });
        for (const [tenantId, organisationId] of [[tenantA, orgA], [tenantB, orgB]]) {
            await ownerPool.query('INSERT INTO nofries.dashboard_tenants (tenant_id,schema_version,revision,payload) VALUES ($1,1,0,$2::jsonb)',
                [tenantId, JSON.stringify({ schemaVersion: 1, tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 })]);
            await ownerPool.query('INSERT INTO nofries.dashboard_organisations (tenant_id,organisation_id,schema_version,revision,payload) VALUES ($1,$2,1,0,$3::jsonb)',
                [tenantId, organisationId, JSON.stringify({ schemaVersion: 1, tenantId, organisationId, displayName: 'Synthetic organisation',
                    domains: [], recordStatus: 'active', revision: 0 })]);
        }
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

    test('table forces RLS and runtime can only read and insert', async () => {
        const rel = (await ownerPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='nofries.dashboard_contact_requests'::regclass")).rows[0];
        expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const columns = (await ownerPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='nofries' AND table_name='dashboard_contact_requests' ORDER BY ordinal_position")).rows;
        expect(columns.map(item => item.column_name)).toEqual(['tenant_id', 'organisation_id', 'request_id', 'subject_key',
            'topic', 'consent_version', 'requested_day', 'requested_at']);
        const privileges = (await runtimePool.query(`SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(name =>
            `has_table_privilege(current_user,'nofries.dashboard_contact_requests','${name}') AS "${name}"`).join(',')}`)).rows[0];
        expect(privileges).toEqual({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false });
    });

    test('a request is written and read only inside its own tenant', async () => {
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA)))).error).toBeUndefined();
        // Bound to tenant A, a row for tenant B is refused by the insert policy.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantB, orgB)))).error).toMatchObject({ code: '42501' });
        // With no tenant bound, nothing can be written or seen.
        expect((await asTenant('', tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'tier1_support' })))).error).toMatchObject({ code: '42501' });
        expect((await asTenant('', tx => tx.query('SELECT 1 FROM nofries.dashboard_contact_requests'))).value.rowCount).toBe(0);
        expect((await asTenant(tenantB, tx => tx.query('SELECT 1 FROM nofries.dashboard_contact_requests'))).value.rowCount).toBe(0);
        expect((await asTenant(tenantA, tx => tx.query('SELECT 1 FROM nofries.dashboard_contact_requests'))).value.rowCount).toBe(1);
    });

    test('a retry is the same row and a second request the same day for the same topic is refused', async () => {
        const requestId = crypto.randomUUID();
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { requestId, topic: 'managed_it_core' })))).error).toBeUndefined();
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { requestId, topic: 'managed_it_core' })))).error)
            .toMatchObject({ code: '23505' });
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'managed_it_core' })))).error)
            .toMatchObject({ code: '23505', constraint: 'dashboard_contact_requests_daily' });
        // Another day or another topic is a new request.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'managed_it_core', day: '2026-11-19' })))).error).toBeUndefined();
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'monthly_proof' })))).error).toBeUndefined();
    });

    test('unknown topics, consent versions, subjects and organisations are refused', async () => {
        for (const overrides of [{ topic: 'everything' }, { topic: 'Results' }, { topic: '' }, { consent: 'contact-request-v0' },
            { consent: '' }, { subject: 'someone@example.test' }]) {
            expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { ...overrides, day: '2026-12-01' })),
                { subject: overrides.subject })).error).toMatchObject({ code: '23514' });
        }
        // Tenant A cannot attach a request to an organisation it does not hold, even if it binds that id.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgB, { day: '2026-12-02' })), { organisation: orgB })).error)
            .toMatchObject({ code: '23503' });
    });

    test('a row for another organisation or subject than the bound one is refused', async () => {
        const other = '60000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000002';
        // Bound to organisation A, a row naming a different organisation id is refused by policy.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgB, { day: '2026-12-04' })))).error).toMatchObject({ code: '42501' });
        // Bound to one subject, a row naming another subject is refused, and so is a row when no subject is bound.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { subject: other, day: '2026-12-04' })))).error).toMatchObject({ code: '42501' });
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { day: '2026-12-04' })), { subject: '' })).error).toMatchObject({ code: '42501' });
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { day: '2026-12-04' })), { organisation: '' })).error).toMatchObject({ code: '42501' });
    });

    test('the day must be the Pacific/Auckland date of the request time', async () => {
        // 11:30 UTC on 4 December is 00:30 on 5 December in Auckland.
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'work_file_backup', day: '2026-12-04', at: '2026-12-04T11:30:00.000Z' })))).error)
            .toMatchObject({ code: '23514', constraint: 'dashboard_contact_requests_day' });
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA, { topic: 'work_file_backup', day: '2026-12-05', at: '2026-12-04T11:30:00.000Z' })))).error).toBeUndefined();
    });

    test('runtime cannot change or remove a request', async () => {
        for (const statement of ["UPDATE nofries.dashboard_contact_requests SET topic='results'", 'DELETE FROM nofries.dashboard_contact_requests',
            'TRUNCATE nofries.dashboard_contact_requests']) {
            expect((await asTenant(tenantA, tx => tx.query(statement))).error).toMatchObject({ code: '42501' });
        }
    });

    test('the account wipe role removes one tenant only and cannot write', async () => {
        await asTenant(tenantB, tx => tx.query(INSERT, row(tenantB, orgB)));
        const before = await all();
        expect(before.some(item => item.tenant_id === tenantA) && before.some(item => item.tenant_id === tenantB)).toBe(true);
        const client = await ownerPool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE nofries_account_wipe');
            await client.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantA]);
            await client.query('SAVEPOINT w');
            const denied = await capture(client.query(INSERT, row(tenantA, orgA, { day: '2026-12-03' })));
            expect(denied.error).toMatchObject({ code: '42501' });
            await client.query('ROLLBACK TO SAVEPOINT w');
            // An unscoped delete still reaches only the tenant being wiped.
            await client.query('DELETE FROM nofries.dashboard_contact_requests');
            await client.query('COMMIT');
        } finally { client.release(); }
        const after = await all();
        expect(after.some(item => item.tenant_id === tenantA)).toBe(false);
        expect(after).toEqual(before.filter(item => item.tenant_id === tenantB));
    });
});
};
