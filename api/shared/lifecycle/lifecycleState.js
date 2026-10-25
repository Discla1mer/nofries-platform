const crypto = require('crypto');
const {
    cleanText,
    createId,
    normaliseOrganisation
} = require('./lifecycleModel');

const LIFECYCLE_SCHEMA_VERSION = 4;
const MAX_OBSERVABILITY_EVENTS = 5000;
const MAX_CONVERSATIONS = 1000;
const MAX_PROSPECT_ADMISSIONS = 5000;
const MAX_PROSPECT_SECURITY_EVENTS = 5000;
const MAX_OPERATOR_TASKS = 3000;
const SENSITIVE_DETAIL_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|connection[_-]?string)/i;

class LifecycleRepositoryError extends Error {
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
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
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
        organisations: [],
        conversations: [],
        prospectAdmissions: [],
        prospectSecurityEvents: [],
        approvals: [],
        operatorTasks: [],
        schedules: [],
        controlRuns: [],
        deadLetters: [],
        inboxReceiptsById: {},
        audit: [],
        observability: [],
        operatorCorrections: []
    };
}

function normaliseState(value, access) {
    const empty = createEmptyState(access);
    const state = migrateLifecycleState(value && typeof value === 'object' ? value : {});
    state.revision = Number(state.revision || 0);
    state.tenant = Object.assign({}, empty.tenant, state.tenant || {}, {
        id: access.tenant.id,
        key: access.tenant.key,
        name: access.tenant.name,
        slug: access.tenant.slug
    });
    state.users = state.users && typeof state.users === 'object' ? state.users : {};
    state.organisations = Array.isArray(state.organisations)
        ? state.organisations.map(normaliseOrganisation)
        : [];
    state.conversations = Array.isArray(state.conversations)
        ? state.conversations.map(normaliseConversation)
        : [];
    state.prospectAdmissions = Array.isArray(state.prospectAdmissions)
        ? state.prospectAdmissions.map(normaliseProspectAdmission).filter((item) => item.sessionHash && item.clientKeyHash)
        : [];
    state.prospectSecurityEvents = Array.isArray(state.prospectSecurityEvents)
        ? state.prospectSecurityEvents.map(normaliseProspectSecurityEvent).filter((item) => (
            item.id && /^[a-f0-9]{64}$/.test(item.sessionHash) && /^[a-f0-9]{64}$/.test(item.clientKeyHash) &&
            item.category && item.createdAt && item.expiresAt
        ))
        : [];
    state.approvals = Array.isArray(state.approvals) ? state.approvals : [];
    state.operatorTasks = Array.isArray(state.operatorTasks)
        ? state.operatorTasks.map(normaliseOperatorTask).filter((task) => task.id && task.organisationId)
        : [];
    state.schedules = Array.isArray(state.schedules)
        ? state.schedules.map(normaliseSchedule).filter((item) => item.id && item.organisationId && item.jobType)
        : [];
    state.controlRuns = Array.isArray(state.controlRuns) ? state.controlRuns.map(normaliseControlRun).filter((item) => item.id) : [];
    state.deadLetters = Array.isArray(state.deadLetters) ? state.deadLetters.map(normaliseDeadLetter).filter((item) => item.id) : [];
    state.inboxReceiptsById = state.inboxReceiptsById && typeof state.inboxReceiptsById === 'object'
        ? state.inboxReceiptsById
        : {};
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.observability = Array.isArray(state.observability) ? state.observability : [];
    state.operatorCorrections = Array.isArray(state.operatorCorrections) ? state.operatorCorrections : [];
    upsertUser(state, access);
    return state;
}

function normaliseConversation(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180),
        organisationId: cleanText(source.organisationId, 180),
        sessionHash: cleanText(source.sessionHash, 128),
        channel: source.channel === 'voice' ? 'voice' : 'text',
        status: ['active', 'closed', 'escalated'].includes(source.status) ? source.status : 'active',
        messages: Array.isArray(source.messages) ? source.messages.slice(-80).map(normaliseMessage) : [],
        summary: cleanText(source.summary, 4000),
        currentNeed: cleanText(source.currentNeed, 1000),
        concerns: cleanStringList(source.concerns, 40, 500),
        nextAction: normaliseNextAction(source.nextAction),
        escalation: Object.assign({ required: false, reason: '', requestedAt: '' }, source.escalation || {}),
        ai: Object.assign({ agent: 'prospect_agent', model: '', runtime: '', confidence: 1, lastRunAt: '' }, source.ai || {}),
        createdAt: cleanText(source.createdAt, 40) || new Date().toISOString(),
        updatedAt: cleanText(source.updatedAt, 40) || new Date().toISOString()
    };
}

