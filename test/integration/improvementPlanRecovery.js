'use strict';

// Synthetic logical recovery only. The caller owns the existing guarded,
// uniquely named loopback PostgreSQL fixture and its restricted roles. This
// proves restored application compatibility, not Azure physical PITR/cutover.
const crypto = require('node:crypto');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createDashboardResourceRuntime } = require('../../api/shared/dashboardRuntime');
const { createPostgresDashboardRuntimeRepository, createPostgresDashboardMaintenanceRepository } =
    require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createCommand, saveCommand, submitCommand, allResponses, SUBJECT } = require('../fixtures/ncscAssessmentFixture');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const TABLES = Object.freeze(['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states',
    'dashboard_entitlement_states', 'dashboard_feature_flags', 'dashboard_advisor_assignments',
    'dashboard_usage', 'dashboard_operation_receipts', 'dashboard_runtime_instance',
    'dashboard_admission_authorities', 'dashboard_admission_decisions', 'dashboard_onboarding_cases',
    'dashboard_onboarding_proofs', 'dashboard_onboarding_decisions', 'dashboard_identity_bindings',
    'dashboard_session_gates', 'dashboard_runtime_receipts', 'dashboard_runtime_audit',
    'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts',
    'dashboard_improvement_revisions', 'dashboard_improvement_heads']);
const SELECTOR = Object.freeze({ planId: 'recovery-plan', filters: Object.freeze({ status: 'all', owner: 'all', overdueOnly: false }) });
const quote = value => '"' + value.replaceAll('"', '""') + '"';

