const { runMcpAuthMetadataFunction } = require('../shared/mcpRuntime');

module.exports = async function mcpAuth(context, req) {
    await runMcpAuthMetadataFunction(context, req);
};
