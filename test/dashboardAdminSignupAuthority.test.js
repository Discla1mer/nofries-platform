'use strict';

const { normaliseSignupAuthority, normaliseSignupManifest } = require('../api/shared/dashboardAdmin/signupAuthority');
const { createFiniteSignupPageReader } = require('../api/shared/dashboardAdmin/finiteSignupIndex');
const { projectSignupPage, projectSignupRecord } = require('../api/shared/dashboardAdmin/signupProjection');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const { hash, equal } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const f = require('./fixtures/dashboardAdminSignupFixture');
const clone = f.clone;
const later = seconds => new Date(Date.parse(f.NOW) + seconds * 1000).toISOString();

// Pure synthetic summaries for contract adversaries. Actual domain/store/native
// composition is exercised separately by the host fixture; these grant objects
// and independent resolver decisions are never production authorisation.
function multi(count = 3) {
    const records = Array.from({ length: count }, (_, i) => {
        const record = f.record(i + 1), tenantId = f.uid(1000 + i), subjectKey = tenantId + ':' + f.uid(2000 + i);
        record.binding.tenantId = tenantId; record.binding.subjectKey = subjectKey;
        for (const key of ['account', 'setup', 'acceptance', 'registration']) record[key].binding = clone(record.binding);
        record.account.value.identitySubjectKey = subjectKey;
        for (const key of ['acceptance', 'registration']) Object.assign(record[key].value, { tenantId, subjectKey });
        return record;
    });
    const manifest = { schemaVersion: 2, provider: 'legacy', populationId: 'synthetic-population', indexId: 'synthetic-index',
        entries: records.map(record => ({ recordId: record.recordId, binding: clone(record.binding) })) };
    const authority = f.grant(); delete authority.tenantId;
    Object.assign(authority, { schemaVersion: 2, scope: { kind: 'finite_manifest', manifestSha256: hash(manifest) } });
    const state = { authority, manifest, now: f.NOW, approval: { authoritySha256: hash(authority), manifestSha256: hash(manifest) } };
    const ports = { manifest, resolvePopulationBinding: jest.fn(async () => state.approval),
        readEntrySummary: jest.fn(async entry => ({ record: records.find(row => row.recordId === entry.recordId), observedAt: state.now })),
        clock: () => state.now, requestBudgetMs: 1000 };
    const reader = createFiniteSignupPageReader(ports), audit = jest.fn(async event => f.ack(event));
    const options = { authoriseSignupList: jest.fn(async () => state.authority), readSignupPage: reader, audit, clock: () => state.now };
    const service = createSignupListService(options);
    return { records, manifest, state, ports, reader, audit, options, service };
}
const query = h => ({ authority: h.state.authority, cursor: null, snapshotId: null, limit: 2 });
const read = h => h.reader(query(h));
const project = (page, h, extra = {}) => projectSignupPage(page, h.state.authority, { now: h.state.now, limit: 2, ...extra });
const list = h => h.service.list(f.principal, { cursor: null });

