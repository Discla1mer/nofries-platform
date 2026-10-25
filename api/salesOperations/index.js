const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesOperations(context, req) {
    await runSalesFunction(context, req);
};
