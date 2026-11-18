# D-013: signed-in request CPU, 18 November 2026

Repeated framework publication was avoidable CPU work in saved-assessment history validation. `frameworkProfileRegistry` now remembers only its own validated, deeply frozen outputs in a private `WeakSet`. Republishing them still returns a fresh, deeply frozen copy. Mutable inputs, JSON copies, caller-frozen objects, proxies and accessors retain full validation. Catalogue values, digests, evaluators and scoring rules are unchanged. No customer data, authority or assessment history is cached.

## Revisions

| Measurement | Before | After |
| --- | --- | --- |
| Current main | `3f72ac2c5bc1ebeab6e9716fc98aadc83d065725` | `9b6f7c1eaec3ae8178d63d0c0e41f6638c5e5515` |
| #446 compatibility | `1075c701c9b614dd0b3cee5ff8c6b2cac6a68d2b` | `ed4bb808d24f70d5c141838fb51d78962c8b3e59` |

The compatibility after revision is a detached checkout of #446 plus exactly the optimization commit. This PR branches from main and does not include #446. Rebase and recheck if #446 lands first. Later commits add this report and the profiling tool, without changing the measured application code.

## Method and assumptions

- Real production application composition, signed-in customer session and PostgreSQL 17.11; synthetic identity, mail and in-memory Blob providers from `customerProductionHarness`. The profiler creates and removes an isolated database and restricted `NOINHERIT`, `NOBYPASSRLS` runtime login on the disposable loopback test cluster.
- One company, one submitted accepted-v1 assessment with three revisions (create/save/submit), no Actions plan. Both protected assets are fetched on each replay. HTML, static loader download, browser rendering, focus refresh, larger portfolios/history and the optional Actions-card path are outside the measurement. Existing loader tests cover the closing witness and focus re-check.
- Replay the loader's signed-in HTTP reads sequentially: session, directory, bootstrap, Cyber Security module, script, CSS, closing session witness, assessment list, and (Overview only) assessment detail. On #446 replace the final two Overview reads with `modules/overview?view=first-paint`. This is server work per load, not the browser's parallel waterfall or time to interactive.
- Three warmups then 20 measured replays per page per revision, with fresh fixture setup per series. Node 24.19.0 on AMD EPYC 9V74, pinned with `taskset -c 0`; PostgreSQL runs separately. Timed series were sequential with no test runs alongside them. This is not an Azure B1 benchmark, and Node differs from CI's 22.22.0.
- CPU is the delta of `process.cpuUsage()` user + system time around each HTTP request: the Node application **and same-process HTTP client**, excluding PostgreSQL, Blob services and browser CPU. `Server-Timing` from #395 measures elapsed server time, including I/O waits; it is not CPU. Reported values are medians; page totals are the median of each replay's sum, not sums of route medians. Series are not randomized; small unrelated-route differences are noise, not claimed improvements.
- A separate `--cpu-prof` discovery run identified repeated `publishFrameworkProfile` / `resolveProfile` validation and hashing under assessment history replay. All history/lineage validation remains in place. CPU sampling was disabled for the reported timings.

## Results

Milliseconds, before → after. Counts were identical on every measured replay before and after. `db` counts are #395 logical calls; **wire** counts all `pg.Client.query` calls, including control SQL and timeout preparation. Session/directory have only a `total` header, so their SQL is absent from #395's `db` count.

| Read sequence | HTTP requests | db / wire / timeout SET calls | Node process CPU ms | Server elapsed ms (sum of total stages) |
| --- | ---: | ---: | ---: | ---: |
| Main Overview | 9 → 9 | 314 / 941 / 433 → same | 372.4 → 313.9 (−15.7%) | 512.7 → 442.9 |
| Main Cyber Security | 8 → 8 | 263 / 831 / 379 → same | 288.2 → 248.3 (−13.8%) | 416.0 → 364.8 |
| #446 Overview | 8 → 8 | 314 / 941 / 433 → same | 368.1 → 317.1 (−13.9%) | 496.9 → 447.5 |
| #446 Cyber Security | 8 → 8 | 263 / 831 / 379 → same | 275.5 → 251.3 (−8.8%) | 396.9 → 364.7 |

Main per-request stage medians, pooling the same route across both pages. `session` has three captures on every instrumented single read. `epoch` and `connect` median durations round to **0.0 → 0.0 ms** for each of these reads; zero does not mean omitted. Missing stages are shown as “—”.

