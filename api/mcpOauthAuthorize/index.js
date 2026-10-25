const { runMcpOauthAuthorizeFunction } = require('../shared/mcpOauthBridge');

module.exports = async function mcpOauthAuthorize(context, req) {
    await runMcpOauthAuthorizeFunction(context, req);
};
