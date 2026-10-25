'use strict';

const { runCustomerPortalFunction } = require('../shared/customerPortalRuntime');

module.exports = async function customerPortalTickets(context, req) {
    await runCustomerPortalFunction(context, req);
};
