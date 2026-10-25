'use strict';

// Registered by postgresMigration.test.js so the existing real PostgreSQL gate
// executes these contracts. All identities and recovery data are synthetic.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createPostgresDatabase, PostgresDatabaseError } = require('../../api/shared/database/postgres');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createBootstrapOperations } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { normaliseEntitlementState } = require('../../api/shared/appLifecycle/entitlementDomain');
const { fixture, NOW, SUBJECT } = require('../fixtures/dashboardFixture');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const TABLES = Object.freeze(['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states',
    'dashboard_entitlement_states', 'dashboard_feature_flags', 'dashboard_advisor_assignments',
    'dashboard_usage', 'dashboard_operation_receipts']);
const EMPTY_REVISIONS = Object.freeze({ tenant: null, organisation: null, membership: null,
    entitlement: null, flags: null, advisorAssignments: [], usage: [] });
const PRINCIPAL = Object.freeze({ authenticated: true, subjectKey: SUBJECT });
const clone = value => JSON.parse(JSON.stringify(value));
const capture = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

module.exports = function registerDashboardPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    const describeDatabase = testUrl ? describe : describe.skip;
    describeDatabase('Canonical dashboard persistence in real PostgreSQL', () => {
        const runKey = crypto.randomBytes(8).toString('hex');
        const role = `nofries_dashboard_test_${runKey}`;
        const password = `synthetic-only-${runKey}`;
        const applicationName = `dashboard-contract-${runKey}`;
        const recoveryName = `nofries_dashboard_restore_${runKey}`;
        const createdTenants = [];
        const createdLegacyTenants = [];
        let ownerPool, runtimePool, database, repository, recoveryOwner, recoveryRuntime;
        let closeRecoveryOwner, closeRecoveryRuntime;
        let recoveryCreated = false, roleCreated = false, sequence = 0;
        let clockNow = NOW;

        function makeRepository(db = database, authoriseAdministration = () => true) {
            return createPostgresDashboardRepository({ database: db, clock: () => clockNow, authoriseAdministration });
        }
        function command(scope, type, expectedRevisions, payload, operationId = `operation-${++sequence}`) {
            return { ...scope, operationId, actorSubjectKey: SUBJECT, type,
                expectedRevisions: clone(expectedRevisions), payload: clone(payload) };
        }
        function reservation(seed, operationId) {
            return command(seed.scope, 'usage.reserve', seed.vector, { grantId: 'synthetic-product',
                moduleId: 'cyber_security', limit: 'assessment_runs', amount: 1,
                framework: { profileId: 'synthetic-cyber_security', version: '1.0' } }, operationId);
        }
        async function seed(options = {}) {
            const tenantId = `dashboard-${runKey}-${++sequence}`;
            const example = replaceTenant(fixture({ role: options.role || 'admin', service: options.service, organisationId: 'shared-organisation' }), tenantId);
            example.entitlementState.grants[0].limits.assessment_runs = options.capacity || 1;
            for (const grant of example.entitlementState.grants) {
                grant.modules.sort(); grant.coverage.sort(); grant.actions.sort();
                grant.frameworks.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
            }
            example.entitlementState.grants.sort((a, b) => a.grantId.localeCompare(b.grantId));
            if (options.grantEndsAt) example.entitlementState.grants[0].validUntil = options.grantEndsAt;
            if (options.serviceEndsAt) example.entitlementState.grants.find(grant => grant.code === options.service).validUntil = options.serviceEndsAt;
            const state = { tenantAggregate: example.tenantAggregate, membershipState: example.membershipState,
                entitlementState: example.entitlementState, flags: example.flags,
                advisorAssignments: Object.values(example.advisorAssignments) };
            if (options.withAdvisor && !state.advisorAssignments.length) {
                state.advisorAssignments = Object.values(replaceTenant(fixture({ role: 'fractional_advisor',
                    organisationId: 'shared-organisation' }), tenantId).advisorAssignments);
            }
            if (options.role === 'fractional_advisor') state.advisorAssignments[0].permissions.push('assessment.write');
            const scope = { tenantId, organisationId: 'shared-organisation' };
            createdTenants.push(tenantId);
            const initialCommand = command(scope, 'organisation.initialise', EMPTY_REVISIONS, {});
            const result = await repository.initialiseOrganisation(initialCommand, state);
            return { scope, state, initialCommand, vector: result.resultRevisions, result };
        }
        function uncommittedBootstrap() {
            const tenantId = `dashboard-${runKey}-${++sequence}`;
            const example = replaceTenant(fixture({ role: 'fractional_advisor', service: 'fractional_advisory',
                organisationId: 'shared-organisation' }), tenantId);
            const scope = { tenantId, organisationId: 'shared-organisation' };
            const state = { tenantAggregate: example.tenantAggregate, membershipState: example.membershipState,
                entitlementState: normaliseEntitlementState(example.entitlementState, example.tenantAggregate),
                flags: example.flags, advisorAssignments: Object.values(example.advisorAssignments) };
            createdTenants.push(tenantId);
            return { scope, state, initialCommand: command(scope, 'organisation.initialise', EMPTY_REVISIONS, {}) };
        }
        function bootstrapReference(receipt) {
            return { schemaVersion: 1, operationType: 'organisation.initialise', tenantId: receipt.tenantId,
                organisationId: receipt.organisationId, operationId: receipt.operationId,
                intentSha256: receipt.intentSha256, resultSha256: receipt.resultSha256 };
        }
        async function rawTransaction(scope, work, pool = runtimePool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                if (scope) await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [scope.tenantId]);
                return await work(client);
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        }
        async function usageOf(scope, pool = ownerPool) {
            const result = await pool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id = $1 AND organisation_id = $2',
                [scope.tenantId, scope.organisationId]);
            return result.rows[0]?.payload;
        }
        async function receiptRows(scope, pool = ownerPool) {
            return (await pool.query('SELECT payload FROM nofries.dashboard_operation_receipts WHERE tenant_id = $1 AND organisation_id = $2 ORDER BY operation_id',
                [scope.tenantId, scope.organisationId])).rows.map(row => row.payload);
        }
        async function expectNoReservation(scope) {
            expect((await usageOf(scope)).counters.assessment_runs).toBe(0);
            expect((await receiptRows(scope)).filter(row => row.operationType === 'usage.reserve')).toEqual([]);
        }
        async function waitForBlockedTenantQuery() {
            const deadline = Date.now() + 5000;
            do {
                const result = await ownerPool.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%dashboard_tenants%'", [applicationName]);
                if (result.rows[0].count > 0) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            } while (Date.now() < deadline);
            throw new Error('The competing dashboard transaction did not reach its PostgreSQL tenant lock.');
        }
        async function holdingTenant(scope, work) {
            const client = await runtimePool.connect();
            try {
                await client.query('BEGIN');
                await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [scope.tenantId]);
                await client.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR UPDATE', [scope.tenantId]);
                return await work(client);
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        }
        async function updatePayload(client, table, scope, payload) {
            expect(TABLES).toContain(table);
            await client.query(`UPDATE nofries.${table} SET revision = $3, payload = $4::jsonb WHERE tenant_id = $1 AND organisation_id = $2`,
                [scope.tenantId, scope.organisationId, payload.revision, JSON.stringify(payload)]);
        }

        beforeAll(async () => {
            const { Pool } = require('pg');
            ownerPool = new Pool({ connectionString: testUrl, max: 3, application_name: `dashboard-owner-${runKey}` });
            await applyMigrations({ pool: ownerPool });
            await ownerPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
            roleCreated = true;
            await ownerPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(role)}`);
            runtimePool = new Pool({ connectionString: databaseUrl(testUrl, { username: role, password }),
                max: 6, application_name: applicationName, statement_timeout: 10000 });
            database = createPostgresDatabase({ pool: runtimePool });
            repository = makeRepository();
        });
        beforeEach(() => { clockNow = NOW; });
        afterAll(async () => {
            if (closeRecoveryRuntime) await closeRecoveryRuntime();
            if (closeRecoveryOwner) await closeRecoveryOwner();
            if (runtimePool) await runtimePool.end();
            if (ownerPool) {
                try {
                    if (recoveryCreated) await ownerPool.query(`DROP DATABASE ${quoteIdentifier(recoveryName)}`);
                    for (const table of [...TABLES].reverse()) {
                        await ownerPool.query(`DELETE FROM nofries.${table} WHERE tenant_id = ANY($1::text[])`, [createdTenants]);
                    }
                    await ownerPool.query('DELETE FROM nofries.tenants WHERE tenant_id = ANY($1::text[])', [createdLegacyTenants]);
                    if (roleCreated) await ownerPool.query(`DROP ROLE ${quoteIdentifier(role)}`);
                } finally { await ownerPool.end(); }
            }
        });

        test('versions the new schema idempotently and forces RLS for a non-owner, non-bypass runtime role', async () => {
            expect((await applyMigrations({ pool: ownerPool })).applied).toEqual([]);
            const checksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../database/migrations/0003_dashboard.sql'))).digest('hex');
            expect((await ownerPool.query("SELECT checksum_sha256 FROM nofries.schema_migrations WHERE migration_id = '0003_dashboard.sql'")).rows).toEqual([{ checksum_sha256: checksum }]);
            const relations = await ownerPool.query("SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'nofries' AND c.relname = ANY($1::text[]) ORDER BY c.relname", [TABLES]);
            expect(relations.rows).toHaveLength(8);
            for (const row of relations.rows) {
                expect(row.relrowsecurity).toBe(true); expect(row.relforcerowsecurity).toBe(true);
                expect(row.owner).not.toBe(role);
            }
            expect((await runtimePool.query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows).toEqual([
                { rolsuper: false, rolbypassrls: false, rolcreaterole: false }
            ]);
            const foreignKeys = await ownerPool.query("SELECT target.relname FROM pg_constraint k JOIN pg_class source ON source.oid = k.conrelid JOIN pg_class target ON target.oid = k.confrelid WHERE k.contype = 'f' AND source.relname = ANY($1::text[])", [TABLES]);
            expect(foreignKeys.rows).toHaveLength(7);
            for (const row of foreignKeys.rows) expect(['dashboard_tenants', 'dashboard_organisations']).toContain(row.relname);
        });

        test('round-trips canonical ownership and revisions without creating state on reads or mapping legacy keys', async () => {
            const current = await seed();
            const snapshot = await repository.readAdmissionSnapshot(current.scope, PRINCIPAL);
            expect(snapshot).toEqual({ ...current.state, advisorAssignments: {}, summary: null });
            expect(current.vector).toEqual({ tenant: 0, organisation: 0, membership: 2, entitlement: 1, flags: 1,
                advisorAssignments: [], usage: [{ grantId: 'synthetic-product', revision: 0 }] });
            expect(Object.isFrozen(snapshot)).toBe(true);
            expect(Object.isFrozen(snapshot.membershipState.memberships)).toBe(true);
            const missing = { tenantId: `missing-${runKey}`, organisationId: current.scope.organisationId };
            createdLegacyTenants.push(missing.tenantId);
            await ownerPool.query('INSERT INTO nofries.tenants (tenant_id,logical_id,tenant_key,name,slug) VALUES ($1,$2,$1,$3,$1)',
                [missing.tenantId, `different-logical-${runKey}`, 'Synthetic legacy record, never dashboard authority']);
            await expect(repository.readAdmissionSnapshot(missing, PRINCIPAL)).rejects.toMatchObject({ code: 'dashboard_not_found' });
            expect((await ownerPool.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id = $1', [missing.tenantId])).rows).toEqual([]);
            expect((await ownerPool.query('SELECT logical_id FROM nofries.tenants WHERE tenant_id = $1', [missing.tenantId])).rows).toEqual([{ logical_id: `different-logical-${runKey}` }]);
            expect((await ownerPool.query('SELECT tenant_id FROM nofries.tenants WHERE tenant_id = $1', [current.scope.tenantId])).rows).toEqual([]);
        });

        test('recovers the complete current revision vector after a repository restart through the trusted authority read', async () => {
            const current = await seed({ capacity: 2, withAdvisor: true });
            const first = await repository.reserveUsage(reservation(current));
            const restarted = makeRepository();
            const view = await restarted.readAuthoritySnapshot(current.scope, PRINCIPAL);
            expect(view.revisions).toEqual(first.resultRevisions);
            expect(view.snapshot.usage).toEqual([first.usage]);
            expect(view.snapshot.advisorAssignments).toEqual(current.state.advisorAssignments);
            expect(view.evaluatedAt).toBe(NOW);
            expect(Object.isFrozen(view.snapshot.usage)).toBe(true);
            await expect(makeRepository(database, () => false).readAuthoritySnapshot(current.scope, PRINCIPAL))
                .rejects.toMatchObject({ code: 'dashboard_administration_denied' });
            const nextRequest = reservation({ ...current, vector: view.revisions });
            expect((await restarted.reserveUsage(nextRequest)).usage.counters.assessment_runs).toBe(2);
        });

        test('isolates every table for two canonical tenants with identical organisation, grant, member and operation IDs', async () => {
            const a = await seed({ withAdvisor: true });
            const b = await seed({ withAdvisor: true });
            await repository.reserveUsage(reservation(a, 'same-operation'));
            await repository.reserveUsage(reservation(b, 'same-operation'));
            const client = await runtimePool.connect();
            try {
                for (const selected of [a, b, null]) {
                    await client.query('BEGIN');
                    if (selected) await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [selected.scope.tenantId]);
                    for (const table of TABLES) {
                        const visible = (await client.query(`SELECT tenant_id FROM nofries.${table}`)).rows;
                        if (selected) {
                            expect(visible.length).toBeGreaterThan(0);
                            expect(visible.every(row => row.tenant_id === selected.scope.tenantId)).toBe(true);
                            const other = selected === a ? b : a;
                            expect((await client.query(`SELECT tenant_id FROM nofries.${table} WHERE tenant_id = $1`, [other.scope.tenantId])).rows).toEqual([]);
                            if (table !== 'dashboard_operation_receipts') expect((await client.query(`UPDATE nofries.${table} SET payload=payload WHERE tenant_id=$1`, [other.scope.tenantId])).rowCount).toBe(0);
                        } else {
                            expect(visible).toEqual([]);
                            if (table !== 'dashboard_operation_receipts') expect((await client.query(`UPDATE nofries.${table} SET payload=payload`)).rowCount).toBe(0);
                        }
                    }
                    await client.query('COMMIT');
                }
            } finally { await client.query('ROLLBACK'); client.release(); }
            await expect(rawTransaction(a.scope, async tx => {
                const row = clone(b.state.tenantAggregate.tenant);
                row.tenantId = `cross-tenant-${runKey}`;
                await tx.query('INSERT INTO nofries.dashboard_tenants (tenant_id,schema_version,revision,payload) VALUES ($1,1,0,$2::jsonb)', [row.tenantId, JSON.stringify(row)]);
            })).rejects.toMatchObject({ code: '42501' });
        });

        test('rejects missing JSON fields, payload/column disagreement and cross-owner foreign keys in PostgreSQL', async () => {
            const current = await seed({ withAdvisor: true });
            for (const table of TABLES.filter(name => name !== 'dashboard_operation_receipts')) {
                for (const expression of ["'{}'::jsonb", "jsonb_set(payload, '{tenantId}', '\"wrong-owner\"'::jsonb)", "jsonb_set(payload, '{revision}', '99'::jsonb)"]) {
                    await expect(rawTransaction(current.scope, tx => tx.query(`UPDATE nofries.${table} SET payload = ${expression} WHERE tenant_id = $1`, [current.scope.tenantId])))
                        .rejects.toMatchObject({ code: '23514' });
                }
            }
            const orphan = clone(current.state.flags);
            orphan.organisationId = 'absent-organisation';
            await expect(rawTransaction(current.scope, tx => tx.query('INSERT INTO nofries.dashboard_feature_flags (tenant_id,organisation_id,schema_version,revision,payload) VALUES ($1,$2,1,$3,$4::jsonb)',
                [current.scope.tenantId, orphan.organisationId, orphan.revision, JSON.stringify(orphan)]))).rejects.toMatchObject({ code: '23503' });
        });

        test('serializes two concurrent last-unit reservations and stores one immutable reservation receipt', async () => {
            const current = await seed();
            const other = await seed();
            const outcomes = await Promise.all([capture(repository.reserveUsage(reservation(current, 'last-a'))),
                capture(makeRepository().reserveUsage(reservation(current, 'last-b')))]);
            expect(outcomes.filter(item => item.ok)).toHaveLength(1);
            expect(outcomes.filter(item => !item.ok)).toHaveLength(1);
            expect(outcomes.find(item => !item.ok).error.code).toBe('dashboard_revision_conflict');
            const usage = await usageOf(current.scope);
            expect(usage.revision).toBe(1); expect(usage.counters.assessment_runs).toBe(1);
            const receipts = (await receiptRows(current.scope)).filter(row => row.operationType === 'usage.reserve');
            expect(receipts).toHaveLength(1);
            expect(receipts[0].result).toEqual(outcomes.find(item => item.ok).value);
            expect(receipts[0].event).toEqual({ schemaVersion: 1, category: 'dashboard_transaction', outcome: 'committed',
                action: 'usage.reserve', actorSubjectKey: SUBJECT, ...current.scope,
                operationId: receipts[0].operationId, effect: 'quota_reserved' });
            const currentVector = outcomes.find(item => item.ok).value.resultRevisions;
            await expect(repository.reserveUsage(reservation({ ...current, vector: currentVector }, 'capacity-exhausted')))
                .rejects.toMatchObject({ code: 'entitlement_limit_exceeded' });
            expect((await receiptRows(current.scope)).filter(row => row.operationType === 'usage.reserve')).toHaveLength(1);
            expect((await usageOf(other.scope)).counters.assessment_runs).toBe(0);
        });

        test('returns the original exact-retry result and rejects changed intent without consuming again', async () => {
            const current = await seed();
            const request = reservation(current, 'exact-retry');
            const result = await repository.reserveUsage(request);
            const flags = { ...clone(current.state.flags), revision: 2 };
            await repository.executeAuthorityCommand(command(current.scope, 'flags.update', result.resultRevisions, flags));
            expect(await repository.reserveUsage(request)).toEqual(result);
            const changed = clone(request); changed.payload.amount = 2;
            await expect(repository.reserveUsage(changed)).rejects.toMatchObject({ code: 'dashboard_operation_conflict' });
            expect((await usageOf(current.scope)).counters.assessment_runs).toBe(1);
            expect((await receiptRows(current.scope)).filter(row => row.operationType === 'usage.reserve')).toHaveLength(1);
        });

        test.each([
            ['tenant.transition', 'dashboard_tenants'], ['organisation.transition', 'dashboard_organisations'],
            ['membership.command', 'dashboard_membership_states'], ['entitlement.update', 'dashboard_entitlement_states'],
            ['flags.update', 'dashboard_feature_flags']
        ])('refuses a mixed-point restore with a %s receipt ahead of live authority', async (type, table) => {
            const current = await seed();
            const before = (await ownerPool.query(`SELECT payload FROM nofries.${table} WHERE tenant_id=$1`, [current.scope.tenantId])).rows[0].payload;
            const payloads = {
                'tenant.transition': { toStatus: 'suspended' }, 'organisation.transition': { toStatus: 'suspended' },
                'membership.command': { action: 'suspend', payload: { membershipId: 'synthetic-membership' } },
                'entitlement.update': { ...current.state.entitlementState, revision: 2 },
                'flags.update': { ...current.state.flags, revision: 2 }
            };
            const request = command(current.scope, type, current.vector, payloads[type]);
            await repository.executeAuthorityCommand(request);
            // The privileged test owner models restoring the state table from
            // an earlier backup point while retaining the newer receipt table.
            await ownerPool.query(`UPDATE nofries.${table} SET revision=$2,payload=$3::jsonb WHERE tenant_id=$1`,
                [current.scope.tenantId, before.revision, JSON.stringify(before)]);
            const restored = await exportTenant(ownerPool, current.scope.tenantId);
            await expect(makeRepository().executeAuthorityCommand(request)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(restored);
        });

        test.each(['olderRevision', 'sameRevisionCounter', 'laterRevisionCounter'])('refuses a mixed-point restore with %s behind its quota receipt', async kind => {
            const current = await seed({ capacity: 2 });
            const before = await usageOf(current.scope), request = reservation(current);
            const original = await repository.reserveUsage(request);
            if (kind === 'laterRevisionCounter') await repository.reserveUsage(reservation({ ...current, vector: original.resultRevisions }));
            const restoredUsage = kind === 'olderRevision' ? before : await usageOf(current.scope);
            restoredUsage.counters.assessment_runs = 0;
            await updatePayload(ownerPool, 'dashboard_usage', current.scope, restoredUsage);
            const restored = await exportTenant(ownerPool, current.scope.tenantId);
            await expect(makeRepository().reserveUsage(request)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(restored);
        });

        test.each(['missing', 'older'])('refuses bootstrap receipt replay with %s retained advisor evidence after restore', async kind => {
            const current = await seed({ withAdvisor: true });
            if (kind === 'missing') await ownerPool.query('DELETE FROM nofries.dashboard_advisor_assignments WHERE tenant_id=$1', [current.scope.tenantId]);
            else {
                const older = clone(current.state.advisorAssignments[0]); older.revision--;
                await updatePayload(ownerPool, 'dashboard_advisor_assignments', current.scope, older);
            }
            const restored = await exportTenant(ownerPool, current.scope.tenantId);
            await expect(makeRepository().initialiseOrganisation(current.initialCommand, current.state))
                .rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(restored);
        });

        test('requires every committed usage counter even when the replayed command consumed a different limit', async () => {
            const current = await seed();
            const evidence = command(current.scope, 'usage.reserve', current.vector,
                { grantId: 'synthetic-product', moduleId: 'evidence', limit: 'evidence_bytes', amount: 7, framework: null });
            const first = await repository.reserveUsage(evidence);
            const request = reservation({ ...current, vector: first.resultRevisions });
            await repository.reserveUsage(request);
            const restoredUsage = await usageOf(current.scope); restoredUsage.counters.evidence_bytes = 0;
            await updatePayload(ownerPool, 'dashboard_usage', current.scope, restoredUsage);
            await expect(makeRepository().reserveUsage(request)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
            expect(await usageOf(current.scope)).toEqual(restoredUsage);
        });

        test.each(['flags.update', 'organisation.initialise'])('rejects a rehashed %s receipt that contradicts its committed command transition', async type => {
            const current = await seed({ withAdvisor: true });
            let request = current.initialCommand;
            if (type === 'flags.update') {
                request = command(current.scope, type, current.vector, { ...current.state.flags, revision: 2 });
                await repository.executeAuthorityCommand(request);
                await updatePayload(ownerPool, 'dashboard_feature_flags', current.scope, current.state.flags);
            } else await ownerPool.query('DELETE FROM nofries.dashboard_advisor_assignments WHERE tenant_id=$1', [current.scope.tenantId]);
            const receipt = (await receiptRows(current.scope)).find(item => item.operationId === request.operationId);
            const vector = clone(current.vector);
            if (type === 'organisation.initialise') vector.advisorAssignments = [];
            receipt.resultRevisions = vector; receipt.result.resultRevisions = clone(vector);
            receipt.resultSha256 = crypto.createHash('sha256').update(stableJson(receipt.result)).digest('hex');
            await ownerPool.query('UPDATE nofries.dashboard_operation_receipts SET result_sha256=$3,payload=$4::jsonb WHERE tenant_id=$1 AND operation_id=$2',
                [current.scope.tenantId, request.operationId, receipt.resultSha256, JSON.stringify(receipt)]);
            const restored = await exportTenant(ownerPool, current.scope.tenantId);
            const replay = type === 'organisation.initialise' ? makeRepository().initialiseOrganisation(request, current.state)
                : makeRepository().executeAuthorityCommand(request);
            await expect(replay).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(restored);
        });

        test('replays original results after later authority revisions, retained records and usage without another mutation', async () => {
            const current = await seed({ capacity: 2, withAdvisor: true });
            const request = reservation(current), original = await repository.reserveUsage(request);
            const flags = { ...current.state.flags, revision: 2 };
            let result = await repository.executeAuthorityCommand(command(current.scope, 'flags.update', original.resultRevisions, flags));
            const advisor = { ...current.state.advisorAssignments[0], revision: current.state.advisorAssignments[0].revision + 1 };
            result = await repository.executeAuthorityCommand(command(current.scope, 'advisor.put', result.resultRevisions, advisor));
            const grants = [...current.state.entitlementState.grants,
                { ...current.state.entitlementState.grants[0], grantId: 'later-product', status: 'revoked' }];
            result = await repository.executeAuthorityCommand(command(current.scope, 'entitlement.update', result.resultRevisions,
                { ...current.state.entitlementState, revision: 2, grants }));
            await repository.reserveUsage(reservation({ ...current, vector: result.resultRevisions }));
            const advanced = await exportTenant(ownerPool, current.scope.tenantId);
            expect(await makeRepository().reserveUsage(request)).toEqual(original);
            expect(await makeRepository().initialiseOrganisation(current.initialCommand, current.state)).toEqual(current.result);
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(advanced);
        });

        test('reads one coherent current snapshot after a writer commits while the read waits for the tenant fence', async () => {
            const current = await seed();
            const nextFlags = clone(current.state.flags); nextFlags.revision++; nextFlags.enabled.cyber_security = false;
            let pending;
            await holdingTenant(current.scope, async blocker => {
                pending = capture(repository.readAdmissionSnapshot(current.scope, PRINCIPAL));
                await waitForBlockedTenantQuery();
                await updatePayload(blocker, 'dashboard_feature_flags', current.scope, nextFlags);
                await blocker.query('COMMIT');
            });
            const result = await pending;
            expect(result.ok).toBe(true); expect(result.value.flags).toEqual(nextFlags);
            expect(result.value.entitlementState).toEqual(current.state.entitlementState);
        });

        test('holds the read fence across all snapshot queries so a concurrent flag writer cannot tear the snapshot', async () => {
            const current = await seed();
            const locked = deferred(), release = deferred();
            const readDatabase = { withTenantTransaction: (tenantId, work) => database.withTenantTransaction(tenantId, tx => work({
                query: async (sql, params) => {
                    const result = await tx.query(sql, params);
                    if (sql.includes('dashboard_tenants') && sql.includes('FOR SHARE')) { locked.resolve(); await release.promise; }
                    return result;
                }
            })) };
            const pendingRead = capture(makeRepository(readDatabase).readAdmissionSnapshot(current.scope, PRINCIPAL));
            let pendingWrite;
            try {
                await locked.promise;
                const flags = clone(current.state.flags); flags.revision++; flags.enabled.cyber_security = false;
                pendingWrite = capture(repository.executeAuthorityCommand(command(current.scope, 'flags.update', current.vector, flags)));
                await waitForBlockedTenantQuery();
            } finally { release.resolve(); }
            const read = await pendingRead, write = await pendingWrite;
            expect(read.ok).toBe(true); expect(read.value.flags).toEqual(current.state.flags);
            expect(write.ok).toBe(true);
            expect((await repository.readAdmissionSnapshot(current.scope, PRINCIPAL)).flags.revision).toBe(2);
        });

        test.each(['membership', 'entitlement', 'flags', 'organisation', 'advisor'])('denies a reservation after current %s authority is revoked while waiting for the tenant lock', async kind => {
            const current = await seed(kind === 'advisor' ? { role: 'fractional_advisor', service: 'fractional_advisory' } : {});
            let pending;
            await holdingTenant(current.scope, async blocker => {
                pending = capture(repository.reserveUsage(reservation(current)));
                await waitForBlockedTenantQuery();
                if (kind === 'membership') {
                    const membership = applyMembershipCommand(current.state.membershipState, current.state.tenantAggregate,
                        { ...current.scope, expectedRevision: current.state.membershipState.revision, actorSubjectKey: SUBJECT,
                            now: NOW, action: 'remove', payload: { membershipId: 'synthetic-membership' } });
                    await updatePayload(blocker, 'dashboard_membership_states', current.scope, membership);
                } else if (kind === 'entitlement') {
                    const entitlement = clone(current.state.entitlementState); entitlement.revision++; entitlement.grants[0].status = 'revoked';
                    await updatePayload(blocker, 'dashboard_entitlement_states', current.scope, entitlement);
                } else if (kind === 'flags') {
                    const flags = clone(current.state.flags); flags.revision++; flags.enabled.cyber_security = false;
                    await updatePayload(blocker, 'dashboard_feature_flags', current.scope, flags);
                } else if (kind === 'organisation') {
                    const organisation = clone(current.state.tenantAggregate.organisations[0]); organisation.revision++; organisation.recordStatus = 'suspended';
                    await updatePayload(blocker, 'dashboard_organisations', current.scope, organisation);
                } else {
                    const assignment = clone(current.state.advisorAssignments[0]); assignment.revision++; assignment.status = 'revoked'; assignment.updatedAt = NOW;
                    await blocker.query('UPDATE nofries.dashboard_advisor_assignments SET revision=$3,status=$4,payload=$5::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                        [current.scope.tenantId, current.scope.organisationId, assignment.revision, assignment.status, JSON.stringify(assignment)]);
                }
                await blocker.query('COMMIT');
            });
            const result = await pending;
            expect(result.ok).toBe(false);
            const codes = { membership: 'membership_not_found', organisation: 'membership_organisation_inactive',
                entitlement: 'dashboard_quota_denied', flags: 'dashboard_quota_denied', advisor: 'portal_permission_denied' };
            expect(result.error.code).toBe(codes[kind]);
            await expectNoReservation(current.scope);
        });

        test('samples trusted time after the lock wait and denies an entitlement at its exclusive expiry boundary', async () => {
            const current = await seed({ grantEndsAt: '2026-09-06T10:00:00.000Z' });
            let pending;
            await holdingTenant(current.scope, async blocker => {
                pending = capture(repository.reserveUsage(reservation(current)));
                await waitForBlockedTenantQuery();
                clockNow = current.state.entitlementState.grants[0].validUntil;
                await blocker.query('COMMIT');
            });
            const result = await pending;
            expect(result.ok).toBe(false); expect(result.error.code).toBe('dashboard_quota_denied');
            await expectNoReservation(current.scope);
        });

        test('rechecks current authority before returning an old receipt after revocation', async () => {
            const current = await seed();
            const request = reservation(current, 'replay-after-revocation');
            const result = await repository.reserveUsage(request);
            const entitlement = clone(current.state.entitlementState); entitlement.revision++; entitlement.grants[0].status = 'revoked';
            await repository.executeAuthorityCommand(command(current.scope, 'entitlement.update', result.resultRevisions, entitlement));
            await expect(repository.reserveUsage(request)).rejects.toMatchObject({ statusCode: 403 });
            expect((await usageOf(current.scope)).counters.assessment_runs).toBe(1);
        });

        test('advisor-only authority cannot reserve without a purchased advisory service', async () => {
            const current = await seed({ role: 'fractional_advisor' });
            await expect(repository.reserveUsage(reservation(current))).rejects.toMatchObject({ code: 'dashboard_quota_denied' });
            await expectNoReservation(current.scope);
        });

        test.each(['disabled', 'revoked', 'expired'])('rechecks current advisory service %s before replaying a committed advisor reservation', async mode => {
            const expiry = new Date(Date.parse(NOW) + 1000).toISOString();
            const current = await seed({ role: 'fractional_advisor', service: 'fractional_advisory', serviceEndsAt: expiry });
            const request = reservation(current), original = await repository.reserveUsage(request);
            expect(await repository.reserveUsage(request)).toEqual(original);
            if (mode === 'expired') clockNow = expiry;
            else if (mode === 'disabled') await repository.executeAuthorityCommand(command(current.scope, 'flags.update', original.resultRevisions,
                { ...current.state.flags, revision: 2, enabled: { ...current.state.flags.enabled, 'service:fractional_advisory': false } }));
            else await repository.executeAuthorityCommand(command(current.scope, 'entitlement.update', original.resultRevisions,
                { ...current.state.entitlementState, revision: 2, grants: current.state.entitlementState.grants.map(grant =>
                    grant.code === 'fractional_advisory' ? { ...grant, status: 'revoked' } : grant) }));
            await expect(repository.reserveUsage(request)).rejects.toMatchObject({ code: 'dashboard_quota_denied' });
            expect((await usageOf(current.scope)).counters.assessment_runs).toBe(1);
        });

        test.each(['false', 'throw', 'promise'])('rolls back authority changes when the trusted administrator callback returns %s', async mode => {
            const current = await seed();
            const flags = clone(current.state.flags); flags.revision++;
            const authorise = mode === 'throw' ? () => { throw new Error('Synthetic denial'); }
                : mode === 'promise' ? () => Promise.resolve(true) : () => false;
            await expect(makeRepository(database, authorise).executeAuthorityCommand(command(current.scope, 'flags.update', current.vector, flags)))
                .rejects.toMatchObject({ code: 'dashboard_administration_denied' });
            expect((await repository.readAdmissionSnapshot(current.scope, PRINCIPAL)).flags).toEqual(current.state.flags);
            expect(await receiptRows(current.scope)).toHaveLength(1);
        });

        test('rolls back both the reservation and its receipt when the transaction fails before COMMIT', async () => {
            const current = await seed();
            const request = reservation(current, 'rollback-reservation');
            const broken = { withTenantTransaction: (tenantId, work) => database.withTenantTransaction(tenantId, async tx => {
                await work(tx);
                throw new PostgresDatabaseError('postgres_query_failed');
            }) };
            await expect(makeRepository(broken).reserveUsage(request)).rejects.toMatchObject({ code: 'postgres_query_failed' });
            await expectNoReservation(current.scope);
            expect((await repository.reserveUsage(request)).usage.counters.assessment_runs).toBe(1);
        });

        test.each(['committed', 'not-committed', 'reconciliation-unavailable'])('preserves the same operation identity across an ambiguous COMMIT: %s', async mode => {
            const current = await seed();
            const request = reservation(current, `ambiguous-${mode}`);
            let calls = 0;
            const uncertain = { withTenantTransaction: async (tenantId, work) => {
                calls++;
                if (calls === 1) {
                    if (mode !== 'not-committed') await database.withTenantTransaction(tenantId, work);
                    throw new PostgresDatabaseError('postgres_commit_failed');
                }
                if (mode === 'reconciliation-unavailable') throw new PostgresDatabaseError('postgres_connection_failed');
                return database.withTenantTransaction(tenantId, work);
            } };
            const attempt = await capture(makeRepository(uncertain).reserveUsage(request));
            expect(calls).toBe(2);
            if (mode === 'committed') expect(attempt.ok).toBe(true);
            else { expect(attempt.ok).toBe(false); expect(attempt.error.code).toBe('dashboard_commit_ambiguous'); }
            if (mode === 'not-committed') await expectNoReservation(current.scope);
            else expect((await usageOf(current.scope)).counters.assessment_runs).toBe(1);
            const recovered = await repository.reserveUsage(request);
            expect(recovered.usage.counters.assessment_runs).toBe(1);
            if (attempt.ok) expect(recovered).toEqual(attempt.value);
            expect((await receiptRows(current.scope)).filter(row => row.operationType === 'usage.reserve')).toHaveLength(1);
            expect((await usageOf(current.scope)).revision).toBe(1);
        });

        test('does not create an absent organisation while reconciling a failed bootstrap under an existing tenant', async () => {
            const current = await seed();
            const secondScope = { ...current.scope, organisationId: 'second-organisation' };
            const initial = replaceOrganisation(current.state, secondScope.organisationId);
            const request = command(secondScope, 'organisation.initialise', { ...EMPTY_REVISIONS, tenant: 0 }, {}, 'ambiguous-bootstrap');
            const before = await exportTenant(ownerPool, current.scope.tenantId), recoveryQueries = [];
            let calls = 0;
            const uncertain = { withTenantTransaction: (tenantId, work) => {
                if (++calls === 1) return Promise.reject(new PostgresDatabaseError('postgres_commit_failed'));
                return database.withTenantTransaction(tenantId, tx => work({ query: async (sql, args) => {
                    recoveryQueries.push(sql); return tx.query(sql, args);
                } }));
            } };
            await expect(makeRepository(uncertain).initialiseOrganisation(request, initial))
                .rejects.toMatchObject({ code: 'dashboard_commit_ambiguous' });
            expect(calls).toBe(2);
            expect((await ownerPool.query('SELECT organisation_id FROM nofries.dashboard_organisations WHERE tenant_id=$1 AND organisation_id=$2',
                [secondScope.tenantId, secondScope.organisationId])).rows).toEqual([]);
            expect(await receiptRows(secondScope)).toEqual([]);
            expect(recoveryQueries.length).toBeGreaterThan(0);
            expect(recoveryQueries.every(sql => sql.startsWith('SELECT'))).toBe(true);
            expect(await exportTenant(ownerPool, current.scope.tenantId)).toEqual(before);
            const explicitRetry = await repository.initialiseOrganisation(request, initial);
            expect(explicitRetry.resultRevisions.usage).toEqual([{ grantId: 'synthetic-product', revision: 0 }]);
            expect(await repository.initialiseOrganisation(request, initial)).toEqual(explicitRetry);
        });

        test.each(['new tenant', 'existing tenant'])('private bootstrap participates in the caller transaction and completely rolls back under a %s', async mode => {
            const existing = mode === 'existing tenant' ? await seed({ withAdvisor: true }) : null;
            const candidate = existing ? {
                scope: { ...existing.scope, organisationId: 'caller-owned-second-org' },
                state: replaceOrganisation(existing.state, 'caller-owned-second-org')
            } : uncommittedBootstrap();
            if (existing) candidate.initialCommand = command(candidate.scope, 'organisation.initialise',
                { ...EMPTY_REVISIONS, tenant: existing.vector.tenant }, {});
            const operations = createBootstrapOperations({ clock: () => clockNow, authoriseAdministration: () => true });
            const prepared = operations.prepareInitialisation(candidate.initialCommand, candidate.state);
            const before = await exportTenant(ownerPool, candidate.scope.tenantId);
            const failure = new Error('synthetic caller-owned operation failed after bootstrap');
            await expect(database.withTenantTransaction(candidate.scope.tenantId, async tx => {
                const outcome = await operations.executeInTransaction(tx, prepared);
                expect(outcome.reference).toEqual(prepared.expectedReference);
                // Query through the SAME restricted transaction: an owner-pool
                // export here would wait on our own tenant lock and prove nothing.
                for (const table of TABLES) {
                    const scoped = table !== 'dashboard_tenants';
                    const rows = await tx.query(`SELECT count(*)::integer AS count FROM nofries.${table} WHERE tenant_id=$1${scoped ? ' AND organisation_id=$2' : ''}`,
                        scoped ? [candidate.scope.tenantId, candidate.scope.organisationId] : [candidate.scope.tenantId]);
                    expect(rows.rows).toEqual([{ count: 1 }]);
                }
                throw failure;
            })).rejects.toBe(failure);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(before);
            const committed = await database.withTenantTransaction(candidate.scope.tenantId,
                tx => operations.executeInTransaction(tx, prepared));
            const receipts = await receiptRows(candidate.scope);
            expect(receipts).toHaveLength(1);
            expect(bootstrapReference(receipts[0])).toEqual(committed.reference);
            expect(committed.reference).toEqual(prepared.expectedReference);
            expect(receipts[0].result).toEqual(committed.result);
            const after = await exportTenant(ownerPool, candidate.scope.tenantId), queries = [];
            expect(await database.withTenantTransaction(candidate.scope.tenantId, tx => operations.reconcileInTransaction({
                query: async (sql, args) => { queries.push(sql); return tx.query(sql, args); }
            }, prepared))).toEqual(committed);
            expect(queries.length).toBeGreaterThan(0); expect(queries.every(sql => sql.startsWith('SELECT'))).toBe(true);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(after);
        });

        test.each(['postgres_commit_failed', 'postgres_rollback_failed'])('bootstrap recovers the original committed result after %s with one fresh nonmutating attempt', async code => {
            const candidate = uncommittedBootstrap(), transactions = [], recoveryQueries = [];
            const prepared = createBootstrapOperations({ clock: () => clockNow, authoriseAdministration: () => true })
                .prepareInitialisation(candidate.initialCommand, candidate.state);
            let original, committedRows;
            const uncertain = { withTenantTransaction: async (tenantId, work) => {
                const attempt = transactions.length;
                const result = await database.withTenantTransaction(tenantId, tx => {
                    transactions.push(tx);
                    return work({ query: async (sql, args) => {
                        if (attempt === 1) recoveryQueries.push(sql);
                        return tx.query(sql, args);
                    } });
                });
                if (attempt === 0) {
                    original = result;
                    committedRows = await exportTenant(ownerPool, candidate.scope.tenantId);
                    // Fault AFTER the actual COMMIT, not inside the callback.
                    throw new PostgresDatabaseError(code);
                }
                return result;
            } };
            expect(await makeRepository(uncertain).initialiseOrganisation(candidate.initialCommand, candidate.state)).toEqual(original);
            expect(transactions).toHaveLength(2); expect(transactions[0]).not.toBe(transactions[1]);
            expect(recoveryQueries.length).toBeGreaterThan(0);
            expect(recoveryQueries.every(sql => sql.startsWith('SELECT'))).toBe(true);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(committedRows);
            const receipts = await receiptRows(candidate.scope);
            expect(receipts).toHaveLength(1); expect(receipts[0].result).toEqual(original);
            expect(bootstrapReference(receipts[0])).toEqual(prepared.expectedReference);
            expect((await usageOf(candidate.scope)).revision).toBe(0);
        });

        test.each(['absent tenant', 'missing receipt'])('bootstrap recovery with %s leaves every retained row unchanged', async mode => {
            const candidate = mode === 'missing receipt' ? await seed({ withAdvisor: true }) : uncommittedBootstrap();
            if (mode === 'missing receipt') await ownerPool.query(
                'DELETE FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                [candidate.scope.tenantId, candidate.scope.organisationId, candidate.initialCommand.operationId]);
            const before = await exportTenant(ownerPool, candidate.scope.tenantId), queries = []; let calls = 0;
            const uncertain = { withTenantTransaction: (tenantId, work) => {
                if (++calls === 1) return Promise.reject(new PostgresDatabaseError('postgres_commit_failed'));
                return database.withTenantTransaction(tenantId, tx => work({ query: async (sql, args) => {
                    queries.push(sql); return tx.query(sql, args);
                } }));
            } };
            await expect(makeRepository(uncertain).initialiseOrganisation(candidate.initialCommand, candidate.state))
                .rejects.toMatchObject({ code: 'dashboard_commit_ambiguous' });
            expect(calls).toBe(2); expect(queries.length).toBeGreaterThan(0);
            expect(queries.every(sql => sql.startsWith('SELECT'))).toBe(true);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(before);
        });

        test('unavailable bootstrap reconciliation retains a genuine commit without claiming its response', async () => {
            const candidate = uncommittedBootstrap(); let calls = 0, original, committedRows;
            const uncertain = { withTenantTransaction: async (tenantId, work) => {
                if (++calls === 2) throw new PostgresDatabaseError('postgres_connection_failed');
                original = await database.withTenantTransaction(tenantId, work);
                committedRows = await exportTenant(ownerPool, candidate.scope.tenantId);
                throw new PostgresDatabaseError('postgres_commit_failed');
            } };
            await expect(makeRepository(uncertain).initialiseOrganisation(candidate.initialCommand, candidate.state))
                .rejects.toMatchObject({ code: 'dashboard_commit_ambiguous' });
            expect(calls).toBe(2);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(committedRows);
            expect((await receiptRows(candidate.scope))[0].result).toEqual(original);
            // A later explicit retry is separate from the failed reconciliation.
            expect(await repository.initialiseOrganisation(candidate.initialCommand, candidate.state)).toEqual(original);
            expect(await exportTenant(ownerPool, candidate.scope.tenantId)).toEqual(committedRows);
        });

        test('denies runtime receipt rewrites, deletion and truncation and verifies result integrity independently', async () => {
            const current = await seed();
            await repository.reserveUsage(reservation(current, 'immutable-receipt'));
            const before = await receiptRows(current.scope);
            for (const sql of ["UPDATE nofries.dashboard_operation_receipts SET result_sha256 = repeat('0',64)",
                'DELETE FROM nofries.dashboard_operation_receipts', 'TRUNCATE nofries.dashboard_operation_receipts']) {
                await expect(rawTransaction(current.scope, tx => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
            }
            expect(await receiptRows(current.scope)).toEqual(before);
            for (const receipt of before) {
                expect(receipt.resultSha256).toBe(crypto.createHash('sha256').update(stableJson(receipt.result)).digest('hex'));
                expect(receipt.resultRevisions).toEqual(receipt.result.resultRevisions);
            }
        });

        test.each(['row', 'counter'])('fails closed for a missing usage %s without treating it as zero', async kind => {
            const current = await seed();
            if (kind === 'row') await ownerPool.query('DELETE FROM nofries.dashboard_usage WHERE tenant_id=$1', [current.scope.tenantId]);
            else await ownerPool.query("UPDATE nofries.dashboard_usage SET payload = payload #- '{counters,assessment_runs}' WHERE tenant_id=$1", [current.scope.tenantId]);
            await expect(repository.reserveUsage(reservation(current))).rejects.toBeDefined();
            expect((await receiptRows(current.scope)).filter(row => row.operationType === 'usage.reserve')).toEqual([]);
            const usage = await usageOf(current.scope);
            if (kind === 'row') expect(usage).toBeUndefined();
            else expect(usage.counters).not.toHaveProperty('assessment_runs');
        });

        test('logically restores exact canonical records, schema checksums, configuration revisions and retry receipts into a fresh database', async () => {
            const current = await seed({ withAdvisor: true });
            const request = reservation(current, 'restore-reservation');
            const original = await repository.reserveUsage(request);
            const flags = clone(current.state.flags); flags.revision++;
            await repository.executeAuthorityCommand(command(current.scope, 'flags.update', original.resultRevisions, flags));
            const beforeSnapshot = await repository.readAdmissionSnapshot(current.scope, PRINCIPAL);
            const exported = await exportTenant(ownerPool, current.scope.tenantId);
            const manifest = await schemaManifest(ownerPool);
            const { Pool } = require('pg');
            await ownerPool.query(`CREATE DATABASE ${quoteIdentifier(recoveryName)} TEMPLATE template0`);
            recoveryCreated = true;
            const recoveryUrl = databaseUrl(testUrl, { database: recoveryName });
            recoveryOwner = new Pool({ connectionString: recoveryUrl, max: 2, application_name: `dashboard-restore-owner-${runKey}` });
            closeRecoveryOwner = trackPoolClientEnds(recoveryOwner);
            expect((await applyMigrations({ pool: recoveryOwner })).applied).toContain('0003_dashboard.sql');
            expect(await schemaManifest(recoveryOwner)).toEqual(manifest);
            const restore = await recoveryOwner.connect();
            try {
                await restore.query('BEGIN');
                for (const table of TABLES) {
                    for (const row of exported[table]) {
                        const columns = Object.keys(row);
                        await restore.query(`INSERT INTO nofries.${table} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
                            columns.map(column => row[column]));
                    }
                }
                await restore.query('COMMIT');
            } finally { await restore.query('ROLLBACK'); restore.release(); }
            expect(await exportTenant(recoveryOwner, current.scope.tenantId)).toEqual(exported);
            recoveryRuntime = new Pool({ connectionString: databaseUrl(recoveryUrl, { username: role, password }), max: 2,
                application_name: `dashboard-restored-runtime-${runKey}` });
            closeRecoveryRuntime = trackPoolClientEnds(recoveryRuntime);
            const recoveredRepository = makeRepository(createPostgresDatabase({ pool: recoveryRuntime }));
            expect(await recoveredRepository.readAdmissionSnapshot(current.scope, PRINCIPAL)).toEqual(beforeSnapshot);
            expect(await recoveredRepository.reserveUsage(request)).toEqual(original);
            expect(await recoveredRepository.initialiseOrganisation(current.initialCommand, current.state)).toEqual(current.result);
            expect(await exportTenant(recoveryOwner, current.scope.tenantId)).toEqual(exported);
            expect((await usageOf(current.scope, recoveryOwner)).counters.assessment_runs).toBe(1);
        }, 60000);
    });
};

