'use strict';

const { performance } = require('node:perf_hooks');
const { createFiniteSignupPageReader } = require('../api/shared/dashboardAdmin/finiteSignupIndex');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const { projectSignupPage } = require('../api/shared/dashboardAdmin/signupProjection');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const f = require('./fixtures/dashboardAdminSignupFixture');
const unavailable = { statusCode: 503, code: 'dashboard_admin_unavailable' };
const denied = { statusCode: 403, code: 'dashboard_admin_access_denied' };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
const shift = seconds => new Date(Date.parse(f.NOW) + seconds * 1000).toISOString();

function manifest(records) {
    return { schemaVersion: 1, provider: 'legacy', tenantId: f.TENANT, populationId: 'synthetic-population',
        indexId: 'synthetic-index', entries: records.map(record => ({ recordId: record.recordId, binding: f.clone(record.binding) })) };
}
function harness(count = 3, overrides = {}) {
    const records = Array.from({ length: count }, (_, i) => f.record(i + 1));
    const index = manifest(records);
    const state = { grant: f.grant(), now: f.NOW,
        // A synthetic independent decision fixture, never a policy that echoes caller input.
        binding: { authoritySha256: hash(f.grant()), manifestSha256: hash(index) } };
    const ports = {
        manifest: index,
        resolvePopulationBinding: jest.fn(async () => state.binding),
        readEntrySummary: jest.fn(async entry => ({ record: records.find(row => row.recordId === entry.recordId), observedAt: state.now })),
        clock: () => state.now, requestBudgetMs: 1000, ...overrides
    };
    const read = createFiniteSignupPageReader(ports);
    return { records, index, state, ports, read };
}
function request(h, extra = {}) { return { authority: h.state.grant, cursor: null, snapshotId: null, limit: 2, ...extra }; }
const first = (h, extra, options) => h.read(request(h, extra), options);
function serviceHarness(count = 3) {
    const h = harness(count), events = [], order = [];
    h.ports.resolvePopulationBinding.mockImplementation(async () => { order.push('approval'); return h.state.binding; });
    h.ports.readEntrySummary.mockImplementation(async entry => {
        order.push(entry.recordId);
        return { record: h.records.find(row => row.recordId === entry.recordId), observedAt: h.state.now };
    });
    const audit = jest.fn(async event => { order.push(event.phase); events.push(event); return f.ack(event); });
    const authoriseSignupList = jest.fn(async () => h.state.grant);
    const service = createSignupListService({ readSignupPage: h.read, authoriseSignupList, audit, clock: () => h.state.now });
    return { ...h, service, events, order, audit, authoriseSignupList };
}

