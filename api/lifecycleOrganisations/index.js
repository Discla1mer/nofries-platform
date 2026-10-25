const { runLifecycleFunction } = require('../shared/appLifecycleRuntime');

module.exports = async function lifecycleOrganisations(context, req) {
    await runLifecycleFunction(context, req);
};
