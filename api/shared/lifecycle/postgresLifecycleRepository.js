const { isDeepStrictEqual } = require('util');
const {
    PostgresDatabaseError,
    createPostgresDatabase
} = require('../database/postgres');
const {
    LIFECYCLE_SCHEMA_VERSION,
    LifecycleRepositoryError,
    assertAccess,
    assertRevision,
    auditHash,
    createEmptyState,
    finishMutation,
    normaliseState
} = require('./lifecycleState');

const MODULE_NAME = 'lifecycle';
const MAX_LOADED_AUDIT_EVENTS = 1000;
const MAX_AUDIT_PAGE_SIZE = 500;

class PostgresLifecycleRepository {
    constructor(options = {}) {
        try {
            this.database = options.database || createPostgresDatabase({
                env: options.env || process.env
            });
        } catch (error) {
            throw repositoryError(error);
        }
        this.ownsDatabase = !options.database;
        if (!this.database || typeof this.database.withTenantTransaction !== 'function') {
            throw new LifecycleRepositoryError(500, 'PostgreSQL lifecycle storage is not configured', {
                code: 'lifecycle_storage_not_configured'
            });
        }
    }

    async read(access) {
        assertAccess(access);
        try {
            return await this.database.withTenantTransaction(access.tenant.key, async (client) => (
                loadState(client, access, { revisionLock: 'share' })
            ));
        } catch (error) {
            throw repositoryError(error);
        }
    }

    async readAudit(access, options = {}) {
        assertAccess(access);
        const page = auditPageOptions(options);
        try {
            return await this.database.withTenantTransaction(access.tenant.key, async (client) => {
                const revisionResult = await client.query(
                    `SELECT schema_version, revision
                    FROM nofries.module_revisions
                    WHERE tenant_id = $1 AND module = $2
                    FOR SHARE`,
                    [access.tenant.key, MODULE_NAME]
                );
                if (!revisionResult.rows.length) {
                    if (page.expectedRevision != null && page.expectedRevision !== 0) {
                        throw revisionConflict(0);
                    }
                    return {
                        events: [],
                        nextSequence: page.afterSequence,
                        throughSequence: page.throughSequence == null ? -1 : page.throughSequence,
                        hasMore: false
                    };
                }
                const revisionRow = revisionResult.rows[0] || {};
                const schemaVersion = numericValue(revisionRow.schema_version, LIFECYCLE_SCHEMA_VERSION);
                const currentRevision = numericValue(revisionRow.revision, 0);
                if (schemaVersion > LIFECYCLE_SCHEMA_VERSION) {
                    throw new LifecycleRepositoryError(409, 'Lifecycle data was written by a newer application version', {
                        code: 'lifecycle_schema_version_unsupported',
                        schemaVersion,
                        supportedVersion: LIFECYCLE_SCHEMA_VERSION
                    });
                }
                if (page.expectedRevision != null && currentRevision !== page.expectedRevision) {
                    throw revisionConflict(currentRevision);
                }
                let throughSequence = page.throughSequence;
                if (throughSequence == null) {
                    const boundary = await client.query(
                        `SELECT COALESCE(MAX(sequence_no), -1) AS through_sequence
                        FROM nofries.lifecycle_audit
                        WHERE tenant_key = $1
                          AND ($2::text IS NULL OR organisation_id = $2)`,
                        [access.tenant.key, page.organisationId || null]
                    );
                    throughSequence = numericValue(boundary.rows[0] && boundary.rows[0].through_sequence, -1);
                }
                const result = await client.query(
                    `SELECT sequence_no, event_id, organisation_id, actor_principal_id, occurred_at, payload
                    FROM nofries.lifecycle_audit
                    WHERE tenant_key = $1
                      AND sequence_no > $2
                      AND ($3::text IS NULL OR organisation_id = $3)
                      AND sequence_no <= $4
                    ORDER BY sequence_no
                    LIMIT $5`,
                    [
                        access.tenant.key,
                        page.afterSequence,
                        page.organisationId || null,
                        throughSequence,
                        page.limit + 1
                    ]
                );
                const hasMore = result.rows.length > page.limit;
                const rows = result.rows.slice(0, page.limit);
                return {
                    events: rows.map(auditRow),
                    nextSequence: rows.length
                        ? numericValue(rows[rows.length - 1].sequence_no, page.afterSequence)
                        : page.afterSequence,
                    throughSequence,
                    hasMore
                };
            });
        } catch (error) {
            throw repositoryError(error);
        }
    }

