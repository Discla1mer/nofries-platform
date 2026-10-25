const {
    PostgresDatabaseError,
    createPostgresDatabase
} = require('../database/postgres');
const { isDeepStrictEqual } = require('util');
const {
    MAX_AUDIT_EVENTS,
    SERVICE_DESK_SCHEMA_VERSION,
    ServiceDeskRepositoryError,
    assertAccess,
    assertRevision,
    createEmptyState,
    finishMutation,
    normaliseState
} = require('./serviceDeskState');

const MODULE_NAME = 'service_desk';

class PostgresServiceDeskRepository {
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
            throw new ServiceDeskRepositoryError(500, 'PostgreSQL service-desk storage is not configured', {
                code: 'service_desk_storage_not_configured'
            });
        }
    }

    async read(access) {
        assertAccess(access);
        try {
            return await this.database.withTenantTransaction(access.tenant.key, async (client) => (
                loadState(client, access)
            ));
        } catch (error) {
            throw repositoryError(error);
        }
    }

    async mutate(access, options = {}, mutator) {
        assertAccess(access);
        try {
            return await this.database.withTenantTransaction(access.tenant.key, async (client) => {
                await ensureTenant(client, access);
                await ensureModuleRevision(client, access.tenant.key);

                const state = await loadState(client, access, { lockRevision: true });
                const originalRevision = state.revision;
                const storedAudit = snapshotAudit(state.audit);
                const storedAuditIds = new Set(storedAudit.map((event) => String(event && event.id || '')));
                let result;
                try {
                    assertRevision(state, options.expectedRevision);
                    result = await mutator(state);
                    assertUniqueTicketIdentities(state.tickets, originalRevision);
                    assertAuditUnchanged(state.audit, storedAudit);
                } catch (error) {
                    throw applicationError(error);
                }
                finishMutation(state, access, options);
                await persistTenant(client, state);
                await persistUsers(client, access.tenant.key, state.users);
                await persistTickets(client, access.tenant.key, state.tickets);
                await appendAuditEvents(client, access.tenant.key, state.audit, storedAuditIds);
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

async function ensureModuleRevision(client, tenantId) {
    const now = new Date().toISOString();
    await client.query(
        `INSERT INTO nofries.module_revisions (
            tenant_id, module, schema_version, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, 0, $4, $4)
        ON CONFLICT (tenant_id, module) DO NOTHING`,
        [tenantId, MODULE_NAME, SERVICE_DESK_SCHEMA_VERSION, now]
    );
}

async function loadState(client, access, options = {}) {
    const revisionQuery = options.lockRevision
        ? `SELECT schema_version, revision
            FROM nofries.module_revisions
            WHERE tenant_id = $1 AND module = $2
            FOR UPDATE`
        : `SELECT schema_version, revision
            FROM nofries.module_revisions
            WHERE tenant_id = $1 AND module = $2`;
    const revisionResult = await client.query(revisionQuery, [access.tenant.key, MODULE_NAME]);
    if (!revisionResult.rows.length) {
        return createEmptyState(access);
    }

    const tenantResult = await client.query(
        `SELECT logical_id, tenant_key, name, slug, created_at, updated_at
        FROM nofries.tenants
        WHERE tenant_id = $1`,
        [access.tenant.key]
    );
    const usersResult = await client.query(
        `SELECT email, payload
        FROM nofries.service_desk_users
        WHERE tenant_id = $1
        ORDER BY email`,
        [access.tenant.key]
    );
    const ticketsResult = await client.query(
        `SELECT ticket_id, payload
        FROM nofries.service_desk_tickets
        WHERE tenant_id = $1
        ORDER BY created_at, ticket_id`,
        [access.tenant.key]
    );
    const auditResult = await client.query(
        `SELECT event_id, payload
        FROM (
            SELECT event_id, sequence_no, payload
            FROM nofries.service_desk_audit
            WHERE tenant_id = $1
            ORDER BY sequence_no DESC
            LIMIT $2
        ) AS recent
        ORDER BY sequence_no`,
        [access.tenant.key, MAX_AUDIT_EVENTS]
    );

    const revision = revisionResult.rows[0];
    const tenant = tenantResult.rows[0] || {};
    const users = {};
    for (const row of usersResult.rows) {
        const payload = recordPayload(row.payload);
        const email = String(row.email || payload.email || '').trim().toLowerCase();
        if (email) users[email] = Object.assign({}, payload, { email });
    }

    const state = {
        schemaVersion: numericValue(revision.schema_version, SERVICE_DESK_SCHEMA_VERSION),
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
        tickets: ticketsResult.rows.map((row) => {
            const payload = recordPayload(row.payload);
            return Object.assign({}, payload, { id: String(row.ticket_id || '') });
        }),
        audit: auditResult.rows.map((row) => Object.assign({}, recordPayload(row.payload), {
            id: String(row.event_id || '')
        }))
    };
    return normaliseState(state, access);
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
            String(state.tenant.id || ''),
            state.tenant.key,
            String(state.tenant.name || ''),
            String(state.tenant.slug || ''),
            state.tenant.updatedAt
        ]
    );
}

async function persistUsers(client, tenantId, users) {
    const entries = Object.entries(users && typeof users === 'object' ? users : {})
        .filter(([email]) => Boolean(String(email || '').trim()));
    const emails = entries.map(([email]) => String(email).trim().toLowerCase());
    await client.query(
        `DELETE FROM nofries.service_desk_users
        WHERE tenant_id = $1 AND NOT (email = ANY($2::text[]))`,
        [tenantId, emails]
    );

    for (const [rawEmail, value] of entries) {
        const email = String(rawEmail).trim().toLowerCase();
        const payload = value && typeof value === 'object' ? value : { email };
        const createdAt = isoValue(payload.createdAt) || new Date().toISOString();
        const updatedAt = isoValue(payload.lastSeenAt) || createdAt;
        await client.query(
            `INSERT INTO nofries.service_desk_users (
                tenant_id, email, payload, created_at, updated_at
            ) VALUES ($1, $2, $3::jsonb, $4, $5)
            ON CONFLICT (tenant_id, email) DO UPDATE SET
                payload = EXCLUDED.payload,
                updated_at = EXCLUDED.updated_at`,
            [tenantId, email, JSON.stringify(payload), createdAt, updatedAt]
        );
    }
}

async function persistTickets(client, tenantId, tickets) {
    const records = Array.isArray(tickets) ? tickets : [];
    const ticketIds = records.map((ticket) => String(ticket && ticket.id || '')).filter(Boolean);
    await client.query(
        `DELETE FROM nofries.service_desk_tickets
        WHERE tenant_id = $1 AND NOT (ticket_id = ANY($2::text[]))`,
        [tenantId, ticketIds]
    );

    for (const ticket of records) {
        const ticketId = String(ticket && ticket.id || '').trim();
        if (!ticketId) {
            throw storageInvalid('A service-desk ticket is missing its stable identifier');
        }
        const createdAt = isoValue(ticket.createdAt) || new Date().toISOString();
        const updatedAt = isoValue(ticket.updatedAt) || createdAt;
        await client.query(
            `INSERT INTO nofries.service_desk_tickets (
                tenant_id, ticket_id, client_request_id, customer_id, status,
                created_at, updated_at, payload
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (tenant_id, ticket_id) DO UPDATE SET
                client_request_id = EXCLUDED.client_request_id,
                customer_id = EXCLUDED.customer_id,
                status = EXCLUDED.status,
                updated_at = EXCLUDED.updated_at,
                payload = EXCLUDED.payload`,
            [
                tenantId,
                ticketId,
                nullableText(ticket.clientRequestId),
                nullableText(ticket.customer && ticket.customer.id),
                nullableText(ticket.status),
                createdAt,
                updatedAt,
                JSON.stringify(ticket)
            ]
        );
    }
}

async function appendAuditEvents(client, tenantId, audit, storedAuditIds) {
    const events = (Array.isArray(audit) ? audit : []).filter((event) => (
        event && event.id && !storedAuditIds.has(String(event.id))
    ));
    for (const event of events) {
        await client.query(
            `INSERT INTO nofries.service_desk_audit (
                tenant_id, event_id, occurred_at, payload
            ) VALUES ($1, $2, $3, $4::jsonb)`,
            [
                tenantId,
                String(event.id),
                isoValue(event.at) || new Date().toISOString(),
                JSON.stringify(event)
            ]
        );
    }
}

async function persistRevision(client, tenantId, state, originalRevision) {
    const result = await client.query(
        `UPDATE nofries.module_revisions SET
            schema_version = $3,
            revision = $4,
            updated_at = $5
        WHERE tenant_id = $1 AND module = $2 AND revision = $6`,
        [
            tenantId,
            MODULE_NAME,
            state.schemaVersion,
            state.revision,
            state.tenant.updatedAt,
            originalRevision
        ]
    );
    if (result.rowCount !== 1) {
        throw new ServiceDeskRepositoryError(
            409,
            'This ticket changed while you were working. Reload and try again.',
            { code: 'revision_conflict', currentRevision: originalRevision }
        );
    }
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
    throw storageInvalid('Stored service-desk data is invalid');
}

function numericValue(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function isoValue(value) {
    if (!value) return '';
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function nullableText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function storageInvalid(message) {
    return new ServiceDeskRepositoryError(500, message, {
        code: 'service_desk_storage_invalid'
    });
}

function snapshotAudit(audit) {
    return JSON.parse(JSON.stringify(Array.isArray(audit) ? audit : []));
}

function assertAuditUnchanged(audit, snapshot) {
    const current = Array.isArray(audit) ? audit : [];
    if (isDeepStrictEqual(current, snapshot)) return;
    throw new ServiceDeskRepositoryError(409, 'Service-desk audit history cannot be changed', {
        code: 'service_desk_audit_immutable'
    });
}

function assertUniqueTicketIdentities(tickets, currentRevision) {
    const ticketIds = new Set();
    const requestIds = new Set();
    for (const ticket of Array.isArray(tickets) ? tickets : []) {
        const ticketId = String(ticket && ticket.id || '').trim();
        const requestId = String(ticket && ticket.clientRequestId || '').trim();
        if (
            (ticketId && ticketIds.has(ticketId)) ||
            (requestId && requestIds.has(requestId))
        ) {
            throw new ServiceDeskRepositoryError(
                409,
                'This ticket changed while you were working. Reload and try again.',
                { code: 'revision_conflict', currentRevision }
            );
        }
        if (ticketId) ticketIds.add(ticketId);
        if (requestId) requestIds.add(requestId);
    }
}

function repositoryError(error) {
    if (error instanceof ServiceDeskRepositoryError) return error;
    if (error instanceof PostgresDatabaseError && error.repositoryError instanceof Error) {
        return error.repositoryError;
    }
    return new ServiceDeskRepositoryError(503, 'Service-desk storage is temporarily unavailable', {
        code: 'service_desk_storage_unavailable'
    });
}

function applicationError(error) {
    if (error instanceof PostgresDatabaseError) return error;
    const carrier = new PostgresDatabaseError('postgres_application_error');
    carrier.repositoryError = error;
    return carrier;
}

module.exports = {
    MODULE_NAME,
    PostgresServiceDeskRepository
};
