'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createPostgresDashboardAdministrationRepository, createPostgresDashboardRuntimeRepository,
    createPostgresDashboardMaintenanceRepository } = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createSignupAuditEnvelope, projectSignupAuditRow } = require('../../api/shared/dashboardAdmin/signupAuditEnvelope');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { applyMigrations } = require('../../scripts/db-migrate');
const { NOW } = require('../fixtures/dashboardFixture');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const clone = value => JSON.parse(JSON.stringify(value));
const START = new Date(Date.parse(NOW) - 60000).toISOString();
const END = new Date(Date.parse(NOW) + 3600000).toISOString();
const BUDGET = { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 };
const predecessor = fs.readFileSync(path.join(__dirname, '../../database/proposals/dashboard_admin_lookup_audit.sql'), 'utf8');
const proposal = fs.readFileSync(path.join(__dirname, '../../database/proposals/dashboard_admin_signup_list_audit.sql'), 'utf8');
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
module.exports = function registerDashboardAdminSignupPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Finite signup listing audit with restricted PostgreSQL', () => {
        const runKey = crypto.randomBytes(6).toString('hex'), databaseName = 'nf_signup_native_' + runKey,
            runtimeRole = 'nf_signup_runtime_' + runKey, password = 'synthetic-only-' + runKey;
        let control, owner, runtimePool, closeOwner, closeRuntime, databaseCreated = false, roleCreated = false, sequence = 100;
        const nextId = () => '83000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');

        async function harness(version = 1) {
            const instanceId = nextId(), restoreEpoch = nextId(), identity = { policyId: 'synthetic-admin-native', policyRevision: 1,
                issuer: 'https://identity.example.invalid/v2.0', identityTenantId: nextId(), oid: nextId(), audience: nextId() };
            const actor = identity.identityTenantId + ':' + identity.oid, request = Object.freeze({ syntheticRequestId: nextId() });
            const capture = { requestId: nextId(), deadline: new Date(Date.parse(NOW) + 60000).toISOString(),
                sessionSha256: hash(nextId()), kind: 'operator_dashboard', identityPayload: identity, instanceId, restoreEpoch,
                issuedAt: START, expiresAt: END, discovery: null, operatorIssuanceProof: null };
            capture.operatorIssuanceProof = { schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: capture.sessionSha256,
                identitySha256: hash(identity), instanceId, restoreEpoch, issuedAt: START, expiresAt: END };
            const state = { trace: [], before: null, after: null, loseCommit: false, allowed: true, externalEpoch: restoreEpoch, now: NOW, policies: [] };
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
            const common = { clock: () => state.now, instanceId, historyBudget: BUDGET,
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch: state.externalEpoch }), newId: nextId };
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
            const authority = { schemaVersion: version, capability: 'signupList', operatorSubjectKey: actor,
                provider: 'legacy', ...(version === 1 ? { tenantId: 'synthetic-signup-tenant' } : {
                    scope: { kind: 'finite_manifest', manifestSha256: hash({ syntheticOnly: true }) } }),
                populationId: 'synthetic-population', indexId: 'synthetic-index', authorityRevision: 1,
                issuedAt: START, expiresAt: new Date(Date.parse(NOW) + 600000).toISOString(),
                maxPageSize: 2, maxRows: 4, maxPages: 2,
                fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-retention' };
            const nativeOptions = { ...common, pool, captureRequest, authoriseAdministration: () => false,
                authoriseSignupList: async context => { state.policies.push(context); return state.allowed && context.request === request &&
                    context.capture.kind === 'operator_dashboard' && context.capture.identityPayload.oid === identity.oid &&
                    hash(context.authority) === hash(authority); } };
            const repository = createPostgresDashboardAdministrationRepository(nativeOptions);
            const serviceRequestId = nextId();
            const envelope = (outcome = 'requested', count = 0) => createSignupAuditEnvelope({ authority,
                nativeBinding: { requestId: capture.requestId, sessionSha256: capture.sessionSha256, instanceId, actorSubjectKey: actor },
                serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId: serviceRequestId,
                    actorSubjectKey: actor, authoritySha256: hash(authority), requestSha256: hash({ cursor: null }), page: 1,
                    phase: outcome === 'requested' ? 'attempt' : 'outcome', outcome, count, occurredAt: state.now }, eventId: nextId() });
            state.trace.length = 0; state.policies.length = 0;
            return { repository, runtime, request, authority, state, capture, envelope, nativeOptions };
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
            await expect(h.repository.persistSignupAudit(h.request, h.envelope(), h.authority)).rejects.toMatchObject({ statusCode: 503 });
            await expect(owner.query(proposal)).rejects.toMatchObject({ code: 'P0001',
                message: 'dashboard_admin_signup_audit_constraint_drift' });
            await owner.query(predecessor);
            await expect(h.repository.persistSignupAudit(h.request, h.envelope(), h.authority)).rejects.toMatchObject({ statusCode: 503 });
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

        test.each([1, 2])('v%s uses native operator gates, preserves forced RLS and does not write on session validation', async version => {
            const result = await owner.query(`SELECT relrowsecurity, relforcerowsecurity,
                has_table_privilege('nofries_runtime',oid,'SELECT') AS can_select,
                has_table_privilege('nofries_runtime',oid,'INSERT') AS can_insert,
                has_table_privilege('nofries_runtime',oid,'UPDATE') AS can_update,
                has_table_privilege('nofries_runtime',oid,'DELETE') AS can_delete
                FROM pg_class WHERE oid='nofries.dashboard_runtime_audit'::regclass`);
            expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true,
                can_select: true, can_insert: true, can_update: false, can_delete: false }]);
            const h = await harness(version);
            const validated = await h.repository.validateSignupSession(h.request, h.authority);
            expect(validated).toEqual({ schemaVersion: 1, state: 'ready', purpose: 'operator_dashboard', capture: h.capture });
            expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(false);
            expect(h.state.policies.length).toBeGreaterThan(3);
            expect(h.state.policies.every(value => hash(value.authority) === hash(h.authority))).toBe(true);
        });

        test.each([1, 2])('v%s immutable phases deduplicate and reconcile SELECT-only after confirmed commit', async version => {
            const h = await harness(version), attempt = h.envelope(), outcome = h.envelope('available', 2);
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).resolves.toBe(true);
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).resolves.toBe(true);
            await expect(h.repository.persistSignupAudit(h.request, outcome, h.authority, attempt)).resolves.toBe(true);
            const start = h.state.trace.length;
            await expect(h.repository.reconcileSignupAudit(h.request, outcome, h.authority, attempt)).resolves.toBe(true);
            const trace = h.state.trace.slice(start);
            expect(trace[0].sql).toBe('BEGIN READ ONLY');
            expect(trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(false);
            const rows = await owner.query("SELECT payload,tenant_id,organisation_id,scope_json FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.signup_list' AND session_sha256=$1 ORDER BY payload->'serviceEvent'->>'phase'", [h.capture.sessionSha256]);
            expect(rows.rows).toEqual([attempt, outcome].map(value => ({ payload: value.event, tenant_id: null, organisation_id: null, scope_json: null })));
        });

        test('lost COMMIT reconciles retained exact phase without INSERT retry', async () => {
            const h = await harness(2), attempt = h.envelope(); h.state.loseCommit = true;
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).rejects.toMatchObject({ code: 'onboarding_outcome_ambiguous' });
            const start = h.state.trace.length;
            await expect(h.repository.reconcileSignupAudit(h.request, attempt, h.authority)).resolves.toBe(true);
            expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
        });

        test.each(['session', 'external-epoch', 'population-policy', 'expiry'])('current %s revocation denies reconciliation without changing retained attempt', async mode => {
            const h = await harness(2), attempt = h.envelope();
            await h.repository.persistSignupAudit(h.request, attempt, h.authority);
            if (mode === 'session') await h.runtime.revokeSession(h.request, { operationId: nextId() });
            if (mode === 'external-epoch') h.state.externalEpoch = nextId();
            if (mode === 'population-policy') h.state.allowed = false;
            if (mode === 'expiry') h.state.now = h.authority.expiresAt;
            const start = h.state.trace.length;
            await expect(h.repository.reconcileSignupAudit(h.request, attempt, h.authority)).rejects.toHaveProperty('statusCode');
            expect(h.state.trace.slice(start).some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
            const rows = await owner.query("SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.signup_list' AND session_sha256=$1", [h.capture.sessionSha256]);
            expect(rows.rows).toEqual([{ event_id: attempt.event.eventId }]);
        });

        test('policy revoked after provisional INSERT rolls back and returns no acknowledgement', async () => {
            const h = await harness(2), attempt = h.envelope();
            h.state.after = async sql => { if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit')) h.state.allowed = false; };
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).rejects.toMatchObject({ statusCode: 403 });
            expect(h.state.trace.some(({ sql }) => sql === 'COMMIT')).toBe(false);
            const rows = await owner.query("SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.signup_list' AND session_sha256=$1", [h.capture.sessionSha256]);
            expect(rows.rows).toEqual([]);
        });

        test('policy revoked after COMMIT withholds acknowledgement and cannot reconcile while revoked', async () => {
            const h = await harness(2), attempt = h.envelope();
            h.state.after = async sql => { if (sql === 'COMMIT') h.state.allowed = false; };
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).rejects.toMatchObject({ statusCode: 403 });
            await expect(h.repository.reconcileSignupAudit(h.request, attempt, h.authority)).rejects.toMatchObject({ statusCode: 403 });
            expect(h.state.trace.filter(({ sql }) => sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit'))).toHaveLength(1);
        });

        test.each(['population', 'native-session', 'native-request', 'native-instance', 'actor', 'event-time', 'authority'])('native reconstruction rejects forged %s before SQL', async mode => {
            const h = await harness(2), attempt = clone(h.envelope());
            if (mode === 'population') attempt.event.population.scope.manifestSha256 = 'f'.repeat(64);
            if (mode === 'native-session') attempt.sessionSha256 = 'f'.repeat(64);
            if (mode === 'native-request') attempt.event.requestId = nextId();
            if (mode === 'native-instance') attempt.instanceId = nextId();
            if (mode === 'actor') { attempt.event.actorSubjectKey = nextId() + ':' + nextId(); attempt.event.serviceEvent.actorSubjectKey = attempt.event.actorSubjectKey; }
            if (mode === 'event-time') { attempt.event.occurredAt = attempt.event.serviceEvent.occurredAt = END; }
            if (mode === 'authority') attempt.event.serviceEvent.authoritySha256 = 'f'.repeat(64);
            attempt.event.serviceEventSha256 = hash(attempt.event.serviceEvent);
            await expect(h.repository.persistSignupAudit(h.request, attempt, h.authority)).rejects.toHaveProperty('statusCode');
            expect(h.state.trace).toEqual([]);
        });

        async function insert(row, client = owner) {
            const columns = Object.keys(row), values = columns.map(key => ['scope_json', 'payload'].includes(key) ? JSON.stringify(row[key]) : row[key]);
            return client.query(`INSERT INTO nofries.dashboard_runtime_audit (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, values);
        }
        test.each(['missing-field', 'extra-field', 'null-phase', 'wrong-count', 'wrong-provider', 'wrong-version', 'mixed-scope', 'wildcard', 'null-scope', 'wrong-category',
            'extra-population', 'extra-scope', 'extra-service', 'missing-population-field'])('SQL refuses closed listing payload violation %s', async mode => {
            const h = await harness(2), row = clone(projectSignupAuditRow(h.envelope()));
            if (mode === 'missing-field') delete row.payload.serviceEvent.phase;
            if (mode === 'extra-field') row.payload.rawCustomer = 'excluded';
            if (mode === 'null-phase') row.payload.serviceEvent.phase = null;
            if (mode === 'wrong-count') row.payload.serviceEvent.count = 1;
            if (mode === 'wrong-provider') row.payload.population.provider = 'all';
            if (mode === 'wrong-version') row.payload.schemaVersion = 1;
            if (mode === 'mixed-scope') row.payload.population.tenantId = 'unexpected';
            if (mode === 'wildcard') row.payload.population.scope.kind = 'all_tenants';
            if (mode === 'null-scope') row.payload.population.scope = null;
            if (mode === 'wrong-category') row.payload.serviceEvent.category = 'dashboard.runtime';
            if (mode === 'extra-population') row.payload.population.unapproved = true;
            if (mode === 'extra-scope') row.payload.population.scope.unapproved = true;
            if (mode === 'extra-service') row.payload.serviceEvent.unapproved = true;
            if (mode === 'missing-population-field') delete row.payload.population.indexId;
            await expect(insert(row)).rejects.toMatchObject({ code: '23514' });
        });

        test('one immutable phase slot rejects changed event identity, and orphan outcome adds no row', async () => {
            const h = await harness(), attempt = h.envelope(), outcome = h.envelope('available', 1);
            await expect(h.repository.persistSignupAudit(h.request, outcome, h.authority, attempt)).rejects.toMatchObject({ statusCode: 503 });
            await h.repository.persistSignupAudit(h.request, attempt, h.authority);
            await h.repository.persistSignupAudit(h.request, outcome, h.authority, attempt);
            await expect(insert(projectSignupAuditRow(h.envelope('unavailable')))).rejects.toMatchObject({ code: '23505' });
        });

        test('concurrent conflicting outcomes serialize and acknowledge only one', async () => {
            const h = await harness(2), attempt = h.envelope(), first = h.envelope('available', 1), second = h.envelope('unavailable');
            await h.repository.persistSignupAudit(h.request, attempt, h.authority);
            const results = await Promise.allSettled([
                h.repository.persistSignupAudit(h.request, first, h.authority, attempt),
                h.repository.persistSignupAudit(h.request, second, h.authority, attempt)
            ]);
            expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
            expect(results.filter(result => result.status === 'rejected' && result.reason.statusCode === 503)).toHaveLength(1);
            const rows = await owner.query("SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_type='dashboard.admin.signup_list' AND session_sha256=$1", [h.capture.sessionSha256]);
            expect(rows.rows).toHaveLength(2);
        });

        test('exact readback rejects same-session substituted manifest despite audit SELECT visibility', async () => {
            const h = await harness(2), expected = h.envelope(), foreign = clone(expected);
            foreign.event.population.scope.manifestSha256 = 'f'.repeat(64);
            await insert(projectSignupAuditRow(foreign));
            const client = await runtimePool.connect();
            try {
                await client.query('BEGIN READ ONLY'); await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query("SELECT set_config('nofries.runtime_instance_id',$1,true),set_config('nofries.session_sha256',$2,true),set_config('nofries.subject_key',$3,true)",
                    [h.capture.instanceId, h.capture.sessionSha256, expected.event.actorSubjectKey]);
                const visible = await client.query('SELECT event_id FROM nofries.dashboard_runtime_audit WHERE event_id=$1', [expected.event.eventId]);
                expect(visible.rows).toEqual([{ event_id: expected.event.eventId }]);
            } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
            h.state.trace.length = 0;
            await expect(h.repository.reconcileSignupAudit(h.request, expected, h.authority)).rejects.toMatchObject({ statusCode: 503 });
            expect(h.state.trace.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
        });

        test.each(['payload', 'type', 'index', 'lookup-index', 'missing-index'])('proposal rejects %s drift atomically', async kind => {
            const client = await owner.connect();
            const schema = async () => ({ constraints: (await client.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='nofries.dashboard_runtime_audit'::regclass ORDER BY conname")).rows,
                indexes: (await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='nofries' AND tablename='dashboard_runtime_audit' ORDER BY indexname")).rows });
            let original;
            try {
                original = await schema(); await client.query('BEGIN');
                if (kind === 'payload') {
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT dashboard_audit_payload');
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_payload CHECK (true)');
                } else if (kind === 'type') {
                    await client.query('ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT dashboard_audit_event_type');
                    await client.query("ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_event_type CHECK (event_type IN ('dashboard.operation','dashboard.runtime','dashboard.admin.lookup','dashboard.admin.signup_list','unexpected'))");
                } else {
                    const name = kind === 'lookup-index' ? 'dashboard_audit_admin_lookup_phase' : 'dashboard_audit_admin_signup_phase';
                    await client.query('DROP INDEX nofries.' + name);
                    if (kind !== 'missing-index') await client.query('CREATE UNIQUE INDEX ' + name + ' ON nofries.dashboard_runtime_audit(event_id)');
                }
                const drifted = await schema(); await client.query('SAVEPOINT proposed_change');
                await expect(client.query(proposal)).rejects.toMatchObject({ code: 'P0001' });
                await client.query('ROLLBACK TO SAVEPOINT proposed_change'); expect(await schema()).toEqual(drifted);
            } finally { try { await client.query('ROLLBACK'); if (original) expect(await schema()).toEqual(original); } finally { client.release(); } }
        });
    });
};
module.exports.isolatedTestUrl = isolatedTestUrl;
