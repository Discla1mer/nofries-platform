'use strict';

const contentSecurityPolicy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'";

const dashboardAdminCss = `
:root { color-scheme: light; --ink: #14201f; --muted: #526763; --paper: #f7f5ef; --line: #d8dfdc; --teal: #0d5e58; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--paper); }
body { margin: 0; color: var(--ink); background: var(--paper); font: 1rem/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color: var(--teal); }
a, button, input, select { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid #ad7900; outline-offset: 3px; }
.skip-link { position: fixed; z-index: 10; top: .5rem; left: .5rem; padding: .6rem; color: var(--ink); background: #f6c84b; transform: translateY(-160%); }
.skip-link:focus { transform: translateY(0); }
.admin-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding: 1rem clamp(1rem, 4vw, 3.5rem); }
.admin-brand { color: var(--ink); font-size: 1.25rem; font-weight: 800; text-decoration: none; }
.admin-header nav { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; font-size: .9rem; }
.admin-header form { margin: 0; }
.admin-header button { padding: .4rem .6rem; color: var(--teal); background: transparent; border: 1px solid var(--line); }
main { width: min(74rem, 100%); padding: 2rem clamp(1rem, 4vw, 3.5rem) 4rem; margin: 0 auto; }
h1 { max-width: 22ch; margin: .25rem 0 1rem; font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.08; letter-spacing: -.035em; }
h2 { margin: 0 0 1rem; font-size: 1.4rem; line-height: 1.3; }
h3 { margin: 1.5rem 0 .5rem; font-size: 1.1rem; }
p { max-width: 75ch; }
.eyebrow { margin: 0; color: var(--teal); text-transform: uppercase; font-size: .75rem; letter-spacing: .1em; font-weight: 800; }
.muted { color: var(--muted); }
.admin-panel { min-width: 0; margin-top: 1.5rem; padding: clamp(1rem, 3vw, 1.8rem); border: 1px solid var(--line); border-radius: 1rem; background: white; }
.access-status { padding: .8rem 1rem; border-left: 4px solid var(--teal); background: #e5f2ef; }
fieldset { min-width: 0; margin: 0; border: 0; padding: 0; }
legend { padding: 0; font-weight: 750; }
.admin-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
label { display: grid; min-width: 0; gap: .35rem; font-weight: 700; }
input, select, button { min-width: 0; max-width: 100%; min-height: 44px; border: 1px solid #9aaca7; border-radius: .6rem; font: inherit; }
input, select { width: 100%; padding: .6rem; color: var(--ink); background: white; scroll-margin-block: .5rem; }
input:enabled, select:enabled { border-color: #758b85; }
input { font-family: ui-monospace, monospace; font-size: .9rem; }
button { padding: .6rem 1rem; color: white; background: var(--teal); cursor: pointer; font-weight: 750; }
button:disabled { opacity: .55; cursor: default; }
.secondary { color: var(--teal); background: white; }
.admin-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.admin-actions button { flex-shrink: 1; }
.lookup-status { min-height: 1.55em; margin-bottom: 0; }
dl { display: grid; grid-template-columns: minmax(7rem, 1fr) minmax(0, 3fr); gap: .4rem 1rem; margin: .75rem 0; }
dt { color: var(--muted); }
dd { min-width: 0; margin: 0; }
dd, p, h1, h2, h3, li { overflow-wrap: anywhere; }
.record-list { margin: .5rem 0; padding-left: 1.2rem; }
.record-list > li { padding: .25rem 0 .75rem; }
.admin-footer { margin-top: 2rem; font-size: .9rem; }
@media (max-width: 38rem) { .admin-fields { grid-template-columns: minmax(0, 1fr); } dl { grid-template-columns: minmax(0, 1fr); gap: .15rem; } dd { margin-bottom: .6rem; } .admin-header nav { width: 100%; } }
`;

