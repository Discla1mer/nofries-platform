'use strict';

const { Readable } = require('node:stream');
const { createDashboardAdminAccountActionService, tokenDigest } = require('../api/shared/dashboardAdmin/accountActionService');
const { AzureAccountActionConfirmationStore, PREFIX } = require('../api/shared/dashboardAdmin/azureAccountActionConfirmationStore');
const { actionCommand, commandDigest, confirmationInput } = require('../api/shared/dashboardAdmin/accountActionRecords');
const { hash, equal } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { SUBJECT, NOW } = require('./fixtures/dashboardFixture');

const ACTOR = SUBJECT.slice(0, -1) + '9', OTHER = SUBJECT.slice(0, -1) + '2';
const principal = Object.freeze({ provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR });
const selector = Object.freeze({ provider: 'external', subjectKey: SUBJECT, tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' });
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = () => Object.assign(new Error('private provider diagnostic'), { statusCode: 503 });
const conflict = () => Object.assign(new Error('private source revision'), { statusCode: 409 });

function setup(overrides = {}) {
    const blobs = new Map(), writes = [], reads = [], receipts = new Map();
    const state = { now: NOW, allowed: true, actions: ['edit', 'delete', 'restore'], label: null, revision: 1,
        membership: { membershipId: 'synthetic-membership', status: 'active', validFrom: '2026-09-01T00:00:00.000Z',
            validUntil: '2026-10-01T00:00:00.000Z' }, loseUploadAck: false, uploadEffect: true };
    const container = { getBlockBlobClient: jest.fn(key => ({
        async download() {
            reads.push(key);
            if (!blobs.has(key)) throw Object.assign(new Error(), { statusCode: 404, code: 'BlobNotFound' });
            const bytes = blobs.get(key);
            return { contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
        },
        async uploadData(bytes, options) {
            writes.push({ key, options });
            if (blobs.has(key)) throw Object.assign(new Error(), { statusCode: 412, code: 'ConditionNotMet' });
            if (state.uploadEffect) blobs.set(key, Buffer.from(bytes));
            if (state.loseUploadAck) throw invalid();
        }
    })) };
    const store = new AzureAccountActionConfirmationStore(container);
    const view = () => ({ selector, version: hash({ revision: state.revision, label: state.label, membership: state.membership }),
        displayName: 'Immutable Accepted Organisation', displayLabel: state.label, membership: clone(state.membership),
        actions: state.actions, witness: { revision: state.revision, privateCanary: 'private-native-authority-witness' } });
    const adapter = {
        inspect: jest.fn(async () => view()),
        outcome: jest.fn(async command => receipts.get(command.operationId) || null),
        commit: jest.fn(async (command, context) => {
            await context.beforeCommit();
            if (receipts.has(command.operationId)) return receipts.get(command.operationId);
            if (command.expectedVersion !== view().version) throw conflict();
            if (command.action === 'edit') state.label = command.patch.displayLabel;
            if (command.action === 'delete') state.membership.status = 'suspended';
            if (command.action === 'restore') state.membership.status = 'active';
            state.revision++;
            const receipt = { operationId: command.operationId, commandSha256: command.commandSha256,
                status: 'succeeded', version: view().version, occurredAt: state.now };
            receipts.set(command.operationId, receipt); return receipt;
        })
    };
    const config = { authoriseOperator: jest.fn(async ({ principal: actor, selector: selected, action }) => state.allowed &&
        actor.subjectKey === ACTOR && (!selected || equal(selected, selector)) && (!action || state.actions.includes(action))),
    adapter, confirmationStore: store, clock: () => state.now, requestBudgetMs: 1000, ...overrides };
    const service = createDashboardAdminAccountActionService(config);
    const prepare = (action = 'edit', patch = { displayLabel: 'Helpful staff label' }) =>
        service.prepare(principal, { selector, action, patch: action === 'edit' ? patch : null, ...(action === 'delete' ? { confirmationName: 'Immutable Accepted Organisation' } : {}) });
    return { config, service, prepare, adapter, store, container, state, blobs, receipts, writes, reads, view };
}

test('construction requires explicit independent authority, durable store and complete native adapter', () => {
    const h = setup();
    for (const key of ['authoriseOperator', 'adapter', 'confirmationStore', 'clock']) {
        const options = { ...h.config }; delete options[key];
        expect(() => createDashboardAdminAccountActionService(options)).toThrow('dashboard_admin_unavailable');
    }
    expect(() => createDashboardAdminAccountActionService({ ...h.config, write: () => true })).toThrow();
    expect(() => createDashboardAdminAccountActionService({ ...h.config, confirmationTtlMs: 300001 })).toThrow();
    expect(() => createDashboardAdminAccountActionService({ ...h.config, adapter: { ...h.adapter, outcome: null } })).toThrow();
});

test.each([null, {}, { ...principal, provider: 'local' }, { ...principal, isAuthenticated: false },
    { ...principal, subjectKey: 'staff@example.invalid' }])('invalid staff cannot reach authority or storage: %p', async actor => {
    const h = setup();
    await expect(h.service.prepare(actor, { selector, action: 'edit', patch: { displayLabel: 'Label' } })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.config.authoriseOperator).not.toHaveBeenCalled(); expect(h.adapter.inspect).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
});

test.each([false, undefined, 'true', {}])('independent action authority requires literal true: %p', async response => {
    const h = setup({ authoriseOperator: jest.fn(async () => response) });
    await expect(h.prepare()).rejects.toMatchObject({ statusCode: 403 });
    expect(h.adapter.inspect).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
});

test.each(['provider', 'subjectKey', 'tenantId', 'organisationId'])('exact target authorization rejects substituted %s before read', async field => {
    const h = setup(), altered = { ...selector, [field]: field === 'provider' ? 'legacy' : field === 'subjectKey' ? OTHER : 'different-scope' };
    await expect(h.service.inspect(principal, altered)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.adapter.inspect).not.toHaveBeenCalled();
});

test.each([{ displayName: 'Canonical rename' }, { displayLabel: 'Label', role: 'admin' }, { email: 'other@example.invalid' },
    { displayLabel: '' }, { displayLabel: '<script>' }, { displayLabel: 'name\u202e' }, { displayLabel: 'x'.repeat(201) },
    { displayLabel: ' name ' }, { displayLabel: 'e\u0301' }])('edit permits only the bounded staff label: %p', async patch => {
    const h = setup();
    await expect(h.prepare('edit', patch)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.adapter.inspect).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
});

test('hostile properties are rejected without invoking accessors or proxy traps', async () => {
    const h = setup(), getter = jest.fn(() => 'Label'), patch = {};
    Object.defineProperty(patch, 'displayLabel', { get: getter, enumerable: true });
    await expect(h.prepare('edit', patch)).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.prepare('edit', new Proxy({ displayLabel: 'Label' }, { get: getter }))).rejects.toMatchObject({ statusCode: 400 });
    expect(getter).not.toHaveBeenCalled();
});

test('inspect minimizes private witnesses and filters independently denied per-target actions', async () => {
    const h = setup(); h.config.authoriseOperator.mockImplementation(async ({ action }) => action !== 'delete');
    const value = await h.service.inspect(principal, selector);
    expect(value).toMatchObject({ displayName: 'Immutable Accepted Organisation', displayLabel: null, actions: ['edit', 'restore'] });
    expect(JSON.stringify(value)).not.toContain('private-native'); expect(value).not.toHaveProperty('witness');
    expect(Object.isFrozen(value.membership)).toBe(true);
    expect(await h.service.capabilities(principal)).toEqual({ accountActions: true });
});

test('prepare persists exact actor/action/version before disclosing token and detached review', async () => {
    const h = setup(), value = await h.prepare();
    expect(value).toMatchObject({ selector, action: 'edit', patch: { displayLabel: 'Helpful staff label' },
        before: { displayName: 'Immutable Accepted Organisation', displayLabel: null },
        confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), operationId: expect.any(String) });
    expect(h.writes).toHaveLength(1); expect(h.writes[0].key).toBe(PREFIX + tokenDigest(value.confirmationToken) + '.json');
    expect(h.writes[0].options.conditions).toEqual({ ifNoneMatch: '*' });
    const retained = await h.store.load(tokenDigest(value.confirmationToken));
    expect(retained).toMatchObject({ actorSubjectKey: ACTOR, operationId: value.operationId, selector,
        expectedVersion: h.view().version, witness: { privateCanary: 'private-native-authority-witness' } });
    expect(JSON.stringify(value)).not.toContain('private-native'); expect(h.adapter.commit).not.toHaveBeenCalled();
});

test('request input is detached before authority I/O', async () => {
    const h = setup(), request = { selector: { ...selector }, action: 'edit', patch: { displayLabel: 'Original label' } };
    h.config.authoriseOperator.mockImplementation(async () => { request.selector.subjectKey = OTHER; request.patch.displayLabel = 'Changed label'; return true; });
    const review = await h.service.prepare(principal, request);
    expect(review.selector.subjectKey).toBe(SUBJECT); expect(review.patch.displayLabel).toBe('Original label');
});

test.each(['reset', 'unchanged'])('unavailable reset or unchanged label cannot create a confirmation: %s', async mode => {
    const h = setup(); if (mode === 'unchanged') h.state.label = 'Helpful staff label';
    if (mode === 'reset') h.config.authoriseOperator.mockResolvedValue(true);
    await expect(h.prepare(mode === 'reset' ? 'reset' : 'edit')).rejects.toMatchObject({ statusCode: mode === 'reset' ? 503 : 409 });
    expect(h.writes).toEqual([]); expect(h.adapter.commit).not.toHaveBeenCalled();
});

test('confirmation and durable outcome survive process recreation; retries do not repeat mutation', async () => {
    const h = setup(), review = await h.prepare(), input = { confirmationToken: review.confirmationToken };
    const restarted = createDashboardAdminAccountActionService({ ...h.config,
        confirmationStore: new AzureAccountActionConfirmationStore(h.container) });
    expect((await restarted.outcome(principal, input)).status).toBe('not_started');
    const first = await restarted.execute(principal, input);
    expect(await h.service.execute(principal, input)).toEqual(first);
    expect(await restarted.outcome(principal, input)).toEqual(first);
    expect(h.adapter.commit).toHaveBeenCalledTimes(1); expect(h.receipts.size).toBe(1); expect(h.state.label).toBe('Helpful staff label');
});

test('another actor cannot use a retained token even with an independently allowed general grant', async () => {
    const h = setup(), review = await h.prepare(); h.config.authoriseOperator.mockResolvedValue(true);
    await expect(h.service.execute({ ...principal, subjectKey: OTHER }, { confirmationToken: review.confirmationToken }))
        .rejects.toMatchObject({ statusCode: 403 });
    expect(h.adapter.outcome).not.toHaveBeenCalled(); expect(h.adapter.commit).not.toHaveBeenCalled();
});

test('expired confirmation is read-only; previously committed outcome remains recoverable', async () => {
    const h = setup(), review = await h.prepare(), input = { confirmationToken: review.confirmationToken };
    h.state.now = review.expiresAt;
    await expect(h.service.execute(principal, input)).rejects.toMatchObject({ statusCode: 409 });
    expect((await h.service.outcome(principal, input)).status).toBe('not_started_expired'); expect(h.adapter.commit).not.toHaveBeenCalled();
    const g = setup(), otherReview = await g.prepare(), otherInput = { confirmationToken: otherReview.confirmationToken };
    const saved = await g.service.execute(principal, otherInput); g.state.now = otherReview.expiresAt;
    expect(await g.service.execute(principal, otherInput)).toEqual(saved); expect(g.adapter.commit).toHaveBeenCalledTimes(1);
});

test('stale review conflicts without mutation and cannot silently bind to a newer revision', async () => {
    const h = setup(), review = await h.prepare(); h.state.revision++;
    await expect(h.service.execute(principal, { confirmationToken: review.confirmationToken })).rejects.toMatchObject({
        statusCode: 409, code: 'dashboard_admin_conflict' });
    expect(h.state.label).toBeNull(); expect(h.receipts.size).toBe(0);
});

test('current action authorization is rechecked immediately before the native effect', async () => {
    const h = setup(), review = await h.prepare();
    h.adapter.commit.mockImplementation(async (_command, context) => { h.state.allowed = false; await context.beforeCommit(); throw new Error('MUST_NOT_REACH'); });
    await expect(h.service.execute(principal, { confirmationToken: review.confirmationToken })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.label).toBeNull(); expect(h.receipts.size).toBe(0);
});

test('a delayed first dispatch cannot mutate after outcome confirms absence past server expiry', async () => {
    const h = setup(), review = await h.prepare(), input = { confirmationToken: review.confirmationToken };
    let release, entered;
    const atCommit = new Promise(resolve => { entered = resolve; });
    h.adapter.commit.mockImplementation(async (_command, context) => {
        entered(); await new Promise(resolve => { release = resolve; });
        context.check(); h.state.label = 'MUST_NOT_WRITE';
    });
    const pending = h.service.execute(principal, input);
    await atCommit; h.state.now = review.expiresAt;
    expect((await h.service.outcome(principal, input)).status).toBe('not_started_expired');
    release(); await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(h.state.label).toBeNull(); expect(h.receipts.size).toBe(0);
});

test('absence observed before expiry is reread after expiry when a competing commit wins during authorization', async () => {
    const h = setup(), review = await h.prepare(), input = { confirmationToken: review.confirmationToken };
    const command = await h.store.load(tokenDigest(review.confirmationToken));
    const committed = { operationId: command.operationId, commandSha256: command.commandSha256,
        status: 'succeeded', version: hash('interleaved-commit'), occurredAt: NOW };
    let interleave = false;
    h.adapter.outcome.mockImplementationOnce(async () => { interleave = true; return null; });
    h.config.authoriseOperator.mockImplementation(async () => {
        if (interleave) {
            interleave = false;
            // The competing transaction committed while the first absence no
            // longer held its native tenant lock, just before expiry.
            h.receipts.set(command.operationId, committed);
            h.state.now = review.expiresAt;
        }
        return true;
    });
    expect(await h.service.outcome(principal, input)).toEqual(committed);
    expect(h.adapter.outcome).toHaveBeenCalledTimes(2);
});

test('historically valid canonical organisation names do not inherit new staff-label restrictions', async () => {
    const h = setup(); h.adapter.inspect.mockResolvedValue({ ...h.view(), displayName: 'Cafe\u0301 <Historical> \u202e' });
    const found = await h.service.inspect(principal, selector);
    expect(found.displayName).toBe('Cafe\u0301 <Historical> \u202e');
    expect(found.actions).toContain('delete');
});

test('timeout aborts the adapter and forbids its delayed precommit from dispatching an effect', async () => {
    const h = setup({ requestBudgetMs: 30 }), review = await h.prepare(); let release, observedSignal, mutated = false, lateError;
    h.adapter.commit.mockImplementation(async (_command, context) => {
        observedSignal = context.signal; await new Promise(resolve => { release = resolve; });
        try { await context.beforeCommit(); mutated = true; } catch (error) { lateError = error; throw error; }
    });
    await expect(h.service.execute(principal, { confirmationToken: review.confirmationToken })).rejects.toMatchObject({ statusCode: 503 });
    expect(observedSignal.aborted).toBe(true); release(); await new Promise(resolve => setImmediate(resolve));
    expect(mutated).toBe(false); expect(lateError).toMatchObject({ statusCode: 503 });
});

test('lost native acknowledgement is recovered by outcome, never converted to another operation', async () => {
    const h = setup(), review = await h.prepare(), input = { confirmationToken: review.confirmationToken };
    const nativeCommit = h.adapter.commit.getMockImplementation();
    h.adapter.commit.mockImplementation(async (...args) => { await nativeCommit(...args); throw invalid(); });
    await expect(h.service.execute(principal, input)).rejects.toMatchObject({ statusCode: 503 });
    expect((await h.service.outcome(principal, input)).status).toBe('succeeded');
    expect((await h.service.execute(principal, input)).status).toBe('succeeded');
    expect(h.adapter.commit).toHaveBeenCalledTimes(1); expect(h.receipts.size).toBe(1);
});

test('malformed or foreign receipts never become a successful response', async () => {
    const h = setup(), review = await h.prepare();
    h.adapter.outcome.mockResolvedValue({ operationId: review.operationId, commandSha256: 'a'.repeat(64), status: 'succeeded',
        version: 'b'.repeat(64), occurredAt: NOW, privateDiagnostic: 'PRIVATE' });
    await expect(h.service.execute(principal, { confirmationToken: review.confirmationToken })).rejects.toMatchObject({ code: 'dashboard_admin_unavailable' });
    expect(h.adapter.commit).not.toHaveBeenCalled();
});

test('lost confirmation upload acknowledgement is reconciled to exact immutable command once', async () => {
    const h = setup(); h.state.loseUploadAck = true;
    const review = await h.prepare();
    expect(await h.store.load(tokenDigest(review.confirmationToken))).toMatchObject({ operationId: review.operationId });
    expect(h.writes).toHaveLength(1);
});

test('confirmation admission failure prevents token disclosure and every native effect', async () => {
    const h = setup(); h.state.loseUploadAck = true; h.state.uploadEffect = false;
    await expect(h.prepare()).rejects.toMatchObject({ statusCode: 503 });
    expect(h.adapter.commit).not.toHaveBeenCalled(); expect(h.receipts.size).toBe(0);
});

test('immutable store refuses collision overwrite and malformed stored bytes', async () => {
    const h = setup(), review = await h.prepare(), key = tokenDigest(review.confirmationToken), original = await h.store.load(key);
    const changed = { ...original, patch: { displayLabel: 'Changed label' } }; changed.commandSha256 = commandDigest(changed);
    await expect(h.store.create(key, actionCommand(changed), async () => true)).rejects.toMatchObject({ statusCode: 503 });
    expect(await h.store.load(key)).toEqual(original);
    h.blobs.set(PREFIX + key + '.json', Buffer.from('{"bad":"record"}'));
    await expect(h.store.load(key)).rejects.toMatchObject({ statusCode: 503 });
});

test('confirmation storage binds immutable content to the exact token digest path', async () => {
    const h = setup(), review = await h.prepare(), key = tokenDigest(review.confirmationToken), other = 'a'.repeat(64);
    h.blobs.set(PREFIX + other + '.json', h.blobs.get(PREFIX + key + '.json'));
    await expect(h.store.load(other)).rejects.toMatchObject({ statusCode: 503 });
});

test('token codec rejects extra target/action fields and noncanonical base64', () => {
    const token = Buffer.alloc(32, 1).toString('base64url');
    expect(confirmationInput({ confirmationToken: token })).toEqual({ confirmationToken: token });
    expect(() => confirmationInput({ confirmationToken: token, selector })).toThrow();
    expect(() => confirmationInput({ confirmationToken: token.slice(0, -1) + 'B' })).toThrow();
});


test.each([undefined, '', 'wrong organisation', 'Immutable Accepted Organisation '])('removal requires the exact typed organisation name: %p', async confirmationName => {
    const h = setup();
    await expect(h.service.prepare(principal, { selector, action: 'delete', patch: null,
        ...(confirmationName === undefined ? {} : { confirmationName }) })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.writes).toEqual([]); expect(h.adapter.commit).not.toHaveBeenCalled();
});
test('typed removal confirmation is checked but not retained in the command or response', async () => {
    const h = setup(), prepared = await h.prepare('delete');
    const command = await h.store.load(tokenDigest(prepared.confirmationToken));
    expect(command).not.toHaveProperty('confirmationName');
    expect(prepared).not.toHaveProperty('confirmationName');
    expect(command.action).toBe('delete');
});


test('soft deletion requires typed canonical name and separate action permission', async () => {
    const h = setup(); h.state.actions.push('archive');
    await expect(h.service.prepare(principal, { selector, action: 'archive', patch: null })).rejects.toHaveProperty('statusCode', 400);
    await expect(h.service.prepare(principal, { selector, action: 'archive', patch: null, confirmationName: 'Immutable Accepted Organisation' })).resolves.toHaveProperty('action', 'archive');
});
