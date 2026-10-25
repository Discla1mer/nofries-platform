'use strict';

const { resolveActiveMembership, normaliseMembershipState, MembershipDomainError } = require('./appLifecycle/membershipDomain');
const { resolveEntitlements } = require('./appLifecycle/entitlementDomain');
const { resolvePortalPermission, normaliseAdvisorAssignment, ROLE_PERMISSIONS, PortalPermissionError } = require('./appLifecycle/portalPermissions');
const { resolveOrganisation } = require('./appLifecycle/tenantDomain');
const { projectDashboard } = require('./appLifecycle/dashboardProjection');
const registry = require('./protectedAssets/dashboardRegistry');

const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class DashboardAdmissionError extends Error {
    constructor() {
        super('dashboard_access_denied');
        this.name = 'DashboardAdmissionError';
        this.statusCode = 403;
        this.code = 'dashboard_access_denied';
        this.details = Object.freeze({ code: this.code });
    }
}
function deny() { throw new DashboardAdmissionError(); }

class DashboardAdmissionUnavailableError extends Error {
    constructor() {
        super('dashboard_unavailable');
        this.name = 'DashboardAdmissionUnavailableError';
        this.statusCode = 503;
        this.code = 'dashboard_unavailable';
        this.details = Object.freeze({ code: this.code });
    }
}
function unavailable() { throw new DashboardAdmissionUnavailableError(); }

/** Uninstalled trusted-server composition, not a request-body policy evaluator.
 * Each invocation authenticates and loads one coherent authoritative snapshot.
 * Both wrappers use the same policy/projection path; only the typed boundary
 * preflights retained state and distinguishes proved refusal from failure.
 */
function createDashboardAdmission(adapters) {
    const dependencies = dependenciesOf(adapters);
    return async function admitDashboard(request, moduleKey = null) {
        try {
            const projection = await evaluateAdmission(dependencies, request, moduleKey, false);
            if (projection === null) deny();
            return projection;
        } catch (error) {
            // Preserve the legacy generic refusal, including its omission behavior.
            deny();
        }
    };
}

function createDashboardAdmissionDecision(adapters) {
    let dependencies;
    try { dependencies = dependenciesOf(adapters); } catch (error) { unavailable(); }
    return async function decideDashboardAdmission(request, moduleKey = null) {
        try {
            const projection = await evaluateAdmission(dependencies, request, moduleKey, true);
            return Object.freeze({ outcome: projection === null ? 'denied' : 'succeeded', projection });
        } catch (error) {
            // Adapter/domain errors, including denial-shaped errors, are never
            // evidence of a policy decision and never disclose their original cause.
            unavailable();
        }
    };
}

function dependenciesOf(adapters) {
    const dependencies = record(adapters, ['authenticate', 'resolveScope', 'loadSnapshot', 'clock']);
    if (Object.values(dependencies).some(value => typeof value !== 'function')) deny();
    return dependencies;
}

async function evaluateAdmission(dependencies, request, moduleKey, typed) {
    const resource = moduleKey === null ? null : registry.modules.find(item => item.key === moduleKey);
    if (moduleKey !== null && !resource) deny();
    const principal = record(await dependencies.authenticate(request), ['authenticated', 'subjectKey']);
    if (principal.authenticated !== true || typeof principal.subjectKey !== 'string' || !SUBJECT.test(principal.subjectKey)) deny();
    const identity = Object.freeze({ authenticated: true, subjectKey: principal.subjectKey });
    const selected = record(await dependencies.resolveScope(request, identity), ['tenantId', 'organisationId']);
    const scope = Object.freeze({ tenantId: identifier(selected.tenantId), organisationId: identifier(selected.organisationId) });
    // Detach before another async turn can alter loader-owned state. This rejects
    // getters, sparse arrays and non-data objects without executing their values.
    const loaded = await dependencies.loadSnapshot(scope, identity);
    const snapshot = copyData(record(loaded, [
        'tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments', 'summary',
        ...(loaded && own(loaded, 'currentUserProfile') ? ['currentUserProfile'] : [])
    ]));
    const { tenantAggregate, membershipState, entitlementState, flags } = snapshot;
    record(snapshot.advisorAssignments, Object.keys(snapshot.advisorAssignments));
    if (Object.keys(snapshot.advisorAssignments).some(key => !registry.modules.some(item => item.key === key))) deny();
    // Sampling after I/O prevents a slow load from using an earlier admission time.
    const now = dependencies.clock();
    const facts = typed ? preflight(snapshot, scope, identity.subjectKey, now) : null;
    let member;
    try {
        member = resolveActiveMembership(membershipState, tenantAggregate, { ...scope, subjectKey: identity.subjectKey }, now);
    } catch (error) {
        if (typed && !facts.activeMember && error instanceof MembershipDomainError &&
            error.code === (facts.ownerActive ? 'membership_not_found' : 'membership_organisation_inactive')) return null;
        throw error;
    }
    const entitlement = typed ? facts.entitlement
        : resolveEntitlements(entitlementState, tenantAggregate, scope, now, flags);
    if (!entitlement.product || flags.enabled.dashboard !== true) return null;
    const mayRead = item => {
        if (entitlement.modules[item.key].eligible !== true) return false;
        try {
            const permission = resolvePortalPermission(membershipState, tenantAggregate, { ...scope,
                subjectKey: identity.subjectKey, permission: item.permission, module: item.key },
            snapshot.advisorAssignments[item.key] ?? null, now);
            if (permission.role === 'fractional_advisor' &&
                entitlement.services.fractional_advisory.enabled !== true) return false;
            return true;
        } catch (error) {
            if (!typed || (error instanceof PortalPermissionError &&
                permissionRefused(member, facts.advisors[item.key] ?? null, item, scope, identity.subjectKey, now))) return false;
            throw error;
        }
    };
    if (resource ? !mayRead(resource) : !registry.modules.some(mayRead)) return null;
    return projectDashboard({ ...snapshot, scope, subjectKey: identity.subjectKey, now });
}

