const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function organisationEvidence(context, req) {
    await runFunction(context, req, handlers.organisationEvidence);
};
