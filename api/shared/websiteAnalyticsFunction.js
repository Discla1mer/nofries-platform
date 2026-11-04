'use strict';
// Each function worker keeps one identifier-free global budget.
const { createRuntime } = require('./websiteAnalyticsRuntime');
const handle = createRuntime();
module.exports = { handle };
