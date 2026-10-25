'use strict';

const { resolvePortalPermission } = require('./portalPermissions');
const { assertServiceEntitlement, resolveEntitlements } = require('./entitlementDomain');

const POLICY_VERSION = 1;
const ROUTES = freeze({
    'autotask/tickets': { system: 'autotask', recordTypes: ['account'], code: 'tier1_support' },
    'datto_rmm/devices': { system: 'datto_rmm', recordTypes: ['site'], code: 'managed_endpoint' },
    'kaseya_mdr/alerts': { system: 'kaseya_mdr', recordTypes: ['tenant', 'organisation'], code: 'endpoint_security' }
});
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class ProviderRouteGateError extends Error {
    constructor() {
        super('provider_route_access_denied');
        this.name = 'ProviderRouteGateError';
        this.statusCode = 403;
        this.code = 'provider_route_access_denied';
        this.details = Object.freeze({ code: this.code });
    }
}
function deny() { throw new ProviderRouteGateError(); }

/** Strict current query projection, not a binding creation/activation API.
 * The repository must return the unique current binding for this exact target.
 * Old lifecycle externalReferences are not accepted by implicit normalisation.
 */
function normaliseProviderBinding(input) {
    const value = record(input, ['schemaVersion', 'bindingId', 'tenantId', 'organisationId',
        'targetId', 'system', 'recordType', 'providerScopeId', 'externalId', 'status',
        'verifiedAt', 'validUntil', 'verificationEvidenceId', 'revision', 'updatedAt']);
    if (value.schemaVersion !== POLICY_VERSION || !['verified', 'suspended', 'revoked'].includes(value.status) ||
        !Object.values(ROUTES).some(route => route.system === value.system && route.recordTypes.includes(value.recordType))) deny();
    const verifiedAt = instant(value.verifiedAt), validUntil = instant(value.validUntil), updatedAt = instant(value.updatedAt);
    if (verifiedAt >= validUntil || verifiedAt > updatedAt) deny();
    return freeze({ schemaVersion: POLICY_VERSION, bindingId: identifier(value.bindingId),
        tenantId: identifier(value.tenantId), organisationId: identifier(value.organisationId),
        targetId: identifier(value.targetId), system: value.system, recordType: value.recordType,
        providerScopeId: identifier(value.providerScopeId), externalId: identifier(value.externalId),
        status: value.status, verifiedAt, validUntil, verificationEvidenceId: identifier(value.verificationEvidenceId),
        revision: integer(value.revision), updatedAt });
}

/** Uninstalled trusted-server precondition for fixed provider read routes.
 * It performs no provider call and grants no reusable executor authority.
 * Existing provider record visibility, target/licence/adapter readiness and
 * operation fences must still pass at use. Never expose its result to a browser.
 */
