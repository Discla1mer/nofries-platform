'use strict';

const { resolveActiveMembership } = require('./membershipDomain');

// Organisation dashboard roles are not operator/provider roles from tenantAccess.
const POLICY_VERSION = 1;
const MODULES = Object.freeze(['overview', 'cyber_security', 'ai_governance',
    'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services']);
const ASSESSMENT_MODULES = ['cyber_security', 'ai_governance', 'it_optimisation'];
const PERMISSIONS = freeze({
    'overview.read': ['overview'],
    'assessment.read': ASSESSMENT_MODULES,
    'assessment.write': ASSESSMENT_MODULES,
    'improvement.read': ['improvement_plan'],
    'improvement.write': ['improvement_plan'],
    'decision.read': ['improvement_plan'],
    'decision.write': ['improvement_plan'],
    'decision.approve': ['improvement_plan'],
    'evidence.read': ['evidence'],
    'evidence.link': ['evidence'],
    'evidence.review': ['evidence'],
    'report.read_issued': ['board_reports'],
    'report.read_draft': ['board_reports'],
    'report.draft': ['board_reports'],
    'report.approve': ['board_reports'],
    'services.read': ['services'],
    'membership.manage': ['overview'],
    'advisor.manage': ['overview']
});
const VIEWER = ['overview.read', 'services.read', 'report.read_issued'];
const EDITOR = [...VIEWER, 'assessment.read', 'assessment.write', 'improvement.read',
    'improvement.write', 'decision.read', 'decision.write', 'evidence.read',
    'evidence.link', 'report.read_draft', 'report.draft'];
const ROLE_PERMISSIONS = freeze({ admin: Object.keys(PERMISSIONS), editor: EDITOR,
    viewer: VIEWER, fractional_advisor: [] });
const ADVISOR_PERMISSIONS = Object.freeze([...EDITOR, 'evidence.review']);
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class PortalPermissionError extends Error {
    constructor() {
        super('portal_permission_denied');
        this.name = 'PortalPermissionError';
        this.statusCode = 403;
        this.code = 'portal_permission_denied';
        this.details = Object.freeze({ code: this.code });
    }
}
function deny() { throw new PortalPermissionError(); }

// Complete, server-owned projection only. No implicit active status or grants.
function normaliseAdvisorAssignment(input) {
    const value = record(input, ['schemaVersion', 'assignmentId', 'tenantId',
        'organisationId', 'membershipId', 'subjectKey', 'status', 'validFrom',
        'validUntil', 'modules', 'permissions', 'grantEvidenceId', 'revision', 'updatedAt']);
    if (value.schemaVersion !== POLICY_VERSION || !['active', 'revoked'].includes(value.status)) deny();
    const modules = uniqueList(value.modules, MODULES), permissions = uniqueList(value.permissions, ADVISOR_PERMISSIONS);
    // Each listed permission must address at least one module in this same grant.
    if (permissions.some(permission => !PERMISSIONS[permission].some(module => modules.includes(module)))) deny();
    const validFrom = instant(value.validFrom), validUntil = instant(value.validUntil);
    const updatedAt = instant(value.updatedAt);
    if (validUntil <= validFrom || !Number.isSafeInteger(value.revision) || value.revision < 0) deny();
    return freeze({ schemaVersion: POLICY_VERSION, assignmentId: identifier(value.assignmentId),
        tenantId: identifier(value.tenantId), organisationId: identifier(value.organisationId),
        membershipId: identifier(value.membershipId), subjectKey: subject(value.subjectKey),
        status: value.status, validFrom, validUntil, modules, permissions,
        grantEvidenceId: identifier(value.grantEvidenceId), revision: value.revision, updatedAt });
}

