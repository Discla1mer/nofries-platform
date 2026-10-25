'use strict';

// Dormant native composition proof. The audit sink below is a fixture, not a
// production runtime/session binding. Only a disposable loopback DB is accepted.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../scripts/db-migrate');
const { createPostgresDatabase } = require('../api/shared/database/postgres');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresEvidenceStore } = require('../api/shared/evidenceLifecycle/postgresEvidenceStore');
const { createPostgresImprovementPlanRepository } = require('../api/shared/improvementPlan/postgresImprovementPlanRepository');
const { createPostgresImprovementEvidenceLinkRepository } = require('../api/shared/improvementPlan/postgresImprovementEvidenceLinkRepository');
const { createImprovementActionPlanSource } = require('../api/shared/improvementPlan/improvementActionPlanSource');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { evidenceFixture } = require('./fixtures/evidenceMetadataFixture');
const { ncscFixture, createClock, createContext, createNcscAdapters, initialiseNcsc,
    allResponses, createCommand, saveCommand, submitCommand, NOW, SUBJECT, clone } = require('./fixtures/ncscAssessmentFixture');

const TABLES = ['dashboard_improvement_revisions', 'dashboard_improvement_heads',
    'dashboard_evidence_revisions', 'dashboard_evidence_heads', 'dashboard_evidence_receipts',
    'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts',
    'dashboard_usage', 'dashboard_operation_receipts'];
const identifier = value => `"${String(value).replace(/"/g, '""')}"`;
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
function localTestUrl(env = process.env) {
    const value = String(env.NOFRIES_IMPROVEMENT_TEST_DATABASE_URL || '').trim() ||
        String(env.NOFRIES_TEST_DATABASE_URL || '').trim();
    if (!value) return null;
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.search || parsed.hash) {
        throw new Error('Evidence-link proof requires an explicit loopback-only disposable PostgreSQL server.');
    }
    return value;
}
function connection(value, overrides = {}) {
    const url = new URL(value);
    if (overrides.database) url.pathname = `/${overrides.database}`;
    if (overrides.username) url.username = overrides.username;
    if (overrides.password) url.password = overrides.password;
    return url.toString();
}
const testUrl = localTestUrl();

test('native discovery accepts only explicit loopback test URLs, without connection overrides', () => {
    const ci = 'postgresql://synthetic@127.0.0.1:5432/test', dedicated = 'postgresql://synthetic@localhost:5433/test';
    expect(localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci })).toBe(ci);
    expect(localTestUrl({ NOFRIES_IMPROVEMENT_TEST_DATABASE_URL: dedicated, NOFRIES_TEST_DATABASE_URL: ci })).toBe(dedicated);
    expect(localTestUrl({ DATABASE_URL: ci, NOFRIES_DATABASE_URL: ci })).toBeNull();
    for (const key of ['NOFRIES_IMPROVEMENT_TEST_DATABASE_URL', 'NOFRIES_TEST_DATABASE_URL']) {
        for (const value of ['postgresql://synthetic@database.invalid/test', 'https://localhost/test',
            `${ci}?host=database.invalid`, `${ci}?user=unexpected`, `${ci}?password=unexpected`, `${ci}#override`]) {
            expect(() => localTestUrl({ [key]: value })).toThrow(/loopback-only/);
        }
    }
    expect(() => localTestUrl({ NOFRIES_IMPROVEMENT_TEST_DATABASE_URL: `${ci}?host=database.invalid`,
        NOFRIES_TEST_DATABASE_URL: ci })).toThrow(/loopback-only/);
});

test('the existing native CI selector includes this suite and the governed action migration', () => {
    expect(require('../package.json').scripts['test:postgres'].split(' ')).toContain('test/improvementEvidenceLinkPostgres.test.js');
    expect(fs.readdirSync(path.join(__dirname, '../database/migrations')).filter(name => /improvement/i.test(name)))
        .toEqual(['0016_dashboard_improvement_plans.sql']);
});

