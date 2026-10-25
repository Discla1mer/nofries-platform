'use strict';
const { Readable } = require('node:stream');
const { createDashboardAdminSignupListingReader, createDashboardAdminSignupListingPublisher } = require('../api/shared/dashboardAdmin/signupListingStore');
const { listingHeadKey, listingRevisionKey } = require('../api/shared/dashboardAdmin/signupListingRecords');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { uid, ACTOR, clone, record } = require('./fixtures/dashboardAdminSignupFixture');
const TARGET = { instanceId: uid(80), operatorSubjectKey: ACTOR, provider: 'legacy', populationId: 'synthetic-population',
    indexId: 'synthetic-index', sourceBindingSha256: 'a'.repeat(64) }, EPOCH = uid(81), AT = '2026-10-20T07:30:00.000Z';
const query = { operatorSubjectKey: ACTOR, capability: 'signupList' };
const unavailable = { statusCode: 503, code: 'dashboard_admin_unavailable' }, denied = { statusCode: 403, code: 'dashboard_admin_access_denied' };
const missing = () => Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
function fixture() {
    const data = record(), entry = { recordId: data.recordId, binding: data.binding };
    const index = { manifest: { schemaVersion: 2, provider: TARGET.provider, populationId: TARGET.populationId,
        indexId: TARGET.indexId, entries: [entry] }, sourceReferences: [{ entry: clone(entry), accountKey: 'starter-accounts/' + 'b'.repeat(64) }],
        revision: 1, restoreEpoch: EPOCH, sourceBindingSha256: TARGET.sourceBindingSha256, complete: true };
    const policy = { coverage: 'complete_application_signups', approvedAt: '2026-10-20T06:00:00.000Z',
        validFrom: '2026-10-20T07:00:00.000Z', validUntil: null, decisionWindowMs: 3600000, pageSize: 25,
        fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicy: { reference: 'synthetic-audit', revision: 1,
            agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
    const revision = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_revision', ...TARGET,
        restoreEpoch: EPOCH, revision: 2, status: 'active', changedAt: policy.approvedAt, decisionReference: 'synthetic-approval', policy };
    const state = { at: AT, epoch: EPOCH, etag: 0, index, hook: null, indexHook: null, epochHook: null }, blobs = new Map(), calls = [], streams = [];
    function put(key, value) { blobs.set(key, { text: canonical(value), etag: `"synthetic-${++state.etag}"` }); }
    function install(value = revision) {
        const head = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_head', ...TARGET,
            restoreEpoch: value.restoreEpoch, revision: value.revision, status: value.status, recordSha256: hash(value) };
        put(listingRevisionKey(TARGET, hash(value)), value); put(listingHeadKey(TARGET), head); return head;
    }
    const originalHead = install();
    const container = { getBlockBlobClient: jest.fn(key => ({ download: jest.fn(async (offset, length, options) => {
        calls.push({ key, offset, length, options }); if (state.hook) await state.hook({ key, options });
        const stored = blobs.get(key); if (!stored) throw missing();
        if (options.conditions?.ifMatch && options.conditions.ifMatch !== stored.etag) throw Object.assign(new Error('synthetic changed'), { statusCode: 412 });
        const bytes = Buffer.from(stored.text), stream = stored.stream || Readable.from([bytes]); streams.push(stream);
        return { contentLength: bytes.length, etag: stored.etag, readableStreamBody: stream, ...stored.response };
    }), uploadData: jest.fn(() => { throw new Error('No write'); }), delete: jest.fn(() => { throw new Error('No delete'); }) })),
    listBlobsFlat: jest.fn(() => { throw new Error('No listing'); }) };
    const readEpoch = jest.fn(async () => { if (state.epochHook) await state.epochHook(); return { instanceId: TARGET.instanceId, restoreEpoch: state.epoch }; });
    const readCurrentIndex = jest.fn(async options => { if (state.indexHook) await state.indexHook(options); return clone(state.index); });
    const config = { authorityContainer: container, instanceId: TARGET.instanceId, clock: () => state.at, readExternalRuntimeEpoch: readEpoch,
        requestBudgetMs: 1000, provider: TARGET.provider, populationId: TARGET.populationId, indexId: TARGET.indexId,
        sourceBindingSha256: TARGET.sourceBindingSha256, readCurrentIndex };
    const reader = createDashboardAdminSignupListingReader(config);
    return { revision, policy, originalHead, index, state, blobs, calls, streams, container, readEpoch, readCurrentIndex, config, reader, put, install,
        revoke() { return install({ ...revision, revision: 3, status: 'revoked', changedAt: state.at, decisionReference: 'synthetic-revocation', policy: null }); } };
}

