'use strict';

// Synthetic development data only. Never imported by a production entry point.
const { createTenantAggregate } = require('../../api/shared/appLifecycle/tenantDomain');
const { createMembershipState, applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { MODULES, TIERS } = require('../../api/shared/appLifecycle/entitlementDomain');
const { projectDashboard } = require('../../api/shared/appLifecycle/dashboardProjection');
const SUBJECT = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const NOW = '2026-09-06T09:00:00.000Z';

function fixture(options = {}) {
    const now = options.now || NOW;
    const start = new Date(Date.parse(now) - 86400000).toISOString();
    const accept = new Date(Date.parse(now) - 3600000).toISOString();
    const end = new Date(Date.parse(now) + 86400000).toISOString();
    const scope = { tenantId: 'synthetic-tenant', organisationId: options.organisationId || 'synthetic-workshop' };
    const tenantAggregate = createTenantAggregate({ tenant: { tenantId: scope.tenantId, displayName: 'Synthetic workspace' },
        organisations: [{ ...scope, displayName: options.name || 'Harbour Workshop (synthetic)' }] });
    let membershipState = createMembershipState(tenantAggregate, scope, start);
    function command(action, payload, at) {
        membershipState = applyMembershipCommand(membershipState, tenantAggregate, { ...scope,
            expectedRevision: membershipState.revision, actorSubjectKey: SUBJECT, now: at, action, payload });
    }
    command('invite', { invitationId: 'synthetic-invitation', subjectKey: SUBJECT, roles: [options.role || 'admin'],
        validFrom: start, validUntil: end, grantEvidenceId: 'synthetic-role-evidence', expiresAt: end }, start);
    command('accept', { invitationId: 'synthetic-invitation', membershipId: 'synthetic-membership' }, accept);
    const code = options.tier || 'dashboard_govern';
    const frameworks = ['cyber_security', 'ai_governance', 'it_optimisation'].filter(module => TIERS[code].includes(module))
        .map(moduleId => ({ moduleId, profileId: 'synthetic-' + moduleId, version: '1.0' }));
    const grant = { ...scope, grantId: 'synthetic-product', code, status: 'active', validFrom: start, validUntil: end,
        agreementRef: 'synthetic-private-order-not-for-browser', modules: options.modules || [...TIERS[code]], frameworks,
        limits: { assessment_runs: 10, report_exports: 10, evidence_bytes: 10000, memberships: 10, ai_requests: 5 }, coverage: [], actions: [] };
    grant.frameworks = frameworks.filter(item => grant.modules.includes(item.moduleId));
    const services = options.service ? [{ ...scope, grantId: 'synthetic-service', code: options.service, status: 'active',
        validFrom: start, validUntil: end, agreementRef: 'synthetic-service-order', modules: ['services'], frameworks: [], limits: {}, coverage: ['synthetic-target'], actions: ['view'] }] : [];
    const entitlementState = { schemaVersion: 1, ...scope, revision: 1, grants: [grant, ...services] };
    const flags = { ...scope, revision: 1, enabled: { dashboard: true, ...Object.fromEntries(MODULES.map(key => [key, true])),
        ...(options.service ? { ['service:' + options.service]: true } : {}), ...options.enabled }, frameworks };
    const summary = options.empty ? undefined : { ...scope, state: options.stale ? 'stale' : 'current', attention: [
        { module: 'cyber_security', title: 'Confirm backup restoration evidence', owner: 'Operations lead', due: 'Due this week',
            source: 'Synthetic Cyber Security / Recovery / revision 3', nextAction: 'Agree an owner and record the next restore-test date.', priority: 'High' },
        { module: 'cyber_security', title: 'Assign the access review owner', owner: 'IT manager', due: 'Due next week',
            source: 'Synthetic Cyber Security / Access / revision 3', nextAction: 'Confirm who will review administrator access.', priority: 'High' },
        { module: 'cyber_security', title: 'Review supplier recovery responsibilities', owner: 'Business owner', due: 'Awaiting decision',
            source: 'Synthetic Cyber Security / Suppliers / revision 3', nextAction: 'Confirm which recovery responsibilities are in scope.', priority: 'Medium' }
    ], metrics: [['implementation', '64%'], ['evidence', '48%'], ['risk', '2 high priorities'], ['trend', '+8 points']].map(([kind, value]) => ({
        module: 'cyber_security', kind, value, period: 'Synthetic September review', version: 'Synthetic profile 1.0',
        revision: 'Assessment revision 3', evidence: 'Sample evidence only', asAt: now
    })) };
    const advisor = { schemaVersion: 1, assignmentId: 'synthetic-assignment', ...scope, membershipId: 'synthetic-membership',
        subjectKey: SUBJECT, status: 'active', validFrom: start, validUntil: end,
        modules: ['cyber_security'], permissions: ['assessment.read'], grantEvidenceId: 'synthetic-advisor-scope', revision: 1, updatedAt: accept };
    return { tenantAggregate, membershipState, entitlementState, flags, scope, subjectKey: SUBJECT, now,
        summary, advisorAssignments: options.role === 'fractional_advisor' ? { cyber_security: advisor } : {} };
}
function scenarios(now = NOW) {
    return Object.fromEntries([
        ['IT manager · Govern', {}], ['Executive · Score', { role: 'viewer', tier: 'dashboard_score' }],
        ['Scoped advisor · Cyber only', { role: 'fractional_advisor', service: 'fractional_advisory' }], ['First use', { empty: true }],
        ['Stale figures', { stale: true }], ['Service awaiting setup', { service: 'managed_endpoint' }],
        ['Cyber module unavailable', { enabled: { cyber_security: false } }],
        ['Another organisation · empty', { organisationId: 'synthetic-studio', name: 'Kauri Studio (synthetic)', empty: true }]
    ].map(([name, options]) => [name, projectDashboard(fixture({ now, ...options }))]));
}
module.exports = { fixture, scenarios, NOW, SUBJECT };