function normaliseProspectAdmission(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        sessionHash: cleanText(source.sessionHash, 128),
        clientKeyHash: cleanText(source.clientKeyHash, 128),
        createdAt: validIsoDate(source.createdAt) || new Date().toISOString()
    };
}

function normaliseProspectSecurityEvent(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180) || createId('security_event'),
        sessionHash: cleanText(source.sessionHash, 128).toLowerCase(),
        clientKeyHash: cleanText(source.clientKeyHash, 128).toLowerCase(),
        category: source.category === 'prompt_injection' ? source.category : '',
        detectorVersion: cleanText(source.detectorVersion, 80),
        signals: cleanStringList(source.signals, 8, 80),
        attemptOrdinal: Math.max(1, Math.min(999, Number(source.attemptOrdinal) || 1)),
        networkIdentifierAvailable: Boolean(source.networkIdentifierAvailable),
        action: source.action === 'strong_warn' ? 'strong_warn' : 'warn',
        createdAt: validIsoDate(source.createdAt),
        expiresAt: validIsoDate(source.expiresAt)
    };
}

function normaliseMessage(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180) || createId('message'),
        role: source.role === 'assistant' ? 'assistant' : 'user',
        text: cleanText(source.text, 4000),
        at: cleanText(source.at, 40) || new Date().toISOString()
    };
}

function normaliseNextAction(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        type: cleanText(source.type || 'continue_chat', 80),
        timing: cleanText(source.timing, 180),
        detail: cleanText(source.detail, 1000)
    };
}

function normaliseOperatorTask(value) {
    const source = value && typeof value === 'object' ? value : {};
    const status = oneOf(source.status, ['open', 'completed', 'cancelled'], 'open');
    return {
        id: cleanText(source.id, 180),
        organisationId: cleanText(source.organisationId, 180),
        conversationId: cleanText(source.conversationId, 180),
        type: cleanText(source.type || 'operator_review', 120),
        title: cleanText(source.title || 'Review lifecycle handoff', 240),
        detail: cleanText(source.detail, 1200),
        status,
        priority: oneOf(source.priority, ['low', 'medium', 'high'], 'medium'),
        ownerRole: cleanText(source.ownerRole || 'service_owner', 80),
        source: cleanText(source.source || 'lifecycle', 120),
        evidence: safeDetails(source.evidence),
        createdAt: validIsoDate(source.createdAt) || new Date().toISOString(),
        createdBy: cleanText(source.createdBy || 'system', 180),
        updatedAt: validIsoDate(source.updatedAt) || validIsoDate(source.createdAt) || new Date().toISOString(),
        updatedBy: cleanText(source.updatedBy || source.createdBy || 'system', 180),
        completedAt: status === 'completed' ? validIsoDate(source.completedAt) : '',
        completedBy: status === 'completed' ? cleanText(source.completedBy, 180) : '',
        outcome: status === 'completed' ? cleanText(source.outcome, 240) : ''
    };
}

function finishMutation(state, access, options = {}) {
    const now = new Date().toISOString();
    state.revision = Number(state.revision || 0) + 1;
    state.tenant.updatedAt = now;
    upsertUser(state, access, now);

    const auditEvents = Array.isArray(options.auditEvents) ? options.auditEvents : [];
    for (const event of auditEvents) {
        const normalised = normaliseAuditEvent(event, access, now);
        const previous = state.audit[state.audit.length - 1];
        normalised.previousHash = cleanText(previous && previous.integritySha256, 64);
        normalised.integritySha256 = auditHash(normalised);
        state.audit.push(normalised);
    }
    const observabilityEvents = Array.isArray(options.observabilityEvents) ? options.observabilityEvents : [];
    for (const event of observabilityEvents) {
        state.observability.push(normaliseObservabilityEvent(event, access, now));
    }
    if (state.observability.length > MAX_OBSERVABILITY_EVENTS) {
        state.observability = state.observability.slice(-MAX_OBSERVABILITY_EVENTS);
    }
    if (state.conversations.length > MAX_CONVERSATIONS) {
        state.conversations = state.conversations.slice(-MAX_CONVERSATIONS);
    }
    if (state.prospectAdmissions.length > MAX_PROSPECT_ADMISSIONS) {
        state.prospectAdmissions = state.prospectAdmissions.slice(-MAX_PROSPECT_ADMISSIONS);
    }
    if (state.prospectSecurityEvents.length > MAX_PROSPECT_SECURITY_EVENTS) {
        state.prospectSecurityEvents = state.prospectSecurityEvents.slice(-MAX_PROSPECT_SECURITY_EVENTS);
    }
    if (state.operatorTasks.length > MAX_OPERATOR_TASKS) {
        state.operatorTasks = state.operatorTasks.slice(-MAX_OPERATOR_TASKS);
    }

    const retainedConversationIds = new Set(state.conversations
        .map((item) => item && item.id)
        .filter(Boolean));
    for (const records of [state.operatorTasks, state.observability]) {
        for (const record of records) {
            if (
                record && record.conversationId &&
                !retainedConversationIds.has(record.conversationId)
            ) record.conversationId = '';
        }
    }
}

