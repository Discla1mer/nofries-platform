'use strict';

// Plans in the combined Overview read's Actions card.
const OVERVIEW_PLAN_LIMIT = 5;
const OVERVIEW = '/api/dashboard/modules/overview?view=first-paint';

// The combined Overview read stands for the separate reads it replaces: the
// assessment page and default assessment, plus with Actions the plan index and
// up to OVERVIEW_PLAN_LIMIT plan lists. The read limiter charges that maximum
// before any read runs. Every other request costs 1.
function dashboardReadCost(method, url) {
    if (method !== 'GET') return 1;
    if (url === OVERVIEW) return 2;
    if (url === OVERVIEW + '&actions=1') return 2 + 1 + OVERVIEW_PLAN_LIMIT;
    return 1;
}

module.exports = Object.freeze({ OVERVIEW_PLAN_LIMIT, dashboardReadCost });
