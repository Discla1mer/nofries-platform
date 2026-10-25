const { runLifecycleFunction } = require('../shared/appLifecycleRuntime');

module.exports = async function lifecycleRetention(context, req) {
    await runLifecycleFunction(context, req);
};
