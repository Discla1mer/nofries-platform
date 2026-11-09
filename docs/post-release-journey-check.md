# Read-only post-release smoke
For [#15](https://github.com/Discla1mer/nofries-platform/issues/15), run explicitly after an authorised release:
```sh
node scripts/post-release-smoke.js --base-url https://example.invalid --expect-sha <40-character-released-SHA>
```

Replace the example with the production origin only. Nothing schedules or enables production checks automatically. Omitting `--expect-sha` checks only health/manifest agreement; supply the exact SHA for release acceptance. `--allow-http` is for local synthetic fixtures.

The eleven checks cover healthy release identity and `/release.json` agreement; signup/login/dashboard HTML; the selected signup provider's `create_account` state; organisation setup availability; dashboard login routing; and signed-out refusal of session/dashboard/assessment APIs. Hosted `/signup` uses its default legacy branch; server-selected external documents check external state. Unknown bootstraps fail closed without executing remote scripts. An inactive provider cannot mask a broken selected provider.

Every request is an unauthenticated GET with a 15-second deadline, no cookies or redirect following. The production-composition tests verify no blob/SQL writes, mail or identity requests. GETs still consume the API limiter. Auth-start routes are excluded entirely: they create persistent sign-in transactions. The former `--include-sign-in-redirect` option is rejected.

Output names each numbered PASS/FAIL check and requested origin/path with HTTP status. A zero status means NETWORK/TIMEOUT failure. Bodies, redirect locations, cookies and exceptions are never printed. Origins with credentials, query strings, fragments or paths are rejected; never pass account data in arguments or URLs.

Exit codes: 0 passed, 1 failed checks, 2 invalid arguments. On failure, hold further releases and ask the release owner for the rollback decision. This script never deploys, rolls back or changes data.

These checks prove route wiring, not rendered accessibility, mail delivery, completed sign-in, organisation binding, durable assessment saves or results. Those require the release owner's separately authorised manual journey with a test account and retention/cleanup plan; record only sanitized outcomes, never addresses, customer content, codes, cookies, tokens or raw screenshots.
