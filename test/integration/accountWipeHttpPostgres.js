'use strict';

// Registered by the existing disposable PostgreSQL/real HTTP suite. A customer
// signs in over real HTTP, submits an NCSC assessment, generates an
// improvement plan, records evidence metadata and reads the organisation
// directory, so assessments, plans, evidence, a customer session gate and
// no-tenant directory audit rows all exist as production writes them. The only
// trusted synthetic step links that tenant to a starter account and scope row.
// The wipe then runs through a separate login holding nofries_account_wipe
// with SET and without INHERIT, as production grants it. Every row outside the
// account must be unchanged.
const crypto = require('node:crypto');
const { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES } = require('../../api/shared/dashboardAdmin/accountWipeRepository');

module.exports = function registerAccountWipeHttpPostgres({ improvementHttpSetup, httpJson, getOwnerPool, loginClean,
    subject, evidenceSeedDatabase }) {
    const ACCOUNT_TABLES = ['dashboard_session_gates', 'dashboard_starter_accounts', 'email_preferences', 'signup_registrations'];
    const TABLES = [...DELETE_TENANT_TABLES, ...ACCOUNT_TABLES];
    const key = crypto.randomBytes(6).toString('hex'), loginRole = `nf_account_wipe_${key}`, password = `synthetic-only-${key}`;
    let wipePool = null, roleCreated = false;

    async function dump() {
        const result = {};
        for (const table of TABLES) {
            result[table] = (await getOwnerPool().query(`SELECT to_jsonb(r) AS value FROM nofries.${table} r ORDER BY to_jsonb(r)::text`))
                .rows.map(row => row.value);
        }
        return result;
    }
    // A row belongs to the account when it carries the account's tenant, or,
    // carrying no tenant, names its account, subject or customer sessions.
    function split(all, target) {
        const sessions = new Set(all.dashboard_session_gates.filter(row => row.subject_key === target.subjectKey
            && ['customer', 'onboarding_discovery'].includes(row.kind)).map(row => row.session_sha256));
        const owned = row => row.tenant_id !== undefined && row.tenant_id !== null ? row.tenant_id === target.tenantId
            : row.account_id === target.accountId || row.subject_key === target.subjectKey
                || sessions.has(row.session_sha256) || sessions.has(row.anchor_session_sha256);
        const mine = {}, others = {};
        for (const [table, rows] of Object.entries(all)) { mine[table] = rows.filter(owned); others[table] = rows.filter(row => !owned(row)); }
        return { mine, others, sessions };
    }
    const counts = rows => Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, list.length]));

    async function customer() {
        const scope = { tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID() };
        const h = await improvementHttpSetup({ customerProvider: true, customerAccountType: 'consultant', scope });
        expect(h.binding.scope).toEqual(scope);
        httpJson(await h.improvementPost(h.generateImprovement()), 200);
        const { evidenceFixture } = require('../fixtures/evidenceMetadataFixture');
        const evidence = evidenceFixture({ now: h.state.now, ...scope });
        expect(evidence.scope).toEqual(scope);
        evidence.command.actorSubjectKey = subject(h.principal);
        await require('../../api/shared/evidenceLifecycle/postgresEvidenceStore')
            .createPostgresEvidenceStore({ database: evidenceSeedDatabase(h) }).execute(evidence.command);
        httpJson(await h.get('organisations?limit=50'), 200);
        // Trusted synthetic link: the starter account and its client scope.
        const target = { accountId: crypto.randomUUID(), subjectKey: subject(h.principal), ...scope };
        await getOwnerPool().query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type,created_at)
            VALUES ($1,$2,$3,'consultant',clock_timestamp())`, [target.accountId, crypto.randomBytes(32).toString('hex'), target.subjectKey]);
        await getOwnerPool().query(`INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,
            ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,'consultant',$4,1,$5,$6,$7::jsonb)`,
        [scope.tenantId, scope.organisationId, target.accountId, target.subjectKey, crypto.randomUUID(), crypto.randomUUID(),
            JSON.stringify({ planId: 'nf-starter-2026-09-r1', scope, subjectKey: target.subjectKey, accountType: 'consultant', kind: 'client' })]);
        return { h, target };
    }
    const wipeTarget = t => ({ accountId: t.accountId, subjectKey: t.subjectKey, tenantIds: [t.tenantId] });

    describe('staff account reset and delete against real customer data', () => {
        beforeAll(async () => {
            const owner = getOwnerPool();
            await owner.query(`CREATE ROLE ${loginRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            roleCreated = true;
            await owner.query(`GRANT nofries_account_wipe TO ${loginRole} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            const url = new URL(owner.options.connectionString); url.username = loginRole; url.password = password;
            wipePool = new (require('pg').Pool)({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
        });
        afterAll(async () => {
            if (wipePool) await wipePool.end().catch(() => {});
            if (roleCreated) await getOwnerPool().query(`DROP ROLE ${loginRole}`);
        });

        test('delete removes assessments, plans, evidence, the session gate and directory audit, and nothing else', async () => {
            const { h, target } = await customer();
            const before = split(await dump(), target), mine = counts(before.mine);
            for (const table of ['dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessment_receipts',
                'dashboard_improvement_heads', 'dashboard_improvement_revisions', 'dashboard_evidence_heads', 'dashboard_evidence_revisions',
                'dashboard_evidence_receipts', 'dashboard_session_gates', 'dashboard_identity_bindings', 'dashboard_runtime_receipts',
                'dashboard_tenants', 'dashboard_starter_accounts', 'dashboard_starter_scopes']) expect([table, mine[table]]).not.toEqual([table, 0]);
            expect(before.sessions.size).toBeGreaterThan(0);
            const directoryAudit = before.mine.dashboard_runtime_audit.filter(row => row.tenant_id === null);
            expect(directoryAudit.length).toBeGreaterThan(0);

            const result = await createAccountWipeRepository(wipePool).delete(wipeTarget(target));
            expect(result).toMatchObject({ mode: 'delete', tenants: 1 });
            const after = split(await dump(), target);
            expect(Object.values(counts(after.mine)).every(n => n === 0)).toBe(true);
            expect(after.others).toEqual(before.others);
            const session = await h.get('session');
            expect(session.status).not.toBe(200);
            await loginClean();
        });

        test('reset removes only assessments, plans and evidence, and the customer stays signed in', async () => {
            const { h, target } = await customer();
            const before = split(await dump(), target);
            for (const table of RESET_TABLES) if (table.startsWith('dashboard_ncsc') || table.startsWith('dashboard_improvement')
                || table.startsWith('dashboard_evidence')) expect([table, before.mine[table].length]).not.toEqual([table, 0]);
            await createAccountWipeRepository(wipePool).reset(wipeTarget(target));
            const after = split(await dump(), target);
            for (const table of RESET_TABLES) expect([table, after.mine[table].length]).toEqual([table, 0]);
            for (const table of TABLES.filter(t => !RESET_TABLES.includes(t))) {
                expect([table, after.mine[table]]).toEqual([table, before.mine[table]]);
            }
            expect(after.others).toEqual(before.others);
            httpJson(await h.get('session'), 200);
            await loginClean();
        });
    });
};
