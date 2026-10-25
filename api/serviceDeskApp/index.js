const { runServiceDeskFunction } = require('../shared/serviceDeskRuntime');

module.exports = async function serviceDeskApp(context, req) {
    await runServiceDeskFunction(context, req);
};
