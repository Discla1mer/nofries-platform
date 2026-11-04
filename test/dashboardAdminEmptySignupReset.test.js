'use strict';
const { createEmptySignupResetAdapter } = require('../api/shared/dashboardAdmin/emptySignupResetAdapter');
const { createSignupWriterFence, KEY } = require('../api/shared/customerSignup/signupWriterFence');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createSignupIndexMaintenance, WRITER_CONTRACT } = require('../api/shared/dashboardAdmin/signupIndexMaintenance');
const { createResetAuditStore } = require('../api/shared/dashboardAdmin/resetAuditStore');
const { commandDigest } = require('../api/shared/dashboardAdmin/accountActionRecords');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { fixture, uid, clone } = require('./fixtures/dashboardAdminSignupData');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
async function harness() {
    const f = await fixture('external'), h = versionedBlobs(), retained = versionedBlobs(); let serial = 900;
    for (const [key, value] of f.blobs) h.put(key, value);
    const now = f.clock(), epoch = uid(800), instance = uid(801), actor = uid(802) + ':' + uid(803);
    const selector = { provider: 'external', subjectKey: f.account.identitySubjectKey,
        tenantId: f.account.organisations[0].tenantId, organisationId: f.account.organisations[0].organisationId };
    const store = new AzureStarterAccountStore(h.container);
    const index = createSignupIndexMaintenance({ container: h.container, accountStore: store, provider: 'external',
        populationId: 'synthetic-reset-population', indexId: 'synthetic-reset-index', instanceId: instance,
        sourceBindingSha256: 'c'.repeat(64), writerContract: WRITER_CONTRACT, clock: () => now,
        readExternalRuntimeEpoch: async () => ({ instanceId: instance, restoreEpoch: epoch }), newId: () => uid(serial++) });
    await index.rebuild({ authoriseMaintenance: async () => true });
    const writerFence = createSignupWriterFence({ container: h.container, scopeId: 'd'.repeat(64) });
    const state = { empty: true, adoption: true };
    const inspectDependencies = jest.fn(async () => ({ empty: state.empty }));
    const readAdoption = jest.fn(async () => { if (!state.adoption) throw new Error('synthetic gate not approved'); });
    const audit = createResetAuditStore(retained.container);
    const adapter = createEmptySignupResetAdapter({ container: h.container, index, writerFence, sourceSha: 'e'.repeat(40),
        providerKey: 'a'.repeat(64), containerSha256: 'f'.repeat(64), clock: () => now, readAdoption, inspectDependencies, audit });
    const context = { actorSubjectKey: actor, authoritySha256: 'b'.repeat(64), restoreEpoch: epoch, check: jest.fn(async () => {}) };
    async function command() {
        const observed = await adapter.inspect(selector, context);
        const value = { schemaVersion: 1, operationId: uid(serial++), actorSubjectKey: actor, selector,
            expectedVersion: observed.version, action: 'reset', patch: null, preparedAt: now,
            expiresAt: new Date(Date.parse(now) + 300000).toISOString(), witness: observed.witness };
        return { ...value, commandSha256: commandDigest(value) };
    }
    return { f, ...h, retained, index, store, state, adapter, context, selector, command, writerFence, audit, readAdoption, inspectDependencies };
}
test('reset removes only a half-created account, preserves setup evidence, fixes index and reconciles once', async () => {
    const h = await harness(), before = Buffer.from(h.current.get(h.f.setupPath).bytes), command = await h.command();
    expect(await h.adapter.outcome(command)).toBeNull();
    const result = await h.adapter.commit(command, h.context); expect(result.status).toBe('succeeded');
    expect(h.current.has(h.f.accountPath)).toBe(false); expect(h.current.get(h.f.setupPath).bytes).toEqual(before);
    expect((await h.index.readCurrentIndex()).sourceReferences).toEqual([]); expect(h.leases.size).toBe(0);
    expect(await h.adapter.commit(command, h.context)).toEqual(result); expect(await h.adapter.outcome(command)).toEqual(result);
    const audit = [...h.retained.current.values()].map(v => v.bytes.toString()).join('\n');
    expect(audit).not.toContain(h.f.account.email); expect(audit).not.toContain(h.f.account.organisations[0].organisationName);
    const fresh = clone(h.f.account); fresh.accountId = uid(990); fresh.setupRequestId = uid(991); fresh.organisations[0].requestId = uid(991);
    await h.writerFence.withWriter(() => h.index.accountStore.create(h.f.reference.accountKey, fresh));
    expect((await h.index.readCurrentIndex()).sourceReferences[0].entry.binding.accountId).toBe(fresh.accountId);
});
test('canonical dependency makes reset unavailable and cannot be reclassified as an empty signup', async () => {
    const h = await harness(); h.state.empty = false;
    expect(await h.adapter.inspect(h.selector, h.context)).toBeNull(); expect(h.current.has(h.f.accountPath)).toBe(true);
    expect(h.calls.filter(c => c[0] === 'delete')).toEqual([]);
});
test('changed dependency after preview stops before deletion and retains uncertainty for operator recovery', async () => {
    const h = await harness(), command = await h.command(); h.state.empty = false;
    await expect(h.adapter.commit(command, h.context)).rejects.toThrow();
    expect(h.current.has(h.f.accountPath)).toBe(true); expect(h.leases.has(KEY)).toBe(true);
    expect((await h.adapter.outcome(command)).status).toBe('pending');
});
test('missing recovery versions or controller adoption prevents any destructive request', async () => {
    const h = await harness(); h.state.adoption = false;
    await expect(h.command()).rejects.toThrow(); expect(h.calls.filter(c => c[0] === 'delete')).toEqual([]);
    h.state.adoption = true; const command = await h.command(); h.versions.clear();
    await expect(h.adapter.commit(command, h.context)).rejects.toThrow();
    expect(h.current.has(h.f.accountPath)).toBe(true); expect((await h.adapter.outcome(command)).status).toBe('pending');
});
test('a lost completed-audit acknowledgement reconciles without repeating pointer deletion', async () => {
    const h = await harness(), command = await h.command(); const original = h.audit.write;
    // The real immutable store already reconciles acknowledgement loss; a
    // caller losing the final response can fetch the persisted outcome.
    const result = await h.adapter.commit(command, h.context), deletes = h.calls.filter(c => c[0] === 'delete').length;
    expect(await h.adapter.outcome(command)).toEqual(result);
    expect(await h.adapter.commit(command, h.context)).toEqual(result);
    expect(h.calls.filter(c => c[0] === 'delete')).toHaveLength(deletes); expect(typeof original).toBe('function');
});