function replaceTenant(value, tenantId) {
    if (Array.isArray(value)) return value.map(item => replaceTenant(item, tenantId));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, key === 'tenantId' ? tenantId : replaceTenant(item, tenantId)]));
    return value;
}
function replaceOrganisation(value, organisationId) {
    if (Array.isArray(value)) return value.map(item => replaceOrganisation(item, organisationId));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, key === 'organisationId' ? organisationId : replaceOrganisation(item, organisationId)]));
    return value;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function quoteIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function quoteLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function databaseUrl(value, overrides) {
    const parsed = new URL(value);
    if (overrides.username) parsed.username = overrides.username;
    if (overrides.password) parsed.password = overrides.password;
    if (overrides.database) parsed.pathname = `/${overrides.database}`;
    return parsed.toString();
}
function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
async function exportTenant(pool, tenantId) {
    const exported = {};
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR SHARE', [tenantId]);
        for (const table of TABLES) {
            exported[table] = (await client.query(`SELECT row_to_json(t) AS record FROM nofries.${table} t WHERE tenant_id=$1 ORDER BY payload::text`, [tenantId]))
                .rows.map(row => row.record);
        }
        await client.query('COMMIT');
        return exported;
    } finally { await client.query('ROLLBACK'); client.release(); }
}
async function schemaManifest(pool) {
    const migrations = (await pool.query('SELECT migration_id,checksum_sha256 FROM nofries.schema_migrations ORDER BY migration_id')).rows;
    const columns = (await pool.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='nofries' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position", [TABLES])).rows;
    const constraints = (await pool.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nofries' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname", [TABLES])).rows;
    const policies = (await pool.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='nofries' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname", [TABLES])).rows;
    return { migrations, columns, constraints, policies };
}