function preflight(snapshot, scope, actor, now) {
    canonicalInstant(now);
    // resolveOrganisation requires the entire canonical retained aggregate. A
    // creation constructor would silently supply missing fields and is unsuitable.
    const organisation = resolveOrganisation(snapshot.tenantAggregate, scope);
    const state = normaliseMembershipState(snapshot.membershipState);
    if (state.tenantId !== scope.tenantId || state.organisationId !== scope.organisationId || now < state.updatedAt) unavailable();
    // This resolver validates the complete grant set and explicit flags even when
    // membership or a product is absent. Every thrown error is operational here.
    const entitlement = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, scope, now, snapshot.flags);
    const advisors = {};
    for (const [key, value] of Object.entries(snapshot.advisorAssignments)) {
        if (value === null) { advisors[key] = null; continue; }
        const assignment = normaliseAdvisorAssignment(value);
        if (assignment.tenantId !== scope.tenantId || assignment.organisationId !== scope.organisationId) unavailable();
        advisors[key] = assignment;
    }
    // Validate neighboring and disabled-module assignments as well: the genuine
    // projector consults all entitled modules and otherwise hides malformed rows.
    const ownerActive = snapshot.tenantAggregate.tenant.recordStatus === 'active' && organisation.recordStatus === 'active';
    const activeMember = ownerActive && state.memberships.some(row => row.subjectKey === actor && row.status === 'active' && row.validFrom <= now && now < row.validUntil);
    return { ownerActive, activeMember, entitlement, advisors };
}

// This is a refusal witness over validated inputs, not a permission grant. A
// success still comes only from the real resolver above. Its catch-all error class
// alone cannot distinguish ordinary refusal from an unexpected implementation fault.
function permissionRefused(member, assignment, item, scope, actor, now) {
    if (['admin', 'editor', 'viewer'].some(role => member.roles.includes(role) && ROLE_PERMISSIONS[role].includes(item.permission))) return false;
    if (!member.roles.includes('fractional_advisor') || assignment === null) return true;
    return !(assignment.tenantId === scope.tenantId && assignment.organisationId === scope.organisationId &&
        assignment.subjectKey === actor && assignment.membershipId === member.membershipId &&
        assignment.status === 'active' && assignment.updatedAt <= now && assignment.validFrom <= now && now < assignment.validUntil &&
        assignment.validFrom >= member.validFrom && assignment.validUntil <= member.validUntil &&
        assignment.modules.includes(item.key) && assignment.permissions.includes(item.permission));
}

function canonicalInstant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) unavailable();
}

function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !own(descriptors, key) || !own(descriptors[key], 'value'))) deny();
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 180 ||
        /[\u0000-\u001f\u007f*]/.test(value)) deny();
    return value;
}
function copyData(value, ancestors = new Set()) {
    if (value === null || ['string', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) deny();
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) deny();
        result = Array.from({ length: value.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !own(descriptor, 'value')) deny();
            return copyData(descriptor.value, ancestors);
        });
    } else {
        const source = record(value, Object.keys(value));
        result = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, copyData(item, ancestors)]));
    }
    ancestors.delete(value);
    return Object.freeze(result);
}

module.exports = { DashboardAdmissionError, createDashboardAdmission,
    DashboardAdmissionUnavailableError, createDashboardAdmissionDecision };
