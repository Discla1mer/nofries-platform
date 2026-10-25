const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function share(context, req) {
    await runFunction(context, req, handlers.share);
};
