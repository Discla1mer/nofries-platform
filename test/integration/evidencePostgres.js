'use strict';
// Registered by the existing PostgreSQL gate. Disposable synthetic owners only.
const crypto = require('node:crypto');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createPostgresDatabase } = require('../../api/shared/database/postgres');
const { createPostgresEvidenceStore } = require('../../api/shared/evidenceLifecycle/postgresEvidenceStore');
const NOW = '2026-09-10T00:00:00.000Z';
const ACTOR = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const clone = x => JSON.parse(JSON.stringify(x));
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
const TABLES = ['dashboard_evidence_receipts', 'dashboard_evidence_heads', 'dashboard_evidence_revisions'];

module.exports = function registerEvidencePostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Dormant evidence metadata in real PostgreSQL', () => {
        const run = crypto.randomBytes(8).toString('hex'), role = `nofries_evidence_${run}`;
        const password = `synthetic-only-${run}`;
        let ownerPool, runtimePool, database, store, sequence = 0, roleCreated = false;
        const tenants = [];
        function command(scope, version = 0) {
            const ref = recordId => ({ recordId, revision: 0, recordSha256: 'a'.repeat(64) });
            return { ...scope, action: version ? 'append-version' : 'create', expectedRevision: version ? version - 1 : null,
                actorSubjectKey: ACTOR, now: NOW, idempotencyKey: `operation:${version}`,
                payload: { versionId: `version:${version}`,
                    declaredContent: { sha256: 'a'.repeat(64), contentType: 'application/pdf', sizeBytes: 100 },
                    source: { kind: 'operator-declaration', sourceId: 'source:A', sourceRevision: 'source-revision:0',
                        observedAt: NOW, sourceMetadataSha256: 'b'.repeat(64) },
                    classification: { level: 'Internal', tags: [] },
                    policySnapshot: { policyId: 'policy:A', policyVersion: 'policy-version:0', maximumDeclaredBytes: 100,
                        allowedDeclaredContentTypes: ['application/pdf'] },
                    governanceRefs: { purposeDecisionRef: ref('purpose:A'), metadataRetentionPolicyRef: ref('metadata:A'),
                        bytesRetentionPolicyRef: ref('bytes:A'), legalHoldRefs: [] } } };
        }
        async function seed(suffix) {
            const tenantId = suffix || `evidence-${run}-${++sequence}`, organisationId = 'shared:organisation';
            const tenant = { schemaVersion: 1, tenantId, displayName: 'Synthetic evidence tenant', recordStatus: 'active', revision: 0 };
            const organisation = { schemaVersion: 1, tenantId, organisationId, displayName: 'Synthetic evidence org',
                domains: [], recordStatus: 'active', revision: 0 };
            await ownerPool.query('INSERT INTO nofries.dashboard_tenants (tenant_id,schema_version,revision,payload) VALUES ($1,1,0,$2::jsonb)',
                [tenantId, JSON.stringify(tenant)]);
            tenants.push(tenantId);
            await ownerPool.query('INSERT INTO nofries.dashboard_organisations (tenant_id,organisation_id,schema_version,revision,payload) VALUES ($1,$2,1,0,$3::jsonb)',
                [tenantId, organisationId, JSON.stringify(organisation)]);
            return { tenantId, organisationId, artefactId: 'shared:artefact' };
        }
        async function sql(scope, work) {
            return database.withTenantTransaction(scope.tenantId, work);
        }
        async function snapshot(scope) {
            const values = [];
            for (const table of TABLES) values.push((await ownerPool.query(`SELECT * FROM nofries.${table}
                WHERE tenant_id=$1 ORDER BY ${table.endsWith('receipts') ? 'result_revision' : 'revision'}`, [scope.tenantId])).rows);
            return values;
        }
        async function clearEvidence(scope) {
            await ownerPool.query('DELETE FROM nofries.dashboard_evidence_receipts WHERE tenant_id=$1', [scope.tenantId]);
            await ownerPool.query('DELETE FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [scope.tenantId]);
            const revisions = (await ownerPool.query('SELECT DISTINCT revision FROM nofries.dashboard_evidence_revisions WHERE tenant_id=$1 ORDER BY revision DESC', [scope.tenantId])).rows;
            for (const row of revisions) await ownerPool.query('DELETE FROM nofries.dashboard_evidence_revisions WHERE tenant_id=$1 AND revision=$2', [scope.tenantId, row.revision]);
        }
        beforeAll(async () => {
            const { Pool } = require('pg');
            ownerPool = new Pool({ connectionString: testUrl, max: 3 });
            const client = await ownerPool.connect();
            try { await applyMigrations({ client }); } finally { client.release(); }
            await ownerPool.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
            roleCreated = true; await ownerPool.query(`GRANT nofries_runtime TO "${role}"`);
            const runtimeUrl = new URL(testUrl); runtimeUrl.username = role; runtimeUrl.password = password;
            runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 4, statement_timeout: 10000 });
            database = createPostgresDatabase({ pool: runtimePool });
            store = createPostgresEvidenceStore({ database });
        });
        afterAll(async () => {
            if (runtimePool) await runtimePool.end();
            if (ownerPool) {
                for (const tenantId of tenants) {
                    await clearEvidence({ tenantId });
                    await ownerPool.query('DELETE FROM nofries.dashboard_organisations WHERE tenant_id=$1', [tenantId]);
                    await ownerPool.query('DELETE FROM nofries.dashboard_tenants WHERE tenant_id=$1', [tenantId]);
                }
                if (roleCreated) { await ownerPool.query(`DROP OWNED BY "${role}"`); await ownerPool.query(`DROP ROLE "${role}"`); }
                await ownerPool.end();
            }
        });
        test('migration repeats unchanged and all three tables FORCE RLS', async () => {
            const client = await ownerPool.connect();
            try { const result = await applyMigrations({ client }); expect(result.skipped).toContain('0007_evidence_metadata.sql'); }
            finally { client.release(); }
            const rows = (await ownerPool.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
                WHERE relnamespace='nofries'::regnamespace AND relname=ANY($1::text[])`, [TABLES])).rows;
            expect(rows).toHaveLength(3); rows.forEach(r => { expect(r.relrowsecurity).toBe(true); expect(r.relforcerowsecurity).toBe(true); });
        });
        test('round trip and repository restart preserve immutable original result', async () => {
            const scope = await seed(), first = await store.execute(command(scope));
            await store.execute(command(scope, 1));
            const restarted = createPostgresEvidenceStore({ database });
            expect((await restarted.read(scope)).revision).toBe(1);
            expect(await restarted.execute(command(scope))).toEqual(first);
            expect(await restarted.reconcile(command(scope))).toEqual(first);
            expect(Object.isFrozen((await restarted.read(scope)).versions[0])).toBe(true);
        });
        test('two tenants with colliding IDs cannot read each others rows and unset context sees none', async () => {
            const a = await seed(), b = await seed(); await store.execute(command(a)); await store.execute(command(b));
            await sql(a, async tx => {
                expect((await tx.query('SELECT * FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [b.tenantId])).rows).toEqual([]);
                expect((await tx.query('SELECT * FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1', [a.tenantId])).rows).toHaveLength(1);
            });
            const client = await runtimePool.connect();
            try { expect((await client.query('SELECT * FROM nofries.dashboard_evidence_heads')).rows).toEqual([]); }
            finally { client.release(); }
        });
        test('RLS rejects foreign tenant INSERT and composite FK rejects a foreign organisation', async () => {
            const a = await seed(), b = await seed(); await store.execute(command(a));
            const [,, revisions] = await snapshot(a); const r = revisions[0];
            await expect(sql(a, tx => tx.query(`INSERT INTO nofries.dashboard_evidence_revisions
                (tenant_id,organisation_id,artefact_id,revision,payload_sha256,parent_revision,parent_sha256,payload)
                VALUES ($1,$2,$3,0,$4,NULL,NULL,$5::jsonb)`,
            [b.tenantId,b.organisationId,'foreign',r.payload_sha256,JSON.stringify({ ...r.payload,tenantId:b.tenantId,artefactId:'foreign' })])))
                .rejects.toMatchObject({ code: 'postgres_query_failed' });
            await expect(sql(a, tx => tx.query(`INSERT INTO nofries.dashboard_evidence_revisions
                (tenant_id,organisation_id,artefact_id,revision,payload_sha256,parent_revision,parent_sha256,payload)
                VALUES ($1,'absent-org',$2,0,$3,NULL,NULL,$4::jsonb)`,
            [a.tenantId,'foreign',r.payload_sha256,JSON.stringify({ ...r.payload,organisationId:'absent-org',artefactId:'foreign' })])))
                .rejects.toMatchObject({ code: 'postgres_query_failed' });
        });
        test.each(['revisions', 'receipts'])('restricted runtime cannot UPDATE or DELETE immutable %s', async table => {
            const scope = await seed(); await store.execute(command(scope));
            await expect(sql(scope, tx => tx.query(`UPDATE nofries.dashboard_evidence_${table} SET payload=payload WHERE tenant_id=$1`, [scope.tenantId])))
                .rejects.toMatchObject({ code: 'postgres_query_failed' });
            await expect(sql(scope, tx => tx.query(`DELETE FROM nofries.dashboard_evidence_${table} WHERE tenant_id=$1`, [scope.tenantId])))
                .rejects.toMatchObject({ code: 'postgres_query_failed' });
        });
        test('drifted TRUNCATE grant fails the role fence before any metadata write', async () => {
            const scope = await seed();
            await ownerPool.query(`GRANT TRUNCATE ON nofries.dashboard_evidence_revisions TO "${role}"`);
            try { await expect(store.execute(command(scope))).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' }); }
            finally { await ownerPool.query(`REVOKE TRUNCATE ON nofries.dashboard_evidence_revisions FROM "${role}"`); }
            expect((await snapshot(scope))[2]).toHaveLength(0);
        });
        test.each([['revisions', 'direct'], ['receipts', 'direct'],
            ['revisions', 'inherited'], ['receipts', 'inherited']])
        ('rejects %s UPDATE(payload) privilege from a %s grant even without table UPDATE', async (kind, mode) => {
            const scope = await seed(), original = command(scope); await store.execute(original);
            const table = `nofries.dashboard_evidence_${kind}`;
            const inheritedRole = `nf_evidence_column_${run}_${++sequence}`;
            const grantee = mode === 'direct' ? role : inheritedRole;
            let inheritedCreated = false, membershipGranted = false, columnGranted = false;
            try {
                if (mode === 'inherited') {
                    await ownerPool.query(`CREATE ROLE "${inheritedRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
                    inheritedCreated = true;
                    await ownerPool.query(`GRANT "${inheritedRole}" TO "${role}" WITH INHERIT TRUE`);
                    membershipGranted = true;
                }
                await ownerPool.query(`GRANT UPDATE (payload) ON ${table} TO "${grantee}"`);
                columnGranted = true;
                await sql(scope, async tx => {
                    const privileges = (await tx.query(`SELECT
                        has_table_privilege(current_user,$1,'UPDATE') AS table_update,
                        has_column_privilege(current_user,$1,'payload','UPDATE') AS column_update,
                        has_any_column_privilege(current_user,$1,'UPDATE') AS any_column_update`, [table])).rows;
                    expect(privileges).toEqual([{ table_update: false, column_update: true, any_column_update: true }]);
                    // Demonstrate a real SQL write is permitted by the column
                    // grant; keep the synthetic payload byte-for-byte unchanged.
                    const write = await tx.query(`UPDATE ${table} SET payload=payload WHERE tenant_id=$1`, [scope.tenantId]);
                    expect(write.rowCount).toBe(1);
                });
                const before = await snapshot(scope);
                await expect(store.read(scope)).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' });
                await expect(store.execute(command(scope, 1))).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' });
                await expect(store.reconcile(original)).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' });
                expect(await snapshot(scope)).toEqual(before);
            } finally {
                // All grants and memberships belong to this synthetic case.
                // Attempt every cleanup even when a prior cleanup fails.
                const cleanupErrors = [];
                if (columnGranted) {
                    try { await ownerPool.query(`REVOKE UPDATE (payload) ON ${table} FROM "${grantee}"`); }
                    catch (error) { cleanupErrors.push(error); }
                }
                if (membershipGranted) {
                    try { await ownerPool.query(`REVOKE "${inheritedRole}" FROM "${role}"`); }
                    catch (error) { cleanupErrors.push(error); }
                }
                if (inheritedCreated) {
                    try { await ownerPool.query(`DROP ROLE "${inheritedRole}"`); }
                    catch (error) { cleanupErrors.push(error); }
                }
                if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic column-grant cleanup failed');
            }
            expect((await store.read(scope)).revision).toBe(0);
        });
        test('owner/superuser connection and drifted BYPASSRLS runtime are denied', async () => {
            const scope = await seed(), unsafe = createPostgresEvidenceStore({ database: createPostgresDatabase({ pool: ownerPool }) });
            await expect(unsafe.read(scope)).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' });
            await ownerPool.query(`ALTER ROLE "${role}" BYPASSRLS`);
            try { await expect(store.read(scope)).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' }); }
            finally { await ownerPool.query(`ALTER ROLE "${role}" NOBYPASSRLS`); }
        });
        test('simultaneous first creates serialize one winner and one original receipt', async () => {
            const scope = await seed(), a = command(scope), b = command(scope); b.idempotencyKey = 'other'; b.payload.versionId = 'other';
            const result = await Promise.all([capture(store.execute(a)), capture(store.execute(b))]);
            expect(result.filter(x => x.value)).toHaveLength(1); expect(result.filter(x => x.error)).toHaveLength(1);
            expect((await snapshot(scope)).map(x => x.length)).toEqual([1,1,1]);
        });
        test('simultaneous same operation creates return the same original state', async () => {
            const scope = await seed(), c = command(scope);
            const result = await Promise.all([store.execute(c), store.execute(c)]);
            expect(result[0]).toEqual(result[1]); expect((await snapshot(scope))[2]).toHaveLength(1);
        });
        test('concurrent appends allow one expected-revision winner', async () => {
            const scope = await seed(); await store.execute(command(scope));
            const a = command(scope,1), b = command(scope,1); b.idempotencyKey = 'other'; b.payload.versionId = 'other';
            const result = await Promise.all([capture(store.execute(a)),capture(store.execute(b))]);
            expect(result.filter(x=>x.value)).toHaveLength(1); expect(result.filter(x=>x.error)).toHaveLength(1);
            expect((await store.read(scope)).revision).toBe(1);
        });
        test('new stale operation fails while old successful operation remains replayable', async () => {
            const scope = await seed(), first = await store.execute(command(scope)); await store.execute(command(scope,1));
            const stale = command(scope,1); stale.idempotencyKey='new-stale'; stale.payload.versionId='new-stale';
            await expect(store.execute(stale)).rejects.toMatchObject({ code:'evidence_revision_conflict' });
            expect(await store.execute(command(scope))).toEqual(first);
        });
        test('changed original intent conflicts and preserves stored state', async () => {
            const scope=await seed(), c=command(scope); await store.execute(c); c.payload.versionId='changed';
            await expect(store.execute(c)).rejects.toMatchObject({ code:'evidence_store_intent_conflict' });
            expect((await store.read(scope)).currentVersionId).toBe('version:0');
        });
        test('failure before receipt insert rolls back version and head', async () => {
            const scope=await seed();
            const broken=createPostgresEvidenceStore({database:{withTenantTransaction:(tenant,work)=>database.withTenantTransaction(tenant,tx=>work({
                query:(q,p)=>{if(q.includes('evidence:insert-receipt')) throw Object.assign(new Error('synthetic'),{code:'postgres_query_failed'});return tx.query(q,p);}
            }))}});
            await expect(broken.execute(command(scope))).rejects.toMatchObject({code:'postgres_query_failed'});
            expect((await snapshot(scope)).map(x=>x.length)).toEqual([0,0,0]);
        });
        test('lost committed response reconciles on a fresh transaction without duplicate writes', async () => {
            const scope=await seed(); let once=true;
            const uncertain=createPostgresEvidenceStore({database:{async withTenantTransaction(tenant,work){
                const result=await database.withTenantTransaction(tenant,work);
                if(once){once=false;throw Object.assign(new Error('synthetic'),{code:'postgres_commit_failed'});} return result;
            }}});
            expect((await uncertain.execute(command(scope))).revision).toBe(0);
            expect((await snapshot(scope)).map(x=>x.length)).toEqual([1,1,1]);
        });
        test('absent commit reconciliation stays read-only and ambiguous', async () => {
            const scope=await seed(); await expect(store.reconcile(command(scope))).rejects.toMatchObject({code:'evidence_store_commit_ambiguous'});
            expect((await snapshot(scope)).map(x=>x.length)).toEqual([0,0,0]);
        });
        test('head missing but revisions retained is rejected as orphan history', async () => {
            const scope=await seed(); await store.execute(command(scope));
            await ownerPool.query('DELETE FROM nofries.dashboard_evidence_heads WHERE tenant_id=$1',[scope.tenantId]);
            await expect(store.read(scope)).rejects.toMatchObject({code:'evidence_store_invalid'});
        });
        test('mixed-point head restore cannot use a later receipt to hide an absent effect', async () => {
            const scope=await seed(); await store.execute(command(scope)); const original=(await snapshot(scope))[1][0];
            await store.execute(command(scope,1));
            await ownerPool.query('UPDATE nofries.dashboard_evidence_heads SET revision=$2,payload_sha256=$3 WHERE tenant_id=$1',
                [scope.tenantId,original.revision,original.payload_sha256]);
            await expect(store.execute(command(scope,1))).rejects.toMatchObject({code:'evidence_store_invalid'});
        });
        test('tampered correlation/causation event is rejected despite intact state hashes', async () => {
            const scope=await seed();await store.execute(command(scope));
            await ownerPool.query("UPDATE nofries.dashboard_evidence_receipts SET payload=jsonb_set(payload,'{event,causationId}',to_jsonb($2::text)) WHERE tenant_id=$1",[scope.tenantId,'f'.repeat(64)]);
            await expect(store.read(scope)).rejects.toMatchObject({code:'evidence_store_invalid'});
        });
        test('canonical Unicode tenant and 180-unit artefact identifiers survive JSONB', async () => {
            const scope=await seed(`租戶:${run}`);scope.artefactId='界'.repeat(180);
            const c=command(scope);c.idempotencyKey='操作:一';c.payload.versionId='版本:一';
            const first=await store.execute(c);expect(await store.read(scope)).toEqual(first);
            expect(first.artefactId.length).toBe(180);
        });
        test('canonical owner revocation while waiting on parent lock denies mutation', async () => {
            const scope=await seed(), blocker=await ownerPool.connect();
            try {
                await blocker.query('BEGIN');await blocker.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR UPDATE',[scope.tenantId]);
                const pending=capture(store.execute(command(scope)));
                await blocker.query("UPDATE nofries.dashboard_tenants SET revision=1,payload=jsonb_set(jsonb_set(payload,'{revision}','1'::jsonb),'{recordStatus}','\"suspended\"'::jsonb) WHERE tenant_id=$1",[scope.tenantId]);
                await blocker.query('COMMIT');
                const result=await pending;expect(result.error?.code).toBe('evidence_store_owner_inactive');
                expect((await snapshot(scope))[2]).toHaveLength(0);
            }finally{await blocker.query('ROLLBACK');blocker.release();}
        });
    });
};
