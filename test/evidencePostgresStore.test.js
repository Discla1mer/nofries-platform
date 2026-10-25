'use strict';
const { createPostgresEvidenceStore } = require('../api/shared/evidenceLifecycle/postgresEvidenceStore');
const { createEvidence } = require('../api/shared/evidenceLifecycle/evidenceDomain');
const clone = x => JSON.parse(JSON.stringify(x));
const NOW = '2026-09-10T00:00:00.000Z';
const ACTOR = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const SCOPE = { tenantId: 'tenant:A', organisationId: 'org:A', artefactId: 'evidence:A' };
function fixture() {
    const ref = recordId => ({ recordId, revision: 0, recordSha256: 'a'.repeat(64) });
    return { ...SCOPE, action: 'create', expectedRevision: null, actorSubjectKey: ACTOR, now: NOW,
        idempotencyKey: 'operation:0', payload: { versionId: 'version:0',
            declaredContent: { sha256: 'a'.repeat(64), contentType: 'application/pdf', sizeBytes: 100 },
            source: { kind: 'operator-declaration', sourceId: 'source:A', sourceRevision: 'source-revision:0',
                observedAt: NOW, sourceMetadataSha256: 'b'.repeat(64) },
            classification: { level: 'Internal', tags: [] },
            policySnapshot: { policyId: 'policy:A', policyVersion: 'policy-version:0', maximumDeclaredBytes: 100,
                allowedDeclaredContentTypes: ['application/pdf'] },
            governanceRefs: { purposeDecisionRef: ref('purpose:A'), metadataRetentionPolicyRef: ref('metadata:A'),
                bytesRetentionPolicyRef: ref('bytes:A'), legalHoldRefs: [] } } };
}
function next(command, revision = 0) { const c = clone(command); c.action = 'append-version';
    c.expectedRevision = revision; c.idempotencyKey = `operation:${revision + 1}`;
    c.payload.versionId = `version:${revision + 1}`; return c; }
function harness() {
    const tenant = { schemaVersion: 1, tenantId: SCOPE.tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 };
    const organisation = { schemaVersion: 1, tenantId: SCOPE.tenantId, organisationId: SCOPE.organisationId,
        displayName: 'Synthetic org', domains: [], recordStatus: 'active', revision: 0 };
    let committed = { versions: [], heads: [], receipts: [] };
    const h = { tenant, organisation, calls: [], failAt: null, ambiguous: null,
        role: { rolsuper: false, rolbypassrls: false, runtime_member: true, tenant_context: SCOPE.tenantId,
            safe_tables: 5, mutable_history: false },
        get state() { return committed; }, set state(x) { committed = x; } };
    h.database = { async withTenantTransaction(tenantId, work) {
        const state = clone(committed);
        const result = await work({ async query(sql, p) {
            const tag = /evidence:([a-z-]+)/.exec(sql)?.[1]; h.calls.push(tag);
            if (h.failAt === tag) throw Object.assign(new Error('synthetic'), { code: 'postgres_query_failed' });
            if (tag === 'role') return { rows: [clone(h.role)] };
            if (tag === 'tenant') return { rows: [{ tenant_id: tenant.tenantId, schema_version: 1, revision: String(tenant.revision), payload: clone(tenant) }] };
            if (tag === 'organisation') return { rows: [{ tenant_id: organisation.tenantId, organisation_id: organisation.organisationId,
                schema_version: 1, revision: String(organisation.revision), payload: clone(organisation) }] };
            if (tag === 'head') return { rows: clone(state.heads) };
            if (tag === 'versions') return { rows: clone(state.versions) };
            if (tag === 'receipts') return { rows: clone(state.receipts) };
            const owner = { tenant_id: p[0], organisation_id: p[1], artefact_id: p[2] };
            if (tag === 'insert-version') state.versions.push({ ...owner, revision: p[3], payload_sha256: p[4],
                parent_revision: p[5], parent_sha256: p[6], payload: JSON.parse(p[7]) });
            else if (tag === 'insert-head') state.heads.push({ ...owner, revision: p[3], payload_sha256: p[4] });
            else if (tag === 'update-head') state.heads = [{ ...owner, revision: p[3], payload_sha256: p[4] }];
            else if (tag === 'insert-receipt') state.receipts.push({ ...owner, operation_id: p[3], intent_sha256: p[4],
                result_revision: p[5], version_sha256: p[6], payload: JSON.parse(p[7]) });
            else throw new Error(`unexpected SQL tag ${tag}`);
            return { rows: [], rowCount: 1 };
        } });
        const ambiguity = h.ambiguous; h.ambiguous = null;
        if (ambiguity !== 'absent') committed = state;
        if (ambiguity) throw Object.assign(new Error('synthetic commit'), { code: 'postgres_commit_failed' });
        return result;
    } };
    h.store = createPostgresEvidenceStore({ database: h.database }); return h;
}

