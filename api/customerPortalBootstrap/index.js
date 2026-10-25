'use strict';

const { runCustomerPortalFunction } = require('../shared/customerPortalRuntime');

module.exports = async function customerPortalBootstrap(context, req) {
    await runCustomerPortalFunction(context, req);
};
