'use strict';
const { Readable } = require('node:stream');
const { publishApproval } = require('../scripts/dashboard-admin-approve');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { headKey } = require('../api/shared/dashboardAdmin/approvalRecords');
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
    const at = '2026-11-09T01:00:00.000Z', target = { instanceId: uid(1), operatorSubjectKey: uid(2) + ':' + uid(3), purpose: 'signup_support' };
    const binding = { schemaVersion: 1, bindingId: uid(4), revision: 0, status: 'active', action: 'dashboard.authority.read', ...target,
        selector: { provider: 'legacy', subjectKey: uid(2) + ':' + uid(5), tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' },
        approvedAt: at, validFrom: at, validUntil: '2026-11-09T02:00:00.000Z', approvalReference: 'synthetic-decision',
        identityPolicy: { policyId: 'synthetic-policy', policyRevision: 1 }, auditPolicy: { reference: 'synthetic-audit', revision: 1,
            agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
    const record = { schemaVersion: 1, recordType: 'dashboard_admin_approval_revision', ...target, restoreEpoch: uid(6),
        revision: 0, status: 'active', changedAt: at, decisionReference: 'synthetic-decision', binding };
    const input = { storageAccount: 'syntheticdata', authorityContainer: 'admin-approvals', epochStorageAccount: 'syntheticauth',
        epochContainer: 'runtime-epochs', record, expectedRevision: null, expectedRecordSha256: null };
    const blobs = new Map(), writes = [], output = [], state = { epoch: uid(6), failWrite: null, afterWrite: null };
    const authority = { getBlockBlobClient(key) { return {
        async download() { if (!blobs.has(key)) throw Object.assign(new Error(), { statusCode: 404, code: 'BlobNotFound' });
            const text = canonical(blobs.get(key)); return { etag: '"' + hash(blobs.get(key)) + '"', contentLength: Buffer.byteLength(text), readableStreamBody: Readable.from([Buffer.from(text)]) }; },
        async uploadData(bytes, options) {
            if (state.failWrite === writes.length) throw new Error('synthetic-private-provider-message');
            if (options.conditions.ifNoneMatch && blobs.has(key) || options.conditions.ifMatch && options.conditions.ifMatch !== '"' + hash(blobs.get(key)) + '"') throw new Error();
            writes.push(key); blobs.set(key, JSON.parse(bytes)); state.afterWrite?.();
        }
    }; } };
    const epoch = { getBlockBlobClient() { return { async download() {
        const text = JSON.stringify({ restoreEpoch: state.epoch, instanceId: target.instanceId }, null, 2);
        return { etag: '"epoch"', contentLength: Buffer.byteLength(text), readableStreamBody: Readable.from([Buffer.from(text)]) };
    } }; } };
    const run = confirm => publishApproval(input, { authority, epoch, confirm, print: value => output.push(value), now: () => Date.parse(at) });
    return { input, blobs, writes, output, state, run, key: headKey(target) };
}
test('dry run prints exact writes; hash confirmation publishes audit then archive then CAS head; retry writes nothing', async () => {
    const h = fixture(); await h.run(); expect(h.writes).toEqual([]);
    const plan = h.output[0]; expect(plan.writes).toHaveLength(3);
    expect(plan.writes[0].blob).toContain('publication-intents/'); expect(plan.writes[1].body).toEqual(h.input.record);
    await expect(h.run('0'.repeat(64))).rejects.toThrow(); expect(h.writes).toEqual([]);
    await h.run(plan.planSha256); expect(h.writes).toEqual(plan.writes.map(w => w.blob));
    await h.run(plan.planSha256); expect(h.writes).toHaveLength(3); expect(h.output.at(-1).status).toBe('already_applied');
});
test.each(['epoch', 'audit failure', 'mid-write epoch', 'extra secret field', 'expired'])('refuses %s without publishing an authority head', async kind => {
    const h = fixture(); await h.run(); const confirmation = h.output[0].planSha256;
    if (kind === 'epoch') h.state.epoch = uid(9);
    if (kind === 'audit failure') h.state.failWrite = 0;
    if (kind === 'mid-write epoch') h.state.afterWrite = () => { h.state.epoch = uid(9); };
    if (kind === 'extra secret field') h.input.secret = 'synthetic-secret';
    if (kind === 'expired') h.input.record.binding.validUntil = h.input.record.binding.validFrom;
    await expect(h.run(confirmation)).rejects.toThrow(); expect(h.blobs.has(h.key)).toBe(false);
    expect(JSON.stringify(h.output)).not.toContain('synthetic-secret');
});
test('revocation requires exact predecessor and a new reviewed plan; old activation cannot replay', async () => {
    const h = fixture(); await h.run(); await h.run(h.output[0].planSha256);
    const previous = h.input.record;
    h.input.record = { ...previous, revision: 1, status: 'revoked', binding: null };
    await expect(h.run()).rejects.toThrow();
    h.input.expectedRevision = 0; h.input.expectedRecordSha256 = hash(previous);
    await h.run(); await h.run(h.output.at(-1).planSha256);
    expect(h.blobs.get(h.key).status).toBe('revoked');
    h.input.record = previous; h.input.expectedRevision = null; h.input.expectedRecordSha256 = null;
    await expect(h.run()).rejects.toThrow();
});
test('partial archive publication can be replanned and completed without replacing immutable history', async () => {
    const h = fixture(); await h.run(); const first = h.output[0]; h.state.failWrite = 2;
    await expect(h.run(first.planSha256)).rejects.toThrow(); expect(h.blobs.has(h.key)).toBe(false);
    h.state.failWrite = null; await h.run(); const retry = h.output.at(-1);
    expect(retry.writes.map(w => w.blob)).toEqual([h.key]);
    await expect(h.run(first.planSha256)).rejects.toThrow();
    await h.run(retry.planSha256); expect(h.writes).toHaveLength(3);
});
test('lookup-only locator is inert while disabled and rejects source/approval collisions without SDK access', () => {
    const { createEnvironmentLookupReader } = require('../lib/dashboardAdminLookupProduction');
    const get = jest.fn(() => { throw new Error('unexpected SDK'); }), dependencies = {};
    Object.defineProperty(dependencies, 'ManagedIdentityCredential', { get });
    const env = { NOFRIES_DASHBOARD_ADMIN_LOOKUP_AUTHORITY_CONTAINER: 'approvals', NOFRIES_DASHBOARD_ADMIN_ENABLED: 'false' };
    expect(createEnvironmentLookupReader(env, null, dependencies)).toBeNull();
    Object.assign(env, { NOFRIES_DASHBOARD_ADMIN_ENABLED: 'true', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'approvals' });
    expect(() => createEnvironmentLookupReader(env, null, dependencies)).toThrow(); expect(get).not.toHaveBeenCalled();
});
