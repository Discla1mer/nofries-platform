'use strict';

const { fields, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { createExpiryAction } = require('./accountActionsExpiry');
const { accountActionsPool } = require('./accountActionsPool');

function createAccountActionsRuntime(configuration, dashboard, authorise) {
    fields(configuration, ['source', 'authorityContainer', 'auditContainer', 'readApprovedExtension']);
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
    return createExpiryAction({ ...configuration, clock: dashboard.clock,
        async readContext(actor, selector, { request, signal }) {
            if (signal.aborted) throw new Error();
            const { capture } = await pool.run(() => repository.validateSession(request, selector));
            if (signal.aborted) throw new Error();
            return { operatorSubjectKey: capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid,
                sessionSha256: capture.sessionSha256, instanceId: capture.instanceId, restoreEpoch: capture.restoreEpoch,
                identityPolicySha256: hash(dashboard.identityPolicy) };
        } });
}
module.exports = { createAccountActionsRuntime };
