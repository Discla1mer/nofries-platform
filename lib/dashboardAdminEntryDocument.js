'use strict';

function buildDashboardAdminEntryDocument() {
    return `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>No Fries | Open dashboard administration</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/operator.css">
<script src="/api/dashboard-admin/entry.js" defer></script></head>
<body data-page="dashboard-admin-entry"><a class="skip-link" href="#adminEntryHeading">Skip to administration entry</a>
<header class="operator-header"><a class="operator-brand" href="/operator">No Fries</a>
<nav aria-label="Private workspace navigation"><a href="/operator">Work</a><a href="/scoping">Sales</a><a href="/support">Service desk</a>
<form class="sign-out-form" action="/api/auth/logout" method="post"><input type="hidden" name="returnTo" value="/"><button class="sign-out-button" type="submit">Sign out</button></form></nav></header>
<main><section class="operator-loading-panel" aria-labelledby="adminEntryHeading">
<p class="eyebrow">Restricted staff entry</p><h1 id="adminEntryHeading" tabindex="-1">Open dashboard administration</h1>
<p>Check your staff access to open dashboard administration.</p>
<p id="adminEntryStatus" role="status" aria-live="polite" aria-atomic="true">Ready to check access.</p>
<button id="adminEntryOpen" class="button" type="button">Open administration</button>
<button id="adminEntryCancel" class="button button-secondary" type="button" hidden>Cancel access check</button>
<p><a id="adminEntrySignIn" href="/api/auth/login?returnTo=%2Fdashboard-admin%2Fentry" hidden>Sign in again</a></p>
<noscript><p>JavaScript is required to check access. No account data has been loaded.</p></noscript>
</section></main></body></html>`;
}

module.exports = { buildDashboardAdminEntryDocument };
