const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function revokeShareLink(context, req) {
    await runFunction(context, req, handlers.revokeShareLink);
};
