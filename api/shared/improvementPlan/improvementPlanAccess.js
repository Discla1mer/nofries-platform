'use strict';

const { resolveActiveMembership } = require('../appLifecycle/membershipDomain');
const { resolvePortalPermission } = require('../appLifecycle/portalPermissions');
const { resolveEntitlements } = require('../appLifecycle/entitlementDomain');
const { normalRole, selectAdvisor } = require('../appLifecycle/dashboardResourceAuthority');
const { ImprovementPlanServiceError, requireImprovementContext } = require('./improvementPlanService');
function deny() { throw new ImprovementPlanServiceError('improvement_access_denied', 403); }

// Evaluate only locked current server records; never persist a permission result.
function resolveImprovementAccess(snapshot, contextInput, permission, at) {
    try {
        const context = requireImprovementContext(contextInput);
        if (!['improvement.read', 'improvement.write'].includes(permission) || at < context.resolvedAt) deny();
        const scope = context.scope, subjectKey = context.identity.subjectKey;
        const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...scope, subjectKey }, at);
        const assignment = normalRole(member, permission) ? null : selectAdvisor(snapshot, member, 'improvement_plan', permission, at);
        const access = resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
            { ...scope, subjectKey, permission, module: 'improvement_plan' }, assignment, at);
        const decision = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, scope, at, snapshot.flags);
        if (!decision.product || !decision.modules.improvement_plan.eligible ||
            (access.role === 'fractional_advisor' && !decision.services.fractional_advisory.enabled)) deny();
        return decision;
    } catch { deny(); }
}
function resolveEligibleOwner(snapshot, contextInput, subjectKey, at) {
    try {
        const context = requireImprovementContext(contextInput);
        if (at < context.resolvedAt) deny();
        resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...context.scope, subjectKey }, at);
        // Assignment records responsibility; it does not grant portal permission.
        return subjectKey;
    } catch { throw new ImprovementPlanServiceError('improvement_owner_ineligible', 409); }
}
module.exports = Object.freeze({ resolveImprovementAccess, resolveEligibleOwner });
