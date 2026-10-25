const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    applyMigrations
} = require('../scripts/db-migrate');

const TEST_DATABASE_URL = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const runKey = crypto.randomBytes(8).toString('hex');
const runtimeRole = `nofries_test_rls_${runKey}`;
const runtimePassword = `nofries-test-only-${runKey}`;
const LIFECYCLE_TABLES = Object.freeze([
    'lifecycle_activation_requests',
    'lifecycle_approvals',
    'lifecycle_audit',
    'lifecycle_control_runs',
    'lifecycle_conversations',
    'lifecycle_dead_letters',
    'lifecycle_device_provider_refs',
    'lifecycle_external_references',
    'lifecycle_inbox_receipts',
    'lifecycle_observability',
    'lifecycle_onboarding_devices',
    'lifecycle_operator_corrections',
    'lifecycle_operator_tasks',
    'lifecycle_organisations',
    'lifecycle_prospect_admissions',
    'lifecycle_prospect_security_events',
    'lifecycle_schedules',
    'lifecycle_users'
]);
const LIFECYCLE_CLAIM_INDEXES = Object.freeze({
    lifecycle_users_tenant_subject_unique:
        '(tenant_key, lower(subject_key))',
    lifecycle_organisations_datto_site_uid_unique:
        '(tenant_key, lower(datto_rmm_site_uid))',
    lifecycle_organisations_datto_site_name_key_unique:
        '(tenant_key, lower(datto_rmm_site_name_key))',
    lifecycle_organisations_datto_claim_id_unique:
        '(tenant_key, lower(datto_rmm_provisioning_claim_id))',
    lifecycle_device_provider_refs_claim_unique:
        '(tenant_key, lower(provider_system), lower(external_id))',
    lifecycle_external_references_active_claim_unique:
        '(tenant_key, lower(provider_system), lower(record_type), lower(provider_scope_id), lower(external_id))',
    lifecycle_external_references_active_slot_unique:
        '(tenant_key, organisation_id, lower(provider_system), lower(record_type), lower(provider_scope_id))',
    lifecycle_conversations_tenant_session_unique:
        '(tenant_key, lower(session_hash))',
    lifecycle_activation_requests_tenant_idempotency_unique:
        '(tenant_key, organisation_id, idempotency_key)',
    lifecycle_schedules_tenant_organisation_job_unique:
        '(tenant_key, organisation_id, job_type)'
});

const {
    createServiceDeskRepository
} = require('../api/shared/serviceDesk/serviceDeskRepository');

jest.setTimeout(30000);

require('./integration/dashboardPostgres')();
require('./integration/ncscAssessmentPostgres')();
require('./integration/dashboardRuntimePostgres')();
require('./integration/dashboardAdminPostgres')();
require('./integration/dashboardAdminSignupPostgres')();
// dashboardAdminAuditLaunchPostgres: private controller integration suite remains private.
require('./integration/organisationAccessAcceptance')();
require('./integration/evidencePostgres')();
require('./integration/evidenceMetadataPostgres')();
// restrictedMaintenancePostgres: private controller integration suite remains private.
// databasePublicHardeningPostgres: private controller integration suite remains private.

describe('PostgreSQL migration runner', () => {
    let migrationsDir;

    beforeEach(() => {
        migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-migrations-'));
        fs.writeFileSync(
            path.join(migrationsDir, '0001_test.sql'),
            'SELECT 1;\n',
            'utf8'
        );
    });

    afterEach(() => {
        fs.rmSync(migrationsDir, { recursive: true, force: true });
    });

    test('applies once, skips an identical replay and rejects checksum drift', async () => {
        const client = migrationLedgerClient();

        await expect(applyMigrations({ client, migrationsDir })).resolves.toEqual({
            applied: ['0001_test.sql'],
            skipped: [],
            total: 1
        });
        await expect(applyMigrations({ client, migrationsDir })).resolves.toEqual({
            applied: [],
            skipped: ['0001_test.sql'],
            total: 1
        });

        fs.writeFileSync(
            path.join(migrationsDir, '0001_test.sql'),
            'SELECT 2;\n',
            'utf8'
        );
        client.query.mockClear();

        await expect(applyMigrations({ client, migrationsDir })).rejects.toMatchObject({
            code: 'database_migration_checksum_drift',
            migrationId: '0001_test.sql',
            message: 'No Fries could not complete the database migration.'
        });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });
});

