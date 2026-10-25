'use strict';

const { resolveOrganisation } = require('./tenantDomain');

const SCHEMA_VERSION = 1;
const MODULES = Object.freeze(['overview', 'cyber_security', 'ai_governance',
    'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services']);
const ASSESSMENT_MODULES = Object.freeze(['cyber_security', 'ai_governance', 'it_optimisation']);
const TIERS = freeze({
    dashboard_score: ['overview', 'cyber_security', 'improvement_plan', 'evidence', 'board_reports', 'services'],
    dashboard_govern: [...MODULES]
});
// Purchase is not provider readiness, a role assignment or permission to act.
const SERVICES = freeze({
    fractional_advisory: { providerBinding: 'none', assignmentRequired: true },
    tier1_support: { providerBinding: 'route_dependent', assignmentRequired: true },
    managed_endpoint: { providerBinding: 'required', assignmentRequired: true },
    endpoint_security: { providerBinding: 'required', assignmentRequired: true },
    work_file_backup: { providerBinding: 'required', assignmentRequired: true },
    microsoft_365_admin: { providerBinding: 'required', assignmentRequired: true },
    google_workspace_admin: { providerBinding: 'required', assignmentRequired: true },
    supplier_coordination: { providerBinding: 'route_dependent', assignmentRequired: true },
    monthly_proof: { providerBinding: 'per_source', assignmentRequired: true },
    customer_onboarding: { providerBinding: 'route_dependent', assignmentRequired: true },
    ai_service_desk: { providerBinding: 'route_dependent', assignmentRequired: true },
    managed_it_core: { providerBinding: 'non_authorising', assignmentRequired: true }
});
const LIMIT_MODULES = freeze({
    assessment_runs: [...ASSESSMENT_MODULES],
    report_exports: ['board_reports'],
    evidence_bytes: ['evidence'],
    memberships: ['overview'],
    ai_requests: [...ASSESSMENT_MODULES, 'evidence', 'board_reports', 'improvement_plan']
});
const FLAGS = Object.freeze(['dashboard', 'governance_workflow', 'ai_drafting',
    ...MODULES, ...Object.keys(SERVICES).map(code => `service:${code}`)]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

class EntitlementDomainError extends Error {
    constructor(code, statusCode = 400) {
        super(`Entitlement operation refused: ${code}`);
        this.name = 'EntitlementDomainError';
        this.code = `entitlement_${code}`;
        this.statusCode = statusCode;
    }
}
const fail = (code, status = 400) => { throw new EntitlementDomainError(code, status); };

/** Validate a server-owned snapshot. This does not create or activate a grant. */
function normaliseEntitlementState(input, aggregate) {
    const source = data(input, ['schemaVersion', 'tenantId', 'organisationId', 'revision', 'grants']);
    version(source.schemaVersion);
    const scope = selector(source);
    resolveOrganisation(aggregate, scope);
    const grants = array(source.grants).map(normaliseGrant);
    for (const grant of grants) equalScope(grant, scope);
    unique(grants.map(grant => grant.grantId));
    const products = grants.filter(grant => own(TIERS, grant.code) && grant.status === 'active')
        .sort((a, b) => compare(a.validFrom, b.validFrom));
    for (let i = 1; i < products.length; i += 1) {
        if (products[i].validFrom < products[i - 1].validUntil) fail('product_overlap', 409);
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, ...scope,
        revision: integer(source.revision), grants: grants.sort(byId) });
}

