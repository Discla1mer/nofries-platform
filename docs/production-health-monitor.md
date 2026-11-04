# Production health and expiry alerts

This is an independent, default-off GitHub Actions monitor of https://nofries.nz.
It does not deploy, roll back, sign in, create accounts or alter customer data.
The only POST is an alert to Joel's chosen destination after a failed check.
No application credentials are used. PR CI uses synthetic fixtures, never the
webhook or live app. No dependency install is needed for scheduled monitoring.

## Checks and limits

Every 15 minutes (minutes 7, 22, 37 and 52 UTC), check `/`, `/signup`, `/login`,
`/dashboard`, `/terms.html`, `/privacy.html`, `/api/health`, and the two public
signup-state endpoints. Pages must return HTML/200; health must report `ok`/200.
Reuse public PR #17's audited unauthenticated GET paths and provider selection:
the signup provider selected by the served page must return `create_account`/200;
an inactive provider's 410 is permitted. No sign-in initiation routes are called.
Because #17 is still separate, this PR shares its route semantics without importing
its optional write-capable CLI. There is no merge dependency or file overlap.

Each request has a 10-second total deadline and 1 MiB response limit, no retries,
cookies or redirect following. HTTPS must validate its hostname and certificate
chain; required responses must expose a certificate with at least 30 days left.
Output contains fixed check names, status codes and certificate days only, never
response bodies, redirect locations, cookies, exception text or webhook URLs.
The public API's process-local request limiter still counts the GETs.

An unhealthy run sends one JSON `{ "text": "...safe check results..." }` alert
and fails the job. A continuing outage/expiry warning repeats every 15 minutes;
there is no deduplication, automatic recovery notification or remediation.
Healthy runs are green in Actions and send no message. Exit codes: 0 healthy or
disabled; 1 unhealthy and alert accepted; 2 invalid configuration/delivery failure.
An HTTP 2xx from the channel means accepted, not proof a person read the message.

## Joel's setup steps (after Fry merges the reviewed PR)

1. Choose the staffed destination and escalation owner. Create a channel webhook
   that accepts HTTPS POST with a JSON `text` field (Slack incoming webhook, or an
   owner-managed relay to another system). Do not paste the URL into GitHub issues,
   PRs, repository files, ordinary variables or chat; it may itself be a secret.
2. In **nofries-platform → Settings → Secrets and variables → Actions → Secrets**,
   set repository secret **`NOFRIES_MONITOR_ALERT_WEBHOOK`** to that HTTPS URL.
   It must have no embedded username/password or fragment. A URL path/query token
   is supported. The endpoint must accept the request directly, without redirects.
3. Have the destination owner send a harmless test message using that channel's
   own setup/test facility and confirm it arrives with the intended recipients.
   Confirm the response contract is HTTP 2xx. This PR does not configure a channel.
4. Under **Actions → Variables**, set repository variable
   **`NOFRIES_MONITOR_ENABLED`** to exactly **`true`**. Leave it unset or set it to
   `false` until the destination and responder are ready. Even if enabled by
   mistake, a missing/invalid destination prevents ALL app probes and fails safely.
5. Wait for the next scheduled **Read-only production health** run on default
   branch main. No manual dispatch exists. Check all nine results, certificate
   days, and the job's status. A scheduled job cannot run from this PR branch.
   Record the run link and channel test receipt on private #686 without secrets.
6. Enable GitHub Actions failure notifications for the responsible owner and check
   the run history daily: failed setup/checkout, a missing destination or a broken
   webhook cannot reliably alert through that same webhook. Scheduled runs can be
   delayed/dropped; public-repository schedules may disable after 60 inactive days
   ([GitHub schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
   This is not an independent uptime SLA or a dead-man monitoring service.
7. To pause, set `NOFRIES_MONITOR_ENABLED=false`. To rotate the destination, pause,
   replace the secret, test delivery with its owner, then re-enable. Do not change
   app permissions or weaken HTTPS verification to make a failing check pass.

This monitor proves reachability, public health and TLS expiry only. It cannot
prove verification-mail delivery, authenticated signup, tenant isolation, saved
assessment durability or customer-data restore. Keep #17's separately authorised
journey acceptance and the recovery work on private #686. Expected downtime must
be handled by the responder; a failed check grants no automatic release authority.
