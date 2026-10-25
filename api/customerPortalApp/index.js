'use strict';

const { runCustomerPortalFunction } = require('../shared/customerPortalRuntime');

module.exports = async function customerPortalApp(context, req) {
    await runCustomerPortalFunction(context, req);
};