    async mutate(access, options = {}, mutator) {
        assertAccess(access);
        if (typeof mutator !== 'function') {
            throw new LifecycleRepositoryError(500, 'A lifecycle mutation callback is required', {
                code: 'lifecycle_mutator_required'
            });
        }
        try {
            return await this.database.withTenantTransaction(access.tenant.key, async (client) => {
                await ensureTenant(client, access);
                await ensureModuleRevision(client, access.tenant.key);

                const state = await loadState(client, access, { revisionLock: 'update' });
                const originalRevision = state.revision;
                const storedAudit = cloneJson(state.audit);
                const storedReceipts = cloneJson(state.inboxReceiptsById);
                let result;
                try {
                    assertRevision(state, options.expectedRevision);
                    result = await mutator(state);
                    assertLifecycleClaims(state, originalRevision);
                    assertAuditUnchanged(state.audit, storedAudit);
                    assertReceiptChanges(state.inboxReceiptsById, storedReceipts);
                    finishMutation(state, access, options);
                    assertLifecycleClaims(state, originalRevision);
                    assertAppendedAudit(state.audit, storedAudit);
                } catch (error) {
                    throw applicationError(error);
                }

                await persistTenant(client, state);
                await replaceMutableState(client, access.tenant.key, state);
                await persistInboxReceipts(client, access.tenant.key, state.inboxReceiptsById, storedReceipts);
                await appendAuditEvents(client, access.tenant.key, state.audit, storedAudit);
                try {
                    await persistRevision(client, access.tenant.key, state, originalRevision);
                } catch (error) {
                    throw applicationError(error);
                }
                return { state, result };
            });
        } catch (error) {
            throw repositoryError(error);
        }
    }

    async close() {
        if (this.ownsDatabase && this.database && typeof this.database.close === 'function') {
            await this.database.close();
        }
    }
}

async function ensureTenant(client, access) {
    const now = new Date().toISOString();
    await client.query(
        `INSERT INTO nofries.tenants (
            tenant_id, logical_id, tenant_key, name, slug, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT DO NOTHING`,
        [
            access.tenant.key,
            String(access.tenant.id || ''),
            access.tenant.key,
            String(access.tenant.name || ''),
            String(access.tenant.slug || ''),
            now
        ]
    );
}

async function ensureModuleRevision(client, tenantKey) {
    const now = new Date().toISOString();
    await client.query(
        `INSERT INTO nofries.module_revisions (
            tenant_id, module, schema_version, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, 0, $4, $4)
        ON CONFLICT (tenant_id, module) DO NOTHING`,
        [tenantKey, MODULE_NAME, LIFECYCLE_SCHEMA_VERSION, now]
    );
}

