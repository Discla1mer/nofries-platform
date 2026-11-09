'use strict';

const { fields, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { createExpiryAction } = require('./accountActionsExpiry');
const { accountActionsPool } = require('./accountActionsPool');
const { createExpiryApproval } = require('./accountActionsApproval');

function createAccountActionsRuntime(configuration, dashboard, authorise) {
    fields(configuration, ['source', 'authorityContainer', 'auditContainer',
        ...(Object.hasOwn(configuration, 'readApprovedExtension') ? ['readApprovedExtension'] : [])]);
    if (Object.hasOwn(configuration, 'readApprovedExtension') && typeof configuration.readApprovedExtension !== 'function') throw new Error('dashboard_admin_configuration_invalid');
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
    const issuer = configuration.readApprovedExtension ? null : createExpiryApproval(options);
    const expiry = createExpiryAction({ ...options, readApprovedExtension: configuration.readApprovedExtension || issuer.readApprovedExtension });
    return Object.freeze({ execute(actor, input, invocation, action) {
        if (action !== 'extend-expired-access') throw new Error('dashboard_admin_unavailable');
        return expiry.execute(actor, input, invocation);
    },
        ...(issuer ? { approve: issuer.approve } : {}) });
}
module.exports = { createAccountActionsRuntime };
