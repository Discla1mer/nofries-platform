const { runLifecycleFunction } = require('../shared/appLifecycleRuntime');

module.exports = async function lifecycleBootstrap(context, req) {
    await runLifecycleFunction(context, req);
};
