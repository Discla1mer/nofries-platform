const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesCustomers(context, req) {
    await runSalesFunction(context, req);
};
