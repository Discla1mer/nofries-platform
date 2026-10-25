'use strict';

// Registered by the existing real-PostgreSQL gate. All setup is synthetic.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createPostgresDatabase, PostgresDatabaseError } = require('../../api/shared/database/postgres');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { hashNcscRecord } = require('../../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const ncscStore = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');
const { ncscFixture, createClock, createContext, createNcscAdapters, initialiseNcsc,
    allResponses, createCommand, saveCommand, submitCommand, NOW, SUBJECT, clone } = require('../fixtures/ncscAssessmentFixture');

const DATA_TABLES = ['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states',
    'dashboard_entitlement_states', 'dashboard_feature_flags', 'dashboard_advisor_assignments',
    'dashboard_usage', 'dashboard_operation_receipts'];
const NCSC_TABLES = ['dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts'];
const TABLES = [...DATA_TABLES, ...NCSC_TABLES];
const capture = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

module.exports = function registerNcscAssessmentPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    const describeDatabase = testUrl ? describe : describe.skip;
    describeDatabase('Accepted NCSC lifecycle in real PostgreSQL', () => {
        const runKey = crypto.randomBytes(8).toString('hex'), role = `ncsc_test_${runKey}`;
        const password = `synthetic-ncsc-only-${runKey}`, applicationName = `ncsc-runtime-${runKey}`;
        const recoveryName = `ncsc_restore_${runKey}`, createdTenants = [];
        const clock = createClock();
        let ownerPool, runtimePool, database, repository, adapters, sequence = 0, roleCreated = false;
        let recoveryCreated = false, recoveryOwner, recoveryRuntime, closeRecoveryOwner, closeRecoveryRuntime;
        const makeRepository = (db = database, configured = adapters) => createPostgresDashboardRepository({
            database: db, clock: clock.now, authoriseAdministration: () => true,
            ncsc: { audit: configured.audit, resolveSubmissionQuota: configured.resolveSubmissionQuota } });

        async function seed(options = {}) {
            const example = ncscFixture({ tenantId: `ncsc-${runKey}-${++sequence}`, now: clock.now(), ...options });
            createdTenants.push(example.scope.tenantId);
            const initial = await initialiseNcsc(repository, example, `bootstrap-${sequence}`);
            return { ...example, context: await createContext(example.scope, clock), vector: initial.resultRevisions };
        }
        async function ready(example, assessmentId = 'assessment-a', responses = allResponses()) {
            const created = await repository.executeNcscAssessment(example.context, createCommand(assessmentId));
            const saved = await repository.executeNcscAssessment(example.context, saveCommand(assessmentId, 0, 'save-a', responses));
            return { created, saved };
        }
        async function usageOf(scope, pool = ownerPool) {
            return (await pool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2 AND grant_id=$3',
                [scope.tenantId, scope.organisationId, 'synthetic-product'])).rows[0].payload;
        }
        async function assessmentRows(scope, pool = ownerPool) {
            return (await exportTenant(pool, scope.tenantId));
        }
        async function rawTransaction(scope, work, pool = runtimePool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                if (scope) await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [scope.tenantId]);
                return await work(client);
            } finally { await client.query('ROLLBACK'); client.release(); }
        }
        async function holdingTenant(scope, work) {
            return rawTransaction(scope, async client => {
                await client.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR UPDATE', [scope.tenantId]);
                return work(client);
            });
        }
        async function waitForBlockedTenantQuery() {
            const deadline = Date.now() + 5000;
            do {
                const result = await ownerPool.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%dashboard_tenants%'", [applicationName]);
                if (result.rows[0].count > 0) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            } while (Date.now() < deadline);
            throw new Error('Synthetic NCSC writer did not reach its tenant lock.');
        }
        async function updatePayload(client, table, scope, payload) {
            expect(DATA_TABLES).toContain(table);
            await client.query(`UPDATE nofries.${table} SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2`,
                [scope.tenantId, scope.organisationId, payload.revision, JSON.stringify(payload)]);
        }
        async function changeAuthority(example, type, payload) {
            const current = await repository.readAuthoritySnapshot(example.scope, { authenticated: true, subjectKey: SUBJECT });
            return repository.executeAuthorityCommand({ ...example.scope, type, operationId: `authority-${++sequence}`,
                actorSubjectKey: SUBJECT, expectedRevisions: current.revisions, payload });
        }
        function interceptQuery(intercept) {
            return { withTenantTransaction: (tenantId, work) => database.withTenantTransaction(tenantId, tx => work({
                query: async (sql, params) => intercept(sql, params, () => tx.query(sql, params))
            })) };
        }

        beforeAll(async () => {
            const { Pool } = require('pg');
            ownerPool = new Pool({ connectionString: testUrl, max: 3, application_name: `ncsc-owner-${runKey}` });
            await applyMigrations({ pool: ownerPool });
            await ownerPool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quoteLiteral(password)}`);
            roleCreated = true;
            await ownerPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(role)}`);
            runtimePool = new Pool({ connectionString: databaseUrl(testUrl, { username: role, password }),
                max: 6, application_name: applicationName, statement_timeout: 15000 });
            database = createPostgresDatabase({ pool: runtimePool });
        });
        beforeEach(() => { clock.set(NOW); adapters = createNcscAdapters(clock); repository = makeRepository(); });
        afterAll(async () => {
            if (closeRecoveryRuntime) await closeRecoveryRuntime();
            if (closeRecoveryOwner) await closeRecoveryOwner();
            if (runtimePool) await runtimePool.end();
            if (ownerPool) {
                try {
                    if (recoveryCreated) await ownerPool.query(`DROP DATABASE ${quoteIdentifier(recoveryName)}`);
                    for (const table of [...TABLES].reverse()) {
                        await ownerPool.query(`DELETE FROM nofries.${table} WHERE tenant_id=ANY($1::text[])`, [createdTenants]);
                    }
                    if (roleCreated) await ownerPool.query(`DROP ROLE ${quoteIdentifier(role)}`);
                } finally { await ownerPool.end(); }
            }
        });

        test('installs an identical-checksum additive migration with forced RLS, scoped foreign keys and restricted runtime grants', async () => {
            expect((await applyMigrations({ pool: ownerPool })).applied).toEqual([]);
            const checksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../database/migrations/0004_ncsc_assessments.sql'))).digest('hex');
            expect((await ownerPool.query("SELECT checksum_sha256 FROM nofries.schema_migrations WHERE migration_id='0004_ncsc_assessments.sql'")).rows)
                .toEqual([{ checksum_sha256: checksum }]);
            const relations = (await ownerPool.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nofries' AND c.relname=ANY($1::text[])", [NCSC_TABLES])).rows;
            expect(relations).toHaveLength(3);
            for (const row of relations) {
                expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true }); expect(row.owner).not.toBe(role);
            }
            expect((await runtimePool.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows)
                .toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
            const keys = (await ownerPool.query("SELECT pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relname=ANY($1::text[]) AND k.contype='f'", [NCSC_TABLES])).rows;
            expect(keys).toHaveLength(4);
            keys.forEach(row => expect(row.definition).toMatch(/^FOREIGN KEY \(tenant_id, organisation_id/));
            for (const table of NCSC_TABLES) {
                const privileges = (await ownerPool.query("SELECT has_table_privilege('nofries_runtime',$1,'SELECT') AS read,has_table_privilege('nofries_runtime',$1,'INSERT') AS insert,has_table_privilege('nofries_runtime',$1,'UPDATE') AS update,has_table_privilege('nofries_runtime',$1,'DELETE') AS delete,has_table_privilege('nofries_runtime',$1,'TRUNCATE') AS truncate", [`nofries.${table}`])).rows[0];
                expect(privileges).toEqual({ read: true, insert: true, update: table === 'dashboard_ncsc_assessments', delete: false, truncate: false });
            }
        });

        test('identical organisation, assessment and idempotency IDs remain isolated by tenant and unscoped RLS returns no records', async () => {
            const first = await seed(), second = await seed();
            const a = await repository.executeNcscAssessment(first.context, createCommand('assessment-a', 'shared-key', 'Synthetic population A'));
            const b = await repository.executeNcscAssessment(second.context, createCommand('assessment-a', 'shared-key', 'Synthetic population B'));
            expect(a.assessment.scopePopulation.description).toBe('Synthetic population A');
            expect(b.assessment.scopePopulation.description).toBe('Synthetic population B');
            expect((await repository.readNcscAssessment(first.context, { assessmentId: 'assessment-a' })).assessment).toEqual(a.assessment);
            for (const table of NCSC_TABLES) {
                expect(await rawTransaction(null, async client => (await client.query(`SELECT * FROM nofries.${table}`)).rows)).toEqual([]);
                const rows = await rawTransaction(first.scope, async client => (await client.query(`SELECT tenant_id FROM nofries.${table}`)).rows);
                expect(rows.length).toBeGreaterThan(0); rows.forEach(row => expect(row.tenant_id).toBe(first.scope.tenantId));
            }
            await expect(rawTransaction(first.scope, client => client.query('INSERT INTO nofries.dashboard_ncsc_assessments SELECT * FROM nofries.dashboard_ncsc_assessments WHERE tenant_id=$1', [second.scope.tenantId])))
                .resolves.toMatchObject({ rowCount: 0 });
            await expect(rawTransaction(first.scope, client => client.query('INSERT INTO nofries.dashboard_ncsc_assessments (tenant_id,organisation_id,assessment_id,schema_version,revision,payload_sha256) VALUES ($1,$2,$3,1,0,$4)',
                [second.scope.tenantId, second.scope.organisationId, 'cross-scope-probe', 'a'.repeat(64)])))
                .rejects.toMatchObject({ code: '42501' });
        });

        test('questionnaire controls persist exact progress through client, handler, service and PostgreSQL across remount and safe retries', async () => {
            const { createNcscQuestionnaireMetadata } = require('../../api/shared/ncscQuestionnaireMetadata');
            const { createClient } = require('../../api/shared/protectedAssets/ncscAssessmentClient');
            const questionnaire = require('../../api/shared/protectedAssets/ncscQuestionnaire');
            const { createNcscAssessmentService } = require('../../api/shared/ncscAssessmentService');
            const { createNcscAssessmentHandlers } = require('../../api/shared/ncscAssessmentHandlers');
            const { createDom } = require('../fixtures/dashboardDom');
            const metadata = createNcscQuestionnaireMetadata(), prefix = '/api/dashboard/ncsc/assessments';
            const first = await seed(), second = await seed(), denied = await seed({ role: 'viewer' });
            let idSequence = 0;
            const createId = () => `00000000-0000-4000-8000-${String(++idSequence).padStart(12, '0')}`;
            const spin = () => new Promise(resolve => setImmediate(resolve));
            async function until(predicate) {
                const deadline = Date.now() + 10000;
                while (!predicate() && Date.now() < deadline) await spin();
                expect(Boolean(predicate())).toBe(true);
            }
            function composed(example, options = {}) {
                // Each composition creates a fresh repository instance over the
                // restricted runtime pool. No browser-side scope is accepted.
                const current = makeRepository(), calls = [];
                const service = createNcscAssessmentService({ repository: current,
                    requestContext: { resolve: async () => createContext(example.scope, clock) } });
                const handlers = createNcscAssessmentHandlers({ service, guardMutation: async () => true });
                let loseSave = options.loseSave === true;
                const client = createClient({ metadata, fetch: async (url, init) => {
                    const parsed = new URL(url, 'https://synthetic.invalid');
                    const relative = decodeURIComponent(parsed.pathname.slice(prefix.length).replace(/^\//, ''));
                    const body = init.body === undefined ? undefined : JSON.parse(init.body);
                    if (body) calls.push({ assessmentId: relative ? relative.split('/')[0] : body.assessmentId,
                        action: relative ? relative.split('/')[1] : 'create', idempotencyKey: body.idempotencyKey,
                        expectedRevision: body.expectedRevision, payload: body.payload });
                    const result = await handlers.handleRequest({ method: init.method, query: Object.fromEntries(parsed.searchParams),
                        ...(body === undefined ? {} : { body }) }, relative);
                    if (loseSave && relative.endsWith('/save') && result.status === 200) {
                        loseSave = false; throw new Error('Synthetic response lost after real SQL commit');
                    }
                    return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
                } });
                return { client, calls };
            }
            function uiFor(transport) {
                const dom = createDom(), original = dom.document.createElement;
                dom.document.createElement = tag => {
                    const element = original(tag);
                    Object.defineProperty(element, 'id', { get: () => element.getAttribute('id') || '', set: value => element.setAttribute('id', value) });
                    element.removeChild = child => { element.children = element.children.filter(item => item !== child); child.parentElement = null; return child; };
                    return element;
                };
                dom.root = dom.document.createElement('div');
                dom.controller = questionnaire.mount(dom.root, { metadata, client: transport.client, presentationMode: 'editable',
                    generation: {}, window: dom.window, createId });
                return dom;
            }
            const button = (ui, label) => ui.root.querySelectorAll('button').find(item => item.textContent === label);
            const id = (ui, key) => ui.root.querySelectorAll('[id]').find(item => item.id === key);
            const emit = (element, name) => { for (const fn of element.events[name] || []) fn({ target: element, currentTarget: element, preventDefault() {} }); };
            const enter = (element, value) => { element.value = value; emit(element, 'input'); };
            function answer(ui, index, option, text) {
                const select = id(ui, 'ncsc-question-index'); select.value = String(index); emit(select, 'change');
                const question = metadata.questions[index], radio = id(ui, `ncsc-answer-${question.id}-${option}`);
                radio.checked = true; emit(radio, 'change');
                if (text !== undefined) enter(id(ui, `ncsc-rationale-${question.id}`), text);
            }
            async function resume(transport) {
                const ui = uiFor(transport);
                await until(() => ui.root.querySelectorAll('button').some(item => / · .*answered$/.test(item.textContent)));
                ui.root.querySelectorAll('button').find(item => / · .*answered$/.test(item.textContent)).click();
                await until(() => id(ui, 'ncsc-question-index')); return ui;
            }

            const transport = composed(first, { loseSave: true }); let ui = uiFor(transport);
            await until(() => button(ui, 'Start an assessment')); button(ui, 'Start an assessment').click();
            const declaration = '  Synthetic cloud and office services.\nMāori \uD83D\uDE80  ';
            enter(id(ui, 'ncsc-scope'), declaration); button(ui, 'Create assessment').click();
            await until(() => button(ui, 'Save progress'));
            const assessmentId = transport.calls[0].assessmentId, rationale = '  Synthetic pending N/A claim.\n界 \uD83D\uDE80  ';
            answer(ui, 0, 'not_applicable', rationale); button(ui, 'Save progress').click();
            await until(() => button(ui, 'Retry same operation'));
            expect((await repository.readNcscAssessment(first.context, { assessmentId })).assessment.revision).toBe(1);
            expect(await ui.controller.requestLeave()).toBe(false);
            button(ui, 'Retry same operation').click();
            await until(() => ui.root.textContent.includes('The operation is confirmed and the current saved version has been checked.'));
            expect(transport.calls[2]).toEqual(transport.calls[1]);
            expect((await usageOf(first.scope)).counters.assessment_runs).toBe(0);
            ui.controller.destroy();

            const restarted = composed(first); ui = await resume(restarted);
            const resumedQuestion = id(ui, 'ncsc-question-index');
            expect(resumedQuestion.value).toBe('1');
            resumedQuestion.value = '0'; emit(resumedQuestion, 'change');
            expect(id(ui, `ncsc-rationale-${metadata.questions[0].id}`).value).toBe(rationale);
            expect(ui.root.textContent).toContain(declaration);
            button(ui, 'Clear answer').click(); button(ui, 'Save progress').click();
            await until(() => ui.root.textContent.includes('Saved revision 2'));
            expect((await restarted.client.read(assessmentId)).assessment.responses).toEqual([]);
            metadata.questions.forEach((_question, index) => answer(ui, index, index === 0 ? 'not_applicable' : 'unknown', index === 0 ? rationale : undefined));
            button(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Saved revision 3'));
            ui.controller.destroy(); const finalTransport = composed(first); ui = await resume(finalTransport);
            button(ui, 'Submit assessment').click(); await until(() => !button(ui, 'Submit assessment'));
            const sealed = (await finalTransport.client.read(assessmentId)).assessment;
            expect(sealed).toMatchObject({ status: 'submitted', revision: 4, scopePopulation: { description: declaration },
                submission: { revision: 4, evaluation: { countsCompletion: { claimedNotApplicableAtoms: 1, approvedNotApplicableAtoms: 0 } } } });
            expect((await finalTransport.client.submit(finalTransport.calls.at(-1))).assessment).toEqual(sealed);
            expect((await usageOf(first.scope)).counters.assessment_runs).toBe(1);
            const retained = await assessmentRows(first.scope);
            expect(retained.dashboard_ncsc_assessment_revisions).toHaveLength(5);
            expect(retained.dashboard_ncsc_assessment_receipts).toHaveLength(5);
            ui.controller.destroy(); ui = await resume(composed(first));
            expect(button(ui, 'Save progress')).toBeUndefined(); expect(ui.root.querySelectorAll('input').every(input => input.disabled)).toBe(true);
            ui.controller.destroy();

            const other = composed(second);
            await expect(other.client.read(assessmentId)).rejects.toMatchObject({ code: 'ncsc_not_found' });
            await expect(other.client.save(saveCommand(assessmentId, 0, 'foreign-save'))).rejects.toMatchObject({ code: 'ncsc_not_found' });
            await other.client.create(createCommand(assessmentId, 'create-other', 'Different tenant population'));
            expect((await other.client.read(assessmentId)).assessment.scopePopulation.description).toBe('Different tenant population');
            expect((await finalTransport.client.read(assessmentId)).assessment).toEqual(sealed);
            await expect(composed(denied).client.create(createCommand('forged-editable-hint'))).rejects.toMatchObject({ code: 'ncsc_access_denied' });
            expect(await assessmentRows(first.scope)).toEqual(retained);
        }, 60000);

        test.each(['save', 'submit'])('NCSC009 candidate %s size413 rolls back every restricted PostgreSQL state and audit effect', async action => {
            const example = await seed(), text = '\u0001'.repeat(action === 'save' ? 4000 : 2800);
            const responses = allResponses('not_applicable').map(row => ({ ...row, rationale: { text } }));
            await repository.executeNcscAssessment(example.context, createCommand());
            const count = action === 'save' ? 10 : responses.length;
            for (let index = 0; index < count; index += 2) {
                const command = saveCommand('assessment-a', index / 2, `size-batch-${index}`, responses.slice(index, index + 2));
                expect(Buffer.byteLength(JSON.stringify(command), 'utf8')).toBeLessThanOrEqual(65536);
                await repository.executeNcscAssessment(example.context, command);
            }
            const revision = count / 2, before = await assessmentRows(example.scope);
            const eventCount = adapters.events.length, policyCount = adapters.policySelections.length;
            const command = action === 'save' ? saveCommand('assessment-a', revision, 'rejected-size-save', responses.slice(10, 12))
                : submitCommand('assessment-a', revision, 'rejected-size-submit');
            expect(Buffer.byteLength(JSON.stringify(command), 'utf8')).toBeLessThanOrEqual(65536);
            await expect(repository.executeNcscAssessment(example.context, command))
                .rejects.toMatchObject({ code: 'ncsc_request_too_large', statusCode: 413 });
            // exportTenant includes all eight DATA tables and all three NCSC
            // tables: head, immutable versions, quota, receipts and durable audit.
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(0);
            expect(adapters.events).toHaveLength(eventCount); expect(adapters.policySelections).toHaveLength(policyCount);
            expect((await repository.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).assessment.revision).toBe(revision);
            const shorter = (action === 'save' ? responses.slice(10, 12) : responses.slice(0, 2))
                .map(row => ({ ...row, rationale: { text: 'Shorter synthetic pending claim.' } }));
            const corrected = await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', revision, 'corrected-size-save', shorter));
            expect(corrected.assessment.revision).toBe(revision + 1);
            if (action === 'submit') {
                const sealed = await repository.executeNcscAssessment(example.context, submitCommand('assessment-a', revision + 1, 'corrected-size-submit'));
                expect(sealed.assessment.status).toBe('submitted');
                expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
            }
        }, 60000);

        test('NCSC009 PostgreSQL measures its actual JSONB text before effects and committed replay does not repeat candidate measurement', async () => {
            const example = await seed(); const created = await repository.executeNcscAssessment(example.context, createCommand());
            const responses = allResponses('not_applicable').map((row, index) => ({ ...row, rationale: { text: '\u0001'.repeat(index === 0 ? 3800 : 2800) } }));
            for (let index = 0; index < 12; index += 2) {
                await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', index / 2, `pg-jsonb-${index}`, responses.slice(index, index + 2)));
            }
            const previous = (await ownerPool.query('SELECT payload,payload_sha256 FROM nofries.dashboard_ncsc_assessment_revisions WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3 AND revision=6',
                [example.scope.tenantId, example.scope.organisationId, 'assessment-a'])).rows[0];
            const command = saveCommand('assessment-a', 6, 'pg-jsonb-overflow', responses.slice(12));
            const candidate = ncscStore.makeVersion(ncscStore.stableIntent(example.context, command), command.idempotencyKey,
                { envelope: previous.payload, revisionSha256: previous.payload_sha256 }, example.state.tenantAggregate, NOW);
            const encoded = JSON.stringify(candidate.envelope);
            expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(262144);
            const sizeSql = 'SELECT octet_length($1::jsonb::text) AS payload_bytes';
            const measured = (await ownerPool.query(sizeSql, [encoded])).rows[0].payload_bytes;
            expect(measured).toBeGreaterThan(262144);
            const before = await assessmentRows(example.scope), eventCount = adapters.events.length, policyCount = adapters.policySelections.length;
            await expect(repository.executeNcscAssessment(example.context, command)).rejects.toMatchObject({ code: 'ncsc_request_too_large', statusCode: 413 });
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect(adapters.events).toHaveLength(eventCount); expect(adapters.policySelections).toHaveLength(policyCount);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(0);

            let measurementAttempts = 0;
            const failedMeasurement = makeRepository(interceptQuery(async (sql, _params, next) => {
                if (sql === sizeSql) { measurementAttempts += 1; throw Object.assign(new Error('Synthetic measurement driver failure'), { code: 'XX000' }); }
                return next();
            }));
            const shorter = responses.slice(12).map(row => ({ ...row, rationale: { text: 'Shorter synthetic claim.' } }));
            await expect(failedMeasurement.executeNcscAssessment(example.context, saveCommand('assessment-a', 6, 'pg-measurement-failed', shorter)))
                .rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
            expect(measurementAttempts).toBe(1); expect(await assessmentRows(example.scope)).toEqual(before);
            expect(await failedMeasurement.executeNcscAssessment(example.context, createCommand())).toEqual(created);
            expect(measurementAttempts).toBe(1); expect(await assessmentRows(example.scope)).toEqual(before);
        }, 60000);

        test('NCSC009 maximum supported CJK rationales retain exact text through restricted PostgreSQL save and submit', async () => {
            const example = await seed(), responses = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '界'.repeat(4000) } }));
            await repository.executeNcscAssessment(example.context, createCommand());
            for (let index = 0; index < responses.length; index += 2) {
                await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', index / 2, `cjk-size-${index}`, responses.slice(index, index + 2)));
            }
            const command = submitCommand('assessment-a', responses.length / 2, 'cjk-size-submit');
            const result = await repository.executeNcscAssessment(example.context, command);
            expect(result.assessment.responses.map(row => row.rationale.text)).toEqual(responses.map(row => row.rationale.text));
            const stored = await assessmentRows(example.scope);
            expect((await repository.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).assessment).toEqual(result.assessment);
            expect(await repository.executeNcscAssessment(example.context, command)).toEqual(result);
            expect(await assessmentRows(example.scope)).toEqual(stored);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
        }, 60000);

        test.each(['malformed', 'oversized'])('NCSC009 retained %s data over restricted PostgreSQL remains503 and cannot be repaired by a new command', async kind => {
            const example = await seed(); await ready(example);
            const retained = (await ownerPool.query('SELECT payload FROM nofries.dashboard_ncsc_assessment_revisions WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3 AND revision=1',
                [example.scope.tenantId, example.scope.organisationId, 'assessment-a'])).rows[0].payload;
            if (kind === 'oversized') retained.scopePopulation.body.description = 'x'.repeat(256 * 1024);
            else retained.state.status = 'invalid-retained-status';
            const update = () => ownerPool.query('UPDATE nofries.dashboard_ncsc_assessment_revisions SET payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3 AND revision=1',
                [example.scope.tenantId, example.scope.organisationId, 'assessment-a', JSON.stringify(retained)]);
            let reading = repository;
            if (kind === 'oversized') {
                // The real table refuses oversized data. Separately inject a
                // corrupt driver-returned retained record after a real scoped
                // SELECT to verify 503 without pretending that row was stored.
                await expect(update()).rejects.toMatchObject({ code: '23514' });
                reading = makeRepository(interceptQuery(async (sql, _params, next) => {
                    const result = await next();
                    return sql.startsWith('SELECT * FROM nofries.dashboard_ncsc_assessment_revisions')
                        ? { ...result, rows: result.rows.map(row => row.revision === 1 ? { ...row, payload: clone(retained) } : row) } : result;
                }));
            } else await update();
            const before = await assessmentRows(example.scope), eventCount = adapters.events.length;
            await expect(reading.readNcscAssessment(example.context, { assessmentId: 'assessment-a' }))
                .rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
            await expect(reading.executeNcscAssessment(example.context, saveCommand('assessment-a', 1, 'cannot-repair-size')))
                .rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect(adapters.events).toHaveLength(eventCount); expect((await usageOf(example.scope)).counters.assessment_runs).toBe(0);
        });

        test('persists partial saves, pending rationale, exact original retries and one durable successful audit event per mutation', async () => {
            const example = await seed();
            const created = await repository.executeNcscAssessment(example.context, createCommand());
            const responses = allResponses(); responses[0] = { ...responses[0], optionId: 'not_applicable', rationale: { text: '  Synthetic N/A claim.  ' } };
            const firstSave = saveCommand('assessment-a', 0, 'partial-a', responses.slice(0, 7));
            await repository.executeNcscAssessment(example.context, firstSave);
            await expect(repository.executeNcscAssessment(example.context, submitCommand('assessment-a', 1, 'incomplete')))
                .rejects.toMatchObject({ code: 'ncsc_state_conflict' });
            const saved = await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', 1, 'partial-b', responses.slice(7)));
            const submitted = await repository.executeNcscAssessment(example.context, submitCommand('assessment-a', 2));
            expect(submitted.assessment.submission).toMatchObject({ revision: 3, submittedAt: NOW,
                evaluation: { countsCompletion: { claimedNotApplicableAtoms: 1, approvedNotApplicableAtoms: 0, unknown: 1 } } });
            expect(submitted.assessment.responses[0]).toHaveProperty('rationale');
            expect(await repository.executeNcscAssessment(example.context, createCommand())).toEqual(created);
            expect(await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', 1, 'partial-b', responses.slice(7)))).toEqual(saved);
            expect(await repository.executeNcscAssessment(example.context, submitCommand('assessment-a', 2))).toEqual(submitted);
            const records = await assessmentRows(example.scope);
            expect(records.dashboard_ncsc_assessment_revisions).toHaveLength(4);
            expect(records.dashboard_ncsc_assessment_receipts).toHaveLength(4);
            const events = records.dashboard_ncsc_assessment_receipts.map(row => row.payload.event);
            expect(new Set(events.map(event => event.eventId)).size).toBe(4);
            events.forEach(event => expect(event).toMatchObject({ actorSubjectKey: SUBJECT, ...example.scope,
                action: 'assessment.write', module: 'cyber_security', result: 'succeeded' }));
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
            expect(adapters.policySelections).toHaveLength(1);
            expect(adapters.events).toHaveLength(0);
            const restarted = makeRepository();
            expect(await restarted.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).toEqual({ schemaVersion: 1, assessment: submitted.assessment });
            expect(await assessmentRows(example.scope)).toEqual(records);
            expect(adapters.events).toHaveLength(1);
        });

        test('lists closed summaries with deterministic bounded keyset pages', async () => {
            const example = await seed();
            for (const id of ['assessment-b', 'assessment-A', 'assessment-a']) await repository.executeNcscAssessment(example.context, createCommand(id));
            const first = await repository.listNcscAssessments(example.context, { limit: 2, afterAssessmentId: null });
            expect(first.assessments.map(row => row.assessmentId)).toEqual(['assessment-A', 'assessment-a']);
            expect(first.nextAfterAssessmentId).toBe('assessment-a');
            const second = await repository.listNcscAssessments(example.context, { limit: 2, afterAssessmentId: first.nextAfterAssessmentId });
            expect(second.assessments.map(row => row.assessmentId)).toEqual(['assessment-b']);
            expect(second.nextAfterAssessmentId).toBeNull();
            first.assessments.forEach(row => expect(Object.keys(row).sort()).toEqual([
                'assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress'
            ].sort()));
        });

        test('rejects runtime history rewrites/deletion/truncation and foreign or missing revision references', async () => {
            const example = await seed(); await ready(example);
            for (const table of NCSC_TABLES) {
                for (const operation of ['DELETE', 'TRUNCATE', ...(table === 'dashboard_ncsc_assessments' ? [] : ['UPDATE'])]) {
                    const sql = operation === 'DELETE' ? `DELETE FROM nofries.${table}` : operation === 'TRUNCATE'
                        ? `TRUNCATE nofries.${table}` : `UPDATE nofries.${table} SET schema_version=1`;
                    await expect(rawTransaction(example.scope, client => client.query(sql))).rejects.toMatchObject({ code: '42501' });
                }
            }
            await expect(rawTransaction(example.scope, client => client.query('UPDATE nofries.dashboard_ncsc_assessments SET revision=2,payload_sha256=$1', ['f'.repeat(64)])))
                .rejects.toMatchObject({ code: '23503' });
            await expect(rawTransaction(example.scope, client => client.query('UPDATE nofries.dashboard_ncsc_assessments SET assessment_id=$1', ['missing-assessment'])))
                .rejects.toMatchObject({ code: '23503' });
            const original = (await assessmentRows(example.scope)).dashboard_ncsc_assessment_revisions[0];
            for (const kind of ['missing-parent', 'revision-jump', 'wrong-owner', 'over-bound']) {
                const candidate = clone(original); candidate.assessment_id = `constraint-${kind}`;
                candidate.payload.assessmentId = candidate.assessment_id; candidate.payload.state.assessmentId = candidate.assessment_id;
                candidate.revision = 1; candidate.payload.revision = 1; candidate.payload.state.revision = 1;
                candidate.parent_revision = 0; candidate.parent_sha256 = 'f'.repeat(64);
                if (kind === 'revision-jump') candidate.parent_revision = 2;
                if (kind === 'wrong-owner') candidate.payload.tenantId = 'foreign-tenant';
                if (kind === 'over-bound') candidate.revision = candidate.payload.revision = candidate.payload.state.revision = 129;
                const columns = Object.keys(candidate);
                await expect(rawTransaction(example.scope, client => client.query(
                    `INSERT INTO nofries.dashboard_ncsc_assessment_revisions (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
                    columns.map(column => candidate[column])))).rejects.toMatchObject({ code: kind === 'missing-parent' ? '23503' : '23514' });
            }
        });

        test('serializes stale concurrent saves and returns one revision conflict', async () => {
            const example = await seed(); await repository.executeNcscAssessment(example.context, createCommand());
            const results = await Promise.all([saveCommand('assessment-a', 0, 'save-left'), saveCommand('assessment-a', 0, 'save-right')]
                .map(command => capture(repository.executeNcscAssessment(example.context, command))));
            expect(results.filter(row => row.ok)).toHaveLength(1);
            expect(results.find(row => !row.ok).error.code).toBe('ncsc_revision_conflict');
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessment_revisions).toHaveLength(2);
        });

        test('concurrent identical submission retries preserve one result, one receipt and one charge', async () => {
            const example = await seed({ capacity: 1 }); await ready(example);
            const request = submitCommand();
            const results = await Promise.all([repository.executeNcscAssessment(example.context, request), repository.executeNcscAssessment(example.context, request)]);
            expect(results[1]).toEqual(results[0]);
            expect((await usageOf(example.scope))).toMatchObject({ revision: 1, counters: { assessment_runs: 1 } });
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessment_receipts).toHaveLength(3);
            expect(adapters.policySelections).toHaveLength(1);
        });

        test('two submissions competing for the final finite quota unit cannot both commit', async () => {
            const example = await seed({ capacity: 1 }); await ready(example, 'assessment-a'); await ready(example, 'assessment-b');
            const results = await Promise.all(['assessment-a', 'assessment-b'].map(id => capture(repository.executeNcscAssessment(example.context, submitCommand(id)))));
            expect(results.filter(row => row.ok)).toHaveLength(1);
            expect(results.find(row => !row.ok).error.code).toBe('ncsc_quota_exceeded');
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessment_revisions).toHaveLength(5);
        });

        test('original submission replays after later charges and agreement renewal without selecting or charging the new grant', async () => {
            const example = await seed({ capacity: 3 }); await ready(example);
            const original = await repository.executeNcscAssessment(example.context, submitCommand());
            await ready(example, 'assessment-b'); await repository.executeNcscAssessment(example.context, submitCommand('assessment-b'));
            const entitlement = clone(example.state.entitlementState); entitlement.revision++;
            const old = entitlement.grants.find(grant => grant.grantId === 'synthetic-product');
            const renewed = { ...clone(old), grantId: 'synthetic-product-renewed', agreementRef: 'synthetic-renewal-order' };
            old.status = 'revoked'; entitlement.grants.push(renewed);
            entitlement.grants.sort((a, b) => a.grantId < b.grantId ? -1 : 1);
            await changeAuthority(example, 'entitlement.update', entitlement);
            clock.advance(1000);
            const context = await createContext(example.scope, clock);
            const before = await assessmentRows(example.scope), selections = adapters.policySelections.length;
            expect(await repository.executeNcscAssessment(context, submitCommand())).toEqual(original);
            expect(adapters.policySelections).toHaveLength(selections);
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(2);
            const counters = before.dashboard_usage.find(row => row.grant_id === 'synthetic-product-renewed').payload.counters;
            expect(counters.assessment_runs).toBe(0);
        });

        test('validates the complete bounded history and accepts submission revision 128 while rejecting another write', async () => {
            const example = await seed(), scope = { ...example.scope, assessmentId: 'ceiling-assessment' };
            const intent = command => ({ ...scope, actorSubjectKey: SUBJECT, action: command.action,
                expectedRevision: command.expectedRevision, payload: command.payload });
            let previous = ncscStore.makeVersion(intent(createCommand()), 'ceiling-create', null, example.state.tenantAggregate, NOW);
            const client = await ownerPool.connect();
            try {
                await client.query('BEGIN');
                await ncscStore.appendVersion(client, previous);
                for (let revision = 1; revision <= 127; revision++) {
                    const responses = revision === 1 ? allResponses() : allResponses().slice(0, 1);
                    const next = ncscStore.makeVersion(intent(saveCommand('ceiling-assessment', revision - 1, `ceiling-${revision}`, responses)),
                        `ceiling-${revision}`, previous, example.state.tenantAggregate, NOW);
                    await ncscStore.appendVersion(client, next); previous = next;
                }
                await client.query('INSERT INTO nofries.dashboard_ncsc_assessments (tenant_id,organisation_id,assessment_id,schema_version,revision,payload_sha256) VALUES ($1,$2,$3,1,127,$4)',
                    [scope.tenantId, scope.organisationId, scope.assessmentId, previous.revisionSha256]);
                await client.query('COMMIT');
            } finally { await client.query('ROLLBACK'); client.release(); }
            await expect(repository.executeNcscAssessment(example.context, saveCommand('ceiling-assessment', 127, 'over-save')))
                .rejects.toMatchObject({ code: 'ncsc_state_conflict' });
            const request = submitCommand('ceiling-assessment', 127, 'last-submit');
            const submitted = await repository.executeNcscAssessment(example.context, request);
            expect(submitted.assessment).toMatchObject({ revision: 128, status: 'submitted', submission: { revision: 128 } });
            expect(await repository.executeNcscAssessment(example.context, request)).toEqual(submitted);
            const before = await assessmentRows(example.scope);
            await expect(repository.executeNcscAssessment(example.context, submitCommand('ceiling-assessment', 128, 'over-bound')))
                .rejects.toMatchObject({ code: 'ncsc_state_conflict' });
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect(before.dashboard_ncsc_assessment_revisions).toHaveLength(129);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
        }, 60000);

        test.each(['membership', 'entitlement', 'flags', 'organisation', 'advisor'])('current %s revocation ordered by the tenant fence denies waiting assessment writes', async kind => {
            const example = await seed(kind === 'advisor' ? { role: 'fractional_advisor', service: true } : {});
            let pending;
            await holdingTenant(example.scope, async blocker => {
                pending = capture(repository.executeNcscAssessment(example.context, createCommand()));
                await waitForBlockedTenantQuery();
                if (kind === 'membership') {
                    const member = applyMembershipCommand(example.state.membershipState, example.state.tenantAggregate,
                        { ...example.scope, expectedRevision: example.state.membershipState.revision, actorSubjectKey: SUBJECT,
                            now: NOW, action: 'remove', payload: { membershipId: 'synthetic-membership' } });
                    await updatePayload(blocker, 'dashboard_membership_states', example.scope, member);
                } else if (kind === 'entitlement') {
                    const entitlement = clone(example.state.entitlementState); entitlement.revision++; entitlement.grants[0].status = 'revoked';
                    await updatePayload(blocker, 'dashboard_entitlement_states', example.scope, entitlement);
                } else if (kind === 'flags') {
                    const flags = clone(example.state.flags); flags.revision++; flags.enabled.cyber_security = false;
                    await updatePayload(blocker, 'dashboard_feature_flags', example.scope, flags);
                } else if (kind === 'organisation') {
                    const organisation = clone(example.state.tenantAggregate.organisations[0]); organisation.revision++; organisation.recordStatus = 'suspended';
                    await updatePayload(blocker, 'dashboard_organisations', example.scope, organisation);
                } else {
                    const assignment = clone(example.state.advisorAssignments[0]); assignment.revision++; assignment.status = 'revoked';
                    await blocker.query('UPDATE nofries.dashboard_advisor_assignments SET revision=$3,status=$4,payload=$5::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                        [example.scope.tenantId, example.scope.organisationId, assignment.revision, assignment.status, JSON.stringify(assignment)]);
                }
                await blocker.query('COMMIT');
            });
            const result = await pending;
            expect(result.ok).toBe(false); expect(result.error.code).toBe('ncsc_access_denied');
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessments).toEqual([]);
        });

        test('advisor-only access requires the explicitly purchased active advisory service on first execution and retry', async () => {
            const absent = await seed({ role: 'fractional_advisor' });
            await expect(repository.executeNcscAssessment(absent.context, createCommand())).rejects.toMatchObject({ code: 'ncsc_access_denied' });
            const example = await seed({ role: 'fractional_advisor', service: true });
            const request = createCommand(); await repository.executeNcscAssessment(example.context, request);
            const entitlement = clone(example.state.entitlementState); entitlement.revision++;
            entitlement.grants.find(grant => grant.code === 'fractional_advisory').status = 'revoked';
            await changeAuthority(example, 'entitlement.update', entitlement);
            await expect(repository.executeNcscAssessment(example.context, request)).rejects.toMatchObject({ code: 'ncsc_access_denied' });
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessment_receipts).toHaveLength(1);
        });

        test('samples trusted time after lock waits and rolls back expiry after awaited writes', async () => {
            const expires = '2026-09-07T09:01:00.000Z';
            const example = await seed({ grantEndsAt: expires });
            let pending;
            await holdingTenant(example.scope, async blocker => {
                pending = capture(repository.executeNcscAssessment(example.context, createCommand()));
                await waitForBlockedTenantQuery(); clock.set(expires); await blocker.query('COMMIT');
            });
            expect((await pending).error.code).toBe('ncsc_access_denied');
            clock.set(NOW); await ready(example);
            const before = await assessmentRows(example.scope);
            const expiring = interceptQuery(async (sql, params, query) => {
                const result = await query();
                if (sql.startsWith('INSERT INTO nofries.dashboard_ncsc_assessment_receipts')) clock.set(expires);
                return result;
            });
            await expect(makeRepository(expiring).executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_access_denied' });
            expect(await assessmentRows(example.scope)).toEqual(before);
        });

        test('authorization ends at the final check; expiry during later COMMIT does not rewrite a committed response', async () => {
            const expires = '2026-09-07T09:01:00.000Z', example = await seed({ grantEndsAt: expires }); await ready(example);
            const expiresAtCommit = { withTenantTransaction: (tenantId, work) => database.withTenantTransaction(tenantId, async tx => {
                const result = await work(tx); clock.set(expires); return result;
            }) };
            const result = await makeRepository(expiresAtCommit).executeNcscAssessment(example.context, submitCommand());
            expect(result.assessment.status).toBe('submitted');
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
            await expect(repository.executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_access_denied' });
        });

        test('a first submission cannot charge an expired grant when a future zero-quota grant activates during receipt I/O', async () => {
            const expires = '2026-09-07T09:01:00.000Z', example = await seed({ grantEndsAt: expires });
            await ready(example);
            const entitlement = clone(example.state.entitlementState); entitlement.revision++;
            const original = entitlement.grants.find(grant => grant.grantId === 'synthetic-product');
            entitlement.grants.push({ ...clone(original), grantId: 'synthetic-product-renewed',
                agreementRef: 'synthetic-future-zero-quota', validFrom: expires,
                validUntil: '2026-09-08T09:00:00.000Z',
                limits: { ...original.limits, assessment_runs: 0 } });
            entitlement.grants.sort((a, b) => a.grantId < b.grantId ? -1 : 1);
            await changeAuthority(example, 'entitlement.update', entitlement);
            const before = await assessmentRows(example.scope);
            const rollover = interceptQuery(async (sql, params, query) => {
                const result = await query();
                if (sql.startsWith('INSERT INTO nofries.dashboard_ncsc_assessment_receipts')) clock.set(expires);
                return result;
            });
            await expect(makeRepository(rollover).executeNcscAssessment(example.context, submitCommand()))
                .rejects.toMatchObject({ code: 'ncsc_access_denied', statusCode: 403 });
            expect(await assessmentRows(example.scope)).toEqual(before);
            expect(adapters.events).toEqual([]);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(0);
        });

        test.each(['version', 'head', 'usage', 'receipt'])('failure after the %s write rolls back history, head, charge and receipt together', async boundary => {
            const example = await seed(); await ready(example); const before = await assessmentRows(example.scope);
            const patterns = { version: 'INSERT INTO nofries.dashboard_ncsc_assessment_revisions', head: 'UPDATE nofries.dashboard_ncsc_assessments',
                usage: 'UPDATE nofries.dashboard_usage', receipt: 'INSERT INTO nofries.dashboard_ncsc_assessment_receipts' };
            let injected = false;
            const broken = interceptQuery(async (sql, params, query) => {
                const result = await query();
                if (sql.startsWith(patterns[boundary])) { injected = true; throw new Error('synthetic private database sentinel'); }
                return result;
            });
            await expect(makeRepository(broken).executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable', message: 'ncsc_unavailable' });
            expect(injected).toBe(true); expect(await assessmentRows(example.scope)).toEqual(before);
        });

        test.each(['postgres_commit_failed', 'postgres_rollback_failed'].flatMap(code =>
            ['committed', 'not-committed', 'reconciliation-unavailable'].map(mode => [code, mode])))
        ('reconciles %s without a second mutation: %s', async (errorCode, mode) => {
            const example = await seed(); await ready(example); let calls = 0;
            const uncertain = { withTenantTransaction: async (tenantId, work) => {
                if (++calls === 1) {
                    if (mode !== 'not-committed') await database.withTenantTransaction(tenantId, work);
                    throw new PostgresDatabaseError(errorCode);
                }
                if (mode === 'reconciliation-unavailable') throw new PostgresDatabaseError('postgres_connection_failed');
                return database.withTenantTransaction(tenantId, work);
            } };
            const attempt = await capture(makeRepository(uncertain).executeNcscAssessment(example.context, submitCommand()));
            expect(calls).toBe(2);
            if (mode === 'committed') expect(attempt.ok).toBe(true);
            else { expect(attempt.ok).toBe(false); expect(attempt.error.code).toBe('ncsc_outcome_ambiguous'); }
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(mode === 'not-committed' ? 0 : 1);
            const result = await repository.executeNcscAssessment(example.context, submitCommand());
            if (attempt.ok) expect(result).toEqual(attempt.value);
            expect((await assessmentRows(example.scope)).dashboard_ncsc_assessment_receipts).toHaveLength(3);
            expect((await usageOf(example.scope)).counters.assessment_runs).toBe(1);
        });

        test('read sink failures and read COMMIT failures return unavailable without mutation reconciliation', async () => {
            const example = await seed(); await ready(example); const before = await assessmentRows(example.scope);
            const brokenAudit = createNcscAdapters(clock, { writeEvent: async () => { throw new Error('synthetic private audit sentinel'); } });
            await expect(makeRepository(database, brokenAudit).readNcscAssessment(example.context, { assessmentId: 'assessment-a' }))
                .rejects.toMatchObject({ code: 'ncsc_unavailable', message: 'ncsc_unavailable' });
            for (const listing of [false, true]) {
                let calls = 0;
                const uncertainRead = { withTenantTransaction: async (tenantId, work) => {
                    calls++; await database.withTenantTransaction(tenantId, work); throw new PostgresDatabaseError('postgres_commit_failed');
                } };
                const repo = makeRepository(uncertainRead);
                await expect(listing ? repo.listNcscAssessments(example.context, { limit: 2, afterAssessmentId: null })
                    : repo.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).rejects.toMatchObject({ code: 'ncsc_unavailable' });
                expect(calls).toBe(1);
            }
            expect(await assessmentRows(example.scope)).toEqual(before);
        });

        test('a read whose awaited audit sink crosses expiry returns access denied without an assessment body', async () => {
            const expires = '2026-09-07T09:01:00.000Z', example = await seed({ grantEndsAt: expires }); await ready(example);
            const before = await assessmentRows(example.scope);
            const expiringAudit = createNcscAdapters(clock, { writeEvent: async () => { await Promise.resolve(); clock.set(expires); } });
            await expect(makeRepository(database, expiringAudit).readNcscAssessment(example.context, { assessmentId: 'assessment-a' }))
                .rejects.toMatchObject({ code: 'ncsc_access_denied', statusCode: 403 });
            expect(await assessmentRows(example.scope)).toEqual(before);
        });

        test.each(['olderRevision', 'sameRevisionCounter', 'laterRevisionCounter'])('rejects a mixed restore whose usage is behind the committed charge: %s', async mode => {
            const example = await seed(); await ready(example); const beforeUsage = await usageOf(example.scope);
            await repository.executeNcscAssessment(example.context, submitCommand());
            const usage = mode === 'olderRevision' ? beforeUsage : await usageOf(example.scope);
            usage.counters.assessment_runs = 0; if (mode === 'laterRevisionCounter') usage.revision++;
            await updatePayload(ownerPool, 'dashboard_usage', example.scope, usage);
            const corrupted = await assessmentRows(example.scope);
            await expect(repository.executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
        });

        test('a restore missing the original usage grant cannot manufacture a zero counter or replay success', async () => {
            const example = await seed(); await ready(example); await repository.executeNcscAssessment(example.context, submitCommand());
            await ownerPool.query('DELETE FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2',
                [example.scope.tenantId, example.scope.organisationId]);
            const corrupted = await assessmentRows(example.scope);
            await expect(repository.executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
        });

        test('rejects a receipt ahead of its restored head and an altered version with unchanged digest without repair', async () => {
            const example = await seed(); await ready(example); await repository.executeNcscAssessment(example.context, submitCommand());
            const rows = await assessmentRows(example.scope), versions = rows.dashboard_ncsc_assessment_revisions;
            await ownerPool.query('UPDATE nofries.dashboard_ncsc_assessments SET revision=$3,payload_sha256=$4 WHERE tenant_id=$1 AND organisation_id=$2',
                [example.scope.tenantId, example.scope.organisationId, 1, versions[1].payload_sha256]);
            let corrupted = await assessmentRows(example.scope);
            await expect(repository.executeNcscAssessment(example.context, submitCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
            await ownerPool.query('UPDATE nofries.dashboard_ncsc_assessments SET revision=$3,payload_sha256=$4 WHERE tenant_id=$1 AND organisation_id=$2',
                [example.scope.tenantId, example.scope.organisationId, 2, versions[2].payload_sha256]);
            const payload = clone(versions[1].payload); payload.scopePopulation.body.description = 'Altered synthetic population';
            await ownerPool.query('UPDATE nofries.dashboard_ncsc_assessment_revisions SET payload=$3::jsonb WHERE tenant_id=$1 AND organisation_id=$2 AND revision=1',
                [example.scope.tenantId, example.scope.organisationId, JSON.stringify(payload)]);
            corrupted = await assessmentRows(example.scope);
            await expect(repository.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
        });

        test('rejects a fully rehashed receipt redirected to another valid retained ancestor', async () => {
            const example = await seed(); await ready(example);
            await repository.executeNcscAssessment(example.context, saveCommand('assessment-a', 1, 'save-b', allResponses('partial')));
            const rows = await assessmentRows(example.scope);
            const first = rows.dashboard_ncsc_assessment_receipts.find(row => row.idempotency_key === 'save-a');
            const later = rows.dashboard_ncsc_assessment_receipts.find(row => row.idempotency_key === 'save-b');
            const payload = clone(first.payload);
            for (const key of ['resultRevision', 'versionSha256', 'predecessorSha256', 'result', 'resultSha256']) payload[key] = clone(later.payload[key]);
            payload.resultSha256 = hashNcscRecord('result', payload.result);
            await ownerPool.query('UPDATE nofries.dashboard_ncsc_assessment_receipts SET result_revision=$4,version_sha256=$5,result_sha256=$6,payload=$7::jsonb WHERE tenant_id=$1 AND organisation_id=$2 AND idempotency_key=$3',
                [example.scope.tenantId, example.scope.organisationId, 'save-a', payload.resultRevision, payload.versionSha256, payload.resultSha256, JSON.stringify(payload)]);
            const corrupted = await assessmentRows(example.scope);
            await expect(repository.executeNcscAssessment(example.context, saveCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
        });

        test.each(['reopen-after-submit', 'changed-answers-at-submit'])
        ('rejects a hash-valid, SQL-shaped restored history with an impossible lifecycle: %s', async kind => {
            const example = await seed(); await ready(example);
            if (kind === 'reopen-after-submit') await repository.executeNcscAssessment(example.context, submitCommand());
            const rows = (await assessmentRows(example.scope)).dashboard_ncsc_assessment_revisions;
            const version = row => ({ envelope: clone(row.payload), revisionSha256: row.payload_sha256,
                parentRevision: row.parent_revision, parentSha256: row.parent_sha256 });
            const first = version(rows[0]), saved = version(rows[1]);
            const scope = { ...example.scope, assessmentId: 'assessment-a' };
            let impossible;
            if (kind === 'reopen-after-submit') {
                impossible = clone(saved);
                impossible.envelope.revision = impossible.envelope.state.revision = 3;
                impossible.parentRevision = 2; impossible.parentSha256 = rows[2].payload_sha256;
                impossible.revisionSha256 = hashNcscRecord('version', impossible.envelope);
            } else {
                const alternative = ncscStore.makeVersion({ ...scope, actorSubjectKey: SUBJECT,
                    action: 'save', expectedRevision: 0, payload: { responses: allResponses('no') } },
                'alternative-save', first, example.state.tenantAggregate, NOW);
                impossible = ncscStore.makeVersion({ ...scope, actorSubjectKey: SUBJECT,
                    action: 'submit', expectedRevision: 1, payload: {} },
                'alternative-submit', alternative, example.state.tenantAggregate, NOW);
                // The exact SQL parent exists, but it did not supply these answers.
                impossible.parentSha256 = saved.revisionSha256;
            }
            const client = await ownerPool.connect();
            try {
                await client.query('BEGIN');
                await ncscStore.appendVersion(client, impossible);
                await client.query('UPDATE nofries.dashboard_ncsc_assessments SET revision=$4,payload_sha256=$5 WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3',
                    [scope.tenantId, scope.organisationId, scope.assessmentId, impossible.envelope.revision, impossible.revisionSha256]);
                await client.query('COMMIT');
            } finally { await client.query('ROLLBACK'); client.release(); }
            const corrupted = await assessmentRows(example.scope);
            await expect(repository.readNcscAssessment(example.context, { assessmentId: scope.assessmentId }))
                .rejects.toMatchObject({ code: 'ncsc_unavailable' });
            expect(await assessmentRows(example.scope)).toEqual(corrupted);
        });

        test('restores complete canonical authority, history, quota and original results into a fresh database and restricted pool', async () => {
            const example = await seed({ role: 'fractional_advisor', service: true });
            const responses = allResponses(); responses[0] = { ...responses[0], optionId: 'not_applicable', rationale: { text: 'Synthetic restore claim.' } };
            const { created, saved } = await ready(example, 'assessment-a', responses);
            const submitted = await repository.executeNcscAssessment(example.context, submitCommand());
            const exported = await assessmentRows(example.scope), manifest = await schemaManifest(ownerPool);
            const { Pool } = require('pg');
            await runtimePool.end();
            runtimePool = new Pool({ connectionString: databaseUrl(testUrl, { username: role, password }), max: 6,
                application_name: applicationName, statement_timeout: 15000 });
            database = createPostgresDatabase({ pool: runtimePool }); repository = makeRepository();
            expect(await repository.executeNcscAssessment(example.context, submitCommand())).toEqual(submitted);
            expect(await assessmentRows(example.scope)).toEqual(exported);
            await ownerPool.query(`CREATE DATABASE ${quoteIdentifier(recoveryName)} TEMPLATE template0`); recoveryCreated = true;
            const recoveryUrl = databaseUrl(testUrl, { database: recoveryName });
            recoveryOwner = new Pool({ connectionString: recoveryUrl, max: 2, application_name: `ncsc-restore-owner-${runKey}` });
            closeRecoveryOwner = trackPoolClientEnds(recoveryOwner);
            expect((await applyMigrations({ pool: recoveryOwner })).applied).toContain('0004_ncsc_assessments.sql');
            expect(await schemaManifest(recoveryOwner)).toEqual(manifest);
            const restore = await recoveryOwner.connect();
            try {
                await restore.query('BEGIN');
                for (const table of TABLES) for (const row of exported[table]) {
                    const columns = Object.keys(row);
                    await restore.query(`INSERT INTO nofries.${table} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, columns.map(column => row[column]));
                }
                await restore.query('COMMIT');
            } finally { await restore.query('ROLLBACK'); restore.release(); }
            expect(await exportTenant(recoveryOwner, example.scope.tenantId)).toEqual(exported);
            recoveryRuntime = new Pool({ connectionString: databaseUrl(recoveryUrl, { username: role, password }), max: 2,
                application_name: `ncsc-restored-runtime-${runKey}` });
            closeRecoveryRuntime = trackPoolClientEnds(recoveryRuntime);
            const recovered = makeRepository(createPostgresDatabase({ pool: recoveryRuntime }));
            expect(await recovered.readNcscAssessment(example.context, { assessmentId: 'assessment-a' })).toEqual({ schemaVersion: 1, assessment: submitted.assessment });
            expect(await recovered.executeNcscAssessment(example.context, createCommand())).toEqual(created);
            expect(await recovered.executeNcscAssessment(example.context, saveCommand('assessment-a', 0, 'save-a', responses))).toEqual(saved);
            expect(await recovered.executeNcscAssessment(example.context, submitCommand())).toEqual(submitted);
            expect((await usageOf(example.scope, recoveryOwner))).toMatchObject({ revision: 1, counters: { assessment_runs: 1 } });
            expect(await exportTenant(recoveryOwner, example.scope.tenantId)).toEqual(exported);
            expect(exported.dashboard_ncsc_assessment_revisions.map(row => hashNcscRecord('version', row.payload)))
                .toEqual(exported.dashboard_ncsc_assessment_revisions.map(row => row.payload_sha256));
            expect(manifest.engine).toMatch(/^\d+/);
        }, 60000);
    });
};

function quoteIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function quoteLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function databaseUrl(value, overrides) {
    const parsed = new URL(value);
    if (overrides.username) parsed.username = overrides.username;
    if (overrides.password) parsed.password = overrides.password;
    if (overrides.database) parsed.pathname = `/${overrides.database}`;
    return parsed.toString();
}
async function exportTenant(pool, tenantId) {
    const exported = {}, client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR SHARE', [tenantId]);
        for (const table of TABLES) {
            const order = table === 'dashboard_ncsc_assessment_revisions' ? 'assessment_id, revision' : 'to_jsonb(t)::text';
            exported[table] = (await client.query(`SELECT row_to_json(t) AS record FROM nofries.${table} t WHERE tenant_id=$1 ORDER BY ${order}`, [tenantId])).rows.map(row => row.record);
        }
        await client.query('COMMIT'); return exported;
    } finally { await client.query('ROLLBACK'); client.release(); }
}
async function schemaManifest(pool) {
    return { engine: (await pool.query("SELECT current_setting('server_version') AS engine")).rows[0].engine,
        migrations: (await pool.query('SELECT migration_id,checksum_sha256 FROM nofries.schema_migrations ORDER BY migration_id')).rows,
        columns: (await pool.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='nofries' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position", [TABLES])).rows,
        constraints: (await pool.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nofries' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname", [TABLES])).rows,
        policies: (await pool.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='nofries' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname", [TABLES])).rows };
}