async function loadState(client, access, options = {}) {
    const lockClause = options.revisionLock === 'update'
        ? 'FOR UPDATE'
        : options.revisionLock === 'share'
            ? 'FOR SHARE'
            : '';
    const revisionSql = `SELECT schema_version, revision
        FROM nofries.module_revisions
        WHERE tenant_id = $1 AND module = $2
        ${lockClause}`.trim();
    const revisionResult = await client.query(revisionSql, [access.tenant.key, MODULE_NAME]);
    if (!revisionResult.rows.length) return normaliseState(createEmptyState(access), access);
    const revision = revisionResult.rows[0];
    const schemaVersion = numericValue(revision.schema_version, LIFECYCLE_SCHEMA_VERSION);
    if (schemaVersion > LIFECYCLE_SCHEMA_VERSION) {
        throw new LifecycleRepositoryError(409, 'Lifecycle data was written by a newer application version', {
            code: 'lifecycle_schema_version_unsupported',
            schemaVersion,
            supportedVersion: LIFECYCLE_SCHEMA_VERSION
        });
    }

    const tenantResult = await client.query(
        `SELECT logical_id, tenant_key, name, slug, created_at, updated_at
        FROM nofries.tenants
        WHERE tenant_id = $1`,
        [access.tenant.key]
    );
    const usersResult = await client.query(
        `SELECT email, principal_id, identity_tenant_id, subject_key, payload
        FROM nofries.lifecycle_users
        WHERE tenant_key = $1
        ORDER BY lower(email), email`,
        [access.tenant.key]
    );
    const organisationsResult = await client.query(
        `SELECT organisation_id, payload
        FROM nofries.lifecycle_organisations
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const conversationsResult = await client.query(
        `SELECT conversation_id, organisation_id, session_hash, payload
        FROM nofries.lifecycle_conversations
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const prospectAdmissionsResult = await client.query(
        `SELECT session_hash, client_key_hash, payload
        FROM nofries.lifecycle_prospect_admissions
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const prospectSecurityResult = await client.query(
        `SELECT event_id, session_hash, client_key_hash, payload
        FROM nofries.lifecycle_prospect_security_events
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const approvalsResult = await client.query(
        `SELECT organisation_id, payload
        FROM nofries.lifecycle_approvals
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const operatorTasksResult = await client.query(
        `SELECT task_id, organisation_id, conversation_id, payload
        FROM nofries.lifecycle_operator_tasks
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const schedulesResult = await client.query(
        `SELECT schedule_id, organisation_id, job_type, payload
        FROM nofries.lifecycle_schedules
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const controlRunsResult = await client.query(
        `SELECT run_id, organisation_id, schedule_id, payload
        FROM nofries.lifecycle_control_runs
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const deadLettersResult = await client.query(
        `SELECT dead_letter_id, organisation_id, operation_id, payload
        FROM nofries.lifecycle_dead_letters
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const receiptsResult = await client.query(
        `SELECT operation_id, payload_hash, receipt_kind, organisation_id,
            sales_customer_id, assessment_id, received_at, received_by,
            rematerialized_at, rematerialized_by, payload
        FROM nofries.lifecycle_inbox_receipts
        WHERE tenant_key = $1
        ORDER BY received_at, operation_id`,
        [access.tenant.key]
    );
    const auditResult = await client.query(
        `SELECT event_id, organisation_id, actor_principal_id, occurred_at, payload
        FROM (
            SELECT sequence_no, event_id, organisation_id, actor_principal_id, occurred_at, payload
            FROM nofries.lifecycle_audit
            WHERE tenant_key = $1
            ORDER BY sequence_no DESC
            LIMIT $2
        ) AS recent_audit
        ORDER BY sequence_no`,
        [access.tenant.key, MAX_LOADED_AUDIT_EVENTS]
    );
    const observabilityResult = await client.query(
        `SELECT event_id, organisation_id, conversation_id, observed_at, payload
        FROM nofries.lifecycle_observability
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );
    const correctionsResult = await client.query(
        `SELECT correction_id, organisation_id, occurred_at, payload
        FROM nofries.lifecycle_operator_corrections
        WHERE tenant_key = $1
        ORDER BY sequence_no`,
        [access.tenant.key]
    );

    const organisations = organisationsResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
        id: String(row.organisation_id || '')
    }));

    const users = {};
    for (const row of usersResult.rows) {
        const payload = recordPayload(row.payload);
        const email = String(row.email || payload.email || '').trim().toLowerCase();
        if (!email) continue;
        users[email] = Object.assign({}, payload, {
            email,
            principalId: String(row.principal_id || payload.principalId || ''),
            identityTenantId: String(row.identity_tenant_id || payload.identityTenantId || ''),
            subjectKey: String(row.subject_key || payload.subjectKey || '')
        });
    }
    const receipts = {};
    for (const row of receiptsResult.rows) {
        const operationId = String(row.operation_id || '');
        receipts[operationId] = Object.assign({}, recordPayload(row.payload), {
            operationId,
            payloadHash: String(row.payload_hash || ''),
            kind: String(row.receipt_kind || ''),
            organisationId: String(row.organisation_id || ''),
            salesCustomerId: String(row.sales_customer_id || ''),
            assessmentId: String(row.assessment_id || ''),
            receivedAt: isoValue(row.received_at),
            receivedBy: String(row.received_by || ''),
            rematerializedAt: isoValue(row.rematerialized_at),
            rematerializedBy: String(row.rematerialized_by || '')
        });
    }

    const tenant = tenantResult.rows[0] || {};
    return normaliseState({
        schemaVersion: numericValue(revision.schema_version, LIFECYCLE_SCHEMA_VERSION),
        revision: numericValue(revision.revision, 0),
        tenant: {
            id: String(tenant.logical_id || access.tenant.id || ''),
            key: String(tenant.tenant_key || access.tenant.key),
            name: String(tenant.name || access.tenant.name || ''),
            slug: String(tenant.slug || access.tenant.slug || ''),
            createdAt: isoValue(tenant.created_at),
            updatedAt: isoValue(tenant.updated_at)
        },
        users,
        organisations,
        conversations: conversationsResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.conversation_id || ''),
            organisationId: String(row.organisation_id || ''),
            sessionHash: String(row.session_hash || '')
        })),
        prospectAdmissions: prospectAdmissionsResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            sessionHash: String(row.session_hash || ''),
            clientKeyHash: String(row.client_key_hash || '')
        })),
        prospectSecurityEvents: prospectSecurityResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.event_id || ''),
            sessionHash: String(row.session_hash || ''),
            clientKeyHash: String(row.client_key_hash || '')
        })),
        approvals: approvalsResult.rows.map((row) => jsonValue(row.payload)),
        operatorTasks: operatorTasksResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.task_id || ''),
            organisationId: String(row.organisation_id || ''),
            conversationId: String(row.conversation_id || '')
        })),
        schedules: schedulesResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.schedule_id || ''),
            organisationId: String(row.organisation_id || ''),
            jobType: String(row.job_type || recordPayload(row.payload).jobType || '')
        })),
        controlRuns: controlRunsResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.run_id || ''),
            organisationId: String(row.organisation_id || ''),
            scheduleId: String(row.schedule_id || '')
        })),
        deadLetters: deadLettersResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.dead_letter_id || ''),
            organisationId: String(row.organisation_id || ''),
            operationId: String(row.operation_id || '')
        })),
        inboxReceiptsById: receipts,
        audit: auditResult.rows.map(auditRow),
        observability: observabilityResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.event_id || ''),
            organisationId: String(row.organisation_id || ''),
            conversationId: String(row.conversation_id || ''),
            at: isoValue(row.observed_at) || recordPayload(row.payload).at
        })),
        operatorCorrections: correctionsResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.correction_id || ''),
            organisationId: String(row.organisation_id || ''),
            at: isoValue(row.occurred_at) || recordPayload(row.payload).at
        }))
    }, access);
}

async function persistTenant(client, state) {
    await client.query(
        `UPDATE nofries.tenants SET
            logical_id = $2,
            tenant_key = $3,
            name = $4,
            slug = $5,
            updated_at = $6
        WHERE tenant_id = $1`,
        [
            state.tenant.key,
            state.tenant.id,
            state.tenant.key,
            state.tenant.name,
            state.tenant.slug,
            state.tenant.updatedAt
        ]
    );
}