// Model the required isolated server baseline only inside each rolled-back test
// transaction. No other database's persistent ACL is changed by this fixture.
async function restrictOtherDatabasePublic(client, providerFixtures = []) {
    const rows = (await client.query('SELECT datname FROM pg_database WHERE datname<>current_database() AND datallowconn AND NOT (datname=ANY($1::text[]))', [providerFixtures])).rows;
    for (const { datname } of rows) await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(datname)} FROM PUBLIC`);
}

describeWithPostgres('PostgreSQL migrations and tenant RLS', () => {
    let ownerPool;
    let runtimePool;
    let repository;
    let tenantA;
    let tenantB;
    const sharedTicketId = `ticket_rls_shared_${runKey}`;
    const sharedOrganisationId = `organisation_rls_shared_${runKey}`;

    beforeAll(async () => {
        const { Pool } = require('pg');
        ownerPool = new Pool({
            connectionString: TEST_DATABASE_URL,
            application_name: 'nofries-postgres-migration-test-owner',
            max: 2
        });
        await ownerPool.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD ${quoteLiteral(runtimePassword)}`);
        await ownerPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(runtimeRole)}`);
        const runtimeUrl = databaseUrlForRole(TEST_DATABASE_URL, runtimeRole, runtimePassword);
        runtimePool = new Pool({
            connectionString: runtimeUrl,
            application_name: 'nofries-postgres-rls-test-runtime',
            max: 1
        });
        repository = createServiceDeskRepository({
            provider: 'postgres',
            env: Object.assign({}, process.env, {
                NODE_ENV: 'test',
                NOFRIES_DATABASE_URL: runtimeUrl
            })
        });

        tenantA = access('rls-a');
        tenantB = access('rls-b');
        await repository.mutate(tenantA, mutationOptions(0, sharedTicketId), (state) => {
            state.tickets.push(ticket(tenantA, sharedTicketId, 'Visible only to tenant A'));
        });
        await repository.mutate(tenantB, mutationOptions(0, sharedTicketId), (state) => {
            state.tickets.push(ticket(tenantB, sharedTicketId, 'Visible only to tenant B'));
        });

        const client = await runtimePool.connect();
        try {
            await seedLifecycleOrganisation(
                client,
                tenantA.tenant.key,
                sharedOrganisationId,
                'Lifecycle organisation visible only to tenant A'
            );
            await seedLifecycleOrganisation(
                client,
                tenantB.tenant.key,
                sharedOrganisationId,
                'Lifecycle organisation visible only to tenant B'
            );
        } finally {
            client.release();
        }
    });

    afterAll(async () => {
        if (repository) await repository.close();
        if (runtimePool) await runtimePool.end();
        if (ownerPool) {
            await ownerPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`);
            await ownerPool.end();
        }
    });

    // Private controller assertion remains in the private repository.
    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Fixed-name provider fixtures exist only in the disposable localhost CI
    // service. CREATE fails on collisions; role/ACL/name changes always roll back.
    async function withProviderDatabase(database, exercise) {
        const url = new URL(TEST_DATABASE_URL);
        expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
        expect(url.pathname).toBe('/nofries_ci');
        expect(['azure_sys', 'azure_maintenance']).toContain(database);
        let created = false, client;
        try {
            await ownerPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
            created = true;
            client = await ownerPool.connect();
            await client.query('BEGIN');
            await client.query('CREATE ROLE azuresu NOLOGIN SUPERUSER');
            await client.query(`ALTER DATABASE ${quoteIdentifier(database)} OWNER TO azuresu`);
            await client.query(`REVOKE nofries_runtime FROM ${quoteIdentifier(runtimeRole)}`);
            await restrictOtherDatabasePublic(client, [database]);
            await exercise(client);
        } finally {
            if (client) { try { await client.query('ROLLBACK'); } finally { client.release(); } }
            if (created) await ownerPool.query(`DROP DATABASE ${quoteIdentifier(database)}`);
        }
    }

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    // Private controller assertion remains in the private repository.

    test('installs the checksum ledger and forced-RLS tenant tables', async () => {
        const migrations = await ownerPool.query(
            `SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_name LIKE '%migration%'
            ORDER BY table_schema, table_name`
        );
        expect(migrations.rows).toContainEqual({
            table_schema: 'nofries',
            table_name: 'schema_migrations'
        });

        const migrationColumns = await ownerPool.query(
            `SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'nofries' AND table_name = 'schema_migrations'
            ORDER BY ordinal_position`
        );
        expect(migrationColumns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
            'migration_id',
            'checksum_sha256',
            'applied_at'
        ]));
        const migrationLedger = await ownerPool.query(
            `SELECT migration_id, checksum_sha256
            FROM nofries.schema_migrations
            ORDER BY migration_id`
        );
        expect(migrationLedger.rows).toEqual(expect.arrayContaining([{
            migration_id: '0001_core_service_desk.sql',
            checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }, {
            migration_id: '0002_lifecycle.sql',
            checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }]));
        expect(migrationLedger.rows.length).toBeGreaterThan(0);

        const tables = await ownerPool.query(
            `SELECT relname AS table_name, relrowsecurity, relforcerowsecurity
            FROM pg_class
            JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
            WHERE pg_namespace.nspname = 'nofries'
              AND pg_class.relkind = 'r'
              AND relname = ANY($1::text[])
            ORDER BY relname`,
            [[
                'tenants',
                'module_revisions',
                'service_desk_users',
                'service_desk_tickets',
                'service_desk_audit'
            ]]
        );
        expect(tables.rows).toHaveLength(5);
        expect(tables.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ table_name: 'tenants', relrowsecurity: true, relforcerowsecurity: true }),
            expect.objectContaining({ table_name: 'module_revisions', relrowsecurity: true, relforcerowsecurity: true }),
            expect.objectContaining({ table_name: 'service_desk_users', relrowsecurity: true, relforcerowsecurity: true }),
            expect.objectContaining({ table_name: 'service_desk_tickets', relrowsecurity: true, relforcerowsecurity: true }),
            expect.objectContaining({ table_name: 'service_desk_audit', relrowsecurity: true, relforcerowsecurity: true })
        ]));

        const lifecycleTables = await ownerPool.query(
            `SELECT relname AS table_name, relrowsecurity, relforcerowsecurity
            FROM pg_class
            JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
            WHERE pg_namespace.nspname = 'nofries'
              AND pg_class.relkind = 'r'
              AND relname ~ '^lifecycle_'
            ORDER BY relname`
        );
        expect(lifecycleTables.rows.map((row) => row.table_name)).toEqual(LIFECYCLE_TABLES);
        expect(lifecycleTables.rows).toHaveLength(18);
        for (const table of lifecycleTables.rows) {
            expect(table).toEqual(expect.objectContaining({
                relrowsecurity: true,
                relforcerowsecurity: true
            }));
        }
    });

    test('uses tenant-bearing primary keys and a restricted NOLOGIN runtime role', async () => {
        const constraints = await ownerPool.query(
            `SELECT c.relname AS table_name, k.contype, pg_get_constraintdef(k.oid) AS definition
            FROM pg_constraint AS k
            JOIN pg_class AS c ON c.oid = k.conrelid
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'nofries'
              AND c.relname = ANY($1::text[])
              AND k.contype IN ('p', 'u', 'f')
            ORDER BY c.relname, k.contype, k.conname`,
            [[
                'tenants',
                'module_revisions',
                'service_desk_users',
                'service_desk_tickets',
                'service_desk_audit'
            ]]
        );
        for (const constraint of constraints.rows) {
            expect(constraint.definition).toMatch(
                /^(?:PRIMARY KEY|UNIQUE|FOREIGN KEY) \(tenant_id(?:,|\))/
            );
        }

        const idempotencyIndex = await ownerPool.query(
            `SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'nofries'
              AND indexname = 'service_desk_tickets_tenant_client_request_unique'`
        );
        expect(idempotencyIndex.rows).toHaveLength(1);
        expect(idempotencyIndex.rows[0].indexdef).toContain('(tenant_id, client_request_id)');
        expect(idempotencyIndex.rows[0].indexdef).toMatch(
            /WHERE \(client_request_id IS NOT NULL\)$/
        );

        const role = await ownerPool.query(
            `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls
            FROM pg_roles
            WHERE rolname = 'nofries_runtime'`
        );
        expect(role.rows).toEqual([{
            rolcanlogin: false,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false
        }]);

        const privileges = await ownerPool.query(
            `SELECT
                has_schema_privilege('nofries_runtime', 'nofries', 'USAGE') AS schema_usage,
                has_schema_privilege('nofries_runtime', 'nofries', 'CREATE') AS schema_create,
                has_database_privilege('nofries_runtime', current_database(), 'CREATE') AS database_create,
                has_database_privilege('nofries_runtime', current_database(), 'TEMPORARY') AS database_temporary,
                has_table_privilege('nofries_runtime', 'nofries.service_desk_audit', 'SELECT') AS audit_select,
                has_table_privilege('nofries_runtime', 'nofries.service_desk_audit', 'INSERT') AS audit_insert,
                has_table_privilege('nofries_runtime', 'nofries.service_desk_audit', 'UPDATE') AS audit_update,
                has_table_privilege('nofries_runtime', 'nofries.service_desk_audit', 'DELETE') AS audit_delete,
                has_table_privilege('nofries_runtime', 'nofries.schema_migrations', 'INSERT') AS migration_insert,
                has_sequence_privilege(
                    'nofries_runtime',
                    'nofries.service_desk_audit_sequence_no_seq',
                    'USAGE'
                ) AS audit_sequence_usage,
                has_sequence_privilege(
                    'nofries_runtime',
                    'nofries.service_desk_audit_sequence_no_seq',
                    'SELECT'
                ) AS audit_sequence_select`
        );
        expect(privileges.rows).toEqual([{
            schema_usage: true,
            schema_create: false,
            database_create: false,
            database_temporary: false,
            audit_select: true,
            audit_insert: true,
            audit_update: false,
            audit_delete: false,
            migration_insert: false,
            audit_sequence_usage: true,
            audit_sequence_select: false
        }]);
    });

    test('keeps every Lifecycle relational identity and uniqueness boundary tenant-leading', async () => {
        const constraints = await ownerPool.query(
            `SELECT c.relname AS table_name, k.contype,
                pg_get_constraintdef(k.oid) AS definition
            FROM pg_constraint AS k
            JOIN pg_class AS c ON c.oid = k.conrelid
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'nofries'
              AND c.relname = ANY($1::text[])
              AND k.contype IN ('p', 'u', 'f')
            ORDER BY c.relname, k.contype, k.conname`,
            [LIFECYCLE_TABLES]
        );
        expect(constraints.rows.length).toBeGreaterThan(LIFECYCLE_TABLES.length);
        expect(new Set(constraints.rows.map((row) => row.table_name))).toEqual(
            new Set(LIFECYCLE_TABLES)
        );
        for (const constraint of constraints.rows) {
            expect(constraint.definition.replace(/"/g, '')).toMatch(
                /^(?:PRIMARY KEY|UNIQUE|FOREIGN KEY) \(tenant_key(?:,|\))/
            );
        }
        expect(constraints.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                table_name: 'lifecycle_schedules',
                contype: 'f',
                definition: expect.stringMatching(
                    /FOREIGN KEY \(tenant_key, organisation_id\).*lifecycle_organisations.*ON DELETE CASCADE/
                )
            })
        ]));

        const uniqueIndexes = await ownerPool.query(
            `SELECT tablename, indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'nofries'
              AND tablename = ANY($1::text[])
              AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
            ORDER BY tablename, indexname`,
            [LIFECYCLE_TABLES]
        );
        expect(uniqueIndexes.rows.length).toBeGreaterThan(LIFECYCLE_TABLES.length);
        for (const index of uniqueIndexes.rows) {
            expect(normaliseIndexDefinition(index.indexdef)).toMatch(
                /\busing btree \(tenant_key(?:,|\))/
            );
        }

        const indexesByName = new Map(uniqueIndexes.rows.map((index) => [
            index.indexname,
            normaliseIndexDefinition(index.indexdef)
        ]));
        for (const [indexName, columns] of Object.entries(LIFECYCLE_CLAIM_INDEXES)) {
            expect(indexesByName.has(indexName)).toBe(true);
            expect(indexesByName.get(indexName)).toContain(columns);
        }

        expect(indexesByName.get('lifecycle_users_tenant_subject_unique')).toMatch(
            /\bwhere\b.*subject_key.*is not null/
        );
        for (const [indexName, nullableClaimColumn] of Object.entries({
            lifecycle_organisations_datto_site_uid_unique: 'datto_rmm_site_uid',
            lifecycle_organisations_datto_site_name_key_unique: 'datto_rmm_site_name_key',
            lifecycle_organisations_datto_claim_id_unique: 'datto_rmm_provisioning_claim_id'
        })) {
            expect(indexesByName.get(indexName)).toMatch(
                new RegExp(`\\bwhere\\b.*${nullableClaimColumn}.*is not null`)
            );
        }
        expect(indexesByName.get('lifecycle_conversations_tenant_session_unique')).toMatch(
            /\bwhere\b.*session_hash.*> 0/
        );
        for (const indexName of [
            'lifecycle_external_references_active_claim_unique',
            'lifecycle_external_references_active_slot_unique'
        ]) {
            expect(indexesByName.get(indexName)).toMatch(
                /\bwhere\b.*claim_status.*<>.*retired/
            );
        }
    });

    test('rejects schedules without a governed organisation and job type', async () => {
        await expectLifecycleScheduleInsertFailure(runtimePool, tenantA.tenant.key, {
            scheduleId: `schedule_null_organisation_${runKey}`,
            organisationId: null,
            jobType: 'monthly_proof'
        }, '23502');
        await expectLifecycleScheduleInsertFailure(runtimePool, tenantA.tenant.key, {
            scheduleId: `schedule_null_job_${runKey}`,
            organisationId: sharedOrganisationId,
            jobType: null
        }, '23502');
        await expectLifecycleScheduleInsertFailure(runtimePool, tenantA.tenant.key, {
            scheduleId: `schedule_unknown_organisation_${runKey}`,
            organisationId: `organisation_missing_${runKey}`,
            jobType: 'monthly_proof'
        }, '23503');
    });

    test('limits Lifecycle immutable evidence and migration control privileges', async () => {
        const privileges = await ownerPool.query(
            `SELECT
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_audit', 'SELECT') AS audit_select,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_audit', 'INSERT') AS audit_insert,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_audit', 'UPDATE') AS audit_update,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_audit', 'DELETE') AS audit_delete,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_inbox_receipts', 'SELECT') AS receipt_select,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_inbox_receipts', 'INSERT') AS receipt_insert,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_inbox_receipts', 'UPDATE') AS receipt_update,
                has_table_privilege('nofries_runtime', 'nofries.lifecycle_inbox_receipts', 'DELETE') AS receipt_delete,
                has_column_privilege(
                    'nofries_runtime', 'nofries.lifecycle_inbox_receipts',
                    'rematerialized_at', 'UPDATE'
                ) AS receipt_rematerialized_at_update,
                has_column_privilege(
                    'nofries_runtime', 'nofries.lifecycle_inbox_receipts',
                    'rematerialized_by', 'UPDATE'
                ) AS receipt_rematerialized_by_update,
                has_column_privilege(
                    'nofries_runtime', 'nofries.lifecycle_inbox_receipts',
                    'payload_hash', 'UPDATE'
                ) AS receipt_payload_hash_update,
                has_table_privilege('nofries_runtime', 'nofries.tenants', 'DELETE') AS tenants_delete,
                has_table_privilege('nofries_runtime', 'nofries.module_revisions', 'DELETE') AS revisions_delete,
                has_table_privilege('nofries_runtime', 'nofries.schema_migrations', 'SELECT') AS migration_select,
                has_table_privilege('nofries_runtime', 'nofries.schema_migrations', 'INSERT') AS migration_insert,
                has_table_privilege('nofries_runtime', 'nofries.schema_migrations', 'UPDATE') AS migration_update,
                has_table_privilege('nofries_runtime', 'nofries.schema_migrations', 'DELETE') AS migration_delete`
        );
        expect(privileges.rows).toEqual([{
            audit_select: true,
            audit_insert: true,
            audit_update: false,
            audit_delete: false,
            receipt_select: true,
            receipt_insert: true,
            receipt_update: false,
            receipt_delete: false,
            receipt_rematerialized_at_update: true,
            receipt_rematerialized_by_update: true,
            receipt_payload_hash_update: false,
            tenants_delete: false,
            revisions_delete: false,
            migration_select: false,
            migration_insert: false,
            migration_update: false,
            migration_delete: false
        }]);

        await expect(runtimePool.query(
            'SELECT migration_id FROM nofries.schema_migrations LIMIT 1'
        )).rejects.toMatchObject({ code: '42501' });
    });

    test('reuses one pooled connection for tenant A, tenant B and no context without leakage', async () => {
        const client = await runtimePool.connect();
        try {
            const backend = await client.query('SELECT pg_backend_pid() AS pid');
            const tenantARows = await tenantTicketRows(client, tenantA.tenant.key);
            const tenantBRows = await tenantTicketRows(client, tenantB.tenant.key);
            const noContextRows = await tenantTicketRows(client, null);
            const sameBackend = await client.query('SELECT pg_backend_pid() AS pid');

            expect(sameBackend.rows[0].pid).toBe(backend.rows[0].pid);
            expect(tenantARows).toEqual([{
                tenant_id: tenantA.tenant.key,
                ticket_id: sharedTicketId,
                summary: 'Visible only to tenant A'
            }]);
            expect(tenantBRows).toEqual([{
                tenant_id: tenantB.tenant.key,
                ticket_id: sharedTicketId,
                summary: 'Visible only to tenant B'
            }]);
            expect(noContextRows).toEqual([]);
        } finally {
            client.release();
        }
    });

    test('reuses one pooled connection for Lifecycle tenant A, tenant B and no context without leakage', async () => {
        const client = await runtimePool.connect();
        try {
            const backend = await client.query('SELECT pg_backend_pid() AS pid');
            const tenantARows = await tenantLifecycleOrganisationRows(
                client,
                tenantA.tenant.key
            );
            const tenantBRows = await tenantLifecycleOrganisationRows(
                client,
                tenantB.tenant.key
            );
            const noContextRows = await tenantLifecycleOrganisationRows(client, null);
            const sameBackend = await client.query('SELECT pg_backend_pid() AS pid');

            expect(sameBackend.rows[0].pid).toBe(backend.rows[0].pid);
            expect(tenantARows).toEqual([{
                tenant_key: tenantA.tenant.key,
                organisation_id: sharedOrganisationId,
                name: 'Lifecycle organisation visible only to tenant A'
            }]);
            expect(tenantBRows).toEqual([{
                tenant_key: tenantB.tenant.key,
                organisation_id: sharedOrganisationId,
                name: 'Lifecycle organisation visible only to tenant B'
            }]);
            expect(noContextRows).toEqual([]);
        } finally {
            client.release();
        }
    });

    test('rejects a cross-tenant write even when the caller supplies another tenant ID', async () => {
        const client = await runtimePool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantA.tenant.key]);
            await expect(client.query(
                `INSERT INTO nofries.service_desk_tickets (
                    tenant_id, ticket_id, client_request_id, customer_id, status,
                    created_at, updated_at, payload
                ) VALUES ($1, $2, NULL, $3, 'new', now(), now(), '{}'::jsonb)`,
                [
                    tenantB.tenant.key,
                    `ticket_cross_tenant_${runKey}`,
                    `customer_cross_tenant_${runKey}`
                ]
            )).rejects.toMatchObject({ code: '42501' });
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }

        const tenantBState = await repository.read(tenantB);
        expect(tenantBState.tickets.map((item) => item.id)).toEqual([sharedTicketId]);
    });

    test('rejects a forged cross-tenant Lifecycle insert', async () => {
        const client = await runtimePool.connect();
        const forgedOrganisationId = `organisation_cross_tenant_${runKey}`;
        try {
            await client.query('BEGIN');
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantA.tenant.key]);
            await expect(client.query(
                `INSERT INTO nofries.lifecycle_organisations (
                    tenant_key, organisation_id, sequence_no, payload
                ) VALUES ($1, $2, $3, $4::jsonb)`,
                [
                    tenantB.tenant.key,
                    forgedOrganisationId,
                    1,
                    JSON.stringify({ name: 'Forged cross-tenant organisation' })
                ]
            )).rejects.toMatchObject({ code: '42501' });
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }

        const clientForReadback = await runtimePool.connect();
        try {
            const tenantBRows = await tenantLifecycleOrganisationRows(
                clientForReadback,
                tenantB.tenant.key
            );
            expect(tenantBRows.map((row) => row.organisation_id)).toEqual([
                sharedOrganisationId
            ]);
        } finally {
            clientForReadback.release();
        }
    });
});

