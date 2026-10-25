const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesCatalogue(context, req) {
    await runSalesFunction(context, req);
};
