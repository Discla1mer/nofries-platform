'use strict';

// Explicit local-only proof. Each run creates and drops its own synthetic
// database and restricted role; no configured application database is selected.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../scripts/db-migrate');
const { createPostgresDatabase, PostgresDatabaseError } = require('../api/shared/database/postgres');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { ncscFixture, createClock, createContext, createNcscAdapters, initialiseNcsc,
    allResponses, createCommand, saveCommand, submitCommand, NOW, SUBJECT, clone } = require('./fixtures/ncscAssessmentFixture');

// Inject a record-construction failure only during carry-forward, after the source plan exists.
jest.mock('../api/shared/improvementPlan/improvementPlanStore', () => {
    const store = jest.requireActual('../api/shared/improvementPlan/improvementPlanStore');
    return { ...store, makeRecord: jest.fn(store.makeRecord) };
});

const CANDIDATE = path.join(__dirname, '../database/proposals/improvement-plan-stage-a.sql');
const TABLES = ['dashboard_improvement_revisions', 'dashboard_improvement_heads'];
const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000003';
const quoteIdentifier = value => `"${String(value).replace(/"/g, '""')}"`;
const quoteLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
function urlFor(value, overrides = {}) {
    const parsed = new URL(value);
    if (overrides.database) parsed.pathname = `/${overrides.database}`;
    if (overrides.username) parsed.username = overrides.username;
    if (overrides.password) parsed.password = overrides.password;
    return parsed.toString();
}
function localTestUrl(env = process.env) {
    const dedicated = String(env.NOFRIES_IMPROVEMENT_TEST_DATABASE_URL || '').trim();
    const value = dedicated || String(env.NOFRIES_TEST_DATABASE_URL || '').trim();
    if (!value) return null;
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.search || parsed.hash) {
        throw new Error('Improvement proof requires an explicitly configured loopback-only disposable PostgreSQL server.');
    }
    return value;
}
const testUrl = localTestUrl();

test('the governed migration promotes only the retained action SQL body', () => {
    const migrations = fs.readdirSync(path.join(__dirname, '../database/migrations'));
    expect(migrations.filter(name => /improvement/i.test(name))).toEqual(['0016_dashboard_improvement_plans.sql']);
    const body = sql => sql.slice(sql.indexOf('CREATE TABLE nofries.dashboard_improvement_revisions'));
    expect(body(fs.readFileSync(path.join(__dirname, '../database/migrations/0016_dashboard_improvement_plans.sql'), 'utf8')))
        .toBe(body(fs.readFileSync(CANDIDATE, 'utf8')));
});

test('native discovery accepts only explicit loopback test URLs and preserves the dedicated override', () => {
    const ci = 'postgresql://synthetic@127.0.0.1:5432/test', dedicated = 'postgresql://synthetic@localhost:5433/test';
    expect(localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci })).toBe(ci);
    expect(localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci, NOFRIES_IMPROVEMENT_TEST_DATABASE_URL: dedicated })).toBe(dedicated);
    expect(localTestUrl({ NOFRIES_DATABASE_URL: ci })).toBeNull();
    for (const key of ['NOFRIES_IMPROVEMENT_TEST_DATABASE_URL', 'NOFRIES_TEST_DATABASE_URL']) {
        for (const value of ['postgresql://synthetic@database.invalid/test', 'https://localhost/test',
            `${ci}?host=database.invalid`, `${ci}?user=unexpected_owner`,
            `${ci}?password=unexpected_password`, `${ci}#unexpected`]) {
            expect(() => localTestUrl({ [key]: value })).toThrow(/loopback-only/);
        }
    }
    expect(() => localTestUrl({ NOFRIES_TEST_DATABASE_URL: ci,
        NOFRIES_IMPROVEMENT_TEST_DATABASE_URL: 'postgresql://synthetic@database.invalid/test' })).toThrow(/loopback-only/);
});

