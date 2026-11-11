'use strict';

// Native checks of migration 0019 (#151) in a disposable database on the loopback
// CI server, so two sessions can commit and race. Scope writes run as nofries_runtime.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createStarterAccountAllocator, starterAccountRecord, STARTER_SLOT_FIELDS } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, compileStarterAdmission, starterBootstrapCommand,
    starterActivationCommands } = require('../../api/shared/customerSignup/starterProvisioning');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresSignupAcceptanceJournal } = require('../../api/shared/customerSignup/postgresSignupAcceptanceJournal');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const MIGRATIONS = path.join(__dirname, '../../database/migrations');
const migration = fs.readFileSync(path.join(MIGRATIONS, '0019_starter_client_discard.sql'), 'utf8');
const DAY = 86400000;
const INSERT_SCOPE = 'INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)';
const ACTIVATE = 'UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2';
const DISCARD = "UPDATE nofries.dashboard_starter_scopes SET discarded_at=date_trunc('milliseconds',clock_timestamp()) WHERE tenant_id=$1 AND activation IS NULL AND discarded_at IS NULL";
const guardOf = sql => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION nofries.guard_starter_scope()'), sql.indexOf('$guard$;'));

module.exports = function registerStarterClientDiscardTests() {
test('migration 0019 adds one column grant, rewrites no rows and keeps every 0017 guard line but the account lock', () => {
    expect(migration.match(/\bGRANT\b.*/g)).toEqual(['GRANT UPDATE (discarded_at) ON nofries.dashboard_starter_scopes TO nofries_runtime;']);
    expect(migration).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE|REVOKE)\s+nofries\.|SECURITY\s+DEFINER|DISABLE\s+ROW|DROP\s+(TABLE|COLUMN|TRIGGER)/i);
    const after = guardOf(migration).split('\n'), before = guardOf(fs.readFileSync(path.join(MIGRATIONS, '0017_starter_client_period.sql'), 'utf8')).split('\n');
    expect(before.filter(line => !after.includes(line))).toEqual([expect.stringMatching(/^DECLARE /), expect.stringMatching(/subject_key = NEW\.subject_key FOR SHARE;$/)]);
    expect(after).toEqual(expect.arrayContaining([expect.stringMatching(/subject_key = NEW\.subject_key FOR UPDATE;$/),
        expect.stringMatching(/IF used >= 3 THEN RAISE EXCEPTION 'starter_client_limit'/)]));
});

