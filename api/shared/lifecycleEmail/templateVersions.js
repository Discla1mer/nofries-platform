'use strict';

// Current template version per lifecycle email type, shared by the outbox
// writer (enqueue) and the sender (render). Keep both sides on these keys.
const TEMPLATE_VERSIONS = Object.freeze({ welcome: 'welcome-v1', result_summary: 'result-summary-v1',
    nudge_unfinished: 'nudge-unfinished-v1', reassess_reminder: 'reassess-reminder-v1' });

module.exports = { TEMPLATE_VERSIONS };
