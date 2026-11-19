'use strict';

// Native checks of migration 0025 and the staff account wipe repository in a
// disposable database on the loopback CI server. A real consultant account is
// built as production builds one (two activated client organisations),
// then reset or deleted as nofries_account_wipe. A second account is the
// isolation sentinel and must be untouched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createStarterAccountAllocator } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, compileStarterAdmission, starterBootstrapCommand,
    starterActivationCommands } = require('../../api/shared/customerSignup/starterProvisioning');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresSignupAcceptanceJournal } = require('../../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES } = require('../../api/shared/dashboardAdmin/accountWipeRepository');
const { seedSource, selectedSource, insertStart } = require('../fixtures/paidStartNcscScope');
const outbox = require('../../api/shared/lifecycleEmail/outboxWriter');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const migration = fs.readFileSync(path.join(__dirname, '../../database/migrations/0025_account_wipe_role.sql'), 'utf8');
const DAY = 86400000;
const INSERT_SCOPE = 'INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)';
const ACTIVATE = 'UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2';

module.exports = function registerAccountWipeTests() {
test('migration 0025 grants only SELECT and DELETE to the new capability and changes no other role', () => {
    // Statements only: the header's rollback note names DROP and REVOKE.
    const statements = migration.replace(/^\s*--.*$/gm, '');
    const grants = statements.match(/\bGRANT\b[^;']*/g);
    expect(grants.every(line => /^GRANT (USAGE ON SCHEMA nofries|SELECT, DELETE ON .*) TO nofries_account_wipe$/.test(line.replace(/\s+/g, ' ')))).toBe(true);
    expect(statements).not.toMatch(/nofries_runtime\b(?!.*FROM)|\bREVOKE\b|SECURITY\s+DEFINER|DISABLE\s+ROW|DROP\s+|ALTER\s+TABLE|\bINSERT\s+INTO|\bUPDATE\s+nofries/i);
    expect(statements).toMatch(/WITH CHECK \(false\)/);
    expect(migration).toMatch(/^-- Rollback,/m);
});

(target ? describe : describe.skip)('staff account reset and delete (migration 0025)', () => {
    const key = crypto.randomBytes(8).toString('hex'), databaseName = `nofries_account_wipe_${key}`;
    let control, url, created = false, pool;
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
        pool = new (require('pg').Pool)({ connectionString: url, max: 2 });
    });
    afterAll(async () => {
        if (pool) await pool.end().catch(() => {});
        for (const client of clients) await client.end().catch(() => {});
        if (control) try { if (created) await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); } finally { await control.end(); }
    });

    async function tx(db, work) {
        await db.query('BEGIN');
        try { const result = await work(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    async function asRuntime(db, subject, scope, work) {
        await db.query("SELECT set_config('nofries.subject_key',$1,true),set_config('nofries.tenant_id',$2,true),set_config('nofries.organisation_id',$3,true)",
            [subject, scope.tenantId, scope.organisationId]);
        await db.query('SET LOCAL ROLE nofries_runtime');
        try { return await work(); } finally { await db.query('RESET ROLE').catch(() => {}); }
    }
    const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
    const database = (db, p) => ({ withTenantTransaction: async (tenant, work) => { assert.equal(tenant, p.scope.tenantId); return work(db); } });

    // A consultant activated a day ago with two reserved client organisations.
    async function consultant(db) {
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
        for (const n of [1, 2]) await accounts.reserveClient({}, { requestId: crypto.randomUUID(), organisationName: 'Synthetic client ' + n });
        const account = saved.record;
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
    // Prepare, record consent and activate one organisation as production does.
    async function organisation(db, c, ordinal) {
        const p = preparation(c, ordinal);
        await tx(db, async () => {
            await asRuntime(db, c.actor, p.scope, () => db.query(INSERT_SCOPE, [p.scope.tenantId, p.scope.organisationId, c.account.accountId,
                'consultant', c.actor, p.ordinal, p.slot.authorityId, p.slot.bindingId, JSON.stringify(p)]));
            await createPostgresDashboardRepository({ database: database(db, p), clock: () => p.createdAt, authoriseAdministration: () => true })
                .initialiseOrganisation(starterBootstrapCommand(p), p.initialState);
        });
        await tx(db, async () => {
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
            await asRuntime(db, c.actor, p.scope, () => db.query(ACTIVATE, [JSON.stringify(compiled.activation), p.scope.tenantId]));
        });
        return p;
    }
    async function account(db, bound = false) {
        // Two client organisations, set up and activated through the same path as production.
        const c = await consultant(db), first = await organisation(db, c, 1), second = await organisation(db, c, 2);
        await db.query("INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source) VALUES ($1,'nudge_unfinished',clock_timestamp(),'settings')",
            [c.account.accountId]);
        // A queued lifecycle email, written by the runtime as production writes it.
        await tx(db, () => asRuntime(db, c.actor, first.scope, () => outbox.enqueue(db, { ...first.scope, accountId: c.account.accountId,
            type: 'welcome', dedupeKey: 'welcome', notBefore: new Date().toISOString() })));
        // A contact request, written by the runtime role as the request route writes it (0026).
        await tx(db, () => asRuntime(db, c.actor, first.scope, () => db.query(`INSERT INTO nofries.dashboard_contact_requests
            (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
            VALUES ($1, $2, $3, $4, 'results', 'contact-request-v1', ($5::timestamptz AT TIME ZONE 'Pacific/Auckland')::date, $5::timestamptz)`,
        [first.scope.tenantId, first.scope.organisationId, crypto.randomUUID(), c.actor, new Date().toISOString()])));
        const ref = { profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1' };
        const state = { ...first.scope, assessmentId: 'paid-1', moduleId: 'cyber_security',
            profileRef: ref, updatedBy: c.actor, revision: 0 };
        await tx(db, () => asRuntime(db, c.actor, first.scope, () => db.query(`INSERT INTO nofries.dashboard_framework_revisions
            (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision, idempotency_key,
             intent_sha256, record_sha256, record) VALUES ($1,$2,$3,$4,'paid-1',0,'start',$5,$6,$7)`,
        [first.scope.tenantId, first.scope.organisationId, ref.profileId, ref.profileVersion,
            'a'.repeat(64), 'b'.repeat(64), JSON.stringify({ state })])));
        let source;
        if (bound) await tx(db, () => asRuntime(db, c.actor, first.scope, async () => {
            source = await seedSource(db, first.scope, c.actor);
            const submitted = source.get(2);
            await insertStart(db, first.scope, c.actor, submitted.envelope.scopePopulation.body, selectedSource(submitted));
        }));
        return { c, scope: first.scope, source, tenants: [first.scope.tenantId, second.scope.tenantId] };
    }
    // Row counts per table for one account, read by the CI owner (superuser).
    async function footprint(db, a) {
        const result = {};
        for (const table of DELETE_TENANT_TABLES) {
            result[table] = Number((await rows(db, `SELECT count(*) AS n FROM nofries.${table} WHERE tenant_id = ANY($1::text[])`, [a.tenants]))[0].n);
        }
        for (const [table, column, value] of [['dashboard_starter_accounts', 'account_id', a.c.account.accountId],
            ['email_preferences', 'account_id', a.c.account.accountId], ['signup_registrations', 'subject_key', a.c.actor]]) {
            result[table] = Number((await rows(db, `SELECT count(*) AS n FROM nofries.${table} WHERE ${column} = $1`, [value]))[0].n);
        }
        return result;
    }
    async function boundStart(db, account) {
        return (await db.query(`SELECT ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256, ncsc_scope_sha256
            FROM nofries.dashboard_framework_revisions WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id='source-bound-start'`,
        [account.scope.tenantId, account.scope.organisationId])).rows;
    }
    const wipeTarget = a => ({ accountId: a.c.account.accountId, subjectKey: a.c.actor, tenantIds: a.tenants });

    test('delete removes every row of the account and leaves another account untouched', async () => {
        const db = await connect(), doomed = await account(db, true), sentinel = await account(db, true);
        const before = await footprint(db, doomed), sentinelBefore = await footprint(db, sentinel);
        expect(before.dashboard_tenants).toBe(2); expect(before.dashboard_starter_scopes).toBe(2);
        expect(before.signup_acceptance_receipts).toBeGreaterThan(0); expect(before.dashboard_starter_accounts).toBe(1);
        expect(before.email_outbox).toBe(1); expect(before.dashboard_contact_requests).toBe(1); expect(before.dashboard_framework_revisions).toBe(2);
        expect(before.dashboard_ncsc_assessment_revisions).toBe(3);
        const controlBinding = await boundStart(db, sentinel);
        expect(controlBinding).toHaveLength(1);
        const result = await createAccountWipeRepository(pool).delete(wipeTarget(doomed));
        expect(result).toMatchObject({ mode: 'delete', tenants: 2 });
        expect(Object.values(await footprint(db, doomed)).every(n => n === 0)).toBe(true);
        expect(await footprint(db, sentinel)).toEqual(sentinelBefore);
        expect(await boundStart(db, sentinel)).toEqual(controlBinding);
    });

    test('reset clears working data and keeps the organisations, membership and sign-in', async () => {
        const db = await connect(), a = await account(db, true), before = await footprint(db, a);
        const sentinel = await account(db, true), sentinelBefore = await footprint(db, sentinel);
        expect(before.dashboard_contact_requests).toBe(1); expect(before.dashboard_framework_revisions).toBe(2);
        expect(before.dashboard_ncsc_assessment_revisions).toBe(3);
        const controlBinding = await boundStart(db, sentinel);
        expect(controlBinding).toHaveLength(1);
        await createAccountWipeRepository(pool).reset(wipeTarget(a));
        const after = await footprint(db, a);
        for (const table of RESET_TABLES) expect(after[table]).toBe(0);
        for (const table of DELETE_TENANT_TABLES.filter(t => !RESET_TABLES.includes(t))) expect(after[table]).toBe(before[table]);
        expect(await footprint(db, sentinel)).toEqual(sentinelBefore);
        expect(await boundStart(db, sentinel)).toEqual(controlBinding);
        expect(after.dashboard_starter_accounts).toBe(1); expect(after.email_preferences).toBe(1);
    });

    test('0033 binds only an explicit same-owner submission and its exact captured scope at an empty paid start', async () => {
        const db = await connect(), a = await account(db, true), other = await account(db, true);
        const submitted = a.source.get(2), body = submitted.envelope.scopePopulation.body, selected = selectedSource(submitted);
        const inAccount = (account, work) => tx(db, () => asRuntime(db, account.c.actor, account.scope, work));
        const start = (choice, scope = body, options = {}) => inAccount(a, () => insertStart(db, a.scope, a.c.actor, scope,
            choice, { assessmentId: 'probe', ...options }));
        const records = () => db.query(`SELECT ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256, ncsc_scope_sha256,
            record#>'{state,responses}' AS answers FROM nofries.dashboard_framework_revisions
            WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY assessment_id`, [a.scope.tenantId, a.scope.organisationId]);
        const bound = { ncsc_assessment_id: selected[0], ncsc_revision: selected[1], ncsc_revision_sha256: selected[2],
            ncsc_scope_sha256: selected[3], answers: [] };
        expect((await records()).rows).toContainEqual(bound);
        // A missing selection stays unbound even when every character of the text matches.
        await start([null, null, null, null], body, { assessmentId: 'text-only' });
        expect((await records()).rows.at(-1)).toEqual({ ncsc_assessment_id: null, ncsc_revision: null,
            ncsc_revision_sha256: null, ncsc_scope_sha256: null, answers: [] });
        const foreign = selectedSource(other.source.get(2));
        expect(other.source.get(2).envelope.scopePopulation.body).toEqual(body);
        expect(foreign[3]).not.toBe(selected[3]);
        for (const choice of [selectedSource(a.source.get(1)), foreign, [selected[0], selected[1], selected[2], foreign[3]],
            [selected[0], selected[1], foreign[2], selected[3]], [null, ...selected.slice(1)], [...selected.slice(0, 3), null]]) {
            await expect(start(choice)).rejects.toMatchObject({ code: '23514' });
        }
        await expect(start(selected, { description: body.description + ' ' })).rejects.toMatchObject({ code: '23514' });
        await expect(start(selected, body, { revision: 1 })).rejects.toMatchObject({ code: '23514' });
        await expect(start(selected, body, { responses: [{ itemId: 'PR.DS-11-Q1', optionId: 'partial' }] }))
            .rejects.toMatchObject({ code: '23514' });
        await expect(inAccount(a, () => db.query('UPDATE nofries.dashboard_framework_revisions SET ncsc_scope_sha256 = NULL')))
            .rejects.toMatchObject({ code: '42501' });
        expect((await records()).rows).toHaveLength(3);
        expect((await records()).rows).toContainEqual(bound);
    });

    test('0033 isolates organisations sharing a tenant and rolls back deletion of a referenced submission', async () => {
        const db = await connect(), a = await account(db, true), submitted = a.source.get(2);
        const selected = selectedSource(submitted), body = submitted.envelope.scopePopulation.body;
        const sibling = { tenantId: a.scope.tenantId, organisationId: crypto.randomUUID() };
        await db.query(`INSERT INTO nofries.dashboard_organisations
            SELECT tenant_id, $3, schema_version, revision, jsonb_set(payload,'{organisationId}',to_jsonb($3::text))
            FROM nofries.dashboard_organisations WHERE tenant_id=$1 AND organisation_id=$2`,
        [a.scope.tenantId, a.scope.organisationId, sibling.organisationId]);
        const fromSibling = (target, source) => tx(db, () => asRuntime(db, a.c.actor, sibling, () =>
            insertStart(db, target, a.c.actor, body, source, { assessmentId: 'sibling-start' })));
        await expect(fromSibling(sibling, selected)).rejects.toMatchObject({ code: '23514' });
        // The real foreign pin and an invented one give the same refusal when the
        // writer also tries to claim the other organisation as the paid target.
        await expect(fromSibling(a.scope, selected)).rejects.toMatchObject({ code: '23514' });
        await expect(fromSibling(a.scope, [...selected.slice(0, 3), '0'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
        const keys = [a.scope.tenantId, a.scope.organisationId, selected[0]];
        const owner = 'tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3';
        await expect(tx(db, async () => {
            await db.query('DELETE FROM nofries.dashboard_ncsc_assessments WHERE ' + owner, keys);
            await db.query('DELETE FROM nofries.dashboard_ncsc_assessment_revisions WHERE ' + owner + ' AND revision=$4',
                [...keys, selected[1]]);
        })).rejects.toMatchObject({ code: '23503', constraint: 'paid_start_ncsc_revision' });
        expect((await db.query('SELECT payload_sha256 FROM nofries.dashboard_ncsc_assessments WHERE ' + owner, keys)).rows)
            .toEqual([{ payload_sha256: selected[2] }]);
    });

    test('a tenant of another account aborts the whole call and removes nothing', async () => {
        const db = await connect(), a = await account(db), other = await account(db), before = await footprint(db, a);
        await expect(createAccountWipeRepository(pool).delete({ ...wipeTarget(a), tenantIds: [a.tenants[0], other.tenants[0]] }))
            .rejects.toMatchObject({ code: 'account_wipe_tenant_mismatch' });
        expect(await footprint(db, a)).toEqual(before);
        // The account row exists under another subject: the wipe role cannot see
        // it, but its preferences and tenant rows show it is still there.
        await expect(createAccountWipeRepository(pool).delete({ ...wipeTarget(a), subjectKey: other.c.actor }))
            .rejects.toMatchObject({ code: 'account_wipe_subject_mismatch' });
        expect(await footprint(db, a)).toEqual(before);
    });

    test('an account id with nothing left in the database is reported as not found', async () => {
        const db = await connect(), sentinel = await account(db), sentinelBefore = await footprint(db, sentinel);
        const { randomUUID } = require('node:crypto');
        await expect(createAccountWipeRepository(pool).delete({ accountId: randomUUID(), subjectKey: sentinel.c.actor, tenantIds: [randomUUID()] }))
            .rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
        expect(await footprint(db, sentinel)).toEqual(sentinelBefore);
    });

    test('the unfinished-signup probe is read only and sees an account the database still holds', async () => {
        const db = await connect(), a = await account(db), before = await footprint(db, a);
        const { randomUUID } = require('node:crypto');
        const repository = createAccountWipeRepository(pool);
        // Held: by its preferences (account id) or by any of its tenants.
        await expect(repository.probe({ accountId: a.c.account.accountId, subjectKey: null, tenantIds: [randomUUID()] })).resolves.toEqual({ mode: 'probe', held: true });
        await expect(repository.probe({ accountId: randomUUID(), subjectKey: null, tenantIds: [a.tenants[1]] })).resolves.toEqual({ mode: 'probe', held: true });
        // Nothing of it in the database: an unfinished signup.
        await expect(repository.probe({ accountId: randomUUID(), subjectKey: null, tenantIds: [randomUUID(), randomUUID()] })).resolves.toEqual({ mode: 'probe', held: false });
        expect(await footprint(db, a)).toEqual(before);
        // Only the probe accepts a missing subject.
        await expect(repository.delete({ accountId: a.c.account.accountId, subjectKey: null, tenantIds: a.tenants })).rejects.toMatchObject({ code: 'onboarding_input_invalid' });
        expect(await footprint(db, a)).toEqual(before);
    });

    test('the capability sees nothing without settings and can never insert or update', async () => {
        const db = await connect(), a = await account(db);
        await tx(db, async () => {
            await db.query('SET LOCAL ROLE nofries_account_wipe');
            expect((await db.query('SELECT count(*) AS n FROM nofries.dashboard_tenants')).rows[0].n).toBe('0');
            expect((await db.query('DELETE FROM nofries.dashboard_starter_accounts')).rowCount).toBe(0);
            await db.query("SELECT set_config('nofries.wipe_tenant_id',$1,true)", [a.tenants[0]]);
            await expect(db.query("UPDATE nofries.dashboard_organisations SET tenant_id = tenant_id WHERE tenant_id = $1", [a.tenants[0]]))
                .rejects.toMatchObject({ code: '42501' });
        }).catch(error => { if (error.code !== '42501') throw error; });
        const role = (await rows(db, "SELECT rolcanlogin, rolbypassrls, rolinherit FROM pg_roles WHERE rolname='nofries_account_wipe'"))[0];
        expect(role).toEqual({ rolcanlogin: false, rolbypassrls: false, rolinherit: false });
        expect((await rows(db, "SELECT count(*) AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname='nofries_account_wipe' AND (m.set_option OR m.inherit_option)"))[0].n).toBe('0');
        expect(await footprint(db, a)).toEqual(await footprint(db, a));
    });
});
};
