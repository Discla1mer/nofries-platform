const { runDattoRmmFunction } = require('../shared/dattoRmmRuntime');

module.exports = async function dattoRmmSites(context, req) {
    await runDattoRmmFunction(context, req);
};
