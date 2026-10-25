const { runMcpFunction } = require('../sharedRuntime')('mcpRuntime');

module.exports = async function mcp(context, req) {
    await runMcpFunction(context, req);
};
