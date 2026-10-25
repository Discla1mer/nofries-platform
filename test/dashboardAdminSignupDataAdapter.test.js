'use strict';

const { createSignupDataAdapter } = require('../api/shared/dashboardAdmin/signupDataAdapter');
const { projectSignupRecord } = require('../api/shared/dashboardAdmin/signupProjection');
const { accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { fixture, START, SUBJECT, uid, clone } = require('./fixtures/dashboardAdminSignupData');

const unavailable = operation => expect(operation).rejects.toMatchObject({ statusCode: 503, code: 'dashboard_admin_unavailable' });

test.each(['legacy', 'external'])('real %s stores produce only exact saved facts and conservative observation', async provider => {
    const f = await fixture(provider), at = f.clock();
    f.duringRead(() => f.setTime(START + 5000));
    const result = await f.read(f.entry);
    expect(result.observedAt).toBe(at);
    expect(result.record.binding).toEqual(f.entry.binding);
    const row = projectSignupRecord(result.record, f.entry.binding, result.observedAt);
    expect(row).toEqual({ email: f.account.email, organisation: f.account.organisations[0].organisationName,
        accountType: 'consultant', milestones: {
            accountSaved: { status: 'recorded', at: f.account.createdAt },
            setupSaved: { status: 'recorded', at: f.setup.assertion.receivedAt },
            termsAccepted: { status: 'unknown', at: null }, accountActivated: { status: 'unknown', at: null },
            admission: { status: 'unknown', at: null }
        } });
    expect(f.reads).toEqual([f.accountPath, f.setupPath]);
    expect(f.writes).toEqual([]);
    expect(Object.isFrozen(result.record.account.value)).toBe(true);
    for (const secret of [f.reference.accountKey, 'synthetic-etag', f.details.name, f.details.address,
        f.details.registrationId, 'authenticationSha256', 'proof', 'authorityEvidenceId']) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(row)).not.toContain(secret);
    }
});

test.each(['legacy', 'external'])('renewed %s proof retains the original setup request association', async provider => {
    const f = await fixture(provider), renewed = await f.renewedSetup();
    expect(renewed.assertion.setupRequestId).not.toBe(f.account.setupRequestId);
    const result = await f.read(f.entry);
    expect(result.record.setup.value.setupRequestId).toBe(f.account.setupRequestId);
    expect(result.record.setup.revision).toBe('setup-sha256:' + hash(renewed));
});

test('valid long opaque ETag becomes bounded private revision and changes when version changes', async () => {
    const f = await fixture();
    f.setEtag('"' + 'x'.repeat(200) + '"');
    const first = await f.read(f.entry);
    expect(first.record.account.revision).toMatch(/^account-etag-sha256:[a-f0-9]{64}$/);
    f.setEtag('"new"');
    expect((await f.read(f.entry)).record.account.revision).not.toBe(first.record.account.revision);
});

test.each(['', 'unquoted', '"bad\nvalue"', '"' + 'x'.repeat(201) + '"'])('invalid ETag withholds source: %j', async version => {
    const f = await fixture(); f.setEtag(version);
    await unavailable(f.read(f.entry)); expect(f.reads).toEqual([f.accountPath]);
});

test.each(['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey'])
('altered reference %s cannot reach any store', async key => {
    const f = await fixture(), target = clone(f.entry);
    target.binding[key] = key === 'provider' ? 'external' : key === 'subjectKey' ? SUBJECT : uid(900);
    await unavailable(f.read(target)); expect(f.reads).toEqual([]);
});

test.each(['recordId', 'key', 'account', 'foreign', 'oversized', 'getter', 'proxy'])
('invalid or ambiguous configured references fail before I/O: %s', async kind => {
    const f = await fixture(), refs = clone(f.options.sourceReferences);
    if (kind === 'recordId') refs.push({ ...clone(refs[0]), accountKey: 'starter-accounts/' + 'a'.repeat(64) });
    if (kind === 'key') refs.push({ ...clone(refs[0]), entry: { ...clone(f.entry), recordId: 'other', binding: { ...f.entry.binding, accountId: uid(901) } } });
    if (kind === 'account') refs.push({ entry: { ...clone(f.entry), recordId: 'other' }, accountKey: 'starter-accounts/' + 'a'.repeat(64) });
    if (kind === 'foreign') refs[0].entry.binding.provider = 'external';
    if (kind === 'oversized') refs.push(...Array(100).fill(refs[0]));
    if (kind === 'getter') Object.defineProperty(refs[0], 'accountKey', { get() { throw new Error('getter'); }, enumerable: true });
    if (kind === 'proxy') refs[0] = new Proxy(refs[0], {});
    expect(() => createSignupDataAdapter({ ...f.options, sourceReferences: refs })).toThrow('dashboard_admin_unavailable');
    expect(f.reads).toEqual([]);
});

