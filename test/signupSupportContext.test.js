'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { withSignupSupportContext, annotateSignupDiagnostic } = require('../api/shared/customerSignup/signupSupportContext');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { customerSignupErrorResponse, CustomerSignupRuntimeError } = require('../api/shared/customerSignup/customerSignupRuntime');

const AT = Date.parse('2026-10-13T12:00:00.000Z');
const PRIVATE = 'SYNTHETIC_COOKIE_TOKEN_PROVIDER_OR_CUSTOMER_DATA_DO_NOT_CAPTURE';
const REF_A = 'NF-0123456789ABCDEF', REF_B = 'NF-FEDCBA9876543210';
const SUPPORT = 'X-NoFries-Support-Reference', SHA = 'X-NoFries-Release-Sha', RUN = 'X-NoFries-Release-Run-Id';
const release = Object.freeze({ schemaVersion: 2, releaseSha: 'a'.repeat(40), runId: '38366056067', runAttempt: '1' });
const options = (reference = REF_A) => ({ newReference: () => reference, readReleaseIdentity: () => null });
const unavailable = () => ({ status: 503, body: Object.freeze({ error: 'Signup is unavailable', code: 'signup_unavailable' }) });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const settled = () => new Promise(resolve => setImmediate(resolve));
function diagnostics(sink, now = () => AT) {
    return createSignupDiagnostics({ now, sink });
}
function expectedEvent(reference, stage = 'setup_save') {
    return { timestamp: new Date(AT).toISOString(), code: 'signup_state_unavailable', stage,
        ...(reference ? { supportReference: reference } : {}) };
}

test('one original failure shares its server reference with nested existing diagnostics and preserves response data', async () => {
    const events = [], report = diagnostics(event => events.push(event));
    const original = unavailable();
    original.headers = { 'Cache-Control': 'private, no-store', 'Set-Cookie': [PRIVATE], 'Content-Type': 'application/json' };
    const result = await withSignupSupportContext(async () => {
        report('setup_save', new Error(PRIVATE));
        await settled();
        report('setup_claim', Object.assign(new Error(PRIVATE), { code: 'starter_store_unavailable', body: PRIVATE }));
        return original;
    }, options());
    expect(result.status).toBe(original.status); expect(result.body).toBe(original.body);
    expect(result.headers).toEqual({ ...original.headers, [SUPPORT]: REF_A,
        'X-NoFries-Signup-Stage': 'workspace_details', 'X-NoFries-Signup-Reason': 'step_unconfirmed' });
    expect(result.headers['Set-Cookie']).toBe(original.headers['Set-Cookie']);
    expect(original.headers).not.toHaveProperty(SUPPORT);
    expect(events).toEqual([expectedEvent(REF_A), { ...expectedEvent(REF_A, 'setup_claim'), code: 'starter_store_unavailable' }]);
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    expect(events.every(Object.isFrozen)).toBe(true);
});

test('interleaved requests remain separate even when the second request finishes first', async () => {
    const events = [], report = diagnostics(event => events.push(event)), gateA = deferred(), gateB = deferred();
    const first = withSignupSupportContext(async () => {
        report('setup_save'); await gateA.promise; report('setup_claim'); return unavailable();
    }, options(REF_A));
    const second = withSignupSupportContext(async () => {
        report('customer_session'); await gateB.promise; report('terms_offer'); return unavailable();
    }, options(REF_B));
    gateB.resolve(); const secondResult = await second;
    report('signup_state'); // No explicit HTTP scope here, despite a pending request.
    gateA.resolve(); const firstResult = await first;
    expect(firstResult.headers[SUPPORT]).toBe(REF_A); expect(secondResult.headers[SUPPORT]).toBe(REF_B);
    expect(events).toEqual([expectedEvent(REF_A), expectedEvent(REF_B, 'customer_session'),
        expectedEvent(REF_B, 'terms_offer'), expectedEvent(null, 'signup_state'), expectedEvent(REF_A, 'setup_claim')]);
});

