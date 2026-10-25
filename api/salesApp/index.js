const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesApp(context, req) {
    await runSalesFunction(context, req);
};
