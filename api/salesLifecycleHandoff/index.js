const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesLifecycleHandoff(context, req) {
    await runSalesFunction(context, req);
};