(testUrl ? describe : describe.skip)('Action/evidence resolution with real PostgreSQL and a paired fixture audit sink', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `evidence_link_${run}`, role = `evidence_link_${run}`;
    const password = `synthetic-local-${run}`, clock = createClock();
    let controlPool, ownerPool, runtimePool, database, ncsc, plans, evidence, sequence = 0;
    let databaseCreated = false, roleCreated = false;

    async function seed(options = {}) {
        const fixture = ncscFixture({ tenantId: `evidence-link-${run}-${++sequence}`, now: clock.now() });
        const grant = fixture.state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
        grant.modules.push('improvement_plan', 'evidence'); grant.modules.sort();
        await initialiseNcsc(ncsc, fixture, `bootstrap-${sequence}`);
        const context = await createContext(fixture.scope, clock);
        await ncsc.executeNcscAssessment(context, createCommand());
        await ncsc.executeNcscAssessment(context, saveCommand('assessment-a', 0, 'save-a', allResponses('no')));
        const submitted = await ncsc.executeNcscAssessment(context, submitCommand());
        const plan = await plans.executeImprovementPlan(context, { planId: 'shared-plan', type: 'generate',
            operationId: 'generate-a', expectedRevision: null, actionId: null,
            payload: { assessmentId: 'assessment-a', assessmentRevision: submitted.assessment.revision,
                assessmentRevisionSha256: submitted.assessment.revisionSha256 } });
        const command = clone(evidenceFixture({ ...fixture.scope, now: clock.now() }).command);
        if (options.artefactId) command.artefactId = options.artefactId;
        await evidence.execute(command);
        await evidence.execute({ ...command, action: 'append-version', expectedRevision: 0,
            idempotencyKey: 'synthetic:append', payload: { ...command.payload, versionId: 'version:1',
                declaredContent: { ...command.payload.declaredContent, sha256: 'b'.repeat(64), sizeBytes: 90 } } });
        return { ...fixture, context, command, plan, submitted,
            selector: { planId: plan.plan.planId, planRevision: plan.plan.revision,
                actionId: plan.plan.actions[0].actionId, artefactId: command.artefactId, evidenceVersionId: 'version:0' } };
    }

    async function businessRows(example) {
        const result = {};
        for (const table of TABLES) {
            const rows = (await ownerPool.query(`SELECT * FROM nofries.${table} WHERE tenant_id=$1 AND organisation_id=$2`,
                [example.scope.tenantId, example.scope.organisationId])).rows;
            result[table] = rows.map(row => JSON.stringify(row)).sort();
        }
        return result;
    }
    async function audits(example) {
        return (await ownerPool.query('SELECT event_id,tenant_id,organisation_id,transaction_id::text,payload FROM native_link_proof.audit WHERE tenant_id=$1 ORDER BY event_id',
            [example.scope.tenantId])).rows;
    }
    const assignment = example => ({ planId: example.selector.planId, type: 'assign', operationId: 'assign-a',
        expectedRevision: 0, actionId: example.selector.actionId,
        payload: { ownerSubjectKey: SUBJECT, dueDate: '2026-10-21' } });
    async function commandRevisions(example) {
        return (await ownerPool.query(`SELECT revision,operation_id,payload,xmin::text AS transaction_id
            FROM nofries.dashboard_improvement_revisions
            WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 ORDER BY revision`,
        [example.scope.tenantId, example.scope.organisationId, example.selector.planId])).rows;
    }
    function reader(options = {}) {
        const h = { boundaries: [], transactions: [], queries: [], transactionQueries: [], auditTransactions: [], events: [] };
        let active, loseCommitReply = options.loseCommitReply;
        // Every SQL query reaches PostgreSQL. The optional lost-reply fault is
        // injected only after PostgreSQL has actually committed successfully.
        const observedPool = { end: runtimePool.end.bind(runtimePool), async connect() {
            const client = await runtimePool.connect();
            return { release: client.release.bind(client), async query(sql, params) {
                if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) h.boundaries.push(sql);
                try {
                    const result = await client.query(sql, params);
                    if (sql === 'COMMIT' && loseCommitReply) {
                        loseCommitReply = false; h.lostCommitReply = true;
                        throw new Error('synthetic lost reply after committed transaction');
                    }
                    return result;
                }
                catch (error) { if (sql === 'COMMIT') h.commitFailure = error.code; throw error; }
            } };
        } };
        const transactionDatabase = createPostgresDatabase({ pool: observedPool });
        const paired = { withTenantTransaction: (tenant, work) => transactionDatabase.withTenantTransaction(tenant, async tx => {
            if (active) throw new Error('Unexpected overlapping native test transaction');
            active = tx;
            h.transactions.push((await tx.query('SELECT txid_current()::text AS id')).rows[0].id);
            const queries = []; h.transactionQueries.push(queries);
            try { return await work({ query: (sql, params) => {
                h.queries.push(sql); queries.push(sql); return tx.query(sql, params);
            } }); }
            finally { active = null; }
        }) };
        const audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
            if (!active) throw new Error('Audit escaped native transaction');
            const txid = (await active.query('SELECT txid_current()::text AS id')).rows[0].id;
            h.auditTransactions.push(txid); h.events.push(event);
            await active.query('INSERT INTO native_link_proof.audit (event_id,tenant_id,organisation_id,payload,witness_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
                [event.eventId, event.tenantId, event.organisationId, JSON.stringify(event), options.failCommit ? 2 : 1]);
            if (options.failAudit) throw new Error('synthetic private audit failure');
        } });
        h.repository = createPostgresImprovementEvidenceLinkRepository({ database: paired, clock: clock.now, audit });
        h.resolve = (example, selector = example.selector, context = example.context) =>
            h.repository.resolveImprovementEvidenceLink(context, selector);
        h.source = createImprovementActionPlanSource({ database: paired, clock: clock.now, audit,
            requestContext: { resolve: async context => context } });
        return h;
    }

    beforeAll(async () => {
        const { Pool } = require('pg');
        controlPool = new Pool({ connectionString: testUrl, max: 2 });
        await controlPool.query(`CREATE DATABASE ${identifier(databaseName)}`); databaseCreated = true;
        ownerPool = new Pool({ connectionString: connection(testUrl, { database: databaseName }), max: 3 });
        await applyMigrations({ pool: ownerPool });
        await controlPool.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(password)}`);
        roleCreated = true;
        await controlPool.query(`GRANT nofries_runtime TO ${identifier(role)}`);
        // Fixture-only storage: not a product migration or runtime audit schema.
        await ownerPool.query(`CREATE SCHEMA native_link_proof;
            CREATE TABLE native_link_proof.witness (id integer PRIMARY KEY);
            INSERT INTO native_link_proof.witness VALUES (1);
            CREATE TABLE native_link_proof.audit (
                event_id uuid PRIMARY KEY, tenant_id text NOT NULL, organisation_id text NOT NULL,
                transaction_id bigint NOT NULL DEFAULT txid_current(), payload jsonb NOT NULL,
                witness_id integer NOT NULL REFERENCES native_link_proof.witness(id) DEFERRABLE INITIALLY DEFERRED);
            ALTER TABLE native_link_proof.audit ENABLE ROW LEVEL SECURITY;
            ALTER TABLE native_link_proof.audit FORCE ROW LEVEL SECURITY;
            CREATE POLICY tenant_audit ON native_link_proof.audit
                USING (tenant_id=current_setting('nofries.tenant_id',true))
                WITH CHECK (tenant_id=current_setting('nofries.tenant_id',true));
            GRANT USAGE ON SCHEMA native_link_proof TO ${identifier(role)};
            GRANT SELECT,INSERT ON native_link_proof.audit TO ${identifier(role)};`);
        runtimePool = new Pool({ connectionString: connection(testUrl, { database: databaseName, username: role, password }),
            max: 3, application_name: `evidence-link-${run}`, statement_timeout: 15000 });
        database = createPostgresDatabase({ pool: runtimePool });
    }, 30000);
    beforeEach(() => {
        clock.set(NOW);
        const adapters = createNcscAdapters(clock);
        ncsc = createPostgresDashboardRepository({ database, clock: clock.now, authoriseAdministration: () => true,
            ncsc: { audit: adapters.audit, resolveSubmissionQuota: adapters.resolveSubmissionQuota } });
        plans = createPostgresImprovementPlanRepository({ database, clock: clock.now });
        evidence = createPostgresEvidenceStore({ database });
    });
    afterAll(async () => {
        if (runtimePool) await runtimePool.end();
        if (ownerPool) await ownerPool.end();
        if (controlPool) {
            try {
                if (databaseCreated) await controlPool.query(`DROP DATABASE ${identifier(databaseName)}`);
                if (roleCreated) await controlPool.query(`DROP ROLE ${identifier(role)}`);
            } finally { await controlPool.end(); }
        }
    });

    test('source assignment commits exactly one revision and canonical audit in the same native transaction', async () => {
        const f = await seed(), before = await businessRows(f), original = await commandRevisions(f), h = reader();
        expect(original).toHaveLength(1); expect(await audits(f)).toEqual([]);
        const command = assignment(f), result = await h.source.execute(f.context, command);
        expect(result.plan.revision).toBe(1);
        expect(result.plan.source).toEqual(f.plan.plan.source);
        expect(result.plan.actions.find(action => action.actionId === command.actionId))
            .toMatchObject({ status: 'open', ...command.payload });
        const retained = await commandRevisions(f), written = await audits(f), after = await businessRows(f);
        expect(retained).toHaveLength(2); expect(retained[0]).toEqual(original[0]);
        expect(retained[1]).toMatchObject({ revision: 1, operation_id: command.operationId,
            transaction_id: h.transactions[0], payload: { intent: { command }, source: original[0].payload.source } });
        expect(after.dashboard_improvement_heads.map(row => JSON.parse(row).revision)).toEqual([1]);
        for (const table of TABLES.slice(2)) expect(after[table]).toEqual(before[table]);
        expect(h.boundaries).toEqual(['BEGIN', 'COMMIT']);
        expect(h.transactions).toHaveLength(1); expect(h.auditTransactions).toEqual(h.transactions);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ transaction_id: retained[1].transaction_id, payload: {
            schemaVersion: 1, eventType: 'dashboard.operation', requestId: f.context.requestId,
            actorSubjectKey: SUBJECT, ...f.scope, action: 'improvement.write', module: 'improvement_plan',
            result: 'succeeded', occurredAt: NOW } });

        const listed = await h.source.list(f.context, { planId: command.planId,
            filters: { status: 'all', owner: 'all', overdueOnly: false } });
        expect(listed).toMatchObject({ planRevision: 1, priority: { status: 'not_calculated' } });
        expect(listed.actions.find(action => action.actionId === command.actionId)).toMatchObject({
            ...command.payload, ownerEligibility: 'not_checked', history: [{ revision: 1, type: 'assign',
                at: NOW, details: command.payload }] });
        expect(h.events.map(event => event.action)).toEqual(['improvement.write', 'improvement.read']);
        expect(await audits(f)).toHaveLength(2); expect(await businessRows(f)).toEqual(after);
    });

    test('identical command replay returns its original result without another revision or operational audit', async () => {
        const f = await seed(), h = reader(), command = assignment(f);
        const assigned = await h.source.execute(f.context, command);
        const started = await h.source.execute(f.context, { ...command, type: 'start', operationId: 'start-a',
            expectedRevision: 1, payload: {} });
        expect(started.plan.revision).toBe(2);
        const before = await businessRows(f), written = await audits(f), queryIndex = h.transactionQueries.length;
        expect(written).toHaveLength(2);
        expect(await h.source.execute(f.context, command)).toEqual(assigned);
        expect(h.transactionQueries).toHaveLength(queryIndex + 1);
        expect(h.transactionQueries[queryIndex].length).toBeGreaterThan(0);
        expect(h.transactionQueries[queryIndex].every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
        expect(h.events).toHaveLength(2); expect(await audits(f)).toEqual(written);
        expect(await businessRows(f)).toEqual(before);
    });

    test('command audit failure after INSERT rolls back the revision, head and audit without retry', async () => {
        const f = await seed(), before = await businessRows(f), h = reader({ failAudit: true });
        const outcome = await capture(h.source.execute(f.context, assignment(f)));
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
        expect(JSON.stringify(outcome.error)).not.toMatch(/private|postgres|native_link_proof/);
        expect(h.events).toHaveLength(1); expect(h.auditTransactions).toEqual(h.transactions);
        expect(h.transactions).toHaveLength(1); expect(h.boundaries).toEqual(['BEGIN', 'ROLLBACK']);
        expect(h.queries.filter(sql => /^INSERT INTO nofries\.dashboard_improvement_revisions\b/.test(sql))).toHaveLength(1);
        expect(await audits(f)).toEqual([]); expect(await businessRows(f)).toEqual(before);
    });

    test('command deferred COMMIT failure reconciles with SELECT only and leaves neither revision nor audit', async () => {
        const f = await seed(), before = await businessRows(f), h = reader({ failCommit: true });
        const outcome = await capture(h.source.execute(f.context, assignment(f)));
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ code: 'improvement_outcome_ambiguous', statusCode: 503 });
        expect(h.commitFailure).toBe('23503'); expect(h.events).toHaveLength(1);
        expect(h.boundaries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
        expect(h.transactions).toHaveLength(2); expect(h.auditTransactions).toEqual([h.transactions[0]]);
        expect(h.transactionQueries[1].length).toBeGreaterThan(0);
        expect(h.transactionQueries[1].every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
        expect(h.queries.filter(sql => /^INSERT INTO nofries\.dashboard_improvement_revisions\b/.test(sql))).toHaveLength(1);
        expect(await audits(f)).toEqual([]); expect(await businessRows(f)).toEqual(before);
    });

    test('a lost reply after actual command COMMIT recovers the retained result without reappending or reaudit', async () => {
        const f = await seed(), h = reader({ loseCommitReply: true }), command = assignment(f);
        const result = await h.source.execute(f.context, command);
        expect(h.lostCommitReply).toBe(true); expect(result.plan.revision).toBe(1);
        expect(result.plan.actions.find(action => action.actionId === command.actionId)).toMatchObject(command.payload);
        expect(h.boundaries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'COMMIT']);
        expect(h.transactions).toHaveLength(2); expect(h.auditTransactions).toEqual([h.transactions[0]]);
        expect(h.events).toHaveLength(1);
        expect(h.transactionQueries[1].length).toBeGreaterThan(0);
        expect(h.transactionQueries[1].every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
        expect(h.queries.filter(sql => /^INSERT INTO nofries\.dashboard_improvement_revisions\b/.test(sql))).toHaveLength(1);
        const retained = await commandRevisions(f), written = await audits(f);
        expect(retained).toHaveLength(2); expect(written).toHaveLength(1);
        expect(retained[1].transaction_id).toBe(h.transactions[0]);
        expect(written[0].transaction_id).toBe(retained[1].transaction_id);
        const beforeReplay = await businessRows(f);
        expect(await h.source.execute(f.context, command)).toEqual(result);
        expect(await audits(f)).toEqual(written); expect(h.events).toHaveLength(1);
        expect(await businessRows(f)).toEqual(beforeReplay);
    });

    test('exact historical selection and audit commit on the same native transaction without business mutation', async () => {
        const f = await seed(), before = await businessRows(f), h = reader();
        const result = await h.resolve(f);
        expect(result).toMatchObject({ status: 'unpersisted', evidenceVerification: 'not_verified',
            downloadAllowed: false, scoreEffect: 'none', scope: f.scope,
            action: { planId: f.plan.plan.planId, planRevision: 0, actionId: f.selector.actionId,
                controlId: f.plan.plan.actions[0].controlId },
            assessment: { assessmentId: 'assessment-a', revision: f.submitted.assessment.revision,
                revisionSha256: f.submitted.assessment.revisionSha256 },
            evidence: { versionId: 'version:0', currentVersionId: 'version:1', selectedIsCurrent: false,
                metadataRevision: 1, declaredContent: { sha256: 'a'.repeat(64), sizeBytes: 100 } } });
        expect(h.boundaries).toEqual(['BEGIN', 'COMMIT']);
        expect(h.transactions).toHaveLength(1); expect(h.auditTransactions).toEqual(h.transactions);
        expect(h.queries.some(sql => /dashboard_tenants/.test(sql) && /FOR UPDATE/.test(sql))).toBe(true);
        const written = await audits(f);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ transaction_id: h.transactions[0], payload: {
            action: 'evidence.read', module: 'evidence', result: 'succeeded', ...f.scope } });
        expect(await businessRows(f)).toEqual(before);
        expect(JSON.stringify(result)).not.toMatch(/private-source|private-policy|private-purpose|actorSubjectKey|governanceRefs|https?:/);
    });

    test('repeated historical and explicit current reads append only audit events', async () => {
        const f = await seed(), before = await businessRows(f), h = reader();
        const first = await h.resolve(f);
        expect(await h.resolve(f)).toEqual(first);
        expect((await h.resolve(f, { ...f.selector, evidenceVersionId: 'version:1' })).evidence)
            .toMatchObject({ versionId: 'version:1', selectedIsCurrent: true, declaredContent: { sha256: 'b'.repeat(64), sizeBytes: 90 } });
        const written = await audits(f);
        expect(written).toHaveLength(3); expect(new Set(written.map(row => row.event_id)).size).toBe(3);
        expect(new Set(written.map(row => row.transaction_id)).size).toBe(3);
        expect(await businessRows(f)).toEqual(before);
    });

    test('audit failure after insertion rolls back that audit and discloses no candidate', async () => {
        const f = await seed(), before = await businessRows(f), h = reader({ failAudit: true });
        const outcome = await capture(h.resolve(f));
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ code: 'improvement_evidence_unavailable', statusCode: 503 });
        expect(JSON.stringify(outcome.error)).not.toMatch(/private|postgres|native_link_proof/);
        expect(h.events).toHaveLength(1); expect(h.boundaries).toEqual(['BEGIN', 'ROLLBACK']);
        expect(await audits(f)).toEqual([]); expect(await businessRows(f)).toEqual(before);
        expect((await reader().resolve(f)).evidence.versionId).toBe('version:0');
        expect(await audits(f)).toHaveLength(1);
    });

    test('a genuine deferred PostgreSQL COMMIT failure rolls back audit and never returns the prepared candidate', async () => {
        const f = await seed(), before = await businessRows(f), h = reader({ failCommit: true });
        const outcome = await capture(h.resolve(f));
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ code: 'improvement_evidence_unavailable', statusCode: 503 });
        expect(h.events).toHaveLength(1); expect(h.commitFailure).toBe('23503');
        expect(h.boundaries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
        expect(h.transactions).toHaveLength(1); // No automatic read or write retry.
        expect(await audits(f)).toEqual([]); expect(await businessRows(f)).toEqual(before);
        expect((await reader().resolve(f)).evidence.versionId).toBe('version:0');
    });

    test('tenant collisions and missing membership cannot disclose foreign action or evidence data', async () => {
        const a = await seed(), b = await seed({ artefactId: 'foreign-only:artefact' }), h = reader();
        expect(a.selector.planId).toBe(b.selector.planId);
        await expect(h.resolve(a, { ...a.selector, artefactId: b.selector.artefactId })).rejects.toMatchObject({ statusCode: 404 });
        await expect(h.resolve(a, { ...a.selector, actionId: b.selector.actionId })).rejects.toMatchObject({ statusCode: 404 });
        const outsider = await createContext(b.scope, clock, '30000000-0000-4000-8000-000000000000:30000000-0000-4000-8000-000000000001');
        await expect(h.resolve(b, b.selector, outsider)).rejects.toMatchObject({ statusCode: 403 });
        await expect(h.resolve(a, a.selector, { ...a.context })).rejects.toMatchObject({ statusCode: 403 });
        await database.withTenantTransaction(a.scope.tenantId, async tx => {
            for (const table of ['dashboard_improvement_revisions', 'dashboard_evidence_revisions']) {
                expect((await tx.query(`SELECT * FROM nofries.${table} WHERE tenant_id=$1`, [b.scope.tenantId])).rows).toEqual([]);
            }
            expect((await tx.query('SELECT * FROM native_link_proof.audit WHERE tenant_id=$1', [b.scope.tenantId])).rows).toEqual([]);
        });
        expect(await audits(a)).toEqual([]); expect(await audits(b)).toEqual([]);
    });

    test('committed membership suspension invalidates an earlier branded context before audit', async () => {
        const f = await seed(), h = reader();
        const membership = applyMembershipCommand(f.state.membershipState, f.state.tenantAggregate, {
            ...f.scope, action: 'suspend', actorSubjectKey: SUBJECT, now: NOW, expectedRevision: f.state.membershipState.revision,
            payload: { membershipId: f.state.membershipState.memberships[0].membershipId } });
        await ownerPool.query('UPDATE nofries.dashboard_membership_states SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
            [f.scope.tenantId, f.scope.organisationId, membership.revision, JSON.stringify(membership)]);
        await expect(h.resolve(f)).rejects.toMatchObject({ code: 'improvement_evidence_access_denied', statusCode: 403 });
        expect(h.events).toEqual([]); expect(await audits(f)).toEqual([]);
    });

    test.each(['improvement_plan', 'evidence'])('current %s denial remains independently enforced', async module => {
        const f = await seed(), h = reader(), flags = clone(f.state.flags);
        flags.revision++; flags.enabled[module] = false;
        await ownerPool.query('UPDATE nofries.dashboard_feature_flags SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
            [f.scope.tenantId, f.scope.organisationId, flags.revision, JSON.stringify(flags)]);
        await expect(h.resolve(f)).rejects.toMatchObject({ code: 'improvement_evidence_access_denied', statusCode: 403 });
        expect(h.events).toEqual([]); expect(await audits(f)).toEqual([]);
    });

    test('stale plan and missing historical version roll back without retaining a read audit', async () => {
        const f = await seed(), before = await businessRows(f), stale = reader(), missing = reader();
        await expect(stale.resolve(f, { ...f.selector, planRevision: 1 }))
            .rejects.toMatchObject({ code: 'improvement_evidence_selection_conflict', statusCode: 409 });
        expect(stale.events).toEqual([]);
        await expect(missing.resolve(f, { ...f.selector, evidenceVersionId: 'version:missing' }))
            .rejects.toMatchObject({ code: 'improvement_evidence_not_found', statusCode: 404 });
        expect(missing.events).toHaveLength(1); // Evidence was read, then final selection failed.
        expect(missing.boundaries).toEqual(['BEGIN', 'ROLLBACK']);
        expect(await audits(f)).toEqual([]); expect(await businessRows(f)).toEqual(before);
    });
});
