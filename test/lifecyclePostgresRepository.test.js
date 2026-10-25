const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DATABASE_URL = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;
const runKey = crypto.randomBytes(8).toString('hex');
const runtimeRole = `nofries_test_lifecycle_${runKey}`;
const runtimePassword = `nofries-test-only-${runKey}`;
const FIXED_AT = '2026-08-25T01:00:00.000Z';

const {
    LIFECYCLE_SCHEMA_VERSION,
    createLifecycleRepository,
    normaliseState
} = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');
const { createOrganisation } = require('../api/shared/lifecycle/lifecycleModel');
const {
    MAX_LOADED_AUDIT_EVENTS,
    PostgresLifecycleRepository
} = require('../api/shared/lifecycle/postgresLifecycleRepository');
const {
    createEmptyState,
    finishMutation
} = require('../api/shared/lifecycle/lifecycleState');
const {
    PostgresDatabaseError
} = require('../api/shared/database/postgres');

jest.setTimeout(30000);

describe('PostgreSQL lifecycle boundary', () => {
    test('selects PostgreSQL only explicitly and bounds configuration failures', () => {
        expect(() => createLifecycleRepository({ provider: 'unknown' })).toThrow(expect.objectContaining({
            details: { code: 'lifecycle_storage_provider_invalid' }
        }));

        const sensitive = 'postgresql://user:do-not-echo@database.invalid/nofries';
        let caught;
        try {
            createLifecycleRepository({
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
            message: 'Lifecycle storage is temporarily unavailable',
            details: { code: 'lifecycle_storage_unavailable' }
        });
        expect(JSON.stringify({ message: caught.message, details: caught.details }))
            .not.toMatch(/do-not-echo|database\.invalid/);
    });

    test('does not let the shared PostgreSQL provider silently opt Lifecycle in', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-lifecycle-explicit-provider-'));
        try {
            const repository = createLifecycleRepository({
                dataDir,
                env: { NOFRIES_STORAGE_PROVIDER: 'postgres' }
            });
            const actor = access('shared-provider-stays-local');
            await expect(repository.read(actor)).resolves.toMatchObject({
                schemaVersion: LIFECYCLE_SCHEMA_VERSION,
                revision: 0,
                tenant: { key: actor.tenant.key }
            });
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('keeps equal principal IDs from different Entra tenants as different users', () => {
        const first = access('subject-one');
        const second = JSON.parse(JSON.stringify(first));
        second.user.email = 'subject-two@example.test';
        second.user.identityTenantId = '22222222-2222-4222-8222-222222222222';
        second.user.subjectKey = `${second.user.identityTenantId}:${second.user.principalId}`;
        second.user.actorId = second.user.subjectKey;

        const state = normaliseState({
            schemaVersion: LIFECYCLE_SCHEMA_VERSION,
            revision: 0,
            tenant: first.tenant,
            users: {
                [first.user.email]: {
                    email: first.user.email,
                    principalId: first.user.principalId,
                    identityTenantId: first.user.identityTenantId,
                    subjectKey: first.user.subjectKey
                }
            }
        }, second);

        expect(Object.keys(state.users).sort()).toEqual([
            first.user.email,
            second.user.email
        ].sort());
        expect(new Set(Object.values(state.users).map((user) => user.subjectKey))).toEqual(new Set([
            first.user.subjectKey,
            second.user.subjectKey
        ]));
    });

    test('fails closed when a display email is reused by another immutable identity', () => {
        const first = access('email-reuse-one');
        const second = JSON.parse(JSON.stringify(first));
        second.user.identityTenantId = '33333333-3333-4333-8333-333333333333';
        second.user.subjectKey = `${second.user.identityTenantId}:${second.user.principalId}`;
        second.user.actorId = second.user.subjectKey;

        expect(() => normaliseState({
            schemaVersion: LIFECYCLE_SCHEMA_VERSION,
            revision: 0,
            tenant: first.tenant,
            users: {
                [first.user.email]: {
                    email: first.user.email,
                    principalId: first.user.principalId,
                    identityTenantId: first.user.identityTenantId,
                    subjectKey: first.user.subjectKey
                }
            }
        }, second)).toThrow(expect.objectContaining({
            statusCode: 409,
            details: { code: 'lifecycle_user_identity_conflict' }
        }));
    });

    test('derives stored immutable identities and refuses implicit legacy principal upgrades', () => {
        const actor = access('derived-subject');
        const stored = {
            email: actor.user.email,
            principalId: actor.user.principalId,
            identityTenantId: actor.user.identityTenantId
        };
        expect(() => normaliseState({
            schemaVersion: LIFECYCLE_SCHEMA_VERSION,
            tenant: actor.tenant,
            users: { [actor.user.email]: stored }
        }, actor)).not.toThrow();

        const legacyEmail = 'legacy-principal@example.test';
        expect(() => normaliseState({
            schemaVersion: LIFECYCLE_SCHEMA_VERSION,
            tenant: actor.tenant,
            users: {
                [legacyEmail]: {
                    email: legacyEmail,
                    principalId: actor.user.principalId
                }
            }
        }, actor)).toThrow(expect.objectContaining({
            statusCode: 409,
            details: { code: 'lifecycle_user_identity_conflict' }
        }));
    });

    test('matches the local-provider user shape on a virgin PostgreSQL read', async () => {
        const actor = access('virgin-read');
        const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        const repository = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work({
                    query
                }))
            }
        });

        await expect(repository.read(actor)).resolves.toMatchObject({
            revision: 0,
            users: {
                [actor.user.email]: {
                    email: actor.user.email,
                    principalId: actor.user.principalId,
                    identityTenantId: actor.user.identityTenantId,
                    subjectKey: actor.user.subjectKey
                }
            }
        });
        expect(query.mock.calls[0][0]).toMatch(/FOR SHARE/);
    });

    test('maps injected database failures and final revision failures to a bounded retryable error', async () => {
        const failed = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn().mockRejectedValue(
                    new Error('password=do-not-echo query=SELECT * FROM lifecycle_private')
                )
            }
        });
        await expect(failed.read(access('bounded-read'))).rejects.toMatchObject({
            statusCode: 503,
            message: 'Lifecycle storage is temporarily unavailable',
            details: { code: 'lifecycle_storage_unavailable' }
        });

        const client = fakeEmptyLifecycleClient({ failRevisionUpdate: true });
        const revisionFailure = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work(client))
            }
        });
        await expect(revisionFailure.mutate(
            access('bounded-revision'),
            { expectedRevision: 0 },
            () => undefined
        )).rejects.toMatchObject({
            statusCode: 503,
            message: 'Lifecycle storage is temporarily unavailable',
            details: { code: 'lifecycle_storage_unavailable' }
        });

        const secret = 'mutator-secret-that-must-not-escape';
        const applicationFailure = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work(fakeEmptyLifecycleClient()))
            }
        });
        let caught;
        try {
            await applicationFailure.mutate(access('bounded-application'), { expectedRevision: 0 }, () => {
                const error = new Error(secret);
                error.details = { credential: secret };
                throw error;
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toMatchObject({
            statusCode: 503,
            message: 'Lifecycle storage is temporarily unavailable',
            details: { code: 'lifecycle_storage_unavailable' }
        });
        expect(JSON.stringify({ message: caught.message, details: caught.details })).not.toContain(secret);
    });

    test('checks future schemas before entity reads and bounds audit materialization in SQL', async () => {
        const futureQuery = jest.fn(async (sql) => {
            if (/SELECT schema_version, revision/.test(sql)) {
                return { rows: [{ schema_version: LIFECYCLE_SCHEMA_VERSION + 1, revision: 0 }], rowCount: 1 };
            }
            throw new Error('future schema entity query must not execute');
        });
        const futureRepository = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work({ query: futureQuery }))
            }
        });
        await expect(futureRepository.read(access('future-schema-boundary'))).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'lifecycle_schema_version_unsupported' }
        });
        expect(futureQuery).toHaveBeenCalledTimes(1);
        futureQuery.mockClear();
        await expect(futureRepository.readAudit(access('future-schema-audit-boundary'))).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'lifecycle_schema_version_unsupported' }
        });
        expect(futureQuery).toHaveBeenCalledTimes(1);

        const client = fakeEmptyLifecycleClient();
        const repository = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work(client))
            }
        });
        await repository.mutate(
            access('audit-window-sql'),
            mutationOptions(0, 'audit.window_tested', 'audit-window'),
            () => undefined
        );
        const auditRead = client.query.mock.calls.find(([sql]) => (
            /FROM nofries\.lifecycle_audit/.test(sql) && /SELECT event_id/.test(sql)
        ));
        expect(auditRead[0]).toMatch(/ORDER BY sequence_no DESC[\s\S]+LIMIT \$2[\s\S]+ORDER BY sequence_no/);
        expect(auditRead[1]).toEqual([expect.any(String), MAX_LOADED_AUDIT_EVENTS]);
        const auditInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO nofries\.lifecycle_audit/.test(sql));
        expect(auditInsert[0]).toMatch(/COALESCE\(MAX\(sequence_no\), -1\) \+ 1/);
    });

    test('returns a fixed empty audit page immediately when no module revision exists', async () => {
        const query = jest.fn(async (sql) => {
            if (/SELECT schema_version, revision/.test(sql)) return { rows: [], rowCount: 0 };
            throw new Error('virgin audit page must not perform later audit queries');
        });
        const repository = new PostgresLifecycleRepository({
            database: {
                withTenantTransaction: jest.fn(async (_tenantKey, work) => work({ query }))
            }
        });
        const actor = access('virgin-audit-page');

        await expect(repository.readAudit(actor, {
            expectedRevision: 0,
            afterSequence: 19,
            throughSequence: 25,
            limit: 5
        })).resolves.toEqual({
            events: [],
            nextSequence: 19,
            throughSequence: 25,
            hasMore: false
        });
        expect(query).toHaveBeenCalledTimes(1);

        query.mockClear();
        await expect(repository.readAudit(actor, { expectedRevision: 1 })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'revision_conflict', currentRevision: 0 }
        });
        expect(query).toHaveBeenCalledTimes(1);
    });

    test('detaches mutable references when conversation retention evicts their source', () => {
        const tenant = access('conversation-retention');
        const organisationId = `organisation_conversation_retention_${runKey}`;
        const conversationIds = Array.from(
            { length: 1001 },
            (_value, index) => `conversation_retention_${index}_${runKey}`
        );
        const state = createEmptyState(tenant);
        state.organisations.push(organisation(tenant, organisationId, 'Conversation retention customer'));
        state.conversations = conversationIds.map((id, index) => (
            conversation(id, organisationId, `retention-${index}`)
        ));
        state.operatorTasks.push(
            operatorTask(`task_evicted_${runKey}`, organisationId, conversationIds[0]),
            operatorTask(`task_retained_${runKey}`, organisationId, conversationIds[1000])
        );

        finishMutation(state, tenant, {
            auditEvents: [Object.assign(
                auditEvent('conversation.retention_applied', organisationId),
                { conversationId: conversationIds[0] }
            )],
            observabilityEvents: [
                observationEvent('conversation.evicted', organisationId, conversationIds[0]),
                observationEvent('conversation.retained', organisationId, conversationIds[1000])
            ]
        });

        expect(state.conversations).toHaveLength(1000);
        expect(state.conversations[0].id).toBe(conversationIds[1]);
        expect(state.conversations[state.conversations.length - 1].id).toBe(conversationIds[1000]);
        expect(state.operatorTasks.map((item) => item.conversationId)).toEqual([
            '',
            conversationIds[1000]
        ]);
        expect(state.observability.map((item) => item.conversationId)).toEqual([
            '',
            conversationIds[1000]
        ]);
        expect(state.audit[0].conversationId).toBe(conversationIds[0]);
    });

    test('performs sealed Sales verification before entering the Lifecycle mutation', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-lifecycle-verifier-'));
        const underlying = createLifecycleRepository({ provider: 'local', dataDir });
        let mutationDepth = 0;
        const repository = {
            read: underlying.read.bind(underlying),
            mutate(accessValue, options, mutator) {
                return underlying.mutate(accessValue, options, async (state) => {
                    mutationDepth += 1;
                    try {
                        return await mutator(state);
                    } finally {
                        mutationDepth -= 1;
                    }
                });
            }
        };
        const verifier = {
            verify: jest.fn(async () => {
                expect(mutationDepth).toBe(0);
                return { verified: true };
            })
        };
        const service = createLifecycleService({
            repository,
            approvedProposalVerifier: verifier,
            now: () => new Date(FIXED_AT)
        });
        const actor = access('verifier-order');

        let result = await service.createOrganisation(actor, { displayName: 'Verifier order customer' });
        for (const lifecycleState of ['discovery', 'scoping']) {
            result = await service.updateOrganisation(actor, result.organisation.organisationId, {
                expectedRevision: result.revision,
                lifecycleState
            });
        }
        result = await service.linkScopingRecords(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            salesCustomerId: 'sales-verifier-order',
            assessmentId: 'assessment-verifier-order'
        });
        result = await service.bindApprovedProposal(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            proposalId: 'proposal-verifier-order',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        await service.recordCommercialAcceptance(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            idempotencyKey: 'accept:verifier-order:v1',
            proposalId: 'proposal-verifier-order',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            acceptedAt: FIXED_AT,
            effectiveDate: '2026-08-25T00:00:00.000Z',
            signatoryName: 'Customer Sponsor',
            signatoryEmail: 'sponsor@example.test',
            signatoryTitle: 'Director',
            authorityBasis: 'Director authority',
            authorityEvidenceId: 'contract-register:verifier-order',
            authorityEvidenceSha256: 'b'.repeat(64),
            confirmCustomerAuthority: true
        });

        expect(verifier.verify).toHaveBeenCalledTimes(2);
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
});