describe('closed additive signup authority and finite membership contracts', () => {
    test('v1 canonical receipts and exact single-tenant shape remain unchanged', () => {
        const authority = normaliseSignupAuthority(f.grant(), { actorSubjectKey: f.ACTOR, now: f.NOW });
        const record = f.record(), manifest = normaliseSignupManifest({ schemaVersion: 1, provider: 'legacy', tenantId: f.TENANT,
            populationId: 'synthetic-population', indexId: 'synthetic-index', entries: [{ recordId: record.recordId, binding: record.binding }] });
        expect(hash(authority)).toBe('00190378893ccc9ceddb4abd5c222bcc3f0b1e969640a09de0f81e72e26af620');
        expect(hash(manifest)).toBe('ac13666df39172fe44c25cd55ce538862de79361bef46efcf04cc21d1e50442d');
        expect(equal(authority, f.grant())).toBe(true); expect(authority).not.toHaveProperty('scope');
    });
    test('v2 detaches and freezes every finite scope/entry without I/O', () => {
        const h = multi(), a = normaliseSignupAuthority(h.state.authority), m = normaliseSignupManifest(h.manifest);
        h.state.authority.scope.manifestSha256 = '0'.repeat(64); h.manifest.entries[0].binding.tenantId = 'changed';
        expect(a.scope.manifestSha256).toBe(hash(m)); expect(Object.isFrozen(a.scope)).toBe(true);
        expect(Object.isFrozen(m.entries[0].binding)).toBe(true); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each([
        ['wildcard', a => { a.scope = { kind: 'all' }; }],
        ['scope extra', a => { a.scope.tenantId = '*'; }],
        ['digest', a => { a.scope.manifestSha256 = 'A'.repeat(64); }],
        ['absent scope', a => { delete a.scope; }],
        ['shared tenant', a => { a.tenantId = f.TENANT; }],
        ['foreign actor', a => { a.operatorSubjectKey = f.SUBJECT; }],
        ['not issued', a => { a.issuedAt = later(1); }],
        ['expired', a => { a.expiresAt = f.NOW; }],
        ['extended lifetime', a => { a.expiresAt = later(3600); }],
        ['wide rows', a => { a.maxRows = 101; }],
        ['wide page', a => { a.maxPageSize = 26; }],
        ['wide fields', a => { a.fields.push('subjectKey'); }]
    ])('rejects v2 %s', (_, mutate) => {
        const h = multi(); mutate(h.state.authority);
        expect(() => normaliseSignupAuthority(h.state.authority, { actorSubjectKey: f.ACTOR, now: f.NOW })).toThrow();
    });
    test.each([
        ['shared tenant', m => { m.tenantId = f.TENANT; }],
        ['wildcard tenant', m => { m.entries[1].binding.tenantId = '*'; }],
        ['foreign provider', m => { m.entries[1].binding.provider = 'external'; }],
        ['duplicate record', m => { m.entries[1].recordId = m.entries[0].recordId; }],
        ['account alias across tenant', m => { m.entries[1].binding.accountId = m.entries[0].binding.accountId; }],
        ['missing association', m => { delete m.entries[1].binding.setupRequestId; }],
        ['private field', m => { m.entries[1].binding.email = 'private@example.invalid'; }],
        ['sparse collection', m => { delete m.entries[0]; }],
        ['unbounded collection', m => { m.entries = Array.from({ length: 101 }, () => m.entries[0]); }]
    ])('rejects complete v2 manifest for %s before reading any entry', (_, mutate) => {
        const h = multi(); mutate(h.manifest);
        expect(() => createFiniteSignupPageReader(h.ports)).toThrow(); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('enforces the manifest byte budget even with valid individual field lengths and finite count', () => {
        const h = multi(100);
        h.manifest.entries.forEach((entry, i) => {
            entry.recordId = '😀'.repeat(88) + i;
            entry.binding.tenantId = '😀'.repeat(88) + i;
            entry.binding.organisationId = '😀'.repeat(88) + i;
        });
        expect(Buffer.byteLength(JSON.stringify(h.manifest))).toBeGreaterThan(131072);
        expect(() => normaliseSignupManifest(h.manifest)).toThrow();
        expect(() => createFiniteSignupPageReader(h.ports)).toThrow(); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('rejects proxies/accessors without executing them', () => {
        const h = multi(), getter = jest.fn(), trap = jest.fn();
        Object.defineProperty(h.state.authority.scope, 'manifestSha256', { enumerable: true, get: getter });
        expect(() => normaliseSignupAuthority(h.state.authority)).toThrow();
        expect(() => normaliseSignupManifest(new Proxy(h.manifest, { get: trap }))).toThrow();
        expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    });
});

describe('multi-tenant witness and exact ordered row membership', () => {
    test('real service traverses different tenant bindings and minimises browser rows/audit', async () => {
        const h = multi(), first = await list(h);
        expect(first.status).toBe('available'); expect(first.rows.map(row => row.email)).toEqual(['person1@example.invalid', 'person2@example.invalid']);
        const second = await h.service.list(f.principal, { cursor: first.nextCursor });
        expect(second.rows.map(row => row.email)).toEqual(['person3@example.invalid']); expect(second.continuation).toBe('end');
        expect(h.ports.readEntrySummary.mock.calls.map(([entry]) => entry.binding.tenantId)).toEqual(h.records.map(row => row.binding.tenantId));
        expect(JSON.stringify([first, second])).not.toMatch(/74000000|finite_manifest|manifestSha256|recordId|accountId|setupRequestId|termsDigest/);
        expect(JSON.stringify(h.audit.mock.calls.map(([event]) => event))).not.toMatch(/person[123]|Synthetic organisation|manifestSha256|recordId|accountId|setupRequestId|termsDigest/);
        await expect(h.service.authoriseDisclosure(f.principal, second)).resolves.toBeUndefined();
        await expect(h.service.authoriseDisclosure(f.principal, second)).rejects.toMatchObject({ statusCode: 403 });
    });
    test('empty approved manifest is truthful and bounded maximum remains supported', async () => {
        const empty = multi(0); expect(await list(empty)).toMatchObject({ status: 'available', rows: [], continuation: 'end' });
        expect(empty.ports.readEntrySummary).not.toHaveBeenCalled();
        expect((await read(multi(100))).records).toHaveLength(2);
    });
    test('an unavailable page still needs the exact witness and never carries rows or continuation', async () => {
        const h = multi(), page = clone(await read(h));
        Object.assign(page, { status: 'unavailable', records: [], nextCursor: null });
        expect(project(page, h)).toMatchObject({ status: 'unavailable', rows: [], nextCursor: null });
        const service = createSignupListService({ ...h.options, readSignupPage: async () => page });
        expect(await service.list(f.principal, { cursor: null })).toMatchObject({ status: 'unavailable', rows: [], continuation: 'unavailable' });
        page.manifest.entries.pop(); expect(() => project(page, h)).toThrow();
    });
    test.each([
        ['absent witness', p => { delete p.manifest; }],
        ['digest-only witness', p => { p.manifest = { manifestSha256: hash(p.manifest) }; }],
        ['changed witness binding', p => { p.manifest.entries[2].binding.organisationId = f.uid(999); }],
        ['reordered witness', p => { p.manifest.entries.reverse(); }],
        ['added witness member', p => { p.manifest.entries.push({ recordId: 'new', binding: f.record(4).binding }); }],
        ['missing row', p => { p.records.pop(); }],
        ['reordered rows', p => { p.records.reverse(); }],
        ['foreign row', p => { p.records[1] = f.record(99); }],
        ['omitted continuation', p => { p.nextCursor = null; }],
        ['skipping continuation', p => { p.nextCursor = p.nextCursor.replace(/:2$/, ':3'); }],
        ['wrong snapshot', p => { p.snapshotId = 'signup-index-v2:' + '0'.repeat(64); }],
        ['cross-version page', p => { p.schemaVersion = 1; }],
        ['shared tenant page', p => { p.tenantId = f.TENANT; }]
    ])('withholds page for %s', async (_, mutate) => {
        const h = multi(), page = clone(await read(h)); mutate(page);
        expect(() => project(page, h)).toThrow();
        const service = createSignupListService({ ...h.options, readSignupPage: async () => page });
        expect(await service.list(f.principal, { cursor: null })).toMatchObject({ status: 'unavailable', rows: [] });
        expect(h.audit.mock.calls.at(-1)[0]).toMatchObject({ outcome: 'unavailable', count: 0 });
    });
    test.each(['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey'])('a fully coherent foreign %s still cannot replace a manifest entry', async key => {
        const h = multi(), page = clone(await read(h)), record = page.records[1];
        const next = key === 'provider' ? 'external' : key === 'subjectKey' ? f.SUBJECT : f.uid(999);
        record.binding[key] = next;
        for (const name of ['account', 'setup', 'acceptance', 'registration']) record[name].binding[key] = next;
        if (['accountId', 'setupRequestId'].includes(key)) for (const name of ['account', 'setup']) record[name].value[key] = next;
        if (['tenantId', 'organisationId', 'subjectKey'].includes(key)) for (const name of ['acceptance', 'registration']) record[name].value[key] = next;
        if (key === 'subjectKey') record.account.value.identitySubjectKey = next;
        expect(() => projectSignupRecord(record, record.binding, f.NOW)).not.toThrow();
        expect(() => project(page, h)).toThrow();
    });
    test('wrong expected traversal offset rejects a genuine later slice', async () => {
        const h = multi(), first = await read(h), second = await h.reader({ ...query(h), cursor: first.nextCursor, snapshotId: first.snapshotId });
        expect(() => project(second, h)).toThrow();
        expect(project(second, h, { offset: 2, snapshotId: first.snapshotId }).rows[0].email).toBe('person3@example.invalid');
        expect(() => projectSignupRecord(h.records[0], h.state.authority, f.NOW)).toThrow(); // v2 digest alone is never a row scope
    });
    test.each([-1, -0, 0.5, 4, Infinity, '0'])('invalid expected offset %p is denied', async offset => {
        const h = multi(), page = await read(h); expect(() => project(page, h, { offset })).toThrow();
    });
    test('row/page bounds end honestly before the manifest ends', async () => {
        const h = multi(5); h.state.authority.maxRows = 3; h.state.approval.authoritySha256 = hash(h.state.authority);
        const first = await list(h), last = await h.service.list(f.principal, { cursor: first.nextCursor });
        expect(last).toMatchObject({ continuation: 'limit_reached', nextCursor: null }); expect(last.rows).toHaveLength(1);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(3);
    });
});

describe('multi-tenant authority revocation and version-pinned continuation', () => {
    test.each(['before', 'read', 'outcome', 'disclosure'])('membership revocation at %s prevents disclosure', async where => {
        const h = multi();
        if (where === 'before') h.state.approval = null;
        if (where === 'read') h.ports.readEntrySummary.mockImplementation(async () => { h.state.approval = null; return { record: h.records[0], observedAt: f.NOW }; });
        if (where === 'outcome') h.audit.mockImplementation(async event => { if (event.phase === 'outcome') h.state.authority = false; return f.ack(event); });
        if (where === 'disclosure') {
            const result = await list(h); h.state.authority.scope.manifestSha256 = '0'.repeat(64);
            await expect(h.service.authoriseDisclosure(f.principal, result)).rejects.toMatchObject({ statusCode: 403 });
        } else await expect(list(h)).rejects.toMatchObject({ statusCode: 403 });
        if (where === 'before') expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
        if (where === 'read') expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test.each(['digest', 'order', 'version'])('changed %s cannot reuse private or browser continuation', async change => {
        const h = multi(), firstSource = await read(h), first = await list(h);
        if (change === 'version') {
            const authority = f.grant(); h.state.authority = authority;
        } else {
            h.manifest.entries.reverse(); h.state.authority.scope.manifestSha256 = change === 'digest' ? '0'.repeat(64) : hash(h.manifest);
        }
        h.state.approval = { authoritySha256: hash(h.state.authority), manifestSha256: hash(h.manifest) };
        await expect(h.service.list(f.principal, { cursor: first.nextCursor })).rejects.toMatchObject({ statusCode: 400 });
        await expect(h.reader({ ...query(h), cursor: firstSource.nextCursor, snapshotId: firstSource.snapshotId })).rejects.toMatchObject({ statusCode: 403 });
    });
    test('source and snapshot prefixes cannot cross versions with an unchanged grant', async () => {
        const h = multi(), first = await read(h);
        for (const key of ['cursor', 'snapshotId']) {
            const next = { ...query(h), cursor: first.nextCursor, snapshotId: first.snapshotId };
            next[key] = next[key].replace('v2:', 'v1:');
            await expect(h.reader(next)).rejects.toMatchObject({ statusCode: 503 });
        }
    });
    test('cancelled read cannot continue to a second tenant or disclose a late page', async () => {
        const h = multi(), controller = new AbortController(); let resolve;
        h.ports.readEntrySummary.mockImplementation(() => new Promise(r => { resolve = r; }));
        const pending = h.reader(query(h), { signal: controller.signal });
        while (!resolve) await new Promise(r => setImmediate(r));
        controller.abort(); await expect(pending).rejects.toMatchObject({ statusCode: 503 });
        resolve({ record: h.records[0], observedAt: f.NOW }); await new Promise(r => setImmediate(r));
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1); expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(1);
    });
});
