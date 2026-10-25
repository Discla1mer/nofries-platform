const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function evidence(context, req) {
    await runFunction(context, req, handlers.evidence);
};