describeWithPostgres('PostgreSQL lifecycle repository', () => {
    let ownerPool;
    let runtimePool;
    let runtimeDatabaseUrl;
    const repositories = new Set();

    beforeAll(async () => {
        const { Pool } = require('pg');
        ownerPool = new Pool({
            connectionString: TEST_DATABASE_URL,
            application_name: 'nofries-lifecycle-postgres-owner',
            max: 2
        });
        await ownerPool.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD ${quoteLiteral(runtimePassword)}`);
        await ownerPool.query(`GRANT nofries_runtime TO ${quoteIdentifier(runtimeRole)}`);
        runtimeDatabaseUrl = databaseUrlForRole(TEST_DATABASE_URL, runtimeRole, runtimePassword);
        runtimePool = new Pool({
            connectionString: runtimeDatabaseUrl,
            application_name: 'nofries-lifecycle-postgres-runtime',
            max: 2
        });
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
        if (runtimePool) await runtimePool.end();
        if (ownerPool) {
            await ownerPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`);
            await ownerPool.end();
        }
    });

    test('isolates identical organisation and operation IDs under two tenants', async () => {
        const repository = createRepository();
        const tenantA = access('isolation-a');
        const tenantB = access('isolation-b');
        const organisationId = `organisation_shared_${runKey}`;
        const operationId = `operation_shared_${runKey}`;

        for (const [tenant, name] of [[tenantA, 'Tenant A organisation'], [tenantB, 'Tenant B organisation']]) {
            await repository.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
                state.organisations.push(organisation(tenant, organisationId, name));
                state.inboxReceiptsById[operationId] = receipt(operationId, organisationId);
            });
        }

        const [stateA, stateB] = await Promise.all([repository.read(tenantA), repository.read(tenantB)]);
        expect(stateA.organisations).toHaveLength(1);
        expect(stateB.organisations).toHaveLength(1);
        expect(stateA.organisations[0]).toMatchObject({ id: organisationId, displayName: 'Tenant A organisation' });
        expect(stateB.organisations[0]).toMatchObject({ id: organisationId, displayName: 'Tenant B organisation' });
        expect(Object.keys(stateA.inboxReceiptsById)).toEqual([operationId]);
        expect(Object.keys(stateB.inboxReceiptsById)).toEqual([operationId]);
    });

    test('round-trips an active aggregate, immutable actor identity and every top-level collection in order', async () => {
        const firstRepository = createRepository();
        const tenant = access('aggregate-restart');
        const first = organisation(tenant, `organisation_first_${runKey}`, 'First customer', `datto-site-${runKey}`);
        const second = organisation(tenant, `organisation_second_${runKey}`, 'Second customer');
        const conversationIds = [`conversation_first_${runKey}`, `conversation_second_${runKey}`];

        await firstRepository.mutate(tenant, {
            expectedRevision: 0,
            auditEvents: [
                auditEvent('aggregate.created', first.id),
                auditEvent('aggregate.activated', first.id)
            ],
            observabilityEvents: [
                observationEvent('agent.first', first.id, conversationIds[0]),
                observationEvent('agent.second', second.id, conversationIds[1])
            ]
        }, (state) => {
            state.organisations.push(first, second);
            state.conversations.push(
                conversation(conversationIds[0], first.id, '1'),
                conversation(conversationIds[1], second.id, '2')
            );
            state.prospectAdmissions.push(
                admission('1'),
                admission('2')
            );
            state.prospectSecurityEvents.push(
                securityEvent(`security_first_${runKey}`, '1'),
                securityEvent(`security_second_${runKey}`, '2')
            );
            state.approvals.push('legacy-approval-marker', {
                id: `approval_${runKey}`,
                organisationId: first.id,
                status: 'pending'
            });
            state.operatorTasks.push(
                operatorTask(`task_first_${runKey}`, first.id, conversationIds[0]),
                operatorTask(`task_second_${runKey}`, second.id, conversationIds[1])
            );
            state.schedules.push(
                schedule(`schedule_first_${runKey}`, first.id, 'monthly_proof'),
                schedule(`schedule_second_${runKey}`, second.id, 'monthly_proof')
            );
            state.controlRuns.push(
                controlRun(`run_first_${runKey}`, first.id, `schedule_first_${runKey}`),
                controlRun(`run_second_${runKey}`, second.id, `schedule_second_${runKey}`)
            );
            state.deadLetters.push(
                deadLetter(`dead_first_${runKey}`, first.id, '1'),
                deadLetter(`dead_second_${runKey}`, second.id, '2')
            );
            state.inboxReceiptsById[`operation_${runKey}`] = receipt(`operation_${runKey}`, first.id);
            state.operatorCorrections.push(
                correction(`correction_first_${runKey}`, first.id),
                correction(`correction_second_${runKey}`, second.id)
            );
        });
        await firstRepository.close();
        repositories.delete(firstRepository);

        const restarted = createRepository();
        const state = await restarted.read(tenant);
        expect(state).toMatchObject({ schemaVersion: LIFECYCLE_SCHEMA_VERSION, revision: 1 });
        expect(state.organisations.map((item) => item.id)).toEqual([first.id, second.id]);
        expect(state.organisations[0]).toMatchObject({ recordType: 'customer', lifecycleState: 'active' });
        expect(state.organisations[0].onboarding.devices.map((item) => item.id)).toEqual([
            `device_1_${runKey}`,
            `device_2_${runKey}`,
            `device_3_${runKey}`,
            `device_4_${runKey}`
        ]);
        expect(state.organisations[0].onboarding.devices[0].providerRefs).toEqual([{
            system: 'datto_rmm',
            externalId: `provider-device-1-${first.id}-${runKey}`
        }]);
        expect(state.organisations[0].customerMaster.externalRefs.map((item) => item.id)).toEqual([
            `external_hubspot_${runKey}`,
            `external_autotask_${runKey}`
        ]);
        expect(state.organisations[0].activationRequests.map((item) => item.id)).toEqual([
            `activation_${runKey}`
        ]);
        expect(state.organisations[0].activationRequests[0].maker).toMatchObject({
            principalId: tenant.user.principalId,
            identityTenantId: tenant.user.identityTenantId,
            subjectKey: tenant.user.subjectKey
        });
        expect(state.conversations.map((item) => item.id)).toEqual(conversationIds);
        expect(state.prospectAdmissions.map((item) => item.sessionHash)).toEqual([
            hash64(`session-admission-1-${runKey}`),
            hash64(`session-admission-2-${runKey}`)
        ]);
        expect(state.prospectSecurityEvents.map((item) => item.id)).toEqual([
            `security_first_${runKey}`,
            `security_second_${runKey}`
        ]);
        expect(state.approvals).toEqual([
            'legacy-approval-marker',
            expect.objectContaining({ id: `approval_${runKey}`, status: 'pending' })
        ]);
        expect(state.operatorTasks.map((item) => item.id)).toEqual([`task_first_${runKey}`, `task_second_${runKey}`]);
        expect(state.schedules.map((item) => item.id)).toEqual([`schedule_first_${runKey}`, `schedule_second_${runKey}`]);
        expect(state.controlRuns.map((item) => item.id)).toEqual([`run_first_${runKey}`, `run_second_${runKey}`]);
        expect(state.deadLetters.map((item) => item.id)).toEqual([`dead_first_${runKey}`, `dead_second_${runKey}`]);
        expect(state.operatorCorrections.map((item) => item.id)).toEqual([
            `correction_first_${runKey}`,
            `correction_second_${runKey}`
        ]);
        expect(state.observability.map((item) => item.eventType)).toEqual(['agent.first', 'agent.second']);
        expect(state.audit.map((item) => item.action)).toEqual(['aggregate.created', 'aggregate.activated']);
        expect(state.audit[0]).toMatchObject({
            actorId: tenant.user.subjectKey,
            actorSubjectKey: tenant.user.subjectKey,
            actorEmail: tenant.user.email
        });
        expect(state.users[tenant.user.email]).toMatchObject({
            principalId: tenant.user.principalId,
            identityTenantId: tenant.user.identityTenantId,
            subjectKey: tenant.user.subjectKey,
            actorId: tenant.user.subjectKey
        });
        expect(state.inboxReceiptsById[`operation_${runKey}`]).toMatchObject({
            organisationId: first.id,
            payloadHash: 'a'.repeat(64)
        });
    });

    test('persists the 1,001st conversation after detaching retained mutable references', async () => {
        const repository = createRepository();
        const tenant = access('conversation-retention-postgres');
        const organisationId = `organisation_conversation_retention_pg_${runKey}`;
        const conversationPrefix = `conversation_retention_pg_${runKey}_`;
        const sessionPrefix = `conversation_retention_session_pg_${runKey}_`;
        const evictedConversationId = `${conversationPrefix}0`;
        const retainedConversationId = `${conversationPrefix}1000`;
        const tasks = [
            operatorTask(`task_evicted_pg_${runKey}`, organisationId, evictedConversationId),
            operatorTask(`task_retained_pg_${runKey}`, organisationId, retainedConversationId)
        ];
        const observations = [
            Object.assign(
                { id: `observation_evicted_pg_${runKey}` },
                observationEvent('conversation.evicted', organisationId, evictedConversationId)
            ),
            Object.assign(
                { id: `observation_retained_pg_${runKey}` },
                observationEvent('conversation.retained', organisationId, retainedConversationId)
            )
        ];

        await repository.mutate(
            tenant,
            mutationOptions(0, 'organisation.created', organisationId),
            (state) => {
                state.organisations.push(organisation(
                    tenant,
                    organisationId,
                    'Conversation retention PostgreSQL customer'
                ));
            }
        );

        await withTenantSql(runtimePool, tenant.tenant.key, async (client) => {
            await client.query(
                `INSERT INTO nofries.lifecycle_conversations (
                    tenant_key, conversation_id, sequence_no,
                    organisation_id, session_hash, payload
                )
                SELECT
                    $1,
                    $3 || generated.position::text,
                    generated.position,
                    $2,
                    $4 || generated.position::text,
                    '{}'::jsonb
                FROM generate_series(0, 1000) AS generated(position)`,
                [tenant.tenant.key, organisationId, conversationPrefix, sessionPrefix]
            );
            for (const [index, task] of tasks.entries()) {
                await client.query(
                    `INSERT INTO nofries.lifecycle_operator_tasks (
                        tenant_key, task_id, sequence_no, organisation_id,
                        conversation_id, payload
                    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
                    [
                        tenant.tenant.key,
                        task.id,
                        index,
                        organisationId,
                        task.conversationId,
                        JSON.stringify(task)
                    ]
                );
            }
            for (const [index, observation] of observations.entries()) {
                await client.query(
                    `INSERT INTO nofries.lifecycle_observability (
                        tenant_key, event_id, sequence_no, organisation_id,
                        conversation_id, observed_at, payload
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
                    [
                        tenant.tenant.key,
                        observation.id,
                        index,
                        organisationId,
                        observation.conversationId,
                        FIXED_AT,
                        JSON.stringify(observation)
                    ]
                );
            }
        });

        const mutation = await repository.mutate(
            tenant,
            mutationOptions(1, 'conversation.retention_applied', organisationId),
            () => undefined
        );
        expect(mutation.state.revision).toBe(2);
        expect(mutation.state.conversations).toHaveLength(1000);
        expect(mutation.state.conversations[0].id).toBe(`${conversationPrefix}1`);
        expect(mutation.state.conversations[999].id).toBe(retainedConversationId);
        expect(mutation.state.operatorTasks.map((item) => item.conversationId)).toEqual([
            '',
            retainedConversationId
        ]);
        expect(mutation.state.observability.map((item) => item.conversationId)).toEqual([
            '',
            retainedConversationId
        ]);

        const storedReferences = await withTenantSql(runtimePool, tenant.tenant.key, async (client) => ({
            tasks: (await client.query(
                `SELECT conversation_id
                FROM nofries.lifecycle_operator_tasks
                WHERE tenant_key = $1
                ORDER BY sequence_no`,
                [tenant.tenant.key]
            )).rows.map((row) => row.conversation_id),
            observations: (await client.query(
                `SELECT conversation_id
                FROM nofries.lifecycle_observability
                WHERE tenant_key = $1
                ORDER BY sequence_no`,
                [tenant.tenant.key]
            )).rows.map((row) => row.conversation_id)
        }));
        expect(storedReferences).toEqual({
            tasks: [null, retainedConversationId],
            observations: [null, retainedConversationId]
        });

        const restarted = await repository.read(tenant);
        expect(restarted).toMatchObject({ revision: 2 });
        expect(restarted.operatorTasks.map((item) => item.conversationId)).toEqual([
            '',
            retainedConversationId
        ]);
        expect(restarted.observability.map((item) => item.conversationId)).toEqual([
            '',
            retainedConversationId
        ]);
    }, 60000);

    test('serializes concurrent same-revision writes across repository instances', async () => {
        const firstRepository = createRepository();
        const secondRepository = createRepository();
        const tenant = access('concurrent');

        const results = await Promise.allSettled([
            firstRepository.mutate(tenant, mutationOptions(0, 'organisation.created', 'one'), async (state) => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                state.organisations.push(organisation(tenant, `organisation_concurrent_one_${runKey}`, 'Concurrent one'));
            }),
            secondRepository.mutate(tenant, mutationOptions(0, 'organisation.created', 'two'), (state) => {
                state.organisations.push(organisation(tenant, `organisation_concurrent_two_${runKey}`, 'Concurrent two'));
            })
        ]);

        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((item) => item.status === 'rejected');
        expect(rejected.reason).toMatchObject({ statusCode: 409, details: { code: 'revision_conflict' } });
        const state = await firstRepository.read(tenant);
        expect(state.revision).toBe(1);
        expect(state.organisations).toHaveLength(1);
    });

    test('holds a consistent read snapshot while a concurrent writer waits for the revision lock', async () => {
        const writer = createRepository();
        const tenant = access('consistent-read');
        const organisationId = `organisation_consistent_read_${runKey}`;
        await writer.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'Before concurrent write'));
        });

        let revisionReadReached;
        let releaseRevisionRead;
        const reached = new Promise((resolve) => { revisionReadReached = resolve; });
        const release = new Promise((resolve) => { releaseRevisionRead = resolve; });
        const reader = new PostgresLifecycleRepository({
            database: barrierTenantDatabase(runtimePool, {
                afterQuery: async (sql) => {
                    if (!/FROM nofries\.module_revisions[\s\S]+FOR SHARE/.test(sql)) return;
                    revisionReadReached();
                    await release;
                }
            })
        });

        const readPromise = reader.read(tenant);
        await reached;
        let writerLockReached;
        const writerAtLock = new Promise((resolve) => { writerLockReached = resolve; });
        const blockedWriter = new PostgresLifecycleRepository({
            database: barrierTenantDatabase(runtimePool, {
                beforeQuery: async (sql) => {
                    if (/FROM nofries\.module_revisions[\s\S]+FOR UPDATE/.test(sql)) writerLockReached();
                }
            })
        });
        let writerSettled = false;
        const writePromise = blockedWriter.mutate(
            tenant,
            mutationOptions(1, 'organisation.updated', organisationId),
            (state) => {
                state.organisations[0].displayName = 'After concurrent write';
            }
        ).then((value) => {
            writerSettled = true;
            return value;
        }, (error) => {
            writerSettled = true;
            throw error;
        });

        await writerAtLock;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(writerSettled).toBe(false);
        releaseRevisionRead();
        const [readState, written] = await Promise.all([readPromise, writePromise]);
        expect(readState).toMatchObject({ revision: 1 });
        expect(readState.organisations[0].displayName).toBe('Before concurrent write');
        expect(written.state).toMatchObject({ revision: 2 });
        expect((await writer.read(tenant)).organisations[0].displayName).toBe('After concurrent write');
    });

    test('keeps a virgin audit page empty when the first writer commits after its missing revision read', async () => {
        const writer = createRepository();
        const tenant = access('consistent-virgin-audit');
        const organisationId = `organisation_consistent_virgin_audit_${runKey}`;
        let missingRevisionReached;
        let releaseMissingRevision;
        const reached = new Promise((resolve) => { missingRevisionReached = resolve; });
        const release = new Promise((resolve) => { releaseMissingRevision = resolve; });
        const reader = new PostgresLifecycleRepository({
            database: barrierTenantDatabase(runtimePool, {
                afterQuery: async (sql, result) => {
                    if (
                        !/FROM nofries\.module_revisions[\s\S]+FOR SHARE/.test(sql) ||
                        result.rows.length
                    ) return;
                    missingRevisionReached();
                    await release;
                }
            })
        });

        const pagePromise = reader.readAudit(tenant, { expectedRevision: 0, limit: 100 });
        await reached;
        await writer.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'First concurrent write'));
        });
        releaseMissingRevision();

        await expect(pagePromise).resolves.toEqual({
            events: [],
            nextSequence: -1,
            throughSequence: -1,
            hasMore: false
        });
        await expect(writer.readAudit(tenant, { expectedRevision: 1 })).resolves.toMatchObject({
            events: [expect.objectContaining({ action: 'organisation.created' })],
            throughSequence: 0,
            hasMore: false
        });
    });

    test('retries an organisation export when state advances before the audit boundary is captured', async () => {
        const repository = createRepository();
        const tenant = access('consistent-export');
        const organisationId = `organisation_consistent_export_${runKey}`;
        await repository.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'Before export retry'));
        });
        let injectConcurrentWrite = true;
        let readCount = 0;
        const exportRepository = {
            async read(accessValue) {
                readCount += 1;
                const snapshot = await repository.read(accessValue);
                if (injectConcurrentWrite) {
                    injectConcurrentWrite = false;
                    await repository.mutate(
                        accessValue,
                        mutationOptions(snapshot.revision, 'organisation.updated', organisationId),
                        (state) => {
                            state.organisations[0].displayName = 'After export retry';
                        }
                    );
                }
                return snapshot;
            },
            readAudit: repository.readAudit.bind(repository)
        };

        const exported = await createLifecycleService({ repository: exportRepository })
            .exportOrganisation(tenant, organisationId);
        expect(readCount).toBe(2);
        expect(exported.organisation.displayName).toBe('After export retry');
        expect(exported.activity.map((event) => event.action)).toEqual([
            'organisation.created',
            'organisation.updated'
        ]);
    });

    test('rolls back conflicting provider claims without changing entities, receipts, audit or revision', async () => {
        const repository = createRepository();
        const tenant = access('claim-rollback');
        const first = organisation(tenant, `organisation_claim_first_${runKey}`, 'Claim first', `shared-datto-${runKey}`);
        const operationId = `operation_claim_${runKey}`;
        await repository.mutate(tenant, mutationOptions(0, 'organisation.created', first.id), (state) => {
            state.organisations.push(first);
            state.inboxReceiptsById[operationId] = receipt(operationId, first.id);
        });

        await expect(repository.mutate(
            tenant,
            mutationOptions(1, 'organisation.created', `organisation_claim_second_${runKey}`),
            (state) => {
                state.organisations.push(organisation(
                    tenant,
                    `organisation_claim_second_${runKey}`,
                    'Claim second',
                    `shared-datto-${runKey}`
                ));
                state.inboxReceiptsById[operationId].rematerializedAt = '2026-08-25T01:05:00.000Z';
                state.inboxReceiptsById[operationId].rematerializedBy = tenant.user.email;
            }
        )).rejects.toMatchObject({ statusCode: 409, details: { code: 'revision_conflict' } });

        const state = await repository.read(tenant);
        expect(state.revision).toBe(1);
        expect(state.organisations.map((item) => item.id)).toEqual([first.id]);
        expect(state.audit).toHaveLength(1);
        expect(state.inboxReceiptsById[operationId]).toMatchObject({
            rematerializedAt: '',
            rematerializedBy: ''
        });
    });

    test('keeps audit append-only with an intact hash chain and restricted runtime privileges', async () => {
        const repository = createRepository();
        const tenant = access('audit');
        const organisationId = `organisation_audit_${runKey}`;
        await repository.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'Audit customer'));
        });
        await repository.mutate(tenant, mutationOptions(1, 'organisation.updated', organisationId), (state) => {
            state.organisations[0].displayName = 'Audit customer updated';
        });

        const state = await repository.read(tenant);
        expect(state.audit).toHaveLength(2);
        expect(state.audit[0].previousHash).toBe('');
        expect(state.audit[1].previousHash).toBe(state.audit[0].integritySha256);
        expect(state.audit[0].integritySha256).toBe(auditHash(state.audit[0]));
        expect(state.audit[1].integritySha256).toBe(auditHash(state.audit[1]));

        await expect(repository.mutate(tenant, { expectedRevision: 2 }, (mutable) => {
            mutable.audit[0].summary = 'Attempted rewrite';
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'lifecycle_audit_immutable' }
        });

        for (const sql of [
            'UPDATE nofries.lifecycle_audit SET payload = payload WHERE tenant_key = $1',
            'DELETE FROM nofries.lifecycle_audit WHERE tenant_key = $1'
        ]) {
            await expect(withTenantSql(runtimePool, tenant.tenant.key, (client) => (
                client.query(sql, [tenant.tenant.key])
            ))).rejects.toMatchObject({ code: '42501' });
        }
        expect((await repository.read(tenant)).audit).toEqual(state.audit);
    });

    test('continues the true audit tail after more than one thousand retained events', async () => {
        const repository = createRepository();
        const tenant = access('audit-window-overflow');
        const organisationId = `organisation_audit_window_${runKey}`;
        await repository.mutate(
            tenant,
            mutationOptions(0, 'audit.seed', organisationId),
            (state) => {
                state.organisations.push(organisation(tenant, organisationId, 'Audit window customer'));
            }
        );
        const seeded = await repository.read(tenant);
        const synthetic = createEmptyState(tenant);
        synthetic.revision = seeded.revision;
        synthetic.audit = seeded.audit.slice();
        for (let index = 0; index < 1005; index += 1) {
            finishMutation(synthetic, tenant, {
                auditEvents: [auditEvent(`audit.bulk_${index}`, organisationId)]
            });
        }
        const additionalAudit = synthetic.audit.slice(seeded.audit.length);
        await withTenantSql(runtimePool, tenant.tenant.key, (client) => client.query(
            `INSERT INTO nofries.lifecycle_audit (
                tenant_key, event_id, sequence_no, organisation_id,
                actor_principal_id, occurred_at, payload
            )
            SELECT
                $1,
                item.payload ->> 'id',
                item.ordinality,
                NULLIF(item.payload ->> 'organisationId', ''),
                NULLIF(item.payload ->> 'actorPrincipalId', ''),
                (item.payload ->> 'at')::timestamptz,
                item.payload
            FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS item(payload, ordinality)`,
            [tenant.tenant.key, JSON.stringify(additionalAudit)]
        ));

        const window = await repository.read(tenant);
        expect(window.audit).toHaveLength(MAX_LOADED_AUDIT_EVENTS);
        expect(window.audit[0].action).toBe('audit.bulk_5');
        expect(window.audit[window.audit.length - 1].action).toBe('audit.bulk_1004');
        const evictedAuditId = seeded.audit[0].id;
        await expect(repository.mutate(
            tenant,
            {
                expectedRevision: 1,
                auditEvents: [Object.assign(auditEvent('audit.duplicate_evicted_id', organisationId), {
                    id: evictedAuditId
                })]
            },
            (state) => {
                state.organisations[0].displayName = 'This duplicate audit mutation must roll back';
            }
        )).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'lifecycle_audit_immutable' }
        });
        const afterDuplicate = await repository.read(tenant);
        expect(afterDuplicate).toMatchObject({ revision: 1 });
        expect(afterDuplicate.organisations[0].displayName).toBe('Audit window customer');
        const afterDuplicateAggregate = await withTenantSql(runtimePool, tenant.tenant.key, (client) => client.query(
            `SELECT COUNT(*)::integer AS count, MAX(sequence_no)::integer AS max_sequence
            FROM nofries.lifecycle_audit
            WHERE tenant_key = $1`,
            [tenant.tenant.key]
        ));
        expect(afterDuplicateAggregate.rows[0]).toEqual({ count: 1006, max_sequence: 1005 });
        await repository.mutate(
            tenant,
            mutationOptions(1, 'audit.after_window', organisationId),
            () => undefined
        );
        const after = await repository.read(tenant);
        expect(after.audit).toHaveLength(MAX_LOADED_AUDIT_EVENTS);
        expect(after.audit[0].action).toBe('audit.bulk_6');
        expect(after.audit[after.audit.length - 1].action).toBe('audit.after_window');
        expect(after.audit[after.audit.length - 1].previousHash)
            .toBe(after.audit[after.audit.length - 2].integritySha256);
        const aggregate = await withTenantSql(runtimePool, tenant.tenant.key, (client) => client.query(
            `SELECT COUNT(*)::integer AS count, MAX(sequence_no)::integer AS max_sequence
            FROM nofries.lifecycle_audit
            WHERE tenant_key = $1`,
            [tenant.tenant.key]
        ));
        expect(aggregate.rows[0]).toEqual({ count: 1007, max_sequence: 1006 });

        const paged = [];
        let afterSequence = -1;
        let throughSequence = null;
        for (;;) {
            const page = await repository.readAudit(tenant, {
                organisationId,
                afterSequence,
                throughSequence,
                limit: 137
            });
            paged.push(...page.events);
            if (!page.hasMore) break;
            afterSequence = page.nextSequence;
            throughSequence = page.throughSequence;
        }
        expect(paged).toHaveLength(1007);
        expect(paged[0].action).toBe('audit.seed');
        expect(paged[paged.length - 1].action).toBe('audit.after_window');
        const exported = await createLifecycleService({ repository }).exportOrganisation(tenant, organisationId);
        expect(exported.activity).toHaveLength(1007);
        expect(exported.activity[0].action).toBe('audit.seed');
        expect(exported.activity[exported.activity.length - 1].action).toBe('audit.after_window');
    });

    test('preserves immutable inbox receipts across restart and permits only rematerialization markers', async () => {
        const firstRepository = createRepository();
        const tenant = access('receipt');
        const organisationId = `organisation_receipt_${runKey}`;
        const operationId = `operation_receipt_${runKey}`;
        await firstRepository.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'Receipt customer'));
            state.inboxReceiptsById[operationId] = receipt(operationId, organisationId);
        });
        await firstRepository.close();
        repositories.delete(firstRepository);

        const restarted = createRepository();
        await restarted.mutate(tenant, { expectedRevision: 1 }, (state) => {
            state.inboxReceiptsById[operationId].rematerializedAt = '2026-08-25T01:05:00.000Z';
            state.inboxReceiptsById[operationId].rematerializedBy = tenant.user.email;
        });
        expect((await restarted.read(tenant)).inboxReceiptsById[operationId]).toMatchObject({
            payloadHash: 'a'.repeat(64),
            rematerializedAt: '2026-08-25T01:05:00.000Z',
            rematerializedBy: tenant.user.email
        });

        await expect(restarted.mutate(tenant, { expectedRevision: 2 }, (state) => {
            state.inboxReceiptsById[operationId].payloadHash = 'b'.repeat(64);
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'lifecycle_inbox_receipt_immutable' }
        });

        await expect(withTenantSql(runtimePool, tenant.tenant.key, (client) => (
            client.query(
                'UPDATE nofries.lifecycle_inbox_receipts SET payload_hash = $2 WHERE tenant_key = $1',
                [tenant.tenant.key, 'b'.repeat(64)]
            )
        ))).rejects.toMatchObject({ code: '42501' });
    });

    test('removes private organisation payload while preserving receipts and deletion audit', async () => {
        const repository = createRepository();
        const tenant = access('deletion');
        const organisationId = `organisation_delete_${runKey}`;
        const operationId = `operation_delete_${runKey}`;
        await repository.mutate(tenant, mutationOptions(0, 'organisation.created', organisationId), (state) => {
            state.organisations.push(organisation(tenant, organisationId, 'Delete customer'));
            state.inboxReceiptsById[operationId] = receipt(operationId, organisationId);
        });
        await repository.mutate(tenant, mutationOptions(1, 'organisation.deleted', organisationId), (state) => {
            state.organisations = state.organisations.filter((item) => item.id !== organisationId);
        });

        const state = await repository.read(tenant);
        expect(state.revision).toBe(2);
        expect(state.organisations).toEqual([]);
        expect(state.inboxReceiptsById[operationId]).toMatchObject({ organisationId });
        expect(state.audit.map((item) => item.action)).toEqual(['organisation.created', 'organisation.deleted']);
    });

    test('fails closed when persisted state uses a future schema version', async () => {
        const repository = createRepository();
        const tenant = access('future-schema');
        await repository.mutate(tenant, { expectedRevision: 0 }, () => undefined);
        await withTenantSql(runtimePool, tenant.tenant.key, (client) => client.query(
            `UPDATE nofries.module_revisions
            SET schema_version = $3
            WHERE tenant_id = $1 AND module = $2`,
            [tenant.tenant.key, 'lifecycle', LIFECYCLE_SCHEMA_VERSION + 1]
        ));

        await expect(repository.read(tenant)).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'lifecycle_schema_version_unsupported',
                schemaVersion: LIFECYCLE_SCHEMA_VERSION + 1
            }
        });

    });

    function createRepository() {
        const repository = createLifecycleRepository({
            provider: 'postgres',
            env: Object.assign({}, process.env, {
                NODE_ENV: 'test',
                NOFRIES_DATABASE_URL: runtimeDatabaseUrl
            })
        });
        repositories.add(repository);
        return repository;
    }
});

