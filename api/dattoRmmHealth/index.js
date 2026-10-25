const { runDattoRmmFunction } = require('../shared/dattoRmmRuntime');

module.exports = async function dattoRmmHealth(context, req) {
    await runDattoRmmFunction(context, req);
};
