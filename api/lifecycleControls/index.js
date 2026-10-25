const { runLifecycleFunction } = require('../shared/appLifecycleRuntime');

module.exports = async function lifecycleControls(context, req) {
    await runLifecycleFunction(context, req);
};