test('dormant store exposes only explicit read/execute/reconcile and requires a database', () => {
    expect(() => createPostgresEvidenceStore()).toThrow('evidence_store_configuration_invalid');
    expect(Object.keys(harness().store)).toEqual(['read', 'reconcile', 'execute']);
});
test('round trip preserves original domain state and detached frozen result', async () => {
    const h = harness(), c = fixture();
    const expected = createEvidence({ schemaVersion: 1, tenant: h.tenant, organisations: [h.organisation] }, c);
    expect(await h.store.read(SCOPE)).toBeNull();
    expect(await h.store.execute(c)).toEqual(expected);
    const state = await h.store.read(SCOPE);
    expect(state).toEqual(expected); expect(Object.isFrozen(state.versions[0])).toBe(true);
    expect(h.calls.slice(0, 6)).toEqual(['role', 'tenant', 'organisation', 'head', 'versions', 'receipts']);
});
test.each([
    ['rolsuper', true], ['rolbypassrls', true], ['runtime_member', false],
    ['safe_tables', 4], ['tenant_context', 'other'], ['mutable_history', true]
])('rejects unsafe SQL role fence %s before owner reads', async (key, value) => {
    const h = harness(); h.role[key] = value;
    await expect(h.store.execute(fixture())).rejects.toMatchObject({ code: 'evidence_store_role_unsafe' });
    expect(h.calls).toEqual(['role']); expect(h.state.versions).toHaveLength(0);
});
test('current owner suspension denies both read and receipt replay', async () => {
    const h = harness(); await h.store.execute(fixture()); h.organisation.recordStatus = 'suspended';
    await expect(h.store.read(SCOPE)).rejects.toMatchObject({ code: 'evidence_store_owner_inactive' });
    await expect(h.store.execute(fixture())).rejects.toMatchObject({ code: 'evidence_store_owner_inactive' });
});
test('input is detached before first asynchronous boundary', async () => {
    const h = harness(), c = fixture(), pending = h.store.execute(c);
    c.payload.versionId = 'mutated'; c.actorSubjectKey = 'invalid';
    expect((await pending).currentVersionId).toBe('version:0');
});
test('replay after later revision/restart returns original state; new stale command fails', async () => {
    const h = harness(), c = fixture(), first = await h.store.execute(c);
    const second = await h.store.execute(next(c)); expect(second.revision).toBe(1);
    const restarted = createPostgresEvidenceStore({ database: h.database });
    expect(await restarted.execute({ ...c, now: '2026-09-10T01:00:00.000Z' })).toEqual(first);
    const stale = next(c); stale.idempotencyKey = 'different-operation'; stale.payload.versionId = 'different-version';
    await expect(restarted.execute(stale)).rejects.toMatchObject({ code: 'evidence_revision_conflict' });
    expect(h.state.versions).toHaveLength(2);
});
test('changed intent under the original operation ID conflicts without writes', async () => {
    const h = harness(), c = fixture(); await h.store.execute(c); c.payload.versionId = 'changed';
    await expect(h.store.execute(c)).rejects.toMatchObject({ code: 'evidence_store_intent_conflict' });
    expect(h.state.versions).toHaveLength(1);
});
test.each(['insert-version', 'insert-head', 'insert-receipt'])('failure at %s rolls back entire transaction', async tag => {
    const h = harness(); h.failAt = tag;
    await expect(h.store.execute(fixture())).rejects.toMatchObject({ code: 'postgres_query_failed' });
    expect(h.state).toEqual({ versions: [], heads: [], receipts: [] });
});
test('committed lost response reconciles by read only and returns original result', async () => {
    const h = harness(); h.ambiguous = 'committed';
    expect((await h.store.execute(fixture())).revision).toBe(0);
    expect(h.calls.filter(x => x === 'insert-version')).toHaveLength(1);
    expect(h.calls.slice(-6)).toEqual(['role', 'tenant', 'organisation', 'head', 'versions', 'receipts']);
});
test('uncommitted lost response and explicit absent reconciliation stay ambiguous without a second write', async () => {
    const h = harness(); h.ambiguous = 'absent';
    await expect(h.store.execute(fixture())).rejects.toMatchObject({ code: 'evidence_store_commit_ambiguous' });
    expect(h.calls.filter(x => x === 'insert-version')).toHaveLength(1); expect(h.state.versions).toHaveLength(0);
    await expect(h.store.reconcile(fixture())).rejects.toMatchObject({ code: 'evidence_store_commit_ambiguous' });
    expect(h.state.versions).toHaveLength(0);
});
test.each(['orphan', 'head-behind', 'missing-receipt', 'changed-event', 'changed-hash', 'foreign-row', 'parent-link', 'correlation', 'causation'])('rejects inconsistent restored %s', async mode => {
    const h = harness(), c = fixture(); await h.store.execute(c); await h.store.execute(next(c));
    if (mode === 'orphan') h.state.heads = [];
    if (mode === 'head-behind') h.state.heads[0].revision = 0;
    if (mode === 'missing-receipt') h.state.receipts.pop();
    if (mode === 'changed-event') h.state.receipts[0].payload.event.recordedAt = '2026-09-10T01:00:00.000Z';
    if (mode === 'changed-hash') h.state.versions[0].payload_sha256 = 'f'.repeat(64);
    if (mode === 'foreign-row') h.state.versions[0].organisation_id = 'other';
    if (mode === 'parent-link') h.state.versions[1].parent_sha256 = 'f'.repeat(64);
    if (mode === 'correlation') h.state.receipts[0].payload.event.correlationId = 'f'.repeat(64);
    if (mode === 'causation') h.state.receipts[0].payload.event.causationId = 'f'.repeat(64);
    await expect(h.store.read(SCOPE)).rejects.toMatchObject({ code: 'evidence_store_invalid' });
});
test('JSONB key reordering preserves canonical state and command hashes', async () => {
    const h = harness(); await h.store.execute(fixture());
    const reverse = x => Array.isArray(x) ? x.map(reverse) : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).reverse().map(k => [k, reverse(x[k])])) : x;
    h.state = reverse(h.state); expect((await h.store.read(SCOPE)).revision).toBe(0);
});
test('history query is bounded and oversized history cannot be silently truncated', async () => {
    const h = harness(); await h.store.execute(fixture());
    h.state.versions = Array(129).fill(h.state.versions[0]);
    await expect(h.store.read(SCOPE)).rejects.toMatchObject({ code: 'evidence_store_invalid' });
});
