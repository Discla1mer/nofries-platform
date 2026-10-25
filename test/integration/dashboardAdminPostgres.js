'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createPostgresDashboardAdministrationRepository, createPostgresDashboardRuntimeRepository,
    createPostgresDashboardMaintenanceRepository } = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createAuditEnvelope, projectAuditRow } = require('../../api/shared/dashboardAdmin/auditEnvelope');
const { normaliseSelector } = require('../../api/shared/dashboardAdmin/service');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataCodec } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMigrations } = require('../../scripts/db-migrate');
const { fixture, NOW, SUBJECT } = require('../fixtures/dashboardFixture');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const clone = value => JSON.parse(JSON.stringify(value));
const START = new Date(Date.parse(NOW) - 60000).toISOString();
const END = new Date(Date.parse(NOW) + 3600000).toISOString();
const BUDGET = { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 };
const proposal = fs.readFileSync(path.join(__dirname, '../../database/proposals/dashboard_admin_lookup_audit.sql'), 'utf8');
const quote = name => '"' + name.replace(/"/g, '""') + '"';

function isolatedTestUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('administration_native_tests_require_isolated_database'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/nofries_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) {
        throw new Error('administration_native_tests_require_isolated_database');
    }
    return value;
}

// Registered only by the existing native PostgreSQL test target. Every schema,
// row and synthetic login below belongs to this newly created test database.
module.exports = function registerDashboardAdminPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Finite dashboard administration with restricted PostgreSQL', () => {
        const runKey = crypto.randomBytes(6).toString('hex'), databaseName = 'nf_admin_native_' + runKey,
            runtimeRole = 'nf_admin_runtime_' + runKey, password = 'synthetic-only-' + runKey;
        let control, owner, runtimePool, closeOwner, closeRuntime, databaseCreated = false, roleCreated = false, sequence = 100;
        const nextId = () => '82000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');

        async function harness() {
            const instanceId = nextId(), restoreEpoch = nextId(), identity = { policyId: 'synthetic-admin-native', policyRevision: 1,
                issuer: 'https://identity.example.invalid/v2.0', identityTenantId: nextId(), oid: nextId(), audience: nextId() };
            const actor = identity.identityTenantId + ':' + identity.oid, request = Object.freeze({ syntheticRequestId: nextId() });
            const capture = { requestId: nextId(), deadline: new Date(Date.parse(NOW) + 60000).toISOString(),
                sessionSha256: hash(nextId()), kind: 'operator_dashboard', identityPayload: identity, instanceId, restoreEpoch,
                issuedAt: START, expiresAt: END, discovery: null, operatorIssuanceProof: null };
            capture.operatorIssuanceProof = { schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: capture.sessionSha256,
                identitySha256: hash(identity), instanceId, restoreEpoch, issuedAt: START, expiresAt: END };
            const state = { trace: [], before: null, after: null, loseCommit: false, allowed: true };
            const pool = { end: () => runtimePool.end(), async connect() {
                const client = await runtimePool.connect();
                return { release: value => client.release(value), async query(sql, params = []) {
                    state.trace.push({ sql, params: clone(params) });
                    if (state.before) await state.before(sql, params);
                    const result = await client.query(sql, params);
                    if (state.after) await state.after(sql, params, result);
                    if (sql === 'COMMIT' && state.loseCommit) { state.loseCommit = false; throw new Error('synthetic lost commit response'); }
                    return result;
                } };
            } };
            const common = { clock: () => NOW, instanceId, historyBudget: BUDGET,
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }), newId: nextId };
            const maintenance = createPostgresDashboardMaintenanceRepository({ ...common, pool: owner, authoriseMaintenanceOperation: () => true });
            const command = before => ({ operationId: nextId(), actorSubjectKey: actor, expectedRevision: before?.revision ?? null,
                expectedRecordSha256: before ? hash(before) : null, restoreEpoch,
                evidenceRef: 'synthetic-test-only', evidenceSha256: 'e'.repeat(64) });
            const first = await maintenance.initializeRuntimeInstance(command(null));
            await maintenance.enableRuntimeIngress(command(first.record));
            const captureRequest = async req => req === request ? clone(capture) : null;
            const runtime = createPostgresDashboardRuntimeRepository({ ...common, pool, captureRequest,
                readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
                authoriseOperatorOperation: () => false, newGenerationToken: () => hash(nextId()) });
            await runtime.initializeOperatorSession(request, { operationId: nextId() });
            const f = clone(fixture());
            const tenantId = 'synthetic-admin-' + runKey + '-' + sequence;
            function tenant(value) {
                if (!value || typeof value !== 'object') return;
                if (Object.hasOwn(value, 'tenantId')) value.tenantId = tenantId;
                Object.values(value).forEach(tenant);
            }
            tenant(f);
            const selector = normaliseSelector({ provider: 'legacy', subjectKey: SUBJECT, ...f.scope });
            const snapshot = { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState,
                entitlementState: f.entitlementState, flags: f.flags, advisorAssignments: [], usage: f.entitlementState.grants.map(dataCodec.newUsage) };
            const payloads = [['dashboard_tenants', snapshot.tenantAggregate.tenant], ['dashboard_organisations', snapshot.tenantAggregate.organisations[0]],
                ['dashboard_membership_states', snapshot.membershipState], ['dashboard_entitlement_states', snapshot.entitlementState],
                ['dashboard_feature_flags', snapshot.flags], ...snapshot.usage.map(value => ['dashboard_usage', value])];
            for (const [table, value] of payloads) {
                const columns = ['tenant_id', ...(table === 'dashboard_tenants' ? [] : ['organisation_id']),
                    ...(table === 'dashboard_usage' ? ['grant_id'] : []), 'schema_version', 'revision', 'payload'];
                const values = [value.tenantId, ...(table === 'dashboard_tenants' ? [] : [value.organisationId]),
                    ...(table === 'dashboard_usage' ? [value.grantId] : []), 1, value.revision, JSON.stringify(value)];
                await owner.query(`INSERT INTO nofries.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(', ')})`, values);
            }
            const repository = createPostgresDashboardAdministrationRepository({ ...common, pool, captureRequest,
                authoriseAdministration: async context => state.allowed && context.request === request && context.capture.kind === 'operator_dashboard' &&
                    context.capture.identityPayload.oid === identity.oid && (context.selector === null || JSON.stringify(context.selector) === JSON.stringify(selector)) });
            const lookupId = nextId();
            const envelope = (outcome = 'attempt') => createAuditEnvelope({ selector, nativeBinding: {
                requestId: capture.requestId, sessionSha256: capture.sessionSha256, instanceId, actorSubjectKey: actor },
            serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_read', requestId: lookupId,
                actorSubjectKey: actor, targetSha256: crypto.createHash('sha256').update(JSON.stringify(selector)).digest('hex'), outcome, occurredAt: NOW }, eventId: nextId() });
            state.trace.length = 0;
            return { repository, runtime, request, selector, state, capture, envelope, snapshot };
        }

        beforeAll(async () => {
            const url = new URL(isolatedTestUrl(testUrl));
            const { Pool } = require('pg');
            control = new Pool({ connectionString: testUrl, max: 1 });
            await control.query(`CREATE DATABASE ${quote(databaseName)}`); databaseCreated = true;
            url.pathname = '/' + databaseName;
            owner = new Pool({ connectionString: url.toString(), max: 2 });
            closeOwner = trackPoolClientEnds(owner);
            const client = await owner.connect();
            try { await applyMigrations({ client }); } finally { client.release(); }
            await control.query(`CREATE ROLE ${quote(runtimeRole)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`); roleCreated = true;
            await control.query(`GRANT nofries_runtime TO ${quote(runtimeRole)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            url.username = runtimeRole; url.password = password;
            runtimePool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000 });
            closeRuntime = trackPoolClientEnds(runtimePool);
            // The real old constraints must refuse this category. The proposal
            // remains outside the migration catalog and is applied only here.
            const h = await harness();
            await expect(h.repository.persistAudit(h.request, h.envelope(), h.selector)).rejects.toMatchObject({ statusCode: 503 });
            await owner.query(proposal);
            await owner.query(proposal);
        }, 30000);

        afterAll(async () => {
            const closed = await Promise.allSettled([closeRuntime?.(), closeOwner?.()]);
            if (control) {
                try {
                    // Attempt both owned pool closers, and never DROP while a
                    // pool/socket's closure is uncertain or setup was unowned.
                    if (closed.some(result => result.status === 'rejected')) throw new Error('administration_native_pool_cleanup_failed');
                    if (databaseCreated) await control.query(`DROP DATABASE ${quote(databaseName)}`);
                    if (roleCreated) await control.query(`DROP ROLE ${quote(runtimeRole)}`);
                } finally { await control.end(); }
            }
        });

        test('restricted principal keeps forced RLS and immutable audit privileges; existing runtime remains compatible', async () => {
            const result = await owner.query(`SELECT relrowsecurity, relforcerowsecurity,
                has_table_privilege('nofries_runtime',oid,'SELECT') AS can_select,
                has_table_privilege('nofries_runtime',oid,'INSERT') AS can_insert,
                has_table_privilege('nofries_runtime',oid,'UPDATE') AS can_update,
                has_table_privilege('nofries_runtime',oid,'DELETE') AS can_delete
                FROM pg_class WHERE oid='nofries.dashboard_runtime_audit'::regclass`);
            expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true,
                can_select: true, can_insert: true, can_update: false, can_delete: false }]);
            const h = await harness();
            const validated = await h.repository.validateSession(h.request, h.selector);
            expect(validated.state).toBe('ready');
            const read = await h.repository.readAuthoritySnapshot(h.request, h.selector);
            expect(read.snapshot.usage).toEqual(h.snapshot.usage);
            expect(read.revisions).toEqual(dataCodec.revisionVector(h.snapshot));
            expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(false);
        });

        test('immutable attempt/terminal phases deduplicate and readback issues no data write', async () => {
            const h = await harness(), attempt = h.envelope(), terminal = h.envelope('found');
            await expect(h.repository.persistAudit(h.request, attempt, h.selector)).resolves.toBe(true);
            await expect(h.repository.persistAudit(h.request, attempt, h.selector)).resolves.toBe(true);
            await expect(h.repository.persistAudit(h.request, terminal, h.selector, attempt)).resolves.toBe(true);
            const start = h.state.trace.length;
            await expect(h.repository.reconcileAudit(h.request, terminal, h.selector, attempt)).resolves.toBe(true);
            const trace = h.state.trace.slice(start);
            expect(trace[0].sql).toBe('BEGIN READ ONLY');
            expect(trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(false);
            const count = await owner.query("SELECT count(*)::int AS count FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.lookup' AND session_sha256=$1", [h.capture.sessionSha256]);
            expect(count.rows[0].count).toBe(2);
        });

        test('lost COMMIT reconciles one exact retained phase without snapshot execution or insert retry', async () => {
            const h = await harness(), attempt = h.envelope(); h.state.loseCommit = true;
            await expect(h.repository.persistAudit(h.request, attempt, h.selector)).rejects.toMatchObject({ code: 'onboarding_outcome_ambiguous' });
            const start = h.state.trace.length;
            await expect(h.repository.reconcileAudit(h.request, attempt, h.selector)).resolves.toBe(true);
            expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql) || sql.includes('FROM nofries.dashboard_tenants'))).toBe(false);
        });

        test.each(['missing-field', 'extra-field', 'null-phase', 'number-lookup', 'null-scope', 'wrong-category'])('SQL refuses closed-envelope violation %s', async mode => {
            const h = await harness(), row = clone(projectAuditRow(h.envelope()));
            if (mode === 'missing-field') delete row.payload.phase;
            if (mode === 'extra-field') row.payload.rawSubject = SUBJECT;
            if (mode === 'null-phase') row.payload.phase = null;
            if (mode === 'number-lookup') row.payload.lookupRequestId = 7;
            if (mode === 'null-scope') row.payload.scope = null;
            if (mode === 'wrong-category') row.payload.category = 'dashboard.runtime';
            const columns = Object.keys(row), values = columns.map(key => ['scope_json', 'payload'].includes(key) ? JSON.stringify(row[key]) : row[key]);
            await expect(owner.query(`INSERT INTO nofries.dashboard_runtime_audit (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, values)).rejects.toMatchObject({ code: '23514' });
        });

        test('one terminal slot forbids changed outcome and event identity at SQL level', async () => {
            const h = await harness(), attempt = h.envelope(), terminal = h.envelope('found');
            await h.repository.persistAudit(h.request, attempt, h.selector);
            await h.repository.persistAudit(h.request, terminal, h.selector, attempt);
            const row = projectAuditRow(h.envelope('unavailable')), columns = Object.keys(row);
            await expect(owner.query(`INSERT INTO nofries.dashboard_runtime_audit (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
                columns.map(key => ['scope_json', 'payload'].includes(key) ? JSON.stringify(row[key]) : row[key]))).rejects.toMatchObject({ code: '23505' });
        });

        test('conflicting concurrent terminal writes serialize and exactly one is acknowledged', async () => {
            const h = await harness(), attempt = h.envelope(), first = h.envelope('found'), second = h.envelope('unavailable');
            await h.repository.persistAudit(h.request, attempt, h.selector);
            let acquired, release, waiting, held = false;
            const firstAcquired = new Promise(resolve => { acquired = resolve; });
            const releaseFirst = new Promise(resolve => { release = resolve; });
            const secondWaiting = new Promise(resolve => { waiting = resolve; });
            h.state.before = async (sql, params) => {
                if (held && sql.includes('pg_advisory_xact_lock(') && params[0] === 71005) waiting();
            };
            h.state.after = async (sql, params) => {
                if (!held && sql.includes('pg_advisory_xact_lock(') && params[0] === 71005) {
                    held = true; acquired(); await releaseFirst;
                }
            };
            h.state.trace.length = 0;
            const one = h.repository.persistAudit(h.request, first, h.selector, attempt);
            let two;
            try {
                await Promise.race([firstAcquired, one.then(() => { throw new Error('terminal settled before phase fence'); })]);
                two = h.repository.persistAudit(h.request, second, h.selector, attempt);
                await Promise.race([secondWaiting, two.then(() => { throw new Error('terminal settled before contended fence'); })]);
                expect(h.state.trace.some(({ sql }) => sql.startsWith('INSERT'))).toBe(false);
            } finally { release(); }
            const results = await Promise.allSettled([one, two]);
            expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
            expect(results.filter(result => result.status === 'rejected' && result.reason.statusCode === 503)).toHaveLength(1);
            expect(h.state.trace.filter(({ sql }) => sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit'))).toHaveLength(1);
            const retained = await owner.query("SELECT payload->>'outcome' AS outcome FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.lookup' AND session_sha256=$1 AND payload->>'phase'='terminal'", [h.capture.sessionSha256]);
            expect(retained.rows).toEqual([{ outcome: 'found' }]);
        });

        test('orphan terminal fails without adding any lookup audit row', async () => {
            const h = await harness(), attempt = h.envelope(), terminal = h.envelope('found');
            await expect(h.repository.persistAudit(h.request, terminal, h.selector, attempt)).rejects.toMatchObject({ statusCode: 503 });
            expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
            const rows = await owner.query("SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.lookup' AND session_sha256=$1", [h.capture.sessionSha256]);
            expect(rows.rows).toEqual([]);
        });

        test('same actor/session can see a foreign scoped row but exact reconciliation rejects it', async () => {
            const h = await harness(), expected = h.envelope(), foreign = clone(expected);
            foreign.event.scope.organisationId = 'foreign-scope';
            const foreignSelector = normaliseSelector({ ...h.selector, organisationId: 'foreign-scope' });
            foreign.event.targetSha256 = crypto.createHash('sha256').update(JSON.stringify(foreignSelector)).digest('hex');
            const row = projectAuditRow(foreign), columns = Object.keys(row);
            await owner.query(`INSERT INTO nofries.dashboard_runtime_audit (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
                columns.map(key => ['scope_json', 'payload'].includes(key) ? JSON.stringify(row[key]) : row[key]));
            // Existing audit SELECT RLS is native actor/session scoped, not
            // target scoped. Prove visibility before testing exact row refusal.
            const client = await runtimePool.connect();
            try {
                await client.query('BEGIN READ ONLY');
                await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query("SELECT set_config('nofries.runtime_instance_id',$1,true),set_config('nofries.session_sha256',$2,true),set_config('nofries.subject_key',$3,true)",
                    [h.capture.instanceId, h.capture.sessionSha256, expected.event.actorSubjectKey]);
                const visible = await client.query('SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_id=$1', [row.event_id]);
                expect(visible.rows).toEqual([{ event_id: row.event_id }]);
            } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
            const start = h.state.trace.length;
            await expect(h.repository.reconcileAudit(h.request, expected, h.selector)).rejects.toMatchObject({ statusCode: 503 });
            expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
        });

        test.each(['payload', 'type', 'index'])('proposal rejects %s drift atomically without partially changing schema', async kind => {
            const client = await owner.connect();
            const schema = async () => ({ constraints: (await client.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='nofries.dashboard_runtime_audit'::regclass ORDER BY conname")).rows,
                indexes: (await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='nofries' AND tablename='dashboard_runtime_audit' ORDER BY indexname")).rows });
            let original;
            try {
                original = await schema();
                await client.query('BEGIN');
                if (kind === 'payload') {
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT dashboard_audit_payload');
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_payload CHECK (true)');
                } else if (kind === 'type') {
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT dashboard_audit_event_type');
                    await client.query("ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_event_type CHECK (event_type IN ('dashboard.operation','dashboard.runtime','dashboard.admin.lookup','unexpected'))");
                } else {
                    await client.query('DROP INDEX nofries.dashboard_audit_admin_lookup_phase');
                    await client.query("CREATE UNIQUE INDEX dashboard_audit_admin_lookup_phase ON nofries.dashboard_runtime_audit(event_id) WHERE event_type='dashboard.admin.lookup'");
                }
                const drifted = await schema();
                await client.query('SAVEPOINT proposed_change');
                await expect(client.query(proposal)).rejects.toMatchObject({ code: 'P0001',
                    message: kind === 'index' ? 'dashboard_admin_audit_index_drift' : 'dashboard_admin_audit_constraint_drift' });
                await client.query('ROLLBACK TO SAVEPOINT proposed_change');
                expect(await schema()).toEqual(drifted);
            } finally {
                try { await client.query('ROLLBACK'); if (original) expect(await schema()).toEqual(original); }
                finally { client.release(); }
            }
        });

        test('current session revocation denies reconciliation and preserves its retained attempt', async () => {
            const h = await harness(), attempt = h.envelope();
            await h.repository.persistAudit(h.request, attempt, h.selector);
            await h.runtime.revokeSession(h.request, { operationId: nextId() });
            const start = h.state.trace.length;
            await expect(h.repository.reconcileAudit(h.request, attempt, h.selector)).rejects.toMatchObject({ statusCode: 403 });
            expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
        });
    });
};
module.exports.isolatedTestUrl = isolatedTestUrl;