test('actual private head/archive/head and complete-index/epoch fences produce current authority without writer or enumeration', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query);
    expect(grant).toMatchObject({ schemaVersion: 2, operatorSubjectKey: ACTOR, maxRows: 1, scope: { manifestSha256: hash(f.index.manifest) } });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(f.calls.map(x => x.key)).toEqual([listingHeadKey(TARGET), listingRevisionKey(TARGET, hash(f.revision)), listingHeadKey(TARGET)]);
    expect(f.calls[2].options.conditions).toEqual({ ifMatch: '"synthetic-2"' });
    expect(f.readCurrentIndex).toHaveBeenCalledTimes(2); expect(f.readEpoch).toHaveBeenCalledTimes(2);
    expect(f.streams.every(x => x.destroyed)).toBe(true);
    expect(f.calls.every(x => x.options.abortSignal instanceof AbortSignal && !x.key.includes(ACTOR))).toBe(true);
    await expect(f.reader.resolvePopulationBinding(grant)).resolves.toEqual({ authoritySha256: hash(grant), manifestSha256: hash(f.index.manifest) });
    await expect(f.reader.readApprovedIndex(grant)).resolves.toEqual(f.index);
    expect(f.calls).toHaveLength(9); expect(f.container.listBlobsFlat).not.toHaveBeenCalled();
    f.container.getBlockBlobClient.mock.results.forEach(x => { expect(x.value.uploadData).not.toHaveBeenCalled(); expect(x.value.delete).not.toHaveBeenCalled(); });
});

test('atomic state returns only the frozen coherent authority/population pair from one unchanged source walk', async () => {
    const f = fixture(), result = await f.reader.readApprovedState(query);
    expect(Object.keys(result)).toEqual(['authority', 'population']);
    expect(result.authority).toMatchObject({ schemaVersion: 2, operatorSubjectKey: ACTOR,
        scope: { kind: 'finite_manifest', manifestSha256: hash(f.index.manifest) } });
    expect(result.population).toEqual({ authoritySha256: hash(result.authority), manifestSha256: hash(f.index.manifest) });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.authority.scope)).toBe(true);
    expect(Object.isFrozen(result.population)).toBe(true);
    expect(f.calls.map(x => x.key)).toEqual([listingHeadKey(TARGET), listingRevisionKey(TARGET, hash(f.revision)), listingHeadKey(TARGET)]);
    expect(f.calls[2].options.conditions).toEqual({ ifMatch: '"synthetic-2"' });
    expect(f.readCurrentIndex).toHaveBeenCalledTimes(2); expect(f.readEpoch).toHaveBeenCalledTimes(2);
    expect(f.streams.every(x => x.destroyed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sourceReferences');
    expect(JSON.stringify(result)).not.toContain(f.index.sourceReferences[0].accountKey);
    expect(f.container.listBlobsFlat).not.toHaveBeenCalled();
    f.container.getBlockBlobClient.mock.results.forEach(x => { expect(x.value.uploadData).not.toHaveBeenCalled(); expect(x.value.delete).not.toHaveBeenCalled(); });
});