async function replaceMutableState(client, tenantKey, state) {
    await deleteMutableState(client, tenantKey);
    await insertUsers(client, tenantKey, state.users);
    await insertOrganisations(client, tenantKey, state.organisations);
    await insertOrganisationChildren(client, tenantKey, state.organisations);
    await insertConversations(client, tenantKey, state.conversations);
    await insertProspectAdmissions(client, tenantKey, state.prospectAdmissions);
    await insertProspectSecurityEvents(client, tenantKey, state.prospectSecurityEvents);
    await insertApprovals(client, tenantKey, state.approvals);
    await insertOperatorTasks(client, tenantKey, state.operatorTasks);
    await insertSchedules(client, tenantKey, state.schedules);
    await insertControlRuns(client, tenantKey, state.controlRuns);
    await insertDeadLetters(client, tenantKey, state.deadLetters);
    await insertObservability(client, tenantKey, state.observability);
    await insertOperatorCorrections(client, tenantKey, state.operatorCorrections);
}

async function deleteMutableState(client, tenantKey) {
    const statements = [
        'DELETE FROM nofries.lifecycle_device_provider_refs WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_onboarding_devices WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_external_references WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_activation_requests WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_operator_tasks WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_observability WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_operator_corrections WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_conversations WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_organisations WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_users WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_prospect_admissions WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_prospect_security_events WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_approvals WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_schedules WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_control_runs WHERE tenant_key = $1',
        'DELETE FROM nofries.lifecycle_dead_letters WHERE tenant_key = $1'
    ];
    for (const sql of statements) await client.query(sql, [tenantKey]);
}

