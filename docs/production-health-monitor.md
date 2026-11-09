# Production health and expiry alerts

Default-off monitor for [#70](https://github.com/Discla1mer/nofries-platform/issues/70). No scheduler or destination is installed by this repository; secret-backed delivery belongs on an operator-owned private host and is refused in GitHub Actions.

`node scripts/production-health-monitor.js --check` explicitly runs credential-free, read-only checks without alert delivery. The default command and `--monitor` make no requests until `NOFRIES_MONITOR_ENABLED=true` and a valid HTTPS alert destination are configured privately.

Checks cover `/`, `/signup`, `/login`, `/dashboard`, `/terms.html`, `/privacy.html`, `/api/health` and both signup-state endpoints. Pages require HTML/200, health requires `ok`/200, and the selected signup provider requires `create_account`/200. Hosted `/signup` selects its default legacy branch; standalone documents select their configured provider. Unknown bootstraps fail closed without executing remote JavaScript. An inactive provider's 410 is permitted. Each required response needs valid TLS hostname/chain verification and at least 30 certificate days remaining.

Requests are sequential GETs with a 10-second absolute deadline, 1 MiB body limit, no cookies, redirects or retries. Auth-start routes are excluded because they create transactions. GETs still consume the public API limiter. Numbered PASS/FAIL results use #17's result shape; this smaller monitor does not prove authenticated journeys, mail delivery, tenant isolation, durable saves or recovery.

After review and merge, the operator:

1. Chooses a staffed alert destination and escalation owner, plus a private Linux host with Node >=22.22.0, `flock`, trusted CA roots and outbound HTTPS. The destination must accept JSON `{ "text": "..." }` with HTTP 2xx; No Fries hosts, URL credentials and fragments are rejected.
2. Installs the reviewed exact source SHA at `/opt/nofries-monitor` (no npm install), creates private operator-owned log/lock directories, and verifies paths in the [disabled cron template](../ops/production-health.cron.example).
3. Sets `NOFRIES_MONITOR_ALERT_WEBHOOK` only in the private crontab or secret store. Never put the URL in source, logs, issues, public variables or GitHub Actions secrets. Keep monitoring disabled until the destination owner tests delivery and confirms recipients.
4. Privately sets `NOFRIES_MONITOR_ENABLED=true` and uncomments the template's 15-minute job; `flock` prevents overlap. Checks all nine results and certificate days, and records the installed SHA and sanitized receipts with the release owner.
5. Supervises host execution, log rotation and channel health daily. Pauses by disabling the flag or commenting the job. Pauses before rotating the destination, tests delivery, then re-enables.

Logs and alerts contain only fixed labels/production URLs, statuses and certificate days; never bodies, headers, exceptions or destination URLs. Healthy/disabled runs exit 0; unhealthy checks exit 1. Enabled failures send one alert and exit 1 on acceptance, or 2 on failed delivery/configuration. Alerts repeat each run without deduplication, recovery messages or repair. HTTP 2xx proves channel acceptance only; a stopped host or broken webhook requires independent supervision.
