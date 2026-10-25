const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesDynamics(context, req) {
    await runSalesFunction(context, req);
};