function buildDashboardAdminDocument() {
    return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>No Fries | Dashboard administration</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/api/dashboard-admin/app.css">
<script src="/api/dashboard-admin/app.js" defer></script>
</head>
<body>
<a class="skip-link" href="#adminMain">Skip to dashboard administration</a>
<header class="admin-header"><a class="admin-brand" href="/operator">No Fries</a>
<nav aria-label="Private workspace navigation"><a href="/operator">Work</a><a href="/scoping">Sales</a><a href="/support">Service desk</a>
<form action="/api/auth/logout" method="post"><input type="hidden" name="returnTo" value="/"><button type="submit">Sign out</button></form></nav></header>
<main id="adminMain" tabindex="-1">
<p class="eyebrow">Restricted operator workspace</p><h1>Dashboard administration</h1>
<p>Look up one dashboard identity within an exact tenant and organisation. Dashboard identities and Sales lifecycle customers are separate records.</p>
<p id="adminAccessStatus" class="access-status" role="status" aria-live="polite">Checking operator access. Lookup is unavailable until access is confirmed.</p>
<div class="admin-actions"><button id="adminCheckAccess" type="button" class="secondary" disabled>Check access again</button><a id="adminSignIn" href="/api/auth/login?returnTo=%2Fdashboard-admin%2Fentry" hidden>Sign in to staff workspace</a></div>
<section class="admin-panel" aria-labelledby="adminLookupHeading"><h2 id="adminLookupHeading">Exact identity lookup</h2>
<p id="adminLookupHelp" class="muted">Use a verified immutable subject key and scope identifiers from an authorised source. An email address or a Sales customer record does not establish dashboard identity.</p>
<form id="adminLookupForm" autocomplete="off"><fieldset id="adminLookupFields" disabled><legend>Identity and scope</legend>
<div class="admin-fields">
<label for="adminProvider">Identity provider<select id="adminProvider" name="provider" required><option value="legacy">Legacy</option><option value="external">External</option></select></label>
<label for="adminSubject">Immutable subject key<input id="adminSubject" name="subjectKey" required maxlength="73" pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" autocomplete="off" spellcheck="false" aria-describedby="adminLookupHelp"></label>
<label for="adminTenant">Tenant ID<input id="adminTenant" name="tenantId" required maxlength="180" autocomplete="off" spellcheck="false"></label>
<label for="adminOrganisation">Organisation ID<input id="adminOrganisation" name="organisationId" required maxlength="180" autocomplete="off" spellcheck="false"></label>
</div><button id="adminLookupSubmit" type="submit">Look up identity</button></fieldset></form>
<div class="admin-actions"><button id="adminLookupCancel" type="button" class="secondary" hidden>Cancel lookup</button></div>
<p id="adminLookupStatus" class="lookup-status" role="status" aria-live="polite" aria-atomic="true"></p></section>
<section id="adminLookupResult" class="admin-panel" aria-labelledby="adminResultHeading" hidden></section>
<section class="admin-panel" aria-labelledby="signupQueueHeading"><h2 id="signupQueueHeading">Signups</h2>
<p class="muted">Recorded signup milestones for an explicitly authorised population. These records do not establish current dashboard access. Sales records and diagnostic errors are separate.</p>
<div class="admin-actions"><button id="signupQueueLoad" type="button" disabled>Load signups</button><button id="signupQueueNext" type="button" class="secondary" disabled>Next page</button><button id="signupQueueCancel" type="button" class="secondary" hidden>Cancel loading signups</button><button id="signupQueueCheck" type="button" class="secondary" disabled>Check signup access</button></div>
<p id="signupQueueStatus" role="status" aria-live="polite" aria-atomic="true">Checking signup capability. No signup records have been loaded.</p>
<div id="signupQueueResult" aria-busy="false" hidden></div></section>
<section class="admin-panel" aria-labelledby="websiteUsageHeading"><h2 id="websiteUsageHeading">Website usage</h2>
<p class="muted">Aggregate views include repeats and possible automated traffic. Daily detail covers up to 90 days.</p>
<button id="websiteUsageLoad" type="button">Load website usage</button><p id="websiteUsageStatus" role="status" aria-live="polite">No website usage has been loaded.</p><div id="websiteUsageResult" hidden></div></section>
<p class="admin-footer muted">This portal is read only. Recovery actions and account changes are unavailable here.</p>
<noscript><p class="access-status">JavaScript is required for this protected lookup. No account data has been loaded.</p></noscript>
</main></body></html>`;
}

module.exports = { buildDashboardAdminDocument, dashboardAdminCss, contentSecurityPolicy };
