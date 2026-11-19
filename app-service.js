'use strict';

const { startAppServiceHost } = require('./lib/hostStartup');
const { startMonthlyProofScheduler } = require('./api/shared/monthlyProofScheduler');
const { startLifecycleEmailDispatcher } = require('./api/shared/lifecycleEmail/dispatcher');
const { startContactRequestRetention } = require('./api/shared/contactRequestRetention');
const { createProductionApplication } = require('./lib/productionApplication');

try {
    const hostedApp = createProductionApplication();
    startMonthlyProofScheduler();
    startLifecycleEmailDispatcher();
    startContactRequestRetention();
    startAppServiceHost(hostedApp);
} catch (error) {
    console.error(error && error.message || 'The No Fries App Service host could not start.');
    process.exitCode = 1;
}