function normaliseAuditEvent(value, access, fallbackAt) {
    const event = value && typeof value === 'object' ? value : {};
    const actorType = oneOf(event.actorType, ['user', 'agent', 'system'], 'system');
    const actorEmail = cleanText(access.user && access.user.email, 180);
    const suppliedActorId = cleanText(event.actorId, 180);
    const subjectKey = immutableSubjectKey(access);
    const humanActor = actorType === 'user' || Boolean(
        actorType === 'system' && actorEmail && suppliedActorId === actorEmail
    );
    return {
        id: cleanText(event.id, 180) || createId('audit'),
        at: validIsoDate(event.at) || fallbackAt,
        tenantKey: access.tenant.key,
        actorType,
        actorId: humanActor && subjectKey
            ? subjectKey
            : suppliedActorId || (actorType === 'user' ? actorEmail : 'system'),
        actorPrincipalId: humanActor ? cleanText(access.user && access.user.principalId, 180) : '',
        actorSubjectKey: humanActor ? subjectKey : '',
        actorEmail: humanActor ? actorEmail : '',
        actorName: humanActor ? cleanText(access.user && access.user.name, 180) : '',
        actorRole: cleanText(event.actorRole || access.user && access.user.role, 80),
        action: cleanText(event.action || 'lifecycle.updated', 160),
        targetType: cleanText(event.targetType, 80),
        targetId: cleanText(event.targetId, 180),
        organisationId: cleanText(event.organisationId, 180),
        conversationId: cleanText(event.conversationId, 180),
        correlationId: cleanText(event.correlationId || access.requestContext && access.requestContext.correlationId, 180),
        operationId: cleanText(event.operationId, 180),
        causationId: cleanText(event.causationId, 180),
        summary: cleanText(event.summary, 600),
        details: safeDetails(event.details),
        previousHash: '',
        integritySha256: ''
    };
}

function migrateLifecycleState(value) {
    const state = value && typeof value === 'object' ? value : {};
    let version = Number(state.schemaVersion || 1);
    if (!Number.isInteger(version) || version < 1) version = 1;
    if (version > LIFECYCLE_SCHEMA_VERSION) {
        throw new LifecycleRepositoryError(409, 'Lifecycle data was written by a newer application version', {
            code: 'lifecycle_schema_version_unsupported',
            schemaVersion: version,
            supportedVersion: LIFECYCLE_SCHEMA_VERSION
        });
    }
    while (version < LIFECYCLE_SCHEMA_VERSION) {
        if (version === 1) {
            state.prospectAdmissions = Array.isArray(state.prospectAdmissions) ? state.prospectAdmissions : [];
            version = 2;
        } else if (version === 2) {
            state.prospectSecurityEvents = Array.isArray(state.prospectSecurityEvents) ? state.prospectSecurityEvents : [];
            state.operatorTasks = Array.isArray(state.operatorTasks) ? state.operatorTasks : [];
            version = 3;
        } else if (version === 3) {
            state.schedules = Array.isArray(state.schedules) ? state.schedules : [];
            state.controlRuns = Array.isArray(state.controlRuns) ? state.controlRuns : [];
            state.deadLetters = Array.isArray(state.deadLetters) ? state.deadLetters : [];
            state.inboxReceiptsById = state.inboxReceiptsById && typeof state.inboxReceiptsById === 'object'
                ? state.inboxReceiptsById
                : {};
            version = 4;
        }
    }
    state.schemaVersion = LIFECYCLE_SCHEMA_VERSION;
    return state;
}

function normaliseSchedule(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180),
        organisationId: cleanText(source.organisationId, 180),
        jobType: cleanText(source.jobType, 120),
        cadence: cleanText(source.cadence, 80),
        timezone: cleanText(source.timezone || 'Pacific/Auckland', 80),
        nextDueAt: validIsoDate(source.nextDueAt),
        enabled: source.enabled !== false,
        templateVersion: cleanText(source.templateVersion || '1', 80),
        deliveryMode: source.deliveryMode === 'autotask' ? 'autotask' : 'internal',
        requiredSources: cleanStringList(source.requiredSources, 20, 80),
        createdAt: validIsoDate(source.createdAt),
        updatedAt: validIsoDate(source.updatedAt),
        revision: nonNegativeNumber(source.revision)
    };
}

