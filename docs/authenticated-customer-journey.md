# Opt-in authenticated customer journey

Default-off HTTP check covering fresh signup and terms, first assessment, saved
answers, submission/results, logout rejection, fresh login and resumed draft.
Real handlers and PostgreSQL use synthetic identity, mail and Blob providers.
This does not validate live providers, browser rendering or deployed environments.

Use Node 22.22+ and installed dependencies with a disposable PostgreSQL 17 cluster.
Create a `nofries_journey` control database whose local test owner can create/drop
databases and roles; never use a tunnel, shared cluster or customer account.

```sh
export NOFRIES_JOURNEY_DATABASE_URL='postgresql://<local-test-owner>:<local-test-password>@127.0.0.1:5432/nofries_journey'
export NOFRIES_JOURNEY_DISPOSABLE_CLUSTER=true
node scripts/authenticated-customer-journey.js --run-local
```

No flag means DISABLED without resource creation. Remote/production targets and
extra flags are rejected. Exit codes: 0 pass/disabled, 1 journey/cleanup failure,
2 invalid arguments. Reports contain numbered checks and loopback paths/statuses,
never cookies, identity codes, customer data, response bodies or raw errors.

The existing PostgreSQL CI job explicitly runs the journey and three injected
failure paths; disabled cannot count as pass. Every run checks removal of its
generated database, restricted runtime role, listener and synthetic storage.
Cleanup failure fails the run. Dispose of the whole cluster after testing or a
hard process kill; migrations may leave the standard `nofries_runtime` role.
Future remote support requires a separately reviewed owner-approved design.