test('a nested scope restores its parent and never transfers its emitted-event flag', async () => {
    const events = [], report = diagnostics(event => events.push(event));
    let inner;
    const outer = await withSignupSupportContext(async () => {
        inner = await withSignupSupportContext(() => { report('setup_save'); return unavailable(); }, options(REF_B));
        return unavailable();
    }, options(REF_A));
    expect(inner.headers[SUPPORT]).toBe(REF_B); expect(outer).not.toHaveProperty('headers');
    const resumed = await withSignupSupportContext(async () => {
        report('customer_session');
        await withSignupSupportContext(() => { report('setup_save'); return unavailable(); }, options(REF_B));
        report('setup_claim'); return unavailable();
    }, options(REF_A));
    expect(resumed.headers[SUPPORT]).toBe(REF_A);
    expect(events.slice(1)).toEqual([expectedEvent(REF_A, 'customer_session'), expectedEvent(REF_B), expectedEvent(REF_A, 'setup_claim')]);
});

test('delayed diagnostics after completion and delayed sink work cannot borrow another active reference', async () => {
    const events = [], sinkGate = deferred(), lateGate = deferred(), outerGate = deferred();
    const report = diagnostics(event => { events.push(event); return sinkGate.promise; });
    let late;
    const first = await withSignupSupportContext(() => {
        report('setup_save');
        late = lateGate.promise.then(() => report('setup_claim'));
        return unavailable();
    }, options(REF_A));
    const second = withSignupSupportContext(async () => {
        report('customer_session'); await outerGate.promise; return unavailable();
    }, options(REF_B));
    lateGate.resolve(); await late;
    sinkGate.reject(new Error(PRIVATE)); await settled();
    outerGate.resolve(); const next = await second;
    expect(first.headers[SUPPORT]).toBe(REF_A); expect(next.headers[SUPPORT]).toBe(REF_B);
    expect(events).toEqual([expectedEvent(REF_A), expectedEvent(REF_B, 'customer_session'), expectedEvent(null, 'setup_claim')]);
    expect(events[0]).toEqual(expectedEvent(REF_A));
});

test('a nested delayed timer remains uncorrelated while its parent scope is still active', async () => {
    const events = [], report = diagnostics(event => events.push(event));
    const done = deferred();
    const result = await withSignupSupportContext(async () => {
        await withSignupSupportContext(() => {
            setImmediate(() => { report('setup_claim'); done.resolve(); });
            report('setup_save'); return unavailable();
        }, options(REF_B));
        await done.promise;
        report('customer_session'); return unavailable();
    }, options(REF_A));
    expect(result.headers[SUPPORT]).toBe(REF_A);
    expect(events).toEqual([expectedEvent(REF_B), expectedEvent(null, 'setup_claim'), expectedEvent(REF_A, 'customer_session')]);
});

test('repeated requests use fresh server entropy and a later status check never inherits the earlier reference', async () => {
    const events = [], report = diagnostics(event => events.push(event));
    const results = [];
    for (let n = 0; n < 3; n++) results.push(await withSignupSupportContext(() => {
        report(n ? 'signup_state' : 'setup_save'); return unavailable();
    }, { readReleaseIdentity: () => null }));
    const refs = results.map(result => result.headers[SUPPORT]);
    expect(refs.every(value => value.length === 19 && /^NF-[A-F0-9]{16}$/.test(value))).toBe(true);
    expect(new Set(refs).size).toBe(3);
    expect(events.map(event => event.supportReference)).toEqual(refs);
});

test.each([401, 403, 503])('status%s keeps its original cookie/status/body contracts', async status => {
    const events = [], report = diagnostics(event => events.push(event));
    const original = status === 401 ? customerSignupErrorResponse(new CustomerSignupRuntimeError(401, 'signup_signin_required'))
        : customerSignupErrorResponse(new CustomerSignupRuntimeError(status, status === 403 ? 'signup_csrf_invalid' : 'signup_unavailable'));
    const result = await withSignupSupportContext(() => { report('customer_session'); return original; }, options());
    expect(result).toEqual({ ...original, headers: { ...(original.headers || {}), [SUPPORT]: REF_A } });
    expect(result.body).toBe(original.body);
    if (status === 401) expect(result.headers['Set-Cookie']).toBe(original.headers['Set-Cookie']);
});