test.each(['unknown operator', 'revoked', 'expired', 'future', 'restored'])('atomic state returns null for %s without constructing population authority', async kind => {
    const f = fixture(); let selected = query;
    if (kind === 'unknown operator') selected = { ...query, operatorSubjectKey: `${uid(1)}:${uid(99)}` };
    if (kind === 'revoked') f.revoke();
    if (kind === 'expired') { f.policy.validUntil = AT; f.install(); }
    if (kind === 'future') { f.policy.validFrom = '2026-10-20T08:00:00.000Z'; f.install(); }
    if (kind === 'restored') f.state.epoch = uid(99);
    await expect(f.reader.readApprovedState(selected)).resolves.toBeNull();
    expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

test('atomic state is freshly reread and revocation cannot reuse its previous pair', async () => {
    const f = fixture(), first = await f.reader.readApprovedState(query);
    const data = record(2), entry = { recordId: data.recordId, binding: { ...data.binding, tenantId: uid(97) } };
    f.index.manifest.entries.push(entry); f.index.sourceReferences.push({ entry: clone(entry), accountKey: 'starter-accounts/' + 'c'.repeat(64) }); f.index.revision++;
    const second = await f.reader.readApprovedState(query);
    expect(second.authority.maxRows).toBe(2); expect(second.authority).not.toEqual(first.authority);
    expect(second.population).toEqual({ authoritySha256: hash(second.authority), manifestSha256: hash(f.index.manifest) });
    expect(second.population).not.toEqual(first.population);
    expect(f.calls).toHaveLength(6); expect(f.readCurrentIndex).toHaveBeenCalledTimes(4); expect(f.readEpoch).toHaveBeenCalledTimes(4);
    f.revoke(); await expect(f.reader.readApprovedState(query)).resolves.toBeNull();
    expect(f.readCurrentIndex).toHaveBeenCalledTimes(4);
});

test.each(['revoked in final index read', 'index changed', 'epoch changed', 'invalid archive', 'source unavailable'])('atomic state withholds the entire pair when %s', async kind => {
    const f = fixture();
    if (kind === 'revoked in final index read') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 2) f.revoke(); };
    if (kind === 'index changed') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 2) f.index.revision++; };
    if (kind === 'epoch changed') f.state.epochHook = async () => { if (f.readEpoch.mock.calls.length === 2) f.state.epoch = uid(99); };
    if (kind === 'invalid archive') f.blobs.get(listingRevisionKey(TARGET, hash(f.revision))).text = '{}';
    if (kind === 'source unavailable') f.state.indexHook = async () => { throw new Error('synthetic unavailable'); };
    await expect(f.reader.readApprovedState(query)).rejects.toMatchObject(unavailable);
});

test('atomic state propagates cancellation and never completes a pair from a late source result', async () => {
    const f = fixture(), controller = new AbortController(); let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    f.state.indexHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.reader.readApprovedState(query, { signal: controller.signal });
    await started; const count = f.calls.length; controller.abort();
    await expect(pending).rejects.toMatchObject(unavailable);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(f.calls).toHaveLength(count); expect(f.readCurrentIndex).toHaveBeenCalledTimes(1);
});

test('atomic state rejects already aborted and spoofed signals before protected reads', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.reader.readApprovedState(query, { signal: controller.signal })).rejects.toMatchObject(unavailable);
    await expect(f.reader.readApprovedState(query, { signal: { aborted: false } })).rejects.toMatchObject(unavailable);
    expect(f.calls).toHaveLength(0); expect(f.readCurrentIndex).not.toHaveBeenCalled(); expect(f.readEpoch).not.toHaveBeenCalled();
});

