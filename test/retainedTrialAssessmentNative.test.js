'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { retainedTrialFixture, START } = require('./fixtures/retainedTrialReadFixture');
const { projectCurrentRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { resolveNcscAccess } = require('../api/shared/appLifecycle/dashboardResourceAuthority');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const ncsc = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const target = String(process.env.NOFRIES_RETAINED_READ_TEST_DATABASE_URL || '').trim();

function isolatedTarget(input) {
    let url;
    try { url = new URL(input); } catch (_) { throw new Error('isolated_retained_read_database_required'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/nofries_test_trial_retained_read' || url.search || url.hash) throw new Error('isolated_retained_read_database_required');
    return input;
}
test('native retained-read fixture requires its explicit disposable loopback database', () => {
    assert.equal(isolatedTarget('postgresql://localhost/nofries_test_trial_retained_read'), 'postgresql://localhost/nofries_test_trial_retained_read');
    for (const input of ['', 'postgresql://remote.invalid/nofries_test_trial_retained_read', 'postgresql://localhost/nofries_ci',
        'postgresql://localhost/nofries_test_trial_retained_read?host=remote.invalid']) assert.throws(() => isolatedTarget(input));
});

(target ? test : test.skip)('restricted runtime reads committed retained scopes and exact saved results without new grants or writes', async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: isolatedTarget(target), connectionTimeoutMillis: 5000,
        statement_timeout: 10000, query_timeout: 12000 });
    let begun = false;
    try {
        await client.connect(); await client.query('BEGIN'); begun = true;
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        const before = (await client.query("SELECT pg_get_functiondef('nofries.guard_starter_scope()'::regprocedure) AS body")).rows[0].body;
        assert.match(before, /336 hours/); assert.doesNotMatch(before, /nf-starter-2026-10-r2/);
        // Only the already-reviewed, unnumbered trial proposal is exercised;
        // both it and all synthetic rows are rolled back. Deferred receipt FKs
        // allow synthetic canonical rows without pretending this seeds a real
        // published callback/activation or proves transaction publication.
        await client.query(fs.readFileSync(path.join(__dirname, '../database/proposals/customer_three_calendar_month_trial.sql'), 'utf8'));
        async function insert(table, row) {
            const keys = Object.keys(row), values = keys.map(k => typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k]);
            await client.query(`INSERT INTO nofries.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, values);
        }
        for (const consultant of [false, true]) {
            await client.query('SAVEPOINT fixture');
            const f = await retainedTrialFixture({ client: consultant });
            await insert('dashboard_runtime_instance', projectCurrentRow('instance', f.state.instance, { receiptId: crypto.randomUUID() }));
            await insert('dashboard_starter_accounts', { account_id: f.account.accountId,
                email_sha256: crypto.createHash('sha256').update('nofries:starter-email:v1\0' + f.email).digest('hex'),
                subject_key: f.actor, account_type: f.account.accountType, created_at: START, activated_at: START });
            for (const [tenantId, fact] of f.scopes) {
                const p = fact.retained.preparation, s = fact.snapshot, slot = p.slot;
                await insert('dashboard_starter_scopes', { tenant_id: tenantId, organisation_id: slot.organisationId,
                    account_id: f.account.accountId, account_type: f.account.accountType, subject_key: f.actor,
                    ordinal: f.account.organisations.findIndex(item => item.bindingId === slot.bindingId), authority_id: slot.authorityId, binding_id: slot.bindingId,
                    preparation: p, activation: fact.retained.activation });
                await insert('dashboard_tenants', { tenant_id: tenantId, schema_version: 1,
                    revision: s.tenantAggregate.tenant.revision, payload: s.tenantAggregate.tenant });
                const stateRow = payload => ({ tenant_id: tenantId, organisation_id: slot.organisationId,
                    schema_version: 1, revision: payload.revision, payload });
                await insert('dashboard_organisations', stateRow(s.tenantAggregate.organisations[0]));
                await insert('dashboard_membership_states', stateRow(s.membershipState));
                await insert('dashboard_entitlement_states', stateRow(s.entitlementState));
                await insert('dashboard_feature_flags', stateRow(s.flags));
                for (const usage of s.usage) await insert('dashboard_usage', { ...stateRow(usage), grant_id: usage.grantId });
                await insert('dashboard_admission_authorities', projectCurrentRow('authority', fact.admission));
                await insert('dashboard_admission_decisions', projectCurrentRow('admission', fact.admission));
                await insert('dashboard_identity_bindings', projectCurrentRow('binding', fact.binding));
            }
            for (const version of f.versions) { await ncsc.appendVersion(client, version); await ncsc.moveHead(client, version); }
            const queries = [];
            const database = { async withTenantTransaction(tenantId, work) {
                assert.equal(tenantId, f.account.organisations[0].tenantId);
                await client.query("SELECT set_config('nofries.tenant_id',$1,true)", [tenantId]);
                return work({ async query(sql, params) { queries.push(sql); return client.query(sql, params); } });
            } };
            await client.query('SET LOCAL ROLE nofries_runtime');
            try {
                assert.deepEqual((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
                    { rolsuper: false, rolbypassrls: false });
                const reader = createRetainedTrialAssessmentReader({ ...f.options, database });
                const result = await reader.read({}, f.input);
                assert.equal(result.assessment.submission.revision, 2); assert.equal(result.readOnly, true);
                assert.ok(queries.some(sql => sql.includes('pg_advisory_xact_lock_shared')));
                assert.ok(queries.every(sql => /^\s*SELECT\b/.test(sql)));
                assert.ok(queries.filter(sql => /dashboard_starter_scopes|dashboard_admission_/.test(sql)).every(sql => !/FOR (?:SHARE|UPDATE)/.test(sql)));
                await assert.rejects(reader.read({}, { ...f.input, assessmentId: 'different-assessment' }), e => e.code === 'retained_read_not_found');
                await assert.rejects(reader.read({}, { ...f.input, bindingId: crypto.randomUUID() }), e => e.code === 'retained_read_denied');
                const persisted = await dataStorage.loadSnapshotForShare(client, f.selected.binding.scope);
                assert.throws(() => resolveNcscAccess(persisted, { scope: f.selected.binding.scope,
                    identity: { subjectKey: f.actor }, resolvedAt: f.state.now }, 'assessment.write', f.state.now), /ncsc_access_denied/);
                const other = new Client({ connectionString: isolatedTarget(target), connectionTimeoutMillis: 5000 });
                await other.connect();
                try {
                    await other.query('BEGIN'); await other.query('SET LOCAL ROLE nofries_runtime');
                    for (const [namespace, key] of [[71001, f.state.capture.sessionSha256], [71002, f.state.capture.instanceId],
                        ...f.account.organisations.map(item => [71003, item.authorityId])]) {
                        assert.equal((await other.query('SELECT pg_try_advisory_xact_lock($1::integer,hashtext($2)) AS acquired', [namespace, key])).rows[0].acquired, false);
                    }
                } finally { try { await other.query('ROLLBACK'); } finally { await other.end(); } }
                // Actual canonical revocation/status changes deny under the
                // runtime role, including the consultant's original account.
                for (const change of ['binding', 'tenant']) {
                    await client.query('RESET ROLE'); await client.query('SAVEPOINT disabled');
                    if (change === 'binding') await client.query("UPDATE nofries.dashboard_identity_bindings SET status='revoked',revision=1,updated_at=$1 WHERE binding_id=$2",
                        [f.state.now, f.account.organisations[0].bindingId]);
                    else {
                        const tenant = { ...f.original.snapshot.tenantAggregate.tenant, revision: 1, recordStatus: 'suspended' };
                        await client.query('UPDATE nofries.dashboard_tenants SET revision=1,payload=$1::jsonb WHERE tenant_id=$2', [JSON.stringify(tenant), tenant.tenantId]);
                    }
                    await client.query('SET LOCAL ROLE nofries_runtime');
                    await assert.rejects(reader.read({}, f.input), e => e.code === 'retained_read_denied');
                    await client.query('RESET ROLE'); await client.query('ROLLBACK TO SAVEPOINT disabled');
                    await client.query('SET LOCAL ROLE nofries_runtime');
                }
                // RLS still hides another subject's immutable starter scope.
                await client.query("SELECT set_config('nofries.subject_key',$1,true)", [crypto.randomUUID() + ':' + crypto.randomUUID()]);
                assert.equal((await client.query('SELECT preparation FROM nofries.dashboard_starter_scopes')).rowCount, 0);
            } finally { await client.query('RESET ROLE'); }
            await client.query('ROLLBACK TO SAVEPOINT fixture');
        }
        await client.query('ROLLBACK'); begun = false;
        assert.equal((await client.query("SELECT pg_get_functiondef('nofries.guard_starter_scope()'::regprocedure) AS body")).rows[0].body, before);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM nofries.dashboard_starter_accounts')).rows[0].count, 0);
    } finally {
        try { if (begun) await client.query('ROLLBACK'); } finally { await client.end(); }
    }
}, 30000);