function normaliseGrant(input) {
    const source = data(input, ['tenantId', 'organisationId', 'grantId', 'code', 'status', 'validFrom', 'validUntil',
        'agreementRef', 'modules', 'frameworks', 'limits', 'coverage', 'actions']);
    const code = identifier(source.code);
    const isProduct = own(TIERS, code);
    if (!isProduct && !own(SERVICES, code)) fail('code_unknown');
    if (!['active', 'suspended', 'revoked'].includes(source.status)) fail('status_invalid');
    const validFrom = timestamp(source.validFrom), validUntil = timestamp(source.validUntil);
    if (validFrom >= validUntil) fail('window_invalid');
    const modules = strings(source.modules, MODULES);
    const frameworks = array(source.frameworks).map(inputFramework => {
        const f = data(inputFramework, ['moduleId', 'profileId', 'version']);
        if (!ASSESSMENT_MODULES.includes(f.moduleId) || !modules.includes(f.moduleId)) fail('framework_scope_invalid');
        return { moduleId: f.moduleId, profileId: identifier(f.profileId), version: identifier(f.version) };
    }).sort((a, b) => compare(tuple(a), tuple(b)));
    unique(frameworks.map(tuple));
    const coverage = strings(source.coverage), actions = strings(source.actions);
    const limits = numbers(source.limits, true);
    if (isProduct) {
        if (modules.some(moduleId => !TIERS[code].includes(moduleId)) || coverage.length || actions.length) fail('product_scope_invalid');
        if (modules.some(moduleId => ASSESSMENT_MODULES.includes(moduleId) &&
            !frameworks.some(f => f.moduleId === moduleId))) fail('framework_required');
    } else if (frameworks.length) fail('service_framework_invalid');
    if (code === 'managed_it_core' && (modules.length || coverage.length || actions.length || Object.keys(limits).length)) {
        fail('package_parent_not_authorising');
    }
    return { ...selector(source), grantId: identifier(source.grantId), code, status: source.status,
        validFrom, validUntil, agreementRef: identifier(source.agreementRef), modules,
        frameworks, limits, coverage, actions };
}

/**
 * Eligibility only. Caller must independently establish authentication,
 * membership, RBAC and (for services) provider/target/action authority.
 */
function resolveEntitlements(stateInput, aggregate, scopeInput, now, flagsInput) {
    const context = resolveContext(stateInput, aggregate, scopeInput, now, flagsInput);
    const { state, flags, live } = context;
    const product = live.find(grant => own(TIERS, grant.code)) || null;
    const modules = {};
    for (const moduleId of MODULES) {
        const entitled = !!product && product.modules.includes(moduleId);
        const featureEnabled = flags.enabled.dashboard === true && flags.enabled[moduleId] === true;
        const profileAvailable = !ASSESSMENT_MODULES.includes(moduleId) || (!!product &&
            product.frameworks.some(f => f.moduleId === moduleId && flags.frameworks.some(active => tuple(active) === tuple(f))));
        const available = featureEnabled && profileAvailable;
        modules[moduleId] = { entitled, available, eligible: entitled && available,
            reason: !product ? 'product_required' : !entitled ? 'not_ordered' : !featureEnabled ? 'feature_disabled' :
                !profileAvailable ? 'framework_unavailable' : 'entitled' };
    }
    const services = {};
    for (const code of Object.keys(SERVICES)) {
        const entitled = code !== 'managed_it_core' && live.some(grant => grant.code === code);
        services[code] = { entitled, enabled: entitled && flags.enabled[`service:${code}`] === true,
            operational: false, ...SERVICES[code] };
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, tenantId: state.tenantId,
        organisationId: state.organisationId, entitlementRevision: state.revision,
        flagRevision: flags.revision, evaluatedAt: context.now,
        product: product ? { code: product.code, grantId: product.grantId,
            agreementRef: product.agreementRef, validFrom: product.validFrom,
            validUntil: product.validUntil, limits: product.limits } : null,
        modules, frameworks: product ? product.frameworks.filter(f => modules[f.moduleId].eligible &&
            flags.frameworks.some(active => tuple(active) === tuple(f))) : [],
        governanceWorkflowEligible: !!product && product.code === 'dashboard_govern' &&
            modules.improvement_plan.eligible && flags.enabled.governance_workflow === true,
        services, admissionGranted: false, providerAccessGranted: false });
}