test('atomic state preserves the source deadline without retrying or releasing a late pair', async () => {
    jest.useFakeTimers();
    try {
        const f = fixture(); let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        f.state.indexHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
        const pending = f.reader.readApprovedState(query), rejected = expect(pending).rejects.toMatchObject(unavailable);
        await started; const count = f.calls.length; await jest.advanceTimersByTimeAsync(1001); await rejected;
        release(); await Promise.resolve(); await Promise.resolve();
        expect(f.calls).toHaveLength(count); expect(f.readCurrentIndex).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});

test.each(['email', 'populationId', 'sourceBindingSha256', 'extra'])('caller cannot add %s to choose its authority source', async key => {
    const f = fixture(); await expect(f.reader.readApprovedAuthority({ ...query, [key]: 'injected' })).rejects.toMatchObject(unavailable);
    expect(f.calls).toHaveLength(0); expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

test('unknown operator returns no grant and never reads index or another policy', async () => {
    const f = fixture(); await expect(f.reader.readApprovedAuthority({ ...query, operatorSubjectKey: `${uid(1)}:${uid(99)}` })).resolves.toBeNull();
    expect(f.calls).toHaveLength(1); expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

test('ongoing approval issues stable decisions and refreshes at a window boundary; old decision is denied', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query);
    f.state.at = '2026-10-20T07:59:59.999Z'; await expect(f.reader.readApprovedAuthority(query)).resolves.toEqual(grant);
    f.state.at = '2026-10-20T08:00:00.000Z';
    const next = await f.reader.readApprovedAuthority(query); expect(next).not.toEqual(grant);
    await expect(f.reader.resolvePopulationBinding(grant)).rejects.toMatchObject(denied);
    await expect(f.reader.resolvePopulationBinding(next)).resolves.toMatchObject({ authoritySha256: hash(next) });
});

test.each(['revoked', 'expired', 'future', 'restored'])('%s policy releases no authority and does not read population', async kind => {
    const f = fixture();
    if (kind === 'revoked') f.revoke();
    if (kind === 'expired') { f.policy.validUntil = AT; f.install(); }
    if (kind === 'future') { f.policy.validFrom = '2026-10-20T08:00:00.000Z'; f.install(); }
    if (kind === 'restored') f.state.epoch = uid(99);
    await expect(f.reader.readApprovedAuthority(query)).resolves.toBeNull(); expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

test('grant never substitutes for current private approval after revocation', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query); f.revoke();
    await expect(f.reader.resolvePopulationBinding(grant)).rejects.toMatchObject(denied);
    await expect(f.reader.readApprovedIndex(grant)).rejects.toMatchObject(denied);
});

test.each(['policy rollback', 'policy equivocation', 'policy removed', 'index rollback', 'index equivocation', 'clock rollback'])('rejects observed %s', async kind => {
    const f = fixture(); await f.reader.readApprovedAuthority(query);
    if (kind === 'policy rollback') { f.revision.revision--; f.install(); }
    if (kind === 'policy equivocation') { f.revision.decisionReference = 'different'; f.install(); }
    if (kind === 'policy removed') f.blobs.delete(listingHeadKey(TARGET));
    if (kind === 'index rollback') f.index.revision--;
    if (kind === 'index equivocation') { f.index.manifest.entries = []; f.index.sourceReferences = []; }
    if (kind === 'clock rollback') f.state.at = '2026-10-20T07:29:59.999Z';
    await expect(f.reader.readApprovedAuthority(query)).rejects.toMatchObject(unavailable);
});

test.each(['policy revoked', 'policy revoked in final index read', 'index changed', 'epoch changed', 'decision window changed'])('%s during read prevents an older grant', async kind => {
    const f = fixture();
    if (kind === 'policy revoked') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 1) f.revoke(); };
    if (kind === 'policy revoked in final index read') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 2) f.revoke(); };
    if (kind === 'index changed') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 2) f.index.revision++; };
    if (kind === 'epoch changed') f.state.epochHook = async () => { if (f.readEpoch.mock.calls.length === 2) f.state.epoch = uid(99); };
    if (kind === 'decision window changed') f.state.indexHook = async () => { if (f.readCurrentIndex.mock.calls.length === 2) f.state.at = '2026-10-20T08:00:00.000Z'; };
    await expect(f.reader.readApprovedAuthority(query)).rejects.toMatchObject(unavailable);
});

test('new complete generation is automatically reflected; retained old grant cannot read the new population', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query);
    const data = record(2), entry = { recordId: data.recordId, binding: { ...data.binding, tenantId: uid(97) } };
    f.index.manifest.entries.push(entry); f.index.sourceReferences.push({ entry: clone(entry), accountKey: 'starter-accounts/' + 'c'.repeat(64) }); f.index.revision++;
    const next = await f.reader.readApprovedAuthority(query);
    expect(next.maxRows).toBe(2); expect(next.authorityRevision).not.toBe(grant.authorityRevision);
    await expect(f.reader.resolvePopulationBinding(grant)).rejects.toMatchObject(denied);
    await expect(f.reader.readApprovedIndex(next)).resolves.toEqual(f.index);
});

test.each(['policy', 'index'])('a concurrent read observing newer %s prevents an older in-flight release', async kind => {
    const f = fixture(); let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    f.state.epochHook = async () => { if (f.readEpoch.mock.calls.length === 2) { entered(); await held; } };
    const older = f.reader.readApprovedAuthority(query), rejected = expect(older).rejects.toMatchObject(unavailable);
    await started;
    if (kind === 'policy') { f.revision.revision++; f.install(); }
    else f.index.revision++;
    const newer = await f.reader.readApprovedAuthority(query); expect(newer).not.toBeNull();
    release(); await rejected;
});

test.each(['incomplete', 'foreign source', 'foreign provider', 'missing exact reference'])('%s index cannot become an approval', async kind => {
    const f = fixture();
    if (kind === 'incomplete') f.index.complete = false;
    if (kind === 'foreign source') f.index.sourceBindingSha256 = 'd'.repeat(64);
    if (kind === 'foreign provider') f.index.manifest.provider = 'external';
    if (kind === 'missing exact reference') f.index.sourceReferences = [];
    await expect(f.reader.readApprovedAuthority(query)).rejects.toMatchObject(unavailable);
});

