'use strict';

// Shared fixed resource-access evaluator; no policy or live factory is installed here.
const { resolveActiveMembership } = require('./membershipDomain');
const { resolveEntitlements } = require('./entitlementDomain');
const { resolvePortalPermission, ROLE_PERMISSIONS } = require('./portalPermissions');
const { MODULE_ID: NCSC_MODULE, ACCEPTED_PROFILE_REF } = require('../assessmentEngine/ncscAssessmentEvaluator');
const { NcscAssessmentError } = require('../ncscAssessmentService');
const { EvidenceMetadataError } = require('../evidenceMetadataService');
const { dataCodec } = require('./postgresDashboardBootstrap');
const { fail } = dataCodec;

function ncscFail(code = 'ncsc_unavailable', status = 503) { throw new NcscAssessmentError(code, status); }
function resolveNcscAccess(snapshot, context, permission, at) {
    try {
        if (at < context.resolvedAt) ncscFail('ncsc_access_denied', 403);
        const scope = context.scope, subjectKey = context.identity.subjectKey;
        const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...scope, subjectKey }, at);
        const assignment = normalRole(member, permission) ? null : selectAdvisor(snapshot, member, NCSC_MODULE, permission, at);
        const permissionDecision = resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
            { ...scope, subjectKey, permission, module: NCSC_MODULE }, assignment, at);
        const decision = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, scope, at, snapshot.flags);
        if (!decision.product || decision.modules[NCSC_MODULE].eligible !== true ||
            !decision.frameworks.some(row => row.moduleId === NCSC_MODULE && row.profileId === ACCEPTED_PROFILE_REF.profileId &&
                row.version === ACCEPTED_PROFILE_REF.profileVersion) ||
            (permissionDecision.role === 'fractional_advisor' && decision.services.fractional_advisory.enabled !== true)) ncscFail('ncsc_access_denied', 403);
        return decision;
    } catch { ncscFail('ncsc_access_denied', 403); }
}
function selectAdvisor(snapshot, member, moduleId, permission, at) {
    if (!member.roles.includes('fractional_advisor')) return null;
    const candidates = snapshot.advisorAssignments.filter(item => item.subjectKey === member.subjectKey &&
        item.membershipId === member.membershipId && item.status === 'active' && item.updatedAt <= at &&
        item.validFrom <= at && at < item.validUntil && item.validFrom >= member.validFrom && item.validUntil <= member.validUntil &&
        item.modules.includes(moduleId) && item.permissions.includes(permission));
    if (candidates.length > 1) fail('assignment_ambiguous', 403);
    return candidates[0] || null;
}
function normalRole(member, permission) {
    return ['admin', 'editor', 'viewer'].some(role => member.roles.includes(role) && ROLE_PERMISSIONS[role].includes(permission));
}

// Trusted internal policy facts, as for resolveNcscAccess. Public service and
// repository boundaries require the branded context; the request guard rebuilds
// these facts only from its captured identity and locked current authority.
function resolveEvidenceAccess(snapshot, context, at) {
    try {
        if (at < context.resolvedAt) throw new Error();
        const scope = context.scope, subjectKey = context.identity.subjectKey, permission = 'evidence.read';
        const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...scope, subjectKey }, at);
        const assignment = normalRole(member, permission) ? null : selectAdvisor(snapshot, member, 'evidence', permission, at);
        const permissionDecision = resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
            { ...scope, subjectKey, permission, module: 'evidence' }, assignment, at);
        const decision = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, scope, at, snapshot.flags);
        if (!decision.product || decision.modules.evidence.eligible !== true ||
            (permissionDecision.role === 'fractional_advisor' && decision.services.fractional_advisory.enabled !== true)) throw new Error();
        return decision;
    } catch { throw new EvidenceMetadataError('evidence_access_denied', 403); }
}

module.exports = Object.freeze({ resolveNcscAccess, resolveEvidenceAccess, normalRole, selectAdvisor });
