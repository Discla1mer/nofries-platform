const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesProposals(context, req) {
    await runSalesFunction(context, req);
};
