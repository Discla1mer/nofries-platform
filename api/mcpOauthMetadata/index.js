const { runMcpOauthMetadataFunction } = require('../shared/mcpOauthBridge');

module.exports = async function mcpOauthMetadata(context, req) {
    await runMcpOauthMetadataFunction(context, req);
};
