const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesBootstrap(context, req) {
    await runSalesFunction(context, req);
};
