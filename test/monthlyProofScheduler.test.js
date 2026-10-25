const {
    createLifecycleRepository
} = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const { proofPeriodBounds } = require('../api/shared/appLifecycle/customerOperations');
const runHealth = require('../api/health');
const appLifecycleRuntime = require('../api/shared/appLifecycleRuntime');
const {
    resetMonthlyProofSchedulerForTests,
    startMonthlyProofScheduler
} = require('../api/shared/monthlyProofScheduler');

describe('hosted monthly Proof scheduler', () => {
    afterEach(() => {
        resetMonthlyProofSchedulerForTests();
        appLifecycleRuntime.resetLifecycleRuntimeForTests();
        jest.restoreAllMocks();
    });

    test('permits only the bounded legacy pre-cutover source staging vector without a scheduler surface', async () => {
        expect(startMonthlyProofScheduler({ env: {} })).toBeNull();
        const context = {};
        await runHealth(context, {}, {
            getReleaseIdentity: () => ({ releaseSha: 'f'.repeat(40), runId: '9000' }),
            getMonthlyProofSchedulerHealth: () => null,
            getServiceDeskHealth: () => null
        });
        expect(context.res).toMatchObject({
            status: 200,
            body: { status: 'ok', releaseSha: 'f'.repeat(40), releaseRunId: '9000' }
        });
        expect(context.res.body).not.toHaveProperty('monthlyProofScheduler');

        expect(() => startMonthlyProofScheduler({
            env: { NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true' }
        })).toThrow(expect.objectContaining({ code: 'monthly_proof_scheduler_setting_invalid' }));
        expect(() => startMonthlyProofScheduler({
            env: { NOFRIES_SERVICE_DESK_PROVIDER: 'autotask' }
        })).toThrow(expect.objectContaining({ code: 'monthly_proof_scheduler_setting_invalid' }));
    });

    test('emergency disable skips scheduler dependencies without preventing host health', async () => {
        const scheduler = startMonthlyProofScheduler({
            env: { NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'false' }
        });
        await expect(scheduler.startPromise).resolves.toMatchObject({
            enabled: false,
            status: 'disabled',
            persistenceVerified: false
        });
        expect(scheduler.health()).toEqual({
            enabled: false,
            status: 'disabled',
            cadence: 'daily',
            lastAttemptAt: '',
            lastSucceededAt: '',
            nextDueAt: '',
            persistenceVerified: false,
            persistenceReceiptSha256: '',
            errorCode: ''
        });
        const context = {};
        await runHealth(context, {}, {
            env: {
                NOFRIES_SERVICE_DESK_PROVIDER: 'autotask',
                NOFRIES_CUSTOMER_PORTAL_ENABLED: 'true',
                NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED: 'false',
                NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE: 'disabled',
                NOFRIES_SERVICE_DESK_WRITE_SCOPE: 'disabled',
                NOFRIES_AUTOTASK_MODE: 'readonly',
                NOFRIES_AUTOTASK_WRITE_ENABLED: 'false',
                NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'false',
                NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
            },
            getReleaseIdentity: () => ({ releaseSha: 'f'.repeat(40), runId: '9001' }),
            getServiceDeskHealth: () => ({ provider: 'autotask', durable: true, ready: true }),
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true }),
            getServiceDeskControlsDigest: () => 'b'.repeat(64)
        });
        expect(context.res).toMatchObject({
            status: 200,
            body: {
                status: 'ok',
                monthlyProofScheduler: { enabled: false, status: 'disabled' }
            }
        });
    });

    test('verifies durable storage before becoming healthy and runs internal controls only', async () => {
        const verifyProofPersistence = jest.fn(async () => ({
            verified: true,
            receiptSha256: 'a'.repeat(64)
        }));
        const repository = {
            verifyProofPersistence,
            read: jest.fn(async () => ({ revision: 7 }))
        };
        const service = {
            runCustomerControls: jest.fn(async (_access, input) => ({ revision: 8, generated: [] }))
        };
        const scheduler = startMonthlyProofScheduler({
            env: {
                NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'true',
                NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure',
                NOFRIES_DEFAULT_TENANT_ID: 'tenant-proof'
            },
            repository,
            service,
            releaseIdentity: { releaseSha: 'b'.repeat(40), runId: '12345' },
            now: () => new Date('2026-08-31T12:10:00.000Z'),
            setTimeout: () => ({ unref() {} }),
            clearTimeout: jest.fn(),
            logger: { error: jest.fn() }
        });
        await scheduler.startPromise;
        expect(verifyProofPersistence).toHaveBeenCalledWith({
            operationId: `monthly-proof:${'b'.repeat(40)}:12345`,
            releaseSha: 'b'.repeat(40)
        });
        expect(service.runCustomerControls).toHaveBeenCalledWith(expect.any(Object), {
            expectedRevision: 7,
            scheduledFor: '2026-08-31T12:10:00.000Z',
            confirmInternalOnly: true
        });
        expect(scheduler.health()).toEqual({
            enabled: true,
            status: 'ready',
            cadence: 'daily',
            lastAttemptAt: '2026-08-31T12:10:00.000Z',
            lastSucceededAt: '2026-08-31T12:10:00.000Z',
            nextDueAt: '2026-09-01T12:10:00.000Z',
            persistenceVerified: true,
            persistenceReceiptSha256: 'a'.repeat(64),
            errorCode: ''
        });
    });

    test('requires repository and service test overrides to be supplied as a pair', () => {
        const common = {
            env: {
                NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'true',
                NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
            },
            releaseIdentity: { releaseSha: 'b'.repeat(40), runId: '12345' }
        };
        expect(() => startMonthlyProofScheduler(Object.assign({}, common, {
            repository: { verifyProofPersistence: jest.fn() }
        }))).toThrow(expect.objectContaining({ code: 'monthly_proof_dependency_pair_invalid' }));
        expect(() => startMonthlyProofScheduler(Object.assign({}, common, {
            service: { runCustomerControls: jest.fn() }
        }))).toThrow(expect.objectContaining({ code: 'monthly_proof_dependency_pair_invalid' }));
    });

    test('uses the one App lifecycle repository and service in production mode', async () => {
        const repository = {
            verifyProofPersistence: jest.fn(async () => ({
                verified: true,
                receiptSha256: 'd'.repeat(64)
            })),
            read: jest.fn(async () => ({ revision: 11 }))
        };
        const service = {
            runCustomerControls: jest.fn(async () => ({ revision: 12, generated: [] }))
        };
        const getRepository = jest.spyOn(appLifecycleRuntime, 'getLifecycleRepository').mockReturnValue(repository);
        const getService = jest.spyOn(appLifecycleRuntime, 'getLifecycleService').mockReturnValue(service);
        const scheduler = startMonthlyProofScheduler({
            env: {
                NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'true',
                NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
            },
            releaseIdentity: { releaseSha: 'e'.repeat(40), runId: '67890' },
            now: () => new Date('2026-08-31T12:10:00.000Z'),
            setTimeout: () => ({ unref() {} }),
            clearTimeout: jest.fn(),
            logger: { error: jest.fn() }
        });
        await scheduler.startPromise;
        expect(getRepository).toHaveBeenCalledTimes(1);
        expect(getService).toHaveBeenCalledTimes(1);
        expect(repository.verifyProofPersistence).toHaveBeenCalledTimes(1);
        expect(service.runCustomerControls).toHaveBeenCalledWith(expect.any(Object), {
            expectedRevision: 11,
            scheduledFor: '2026-08-31T12:10:00.000Z',
            confirmInternalOnly: true
        });
    });

    test('health exposes and enforces lifecycle durability alongside an enabled scheduler', async () => {
        const schedulerHealth = {
            enabled: true,
            status: 'ready',
            cadence: 'daily',
            lastAttemptAt: '2026-08-31T12:10:00.000Z',
            lastSucceededAt: '2026-08-31T12:10:00.000Z',
            nextDueAt: '2026-09-01T12:10:00.000Z',
            persistenceVerified: true,
            persistenceReceiptSha256: 'a'.repeat(64),
            errorCode: ''
        };
        const healthy = {};
        await runHealth(healthy, {}, {
            getReleaseIdentity: () => ({ releaseSha: 'b'.repeat(40), runId: '12345' }),
            getMonthlyProofSchedulerHealth: () => schedulerHealth,
            getServiceDeskHealth: () => null,
            getLifecycleHealth: () => ({ storageProvider: 'azure', durable: true, ready: true })
        });
        expect(healthy.res).toMatchObject({
            status: 200,
            body: { lifecycle: { storageProvider: 'azure', durable: true, ready: true } }
        });

        const unavailable = {};
        await runHealth(unavailable, {}, {
            getReleaseIdentity: () => ({ releaseSha: 'b'.repeat(40), runId: '12345' }),
            getMonthlyProofSchedulerHealth: () => schedulerHealth,
            getServiceDeskHealth: () => null,
            getLifecycleHealth: () => ({ storageProvider: 'local', durable: false, ready: false })
        });
        expect(unavailable.res).toMatchObject({
            status: 503,
            body: {
                code: 'monthly_proof_runtime_unavailable',
                lifecycle: { storageProvider: 'local', durable: false, ready: false }
            }
        });
    });

    test('fails closed when durable verification fails', async () => {
        const logger = { error: jest.fn() };
        const scheduler = startMonthlyProofScheduler({
            env: {
                NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED: 'true',
                NOFRIES_LIFECYCLE_STORAGE_PROVIDER: 'azure'
            },
            repository: {
                verifyProofPersistence: jest.fn(async () => {
                    const error = new Error('storage unavailable');
                    error.details = { code: 'proof_storage_unavailable' };
                    throw error;
                })
            },
            service: { runCustomerControls: jest.fn() },
            releaseIdentity: { releaseSha: 'c'.repeat(40), runId: '54321' },
            now: () => new Date('2026-08-31T12:10:00.000Z'),
            setTimeout: () => ({ unref() {} }),
            clearTimeout: jest.fn(),
            logger
        });
        await scheduler.startPromise;
        expect(scheduler.health()).toMatchObject({
            status: 'error',
            persistenceVerified: false,
            persistenceReceiptSha256: '',
            errorCode: 'proof_storage_unavailable'
        });
        expect(logger.error).toHaveBeenCalledWith('Monthly Proof scheduler failed (proof_storage_unavailable).');
    });

    test('creates one deterministic customer-local monthly task for every missed reporting period', async () => {
        const access = systemAccess();
        const firstDue = proofPeriodBounds('2026-05', 'Pacific/Auckland').endExclusiveMs;
        const state = {
            revision: 0,
            organisations: [{
                id: 'organisation-backlog',
                recordType: 'customer',
                displayName: 'Backlog Customer',
                serviceStatus: { state: 'active' },
                lifecycleState: 'active',
                supportProfile: { timezone: 'Pacific/Auckland' },
                customerMaster: { entitlements: [], serviceSchedule: { timezone: 'Pacific/Auckland' } },
                proofPeriods: []
            }],
            schedules: [{
                id: 'monthly-backlog',
                organisationId: 'organisation-backlog',
                jobType: 'monthly_proof',
                cadence: 'monthly',
                timezone: 'Pacific/Auckland',
                nextDueAt: new Date(firstDue).toISOString(),
                enabled: true,
                templateVersion: '1',
                deliveryMode: 'internal',
                requiredSources: [],
                revision: 1
            }],
            controlRuns: [],
            operatorTasks: [],
            deadLetters: [],
            audit: []
        };
        const repository = mutableRepository(state);
        const service = createLifecycleService({
            repository,
            now: () => new Date('2026-09-15T00:00:00.000Z')
        });
        const first = await service.runCustomerControls(access, {
            expectedRevision: 0,
            scheduledFor: '2026-09-15T00:00:00.000Z',
            confirmInternalOnly: true
        });
        expect(first.generated.filter((item) => item.jobType === 'monthly_proof').map((item) => item.reportingPeriod)).toEqual([
            '2026-05', '2026-06', '2026-07', '2026-08'
        ]);
        const after = await repository.read(access);
        expect(after.operatorTasks.map((item) => item.evidence.reportingPeriod)).toEqual([
            '2026-05', '2026-06', '2026-07', '2026-08'
        ]);
        expect(after.schedules[0].nextDueAt).toBe('2026-09-30T11:00:00.000Z');
        const replay = await service.runCustomerControls(access, {
            expectedRevision: after.revision,
            scheduledFor: '2026-09-15T00:00:00.000Z',
            confirmInternalOnly: true
        });
        expect(replay.generated).toEqual([]);
    });

    test('advances by customer calendar months across daylight-saving transitions', async () => {
        const timezone = 'America/New_York';
        const march = proofPeriodBounds('2026-03', timezone);
        expect(march).toMatchObject({
            periodStart: '2026-03-01T05:00:00.000Z',
            periodEnd: '2026-04-01T03:59:59.999Z'
        });
        expect(march.endExclusiveMs - march.startMs).toBe(743 * 60 * 60 * 1000);
        const state = {
            revision: 0,
            organisations: [{
                id: 'organisation-dst',
                recordType: 'customer',
                displayName: 'DST Customer',
                serviceStatus: { state: 'active' },
                lifecycleState: 'active',
                supportProfile: { timezone },
                customerMaster: { customerId: 'customer-dst', entitlements: [], serviceSchedule: { timezone } },
                proofPeriods: []
            }],
            schedules: [{
                id: 'monthly-dst',
                organisationId: 'organisation-dst',
                jobType: 'monthly_proof',
                cadence: 'monthly',
                timezone,
                nextDueAt: new Date(march.endExclusiveMs).toISOString(),
                enabled: true,
                templateVersion: '1',
                deliveryMode: 'internal',
                requiredSources: [],
                revision: 1
            }],
            controlRuns: [],
            operatorTasks: [],
            deadLetters: [],
            audit: []
        };
        const repository = mutableRepository(state);
        const service = createLifecycleService({ repository, now: () => new Date('2026-06-15T00:00:00.000Z') });
        const run = await service.runCustomerControls(systemAccess(), {
            expectedRevision: 0,
            scheduledFor: '2026-06-15T00:00:00.000Z',
            confirmInternalOnly: true
        });
        expect(run.generated.filter((item) => item.jobType === 'monthly_proof').map((item) => item.reportingPeriod)).toEqual([
            '2026-03', '2026-04', '2026-05'
        ]);
        expect((await repository.read(systemAccess())).schedules[0].nextDueAt).toBe('2026-07-01T04:00:00.000Z');
    });

    test('concurrent scheduler starts converge on one retained, hash-only Azure persistence receipt', async () => {
        let stored = null;
        let etagSequence = 0;
        let blobPath = '';
        const payloads = [];
        const blob = {
            async uploadData(buffer, options) {
                if (options.conditions && options.conditions.ifNoneMatch === '*' && stored) {
                    const error = new Error('exists');
                    error.statusCode = 412;
                    throw error;
                }
                etagSequence += 1;
                const text = buffer.toString('utf8');
                payloads.push(text);
                stored = { text, etag: `etag-${etagSequence}` };
            },
            async download() {
                if (!stored) {
                    const error = new Error('missing');
                    error.statusCode = 404;
                    throw error;
                }
                const text = stored.text;
                return {
                    etag: stored.etag,
                    readableStreamBody: (async function * stream() { yield Buffer.from(text); }())
                };
            },
            async deleteIfExists() { throw new Error('the active release receipt must not be deleted'); }
        };
        const repository = createLifecycleRepository({
            provider: 'azure',
            env: { AZURE_STORAGE_ACCOUNT_NAME: 'proofstorage' }
        });
        repository.container = {
            getBlockBlobClient(path) {
                blobPath = path;
                return blob;
            },
            async * listBlobsFlat(options) {
                expect(options.prefix).toBe('lifecycle/verification/monthly-proof/');
                if (stored) {
                    yield {
                        name: blobPath,
                        properties: { createdOn: new Date('2026-08-31T12:10:00.000Z') }
                    };
                }
            }
        };
        repository.ready = Promise.resolve();
        const options = {
            operationId: `monthly-proof:${'d'.repeat(40)}:777`,
            releaseSha: 'd'.repeat(40)
        };
        const [first, second] = await Promise.all([
            repository.verifyProofPersistence(options),
            repository.verifyProofPersistence(options)
        ]);
        expect(first).toEqual(second);
        expect(first).toMatchObject({
            verified: true,
            receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            operationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            retained: true,
            retentionLimit: 32
        });
        expect(blobPath).toMatch(/^lifecycle\/verification\/monthly-proof\/[a-f0-9]{64}\.json$/);
        payloads.map(JSON.parse).forEach((payload) => {
            expect(payload).toEqual({
                schemaVersion: 1,
                kindSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                operationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                releaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
            });
            expect(JSON.stringify(payload)).not.toContain(options.operationId);
            expect(JSON.stringify(payload)).not.toContain(options.releaseSha);
        });
        expect(stored).not.toBeNull();
    });
});

function systemAccess() {
    return {
        allowed: true,
        user: { email: 'scheduler@example.test', role: 'system' },
        tenant: { id: 'tenant-proof', key: 'tenant-proof', name: 'Proof tenant', slug: 'proof' }
    };
}

function mutableRepository(initialState) {
    let state = structuredClone(initialState);
    return {
        async read() {
            return structuredClone(state);
        },
        async mutate(_access, options, mutator) {
            if (Number(options.expectedRevision) !== state.revision) {
                const error = new Error('revision conflict');
                error.details = { code: 'revision_conflict' };
                throw error;
            }
            const next = structuredClone(state);
            const result = await mutator(next);
            next.revision += 1;
            next.audit.push(...(options.auditEvents || []));
            state = next;
            return { state: structuredClone(state), result };
        }
    };
}
