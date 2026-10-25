const { runDattoRmmFunction } = require('../shared/dattoRmmRuntime');

module.exports = async function dattoRmmOnboarding(context, req) {
    await runDattoRmmFunction(context, req);
};