test('HTTP200 unavailable carries correlation without changing the strict state body', async () => {
    const report = diagnostics(() => {}), original = { status: 200, body: Object.freeze({ state: Object.freeze({ status: 'unavailable' }) }) };
    const result = await withSignupSupportContext(() => { report('terms_offer'); return original; }, options());
    expect(result.status).toBe(200); expect(result.body).toBe(original.body);
    expect(result.headers).toEqual({ [SUPPORT]: REF_A,
        'X-NoFries-Signup-Stage': 'terms_review', 'X-NoFries-Signup-Reason': 'step_unconfirmed' });
});

test.each([200, 202, 204, 303])('successful status%s never publishes a reference or release pair even if a diagnostic occurred', async status => {
    const report = diagnostics(() => {}), original = { status, headers: { 'Cache-Control': 'no-store' }, body: { state: { status: 'pending_preparation' } } };
    const result = await withSignupSupportContext(() => { report('setup_save'); return original; },
        { ...options(), readReleaseIdentity: () => release });
    expect(result).toBe(original);
});

test.each([unavailable(), { status: 200, body: { state: { status: 'unavailable' } } }])
('failure without an existing diagnostic remains uncorrelated', async original => {
    expect(await withSignupSupportContext(() => original, options())).toBe(original);
});

test('original stamped release pair can accompany a failure without fabricating a diagnostic reference', async () => {
    const original = unavailable();
    const result = await withSignupSupportContext(() => original, { ...options(), readReleaseIdentity: () => release });
    expect(result.headers).toEqual({ [SHA]: release.releaseSha, [RUN]: release.runId });
    expect(result.body).toBe(original.body); expect(result.status).toBe(original.status);
});

test('release identity is snapshotted before asynchronous work and no later version is substituted', async () => {
    const stamp = { ...release }, gate = deferred(), original = unavailable();
    const reader = jest.fn(() => stamp);
    const pending = withSignupSupportContext(async () => { await gate.promise; return original; },
        { ...options(), readReleaseIdentity: reader });
    stamp.releaseSha = 'b'.repeat(40); stamp.runId = '111'; gate.resolve();
    const result = await pending;
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.headers).toEqual({ [SHA]: release.releaseSha, [RUN]: release.runId });
});

test.each([
    null, {}, { ...release, schemaVersion: 1 }, { ...release, releaseSha: 'A'.repeat(40) },
    { ...release, releaseSha: 'main' }, { ...release, releaseSha: 'a'.repeat(40) + '\n' },
    { ...release, runId: 123 }, { ...release, runId: '0' }, { ...release, runId: '001' },
    { ...release, runId: '1'.repeat(21) }, { ...release, runId: '123\n' },
    { releaseSha: release.releaseSha }, { runId: release.runId },
    Object.create(release), [release], PRIVATE
])('malformed or incomplete release identity is omitted as a pair', async identity => {
    const original = unavailable();
    expect(await withSignupSupportContext(() => original, { ...options(), readReleaseIdentity: () => identity })).toBe(original);
});

test.each(['', PRIVATE, 'NF-short', REF_A.toLowerCase(), REF_A + '\n', ' ' + REF_A, REF_A + ',' + REF_B, 42, null])
('invalid entropy result cannot become a support reference', async reference => {
    const events = [], report = diagnostics(event => events.push(event)), original = unavailable();
    const result = await withSignupSupportContext(() => { report('setup_save'); return original; }, options(reference));
    expect(result).toBe(original); expect(events).toEqual([expectedEvent(null)]);
});

test.each(['newReference', 'readReleaseIdentity'])('throwing, rejecting and hanging%s sources never change or delay the operation', async key => {
    for (const reader of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE)), () => new Promise(() => {})]) {
        const original = unavailable(), action = jest.fn(() => original);
        const selected = { newReference: () => '', readReleaseIdentity: () => null, [key]: reader };
        expect(await withSignupSupportContext(action, selected)).toBe(original);
        expect(action).toHaveBeenCalledTimes(1);
    }
    await settled();
});

