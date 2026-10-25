const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function account(context, req) {
    await runFunction(context, req, handlers.account);
};
