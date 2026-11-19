'use strict';

// Native checks of migration 0027 (#455) and the retention job, registered by
// the existing disposable PostgreSQL suite. Each run creates and drops its own
// synthetic database and logins; no application database is selected.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createContactRequestRetention } = require('../../api/shared/contactRequestRetention');

const ROLE = 'nofries_contact_request_retention';
const TABLE = 'nofries.dashboard_contact_requests';
const sql = fs.readFileSync(path.join(__dirname, '../../database/migrations/0027_contact_request_retention.sql'), 'utf8');
const statements = sql.replace(/^\s*--.*$/gm, '');
const SUBJECT = '70000000-0000-4000-8000-000000000001:70000000-0000-4000-8000-000000000002';
const TOPICS = ['results', 'managed_it_core', 'tier1_support', 'monthly_proof', 'work_file_backup', 'endpoint_security'];
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
        throw new Error('Contact request retention proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();

module.exports = function registerContactRequestRetentionTests() {
test('0027 grants the retention role read of the key and date, delete, and nothing else', () => {
    const grants = sql.match(/^GRANT[^;]*;/gm).map(line => line.replace(/\s+/g, ' '));
    expect(grants).toEqual([`GRANT USAGE ON SCHEMA nofries TO ${ROLE};`,
        `GRANT SELECT (tenant_id, request_id, requested_at), DELETE ON ${TABLE} TO ${ROLE};`]);
    expect(statements).not.toMatch(/GRANT\s+nofries_contact_request_retention\s+TO/i);
    expect(statements).not.toMatch(/nofries_runtime|nofries_account_wipe/);
    expect(sql.match(/CREATE POLICY[^;]*;/g).map(line => line.replace(/\s+/g, ' '))).toEqual([
        `CREATE POLICY dashboard_contact_requests_retention_select ON ${TABLE} FOR SELECT TO ${ROLE} USING (requested_at < now() - interval '24 months');`,
        `CREATE POLICY dashboard_contact_requests_retention_delete ON ${TABLE} FOR DELETE TO ${ROLE} USING (requested_at < now() - interval '24 months');`]);
});

(testUrl ? describe : describe.skip)('contact request retention with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `contact_retention_${run}`;
    const runtimeLogin = `retention_runtime_${run}`, purgeLogin = `retention_purge_${run}`, password = `synthetic-local-retention-${run}`;
    const tenantA = crypto.randomUUID(), tenantB = crypto.randomUUID(), orgA = crypto.randomUUID(), orgB = crypto.randomUUID();
    const created = { database: false, logins: [] };
    let controlPool, ownerPool, runtimePool, purgePool;
    const capture = promise => promise.then(value => ({ value }), error => ({ error }));
    // Ages relative to now: two past 24 months (one in each tenant), one a day past, one a day short, and two recent.
    const AGES = [[tenantA, orgA, '30 months'], [tenantB, orgB, '25 months'], [tenantA, orgA, '24 months 1 day'],
        [tenantB, orgB, '23 months 29 days'], [tenantA, orgA, '1 month'], [tenantB, orgB, '1 day']];
    const OLD = 3;
    async function seed() {
        await ownerPool.query(`TRUNCATE ${TABLE}`);
        for (const [index, [tenantId, organisationId, age]] of AGES.entries()) {
            await ownerPool.query(`WITH t AS (SELECT date_trunc('milliseconds', now() - $5::interval) AS at)
                INSERT INTO ${TABLE} (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
                SELECT $1, $2, $3, $4, $6, 'contact-request-v1', (t.at AT TIME ZONE 'Pacific/Auckland')::date, t.at FROM t`,
            [tenantId, organisationId, crypto.randomUUID(), SUBJECT, age, TOPICS[index]]);
        }
    }
    const remaining = async () => (await ownerPool.query(`SELECT topic FROM ${TABLE} ORDER BY requested_at`)).rows.map(row => row.topic);
    async function asRetention(work, end = 'ROLLBACK') {
        const client = await purgePool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL ROLE ${ROLE}`);
            const result = await capture(Promise.resolve().then(() => work(client)));
            await client.query(result.error ? 'ROLLBACK' : end);
            return result;
        } finally { client.release(); }
    }
    async function login(name, grant) {
        await controlPool.query(`CREATE ROLE ${quoteIdentifier(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
        created.logins.push(name);
        await controlPool.query(grant(quoteIdentifier(name)));
        return new (require('pg').Pool)({ connectionString: urlFor(testUrl, { database: databaseName, username: name, password }),
            max: 2, statement_timeout: 15000 });
    }

    beforeAll(async () => {
        const { Pool } = require('pg');
        controlPool = new Pool({ connectionString: testUrl, max: 2 });
        await controlPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); created.database = true;
        ownerPool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName }), max: 4 });
        await applyMigrations({ pool: ownerPool });
        runtimePool = await login(runtimeLogin, name => `GRANT nofries_runtime TO ${name}`);
        // The production grant this change needs: SET only, no INHERIT.
        purgePool = await login(purgeLogin, name => `GRANT ${ROLE} TO ${name} WITH SET TRUE, INHERIT FALSE`);
        for (const [tenantId, organisationId] of [[tenantA, orgA], [tenantB, orgB]]) {
            await ownerPool.query('INSERT INTO nofries.dashboard_tenants (tenant_id,schema_version,revision,payload) VALUES ($1,1,0,$2::jsonb)',
                [tenantId, JSON.stringify({ schemaVersion: 1, tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 })]);
            await ownerPool.query('INSERT INTO nofries.dashboard_organisations (tenant_id,organisation_id,schema_version,revision,payload) VALUES ($1,$2,1,0,$3::jsonb)',
                [tenantId, organisationId, JSON.stringify({ schemaVersion: 1, tenantId, organisationId, displayName: 'Synthetic organisation',
                    domains: [], recordStatus: 'active', revision: 0 })]);
        }
    }, 30000);
    beforeEach(seed);
    afterAll(async () => {
        for (const pool of [purgePool, runtimePool, ownerPool]) if (pool) await pool.end();
        if (controlPool) {
            try {
                if (created.database) await controlPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
                // Dropping the logins also removes their memberships, so the shared role keeps no members.
                for (const name of created.logins) await controlPool.query(`DROP ROLE ${quoteIdentifier(name)}`);
            } finally { await controlPool.end(); }
        }
    });

    test('the role cannot log in, bypass RLS or inherit, and holds privileges on this table only', async () => {
        const role = (await ownerPool.query('SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=$1', [ROLE])).rows[0];
        expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false });
        const privileges = (await ownerPool.query(`SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(name =>
            `has_table_privilege($1,'${TABLE}','${name}') AS "${name}"`).join(',')}`, [ROLE])).rows[0];
        expect(privileges).toEqual({ SELECT: false, INSERT: false, UPDATE: false, DELETE: true, TRUNCATE: false });
        const columns = (await ownerPool.query(`SELECT column_name FROM information_schema.columns
            WHERE table_schema='nofries' AND table_name='dashboard_contact_requests'
              AND has_column_privilege($1, '${TABLE}', column_name, 'SELECT') ORDER BY column_name`, [ROLE])).rows;
        expect(columns.map(row => row.column_name)).toEqual(['request_id', 'requested_at', 'tenant_id']);
        const elsewhere = (await ownerPool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='nofries' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'dashboard_contact_requests'
              AND (has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE'))`, [ROLE])).rows;
        expect(elsewhere).toEqual([]);
        const policies = (await ownerPool.query(`SELECT policyname, cmd FROM pg_policies
            WHERE schemaname='nofries' AND $1 = ANY(roles) ORDER BY policyname`, [ROLE])).rows;
        expect(policies).toEqual([{ policyname: 'dashboard_contact_requests_retention_delete', cmd: 'DELETE' },
            { policyname: 'dashboard_contact_requests_retention_select', cmd: 'SELECT' }]);
    });

    test('the role sees only rows past 24 months and cannot read their content, insert or update', async () => {
        expect((await asRetention(tx => tx.query(`SELECT tenant_id FROM ${TABLE}`))).value.rowCount).toBe(OLD);
        // The boundary row a day short of 24 months is invisible even when named by its date.
        expect((await asRetention(tx => tx.query(`SELECT 1 FROM ${TABLE} WHERE requested_at >= now() - interval '24 months'`))).value.rowCount).toBe(0);
        for (const statement of [`SELECT subject_key FROM ${TABLE}`, `SELECT organisation_id, topic FROM ${TABLE}`, `SELECT * FROM ${TABLE}`,
            `UPDATE ${TABLE} SET requested_at = now()`, `TRUNCATE ${TABLE}`,
            `INSERT INTO ${TABLE} (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
                VALUES ('${tenantA}', '${orgA}', '${crypto.randomUUID()}', '${SUBJECT}', 'customer_onboarding', 'contact-request-v1', '2020-01-01', '2020-01-01T00:00:00Z')`]) {
            expect((await asRetention(tx => tx.query(statement))).error).toMatchObject({ code: '42501' });
        }
    });

    test('an unscoped delete as the role removes only rows past 24 months', async () => {
        expect((await asRetention(tx => tx.query(`DELETE FROM ${TABLE}`), 'COMMIT')).value.rowCount).toBe(OLD);
        expect(await remaining()).toEqual(TOPICS.slice(OLD));
        // Even naming a recent row directly deletes nothing.
        expect((await asRetention(tx => tx.query(`DELETE FROM ${TABLE} WHERE requested_at > now() - interval '2 days'`))).value.rowCount).toBe(0);
    });

    test('the job, as a login granted the role WITH SET, purges only rows past 24 months in bounded batches', async () => {
        const log = jest.fn();
        expect(await createContactRequestRetention({ pool: purgePool, log, batchSize: 2 }).runOnce()).toEqual({ code: 'retention_completed', deleted: OLD });
        expect(log.mock.calls).toEqual([[{ code: 'retention_completed', deleted: OLD }]]);
        expect(await remaining()).toEqual(TOPICS.slice(OLD));
        // A second run finds nothing more.
        expect(await createContactRequestRetention({ pool: purgePool, log }).runOnce()).toEqual({ code: 'retention_completed', deleted: 0 });
    });

    test('the login without SET ROLE cannot read the table, and the runtime login has no grant and cannot delete', async () => {
        expect((await capture(purgePool.query(`SELECT 1 FROM ${TABLE}`))).error).toMatchObject({ code: '42501' });
        expect((await runtimePool.query(`SELECT pg_has_role(current_user, '${ROLE}', 'SET') AS ok`)).rows[0].ok).toBe(false);
        const log = jest.fn();
        expect(await createContactRequestRetention({ pool: runtimePool, log }).runOnce()).toEqual({ code: 'retention_role_unavailable', deleted: 0 });
        expect((await capture(runtimePool.query(`SET ROLE ${ROLE}`))).error).toMatchObject({ code: '42501' });
        const client = await runtimePool.connect();
        try {
            for (const tenantId of [tenantA, tenantB]) {
                await client.query('BEGIN');
                await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
                expect((await capture(client.query(`DELETE FROM ${TABLE} WHERE requested_at < now() - interval '24 months'`))).error)
                    .toMatchObject({ code: '42501' });
                await client.query('ROLLBACK');
            }
        } finally { client.release(); }
        expect(await remaining()).toEqual(TOPICS);
    });
});
};
