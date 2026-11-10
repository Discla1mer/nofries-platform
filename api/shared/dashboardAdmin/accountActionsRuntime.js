'use strict';

const { fields, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { createMembershipAction } = require('./accountActionsMembership');
const { createAccountActionsRepository } = require('./accountActionsRepository');
const { createExpiryAction } = require('./accountActionsExpiry');
const { accountActionsPool } = require('./accountActionsPool');
const { createExpiryApproval } = require('./accountActionsApproval');
const { DashboardAdminError } = require('./service');

function createAccountActionsRuntime(configuration, dashboard, authorise) {
    if (Object.hasOwn(configuration, 'sources')) return require('./accountActionsSources')
        .createAccountActionsSources(configuration, dashboard, authorise, createAccountActionsRuntime);
    const hasMembership = ['readApprovedAction', 'auditPolicy'].some(key => Object.hasOwn(configuration, key));
    // `expiry: false` withdraws expiry extension entirely: no approval issuer
    // and no executor are constructed for this source.
    const withdrawn = Object.hasOwn(configuration, 'expiry');
    if (withdrawn && (configuration.expiry !== false || Object.hasOwn(configuration, 'readApprovedExtension'))) throw new Error('dashboard_admin_configuration_invalid');
    fields(configuration, ['source', 'authorityContainer', 'auditContainer', ...(withdrawn ? ['expiry'] : []),
        ...(hasMembership ? ['auditPolicy'] : []), ...(Object.hasOwn(configuration, 'readApprovedAction') ? ['readApprovedAction'] : []),
        ...(Object.hasOwn(configuration, 'readApprovedExtension') ? ['readApprovedExtension'] : [])]);
    if (Object.hasOwn(configuration, 'readApprovedExtension') && typeof configuration.readApprovedExtension !== 'function') throw new Error('dashboard_admin_configuration_invalid');
    if (Object.hasOwn(configuration, 'readApprovedAction') && typeof configuration.readApprovedAction !== 'function') throw new Error('dashboard_admin_configuration_invalid');
    const select = names => Object.fromEntries(names.map(key => [key, dashboard[key]]));
    const pool = accountActionsPool(dashboard.pool);
    const session = createDashboardOperatorSession(select(['browserAuthOptions', 'identityPolicy', 'proofStore',
        'clock', 'readExternalRuntimeEpoch', 'newRequestId', 'requestBudgetMs']));
    const repository = createPostgresDashboardAdministrationRepository({ ...select(['pool', 'clock', 'instanceId',
        'historyBudget', 'readExternalRuntimeEpoch', 'newId']), pool, captureRequest: request => session.captureRequest(request),
        authoriseAdministration: async ({ capture, selector }) => {
            await authorise({ provider: 'entra-bff', isAuthenticated: true,
                subjectKey: capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid }, selector);
            return true;
        } });
    const { expiry: _expiry, ...base } = configuration;
    const options = { ...base, clock: dashboard.clock,
        async readContext(actor, selector, { request, signal }) {
            if (signal.aborted) throw new Error();
            const { capture } = await pool.run(() => repository.validateSession(request, selector));
            if (signal.aborted) throw new Error();
            return { operatorSubjectKey: capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid,
                sessionSha256: capture.sessionSha256, instanceId: capture.instanceId, restoreEpoch: capture.restoreEpoch,
                identityPolicySha256: hash(dashboard.identityPolicy) };
        } };
    const issuer = withdrawn || configuration.readApprovedExtension ? null : createExpiryApproval(options);
    const expiry = withdrawn ? null : createExpiryAction({ ...options, readApprovedExtension: configuration.readApprovedExtension || issuer.readApprovedExtension });
    const membership = hasMembership ? createMembershipAction({ ...options, identityPolicy: dashboard.identityPolicy,
        createRepository: (guard, allowed, context) => createAccountActionsRepository(pool, dashboard.clock, guard, allowed, context) }) : null;
    return Object.freeze({ expiry: !withdrawn, execute(actor, input, invocation, action) {
        if (action === 'extend-expired-access') {
            if (!expiry) throw new DashboardAdminError(404, 'dashboard_admin_not_found');
            return expiry.execute(actor, input, invocation);
        }
        if (!membership || !['suspend', 'restore', 'approve-suspend', 'approve-restore'].includes(action)) throw new Error('dashboard_admin_unavailable');
        return membership.execute(actor, input, invocation, action);
    },
        ...(issuer ? { approve: issuer.approve } : {}) });
}
module.exports = { createAccountActionsRuntime };
