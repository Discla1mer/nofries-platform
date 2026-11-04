'use strict';
const { handle } = require('../shared/websiteAnalyticsFunction');
module.exports = async (context, req) => { context.res = await handle(req, '/events'); };
