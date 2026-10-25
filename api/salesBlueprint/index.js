const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesBlueprint(context, req) {
    await runSalesFunction(context, req);
};