function normaliseControlRun(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180),
        scheduleId: cleanText(source.scheduleId, 180),
        organisationId: cleanText(source.organisationId, 180),
        jobType: cleanText(source.jobType, 120),
        scheduledFor: validIsoDate(source.scheduledFor),
        status: oneOf(source.status, ['generated', 'completed', 'failed', 'dead_letter'], 'generated'),
        taskId: cleanText(source.taskId, 180),
        attemptCount: nonNegativeNumber(source.attemptCount),
        createdAt: validIsoDate(source.createdAt),
        completedAt: validIsoDate(source.completedAt),
        lastError: safeDetails(source.lastError)
    };
}

function normaliseDeadLetter(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(source.id, 180),
        operationId: cleanText(source.operationId, 180),
        organisationId: cleanText(source.organisationId, 180),
        reasonCode: cleanText(source.reasonCode, 120),
        status: oneOf(source.status, ['open', 'resolved', 'cancelled'], 'open'),
        owner: cleanText(source.owner, 180),
        dueAt: validIsoDate(source.dueAt),
        createdAt: validIsoDate(source.createdAt),
        resolvedAt: validIsoDate(source.resolvedAt),
        evidence: safeDetails(source.evidence)
    };
}

function normaliseObservabilityEvent(value, access, fallbackAt) {
    const event = value && typeof value === 'object' ? value : {};
    return {
        id: createId('observation'),
        at: validIsoDate(event.at) || fallbackAt,
        tenantKey: access.tenant.key,
        organisationId: cleanText(event.organisationId, 180),
        conversationId: cleanText(event.conversationId, 180),
        agent: cleanText(event.agent, 120),
        model: cleanText(event.model, 120),
        providerModel: cleanText(event.providerModel, 120),
        runtime: cleanText(event.runtime, 80),
        reasoningEffort: cleanText(event.reasoningEffort, 40),
        promptVersion: cleanText(event.promptVersion, 120),
        toolSchemaVersion: cleanText(event.toolSchemaVersion, 120),
        outputSchemaVersion: cleanText(event.outputSchemaVersion, 120),
        policyId: cleanText(event.policyId, 120),
        policyVersion: cleanText(event.policyVersion, 120),
        policyEffectiveFrom: cleanText(event.policyEffectiveFrom, 40),
        releaseSha: cleanText(event.releaseSha, 64),
        releaseRunId: cleanText(event.releaseRunId, 80),
        eventType: cleanText(event.eventType || 'agent.run', 120),
        tool: cleanText(event.tool, 120),
        outcome: cleanText(event.outcome, 80),
        latencyMs: nonNegativeNumber(event.latencyMs),
        inputTokens: nonNegativeNumber(event.inputTokens),
        cachedInputTokens: nonNegativeNumber(event.cachedInputTokens),
        cacheWriteTokens: nonNegativeNumber(event.cacheWriteTokens),
        outputTokens: nonNegativeNumber(event.outputTokens),
        reasoningTokens: nonNegativeNumber(event.reasoningTokens),
        totalTokens: nonNegativeNumber(event.totalTokens),
        toolFailures: nonNegativeNumber(event.toolFailures),
        approximateCostUsd: nonNegativeNumber(event.approximateCostUsd, 6),
        handoff: cleanText(event.handoff, 120),
        errorCode: cleanText(event.errorCode, 120),
        escalation: Boolean(event.escalation),
        traceId: cleanText(event.traceId, 180),
        details: safeDetails(event.details)
    };
}

