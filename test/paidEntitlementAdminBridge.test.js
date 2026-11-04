'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createPaidEntitlementAdminBridge } = require('../api/shared/paidEntitlement/adminBridge');
const actor = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const selector = { provider: 'external', subjectKey: actor, tenantId: 'tenant-1', organisationId: 'org-1' };
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
    const f = { now: '2026-11-04T00:00:00.000Z', authorised: true, failAudit: false, beforeApply: null, receipts: new Map(), events: [] };
    f.current = { selector, displayName: 'Fictional customer', bindingSha256: 'a'.repeat(64), restoreEpoch: 0,
        record: { schemaVersion: 1, tenantId: 'tenant-1', organisationId: 'org-1', revision: 0, enabled: false, validUntil: null, agreementRef: null } };
    f.ctx = { principal: { provider: 'entra-bff', isAuthenticated: true, subjectKey: actor },
        check: () => f.now, beforeCommit: async () => { if (!f.authorised) throw new Error('private policy detail'); } };
    let queue = Promise.resolve();
    f.store = { transaction: jest.fn((scope, work, guard) => {
        const task = queue.then(async () => {
            expect(scope).toEqual({ tenantId: 'tenant-1', organisationId: 'org-1' });
            let staged = null;
            const result = await work({ snapshot: async () => clone(f.current), receipt: async id => clone(f.receipts.get(id) || null),
                save: async value => { staged = clone(value); if (f.failAudit) throw new Error('private SQL audit failure'); } });
            if (f.beforeApply) await f.beforeApply();
            await guard(); // Atomic native commit MUST call this after its last await.
            if (staged) { f.current.record = staged.record; f.events.push(staged.event); f.receipts.set(staged.receipt.operationId, staged.receipt); }
            return result;
        });
        queue = task.catch(() => {}); return task;
    }) };
    f.bridge = createPaidEntitlementAdminBridge({ enabled: true, store: f.store });
    f.command = async (patch = { enabled: true, validUntil: '2026-12-04T00:00:00.000Z', agreementRef: randomUUID() }) => {
        const observed = await f.bridge.inspect(selector, f.ctx);
        const value = { schemaVersion: 1, operationId: randomUUID(), actorSubjectKey: actor, selector,
            expectedVersion: observed.version, action: 'paid_entitlement', patch, preparedAt: f.now,
            expiresAt: new Date(Date.parse(f.now) + 300000).toISOString(), witness: observed.witness };
        return { ...value, commandSha256: hash(value) };
    };
    return f;
}
const conflict = { statusCode: 409 };
const unavailable = { statusCode: 503, message: 'paid_entitlement_unavailable' };

