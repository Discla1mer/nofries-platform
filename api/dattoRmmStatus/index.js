const { runDattoRmmFunction } = require('../shared/dattoRmmRuntime');

module.exports = async function dattoRmmStatus(context, req) {
    await runDattoRmmFunction(context, req);
};
