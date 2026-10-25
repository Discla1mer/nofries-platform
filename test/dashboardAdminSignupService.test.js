'use strict';
const { createSignupListService, signupListInput } = require('../api/shared/dashboardAdmin/signupService');
const f = require('./fixtures/dashboardAdminSignupFixture');
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
function harness(overrides = {}) {
    const state = { grant: f.grant(), now: f.NOW };
    const ports = { authoriseSignupList: jest.fn(async () => state.grant), readSignupPage: jest.fn(async () => f.page()),
        audit: jest.fn(async event => f.ack(event)), clock: () => state.now, requestBudgetMs: 1000, ...overrides };
    return { state, ports, service: createSignupListService(ports) };
}
const list = h => h.service.list(f.principal, { cursor: null });
describe('separate dormant signup listing authority', () => {
    test('defaults absent reader/audit capability false; never calls a writer/provider', async () => {
        const h = harness({ readSignupPage: null, audit: null });
        expect(await h.service.capabilities(f.principal)).toEqual({ signupList: false });
        await expect(list(h)).rejects.toMatchObject({ statusCode: 503 });
        expect(Object.keys(h.service)).toEqual(['authorise', 'capabilities', 'list', 'authoriseDisclosure']);
    });
    test('requires distinct finite listing grant and exact durable attempt/outcome acknowledgements', async () => {
        const h = harness(), result = await list(h);
        expect(result).toMatchObject({ status: 'available', continuation: 'end', nextCursor: null });
        expect(h.ports.authoriseSignupList).toHaveBeenCalledTimes(4);
        expect(h.ports.authoriseSignupList).toHaveBeenCalledWith({ principal: f.principal, capability: 'signupList' });
        expect(h.ports.audit.mock.calls.map(([event]) => [event.phase, event.outcome, event.count])).toEqual([['attempt', 'requested', 0], ['outcome', 'available', 1]]);
        expect(JSON.stringify(h.ports.audit.mock.calls.map(([event]) => event))).not.toMatch(/person1|organisation 1|source-next|termsDigest/);
        expect(h.ports.readSignupPage.mock.calls[0][0]).toEqual({ authority: f.grant(), cursor: null, snapshotId: null, limit: 2 });
        expect(Object.isFrozen(result.rows[0])).toBe(true);
    });
    test.each([true, false, null, { lookup: true }, { ...f.grant(), capability: 'lookup' }])('diagnostic/invalid grant %p never reads', async grant => {
        const h = harness(); h.state.grant = grant;
        await expect(list(h)).rejects.toMatchObject({ statusCode: 403 }); expect(h.ports.readSignupPage).not.toHaveBeenCalled(); expect(h.ports.audit).not.toHaveBeenCalled();
    });
    test.each([
        ['operatorSubjectKey', f.TENANT + ':' + f.uid(99)], ['provider', 'customer'], ['tenantId', '*'], ['populationId', ''],
        ['indexId', ''], ['authorityRevision', -1], ['expiresAt', f.NOW], ['issuedAt', '2026-10-21T00:00:00.000Z'],
        ['expiresAt', '2026-10-20T09:00:00.000Z'], ['maxPageSize', 26], ['maxPageSize', 0], ['maxRows', 101], ['maxPages', 11],
        ['fields', ['email', 'diagnostics']], ['auditPolicyId', '']
    ])('rejects malformed authority %s=%p', async (key, value) => {
        const h = harness(); h.state.grant[key] = value; await expect(list(h)).rejects.toMatchObject({ statusCode: 403 }); expect(h.ports.readSignupPage).not.toHaveBeenCalled();
    });
    test.each(['email', 'external-customer', 'customer-bff'])('rejects %s session before policy', async provider => {
        const h = harness(); await expect(h.service.list({ ...f.principal, provider }, { cursor: null })).rejects.toMatchObject({ statusCode: 403 }); expect(h.ports.authoriseSignupList).not.toHaveBeenCalled();
    });
    test.each([{}, { cursor: '' }, { cursor: 'source-next' }, { cursor: null, limit: 1000 }, { cursor: null, populationId: '*' }])('rejects client input %p', input => {
        expect(() => signupListInput(input)).toThrow();
    });
    test.each([true, false, null, {}, { schemaVersion: 1, durable: true, eventSha256: 'a'.repeat(64) }, { schemaVersion: 1, durable: false, eventSha256: 'a'.repeat(64) }])('ambiguous attempt ack %p prevents source read', async ack => {
        const h = harness({ audit: jest.fn(async () => ack) }); await expect(list(h)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.ports.readSignupPage).not.toHaveBeenCalled(); expect(h.ports.audit).toHaveBeenCalledTimes(1);
    });
    test('failed/ambiguous outcome withholds buffered data without retry', async () => {
        const h = harness(); h.ports.audit.mockImplementation(async event => event.phase === 'attempt' ? f.ack(event) : undefined);
        await expect(list(h)).rejects.toMatchObject({ statusCode: 503 }); expect(h.ports.audit).toHaveBeenCalledTimes(2);
    });
    test.each(['throw', 'unknown', 'wrong-provider', 'stale', 'malformed'])('unavailable %s is audited, never empty success', async mode => {
        const h = harness(); h.ports.readSignupPage.mockImplementation(async () => {
            if (mode === 'throw') throw new Error('PRIVATE_RAW_DIAGNOSTIC');
            if (mode === 'unknown') return null;
            const p = f.page(); if (mode === 'wrong-provider') p.provider = 'external';
            if (mode === 'stale') p.observedAt = '2026-10-20T06:59:29.000Z';
            if (mode === 'malformed') p.records[0].account.value.secret = 'PRIVATE_RAW_DIAGNOSTIC'; return p;
        });
        expect(await list(h)).toEqual({ status: 'unavailable', rows: [], observedAt: null, nextCursor: null, continuation: 'unavailable' });
        expect(h.ports.audit.mock.calls.at(-1)[0].outcome).toBe('unavailable');
    });
    test.each(['attempt', 'read', 'outcome'])('revocation during %s stops disclosure', async where => {
        const h = harness();
        if (where === 'read') h.ports.readSignupPage.mockImplementation(async () => { h.state.grant = false; return f.page(); });
        else h.ports.audit.mockImplementation(async event => { if (event.phase === where) h.state.grant = false; return f.ack(event); });
        await expect(list(h)).rejects.toMatchObject({ statusCode: 403 });
        if (where === 'attempt') expect(h.ports.readSignupPage).not.toHaveBeenCalled();
    });
    test('changed valid grant during read is denied, not widened', async () => {
        const h = harness(); h.ports.readSignupPage.mockImplementation(async () => { h.state.grant = { ...h.state.grant, authorityRevision: 2 }; return f.page(); });
        await expect(list(h)).rejects.toMatchObject({ statusCode: 403 });
    });
    test('late reader is cancelled, cannot start outcome audit or release data', async () => {
        const pending = deferred(), h = harness({ requestBudgetMs: 20, readSignupPage: jest.fn(() => pending.promise) });
        await expect(list(h)).rejects.toMatchObject({ statusCode: 503 });
        expect(h.ports.readSignupPage.mock.calls[0][1].signal.aborted).toBe(true);
        pending.resolve(f.page()); await new Promise(resolve => setImmediate(resolve)); expect(h.ports.audit).toHaveBeenCalledTimes(1);
    });
    test('clock rollback and source aging during audit fail closed', async () => {
        const h = harness(); h.ports.audit.mockImplementation(async event => { if (event.phase === 'outcome') h.state.now = '2026-10-20T07:00:31.000Z'; return f.ack(event); });
        await expect(list(h)).rejects.toMatchObject({ statusCode: 503 });
        h.state.now = '2026-10-20T07:00:00.000Z'; await expect(list(h)).rejects.toMatchObject({ statusCode: 503 });
    });
});
describe('bounded authority-bound opaque pagination', () => {
    test('source cursor hidden; replay/tampering rejected; page snapshot bound', async () => {
        const h = harness(); h.ports.readSignupPage.mockResolvedValueOnce(f.page([f.record()], 'private-source-cursor')).mockResolvedValueOnce(f.page([f.record(2)]));
        const first = await list(h); expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(JSON.stringify(first)).not.toContain('private-source-cursor');
        await expect(h.service.list(f.principal, { cursor: 'x'.repeat(43) })).rejects.toMatchObject({ statusCode: 400 });
        expect((await h.service.list(f.principal, { cursor: first.nextCursor })).rows[0].email).toBe('person2@example.invalid');
        expect(h.ports.readSignupPage.mock.calls[1][0]).toMatchObject({ cursor: 'private-source-cursor', snapshotId: 'synthetic-snapshot-1' });
        await expect(h.service.list(f.principal, { cursor: first.nextCursor })).rejects.toMatchObject({ statusCode: 400 });
    });
    test.each(['actor', 'revision', 'population', 'provider', 'tenant', 'expiry'])('cursor cannot survive changed %s', async mode => {
        const h = harness(); h.ports.readSignupPage.mockResolvedValue(f.page([f.record()], 'next'));
        const first = await list(h); let actor = f.principal;
        if (mode === 'actor') { actor = { ...actor, subjectKey: f.TENANT + ':' + f.uid(99) }; h.state.grant.operatorSubjectKey = actor.subjectKey; }
        if (mode === 'revision') h.state.grant.authorityRevision++;
        if (mode === 'population') h.state.grant.populationId = 'other';
        if (mode === 'provider') h.state.grant.provider = 'external';
        if (mode === 'tenant') h.state.grant.tenantId = f.uid(99);
        if (mode === 'expiry') h.state.now = '2026-10-20T07:01:01.000Z';
        await expect(h.service.list(actor, { cursor: first.nextCursor })).rejects.toMatchObject({ statusCode: 400 });
        expect(h.ports.readSignupPage).toHaveBeenCalledTimes(1);
    });
    test.each(['snapshot', 'record', 'account', 'cursor-loop'])('conflicting continuation %s withholds whole page', async mode => {
        const h = harness(); h.ports.readSignupPage.mockResolvedValueOnce(f.page([f.record()], 'next'));
        const first = await list(h), p = f.page([f.record(2)]);
        if (mode === 'snapshot') p.snapshotId = 'other';
        if (mode === 'record') p.records[0].recordId = 'synthetic-record-1';
        if (mode === 'account') { p.records[0] = f.record(); p.records[0].recordId = 'distinct'; }
        if (mode === 'cursor-loop') p.nextCursor = 'next';
        h.ports.readSignupPage.mockResolvedValueOnce(p);
        expect(await h.service.list(f.principal, { cursor: first.nextCursor })).toMatchObject({ status: 'unavailable', rows: [], nextCursor: null });
    });
    test('finite row/page budget stops with truthful limit marker', async () => {
        const h = harness(); h.state.grant.maxRows = 3;
        h.ports.readSignupPage.mockResolvedValueOnce(f.page([f.record(), f.record(2)], 'next')).mockResolvedValueOnce(f.page([f.record(3)], 'more'));
        const first = await list(h), second = await h.service.list(f.principal, { cursor: first.nextCursor });
        expect(h.ports.readSignupPage.mock.calls[1][0].limit).toBe(1);
        expect(second).toMatchObject({ nextCursor: null, continuation: 'limit_reached' });
    });
});

test('disclosure receipt is private, one-use, same-authority and cannot be forged', async () => {
    const h = harness(), result = await list(h);
    await expect(h.service.authoriseDisclosure(f.principal, f.clone(result))).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.service.authoriseDisclosure(f.principal, result)).resolves.toBeUndefined();
    await expect(h.service.authoriseDisclosure(f.principal, result)).rejects.toMatchObject({ statusCode: 403 });
    const second = await list(h); h.state.grant = { ...h.state.grant, populationId: 'new-population' };
    await expect(h.service.authoriseDisclosure(f.principal, second)).rejects.toMatchObject({ statusCode: 403 });
});

test('finite continuation capacity never evicts valid handles or reads when already full', async () => {
    const h = harness(); h.ports.readSignupPage.mockResolvedValue(f.page([f.record()], 'next'));
    const first = await list(h);
    for (let i = 1; i < 256; i++) await list(h);
    await expect(list(h)).rejects.toMatchObject({ statusCode: 503 }); expect(h.ports.readSignupPage).toHaveBeenCalledTimes(256);
    h.ports.readSignupPage.mockResolvedValueOnce(f.page([f.record(2)]));
    expect((await h.service.list(f.principal, { cursor: first.nextCursor })).status).toBe('available');
});
