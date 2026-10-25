const { runServiceDeskFunction } = require('../shared/serviceDeskRuntime');

module.exports = async function serviceDeskAudit(context, req) {
    await runServiceDeskFunction(context, req);
};
