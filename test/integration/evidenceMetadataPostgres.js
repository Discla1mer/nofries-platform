'use strict';
// Restricted disposable PostgreSQL identity; metadata only, no bytes or live activation.
const crypto = require('node:crypto');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createPostgresDatabase } = require('../../api/shared/database/postgres');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresEvidenceStore } = require('../../api/shared/evidenceLifecycle/postgresEvidenceStore');
const { createPostgresEvidenceMetadataRepository } = require('../../api/shared/appLifecycle/postgresEvidenceMetadataRepository');
const { createDashboardAudit } = require('../../api/shared/appLifecycle/dashboardAudit');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { evidenceFixture, clone, SUBJECT, NOW } = require('../fixtures/evidenceMetadataFixture');
const { createContext, createClock, initialiseNcsc } = require('../fixtures/ncscAssessmentFixture');
module.exports = function registerEvidenceMetadataPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Authorised evidence metadata in real PostgreSQL', () => {
        const run = crypto.randomBytes(8).toString('hex'), role = `evidence_read_${run}`, password = `synthetic-only-${run}`;
        const applicationName = `evidence-read-${run}`, tenants = [], clock = createClock(NOW);
        let ownerPool, runtimePool, database, bootstrap, store, sequence = 0, roleCreated = false;
        async function seed(options = {}) {
            const example = evidenceFixture({ tenantId: `evidence-read-${run}-${++sequence}`, ...options });
            tenants.push(example.scope.tenantId);
            await initialiseNcsc(bootstrap, example, `bootstrap-${sequence}`);
            if (options.versionId) example.command.payload.versionId = options.versionId;
            await store.execute(example.command);
            return { ...example, context: await createContext(example.scope, clock) };
        }
        function reader(options = {}) {
            const events = [], transactions = [], queries = []; let active;
            const guarded = { withTenantTransaction: (tenant, work) => database.withTenantTransaction(tenant, async tx => {
                active = tx;
                transactions.push((await tx.query('SELECT txid_current()::text AS id')).rows[0].id);
                try { return await work({ query: async (sql, params) => { queries.push(sql); return tx.query(sql, params); } }); }
                finally { active = null; }
            }) };
            const audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
                if (!active) throw new Error('Audit escaped its read transaction');
                const txid = (await active.query('SELECT txid_current()::text AS id')).rows[0].id;
                expect(txid).toBe(transactions.at(-1)); events.push(event);
                if (options.failAudit) throw new Error('synthetic private sink failure');
            } });
            return { repository: createPostgresEvidenceMetadataRepository({ database: guarded, clock: clock.now, audit }), events, transactions, queries };
        }
        async function waitForLock() {
            const deadline = Date.now() + 5000;
            do {
                const rows = (await ownerPool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName])).rows;
                if (rows.length) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            } while (Date.now() < deadline);
            throw new Error('Synthetic evidence reader did not reach the owner lock');
        }
        beforeAll(async () => {
            const { Pool } = require('pg'); ownerPool = new Pool({ connectionString: testUrl, max: 3 });
            await applyMigrations({ pool: ownerPool });
            await ownerPool.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`); roleCreated = true;
            await ownerPool.query(`GRANT nofries_runtime TO "${role}"`);
            const url = new URL(testUrl); url.username = role; url.password = password;
            runtimePool = new Pool({ connectionString: url.toString(), max: 4, application_name: applicationName, statement_timeout: 10000 });
            database = createPostgresDatabase({ pool: runtimePool });
            bootstrap = createPostgresDashboardRepository({ database, clock: clock.now, authoriseAdministration: () => true });
            store = createPostgresEvidenceStore({ database });
        });
        afterAll(async () => {
            if (runtimePool) await runtimePool.end();
            if (!ownerPool) return;
            try {
                // Each fixture has one immutable evidence revision. No shared records are selected.
                for (const table of ['dashboard_evidence_receipts', 'dashboard_evidence_heads', 'dashboard_evidence_revisions',
                    'dashboard_operation_receipts', 'dashboard_usage', 'dashboard_advisor_assignments', 'dashboard_feature_flags',
                    'dashboard_entitlement_states', 'dashboard_membership_states', 'dashboard_organisations', 'dashboard_tenants']) {
                    await ownerPool.query(`DELETE FROM nofries.${table} WHERE tenant_id=ANY($1::text[])`, [tenants]);
                }
                if (roleCreated) { await ownerPool.query(`DROP OWNED BY "${role}"`); await ownerPool.query(`DROP ROLE "${role}"`); }
            } finally { await ownerPool.end(); }
        });
        test('authorised metadata and audit use one transaction with UPDATE parent locks and no evidence writes', async () => {
            const f = await seed(), h = reader(), before = (await ownerPool.query('SELECT * FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [f.scope.tenantId])).rows;
            const result = await h.repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId });
            expect(result.evidence.currentVersionId).toBe('version:0'); expect(result.evidence.versions[0].quarantine.state).toBe('quarantined');
            expect(h.transactions).toHaveLength(1); expect(h.events).toHaveLength(1);
            expect(h.queries.filter(q => /dashboard_tenants/.test(q) && /FOR UPDATE/.test(q)).length).toBeGreaterThan(0);
            expect((await ownerPool.query('SELECT * FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [f.scope.tenantId])).rows).toEqual(before);
        });
        test('colliding identifiers stay tenant-bound and literal star never lists metadata', async () => {
            const a = await seed(), b = await seed({ versionId: 'version:B' }), h = reader();
            expect((await h.repository.readEvidenceMetadata(a.context, { artefactId: a.command.artefactId })).evidence.currentVersionId).toBe('version:0');
            expect((await h.repository.readEvidenceMetadata(b.context, { artefactId: b.command.artefactId })).evidence.currentVersionId).toBe('version:B');
            await expect(h.repository.readEvidenceMetadata(a.context, { artefactId: b.command.artefactId, tenantId: b.scope.tenantId }))
                .rejects.toMatchObject({ code: 'evidence_input_invalid' });
            await expect(h.repository.readEvidenceMetadata(a.context, { artefactId: '*' })).rejects.toMatchObject({ code: 'evidence_not_found' });
            await database.withTenantTransaction(a.scope.tenantId, async tx => {
                expect((await tx.query('SELECT * FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [b.scope.tenantId])).rows).toEqual([]);
            });
            const foreign = await createContext(b.scope, clock, '30000000-0000-4000-8000-000000000000:30000000-0000-4000-8000-000000000001');
            await expect(h.repository.readEvidenceMetadata(foreign, { artefactId: b.command.artefactId })).rejects.toMatchObject({ code: 'evidence_access_denied' });
        });
        test('a committed membership suspension invalidates an earlier branded context', async () => {
            const f = await seed(), h = reader();
            await h.repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId });
            const membership = applyMembershipCommand(f.state.membershipState, f.state.tenantAggregate, {
                ...f.scope, action: 'suspend', actorSubjectKey: SUBJECT, now: NOW, expectedRevision: f.state.membershipState.revision,
                payload: { membershipId: f.state.membershipState.memberships[0].membershipId } });
            await ownerPool.query('UPDATE nofries.dashboard_membership_states SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                [f.scope.tenantId, f.scope.organisationId, membership.revision, JSON.stringify(membership)]);
            await expect(h.repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId })).rejects.toMatchObject({ code: 'evidence_access_denied' });
            expect(h.events).toHaveLength(1);
        });
        test('waiting reader observes authority revocation committed by the lock holder', async () => {
            const f = await seed(), h = reader(), blocker = await ownerPool.connect(); let pending;
            try {
                await blocker.query('BEGIN');
                await blocker.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR UPDATE', [f.scope.tenantId]);
                pending = h.repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId }).then(value => ({ value }), error => ({ error }));
                await waitForLock();
                const flags = clone(f.state.flags); flags.revision++; flags.enabled.evidence = false;
                await blocker.query('UPDATE nofries.dashboard_feature_flags SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                    [f.scope.tenantId, f.scope.organisationId, flags.revision, JSON.stringify(flags)]);
                await blocker.query('COMMIT');
                expect((await pending).error).toMatchObject({ code: 'evidence_access_denied' }); expect(h.events).toHaveLength(0);
            } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
        });
        test('failing transaction-bound audit prevents metadata disclosure and a fresh read recovers', async () => {
            const f = await seed(), h = reader({ failAudit: true });
            await expect(h.repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId })).rejects.toMatchObject({ code: 'evidence_unavailable' });
            expect((await reader().repository.readEvidenceMetadata(f.context, { artefactId: f.command.artefactId })).evidence.revision).toBe(0);
            expect((await ownerPool.query('SELECT count(*)::integer AS count FROM nofries.dashboard_evidence_receipts WHERE tenant_id=$1', [f.scope.tenantId])).rows[0].count).toBe(1);
        });
    });
};
