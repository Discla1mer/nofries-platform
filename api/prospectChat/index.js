const { runProspectChatFunction } = require('../shared/prospectRuntime');

module.exports = async function prospectChat(context, req) {
    await runProspectChatFunction(context, req);
};
