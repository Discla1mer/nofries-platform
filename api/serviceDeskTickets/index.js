const { runServiceDeskFunction } = require('../shared/serviceDeskRuntime');

module.exports = async function serviceDeskTickets(context, req) {
    await runServiceDeskFunction(context, req);
};