async function tenantTicketRows(client, tenantId) {
    await client.query('BEGIN');
    try {
        if (tenantId) {
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
        }
        const result = await client.query(
            `SELECT tenant_id, ticket_id, payload->>'summary' AS summary
            FROM nofries.service_desk_tickets
            ORDER BY tenant_id, ticket_id`
        );
        await client.query('COMMIT');
        return result.rows;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original PostgreSQL error for the test assertion.
        }
        throw error;
    }
}

async function seedLifecycleOrganisation(client, tenantId, organisationId, name) {
    await client.query('BEGIN');
    try {
        await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
        await client.query(
            `INSERT INTO nofries.lifecycle_organisations (
                tenant_key, organisation_id, sequence_no, payload
            ) VALUES ($1, $2, 0, $3::jsonb)`,
            [tenantId, organisationId, JSON.stringify({ name })]
        );
        await client.query('COMMIT');
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original PostgreSQL error for the test assertion.
        }
        throw error;
    }
}

async function expectLifecycleScheduleInsertFailure(pool, tenantId, value, expectedCode) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
        const error = await client.query(
            `INSERT INTO nofries.lifecycle_schedules (
                tenant_key, schedule_id, sequence_no, organisation_id, job_type, payload
            ) VALUES ($1, $2, 999, $3, $4, '{}'::jsonb)`,
            [tenantId, value.scheduleId, value.organisationId, value.jobType]
        ).then(() => null, (caught) => caught);
        expect(error).toMatchObject({ code: expectedCode });
    } finally {
        try {
            await client.query('ROLLBACK');
        } catch {
            // The assertion preserves the original database failure.
        }
        client.release();
    }
}

