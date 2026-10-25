const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesAudit(context, req) {
    await runSalesFunction(context, req);
};
