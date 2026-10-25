'use strict';

const { createDashboardAdminSignupRuntime } = require('../api/shared/dashboardAdmin/signupAuditRuntimeAdapter');
const { createSignupListService } = require('../api/shared/dashboardAdmin/signupService');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { verifySignupAuditPhasePair } = require('../api/shared/dashboardAdmin/signupAuditEnvelope');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');
const { runtimeFixture, uid, principal, deferred, clone } = require('./fixtures/dashboardAdminSignupRuntime');

function serviceFor(h, request = h.request()) {
    return createSignupListService({ ...h.runtime,
        authoriseSignupList: input => h.runtime.authoriseSignupList({ ...input, request }),
        readSignupPage: (query, context) => h.runtime.readSignupPage(query, { ...context, request }),
        audit: (event, grant, context) => h.runtime.audit(event, grant, { ...context, request }) });
}
const authorise = (h, request = h.request(), actor = principal) => h.runtime.authoriseSignupList({ principal: actor, capability: 'signupList', request });
const inserts = h => h.state.trace.filter(({ sql }) => sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit'));
const retained = row => ({ sessionSha256: row.session_sha256, instanceId: row.instance_id, authorityId: row.authority_id, event: row.payload });

function atomicRuntime(h, read) {
    const legacyAuthority = jest.fn(() => { throw new Error('UNEXPECTED_LEGACY_AUTHORITY'); });
    const legacyBinding = jest.fn(() => { throw new Error('UNEXPECTED_LEGACY_BINDING'); });
    const readApprovedState = jest.fn(read || (async () => h.state.grant && h.state.binding
        ? { authority: clone(h.state.grant), population: clone(h.state.binding) } : null));
    h.runtime = createDashboardAdminSignupRuntime({ ...h.runtimeInput, readApprovedAuthority: legacyAuthority,
        resolvePopulationBinding: legacyBinding, readApprovedState });
    return { readApprovedState, legacyAuthority, legacyBinding };
}

test.each([1, 2])('atomic v%s authority observations retain native audit and final disclosure without legacy fallback', async version => {
    const h = await runtimeFixture({ version, twoTenants: version === 2 }), ports = atomicRuntime(h), service = serviceFor(h);
    const result = await service.list(principal, { cursor: null });
    expect(result.status).toBe('available'); expect(result.rows[0].email).toBe(h.data[0].account.email);
    expect(h.state.audit.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    expect(verifySignupAuditPhasePair(...h.state.audit.map(retained))).toBeDefined();
    const beforeDisclosure = ports.readApprovedState.mock.calls.length;
    await service.authoriseDisclosure(principal, result);
    expect(ports.readApprovedState.mock.calls.length).toBeGreaterThan(beforeDisclosure);
    expect(ports.readApprovedState.mock.calls.every(([query]) => query.operatorSubjectKey === principal.subjectKey &&
        query.capability === 'signupList' && Object.isFrozen(query))).toBe(true);
    expect(ports.legacyAuthority).not.toHaveBeenCalled(); expect(ports.legacyBinding).not.toHaveBeenCalled();
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
});

test.each([undefined, null, false, {}, new Proxy(async () => null, {})])('invalid selected atomic port %p cannot use legacy callbacks', async readApprovedState => {
    const h = await runtimeFixture();
    expect(() => createDashboardAdminSignupRuntime({ ...h.runtimeInput, readApprovedState })).toThrow('dashboard_admin_unavailable');
    expect(h.readApprovedAuthority).not.toHaveBeenCalled(); expect(h.state.trace).toEqual([]);
});

test('atomic configuration accessors and proxy traps are never executed', async () => {
    const h = await runtimeFixture(), getter = jest.fn(), trap = jest.fn();
    const input = { ...h.runtimeInput };
    Object.defineProperty(input, 'readApprovedState', { enumerable: true, get: getter });
    expect(() => createDashboardAdminSignupRuntime(input)).toThrow('dashboard_admin_unavailable');
    expect(() => createDashboardAdminSignupRuntime(new Proxy(h.runtimeInput, { getOwnPropertyDescriptor: trap })))
        .toThrow('dashboard_admin_unavailable');
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test.each(['absent', 'undefined', 'throw', 'unavailable', 'extra state', 'extra binding', 'foreign actor', 'authority hash', 'manifest hash', 'getter'])
('selected atomic result %s withholds authority before native work and never falls back', async mode => {
    const h = await runtimeFixture({ version: 2, twoTenants: true }), getter = jest.fn();
    const ports = atomicRuntime(h, async () => {
        if (mode === 'absent') return null;
        if (mode === 'undefined') return undefined;
        if (mode === 'throw') throw new Error('synthetic failure');
        if (mode === 'unavailable') throw new DashboardAdminError(503, 'dashboard_admin_unavailable');
        const value = { authority: clone(h.state.grant), population: clone(h.state.binding) };
        if (mode === 'extra state') value.extra = true;
        if (mode === 'extra binding') value.population.extra = true;
        if (mode === 'foreign actor') value.authority.operatorSubjectKey = uid(51) + ':' + uid(52);
        if (mode === 'authority hash') value.population.authoritySha256 = 'f'.repeat(64);
        if (mode === 'manifest hash') value.population.manifestSha256 = 'f'.repeat(64);
        if (mode === 'getter') Object.defineProperty(value, 'authority', { enumerable: true, get: getter });
        return value;
    });
    if (mode === 'unavailable') await expect(authorise(h)).rejects.toMatchObject({ statusCode: 503 });
    else expect(await authorise(h)).toBeNull();
    expect(h.state.trace).toEqual([]); expect(h.readSignupPage).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    expect(ports.legacyAuthority).not.toHaveBeenCalled(); expect(ports.legacyBinding).not.toHaveBeenCalled();
});

test.each(['grant', 'population', 'gate', 'parent', 'epoch', 'request'])('atomic checkpoints reject %s changes during data await', async mode => {
    const h = await runtimeFixture(), ports = atomicRuntime(h), req = h.request(), entered = deferred(), resume = deferred();
    h.state.sourceHook = async () => { entered.resolve(); await resume.promise; };
    const operation = serviceFor(h, req).list(principal, { cursor: null }).catch(error => error); await entered.promise;
    if (mode === 'grant') h.state.grant = null;
    if (mode === 'population') h.state.binding = null;
    if (mode === 'gate') h.state.gate.status = 'revoked';
    if (mode === 'parent') h.store.sessions.clear();
    if (mode === 'epoch') h.state.epoch = uid(40);
    if (mode === 'request') req.aborted = true;
    resume.resolve(); expect(await operation).toBeInstanceOf(Error);
    expect(h.state.audit).toHaveLength(1); expect(inserts(h)).toHaveLength(1);
    expect(ports.legacyAuthority).not.toHaveBeenCalled(); expect(ports.legacyBinding).not.toHaveBeenCalled();
});

test.each(['grant', 'population'])('atomic final disclosure refreshes current %s after a successful audited page', async mode => {
    const h = await runtimeFixture(), ports = atomicRuntime(h), service = serviceFor(h);
    const result = await service.list(principal, { cursor: null });
    if (mode === 'grant') h.state.grant = null; else h.state.binding = null;
    const before = ports.readApprovedState.mock.calls.length;
    await expect(service.authoriseDisclosure(principal, result)).rejects.toMatchObject({ statusCode: 403 });
    expect(ports.readApprovedState.mock.calls.length).toBeGreaterThan(before); expect(h.state.audit).toHaveLength(2);
});

test('atomic result is snapshotted before later native work can mutate the returned object', async () => {
    const h = await runtimeFixture(); let returned;
    atomicRuntime(h, async () => (returned = { authority: clone(h.state.grant), population: clone(h.state.binding) }));
    h.state.before = async () => { if (returned) { returned.authority.authorityRevision++; returned.population.authoritySha256 = 'f'.repeat(64); } };
    expect((await serviceFor(h).list(principal, { cursor: null })).status).toBe('available');
    expect(h.state.audit).toHaveLength(2);
});

test('atomic port receives a private cancellation signal and cannot acknowledge a late result', async () => {
    const h = await runtimeFixture(), req = h.request(), controller = new AbortController(), entered = deferred(), resume = deferred();
    let captured;
    const ports = atomicRuntime(h, async (_query, { signal } = {}) => {
        if (signal && !captured) { captured = signal; entered.resolve(); await resume.promise; }
        return { authority: clone(h.state.grant), population: clone(h.state.binding) };
    });
    const operation = h.runtime.audit(h.event(), h.grant, { request: req, signal: controller.signal }).catch(error => error);
    await entered.promise; expect(captured).not.toBe(controller.signal);
    controller.abort(); expect(captured.aborted).toBe(true); resume.resolve();
    expect(await operation).toBeInstanceOf(Error); expect(h.state.audit).toEqual([]);
    expect(ports.legacyAuthority).not.toHaveBeenCalled(); expect(ports.legacyBinding).not.toHaveBeenCalled();
});

test.each([false, true])('request expiry denies unchanged authority without another SQL read (atomic=%s)', async atomic => {
    const h = await runtimeFixture(), req = h.request();
    if (atomic) atomicRuntime(h);
    expect(await authorise(h, req)).toEqual(h.grant);
    const grant = clone(h.state.grant), binding = clone(h.state.binding), queries = h.state.trace.length;
    const originalNow = Date.now, elapsed = jest.spyOn(Date, 'now').mockImplementation(() => originalNow() + 10001);
    try { expect(await authorise(h, req)).toBeNull(); }
    finally { elapsed.mockRestore(); }
    expect(h.state.grant).toEqual(grant); expect(h.state.binding).toEqual(binding);
    expect(h.state.trace).toHaveLength(queries); expect(h.state.audit).toEqual([]);
});

test.each([1, 2])('genuine capture and real native transaction/writer compose a bounded v%s listing', async version => {
    const h = await runtimeFixture({ version, twoTenants: version === 2 }), service = serviceFor(h);
    const result = await service.list(principal, { cursor: null });
    expect(result.status).toBe('available'); expect(result.rows[0].email).toBe(h.data[0].account.email);
    expect(h.state.audit).toHaveLength(2); expect(inserts(h)).toHaveLength(2);
    expect(h.state.audit.map(row => row.payload.serviceEvent.phase)).toEqual(['attempt', 'outcome']);
    expect(h.state.audit.every(row => row.tenant_id === null && row.organisation_id === null && row.scope_json === null)).toBe(true);
    expect(verifySignupAuditPhasePair(...h.state.audit.map(retained))).toBeDefined();
    expect(h.readSignupPage).toHaveBeenCalledTimes(1);
    await service.authoriseDisclosure(principal, result);
    expect(h.state.trace.some(({ sql }) => /FROM nofries.dashboard_(tenants|organisations|membership|entitlement)/.test(sql))).toBe(false);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-native-audit-policy|sessionSha256|manifestSha256|restoreEpoch|recordId|accountId/);
});

test('configuration requires explicit current authority and finite reader, with no implicit lookup or production grants', async () => {
    const h = await runtimeFixture();
    for (const key of ['readApprovedAuthority', 'resolvePopulationBinding', 'readSignupPage', 'proofStore', 'pool']) {
        expect(() => createDashboardAdminSignupRuntime({ ...h.runtimeInput, [key]: undefined })).toThrow('dashboard_admin_unavailable');
    }
    expect(Object.keys(h.runtime).sort()).toEqual(['audit', 'authoriseSignupList', 'clock', 'readSignupPage', 'requestBudgetMs']);
    expect(() => createDashboardAdminSignupRuntime({ ...h.runtimeInput, wildcard: true })).toThrow('dashboard_admin_unavailable');
    expect(() => createDashboardAdminSignupRuntime({ ...h.runtimeInput, requestBudgetMs: 10001 })).toThrow('dashboard_admin_unavailable');
    expect(h.state.trace).toEqual([]);
});

test.each(['plain request', 'customer cookie', 'missing cookie', 'proofless parent', 'missing proof', 'revoked gate',
    'disabled ingress', 'restore epoch', 'wrong principal', 'missing authority', 'changed authority', 'expired authority'])
('operator authority fails closed before data/audit: %s', async mode => {
    const h = await runtimeFixture({ withProof: mode !== 'proofless parent' }); let req = h.request(), actor = principal;
    if (mode === 'plain request') req = { headers: { cookie: h.cookie } };
    if (mode === 'customer cookie') req = h.request(h.cookie.replace('__Host-nofries-auth', '__Host-nofries-customer'));
    if (mode === 'missing cookie') req = h.request('');
    if (mode === 'missing proof') h.proofs.clear();
    if (mode === 'revoked gate') h.state.gate.status = 'revoked';
    if (mode === 'disabled ingress') h.state.instance.ingressStatus = 'disabled';
    if (mode === 'restore epoch') h.state.epoch = uid(50);
    if (mode === 'wrong principal') actor = { ...principal, subjectKey: uid(51) + ':' + uid(52) };
    if (mode === 'missing authority') h.state.grant = null;
    if (mode === 'changed authority') h.state.grant.operatorSubjectKey = uid(51) + ':' + uid(52);
    if (mode === 'expired authority') h.state.grant.expiresAt = h.state.now;
    expect(await authorise(h, req, actor)).toBeNull();
    expect(h.readSignupPage).not.toHaveBeenCalled(); expect(inserts(h)).toEqual([]);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
});

test('read waits for acknowledged attempt and reserves the only data slot before awaiting', async () => {
    const h = await runtimeFixture(), req = h.request(), context = { request: req };
    const query = { authority: h.grant, cursor: null, snapshotId: null, limit: 1 };
    await authorise(h, req);
    await expect(h.runtime.readSignupPage(query, context)).rejects.toMatchObject({ statusCode: 403 });
    await h.runtime.audit(h.event(), h.grant, context);
    const entered = deferred(), resume = deferred();
    h.state.sourceHook = async () => { entered.resolve(); await resume.promise; };
    const first = h.runtime.readSignupPage(query, context); await entered.promise;
    await expect(h.runtime.readSignupPage(query, context)).rejects.toMatchObject({ statusCode: 403 });
    resume.resolve(); expect((await first).status).toBe('available'); expect(h.readSignupPage).toHaveBeenCalledTimes(1);
});

test('identical concurrent phase requests share one native write and return the original service digest', async () => {
    const h = await runtimeFixture(), req = h.request(), context = { request: req }, event = h.event();
    const entered = deferred(), resume = deferred();
    h.state.before = async sql => { if (sql.startsWith('INSERT INTO')) { entered.resolve(); await resume.promise; } };
    const first = h.runtime.audit(event, h.grant, context); await entered.promise;
    const second = h.runtime.audit(clone(event), clone(h.grant), context); resume.resolve();
    expect(await first).toEqual({ schemaVersion: 1, durable: true, eventSha256: hash(event) });
    expect(await second).toEqual(await first); expect(inserts(h)).toHaveLength(1);
    await expect(h.runtime.audit({ ...event, requestSha256: 'f'.repeat(64) }, h.grant, context)).rejects.toBeDefined();
    expect(inserts(h)).toHaveLength(1);
});

test.each(['attempt', 'outcome'])('lost %s COMMIT uses exact SELECT-only reconciliation without reinsert or data retry', async phase => {
    const h = await runtimeFixture();
    h.state.after = async (sql, params) => {
        if (sql.startsWith('INSERT INTO') && JSON.parse(params.at(-1)).serviceEvent.phase === phase) h.state.loseCommit = true;
    };
    expect((await serviceFor(h).list(principal, { cursor: null })).status).toBe('available');
    expect(inserts(h)).toHaveLength(2); expect(h.state.audit).toHaveLength(2); expect(h.readSignupPage).toHaveBeenCalledTimes(1);
    const phaseQueries = h.state.trace.filter(({ sql, params }) => sql.includes("payload->'serviceEvent'->>'phase'") && params[4] === phase);
    expect(phaseQueries.length).toBeGreaterThan(1);
});

test.each(['revoked grant', 'revoked gate', 'parent removed', 'restore epoch', 'aborted request'])
('native authority change during data await withholds disclosure: %s', async mode => {
    const h = await runtimeFixture(), req = h.request(), entered = deferred(), resume = deferred();
    h.state.sourceHook = async () => { entered.resolve(); await resume.promise; };
    const operation = serviceFor(h, req).list(principal, { cursor: null }).catch(error => error); await entered.promise;
    if (mode === 'revoked grant') h.state.grant = null;
    if (mode === 'revoked gate') h.state.gate.status = 'revoked';
    if (mode === 'parent removed') h.store.sessions.clear();
    if (mode === 'restore epoch') h.state.epoch = uid(40);
    if (mode === 'aborted request') req.aborted = true;
    resume.resolve(); const result = await operation;
    expect(result).toBeInstanceOf(Error); expect(result).not.toHaveProperty('rows');
    expect(h.state.audit).toHaveLength(1); expect(inserts(h)).toHaveLength(1);
});

test('cancellation during provisional INSERT prevents COMMIT and cannot acknowledge late work', async () => {
    const h = await runtimeFixture(), req = h.request(), controller = new AbortController(), entered = deferred(), resume = deferred();
    h.state.after = async sql => { if (sql.startsWith('INSERT INTO')) { entered.resolve(); await resume.promise; } };
    const operation = h.runtime.audit(h.event(), h.grant, { request: req, signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); resume.resolve();
    expect(await operation).toBeInstanceOf(Error); expect(h.state.audit).toEqual([]);
    const insertion = h.state.trace.findIndex(({ sql }) => sql.startsWith('INSERT INTO'));
    expect(h.state.trace.slice(insertion).some(({ sql }) => sql === 'COMMIT')).toBe(false);
});

test('signal shadowing cannot hide cancellation after a port captures its private signal', async () => {
    const h = await runtimeFixture(), req = h.request(), controller = new AbortController(), entered = deferred(), resume = deferred();
    h.state.after = async sql => { if (sql.startsWith('INSERT INTO')) { entered.resolve(); await resume.promise; } };
    const operation = h.runtime.audit(h.event(), h.grant, { request: req, signal: controller.signal }).catch(error => error);
    await entered.promise; Object.defineProperty(controller.signal, 'aborted', { value: false }); controller.abort(); resume.resolve();
    expect(await operation).toBeInstanceOf(Error); expect(h.state.audit).toEqual([]);
});

test('changed grant after outcome COMMIT cannot return a durable acknowledgement', async () => {
    const h = await runtimeFixture(); let outcome = false;
    h.state.after = async (sql, params) => {
        if (sql.startsWith('INSERT INTO')) outcome = JSON.parse(params.at(-1)).serviceEvent.phase === 'outcome';
        if (sql === 'COMMIT' && outcome) h.state.grant.authorityRevision++;
    };
    await expect(serviceFor(h).list(principal, { cursor: null })).rejects.toBeDefined();
    expect(h.state.audit).toHaveLength(2); expect(h.readSignupPage).toHaveBeenCalledTimes(1);
});

test('final disclosure revalidates current grant after successful list and consumed service signal', async () => {
    const h = await runtimeFixture(), service = serviceFor(h), result = await service.list(principal, { cursor: null });
    h.state.grant.authorityRevision++;
    await expect(service.authoriseDisclosure(principal, result)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.audit).toHaveLength(2);
});

test.each([1, 2])('v%s current population binding revocation is independent of an unchanged operator grant', async version => {
    const h = await runtimeFixture({ version }), service = serviceFor(h);
    const result = await service.list(principal, { cursor: null });
    h.state.binding = null;
    await expect(service.authoriseDisclosure(principal, result)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.grant).toEqual(h.grant); expect(h.state.audit).toHaveLength(2);
});

test.each(['authority', 'manifest'])('changed %s binding after attempt prevents data read despite unchanged grant', async field => {
    const h = await runtimeFixture(); let inserted = false;
    h.state.after = async sql => {
        if (sql.startsWith('INSERT INTO')) inserted = true;
        if (sql === 'COMMIT' && inserted) h.state.binding[field + 'Sha256'] = 'f'.repeat(64);
    };
    await expect(serviceFor(h).list(principal, { cursor: null })).rejects.toBeDefined();
    expect(h.readSignupPage).not.toHaveBeenCalled(); expect(h.state.audit).toHaveLength(1);
});

test('population revocation after successful data read prevents outcome commit', async () => {
    const h = await runtimeFixture(), read = h.runtimeInput.readSignupPage;
    const input = { ...h.runtimeInput, readSignupPage: async (...args) => {
        const page = await read(...args); h.state.binding = null; return page;
    } };
    h.runtime = createDashboardAdminSignupRuntime(input);
    await expect(serviceFor(h).list(principal, { cursor: null })).rejects.toBeDefined();
    expect(h.state.audit).toHaveLength(1); expect(h.state.grant).toEqual(h.grant);
});
