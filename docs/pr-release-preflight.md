# PR release pre-flight

`PR release pre-flight / release-preflight` runs on every pull request, including
unchanged dependency graphs. Registry advisories can change without a lockfile
change, so this job never reuses the protected-main audit baseline. It adds early
feedback; it does not replace ordinary CI, exact-main qualification or release
checks. Branch protection is unchanged: the owner may separately require the new
check after admission, but this PR does not change repository permissions/settings.

## Existing code reused

`scripts/pr-release-preflight.js audit` collects these same three release reports:

| Report | Existing release command |
| --- | --- |
| Root excluding optional | `npm audit --audit-level=moderate --omit=optional --json` |
| Root runtime | `npm audit --omit=dev --audit-level=moderate --json` |
| API runtime | `npm --prefix api audit --omit=dev --audit-level=moderate --json` |

All reports go to the repository's existing `scripts/check-dependency-audit.js`
with its three `--release-*-report` flags. No severity/exception/advisory logic is
copied into the orchestrator. This release mode rejects Moderate/High/Critical
findings and malformed or ambiguous reports; build-only exceptions do not apply.
The existing policy also rejects findings spanning multiple installed versions,
including the reproduced glob case. Existing release-specific exceptions, source
checks and their expiry remain owned by that checker; none is added or extended.

Audit exit 1 carries findings to the policy; transport errors, timeout, signals,
oversized output and empty/malformed reports fail. Every audit surface is attempted
even when another fails. Reports are private temporary files and removed on exit.
The package step still runs after an audit failure when dependency installation
succeeded; an audit failure still fails the overall job.

`package` runs the existing `appServicePackage.test.js` and `customerStaticBuild.test.js`
suites without stamping release identity. These execute the real App Service/static builders and check package
inclusions/exclusions, runtime-only manifest, customer routes, headers and SWA
configuration size. The generated runtime and API installs use the release's omit
flags with `--dry-run --offline --ignore-scripts --audit=false`. Missing cache or
an invalid lockfile is a failure, never an online fallback or a silent skip.

This is a fast build/manifest/install-planning check, **not** archive assembly,
installed-runtime validation, a full test run, rollback construction, authenticated
live evaluation or production readiness. Synthetic output is never uploaded or
promoted. Registry changes after the PR can still fail the mandatory release audit.

## Isolation and budget

The separate workflow uses `pull_request` only, full-SHA-pinned actions, read-only
contents access, no persisted checkout credential, no cache, no secrets, environment,
OIDC, Azure login, deployment or artifact upload. Node is 22.22.0 and the new job
uses Ubuntu 24.04. Existing CI and release workflows/profile hashes are unchanged.
Commands receive inert GitHub command-file channels. PR source remains untrusted;
no local-only wrapper is a sandbox or an authorization boundary.

Root installation runs once without lifecycle scripts. The 25-minute job ceiling
contains a 5-minute installation budget, three 5-minute audit request limits in a
16-minute step, and a 4-minute package step. Normal runtime is expected to be far
shorter than full release verification; measure the first hosted run rather than
treating the ceiling as a timing claim. Full Jest, PostgreSQL and provider checks
remain in their existing lanes.

## Local checks and limits

Use a disposable checkout: the existing builders replace `dist`/`app-service-dist`.
After the standard root install:

```sh
node --test scripts/tests/pr-release-preflight.cjs
node scripts/pr-release-preflight.js audit
node scripts/pr-release-preflight.js package
```

Regression tests execute the unchanged real audit-policy CLI against synthetic
reports (vendor provenance alone is stubbed in those fixtures). Hosted pre-flight
uses the real vendor verifier and real reports. Transport/build errors, severity,
build-only exceptions, multi-version glob and restricted workflow wiring are covered.
The Jest wrapper keeps those regressions in ordinary CI too.

Public source uses its existing release-mode policy, without importing private
controller source or credentials. Its older MSAL-remediation handling can be more
restrictive than the current private checker; this change does not claim those
policy files are byte-identical or silently reconcile them. Any resulting refusal
requires a separately reviewed policy/source repair. Release-controller audit and
package gates always remain authoritative.