async function snapshot(pool) {
    const client = await pool.connect();
    try {
        // All parent revisions, action heads/history, session authority and the
        // original paired audit belong to one consistent database snapshot.
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const retained = {};
        for (const table of TABLES) retained[table] = (await client.query(
            `SELECT to_jsonb(t) AS value FROM nofries.${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.value);
        retained.ledger = (await client.query('SELECT migration_id,checksum_sha256 FROM nofries.schema_migrations ORDER BY migration_id')).rows;
        return retained;
    } finally { await client.query('ROLLBACK'); client.release(); }
}

async function restore(pool, retained) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const table of TABLES) {
            // Self-linked immutable revisions must precede their children.
            const ordered = [...retained[table]].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
            for (const row of ordered) {
                const columns = Object.keys(row);
                // These two existing tables require JSONB literal null for a
                // scopeless event/receipt; ordinary SQL-null references retain
                // their original meaning. Reuse the native fixture convention.
                const projection = columns.map(column => column === 'scope_json'
                    ? "COALESCE(v.scope_json,'null'::jsonb)" : 'v.' + quote(column)).join(',');
                await client.query(`INSERT INTO nofries.${table} (${columns.map(quote).join(',')})
                    SELECT ${projection} FROM jsonb_populate_record(NULL::nofries.${table},$1::jsonb) v`, [JSON.stringify(row)]);
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
}

module.exports = function registerImprovementPlanRecovery({ resourceSetup, getPools, testUrl, maintenanceRole }) {
    test('Improvement logical restore retains exact parents/audit, reopens with the prior reader, replays without writes and fences stale sessions', async () => {
        const url = new URL(testUrl);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
            !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) {
            throw new Error('Improvement recovery requires the existing explicit loopback-only disposable fixture.');
        }
        const f = await resourceSetup({ prepareExample(example) {
            const product = example.state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
            product.modules.push('improvement_plan'); product.modules.sort();
            example.state.flags.enabled.improvement_plan = true;
        } });
        const selected = await f.bindResource({ overrides: { improvementEnabled: true, ncscEnabled: true } });
        const executeAssessment = command => selected.facade.ncsc.executeNcscAssessment(selected.context, command);
        await executeAssessment(createCommand());
        await executeAssessment(saveCommand('assessment-a', 0, 'save-recovery', allResponses('no')));
        const submitted = await executeAssessment(submitCommand());
        const generate = { planId: SELECTOR.planId, type: 'generate', operationId: 'generate-recovery',
            expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-a',
                assessmentRevision: submitted.assessment.revision,
                assessmentRevisionSha256: submitted.assessment.revisionSha256 } };
        const generated = await selected.facade.improvement.execute(generate);
        const command = (plan, type, payload = {}) => ({ planId: plan.planId, type, operationId: type + '-recovery',
            expectedRevision: plan.revision, actionId: plan.actions[0].actionId, payload });
        const assigned = await selected.facade.improvement.execute(command(generated.plan, 'assign', {
            ownerSubjectKey: SUBJECT, dueDate: '2026-09-20' }));
        const started = await selected.facade.improvement.execute(command(assigned.plan, 'start'));
        const completed = await selected.facade.improvement.execute(command(started.plan, 'complete', {
            note: 'Synthetic completion retained for review.', evidenceReference: 'synthetic:recovery:evidence' }));
        const reopen = command(completed.plan, 'reopen', { reason: 'Synthetic restored review requires follow-up.' });
        const reopened = await selected.facade.improvement.execute(reopen);
        const originalList = await selected.facade.improvement.list(SELECTOR);
        const originalView = await selected.facade.improvement.view(SELECTOR);
        expect(originalList.planRevision).toBe(4);
        expect(originalList.actions[0].history.map(row => row.type)).toEqual(['assign', 'start', 'complete', 'reopen']);

        const { ownerPool, controlPool } = getPools();
        const retained = await snapshot(ownerPool);
        expect(retained.dashboard_improvement_revisions).toHaveLength(5);
        expect(retained.dashboard_improvement_heads).toHaveLength(1);
        const parent = retained.dashboard_ncsc_assessment_revisions.find(row => row.tenant_id === f.scope.tenantId &&
            row.organisation_id === f.scope.organisationId && row.assessment_id === 'assessment-a' &&
            row.revision === submitted.assessment.revision && row.payload_sha256 === submitted.assessment.revisionSha256);
        expect(parent).toBeDefined();
        for (const row of retained.dashboard_improvement_revisions) expect(row).toMatchObject({
            assessment_id: parent.assessment_id, assessment_revision: parent.revision, assessment_sha256: parent.payload_sha256 });
        const actionAudit = retained.dashboard_runtime_audit.filter(row => row.payload.module === 'improvement_plan');
        expect(actionAudit.filter(row => row.payload.action === 'improvement.write')).toHaveLength(5);
        expect(actionAudit.filter(row => row.payload.action === 'improvement.read')).toHaveLength(2);
        const revisionTransactions = (await ownerPool.query('SELECT xmin::text AS id FROM nofries.dashboard_improvement_revisions')).rows.map(row => row.id).sort();
        const auditTransactions = (await ownerPool.query("SELECT xmin::text AS id FROM nofries.dashboard_runtime_audit WHERE payload->>'action'='improvement.write'")).rows.map(row => row.id).sort();
        expect(auditTransactions).toEqual(revisionTransactions);

        const name = 'nf_improvement_restore_' + crypto.randomBytes(8).toString('hex');
        let owner, runtime, maintenance, closeOwner, closeRuntime, closeMaintenance, created = false;
        try {
            await controlPool.query('CREATE DATABASE ' + quote(name)); created = true;
            const { Pool } = require('pg'); url.pathname = '/' + name;
            owner = new Pool({ connectionString: url.toString(), max: 1 }); closeOwner = trackPoolClientEnds(owner);
            // The existing0005 test baseline permits no maintenance members
            // during installation. Temporarily release only this fixture's
            // synthetic edge and restore its exact membership options.
            await controlPool.query('REVOKE nofries_dashboard_maintenance FROM ' + quote(maintenanceRole));
            try {
                const migrated = await applyMigrations({ pool: owner });
                expect(migrated.applied).toContain('0016_dashboard_improvement_plans.sql');
                expect((await applyMigrations({ pool: owner })).applied).toEqual([]);
            } finally {
                await controlPool.query('GRANT nofries_dashboard_maintenance TO ' + quote(maintenanceRole) + ' WITH INHERIT FALSE,SET TRUE,ADMIN FALSE');
            }
            await restore(owner, retained);
            expect(await snapshot(owner)).toEqual(retained);

            // Keep the same restricted local login, changing only its uniquely
            // owned disposable database. Never log connection options.
            const clonePool = pool => {
                const selectedUrl = new URL(pool.options.connectionString); selectedUrl.pathname = '/' + name;
                return new Pool({ connectionString: selectedUrl.toString(), max: 1, connectionTimeoutMillis: 5000 });
            };
            runtime = clonePool(getPools().runtimePool);
            closeRuntime = trackPoolClientEnds(runtime);
            const resourceOptions = { ...f.resourceOptions, pool: runtime };
            let currentGeneration = f.selected.record.generationToken;
            const bind = async (enabled, generation = currentGeneration, inspect = null) => {
                const request = f.request(f.seed);
                const runtimeSource = createDashboardResourceRuntime({ ...resourceOptions,
                    ...(enabled ? { improvementEnabled: true } : {}) });
                const facade = await runtimeSource.forRequest(request, { expectedGeneration: generation });
                if (inspect) await inspect(facade, await facade.requestContext.resolve(request));
                return facade;
            };
            const restored = await bind(true);
            expect(await restored.improvement.plans({ limit: 20, afterPlanId: null })).toMatchObject({
                scope: f.scope, plans: [{ planId: SELECTOR.planId, planRevision: 4 }] });
            expect(await restored.improvement.list(SELECTOR)).toEqual(originalList);
            expect(await restored.improvement.view(SELECTOR)).toEqual(originalView);
            const editor = await restored.improvement.editor({ planId: SELECTOR.planId });
            expect(editor).toMatchObject({ schemaVersion: 1, scope: { ...f.scope, planId: SELECTOR.planId },
                planRevision: 4, canWrite: true, ownerChoices: [{ subjectKey: SUBJECT, label: 'Assign to me' }] });
            expect(editor.actions.map(row => row.actionId).sort()).toEqual(reopened.plan.actions.map(row => row.actionId).sort());
            expect(editor.actions.find(row => row.actionId === reopened.plan.actions[0].actionId)).toEqual({
                actionId: reopened.plan.actions[0].actionId, commands: ['assign', 'start'] });
            // The editor uses the existing read audit. Include that legitimate
            // read before proving exact replay adds no revision or audit.
            const beforeReplay = await snapshot(owner);
            expect(await restored.improvement.execute(generate)).toEqual(generated);
            expect(await restored.improvement.execute(reopen)).toEqual(reopened);
            expect(await snapshot(owner)).toEqual(beforeReplay);

            // Application rollback disables exposure and retains every row.
            // Reenable the unchanged608 reader and reconstruct full history.
            expect((await bind(false, f.selected.record.generationToken, async (facade, context) => {
                const legacyRead = await facade.ncsc.readNcscAssessment(context, { assessmentId: 'assessment-a' });
                expect(legacyRead.assessment).toEqual(submitted.assessment);
            })).improvement).toBeUndefined();
            const disabled = await snapshot(owner);
            for (const table of ['dashboard_improvement_revisions', 'dashboard_improvement_heads', 'dashboard_ncsc_assessment_revisions']) {
                expect(disabled[table]).toEqual(beforeReplay[table]);
            }
            // The legacy read uses its existing audit sink; rollback neither
            // rewrites retained action data nor invents an action audit.
            expect(disabled.dashboard_runtime_audit.filter(row => row.payload.module === 'improvement_plan'))
                .toEqual(beforeReplay.dashboard_runtime_audit.filter(row => row.payload.module === 'improvement_plan'));
            const resumed = await bind(true);
            expect(await resumed.improvement.view(SELECTOR)).toEqual(originalView);
            const beforeDenial = await snapshot(owner);
            await expect(bind(true, 'f'.repeat(64))).rejects.toMatchObject({ statusCode: 403 });
            expect(await snapshot(owner)).toEqual(beforeDenial);

            // Supersede an actually issued generation through the existing
            // native session controller, rather than only forging a token.
            const sessions = createPostgresDashboardRuntimeRepository({ ...f.options, pool: runtime });
            const previousGeneration = currentGeneration;
            const selectedAgain = await sessions.selectBinding(f.request(f.seed), {
                operationId: crypto.randomUUID(), bindingId: f.publication.binding.bindingId,
                expectedGeneration: previousGeneration });
            currentGeneration = selectedAgain.record.generationToken;
            expect(currentGeneration).not.toBe(previousGeneration);
            const superseded = await snapshot(owner);
            await expect(bind(true, previousGeneration)).rejects.toMatchObject({ statusCode: 403 });
            await expect(resumed.improvement.execute(reopen)).rejects.toMatchObject({ statusCode: 403 });
            await expect(resumed.improvement.editor({ planId: SELECTOR.planId })).rejects.toMatchObject({ statusCode: 403 });
            expect(await snapshot(owner)).toEqual(superseded);
            const current = await bind(true);
            expect(await current.improvement.view(SELECTOR)).toEqual(originalView);

            // Fence a restored instance through the existing maintenance
            // repository, then prove the retained old session cannot replay.
            maintenance = clonePool(getPools().maintenancePool);
            closeMaintenance = trackPoolClientEnds(maintenance);
            const row = retained.dashboard_runtime_instance[0];
            const record = { schemaVersion: 1, instanceId: row.instance_id, revision: row.revision,
                restoreEpoch: row.restore_epoch, ingressStatus: row.ingress_status, changedAt: new Date(row.changed_at).toISOString(),
                evidenceRef: row.evidence_ref, evidenceSha256: row.evidence_sha256 };
            const maintainer = createPostgresDashboardMaintenanceRepository({ ...f.maintenanceOptions, pool: maintenance });
            const firstFence = f.instanceCommand(record);
            expect(firstFence.expectedRecordSha256).toBe(row.record_sha256);
            const sameEpoch = await maintainer.fenceRestoreEpoch(firstFence);
            f.state.restoreEpoch = crypto.randomUUID();
            const newEpoch = await maintainer.fenceRestoreEpoch(f.instanceCommand(sameEpoch.record, f.state.restoreEpoch));
            await maintainer.enableRuntimeIngress(f.instanceCommand(newEpoch.record));
            const fenced = await snapshot(owner);
            expect(fenced.dashboard_improvement_revisions).toEqual(retained.dashboard_improvement_revisions);
            expect(fenced.dashboard_improvement_heads).toEqual(retained.dashboard_improvement_heads);
            expect(fenced.dashboard_ncsc_assessment_revisions).toEqual(retained.dashboard_ncsc_assessment_revisions);
            await expect(current.improvement.execute(reopen)).rejects.toMatchObject({ statusCode: 403 });
            await expect(current.improvement.editor({ planId: SELECTOR.planId })).rejects.toMatchObject({ statusCode: 403 });
            await expect(bind(true)).rejects.toMatchObject({ statusCode: 403 });
            expect(await snapshot(owner)).toEqual(fenced);
        } finally {
            const results = await Promise.allSettled([closeRuntime?.(), closeMaintenance?.(), closeOwner?.()]);
            if (created) await controlPool.query('DROP DATABASE ' + quote(name));
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        }
    }, 30000);
};