function access(label) {
    const tenantId = `tenant-lifecycle-${runKey}-${label}`;
    const identityTenantId = '11111111-1111-4111-8111-111111111111';
    const principalId = guidFrom(label);
    const subjectKey = `${identityTenantId}:${principalId}`;
    return {
        allowed: true,
        reason: 'test',
        tenant: {
            id: tenantId,
            key: crypto.createHash('sha256').update(tenantId).digest('hex').slice(0, 32),
            name: `Lifecycle PostgreSQL ${label}`,
            slug: `lifecycle-postgres-${label}`
        },
        user: {
            email: `${label}@example.test`,
            name: `Lifecycle ${label}`,
            role: 'admin',
            principalId,
            identityTenantId,
            subjectKey,
            actorId: subjectKey,
            capabilities: []
        }
    };
}

function organisation(accessValue, id, displayName, dattoSiteUid = '') {
    const value = createOrganisation({
        id,
        displayName,
        actorId: accessValue.user.subjectKey,
        now: FIXED_AT
    });
    value.recordType = 'customer';
    value.lifecycleState = 'active';
    value.onboarding.devices = [1, 2, 3, 4].map((index) => ({
        id: `device_${index}_${runKey}`,
        label: `Device ${index}`,
        platform: index === 2 ? 'macos' : 'windows',
        status: 'verified',
        owner: accessValue.user.email,
        notes: '',
        providerRefs: index === 1 ? [{
            system: 'datto_rmm',
            externalId: `provider-device-${index}-${id}-${runKey}`
        }] : [],
        matchStatus: index === 1 ? 'confirmed' : 'unmatched',
        matchedAt: index === 1 ? FIXED_AT : '',
        matchedBy: index === 1 ? accessValue.user.email : '',
        lastObservedAt: index === 1 ? FIXED_AT : '',
        sourceSnapshotId: index === 1 ? `snapshot_${runKey}` : '',
        updatedAt: FIXED_AT,
        updatedBy: accessValue.user.email
    }));
    value.customerMaster.externalRefs = [
        externalReference('hubspot', 'company', `hubspot-${id}-${runKey}`, `external_hubspot_${runKey}`),
        externalReference('autotask', 'account', `autotask-${id}-${runKey}`, `external_autotask_${runKey}`)
    ];
    value.activationRequests = [{
        id: `activation_${runKey}`,
        idempotencyKey: `activation:${id}`,
        status: 'consumed',
        planId: `plan_${runKey}`,
        planRevision: 1,
        payloadSha256: 'c'.repeat(64),
        maker: actor(accessValue),
        checker: actor(accessValue, 'checker'),
        executor: actor(accessValue, 'executor'),
        customerAuthorityRef: 'authority-register:synthetic',
        createdAt: FIXED_AT,
        approvedAt: FIXED_AT,
        executedAt: FIXED_AT
    }];
    if (dattoSiteUid) {
        value.links.dattoRmmSiteUid = dattoSiteUid;
        value.integrations.dattoRmm = Object.assign({}, value.integrations.dattoRmm, {
            status: 'linked',
            siteUid: dattoSiteUid,
            siteName: displayName,
            provisioning: Object.assign({}, value.integrations.dattoRmm.provisioning, {
                state: 'prepared',
                claimId: `claim-${dattoSiteUid}`,
                keyHash: 'd'.repeat(64),
                siteName: displayName,
                siteNameKey: displayName.toLowerCase(),
                startedAt: FIXED_AT,
                startedBy: accessValue.user.email,
                completedAt: FIXED_AT,
                completedBy: accessValue.user.email
            })
        });
    }
    value.updatedAt = FIXED_AT;
    value.updatedBy = accessValue.user.subjectKey;
    return value;
}

