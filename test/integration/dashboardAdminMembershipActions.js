'use strict';

const { randomUUID } = require('node:crypto');
const { createAccountActionsRepository } = require('../../api/shared/dashboardAdmin/accountActionsRepository');
const { accountActionsPool } = require('../../api/shared/dashboardAdmin/accountActionsPool');
const { fixture, actor, NOW, SUBJECT } = require('../fixtures/dashboardAdminMembershipActions');
const { createMembershipRead } = require('../../api/shared/dashboardAdmin/accountActionsMembershipRead');
module.exports = function registerAccountActionPostgresTests() {
    const testUrl = process.env.NOFRIES_TEST_DATABASE_URL;
    (testUrl ? test : test.skip)('native PostgreSQL preserves receipts and organisation data through suspend/restore', async () => {
        const url = new URL(testUrl);
        if (url.hostname !== '127.0.0.1' || url.pathname !== '/nofries_ci') throw new Error('isolated_database_required');
        const { Pool } = require('pg'), owner = new Pool({ connectionString: testUrl, max: 1, connectionTimeoutMillis: 1000 });
        const pool = accountActionsPool(owner);
        const h = fixture(), tenantId = 'synthetic-actions-' + randomUUID();
        h.config.readContext.mockImplementation(() => pool.run(async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN READ ONLY');
                await client.query("SELECT set_config('nofries.tenant_id', 'synthetic-validation-scope', true)");
                const nested = await pool.connect();
                try { await nested.query('BEGIN READ ONLY'); await nested.query('SELECT 1'); await nested.query('COMMIT'); }
                finally { nested.release(); }
                await client.query('COMMIT'); return h.context;
            } finally { client.release(); }
        }));
        h.state.snapshot = JSON.parse(JSON.stringify(h.snapshot).replaceAll('synthetic-tenant', tenantId));
        h.selector.tenantId = h.record.tenantId = tenantId;
        h.config.createRepository = (guard, allowed) => createAccountActionsRepository(pool, () => NOW, guard, allowed, h.context);
        const repo = h.config.createRepository(async () => {}, () => true);
        try {
            const { usage, ...initial } = h.state.snapshot;
            await repo.initialiseOrganisation({ tenantId, organisationId: h.selector.organisationId, operationId: randomUUID(), actorSubjectKey: SUBJECT,
                type: 'organisation.initialise', expectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null, flags: null, advisorAssignments: [], usage: [] }, payload: {} }, initial);
            const scope = { tenantId, organisationId: h.selector.organisationId }, principal = { authenticated: true, subjectKey: SUBJECT };
            const before = await repo.readAuthoritySnapshot(scope, principal);
            const read = createMembershipRead(h.config);
            expect(await read(actor, { selector: h.selector }, { request: {}, signal: new AbortController().signal }))
                .toMatchObject({ membershipStatus: 'active', expectedMembershipRevision: before.revisions.membership });
            expect((await repo.readAuthoritySnapshot(scope, principal)).snapshot).toEqual(before.snapshot);
            expect((await owner.query('SELECT count(*) FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1', [tenantId])).rows[0].count).toBe('1');
            await h.run('suspend'); h.state.snapshot.membershipState.revision++;
            await h.run('restore');
            const seen = await repo.readAuthoritySnapshot(scope, principal);
            expect(seen.snapshot.membershipState.memberships[0].status).toBe('active');
            expect(seen.snapshot.entitlementState).toEqual(before.snapshot.entitlementState);
            expect(seen.snapshot.membershipState.invitations).toEqual(before.snapshot.membershipState.invitations);
            h.state.snapshot.membershipState.revision = seen.revisions.membership;
            let calls = 0;
            h.config.readApprovedAction.mockImplementation(async ({ operationId }) => {
                const record = JSON.parse(JSON.stringify(h.state.approvals.get(operationId)));
                record.grant.status = ++calls === 6 ? 'revoked' : 'active'; return record;
            });
            await expect(h.run('suspend')).rejects.toBeDefined();
            expect((await repo.readAuthoritySnapshot(scope, principal)).snapshot).toEqual(seen.snapshot);
        } finally { await owner.end(); }
    }, 30000);

};