test('configuration and requested entry are detached; later mutation never changes source selection', async () => {
    const f = await fixture(), input = clone(f.entry);
    f.options.sourceReferences[0].accountKey = 'starter-accounts/' + 'f'.repeat(64);
    f.duringRead(() => { input.binding.organisationId = uid(909); });
    expect((await f.read(input)).record.binding.organisationId).toBe(f.account.organisations[0].organisationId);
    expect(f.reads).toEqual([f.accountPath, f.setupPath]);
});

test.each(['accountId', 'setupRequestId', 'scope', 'email', 'subject', 'originalProof'])
('a well-located account cannot contradict its reference: %s', async kind => {
    const f = await fixture('external'), raw = clone(f.account);
    if (kind === 'accountId') raw.accountId = uid(911);
    if (kind === 'setupRequestId') raw.setupRequestId = raw.organisations[0].requestId = uid(912);
    if (kind === 'scope') raw.organisations[0].tenantId = uid(913);
    if (kind === 'email') raw.email = 'other@example.invalid';
    if (kind === 'subject') raw.identitySubjectKey = uid(914) + ':' + uid(915);
    if (kind === 'originalProof') raw.setupSha256 = 'f'.repeat(64);
    f.blobs.set(f.accountPath, raw);
    await unavailable(f.read(f.entry));
    expect(f.writes).toEqual([]);
    if (kind !== 'originalProof') expect(f.reads).toEqual([f.accountPath]);
});

test('an unestablished legacy subject stays null, even if a configured reference asserts one', async () => {
    const f = await fixture(), changed = clone(f.reference); changed.entry.binding.subjectKey = SUBJECT;
    const read = createSignupDataAdapter({ ...f.options, sourceReferences: [changed] });
    await unavailable(read(changed.entry)); expect(f.reads).toEqual([f.accountPath]);
});

test.each(['accountId', 'requestId', 'planSha256', 'kind', 'accountType', 'tenantId', 'organisationId',
    'organisationName', 'grantId', 'scheduleId', 'subject', 'provider'])
('setup linkage or domain contradiction withholds all evidence: %s', async key => {
    const f = await fixture('external'), raw = clone(f.setup);
    if (['accountId', 'requestId'].includes(key)) raw[key] = uid(920);
    else if (key === 'planSha256') raw[key] = 'f'.repeat(64);
    else if (key === 'subject') { raw.assertion.proof.subjectKey = uid(921) + ':' + uid(922); raw.assertion.setupSha256 = hash(raw.assertion.proof); }
    else if (key === 'provider') { raw.assertion.proof.source = 'forged'; }
    else raw.offerInput[key] = key === 'kind' ? 'client' : key === 'accountType' ? 'company' : key === 'organisationName' ? 'Foreign' : uid(923);
    f.blobs.set(f.setupPath, raw);
    await unavailable(f.read(f.entry)); expect(f.writes).toEqual([]);
});

test('historical activation uses the own-slot activation ID and never implies current admission', async () => {
    const f = await fixture('external'), raw = clone(f.account), at = new Date(START + 2500).toISOString();
    raw.activation = { subjectKey: SUBJECT, receiptId: raw.organisations[0].activationId, activatedAt: at,
        validUntil: accountWindow(at, raw.planId).validUntil };
    f.blobs.set(f.accountPath, raw);
    const result = await f.read(f.entry), row = projectSignupRecord(result.record, f.entry.binding, result.observedAt);
    expect(row.milestones.accountActivated).toEqual({ status: 'recorded', at });
    expect(row.milestones.admission).toEqual({ status: 'unknown', at: null });
    raw.activation.receiptId = uid(931); f.blobs.set(f.accountPath, raw);
    await unavailable(f.read(f.entry));
});

test.each(['accountType', 'organisationName', 'subjectKey'])('renewed proof cannot change retained %s', async key => {
    const f = await fixture('external'), raw = clone(await f.renewedSetup());
    raw.assertion.proof[key] = key === 'accountType' ? 'company' : key === 'organisationName' ? 'Foreign organisation' : uid(940) + ':' + uid(941);
    raw.assertion.setupSha256 = hash(raw.assertion.proof);
    f.blobs.set(f.setupPath, raw);
    await unavailable(f.read(f.entry));
});

