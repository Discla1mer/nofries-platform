const { runMcpAuthMetadataFunction } = require('../sharedRuntime')('mcpRuntime');

module.exports = async function mcpProtectedResource(context, req) {
    await runMcpAuthMetadataFunction(context, req);
};
