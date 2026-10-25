const { runMcpAuthMetadataFunction } = require('../sharedRuntime')('mcpRuntime');

module.exports = async function mcpAuth(context, req) {
    await runMcpAuthMetadataFunction(context, req);
};
