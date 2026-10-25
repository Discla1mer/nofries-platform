const {
    AzureSalesWorkspaceRepository,
    DEFAULT_AZURE_STORAGE_TIMEOUT_MS
} = require('../api/shared/salesWorkspaceRepository');

function access() {
    return {
        tenant: {
            id: 'tenant-id',
            key: 'tenant-key',
            name: 'Test tenant',
            slug: 'test-tenant'
        },
        user: {
            email: 'admin@example.com',
            name: 'Admin User',
            role: 'admin'
        }
    };
}

function storedState(revision = 3) {
    return {
        schemaVersion: 1,
        revision,
        tenant: {
            id: 'old-id',
            key: 'old-key',
            name: 'Old tenant',
            slug: 'old-tenant'
        },
        users: {},
        customers: [],
        assessments: [],
        proposals: [],
        dynamicsHandoffs: [],
        audit: []
    };
}

function streamFrom(...chunks) {
    return (async function* readChunks() {
        for (const chunk of chunks) {
            yield chunk;
        }
    }());
}

function createTimerHarness() {
    const timers = [];
    return {
        setTimeout: jest.fn((callback, delay) => {
            const timer = { active: true, callback, delay };
            timers.push(timer);
            return timer;
        }),
        clearTimeout: jest.fn((timer) => {
            timer.active = false;
        }),
        expireNext() {
            const timer = timers.find((entry) => entry.active);
            if (!timer) throw new Error('No active storage deadline');
            timer.active = false;
            timer.callback();
            return timer;
        },
        activeCount() {
            return timers.filter((timer) => timer.active).length;
        }
    };
}

function createAbortHarness() {
    const controllers = [];
    return {
        controllers,
        factory: jest.fn(() => {
            const signal = { aborted: false };
            const controller = {
                signal,
                abort: jest.fn(() => {
                    signal.aborted = true;
                })
            };
            controllers.push(controller);
            return controller;
        })
    };
}

function createRepository(containerClient, timerHarness, abortHarness, options = {}) {
    return new AzureSalesWorkspaceRepository(Object.assign({
        azureSettings: {
            connectionString: 'UseDevelopmentStorage=true',
            accountName: '',
            blobEndpoint: '',
            containerName: 'test-workspaces'
        },
        containerClient,
        storageTimeoutMs: 37,
        setTimeout: timerHarness.setTimeout,
        clearTimeout: timerHarness.clearTimeout,
        abortControllerFactory: abortHarness.factory
    }, options));
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error('Condition was not reached');
}

