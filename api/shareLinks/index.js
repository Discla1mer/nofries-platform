const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function shareLinks(context, req) {
    await runFunction(context, req, handlers.createShareLink);
};
