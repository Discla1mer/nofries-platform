'use strict';

// Native proof for the staff contact request list: it reads every listed
// organisation through the existing runtime role (0026 RLS, one tenant setting
// at a time), never sees an unlisted tenant, and cannot write. Each run creates
// and drops its own synthetic database and restricted login.
const crypto = require('node:crypto');
const { applyMigrations } = require('../scripts/db-migrate');
const { createContactRequestReader } = require('../api/shared/dashboardAdmin/contactRequestList');

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
        throw new Error('Contact request list proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();
const id = () => crypto.randomUUID();
const subject = () => `${id()}:${id()}`;

test('native discovery accepts only explicit loopback test URLs', () => {
    const ci = 'postgresql://synthetic@127.0.0.1:5432/test';
    expect(localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci })).toBe(ci);
    expect(localTestUrl({})).toBeNull();
    expect(() => localTestUrl({ NOFRIES_TEST_DATABASE_URL: 'postgresql://synthetic@database.invalid/test' })).toThrow(/loopback-only/);
});

(testUrl ? describe : describe.skip)('staff contact request list with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `contact_list_${run}`, role = `contact_list_runtime_${run}`, password = `synthetic-local-contact-${run}`;
    let controlPool, ownerPool, runtimePool, databaseCreated = false, roleCreated = false;
    const orgs = { a: { tenantId: id(), organisationId: id(), name: 'Alpha Ltd' }, b: { tenantId: id(), organisationId: id(), name: 'Beta Ltd' },
        hidden: { tenantId: id(), organisationId: id(), name: 'Unlisted Ltd' } };
    const owner = subject(), colleague = subject();
    const now = Date.parse('2026-11-19T00:00:00Z');

    async function organisation({ tenantId, organisationId, name }) {
        await ownerPool.query(`INSERT INTO nofries.dashboard_tenants (tenant_id, schema_version, revision, payload)
            VALUES ($1, 1, 0, jsonb_build_object('schemaVersion', 1, 'tenantId', $1::text, 'displayName', $2::text, 'recordStatus', 'active', 'revision', 0))`, [tenantId, name]);
        await ownerPool.query(`INSERT INTO nofries.dashboard_organisations (tenant_id, organisation_id, schema_version, revision, payload)
            VALUES ($1, $2, 1, 0, jsonb_build_object('schemaVersion', 1, 'tenantId', $1::text, 'organisationId', $2::text, 'displayName', $3::text,
                'domains', '[]'::jsonb, 'recordStatus', 'active', 'revision', 0))`, [tenantId, organisationId, name]);
    }
    async function request(org, subjectKey, topic, at) {
        await ownerPool.query(`INSERT INTO nofries.dashboard_contact_requests
            (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
            VALUES ($1, $2, $3, $4, $5, 'contact-request-v1', ($6::timestamptz AT TIME ZONE 'Pacific/Auckland')::date, $6::timestamptz)`,
        [org.tenantId, org.organisationId, id(), subjectKey, topic, at]);
    }

    beforeAll(async () => {
        const { Pool } = require('pg');
        controlPool = new Pool({ connectionString: testUrl, max: 2 });
        await controlPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); databaseCreated = true;
        ownerPool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName }), max: 4 });
        await applyMigrations({ pool: ownerPool });
        await controlPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
        roleCreated = true;
        await controlPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(role)}`);
        runtimePool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName, username: role, password }), max: 2 });
        for (const org of Object.values(orgs)) await organisation(org);
        await request(orgs.a, owner, 'results', '2026-11-18T22:30:00Z');
        await request(orgs.a, colleague, 'managed_it_core', '2026-11-10T01:00:00Z');
        await request(orgs.a, owner, 'tier1_support', '2026-07-01T01:00:00Z');
        await request(orgs.b, subject(), 'results', '2026-11-15T03:00:00Z');
        await request(orgs.hidden, subject(), 'results', '2026-11-18T23:00:00Z');
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

    test('lists listed organisations newest first within 90 days, resolving the requester or the owner', async () => {
        const list = jest.fn(async () => ({ truncated: false, rows: [
            { readable: true, email: 'owner@example.test', subjectKey: owner, scopes: [{ tenantId: orgs.a.tenantId, name: 'Alpha (blob)' }] },
            { readable: true, email: 'beta@example.test', subjectKey: subject(), scopes: [{ tenantId: orgs.b.tenantId, name: 'Beta (blob)' }] }] }));
        const read = createContactRequestReader({ list, pool: runtimePool, now: () => now });
        const view = await read(new AbortController().signal);
        expect(list).toHaveBeenCalledWith(expect.anything(), false, true);
        expect(view).toEqual({ truncated: false, windowDays: 90, rows: [
            { requestedAt: '2026-11-18T22:30:00.000Z', organisation: 'Alpha Ltd', topic: 'Results', contactEmail: 'owner@example.test', contactBasis: 'requester' },
            { requestedAt: '2026-11-15T03:00:00.000Z', organisation: 'Beta Ltd', topic: 'Results', contactEmail: 'beta@example.test', contactBasis: 'account' },
            { requestedAt: '2026-11-10T01:00:00.000Z', organisation: 'Alpha Ltd', topic: expect.any(String), contactEmail: 'owner@example.test', contactBasis: 'account' }] });
        expect(JSON.stringify(view)).not.toContain('Unlisted');
    });

    test('the runtime role sees nothing without a tenant setting and the read transaction cannot write', async () => {
        expect((await runtimePool.query('SELECT count(*)::integer AS n FROM nofries.dashboard_contact_requests')).rows[0].n).toBe(0);
        const client = await runtimePool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [orgs.a.tenantId]);
            expect((await client.query('SELECT count(*)::integer AS n FROM nofries.dashboard_contact_requests')).rows[0].n).toBe(3);
            await expect(client.query(`INSERT INTO nofries.dashboard_contact_requests
                (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
                VALUES ($1, $2, $3, $4, 'results', 'contact-request-v1', '2026-11-19', '2026-11-19T00:00:00Z')`,
            [orgs.a.tenantId, orgs.a.organisationId, id(), owner])).rejects.toMatchObject({ code: '25006' });
        } finally { await client.query('ROLLBACK'); client.release(); }
        const privileges = (await runtimePool.query(`SELECT has_table_privilege(current_user, 'nofries.dashboard_contact_requests', 'UPDATE') AS update,
            has_table_privilege(current_user, 'nofries.dashboard_contact_requests', 'DELETE') AS delete`)).rows[0];
        expect(privileges).toEqual({ update: false, delete: false });
    });
});