describe('dormant immutable finite signup manifest', () => {
    test('no default configuration, manifest, reader or approval', () => {
        expect(() => createFiniteSignupPageReader()).toThrow('dashboard_admin_unavailable');
        const h = harness();
        for (const key of ['manifest', 'resolvePopulationBinding', 'readEntrySummary', 'clock']) {
            const options = { ...h.ports }; delete options[key];
            expect(() => createFiniteSignupPageReader(options)).toThrow('dashboard_admin_unavailable');
        }
        expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled();
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each([null, false, 0, -1, 10001, 1.5, NaN, Infinity])('rejects explicit invalid budget %p', requestBudgetMs => {
        const h = harness();
        expect(() => createFiniteSignupPageReader({ ...h.ports, requestBudgetMs })).toThrow('dashboard_admin_unavailable');
    });
    test('rejects config and manifest accessors/proxies without invoking them', () => {
        const h = harness(), getter = jest.fn(), trap = jest.fn();
        const options = { ...h.ports };
        Object.defineProperty(options, 'manifest', { enumerable: true, get: getter });
        expect(() => createFiniteSignupPageReader(options)).toThrow();
        expect(() => createFiniteSignupPageReader(new Proxy(h.ports, { get: trap }))).toThrow();
        const index = f.clone(h.index);
        Object.defineProperty(index.entries[2].binding, 'accountId', { enumerable: true, get: getter });
        expect(() => createFiniteSignupPageReader({ ...h.ports, manifest: index })).toThrow();
        expect(() => createFiniteSignupPageReader({ ...h.ports, readEntrySummary: new Proxy(() => {}, { apply: trap }) })).toThrow();
        expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    });
    test.each([
        ['schema', m => { m.schemaVersion = 2; }],
        ['scope', m => { m.provider = 'customer'; }],
        ['wildcard', m => { m.populationId = '*'; }],
        ['unknown field', m => { m.approved = true; }],
        ['non-array', m => { m.entries = {}; }],
        ['oversize', m => { m.entries = Array.from({ length: 101 }, (_, i) => manifest([f.record(i + 1)]).entries[0]); }],
        ['duplicate record', m => { m.entries[2].recordId = m.entries[0].recordId; }],
        ['duplicate account', m => { m.entries[2].binding.accountId = m.entries[0].binding.accountId; }],
        ['late foreign tenant', m => { m.entries[2].binding.tenantId = f.uid(999); }],
        ['late foreign provider', m => { m.entries[2].binding.provider = 'external'; }],
        ['missing binding', m => { delete m.entries[2].binding.subjectKey; }],
        ['extra binding', m => { m.entries[2].binding.email = 'private@example.invalid'; }],
        ['noncanonical subject', m => { m.entries[2].binding.subjectKey = 'email@example.invalid'; }],
        ['noncanonical account', m => { m.entries[2].binding.accountId = 'account'; }],
        ['noncanonical setup', m => { m.entries[2].binding.setupRequestId = 'setup'; }],
        ['empty organisation', m => { m.entries[2].binding.organisationId = ''; }],
        ['unbounded record', m => { m.entries[2].recordId = 'x'.repeat(181); }],
        ['sparse entries', m => { delete m.entries[1]; }]
    ])('rejects entire manifest for %s, including entries beyond first page', (_, mutate) => {
        const h = harness(); mutate(h.index);
        expect(() => createFiniteSignupPageReader(h.ports)).toThrow('dashboard_admin_unavailable');
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('finite maximum is accepted; repeated subjects/emails are not deduplicated', async () => {
        const h = harness(100);
        h.records[1].account.value.email = h.records[0].account.value.email;
        const page = await first(h);
        expect(page.records).toHaveLength(2);
        expect(page.records[0].binding.subjectKey).toBe(page.records[1].binding.subjectKey);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(2);
    });
    test('copies construction inputs and freezes the exact entries, grant and output', async () => {
        const h = harness(), original = f.clone(h.index);
        h.index.entries.reverse(); h.index.entries[0].binding.accountId = f.uid(999);
        const page = await first(h);
        expect(page.snapshotId).toBe('signup-index-v1:' + hash(original));
        expect(h.ports.readEntrySummary.mock.calls.map(([entry]) => entry.recordId)).toEqual(['synthetic-record-1', 'synthetic-record-2']);
        for (const [entry, options] of h.ports.readEntrySummary.mock.calls) {
            expect(Object.isFrozen(entry)).toBe(true); expect(Object.isFrozen(entry.binding)).toBe(true);
            expect(Object.keys(entry)).toEqual(['binding', 'recordId']);
            expect(Object.keys(options)).toEqual(['signal']); expect(options.signal.aborted).toBe(true);
        }
        expect(Object.isFrozen(h.ports.resolvePopulationBinding.mock.calls[0][0].fields)).toBe(true);
        expect(Object.isFrozen(page.records[0].account.value)).toBe(true);
        h.records[0].account.value.organisation = 'Changed source after return';
        expect(page.records[0].account.value.organisation).toBe('Synthetic organisation 1');
    });
});

describe('independent current population approval and private finite continuation', () => {
    test.each([null, false, true, {}, { lookup: true }, { authoritySha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) }])(
        'absent/invalid binding %p stops before every evidence read', async binding => {
            const h = harness(); h.state.binding = binding;
            await expect(first(h)).rejects.toMatchObject(denied);
            expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
        });
    test.each(['authoritySha256', 'manifestSha256', 'extra'])('wrong/ambiguous binding %s is denied', async key => {
        const h = harness(); h.state.binding[key] = 'd'.repeat(64);
        await expect(first(h)).rejects.toMatchObject(denied); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each([
        ['schemaVersion', 2], ['capability', 'lookup'], ['operatorSubjectKey', 'email@example.invalid'],
        ['provider', 'external'], ['tenantId', f.uid(99)], ['populationId', 'other'], ['indexId', 'other'],
        ['authorityRevision', -1], ['issuedAt', shift(1)], ['expiresAt', f.NOW], ['expiresAt', shift(7200)],
        ['maxPageSize', 26], ['maxRows', 101], ['maxPages', 11], ['fields', ['email']], ['auditPolicyId', '']
    ])('rejects malformed or incompatible full grant %s', async (key, value) => {
        const h = harness(); h.state.grant[key] = value;
        await expect(first(h)).rejects.toMatchObject(denied); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each(['operatorSubjectKey', 'authorityRevision', 'auditPolicyId', 'maxPages'])('valid changed %s still requires a new exact approval binding', async key => {
        const h = harness();
        h.state.grant[key] = key === 'operatorSubjectKey' ? f.TENANT + ':' + f.uid(99) :
            key === 'auditPolicyId' ? 'other-policy' : h.state.grant[key] + 1;
        await expect(first(h)).rejects.toMatchObject(denied); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each(['order', 'membership', 'binding'])('same population/index IDs with changed %s cannot reuse approval', async mode => {
        const h = harness();
        if (mode === 'order') h.index.entries.reverse();
        if (mode === 'membership') h.index.entries.push(manifest([f.record(4)]).entries[0]);
        if (mode === 'binding') h.index.entries[0].binding.organisationId = f.uid(99);
        h.read = createFiniteSignupPageReader(h.ports);
        await expect(first(h)).rejects.toMatchObject(denied); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('paginates only the finite ordered slice, without enumeration or skipping', async () => {
        const h = harness(), page1 = await first(h);
        const page2 = await first(h, { cursor: page1.nextCursor, snapshotId: page1.snapshotId });
        expect(page1.records.map(row => row.recordId)).toEqual(['synthetic-record-1', 'synthetic-record-2']);
        expect(page2.records.map(row => row.recordId)).toEqual(['synthetic-record-3']);
        expect(page2.nextCursor).toBeNull(); expect(page2.snapshotId).toBe(page1.snapshotId);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(3);
    });
    test.each(['missing snapshot', 'wrong snapshot', 'offset zero', 'leading zero', 'out of range', 'wrong digest', 'wrong type', 'extra field'])(
        'rejects %s continuation before I/O', async mode => {
            const h = harness(), page = await first(h);
            const next = { cursor: page.nextCursor, snapshotId: page.snapshotId };
            if (mode === 'missing snapshot') next.snapshotId = null;
            if (mode === 'wrong snapshot') next.snapshotId = 'other';
            if (mode === 'offset zero') next.cursor = next.cursor.replace(/:2$/, ':0');
            if (mode === 'leading zero') next.cursor = next.cursor.replace(/:2$/, ':02');
            if (mode === 'out of range') next.cursor = next.cursor.replace(/:2$/, ':100');
            if (mode === 'wrong digest') next.cursor = next.cursor.replace(/[a-f0-9]{64}/, '0'.repeat(64));
            if (mode === 'wrong type') next.cursor = [];
            if (mode === 'extra field') next.populationId = '*';
            h.ports.readEntrySummary.mockClear(); h.ports.resolvePopulationBinding.mockClear();
            await expect(first(h, next)).rejects.toMatchObject(unavailable);
            expect(h.ports.readEntrySummary).not.toHaveBeenCalled(); expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled();
        });
    test('old continuation cannot select a replaced manifest even with a new current binding', async () => {
        const h = harness(), page = await first(h);
        h.index.entries.reverse(); h.state.binding.manifestSha256 = hash(h.index);
        h.read = createFiniteSignupPageReader(h.ports); h.ports.readEntrySummary.mockClear();
        await expect(first(h, { cursor: page.nextCursor, snapshotId: page.snapshotId })).rejects.toMatchObject(unavailable);
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
        expect((await first(h)).records[0].recordId).toBe('synthetic-record-3');
    });
    test('old source cursor is also pinned to the complete grant digest', async () => {
        const h = harness(), page = await first(h);
        h.state.grant.authorityRevision++; h.state.binding.authoritySha256 = hash(h.state.grant); h.ports.readEntrySummary.mockClear();
        await expect(first(h, { cursor: page.nextCursor, snapshotId: page.snapshotId })).rejects.toMatchObject(unavailable);
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test.each([0, -1, 3, 1.5, '2', null])('invalid requested limit %p performs no read', async limit => {
        const h = harness(); await expect(first(h, { limit })).rejects.toMatchObject(unavailable);
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
});

describe('exact summary association and honest observation times', () => {
    test('unknown/unavailable facts are preserved; verified empty is distinct', async () => {
        const h = harness(1);
        h.records[0].account = { state: 'unknown' }; h.records[0].setup = { state: 'unavailable' };
        const page = await first(h), projected = projectSignupPage(page, h.state.grant, { now: f.NOW, limit: 2 });
        expect(projected.rows[0]).toMatchObject({ email: null, organisation: null, milestones: {
            accountSaved: { status: 'unknown', at: null }, setupSaved: { status: 'unavailable', at: null }
        } });
        const empty = harness(0), result = await first(empty);
        expect(result).toMatchObject({ status: 'available', records: [], nextCursor: null, observedAt: f.NOW });
        expect(empty.ports.readEntrySummary).not.toHaveBeenCalled(); expect(empty.ports.resolvePopulationBinding).toHaveBeenCalledTimes(2);
        empty.state.binding = null;
        await expect(first(empty)).rejects.toMatchObject(denied);
    });
    test.each([
        ['missing record', () => ({ record: null, observedAt: f.NOW })],
        ['absent evidence', () => undefined],
        ['foreign record', () => ({ record: f.record(99), observedAt: f.NOW })],
        ['different subject', () => { const record = f.record(); record.binding.subjectKey = f.TENANT + ':' + f.uid(99); return { record, observedAt: f.NOW }; }],
        ['wrong fact association', () => { const record = f.record(); record.account.binding.accountId = f.uid(99); return { record, observedAt: f.NOW }; }],
        ['missing fact', () => { const record = f.record(); delete record.setup; return { record, observedAt: f.NOW }; }],
        ['raw diagnostic', () => ({ record: f.record(), observedAt: f.NOW, diagnostic: 'PRIVATE' })],
        ['raw proof', () => { const record = f.record(); record.setup.value.proof = 'PRIVATE'; return { record, observedAt: f.NOW }; }]
    ])('withholds whole page for %s and never skips to the next entry', async (_, evidence) => {
        const h = harness(); h.ports.readEntrySummary.mockImplementation(async () => evidence());
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test.each([shift(1), shift(-31), 'not-a-time', undefined])('rejects future/stale/invalid observation %p', async observedAt => {
        const h = harness(); h.ports.readEntrySummary.mockResolvedValue({ record: f.record(), observedAt });
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test('uses the oldest actual observation, not completion time', async () => {
        const h = harness();
        h.ports.readEntrySummary.mockImplementation(async entry => {
            h.state.now = shift(5);
            return { record: h.records.find(row => row.recordId === entry.recordId), observedAt: entry.recordId.endsWith('1') ? shift(-20) : shift(2) };
        });
        const page = await first(h);
        expect(page.observedAt).toBe(shift(-20)); expect(page.records).toHaveLength(2);
    });
    test('future evidence at receipt cannot age into validity during post-read approval', async () => {
        const h = harness();
        h.ports.readEntrySummary.mockResolvedValue({ record: f.record(), observedAt: shift(1) });
        h.ports.resolvePopulationBinding.mockImplementation(async () => {
            if (h.ports.readEntrySummary.mock.calls.length) h.state.now = shift(2);
            return h.state.binding;
        });
        await expect(first(h)).rejects.toMatchObject(unavailable);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
        expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(1);
    });
    test('captures the returned evidence before awaiting post-read approval', async () => {
        const h = harness(1), raw = { record: f.record(), observedAt: f.NOW };
        h.ports.readEntrySummary.mockResolvedValue(raw);
        h.ports.resolvePopulationBinding.mockImplementation(async () => {
            if (h.ports.readEntrySummary.mock.calls.length) raw.record.account.value.organisation = 'Mutated during approval';
            return h.state.binding;
        });
        expect((await first(h)).records[0].account.value.organisation).toBe('Synthetic organisation 1');
    });
    test('later milestone beyond the oldest observation invalidates the whole page', async () => {
        const h = harness(); h.records[1].acceptance.value.acceptedAt = Date.parse(shift(-5));
        h.ports.readEntrySummary.mockImplementation(async entry => ({
            record: h.records.find(row => row.recordId === entry.recordId), observedAt: entry.recordId.endsWith('1') ? shift(-10) : f.NOW
        }));
        await expect(first(h)).rejects.toMatchObject(unavailable);
    });
    test('aging during post-read approval prevents starting another read', async () => {
        const h = harness();
        h.ports.readEntrySummary.mockResolvedValue({ record: f.record(), observedAt: shift(-20) });
        h.ports.resolvePopulationBinding.mockImplementation(async () => {
            if (h.ports.readEntrySummary.mock.calls.length) h.state.now = shift(11);
            return h.state.binding;
        });
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test('verified empty cannot be stamped fresh after a slow approval', async () => {
        const h = harness(0);
        h.ports.resolvePopulationBinding.mockImplementation(async () => { h.state.now = shift(31); return h.state.binding; });
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('safe-copy rejects evidence accessors/proxies without evaluating them', async () => {
        const h = harness(), getter = jest.fn(), trap = jest.fn();
        const evidence = { record: f.record(), observedAt: f.NOW };
        Object.defineProperty(evidence.record.account.value, 'email', { enumerable: true, get: getter });
        h.ports.readEntrySummary.mockResolvedValue(evidence);
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(getter).not.toHaveBeenCalled();
        h.ports.readEntrySummary.mockResolvedValue({ record: new Proxy({}, { get: trap }), observedAt: f.NOW });
        await expect(first(h)).rejects.toMatchObject(unavailable); expect(trap).not.toHaveBeenCalled();
    });
});

describe('revocation, bounded waiting and cancellation', () => {
    test.each([1, 2, 3, 4])('approval denial at boundary %i stops later reads', async boundary => {
        const h = harness();
        h.ports.resolvePopulationBinding.mockImplementation(async () =>
            h.ports.resolvePopulationBinding.mock.calls.length === boundary ? null : h.state.binding);
        await expect(first(h)).rejects.toMatchObject(denied);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(Math.min(boundary - 1, 2));
        expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(boundary);
    });
    test('current grant change during evidence await is denied after that one read', async () => {
        const h = harness();
        h.ports.readEntrySummary.mockImplementation(async () => {
            h.state.grant.authorityRevision++; h.state.binding.authoritySha256 = hash(h.state.grant);
            return { record: f.record(), observedAt: f.NOW };
        });
        await expect(first(h)).rejects.toMatchObject(denied); expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test.each(['approval', 'read'])('expiry during %s prevents subsequent evidence calls', async where => {
        const h = harness();
        const expire = () => { h.state.now = h.state.grant.expiresAt; };
        if (where === 'approval') h.ports.resolvePopulationBinding.mockImplementation(async () => { expire(); return h.state.binding; });
        else h.ports.readEntrySummary.mockImplementation(async () => { expire(); return { record: f.record(), observedAt: f.NOW }; });
        await expect(first(h)).rejects.toMatchObject(denied);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(where === 'approval' ? 0 : 1);
    });
    test.each(['approval', 'read'])('clock rollback during %s stops', async where => {
        const h = harness();
        if (where === 'approval') h.ports.resolvePopulationBinding.mockImplementation(async () => { h.state.now = shift(-1); return h.state.binding; });
        else h.ports.readEntrySummary.mockImplementation(async () => { h.state.now = shift(-1); return { record: f.record(), observedAt: h.state.now }; });
        await expect(first(h)).rejects.toMatchObject(unavailable);
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(where === 'approval' ? 0 : 1);
    });
    describe('deterministic deadline scheduling', () => {
        let elapsed, monotonicClock;
        beforeEach(() => {
            jest.useFakeTimers({ doNotFake: ['performance', 'setImmediate'] });
            elapsed = 0;
            monotonicClock = jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
        });
        afterEach(() => { monotonicClock.mockRestore(); jest.useRealTimers(); });

        test.each(['approval', 'read'])('hung %s is bounded; late success starts no further call', async where => {
            const pending = deferred(), entered = deferred(), h = harness(3, { requestBudgetMs: 20 });
            const target = where === 'approval' ? h.ports.resolvePopulationBinding : h.ports.readEntrySummary;
            target.mockImplementation(() => { entered.resolve(); return pending.promise; });
            const result = first(h), assertion = expect(result).rejects.toMatchObject(unavailable);
            await entered.promise;
            const calls = where === 'approval' ? [1, 0] : [1, 1];
            expect([h.ports.resolvePopulationBinding.mock.calls.length, h.ports.readEntrySummary.mock.calls.length]).toEqual(calls);
            expect(target.mock.calls[0][1].signal.aborted).toBe(false);
            elapsed = 20;
            await jest.advanceTimersByTimeAsync(20);
            await assertion;
            expect(target.mock.calls[0][1].signal.aborted).toBe(true);
            pending.resolve(where === 'approval' ? h.state.binding : { record: f.record(), observedAt: f.NOW }); await settle();
            expect([h.ports.resolvePopulationBinding.mock.calls.length, h.ports.readEntrySummary.mock.calls.length]).toEqual(calls);
        });

        test.each(['dispatch', 'approval'])('deadline reached during %s stops before evidence I/O', async where => {
            const h = harness(3, { requestBudgetMs: 20 });
            if (where === 'approval') h.ports.resolvePopulationBinding.mockImplementation(async () => {
                elapsed = 20; return h.state.binding;
            });
            const result = first(h);
            if (where === 'dispatch') elapsed = 20;
            await expect(result).rejects.toMatchObject(unavailable);
            expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(where === 'dispatch' ? 0 : 1);
            expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
            for (const [, options] of h.ports.resolvePopulationBinding.mock.calls) expect(options.signal.aborted).toBe(true);
        });
    });
    test.each(['before', 'approval', 'read'])('external cancellation %s stops and cancels the supplied signal', async where => {
        const pending = deferred(), h = harness(), controller = new AbortController();
        if (where === 'before') controller.abort();
        if (where === 'approval') h.ports.resolvePopulationBinding.mockImplementation(() => pending.promise);
        if (where === 'read') h.ports.readEntrySummary.mockImplementation(() => pending.promise);
        const result = first(h, undefined, { signal: controller.signal });
        const assertion = expect(result).rejects.toMatchObject(unavailable);
        await settle(); controller.abort(); await assertion;
        const calls = [h.ports.resolvePopulationBinding.mock.calls.length, h.ports.readEntrySummary.mock.calls.length];
        expect(calls).toEqual(where === 'before' ? [0, 0] : where === 'approval' ? [1, 0] : [1, 1]);
        for (const [, options] of [...h.ports.resolvePopulationBinding.mock.calls, ...h.ports.readEntrySummary.mock.calls])
            expect(options.signal.aborted).toBe(true);
        pending.resolve(where === 'approval' ? h.state.binding : { record: f.record(), observedAt: f.NOW }); await settle();
        expect([h.ports.resolvePopulationBinding.mock.calls.length, h.ports.readEntrySummary.mock.calls.length]).toEqual(calls);
    });
    test('does not invoke hostile input or signal accessors', async () => {
        const h = harness(), getter = jest.fn(), input = request(h), options = {};
        Object.defineProperty(input, 'authority', { enumerable: true, get: getter });
        Object.defineProperty(options, 'signal', { enumerable: true, get: getter });
        await expect(h.read(input)).rejects.toMatchObject(unavailable);
        await expect(first(h, undefined, options)).rejects.toMatchObject(unavailable);
        await expect(first(h, undefined, { signal: { aborted: false } })).rejects.toMatchObject(unavailable);
        expect(getter).not.toHaveBeenCalled(); expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled();
    });
    test.each(['aborted', 'reason', 'addEventListener', 'removeEventListener'])('rejects a native signal with shadowed %s before I/O', async key => {
        const h = harness(), controller = new AbortController(), getter = jest.fn(() => { throw new Error('PRIVATE'); });
        Object.defineProperty(controller.signal, key, { get: getter });
        await expect(first(h, undefined, { signal: controller.signal })).rejects.toMatchObject(unavailable);
        expect(getter).not.toHaveBeenCalled();
        expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled(); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('rejects shadowed no-op listener registration instead of losing cancellation', async () => {
        const h = harness(), controller = new AbortController(), listener = jest.fn();
        Object.defineProperty(controller.signal, 'addEventListener', { value: listener });
        await expect(first(h, undefined, { signal: controller.signal })).rejects.toMatchObject(unavailable);
        expect(listener).not.toHaveBeenCalled(); expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled();
    });
    test('sampling the original native signal prevents a later false aborted shadow from hiding cancellation', async () => {
        const h = harness(), pending = deferred(), controller = new AbortController();
        h.ports.resolvePopulationBinding.mockImplementationOnce(() => pending.promise);
        const result = first(h, undefined, { signal: controller.signal });
        const outcome = result.then(value => ({ value }), error => ({ error }));
        await settle();
        Object.defineProperty(controller.signal, 'aborted', { value: false });
        controller.abort();
        pending.resolve(h.state.binding);
        expect(await outcome).toMatchObject({ error: unavailable });
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
        expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(1);
        expect(h.ports.resolvePopulationBinding.mock.calls[0][1].signal.aborted).toBe(true);
    });
    test('private native dependent signal survives later caller method changes and stopped propagation', async () => {
        const h = harness(), pending = deferred(), controller = new AbortController(), shadow = jest.fn();
        controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
        h.ports.readEntrySummary.mockImplementation(() => pending.promise);
        const result = first(h, undefined, { signal: controller.signal });
        const assertion = expect(result).rejects.toMatchObject(unavailable);
        await settle();
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
        for (const key of ['addEventListener', 'removeEventListener'])
            Object.defineProperty(controller.signal, key, { get: shadow });
        controller.abort(); await assertion;
        expect(h.ports.readEntrySummary.mock.calls[0][1].signal.aborted).toBe(true);
        pending.resolve({ record: f.record(), observedAt: f.NOW }); await settle();
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
        expect(h.ports.resolvePopulationBinding).toHaveBeenCalledTimes(1); expect(shadow).not.toHaveBeenCalled();
    });
});

describe('real listing service retains audit, traversal and disclosure controls', () => {
    test('acknowledged attempt precedes all index reads; only projected rows and browser handles leave service', async () => {
        const h = serviceHarness(), result = await h.service.list(f.principal, { cursor: null });
        expect(h.order[0]).toBe('attempt'); expect(h.order.at(-1)).toBe('outcome');
        expect(h.events.map(e => [e.phase, e.outcome, e.count])).toEqual([['attempt', 'requested', 0], ['outcome', 'available', 2]]);
        expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(JSON.stringify(result)).not.toMatch(/signup-index|recordId|subjectKey|tenantId|termsDigest|synthetic-audit/);
        expect(JSON.stringify(h.events)).not.toMatch(/person1|organisation 1|signup-index|termsDigest/);
        await h.service.authoriseDisclosure(f.principal, result);
        await expect(h.service.authoriseDisclosure(f.principal, result)).rejects.toMatchObject(denied);
        const next = await h.service.list(f.principal, { cursor: result.nextCursor });
        expect(next.rows.map(row => row.email)).toEqual(['person3@example.invalid']); expect(next.continuation).toBe('end');
    });
    test.each(['rows', 'pages'])('finite manifest larger than traversal %s limit remains truthfully limited', async mode => {
        const h = serviceHarness(5);
        if (mode === 'pages') h.state.grant.maxPages = 1;
        h.state.binding.authoritySha256 = hash(h.state.grant);
        let result = await h.service.list(f.principal, { cursor: null });
        if (mode === 'rows') result = await h.service.list(f.principal, { cursor: result.nextCursor });
        expect(result).toMatchObject({ status: 'available', continuation: 'limit_reached', nextCursor: null });
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(mode === 'rows' ? 4 : 2);
    });
    test('ambiguous attempt ack prevents even manifest approval resolution', async () => {
        const h = serviceHarness(); h.audit.mockResolvedValue(true);
        await expect(h.service.list(f.principal, { cursor: null })).rejects.toMatchObject(unavailable);
        expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled(); expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('failed exact entry records unavailable outcome, never successful empty', async () => {
        const h = serviceHarness(); h.ports.readEntrySummary.mockResolvedValue(null);
        expect(await h.service.list(f.principal, { cursor: null })).toEqual({
            status: 'unavailable', rows: [], observedAt: null, nextCursor: null, continuation: 'unavailable'
        });
        expect(h.events.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'unavailable', count: 0 });
        expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(1);
    });
    test('population denial records denied outcome and discloses nothing', async () => {
        const h = serviceHarness(); h.state.binding = null;
        await expect(h.service.list(f.principal, { cursor: null })).rejects.toMatchObject(denied);
        expect(h.events.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'denied', count: 0 });
        expect(h.ports.readEntrySummary).not.toHaveBeenCalled();
    });
    test('outcome ack failure withholds buffered rows without retry', async () => {
        const h = serviceHarness(); h.audit.mockImplementation(async event => event.phase === 'attempt' ? f.ack(event) : true);
        await expect(h.service.list(f.principal, { cursor: null })).rejects.toMatchObject(unavailable);
        expect(h.audit).toHaveBeenCalledTimes(2); expect(h.ports.readEntrySummary).toHaveBeenCalledTimes(2);
    });
    test.each(['outcome', 'disclosure'])('shared current approval revocation during %s withholds rows', async where => {
        const h = serviceHarness();
        // Future host MUST connect service policy and index binding to the same current approval.
        h.authoriseSignupList.mockImplementation(async () => h.state.binding ? h.state.grant : false);
        if (where === 'outcome') {
            h.audit.mockImplementation(async event => { if (event.phase === 'outcome') h.state.binding = null; return f.ack(event); });
            await expect(h.service.list(f.principal, { cursor: null })).rejects.toMatchObject(denied);
        } else {
            const result = await h.service.list(f.principal, { cursor: null }); h.state.binding = null;
            await expect(h.service.authoriseDisclosure(f.principal, result)).rejects.toMatchObject(denied);
        }
    });
    test('ordinary customer principal cannot reach library or audit', async () => {
        const h = serviceHarness();
        await expect(h.service.list({ ...f.principal, provider: 'customer' }, { cursor: null })).rejects.toMatchObject(denied);
        expect(h.audit).not.toHaveBeenCalled(); expect(h.ports.resolvePopulationBinding).not.toHaveBeenCalled();
    });
});
