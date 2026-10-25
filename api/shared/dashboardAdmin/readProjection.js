'use strict';

const { copy, fields, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { resolveOrganisation } = require('../appLifecycle/tenantDomain');
const { normaliseMembershipState } = require('../appLifecycle/membershipDomain');
const { normaliseEntitlementState, resolveEntitlements } = require('../appLifecycle/entitlementDomain');

// This is a projection of an exact scope, never an identity directory. In
// particular neither membership nor entitlement state proves signup success.
function projectAuthorityRead(input, selector) {
    const value = fields(copy(input), ['snapshot', 'revisions', 'evaluatedAt']);
    const at = dataCodec.instant(value.evaluatedAt);
    const snapshot = fields(value.snapshot, ['tenantAggregate', 'membershipState', 'entitlementState',
        'flags', 'advisorAssignments', 'usage']);
    const aggregate = snapshot.tenantAggregate;
    const scope = { tenantId: selector.tenantId, organisationId: selector.organisationId };
    const organisation = resolveOrganisation(aggregate, scope);
    if (aggregate.organisations.length !== 1 || aggregate.tenant.tenantId !== selector.tenantId) throw new Error('scope');
    const membership = normaliseMembershipState(snapshot.membershipState, aggregate);
    const entitlement = normaliseEntitlementState(snapshot.entitlementState, aggregate);
    for (const row of [membership, entitlement, snapshot.flags]) dataCodec.equalScope(row, selector);
    resolveEntitlements(entitlement, aggregate, scope, at, snapshot.flags);
    // Validate the observed revision tuple instead of inventing new revisions.
    if (dataCodec.hash(value.revisions) !== dataCodec.hash(dataCodec.revisionVector(snapshot))) throw new Error('revisions');
    if (!Array.isArray(snapshot.usage) || !Array.isArray(snapshot.advisorAssignments)) throw new Error('shape');
    const usage = snapshot.usage.map(row => {
        dataCodec.equalScope(row, selector);
        return dataCodec.validateUsage(row, entitlement);
    });
    const base = { identity: { provider: selector.provider, subjectKey: selector.subjectKey },
        scope: { tenantId: selector.tenantId, organisationId: selector.organisationId }, evaluatedAt: at,
        signup: { status: 'unavailable' }, diagnostics: { status: 'unavailable' }, recovery: [] };
    const selectedMembers = membership.memberships.filter(row => row.subjectKey === selector.subjectKey);
    const invitations = membership.invitations.filter(row => row.subjectKey === selector.subjectKey);
    if (!selectedMembers.length && !invitations.length) return freeze({ ...base, status: 'not_found' });
    return freeze({ ...base, status: 'found',
        // Advisor IDs concern other people and are unnecessary for this read.
        revisions: Object.fromEntries(['tenant', 'organisation', 'membership', 'entitlement', 'flags']
            .map(key => [key, value.revisions[key]])),
        tenant: { displayName: aggregate.tenant.displayName, status: aggregate.tenant.recordStatus },
        organisation: { displayName: organisation.displayName, status: organisation.recordStatus },
        memberships: selectedMembers.map(row => ({ membershipId: row.membershipId, status: row.status,
            roles: row.roles, validFrom: row.validFrom, validUntil: row.validUntil,
            effectiveStatus: row.status !== 'active' ? row.status : at < row.validFrom ? 'not_started' : at >= row.validUntil ? 'expired' : 'active' })),
        invitations: invitations.map(row => ({ status: row.status, roles: row.roles,
            validFrom: row.validFrom, validUntil: row.validUntil, expiresAt: row.expiresAt })),
        entitlements: entitlement.grants.map(row => ({ grantId: row.grantId, code: row.code, status: row.status,
            validFrom: row.validFrom, validUntil: row.validUntil })),
        flags: { enabled: snapshot.flags.enabled },
        usage: usage.map(row => ({ grantId: row.grantId, revision: row.revision, counters: row.counters })) });
}

module.exports = { projectAuthorityRead };