/** Prove only a purchased, enabled, exact service scope. No operational grant. */
function assertServiceEntitlement(stateInput, aggregate, requestInput, now, flagsInput) {
    const request = data(requestInput, ['tenantId', 'organisationId', 'code', 'moduleId', 'targetId', 'action']);
    const { state, flags, live } = resolveContext(stateInput, aggregate, selector(request), now, flagsInput);
    const code = identifier(request.code), targetId = identifier(request.targetId), action = identifier(request.action);
    if (!own(SERVICES, code) || code === 'managed_it_core') fail('service_not_entitled', 403);
    if (!MODULES.includes(request.moduleId)) fail('module_unknown');
    if (flags.enabled[`service:${code}`] !== true) fail('feature_disabled', 403);
    const matching = live.filter(grant => grant.code === code && grant.modules.includes(request.moduleId) &&
        grant.coverage.includes(targetId) && grant.actions.includes(action));
    if (matching.length !== 1) fail(matching.length ? 'service_ambiguous' : 'service_not_entitled', 403);
    return freeze({ tenantId: state.tenantId, organisationId: state.organisationId,
        entitlementRevision: state.revision, flagRevision: flags.revision,
        code, grantId: matching[0].grantId, agreementRef: matching[0].agreementRef,
        moduleId: request.moduleId, targetId, action, entitled: true,
        ...SERVICES[code], admissionGranted: false, providerAccessGranted: false });
}

/**
 * Pure server-side counter transition. The repository MUST atomically compare
 * entitlement, flag and usage revisions when persisting the returned snapshot.
 * It is not safe to construct usage from a request or to reset it on retry.
 */
function consumeEntitlementLimit(stateInput, aggregate, usageInput, commandInput, now, flagsInput) {
    const command = data(commandInput, ['tenantId', 'organisationId', 'grantId',
        'expectedEntitlementRevision', 'expectedFlagRevision', 'expectedUsageRevision',
        'moduleId', 'limit', 'amount', 'framework']);
    const scope = selector(command);
    const decision = resolveEntitlements(stateInput, aggregate, scope, now, flagsInput);
    const usage = data(usageInput, ['schemaVersion', 'tenantId', 'organisationId', 'grantId', 'revision', 'counters']);
    version(usage.schemaVersion);
    equalScope(selector(usage), scope);
    const grantId = identifier(command.grantId), revision = integer(usage.revision);
    if (identifier(usage.grantId) !== grantId || !decision.product || decision.product.grantId !== grantId) fail('quota_grant_mismatch', 409);
    if (integer(command.expectedEntitlementRevision) !== decision.entitlementRevision ||
        integer(command.expectedFlagRevision) !== decision.flagRevision ||
        integer(command.expectedUsageRevision) !== revision) fail('revision_conflict', 409);
    if (!own(LIMIT_MODULES, command.limit) || !LIMIT_MODULES[command.limit].includes(command.moduleId)) fail('limit_scope_invalid');
    if (!decision.modules[command.moduleId].eligible) fail('module_not_entitled', 403);
    if (command.limit === 'ai_requests' && flagsInput.enabled.ai_drafting !== true) fail('feature_disabled', 403);
    if (command.limit === 'assessment_runs') {
        const framework = data(command.framework, ['profileId', 'version']);
        const profileId = identifier(framework.profileId), frameworkVersion = identifier(framework.version);
        if (!decision.frameworks.some(f => f.moduleId === command.moduleId &&
            f.profileId === profileId && f.version === frameworkVersion)) fail('framework_not_entitled', 403);
    } else if (command.framework !== null) fail('framework_unexpected');
    const counters = numbers(usage.counters);
    if (!own(decision.product.limits, command.limit) || !own(counters, command.limit)) fail('limit_required', 403);
    const amount = integer(command.amount);
    if (!amount) fail('amount_invalid');
    const next = counters[command.limit] + amount;
    if (!Number.isSafeInteger(next) || decision.product.limits[command.limit] !== null &&
        next > decision.product.limits[command.limit]) fail('limit_exceeded', 403);
    if (!Number.isSafeInteger(revision + 1)) fail('revision_exhausted', 409);
    return freeze({ schemaVersion: SCHEMA_VERSION, ...scope, grantId,
        revision: revision + 1, counters: { ...counters, [command.limit]: next } });
}