// Snapshot policy. The caller must authenticate and obtain current trusted state.
// A returned decision is diagnostic evidence, not a bearer authorisation token.
function resolvePortalPermission(membershipState, tenantAggregate, selector, advisorAssignment, nowInput) {
    try {
        const query = record(selector, ['tenantId', 'organisationId', 'subjectKey', 'permission', 'module']);
        const scope = scopeOf(query), actor = subject(query.subjectKey), now = instant(nowInput);
        const action = normaliseAction({ permission: query.permission, module: query.module });
        const member = resolveActiveMembership(membershipState, tenantAggregate,
            { ...scope, subjectKey: actor }, now);
        const decision = (role, assignment = null) => freeze({ policyVersion: POLICY_VERSION,
            ...scope, subjectKey: actor, membershipId: member.membershipId,
            membershipRevision: membershipState.revision, permission: action.permission,
            module: action.module, role, assignmentId: assignment?.assignmentId ?? null,
            assignmentRevision: assignment?.revision ?? null, evaluatedAt: now });
        // Independently granted normal roles retain their own authority. An advisor
        // grant never extends a viewer/editor role or restricts an independent admin.
        for (const role of ['admin', 'editor', 'viewer']) {
            if (member.roles.includes(role) && ROLE_PERMISSIONS[role].includes(action.permission)) {
                return decision(role);
            }
        }
        if (!member.roles.includes('fractional_advisor')) deny();
        // Query one current relevant grant, never enumerate an organisation's
        // retained assignment history or impose a customer-size ceiling.
        const assignment = normaliseAdvisorAssignment(advisorAssignment);
        const matches = assignment.tenantId === scope.tenantId &&
            assignment.organisationId === scope.organisationId && assignment.updatedAt <= now &&
            assignment.status === 'active' &&
            assignment.subjectKey === actor && assignment.membershipId === member.membershipId &&
            assignment.validFrom >= member.validFrom && assignment.validUntil <= member.validUntil &&
            assignment.validFrom <= now && now < assignment.validUntil &&
            assignment.modules.includes(action.module) && assignment.permissions.includes(action.permission);
        if (!matches) deny();
        return decision('fractional_advisor', assignment);
    } catch (error) {
        // Never disclose whether another tenant, subject or membership exists.
        if (error instanceof PortalPermissionError) throw error;
        deny();
    }
}

// Not installed on production routes. These adapters belong to trusted server
// composition, never request JSON. No permission result is cached between calls.
function createPortalPermissionGuard(adapters) {
    const dependencies = record(adapters, ['authenticate', 'resolveScope',
        'loadTenantAggregate', 'loadMembershipState', 'loadAdvisorAssignment', 'clock']);
    if (Object.values(dependencies).some(value => typeof value !== 'function')) deny();
    return async function requirePermission(request, actionInput) {
        try {
            const action = normaliseAction(actionInput);
            const principal = record(await dependencies.authenticate(request), ['authenticated', 'subjectKey']);
            if (principal.authenticated !== true) deny();
            const identity = Object.freeze({ authenticated: true, subjectKey: subject(principal.subjectKey) });
            const scope = Object.freeze(scopeOf(record(await dependencies.resolveScope(request, identity),
                ['tenantId', 'organisationId'])));
            // Adapters must return a coherent authoritative snapshot. For mutations,
            // additionally bind the operation to these revisions transactionally.
            const tenantAggregate = await dependencies.loadTenantAggregate(scope);
            const membershipState = await dependencies.loadMembershipState(scope);
            // I/O may cross an expiry boundary; evaluate with time sampled afterwards.
            const now = instant(dependencies.clock());
            const selector = { ...scope, subjectKey: identity.subjectKey, ...action };
            const member = resolveActiveMembership(membershipState, tenantAggregate,
                { ...scope, subjectKey: identity.subjectKey }, now);
            if (['admin', 'editor', 'viewer'].some(role => member.roles.includes(role) &&
                ROLE_PERMISSIONS[role].includes(action.permission))) {
                return resolvePortalPermission(membershipState, tenantAggregate, selector, null, now);
            }
            if (!member.roles.includes('fractional_advisor')) deny();
            // Adapter selects from CURRENT authoritative assignments, not historic
            // active revisions. Return one matching candidate or null; never truncate
            // a whole-organisation array and silently reinterpret it as complete.
            const assignment = await dependencies.loadAdvisorAssignment(Object.freeze({ ...selector,
                membershipId: member.membershipId, at: now }));
            return resolvePortalPermission(membershipState, tenantAggregate,
                selector, assignment, dependencies.clock());
        } catch (error) {
            if (error instanceof PortalPermissionError) throw error;
            deny();
        }
    };
}

function normaliseAction(input) {
    const action = record(input, ['permission', 'module']);
    if (typeof action.permission !== 'string' || typeof action.module !== 'string' ||
        !Object.prototype.hasOwnProperty.call(PERMISSIONS, action.permission) ||
        !PERMISSIONS[action.permission].includes(action.module)) deny();
    return action;
}
function scopeOf(input) { return { tenantId: identifier(input.tenantId), organisationId: identifier(input.organisationId) }; }
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key) ||
            !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) deny();
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function array(value, maximum) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) deny();
    return Array.from({ length: value.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) deny();
        return descriptor.value;
    });
}
function uniqueList(input, allowed) {
    const values = array(input, allowed.length);
    if (!values.length || values.some(value => !allowed.includes(value)) || new Set(values).size !== values.length) deny();
    return values.slice().sort();
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 180 || value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)) deny();
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || !SUBJECT.test(value)) deny();
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) deny();
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

module.exports = { POLICY_VERSION, MODULES, PERMISSIONS, ROLE_PERMISSIONS, ADVISOR_PERMISSIONS,
    PortalPermissionError, normaliseAdvisorAssignment, resolvePortalPermission, createPortalPermissionGuard };
