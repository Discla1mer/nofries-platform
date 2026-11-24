'use strict';

const { apiSecurityHeaders } = require('./securityHeaders');

function readPublicPaidPricing(env = process.env) {
    return {
        status: 200,
        headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
        body: env.NOFRIES_PAID_FRAMEWORKS_ENABLED === 'true'
            ? { price: 'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free).' }
            : {}
    };
}

module.exports = { readPublicPaidPricing };
