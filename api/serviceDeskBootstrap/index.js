const { runServiceDeskFunction } = require('../shared/serviceDeskRuntime');

module.exports = async function serviceDeskBootstrap(context, req) {
    await runServiceDeskFunction(context, req);
};