function externalReference(system, recordType, externalId, id) {
    return {
        id,
        system,
        recordType,
        externalId,
        providerScopeId: `scope-${system}-${runKey}`,
        status: 'verified',
        verificationMode: 'manual',
        verifiedAt: FIXED_AT,
        verifiedBy: 'operator@example.test',
        evidenceRef: `record:${externalId}`,
        createdAt: FIXED_AT,
        retiredAt: '',
        retiredBy: '',
        retirementReason: ''
    };
}

function actor(accessValue, roleSuffix = '') {
    const principalId = roleSuffix
        ? guidFrom(`${accessValue.tenant.id}:${roleSuffix}`)
        : accessValue.user.principalId;
    const email = roleSuffix
        ? `${roleSuffix}.${accessValue.user.email}`
        : accessValue.user.email;
    const subjectKey = `${accessValue.user.identityTenantId}:${principalId}`;
    return {
        principalId,
        identityTenantId: accessValue.user.identityTenantId,
        subjectKey,
        email,
        role: accessValue.user.role
    };
}

function conversation(id, organisationId, suffix) {
    return {
        id,
        organisationId,
        sessionHash: hash64(`conversation-session-${suffix}-${runKey}`),
        channel: 'text',
        status: 'closed',
        messages: [{ id: `message_${suffix}_${runKey}`, role: 'user', text: `Message ${suffix}`, at: FIXED_AT }],
        summary: `Conversation ${suffix}`,
        currentNeed: '',
        concerns: [],
        nextAction: { type: 'continue_chat', timing: '', detail: '' },
        escalation: { required: false, reason: '', requestedAt: '' },
        ai: { agent: 'prospect_agent', model: '', runtime: 'mock', confidence: 1, lastRunAt: FIXED_AT },
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT
    };
}