function upsertUser(state, access, at = new Date().toISOString()) {
    const email = cleanText(access.user && access.user.email, 180).toLowerCase();
    if (!email) return;
    const principalId = cleanText(access.user && access.user.principalId, 180).toLowerCase();
    const subjectKey = immutableSubjectKey(access);
    const users = state.users && typeof state.users === 'object' ? state.users : {};
    const emailUser = users[email];
    const emailSubjectKey = storedSubjectKey(emailUser);
    if (subjectKey && emailSubjectKey && subjectKey !== emailSubjectKey) {
        throw new LifecycleRepositoryError(409, 'This email is already bound to another immutable identity', {
            code: 'lifecycle_user_identity_conflict'
        });
    }
    if (subjectKey && principalId) {
        const ambiguousLegacyUser = Object.values(users).find((candidate) => (
            cleanText(candidate && candidate.principalId, 180).toLowerCase() === principalId &&
            storedSubjectKey(candidate) === `principal:${principalId}`
        ));
        if (ambiguousLegacyUser && subjectKey !== `principal:${principalId}`) {
            throw new LifecycleRepositoryError(409, 'This principal requires an explicit immutable-identity migration', {
                code: 'lifecycle_user_identity_conflict'
            });
        }
    }
    let existingKey = email;
    if (subjectKey || principalId) {
        const matched = Object.entries(users).find(([, candidate]) => {
            if (!candidate) return false;
            if (subjectKey) {
                return storedSubjectKey(candidate) === subjectKey;
            }
            return cleanText(candidate.principalId, 180).toLowerCase() === principalId;
        });
        if (matched) existingKey = matched[0];
    }
    const existing = users[existingKey] || users[email] || { email, createdAt: at };
    existing.email = email;
    existing.name = access.user.name || existing.name || '';
    existing.role = access.user.role || existing.role || '';
    existing.principalId = principalId || existing.principalId || '';
    existing.identityTenantId = cleanText(access.user.identityTenantId, 180).toLowerCase() || existing.identityTenantId || '';
    existing.subjectKey = subjectKey || existing.subjectKey || '';
    existing.actorId = subjectKey || principalId || existing.actorId || email;
    existing.lastSeenAt = at;
    if (existingKey !== email) delete users[existingKey];
    users[email] = existing;
    state.users = users;
}

function immutableSubjectKey(access) {
    const user = access && access.user || {};
    const subjectKey = cleanText(user.subjectKey, 380).toLowerCase();
    if (subjectKey) return subjectKey;
    const tenantId = cleanText(user.identityTenantId, 180).toLowerCase();
    const principalId = cleanText(user.principalId, 180).toLowerCase();
    if (tenantId && principalId) return `${tenantId}:${principalId}`;
    return principalId ? `principal:${principalId}` : '';
}

function storedSubjectKey(value) {
    const user = value && typeof value === 'object' ? value : {};
    const subjectKey = cleanText(user.subjectKey, 380).toLowerCase();
    if (subjectKey) return subjectKey;
    const tenantId = cleanText(user.identityTenantId, 180).toLowerCase();
    const principalId = cleanText(user.principalId, 180).toLowerCase();
    if (tenantId && principalId) return `${tenantId}:${principalId}`;
    return principalId ? `principal:${principalId}` : '';
}

function assertRevision(state, expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') return;
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) {
        throw new LifecycleRepositoryError(400, 'A valid lifecycle revision is required', { code: 'invalid_revision' });
    }
    if (Number(state.revision || 0) !== expected) {
        throw new LifecycleRepositoryError(
            409,
            'Lifecycle data changed while you were working. Reload and try again.',
            { code: 'revision_conflict', currentRevision: Number(state.revision || 0) }
        );
    }
}

function assertAccess(access) {
    if (!access || !access.allowed || !access.tenant || !access.tenant.key) {
        throw new LifecycleRepositoryError(403, 'Tenant access is required', { code: 'tenant_access_required' });
    }
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

function cleanStringList(value, maxItems, maxLength) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean))).slice(0, maxItems);
}

function safeDetails(value) {
    if (!value || typeof value !== 'object') return {};
    try {
        const parsed = sanitiseDetailValue(value, 0, new WeakSet());
        return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

function sanitiseDetailValue(value, depth, seen) {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') return cleanText(value, 1000);
    if (typeof value !== 'object' || depth >= 5 || seen.has(value)) return '[truncated]';

    seen.add(value);
    if (Array.isArray(value)) {
        const result = value.slice(0, 40).map((item) => sanitiseDetailValue(item, depth + 1, seen));
        seen.delete(value);
        return result;
    }

    const result = {};
    Object.entries(value).slice(0, 40).forEach(([key, item]) => {
        const safeKey = cleanText(key, 120);
        if (!safeKey || ['__proto__', 'prototype', 'constructor'].includes(safeKey)) return;
        result[safeKey] = SENSITIVE_DETAIL_KEY.test(safeKey)
            ? '[redacted]'
            : sanitiseDetailValue(item, depth + 1, seen);
    });
    seen.delete(value);
    return result;
}

function validIsoDate(value) {
    const text = cleanText(value, 40);
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function nonNegativeNumber(value, precision = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    const factor = 10 ** precision;
    return Math.round(number * factor) / factor;
}

module.exports = {
    LIFECYCLE_SCHEMA_VERSION,
    LifecycleRepositoryError,
    assertAccess,
    assertRevision,
    auditHash,
    createEmptyState,
    finishMutation,
    normaliseState
};
