# Production health and expiry alerts — disabled pending Joel's destination

This portable monitor checks https://nofries.nz without signing in, creating
accounts or altering customer data. The scheduled alerting mode is **default-off**
and belongs on an operator-owned **private host**, separate from the release system.
The public repository has no monitoring workflow, webhook secret or delivery job.
This addresses #71's review finding: public checks and PR CI run without credentials;
secret-backed delivery is confined to the separately managed private monitor.
No scheduler, destination, secret, account or environment is configured by this PR.

## Checks, smoke output and limits

Probe `/`, `/signup`, `/login`, `/dashboard`, `/terms.html`, `/privacy.html`,
`/api/health`, and both public signup-state endpoints. Pages require HTML/200 and
health requires `ok`/200. The provider selected by the signup page must return
`create_account`/200; an inactive provider's 410 is permitted. No auth-start routes
are called. A certificate validated for its hostname and chain, with at least
30 days remaining, is required on every selected response.

Reuse [#17](https://github.com/Discla1mer/nofries-platform/pull/17)'s audited GET
semantics and its `readOnly/results/step/name/ok/reason/probes` result shape via
`smokeReport()`, with the same numbered PASS/FAIL and exact GET URL/HTTP-status
output convention (source `29b80bfa251402e551eb50e8a4633b841ab838dc`). The summary
says **production health**, because this is a smaller probe set plus TLS checks,
not #17's whole smoke suite. No write-capable sign-in CLI is imported or enabled;
#17's branch/files remain unchanged and there is no merge-order dependency.

Each request has a 10-second absolute deadline, 1 MiB body limit, no retries,
cookies or redirect following. Output and alerts contain only fixed labels,
fixed production URLs, statuses and certificate days; never response bodies,
redirect tokens, cookies, exception text or the webhook URL. Public API GETs still
count against the process-local limiter. TLS validation is never disabled.

`node scripts/production-health-monitor.js --check` explicitly runs one
credential-free, read-only check, with no alert delivery or destination lookup.
Without arguments (or with `--monitor`), the CLI does nothing until enabled and a
valid HTTPS destination is supplied. Missing configuration blocks ALL scheduled
probes. Alert mode also refuses to run in GitHub Actions, even if enabled there.

## Joel's short setup steps (after review and merge)

1. Choose a staffed destination and escalation owner, plus an existing private
   Linux host with Node >=22.22.0, util-linux `flock`, trusted CA roots and outbound
   HTTPS. Use a webhook accepting JSON `{ "text": "..." }` directly with HTTP 2xx
   (e.g. a channel webhook or an owner-managed relay). Do not put its URL in chat,
   issues, repository files, public variables or GitHub Actions secrets.
2. The operator installs the **reviewed, exact source SHA** at `/opt/nofries-monitor`
   on that host; no npm install is required. Create operator-owned, private log/lock
   directories matching [the disabled cron template](../ops/production-health.cron.example).
   Confirm the absolute Node/flock paths before copying the template.
3. In that operator's **private crontab** (or its private scheduler's secret store),
   set `NOFRIES_MONITOR_ALERT_WEBHOOK` to the chosen HTTPS URL. Keep
   `NOFRIES_MONITOR_ENABLED=false` and the cron job commented out until the channel
   owner has tested delivery with the channel's own test facility and confirmed
   recipients. No username/password or fragment is accepted in the webhook URL;
   path/query tokens are supported and must remain private. No Fries hosts are
   rejected as alert destinations to prevent accidental production POSTs.
4. Set `NOFRIES_MONITOR_ENABLED=true` privately and uncomment the template's
   `7,22,37,52 * * * *` job. It runs every 15 minutes; `flock` prevents overlaps.
   Check the first nine results and certificate days in the private log. Record
   the exact installed SHA, check receipt and destination test receipt on #686
   without the webhook value. Nothing in this step changes the release workflows.
5. The operator checks cron execution, log rotation and destination health daily.
   Pause by setting enabled=false or commenting the cron job. To rotate, pause,
   replace the private value, test delivery, then re-enable. A stopped host or
   broken webhook needs independent operator supervision; it cannot alert itself.

An unhealthy enabled run sends one sanitized JSON `text` alert and exits 1 if
accepted; missing/invalid configuration or failed delivery exits 2. Healthy or
disabled monitor runs exit 0. Check-only mode exits 0/1 for healthy/unhealthy.
An outage repeats alerts each scheduled run; no deduplication, recovery message,
automatic repair or uptime SLA is claimed. HTTP 2xx proves channel acceptance,
not that a person read the message. No live alert was sent by this PR.

Reachability and TLS do not prove mail delivery, authenticated signup, tenant
isolation, saved assessment durability or backup restore. Keep the separately
authorised journey acceptance and recovery decisions on private #686. This PR
neither accesses the private release source nor grants release authority.
