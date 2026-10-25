'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runner = typeof globalThis.test === 'function' ? globalThis : require('node:test');
const test = runner.test;
const { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, approvedStarterPlan, accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const proposal = fs.readFileSync(path.join(__dirname, '../database/proposals/customer_three_calendar_month_trial.sql'), 'utf8');
const target = String(process.env.NOFRIES_TRIAL_PROPOSAL_DATABASE_URL || '').trim();
function isolatedTarget(input) {
    let url;
    try { url = new URL(input); } catch { throw new Error('isolated_trial_proposal_database_required'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['/nofries_test_trial_proposal', '/nofries_ci_trial_proposal'].includes(url.pathname) || url.search || url.hash)
        throw new Error('isolated_trial_proposal_database_required');
    return input;
}
test('proposal fixture accepts only an explicit disposable loopback database', () => {
    assert.equal(isolatedTarget('postgresql://localhost/nofries_test_trial_proposal'), 'postgresql://localhost/nofries_test_trial_proposal');
    for (const input of ['', 'postgresql://remote.invalid/nofries_test_trial_proposal',
        'postgresql://localhost/nofries_production', 'postgresql://localhost/nofries_test_trial_proposal?host=remote.invalid',
        'postgresql://localhost/nofries_ci', 'https://localhost/nofries_test_trial_proposal']) assert.throws(() => isolatedTarget(input));
});
test('proposal remains outside the active catalog and contains no record rewrite, runtime grant or identity extension', () => {
    const migrations = fs.readdirSync(path.join(__dirname, '../database/migrations'));
    assert.ok(!JSON.stringify(migrations).includes('customer_three_calendar_month_trial'));
    assert.doesNotMatch(proposal, /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|GRANT)\s+nofries\./i);
    assert.doesNotMatch(proposal, /SECURITY\s+DEFINER|DISABLE\s+ROW\s+LEVEL\s+SECURITY|interval\s+'(?:90|93)\s+days'/i);
    assert.match(proposal, /UNAPPLIED PROPOSAL ONLY/);
    assert.match(proposal, /AT TIME ZONE 'UTC'/);
});

(target ? test : test.skip)('native proposal verifies closed preparation versions and UTC clamping, then rolls back all DDL and rows', async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: isolatedTarget(target), connectionTimeoutMillis: 5000,
        statement_timeout: 10000, query_timeout: 12000 });
    let begun = false;
    try {
        await client.connect(); await client.query('BEGIN'); begun = true;
        assert.equal((await client.query("SELECT to_regclass('nofries.dashboard_starter_scopes')::text AS name")).rows[0].name,
            'nofries.dashboard_starter_scopes', 'prepare only the explicit disposable database with catalog migrations first');
        const before = (await client.query("SELECT pg_get_functiondef('nofries.guard_starter_scope()'::regprocedure) AS body")).rows[0].body;
        assert.match(before, /336 hours/); assert.doesNotMatch(before, /nf-starter-2026-10-r2/);
        await client.query(proposal);
        for (const timezone of ['UTC', 'Pacific/Auckland', 'America/New_York']) {
            await client.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
            for (const at of ['2027-01-31T12:34:56.789Z', '2027-11-30T23:59:59.999Z', '2028-02-29T08:20:33.123Z']) {
                const result = await client.query("SELECT (($1::timestamptz AT TIME ZONE 'UTC')+interval '3 months') AT TIME ZONE 'UTC' AS expires", [at]);
                assert.equal(result.rows[0].expires.toISOString(), accountWindow(at, THREE_MONTH_PLAN_ID).validUntil);
            }
        }
        const plan = approvedStarterPlan(THREE_MONTH_PLAN_ID), accountId = crypto.randomUUID(), tenantId = crypto.randomUUID(), organisationId = crypto.randomUUID();
        const subjectKey = crypto.randomUUID() + ':' + crypto.randomUUID();
        await client.query('INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type) VALUES ($1,$2,$3,$4)',
            [accountId, crypto.createHash('sha256').update(accountId).digest('hex'), subjectKey, 'company']);
        const preparation = { planId: plan.planId, planSha256: plan.sha256, scope: { tenantId, organisationId }, subjectKey,
            accountType: 'company', kind: 'own', source: { offerInput: { planId: plan.planId } }, terms: { termsVersion: plan.termsVersion, termsDigest: plan.termsDigest } };
        const values = [tenantId, organisationId, accountId, 'company', subjectKey, 0, crypto.randomUUID(), crypto.randomUUID(), JSON.stringify(preparation)];
        const insert = 'INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)';
        for (const change of [{ planId: 'unknown' }, { planSha256: 'a'.repeat(64) }, { terms: { ...preparation.terms, termsDigest: 'b'.repeat(64) } }]) {
            await client.query('SAVEPOINT invalid_scope');
            await assert.rejects(client.query(insert, [...values.slice(0, -1), JSON.stringify({ ...preparation, ...change })]), error => error.code === '23514');
            await client.query('ROLLBACK TO SAVEPOINT invalid_scope');
        }
        await client.query(insert, values);
        assert.equal((await client.query('SELECT activated_at FROM nofries.dashboard_starter_accounts WHERE account_id=$1', [accountId])).rows[0].activated_at, null);
        // Exercise real original/new activation triggers as the restricted
        // runtime role. Owner setup is confined to this rolled-back fixture.
        const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
        const { compileStarterProvisioning, compileStarterAdmission, starterBootstrapCommand,
            starterActivationCommands } = require('../api/shared/customerSignup/starterProvisioning');
        const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
        const { createPostgresSignupAcceptanceJournal } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
        for (const version of [LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID]) {
            const at = Date.now(), email = 'synthetic-' + crypto.randomUUID() + '@example.test', requestId = crypto.randomUUID();
            let saved;
            const accounts = createStarterAccountAllocator({ planId: version, now: () => at,
                readActivation: async () => null, captureOwner: async () => null,
                store: { load: async () => saved || null, create: async (_, record) => { saved = { record, version: 1 }; return true; }, replace: async () => false } });
            const account = await accounts.reserveInitial({ schemaVersion: 1, requestId, email,
                organisationName: 'Synthetic native trial', accountType: 'consultant', status: 'verified', codeHash: null,
                attempts: 0, createdAt: at - 1000, codeExpiresAt: at + 599000, expiresAt: at + 86399000, verifiedAt: at });
            const slot = account.organisations[0], identity = { policyId: 'synthetic-native', policyRevision: 1,
                issuer: 'https://identity.example.test/v2.0', identityTenantId: crypto.randomUUID(), oid: crypto.randomUUID(), audience: 'synthetic-native' };
            const actor = identity.identityTenantId + ':' + identity.oid;
            const p = compileStarterProvisioning({ account, requestId, source: {
                offerInput: { ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])),
                    ...(version === THREE_MONTH_PLAN_ID ? { planId: version } : {}), accountType: account.accountType,
                    contact: { name: 'Synthetic Owner', role: 'Owner', email, address: 'Synthetic address', registrationId: null, authorityEvidenceId: crypto.randomUUID() },
                    framework: { moduleId: 'cyber_security', profileId: 'synthetic-native', version: '1', scoringVersion: '1' } },
                subjectKey: actor, issuerSubjectKey: actor, invitationId: crypto.randomUUID(), createdAt: new Date(at).toISOString() } });
            await client.query('INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type) VALUES ($1,$2,$3,$4)',
                [account.accountId, crypto.createHash('sha256').update(email).digest('hex'), actor, account.accountType]);
            await client.query(insert, [slot.tenantId, slot.organisationId, account.accountId, account.accountType, actor, 0,
                slot.authorityId, slot.bindingId, JSON.stringify(p)]);
            const database = { withTenantTransaction: async (tenant, work) => { assert.equal(tenant, slot.tenantId); return work(client); } };
            const repo = createPostgresDashboardRepository({ database, clock: () => new Date(at).toISOString(), authoriseAdministration: () => true });
            await repo.initialiseOrganisation(starterBootstrapCommand(p), p.initialState);
            const activationAt = (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0].at;
            const acceptance = { receiptId: crypto.randomUUID(), invitationId: p.invitationId, subjectKey: actor, ...p.scope, ...p.terms,
                scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest, acceptedAt: Date.parse(activationAt),
                status: 'pending_admission', dashboardAccess: false };
            await createPostgresSignupAcceptanceJournal({ database }).persist(acceptance);
            const compiled = compileStarterAdmission({ preparation: p, acceptance, identity, occurredAt: activationAt, accountActivatedAt: null });
            const activationRepo = createPostgresDashboardRepository({ database, clock: () => activationAt, authoriseAdministration: () => true });
            for (const command of starterActivationCommands(p, compiled)) {
                if (command.type === 'usage.reserve') await activationRepo.reserveInitialMembership(command);
                else await activationRepo.executeAuthorityCommand(command);
            }
            await client.query("SELECT set_config('nofries.subject_key',$1,true),set_config('nofries.tenant_id',$2,true),set_config('nofries.organisation_id',$3,true)", [actor, slot.tenantId, slot.organisationId]);
            await client.query('SET LOCAL ROLE nofries_runtime');
            try {
                assert.deepEqual((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0], { rolsuper: false, rolbypassrls: false });
                await client.query('UPDATE nofries.dashboard_starter_accounts SET activated_at=$1 WHERE account_id=$2', [activationAt, account.accountId]);
                for (const invalid of [{ ...compiled.activation, validUntil: '2099-01-01T00:00:00.000Z' },
                    { ...compiled.activation, planId: version === LEGACY_PLAN_ID ? THREE_MONTH_PLAN_ID : LEGACY_PLAN_ID }]) {
                    await client.query('SAVEPOINT invalid_activation');
                    await assert.rejects(client.query('UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2', [JSON.stringify(invalid), slot.tenantId]), /starter_activation_invalid/);
                    await client.query('ROLLBACK TO SAVEPOINT invalid_activation');
                }
                await client.query('UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2', [JSON.stringify(compiled.activation), slot.tenantId]);
                const retained = (await client.query('SELECT activation FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1', [slot.tenantId])).rows[0].activation;
                assert.deepEqual(retained, compiled.activation);
                assert.equal(retained.validUntil, accountWindow(activationAt, version).validUntil);
                await client.query('SAVEPOINT set_once');
                await assert.rejects(client.query('UPDATE nofries.dashboard_starter_accounts SET activated_at=$1 WHERE account_id=$2', [new Date(Date.parse(activationAt) + 1).toISOString(), account.accountId]), /starter_account_transition_invalid/);
                await client.query('ROLLBACK TO SAVEPOINT set_once');
            } finally { await client.query('RESET ROLE'); }
        }
        // Session publication, post-expiry current-auth reads and customer entry
        // still require separately reviewed integration; none are enabled here.
        await client.query('ROLLBACK'); begun = false;
        const after = (await client.query("SELECT pg_get_functiondef('nofries.guard_starter_scope()'::regprocedure) AS body")).rows[0].body;
        assert.equal(after, before);
    } finally {
        try { if (begun) await client.query('ROLLBACK'); }
        finally { await client.end(); }
    }
});
