const crypto = require('crypto');

const TEST_DATABASE_URL = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const runKey = crypto.randomBytes(8).toString('hex');
const runtimeRole = `nofries_test_service_desk_${runKey}`;
const runtimePassword = `nofries-test-only-${runKey}`;

const {
    SERVICE_DESK_SCHEMA_VERSION,
    createServiceDeskRepository
} = require('../api/shared/serviceDesk/serviceDeskRepository');
const { createServiceDeskService } = require('../api/shared/serviceDesk/agentRuntime');
const { createMockServiceDeskAdapters } = require('../api/shared/serviceDesk/mockAdapters');
const {
    ServiceDeskRepositoryError
} = require('../api/shared/serviceDesk/serviceDeskState');
const {
    PostgresServiceDeskRepository
} = require('../api/shared/serviceDesk/postgresServiceDeskRepository');
const {
    PostgresDatabaseError,
    createPostgresDatabase,
    createPostgresPool
} = require('../api/shared/database/postgres');

jest.setTimeout(30000);

describe('PostgreSQL database boundary', () => {
    test('rolls back and preserves an application error from the transaction callback', async () => {
        const client = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: jest.fn()
        };
        const pool = {
            connect: jest.fn().mockResolvedValue(client),
            end: jest.fn().mockResolvedValue(undefined)
        };
        const database = createPostgresDatabase({ pool });
        const domainError = new ServiceDeskRepositoryError(409, 'Synthetic conflict', {
            code: 'synthetic_conflict'
        });

        await expect(database.withTenantTransaction('tenant-a', async (tenantClient) => {
            await tenantClient.query('SELECT $1::text', ['bounded']);
            throw domainError;
        })).rejects.toBe(domainError);

        expect(client.query.mock.calls).toEqual([
            ['BEGIN'],
            ["SELECT set_config('nofries.tenant_id', $1, true)", ['tenant-a']],
            ['SELECT $1::text', ['bounded']],
            ['ROLLBACK']
        ]);
        expect(client.release).toHaveBeenCalledWith(false);
    });

    test('sanitises a failed BEGIN and discards that pooled connection', async () => {
        const client = {
            query: jest.fn().mockRejectedValueOnce(
                new Error('password=do-not-echo host=database.invalid')
            ),
            release: jest.fn()
        };
        const database = createPostgresDatabase({
            pool: {
                connect: jest.fn().mockResolvedValue(client),
                end: jest.fn().mockResolvedValue(undefined)
            }
        });

        let caught;
        try {
            await database.withTenantTransaction('tenant-a', async () => undefined);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(PostgresDatabaseError);
        expect(caught).toMatchObject({
            code: 'postgres_begin_failed',
            message: 'No Fries could not complete the database operation.'
        });
        expect(JSON.stringify(caught)).not.toMatch(/do-not-echo|database\.invalid/);
        expect(client.release).toHaveBeenCalledWith(true);
    });

    test('rejects URL credentials in production without echoing them', () => {
        const sensitive = 'postgresql://user:do-not-echo@database.invalid/nofries';
        let caught;
        try {
            createServiceDeskRepository({
                provider: 'postgres',
                env: {
                    NODE_ENV: 'production',
                    NOFRIES_DATABASE_URL: sensitive
                }
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toMatchObject({
            statusCode: 503,
            message: 'Service-desk storage is temporarily unavailable',
            details: { code: 'service_desk_storage_unavailable' }
        });
        expect(JSON.stringify({ message: caught.message, details: caught.details }))
            .not.toMatch(/do-not-echo|database\.invalid/);
    });

    test('contains idle pool errors behind a bounded diagnostic callback', () => {
        let idleErrorHandler;
        class CapturingPool {
            on(event, handler) {
                if (event === 'error') idleErrorHandler = handler;
            }
        }
        const onPoolError = jest.fn(() => {
            throw new Error('A diagnostic observer must not crash the process');
        });
        createPostgresPool({
            Pool: CapturingPool,
            env: {
                NODE_ENV: 'test',
                NOFRIES_DATABASE_URL: 'postgresql://user:local-only@127.0.0.1/nofries'
            },
            onPoolError
        });

        expect(() => idleErrorHandler(new Error('password=do-not-echo'))).not.toThrow();
        expect(onPoolError).toHaveBeenCalledWith(expect.objectContaining({
            code: 'postgres_idle_client_error',
            message: 'No Fries could not complete the database operation.'
        }));
        expect(JSON.stringify(onPoolError.mock.calls[0][0])).not.toMatch(/do-not-echo/);
    });

    test('maps injected database failures to a generic repository error', async () => {
        const sensitive = 'postgresql://user:do-not-echo@database.invalid/nofries';
        const database = {
            withTenantTransaction: jest.fn().mockRejectedValue(
                new Error(`password=do-not-echo query=SELECT * FROM customers url=${sensitive}`)
            )
        };
        const repository = new PostgresServiceDeskRepository({ database });

        let caught;
        try {
            await repository.read(access('redaction'));
        } catch (error) {
            caught = error;
        }
        expect(caught).toMatchObject({
            statusCode: 503,
            message: 'Service-desk storage is temporarily unavailable',
            details: { code: 'service_desk_storage_unavailable' }
        });
        expect(JSON.stringify({
            message: caught.message,
            details: caught.details
        })).not.toMatch(/do-not-echo|SELECT \* FROM customers|database\.invalid/);
    });

    test('maps a final revision-write database failure to the retryable storage error', async () => {
        const client = {
            query: jest.fn(async (sql) => {
                if (/UPDATE nofries\.module_revisions SET/.test(sql)) {
                    throw new PostgresDatabaseError('postgres_query_failed');
                }
                if (/SELECT schema_version, revision[\s\S]+FROM nofries\.module_revisions/.test(sql)) {
                    return { rows: [{ schema_version: SERVICE_DESK_SCHEMA_VERSION, revision: 0 }], rowCount: 1 };
                }
                if (/SELECT logical_id, tenant_key, name, slug/.test(sql)) {
                    return {
                        rows: [{
                            logical_id: 'tenant-revision-write',
                            tenant_key: 'revision-write',
                            name: 'Revision write test',
                            slug: 'revision-write',
                            created_at: new Date(),
                            updated_at: new Date()
                        }],
                        rowCount: 1
                    };
                }
                if (/^\s*SELECT /.test(sql)) return { rows: [], rowCount: 0 };
                return { rows: [], rowCount: 1 };
            })
        };
        const database = {
            withTenantTransaction: jest.fn(async (_tenantId, work) => work(client))
        };
        const repository = new PostgresServiceDeskRepository({ database });

        await expect(repository.mutate(
            access('revision-write'),
            { expectedRevision: 0, auditEvents: [] },
            () => undefined
        )).rejects.toMatchObject({
            statusCode: 503,
            message: 'Service-desk storage is temporarily unavailable',
            details: { code: 'service_desk_storage_unavailable' }
        });
    });
});

describeWithPostgres('PostgreSQL service-desk repository', () => {
    let ownerPool;
    let runtimeDatabaseUrl;
    const repositories = new Set();

    beforeAll(async () => {
        const { Pool } = require('pg');
        ownerPool = new Pool({
            connectionString: TEST_DATABASE_URL,
            application_name: 'nofries-postgres-repository-test-owner',
            max: 2
        });
        await ownerPool.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD ${quoteLiteral(runtimePassword)}`);
        await ownerPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(runtimeRole)}`);
        runtimeDatabaseUrl = databaseUrlForRole(TEST_DATABASE_URL, runtimeRole, runtimePassword);
    });

    afterEach(async () => {
        await Promise.all(Array.from(repositories).map(async (repository) => {
            try {
                await repository.close();
            } finally {
                repositories.delete(repository);
            }
        }));
    });

    afterAll(async () => {
        if (ownerPool) {
            await ownerPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`);
            await ownerPool.end();
        }
    });

    test('keeps identical ticket IDs isolated under two tenants', async () => {
        const repository = createRepository();
        const tenantA = access('identical-a');
        const tenantB = access('identical-b');
        const ticketId = `ticket_shared_${runKey}`;

        await repository.mutate(tenantA, mutationOptions(0, 'ticket.created', ticketId), (state) => {
            state.tickets.push(ticket(tenantA, ticketId, 'Tenant A ticket'));
        });
        await repository.mutate(tenantB, mutationOptions(0, 'ticket.created', ticketId), (state) => {
            state.tickets.push(ticket(tenantB, ticketId, 'Tenant B ticket'));
        });

        const [stateA, stateB] = await Promise.all([
            repository.read(tenantA),
            repository.read(tenantB)
        ]);
        expect(stateA.tickets).toHaveLength(1);
        expect(stateB.tickets).toHaveLength(1);
        expect(stateA.tickets[0]).toMatchObject({ id: ticketId, summary: 'Tenant A ticket' });
        expect(stateB.tickets[0]).toMatchObject({ id: ticketId, summary: 'Tenant B ticket' });
        expect(stateA.tenant.key).not.toBe(stateB.tenant.key);
    });

    test('permits exactly one concurrent mutation at the same expected revision', async () => {
        const firstRepository = createRepository();
        const secondRepository = createRepository();
        const tenant = access('concurrency');
        let releaseFirst;
        let markFirstStarted;
        const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
        const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });

        const first = firstRepository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_concurrency_first'),
            async (state) => {
                markFirstStarted();
                await firstMayFinish;
                state.tickets.push(ticket(tenant, 'ticket_concurrency_first', 'First writer'));
            }
        );
        await firstStarted;
        const second = secondRepository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_concurrency_second'),
            (state) => {
                state.tickets.push(ticket(tenant, 'ticket_concurrency_second', 'Second writer'));
            }
        );
        releaseFirst();

        const outcomes = await Promise.allSettled([first, second]);
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = outcomes.find((outcome) => outcome.status === 'rejected').reason;
        expect(rejected).toMatchObject({
            statusCode: 409,
            details: expect.objectContaining({ code: 'revision_conflict' })
        });

        const state = await firstRepository.read(tenant);
        expect(state.revision).toBe(1);
        expect(state.tickets.map((item) => item.id)).toEqual(['ticket_concurrency_first']);
        expect(state.audit).toHaveLength(1);
    });

    test('rejects duplicate ticket identities before persistence when no revision is supplied', async () => {
        const firstRepository = createRepository();
        const secondRepository = createRepository();
        const tenant = access('duplicate-request');
        const duplicate = ticket(tenant, 'ticket_duplicate_request', 'Original request');

        await firstRepository.mutate(
            tenant,
            mutationOptions(undefined, 'ticket.created', duplicate.id),
            (state) => state.tickets.push(duplicate)
        );

        await expect(secondRepository.mutate(
            tenant,
            mutationOptions(undefined, 'ticket.created', duplicate.id),
            (state) => state.tickets.push(Object.assign({}, duplicate))
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'revision_conflict', currentRevision: 1 }
        });

        const state = await firstRepository.read(tenant);
        expect(state.revision).toBe(1);
        expect(state.tickets).toEqual([expect.objectContaining({ id: duplicate.id })]);
        expect(state.audit).toHaveLength(1);
    });

    test('concurrent application instances converge an exact ticket request before a second provider call', async () => {
        const firstRepository = createRepository();
        const secondRepository = createRepository();
        const tenant = access('cross-instance-idempotency');
        tenant.user.capabilities = ['service-desk:read', 'service-desk:create'];
        const providerCreate = jest.fn();
        const customer = {
            id: 'customer-cross-instance',
            name: 'Cross-instance customer',
            lifecycleState: 'active',
            onboardingStatus: 'complete',
            devices: [{ id: 'device-cross-instance', status: 'verified' }]
        };
        const contextProvider = {
            async requireServiceDeskCustomer(_access, customerId) {
                if (customerId !== customer.id) {
                    throw new ServiceDeskRepositoryError(404, 'Service-desk customer not found', {
                        code: 'service_desk_customer_not_found'
                    });
                }
                return customer;
            },
            async recordServiceEvent() {
                return { linked: true, created: true };
            }
        };
        const serviceOptions = (repository) => ({
            repository,
            env: { NOFRIES_AGENT_RUNTIME: 'mock' },
            contextProvider,
            adapterFactory(adapterOptions) {
                const adapters = createMockServiceDeskAdapters(adapterOptions);
                const create = adapters.autotask.createTicket;
                adapters.autotask.createTicket = async function (...args) {
                    providerCreate();
                    return create.apply(this, args);
                };
                return adapters;
            }
        });
        let initialReadCount = 0;
        let releaseInitialReads;
        const bothInitialReadsComplete = new Promise((resolve) => {
            releaseInitialReads = resolve;
        });
        const gateInitialRead = (repository) => {
            let initialReadPending = true;
            return {
                async read(activeAccess) {
                    const state = await repository.read(activeAccess);
                    if (initialReadPending) {
                        initialReadPending = false;
                        initialReadCount += 1;
                        if (initialReadCount === 2) releaseInitialReads();
                        await bothInitialReadsComplete;
                    }
                    return state;
                },
                mutate(...args) {
                    return repository.mutate(...args);
                }
            };
        };
        const firstService = createServiceDeskService(serviceOptions(gateInitialRead(firstRepository)));
        const secondService = createServiceDeskService(serviceOptions(gateInitialRead(secondRepository)));
        const input = {
            clientRequestId: 'request-cross-instance',
            customerId: customer.id,
            affectedUser: 'person@example.test',
            requesterEmail: 'person@example.test',
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Authenticated test session',
            requesterVerificationRef: 'test:cross-instance',
            deviceId: customer.devices[0].id,
            incidentType: 'outlook_authentication',
            summary: 'One request across two instances',
            problem: 'The same request reached two application instances.'
        };

        const [first, second] = await Promise.all([
            firstService.createTicket(tenant, input),
            secondService.createTicket(tenant, input)
        ]);

        expect(first.ticket.id).toBe(second.ticket.id);
        expect([first.idempotentReplay, second.idempotentReplay]).toContain(true);
        expect(providerCreate).toHaveBeenCalledTimes(1);
        const state = await firstRepository.read(tenant);
        expect(state.revision).toBe(1);
        expect(state.tickets).toHaveLength(1);
    });

    test('rolls back ticket, user, audit and revision changes when a mutator fails', async () => {
        const repository = createRepository();
        const tenant = access('rollback');
        const failure = new ServiceDeskRepositoryError(409, 'Synthetic domain failure', {
            code: 'synthetic_mutator_failure'
        });

        await expect(repository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_rollback'),
            (state) => {
                state.tickets.push(ticket(tenant, 'ticket_rollback', 'Must roll back'));
                throw failure;
            }
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'synthetic_mutator_failure' }
        });

        const state = await repository.read(tenant);
        expect(state.revision).toBe(0);
        expect(state.tickets).toEqual([]);
        expect(state.audit).toEqual([]);

        const persisted = await ownerPool.query(
            `SELECT
                (SELECT count(*)::int FROM nofries.tenants WHERE tenant_id = $1) AS tenants,
                (SELECT count(*)::int FROM nofries.module_revisions WHERE tenant_id = $1) AS revisions,
                (SELECT count(*)::int FROM nofries.service_desk_users WHERE tenant_id = $1) AS users,
                (SELECT count(*)::int FROM nofries.service_desk_tickets WHERE tenant_id = $1) AS tickets,
                (SELECT count(*)::int FROM nofries.service_desk_audit WHERE tenant_id = $1) AS audit`,
            [tenant.tenant.key]
        );
        expect(persisted.rows).toEqual([{
            tenants: 0,
            revisions: 0,
            users: 0,
            tickets: 0,
            audit: 0
        }]);
    });

    test('persists revision, tickets, users and audit across repository restart', async () => {
        const tenant = access('restart');
        const firstRepository = createRepository();
        await firstRepository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_restart'),
            (state) => {
                state.tickets.push(ticket(tenant, 'ticket_restart', 'Survives restart'));
            }
        );
        await closeRepository(firstRepository);

        const restartedRepository = createRepository();
        const state = await restartedRepository.read(tenant);
        expect(state.schemaVersion).toBe(SERVICE_DESK_SCHEMA_VERSION);
        expect(state.revision).toBe(1);
        expect(state.tickets).toEqual([
            expect.objectContaining({ id: 'ticket_restart', summary: 'Survives restart' })
        ]);
        expect(state.users[tenant.user.email]).toEqual(expect.objectContaining({
            email: tenant.user.email,
            role: tenant.user.role
        }));
        expect(state.audit).toEqual([
            expect.objectContaining({ action: 'ticket.created', ticketId: 'ticket_restart' })
        ]);
        const persistedUser = await ownerPool.query(
            `SELECT email, payload->>'role' AS role
            FROM nofries.service_desk_users
            WHERE tenant_id = $1`,
            [tenant.tenant.key]
        );
        expect(persistedUser.rows).toEqual([{
            email: tenant.user.email,
            role: tenant.user.role
        }]);
    });

    test('keeps audit events append-only with a valid per-tenant hash chain', async () => {
        const repository = createRepository();
        const tenant = access('audit-chain');
        await repository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_audit'),
            (state) => state.tickets.push(ticket(tenant, 'ticket_audit', 'Audit chain'))
        );
        await repository.mutate(
            tenant,
            mutationOptions(1, 'ticket.updated', 'ticket_audit'),
            (state) => { state.tickets[0].status = 'investigating'; }
        );

        const state = await repository.read(tenant);
        expect(state.audit).toHaveLength(2);
        expect(state.audit[0].previousHash).toBe('');
        expect(state.audit[0].integritySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(state.audit[1].previousHash).toBe(state.audit[0].integritySha256);
        expect(state.audit[1].integritySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(state.audit[0].integritySha256).toBe(auditHash(state.audit[0]));
        expect(state.audit[1].integritySha256).toBe(auditHash(state.audit[1]));

        await expect(repository.mutate(
            tenant,
            { expectedRevision: 2, auditEvents: [] },
            (mutableState) => {
                mutableState.audit[0].summary = 'Attempted rewrite';
            }
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'service_desk_audit_immutable' }
        });
        const afterRejectedMutation = await repository.read(tenant);
        expect(afterRejectedMutation.revision).toBe(state.revision);
        expect(afterRejectedMutation.tickets).toEqual(state.tickets);
        expect(afterRejectedMutation.audit).toEqual(state.audit);

        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: runtimeDatabaseUrl, max: 1 });
        try {
            await expect(inTenantTransaction(pool, tenant.tenant.key, (client) => client.query(
                `UPDATE nofries.service_desk_audit
                SET payload = '{}'::jsonb
                WHERE tenant_id = $1`,
                [tenant.tenant.key]
            ))).rejects.toMatchObject({ code: '42501' });
            await expect(inTenantTransaction(pool, tenant.tenant.key, (client) => client.query(
                'DELETE FROM nofries.service_desk_audit WHERE tenant_id = $1',
                [tenant.tenant.key]
            ))).rejects.toMatchObject({ code: '42501' });
        } finally {
            await pool.end();
        }

        const unchanged = await repository.read(tenant);
        expect(unchanged.audit).toEqual(state.audit);
    });

    test('fails closed when the stored module schema is newer than the application', async () => {
        const repository = createRepository();
        const tenant = access('future-schema');
        await repository.mutate(
            tenant,
            mutationOptions(0, 'ticket.created', 'ticket_future_schema'),
            (state) => state.tickets.push(ticket(tenant, 'ticket_future_schema', 'Future schema'))
        );
        await ownerPool.query(
            `UPDATE nofries.module_revisions
            SET schema_version = $3
            WHERE tenant_id = $1 AND module = $2`,
            [tenant.tenant.key, 'service_desk', SERVICE_DESK_SCHEMA_VERSION + 1]
        );

        await expect(repository.read(tenant)).rejects.toMatchObject({
            statusCode: 409,
            details: expect.objectContaining({ code: 'service_desk_schema_version_unsupported' })
        });
    });

    function createRepository() {
        const repository = createServiceDeskRepository({
            provider: 'postgres',
            env: Object.assign({}, process.env, {
                NODE_ENV: 'test',
                NOFRIES_DATABASE_URL: runtimeDatabaseUrl
            })
        });
        repositories.add(repository);
        return repository;
    }

    async function closeRepository(repository) {
        repositories.delete(repository);
        await repository.close();
    }
});

function access(label) {
    const identity = `${runKey}:${label}`;
    const tenantKey = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
    return {
        allowed: true,
        tenant: {
            id: `tenant-${identity}`,
            key: tenantKey,
            name: `PostgreSQL test ${label}`,
            slug: `postgres-test-${label}`
        },
        user: {
            email: `${label}@example.test`,
            name: `Test ${label}`,
            role: 'admin',
            capabilities: []
        },
        requestContext: {
            correlationId: `correlation-${identity}`
        }
    };
}

function ticket(accessValue, id, summary) {
    const now = new Date().toISOString();
    return {
        id,
        tenantId: accessValue.tenant.id,
        tenantKey: accessValue.tenant.key,
        clientRequestId: `request_${id}`,
        customer: { id: `customer_${id}`, name: 'Synthetic customer' },
        status: 'new',
        summary,
        createdAt: now,
        updatedAt: now
    };
}

function mutationOptions(expectedRevision, action, ticketId) {
    return {
        expectedRevision,
        auditEvents: [{
            actorType: 'user',
            actorId: 'postgres-test-user',
            actorRole: 'admin',
            action,
            targetType: 'ticket',
            targetId: ticketId,
            ticketId,
            summary: `${action} during PostgreSQL repository verification`
        }]
    };
}

async function inTenantTransaction(pool, tenantId, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // The original PostgreSQL error is the useful assertion evidence.
        }
        throw error;
    } finally {
        client.release();
    }
}

function databaseUrlForRole(value, username, password) {
    const parsed = new URL(value);
    parsed.username = username;
    parsed.password = password;
    return parsed.toString();
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function auditHash(event) {
    const payload = Object.assign({}, event);
    delete payload.integritySha256;
    return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
}
