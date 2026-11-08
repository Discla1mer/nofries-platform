'use strict';

// Standalone synthetic regression harness.
// Run: node scripts/tests/admin-account-recovery-proof.cjs
// Exercises the real adapter, membership domain, immutable state hydration and
// native receipt writer/validator. Only snapshot persistence and SQL row selection
// are simulated. This does NOT qualify PostgreSQL syntax, locking, RLS, sessions,
// role/approval revocation, Azure storage or production release readiness.
// The default root resolves to the checkout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const fromRepo = createRequire(path.join(root, 'package.json'));
const { fixture, NOW, SUBJECT } = fromRepo('./test/fixtures/dashboardFixture');
const { applyMembershipCommand } = fromRepo('./api/shared/appLifecycle/membershipDomain');
const { hash } = fromRepo('./api/shared/appLifecycle/dashboardRuntimeRecords');
const { commandDigest } = fromRepo('./api/shared/dashboardAdmin/accountActionRecords');
const clone = value => JSON.parse(JSON.stringify(value));
const bootstrapPath = fromRepo.resolve('./api/shared/appLifecycle/postgresDashboardBootstrap');
const bootstrap = fromRepo(bootstrapPath);
let active;

// Patch only the three snapshot persistence ports before loading their consumers.
// Native receipt read/write and codecs remain the actual production functions.
require.cache[bootstrapPath].exports = { ...bootstrap, dataStorage: { ...bootstrap.dataStorage,
    loadSnapshotForShare: async () => clone(active.snapshot),
    loadSnapshotForUpdate: async () => clone(active.snapshot),
    updateMembershipState: async (_tx, next) => {
        active.snapshot = { ...active.snapshot, membershipState: clone(next) };
    }
} };
const { createPostgresAccountActionDataAdapter } = fromRepo('./api/shared/dashboardAdmin/postgresAccountActionAdapter');

function harness() {
    const source = fixture(), other = SUBJECT.slice(0, -1) + '2', actor = SUBJECT.slice(0, -1) + '3';
    let members = source.membershipState;
    for (const [action, payload, by] of [
        ['invite', { invitationId: 'other-invitation', subjectKey: other, roles: ['viewer'], validFrom: NOW,
            validUntil: '2026-09-07T09:00:00.000Z', grantEvidenceId: 'other-evidence', expiresAt: '2026-09-07T09:00:00.000Z' }, SUBJECT],
        ['accept', { invitationId: 'other-invitation', membershipId: 'other-membership' }, other]
    ]) members = applyMembershipCommand(members, source.tenantAggregate, { ...source.scope,
        expectedRevision: members.revision, actorSubjectKey: by, now: NOW, action, payload });
    const h = { snapshot: { tenantAggregate: source.tenantAggregate, membershipState: members,
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: [],
        usage: source.entitlementState.grants.map(bootstrap.dataCodec.newUsage) },
    rows: [], state: new Map(), other, actor, scope: source.scope, duplicateChain: false };
    active = h;
    let sequence = 10;
    const newId = () => '90000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');
    const tx = { async query(sql, params) {
        if (sql.startsWith('INSERT')) {
            assert(sql.includes('nofries.dashboard_operation_receipts'));
            const payload = JSON.parse(params[5]);
            h.rows.push({ tenant_id: params[0], organisation_id: params[1], operation_id: params[2],
                schema_version: 1, intent_sha256: params[3], result_sha256: params[4], payload });
            return { rowCount: 1 };
        }
        if (sql.includes("payload->>'operationType'=$3")) {
            let rows = h.rows.filter(row => row.tenant_id === params[0] && row.organisation_id === params[1]
                && row.payload.operationType === params[2]);
            if (params.length === 6) {
                assert(sql.includes('DESC LIMIT 2'));
                rows = rows.filter(row => row.payload.result.selector.subjectKey === params[3]
                    && row.payload.result.selector.provider === params[4] && row.payload.result.action === params[5]);
                rows.sort((a, b) => params[5] === 'delete'
                    ? b.payload.resultRevisions.membership - a.payload.resultRevisions.membership
                    : b.payload.result.labelRevision - a.payload.result.labelRevision);
                return { rows: rows.slice(0, 2) };
            }
            if (params.length === 5) {
                assert(sql.includes("IN ('delete','restore')"));
                assert(sql.includes("::bigint > $4"));
                assert(sql.includes("::bigint <= $5"));
                assert(sql.includes('ASC LIMIT 129'));
                rows = rows.filter(row => ['delete', 'restore'].includes(row.payload.result.action)
                    && row.payload.resultRevisions.membership > params[3]
                    && row.payload.resultRevisions.membership <= params[4]);
                rows.sort((a, b) => a.payload.resultRevisions.membership - b.payload.resultRevisions.membership);
                if (h.duplicateChain && rows.length) rows.push(rows[0]);
                return { rows: rows.slice(0, 129) };
            }
            // No organisation-deletion receipts are generated in these cases.
            assert.equal(params.length, 4);
            assert.equal(params[2], 'dashboard.admin.organisation_deletion');
            assert.equal(rows.length, 0);
            return { rows: [] };
        }
        if (/operation_id\s*=\s*\$3/.test(sql)) return { rows: h.rows.filter(row =>
            row.tenant_id === params[0] && row.organisation_id === params[1] && row.operation_id === params[2]) };
        throw new Error('Unexpected synthetic SQL: ' + sql);
    } };
    h.adapter = createPostgresAccountActionDataAdapter({ tx, clock: () => NOW, restoreEpoch: newId(),
        authoritySha256: 'a'.repeat(64), actorSubjectKey: actor, newId, stateStore: {
            async writeState(value) { h.state.set(hash(value), clone(value)); return hash(value); },
            async readState(key) { return clone(h.state.get(key)); }
        } });
    const selector = subjectKey => ({ provider: 'legacy', subjectKey, ...source.scope });
    h.inspect = (subjectKey = SUBJECT) => h.adapter.inspect(selector(subjectKey));
    h.command = async (action, subjectKey = SUBJECT) => {
        const selected = selector(subjectKey), seen = await h.adapter.inspect(selected);
        const unsigned = { schemaVersion: 1, operationId: newId(), actorSubjectKey: actor, selector: selected,
            expectedVersion: seen.version, action, patch: null, preparedAt: NOW,
            expiresAt: '2026-09-06T09:05:00.000Z', witness: seen.witness };
        return { ...unsigned, commandSha256: commandDigest(unsigned) };
    };
    h.act = async (action, subjectKey = SUBJECT) => {
        const command = await h.command(action, subjectKey), receipt = await h.adapter.commit(command);
        return { command, receipt };
    };
    return h;
}

