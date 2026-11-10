'use strict';

const { fields, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { createMembershipAction } = require('./accountActionsMembership');
const { createAccountActionsRepository } = require('./accountActionsRepository');
const { accountActionsPool } = require('./accountActionsPool');

function createAccountActionsRuntime(configuration, dashboard, authorise) {
    if (Object.hasOwn(configuration, 'sources')) return require('./accountActionsSources')
        .createAccountActionsSources(configuration, dashboard, authorise, createAccountActionsRuntime);
    // Suspend and restore are the only account actions. Approvals are issued
    // and read by the built-in store unless a trusted reader is also supplied.
    fields(configuration, ['source', 'authorityContainer', 'auditContainer', 'auditPolicy',
        ...(Object.hasOwn(configuration, 'readApprovedAction') ? ['readApprovedAction'] : [])]);
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
    const options = { ...configuration, clock: dashboard.clock,
        async readContext(actor, selector, { request, signal }) {
            if (signal.aborted) throw new Error();
            const { capture } = await pool.run(() => repository.validateSession(request, selector));
            if (signal.aborted) throw new Error();
            return { operatorSubjectKey: capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid,
                sessionSha256: capture.sessionSha256, instanceId: capture.instanceId, restoreEpoch: capture.restoreEpoch,
                identityPolicySha256: hash(dashboard.identityPolicy) };
        } };
    const membership = createMembershipAction({ ...options, identityPolicy: dashboard.identityPolicy,
        createRepository: (guard, allowed, context) => createAccountActionsRepository(pool, dashboard.clock, guard, allowed, context) });
    return Object.freeze({ execute(actor, input, invocation, action) {
        if (!['suspend', 'restore', 'approve-suspend', 'approve-restore'].includes(action)) throw new Error('dashboard_admin_unavailable');
        return membership.execute(actor, input, invocation, action);
    } });
}
module.exports = { createAccountActionsRuntime };
