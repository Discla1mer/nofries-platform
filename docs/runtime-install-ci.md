# Isolated production install check

The PR-only `PR isolated runtime install / runtime-install` workflow builds the
App Service tree and installs both production closures outside the checkout.
App Service omits development and optional packages; API omits development
packages and includes optional packages, matching the release install profiles.
Install scripts are disabled. A fresh Node process with no inherited credentials
or Node lookup overrides loads every direct dependency and selected runtime
entry modules. Missing packages and parent, symlink or transitive fallback fail.
Temporary directories are removed when the script returns.

This checks real installation and module resolution. It does not start the
production host, contact customer services or prove live configuration. Only
package-registry access is required. Actions use full SHA pins, checkout retains
no credential, the token is contents-read, and there is no cache, upload, OIDC,
environment or deployment. The job uses Node 22.22.0 on Ubuntu 24.04 with an
8-minute ceiling.

## Relationship to the other CI changes

| Change | Responsibility |
| --- | --- |
| Public #13 | Four parallel Jest shards, existing build/evaluations, unchanged fail-closed application aggregate |
| Public #41 | Actual isolated production installs and module loading, independent early PR feedback |
| Public #54 | Fresh release audit policy plus fast package-build tests and offline install planning |
| Private #724 | Timing weights for the private two-shard suite; no public selector or workflow change |

The new job does not install root development dependencies, run audits or rerun
the application suite. It runs alongside existing CI, so it can report failure
early without making long-running jobs wait. Existing CI may still repeat its
small build/install-planning check; its exact reviewed workflow is deliberately
preserved. Separate runners must construct their own inputs; no shared artifact
is treated as release evidence.

This refresh removes #41's old modifications to `.github/workflows/ci.yml`,
`scripts/release/public-repository-handover.js` and existing package/handover
tests. All existing files now match current main. New tests use their own Jest
wrapper, and this document avoids #13's `docs/public-ci.md`. Thus #13, #41 and
#54 have no directly conflicting changed paths and may be reviewed independently.
Release workflow/profile hashes, application aggregate semantics, signup/fence
code and admin/visual work are untouched.

The new check is visible in PR CI; this PR does not configure it as a required
branch-protection check or add it to release admission. Fry must decide any later
required-check/profile adoption separately. Existing release gates remain
mandatory. A passing check is not authority to release.

## Local verification and timing

```sh
node --test scripts/tests/check-runtime-install.cjs
npm run build:app-service
node scripts/check-runtime-install.js
```

Nine focused regressions cover the isolated resolution failures and unprivileged
workflow wiring; ordinary Jest also executes them. The original #41 hosted
[run 41375710711](https://github.com/Discla1mer/nofries-platform/actions/runs/41375710711)
passed: real install/load step 6s, application job 19m56s, workflow creation to
last completed job 19m59s. That run used the earlier #41 base. Current-main serial
[run 41430367627](https://github.com/Discla1mer/nofries-platform/actions/runs/41430367627)
took 28m17s total. These differing runs demonstrate timing variance, not a claimed
speedup from adding installation coverage. Refreshed-head CI and measured timings
are recorded on the PR and private #686; do not substitute a projected result.

Rollback is removal of the five added files. There is no production state or
shared release artifact to undo.
