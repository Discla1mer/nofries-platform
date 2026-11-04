# Opt-in authenticated customer journey

This check joins fresh company signup, terms, authenticated admission, the first
NCSC assessment, save, submit, results, sign out and return. It verifies identical
submitted results after fresh authentication and resumes a separate unfinished
draft, saving another answer without losing its earlier answers or rationale.
It also replays the revoked cookie to prove server-side logout.

The default is **disabled**. The only implemented target is a disposable **local**
stack. No deployed preview or production URL is accepted. It executes real HTTP
handlers, authentication/session/CSRF/tenant gates, migrations and native PostgreSQL
with a restricted runtime login. Identity, mail, managed identity and Blob storage
are synthetic providers reused from the existing production-composition fixture.
This is application journey evidence, not live email/MFA, browser rendering, CSP,
keyboard or deployed-environment acceptance. It does not bypass an application
handler or seed an admitted customer. Signup and terms create the customer.

## Run locally

Use Node 22.22+, `npm ci --ignore-scripts --omit=optional --audit=false`, and a
disposable PostgreSQL 17 cluster with a control database named `nofries_journey`.
Its test-only owner must be able to create/drop temporary databases and roles.
Never point this at a tunnel, shared database or customer cluster. The migrations
may create the standard `nofries_runtime` role; destroy the whole disposable
cluster after testing. No application credentials are used or inherited as a
database fallback.

```sh
# Supply the disposable local database URL through your shell, not source control.
export NOFRIES_JOURNEY_DATABASE_URL='postgresql://<local-test-owner>:<local-test-password>@127.0.0.1:5432/nofries_journey'
export NOFRIES_JOURNEY_DISPOSABLE_CLUSTER=true
node scripts/authenticated-customer-journey.js --run-local
```

With no flag the script exits without creating resources. `--run-local` explicitly
opts in. Exit 0 means passed (or explicitly DISABLED with no flag), 1 means a
journey or cleanup failure, 2 means invalid arguments. CI selects the native test
explicitly and requires a real passing journey; it cannot count DISABLED as PASS.

The separate ordinary PR workflow `customer-journey.yml` runs this local stack
without secrets, environments, deployment steps or dispatches. It also injects
failures after stack preparation, signup and submission and proves cleanup each
time. The existing application and native PostgreSQL CI remain required.

## Evidence and cleanup

Like [#17](https://github.com/Discla1mer/nofries-platform/pull/17), each numbered
step emits PASS/FAIL, requested URL and HTTP status. Only loopback origin and path
are reported; query/fragment values, cookies, auth codes, email addresses,
response bodies, raw SDK/SQL errors and screenshots are excluded. Redirects are
never followed; the local fixture consumes only synthetic authentication state.
Socket access is restricted to the numeric loopback database and owned HTTP
listener ports, so synthetic provider URLs cannot accidentally be contacted.

Each run creates a uniquely named database and runtime role. Finally blocks close
the listener and pools, clear synthetic Blob/mail/session data, drop **only** those
generated resources and check absence. Cleanup failure makes the run fail; every
remaining cleanup action is still attempted. No customer deletion/reset API is
used. A hard process kill cannot execute finally blocks: dispose of the dedicated
cluster in that case (the CI service is disposable). Do not use an empty-signup
reset on this test account: it has completed assessments.

## Future preview / production activation — not implemented or enabled

Production remains blocked even if somebody supplies an approval-looking flag or
environment variable. A future separately reviewed adapter must require **both**
an explicit owner-approved production flag and a dedicated synthetic test tenant;
neither alone is sufficient. It must bind the approval to the exact production
origin, tenant and run, verify tenant identity before writes, use dedicated test
credentials/mailbox, allowlist identity-provider redirects, and provide bounded,
tenant-scoped cleanup with a receipt. Preview support needs the same isolated
tenant and cleanup contract. Do not add production defaults, derive approval
from an environment name, use real customer accounts or enable this in a release
workflow. Obtain that future approval from Fry/Joel; this PR does not grant it.
