'use strict';

const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { fixture, SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const { createHash } = require('node:crypto');
const { normaliseMembershipState } = require('../api/shared/appLifecycle/membershipDomain');
const { normaliseEntitlementState, TIERS } = require('../api/shared/appLifecycle/entitlementDomain');
const { normaliseAdvisorAssignment } = require('../api/shared/appLifecycle/portalPermissions');

const copy = value => JSON.parse(JSON.stringify(value));
const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}` : JSON.stringify(value);
const EMPTY = { tenant: null, organisation: null, membership: null, entitlement: null, flags: null, advisorAssignments: [], usage: [] };
const INITIAL = { tenant: 0, organisation: 0, membership: 2, entitlement: 1, flags: 1,
    advisorAssignments: [], usage: [{ grantId: 'synthetic-product', revision: 0 }] };

// Contract double only: SQL isolation/locks/constraints are independently proved
// by the real PostgreSQL suite registered through postgresMigration.test.js.
function memoryDatabase() {
    let records = {}, failInsert = null, loseCommit = false;
    let afterQuery = () => {};
    const queries = [];
    const database = {
        async withTenantTransaction(tenantId, work) {
            const draft = copy(records);
            const result = await work({ query: async (sql, args) => {
                queries.push({ sql, args: copy(args) });
                afterQuery(sql);
                const table = sql.match(/nofries\.(dashboard_\w+)/)?.[1];
                if (!table) throw new Error('Unexpected SQL contract');
                const rows = draft[table] || (draft[table] = []);
                if (sql.startsWith('SELECT')) {
                    const where = sql.split(' WHERE ')[1].split(/ ORDER BY | FOR /)[0];
                    const conditions = [...where.matchAll(/(\w+) = \$(\d+)/g)];
                    return { rows: copy(rows.filter(row => row.tenant_id === tenantId && conditions.every(m => row[m[1]] === args[Number(m[2]) - 1]))) };
                }
                if (sql.startsWith('INSERT')) {
                    if (failInsert === table) throw new Error('synthetic_precommit_failure');
                    const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
                    const expressions = sql.match(/VALUES \((.+?)\)(?: ON CONFLICT|$)/)[1].split(', ');
                    const row = Object.fromEntries(columns.map((column, i) => {
                        const reference = expressions[i].match(/\$(\d+)/);
                        let value = reference ? args[Number(reference[1]) - 1] : Number(expressions[i]);
                        if (column === 'payload') value = JSON.parse(value);
                        return [column, value];
                    }));
                    if (row.tenant_id !== tenantId) throw new Error('synthetic_rls_denial');
                    if (table === 'dashboard_tenants' && rows.some(item => item.tenant_id === tenantId)) return { rows: [], rowCount: 0 };
                    rows.push(row); return { rows: sql.includes('RETURNING') ? [{ tenant_id: tenantId }] : [], rowCount: 1 };
                }
                if (sql.startsWith('UPDATE')) {
                    const conditions = [...sql.split(' WHERE ')[1].matchAll(/(\w+) = \$(\d+)/g)];
                    const matches = rows.filter(row => row.tenant_id === tenantId && conditions.every(m => row[m[1]] === args[Number(m[2]) - 1]));
                    for (const row of matches) for (const m of sql.split(' SET ')[1].split(' WHERE ')[0].matchAll(/(\w+) = \$(\d+)/g)) {
                        const value = args[Number(m[2]) - 1]; row[m[1]] = m[1] === 'payload' ? JSON.parse(value) : value;
                    }
                    return { rowCount: matches.length, rows: [] };
                }
                throw new Error('Unexpected SQL contract');
            } });
            records = draft;
            if (loseCommit) { loseCommit = false; throw Object.assign(new Error('synthetic_lost_commit_response'), { code: 'postgres_commit_failed' }); }
            return result;
        }
    };
    return { database, queries, rows: table => records[table] || [],
        set afterQuery(value) { afterQuery = value; },
        set failInsert(value) { failInsert = value; }, set loseCommit(value) { loseCommit = value; } };
}

function setup(options = {}) {
    const source = copy(fixture(options));
    const initial = { tenantAggregate: source.tenantAggregate, membershipState: source.membershipState,
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: Object.values(source.advisorAssignments) };
    const memory = memoryDatabase();
    const state = { now: NOW, authorise: () => true };
    const repo = createPostgresDashboardRepository({ database: memory.database, clock: () => state.now,
        authoriseAdministration: (command, snapshot) => state.authorise(command, snapshot) });
    const scope = source.scope;
    const command = (type, operationId, expectedRevisions, payload) => ({ ...scope, actorSubjectKey: SUBJECT, type, operationId, expectedRevisions: copy(expectedRevisions), payload: copy(payload) });
    const bootstrap = () => repo.initialiseOrganisation(command('organisation.initialise', 'create-org', EMPTY, {}), initial);
    const reserve = (id = 'reserve-1', revisions = INITIAL) => command('usage.reserve', id, revisions,
        { grantId: 'synthetic-product', moduleId: 'cyber_security', limit: 'assessment_runs', amount: 1,
            framework: { profileId: 'synthetic-cyber_security', version: '1.0' } });
    return { memory, repo, initial, state, scope, command, bootstrap, reserve };
}

describe('canonical dashboard PostgreSQL repository contract', () => {
    test('requires explicit database, clock and trusted administrative authority without defaults', () => {
        expect(() => createPostgresDashboardRepository({})).toThrow();
        const h = setup();
        for (const authoriseAdministration of [undefined, true, {}]) expect(() => createPostgresDashboardRepository({
            database: h.memory.database, clock: () => NOW, authoriseAdministration })).toThrow();
    });

    test('explicit bootstrap and admission preserve canonical ownership/history/revisions with no legacy mapping', async () => {
        const h = setup();
        const result = await h.bootstrap();
        expect(result).toEqual({ operationId: 'create-org', type: 'organisation.initialise', reserved: false, resultRevisions: INITIAL, usage: null });
        const snapshot = await h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT });
        expect(snapshot.membershipState).toEqual(h.initial.membershipState);
        expect(snapshot.flags).toEqual(h.initial.flags);
        expect(snapshot.summary).toBeNull();
        expect(snapshot.advisorAssignments).toEqual({});
        expect(Object.isFrozen(snapshot.membershipState.memberships[0])).toBe(true);
        expect(h.memory.rows('dashboard_usage')[0].payload.counters).toEqual({ assessment_runs: 0, report_exports: 0, evidence_bytes: 0, memberships: 0, ai_requests: 0 });
        expect(h.memory.queries.at(-7).sql).toContain('FOR SHARE');
        expect(h.memory.rows('tenants')).toHaveLength(0);
    });

    test('reads never bootstrap missing current authority', async () => {
        const h = setup();
        await expect(h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT })).rejects.toMatchObject({ code: 'dashboard_not_found' });
        expect(h.memory.queries.every(item => item.sql.startsWith('SELECT'))).toBe(true);
    });

    test('trusted authority read recovers the complete current vector after repository restart', async () => {
        const h = setup(); await h.bootstrap();
        const result = await h.repo.reserveUsage(h.reserve());
        const authorise = jest.fn(() => true);
        const restarted = createPostgresDashboardRepository({ database: h.memory.database, clock: () => NOW, authoriseAdministration: authorise });
        const view = await restarted.readAuthoritySnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT });
        expect(view.revisions).toEqual(result.resultRevisions);
        expect(view.snapshot.usage[0].counters.assessment_runs).toBe(1);
        expect(authorise).toHaveBeenCalledWith({ ...h.scope, actorSubjectKey: SUBJECT, type: 'authority.read' }, view.snapshot);
        expect(Object.isFrozen(view.snapshot.usage)).toBe(true);
        h.state.authorise = () => false;
        await expect(h.repo.readAuthoritySnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT })).rejects.toMatchObject({ code: 'dashboard_administration_denied' });
    });

    test.each([false, null, {}, 'true', Promise.resolve(true)])('administration must return literal synchronous true (%p)', async outcome => {
        const h = setup(); h.state.authorise = () => outcome;
        await expect(h.bootstrap()).rejects.toMatchObject({ code: 'dashboard_administration_denied' });
        expect(h.memory.rows('dashboard_tenants')).toHaveLength(0);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(0);
    });

    test('administration exceptions deny and callback sees frozen seed state', async () => {
        const h = setup();
        h.state.authorise = (command, snapshot) => {
            expect(Object.isFrozen(command)).toBe(true);
            expect(Object.isFrozen(snapshot.proposed.membershipState)).toBe(true);
            throw new Error('private callback detail');
        };
        await expect(h.bootstrap()).rejects.toMatchObject({ code: 'dashboard_administration_denied' });
    });

    test('one reservation produces explicit usage and atomic safe transaction evidence', async () => {
        const h = setup(); await h.bootstrap();
        const result = await h.repo.reserveUsage(h.reserve());
        expect(result.usage.revision).toBe(1);
        expect(result.usage.counters.assessment_runs).toBe(1);
        expect(result.reserved).toBe(true);
        const receipt = h.memory.rows('dashboard_operation_receipts')[1].payload;
        expect(receipt.event).toEqual({ schemaVersion: 1, category: 'dashboard_transaction', outcome: 'committed',
            action: 'usage.reserve', actorSubjectKey: SUBJECT, ...h.scope, operationId: 'reserve-1', effect: 'quota_reserved' });
        expect(receipt.expectedRevisions).toEqual(INITIAL);
        expect(receipt.result).toEqual(result);
        expect(receipt.intentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(receipt)).not.toContain('synthetic-private-order');
    });

    test('exact replay returns original result after further usage and rejects altered intent', async () => {
        const h = setup(); await h.bootstrap(); const command = h.reserve();
        const first = await h.repo.reserveUsage(command);
        await h.repo.reserveUsage(h.reserve('reserve-2', first.resultRevisions));
        expect(await h.repo.reserveUsage(command)).toEqual(first);
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(2);
        const changed = copy(command); changed.payload.amount = 2;
        await expect(h.repo.reserveUsage(changed)).rejects.toMatchObject({ code: 'dashboard_operation_conflict' });
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(3);
    });

    test.each([
        ['tenant.transition', 'dashboard_tenants'], ['organisation.transition', 'dashboard_organisations'],
        ['membership.command', 'dashboard_membership_states'], ['entitlement.update', 'dashboard_entitlement_states'],
        ['flags.update', 'dashboard_feature_flags']
    ].flatMap(([type, table]) => [[type, table, false], [type, table, true]]))('mixed restore rejects %s ahead of %s (rehashed=%s)', async (type, table, rehashed) => {
        const h = setup(); await h.bootstrap();
        const before = copy(h.memory.rows(table)[0]);
        const payloads = {
            'tenant.transition': { toStatus: 'suspended' }, 'organisation.transition': { toStatus: 'suspended' },
            'membership.command': { action: 'suspend', payload: { membershipId: 'synthetic-membership' } },
            'entitlement.update': { ...h.initial.entitlementState, revision: 2 },
            'flags.update': { ...h.initial.flags, revision: 2 }
        };
        const command = h.command(type, 'authority-before-restore', INITIAL, payloads[type]);
        await h.repo.executeAuthorityCommand(command);
        h.memory.rows(table)[0] = before;
        if (rehashed) {
            const row = h.memory.rows('dashboard_operation_receipts')[1];
            row.payload.result.resultRevisions = copy(command.expectedRevisions);
            row.payload.resultRevisions = copy(command.expectedRevisions);
            row.payload.resultSha256 = row.result_sha256 = require('node:crypto').createHash('sha256').update(stableJson(row.payload.result)).digest('hex');
        }
        const start = h.memory.queries.length;
        await expect(h.repo.executeAuthorityCommand(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
        expect(h.memory.rows(table)[0]).toEqual(before);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(2);
        expect(h.memory.queries.slice(start).every(item => item.sql.startsWith('SELECT'))).toBe(true);
    });

    test.each([['missing', false], ['older', false], ['missing', true], ['older', true]])('mixed restore rejects %s advisor evidence (rehashed=%s), including initialisation replay', async (kind, rehashed) => {
        const h = setup({ role: 'fractional_advisor' });
        const initial = await h.bootstrap();
        let replay = h.bootstrap;
        if (kind === 'missing') h.memory.rows('dashboard_advisor_assignments').splice(0);
        else {
            const before = copy(h.memory.rows('dashboard_advisor_assignments')[0]);
            const command = h.command('advisor.put', 'advisor-before-restore', initial.resultRevisions,
                { ...before.payload, revision: before.payload.revision + 1, status: 'revoked' });
            await h.repo.executeAuthorityCommand(command);
            h.memory.rows('dashboard_advisor_assignments')[0] = before;
            replay = () => h.repo.executeAuthorityCommand(command);
        }
        if (rehashed) {
            const row = h.memory.rows('dashboard_operation_receipts').at(-1), vector = copy(initial.resultRevisions);
            if (kind === 'missing') vector.advisorAssignments = [];
            row.payload.result.resultRevisions = copy(vector); row.payload.resultRevisions = vector;
            row.payload.resultSha256 = row.result_sha256 = require('node:crypto').createHash('sha256').update(stableJson(row.payload.result)).digest('hex');
        }
        await expect(replay()).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
    });

    test.each(['olderRevision', 'sameRevisionCounter', 'laterRevisionCounter'])('mixed restore rejects quota receipt with %s in live usage', async kind => {
        const h = setup(); await h.bootstrap();
        const before = copy(h.memory.rows('dashboard_usage')[0]), command = h.reserve();
        const original = await h.repo.reserveUsage(command);
        if (kind === 'laterRevisionCounter') await h.repo.reserveUsage(h.reserve('later-reservation', original.resultRevisions));
        if (kind === 'olderRevision') h.memory.rows('dashboard_usage')[0] = before;
        else h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs = 0;
        const start = h.memory.queries.length;
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(0);
        expect(h.memory.queries.slice(start).every(item => item.sql.startsWith('SELECT'))).toBe(true);
    });

    test('replay requires all committed grant counters, including a different limit than this reservation', async () => {
        const h = setup(); await h.bootstrap();
        const evidence = h.command('usage.reserve', 'evidence-first', INITIAL,
            { grantId: 'synthetic-product', moduleId: 'evidence', limit: 'evidence_bytes', amount: 7, framework: null });
        const earlier = await h.repo.reserveUsage(evidence), command = h.reserve('assessment-after-evidence', earlier.resultRevisions);
        await h.repo.reserveUsage(command);
        h.memory.rows('dashboard_usage')[0].payload.counters.evidence_bytes = 0;
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
    });

    test.each(['missingGrant', 'nullRevision'])('internally consistent authority receipt cannot conceal %s evidence', async kind => {
        const h = setup(); await h.bootstrap();
        const row = h.memory.rows('dashboard_operation_receipts')[0], receipt = row.payload;
        if (kind === 'missingGrant') receipt.result.resultRevisions.usage.push({ grantId: 'unrestored-product', revision: 0 });
        else receipt.result.resultRevisions.tenant = null;
        receipt.resultRevisions = copy(receipt.result.resultRevisions);
        receipt.resultSha256 = row.result_sha256 = require('node:crypto').createHash('sha256').update(stableJson(receipt.result)).digest('hex');
        await expect(h.bootstrap()).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
    });

    test('later authority, advisor and product records preserve the original reservation and bootstrap replies', async () => {
        const h = setup(); const initial = await h.bootstrap(), command = h.reserve();
        const first = await h.repo.reserveUsage(command);
        const flags = { ...h.initial.flags, revision: 2 };
        let changed = await h.repo.executeAuthorityCommand(h.command('flags.update', 'later-flags', first.resultRevisions, flags));
        const advisor = Object.values(fixture({ role: 'fractional_advisor' }).advisorAssignments)[0];
        advisor.revision = 0;
        changed = await h.repo.executeAuthorityCommand(h.command('advisor.put', 'later-advisor', changed.resultRevisions, advisor));
        const grants = [...h.initial.entitlementState.grants, { ...h.initial.entitlementState.grants[0], grantId: 'later-product', status: 'revoked' }];
        changed = await h.repo.executeAuthorityCommand(h.command('entitlement.update', 'later-grant', changed.resultRevisions,
            { ...h.initial.entitlementState, revision: 2, grants }));
        await h.repo.reserveUsage(h.reserve('later-usage', changed.resultRevisions));
        expect(await h.repo.reserveUsage(command)).toEqual(first);
        expect(await h.bootstrap()).toEqual(initial);
        expect(h.memory.rows('dashboard_usage')).toHaveLength(2);
        expect(h.memory.rows('dashboard_usage').find(row => row.grant_id === 'synthetic-product').payload.counters.assessment_runs).toBe(2);
    });

    test('rehashed entitlement receipt cannot omit the new product usage transition', async () => {
        const h = setup(); await h.bootstrap();
        const grants = [...h.initial.entitlementState.grants, { ...h.initial.entitlementState.grants[0], grantId: 'later-product', status: 'revoked' }];
        const command = h.command('entitlement.update', 'add-product', INITIAL, { ...h.initial.entitlementState, revision: 2, grants });
        await h.repo.executeAuthorityCommand(command);
        const row = h.memory.rows('dashboard_operation_receipts').at(-1);
        row.payload.result.resultRevisions.usage = copy(INITIAL.usage);
        row.payload.resultRevisions = copy(row.payload.result.resultRevisions);
        row.payload.resultSha256 = row.result_sha256 = require('node:crypto').createHash('sha256').update(stableJson(row.payload.result)).digest('hex');
        await expect(h.repo.executeAuthorityCommand(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
    });

    test('stale complete revision vectors cannot reserve or refresh themselves', async () => {
        const h = setup(); await h.bootstrap(); await h.repo.reserveUsage(h.reserve());
        await expect(h.repo.reserveUsage(h.reserve('another'))).rejects.toMatchObject({ code: 'dashboard_revision_conflict' });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(1);
    });

    test.each(['result', 'event', 'expectedRevisions'])('corrupt stored %s evidence is rejected during replay', async field => {
        const h = setup(); await h.bootstrap(); const command = h.reserve();
        await h.repo.reserveUsage(command);
        const receipt = h.memory.rows('dashboard_operation_receipts')[1].payload;
        if (field === 'result') receipt.result.usage.counters.assessment_runs = 9;
        if (field === 'event') receipt.event.actorSubjectKey = SUBJECT.replace(/1$/, '2');
        if (field === 'expectedRevisions') receipt.expectedRevisions.flags = 100;
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(1);
    });

    test.each(['usageRevision', 'vectorRevision', 'missingCounter'])('a recomputed hash cannot conceal contradictory receipt %s', async field => {
        const h = setup(); await h.bootstrap(); const command = h.reserve(); await h.repo.reserveUsage(command);
        const row = h.memory.rows('dashboard_operation_receipts')[1], receipt = row.payload;
        if (field === 'usageRevision') receipt.result.usage.revision = 0;
        if (field === 'vectorRevision') {
            receipt.result.resultRevisions.flags = 99; receipt.resultRevisions.flags = 99;
        }
        if (field === 'missingCounter') delete receipt.result.usage.counters.assessment_runs;
        receipt.resultSha256 = row.result_sha256 = require('node:crypto').createHash('sha256').update(stableJson(receipt.result)).digest('hex');
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code: 'dashboard_receipt_invalid' });
    });

    test.each(['tenant.transition', 'organisation.transition', 'flags.update', 'entitlement.update', 'membership.command'])('current %s revocation prevents original receipt replay', async type => {
        const h = setup(); await h.bootstrap(); const command = h.reserve();
        const result = await h.repo.reserveUsage(command);
        const payloads = {
            'tenant.transition': { toStatus: 'suspended' }, 'organisation.transition': { toStatus: 'suspended' },
            'flags.update': { ...h.initial.flags, revision: 2, enabled: { ...h.initial.flags.enabled, cyber_security: false } },
            'entitlement.update': { ...h.initial.entitlementState, revision: 2, grants: h.initial.entitlementState.grants.map(grant => ({ ...grant, status: 'revoked' })) },
            'membership.command': { action: 'suspend', payload: { membershipId: 'synthetic-membership' } }
        };
        await h.repo.executeAuthorityCommand(h.command(type, 'revoke', result.resultRevisions, payloads[type]));
        const code = ['tenant.transition', 'organisation.transition'].includes(type) ? 'membership_organisation_inactive' :
            type === 'membership.command' ? 'membership_not_found' : 'dashboard_quota_denied';
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(1);
    });

    test('rollback keeps usage and receipt unchanged when receipt insertion fails', async () => {
        const h = setup(); await h.bootstrap(); h.memory.failInsert = 'dashboard_operation_receipts';
        await expect(h.repo.reserveUsage(h.reserve())).rejects.toThrow('synthetic_precommit_failure');
        expect(h.memory.rows('dashboard_usage')[0].payload.revision).toBe(0);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
    });

    test('lost COMMIT response reconciles original operation instead of consuming again', async () => {
        const h = setup(); await h.bootstrap(); h.memory.loseCommit = true;
        const result = await h.repo.reserveUsage(h.reserve());
        expect(result.usage.counters.assessment_runs).toBe(1);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(2);
        expect(h.memory.queries.filter(item => item.sql.startsWith('UPDATE nofries.dashboard_usage'))).toHaveLength(1);
    });

    test('ambiguous rollback failure after commit also reconciles without consuming twice', async () => {
        const h = setup(); await h.bootstrap(); let lost = false;
        const repo = createPostgresDashboardRepository({ clock: () => NOW, authoriseAdministration: () => true,
            database: { withTenantTransaction: async (scope, work) => {
                const result = await h.memory.database.withTenantTransaction(scope, work);
                if (!lost) { lost = true; throw Object.assign(new Error('synthetic'), { code: 'postgres_rollback_failed' }); }
                return result;
            } } });
        expect((await repo.reserveUsage(h.reserve())).usage.counters.assessment_runs).toBe(1);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(2);
    });

    test('ambiguous COMMIT without durable receipt never reruns mutation', async () => {
        const h = setup(); let calls = 0;
        const repository = createPostgresDashboardRepository({ clock: () => NOW, authoriseAdministration: () => true,
            database: { withTenantTransaction: async (tenant, work) => {
                calls += 1;
                if (calls === 1) throw Object.assign(new Error('synthetic'), { code: 'postgres_commit_failed' });
                return h.memory.database.withTenantTransaction(tenant, work);
            } } });
        await h.bootstrap();
        await expect(repository.reserveUsage(h.reserve())).rejects.toMatchObject({ code: 'dashboard_commit_ambiguous' });
        expect(h.memory.rows('dashboard_usage')[0].payload.revision).toBe(0);
    });

    test('bootstrap reconciliation cannot create an absent organisation under an existing tenant', async () => {
        const h = setup(); await h.bootstrap();
        const next = fixture({ organisationId: 'second-organisation' });
        const initial = { tenantAggregate: next.tenantAggregate, membershipState: next.membershipState,
            entitlementState: next.entitlementState, flags: next.flags, advisorAssignments: [] };
        const command = { ...h.command('organisation.initialise', 'second-bootstrap', { ...EMPTY, tenant: 0 }, {}), organisationId: 'second-organisation' };
        let calls = 0;
        const repository = createPostgresDashboardRepository({ clock: () => NOW, authoriseAdministration: () => true,
            database: { withTenantTransaction: (tenant, work) => {
                calls += 1;
                if (calls === 1) return Promise.reject(Object.assign(new Error('synthetic'), { code: 'postgres_commit_failed' }));
                return h.memory.database.withTenantTransaction(tenant, work);
            } } });
        await expect(repository.initialiseOrganisation(command, initial)).rejects.toMatchObject({ code: 'dashboard_commit_ambiguous' });
        expect(h.memory.rows('dashboard_organisations')).toHaveLength(1);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
        await h.repo.initialiseOrganisation(command, initial);
        expect(h.memory.rows('dashboard_organisations')).toHaveLength(2);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(2);
    });

    test('grant IDs cannot be removed, repurposed or resurrected and usage never resets', async () => {
        const h = setup(); await h.bootstrap();
        const changed = copy(h.initial.entitlementState); changed.revision = 2; changed.grants[0].limits.assessment_runs = 100;
        await expect(h.repo.executeAuthorityCommand(h.command('entitlement.update', 'repurpose', INITIAL, changed))).rejects.toMatchObject({ code: 'dashboard_grant_history_invalid' });
        changed.grants = [];
        await expect(h.repo.executeAuthorityCommand(h.command('entitlement.update', 'remove', INITIAL, changed))).rejects.toMatchObject({ code: 'dashboard_grant_history_invalid' });
        expect(h.memory.rows('dashboard_usage')[0].payload.revision).toBe(0);
    });

    test('advisor projection selects current relevant permission and rejects ambiguity', async () => {
        const h = setup({ role: 'fractional_advisor' }); await h.bootstrap();
        const snapshot = await h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT });
        expect(Object.keys(snapshot.advisorAssignments)).toEqual(['cyber_security']);
        expect(snapshot.advisorAssignments.cyber_security.assignmentId).toBe('synthetic-assignment');
        const other = { ...h.initial.advisorAssignments[0], assignmentId: 'second-assignment', revision: 0, updatedAt: NOW };
        const vector = { ...INITIAL, advisorAssignments: [{ assignmentId: 'synthetic-assignment', revision: 1 }] };
        await h.repo.executeAuthorityCommand(h.command('advisor.put', 'assign', vector, other));
        await expect(h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT })).rejects.toMatchObject({ code: 'dashboard_assignment_ambiguous' });
    });

    test('advisor revocation receives server time and cannot resurrect the old active assignment', async () => {
        const h = setup({ role: 'fractional_advisor' }); await h.bootstrap();
        const vector = { ...INITIAL, advisorAssignments: [{ assignmentId: 'synthetic-assignment', revision: 1 }] };
        const assignment = { ...h.initial.advisorAssignments[0], status: 'revoked', revision: 2 };
        const result = await h.repo.executeAuthorityCommand(h.command('advisor.put', 'revoke-advisor', vector, assignment));
        expect(h.memory.rows('dashboard_advisor_assignments')[0].payload.updatedAt).toBe(NOW);
        expect(assignment.updatedAt).not.toBe(NOW);
        expect((await h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT })).advisorAssignments).toEqual({});
        await expect(h.repo.executeAuthorityCommand(h.command('advisor.put', 'resurrect', result.resultRevisions,
            { ...assignment, revision: 3, status: 'active' }))).rejects.toMatchObject({ code: 'dashboard_assignment_history_invalid' });
    });

    test('ordinary viewer visibility cannot reserve assessment execution capacity', async () => {
        const h = setup({ role: 'viewer' }); await h.bootstrap();
        await expect(h.repo.reserveUsage(h.reserve())).rejects.toMatchObject({ code: 'portal_permission_denied' });
        expect(h.memory.rows('dashboard_usage')[0].payload.revision).toBe(0);
    });

    test.each(['missing', 'disabled', 'expired', 'revoked'])('advisor-only reservation requires purchased current advisory service (%s)', async mode => {
        const h = setup({ role: 'fractional_advisor', ...(mode === 'missing' ? {} : { service: 'fractional_advisory' }) });
        h.initial.advisorAssignments[0].permissions.push('assessment.write');
        if (mode === 'disabled') h.initial.flags.enabled['service:fractional_advisory'] = false;
        if (mode === 'expired') h.initial.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').validUntil = NOW;
        if (mode === 'revoked') h.initial.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').status = 'revoked';
        const initial = await h.bootstrap();
        await expect(h.repo.reserveUsage(h.reserve('advisor-reservation', initial.resultRevisions)))
            .rejects.toMatchObject({ code: 'dashboard_quota_denied' });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(0);
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
    });

    test.each(['disabled', 'expired', 'revoked'])('advisor service %s prevents an otherwise exact successful reservation replay', async mode => {
        const h = setup({ role: 'fractional_advisor', service: 'fractional_advisory' });
        h.initial.advisorAssignments[0].permissions.push('assessment.write');
        const expiry = new Date(Date.parse(NOW) + 1000).toISOString();
        h.initial.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').validUntil = expiry;
        const initial = await h.bootstrap(), command = h.reserve('advisor-reservation', initial.resultRevisions);
        const original = await h.repo.reserveUsage(command);
        expect(await h.repo.reserveUsage(command)).toEqual(original);
        if (mode === 'expired') h.state.now = expiry;
        else if (mode === 'disabled') await h.repo.executeAuthorityCommand(h.command('flags.update', 'disable-advisory', original.resultRevisions,
            { ...h.initial.flags, revision: 2, enabled: { ...h.initial.flags.enabled, 'service:fractional_advisory': false } }));
        else await h.repo.executeAuthorityCommand(h.command('entitlement.update', 'revoke-advisory', original.resultRevisions,
            { ...h.initial.entitlementState, revision: 2, grants: h.initial.entitlementState.grants.map(grant =>
                grant.code === 'fractional_advisory' ? { ...grant, status: 'revoked' } : grant) }));
        await expect(h.repo.reserveUsage(command)).rejects.toMatchObject({ code: 'dashboard_quota_denied' });
        expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(1);
    });

    test.each(['admin', 'editor'])('independent %s permission still reserves without an advisory purchase', async role => {
        const h = setup({ role });
        h.initial.membershipState.memberships[0].roles.push('fractional_advisor');
        h.initial.membershipState.invitations[0].roles.push('fractional_advisor');
        await h.bootstrap();
        expect((await h.repo.reserveUsage(h.reserve())).reserved).toBe(true);
    });

    test('missing counter fails closed without synthesizing zero', async () => {
        const h = setup(); await h.bootstrap();
        delete h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs;
        await expect(h.repo.reserveUsage(h.reserve())).rejects.toMatchObject({ code: 'dashboard_quota_denied' });
    });

    test('malformed persisted canonical records fail instead of defaulting', async () => {
        const h = setup(); await h.bootstrap();
        delete h.memory.rows('dashboard_tenants')[0].payload.recordStatus;
        await expect(h.repo.readAdmissionSnapshot(h.scope, { authenticated: true, subjectKey: SUBJECT })).rejects.toThrow();
    });

    test('captures immutable commands before transaction awaits and rejects accessors without invoking them', async () => {
        const h = setup(); await h.bootstrap(); const command = h.reserve();
        const promise = h.repo.reserveUsage(command);
        command.payload.amount = 100; command.tenantId = 'foreign';
        expect((await promise).usage.counters.assessment_runs).toBe(1);
        const getter = jest.fn(() => 'foreign');
        const malicious = h.reserve('getter'); Object.defineProperty(malicious.payload, 'grantId', { get: getter, enumerable: true });
        expect(() => h.repo.reserveUsage(malicious)).toThrow(); expect(getter).not.toHaveBeenCalled();
    });

    test('time is sampled after snapshot I/O and denies expired membership', async () => {
        const h = setup(); await h.bootstrap();
        h.state.now = '2026-09-07T09:00:00.000Z';
        await expect(h.repo.reserveUsage(h.reserve())).rejects.toMatchObject({ code: 'membership_not_found' });
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
    });

    test('expiry during receipt I/O denies both a first reservation and an exact replay', async () => {
        for (const replay of [false, true]) {
            const h = setup(); await h.bootstrap();
            if (replay) await h.repo.reserveUsage(h.reserve());
            h.memory.afterQuery = sql => { if (sql.startsWith('SELECT * FROM nofries.dashboard_operation_receipts')) h.state.now = '2026-09-07T09:00:00.000Z'; };
            await expect(h.repo.reserveUsage(h.reserve())).rejects.toMatchObject({ code: 'membership_not_found' });
            expect(h.memory.rows('dashboard_usage')[0].payload.counters.assessment_runs).toBe(replay ? 1 : 0);
        }
    });
});

// This private seam is a transaction participant, not another database owner.
// The independent oracle below uses canonical domain primitives and the original
// DATA receipt schema; it does not call the extracted codec/result constructor.
const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
function bootstrapOracle(command, input) {
    const initialState = { tenantAggregate: copy(input.tenantAggregate),
        membershipState: normaliseMembershipState(input.membershipState),
        entitlementState: normaliseEntitlementState(input.entitlementState, input.tenantAggregate),
        flags: copy(input.flags), advisorAssignments: input.advisorAssignments.map(normaliseAdvisorAssignment) };
    const products = initialState.entitlementState.grants.filter(grant => Object.prototype.hasOwnProperty.call(TIERS, grant.code));
    const result = { operationId: command.operationId, type: 'organisation.initialise', reserved: false,
        resultRevisions: { tenant: initialState.tenantAggregate.tenant.revision,
            organisation: initialState.tenantAggregate.organisations[0].revision,
            membership: initialState.membershipState.revision, entitlement: initialState.entitlementState.revision,
            flags: initialState.flags.revision,
            advisorAssignments: initialState.advisorAssignments.map(row => ({ assignmentId: row.assignmentId, revision: row.revision }))
                .sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0),
            usage: products.map(row => ({ grantId: row.grantId, revision: 0 }))
                .sort((a, b) => a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0) }, usage: null };
    const reference = { schemaVersion: 1, operationType: 'organisation.initialise', tenantId: command.tenantId,
        organisationId: command.organisationId, operationId: command.operationId,
        intentSha256: digest({ command, initialState }), resultSha256: digest(result) };
    return { initialState, result, reference, usage: products.map(row => ({ schemaVersion: 1,
        tenantId: row.tenantId, organisationId: row.organisationId, grantId: row.grantId, revision: 0,
        counters: Object.fromEntries(Object.keys(row.limits).map(key => [key, 0])) })) };
}
function privateBootstrap(options = {}) {
    const h = setup(options), clock = jest.fn(() => NOW), guard = jest.fn(() => true);
    const bootstrap = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
    const operations = bootstrap.createBootstrapOperations({ clock, authoriseAdministration: guard });
    const command = h.command('organisation.initialise', 'create-org', EMPTY, {});
    const run = (method, prepared, after = null) => h.memory.database.withTenantTransaction(prepared.tenantId, async tx => {
        const result = await operations[method](tx, prepared);
        if (after) await after(tx, result);
        return result;
    });
    return { ...h, bootstrap, operations, command, clock, guard, run };
}

describe('private dashboard bootstrap extraction compatibility', () => {
    test('keeps the fixed private facets and the original public error constructor', () => {
        const h = privateBootstrap();
        expect(Object.keys(h.bootstrap).sort()).toEqual(['DashboardPersistenceError', 'createBootstrapOperations', 'dataCodec', 'dataStorage'].sort());
        expect(h.bootstrap.DashboardPersistenceError).toBe(require('../api/shared/appLifecycle/postgresDashboardRepository').DashboardPersistenceError);
        expect(Object.isFrozen(h.bootstrap.dataStorage)).toBe(true);
        expect(Object.isFrozen(h.bootstrap.dataCodec)).toBe(true);
        expect(Object.keys(h.bootstrap.dataStorage).sort()).toEqual(['loadSnapshotForShare', 'loadSnapshotForUpdate',
            'updateTenant', 'updateOrganisation', 'updateMembershipState', 'updateEntitlementState', 'updateFlags',
            'insertAdvisorAssignment', 'updateAdvisorAssignment', 'insertUsage', 'updateUsage',
            'readOperationReceipt', 'saveOperationReceipt'].sort());
        expect(Object.keys(h.operations).sort()).toEqual(['prepareInitialisation', 'executeInTransaction', 'reconcileInTransaction'].sort());
        expect(Object.isFrozen(h.operations)).toBe(true);
        for (const value of [{}, { clock: () => NOW }, { clock: true, authoriseAdministration: () => true }]) {
            expect(() => h.bootstrap.createBootstrapOperations(value)).toThrow(h.bootstrap.DashboardPersistenceError);
        }
    });

    test('prepares a detached branded handle and exact five-part intent without clock, guard or database work', async () => {
        const h = privateBootstrap({ role: 'fractional_advisor', service: 'fractional_advisory' });
        const expected = bootstrapOracle(h.command, h.initial);
        const prepared = h.operations.prepareInitialisation(h.command, h.initial);
        expect(Object.keys(prepared).sort()).toEqual(['expectedReference', 'tenantId']);
        expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.expectedReference)).toBe(true);
        expect(prepared.expectedReference).toEqual(expected.reference);
        expect(h.clock).not.toHaveBeenCalled(); expect(h.guard).not.toHaveBeenCalled(); expect(h.memory.queries).toEqual([]);
        h.command.operationId = 'changed-after-preparation'; h.command.tenantId = 'foreign-after-preparation';
        h.initial.flags.enabled.cyber_security = false;
        h.initial.entitlementState.grants[0].agreementRef = 'changed-after-preparation';
        const actual = await h.run('executeInTransaction', prepared);
        expect(actual).toEqual({ result: expected.result, reference: expected.reference });
        expect(Object.isFrozen(actual)).toBe(true); expect(Object.isFrozen(actual.reference)).toBe(true);
        const receipt = h.memory.rows('dashboard_operation_receipts')[0];
        expect(receipt.intent_sha256).toBe(expected.reference.intentSha256);
        expect(receipt.result_sha256).toBe(expected.reference.resultSha256);
        expect(receipt.payload.result).toEqual(expected.result);
        expect(receipt.payload.occurredAt).toBe(NOW);
        expect(h.memory.rows('dashboard_usage').map(row => row.payload)).toEqual(expected.usage);
        expect(h.memory.rows('dashboard_feature_flags')[0].payload).toEqual(expected.initialState.flags);
        expect(h.clock).toHaveBeenCalledTimes(1);
    });

    test('rejects cloned, forged and foreign-factory handles before any SQL', async () => {
        const h = privateBootstrap(), prepared = h.operations.prepareInitialisation(h.command, h.initial);
        const foreign = h.bootstrap.createBootstrapOperations({ clock: h.clock, authoriseAdministration: h.guard })
            .prepareInitialisation(h.command, h.initial);
        const query = jest.fn();
        for (const invalid of [copy(prepared), Object.freeze({ ...prepared }), foreign]) {
            for (const method of ['executeInTransaction', 'reconcileInTransaction']) {
                await expect(h.operations[method]({ query }, invalid)).rejects.toBeInstanceOf(h.bootstrap.DashboardPersistenceError);
            }
        }
        expect(query).not.toHaveBeenCalled(); expect(h.guard).not.toHaveBeenCalled(); expect(h.clock).not.toHaveBeenCalled();
    });

    test('malformed preparation remains synchronous and cannot invoke input accessors', () => {
        const h = privateBootstrap(), getter = jest.fn(() => h.initial.flags);
        const invalid = { ...h.initial }; Object.defineProperty(invalid, 'flags', { enumerable: true, get: getter });
        expect(() => h.operations.prepareInitialisation(h.command, invalid)).toThrow(h.bootstrap.DashboardPersistenceError);
        expect(getter).not.toHaveBeenCalled(); expect(h.clock).not.toHaveBeenCalled(); expect(h.guard).not.toHaveBeenCalled();
        expect(h.memory.queries).toEqual([]);
    });

    test.each(['flags', 'grant terms', 'member evidence'])('the entire original initial state binds replay even when changed %s preserves every revision', async kind => {
        const h = privateBootstrap(), original = h.operations.prepareInitialisation(h.command, h.initial);
        await h.run('executeInTransaction', original);
        const changed = copy(h.initial);
        if (kind === 'flags') changed.flags.enabled.cyber_security = false;
        if (kind === 'grant terms') changed.entitlementState.grants[0].limits.assessment_runs++;
        if (kind === 'member evidence') {
            changed.membershipState.memberships[0].grantEvidenceId = 'substituted-role-evidence';
            changed.membershipState.invitations[0].grantEvidenceId = 'substituted-role-evidence';
        }
        const prepared = h.operations.prepareInitialisation(h.command, changed);
        expect(prepared.expectedReference.resultSha256).toBe(original.expectedReference.resultSha256);
        expect(prepared.expectedReference.intentSha256).not.toBe(original.expectedReference.intentSha256);
        await expect(h.run('executeInTransaction', prepared)).rejects.toMatchObject({ code: 'dashboard_operation_conflict', statusCode: 409 });
        expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
    });

    test('first write samples time after state writes while replay and reconciliation only recheck current administration', async () => {
        const h = privateBootstrap(), prepared = h.operations.prepareInitialisation(h.command, h.initial);
        h.clock.mockImplementation(() => {
            expect(h.memory.queries.some(row => row.sql.startsWith('INSERT INTO nofries.dashboard_usage'))).toBe(true);
            expect(h.memory.queries.some(row => row.sql.startsWith('INSERT INTO nofries.dashboard_operation_receipts'))).toBe(false);
            return NOW;
        });
        const original = await h.run('executeInTransaction', prepared);
        expect(h.clock).toHaveBeenCalledTimes(1);
        h.clock.mockClear().mockImplementation(() => { throw new Error('Replay must not sample a fresh timestamp'); });
        const queryStart = h.memory.queries.length;
        expect(await h.run('executeInTransaction', prepared)).toEqual(original);
        expect(await h.run('reconcileInTransaction', prepared)).toEqual(original);
        expect(h.memory.queries.slice(queryStart).every(row => row.sql.startsWith('SELECT'))).toBe(true);
        expect(h.clock).not.toHaveBeenCalled(); expect(h.guard).toHaveBeenCalledTimes(3);
        h.guard.mockReturnValue(false);
        await expect(h.run('reconcileInTransaction', prepared)).rejects.toMatchObject({ code: 'dashboard_administration_denied', statusCode: 403 });
    });

    test.each(['false', 'throw', 'resolved promise', 'rejected promise', 'thenable'])('bootstrap refuses %s approval and rolls back provisional tenant creation', async mode => {
        const h = privateBootstrap(), then = jest.fn();
        h.guard.mockImplementation(() => {
            if (mode === 'throw') throw new Error('private administrative detail');
            if (mode === 'resolved promise') return Promise.resolve(true);
            if (mode === 'rejected promise') return Promise.reject(new Error('private rejected approval'));
            if (mode === 'thenable') return { then };
            return false;
        });
        const prepared = h.operations.prepareInitialisation(h.command, h.initial);
        await expect(h.run('executeInTransaction', prepared)).rejects.toMatchObject({ code: 'dashboard_administration_denied', statusCode: 403 });
        expect(then).not.toHaveBeenCalled(); expect(h.clock).not.toHaveBeenCalled();
        expect(h.memory.rows('dashboard_tenants')).toEqual([]); expect(h.memory.rows('dashboard_operation_receipts')).toEqual([]);
    });

    test('invalid final clock and outer failure preserve the caller transaction rollback contract', async () => {
        const h = privateBootstrap(), prepared = h.operations.prepareInitialisation(h.command, h.initial);
        h.clock.mockReturnValue('invalid-clock');
        await expect(h.run('executeInTransaction', prepared)).rejects.toMatchObject({ code: 'dashboard_clock_invalid' });
        expect(h.memory.rows('dashboard_tenants')).toEqual([]);
        h.clock.mockReturnValue(NOW);
        const failure = new Error('synthetic outer operation failure');
        await expect(h.run('executeInTransaction', prepared, () => { throw failure; })).rejects.toBe(failure);
        for (const table of ['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states',
            'dashboard_entitlement_states', 'dashboard_feature_flags', 'dashboard_advisor_assignments',
            'dashboard_usage', 'dashboard_operation_receipts']) expect(h.memory.rows(table)).toEqual([]);
        const query = jest.fn(async () => { throw failure; });
        await expect(h.operations.executeInTransaction({ query }, prepared)).rejects.toBe(failure);
        await expect(h.operations.reconcileInTransaction({ query }, prepared)).rejects.toBe(failure);
        expect(query).toHaveBeenCalledTimes(2); // Each direct call tries once; only its outer owner may recover.
    });

    test.each(['postgres_commit_failed', 'postgres_rollback_failed'])('public bootstrap reconciles a committed %s once and returns the original result', async code => {
        const h = setup(), transactions = [], clock = jest.fn(() => NOW);
        const database = { withTenantTransaction: async (tenant, work) => {
            const queries = []; transactions.push(queries);
            const result = await h.memory.database.withTenantTransaction(tenant, tx => work({ query: async (sql, args) => {
                queries.push(sql); return tx.query(sql, args);
            } }));
            if (transactions.length === 1) throw Object.assign(new Error('synthetic lost outcome'), { code });
            return result;
        } };
        const repo = createPostgresDashboardRepository({ database, clock, authoriseAdministration: () => true });
        const command = h.command('organisation.initialise', 'create-org', EMPTY, {});
        const result = await repo.initialiseOrganisation(command, h.initial);
        expect(result).toEqual(bootstrapOracle(command, h.initial).result);
        expect(transactions).toHaveLength(2); expect(transactions[1].every(sql => sql.startsWith('SELECT'))).toBe(true);
        expect(clock).toHaveBeenCalledTimes(1); expect(h.memory.rows('dashboard_operation_receipts')).toHaveLength(1);
        expect(h.memory.rows('dashboard_usage')[0].payload.revision).toBe(0);
    });

    test.each(['absent tenant', 'missing receipt', 'unavailable recovery'])('bootstrap ambiguity with %s performs no recovery writes or third attempt', async mode => {
        const h = setup();
        if (mode === 'missing receipt') { await h.bootstrap(); h.memory.rows('dashboard_operation_receipts').splice(0); }
        const before = h.memory.queries.length, clock = jest.fn(() => NOW); let attempts = 0;
        const database = { withTenantTransaction: (tenant, work) => {
            if (++attempts === 1) return Promise.reject(Object.assign(new Error('synthetic uncertain commit'), { code: 'postgres_commit_failed' }));
            if (mode === 'unavailable recovery') return Promise.reject(Object.assign(new Error('synthetic connection failure'), { code: 'postgres_connection_failed' }));
            return h.memory.database.withTenantTransaction(tenant, work);
        } };
        const repo = createPostgresDashboardRepository({ database, clock, authoriseAdministration: () => true });
        await expect(repo.initialiseOrganisation(h.command('organisation.initialise', 'create-org', EMPTY, {}), h.initial))
            .rejects.toMatchObject({ code: 'dashboard_commit_ambiguous', statusCode: 503 });
        expect(attempts).toBe(2); expect(clock).not.toHaveBeenCalled();
        expect(h.memory.queries.slice(before).every(row => row.sql.startsWith('SELECT'))).toBe(true);
        expect(h.memory.rows('dashboard_operation_receipts')).toEqual([]);
        expect(h.memory.rows('dashboard_tenants')).toHaveLength(mode === 'missing receipt' ? 1 : 0);
    });
});
