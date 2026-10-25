const runHealth = require('../api/health');
const { getServiceDeskHealth } = require('../api/shared/serviceDeskHealth');

function autotaskEnv(overrides = {}) {
    return Object.assign({
        NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
        NOFRIES_SERVICE_DESK_STORAGE_PROVIDER: 'azure',
        NOFRIES_SERVICE_DESK_OPERATION_STORAGE_PROVIDER: 'azure',
        NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'production-scope',
        NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID: 'production-account',
        NOFRIES_AUTOTASK_API_URL: 'https://webservices1.autotask.net/atservicesrest/v1.0',
        NOFRIES_AUTOTASK_USERNAME: 'health@example.test',
        NOFRIES_AUTOTASK_SECRET: 'credential-one',
        NOFRIES_AUTOTASK_INTEGRATION_CODE: 'integration-one'
    }, overrides);
}

function readyRuntime(health = jest.fn(async () => ({
    connected: true,
    checkedAt: new Date().toISOString()
}))) {
    return {
        health,
        status: () => ({
            configured: true,
            mode: 'readonly',
            writeScope: 'disabled',
            writeScopeReady: false,
            writeOperationsEnabled: false,
            durableOperationFence: true,
            crossInstanceExclusive: true,
            leaseRenewal: true,
            immutableOperationBinding: true,
            terminalReceiptArchive: true,
            boundedDuplicateIntentIndex: true,
            providerAccountReady: true,
            portalVisibilityReady: true,
            priorityMappingVerified: true,
            dattoRmmSourceMappingReady: true,
            statusWritesEnabled: false
        })
    };
}

function emergencyReadOnlyEnv(overrides = {}) {
    return Object.assign({
        NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
        NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true',
        NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'false',
        NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'disabled',
        NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'disabled',
        NOFRIES_AUTOTASK_MODE: 'readonly',
        NOFRIES_AUTOTASK_WRITE_ENABLED: 'false',
        NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'false',
        NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
    }, overrides);
}

