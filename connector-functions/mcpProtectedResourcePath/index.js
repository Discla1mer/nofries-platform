const { runMcpAuthMetadataFunction } = require('../sharedRuntime')('mcpRuntime');

module.exports = async function mcpProtectedResourcePath(context, req) {
    await runMcpAuthMetadataFunction(context, req);
};