| Route under `/api/dashboard/` | db / wire / SET, both revisions | session ms | db elapsed ms | total elapsed ms | Node CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `session` (opening and closing) | — / 99 / 39 | — | — | 33.0 → 31.9 | 18.1 → 17.4 |
| `organisations?limit=50` | — / 67 / 23 | — | — | 22.9 → 21.5 | 12.6 → 11.7 |
| `bootstrap` | 51 / 110 / 54 | 2.1 → 2.0 | 25.1 → 23.8 | 51.8 → 48.9 | 34.9 → 33.0 |
| `modules/cyber_security` | 63 / 134 / 66 | 2.1 → 2.1 | 29.4 → 28.4 | 63.5 → 63.1 | 44.3 → 46.5 |
| `app.js` | 49 / 106 / 52 | 2.1 → 2.1 | 24.7 → 22.0 | 46.2 → 42.9 | 33.4 → 31.2 |
| `dashboard.css` | 49 / 106 / 52 | 2.2 → 2.1 | 23.1 → 22.3 | 42.4 → 39.9 | 28.0 → 25.9 |
| `ncsc/assessments` | 51 / 110 / 54 | 2.1 → 2.2 | 24.6 → 24.6 | 107.0 → 79.5 | 89.7 → 63.8 |
| `ncsc/assessments/:assessment` | 51 / 110 / 54 | 2.1 → 2.1 | 26.6 → 26.4 | 109.8 → 78.9 | 92.2 → 62.5 |

For #446's Overview bundle specifically: **102 / 220 / 108** calls remain unchanged; `session` **4.3 → 4.3 ms**, `epoch` **0.0 → 0.0**, `connect` **0.1 → 0.1**, `db` **49.7 → 51.0**, `total` **209.4 → 159.0** and Node CPU **176.7 → 124.3 ms**. Its two constituent reads still capture the session six times in total. The bundle reduces HTTP overhead, not constituent SQL or authentication work.

## Timeout investigation

Timeout setters account for 433 of 941 driver calls on the main Overview replay, with aggregate setter elapsed time **86.5 → 81.9 ms**; Cyber Security is 379 of 831 and **77.7 → 73.3 ms**. These durations include round trips and are not CPU savings from this patch. A transaction-scoped constant `statement_timeout` applies separately to each statement, not to the remaining request budget. A local PostgreSQL 17.11 probe set it once to 250 ms and successfully ran two 150 ms sleeps in **304.2 ms**; rollback restored the connection's 1 s setting.

The current guard recalculates the remaining deadline inside its FIFO immediately before every statement, rechecks authority after timeout setup and before COMMIT, and retains transaction ownership until settlement. A connection-wide setting would additionally need reset/discard proofs. PostgreSQL 17's `transaction_timeout` terminates the session, so it is not a verified drop-in replacement for the existing cancellation, rollback and outcome handling. See [PostgreSQL's timeout semantics](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-STATEMENT-TIMEOUT). No timeout, pool, isolation, capture, closing-witness or focus behavior is changed here.

## Reproduce

Use the disposable local PostgreSQL credentials already used by public CI; never a live application URL. Run from each checkout being measured, passing the same absolute profiler path (the profiler resolves application modules from the current working directory):

```sh
export NOFRIES_TEST_DATABASE_URL='postgresql://nofries_ci_owner:nofries-ci-only-password@127.0.0.1:5432/nofries_ci'
export NOFRIES_PROFILE_DISPOSABLE_CLUSTER=true
export NOFRIES_PROFILE_RUNS=20
taskset -c 0 node /path/to/candidate/scripts/profile-dashboard-loads.js --run-local > /tmp/d013.json
```

Set `NOFRIES_PROFILE_OVERVIEW_BUNDLE=true` for the #446 checkouts only. The JSON contains the checkout SHA, Node version, sample counts, numeric timing/count data and fixed route labels; it does not emit cookies, SQL, identities or assessment bodies. Keep raw profiles local. Run `node --test scripts/tests/profile-dashboard-loads.cjs`, targeted registry/runtime/loader tests, `npm run verify`, migrations twice and `npm run test:postgres` for correctness; exact-head check results belong on the PR.

The supplied production observations (1.1–1.5 s elapsed per request and 550–700 ms of session work) are not reproduced by synthetic Blob providers. The measured reduction is local CPU evidence for a narrow optimization, not a production latency or capacity claim.
