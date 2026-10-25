'use strict';

const { createProductionOrganisationSetup } = require('./organisationSetupProduction');
const { createProductionDashboardConfiguration } = require('./dashboardProduction');
const { createProductionCustomerSignupConfiguration, createExternalCustomerSignupConfiguration } = require('./customerSignupProduction');
const { createProductionCustomerActivation } = require('./customerActivationProduction');
const { externalCustomerConfiguration } = require('./externalCustomerConfiguration');
const { createProductionDashboardAdministration } = require('./dashboardAdminProduction');

// The launcher and HTTP acceptance tests call this same composition. Tests may
// substitute external SDK boundaries, never signup handlers or identity proofs.
function createProductionApplication(env = process.env, dependencies = {}) {
    const externalConfiguration = dependencies.externalCustomer || externalCustomerConfiguration(env, dependencies);
    const dashboard = createProductionDashboardConfiguration(env, dependencies);
    const signup = createProductionCustomerSignupConfiguration(env, dashboard, dependencies);
    const configuration = dashboard ? { dashboard: signup ? { ...dashboard, customer: signup.customer } : dashboard } : {};
    const activation = createProductionCustomerActivation(env, dashboard, dependencies);
    if (activation) configuration.dashboard = { ...configuration.dashboard, activation };
    if (signup) Object.assign(configuration, { customerSignup: signup.customerSignup, signupBootstrap: signup.signupBootstrap });
    if (signup?.starterClients) configuration.starterClients = signup.starterClients;
    if (signup?.resolveStarterQuota && dashboard.ncsc) configuration.dashboard = { ...configuration.dashboard,
        ncsc: { resolveSubmissionQuota: async input => await signup.resolveStarterQuota(input) ?? dashboard.ncsc.resolveSubmissionQuota(input) } };
    // Signer transport dependencies belong only to the external composition;
    // enumerating other dependency values must not touch them while disabled.
    const organisationDependencies = Object.fromEntries(Object.keys(dependencies)
        .filter(key => key !== 'customerAssertion' && key !== 'dashboardAdministration').map(key => [key, dependencies[key]]));
    const organisationSetup = createProductionOrganisationSetup(env, { ...organisationDependencies,
        ...(signup?.findAccount ? { findAccount: signup.findAccount } : {}),
        ...(signup?.starterSetup ? { starterSetup: signup.starterSetup } : {}) });
    if (organisationSetup) configuration.organisationSetup = organisationSetup;
    if (externalConfiguration) {
        const external = createExternalCustomerSignupConfiguration(env, dashboard, dependencies, externalConfiguration);
        configuration.dashboard = { ...configuration.dashboard, externalCustomer: external.customer };
        configuration.externalCustomerSignup = external.customerSignup;
        if (external.retainedTrialRead) configuration.retainedTrialRead = external.retainedTrialRead;
        if (env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED === 'true') configuration.customerEntry = 'external';
        // Managed provider signup precedes No Fries setup. Never expose a
        // second application OTP handler sharing the legacy setup namespace.
        if (external.resolveStarterQuota && configuration.dashboard.ncsc) {
            const priorQuota = configuration.dashboard.ncsc.resolveSubmissionQuota;
            configuration.dashboard.ncsc = { resolveSubmissionQuota: async input => await external.resolveStarterQuota(input) ?? priorQuota(input) };
        }
        if (external.starterClients) configuration.externalStarterClients = external.starterClients;
    }
    Object.assign(configuration, createProductionDashboardAdministration(env, dashboard, dependencies, externalConfiguration));
    return require('../server').createNoFriesApp(configuration);
}
module.exports = { createProductionApplication };
