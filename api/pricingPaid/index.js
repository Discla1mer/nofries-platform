'use strict';

const { readPublicPaidPricing } = require('../shared/publicPaidPricing');

module.exports = async function pricingPaid(context) {
    context.res = readPublicPaidPricing();
};