test.each(['noncanonical', 'oversized', 'bad etag', 'wrong length', 'duplicate key', 'wrong digest', 'missing archive'])('rejects %s source record', async kind => {
    const f = fixture(), key = listingRevisionKey(TARGET, hash(f.revision)), stored = f.blobs.get(key);
    if (kind === 'noncanonical') stored.text = JSON.stringify(f.revision);
    if (kind === 'oversized') stored.response = { contentLength: 8193 };
    if (kind === 'bad etag') stored.etag = 'unquoted';
    if (kind === 'wrong length') stored.response = { contentLength: Buffer.byteLength(stored.text) + 1 };
    if (kind === 'duplicate key') stored.text = stored.text.replace('{', '{"schemaVersion":1,');
    if (kind === 'wrong digest') { const bad = clone(f.revision); bad.decisionReference = 'other'; stored.text = canonical(bad); }
    if (kind === 'missing archive') f.blobs.delete(key);
    await expect(f.reader.readApprovedAuthority(query)).rejects.toMatchObject(unavailable);
    expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

test('caller cancellation aborts a pending source read and prevents further work', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query), controller = new AbortController();
    let entered; const started = new Promise(resolve => { entered = resolve; });
    f.state.indexHook = async () => { entered(); await new Promise(() => {}); };
    const result = f.reader.readApprovedIndex(grant, { signal: controller.signal });
    await started; const calls = f.calls.length; controller.abort();
    await expect(result).rejects.toMatchObject(unavailable);
    expect(f.calls).toHaveLength(calls);
});

test('already aborted or spoofed signal cannot start source access', async () => {
    const f = fixture(), grant = await f.reader.readApprovedAuthority(query), count = f.calls.length;
    const controller = new AbortController(); controller.abort();
    await expect(f.reader.readApprovedIndex(grant, { signal: controller.signal })).rejects.toMatchObject(unavailable);
    await expect(f.reader.readApprovedIndex(grant, { signal: { aborted: false } })).rejects.toMatchObject(unavailable);
    expect(f.calls).toHaveLength(count);
});

test('bounded source timeout fails closed; no new storage read begins after its late completion', async () => {
    jest.useFakeTimers();
    try {
        const f = fixture(); let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        f.state.indexHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
        const result = f.reader.readApprovedAuthority(query), assertion = expect(result).rejects.toMatchObject(unavailable);
        await started; const count = f.calls.length; await jest.advanceTimersByTimeAsync(1001); await assertion;
        release(); await Promise.resolve(); await Promise.resolve(); expect(f.calls).toHaveLength(count);
    } finally { jest.useRealTimers(); }
});

test.each([
    ['missing source binding', c => { delete c.sourceBindingSha256; }],
    ['malformed source binding', c => { c.sourceBindingSha256 = 'not-a-digest'; }],
    ['wildcard population', c => { c.populationId = '*'; }],
    ['unknown provider', c => { c.provider = 'crm'; }],
    ['missing index reader', c => { c.readCurrentIndex = null; }],
    ['missing epoch reader', c => { c.readExternalRuntimeEpoch = null; }],
    ['unbounded request', c => { c.requestBudgetMs = 10001; }],
    ['extra authority', c => { c.approved = true; }],
    ['accessor callback', c => { Object.defineProperty(c, 'readCurrentIndex', { enumerable: true, get() { throw new Error('must not execute'); } }); }]
])('invalid %s configuration is rejected before source access', (_, mutate) => {
    const f = fixture(), config = { ...f.config }; mutate(config);
    expect(() => createDashboardAdminSignupListingReader(config)).toThrow('dashboard_admin_unavailable');
    expect(f.calls).toHaveLength(0); expect(f.readCurrentIndex).not.toHaveBeenCalled();
});