async function insertUsers(client, tenantKey, users) {
    for (const [rawEmail, rawUser] of Object.entries(users || {})) {
        const email = String(rawEmail || rawUser && rawUser.email || '').trim().toLowerCase();
        if (!email) throw storageInvalid('A lifecycle user is missing its email');
        const user = rawUser && typeof rawUser === 'object' ? rawUser : { email };
        const identityTenantId = String(user.identityTenantId || '').trim().toLowerCase();
        const principalId = String(user.principalId || '').trim().toLowerCase();
        const subjectKey = String(
            user.subjectKey || identityTenantId && principalId && `${identityTenantId}:${principalId}` || ''
        ).trim().toLowerCase();
        await client.query(
            `INSERT INTO nofries.lifecycle_users (
                tenant_key, email, identity_tenant_id, principal_id, subject_key,
                payload, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
            [
                tenantKey,
                email,
                nullableText(identityTenantId),
                nullableText(principalId),
                nullableText(subjectKey),
                JSON.stringify(Object.assign({}, user, { email, identityTenantId, principalId, subjectKey })),
                isoValue(user.createdAt) || new Date().toISOString(),
                isoValue(user.lastSeenAt) || isoValue(user.createdAt) || new Date().toISOString()
            ]
        );
    }
}

async function insertOrganisations(client, tenantKey, organisations) {
    for (const [position, organisation] of records(organisations).entries()) {
        const id = requiredId(organisation && organisation.id, 'organisation');
        const datto = dattoClaims(organisation);
        await client.query(
            `INSERT INTO nofries.lifecycle_organisations (
                tenant_key, organisation_id, sequence_no, datto_rmm_site_uid,
                datto_rmm_site_name_key, datto_rmm_provisioning_claim_id,
                payload, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
            [
                tenantKey,
                id,
                position,
                nullableText(datto.siteUid),
                nullableText(datto.siteNameKey),
                nullableText(datto.claimId),
                JSON.stringify(cloneJson(organisation)),
                isoValue(organisation.createdAt) || new Date().toISOString(),
                isoValue(organisation.updatedAt) || isoValue(organisation.createdAt) || new Date().toISOString()
            ]
        );
    }
}

async function insertOrganisationChildren(client, tenantKey, organisations) {
    for (const organisation of records(organisations)) {
        const organisationId = requiredId(organisation && organisation.id, 'organisation');
        const devices = records(organisation && organisation.onboarding && organisation.onboarding.devices);
        for (const [position, device] of devices.entries()) {
            const deviceId = requiredId(device && device.id, 'onboarding device');
            await client.query(
                `INSERT INTO nofries.lifecycle_onboarding_devices (
                    tenant_key, organisation_id, device_id, sequence_no, payload
                ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
                [tenantKey, organisationId, deviceId, position, JSON.stringify(cloneJson(device))]
            );
            for (const [refPosition, ref] of records(device.providerRefs).entries()) {
                const providerSystem = requiredId(ref && ref.system, 'device provider system');
                const externalId = requiredId(ref && ref.externalId, 'device provider identifier');
                await client.query(
                    `INSERT INTO nofries.lifecycle_device_provider_refs (
                        tenant_key, organisation_id, device_id, sequence_no,
                        provider_system, external_id, payload
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
                    [tenantKey, organisationId, deviceId, refPosition, providerSystem, externalId, JSON.stringify(ref)]
                );
            }
        }
        const externalRefs = records(organisation && organisation.customerMaster && organisation.customerMaster.externalRefs);
        for (const [position, ref] of externalRefs.entries()) {
            await client.query(
                `INSERT INTO nofries.lifecycle_external_references (
                    tenant_key, organisation_id, external_reference_id, sequence_no,
                    provider_system, record_type, provider_scope_id, external_id,
                    claim_status, payload
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
                [
                    tenantKey,
                    organisationId,
                    requiredId(ref && ref.id, 'external reference'),
                    position,
                    requiredId(ref && ref.system, 'external reference provider'),
                    requiredId(ref && ref.recordType, 'external reference record type'),
                    String(ref && ref.providerScopeId || ''),
                    requiredId(ref && ref.externalId, 'external reference identifier'),
                    String(ref && ref.status || 'pending'),
                    JSON.stringify(ref)
                ]
            );
        }
        for (const [position, request] of records(organisation && organisation.activationRequests).entries()) {
            await client.query(
                `INSERT INTO nofries.lifecycle_activation_requests (
                    tenant_key, organisation_id, activation_request_id, sequence_no,
                    idempotency_key, payload
                ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
                [
                    tenantKey,
                    organisationId,
                    requiredId(request && request.id, 'activation request'),
                    position,
                    requiredId(request && request.idempotencyKey, 'activation idempotency key'),
                    JSON.stringify(request)
                ]
            );
        }
    }
}

async function insertConversations(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_conversations (
                tenant_key, conversation_id, sequence_no, organisation_id, session_hash, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'conversation'),
                position,
                nullableText(item && item.organisationId),
                String(item && item.sessionHash || ''),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertProspectAdmissions(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_prospect_admissions (
                tenant_key, sequence_no, session_hash, client_key_hash, payload
            ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
                tenantKey,
                position,
                requiredId(item && item.sessionHash, 'prospect admission session hash'),
                requiredId(item && item.clientKeyHash, 'prospect admission client hash'),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertProspectSecurityEvents(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_prospect_security_events (
                tenant_key, event_id, sequence_no, session_hash, client_key_hash, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'prospect security event'),
                position,
                requiredId(item && item.sessionHash, 'prospect security session hash'),
                requiredId(item && item.clientKeyHash, 'prospect security client hash'),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertApprovals(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        const approval = objectValue(item);
        const payload = JSON.stringify(item) ?? 'null';
        await client.query(
            `INSERT INTO nofries.lifecycle_approvals (
                tenant_key, sequence_no, organisation_id, payload
            ) VALUES ($1, $2, $3, $4::jsonb)`,
            [tenantKey, position, nullableText(approval.organisationId), payload]
        );
    }
}

async function insertOperatorTasks(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_operator_tasks (
                tenant_key, task_id, sequence_no, organisation_id, conversation_id, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'operator task'),
                position,
                requiredId(item && item.organisationId, 'operator task organisation'),
                nullableText(item && item.conversationId),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertSchedules(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_schedules (
                tenant_key, schedule_id, sequence_no, organisation_id, job_type, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'schedule'),
                position,
                requiredId(item && item.organisationId, 'schedule organisation'),
                requiredId(item && item.jobType, 'schedule job type'),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertControlRuns(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_control_runs (
                tenant_key, run_id, sequence_no, organisation_id, schedule_id, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'control run'),
                position,
                nullableText(item && item.organisationId),
                nullableText(item && item.scheduleId),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertDeadLetters(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_dead_letters (
                tenant_key, dead_letter_id, sequence_no, organisation_id, operation_id, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'dead letter'),
                position,
                nullableText(item && item.organisationId),
                nullableText(item && item.operationId),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertObservability(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_observability (
                tenant_key, event_id, sequence_no, organisation_id,
                conversation_id, observed_at, payload
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'observability event'),
                position,
                nullableText(item && item.organisationId),
                nullableText(item && item.conversationId),
                isoValue(item && item.at) || new Date().toISOString(),
                JSON.stringify(item)
            ]
        );
    }
}

async function insertOperatorCorrections(client, tenantKey, values) {
    for (const [position, item] of records(values).entries()) {
        await client.query(
            `INSERT INTO nofries.lifecycle_operator_corrections (
                tenant_key, correction_id, sequence_no, organisation_id, occurred_at, payload
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                tenantKey,
                requiredId(item && item.id, 'operator correction'),
                position,
                requiredId(item && item.organisationId, 'operator correction organisation'),
                isoValue(item && item.at) || new Date().toISOString(),
                JSON.stringify(item)
            ]
        );
    }
}

async function persistInboxReceipts(client, tenantKey, currentValue, storedValue) {
    const current = objectValue(currentValue);
    const stored = objectValue(storedValue);
    for (const [operationId, receiptValue] of Object.entries(current)) {
        const receipt = objectValue(receiptValue);
        if (!stored[operationId]) {
            await client.query(
                `INSERT INTO nofries.lifecycle_inbox_receipts (
                    tenant_key, operation_id, payload_hash, receipt_kind, organisation_id,
                    sales_customer_id, assessment_id, received_at, received_by,
                    rematerialized_at, rematerialized_by, payload
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
                [
                    tenantKey,
                    operationId,
                    String(receipt.payloadHash || ''),
                    String(receipt.kind || ''),
                    String(receipt.organisationId || ''),
                    String(receipt.salesCustomerId || ''),
                    String(receipt.assessmentId || ''),
                    isoValue(receipt.receivedAt),
                    String(receipt.receivedBy || ''),
                    nullableIso(receipt.rematerializedAt),
                    nullableText(receipt.rematerializedBy),
                    JSON.stringify(receipt)
                ]
            );
            continue;
        }
        if (
            String(receipt.rematerializedAt || '') !== String(stored[operationId].rematerializedAt || '') ||
            String(receipt.rematerializedBy || '') !== String(stored[operationId].rematerializedBy || '')
        ) {
            await client.query(
                `UPDATE nofries.lifecycle_inbox_receipts SET
                    rematerialized_at = $3,
                    rematerialized_by = $4
                WHERE tenant_key = $1 AND operation_id = $2`,
                [
                    tenantKey,
                    operationId,
                    nullableIso(receipt.rematerializedAt),
                    nullableText(receipt.rematerializedBy)
                ]
            );
        }
    }
}

async function appendAuditEvents(client, tenantKey, auditValue, storedValue) {
    const audit = records(auditValue);
    const storedLength = records(storedValue).length;
    for (let index = storedLength; index < audit.length; index += 1) {
        const event = audit[index];
        const inserted = await client.query(
            `INSERT INTO nofries.lifecycle_audit (
                tenant_key, event_id, sequence_no, organisation_id,
                actor_principal_id, occurred_at, payload
            ) VALUES (
                $1,
                $2,
                (SELECT COALESCE(MAX(sequence_no), -1) + 1
                    FROM nofries.lifecycle_audit
                    WHERE tenant_key = $1),
                $3,
                $4,
                $5,
                $6::jsonb
            )
            ON CONFLICT (tenant_key, event_id) DO NOTHING
            RETURNING event_id`,
            [
                tenantKey,
                requiredId(event && event.id, 'audit event'),
                nullableText(event && event.organisationId),
                nullableText(event && event.actorPrincipalId),
                isoValue(event && event.at) || new Date().toISOString(),
                JSON.stringify(event)
            ]
        );
        if (inserted.rowCount !== 1) {
            throw new LifecycleRepositoryError(409, 'Lifecycle audit history cannot be changed', {
                code: 'lifecycle_audit_immutable'
            });
        }
    }
}

async function persistRevision(client, tenantKey, state, originalRevision) {
    const result = await client.query(
        `UPDATE nofries.module_revisions SET
            schema_version = $3,
            revision = $4,
            updated_at = $5
        WHERE tenant_id = $1 AND module = $2 AND revision = $6`,
        [
            tenantKey,
            MODULE_NAME,
            state.schemaVersion,
            state.revision,
            state.tenant.updatedAt,
            originalRevision
        ]
    );
    if (result.rowCount !== 1) throw revisionConflict(originalRevision);
}

function assertLifecycleClaims(state, currentRevision) {
    const subjectKeys = new Set();
    const emails = new Set();
    for (const [rawEmail, user] of Object.entries(objectValue(state.users))) {
        claimUnique(emails, String(rawEmail || '').trim().toLowerCase(), currentRevision);
        const identityTenantId = String(user && user.identityTenantId || '').trim().toLowerCase();
        const principalId = String(user && user.principalId || '').trim().toLowerCase();
        const subjectKey = String(
            user && user.subjectKey || identityTenantId && principalId && `${identityTenantId}:${principalId}` || ''
        ).trim().toLowerCase();
        claimUnique(subjectKeys, subjectKey, currentRevision);
    }

    assertUniqueIds(state.organisations, currentRevision);
    const deviceProviderClaims = new Set();
    const externalClaims = new Set();
    const externalSlots = new Set();
    const dattoSiteUids = new Set();
    const dattoSiteNames = new Set();
    const dattoClaimIds = new Set();
    for (const organisation of records(state.organisations)) {
        const devices = records(organisation && organisation.onboarding && organisation.onboarding.devices);
        assertUniqueIds(devices, currentRevision);
        for (const device of devices) {
            const providerSystems = new Set();
            for (const ref of records(device && device.providerRefs)) {
                const system = String(ref && ref.system || '').trim().toLowerCase();
                const externalId = String(ref && ref.externalId || '').trim().toLowerCase();
                claimUnique(providerSystems, system, currentRevision);
                claimUnique(deviceProviderClaims, system && externalId ? `${system}\u0000${externalId}` : '', currentRevision);
            }
        }
        const externalRefs = records(organisation && organisation.customerMaster && organisation.customerMaster.externalRefs);
        assertUniqueIds(externalRefs, currentRevision);
        for (const ref of externalRefs) {
            if (String(ref && ref.status || '') === 'retired') continue;
            const [system, recordType, providerScopeId, externalId] = [
                ref && ref.system,
                ref && ref.recordType,
                ref && ref.providerScopeId,
                ref && ref.externalId
            ]
                .map((value) => String(value || '').trim().toLowerCase())
            claimUnique(externalClaims, [system, recordType, providerScopeId, externalId].join('\u0000'), currentRevision);
            if (isSingletonExternalSlot(system, recordType)) {
                claimUnique(
                    externalSlots,
                    [organisation.id, system, recordType, providerScopeId].join('\u0000'),
                    currentRevision
                );
            }
        }
        const activationRequests = records(organisation && organisation.activationRequests);
        assertUniqueIds(activationRequests, currentRevision);
        const activationClaims = new Set();
        for (const request of activationRequests) {
            claimUnique(
                activationClaims,
                String(request && request.idempotencyKey || '').trim(),
                currentRevision
            );
        }
        const datto = dattoClaims(organisation, currentRevision);
        claimUnique(dattoSiteUids, datto.siteUid.toLowerCase(), currentRevision);
        claimUnique(dattoSiteNames, datto.siteNameKey.toLowerCase(), currentRevision);
        claimUnique(dattoClaimIds, datto.claimId.toLowerCase(), currentRevision);
    }

    assertUniqueIds(state.conversations, currentRevision);
    const conversationSessions = new Set();
    for (const conversation of records(state.conversations)) {
        claimUnique(
            conversationSessions,
            String(conversation && conversation.sessionHash || '').trim().toLowerCase(),
            currentRevision
        );
    }
    const prospectAdmissionSessions = new Set();
    for (const admission of records(state.prospectAdmissions)) {
        claimUnique(
            prospectAdmissionSessions,
            String(admission && admission.sessionHash || '').trim().toLowerCase(),
            currentRevision
        );
    }
    assertUniqueIds(state.prospectSecurityEvents, currentRevision);
    assertUniqueIds(state.operatorTasks, currentRevision);
    assertUniqueIds(state.schedules, currentRevision);
    const scheduleClaims = new Set();
    for (const schedule of records(state.schedules)) {
        const organisationId = String(schedule && schedule.organisationId || '').trim();
        const jobType = String(schedule && schedule.jobType || '').trim().toLowerCase();
        claimUnique(
            scheduleClaims,
            organisationId && jobType ? `${organisationId}\u0000${jobType}` : '',
            currentRevision
        );
    }
    assertUniqueIds(state.controlRuns, currentRevision);
    assertUniqueIds(state.deadLetters, currentRevision);
    assertUniqueIds(state.audit, currentRevision);
    assertUniqueIds(state.observability, currentRevision);
    assertUniqueIds(state.operatorCorrections, currentRevision);

    for (const [operationId, receiptValue] of Object.entries(objectValue(state.inboxReceiptsById))) {
        const receipt = objectValue(receiptValue);
        if (
            !operationId || receipt.operationId !== operationId ||
            !/^[a-f0-9]{64}$/.test(String(receipt.payloadHash || '')) ||
            receipt.kind !== 'lifecycle.scoping.link' || !receipt.organisationId || !receipt.salesCustomerId ||
            !receipt.assessmentId || !isoValue(receipt.receivedAt) || !receipt.receivedBy
        ) throw revisionConflict(currentRevision);
    }
}

function isSingletonExternalSlot(system, recordType) {
    return new Set([
        'hubspot\u0000company',
        'autotask\u0000account',
        'datto_rmm\u0000site',
        'kaseya_mdr\u0000tenant',
        'kaseya_mdr\u0000organisation',
        'backup\u0000tenant'
    ]).has(`${system}\u0000${recordType}`);
}

function assertUniqueIds(values, currentRevision) {
    const ids = new Set();
    for (const value of records(values)) {
        claimUnique(ids, String(value && value.id || '').trim(), currentRevision);
    }
}

function claimUnique(claims, value, currentRevision) {
    if (!value) return;
    if (claims.has(value)) throw revisionConflict(currentRevision);
    claims.add(value);
}

function assertAuditUnchanged(currentValue, storedValue) {
    const current = records(currentValue);
    const stored = records(storedValue);
    if (!isDeepStrictEqual(current, stored)) {
        throw new LifecycleRepositoryError(409, 'Lifecycle audit history cannot be changed', {
            code: 'lifecycle_audit_immutable'
        });
    }
}

function assertAppendedAudit(currentValue, storedValue) {
    const current = records(currentValue);
    const stored = records(storedValue);
    if (current.length < stored.length || !isDeepStrictEqual(current.slice(0, stored.length), stored)) {
        throw new LifecycleRepositoryError(409, 'Lifecycle audit history cannot be changed', {
            code: 'lifecycle_audit_immutable'
        });
    }
    for (let index = stored.length; index < current.length; index += 1) {
        const event = objectValue(current[index]);
        const previous = current[index - 1];
        const expectedPreviousHash = String(previous && previous.integritySha256 || '');
        if (
            !event.id || event.previousHash !== expectedPreviousHash ||
            !/^[a-f0-9]{64}$/.test(String(event.integritySha256 || '')) ||
            event.integritySha256 !== auditHash(event)
        ) {
            throw new LifecycleRepositoryError(409, 'Lifecycle audit history cannot be changed', {
                code: 'lifecycle_audit_immutable'
            });
        }
    }
}

function assertReceiptChanges(currentValue, storedValue) {
    const current = objectValue(currentValue);
    const stored = objectValue(storedValue);
    for (const [operationId, storedReceipt] of Object.entries(stored)) {
        const currentReceipt = current[operationId];
        if (!currentReceipt || !isDeepStrictEqual(
            immutableReceipt(currentReceipt),
            immutableReceipt(storedReceipt)
        )) {
            throw new LifecycleRepositoryError(409, 'Lifecycle inbox receipt bindings cannot be changed', {
                code: 'lifecycle_inbox_receipt_immutable'
            });
        }
    }
}

function immutableReceipt(value) {
    const receipt = cloneJson(objectValue(value));
    delete receipt.rematerializedAt;
    delete receipt.rematerializedBy;
    return receipt;
}

function dattoClaims(organisation, currentRevision) {
    const value = objectValue(organisation);
    const links = objectValue(value.links);
    const integration = objectValue(objectValue(value.integrations).dattoRmm);
    const provisioning = objectValue(integration.provisioning);
    const activeReferenceUids = records(objectValue(value.customerMaster).externalRefs)
        .filter((ref) => (
            ref && ref.status !== 'retired' && ref.system === 'datto_rmm' && ref.recordType === 'site'
        ))
        .map((ref) => String(ref.externalId || '').trim())
        .filter(Boolean);
    const siteUids = Array.from(new Set([
        String(links.dattoRmmSiteUid || '').trim(),
        String(integration.siteUid || '').trim(),
        ...activeReferenceUids
    ].filter(Boolean).map((item) => item.toLowerCase())));
    if (siteUids.length > 1 && currentRevision !== undefined) throw revisionConflict(currentRevision);
    const siteUid = String(links.dattoRmmSiteUid || integration.siteUid || activeReferenceUids[0] || '').trim();
    const ownsSiteName = Boolean(siteUid || ['preparing', 'prepared'].includes(provisioning.state));
    const siteName = String(provisioning.siteNameKey || integration.siteName || value.displayName || '').trim();
    return {
        siteUid,
        siteNameKey: ownsSiteName ? canonicalDattoSiteName(siteName) : '',
        claimId: String(provisioning.claimId || '').trim()
    };
}

function canonicalDattoSiteName(value) {
    const name = String(value || '').trim().toLocaleLowerCase('en-NZ').replace(/\s+/g, ' ');
    return /^(no fries (?:hq|headquarters))(?: (?:workshop|internal pilot|pilot))?$/.test(name)
        ? 'no fries headquarters'
        : name;
}

function revisionConflict(currentRevision) {
    return new LifecycleRepositoryError(
        409,
        'Lifecycle data changed while you were working. Reload and try again.',
        { code: 'revision_conflict', currentRevision: Number(currentRevision || 0) }
    );
}

function recordPayload(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (error) {
            // Convert malformed persisted content into a bounded storage error below.
        }
    }
    throw storageInvalid('Stored lifecycle data is invalid');
}

function jsonValue(value) {
    return value;
}

function requiredId(value, label) {
    const id = String(value || '').trim();
    if (id) return id;
    throw storageInvalid(`A lifecycle ${label} is missing its stable identifier`);
}

function storageInvalid(message) {
    return new LifecycleRepositoryError(500, message, {
        code: 'lifecycle_storage_invalid'
    });
}

function numericValue(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function isoValue(value) {
    if (!value) return '';
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function nullableIso(value) {
    return isoValue(value) || null;
}

function nullableText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function records(value) {
    return Array.isArray(value) ? value : [];
}

function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function auditRow(row) {
    const payload = recordPayload(row && row.payload);
    return Object.assign({}, payload, {
        id: String(row && row.event_id || ''),
        organisationId: String(row && row.organisation_id || payload.organisationId || ''),
        actorPrincipalId: String(row && row.actor_principal_id || payload.actorPrincipalId || ''),
        at: isoValue(row && row.occurred_at) || payload.at
    });
}

function auditPageOptions(value) {
    const source = objectValue(value);
    const afterSequence = Number(source.afterSequence == null ? -1 : source.afterSequence);
    const requestedLimit = Number(source.limit == null ? 200 : source.limit);
    const throughSequence = source.throughSequence == null ? null : Number(source.throughSequence);
    const expectedRevision = source.expectedRevision == null ? null : Number(source.expectedRevision);
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
        throw new LifecycleRepositoryError(400, 'A valid audit cursor is required', {
            code: 'lifecycle_audit_cursor_invalid'
        });
    }
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_AUDIT_PAGE_SIZE) {
        throw new LifecycleRepositoryError(400, 'A valid audit page size is required', {
            code: 'lifecycle_audit_page_size_invalid'
        });
    }
    if (throughSequence != null && (!Number.isInteger(throughSequence) || throughSequence < -1)) {
        throw new LifecycleRepositoryError(400, 'A valid audit boundary is required', {
            code: 'lifecycle_audit_boundary_invalid'
        });
    }
    if (expectedRevision != null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        throw new LifecycleRepositoryError(400, 'A valid lifecycle revision is required', {
            code: 'invalid_revision'
        });
    }
    return {
        afterSequence,
        expectedRevision,
        throughSequence,
        limit: requestedLimit,
        organisationId: String(source.organisationId || '').trim().slice(0, 180)
    };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
}

function repositoryError(error) {
    if (error instanceof LifecycleRepositoryError) return error;
    if (error instanceof PostgresDatabaseError && error.repositoryError instanceof LifecycleRepositoryError) {
        return error.repositoryError;
    }
    return new LifecycleRepositoryError(503, 'Lifecycle storage is temporarily unavailable', {
        code: 'lifecycle_storage_unavailable'
    });
}

function applicationError(error) {
    if (error instanceof PostgresDatabaseError) return error;
    if (!(error instanceof LifecycleRepositoryError)) {
        return new PostgresDatabaseError('postgres_application_error');
    }
    const carrier = new PostgresDatabaseError('postgres_application_error');
    carrier.repositoryError = error;
    return carrier;
}

module.exports = {
    MAX_AUDIT_PAGE_SIZE,
    MAX_LOADED_AUDIT_EVENTS,
    MODULE_NAME,
    PostgresLifecycleRepository
};
