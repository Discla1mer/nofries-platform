const { runSalesFunction } = require('../shared/salesRuntime');

module.exports = async function salesAssessments(context, req) {
    await runSalesFunction(context, req);
};
