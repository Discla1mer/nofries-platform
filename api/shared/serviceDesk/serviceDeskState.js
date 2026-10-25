const crypto = require('crypto');

const SERVICE_DESK_SCHEMA_VERSION = 1;
const MAX_AUDIT_EVENTS = 2000;

class ServiceDeskRepositoryError extends Error {
    constructor(statusCode, message, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
    }
}

function createEmptyState(access) {
    assertAccess(access);
    const now = new Date().toISOString();
    return {
        schemaVersion: SERVICE_DESK_SCHEMA_VERSION,
        revision: 0,
        tenant: {
            id: access.tenant.id,
            key: access.tenant.key,
            name: access.tenant.name,
            slug: access.tenant.slug,
            createdAt: now,
            updatedAt: now
        },
        users: {},
        tickets: [],
        audit: []
    };
}

function normaliseState(value, access) {
    const empty = createEmptyState(access);
    const state = value && typeof value === 'object' ? value : {};
    const schemaVersion = state.schemaVersion == null || state.schemaVersion === ''
        ? SERVICE_DESK_SCHEMA_VERSION
        : Number(state.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new ServiceDeskRepositoryError(500, 'The service-desk schema version is invalid', {
            code: 'service_desk_schema_version_invalid',
            schemaVersion: state.schemaVersion
        });
    }
    if (schemaVersion !== SERVICE_DESK_SCHEMA_VERSION) {
        throw new ServiceDeskRepositoryError(409, 'Service-desk data was written by a newer application version', {
            code: 'service_desk_schema_version_unsupported',
            schemaVersion,
            supportedVersion: SERVICE_DESK_SCHEMA_VERSION
        });
    }
    state.schemaVersion = SERVICE_DESK_SCHEMA_VERSION;
    state.revision = Number(state.revision || 0);
    state.tenant = Object.assign({}, empty.tenant, state.tenant || {}, {
        id: access.tenant.id,
        key: access.tenant.key,
        name: access.tenant.name,
        slug: access.tenant.slug
    });
    state.users = state.users && typeof state.users === 'object' ? state.users : {};
    state.tickets = Array.isArray(state.tickets) ? state.tickets : [];
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    upsertUser(state, access);
    return state;
}

function finishMutation(state, access, options = {}) {
    const now = new Date().toISOString();
    state.revision = Number(state.revision || 0) + 1;
    state.tenant.updatedAt = now;
    upsertUser(state, access, now);

    const events = Array.isArray(options.auditEvents) ? options.auditEvents : [];
    for (const event of events) {
        const normalised = normaliseAuditEvent(event, access, now);
        const previous = state.audit[state.audit.length - 1];
        normalised.previousHash = cleanSha256(previous && previous.integritySha256);
        normalised.integritySha256 = auditHash(normalised);
        state.audit.push(normalised);
    }
    if (state.audit.length > MAX_AUDIT_EVENTS) {
        state.audit = state.audit.slice(-MAX_AUDIT_EVENTS);
    }
}

function normaliseAuditEvent(event, access, fallbackAt) {
    const value = event && typeof event === 'object' ? event : {};
    return {
        id: createId('audit'),
        at: validIsoDate(value.at) || fallbackAt,
        tenantKey: access.tenant.key,
        actorType: oneOf(value.actorType, ['user', 'agent', 'system'], 'system'),
        actorId: cleanText(value.actorId, 180),
        actorName: cleanText(value.actorName, 180),
        actorRole: cleanText(value.actorRole, 80),
        action: cleanText(value.action || 'service_desk.updated', 160),
        targetType: cleanText(value.targetType, 80),
        targetId: cleanText(value.targetId, 180),
        ticketId: cleanText(value.ticketId, 180),
        summary: cleanText(value.summary, 600),
        details: safeDetails(value.details),
        previousHash: '',
        integritySha256: ''
    };
}

function upsertUser(state, access, at = new Date().toISOString()) {
    if (!access.user || !access.user.email) {
        return;
    }
    const existing = state.users[access.user.email] || {
        email: access.user.email,
        createdAt: at
    };
    existing.name = access.user.name || existing.name || '';
    existing.role = access.user.role;
    existing.lastSeenAt = at;
    state.users[access.user.email] = existing;
}

function assertRevision(state, expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') {
        return;
    }
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) {
        throw new ServiceDeskRepositoryError(400, 'A valid service-desk revision is required', {
            code: 'invalid_revision'
        });
    }
    if (Number(state.revision || 0) !== expected) {
        throw new ServiceDeskRepositoryError(
            409,
            'This ticket changed while you were working. Reload and try again.',
            { code: 'revision_conflict', currentRevision: Number(state.revision || 0) }
        );
    }
}

function assertAccess(access) {
    if (!access || !access.allowed || !access.tenant || !access.tenant.key) {
        throw new ServiceDeskRepositoryError(403, 'Tenant access is required', {
            code: 'tenant_access_required'
        });
    }
}

function safeDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
        if (/secret|token|password|credential|authorization|cookie/i.test(key)) {
            continue;
        }
        if (['string', 'number', 'boolean'].includes(typeof item)) {
            result[cleanText(key, 80)] = typeof item === 'string' ? cleanText(item, 500) : item;
        }
    }
    return result;
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

function cleanSha256(value) {
    const text = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function validIsoDate(value) {
    const parsed = new Date(value || '');
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function cleanText(value, limit) {
    return String(value || '').trim().slice(0, limit);
}

function createId(prefix) {
    return `${prefix}_${typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`}`;
}

module.exports = {
    MAX_AUDIT_EVENTS,
    SERVICE_DESK_SCHEMA_VERSION,
    ServiceDeskRepositoryError,
    assertAccess,
    assertRevision,
    createEmptyState,
    finishMutation,
    normaliseState
};
