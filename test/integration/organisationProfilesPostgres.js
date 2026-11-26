'use strict';

// Native checks of migration 0035 (#608 step 1), registered by the disposable
// PostgreSQL suite. Each run creates and drops its own synthetic database and
// restricted role; no application database is selected.
const crypto = require('node:crypto');
const { applyMigrations } = require('../../scripts/db-migrate');

const SUBJECT = '70000000-0000-4000-8000-000000000001:70000000-0000-4000-8000-000000000002';
const OTHER = '71000000-0000-4000-8000-000000000001:71000000-0000-4000-8000-000000000002';
const INSERT = `INSERT INTO nofries.dashboard_organisation_profiles
    (tenant_id, organisation_id, revision, website, industry, region, size_band, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
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
        throw new Error('Organisation profile proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();

module.exports = function registerOrganisationProfileTests() {
(testUrl ? describe : describe.skip)('organisation profiles (0035) with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `organisation_profiles_${run}`, role = `profile_runtime_${run}`, password = `synthetic-local-profile-${run}`;
    const tenantA = crypto.randomUUID(), tenantB = crypto.randomUUID(), orgA = crypto.randomUUID(), orgB = crypto.randomUUID();
    let controlPool, ownerPool, runtimePool, databaseCreated = false, roleCreated = false;
    const capture = promise => promise.then(value => ({ value }), error => ({ error }));
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
    const row = (tenantId, organisationId, overrides = {}) => [tenantId, organisationId, overrides.revision ?? 1,
        'website' in overrides ? overrides.website : 'https://example.co.nz/', overrides.industry ?? 'retail',
        overrides.region ?? 'auckland', overrides.size ?? '6-20', overrides.at ?? '2026-11-26T01:00:00.000Z', overrides.subject ?? SUBJECT];
    const all = async () => (await ownerPool.query(
        'SELECT tenant_id, revision, website, industry FROM nofries.dashboard_organisation_profiles ORDER BY tenant_id')).rows;

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

    test('table forces RLS; runtime can read, insert and update the profile columns but not delete or rekey', async () => {
        const rel = (await ownerPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='nofries.dashboard_organisation_profiles'::regclass")).rows[0];
        expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const privileges = (await runtimePool.query(`SELECT ${['SELECT', 'INSERT', 'DELETE', 'TRUNCATE'].map(name =>
            `has_table_privilege(current_user,'nofries.dashboard_organisation_profiles','${name}') AS "${name}"`).join(',')}`)).rows[0];
        expect(privileges).toEqual({ SELECT: true, INSERT: true, DELETE: false, TRUNCATE: false });
        const columns = (await runtimePool.query(`SELECT column_name, has_column_privilege(current_user,'nofries.dashboard_organisation_profiles',column_name,'UPDATE') AS upd
            FROM information_schema.columns WHERE table_schema='nofries' AND table_name='dashboard_organisation_profiles' ORDER BY ordinal_position`)).rows;
        expect(columns).toEqual([['tenant_id', false], ['organisation_id', false], ['revision', true], ['website', true], ['industry', true],
            ['region', true], ['size_band', true], ['updated_at', true], ['updated_by', true]].map(([column_name, upd]) => ({ column_name, upd })));
    });

    test('a profile is written, updated and read only inside its own tenant and organisation', async () => {
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgA)))).error).toBeUndefined();
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantB, orgB)))).error).toMatchObject({ code: '42501' });
        expect((await asTenant(tenantA, tx => tx.query(INSERT, row(tenantA, orgB)), { organisation: orgA })).error).toMatchObject({ code: '42501' });
        expect((await asTenant('', tx => tx.query('SELECT 1 FROM nofries.dashboard_organisation_profiles'))).value.rowCount).toBe(0);
        expect((await asTenant(tenantB, tx => tx.query('SELECT 1 FROM nofries.dashboard_organisation_profiles'))).value.rowCount).toBe(0);
        const updated = await asTenant(tenantA, tx => tx.query(`UPDATE nofries.dashboard_organisation_profiles
            SET revision=2, industry='health', updated_at=$1, updated_by=$2 WHERE revision=1`, ['2026-11-26T02:00:00.000Z', SUBJECT]));
        expect(updated.value.rowCount).toBe(1);
        // Tenant B cannot see, so cannot change, tenant A's row.
        expect((await asTenant(tenantB, tx => tx.query("UPDATE nofries.dashboard_organisation_profiles SET industry='other'"))).value.rowCount).toBe(0);
        expect(await all()).toEqual([{ tenant_id: tenantA, revision: 2, website: 'https://example.co.nz/', industry: 'health' }]);
    });

    test('every write is stamped with the bound subject', async () => {
        expect((await asTenant(tenantB, tx => tx.query(INSERT, row(tenantB, orgB, { subject: OTHER })))).error).toMatchObject({ code: '42501' });
        expect((await asTenant(tenantB, tx => tx.query(INSERT, row(tenantB, orgB)), { subject: '' })).error).toMatchObject({ code: '42501' });
        expect((await asTenant(tenantA, tx => tx.query('UPDATE nofries.dashboard_organisation_profiles SET updated_by=$1', [OTHER]))).error)
            .toMatchObject({ code: '42501' });
        expect((await asTenant(tenantA, tx => tx.query('UPDATE nofries.dashboard_organisation_profiles SET tenant_id=$1', [tenantB]))).error)
            .toMatchObject({ code: '42501' });
    });

    test('websites, codes and revisions outside the agreed shapes are refused', async () => {
        for (const overrides of [{ website: 'http://example.co.nz/' }, { website: 'https://example.co.nz' }, { website: 'https://example.co.nz/about' },
            { website: 'https://Example.co.nz/' }, { website: 'https://10.0.0.1/' }, { website: 'https://localhost/' },
            { website: 'https://user@example.co.nz/' }, { website: 'https://' + 'a'.repeat(250) + '.nz/' },
            { industry: 'Retail' }, { industry: 'mining' }, { region: 'Auckland' }, { region: '' }, { size: '1-5' }, { revision: 0 }]) {
            expect((await asTenant(tenantB, tx => tx.query(INSERT, row(tenantB, orgB, overrides)))).error).toMatchObject({ code: '23514' });
        }
        // Every field except the stamp may be left empty.
        expect((await asTenant(tenantB, tx => tx.query(INSERT, [tenantB, orgB, 1, null, null, null, null, '2026-11-26T01:00:00.000Z', SUBJECT]))).error)
            .toBeUndefined();
        expect((await asTenant(tenantB, tx => tx.query(INSERT, row(tenantB, orgB)))).error).toMatchObject({ code: '23505' });
    });

    test('runtime cannot remove a profile', async () => {
        for (const statement of ['DELETE FROM nofries.dashboard_organisation_profiles', 'TRUNCATE nofries.dashboard_organisation_profiles']) {
            expect((await asTenant(tenantA, tx => tx.query(statement))).error).toMatchObject({ code: '42501' });
        }
    });

    test('the account wipe role removes one tenant only and cannot write', async () => {
        const client = await ownerPool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE nofries_account_wipe');
            await client.query("SELECT set_config('nofries.wipe_tenant_id', $1, true)", [tenantA]);
            await client.query('SAVEPOINT w');
            expect((await capture(client.query("UPDATE nofries.dashboard_organisation_profiles SET industry='other'"))).error).toMatchObject({ code: '42501' });
            await client.query('ROLLBACK TO SAVEPOINT w');
            expect((await client.query('DELETE FROM nofries.dashboard_organisation_profiles')).rowCount).toBe(1);
            await client.query('COMMIT');
        } finally { client.release(); }
        expect((await all()).map(item => item.tenant_id)).toEqual([tenantB]);
    });
});
};