function admission(suffix) {
    return {
        sessionHash: hash64(`session-admission-${suffix}-${runKey}`),
        clientKeyHash: hash64(`client-admission-${suffix}-${runKey}`),
        createdAt: FIXED_AT
    };
}

function securityEvent(id, suffix) {
    return {
        id,
        sessionHash: hash64(`security-session-${suffix}-${runKey}`),
        clientKeyHash: hash64(`security-client-${suffix}-${runKey}`),
        category: 'prompt_injection',
        detectorVersion: 'test-v1',
        signals: ['synthetic'],
        attemptOrdinal: Number(suffix),
        networkIdentifierAvailable: false,
        action: 'warn',
        createdAt: FIXED_AT,
        expiresAt: '2027-08-25T01:00:00.000Z'
    };
}

function operatorTask(id, organisationId, conversationId) {
    return {
        id,
        organisationId,
        conversationId,
        type: 'operator_review',
        title: id,
        detail: 'Synthetic operator review',
        status: 'open',
        priority: 'medium',
        ownerRole: 'service_owner',
        source: 'lifecycle',
        evidence: {},
        createdAt: FIXED_AT,
        createdBy: 'system',
        updatedAt: FIXED_AT,
        updatedBy: 'system'
    };
}

function schedule(id, organisationId, jobType) {
    return {
        id,
        organisationId,
        jobType,
        cadence: 'monthly',
        timezone: 'Pacific/Auckland',
        nextDueAt: '2026-09-01T01:00:00.000Z',
        enabled: true,
        templateVersion: '1',
        deliveryMode: 'internal',
        requiredSources: ['service_desk'],
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
        revision: 1
    };
}

