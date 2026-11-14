'use strict';

const { startAppServiceHost } = require('./lib/hostStartup');
const { startMonthlyProofScheduler } = require('./api/shared/monthlyProofScheduler');
const { startLifecycleEmailDispatcher } = require('./api/shared/lifecycleEmail/dispatcher');
const { createProductionApplication } = require('./lib/productionApplication');

try {
    const hostedApp = createProductionApplication();
    startMonthlyProofScheduler();
    startLifecycleEmailDispatcher();
    startAppServiceHost(hostedApp);
} catch (error) {
    console.error(error && error.message || 'The No Fries App Service host could not start.');
    process.exitCode = 1;
}