async function tenantLifecycleOrganisationRows(client, tenantId) {
    await client.query('BEGIN');
    try {
        if (tenantId) {
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
        }
        const result = await client.query(
            `SELECT tenant_key, organisation_id, payload->>'name' AS name
            FROM nofries.lifecycle_organisations
            ORDER BY tenant_key, organisation_id`
        );
        await client.query('COMMIT');
        return result.rows;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original PostgreSQL error for the test assertion.
        }
        throw error;
    }
}

function normaliseIndexDefinition(value) {
    return String(value || '')
        .replace(/"/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function access(label) {
    const identity = `${runKey}:${label}`;
    return {
        allowed: true,
        tenant: {
            id: `tenant-${identity}`,
            key: crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32),
            name: `PostgreSQL RLS test ${label}`,
            slug: `postgres-rls-${label}`
        },
        user: {
            email: `${label}@example.test`,
            name: `Test ${label}`,
            role: 'admin',
            capabilities: []
        }
    };
}

function ticket(accessValue, id, summary) {
    const now = new Date().toISOString();
    return {
        id,
        tenantId: accessValue.tenant.id,
        tenantKey: accessValue.tenant.key,
        clientRequestId: `request_${accessValue.tenant.key}`,
        customer: { id: `customer_${accessValue.tenant.key}`, name: 'Synthetic customer' },
        status: 'new',
        summary,
        createdAt: now,
        updatedAt: now
    };
}

function mutationOptions(expectedRevision, ticketId) {
    return {
        expectedRevision,
        auditEvents: [{
            actorType: 'user',
            actorId: 'postgres-rls-test-user',
            actorRole: 'admin',
            action: 'ticket.created',
            targetType: 'ticket',
            targetId: ticketId,
            ticketId,
            summary: 'Created during PostgreSQL RLS verification'
        }]
    };
}

function databaseUrlForRole(value, username, password) {
    const parsed = new URL(value);
    parsed.username = username;
    parsed.password = password;
    return parsed.toString();
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function migrationLedgerClient() {
    let recordedChecksum = '';
    return {
        query: jest.fn(async (text, params = []) => {
            const sql = String(text).trim();
            if (sql.startsWith('SELECT checksum_sha256')) {
                return {
                    rows: recordedChecksum ? [{ checksum_sha256: recordedChecksum }] : []
                };
            }
            if (sql.startsWith('INSERT INTO nofries.schema_migrations')) {
                recordedChecksum = String(params[1] || '');
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        })
    };
}