function controlRun(id, organisationId, scheduleId) {
    return {
        id,
        scheduleId,
        organisationId,
        jobType: 'monthly_proof',
        scheduledFor: FIXED_AT,
        status: 'completed',
        taskId: '',
        attemptCount: 1,
        createdAt: FIXED_AT,
        completedAt: FIXED_AT,
        lastError: {}
    };
}

function deadLetter(id, organisationId, suffix) {
    return {
        id,
        operationId: `dead-operation-${suffix}-${runKey}`,
        organisationId,
        reasonCode: 'synthetic_failure',
        status: 'open',
        owner: 'service_owner',
        dueAt: '2026-08-26T01:00:00.000Z',
        createdAt: FIXED_AT,
        resolvedAt: '',
        evidence: {}
    };
}

function correction(id, organisationId) {
    return {
        id,
        at: FIXED_AT,
        organisationId,
        correctedBy: 'operator@example.test',
        fields: ['company.name'],
        reason: 'Synthetic correction'
    };
}

function receipt(operationId, organisationId) {
    return {
        operationId,
        payloadHash: 'a'.repeat(64),
        kind: 'lifecycle.scoping.link',
        organisationId,
        salesCustomerId: `sales_${organisationId}`,
        assessmentId: `assessment_${organisationId}`,
        receivedAt: FIXED_AT,
        receivedBy: 'operator@example.test',
        rematerializedAt: '',
        rematerializedBy: ''
    };
}

