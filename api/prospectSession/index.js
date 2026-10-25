const { runProspectSessionFunction } = require('../shared/prospectRuntime');

module.exports = async function prospectSession(context, req) {
    await runProspectSessionFunction(context, req);
};