test('activation subject cannot disagree with account identity', async () => {
    const f = await fixture('external'), raw = clone(f.account), at = new Date(START + 2500).toISOString();
    raw.activation = { subjectKey: uid(932) + ':' + uid(933), receiptId: raw.organisations[0].activationId,
        activatedAt: at, validUntil: accountWindow(at, raw.planId).validUntil };
    f.blobs.set(f.accountPath, raw); await unavailable(f.read(f.entry));
    expect(f.reads).toEqual([f.accountPath]);
});

test('missing account withholds entry; missing setup is unknown, never not-started or successful', async () => {
    const f = await fixture(); f.blobs.delete(f.setupPath);
    expect((await f.read(f.entry)).record.setup).toEqual({ state: 'unknown' });
    f.reads.length = 0; f.blobs.delete(f.accountPath);
    await unavailable(f.read(f.entry)); expect(f.reads).toEqual([f.accountPath]);
});

test.each(['account', 'setup'])('source errors remain unavailable and bounded: %s', async source => {
    const f = await fixture(); f.duringRead(key => {
        if (key === f[source + 'Path']) throw new Error('PRIVATE_PROVIDER_ERROR');
    });
    await unavailable(f.read(f.entry)); expect(f.writes).toEqual([]);
    expect(f.reads.length).toBe(source === 'account' ? 1 : 2);
});

test('raw account is detached before a later setup await can mutate it', async () => {
    const f = await fixture(), raw = { record: clone(f.account), version: '"v1"' };
    const read = createSignupDataAdapter({ ...f.options, accountStore: { async load() { return raw; } },
        setupStore: { async load() { raw.record.email = 'changed@example.invalid'; return f.setup; } } });
    expect((await read(f.entry)).record.account.value.email).toBe(f.account.email);
});

test.each(['before', 'account', 'setup'])('abort %s prevents disclosure and any later read', async phase => {
    const f = await fixture(), controller = new AbortController();
    if (phase === 'before') controller.abort();
    else f.duringRead(key => { if (key === f[phase + 'Path']) controller.abort(); });
    await unavailable(f.read(f.entry, { signal: controller.signal }));
    expect(f.reads.length).toBe(phase === 'before' ? 0 : phase === 'account' ? 1 : 2);
});

test('abort during unresolved read settles promptly without starting setup even after completion', async () => {
    const f = await fixture(), controller = new AbortController(); let release;
    f.duringRead(() => new Promise(resolve => { release = resolve; }));
    const pending = f.read(f.entry, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await unavailable(pending); release(); await new Promise(resolve => setImmediate(resolve));
    expect(f.reads).toEqual([f.accountPath]);
});

test('private dependent signal survives caller method replacement', async () => {
    const f = await fixture(), controller = new AbortController();
    f.duringRead(() => {
        controller.signal.addEventListener = () => {};
        Object.defineProperty(controller.signal, 'aborted', { value: false });
        controller.abort();
    });
    await unavailable(f.read(f.entry, { signal: controller.signal }));
    expect(f.reads).toEqual([f.accountPath]);
});

test('adapter deadline settles an unresponsive store and permanently stops later reads', async () => {
    const f = await fixture(); let release;
    f.duringRead(() => new Promise(resolve => { release = resolve; }));
    jest.useFakeTimers();
    try {
        const pending = f.read(f.entry), assertion = unavailable(pending);
        await jest.advanceTimersByTimeAsync(10000);
        await assertion;
        release(); await Promise.resolve(); await Promise.resolve();
        expect(f.reads).toEqual([f.accountPath]);
    } finally { jest.useRealTimers(); }
});

test.each(['rollback', 'stale', 'futureAccount', 'futureSetup'])('incoherent time withholds evidence: %s', async kind => {
    const f = await fixture();
    if (kind === 'rollback' || kind === 'stale') f.duringRead(() => f.setTime(START + (kind === 'rollback' ? 2000 : 34000)));
    if (kind === 'futureAccount') { const raw = clone(f.account); raw.createdAt = new Date(START + 4000).toISOString(); f.blobs.set(f.accountPath, raw); }
    if (kind === 'futureSetup') { const raw = clone(f.setup); raw.assertion.receivedAt = new Date(START + 4000).toISOString(); f.blobs.set(f.setupPath, raw); }
    await unavailable(f.read(f.entry));
    if (kind !== 'futureSetup') expect(f.reads).toEqual([f.accountPath]);
});