function auditEvent(action, targetId) {
    return {
        actorType: 'user',
        actorId: 'display-email-will-be-replaced@example.test',
        actorRole: 'admin',
        action,
        targetType: 'organisation',
        targetId,
        organisationId: targetId,
        summary: action
    };
}

function observationEvent(eventType, organisationId, conversationId) {
    return {
        at: FIXED_AT,
        organisationId,
        conversationId,
        agent: 'prospect_agent',
        runtime: 'mock',
        eventType,
        outcome: 'success'
    };
}

function mutationOptions(expectedRevision, action, targetId) {
    return {
        expectedRevision,
        auditEvents: [auditEvent(action, targetId)]
    };
}

function fakeEmptyLifecycleClient(options = {}) {
    return {
        query: jest.fn(async (sql) => {
            if (/UPDATE nofries\.module_revisions SET/.test(sql) && options.failRevisionUpdate) {
                throw new PostgresDatabaseError('postgres_query_failed');
            }
            if (/SELECT schema_version, revision[\s\S]+FROM nofries\.module_revisions/.test(sql)) {
                return { rows: [{ schema_version: LIFECYCLE_SCHEMA_VERSION, revision: 0 }], rowCount: 1 };
            }
            if (/SELECT logical_id, tenant_key, name, slug/.test(sql)) {
                return {
                    rows: [{
                        logical_id: 'tenant-bounded-revision',
                        tenant_key: access('bounded-revision').tenant.key,
                        name: 'Bounded revision',
                        slug: 'bounded-revision',
                        created_at: new Date(FIXED_AT),
                        updated_at: new Date(FIXED_AT)
                    }],
                    rowCount: 1
                };
            }
            if (/^\s*SELECT /.test(sql)) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 1 };
        })
    };
}