(target ? describe : describe.skip)('starter client discard and activation limit (migration 0019)', () => {
    const key = crypto.randomBytes(8).toString('hex'), databaseName = `nofries_client_discard_${key}`;
    let control, url, created = false;
    const clients = [];
    async function connect() {
        const client = new (require('pg').Client)({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
        await client.connect(); clients.push(client); return client;
    }
    beforeAll(async () => {
        const base = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('disposable_loopback_database_required');
        control = new (require('pg').Client)({ connectionString: target, connectionTimeoutMillis: 5000 });
        await control.connect(); await control.query(`CREATE DATABASE "${databaseName}"`); created = true;
        base.pathname = '/' + databaseName; url = base.toString();
        await applyMigrations({ client: await connect() });
    });
    afterAll(async () => {
        for (const client of clients) await client.end().catch(() => {});
        if (control) try { if (created) await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); } finally { await control.end(); }
    });

    async function tx(db, work) {
        await db.query('BEGIN');
        try { const result = await work(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    // Inside a transaction: the runtime role with one subject and scope context.
    async function asRuntime(db, subject, scope, work) {
        await db.query("SELECT set_config('nofries.subject_key',$1,true),set_config('nofries.tenant_id',$2,true),set_config('nofries.organisation_id',$3,true)",
            [subject, scope.tenantId, scope.organisationId]);
        await db.query('SET LOCAL ROLE nofries_runtime');
        let result; // After a refusal the caller rolls back, which ends SET LOCAL ROLE; keep the original error.
        try { result = await work(); } catch (error) { await db.query('RESET ROLE').catch(() => {}); throw error; }
        await db.query('RESET ROLE'); return result;
    }
    const runtime = (db, subject, scope, work) => tx(db, () => asRuntime(db, subject, scope, work));
    const refusedAs = (db, subject, scope, sql, params, pattern) => assert.rejects(runtime(db, subject, scope, () => db.query(sql, params)), pattern);
    const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

    // A consultant whose own organisation was activated a day ago, with `drafts`
    // reserved client organisations. The allocator reserves up to three; later
    // drafts are appended to the record as a reservation made after a discard.
    async function consultant(db, drafts) {
        const dbNow = Date.parse((await db.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString());
        const activatedAt = new Date(dbNow - DAY).toISOString(), createdMs = Date.parse(activatedAt) - 60000;
        const email = 'synthetic-' + crypto.randomUUID() + '@example.test';
        const identity = { policyId: 'synthetic-native', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
            identityTenantId: crypto.randomUUID(), oid: crypto.randomUUID(), audience: 'synthetic-native' };
        const actor = identity.identityTenantId + ':' + identity.oid;
        let saved = null, clock = createdMs, activationFact = null;
        const accounts = createStarterAccountAllocator({ now: () => clock, readActivation: async () => activationFact,
            captureOwner: async () => ({ subjectKey: actor, email }),
            store: { load: async () => saved, create: async (_, record) => { saved = { record, version: 1 }; return true; },
                replace: async (_, version, record) => { saved = { record, version: version + 1 }; return true; } } });
        const initial = await accounts.reserveInitial({ schemaVersion: 1, requestId: crypto.randomUUID(), email, organisationName: 'Synthetic consultancy',
            accountType: 'consultant', status: 'verified', codeHash: null, attempts: 0, createdAt: createdMs - 1000,
            codeExpiresAt: createdMs + 599000, expiresAt: createdMs + 86399000, verifiedAt: createdMs });
        activationFact = { email, subjectKey: actor, accountId: initial.accountId, organisationId: initial.organisations[0].organisationId,
            receiptId: initial.organisations[0].activationId, activatedAt };
        clock = dbNow; await accounts.activate({});
        for (let n = 0; n < Math.min(drafts, 3); n++) await accounts.reserveClient({}, { requestId: crypto.randomUUID(), organisationName: 'Synthetic client ' + n });
        let account = saved.record;
        for (let n = 3; n < drafts; n++) account = starterAccountRecord({ ...account, organisations: [...account.organisations,
            Object.fromEntries(STARTER_SLOT_FIELDS.map(k => [k, k === 'kind' ? 'client' : k === 'organisationName' ? 'Synthetic client ' + n : crypto.randomUUID()]))] });
        await db.query('INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type,created_at,activated_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [account.accountId, crypto.createHash('sha256').update(email).digest('hex'), actor, 'consultant', new Date(createdMs).toISOString(), activatedAt]);
        return { account, identity, actor, activatedAt, email, createdAt: new Date(dbNow).toISOString() };
    }
    function preparation(c, ordinal) {
        const slot = c.account.organisations[ordinal];
        return compileStarterProvisioning({ account: c.account, requestId: slot.requestId, source: {
            offerInput: { ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])),
                accountType: 'consultant', contact: { name: 'Synthetic Owner', role: 'Owner', email: c.email, address: 'Synthetic address',
                    registrationId: null, authorityEvidenceId: crypto.randomUUID() },
                framework: { moduleId: 'cyber_security', profileId: 'synthetic-native', version: '1', scoringVersion: '1' } },
            subjectKey: c.actor, issuerSubjectKey: c.actor, invitationId: crypto.randomUUID(), createdAt: c.createdAt } });
    }
    const database = (db, p) => ({ withTenantTransaction: async (tenant, work) => { assert.equal(tenant, p.scope.tenantId); return work(db); } });
    // Prepare and commit a draft exactly as production's prepare phase does:
    // the runtime inserts the scope, then the organisation is initialised.
    async function draft(db, c, ordinal) {
        const p = preparation(c, ordinal);
        await tx(db, async () => {
            await asRuntime(db, c.actor, p.scope, () => db.query(INSERT_SCOPE, [p.scope.tenantId, p.scope.organisationId, c.account.accountId,
                'consultant', c.actor, p.ordinal, p.slot.authorityId, p.slot.bindingId, JSON.stringify(p)]));
            await createPostgresDashboardRepository({ database: database(db, p), clock: () => p.createdAt, authoriseAdministration: () => true })
                .initialiseOrganisation(starterBootstrapCommand(p), p.initialState);
        });
        return p;
    }
    // Inside the caller's transaction: record consent and product state, then
    // compile the activation at the database clock, as production does.
    async function activation(db, c, p) {
        const occurredAt = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0].at;
        const acceptance = { receiptId: crypto.randomUUID(), invitationId: p.invitationId, subjectKey: c.actor, ...p.scope, ...p.terms,
            scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest, acceptedAt: Date.parse(occurredAt),
            status: 'pending_admission', dashboardAccess: false };
        await createPostgresSignupAcceptanceJournal({ database: database(db, p) }).persist(acceptance);
        const compiled = compileStarterAdmission({ preparation: p, acceptance, identity: c.identity, occurredAt, accountActivatedAt: c.activatedAt });
        const repository = createPostgresDashboardRepository({ database: database(db, p), clock: () => occurredAt, authoriseAdministration: () => true });
        for (const command of starterActivationCommands(p, compiled)) {
            if (command.type === 'usage.reserve') await repository.reserveInitialMembership(command);
            else await repository.executeAuthorityCommand(command);
        }
        return compiled.activation;
    }
    async function activate(db, c, p) {
        await tx(db, async () => {
            const a = await activation(db, c, p);
            await asRuntime(db, c.actor, p.scope, () => db.query(ACTIVATE, [JSON.stringify(a), p.scope.tenantId]));
        });
    }
    const discard = (db, c, p, scope = p.scope, subject = c.actor) => runtime(db, subject, scope, async () => (await db.query(DISCARD, [p.scope.tenantId])).rowCount);
    const state = async (db, p) => (await rows(db, 'SELECT discarded_at, activation IS NOT NULL AS activated FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1', [p.scope.tenantId]))[0];

    test('catalog: one nullable column, update rights on activation and discarded_at only, and the replaced ordinal bound', async () => {
        const db = await connect();
        expect(await rows(db, "SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='nofries' AND table_name='dashboard_starter_scopes' AND column_name='discarded_at'"))
            .toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
        const rights = await rows(db, `SELECT a.attname AS column FROM pg_attribute a WHERE a.attrelid='nofries.dashboard_starter_scopes'::regclass
            AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('nofries_runtime', a.attrelid, a.attnum, 'UPDATE') ORDER BY a.attname`);
        expect(rights.map(r => r.column)).toEqual(['activation', 'discarded_at']);
        expect(await rows(db, "SELECT has_table_privilege('nofries_runtime','nofries.dashboard_starter_scopes','DELETE') AS d, has_table_privilege('nofries_runtime','nofries.dashboard_starter_scopes','TRUNCATE') AS t"))
            .toEqual([{ d: false, t: false }]);
        expect((await rows(db, "SELECT policyname,cmd FROM pg_policies WHERE schemaname='nofries' AND tablename='dashboard_starter_scopes' ORDER BY policyname")))
            .toEqual([{ policyname: 'starter_scopes_activate', cmd: 'UPDATE' }, { policyname: 'starter_scopes_discard', cmd: 'UPDATE' },
                { policyname: 'starter_scopes_new', cmd: 'INSERT' }, { policyname: 'starter_scopes_subject_read', cmd: 'SELECT' }]);
        const checks = await rows(db, "SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='nofries.dashboard_starter_scopes'::regclass ORDER BY conname");
        expect(checks.filter(r => /ordinal <= 3/.test(r.def))).toEqual([]);
        expect(checks.find(r => r.conname === 'dashboard_starter_scopes_ordinal_bound').def).toMatch(/ordinal >= 0.*ordinal <= 12.*account_type = 'consultant'.*ordinal = 0/);
        expect(checks.find(r => r.conname === 'dashboard_starter_scopes_discard_draft').def).toMatch(/discarded_at IS NULL\) OR \(\(activation IS NULL\) AND \(ordinal > 0\)/);
        expect(checks.find(r => r.conname === 'dashboard_starter_scopes_account_id_ordinal_key').def).toBe('UNIQUE (account_id, ordinal)');
        expect(await rows(db, "SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid='nofries.dashboard_starter_scopes'::regclass")).toEqual([{ forced: true }]);
    });

    test('replaying the migration body changes nothing', async () => {
        const db = await connect(), snapshot = async () => JSON.stringify({
            guard: await rows(db, "SELECT pg_get_functiondef('nofries.guard_starter_scope()'::regprocedure) AS body"),
            checks: await rows(db, "SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='nofries.dashboard_starter_scopes'::regclass ORDER BY conname"),
            policies: await rows(db, "SELECT policyname,cmd,roles,qual,with_check FROM pg_policies WHERE schemaname='nofries' AND tablename='dashboard_starter_scopes' ORDER BY policyname") });
        const before = await snapshot();
        await db.query('BEGIN'); await db.query(migration); expect(await snapshot()).toBe(before); await db.query('ROLLBACK');
    });

    test('the owner discards a draft once, before activation, and nobody else can', async () => {
        const db = await connect(), c = await consultant(db, 4), other = crypto.randomUUID() + ':' + crypto.randomUUID();
        const one = await draft(db, c, 1), two = await draft(db, c, 2), three = await draft(db, c, 3);
        // Another subject, or the owner in another organisation's context, sees no row to discard.
        expect(await discard(db, c, one, one.scope, other)).toBe(0);
        expect(await discard(db, c, one, two.scope)).toBe(0);
        expect(await discard(db, c, one, { ...one.scope, tenantId: crypto.randomUUID() })).toBe(0);
        expect((await state(db, one)).discarded_at).toBeNull();
        // The runtime cannot change any other column, delete, or insert a discarded row.
        for (const sql of ['UPDATE nofries.dashboard_starter_scopes SET ordinal=9 WHERE tenant_id=$1', 'DELETE FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1'])
            await refusedAs(db, c.actor, one.scope, sql, [one.scope.tenantId], /permission denied/);
        // A backdated or future time is refused by the guard.
        for (const at of ["clock_timestamp() - interval '1 hour'", "clock_timestamp() + interval '1 hour'"]) {
            await refusedAs(db, c.actor, one.scope, `UPDATE nofries.dashboard_starter_scopes SET discarded_at=${at} WHERE tenant_id=$1`, [one.scope.tenantId], /starter_scope_discard_invalid/);
        }
        expect(await discard(db, c, one)).toBe(1);
        const first = (await state(db, one)).discarded_at; expect(first).toBeInstanceOf(Date);
        expect(await discard(db, c, one)).toBe(0); expect((await state(db, one)).discarded_at).toEqual(first); // Only once.
        // Even the table owner, bypassing row security, cannot move or clear it.
        await assert.rejects(tx(db, () => db.query("UPDATE nofries.dashboard_starter_scopes SET discarded_at=NULL WHERE tenant_id=$1", [one.scope.tenantId])), /starter_scope_transition_invalid/);
        // A discarded draft cannot be activated.
        await assert.rejects(activate(db, c, one), /starter_scope_discarded/);
        // An activated organisation is never discarded: hidden from the runtime, refused for the owner.
        await activate(db, c, two);
        expect(await discard(db, c, two)).toBe(0);
        await assert.rejects(tx(db, async () => {
            await db.query("SELECT set_config('nofries.subject_key',$1,true)", [c.actor]);
            await db.query("UPDATE nofries.dashboard_starter_scopes SET discarded_at=date_trunc('milliseconds',clock_timestamp()) WHERE tenant_id=$1", [two.scope.tenantId]);
        }), /starter_scope_discard_invalid/);
        // The runtime cannot insert a draft that is already discarded.
        const four = preparation(c, 4);
        await refusedAs(db, c.actor, four.scope, INSERT_SCOPE.replace('preparation)', 'preparation,discarded_at)').replace('$9::jsonb)', '$9::jsonb,clock_timestamp())'),
            [four.scope.tenantId, four.scope.organisationId, c.account.accountId, 'consultant', c.actor, 4, four.slot.authorityId, four.slot.bindingId, JSON.stringify(four)], /row-level security/);
        expect((await state(db, three)).discarded_at).toBeNull();
    });

    test('three activated clients are the limit; a discarded draft frees its place for a later draft', async () => {
        const db = await connect(), c = await consultant(db, 5);
        const drafts = [await draft(db, c, 1), await draft(db, c, 2), await draft(db, c, 3)];
        expect(await discard(db, c, drafts[2])).toBe(1);
        const fourth = await draft(db, c, 4), fifth = await draft(db, c, 5);
        await activate(db, c, drafts[0]); await activate(db, c, drafts[1]); await activate(db, c, fourth);
        // A draft beyond the limit may exist but cannot activate.
        await assert.rejects(activate(db, c, fifth), /starter_client_limit/);
        expect((await state(db, fifth)).activated).toBe(false); expect(await discard(db, c, fifth)).toBe(1);
        expect(await rows(db, 'SELECT count(*)::int AS n FROM nofries.dashboard_starter_scopes WHERE account_id=$1 AND activation IS NOT NULL AND ordinal>0', [c.account.accountId])).toEqual([{ n: 3 }]);
        // Ordinals stay unique and at most 12 (as the owner, so row security does not refuse first).
        await assert.rejects(tx(db, () => db.query('UPDATE nofries.dashboard_starter_scopes SET ordinal=13 WHERE tenant_id=$1', [fifth.scope.tenantId])), /starter_scope_transition_invalid/);
        const insertAs = ordinal => {
            const scope = { tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID() };
            return tx(db, () => db.query(INSERT_SCOPE, [scope.tenantId, scope.organisationId, c.account.accountId, 'consultant', c.actor, ordinal,
                crypto.randomUUID(), crypto.randomUUID(), JSON.stringify({ ...fifth, scope })]));
        };
        await assert.rejects(insertAs(13), /dashboard_starter_scopes_ordinal_bound/);
        await assert.rejects(insertAs(4), /dashboard_starter_scopes_account_id_ordinal_key/);
        await insertAs(12);
    });

    test('a client activation outside READ COMMITTED is refused', async () => {
        const db = await connect(), c = await consultant(db, 1), p = await draft(db, c, 1);
        for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
            await db.query('BEGIN ISOLATION LEVEL ' + level);
            try {
                const a = await activation(db, c, p);
                await assert.rejects(asRuntime(db, c.actor, p.scope, () => db.query(ACTIVATE, [JSON.stringify(a), p.scope.tenantId])), /starter_activation_isolation_invalid/);
            } finally { await db.query('ROLLBACK'); }
        }
        await activate(db, c, p);
    });

    async function waitForLock(db, pid) {
        for (let n = 0; n < 100; n++) {
            const [row] = await rows(db, 'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
            if (row?.wait_event_type === 'Lock') return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('session_not_waiting_for_lock');
    }

    test('two concurrent activations for the last place: the second waits for the account lock and is refused', async () => {
        const setup = await connect(), first = await connect(), second = await connect(), c = await consultant(setup, 4);
        const p = [await draft(setup, c, 1), await draft(setup, c, 2), await draft(setup, c, 3), await draft(setup, c, 4)];
        await activate(setup, c, p[0]); await activate(setup, c, p[1]);
        const pid = (await rows(second, 'SELECT pg_backend_pid() AS pid'))[0].pid;
        await first.query('BEGIN'); await second.query('BEGIN');
        const a = await activation(first, c, p[2]), b = await activation(second, c, p[3]);
        await asRuntime(first, c.actor, p[2].scope, () => first.query(ACTIVATE, [JSON.stringify(a), p[2].scope.tenantId]));
        const racing = asRuntime(second, c.actor, p[3].scope, () => second.query(ACTIVATE, [JSON.stringify(b), p[3].scope.tenantId]))
            .then(() => 'activated', error => error.message);
        await waitForLock(setup, pid);
        await first.query('COMMIT'); expect(await racing).toBe('starter_client_limit'); await second.query('ROLLBACK');
        expect(await rows(setup, 'SELECT ordinal, activation IS NOT NULL AS activated FROM nofries.dashboard_starter_scopes WHERE account_id=$1 AND ordinal>0 ORDER BY ordinal', [c.account.accountId]))
            .toEqual([{ ordinal: 1, activated: true }, { ordinal: 2, activated: true }, { ordinal: 3, activated: true }, { ordinal: 4, activated: false }]);
    });

    test('a discard committed while an activation of the same draft waits: the activation is refused', async () => {
        const setup = await connect(), first = await connect(), second = await connect(), c = await consultant(setup, 1), p = await draft(setup, c, 1);
        const pid = (await rows(second, 'SELECT pg_backend_pid() AS pid'))[0].pid;
        await first.query('BEGIN'); await second.query('BEGIN');
        const a = await activation(second, c, p);
        expect(await asRuntime(first, c.actor, p.scope, async () => (await first.query(DISCARD, [p.scope.tenantId])).rowCount)).toBe(1);
        const racing = asRuntime(second, c.actor, p.scope, () => second.query(ACTIVATE, [JSON.stringify(a), p.scope.tenantId]))
            .then(() => 'activated', error => error.message);
        await waitForLock(setup, pid);
        await first.query('COMMIT'); expect(await racing).toBe('starter_scope_discarded'); await second.query('ROLLBACK');
        expect((await state(setup, p)).activated).toBe(false);
        expect((await state(setup, p)).discarded_at).toBeInstanceOf(Date);
    });
});
};