describe('AzureSalesWorkspaceRepository bounded storage operations', () => {
    test('uses a ten-second default storage deadline', () => {
        expect(DEFAULT_AZURE_STORAGE_TIMEOUT_MS).toBe(10000);
    });

    test('passes abort signals to container init and download while reading every stream chunk', async () => {
        const timers = createTimerHarness();
        const aborts = createAbortHarness();
        const blob = {
            download: jest.fn().mockResolvedValue({
                etag: 'etag-3',
                readableStreamBody: streamFrom(
                    Buffer.from(JSON.stringify(storedState(3)).slice(0, 25)),
                    JSON.stringify(storedState(3)).slice(25)
                )
            })
        };
        const container = {
            createIfNotExists: jest.fn().mockResolvedValue(undefined),
            getBlockBlobClient: jest.fn().mockReturnValue(blob)
        };
        const repository = createRepository(container, timers, aborts);

        const state = await repository.read(access());

        expect(state.revision).toBe(3);
        expect(state.tenant.key).toBe('tenant-key');
        expect(container.createIfNotExists).toHaveBeenCalledWith({
            abortSignal: aborts.controllers[0].signal
        });
        expect(blob.download).toHaveBeenCalledWith(0, undefined, {
            abortSignal: aborts.controllers[1].signal
        });
        expect(timers.activeCount()).toBe(0);
        expect(aborts.controllers.every((controller) => !controller.signal.aborted)).toBe(true);
    });

    test('times out and aborts container initialisation, then clears the cached ready promise', async () => {
        const timers = createTimerHarness();
        const aborts = createAbortHarness();
        const container = {
            createIfNotExists: jest.fn(() => new Promise(() => {})),
            getBlockBlobClient: jest.fn()
        };
        const repository = createRepository(container, timers, aborts);
        const pending = repository.init();
        const outcome = expect(pending).rejects.toMatchObject({
            statusCode: 503,
            details: {
                code: 'storage_timeout',
                operation: 'container_init',
                timeoutMs: 37
            }
        });

        const timer = timers.expireNext();
        await outcome;

        expect(timer.delay).toBe(37);
        expect(aborts.controllers[0].signal.aborted).toBe(true);
        expect(repository.ready).toBeNull();
        expect(repository.container).toBeNull();
    });

    test('retries container initialisation after a non-timeout failure', async () => {
        const timers = createTimerHarness();
        const aborts = createAbortHarness();
        const initialisationError = new Error('temporary init failure');
        const blob = {
            download: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }))
        };
        const container = {
            createIfNotExists: jest.fn()
                .mockRejectedValueOnce(initialisationError)
                .mockResolvedValueOnce(undefined),
            getBlockBlobClient: jest.fn().mockReturnValue(blob)
        };
        const repository = createRepository(container, timers, aborts);

        await expect(repository.read(access())).rejects.toBe(initialisationError);
        expect(repository.ready).toBeNull();

        const state = await repository.read(access());
        expect(state.revision).toBe(0);
        expect(container.createIfNotExists).toHaveBeenCalledTimes(2);
    });

    test('keeps the download deadline active while the response stream is being read', async () => {
        const timers = createTimerHarness();
        const aborts = createAbortHarness();
        let streamIsWaiting = false;
        const stuckStream = (async function* readStuckStream() {
            yield Buffer.from('{"revision":');
            streamIsWaiting = true;
            await new Promise(() => {});
        }());
        const blob = {
            download: jest.fn().mockResolvedValue({
                etag: 'etag-stuck',
                readableStreamBody: stuckStream
            })
        };
        const container = {
            createIfNotExists: jest.fn().mockResolvedValue(undefined),
            getBlockBlobClient: jest.fn().mockReturnValue(blob)
        };
        const repository = createRepository(container, timers, aborts);
        const pending = repository.read(access());
        const outcome = expect(pending).rejects.toMatchObject({
            statusCode: 503,
            details: {
                code: 'storage_timeout',
                operation: 'download'
            }
        });

        await waitFor(() => streamIsWaiting && timers.activeCount() === 1);
        timers.expireNext();
        await outcome;

        expect(aborts.controllers[1].signal.aborted).toBe(true);
    });

    test('times out upload and sends its abort signal with conditional write options', async () => {
        const timers = createTimerHarness();
        const aborts = createAbortHarness();
        const uploadData = jest.fn(() => new Promise(() => {}));
        const blob = {
            download: jest.fn().mockResolvedValue({
                etag: 'etag-before-write',
                readableStreamBody: streamFrom(Buffer.from(JSON.stringify(storedState(4))))
            }),
            uploadData
        };
        const container = {
            createIfNotExists: jest.fn().mockResolvedValue(undefined),
            getBlockBlobClient: jest.fn().mockReturnValue(blob)
        };
        const repository = createRepository(container, timers, aborts);
        const pending = repository.mutate(access(), { expectedRevision: 4 }, (state) => {
            state.customers.push({ id: 'customer-one' });
            return 'saved';
        });
        const outcome = expect(pending).rejects.toMatchObject({
            statusCode: 503,
            details: {
                code: 'storage_timeout',
                operation: 'upload'
            }
        });

        await waitFor(() => uploadData.mock.calls.length === 1 && timers.activeCount() === 1);
        const uploadOptions = uploadData.mock.calls[0][1];
        expect(uploadOptions.conditions).toEqual({ ifMatch: 'etag-before-write' });
        expect(uploadOptions.abortSignal).toBe(aborts.controllers[2].signal);

        timers.expireNext();
        await outcome;
        expect(aborts.controllers[2].signal.aborted).toBe(true);
    });
});
