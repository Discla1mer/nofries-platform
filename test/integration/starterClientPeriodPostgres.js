'use strict';

// Native check of migration 0017 against the real trigger and insert policy, as
// the restricted runtime role. Everything runs in one transaction that is rolled
// back, on the disposable CI database only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { accountWindow } = require('../../api/shared/customerSignup/customerStarterPlan');
const { createStarterAccountAllocator } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, compileStarterAdmission, starterBootstrapCommand,
    starterActivationCommands } = require('../../api/shared/customerSignup/starterProvisioning');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresSignupAcceptanceJournal } = require('../../api/shared/customerSignup/postgresSignupAcceptanceJournal');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const DAY = 86400000, HOURS_336 = 14 * DAY;
const INSERT_SCOPE = 'INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)';
const SET_ACTIVATION = 'UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2';

module.exports = function registerStarterClientPeriodTests() {
(target ? describe : describe.skip)('starter client organisations after the recorded 336 hours (migration 0017)', () => {
    let client, savepoints = 0;
    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Client } = require('pg');
        client = new Client({ connectionString: target, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
        await client.connect(); await client.query('BEGIN');
    });
    afterAll(async () => { if (client) { try { await client.query('ROLLBACK'); } finally { await client.end(); } } });

    async function refused(sql, params, pattern) {
        const name = 'refusal_' + (++savepoints);
        await client.query('SAVEPOINT ' + name);
        await assert.rejects(client.query(sql, params), pattern);
        await client.query('ROLLBACK TO SAVEPOINT ' + name);
    }
    const asRuntime = async (subject, slot, work) => {
        await client.query("SELECT set_config('nofries.subject_key',$1,true),set_config('nofries.tenant_id',$2,true),set_config('nofries.organisation_id',$3,true)",
            [subject, slot.tenantId, slot.organisationId]);
        await client.query('SET LOCAL ROLE nofries_runtime');
        try {
            assert.deepEqual((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0], { rolsuper: false, rolbypassrls: false });
            return await work();
        } finally { await client.query('RESET ROLE'); }
    };

    // A consultant account whose own organisation activated `ageMs` ago, with one
    // reserved client organisation prepared exactly as production prepares it.
    async function consultant(ageMs) {
        const dbNow = Date.parse((await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString());
        const activatedAt = new Date(dbNow - ageMs).toISOString(), createdMs = Date.parse(activatedAt) - 60000;
        const email = 'synthetic-' + crypto.randomUUID() + '@example.test', requestId = crypto.randomUUID(), clientRequestId = crypto.randomUUID();
        const identity = { policyId: 'synthetic-native', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
            identityTenantId: crypto.randomUUID(), oid: crypto.randomUUID(), audience: 'synthetic-native' };
        const actor = identity.identityTenantId + ':' + identity.oid;
        let saved = null, clock = createdMs, activationFact = null;
        const accounts = createStarterAccountAllocator({ now: () => clock, readActivation: async () => activationFact,
            captureOwner: async () => ({ subjectKey: actor, email }),
            store: { load: async () => saved, create: async (_, record) => { saved = { record, version: 1 }; return true; },
                replace: async (_, version, record) => { saved = { record, version: version + 1 }; return true; } } });
        const initial = await accounts.reserveInitial({ schemaVersion: 1, requestId, email, organisationName: 'Synthetic consultancy',
            accountType: 'consultant', status: 'verified', codeHash: null, attempts: 0, createdAt: createdMs - 1000,
            codeExpiresAt: createdMs + 599000, expiresAt: createdMs + 86399000, verifiedAt: createdMs });
        activationFact = { email, subjectKey: actor, accountId: initial.accountId, organisationId: initial.organisations[0].organisationId,
            receiptId: initial.organisations[0].activationId, activatedAt };
        clock = dbNow; await accounts.activate({});
        // Reserving a client slot is no longer bounded by the recorded period.
        const slot = await accounts.reserveClient({}, { requestId: clientRequestId, organisationName: 'Synthetic client' });
        const account = saved.record;
        assert.equal(account.activation.validUntil, new Date(Date.parse(activatedAt) + HOURS_336).toISOString());
        const preparation = compileStarterProvisioning({ account, requestId: clientRequestId, source: {
            offerInput: { ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])),
                accountType: 'consultant', contact: { name: 'Synthetic Owner', role: 'Owner', email, address: 'Synthetic address',
                    registrationId: null, authorityEvidenceId: crypto.randomUUID() },
                framework: { moduleId: 'cyber_security', profileId: 'synthetic-native', version: '1', scoringVersion: '1' } },
            subjectKey: actor, issuerSubjectKey: actor, invitationId: crypto.randomUUID(), createdAt: new Date(dbNow).toISOString() } });
        await client.query('INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type,created_at,activated_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [account.accountId, crypto.createHash('sha256').update(email).digest('hex'), actor, 'consultant', new Date(createdMs).toISOString(), activatedAt]);
        return { account, slot, preparation, identity, actor, activatedAt };
    }
    // Insert the client scope as the runtime role (the insert policy), create its
    // organisation, consent and product state, and compile its activation at the
    // database's own clock, as the production transaction does.
    async function prepared(c) {
        const { slot, preparation: p, actor } = c;
        await asRuntime(actor, slot, () => client.query(INSERT_SCOPE, [slot.tenantId, slot.organisationId, c.account.accountId, 'consultant', actor, 1,
            slot.authorityId, slot.bindingId, JSON.stringify(p)]));
        const database = { withTenantTransaction: async (tenant, work) => { assert.equal(tenant, slot.tenantId); return work(client); } };
        await createPostgresDashboardRepository({ database, clock: () => p.createdAt, authoriseAdministration: () => true })
            .initialiseOrganisation(starterBootstrapCommand(p), p.initialState);
        const occurredAt = (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0].at;
        const acceptance = { receiptId: crypto.randomUUID(), invitationId: p.invitationId, subjectKey: actor, ...p.scope, ...p.terms,
            scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest, acceptedAt: Date.parse(occurredAt),
            status: 'pending_admission', dashboardAccess: false };
        await createPostgresSignupAcceptanceJournal({ database }).persist(acceptance);
        const compiled = compileStarterAdmission({ preparation: p, acceptance, identity: c.identity, occurredAt, accountActivatedAt: c.activatedAt });
        const repository = createPostgresDashboardRepository({ database, clock: () => occurredAt, authoriseAdministration: () => true });
        for (const command of starterActivationCommands(p, compiled)) {
            if (command.type === 'usage.reserve') await repository.reserveInitialMembership(command);
            else await repository.executeAuthorityCommand(command);
        }
        return { compiled, occurredAt };
    }
    const moved = (activation, validUntil) => ({ ...activation, validUntil,
        admission: { ...activation.admission, payload: { ...activation.admission.payload, validUntil } } });

    test('migration replaces only the guard function and the insert policy and rewrites no rows', () => {
        const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../database/migrations/0017_starter_client_period.sql'), 'utf8');
        const statements = sql.replace(/--[^\n]*\n/g, '').replace(/\$guard\$[\s\S]*?\$guard\$/g, '').replace(/\$precheck\$[\s\S]*?\$precheck\$/g, '').split(';').map(s => s.trim()).filter(Boolean);
        expect(statements.map(s => s.split(/\s+/).slice(0, 3).join(' '))).toEqual(['DO', 'CREATE OR REPLACE', 'DROP POLICY IF', 'CREATE POLICY starter_scopes_new']);
        expect(sql).toMatch(/conname = 'dashboard_starter_scopes_versioned_contract'\) THEN\s+RAISE EXCEPTION/);
        expect(sql).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|ALTER\s+TABLE|TRUNCATE|GRANT|SECURITY\s+DEFINER)\b\s+nofries\./i);
        expect(sql).toMatch(/nf-starter-2026-09-r1/); expect(sql).toMatch(/257fdd66a5359392428c0e5f16734a7ac64ff886e9b359218e4e87b4c7f68acc/);
    });

    test('a client organisation is reserved and activated 15 days after the account, recording its own 336-hour period', async () => {
        const c = await consultant(15 * DAY), { compiled, occurredAt } = await prepared(c), a = compiled.activation;
        const ownEnd = new Date(Date.parse(occurredAt) + HOURS_336).toISOString(), originalEnd = c.account.activation.validUntil;
        expect(occurredAt > originalEnd).toBe(true);
        expect(a.validFrom).toBe(c.activatedAt); expect(a.validUntil).toBe(ownEnd); expect(a.validUntil).toBe(accountWindow(occurredAt).validUntil);
        expect(a.admission.payload).toMatchObject({ validFrom: occurredAt, validUntil: ownEnd });
        await asRuntime(c.actor, c.slot, async () => {
            // Every other refusal of the guard still fires for a late activation.
            for (const invalid of [
                moved(a, originalEnd),                                   // the account's passed end: would end before it starts
                moved(a, '2099-01-01T00:00:00.000Z'), moved(a, new Date(Date.parse(ownEnd) + 1).toISOString()),
                { ...a, validUntil: '2099-01-01T00:00:00.000Z' },        // activation and admission ends must agree
                { ...a, validFrom: occurredAt },                         // must still start at the account's activation
                { ...a, planId: 'nf-starter-2026-10-r2' }, { ...a, subjectKey: crypto.randomUUID() + ':' + crypto.randomUUID() },
                { ...a, bindingId: crypto.randomUUID() }, { ...a, scope: { ...a.scope, organisationId: crypto.randomUUID() } },
                { ...a, occurredAt: new Date(Date.parse(c.activatedAt) - 1).toISOString() },
                { ...a, occurredAt: new Date(Date.parse(occurredAt) + 3600000).toISOString() },
                { ...a, admission: { ...a.admission, payload: { ...a.admission.payload, decision: 'withdrawn' } } },
                { ...a, acceptance: { ...a.acceptance, termsDigest: 'b'.repeat(64) } }
            ]) await refused(SET_ACTIVATION, [JSON.stringify(invalid), c.slot.tenantId], /starter_activation_invalid|starter_product_invalid/);
            await client.query(SET_ACTIVATION, [JSON.stringify(a), c.slot.tenantId]);
            const stored = (await client.query('SELECT activation FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1', [c.slot.tenantId])).rows[0].activation;
            expect(stored).toEqual(a);
            expect((await client.query(SET_ACTIVATION, [JSON.stringify(a), c.slot.tenantId])).rowCount).toBe(0); // Set once.
        });
    });

    test('inside the first 336 hours a client still records the account\'s shared end, exactly as before', async () => {
        const c = await consultant(DAY), { compiled, occurredAt } = await prepared(c), a = compiled.activation;
        expect(a.validUntil).toBe(c.account.activation.validUntil); expect(a.admission.payload.validUntil).toBe(c.account.activation.validUntil);
        await asRuntime(c.actor, c.slot, async () => {
            await refused(SET_ACTIVATION, [JSON.stringify(moved(a, new Date(Date.parse(occurredAt) + HOURS_336).toISOString())), c.slot.tenantId], /starter_activation_invalid|starter_product_invalid/);
            await client.query(SET_ACTIVATION, [JSON.stringify(a), c.slot.tenantId]);
        });
    });

    test('the insert policy still refuses a client scope for an unactivated or foreign account', async () => {
        const c = await consultant(15 * DAY), p = c.preparation, slot = c.slot;
        const values = [slot.tenantId, slot.organisationId, c.account.accountId, 'consultant', c.actor, 1, slot.authorityId, slot.bindingId, JSON.stringify(p)];
        await client.query('SAVEPOINT unactivated');
        await client.query('ALTER TABLE nofries.dashboard_starter_accounts DISABLE TRIGGER starter_account_guard');
        await client.query('UPDATE nofries.dashboard_starter_accounts SET activated_at=NULL WHERE account_id=$1', [c.account.accountId]);
        await asRuntime(c.actor, slot, () => refused(INSERT_SCOPE, values, /row-level security/));
        await client.query('ROLLBACK TO SAVEPOINT unactivated');
        const other = crypto.randomUUID() + ':' + crypto.randomUUID();
        await asRuntime(other, slot, () => refused(INSERT_SCOPE, values, /row-level security/));
        await asRuntime(c.actor, { ...slot, tenantId: crypto.randomUUID() }, () => refused(INSERT_SCOPE, values, /row-level security/));
        await asRuntime(c.actor, slot, () => client.query(INSERT_SCOPE, values));
    });
});
};
