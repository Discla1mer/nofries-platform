const { runLifecycleFunction } = require('../shared/appLifecycleRuntime');

module.exports = async function lifecycleApp(context, req) {
    await runLifecycleFunction(context, req);
};
