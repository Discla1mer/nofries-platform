'use strict';

const { runCustomerPortalFunction } = require('../shared/customerPortalRuntime');

module.exports = async function customerPortalProof(context, req) {
    await runCustomerPortalFunction(context, req);
};