function createProviderRouteGuard(adapters) {
    const dependencies = record(adapters, ['authenticate', 'resolveTarget', 'loadSnapshot', 'clock', 'auditDenial']);
    if (Object.values(dependencies).some(value => typeof value !== 'function')) deny();

    return async function requireProviderRoute(request, routeKey) {
        let stage = 'request_invalid', evaluatedAt = null, knownRoute = null;
        let actorSubjectKey = null, selectedTarget = null, scopeAuthorised = false;
        try {
            if (typeof routeKey !== 'string' || !own(ROUTES, routeKey)) deny();
            knownRoute = routeKey;
            if (request?.method !== 'GET') deny();
            const route = ROUTES[routeKey];
            stage = 'identity_denied';
            const principal = record(await dependencies.authenticate(request), ['authenticated', 'subjectKey']);
            if (principal.authenticated !== true || typeof principal.subjectKey !== 'string' || !SUBJECT.test(principal.subjectKey)) deny();
            const identity = freeze({ authenticated: true, subjectKey: principal.subjectKey });
            actorSubjectKey = identity.subjectKey;
            stage = 'selection_denied';
            const selected = record(await dependencies.resolveTarget(request, identity, routeKey), ['tenantId', 'organisationId', 'targetId']);
            const target = freeze({ tenantId: identifier(selected.tenantId),
                organisationId: identifier(selected.organisationId), targetId: identifier(selected.targetId) });
            selectedTarget = target;
            const scope = { tenantId: target.tenantId, organisationId: target.organisationId };
            stage = 'snapshot_unavailable';
            const snapshot = copyData(record(await dependencies.loadSnapshot(target, identity, routeKey), [
                'tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignment', 'providerPolicy', 'binding'
            ]));
            // Evaluate after every asynchronous policy load; no cached decisions.
            evaluatedAt = instant(dependencies.clock());
            stage = 'permission_denied';
            const permission = resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
                { ...scope, subjectKey: identity.subjectKey, permission: 'services.read', module: 'services' },
                snapshot.advisorAssignment, evaluatedAt);
            scopeAuthorised = true;
            stage = 'entitlement_denied';
            // A scoped advisor assignment does not supply its service purchase.
            // Normal roles retain their independently resolved permission.
            if (permission.role === 'fractional_advisor' &&
                resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate,
                    scope, evaluatedAt, snapshot.flags).services.fractional_advisory.enabled !== true) deny();
            const entitlement = assertServiceEntitlement(snapshot.entitlementState, snapshot.tenantAggregate,
                { ...target, code: route.code, moduleId: 'services', action: 'view' }, evaluatedAt, snapshot.flags);
            stage = 'binding_denied';
            const policy = record(snapshot.providerPolicy, ['system', 'providerScopeId', 'revision', 'maxBindingAgeMs', 'updatedAt']);
            if (policy.system !== route.system || !integer(policy.maxBindingAgeMs) || instant(policy.updatedAt) > evaluatedAt) deny();
            const providerScopeId = identifier(policy.providerScopeId), policyRevision = integer(policy.revision);
            const binding = normaliseProviderBinding(snapshot.binding);
            const age = Date.parse(evaluatedAt) - Date.parse(binding.verifiedAt);
            if (binding.tenantId !== scope.tenantId || binding.organisationId !== scope.organisationId ||
                binding.targetId !== target.targetId || binding.system !== route.system ||
                !route.recordTypes.includes(binding.recordType) || binding.providerScopeId !== providerScopeId ||
                binding.status !== 'verified' || binding.updatedAt > evaluatedAt ||
                age < 0 || age >= policy.maxBindingAgeMs || evaluatedAt >= binding.validUntil) deny();
            // A server-only diagnostic handoff. It cannot be used as a token or
            // authorise an external call after current-state checks have changed.
            return freeze({ policyVersion: POLICY_VERSION, routeKey, ...target,
                subjectKey: identity.subjectKey, evaluatedAt,
                membershipRevision: permission.membershipRevision,
                assignmentRevision: permission.assignmentRevision,
                entitlementRevision: entitlement.entitlementRevision, flagRevision: entitlement.flagRevision,
                providerPolicyRevision: policyRevision, bindingRevision: binding.revision,
                serviceCode: route.code, moduleId: 'services', action: 'view',
                binding: { bindingId: binding.bindingId, system: binding.system,
                    recordType: binding.recordType, providerScopeId, externalId: binding.externalId },
                preconditionsSatisfied: true, providerAccessGranted: false });
        } catch (error) {
            // Closed categories and trusted internal identity/scope only: never
            // forward request data, external provider identifiers, secrets,
            // exception messages or provider responses to customer or audit output.
            const event = freeze({ schemaVersion: 1, eventType: 'provider_route.denied',
                policyVersion: POLICY_VERSION, routeKey: knownRoute, reason: stage, evaluatedAt,
                actorSubjectKey, selectedTarget, scopeAuthorised });
            try { await dependencies.auditDenial(event); } catch (auditError) { /* Failure remains closed. */ }
            deny();
        }
    };
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
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) deny();
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) deny();
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
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

module.exports = { POLICY_VERSION, ROUTES, ProviderRouteGateError, normaliseProviderBinding, createProviderRouteGuard };