test('default-off refuses every port without reading the store', async () => {
    const f = fixture(), bridge = createPaidEntitlementAdminBridge({ store: f.store });
    for (const method of ['inspect', 'commit', 'outcome']) await expect(bridge[method](selector, f.ctx)).rejects.toMatchObject(unavailable);
    expect(f.store.transaction).not.toHaveBeenCalled();
    expect(() => createPaidEntitlementAdminBridge({ enabled: 'true' })).toThrow();
});
test('finite paid flag, audit and receipt commit together; identity and binding stay unchanged', async () => {
    const f = fixture(), original = clone(f.current), command = await f.command();
    const receipt = await f.bridge.commit(command, f.ctx);
    expect(receipt.status).toBe('succeeded'); expect(f.current.record.enabled).toBe(true); expect(f.current.record.revision).toBe(1);
    expect(f.current).toEqual({ ...original, record: { ...original.record, revision: 1, ...command.patch } });
    expect(f.events).toHaveLength(1); expect(f.events[0].before).toEqual(original.record);
    expect(f.events[0].after).toEqual(f.current.record); expect(hash(f.events[0])).toBe(receipt.version);
    expect(JSON.stringify(f.events)).not.toContain('Fictional customer');
});
test('same command concurrently commits once, then reconciles after confirmation expires', async () => {
    const f = fixture(), command = await f.command();
    const results = await Promise.all([f.bridge.commit(command, f.ctx), f.bridge.commit(command, f.ctx)]);
    expect(results[0]).toEqual(results[1]); expect(f.events).toHaveLength(1);
    f.now = command.expiresAt;
    await expect(f.bridge.outcome(command, f.ctx)).resolves.toEqual(results[0]);
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject(conflict);
});
test('concurrent different commands for the same org reject the stale preview', async () => {
    const f = fixture(), first = await f.command(), second = await f.command();
    const results = await Promise.allSettled([f.bridge.commit(first, f.ctx), f.bridge.commit(second, f.ctx)]);
    expect(results.map(x => x.status)).toEqual(['fulfilled', 'rejected']); expect(results[1].reason.statusCode).toBe(409);
    expect(f.events).toHaveLength(1);
});
test.each(['revision', 'binding', 'restore', 'name'])('changed %s invalidates confirmation', async kind => {
    const f = fixture(), command = await f.command();
    if (kind === 'revision') f.current.record.revision++;
    if (kind === 'binding') f.current.bindingSha256 = 'b'.repeat(64);
    if (kind === 'restore') f.current.restoreEpoch++;
    if (kind === 'name') f.current.displayName = 'Renamed fictional customer';
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject(conflict); expect(f.events).toHaveLength(0);
});
test.each(['audit', 'revocation', 'confirmation-expiry', 'term-expiry'])('rollback on %s at final transaction boundary', async kind => {
    const f = fixture(), command = await f.command(), original = clone(f.current.record);
    if (kind === 'audit') f.failAudit = true;
    else f.beforeApply = async () => {
        if (kind === 'revocation') f.authorised = false;
        if (kind === 'confirmation-expiry') f.now = command.expiresAt;
        if (kind === 'term-expiry') f.now = command.patch.validUntil;
    };
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject({ statusCode: kind.includes('expiry') ? 409 : 503 });
    expect(f.current.record).toEqual(original); expect(f.events).toHaveLength(0); expect(f.receipts.size).toBe(0);
});
test('disable clears term/reference without revoking membership or erasing audit; repeated disable is a conflict', async () => {
    const f = fixture(); await f.bridge.commit(await f.command(), f.ctx);
    const off = { enabled: false, validUntil: null, agreementRef: null };
    await f.bridge.commit(await f.command(off), f.ctx);
    expect(f.current.record).toMatchObject({ ...off, revision: 2 }); expect(f.events).toHaveLength(2);
    await expect(f.bridge.commit(await f.command(off), f.ctx)).rejects.toMatchObject(conflict);
});
test.each([
    { enabled: true, validUntil: null, agreementRef: randomUUID() },
    { enabled: true, validUntil: '2026-02-30T00:00:00.000Z', agreementRef: randomUUID() },
    { enabled: true, validUntil: '2026-12-04T00:00:00.000Z', agreementRef: 'customer@example.test' },
    { enabled: false, validUntil: '2026-12-04T00:00:00.000Z', agreementRef: null },
    { enabled: false, validUntil: null, agreementRef: null, invoice: 'private' }
])('rejects invalid or excessive paid metadata %#', async patch => {
    const f = fixture(); await expect(f.bridge.commit(await f.command(patch), f.ctx)).rejects.toMatchObject(unavailable);
    expect(f.events).toHaveLength(0);
});
test('already expired paid term cannot be granted', async () => {
    const f = fixture(), command = await f.command({ enabled: true, validUntil: f.now, agreementRef: randomUUID() });
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject(conflict);
});
test.each(['actor', 'scope', 'digest', 'future', 'receipt'])('rejects mismatched %s without write', async kind => {
    const f = fixture(), command = await f.command();
    if (kind === 'actor') f.ctx.principal.subjectKey = '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444';
    if (kind === 'scope') f.current.record.organisationId = 'other-org';
    if (kind === 'digest') command.patch.enabled = false;
    if (kind === 'future') f.now = '2026-11-03T00:00:00.000Z';
    if (kind === 'receipt') f.receipts.set(command.operationId, { operationId: command.operationId, commandSha256: 'c'.repeat(64), status: 'succeeded', version: 'd'.repeat(64), occurredAt: f.now });
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject(unavailable); expect(f.events).toHaveLength(0);
});
test('restore epoch change blocks replay and reconciliation of an old confirmation', async () => {
    const f = fixture(), command = await f.command(); await f.bridge.commit(command, f.ctx); f.current.restoreEpoch++;
    await expect(f.bridge.commit(command, f.ctx)).rejects.toMatchObject(conflict);
    await expect(f.bridge.outcome(command, f.ctx)).rejects.toMatchObject(conflict); expect(f.events).toHaveLength(1);
});
test('revoked operator cannot reconcile a retained receipt', async () => {
    const f = fixture(), command = await f.command(); await f.bridge.commit(command, f.ctx); f.authorised = false;
    await expect(f.bridge.outcome(command, f.ctx)).rejects.toMatchObject(unavailable);
});
test('no production module imports the dormant adapter', () => {
    const root = join(__dirname, '..'), own = join(root, 'api/shared/paidEntitlement/adminBridge.js');
    function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]); }
    for (const file of [...walk(join(root, 'api')), ...walk(join(root, 'lib')), join(root, 'server.js')]) {
        if (file.endsWith('.js') && file !== own) expect(readFileSync(file, 'utf8')).not.toMatch(/paidEntitlement\/adminBridge|createPaidEntitlementAdminBridge/);
    }
});