function resolveContext(stateInput, aggregate, scopeInput, nowInput, flagsInput) {
    const scope = selector(data(scopeInput, ['tenantId', 'organisationId']));
    const organisation = resolveOrganisation(aggregate, scope);
    const state = normaliseEntitlementState(stateInput, aggregate);
    equalScope(state, scope);
    const now = timestamp(nowInput), flags = normaliseFlags(flagsInput, scope);
    // resolveOrganisation first validates all ownership fields without defaults.
    const ownerActive = aggregate.tenant.recordStatus === 'active' && organisation.recordStatus === 'active';
    const live = ownerActive ? state.grants.filter(grant => grant.status === 'active' &&
        grant.validFrom <= now && now < grant.validUntil) : [];
    return { state, flags, live, now };
}

function normaliseFlags(input, scope) {
    if (input === undefined) return { revision: 0, enabled: {}, frameworks: [] };
    const source = data(input, ['tenantId', 'organisationId', 'revision', 'enabled', 'frameworks']);
    equalScope(selector(source), scope);
    const enabled = data(source.enabled, FLAGS, []);
    for (const key of Object.keys(enabled)) if (typeof enabled[key] !== 'boolean') fail('flag_invalid');
    const frameworks = array(source.frameworks).map(inputFramework => {
        const f = data(inputFramework, ['moduleId', 'profileId', 'version']);
        if (!ASSESSMENT_MODULES.includes(f.moduleId)) fail('framework_scope_invalid');
        return { moduleId: f.moduleId, profileId: identifier(f.profileId), version: identifier(f.version) };
    });
    unique(frameworks.map(tuple));
    return { revision: integer(source.revision), enabled, frameworks };
}

function selector(source) {
    return { tenantId: identifier(source.tenantId), organisationId: identifier(source.organisationId) };
}
function equalScope(a, b) {
    if (a.tenantId !== b.tenantId || a.organisationId !== b.organisationId) fail('not_found', 404);
}
function version(value) { if (value !== SCHEMA_VERSION) fail('schema_unsupported'); }
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 180 ||
        /[\u0000-\u001f\u007f*]/.test(value)) fail('identifier_invalid');
    return value;
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('integer_invalid');
    return value;
}
function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('timestamp_invalid');
    return value;
}
function data(value, allowed, required = allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape_invalid');
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !own(descriptors[key], 'value')) ||
        required.some(key => !own(descriptors, key))) fail('shape_invalid');
    const result = Object.create(null);
    for (const key of keys) result[key] = descriptors[key].value;
    return result;
}
function array(value) {
    if (!Array.isArray(value)) fail('array_invalid');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) fail('array_invalid');
    const result = [];
    for (let i = 0; i < value.length; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !own(d, 'value')) fail('array_invalid');
        result.push(d.value);
    }
    return result;
}
function strings(value, allowed) {
    const result = array(value).map(identifier);
    if (allowed && result.some(item => !allowed.includes(item))) fail('scope_invalid');
    unique(result);
    return result.sort();
}
function numbers(value, limits = false) {
    const source = data(value, Object.keys(LIMIT_MODULES), []), result = {};
    // null removes only the commercial assessment ceiling. Usage is always an
    // integer, and seats, provider spend, upload bytes and exports stay finite.
    for (const key of Object.keys(source).sort()) result[key] = limits && key === 'assessment_runs' && source[key] === null ? null : integer(source[key]);
    return result;
}
function unique(values) { if (new Set(values).size !== values.length) fail('duplicate'); }
function tuple(f) { return JSON.stringify([f.moduleId, f.profileId, f.version]); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function byId(a, b) { return compare(a.grantId, b.grantId); }
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

module.exports = { SCHEMA_VERSION, MODULES, TIERS, SERVICES, EntitlementDomainError,
    normaliseEntitlementState, resolveEntitlements, assertServiceEntitlement, consumeEntitlementLimit };