function publisherFixture(empty = false) {
    const f = fixture(), writes = [], permissions = [];
    if (empty) f.blobs.clear();
    const original = f.container.getBlockBlobClient.getMockImplementation();
    f.state.writeHook = null; f.state.approvalHook = null;
    f.container.getBlockBlobClient.mockImplementation(key => ({ ...original(key), uploadData: jest.fn(async (bytes, options) => {
        const value = JSON.parse(bytes.toString()), phase = key.startsWith('dashboard-admin-signup-policy-heads/') ? 'head' : 'archive';
        writes.push({ key, bytes, options, phase });
        if (f.state.writeHook) await f.state.writeHook(phase, 'before', value);
        const current = f.blobs.get(key);
        if (options.conditions.ifNoneMatch === '*' && current || options.conditions.ifMatch && current?.etag !== options.conditions.ifMatch)
            throw Object.assign(new Error('synthetic condition failed'), { statusCode: 412 });
        f.put(key, value);
        if (f.state.writeHook) await f.state.writeHook(phase, 'after', value);
    }) }));
    const { readCurrentIndex, ...base } = f.config;
    const authorisePublication = jest.fn(async input => { permissions.push(input); return f.state.approvalHook ? f.state.approvalHook(input) : true; });
    const config = { ...base, authorisePublication }, publisher = createDashboardAdminSignupListingPublisher(config);
    const next = clone(f.revision); next.revision = empty ? 0 : 3; next.changedAt = next.policy.approvedAt = f.state.at;
    next.policy.validFrom = f.state.at;
    const command = { record: next, expectedRevision: empty ? null : f.originalHead.revision,
        expectedRecordSha256: empty ? null : f.originalHead.recordSha256 };
    return { ...f, writes, permissions, publisher, publisherConfig: config, command, authorisePublication };
}

test.each([true, false])('publisher inspects then publishes exact approved %s-initial record with immutable archive and conditional head', async initial => {
    const f = publisherFixture(initial);
    await expect(f.publisher.inspect({ operatorSubjectKey: ACTOR })).resolves.toEqual({ expectedRevision: f.command.expectedRevision,
        expectedRecordSha256: f.command.expectedRecordSha256, restoreEpoch: EPOCH });
    expect(f.writes).toHaveLength(0); expect(f.authorisePublication).not.toHaveBeenCalled();
    const result = await f.publisher.publish(f.command);
    expect(result).toEqual({ schemaVersion: 1, targetSha256: hash(TARGET), revision: initial ? 0 : 3,
        recordSha256: hash(f.command.record), status: 'active' });
    expect(f.permissions.map(x => x.phase)).toEqual(['archive', 'head']);
    expect(f.permissions.every(x => Object.isFrozen(x.record.policy.auditPolicy))).toBe(true);
    expect(f.writes.map(x => x.options.conditions)).toEqual([{ ifNoneMatch: '*' }, initial ? { ifNoneMatch: '*' } : { ifMatch: '"synthetic-2"' }]);
    expect(f.writes.every(x => x.options.abortSignal instanceof AbortSignal && x.bytes.toString() === canonical(JSON.parse(x.bytes)))).toBe(true);
    await expect(f.reader.readApprovedAuthority(query)).resolves.toMatchObject({ authorityRevision: 11 + (initial ? -9 : 0) });
    const writeCount = f.writes.length, authCount = f.permissions.length;
    await expect(f.publisher.publish(f.command)).resolves.toEqual(result);
    expect(f.writes).toHaveLength(writeCount); expect(f.permissions).toHaveLength(authCount);
});

test('publisher supports an exact reviewed revocation without deleting old policy history', async () => {
    const f = publisherFixture(); f.command.record.status = 'revoked'; f.command.record.policy = null;
    f.command.record.decisionReference = 'synthetic-revocation';
    await expect(f.publisher.publish(f.command)).resolves.toMatchObject({ status: 'revoked', revision: 3 });
    await expect(f.reader.readApprovedAuthority(query)).resolves.toBeNull();
    expect(f.blobs.has(listingRevisionKey(TARGET, hash(f.revision)))).toBe(true);
});

test.each([false, undefined, null, 1, 'true', {}])('publisher requires literal true approval, not %p', async authority => {
    const f = publisherFixture(); f.state.approvalHook = () => authority;
    await expect(f.publisher.publish(f.command)).rejects.toMatchObject(denied);
    expect(f.writes).toHaveLength(0);
});

test('revoked publication permission between archive and head leaves the active head unchanged', async () => {
    const f = publisherFixture(); f.state.approvalHook = input => input.phase === 'archive';
    await expect(f.publisher.publish(f.command)).rejects.toMatchObject(denied);
    expect(f.writes.map(x => x.phase)).toEqual(['archive']);
    expect(JSON.parse(f.blobs.get(listingHeadKey(TARGET)).text)).toEqual(f.originalHead);
});