async function withTenantSql(pool, tenantKey, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantKey]);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original PostgreSQL error for the assertion.
        }
        throw error;
    } finally {
        client.release();
    }
}

function barrierTenantDatabase(pool, hooks = {}) {
    const beforeQuery = typeof hooks.beforeQuery === 'function' ? hooks.beforeQuery : async () => undefined;
    const afterQuery = typeof hooks.afterQuery === 'function' ? hooks.afterQuery : async () => undefined;
    return {
        async withTenantTransaction(tenantKey, work) {
            const rawClient = await pool.connect();
            try {
                await rawClient.query('BEGIN');
                await rawClient.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantKey]);
                const client = {
                    async query(sql, parameters) {
                        await beforeQuery(String(sql));
                        const result = await rawClient.query(sql, parameters);
                        await afterQuery(String(sql), result);
                        return result;
                    }
                };
                const value = await work(client);
                await rawClient.query('COMMIT');
                return value;
            } catch (error) {
                try {
                    await rawClient.query('ROLLBACK');
                } catch {
                    // Preserve the original PostgreSQL error for the assertion.
                }
                throw error;
            } finally {
                rawClient.release();
            }
        }
    };
}

function auditHash(event) {
    const payload = Object.assign({}, event);
    delete payload.integritySha256;
    return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function guidFrom(value) {
    const hex = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function hash64(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
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
