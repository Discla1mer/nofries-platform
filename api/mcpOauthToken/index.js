const { runMcpOauthTokenFunction } = require('../shared/mcpOauthBridge');

module.exports = async function mcpOauthToken(context, req) {
    await runMcpOauthTokenFunction(context, req);
};
