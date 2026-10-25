const { runMcpFunction } = require('../shared/mcpRuntime');
const { getLifecycleService } = require('../shared/appLifecycleRuntime');

module.exports = async function mcp(context, req) {
    await runMcpFunction(context, req, { lifecycle: getLifecycleService() });
};