test.each(['wrong predecessor revision', 'wrong predecessor digest', 'skipped successor', 'wrong source', 'wrong epoch', 'future approval', 'expired policy', 'unexpected input'])('publication rejects %s before any write', async kind => {
    const f = publisherFixture();
    if (kind === 'wrong predecessor revision') f.command.expectedRevision--;
    if (kind === 'wrong predecessor digest') f.command.expectedRecordSha256 = 'c'.repeat(64);
    if (kind === 'skipped successor') f.command.record.revision++;
    if (kind === 'wrong source') f.command.record.sourceBindingSha256 = 'c'.repeat(64);
    if (kind === 'wrong epoch') f.command.record.restoreEpoch = uid(95);
    if (kind === 'future approval') f.command.record.changedAt = f.command.record.policy.approvedAt = f.command.record.policy.validFrom = '2026-10-20T08:00:00.000Z';
    if (kind === 'expired policy') { f.command.record.policy.validFrom = '2026-10-20T07:00:00.000Z';
        f.command.record.changedAt = f.command.record.policy.approvedAt = '2026-10-20T06:00:00.000Z'; f.command.record.policy.validUntil = AT; }
    if (kind === 'unexpected input') f.command.force = true;
    await expect(f.publisher.publish(f.command)).rejects.toBeInstanceOf(Error);
    expect(f.writes).toHaveLength(0);
});

test.each(['epoch', 'expiry'])('publication rechecks %s after approval callback before writing', async kind => {
    const f = publisherFixture(); f.command.record.policy.validUntil = '2026-10-20T07:45:00.000Z';
    f.state.approvalHook = () => { if (kind === 'epoch') f.state.epoch = uid(95); else f.state.at = f.command.record.policy.validUntil; return true; };
    await expect(f.publisher.publish(f.command)).rejects.toMatchObject({ statusCode: 409 }); expect(f.writes).toHaveLength(0);
});

test.each(['archive', 'head'])('uncertain %s acknowledgement reconciles only exact retained bytes', async phase => {
    const f = publisherFixture(); f.state.writeHook = (actual, position) => { if (actual === phase && position === 'after') throw new Error('synthetic lost acknowledgement'); };
    await expect(f.publisher.publish(f.command)).resolves.toMatchObject({ recordSha256: hash(f.command.record) });
    expect(f.writes.map(x => x.phase)).toEqual(['archive', 'head']);
});

test('racing publication cannot overwrite another head and preserves both immutable archives', async () => {
    const f = publisherFixture(), other = clone(f.command.record); other.decisionReference = 'synthetic-other-approval';
    f.state.approvalHook = input => { if (input.phase === 'head') f.install(other); return true; };
    await expect(f.publisher.publish(f.command)).rejects.toMatchObject({ statusCode: 409 });
    expect(JSON.parse(f.blobs.get(listingHeadKey(TARGET)).text).recordSha256).toBe(hash(other));
    expect(f.blobs.has(listingRevisionKey(TARGET, hash(f.command.record)))).toBe(true);
    expect(f.blobs.has(listingRevisionKey(TARGET, hash(other)))).toBe(true);
});

test('a missing acknowledgement with absent head is not reported as publication success', async () => {
    const f = publisherFixture(true); f.state.writeHook = (phase, when) => { if (phase === 'head' && when === 'before') throw new Error('synthetic transport failure'); };
    await expect(f.publisher.publish(f.command)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.blobs.has(listingHeadKey(TARGET))).toBe(false);
});

test('publication deadline prevents a late affirmative approval from writing anything', async () => {
    jest.useFakeTimers();
    try {
        const f = publisherFixture(); let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        f.state.approvalHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
        const result = f.publisher.publish(f.command), assertion = expect(result).rejects.toMatchObject(unavailable);
        await started; await jest.advanceTimersByTimeAsync(1001); await assertion;
        release(true); await Promise.resolve(); await Promise.resolve();
        expect(f.writes).toHaveLength(0);
    } finally { jest.useRealTimers(); }
});

test('publisher needs its explicit authoriser and does not expose publication through the reader', () => {
    const f = publisherFixture();
    expect(() => createDashboardAdminSignupListingPublisher({ ...f.publisherConfig, authorisePublication: undefined })).toThrow('dashboard_admin_unavailable');
    expect(Object.keys(f.reader)).toEqual(['readApprovedAuthority', 'readApprovedState', 'resolvePopulationBinding', 'readApprovedIndex']);
    expect(Object.keys(f.publisher)).toEqual(['inspect', 'publish']);
});
