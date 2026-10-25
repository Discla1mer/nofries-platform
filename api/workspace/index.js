const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function workspace(context, req) {
    await runFunction(context, req, handlers.workspace);
};
