const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function billingCheckout(context, req) {
    await runFunction(context, req, handlers.billingCheckout);
};
