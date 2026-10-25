const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function organisationAssessment(context, req) {
    await runFunction(context, req, handlers.assessment);
};
