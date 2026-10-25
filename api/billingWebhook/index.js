const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function billingWebhook(context, req) {
    await runFunction(context, req, handlers.billingWebhook);
};
