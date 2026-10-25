'use strict';

const { resolveOrganisation } = require('./tenantDomain');
const { resolveActiveMembership } = require('./membershipDomain');
const { resolveEntitlements } = require('./entitlementDomain');
const { resolvePortalPermission } = require('./portalPermissions');
const registry = require('../protectedAssets/dashboardRegistry');

class DashboardProjectionError extends Error {
    constructor() { super('dashboard_unavailable'); this.code = 'dashboard_unavailable'; this.statusCode = 403; }
}
const deny = () => { throw new DashboardProjectionError(); };

/** Pure trusted-server composition; never pass request JSON as these snapshots.
 * This display contract grants neither admission nor permission to act. POR-005
 * must authenticate, load current coherent state and authorise each resource.
 */
function projectDashboard(input) {
    try {
        const { tenantAggregate, membershipState, entitlementState, scope, subjectKey, flags, now } = input;
        const organisation = resolveOrganisation(tenantAggregate, scope);
        const member = resolveActiveMembership(membershipState, tenantAggregate, { ...scope, subjectKey }, now);
        const entitlement = resolveEntitlements(entitlementState, tenantAggregate, scope, now, flags);
        if (!entitlement.product || flags?.enabled?.dashboard !== true) deny();
        const modules = registry.modules.flatMap(item => {
            if (entitlement.modules[item.key].entitled !== true) return [];
            try {
                const permission = resolvePortalPermission(membershipState, tenantAggregate,
                    { ...scope, subjectKey, permission: item.permission, module: item.key },
                    input.advisorAssignments?.[item.key] ?? null, now);
                if (permission.role === 'fractional_advisor' &&
                    entitlement.services.fractional_advisory.enabled !== true) return [];
            } catch (error) { return []; }
            return [{ key: item.key, state: !entitlement.modules[item.key].eligible ? 'disabled'
                : ['overview', 'services'].includes(item.key) ? 'ready' : 'planned' }];
        });
        if (!modules.length) deny();
        const mayRead = key => modules.some(item => item.key === key && item.state !== 'disabled');
        const services = mayRead('services') ? registry.services.map(item => {
            const service = entitlement.services[item.key];
            return { key: item.key, state: !service.entitled ? 'not_included'
                : !service.enabled ? 'disabled' : 'setup_required', operational: false };
        }) : [];
        const audience = member.roles.includes('admin') || member.roles.includes('editor') ? 'IT manager'
            : member.roles.includes('viewer') ? 'Executive / board' : 'Scoped advisor';
        return freeze({ schemaVersion: 1, context: { organisationId: organisation.organisationId,
            displayName: organisation.displayName }, audience,
            currentUser: { jobTitle: projectJobTitle(input.currentUserProfile, scope, member) },
            subscription: entitlement.product.code === 'dashboard_govern' ? 'Govern' : 'Score',
            generatedAt: entitlement.evaluatedAt, modules, services,
            summary: projectSummary(input.summary, scope, mayRead, entitlement.evaluatedAt),
            admissionGranted: false, providerAccessGranted: false });
    } catch (error) { deny(); }
}

function projectJobTitle(profile, scope, member) {
    if (profile == null) return null;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
        Object.keys(profile).length !== 5 ||
        profile.tenantId !== scope.tenantId || profile.organisationId !== scope.organisationId ||
        profile.subjectKey !== member.subjectKey || profile.membershipId !== member.membershipId ||
        typeof profile.jobTitle !== 'string' || !profile.jobTitle || profile.jobTitle.length > 120 ||
        profile.jobTitle !== profile.jobTitle.trim().normalize('NFC') || /[\u0000-\u001f\u007f-\u009f<>]/u.test(profile.jobTitle)) deny();
    return profile.jobTitle;
}

function projectSummary(summary, scope, mayRead, now) {
    // No default numbers, score arithmetic or guessed customer records.
    if (!summary || !mayRead('overview')) return { state: 'empty', attention: [], metrics: [] };
    if (summary.tenantId !== scope.tenantId || summary.organisationId !== scope.organisationId ||
        !['current', 'stale'].includes(summary.state) || !Array.isArray(summary.attention) || !Array.isArray(summary.metrics)) deny();
    const attention = summary.attention.filter(item => mayRead(item.module)).map(item => ({
        module: item.module, title: text(item.title), owner: text(item.owner), due: text(item.due),
        source: text(item.source), nextAction: text(item.nextAction),
        priority: ['High', 'Medium', 'Low'].includes(item.priority) ? item.priority : 'Unrated'
    }));
    const allowedMetrics = ['implementation', 'evidence', 'risk', 'trend'];
    const metrics = summary.metrics.filter(item => mayRead(item.module)).map(item => {
        if (!allowedMetrics.includes(item.kind) || !canonicalInstant(item.asAt) || Date.parse(item.asAt) > Date.parse(now)) deny();
        return { module: item.module, kind: item.kind, value: text(item.value), period: text(item.period),
            version: text(item.version), revision: text(item.revision), evidence: text(item.evidence), asAt: item.asAt };
    });
    return { state: summary.state, attention, metrics };
}
function text(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) deny();
    return value;
}
function canonicalInstant(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
module.exports = { projectDashboard, DashboardProjectionError };
