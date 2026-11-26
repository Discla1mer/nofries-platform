'use strict';

const { apiSecurityHeaders } = require('./securityHeaders');

function readPublicPaidPricing(env = process.env) {
    const body = {};
    if (env.NOFRIES_PAID_FRAMEWORKS_ENABLED === 'true') {
        body.price = 'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free).';
    }
    if (env.NOFRIES_NCSC_PROFILE_V2 === 'true') body.updatedFreeCheckQuestions = 16;
    return {
        status: 200,
        headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
        body
    };
}

module.exports = { readPublicPaidPricing };
