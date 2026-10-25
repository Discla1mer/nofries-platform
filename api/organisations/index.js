const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function organisations(context, req) {
    await runFunction(context, req, handlers.createOrganisation);
};
