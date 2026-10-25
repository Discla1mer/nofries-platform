'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { retainedTrialAuthFixture } = require('./fixtures/retainedTrialAuthFixture');
const { START, clone } = require('./fixtures/retainedTrialReadFixture');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createPostgresDatabase } = require('../api/shared/database/postgres');
const { createPostgresDashboardMaintenanceRepository, createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { resolveNcscAccess } = require('../api/shared/appLifecycle/dashboardResourceAuthority');
const ncsc = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { createRetainedTrialReadProduction } = require('../lib/retainedTrialReadProduction');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const { createExternalCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { THREE_MONTH_PLAN_ID } = require('../api/shared/customerSignup/customerStarterPlan');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const target = String(process.env.NOFRIES_RETAINED_READ_AUDIT_TEST_DATABASE_URL || '').trim();
const BUDGET = { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 };

function isolatedTarget(input) {
    let url;
    try { url = new URL(input); } catch (_) { throw new Error('isolated_retained_read_audit_database_required'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/nofries_test_trial_retained_read_audit' || url.search || url.hash)
        throw new Error('isolated_retained_read_audit_database_required');
    return input;
}
test('native audited read requires its explicit disposable loopback database', () => {
    assert.equal(isolatedTarget('postgresql://localhost/nofries_test_trial_retained_read_audit'), 'postgresql://localhost/nofries_test_trial_retained_read_audit');
    for (const input of ['', 'postgresql://remote.invalid/nofries_test_trial_retained_read_audit', 'postgresql://localhost/nofries_ci',
        'postgresql://localhost/nofries_test_trial_retained_read_audit?host=remote.invalid']) assert.throws(() => isolatedTarget(input));
});

for (const consultant of [false, true]) (target ? test : test.skip)(`existing runtime role COMMITs an exact retained read with real audit/session FKs (client=${consultant})`, async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: isolatedTarget(target), max: 3, connectionTimeoutMillis: 5000,
        statement_timeout: 10000, query_timeout: 12000 });
    const h = await retainedTrialAuthFixture({ client: consultant, email: 'synthetic-' + crypto.randomUUID() + '@example.test' }), f = h.f;
    let setupAt = START;
    try {
        // This dedicated, disposable database is prepared with the unchanged
        // catalog. Only its local proposal is applied. No role/grant is added.
        await pool.query(fs.readFileSync(path.join(__dirname, '../database/proposals/customer_three_calendar_month_trial.sql'), 'utf8'));
        const epoch = async () => ({ instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch });
        const common = { pool, clock: () => setupAt, instanceId: f.state.instance.instanceId,
            historyBudget: BUDGET, readExternalRuntimeEpoch: epoch, newId: crypto.randomUUID };
        const maintenance = createPostgresDashboardMaintenanceRepository({ ...common, authoriseMaintenanceOperation: () => true });
        const instanceCommand = before => ({ operationId: crypto.randomUUID(), actorSubjectKey: f.actor,
            expectedRevision: before ? before.revision : null, expectedRecordSha256: before ? hash(before) : null,
            restoreEpoch: f.state.instance.restoreEpoch, evidenceRef: f.state.instance.evidenceRef, evidenceSha256: f.state.instance.evidenceSha256 });
        const initialized = await maintenance.initializeRuntimeInstance(instanceCommand(null));
        const enabled = await maintenance.enableRuntimeIngress(instanceCommand(initialized.record));
        assert.deepEqual(enabled.record, f.state.instance);

        const seed = { sessionSha256: crypto.randomBytes(32).toString('hex'), kind: 'operator_dashboard', identityPayload: f.identity,
            instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch,
            issuedAt: START, expiresAt: f.account.activation.validUntil, discovery: null };
        seed.operatorIssuanceProof = { schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: seed.sessionSha256,
            identitySha256: hash(f.identity), instanceId: seed.instanceId, restoreEpoch: seed.restoreEpoch,
            issuedAt: seed.issuedAt, expiresAt: seed.expiresAt };
        const captures = new WeakMap();
        const runtime = createPostgresDashboardRuntimeRepository({ ...common,
            captureRequest: async request => {
                if (!captures.has(request)) captures.set(request, { ...seed, requestId: crypto.randomUUID(),
                    deadline: new Date(Date.parse(setupAt) + 60000).toISOString() });
                return clone(captures.get(request));
            }, readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
            authoriseOperatorOperation: () => true, newGenerationToken: () => crypto.randomBytes(32).toString('hex') });
        await runtime.initializeOperatorSession({}, { operationId: crypto.randomUUID() });

        const owner = await pool.connect();
        try {
            await owner.query('BEGIN');
            async function insert(table, row) {
                const keys = Object.keys(row), values = keys.map(key => row[key] !== null && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
                await owner.query(`INSERT INTO nofries.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, values);
            }
            await insert('dashboard_starter_accounts', { account_id: f.account.accountId,
                email_sha256: crypto.createHash('sha256').update('nofries:starter-email:v1\0' + f.email).digest('hex'),
                subject_key: f.actor, account_type: f.account.accountType, created_at: START, activated_at: START });
            for (const [tenantId, fact] of f.scopes) {
                const p = fact.retained.preparation, s = fact.snapshot, slot = p.slot;
                await insert('dashboard_starter_scopes', { tenant_id: tenantId, organisation_id: slot.organisationId,
                    account_id: f.account.accountId, account_type: f.account.accountType, subject_key: f.actor,
                    ordinal: f.account.organisations.findIndex(item => item.bindingId === slot.bindingId), authority_id: slot.authorityId,
                    binding_id: slot.bindingId, preparation: p, activation: fact.retained.activation });
                await insert('dashboard_tenants', { tenant_id: tenantId, schema_version: 1, revision: s.tenantAggregate.tenant.revision, payload: s.tenantAggregate.tenant });
                const stateRow = payload => ({ tenant_id: tenantId, organisation_id: slot.organisationId,
                    schema_version: 1, revision: payload.revision, payload });
                await insert('dashboard_organisations', stateRow(s.tenantAggregate.organisations[0]));
                await insert('dashboard_membership_states', stateRow(s.membershipState));
                await insert('dashboard_entitlement_states', stateRow(s.entitlementState));
                await insert('dashboard_feature_flags', stateRow(s.flags));
                for (const usage of s.usage) await insert('dashboard_usage', { ...stateRow(usage), grant_id: usage.grantId });
            }
            for (const version of f.versions) { await ncsc.appendVersion(owner, version); await ncsc.moveHead(owner, version); }
            await owner.query('COMMIT');
        } catch (error) { await owner.query('ROLLBACK'); throw error; }
        finally { owner.release(); }

        for (const fact of f.scopes.values()) {
            const p = fact.retained.preparation, a = fact.retained.activation;
            setupAt = a.occurredAt;
            const payload = Object.fromEntries(['target', 'identityPolicyRef', 'approvedEffectSha256', 'evidenceRefs', 'validFrom', 'validUntil']
                .map(key => [key, fact.admission.payload[key]]));
            const admission = await maintenance.publishAdmissionDecision({ operationId: p.slot.admissionOperationId,
                actorSubjectKey: f.actor, authorityId: p.slot.authorityId, expectedRevision: null, expectedHeadSha256: null, payload });
            assert.deepEqual(admission.record, fact.admission);
            const publication = await runtime.publishExistingMembershipBinding({}, { operationId: p.slot.publicationOperationId,
                bindingId: p.slot.bindingId, scope: p.scope, membershipId: p.slot.membershipId, invitationId: p.invitationId,
                grantEvidenceId: p.representativeAuthorityEvidenceId, identity: f.identity,
                validFrom: a.occurredAt, validUntil: a.validUntil, authorityRef: fact.binding.authorityRef });
            assert.equal(publication.binding.bindingId, p.slot.bindingId);
        }
        // A new connection now sees a fully committed, constraint-valid graph.
        // Unlike the older SELECT fixture, no outer rollback or unfulfilled
        // deferred receipt foreign key can masquerade as publication.
        // Qualify the actual production quota factory and finite SQL counter
        // before expiry. These are six reservations, not a claim that six full
        // browser submissions or live customer assessments were completed.
        const expiredAt = f.state.now;
        f.state.now = new Date(Date.parse(START) + 2 * 86400000).toISOString();
        const composition = customerProductionHarness({ pool, starter: true, external: true,
            instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch,
            configureExternal({ dependencies }) {
                dependencies.clock = () => f.state.now;
                dependencies.externalCustomer = { identityProvider: h.rawProfile, identityPolicy: h.sessionOptions.identityPolicy,
                    client: { clientSecret: h.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET, clientApplication: h.browserAuthOptions.clientApplication },
                    userFlowId: 'synthetic-password-flow', allowNewSignup: false, starterAuthorityContainer: 'external-starter-authority',
                    trial: { planId: THREE_MONTH_PLAN_ID, retainedRead: true } };
            } });
        const blobs = composition.getContainer('external-starter-authority').records;
        blobs.set(`customer-subjects/${subjectHash(f.actor)}.json`, Buffer.from(JSON.stringify(f.state.subject)));
        blobs.set(`customer-starter/${starterAccountKey(f.email)}.json`, Buffer.from(JSON.stringify(f.state.account)));
        const own = f.account.organisations[0], p = f.original.retained.preparation;
        blobs.set(`customer-starter/contexts/${own.organisationId}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, accountId: f.account.accountId, source: p.source })));
        const dashboard = createProductionDashboardConfiguration(composition.env, composition.dependencies);
        const signup = createExternalCustomerSignupConfiguration(composition.env, dashboard, composition.dependencies, composition.dependencies.externalCustomer);
        const normalDatabase = createPostgresDatabase({ pool: { end: () => pool.end(), async connect() {
            const client = await pool.connect(); return { release: discard => client.release(discard), async query(sql, params) {
                const result = await client.query(sql, params); if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime'); return result;
            } };
        } } });
        const ordinary = createPostgresDashboardRepository({ database: normalDatabase, clock: () => f.state.now, authoriseAdministration: () => false });
        let revisions = dataCodec.revisionVector(f.original.snapshot);
        for (let n = 0; n < 6; n++) {
            const policy = await signup.resolveStarterQuota({ tenantId: own.tenantId, organisationId: own.organisationId,
                assessmentId: 'synthetic-reservation-' + n, actorSubjectKey: f.actor, moduleId: MODULE_ID,
                profileRef: ACCEPTED_PROFILE_REF, productGrantId: own.grantId, agreementRef: own.scheduleId,
                expectedRevision: 1, submissionRevision: 2, at: f.state.now });
            assert.equal(policy.amount, 1); assert.equal(policy.validUntil, f.account.activation.validUntil);
            const reserved = await ordinary.reserveUsage({ tenantId: own.tenantId, organisationId: own.organisationId,
                operationId: crypto.randomUUID(), actorSubjectKey: f.actor, type: 'usage.reserve', expectedRevisions: revisions,
                payload: { grantId: own.grantId, moduleId: MODULE_ID, limit: policy.limit, amount: policy.amount,
                    framework: { profileId: ACCEPTED_PROFILE_REF.profileId, version: ACCEPTED_PROFILE_REF.profileVersion } } });
            revisions = reserved.resultRevisions;
        }
        const used = (await pool.query('SELECT payload FROM nofries.dashboard_usage WHERE tenant_id=$1 AND organisation_id=$2 AND grant_id=$3', [own.tenantId, own.organisationId, own.grantId])).rows[0].payload;
        assert.equal(used.counters.assessment_runs, 6); assert.equal(f.original.snapshot.entitlementState.grants[0].limits.assessment_runs, null);
        f.state.now = expiredAt;

        const logged = await h.login(), capture = await h.session.captureRequest(logged.request);
        let loseCommitResponse = true, commits = 0, fencesObserved = 0, inspectFence = true;
        const database = createPostgresDatabase({ pool: { end: () => pool.end(), async connect() {
            const client = await pool.connect();
            return { release: discard => client.release(discard), async query(sql, params) {
                if (sql === 'COMMIT' && inspectFence) {
                    const observer = await pool.connect();
                    try {
                        await observer.query('BEGIN'); await observer.query('SET LOCAL ROLE nofries_runtime');
                        assert.deepEqual((await observer.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0], { rolsuper: false, rolbypassrls: false });
                        assert.equal((await observer.query('SELECT pg_try_advisory_xact_lock($1::integer,hashtext($2)) AS acquired', [71001, capture.sessionSha256])).rows[0].acquired, false);
                        fencesObserved++;
                    } finally { try { await observer.query('ROLLBACK'); } finally { observer.release(); } }
                }
                const result = await client.query(sql, params);
                if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                if (sql === 'COMMIT') { commits++; if (loseCommitResponse) { loseCommitResponse = false; throw new Error('synthetic lost actual COMMIT response'); } }
                return result;
            } };
        } } });
        const reader = createRetainedTrialAssessmentReader({ ...f.options, database, captureRequest: h.session.captureRequest, auditRead: true });
        await assert.rejects(reader.read(logged.request, f.input), { code: 'retained_read_unavailable' });
        const first = (await pool.query('SELECT * FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1', [capture.sessionSha256])).rows;
        assert.equal(first.length, 1); assert.equal(first[0].payload.action, 'assessment.read');
        assert.equal((await reader.read(logged.request, f.input)).assessment.assessmentId, f.input.assessmentId);
        const second = (await pool.query('SELECT * FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1', [capture.sessionSha256])).rows;
        assert.deepEqual(second, first); assert.equal(commits, 2); assert.equal(fencesObserved, 2);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [capture.sessionSha256])).rows[0].n, 1);
        assert.throws(() => resolveNcscAccess(f.selected.snapshot, { scope: f.selected.binding.scope,
            identity: { subjectKey: f.actor }, resolvedAt: f.state.now }, 'assessment.write', f.state.now), /ncsc_access_denied/);

        // Qualify the real production retained composition's sign-out, including
        // its existing runtime transition/audit and an absent first-read gate.
        inspectFence = false;
        const retained = createRetainedTrialReadProduction({ env: h.env, database, records: h.records,
            accountStore: f.options.accountStore, profile: h.profile, rawProfile: h.rawProfile,
            identityPolicy: h.sessionOptions.identityPolicy, authentication: h.authentication,
            client: { clientSecret: h.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET, clientApplication: h.browserAuthOptions.clientApplication },
            dashboard: { browserAuthOptions: h.browserAuthOptions, clock: f.options.clock,
                proofStore: h.sessionOptions.proofStore, readExternalRuntimeEpoch: epoch, newRequestId: crypto.randomUUID,
                requestBudgetMs: 60000, pool, instanceId: capture.instanceId, historyBudget: BUDGET,
                newId: crypto.randomUUID, newOperationId: crypto.randomUUID, newGenerationToken: () => crypto.randomBytes(32).toString('hex') } });
        async function freshRetained() {
            const begun = await retained.beginLogin({ returnTo: '/api/retained-results?' + new URLSearchParams(f.input) });
            const result = await retained.completeLogin({ cookieHeader: begun.cookie[0].split(';')[0],
                body: { code: 'synthetic-code', state: new URL(begun.location).searchParams.get('state') } });
            return { headers: { cookie: result.cookie.split(';')[0] } };
        }
        const viewed = await freshRetained(); await retained.read(viewed, f.input);
        const viewedCapture = await h.session.captureRequest(viewed);
        assert.equal((await retained.logout({ headers: viewed.headers })).location, '/');
        assert.equal((await pool.query('SELECT status FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [viewedCapture.sessionSha256])).rows[0].status, 'revoked');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1 AND payload->>'action'='revokeSession'", [viewedCapture.sessionSha256])).rows[0].n, 1);
        await assert.rejects(retained.read({ headers: viewed.headers }, f.input), { code: 'retained_read_signin_required' });
        const unviewed = await freshRetained(), unviewedCapture = await h.session.captureRequest(unviewed);
        await retained.logout(unviewed);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [unviewedCapture.sessionSha256])).rows[0].n, 0);

        const probe = await pool.connect();
        try {
            await probe.query('BEGIN'); await probe.query('SET LOCAL ROLE nofries_runtime');
            await probe.query("SELECT set_config('nofries.runtime_instance_id',$1,true),set_config('nofries.session_sha256',$2,true),set_config('nofries.session_kind','customer',true),set_config('nofries.identity_sha256',$3,true),set_config('nofries.subject_key',$4,true)",
                [capture.instanceId, capture.sessionSha256, hash(capture.identityPayload), crypto.randomUUID() + ':' + crypto.randomUUID()]);
            assert.equal((await probe.query('SELECT * FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [capture.sessionSha256])).rowCount, 0);
            assert.equal((await probe.query('SELECT * FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1', [capture.sessionSha256])).rowCount, 0);
        } finally { try { await probe.query('ROLLBACK'); } finally { probe.release(); } }
        const revokedAt = new Date(h.now() + 1).toISOString(); h.f.state.now = revokedAt;
        await pool.query("UPDATE nofries.dashboard_session_gates SET status='revoked',revision=1,selection_generation=1,generation_token=$1,updated_at=$2,revoked_at=$2 WHERE session_sha256=$3",
            [crypto.randomBytes(32).toString('hex'), revokedAt, capture.sessionSha256]);
        await assert.rejects(reader.read(logged.request, f.input), { code: 'retained_read_denied' });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM nofries.dashboard_runtime_audit WHERE session_sha256=$1', [capture.sessionSha256])).rows[0].n, 1);
    } finally { await pool.end(); }
}, 45000);