test('bounded account-action recovery proof (synthetic storage, real receipts)', async t => {
    await t.test('two members restore independently; stale and repeated commands retain their guarantees', async () => {
        const h = harness(), deleted = await h.act('delete'), stale = await h.command('restore');
        await h.act('delete', h.other);
        await assert.rejects(() => h.adapter.commit(stale), error => error.statusCode === 409);
        assert((await h.inspect()).actions.includes('restore'));
        const restored = await h.act('restore');
        assert.equal(h.snapshot.membershipState.memberships.find(member => member.subjectKey === h.other).status, 'suspended');
        assert((await h.inspect(h.other)).actions.includes('restore'));
        await h.act('restore', h.other);
        const snapshot = clone(h.snapshot), receipts = clone(h.rows);
        assert.deepEqual(await h.adapter.commit(deleted.command), deleted.receipt);
        assert.deepEqual(await h.adapter.commit(restored.command), restored.receipt);
        assert.deepEqual(h.snapshot, snapshot);
        assert.deepEqual(h.rows, receipts);
    });
    for (const prefix of ['admin-account-action:', 'admin-membership:']) {
        await t.test('missing intervening ' + prefix + ' receipt blocks recovery', async () => {
            const h = harness(); await h.act('delete'); const otherDelete = await h.act('delete', h.other);
            h.rows = h.rows.filter(row => row.operation_id !== prefix + otherDelete.command.operationId);
            assert(!(await h.inspect()).actions.includes('restore'));
        });
    }
    await t.test('corrupt native receipt fails closed through the actual receipt codec', async () => {
        const h = harness(); await h.act('delete'); const otherDelete = await h.act('delete', h.other);
        h.rows.find(row => row.operation_id === 'admin-membership:' + otherDelete.command.operationId).intent_sha256 = 'b'.repeat(64);
        await assert.rejects(() => h.inspect(), error => typeof error.statusCode === 'number');
    });
    await t.test('duplicate chain evidence blocks recovery', async () => {
        const h = harness(); await h.act('delete'); await h.act('delete', h.other); h.duplicateChain = true;
        assert(!(await h.inspect()).actions.includes('restore'));
    });
    await t.test('identical-byte same-member round trip cannot reuse an old delete', async () => {
        const h = harness(); await h.act('delete');
        const prior = clone(h.snapshot.membershipState.memberships.find(member => member.subjectKey === SUBJECT));
        for (const action of ['resume', 'suspend']) h.snapshot.membershipState = applyMembershipCommand(
            h.snapshot.membershipState, h.snapshot.tenantAggregate, { ...h.scope,
                expectedRevision: h.snapshot.membershipState.revision, actorSubjectKey: h.actor,
                now: NOW, action, payload: { membershipId: prior.membershipId } });
        assert.deepEqual(h.snapshot.membershipState.memberships.find(member => member.subjectKey === SUBJECT), prior);
        await h.act('delete', h.other);
        assert(!(await h.inspect()).actions.includes('restore'));
    });
    await t.test('128 intervening revisions qualify; 129 fail closed', async () => {
        const h = harness(); await h.act('delete');
        for (let index = 0; index < 128; index++) await h.act(index % 2 ? 'restore' : 'delete', h.other);
        assert((await h.inspect()).actions.includes('restore'));
        await h.act('delete', h.other);
        assert(!(await h.inspect()).actions.includes('restore'));
    });
});
