'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = global.test || require('node:test');
const { createDashboardReadiness } = require('../api/shared/appLifecycle/dashboardReadiness');
const { NOW } = require('./fixtures/dashboardFixture');
const healthy = () => ({ ready: true });
const adapters = overrides => ({ identity: healthy, snapshotStore: healthy, auditStore: healthy,
    clock: () => NOW, ...overrides });

test('dashboard readiness needs only identity, snapshot and audit dependencies, with immutable closed output', async () => {
    const result = await createDashboardReadiness(adapters())();
    assert.deepEqual(result, { schemaVersion: 1, capability: 'dashboard', ready: true, checkedAt: NOW,
        dependencies: { identity: 'ready', snapshotStore: 'ready', auditStore: 'ready' } });
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.dependencies));
});

for (const dependency of ['identity', 'snapshotStore', 'auditStore']) {
    test(`${dependency} unavailable fails dashboard readiness`, async () => {
        const result = await createDashboardReadiness(adapters({ [dependency]: () => ({ ready: false }) }))();
        assert.equal(result.ready, false); assert.equal(result.dependencies[dependency], 'unavailable');
    });
}

test('probes run concurrently, time out with cooperative cancellation and ignore late readiness', async () => {
    const started = [], late = [];
    let aborted = false;
    const inspect = createDashboardReadiness(adapters({
        identity: () => { started.push('identity'); return new Promise(resolve => late.push(resolve)); },
        snapshotStore: () => { started.push('snapshotStore'); return { ready: true }; },
        auditStore: ({ cancellation }) => { started.push('auditStore'); cancellation.onCancel(() => { aborted = true; });
            return new Promise(() => {}); }
    }), 10);
    const result = await inspect();
    assert.deepEqual(started.sort(), ['identity', 'snapshotStore', 'auditStore'].sort());
    assert.equal(result.ready, false); assert.equal(result.dependencies.identity, 'timed_out');
    assert.equal(result.dependencies.auditStore, 'timed_out'); assert.equal(aborted, true);
    late[0]({ ready: true }); await Promise.resolve();
    assert.equal(result.dependencies.identity, 'timed_out');
});

test('timeout cancellation contains thrown and rejected cleanup errors without crashing or leaking', () => {
    const script = `
        const assert = require('node:assert/strict');
        const { createDashboardReadiness } = require(${JSON.stringify(require.resolve('../api/shared/appLifecycle/dashboardReadiness'))});
        const sentinel = 'synthetic-cancellation-secret';
        let notified = 0, removed = 0, token;
        const inspect = createDashboardReadiness({
            identity: () => ({ ready: true }), snapshotStore: () => ({ ready: true }),
            clock: () => ${JSON.stringify(NOW)},
            auditStore: input => {
                token = input.cancellation;
                // Exercise the old native-signal path too: this regression must fail before the fix.
                if (input.signal) {
                    input.signal.addEventListener('abort', () => { throw new Error(sentinel); });
                } else {
                    assert.ok(Object.isFrozen(token));
                    assert.equal(token.isCancelled(), false);
                    token.onCancel(() => { throw new Error(sentinel); });
                    token.onCancel(() => Promise.reject(new Error(sentinel)));
                    token.onCancel(() => { notified += 1; });
                    token.onCancel(() => { removed += 1; })();
                }
                return new Promise(() => {});
            }
        }, 5);
        inspect().then(async result => {
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(result.dependencies.auditStore, 'timed_out');
            assert.equal(result.ready, false);
            assert.equal(notified, 1); assert.equal(removed, 0);
            assert.equal(token.isCancelled(), true);
            token.onCancel(() => { notified += 1; throw new Error(sentinel); });
            assert.equal(notified, 2);
            assert.equal(JSON.stringify(result).includes(sentinel), false);
            process.stdout.write(JSON.stringify(result));
        }).catch(() => { process.exitCode = 2; });
    `;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
        encoding: 'utf8', timeout: 5000
    });
    assert.equal(child.status, 0, 'cancellation cleanup must not terminate the probe process');
    assert.equal(child.error, undefined);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.includes('synthetic-cancellation-secret'), false);
    assert.equal(JSON.parse(child.stdout).dependencies.auditStore, 'timed_out');
});

test('raw adapter payloads, exceptions and accessors never enter telemetry or execute getters', async () => {
    let reads = 0;
    const inspect = createDashboardReadiness(adapters({
        identity: () => { throw new Error('Authorization: secret-token'); },
        snapshotStore: () => ({ ready: true, connectionString: 'secret-password' }),
        auditStore: () => ({ get ready() { reads += 1; return true; } }) }));
    const result = await inspect();
    assert.equal(result.ready, false); assert.equal(reads, 0);
    assert.deepEqual(result.dependencies, { identity: 'unavailable', snapshotStore: 'unavailable', auditStore: 'unavailable' });
    assert.equal(/secret|Authorization|password/.test(JSON.stringify(result)), false);
});

test('a new check observes recovery and clock errors cannot claim current health', async () => {
    let ready = false;
    const inspect = createDashboardReadiness(adapters({ snapshotStore: () => ({ ready }) }));
    assert.equal((await inspect()).ready, false); ready = true;
    assert.equal((await inspect()).ready, true);
    const result = await createDashboardReadiness(adapters({ clock: () => { throw new Error('secret-clock'); } }))();
    assert.equal(result.ready, false); assert.equal(result.checkedAt, null);
});

test('provider probes, missing dashboard dependencies and unbounded timeouts are not accepted', () => {
    assert.throws(() => createDashboardReadiness(adapters({ autotask: healthy })));
    assert.throws(() => createDashboardReadiness({ identity: healthy, snapshotStore: healthy, clock: () => NOW }));
    for (const timeout of [0, -1, 5001, Infinity, '1000']) assert.throws(() => createDashboardReadiness(adapters(), timeout));
});
