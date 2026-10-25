'use strict';

const { Readable } = require('node:stream');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { headKey, revisionKey } = require('../api/shared/dashboardAdmin/approvalRecords');
const { createDashboardAdminApprovalReader } = require('../api/shared/dashboardAdmin/approvalStore');

const ID = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = `${ID(1)}:${ID(2)}`, TARGET_SUBJECT = `${ID(3)}:${ID(4)}`;
const INSTANCE = ID(5), EPOCH = ID(6), AT = '2026-10-20T02:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const unavailable = { code: 'dashboard_admin_unavailable', statusCode: 503 };
const query = { operatorSubjectKey: ACTOR, purpose: 'signup_support' };
const target = { ...query, instanceId: INSTANCE };
const missing = () => Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
function fixture() {
    const binding = { schemaVersion: 1, bindingId: ID(7), revision: 1, status: 'active', action: 'dashboard.authority.read',
        purpose: 'signup_support', operatorSubjectKey: ACTOR, instanceId: INSTANCE,
        selector: { provider: 'legacy', subjectKey: TARGET_SUBJECT, tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' },
        approvedAt: '2026-10-20T01:59:00.000Z', validFrom: AT, validUntil: '2026-10-20T03:00:00.000Z',
        approvalReference: 'synthetic-owner-decision', identityPolicy: { policyId: 'synthetic-identity-policy', policyRevision: 2 },
        auditPolicy: { reference: 'synthetic-audit-policy', revision: 3, agreementVersion: 'nf-dashboard-2026-09-r2',
            retention: { unit: 'calendar_months', count: 13 } } };
    const state = { at: AT, epoch: EPOCH, etag: 0, hook: null, epochHook: null };
    const blobs = new Map(), streams = [], calls = [];
    const record = { schemaVersion: 1, recordType: 'dashboard_admin_approval_revision', ...target, restoreEpoch: EPOCH,
        revision: 1, status: 'active', changedAt: binding.approvedAt, decisionReference: binding.approvalReference, binding };
    function put(key, value) { blobs.set(key, { text: canonical(value), etag: `"synthetic-${++state.etag}"` }); }
    function install(value = record) {
        const digest = hash(value), head = { schemaVersion: 1, recordType: 'dashboard_admin_approval_head', ...target,
            restoreEpoch: value.restoreEpoch, revision: value.revision, status: value.status, recordSha256: digest };
        put(revisionKey(target, digest), value); put(headKey(target), head); return head;
    }
    const originalHead = install();
    const container = { getBlockBlobClient: jest.fn(key => ({ download: jest.fn(async (offset, length, options) => {
        const call = { key, offset, length, options }; calls.push(call);
        if (state.hook) await state.hook(call);
        const stored = blobs.get(key); if (!stored) throw missing();
        if (options.conditions?.ifMatch && options.conditions.ifMatch !== stored.etag)
            throw Object.assign(new Error('synthetic changed'), { statusCode: 412 });
        const bytes = Buffer.from(stored.text), stream = Readable.from([bytes]); streams.push(stream);
        return { contentLength: bytes.length, etag: stored.etag, readableStreamBody: stream, ...stored.response };
    }), uploadData: jest.fn(() => { throw new Error('No source write permitted'); }),
    delete: jest.fn(() => { throw new Error('No source deletion permitted'); }) })),
    listBlobsFlat: jest.fn(() => { throw new Error('No source listing permitted'); }) };
    const readEpoch = jest.fn(async () => { if (state.epochHook) await state.epochHook(); return { instanceId: INSTANCE, restoreEpoch: state.epoch }; });
    const config = { authorityContainer: container, instanceId: INSTANCE, clock: () => state.at,
        readExternalRuntimeEpoch: readEpoch, requestBudgetMs: 1000 };
    const reader = createDashboardAdminApprovalReader(config);
    return { binding, record, state, blobs, streams, calls, container, readEpoch, config, reader, put, install, originalHead,
        revoke() { return install({ ...record, revision: 2, status: 'revoked', changedAt: state.at,
            decisionReference: 'synthetic-revocation', binding: null }); } };
}

test('fresh source head/archive/head and epoch brackets return exactly the frozen binding with no write/list capability', async () => {
    const h = fixture();
    expect(Object.keys(h.reader)).toEqual(['readApprovedBinding']);
    const result = await h.reader.readApprovedBinding(query);
    expect(result).toEqual(h.binding); expect(Object.isFrozen(result.selector)).toBe(true);
    expect(h.calls.map(call => call.key)).toEqual([headKey(target), revisionKey(target, hash(h.record)), headKey(target)]);
    expect(h.calls[2].options.conditions).toEqual({ ifMatch: '"synthetic-2"' });
    expect(h.calls.every(call => call.offset === 0 && call.options.abortSignal instanceof AbortSignal)).toBe(true);
    expect(h.calls.every(call => !call.key.includes(ACTOR) && !call.key.includes(TARGET_SUBJECT))).toBe(true);
    expect(h.readEpoch).toHaveBeenCalledTimes(2); expect(h.streams.every(stream => stream.destroyed)).toBe(true);
    await expect(h.reader.readApprovedBinding(query)).resolves.toEqual(h.binding);
    expect(h.calls).toHaveLength(6); expect(h.container.listBlobsFlat).not.toHaveBeenCalled();
    for (const result of h.container.getBlockBlobClient.mock.results) {
        expect(result.value.uploadData).not.toHaveBeenCalled(); expect(result.value.delete).not.toHaveBeenCalled();
    }
});

test.each(['legacy', 'external'])('exact %s target partition is preserved', async provider => {
    const h = fixture(); h.record.binding.selector.provider = provider; h.install();
    await expect(h.reader.readApprovedBinding(query)).resolves.toMatchObject({ selector: { provider, subjectKey: TARGET_SUBJECT } });
});

test.each([
    ['email selector', q => { q.email = 'synthetic@example.invalid'; }],
    ['caller source locator', q => { q.source = 'other.json'; }],
    ['caller approval reference', q => { q.approvalReference = 'synthetic'; }],
    ['foreign purpose', q => { q.purpose = 'customer_recovery'; }],
    ['nonimmutable actor', q => { q.operatorSubjectKey = 'synthetic@example.invalid'; }]
])('rejects %s before a storage read', async (_, change) => {
    const h = fixture(), input = clone(query); change(input);
    await expect(h.reader.readApprovedBinding(input)).rejects.toMatchObject(unavailable);
    expect(h.calls).toHaveLength(0);
});

test('unknown exact operator returns no approval without listing or another operator fallback', async () => {
    const h = fixture();
    await expect(h.reader.readApprovedBinding({ ...query, operatorSubjectKey: `${ID(1)}:${ID(99)}` })).resolves.toBeNull();
    expect(h.calls).toHaveLength(1); expect(h.container.listBlobsFlat).not.toHaveBeenCalled();
});

test.each([
    ['unexpected record field', r => { r.extra = true; }],
    ['wrong record type', r => { r.recordType = 'customer_authority'; }],
    ['wrong record schema', r => { r.schemaVersion = 2; }],
    ['wrong operator', r => { r.operatorSubjectKey = `${ID(1)}:${ID(99)}`; }],
    ['wrong instance', r => { r.instanceId = ID(99); }],
    ['wrong purpose', r => { r.purpose = 'other'; }],
    ['unknown status', r => { r.status = 'pending'; }],
    ['missing active binding', r => { r.binding = null; }],
    ['revoked binding content', r => { r.status = 'revoked'; }],
    ['mismatched binding revision', r => { r.binding.revision++; }],
    ['mismatched binding operator', r => { r.binding.operatorSubjectKey = `${ID(1)}:${ID(99)}`; }],
    ['mismatched binding instance', r => { r.binding.instanceId = ID(99); }],
    ['mismatched decision provenance', r => { r.decisionReference = 'different'; }],
    ['future approval', r => { r.changedAt = r.binding.approvedAt = '2026-10-20T02:10:00.000Z'; r.binding.validFrom = r.changedAt; }],
    ['approval after start', r => { r.binding.approvedAt = r.changedAt = '2026-10-20T02:00:01.000Z'; }],
    ['window over sixty minutes', r => { r.binding.validUntil = '2026-10-20T03:00:00.001Z'; }],
    ['empty window', r => { r.binding.validUntil = AT; }],
    ['mutation action', r => { r.binding.action = 'dashboard.authority.write'; }],
    ['wildcard target', r => { r.binding.selector.organisationId = '*'; }],
    ['unsupported provider', r => { r.binding.selector.provider = 'email'; }],
    ['fixed-day retention', r => { r.binding.auditPolicy.retention = { unit: 'days', count: 395 }; }],
    ['different agreement', r => { r.binding.auditPolicy.agreementVersion = 'other'; }],
    ['invalid identity policy', r => { r.binding.identityPolicy.policyRevision = -1; }]
])('fails closed for %s in an otherwise correctly hashed record', async (_, change) => {
    const h = fixture(); change(h.record); h.install();
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test.each(['schemaVersion', 'recordType', 'operatorSubjectKey', 'instanceId', 'purpose', 'revision', 'recordSha256'])('rejects malformed current head %s', async field => {
    const h = fixture(), head = clone(h.originalHead); head[field] = 'invalid'; h.put(headKey(target), head);
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('a valid revocation returns null and blocks replay of the older active head', async () => {
    const h = fixture(); h.revoke();
    await expect(h.reader.readApprovedBinding(query)).resolves.toBeNull();
    h.put(headKey(target), h.originalHead);
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('a newly approved higher revision remains usable after revocation', async () => {
    const h = fixture(); h.revoke(); await h.reader.readApprovedBinding(query);
    h.record.revision = h.record.binding.revision = 3; h.install();
    await expect(h.reader.readApprovedBinding(query)).resolves.toMatchObject({ revision: 3 });
});

test('same-revision replacement cannot change the target even between requests', async () => {
    const h = fixture(); await h.reader.readApprovedBinding(query);
    h.record.binding.selector.organisationId = 'different-org'; h.install();
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('missing current head after a prior observation is unavailable, never a cached grant', async () => {
    const h = fixture(); await h.reader.readApprovedBinding(query); h.blobs.delete(headKey(target));
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test.each(['missing', 'mismatched digest'])('an %s archive cannot authorize', async kind => {
    const h = fixture(), key = revisionKey(target, h.originalHead.recordSha256);
    if (kind === 'missing') h.blobs.delete(key);
    else { const changed = clone(h.record); changed.binding.selector.organisationId = 'other'; h.put(key, changed); }
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test.each(['revocation', 'missing', 'same bytes new etag'])('current head %s during I/O prevents release', async mode => {
    const h = fixture(); h.state.hook = call => {
        if (call.key.startsWith('dashboard-admin-approval-revisions/')) {
            if (mode === 'revocation') h.revoke();
            else if (mode === 'missing') h.blobs.delete(headKey(target));
            else h.put(headKey(target), h.originalHead);
        }
    };
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test.each(['before start', 'at expiry', 'after expiry'])('approval %s gives no binding', async mode => {
    const h = fixture(); h.state.at = mode === 'before start' ? '2026-10-20T01:59:30.000Z' :
        mode === 'at expiry' ? h.binding.validUntil : '2026-10-20T03:00:01.000Z';
    await expect(h.reader.readApprovedBinding(query)).resolves.toBeNull();
});

test('expiry during the last epoch read prevents release', async () => {
    const h = fixture(); h.state.epochHook = () => { if (h.readEpoch.mock.calls.length === 2) h.state.at = h.binding.validUntil; };
    await expect(h.reader.readApprovedBinding(query)).resolves.toBeNull();
});

test('clock rollback cannot revive an expired approval', async () => {
    const h = fixture(); h.state.at = h.binding.validUntil; await h.reader.readApprovedBinding(query); h.state.at = AT;
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('cold reader denies restored old-epoch approval after the independently maintained epoch advances', async () => {
    const h = fixture(); h.state.epoch = ID(90);
    const freshReader = createDashboardAdminApprovalReader(h.config);
    await expect(freshReader.readApprovedBinding(query)).resolves.toBeNull();
    expect(h.calls).toHaveLength(1);
});

test('new approval explicitly bound to the current epoch is readable', async () => {
    const h = fixture(); h.state.epoch = h.record.restoreEpoch = ID(90); h.install();
    await expect(h.reader.readApprovedBinding(query)).resolves.toEqual(h.binding);
});

test('epoch changes during storage reads fail closed', async () => {
    const h = fixture(); h.state.hook = call => { if (call.options.conditions) h.state.epoch = ID(90); };
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('foreign/malformed/unavailable epoch is not treated as an absent approval', async () => {
    for (const value of [null, { instanceId: ID(99), restoreEpoch: EPOCH }, { instanceId: INSTANCE, restoreEpoch: 'bad' }]) {
        const h = fixture(); h.readEpoch.mockResolvedValue(value);
        await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable); expect(h.calls).toHaveLength(0);
    }
    const h = fixture(); h.readEpoch.mockRejectedValue(new Error('synthetic unavailable'));
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('a slower read cannot release an active grant after a concurrent revocation observed during its final epoch await', async () => {
    const h = fixture(); let resume, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    h.state.epochHook = async () => { if (h.readEpoch.mock.calls.length === 2) { entered(); await new Promise(resolve => { resume = resolve; }); } };
    const slow = h.reader.readApprovedBinding(query); await waiting; h.revoke();
    await expect(h.reader.readApprovedBinding(query)).resolves.toBeNull(); resume();
    await expect(slow).rejects.toMatchObject(unavailable);
});

test.each(['unknown 404', '403', '429', '503'])('storage %s fails unavailable without retry or cached authority', async kind => {
    const h = fixture(); await h.reader.readApprovedBinding(query);
    h.state.hook = () => { throw Object.assign(new Error('synthetic private detail'), { statusCode: Number(kind), code: 'Other' }); };
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
    expect(h.calls).toHaveLength(4);
});

test.each([
    ['missing body', { readableStreamBody: null }], ['zero length', { contentLength: 0 }],
    ['oversize', { contentLength: 2049 }], ['truncated length', { contentLength: 1 }],
    ['missing etag', { etag: undefined }], ['weak etag', { etag: 'W/"x"' }], ['invalid etag', { etag: '"bad\n"' }]
])('rejects %s response metadata and closes any stream', async (_, response) => {
    const h = fixture(); h.blobs.get(headKey(target)).response = response;
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
    if (response.readableStreamBody !== null) expect(h.streams.every(stream => stream.destroyed)).toBe(true);
});

test.each(['duplicate key', 'invalid JSON', 'noncanonical JSON', 'invalid UTF8'])('rejects %s bytes', async kind => {
    const h = fixture(), stored = h.blobs.get(headKey(target));
    stored.text = kind === 'duplicate key' ? stored.text.replace('{', '{"revision":999,') :
        kind === 'invalid JSON' ? '{' : kind === 'noncanonical JSON' ? ' ' + stored.text : Buffer.from([255]);
    await expect(h.reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
});

test('hard timeout rejects a provider that ignores abort and its late result cannot install high-water or grant authority', async () => {
    const h = fixture(); let resume, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    h.state.hook = async () => { entered(); await new Promise(resolve => { resume = resolve; }); };
    const reader = createDashboardAdminApprovalReader({ ...h.config, requestBudgetMs: 25 });
    const pending = reader.readApprovedBinding(query), result = expect(pending).rejects.toMatchObject(unavailable);
    await waiting; await result; h.state.hook = null; resume();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.streams.every(stream => stream.destroyed)).toBe(true);
    h.blobs.delete(headKey(target)); await expect(reader.readApprovedBinding(query)).resolves.toBeNull();
});

test('hard timeout closes a stalled response stream', async () => {
    const h = fixture(), stream = new Readable({ read() {} });
    h.blobs.get(headKey(target)).response = { readableStreamBody: stream };
    const reader = createDashboardAdminApprovalReader({ ...h.config, requestBudgetMs: 25 });
    await expect(reader.readApprovedBinding(query)).rejects.toMatchObject(unavailable);
    expect(stream.destroyed).toBe(true);
});
