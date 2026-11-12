'use strict';

// One template version per lifecycle email type: the type name plus '-v1'.
// Shared by the outbox writer and the templates so the two cannot drift.
const TEMPLATE_VERSIONS = Object.freeze({
    welcome: 'welcome-v1',
    result_summary: 'result_summary-v1',
    nudge_unfinished: 'nudge_unfinished-v1',
    reassess_reminder: 'reassess_reminder-v1'
});

module.exports = { TEMPLATE_VERSIONS };