(testUrl ? describe : describe.skip)('Improvement Stage A with restricted real PostgreSQL', () => {
    const run = crypto.randomBytes(8).toString('hex');
    const databaseName = `improvement_stage_a_${run}`, role = `improvement_runtime_${run}`;
    const password = `synthetic-local-improvement-${run}`, applicationName = `improvement-runtime-${run}`;
    const clock = createClock();
    let controlPool, ownerPool, runtimePool, database, ncsc, makeRepository, repository, sequence = 0;
    let databaseCreated = false, roleCreated = false;

    async function seed(options = {}) {
        const fixture = ncscFixture({ tenantId: `improvement-${run}-${++sequence}`, now: clock.now(), ...options });
        const product = fixture.state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
        product.modules.push('improvement_plan'); product.modules.sort();
        product.code = options.tier || 'dashboard_score';
        fixture.state.flags.enabled.governance_workflow = false;
        await initialiseNcsc(ncsc, fixture, `bootstrap-${sequence}`);
        const context = await createContext(fixture.scope, clock);
        await ncsc.executeNcscAssessment(context, createCommand());
        await ncsc.executeNcscAssessment(context, saveCommand('assessment-a', 0, 'save-a', allResponses('no')));
        const submitted = await ncsc.executeNcscAssessment(context, submitCommand());
        const example = { ...fixture, context, submitted };
        await addMember(example, OWNER, 'owner');
        return example;
    }
    function generate(example, operationId = 'generate-a', planId = 'shared-plan') {
        return { planId, type: 'generate', operationId, expectedRevision: null, actionId: null,
            payload: { assessmentId: 'assessment-a', assessmentRevision: example.submitted.assessment.revision,
                assessmentRevisionSha256: example.submitted.assessment.revisionSha256 } };
    }
    function command(plan, type = 'assign', operationId = `${type}-${plan.revision}`, payload) {
        return { planId: plan.planId, type, operationId, expectedRevision: plan.revision,
            actionId: plan.actions[0].actionId, payload: payload || (type === 'assign'
                ? { ownerSubjectKey: OWNER, dueDate: '2026-09-20' } : {}) };
    }
    async function generated(example = null) {
        const selected = example || await seed();
        return { example: selected, initial: await repository.executeImprovementPlan(selected.context, generate(selected)) };
    }
    async function authority(example) {
        return (await ownerPool.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2',
            [example.scope.tenantId, example.scope.organisationId])).rows[0].payload;
    }
    async function saveMembership(example, state, client = ownerPool) {
        await client.query('UPDATE nofries.dashboard_membership_states SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
            [example.scope.tenantId, example.scope.organisationId, state.revision, JSON.stringify(state)]);
    }
    async function addMember(example, subjectKey, suffix) {
        let state = await authority(example);
        const old = state.memberships[0];
        state = applyMembershipCommand(state, example.state.tenantAggregate, { ...example.scope,
            expectedRevision: state.revision, actorSubjectKey: SUBJECT, now: clock.now(), action: 'invite',
            payload: { invitationId: `invite-${suffix}`, subjectKey, roles: ['editor'],
                validFrom: old.validFrom, validUntil: old.validUntil, expiresAt: old.validUntil,
                grantEvidenceId: `synthetic-${suffix}` } });
        state = applyMembershipCommand(state, example.state.tenantAggregate, { ...example.scope,
            expectedRevision: state.revision, actorSubjectKey: subjectKey, now: clock.now(), action: 'accept',
            payload: { invitationId: `invite-${suffix}`, membershipId: `member-${suffix}` } });
        await saveMembership(example, state);
    }
    async function removeMember(example, subjectKey = SUBJECT, client = ownerPool) {
        const state = await authority(example), member = state.memberships.find(row => row.subjectKey === subjectKey);
        const next = applyMembershipCommand(state, example.state.tenantAggregate, { ...example.scope,
            expectedRevision: state.revision, actorSubjectKey: SUBJECT, now: clock.now(), action: 'remove',
            payload: { membershipId: member.membershipId } });
        await saveMembership(example, next, client);
    }
    async function rows(example, table = TABLES[0]) {
        return (await ownerPool.query(`SELECT * FROM nofries.${table} WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY revision`,
            [example.scope.tenantId, example.scope.organisationId])).rows;
    }
    async function insertRevision(tx, record, changes = {}) {
        const row = { ...record, ...changes };
        return tx.query('INSERT INTO nofries.dashboard_improvement_revisions (tenant_id,organisation_id,plan_id,revision,operation_id,payload_sha256,parent_revision,parent_sha256,assessment_id,assessment_revision,assessment_sha256,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)',
            [row.tenant_id,row.organisation_id,row.plan_id,row.revision,row.operation_id,row.payload_sha256,row.parent_revision,row.parent_sha256,row.assessment_id,row.assessment_revision,row.assessment_sha256,JSON.stringify(row.payload)]);
    }
    async function rawTransaction(scope, work) {
        const client = await runtimePool.connect();
        try {
            await client.query('BEGIN');
            if (scope) await client.query("SELECT set_config('nofries.tenant_id',$1,true)", [scope.tenantId]);
            return await work(client);
        } finally { await client.query('ROLLBACK'); client.release(); }
    }
    async function waitForBlockedTenantQuery() {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const result = await ownerPool.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%dashboard_tenants%'", [applicationName]);
            if (result.rows[0].count) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Improvement operation did not reach its current-authority tenant lock.');
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
        runtimePool = new Pool({ connectionString: urlFor(testUrl, { database: databaseName, username: role, password }),
            max: 6, application_name: applicationName, statement_timeout: 15000 });
        database = createPostgresDatabase({ pool: runtimePool });
        ({ createPostgresImprovementPlanRepository: makeRepository } = require('../api/shared/improvementPlan/postgresImprovementPlanRepository'));
    }, 30000);
    beforeEach(() => {
        clock.set(NOW);
        const adapters = createNcscAdapters(clock);
        ncsc = createPostgresDashboardRepository({ database, clock: clock.now, authoriseAdministration: () => true,
            ncsc: { audit: adapters.audit, resolveSubmissionQuota: adapters.resolveSubmissionQuota } });
        repository = makeRepository({ database, clock: clock.now });
    });
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

    test('candidate tables force RLS, bind exact source/predecessor hashes, and retain append-only runtime history', async () => {
        const result = await ownerPool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='nofries'::regnamespace AND relname=ANY($1::text[])", [TABLES]);
        expect(result.rows).toHaveLength(2);
        result.rows.forEach(row => expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true }));
        for (const table of TABLES) {
            const privileges = (await runtimePool.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate", [`nofries.${table}`])).rows[0];
            expect(privileges).toEqual({ read: true, insert: true, update: table.endsWith('heads'), delete: false, truncate: false });
        }
        const keys = (await ownerPool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='nofries.dashboard_improvement_revisions'::regclass AND contype='f'")).rows;
        expect(keys).toHaveLength(2);
        expect(keys.some(row => row.definition.includes('assessment_id, assessment_revision, assessment_sha256'))).toBe(true);
        expect(keys.some(row => row.definition.includes('plan_id, parent_revision, parent_sha256'))).toBe(true);
        expect((await ownerPool.query("SELECT migration_id FROM nofries.schema_migrations WHERE migration_id ILIKE '%improvement%'")).rows)
            .toEqual([{ migration_id: '0016_dashboard_improvement_plans.sql' }]);
    });

    test('Score-tier generation and restart retain authentic source, history and immutable original replay results', async () => {
        const { example, initial } = await generated();
        expect(initial.plan.actions.length).toBeGreaterThan(0);
        const assign = command(initial.plan), assigned = await repository.executeImprovementPlan(example.context, assign);
        clock.advance(1000);
        const started = await repository.executeImprovementPlan(example.context, command(assigned.plan, 'start'));
        const restarted = makeRepository({ database, clock: clock.now });
        const read = await restarted.readImprovementPlan(example.context, { planId: initial.plan.planId });
        expect(read.plan).toEqual(started.plan);
        expect(read.history).toHaveLength(3);
        expect(read.sourceRevision).toMatchObject({ assessmentId: 'assessment-a', revision: example.submitted.assessment.revision,
            revisionSha256: example.submitted.assessment.revisionSha256 });
        expect(await restarted.executeImprovementPlan(example.context, generate(example))).toEqual(initial);
        expect(await restarted.executeImprovementPlan(example.context, assign)).toEqual(assigned);
        expect(await rows(example)).toHaveLength(3);
    });

    test('completion and reopening retain notes/evidence history without changing assessment records or scores', async () => {
        const { example, initial } = await generated();
        const sourceBefore = await ownerPool.query('SELECT * FROM nofries.dashboard_ncsc_assessment_revisions WHERE tenant_id=$1 ORDER BY revision', [example.scope.tenantId]);
        let result = await repository.executeImprovementPlan(example.context, command(initial.plan));
        result = await repository.executeImprovementPlan(example.context, command(result.plan, 'start'));
        result = await repository.executeImprovementPlan(example.context, command(result.plan, 'complete', 'complete-a',
            { note: 'Synthetic change recorded.', evidenceReference: 'evidence:synthetic-界' }));
        expect(result.plan.actions[0].completion).toMatchObject({ evidenceVerification: 'not_verified', evidenceReference: 'evidence:synthetic-界' });
        result = await repository.executeImprovementPlan(example.context, command(result.plan, 'reopen', 'reopen-a', { reason: 'Synthetic further work.' }));
        const read = await repository.readImprovementPlan(example.context, { planId: result.plan.planId });
        expect(read.history).toHaveLength(5); expect(read.plan.source).toEqual(initial.plan.source);
        expect(read.plan.actions[0]).toMatchObject({ status: 'open', completion: null });
        expect((await ownerPool.query('SELECT * FROM nofries.dashboard_ncsc_assessment_revisions WHERE tenant_id=$1 ORDER BY revision', [example.scope.tenantId])).rows).toEqual(sourceBefore.rows);
    });

    test('completion review date survives guarded SQL reload and identical retry, but not a changed retry', async () => {
        const { example, initial } = await generated();
        let result = await repository.executeImprovementPlan(example.context, command(initial.plan));
        result = await repository.executeImprovementPlan(example.context, command(result.plan, 'start'));
        const complete = command(result.plan, 'complete', 'complete-review',
            { note: 'Synthetic review planned.', evidenceReference: 'evidence:review', nextReviewDate: '2026-12-01' });
        const receipt = await repository.executeImprovementPlan(example.context, complete);
        const read = await repository.readImprovementPlan(example.context, { planId: result.plan.planId });
        expect(read.plan).toEqual(receipt.plan);
        expect(read.plan.actions[0].completion).toMatchObject({ nextReviewDate: '2026-12-01', evidenceVerification: 'not_verified' });
        expect(read.history.at(-1).payload.nextReviewDate).toBe('2026-12-01');
        expect(await repository.executeImprovementPlan(example.context, complete)).toEqual(receipt);
        await expect(repository.executeImprovementPlan(example.context, { ...complete,
            payload: { ...complete.payload, nextReviewDate: '2027-01-01' } })).rejects.toMatchObject({ statusCode: 409 });
        expect(await rows(example)).toHaveLength(4);
        expect(read.plan.source).toEqual(initial.plan.source);
    });

    test('an ownerLabel assign round-trips without membership, passes the 0016 CHECK and replays the same receipt', async () => {
        const { example, initial } = await generated();
        const assign = command(initial.plan, 'assign', 'assign-label', { ownerLabel: ' IT\tcontractor ', dueDate: '2026-09-20' });
        const assigned = await repository.executeImprovementPlan(example.context, assign);
        expect(assigned.plan.actions[0]).toMatchObject({ ownerSubjectKey: null, ownerLabel: 'IT contractor', dueDate: '2026-09-20' });
        const stored = (await rows(example))[1];
        expect(stored.payload.intent.command.payload).toEqual({ ownerLabel: 'IT contractor', dueDate: '2026-09-20' });
        expect(stored.payload.command.payload).toEqual({ ownerLabel: 'IT contractor', dueDate: '2026-09-20' });
        clock.advance(1000);
        const started = await repository.executeImprovementPlan(example.context, command(assigned.plan, 'start'));
        const restarted = makeRepository({ database, clock: clock.now });
        expect((await restarted.readImprovementPlan(example.context, { planId: initial.plan.planId })).plan).toEqual(started.plan);
        expect(await restarted.executeImprovementPlan(example.context, assign)).toEqual(assigned);
        await expect(restarted.executeImprovementPlan(example.context, { ...assign, payload: { ...assign.payload, ownerLabel: 'Other' } }))
            .rejects.toMatchObject({ statusCode: 409 });
        await expect(repository.executeImprovementPlan(example.context, command(started.plan, 'assign', 'assign-email',
            { ownerLabel: 'it@example.invalid', dueDate: '2026-09-20' }))).rejects.toMatchObject({ statusCode: 400 });
        expect(await rows(example)).toHaveLength(3);
    });

    test('tenant collisions, missing selected membership and forged contexts do not disclose foreign action records', async () => {
        const a = await generated(), b = await generated();
        expect(a.initial.plan.planId).toBe(b.initial.plan.planId);
        expect(a.initial.plan.actions[0].actionId).not.toBe(b.initial.plan.actions[0].actionId);
        for (const table of TABLES) {
            expect(await rawTransaction(null, async tx => (await tx.query(`SELECT * FROM nofries.${table}`)).rows)).toEqual([]);
            expect(await rawTransaction(a.example.scope, async tx => (await tx.query(`SELECT * FROM nofries.${table} WHERE tenant_id=$1`, [b.example.scope.tenantId])).rows)).toEqual([]);
        }
        const outsider = await createContext(a.example.scope, clock, OTHER);
        await expect(repository.readImprovementPlan(outsider, { planId: a.initial.plan.planId })).rejects.toMatchObject({ statusCode: 403 });
        await expect(repository.readImprovementPlan({ ...a.example.context }, { planId: a.initial.plan.planId })).rejects.toMatchObject({ statusCode: 403 });
    });

    test('cross-tenant INSERT, foreign source hashes and skipped predecessor history fail at the SQL boundary', async () => {
        const a = await generated(), b = await generated(), record = (await rows(a.example))[0];
        await expect(rawTransaction(a.example.scope, tx => insertRevision(tx, record, { tenant_id: b.example.scope.tenantId }))).rejects.toMatchObject({ code: '42501' });
        // Valid payload/column correspondence isolates the exact source FK.
        const foreign = clone(record.payload); foreign.source.revisionSha256 = 'f'.repeat(64);
        foreign.intent.command.planId = 'foreign-source';
        await expect(rawTransaction(a.example.scope, tx => insertRevision(tx, record, { plan_id: 'foreign-source', assessment_sha256: 'f'.repeat(64), payload: foreign }))).rejects.toMatchObject({ code: '23503' });
        await expect(rawTransaction(a.example.scope, tx => tx.query('UPDATE nofries.dashboard_improvement_revisions SET payload_sha256=$1 WHERE tenant_id=$2', ['f'.repeat(64),a.example.scope.tenantId]))).rejects.toMatchObject({ code: '42501' });
        await expect(rawTransaction(a.example.scope, tx => tx.query('DELETE FROM nofries.dashboard_improvement_heads WHERE tenant_id=$1', [a.example.scope.tenantId]))).rejects.toMatchObject({ code: '42501' });
    });

    test('SQL checks require closed intent, command and source objects after JSON extraction', async () => {
        const { example } = await generated(), record = (await rows(example))[0];
        const locations = [
            { path: ['intent'], required: 'actorSubjectKey' },
            { path: ['intent', 'command'], required: 'type' },
            { path: ['source'], required: 'revisionSha256' }
        ];
        let index = 0;
        for (const { path: location, required } of locations) {
            for (const kind of ['extra', 'missing', 'null', 'array']) {
                const payload = clone(record.payload), planId = `invalid-envelope-${++index}`;
                payload.intent.command.planId = planId;
                const parent = location.slice(0, -1).reduce((value, key) => value[key], payload);
                const key = location[location.length - 1];
                if (kind === 'extra') parent[key].unexpected = true;
                else if (kind === 'missing') delete parent[key][required];
                else parent[key] = kind === 'null' ? null : [];
                await expect(rawTransaction(example.scope, tx => insertRevision(tx, record,
                    { plan_id: planId, payload }))).rejects.toMatchObject({ code: '23514' });
            }
        }
        expect(await rows(example)).toEqual([record]);
    });

    test('revoked actors cannot read, mutate or replay a previously successful command', async () => {
        const { example, initial } = await generated(), assign = command(initial.plan);
        await repository.executeImprovementPlan(example.context, assign);
        await removeMember(example);
        await expect(repository.readImprovementPlan(example.context, { planId: initial.plan.planId })).rejects.toMatchObject({ statusCode: 403 });
        await expect(repository.executeImprovementPlan(example.context, assign)).rejects.toMatchObject({ statusCode: 403 });
        await expect(repository.executeImprovementPlan(example.context, generate(example))).rejects.toMatchObject({ statusCode: 403 });
        expect(await rows(example)).toHaveLength(2);
    });

    test('removed owners cannot start work, while replaying the original assignment adds no owner side effect', async () => {
        const { example, initial } = await generated(), assign = command(initial.plan);
        const assigned = await repository.executeImprovementPlan(example.context, assign);
        await removeMember(example, OWNER);
        expect(await repository.executeImprovementPlan(example.context, assign)).toEqual(assigned);
        await expect(repository.executeImprovementPlan(example.context, command(assigned.plan, 'start'))).rejects.toMatchObject({ statusCode: 409 });
        expect(await rows(example)).toHaveLength(2);
    });

    test('product revocation and module disablement deny current reads and successful-command replays', async () => {
        for (const mode of ['product', 'module']) {
            const { example, initial } = await generated();
            const table = mode === 'product' ? 'dashboard_entitlement_states' : 'dashboard_feature_flags';
            const saved = (await ownerPool.query(`SELECT payload FROM nofries.${table} WHERE tenant_id=$1`, [example.scope.tenantId])).rows[0].payload;
            saved.revision += 1;
            if (mode === 'product') saved.grants.find(row => row.grantId === 'synthetic-product').status = 'revoked';
            else saved.enabled.improvement_plan = false;
            await ownerPool.query(`UPDATE nofries.${table} SET revision=$2,payload=$3::jsonb WHERE tenant_id=$1`, [example.scope.tenantId,saved.revision,JSON.stringify(saved)]);
            await expect(repository.readImprovementPlan(example.context, { planId: initial.plan.planId })).rejects.toMatchObject({ statusCode: 403 });
            await expect(repository.executeImprovementPlan(example.context, generate(example))).rejects.toMatchObject({ statusCode: 403 });
            expect(await rows(example)).toHaveLength(1);
        }
    });

    test('changed operation intent and another actor cannot reuse an earlier operation key', async () => {
        const { example, initial } = await generated(), assign = command(initial.plan);
        await repository.executeImprovementPlan(example.context, assign);
        await expect(repository.executeImprovementPlan(example.context, { ...assign, payload: { ...assign.payload, dueDate: '2026-09-21' } })).rejects.toMatchObject({ statusCode: 409 });
        const otherActor = await createContext(example.scope, clock, OWNER);
        await expect(repository.executeImprovementPlan(otherActor, assign)).rejects.toMatchObject({ statusCode: 409 });
        expect(await rows(example)).toHaveLength(2);
    });

    test('concurrent first creation and stale action revisions yield one immutable result per revision', async () => {
        const example = await seed(), create = generate(example);
        const creation = await Promise.all([capture(repository.executeImprovementPlan(example.context, create)),
            capture(repository.executeImprovementPlan(example.context, { ...create, operationId: 'generate-b' }))]);
        expect(creation.filter(row => row.value)).toHaveLength(1);
        expect(creation.find(row => row.error).error).toMatchObject({ statusCode: 409 });
        const plan = creation.find(row => row.value).value.plan;
        const writes = await Promise.all([capture(repository.executeImprovementPlan(example.context, command(plan, 'assign', 'assign-a'))),
            capture(repository.executeImprovementPlan(example.context, command(plan, 'assign', 'assign-b')))]);
        expect(writes.filter(row => row.value)).toHaveLength(1);
        expect(writes.find(row => row.error).error).toMatchObject({ statusCode: 409 });
        expect((await rows(example)).map(row => row.revision)).toEqual([0, 1]);
    });

    test('revocation committed while an operation waits on its tenant lock denies before disclosure or mutation', async () => {
        const { example, initial } = await generated(), holder = await ownerPool.connect();
        let pending;
        try {
            await holder.query('BEGIN');
            await holder.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR UPDATE', [example.scope.tenantId]);
            pending = capture(repository.executeImprovementPlan(example.context, command(initial.plan)));
            await waitForBlockedTenantQuery();
            await removeMember(example, SUBJECT, holder);
            await holder.query('COMMIT');
            expect((await pending).error).toMatchObject({ statusCode: 403 });
            expect(await rows(example)).toHaveLength(1);
        } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; }
    });

    test('a write failure rolls back the appended revision and head together', async () => {
        const { example, initial } = await generated();
        const failing = { withTenantTransaction: (tenantId, work) => database.withTenantTransaction(tenantId, tx => work({
            query: async (sql, args) => {
                const result = await tx.query(sql, args);
                if (/INSERT INTO nofries\.dashboard_improvement_revisions/.test(sql)) throw new Error('Synthetic append failure');
                return result;
            }
        })) };
        await expect(makeRepository({ database: failing, clock: clock.now }).executeImprovementPlan(example.context, command(initial.plan))).rejects.toBeDefined();
        expect((await repository.readImprovementPlan(example.context, { planId: initial.plan.planId })).plan).toEqual(initial.plan);
        expect(await rows(example)).toHaveLength(1);
    });

    test('lost COMMIT acknowledgement reconciles only a durable original receipt and never appends twice', async () => {
        const { example, initial } = await generated(), assign = command(initial.plan);
        let lose = true;
        const uncertain = { async withTenantTransaction(tenantId, work) {
            const result = await database.withTenantTransaction(tenantId, work);
            if (lose) { lose = false; throw new PostgresDatabaseError('postgres_commit_failed'); }
            return result;
        } };
        const recovered = await makeRepository({ database: uncertain, clock: clock.now }).executeImprovementPlan(example.context, assign);
        expect(recovered.plan.revision).toBe(1);
        expect(await repository.executeImprovementPlan(example.context, assign)).toEqual(recovered);
        expect(await rows(example)).toHaveLength(2);
    });

    test('missing outcome after a failed COMMIT stays ambiguous and does not create work on reconciliation', async () => {
        const { example, initial } = await generated();
        let fail = true;
        const uncertain = { withTenantTransaction(tenantId, work) {
            if (fail) { fail = false; return Promise.reject(new PostgresDatabaseError('postgres_commit_failed')); }
            return database.withTenantTransaction(tenantId, work);
        } };
        await expect(makeRepository({ database: uncertain, clock: clock.now }).executeImprovementPlan(example.context, command(initial.plan))).rejects.toMatchObject({ statusCode: 503 });
        expect(await rows(example)).toHaveLength(1);
    });

    test('retained result corruption fails closed without returning a partial plan', async () => {
        const { example, initial } = await generated();
        await ownerPool.query("UPDATE nofries.dashboard_improvement_revisions SET payload=jsonb_set(payload,'{resultSha256}',to_jsonb($2::text)) WHERE tenant_id=$1", [example.scope.tenantId,'f'.repeat(64)]);
        await expect(repository.readImprovementPlan(example.context, { planId: initial.plan.planId })).rejects.toMatchObject({ statusCode: 503 });
        await expect(repository.executeImprovementPlan(example.context, generate(example))).rejects.toMatchObject({ statusCode: 503 });
    });

    describe('retained lists through the actual dormant source factory', () => {
        const { createImprovementActionPlanSource } = require('../api/shared/improvementPlan/improvementActionPlanSource');
        const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
        const harnesses = [];
        const selector = planId => ({ planId, filters: { status: 'all', owner: 'all', overdueOnly: false } });

        async function businessRows(example) {
            const result = {};
            for (const table of [...TABLES, 'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments',
                'dashboard_ncsc_assessment_receipts', 'dashboard_usage', 'dashboard_operation_receipts']) {
                const selected = await ownerPool.query(`SELECT * FROM nofries.${table} WHERE tenant_id=$1 AND organisation_id=$2`,
                    [example.scope.tenantId, example.scope.organisationId]);
                result[table] = selected.rows.map(row => JSON.stringify(row)).sort();
            }
            return result;
        }

        async function sourceHarness(example, options = {}) {
            const client = await ownerPool.connect();
            let active, observed, closed = false, discard = false;
            const h = { boundaries: [], transactions: [], auditTransactions: [], queryIdentities: [], events: [], queries: [], resolutions: 0 };
            h.close = async () => {
                if (closed) return;
                closed = true;
                let failure;
                try {
                    if (observed) await observed.close();
                } catch (error) { discard = true; failure = error; }
                try {
                    for (const sql of ['ROLLBACK', 'RESET ROLE',
                        'DROP TABLE IF EXISTS pg_temp.nf_action_list_audit, pg_temp.nf_action_list_witness']) {
                        try { await client.query(sql); }
                        catch (error) { discard = true; failure ||= error; }
                    }
                } finally { client.release(discard); }
                if (failure) throw failure;
            };
            harnesses.push(h); // Includes partially initialized fixtures in cleanup.
            try {
                // Owner-session fixture only: runtime has no TEMP privilege.
                // All business SQL below uses the exact restricted current role.
                // This does not prove a direct runtime principal can write audit
                // or cannot elevate its role; existing direct-runtime cases above
                // remain separate. No privileges or operational schema change.
                const ownerRole = (await client.query('SELECT current_user AS role')).rows[0].role;
                await client.query(`CREATE TEMP TABLE nf_action_list_witness (id integer PRIMARY KEY);
                    INSERT INTO nf_action_list_witness VALUES (1);
                    CREATE TEMP TABLE nf_action_list_audit (
                        event_id uuid PRIMARY KEY, transaction_id bigint NOT NULL DEFAULT txid_current(),
                        payload jsonb NOT NULL, witness_id integer NOT NULL REFERENCES nf_action_list_witness(id)
                            DEFERRABLE INITIALLY DEFERRED)`);
                async function requireRestrictedIdentity() {
                    const identity = (await client.query(`SELECT current_user AS role,rolsuper,rolbypassrls,
                        has_database_privilege(current_user,current_database(),'TEMP') AS temporary
                        FROM pg_catalog.pg_roles WHERE rolname=current_user`)).rows[0];
                    expect(identity).toEqual({ role, rolsuper: false, rolbypassrls: false, temporary: false });
                    h.queryIdentities.push(identity);
                }
                observed = createPostgresDatabase({ pool: {
                    async end() {},
                    async connect() {
                        return {
                            release(value) { discard ||= !!value; },
                            async query(sql, params) {
                                h.queries.push(sql);
                                if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) h.boundaries.push(sql);
                                try {
                                    if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) await requireRestrictedIdentity();
                                    const result = await client.query(sql, params);
                                    if (sql === 'BEGIN') {
                                        await client.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
                                        await requireRestrictedIdentity();
                                    }
                                    if (sql === 'COMMIT' && options.afterCommit) await options.afterCommit();
                                    return result;
                                } catch (error) {
                                    if (sql === 'COMMIT') h.commitFailure = error.code;
                                    throw error;
                                }
                            }
                        };
                    }
                } });
                const paired = { withTenantTransaction: (tenantId, work) => observed.withTenantTransaction(tenantId, async tx => {
                    if (active) throw new Error('Unexpected overlapping fixture transaction');
                    active = { tx, tenantId };
                    try {
                        h.transactions.push((await tx.query('SELECT txid_current()::text AS id')).rows[0].id);
                        return await work(tx);
                    } finally { active = null; }
                }) };
                const audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID,
                    async writeEvent(event) {
                        if (!active || event.tenantId !== active.tenantId ||
                            event.organisationId !== example.scope.organisationId) throw new Error('Unpaired fixture audit');
                        h.events.push(event);
                        const transactionId = (await active.tx.query('SELECT txid_current()::text AS id')).rows[0].id;
                        // Trusted synthetic sink alone returns to the fixture
                        // owner; the real transaction and tenant locks stay held.
                        try {
                            try { await client.query('RESET ROLE'); }
                            catch (error) { discard = true; throw error; }
                            expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe(ownerRole);
                            const inserted = await client.query('INSERT INTO pg_temp.nf_action_list_audit (event_id,payload,witness_id) VALUES ($1,$2::jsonb,$3) RETURNING transaction_id::text AS id',
                                [event.eventId, JSON.stringify(event), options.failCommit ? 2 : 1]);
                            expect(inserted.rows[0].id).toBe(transactionId);
                            h.auditTransactions.push(inserted.rows[0].id);
                        } finally {
                            try {
                                await client.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
                                await requireRestrictedIdentity();
                            } catch (error) { discard = true; throw error; }
                        }
                        if (options.failAudit) throw new Error('Synthetic private audit failure');
                    } });
                h.source = createImprovementActionPlanSource({ database: paired, clock: clock.now, audit,
                    requestContext: { async resolve() { h.resolutions++; return options.context || example.context; } } });
                h.list = input => h.source.list({}, input || selector('shared-plan'));
                h.audits = async () => (await client.query('SELECT event_id,transaction_id::text,payload FROM pg_temp.nf_action_list_audit ORDER BY event_id')).rows;
                return h;
            } catch (error) { await h.close().catch(() => {}); throw error; }
        }

        afterEach(async () => {
            const settled = await Promise.allSettled(harnesses.splice(0).map(h => h.close()));
            const failed = settled.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
        });

        test('factory commands reconstruct retained SQL ownership, completion and reopen lists without changing assessment or score records', async () => {
            const example = await seed(), writer = await sourceHarness(example);
            expect(example.submitted.assessment.revision).toBe(2);
            const initial = await writer.source.execute({}, generate(example));
            const assign = command(initial.plan, 'assign', 'assign-list', { ownerSubjectKey: OWNER, dueDate: '2026-09-06' });
            const assigned = await writer.source.execute({}, assign);
            let saved = assigned;
            saved = await writer.source.execute({}, command(saved.plan, 'start', 'start-list'));
            saved = await writer.source.execute({}, command(saved.plan, 'complete', 'complete-list',
                { note: 'Synthetic completion.', evidenceReference: 'evidence:synthetic-list' }));
            expect(writer.events).toHaveLength(4);
            expect(writer.auditTransactions).toEqual(writer.transactions);
            expect(new Set(writer.transactions).size).toBe(4);
            const written = await writer.audits();
            expect(written).toHaveLength(4);
            const byEventId = new Map(written.map(row => [row.event_id, row]));
            writer.events.forEach((event, index) => {
                expect(event).toEqual({ schemaVersion: 1, eventType: 'dashboard.operation',
                    eventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
                    requestId: example.context.requestId, actorSubjectKey: SUBJECT, ...example.scope,
                    action: 'improvement.write', module: 'improvement_plan', result: 'succeeded', occurredAt: NOW });
                expect(byEventId.get(event.eventId)).toEqual({ event_id: event.eventId,
                    transaction_id: writer.transactions[index], payload: event });
            });
            await writer.close();
            const before = await businessRows(example), reader = await sourceHarness(example);
            const list = await reader.list();
            const row = list.actions.find(action => action.actionId === initial.plan.actions[0].actionId);
            expect(list).toMatchObject({ scope: { ...example.scope, planId: 'shared-plan' }, planRevision: 3,
                source: { assessmentId: 'assessment-a', assessmentRevision: 'rev-2' },
                priority: { status: 'not_calculated', reason: 'priority_adapter_required' },
                order: 'due_date_then_action_id' });
            expect(row).toMatchObject({ ownerSubjectKey: OWNER, ownerEligibility: 'not_checked', dueDate: '2026-09-06',
                status: 'completed', isOverdue: false, completion: { note: 'Synthetic completion.' },
                evidence: { completionReference: 'evidence:synthetic-list', completionVerification: 'not_verified',
                    durableLinkStatus: 'not_established', downloadAllowed: false, scoreEffect: 'none' } });
            expect(row.history.map(event => event.type)).toEqual(['assign', 'start', 'complete']);
            expect(reader.boundaries).toEqual(['BEGIN', 'COMMIT']);
            expect(reader.auditTransactions).toEqual(reader.transactions);
            expect(await reader.audits()).toEqual([expect.objectContaining({ transaction_id: reader.transactions[0],
                payload: expect.objectContaining({ ...example.scope, action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' }) })]);
            expect(reader.queries.some(sql => /dashboard_improvement_revisions/.test(sql))).toBe(true);
            expect(reader.queries.some(sql => /dashboard_ncsc_assessment_revisions/.test(sql))).toBe(true);
            expect(reader.queries.some(sql => /dashboard_tenants/.test(sql) && /FOR UPDATE/.test(sql))).toBe(true);
            expect(await businessRows(example)).toEqual(before);
            await reader.close();
            const restarted = await sourceHarness(example);
            expect(await restarted.source.execute({}, assign)).toEqual(assigned);
            expect(assigned.plan.revision).toBe(1);
            expect(restarted.events).toEqual([]); expect(restarted.auditTransactions).toEqual([]);
            expect(await restarted.audits()).toEqual([]);
            expect(restarted.transactions).toHaveLength(1);
            expect(restarted.boundaries).toEqual(['BEGIN', 'COMMIT']);
            expect(await businessRows(example)).toEqual(before);
            expect(await rows(example)).toHaveLength(4);
            expect(await restarted.list()).toEqual(list);
            expect(list.planRevision).toBe(3);
            expect(restarted.events.map(event => event.action)).toEqual(['improvement.read']);
            expect(restarted.transactions).toHaveLength(2);
            expect(restarted.auditTransactions).toEqual([restarted.transactions[1]]);
            expect(await restarted.audits()).toEqual([expect.objectContaining({
                transaction_id: restarted.transactions[1], payload: restarted.events[0] })]);
            expect(await businessRows(example)).toEqual(before);
            expect(await rows(example)).toHaveLength(4);
            await restarted.source.execute({}, command(saved.plan, 'reopen', 'reopen-list', { reason: 'Synthetic follow-up.' }));
            const afterReopen = await businessRows(example);
            const filtered = await restarted.list({ planId: 'shared-plan', filters: { status: 'open', owner: OWNER, overdueOnly: true } });
            expect(filtered).toMatchObject({ planRevision: 4, counts: { visible: { total: 1, overdue: 1 } } });
            expect(filtered.actions[0]).toMatchObject({ actionId: row.actionId, status: 'open', completion: null,
                evidence: { completionReference: null, completionVerification: 'not_recorded', durableLinkStatus: 'not_established' } });
            expect(filtered.actions[0].history.map(event => event.type)).toEqual(['assign', 'start', 'complete', 'reopen']);
            expect(filtered.actions[0].history[2].details.evidenceReference).toBe('evidence:synthetic-list');
            expect((await restarted.list()).counts.all).toEqual(filtered.counts.all);
            expect(await businessRows(example)).toEqual(afterReopen);
            for (const table of Object.keys(before).filter(name => !TABLES.includes(name))) expect(afterReopen[table]).toEqual(before[table]);
        });

        test('native list selection stays tenant-bound and rejects copied contexts or forged selector scope before transaction entry', async () => {
            const a = await generated(), b = await generated(), h = await sourceHarness(a.example);
            const list = await h.list();
            expect(list.scope).toEqual({ ...a.example.scope, planId: a.initial.plan.planId });
            expect(list.actions.map(row => row.actionId)).toEqual(expect.arrayContaining(a.initial.plan.actions.map(row => row.actionId)));
            expect(list.actions.some(row => b.initial.plan.actions.some(foreign => row.actionId === foreign.actionId))).toBe(false);
            await expect(h.list({ ...selector('shared-plan'), tenantId: b.example.scope.tenantId }))
                .rejects.toMatchObject({ code: 'improvement_list_input_invalid', statusCode: 400 });
            expect(h.resolutions).toBe(1); expect(h.transactions).toHaveLength(1);
            const copied = await sourceHarness(a.example, { context: { ...a.example.context } });
            await expect(copied.list()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
            expect(copied.transactions).toEqual([]); expect(await copied.audits()).toEqual([]);
        });

        test('committed membership revocation denies an earlier genuine context before retained disclosure or audit', async () => {
            const { example } = await generated(), before = await businessRows(example), h = await sourceHarness(example);
            await removeMember(example);
            await expect(h.list()).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
            expect(h.events).toEqual([]); expect(await h.audits()).toEqual([]);
            expect(h.boundaries).toEqual(['BEGIN', 'ROLLBACK']);
            expect(await businessRows(example)).toEqual(before);
        });

        test('real retained-history corruption withholds the list without a read audit', async () => {
            const { example } = await generated(), h = await sourceHarness(example);
            await ownerPool.query("UPDATE nofries.dashboard_improvement_revisions SET payload=jsonb_set(payload,'{resultSha256}',to_jsonb($2::text)) WHERE tenant_id=$1",
                [example.scope.tenantId, 'f'.repeat(64)]);
            const before = await businessRows(example);
            await expect(h.list()).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
            expect(h.events).toEqual([]); expect(await h.audits()).toEqual([]);
            expect(h.boundaries).toEqual(['BEGIN', 'ROLLBACK']);
            expect(await businessRows(example)).toEqual(before);
        });

        test.each(['audit', 'commit'])('native %s failure withholds the list and rolls back its audit without automatic retry', async phase => {
            const { example } = await generated(), before = await businessRows(example);
            const h = await sourceHarness(example, phase === 'audit' ? { failAudit: true } : { failCommit: true });
            const outcome = await capture(h.list());
            expect(outcome.value).toBeUndefined();
            expect(outcome.error).toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
            expect(JSON.stringify(outcome.error)).not.toMatch(/private|postgres|nf_action_list/);
            expect(h.events).toHaveLength(1); expect(h.transactions).toHaveLength(1);
            expect(h.auditTransactions).toEqual(h.transactions);
            expect(h.boundaries).toEqual(phase === 'audit' ? ['BEGIN', 'ROLLBACK'] : ['BEGIN', 'COMMIT', 'ROLLBACK']);
            if (phase === 'commit') expect(h.commitFailure).toBe('23503'); // Actual deferred PostgreSQL FK failure.
            expect(await h.audits()).toEqual([]); expect(await businessRows(example)).toEqual(before);
        });

        test('a recorded membership end passing at genuine successful COMMIT still returns the list with its committed audit', async () => {
            const { example } = await generated(), before = await businessRows(example);
            const h = await sourceHarness(example, { afterCommit() { clock.set(example.state.membershipState.memberships[0].validUntil); } });
            const outcome = await capture(h.list());
            expect(outcome.error).toBeUndefined(); expect(outcome.value).toBeDefined(); // Accounts do not expire.
            expect(h.boundaries).toEqual(['BEGIN', 'COMMIT']);
            expect(h.transactions).toHaveLength(1); expect(h.auditTransactions).toEqual(h.transactions);
            expect(await h.audits()).toEqual([expect.objectContaining({ transaction_id: h.transactions[0],
                payload: expect.objectContaining({ action: 'improvement.read', result: 'succeeded' }) })]);
            expect(await businessRows(example)).toEqual(before);
        });
    });

    describe('reassessment carry-forward', () => {
        async function reassessed(description, seedOptions) {
            // The fixture grant allows two assessment runs at one unit each.
            const { example, initial } = await generated(seedOptions ? await seed(seedOptions) : null);
            const [a, b, c, d] = initial.plan.actions.map(action => action.actionId);
            let plan = initial.plan;
            const run = async (actionId, type, payload) => {
                clock.advance(1000);
                plan = (await repository.executeImprovementPlan(example.context, { planId: plan.planId, type,
                    operationId: `${type}-${plan.revision}`, expectedRevision: plan.revision, actionId, payload })).plan;
            };
            const label = { ownerLabel: 'Ops lead', dueDate: '2026-10-01' }, owner = { ownerSubjectKey: OWNER, dueDate: '2026-11-01' };
            await run(a, 'assign', label);
            await run(b, 'assign', owner); await run(b, 'start', {});
            await run(c, 'assign', label); await run(c, 'start', {}); await run(c, 'block', { reason: 'Waiting on supplier.' });
            await run(d, 'assign', owner); await run(d, 'start', {});
            await run(d, 'complete', { note: 'Synthetic work done.', evidenceReference: 'evidence:synthetic-1' });
            const before = await planRows(example, plan.planId);
            clock.advance(60000);
            await ncsc.executeNcscAssessment(example.context, createCommand('assessment-b', 'create-b', description));
            await ncsc.executeNcscAssessment(example.context, saveCommand('assessment-b', 0, 'save-b', allResponses('no')));
            const second = await ncsc.executeNcscAssessment(example.context, submitCommand('assessment-b', 1, 'submit-b'));
            clock.advance(1000);
            return { example, previous: plan, before, second, generate: { planId: 'plan-b', type: 'generate', operationId: 'generate-b',
                expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-b',
                    assessmentRevision: second.assessment.revision, assessmentRevisionSha256: second.assessment.revisionSha256 } } };
        }
        async function planRows(example, planId) {
            return (await ownerPool.query('SELECT * FROM nofries.dashboard_improvement_revisions WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 ORDER BY revision',
                [example.scope.tenantId, example.scope.organisationId, planId])).rows;
        }

        test('a new plan carries owners, due dates and open work by question as ordinary appended commands', async () => {
            const { example, previous, before, generate } = await reassessed();
            const created = await repository.executeImprovementPlan(example.context, generate);
            expect(created.plan.revision).toBe(0);
            const read = await makeRepository({ database, clock: clock.now }).readImprovementPlan(example.context, { planId: 'plan-b' });
            const byItem = new Map(previous.actions.map(action => [action.itemId, action]));
            expect(read.plan.actions.slice(0, 5).map(action => [byItem.get(action.itemId).actionId !== action.actionId,
                action.status, action.ownerLabel ?? action.ownerSubjectKey, action.dueDate, action.blockedReason]))
                .toEqual([[true, 'open', 'Ops lead', '2026-10-01', null], [true, 'in_progress', OWNER, '2026-11-01', null],
                    [true, 'blocked', 'Ops lead', '2026-10-01', 'Waiting on supplier.'], [true, 'open', OWNER, '2026-11-01', null],
                    [true, 'open', null, null, null]]);
            expect(read.history.map(entry => entry.type)).toEqual(['generate', 'assign', 'assign', 'start', 'assign', 'start', 'block', 'assign']);
            const stored = await planRows(example, 'plan-b'), sourceHead = before.at(-1).payload_sha256;
            expect(stored.slice(1).map(row => row.operation_id)).toEqual(stored.slice(1).map(row => `carry:${sourceHead}:${row.revision}`));
            expect(stored.slice(1).every(row => row.payload.intent.actorSubjectKey === SUBJECT && row.assessment_id === 'assessment-b')).toBe(true);
            // The previous plan is read, never changed; an identical retry adds nothing.
            expect(await planRows(example, previous.planId)).toEqual(before);
            expect(await repository.executeImprovementPlan(example.context, generate)).toEqual(created);
            expect(await planRows(example, 'plan-b')).toEqual(stored);
        });

        test('a carried record construction failure aborts generation and leaves no partial plan', async () => {
            const { example, generate } = await reassessed();
            const path = '../api/shared/improvementPlan/improvementPlanStore';
            const { makeRecord } = require(path);
            const original = jest.requireActual(path).makeRecord;
            const { ImprovementPlanServiceError } = require('../api/shared/improvementPlan/improvementPlanService');
            makeRecord.mockImplementation((intent, ...args) => {
                if (intent.command.type === 'start') throw new ImprovementPlanServiceError();
                return original(intent, ...args);
            });
            try {
                await expect(repository.executeImprovementPlan(example.context, generate))
                    .rejects.toMatchObject({ code: 'improvement_unavailable' });
                expect(await planRows(example, generate.planId)).toEqual([]);
            } finally {
                makeRecord.mockImplementation(original);
            }
        });

        test('an owner who is no longer a member is not carried, and labelled owners still are', async () => {
            const { example, generate } = await reassessed();
            await removeMember(example, OWNER);
            await repository.executeImprovementPlan(example.context, generate);
            const read = await repository.readImprovementPlan(example.context, { planId: 'plan-b' });
            expect(read.plan.actions.slice(0, 4).map(action => [action.status, action.ownerLabel ?? action.ownerSubjectKey]))
                .toEqual([['open', 'Ops lead'], ['open', null], ['blocked', 'Ops lead'], ['open', null]]);
            expect(read.history).toHaveLength(5);
        });

        test('a different-scope plan is never carried from, and a same-scope plan behind it still is', async () => {
            const { example, previous, before, generate } = await reassessed('Synthetic warehouse systems only.', { capacity: 3 });
            const fresh = await repository.executeImprovementPlan(example.context, generate);
            expect((await repository.readImprovementPlan(example.context, { planId: 'plan-b' })).history).toHaveLength(1);
            expect(fresh.plan.counts.unassigned).toBe(fresh.plan.counts.total);
            // assessment-c repeats assessment-a's scope: the newer plan-b is skipped.
            clock.advance(1000);
            await ncsc.executeNcscAssessment(example.context, createCommand('assessment-c', 'create-c'));
            await ncsc.executeNcscAssessment(example.context, saveCommand('assessment-c', 0, 'save-c', allResponses('no')));
            const third = await ncsc.executeNcscAssessment(example.context, submitCommand('assessment-c', 1, 'submit-c'));
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, { ...generate, planId: 'plan-c', operationId: 'generate-c',
                payload: { assessmentId: 'assessment-c', assessmentRevision: third.assessment.revision,
                    assessmentRevisionSha256: third.assessment.revisionSha256 } });
            const stored = await planRows(example, 'plan-c');
            expect(stored).toHaveLength(8);
            expect(stored.slice(1).every(row => row.operation_id.startsWith(`carry:${before.at(-1).payload_sha256}:`))).toBe(true);
            expect(await planRows(example, previous.planId)).toEqual(before);
        });

        async function submitAssessment(example, id, description) {
            clock.advance(1000);
            await ncsc.executeNcscAssessment(example.context, createCommand(id, `create-${id}`, description));
            await ncsc.executeNcscAssessment(example.context, saveCommand(id, 0, `save-${id}`, allResponses('no')));
            const { assessment } = await ncsc.executeNcscAssessment(example.context, submitCommand(id, 1, `submit-${id}`));
            clock.advance(1000);
            return { assessmentId: id, assessmentRevision: assessment.revision, assessmentRevisionSha256: assessment.revisionSha256 };
        }
        const planFrom = (planId, payload) => ({ planId, type: 'generate', operationId: `generate-${planId}`,
            expectedRevision: null, actionId: null, payload });

        test('a previous plan that no longer validates does not block generation and carries nothing', async () => {
            const { example, previous, generate } = await reassessed();
            await ownerPool.query("UPDATE nofries.dashboard_improvement_revisions SET payload=jsonb_set(payload,'{resultSha256}',to_jsonb($3::text)) WHERE tenant_id=$1 AND plan_id=$2",
                [example.scope.tenantId, previous.planId, 'f'.repeat(64)]);
            const created = await repository.executeImprovementPlan(example.context, generate);
            expect(created.plan.counts.unassigned).toBe(created.plan.counts.total);
            expect(await planRows(example, 'plan-b')).toHaveLength(1);
        });

        test('the newest same-scope assessment wins over a plan generated later for an older assessment', async () => {
            const example = await seed({ capacity: 3 });
            const older = { assessmentId: 'assessment-a', assessmentRevision: example.submitted.assessment.revision,
                assessmentRevisionSha256: example.submitted.assessment.revisionSha256 };
            const newer = await submitAssessment(example, 'assessment-b');
            let plan = (await repository.executeImprovementPlan(example.context, planFrom('plan-b', newer))).plan;
            plan = (await repository.executeImprovementPlan(example.context, command(plan, 'assign', 'assign-b', { ownerLabel: 'Newer', dueDate: '2026-10-01' }))).plan;
            clock.advance(1000);
            // Generated later, but from the older assessment: nothing newer may carry into it.
            let stale = (await repository.executeImprovementPlan(example.context, planFrom('plan-old', older))).plan;
            expect(await planRows(example, 'plan-old')).toHaveLength(1);
            stale = (await repository.executeImprovementPlan(example.context, command(stale, 'assign', 'assign-old', { ownerLabel: 'Stale', dueDate: '2026-10-01' }))).plan;
            const latest = await submitAssessment(example, 'assessment-c');
            const created = await repository.executeImprovementPlan(example.context, planFrom('plan-c', latest));
            const read = await repository.readImprovementPlan(example.context, { planId: 'plan-c' });
            expect(created.plan.revision).toBe(0);
            expect(read.plan.actions[0]).toMatchObject({ ownerLabel: 'Newer' });
            const sourceHead = (await planRows(example, 'plan-b')).at(-1).payload_sha256;
            expect((await planRows(example, 'plan-c')).slice(1).map(row => row.operation_id)).toEqual([`carry:${sourceHead}:1`]);
        });

        // The previous-plan query on main (2b00084) with the flag off, verbatim: it
        // had no profile condition. The query is now always profile-scoped; on
        // v1-only data both must pick the same plan, as each v1 assessment stores
        // the full accepted profileRef.
        const MAIN_FLAG_OFF_SQL = `SELECT p.plan_id FROM nofries.dashboard_improvement_revisions p
        JOIN nofries.dashboard_ncsc_assessment_revisions a ON a.tenant_id=p.tenant_id AND a.organisation_id=p.organisation_id AND a.assessment_id=p.assessment_id AND a.revision=p.assessment_revision AND a.payload_sha256=p.assessment_sha256
        JOIN nofries.dashboard_ncsc_assessment_revisions n ON n.tenant_id=p.tenant_id AND n.organisation_id=p.organisation_id AND n.assessment_id=$4 AND n.revision=$5 AND n.payload_sha256=$6
        WHERE p.tenant_id=$1 AND p.organisation_id=$2 AND p.plan_id<>$3 AND p.revision=0 AND p.assessment_id<>$4
        AND a.payload->'scopePopulation'->'body' = n.payload->'scopePopulation'->'body'
        AND a.payload#>>'{submission,input,moduleId}' = n.payload#>>'{submission,input,moduleId}'
        AND (a.payload#>>'{submission,input,scoreAsOf}') COLLATE "C" <= (n.payload#>>'{submission,input,scoreAsOf}') COLLATE "C"
        ORDER BY (a.payload#>>'{submission,input,scoreAsOf}') COLLATE "C" DESC, (p.payload->>'at') COLLATE "C" DESC, p.plan_id COLLATE "C" DESC LIMIT 1`;

        test('flag off, v1-only data: the profile-scoped lookup picks the same previous plan as main', async () => {
            const store = require('../api/shared/improvementPlan/improvementPlanStore');
            const { ACCEPTED_NCSC_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');
            const flag = process.env.NOFRIES_NCSC_PROFILE_V2;
            delete process.env.NOFRIES_NCSC_PROFILE_V2;
            try {
                const example = await seed({ capacity: 5 });
                const sources = { 'assessment-a': { assessmentId: 'assessment-a', assessmentRevision: example.submitted.assessment.revision,
                    assessmentRevisionSha256: example.submitted.assessment.revisionSha256 } };
                sources['assessment-b'] = await submitAssessment(example, 'assessment-b');
                sources['assessment-w'] = await submitAssessment(example, 'assessment-w', 'Synthetic warehouse systems only.');
                sources['assessment-c'] = await submitAssessment(example, 'assessment-c');
                // Plans generated out of assessment order, plus one for another scope.
                const order = [['plan-b', 'assessment-b'], ['plan-a', 'assessment-a'], ['plan-w', 'assessment-w'], ['plan-c', 'assessment-c'],
                    ['plan-b2', 'assessment-b']];
                const chosen = [];
                for (const [planId, assessmentId] of order) {
                    const payload = sources[assessmentId];
                    const source = { assessmentId, revision: payload.assessmentRevision, revisionSha256: payload.assessmentRevisionSha256 };
                    const scope = { ...example.scope, planId };
                    const [now, main] = await rawTransaction(example.scope, async tx => [await store.previousPlanId(tx, scope, source),
                        (await tx.query(MAIN_FLAG_OFF_SQL, [example.scope.tenantId, example.scope.organisationId, planId,
                            source.assessmentId, source.revision, source.revisionSha256])).rows.map(row => row.plan_id)[0] ?? null]);
                    expect(now).toBe(main);
                    chosen.push([planId, now]);
                    clock.advance(1000);
                    await repository.executeImprovementPlan(example.context, planFrom(planId, payload));
                }
                expect(chosen).toEqual([['plan-b', null], ['plan-a', null], ['plan-w', null], ['plan-c', 'plan-b'], ['plan-b2', 'plan-a']]);
                // Every v1 assessment stored the full accepted reference, so the profile condition holds for each pair.
                const refs = (await ownerPool.query("SELECT DISTINCT payload#>'{submission,input,profileRef}' AS ref FROM nofries.dashboard_ncsc_assessment_revisions WHERE tenant_id=$1 AND payload->'submission' <> 'null'::jsonb",
                    [example.scope.tenantId])).rows.map(row => row.ref);
                expect(refs).toEqual([{ ...ACCEPTED_NCSC_CONTEXT.profileRef }]);
                expect(Object.keys(refs[0]).sort()).toEqual(['catalogueSha256', 'frameworkId', 'frameworkVersion', 'profileId',
                    'profileVersion', 'sourceCatalogueSha256']);
            } finally {
                if (flag === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = flag;
            }
        });

        test('plans from another organisation or another tenant are never selected', async () => {
            const store = require('../api/shared/improvementPlan/improvementPlanStore');
            const { example, second } = await reassessed(), other = await seed();
            const source = { assessmentId: 'assessment-b', revision: second.assessment.revision, revisionSha256: second.assessment.revisionSha256 };
            const lookup = (txScope, scope) => rawTransaction(txScope, tx => store.previousPlanId(tx, { ...scope, planId: 'plan-b' }, source));
            expect(await lookup(example.scope, example.scope)).toBe('shared-plan');
            expect(await lookup(example.scope, { ...example.scope, organisationId: 'other-organisation' })).toBeNull();
            expect(await lookup(other.scope, example.scope)).toBeNull();
            expect(await lookup(other.scope, other.scope)).toBeNull();
        });
    });

    // Scoring v2 (#399): plans for an assessment stored on profile 2026-11-18.1.
    describe('plans for scoring v2 results', () => {
        const ncscStore = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
        const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');
        const LATER = '2026-11-19T09:00:00.000Z';
        const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
            'no', 'ad_hoc', 'partly', 'no', 'unknown'];
        const v2Responses = () => NCSC_V2_CONTEXT.questionIds.map((itemId, index) => ({ itemId, optionId: EXAMPLE[index], rationale: null }));
        const original = process.env.NOFRIES_NCSC_PROFILE_V2;
        const setFlag = value => { if (value === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = value; };
        afterEach(() => setFlag(original));

        // One organisation listing both profiles, with a policy that names the profile asked for.
        async function organisation() {
            setFlag('true'); clock.set(LATER);
            const fixture = ncscFixture({ tenantId: `improvement-v2-${run}-${++sequence}`, now: clock.now(), capacity: 5,
                profileRefs: [ACCEPTED_NCSC_CONTEXT.profileRef, NCSC_V2_CONTEXT.profileRef] });
            const product = fixture.state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
            product.modules.push('improvement_plan'); product.modules.sort();
            product.code = 'dashboard_score';
            fixture.state.flags.enabled.governance_workflow = false;
            const adapters = createNcscAdapters(clock);
            const assessments = createPostgresDashboardRepository({ database, clock: clock.now, authoriseAdministration: () => true,
                ncsc: { audit: adapters.audit, resolveSubmissionQuota: selection => ({ ...adapters.resolveSubmissionQuota(selection),
                    profileRef: clone(selection.profileRef) }) } });
            await initialiseNcsc(assessments, fixture, `bootstrap-v2-${sequence}`);
            const context = await createContext(fixture.scope, clock);
            return { ...fixture, context, assessments };
        }
        async function planRows(example, planId) {
            return (await ownerPool.query('SELECT * FROM nofries.dashboard_improvement_revisions WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 ORDER BY revision',
                [example.scope.tenantId, example.scope.organisationId, planId])).rows;
        }
        // Creation still uses the accepted profile, so the v2 first version is stored directly.
        async function submitV2(example, assessmentId) {
            const command = createCommand(assessmentId, 'create-' + assessmentId);
            const created = ncscStore.makeVersion(ncscStore.stableIntent(example.context, command), command.idempotencyKey, null,
                example.state.tenantAggregate, clock.now(), NCSC_V2_CONTEXT);
            await database.withTenantTransaction(example.scope.tenantId, async tx => {
                await ncscStore.appendVersion(tx, created); await ncscStore.moveHead(tx, created);
            });
            await example.assessments.executeNcscAssessment(example.context, saveCommand(assessmentId, 0, 'save-' + assessmentId, v2Responses()));
            return example.assessments.executeNcscAssessment(example.context, submitCommand(assessmentId, 1, 'submit-' + assessmentId));
        }
        async function submitV1(example, assessmentId) {
            await example.assessments.executeNcscAssessment(example.context, createCommand(assessmentId, 'create-' + assessmentId));
            await example.assessments.executeNcscAssessment(example.context, saveCommand(assessmentId, 0, 'save-' + assessmentId, allResponses('no')));
            return example.assessments.executeNcscAssessment(example.context, submitCommand(assessmentId, 1, 'submit-' + assessmentId));
        }
        const generateFor = (submitted, planId) => ({ planId, type: 'generate', operationId: 'generate-' + planId, expectedRevision: null,
            actionId: null, payload: { assessmentId: submitted.assessment.assessmentId, assessmentRevision: submitted.assessment.revision,
                assessmentRevisionSha256: submitted.assessment.revisionSha256 } });
        const actionFor = (plan, itemId) => plan.actions.find(action => action.itemId === itemId);
        function assignLabel(plan, itemId, operationId) {
            return { planId: plan.planId, type: 'assign', operationId, expectedRevision: plan.revision,
                actionId: actionFor(plan, itemId).actionId, payload: { ownerLabel: 'Office manager', dueDate: '2026-12-01' } };
        }

        test('flag on: a v2 result generates its plan from its own profile, and it survives restart and replay', async () => {
            const example = await organisation();
            const submitted = await submitV2(example, 'assessment-v2');
            expect(submitted.assessment.profileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
            clock.advance(1000);
            const created = await repository.executeImprovementPlan(example.context, generateFor(submitted, 'plan-v2'));
            expect(created.plan.source.provenance).toMatchObject({ scoreContractVersion: 'PROD-003-R2',
                profileRef: NCSC_V2_CONTEXT.profileRef, assessmentId: 'assessment-v2' });
            expect(created.plan.actions.map(action => action.itemId).sort()).toEqual([...NCSC_V2_CONTEXT.questionIds].sort());
            expect(actionFor(created.plan, 'NF-NCSC-CC-SU-01-Q1')).toMatchObject({ kind: 'implementation', response: 'no',
                controlId: 'NF-NCSC-CC-SU-01', suggestedAction: 'List who has access, turn on the extra login step, and add a breach-notice clause.' });
            expect(actionFor(created.plan, 'NF-NCSC-CC-EM-01-Q1')).toMatchObject({ kind: 'assessment', response: 'unknown' });
            expect(actionFor(created.plan, 'NF-NCSC-MCSS-MF-01-Q2')).toMatchObject({ kind: 'implementation', response: 'partial',
                suggestedAction: 'Move those accounts off text or email codes to an app, passkey or security key.' });
            clock.advance(1000);
            const assigned = await repository.executeImprovementPlan(example.context, assignLabel(created.plan, 'NF-NCSC-CC-SU-01-Q1', 'assign-v2'));
            const restarted = makeRepository({ database, clock: clock.now });
            const read = await restarted.readImprovementPlan(example.context, { planId: 'plan-v2' });
            expect(read.plan).toEqual(assigned.plan);
            expect(await restarted.executeImprovementPlan(example.context, generateFor(submitted, 'plan-v2'))).toEqual(created);
        });

        test('flag turned off again: a v2 plan is not read and no v2 plan is generated, and both work once it is back on', async () => {
            const example = await organisation();
            const first = await submitV2(example, 'assessment-v2');
            const second = await submitV2(example, 'assessment-v3');
            clock.advance(1000);
            const created = await repository.executeImprovementPlan(example.context, generateFor(first, 'plan-v2'));
            for (const value of [undefined, 'TRUE', '1']) {
                setFlag(value);
                await expect(repository.readImprovementPlan(example.context, { planId: 'plan-v2' })).rejects.toBeTruthy();
                await expect(repository.executeImprovementPlan(example.context, generateFor(second, 'plan-v3'))).rejects.toBeTruthy();
            }
            expect(await planRows(example, 'plan-v3')).toEqual([]);
            setFlag('true');
            expect((await repository.readImprovementPlan(example.context, { planId: 'plan-v2' })).plan).toEqual(created.plan);
        });

        test('a v2 plan carries from an earlier v2 plan only, never from a v1 plan', async () => {
            const example = await organisation();
            const v1 = await submitV1(example, 'assessment-a');
            clock.advance(1000);
            const v1Plan = await repository.executeImprovementPlan(example.context, generateFor(v1, 'plan-a'));
            // Work on a question id that v2 keeps.
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, assignLabel(v1Plan.plan, 'NF-NCSC-MCSS-MF-01-Q1', 'assign-a'));
            clock.advance(1000);
            const first = await submitV2(example, 'assessment-b');
            clock.advance(1000);
            const fresh = await repository.executeImprovementPlan(example.context, generateFor(first, 'plan-b'));
            expect((await repository.readImprovementPlan(example.context, { planId: 'plan-b' })).history).toHaveLength(1);
            expect(actionFor(fresh.plan, 'NF-NCSC-MCSS-MF-01-Q1')).toMatchObject({ status: 'open', ownerSubjectKey: null, dueDate: null });
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, assignLabel(fresh.plan, 'NF-NCSC-CC-SU-01-Q1', 'assign-b'));
            clock.advance(1000);
            const later = await submitV2(example, 'assessment-c');
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, generateFor(later, 'plan-c'));
            const read = await repository.readImprovementPlan(example.context, { planId: 'plan-c' });
            expect(read.history).toHaveLength(2);
            expect(actionFor(read.plan, 'NF-NCSC-CC-SU-01-Q1')).toMatchObject({ ownerLabel: 'Office manager', dueDate: '2026-12-01', status: 'open' });
            expect(actionFor(read.plan, 'NF-NCSC-MCSS-MF-01-Q1')).toMatchObject({ ownerSubjectKey: null, dueDate: null });
        });

        // #399 item 5 (flag rollback): a v2 plan exists, the flag is turned off,
        // and a v1 assessment is submitted. Its plan must be made fresh, not
        // fail with 503 trying to read the v2 plan as its previous plan.
        test('flag rolled back after a v2 plan: a v1 plan generates fresh and never carries from the v2 plan', async () => {
            const store = require('../api/shared/improvementPlan/improvementPlanStore');
            const example = await organisation();
            const v2 = await submitV2(example, 'assessment-v2');
            clock.advance(1000);
            const v2Plan = await repository.executeImprovementPlan(example.context, generateFor(v2, 'plan-v2'));
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, assignLabel(v2Plan.plan, 'NF-NCSC-MCSS-MF-01-Q1', 'assign-v2'));
            const v2Rows = await planRows(example, 'plan-v2');
            setFlag(undefined);
            clock.advance(1000);
            const v1 = await submitV1(example, 'assessment-v1');
            expect(v1.assessment.profileRef).toEqual(ACCEPTED_NCSC_CONTEXT.profileRef);
            clock.advance(1000);
            const source = { assessmentId: 'assessment-v1', revision: v1.assessment.revision, revisionSha256: v1.assessment.revisionSha256 };
            expect(await rawTransaction(example.scope, tx => store.previousPlanId(tx, { ...example.scope, planId: 'plan-v1' }, source))).toBeNull();
            const created = await repository.executeImprovementPlan(example.context, generateFor(v1, 'plan-v1'));
            expect(created.plan.revision).toBe(0);
            expect(created.plan.source.provenance).toMatchObject({ scoreContractVersion: 'PROD-003-R1',
                profileRef: ACCEPTED_NCSC_CONTEXT.profileRef, assessmentId: 'assessment-v1' });
            expect(actionFor(created.plan, 'NF-NCSC-MCSS-MF-01-Q1')).toMatchObject({ status: 'open', ownerSubjectKey: null, dueDate: null });
            expect(created.plan.counts.unassigned).toBe(created.plan.counts.total);
            expect(await planRows(example, 'plan-v1')).toHaveLength(1);
            expect((await repository.readImprovementPlan(example.context, { planId: 'plan-v1' })).history).toHaveLength(1);
            // The v2 plan is left as it was, and reads again once the flag is back on.
            expect(await planRows(example, 'plan-v2')).toEqual(v2Rows);
            setFlag('true');
            expect((await repository.readImprovementPlan(example.context, { planId: 'plan-v2' })).history).toHaveLength(2);
        });

        test('flag rolled back: a v2 plan reached as previous is skipped, a same-profile assessment error still aborts', async () => {
            const store = require('../api/shared/improvementPlan/improvementPlanStore');
            const example = await organisation();
            const v2 = await submitV2(example, 'assessment-v2');
            clock.advance(1000);
            await repository.executeImprovementPlan(example.context, generateFor(v2, 'plan-v2'));
            setFlag(undefined);
            clock.advance(1000);
            const first = await submitV1(example, 'assessment-v1');
            clock.advance(1000);
            const spy = jest.spyOn(store, 'previousPlanId');
            let load = null;
            try {
                // As if the lookup still picked the v2 plan (main with the flag off): the
                // carry-forward read fails on the v2 profile and the plan starts fresh.
                spy.mockResolvedValueOnce('plan-v2');
                const created = await repository.executeImprovementPlan(example.context, generateFor(first, 'plan-v1'));
                expect(spy).toHaveBeenCalledTimes(1);
                expect(created.plan.revision).toBe(0);
                expect(await planRows(example, 'plan-v1')).toHaveLength(1);
                // An unreadable previous source on the same profile is not swallowed:
                // corrupt the first v1 assessment's history and generate from a second.
                clock.advance(1000);
                const second = await submitV1(example, 'assessment-v1b');
                clock.advance(1000);
                expect(await rawTransaction(example.scope, tx => store.previousPlanId(tx, { ...example.scope, planId: 'plan-v1b' },
                    { assessmentId: 'assessment-v1b', revision: second.assessment.revision, revisionSha256: second.assessment.revisionSha256 })))
                    .toBe('plan-v1');
                await ownerPool.query("UPDATE nofries.dashboard_ncsc_assessment_revisions SET payload=jsonb_set(payload,'{state,updatedAt}',to_jsonb('2026-01-01T00:00:00.000Z'::text)) WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id='assessment-v1' AND revision=0",
                    [example.scope.tenantId, example.scope.organisationId]);
                await expect(repository.executeImprovementPlan(example.context, generateFor(second, 'plan-v1b')))
                    .rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
                expect(await planRows(example, 'plan-v1b')).toEqual([]);
                // A database error while reading the previous plan still aborts too.
                const actual = store.loadHistory;
                load = jest.spyOn(store, 'loadHistory').mockImplementation((tx, scope, ...rest) => (scope.planId === 'plan-v1'
                    ? Promise.reject(Object.assign(new Error('Synthetic database failure'), { code: '57P01' })) : actual(tx, scope, ...rest)));
                await expect(repository.executeImprovementPlan(example.context, generateFor(second, 'plan-v1b')))
                    .rejects.toMatchObject({ code: 'improvement_unavailable' });
                expect(load.mock.calls.some(([, scope]) => scope.planId === 'plan-v1')).toBe(true);
                expect(await planRows(example, 'plan-v1b')).toEqual([]);
            } finally {
                spy.mockRestore();
                if (load) load.mockRestore();
            }
        });
    });
});
