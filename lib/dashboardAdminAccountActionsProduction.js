'use strict';

const { isProxy } = require('node:util').types;
const { fields } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createDashboardAdminAccountActionRuntime } = require('../api/shared/dashboardAdmin/accountActionRuntime');
const fail = () => { throw new Error('dashboard_admin_account_actions_configuration_invalid'); };

// Independent private-store selection, separate from read-only administration.
// The launcher can locate existing stores; their current records grant authority.
// This factory publishes no approvals and provisions no storage or permissions.
function createProductionDashboardAccountActions(dashboard, dependencies = {}, env = {}, externalConfiguration = null) {
    try {
        if (!dependencies || typeof dependencies !== 'object' || isProxy(dependencies)) fail();
        let descriptor = Object.getOwnPropertyDescriptor(dependencies, 'dashboardAccountActions');
        if (!descriptor) {
            const bind = require('./dashboardAdminAccountActionBindings').bindProductionAccountActions(env, dependencies);
            if (!bind) return Object.freeze({});
            const value = bind(dashboard);
            descriptor = { value };
        }
        if (!Object.hasOwn(descriptor, 'value')) fail();
        if (descriptor.value === null) return Object.freeze({});
        const selected = fields(descriptor.value, ['readApprovedActionBinding', 'confirmationStore',
            ...(Object.hasOwn(descriptor.value, 'signupReset') ? ['signupReset'] : [])]);
        if (typeof selected.readApprovedActionBinding !== 'function' || isProxy(selected.readApprovedActionBinding) ||
            !dashboard || typeof dashboard !== 'object' || isProxy(dashboard)) fail();
        const common = {};
        for (const key of ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
            'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId', 'requestBudgetMs']) {
            const value = Object.getOwnPropertyDescriptor(dashboard, key);
            if (!value || !Object.hasOwn(value, 'value')) fail();
            common[key] = value.value;
        }
        if (!Number.isSafeInteger(common.requestBudgetMs) || common.requestBudgetMs < 1 || common.requestBudgetMs > 60000) fail();
        common.requestBudgetMs = Math.min(common.requestBudgetMs, 10000);
        // Reset is deliberately uncomposed until the #55/#56/#57/#59 fence
        // reconciliation lands and its adoption/recovery gates are qualified.
        // Neither old settings nor an injected reset port can activate it.
        // Re-enabling requires a reviewed source change, not an environment flag.
        return Object.freeze({ dashboardAdminAccountActions: createDashboardAdminAccountActionRuntime({ ...common,
            readApprovedActionBinding: selected.readApprovedActionBinding,
            confirmationStore: selected.confirmationStore }) });
    } catch (_) { fail(); }
}

module.exports = { createProductionDashboardAccountActions };