describe('production health service-desk controls', () => {
    test('emits the exact non-secret service desk, lifecycle and controls digest contract', async () => {
        const context = {};
        await runHealth(context, {}, {
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => ({ enabled: true, status: 'healthy' }),
            getServiceDeskHealth: () => ({
                provider: 'autotask',
                storageProvider: 'azure',
                operationStorageProvider: 'azure',
                durable: true,
                ready: true,
                dattoRmmSourceMappingReady: true,
                statusWritesEnabled: false
            }),
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true }),
            getServiceDeskControlsDigest: () => 'b'.repeat(64)
        });
        expect(context.res).toMatchObject({
            status: 200,
            body: {
                status: 'ok',
                serviceDeskControls: 'b'.repeat(64),
                serviceDesk: {
                    provider: 'autotask',
                    storageProvider: 'azure',
                    operationStorageProvider: 'azure',
                    durable: true,
                    ready: true,
                    dattoRmmSourceMappingReady: true,
                    statusWritesEnabled: false
                },
                lifecycle: { storageProvider: 'azure', durable: true, ready: true }
            }
        });
    });

    test('fails closed when the controls digest is absent', async () => {
        const context = {};
        await runHealth(context, {}, {
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => ({ enabled: true, status: 'ready' }),
            getServiceDeskHealth: () => ({ ready: true }),
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true }),
            getServiceDeskControlsDigest: () => ''
        });
        expect(context.res).toMatchObject({ status: 503, body: { code: 'service_desk_runtime_unavailable' } });
    });

    test('accepts a disabled monthly Proof scheduler only for the exact emergency read-only vector', async () => {
        const context = {};
        await runHealth(context, {}, {
            env: emergencyReadOnlyEnv(),
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => ({ enabled: false, status: 'disabled' }),
            getServiceDeskHealth: () => ({ provider: 'autotask', durable: true, ready: true }),
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true }),
            getServiceDeskControlsDigest: () => 'b'.repeat(64)
        });
        expect(context.res).toMatchObject({
            status: 200,
            body: {
                status: 'ok',
                monthlyProofScheduler: { enabled: false, status: 'disabled' },
                lifecycle: { storageProvider: 'azure', durable: true, ready: true }
            }
        });
    });

    test.each([
        ['service-desk provider not Autotask', { NOFRIES_SERVICE_DESK_PROVIDER: 'mock' }],
        ['portal disabled', { NOFRIES_CUSTOMER_PORTAL_ENABLED: 'false' }],
        ['portal writes enabled', { NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'true' }],
        ['portal write scope governed', { NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'governed' }],
        ['service-desk write scope governed', { NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'governed' }],
        ['Autotask controlled writes selected', { NOFRIES_AUTOTASK_MODE: 'controlled_write' }],
        ['Autotask write flag enabled', { NOFRIES_AUTOTASK_WRITE_ENABLED: 'true' }],
        ['scheduler setting enabled', { NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'true' }],
        ['lifecycle storage not durable', { NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'local' }]
    ])('rejects a disabled scheduler when the emergency vector drifts: %s', async (label, override) => {
        const context = {};
        await runHealth(context, {}, {
            env: emergencyReadOnlyEnv(override),
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => ({ enabled: false, status: 'disabled' }),
            getServiceDeskHealth: () => ({ provider: 'autotask', durable: true, ready: true }),
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true }),
            getServiceDeskControlsDigest: () => 'b'.repeat(64)
        });
        expect(context.res).toMatchObject({
            status: 503,
            body: { status: 'unavailable', code: 'monthly_proof_runtime_unavailable' }
        });
    });

    test('rejects a lone disabled scheduler and a missing scheduler after production selection', async () => {
        const disabled = {};
        await runHealth(disabled, {}, {
            env: { NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'false' },
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => ({ enabled: false, status: 'disabled' }),
            getServiceDeskHealth: () => null,
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true })
        });
        expect(disabled.res).toMatchObject({
            status: 503,
            body: { code: 'monthly_proof_runtime_unavailable' }
        });

        const absent = {};
        await runHealth(absent, {}, {
            env: { NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true' },
            getReleaseIdentity: () => ({ releaseSha: 'a'.repeat(40), runId: '123' }),
            getMonthlyProofSchedulerHealth: () => null,
            getServiceDeskHealth: () => null
        });
        expect(absent.res).toMatchObject({
            status: 503,
            body: { code: 'monthly_proof_runtime_unavailable' }
        });
    });

    test('keeps durable provider reads healthy while every write scope is emergency-disabled', async () => {
        const runtime = readyRuntime();
        const health = await getServiceDeskHealth(autotaskEnv(), {
            providerHealthCache: new Map(),
            runtime
        });
        expect(health).toMatchObject({
            mode: 'readonly',
            durable: true,
            ready: true,
            connected: true,
            providerHealthFresh: true,
            writeOperationsEnabled: false,
            statusWritesEnabled: false
        });
        expect(runtime.health).toHaveBeenCalledTimes(1);
    });

    test('single-flights concurrent anonymous health probes for one exact provider configuration', async () => {
        let resolveProbe;
        const providerProbe = new Promise((resolve) => { resolveProbe = resolve; });
        const runtime = readyRuntime(jest.fn(() => providerProbe));
        const cache = new Map();
        const first = getServiceDeskHealth(autotaskEnv(), { runtime, providerHealthCache: cache });
        const second = getServiceDeskHealth(autotaskEnv(), { runtime, providerHealthCache: cache });

        await Promise.resolve();
        expect(runtime.health).toHaveBeenCalledTimes(1);
        resolveProbe({ connected: true, checkedAt: new Date().toISOString() });
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ ready: true }),
            expect.objectContaining({ ready: true })
        ]);
    });

    test('bounds a stalled probe and negative-caches the fail-closed result', async () => {
        jest.useFakeTimers({ now: new Date('2026-09-01T00:00:00.000Z') });
        try {
            const runtime = readyRuntime(jest.fn(() => new Promise(() => {})));
            const cache = new Map();
            const dependencies = {
                runtime,
                providerHealthCache: cache,
                probeTimeoutMs: 50,
                failureTtlMs: 100
            };
            const first = getServiceDeskHealth(autotaskEnv(), dependencies);
            const concurrent = getServiceDeskHealth(autotaskEnv(), dependencies);
            await jest.advanceTimersByTimeAsync(50);
            await expect(Promise.all([first, concurrent])).resolves.toEqual([
                expect.objectContaining({ ready: false, connected: false, providerHealthState: 'unavailable' }),
                expect.objectContaining({ ready: false, connected: false, providerHealthState: 'unavailable' })
            ]);
            expect(runtime.health).toHaveBeenCalledTimes(1);

            await expect(getServiceDeskHealth(autotaskEnv(), dependencies))
                .resolves.toMatchObject({ ready: false, providerHealthState: 'unavailable' });
            expect(runtime.health).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(101);
            const retry = getServiceDeskHealth(autotaskEnv(), dependencies);
            await jest.advanceTimersByTimeAsync(50);
            await expect(retry).resolves.toMatchObject({ ready: false, providerHealthState: 'unavailable' });
            expect(runtime.health).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('does not reuse successful health across credential or API endpoint changes', async () => {
        const runtime = readyRuntime();
        const cache = new Map();
        const dependencies = { runtime, providerHealthCache: cache };

        await expect(getServiceDeskHealth(autotaskEnv(), dependencies)).resolves.toMatchObject({ ready: true });
        await expect(getServiceDeskHealth(autotaskEnv(), dependencies)).resolves.toMatchObject({ ready: true });
        expect(runtime.health).toHaveBeenCalledTimes(1);

        await expect(getServiceDeskHealth(autotaskEnv({ NOFRIES_AUTOTASK_SECRET: 'credential-two' }), dependencies))
            .resolves.toMatchObject({ ready: true });
        await expect(getServiceDeskHealth(autotaskEnv({
            NOFRIES_AUTOTASK_SECRET: 'credential-two',
            NOFRIES_AUTOTASK_API_URL: 'https://webservices2.autotask.net/atservicesrest/v1.0'
        }), dependencies)).resolves.toMatchObject({ ready: true });
        expect(runtime.health).toHaveBeenCalledTimes(3);
    });

    test('replaces an expired success with a fail-closed provider result', async () => {
        jest.useFakeTimers({ now: new Date('2026-09-01T00:00:00.000Z') });
        try {
            const health = jest.fn()
                .mockResolvedValueOnce({ connected: true, checkedAt: new Date().toISOString() })
                .mockRejectedValueOnce(new Error('provider unavailable'));
            const runtime = readyRuntime(health);
            const dependencies = {
                runtime,
                providerHealthCache: new Map(),
                probeTtlMs: 100,
                failureTtlMs: 100
            };
            await expect(getServiceDeskHealth(autotaskEnv(), dependencies))
                .resolves.toMatchObject({ ready: true, connected: true });

            await jest.advanceTimersByTimeAsync(101);
            await expect(getServiceDeskHealth(autotaskEnv(), dependencies)).resolves.toMatchObject({
                ready: false,
                connected: false,
                providerHealthFresh: false,
                providerHealthState: 'unavailable'
            });
            expect(health).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('rejects stale or future provider timestamps instead of caching them as healthy', async () => {
        const now = new Date('2026-09-01T00:00:30.000Z');
        const stale = readyRuntime(jest.fn(async () => ({
            connected: true,
            checkedAt: '2026-09-01T00:00:00.000Z'
        })));
        await expect(getServiceDeskHealth(autotaskEnv(), {
            runtime: stale,
            providerHealthCache: new Map(),
            now: () => now,
            probeTtlMs: 100
        })).resolves.toMatchObject({
            ready: false,
            connected: false,
            providerHealthFresh: false,
            providerHealthState: 'stale'
        });

        const future = readyRuntime(jest.fn(async () => ({
            connected: true,
            checkedAt: '2026-09-01T00:00:31.000Z'
        })));
        await expect(getServiceDeskHealth(autotaskEnv(), {
            runtime: future,
            providerHealthCache: new Map(),
            now: () => now
        })).resolves.toMatchObject({ ready: false, providerHealthState: 'stale' });
    });
});