test('invalid option objects and dependency accessors or proxies are never evaluated', async () => {
    const getter = jest.fn(() => { throw new Error(PRIVATE); }), trap = jest.fn(() => { throw new Error(PRIVATE); });
    const revocable = Proxy.revocable({}, { getOwnPropertyDescriptor: trap }); revocable.revoke();
    const choices = [new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }), revocable.proxy,
        Object.defineProperties({}, { newReference: { get: getter }, readReleaseIdentity: { get: getter } }),
        { newReference: new Proxy(() => REF_A, { apply: trap }), readReleaseIdentity: new Proxy(() => release, { apply: trap }) }];
    for (const selected of choices) {
        const original = unavailable();
        expect(await withSignupSupportContext(() => original, selected)).toBe(original);
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test('release getters and proxies cannot expose private data or run traps', async () => {
    const getter = jest.fn(() => PRIVATE), trap = jest.fn(() => { throw new Error(PRIVATE); });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const values = [Object.defineProperty({ ...release }, 'releaseSha', { get: getter }),
        new Proxy(release, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }), revoked.proxy];
    for (const value of values) {
        const original = unavailable();
        expect(await withSignupSupportContext(() => original, { ...options(), readReleaseIdentity: () => value })).toBe(original);
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test.each([200, 503])('only owned metadata header names are stripped from status%s and cannot be spoofed by the returned result', async status => {
    const cookie = [PRIVATE], body = { state: { status: 'setup_details' } };
    const original = { status, body, headers: { 'x-Nofries-SUPPORT-reference': REF_B,
        'X-NoFries-Release-Sha': PRIVATE, 'x-nofries-release-run-id': '999', 'Set-Cookie': cookie,
        'Cache-Control': 'private, no-store', 'X-NoFries-Support-Reference-Other': 'preserved' } };
    const result = await withSignupSupportContext(() => original, options());
    expect(result.headers).toEqual({ 'Set-Cookie': cookie, 'Cache-Control': 'private, no-store', 'X-NoFries-Support-Reference-Other': 'preserved' });
    expect(result.body).toBe(body); expect(result.headers['Set-Cookie']).toBe(cookie);
    expect(original.headers['x-Nofries-SUPPORT-reference']).toBe(REF_B);
});

test('a failed result cannot override the generated reference or original release pair', async () => {
    const report = diagnostics(() => {}), original = unavailable();
    original.headers = { [SUPPORT]: REF_B, [SHA]: 'b'.repeat(40), [RUN]: '999' };
    const result = await withSignupSupportContext(() => { report('setup_save'); return original; }, { ...options(), readReleaseIdentity: () => release });
    expect(result.headers).toEqual({ [SUPPORT]: REF_A, [SHA]: release.releaseSha, [RUN]: release.runId,
        'X-NoFries-Signup-Stage': 'workspace_details', 'X-NoFries-Signup-Reason': 'step_unconfirmed' });
});

test('unsafe response objects/accessors/proxies are preserved without evaluating them or adding metadata', async () => {
    const getter = jest.fn(() => PRIVATE), trap = jest.fn(() => { throw new Error(PRIVATE); });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const objects = [Object.defineProperty({ body: {} }, 'status', { get: getter }),
        Object.defineProperty(unavailable(), 'headers', { get: getter }),
        { ...unavailable(), headers: Object.defineProperty({}, 'Set-Cookie', { get: getter }) },
        { ...unavailable(), headers: new Proxy({}, { get: trap, getPrototypeOf: trap }) },
        new Proxy(unavailable(), { get: trap, getPrototypeOf: trap, ownKeys: trap }), revoked.proxy];
    for (const original of objects) {
        const report = diagnostics(() => {});
        expect(withSignupSupportContext(() => { report('setup_save'); return original; },
            { ...options(), readReleaseIdentity: () => release })).toBe(original);
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

test('a body/state accessor cannot turn a successful response into a correlated unavailable response', async () => {
    const getter = jest.fn(() => ({ status: 'unavailable' })), report = diagnostics(() => {});
    for (const body of [Object.defineProperty({}, 'state', { get: getter }),
        { state: Object.defineProperty({}, 'status', { get: getter }) }, new Proxy({}, { get: getter })]) {
        const original = { status: 200, body };
        expect(await withSignupSupportContext(() => { report('terms_offer'); return original; }, options())).toBe(original);
    }
    expect(getter).not.toHaveBeenCalled();
});

test('diagnostic sink throws/rejections preserve application failure and frozen attempted-event metadata', async () => {
    for (const sink of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE))]) {
        const seen = [], report = diagnostics(event => { seen.push(event); return sink(); }), original = unavailable();
        const result = await withSignupSupportContext(() => { report('setup_save'); return original; }, options());
        expect(result.body).toBe(original.body); expect(result.status).toBe(original.status);
        expect(result.headers[SUPPORT]).toBe(REF_A); expect(seen).toEqual([expectedEvent(REF_A)]);
        expect(Object.isFrozen(seen[0])).toBe(true);
    }
    await settled();
});

test('a failed diagnostic clock produces neither an event nor a fabricated correlation header', async () => {
    for (const clock of [() => NaN, () => -1, () => { throw new Error(PRIVATE); }]) {
        const sink = jest.fn(), report = diagnostics(sink, clock), original = unavailable();
        expect(await withSignupSupportContext(() => { report('setup_save'); return original; }, options())).toBe(original);
        expect(sink).not.toHaveBeenCalled();
    }
});

test('the original action rejection propagates unchanged and deactivates inherited late diagnostics', async () => {
    const thrown = new Error(PRIVATE), gate = deferred(), events = [], report = diagnostics(event => events.push(event));
    let late;
    await expect(withSignupSupportContext(async () => {
        late = gate.promise.then(() => report('setup_claim')); throw thrown;
    }, options())).rejects.toBe(thrown);
    gate.resolve(); await late;
    expect(events).toEqual([expectedEvent(null, 'setup_claim')]);
});

test('the stored async context contains only generated reference and flags, not a request or caller fields', async () => {
    const run = AsyncLocalStorage.prototype.run, stores = [];
    const spy = jest.spyOn(AsyncLocalStorage.prototype, 'run').mockImplementation(function (store, action, ...args) {
        stores.push(store); return run.call(this, store, action, ...args);
    });
    try {
        const caller = { headers: { cookie: PRIVATE, [SUPPORT]: REF_B }, body: { customerId: PRIVATE } };
        await withSignupSupportContext(() => ({ status: 200, body: caller.body }), { ...options(), request: caller, providerId: PRIVATE });
        expect(stores).toHaveLength(1);
        expect(stores[0]).toEqual({ active: false, reference: REF_A, emitted: false });
        expect(JSON.stringify(stores)).not.toContain(PRIVATE); expect(JSON.stringify(stores)).not.toContain(REF_B);
    } finally { spy.mockRestore(); }
});

test('annotation does not create events and leaves unsafe/non-builder-shaped events unchanged', async () => {
    const getter = jest.fn(() => PRIVATE), trap = jest.fn(() => PRIVATE);
    const valid = Object.freeze(expectedEvent(null));
    const malformed = [{ ...valid }, Object.freeze({ ...valid, cookie: PRIVATE }),
        Object.freeze({ ...valid, stage: PRIVATE }), Object.freeze({ ...valid, timestamp: PRIVATE }),
        Object.freeze(Object.defineProperty({ ...valid }, 'code', { get: getter })), new Proxy(valid, { get: trap })];
    const original = unavailable();
    expect(await withSignupSupportContext(() => {
        for (const event of malformed) expect(annotateSignupDiagnostic(event)).toBe(event);
        return original;
    }, options())).toBe(original);
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    expect(annotateSignupDiagnostic(valid)).toBe(valid);
});
